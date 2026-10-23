/**
 * Connections of the Share host (app 2.4.0, item 8): the handshake, who gets
 * in, and the lifecycle of each guest session. What an admitted session may
 * do (scope, streams, input, ctl) is ShareHost's.
 *
 * Per connection: cleartext `hs1` -> SecureChannel (crypto.ts; the guest is
 * known by its static key from then on), then the first sealed record must
 * be `hello { sid, guestName, app, proof, ticket?, pw? }`. The host checks,
 * in order (AnyDesk model):
 *  1. the address is not locked out (5 failures in 10 min: 30 s doubling to
 *     5 min) -> else `denied{locked}`, 4429;
 *  2. the grant exists and the invite proof (HMAC over the channel) matches,
 *     in constant time -> else a failure, 4401;
 *  3. the grant has not expired (4410) and its scope is there (4411);
 *  4. a reconnect ticket for (grant, guest key) -> admitted at the perm and
 *     rights the ticket holds (those of the last session: an approval as view
 *     comes back as view);
 *  5. the grant's password proof -> admitted at the grant perm and rights (a
 *     wrong one is a failure and the prompt shows "wrong password tried");
 *  6. otherwise an approval request: at most 1 pending per address and 3 per
 *     host, 60 s; Deny and the timeout count as failures, and a Deny starts a
 *     15 s cooldown for that address. While pending the guest may still send
 *     `password{proof}`.
 * Limits: 4 unauthenticated sockets per address, 10 s to say hello, 8
 * sessions per grant and 16 in total, 60 s of silence closes, 3 malformed
 * frames close (4400; a record that fails to open closes at once).
 *
 * Tickets live in memory only (a host restart clears them): one per (grant,
 * guest key), valid while a session of that pair is open and for 15 min
 * after the last one closes. A kick or a revoke drops it.
 *
 * Each session keeps the protocol version its handshake negotiated
 * (`version`): ShareHost sends v2 fields and messages only to a v2 session.
 */
import { randomBytes } from 'crypto'
import {
  SHARE_APPROVAL_TTL_MS,
  SHARE_CLOSE,
  SHARE_LIMITS,
  SHARE_TICKET_TTL_MS,
  shareText,
  type ShareClientMsg,
  type ShareEndReason,
  type ShareHostMsg,
  type ShareHostPlatform,
  type ShareScopeKind,
  type ShareState,
} from '@shared/share-protocol'
import { parseShareClientMsg } from '@shared/share-protocol-schemas'
import { SHARE_RIGHTS_NONE, normalizeShareRights } from '@shared/shareRights'
import type { ShareHostApproval } from '@shared/ipc-contract'
import type { SharePerm, ShareRights } from '@shared/types'
import { sanitizeDeviceName } from '../remote/PairingService'
import { hostHandshake, keyFingerprint, randomB64u, sameToken, toB64u, verifyShareProof, type SecureChannel, type ShareKeyPair } from './crypto'
import type { ShareGrant } from './GrantStore'
import type { ShareFrame, ShareTransport } from './transport'
import { realShareClock, type ShareClock, type ShareTimer } from './clock'

export const SHARE_HANDSHAKE_TIMEOUT_MS = 10_000
export const SHARE_MAX_UNAUTHED_PER_IP = 4
export const SHARE_SESSIONS_PER_GRANT = 8
export const SHARE_SESSIONS_MAX = 16
export const SHARE_PENDING_MAX = 3
export const SHARE_KEEPALIVE_SILENCE_MS = 60_000
export const SHARE_BAD_MSG_LIMIT = 3
export const SHARE_DENY_COOLDOWN_MS = 15_000
export const SHARE_FAIL_THRESHOLD = 5
export const SHARE_FAIL_WINDOW_MS = 10 * 60_000
export const SHARE_LOCKOUT_BASE_MS = 30_000
export const SHARE_LOCKOUT_MAX_MS = 5 * 60_000

const END_CODES: Record<ShareEndReason, number> = {
  revoked: SHARE_CLOSE.DENIED,
  kicked: SHARE_CLOSE.KICKED,
  expired: SHARE_CLOSE.EXPIRED,
  scope_gone: SHARE_CLOSE.SCOPE_GONE,
  host_quit: SHARE_CLOSE.GOING_AWAY,
  sharing_off: SHARE_CLOSE.GOING_AWAY,
}

