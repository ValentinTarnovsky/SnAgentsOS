/**
 * Claude multi-account switching (app 2.3.0, item 9): state and view types
 * shared by main, the renderer and the phone. Nothing here ever carries a
 * token or the raw credentials file; the phone only gets `UsageActiveAccount`
 * (no email). No Node or DOM imports.
 *
 * App 2.4.0: up to MAX_CLAUDE_ACCOUNTS accounts in priority order (`rank`,
 * 0 = highest). `role` is derived from the rank only for older callers
 * (rank 0 is 'primary', every other one 'secondary').
 */
import type { ClaudeAccountsSettings } from './types'

export type ClaudeAccountRole = 'primary' | 'secondary'

/** Most saved Claude accounts (app 2.4.0). */
export const MAX_CLAUDE_ACCOUNTS = 8

/** The compat role of a rank: 0 is the primary, every other one a secondary. */
export function roleOfRank(rank: number): ClaudeAccountRole {
  return rank === 0 ? 'primary' : 'secondary'
}

/** The rank a legacy role names: 'primary' is 0, 'secondary' is 1. */
export function rankOfRole(role: ClaudeAccountRole): number {
  return role === 'primary' ? 0 : 1
}

/**
 * Why the live login changed. `manual` / `phone` come from the desktop UI and
 * the phone, `cli` from `snaos account use`, `auto_*` from the policy,
 * `external` from a login main did not write, `rollback` from main putting the
 * previous account back after the target's token refresh emptied the file.
 */
export type ClaudeSwitchReason = 'manual' | 'phone' | 'cli' | 'auto_exhausted' | 'auto_return' | 'external' | 'rollback'

/** Reasons the renderer may claim over IPC (main validates). */
export const RENDERER_SWITCH_REASONS = ['manual', 'phone'] as const
export type RendererSwitchReason = (typeof RENDERER_SWITCH_REASONS)[number]

/** Main-made account id; validated before any path is built from it. */
export const ACCOUNT_ID_RE = /^acc_[0-9a-f]{12}$/

/** Longest account label (one line). */
export const ACCOUNT_LABEL_MAX = 40

export interface ClaudeAccountWindowView {
  percent: number | null
  /** ISO-8601 reset, when known. */
  resetsAt: string | null
  /** Epoch ms of the reading. */
  at: number | null
  /** `live`: the active account's poll; `parked`: its own token; `estimated`: the reset passed. */
  source: 'live' | 'parked' | 'estimated' | 'none'
}

export interface ClaudeAccountView {
  id: string
  /** Priority, 0-based (0 = highest). The list comes sorted by it. */
  rank: number
  /** Derived from `rank` (compat). */
  role: ClaudeAccountRole
  /** User label ('' = show "Account N"). */
  label: string
  /** Desktop only (accounts:getState); never sent to the phone. */
  email: string | null
  organizationName: string | null
  subscriptionType: string | null
  capturedAt: number
  active: boolean
  /** Never the token itself. `invalid`: the saved login cannot be used (see needsRecapture). */
  tokenState: 'ok' | 'expired' | 'invalid'
  /** The saved login cannot be used (it could not be decrypted, or its refresh failed): capture it again. */
  needsRecapture: boolean
  /** False when the identity came from `.claude.json` because the profile endpoint failed. */
  identityConfirmed: boolean
  usage: { fiveHour: ClaudeAccountWindowView; sevenDay: ClaudeAccountWindowView }
}

/** Why automatic switching is paused (null = not paused). */
export type ClaudeAutoPause = 'unknownAccount' | 'noLogin' | 'conflict' | 'locked' | 'refreshFailed'

export interface ClaudeAccountsState {
  supported: boolean
  unsupportedReason?: 'keychain' | 'encryption_unavailable'
  /** A running `claude` follows the replaced file (SPIKE 2026-10-20): no restart needed. */
  liveSwitch: boolean
  accounts: ClaudeAccountView[]
  activeId: string | null
  /** `known`: the live login is a saved account; `unknown`: another one; `none`: no login. */
  liveIdentity: 'known' | 'unknown' | 'none'
  /** Email of an unknown live login (desktop only), when the profile told it. */
  liveEmail?: string | null
  /**
   * The live login changed and could not be identified yet (its access token
   * expired, or the profile endpoint is unreachable): switching answers
   * `identity_failed` until a Claude console refreshes it. Absent = false.
   */
  liveUnverified?: boolean
  autoPaused: ClaudeAutoPause | null
  /**
   * app 2.4.0: the account the user picked last (a manual, phone or CLI
   * switch, a capture, an outside /login). The automatic return never climbs
   * above it. Absent or null = the first account.
   */
  anchorId?: string | null
  lastSwitch: { at: number; from: string | null; to: string; reason: ClaudeSwitchReason } | null
  pending: { to: string; reason: 'auto_exhausted' | 'auto_return'; since: number } | null
  blocked: 'allExhausted' | null
  /** Pane ids to restart; always empty while `liveSwitch`. */
  restartNeeded: string[]
}

export type AccountsOpError =
  | 'not_found'
  | 'unknown_live_account'
  | 'no_login'
  | 'encryption_unavailable'
  | 'locked'
  | 'identity_failed'
  | 'duplicate'
  /** 2.3.0 only (two fixed slots); kept for older callers. */
  | 'role_taken'
  /** app 2.4.0: MAX_CLAUDE_ACCOUNTS are saved already. */
  | 'limit_reached'
  | 'busy'
  | 'io'
  | 'unsupported'
  | 'bad_request'

