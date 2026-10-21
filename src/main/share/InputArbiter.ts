/**
 * Who may type into a shared pane right now (app 2.4.0, item 8). One
 * instance per host, state per pane and per guest session.
 *
 * Leases:
 *  - the owner (desktop keyboard or the phone, any PtyManager.write with
 *    origin 'user' that is not a terminal report) holds the pane for
 *    SHARE_HOST_LEASE_MS after each key and revokes a guest's lease at once;
 *    the owner is never refused;
 *  - an accepted guest write holds it for SHARE_GUEST_LEASE_MS against the
 *    other guests.
 * `inputLock` frames go out on transitions only (holder 'host' / 'you' /
 * 'other' / null) to the guests watching the pane.
 *
 * A guest `input` is decided in this order: paused, the rate bucket
 * (60/s, burst 200), the perm gate (ShareInputGate, per pane and session,
 * with the Esc window and pastes judged whole), the owner's lease, another
 * guest's lease; then it is written with origin 'auto' (it invalidates answer
 * cards but never acknowledges the owner's attention) and the lease is armed.
 * The scope check runs before, in ShareHost. A denial answers `inputDenied`
 * (at most one per 500 ms per pane and session, no strike); an admitted paste
 * the guest left open is closed by the host (`\x1b[201~`) whenever its next
 * write is refused, its lease is taken or its session ends.
 */
import { REPORTS_ONLY_RE } from '@shared/inputReports'
import { SHARE_GUEST_LEASE_MS, SHARE_HOST_LEASE_MS, type ShareDenyReason, type ShareHostMsg } from '@shared/share-protocol'
import { ShareInputGate, SharePasteAssembler, type ShareInputCtx } from '@shared/shareInput'
import type { SharePerm } from '@shared/types'
import type { PtyInputOrigin } from '../pty/PtyManager'
import { TokenBucket } from '../remote/TokenBucket'
import { realShareClock, type ShareClock, type ShareTimer } from './clock'

export const SHARE_INPUT_RATE_PER_SEC = 60
export const SHARE_INPUT_BURST = 200
export const SHARE_DENY_THROTTLE_MS = 500

export interface ArbiterDeps<S> {
  /** Write to the pane's live pty with origin 'auto'; false when it has none. */
  write(paneId: string, data: string): boolean
  send(session: S, msg: ShareHostMsg): void
  /** Guests to tell about a lock change (the ones watching the pane). */
  watchers(paneId: string): Iterable<S>
  /** What the gate needs to know about the pane, without lastByte. */
  ctxFor(paneId: string): Omit<ShareInputCtx, 'lastByte'>
  permOf(session: S): SharePerm
  paused(session: S): boolean
  clock?: ShareClock
  /** A lease started or ended (share:panes "is typing"). */
  onLeaseChange?(paneId: string): void
}

export interface GuestInputMsg {
  paneId: string
  data: string
  seq: number
  paste?: { id: number; part: number; last: boolean }
}

interface PaneState {
  hostUntil: number
  hostTimer: ShareTimer | null
  guest: { session: object; until: number; timer: ShareTimer | null } | null
  lastByte: string
}

interface SessionState {
  gates: Map<string, ShareInputGate>
  paste: SharePasteAssembler
  bucket: TokenBucket
  lastDeny: Map<string, number>
}

export class InputArbiter<S extends object> {
  private readonly panes = new Map<string, PaneState>()
  private readonly sessions = new Map<S, SessionState>()
  private readonly clock: ShareClock

  constructor(private readonly deps: ArbiterDeps<S>) {
    this.clock = deps.clock ?? realShareClock
  }