export type ShareSessionPhase = 'handshake' | 'hello' | 'pending' | 'admitted' | 'closed'

export interface HostSession {
  readonly id: string
  readonly transport: ShareTransport
  readonly ip: string
  phase: ShareSessionPhase
  channel: SecureChannel | null
  /** The guest static key (base64url), '' before the handshake. */
  guestKey: string
  fingerprint: string
  grantId: string
  guestName: string
  app: string
  perm: SharePerm
  /** What it may use beyond the terminal (app 2.6.0, shareRights.ts). */
  rights: ShareRights
  /** Negotiated SHARE_PROTOCOL_VERSION (1 before the handshake). */
  version: number
  since: number
  lastSeen: number
  strikes: number
  timer: ShareTimer | null
  requestId: string | null
  passwordFailed: boolean
  countedUnauthed: boolean
  // ShareHost's bookkeeping of an admitted session.
  pausedSent: boolean
  stateKey: string
  chatSubs: Set<string>
  gitPaths: Map<string, Set<string>>
  gitTimes: number[]
  gitInFlight: number
  notesTimes: number[]
  notesInFlight: number
  /** Note creates and deletes (their own, slower bucket). */
  notesOpTimes: number[]
  filesTimes: number[]
  filesInFlight: number
  /** The guest's Files drawer is open (`filesWatch`). */
  filesWatch: boolean
  ctlTimes: number[]
}

/** Per-address failure tracker with lockout (RateLimiter's rule, on the injectable clock). */
export class ShareFailures {
  private readonly byIp = new Map<string, { fails: number[]; lockoutUntil: number; lockoutMs: number; cooldownUntil: number }>()

  constructor(private readonly now: () => number) {}

  private entry(ip: string) {
    let s = this.byIp.get(ip)
    if (!s) {
      s = { fails: [], lockoutUntil: 0, lockoutMs: SHARE_LOCKOUT_BASE_MS, cooldownUntil: 0 }
      this.byIp.set(ip, s)
    }
    return s
  }

  locked(ip: string): boolean {
    const s = this.byIp.get(ip)
    return !!s && this.now() < s.lockoutUntil
  }

  coolingDown(ip: string): boolean {
    const s = this.byIp.get(ip)
    return !!s && this.now() < s.cooldownUntil
  }

  record(ip: string): void {
    const now = this.now()
    const s = this.entry(ip)
    s.fails = s.fails.filter((t) => now - t < SHARE_FAIL_WINDOW_MS)
    s.fails.push(now)
    if (s.fails.length >= SHARE_FAIL_THRESHOLD) {
      s.lockoutUntil = now + s.lockoutMs
      s.lockoutMs = Math.min(s.lockoutMs * 2, SHARE_LOCKOUT_MAX_MS)
      s.fails = []
    }
  }

  cooldown(ip: string, ms: number): void {
    this.entry(ip).cooldownUntil = this.now() + ms
  }

  clear(ip: string): void {
    this.byIp.delete(ip)
  }
}

interface Approval {
  requestId: string
  session: HostSession
  grantId: string
  expiresAt: number
  known: boolean
}

interface Ticket {
  token: string
  perm: SharePerm
  rights: ShareRights
  live: number
  expiresAt: number
}

export interface HostSessionsDeps {
  grants: { byShareId(sid: string): ShareGrant | undefined; get(id: string): ShareGrant | undefined; noteGuest(id: string, key: string, name: string): void; isKnown(id: string, key: string): boolean }
  hostKey(): ShareKeyPair
  appVersion: string
  hostLabel(): string
  platform: ShareHostPlatform
  /** Localized "Guest" for an empty name. */
  guestFallback(): string
  /** Whether the grant can be joined right now. */
  grantGate(grant: ShareGrant): 'ok' | 'expired' | 'scope_gone'
  scopeOf(grant: ShareGrant): { kind: ShareScopeKind; label: string }
  welcomeState(session: HostSession): ShareState
  onAdmitted(session: HostSession): void
  onMessage(session: HostSession, msg: ShareClientMsg): void
  onClosed(session: HostSession, wasAdmitted: boolean): void
  onApprovalsChanged(): void
  /** A new approval request (main shows a Notification when the window has no focus). */
  onApprovalRequest?(approval: ShareHostApproval): void
  clock?: ShareClock
  /** Highest protocol version offered (tests: 1 plays an app 2.5 host). */
  protocolMax?: number
}

