/**
 * Per-pane in-place restarters (E6-FR-18). A mounted terminal registers one
 * that respawns its shell inside the same xterm, keeping the scrollback, so
 * the store's restartPane (header button, menu, phone, resume) can use it
 * without reaching into the pane's xterm controller. Without one (the console
 * is not mounted) restartPane falls back to a remount.
 */
const restarters = new Map<string, () => void>()

/** Register a pane terminal's in-place restart fn (called by useXterm on mount). */
export function registerRestarter(paneId: string, restart: () => void): void {
  restarters.set(paneId, restart)
}

/** Drop the pane's restarter, only when it is still the one registered. */
export function unregisterRestarter(paneId: string, restart: () => void): void {
  if (restarters.get(paneId) === restart) restarters.delete(paneId)
}

/** Restart a mounted pane in place. Returns false when nothing is registered. */
export function restartInPlace(paneId: string): boolean {
  const restart = restarters.get(paneId)
  if (!restart) return false
  restart()
  return true
}
