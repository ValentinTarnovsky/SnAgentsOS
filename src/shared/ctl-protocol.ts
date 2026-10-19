/**
 * Local control protocol of the `snaos` CLI (E8-FR-12..22). HTTP/1.1 over a
 * named pipe (Windows) or a 0600 unix socket, never TCP: POST /v1/rpc with
 * `Authorization: Bearer <token>`. HTTP 200 whenever the token is valid (the
 * error goes in the body); 401 bad token, 403 any `Origin`, 413 body > 1 MB.
 *
 * Kept free of runtime imports besides types: the CLI entry (cliEntry.ts,
 * Node core only) bundles it next to main.
 */
import type { AttentionReason, ClaudePaneState, PaneType, WorkspaceTaskState } from './types'

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

export type CtlMethod = 'ping' | 'ls' | 'open' | 'spawn' | 'send' | 'read' | 'wait' | 'status' | 'notify' | 'note'

export const CTL_METHODS: readonly CtlMethod[] = ['ping', 'ls', 'open', 'spawn', 'send', 'read', 'wait', 'status', 'notify', 'note']

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

export interface CtlError {
  code: CtlErrorCode
  message: string
}

/** `data` on an error carries extra context (a `wait` timeout: `{ state, waitedMs }`). */
export type CtlResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: CtlError; data?: unknown }

/**
 * Process exit code per error (E8-FR-14): 0 ok, 1 internal, 2 usage, 3 not
 * found, 4 ambiguous, 5 app unavailable, 6 unauthorized, 7 forbidden or
 * disabled, 124 timeout.
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
}

export interface CtlConsoleInfo {
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
  note?: string
  taskState?: WorkspaceTaskState
  consoles: CtlConsoleInfo[]
}

export interface CtlWaitResult {
  state: ClaudePaneState | null
  precise: boolean
  waitedMs: number
  noTurnObserved?: boolean
}

export interface CtlSpawnResult {
  paneId: string
  index: number
  workspaceId: string
  promptDelivery: 'argv' | 'gate' | 'none'
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
}

export interface CtlListWorkspace {
  id: string
  name: string
  cwd: string
  setupId?: string
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
  | { kind: 'composer'; cwd: string }
  | { kind: 'spawn'; workspaceId: string; presetId?: string; paneType?: PaneType; title?: string; prompt?: string; focus: boolean; noProfile: boolean }
  | { kind: 'read'; paneId: string; lines: number }
  | { kind: 'setStatusLine'; paneId: string; text: string | null }
  | { kind: 'setNote'; workspaceId: string; note?: string | null; taskState?: WorkspaceTaskState | null }
  | { kind: 'attention'; paneId: string }

export interface CliCtlAction {
  kind: 'cli'
  op: CtlRendererOp
}

/** Payload of a successful renderer op (`RemoteCommandResult.data`). */
export interface CtlRendererData {
  list: CtlListData
  spawn: { paneId: string; index: number; promptDelivery: 'argv' | 'gate' | 'none' }
  read: { lines: string[] }
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
