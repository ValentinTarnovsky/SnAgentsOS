/**
 * Share invite string (app 2.4.0, item 8): `snaos-share:1:` + base64url of
 *   { v: 1, h: hostLabel, pk: host X25519 key, s: shareId, k: inviteKey,
 *     e: [{ a: IPv4, p: port, t: 'ts' | 'lan' | 'loop' }] (1..6),
 *     sc: { k: 'pane' | 'workspace', l: label }, pm: perm, x?: expiresAt }
 * The invite is the right to knock: `k` proves it (HMAC over the channel),
 * `pk` pins the host key. Scope, perm, label and expiry are display-only, the
 * host is authoritative.
 *
 * The guest parses it strictly (unknown keys, non-canonical base64url, bad
 * lengths all fail) and only ever dials IPv4 literals that are private
 * (RFC 1918), tailnet (100.64.0.0/10) or, with `SNAOS_SHARE_LOOPBACK=1`
 * (dev and E2E only), loopback, on ports 1024..65535: an invite can never
 * point the guest at a public host or a name to resolve. Leading zeros are
 * refused (`010.0.0.1` would be octal to a URL parser).
 */
import { z } from 'zod'
import { SHARE_INVITE_PREFIX, SHARE_LIMITS, shareText } from '@shared/share-protocol'
import type { SharePerm, ShareScopeKind } from '@shared/share-protocol'
import type { RemoteEndpointKind } from '@shared/remote-protocol'

export type ShareEndpointKind = 'ts' | 'lan' | 'loop'

export interface ShareInviteEndpoint {
  a: string
  p: number
  t: ShareEndpointKind
}

export interface ShareInvite {
  v: 1
  h: string
  pk: string
  s: string
  k: string
  e: ShareInviteEndpoint[]
  sc: { k: ShareScopeKind; l: string }
  pm: SharePerm
  x?: number
}

export type ShareInviteError = 'format' | 'version' | 'too_long' | 'bad_key' | 'endpoint' | 'self'

export const SHARE_INVITE_MAX = 2048
export const SHARE_INVITE_ENDPOINTS_MAX = 6

/** `SNAOS_SHARE_LOOPBACK=1`: invites may list (and guests may dial) 127.0.0.1. Dev and E2E only. */
export function shareLoopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SNAOS_SHARE_LOOPBACK === '1'
}

/** The address class of a canonical dotted IPv4 literal, or null (public, malformed, leading zeros). */
export function shareIpClass(ip: string): ShareEndpointKind | null {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(ip)
  if (!m) return null
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (o.some((n) => n > 255)) return null
  if (o[0] === 127) return 'loop'
  if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)) return 'lan'
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'ts'
  return null
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/
const label = (max: number) => z.string().max(max).refine((s) => !CONTROL_RE.test(s), 'label')

const inviteSchema = z
  .object({
    v: z.literal(1),
    h: label(SHARE_LIMITS.hostLabelMax),
    pk: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    s: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    k: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    e: z
      .array(z.object({ a: z.string().max(15), p: z.number().int().min(1024).max(65535), t: z.enum(['ts', 'lan', 'loop']) }).strict())
      .min(1)
      .max(SHARE_INVITE_ENDPOINTS_MAX),
    sc: z.object({ k: z.enum(['pane', 'workspace']), l: label(SHARE_LIMITS.labelMax) }).strict(),
    pm: z.enum(['view', 'type', 'full']),
    x: z.number().int().min(0).max(8.64e15).optional(),
  })
  .strict()

function canonicalB64u(text: string, bytes: number): boolean {
  const buf = Buffer.from(text, 'base64url')
  return buf.length === bytes && buf.toString('base64url') === text
}

function endpointOk(ep: ShareInviteEndpoint, allowLoopback: boolean): boolean {
  const cls = shareIpClass(ep.a)
  if (!cls || cls !== ep.t) return false
  return cls !== 'loop' || allowLoopback
}

export interface ParseInviteOpts {
  /** Default: `shareLoopbackAllowed()`. */
  allowLoopback?: boolean
  /** This PC's own public keys (base64url): an invite to ourselves is `self`. */
  ownKeys?: readonly string[]
}

export type ParseInviteResult = { ok: true; invite: ShareInvite } | { ok: false; error: ShareInviteError }

