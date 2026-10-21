import { Notification, type BrowserWindow } from 'electron'
import { isAbsolute } from 'path'
import { CH } from '@shared/ipc-channels'
import { BRAND } from '@shared/brand'
import { effectiveProvider } from '@shared/agents'
import { REPORTS_ONLY_RE } from '@shared/inputReports'
import type { TuneHint } from '@shared/agentTune'
import { AGENT_END_REASONS, type AgentDetail, type AgentProvider, type AgentRenameEvt, type AgentSessionEndEvt, type AgentWaiting, type AttentionReason, type ClaudePaneState, type ConfigFile, type NotificationSettings, type PaneStatusEvt, type RemotePending } from '@shared/types'
import type { PtyExitInfo, PtyInputOrigin, PtySink } from '../pty/PtyManager'
import { mainT } from '../i18n'
import { revealWindow } from '../window/revealWindow'
import type { BackgroundTasks, HookEvent } from './HookServer'
import type { AgentEvent, StatusNotice } from './events'
import { LIMITS, clip, firstLine, readLastAssistantMessage, readLastCustomTitle, sanitize } from './statusDetails'

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
  /** v2.2.1: a title-only Codex track's text after the spinner (its idle title). */
  titleText?: string
  /** v2.4: when the armed clear `timer` fires (armClear keeps the sooner one). */
  clearAt?: number
  firstPrompt?: string
  cwd?: string
  transcriptPath?: string
  /** Throttle of detail-only emissions (500 ms per pane). */
  emitted?: string
  emittedAt: number
  detailTimer: NodeJS.Timeout | null
  deferredCause?: AgentEvent
  // v2.2: what a finished turn still waits on.
  /** Sub-sessions alive on the console (a driver's `claude -p`): session id -> last hook. */
  subSessions: Map<string, number>
  /** When the last sub-session ended: a short grace bridges two of a driver. */
  subEndedAt?: number
  /** Stop `background_tasks` of the last turn, and when it stopped. */
  background?: BackgroundTasks & { at: number }
  /** Re-evaluates the wait when its next piece expires. */
  waitTimer: NodeJS.Timeout | null
  /** Last hook of the main session (the Esc interrupt watch). */
  lastHookAt: number
  interruptTimer: NodeJS.Timeout | null
  // v2.3 attention: every effective transition bumps stateSeq; an ack copies
  // it to ackedSeq. A counter, not a clock: two transitions in the same ms differ.
  stateSeq: number
  ackedSeq: number
  // v2.3 agentTune read-back: SessionStart model / hook effort, or the last
  // tune applied with Enter (setTuneHint). Reset on `start`.
  model?: string
  effort?: string
  ultracode?: boolean
  // v2.4 `/rename`: the session's name as last seen (dedup), the session it
  // belongs to, and whether main already looked at it once (a name found on
  // the first look is `initial`). The read of the transcript is debounced.
  agentTitle?: string
  titleSession?: string
  titleLooked?: boolean
  titleTimer?: NodeJS.Timeout | null
}

/** A hook of the live pty with its session: what onHookEvent passes on. */
type LiveHook = HookEvent & { ptyId: string; sessionId: string }

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
/** Tools whose PreToolUse is the request itself (question, plan); their permission prompt is the same request. */
const PROMPT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
/** A sub-session silent this long is gone (its SessionEnd never came). */
export const SUB_SESSION_TTL_MS = 10 * 60 * 1000
/** Between two sub-sessions of a driver the console keeps waiting this long. */
export const SUB_SESSION_GRACE_MS = 15 * 1000
/** Background work that comes back to the agent holds the console at most this long. */
export const BACKGROUND_WAIT_TTL_MS = 2 * 60 * 60 * 1000
/** Stopped title glyph with no hook for this long after an Esc: the turn is over. */
export const INTERRUPT_SETTLE_MS = 2000
/** v2.4: a `/rename` trigger (topic change, prompt, done) reads the transcript this long after the last one. */
export const AGENT_TITLE_DEBOUNCE_MS = 300
/** v2.4: a prompt that is Claude's `/rename` command never becomes the first prompt. */
const RENAME_PROMPT_RE = /^\/rename(?:\s|$)/i
/** v2.4: who keeps the last name of each session across restarts (AgentSessionStore). */
export type AgentTitleSeed = (paneId: string, provider: AgentProvider, sessionId: string) => string | undefined

/** Topic after the spinner / stopped glyph of Claude's OSC title, or undefined for generic titles. */
function titleTopic(title: string): string | undefined {
  const cp = title.codePointAt(0) ?? 0
  if (!((cp >= 0x2800 && cp <= 0x28ff) || cp === 0x2733)) return undefined
  const topic = clip(sanitize(title.slice(cp > 0xffff ? 2 : 1), true), LIMITS.title)
  return topic && !GENERIC_TOPICS.test(topic) ? topic : undefined
}

/** Codex's idle title is its working title without the spinner (extra status words on either side tolerated). */
function sameTitle(a: string, b: string): boolean {
  return a === b || (!!a && !!b && (a.startsWith(`${b} `) || b.startsWith(`${a} `)))
}

/** Separators Codex (or a status line) puts between the idle text and extra words. */
const TITLE_PARTS_RE = / (?:\||·|-|:) /
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * v2.4: Codex back at its prompt. The idle title is the working title's text
 * without the spinner, give or take a leading activity glyph, extra parts
 * after ` | `, ` · `, ` - ` or ` : `, or extra words around it (whole words).
 */
