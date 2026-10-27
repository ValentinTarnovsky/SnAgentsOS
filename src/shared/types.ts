/**
 * Core domain model, shared by main and renderer.
 * Must stay free of Node/DOM imports so it is safe in the renderer bundle.
 */
import type { PaneWorktree } from './worktree-types'
import type { LabsSettings } from './labs'
import type { SidebarBlocksSettings } from './sidebarBlocks'
import type { ToolFamily, TurnDigest } from './toolActivity'
import type { FailureInfo } from './failure'

export type { PaneWorktree }

/**
 * Persisted config schema version. Single source of truth for both the main
 * process (schema/migrations) and the renderer (persistence writer).
 */
export const CONFIG_VERSION = 20

export type PaneType = 'shell' | 'claude' | 'codex' | 'custom'

/**
 * One step of a pre-launch sequence (expect/send). The runner sends `send`,
 * optionally waiting for the terminal to print `waitFor` first, this is how a
 * console can auto-answer an interactive prompt (e.g. send a password right
 * after the shell prints "password:").
 */
export interface SetupStep {
  /** Text written to the shell. A CR (Enter) is appended unless `noEnter`. */
  send: string
  /**
   * Wait until the terminal output contains this string before sending.
   * Wrap in slashes for a regex, e.g. "/\\$\\s*$/". Empty = send immediately.
   */
  waitFor?: string
  /** Max ms to wait for `waitFor` before sending anyway. Default 15000. */
  timeoutMs?: number
  /** Fixed pause (ms) applied right before sending (after any `waitFor`). */
  delayMs?: number
  /** Treat `send` as a secret (password): masked in the UI. */
  secret?: boolean
  /** Send `send` literally without appending Enter/CR. */
  noEnter?: boolean
}

/**
 * A reusable pre-launch sequence (e.g. "SSH into the dedi") applied to a
 * console before its model command runs. Defined in Settings, selected when a
 * workspace is created, and applied to every console in that workspace.
 */
export interface ConnectionProfile {
  id: string
  name: string
  steps: SetupStep[]
}

/**
 * How a pane schedule repeats (E8-FR-28, schema 13). Absent = `once`.
 * `weekly.days`: 0 = Sunday .. 6 = Saturday, 1..7 distinct entries; `hourly`
 * takes the minute from `PaneSchedule.time`. `cron` (app 2.7.0, schema 19):
 * a 5-field expression in local time (`src/shared/cron.ts`), at least 15
 * minutes between runs and with a next run; `PaneSchedule.time` is not used.
 */
export type ScheduleRecurrence =
  | { kind: 'once' }
  | { kind: 'daily' }
  | { kind: 'weekdays' }
  | { kind: 'weekly'; days: number[] }
  | { kind: 'hourly' }
  | { kind: 'cron'; expr: string }

/** Outcome of one schedule run (E8-FR-31, schema 13). */
export type ScheduleRunStatus = 'sent' | 'sent_unconfirmed' | 'skipped_busy' | 'missed' | 'failed'

/** One entry of a pane schedule's run history (E8-FR-31, schema 13). */
export interface ScheduleRun {
  /** Epoch ms of the run. */
  at: number
  /** Epoch ms of the occurrence it served. */
  scheduledFor: number
  trigger: 'scheduled' | 'manual'
  status: ScheduleRunStatus
  /**
   * `enter_held` (post 2.6.0, `userGate`): the agent started waiting on the
   * user after the text was typed, so the Enter was dropped (text left typed).
   */
  reason?: 'agent_not_running' | 'multiline_unsafe' | 'not_delivered' | 'enter_held'
}

/**
 * A prompt scheduled to run in a single console at a wall-clock time. The
 * renderer ticker writes `prompt` (then Enter) into the pane once `dueAt` is
 * reached, using the local PC clock. Without `recurrence` it is one-shot and
 * cleared after firing. Schema 13 adds the optional automation fields (they
 * replace the contract's top-level `automations`, R30-01 amendment); an old
 * schedule without them keeps its one-shot behavior. Schema 19 (app 2.7.0):
 * a console holds several, each with its own `id`, in `Pane.schedules`.
 */
export interface PaneSchedule {
  /**
   * `s1`..`s999` (`SCHEDULE_ID_RE`, src/shared/schedule.ts), unique within
   * the pane (schema 19). The single schedule of schema <= 18 becomes `s1`.
   */
  id: string
  /** "HH:MM" wall-clock time the user picked (for display/editing; unused by a `cron` rule). */
  time: string
  /** Prompt text sent into the console (Enter appended) when it fires. */
  prompt: string
  /** Epoch ms of the next occurrence; the ticker fires when Date.now() >= dueAt. */
  dueAt: number
  /** Repeat rule (schema 13). Absent = `{ kind: 'once' }`. */
  recurrence?: ScheduleRecurrence
  /** Wait for the agent to be free before sending (schema 13). Absent = true. */
  waitIdle?: boolean
  /** Paused when false (schema 13). Absent = true. */
  enabled?: boolean
  /** Epoch ms since the run waits for a busy agent; persisted to survive reloads (schema 13). */
  waitingSince?: number
  /** Last runs, at most 20 (schema 13). */
  history?: ScheduleRun[]
}