  /** Every write that reaches a pty (PtySink.onUserInput): last byte, and the owner's lease. */
  onPtyInput(paneId: string, data: string, origin: PtyInputOrigin): void {
    if (!data) return
    const pane = this.pane(paneId)
    pane.lastByte = data[data.length - 1]
    if (origin !== 'user' || REPORTS_ONLY_RE.test(data)) return
    const now = this.clock.now()
    const wasHost = now < pane.hostUntil
    pane.hostUntil = now + SHARE_HOST_LEASE_MS
    if (pane.guest) this.releaseGuest(paneId, pane, true)
    if (!wasHost) {
      for (const s of this.deps.watchers(paneId)) this.deps.send(s, { t: 'inputLock', paneId, holder: 'host' })
      this.deps.onLeaseChange?.(paneId)
    }
    if (pane.hostTimer === null) this.armHostTimer(paneId, pane)
  }

  /** The owner holds the pane right now. */
  hostTyping(paneId: string): boolean {
    const pane = this.panes.get(paneId)
    return !!pane && this.clock.now() < pane.hostUntil
  }

  /** The guest holding the pane's lease, or null. */
  guestHolder(paneId: string): S | null {
    const g = this.panes.get(paneId)?.guest
    return g && this.clock.now() < g.until ? (g.session as S) : null
  }

  /** The lock a guest sees for the pane right now (sent after a sub). */
  lockFor(session: S, paneId: string): 'host' | 'you' | 'other' | null {
    if (this.hostTyping(paneId)) return 'host'
    const holder = this.guestHolder(paneId)
    if (!holder) return null
    return holder === session ? 'you' : 'other'
  }

  input(session: S, msg: GuestInputMsg): void {
    const st = this.sessionState(session)
    const { paneId, seq } = msg
    if (this.deps.paused(session)) {
      st.paste.reset()
      return this.deny(session, st, paneId, seq, 'paused')
    }
    if (!st.bucket.take()) return this.deny(session, st, paneId, seq, 'rate')
    let data = msg.data
    if (msg.paste) {
      const r = st.paste.push(paneId, data, msg.paste)
      if (r.kind === 'wait') return
      if (r.kind === 'error') return this.deny(session, st, paneId, seq, r.reason)
      data = r.data
    } else {
      st.paste.reset() // a plain input between parts drops the unfinished paste (nothing of it was written)
    }
    const gate = this.gate(st, paneId)
    const pane = this.pane(paneId)
    const verdict = gate.check(data, this.deps.permOf(session), { ...this.deps.ctxFor(paneId), lastByte: pane.lastByte })
    if (!verdict.ok) {
      if (verdict.drop) return
      return this.deny(session, st, paneId, seq, verdict.reason)
    }
    const now = this.clock.now()
    if (now < pane.hostUntil) return this.deny(session, st, paneId, seq, 'host_typing')
    if (pane.guest && pane.guest.session !== session && now < pane.guest.until) return this.deny(session, st, paneId, seq, 'other_typing')
    if (!this.deps.write(paneId, data)) return
    gate.commit(data)
    this.armGuest(session, paneId, pane, now)
  }

  /** The session is gone (closed, kicked, revoked): its leases end and its open pastes are closed. */
  dropSession(session: S): void {
    const st = this.sessions.get(session)
    if (!st) return
    this.sessions.delete(session)
    for (const [paneId, gate] of st.gates) {
      const close = gate.cutPaste()
      if (close) this.deps.write(paneId, close)
    }
    for (const [paneId, pane] of this.panes) {
      if (pane.guest?.session === session) this.releaseGuest(paneId, pane, false)
    }
  }

  /** The session no longer sees the pane (unsub or out of scope): same as above for that pane only. */
  dropPane(session: S, paneId: string): void {
    const st = this.sessions.get(session)
    const gate = st?.gates.get(paneId)
    if (st && gate) {
      const close = gate.cutPaste()
      if (close) this.deps.write(paneId, close)
      st.gates.delete(paneId)
    }
    const pane = this.panes.get(paneId)
    if (pane?.guest?.session === session) this.releaseGuest(paneId, pane, false)
  }

  dispose(): void {
    for (const pane of this.panes.values()) {
      if (pane.hostTimer !== null) this.clock.clearTimeout(pane.hostTimer)
      if (pane.guest?.timer) this.clock.clearTimeout(pane.guest.timer)
    }
    this.panes.clear()
    this.sessions.clear()
  }