export interface AccountsOpRes {
  ok: boolean
  error?: AccountsOpError
  state: ClaudeAccountsState
}

export interface ClaudeAccountsEvent {
  /** `loggedOut`: the active login's refresh failed and emptied the file, with nothing to roll back to. */
  kind: 'switched' | 'allExhausted' | 'unknownAccount' | 'conflict' | 'rollback' | 'locked' | 'loggedOut'
  auto: boolean
  from?: string
  to?: string
  reason?: ClaudeSwitchReason
  window?: '5h' | '7d'
  percent?: number
  at: number
}

/**
 * IPC payloads (accounts:*), validated with zod in main.
 * Capture (app 2.4.0): appended as the last account, or in place of
 * `replaceId` (same rank). The same identity again re-captures in place. The
 * 2.3.0 shape `{ role, replace: true }` replaces the account at that role's
 * rank.
 */
export interface AccountsCaptureReq {
  label?: string
  replaceId?: string
  /**
   * Re-capture only: the live login must be this saved account (else
   * `duplicate` when it is another saved one, `unknown_live_account` when it
   * is not saved). Never appends or replaces.
   */
  recaptureId?: string
  /** @deprecated 2.3.0 slots. */
  role?: ClaudeAccountRole
  /** @deprecated 2.3.0 slots, with `role`. */
  replace?: boolean
}
export interface AccountsSwitchReq {
  /** An account id, or 'primary' | 'secondary' (rank 0 / 1). */
  target: string
  reason: RendererSwitchReason
}
/** app 2.4.0: the new priority order, every saved id exactly once. */
export interface AccountsReorderReq {
  ids: string[]
}

/** A saved account the phone may switch to (no email). */
export interface UsageOtherAccount {
  id: string
  /** 0-based priority. */
  rank: number
  /** Derived from the rank (compat). */
  role: ClaudeAccountRole
  /** '' = show "Account N". Never carries an `@`. */
  label: string
  /** False when the saved login must be captured again. */
  ready: boolean
}

/** The active account in the usage snapshot. No email: it also travels to the phone. */
export interface UsageActiveAccount {
  id: string
  /** app 2.4.0: 0-based priority (absent from a 2.3.0 desktop). */
  rank?: number
  role: ClaudeAccountRole
  /** '' = show the role name (2.3.0) or "Account N". Never carries an `@`. */
  label: string
  /**
   * The first other account by rank (the 2.3.0 phone's "Use <other>", sent
   * by role): rank 0, or rank 1 when the active one is rank 0, so its derived
   * role always names it.
   */
  other?: { id: string; rank?: number; role: ClaudeAccountRole; label: string }
  /** app 2.4.0: every other saved account by rank (the phone's picker, sent by id). */
  others?: UsageOtherAccount[]
}

export const DEFAULT_CLAUDE_ACCOUNTS_SETTINGS: ClaudeAccountsSettings = {
  autoSwitch: false,
  switchAtPercent: 99,
  returnToPrimary: true,
  returnBelowPercent: 90,
  returnMarginMinutes: 5,
  minDwellMinutes: 10,
  deferWhileWorking: true,
  deferMaxMinutes: 3,
  pollParked: true,
  alertOnSwitch: true,
}

function intIn(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt
  return Math.max(min, Math.min(max, Math.round(v)))
}
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)

/** Every field clamped to its range, junk to the default, and `returnBelowPercent < switchAtPercent`. */
export function normalizeAccountsSettings(c: Partial<ClaudeAccountsSettings> | null | undefined): ClaudeAccountsSettings {
  const d = DEFAULT_CLAUDE_ACCOUNTS_SETTINGS
  const src: Partial<ClaudeAccountsSettings> = c && typeof c === 'object' ? c : {}
  const switchAtPercent = intIn(src.switchAtPercent, 50, 100, d.switchAtPercent)
  let returnBelowPercent = intIn(src.returnBelowPercent, 0, 99, d.returnBelowPercent)
  if (returnBelowPercent >= switchAtPercent) returnBelowPercent = switchAtPercent - 1
  return {
    autoSwitch: bool(src.autoSwitch, d.autoSwitch),
    switchAtPercent,
    returnToPrimary: bool(src.returnToPrimary, d.returnToPrimary),
    returnBelowPercent,
    returnMarginMinutes: intIn(src.returnMarginMinutes, 0, 120, d.returnMarginMinutes),
    minDwellMinutes: intIn(src.minDwellMinutes, 0, 240, d.minDwellMinutes),
    deferWhileWorking: bool(src.deferWhileWorking, d.deferWhileWorking),
    deferMaxMinutes: intIn(src.deferMaxMinutes, 0, 60, d.deferMaxMinutes),
    pollParked: bool(src.pollParked, d.pollParked),
    alertOnSwitch: bool(src.alertOnSwitch, d.alertOnSwitch),
  }
}

/** One line, at most ACCOUNT_LABEL_MAX characters. */
export function cleanAccountLabel(label: unknown): string {
  if (typeof label !== 'string') return ''
  return label.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ACCOUNT_LABEL_MAX)
}

/** The other role. */
export function otherRole(role: ClaudeAccountRole): ClaudeAccountRole {
  return role === 'primary' ? 'secondary' : 'primary'
}
