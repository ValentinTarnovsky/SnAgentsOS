/**
 * Every touch gesture on the phone terminal, in one capture-phase handler on
 * the container (it runs before xterm's own listeners):
 *
 *  - Vertical swipe (E2-FR-31): in the normal buffer it scrolls with
 *    term.scrollLines and keeps the sub-line remainder; in a mouse-tracking app
 *    (Claude, vim) it dispatches wheel events that xterm encodes in the app's
 *    protocol, at most MAX_WHEEL_PER_FRAME per event or frame. On release it
 *    keeps going with momentum: velocity blended v = v*0.55 + inst*0.45,
 *    friction 0.972 per 16ms until under 0.012 px/ms, one scroll per frame.
 *    A new touch stops it. xterm never sees the touchmove (its own touch
 *    scroll would double the movement), and a horizontal drag is left alone so
 *    the overflowing grid still pans natively.
 *  - Long-press (E2-FR-26): LONG_PRESS_MS with less than LONG_PRESS_SLOP px of
 *    movement calls onLongPress; the lift is then cancelled so no synthetic
 *    click focuses xterm (no keyboard, no click report to a TUI).
 *  - Tap (E2-FR-28/29): under TAP_MAX_MS and TAP_SLOP px without scrolling,
 *    onTap decides; when it handles the tap (a link) the lift is cancelled too.
 *    touchstart is never cancelled, so a plain tap still focuses the input.
 *  - Pinch (E2-FR-34): two fingers report the live distance ratio and the
 *    final one on release; the caller scales and snaps.
 *  - Everything is off while isSelecting() (the selection overlay owns touch).
 */
import type { Terminal } from '@xterm/xterm'
import { LONG_PRESS_MS, LONG_PRESS_SLOP, TAP_MAX_MS, TAP_SLOP } from './selection'

export const VELOCITY_KEEP = 0.55
export const MOMENTUM_FRICTION = 0.972
export const MOMENTUM_MIN_VELOCITY = 0.012
export const MAX_WHEEL_PER_FRAME = 8
/** Movement before the gesture picks an axis (taps and jitter stay taps). */
export const AXIS_SLOP = 8
/** Fastest swipe honoured, px/ms (synthetic or glitchy events can be instant). */
export const MAX_VELOCITY = 6
/** A finger that rested this long before lifting throws no momentum. */
export const MOMENTUM_IDLE_MS = 100

export interface TouchGestureHandlers {
  /** Long-press at a client point (selection mode). */
  onLongPress?: (x: number, y: number) => void
  /** Short tap at a client point; true when handled, which cancels the synthetic click. */
  onTap?: (x: number, y: number) => boolean
  /** The selection overlay is up: every gesture is ignored. */
  isSelecting?: () => boolean
  /** Two-finger pinch, live ratio of the current to the starting distance. */
  onPinch?: (ratio: number) => void
  onPinchEnd?: (ratio: number) => void
}

/** v = v*0.55 + inst*0.45 (px/ms). */
export function blendVelocity(v: number, inst: number): number {
  return v * VELOCITY_KEEP + inst * (1 - VELOCITY_KEEP)
}

/** Velocity after `elapsedMs` of friction (0.972 per 16ms). */
export function decayVelocity(v: number, elapsedMs: number): number {
  return v * MOMENTUM_FRICTION ** (elapsedMs / 16)
}

/** Total distance a release at `v` px/ms travels with 16ms frames (for tests and tuning). */
export function momentumDistance(v: number): number {
  let total = 0
  let vel = v
  for (let i = 0; i < 10000; i++) {
    vel = decayVelocity(vel, 16)
    if (Math.abs(vel) < MOMENTUM_MIN_VELOCITY) break
    total += vel * 16
  }
  return total
}

interface Gesture {
  id: number
  startX: number
  startY: number
  x: number
  y: number
  lastY: number
  startT: number
  lastT: number
  maxDist: number
  axis: 'pending' | 'vertical' | 'horizontal'
  v: number
  scrolled: boolean
  longPressed: boolean
  timer: ReturnType<typeof setTimeout> | null
}

