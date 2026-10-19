/**
 * Scroll thumb (E2-FR-33): 3px on the right edge of the terminal, height
 * proportional to the visible share (rows / (baseY + rows), at least 24px),
 * shown while the user scrolls and faded out SCROLL_THUMB_FADE_MS later. The
 * position comes from RemoteTerminal; output that merely follows the bottom
 * does not count as scrolling there.
 */
import type { ReactNode } from 'react'

export const SCROLL_THUMB_MIN_PX = 24
export const SCROLL_THUMB_FADE_MS = 1000

/** Thumb height and offset in px for a track of `trackPx`. */
export function thumbGeometry(viewportY: number, baseY: number, rows: number, trackPx: number): { height: number; top: number } {
  const total = Math.max(1, baseY + rows)
  const height = Math.min(trackPx, Math.max(SCROLL_THUMB_MIN_PX, (trackPx * rows) / total))
  const top = baseY > 0 ? ((trackPx - height) * Math.min(viewportY, baseY)) / baseY : 0
  return { height, top }
}

export function ScrollThumb({
  visible,
  viewportY,
  baseY,
  rows,
  trackPx,
}: {
  visible: boolean
  viewportY: number
  baseY: number
  rows: number
  trackPx: number
}): ReactNode {
  if (baseY <= 0 || trackPx <= 0) return null
  const { height, top } = thumbGeometry(viewportY, baseY, rows, trackPx)
  return (
    <div
      data-scroll-thumb
      data-visible={visible}
      aria-hidden
      className="pointer-events-none absolute right-0.5 z-10 w-[3px] rounded-full bg-text-secondary transition-opacity duration-300"
      style={{ top, height, opacity: visible ? 0.7 : 0 }}
    />
  )
}
