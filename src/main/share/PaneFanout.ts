/**
 * Data plane of the Share host (app 2.4.0, item 8): PtySink `share-sessions`
 * fans each pane's output out to the guest sessions subscribed to it. A
 * copy-adapt of SessionManager's data plane (that file is untouched), with
 * the same invariants:
 *  - sub: getReplay, then add the sub, then send the replay, in one
 *    synchronous block, so the replay is the exact prefix of the `out`
 *    frames that follow (no gap, no overlap);
 *  - resync / recovery: getReplay, then discard the session's buffered
 *    bytes for the pane, then send (getReplay flushes the pty's pending
 *    output to the sinks, and that tail is already in the replay);
 *  - out coalesced 16 ms per session; a socket over 512KB buffered drops
 *    the pane (congested) until it drains under 64KB and gets a replay; past
 *    4MB buffered or 30 s congested the session is terminated.
 * Unlike the phone, every `replay` and `out` is split into frames of at most
 * 16K UTF-16 units (never a split surrogate pair), and a paused session
 * (grant paused or "pause all") gets nothing until it resumes with a replay.
 *
 * Generic over the session object; the facade (ShareHost) gives it the send,
 * the socket's buffered amount and the pause rule.
 */
import { SHARE_LIMITS, type ShareHostMsg } from '@shared/share-protocol'
import type { PtyExitInfo, PtyInputOrigin, PtySink } from '../pty/PtyManager'
import { realShareClock, type ShareClock, type ShareTimer } from './clock'

// Mirror of SessionManager's module-private thresholds (keep in step).
export const FANOUT_OUT_COALESCE_MS = 16
export const FANOUT_BACKPRESSURE_DROP = 512 * 1024
export const FANOUT_BACKPRESSURE_RECOVER = 64 * 1024
export const FANOUT_BACKPRESSURE_KILL = 4 * 1024 * 1024
export const FANOUT_CONGESTION_KILL_MS = 30 * 1000

export const SHARE_SINK_ID = 'share-sessions'

/** The PtyManager surface the fan-out reads. */
export interface FanoutPty {
  getReplay(paneId: string): { ptyId: string; replay: string; cols: number; rows: number } | null
  getExited(paneId: string): { data: string; cols: number; rows: number; exitCode: number } | null
  setForcedFast(paneIds: Iterable<string>, owner: 'share'): void
}

export interface FanoutDeps<S> {
  pty: FanoutPty
  send(session: S, msg: ShareHostMsg): void
  /** Bytes queued on the session's socket. */
  bufferedAmount(session: S): number
  /** Hard kill (backpressure). */
  terminate(session: S): void
  /** False while the session is paused: no out, no replay. */
  streaming(session: S): boolean
  clock?: ShareClock
  /** Every write to a pty (InputArbiter: the host lease and the last byte). */
  onUserInput?(paneId: string, data: string, origin: PtyInputOrigin): void
  /** A pty spawned or exited (a pane's `running` flipped). */
  onRunningChange?(paneId: string): void
}

interface FanoutState {
  subs: Set<string>
  outBuf: Map<string, string>
  outTimer: ShareTimer | null
  congested: Set<string>
  congestedSince: Map<string, number>
}

/** Cut text into parts of at most `max` UTF-16 units, never between a surrogate pair. */
export function splitShareText(data: string, max: number): string[] {
  if (data.length <= max) return [data]
  const out: string[] = []
  let i = 0
  while (i < data.length) {
    let end = Math.min(data.length, i + max)
    if (end < data.length) {
      const c = data.charCodeAt(end - 1)
      if (c >= 0xd800 && c <= 0xdbff && end - 1 > i) end--
    }
    out.push(data.slice(i, end))
    i = end
  }
  return out
}

const clampCols = (n: number): number => Math.min(SHARE_LIMITS.colsMax, Math.max(SHARE_LIMITS.colsMin, Math.floor(n) || 80))
const clampRows = (n: number): number => Math.min(SHARE_LIMITS.rowsMax, Math.max(SHARE_LIMITS.rowsMin, Math.floor(n) || 24))

export class PaneFanout<S extends object> implements PtySink {
  readonly id = SHARE_SINK_ID
  private readonly paneSubs = new Map<string, Set<S>>()
  private readonly state = new Map<S, FanoutState>()
  private readonly clock: ShareClock

  constructor(private readonly deps: FanoutDeps<S>) {
    this.clock = deps.clock ?? realShareClock
  }

  // --- Subscriptions ---------------------------------------------------------