export interface Pane {
  id: string
  type: PaneType
  /** Reference to an AgentPreset; when set, preset fields are merged in. */
  presetId?: string
  /** Overrides the workspace cwd for this pane. */
  cwd?: string
  /** Overrides the resolved shell/command for this pane. */
  command?: string
  /** Per-pane connection profile override (falls back to the workspace's). */
  setupId?: string
  title: string
  color: string
  icon: string
  /** Per-pane terminal font size override (Ctrl +/-/0, Ctrl+wheel). */
  fontSize?: number
  /**
   * Prompts scheduled to run in this console (schema 19, app 2.7.0): at most
   * `PANE_SCHEDULES_MAX` (8), ids unique, each run on its own. Replaces the
   * single `schedule` of schema <= 18, which migrate() turns into
   * `[{ id: 's1', ...schedule }]` and never writes again.
   */
  schedules?: PaneSchedule[]
  /**
   * Last agent session seen in this console (schema 11). A mirror written by
   * the renderer; main's agent-sessions.json is the source of truth and only
   * seeds from this when that file is missing or corrupt.
   */
  lastSession?: PaneLastSession
  /** Isolated worktree this console runs in (schema 13, E7-FR-28); its path is also `cwd`. */
  worktree?: PaneWorktree
}

/** Agent session mirrored onto a pane so it can be resumed later (schema 11). */
export interface PaneLastSession {
  provider: AgentProvider
  sessionId: string
  /** Directory the agent was spawned in. */
  cwd: string
  /** Epoch ms of the status update that carried the session id. */
  at: number
}

/** Number of terminals in a workspace grid; maps to a fixed CSS grid template. */
export type GridPreset = 1 | 2 | 4 | 6 | 8 | 10 | 12

/** Simple, human-readable layout descriptor (replaces dockview's opaque blob). */
export interface WorkspaceLayout {
  grid: GridPreset
  /** Pane ids in display order (cell placement). */
  order: string[]
}

export interface Workspace {
  id: string
  name: string
  cwd: string
  panes: Pane[]
  /** When true, sorts to the top of the workspace list. */
  favorite?: boolean
  /** Console grid layout (custom tiling grid). */
  layout?: WorkspaceLayout
  /** Connection profile run in every console before its model command. */
  setupId?: string
  /** Sidebar agent rows folded under this workspace (schema 11). */
  agentsCollapsed?: boolean
  /** Short free-text note shown under the workspace name, max 140 (schema 12). */
  note?: string
  /** User task state, distinct from the agent state (schema 12). */
  taskState?: WorkspaceTaskState
  /** Repo file (.snagentsos.json) this workspace was created from (schema 13). */
  repoConfig?: WorkspaceRepoConfig
}

/**
 * Trace of the repo config applied to a workspace (E8-FR-25, schema 13). The
 * trust itself lives in main's `trusted-repos.json`, never in config.json
 * (R30-01 amendment: the renderer cannot forge it).
 */
export interface WorkspaceRepoConfig {
  /** sha256 (hex) of the normalized file that was applied. */
  sha256: string
  /** Epoch ms of the apply. */
  appliedAt: number
  /** Quick Commands imported from the file, at most 20. */
  quickCommandIds: string[]
}

/** Per-workspace task state (E8-FR-10, schema 12). */
export type WorkspaceTaskState = 'todo' | 'doing' | 'review' | 'done'

/**
 * A saved, reusable prompt/text snippet inserted into a console (U10).
 * @deprecated Schema 12 replaced snippets with QuickCommand. Kept only to parse
 * old configs (migration input) and for the phone snapshot until R22-12.
 */
export interface Snippet {
  id: string
  name: string
  text: string
}

/**
 * A reusable command (E8-FR-01, schema 12; Contratos compartidos). `send`
 * writes `text` to a console (Enter optional); `agent` opens a console from
 * `presetId` and delivers `text` as its first prompt (always with Enter).
 */
export interface QuickCommand {
  /** 'qc-...'; commands migrated from snippets keep their 'snip-...' id. */
  id: string
  /** Visible label, 1..60. */
  name: string
  /** send: text to write; agent: first prompt. 1..16384. */
  text: string
  /** Absent = global. */
  workspaceId?: string
  action: 'send' | 'agent'
  /** send: optional Enter; agent: always true. */
  enter: boolean
  /** Required when action === 'agent'. */
  presetId?: string
}

/**
 * A custom button in the phone's KeyBar. `seq` is the raw bytes written to the
 * pty when tapped (e.g. "\r", "\x1b", a literal string) - what it does depends
 * on the program reading it, we just forward the bytes.
 */
export interface KeyButton {
  id: string
  label: string
  seq: string
}

export interface AgentPreset {
  id: string
  name: string
  type: PaneType
  command: string
  args: string[]
  env?: Record<string, string>
  color: string
  icon: string
  defaultCwd?: string
}

/** Legacy accent selector (superseded by the theme registry; kept for migration). */
export type AccentName = 'violet' | 'purple' | 'blue'

