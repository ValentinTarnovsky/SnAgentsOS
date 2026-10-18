/**
 * Pure tap / hold / auto-repeat controller for one KeyBar button (E1-FR-17).
 *
 *  - Every key fires on pointerup, and only if the finger moved less than
 *    TAP_SLOP_PX since pointerdown and no pointercancel arrived. A swipe that
 *    starts on a key (scrolling the bar) therefore never sends it.
 *  - Repeat keys (arrows, Bksp, Del) held still for REPEAT_DELAY_MS send the
 *    first copy at t=400ms and then one every REPEAT_INTERVAL_MS; releasing a
 *    repeating key sends nothing extra. A 1s hold = 14 sends.
 *  - The repeat stops on up, cancel, a move past the slop, a failed send (the
 *    socket is not OPEN) or after REPEAT_MAX_MS as a safety cap. The KeyBar
 *    also calls cancel() on visibilitychange to hidden and on pane switches.
 *
 * Every press bumps a generation counter, so a timer armed by an earlier press
 * can never fire into a later one. No DOM access: timers and the clock are
 * injectable so the whole state machine runs under fake timers in tests.
 */

export const REPEAT_DELAY_MS = 400
export const REPEAT_INTERVAL_MS = 45
export const REPEAT_MAX_MS = 15000
export const TAP_SLOP_PX = 10

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

/** The slice of a PointerEvent the controller reads (a PointerEvent fits). */
export interface PressPoint {
  clientX: number
  clientY: number
  pointerId?: number
}

export interface PressHandlers {
  down(e: PressPoint): void
  move(e: PressPoint): void
  /** Optional point: an up from a different pointer than the press is ignored. */
  up(e?: PressPoint): void
  cancel(): void
}

const defaultTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/**
 * idle: no press. pressed: down, nothing sent yet (a tap sends on up).
 * repeating: the hold already sent at least once. dead: still held, but the
 * press was voided (slop, failed send, cap) and up must send nothing.
 */
type PressState = 'idle' | 'pressed' | 'repeating' | 'dead'

export function createKeyPress(
  send: () => boolean,
  opts: { repeat: boolean; now?: () => number; timers?: TimerApi },
): PressHandlers {
  const timers = opts.timers ?? defaultTimers
  const now = opts.now ?? (() => Date.now())
  let state: PressState = 'idle'
  let gen = 0
  let timer: unknown = null
  let startX = 0
  let startY = 0
  let pointerId: number | undefined
  let downAt = 0
  let nextDue = 0

  const clear = (): void => {
    if (timer != null) {
      timers.clearTimeout(timer)
      timer = null
    }
  }

  const finish = (): void => {
    clear()
    state = 'idle'
    pointerId = undefined
    gen++
  }

  const arm = (g: number): void => {
    timer = timers.setTimeout(() => tick(g), Math.max(0, nextDue - now()))
  }

  const tick = (g: number): void => {
    timer = null
    if (g !== gen || (state !== 'pressed' && state !== 'repeating')) return
    const t = now()
    if (t - downAt >= REPEAT_MAX_MS) {
      state = 'dead'
      return
    }
    state = 'repeating'
    if (!send()) {
      state = 'dead'
      return
    }
    // Schedule against absolute due times so timer jitter does not drift the
    // rate, but never burst to catch up after a stall (a throttled tab).
    nextDue += REPEAT_INTERVAL_MS
    if (nextDue < t) nextDue = t + REPEAT_INTERVAL_MS
    arm(g)
  }

  const samePointer = (e?: PressPoint): boolean =>
    !e || pointerId === undefined || e.pointerId === undefined || e.pointerId === pointerId

  return {
    down(e) {
      // A second finger on the same key while the first is held is ignored.
      if (state !== 'idle') return
      gen++
      state = 'pressed'
      startX = e.clientX
      startY = e.clientY
      pointerId = e.pointerId
      downAt = now()
      nextDue = downAt + REPEAT_DELAY_MS
      if (opts.repeat) arm(gen)
    },
    move(e) {
      if (state === 'idle' || state === 'dead' || !samePointer(e)) return
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > TAP_SLOP_PX) {
        clear()
        state = 'dead'
      }
    },
    up(e) {
      if (state === 'idle' || !samePointer(e)) return
      const tap = state === 'pressed'
      finish()
      if (tap) send()
    },
    cancel() {
      if (state !== 'idle') finish()
    },
  }
}
