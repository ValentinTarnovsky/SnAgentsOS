/**
 * Pairing: turning a QR scan into a trusted device. One short code is active at
 * a time (only while the QR modal is open), single-use, ~40 bits of entropy,
 * TTL 120s. A valid scan raises exactly one pending approval that the desktop
 * user must Allow/Deny within 60s; approval mints the device + secret.
 *
 * The shared RateLimiter (used by both pairing and auth) lives here so a
 * failing IP is slowed identically whichever door it knocks on.
 */
import { createHash, randomInt, randomUUID } from 'crypto'
import QRCode from 'qrcode'
import type { PairingQrPayload, PendingPairingInfo } from '@shared/ipc-contract'
import type { DeviceRegistry } from './DeviceRegistry'
import { listEndpoints } from './network'

/** No 0/O/1/I: unambiguous when typed by hand from the QR modal. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const CODE_TTL_MS = 120 * 1000
const PENDING_TTL_MS = 60 * 1000
const MAX_DEVICES = 10

// --- Rate limiter (shared with auth) ---------------------------------------

const FAIL_WINDOW_MS = 10 * 60 * 1000
const FAIL_THRESHOLD = 5
const LOCKOUT_BASE_MS = 30 * 1000
const LOCKOUT_MAX_MS = 5 * 60 * 1000

interface IpState {
  fails: number[]
  lockoutUntil: number
  /** Next lockout duration (doubles each lockout, capped). */
  lockoutMs: number
}

/**
 * Per-IP failure tracker shared by pairing and auth. Five failures inside ten
 * minutes trips a lockout starting at 30s and doubling (to a 5min cap) on each
 * repeat, so a brute-forcer is answered without any crypto work while locked.
 */
export class RateLimiter {
  private readonly byIp = new Map<string, IpState>()

  isLocked(ip: string): boolean {
    const s = this.byIp.get(ip)
    return s ? Date.now() < s.lockoutUntil : false
  }

  retryAfterMs(ip: string): number {
    const s = this.byIp.get(ip)
    return s ? Math.max(0, s.lockoutUntil - Date.now()) : 0
  }

  recordFailure(ip: string): void {
    const now = Date.now()
    const s = this.byIp.get(ip) ?? { fails: [], lockoutUntil: 0, lockoutMs: LOCKOUT_BASE_MS }
    s.fails = s.fails.filter((t) => now - t < FAIL_WINDOW_MS)
    s.fails.push(now)
    if (s.fails.length >= FAIL_THRESHOLD) {
      s.lockoutUntil = now + s.lockoutMs
      s.lockoutMs = Math.min(s.lockoutMs * 2, LOCKOUT_MAX_MS)
      s.fails = []
    }
    this.byIp.set(ip, s)
  }

  /** A success clears the slate for that IP. */
  clear(ip: string): void {
    this.byIp.delete(ip)
  }
}

// --- Pairing ----------------------------------------------------------------

interface ActiveCode {
  code: string
  used: boolean
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

interface PendingReq extends PendingPairingInfo {
  timer: ReturnType<typeof setTimeout>
}

export type PairSubmitResult =
  | { status: 'pending'; info: PendingPairingInfo }
  | { status: 'denied'; reason: 'badCode' | 'limit' | 'expired' }

export type PairResolveResult =
  | { kind: 'paired'; deviceId: string; secret: string }
  | { kind: 'denied'; reason: 'denied' }

export interface PairingDeps {
  registry: DeviceRegistry
  /** Fired when the active code or pending request changes (coalesced UI push). */
  onChange: () => void
  /** The 60s pending approval elapsed: deliver pairDenied{expired} to its socket. */
  onPendingExpired: (requestId: string) => void
}

/**
 * Strip characters that could spoof the desktop approval prompt, then trim and
 * cap at 48. Removed: C0 controls + DEL, and bidi marks (LRM/RLM/ALM, the
 * embedding/override/PDF set, and the isolates) which can visually reorder the
 * name shown to the approving user. Unicode letters and emoji are kept.
 */
function sanitizeDeviceName(name: string): string {
  let out = ''
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20 || c === 0x7f) continue
    if (c === 0x200e || c === 0x200f || c === 0x061c) continue
    if (c >= 0x202a && c <= 0x202e) continue
    if (c >= 0x2066 && c <= 0x2069) continue
    out += ch
  }
  return out.trim().slice(0, 48) || 'Phone'
}

