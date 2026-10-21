/**
 * The shares this PC joined as a guest (app 2.4.0, item 8, stage S2).
 *
 * File: `dataDir()/share-links.json`, main-owned, never in config:
 *   { version: 1, links: [{ id, hostLabel, hostKey, shareId, inviteKey: Sealed,
 *     endpoints, scope, permHint, expiresAt?, addedAt, lastConnectedAt?,
 *     lastEndpoint?, pw?: { salt, key: Sealed } }] }
 *   Sealed = { enc: 'dpapi', data: base64 of the DPAPI blob }
 * The invite key and the remembered password key (the scrypt output, never
 * the password) are only ever written sealed by DPAPI. Without encryption the
 * links live in memory for this run only and the file is never touched (the
 * UI says they are forgotten on quit). A link whose invite key DPAPI cannot
 * open (a portable moved to another user or PC) is dropped; a password key it
 * cannot open is forgotten.
 *
 * The guest's own static key is not here: it is the `guest` role of
 * share-identity.json (identity.ts), one instance shared with the host side.
 *
 * Writes are synchronous temp + rename (UTF-8, no BOM), so two persists never
 * land out of order.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod'
import { SHARE_LIMITS, shareText, type SharePerm, type ShareScopeKind } from '@shared/share-protocol'
import { SHARE_LINKS_MAX } from '@shared/share-guest'
import { dataDir } from '../../paths'
import type { VaultCrypto } from '../../accounts/safeCrypto'
import { fromB64u, randomB64u } from '../crypto'
import { shareIpClass, type ShareEndpointKind, type ShareInvite, type ShareInviteEndpoint } from '../invite'

export interface LinkRecord {
  id: string
  hostLabel: string
  /** The pinned host static key (base64url, 32 bytes). */
  hostKey: string
  /** The invite's share id (`hello.sid`). */
  shareId: string
  endpoints: ShareInviteEndpoint[]
  scope: { kind: ShareScopeKind; label: string }
  permHint: SharePerm
  expiresAt?: number
  addedAt: number
  lastConnectedAt?: number
  /** `a:p` of the endpoint that last reached the host (dialed first). */
  lastEndpoint?: string
}

export interface LinkPassword {
  salt: Buffer
  key: Buffer
}

const sealedSchema = z.object({ enc: z.literal('dpapi'), data: z.string().min(1).max(8192) }).strict()
type Sealed = z.infer<typeof sealedSchema>

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/
const label = (max: number) => z.string().max(max).refine((s) => !CONTROL_RE.test(s), 'label')

const endpointSchema = z
  .object({ a: z.string().max(15), p: z.number().int().min(1024).max(65535), t: z.enum(['ts', 'lan', 'loop']) })
  .strict()
  .refine((ep) => shareIpClass(ep.a) === ep.t, 'endpoint')

const linkSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    hostLabel: label(SHARE_LIMITS.hostLabelMax),
    hostKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    shareId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    inviteKey: sealedSchema,
    endpoints: z.array(endpointSchema).min(1).max(6),
    scope: z.object({ kind: z.enum(['pane', 'workspace']), label: label(SHARE_LIMITS.labelMax) }).strict(),
    permHint: z.enum(['view', 'type', 'full']),
    expiresAt: z.number().int().min(0).max(8.64e15).optional(),
    addedAt: z.number().int().min(0).max(8.64e15),
    lastConnectedAt: z.number().int().min(0).max(8.64e15).optional(),
    lastEndpoint: z.string().max(32).optional(),
    pw: z.object({ salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/), key: sealedSchema }).strict().optional(),
  })
  .strict()
type StoredLink = z.infer<typeof linkSchema>

const fileSchema = z.object({ version: z.literal(1), links: z.array(z.unknown()).max(SHARE_LINKS_MAX * 2) })

export function shareLinksPath(): string {
  return join(dataDir(), 'share-links.json')
}

export type UpsertResult = { ok: true; link: LinkRecord; created: boolean } | { ok: false; error: 'limit' }

export class LinkStore {
  private loaded = false
  private readonly links = new Map<string, LinkRecord>()
  private readonly inviteKeys = new Map<string, Buffer>()
  private readonly passwords = new Map<string, LinkPassword>()

  constructor(
    private readonly file: string,
    private readonly vault: VaultCrypto,
    private readonly now: () => number = Date.now,
    private readonly warn: (msg: string, err?: unknown) => void = (msg, err) => console.warn(`[share] ${msg}`, err ?? ''),
  ) {}

  /** False = no encryption: links and password keys stay in memory for this run. */
  get persisted(): boolean {
    return this.vault.available()
  }

  list(): LinkRecord[] {
    this.load()
    return [...this.links.values()].map((l) => ({ ...l, endpoints: l.endpoints.map((e) => ({ ...e })), scope: { ...l.scope } }))
  }

  get(id: string): LinkRecord | null {
    this.load()
    const l = this.links.get(id)
    return l ? { ...l, endpoints: l.endpoints.map((e) => ({ ...e })), scope: { ...l.scope } } : null
  }

  /** The link that already holds this host key and share id (a re-pasted or rotated invite). */
  findByShare(hostKey: string, shareId: string): LinkRecord | null {
    this.load()
    for (const l of this.links.values()) if (l.hostKey === hostKey && l.shareId === shareId) return this.get(l.id)
    return null
  }

