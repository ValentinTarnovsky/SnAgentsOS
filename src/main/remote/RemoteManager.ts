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
 *
 * Phone-fit (E3 M11): fitPane / releaseFit go through the FitController
 * first (owner, grace, auto restore); it outlives a server restart so the
 * server going off can give every pane back before the sockets close.
 *
 * Chat view (E3 M12): index.ts injects the ChatHub (setChat); the sessions
 * reach it through a relay, so a hub set after the server started still
 * answers, and none answers every chatSub with the noTranscript notice.
 *
 * Secure mode and Web Push (E3 M14, R30-07): SecureMode drives `tailscale
 * serve`; while it is on, the MagicDNS name is a valid Host (RemoteServer),
 * the first QR endpoint and authOk's `secureUrl`. PushService holds the VAPID
 * keys and the subscriptions; it is active with `settings.remote.https.enabled`
 * (FR-46) and pushes each StatusNotice to the devices without a visible session.
 */
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { join } from 'path'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  PairingQrPayload,
  RemoteCommand,
  RemoteCommandFit,
  RemoteEndpoint,
  RemoteCommandResult,
  RemoteFitReleaseReq,
  RemoteServerState,
  RemoteServerStatus,
  RemoteUiState,
  SecureModeStatus,
} from '@shared/ipc-contract'
import type { RemoteCtlAction, RemoteGitReply, RemoteGitRequest, RemoteHistorySession, RemoteNote, RemoteNotesReply, RemoteNotesRequest, RemotePaneMenu, RemotePaneStatus, RemotePlanReply, RemotePlanRequest, RemoteStateSnapshot } from '@shared/remote-protocol'
import { WS_NOTE_PHONE_MAX, type WsNoteDoc, type WsNotesChangedEvt } from '@shared/ws-notes'
import type { WsNoteStore } from '../notes/WsNoteStore'
import type { AgentProvider, ClaudePaneState, ConfigFile, PanePlan, PaneStatusEvt, RemoteSettings, ThemeTokens } from '@shared/types'
import { isHistorySessionId } from '@shared/session-history'
import type { PtyManager } from '../pty/PtyManager'
import { DeviceRegistry } from './DeviceRegistry'
import { FitController } from './FitController'
import { listEndpoints } from './network'
import { dataDir } from '../paths'
import { devPort } from '../devPort'
import { PairingService, RateLimiter } from './PairingService'
import { RemoteServer } from './RemoteServer'
import { SessionManager, type HttpTokenOwner, type RemoteStatusCtl } from './SessionManager'
import { ATTACHMENT_CLEANUP_INTERVAL_MS, UploadService } from './UploadService'
import { noticePage, type ChatHooks } from '../chat/ChatHub'
import { SecureMode, type SecureResult } from './SecureMode'
import { PushService, buildPushMessage } from './PushService'
import { PromptMenuWatcher, validMenu } from './PromptMenuWatcher'
import { parseMenu } from '@shared/promptMenu'
import type { StatusNotice } from '../status/events'

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
 * enrichment (detail, topic, firstPrompt, cacheSince, digest, signalAt) never
 * leave main. App 2.7.0 (A3): a `bare` status (needs only, no agent track)
 * goes out for its needs and attention with `bare: true`, so the phone shows
 * the request and no agent state.
 */
