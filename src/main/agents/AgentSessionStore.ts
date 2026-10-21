/**
 * Durable agent session registry (E5-FR-05..07, D5): which Claude/Codex
 * session each console was running, so a quit, an update, a Windows restart
 * or a crash can bring every console back to its conversation.
 *
 * Main-owned file dataDir()/agent-sessions.json (version 1), same pattern as
 * remote-devices.json: atomic tmp + rename, at most one write per second, a
 * synchronous flush at exit. `pane.lastSession` in config.json is only a
 * mirror the renderer writes; it seeds this store when the file is missing or
 * corrupt. Prompts are never logged; on disk there is only the first line of
 * the last prompt (<= 120), the first prompt (<= 60) and the topic.
 *
 * Fed by the StatusManager listener (state + the agent event behind it) and
 * by PtyManager (the cwd node-pty got). After the exit snapshot the store is
 * frozen: the SessionEnd / disconnect noise of killing every pty never marks
 * a chat as ended.
 *
 * Timers, clock and the config/pty lookups are injected so the whole policy
 * runs under fakes in scripts/test-agents-resume.cjs.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { isSafeSessionId } from '@shared/agent-argv'
import { ENDING_REASONS, type AgentSessionView, type AgentsChangedEvt, type AgentsReadyEvt, type AgentsStartup, type ExitTrigger } from '@shared/agents'
import type { AgentProvider, ConfigFile, PaneStatusEvt } from '@shared/types'
import type { AgentEvent } from '../status/events'
import { firstLine } from '../status/statusDetails'
import { claudeAvailability, claudeProjectsDir, codexAvailability, type CodexRolloutIndex } from './transcripts'

/** Records older than this are dropped at startup. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Hard cap on records (keeps the file well under 256 KB). */
export const MAX_SESSIONS = 500
/** Debounce of the background write. */
export const SAVE_DEBOUNCE_MS = 1000
const LAST_PROMPT_MAX = 120

type Availability = Pick<AgentSessionView, 'available' | 'unavailableReason'>

/** One pane's record as stored on disk (the view minus computed fields, plus the transcript). */
export type AgentRecord = Omit<AgentSessionView, 'paneId' | 'available' | 'unavailableReason'> & {
  transcriptPath?: string
  /** v2.4 `/rename`: the session's last name main saw (main only, never in the view). */
  agentTitle?: string
}

/** v2.4: a session name heard before its record existed (the record is made on the next status). */
interface StashedTitle {
  provider: AgentProvider
  sessionId: string
  title: string
}

const stateSchema = z.enum(['idle', 'working', 'done', 'action', 'error', 'unknown'])
const reasonSchema = z.enum(['permission', 'question', 'plan', 'elicitation', 'failure'])
const triggerSchema = z.enum(['quit', 'update', 'shutdown', 'crash'])
const recordSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  sessionId: z.string().refine(isSafeSessionId),
  spawnCwd: z.string().max(4096),
  cwd: z.string().max(4096).optional(),
  topic: z.string().max(200).optional(),
  firstPrompt: z.string().max(200).optional(),
  lastPrompt: z.string().max(400).optional(),
  activity: stateSchema.catch('unknown'),
  reason: reasonSchema.optional().catch(undefined),
  updatedAt: z.number(),
  endedAt: z.number().optional(),
  hibernatedAt: z.number().optional(),
  interrupted: z
    .object({ activity: z.enum(['working', 'action']), reason: reasonSchema.optional(), trigger: triggerSchema, at: z.number() })
    .optional()
    .catch(undefined),
  transcriptPath: z.string().max(4096).optional(),
  // v2.4: optional, file version unchanged (an older build drops it on its next write).
  agentTitle: z.string().max(60).optional().catch(undefined),
})
const fileSchema = z.object({
  version: z.literal(1),
  cleanExit: z.boolean(),
  lastExit: z.object({ trigger: triggerSchema, at: z.number() }).optional().catch(undefined),
  sessions: z.record(z.unknown()),
})