  sub(session: S, paneId: string): void {
    const st = this.stateOf(session)
    if (st.subs.has(paneId)) return
    // One synchronous block (see the header): replay first, then the sub.
    const replay = this.deps.streaming(session) ? this.deps.pty.getReplay(paneId) : null
    st.subs.add(paneId)
    let set = this.paneSubs.get(paneId)
    if (!set) {
      set = new Set()
      this.paneSubs.set(paneId, set)
    }
    set.add(session)
    if (this.deps.streaming(session)) this.sendReplay(session, paneId, replay)
    this.recomputeForcedFast()
  }

  unsub(session: S, paneId: string): void {
    const st = this.state.get(session)
    if (!st || !st.subs.delete(paneId)) return
    const set = this.paneSubs.get(paneId)
    if (set) {
      set.delete(session)
      if (set.size === 0) this.paneSubs.delete(paneId)
    }
    this.discardPane(st, paneId)
    this.recomputeForcedFast()
  }

  /** Same as unsub + sub for a subscribed pane (the guest renderer's backpressure). */
  resync(session: S, paneId: string): void {
    const st = this.state.get(session)
    if (!st || !st.subs.has(paneId) || !this.deps.streaming(session)) return
    const replay = this.deps.pty.getReplay(paneId)
    this.discardPane(st, paneId)
    this.sendReplay(session, paneId, replay)
  }

  /** Resume after a pause: a fresh replay of every pane the session watches. */
  resyncAll(session: S): void {
    const st = this.state.get(session)
    if (!st) return
    for (const paneId of [...st.subs]) this.resync(session, paneId)
  }

  /** Pause: drop what is buffered for the session (the resume replay carries it). */
  dropPending(session: S): void {
    const st = this.state.get(session)
    if (!st) return
    st.outBuf.clear()
    st.congested.clear()
    st.congestedSince.clear()
  }

  removeSession(session: S): void {
    const st = this.state.get(session)
    if (!st) return
    this.state.delete(session)
    if (st.outTimer !== null) this.clock.clearTimeout(st.outTimer)
    for (const paneId of st.subs) {
      const set = this.paneSubs.get(paneId)
      if (!set) continue
      set.delete(session)
      if (set.size === 0) this.paneSubs.delete(paneId)
    }
    st.subs.clear()
    this.recomputeForcedFast()
  }

  subsOf(session: S): ReadonlySet<string> {
    return this.state.get(session)?.subs ?? new Set()
  }

  isSubscribed(session: S, paneId: string): boolean {
    return this.state.get(session)?.subs.has(paneId) ?? false
  }

  sessionsFor(paneId: string): ReadonlySet<S> {
    return this.paneSubs.get(paneId) ?? new Set()
  }

  /** Panes some guest watches (hibernation keeps them awake). */
  subscribedPaneIds(): Set<string> {
    return new Set(this.paneSubs.keys())
  }

  dispose(): void {
    for (const session of [...this.state.keys()]) this.removeSession(session)
    this.deps.pty.setForcedFast([], 'share')
  }

  // --- PtySink ------------------------------------------------------------------

  onSpawn(_ptyId: string, paneId: string): void {
    const subs = this.paneSubs.get(paneId)
    if (subs && subs.size > 0) {
      // A new pty backs the pane: drop the old pty's bytes, push a fresh replay.
      const replay = this.deps.pty.getReplay(paneId)
      for (const session of subs) {
        const st = this.state.get(session)
        if (!st) continue
        this.discardPane(st, paneId)
        if (this.deps.streaming(session)) this.sendReplay(session, paneId, replay)
      }
      this.recomputeForcedFast()
    }
    this.deps.onRunningChange?.(paneId)
  }

  onData(_ptyId: string, paneId: string, data: string): void {
    const subs = this.paneSubs.get(paneId)
    if (!subs) return
    for (const session of subs) this.bufferOut(session, paneId, data)
  }

  onExit(_ptyId: string, paneId: string, exitCode: number, info: PtyExitInfo): void {
    if (info.current) this.deps.onRunningChange?.(paneId)
    // Only a natural exit of the pane's live pty is reported (mirror of the phone rule).
    if (!info.current || !info.natural) return
    const subs = this.paneSubs.get(paneId)
    if (!subs) return
    for (const session of subs) {
      const st = this.state.get(session)
      if (!st) continue
      this.flushPane(session, st, paneId)
      if (this.deps.streaming(session)) this.deps.send(session, { t: 'exit', paneId, code: Number.isFinite(exitCode) ? exitCode : null })
    }
  }

