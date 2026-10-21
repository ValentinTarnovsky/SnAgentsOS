import { copyFileSync, existsSync, promises as fsp, readFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { writeAtomic } from '../fsAtomic'
import {
  ACCOUNT_ID_RE,
  MAX_CLAUDE_ACCOUNTS,
  cleanAccountLabel,
  type ClaudeAccountRole,
  type ClaudeAutoPause,
  type ClaudeSwitchReason,
} from '@shared/claude-accounts'
import type { VaultCrypto } from './safeCrypto'

/**
 * Saved Claude logins under `dataDir()/claude-accounts/`:
 *  - `accounts.v2.json` (app 2.4.0): metadata only, never a token (UTF-8
 *    without BOM, atomic). The array order is the priority (index = rank),
 *    each account keeps its own `exhaustedUntil`, and `anchorId` is the
 *    account the user picked last;
 *  - `accounts.json` (app 2.3.0, two roles): read only to migrate and never
 *    written, renamed or deleted again, so a downgrade to 2.3.0 finds it as
 *    it was;
 *  - `<id>.bin`: the captured `.credentials.json`, encrypted with safeStorage
 *    (shared by both formats, untouched by the migration);
 *  - `prev.bin`: the live blob replaced by the last switch, encrypted (the
 *    only backup: nothing in plain text next to Claude's file).
 * Each save records the size and mtime of `accounts.json` (`v1Seen`): only a
 * different one (a 2.3.0 ran in between) merges v1 into v2 again, so a clock
 * skew never re-migrates and nothing 2.4.0 keeps alone (accounts #3 to #8,
 * the order, the anchor) is lost to a downgrade.
 * A corrupt `accounts.v2.json` is set aside as `accounts.v2.json.corrupt-<ts>`
 * and the vault migrates from v1 again (or starts empty). Ids are checked
 * with ACCOUNT_ID_RE before any path.
 */

export interface WindowSample {
  percent: number | null
  resetsAt: string | null
  at: number | null
}

/** One account of `accounts.json` (v1, app 2.3.0). */
export interface VaultAccountMetaV1 extends Omit<VaultAccountMeta, 'exhaustedUntil'> {
  role: ClaudeAccountRole
}

/** One account of `accounts.v2.json`; its index in the array is its rank. */
export interface VaultAccountMeta {
  id: string
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
  /**
   * Reset of the window that made the policy leave this account (epoch ms):
   * it is no target and no return candidate before it plus the margin.
   */
  exhaustedUntil: number | null
  lastUsage?: { fiveHour: WindowSample; sevenDay: WindowSample }
}

type LastSwitch = { at: number; from: string | null; to: string; reason: ClaudeSwitchReason }

/** `accounts.json` (app 2.3.0): one account per role, one global exhaustedUntil. */
export interface VaultMetaV1 {
  version: 1
  activeId: string | null
  lastSwitch: LastSwitch | null
  autoPaused: ClaudeAutoPause | null
  /** Reset of the window that made the policy leave the primary (epoch ms). */
  exhaustedUntil: number | null
  verify: VaultVerify | null
  accounts: VaultAccountMetaV1[]
}

/** `accounts.v2.json` (app 2.4.0). */
export interface VaultMeta {
  version: 2
  activeId: string | null
  /** The account the user picked last; the automatic return never climbs above it (null = the first). */
  anchorId: string | null
  lastSwitch: LastSwitch | null
  autoPaused: ClaudeAutoPause | null
  /**
   * Our last switch, until the target proved it can refresh: an emptied file
   * then rolls back to `from`. Persisted so a restart inside the window keeps
   * it. `targetExpiresAt`: the target snapshot's access token expiry (a
   * rollback needs its refresh to have been due).
   */
  verify: VaultVerify | null
  accounts: VaultAccountMeta[]
  /** Size and mtime of accounts.json at the last save (null = there was none; absent = a file from before it was recorded). */
  v1Seen?: V1Fingerprint | null
}

export interface V1Fingerprint {
  mtimeMs: number
  size: number
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

export const emptyMeta = (): VaultMeta => ({ version: 2, activeId: null, anchorId: null, lastSwitch: null, autoPaused: null, verify: null, accounts: [] })

const REASONS: ReadonlySet<string> = new Set(['manual', 'phone', 'cli', 'auto_exhausted', 'auto_return', 'external', 'rollback'])
const PAUSES: ReadonlySet<string> = new Set(['unknownAccount', 'noLogin', 'conflict', 'locked', 'refreshFailed'])
/** The switches that were the user's own pick (they anchor the automatic return). */
export const ANCHOR_REASONS: ReadonlySet<string> = new Set(['manual', 'phone', 'cli', 'external'])
const s = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const identityOf = (a: { accountUuid: string; organizationUuid: string | null }): string => `${a.accountUuid}:${a.organizationUuid ?? ''}`

function sample(v: unknown): WindowSample {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const p = n(o.percent)
  return { percent: p === null ? null : Math.max(0, Math.min(100, p)), resetsAt: s(o.resetsAt, 64), at: n(o.at) }
}

/** The fields both formats share; null when the id or the identity is missing. */
function accountBase(v: unknown): Omit<VaultAccountMeta, 'exhaustedUntil'> | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = s(o.id, 32)
  const accountUuid = s(o.accountUuid, 100)
  if (!id || !ACCOUNT_ID_RE.test(id) || !accountUuid) return null
  const lu = o.lastUsage && typeof o.lastUsage === 'object' ? (o.lastUsage as Record<string, unknown>) : null
  return {
    id,
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

function parseObject(raw: string, version: number): Record<string, unknown> | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || (v as { version?: unknown }).version !== version) return null
  return v as Record<string, unknown>
}

/** lastSwitch, autoPaused, activeId and verify, the same in both formats. */
function commonFields(o: Record<string, unknown>, ids: ReadonlySet<string>): Pick<VaultMeta, 'activeId' | 'lastSwitch' | 'autoPaused' | 'verify'> {
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
    activeId: activeId && ids.has(activeId) ? activeId : null,
    lastSwitch,
    autoPaused: typeof o.autoPaused === 'string' && PAUSES.has(o.autoPaused) ? (o.autoPaused as ClaudeAutoPause) : null,
    verify: verify && ids.has(verify.to) ? verify : null,
  }
}

