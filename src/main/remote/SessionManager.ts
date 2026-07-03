/**
 * One SessionManager backs the whole embedded server: it is registered once as
 * a PtySink and owns every phone socket's state machine (pre-auth handshake ->
 * authed), the paneId-keyed subscription fan-out, per-socket output coalescing
 * with backpressure, and the mutual challenge-response auth.
 *
 * It is the desktop trusting nobody: every inbound frame is schema-validated,
 * `authed` is re-checked at a single choke point, and unauthenticated sockets
 * are capped, timed out, and rate-limited per IP.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { WebSocket, type RawData } from 'ws'
import type { RemoteCommandResult } from '@shared/ipc-contract'
import {
  PROTOCOL_VERSION,
  REMOTE_CLOSE,
  type RemoteAuthFailReason,
  type RemoteCtlAction,
  type RemotePairDeniedReason,
  type RemoteServerMsg,
  type RemoteStateSnapshot,
} from '@shared/remote-protocol'
import { parseRemoteClientMsg } from '@shared/remote-protocol-schemas'
import type { PtyManager, PtySink } from '../pty/PtyManager'
import type { DeviceRegistry } from './DeviceRegistry'
import type { PairingService, RateLimiter } from './PairingService'

/** Coalesce `out` bytes at ~60Hz per socket (mirror of the desktop cadence). */
const OUT_COALESCE_MS = 16
/** Pre-auth sockets must complete the handshake within this window. */
const HANDSHAKE_TIMEOUT_MS = 10 * 1000
/** Simultaneous un-authed sockets tolerated from one IP (pre-auth DoS bound). */
const MAX_UNAUTHED_PER_IP = 8
/** A socket silent longer than this is presumed dead (client pings every 25s). */
const KEEPALIVE_SILENCE_MS = 60 * 1000
/** Cadence of the keepalive + backpressure sweep. */
const MAINTENANCE_MS = 5 * 1000
/** Above this queued-per-socket, drop `out` for the pane and mark it congested. */
const BACKPRESSURE_DROP = 512 * 1024
/** Below this, a congested pane resyncs with a fresh replay. */
const BACKPRESSURE_RECOVER = 64 * 1024
/** Hard ceiling: a socket this far behind is terminated. */
const BACKPRESSURE_KILL = 4 * 1024 * 1024
/** A pane congested longer than this terminates the socket. */
const CONGESTION_KILL_MS = 30 * 1000
/** Malformed frames tolerated before the socket is closed. */
const BAD_MSG_LIMIT = 3
/** Generic policy-violation close (client keeps its secret and may retry). */
const CLOSE_POLICY = 1008
/** Normal / going-away close codes. */
const CLOSE_NORMAL = 1000
const CLOSE_GOING_AWAY = 1001

/** Distributive Omit so callers of send() skip the constant `v` field. */
type ServerMsgNoV<T = RemoteServerMsg> = T extends unknown ? Omit<T, 'v'> : never

/** Result delivered to the paired socket (pairing resolve or pending expiry). */
export type DeliveredPairResult =
  | { kind: 'paired'; deviceId: string; secret: string }
  | { kind: 'denied'; reason: RemotePairDeniedReason }

interface Session {
  ws: WebSocket
  ip: string
  authed: boolean
  deviceId: string | null
  /** Nonce the client must HMAC (single-use per socket). */
  serverNonce: string | null
  /** Device id the pending challenge belongs to. */
  challengeDeviceId: string | null
  /** True after a device-less hello (this socket may only pair). */
  pairingAllowed: boolean
  /** Pending pairing request id while awaiting the desktop's Allow/Deny. */
  pendingRequestId: string | null
  /** Whether this socket still counts against MAX_UNAUTHED_PER_IP. */
  countedUnauthed: boolean
  /** Subscribed pane ids (data plane). */
  subs: Set<string>
  /** Per-pane coalesce buffer, joined and flushed on the socket timer. */
  outBuf: Map<string, string>
  outTimer: ReturnType<typeof setTimeout> | null
  /** Panes whose `out` is currently being dropped for backpressure. */
  congested: Set<string>
  congestedSince: Map<string, number>
  lastSeen: number
  handshakeTimer: ReturnType<typeof setTimeout> | null
  badMsgStrikes: number
}

