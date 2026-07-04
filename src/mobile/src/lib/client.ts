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
 */
import {
  PROTOCOL_VERSION,
  REMOTE_CLOSE,
  type RemoteClientMsg,
  type RemoteCtlAction,
  type RemoteServerMsg,
  type RemoteStateSnapshot,
} from '@shared/remote-protocol'
import {
  clearAuth,
  getStoredAuth,
  getStoredHostPlatform,
  randomNonceHex,
  storeAuth,
  storeHostPlatform,
} from './auth'
import { hexEqual, hexToBytes, hmacSha256Hex } from './sha256'
import { store } from './store'
import { applyRemoteTheme } from './theme'
import { setLang } from './i18n'

/** A frame handed to the live terminal. */
export type TermFrame =
  | { type: 'replay'; data: string; cols: number; rows: number; running: boolean }
  | { type: 'out'; data: string }
  | { type: 'exit'; exitCode: number }

/** Result of a control request, resolved by the matching ctlAck (or a timeout). */
export interface CtlResult {
  ok: boolean
  error?: string
  paneId?: string
  info?: number
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000]
const PING_INTERVAL = 25000
const CTL_TIMEOUT = 10000
const PAIR_PENDING_MS = 60000

/** Read the one-time pairing code from the URL fragment (#pair=CODE). */
function readPairCode(): string | null {
  const m = location.hash.match(/pair=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
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
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private manualClose = false
  private noReconnect = false
  private started = false

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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.ws) {
      this.manualClose = true
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.mode = 'pair'
    this.pairCode = code
    this.deviceId = null
    this.secretKey = null
    this.noReconnect = false
    this.reconnectAttempt = 0
    store.getState().update({ phase: 'pairForm', banner: null, pairReason: null, pairExpiresAt: null })
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
    this.noReconnect = false
    this.reconnectAttempt = 0
    store.getState().update({ phase: this.deviceId ? 'connecting' : 'welcome', banner: null, lockUntil: null })
    if (this.deviceId) this.connect()
  }

  /** Forget this origin's device and reload to a clean state. */
  unpair(): void {
    clearAuth()
    this.manualClose = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    location.reload()
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

  /** Send keystrokes/paste data to the currently-viewed pane. */
  sendInput(data: string): void {
    const paneId = store.getState().subscribedPaneId
    if (paneId) this.send({ v: PROTOCOL_VERSION, type: 'input', paneId, data })
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

  // --- internals ---

  private onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return
    // Reconnect immediately instead of waiting out the backoff timer.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      this.connect()
    }
  }

  private send(msg: RemoteClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg))
      } catch {
        /* socket dying; onclose will drive recovery */
      }
    }
  }

  private connect(): void {
    if (this.ws) return
    this.noReconnect = false
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://${location.host}/ws`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = this.onOpen
    ws.onmessage = this.onMessage
    ws.onclose = this.onClose
    ws.onerror = () => {
      /* onclose always follows; recovery happens there */
    }
  }

  private onOpen = (): void => {
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

  private onMessage = (ev: MessageEvent): void => {
    let msg: RemoteServerMsg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as RemoteServerMsg
    } catch {
      return
    }
    switch (msg.type) {
      case 'challenge':
        this.handleChallenge(msg)
        break
      case 'pairPending':
        store.getState().update({ phase: 'pairPending', pairExpiresAt: Date.now() + PAIR_PENDING_MS })
        break
      case 'paired':
        this.handlePaired(msg)
        break
      case 'pairDenied':
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
          this.emit({ type: 'replay', data: msg.data, cols: msg.cols, rows: msg.rows, running: msg.running })
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
          store.getState().update({ banner: { kind: 'desktopGone' } })
        }
        break
      case 'pong':
        break
      case 'err':
        // version/rate/unauthorized: nothing actionable on the phone beyond the
        // eventual close; bad_msg should never happen from our own encoder.
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
    // On the pairing path the socket is ALREADY authed: there is no authOk, the
    // server just pushes a 'state' frame next. Show a brief connecting state
    // until that arrives (handleState then takes us live). hostPlatform/appVersion
    // never arrive on this path, so windowsPty defaults off until a later
    // reconnect's authOk fills it in (and persists it for next time).
    store.getState().update({ phase: 'connecting', pairExpiresAt: null })
  }

  /**
   * Adopt a state snapshot as the live screen: apply theme/lang, pick a pane and
   * subscribe, start keepalive. Shared by the reconnect authOk path (with
   * hostPlatform/appVersion) and the pairing path's first 'state' frame (without).
   */
  private goLive(state: RemoteStateSnapshot, hostPlatform: string, appVersion: string): void {
    setLang(state.language)
    const xtermTheme = applyRemoteTheme(state.themeTokens)
    this.reconnectAttempt = 0
    const cur = store.getState().activePaneId
    const keep = cur && paneExists(state, cur) ? cur : pickPane(state, state.activeWorkspaceId)
    store.getState().update({
      phase: 'live',
      banner: null,
      snapshot: state,
      xtermTheme,
      hostPlatform,
      appVersion,
      pairExpiresAt: null,
      // Force viewPane below to (re)issue a sub even on reconnect to the same pane.
      subscribedPaneId: null,
      activePaneId: keep ?? null,
    })
    this.startKeepalive()
    if (keep) this.viewPane(keep)
  }

  private handleAuthOk(msg: Extract<RemoteServerMsg, { type: 'authOk' }>): void {
    // Persist the host platform so future sessions (incl. the pairing path, which
    // never learns it) can still enable windowsPty on Windows desktops.
    storeHostPlatform(msg.hostPlatform)
    this.goLive(msg.state, msg.hostPlatform, msg.appVersion)
  }

  private handleAuthFail(msg: Extract<RemoteServerMsg, { type: 'authFail' }>): void {
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
    // Pairing path: the first 'state' (no preceding authOk) is what takes us live.
    if (store.getState().phase !== 'live') {
      this.goLive(state, getStoredHostPlatform(), store.getState().appVersion)
      return
    }
    setLang(state.language)
    const xtermTheme = applyRemoteTheme(state.themeTokens)
    store.getState().update({ snapshot: state, xtermTheme })
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
    this.manualClose = true
    this.noReconnect = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    store.getState().update({ phase })
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.pingTimer = setInterval(() => {
      this.send({ v: PROTOCOL_VERSION, type: 'ping', t: Date.now() })
    }, PING_INTERVAL)
  }

  private stopKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private onClose = (ev: CloseEvent): void => {
    this.stopKeepalive()
    this.ws = null

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

    const phase = store.getState().phase
    if (phase === 'impostor' || phase === 'pairDenied' || phase === 'revoked' || phase === 'rePair' || phase === 'locked') {
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const base = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    // +-30% jitter to avoid a reconnect thundering-herd across devices.
    const delay = Math.round(base * (0.7 + Math.random() * 0.6))
    this.reconnectAttempt++
    const wasLive = store.getState().snapshot !== null
    if (wasLive) {
      store.getState().update({ banner: { kind: 'reconnecting', attempt: this.reconnectAttempt } })
    } else {
      store.getState().update({ phase: 'connecting' })
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }
}

/** Singleton client shared by the whole app. */
export const client = new RemoteClient()
