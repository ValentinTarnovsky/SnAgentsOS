import { INTERNAL_PATH_MIME } from './dragNonce'

/**
 * Drop-target feedback for a pane (E7-FR-03). Only drags that bring files (or
 * an in-app path) light the pane up; the header drag that reorders panes
 * carries neither. Visibility uses an enter/leave depth counter so crossing
 * child elements (xterm canvas, header) never makes the overlay flicker.
 */
export function isPathDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false
  const list = Array.from(types)
  return list.includes('Files') || list.includes(INTERNAL_PATH_MIME)
}

export type DragHoverEvent = 'enter' | 'leave' | 'reset'

/** Next counter value; the overlay shows while it is above 0. */
export function nextDragDepth(depth: number, event: DragHoverEvent): number {
  if (event === 'enter') return depth + 1
  if (event === 'leave') return Math.max(0, depth - 1)
  return 0
}
