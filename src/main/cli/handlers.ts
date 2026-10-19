import { resolve as resolvePath } from 'path'
import { BRAND } from '@shared/brand'
import {
  CTL_MAX_PROMPT,
  CTL_MAX_SEND,
  CTL_MAX_WAITERS,
  CTL_NOTIFY_BODY_MAX,
  CTL_NOTIFY_PER_MIN,
  CTL_NOTIFY_TITLE_MAX,
  CTL_PROTOCOL_VERSION,
  CTL_READ_DEFAULT,
  CTL_READ_MAX,
  CTL_STATUS_MAX,
  CTL_WAIT_DEFAULT_S,
  CTL_WAIT_MAX_S,
  CTL_WAIT_QUIET_MS,
  type CtlConsoleInfo,
  type CtlErrorCode,
  type CtlListData,
  type CtlListPane,
  type CtlListWorkspace,
  type CtlMethod,
  type CtlRendererData,
  type CtlResponse,
  type CtlSpawnResult,
  type CtlWaitResult,
  type CtlWorkspaceInfo,
} from '@shared/ctl-protocol'
import { resolveConsoleRef, resolveWorkspaceRef, workspaceOfPane, type RefError } from '@shared/ctlRefs'
import { stripAnsi, tailLines } from '@shared/ansi'
import { isTaskState, normalizeWorkspaceNote } from '@shared/workspaceNote'
import type { ClaudePaneState, ConfigFile, PaneStatusEvt, PaneType } from '@shared/types'
import type { PtySubmitRes } from '@shared/ipc-contract'
import type { BusResult, RendererBus } from './rendererBus'
import type { CtlCaller } from './CtlTokens'

/** The PtyManager surface the CLI uses. */
export interface CtlPtyView {
  ptyIdForPane(paneId: string): string | null
  submitToPane(ptyId: string, paneId: string | undefined, text: string, enter: boolean): Promise<PtySubmitRes>
  lastSubmitAt(paneId: string): number | undefined
  lastOutputAt(paneId: string): number | undefined
  /** The live pty's raw ring (no side effects), or null. */
  tail(paneId: string): string | null
}

export interface CtlStatusView {
  stateOf(paneId: string): PaneStatusEvt | null
}

/** A `snaos notify` to deliver: native (respecting notifications.enabled) and, unless local, Discord/ntfy. */
export interface CtlNotice {
  paneId: string | null
  title: string
  body: string
  local: boolean
}

export interface CtlTiming {
  /** Consecutive time in a free state before `wait` returns (E8-FR-18). */
  settleMs: number
  /** No `working` in this long + already free at call time = return at once. */
  recentWorkingMs: number
  /** After a submit with Enter, how long without any transition means "no turn". */
  noTurnMs: number
  /** Re-evaluation cadence of a live waiter. */
  tickMs: number
}

export const DEFAULT_TIMING: CtlTiming = { settleMs: 1500, recentWorkingMs: 3000, noTurnMs: 10_000, tickMs: 250 }

export interface CtlHandlerDeps {
  bus: RendererBus
  pty: CtlPtyView
  status: CtlStatusView
  config: () => ConfigFile | null
  notify: (notice: CtlNotice) => void
  appVersion: string
  now?: () => number
  timing?: Partial<CtlTiming>
}

const FREE_STATES = new Set<ClaudePaneState>(['idle', 'done', 'action', 'error'])
const AGENT_TYPES = new Set<PaneType>(['claude', 'codex', 'shell', 'custom'])
const RATE_WINDOW_MS = 60_000

type Out = CtlResponse
type Fail = Extract<CtlResponse, { ok: false }>

function ok(data: unknown): Out {
  return { ok: true, data }
}

function err(code: CtlErrorCode, message: string, data?: unknown): Fail {
  return data === undefined ? { ok: false, error: { code, message } } : { ok: false, error: { code, message }, data }
}

function refErr(e: RefError): Fail {
  return err(e.code, e.message)
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const bool = (v: unknown): boolean => v === true

/** One line of plain text: controls become spaces, runs collapse, clipped without splitting a surrogate pair. */
export function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  let out = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (out.length > max) {
    out = out.slice(0, max)
    const last = out.charCodeAt(out.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
    out = out.trimEnd()
  }
  return out
}

/** A path compared the way Windows does (case-insensitive) or POSIX does. */
export function samePathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const abs = resolvePath(p.trim()).replace(/[\\/]+$/, '')
  return platform === 'win32' ? abs.toLowerCase() : abs
}

