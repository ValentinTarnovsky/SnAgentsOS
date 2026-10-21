import type { ClaudeAccountRole, ClaudeSwitchReason } from '@shared/claude-accounts'
import type { ClaudeAccountsSettings } from '@shared/types'

/**
 * Automatic Claude account switching (app 2.3.0, item 9). Pure: no clock, no
 * I/O, so a table of cases drives it. AccountService feeds it the active
 * account's fresh usage and the parked account's last reading.
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
  role: ClaudeAccountRole
  fiveHour: PolicyWindow
  sevenDay: PolicyWindow
  /** The reading is recent enough to act on (main decides per account). */
  fresh: boolean
  /**
   * No fresh reading can come (the parked access token expired, the parked
   * poll stopped or is off): the return to the primary then goes by the
   * estimate of effectivePercent. Absent = false.
   */
  stale?: boolean
  /** The saved login can be switched to (false: needs a capture). */
  usable: boolean
}

export interface PolicyMemory {
  lastSwitchAt: number | null
  lastSwitchReason: ClaudeSwitchReason | null
  exhaustedUntil: number | null
  deferSince: number | null
  allExhaustedLatched: boolean
}

export interface PolicyInput {
  now: number
  cfg: ClaudeAccountsSettings
  activeId: string | null
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
  exhaustedUntil: null,
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
  const active = input.accounts.find((a) => a.id === input.activeId)
  if (input.accounts.length < 2 || !active) return stay('single')
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

  if (exhaustedWin) {
    // Unknown windows count as available; an old value is an upper bound.
    const available = (a: PolicyAccount): boolean =>
      [a.fiveHour, a.sevenDay].every((w) => {
        const p = effectivePercent(w, now, margin, a.fresh)
        return p === null || p < at
      })
    const target = input.accounts.find((a) => a.id !== active.id && a.usable && available(a))
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

  // Back to the primary only after an automatic move away from it (a manual
  // pick of the secondary is never undone), its reset plus the margin, and a
  // fresh reading below returnBelowPercent on both windows. When no fresh
  // reading can come (stale: the parked token expired long before a 7d
  // reset), the estimate decides: a window whose reset + margin passed counts
  // as 0, the other keeps its last value; the live reading after the switch,
  // plus the dwell, corrects a wrong guess.
  if (active.role === 'secondary' && mem.lastSwitchReason === 'auto_exhausted' && cfg.returnToPrimary) {
    const primary = input.accounts.find((a) => a.role === 'primary' && a.usable)
    if (primary && (primary.fresh || primary.stale === true) && now >= (mem.exhaustedUntil ?? 0) + margin) {
      const five = effectivePercent(primary.fiveHour, now, margin, primary.fresh)
      const seven = effectivePercent(primary.sevenDay, now, margin, primary.fresh)
      if (five !== null && seven !== null && five < cfg.returnBelowPercent && seven < cfg.returnBelowPercent) {
        return maybeDefer({ kind: 'switch', to: primary.id, reason: 'auto_return' })
      }
    }
  }
  return stay('ok')
}
