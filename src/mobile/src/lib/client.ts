/**
 * The phone's WebSocket connection state machine. Owns the socket, runs the
 * mutual challenge-response auth, drives reconnection, and fans terminal frames
 * out to the mounted RemoteTerminal. It mutates the zustand store for React and
 * exposes imperative methods components call for actions.
 *
 * State flow (auth path):   connecting -> challenge(verify proof) -> auth -> authOk(live)
 * State flow (pair path):   pairForm -> hello+pair -> pairPending -> paired -> authOk(live)
 *
 * Security-critical invariants:
 *  - On `challenge` the client verifies the server's proof (HMAC(secret,
 *    clientNonce)) BEFORE sending its own HMAC. A mismatch aborts the socket
 *    and shows the impostor screen; nothing is sent to an unproven server.
 *  - Only close code 4403 (REVOKED) wipes the stored secret. 4401 keeps it and
 *    asks to re-pair (a different desktop instance may have answered).
 *
 * Connection reliability (E1-FR-10..15, 41):
 *  - Every socket carries a generation number and each handler bails unless its
 *    generation is current, so a late onclose of an aborted socket can never
 *    null out or reschedule its successor. Forced closes (liveness, revive
 *    probe, Retry, connect timeout) go through abortSocket(), which detaches the
 *    handlers instead of waiting for an onclose a dead TCP may never deliver.
 *  - Liveness: 20s without an inbound frame while visible sends a ping, and
 *    every ping arms a pong deadline measured with performance.now(). Deadlines
 *    never span a hidden interval (iOS suspends JS and fires stale timers late).
 *  - Revive triggers (visible, pageshow, online) probe an OPEN socket with a 3s
 *    deadline and re-sync the viewed pane on the pong after a long absence.
 *  - A desktop on another version than this bundle parks the client on phase
 *    'updated' with the socket closed and every reconnect path disabled.
 */
import {
  PROTOCOL_VERSION,
  REMOTE_CLOSE,
  type RemoteClientMsg,
  type RemoteCtlAction,
  type RemoteServerMsg,
  type RemoteStateSnapshot,
} from '@shared/remote-protocol'
import { BRAND } from '@shared/brand'
import {
  clearAuth,
  getStoredAuth,
  getStoredHostPlatform,
  randomNonceHex,
  storeAuth,
  storeHostPlatform,
} from './auth'
import { hexEqual, hexToBytes, hmacSha256Hex } from './sha256'
import { store, type UpdateInfo } from './store'
import { applyRemoteTheme } from './theme'
import { setLang } from './i18n'
import { delayFor } from './reconnectSchedule'

/** A frame handed to the live terminal. */
export type TermFrame =
  | { type: 'replay'; data: string; cols: number; rows: number; running: boolean; exitCode?: number }
  | { type: 'out'; data: string }
  | { type: 'exit'; exitCode: number }

/** Result of a control request, resolved by the matching ctlAck (or a timeout). */
export interface CtlResult {
  ok: boolean
  error?: string
  paneId?: string
  info?: number
}

/** Fixed keepalive; the server drops a session after 60s of silence. */
export const PING_INTERVAL = 25000
/** Idle time (visible page) before an extra liveness ping (FR-10). */
export const IDLE_PROBE_MS = 20000
/** Pong deadline for keepalive and idle pings (FR-10). */
export const PONG_TIMEOUT = 8000
/** Pong deadline for the probe sent when the page revives (FR-11). */
export const REVIVE_PROBE_TIMEOUT = 3000
/** new WebSocket -> authOk/pairPending/authFail/pairDenied budget (FR-41). */
export const CONNECT_TIMEOUT_MS = 8000
/** Hidden longer than this re-syncs the viewed pane on revive (FR-11). */
export const RESYNC_HIDDEN_MS = 10000
/** A deadline timer this late means JS was suspended: re-probe, never abort. */
const SUSPEND_SLACK_MS = 2000
const CTL_TIMEOUT = 10000
const PAIR_PENDING_MS = 60000
/** sessionStorage guard against a reload loop on a stale cached bundle (FR-15). */
export const RELOAD_FOR_KEY = `${BRAND.mobileStoragePrefix}reloadFor`

/** This bundle's version, baked in by vite.config.ts. */
const BUNDLE_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

