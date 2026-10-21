import type { ClaudeSwitchReason } from '@shared/claude-accounts'
import type { ClaudeAccountsSettings } from '@shared/types'

/**
 * Automatic Claude account switching (app 2.3.0, item 9). Pure: no clock, no
 * I/O, so a table of cases drives it. AccountService feeds it the active
 * account's fresh usage and the parked accounts' last readings.
 *
 * App 2.4.0: N accounts in priority order (`rank`, 0 = highest).
 *  - Exhausted: the first account by rank that is usable, past its own
 *    `exhaustedUntil` plus the margin, and has room.
 *  - Return: only after an automatic move, to the highest priority account
 *    between the anchor (the user's last pick) and the active one whose
 *    window reset and reads below returnBelowPercent. Step by step: C to B
 *    when B resets, B to A when A does. It never climbs above the anchor.
 */

export interface PolicyWindow {
  percent: number | null
  /** Epoch ms of the window reset, when known. */
  resetsAt: number | null
  /** Epoch ms of the reading. */
  at: number | null
}

export interface PolicyAccount {
  id: string
  /** Priority, 0 = highest. */
  rank: number
  /** Reset of the window that made the policy leave this account (epoch ms), or null. */
  exhaustedUntil: number | null
  fiveHour: PolicyWindow
  sevenDay: PolicyWindow
  /** The reading is recent enough to act on (main decides per account). */
  fresh: boolean
  /**
   * No fresh reading can come (the parked access token expired, the parked
   * poll stopped or is off): the return to it then goes by the estimate of
   * effectivePercent. Absent = false.
   */
  stale?: boolean
  /** The saved login can be switched to (false: needs a capture). */
  usable: boolean
}

export interface PolicyMemory {
  lastSwitchAt: number | null
  lastSwitchReason: ClaudeSwitchReason | null
  deferSince: number | null
  allExhaustedLatched: boolean
}

export interface PolicyInput {
  now: number
  cfg: ClaudeAccountsSettings
  activeId: string | null
  /** The user's last pick; the return never climbs above it (null or unknown = rank 0). */
  anchorId?: string | null
  accounts: PolicyAccount[]
  paused: boolean
  /** Claude consoles in `working`. */
  workingClaude: number
  mem: PolicyMemory
}

export type PolicyDecision =
  | { kind: 'stay'; why: 'off' | 'paused' | 'single' | 'ok' | 'dwell' | 'noData' }
  | { kind: 'blocked'; why: 'allExhausted'; notify: boolean }
  | { kind: 'defer'; to: string; reason: 'auto_exhausted' | 'auto_return' }
  | { kind: 'switch'; to: string; reason: 'auto_exhausted' | 'auto_return'; window?: '5h' | '7d'; percent?: number; exhaustedUntil?: number | null }

export const emptyPolicyMemory = (): PolicyMemory => ({
  lastSwitchAt: null,
  lastSwitchReason: null,
  deferSince: null,
  allExhaustedLatched: false,
})

/**
 * What a window is worth now. A fresh reading counts as is. A stale one whose
 * reset passed (plus the margin) is estimated at 0. Otherwise the last known
 * value: a parked account cannot gain usage from this PC, so it is an upper
 * bound. Null when nothing is known.
 */
export function effectivePercent(w: PolicyWindow, now: number, marginMs: number, fresh: boolean): number | null {
  if (fresh) return w.percent
  if (w.resetsAt !== null && now >= w.resetsAt + marginMs) return 0
  return w.percent
}

const MIN = 60_000