/** Defensive parse of accounts.json (v1, app 2.3.0); null when it is not a v1 vault file. */
export function parseMetaV1(raw: string): VaultMetaV1 | null {
  const o = parseObject(raw, 1)
  if (!o) return null
  const accounts: VaultAccountMetaV1[] = []
  for (const a of Array.isArray(o.accounts) ? o.accounts : []) {
    const base = accountBase(a)
    const role = (a as { role?: unknown } | null)?.role
    if (!base || (role !== 'primary' && role !== 'secondary')) continue
    // One account per role, ids unique.
    if (!accounts.some((x) => x.id === base.id || x.role === role)) accounts.push({ ...base, role })
  }
  return { version: 1, ...commonFields(o, new Set(accounts.map((a) => a.id))), exhaustedUntil: n(o.exhaustedUntil), accounts }
}

/** The 2.3.0 name of the v1 parser. */
export const parseMeta = parseMetaV1

/** Defensive parse of accounts.v2.json; null when it is not a v2 vault file. Ids and identities unique, at most MAX_CLAUDE_ACCOUNTS. */
export function parseMetaV2(raw: string): VaultMeta | null {
  const o = parseObject(raw, 2)
  if (!o) return null
  const accounts: VaultAccountMeta[] = []
  for (const a of Array.isArray(o.accounts) ? o.accounts : []) {
    if (accounts.length >= MAX_CLAUDE_ACCOUNTS) break
    const base = accountBase(a)
    if (!base || accounts.some((x) => x.id === base.id || identityOf(x) === identityOf(base))) continue
    accounts.push({ ...base, exhaustedUntil: n((a as { exhaustedUntil?: unknown }).exhaustedUntil) })
  }
  const ids = new Set(accounts.map((a) => a.id))
  const anchorId = s(o.anchorId, 32)
  const c = commonFields(o, ids)
  const meta: VaultMeta = { version: 2, activeId: c.activeId, anchorId: anchorId && ids.has(anchorId) ? anchorId : null, lastSwitch: c.lastSwitch, autoPaused: c.autoPaused, verify: c.verify, accounts }
  if ('v1Seen' in o) {
    const f = o.v1Seen && typeof o.v1Seen === 'object' ? (o.v1Seen as Record<string, unknown>) : null
    const mtimeMs = n(f?.mtimeMs)
    const size = n(f?.size)
    meta.v1Seen = mtimeMs !== null && size !== null ? { mtimeMs, size } : null
  }
  return meta
}

