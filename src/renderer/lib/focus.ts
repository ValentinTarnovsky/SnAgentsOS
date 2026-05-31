/**
 * Tracks the most recently focused console pane and exposes a way to refocus a
 * pane's terminal from elsewhere (command palette, snippets), so the user can
 * keep typing right after an action without clicking back into the console.
 */
let lastFocusedPaneId: string | null = null
const focusers = new Map<string, () => void>()

export function setFocusedPane(paneId: string): void {
  lastFocusedPaneId = paneId
}

export function getFocusedPane(): string | null {
  return lastFocusedPaneId
}

/** Register a pane's terminal focus fn (called by useXterm on mount). */
export function registerFocuser(paneId: string, focus: () => void): void {
  focusers.set(paneId, focus)
}

export function unregisterFocuser(paneId: string): void {
  focusers.delete(paneId)
}

/** Focus a pane's terminal, if it's mounted. */
export function focusPane(paneId: string): void {
  focusers.get(paneId)?.()
}
