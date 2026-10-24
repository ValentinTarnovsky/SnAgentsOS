/**
 * Remote-control wire protocol: message shapes exchanged over the embedded
 * WebSocket server between the desktop (main process) and phone clients.
 *
 * Pure types only - no zod, no Node, no DOM - because this file is bundled
 * into three targets: main, renderer and the mobile web client. Runtime
 * validation schemas live in remote-protocol-schemas.ts (main-only). It may
 * import only types.ts, git-types.ts, chat-types.ts, ws-notes.ts,
 * agentTune.ts, claude-accounts.ts, toolActivity.ts and failure.ts, all
 * import-free of Node and DOM.
 */
import type {
  AgentProvider,
  AgentWaiting,
  AttentionReason,
  ClaudePaneState,
  KeyButton,
  Language,
  PaneContext,
  PaneNeeds,
  PanePlan,
  PaneSilence,
  PaneType,
  QuickCommand,
  RemotePending,
  ScheduleRecurrence,
  ScheduleRunStatus,
  ThemeName,
  ThemeTokens,
  WorkspaceTaskState,
} from './types'
import type { GitArea, GitDiffHunk, GitFileEntry, RemoteGitChip } from './git-types'
import type { ChatFrameNotice, ChatMessage } from './chat-types'
import type { WsNoteError, WsNoteMeta } from './ws-notes'
import type { TuneSet } from './agentTune'
import type { ClaudeAccountRole, UsageActiveAccount } from './claude-accounts'
import type { ToolFamily } from './toolActivity'
import type { FailureInfo } from './failure'

export type { RemotePending, RemoteGitChip }

export const PROTOCOL_VERSION = 1

/**
 * WebSocket close codes used by the server. Only REVOKED tells the phone to
 * forget its stored secret; UNKNOWN_DEVICE may just mean a different desktop
 * instance answered (re-pair without wiping).
 */
export const REMOTE_CLOSE = {
  UNKNOWN_DEVICE: 4401,
  REVOKED: 4403,
  RATE_LIMITED: 4429,
} as const

/** `tailscaleHttps` (E3-FR-43): the `tailscale serve` origin of the secure mode, listed first. */
export type RemoteEndpointKind = 'lan' | 'tailscale' | 'other' | 'tailscaleHttps'

// --- State snapshot (desktop -> phone) ---

/**
 * Agent status of one pane as the phone sees it (E1-FR-03, CONTRATOS). Main
 * builds it from StatusManager and never copies the desktop-only fields
 * (sessionId, cwd, detail, topic, firstPrompt, cacheSince).
 */
export interface RemotePaneStatus {
  state: ClaudePaneState
  /** false = inferred from the OSC title (SSH or no hooks); absent = true. */
  precise?: boolean
  provider?: AgentProvider
  /** v2.4: a shell console running a hand-typed `claude` / `codex` (PaneStatusEvt.hosted). Absent = no. */
  hosted?: true
  reason?: AttentionReason
  pendingCount?: number
  /** Desktop clock (epoch ms) of the last state transition. */
  stateSince: number
  /** Last assistant reply, <= 280. */
  lastMessage?: string
  /** Current tool, <= 120. */
  activity?: string
  pending?: RemotePending[]
  /** v2.2: the agent waits on work it started; the state reads `working` meanwhile. */
  waiting?: AgentWaiting
  /** v2.3: main's derived attention (PaneStatusEvt.attention), false sent explicitly. Absent = older desktop. */
  attention?: boolean
  /**
   * v2.3 (agentTune): Claude's model (SessionStart, or the last tune applied
   * with Enter), <= 64, one line. Absent = unknown.
   */
  model?: string
  /** v2.3: Claude's effort level (every hook's effort.level, or the last tune), <= 16. */
  effort?: string
  /** v2.3: Ultracode as the last tune applied with Enter left it (no hook reports it). */
  ultracode?: boolean
  /**
   * app 2.4.0: Claude's answer menu as main reads it off the headless mirror
   * (PromptMenuWatcher), for the phone's Chat view, whose terminal stream is
   * paused. Only for a precise Claude console with a pending plan or
   * permission that some phone watches, and only once the menu validates for
   * that kind (planOptions / alwaysOption). `for` is the pending id it
   * belongs to; at most 9 options, labels cleaned and <= 160. Absent = no
   * validated menu (or an older desktop).
   */
  menu?: RemotePaneMenu
  // --- app 2.7.0 (A3); absent = none, or an older desktop ---
  /** Family of the newest tool still open (`activity` is its summary). */
  toolFamily?: ToolFamily
  /** Why the last turn failed (`until` only for a limit with a known reset); cleared by the next `working`. */
  failure?: FailureInfo
  /** A working agent with no signal since `since`: `quiet` after quietMin, `stalled` after stalledMin. */
  silence?: PaneSilence
  /** Open `snaos needs` request (text <= NEEDS_TEXT_MAX, one line): attention without `pending`. */
  needs?: PaneNeeds
  /** Muted by the user until the effective state changes. Main publishes only `true`; absent = not muted (or an older desktop). */
  muted?: boolean
  /**
   * App 2.7.0 (A3): minimal status of a console with no agent track that only
   * carries `needs`; the phone shows the request and no agent state. Absent =
   * a real status (or an older desktop).
   */
  bare?: true
  /**
   * App 2.7.0 (A4): how full the agent's context is (ConsoleLedger), always
   * an estimate; `exact` for Codex, approximate for Claude. Refreshed once per
   * turn for Claude (its done) and on every model call for Codex
   * (thread/tokenUsage/updated), always inside the detail throttle. The token
   * and cost `usage` stays on the desktop. Absent = unknown.
   */
  context?: PaneContext
}

