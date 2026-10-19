/**
 * IPC request/response/event payload shapes and the typed bridge surface
 * exposed on `window.snApi`. The SnApi interface grows phase by phase.
 */
import type {
  AgentSessionEndEvt,
  AgentSettings,
  AwakeMode,
  ConfigFile,
  Language,
  NotificationSettings,
  PaneStatusEvt,
  RemoteSettings,
  SetupStep,
  StatusHooksStatusRes,
  TerminalSnapshotMode,
  UsageSettings,
} from './types'
import type { AgentSessionView, AgentsChangedEvt, AgentsReadyEvt, AgentsStartup } from './agents'
import type { AgentsHibernateEvt, HibernationConfig } from './hibernation'
import type { SessionSummary, SessionsListReq } from './session-history'
import type {
  RemoteCtlAction,
  RemoteEndpointKind,
  RemoteStateSnapshot,
} from './remote-protocol'
import type { InitialPromptReq, LaunchKind, SubmitError } from './initialPrompt'
import type { GitArea, GitChangesRes, GitDiffReply, GitInfoRes, GitTarget, GitUpdateEvt } from './git-types'
import type { WorktreeAddReq, WorktreeAddRes, WorktreeInspectRes, WorktreeListRes, WorktreeProbeRes, WorktreeRemoveReq, WorktreeRemoveRes } from './worktree-types'
import type { OpenPathReq, OpenPathRes } from './inertOpen'
import type { RepoConfigExportRes, RepoConfigFile, RepoConfigPreviewRes, RepoConfigReadRes, RepoConfigTrustRes } from './repo-config'
import type { ReviewNote, ReviewNoteInput, ReviewNotesChangedEvt, ReviewNotesDeleteReq, ReviewNotesListRes, ReviewNotesMarkSentReq } from './review-notes'
import type { CliCtlAction, CliUiState, SkillOp, SkillStatus } from './ctl-protocol'

export type { GitArea, GitChangesRes, GitDiffError, GitDiffHunk, GitDiffLine, GitDiffReply, GitDiffRes, GitError, GitFileEntry, GitInfoRes, GitSummary, GitTarget, GitUpdateEvt } from './git-types'

/**
 * "PC awake" state (contract `power:state`). `reason: 'agents'` covers both a
 * working agent and an agent waiting on a connected phone; the 120 s grace
 * shows as `blocking: true` with `releaseAt`.
 */
export interface PowerState {
  blocking: boolean
  reason: 'agents' | 'always' | null
  mode?: AwakeMode
  display?: boolean
  /** Fresh `working` panes counted by Auto. */
  workingCount?: number
  /** Epoch ms when the grace ends and the block is released (grace only). */
  releaseAt?: number
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  portable: boolean
  configPath: string | null
}

// --- Crash resilience (E4-FR-19..25) ------------------------------------------

/** Where a render error was caught. */
export type RenderErrorScope = 'pane' | 'paneCell' | 'titlebar' | 'app' | 'root' | 'window'

/** One render error, from a boundary, the root handlers, window.onerror or unhandledrejection. */
export interface RenderErrorReport {
  scope: RenderErrorScope
  paneId?: string
  message: string
  /** <= 8KB (main trims again). */
  stack?: string
  /** React component stack, <= 8KB. */
  componentStack?: string
  at: number
}

/** Pending "the window recovered" data, consumed once by `app:takeRecovery`. */
export interface RecoveryInfo {
  at: number
  reason: string
  exitCode: number
  /** Live consoles when the renderer takes it (after its reconcile). */
  consoles: number
  autoReloadsInWindow: number
}

/** What the renderer adds to `app:diagnostics` (counts only, never contents). */
export interface RendererDiagnostics {
  renderErrors: RenderErrorReport[]
  workspaces: number
  panes: number
  connections: number
  snippets: number
  lang: string
}

/** One JSON file under dataDir()/crashes (last 20 kept, <= 16KB each, never uploaded). */
export interface CrashRecord {
  id: string
  kind: 'render-process-gone' | 'render-error' | 'unresponsive'
  at: number
  version: string
  reason?: string
  exitCode?: number
  scope?: RenderErrorScope
  paneId?: string
  message?: string
  /** <= 8KB. */
  stack?: string
  /** <= 8KB. */
  componentStack?: string
}

/** A folder to open from `--open` (E4-FR-32/33). The id lets the renderer skip a request it already handled (reload). */
export interface OpenRequest {
  id: string
  path: string
  source: 'argv' | 'second-instance'
}

/** State of the Explorer "Open in" menu keys (E4-FR-34). */
export interface ExplorerMenuResult {
  ok: boolean
  registered: boolean
  /** Exe the registered command launches. */
  exe?: string
  /** Exe this run would register. */
  currentExe?: string
  /** Registered, but for another exe (a portable and an installed copy, a moved portable). */
  mismatch?: boolean
  error?: string
  skipped?: 'not-windows' | 'dev'
}

/** Phases of the 1.x migration marker (mirrors LEGACY_PHASES in main's legacyMarker.ts). */
export type LegacyPhase = 'migrating' | 'verified' | 'backedUp' | 'committed' | 'cleaning' | 'done' | 'failed'

