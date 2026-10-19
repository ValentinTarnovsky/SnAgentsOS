/**
 * Pure drag math of the bottom sheet (E1-FR-34), kept apart from Sheet.tsx so
 * test-mobile-logic.cjs runs it in Node. A drag dismisses past DISMISS_PX or
 * when the finger leaves faster than DISMISS_VELOCITY, measured over the last
 * VELOCITY_WINDOW_MS; otherwise the sheet springs back in SPRING_MS. The exit
 * duration follows the release speed, clamped to CLOSE_MIN_MS..CLOSE_MAX_MS,
 * and the sheet unmounts on transitionend or after UNMOUNT_FALLBACK_MS.
 */

export const DISMISS_PX = 80
/** px/s */
export const DISMISS_VELOCITY = 500
export const VELOCITY_WINDOW_MS = 100
export const SPRING_MS = 200
export const CLOSE_MIN_MS = 120
export const CLOSE_MAX_MS = 300
/** Exit duration of a close that did not come from a drag. */
export const CLOSE_DEFAULT_MS = 240
export const UNMOUNT_FALLBACK_MS = 350
/** Content drags start only after this much downward travel. */
export const CONTENT_DRAG_START_PX = 4

export interface DragSample {
  /** ms (performance.now) */
  t: number
  /** clientY */
  y: number
}

/** Downward release speed in px/s over the last VELOCITY_WINDOW_MS (0 if the finger rested). */
export function releaseVelocity(samples: DragSample[], tEnd: number): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  if (tEnd - last.t > VELOCITY_WINDOW_MS) return 0
  let ref = samples[samples.length - 2]
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > VELOCITY_WINDOW_MS) break
    ref = samples[i]
  }
  const dt = Math.max(1, last.t - ref.t)
  return ((last.y - ref.y) / dt) * 1000
}

export function shouldDismiss(dy: number, velocity: number): boolean {
  return dy > DISMISS_PX || velocity > DISMISS_VELOCITY
}

/** Exit duration: the remaining travel at the release speed, clamped. */
export function closeDurationMs(remainingPx: number, velocity: number): number {
  const ms = velocity > 0 ? (Math.max(0, remainingPx) / velocity) * 1000 : CLOSE_DEFAULT_MS
  return Math.round(Math.min(CLOSE_MAX_MS, Math.max(CLOSE_MIN_MS, ms)))
}

/** A drag that starts on the sheet's content: only at the top, downwards, keyboard down. */
export function canDragFromContent(p: { scrollTop: number; dy: number; inputFocused: boolean }): boolean {
  return p.scrollTop <= 0 && p.dy > CONTENT_DRAG_START_PX && !p.inputFocused
}

/** Backdrop opacity while the panel is dragged down by `dy` of `height` px. */
export function backdropOpacity(dy: number, height: number): number {
  if (height <= 0) return 1
  return Math.max(0, Math.min(1, 1 - dy / height))
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