interface Waiter {
  paneId: string
  start: number
  timeoutMs: number
  quietMs: number
  first: boolean
  timer: ReturnType<typeof setInterval> | null
  done: (out: Out) => void
}

/**
 * Every CLI method (E8-FR-14..20). References resolve against the renderer's
 * `list` with the caller derived from the token; `send` and `wait` run in main
 * on PtyManager and StatusManager; `spawn`, `open`, `status` and `note` go
 * through the renderer, which owns the model. Waiters and rate limits are
 * keyed by the caller's pane (or 'master').
 */
export class CtlHandlers {
  private readonly now: () => number
  private readonly timing: CtlTiming
  private readonly waiters = new Set<Waiter>()
  private readonly notifyLog = new Map<string, number[]>()
  private readonly lastTransitionAt = new Map<string, number>()
  private readonly lastWorkingAt = new Map<string, number>()
  private readonly lastState = new Map<string, ClaudePaneState | null>()
  /** Panes with a status line set through the CLI: cleared when their pty is replaced or ends. */
  private readonly statusLinePanes = new Set<string>()

  constructor(private readonly deps: CtlHandlerDeps) {
    this.now = deps.now ?? Date.now
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
  }

  get waiterCount(): number {
    return this.waiters.size
  }

  readonly handle = async (method: CtlMethod, params: Record<string, unknown>, caller: CtlCaller | null, signal: AbortSignal): Promise<Out> => {
    switch (method) {
      case 'ping':
        return ok({ pong: true, appVersion: this.deps.appVersion, protocol: CTL_PROTOCOL_VERSION, self: caller?.paneId ?? null })
      case 'ls':
        return this.ls(params, caller)
      case 'open':
        return this.open(params, caller)
      case 'spawn':
        return this.spawn(params, caller)
      case 'send':
        return this.send(params, caller)
      case 'read':
        return this.read(params, caller)
      case 'wait':
        return this.wait(params, caller, signal)
      case 'status':
        return this.status(params, caller)
      case 'notify':
        return this.notify(params, caller)
      case 'note':
        return this.note(params, caller)
      default:
        return err('bad_request', 'unknown method')
    }
  }

  // --- Observers (wired by CliService) -------------------------------------

  /** StatusManager listener: transitions feed `wait`. */
  onStatus(evt: PaneStatusEvt): void {
    const now = this.now()
    const prev = this.lastState.has(evt.paneId) ? this.lastState.get(evt.paneId) : undefined
    if (prev !== evt.state) {
      this.lastTransitionAt.set(evt.paneId, now)
      this.lastState.set(evt.paneId, evt.state)
    }
    if (evt.state === 'working') this.lastWorkingAt.set(evt.paneId, now)
    if (evt.state === null) this.lastState.delete(evt.paneId)
    for (const w of this.waiters) if (w.paneId === evt.paneId) this.evaluate(w)
  }

  /** A pty was bound to the pane (spawn or restart): its old status line goes. */
  onPtySpawn(paneId: string): void {
    this.dropStatusLine(paneId)
  }

  /** The pane's live pty ended: its waiters end with `exited`, its status line goes. */
  onPtyExit(paneId: string): void {
    this.dropStatusLine(paneId)
    for (const w of [...this.waiters]) if (w.paneId === paneId) this.finish(w, err('exited', 'the console exited'))
  }

  dispose(): void {
    for (const w of [...this.waiters]) this.finish(w, err('desktop_unavailable', `${BRAND.productName} is shutting down`))
  }

  private dropStatusLine(paneId: string): void {
    if (!this.statusLinePanes.delete(paneId)) return
    void this.deps.bus.request({ kind: 'setStatusLine', paneId, text: null })
  }

  // --- Helpers -------------------------------------------------------------

  private async list(): Promise<CtlListData | Fail> {
    const res = await this.deps.bus.request({ kind: 'list' })
    if (!res.ok) return this.busErr(res)
    const data = res.data as CtlListData | undefined
    if (!data || !Array.isArray(data.workspaces)) return err('internal', 'the desktop answered an invalid list')
    return data
  }

  private busErr(res: Extract<BusResult, { ok: false }>): Fail {
    if (res.error === 'desktop_unavailable') return err('desktop_unavailable', `the ${BRAND.productName} window is not available`)
    return err(res.error, res.message && res.message !== res.error ? res.message : res.error.replace(/_/g, ' '))
  }

  private protectSsh(): boolean {
    return this.deps.config()?.settings?.automation?.cliProtectSsh !== false
  }