const pairKey = (grantId: string, guestKey: string): string => `${grantId}|${guestKey}`

export class HostSessions {
  private readonly sessions = new Set<HostSession>()
  private readonly unauthed = new Map<string, number>()
  private readonly approvalsById = new Map<string, Approval>()
  private readonly tickets = new Map<string, Ticket>()
  readonly failures: ShareFailures
  private readonly clock: ShareClock

  constructor(private readonly deps: HostSessionsDeps) {
    this.clock = deps.clock ?? realShareClock
    this.failures = new ShareFailures(() => this.clock.now())
  }

  // --- Connections ----------------------------------------------------------------

  attach(transport: ShareTransport): HostSession | null {
    const ip = transport.remoteIp
    const n = this.unauthed.get(ip) ?? 0
    if (n >= SHARE_MAX_UNAUTHED_PER_IP) {
      transport.close(SHARE_CLOSE.LOCKED, 'busy')
      return null
    }
    this.unauthed.set(ip, n + 1)
    const now = this.clock.now()
    const session: HostSession = {
      id: randomB64u(12),
      transport,
      ip,
      phase: 'handshake',
      channel: null,
      guestKey: '',
      fingerprint: '',
      grantId: '',
      guestName: '',
      app: '',
      perm: 'view',
      rights: { ...SHARE_RIGHTS_NONE },
      version: 1,
      since: now,
      lastSeen: now,
      strikes: 0,
      timer: null,
      requestId: null,
      passwordFailed: false,
      countedUnauthed: true,
      pausedSent: false,
      stateKey: '',
      chatSubs: new Set(),
      gitPaths: new Map(),
      gitTimes: [],
      gitInFlight: 0,
      notesTimes: [],
      notesInFlight: 0,
      notesOpTimes: [],
      filesTimes: [],
      filesInFlight: 0,
      filesWatch: false,
      ctlTimes: [],
    }
    this.sessions.add(session)
    session.timer = this.clock.setTimeout(() => {
      session.timer = null
      if (session.phase === 'handshake' || session.phase === 'hello') this.close(session, SHARE_CLOSE.TIMEOUT, 'handshake')
    }, SHARE_HANDSHAKE_TIMEOUT_MS)
    transport.onClose(() => this.onTransportClosed(session))
    transport.onMessage((frame) => this.onFrame(session, frame))
    return session
  }

  all(): HostSession[] {
    return [...this.sessions]
  }

  admitted(): HostSession[] {
    return [...this.sessions].filter((s) => s.phase === 'admitted')
  }

  byId(id: string): HostSession | undefined {
    for (const s of this.sessions) if (s.id === id && s.phase !== 'closed') return s
    return undefined
  }

  /**
   * Seal and send one frame to the session (no-op once it closed). A frame
   * past SHARE_LIMITS.hostFrameMax UTF-8 bytes is dropped before sealing (the
   * guest would end the link on it, and sealing advances the nonce).
   */
  send(session: HostSession, msg: ShareHostMsg): void {
    if (session.phase === 'closed' || !session.channel || session.transport.closed) return
    const text = JSON.stringify(msg)
    if (Buffer.byteLength(text, 'utf8') > SHARE_LIMITS.hostFrameMax) return
    let frame: Buffer
    try {
      frame = session.channel.seal(text)
    } catch {
      this.close(session, SHARE_CLOSE.BAD_MSG, 'crypto')
      return
    }
    session.transport.send(frame)
  }

  /** `ended{reason}` and the matching close code. */
  end(session: HostSession, reason: ShareEndReason): void {
    if (session.phase === 'closed') return
    this.send(session, { t: 'ended', reason })
    this.close(session, END_CODES[reason], reason)
  }

  /** Every session (admitted or pending) of a grant. */
  endGrant(grantId: string, reason: ShareEndReason): void {
    for (const s of [...this.sessions]) if (s.grantId === grantId && s.phase !== 'closed') this.end(s, reason)
  }