export function decide(input: PolicyInput): { decision: PolicyDecision; mem: PolicyMemory } {
  const { now, cfg } = input
  const mem: PolicyMemory = { ...input.mem }
  const stay = (why: Extract<PolicyDecision, { kind: 'stay' }>['why']): { decision: PolicyDecision; mem: PolicyMemory } => {
    mem.deferSince = null
    return { decision: { kind: 'stay', why }, mem }
  }
  const maybeDefer = (sw: Extract<PolicyDecision, { kind: 'switch' }>): { decision: PolicyDecision; mem: PolicyMemory } => {
    if (cfg.deferWhileWorking && input.workingClaude > 0) {
      const since = mem.deferSince ?? now
      if (now - since < cfg.deferMaxMinutes * MIN) {
        mem.deferSince = since
        return { decision: { kind: 'defer', to: sw.to, reason: sw.reason }, mem }
      }
    }
    mem.deferSince = null
    return { decision: sw, mem }
  }

  if (!cfg.autoSwitch) return stay('off')
  if (input.paused) return stay('paused')
  // By rank, whatever order the caller used.
  const accounts = [...input.accounts].sort((a, b) => a.rank - b.rank)
  const active = accounts.find((a) => a.id === input.activeId)
  if (accounts.length < 2 || !active) return stay('single')
  if (mem.lastSwitchAt !== null && now - mem.lastSwitchAt < cfg.minDwellMinutes * MIN) return stay('dwell')
  if (!active.fresh || (active.fiveHour.percent === null && active.sevenDay.percent === null)) return stay('noData')

  const margin = cfg.returnMarginMinutes * MIN
  const at = cfg.switchAtPercent
  const exhaustedWin: '5h' | '7d' | null =
    active.fiveHour.percent !== null && active.fiveHour.percent >= at
      ? '5h'
      : active.sevenDay.percent !== null && active.sevenDay.percent >= at
        ? '7d'
        : null

  /** Past the reset of the window that made the policy leave it, plus the margin. */
  const rested = (a: PolicyAccount): boolean => now >= (a.exhaustedUntil ?? 0) + margin

  if (exhaustedWin) {
    // Unknown windows count as available; an old value is an upper bound.
    const available = (a: PolicyAccount): boolean =>
      [a.fiveHour, a.sevenDay].every((w) => {
        const p = effectivePercent(w, now, margin, a.fresh)
        return p === null || p < at
      })
    // The first by rank: an account left at its limit stays out until its
    // own reset (no ping-pong on an old low reading).
    const target = accounts.find((a) => a.id !== active.id && a.usable && rested(a) && available(a))
    if (!target) {
      const notify = !mem.allExhaustedLatched
      mem.allExhaustedLatched = true
      mem.deferSince = null
      return { decision: { kind: 'blocked', why: 'allExhausted', notify }, mem }
    }
    mem.allExhaustedLatched = false
    const w = exhaustedWin === '5h' ? active.fiveHour : active.sevenDay
    return maybeDefer({
      kind: 'switch',
      to: target.id,
      reason: 'auto_exhausted',
      window: exhaustedWin,
      percent: w.percent ?? undefined,
      exhaustedUntil: w.resetsAt,
    })
  }
  mem.allExhaustedLatched = false

  // Back up only after an automatic move (a manual pick is never undone), to
  // the highest priority account between the anchor and the active one that
  // is past its reset plus the margin, with a reading below
  // returnBelowPercent on both windows. When no fresh reading can come
  // (stale: the parked token expired long before a 7d reset), the estimate
  // decides: a window whose reset + margin passed counts as 0, the other
  // keeps its last value; the live reading after the switch, plus the dwell,
  // corrects a wrong guess.
  const auto = mem.lastSwitchReason === 'auto_exhausted' || mem.lastSwitchReason === 'auto_return'
  if (auto && cfg.returnToPrimary) {
    const anchorRank = accounts.find((a) => a.id === input.anchorId)?.rank ?? 0
    if (anchorRank < active.rank) {
      const back = accounts.find((a) => {
        if (a.rank < anchorRank || a.rank >= active.rank || !a.usable || !(a.fresh || a.stale === true) || !rested(a)) return false
        const five = effectivePercent(a.fiveHour, now, margin, a.fresh)
        const seven = effectivePercent(a.sevenDay, now, margin, a.fresh)
        return five !== null && seven !== null && five < cfg.returnBelowPercent && seven < cfg.returnBelowPercent
      })
      if (back) return maybeDefer({ kind: 'switch', to: back.id, reason: 'auto_return' })
    }
  }
  return stay('ok')
}
