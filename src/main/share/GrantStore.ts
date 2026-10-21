/**
 * Share grants of this PC as a host (app 2.4.0, item 8): what is shared
 * (one console, or every console of a workspace), with which permission,
 * under which invite key and optional unattended password.
 *
 * File: `dataDir()/share-grants.json`, main-owned, never in config:
 *   { version: 1, grants: [{ id, shareId, label, scope, perm,
 *     inviteKey: { enc: 'dpapi', data }, password?: { salt, N, r, p, key: { enc: 'dpapi', data } },
 *     createdAt, expiresAt?, paused?, knownGuests?: [{ key, name, lastAt }] (<= 20) }] }
 * The invite key and the password key are only ever persisted sealed by
 * DPAPI (safeStorage). Without encryption nothing is written: grants live in
 * memory for this run (`persisted: false`, the UI says they end on quit) and
 * a password cannot be set (`encryption_unavailable`). A secret DPAPI cannot
 * open (a portable moved to another PC) drops its grant, or its password.
 *
 * Writes are synchronous temp + rename (UTF-8, no BOM), so two persists can
 * never land out of order: a revoke persisted next to a knownGuests update
 * always leaves the revoked grant out. Callers that work asynchronously (the
 * password's scrypt) re-check the grant still exists before committing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { SHARE_LIMITS, SHARE_SCRYPT, shareText } from '@shared/share-protocol'
import type { SharePerm } from '@shared/types'
import { dataDir } from '../paths'
import type { VaultCrypto } from '../accounts/safeCrypto'
import { fromB64u, toB64u } from './crypto'

export const SHARE_GRANTS_MAX = 20
export const SHARE_KNOWN_GUESTS_MAX = 20

export type ShareGrantScope = { kind: 'pane'; paneId: string; workspaceId: string } | { kind: 'workspace'; workspaceId: string }

export interface ShareKnownGuest {
  /** The guest static key, base64url. */
  key: string
  name: string
  lastAt: number
}

export interface ShareGrant {
  id: string
  /** 16 random bytes, base64url: the invite's `s`, the hello's `sid`. */
  shareId: string
  label: string
  scope: ShareGrantScope
  perm: SharePerm
  inviteKey: Buffer
  password?: { salt: Buffer; key: Buffer }
  createdAt: number
  expiresAt?: number
  paused: boolean
  knownGuests: ShareKnownGuest[]
}

export interface NewShareGrant {
  label: string
  scope: ShareGrantScope
  perm: SharePerm
  expiresAt?: number
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const sealedSchema = z.object({ enc: z.literal('dpapi'), data: z.string().min(1).max(8192) })
const scopeSchema = z.union([
  z.object({ kind: z.literal('pane'), paneId: z.string().min(1).max(128), workspaceId: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('workspace'), workspaceId: z.string().min(1).max(128) }),
])
const grantSchema = z.object({
  id: z.string().regex(ID_RE),
  shareId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  label: z.string().max(SHARE_LIMITS.labelMax),
  scope: scopeSchema,
  perm: z.enum(['view', 'type', 'full']),
  inviteKey: sealedSchema,
  password: z
    .object({ salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/), N: z.number(), r: z.number(), p: z.number(), key: sealedSchema })
    .optional(),
  createdAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0).optional(),
  paused: z.boolean().optional(),
  knownGuests: z
    .array(z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/), name: z.string().max(SHARE_LIMITS.guestNameMax), lastAt: z.number().int().min(0) }))
    .max(SHARE_KNOWN_GUESTS_MAX)
    .optional(),
})
const fileSchema = z.object({ version: z.literal(1), grants: z.array(z.unknown()).max(SHARE_GRANTS_MAX * 2) })

export function shareGrantsPath(): string {
  return join(dataDir(), 'share-grants.json')
}

export class GrantStore {
  private readonly grants = new Map<string, ShareGrant>()
  /** Sealed blobs per grant (DPAPI output of the current secrets), so a persist never re-seals. */
  private readonly sealed = new Map<string, { inviteKey: string; password?: string }>()
  private loaded = false