export type ThemeName = 'midnight' | 'light' | 'nord' | 'dracula' | 'solarized' | 'custom'

export type Language = 'en' | 'es'

/**
 * Flat set of themeable tokens. One registry consumed by:
 *  - CSS custom properties (UI chrome),
 *  - the xterm terminal palette,
 *  - the console grid/header colors.
 */
export type ThemeTokenKey =
  // UI chrome
  | 'bg-primary'
  | 'bg-secondary'
  | 'card'
  | 'border'
  | 'text-primary'
  | 'text-secondary'
  | 'accent'
  | 'accent-2'
  | 'accent-3'
  // terminal core
  | 'term-bg'
  | 'term-fg'
  | 'term-cursor'
  | 'term-selection'
  // ansi 16
  | 'ansi-black'
  | 'ansi-red'
  | 'ansi-green'
  | 'ansi-yellow'
  | 'ansi-blue'
  | 'ansi-magenta'
  | 'ansi-cyan'
  | 'ansi-white'
  | 'ansi-brightBlack'
  | 'ansi-brightRed'
  | 'ansi-brightGreen'
  | 'ansi-brightYellow'
  | 'ansi-brightBlue'
  | 'ansi-brightMagenta'
  | 'ansi-brightCyan'
  | 'ansi-brightWhite'

export type ThemeTokens = Record<ThemeTokenKey, string>

export interface ThemeDefinition {
  name: ThemeName
  /** Human label shown in settings. */
  label: string
  /** True for light-background themes (drives `color-scheme`). */
  light?: boolean
  tokens: ThemeTokens
}

/**
 * A user-defined usage row that counts tokens for an arbitrary model by parsing
 * the local transcript JSONL (no live quota %, totals only). The optional
 * `tokenBudget` turns the absolute count into a percent bar.
 */
export interface UsageCustomRow {
  id: string
  /** Display label for the row. */
  label: string
  /** Which transcript store to scan. */
  source: 'claude' | 'codex'
  /** Case-insensitive substring matched against each turn's model id. */
  modelMatch: string
  /** Time window the tokens are summed over. */
  window: 'session5h' | 'weekly7d' | 'today' | 'all'
  /** When set, the row shows used/budget as a percent bar. */
  tokenBudget?: number
  enabled: boolean
}

/** Settings for the live usage bars feature (Claude + Codex + custom). */
export interface UsageSettings {
  /** Master switch for the sidebar widget + polling. */
  enabled: boolean
  /** Poll interval for the Claude OAuth endpoint (ms; clamped >= 30s in main). */
  claudeIntervalMs: number
  /** Poll interval for the local Codex rollout file (ms; clamped >= 3s in main). */
  codexIntervalMs: number
  /** Re-fetch when the app window regains focus. */
  refreshOnFocus: boolean
  /** Show the Anthropic service-status dot. */
  showStatus: boolean
  /** Which built-in quota rows are visible. */
  rows: {
    claude5h: boolean
    claude7d: boolean
    claudeOpus7d: boolean
    claudeSonnet7d: boolean
    codex5h: boolean
    codex7d: boolean
  }
  custom: UsageCustomRow[]
  /** Sidebar usage panel folded down to one row of rings (schema 15). */
  collapsed?: boolean
}

/**
 * Claude multi-account switching (schema 16, app 2.3.0). Only the policy
 * lives in config.json: the saved accounts and their encrypted logins are
 * main-owned under dataDir()/claude-accounts/. Automatic switching is off by
 * default; `normalizeAccountsSettings` (src/shared/claude-accounts.ts) clamps
 * every field and keeps `returnBelowPercent < switchAtPercent`.
 */
export interface ClaudeAccountsSettings {
  /** Switch to the other account when the active one reaches `switchAtPercent`. */
  autoSwitch: boolean
  /** 5h or 7d usage that counts as exhausted (50..100). */
  switchAtPercent: number
  /** After an automatic switch, go back to the primary once its limit reset. */
  returnToPrimary: boolean
  /** The primary must read below this (0..99) to go back to it. */
  returnBelowPercent: number
  /** Minutes after the primary's reset before going back (0..120). */
  returnMarginMinutes: number
  /** Minimum minutes between two switches (0..240). */
  minDwellMinutes: number
  /** Wait while a Claude console is working, up to `deferMaxMinutes`. */
  deferWhileWorking: boolean
  /** 0..60 */
  deferMaxMinutes: number
  /** Read the usage of the parked account with its own unexpired token. */
  pollParked: boolean
  /** Desktop and remote notice on an automatic switch. */
  alertOnSwitch: boolean
}

/**
 * Persisted settings for the embedded remote-control server (phone access).
 * Only the on/off switch and port live here; the paired-device registry is a
 * separate main-owned file (remote-devices.json) so device secrets never
 * enter the renderer-persisted config blob.
 */
export interface RemoteSettings {
  /** Master switch for the embedded HTTP+WS server. Off by default. */
  enabled: boolean
  /** TCP port the server binds on 0.0.0.0. */
  port: number
  /** Accept phone-fit requests (fitPane) from the phone (E3, schema 13). */
  phoneFit: boolean
  /** Secure mode through `tailscale serve` (E3-FR-42, schema 13). */
  https: RemoteHttpsSettings
}