/**
 * v1 to v2: the primary first, then the secondary. The global exhaustedUntil
 * goes to the account an automatic switch left (`lastSwitch.from` when its
 * reason was auto_exhausted), else to the primary. The anchor is the target
 * of the last switch the user made (manual, phone, cli, external), else the
 * primary.
 */
export function migrateV1(v1: VaultMetaV1): VaultMeta {
  const ordered = [...v1.accounts].sort((a, b) => (a.role === b.role ? 0 : a.role === 'primary' ? -1 : 1))
  const primary = ordered.find((a) => a.role === 'primary') ?? null
  const ls = v1.lastSwitch
  const has = (id: string | null | undefined): id is string => !!id && ordered.some((a) => a.id === id)
  const exhaustedId = ls?.reason === 'auto_exhausted' && has(ls.from) ? ls.from : (primary?.id ?? null)
  const accounts: VaultAccountMeta[] = ordered.map(({ role: _role, ...a }) => ({ ...a, exhaustedUntil: a.id === exhaustedId ? v1.exhaustedUntil : null }))
  const anchorId = ls && ANCHOR_REASONS.has(ls.reason) && has(ls.to) ? ls.to : (primary?.id ?? null)
  return { version: 2, activeId: v1.activeId, anchorId, lastSwitch: v1.lastSwitch, autoPaused: v1.autoPaused, verify: v1.verify, accounts }
}

/** The fields accounts.json (2.3.0) owns for an account both formats know. */
const V1_OWNED = ['email', 'accountUuid', 'organizationUuid', 'organizationName', 'subscriptionType', 'rateLimitTier', 'capturedAt', 'identityConfirmed', 'needsRecapture', 'updatedAt'] as const

/**
 * accounts.json changed under a v2 vault (a 2.3.0 ran in between): v1 merged
 * into v2, never replacing it.
 *  - v2's accounts in v2 order; for those v1 knows (by id, else by identity)
 *    v1's identity fields, needsRecapture, lastUsage and updatedAt, and its
 *    label only when v1 edited the account later;
 *  - the v1 accounts v2 lacks appended, up to MAX_CLAUDE_ACCOUNTS;
 *  - a v2-only account stays while its `<id>.bin` exists (`hasBin`), so one
 *    2.3.0 removed is dropped;
 *  - exhaustedUntil: the later of v2's and the one 2.3.0 left; the anchor
 *    from v2 (else v1's); activeId, lastSwitch, autoPaused and verify from v1
 *    when its active account is in the list, else v2's.
 */
export function mergeV1(v2: VaultMeta, v1: VaultMetaV1, hasBin: (id: string) => boolean): VaultMeta {
  const m1 = migrateV1(v1)
  const matched = new Set<string>()
  const accounts: VaultAccountMeta[] = []
  for (const a of v2.accounts) {
    const b = m1.accounts.find((x) => x.id === a.id) ?? m1.accounts.find((x) => !matched.has(x.id) && identityOf(x) === identityOf(a))
    if (!b) {
      if (hasBin(a.id)) accounts.push({ ...a })
      continue
    }
    matched.add(b.id)
    const next: VaultAccountMeta = { ...a }
    for (const k of V1_OWNED) (next as unknown as Record<string, unknown>)[k] = b[k]
    if (b.lastUsage) next.lastUsage = b.lastUsage
    if (b.updatedAt > a.updatedAt) next.label = b.label
    next.exhaustedUntil = a.exhaustedUntil === null ? b.exhaustedUntil : b.exhaustedUntil === null ? a.exhaustedUntil : Math.max(a.exhaustedUntil, b.exhaustedUntil)
    accounts.push(next)
  }
  for (const b of m1.accounts) {
    if (matched.has(b.id) || accounts.length >= MAX_CLAUDE_ACCOUNTS) continue
    if (accounts.some((x) => x.id === b.id || identityOf(x) === identityOf(b))) continue
    accounts.push({ ...b })
  }
  const ids = new Set(accounts.map((a) => a.id))
  const has = (id: string | null | undefined): id is string => !!id && ids.has(id)
  const fromV1 = has(v1.activeId)
  const src = fromV1 ? m1 : v2
  return {
    version: 2,
    activeId: fromV1 ? v1.activeId : has(v2.activeId) ? v2.activeId : null,
    anchorId: has(v2.anchorId) ? v2.anchorId : has(m1.anchorId) ? m1.anchorId : null,
    lastSwitch: src.lastSwitch && has(src.lastSwitch.to) ? src.lastSwitch : null,
    autoPaused: src.autoPaused,
    verify: src.verify && has(src.verify.to) ? src.verify : null,
    accounts,
  }
}

