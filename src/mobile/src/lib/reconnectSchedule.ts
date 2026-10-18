/**
 * Pure reconnect backoff (E1-FR-12). Kept out of client.ts so the schedule can
 * be tested without a socket: 500ms doubling up to 60s, then a slow trickle
 * every 90s from attempt 12 on, forever. Every delay gets +-30% jitter so a
 * fleet of phones does not hammer a desktop that just came back in lockstep.
 */

export const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000]
export const RECONNECT_TRICKLE_AFTER = 12
export const RECONNECT_TRICKLE_MS = 90000
export const RECONNECT_JITTER = 0.3

/**
 * Delay before reconnect attempt `attempt` (1-based: the first retry is 1).
 * `rand` is a uniform sample in [0, 1); 0.5 means no jitter.
 */
export function delayFor(attempt: number, rand: number): number {
  const n = Math.max(1, Math.floor(attempt))
  const base =
    n >= RECONNECT_TRICKLE_AFTER
      ? RECONNECT_TRICKLE_MS
      : RECONNECT_DELAYS[Math.min(n, RECONNECT_DELAYS.length) - 1]
  const r = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0.5
  return Math.round(base * (1 + (r * 2 - 1) * RECONNECT_JITTER))
}
