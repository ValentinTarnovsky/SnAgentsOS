import { Notification, type BrowserWindow } from 'electron'
import { isAbsolute } from 'path'
import { CH } from '@shared/ipc-channels'
import { BRAND } from '@shared/brand'
import { AGENT_END_REASONS, type AgentDetail, type AgentProvider, type AgentSessionEndEvt, type AttentionReason, type ClaudePaneState, type ConfigFile, type NotificationSettings, type PaneStatusEvt, type RemotePending } from '@shared/types'
import type { PtyExitInfo, PtySink } from '../pty/PtyManager'
import { mainT } from '../i18n'
import { revealWindow } from '../window/revealWindow'
import type { HookEvent } from './HookServer'
import type { AgentEvent, StatusNotice } from './events'
import { LIMITS, clip, firstLine, readLastAssistantMessage, sanitize } from './statusDetails'

interface PendingEntry {
  reason: AttentionReason
  toolName?: string
  summary: string
  questions?: RemotePending['questions']
  /**
   * E2-FR-48: when the request was registered, and whether user input reached
   * the pty after it. They live on the entry (not in side maps on the track),
   * so every delete and clear of `pending` drops them with the request.
   */
  requestAt: number
  invalidated?: boolean
}

interface PaneTrack {
  provider: AgentProvider
  sessionId: string
  retired: Set<string>
  precise: boolean
  activity: ClaudePaneState
  pending: Map<string, PendingEntry>
  seen: Set<string>
  turnId: string
  turn: number
  timer: NodeJS.Timeout | null
  updatedAt: number
  ended: boolean
  // Enrichment (E4-FR-09, E5-FR-02).
  /** Effective state last published and when it started. */
  lastState: ClaudePaneState
  stateSince: number
  cacheSince?: number
  /** Last assistant reply (<= 2000) and the turn it belongs to. */
  reply?: string
  replyTurn?: string
  /** Current tool summary (public `activity`). */
  tool?: string
  detail?: AgentDetail
  topic?: string
  firstPrompt?: string
  cwd?: string
  transcriptPath?: string
  /** Throttle of detail-only emissions (500 ms per pane). */
  emitted?: string
  emittedAt: number
  detailTimer: NodeJS.Timeout | null
  deferredCause?: AgentEvent
}

/** Called on every emission, `state: null` included (E1-FR-01). `cause` is the agent event behind it, when any. */
export type StatusListener = (evt: PaneStatusEvt, cause?: AgentEvent) => void

/**
 * The agent session behind a console as the Chat view needs it (E3 M12):
 * `sessionId` is '' for an approximate (title-only) track or a Codex
 * `launch:` placeholder; `transcriptPath` only from a main-session hook,
 * already checked by isSafeTranscriptPath. Main only.
 */
export interface PaneTranscriptInfo {
  provider: AgentProvider
  sessionId: string
  transcriptPath?: string
  cwd?: string
}

/** Same charset as schema 11 `lastSession.sessionId`: rejects `launch:` ids and shell syntax. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/
const DETAIL_THROTTLE_MS = 500
// 'resolved' is not here: every tool call ends in a PostToolUse, so forcing it
// would defeat the throttle. A resolution that clears a pending request still
// goes out at once through the state / pending signature.
const IMMEDIATE_KINDS = new Set<AgentEvent['kind']>(['start', 'end', 'request', 'done', 'error', 'unknown'])
const GENERIC_TOPICS = /^(claude|claude code)$/i
/**
 * Input that is only terminal reports, never an answer (E2-FR-48): focus in /
 * out, SGR and X10 mouse, plus the replies a terminal sends on its own to the
 * app's queries (cursor position, device attributes, status, mode reports,
 * kitty keyboard flags, OSC color answers, DECRQSS), which a phone xterm emits while it
 * parses a replay.
 */