  close(session: HostSession, code: number, reason = ''): void {
    if (session.phase === 'closed') return
    const wasAdmitted = session.phase === 'admitted'
    session.phase = 'closed'
    this.cleanup(session, wasAdmitted)
    session.transport.close(code, reason)
  }

  // --- Tickets --------------------------------------------------------------------

  /** A kick or a revoke: that guest (or every guest of the grant) needs to knock again. */
  dropTickets(grantId: string, guestKey?: string): void {
    for (const key of [...this.tickets.keys()]) {
      if (guestKey ? key === pairKey(grantId, guestKey) : key.startsWith(`${grantId}|`)) this.tickets.delete(key)
    }
  }

  /** The perm a ticket reconnect gets: follows a live per-session or grant perm change. */
  setTicketPerm(grantId: string, guestKey: string | null, perm: SharePerm): void {
    for (const [key, t] of this.tickets) {
      if (guestKey ? key === pairKey(grantId, guestKey) : key.startsWith(`${grantId}|`)) t.perm = perm
    }
  }

  /** Every ticket of the grant gets `fn(its perm)` (a grant perm change). */
  remapTicketPerms(grantId: string, fn: (perm: SharePerm) => SharePerm): void {
    for (const [key, t] of this.tickets) if (key.startsWith(`${grantId}|`)) t.perm = fn(t.perm)
  }

  ticketPerm(grantId: string, guestKey: string): SharePerm | null {
    return this.tickets.get(pairKey(grantId, guestKey))?.perm ?? null
  }

  /** The rights a ticket reconnect gets: follows a live per-session change. */
  setTicketRights(grantId: string, guestKey: string, rights: ShareRights): void {
    const t = this.tickets.get(pairKey(grantId, guestKey))
    if (t) t.rights = { ...rights }
  }

  /** Every ticket of the grant gets `fn(its rights)` (a grant rights change). */
  remapTicketRights(grantId: string, fn: (rights: ShareRights) => ShareRights): void {
    for (const [key, t] of this.tickets) if (key.startsWith(`${grantId}|`)) t.rights = fn(t.rights)
  }

  ticketRights(grantId: string, guestKey: string): ShareRights | null {
    const r = this.tickets.get(pairKey(grantId, guestKey))?.rights
    return r ? { ...r } : null
  }

  // --- Approvals ------------------------------------------------------------------

  approvals(): ShareHostApproval[] {
    const out: ShareHostApproval[] = []
    for (const a of this.approvalsById.values()) {
      const grant = this.deps.grants.get(a.grantId)
      if (!grant) continue
      out.push({
        requestId: a.requestId,
        grantId: grant.id,
        grantLabel: this.deps.scopeOf(grant).label,
        scopeKind: grant.scope.kind,
        guestName: a.session.guestName,
        ip: a.session.ip,
        fingerprint: a.session.fingerprint,
        known: a.known,
        passwordFailed: a.session.passwordFailed,
        perm: grant.perm,
        rights: { ...grant.rights },
        ...(a.session.version < 2 ? { legacy: true as const } : {}),
        expiresAt: a.expiresAt,
      })
    }
    return out
  }

  /** The host's Allow / Deny (and the perm and rights the prompt chose). */
  resolve(requestId: string, allow: boolean, perm?: SharePerm, rights?: ShareRights): boolean {
    const a = this.approvalsById.get(requestId)
    if (!a) return false
    const session = a.session
    const grant = this.deps.grants.get(a.grantId)
    if (!allow || !grant) {
      this.removeApproval(session)
      this.failures.record(session.ip)
      this.failures.cooldown(session.ip, SHARE_DENY_COOLDOWN_MS)
      this.send(session, { t: 'denied', reason: 'denied' })
      this.close(session, SHARE_CLOSE.DENIED, 'denied')
      return true
    }
    this.admit(session, grant, perm ?? grant.perm, rights ?? grant.rights)
    return true
  }

  // --- Maintenance ----------------------------------------------------------------

  maintenance(): void {
    const now = this.clock.now()
    for (const s of [...this.sessions]) {
      if ((s.phase === 'admitted' || s.phase === 'pending') && now - s.lastSeen > SHARE_KEEPALIVE_SILENCE_MS) this.close(s, SHARE_CLOSE.TIMEOUT, 'idle')
    }
    for (const [key, t] of this.tickets) if (t.live <= 0 && now >= t.expiresAt) this.tickets.delete(key)
  }