  onResize(_ptyId: string, paneId: string, cols: number, rows: number): void {
    const subs = this.paneSubs.get(paneId)
    if (!subs) return
    for (const session of subs) {
      const st = this.state.get(session)
      if (!st) continue
      // Bytes laid out for the old size go first.
      this.flushPane(session, st, paneId)
      if (this.deps.streaming(session)) this.deps.send(session, { t: 'fit', paneId, cols: clampCols(cols), rows: clampRows(rows) })
    }
  }

  onUserInput(_ptyId: string, paneId: string, data: string, origin: PtyInputOrigin): void {
    this.deps.onUserInput?.(paneId, data, origin)
  }

  // --- Keepalive + backpressure sweep (ShareHost runs it every 5 s) -------------

  maintenance(): void {
    const now = this.clock.now()
    for (const [session, st] of [...this.state]) {
      const buffered = this.deps.bufferedAmount(session)
      if (buffered > FANOUT_BACKPRESSURE_KILL) {
        this.deps.terminate(session)
        continue
      }
      let killed = false
      for (const since of st.congestedSince.values()) {
        if (now - since > FANOUT_CONGESTION_KILL_MS) {
          this.deps.terminate(session)
          killed = true
          break
        }
      }
      if (killed) continue
      // Recovery: getReplay, THEN discard, THEN send (header).
      if (st.congested.size > 0 && buffered < FANOUT_BACKPRESSURE_RECOVER) {
        for (const paneId of [...st.congested]) {
          const replay = this.deps.pty.getReplay(paneId)
          this.discardPane(st, paneId)
          this.sendReplay(session, paneId, replay)
        }
      }
    }
  }

  // --- Internals ----------------------------------------------------------------

  private stateOf(session: S): FanoutState {
    let st = this.state.get(session)
    if (!st) {
      st = { subs: new Set(), outBuf: new Map(), outTimer: null, congested: new Set(), congestedSince: new Map() }
      this.state.set(session, st)
    }
    return st
  }

  private bufferOut(session: S, paneId: string, data: string): void {
    const st = this.state.get(session)
    if (!st || !this.deps.streaming(session)) return
    st.outBuf.set(paneId, (st.outBuf.get(paneId) ?? '') + data)
    if (st.outTimer === null) st.outTimer = this.clock.setTimeout(() => this.flushOut(session), FANOUT_OUT_COALESCE_MS)
  }

  private flushOut(session: S): void {
    const st = this.state.get(session)
    if (!st) return
    st.outTimer = null
    for (const [paneId, data] of st.outBuf) {
      if (!st.congested.has(paneId)) this.sendOut(session, st, paneId, data)
    }
    st.outBuf.clear()
  }

  private flushPane(session: S, st: FanoutState, paneId: string): void {
    const data = st.outBuf.get(paneId)
    if (data === undefined) return
    st.outBuf.delete(paneId)
    if (!st.congested.has(paneId)) this.sendOut(session, st, paneId, data)
  }

  private discardPane(st: FanoutState, paneId: string): void {
    st.outBuf.delete(paneId)
    st.congested.delete(paneId)
    st.congestedSince.delete(paneId)
  }

  private sendOut(session: S, st: FanoutState, paneId: string, data: string): void {
    if (!data || !this.deps.streaming(session)) return
    for (const part of splitShareText(data, SHARE_LIMITS.outChunkMax)) {
      if (this.deps.bufferedAmount(session) > FANOUT_BACKPRESSURE_DROP) {
        st.congested.add(paneId)
        if (!st.congestedSince.has(paneId)) st.congestedSince.set(paneId, this.clock.now())
        return
      }
      this.deps.send(session, { t: 'out', paneId, data: part })
    }
  }

  private sendReplay(session: S, paneId: string, replay: { replay: string; cols: number; rows: number } | null): void {
    let running = true
    let data = ''
    let cols = 80
    let rows = 24
    let exitCode: number | undefined
    if (replay) {
      data = replay.replay
      cols = replay.cols
      rows = replay.rows
    } else {
      running = false
      // A shell that ended on its own: its last output and exit code.
      const exited = this.deps.pty.getExited(paneId)
      if (exited) {
        data = exited.data
        cols = exited.cols
        rows = exited.rows
        exitCode = exited.exitCode
      }
    }
    const parts = splitShareText(data, SHARE_LIMITS.replayChunkMax)
    parts.forEach((part, i) => {
      this.deps.send(session, {
        t: 'replay',
        paneId,
        running,
        cols: clampCols(cols),
        rows: clampRows(rows),
        ...(exitCode !== undefined && Number.isInteger(exitCode) ? { exitCode } : {}),
        data: part,
        first: i === 0,
        last: i === parts.length - 1,
      })
    })
  }

  private recomputeForcedFast(): void {
    this.deps.pty.setForcedFast(this.paneSubs.keys(), 'share')
  }
}