/** app 2.4.0: RemotePaneStatus.menu. */
export interface RemotePaneMenu {
  for: string
  options: Array<{ n: number; label: string }>
}

export interface RemotePaneInfo {
  id: string
  title: string
  type: PaneType
  color: string
  icon: string
  /** True when a live pty is bound to this pane (authoritative in main). */
  running: boolean
  /**
   * Agent pane without a Connection Profile whose last session can be resumed
   * (D10, computed in the renderer's remoteSnapshot). Absent = hide "Relaunch
   * resuming" and "New chat".
   */
  resumable?: boolean
  /**
   * Exit code of a console whose shell ended on its own (E6-FR-38), overlaid
   * by main like `running`; absent while running or never started.
   */
  exitCode?: number
  /**
   * The pane's Claude session ended with /exit (or its Codex quit, v2.2) and
   * the desktop offers the "<agent> exited [Resume] [New]" chip (E6-FR-24,
   * renderer-computed, absent with the chip setting off). `canResume` false =
   * only [New] (unsafe id or command); `provider` absent = Claude. The phone
   * mirrors it with `agentResume`.
   */
  agentEnded?: { canResume: boolean; provider?: AgentProvider }
  /** Agent status overlaid by main on every state / authOk (E1-FR-03). */
  status?: RemotePaneStatus
  /**
   * E8-FR-19 (v3.1, R31-00): the console's `snaos status` line, <= 120 and
   * one line, from the renderer's transient statusLineStore. Absent = none.
   */
  statusLine?: string
}

export interface RemoteWorkspaceInfo {
  id: string
  name: string
  /** Pane ids in display order (grid placement). */
  layoutOrder: string[]
  panes: RemotePaneInfo[]
  /** Git chip of the workspace cwd (E7-FR-09). Omitted without a repo, on error or with settings.gitChip off. */
  git?: RemoteGitChip
  /** E8-FR-11 (v3.1, R31-00): the workspace note (`workspaces[].note`, <= 140). Absent = none. */
  note?: string
  /** E8-FR-11 (v3.1, R31-00): the user task state (`workspaces[].taskState`). Absent = none. */
  taskState?: WorkspaceTaskState
}

/**
 * E8-FR-32 (v3.1, R31-00): one console schedule as the phone's Automations
 * section shows it. Read-only mirror of one entry of `pane.schedules` with
 * the absent fields resolved; it never carries the prompt text (the phone can
 * only toggle it and run it now, never edit it). App 2.7.0: one info per
 * schedule, so a console with several sends several.
 */