  private sshProtected(ws: CtlListWorkspace, pane: CtlListPane): boolean {
    return this.protectSsh() && !!(pane.setupId ?? ws.setupId)
  }

  /** --workspace, else the caller's workspace, else the active one. */
  private scope(list: CtlListData, params: Record<string, unknown>, caller: CtlCaller | null): { id: string | null } | Fail {
    const ref = str(params.workspace)
    if (ref !== undefined) {
      const r = resolveWorkspaceRef(list, ref)
      return r.ok ? { id: r.workspace.id } : refErr(r)
    }
    if (caller) {
      const own = workspaceOfPane(list, caller.paneId)?.workspace.id ?? (list.workspaces.some((w) => w.id === caller.workspaceId) ? caller.workspaceId : null)
      if (own) return { id: own }
    }
    return { id: list.activeWorkspaceId && list.workspaces.some((w) => w.id === list.activeWorkspaceId) ? list.activeWorkspaceId : null }
  }

  private target(list: CtlListData, params: Record<string, unknown>, caller: CtlCaller | null, key = 'console'): Extract<ReturnType<typeof resolveConsoleRef>, { ok: true }> | Fail {
    const ref = str(params[key])
    if (ref === undefined) return err('bad_request', 'missing console')
    const sc = this.scope(list, params, caller)
    if ('ok' in sc) return sc
    const r = resolveConsoleRef(list, sc.id, ref, caller?.paneId ?? null)
    return r.ok ? r : refErr(r)
  }

  // --- Methods -------------------------------------------------------------

  private async ls(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const list = await this.list()
    if ('ok' in list) return list
    let shown = list.workspaces.map((w, i) => ({ w, index: i + 1 }))
    const ref = str(params.workspace)
    if (ref !== undefined) {
      const r = resolveWorkspaceRef(list, ref)
      if (!r.ok) return refErr(r)
      shown = [{ w: r.workspace, index: r.index }]
    }
    const presets = new Map(list.presets.map((p) => [p.id, p.name]))
    const out: CtlWorkspaceInfo[] = shown.map(({ w, index }) => ({
      index,
      id: w.id,
      name: w.name,
      cwd: w.cwd,
      active: w.id === list.activeWorkspaceId,
      ...(w.note ? { note: w.note } : {}),
      ...(w.taskState ? { taskState: w.taskState } : {}),
      consoles: w.panes.map((p, i): CtlConsoleInfo => {
        const st = this.deps.status.stateOf(p.id)
        const line = list.statusLines[p.id]
        return {
          index: i + 1,
          id: p.id,
          title: p.title,
          type: p.type,
          ...(p.presetId && presets.has(p.presetId) ? { presetName: presets.get(p.presetId) } : {}),
          running: this.deps.pty.ptyIdForPane(p.id) !== null,
          agentState: st?.state ?? null,
          precise: st?.precise ?? false,
          ...(st?.reason ? { reason: st.reason } : {}),
          ...(line ? { statusLine: line } : {}),
          self: caller?.paneId === p.id,
          sshProtected: this.sshProtected(w, p),
        }
      }),
    }))
    return ok({ workspaces: out })
  }

  private async open(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const list = await this.list()
    if ('ok' in list) return list
    const dir = str(params.path)
    if (dir !== undefined) {
      if (!dir.trim() || dir.includes('\0') || dir.length > 4096) return err('bad_request', 'invalid --path')
      const key = samePathKey(dir)
      const hit = list.workspaces.find((w) => w.cwd && samePathKey(w.cwd) === key)
      if (!hit) {
        const res = await this.deps.bus.request({ kind: 'composer', cwd: resolvePath(dir.trim()) })
        return res.ok ? ok({ created: false, composer: true }) : this.busErr(res)
      }
      const res = await this.deps.bus.request({ kind: 'open', workspaceId: hit.id })
      return res.ok ? ok({ workspaceId: hit.id, created: false, composer: false }) : this.busErr(res)
    }
    const wsRef = str(params.workspace)
    let workspace: CtlListWorkspace | null = null
    if (wsRef !== undefined) {
      const r = resolveWorkspaceRef(list, wsRef)
      if (!r.ok) return refErr(r)
      workspace = r.workspace
    }
    let paneId: string | undefined
    if (str(params.console) !== undefined) {
      const sc = workspace ? { id: workspace.id } : this.scope(list, params, caller)
      if ('ok' in sc) return sc
      const r = resolveConsoleRef(list, sc.id, str(params.console)!, caller?.paneId ?? null)
      if (!r.ok) return refErr(r)
      workspace = r.workspace
      paneId = r.pane.id
    }
    if (!workspace) return err('bad_request', 'open needs a workspace, --console or --path')
    const res = await this.deps.bus.request({ kind: 'open', workspaceId: workspace.id, ...(paneId ? { paneId } : {}) })
    return res.ok ? ok({ workspaceId: workspace.id, ...(paneId ? { paneId } : {}), created: false, composer: false }) : this.busErr(res)
  }