/** What only the user can do about 1.x: items left skipped: needsElevation (E0-FR-10). */
export type LegacyManualAction = 'uninstallPerMachine' | 'trashMacApp'

/**
 * The 1.x migration as the renderer sees it (E0-FR-10, 28, 35), derived in
 * main from the marker. Paths are computed in main and only shown; no channel
 * takes a path back from the renderer.
 */
export interface LegacyDataInfo {
  phase: LegacyPhase | null
  outcome: 'migrated' | 'noLegacy' | null
  counts: { workspaces: number; presets: number; devices: number; backups: number } | null
  cleanup: { pending: number; deferred: number; done: number; skipped: number }
  /** Some item deferred and cleanupStarts >= 5. */
  showDeferredBanner: boolean
  failure: { phase: LegacyPhase; attempts: number } | null
  /** migration-backup-v1.zip while it exists (null after its expiry). */
  backup: { path: string; expiresAt: number } | null
  pinRetargeted: boolean | null
  manualActions: LegacyManualAction[]
  /** Windows: settings.remote.enabled or migrated devices; the new exe path triggers the firewall prompt. */
  firewallHint: boolean
  noticeSeen: boolean
}

/**
 * How a downloaded update will be applied, derived from the OS + install type.
 *  - win-installer  : run the NSIS setup (upgrades + relaunches)
 *  - win-portable   : swap the portable exe in place, then relaunch
 *  - mac-dmg        : open the dmg (manual drag; unsigned can't auto-install)
 *  - linux-appimage : swap the AppImage in place, then relaunch
 *  - linux-deb      : open the .deb with the system handler
 *  - open           : update exists but no matching asset; open the release page
 *  - none           : already up to date / check failed
 */
export type InstallKind =
  | 'win-installer'
  | 'win-portable'
  | 'mac-dmg'
  | 'linux-appimage'
  | 'linux-deb'
  | 'open'
  | 'none'

/** Result of an update check against the GitHub releases API. */
export interface UpdateInfo {
  /** True when the latest published release is newer than the running app. */
  available: boolean
  currentVersion: string
  /** Latest release version (no leading "v"), or null when unknown. */
  latestVersion: string | null
  /** Release notes (the GitHub release body, markdown). */
  notes: string
  /** GitHub release page URL (for "view release" / manual download). */
  releaseUrl: string | null
  /** True when an asset matching this OS + install type can be downloaded. */
  installable: boolean
  /** How the update would be applied on this machine. */
  installKind: InstallKind
  /** Set when the check itself failed (network/API error). */
  error?: string
  /**
   * Ready releases newer than the running app (E4-FR-14): published, with this
   * build's asset and its `.sha256`. 30 means "30 or more"; 0 when unknown.
   */
  newerCount: number
  /** Notes of those releases, newest first, at most 64 KB of notes in total. */
  missed: ReleaseSummary[]
  /** Newest published version still missing assets (mid-CI): re-check in 10 min. */
  newestNotReady?: string
}

/** One release the user is behind on (E4-FR-14). */
export interface ReleaseSummary {
  version: string
  /** Release body (markdown), possibly cut by the 64 KB notes budget. */
  notes: string
  url: string | null
  publishedAt: string | null
}

/**
 * Install error raised when the chosen asset has no "<asset>.sha256" sidecar
 * (E0-FR-25). The renderer shows update.error.missingChecksum for it.
 */
export const MISSING_CHECKSUM = 'missing-checksum'

/** Streamed while an update is downloading. */
export interface UpdateProgress {
  /** 0..100 */
  percent: number
  transferred: number
  total: number
}

/**
 * Where the self-update stands, owned by main (E4-FR-37). 'installing' means
 * the download reached 100% and the apply step has not resolved yet; 'opened'
 * means an installer/file was opened and the app keeps running.
 */
export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'installing' | 'opened' | 'failed'

/** main's update state, rehydrated by the renderer after a reload (E4-FR-37). */
export interface UpdateState {
  phase: UpdatePhase
  progress: UpdateProgress | null
  installError: string | null
  info: UpdateInfo | null
}

/** Live resource usage of the app (its own Electron processes). */
export interface AppMetrics {
  /** Total working-set memory across all app processes, in MB. */
  memMB: number
  /** Total CPU usage across all app processes, in percent (can exceed 100). */
  cpuPercent: number
  /** Number of Electron processes (main + renderer + gpu + utility). */
  processes: number
  /** Number of running console processes (ptys). */
  consoles: number
  /** Headless snapshot engine instrumentation (E6-FR-07); absent from older mains. */
  headless?: HeadlessMetrics
}

/** Headless mirrors in main (E6-FR-07): live count, p95 timings in ms and counters. */
export interface HeadlessMetrics {
  panes: number
  parseMsP95: number
  snapshotMsP95: number
  bytesParsed: number
  snapshotCacheHits: number
}

/**
 * Terminal engine settings main applies to its headless mirrors (E6-FR-01/06/08/14),
 * pushed on `pty:setEngine` and normalized by `normalizeEngine` (src/shared/terminalEngine.ts).
 */
