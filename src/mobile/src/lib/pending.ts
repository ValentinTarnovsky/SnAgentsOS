/**
 * Requests waiting on the desktop (E3-FR-04). The v3.0 requests (historyReq,
 * gitReq and every ctl) wait by `id`; chatSub and chatMore wait by `paneId`,
 * one at a time per pane. Each one settles with the answer, or fails after
 * PENDING_TIMEOUT_MS ('timeout') or on a `ctlAck {error:'rate'}` ('rate').
 * Either failure shows "The PC did not answer [Retry]"; a manual retry sends
 * the same request again under a new id.
 *
 * The desktop drops rate-limited messages without an answer (E3-FR-03), so
 * this timeout is the only signal the phone gets for them.
 */

/** How long a request waits for its answer. */
export const PENDING_TIMEOUT_MS = 10000

/** Why a request ended without an answer. 'offline' = it never left the phone. */
export type PendingFailure = 'timeout' | 'rate' | 'offline'

export type PendingOutcome<T> = { ok: true; value: T } | { ok: false; error: PendingFailure }

/** Failures the UI shows as "The PC did not answer [Retry]". */
export function isNoReply(error: string | undefined): boolean {
  return error === 'timeout' || error === 'rate'
}

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface Entry<T> {
  promise: Promise<PendingOutcome<T>>
  settle: (outcome: PendingOutcome<T>) => void
  timer: unknown
}

/** Keyed requests with a timeout each; at most one per key. */
export class PendingMap<T> {
  private readonly entries = new Map<string, Entry<T>>()

  constructor(
    private readonly timeoutMs: number = PENDING_TIMEOUT_MS,
    private readonly timers: Timers = defaultTimers,
  ) {}

  /**
   * Start waiting on key. Null when that key is already waiting (one chat
   * request per pane): the caller sends nothing and keeps its spinner.
   */
  begin(key: string): Promise<PendingOutcome<T>> | null {
    if (this.entries.has(key)) return null
    let settle!: (outcome: PendingOutcome<T>) => void
    const promise = new Promise<PendingOutcome<T>>((resolve) => {
      settle = resolve
    })
    const entry: Entry<T> = { promise, settle, timer: null }
    entry.timer = this.timers.setTimeout(() => this.finish(key, { ok: false, error: 'timeout' }), this.timeoutMs)
    this.entries.set(key, entry)
    return promise
  }

  /** The answer arrived. False when nothing waits on key (late or unknown). */
  resolve(key: string, value: T): boolean {
    return this.finish(key, { ok: true, value })
  }

  /** End the wait without an answer ('rate' from a ctlAck, 'offline' when not sent). */
  fail(key: string, error: PendingFailure): boolean {
    return this.finish(key, { ok: false, error })
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get size(): number {
    return this.entries.size
  }

  private finish(key: string, outcome: PendingOutcome<T>): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.timers.clearTimeout(entry.timer)
    entry.settle(outcome)
    return true
  }
}