export class AccountVault {
  /** The last load() built the list from accounts.json (v1): the service saves it as v2 once. */
  migratedFromV1 = false

  constructor(
    readonly dir: string,
    private readonly crypto: VaultCrypto,
    private readonly now: () => number = Date.now,
  ) {}

  /** v2, the only metadata file written. */
  private get metaPath(): string {
    return join(this.dir, 'accounts.v2.json')
  }

  /** v1 (app 2.3.0), read only. */
  private get v1Path(): string {
    return join(this.dir, 'accounts.json')
  }

  private binPath(id: string): string {
    if (!ACCOUNT_ID_RE.test(id)) throw new Error('bad_id')
    return join(this.dir, `${id}.bin`)
  }

  private readV1(): VaultMetaV1 | null {
    try {
      return parseMetaV1(readFileSync(this.v1Path, 'utf8'))
    } catch {
      return null
    }
  }

  private v1Stat(): V1Fingerprint | null {
    try {
      const st = statSync(this.v1Path)
      return { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
  }

  /**
   * accounts.json is not the one the last save saw: a 2.3.0 ran in between.
   * A v2 file from before the fingerprint falls back to the mtime comparison
   * (once: the next save records it).
   */
  private v1Changed(meta: VaultMeta): boolean {
    const cur = this.v1Stat()
    if (!cur) return false
    if (meta.v1Seen === undefined) {
      try {
        return cur.mtimeMs > statSync(this.metaPath).mtimeMs
      } catch {
        return false
      }
    }
    return meta.v1Seen === null || meta.v1Seen.mtimeMs !== cur.mtimeMs || meta.v1Seen.size !== cur.size
  }

  /** `corrupt` moves v2 aside; `bak` keeps a copy (the merge is saved over v2 right after). */
  private setAside(suffix: 'bak' | 'corrupt'): void {
    const to = `${this.metaPath}.${suffix}-${this.now()}`
    try {
      if (suffix === 'bak') copyFileSync(this.metaPath, to)
      else renameSync(this.metaPath, to)
    } catch {
      /* left in place; the next save replaces it */
    }
  }

  /**
   * Synchronous at startup.
   *  1. accounts.v2.json parses: used, unless accounts.json is not the one
   *     its last save saw (a 2.3.0 ran after it): then v2 is copied to
   *     `.bak-<ts>` and v1 merged into it (mergeV1).
   *  2. accounts.v2.json corrupt: set aside as `.corrupt-<ts>`, then 3.
   *  3. Only accounts.json: migrated. Neither (or a corrupt v1): empty.
   * accounts.json itself is never written, renamed or removed.
   */
  load(): VaultMeta {
    this.migratedFromV1 = false
    let raw: string | null
    try {
      raw = readFileSync(this.metaPath, 'utf8')
    } catch {
      raw = null
    }
    if (raw !== null) {
      const meta = parseMetaV2(raw)
      if (meta) {
        if (!this.v1Changed(meta)) return meta
        const v1 = this.readV1()
        if (!v1) return meta
        this.setAside('bak')
        this.migratedFromV1 = true
        return mergeV1(meta, v1, (id) => {
          try {
            return existsSync(this.binPath(id))
          } catch {
            return false
          }
        })
      }
      this.setAside('corrupt')
    }
    const v1 = this.readV1()
    if (!v1) return emptyMeta()
    this.migratedFromV1 = true
    return migrateV1(v1)
  }

  /** Records the accounts.json it saw (`v1Seen`) in the file and on `m`. */
  async saveMeta(m: VaultMeta): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    m.v1Seen = this.v1Stat()
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
