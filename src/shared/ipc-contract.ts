/**
 * IPC request/response/event payload shapes and the typed bridge surface
 * exposed on `window.snApi`. The SnApi interface grows phase by phase.
 */
import type { ConfigFile } from './types'

export interface AppInfo {
  version: string
  platform: string
  arch: string
  portable: boolean
  configPath: string | null
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

/** The object exposed on window.snApi via contextBridge. */
export interface SnApi {
  platform: string
  app: {
    info(): Promise<AppInfo>
  }
  pty: {
    spawn(req: PtySpawnReq): Promise<PtySpawnRes>
    write(req: PtyWriteReq): void
    resize(req: PtyResizeReq): void
    kill(ptyId: string): Promise<void>
    /** Returns an unsubscribe function. */
    onData(cb: (e: PtyDataEvt) => void): () => void
    /** Returns an unsubscribe function. */
    onExit(cb: (e: PtyExitEvt) => void): () => void
  }
  dialog: {
    /** Opens a native folder picker; resolves to the chosen path or null. */
    openDirectory(): Promise<string | null>
  }
  config: {
    /** Loads persisted config, or null if none / invalid. */
    load(): Promise<ConfigFile | null>
    /** Persists the full config blob (fire-and-forget; debounced by caller). */
    save(config: ConfigFile): void
  }
}
