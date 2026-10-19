/**
 * Phone-fit ownership (E3 M11, FR-12..23): main decides who owns a pane's
 * size, the renderer applies it. One small state machine per pane:
 *
 *   desktop (no entry) --fitPane--> phone{session, cols, rows, chat}
 *   phone --owner left (unsub without chatSub, chatUnsub without sub, socket
 *           closed) + 250ms grace--> held{cols, rows, since}
 *   held --5 min--> desktop (auto restore)
 *   phone | held --releaseFit, remote:fitRelease, pty exit, server off--> desktop
 *
 * The last phone that sent fitPane wins. A re-sub (or chatSub, FR-21) inside
 * the grace keeps the owner without oscillating, and an owner in Chat runs no
 * timer at all. Restoring is dispatching the `releaseFit` ctl to the renderer
 * executor, which applies the desktop's latest baseline; the resize that
 * follows reaches phones as fitState {owner:'desktop'} (and onReleased covers
 * a baseline equal to the phone size, where no resize happens).
 *
 * Patterned after Orca's mobile presence lock (last actor wins, 250ms grace,
 * restore to the baseline), reimplemented here without its code.
 */
import type { RemoteCommandFit, RemoteCommandResult } from '@shared/ipc-contract'
import type { RemoteCtlAction } from '@shared/remote-protocol'

/** Grace before an owner that left becomes `held` (E3 M11). */
export const FIT_GRACE_MS = 250
/** A held size returns to the desktop on its own after this (E3-FR-19, constant). */
export const FIT_AUTO_RESTORE_MS = 5 * 60 * 1000
/** fitPane bursts per pane are coalesced server-side to the last one. */
export const FIT_COALESCE_MS = 50

export type FitOwner = 'phone' | 'desktop'
export type FitCtlAction = Extract<RemoteCtlAction, { kind: 'fitPane' | 'releaseFit' }>

interface Size {
  cols: number
  rows: number
}

/** Where a phone-owned pane stands. Absent from the map = desktop. */
export type PaneFit =
  | { state: 'phone'; session: object; workspaceId: string; cols: number; rows: number; chat: boolean; baseline: Size | null }
  | { state: 'held'; workspaceId: string; cols: number; rows: number; since: number; baseline: Size | null }

/** What SessionManager reports and asks (wired by RemoteManager). */
export interface FitHooks {
  /** A fitPane / releaseFit ctl from an authenticated session. */
  ctl(session: object, action: FitCtlAction, subscribed: boolean): Promise<RemoteCommandResult>
  /** The session watches the pane again: `sub` (chat false) or `chatSub` (chat true, FR-21). */
  joined(session: object, paneId: string, chat: boolean): void
  /** The session stopped watching the pane: `unsub` or `chatUnsub`. */
  left(session: object, paneId: string): void
  /** The session's socket is gone. */
  closed(session: object): void
  /** The pane's live pty ended (exit, restart, close). */
  paneGone(paneId: string): void
  ownerOf(paneId: string): FitOwner
}

export interface FitControllerDeps {
  /** Relay a ctl to the renderer executor (RemoteManager.executeCommand). */
  dispatch: (action: RemoteCtlAction, fit: RemoteCommandFit) => Promise<RemoteCommandResult>
  /** settings.remote.phoneFit (default true). */
  enabled: () => boolean
  /** Live pty size of a pane, the fallback baseline. */
  sizeOf: (paneId: string) => Size | null
  /** Live pty of a pane, so the executor can resize an unmounted one. */
  ptyIdOf: (paneId: string) => string | null
  /**
   * The desktop took the size back on purpose (not a pty exit): every phone
   * gets fitState desktop, so a phone in phone mode switches to desktop even
   * when the baseline equals its grid (no resize) or it watches another pane.
   */
  onReleased: (paneId: string) => void
  /**
   * The executor applied a fitPane: phones on the pane get fitState phone with
   * the pty size, also when that size was already the pty's (no resize).
   */
  onFitted: (paneId: string) => void
}

interface PendingFit {
  action: Extract<RemoteCtlAction, { kind: 'fitPane' }>
  waiters: Array<(res: RemoteCommandResult) => void>
  timer: ReturnType<typeof setTimeout>
}