export interface TerminalEngineSettings {
  snapshotMode: TerminalSnapshotMode
  unicode11: boolean
  persist: boolean
  /** 200..5000; the mirror keeps max(REPLAY_LINES, persistLines) rows. */
  persistLines: number
  /** PowerShell integration (E6-FR-25, R31-01); absent until that setting exists. */
  shellIntegration?: boolean
}

/** One bar in the live usage widget (a quota window or a custom token counter). */
export interface UsageRow {
  /** Stable id, e.g. 'claude.5h', 'codex.7d', 'custom.<rowId>'. */
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
}

/** A full snapshot of every enabled usage row, pushed to the renderer. */
export interface UsageSnapshot {
  rows: UsageRow[]
  /** Epoch ms the snapshot was produced. */
  updatedAt: number
  /** Anthropic service health, when the status dot is enabled. */
  services?: 'operational' | 'degraded' | 'down' | null
  error?: string | null
}

// --- PTY payloads (wired from F1) ---
export interface PtySpawnReq {
  /** Renderer-owned stable id tying the pty to a pane. */
  paneId: string
  /** Absolute path or command; undefined => OS default shell. */
  shell?: string
  /**
   * Shell arguments. A string is a raw Windows command line handed to
   * node-pty as is (cmd.exe `/s /c "..."` needs its own quoting; the array
   * form escapes every `"` as `\"`, which cmd does not understand).
   */
  args?: string[] | string
  cwd?: string
  env?: Record<string, string>
  /**
   * A command line typed into the shell after spawn (e.g. "claude").
   * Running inside the shell makes PATH/PATHEXT resolution work on Windows
   * and leaves an interactive shell when the command exits.
   */
  initialCommand?: string
  /**
   * Pre-launch sequence (e.g. SSH connect) run before `initialCommand`. The
   * main process drives it: each step optionally waits for the terminal to
   * print `waitFor`, then writes its text, so an interactive prompt like a
   * password can be answered automatically.
   */
  setup?: SetupStep[]
  cols: number
  rows: number
  /**
   * E6-FR-11: start from the pane's saved scrollback. Main honors it only on
   * the pane's first spawn in this app session; the renderer leaves it out
   * when the pane resumes a conversation (E6-FR-13).
   */
  restoreScrollback?: boolean
  /**
   * E8-FR-02b: 'claude' / 'codex' only when `initialCommand` is that preset's
   * own command (no `pane.command` override, no resume). Enables `argv`.
   */
  launchKind?: LaunchKind
  /**
   * One-shot initial prompt (Quick Command agent, composer, phone). Main picks
   * `argv` or the gate with the resolved shell (D1) and reports the outcome on
   * `pty:promptResult`. A restart never carries it.
   */
  initialPrompt?: InitialPromptReq
  /**
   * Workspace of the pane (reserved for the CLI, R30-11): the console token
   * and SNAOS_WORKSPACE_ID carry it. Absent = main looks it up in the config.
   */
  workspaceId?: string
}
/** E8-FR-02a: write text (and optionally a delayed Enter) into a live pty. */
export interface PtySubmitReq {
  ptyId: string
  /**
   * Amendment R22-12: the pane whose live pty gets the text when `ptyId` is
   * empty or stale (a phone Quick Command after a renderer reload, before the
   * pane remounted and registered its pty).
   */
  paneId?: string
  text: string
  enter: boolean
}
export type PtySubmitRes = { ok: true } | { ok: false; error: SubmitError }
/** Outcome of a spawn's initial prompt (main -> renderer). */
export interface PtyPromptResultEvt {
  paneId: string
  result: 'sent_argv' | 'sent_gate' | 'inserted_unconfirmed' | 'not_delivered' | 'dropped_exit'
}
/** Family of the shell a pty runs, derived from its executable name (E6). */
export type ShellKind = 'powershell' | 'cmd' | 'posix' | 'other'
export interface PtySpawnRes {
  ptyId: string
  /** Sanitized saved history + the "restarted - history from ..." separator, written before bind (E6-FR-11). */
  seed?: string
  shellKind: ShellKind
  /** E6-FR-32: the configured shell was not found, `used` was launched instead. */
  warning?: { kind: 'shellNotFound'; requested: string; used: string }
}
export interface PtyWriteReq {
  ptyId: string
  data: string
}
export interface PtyResizeReq {
  ptyId: string
  cols: number
  rows: number
}
export interface PtyDataEvt {
  ptyId: string
  data: string
}
export interface PtyExitEvt {
  ptyId: string
  exitCode: number
  signal?: number
  /** False when kill/killAll/restart caused the exit (E6-FR-17 shows the exit card only for natural exits). */
  natural?: boolean
}
export interface PtyReattachRes {
  ptyId: string
  /**
   * Screen to replay into the freshly-mounted terminal: the headless snapshot
   * (E6-FR-03), or in 'off' the mode rehydration (E6-FR-33) + the query-free ring.
   */
  replay: string
  /** Size the replay is laid out for (the pty's); the renderer writes it there, then refits (E6-FR-04). */
  cols: number
  rows: number
  /** Family of the live shell (E6-FR-22 cd prefix after a reattach). */
  shellKind: ShellKind
}
export interface PtyFlowReq {
  ptyId: string
  pause: boolean
}
/**
 * In-place restart (E6-FR-18/19, D2): the full launch request, so "restart
 * resuming the chat" goes through the same path that keeps the scrollback.
 * `fallbackDefaultShell` ignores `shell` (retry after a failed respawn).
 */