/** Secure remote mode (E3-FR-42, schema 13). Only `tailscaleServe` exists. */
export interface RemoteHttpsSettings {
  enabled: boolean
  mode: 'tailscaleServe'
}

/**
 * Live state of a Claude Code session inside a console, derived from two
 * structured channels (never from sniffing raw pty bytes):
 *  - the OSC terminal title Claude Code sets (braille spinner = working,
 *    U+2733 = stopped at the prompt),
 *  - optional Claude Code hooks POSTing to the local HookServer (precise).
 */
export type ClaudePaneState = 'idle' | 'working' | 'done' | 'action' | 'error' | 'unknown'
export type AgentProvider = 'claude' | 'codex'
export type AttentionReason = 'permission' | 'question' | 'plan' | 'elicitation' | 'failure'

/**
 * One outstanding request of an agent (CONTRATOS RemotePending, E4-FR-09).
 * Travels to the phone inside RemotePaneStatus; built in main from bounded
 * hook fields, never from the raw tool_input.
 */
export interface RemotePending {
  /** toolUseId / elicitation id, or a fallback key. */
  id: string
  kind: 'permission' | 'question' | 'plan' | 'elicitation'
  toolName?: string
  /** <= 200 */
  summary: string
  /** AskUserQuestion only. */
  questions?: Array<{ question: string; header?: string; multiSelect: boolean; options: Array<{ label: string; description?: string }> }>
}

export type AgentDetailKind = 'tool' | 'prompt' | 'question' | 'permission' | 'plan' | 'reply'
/** What the agent is on right now (desktop only, E5-FR-02). text <= 160, no C0/C1 or ANSI. */
export interface AgentDetail {
  kind: AgentDetailKind
  text: string
}

/**
 * Status enrichment shared by PaneStatus and PaneStatusEvt (E4-FR-09,
 * E5-FR-02). The first four also reach the phone (RemotePaneStatus); the
 * rest are desktop only and never leave main -> renderer, except the 2.7.0
 * fields marked "Reaches the phone".
 */
export interface PaneStatusDetails {
  /** Epoch ms of the last change of the effective state (not of updatedAt). */
  stateSince?: number
  /** Last assistant reply, <= 280. */
  lastMessage?: string
  /** Current tool, summarized, <= 120. */
  activity?: string
  pending?: RemotePending[]
  /** Validated session id (never `launch:`, never on SSH panes). Desktop only. */
  sessionId?: string
  /** Absolute existing directory reported by the agent. Desktop only. */
  cwd?: string
  detail?: AgentDetail
  /** Text after the glyph in Claude's OSC title, <= 60. */
  topic?: string
  /** First line of the first prompt of the session, <= 60. */
  firstPrompt?: string
  /** Claude working -> done/idle transition (cache timer start). */
  cacheSince?: number
  /**
   * v2.2: the agent ended its turn but waits on work it started, so the state
   * reads `working` meanwhile (no "done" notice, no hibernation, `snaos wait`
   * keeps waiting). Absent = not waiting.
   */
  waiting?: AgentWaiting
  /** v2.2: background tasks that do not hold the console (a dev server), next to `done`. */
  backgroundOther?: number
  /**
   * v2.3 (agentTune read-back, main): Claude's model from SessionStart or the
   * last tune applied with Enter (<= 64, one line), its effort level from the
   * hooks' `effort.level` or that tune (<= 16), and Ultracode as that tune
   * left it. Reset on a new session (`start`). Absent = unknown.
   */
  model?: string
  effort?: string
  ultracode?: boolean
  /**
   * App 2.7.0 (A3): family of the newest tool still open (`activity` is its
   * summary). Absent while no tool runs. Reaches the phone.
   */
  toolFamily?: ToolFamily
  /** App 2.7.0 (A3): why the last turn failed; cleared by the next `working`. Reaches the phone. */
  failure?: FailureInfo
  /** App 2.7.0 (A3): a working agent with no signal for a while (SilenceWatch). Reaches the phone. */
  silence?: PaneSilence
  /** App 2.7.0 (A3): open `snaos needs` request; raises attention, never `pending`. Reaches the phone. */
  needs?: PaneNeeds
  /** App 2.7.0 (A3): silenced by the user until the effective state changes. Reaches the phone. */
  muted?: boolean
  /** App 2.7.0 (A3): tools of the current turn, frozen as the last turn's on done. Desktop only. */
  digest?: TurnDigest
  /**
   * App 2.7.0 (A3): epoch ms of the last sign of life (hook, Codex app-server
   * line). Desktop only and never part of the publish signature.
   */
  signalAt?: number
  /**
   * App 2.7.0 (A3): minimal status that only carries `needs` for a pane
   * without an agent track; consumers treat its state as no agent state.
   * Desktop only (the phone gets the status without it). Absent = a real status.
   */
  bare?: true
  /**
   * App 2.7.0 (A4): tokens and cost the console's agent spent (ConsoleLedger),
   * refreshed once per turn for Claude (its done) and on every model call for
   * Codex (thread/tokenUsage/updated), always inside the detail throttle.
   * Always an estimate ("estimado"). Desktop only.
   */
  usage?: PaneUsage
  /**
   * App 2.7.0 (A4): how full the agent's context window is, refreshed like
   * `usage` (once per turn for Claude, on every model call for Codex, inside
   * the detail throttle). Reaches the phone.
   */
  context?: PaneContext
}

