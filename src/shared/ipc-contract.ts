/**
 * IPC request/response/event payload shapes and the typed bridge surface
 * exposed on `window.snApi`. The SnApi interface grows phase by phase.
 */
import type { ConfigFile, SetupStep } from './types'

export interface AppInfo {
  version: string
  platform: string
  arch: string
  portable: boolean
  configPath: string | null
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
  }
}