/** Constant-time string compare via SHA-256 (equal-length digests). */
function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest('hex')
  const bh = createHash('sha256').update(b).digest('hex')
  // Comparing two fixed-length hex digests leaks no length information.
  let diff = 0
  for (let i = 0; i < ah.length; i++) diff |= ah.charCodeAt(i) ^ bh.charCodeAt(i)
  return diff === 0
}

export class PairingService {
  private active: ActiveCode | null = null
  private pending: PendingReq | null = null

  constructor(private readonly deps: PairingDeps) {}

  /** Mint a fresh code + one QR per reachable endpoint. Re-enumerates NICs. */
  async begin(port: number): Promise<PairingQrPayload> {
    this.clearCode()
    const code = this.mintCode()
    const expiresAt = Date.now() + CODE_TTL_MS
    this.active = {
      code,
      used: false,
      expiresAt,
      timer: setTimeout(() => this.clearCode(true), CODE_TTL_MS),
    }
    const endpoints = await Promise.all(
      listEndpoints(port).map(async (ep) => ({
        ip: ep.ip,
        kind: ep.kind,
        url: ep.url,
        qrDataUrl: await QRCode.toDataURL(`${ep.url}/#pair=${code}`, { margin: 1, width: 512 }),
      })),
    )
    this.deps.onChange()
    return { code, expiresAt, endpoints }
  }

  /** QR modal closed: invalidate the active code (pairing only works while open). */
  cancelCode(): void {
    this.clearCode(true)
  }

  activeCodeExpiresAt(): number | null {
    return this.active ? this.active.expiresAt : null
  }

  pendingInfo(): PendingPairingInfo | null {
    if (!this.pending) return null
    const { requestId, deviceName, ip, expiresAt } = this.pending
    return { requestId, deviceName, ip, expiresAt }
  }

  /**
   * A phone submitted a code. Validates it against the single active code and
   * the device cap, then raises one pending approval. Never does slow work for
   * a wrong code beyond a single hash compare.
   */
  submitPair(code: string, deviceName: string, ip: string): PairSubmitResult {
    const now = Date.now()
    if (!this.active || this.active.used || now > this.active.expiresAt) {
      return { status: 'denied', reason: 'badCode' }
    }
    if (!constantTimeEqual(code, this.active.code)) {
      return { status: 'denied', reason: 'badCode' }
    }
    if (this.deps.registry.count >= MAX_DEVICES) {
      return { status: 'denied', reason: 'limit' }
    }
    // MAX_PENDING = 1 (also implied by single-use code, but guard explicitly).
    if (this.pending) {
      return { status: 'denied', reason: 'limit' }
    }
    this.active.used = true
    const requestId = randomUUID()
    const info: PendingPairingInfo = {
      requestId,
      deviceName: sanitizeDeviceName(deviceName),
      ip,
      expiresAt: now + PENDING_TTL_MS,
    }
    this.pending = {
      ...info,
      timer: setTimeout(() => this.expirePending(requestId), PENDING_TTL_MS),
    }
    this.deps.onChange()
    return { status: 'pending', info }
  }

  /** The desktop user answered Allow/Deny. Returns null if the request is stale. */
  resolve(requestId: string, allow: boolean): PairResolveResult | null {
    if (!this.pending || this.pending.requestId !== requestId) return null
    const pend = this.pending
    clearTimeout(pend.timer)
    this.pending = null
    this.clearCode()
    let result: PairResolveResult
    if (allow && this.deps.registry.count < MAX_DEVICES) {
      const device = this.deps.registry.add(pend.deviceName)
      result = { kind: 'paired', deviceId: device.id, secret: device.secret }
    } else {
      result = { kind: 'denied', reason: 'denied' }
    }
    this.deps.onChange()
    return result
  }

  /** Drop a pending request whose socket went away before the user answered. */
  cancelPending(requestId: string): void {
    if (!this.pending || this.pending.requestId !== requestId) return
    clearTimeout(this.pending.timer)
    this.pending = null
    this.deps.onChange()
  }

  /** Release timers on server shutdown. */
  dispose(): void {
    this.clearCode()
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending = null
    }
  }

  private expirePending(requestId: string): void {
    if (!this.pending || this.pending.requestId !== requestId) return
    this.pending = null
    this.clearCode()
    this.deps.onChange()
    this.deps.onPendingExpired(requestId)
  }

  private clearCode(notify = false): void {
    if (this.active) {
      clearTimeout(this.active.timer)
      this.active = null
      if (notify) this.deps.onChange()
    }
  }

  private mintCode(): string {
    let s = ''
    for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    return s
  }
}