/**
 * App 2.7.0 (A4): what a console spent, from the ConsoleLedger in main. Every
 * surface shows it as "estimado": the tokens come from the agent's own
 * records and the cost from the agent (Claude's `cost-state`) or the dated
 * rate card (`src/shared/rateCard.ts`, Codex), never from a bill. The four
 * counts do not overlap: `inputTokens` is the input that was not read from a
 * cache. Claude: every assistant message of the console's sessions (main and
 * subagent transcripts) once per message id. Codex: each thread's cumulative
 * total minus its total before the first call the console saw.
 */
export interface PaneUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** USD of the part with a known price (a lower bound with `unknownCost`); absent when no part has one. */
  costUSD?: number
  /** Some of the usage has no known price (a model off the rate card, a session without `cost-state`, Claude's `hasUnknownModelCost`). */
  unknownCost?: boolean
  /** The model of the latest call, when known. */
  model?: string
  estimated: true
}

/**
 * App 2.7.0 (A4): share of the context window the latest call used. `exact`:
 * Codex reports the call and its window (`thread/tokenUsage/updated`); Claude's
 * is approximate (its last main-thread usage over an assumed window).
 */
export interface PaneContext {
  /** 0..1. */
  pct: number
  /** Tokens the latest call held. */
  used: number
  /** The window, in tokens. */
  window: number
  exact: boolean
}

/** App 2.7.0 (A3): silence levels of a working agent, `quiet` after quietMin, `stalled` after stalledMin. */
export type SilenceLevel = 'quiet' | 'stalled'

/** App 2.7.0 (A3): `since` is the signalAt the silence counts from. */
export interface PaneSilence {
  level: SilenceLevel
  since: number
}

/** Longest `snaos needs` text kept (one line). */
export const NEEDS_TEXT_MAX = 200

/** App 2.7.0 (A3): what the agent asked for with `snaos needs`, and when. */
export interface PaneNeeds {
  text: string
  at: number
}

/** Longest ExitPlanMode plan kept for "Leer plan completo", in UTF-16 units. */
export const PLAN_TEXT_MAX = 32 * 1024

/** App 2.7.0 (A3): the full plan of an ExitPlanMode request (`status:plan`, `planReq`). */
export interface PanePlan {
  requestId: string
  text: string
  at: number
  /** The plan was longer than PLAN_TEXT_MAX and was cut. */
  truncated: boolean
}

/**
 * What a console's agent waits on after its turn (v2.2): `background` =
 * subagents, workflows, a `snaos wait` or a driver it left running (Stop
 * `background_tasks`); `subsessions` = `claude -p` sub-sessions started from
 * the console (hooks marked X-Agent-Child / X-Agent-Parent). `count` >= 1,
 * except a short grace between two sub-sessions of a driver (0).
 */
export interface AgentWaiting {
  kind: 'background' | 'subsessions'
  count: number
}

export interface PaneStatus extends PaneStatusDetails {
  state: ClaudePaneState
  precise: boolean
  provider?: AgentProvider
  reason?: AttentionReason
  pendingCount?: number
  updatedAt?: number
  /** v2.3: derived by main, see PaneStatusEvt.attention. Absent = legacy rules. */
  attention?: boolean
}

/** Main -> renderer status update for one console. */
export interface PaneStatusEvt extends PaneStatusDetails {
  paneId: string
  /** null clears the indicator (claude exited / pty died). */
  state: ClaudePaneState | null
  /** True when the hooks channel is live for this pane (exact 3-state info). */
  precise: boolean
  /** Main already decided this transition deserves a notification (drives sound too). */
  notify: boolean
  /**
   * How main delivered that notification (E4-FR-07): the OS toast, an in-app
   * card (window focused, console out of view) or nothing. Set on notice events.
   */
  delivery?: 'native' | 'inApp' | 'none'
  provider?: AgentProvider
  /**
   * v2.4: a shell console (no agent in its config) running `claude` / `codex`
   * typed by hand (OSC 133 `agent=` of the integrated PowerShell). `provider`
   * names that agent; the saved pane type never changes. Absent = no.
   */
  hosted?: true
  reason?: AttentionReason
  pendingCount?: number
  updatedAt?: number
  /**
   * v2.3, derived by main: the console needs the user now (`action` while some
   * request is not answered yet, `done` / `error` until a device acknowledged
   * it). Every badge, flash, card and tray item reads it; `state`,
   * `pendingCount` and `pending[]` keep their own meaning. Absent = a desktop
   * without the field (legacy rules).
   */
  attention?: boolean
}

/**
 * SessionEnd reasons that offer "Claude exited [Resume] [New]" (E6-FR-21);
 * `exit` (v2.2) is Codex's: its launcher ended with code 0.
 */
export const AGENT_END_REASONS = ['prompt_input_exit', 'other', 'exit'] as const

