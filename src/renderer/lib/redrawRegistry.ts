/**
 * Per-pane "redraw" hooks. A terminal can rebuild its GPU renderer from scratch
 * (fresh canvas + WebGL context + glyph atlas), which heals the mojibake left
 * behind by a GPU reset that fired no power/focus event. Exposed here so chrome
 * (the pane context menu, a keybinding) can trigger it for a specific pane
 * without reaching into that pane's xterm controller.
 */
const redrawers = new Map<string, () => void>()

/** Register a pane terminal's renderer-rebuild fn (called by useXterm on mount). */
export function registerRedrawer(paneId: string, redraw: () => void): void {
  redrawers.set(paneId, redraw)
}

export function unregisterRedrawer(paneId: string): void {
  redrawers.delete(paneId)
}

/** Rebuild a pane terminal's renderer, if it's mounted. */
export function redrawPane(paneId: string): void {
  redrawers.get(paneId)?.()
}