export type PtyRestartReq = Omit<PtySpawnReq, 'restoreScrollback'> & { fallbackDefaultShell?: boolean }
/** Saved scrollback on disk (E6-FR-12): live files only, the trash is not counted. */
export interface ScrollbackStats {
  files: number
  bytes: number
}
export interface PtyRestartRes {
  ptyId: string
  /** Soft reset of modes + the localized "--- restarted 14:32 ---" separator; written as is. */
  tail: string
  shellKind: ShellKind
  warning?: PtySpawnRes['warning']
}

// --- Claude status (state dots, badges, notifications) ---

/** Renderer -> main: an xterm OSC title change observed in one console. */
export interface StatusTitleReq {
  paneId: string
  title: string
}

// --- Remote control (embedded LAN/Tailscale server for phone clients) ---

export type RemoteServerState = 'stopped' | 'starting' | 'running' | 'error'

/**
 * One reachable address the phone can use (LAN NIC, Tailscale, ...). The
 * secure mode's `tailscaleHttps` endpoint has a `host` (the MagicDNS name)
 * and no `ip` (E3-FR-43); every other kind has an `ip`.
 */
export interface RemoteEndpoint {
  ip?: string
  host?: string
  kind: RemoteEndpointKind
  url: string
}

/** Why turning the secure mode on failed or stopped working (E3-FR-42). */
export type SecureModeError =
  | 'not_installed' // no tailscale CLI
  | 'not_running' // tailscale is logged out or stopped
  | 'no_https' // MagicDNS or HTTPS certificates are off in the tailnet
  | 'port_busy' // another handler already serves https:443
  | 'funnel' // https:443 is exposed with Funnel: never touched
  | 'cli' // the CLI failed: `message` carries its stderr as is
  | 'server_off' // the remote server is not running

/** The secure mode as main sees it (`RemoteServerStatus.secure`, E3-FR-42). */
export interface SecureModeStatus {
  state: 'off' | 'checking' | 'on' | 'error'
  /** MagicDNS name (`machine.tailnet.ts.net`), while on. */
  dnsName?: string
  /** `https://<dnsName>`, while on. */
  url?: string
  error?: SecureModeError
  /** Raw CLI output for `cli`, the foreign handler for `port_busy`. */
  message?: string
}

export interface RemoteServerStatus {
  state: RemoteServerState
  port: number
  endpoints: RemoteEndpoint[]
  /** Live authed phone sessions. */
  connectedCount: number
  /** Bind/start failure detail (e.g. port in use). */
  error?: string
  /** Secure mode through `tailscale serve` (E3-FR-42). Absent = off. */
  secure?: SecureModeStatus
}

/** Device info safe to show in the renderer (never includes the secret). */
export interface SanitizedDevice {
  id: string
  name: string
  createdAt: number
  lastSeen: number
  /** True while the device has at least one live authed socket. */
  connected: boolean
}

/** An in-flight pairing request awaiting the user's Allow/Deny. */
export interface PendingPairingInfo {
  requestId: string
  deviceName: string
  ip: string
  expiresAt: number
}

/** Everything the QR modal needs: one code, one QR per reachable endpoint. */
export interface PairingQrPayload {
  code: string
  expiresAt: number
  endpoints: Array<{ ip?: string; host?: string; kind: RemoteEndpointKind; url: string; qrDataUrl: string }>
}

/** Pushed to the renderer whenever server status / devices / pairing change. */
export interface RemoteUiState {
  status: RemoteServerStatus
  devices: SanitizedDevice[]
  pendingPairing: PendingPairingInfo | null
}

// --- Remote firewall check / fix (E2-FR-38/39, Windows only) ---

/** Network category of an endpoint as Get-NetConnectionProfile reports it. */
export type FirewallProfile = 'Private' | 'Public' | 'DomainAuthenticated' | 'unknown'

export interface FirewallEndpointCheck {
  ip: string
  kind: RemoteEndpointKind
  profile: FirewallProfile
  networkName?: string
}

export interface FirewallBlockingRule {
  name: string
  displayName: string
  /** currentProgram: on the running exe; port: program-less; otherProgram: same file name elsewhere (never applies). */
  scope: 'currentProgram' | 'otherProgram' | 'port'
}

export interface FirewallStatus {
  /** Contract: state === 'ok'. */
  ok: boolean
  /** Contract: the worst profile among the endpoints. */
  profile: FirewallProfile
  /** Contract: an enabled Allow covers the current exe or the port. */
  ruleFound: boolean
  state: 'ok' | 'publicProfile' | 'blocked' | 'noRule' | 'unknown' | 'unsupported'
  port: number
  endpoints: FirewallEndpointCheck[]
  blockingRules: FirewallBlockingRule[]
  /** What [Fix] creates: a rule by program and port (installed) or by port only. */
  ruleScope: 'program' | 'port'
  /** False while a port Block (not ours to remove) applies. */
  fixable: boolean
  checkedAt: number
  detail?: string
}

