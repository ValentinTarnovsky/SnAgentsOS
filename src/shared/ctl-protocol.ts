/**
 * Local control protocol of the `snaos` CLI (E8-FR-12..22). HTTP/1.1 over a
 * named pipe (Windows) or a 0600 unix socket, never TCP: POST /v1/rpc with
 * `Authorization: Bearer <token>`. HTTP 200 whenever the token is valid (the
 * error goes in the body); 401 bad token, 403 any `Origin`, 413 body > 1 MB.
 *
 * Kept free of runtime imports besides types: the CLI entry (cliEntry.ts,
 * Node core only) bundles it next to main.
 */
import type { AgentProvider, AgentWaiting, AttentionReason, ClaudePaneState, PaneType, RemotePending, SilenceLevel, WorkspaceTaskState } from './types'
import type { ChatMessage } from './chat-types'
import type { FailureKind } from './failure'
import type { TeamCtlMethod } from './teamTools'

export const CTL_PROTOCOL_VERSION = 1
export const CTL_RPC_PATH = '/v1/rpc'
/** Request body cap (E8-FR-12). */
export const CTL_MAX_BODY = 1024 * 1024
/** `send` text cap (E8-FR-17). */
export const CTL_MAX_SEND = 256 * 1024
/** Initial prompt cap of a spawned console (same as a pane's pending prompt). */
export const CTL_MAX_PROMPT = 16384
/** `status "<text>"` cap (E8-FR-19). */
export const CTL_STATUS_MAX = 120
/** `notify` title / body caps (E8-FR-19). */
export const CTL_NOTIFY_TITLE_MAX = 80
export const CTL_NOTIFY_BODY_MAX = 300
/** `notify` budget per console (or master token) and minute. */
export const CTL_NOTIFY_PER_MIN = 10
/** `read --lines` default and cap. */
export const CTL_READ_DEFAULT = 100
export const CTL_READ_MAX = 2000
/** `wait` limits (E8-FR-18). */
export const CTL_WAIT_DEFAULT_S = 600
export const CTL_WAIT_MAX_S = 3600
export const CTL_WAIT_QUIET_MS = 3000
export const CTL_MAX_WAITERS = 32
/** `chat --turns` default and cap (app 2.3.0). A turn is one user message and everything up to the next one. */
export const CTL_CHAT_TURNS_DEFAULT = 3
export const CTL_CHAT_TURNS_MAX = 20
/** Transcript pages one `chat` call reads at most (each scans 8 MB at most). */
export const CTL_CHAT_MAX_PAGES = 8
/** A `text` block of `chat` is clipped to this many characters (`truncated: true`). */
export const CTL_CHAT_BLOCK_MAX = 4096
/** `peek --lines` default (capped like `read`). */
export const CTL_PEEK_LINES_DEFAULT = 30
/** `chat` and `peek` budget per console (or master token) and minute. */
export const CTL_READS_PER_MIN = 120
/** Console title (`rename`; `spawn --title` clips at the same 60) and workspace name caps. */
export const CTL_TITLE_MAX = 60
export const CTL_WS_NAME_MAX = 80
/** `kill`, `restart`, `rename`, `ws rename|close|fav` budget per caller and minute. */
export const CTL_MUTATE_PER_MIN = 30
/** `ws new` budget per caller and minute. */
export const CTL_WS_NEW_PER_MIN = 5
/** `notes new|set|append|rm` budget per caller and minute. */
export const CTL_NOTES_WRITE_PER_MIN = 60
/** `account use` switches per minute, one budget for every caller (the Claude login is global). */
export const CTL_ACCOUNT_USE_PER_MIN = 3

/** dataDir()/runtime.json (E8-FR-12): written atomically, removed on quit by its own pid. */
export interface SnaosRuntimeFile {
  version: 1
  pid: number
  appVersion: string
  startedAt: number
  transport: { kind: 'named-pipe' | 'unix'; endpoint: string }
  /** Master token, 64 hex, stable for the whole run. */
  token: string
}

export type CtlMethod =
  | 'ping'
  | 'ls'
  | 'open'
  | 'spawn'
  | 'send'
  | 'read'
  | 'wait'
  | 'status'
  | 'notify'
  | 'note'
  // app 2.3.0: observe other consoles, console and workspace control, Markdown notes.
  | 'chat'
  | 'peek'
  | 'kill'
  | 'restart'
  | 'rename'
  | 'ws.new'
  | 'ws.rename'
  | 'ws.close'
  | 'ws.fav'
  | 'notes.ls'
  | 'notes.get'
  | 'notes.new'
  | 'notes.set'
  | 'notes.append'
  | 'notes.rm'
  | 'notes.open'
  // app 2.3.0 (4b): usage bars and Claude accounts.
  | 'usage'
  | 'account.ls'
  | 'account.status'
  | 'account.use'
  // app 2.7.0 (A3): ask the user to do or decide something, without blocking the console.
  | 'needs'
  // app 2.7.0 (Teams, B2): `snaos team`, only for the token of a team run (TEAM_TOOLS of teamTools.ts).
  | TeamCtlMethod