export interface RemoteScheduleInfo {
  workspaceId: string
  paneId: string
  /**
   * App 2.7.0: the schedule's id within the pane (`s1`..`s999`), echoed in
   * scheduleRun / scheduleToggle. Absent = an older desktop (one per console).
   */
  scheduleId?: string
  /** "HH:MM" wall-clock time the user picked, on the desktop clock (not used by a `cron` rule). */
  time: string
  /**
   * Repeat rule; an absent `recurrence` travels as `{ kind: 'once' }`. A
   * `cron` rule travels as is, and also in `cron` below.
   */
  recurrence: ScheduleRecurrence
  /**
   * App 2.7.0: the cron expression of a `cron` rule (the same text as
   * `recurrence.expr`), absent otherwise. A phone older than 2.7.0 reads
   * neither and shows the rule as a one-shot.
   */
  cron?: string
  /** Epoch ms of the next run (desktop clock). Meaningless while `enabled` is false. */
  dueAt: number
  /** The Active switch (`schedule.enabled`, absent = true). */
  enabled: boolean
  /** Wait for the agent to be free before sending (`schedule.waitIdle`, absent = true). */
  waitIdle: boolean
  /** Most recent run of `schedule.history`, if any. */
  lastRun?: { at: number; status: ScheduleRunStatus; trigger: 'scheduled' | 'manual' }
  /** A "Run now" (desktop or phone) is waiting for the agent; nothing was sent yet. */
  runPending?: boolean
}

/**
 * One usage bar as seen by the phone. Structural mirror of the desktop's
 * `UsageRow` (ipc-contract.ts), duplicated here to keep this wire protocol
 * self-contained (ipc-contract imports THIS file, so it can't be imported back).
 */
export interface RemoteUsageRow {
  id: string
  provider: 'claude' | 'codex' | 'custom'
  kind: '5h' | '7d' | 'custom'
  /** Resolved display label (model name for custom rows). */
  label: string
  /** 0..100 quota utilization, or null for a custom row with no token budget. */
  percent: number | null
  /** Absolute tokens used (custom rows). */
  used?: number
  /** Token budget (custom rows with a configured budget). */
  limit?: number
  /** ISO-8601 reset time, when the source provides one. */
  resetsAt?: string | null
  /** Subscription/plan label (Codex: plus/pro/...). */
  planType?: string | null
  status: 'ok' | 'expired' | 'error' | 'nodata' | 'loading'
  /** True when the desktop is holding the last good value through a failed poll. */
  stale?: boolean
  /** Custom rows whose transcript scan has not caught up yet (the phone does not show it). */
  partial?: boolean
}

/** Snapshot of the desktop's live usage bars, mirrored to the phone. */
export interface RemoteUsageSnapshot {
  rows: RemoteUsageRow[]
  /** Epoch ms the snapshot was produced. */
  updatedAt: number
  /** Anthropic service health, when the status dot is enabled. */
  services?: 'operational' | 'degraded' | 'down' | null
  /**
   * app 2.3.0: the active Claude account (label and role, never the email); absent = no saved accounts or an older desktop.
   * app 2.4.0: plus its rank and `others` (every other saved account by priority, for the picker).
   */
  activeAccount?: UsageActiveAccount
}

/** An agent preset as the phone's console picker shows it (E2-FR-10/12). */
export interface RemotePresetInfo {
  id: string
  name: string
  type: PaneType
  icon: string
  color: string
}

/** Compact mirror of the desktop state, pushed to every authed phone. */
export interface RemoteStateSnapshot {
  workspaces: RemoteWorkspaceInfo[]
  activeWorkspaceId: string | null
  /** Resolved flat theme tokens (base theme + custom overrides). */
  themeTokens: ThemeTokens
  /** Named theme id (undefined for older desktops mid-upgrade). */
  themeName?: ThemeName
  language: Language
  fontFamily: string
  fontSize: number
  /**
   * Quick Commands (E8-FR-07, replaces `snippets`): globals and every
   * workspace's own. The phone runs them by id (`runQuickCommand`); the
   * desktop resolves the text.
   */
  quickCommands?: QuickCommand[]
  /** Custom phone KeyBar buttons. */
  keyButtons?: KeyButton[]
  /** Live usage bars (undefined/null when the usage widget is off). */
  usage?: RemoteUsageSnapshot | null
  /** xterm unicode width table the desktop uses (E6-FR-15); absent = '6'. */
  terminalUnicode?: '6' | '11'
  /** Agent presets in their desktop order, for the phone's console picker (E2-FR-10/12). */
  presets?: RemotePresetInfo[]
  /** os.hostname() of the desktop, injected by main into every snapshot it emits (E2-FR-02/12). */
  hostName?: string
  /**
   * Workspaces fully mounted on the desktop (D4: the 'full' keys of
   * mountedWorkspaces). Opening a stopped pane of any other workspace asks the
   * phone to confirm `mountWorkspace` first (E2-FR-06/12).
   */
  mountedWorkspaceIds?: string[]
  /**
   * E8-FR-32 (v3.1, R31-00): every console with a schedule, in sidebar order
   * (workspaces, then panes; app 2.7.0: then the pane's schedules in their
   * stored order). Absent = an older desktop; `[]` = none.
   */
  schedules?: RemoteScheduleInfo[]
}