/** Executor errors that keep the owner: the renderer is just away (reload, hidden). */
const TRANSIENT = new Set(['timeout', 'desktop_unavailable'])

export class FitController implements FitHooks {
  private readonly panes = new Map<string, PaneFit>()
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly restoreTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pending = new Map<string, PendingFit>()

  constructor(private readonly deps: FitControllerDeps) {}

  // --- FitHooks ---------------------------------------------------------------

  ctl(session: object, action: FitCtlAction, subscribed: boolean): Promise<RemoteCommandResult> {
    if (action.kind === 'releaseFit') return this.release(action.paneId)
    return this.fitPane(session, action, subscribed)
  }

  joined(session: object, paneId: string, chat: boolean): void {
    const st = this.panes.get(paneId)
    if (!st || st.state !== 'phone' || st.session !== session) return
    this.clearGrace(paneId)
    if (st.chat === chat) return
    st.chat = chat
    // The desktop strip says "(Chat)" while the owner reads the chat (FR-21).
    void this.forward(paneId, st)
  }

  left(session: object, paneId: string): void {
    const st = this.panes.get(paneId)
    if (!st || st.state !== 'phone' || st.session !== session || this.graceTimers.has(paneId)) return
    this.graceTimers.set(
      paneId,
      setTimeout(() => {
        this.graceTimers.delete(paneId)
        this.hold(paneId)
      }, FIT_GRACE_MS),
    )
  }

  closed(session: object): void {
    for (const [paneId, st] of this.panes) {
      if (st.state === 'phone' && st.session === session) this.left(session, paneId)
    }
  }

  paneGone(paneId: string): void {
    // No "the PC took it back" for phones: a phone in phone mode re-sends its
    // fitPane on the new pty's replay (E3 M11).
    if (this.panes.has(paneId) || this.pending.has(paneId)) void this.release(paneId, false)
  }

  ownerOf(paneId: string): FitOwner {
    return this.panes.has(paneId) ? 'phone' : 'desktop'
  }

  // --- Commands -------------------------------------------------------------

  /**
   * fitPane from a phone (FR-14/20): refused while phone-fit is off
   * ('disabled') or from a session not subscribed to the pane
   * ('notSubscribed'); otherwise the session owns the pane at once and the
   * executor gets the last fitPane of a 50ms burst.
   */
  fitPane(session: object, action: Extract<RemoteCtlAction, { kind: 'fitPane' }>, subscribed: boolean): Promise<RemoteCommandResult> {
    if (!this.deps.enabled()) return Promise.resolve({ id: '', ok: false, error: 'disabled' })
    if (!subscribed) return Promise.resolve({ id: '', ok: false, error: 'notSubscribed' })
    const { paneId } = action
    const prev = this.panes.get(paneId)
    const baseline = prev ? prev.baseline : this.deps.sizeOf(paneId)
    this.clearTimers(paneId)
    this.panes.set(paneId, {
      state: 'phone',
      session,
      workspaceId: action.workspaceId,
      cols: action.cols,
      rows: action.rows,
      chat: false,
      baseline,
    })
    return new Promise((resolve) => {
      const queued = this.pending.get(paneId)
      if (queued) {
        queued.action = action
        queued.waiters.push(resolve)
        return
      }
      const entry: PendingFit = {
        action,
        waiters: [resolve],
        timer: setTimeout(() => void this.flushPending(paneId), FIT_COALESCE_MS),
      }
      this.pending.set(paneId, entry)
    })
  }

  /**
   * Back to the desktop (FR-18/19/20): the phone's releaseFit, the strip,
   * a real key on the desktop, the auto restore, a pty exit or the server
   * going off. A pane nobody owns answers ok without a round trip.
   */
  release(paneId: string, notify = true): Promise<RemoteCommandResult> {
    const st = this.panes.get(paneId)
    const queued = this.pending.get(paneId)
    this.panes.delete(paneId)
    this.clearTimers(paneId)
    if (queued) {
      clearTimeout(queued.timer)
      this.pending.delete(paneId)
      // A fit superseded by a release: it did take effect, then gave way.
      for (const w of queued.waiters) w({ id: '', ok: true })
    }
    if (!st && !queued) return Promise.resolve({ id: '', ok: true })
    const fit: RemoteCommandFit = {}
    const ptyId = this.deps.ptyIdOf(paneId)
    if (ptyId) fit.ptyId = ptyId
    const baseline = st?.baseline ?? null
    if (baseline) fit.baseline = { cols: baseline.cols, rows: baseline.rows }
    return this.deps.dispatch({ kind: 'releaseFit', paneId }, fit).then((res) => {
      if (notify) this.deps.onReleased(paneId)
      return res
    })
  }

