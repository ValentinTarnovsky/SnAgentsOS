/**
 * Long-press detector shared by the pane tabs, the Home rows and
 * the composer's Send (E1-FR-26/33/39). One constant, LONG_PRESS_MS, so every
 * hold on the phone feels the same (risk 18 of E1).
 *
 *  - A manual timer starts on pointerdown; it fires onLongPress after
 *    LONG_PRESS_MS unless the finger moved more than LONG_PRESS_SLOP_PX, was
 *    lifted or the browser cancelled the pointer (a scroll took over).
 *  - It vibrates for LONG_PRESS_VIBRATE_MS where navigator.vibrate exists.
 *  - Once it fired, the click that follows the lift is swallowed, so a hold
 *    on a tab never also switches to it, and the browser's own context menu
 *    (iOS callout, Android long-tap menu) is suppressed.
 *
 * createLongPress is pure (timers injectable, no DOM) so it runs under fake
 * timers in test-mobile-logic.cjs; useLongPress wires it to React props.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { PressPoint, TimerApi } from './keyPress'

export const LONG_PRESS_MS = 450
export const LONG_PRESS_SLOP_PX = 10
export const LONG_PRESS_VIBRATE_MS = 10

export interface LongPressController {
  down(e: PressPoint): void
  move(e: PressPoint): void
  /** Lift. Returns true when the press already fired (the click must be swallowed). */
  up(): boolean
  cancel(): void
  /** The current or last press fired and its click has not been swallowed yet. */
  consumeFired(): boolean
}

const defaultTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

export function createLongPress(
  onLongPress: () => void,
  opts: { timers?: TimerApi; vibrate?: (ms: number) => void; ms?: number } = {},
): LongPressController {
  const timers = opts.timers ?? defaultTimers
  const ms = opts.ms ?? LONG_PRESS_MS
  let timer: unknown = null
  let startX = 0
  let startY = 0
  let pointerId: number | undefined
  let fired = false
  let gen = 0

  const clear = (): void => {
    if (timer != null) {
      timers.clearTimeout(timer)
      timer = null
    }
  }

  return {
    down(e) {
      clear()
      gen++
      const g = gen
      fired = false
      startX = e.clientX
      startY = e.clientY
      pointerId = e.pointerId
      timer = timers.setTimeout(() => {
        timer = null
        if (g !== gen) return
        fired = true
        opts.vibrate?.(LONG_PRESS_VIBRATE_MS)
        onLongPress()
      }, ms)
    },
    move(e) {
      if (timer == null) return
      if (pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== pointerId) return
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_SLOP_PX) {
        clear()
        gen++
      }
    },
    up() {
      clear()
      gen++
      return fired
    },
    cancel() {
      clear()
      gen++
    },
    consumeFired() {
      const was = fired
      fired = false
      return was
    },
  }
}

export interface LongPressProps {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
  onPointerCancel: (e: ReactPointerEvent) => void
  onPointerLeave: (e: ReactPointerEvent) => void
  onContextMenu: (e: ReactMouseEvent) => void
  onClickCapture: (e: ReactMouseEvent) => void
}

function vibrate(ms: number): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms)
  } catch {
    /* some browsers throw without a user gesture */
  }
}

/**
 * Props for an element with a long-press. `onPointerDown` runs first, so the
 * caller can still preventDefault there (the tabs keep the keyboard open).
 */
export function useLongPress(onLongPress: () => void, onPointerDown?: (e: ReactPointerEvent) => void): LongPressProps {
  const cb = useRef(onLongPress)
  cb.current = onLongPress
  const down = useRef(onPointerDown)
  down.current = onPointerDown
  const ctl = useMemo(() => createLongPress(() => cb.current(), { vibrate }), [])
  useEffect(() => () => ctl.cancel(), [ctl])
  return useMemo<LongPressProps>(
    () => ({
      onPointerDown: (e) => {
        down.current?.(e)
        if (e.button !== 0 && e.pointerType === 'mouse') return
        ctl.down(e)
      },
      onPointerMove: (e) => ctl.move(e),
      onPointerUp: () => {
        ctl.up()
      },
      onPointerCancel: () => ctl.cancel(),
      onPointerLeave: () => ctl.cancel(),
      onContextMenu: (e) => e.preventDefault(),
      onClickCapture: (e) => {
        if (ctl.consumeFired()) {
          e.preventDefault()
          e.stopPropagation()
        }
      },
    }),
    [ctl],
  )
}
