/**
 * Circuit breaker for automatic renderer reloads (E4-FR-21). Pure logic, no
 * Electron: at most `maxRecoveries` automatic reloads inside a rolling
 * `windowMs`; the next crash in that window opens the native dialog instead
 * of reloading again. A manual reload resets it. Pattern after Orca's
 * renderer-recovery-circuit-breaker.ts (written from the PRD, no code taken),
 * with maxRecoveries = 2.
 */
export const MAX_AUTO_RELOADS = 2
export const RELOAD_WINDOW_MS = 60_000
/** Delay between render-process-gone and the reload. */
export const AUTO_RELOAD_DELAY_MS = 300

export class RecoveryBreaker {
  private attempts: number[] = []

  constructor(
    private readonly maxRecoveries = MAX_AUTO_RELOADS,
    private readonly windowMs = RELOAD_WINDOW_MS,
  ) {}

  /** Automatic reloads inside the window ending at `now`. */
  countInWindow(now: number): number {
    this.attempts = this.attempts.filter((t) => now - t < this.windowMs)
    return this.attempts.length
  }

  /** True while another automatic reload is allowed. */
  canRecover(now: number): boolean {
    return this.countInWindow(now) < this.maxRecoveries
  }

  /** Count one reload (automatic, or the unresponsive dialog's [Reload]). */
  record(now: number): void {
    this.countInWindow(now)
    this.attempts.push(now)
  }

  /** A manual reload or [Retry]: the user is in control again. */
  reset(): void {
    this.attempts = []
  }
}

export interface AutoReloadInput {
  /** Electron's RenderProcessGoneDetails.reason; null for the unresponsive path. */
  reason: string | null
  isQuitting: boolean
  /** Quit for an update: the window must just close. */
  bypassCloseGuards: boolean
  destroyed: boolean
  /** An update applied and the app relaunches itself. */
  updateRelaunchPending: boolean
  now?: number
}

/**
 * The guards of FR-21/25: never reload a clean exit, while quitting, during
 * an update quit/relaunch or on a destroyed window.
 */
export function shouldAutoReload(i: AutoReloadInput): boolean {
  if (i.reason === 'clean-exit') return false
  return !i.isQuitting && !i.bypassCloseGuards && !i.destroyed && !i.updateRelaunchPending
}

/** What main does on a renderer crash: reload, open the breaker dialog, or nothing. */
export type RecoveryDecision = 'reload' | 'dialog' | 'ignore'

export function decideRecovery(i: AutoReloadInput, breaker: RecoveryBreaker, now: number): RecoveryDecision {
  if (!shouldAutoReload(i)) return 'ignore'
  return breaker.canRecover(now) ? 'reload' : 'dialog'
}