  inviteKey(id: string): Buffer | null {
    this.load()
    const k = this.inviteKeys.get(id)
    return k ? Buffer.from(k) : null
  }

  password(id: string): LinkPassword | null {
    this.load()
    const p = this.passwords.get(id)
    return p ? { salt: Buffer.from(p.salt), key: Buffer.from(p.key) } : null
  }

  /**
   * A parsed invite becomes a link, or refreshes the one of the same host key
   * and share id (new invite key after a rotate, new endpoints, labels). The
   * id, the remembered password and the history are kept.
   */
  upsertFromInvite(invite: ShareInvite): UpsertResult {
    this.load()
    const inviteKey = fromB64u(invite.k, 16)
    if (!inviteKey) throw new Error('invite key')
    const existing = this.findByShare(invite.pk, invite.s)
    if (!existing && this.links.size >= SHARE_LINKS_MAX) return { ok: false, error: 'limit' }
    const base: LinkRecord = existing ?? {
      id: randomB64u(16),
      hostLabel: '',
      hostKey: invite.pk,
      shareId: invite.s,
      endpoints: [],
      scope: { kind: invite.sc.k, label: '' },
      permHint: invite.pm,
      addedAt: this.now(),
    }
    const next: LinkRecord = {
      ...base,
      hostLabel: shareText(invite.h, SHARE_LIMITS.hostLabelMax),
      endpoints: invite.e.map((e) => ({ a: e.a, p: e.p, t: e.t as ShareEndpointKind })),
      scope: { kind: invite.sc.k, label: shareText(invite.sc.l, SHARE_LIMITS.labelMax) },
      permHint: invite.pm,
    }
    if (invite.x !== undefined) next.expiresAt = invite.x
    else delete next.expiresAt
    if (next.lastEndpoint && !next.endpoints.some((e) => `${e.a}:${e.p}` === next.lastEndpoint)) delete next.lastEndpoint
    this.links.set(next.id, next)
    this.inviteKeys.set(next.id, inviteKey)
    this.persist()
    return { ok: true, link: this.get(next.id)!, created: !existing }
  }

  /** A successful welcome: when and through which endpoint. */
  markConnected(id: string, endpoint: string): void {
    this.load()
    const l = this.links.get(id)
    if (!l) return
    l.lastConnectedAt = this.now()
    if (l.endpoints.some((e) => `${e.a}:${e.p}` === endpoint)) l.lastEndpoint = endpoint
    this.persist()
  }

  /** Remember (or forget, with null) the derived password key of a link. */
  setPassword(id: string, pw: LinkPassword | null): void {
    this.load()
    if (!this.links.has(id)) return
    if (pw) this.passwords.set(id, { salt: Buffer.from(pw.salt), key: Buffer.from(pw.key) })
    else if (!this.passwords.delete(id)) return
    this.persist()
  }

  remove(id: string): boolean {
    this.load()
    if (!this.links.delete(id)) return false
    this.inviteKeys.delete(id)
    this.passwords.delete(id)
    this.persist()
    return true
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.vault.available()) return
    let raw: unknown
    try {
      if (!existsSync(this.file)) return
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      this.warn('share links file unreadable, ignoring it', err)
      return
    }
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) {
      this.warn('share links file is malformed, ignoring it')
      return
    }
    for (const item of parsed.data.links) {
      if (this.links.size >= SHARE_LINKS_MAX) break
      const entry = linkSchema.safeParse(item)
      if (!entry.success || this.links.has(entry.data.id)) continue
      const inviteKey = this.open(entry.data.inviteKey, 16)
      if (!inviteKey) {
        this.warn('a share link cannot be decrypted, dropping it')
        continue
      }
      const { inviteKey: _k, pw, ...rest } = entry.data
      void _k
      this.links.set(rest.id, rest)
      this.inviteKeys.set(rest.id, inviteKey)
      if (pw) {
        const salt = fromB64u(pw.salt, 16)
        const key = this.open(pw.key, 32)
        if (salt && key) this.passwords.set(rest.id, { salt, key })
      }
    }
  }

  private open(sealed: Sealed, bytes: number): Buffer | null {
    try {
      const buf = Buffer.from(this.vault.decrypt(Buffer.from(sealed.data, 'base64')), 'base64')
      return buf.length === bytes ? buf : null
    } catch {
      return null
    }
  }

  private seal(buf: Buffer): Sealed {
    return { enc: 'dpapi', data: this.vault.encrypt(buf.toString('base64')).toString('base64') }
  }

  private persist(): void {
    if (!this.vault.available()) return
    let links: StoredLink[]
    try {
      links = [...this.links.values()].map((l) => {
        const pw = this.passwords.get(l.id)
        const stored: StoredLink = { ...l, inviteKey: this.seal(this.inviteKeys.get(l.id)!) }
        if (pw) stored.pw = { salt: pw.salt.toString('base64url'), key: this.seal(pw.key) }
        return stored
      })
    } catch (err) {
      this.warn('share links cannot be encrypted, keeping them in memory', err)
      return
    }
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, links }, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // nothing left to clean
      }
      this.warn('share links cannot be saved', err)
    }
  }
}