// --- Session history (E3-FR-36..40) ---

/** One session of historyRes: a Claude transcript or a Codex rollout on the PC. */
export interface RemoteHistorySession {
  provider: AgentProvider
  sessionId: string
  /** Directory the session ran in; a resumed console starts there. */
  cwd: string
  /** Custom title, else Claude's summary, else the first real prompt cut to 60. */
  title: string
  /** Epoch ms of its last record. */
  updatedAt: number
  /**
   * Amendment (E3-FR-38): the console that already holds this session, so the
   * phone offers "Go to the console" instead of a second resume.
   */
  paneId?: string
}

// --- Control actions (phone -> desktop, executed by the renderer) ---

export type RemoteCtlAction =
  | { kind: 'switchWorkspace'; workspaceId: string }
  /**
   * `prompt` (E2-FR-11, <= 16384): initial prompt of a claude/codex preset,
   * delivered only through the SNAOS_INITIAL_PROMPT variable. When that is not
   * possible the console opens without it and the ack says `promptFallback`.
   *
   * `resume` (E3-FR-39): resume a session of the history in a new local
   * console. Main checks the id against SessionHistory first (else ack
   * `notFound`); the cwd comes from main's index, never from the phone. A
   * console that already holds the session acks its own id instead.
   */
  | {
      kind: 'createPane'
      workspaceId: string
      presetId?: string
      paneType?: PaneType
      prompt?: string
      resume?: { provider: AgentProvider; sessionId: string }
    }
  | { kind: 'closePane'; workspaceId: string; paneId: string }
  /**
   * `resume` (E4/E5-FR-11): true = relaunch resuming the chat, false = new chat
   * (forgets the session), absent = the header restart button's rule (old bundles).
   */
  | { kind: 'restartPane'; workspaceId: string; paneId: string; resume?: boolean }
  | { kind: 'globalPrompt'; workspaceId: string; text: string }
  | { kind: 'setTheme'; theme: ThemeName }
  | { kind: 'renamePane'; workspaceId: string; paneId: string; title: string }
  /**
   * E8-FR-07: run a Quick Command by id. `send` needs `paneId` (the console
   * open on the phone; never the desktop's focus) and answers `not_running`
   * without a live pty; `agent` creates the console in `workspaceId` without
   * activating it and acks its id. The command must be global or scoped to
   * `workspaceId`, else `not_found`.
   */
  | { kind: 'runQuickCommand'; workspaceId: string; paneId?: string; id: string }
  // --- E2 Home (R22-14) ---
  /** Mount every console of a workspace without activating it (E2-FR-06). */
  | { kind: 'mountWorkspace'; workspaceId: string }
  /** "Show on the PC": restore and focus the window, then reveal the pane (E2-FR-07). */
  | { kind: 'revealPane'; paneId: string }
  /**
   * E2-FR-29/30: a path tapped in the phone terminal. The renderer resolves the
   * root from its own store (the pane's launch cwd, then `ws.cwd`) and main
   * opens an inert file or reveals it. Ack errors: denied_path, not_found, rate.
   */
  | { kind: 'openPath'; workspaceId: string; paneId: string; path: string }
  /** E2-FR-28: open a link on the PC (http, https or mailto only, <= 2048; else ack denied_url). */
  | { kind: 'openUrl'; url: string }
  /**
   * E6-FR-24: the phone's [Resume] / [New] of the "Claude exited" strip. The
   * renderer types the same text as the desktop chip; the first action of any
   * device clears the offer and the rest ack `stale`. Other errors: not_found
   * (pane outside workspaceId), no_resume, not_running.
   */
  | { kind: 'agentResume'; workspaceId: string; paneId: string; mode: 'resume' | 'new' }
  // --- E3 M11 phone-fit (R30-04) ---
  /**
   * E3-FR-14/20: the phone sizes the pty to its own grid (cols 20..500, rows
   * 8..300). Main records the owner (FitController) before the executor
   * applies it; acks: disabled (settings.remote.phoneFit off, plus a
   * fitState desktop), notSubscribed (the session does not watch the pane),
   * not_running (no live pty to size), rate.
   */
  | { kind: 'fitPane'; workspaceId: string; paneId: string; cols: number; rows: number }
  /** E3-FR-18: give the size back to the desktop (its latest baseline). */
  | { kind: 'releaseFit'; paneId: string }
  /**
   * E7-FR-25: review notes written on the phone, sent inline (never stored in
   * the desktop's ReviewNoteStore). The renderer formats and pastes them like
   * the desktop's own send; ack `info` = notes sent. Errors: not_found,
   * no_pty, not_agent (plain console, or `enter` on a non-agent one),
   * no_notes, too_large (over 50 notes or 32KB of text).
   */
  | { kind: 'sendReviewNotes'; workspaceId: string; paneId: string; notes: Array<{ file: string; lines: string; comment: string }>; enter: boolean }
  // --- E8-FR-32 phone Automations (v3.1, R31-00) ---
  /**
   * "Run now": the same path as the desktop's button, so the next run
   * (`dueAt`) never moves and the phone sends no text (the desktop uses the
   * stored prompt). Idempotent while a run waits (ack ok, `info: 'pending'`).
   * Ack errors: not_found (pane outside workspaceId), no_schedule (no
   * schedule or an empty prompt), rate (per-session bucket, E3-FR-03).
   * App 2.7.0: `scheduleId` names one of the pane's schedules (an unknown id
   * is no_schedule); absent = the pane's first schedule (an older phone).
   */
  | { kind: 'scheduleRun'; workspaceId: string; paneId: string; scheduleId?: string }
  /**
   * The Active switch: pauses without deleting; turning it on re-arms the
   * next run like the desktop switch. Ack errors: not_found, no_schedule,
   * rate. `scheduleId` as in scheduleRun.
   */
  | { kind: 'scheduleToggle'; workspaceId: string; paneId: string; enabled: boolean; scheduleId?: string }
  // --- app 2.3.0: model, effort and Ultracode from the phone ---
  /**
   * One allowlisted slash command (tuneCommand) into the agent console:
   * Claude takes model / effort / ultracode, Codex only `picker` (`/model`).
   * `enter` only with the phone's "Apply with Enter" switch: then the agent
   * must be precise and at rest (tuneReady) with nothing unsent in its input
   * box (checked in main), else ack `busy` and nothing is written. Errors:
   * not_found, not_agent, unsupported, busy, not_running, rate. The phone
   * sends it only to a desktop >= 2.3.0 (an older one strikes the kind).
   */
  | { kind: 'agentTune'; workspaceId: string; paneId: string; set: TuneSet; enter: boolean }
  /**
   * app 2.3.0: switch the Claude login to the saved account of that role
   * (reason `phone`). Rate limited, plus 3 per minute per device in main.
   * Errors: not_found, locked, unknown_live_account, identity_failed, busy,
   * unsupported, encryption_unavailable, io, rate.
   * The phone sends it only to a desktop >= 2.3.0.
   * app 2.4.0: by `id` (an account of `usage.activeAccount.others`), only
   * to a desktop >= 2.4.0; `role` stays accepted (rank 0 / 1). Exactly one
   * of the two (the executor answers `bad_target` otherwise).
   */
  | { kind: 'claudeAccountUse'; role?: ClaudeAccountRole; id?: string }
  /**
   * app 2.4.0: pick option `n` of Claude's answer menu from the phone's Chat
   * view (a Plan card option, "Always allow"). Handled in main
   * (SessionManager.handleCtl): it re-reads the screen off the headless
   * mirror and writes only the digit, never Enter, when `pendingId` is still
   * pending and option `n` still reads `label`. Acks: stale (the request is
   * gone), no_menu (no menu can be read: no live pty, snapshotMode 'off', or
   * none drawn), menu_changed (option n is missing or reads otherwise),
   * denied, rate. The phone sends it only to a desktop >= 2.4.0.
   */
  | { kind: 'answerMenu'; paneId: string; pendingId: string; n: number; label: string }
  // --- app 2.7.0 (A3): status marks, handled in main ---
  /**
   * Mark a done / error console read from the phone (the desktop's "Marcar
   * leido"). Handled in main (SessionManager.handleCtl -> StatusManager);
   * never relayed. Acks: not_found (unknown console, or neither done nor
   * error), denied, rate. The phone sends it only to a desktop >= 2.7.0.
   */
  | { kind: 'markRead'; paneId: string }
  /**
   * Mute the console until its effective state changes (`muted: false` lifts
   * it). Handled in main; never relayed. Acks: not_found (unknown console),
   * denied, rate. The phone sends it only to a desktop >= 2.7.0.
   */
  | { kind: 'mutePane'; paneId: string; muted: boolean }
  /**
   * Ignore the silence (quiet / stalled) of the rest of this turn, shown or
   * not yet; the next turn is watched again. Handled in main; never relayed.
   * Acks: not_found (unknown or title-only console), denied, rate. The phone
   * sends it only to a desktop >= 2.7.0.
   */
  | { kind: 'silenceAck'; paneId: string }