export interface AgentSessionStoreDeps {
  /** dataDir()/agent-sessions.json */
  file: string
  /** Persisted config (pane existence, Connection Profiles, lastSession seed). */
  getConfig: () => ConfigFile | null
  /** cwd PtyManager handed node-pty for the pane's live pty. */
  spawnCwd: (paneId: string) => string | undefined
  codexIndex?: Pick<CodexRolloutIndex, 'has' | 'refresh'>
  projectsDir?: () => string
  onChanged?: (evt: AgentsChangedEvt) => void
  onReady?: (evt: AgentsReadyEvt) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

function viewSignature(v: AgentSessionView): string {
  return JSON.stringify([v.available, v.unavailableReason, v.provider, v.sessionId, v.endedAt, v.interrupted, v.hibernatedAt, v.topic, v.firstPrompt])
}

export class AgentSessionStore {
  private readonly records = new Map<string, AgentRecord>()
  /** In-memory availability cache (transcript / cwd checks touch the disk). */
  private readonly avail = new Map<string, Availability>()
  /** Last view signature sent per pane (agents:changed only on visible changes). */
  private readonly sent = new Map<string, string>()
  /** Panes whose session (re)started during this run. */
  private readonly started = new Set<string>()
  /** Panes waiting for their first idle after a start (agents:ready 'idle'). */
  private readonly idleArmed = new Set<string>()
  private readonly consumed = new Set<string>()
  /** paneId -> session just forgotten: its late events must not bring it back before a start. */
  private readonly forgotten = new Map<string, string>()
  /** v2.4: paneId -> a session name heard before that session's record existed. */
  private readonly stashedTitles = new Map<string, StashedTitle>()
  private startupInfo: AgentsStartup = { trigger: null, interrupted: [] }
  private cleanExit = false
  private lastExit: { trigger: ExitTrigger; at: number } | undefined
  private loaded = false
  private frozen = false
  private timer: unknown = null
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: AgentSessionStoreDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /**
   * Reads the file once, derives how the previous run ended, prunes and
   * marks this run as not cleanly exited yet (written at once, so a crash
   * from here on is detected at the next start).
   */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    const now = this.now()
    const cfg = this.deps.getConfig()
    let parsed: z.infer<typeof fileSchema> | null = null
    try {
      parsed = fileSchema.parse(JSON.parse(readFileSync(this.deps.file, 'utf8')))
    } catch {
      parsed = null
    }
    if (parsed) {
      for (const [paneId, raw] of Object.entries(parsed.sessions)) {
        const rec = recordSchema.safeParse(raw)
        if (rec.success) this.records.set(paneId, rec.data as AgentRecord)
      }
      let trigger: ExitTrigger | null = parsed.lastExit?.trigger ?? null
      if (!parsed.cleanExit) {
        // No exit snapshot ran: the last persisted activity is all we have.
        trigger = 'crash'
        for (const rec of this.records.values()) {
          if (rec.activity === 'working' || rec.activity === 'action') {
            rec.interrupted = { activity: rec.activity, reason: rec.reason, trigger: 'crash', at: rec.updatedAt }
          }
        }
      }
      this.startupInfo = { trigger, interrupted: [] }
    } else {
      this.seedFromConfig(cfg)
    }
    this.prune(cfg, now)
    for (const rec of this.records.values()) rec.activity = 'unknown' // nothing runs yet
    this.startupInfo.interrupted = [...this.records].filter(([, r]) => r.interrupted && !r.endedAt).map(([id]) => id)
    this.deps.codexIndex?.refresh()
    this.cleanExit = false
    this.lastExit = parsed?.lastExit
    this.writeNow()
  }

  /** Missing or corrupt file: rebuild from pane.lastSession (no interrupted info). */
  private seedFromConfig(cfg: ConfigFile | null): void {
    for (const ws of cfg?.workspaces ?? []) {
      if (!Array.isArray(ws.panes)) continue
      for (const pane of ws.panes) {
        const ls = pane.lastSession
        if (!ls || !isSafeSessionId(ls.sessionId) || (ls.provider !== 'claude' && ls.provider !== 'codex')) continue
        if (pane.setupId ?? ws.setupId) continue
        this.records.set(pane.id, { provider: ls.provider, sessionId: ls.sessionId, spawnCwd: ls.cwd ?? '', activity: 'unknown', updatedAt: ls.at || this.now() })
      }
    }
  }