export interface FirewallFixRes {
  ok: boolean
  /** cancelled (UAC 1223) | failed | timeout | notFixed | unsupported */
  error?: string
  cancelled?: boolean
  status?: FirewallStatus
}

/** A control action relayed main -> renderer for execution via store actions. */
export interface RemoteCommand {
  id: string
  /** A phone action, or an op of the snaos CLI bus (main-only, R30-11; the phone schema never accepts `cli`). */
  action: RemoteCtlAction | CliCtlAction
  /**
   * Name of the paired device that sent it (E4-FR-08). Main fills it from the
   * authenticated session and the DeviceRegistry, never from the payload.
   */
  deviceName?: string
  /** fitPane / releaseFit only (E3 M11, R30-04): what main knows about the pane. */
  fit?: RemoteCommandFit
}

/**
 * Main's extra data for the phone-fit ctls (amendment R30-04, additive): the
 * executor resizes the pty by `ptyId` even when the pane is not mounted;
 * `chat` = the owner reads it as Chat (the strip says "(Chat)", E3-FR-21);
 * `baseline` = the pty size before the phone took it, the fallback when the
 * renderer has not measured the pane since.
 */
export interface RemoteCommandFit {
  ptyId?: string
  chat?: boolean
  baseline?: { cols: number; rows: number }
}

/** remote:fitRelease (E3-FR-17/19): one pane or every phone-sized pane. */
export type RemoteFitReleaseReq = { paneId: string } | { all: true }

export interface RemoteCommandResult {
  id: string
  ok: boolean
  error?: string
  /** createPane: id of the freshly created pane. */
  paneId?: string
  /** globalPrompt: number of consoles written to. */
  info?: number
  /** createPane with a prompt that could not go on the command line (E2-FR-11). */
  promptFallback?: boolean
  /** A CLI bus op's payload (R30-11); never relayed to phones. */
  data?: unknown
}