// --- Git API for the phone's Changes screen (E7-FR-22..26) ---

/** Why a `gitReq` got no data. `rate`: over 10 per 5s or 2 in flight per session. */
export interface RemoteGitError {
  error: 'not_found' | 'not_repo' | 'git_missing' | 'git_old' | 'unsafe_repo' | 'too_large' | 'rate' | 'timeout' | 'git_error'
}

/**
 * One page of the workspace's change list (E7-FR-22). Every page repeats the
 * summary; `total` counts the whole list, `truncated` = git listed over 5000
 * entries. Paths are relative to the repo; the repo root never travels.
 */
export interface RemoteGitChanges {
  summary: RemoteGitChip & { approx: boolean; conflicts: number; op: 'merge' | 'rebase' | 'cherry-pick' | null }
  files: GitFileEntry[]
  total: number
  truncated: boolean
}

/**
 * One page of a file's diff (E7-FR-23). Every page of one read carries the
 * same `diffRev`; a different one means the file changed and the phone starts
 * again at page 0. A hunk cut at a page edge goes on in the next page with its
 * header repeated and `continued: true`.
 */
export interface RemoteGitDiffPage {
  path: string
  oldPath?: string
  area: GitArea
  diffRev: string
  binary: boolean
  tooLarge?: { lines: number }
  hunks: GitDiffHunk[]
}

