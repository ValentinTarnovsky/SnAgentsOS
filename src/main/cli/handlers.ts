import { stat } from 'fs/promises'
import { posix, win32 } from 'path'
import { BRAND } from '@shared/brand'
import {
  CTL_ACCOUNT_USE_PER_MIN,
  CTL_CHAT_BLOCK_MAX,
  CTL_CHAT_MAX_PAGES,
  CTL_CHAT_TURNS_DEFAULT,
  CTL_CHAT_TURNS_MAX,
  CTL_MAX_PROMPT,
  CTL_MAX_SEND,
  CTL_MAX_WAITERS,
  CTL_MUTATE_PER_MIN,
  CTL_NOTES_WRITE_PER_MIN,
  CTL_NOTIFY_BODY_MAX,
  CTL_NOTIFY_PER_MIN,
  CTL_NOTIFY_TITLE_MAX,
  CTL_PEEK_LINES_DEFAULT,
  CTL_PROTOCOL_VERSION,
  CTL_READ_DEFAULT,
  CTL_READ_MAX,
  CTL_READS_PER_MIN,
  CTL_STATUS_MAX,
  CTL_TITLE_MAX,
  CTL_WAIT_DEFAULT_S,
  CTL_WAIT_MAX_S,
  CTL_WAIT_QUIET_MS,
  CTL_WS_NAME_MAX,
  CTL_WS_NEW_PER_MIN,
  type CtlAccountStatus,
  type CtlChatResult,
  type CtlConsoleInfo,
  type CtlErrorCode,
  type CtlListData,
  type CtlListPane,
  type CtlListWorkspace,
  type CtlMethod,
  type CtlNeedsResult,
  type CtlPeekResult,
  type CtlRendererData,
  type CtlResponse,
  type CtlSpawnResult,
  type CtlStatusSignals,
  type CtlUsageResult,
  type CtlUsageRow,
  type CtlWaitResult,
  type CtlWorkspaceInfo,
} from '@shared/ctl-protocol'
import { resolveConsoleRef, resolveNoteRef, resolveWorkspaceRef, workspaceOfPane, type RefError } from '@shared/ctlRefs'
import { stripAnsi, tailLines } from '@shared/ansi'
import { typingBlocked } from '@shared/agentTune'
import { isTaskState, normalizeWorkspaceNote } from '@shared/workspaceNote'
import { WS_NOTE_MAX_BYTES, WS_NOTE_TITLE_MAX, type WsNoteCreateReq, type WsNoteDoc, type WsNoteError, type WsNoteMeta, type WsNoteReadReq, type WsNoteResult, type WsNoteWriteReq, type WsNotesListRes } from '@shared/ws-notes'
import { chatMessageOffset, type ChatBlock, type ChatMessage, type ChatUnavailableReason } from '@shared/chat-types'
import { NEEDS_TEXT_MAX, type AgentProvider, type ClaudePaneState, type ConfigFile, type PaneStatusEvt, type PaneType } from '@shared/types'
import { digestLine, toolFamilyKey, type ToolFamily } from '@shared/toolActivity'
import { redactCredentials } from '@shared/redact'
import { TEAM_READS_PER_MIN, TEAM_WRITES_PER_MIN } from '@shared/teams'
import { teamTool, type TeamCtlMethod } from '@shared/teamTools'
import type { PtySubmitRes, UsageSnapshot } from '@shared/ipc-contract'
import type { AccountsOpError } from '@shared/claude-accounts'
import { readPage } from '../chat/TranscriptWatcher'
import { decoderFor } from '../chat/ChatHub'
import type { LocateResult } from '../chat/TranscriptLocator'
import { mainTLang } from '../i18n'
import type { BusResult, RendererBus } from './rendererBus'
import type { CtlCaller, CtlTeamCaller } from './CtlTokens'

/** The PtyManager surface the CLI uses. */
export interface CtlPtyView {
  ptyIdForPane(paneId: string): string | null
  submitToPane(ptyId: string, paneId: string | undefined, text: string, enter: boolean, origin?: 'user' | 'auto', readyFor?: AgentProvider, userGate?: boolean): Promise<PtySubmitRes>
  lastSubmitAt(paneId: string): number | undefined
  lastOutputAt(paneId: string): number | undefined
  /** The live pty's raw ring (no side effects), or null. */
  tail(paneId: string): string | null
}