export const CTL_METHODS: readonly CtlMethod[] = [
  'ping',
  'ls',
  'open',
  'spawn',
  'send',
  'read',
  'wait',
  'status',
  'notify',
  'note',
  'chat',
  'peek',
  'kill',
  'restart',
  'rename',
  'ws.new',
  'ws.rename',
  'ws.close',
  'ws.fav',
  'notes.ls',
  'notes.get',
  'notes.new',
  'notes.set',
  'notes.append',
  'notes.rm',
  'notes.open',
  'usage',
  'account.ls',
  'account.status',
  'account.use',
  'needs',
  // = TEAM_CTL_METHODS (test-cli.cjs asserts it), spelled out so this file keeps type-only imports.
  'team.show',
  'team.tasks',
  'team.task.get',
  'team.task.create',
  'team.task.update',
  'team.comment',
  'team.note',
  'team.ask',
  'team.needs',
  'team.plan',
  'team.review',
  'team.verdict',
  'team.done',
  'team.approve',
  'team.hire',
]

export interface CtlRequest {
  v: 1
  method: CtlMethod
  params: Record<string, unknown>
  // No 'caller': main derives it from the token (CtlTokens.resolve).
}

export type CtlErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'disabled'
  | 'not_found'
  | 'not_running'
  | 'exited'
  | 'ambiguous'
  | 'ssh_protected'
  | 'multiline_unsafe'
  | 'rate_limited'
  | 'busy'
  | 'timeout'
  | 'desktop_unavailable'
  | 'internal'
  /** app 2.3.0: the note changed since `--rev` (reread and retry). */
  | 'conflict'
  /** `send` to a console whose agent waits on the user (precise permission, question or plan, or an open request): nothing was typed. */
  | 'awaiting_user'
  /** app 2.7.0 (Teams): `snaos team task update` of fields the user set (they stay theirs). */
  | 'user_owned'

export interface CtlError {
  code: CtlErrorCode
  message: string
}

/** `data` on an error carries extra context (a `wait` timeout: `{ state, waitedMs }`). */
export type CtlResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: CtlError; data?: unknown }

/**
 * Process exit code per error (E8-FR-14): 0 ok, 1 internal, 2 usage, 3 not
 * found, 4 ambiguous, 5 app unavailable, 6 unauthorized, 7 forbidden or
 * disabled, 8 conflict (app 2.3.0) or user owned (app 2.7.0), 9 awaiting
 * the user, 124 timeout.
 */
export const CTL_EXIT: Record<CtlErrorCode, number> = {
  bad_request: 2,
  unauthorized: 6,
  forbidden: 7,
  disabled: 7,
  not_found: 3,
  not_running: 3,
  exited: 3,
  ambiguous: 4,
  ssh_protected: 7,
  multiline_unsafe: 7,
  rate_limited: 7,
  busy: 7,
  timeout: 124,
  desktop_unavailable: 5,
  internal: 1,
  conflict: 8,
  awaiting_user: 9,
  user_owned: 8,
}

/**
 * App 2.7.0 (A3): main's status signals of a console, picked field by field
 * from its PaneStatusEvt (`ls`, `peek`, the read-only `status`). Each one is
 * absent when main has nothing to say.
 */
export interface CtlStatusSignals {
  /** Tools of the current turn (the last one once done): the count and an English line ("Edit 3, Read 2 (src/a.ts)"). */
  digest?: { tools: number; line: string }
  /** Why the last turn failed; `until`: epoch ms of a limit reset, when the provider said it. */
  failure?: { kind: FailureKind; until?: number }
  /** A working agent with no sign of life since `since` (epoch ms). */
  silence?: { level: SilenceLevel; since: number }
  /** The open `snaos needs` request and when it was raised (epoch ms). */
  needs?: { text: string; at: number }
}

export interface CtlConsoleInfo extends CtlStatusSignals {
  index: number
  id: string
  title: string
  type: PaneType
  presetName?: string
  running: boolean
  agentState: ClaudePaneState | null
  precise: boolean
  reason?: AttentionReason
  statusLine?: string
  self: boolean
  sshProtected: boolean
}

export interface CtlWorkspaceInfo {
  index: number
  id: string
  name: string
  cwd: string
  active: boolean
  /** app 2.3.0: a favorite (sidebar top). */
  favorite?: true
  note?: string
  taskState?: WorkspaceTaskState
  consoles: CtlConsoleInfo[]
}