/** The object exposed on window.snApi via contextBridge. */
export interface SnApi {
  platform: string
  /** Resolve the absolute path of a dropped File (Electron webUtils). */
  filePath(file: unknown): string
  app: {
    info(): Promise<AppInfo>
    /** State of the 1.x migration (E0-FR-10). */
    legacyInfo(): Promise<LegacyDataInfo>
    /** Closes the welcome notice for good (noticeSeen in the marker). */
    legacyAck(): void
    /** Reveals migration-backup-v1.zip in the file manager (path resolved in main). */
    legacyShowBackup(): void
    /** Opens logs/legacy-migration.log (path resolved in main). */
    legacyOpenLog(): void
    /** Pushed on every marker change. Returns an unsubscribe function. */
    onLegacyStatus(cb: (info: LegacyDataInfo) => void): () => void
    /** Manual window reload (resets the crash breaker, E4-FR-20). */
    reload(): void
    /** Recovery data after an automatic reload, once; null otherwise (E4-FR-22). */
    takeRecovery(): Promise<RecoveryInfo | null>
    /** Report a render error to main's crash log (E4-FR-23). */
    reportRenderError(report: RenderErrorReport): void
    /** Allowlisted, redacted diagnostics markdown (E4-FR-24). */
    diagnostics(renderer: RendererDiagnostics): Promise<string>
    /** Consumes the open request main is holding (E4-FR-33), or null. */
    takePendingOpen(): Promise<OpenRequest | null>
    /** A folder arrived through `--open`. Returns an unsubscribe function. */
    onOpenPath(cb: (req: OpenRequest) => void): () => void
  }
  pty: {
    spawn(req: PtySpawnReq): Promise<PtySpawnRes>
    /** Rebind to an already-running pty for this paneId (renderer reload / remount). */
    reattach(paneId: string): Promise<PtyReattachRes | null>
    write(req: PtyWriteReq): void
    resize(req: PtyResizeReq): void
    kill(ptyId: string): Promise<void>
    /** Mark which panes belong to the visible workspace (drives output throttling). */
    setActive(paneIds: string[]): void
    /** Backpressure: pause/resume a pty when the renderer can't keep up. */
    flow(req: PtyFlowReq): void
    /** Returns an unsubscribe function. */
    onData(cb: (e: PtyDataEvt) => void): () => void
    /** Returns an unsubscribe function. */
    onExit(cb: (e: PtyExitEvt) => void): () => void
    /** Restart the pane's shell in place, keeping its output (E6-FR-18). Rejects when the spawn fails. */
    restart(req: PtyRestartReq): Promise<PtyRestartRes>
    /** Kill the ptys of these panes in main, by paneId (E4-FR-36). Resolves to how many were live. */
    killPanes(paneIds: string[]): Promise<number>
    /** Kill every pty whose pane is not in `livePaneIds` (after hydrate, E4-FR-36). */
    reconcile(livePaneIds: string[]): Promise<number>
    /** Push the terminal engine settings to main's headless mirrors (E6-FR-06). */
    setEngine(settings: TerminalEngineSettings): void
    /** The shared delivery path (E8-FR-02a): text, then Enter 150 ms after the queue drained. */
    submit(req: PtySubmitReq): Promise<PtySubmitRes>
    /** Initial prompt outcomes (E8-FR-02b). Returns an unsubscribe function. */
    onPromptResult(cb: (e: PtyPromptResultEvt) => void): () => void
  }
  /** Saved scrollback between restarts (E6-FR-12). */
  scrollback: {
    /** Delete a pane's saved history now, or move it to the trash (`trash: true`, pane closed). */
    clear(paneId: string, opts?: { trash?: boolean }): Promise<void>
    /** Delete every saved history (the global button, turning persistence off). */
    clearAll(): Promise<void>
    stats(): Promise<ScrollbackStats>
    /** The sanitized saved text of a pane, without consuming its seed; null when none. */
    load(paneId: string): Promise<string | null>
  }
  dialog: {
    /** Opens a native folder picker; resolves to the chosen path or null. */
    openDirectory(): Promise<string | null>
  }
  /** File system probes (E8-FR-08). */
  fs: {
    /** Whether an absolute path is an existing folder (true when the probe times out). */
    dirExists(path: string): Promise<boolean>
  }
  /**
   * Per-repo `.snagentsos.json` (E8-FR-23..27). Main reads, hashes and keeps
   * the trust (dataDir()/trusted-repos.json); the renderer only asks.
   */
  repoConfig: {
    /** Read and validate `<dir>/.snagentsos.json` (2 s timeout = `none`). */
    read(dir: string): Promise<RepoConfigReadRes>
    /** Approve the file; main re-hashes it first and answers `changed` when it moved on. */
    trust(req: { dir: string; sha256: string }): Promise<RepoConfigTrustRes>
    /** The exact JSON an export would write, and whether the file exists. */
    previewExport(req: { dir: string; file: RepoConfigFile }): Promise<RepoConfigPreviewRes>
    /** Write the file (never over an existing one without `overwrite`); the written hash is trusted. */
    export(req: { dir: string; file: RepoConfigFile; overwrite: boolean }): Promise<RepoConfigExportRes>
  }
  /** System clipboard, used for terminal copy/paste. */
  clipboard: {
    writeText(text: string): void
    readText(): Promise<string>
  }
  config: {
    /** Loads persisted config, or null if none / invalid. */
    load(): Promise<ConfigFile | null>
    /** Persists the full config blob (fire-and-forget; debounced by caller). */
    save(config: ConfigFile): void
    /** Save the config to a user-chosen file; resolves true if written. */
    export(config: ConfigFile): Promise<boolean>
    /** Pick + parse a config file; resolves null if cancelled/invalid. */
    import(): Promise<ConfigFile | null>
  }
  /** Custom title bar window controls (frame: false). */
  window: {
    minimize(): void
    /** Toggles maximize/restore. */
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    /** Fires on maximize/unmaximize; returns an unsubscribe function. */
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
    /**
     * Restore the window if minimized, show it from the tray and focus it;
     * flashes the taskbar button when Windows denies the focus (E2-FR-07).
     */
    reveal(): void
  }
  /** OS integration. */
  system: {
    /** Login item: no-ops on the portable build. */
    setLoginItem(enabled: boolean): Promise<void>
    getLoginItem(): Promise<boolean>
    /** Registers/unregisters the global show-app shortcut; resolves false if it couldn't bind. */
    setGlobalHotkey(enabled: boolean, accelerator: string): Promise<boolean>
    /** Snapshot of live resource usage (poll this for a real-time view). */
    getMetrics(): Promise<AppMetrics>
    /** Open a URL in the OS default browser. http/https/mailto only; others are ignored. */
    openExternal(url: string): void
    /** Open (inert extension) or reveal a phone-tapped path contained in cwd (E2-FR-30). */
    openPath(req: OpenPathReq): Promise<OpenPathRes>
    /**
     * Fires after system resume, screen unlock, or a GPU process crash, the
     * moments where WebGL texture memory can come back corrupted. Terminals
     * rebuild their glyph atlases on it. Returns an unsubscribe function.
     */
    onDisplayRecovered(cb: () => void): () => void
    /** Adds or removes the Explorer "Open in" menu (E4-FR-34). */
    setExplorerMenu(req: { enabled: boolean; language: Language }): Promise<ExplorerMenuResult>
    /** What the Explorer menu keys point at now. */
    getExplorerMenu(): Promise<ExplorerMenuResult>
  }
  /** Self-update via GitHub releases. */
  updates: {
    /** Query GitHub for the latest release and whether/how it can be installed. */
    check(): Promise<UpdateInfo>
    /**
     * Download the matching asset (progress on `onProgress`) and apply it. When
     * `relaunching` is true the app is about to quit so the installer/swap runs.
     */
    downloadAndInstall(): Promise<{ relaunching: boolean }>
    /** Subscribe to download progress; returns an unsubscribe function. */
    onProgress(cb: (p: UpdateProgress) => void): () => void
    /** main's update state (phase, progress, error, info), for a reload mid-download (E4-FR-37). */
    getState(): Promise<UpdateState>
    /** Subscribe to main's update state on every phase change; returns an unsubscribe function. */
    onState(cb: (s: UpdateState) => void): () => void
  }
  /** Live usage / quota bars (Claude OAuth + Codex rollout + custom models). */
  usage: {
    /** Current cached snapshot (kicks a background refresh). */
    get(): Promise<UsageSnapshot>
    /** Force a full refresh of every source and return the fresh snapshot. */
    refresh(): Promise<UsageSnapshot>
    /** Push the latest usage settings so main can (re)schedule its pollers. */
    setConfig(cfg: UsageSettings): void
    /** Subscribe to pushed snapshots; returns an unsubscribe function. */
    onUpdate(cb: (s: UsageSnapshot) => void): () => void
  }
  /** Claude status: per-console state dots, badges, notifications. */
  status: {
    /** Relay an xterm OSC title change (the structured Claude state channel). */
    reportTitle(paneId: string, title: string): void
    /** Panes currently in view (active workspace minus minimized); drives notify rules. */
    setViewed(paneIds: string[]): void
    /** Push NotificationSettings so main keeps notify rules + HookServer in sync. */
    setConfig(cfg: NotificationSettings): void
    /** Per-console state updates. Returns an unsubscribe function. */
    onState(cb: (e: PaneStatusEvt) => void): () => void
    snapshot(): Promise<PaneStatusEvt[]>
    health(): Promise<import('./types').StatusHealth>
    testDiscord(cfg: import('./types').DiscordSettings): Promise<{ ok: boolean; error?: string }>
    testDesktop(): Promise<void>
    /** Publish a test push with the saved ntfy config (E2-FR-40). */
    testNtfy(): Promise<{ ok: boolean; error?: string }>
    /** Fired when a status notification is clicked (reveal that console). */
    onReveal(cb: (paneId: string) => void): () => void
    /** Claude's main session ended on its own (E6-FR-21). Returns an unsubscribe function. */
    onSessionEnd(cb: (e: AgentSessionEndEvt) => void): () => void
    /** Write our hook block into ~/.claude/settings.json. */
    hooksInstall(cfg: NotificationSettings): Promise<StatusHooksStatusRes>
    /** Remove every hook handler of ours from ~/.claude/settings.json. */
    hooksUninstall(): Promise<StatusHooksStatusRes>
    hooksStatus(): Promise<StatusHooksStatusRes>
  }
  /** Remote control from a phone browser (embedded LAN/Tailscale server). */
  remote: {
    /** Push RemoteSettings; main diffs and starts/stops/restarts the server. */
    setConfig(cfg: RemoteSettings): void
    /** Current server status + paired devices + pending pairing. */
    getState(): Promise<RemoteUiState>
    /** Open a pairing window: mints the code + QR per endpoint, or null if the server is down. */
    pairingBegin(): Promise<PairingQrPayload | null>
    /** QR modal closed: invalidate the active pairing code. */
    pairingCancel(): void
    /** User answered the Allow/Deny prompt for a pending pairing request. */
    pairingResolve(requestId: string, allow: boolean): void
    /** Forget a paired device and kill its live sessions immediately. */
    revokeDevice(deviceId: string): Promise<void>
    /** Renderer -> main state sync (debounced compact snapshot for phones). */
    pushState(snapshot: RemoteStateSnapshot): void
    /** Control commands from phones, to run through store actions. Returns unsubscribe. */
    onCommand(cb: (cmd: RemoteCommand) => void): () => void
    /** Report the outcome of an onCommand execution back to main. */
    commandResult(res: RemoteCommandResult): void
    /** Server status / device list / pairing events. Returns unsubscribe. */
    onEvent(cb: (s: RemoteUiState) => void): () => void
    /** Windows firewall + network profile check (cached 60s unless force). */
    firewallCheck(force?: boolean): Promise<FirewallStatus>
    /** One-click elevated fix (UAC), then a fresh check. */
    firewallFix(): Promise<FirewallFixRes>
    /** Open Windows network settings (ms-settings:network-status). */
    openNetworkSettings(): void
    /**
     * Give a phone-sized pane (or all of them) back to the desktop (E3-FR-17/19):
     * the strip's [Recover] / [Restore all] and a real key or paste in the pane.
     * A no-op without the remote server.
     */
    fitRelease(req: RemoteFitReleaseReq): void
    /**
     * Turn the secure mode on or off (E3-FR-42): main runs the tailscale CLI
     * and answers with the result. The renderer saves `settings.remote.https`
     * only after an `on` (or after turning it off).
     */
    secureSet(enabled: boolean): Promise<SecureModeStatus>
  }
  /** Keep the PC awake while agents work (E5-FR-23/24). */
  power: {
    /** Push settings.awakeMode; main answers with a power:state. */
    setConfig(mode: AwakeMode): void
    /** Current state (later changes arrive on onState). */
    getState(): Promise<PowerState>
    /** Every state change, including a mode picked from the tray. Returns unsubscribe. */
    onState(cb: (s: PowerState) => void): () => void
  }
  /** Agent behavior settings and durable sessions (E5 G2). */
  agents: {
    /** Push settings.agents so main applies awakeDisplay (and later keys). */
    setConfig(cfg: AgentSettings): void
    /** Every recorded session (availability re-checked in main). */
    list(): Promise<AgentSessionView[]>
    /** How the previous run ended and which panes it interrupted (stable for the run). */
    startup(): Promise<AgentsStartup>
    /** True only for the first spawn of a pane in this run (survives renderer reloads). */
    consumeStartup(paneId: string): Promise<boolean>
    /** Which of these panes have not spent their startup decision yet; spends nothing (E5-FR-12). */
    startupPending(paneIds: string[]): Promise<string[]>
    /** Drop a pane's session ("Restart with a new chat"). */
    forget(paneId: string): void
    /** A session view changed in a visible field, or was removed. Returns unsubscribe. */
    onChanged(cb: (e: AgentsChangedEvt) => void): () => void
    /** A session started, or reached its first idle after a start. Returns unsubscribe. */
    onReady(cb: (e: AgentsReadyEvt) => void): () => void
    /** Hibernation setting and the consoles to keep awake (visible or about to run), E5-FR-25. */
    setHibernation(cfg: HibernationConfig): void
    /** Main put a console to sleep (its pty is gone). Returns unsubscribe. */
    onHibernate(cb: (e: AgentsHibernateEvt) => void): () => void
  }
  /** Session history (E3-FR-36..40): Claude transcripts and Codex rollouts indexed by main. */
  sessions: {
    /** Newest first; empty sessions are never listed. */
    list(req?: SessionsListReq): Promise<SessionSummary[]>
  }
  /** Review notes of the Changes panel (E7-FR-17..21), stored by main per workspace. */
  /** snaos CLI (E8-FR-12..22, R30-11). Nothing here ever carries a token. */
  cli: {
    /** settings.cliEnabled: starts or stops the control server (same endpoint and tokens). */
    setEnabled(enabled: boolean): void
    state(): Promise<CliUiState>
    skill(op: SkillOp): Promise<SkillStatus>
    /** Adds (true) or removes (false) <dataDir>\bin in the user PATH; false when it failed or is not available. */
    userPath(enabled: boolean): Promise<boolean>
  }
  reviewNotes: {
    list(workspaceId: string): Promise<ReviewNotesListRes>
    /** Create or edit; editing the text drops `sentAt`. Rejects on invalid input or past 500 notes. */
    upsert(note: ReviewNoteInput): Promise<ReviewNote>
    delete(req: ReviewNotesDeleteReq): Promise<void>
    markSent(req: ReviewNotesMarkSentReq): Promise<void>
    /** Drop the notes of workspaces that no longer exist. */
    prune(workspaceIds: string[]): void
    onChanged(cb: (e: ReviewNotesChangedEvt) => void): () => void
  }
  /** Git chip (E7-FR-05..10). Main runs git; the renderer owns the targets and settings.gitChip. */
  git: {
    /** Replace the watched targets (workspace cwds and pane worktrees). */
    setWatch(targets: GitTarget[]): void
    /** settings.gitChip: off stops the background refresh; on-demand refreshes keep working. */
    setConfig(cfg: { gitChip: boolean }): void
    /** Refresh now ('manual', all targets when no keys) or after an agent finished ('agent', debounced). */
    refresh(req?: { keys?: string[]; reason?: 'manual' | 'agent' }): void
    /** Which git is on PATH (cached; force re-checks). */
    info(force?: boolean): Promise<GitInfoRes>
    /** Summaries, only when one changes by value. Returns an unsubscribe function. */
    onUpdate(cb: (e: GitUpdateEvt) => void): () => void
    /** The open Changes panel's target (main polls it every 3 s while focused), or null when closed. */
    setPanel(key: string | null): void
    /** The panel's file list with per-area line counts; null when the target is not a readable repo. */
    status(key: string): Promise<GitChangesRes | null>
    /** One listed file's diff; `force` renders a too-large diff anyway. */
    fileDiff(req: { key: string; path: string; area: GitArea; force?: boolean }): Promise<GitDiffReply>
    /** Open a listed file with its default app (allowlisted extensions only) or reveal it in its folder. */
    openFile(req: { key: string; path: string; reveal?: boolean }): Promise<boolean>
    /** Create an isolated worktree on a new sn/<slug> branch (E7-FR-28). */
    worktreeAdd(req: WorktreeAddReq): Promise<WorktreeAddRes>
    /** Delete a managed worktree (and its branch); main kills the pane's pty first (E7-FR-30). */
    worktreeRemove(req: WorktreeRemoveReq): Promise<WorktreeRemoveRes>
    /** Is this folder a repo with commits; its HEAD for the launch dialog (E7-FR-27). */
    worktreeProbe(repoCwd: string): Promise<WorktreeProbeRes>
    /** Exists, dirty files, commits over the base, merged into the repo HEAD (E7-FR-30/36). */
    worktreeInspect(req: { path: string; base?: string }): Promise<WorktreeInspectRes>
    /** Manifest entries plus scanned folders under the roots (E7-FR-31). */
    worktreeList(): Promise<WorktreeListRes>
    /** Open a managed worktree folder in the file manager. */
    worktreeReveal(path: string): Promise<boolean>
  }
}
