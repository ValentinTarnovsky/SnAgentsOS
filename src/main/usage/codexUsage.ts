import type { UsageRow } from '@shared/ipc-contract'
import { fetchCodexLive, type CodexLiveResult } from './codexLive'
import { readCodexLocal } from './codex'
import {
  applyExpiry,
  emptyCodexRows,
  rowsFromSnapshot,
  type CodexRowFlags,
  type CodexSnapshot,
} from './codexWindows'

/** The live endpoint is remote: never polled faster than this, whatever the Codex interval says. */
export const MIN_CODEX_LIVE_MS = 60_000
/** A forced refresh (focus, turn finished, Refresh button) still waits this long since the last live attempt. */
export const FORCE_MIN_GAP_MS = 5_000

export interface CodexUsageDeps {
  live?: () => Promise<CodexLiveResult>
  local?: () => Promise<CodexSnapshot | null>
  now?: () => number
}

/**
 * Codex usage policy.
 *
 *  - LIVE (`wham/usage`) is the source of truth. It is asked at most every
 *    max(60s, configured Codex interval); between those fetches the last live
 *    snapshot is reused, so the 10s tick costs nothing while live is healthy.
 *  - LOCAL (rollout tail) is the fallback, read on EVERY tick at the
 *    configured cadence whenever live is unavailable (no ChatGPT login,
 *    401/403, offline). It is cheap: a few tail reads.
 *  - A forced refresh bypasses the schedule (but not the 5s gap).
 */
export class CodexUsage {
  private liveNextAt = 0
  private lastLiveAttempt = -Infinity
  private liveSnapshot: CodexSnapshot | null = null
  private readonly live: () => Promise<CodexLiveResult>
  private readonly local: () => Promise<CodexSnapshot | null>
  private readonly now: () => number

  constructor(deps: CodexUsageDeps = {}) {
    this.live = deps.live ?? (() => fetchCodexLive())
    this.local = deps.local ?? (() => readCodexLocal())
    this.now = deps.now ?? Date.now
  }

  async refresh(flags: CodexRowFlags, configuredMs: number, force = false): Promise<UsageRow[]> {
    if (!flags.codex5h && !flags.codex7d) return []
    const t = this.now()
    const liveEvery = Math.max(MIN_CODEX_LIVE_MS, configuredMs)
    const due = t >= this.liveNextAt || (force && t - this.lastLiveAttempt >= FORCE_MIN_GAP_MS)
    if (due) {
      this.lastLiveAttempt = t
      this.liveNextAt = t + liveEvery
      const res = await this.live()
      if (res.ok) {
        this.liveSnapshot = res.snapshot
        return rowsFromSnapshot(flags, applyExpiry(res.snapshot, this.now()))
      }
      this.liveSnapshot = null
    } else if (this.liveSnapshot) {
      return rowsFromSnapshot(flags, applyExpiry(this.liveSnapshot, t))
    }
    const snap = await this.local().catch(() => null)
    return snap ? rowsFromSnapshot(flags, applyExpiry(snap, this.now())) : emptyCodexRows(flags, 'nodata')
  }
}