  private async spawn(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const agent = str(params.agent)?.trim()
    if (!agent) return err('bad_request', 'spawn needs an agent: claude, codex, shell or a preset name')
    const prompt = str(params.prompt)
    if (prompt !== undefined && prompt.length > CTL_MAX_PROMPT) return err('bad_request', `the prompt is longer than ${CTL_MAX_PROMPT} characters`)
    const list = await this.list()
    if ('ok' in list) return list
    const sc = this.scope(list, params, caller)
    if ('ok' in sc) return sc
    const ws = sc.id ? list.workspaces.find((w) => w.id === sc.id) : undefined
    if (!ws) return err('bad_request', 'no workspace to spawn in (use --workspace)')
    const lower = agent.toLowerCase()
    let presetId: string | undefined
    let paneType: PaneType | undefined
    const byId = list.presets.find((p) => p.id === agent)
    const byName = list.presets.filter((p) => p.name.toLowerCase() === lower)
    if (byId) presetId = byId.id
    else if (byName.length > 1) return err('ambiguous', `preset "${agent}" is ambiguous`)
    else if (byName.length === 1) presetId = byName[0].id
    else if (AGENT_TYPES.has(lower as PaneType)) {
      const first = list.presets.find((p) => p.type === lower)
      if (first) presetId = first.id
      else if (lower === 'shell') paneType = 'shell'
      else return err('not_found', `no preset of type ${lower}`)
    } else return err('not_found', `preset "${agent}" not found`)
    const noProfile = bool(params.noProfile)
    if (ws.setupId && this.protectSsh() && !noProfile) return err('ssh_protected', 'this workspace has a Connection Profile; use --no-profile for a local console')
    const title = str(params.title) !== undefined ? oneLine(str(params.title)!, 60) : undefined
    const res = await this.deps.bus.request({
      kind: 'spawn',
      workspaceId: ws.id,
      ...(presetId ? { presetId } : {}),
      ...(paneType ? { paneType } : {}),
      ...(title ? { title } : {}),
      ...(prompt?.trim() ? { prompt } : {}),
      focus: bool(params.focus),
      noProfile,
    })
    if (!res.ok) return this.busErr(res)
    const data = res.data as CtlRendererData['spawn'] | undefined
    if (!data?.paneId) return err('internal', 'the desktop did not create the console')
    const out: CtlSpawnResult = { paneId: data.paneId, index: data.index, workspaceId: ws.id, promptDelivery: data.promptDelivery }
    return ok(out)
  }

  private async send(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const raw = str(params.text)
    if (raw === undefined) return err('bad_request', 'send needs a text (argument, - for stdin or --file)')
    // A file or stdin ends with a line break: never an implicit Enter.
    const text = raw.replace(/[\r\n]+$/, '')
    const enter = bool(params.enter)
    if (Buffer.byteLength(text, 'utf8') > CTL_MAX_SEND) return err('bad_request', 'the text is larger than 256 KB')
    if (!text && !enter) return err('bad_request', 'nothing to send')
    const list = await this.list()
    if ('ok' in list) return list
    const t = this.target(list, params, caller)
    if (!t.ok) return t
    if (this.sshProtected(t.workspace, t.pane)) return err('ssh_protected', 'this console has a Connection Profile (cliProtectSsh)')
    const ptyId = this.deps.pty.ptyIdForPane(t.pane.id)
    if (!ptyId) return err('not_running', 'the console is not running')
    const res = await this.deps.pty.submitToPane(ptyId, t.pane.id, text, enter)
    if (!res.ok) return res.error === 'multiline_unsafe' ? err('multiline_unsafe', 'multi-line text: this console does not accept a safe paste') : err('not_running', 'the console is not running')
    return ok({ paneId: t.pane.id, enter })
  }