/** The request half of `gitReq` (without the envelope). `gitReq` has no paneId: the target is `ws:<workspaceId>`. */
export interface RemoteGitRequest {
  workspaceId: string
  op: 'status' | 'diff'
  path?: string
  staged?: boolean
  page?: number
}

/** The answer half of `gitRes` (without the envelope), at most 48KB once framed. */
export interface RemoteGitReply {
  ok: boolean
  data: RemoteGitChanges | RemoteGitDiffPage | RemoteGitError
  page: number
  done: boolean
}

// --- Workspace notes for the phone (v2.2, E9) ---

/** The request half of `notesReq`: a workspace the desktop has, and a note of it by id. */
export interface RemoteNotesRequest {
  workspaceId: string
  op: 'list' | 'read' | 'write' | 'create' | 'delete'
  noteId?: string
  /** write / create, <= WS_NOTE_PHONE_MAX. */
  text?: string
  /** write: the rev the phone loaded; another one on the PC is a conflict. */
  baseRev?: string
}

/** A note as the phone gets it: never its path; past WS_NOTE_PHONE_MAX only its start, read-only. */
export interface RemoteNote extends WsNoteMeta {
  text?: string
  readOnly?: boolean
}

/** The answer half of `notesRes`, <= 48KB once framed. */
export interface RemoteNotesReply {
  ok: boolean
  error?: WsNoteError
  notes?: WsNoteMeta[]
  note?: RemoteNote
  /** conflict: the note as it is now on the PC. */
  current?: RemoteNote
}

// --- Full ExitPlanMode plan for the phone (app 2.7.0, A3) ---