  /** Quit or sharing off: every session ends (the guest may come back later). */
  shutdown(reason: 'host_quit' | 'sharing_off'): void {
    for (const s of [...this.sessions]) {
      if (s.phase === 'admitted') this.end(s, reason)
      else this.close(s, SHARE_CLOSE.GOING_AWAY, reason)
    }
    this.approvalsById.clear()
    this.unauthed.clear()
  }

  // --- Frames ---------------------------------------------------------------------

  private onFrame(session: HostSession, frame: ShareFrame): void {
    if (session.phase === 'closed') return
    session.lastSeen = this.clock.now()
    if (session.phase === 'handshake') {
      if (typeof frame !== 'string') return this.close(session, SHARE_CLOSE.BAD_MSG, 'bad_msg')
      return this.handshake(session, frame)
    }
    if (typeof frame === 'string' || !session.channel) return this.close(session, SHARE_CLOSE.BAD_MSG, 'bad_msg')
    const text = session.channel.open(frame)
    if (text === null) return this.close(session, SHARE_CLOSE.BAD_MSG, 'crypto')
    const parsed = parseShareClientMsg(text)
    if (!parsed.ok) {
      if (session.phase === 'hello') return this.close(session, SHARE_CLOSE.BAD_MSG, 'bad_msg')
      if (parsed.unknown) return this.send(session, { t: 'err', code: 'unsupported' })
      return this.strike(session)
    }
    const msg = parsed.msg
    switch (session.phase) {
      case 'hello':
        if (msg.t !== 'hello') return this.close(session, SHARE_CLOSE.BAD_MSG, 'bad_msg')
        return this.hello(session, msg)
      case 'pending':
        if (msg.t === 'password') return this.passwordWhilePending(session, msg.proof)
        if (msg.t === 'ping') return this.send(session, { t: 'pong', ts: msg.ts })
        if (msg.t === 'bye') return this.close(session, 1000, 'bye')
        this.send(session, { t: 'err', code: 'unauthorized' })
        return this.strike(session)
      case 'admitted':
        if (msg.t === 'ping') return this.send(session, { t: 'pong', ts: msg.ts })
        if (msg.t === 'bye') return this.close(session, 1000, 'bye')
        if (msg.t === 'hello' || msg.t === 'password') return this.strike(session)
        try {
          this.deps.onMessage(session, msg)
        } catch {
          /* a handler bug never takes the socket down */
        }
    }
  }

  private handshake(session: HostSession, raw: string): void {
    const res = hostHandshake(raw, { hostStatic: this.deps.hostKey(), app: this.deps.appVersion, ...(this.deps.protocolMax ? { maxVersion: this.deps.protocolMax } : {}) })
    if (!res.ok) {
      if (res.reply) session.transport.send(res.reply)
      return this.close(session, res.close, res.error)
    }
    session.channel = res.channel
    session.version = res.version
    session.guestKey = toB64u(res.guestStatic)
    session.fingerprint = keyFingerprint(res.guestStatic)
    session.phase = 'hello'
    session.transport.send(res.reply)
    session.transport.send(res.ready)
  }