/** `chat` (app 2.3.0): turns of another console's transcript, oldest first. */
export interface CtlChatResult {
  paneId: string
  provider?: AgentProvider
  items: ChatMessage[]
  /** User messages among `items` (a turn starts at each). */
  turns: number
  /** `--before` of the older turns; null when the transcript starts here. */
  nextCursor: string | null
  /** The transcript does not exist yet (a new console, or right after /clear). */
  pending?: true
}

/** One pending request in `peek` (no answer options: those stay on the desktop and the phone). */
export interface CtlPeekPending {
  kind: RemotePending['kind']
  toolName?: string
  summary: string
}

/** `peek` (app 2.3.0): one look at a console without reading for the user. */
export interface CtlPeekResult extends CtlStatusSignals {
  paneId: string
  title: string
  type: PaneType
  provider?: AgentProvider
  running: boolean
  state: ClaudePaneState | null
  precise: boolean
  /** Main's attention mark (absent = unknown); `peek` never clears it. */
  attention?: boolean
  reason?: AttentionReason
  pendingCount?: number
  pending?: CtlPeekPending[]
  stateSince?: number
  activity?: string
  lastMessage?: string
  waiting?: AgentWaiting
  statusLine?: string
  model?: string
  effort?: string
  ultracode?: boolean
  /** Last screen lines without colors; [] when the console is not running. */
  lines: string[]
}

export interface CtlWaitResult {
  state: ClaudePaneState | null
  precise: boolean
  waitedMs: number
  noTurnObserved?: boolean
}

/** `needs` (app 2.7.0, A3): the console flagged, and its request (null: cleared). */
export interface CtlNeedsResult {
  paneId: string
  needs: string | null
}

export interface CtlSpawnResult {
  paneId: string
  index: number
  workspaceId: string
  promptDelivery: 'argv' | 'gate' | 'none'
}

// --- usage and accounts (app 2.3.0, 4b) ----------------------------------------
// Fields are picked one by one from main's views: never a token, a raw
// credentials file, an email, token counts (`used` / `limit`) or custom rows.

/** One `usage` row: Claude and Codex quota windows only. */
export interface CtlUsageRow {
  id: string
  provider: 'claude' | 'codex'
  kind: '5h' | '7d'
  label: string
  /** 0..100, null when unknown. */
  percent: number | null
  /** ISO-8601 reset, when known. */
  resetsAt: string | null
  planType?: string
  status: 'ok' | 'expired' | 'error' | 'nodata' | 'loading'
  /** The last good value held through a failed poll. */
  stale?: true
}

/** 2.3.0 slots; app 2.4.0: derived from the rank (#1 is 'primary', every other one 'secondary'). */
export type CtlAccountSlot = 'primary' | 'secondary'

export interface CtlUsageResult {
  rows: CtlUsageRow[]
  /** Epoch ms of the snapshot (0: nothing fetched yet). */
  updatedAt: number
  services: 'operational' | 'degraded' | 'down' | null
  /** The active Claude account, when accounts are saved. `rank`: 1-based priority (app 2.4.0). */
  account?: { id: string; rank?: number; slot: CtlAccountSlot; label: string }
}

export interface CtlAccountWindow {
  percent: number | null
  resetsAt: string | null
  /** `live`: the active account's poll; `parked`: its own token; `estimated`: the reset passed. */
  source: 'live' | 'parked' | 'estimated' | 'none'
}

/** A saved Claude account as the CLI shows it. */
export interface CtlAccountInfo {
  id: string
  provider: 'claude'
  /** app 2.4.0: 1-based priority (#1 first); `account use <n>` takes it. */
  rank: number
  /** Derived from the rank, kept for one release (compat). */
  slot: CtlAccountSlot
  /** The user's label ('' = show #rank). A label with an `@` comes as ''. */
  label: string
  /** Subscription type (pro, max...), when known. */
  plan: string | null
  active: boolean
  /** False when the saved login must be captured again on the desktop. */
  ready: boolean
  fiveHour: CtlAccountWindow
  sevenDay: CtlAccountWindow
}

export interface CtlAccountStatus {
  /** False when this machine cannot keep saved logins (no encryption, keychain). */
  supported: boolean
  /** The live Claude login: a saved account, another one, or none. */
  live: 'known' | 'unknown' | 'none'
  /**
   * The live login changed and is not identified yet (AccountService's
   * liveUnverified): `live` and `active` still show the last known login, and
   * a switch answers `busy` until a Claude console used the new one.
   */
  unverified?: true
  active: CtlAccountInfo | null
  accounts: CtlAccountInfo[]
  /** Account ids; `reason` is manual, phone, cli, auto_exhausted, auto_return, external or rollback. */
  lastSwitch: { at: number; from: string | null; to: string; reason: string } | null
  auto: { enabled: boolean; switchAtPercent: number; paused: string | null }
}

