/**
 * Time source of the Share host (app 2.4.0, item 8): leases, approvals,
 * tickets, keepalive and the backpressure sweep all read it, so the tests
 * drive every timing rule with a fake clock instead of waiting.
 */
export type ShareTimer = unknown

export interface ShareClock {
  now(): number
  setTimeout(fn: () => void, ms: number): ShareTimer
  clearTimeout(timer: ShareTimer): void
  setInterval(fn: () => void, ms: number): ShareTimer
  clearInterval(timer: ShareTimer): void
}

/** The real clock; its timers never keep the process alive on their own. */
export const realShareClock: ShareClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms)
    t.unref?.()
    return t
  },
  clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
}