  // --- Internals ----------------------------------------------------------------

  private pane(paneId: string): PaneState {
    let p = this.panes.get(paneId)
    if (!p) {
      p = { hostUntil: 0, hostTimer: null, guest: null, lastByte: '' }
      this.panes.set(paneId, p)
    }
    return p
  }

  private sessionState(session: S): SessionState {
    let st = this.sessions.get(session)
    if (!st) {
      st = {
        gates: new Map(),
        paste: new SharePasteAssembler(),
        bucket: new TokenBucket(SHARE_INPUT_RATE_PER_SEC, SHARE_INPUT_BURST, () => this.clock.now()),
        lastDeny: new Map(),
      }
      this.sessions.set(session, st)
    }
    return st
  }

  private gate(st: SessionState, paneId: string): ShareInputGate {
    let g = st.gates.get(paneId)
    if (!g) {
      g = new ShareInputGate(() => this.clock.now())
      st.gates.set(paneId, g)
    }
    return g
  }

  private deny(session: S, st: SessionState, paneId: string, seq: number, reason: ShareDenyReason): void {
    // A paste this guest opened and can no longer finish is closed by the host.
    const gate = st.gates.get(paneId)
    const close = gate?.cutPaste()
    if (close) this.deps.write(paneId, close)
    const now = this.clock.now()
    const last = st.lastDeny.get(paneId)
    if (last !== undefined && now - last < SHARE_DENY_THROTTLE_MS) return
    st.lastDeny.set(paneId, now)
    this.deps.send(session, { t: 'inputDenied', paneId, seq, reason })
  }

  private armHostTimer(paneId: string, pane: PaneState): void {
    const wait = Math.max(0, pane.hostUntil - this.clock.now())
    pane.hostTimer = this.clock.setTimeout(() => {
      pane.hostTimer = null
      if (this.clock.now() < pane.hostUntil) return this.armHostTimer(paneId, pane)
      for (const s of this.deps.watchers(paneId)) this.deps.send(s, { t: 'inputLock', paneId, holder: null })
      this.deps.onLeaseChange?.(paneId)
    }, wait)
  }

  private armGuest(session: S, paneId: string, pane: PaneState, now: number): void {
    const until = now + SHARE_GUEST_LEASE_MS
    if (pane.guest && pane.guest.session === session && now < pane.guest.until) {
      pane.guest.until = until
      return
    }
    if (pane.guest?.timer) this.clock.clearTimeout(pane.guest.timer)
    const lease: NonNullable<PaneState['guest']> = { session, until, timer: null }
    pane.guest = lease
    const tick = (): void => {
      lease.timer = null
      if (pane.guest !== lease) return
      const left = lease.until - this.clock.now()
      if (left > 0) {
        lease.timer = this.clock.setTimeout(tick, left)
        return
      }
      this.releaseGuest(paneId, pane, false)
    }
    lease.timer = this.clock.setTimeout(tick, SHARE_GUEST_LEASE_MS)
    for (const s of this.deps.watchers(paneId)) this.deps.send(s, { t: 'inputLock', paneId, holder: s === session ? 'you' : 'other' })
    this.deps.onLeaseChange?.(paneId)
  }

  /** End the guest lease; `byHost`: the owner took the pane (the 'host' lock follows, no null in between). */
  private releaseGuest(paneId: string, pane: PaneState, byHost: boolean): void {
    const lease = pane.guest
    if (!lease) return
    pane.guest = null
    if (lease.timer) this.clock.clearTimeout(lease.timer)
    const gate = this.sessions.get(lease.session as S)?.gates.get(paneId)
    const close = gate?.cutPaste()
    if (close) this.deps.write(paneId, close)
    if (byHost) return
    for (const s of this.deps.watchers(paneId)) this.deps.send(s, { t: 'inputLock', paneId, holder: null })
    this.deps.onLeaseChange?.(paneId)
  }
}