/** The request half of `planReq`: a console's plan by request id, or its newest one. */
export interface RemotePlanRequest {
  paneId: string
  requestId?: string
}

/**
 * Why a `planRes` carries no plan. `not_found`: unknown console or no plan
 * for it; `rate`: over PLAN_REQ_MAX per window or PLAN_REQ_IN_FLIGHT waiting.
 * `unsupported` never travels: the phone answers it to itself for a desktop
 * older than 2.7.0, which would strike an unknown frame.
 */
export type RemotePlanError = 'not_found' | 'rate' | 'unsupported'

/**
 * The answer half of `planRes`, < 40KB once framed: main cuts `plan.text`
 * further when its JSON would not fit (then `truncated: true`).
 */
export interface RemotePlanReply {
  ok: boolean
  plan?: PanePlan
  error?: RemotePlanError
}

// --- Client -> server messages ---

export type RemoteClientMsg =
  | { v: number; type: 'hello'; deviceId?: string; clientNonce: string }
  | { v: number; type: 'pair'; code: string; deviceName: string }
  | { v: number; type: 'auth'; deviceId: string; hmac: string }
  | { v: number; type: 'sub'; paneId: string }
  | { v: number; type: 'unsub'; paneId: string }
  /**
   * app 2.5.0: `submit` marks a lone `\r` that submits text this client just
   * pasted: main writes it SUBMIT_DELAY_MS after the pty's last write, so an
   * agent that debounces a paste (Codex on Windows) takes it as Enter, not as
   * a newline inside the paste. Ignored on any other data.
   */
  | { v: number; type: 'input'; paneId: string; data: string; submit?: boolean }
  | { v: number; type: 'ctl'; id: string; action: RemoteCtlAction }
  | { v: number; type: 'ping'; t: number }
  /** The page became visible/hidden, and once after authOk (E2-FR-52: ntfy quiet while watched). */
  | { v: number; type: 'visibility'; visible: boolean }
  /** E3-FR-36: the session history filtered by `query`; with `workspaceId` = "This workspace". */
  | { v: number; type: 'historyReq'; id: string; query?: string; workspaceId?: string }
  /** E7-FR-22/23: one page of the change list or of a file's diff; answered by `gitRes` with the same id. */
  | ({ v: number; type: 'gitReq'; id: string } & RemoteGitRequest)
  /** v2.2 (E9): the workspace's .md notes; answered by `notesRes` with the same id. */
  | ({ v: number; type: 'notesReq'; id: string } & RemoteNotesRequest)
  /** app 2.7.0 (A3): the full plan of an ExitPlanMode request; answered by `planRes` with the same id. */
  | ({ v: number; type: 'planReq'; id: string } & RemotePlanRequest)
  // --- E3 M12 Chat view (R30-05) ---
  /** E3-FR-25: read the pane as a chat; answered by a first `chatPage`. */
  | { v: number; type: 'chatSub'; paneId: string }
  | { v: number; type: 'chatUnsub'; paneId: string }
  /** E3-FR-26: the page before `before` (the `cursor` of the oldest page held, a byte offset). */
  | { v: number; type: 'chatMore'; paneId: string; before: string }

// --- Server -> client messages ---

export type RemotePairDeniedReason = 'denied' | 'expired' | 'badCode' | 'limit'
export type RemoteAuthFailReason = 'unknownDevice' | 'badHmac' | 'locked'
export type RemoteErrCode = 'bad_msg' | 'unauthorized' | 'version' | 'rate'