// eslint-disable-next-line no-control-regex
const REPORTS_ONLY_RE = /^(?:\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\??\d+;\d+(?:;\d+)?R|\x1b\[[?>=][\d;]*c|\x1b\[\??\d+n|\x1b\[\??[\d;]+\$y|\x1b\[\?\d+u|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[01]\$r[^\x1b]*\x1b\\)+$/

/** Topic after the spinner / stopped glyph of Claude's OSC title, or undefined for generic titles. */
function titleTopic(title: string): string | undefined {
  const cp = title.codePointAt(0) ?? 0
  if (!((cp >= 0x2800 && cp <= 0x28ff) || cp === 0x2733)) return undefined
  const topic = clip(sanitize(title.slice(cp > 0xffff ? 2 : 1), true), LIMITS.title)
  return topic && !GENERIC_TOPICS.test(topic) ? topic : undefined
}

/** Requests survive title changes, renderer reloads and concurrent background work. */
export class StatusManager implements PtySink {
  readonly id = 'status'
  private readonly panes = new Map<string, PaneTrack>()
  private readonly ptys = new Map<string, string>()
  private viewed = new Set<string>()
  private cfg: NotificationSettings | null = null
  private promptSequence = 0
  private readonly listeners = new Set<StatusListener>()
  private readonly sshPanes = new Map<string, boolean>()
  private readonly sshMisses = new Map<string, number>()
  /** E3 M12: when each pane's live pty spawned (the no-hooks transcript match). */
  private readonly spawnTimes = new Map<string, number>()
  /** E3 M12: provider|session|transcript each pane last reported, and who listens. */
  private readonly transcriptKeys = new Map<string, string>()
  private readonly transcriptListeners = new Set<(paneId: string) => void>()
  lastClaudeEventAt: number | null = null
  desktopError: 'blocked' | 'failed' | 'unavailable' | null = null
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getConfig: () => ConfigFile | null,
    private readonly onNotice: (notice: StatusNotice) => void = () => {},
    private readonly readTranscript: (path: string, sessionId: string) => Promise<string | undefined> = (path, sessionId) => readLastAssistantMessage(path, sessionId),
  ) {}
  onSpawn(ptyId: string, paneId: string): void { this.clearPane(paneId); this.sshPanes.delete(paneId); this.sshMisses.delete(paneId); this.ptys.set(paneId, ptyId); this.spawnTimes.set(paneId, Date.now()) }
  onData(): void {}
  /** Every exit (natural or not) releases the pane's tracking. */
  onExit(ptyId: string, paneId: string, _exitCode?: number, _info?: PtyExitInfo): void {
    if (this.ptys.get(paneId) !== ptyId) return
    this.ptys.delete(paneId)
    this.spawnTimes.delete(paneId)
    this.clearPane(paneId)
  }
  setConfig(cfg: NotificationSettings): void { this.cfg = cfg }
  setViewed(paneIds: string[]): void { this.viewed = new Set(paneIds) }
  snapshot(): PaneStatusEvt[] { return [...this.panes].map(([id, track]) => this.event(id, track, false)) }
  /** Current status of one console, or null when it has none. */
  stateOf(paneId: string): PaneStatusEvt | null {
    const track = this.panes.get(paneId)
    return track ? this.event(paneId, track, false) : null
  }
  /** Observer seam (E1-FR-01) for the remote overlay, the session store and the awake service. */
  addListener(cb: StatusListener): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
  // --- E3 M12 Chat view seams ------------------------------------------------

  /** The session and transcript a console's agent reported, or null without a track. */
  transcriptFor(paneId: string): PaneTranscriptInfo | null {
    const track = this.panes.get(paneId)
    if (!track) return null
    const out: PaneTranscriptInfo = { provider: track.provider, sessionId: track.precise && SESSION_ID_RE.test(track.sessionId) ? track.sessionId : '' }
    if (track.transcriptPath) out.transcriptPath = track.transcriptPath
    if (track.cwd) out.cwd = track.cwd
    return out
  }

  /** The console whose live track holds this session id, or null. */
  paneForSession(sessionId: string): string | null {
    if (!sessionId) return null
    for (const [paneId, track] of this.panes) if (track.precise && track.sessionId === sessionId) return paneId
    return null
  }

  /** When the pane's live pty spawned (epoch ms), or undefined. */
  spawnedAt(paneId: string): number | undefined {
    return this.spawnTimes.get(paneId)
  }

  /**
   * Called with a pane id whenever its provider, session or transcript path
   * changes, including when its track goes away (/clear, a resume, an exit).
   */
  onTranscriptChange(cb: (paneId: string) => void): () => void {
    this.transcriptListeners.add(cb)
    return () => { this.transcriptListeners.delete(cb) }
  }

  private noteTranscript(paneId: string): void {
    const t = this.transcriptFor(paneId)
    const key = t ? `${t.provider}|${t.sessionId}|${t.transcriptPath ?? ''}` : ''
    if ((this.transcriptKeys.get(paneId) ?? '') === key) return
    if (key) this.transcriptKeys.set(paneId, key)
    else this.transcriptKeys.delete(paneId)
    for (const cb of this.transcriptListeners) {
      try { cb(paneId) } catch { console.warn('[status] a transcript listener failed') }
    }
  }

  testDesktop(): void { this.showNative(mainT(this.getConfig(), 'status.notif.test')) }
  /**
   * `snaos notify` (E8-FR-19): a native notification with the caller's title
   * and text, only with notifications.enabled; a click reveals the console.
   * Discord and ntfy go through the notice router, not through here.
   */
  notifyCustom(paneId: string | null, title: string, body: string): boolean {
    if (!this.cfg?.enabled) return false
    this.showNative(body, paneId ?? undefined, title)
    return true
  }

  reportTitle(paneId: string, title: string): void {
    if (!this.ptys.has(paneId)) return
    const current = this.panes.get(paneId)
    const t = title.trim(), cp = t.codePointAt(0) ?? 0
    // The topic is captured before the precise early return (E5-FR-02); a
    // generic title never overwrites a valid one.
    const topic = titleTopic(t)
    if (current?.precise) {
      if (topic && topic !== current.topic) { current.topic = topic; this.publish(paneId, current) }
      return
    }
    const working = cp >= 0x2800 && cp <= 0x28ff, stopped = cp === 0x2733
    const present = /^(claude|Claude Code|claude daemon)$/.test(t) || t.startsWith('claude · ')
    if (!working && !stopped && !present) {
      if (current && !current.timer) current.timer = setTimeout(() => this.clearPane(paneId), 3000)
      return
    }
    const track = current ?? this.createTrack('claude', '')
    this.panes.set(paneId, track)
    this.cancelTimer(track)
    if (topic) track.topic = topic
    if (working) {
      if (track.activity !== 'working') track.turn++
      track.activity = 'working'
      track.pending.clear()
    } else if (stopped && track.activity === 'working') {
      track.activity = 'idle'
      track.pending.set('title', { reason: 'question', summary: '', requestAt: Date.now() })
      this.publish(paneId, track, `title:${track.turn}`, 'action')
      return
    }
    this.publish(paneId, track)
  }

  onHookEvent(evt: HookEvent): void {
    if (!evt.ptyId || !evt.sessionId || this.ptys.get(evt.consoleId) !== evt.ptyId) return
    if (evt.agentId && !['PermissionRequest', 'Elicitation', 'ElicitationResult', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification'].includes(evt.name)) return
    if (evt.agentId && evt.name === 'PreToolUse' && !['AskUserQuestion', 'ExitPlanMode'].includes(evt.toolName ?? '')) return
    const base = {
      paneId: evt.consoleId, ptyId: evt.ptyId, provider: 'claude' as const,
      sessionId: evt.agentId ? this.panes.get(evt.consoleId)?.sessionId ?? evt.sessionId : evt.sessionId,
      cwd: evt.cwd, transcriptPath: evt.agentId ? undefined : evt.transcriptPath, subagent: evt.agentId ? true : undefined,
    }
    const requestId = evt.toolUseId ?? evt.elicitationId
    const tool = { toolName: evt.toolName, tool: evt.toolSummary, summary: evt.requestSummary ?? evt.toolSummary }
    let event: AgentEvent | undefined
    switch (evt.name) {
      case 'SessionStart': event = { ...base, kind: 'start' }; break
      case 'SessionEnd': event = { ...base, kind: 'end', endReason: evt.endReason }; break
      case 'UserPromptSubmit':
        event = { ...base, kind: 'working', turnId: `prompt:${++this.promptSequence}`, prompt: evt.prompt, detail: evt.prompt ? { kind: 'prompt', text: firstLine(evt.prompt, LIMITS.detail) } : undefined }
        break
      case 'Stop':
        event = { ...base, kind: 'done', reply: evt.lastAssistantMessage, detail: { kind: 'reply', text: firstLine(evt.lastAssistantMessage, LIMITS.detail) } }
        break
      case 'StopFailure': event = { ...base, kind: 'error', reason: 'failure' }; break
      case 'PermissionRequest':
        event = { ...base, ...tool, kind: 'request', requestId, reason: 'permission', detail: { kind: 'permission', text: evt.toolSummary ?? '' } }
        break
      case 'Elicitation': event = { ...base, kind: 'request', requestId, reason: 'elicitation' }; break
      case 'ElicitationResult': event = { ...base, kind: 'resolved', requestId, reason: 'elicitation' }; break
      case 'PreToolUse':
        if (evt.toolName === 'ExitPlanMode') event = { ...base, toolName: evt.toolName, summary: evt.requestSummary, kind: 'request', requestId, reason: 'plan', detail: { kind: 'plan', text: '' } }
        else if (evt.toolName === 'AskUserQuestion') event = { ...base, toolName: evt.toolName, summary: evt.question ?? '', questions: evt.questions, kind: 'request', requestId, reason: 'question', detail: { kind: 'question', text: evt.question ?? '' } }
        else event = { ...base, ...tool, kind: 'working', detail: evt.toolSummary ? { kind: 'tool', text: evt.toolSummary } : undefined }
        break
      case 'PostToolUse':
      case 'PostToolUseFailure': event = { ...base, kind: 'resolved', requestId }; break
      case 'Notification': {
        const reason = evt.notificationType === 'permission_prompt' ? 'permission' : evt.notificationType === 'elicitation_dialog' ? 'elicitation' : undefined
        if (reason && ![...(this.panes.get(evt.consoleId)?.pending.values() ?? [])].some(p => p.reason === reason)) event = { ...base, kind: 'request', reason }
        break
      }
    }
    if (event) { this.lastClaudeEventAt = Date.now(); this.onAgentEvent(event) }
    if (evt.name === 'SessionEnd') this.emitSessionEnd(evt)
  }

  /**
   * E6-FR-21: Claude's main session of the live pty ended with a reason that
   * offers "resume / new" (`/exit`, Ctrl+D). The live-pty and subagent guards
   * already ran in onHookEvent; `clear`, `logout` and unknown reasons stay silent.
   */
  private emitSessionEnd(evt: HookEvent): void {
    const reason = AGENT_END_REASONS.find((r) => r === evt.endReason)
    if (!reason || evt.agentId || !evt.ptyId || !evt.sessionId || !SESSION_ID_RE.test(evt.sessionId)) return
    const end: AgentSessionEndEvt = { paneId: evt.consoleId, ptyId: evt.ptyId, provider: 'claude', sessionId: evt.sessionId, reason, at: Date.now() }
    if (evt.cwd) end.cwd = evt.cwd
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(CH.STATUS_SESSION_END, end)
  }

  onAgentEvent(evt: AgentEvent): void {
    if (this.ptys.get(evt.paneId) !== evt.ptyId) return
    let track = this.panes.get(evt.paneId)
    if (track?.retired.has(`${evt.provider}:${evt.sessionId}`)) {
      if (evt.kind === 'start' && (evt.provider === 'codex' || (track.ended && track.sessionId === evt.sessionId))) track.retired.delete(`${evt.provider}:${evt.sessionId}`)
      else return
    }
    if (track?.precise && (track.sessionId !== evt.sessionId || track.provider !== evt.provider)) {
      if (evt.kind !== 'start') return
      const retired = track.retired
      retired.add(`${track.provider}:${track.sessionId}`)
      if (retired.size > 64) retired.delete(retired.values().next().value!)
      this.cancelTimer(track)
      this.cancelDetail(track)
      track = this.createTrack(evt.provider, evt.sessionId)
      track.retired = retired
    }
    if (!track) track = this.createTrack(evt.provider, evt.sessionId)
    if (!track.precise) { this.cancelTimer(track); track.pending.clear(); track.sessionId = evt.sessionId; track.provider = evt.provider }
    track.precise = true
    this.panes.set(evt.paneId, track)
    this.cancelTimer(track)
    if (evt.turnId) track.turnId = evt.turnId
    if (evt.kind === 'start') {
      // A new session starts clean (E5-FR-02: firstPrompt resets on start).
      track.firstPrompt = undefined; track.detail = undefined; track.tool = undefined; track.reply = undefined; track.replyTurn = undefined
    }
    this.enrich(track, evt)
    let notice: StatusNotice['state'] | undefined, key: string | undefined
    switch (evt.kind) {
      case 'start':
        track.ended = false; track.activity = 'idle'; track.pending.clear(); track.seen.clear()
        track.turnId = evt.turnId ?? ''
        break
      case 'working': track.activity = 'working'; break
      case 'idle': track.activity = 'idle'; break
      case 'request': {
        const id = evt.requestId ?? `fallback:${evt.reason ?? 'question'}`
        key = evt.requestId ? `request:${id}` : `request:${track.turnId}:${id}`
        if (evt.requestId && track.seen.has(key)) return
        const fallbackId = `fallback:${evt.reason ?? 'question'}`
        const fallback = evt.requestId ? track.pending.get(fallbackId) : undefined
        const promoted = !!evt.requestId && track.pending.delete(fallbackId)
        // E2-FR-48: the promoted request is the prompt the fallback stood for;
        // one already answered keeps its mark, so no card comes back for it.
        track.pending.set(id, { reason: evt.reason ?? 'question', toolName: evt.toolName ? clip(sanitize(evt.toolName, true), 80) : undefined, summary: clip(evt.summary ?? '', LIMITS.summary), questions: evt.questions, requestAt: fallback?.requestAt ?? Date.now(), ...(fallback?.invalidated ? { invalidated: true } : {}) })
        if (!promoted) notice = 'action'
        break
      }
      case 'resolved':
        if (evt.requestId) {
          track.pending.delete(evt.requestId)
          // A stable request ID remains deduplicated after resolution.
        }
        if (evt.reason) track.pending.delete(`fallback:${evt.reason}`)
        if (evt.provider === 'claude') {
          track.pending.delete('fallback:permission')
          track.seen.delete(`request:${track.turnId}:fallback:permission`)
          if (evt.reason) track.seen.delete(`request:${track.turnId}:fallback:${evt.reason}`)
          track.activity = 'working'
        }
        break
      case 'done':
        if (evt.provider === 'claude') {
          const target = track
          if (!evt.reply && !evt.subagent && target.transcriptPath) this.replyFromTranscript(evt.paneId, target)
          target.timer = setTimeout(() => {
            target.timer = null
            target.activity = 'done'
            target.pending.clear()
            target.tool = undefined
            this.publish(evt.paneId, target, `done:${target.turnId}`, 'done', evt)
          }, 700)
          return
        }
        track.activity = 'done'; key = `done:${track.turnId}`; notice = 'done'
        break
      case 'error': track.activity = 'error'; key = `error:${track.turnId}`; notice = 'error'; break
      case 'unknown': track.activity = 'unknown'; break
      case 'end':
        track.retired.add(`${evt.provider}:${evt.sessionId}`)
        track.pending.clear(); track.activity = 'idle'; track.ended = true
        track.detail = undefined; track.tool = undefined
        break
    }
    this.publish(evt.paneId, track, key, notice, evt)
  }

  /**
   * E2-FR-48: user input written to the pane's live pty after a request takes
   * that request out of `pending[]` (the answer cards), so a card answered on
   * the desktop or on another phone goes away and a second tap finds nothing
   * to answer. `state`, `reason` and `pendingCount` stay: the request lives
   * until its normal hook (PostToolUse). Terminal reports never count.
   */
  onUserInput(ptyId: string, paneId: string, data: string): void {
    if (this.ptys.get(paneId) !== ptyId) return
    const track = this.panes.get(paneId)
    if (!track || track.pending.size === 0 || REPORTS_ONLY_RE.test(data)) return
    const now = Date.now()
    let changed = false
    for (const entry of track.pending.values()) {
      if (entry.invalidated || entry.requestAt > now) continue
      entry.invalidated = true
      changed = true
    }
    if (changed) this.publish(paneId, track)
  }

  dispose(): void { for (const id of [...this.panes.keys()]) this.clearPane(id); this.ptys.clear() }

  /** Copies the bounded enrichment of an accepted event onto its track. */
  private enrich(track: PaneTrack, evt: AgentEvent): void {
    if (evt.cwd && isAbsolute(evt.cwd)) track.cwd = evt.cwd
    if (evt.transcriptPath) track.transcriptPath = evt.transcriptPath
    // Subagents only touch the main detail through questions and permissions.
    const own = !evt.subagent || evt.kind === 'request'
    if (own && evt.detail) track.detail = { kind: evt.detail.kind, text: clip(sanitize(evt.detail.text, true), LIMITS.detail) }
    if (own && evt.tool) track.tool = evt.tool
    if (evt.prompt) {
      track.tool = undefined
      if (!track.firstPrompt) track.firstPrompt = firstLine(evt.prompt, LIMITS.title) || undefined
    }
    if (evt.firstPrompt && !track.firstPrompt) track.firstPrompt = firstLine(evt.firstPrompt, LIMITS.title) || undefined
    if (evt.reply) { track.reply = evt.reply; track.replyTurn = track.turnId }
  }

  /**
   * Stop without last_assistant_message: read the reply from the tail of the
   * validated transcript (E1-FR-09). Runs after the HTTP answer and never
   * blocks the event flow; a stale result (other session or turn) is dropped.
   */
  private replyFromTranscript(paneId: string, track: PaneTrack): void {
    const turn = track.turnId, session = track.sessionId, path = track.transcriptPath!
    void this.readTranscript(path, session).then((text) => {
      if (!text || this.panes.get(paneId) !== track || track.sessionId !== session || track.turnId !== turn || track.replyTurn === turn) return
      track.reply = text; track.replyTurn = turn
      if (!track.detail || track.detail.kind === 'reply') track.detail = { kind: 'reply', text: firstLine(text, LIMITS.detail) }
      this.publish(paneId, track)
    }, () => {})
  }

  private createTrack(provider: AgentProvider, sessionId: string): PaneTrack {
    const now = Date.now()
    return { provider, sessionId, retired: new Set(), precise: false, activity: 'idle', pending: new Map(), seen: new Set(), turnId: '', turn: 0, timer: null, updatedAt: now, ended: false, lastState: 'idle', stateSince: now, emittedAt: 0, detailTimer: null }
  }
  private cancelTimer(track: PaneTrack): void { if (track.timer) clearTimeout(track.timer); track.timer = null }
  private cancelDetail(track: PaneTrack): void { if (track.detailTimer) clearTimeout(track.detailTimer); track.detailTimer = null; track.deferredCause = undefined }
  private clearPane(paneId: string): void {
    const track = this.panes.get(paneId)
    if (!track) return
    this.cancelTimer(track); this.cancelDetail(track); this.panes.delete(paneId)
    this.emit({ paneId, state: null, precise: false, notify: false })
  }
  private stateOfTrack(track: PaneTrack): ClaudePaneState {
    return track.activity === 'error' || track.activity === 'unknown' ? track.activity : track.pending.size ? 'action' : track.activity
  }
  private event(paneId: string, track: PaneTrack, notify: boolean): PaneStatusEvt {
    const state = this.stateOfTrack(track)
    const evt: PaneStatusEvt = {
      paneId, provider: track.provider, precise: track.precise, notify, state,
      reason: track.activity === 'error' ? 'failure' : track.pending.values().next().value?.reason,
      pendingCount: track.pending.size, updatedAt: track.updatedAt, stateSince: track.stateSince,
    }
    if (track.topic) evt.topic = track.topic
    if (track.firstPrompt) evt.firstPrompt = track.firstPrompt
    if (track.provider === 'claude' && track.cacheSince) evt.cacheSince = track.cacheSince
    // A title-only (approximate) track carries no reply, tool or pending detail (E4-FR-09).
    if (!track.precise) return evt
    if (track.reply) evt.lastMessage = clip(sanitize(track.reply, true), LIMITS.lastMessage)
    if (track.tool && (state === 'working' || state === 'action')) evt.activity = clip(track.tool, LIMITS.activity)
    const pending: RemotePending[] = []
    for (const [id, entry] of track.pending) {
      if (entry.reason === 'failure' || entry.invalidated) continue
      pending.push({ id, kind: entry.reason, ...(entry.toolName ? { toolName: entry.toolName } : {}), summary: entry.summary, ...(entry.questions ? { questions: entry.questions } : {}) })
    }
    if (pending.length) evt.pending = pending
    if (track.detail) evt.detail = track.detail
    if (track.cwd) evt.cwd = track.cwd
    // Never a Codex `launch:` placeholder, never a console behind a Connection Profile.
    if (SESSION_ID_RE.test(track.sessionId) && !this.isSshPane(paneId)) evt.sessionId = track.sessionId
    return evt
  }
  /** pane.setupId ?? workspace.setupId (same precedence as launch.ts). Cached per spawn; misses retried after 5 s. */
  private isSshPane(paneId: string): boolean {
    const cached = this.sshPanes.get(paneId)
    if (cached !== undefined) return cached
    if (Date.now() - (this.sshMisses.get(paneId) ?? -Infinity) < 5000) return false
    for (const ws of this.getConfig()?.workspaces ?? []) {
      const pane = ws.panes.find(p => p.id === paneId)
      if (pane) { const ssh = !!(pane.setupId ?? ws.setupId); this.sshPanes.set(paneId, ssh); return ssh }
    }
    this.sshMisses.set(paneId, Date.now())
    return false
  }
  private publish(paneId: string, track: PaneTrack, key?: string, state?: StatusNotice['state'], cause?: AgentEvent): void {
    const now = Date.now()
    track.updatedAt = now
    // stateSince moves only when the effective state changes (E4-FR-09 c);
    // cacheSince marks Claude's working -> done/idle transition (E5-FR-28).
    const effective = this.stateOfTrack(track)
    const transition = effective !== track.lastState
    if (transition) {
      if (effective === 'working') track.cacheSince = undefined
      else if (track.lastState === 'working' && (effective === 'done' || effective === 'idle')) track.cacheSince = now
      track.lastState = effective; track.stateSince = now
    }
    const fresh = !!key && !track.seen.has(key)
    if (key) { track.seen.add(key); if (track.seen.size > 512) track.seen.delete(track.seen.values().next().value!) }
    const evt = this.event(paneId, track, false), cfg = this.cfg
    if (fresh && state) {
      this.onNotice({ paneId, provider: track.provider, state, reason: evt.reason })
      const focused = this.getWindow()?.isFocused() ?? false
      const inView = this.viewed.has(paneId) && focused
      evt.notify = !!cfg?.enabled && (state === 'done' ? cfg.notifyDone : cfg.notifyAction) && !inView
      // E4-FR-07: with the window focused, the renderer shows an in-app card
      // instead of the OS notification (and never flashes the taskbar).
      evt.delivery = !evt.notify ? 'none' : focused && cfg?.inAppWhenFocused !== false ? 'inApp' : 'native'
      if (evt.delivery === 'native') this.showNotification(paneId, track, state)
    }
    // Only-detail changes are coalesced to one emission per 500 ms per pane
    // (E5-FR-02); state, pending, session and notifications go out at once.
    const signature = JSON.stringify([evt.state, evt.reason, evt.pendingCount, evt.pending?.map(p => p.id), evt.provider, evt.precise, evt.sessionId, evt.cwd])
    const immediate = transition || !!key || evt.notify || (!!cause && IMMEDIATE_KINDS.has(cause.kind)) || signature !== track.emitted
    if (immediate || now - track.emittedAt >= DETAIL_THROTTLE_MS) {
      this.cancelDetail(track)
      track.emitted = signature; track.emittedAt = now
      this.emit(evt, cause)
      return
    }
    if (cause) track.deferredCause = cause
    if (track.detailTimer) return
    track.detailTimer = setTimeout(() => {
      const deferred = track.deferredCause
      track.detailTimer = null; track.deferredCause = undefined
      if (this.panes.get(paneId) !== track) return
      track.emittedAt = Date.now()
      this.emit(this.event(paneId, track, false), deferred)
    }, Math.max(0, DETAIL_THROTTLE_MS - (now - track.emittedAt)))
  }
  private showNotification(paneId: string, track: PaneTrack, state: StatusNotice['state']): void {
    const win = this.getWindow(), cfg = this.getConfig()
    let pane = track.provider === 'codex' ? 'Codex' : 'Claude'
    for (const ws of cfg?.workspaces ?? []) {
      const found = ws.panes.find(p => p.id === paneId)
      if (found) { pane = `${ws.name} / ${found.title}`; break }
    }
    const key = state === 'done' ? 'status.notif.done' : state === 'error' ? 'status.notif.error' : track.precise ? 'status.notif.action' : 'status.notif.generic'
    this.showNative(mainT(cfg, key, { pane, provider: track.provider === 'codex' ? 'Codex' : 'Claude' }), paneId)
    if (this.cfg?.flashTaskbar && win && !win.isFocused()) win.flashFrame(true)
  }
  private showNative(body: string, paneId?: string, title: string = BRAND.productName): void {
    this.desktopError = null
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body, silent: true })
      notification.on('click', () => {
        const w = this.getWindow()
        if (!w || w.isDestroyed()) return
        revealWindow(w, paneId)
      })
      notification.on('failed', (_event, error) => {
        this.desktopError = /-214342014[03]/.test(error) ? 'blocked' : 'failed'
        console.warn('[status] Desktop notification could not be displayed')
      })
      notification.show()
    } else this.desktopError = 'unavailable'
  }
  private emit(evt: PaneStatusEvt, cause?: AgentEvent): void {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(CH.STATUS_STATE, evt)
    for (const listener of this.listeners) {
      try { listener(evt, cause) } catch { console.warn('[status] a status listener failed') }
    }
    this.noteTranscript(evt.paneId)
  }
}