/**
 * Main -> renderer: the agent's main session (no subagent, no sub-session) of
 * the live pty ended with a reason in AGENT_END_REASONS (E6-FR-21; Codex since
 * v2.2). `cwd` is the validated session directory, when any.
 */
export interface AgentSessionEndEvt {
  paneId: string
  ptyId: string
  provider: AgentProvider
  sessionId: string
  reason: (typeof AGENT_END_REASONS)[number]
  cwd?: string
  at: number
}

/**
 * Main -> renderer (v2.4, one-shot): the agent of the live pty named its
 * session (Claude `/rename`, a `custom-title` record or `session_title`;
 * Codex `thread/name/set`). Only the console's main session, deduplicated
 * per session in main. `initial`: the name was already there the first time
 * main looked at the session (a resume), not a rename seen happening; the
 * renderer never lets it overwrite a console renamed by hand. `title` is one
 * line, <= 60.
 */
export interface AgentRenameEvt {
  paneId: string
  ptyId: string
  provider: AgentProvider
  sessionId: string
  title: string
  initial: boolean
}

/** Result of installing/uninstalling/inspecting the Claude Code hooks block. */
export interface StatusHooksStatusRes {
  installed: boolean
  settingsPath: string
  /** Port found in the installed hook URL, null when not installed. */
  port: number | null
  complete?: boolean
  running?: boolean
  lastEventAt?: number | null
  error?: string
}

export interface DiscordSettings {
  enabled: boolean
  webhookUrl: string
  userId: string
  notifyAction: boolean
  notifyDone: boolean
}

/** ntfy push channel (E2-FR-40, schema 12). Topic and token never leave in an export. */
export interface NtfySettings {
  enabled: boolean
  /** https, or http only for a private/tailnet host. Default 'https://ntfy.sh'. */
  server: string
  /** [A-Za-z0-9_-]{1,64} or empty. */
  topic: string
  /** Optional access token (Bearer). */
  token: string
  notifyAction: boolean
  notifyDone: boolean
}

export interface StatusHealth {
  desktop: { error: 'blocked' | 'failed' | 'unavailable' | null }
  claude: StatusHooksStatusRes
  /** v2.4: `missing` = enabled but no codex.exe on PATH yet (a neutral state, not an error; rescanned lazily). */
  codex: { enabled: boolean; available: boolean; connected: number; error?: string; missing?: boolean }
  discord: { lastSuccessAt: number | null; error: string | null; queued: number }
  /** ntfy channel (E2-FR-40), same shape as discord. */
  ntfy?: { lastSuccessAt: number | null; error: string | null; queued: number }
}

/** Desktop notifications, sounds and Claude status integration. */
export interface NotificationSettings {
  /** Master switch for desktop notifications. */
  enabled: boolean
  /** Notify when Claude finishes a turn. */
  notifyDone: boolean
  /** Notify when Claude needs the user (permission prompt, question). */
  notifyAction: boolean
  /** Play a sound alongside the notification. */
  sound: boolean
  soundId: 'chime' | 'ping' | 'pop'
  /** 0-100. */
  volume: number
  /** Flash the taskbar button when unfocused. */
  flashTaskbar: boolean
  /** Claude Code hooks integration (writes to ~/.claude/settings.json). */
  hooksEnabled: boolean
  /** Local port the HookServer listens on (127.0.0.1 only). */
  hookPort: number
  /** Random token in the hook URL path; generated on first install. */
  hookToken: string
  /**
   * Private per-console Codex transport for new local terminals. Default on
   * since schema 17 (app 2.4.0); migrate() turns it on once for older configs.
   */
  codexEnabled: boolean
  discord: DiscordSettings
  /**
   * With the window focused but the console out of view, show an in-app card
   * instead of the OS notification and taskbar flash (schema 11).
   */
  inAppWhenFocused: boolean
  /** ntfy channel next to Discord (schema 12). */
  ntfy: NtfySettings
  /**
   * Discord and ntfy only while the PC is idle/locked for 180 s (fixed); an
   * unknown idle state still delivers. Native notifications ignore it (schema 12).
   */
  onlyWhenAway: boolean
  /**
   * Seconds the remote notices (Web Push, Discord, ntfy) wait before going out; one
   * that no longer stands by then is dropped (schema 20, app 2.8.0). 0 sends at once.
   */
  remoteDelaySec: number
}

/** Keep the PC awake while agents work (schema 11). */
export type AwakeMode = 'auto' | 'always' | 'never'

/** What to do with interrupted agent sessions on startup (schema 11). */
export type ResumeOnStartup = 'ask' | 'auto' | 'off'

