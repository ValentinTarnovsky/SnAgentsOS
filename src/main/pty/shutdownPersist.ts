/**
 * Saves on an OS shutdown or log off (E6-FR-36). Windows ends the session
 * through the window's 'session-end' (WM_ENDSESSION, no before-quit), macOS
 * and Linux through powerMonitor 'shutdown'. Both run the synchronous exit
 * save behind the same once-per-exit flag the quit paths use (FR-10), then
 * re-arm it after SHUTDOWN_REARM_MS: a cancelled shutdown leaves the app
 * running, so a later quit must save again.
 */

/** How long after a shutdown save the exit flag re-arms. */
export const SHUTDOWN_REARM_MS = 10_000

/** The exit-save side of ScrollbackCheckpoint. */
export interface ExitSaver {
  persistOnExit(): boolean
  resetExit(): void
}

export interface ShutdownPersistDeps {
  /** The live checkpoint, read at event time (null before bootstrap). */
  checkpoint: () => ExitSaver | null | undefined
  /** Other synchronous flushes that ride the same moment (review notes). */
  flush?: () => void
  log?: (msg: string, error: unknown) => void
  /** Timer of the re-arm (unref'd by default, so it never holds the app). */
  setTimer?: (fn: () => void, ms: number) => void
}

/** Anything with an `on(event, listener)`: a BrowserWindow, powerMonitor. */
interface Emitter {
  on(event: string, listener: () => void): unknown
}

/** The shutdown save: exit save once, the extra flushes, then the re-arm. */
export function createShutdownPersist(deps: ShutdownPersistDeps): () => void {
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): void => {
      setTimeout(fn, ms).unref?.()
    })
  return () => {
    try {
      deps.checkpoint()?.persistOnExit()
    } catch (error) {
      deps.log?.('[scrollback] exit save failed:', error)
    }
    try {
      deps.flush?.()
    } catch (error) {
      deps.log?.('[scrollback] shutdown flush failed:', error)
    }
    setTimer(() => deps.checkpoint()?.resetExit(), SHUTDOWN_REARM_MS)
  }
}

/** Windows: the window's WM_ENDSESSION. `before` runs first (the agent snapshot, E5-FR-06). */
export function wireSessionEnd(win: Emitter, before: () => void, persist: () => void): void {
  win.on('session-end', () => {
    before()
    persist()
  })
}

/** macOS/Linux: powerMonitor's shutdown (Windows uses wireSessionEnd). */
export function wirePowerShutdown(power: Emitter, persist: () => void): void {
  power.on('shutdown', () => persist())
}