export interface CtlStatusView {
  stateOf(paneId: string): PaneStatusEvt | null
  /**
   * App 2.7.0 (A3): opens (`text`, one line already clipped) or clears (null)
   * the pane's `snaos needs` request. False when the pane has no live pty.
   */
  setNeeds(paneId: string, text: string | null): boolean
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

/** The WsNoteStore surface the CLI uses (the same instance as the renderer IPC and the phones, so every write emits). */
export interface CtlNotesView {
  list(workspaceId: string): Promise<WsNotesListRes>
  read(req: WsNoteReadReq): Promise<WsNoteResult<{ note: WsNoteDoc }>>
  write(req: WsNoteWriteReq): Promise<WsNoteResult<{ note: WsNoteMeta }>>
  create(req: WsNoteCreateReq): Promise<WsNoteResult<{ note: WsNoteMeta }>>
  delete(req: WsNoteReadReq): Promise<WsNoteResult<Record<never, never>>>
}

/**
 * Transcript lookup for `chat` / `peek`: TranscriptLocator.locate only. The
 * CLI reads the file one-shot (readPage) and is never a ChatHub reader: no
 * watcher, no LRU slot, so a phone's Chat is never evicted (FR-35 holds).
 */
export interface CtlChatView {
  locate(paneId: string): Promise<LocateResult>
}

/** The usage poller as the CLI reads it (registerUsageIpc's handle fits as is). */
export interface CtlUsageView {
  /** The current snapshot; fetches once when nothing was fetched yet (like `usage:get`). */
  load(): Promise<UsageSnapshot>
  enabled(): boolean
}

/** Outcome of a switch: never the account state, a token or an email. */
export interface CtlAccountSwitchRes {
  ok: boolean
  error?: AccountsOpError
}

/**
 * Claude accounts as the CLI sees them: an adapter over AccountService
 * (accountsView.ts) that picks every field, so no token, credentials blob or
 * email ever reaches a console.
 */
export interface CtlAccountsView {
  status(): Promise<CtlAccountStatus>
  switchTo(id: string, reason: 'cli'): Promise<CtlAccountSwitchRes>
}

/**
 * App 2.7.0 (Teams, design 3.9): `snaos team` of a team run. TeamService's
 * ctlView (teams/teamCtl.ts) checks the params, the role and the run, applies
 * the call to the store and maps its errors; the gate and the budgets stay here.
 * B5 integration, fifth round: `secrets` (CtlTokens) lets it refuse a text that
 * holds a live token of the app, right after the Labs gate.
 */
export interface CtlTeamsView {
  handle(method: TeamCtlMethod, params: Record<string, unknown>, who: CtlTeamCaller, secrets?: CtlSecrets): Promise<CtlResponse>
}

/** B5 integration, fifth round: the live tokens of the app as a team call checks its texts against them (CtlTokens). */
export interface CtlSecrets {
  holdsToken(text: string): boolean
}

/**
 * Main services the CLI reaches once bootstrap built them (CliService.attach).
 * Each is optional: a missing one answers `disabled`.
 */
export interface CtlServices {
  notes?: CtlNotesView
  chat?: CtlChatView
  usage?: CtlUsageView
  accounts?: CtlAccountsView
  teams?: CtlTeamsView
}

export interface CtlHandlerDeps {
  bus: RendererBus
  pty: CtlPtyView
  status: CtlStatusView
  config: () => ConfigFile | null
  notify: (notice: CtlNotice) => void
  appVersion: string
  now?: () => number
  timing?: Partial<CtlTiming>
  /** OS whose path rules `open --path` follows (default process.platform; tests pin one). */
  platform?: NodeJS.Platform
  /** Late-bound services (notes, transcripts). */
  services?: () => CtlServices
  /** B5 integration, fifth round: the live tokens (CliService's CtlTokens); a team text that holds one is refused. */
  secrets?: CtlSecrets
  /** `ws new`: the folder exists (a stat, nothing is opened or read). */
  isDir?: (path: string) => Promise<boolean>
}

const REASON_TEXT: Record<ChatUnavailableReason, string> = {
  noTranscript: 'no transcript found',
  ambiguous: 'more than one transcript could be this console',
  notLocal: 'the agent runs on another machine',
}

const defaultIsDir = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory(), () => false)

