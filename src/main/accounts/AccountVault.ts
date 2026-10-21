import { promises as fsp, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { writeAtomic } from '../fsAtomic'
import {
  ACCOUNT_ID_RE,
  cleanAccountLabel,
  type ClaudeAccountRole,
  type ClaudeAutoPause,
  type ClaudeSwitchReason,
} from '@shared/claude-accounts'
import type { VaultCrypto } from './safeCrypto'

/**
 * Saved Claude logins under `dataDir()/claude-accounts/` (app 2.3.0):
 *  - `accounts.json`: metadata only, never a token (UTF-8 without BOM, atomic);
 *  - `<id>.bin`: the captured `.credentials.json`, encrypted with safeStorage;
 *  - `prev.bin`: the live blob replaced by the last switch, encrypted (the
 *    only backup: nothing in plain text next to Claude's file).
 * A corrupt `accounts.json` is set aside as `accounts.json.corrupt-<ts>` and
 * the vault starts empty. Ids are checked with ACCOUNT_ID_RE before any path.
 */

export interface WindowSample {
  percent: number | null
  resetsAt: string | null
  at: number | null
}

export interface VaultAccountMeta {
  id: string
  role: ClaudeAccountRole
  label: string
  email: string | null
  accountUuid: string
  organizationUuid: string | null
  organizationName: string | null
  subscriptionType: string | null
  rateLimitTier: string | null
  capturedAt: number
  updatedAt: number
  identityConfirmed: boolean
  /** The saved login cannot be used (decrypt failed, or its refresh emptied the file). */
  needsRecapture: boolean
  lastUsage?: { fiveHour: WindowSample; sevenDay: WindowSample }
}

export interface VaultMeta {
  version: 1
  activeId: string | null
  lastSwitch: { at: number; from: string | null; to: string; reason: ClaudeSwitchReason } | null
  autoPaused: ClaudeAutoPause | null
  /** Reset of the window that made the policy leave the primary (epoch ms). */
  exhaustedUntil: number | null
  /**
   * Our last switch, until the target proved it can refresh: an emptied file
   * then rolls back to `from`. Persisted so a restart inside the window keeps
   * it. `targetExpiresAt`: the target snapshot's access token expiry (a
   * rollback needs its refresh to have been due).
   */
  verify: VaultVerify | null
  accounts: VaultAccountMeta[]
}

export interface VaultVerify {
  to: string
  from: string | null
  at: number
  targetExpiresAt: number | null
}

export interface Snapshot {
  v: 1
  /** The captured `.credentials.json`, byte for byte as text. */
  credentialsRaw: string
  capturedAt: number
}

export const emptyMeta = (): VaultMeta => ({ version: 1, activeId: null, lastSwitch: null, autoPaused: null, exhaustedUntil: null, verify: null, accounts: [] })

const REASONS: ReadonlySet<string> = new Set(['manual', 'phone', 'cli', 'auto_exhausted', 'auto_return', 'external', 'rollback'])
const PAUSES: ReadonlySet<string> = new Set(['unknownAccount', 'noLogin', 'conflict', 'locked', 'refreshFailed'])
const s = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function sample(v: unknown): WindowSample {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const p = n(o.percent)
  return { percent: p === null ? null : Math.max(0, Math.min(100, p)), resetsAt: s(o.resetsAt, 64), at: n(o.at) }
}

function account(v: unknown): VaultAccountMeta | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = s(o.id, 32)
  const accountUuid = s(o.accountUuid, 100)
  if (!id || !ACCOUNT_ID_RE.test(id) || !accountUuid) return null
  if (o.role !== 'primary' && o.role !== 'secondary') return null
  const lu = o.lastUsage && typeof o.lastUsage === 'object' ? (o.lastUsage as Record<string, unknown>) : null
  return {
    id,
    role: o.role,
    label: cleanAccountLabel(o.label),
    email: s(o.email),
    accountUuid,
    organizationUuid: s(o.organizationUuid, 100),
    organizationName: s(o.organizationName),
    subscriptionType: s(o.subscriptionType, 64),
    rateLimitTier: s(o.rateLimitTier, 100),
    capturedAt: n(o.capturedAt) ?? 0,
    updatedAt: n(o.updatedAt) ?? 0,
    identityConfirmed: o.identityConfirmed === true,
    needsRecapture: o.needsRecapture === true,
    ...(lu ? { lastUsage: { fiveHour: sample(lu.fiveHour), sevenDay: sample(lu.sevenDay) } } : {}),
  }
}

