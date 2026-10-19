/**
 * Per-session rate limit of the v3.0 phone messages and ctl actions
 * (E3-FR-03): a token bucket that refills continuously at REMOTE_RATE_PER_SEC
 * up to REMOTE_RATE_BURST tokens. One take() per frame; an empty bucket
 * refuses without side effects, so a refused frame never costs a strike.
 */

/** Sustained frames per second for the rate-limited message types. */
export const REMOTE_RATE_PER_SEC = 20
/** Frames a fresh (or long idle) session may send back to back. */
export const REMOTE_RATE_BURST = 40

export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly ratePerSec: number = REMOTE_RATE_PER_SEC,
    private readonly burst: number = REMOTE_RATE_BURST,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst
    this.last = now()
  }

  /** Spend one token: true when the frame may go through. */
  take(): boolean {
    const t = this.now()
    // A clock that went backwards refills nothing instead of draining.
    const elapsed = Math.max(0, t - this.last)
    this.last = t
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerSec) / 1000)
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
