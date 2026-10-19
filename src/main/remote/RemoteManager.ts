/**
 * The single object the rest of main (index.ts, the IPC layer) talks to. It
 * owns the device registry, the pairing service, and the live server, diffing
 * RemoteSettings to start/stop/restart at runtime without an app restart.
 *
 * Two invariants it enforces:
 *  - main is authoritative for pane `running` and `status`: every snapshot the
 *    renderer pushes has its per-pane running flag overwritten from the live
 *    pty table, and its agent status from StatusManager, before it reaches any
 *    phone (E1-FR-03). Status changes also travel on their own as `paneStatus`,
 *    straight from main, so a throttled or reloading renderer never delays them,
 *  - the renderer is the control-plane executor: control actions are relayed to
 *    it and answered within 10s, or reported as unavailable.
 */
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  PairingQrPayload,
  RemoteCommand,
  RemoteEndpoint,
  RemoteCommandResult,
  RemoteServerState,
  RemoteServerStatus,
  RemoteUiState,
} from '@shared/ipc-contract'
import type { RemoteCtlAction, RemoteHistorySession, RemotePaneStatus, RemoteStateSnapshot } from '@shared/remote-protocol'
import type { AgentProvider, ClaudePaneState, PaneStatusEvt, RemoteSettings, ThemeTokens } from '@shared/types'
import { isHistorySessionId } from '@shared/session-history'
import type { PtyManager } from '../pty/PtyManager'
import { DeviceRegistry } from './DeviceRegistry'
import { listEndpoints } from './network'
import { PairingService, RateLimiter } from './PairingService'
import { RemoteServer } from './RemoteServer'
import { SessionManager, type HttpTokenOwner } from './SessionManager'

const DEFAULT_PORT = 4517
const MIN_PORT = 1024
const MAX_PORT = 65535
/** How long the renderer has to execute a relayed control command. */
const COMMAND_TIMEOUT_MS = 10 * 1000
/** paneStatus coalesce window per pane (E1-FR-03): at most 10 frames/s each. */
export const PANE_STATUS_COALESCE_MS = 100
/** Transitions the phone must see at once, never held by the coalesce window. */
const IMMEDIATE_STATES = new Set<ClaudePaneState | null>(['action', 'done', 'error', null])

/**
 * The phone's view of a desktop status event (E1-FR-03). Copies only the
 * CONTRATOS fields of RemotePaneStatus: sessionId, cwd and every desktop-only
 * enrichment (detail, topic, firstPrompt, cacheSince) never leave main.
 */
export function toRemoteStatus(evt: Omit<PaneStatusEvt, 'paneId' | 'notify'> | null | undefined): RemotePaneStatus | null {
  if (!evt || evt.state == null) return null
  const out: RemotePaneStatus = { state: evt.state, stateSince: evt.stateSince ?? evt.updatedAt ?? 0 }
  if (evt.precise === false) out.precise = false
  if (evt.provider) out.provider = evt.provider
  if (evt.reason) out.reason = evt.reason
  if (evt.pendingCount) out.pendingCount = evt.pendingCount
  if (evt.lastMessage) out.lastMessage = evt.lastMessage
  if (evt.activity) out.activity = evt.activity
  if (evt.pending?.length) out.pending = evt.pending
  return out
}

/** os.hostname() cut to 64 characters; '' when the OS will not say. */
function safeHostName(): string {
  try {
    return hostname().trim().slice(0, 64)
  } catch {
    return ''
  }
}

/** Placeholder state until the renderer pushes its first real snapshot. */
const EMPTY_SNAPSHOT: RemoteStateSnapshot = {
  workspaces: [],
  activeWorkspaceId: null,
  // Real tokens arrive on the renderer's first push (<=100ms); until then the
  // phone falls back to its own defaults for any token it is missing.
  themeTokens: {} as ThemeTokens,
  language: 'en',
  fontFamily: '',
  fontSize: 14,
}

/** The session history as RemoteManager uses it (E3-FR-36..39; SessionHistory in main). */
export interface RemoteHistoryProvider {
  forRemote(req: { query?: string; workspaceId?: string }): Promise<RemoteHistorySession[]>
  has(provider: AgentProvider, sessionId: string): Promise<boolean>
}