  private hello(session: HostSession, msg: Extract<ShareClientMsg, { t: 'hello' }>): void {
    const ip = session.ip
    if (this.failures.locked(ip)) {
      this.send(session, { t: 'denied', reason: 'locked' })
      return this.close(session, SHARE_CLOSE.LOCKED, 'locked')
    }
    const channel = session.channel!
    const grant = this.deps.grants.byShareId(msg.sid)
    if (!grant || !verifyShareProof(grant.inviteKey, 'join', channel.h, msg.proof)) {
      this.failures.record(ip)
      return this.close(session, SHARE_CLOSE.BAD_INVITE, 'bad_invite')
    }
    const gate = this.deps.grantGate(grant)
    if (gate === 'expired') return this.close(session, SHARE_CLOSE.EXPIRED, 'expired')
    if (gate === 'scope_gone') return this.close(session, SHARE_CLOSE.SCOPE_GONE, 'scope_gone')
    session.grantId = grant.id
    session.guestName = this.cleanName(msg.guestName)
    session.app = shareText(msg.app, SHARE_LIMITS.appMax)
    if (!this.roomFor(grant.id, session)) {
      this.send(session, { t: 'denied', reason: 'limit' })
      return this.close(session, SHARE_CLOSE.DENIED, 'limit')
    }
    // Reconnect ticket: bound to this guest key and this grant, at the perm it holds.
    if (msg.ticket) {
      const t = this.tickets.get(pairKey(grant.id, session.guestKey))
      if (t && sameToken(t.token, msg.ticket) && (t.live > 0 || this.clock.now() < t.expiresAt)) return this.admit(session, grant, t.perm, t.rights, false)
    }
    if (msg.pw && grant.password) {
      if (verifyShareProof(grant.password.key, 'pw', channel.h, msg.pw)) return this.admit(session, grant, grant.perm, grant.rights)
      this.failures.record(ip)
      session.passwordFailed = true
      if (this.failures.locked(ip)) {
        this.send(session, { t: 'denied', reason: 'locked' })
        return this.close(session, SHARE_CLOSE.LOCKED, 'locked')
      }
    }
    this.requestApproval(session, grant)
  }

  private requestApproval(session: HostSession, grant: ShareGrant): void {
    const ip = session.ip
    const busy =
      this.failures.coolingDown(ip) ||
      this.approvalsById.size >= SHARE_PENDING_MAX ||
      [...this.approvalsById.values()].some((a) => a.session.ip === ip)
    if (busy) {
      this.send(session, { t: 'denied', reason: 'busy' })
      return this.close(session, SHARE_CLOSE.DENIED, 'busy')
    }
    const requestId = randomB64u(12)
    const expiresAt = this.clock.now() + SHARE_APPROVAL_TTL_MS
    this.clearTimer(session)
    session.phase = 'pending'
    session.requestId = requestId
    const approval: Approval = { requestId, session, grantId: grant.id, expiresAt, known: this.deps.grants.isKnown(grant.id, session.guestKey) }
    this.approvalsById.set(requestId, approval)
    session.timer = this.clock.setTimeout(() => {
      session.timer = null
      if (session.phase !== 'pending') return
      this.removeApproval(session)
      this.failures.record(ip)
      this.send(session, { t: 'denied', reason: 'timeout' })
      this.close(session, SHARE_CLOSE.TIMEOUT, 'timeout')
    }, SHARE_APPROVAL_TTL_MS)
    this.sendPending(session, grant)
    this.deps.onApprovalsChanged()
    const view = this.approvals().find((a) => a.requestId === requestId)
    if (view) this.deps.onApprovalRequest?.(view)
  }

  private sendPending(session: HostSession, grant: ShareGrant): void {
    const a = session.requestId ? this.approvalsById.get(session.requestId) : undefined
    this.send(session, {
      t: 'pending',
      expiresAt: a?.expiresAt ?? this.clock.now(),
      password: !!grant.password,
      ...(grant.password ? { salt: toB64u(grant.password.salt) } : {}),
      ...(session.passwordFailed ? { passwordFailed: true } : {}),
    })
  }

  private passwordWhilePending(session: HostSession, proof: string): void {
    const grant = this.deps.grants.get(session.grantId)
    if (!grant) {
      this.removeApproval(session)
      return this.close(session, SHARE_CLOSE.DENIED, 'revoked')
    }
    if (!grant.password) return this.strike(session)
    if (this.failures.locked(session.ip)) {
      this.removeApproval(session)
      this.send(session, { t: 'denied', reason: 'locked' })
      return this.close(session, SHARE_CLOSE.LOCKED, 'locked')
    }
    if (verifyShareProof(grant.password.key, 'pw', session.channel!.h, proof)) return this.admit(session, grant, grant.perm, grant.rights)
    this.failures.record(session.ip)
    session.passwordFailed = true
    if (this.failures.locked(session.ip)) {
      this.removeApproval(session)
      this.send(session, { t: 'denied', reason: 'locked' })
      return this.close(session, SHARE_CLOSE.LOCKED, 'locked')
    }
    this.sendPending(session, grant)
    this.deps.onApprovalsChanged()
  }

