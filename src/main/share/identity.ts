/**
 * Share static identities (app 2.4.0, item 8): one X25519 key for this PC as
 * a host (its public half goes in every invite and is pinned by the guest)
 * and one as a guest (the host knows a returning guest by it, shows its
 * fingerprint in the join prompt and binds tickets to it). Separate keys, so
 * a guest can refuse an invite of its own host key (`self`).
 *
 * File: `dataDir()/share-identity.json`, main-owned, never in config:
 *   { version: 1, host?: Entry, guest?: Entry }
 *   Entry = { pub: base64url, priv: { enc: 'dpapi', data: base64 of the sealed PKCS#8 }, createdAt }
 * The private key is only ever persisted sealed by DPAPI (safeStorage, the
 * same VaultCrypto the Claude accounts use). Without encryption the key
 * lives in memory for this run only (`persisted: false`, the UI says invites
 * and links die on quit) and the file is left untouched; an entry that is not
 * `enc: 'dpapi'` is never trusted. An entry DPAPI cannot open (a portable
 * moved to another user or PC) is replaced (`regenerated: true`: old invites
 * die and guests see "identity changed").
 *
 * Writes are synchronous temp + rename (UTF-8, no BOM), so two persists can
 * never land out of order.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod'
import { dataDir } from '../paths'
import { electronCrypto, type VaultCrypto } from '../accounts/safeCrypto'
import { exportShareKey, fromB64u, generateShareKeyPair, importShareKey, keyFingerprint, safeEqual, toB64u, type ShareKeyPair } from './crypto'

export type ShareIdentityRole = 'host' | 'guest'

export interface ShareIdentity extends ShareKeyPair {
  role: ShareIdentityRole
  /** `AB12-CD34-EF56-7890` of the public key. */
  fingerprint: string
  /** False = memory only (no encryption available): gone on quit. */
  persisted: boolean
  /** True when a stored key could not be opened and this run made a new one. */
  regenerated: boolean
}

const entrySchema = z.object({
  pub: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  priv: z.object({ enc: z.literal('dpapi'), data: z.string().min(1).max(8192) }),
  createdAt: z.number().int().min(0),
})
type Entry = z.infer<typeof entrySchema>

const fileSchema = z.object({
  version: z.literal(1),
  host: z.unknown().optional(),
  guest: z.unknown().optional(),
})

export function shareIdentityPath(): string {
  return join(dataDir(), 'share-identity.json')
}

export class ShareIdentityStore {
  private loaded = false
  /** Entries as stored (raw, so an entry this run cannot read is kept for the other role's writes). */
  private doc: { host?: unknown; guest?: unknown } = {}
  private readonly cache = new Map<ShareIdentityRole, ShareIdentity>()

  constructor(
    private readonly file: string,
    private readonly vault: VaultCrypto,
    private readonly now: () => number = Date.now,
    private readonly warn: (msg: string, err?: unknown) => void = (msg, err) => console.warn(`[share] ${msg}`, err ?? ''),
  ) {}

  /** The role's identity, created (and persisted when possible) on first use. */
  get(role: ShareIdentityRole): ShareIdentity {
    const cached = this.cache.get(role)
    if (cached) return cached
    this.load()
    const available = this.vault.available()
    const raw = this.doc[role]
    const entry = entrySchema.safeParse(raw)
    let regenerated = false
    if (entry.success && available) {
      const pair = this.open(entry.data)
      if (pair) return this.remember(role, pair, true, false)
      regenerated = true
    } else if (raw !== undefined && available) {
      regenerated = true // malformed or not DPAPI-sealed: never trusted
    }
    const pair = generateShareKeyPair()
    if (!available) return this.remember(role, pair, false, false)
    const persisted = this.persist(role, pair)
    return this.remember(role, pair, persisted, regenerated)
  }

  /** The role's public key without creating one (null when there is none yet). */
  peekPub(role: ShareIdentityRole): Buffer | null {
    const cached = this.cache.get(role)
    if (cached) return cached.pub
    this.load()
    const entry = entrySchema.safeParse(this.doc[role])
    return entry.success ? fromB64u(entry.data.pub, 32) : null
  }

  private remember(role: ShareIdentityRole, pair: ShareKeyPair, persisted: boolean, regenerated: boolean): ShareIdentity {
    const id: ShareIdentity = { ...pair, role, fingerprint: keyFingerprint(pair.pub), persisted, regenerated }
    this.cache.set(role, id)
    return id
  }

  private open(entry: Entry): ShareKeyPair | null {
    try {
      const der = Buffer.from(this.vault.decrypt(Buffer.from(entry.priv.data, 'base64')), 'base64')
      const pair = importShareKey(der)
      const pub = fromB64u(entry.pub, 32)
      if (!pub || !safeEqual(pub, pair.pub)) return null
      return pair
    } catch (err) {
      this.warn('share identity cannot be decrypted, making a new one', err)
      return null
    }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file)) return
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
      if (parsed.success) this.doc = { host: parsed.data.host, guest: parsed.data.guest }
      else this.warn('share identity file is malformed, ignoring it')
    } catch (err) {
      this.warn('share identity file unreadable, ignoring it', err)
    }
  }

  private persist(role: ShareIdentityRole, pair: ShareKeyPair): boolean {
    let sealed: Buffer
    try {
      sealed = this.vault.encrypt(exportShareKey(pair).toString('base64'))
    } catch (err) {
      this.warn('share identity cannot be encrypted, keeping it in memory', err)
      return false
    }
    const entry: Entry = { pub: toB64u(pair.pub), priv: { enc: 'dpapi', data: sealed.toString('base64') }, createdAt: this.now() }
    const next = { ...this.doc, [role]: entry }
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, ...next }, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
      this.doc = next
      return true
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // nothing left to clean
      }
      this.warn('share identity cannot be saved, keeping it in memory', err)
      return false
    }
  }
}

/** The store over the real file and DPAPI (needs app ready). */
export function createShareIdentityStore(): ShareIdentityStore {
  return new ShareIdentityStore(shareIdentityPath(), electronCrypto())
}