/** Agent behavior settings (schema 11). */
export interface AgentSettings {
  /** Startup decision for consoles whose agent session was interrupted. */
  resumeOnStartup: ResumeOnStartup
  /** Awake mode also keeps the display on (prevent-display-sleep). */
  awakeDisplay: boolean
  /** One row per agent console under each workspace in the expanded sidebar. */
  sidebarAgentRows: boolean
  /** Show the agent's topic as the console title. */
  topicAsTitle: boolean
  /** Ctrl+1..9 focuses the Nth visible console instead of reaching the terminal. */
  ctrlDigitFocus: boolean
  /** Resume modal auto-applies after this many seconds, 0 = never (0..600, schema 12). */
  resumeModalTimeoutSec: number
  /** Nudge resumed consoles that were working (schema 12). */
  resumeNudge: boolean
  /** Nudge text, max 500; '' = the localized default (schema 12). */
  resumeNudgeText: string
  /** Sidebar order: manual (default) or by agent demand (schema 12). */
  sidebarSort: 'manual' | 'smart'
  /** Claude prompt cache countdown chip (E5-FR-28, schema 13). */
  cacheTimer: CacheTimerSettings
  /** An agent `/rename` also renames its console (schema 17). */
  syncAgentRename: boolean
  /** A `claude`/`codex` typed in a shell console is tracked as an agent (OSC 133 `agent=`, schema 17). */
  shellAgentDetect: boolean
  /** Silence watch of working agents (schema 19, app 2.7.0). */
  silence: SilenceSettings
}

/**
 * Silence watch (schema 19, app 2.7.0): a working agent without a signal for
 * quietMin minutes reads `quiet`, for stalledMin `stalled`. It never kills or
 * writes; quietMin < stalledMin.
 */
export interface SilenceSettings {
  enabled: boolean
  quietMin: number
  stalledMin: number
}

/** Claude prompt cache timer (E5-FR-28, schema 13). */
export interface CacheTimerSettings {
  enabled: boolean
  /** Cache TTL the countdown starts from. */
  ttlMinutes: 5 | 60
}

/** Workspace composer and automation settings (E8, schema 12 and 13). */
export interface AutomationSettings {
  /** Preselected composer preset; '' = first 'claude' preset, else the first one. */
  defaultAgentPresetId: string
  /** Composer "Create another" switch. */
  composerCreateAnother: boolean
  /** The CLI never reads, writes or creates consoles with a Connection Profile (schema 13). */
  cliProtectSsh: boolean
  /** Add `<dataDir>/bin` to the user PATH (schema 13; forced off in the portable). */
  cliUserPath: boolean
  /** A missed run still fires once if it is at most this late, 0..1440 min (schema 13). */
  scheduleGraceMin: number
  /** Max wait for a busy agent before `skipped_busy`, 1..240 min (schema 13). */
  scheduleMaxWaitMin: number
  /** Desktop notification per schedule run (schema 13). */
  scheduleNotify: boolean
}

/**
 * Where the local Whisper engine runs (schema 18, app 2.5.0): 'auto' = the GPU
 * pack on an NVIDIA GPU when installed, else the CPU pack.
 */
export type DictationDevice = 'auto' | 'gpu' | 'cpu'

/** Desktop microphone dictation (schema 17; schema 18 swaps the Windows engine for local Whisper). */
export interface DictationSettings {
  /** Engine device (schema 18). */
  device: DictationDevice
  /** 'auto' (the app language) or a BCP 47 tag. */
  language: string
  /** Microphone button in the workspace header. */
  headerButton: boolean
  /** Show the phrase being heard while it is still open (GPU only, schema 18). */
  interim: boolean
  /** Extra words that bias recognition (names, jargon), at most 400 chars (schema 18). */
  vocabulary: string
}

/** What a desktop share guest may do: watch, type without Enter, or full control (schema 17). */
export type SharePerm = 'view' | 'type' | 'full'

/** A share guest's workspace notes: none, read, or read and write (app 2.6.0). */
export type ShareNotesRight = 'off' | 'read' | 'write'
/** A share guest's workspace files: none or read-only (app 2.6.0). */
export type ShareFilesRight = 'off' | 'read'

/**
 * What a share guest may use beyond the terminal (app 2.6.0), set apart from
 * the terminal perm: per grant (the default of whoever joins) and per session.
 * Only a workspace scope has any (src/shared/shareRights.ts).
 */
export interface ShareRights {
  /** New console / Close console. */
  consoles: boolean
  chat: boolean
  /** The Changes drawer (git status and diff). */
  changes: boolean
  notes: ShareNotesRight
  files: ShareFilesRight
}

/**
 * Desktop-to-desktop sharing (schema 17). Off until the Share dialog turns it
 * on; grants, links and the host identity live in dataDir(), never here.
 */
export interface ShareSettings {
  enabled: boolean
  /** Share listener port (1024..65535), separate from the phone server. */
  port: number
  /** Name shown to hosts when joining; '' = the device name. */
  guestName: string
  /** Preselected permission in the Share dialog. */
  defaultPerm: SharePerm
}

/** Headless snapshot engine (E6-FR-01, schema 12). 'off' also disables scrollback persistence. */
export type TerminalSnapshotMode = 'auto' | 'lazy' | 'off'