  /**
   * `freshAuth` = a password or the host's approval admitted it, which clears
   * the address's failure history. A ticket reconnect never does, or a guest
   * holding any ticket could reset the password lockout between guesses.
   */
  private admit(session: HostSession, grant: ShareGrant, perm: SharePerm, rights: ShareRights, freshAuth = true): void {
    if (!this.roomFor(grant.id, session)) {
      this.removeApproval(session)
      this.send(session, { t: 'denied', reason: 'limit' })
      return this.close(session, SHARE_CLOSE.DENIED, 'limit')
    }
    const hadApproval = this.removeApproval(session)
    this.clearTimer(session)
    this.uncountUnauthed(session)
    if (freshAuth) this.failures.clear(session.ip)
    session.phase = 'admitted'
    session.grantId = grant.id
    session.perm = perm
    session.rights = normalizeShareRights(grant.scope.kind, rights)
    session.since = this.clock.now()
    this.deps.grants.noteGuest(grant.id, session.guestKey, session.guestName)
    const key = pairKey(grant.id, session.guestKey)
    const old = this.tickets.get(key)
    const ticket: Ticket = { token: randomBytes(32).toString('base64url'), perm, rights: { ...session.rights }, live: (old?.live ?? 0) + 1, expiresAt: 0 }
    this.tickets.set(key, ticket)
    this.send(session, {
      t: 'welcome',
      session: { id: session.id },
      grant: { scope: this.deps.scopeOf(grant) },
      perm,
      host: { label: shareText(this.deps.hostLabel(), SHARE_LIMITS.hostLabelMax), platform: this.deps.platform, app: shareText(this.deps.appVersion, SHARE_LIMITS.appMax) },
      ticket: ticket.token,
      state: this.deps.welcomeState(session),
      limits: { inputMax: SHARE_LIMITS.inputMax },
    })
    if (hadApproval) this.deps.onApprovalsChanged()
    this.deps.onAdmitted(session)
  }

  // --- Internals ------------------------------------------------------------------

  private roomFor(grantId: string, session: HostSession): boolean {
    let total = 0
    let ofGrant = 0
    for (const s of this.sessions) {
      if (s === session || s.phase !== 'admitted') continue
      total++
      if (s.grantId === grantId) ofGrant++
    }
    return total < SHARE_SESSIONS_MAX && ofGrant < SHARE_SESSIONS_PER_GRANT
  }

  private cleanName(raw: string): string {
    const fallback = this.deps.guestFallback()
    return shareText(sanitizeDeviceName(raw, fallback), SHARE_LIMITS.guestNameMax) || fallback
  }

  private strike(session: HostSession): void {
    session.strikes += 1
    if (session.strikes >= SHARE_BAD_MSG_LIMIT) this.close(session, SHARE_CLOSE.BAD_MSG, 'bad_msg')
  }

  private removeApproval(session: HostSession): boolean {
    if (!session.requestId) return false
    const had = this.approvalsById.delete(session.requestId)
    session.requestId = null
    return had
  }

  private clearTimer(session: HostSession): void {
    if (session.timer !== null) this.clock.clearTimeout(session.timer)
    session.timer = null
  }

  private uncountUnauthed(session: HostSession): void {
    if (!session.countedUnauthed) return
    session.countedUnauthed = false
    const n = (this.unauthed.get(session.ip) ?? 1) - 1
    if (n <= 0) this.unauthed.delete(session.ip)
    else this.unauthed.set(session.ip, n)
  }

  private onTransportClosed(session: HostSession): void {
    if (session.phase === 'closed') return
    const wasAdmitted = session.phase === 'admitted'
    session.phase = 'closed'
    this.cleanup(session, wasAdmitted)
  }

  private cleanup(session: HostSession, wasAdmitted: boolean): void {
    this.clearTimer(session)
    const hadApproval = this.removeApproval(session)
    this.uncountUnauthed(session)
    this.sessions.delete(session)
    if (wasAdmitted) {
      const t = this.tickets.get(pairKey(session.grantId, session.guestKey))
      if (t) {
        t.live = Math.max(0, t.live - 1)
        if (t.live === 0) t.expiresAt = this.clock.now() + SHARE_TICKET_TTL_MS
      }
    }
    if (hadApproval) this.deps.onApprovalsChanged()
    try {
      this.deps.onClosed(session, wasAdmitted)
    } catch {
      /* never blocks the cleanup */
    }
  }
}
