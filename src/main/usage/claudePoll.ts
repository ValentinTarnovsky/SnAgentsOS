import type { UsageRow } from '@shared/ipc-contract'
import type { ClaudeFetchResult } from './claude'

/** Consecutive all-error Claude polls tolerated (last good rows held, flagged stale) before the UI shows "Error". */
export const CLAUDE_ERROR_GRACE = 3
/** The doubling back-off after failed polls never exceeds this. */
export const MAX_CLAUDE_BACKOFF_MS = 10 * 60_000
/** A server `Retry-After` is honored up to this (sanity bound, larger than the doubling cap on purpose). */
export const MAX_RETRY_AFTER_MS = 30 * 60_000
/** After the first `expired`, one early re-check: Claude Code may refresh the token any moment. */
export const EXPIRED_RETRY_MS = 30_000

const isAllError = (rows: UsageRow[]): boolean => rows.length > 0 && rows.every((r) => r.status === 'error')
const isAllExpired = (rows: UsageRow[]): boolean => rows.length > 0 && rows.every((r) => r.status === 'expired')

/**
 * Poll policy of the Claude usage rows, kept apart from timers and IPC so it
 * can be driven with a fake clock.
 *
 *  - A failed poll (429, 5xx, network) doubles the wait before the next one
 *    (base, 2x, 4x ... capped at 10 min, or the server's `Retry-After` when
 *    larger) and any success resets it. While `blockedUntil` is in the future
 *    even a manual/focus refresh must not call the endpoint.
 *  - The last good rows are held through `CLAUDE_ERROR_GRACE - 1` failures,
 *    flagged `stale` so the UI can say the value is not fresh.
 *  - `expired` shows at once and schedules exactly one early retry.
 */
export class ClaudePoll {
  rows: UsageRow[] = []
  private backoffMs = 0
  private blockedUntil = 0
  private errorStreak = 0
  private expiredRetried = false

  /** False while a back-off is running (the endpoint asked us to slow down). */
  canFetch(nowMs: number): boolean {
    return nowMs >= this.blockedUntil
  }

  /** Delay to the next poll when this tick did not fetch (still backing off). */
  skipDelay(baseMs: number, nowMs: number): number {
    return Math.max(baseMs, this.blockedUntil - nowMs)
  }

  /** Fold one fetch result into the rows to show; returns the delay before the next poll. */
  apply(res: ClaudeFetchResult, baseMs: number, nowMs: number): number {
    const failed = res.rateLimited === true || isAllError(res.rows)
    if (failed) {
      this.errorStreak += 1
      this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, MAX_CLAUDE_BACKOFF_MS) : Math.min(baseMs, MAX_CLAUDE_BACKOFF_MS)
      const hint = Math.min(res.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS)
      this.blockedUntil = nowMs + Math.max(this.backoffMs, hint)
      const hold = this.rows.length > 0 && !isAllError(this.rows) && this.errorStreak < CLAUDE_ERROR_GRACE
      this.rows = hold ? this.rows.map((r) => (r.stale ? r : { ...r, stale: true })) : res.rows
      return this.skipDelay(baseMs, nowMs)
    }
    this.errorStreak = 0
    this.backoffMs = 0
    this.blockedUntil = 0
    this.rows = res.rows
    if (isAllExpired(res.rows)) {
      if (!this.expiredRetried) {
        this.expiredRetried = true
        return Math.min(EXPIRED_RETRY_MS, baseMs)
      }
    } else {
      this.expiredRetried = false
    }
    return baseMs
  }
}