export interface Settings {
  /** Default shell per platform; undefined => resolver picks the OS default. */
  defaultShell: { win32?: string; darwin?: string; linux?: string }
  fontFamily: string
  fontSize: number
  /** Legacy; retained for back-compat with v1 configs. */
  accent: AccentName
  theme: ThemeName
  /** Per-token overrides applied on top of the active theme (used by 'custom'). */
  customColors?: Partial<Record<ThemeTokenKey, string>>
  language: Language
  scrollback: number
  /** When true, consoles keep effectively unlimited scrollback (like a normal terminal). */
  infiniteScrollback: boolean
  /**
   * Terminal draw engine. 'canvas' (default) has no corruptible GPU glyph
   * atlas, so it cannot show garbled mojibake after a GPU reset (sleep/resume,
   * screen unlock, Windows TDR, GPU-process crash); its worst case is a blank
   * glyph that repaints on the next output. 'webgl' is faster for many busy
   * panes but its context can come back "alive but invalid" with a trashed
   * atlas and NO event to detect it, which is the historical mojibake bug, so
   * it is opt-in only.
   */
  terminalRenderer: 'canvas' | 'webgl'
  /**
   * When a TUI (Claude Code, vim with mouse) enables xterm mouse reporting,
   * a plain left-drag still makes a local text selection instead of being
   * sent to the app. Shift+drag selects either way; turn off to let plain
   * clicks reach the TUI (previous behavior).
   */
  terminalSelectionOverride: boolean
  /** Unicode 11 character widths in the terminal (emoji and symbols). Schema 11. */
  terminalUnicode11: boolean
  /** Offer Resume / New under a console when Claude exits. Schema 11. */
  terminalAgentEndChip: boolean
  /** Keep the PC awake while agents work. Schema 11. */
  awakeMode: AwakeMode
  /** Headless mirror policy for replay and persistence. Schema 12. */
  terminalSnapshotMode: TerminalSnapshotMode
  /** Keep console history across restarts. Schema 12. */
  persistScrollback: boolean
  /** Lines saved per console, 200..5000. Schema 12. */
  persistScrollbackLines: number
  /** Git chip in the workspace header and background git refresh. Schema 12. */
  gitChip: boolean
  /** Windows "Open in SnAgentsOS" folder context menu (packaged only). Schema 12. */
  explorerMenu: boolean
  /** Update card dismissed for this version (installable ones only). Schema 12. */
  updateDismissedVersion: string
  /** `snaos` CLI available in the consoles (E8-FR-12). Schema 13. */
  cliEnabled: boolean
  /** Root for console worktrees; '' = dataDir()/worktrees (E7-FR-28). Schema 13. */
  worktreesRoot: string
  /** Hibernate idle agent consoles after N minutes; 0 = off, else 5..1440 (E5-FR-25). Schema 13. */
  hibernateIdleMinutes: number
  /**
   * PowerShell shell integration: prompt marks (OSC 133), prompt navigation
   * and "copy the last command output" (E6-FR-25..31). Schema 14.
   */
  terminalShellIntegration: boolean
  restoreLastWorkspace: boolean
  confirmCloseRunning: boolean
  /** Installed build only: hide to tray on window close instead of quitting. */
  closeToTray: boolean
  /** Installed build only: register the app to launch at system login. */
  launchOnStartup: boolean
  /** Check GitHub for a newer release on startup and offer to install it. */
  autoCheckUpdates: boolean
  /** Global OS shortcut to show/focus the app from anywhere. */
  globalHotkeyEnabled: boolean
  /** Electron accelerator string, e.g. "Super+Alt+O". */
  globalHotkey: string
  /** Remapped in-app shortcuts: actionId -> accelerator (overrides defaults). */
  keymap: Record<string, string>
  sidebarCollapsed: boolean
  /** Live usage / quota bars (Claude + Codex + custom models). */
  usage: UsageSettings
  /** Claude multi-account switching policy (schema 16). */
  claudeAccounts: ClaudeAccountsSettings
  /** Remote control from a phone browser (embedded LAN/Tailscale server). */
  remote: RemoteSettings
  /** Desktop notifications, sounds and Claude status integration. */
  notifications: NotificationSettings
  /** Agent behavior (resume, awake display, sidebar rows, shortcuts). Schema 11. */
  agents: AgentSettings
  /** Workspace composer defaults (schema 12), CLI and schedule options (schema 13). */
  automation: AutomationSettings
  /** Desktop microphone dictation (schema 17). */
  dictation: DictationSettings
  /** Desktop-to-desktop console and workspace sharing (schema 17). */
  share: ShareSettings
  /** Opt-in experimental modules, all off by default (schema 19, app 2.7.0). */
  labs: LabsSettings
  /** Sidebar blocks shown, all on by default (schema 20, app 2.8.0). */
  sidebarBlocks: SidebarBlocksSettings
}

export interface ConfigFile {
  version: number
  workspaces: Workspace[]
  presets: AgentPreset[]
  settings: Settings
  activeWorkspaceId?: string | null
  /** Reusable commands (schema 12). Replaces `snippets`. */
  quickCommands?: QuickCommand[]
  /**
   * @deprecated Schema <= 11 only: migration input, converted to
   * `quickCommands` on parse and never written again.
   */
  snippets?: Snippet[]
  /** Reusable pre-launch connection sequences (e.g. SSH). */
  connections?: ConnectionProfile[]
  /** Custom phone KeyBar buttons. */
  keyButtons?: KeyButton[]
}
