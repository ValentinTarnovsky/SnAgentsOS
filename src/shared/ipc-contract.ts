/**
 * IPC request/response/event payload shapes and the typed bridge surface
 * exposed on `window.snApi`. The SnApi interface grows phase by phase.
 */
import type { ConfigFile, SetupStep, UsageSettings } from './types'

export interface AppInfo {
  version: string
  platform: string
  arch: string
  portable: boolean
  configPath: string | null
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
}

/** Streamed while an update is downloading. */
export interface UpdateProgress {
  /** 0..100 */
  percent: number
  transferred: number
  total: number
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
  args?: string[]
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
}
export interface PtySpawnRes {
  ptyId: string
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
}
export interface PtyReattachRes {
  ptyId: string
  /** Recent raw output to replay into the freshly-mounted terminal. */
  replay: string
}
export interface PtyFlowReq {
  ptyId: string
  pause: boolean
}

/** The object exposed on window.snApi via contextBridge. */
export interface SnApi {
  platform: string
  /** Resolve the absolute path of a dropped File (Electron webUtils). */
  filePath(file: unknown): string
  app: {
    info(): Promise<AppInfo>
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
  }
  dialog: {
    /** Opens a native folder picker; resolves to the chosen path or null. */
    openDirectory(): Promise<string | null>
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
    /**
     * Fires after system resume, screen unlock, or a GPU process crash, the
     * moments where WebGL texture memory can come back corrupted. Terminals
     * rebuild their glyph atlases on it. Returns an unsubscribe function.
     */
    onDisplayRecovered(cb: () => void): () => void
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
}
