/** Longest delay a platform timer honors (2^31-1 ms, about 24.8 days); a longer one fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1

export interface DeadlineTimerDeps {
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (h: unknown) => void
}

/**
 * Keyed deadlines (epoch ms on `now()`) behind a single platform timer: the
 * background-work rule of 2.7.0 (no new polling interval). Exactly one timer
 * is pending, armed for the nearest deadline, and none at all while there are
 * no keys. It is re-armed only when the nearest deadline changes. A delay
 * beyond the platform limit is clamped and the timer simply re-arms on that
 * early wake.
 *
 * When the timer fires, every key whose deadline is <= now is due (a late
 * wake or a clock jump catches up in one pass), in deadline order then key
 * order. Each key is removed before its `onDue`, so the callback may set it
 * again, clear others or set new ones; a key cleared or moved by an earlier
 * callback of the same pass does not fire with its old deadline. A throwing
 * callback is logged and the rest still run. A deadline already in the past
 * fires on the next tick (delay 0), never synchronously inside `set()`.
 */
export class DeadlineTimer<K extends string = string> {
  private readonly deadlines = new Map<K, number>()
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  /** The deadline the pending timer was armed for; null while no timer is pending. */
  private armedFor: number | null = null
  private handle: unknown = undefined
  /** True while `fire()` runs callbacks: re-entrant set/clear defer the re-arm to its end. */
  private firing = false
  private disposed = false

  constructor(
    private readonly onDue: (key: K, at: number) => void,
    opts: DeadlineTimerDeps = {},
  ) {
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Sets (or replaces) `key`'s deadline. A non-finite `at` means none, as `clear(key)`. Ignored after dispose. */
  set(key: K, at: number): void {
    if (this.disposed) return
    if (!Number.isFinite(at)) {
      this.clear(key)
      return
    }
    this.deadlines.set(key, at)
    this.arm()
  }

  clear(key: K): void {
    if (this.deadlines.delete(key)) this.arm()
  }

  has(key: K): boolean {
    return this.deadlines.has(key)
  }

  at(key: K): number | undefined {
    return this.deadlines.get(key)
  }

  get size(): number {
    return this.deadlines.size
  }

  /** The nearest deadline, or null without keys. A linear scan: the key sets here are small. */
  next(): number | null {
    let min: number | null = null
    for (const at of this.deadlines.values()) if (min === null || at < min) min = at
    return min
  }

  /** Drops every key and the pending timer; later `set()` calls are ignored. */
  dispose(): void {
    this.disposed = true
    this.deadlines.clear()
    this.disarm()
  }

  /** Keeps the single timer on the nearest deadline: untouched when that did not change. */
  private arm(): void {
    if (this.firing) return
    const next = this.next()
    if (next === this.armedFor) return
    this.disarm()
    if (next === null) return
    const delay = Math.min(Math.max(0, next - this.now()), MAX_DELAY_MS)
    this.armedFor = next
    this.handle = this.setTimer(() => this.fire(), delay)
  }

  private disarm(): void {
    if (this.armedFor === null) return
    this.clearTimer(this.handle)
    this.armedFor = null
    this.handle = undefined
  }

  private fire(): void {
    this.armedFor = null
    this.handle = undefined
    const now = this.now()
    // The due set is taken once: a key set to the past by a callback waits for the next tick.
    const due = [...this.deadlines].filter(([, at]) => at <= now)
    due.sort(([ka, a], [kb, b]) => a - b || (ka < kb ? -1 : ka > kb ? 1 : 0))
    this.firing = true
    try {
      for (const [key, at] of due) {
        if (this.deadlines.get(key) !== at) continue
        this.deadlines.delete(key)
        try {
          this.onDue(key, at)
        } catch (error) {
          console.warn('[deadline] onDue failed:', key, error instanceof Error ? error.message : String(error))
        }
      }
    } finally {
      this.firing = false
    }
    this.arm()
  }
}