  constructor(
    private readonly file: string,
    private readonly vault: VaultCrypto,
    private readonly now: () => number = Date.now,
    private readonly warn: (msg: string, err?: unknown) => void = (msg, err) => console.warn(`[share] ${msg}`, err ?? ''),
  ) {}

  /** DPAPI is there: grants persist and a password can be set. */
  get persisted(): boolean {
    return this.vault.available()
  }

  load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.vault.available()) return
    let raw: unknown
    try {
      if (!existsSync(this.file)) return
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      this.warn('share grants unreadable, starting empty', err)
      return
    }
    const file = fileSchema.safeParse(raw)
    if (!file.success) {
      this.warn('share grants file is malformed, starting empty')
      return
    }
    for (const item of file.data.grants) {
      if (this.grants.size >= SHARE_GRANTS_MAX) break
      const g = grantSchema.safeParse(item)
      if (!g.success || this.grants.has(g.data.id)) continue
      const inviteKey = this.open(g.data.inviteKey.data, 16)
      if (!inviteKey) {
        this.warn('a share grant cannot be decrypted on this PC, dropping it')
        continue
      }
      let password: ShareGrant['password']
      const pw = g.data.password
      if (pw) {
        const salt = fromB64u(pw.salt, 16)
        const key = this.open(pw.key.data, SHARE_SCRYPT.keyLen)
        if (salt && key && pw.N === SHARE_SCRYPT.N && pw.r === SHARE_SCRYPT.r && pw.p === SHARE_SCRYPT.p) password = { salt, key }
        else this.warn('a share password cannot be decrypted on this PC, dropping it')
      }
      const grant: ShareGrant = {
        id: g.data.id,
        shareId: g.data.shareId,
        label: shareText(g.data.label, SHARE_LIMITS.labelMax),
        scope: g.data.scope,
        perm: g.data.perm,
        inviteKey,
        ...(password ? { password } : {}),
        createdAt: g.data.createdAt,
        ...(g.data.expiresAt !== undefined ? { expiresAt: g.data.expiresAt } : {}),
        paused: g.data.paused === true,
        knownGuests: g.data.knownGuests ?? [],
      }
      this.grants.set(grant.id, grant)
      this.sealed.set(grant.id, { inviteKey: g.data.inviteKey.data, ...(password && pw ? { password: pw.key.data } : {}) })
    }
  }

  list(): ShareGrant[] {
    return [...this.grants.values()]
  }

  get(id: string): ShareGrant | undefined {
    return this.grants.get(id)
  }

  byShareId(shareId: string): ShareGrant | undefined {
    for (const g of this.grants.values()) if (g.shareId === shareId) return g
    return undefined
  }

  /** A new grant (and persisted), or null past SHARE_GRANTS_MAX. */
  create(input: NewShareGrant): ShareGrant | null {
    if (this.grants.size >= SHARE_GRANTS_MAX) return null
    const grant: ShareGrant = {
      id: randomBytes(9).toString('base64url'),
      shareId: randomBytes(16).toString('base64url'),
      label: shareText(input.label, SHARE_LIMITS.labelMax),
      scope: input.scope,
      perm: input.perm,
      inviteKey: randomBytes(16),
      createdAt: this.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      paused: false,
      knownGuests: [],
    }
    this.grants.set(grant.id, grant)
    this.persist()
    return grant
  }

  /** A new invite key: invites made before stop working (live sessions are the caller's). */
  rotate(id: string): ShareGrant | null {
    const g = this.grants.get(id)
    if (!g) return null
    g.inviteKey = randomBytes(16)
    this.sealed.delete(id)
    this.persist()
    return g
  }

  update(id: string, patch: { perm?: SharePerm; label?: string; expiresAt?: number | null; paused?: boolean; scope?: ShareGrantScope }): ShareGrant | null {
    const g = this.grants.get(id)
    if (!g) return null
    if (patch.perm) g.perm = patch.perm
    if (patch.label !== undefined) g.label = shareText(patch.label, SHARE_LIMITS.labelMax)
    if (patch.expiresAt === null) delete g.expiresAt
    else if (patch.expiresAt !== undefined) g.expiresAt = patch.expiresAt
    if (patch.paused !== undefined) g.paused = patch.paused
    if (patch.scope) g.scope = patch.scope
    this.persist()
    return g
  }

  /**
   * Set (the scrypt key and its salt) or clear the unattended password. Only
   * with DPAPI: the key is password-equivalent and is never written in clear.
   */
  setPassword(id: string, password: { salt: Buffer; key: Buffer } | null): 'ok' | 'not_found' | 'encryption_unavailable' {
    const g = this.grants.get(id)
    if (!g) return 'not_found'
    if (password && !this.vault.available()) return 'encryption_unavailable'
    if (password) g.password = { salt: Buffer.from(password.salt), key: Buffer.from(password.key) }
    else delete g.password
    const s = this.sealed.get(id)
    if (s) delete s.password
    this.persist()
    return 'ok'
  }

  /** Revoke step 1: gone from memory, so no in-flight socket can use it; the caller kills sessions, then persist(). */
  deleteInMemory(id: string): boolean {
    this.sealed.delete(id)
    return this.grants.delete(id)
  }

  /** Remember a guest that joined (by key), newest first, at most 20. */
  noteGuest(id: string, key: string, name: string): void {
    const g = this.grants.get(id)
    if (!g) return
    const rest = g.knownGuests.filter((k) => k.key !== key)
    g.knownGuests = [{ key, name: shareText(name, SHARE_LIMITS.guestNameMax), lastAt: this.now() }, ...rest].slice(0, SHARE_KNOWN_GUESTS_MAX)
    this.persist()
  }

  isKnown(id: string, key: string): boolean {
    return this.grants.get(id)?.knownGuests.some((k) => k.key === key) ?? false
  }

  /** Write the current state (no-op without DPAPI: nothing is ever written in clear). */
  persist(): boolean {
    if (!this.vault.available()) return false
    let doc: unknown
    try {
      doc = { version: 1, grants: this.list().map((g) => this.serialize(g)) }
    } catch (err) {
      this.warn('share grants cannot be encrypted, keeping them in memory', err)
      return false
    }
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
      return true
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // nothing left to clean
      }
      this.warn('share grants cannot be saved', err)
      return false
    }
  }

  private serialize(g: ShareGrant): unknown {
    let s = this.sealed.get(g.id)
    if (!s) {
      s = { inviteKey: this.seal(g.inviteKey) }
      this.sealed.set(g.id, s)
    }
    if (g.password && !s.password) s.password = this.seal(g.password.key)
    return {
      id: g.id,
      shareId: g.shareId,
      label: g.label,
      scope: g.scope,
      perm: g.perm,
      inviteKey: { enc: 'dpapi', data: s.inviteKey },
      ...(g.password && s.password
        ? { password: { salt: toB64u(g.password.salt), N: SHARE_SCRYPT.N, r: SHARE_SCRYPT.r, p: SHARE_SCRYPT.p, key: { enc: 'dpapi', data: s.password } } }
        : {}),
      createdAt: g.createdAt,
      ...(g.expiresAt !== undefined ? { expiresAt: g.expiresAt } : {}),
      ...(g.paused ? { paused: true } : {}),
      ...(g.knownGuests.length ? { knownGuests: g.knownGuests } : {}),
    }
  }

  private seal(secret: Buffer): string {
    return this.vault.encrypt(secret.toString('base64')).toString('base64')
  }

  private open(data: string, bytes: number): Buffer | null {
    try {
      const out = Buffer.from(this.vault.decrypt(Buffer.from(data, 'base64')), 'base64')
      return out.length === bytes ? out : null
    } catch {
      return null
    }
  }
}