/** A version string worth comparing (dev builds and unknowns never mismatch). */
function comparableVersion(v: string | undefined): v is string {
  return !!v && v !== 'dev'
}

function perfNow(): number {
  return performance.now()
}

function pageVisible(): boolean {
  return document.visibilityState === 'visible'
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/** Read the one-time pairing code from the URL fragment (#pair=CODE). */
function readPairCode(): string | null {
  const m = location.hash.match(/pair=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

/** Width table for the terminal: only an explicit '11' opts in (E6-FR-15). */
function unicodeOf(snap: RemoteStateSnapshot): '6' | '11' {
  return snap.terminalUnicode === '11' ? '11' : '6'
}

/** Pick a sensible pane to view in a workspace: a running one, else the first. */
function pickPane(snap: RemoteStateSnapshot, workspaceId: string | null): string | null {
  const ws = snap.workspaces.find((w) => w.id === workspaceId) ?? snap.workspaces[0]
  if (!ws || ws.panes.length === 0) return null
  const running = ws.panes.find((p) => p.running)
  if (running) return running.id
  const firstOrdered = ws.layoutOrder.find((id) => ws.panes.some((p) => p.id === id))
  return firstOrdered ?? ws.panes[0].id
}

function paneExists(snap: RemoteStateSnapshot, paneId: string): boolean {
  return snap.workspaces.some((w) => w.panes.some((p) => p.id === paneId))
}

function workspaceOfPane(snap: RemoteStateSnapshot, paneId: string): string | null {
  const ws = snap.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
  return ws ? ws.id : null
}

class RemoteClient {
  private ws: WebSocket | null = null
  /** Bumped by every connect() and abortSocket(); stale handlers compare and bail. */
  private gen = 0
  /** The current socket reached authOk (or the pairing path's first state). */
  private socketAuthed = false
  private mode: 'auth' | 'pair' | 'idle' = 'idle'
  private deviceId: string | null = null
  // HMAC key = the device secret hex-DECODED to its raw 32 bytes. This matches
  // the server's createHmac('sha256', Buffer.from(secretHex, 'hex')). The
  // message (a nonce) is passed as its literal hex STRING (hashed as UTF-8) on
  // both sides. Encoding the key as the hex string's UTF-8 bytes breaks auth.
  private secretKey: Uint8Array | null = null
  private clientNonce = ''
  private pairCode: string | null = null
  private pairDeviceName = ''

  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private manualClose = false
  private noReconnect = false
  private started = false
  /** "Continue anyway" on the updated screen; lasts for this page only (FR-15). */
  private ignoreVersionMismatch = false

  // Liveness (FR-10/11). All perf-clock values are performance.now() ms.
  private lastInboundAt = 0
  private lastInboundWall = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private pingSentAt = 0
  private deadlineMs = 0
  /** When the page last went hidden (perf clock), null while visible. */
  private hiddenAt: number | null = null
  /** Most recent hide (perf clock), kept after revive to discard spanning deadlines. */
  private lastHiddenAt: number | null = null
  /** Re-sync the viewed pane when the revive probe's pong arrives. */
  private resyncOnPong = false

  private pendingCtl = new Map<string, { resolve: (r: CtlResult) => void; timer: ReturnType<typeof setTimeout> }>()
  private termListener: ((f: TermFrame) => void) | null = null
  // Frames that arrived before the terminal mounted (the authOk -> first React
  // render gap). Buffered so the initial replay/out is never lost; a replay
  // supersedes and resets the buffer since it repaints the whole screen.
  private frameBuffer: TermFrame[] = []

  /** Boot the client from stored auth or a pairing code. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true

    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pageshow', this.onPageShow)
    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
    if (!pageVisible()) this.hiddenAt = this.lastHiddenAt = perfNow()
    store.getState().update({ online: browserOnline() })

    const auth = getStoredAuth()
    const code = readPairCode()
    if (auth) {
      this.mode = 'auth'
      this.deviceId = auth.deviceId
      this.secretKey = hexToBytes(auth.secretHex)
      store.getState().update({ phase: 'connecting' })
      this.connect()
    } else if (code) {
      this.mode = 'pair'
      this.pairCode = code
      store.getState().update({ phase: 'pairForm' })
    } else {
      this.mode = 'idle'
      store.getState().update({ phase: 'welcome' })
    }
  }

  /**
   * Enter pairing mode from inside the app (in-app QR scan or manual code).
   * Needed by installed home-screen apps: scanning the QR with the OS camera
   * opens the URL in the browser, a different storage origin, so pairing must
   * be reachable without the #pair= boot fragment. Resets any auth/reconnect
   * state so the next socket runs the pair path exactly like a #pair= boot.
   */
  startPairing(code: string): void {
    this.clearReconnectTimer()
    this.abortSocket()
    this.mode = 'pair'
    this.pairCode = code
    this.deviceId = null
    this.secretKey = null
    this.noReconnect = false
    this.reconnectAttempt = 0
    store.getState().update({ phase: 'pairForm', banner: null, pairReason: null, pairExpiresAt: null, connAttempt: 0 })
  }

  /** Submit the pairing form: open the socket and request pairing. */
  submitPairing(deviceName: string): void {
    if (this.mode !== 'pair') return
    this.pairDeviceName = deviceName
    store.getState().update({ phase: 'connecting' })
    this.connect()
  }

  /** Manual reconnect (retry button on the locked/connecting screens). */
  retry(): void {
    this.clearReconnectTimer()
    // A lingering socket would make connect() a no-op and the button dead.
    this.abortSocket()
    this.noReconnect = false
    this.reconnectAttempt = 0
    store.getState().update({ phase: this.deviceId ? 'connecting' : 'welcome', banner: null, lockUntil: null, connAttempt: 0 })
    if (this.deviceId) this.connect()
  }

  /**
   * "Retry" on the connection banner (FR-13): abort whatever socket exists (OPEN
   * or still CONNECTING), cancel the backoff timer, reset the attempt counter and
   * connect right away. Never touches phase, so the live screen stays up.
   */
  reconnectNow(): void {
    if (store.getState().phase === 'updated') return
    if (!this.deviceId) return
    this.clearReconnectTimer()
    this.abortSocket()
    this.noReconnect = false
    this.reconnectAttempt = 0
    this.showReconnecting()
    this.connect()
  }

  /** "Continue anyway" on the updated screen (FR-15, mismatch case only). */
  continueAnyway(): void {
    const s = store.getState()
    if (s.phase !== 'updated' || s.updateInfo?.kind !== 'mismatch') return
    this.ignoreVersionMismatch = true
    this.noReconnect = false
    this.manualClose = false
    s.update({ phase: 'connecting', updateInfo: null })
    this.reconnectNow()
  }

  /** Forget this origin's device and reload to a clean state. */
  unpair(): void {
    clearAuth()
    this.clearReconnectTimer()
    this.abortSocket()
    location.reload()
  }

  /** An authenticated socket is OPEN, so input and control frames get delivered. */
  isOpen(): boolean {
    return this.socketAuthed && this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /** Register the live terminal's frame handler (RemoteTerminal on mount). */
  setTermListener(cb: ((f: TermFrame) => void) | null): void {
    this.termListener = cb
    if (cb && this.frameBuffer.length) {
      const buffered = this.frameBuffer
      this.frameBuffer = []
      for (const f of buffered) cb(f)
    }
  }

  /**
   * Send keystrokes/paste data to the currently-viewed pane. Returns false (and
   * sends nothing) without an open authenticated socket (FR-14), so callers can
   * keep the text instead of losing it.
   */
  sendInput(data: string): boolean {
    const paneId = store.getState().subscribedPaneId
    if (!paneId || !this.isOpen()) return false
    return this.send({ v: PROTOCOL_VERSION, type: 'input', paneId, data })
  }

  /** Switch the viewed pane within the current workspace (unsub old, sub new). */
  viewPane(paneId: string): void {
    const s = store.getState()
    if (s.subscribedPaneId === paneId) {
      s.update({ activePaneId: paneId })
      return
    }
    if (s.subscribedPaneId) this.send({ v: PROTOCOL_VERSION, type: 'unsub', paneId: s.subscribedPaneId })
    this.send({ v: PROTOCOL_VERSION, type: 'sub', paneId })
    s.update({ activePaneId: paneId, subscribedPaneId: paneId })
  }

  /**
   * Ask for a fresh replay of the viewed pane. The server ignores a repeated
   * `sub` for a pane it already streams, so this sends `unsub` then `sub`:
   * handleUnsub drops the buffer and handleSub answers with a new replay.
   */
  resyncPane(): void {
    const paneId = store.getState().subscribedPaneId
    if (!paneId || !this.isOpen()) return
    this.send({ v: PROTOCOL_VERSION, type: 'unsub', paneId })
    this.send({ v: PROTOCOL_VERSION, type: 'sub', paneId })
  }

  /**
   * Switch to a pane that may live in another workspace: ask the desktop to
   * switch workspace first (which triggers any lazy spawns), then subscribe. A
   * not-yet-running pane shows a spinner until the server pushes its replay.
   */
  async switchWorkspaceAndView(workspaceId: string, paneId: string): Promise<void> {
    const snap = store.getState().snapshot
    const needsSwitch = snap ? workspaceOfPane(snap, paneId) !== snap.activeWorkspaceId : true
    if (needsSwitch) await this.sendCtl({ kind: 'switchWorkspace', workspaceId })
    this.viewPane(paneId)
  }

  /** Send a control request and await its ack (10s local timeout). */
  sendCtl(action: RemoteCtlAction): Promise<CtlResult> {
    const id = randomNonceHex(8)
    return new Promise<CtlResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCtl.delete(id)
        resolve({ ok: false, error: 'timeout' })
      }, CTL_TIMEOUT)
      this.pendingCtl.set(id, { resolve, timer })
      this.send({ v: PROTOCOL_VERSION, type: 'ctl', id, action })
    })
  }

  // --- page lifecycle (FR-10/11) ---

  private onVisibility = (): void => {
    if (pageVisible()) {
      this.onRevive('visible')
      return
    }
    // Hidden: iOS suspends JS and fires stale timers on resume, so liveness
    // checks stop here. The fixed 25s keepalive keeps running.
    this.hiddenAt = this.lastHiddenAt = perfNow()
    this.clearIdleWatchdog()
    this.clearDeadline()
  }

  private onPageShow = (ev: PageTransitionEvent): void => {
    this.onRevive('pageshow', ev.persisted === true)
  }

  private onOnline = (): void => {
    this.onRevive('online')
  }

  private onOffline = (): void => {
    store.getState().update({ online: false })
    // No attempts while the phone itself has no network; 'online' resumes.
    this.clearReconnectTimer()
  }

  /**
   * The page came back (visible, bfcache restore) or the network returned.
   * Probe an OPEN socket instead of trusting it; reconnect at once otherwise.
   */
  private onRevive(trigger: 'visible' | 'pageshow' | 'online', persisted = false): void {
    const t = perfNow()
    const hiddenFor = this.hiddenAt != null ? t - this.hiddenAt : 0
    if (trigger === 'visible') this.hiddenAt = null
    const online = browserOnline()
    if (store.getState().online !== online) store.getState().update({ online })

    const phase = store.getState().phase
    if (phase === 'updated') return
    if (phase !== 'live' && phase !== 'connecting') return
    if (this.mode === 'idle' || (this.mode === 'pair' && !this.deviceId)) return
    if (!online) return

    this.lastInboundAt = t
    const wantResync = hiddenFor > RESYNC_HIDDEN_MS || trigger === 'online' || (trigger === 'pageshow' && persisted)
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!pageVisible()) return
      if (wantResync && this.socketAuthed) this.resyncOnPong = true
      // The probe replaces any pending deadline: its base was just reset.
      this.clearDeadline()
      this.sendPing(REVIVE_PROBE_TIMEOUT)
      this.armIdleWatchdog()
      return
    }
    // CONNECTING is covered by the connect timeout and CLOSING by its onclose.
    if (ws && ws.readyState !== WebSocket.CLOSED) return
    if (ws) {
      // CLOSED with no onclose delivered (the browser sets readyState and fires
      // close in one task, so a bfcache restore or a freeze swallowed it): no
      // timer covers this socket any more, so drop it here.
      this.abortSocket()
      if (this.noReconnect) return
      this.reconnectAttempt = 0
      this.showReconnecting()
    }
    if (this.noReconnect) return
    this.clearReconnectTimer()
    this.connect()
  }

  // --- liveness (FR-10) ---

  private noteInbound(): void {
    this.lastInboundAt = perfNow()
    this.lastInboundWall = Date.now()
    this.clearDeadline()
    this.armIdleWatchdog()
  }

  private armIdleWatchdog(): void {
    if (this.idleTimer || !this.socketAuthed || !pageVisible()) return
    const wait = Math.max(0, IDLE_PROBE_MS - (perfNow() - this.lastInboundAt))
    this.idleTimer = setTimeout(this.onIdleTimer, wait)
  }

  private onIdleTimer = (): void => {
    this.idleTimer = undefined
    if (!this.isOpen() || !pageVisible()) return
    if (perfNow() - this.lastInboundAt < IDLE_PROBE_MS) {
      this.armIdleWatchdog()
      return
    }
    // The pong (or any frame) re-arms the watchdog; silence trips the deadline.
    this.sendPing(PONG_TIMEOUT)
  }

  private clearIdleWatchdog(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private sendPing(deadlineMs: number): void {
    if (!this.send({ v: PROTOCOL_VERSION, type: 'ping', t: Date.now() })) return
    if (pageVisible()) this.armDeadline(deadlineMs)
  }

  /** Arm a pong deadline; an already-pending stricter one wins. */
  private armDeadline(ms: number): void {
    const t = perfNow()
    if (this.deadlineTimer) {
      if (this.pingSentAt + this.deadlineMs - t <= ms) return
      clearTimeout(this.deadlineTimer)
    }
    this.pingSentAt = t
    this.deadlineMs = ms
    this.deadlineTimer = setTimeout(this.onDeadline, ms)
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = undefined
  }

  private onDeadline = (): void => {
    this.deadlineTimer = undefined
    if (!pageVisible() || !this.ws) return
    // Any frame since the ping proves the socket alive.
    if (this.lastInboundAt > this.pingSentAt) return
    // A deadline that spans a hidden interval measures the suspension, not the link.
    if (this.lastHiddenAt != null && this.lastHiddenAt >= this.pingSentAt) return
    const elapsed = perfNow() - this.pingSentAt
    if (elapsed < this.deadlineMs - 50) {
      this.deadlineTimer = setTimeout(this.onDeadline, this.deadlineMs - elapsed)
      return
    }
    if (elapsed > this.deadlineMs + SUSPEND_SLACK_MS && this.ws.readyState === WebSocket.OPEN) {
      // Fired far too late: JS was frozen without a visibilitychange. Probe again.
      this.sendPing(REVIVE_PROBE_TIMEOUT)
      return
    }
    // Dead link: abort without waiting for onclose and reconnect now, no backoff.
    this.abortSocket()
    this.clearReconnectTimer()
    this.reconnectAttempt = 0
    this.showReconnecting()
    this.connect()
  }

  // --- socket ---

  private send(msg: RemoteClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg))
        return true
      } catch {
        /* socket dying; liveness or onclose will drive recovery */
      }
    }
    return false
  }

  private connect(): void {
    if (this.ws) return
    if (store.getState().phase === 'updated') return
    if (!browserOnline()) {
      // No attempt while the phone is offline (FR-11); the 'online' event resumes.
      store.getState().update({ online: false })
      return
    }
    this.noReconnect = false
    // Any manualClose belonged to a socket whose handlers are already detached.
    this.manualClose = false
    const myGen = ++this.gen
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://${location.host}/ws`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.socketAuthed = false
    ws.onopen = () => {
      if (myGen !== this.gen) return
      this.onOpen()
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (myGen !== this.gen) return
      this.onMessage(ev)
    }
    ws.onclose = (ev: CloseEvent) => {
      if (myGen !== this.gen) return
      this.onClose(ev)
    }
    ws.onerror = () => {
      /* onclose always follows; recovery happens there */
    }
    this.clearConnectTimer()
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      if (myGen !== this.gen) return
      this.abortSocket()
      this.afterDrop()
    }, CONNECT_TIMEOUT_MS)
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  /** Stop every timer bound to the current socket. */
  private stopSocketTimers(): void {
    this.clearConnectTimer()
    this.stopKeepalive()
    this.clearIdleWatchdog()
    this.clearDeadline()
    this.resyncOnPong = false
  }

  /** Record the end of an authenticated socket for the banner. */
  private noteDropped(): void {
    if (!this.socketAuthed) return
    this.socketAuthed = false
    store.getState().update({ connected: false, lastConnectedAt: this.lastInboundWall || Date.now() })
  }

  /**
   * Force-close the current socket without waiting for onclose (FR-41): detach
   * its handlers, close it, drop the reference and stop its timers. The caller
   * decides what follows (connect now, schedule a retry, or nothing).
   */
  private abortSocket(): void {
    const ws = this.ws
    this.gen++
    this.ws = null
    this.stopSocketTimers()
    this.noteDropped()
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }

  private onOpen(): void {
    this.clientNonce = randomNonceHex(32)
    const hello: RemoteClientMsg =
      this.deviceId != null
        ? { v: PROTOCOL_VERSION, type: 'hello', deviceId: this.deviceId, clientNonce: this.clientNonce }
        : { v: PROTOCOL_VERSION, type: 'hello', clientNonce: this.clientNonce }
    this.send(hello)
    if (this.mode === 'pair' && this.pairCode) {
      this.send({ v: PROTOCOL_VERSION, type: 'pair', code: this.pairCode, deviceName: this.pairDeviceName })
    }
  }

  private onMessage(ev: MessageEvent): void {
    let msg: RemoteServerMsg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as RemoteServerMsg
    } catch {
      return
    }
    this.noteInbound()
    switch (msg.type) {
      case 'challenge':
        this.handleChallenge(msg)
        break
      case 'pairPending':
        // The legitimate approval wait can reach 60s: the connect timeout ends here.
        this.clearConnectTimer()
        store.getState().update({ phase: 'pairPending', pairExpiresAt: Date.now() + PAIR_PENDING_MS })
        break
      case 'paired':
        this.handlePaired(msg)
        break
      case 'pairDenied':
        this.clearConnectTimer()
        this.manualClose = true
        store.getState().update({ phase: 'pairDenied', pairReason: msg.reason })
        break
      case 'authOk':
        this.handleAuthOk(msg)
        break
      case 'authFail':
        this.handleAuthFail(msg)
        break
      case 'state':
        this.handleState(msg.state)
        break
      case 'replay':
        if (msg.paneId === store.getState().subscribedPaneId) {
          this.emit({ type: 'replay', data: msg.data, cols: msg.cols, rows: msg.rows, running: msg.running, exitCode: msg.exitCode })
        }
        break
      case 'out':
        if (msg.paneId === store.getState().subscribedPaneId) this.emit({ type: 'out', data: msg.data })
        break
      case 'exit':
        if (msg.paneId === store.getState().subscribedPaneId) this.emit({ type: 'exit', exitCode: msg.exitCode })
        break
      case 'ctlAck':
        this.handleCtlAck(msg)
        break
      case 'revoked':
        store.getState().update({ phase: 'revoked' })
        break
      case 'shutdown':
        if (msg.reason === 'disabled') {
          this.noReconnect = true
          store.getState().update({ banner: { kind: 'disabled' } })
        } else {
          // Sticky until the next authOk; the reconnect attempts count beside it.
          store.getState().update({ banner: { kind: 'desktopGone' } })
        }
        break
      case 'pong':
        if (this.resyncOnPong) {
          this.resyncOnPong = false
          if (store.getState().phase === 'live') this.resyncPane()
        }
        break
      case 'err':
        // A protocol mismatch means the desktop runs another build (FR-15). The
        // server answers every frame with it and never closes, so park here.
        // rate/unauthorized/bad_msg: nothing actionable beyond the eventual close.
        if (msg.code === 'version' && store.getState().phase !== 'updated') this.enterUpdated('protocol', '')
        break
    }
  }

  private handleChallenge(msg: Extract<RemoteServerMsg, { type: 'challenge' }>): void {
    if (!this.secretKey || !this.deviceId) {
      // No secret but got a challenge (should not happen in the pair path).
      this.abort('impostor')
      return
    }
    // Mutual auth: the server must prove it knows our secret first.
    const expected = hmacSha256Hex(this.secretKey, this.clientNonce)
    if (!msg.proof || !hexEqual(expected, msg.proof)) {
      this.abort('impostor')
      return
    }
    const hmac = hmacSha256Hex(this.secretKey, msg.nonce)
    this.send({ v: PROTOCOL_VERSION, type: 'auth', deviceId: this.deviceId, hmac })
  }

  private handlePaired(msg: Extract<RemoteServerMsg, { type: 'paired' }>): void {
    storeAuth(msg.deviceId, msg.secret)
    this.deviceId = msg.deviceId
    this.secretKey = hexToBytes(msg.secret)
    this.mode = 'auth'
    // Strip #pair from the URL so a manual refresh reconnects via the auth path.
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      /* ignore */
    }
    // The server follows 'paired' with a full authOk on this same socket
    // (SessionManager.deliverPairResult), so the phone goes live through the
    // same path as a reconnect. Show a brief connecting state until it lands;
    // handleState still covers a desktop that only pushes a 'state' frame.
    store.getState().update({ phase: 'connecting', pairExpiresAt: null })
  }

  /**
   * Adopt a state snapshot as the live screen: apply theme/lang, pick a pane and
   * subscribe, start keepalive. Shared by the authOk path (with hostPlatform/
   * appVersion) and a bare first 'state' frame (without).
   */
  private goLive(state: RemoteStateSnapshot, hostPlatform: string, appVersion: string): void {
    setLang(state.language)
    const xtermTheme = applyRemoteTheme(state.themeTokens)
    this.clearConnectTimer()
    this.socketAuthed = true
    this.reconnectAttempt = 0
    const cur = store.getState().activePaneId
    const keep = cur && paneExists(state, cur) ? cur : pickPane(state, state.activeWorkspaceId)
    store.getState().update({
      phase: 'live',
      banner: null,
      connAttempt: 0,
      connected: true,
      updateInfo: null,
      snapshot: state,
      xtermTheme,
      terminalUnicode: unicodeOf(state),
      hostPlatform,
      appVersion,
      pairExpiresAt: null,
      // Force viewPane below to (re)issue a sub even on reconnect to the same pane.
      subscribedPaneId: null,
      activePaneId: keep ?? null,
    })
    this.startKeepalive()
    this.armIdleWatchdog()
    if (keep) this.viewPane(keep)
  }

  private handleAuthOk(msg: Extract<RemoteServerMsg, { type: 'authOk' }>): void {
    this.clearConnectTimer()
    // Persist the host platform so future sessions (incl. the pairing path, which
    // never learns it) can still enable windowsPty on Windows desktops.
    storeHostPlatform(msg.hostPlatform)
    // FR-15: a cached old bundle talking to an updated desktop must not go live.
    if (
      !this.ignoreVersionMismatch &&
      comparableVersion(msg.appVersion) &&
      comparableVersion(BUNDLE_VERSION) &&
      msg.appVersion !== BUNDLE_VERSION
    ) {
      this.enterUpdated('mismatch', msg.appVersion)
      return
    }
    try {
      sessionStorage.removeItem(RELOAD_FOR_KEY)
    } catch {
      /* ignore */
    }
    this.goLive(msg.state, msg.hostPlatform, msg.appVersion)
  }

  /**
   * Park on the 'updated' screen (FR-15): cancel every timer, close the socket
   * for good (manualClose + noReconnect) and never go live. handleState,
   * scheduleReconnect, connect and the revive triggers all no-op meanwhile.
   */
  private enterUpdated(kind: UpdateInfo['kind'], to: string): void {
    const guard = to || kind
    let retried = false
    try {
      retried = sessionStorage.getItem(RELOAD_FOR_KEY) === guard
      sessionStorage.setItem(RELOAD_FOR_KEY, guard)
    } catch {
      /* storage blocked: no loop guard, the screen still works */
    }
    this.clearReconnectTimer()
    this.manualClose = true
    this.noReconnect = true
    this.abortSocket()
    store.getState().update({
      phase: 'updated',
      updateInfo: { from: BUNDLE_VERSION, to, kind, retried },
      banner: null,
      connAttempt: 0,
      connected: false,
    })
  }

  private handleAuthFail(msg: Extract<RemoteServerMsg, { type: 'authFail' }>): void {
    this.clearConnectTimer()
    this.manualClose = true
    if (msg.reason === 'locked') {
      const lockUntil = Date.now() + (msg.retryAfterMs ?? 30000)
      store.getState().update({ phase: 'locked', lockUntil })
    } else {
      // unknownDevice / badHmac: re-pair, but keep the secret (only 4403 wipes it).
      store.getState().update({ phase: 'rePair', authFailReason: msg.reason })
    }
  }

  private handleState(state: RemoteStateSnapshot): void {
    const phase = store.getState().phase
    // A state frame racing the close must not pull the phone off the updated screen.
    if (phase === 'updated') return
    // A bare first 'state' (no preceding authOk) is what takes us live.
    if (phase !== 'live') {
      this.goLive(state, getStoredHostPlatform(), store.getState().appVersion)
      return
    }
    setLang(state.language)
    const xtermTheme = applyRemoteTheme(state.themeTokens)
    store.getState().update({ snapshot: state, xtermTheme, terminalUnicode: unicodeOf(state) })
    // If the viewed pane vanished (closed on desktop), fall back to another.
    const cur = store.getState().activePaneId
    if (!cur || !paneExists(state, cur)) {
      const next = pickPane(state, state.activeWorkspaceId)
      if (next) this.viewPane(next)
      else store.getState().update({ activePaneId: null, subscribedPaneId: null })
    }
  }

  private handleCtlAck(msg: Extract<RemoteServerMsg, { type: 'ctlAck' }>): void {
    const pending = this.pendingCtl.get(msg.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingCtl.delete(msg.id)
    pending.resolve({ ok: msg.ok, error: msg.error, paneId: msg.paneId, info: msg.info })
  }

  private emit(frame: TermFrame): void {
    if (this.termListener) {
      this.termListener(frame)
      return
    }
    // No terminal mounted yet: buffer so nothing is lost. A replay resets the
    // buffer (it supersedes prior output); other frames append under a cap.
    if (frame.type === 'replay') {
      this.frameBuffer = [frame]
    } else {
      this.frameBuffer.push(frame)
      if (this.frameBuffer.length > 1000) this.frameBuffer.shift()
    }
  }

  private abort(phase: 'impostor'): void {
    this.clearReconnectTimer()
    this.noReconnect = true
    this.abortSocket()
    store.getState().update({ phase })
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.pingTimer = setInterval(() => {
      this.sendPing(PONG_TIMEOUT)
    }, PING_INTERVAL)
  }

  private stopKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private onClose(ev: CloseEvent): void {
    this.ws = null
    this.stopSocketTimers()
    this.noteDropped()

    if (this.manualClose) {
      this.manualClose = false
      return
    }

    if (ev.code === REMOTE_CLOSE.REVOKED) {
      clearAuth()
      this.secretKey = null
      this.deviceId = null
      store.getState().update({ phase: 'revoked', banner: null })
      return
    }
    if (ev.code === REMOTE_CLOSE.UNKNOWN_DEVICE) {
      store.getState().update({ phase: 'rePair', banner: null })
      return
    }
    if (ev.code === REMOTE_CLOSE.RATE_LIMITED) {
      const lockUntil = Date.now() + 30000
      store.getState().update({ phase: 'locked', lockUntil })
      return
    }
    this.afterDrop()
  }

  /** What follows an unexpected drop (onclose or a connect timeout). */
  private afterDrop(): void {
    const phase = store.getState().phase
    if (
      phase === 'impostor' ||
      phase === 'pairDenied' ||
      phase === 'revoked' ||
      phase === 'rePair' ||
      phase === 'locked' ||
      phase === 'updated'
    ) {
      return
    }
    if (this.noReconnect) return

    // Pairing socket dropped before it completed: back to the form / welcome.
    if (this.mode === 'pair' && !this.deviceId) {
      store.getState().update({ phase: this.pairCode ? 'pairForm' : 'welcome' })
      return
    }

    this.scheduleReconnect()
  }

  /**
   * Reflect a pending or running reconnect in the banner state (a sticky
   * desktopGone/disabled stays). Over a live screen it is the overlay; before
   * the first snapshot the connecting screen reads the same tier.
   */
  private showReconnecting(): void {
    const s = store.getState()
    const attempt = this.reconnectAttempt
    const sticky = s.banner?.kind === 'desktopGone' || s.banner?.kind === 'disabled'
    const banner = sticky ? s.banner : { kind: 'reconnecting' as const, attempt }
    if (s.snapshot !== null) s.update({ connAttempt: attempt, banner })
    else s.update({ connAttempt: attempt, banner, phase: 'connecting' })
  }

  private scheduleReconnect(): void {
    if (store.getState().phase === 'updated') return
    if (this.reconnectTimer) return
    if (!browserOnline()) {
      // Offline phone: no attempts (FR-11). The 'online' event reconnects.
      store.getState().update({ online: false })
      this.showReconnecting()
      return
    }
    this.reconnectAttempt++
    const delay = delayFor(this.reconnectAttempt, Math.random())
    this.showReconnecting()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }
}

/** Singleton client shared by the whole app. */
export const client = new RemoteClient()