export interface SessionManagerDeps {
  ptyManager: PtyManager
  registry: DeviceRegistry
  pairing: PairingService
  rateLimiter: RateLimiter
  appVersion: string
  /** Current running-overridden snapshot (for authOk / post-pair state). */
  getSnapshot: () => RemoteStateSnapshot
  /** Relay a control action to the renderer and await its result (10s bound). */
  executeCommand: (action: RemoteCtlAction) => Promise<RemoteCommandResult>
  /** Authed-session count changed (toggles throttling + pushes UI state). */
  onConnectionsChanged: () => void
}

/**
 * HMAC-SHA256 wire convention (must match the mobile client's pure-JS impl):
 * key = the device secret hex-DECODED to its raw 32 bytes; message = the nonce
 * as its literal hex string (UTF-8). Changing either side alone breaks auth.
 */
function hmacHex(secretHex: string, message: string): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message).digest('hex')
}

/** Timing-safe compare of two equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}

export class SessionManager implements PtySink {
  readonly id = 'remote-sessions'
  private readonly sessions = new Set<Session>()
  /** paneId -> sessions subscribed to it (data-plane fan-out). */
  private readonly paneSubs = new Map<string, Set<Session>>()
  /** requestId -> the socket waiting on that pairing approval. */
  private readonly pendingPairSessions = new Map<string, Session>()
  private readonly unauthedByIp = new Map<string, number>()
  private readonly maintenanceTimer: ReturnType<typeof setInterval>

  constructor(private readonly deps: SessionManagerDeps) {
    this.maintenanceTimer = setInterval(() => this.maintenance(), MAINTENANCE_MS)
  }

  // --- Connection intake ----------------------------------------------------

  /** Adopt a freshly upgraded socket (already Host/Origin validated by server). */
  handleSocket(ws: WebSocket, ip: string): void {
    const unauthed = this.unauthedByIp.get(ip) ?? 0
    if (unauthed >= MAX_UNAUTHED_PER_IP) {
      try {
        ws.close(REMOTE_CLOSE.RATE_LIMITED, 'too many')
      } catch {
        /* ignore */
      }
      return
    }
    this.unauthedByIp.set(ip, unauthed + 1)

    const session: Session = {
      ws,
      ip,
      authed: false,
      deviceId: null,
      serverNonce: null,
      challengeDeviceId: null,
      pairingAllowed: false,
      pendingRequestId: null,
      countedUnauthed: true,
      subs: new Set(),
      outBuf: new Map(),
      outTimer: null,
      congested: new Set(),
      congestedSince: new Map(),
      lastSeen: Date.now(),
      handshakeTimer: null,
      badMsgStrikes: 0,
    }
    this.sessions.add(session)
    session.handshakeTimer = setTimeout(() => {
      // A socket parked in pending-pairing legitimately waits up to 60s.
      if (!session.authed && !session.pendingRequestId) {
        this.closeSession(session, CLOSE_POLICY, 'handshake timeout')
      }
    }, HANDSHAKE_TIMEOUT_MS)

    ws.on('message', (data) => void this.onMessage(session, this.decode(data)))
    ws.on('close', () => this.removeSession(session))
    ws.on('error', () => {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
    })
  }

  private decode(data: RawData): string {
    if (typeof data === 'string') return data
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
    if (Buffer.isBuffer(data)) return data.toString('utf8')
    return Buffer.from(data as ArrayBuffer).toString('utf8')
  }

  // --- Message dispatch -----------------------------------------------------

  private async onMessage(session: Session, raw: string): Promise<void> {
    session.lastSeen = Date.now()
    const msg = parseRemoteClientMsg(raw)
    if (!msg) {
      session.badMsgStrikes += 1
      this.send(session, { type: 'err', code: 'bad_msg' })
      if (session.badMsgStrikes >= BAD_MSG_LIMIT) this.closeSession(session, CLOSE_POLICY, 'bad_msg')
      return
    }
    if (msg.v !== PROTOCOL_VERSION) {
      this.send(session, { type: 'err', code: 'version' })
      return
    }

    // Pre-auth: only the handshake verbs are allowed. This branch is the single
    // choke point that gates every post-auth message type on `authed`.
    if (!session.authed) {
      switch (msg.type) {
        case 'ping':
          return this.send(session, { type: 'pong', t: msg.t })
        case 'hello':
          return this.handleHello(session, msg.deviceId, msg.clientNonce)
        case 'pair':
          return this.handlePair(session, msg.code, msg.deviceName)
        case 'auth':
          return this.handleAuth(session, msg.deviceId, msg.hmac)
        default:
          return this.send(session, { type: 'err', code: 'unauthorized' })
      }
    }

    switch (msg.type) {
      case 'ping':
        return this.send(session, { type: 'pong', t: msg.t })
      case 'sub':
        return this.handleSub(session, msg.paneId)
      case 'unsub':
        return this.handleUnsub(session, msg.paneId)
      case 'input':
        return this.handleInput(msg.paneId, msg.data)
      case 'ctl':
        return void this.handleCtl(session, msg.id, msg.action)
      default:
        return this.send(session, { type: 'err', code: 'unauthorized' })
    }
  }

  // --- Auth handshake -------------------------------------------------------

  private handleHello(session: Session, deviceId: string | undefined, clientNonce: string): void {
    if (this.deps.rateLimiter.isLocked(session.ip)) return this.rejectLocked(session)
    if (!deviceId) {
      // Device-less hello is the pairing entry point: no challenge needed.
      session.pairingAllowed = true
      return
    }
    const device = this.deps.registry.get(deviceId)
    if (!device) {
      this.send(session, { type: 'authFail', reason: 'unknownDevice' })
      return this.closeSession(session, REMOTE_CLOSE.UNKNOWN_DEVICE, 'unknown')
    }
    // Mutual auth: prove we hold the secret (proof over the client's nonce)
    // before asking the client to prove it holds the secret (over ours).
    const serverNonce = randomBytes(32).toString('hex')
    session.serverNonce = serverNonce
    session.challengeDeviceId = deviceId
    this.send(session, {
      type: 'challenge',
      nonce: serverNonce,
      proof: hmacHex(device.secret, clientNonce),
    })
  }

  private handleAuth(session: Session, deviceId: string, hmac: string): void {
    if (this.deps.rateLimiter.isLocked(session.ip)) return this.rejectLocked(session)
    const challengeId = session.challengeDeviceId
    const nonce = session.serverNonce
    session.serverNonce = null // single-use regardless of outcome
    if (!challengeId || !nonce || challengeId !== deviceId) {
      return this.failAuth(session, 'badHmac')
    }
    const device = this.deps.registry.get(deviceId)
    if (!device) {
      this.send(session, { type: 'authFail', reason: 'unknownDevice' })
      return this.closeSession(session, REMOTE_CLOSE.UNKNOWN_DEVICE, 'unknown')
    }
    if (!timingSafeEqualHex(hmacHex(device.secret, nonce), hmac)) {
      return this.failAuth(session, 'badHmac')
    }
    this.deps.rateLimiter.clear(session.ip)
    this.finishAuth(session, deviceId)
    this.send(session, {
      type: 'authOk',
      deviceId,
      state: this.deps.getSnapshot(),
      hostPlatform: process.platform,
      appVersion: this.deps.appVersion,
    })
  }

  private failAuth(session: Session, reason: RemoteAuthFailReason): void {
    this.deps.rateLimiter.recordFailure(session.ip)
    if (this.deps.rateLimiter.isLocked(session.ip)) return this.rejectLocked(session)
    this.send(session, { type: 'authFail', reason })
    this.closeSession(session, CLOSE_POLICY, reason)
  }

  private rejectLocked(session: Session): void {
    this.send(session, {
      type: 'authFail',
      reason: 'locked',
      retryAfterMs: this.deps.rateLimiter.retryAfterMs(session.ip),
    })
    this.closeSession(session, REMOTE_CLOSE.RATE_LIMITED, 'locked')
  }

  /** Mark a socket authenticated and stop counting it against the pre-auth cap. */
  private finishAuth(session: Session, deviceId: string): void {
    session.authed = true
    session.deviceId = deviceId
    this.clearHandshakeTimer(session)
    this.uncountUnauthed(session)
    this.deps.registry.touchLastSeen(deviceId)
    this.deps.onConnectionsChanged()
  }

  // --- Pairing --------------------------------------------------------------

  private handlePair(session: Session, code: string, deviceName: string): void {
    if (this.deps.rateLimiter.isLocked(session.ip)) {
      this.send(session, { type: 'pairDenied', reason: 'badCode' })
      return this.closeSession(session, REMOTE_CLOSE.RATE_LIMITED, 'locked')
    }
    const result = this.deps.pairing.submitPair(code, deviceName, session.ip)
    if (result.status === 'denied') {
      if (result.reason === 'badCode') this.deps.rateLimiter.recordFailure(session.ip)
      this.send(session, { type: 'pairDenied', reason: result.reason })
      return
    }
    // Awaiting a human decision for up to 60s: retire the 10s handshake timer;
    // the pending request's own timeout governs this socket now.
    session.pendingRequestId = result.info.requestId
    this.pendingPairSessions.set(result.info.requestId, session)
    this.clearHandshakeTimer(session)
    this.send(session, { type: 'pairPending' })
  }

  /** Deliver a pairing outcome (approval, denial, or expiry) to its socket. */
  deliverPairResult(requestId: string, result: DeliveredPairResult): void {
    const session = this.pendingPairSessions.get(requestId)
    this.pendingPairSessions.delete(requestId)
    if (!session) return
    session.pendingRequestId = null
    if (result.kind === 'paired') {
      this.send(session, { type: 'paired', deviceId: result.deviceId, secret: result.secret })
      this.finishAuth(session, result.deviceId)
      // Full authOk (not just a state frame) so the freshly paired client goes
      // live through the same path as a reconnect and learns hostPlatform.
      this.send(session, {
        type: 'authOk',
        deviceId: result.deviceId,
        state: this.deps.getSnapshot(),
        hostPlatform: process.platform,
        appVersion: this.deps.appVersion,
      })
      return
    }
    this.send(session, { type: 'pairDenied', reason: result.reason })
    this.closeSession(session, CLOSE_NORMAL, result.reason)
  }

  // --- Subscriptions + data plane ------------------------------------------

  private handleSub(session: Session, paneId: string): void {
    if (session.subs.has(paneId)) return
    // Single synchronous block: drain pending output to current subscribers,
    // add this session, then send the replay. That makes the replay the exact
    // prefix of the `out` frames this socket will receive next (no gap/overlap).
    const replay = this.deps.ptyManager.getReplay(paneId)
    session.subs.add(paneId)
    let set = this.paneSubs.get(paneId)
    if (!set) {
      set = new Set()
      this.paneSubs.set(paneId, set)
    }
    set.add(session)
    this.sendReplay(session, paneId, replay)
    this.recomputeForcedFast()
  }

  private handleUnsub(session: Session, paneId: string): void {
    if (!session.subs.delete(paneId)) return
    const set = this.paneSubs.get(paneId)
    if (set) {
      set.delete(session)
      if (set.size === 0) this.paneSubs.delete(paneId)
    }
    this.discardPane(session, paneId)
    this.recomputeForcedFast()
  }

  private handleInput(paneId: string, data: string): void {
    const ptyId = this.deps.ptyManager.ptyIdForPane(paneId)
    if (ptyId) this.deps.ptyManager.write(ptyId, data)
  }

  private async handleCtl(session: Session, id: string, action: RemoteCtlAction): Promise<void> {
    const result = await this.deps.executeCommand(action)
    this.send(session, {
      type: 'ctlAck',
      id,
      ok: result.ok,
      error: result.error,
      paneId: result.paneId,
      info: result.info,
    })
  }

  // --- PtySink (fan-out from PtyManager) ------------------------------------

  onSpawn(_ptyId: string, paneId: string): void {
    const subs = this.paneSubs.get(paneId)
    if (!subs || subs.size === 0) return
    // Rebind: a new pty backs this pane (spawn or restart). Drop any coalesced
    // bytes from the previous pty and push a fresh replay so clients reset.
    const replay = this.deps.ptyManager.getReplay(paneId)
    for (const session of subs) {
      this.discardPane(session, paneId)
      this.sendReplay(session, paneId, replay)
    }
    // A pane subscribed while it had no pty (running:false) now has one: make
    // sure it flushes at the fast cadence even if its desktop pane is hidden.
    this.recomputeForcedFast()
  }

  onData(_ptyId: string, paneId: string, data: string): void {
    const subs = this.paneSubs.get(paneId)
    if (!subs) return
    for (const session of subs) this.bufferOut(session, paneId, data)
  }

  onExit(ptyId: string, paneId: string, exitCode: number): void {
    // Ignore a stale exit whose pane already rebound to a newer pty.
    if (this.deps.ptyManager.ptyIdForPane(paneId) !== ptyId) return
    const subs = this.paneSubs.get(paneId)
    if (!subs) return
    for (const session of subs) {
      this.flushPane(session, paneId)
      this.send(session, { type: 'exit', paneId, exitCode })
    }
  }

  // --- Broadcast / lifecycle exposed to RemoteManager -----------------------

  broadcastState(snapshot: RemoteStateSnapshot): void {
    for (const session of this.sessions) {
      if (session.authed) this.send(session, { type: 'state', state: snapshot })
    }
  }

  get connectedCount(): number {
    let n = 0
    for (const session of this.sessions) if (session.authed) n += 1
    return n
  }

  connectedDeviceIds(): Set<string> {
    const ids = new Set<string>()
    for (const session of this.sessions) {
      if (session.authed && session.deviceId) ids.add(session.deviceId)
    }
    return ids
  }

  /** Terminate every socket of a revoked device (revoked frame, then 4403). */
  killByDevice(deviceId: string): void {
    let changed = false
    for (const session of [...this.sessions]) {
      if (session.deviceId !== deviceId) continue
      this.send(session, { type: 'revoked' }) // best-effort while still OPEN
      // ws.close() only starts a graceful close: the TCP can linger up to ws's
      // 30s closeTimeout, during which a malicious client that ignores the
      // close frame would otherwise keep hitting the authed choke point. Flip
      // authed off NOW so any further sub/input/ctl is rejected immediately.
      session.authed = false
      changed = true
      this.closeSession(session, REMOTE_CLOSE.REVOKED, 'revoked')
    }
    if (changed) this.deps.onConnectionsChanged()
  }

  /** Best-effort shutdown frame + close; never awaits (must not delay quit). */
  shutdownAll(reason: 'quit' | 'disabled'): void {
    for (const session of this.sessions) {
      this.send(session, { type: 'shutdown', reason })
      try {
        session.ws.close(CLOSE_GOING_AWAY, reason)
      } catch {
        try {
          session.ws.terminate()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Hard teardown: stop timers, drop all sockets, release forced-fast panes. */
  dispose(): void {
    clearInterval(this.maintenanceTimer)
    for (const session of [...this.sessions]) {
      if (session.outTimer) clearTimeout(session.outTimer)
      this.clearHandshakeTimer(session)
      try {
        session.ws.terminate()
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear()
    this.paneSubs.clear()
    this.pendingPairSessions.clear()
    this.unauthedByIp.clear()
    this.deps.ptyManager.setForcedFast([])
  }

  // --- Output coalescing + backpressure -------------------------------------

  private bufferOut(session: Session, paneId: string, data: string): void {
    session.outBuf.set(paneId, (session.outBuf.get(paneId) ?? '') + data)
    if (!session.outTimer) {
      session.outTimer = setTimeout(() => this.flushOut(session), OUT_COALESCE_MS)
    }
  }

  private flushOut(session: Session): void {
    session.outTimer = null
    for (const [paneId, data] of session.outBuf) {
      // Congested panes stay dropped until the sweep resyncs them with a replay.
      if (!session.congested.has(paneId)) this.sendOut(session, paneId, data)
    }
    session.outBuf.clear()
  }

  private flushPane(session: Session, paneId: string): void {
    const data = session.outBuf.get(paneId)
    if (data === undefined) return
    session.outBuf.delete(paneId)
    if (!session.congested.has(paneId)) this.sendOut(session, paneId, data)
  }

  private discardPane(session: Session, paneId: string): void {
    session.outBuf.delete(paneId)
    session.congested.delete(paneId)
    session.congestedSince.delete(paneId)
  }

  private sendOut(session: Session, paneId: string, data: string): void {
    if (session.ws.bufferedAmount > BACKPRESSURE_DROP) {
      session.congested.add(paneId)
      if (!session.congestedSince.has(paneId)) session.congestedSince.set(paneId, Date.now())
      return
    }
    this.send(session, { type: 'out', paneId, data })
  }

  private sendReplay(
    session: Session,
    paneId: string,
    replay: { ptyId: string; replay: string; cols: number; rows: number } | null,
  ): void {
    if (replay) {
      this.send(session, {
        type: 'replay',
        paneId,
        running: true,
        data: replay.replay,
        cols: replay.cols,
        rows: replay.rows,
      })
    } else {
      // Pane exists but has no live pty yet: client shows a spinner until the
      // lazy spawn arrives and onSpawn pushes a running replay.
      this.send(session, { type: 'replay', paneId, running: false, data: '', cols: 80, rows: 24 })
    }
  }

  private recomputeForcedFast(): void {
    const all = new Set<string>()
    for (const session of this.sessions) for (const paneId of session.subs) all.add(paneId)
    this.deps.ptyManager.setForcedFast(all)
  }

  // --- Keepalive + backpressure sweep ---------------------------------------

  private maintenance(): void {
    const now = Date.now()
    for (const session of [...this.sessions]) {
      const ws = session.ws
      if (now - session.lastSeen > KEEPALIVE_SILENCE_MS) {
        this.closeSession(session, CLOSE_GOING_AWAY, 'idle')
        continue
      }
      if (ws.bufferedAmount > BACKPRESSURE_KILL) {
        this.terminate(session)
        continue
      }
      let killed = false
      for (const since of session.congestedSince.values()) {
        if (now - since > CONGESTION_KILL_MS) {
          this.terminate(session)
          killed = true
          break
        }
      }
      if (killed) continue
      // Recovery: the socket drained, so resync each congested pane from history.
      // Order matters and mirrors handleSub: getReplay first (its internal flush
      // re-buffers the just-flushed tail into outBuf, and that tail is already in
      // the replay history), THEN discardPane to drop that re-buffered tail and
      // clear congestion, THEN send. Doing discardPane first would let the tail
      // reappear as an `out` frame after the replay, duplicating output.
      if (session.congested.size > 0 && ws.bufferedAmount < BACKPRESSURE_RECOVER) {
        for (const paneId of [...session.congested]) {
          const replay = this.deps.ptyManager.getReplay(paneId)
          this.discardPane(session, paneId)
          this.sendReplay(session, paneId, replay)
        }
      }
    }
  }

  // --- Socket bookkeeping ---------------------------------------------------

  private send(session: Session, msg: ServerMsgNoV): void {
    const ws = session.ws
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }))
    } catch {
      /* socket dying; the close handler will clean it up */
    }
  }

  private closeSession(session: Session, code: number, reason: string): void {
    try {
      session.ws.close(code, reason)
    } catch {
      this.terminate(session)
    }
  }

  private terminate(session: Session): void {
    try {
      session.ws.terminate()
    } catch {
      /* ignore */
    }
    this.removeSession(session)
  }

  private removeSession(session: Session): void {
    if (!this.sessions.delete(session)) return
    this.clearHandshakeTimer(session)
    if (session.outTimer) {
      clearTimeout(session.outTimer)
      session.outTimer = null
    }
    this.uncountUnauthed(session)
    for (const paneId of session.subs) {
      const set = this.paneSubs.get(paneId)
      if (!set) continue
      set.delete(session)
      if (set.size === 0) this.paneSubs.delete(paneId)
    }
    session.subs.clear()
    if (session.pendingRequestId) {
      this.pendingPairSessions.delete(session.pendingRequestId)
      this.deps.pairing.cancelPending(session.pendingRequestId)
      session.pendingRequestId = null
    }
    this.recomputeForcedFast()
    if (session.authed) this.deps.onConnectionsChanged()
  }

  private uncountUnauthed(session: Session): void {
    if (!session.countedUnauthed) return
    session.countedUnauthed = false
    const n = (this.unauthedByIp.get(session.ip) ?? 1) - 1
    if (n <= 0) this.unauthedByIp.delete(session.ip)
    else this.unauthedByIp.set(session.ip, n)
  }

  private clearHandshakeTimer(session: Session): void {
    if (session.handshakeTimer) {
      clearTimeout(session.handshakeTimer)
      session.handshakeTimer = null
    }
  }
}