  /** Startup pruning: panes that no longer exist, records older than 30 days, the 500 cap. */
  private prune(cfg: ConfigFile | null, now: number): void {
    const panes = cfg && Array.isArray(cfg.workspaces) ? new Set(cfg.workspaces.flatMap((w) => (Array.isArray(w.panes) ? w.panes.map((p) => p.id) : []))) : null
    for (const [paneId, rec] of this.records) {
      if ((panes && !panes.has(paneId)) || now - rec.updatedAt > SESSION_TTL_MS) this.records.delete(paneId)
    }
    this.capSize()
  }

  private capSize(): void {
    if (this.records.size <= MAX_SESSIONS) return
    const oldest = [...this.records].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [paneId] of oldest.slice(0, this.records.size - MAX_SESSIONS)) this.records.delete(paneId)
  }

  /** pane.setupId ?? workspace.setupId, read only when a record is created or replaced (rare). */
  private isSshPane(paneId: string): boolean {
    for (const ws of this.deps.getConfig()?.workspaces ?? []) {
      const pane = ws.panes?.find((p) => p.id === paneId)
      if (pane) return !!(pane.setupId ?? ws.setupId)
    }
    return false
  }

  /** StatusManager listener: every emission with the agent event behind it (when any). */
  onStatus(evt: PaneStatusEvt, cause?: AgentEvent): void {
    if (!this.loaded || this.frozen || evt.state === null) return
    const paneId = evt.paneId
    const provider: AgentProvider | undefined = cause?.provider ?? evt.provider
    const sessionId = cause?.sessionId ?? evt.sessionId
    // Never a Codex `launch:` placeholder, an empty title-only id or shell syntax.
    if (!provider || !isSafeSessionId(sessionId)) return
    const now = this.now()
    const isStart = cause?.kind === 'start'
    if (this.forgotten.get(paneId) === sessionId && !isStart) return
    this.forgotten.delete(paneId)
    let rec = this.records.get(paneId)
    // A pane leaving a session may release another pane it had claimed.
    const previousSession = rec && rec.sessionId !== sessionId ? rec.sessionId : undefined
    let recheck = false
    if (!rec || rec.sessionId !== sessionId || rec.provider !== provider) {
      if (this.isSshPane(paneId)) return
      rec = { provider, sessionId, spawnCwd: this.deps.spawnCwd(paneId) ?? cause?.cwd ?? '', activity: evt.state, updatedAt: now }
      const stashed = this.stashedTitles.get(paneId)
      if (stashed && stashed.provider === provider && stashed.sessionId === sessionId) rec.agentTitle = stashed.title
      this.stashedTitles.delete(paneId)
      this.records.set(paneId, rec)
      this.started.add(paneId)
      recheck = true
    }
    if (isStart) {
      rec.endedAt = undefined
      rec.interrupted = undefined
      rec.hibernatedAt = undefined
      rec.spawnCwd = this.deps.spawnCwd(paneId) ?? rec.spawnCwd
      this.started.add(paneId)
      this.idleArmed.add(paneId)
      if (provider === 'codex') this.deps.codexIndex?.refresh()
      recheck = true
    }
    if (cause?.cwd) rec.cwd = cause.cwd
    if (cause?.transcriptPath && cause.transcriptPath !== rec.transcriptPath) {
      rec.transcriptPath = cause.transcriptPath
      recheck = true
    }
    if (evt.topic) rec.topic = evt.topic
    if (evt.firstPrompt) rec.firstPrompt = evt.firstPrompt
    if (cause?.prompt) rec.lastPrompt = firstLine(cause.prompt, LAST_PROMPT_MAX) || rec.lastPrompt
    rec.activity = evt.state
    rec.reason = evt.reason
    rec.updatedAt = now
    if (cause?.kind === 'end' && !rec.hibernatedAt) {
      // Claude: only a real exit (`/exit`, Ctrl+D, logout); `clear` waits for the
      // next SessionStart and `other` (ConPTY closing) is ignored. Codex: the
      // launcher reported a clean exit of the CLI.
      if (provider === 'codex' || ENDING_REASONS.has(cause.endReason ?? '')) {
        rec.endedAt = now
        recheck = true
      }
    }
    if (recheck || this.avail.get(paneId)?.available !== true) this.avail.delete(paneId)
    if (isStart) this.deps.onReady?.({ paneId, sessionId, phase: 'start' })
    if (this.idleArmed.has(paneId) && (evt.state === 'idle' || evt.state === 'done')) {
      this.idleArmed.delete(paneId)
      this.deps.onReady?.({ paneId, sessionId, phase: 'idle' })
    }
    this.scheduleSave()
    this.emitIfChanged(paneId, previousSession)
  }

  /**
   * v2.4 `/rename` (StatusManager.onAgentRename): the session's last name,
   * recorded whether or not agents.syncAgentRename is on, so turning it on
   * later never re-applies an old name. A name heard before the session's
   * record exists waits in memory for it.
   */
  noteAgentTitle(paneId: string, provider: AgentProvider, sessionId: string, title: string): void {
    if (!this.loaded || this.frozen || !isSafeSessionId(sessionId) || typeof title !== 'string') return
    const clean = title.slice(0, 60)
    if (!clean) return
    const rec = this.records.get(paneId)
    if (rec && rec.provider === provider && rec.sessionId === sessionId) {
      if (rec.agentTitle === clean) return
      rec.agentTitle = clean
      this.scheduleSave()
      return
    }
    this.stashedTitles.set(paneId, { provider, sessionId, title: clean })
  }

  /** v2.4: the name a pane's session already had (StatusManager's seed), or undefined. */
  agentTitleFor(paneId: string, provider: AgentProvider, sessionId: string): string | undefined {
    const rec = this.records.get(paneId)
    if (rec && rec.provider === provider && rec.sessionId === sessionId) return rec.agentTitle
    const stashed = this.stashedTitles.get(paneId)
    return stashed && stashed.provider === provider && stashed.sessionId === sessionId ? stashed.title : undefined
  }

  /** "Start fresh" / "Restart with a new chat": the pane forgets its session. */
  forget(paneId: string): void {
    const rec = this.records.get(paneId)
    if (this.frozen || !rec) return
    this.records.delete(paneId)
    this.forgotten.set(paneId, rec.sessionId)
    this.avail.delete(paneId)
    this.sent.delete(paneId)
    this.idleArmed.delete(paneId)
    this.scheduleSave()
    this.deps.onChanged?.({ paneId, removed: true })
    this.emitSiblings(paneId, [rec.sessionId])
  }

  /** Marks the record so the end that follows a hibernation kill is ignored (E5-FR-25). */
  markHibernated(paneId: string): void {
    const rec = this.records.get(paneId)
    if (!rec || this.frozen) return
    rec.hibernatedAt = this.now()
    this.scheduleSave()
    this.emitIfChanged(paneId)
  }

  /** The pane's chat can be resumed right now (available === true): hibernation's last rule (E5-FR-25). */
  isAvailable(paneId: string): boolean {
    return !this.frozen && this.view(paneId)?.available === true
  }

  /** Every record as the renderer sees it (availability re-checked). */
  list(): AgentSessionView[] {
    this.avail.clear()
    this.deps.codexIndex?.refresh()
    return [...this.records.keys()].map((id) => {
      const v = this.view(id)!
      this.sent.set(id, viewSignature(v))
      return v
    })
  }

  startup(): AgentsStartup {
    return { trigger: this.startupInfo.trigger, interrupted: [...this.startupInfo.interrupted] }
  }

  /** True only the first time per run for each pane (survives renderer reloads). */
  consumeStartup(paneId: string): boolean {
    if (typeof paneId !== 'string' || !paneId || this.consumed.has(paneId)) return false
    this.consumed.add(paneId)
    return true
  }

  /**
   * Which of `paneIds` still have their startup decision unspent, without
   * spending it (E5-FR-12): the resume dialog lists only those, so a renderer
   * reload after the decision does not ask again.
   */
  startupPending(paneIds: readonly string[]): string[] {
    return paneIds.filter((id) => typeof id === 'string' && !!id && !this.consumed.has(id))
  }

  get isFrozen(): boolean {
    return this.frozen
  }

  /**
   * Exit snapshot (E5-FR-06). Runs before the ptys are killed, once: every
   * record mid-turn or waiting on the user is marked interrupted with the
   * trigger, the file is flushed synchronously and the store freezes.
   */
  snapshotExitOnce(trigger: ExitTrigger): void {
    if (!this.loaded || this.frozen) return
    this.frozen = true
    const at = this.now()
    for (const [paneId, rec] of this.records) {
      if (rec.activity === 'working' || rec.activity === 'action') {
        rec.interrupted = { activity: rec.activity, reason: rec.reason, trigger, at }
      } else if (this.started.has(paneId)) {
        rec.interrupted = undefined
      }
    }
    this.cleanExit = true
    this.lastExit = { trigger, at }
    this.writeNow()
  }

  /** macOS keeps running with no window: a new window resumes recording. */
  thaw(): void {
    if (!this.frozen) return
    this.frozen = false
    this.cleanExit = false
    this.writeNow()
  }

  /** Writes any pending change now (exit paths). */
  flush(): void {
    if (this.timer !== null) this.writeNow()
  }

  dispose(): void {
    this.flush()
  }

  private availabilityOf(paneId: string, rec: AgentRecord): Availability {
    let a = this.avail.get(paneId)
    if (!a) {
      if (rec.provider === 'claude') {
        const c = claudeAvailability(rec, this.deps.projectsDir?.() ?? claudeProjectsDir())
        a = c.available ? { available: true } : { available: false, unavailableReason: c.reason }
      } else {
        const c = codexAvailability(rec, this.deps.codexIndex)
        a = c.reason ? { available: false, unavailableReason: c.reason } : { available: c.available }
      }
      this.avail.set(paneId, a)
    }
    // Two panes on the same session: only the most recent one may resume it.
    for (const [other, r] of this.records) {
      if (other !== paneId && r.provider === rec.provider && r.sessionId === rec.sessionId && r.updatedAt > rec.updatedAt) {
        return { available: false, unavailableReason: 'claimed' }
      }
    }
    return a
  }

  private view(paneId: string): AgentSessionView | null {
    const rec = this.records.get(paneId)
    if (!rec) return null
    const { transcriptPath: _hidden, agentTitle: _title, ...rest } = rec
    const v: AgentSessionView = { paneId, ...rest, ...this.availabilityOf(paneId, rec) }
    for (const key of Object.keys(v) as Array<keyof AgentSessionView>) if (v[key] === undefined) delete v[key]
    return v
  }

  /** `previousSession`: the session the pane just left (its other holder may be released). */
  private emitIfChanged(paneId: string, previousSession?: string): void {
    if (previousSession) this.emitSiblings(paneId, [previousSession])
    const v = this.view(paneId)
    if (!v) return
    const sig = viewSignature(v)
    if (this.sent.get(paneId) === sig) return
    this.sent.set(paneId, sig)
    this.deps.onChanged?.(v)
    // A newer record can claim (or release) another pane's session.
    this.emitSiblings(paneId, [v.sessionId])
  }

  /** Re-sends the views of the other panes on `sessionIds` whose claimed state moved. */
  private emitSiblings(paneId: string, sessionIds: string[]): void {
    for (const [other, r] of this.records) {
      if (other === paneId || !sessionIds.includes(r.sessionId)) continue
      const ov = this.view(other)!
      const osig = viewSignature(ov)
      if (this.sent.get(other) !== osig) {
        this.sent.set(other, osig)
        this.deps.onChanged?.(ov)
      }
    }
  }

  private scheduleSave(): void {
    if (this.timer !== null) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private writeNow(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.capSize()
    const sessions: Record<string, AgentRecord> = {}
    for (const [paneId, rec] of this.records) sessions[paneId] = rec
    const body = JSON.stringify({ version: 1, cleanExit: this.cleanExit, ...(this.lastExit ? { lastExit: this.lastExit } : {}), sessions })
    const tmp = `${this.deps.file}.tmp`
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, this.deps.file)
    } catch {
      console.warn('[agents] could not write the agent session registry')
    }
  }
}