export type RemoteServerMsg =
  | {
      v: number
      type: 'challenge'
      /** Server nonce the client must HMAC with the device secret. */
      nonce: string
      /**
       * Mutual auth: HMAC(secret, clientNonce) proving the server knows the
       * device secret. The client MUST verify this before sending its own
       * HMAC. Absent during pairing (no secret exists yet).
       */
      proof?: string
    }
  | { v: number; type: 'pairPending' }
  | {
      v: number
      type: 'paired'
      deviceId: string
      /** The only time the shared secret ever travels. */
      secret: string
    }
  | { v: number; type: 'pairDenied'; reason: RemotePairDeniedReason }
  | {
      v: number
      type: 'authOk'
      deviceId: string
      state: RemoteStateSnapshot
      /** Desktop OS (drives e.g. xterm windowsPty on the phone). */
      hostPlatform: string
      appVersion: string
      /**
       * E3-FR-01: per-session Bearer for the HTTP routes (64 hex, dies with
       * the socket or the device). Absent = an older desktop: no image button.
       */
      httpToken?: string
      /** E3-FR-01: public VAPID key, only while https is on. Absent = no "Enable notifications". */
      pushKey?: string
      /**
       * E3-FR-43 (R30-07 amendment): `https://<machine>.<tailnet>.ts.net` while
       * the secure mode is on. A phone on the http origin offers it in a card.
       */
      secureUrl?: string
    }
  | { v: number; type: 'authFail'; reason: RemoteAuthFailReason; retryAfterMs?: number }
  | { v: number; type: 'state'; state: RemoteStateSnapshot }
  | {
      v: number
      type: 'replay'
      paneId: string
      /** False = pane exists but no live pty yet (lazy spawn pending). */
      running: boolean
      data: string
      cols: number
      rows: number
      /** With running:false: the pty ended on its own and `data` is its last output (E6-FR-20). */
      exitCode?: number
    }
  | { v: number; type: 'out'; paneId: string; data: string }
  | { v: number; type: 'exit'; paneId: string; exitCode: number }
  /** Live agent status change, straight from main (E1-FR-03); null clears it. */
  | { v: number; type: 'paneStatus'; paneId: string; status: RemotePaneStatus | null }
  /**
   * E3-FR-12: every effective pty resize, to each phone subscribed to the
   * pane. `owner` says who sized it; it never names the device (FR-16).
   */
  | { v: number; type: 'fitState'; paneId: string; owner: 'phone' | 'desktop'; cols: number; rows: number }
  | {
      v: number
      type: 'ctlAck'
      id: string
      ok: boolean
      error?: string
      /** createPane: id of the new pane so the phone can auto-subscribe. */
      paneId?: string
      /** globalPrompt: number of consoles the text was sent to. */
      info?: number
      /**
       * createPane with `prompt`: the console opened without it (E2-FR-11);
       * the phone keeps the text in that console's composer draft.
       */
      promptFallback?: boolean
    }
  | { v: number; type: 'revoked' }
  | { v: number; type: 'shutdown'; reason: 'quit' | 'disabled' }
  | { v: number; type: 'pong'; t: number }
  | { v: number; type: 'err'; code: RemoteErrCode; msg?: string }
  /** E3-FR-37: answer to historyReq, newest first, at most 100 sessions and 48KB. */
  | { v: number; type: 'historyRes'; id: string; sessions: RemoteHistorySession[] }
  /** E7-FR-22..26: the answer to one `gitReq`, each frame <= 48KB. */
  | ({ v: number; type: 'gitRes'; id: string } & RemoteGitReply)
  /** v2.2 (E9): the answer to one `notesReq`. */
  | ({ v: number; type: 'notesRes'; id: string } & RemoteNotesReply)
  /** v2.2 (E9): a note of the workspace changed on the PC or on another phone. */
  | { v: number; type: 'notesChanged'; workspaceId: string; noteId?: string }
  /** app 2.7.0 (A3): the answer to one `planReq`, < 40KB. */
  | ({ v: number; type: 'planRes'; id: string } & RemotePlanReply)
  /**
   * E3-FR-26/30/33: a page of the pane's chat, oldest first, <= 48KB. One that
   * arrives without a chatMore pending is a first page and replaces the list
   * (reset after /clear, a resume or a truncated file). `cursor` = byte offset
   * of its first line (null with nothing before); a lone notice block = no chat.
   * app 2.7.0 (A7): optional `notice` (ChatFrameNotice), see chatAppend.
   */
  | { v: number; type: 'chatPage'; paneId: string; items: ChatMessage[]; cursor: string | null; done: boolean; notice?: ChatFrameNotice }
  /**
   * E3-FR-30: messages written to the transcript since, <= 48KB per frame.
   * app 2.7.0 (A7): `notice: 'paused'` on an empty one = the PC closed this
   * chat's watcher for another one; nothing more comes until a new chatSub.
   */
  | { v: number; type: 'chatAppend'; paneId: string; items: ChatMessage[]; notice?: ChatFrameNotice }