/** `account use` data. `changed: false`: that account was already the live one (nothing written, the last switch did not move). */
export interface CtlAccountUseResult {
  active: CtlAccountInfo
  changed: boolean
}

// --- Bus main -> renderer --------------------------------------------------
// Rides the remote control relay (remote:controlCmd / remote:controlResult,
// CONTRATOS): the action is `{ kind: 'cli', op }`, which the phone schema can
// never produce.

/** One console as the renderer lists it (grid order). */
export interface CtlListPane {
  id: string
  title: string
  type: PaneType
  presetId?: string
  /** pane.setupId (a Connection Profile of its own; '' = none on purpose). */
  setupId?: string
  /** Only on a console visiting from another workspace: its home (closing this workspace sends it back there). */
  homeWorkspaceId?: string
}

export interface CtlListWorkspace {
  id: string
  name: string
  cwd: string
  setupId?: string
  /** app 2.3.0. */
  favorite?: true
  note?: string
  taskState?: WorkspaceTaskState
  /** Panes in grid order. */
  panes: CtlListPane[]
}

export interface CtlListPreset {
  id: string
  name: string
  type: PaneType
}

export interface CtlListData {
  /** Sidebar order (favorites first, the same numbers as Alt+1..9). */
  workspaces: CtlListWorkspace[]
  activeWorkspaceId: string | null
  presets: CtlListPreset[]
  /** paneId -> CLI status line (transient). */
  statusLines: Record<string, string>
}

export type CtlRendererOp =
  | { kind: 'list' }
  | { kind: 'open'; workspaceId: string; paneId?: string }
  | { kind: 'composer'; cwd: string; name?: string }
  | { kind: 'spawn'; workspaceId: string; presetId?: string; paneType?: PaneType; title?: string; prompt?: string; focus: boolean; noProfile: boolean }
  | { kind: 'read'; paneId: string; lines: number }
  | { kind: 'setStatusLine'; paneId: string; text: string | null }
  | { kind: 'setNote'; workspaceId: string; note?: string | null; taskState?: WorkspaceTaskState | null }
  | { kind: 'attention'; paneId: string }
  // app 2.3.0: kills stay explicit (killPanePtys), never an Enter.
  /** `running`: main's view (it owns the ptys); false = nothing to stop, no "stopped" toast. */
  | { kind: 'kill'; workspaceId: string; paneId: string; close: boolean; running?: boolean }
  | { kind: 'restart'; workspaceId: string; paneId: string; resume?: boolean }
  | { kind: 'renamePane'; workspaceId: string; paneId: string; title: string }
  | { kind: 'createWorkspace'; name: string; cwd: string; focus: boolean }
  | { kind: 'renameWorkspace'; workspaceId: string; name: string }
  | { kind: 'deleteWorkspace'; workspaceId: string }
  | { kind: 'setFavorite'; workspaceId: string; favorite: boolean }
  | { kind: 'openNote'; workspaceId: string; noteId: string }

export interface CliCtlAction {
  kind: 'cli'
  op: CtlRendererOp
}

/** Payload of a successful renderer op (`RemoteCommandResult.data`). */
export interface CtlRendererData {
  list: CtlListData
  spawn: { paneId: string; index: number; promptDelivery: 'argv' | 'gate' | 'none' }
  read: { lines: string[] }
  createWorkspace: { workspaceId: string; index: number }
}

// --- Settings UI ---------------------------------------------------------

/** cli:state (Settings > Automation). Never carries a token. */
export interface CliUiState {
  enabled: boolean
  running: boolean
  endpoint: string | null
  startedAt: number | null
  shimPath: string
  binDir: string
  portable: boolean
  /** <dataDir>\bin is in the user PATH (HKCU\Environment), Windows only. */
  inUserPath: boolean
  error?: string
}

export type SkillState = 'missing' | 'installed' | 'outdated' | 'foreign'

/** Which agent's skills folder a skill op acts on: Claude Code or Codex. */
export type SkillTarget = 'claude' | 'codex'

export const SKILL_TARGETS: readonly SkillTarget[] = ['claude', 'codex']

export interface SkillStatus {
  state: SkillState
  /** The agent this status is about. */
  target: SkillTarget
  /** Version written in our marker, when there is one. */
  version?: string
  path: string
  error?: string
}

export type SkillOp = 'status' | 'install' | 'remove' | 'repair'

export const SKILL_OPS: readonly SkillOp[] = ['status', 'install', 'remove', 'repair']

/** cli:skill payload. `target` is optional: absent means 'claude' (the pre-Codex form). */
export interface SkillRequest {
  op: SkillOp
  target?: SkillTarget
}