/** Defensive parse of accounts.json; null when it is not a vault file. */
export function parseMeta(raw: string): VaultMeta | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || (v as { version?: unknown }).version !== 1) return null
  const o = v as Record<string, unknown>
  const accounts: VaultAccountMeta[] = []
  for (const a of Array.isArray(o.accounts) ? o.accounts : []) {
    const acc = account(a)
    // One account per role, ids unique.
    if (acc && !accounts.some((x) => x.id === acc.id || x.role === acc.role)) accounts.push(acc)
  }
  const ls = o.lastSwitch && typeof o.lastSwitch === 'object' ? (o.lastSwitch as Record<string, unknown>) : null
  const lastSwitch =
    ls && n(ls.at) !== null && s(ls.to, 32) && typeof ls.reason === 'string' && REASONS.has(ls.reason)
      ? { at: n(ls.at) as number, from: s(ls.from, 32), to: s(ls.to, 32) as string, reason: ls.reason as ClaudeSwitchReason }
      : null
  const activeId = s(o.activeId, 32)
  const vf = o.verify && typeof o.verify === 'object' ? (o.verify as Record<string, unknown>) : null
  const vTo = s(vf?.to, 32)
  const vFrom = s(vf?.from, 32)
  const verify: VaultVerify | null =
    vf && vTo && ACCOUNT_ID_RE.test(vTo) && (vFrom === null || ACCOUNT_ID_RE.test(vFrom)) && n(vf.at) !== null
      ? { to: vTo, from: vFrom, at: n(vf.at) as number, targetExpiresAt: n(vf.targetExpiresAt) }
      : null
  return {
    version: 1,
    activeId: activeId && accounts.some((a) => a.id === activeId) ? activeId : null,
    lastSwitch,
    autoPaused: typeof o.autoPaused === 'string' && PAUSES.has(o.autoPaused) ? (o.autoPaused as ClaudeAutoPause) : null,
    exhaustedUntil: n(o.exhaustedUntil),
    verify: verify && accounts.some((a) => a.id === verify.to) ? verify : null,
    accounts,
  }
}

export class AccountVault {
  constructor(
    readonly dir: string,
    private readonly crypto: VaultCrypto,
    private readonly now: () => number = Date.now,
  ) {}

  private get metaPath(): string {
    return join(this.dir, 'accounts.json')
  }

  private binPath(id: string): string {
    if (!ACCOUNT_ID_RE.test(id)) throw new Error('bad_id')
    return join(this.dir, `${id}.bin`)
  }

  /** Synchronous at startup. Missing file = empty vault; a corrupt one is set aside. */
  load(): VaultMeta {
    let raw: string
    try {
      raw = readFileSync(this.metaPath, 'utf8')
    } catch {
      return emptyMeta()
    }
    const meta = parseMeta(raw)
    if (meta) return meta
    try {
      renameSync(this.metaPath, `${this.metaPath}.corrupt-${this.now()}`)
    } catch {
      /* left in place; the next save replaces it */
    }
    return emptyMeta()
  }

  async saveMeta(m: VaultMeta): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    await writeAtomic(this.metaPath, JSON.stringify(m, null, 2), { mode: 0o600 })
  }

  async putSnapshot(id: string, snap: Snapshot): Promise<void> {
    const file = this.binPath(id)
    await fsp.mkdir(this.dir, { recursive: true })
    await writeAtomic(file, this.crypto.encrypt(JSON.stringify(snap)), { mode: 0o600 })
  }

  /** Null when missing or when it cannot be decrypted (`failed` tells which). */
  async readSnapshot(id: string): Promise<{ snap: Snapshot | null; failed: boolean }> {
    let buf: Buffer
    try {
      buf = await fsp.readFile(this.binPath(id))
    } catch {
      return { snap: null, failed: false }
    }
    try {
      const v = JSON.parse(this.crypto.decrypt(buf)) as Partial<Snapshot> | null
      if (!v || v.v !== 1 || typeof v.credentialsRaw !== 'string') return { snap: null, failed: true }
      return { snap: { v: 1, credentialsRaw: v.credentialsRaw, capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : 0 }, failed: false }
    } catch {
      return { snap: null, failed: true }
    }
  }

  async getSnapshot(id: string): Promise<Snapshot | null> {
    return (await this.readSnapshot(id)).snap
  }

  /** The blob the last switch replaced, encrypted; a recovery aid only. */
  async putPrevious(raw: string): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    await writeAtomic(join(this.dir, 'prev.bin'), this.crypto.encrypt(JSON.stringify({ v: 1, credentialsRaw: raw, capturedAt: this.now() })), { mode: 0o600 })
  }

  /** Drop the recovery blob (a removed or replaced account must leave no working copy behind). */
  async removePrevious(): Promise<void> {
    await fsp.rm(join(this.dir, 'prev.bin'), { force: true })
  }

  async remove(id: string): Promise<void> {
    await fsp.rm(this.binPath(id), { force: true })
  }
}