  private async read(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    let lines = CTL_READ_DEFAULT
    if (params.lines !== undefined) {
      const n = Number(params.lines)
      if (!Number.isInteger(n) || n < 1) return err('bad_request', '--lines must be a positive integer')
      lines = Math.min(n, CTL_READ_MAX)
    }
    const list = await this.list()
    if ('ok' in list) return list
    const t = this.target(list, params, caller)
    if (!t.ok) return t
    if (this.sshProtected(t.workspace, t.pane)) return err('ssh_protected', 'this console has a Connection Profile (cliProtectSsh)')
    if (!this.deps.pty.ptyIdForPane(t.pane.id)) return err('not_running', 'the console is not running')
    const res = await this.deps.bus.request({ kind: 'read', paneId: t.pane.id, lines })
    if (res.ok) {
      const data = res.data as CtlRendererData['read'] | undefined
      return ok({ paneId: t.pane.id, lines: Array.isArray(data?.lines) ? data!.lines.slice(-lines) : [] })
    }
    if (res.error !== 'not_running') return this.busErr(res)
    // No mounted xterm: main's ring, escapes stripped, carriage returns applied.
    const ring = this.deps.pty.tail(t.pane.id)
    if (ring === null) return err('not_running', 'the console is not running')
    return ok({ paneId: t.pane.id, lines: tailLines(stripAnsi(ring), lines), fallback: true })
  }

  private async wait(params: Record<string, unknown>, caller: CtlCaller | null, signal: AbortSignal): Promise<Out> {
    let timeoutS = CTL_WAIT_DEFAULT_S
    if (params.timeout !== undefined) {
      const n = Number(params.timeout)
      if (!Number.isFinite(n) || n <= 0) return err('bad_request', '--timeout must be a positive number of seconds')
      timeoutS = Math.min(n, CTL_WAIT_MAX_S)
    }
    let quietMs = CTL_WAIT_QUIET_MS
    if (params.quietMs !== undefined) {
      const n = Number(params.quietMs)
      if (!Number.isInteger(n) || n < 100 || n > 600_000) return err('bad_request', '--quiet-ms must be between 100 and 600000')
      quietMs = n
    }
    if (this.waiters.size >= CTL_MAX_WAITERS) return err('busy', `too many waits at once (max ${CTL_MAX_WAITERS})`)
    const list = await this.list()
    if ('ok' in list) return list
    const t = this.target(list, params, caller)
    if (!t.ok) return t
    if (caller && t.pane.id === caller.paneId) return err('bad_request', 'a console cannot wait for itself')
    if (!this.deps.pty.ptyIdForPane(t.pane.id)) return err('not_running', 'the console is not running')
    if (signal.aborted) return err('internal', 'cancelled')
    if (this.waiters.size >= CTL_MAX_WAITERS) return err('busy', `too many waits at once (max ${CTL_MAX_WAITERS})`)
    return new Promise<Out>((resolve) => {
      const w: Waiter = { paneId: t.pane.id, start: this.now(), timeoutMs: timeoutS * 1000, quietMs, first: true, timer: null, done: resolve }
      this.waiters.add(w)
      signal.addEventListener('abort', () => this.finish(w, err('internal', 'cancelled')), { once: true })
      w.timer = setInterval(() => this.evaluate(w), this.timing.tickMs)
      this.evaluate(w)
    })
  }

  private finish(w: Waiter, out: Out): void {
    if (!this.waiters.delete(w)) return
    if (w.timer) clearInterval(w.timer)
    w.timer = null
    w.done(out)
  }

  /** One look at a waiter's pane (E8-FR-18). */
  private evaluate(w: Waiter): void {
    if (!this.waiters.has(w)) return
    const now = this.now()
    const first = w.first
    w.first = false
    const waitedMs = now - w.start
    if (!this.deps.pty.ptyIdForPane(w.paneId)) {
      this.finish(w, err('exited', 'the console exited'))
      return
    }
    const st = this.deps.status.stateOf(w.paneId)
    const state = st?.state ?? null
    const precise = st?.precise ?? false
    const result = (extra: Partial<CtlWaitResult> = {}): Out => ok({ state, precise, waitedMs, ...extra } satisfies CtlWaitResult)
    if (state !== null && state !== 'unknown') {
      const submitAt = this.deps.pty.lastSubmitAt(w.paneId)
      const transitionAt = Math.max(this.lastTransitionAt.get(w.paneId) ?? 0, st?.stateSince ?? 0)
      // A submit with Enter and no transition after it: the turn has not started.
      if (submitAt !== undefined && transitionAt <= submitAt) {
        if (now >= Math.max(submitAt + this.timing.noTurnMs, w.start)) {
          this.finish(w, result({ noTurnObserved: true }))
          return
        }
      } else if (FREE_STATES.has(state)) {
        const since = st?.stateSince ?? now
        const recentWorking = this.lastWorkingAt.get(w.paneId) ?? 0
        if (now - since >= this.timing.settleMs || (first && now - recentWorking >= this.timing.recentWorkingMs)) {
          this.finish(w, result())
          return
        }
      }
    } else {
      // No agent state (shell, no hooks): quiet output.
      const last = Math.max(this.deps.pty.lastOutputAt(w.paneId) ?? 0, this.deps.pty.lastSubmitAt(w.paneId) ?? 0)
      if (now - last >= w.quietMs) {
        this.finish(w, result())
        return
      }
    }
    if (waitedMs >= w.timeoutMs) this.finish(w, err('timeout', `timed out after ${Math.round(waitedMs / 1000)} s`, { state, waitedMs }))
  }

