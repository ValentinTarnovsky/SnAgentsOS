/**
 * Drag of a console by its header. The pane id rides in the DataTransfer
 * under this type, so a drop target outside the grid (a sidebar workspace
 * row, "move to workspace") can tell a pane drag from a file or path drag.
 */
export const PANE_DRAG_MIME = 'application/x-snaos-pane'

/** Whether a drag carries a console (dragover only sees the types, not the data). */
export function isPaneDrag(types: readonly string[]): boolean {
  return types.includes(PANE_DRAG_MIME)
}

/** The console being dragged right now, for dragover handlers that cannot read the data. */
let dragging: string | null = null

export function setPaneDragId(paneId: string | null): void {
  dragging = paneId
}

export function paneDragId(): string | null {
  return dragging
}