/** A text clipped at `max` characters without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  let out = text.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/** One transcript message as `chat` shows it, or null when nothing is left. */
function chatView(m: ChatMessage, opts: { tools: boolean; thinking: boolean }): ChatMessage | null {
  const blocks: ChatBlock[] = []
  for (const b of m.blocks) {
    if (b.t === 'notice') continue
    if (b.t === 'thinking' && !opts.thinking) continue
    if (b.t === 'toolResult' && !opts.tools) continue
    if (b.t === 'text' && b.text.length > CTL_CHAT_BLOCK_MAX) blocks.push({ ...b, text: clip(b.text, CTL_CHAT_BLOCK_MAX), truncated: true })
    else blocks.push(b)
  }
  return blocks.length ? { ...m, blocks } : null
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

/** A family as the digest line names it: English whatever the app language (the CLI's output is English on purpose). */
const familyWord = (family: ToolFamily): string => mainTLang('en', toolFamilyKey(family))

/**
 * App 2.7.0 (A3): main's status as the agent state of a pane. A `bare` one
 * (only a `snaos needs` on a pane with no agent track) is no agent state:
 * null, as a plain shell reads; signalsOf still takes its needs.
 */
function agentStatus(st: PaneStatusEvt | null): PaneStatusEvt | null {
  return st?.bare ? null : st
}

/** App 2.7.0 (A3): main's signals of a pane, field by field (never the failure code, the files list or signalAt). */
function signalsOf(st: PaneStatusEvt | null): CtlStatusSignals {
  const out: CtlStatusSignals = {}
  if (!st) return out
  if (st.digest && st.digest.tools > 0) out.digest = { tools: st.digest.tools, line: digestLine(st.digest, familyWord) }
  if (st.failure) out.failure = { kind: st.failure.kind, ...(st.failure.until !== undefined ? { until: st.failure.until } : {}) }
  if (st.silence) out.silence = { level: st.silence.level, since: st.silence.since }
  if (st.needs) out.needs = { text: st.needs.text, at: st.needs.at }
  return out
}

/** Node's path rules of `platform`, never the host's (a test may pin another OS). */
function pathFor(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix
}

/**
 * A path compared the way Windows does (both separators, case-insensitive,
 * no trailing separator) or POSIX does (case-sensitive, a backslash is part of
 * a name), with the rules of `platform` whatever OS runs this.
 */
export function samePathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const abs = pathFor(platform).resolve(p.trim())
  return platform === 'win32' ? abs.replace(/[\\/]+$/, '').toLowerCase() : abs.replace(/\/+$/, '')
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
  /** Rate windows, `<bucket>:<caller key>` -> call times of the last minute. */
  private readonly rateLog = new Map<string, number[]>()
  /** One promise chain per `<workspace>/<note>`: appends never interleave. */
  private readonly noteChains = new Map<string, Promise<unknown>>()
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
    // App 2.7.0 (Teams): a team token reaches only its own tools. It has no workspace, and scope() falls back to the
    // active one, so without this gate a team agent could send to or kill the user's consoles there.
    if (caller?.team) {
      if (method !== 'ping' && method !== 'usage' && !method.startsWith('team.')) return err('forbidden', 'a team agent may only use snaos team, ping and usage')
    } else if (method.startsWith('team.')) return err('forbidden', 'snaos team works only inside a team run')
    if (method.startsWith('team.')) return this.team(method as TeamCtlMethod, params, caller)
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
      case 'chat':
        return this.chat(params, caller)
      case 'peek':
        return this.peek(params, caller)
      case 'kill':
        return this.kill(params, caller)
      case 'restart':
        return this.restart(params, caller)
      case 'rename':
        return this.rename(params, caller)
      case 'ws.new':
        return this.wsNew(params, caller)
      case 'ws.rename':
        return this.wsRename(params, caller)
      case 'ws.close':
        return this.wsClose(params, caller)
      case 'ws.fav':
        return this.wsFav(params, caller)
      case 'notes.ls':
        return this.notesLs(params, caller)
      case 'notes.get':
        return this.notesGet(params, caller)
      case 'notes.new':
        return this.notesNew(params, caller)
      case 'notes.set':
        return this.notesSet(params, caller)
      case 'notes.append':
        return this.notesAppend(params, caller)
      case 'notes.rm':
        return this.notesRm(params, caller)
      case 'notes.open':
        return this.notesOpen(params, caller)
      case 'usage':
        return this.usage(params)
      case 'account.ls':
        return this.accountLs(params)
      case 'account.status':
        return this.accountStatus()
      case 'account.use':
        return this.accountUse(params)
      case 'needs':
        return this.needs(params, caller)
      default:
        return err('bad_request', 'unknown method')
    }
  }

  // --- Observers (wired by CliService) -------------------------------------

  /** StatusManager listener: transitions feed `wait`. */
  onStatus(evt: PaneStatusEvt): void {
    const now = this.now()
    // App 2.7.0 (A3): a bare status (needs only) counts as no state, like null.
    const state = agentStatus(evt)?.state ?? null
    const prev = this.lastState.has(evt.paneId) ? this.lastState.get(evt.paneId) : undefined
    if (prev !== state) {
      this.lastTransitionAt.set(evt.paneId, now)
      this.lastState.set(evt.paneId, state)
    }
    if (state === 'working') this.lastWorkingAt.set(evt.paneId, now)
    if (state === null) this.lastState.delete(evt.paneId)
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

  /** A caller that is gone for good (a team run's revoked token, `team:<runId>`): its rate windows go too. */
  forgetCaller(paneId: string): void {
    const suffix = `:${paneId}`
    for (const key of [...this.rateLog.keys()]) if (key.endsWith(suffix)) this.rateLog.delete(key)
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

  /**
   * One call in `bucket` for the caller (its pane, or 'master'), false when
   * it already made `max` in the last minute. Generalizes notify's budget.
   */
  private take(bucket: string, caller: CtlCaller | null, max: number): boolean {
    const key = `${bucket}:${caller?.paneId ?? 'master'}`
    const now = this.now()
    const log = (this.rateLog.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
    if (log.length >= max) {
      this.rateLog.set(key, log)
      return false
    }
    log.push(now)
    this.rateLog.set(key, log)
    return true
  }

  private services(): CtlServices {
    return this.deps.services?.() ?? {}
  }

  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
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
      ...(w.favorite ? { favorite: true as const } : {}),
      ...(w.note ? { note: w.note } : {}),
      ...(w.taskState ? { taskState: w.taskState } : {}),
      consoles: w.panes.map((p, i): CtlConsoleInfo => {
        const raw = this.deps.status.stateOf(p.id)
        const st = agentStatus(raw)
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
          ...signalsOf(raw),
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
      const platform = this.deps.platform ?? process.platform
      const key = samePathKey(dir, platform)
      const hit = list.workspaces.find((w) => w.cwd && samePathKey(w.cwd, platform) === key)
      if (!hit) {
        const res = await this.deps.bus.request({ kind: 'composer', cwd: pathFor(platform).resolve(dir.trim()) })
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
    // A menu waiting on the user (main's own status): a digit or an Enter
    // would answer it, so one agent could approve another's permission.
    if (typingBlocked(this.deps.status.stateOf(t.pane.id))) {
      return err('awaiting_user', 'the console waits on the user (a permission, question or plan): nothing was typed')
    }
    // v2.3: an agent's send answers the prompt (cards go away) but never marks the user's result as seen.
    // userGate: main checks again right before the deferred Enter, so a menu
    // that opens while the text is typed never gets it.
    const res = await this.deps.pty.submitToPane(ptyId, t.pane.id, text, enter, 'auto', undefined, true)
    if (!res.ok) {
      if (res.error === 'multiline_unsafe') return err('multiline_unsafe', 'multi-line text: this console does not accept a safe paste')
      if (res.error === 'awaiting_user') return err('awaiting_user', 'the console waits on the user (a permission, question or plan): nothing was typed')
      if (res.error === 'enter_held') return err('awaiting_user', 'the console started waiting on the user (a permission, question or plan) before the Enter: the text was typed, not submitted')
      return err('not_running', 'the console is not running')
    }
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
    // A bare status (a needs on a pane with no agent) waits like a plain shell.
    const st = agentStatus(this.deps.status.stateOf(w.paneId))
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
      const evt = this.deps.status.stateOf(paneId)
      const st = agentStatus(evt)
      return ok({ paneId, state: st?.state ?? null, precise: st?.precise ?? false, statusLine: list.statusLines[paneId] ?? null, ...signalsOf(evt) })
    }
    const text = oneLine(raw, CTL_STATUS_MAX)
    if (!text) return err('bad_request', 'empty status text (use --clear)')
    const res = await this.deps.bus.request({ kind: 'setStatusLine', paneId, text })
    if (!res.ok) return this.busErr(res)
    this.statusLinePanes.add(paneId)
    return ok({ paneId, statusLine: text })
  }

  /**
   * App 2.7.0 (A3): `snaos needs "<action>" | --clear`. The request lives in
   * main (StatusManager: attention, never `pending`), so a console token needs
   * no renderer: it always targets its own pane. The master token names one
   * with `--console`; a console naming another one is forbidden.
   */
  private async needs(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const clear = bool(params.clear)
    const raw = str(params.text)
    if (clear && raw !== undefined) return err('bad_request', 'use either a text or --clear')
    if (!clear && raw === undefined) return err('bad_request', 'needs takes a text or --clear')
    const text = clear ? null : oneLine(raw ?? '', NEEDS_TEXT_MAX)
    if (text === '') return err('bad_request', 'empty needs text (use --clear)')
    let paneId: string
    if (str(params.console) !== undefined) {
      const list = await this.list()
      if ('ok' in list) return list
      const t = this.target(list, params, caller)
      if (!t.ok) return t
      if (caller && t.pane.id !== caller.paneId) return err('forbidden', 'a console can only raise or clear its own needs')
      paneId = t.pane.id
    } else if (caller) paneId = caller.paneId
    else return err('bad_request', 'outside a SnAgentsOS console, needs takes --console')
    if (!this.take('mutate', caller, CTL_MUTATE_PER_MIN)) return err('rate_limited', `at most ${CTL_MUTATE_PER_MIN} console or workspace changes per minute`)
    if (!this.deps.status.setNeeds(paneId, text)) return err('not_found', 'that console is not running')
    const out: CtlNeedsResult = { paneId, needs: text }
    return ok(out)
  }

  /**
   * App 2.7.0 (Teams, design 5.1): `snaos team` of a team run (the gate in handle() let only a team caller through).
   * Budgets per run (`team:<runId>`, freed by forgetCaller at revoke): 120 reads and 60 writes a minute. The live
   * tokens go along (B5 integration, fifth round): teamCtl refuses a text that holds one (`detail: 'secret'`).
   */
  private async team(method: TeamCtlMethod, params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const teams = this.services().teams
    if (!teams) return err('disabled', 'snaos team is not available in this build')
    const spec = teamTool(method)
    if (!spec || !caller?.team) return err('bad_request', 'unknown method')
    const write = spec.write
    if (!this.take(write ? 'teamWrite' : 'teamRead', caller, write ? TEAM_WRITES_PER_MIN : TEAM_READS_PER_MIN))
      return err('rate_limited', `at most ${TEAM_READS_PER_MIN} team reads and ${TEAM_WRITES_PER_MIN} team writes per minute and run: wait a minute`)
    return teams.handle(spec.method, params, caller.team, this.deps.secrets)
  }

  private async notify(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    // App 2.7.0 (A5): credentials never reach a channel nor the echo. Masked on
    // the whole line, before the clip, so a key cut at the limit keeps no head.
    const line = (v: unknown, max: number): string => oneLine(redactCredentials(oneLine(str(v) ?? '', Infinity)), max)
    const body = line(params.text, CTL_NOTIFY_BODY_MAX)
    if (!body) return err('bad_request', 'notify needs a text')
    const title = line(params.title, CTL_NOTIFY_TITLE_MAX) || BRAND.productName
    if (!this.take('notify', caller, CTL_NOTIFY_PER_MIN)) return err('rate_limited', `at most ${CTL_NOTIFY_PER_MIN} notifications per minute`)
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

  // --- app 2.3.0: observe other consoles ------------------------------------
  // `chat` and `peek` only look: they never acknowledge attention (no ackPane,
  // no setRemoteSeen, no paneAttention), so an agent watching a console never
  // "reads" a result for the user.

  /** The last screen lines of a running console: the xterm buffer, else main's ring; [] when neither answers. */
  private async screen(paneId: string, lines: number): Promise<string[]> {
    const res = await this.deps.bus.request({ kind: 'read', paneId, lines })
    if (res.ok) {
      const data = res.data as CtlRendererData['read'] | undefined
      return Array.isArray(data?.lines) ? data!.lines.slice(-lines) : []
    }
    const ring = this.deps.pty.tail(paneId)
    return ring === null ? [] : tailLines(stripAnsi(ring), lines)
  }

  private async chat(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    let turns = CTL_CHAT_TURNS_DEFAULT
    if (params.turns !== undefined) {
      const n = Number(params.turns)
      if (!Number.isInteger(n) || n < 1) return err('bad_request', '--turns must be a positive integer')
      turns = Math.min(n, CTL_CHAT_TURNS_MAX)
    }
    let before: number | null = null
    if (params.before !== undefined) {
      const raw = params.before
      const n = typeof raw === 'string' ? (/^\d{1,16}$/.test(raw) ? Number(raw) : NaN) : typeof raw === 'number' ? raw : NaN
      if (!Number.isSafeInteger(n) || n < 0) return err('bad_request', '--before must be a cursor printed by an earlier snaos chat')
      before = n
    }
    const opts = { tools: bool(params.tools), thinking: bool(params.thinking) }
    const svc = this.services().chat
    if (!svc) return err('disabled', 'reading transcripts is not available yet')
    const list = await this.list()
    if ('ok' in list) return list
    const t = this.target(list, params, caller)
    if (!t.ok) return t
    if (this.sshProtected(t.workspace, t.pane)) return err('ssh_protected', 'this console has a Connection Profile (cliProtectSsh)')
    if (!this.take('read', caller, CTL_READS_PER_MIN)) return err('rate_limited', `at most ${CTL_READS_PER_MIN} chat or peek calls per minute`)
    const paneId = t.pane.id
    let loc: LocateResult
    try {
      loc = await svc.locate(paneId)
    } catch {
      return err('internal', 'could not locate the transcript')
    }
    const noChat = (reason: ChatUnavailableReason): Fail => {
      const hint = this.deps.pty.ptyIdForPane(paneId) ? `snaos read ${paneId} shows its screen` : `snaos peek ${paneId} shows its state`
      // A transcript reason, never the CLI's own `ambiguous` (exit 4).
      return err('not_found', `no chat for this console (${REASON_TEXT[reason]}); ${hint}`, { reason })
    }
    if (!loc.ok) {
      if (loc.pending) return ok({ paneId, items: [], turns: 0, nextCursor: null, pending: true } satisfies CtlChatResult)
      return noChat(loc.reason)
    }
    const decode = decoderFor(loc.provider)
    const collected: ChatMessage[] = []
    let cursor: number | null = before
    let lastCursor: string | null = null
    let users = 0
    for (let page = 0; page < CTL_CHAT_MAX_PAGES; page++) {
      let res: Awaited<ReturnType<typeof readPage>>
      try {
        res = await readPage(loc.path, decode, { before: cursor, paneId })
      } catch {
        if (page === 0) return noChat('noTranscript')
        break
      }
      const kept = res.items.flatMap((m) => chatView(m, opts) ?? [])
      collected.unshift(...kept)
      users += kept.filter((m) => m.role === 'user').length
      lastCursor = res.cursor
      if (res.cursor === null || users >= turns) break
      cursor = Number(res.cursor)
    }
    // A turn starts at a user message: keep the last `turns` of them and what follows.
    let start = 0
    if (users >= turns) {
      let seen = 0
      for (let i = collected.length - 1; i >= 0; i--) {
        if (collected[i].role === 'user' && ++seen === turns) {
          start = i
          break
        }
      }
    }
    // One transcript line can hold a tool result and the user's prompt (`<off>.0`, `<off>.1`): the page
    // starts at the whole line, since `--before <off>` skips every part of it.
    const lineOffset = start > 0 ? chatMessageOffset(collected[start].id) : null
    if (lineOffset !== null) while (start > 0 && chatMessageOffset(collected[start - 1].id) === lineOffset) start--
    const items = collected.slice(start)
    const startOffset = start > 0 ? chatMessageOffset(items[0].id) : null
    const nextCursor = startOffset !== null ? String(startOffset) : lastCursor
    const out: CtlChatResult = { paneId, provider: loc.provider, items, turns: items.filter((m) => m.role === 'user').length, nextCursor }
    return ok(out)
  }

  /** Last assistant reply of a transcript (one page), for a status without `lastMessage`. */
  private async lastReply(paneId: string): Promise<string | undefined> {
    const svc = this.services().chat
    if (!svc) return undefined
    try {
      const loc = await svc.locate(paneId)
      if (!loc.ok) return undefined
      const page = await readPage(loc.path, decoderFor(loc.provider), { before: null, paneId })
      for (let i = page.items.length - 1; i >= 0; i--) {
        const m = page.items[i]
        if (m.role !== 'assistant') continue
        const text = m.blocks.flatMap((b) => (b.t === 'text' ? [b.text] : [])).join(' ')
        const line = oneLine(text, 280)
        if (line) return line
      }
    } catch {
      /* no transcript: the field stays out */
    }
    return undefined
  }

  private async peek(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    let lines = CTL_PEEK_LINES_DEFAULT
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
    if (!this.take('read', caller, CTL_READS_PER_MIN)) return err('rate_limited', `at most ${CTL_READS_PER_MIN} chat or peek calls per minute`)
    const pane = t.pane
    const raw = this.deps.status.stateOf(pane.id)
    const st = agentStatus(raw)
    const running = this.deps.pty.ptyIdForPane(pane.id) !== null
    const provider: AgentProvider | undefined = st?.provider ?? (pane.type === 'claude' || pane.type === 'codex' ? pane.type : undefined)
    const lastMessage = st?.lastMessage || (provider ? await this.lastReply(pane.id) : undefined)
    const statusLine = list.statusLines[pane.id]
    const out: CtlPeekResult = {
      paneId: pane.id,
      title: pane.title,
      type: pane.type,
      ...(provider ? { provider } : {}),
      running,
      state: st?.state ?? null,
      precise: st?.precise ?? false,
      ...(st?.attention !== undefined ? { attention: st.attention } : {}),
      ...(st?.reason ? { reason: st.reason } : {}),
      ...(st?.pendingCount !== undefined ? { pendingCount: st.pendingCount } : {}),
      ...(st?.pending?.length ? { pending: st.pending.map((p) => ({ kind: p.kind, ...(p.toolName ? { toolName: p.toolName } : {}), summary: p.summary })) } : {}),
      ...(st?.stateSince !== undefined ? { stateSince: st.stateSince } : {}),
      ...(st?.activity ? { activity: st.activity } : {}),
      ...(lastMessage ? { lastMessage } : {}),
      ...(st?.waiting ? { waiting: st.waiting } : {}),
      ...(statusLine ? { statusLine } : {}),
      ...(st?.model ? { model: st.model } : {}),
      ...(st?.effort ? { effort: st.effort } : {}),
      ...(st?.ultracode !== undefined ? { ultracode: st.ultracode } : {}),
      ...signalsOf(raw),
      lines: running ? await this.screen(pane.id, lines) : [],
    }
    return ok(out)
  }

  // --- app 2.3.0: consoles ---------------------------------------------------

  private async kill(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const list = await this.list()
    if ('ok' in list) return list
    const t = this.target(list, params, caller)
    if (!t.ok) return t
    if (caller && t.pane.id === caller.paneId) return err('bad_request', 'a console cannot kill itself')
    if (this.sshProtected(t.workspace, t.pane)) return err('ssh_protected', 'this console has a Connection Profile (cliProtectSsh)')
    if (!this.take('mutate', caller, CTL_MUTATE_PER_MIN)) return err('rate_limited', `at most ${CTL_MUTATE_PER_MIN} console or workspace changes per minute`)
    const close = bool(params.close)
    const killed = this.deps.pty.ptyIdForPane(t.pane.id) !== null
    const res = await this.deps.bus.request({ kind: 'kill', workspaceId: t.workspace.id, paneId: t.pane.id, close, running: killed })
    if (!res.ok) return this.busErr(res)
    return ok({ paneId: t.pane.id, killed, closed: close })
  }

  private async restart(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const resume = params.resume === true ? true : params.resume === false ? false : undefined
    const list = await this.list()
    if ('ok' in list) return list
    const t = this.target(list, params, caller)
    if (!t.ok) return t
    if (caller && t.pane.id === caller.paneId) return err('bad_request', 'a console cannot restart itself')
    if (this.sshProtected(t.workspace, t.pane)) return err('ssh_protected', 'this console has a Connection Profile (cliProtectSsh)')
    if (resume !== undefined && t.pane.type !== 'claude' && t.pane.type !== 'codex') return err('bad_request', '--resume and --fresh apply to Claude and Codex consoles')
    if (!this.take('mutate', caller, CTL_MUTATE_PER_MIN)) return err('rate_limited', `at most ${CTL_MUTATE_PER_MIN} console or workspace changes per minute`)
    const res = await this.deps.bus.request({ kind: 'restart', workspaceId: t.workspace.id, paneId: t.pane.id, ...(resume !== undefined ? { resume } : {}) })
    if (!res.ok) return this.busErr(res)
    return ok({ paneId: t.pane.id, mode: resume === true ? 'resume' : resume === false ? 'fresh' : 'default' })
  }

  private async rename(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const title = oneLine(str(params.title) ?? '', CTL_TITLE_MAX)
    if (!title) return err('bad_request', 'rename needs a title')
    const list = await this.list()
    if ('ok' in list) return list
    const t = this.target(list, params, caller)
    if (!t.ok) return t
    if (!this.take('mutate', caller, CTL_MUTATE_PER_MIN)) return err('rate_limited', `at most ${CTL_MUTATE_PER_MIN} console or workspace changes per minute`)
    const res = await this.deps.bus.request({ kind: 'renamePane', workspaceId: t.workspace.id, paneId: t.pane.id, title })
    if (!res.ok) return this.busErr(res)
    return ok({ paneId: t.pane.id, title })
  }

  // --- app 2.3.0: workspaces -------------------------------------------------

  private async workspaceParam(list: CtlListData, params: Record<string, unknown>, verb: string): Promise<{ ws: CtlListWorkspace; index: number } | Fail> {
    const ref = str(params.workspace)
    if (ref === undefined) return err('bad_request', `ws ${verb} needs a workspace`)
    const r = resolveWorkspaceRef(list, ref)
    return r.ok ? { ws: r.workspace, index: r.index } : refErr(r)
  }

  private async wsNew(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const raw = str(params.path)?.trim()
    if (!raw || raw.includes('\0') || raw.length > 4096) return err('bad_request', 'ws new needs a folder (--path)')
    const p = pathFor(this.platform())
    // The client made it absolute against its own cwd; main never guesses one.
    if (!p.isAbsolute(raw)) return err('bad_request', 'the folder must be an absolute path')
    const cwd = p.resolve(raw)
    if (!(await (this.deps.isDir ?? defaultIsDir)(cwd))) return err('not_found', `no such folder: ${cwd}`)
    const name = oneLine(str(params.name) ?? '', CTL_WS_NAME_MAX) || oneLine(p.basename(cwd), CTL_WS_NAME_MAX) || cwd
    // One budget for both paths: the composer also brings the window forward.
    if (!this.take('wsNew', caller, CTL_WS_NEW_PER_MIN)) return err('rate_limited', `at most ${CTL_WS_NEW_PER_MIN} new workspaces per minute`)
    if (bool(params.composer)) {
      const res = await this.deps.bus.request({ kind: 'composer', cwd, name })
      return res.ok ? ok({ composer: true, name, cwd }) : this.busErr(res)
    }
    const res = await this.deps.bus.request({ kind: 'createWorkspace', name, cwd, focus: bool(params.focus) })
    if (!res.ok) return this.busErr(res)
    const data = res.data as CtlRendererData['createWorkspace'] | undefined
    if (!data?.workspaceId) return err('internal', 'the desktop did not create the workspace')
    return ok({ workspaceId: data.workspaceId, index: data.index, name, cwd })
  }

  private async wsRename(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const name = oneLine(str(params.name) ?? '', CTL_WS_NAME_MAX)
    if (!name) return err('bad_request', 'ws rename needs a name')
    const list = await this.list()
    if ('ok' in list) return list
    const w = await this.workspaceParam(list, params, 'rename')
    if ('ok' in w) return w
    if (!this.take('mutate', caller, CTL_MUTATE_PER_MIN)) return err('rate_limited', `at most ${CTL_MUTATE_PER_MIN} console or workspace changes per minute`)
    const res = await this.deps.bus.request({ kind: 'renameWorkspace', workspaceId: w.ws.id, name })
    return res.ok ? ok({ workspaceId: w.ws.id, name }) : this.busErr(res)
  }

  private async wsClose(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    // The desktop always confirms this: it ends every console of the workspace.
    if (params.yes !== true) return err('bad_request', 'closing a workspace ends its consoles; add --yes')
    const list = await this.list()
    if ('ok' in list) return list
    const w = await this.workspaceParam(list, params, 'close')
    if ('ok' in w) return w
    if (caller && workspaceOfPane(list, caller.paneId)?.workspace.id === w.ws.id) return err('bad_request', 'a console cannot close its own workspace')
    // A console visiting from another workspace goes back home instead of ending (store.deleteWorkspace).
    const live = w.ws.panes.filter((p) => !p.homeWorkspaceId && this.deps.pty.ptyIdForPane(p.id) !== null)
    if (live.some((p) => this.sshProtected(w.ws, p))) return err('ssh_protected', 'a console of this workspace has a Connection Profile (cliProtectSsh)')
    if (!this.take('mutate', caller, CTL_MUTATE_PER_MIN)) return err('rate_limited', `at most ${CTL_MUTATE_PER_MIN} console or workspace changes per minute`)
    const res = await this.deps.bus.request({ kind: 'deleteWorkspace', workspaceId: w.ws.id })
    return res.ok ? ok({ workspaceId: w.ws.id, name: w.ws.name, consolesEnded: live.length }) : this.busErr(res)
  }

  private async wsFav(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const favorite = params.favorite !== false
    const list = await this.list()
    if ('ok' in list) return list
    const w = await this.workspaceParam(list, params, 'fav')
    if ('ok' in w) return w
    if (!this.take('mutate', caller, CTL_MUTATE_PER_MIN)) return err('rate_limited', `at most ${CTL_MUTATE_PER_MIN} console or workspace changes per minute`)
    const res = await this.deps.bus.request({ kind: 'setFavorite', workspaceId: w.ws.id, favorite })
    return res.ok ? ok({ workspaceId: w.ws.id, name: w.ws.name, favorite }) : this.busErr(res)
  }

  // --- app 2.3.0: Markdown notes of a workspace ------------------------------
  // Through the same WsNoteStore as the desktop and the phones, so every write
  // is atomic and emits (the open editor reloads or shows its conflict banner).

  private noteErr(e: WsNoteError, current?: WsNoteDoc): Fail {
    switch (e) {
      case 'not_found':
        return err('not_found', 'note not found')
      case 'invalid':
        return err('bad_request', 'invalid note request')
      case 'too_large':
        return err('bad_request', 'the note is larger than 1 MB')
      case 'conflict':
        // Never the text: only what a retry needs.
        return err('conflict', 'the note changed since --rev; read it again and retry', current ? { current: { rev: current.rev, updatedAt: current.updatedAt, size: current.size } } : undefined)
      case 'rate':
        return err('rate_limited', 'too many note requests')
      default:
        return err('internal', 'the note could not be saved')
    }
  }

  /** The notes service and the workspace: --workspace, else the caller's, else the active one. */
  private async noteScope(params: Record<string, unknown>, caller: CtlCaller | null): Promise<{ notes: CtlNotesView; wsId: string } | Fail> {
    const notes = this.services().notes
    if (!notes) return err('disabled', 'notes are not available yet')
    const list = await this.list()
    if ('ok' in list) return list
    const sc = this.scope(list, params, caller)
    if ('ok' in sc) return sc
    if (!sc.id) return err('bad_request', 'no workspace (use --workspace)')
    return { notes, wsId: sc.id }
  }

  private async noteTarget(params: Record<string, unknown>, caller: CtlCaller | null): Promise<{ notes: CtlNotesView; wsId: string; note: WsNoteMeta } | Fail> {
    const ref = str(params.note)
    if (ref === undefined) return err('bad_request', 'missing note (an id or its exact title)')
    const sc = await this.noteScope(params, caller)
    if ('ok' in sc) return sc
    const res = await sc.notes.list(sc.wsId)
    if (!res.ok) return err('internal', 'could not list the notes')
    const r = resolveNoteRef(res.notes, ref)
    return r.ok ? { ...sc, note: r.note } : refErr(r)
  }

  /** Runs `fn` after every earlier call on the same note. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.noteChains.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    this.noteChains.set(key, tail)
    void tail.then(() => {
      if (this.noteChains.get(key) === tail) this.noteChains.delete(key)
    })
    return run
  }

  private async notesLs(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const sc = await this.noteScope(params, caller)
    if ('ok' in sc) return sc
    const res = await sc.notes.list(sc.wsId)
    return res.ok ? ok({ workspaceId: sc.wsId, notes: res.notes }) : err('internal', 'could not list the notes')
  }

  private async notesGet(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const t = await this.noteTarget(params, caller)
    if ('ok' in t) return t
    const res = await t.notes.read({ workspaceId: t.wsId, noteId: t.note.id })
    return res.ok ? ok({ workspaceId: t.wsId, note: res.note }) : this.noteErr(res.error)
  }

  private async notesNew(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const title = oneLine(str(params.title) ?? '', WS_NOTE_TITLE_MAX)
    const text = str(params.text) ?? ''
    const body = title ? `# ${title}\n\n${text}` : text
    if (Buffer.byteLength(body, 'utf8') > WS_NOTE_MAX_BYTES) return err('bad_request', 'the note is larger than 1 MB')
    const sc = await this.noteScope(params, caller)
    if ('ok' in sc) return sc
    if (!this.take('notesWrite', caller, CTL_NOTES_WRITE_PER_MIN)) return err('rate_limited', `at most ${CTL_NOTES_WRITE_PER_MIN} note writes per minute`)
    const res = await sc.notes.create({ workspaceId: sc.wsId, text: body })
    if (!res.ok) return this.noteErr(res.error)
    let opened = false
    if (bool(params.open)) opened = (await this.deps.bus.request({ kind: 'openNote', workspaceId: sc.wsId, noteId: res.note.id })).ok
    return ok({ workspaceId: sc.wsId, note: res.note, ...(opened ? { opened: true } : {}) })
  }

  private async notesSet(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const text = str(params.text)
    if (text === undefined) return err('bad_request', 'notes set needs a text (argument, - for stdin or --file)')
    const rev = params.rev
    if (rev !== undefined && (typeof rev !== 'string' || !rev.trim())) return err('bad_request', 'invalid --rev')
    if (Buffer.byteLength(text, 'utf8') > WS_NOTE_MAX_BYTES) return err('bad_request', 'the note is larger than 1 MB')
    const t = await this.noteTarget(params, caller)
    if ('ok' in t) return t
    if (!this.take('notesWrite', caller, CTL_NOTES_WRITE_PER_MIN)) return err('rate_limited', `at most ${CTL_NOTES_WRITE_PER_MIN} note writes per minute`)
    const res = await t.notes.write({ workspaceId: t.wsId, noteId: t.note.id, text, ...(typeof rev === 'string' ? { baseRev: rev.trim() } : {}) })
    return res.ok ? ok({ workspaceId: t.wsId, note: res.note }) : this.noteErr(res.error, res.current)
  }

  private async notesAppend(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const add = str(params.text)
    if (!add) return err('bad_request', 'notes append needs a text (argument, - for stdin or --file)')
    if (Buffer.byteLength(add, 'utf8') > WS_NOTE_MAX_BYTES) return err('bad_request', 'the note is larger than 1 MB')
    const t = await this.noteTarget(params, caller)
    if ('ok' in t) return t
    if (!this.take('notesWrite', caller, CTL_NOTES_WRITE_PER_MIN)) return err('rate_limited', `at most ${CTL_NOTES_WRITE_PER_MIN} note writes per minute`)
    const req = { workspaceId: t.wsId, noteId: t.note.id }
    return this.serial(`${t.wsId}/${t.note.id}`, async (): Promise<Out> => {
      // Read, add, write with the rev read: a desktop or phone edit in between is a conflict, retried once.
      for (let attempt = 0; ; attempt++) {
        const cur = await t.notes.read(req)
        if (!cur.ok) return this.noteErr(cur.error)
        const sep = cur.note.text && !cur.note.text.endsWith('\n') ? '\n' : ''
        const next = cur.note.text + sep + add
        if (Buffer.byteLength(next, 'utf8') > WS_NOTE_MAX_BYTES) return err('bad_request', 'the note would be larger than 1 MB')
        const res = await t.notes.write({ ...req, text: next, baseRev: cur.note.rev })
        if (res.ok) return ok({ workspaceId: t.wsId, note: res.note })
        if (res.error !== 'conflict' || attempt >= 1) return this.noteErr(res.error, res.current)
      }
    })
  }

  private async notesRm(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const t = await this.noteTarget(params, caller)
    if ('ok' in t) return t
    if (!this.take('notesWrite', caller, CTL_NOTES_WRITE_PER_MIN)) return err('rate_limited', `at most ${CTL_NOTES_WRITE_PER_MIN} note writes per minute`)
    const res = await t.notes.delete({ workspaceId: t.wsId, noteId: t.note.id })
    return res.ok ? ok({ workspaceId: t.wsId, noteId: t.note.id, trashed: true }) : this.noteErr(res.error)
  }

  private async notesOpen(params: Record<string, unknown>, caller: CtlCaller | null): Promise<Out> {
    const t = await this.noteTarget(params, caller)
    if ('ok' in t) return t
    const res = await this.deps.bus.request({ kind: 'openNote', workspaceId: t.wsId, noteId: t.note.id })
    return res.ok ? ok({ workspaceId: t.wsId, noteId: t.note.id }) : this.busErr(res)
  }

  // --- usage and Claude accounts (app 2.3.0, 4b) ----------------------------------

  /** `usage`: the Claude and Codex rows of main's usage poller (its cache, fetched once if empty). */
  private async usage(params: Record<string, unknown>): Promise<Out> {
    const svc = this.services().usage
    if (!svc) return err('disabled', 'usage is not available yet')
    const provider = params.provider
    if (provider !== undefined && provider !== 'claude' && provider !== 'codex') return err('bad_request', 'provider must be claude or codex')
    if (!svc.enabled()) return err('disabled', 'the usage bars are off (Settings > AI Usage)')
    let snap: UsageSnapshot
    try {
      snap = await svc.load()
    } catch {
      return err('internal', 'usage could not be read')
    }
    return ok(ctlUsage(snap, provider))
  }

  private accountsSvc(): CtlAccountsView | Fail {
    return this.services().accounts ?? err('disabled', 'Claude accounts are not available yet')
  }

  /** Only Claude logins are saved and switched; `--provider claude` is accepted for symmetry with `usage`. */
  private accountProvider(params: Record<string, unknown>): Fail | null {
    const p = params.provider
    if (p === undefined || p === 'claude') return null
    return err('bad_request', p === 'codex' ? 'only Claude accounts can be saved and switched' : 'provider must be claude')
  }

  private async accountLs(params: Record<string, unknown>): Promise<Out> {
    const svc = this.accountsSvc()
    if ('ok' in svc) return svc
    const bad = this.accountProvider(params)
    if (bad) return bad
    return ok({ accounts: (await svc.status()).accounts })
  }

  private async accountStatus(): Promise<Out> {
    const svc = this.accountsSvc()
    if ('ok' in svc) return svc
    return ok(await svc.status())
  }

  /**
   * `account use <n|slot|id|label>`: the slot (primary / secondary: #1 / #2)
   * first, then a number as the 1-based rank (app 2.4.0), then the exact id,
   * then the label (case-insensitive; two equal labels are `ambiguous`).
   * Already the live login (known and verified): ok with
   * `changed: false`, nothing written and no budget spent. Otherwise
   * CTL_ACCOUNT_USE_PER_MIN for every caller together, and
   * AccountService.switchTo with reason 'cli'. `changed` comes from the last
   * switch moving to the target with reason 'cli': switchTo also answers ok
   * without writing when its own reconcile finds the target already live. A
   * live login still unverified after that no-op is `busy` (identity_failed).
   */
  private async accountUse(params: Record<string, unknown>): Promise<Out> {
    const svc = this.accountsSvc()
    if ('ok' in svc) return svc
    const bad = this.accountProvider(params)
    if (bad) return bad
    const ref = (str(params.account) ?? '').trim()
    if (!ref) return err('bad_request', 'account use needs an account: its number (snaos account ls), an id or a label')
    const st = await svc.status()
    if (!st.supported) return err('disabled', 'saved Claude logins are not supported on this machine')
    const key = ref.toLowerCase()
    let hits = key === 'primary' ? st.accounts.filter((a) => a.rank === 1) : key === 'secondary' ? st.accounts.filter((a) => a.rank === 2) : []
    if (!hits.length && /^#?\d{1,2}$/.test(ref)) hits = st.accounts.filter((a) => a.rank === Number(ref.replace('#', '')))
    if (!hits.length) hits = st.accounts.filter((a) => a.id === ref)
    if (!hits.length) hits = st.accounts.filter((a) => a.label !== '' && a.label.toLowerCase() === key)
    if (hits.length > 1) return err('ambiguous', `more than one account is called "${ref}": use its number or an id (${hits.map((a) => `#${a.rank} ${a.id}`).join(', ')})`)
    const target = hits[0]
    if (!target) return err('not_found', `no saved Claude account "${ref}" (snaos account ls)`)
    if (target.active && st.live === 'known' && !st.unverified) return ok({ active: target, changed: false })
    if (!target.ready) return err('disabled', 'the saved login of that account cannot be used: capture it again on the desktop (Settings > Claude accounts)')
    // One budget for every caller (null key): the Claude login is global.
    if (!this.take('accountUse', null, CTL_ACCOUNT_USE_PER_MIN)) return err('rate_limited', `at most ${CTL_ACCOUNT_USE_PER_MIN} account switches per minute`)
    let res: CtlAccountSwitchRes
    try {
      res = await svc.switchTo(target.id, 'cli')
    } catch {
      return err('internal', 'the account switch failed')
    }
    if (!res.ok) return switchErr(res.error)
    const now = await svc.status()
    const ls = now.lastSwitch
    const changed = switchKey(ls) !== switchKey(st.lastSwitch) && ls?.to === target.id && ls.reason === 'cli'
    if (!changed && now.unverified) return switchErr('identity_failed')
    const after = now.accounts.find((a) => a.id === target.id) ?? { ...target, active: true }
    return ok({ active: after, changed })
  }
}

/** The CLI view of a usage snapshot: Claude and Codex windows, each field picked by name. */
export function ctlUsage(snap: UsageSnapshot, provider?: 'claude' | 'codex'): CtlUsageResult {
  const rows: CtlUsageRow[] = []
  for (const r of snap.rows ?? []) {
    if (r.provider !== 'claude' && r.provider !== 'codex') continue
    if (r.kind !== '5h' && r.kind !== '7d') continue
    if (provider && r.provider !== provider) continue
    rows.push({
      id: String(r.id),
      provider: r.provider,
      kind: r.kind,
      label: String(r.label),
      percent: typeof r.percent === 'number' && Number.isFinite(r.percent) ? r.percent : null,
      resetsAt: typeof r.resetsAt === 'string' ? r.resetsAt : null,
      ...(typeof r.planType === 'string' && r.planType ? { planType: r.planType } : {}),
      status: r.status,
      ...(r.stale ? { stale: true as const } : {}),
    })
  }
  const a = snap.activeAccount
  return {
    rows,
    updatedAt: typeof snap.updatedAt === 'number' ? snap.updatedAt : 0,
    services: snap.services ?? null,
    ...(a && provider !== 'codex'
      ? { account: { id: a.id, ...(typeof a.rank === 'number' ? { rank: a.rank + 1 } : {}), slot: a.role, label: a.label.includes('@') ? '' : a.label } }
      : {}),
  }
}

/** One last switch as a comparable key ('' when there is none). */
function switchKey(ls: CtlAccountStatus['lastSwitch']): string {
  return ls ? `${ls.at}|${ls.from ?? ''}|${ls.to}|${ls.reason}` : ''
}

/** AccountService errors as CLI errors (exit 3, 7 or 1). */
function switchErr(e: AccountsOpError | undefined): Fail {
  switch (e) {
    case 'not_found':
      return err('not_found', 'that account is no longer saved')
    case 'locked':
      return err('disabled', 'the saved login of that account cannot be used: capture it again on the desktop (Settings > Claude accounts)')
    case 'busy':
      return err('busy', 'another account change is running, try again in a moment')
    case 'identity_failed':
      return err('busy', 'the live Claude login changed and is not identified yet: try again after a Claude console used it')
    case 'unknown_live_account':
      return err('disabled', 'the live Claude login is not a saved account: save or replace it on the desktop first (Settings > Claude accounts)')
    case 'unsupported':
    case 'encryption_unavailable':
      return err('disabled', 'saved Claude logins are not supported on this machine')
    case 'bad_request':
      return err('bad_request', 'invalid account')
    default:
      return err('internal', 'the account switch failed')
  }
}