  private async status(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const list = await this.list()
    if ('ok' in list) return list
    let paneId: string
    if (str(params.console) !== undefined) {
      const t = this.target(list, params, caller)
      if (!t.ok) return t
      paneId = t.pane.id
    } else if (caller) paneId = caller.paneId
    else return err('bad_request', 'status outside a SnAgentsOS console needs --console')
    if (!list.workspaces.some((w) => w.panes.some((p) => p.id === paneId))) return err('not_found', 'console not found')
    if (bool(params.clear)) {
      const res = await this.deps.bus.request({ kind: 'setStatusLine', paneId, text: null })
      if (!res.ok) return this.busErr(res)
      this.statusLinePanes.delete(paneId)
      return ok({ paneId, statusLine: null })
    }
    const raw = str(params.text)
    if (raw === undefined) {
      const st = this.deps.status.stateOf(paneId)
      return ok({ paneId, state: st?.state ?? null, precise: st?.precise ?? false, statusLine: list.statusLines[paneId] ?? null })
    }
    const text = oneLine(raw, CTL_STATUS_MAX)
    if (!text) return err('bad_request', 'empty status text (use --clear)')
    const res = await this.deps.bus.request({ kind: 'setStatusLine', paneId, text })
    if (!res.ok) return this.busErr(res)
    this.statusLinePanes.add(paneId)
    return ok({ paneId, statusLine: text })
  }

  private async notify(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const body = oneLine(str(params.text) ?? '', CTL_NOTIFY_BODY_MAX)
    if (!body) return err('bad_request', 'notify needs a text')
    const title = oneLine(str(params.title) ?? '', CTL_NOTIFY_TITLE_MAX) || BRAND.productName
    const key = caller?.paneId ?? 'master'
    const now = this.now()
    const log = (this.notifyLog.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
    if (log.length >= CTL_NOTIFY_PER_MIN) {
      this.notifyLog.set(key, log)
      return err('rate_limited', `at most ${CTL_NOTIFY_PER_MIN} notifications per minute`)
    }
    log.push(now)
    this.notifyLog.set(key, log)
    const local = bool(params.local)
    this.deps.notify({ paneId: caller?.paneId ?? null, title, body, local })
    if (caller) void this.deps.bus.request({ kind: 'attention', paneId: caller.paneId })
    return ok({ title, body, local })
  }

  private async note(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const clear = bool(params.clear)
    const rawState = params.taskState
    if (rawState !== undefined && !isTaskState(rawState)) return err('bad_request', '--task-state must be todo, doing, review or done')
    const raw = str(params.text)
    if (!clear && raw === undefined && rawState === undefined) return err('bad_request', 'note needs a text, --task-state or --clear')
    const list = await this.list()
    if ('ok' in list) return list
    const sc = this.scope(list, params, caller)
    if ('ok' in sc) return sc
    if (!sc.id) return err('bad_request', 'no workspace (use --workspace)')
    const op = clear
      ? { kind: 'setNote' as const, workspaceId: sc.id, note: null, taskState: null }
      : {
          kind: 'setNote' as const,
          workspaceId: sc.id,
          ...(raw !== undefined ? { note: normalizeWorkspaceNote(raw) ?? null } : {}),
          ...(isTaskState(rawState) ? { taskState: rawState } : {}),
        }
    const res = await this.deps.bus.request(op)
    if (!res.ok) return this.busErr(res)
    return ok({ workspaceId: sc.id, note: clear ? null : (op.note ?? undefined), taskState: clear ? null : (isTaskState(rawState) ? rawState : undefined) })
  }
}