  /** "Restore all" and the server going off: every owned or held pane. */
  releaseAll(): Promise<RemoteCommandResult[]> {
    const ids = new Set([...this.panes.keys(), ...this.pending.keys()])
    return Promise.all([...ids].map((id) => this.release(id)))
  }

  /** After a renderer reload (FR-23): the executor learns every owned pane again. */
  refitAll(): void {
    for (const [paneId, st] of this.panes) void this.forward(paneId, st)
  }

  /** Stop every timer without dispatching (app quit). */
  dispose(): void {
    for (const t of this.graceTimers.values()) clearTimeout(t)
    for (const t of this.restoreTimers.values()) clearTimeout(t)
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.graceTimers.clear()
    this.restoreTimers.clear()
    this.pending.clear()
    this.panes.clear()
  }

  /** Read-only view of one pane, for tests and diagnostics. */
  stateOf(paneId: string): PaneFit | null {
    return this.panes.get(paneId) ?? null
  }

  /** True while the owner reads the pane as Chat (FR-21). */
  chatOf(paneId: string): boolean {
    const st = this.panes.get(paneId)
    return st?.state === 'phone' && st.chat
  }

  // --- Internals ------------------------------------------------------------

  private async flushPending(paneId: string): Promise<void> {
    const queued = this.pending.get(paneId)
    if (!queued) return
    this.pending.delete(paneId)
    const st = this.panes.get(paneId)
    let res: RemoteCommandResult
    if (!st) {
      res = { id: '', ok: true }
    } else {
      res = await this.deps.dispatch(queued.action, this.fitExtra(paneId, st))
      if (res.ok) {
        if (this.panes.get(paneId) === st) this.deps.onFitted(paneId)
      } else if (!TRANSIENT.has(res.error ?? '') && this.panes.get(paneId) === st) {
        // A pane the desktop does not know (closed, stale phone): nothing to hold.
        this.panes.delete(paneId)
        this.clearTimers(paneId)
      }
    }
    for (const w of queued.waiters) w(res)
  }

  /** Re-sends the current owner geometry to the executor (chat flag, reload). */
  private forward(paneId: string, st: PaneFit): Promise<RemoteCommandResult> {
    return this.deps.dispatch(
      { kind: 'fitPane', workspaceId: st.workspaceId, paneId, cols: st.cols, rows: st.rows },
      this.fitExtra(paneId, st),
    )
  }

  private fitExtra(paneId: string, st: PaneFit): RemoteCommandFit {
    const fit: RemoteCommandFit = {}
    const ptyId = this.deps.ptyIdOf(paneId)
    if (ptyId) fit.ptyId = ptyId
    if (st.state === 'phone' && st.chat) fit.chat = true
    return fit
  }

  private hold(paneId: string): void {
    const st = this.panes.get(paneId)
    if (!st || st.state !== 'phone') return
    const held: PaneFit = { state: 'held', workspaceId: st.workspaceId, cols: st.cols, rows: st.rows, since: Date.now(), baseline: st.baseline }
    this.panes.set(paneId, held)
    // The strip loses "(Chat)": nobody is reading the chat anymore.
    if (st.chat) void this.forward(paneId, held)
    this.restoreTimers.set(
      paneId,
      setTimeout(() => {
        this.restoreTimers.delete(paneId)
        if (this.panes.get(paneId)?.state === 'held') void this.release(paneId)
      }, FIT_AUTO_RESTORE_MS),
    )
  }

  private clearGrace(paneId: string): void {
    const t = this.graceTimers.get(paneId)
    if (t) clearTimeout(t)
    this.graceTimers.delete(paneId)
  }

  private clearTimers(paneId: string): void {
    this.clearGrace(paneId)
    const t = this.restoreTimers.get(paneId)
    if (t) clearTimeout(t)
    this.restoreTimers.delete(paneId)
  }
}