function dist(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

export function attachTouchScroll(term: Terminal, container: HTMLElement, handlers: TouchGestureHandlers = {}): () => void {
  let gesture: Gesture | null = null
  let pinch: { start: number; ratio: number } | null = null
  let remainder = 0
  let momentum: { raf: number; v: number; last: number; mouse: boolean } | null = null

  const mouseMode = (): boolean => term.modes.mouseTrackingMode !== 'none'

  const lineHeight = (): number => {
    const screen = container.querySelector<HTMLElement>('.xterm-screen')
    const h = screen?.getBoundingClientRect().height ?? 0
    return h ? Math.max(8, h / Math.max(1, term.rows)) : 0
  }

  /** Scroll by a pixel delta (positive = towards newer output). Returns lines moved. */
  const scrollPixels = (delta: number, x: number, y: number): number => {
    const lh = lineHeight()
    if (!lh) return 0
    remainder += delta
    const lines = Math.trunc(remainder / lh)
    remainder -= lines * lh
    if (lines === 0) return 0
    if (mouseMode()) {
      const element = term.element
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      if (!element || !screen) return 0
      const rect = screen.getBoundingClientRect()
      const n = Math.min(Math.abs(lines), MAX_WHEEL_PER_FRAME)
      // xterm encodes one wheel report per event in the app's mouse protocol.
      for (let i = 0; i < n; i++) {
        element.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: Math.sign(lines),
          clientX: Math.max(rect.left + 1, Math.min(rect.right - 1, x)),
          clientY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, y)),
        }))
      }
      return n * Math.sign(lines)
    }
    const before = term.buffer.active.viewportY
    term.scrollLines(lines)
    return term.buffer.active.viewportY - before
  }

  const stopMomentum = (): void => {
    if (momentum) cancelAnimationFrame(momentum.raf)
    momentum = null
  }

  const startMomentum = (v: number, x: number, y: number): void => {
    stopMomentum()
    const state = { raf: 0, v, last: performance.now(), mouse: mouseMode() }
    const step = (now: number): void => {
      if (momentum !== state) return
      const elapsed = Math.max(1, Math.min(50, now - state.last))
      state.last = now
      state.v = decayVelocity(state.v, elapsed)
      // Stop under the floor, or when the app switched mouse capture mid-flight.
      if (Math.abs(state.v) < MOMENTUM_MIN_VELOCITY || state.mouse !== mouseMode()) {
        momentum = null
        return
      }
      // The normal buffer reached the top or the bottom: nothing left to scroll.
      const buf = term.buffer.active
      if (!state.mouse && ((state.v > 0 && buf.viewportY >= buf.baseY) || (state.v < 0 && buf.viewportY <= 0))) {
        momentum = null
        return
      }
      scrollPixels(state.v * elapsed, x, y)
      state.raf = requestAnimationFrame(step)
    }
    momentum = state
    state.raf = requestAnimationFrame(step)
  }

  const clearTimer = (): void => {
    if (gesture?.timer != null) clearTimeout(gesture.timer)
    if (gesture) gesture.timer = null
  }

  const reset = (): void => {
    clearTimer()
    gesture = null
  }

  const start = (event: TouchEvent): void => {
    stopMomentum()
    if (handlers.isSelecting?.()) {
      reset()
      pinch = null
      return
    }
    if (event.touches.length === 2) {
      reset()
      pinch = { start: Math.max(1, dist(event.touches[0], event.touches[1])), ratio: 1 }
      return
    }
    reset()
    if (event.touches.length !== 1) return
    const touch = event.touches[0]
    remainder = 0
    const g: Gesture = {
      id: touch.identifier,
      startX: touch.clientX, startY: touch.clientY, x: touch.clientX, y: touch.clientY,
      lastY: touch.clientY, startT: event.timeStamp, lastT: event.timeStamp,
      maxDist: 0, axis: 'pending', v: 0, scrolled: false, longPressed: false, timer: null,
    }
    if (handlers.onLongPress) {
      g.timer = setTimeout(() => {
        g.timer = null
        if (gesture !== g || g.axis !== 'pending' || g.maxDist > LONG_PRESS_SLOP) return
        g.longPressed = true
        handlers.onLongPress?.(g.x, g.y)
      }, LONG_PRESS_MS)
    }
    gesture = g
  }

  const move = (event: TouchEvent): void => {
    // xterm's own touch scroll would double ours; it never sees a touchmove.
    event.stopPropagation()
    if (handlers.isSelecting?.()) return
    if (pinch || event.touches.length === 2) {
      if (event.touches.length !== 2) return // one finger left: wait for the lift
      event.preventDefault()
      const d = dist(event.touches[0], event.touches[1])
      if (!pinch) {
        reset()
        pinch = { start: Math.max(1, d), ratio: 1 }
      }
      pinch.ratio = d / pinch.start
      handlers.onPinch?.(pinch.ratio)
      return
    }
    const g = gesture
    if (!g) return
    if (event.touches.length !== 1) { reset(); return }
    const touch = event.touches[0]
    if (touch.identifier !== g.id) { reset(); return }
    g.x = touch.clientX
    g.y = touch.clientY
    g.maxDist = Math.max(g.maxDist, Math.hypot(touch.clientX - g.startX, touch.clientY - g.startY))
    if (g.maxDist > LONG_PRESS_SLOP) clearTimer()
    if (g.longPressed) {
      event.preventDefault()
      return
    }
    if (g.axis === 'pending') {
      const dx = Math.abs(touch.clientX - g.startX), dy = Math.abs(touch.clientY - g.startY)
      if (Math.max(dx, dy) < AXIS_SLOP) return
      g.axis = dy >= dx ? 'vertical' : 'horizontal'
    }
    if (g.axis !== 'vertical') return // the grid's horizontal pan stays native
    event.preventDefault()
    const delta = g.lastY - touch.clientY
    const dt = Math.max(1, event.timeStamp - g.lastT)
    const inst = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, delta / dt))
    g.v = blendVelocity(g.v, inst)
    g.lastY = touch.clientY
    g.lastT = event.timeStamp
    if (scrollPixels(delta, touch.clientX, touch.clientY) !== 0) g.scrolled = true
  }

  const end = (event: TouchEvent): void => {
    if (pinch) {
      if (event.touches.length >= 2) return
      const ratio = pinch.ratio
      pinch = null
      reset()
      if (event.cancelable) event.preventDefault()
      handlers.onPinchEnd?.(ratio)
      return
    }
    const g = gesture
    if (!g) return
    reset()
    if (g.longPressed) {
      if (event.cancelable) event.preventDefault()
      return
    }
    if (event.type !== 'touchend') return
    const t = event.timeStamp
    if (t - g.startT < TAP_MAX_MS && g.maxDist < TAP_SLOP && !g.scrolled) {
      if (handlers.onTap?.(g.x, g.y) && event.cancelable) event.preventDefault()
      return
    }
    if (g.axis !== 'vertical') return
    const v = t - g.lastT > MOMENTUM_IDLE_MS ? 0 : g.v
    if (Math.abs(v) > MOMENTUM_MIN_VELOCITY) startMomentum(v, g.x, g.y)
  }

  // Android's long-press menu and iOS's callout would fight the selection.
  const onContextMenu = (event: Event): void => event.preventDefault()

  // Capture before xterm's handlers. touchstart stays passive and uncancelled:
  // a tap still focuses xterm's textarea and opens the keyboard.
  container.addEventListener('touchstart', start, { capture: true, passive: true })
  container.addEventListener('touchmove', move, { capture: true, passive: false })
  container.addEventListener('touchend', end, { capture: true, passive: false })
  container.addEventListener('touchcancel', end, { capture: true, passive: false })
  container.addEventListener('contextmenu', onContextMenu)
  return () => {
    reset()
    pinch = null
    stopMomentum()
    container.removeEventListener('touchstart', start, true)
    container.removeEventListener('touchmove', move, true)
    container.removeEventListener('touchend', end, true)
    container.removeEventListener('touchcancel', end, true)
    container.removeEventListener('contextmenu', onContextMenu)
  }
}
