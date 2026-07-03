/**
 * The single object the rest of main (index.ts, the IPC layer) talks to. It
 * owns the device registry, the pairing service, and the live server, diffing
 * RemoteSettings to start/stop/restart at runtime without an app restart.
 *
 * Two invariants it enforces:
 *  - main is authoritative for pane `running`: every snapshot the renderer
 *    pushes has its per-pane running flag overwritten from the live pty table
 *    before it reaches any phone,
 *  - the renderer is the control-plane executor: control actions are relayed to
 *    it and answered within 10s, or reported as unavailable.
 */
import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  PairingQrPayload,
  RemoteCommand,
  RemoteCommandResult,
  RemoteServerState,
  RemoteServerStatus,
  RemoteUiState,
} from '@shared/ipc-contract'
import type { RemoteCtlAction, RemoteStateSnapshot } from '@shared/remote-protocol'
import type { RemoteSettings, ThemeTokens } from '@shared/types'
import type { PtyManager } from '../pty/PtyManager'
import { DeviceRegistry } from './DeviceRegistry'
import { listEndpoints } from './network'
import { PairingService, RateLimiter } from './PairingService'
import { RemoteServer } from './RemoteServer'
import { SessionManager } from './SessionManager'

const DEFAULT_PORT = 4517
const MIN_PORT = 1024
const MAX_PORT = 65535
/** How long the renderer has to execute a relayed control command. */
const COMMAND_TIMEOUT_MS = 10 * 1000

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

  constructor(
    private readonly ptyManager: PtyManager,
    private readonly getWebContents: () => WebContents | null,
    private readonly appVersion: string,
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
      getSnapshot: () => this.currentSnapshot(),
      executeCommand: (action) => this.executeCommand(action),
      onConnectionsChanged: () => this.onConnectionsChanged(),
    })
    this.ptyManager.addSink(this.sessions)
    // A pty spawning/exiting flips a pane's `running`; re-broadcast so phones
    // update their dots even without a renderer-driven snapshot push.
    this.ptyManager.setRunningChangeListener(() =>
      this.sessions?.broadcastState(this.currentSnapshot()),
    )
    this.server = new RemoteServer(port, {
      onSocket: (ws, ip) => this.sessions?.handleSocket(ws, ip),
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
    this.sessions?.broadcastState(this.overlayRunning(snapshot))
  }

  private currentSnapshot(): RemoteStateSnapshot {
    return this.rawSnapshot ? this.overlayRunning(this.rawSnapshot) : EMPTY_SNAPSHOT
  }

  private overlayRunning(snap: RemoteStateSnapshot): RemoteStateSnapshot {
    const running = new Set(this.ptyManager.runningPaneIds())
    return {
      ...snap,
      workspaces: snap.workspaces.map((ws) => ({
        ...ws,
        panes: ws.panes.map((p) => ({ ...p, running: running.has(p.id) })),
      })),
    }
  }

  // --- Control-plane relay --------------------------------------------------

  /** Relay a control action to the renderer; resolve on its result or timeout. */
  private executeCommand(action: RemoteCtlAction): Promise<RemoteCommandResult> {
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
      wc.send(CH.REMOTE_CONTROL_CMD, { id, action } satisfies RemoteCommand)
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
