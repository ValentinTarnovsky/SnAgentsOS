/**
 * Claude multi-account switching (app 2.3.0, item 9): state and view types
 * shared by main, the renderer and the phone. Nothing here ever carries a
 * token or the raw credentials file; the phone only gets `UsageActiveAccount`
 * (no email). No Node or DOM imports.
 */
import type { ClaudeAccountsSettings } from './types'

export type ClaudeAccountRole = 'primary' | 'secondary'

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
  role: ClaudeAccountRole
  /** User label ('' = show the role name). */
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
  | 'role_taken'
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

/** IPC payloads (accounts:*), validated with zod in main. */
export interface AccountsCaptureReq {
  role: ClaudeAccountRole
  label?: string
  replace?: boolean
}
export interface AccountsSwitchReq {
  /** 'primary' | 'secondary' | an account id. */
  target: string
  reason: RendererSwitchReason
}

/** The active account in the usage snapshot. No email: it also travels to the phone. */
export interface UsageActiveAccount {
  id: string
  role: ClaudeAccountRole
  /** '' = show the role name. Never carries an `@`. */
  label: string
  /** The other saved account, when there is one (the phone's "Use <other>"). */
  other?: { id: string; role: ClaudeAccountRole; label: string }
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