export function codexIdleMatch(title: string, titleText: string): boolean {
  const raw = sanitize(title, true)
  if (sameTitle(raw, titleText)) return true
  if (!titleText) return false
  const clean = raw.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  if (sameTitle(clean, titleText)) return true
  if (clean.split(TITLE_PARTS_RE).some(part => part.trim() === titleText)) return true
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRe(titleText)}(?:$|[^\\p{L}\\p{N}_])`, 'u').test(clean)
}

/** v2.4: the shell's own title (PowerShell, pwsh, cmd, their exe path, or the pane's last title before the agent ran). */
export function looksLikeShellTitle(title: string, shellTitle?: string): boolean {
  const t = title.trim()
  if (!t) return false
  if (shellTitle && t === shellTitle) return true
  return /^(?:(?:Administrator|Administrador): )?(?:Windows PowerShell|PowerShell|pwsh|cmd(?:\.exe)?)\b/i.test(t) || /(?:^|[\\/])(?:powershell|pwsh|cmd)(?:\.exe)?$/i.test(t)
}

/** v2.4: an OSC 133 A / C / D mark with its `;field` list (B carries nothing main needs). */
const SHELL_MARK_RE = /\x1b\]133;([ACD])((?:;[^\x07\x1b]*)?)(?:\x07|\x1b\\)/g
/** A 133 mark cut at the end of a chunk; the next chunk completes it. */
const SHELL_MARK_TAIL_RE = /^\x1b(?:\](?:1(?:3(?:3(?:;[^\x07\x1b]*)?)?)?)?)?$/
/** Longest cut mark kept between chunks (`C;agent=codex;k=` plus a 32-char nonce fits well under it). */
const SHELL_MARK_TAIL_MAX = 128
/** An `agent=` mark counts only this soon after a user Enter on the pty. */
export const SHELL_AGENT_ENTER_MS = 2000
/** A title-only Codex track under an unknown title, on a pty with no shell marks, is cleared after this long. */
export const CODEX_STALE_TITLE_MS = 10_000

/** The cut mark at the end of `text` (from its last ESC), or ''. Scans only the last SHELL_MARK_TAIL_MAX chars. */
function shellMarkTail(text: string): string {
  let esc = text.indexOf('\x1b', Math.max(0, text.length - SHELL_MARK_TAIL_MAX))
  if (esc < 0) return ''
  for (let next = esc; next >= 0; next = text.indexOf('\x1b', next + 1)) esc = next
  const cut = text.slice(esc)
  return SHELL_MARK_TAIL_RE.test(cut) ? cut : ''
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
  /** v2.2.1: the agent each pane's preset runs (title-only fallback), cached per spawn like sshPanes. */
  private readonly paneProviders = new Map<string, AgentProvider | null>()
  private readonly providerMisses = new Map<string, number>()
  /** E3 M12: when each pane's live pty spawned (the no-hooks transcript match). */
  private readonly spawnTimes = new Map<string, number>()
  /** E3 M12: provider|session|transcript each pane last reported, and who listens. */
  private readonly transcriptKeys = new Map<string, string>()
  private readonly transcriptListeners = new Set<(paneId: string) => void>()
  /**
   * v2.2: a `startup` SessionStart of another session while the console's
   * own session lives, held until that session's first hook says whether it
   * is a sub-session (a driver's `claude -p`) or a new agent of the console.
   */
  private readonly candidates = new Map<string, LiveHook>()
  /**
   * v2.3: the native toast of each pane's last status notice (only
   * showNotification; `snaos notify` and the test toast never enter) and the
   * panes that flashed the taskbar. Both are released when the pane's
   * attention goes false.
   */
  private readonly natives = new Map<string, Notification>()
  private readonly flashing = new Set<string>()
  /** v2.3: a paired phone is looking at the pane right now (SessionManager.isPaneSeen). */
  private remoteSeen: (paneId: string) => boolean = () => false
  // v2.4: `claude` / `codex` typed in an integrated PowerShell (OSC 133 C;agent=).
  /** The pty's mark nonce (PtyManager.shellMarkOf), read on spawn; no entry = not integrated. */
  private shellMark: (ptyId: string) => string | undefined = () => undefined
  private readonly shellKeys = new Map<string, string>()
  /** agents.shellAgentDetect, pushed by main (never read from disk on the data path). */
  private shellAgentDetect = true
  /** The agent the pane's shell runs right now; it wins over the config in providerOf. */
  private readonly runtimeAgents = new Map<string, AgentProvider>()
  /** A mark cut at the end of the pane's last chunk. */
  private readonly markTails = new Map<string, string>()
  /** When the user last sent an Enter to the pane's live pty. */
  private readonly enterAt = new Map<string, number>()
  /** The pane's title while it had no track (looksLikeShellTitle). */
  private readonly shellTitles = new Map<string, string>()
  /** Sessions a shell's agent ran, cleared at its D/A: a late end or hook never brings the row back. */
  private readonly hostedRetired = new Map<string, Set<string>>()
  // v2.4 `/rename`: the persisted last name of a session, and who hears a rename.
  private titleSeed: AgentTitleSeed = () => undefined
  private readonly renameListeners = new Set<(evt: AgentRenameEvt) => void>()
  lastClaudeEventAt: number | null = null
  desktopError: 'blocked' | 'failed' | 'unavailable' | null = null
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getConfig: () => ConfigFile | null,
    private readonly onNotice: (notice: StatusNotice) => void = () => {},
    private readonly readTranscript: (path: string, sessionId: string) => Promise<string | undefined> = (path, sessionId) => readLastAssistantMessage(path, sessionId),
    private readonly readTitle: (path: string, sessionId: string) => Promise<string | undefined> = (path, sessionId) => readLastCustomTitle(path, sessionId),
  ) {}
  onSpawn(ptyId: string, paneId: string): void {
    this.clearPane(paneId); this.candidates.delete(paneId); this.sshPanes.delete(paneId); this.sshMisses.delete(paneId); this.paneProviders.delete(paneId); this.providerMisses.delete(paneId); this.ptys.set(paneId, ptyId); this.spawnTimes.set(paneId, Date.now())
    this.resetShell(paneId)
    const key = this.shellMark(ptyId)
    if (key) this.shellKeys.set(paneId, key)
  }
  /**
   * v2.4: the OSC 133 marks of an integrated PowerShell. Runs on every flush,
   * so the cheap checks go first: an integrated pty, the cached setting, then
   * a plain `includes` (or a mark cut at the previous chunk's end).
   */
  onData(ptyId: string, paneId: string, data: string): void {
    const key = this.shellKeys.get(paneId)
    if (!key || (!this.shellAgentDetect && !this.runtimeAgents.has(paneId)) || this.ptys.get(paneId) !== ptyId) return
    const tail = this.markTails.get(paneId)
    if (!tail && !data.includes('\x1b]133;')) {
      const cut = shellMarkTail(data)
      if (cut) this.markTails.set(paneId, cut)
      return
    }
    const text = tail ? tail + data : data
    this.markTails.delete(paneId)
    for (const m of text.matchAll(SHELL_MARK_RE)) this.onShellMark(paneId, key, m[1], m[2])
    const cut = shellMarkTail(text)
    if (cut) this.markTails.set(paneId, cut)
  }
  /** Every exit (natural or not) releases the pane's tracking. */
  onExit(ptyId: string, paneId: string, _exitCode?: number, _info?: PtyExitInfo): void {
    if (this.ptys.get(paneId) !== ptyId) return
    this.ptys.delete(paneId)
    this.spawnTimes.delete(paneId)
    this.candidates.delete(paneId)
    this.paneProviders.delete(paneId); this.providerMisses.delete(paneId)
    this.resetShell(paneId)
    this.clearPane(paneId)
  }
  setConfig(cfg: NotificationSettings): void { this.cfg = cfg }
  /** v2.4: main's wiring to PtyManager.shellMarkOf (the nonce of an integrated pty). */
  setShellMarks(fn: (ptyId: string) => string | undefined): void { this.shellMark = fn }
  /** v2.4: the agents settings main acts on, pushed at boot and on every config save. */
  setAgentSettings(agents: { shellAgentDetect?: boolean } | null | undefined): void {
    this.shellAgentDetect = agents?.shellAgentDetect !== false
  }
  /** v2.4 `/rename`: main's wiring to AgentSessionStore.agentTitleFor (the name a session already had). */
  setAgentTitleSeed(fn: AgentTitleSeed): void { this.titleSeed = fn }
  /**
   * v2.4: every AgentRenameEvt main sends the renderer, whatever the
   * setting (the session store keeps the name so it is never re-applied).
   */
  onAgentRename(cb: (evt: AgentRenameEvt) => void): () => void {
    this.renameListeners.add(cb)
    return () => { this.renameListeners.delete(cb) }
  }
  /**
   * v2.4: a name Codex gave its thread (CodexProtocol through the bridge).
   * `explicit`: a `thread/name/set` the server accepted (the user's
   * `/rename`); otherwise the name a started or resumed thread already had.
   * Only the console's live precise Codex track of that thread takes it.
   */
  reportAgentTitle(paneId: string, ptyId: string, provider: AgentProvider, sessionId: string, title: string | undefined, explicit: boolean): void {
    if (this.ptys.get(paneId) !== ptyId) return
    const track = this.panes.get(paneId)
    if (!track?.precise || track.provider !== provider || track.sessionId !== sessionId || track.ended) return
    this.applyAgentTitle(paneId, track, title ? clip(sanitize(title, true), LIMITS.title) : undefined, explicit)
  }

  private resetShell(paneId: string): void {
    this.shellKeys.delete(paneId); this.runtimeAgents.delete(paneId); this.markTails.delete(paneId)
    this.enterAt.delete(paneId); this.shellTitles.delete(paneId); this.hostedRetired.delete(paneId)
  }

  /**
   * v2.4: one mark of the pane's shell. Only a mark carrying the pty's nonce
   * counts (a program's output, a `cat` of a file or an ssh host cannot know
   * it). A C with `agent=` right after a user Enter starts a runtime agent;
   * a D or an A is the shell's prompt back, so no agent owns the console.
   */
  private onShellMark(paneId: string, key: string, kind: string, params: string): void {
    const fields = params.split(';')
    if (!fields.includes(`k=${key}`)) return
    if (kind === 'C') {
      const agent = fields.find(f => f.startsWith('agent='))?.slice(6)
      if ((agent !== 'claude' && agent !== 'codex') || !this.shellAgentDetect) return
      if (Date.now() - (this.enterAt.get(paneId) ?? -Infinity) > SHELL_AGENT_ENTER_MS) return
      this.startRuntimeAgent(paneId, agent)
      return
    }
    this.endRuntimeAgent(paneId)
  }

  /** The row appears at once, idle; the title rules, hooks or the Codex bridge take it from there. */
  private startRuntimeAgent(paneId: string, provider: AgentProvider): void {
    this.runtimeAgents.set(paneId, provider)
    const current = this.panes.get(paneId)
    if (current?.precise && !current.ended) { this.publish(paneId, current); return }
    const track = current && !current.precise ? current : this.createTrack(provider, '')
    if (current?.precise) {
      // The previous agent's session ended: this is a new agent of the console.
      current.retired.add(`${current.provider}:${current.sessionId}`)
      this.stopTimers(current)
      track.retired = current.retired
    }
    this.cancelTimer(track)
    track.provider = provider
    this.panes.set(paneId, track)
    this.publish(paneId, track)
  }

  /**
   * The shell's prompt is back. A shell console drops its row whatever the
   * precision (the agent's process is gone; its end chip went out on its own)
   * and remembers the session, so a late SessionEnd or launcher end cannot
   * bring it back. An agent console only drops an approximate (title) track.
   */
  private endRuntimeAgent(paneId: string): void {
    const hosted = this.runtimeAgents.delete(paneId) && this.configProviderOf(paneId) === null
    const track = this.panes.get(paneId)
    if (!track || (!hosted && track.precise)) return
    if (hosted) {
      const gone = this.hostedRetired.get(paneId) ?? new Set<string>()
      for (const key of [...track.retired, `${track.provider}:${track.sessionId}`]) gone.add(key)
      while (gone.size > 64) gone.delete(gone.values().next().value!)
      this.hostedRetired.set(paneId, gone)
    }
    this.clearPane(paneId)
  }
  /** The panes the desktop shows; with the window focused they are acknowledged too (v2.3). */
  setViewed(paneIds: string[]): void {
    this.viewed = new Set(paneIds)
    if (!this.isFocused()) return
    for (const id of this.viewed) this.ackPane(id)
  }
  /** v2.3: who tells whether a phone is looking at a pane (main wiring). */
  setRemoteSeen(fn: (paneId: string) => boolean): void { this.remoteSeen = fn }
  /**
   * v2.3: a device saw the pane (a focused desktop view, a phone with it
   * open): its done / error stops asking for attention. An open request is
   * not answered by looking at it, so an `action` keeps its attention.
   * Publishes only when attention really went true -> false.
   */
  ackPane(paneId: string): void {
    const track = this.panes.get(paneId)
    if (!track || track.ackedSeq === track.stateSeq) return
    const before = this.attentionOf(track)
    track.ackedSeq = track.stateSeq
    if (before && !this.attentionOf(track)) this.publish(paneId, track)
  }
  /**
   * v2.3 (agentTune): the renderer applied a tune with Enter and ok; until a
   * hook says otherwise (or a new session starts) the console shows it. Only
   * a precise track takes it (the Enter gate needs one). Values come already
   * validated (registerStatusIpc).
   */
  setTuneHint(paneId: string, hint: TuneHint): void {
    const track = this.panes.get(paneId)
    if (!track || !track.precise) return
    const before = [track.model, track.effort, track.ultracode].join()
    if (hint.model) track.model = hint.model
    if (hint.effort) track.effort = hint.effort
    if (hint.ultracode !== undefined) track.ultracode = hint.ultracode
    if ([track.model, track.effort, track.ultracode].join() !== before) this.publish(paneId, track)
  }
  /** v2.3: the window got the focus: the taskbar stops flashing and the panes in view are seen. */
  onWindowFocus(): void {
    this.flashing.clear()
    for (const id of [...this.viewed]) this.ackPane(id)
  }
  snapshot(): PaneStatusEvt[] { return [...this.panes].map(([id, track]) => this.event(id, track, false)) }
  /** v2.3 (agentTune gate): the console's agent session ended (`/exit`), so its pty is back at the shell. */
  isEnded(paneId: string): boolean {
    return this.panes.get(paneId)?.ended === true
  }
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
      if (topic && topic !== current.topic) {
        current.topic = topic; this.publish(paneId, current)
        // v2.4: `/rename` changes Claude's title at once; its record says the name.
        this.scheduleTitleRead(paneId, current)
      }
      this.watchInterrupt(paneId, current, cp)
      return
    }
    const working = cp >= 0x2800 && cp <= 0x28ff, stopped = cp === 0x2733
    // v2.4: what the shell shows while no agent runs (looksLikeShellTitle).
    if (!current && !working && !stopped && t) this.shellTitles.set(paneId, t)
    // v2.2.1: a Codex console's title has its own shape (no Claude glyph or names).
    if (this.providerOf(paneId) === 'codex') { this.codexTitle(paneId, current, t, working); return }
    const present =/^(claude|Claude Code|claude daemon)$/.test(t) || t.startsWith('claude · ')
    if (!working && !stopped && !present) {
      // v2.4: with a runtime agent, the shell's D/A mark ends the row, never a title.
      if (current && !current.timer && !this.runtimeAgents.has(paneId)) current.timer = setTimeout(() => this.clearPane(paneId), 3000)
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

  /**
   * v2.2.1: the title-only fallback of a Codex console (no bridge: the
   * integration is off or the command passes `--no-daemon`). A spinner is a
   * working turn and the text after it is kept; that same text with no spinner
   * is Codex back at its prompt (done, the track stays, codexIdleMatch).
   * v2.4: only the shell's own title (looksLikeShellTitle) clears it, after
   * 3 s like Claude's, and never while the shell's marks say an agent runs;
   * any other title keeps the row (working becomes done). On a pty with no
   * shell marks an unknown title that stays CODEX_STALE_TITLE_MS clears it
   * too, or a custom prompt title would keep the row forever.
   */
  private codexTitle(paneId: string, current: PaneTrack | undefined, title: string, working: boolean): void {
    if (!working) {
      if (!current) return
      const idle = current.titleText !== undefined && codexIdleMatch(title, current.titleText)
      if (!idle && looksLikeShellTitle(title, this.shellTitles.get(paneId))) {
        if (!this.runtimeAgents.has(paneId)) this.armClear(paneId, current, 3000)
        return
      }
      this.cancelTimer(current)
      if (current.activity !== 'done') current.activity = current.activity === 'working' ? 'done' : 'idle'
      current.pending.clear()
      this.publish(paneId, current)
      if (!idle && !this.shellKeys.has(paneId)) this.armClear(paneId, current, CODEX_STALE_TITLE_MS)
      return
    }
    // A track made by the Claude rules before the config named the preset is relabelled.
    const track = current ?? this.createTrack('codex', '')
    track.provider = 'codex'
    this.panes.set(paneId, track)
    this.cancelTimer(track)
    track.titleText = sanitize(title.slice(1), true)
    const topic = titleTopic(title)
    if (topic) track.topic = topic
    if (track.activity !== 'working') track.turn++
    track.activity = 'working'
    track.pending.clear()
    this.publish(paneId, track)
  }

  /**
   * v2.2: Claude fires no Stop when the user interrupts a turn (Esc). A
   * precise Claude track stuck in `working` with nothing pending, whose title
   * shows the stopped glyph for INTERRUPT_SETTLE_MS while no hook arrives, is
   * idle (no notice). A working glyph, or any hook, calls it off.
   */
  private watchInterrupt(paneId: string, track: PaneTrack, glyph: number): void {
    if (glyph !== 0x2733 || track.provider !== 'claude' || track.activity !== 'working' || track.pending.size) {
      if (track.interruptTimer) { clearTimeout(track.interruptTimer); track.interruptTimer = null }
      return
    }
    if (track.interruptTimer) return
    const since = track.lastHookAt
    track.interruptTimer = setTimeout(() => {
      track.interruptTimer = null
      if (this.panes.get(paneId) !== track || track.timer || track.activity !== 'working' || track.pending.size || track.lastHookAt !== since) return
      track.activity = 'idle'
      track.tool = undefined
      this.publish(paneId, track)
    }, INTERRUPT_SETTLE_MS)
  }

  onHookEvent(evt: HookEvent): void {
    if (!evt.ptyId || !evt.sessionId || this.ptys.get(evt.consoleId) !== evt.ptyId) return
    const live = evt as LiveHook
    if (this.routeSubSession(live)) return
    this.acceptHook(live)
  }

  /**
   * v2.2: hooks of a sub-session (a `claude -p` a driver started from this
   * console, marked by its headers) never stand for the console's agent: they
   * only keep it waiting. A `startup` of another session while the console's
   * own session lives is held as a candidate (a hook command cannot carry the
   * child mark): its first marked hook makes it a sub-session, an unmarked one
   * a new agent of the console (the old one died without SessionEnd). True
   * when the event was consumed here.
   */
  private routeSubSession(evt: LiveHook): boolean {
    const paneId = evt.consoleId, sid = evt.sessionId
    const track = this.panes.get(paneId)
    const candidate = this.candidates.get(paneId)
    if (!evt.nested && !track?.subSessions.has(sid)) {
      if (candidate?.sessionId === sid) {
        if (evt.name === 'SessionStart') return true
        this.candidates.delete(paneId)
        this.acceptHook(candidate)
        return false
      }
      if (evt.name === 'SessionStart' && evt.source === 'startup' && track?.precise && !track.ended && track.sessionId && track.sessionId !== sid) {
        this.candidates.set(paneId, evt)
        return true
      }
      return false
    }
    if (candidate?.sessionId === sid) this.candidates.delete(paneId)
    if (!track) return true
    const now = Date.now()
    if (evt.name === 'SessionEnd') {
      if (track.subSessions.delete(sid)) track.subEndedAt = now
    } else track.subSessions.set(sid, now)
    this.publish(paneId, track)
    this.armWait(paneId, track)
    return true
  }

  private acceptHook(evt: LiveHook): void {
    if (evt.agentId && !['PermissionRequest', 'Elicitation', 'ElicitationResult', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification'].includes(evt.name)) return
    if (evt.agentId && evt.name === 'PreToolUse' && !['AskUserQuestion', 'ExitPlanMode'].includes(evt.toolName ?? '')) return
    const base = {
      paneId: evt.consoleId, ptyId: evt.ptyId, provider: 'claude' as const,
      sessionId: evt.agentId ? this.panes.get(evt.consoleId)?.sessionId ?? evt.sessionId : evt.sessionId,
      cwd: evt.cwd, transcriptPath: evt.agentId ? undefined : evt.transcriptPath, subagent: evt.agentId ? true : undefined,
      // v2.3: a subagent's model and effort are not the console's.
      ...(evt.agentId ? {} : { model: evt.model, effort: evt.effort }),
    }
    const requestId = evt.toolUseId ?? evt.elicitationId
    const tool = { toolName: evt.toolName, tool: evt.toolSummary, summary: evt.requestSummary ?? evt.toolSummary }
    let event: AgentEvent | undefined
    switch (evt.name) {
      case 'SessionStart': event = { ...base, kind: 'start', source: evt.source }; break
      case 'SessionEnd': event = { ...base, kind: 'end', endReason: evt.endReason }; break
      case 'UserPromptSubmit':
        event = { ...base, kind: 'working', turnId: `prompt:${++this.promptSequence}`, prompt: evt.prompt, detail: evt.prompt ? { kind: 'prompt', text: firstLine(evt.prompt, LIMITS.detail) } : undefined }
        break
      case 'Stop':
        event = { ...base, kind: 'done', reply: evt.lastAssistantMessage, detail: { kind: 'reply', text: firstLine(evt.lastAssistantMessage, LIMITS.detail) }, background: evt.background }
        break
      case 'StopFailure': event = { ...base, kind: 'error', reason: 'failure' }; break
      case 'PermissionRequest':
        // AskUserQuestion and ExitPlanMode also go through a permission prompt
        // (with no tool_use_id): their PreToolUse already registered the request.
        if (!requestId && PROMPT_TOOLS.has(evt.toolName ?? '') && this.hasPendingTool(evt.consoleId, evt.toolName!)) break
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
        // A fallback for a prompt no other hook reported: any request already
        // pending is the prompt this notification is about.
        const reason = evt.notificationType === 'permission_prompt' ? 'permission' : evt.notificationType === 'elicitation_dialog' ? 'elicitation' : undefined
        if (reason && !this.panes.get(evt.consoleId)?.pending.size) event = { ...base, kind: 'request', reason }
        break
      }
    }
    if (event) { this.lastClaudeEventAt = Date.now(); this.onAgentEvent(event) }
    if (event && !evt.agentId) this.titleFromHook(evt)
    if (evt.name === 'SessionEnd') this.emitSessionEnd(evt)
  }

  /**
   * v2.4 `/rename`: a hook of the console's main session (sub-sessions and
   * subagents never get here) names the session or asks for a look.
   * `session_title` is the name itself; without it a prompt re-reads the
   * transcript, and a fresh `startup` has no name yet (the first look is
   * done, so the next name is a rename seen happening).
   */
  private titleFromHook(evt: LiveHook): void {
    const paneId = evt.consoleId
    const track = this.panes.get(paneId)
    if (!track?.precise || track.provider !== 'claude' || track.sessionId !== evt.sessionId || track.ended) return
    if (evt.sessionTitle) { this.applyAgentTitle(paneId, track, evt.sessionTitle, false); return }
    if (evt.name === 'SessionStart') {
      if (track.titleLooked) return
      if (evt.source && evt.source !== 'startup' && track.transcriptPath) this.scheduleTitleRead(paneId, track)
      else track.titleLooked = true
      return
    }
    if (evt.name === 'UserPromptSubmit') this.scheduleTitleRead(paneId, track)
  }

  /** v2.4: reads the session's name from its transcript, AGENT_TITLE_DEBOUNCE_MS after the last trigger. */
  private scheduleTitleRead(paneId: string, track: PaneTrack): void {
    if (!track.precise || track.provider !== 'claude' || !track.transcriptPath || track.ended) return
    if (track.titleTimer) clearTimeout(track.titleTimer)
    track.titleTimer = setTimeout(() => {
      track.titleTimer = null
      const session = track.sessionId, path = track.transcriptPath
      if (this.panes.get(paneId) !== track || !path) return
      void this.readTitle(path, session).then((title) => {
        // Stale: another session, the track went away, or the session ended.
        if (this.panes.get(paneId) !== track || track.sessionId !== session || !track.precise || track.ended) return
        this.applyAgentTitle(paneId, track, title, false)
      }, () => {})
    }, AGENT_TITLE_DEBOUNCE_MS)
  }

  /**
   * v2.4: the one place a session name lands. Undefined only records that
   * main looked. The same name twice (Claude re-appends it every turn, a
   * restart seeds it back) never goes out again.
   */
  private applyAgentTitle(paneId: string, track: PaneTrack, title: string | undefined, explicit: boolean): void {
    const initial = !explicit && !track.titleLooked
    track.titleLooked = true
    if (!title || title === track.agentTitle) return
    track.agentTitle = title
    const ptyId = this.ptys.get(paneId)
    // Never a Codex `launch:` placeholder or an approximate track.
    if (!ptyId || !SESSION_ID_RE.test(track.sessionId)) return
    this.sendAgentRename({ paneId, ptyId, provider: track.provider, sessionId: track.sessionId, title, initial })
  }

  private sendAgentRename(evt: AgentRenameEvt): void {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(CH.STATUS_AGENT_RENAME, evt)
    for (const cb of this.renameListeners) {
      try { cb(evt) } catch { console.warn('[status] a rename listener failed') }
    }
  }

  /** A request of this tool (AskUserQuestion, ExitPlanMode) is already pending on the pane. */
  private hasPendingTool(paneId: string, toolName: string): boolean {
    for (const p of this.panes.get(paneId)?.pending.values() ?? []) if (p.toolName === toolName) return true
    return false
  }

  /**
   * E6-FR-21: Claude's main session of the live pty ended with a reason that
   * offers "resume / new" (`/exit`, Ctrl+D). The live-pty and subagent guards
   * already ran in onHookEvent; `clear`, `logout` and unknown reasons stay silent.
   */
  private emitSessionEnd(evt: HookEvent): void {
    const reason = AGENT_END_REASONS.find((r) => r === evt.endReason)
    if (!reason || reason === 'exit' || evt.agentId || !evt.ptyId || !evt.sessionId || !SESSION_ID_RE.test(evt.sessionId)) return
    this.sendSessionEnd({ paneId: evt.consoleId, ptyId: evt.ptyId, provider: 'claude', sessionId: evt.sessionId, reason, at: Date.now(), ...(evt.cwd ? { cwd: evt.cwd } : {}) })
  }

  private sendSessionEnd(end: AgentSessionEndEvt): void {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(CH.STATUS_SESSION_END, end)
  }

  onAgentEvent(evt: AgentEvent): void {
    if (this.ptys.get(evt.paneId) !== evt.ptyId) return
    let track = this.panes.get(evt.paneId)
    // v2.4: the shell's prompt already ended this agent (D/A); only a new start counts.
    if (!track && evt.kind !== 'start' && this.hostedRetired.get(evt.paneId)?.has(`${evt.provider}:${evt.sessionId}`)) return
    if (track?.retired.has(`${evt.provider}:${evt.sessionId}`)) {
      if (evt.kind === 'start' && (evt.provider === 'codex' || (track.ended && track.sessionId === evt.sessionId))) track.retired.delete(`${evt.provider}:${evt.sessionId}`)
      else return
    }
    if (track?.precise && (track.sessionId !== evt.sessionId || track.provider !== evt.provider)) {
      if (evt.kind !== 'start') return
      const retired = track.retired
      retired.add(`${track.provider}:${track.sessionId}`)
      if (retired.size > 64) retired.delete(retired.values().next().value!)
      this.stopTimers(track)
      track = this.createTrack(evt.provider, evt.sessionId)
      track.retired = retired
    }
    if (!track) track = this.createTrack(evt.provider, evt.sessionId)
    if (!track.precise) { this.cancelTimer(track); track.pending.clear(); track.sessionId = evt.sessionId; track.provider = evt.provider }
    track.precise = true
    this.panes.set(evt.paneId, track)
    this.cancelTimer(track)
    track.lastHookAt = Date.now()
    // v2.4 `/rename`: a session seen for the first time starts from the name it
    // already had (kept across restarts), so a resume never renames again.
    const titleSession = `${evt.provider}:${evt.sessionId}`
    if (track.titleSession !== titleSession) {
      track.titleSession = titleSession
      let seed: string | undefined
      try { seed = SESSION_ID_RE.test(evt.sessionId) ? this.titleSeed(evt.paneId, evt.provider, evt.sessionId) : undefined } catch { seed = undefined }
      track.agentTitle = seed
      track.titleLooked = seed !== undefined
      if (track.titleTimer) { clearTimeout(track.titleTimer); track.titleTimer = null }
    }
    // A turn the agent starts on its own (a background task came back) has no
    // UserPromptSubmit: its first event after a settled Stop opens a new turn,
    // so its own Stop notifies again.
    if (!evt.turnId && track.activity === 'done' && (evt.kind === 'working' || evt.kind === 'request')) track.turnId = `wake:${++this.promptSequence}`
    if (evt.turnId) track.turnId = evt.turnId
    if (evt.kind === 'start') {
      // A new session starts clean (E5-FR-02: firstPrompt resets on start).
      track.firstPrompt = undefined; track.detail = undefined; track.tool = undefined; track.reply = undefined; track.replyTurn = undefined
      // v2.3: so is its tune read-back, but only for a new process (a startup,
      // or a resume after the session ended): a compact, clear or resume
      // inside the same Claude keeps it (Ultracode is never re-reported) and
      // SessionStart's own model and effort overwrite it through enrich().
      if (!evt.source || evt.source === 'startup' || track.ended) { track.model = undefined; track.effort = undefined; track.ultracode = undefined }
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
        // The fallback this request stands for: same reason, or the permission
        // prompt of this same AskUserQuestion / ExitPlanMode reported first.
        const toolName = evt.toolName ? clip(sanitize(evt.toolName, true), 80) : undefined
        const permission = track.pending.get('fallback:permission')
        const fallbackId = evt.requestId && toolName && PROMPT_TOOLS.has(toolName) && permission?.toolName === toolName ? 'fallback:permission' : `fallback:${evt.reason ?? 'question'}`
        const fallback = evt.requestId ? track.pending.get(fallbackId) : undefined
        const promoted = !!evt.requestId && track.pending.delete(fallbackId)
        // E2-FR-48: the promoted request is the prompt the fallback stood for;
        // one already answered keeps its mark, so no card comes back for it.
        track.pending.set(id, { reason: evt.reason ?? 'question', toolName, summary: clip(evt.summary ?? '', LIMITS.summary), questions: evt.questions, requestAt: fallback?.requestAt ?? Date.now(), ...(fallback?.invalidated ? { invalidated: true } : {}) })
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
          // v2.4: a turn that ended may have renamed the session (`/rename` inside it).
          if (!evt.subagent) this.scheduleTitleRead(evt.paneId, target)
          target.timer = setTimeout(() => {
            target.timer = null
            target.activity = 'done'
            target.pending.clear()
            target.tool = undefined
            target.background = evt.background ? { ...evt.background, at: Date.now() } : undefined
            // v2.2: a turn that left work coming back to it is not done: no notice.
            const waiting = !!this.waitingOf(target)
            this.publish(evt.paneId, target, `done:${target.turnId}`, waiting ? undefined : 'done', evt)
            this.armWait(evt.paneId, target)
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
        // v2.2: Codex quit (its launcher ended with code 0): the same
        // "exited [Resume] [New]" offer Claude's SessionEnd raises.
        if (evt.provider === 'codex' && SESSION_ID_RE.test(evt.sessionId)) {
          this.sendSessionEnd({ paneId: evt.paneId, ptyId: evt.ptyId, provider: 'codex', sessionId: evt.sessionId, reason: 'exit', at: Date.now(), ...(track.cwd ? { cwd: track.cwd } : {}) })
        }
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
  onUserInput(ptyId: string, paneId: string, data: string, origin: PtyInputOrigin = 'user'): void {
    if (this.ptys.get(paneId) !== ptyId) return
    // v2.4: an `agent=` mark needs a user Enter just before it (never an automation's).
    if (origin === 'user' && this.shellKeys.has(paneId) && data.includes('\r')) this.enterAt.set(paneId, Date.now())
    const track = this.panes.get(paneId)
    if (!track) return
    // v2.3: real input from any device also acknowledges the console (its
    // done / error was seen); an automation's write ('auto') only invalidates.
    const acks = origin === 'user' && track.ackedSeq !== track.stateSeq
    if ((track.pending.size === 0 && !acks) || REPORTS_ONLY_RE.test(data)) return
    const before = this.attentionOf(track)
    const now = Date.now()
    let changed = false
    for (const entry of track.pending.values()) {
      if (entry.invalidated || entry.requestAt > now) continue
      entry.invalidated = true
      changed = true
    }
    if (acks) track.ackedSeq = track.stateSeq
    if (changed || before !== this.attentionOf(track)) this.publish(paneId, track)
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
      // v2.4: a `/rename X` names the session; it is not what the session is about.
      if (!track.firstPrompt && !RENAME_PROMPT_RE.test(evt.prompt.trim())) track.firstPrompt = firstLine(evt.prompt, LIMITS.title) || undefined
    }
    if (evt.firstPrompt && !track.firstPrompt) track.firstPrompt = firstLine(evt.firstPrompt, LIMITS.title) || undefined
    if (evt.reply) { track.reply = evt.reply; track.replyTurn = track.turnId }
    if (!evt.subagent && evt.model) track.model = evt.model
    if (!evt.subagent && evt.effort) track.effort = evt.effort
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
    return { provider, sessionId, retired: new Set(), precise: false, activity: 'idle', pending: new Map(), seen: new Set(), turnId: '', turn: 0, timer: null, updatedAt: now, ended: false, lastState: 'idle', stateSince: now, emittedAt: 0, detailTimer: null, subSessions: new Map(), waitTimer: null, lastHookAt: 0, interruptTimer: null, stateSeq: 0, ackedSeq: 0 }
  }
  private cancelTimer(track: PaneTrack): void { if (track.timer) clearTimeout(track.timer); track.timer = null }
  /** v2.4: clears the pane in `ms`, unless a clear already armed fires sooner. */
  private armClear(paneId: string, track: PaneTrack, ms: number): void {
    const at = Date.now() + ms
    if (track.timer && (track.clearAt ?? Infinity) <= at) return
    this.cancelTimer(track)
    track.clearAt = at
    track.timer = setTimeout(() => this.clearPane(paneId), ms)
  }
  private cancelDetail(track: PaneTrack): void { if (track.detailTimer) clearTimeout(track.detailTimer); track.detailTimer = null; track.deferredCause = undefined }
  /** Every timer of a track that is going away. */
  private stopTimers(track: PaneTrack): void {
    this.cancelTimer(track); this.cancelDetail(track)
    if (track.waitTimer) clearTimeout(track.waitTimer)
    if (track.interruptTimer) clearTimeout(track.interruptTimer)
    track.waitTimer = null; track.interruptTimer = null
    if (track.titleTimer) { clearTimeout(track.titleTimer); track.titleTimer = null }
  }
  private clearPane(paneId: string): void {
    const track = this.panes.get(paneId)
    if (!track) return
    this.stopTimers(track); this.panes.delete(paneId)
    this.releaseAttention(paneId)
    this.emit({ paneId, state: null, precise: false, notify: false })
  }
  /**
   * v2.2: what a finished turn still waits on, or undefined. Only a turn that
   * ended (done / idle) of a live session waits; expired pieces are dropped.
   */
  private waitingOf(track: PaneTrack, now = Date.now()): AgentWaiting | undefined {
    if (track.ended || (track.activity !== 'done' && track.activity !== 'idle')) return undefined
    for (const [sid, at] of track.subSessions) if (now - at >= SUB_SESSION_TTL_MS) track.subSessions.delete(sid)
    if (track.subSessions.size || (track.subEndedAt !== undefined && now - track.subEndedAt < SUB_SESSION_GRACE_MS)) return { kind: 'subsessions', count: track.subSessions.size }
    if (track.background?.waits && now - track.background.at < BACKGROUND_WAIT_TTL_MS) return { kind: 'background', count: track.background.waits }
    return undefined
  }
  /** Publishes again when the next piece of the wait expires (a sub-session TTL, the grace, the background TTL). */
  private armWait(paneId: string, track: PaneTrack): void {
    if (track.waitTimer) clearTimeout(track.waitTimer)
    track.waitTimer = null
    const now = Date.now()
    const due: number[] = [...track.subSessions.values()].map(at => at + SUB_SESSION_TTL_MS)
    if (track.subEndedAt !== undefined) due.push(track.subEndedAt + SUB_SESSION_GRACE_MS)
    if (track.background?.waits) due.push(track.background.at + BACKGROUND_WAIT_TTL_MS)
    const next = due.filter(t => t > now)
    if (!next.length) return
    track.waitTimer = setTimeout(() => {
      track.waitTimer = null
      if (this.panes.get(paneId) !== track) return
      this.publish(paneId, track)
      this.armWait(paneId, track)
    }, Math.min(...next) - now + 5)
  }
  private stateOfTrack(track: PaneTrack): ClaudePaneState {
    if (track.activity === 'error' || track.activity === 'unknown') return track.activity
    if (track.pending.size) return 'action'
    // v2.2: a turn waiting on work it started reads as working.
    return this.waitingOf(track) ? 'working' : track.activity
  }
  /**
   * v2.3: the console needs the user. `action` while some request was not
   * answered (invalidated by input), `done` / `error` until a device
   * acknowledged that transition; never for the other states.
   */
  private attentionOf(track: PaneTrack, state = this.stateOfTrack(track)): boolean {
    if (state === 'action') {
      for (const entry of track.pending.values()) if (!entry.invalidated) return true
      return false
    }
    return (state === 'done' || state === 'error') && track.ackedSeq !== track.stateSeq
  }
  private isFocused(): boolean {
    const win = this.getWindow()
    return !!win && !win.isDestroyed() && win.isFocused()
  }
  /** A device looks at the pane now: a focused desktop view or a phone. */
  private seenNow(paneId: string): boolean {
    if (this.viewed.has(paneId) && this.isFocused()) return true
    try { return this.remoteSeen(paneId) } catch { return false }
  }
  /** v2.3: the pane no longer asks for attention: its native toast closes, the flash stops with the last one. */
  private releaseAttention(paneId: string): void {
    const native = this.natives.get(paneId)
    if (native) {
      this.natives.delete(paneId)
      try { native.close() } catch { /* already gone */ }
    }
    if (this.flashing.delete(paneId) && this.flashing.size === 0) {
      const win = this.getWindow()
      if (win && !win.isDestroyed()) win.flashFrame(false)
    }
  }
  private event(paneId: string, track: PaneTrack, notify: boolean): PaneStatusEvt {
    const state = this.stateOfTrack(track)
    const evt: PaneStatusEvt = {
      paneId, provider: track.provider, precise: track.precise, notify, state,
      reason: track.activity === 'error' ? 'failure' : track.pending.values().next().value?.reason,
      pendingCount: track.pending.size, updatedAt: track.updatedAt, stateSince: track.stateSince,
      attention: this.attentionOf(track, state),
    }
    // v2.4: a shell console running a hand-typed agent (the saved type stays shell).
    if (this.runtimeAgents.has(paneId) && this.configProviderOf(paneId) === null) evt.hosted = true
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
    if (track.model) evt.model = track.model
    if (track.effort) evt.effort = track.effort
    if (track.ultracode !== undefined) evt.ultracode = track.ultracode
    const waiting = this.waitingOf(track)
    if (waiting) evt.waiting = waiting
    else if (state === 'done' && track.background?.other) evt.backgroundOther = track.background.other
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
  /** v2.4: the agent the pane's shell runs right now (shell marks), else the config's. */
  private providerOf(paneId: string): AgentProvider | null {
    return this.runtimeAgents.get(paneId) ?? this.configProviderOf(paneId)
  }
  /** effectiveProvider of the pane and its preset (same reading as resolveLaunch), or null. Cached per spawn; misses retried after 5 s. */
  private configProviderOf(paneId: string): AgentProvider | null {
    const cached = this.paneProviders.get(paneId)
    if (cached !== undefined) return cached
    if (Date.now() - (this.providerMisses.get(paneId) ?? -Infinity) < 5000) return null
    const cfg = this.getConfig()
    for (const ws of cfg?.workspaces ?? []) {
      const pane = ws.panes.find(p => p.id === paneId)
      if (!pane) continue
      const preset = pane.presetId ? cfg?.presets?.find(p => p.id === pane.presetId) : undefined
      const provider = effectiveProvider(pane, preset)
      this.paneProviders.set(paneId, provider)
      return provider
    }
    this.providerMisses.set(paneId, Date.now())
    return null
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
      track.stateSeq++
    }
    // v2.3: a done / error that lands while a device looks at the pane is already seen.
    if ((effective === 'done' || effective === 'error') && track.ackedSeq !== track.stateSeq && this.seenNow(paneId)) track.ackedSeq = track.stateSeq
    const fresh = !!key && !track.seen.has(key)
    if (key) { track.seen.add(key); if (track.seen.size > 512) track.seen.delete(track.seen.values().next().value!) }
    const evt = this.event(paneId, track, false), cfg = this.cfg
    if (fresh && state) {
      this.onNotice({ paneId, provider: track.provider, state, reason: evt.reason })
      const focused = this.getWindow()?.isFocused() ?? false
      const inView = this.viewed.has(paneId) && focused
      // v2.3: nothing to announce for a notice already seen (on a phone).
      evt.notify = !!cfg?.enabled && (state === 'done' ? cfg.notifyDone : cfg.notifyAction) && !inView && evt.attention !== false
      // E4-FR-07: with the window focused, the renderer shows an in-app card
      // instead of the OS notification (and never flashes the taskbar).
      evt.delivery = !evt.notify ? 'none' : focused && cfg?.inAppWhenFocused !== false ? 'inApp' : 'native'
      if (evt.delivery === 'native') this.showNotification(paneId, track, state)
    }
    if (!evt.attention) this.releaseAttention(paneId)
    // Only-detail changes are coalesced to one emission per 500 ms per pane
    // (E5-FR-02); state, pending, session and notifications go out at once.
    const signature = JSON.stringify([evt.state, evt.reason, evt.pendingCount, evt.pending?.map(p => p.id), evt.provider, evt.hosted, evt.precise, evt.sessionId, evt.cwd, evt.waiting, evt.attention, evt.model, evt.effort, evt.ultracode])
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
    const native = this.showNative(mainT(cfg, key, { pane, provider: track.provider === 'codex' ? 'Codex' : 'Claude' }), paneId)
    if (native) {
      // v2.3: kept until the pane's attention goes false. Not dropped on
      // 'close': on Windows a toast that timed out into the Action Center
      // fires it too, and only this reference can remove it from there.
      const prev = this.natives.get(paneId)
      this.natives.set(paneId, native)
      const forget = (): void => { if (this.natives.get(paneId) === native) this.natives.delete(paneId) }
      native.on('click', forget)
      native.on('failed', forget)
      if (prev) try { prev.close() } catch { /* already gone */ }
    }
    if (this.cfg?.flashTaskbar && win && !win.isFocused()) { win.flashFrame(true); this.flashing.add(paneId) }
  }
  private showNative(body: string, paneId?: string, title: string = BRAND.productName): Notification | null {
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
      return notification
    }
    this.desktopError = 'unavailable'
    return null
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