export function toRemoteStatus(evt: Omit<PaneStatusEvt, 'paneId' | 'notify'> | null | undefined, menu?: RemotePaneMenu | null): RemotePaneStatus | null {
  if (!evt || evt.state == null) return null
  const out: RemotePaneStatus = { state: evt.state, stateSince: evt.stateSince ?? evt.updatedAt ?? 0 }
  if (evt.precise === false) out.precise = false
  if (evt.provider) out.provider = evt.provider
  if (evt.hosted) out.hosted = true
  if (evt.reason) out.reason = evt.reason
  if (evt.pendingCount) out.pendingCount = evt.pendingCount
  if (evt.lastMessage) out.lastMessage = evt.lastMessage
  if (evt.activity) out.activity = evt.activity
  if (evt.pending?.length) out.pending = evt.pending
  if (evt.waiting) out.waiting = evt.waiting
  // v2.3: false goes out explicitly (it clears the phone's marks); absent = an older desktop.
  if (evt.attention !== undefined) out.attention = evt.attention
  // v2.3 (agentTune read-back): already bounded by main.
  if (evt.model) out.model = evt.model
  if (evt.effort) out.effort = evt.effort
  if (evt.ultracode !== undefined) out.ultracode = evt.ultracode
  // app 2.4.0: Claude's menu (PromptMenuWatcher), only while its request is still pending.
  if (menu && evt.pending?.some((p) => p.id === menu.for)) out.menu = { for: menu.for, options: menu.options.map((o) => ({ n: o.n, label: o.label })) }
  // app 2.7.0 (A3): already bounded by StatusManager, copied field by field;
  // digest and signalAt stay on the desktop.
  if (evt.toolFamily) out.toolFamily = evt.toolFamily
  if (evt.failure) {
    out.failure = { kind: evt.failure.kind }
    if (evt.failure.until !== undefined) out.failure.until = evt.failure.until
    if (evt.failure.code !== undefined) out.failure.code = evt.failure.code
  }
  if (evt.silence) out.silence = { level: evt.silence.level, since: evt.silence.since }
  if (evt.needs) out.needs = { text: evt.needs.text, at: evt.needs.at }
  if (evt.muted !== undefined) out.muted = evt.muted
  if (evt.bare) out.bare = true
  // app 2.7.0 (A4): the ledger's context, field by field; `usage` stays on the desktop.
  if (evt.context) out.context = { pct: evt.context.pct, used: evt.context.used, window: evt.context.window, exact: evt.context.exact }
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

/** A failed secure mode is retried this often while the setting stays on (tailscale may start after us). */
export const SECURE_RETRY_MS = 60 * 1000

/** Injectable services (tests); defaults are the real ones. */
export interface RemoteServices {
  secure?: Pick<SecureMode, 'enable' | 'disable'>
  push?: PushService
}

/** The session history as RemoteManager uses it (E3-FR-36..39; SessionHistory in main). */
export interface RemoteHistoryProvider {
  forRemote(req: { query?: string; workspaceId?: string }): Promise<RemoteHistorySession[]>
  has(provider: AgentProvider, sessionId: string): Promise<boolean>
}

/**
 * app 2.7.0 (A3): the StatusManager marks behind the phone's markRead /
 * mutePane / silenceAck ctls and planReq (index.ts wires StatusManager).
 */
export interface RemoteStatusControl {
  markRead(paneId: string): boolean
  setMuted(paneId: string, muted: boolean): boolean
  ackSilence(paneId: string): boolean
  planOf(paneId: string, requestId?: string): PanePlan | null
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
  private boundPort = devPort(DEFAULT_PORT, DEFAULT_PORT)
  /** Latest snapshot pushed by the renderer (running overlaid on read). */
  private rawSnapshot: RemoteStateSnapshot | null = null
  private readonly pendingCommands = new Map<string, PendingCommand>()
  private uiScheduled = false
  /** Tracks the current setBackgroundThrottling state to avoid redundant calls. */
  private throttlingDisabled = false
  /** app 2.4.0: other owners that keep the renderer unthrottled (the Share guests), by key. */
  private readonly throttleHolds = new Set<string>()
  /** app 2.4.0: observers of every renderer snapshot (ShareHost), phone server or not. */
  private readonly snapshotListeners = new Set<(snap: RemoteStateSnapshot) => void>()
  /** Phone presence observer (AwakeService: an agent in `action` + a phone keeps the PC awake). */
  private phoneListener: ((connected: boolean) => void) | null = null
  private phoneNotified = false
  /** v2.3: a phone looked at a pane (StatusManager.ackPane). */
  private paneSeenListener: ((paneId: string) => void) | null = null
  /** app 2.7.0 (A3): StatusManager's marks and plans (set by index.ts; read lazily by the session deps). */
  private statusControl: RemoteStatusControl | null = null
  /** paneStatus dedupe: the serialized status each pane last went out with. */
  private readonly statusSent = new Map<string, string>()
  /** paneStatus coalesce: latest status held per pane until its timer fires. */
  private readonly statusHeld = new Map<string, RemotePaneStatus | null>()
  private readonly statusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** settings.remote.phoneFit (E3-FR-20), from the last applyConfig. */
  private phoneFit = true
  /** The renderer navigated (reload, crash recovery): its next snapshot re-learns the owners (FR-23). */
  private refitPending = false
  /** Phone-fit owners, grace and auto restore (E3 M11). */
  readonly fit: FitController
  /** app 2.4.0: Claude's menu read off the headless mirror for the phone's Chat view. */
  readonly menus: PromptMenuWatcher
  /** Phone image uploads (E3-FR-08..10): `POST /api/upload` and the attachments cleanup. */
  private readonly uploads = new UploadService({
    dir: () => join(dataDir(), 'attachments'),
    resolveToken: (token) => this.resolveHttpToken(token),
  })
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  /** Session history for historyReq and the createPane.resume check (E3-FR-36..39). */
  private history: RemoteHistoryProvider | null = null
  /** E7-FR-22..26: answers the phone's gitReq (GitRemote, set by index.ts at boot). */
  private gitHandler: ((req: RemoteGitRequest) => Promise<RemoteGitReply>) | null = null
  /** v2.2 (E9): the workspace notes the phones read and write (set by index.ts at boot). */
  private notes: Pick<WsNoteStore, 'list' | 'read' | 'write' | 'create' | 'delete'> | null = null
  /** E3 M12: the phones' Chat view (ChatHub, set by index.ts at boot). */
  private chat: ChatHooks | null = null
  private readonly chatRelay: ChatHooks = {
    sub: (owner, paneId, send) => (this.chat ? this.chat.sub(owner, paneId, send) : send(noticePage(paneId, 'noTranscript'))),
    unsub: (owner, paneId) => this.chat?.unsub(owner, paneId),
    more: (owner, paneId, before, send) => (this.chat ? this.chat.more(owner, paneId, before, send) : send(noticePage(paneId, 'noTranscript'))),
    closed: (owner) => this.chat?.closed(owner),
  }
  /** E3-FR-42: `tailscale serve` (CLI calls run one at a time on secureQueue). */
  private readonly secure: Pick<SecureMode, 'enable' | 'disable'>
  /** E3-FR-44..46: VAPID keys, subscriptions and sending. */
  readonly push: PushService
  /** settings.remote.https.enabled as last applied (push is active with it, FR-46). */
  private httpsWanted = false
  /**
   * `tailscale serve` should point at us: https on and the remote server
   * enabled. With the server off nothing stays published on the tailnet (a
   * handler to a closed loopback port, or to whatever binds it next).
   */
  private serveWanted = false
  /** The MagicDNS name while the secure mode is on (accepted as Host, listed first). */
  private secureHost: string | null = null
  /** Port the current `tailscale serve` handler points at. */
  private securePort: number | null = null
  private secureStatus: SecureModeStatus = { state: 'off' }
  private secureQueue: Promise<unknown> = Promise.resolve()
  private secureRetry: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly ptyManager: PtyManager,
    private readonly getWebContents: () => WebContents | null,
    private readonly appVersion: string,
    /** Live agent statuses (StatusManager.snapshot), overlaid on every snapshot. */
    private readonly getPaneStatuses: () => PaneStatusEvt[] = () => [],
    /** The PC name the phone's Home header shows (E2-FR-02); injectable for tests. */
    private readonly getHostName: () => string = safeHostName,
    /** Reachable addresses for a port (deepLinkBase, E2-FR-42); injectable for tests. */
    private readonly getEndpoints: (port: number, secureHost?: string | null) => RemoteEndpoint[] = listEndpoints,
    services: RemoteServices = {},
  ) {
    this.secure = services.secure ?? new SecureMode()
    this.push = services.push ?? new PushService({ file: () => join(dataDir(), 'push-keys.json') })
    this.fit = new FitController({
      dispatch: (action, fit) => this.executeCommand(action, undefined, fit),
      enabled: () => this.phoneFit,
      sizeOf: (paneId) => this.ptyManager.sizeOf(paneId),
      ptyIdOf: (paneId) => this.ptyManager.ptyIdForPane(paneId),
      onReleased: (paneId) => {
        // Every phone, viewing the pane or not (FR-18), even without a resize.
        const size = this.ptyManager.sizeOf(paneId)
        if (size) this.sessions?.broadcastFitState(paneId, 'desktop', size.cols, size.rows, true)
      },
      onFitted: (paneId) => {
        const size = this.ptyManager.sizeOf(paneId)
        if (size) this.sessions?.broadcastFitState(paneId, 'phone', size.cols, size.rows)
      },
    })
    this.menus = new PromptMenuWatcher({
      screenRows: (paneId) => this.ptyManager.screenRows?.(paneId) ?? null,
      isWatched: (paneId) => this.sessions?.isPaneWatched(paneId) ?? false,
      // The full event, so the re-broadcast is the same status plus the menu
      // (pushPaneStatus's coalesce and dedupe apply).
      onChange: (paneId) => {
        const evt = this.paneStatusOf(paneId)
        if (evt) this.pushPaneStatus(evt)
      },
    })
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
    this.startAttachmentCleanup()
  }

  /**
   * E3-FR-10: prune old phone attachments now and every 6h, whether or not
   * the server is on (the folder outlives a disabled remote). Runs once.
   */
  private startAttachmentCleanup(): void {
    if (this.cleanupTimer) return
    const run = (): void => void this.uploads.cleanup().catch(() => undefined)
    run()
    this.cleanupTimer = setInterval(run, ATTACHMENT_CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref?.()
  }

  /** Diff the desired config against the live server; start/stop/restart. */
  applyConfig(cfg: RemoteSettings): void {
    const phoneFit = cfg.phoneFit !== false
    // Turning phone-fit off gives every phone-sized pane back at once.
    if (this.phoneFit && !phoneFit) void this.fit.releaseAll()
    this.phoneFit = phoneFit
    // Plan A1.3: a worktree dev instance moves the default port (devPort.ts).
    const port = devPort(this.clampPort(cfg.port), DEFAULT_PORT)
    this.syncSecure(cfg.https?.enabled === true, port, cfg.enabled === true)
    if (!cfg.enabled) {
      this.stopServer('disabled')
      return
    }
    // Already up (or coming up) on the right port and not in an error state.
    if (this.server && this.statusState !== 'error' && this.boundPort === port) return
    this.stopServer('disabled') // no-op when nothing is running
    this.startServer(port)
  }

  // --- Secure mode (E3-FR-42/43) ------------------------------------------------

  /** Run one CLI job after the previous one, so enable/disable never interleave. */
  private enqueueSecure<T>(job: () => Promise<T>): Promise<T> {
    const next = this.secureQueue.then(job, job)
    this.secureQueue = next.catch(() => undefined)
    return next
  }

  /**
   * The config says what the secure mode should be (boot, an import, a port
   * change). The toggle itself goes through setSecure, which already leaves
   * this state in place, so its config echo is a no-op here.
   */
  private syncSecure(wanted: boolean, port: number, serverEnabled: boolean): void {
    this.httpsWanted = wanted
    if (wanted) {
      // The keys exist from the first time https is on (E3 M14).
      try {
        this.push.ensureKeys()
      } catch {
        /* unreadable data dir: push stays without a key */
      }
    }
    const was = this.serveWanted
    this.serveWanted = wanted && serverEnabled
    if (this.serveWanted) {
      if (was && this.securePort === port && this.secureStatus.state !== 'error') return
      void this.applySecure(port)
      return
    }
    if (!was) return
    this.clearSecureRetry()
    const previous = this.securePort
    this.markSecureOff()
    if (previous !== null) void this.enqueueSecure(() => this.secure.disable(previous)).catch(() => undefined)
  }

  /** enable(port) in the background with the 'checking' state, retried while it fails. */
  private applySecure(port: number): Promise<SecureModeStatus> {
    const previous = this.securePort ?? undefined
    this.clearSecureRetry()
    this.secureStatus = { state: 'checking' }
    this.scheduleUi()
    return this.enqueueSecure(async () => {
      let res: SecureResult
      try {
        res = await this.secure.enable(port, previous)
      } catch (err) {
        res = { ok: false, error: 'cli', message: err instanceof Error ? err.message : String(err) }
      }
      // Turned off (or moved to another port) while the CLI ran: that call wins.
      if (!this.serveWanted) return this.secureStatus
      this.onSecureResult(res, port)
      if (!res.ok) {
        this.secureRetry = setTimeout(() => {
          this.secureRetry = null
          if (this.serveWanted && this.secureStatus.state === 'error') void this.applySecure(this.boundPort)
        }, SECURE_RETRY_MS)
        this.secureRetry.unref?.()
      }
      return this.secureStatus
    })
  }

  private onSecureResult(res: SecureResult, port: number): void {
    if (res.ok) {
      this.secureHost = res.dnsName
      this.securePort = port
      this.secureStatus = { state: 'on', dnsName: res.dnsName, url: `https://${res.dnsName}` }
    } else {
      this.secureHost = null
      this.secureStatus = { state: 'error', error: res.error, ...(res.message ? { message: res.message } : {}) }
    }
    this.scheduleUi()
  }

  private markSecureOff(): void {
    this.secureHost = null
    this.securePort = null
    this.secureStatus = { state: 'off' }
    this.scheduleUi()
  }

  private clearSecureRetry(): void {
    if (this.secureRetry) clearTimeout(this.secureRetry)
    this.secureRetry = null
  }

  /**
   * remote:secureSet, the Settings toggle (E3-FR-42). On: needs the server
   * running, then `tailscale serve`; the answer says whether the renderer may
   * save `https.enabled = true`. Off: removes our handler (only ours) and
   * always ends off locally, with the CLI's error if the removal failed.
   */
  async setSecure(enabled: boolean): Promise<SecureModeStatus> {
    if (enabled) {
      if (this.statusState !== 'running') return { state: 'error', error: 'server_off' }
      this.httpsWanted = true
      this.serveWanted = true
      try {
        this.push.ensureKeys()
      } catch {
        /* push stays without a key */
      }
      const status = await this.applySecure(this.boundPort)
      // A failed attempt from the toggle leaves the setting off: no retry loop.
      // The renderer shows the returned error; main's status goes back to off
      // so the status line and the diagnostics never report a setting that is off.
      if (status.state !== 'on') {
        this.httpsWanted = false
        this.serveWanted = false
        this.clearSecureRetry()
        this.markSecureOff()
      }
      return status
    }
    this.httpsWanted = false
    this.serveWanted = false
    this.clearSecureRetry()
    const port = this.securePort ?? this.boundPort
    this.markSecureOff()
    let res: Awaited<ReturnType<SecureMode['disable']>>
    try {
      res = await this.enqueueSecure(() => this.secure.disable(port))
    } catch (err) {
      res = { ok: false, error: 'cli', message: err instanceof Error ? err.message : String(err) }
    }
    if (res.ok) return { state: 'off' }
    return { state: 'off', error: res.error, ...(res.message ? { message: res.message } : {}) }
  }

  /** `https://<name>` while the secure mode is on (authOk.secureUrl, E3-FR-43). */
  private secureUrl(): string | null {
    return this.secureHost ? `https://${this.secureHost}` : null
  }

  // --- Web Push (E3-FR-44..46) --------------------------------------------------

  /**
   * A StatusNotice that passed the away gate (noticeRouter): push it to every
   * paired device without a visible session, with the desktop's notifyAction
   * / notifyDone preferences. Nothing while https is off (FR-46).
   */
  notifyPush(notice: StatusNotice, config: ConfigFile | null): Promise<number> {
    if (!this.httpsWanted) return Promise.resolve(0)
    const prefs = config?.settings?.notifications
    if (prefs && !(notice.state === 'done' ? prefs.notifyDone : prefs.notifyAction)) return Promise.resolve(0)
    return this.push
      .notify(buildPushMessage(notice, config), {
        enabled: this.httpsWanted,
        isDeviceVisible: (deviceId) => this.sessions?.isDeviceVisible(deviceId) ?? false,
        isPaired: (deviceId) => this.registry.get(deviceId) !== undefined,
      })
      .catch(() => 0)
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
      fit: this.fit,
      queryHistory: (req) => this.history?.forRemote(req) ?? Promise.resolve([]),
      git: (req) => this.gitRequest(req),
      notes: (req) => this.notesRequest(req),
      chat: this.chatRelay,
      // E3-FR-44/46: the VAPID key only while https is on.
      getPushKey: () => (this.httpsWanted ? this.push.publicKey() : null),
      getSecureUrl: () => this.secureUrl(),
      onPaneSeen: (paneId) => this.paneSeenListener?.(paneId),
      // app 2.4.0: a phone opened the pane (Terminal or Chat): read its menu now.
      onPaneWatched: (paneId) => this.menus.watch(paneId),
      answerMenu: (action) => this.answerMenu(action),
      // app 2.7.0 (A3): status marks and the full plan, answered by StatusManager.
      statusCtl: (action) => this.statusCtl(action),
      plan: (req) => this.planRequest(req),
    })
    // The menu reader only schedules a timer per chunk; the sessions sink goes last.
    this.ptyManager.addSink(this.menus)
    this.ptyManager.addSink(this.sessions)
    // A pty spawning/exiting flips a pane's `running`; re-broadcast so phones
    // update their dots even without a renderer-driven snapshot push.
    this.ptyManager.setRunningChangeListener(() => this.broadcastSnapshot())
    this.server = new RemoteServer(port, {
      onSocket: (ws, ip, host) => this.sessions?.handleSocket(ws, ip, host),
      onUpload: (req, res) => this.uploads.handle(req, res),
      onPushSubscribe: (req, res) =>
        this.push.handleSubscribe(req, res, { enabled: this.httpsWanted, resolveToken: (token) => this.resolveHttpToken(token) }),
      secureHost: () => this.secureHost,
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
    // E3-FR-20: every phone-sized pane goes back to the desktop first.
    void this.fit.releaseAll()
    this.sessions?.shutdownAll(reason)
    // dispose (not just cancelCode) so a pending 60s approval + its timer are
    // cleared too; otherwise it would block all new pairings until it expires.
    this.pairing.dispose()
    this.teardownServer()
    this.setStatus('stopped')
  }

  private teardownServer(): void {
    this.resetPaneStatus()
    this.menus.reset()
    if (this.sessions) {
      this.ptyManager.setRunningChangeListener(null)
      this.ptyManager.removeSink(this.menus.id)
      this.ptyManager.removeSink(this.sessions.id)
      this.sessions.dispose()
      this.sessions = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.applyThrottling(this.throttleHolds.size > 0)
    this.notifyPhones()
  }

  /**
   * Best-effort teardown on app quit. Sends a shutdown frame and closes sockets
   * but never awaits socket closes, so it cannot delay the quit.
   */
  shutdown(reason: 'quit' | 'disabled'): void {
    // Quitting: the renderer goes too, so there is nothing to restore into.
    this.fit.dispose()
    this.sessions?.shutdownAll(reason)
    this.pairing.dispose()
    for (const pending of this.pendingCommands.values()) clearTimeout(pending.timer)
    this.pendingCommands.clear()
    // `tailscale serve --bg` persists on its own: quitting leaves it in place.
    this.clearSecureRetry()
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
    this.teardownServer()
    this.statusState = 'stopped'
  }

  // --- Snapshot relay (main is authoritative for `running`) -----------------

  /** Renderer pushed a fresh snapshot: cache it and broadcast to every phone. */
  pushState(snapshot: RemoteStateSnapshot): void {
    this.rawSnapshot = snapshot
    // E3-FR-23: the first snapshot of a reloaded renderer means its executor is
    // wired again; it gets the fitPane of every pane a phone still sizes.
    if (this.refitPending) {
      this.refitPending = false
      this.fit.refitAll()
    }
    this.broadcastSnapshot()
    if (this.snapshotListeners.size > 0) {
      const snap = this.currentSnapshot()
      for (const cb of this.snapshotListeners) {
        try {
          cb(snap)
        } catch {
          /* an observer never breaks the phones' relay */
        }
      }
    }
  }

  /**
   * app 2.4.0 (Share): the last renderer snapshot with main's running and
   * status overlaid, or null before the renderer's first push. Works with
   * the phone server off.
   */
  snapshot(): RemoteStateSnapshot | null {
    return this.rawSnapshot ? this.currentSnapshot() : null
  }

  /** app 2.4.0 (Share): called after every renderer snapshot push (overlaid). Returns unsubscribe. */
  onSnapshot(cb: (snap: RemoteStateSnapshot) => void): () => void {
    this.snapshotListeners.add(cb)
    return () => this.snapshotListeners.delete(cb)
  }

  /**
   * app 2.4.0 (Share): relay one control action to the renderer executor and
   * await its result (10 s bound), as a phone ctl does. `label` names who
   * asked in the renderer's toasts. The caller validated the action.
   */
  relayAction(action: RemoteCtlAction, label?: string): Promise<RemoteCommandResult> {
    return this.relayCommand(action, label)
  }

  /**
   * app 2.4.0 (Share): another owner wants the renderer unthrottled (guests
   * connected) or lets go. Throttling is off while a phone is connected or
   * any hold is set.
   */
  setThrottleHold(key: string, on: boolean): void {
    if (on) this.throttleHolds.add(key)
    else this.throttleHolds.delete(key)
    this.applyThrottling(this.phoneConnected || this.throttleHolds.size > 0)
  }

  /** The window's main frame navigated (reload, crash recovery). */
  onRendererNavigate(): void {
    this.refitPending = true
  }

  // --- Phone-fit (E3 M11) -------------------------------------------------------

  /** remote:fitRelease: the strip's [Recover] / [Restore all] or a real key/paste (FR-17/19). */
  fitRelease(req: RemoteFitReleaseReq): void {
    if ('all' in req) void this.fit.releaseAll()
    else void this.fit.release(req.paneId)
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
      // app 2.4.0: the menu rides every state frame too, else the phone's
      // statusMapOf would drop the Chat card on the next pushState.
      const status = toRemoteStatus(evt, this.menus.menuFor(evt.paneId, evt.pending))
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
    // app 2.4.0: the watcher follows every request, phones or not, so a phone
    // that connects while a plan waits still gets its menu.
    this.menus.onStatus(evt)
    if (!this.sessions) return
    const paneId = evt.paneId
    const status = toRemoteStatus(evt, this.menus.menuFor(paneId, evt.pending))
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

  /** One pane's live status (what StatusManager.stateOf gives, through the snapshot getter), or null. */
  private paneStatusOf(paneId: string): PaneStatusEvt | null {
    return this.getPaneStatuses().find((evt) => evt.paneId === paneId) ?? null
  }

  /**
   * app 2.4.0 ctl answerMenu (SessionManager checked the session first): the
   * screen is read again here, at answer time, and only the digit is written
   * (never Enter) when the request is still pending and option `n` of the
   * validated menu still reads `label`.
   */
  answerMenu(action: Extract<RemoteCtlAction, { kind: 'answerMenu' }>): RemoteCommandResult {
    const evt = this.paneStatusOf(action.paneId)
    const pending = evt?.pending?.find((p) => p.id === action.pendingId)
    if (!evt || evt.state !== 'action' || !pending) return { id: '', ok: false, error: 'stale' }
    if (pending.kind !== 'plan' && pending.kind !== 'permission') return { id: '', ok: false, error: 'no_menu' }
    const ptyId = this.ptyManager.ptyIdForPane(action.paneId)
    const rows = ptyId ? (this.ptyManager.screenRows?.(action.paneId) ?? null) : null
    if (!ptyId || !rows) return { id: '', ok: false, error: 'no_menu' }
    const menu = validMenu(rows, pending.kind)
    // A menu of another layout replaced it (menu_changed); no menu at all is no_menu.
    if (!menu) return { id: '', ok: false, error: parseMenu(rows) ? 'menu_changed' : 'no_menu' }
    const option = menu.find((o) => o.n === action.n)
    if (!option || option.label !== action.label) return { id: '', ok: false, error: 'menu_changed' }
    this.ptyManager.write(ptyId, String(option.n), 'user')
    return { id: '', ok: true }
  }

  /** app 2.7.0 (A3): wire StatusManager's marks and plans (index.ts, right after both exist). */
  setStatusControl(ctl: RemoteStatusControl | null): void {
    this.statusControl = ctl
  }

  /**
   * app 2.7.0 (A3) ctls markRead / mutePane / silenceAck (SessionManager
   * checked the session first): StatusManager applies the mark and republishes
   * the pane; a mark that does not apply acks not_found. Nothing is written.
   */
  statusCtl(action: RemoteStatusCtl): RemoteCommandResult {
    const ctl = this.statusControl
    if (!ctl) return { id: '', ok: false, error: 'unknown_action' }
    const applied =
      action.kind === 'markRead' ? ctl.markRead(action.paneId)
      : action.kind === 'mutePane' ? ctl.setMuted(action.paneId, action.muted)
      : ctl.ackSilence(action.paneId)
    return applied === true ? { id: '', ok: true } : { id: '', ok: false, error: 'not_found' }
  }

  /** app 2.7.0 (A3) planReq: the plan StatusManager keeps for the pane, copied field by field. */
  private async planRequest(req: RemotePlanRequest): Promise<RemotePlanReply> {
    const plan = this.statusControl?.planOf(req.paneId, req.requestId) ?? null
    if (!plan) return { ok: false, error: 'not_found' }
    return { ok: true, plan: { requestId: plan.requestId, text: plan.text, at: plan.at, truncated: plan.truncated === true } }
  }

  // --- Control-plane relay --------------------------------------------------

  /** Wire the Chat view (index.ts, once the ChatHub exists). */
  setChat(chat: ChatHooks | null): void {
    this.chat = chat
  }

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
  private async executeCommand(action: RemoteCtlAction, deviceName?: string, fit?: RemoteCommandFit): Promise<RemoteCommandResult> {
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
    return this.relayCommand(action, deviceName, fit)
  }

  private relayCommand(action: RemoteCtlAction, deviceName?: string, fit?: RemoteCommandFit): Promise<RemoteCommandResult> {
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
      if (fit) cmd.fit = fit
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
    const payload = await this.pairing.begin(this.boundPort, this.secureHost)
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
    // E3 M14: its push subscriptions go with it.
    this.push.removeDevice(deviceId)
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
    const endpoints = this.getEndpoints(this.boundPort, this.secureHost)
    const live = new Set(endpoints.map((e) => e.ip ?? e.host))
    const recent = this.registry.lastHosts().find((h) => live.has(h.host))
    // A phone that last came in through the secure mode opens its https origin (E3-FR-43).
    if (recent && recent.host === this.secureHost) return `https://${recent.host}`
    const ip = recent?.host ?? endpoints.find((e) => e.kind === 'tailscale')?.ip ?? endpoints.find((e) => e.kind === 'lan')?.ip
    return ip ? `http://${ip}:${this.boundPort}` : null
  }

  /** Panes some phone is subscribed to (hibernation keeps them awake, E5-FR-25). */
  subscribedPaneIds(): Set<string> {
    return this.sessions?.subscribedPaneIds() ?? new Set()
  }

  /** A phone is watching this pane right now (subscribed, page visible, fresh); ntfy skips it. */
  isPaneViewed(paneId: string): boolean {
    return this.sessions?.isPaneViewed(paneId) ?? false
  }

  /** v2.3: a phone looks at this pane right now, Terminal or Chat (attention acks). */
  isPaneSeen(paneId: string): boolean {
    return this.sessions?.isPaneSeen(paneId) ?? false
  }

  /** v2.3: called when a phone with its page visible opens a pane or comes back to it. */
  setPaneSeenListener(cb: ((paneId: string) => void) | null): void {
    this.paneSeenListener = cb
  }

  // --- Git API for the phone (E7-FR-22..26) ------------------------------------

  /** Who answers gitReq (index.ts injects GitRemote over the app's GitService). */
  setGitHandler(handler: ((req: RemoteGitRequest) => Promise<RemoteGitReply>) | null): void {
    this.gitHandler = handler
  }

  private gitRequest(req: RemoteGitRequest): Promise<RemoteGitReply> {
    if (!this.gitHandler) return Promise.resolve({ ok: false, data: { error: 'not_found' }, page: 0, done: true })
    return this.gitHandler(req)
  }

  // --- Workspace notes for the phone (v2.2, E9) -----------------------------------

  setNotes(store: Pick<WsNoteStore, 'list' | 'read' | 'write' | 'create' | 'delete'> | null): void {
    this.notes = store
  }

  /** A note changed on the PC or on a phone: every phone reloads what it shows of that workspace. */
  notesChanged(evt: WsNotesChangedEvt): void {
    this.sessions?.broadcastNotesChanged(evt.workspaceId, evt.noteId)
  }

  /** One notesReq. The phone is never trusted: only a workspace the desktop has, ids only, never a path back. */
  private async notesRequest(req: RemoteNotesRequest): Promise<RemoteNotesReply> {
    const store = this.notes
    if (!store || !this.currentSnapshot().workspaces.some((w) => w.id === req.workspaceId)) return { ok: false, error: 'not_found' }
    return runNotesRequest(store, req)
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
      endpoints: this.statusState === 'running' ? listEndpoints(this.boundPort, this.secureHost) : [],
      connectedCount: this.sessions?.connectedCount ?? 0,
      error: this.statusError,
      ...(this.secureStatus.state !== 'off' || this.secureStatus.error ? { secure: this.secureStatus } : {}),
    }
  }

  private setStatus(state: RemoteServerState, error?: string): void {
    this.statusState = state
    this.statusError = error
    this.scheduleUi()
  }

  private onConnectionsChanged(): void {
    this.applyThrottling((this.sessions?.connectedCount ?? 0) > 0 || this.throttleHolds.size > 0)
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

export type NotesRequestStore = Pick<WsNoteStore, 'list' | 'read' | 'write' | 'create' | 'delete'>

/**
 * One notes request of a remote reader (a phone, or a share guest from app
 * 2.6.0), on a workspace the caller already checked. Never a path back; a
 * text past WS_NOTE_PHONE_MAX bytes is `too_large`, and so is a write over a
 * note bigger than that on disk (the reader only saw its start).
 */
export async function runNotesRequest(store: NotesRequestStore, req: RemoteNotesRequest): Promise<RemoteNotesReply> {
  const { workspaceId, noteId } = req
  if (req.text !== undefined && Buffer.byteLength(req.text, 'utf8') > WS_NOTE_PHONE_MAX) return { ok: false, error: 'too_large' }
  switch (req.op) {
    case 'list': {
      const res = await store.list(workspaceId)
      return res.ok ? { ok: true, notes: res.notes } : { ok: false, error: 'invalid' }
    }
    case 'read': {
      const res = await store.read({ workspaceId, noteId })
      return res.ok ? { ok: true, note: phoneNote(res.note) } : { ok: false, error: res.error }
    }
    case 'write': {
      if (typeof req.text !== 'string') return { ok: false, error: 'invalid' }
      const cur = await store.read({ workspaceId, noteId })
      if (cur.ok ? Buffer.byteLength(cur.note.text, 'utf8') > WS_NOTE_PHONE_MAX : cur.error === 'too_large') return { ok: false, error: 'too_large' }
      const res = await store.write({ workspaceId, noteId, text: req.text, ...(req.baseRev !== undefined ? { baseRev: req.baseRev } : {}) })
      if (res.ok) return { ok: true, note: res.note }
      return { ok: false, error: res.error, ...(res.current ? { current: phoneNote(res.current) } : {}) }
    }
    case 'create': {
      const res = await store.create({ workspaceId, text: req.text ?? '' })
      return res.ok ? { ok: true, note: res.note } : { ok: false, error: res.error }
    }
    case 'delete': {
      const res = await store.delete({ workspaceId, noteId })
      return res.ok ? { ok: true } : { ok: false, error: res.error }
    }
  }
  return { ok: false, error: 'invalid' }
}

/**
 * A note as the phone gets it: never its path; one past WS_NOTE_PHONE_MAX
 * UTF-8 bytes travels cut there (whole characters) and read-only.
 */
export function phoneNote(doc: WsNoteDoc): RemoteNote {
  const { path: _path, text, ...meta } = doc
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= WS_NOTE_PHONE_MAX) return { ...meta, text }
  return { ...meta, text: bytes.subarray(0, WS_NOTE_PHONE_MAX).toString('utf8').replace(/�+$/, ''), readOnly: true }
}