/** Strict guest-side parse of a pasted invite (surrounding whitespace is ignored). */
export function parseShareInvite(input: unknown, opts: ParseInviteOpts = {}): ParseInviteResult {
  if (typeof input !== 'string') return { ok: false, error: 'format' }
  const text = input.trim()
  if (text.length > SHARE_INVITE_MAX) return { ok: false, error: 'too_long' }
  const m = /^snaos-share:(\d{1,3}):([A-Za-z0-9_-]+)$/.exec(text)
  if (!m) return { ok: false, error: 'format' }
  if (m[1] !== '1') return { ok: false, error: 'version' }
  let obj: unknown
  try {
    const json = Buffer.from(m[2], 'base64url').toString('utf8')
    if (Buffer.from(json, 'utf8').toString('base64url') !== m[2]) return { ok: false, error: 'format' }
    obj = JSON.parse(json)
  } catch {
    return { ok: false, error: 'format' }
  }
  if (obj && typeof obj === 'object' && 'v' in obj && (obj as { v: unknown }).v !== 1) return { ok: false, error: 'version' }
  const parsed = inviteSchema.safeParse(obj)
  if (!parsed.success) {
    const keyIssue = parsed.error.issues.some((i) => i.path[0] === 'pk' || i.path[0] === 'k' || i.path[0] === 's')
    const epIssue = parsed.error.issues.some((i) => i.path[0] === 'e')
    return { ok: false, error: keyIssue ? 'bad_key' : epIssue ? 'endpoint' : 'format' }
  }
  const invite = parsed.data as ShareInvite
  if (!canonicalB64u(invite.pk, 32) || !canonicalB64u(invite.k, 16) || !canonicalB64u(invite.s, 16)) return { ok: false, error: 'bad_key' }
  if (Buffer.from(invite.pk, 'base64url').every((b) => b === 0)) return { ok: false, error: 'bad_key' }
  const allowLoopback = opts.allowLoopback ?? shareLoopbackAllowed()
  if (!invite.e.every((ep) => endpointOk(ep, allowLoopback))) return { ok: false, error: 'endpoint' }
  if (opts.ownKeys?.includes(invite.pk)) return { ok: false, error: 'self' }
  return { ok: true, invite }
}

/** Host side: the invite string; throws when a field is out of bounds (a host bug, never user input). */
export function encodeShareInvite(invite: ShareInvite, opts: { allowLoopback?: boolean } = {}): string {
  const clean: ShareInvite = {
    ...invite,
    h: shareText(invite.h, SHARE_LIMITS.hostLabelMax),
    sc: { k: invite.sc.k, l: shareText(invite.sc.l, SHARE_LIMITS.labelMax) },
  }
  const parsed = inviteSchema.safeParse(clean)
  if (!parsed.success) throw new Error('invalid share invite')
  const allowLoopback = opts.allowLoopback ?? shareLoopbackAllowed()
  if (!clean.e.every((ep) => endpointOk(ep, allowLoopback))) throw new Error('invalid share invite endpoint')
  const text = SHARE_INVITE_PREFIX + Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url')
  if (text.length > SHARE_INVITE_MAX) throw new Error('share invite too long')
  return text
}

/**
 * The endpoints an invite lists, from `listEndpoints(sharePort)`: Tailscale
 * first, then LAN, never virtual adapters nor 'other', at most 6; loopback
 * first when allowed (dev and E2E).
 */
export function inviteEndpoints(
  list: ReadonlyArray<{ ip?: string; kind: RemoteEndpointKind; virtual?: boolean }>,
  port: number,
  allowLoopback: boolean = shareLoopbackAllowed(),
): ShareInviteEndpoint[] {
  const out: ShareInviteEndpoint[] = []
  const seen = new Set<string>()
  const add = (a: string, t: ShareEndpointKind): void => {
    if (seen.has(a) || out.length >= SHARE_INVITE_ENDPOINTS_MAX || shareIpClass(a) !== t) return
    seen.add(a)
    out.push({ a, p: port, t })
  }
  if (allowLoopback) add('127.0.0.1', 'loop')
  for (const kind of ['tailscale', 'lan'] as const) {
    for (const ep of list) if (ep.kind === kind && ep.ip && !ep.virtual) add(ep.ip, kind === 'tailscale' ? 'ts' : 'lan')
  }
  return out
}
