// Adaptado de stablyai/orca (MIT) - src/main/notifications/desktop-away-state.ts
/**
 * "Only when I am away from the PC" gate (E2-FR-41). The desktop counts as
 * away while Electron reports the session idle for the fixed threshold or the
 * screen locked. Any other answer ('unknown', a throw, a missing API) is
 * undefined: the caller delivers anyway, because silencing a push on a state
 * the OS cannot read would lose the one alert the user asked for.
 */

/** The slice of Electron's powerMonitor this reads (injected for tests). */
export interface IdleMonitor {
  getSystemIdleState: (idleThresholdSec: number) => string
}

/** Fixed idle threshold of E2-FR-41 (not configurable). */
export const AWAY_IDLE_THRESHOLD_SEC = 180

/** true = away (idle or locked), false = active, undefined = unknown (deliver). */
export function isDesktopAway(monitor: IdleMonitor | null | undefined, thresholdSec = AWAY_IDLE_THRESHOLD_SEC): boolean | undefined {
  try {
    const state = monitor?.getSystemIdleState(thresholdSec)
    if (state === 'idle' || state === 'locked') return true
    if (state === 'active') return false
    return undefined
  } catch {
    return undefined
  }
}