interface PendingCommand {
  resolve: (res: RemoteCommandResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class RemoteManager {
  private readonly registry = new DeviceRegistry()
  private readonly rateLimiter = new RateLimiter()
  private readonly pairing: PairingService
  private server: RemoteServer | null = null
  private sessions: SessionManager | null = null
  private statusState: RemoteServerState = 'stopped'
  private statusError: string | undefined
  private boundPort = DEFAULT_PORT
  /** Latest snapshot pushed by the renderer (running overlaid on read). */
  private rawSnapshot: RemoteStateSnapshot | null = null
  private readonly pendingCommands = new Map<string, PendingCommand>()
  private uiScheduled = false
  /** Tracks the current setBackgroundThrottling state to avoid redundant calls. */
  private throttlingDisabled = false
  /** Phone presence observer (AwakeService: an agent in `action` + a phone keeps the PC awake). */
  private phoneListener: ((connected: boolean) => void) | null = null
  private phoneNotified = false
  /** paneStatus dedupe: the serialized status each pane last went out with. */
  private readonly statusSent = new Map<string, string>()
  /** paneStatus coalesce: latest status held per pane until its timer fires. */
  private readonly statusHeld = new Map<string, RemotePaneStatus | null>()
  private readonly statusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Session history for historyReq and the createPane.resume check (E3-FR-36..39). */
  private history: RemoteHistoryProvider | null = null

  constructor(
    private readonly ptyManager: PtyManager,
    private readonly getWebContents: () => WebContents | null,
    private readonly appVersion: string,
    /** Live agent statuses (StatusManager.snapshot), overlaid on every snapshot. */
    private readonly getPaneStatuses: () => PaneStatusEvt[] = () => [],
    /** The PC name the phone's Home header shows (E2-FR-02); injectable for tests. */
    private readonly getHostName: () => string = safeHostName,
    /** Reachable addresses for a port (deepLinkBase, E2-FR-42); injectable for tests. */
    private readonly getEndpoints: (port: number) => RemoteEndpoint[] = listEndpoints,
  ) {
    this.pairing = new PairingService({
      registry: this.registry,
      onChange: () => this.scheduleUi(),
      onPendingExpired: (requestId) => {
        this.sessions?.deliverPairResult(requestId, { kind: 'denied', reason: 'expired' })
        this.scheduleUi()
      },
    })
  }

  // --- Config lifecycle -----------------------------------------------------

  /** Loads paired devices; bootstrap() calls it right after the legacy migration. */
  loadDevices(): void {
    this.registry.load()
  }

  /** Diff the desired config against the live server; start/stop/restart. */
  applyConfig(cfg: RemoteSettings): void {
    const port = this.clampPort(cfg.port)
    if (!cfg.enabled) {
      this.stopServer('disabled')
      return
    }
    // Already up (or coming up) on the right port and not in an error state.
    if (this.server && this.statusState !== 'error' && this.boundPort === port) return
    this.stopServer('disabled') // no-op when nothing is running
    this.startServer(port)
  }

  private startServer(port: number): void {
    this.boundPort = port
    this.sessions = new SessionManager({
      ptyManager: this.ptyManager,
      registry: this.registry,
      pairing: this.pairing,
      rateLimiter: this.rateLimiter,
      appVersion: this.appVersion,
      // authOk: the new phone learns every status from this snapshot, which may
      // be ahead of what the others were sent, so the dedupe memory is dropped
      // and the next emit of each pane goes out (a repeat is harmless).
      getSnapshot: () => {
        this.statusSent.clear()
        return this.currentSnapshot()
      },
      executeCommand: (action, deviceName) => this.executeCommand(action, deviceName),
      onConnectionsChanged: () => this.onConnectionsChanged(),
      queryHistory: (req) => this.history?.forRemote(req) ?? Promise.resolve([]),
    })
    this.ptyManager.addSink(this.sessions)
    // A pty spawning/exiting flips a pane's `running`; re-broadcast so phones
    // update their dots even without a renderer-driven snapshot push.
    this.ptyManager.setRunningChangeListener(() => this.broadcastSnapshot())
    this.server = new RemoteServer(port, {
      onSocket: (ws, ip, host) => this.sessions?.handleSocket(ws, ip, host),
    })
    this.setStatus('starting')
    this.server
      .start()
      .then(() => this.setStatus('running'))
      .catch((err) => {
        this.setStatus('error', this.humanError(err, port))
        this.teardownServer()
      })
  }

  private stopServer(reason: 'quit' | 'disabled'): void {
    if (!this.server && !this.sessions) {
      if (this.statusState !== 'stopped') this.setStatus('stopped')
      return
    }
    this.sessions?.shutdownAll(reason)
    // dispose (not just cancelCode) so a pending 60s approval + its timer are
    // cleared too; otherwise it would block all new pairings until it expires.
    this.pairing.dispose()
    this.teardownServer()
    this.setStatus('stopped')
  }

  private teardownServer(): void {
    this.resetPaneStatus()
    if (this.sessions) {
      this.ptyManager.setRunningChangeListener(null)
      this.ptyManager.removeSink(this.sessions.id)
      this.sessions.dispose()
      this.sessions = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.applyThrottling(false)
    this.notifyPhones()
  }

  /**
   * Best-effort teardown on app quit. Sends a shutdown frame and closes sockets
   * but never awaits socket closes, so it cannot delay the quit.
   */
  shutdown(reason: 'quit' | 'disabled'): void {
    this.sessions?.shutdownAll(reason)
    this.pairing.dispose()
    for (const pending of this.pendingCommands.values()) clearTimeout(pending.timer)
    this.pendingCommands.clear()
    this.teardownServer()
    this.statusState = 'stopped'
  }

  // --- Snapshot relay (main is authoritative for `running`) -----------------

  /** Renderer pushed a fresh snapshot: cache it and broadcast to every phone. */
  pushState(snapshot: RemoteStateSnapshot): void {
    this.rawSnapshot = snapshot
    this.broadcastSnapshot()
  }

  /**
   * Send the overlaid snapshot to every authed phone. Each pane's overlaid
   * status is now what every phone holds, so it becomes the paneStatus dedupe
   * baseline: a later emit that differs from it always goes out, even when it
   * equals the last paneStatus frame (a held update a state frame overtook).
   */
  private broadcastSnapshot(): void {
    if (!this.sessions) return
    const snap = this.currentSnapshot()
    this.statusSent.clear()
    for (const ws of snap.workspaces) {
      for (const pane of ws.panes) this.statusSent.set(pane.id, pane.status ? JSON.stringify(pane.status) : 'null')
    }
    this.sessions.broadcastState(snap)
  }

  private currentSnapshot(): RemoteStateSnapshot {
    return this.rawSnapshot ? this.overlayRunning(this.rawSnapshot) : EMPTY_SNAPSHOT
  }

  /**
   * Overlay main's authoritative `running` and agent `status` on each pane,
   * and the PC name (E2-FR-12): pushState() emits through here too, so every
   * state frame carries it, not only authOk.
   */
  private overlayRunning(snap: RemoteStateSnapshot): RemoteStateSnapshot {
    const running = new Set(this.ptyManager.runningPaneIds())
    // E6-FR-38: a shell that ended on its own shows as "exited" on the phone.
    const exited = this.ptyManager.exitedPaneCodes()
    const statuses = new Map<string, RemotePaneStatus>()
    for (const evt of this.getPaneStatuses()) {
      const status = toRemoteStatus(evt)
      if (status) statuses.set(evt.paneId, status)
    }
    const host = this.getHostName()
    return {
      ...snap,
      ...(host ? { hostName: host } : {}),
      workspaces: snap.workspaces.map((ws) => ({
        ...ws,
        panes: ws.panes.map((p) => {
          const live = running.has(p.id)
          const pane = { ...p, running: live }
          const exitCode = live ? undefined : exited.get(p.id)
          if (exitCode !== undefined) pane.exitCode = exitCode
          else delete pane.exitCode
          const status = statuses.get(p.id)
          if (status) pane.status = status
          else delete pane.status
          return pane
        }),
      })),
    }
  }

  // --- Live agent status (E1-FR-03) -------------------------------------------

  /**
   * StatusManager emitted for a pane: relay it to every authed phone as
   * `paneStatus`. Identical consecutive statuses are dropped (dedupe), and
   * working/idle/unknown updates are held up to 100ms per pane so a burst of
   * PreToolUse events costs at most 10 frames/s; action, done, error and the
   * clearing null go out at once.
   */
  pushPaneStatus(evt: PaneStatusEvt): void {
    if (!this.sessions) return
    const paneId = evt.paneId
    const status = toRemoteStatus(evt)
    if (IMMEDIATE_STATES.has(status?.state ?? null)) {
      this.cancelHeldStatus(paneId)
      this.sendPaneStatus(paneId, status)
      return
    }
    this.statusHeld.set(paneId, status)
    if (this.statusTimers.has(paneId)) return
    this.statusTimers.set(
      paneId,
      setTimeout(() => {
        this.statusTimers.delete(paneId)
        if (!this.statusHeld.has(paneId)) return
        const held = this.statusHeld.get(paneId) ?? null
        this.statusHeld.delete(paneId)
        this.sendPaneStatus(paneId, held)
      }, PANE_STATUS_COALESCE_MS),
    )
  }

  private sendPaneStatus(paneId: string, status: RemotePaneStatus | null): void {
    // The key is what every phone last got for this pane, by a paneStatus or
    // a state frame; an unknown pane (no entry) always goes out.
    const key = status ? JSON.stringify(status) : 'null'
    if (this.statusSent.get(paneId) === key) return
    this.statusSent.set(paneId, key)
    this.sessions?.broadcastPaneStatus(paneId, status)
  }

  private cancelHeldStatus(paneId: string): void {
    const timer = this.statusTimers.get(paneId)
    if (timer) clearTimeout(timer)
    this.statusTimers.delete(paneId)
    this.statusHeld.delete(paneId)
  }

  /** Server gone: phones re-learn every status from the next authOk snapshot. */
  private resetPaneStatus(): void {
    for (const timer of this.statusTimers.values()) clearTimeout(timer)
    this.statusTimers.clear()
    this.statusHeld.clear()
    this.statusSent.clear()
  }

  // --- Control-plane relay --------------------------------------------------

  /** Wire the session history (index.ts, once SessionHistory exists). */
  setHistory(history: RemoteHistoryProvider | null): void {
    this.history = history
  }

  /**
   * Relay a control action to the renderer; resolve on its result or timeout.
   * A createPane carrying `resume` is checked here first (E3-FR-39): the id
   * must have the history format and be in the index, else it acks
   * `notFound` and the renderer never sees it.
   */
  private async executeCommand(action: RemoteCtlAction, deviceName?: string): Promise<RemoteCommandResult> {
    if (action.kind === 'createPane' && action.resume) {
      const { provider, sessionId } = action.resume
      let known = false
      try {
        known = isHistorySessionId(sessionId) && !!this.history && (await this.history.has(provider, sessionId))
      } catch {
        known = false
      }
      if (!known) return { id: '', ok: false, error: 'notFound' }
    }
    return this.relayCommand(action, deviceName)
  }

  private relayCommand(action: RemoteCtlAction, deviceName?: string): Promise<RemoteCommandResult> {
    const wc = this.getWebContents()
    if (!wc || wc.isDestroyed()) {
      return Promise.resolve({ id: '', ok: false, error: 'desktop_unavailable' })
    }
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id)
        resolve({ id, ok: false, error: 'timeout' })
      }, COMMAND_TIMEOUT_MS)
      this.pendingCommands.set(id, { resolve, timer })
      const cmd: RemoteCommand = deviceName ? { id, action, deviceName: deviceName.slice(0, 48) } : { id, action }
      wc.send(CH.REMOTE_CONTROL_CMD, cmd)
    })
  }

  /** Renderer reported a control command's outcome. */
  onControlResult(res: RemoteCommandResult): void {
    const pending = this.pendingCommands.get(res.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingCommands.delete(res.id)
    pending.resolve(res)
  }

  // --- Pairing + devices (driven by IPC) ------------------------------------

  async pairingBegin(): Promise<PairingQrPayload | null> {
    if (this.statusState !== 'running') return null
    const payload = await this.pairing.begin(this.boundPort)
    this.scheduleUi()
    return payload
  }

  pairingCancel(): void {
    this.pairing.cancelCode()
    this.scheduleUi()
  }

  pairingResolve(requestId: string, allow: boolean): void {
    const result = this.pairing.resolve(requestId, allow)
    if (result) this.sessions?.deliverPairResult(requestId, result)
    this.scheduleUi()
  }

  async revokeDevice(deviceId: string): Promise<void> {
    // Revocation order is load-bearing: drop from memory FIRST so no in-flight
    // socket can re-auth, then kill live sockets, and only then persist.
    const existed = this.registry.deleteInMemory(deviceId)
    this.sessions?.killByDevice(deviceId)
    if (existed) this.registry.persist()
    this.scheduleUi()
  }

  // --- Push notifications (E2-FR-42, 52) -------------------------------------

  /**
   * Base of the deep link an ntfy push opens: 'http://<host>:<port>' on the
   * most recent host a phone authenticated through that this PC still has,
   * else the Tailscale endpoint, else the first LAN one. Null while the
   * server is not running (a push then carries no click).
   */
  deepLinkBase(): string | null {
    if (this.statusState !== 'running') return null
    const endpoints = this.getEndpoints(this.boundPort)
    const live = new Set(endpoints.map((e) => e.ip))
    const recent = this.registry.lastHosts().find((h) => live.has(h.host))
    const ip = recent?.host ?? endpoints.find((e) => e.kind === 'tailscale')?.ip ?? endpoints.find((e) => e.kind === 'lan')?.ip
    return ip ? `http://${ip}:${this.boundPort}` : null
  }

  /** A phone is watching this pane right now (subscribed, page visible, fresh); ntfy skips it. */
  isPaneViewed(paneId: string): boolean {
    return this.sessions?.isPaneViewed(paneId) ?? false
  }

  // --- HTTP auth (E3-FR-01) ---------------------------------------------------

  /**
   * The device behind an `Authorization: Bearer` token of the HTTP routes
   * (upload, push subscribe), or null: unknown token, a socket that already
   * closed, a revoked device, or the server stopped (which drops them all).
   */
  resolveHttpToken(token: string): HttpTokenOwner | null {
    return this.sessions?.resolveHttpToken(token) ?? null
  }

  // --- UI state -------------------------------------------------------------

  getUiState(): RemoteUiState {
    return {
      status: this.buildStatus(),
      devices: this.registry.listSanitized(this.sessions?.connectedDeviceIds() ?? new Set()),
      pendingPairing: this.pairing.pendingInfo(),
    }
  }

  private buildStatus(): RemoteServerStatus {
    return {
      state: this.statusState,
      port: this.boundPort,
      endpoints: this.statusState === 'running' ? listEndpoints(this.boundPort) : [],
      connectedCount: this.sessions?.connectedCount ?? 0,
      error: this.statusError,
    }
  }

  private setStatus(state: RemoteServerState, error?: string): void {
    this.statusState = state
    this.statusError = error
    this.scheduleUi()
  }

  private onConnectionsChanged(): void {
    this.applyThrottling((this.sessions?.connectedCount ?? 0) > 0)
    this.scheduleUi()
    this.notifyPhones()
  }

  // --- Phone presence (AwakeService) -----------------------------------------

  /** At least one authenticated phone session is connected right now. */
  get phoneConnected(): boolean {
    return (this.sessions?.connectedCount ?? 0) > 0
  }

  /** Observe phone presence; called only when it flips. */
  setPhoneListener(cb: ((connected: boolean) => void) | null): void {
    this.phoneListener = cb
    this.phoneNotified = this.phoneConnected
  }

  private notifyPhones(): void {
    const connected = this.phoneConnected
    if (connected === this.phoneNotified) return
    this.phoneNotified = connected
    this.phoneListener?.(connected)
  }

  private applyThrottling(disable: boolean): void {
    if (this.throttlingDisabled === disable) return
    this.throttlingDisabled = disable
    const wc = this.getWebContents()
    // Keep the control plane responsive while phones are attached, even when the
    // desktop window is hidden in the tray.
    if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(!disable)
  }

  private scheduleUi(): void {
    if (this.uiScheduled) return
    this.uiScheduled = true
    queueMicrotask(() => {
      this.uiScheduled = false
      const wc = this.getWebContents()
      if (wc && !wc.isDestroyed()) wc.send(CH.REMOTE_EVENT, this.getUiState())
    })
  }

  private clampPort(port: number): number {
    if (!Number.isFinite(port)) return DEFAULT_PORT
    return Math.min(MAX_PORT, Math.max(MIN_PORT, Math.floor(port)))
  }

  private humanError(err: unknown, port: number): string {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'EADDRINUSE') return `Port ${port} is already in use. Choose another port.`
    if (code === 'EACCES') return `Port ${port} needs elevated privileges. Choose a port above 1024.`
    return err instanceof Error ? err.message : 'Failed to start the remote server.'
  }
}
