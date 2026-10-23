/**
 * The Share host (app 2.4.0, item 8): the one object index.ts and the host
 * IPC talk to. It owns the grants, the listener (ShareServer), the guest
 * sessions (HostSessions), the data plane (PaneFanout, PtySink
 * `share-sessions`), the input arbiter and the status relay, and enforces
 * the scope of every grant:
 *  - the listener runs while `settings.share.enabled` is on and some grant
 *    has not expired, paused or not (a paused grant admits, the guest sees
 *    `paused`);
 *  - allowed panes are recomputed on every renderer snapshot
 *    (RemoteManager.onSnapshot) and on a pty spawn/exit (50 ms debounce): a
 *    pane grant follows its pane to any workspace; a closed pane suspends
 *    the grant (sessions end `scope_gone`) and a reopen inside the 10 min
 *    grace restores it, after that (or on the first snapshot after boot) it
 *    is deleted; a gone workspace deletes its grants;
 *  - each session's ShareState is filtered to the scope (never usage,
 *    accounts, quick commands, schedules, notes text, the git chip nor other
 *    workspaces) and pane statuses travel without `pending`/`attention`;
 *  - a frame naming a pane outside the scope gets `out_of_scope`, no strike;
 *  - on a workspace scope, each session's rights (app 2.6.0, set per grant
 *    and per guest, apart from the terminal perm) add the ctl allowlist
 *    (consoles: createPane from the snapshot's presets or a plain type, never
 *    prompt/resume/cwd, and closePane in the scope, both relayed to the
 *    renderer executor through RemoteManager.relayAction; a createPane ack
 *    adds its pane to the scope at once), read-only Chat and Git
 *    (status/diff), Notes (read, or read and write) and the read-only Files
 *    drawer. A v1 guest (app 2.4 / 2.5) gets the v1 caps only: notes it may
 *    write show read-only there, files do not exist for it.
 * Revoke order mirrors revokeDevice: out of memory, then the sessions die
 * (`ended{revoked}`, 4403), then the file is written.
 */
import {
  SHARE_CLOSE,
  SHARE_LIMITS,
  shareText,
  type ShareCaps,
  type ShareClientMsg,
  type ShareCtlError,
  type ShareFilesReply,
  type ShareHostMsg,
  type ShareHostPlatform,
  type ShareNotesOp,
  type ShareNotesReply,
  type SharePaneInfo,
  type SharePresetInfo,
  type ShareScopeKind,
  type ShareState,
} from '@shared/share-protocol'
import type {
  RemoteCommandResult,
  ShareCreateReq,
  ShareCreateRes,
  ShareExpiryChoice,
  ShareHostApproval,
  ShareHostConfig,
  ShareHostGrantView,
  ShareHostPaneGuests,
  ShareHostState,
  ShareInviteRes,
  ShareOpRes,
  ShareResolveReq,
  ShareUpdateReq,
} from '@shared/ipc-contract'
import type { RemoteCtlAction, RemoteGitReply, RemoteGitRequest, RemotePaneInfo, RemoteStateSnapshot, RemoteWorkspaceInfo } from '@shared/remote-protocol'
import type { PaneStatusEvt, SharePerm } from '@shared/types'
import { inGitDir, isSafeRel, relHasShareSecret, type FilesChangedEvt, type FilesListRes } from '@shared/files'
import { parseMenu } from '@shared/promptMenu'
import { shareStateImprecise } from '@shared/shareInput'
import { SHARE_RIGHTS_NONE, isShareRights, normalizeShareRights, remapShareRights, sameShareRights, shareCapsOf, type ShareBackends } from '@shared/shareRights'
import type { WsNoteError, WsNotesChangedEvt } from '@shared/ws-notes'
import type { GuestReadRes } from '../files/FileService'
import type { ChatFrame, ChatHooks } from '../chat/ChatHub'
import type { PtyInputOrigin } from '../pty/PtyManager'
import { GIT_REQ_IN_FLIGHT, GIT_REQ_MAX, GIT_REQ_WINDOW_MS, MAX_CHAT_SUBS, NOTES_REQ_IN_FLIGHT, NOTES_REQ_MAX, NOTES_REQ_WINDOW_MS, gitPathAllowed, recordGitPaths } from '../remote/SessionManager'
import { derivePasswordKey, keyFingerprint, newPasswordSalt, toB64u, type ShareKeyPair } from './crypto'
import { GrantStore, type ShareGrant } from './GrantStore'
import { HostSessions, type HostSession } from './HostSessions'
import { InputArbiter } from './InputArbiter'
import { encodeShareInvite, inviteEndpoints, shareLoopbackAllowed } from './invite'
import { PaneFanout, type FanoutPty } from './PaneFanout'
import { StatusCoalescer, toShareStatus, type StatusLike } from './StatusCoalescer'
import type { ShareListener } from './ShareServer'
import { fitFilesReply } from './shareFiles'
import type { ShareTransport } from './transport'
import { realShareClock, type ShareClock, type ShareTimer } from './clock'
import { devPort } from '../devPort'

export const SHARE_SCOPE_GRACE_MS = 10 * 60_000
export const SHARE_RUNNING_DEBOUNCE_MS = 50
export const SHARE_MAINTENANCE_MS = 5_000
export const SHARE_CTL_MAX = 6
export const SHARE_CTL_WINDOW_MS = 60_000
/** A createPane ack's pane counts as in scope this long before a snapshot lists it. */
export const SHARE_EXTRA_PANE_MS = 10_000
/** Files drawer requests per session (filesWatch counts too). */
export const SHARE_FILES_REQ_MAX = 40
export const SHARE_FILES_REQ_WINDOW_MS = 5_000
export const SHARE_FILES_REQ_IN_FLIGHT = 2
/** Note creates and deletes per session, on top of the notes bucket. */
export const SHARE_NOTES_OP_MAX = 10
export const SHARE_NOTES_OP_WINDOW_MS = 60_000

const EXPIRY_MS: Record<Exclude<ShareExpiryChoice, 'never'>, number> = { '1h': 3_600_000, '8h': 8 * 3_600_000, '24h': 24 * 3_600_000 }
const ID_RE = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/
const PERMS: readonly SharePerm[] = ['view', 'type', 'full']
const PERM_RANK: Record<SharePerm, number> = { view: 0, type: 1, full: 2 }

const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)
const isPerm = (v: unknown): v is SharePerm => typeof v === 'string' && (PERMS as readonly string[]).includes(v)
const isExpiry = (v: unknown): v is ShareExpiryChoice => v === 'never' || v === '1h' || v === '8h' || v === '24h'
const NO_BACKENDS: ShareBackends = { chat: false, git: false, notes: false, files: false }
const REV_RE = /^\d{1,20}-\d{1,20}$/
const oneLine = (v: unknown, max: number): string => (typeof v === 'string' ? shareText(v, max) : '')

/** The PtyManager surface the host uses. */
export interface ShareHostPty extends FanoutPty {
  ptyIdForPane(paneId: string): string | null
  write(ptyId: string, data: string, origin: PtyInputOrigin): void
  /** The pane's screen rows (PtyManager.screenRows), for an agent with no precise state; null when unreadable. */
  screenRows?(paneId: string): string[] | null
}

/** One notes request on the scoped workspace (the caller checked the caps). */
export interface ShareHostNotesReq {
  workspaceId: string
  op: ShareNotesOp
  noteId?: string
  text?: string
  baseRev?: string
}

/** FileService as a share guest reads it: never `.git` nor a secret name, bounded. */
export interface ShareHostFiles {
  list(workspaceId: string, rel: string, max: number): Promise<FilesListRes>
  read(workspaceId: string, rel: string, limits: { textMax: number; imageMax: number }): Promise<GuestReadRes>
  acquireWatch(workspaceId: string, owner: string, cb: (evt: FilesChangedEvt) => void): boolean
  releaseWatch(workspaceId: string, owner: string): void
}

export interface ShareHostDeps {
  pty: ShareHostPty
  remote: {
    snapshot(): RemoteStateSnapshot | null
    relayAction(action: RemoteCtlAction, label?: string): Promise<RemoteCommandResult>
  }
  grants: GrantStore
  /** The host static key (created on first use). */
  hostKey(): ShareKeyPair
  /** Makes the listener for a port (tests: an in-memory one). */
  listen(port: number, onTransport: (t: ShareTransport) => void): ShareListener
  /** Reachable addresses (network.listEndpoints). */
  endpoints(port: number): ReadonlyArray<{ ip?: string; kind: 'lan' | 'tailscale' | 'tailscaleHttps' | 'other'; virtual?: boolean }>
  appVersion: string
  platform: ShareHostPlatform
  hostLabel(): string
  /** Live agent statuses (StatusManager.snapshot) for the gate's agent rules. */
  statuses?(): PaneStatusEvt[]
  chat?(): ChatHooks | null
  git?(): ((req: RemoteGitRequest) => Promise<RemoteGitReply>) | null
  notes?(): ((req: ShareHostNotesReq) => Promise<ShareNotesReply>) | null
  /** The workspace folder a guest reads (FileService's guest half), app 2.6.0. */
  files?(): ShareHostFiles | null
  /** Highest protocol version offered (tests: 1 plays an app 2.5 host). */
  protocol?: { max: number }
  /** "<name> (guest)" for the renderer's toasts (i18n in main). */
  guestLabel(name: string): string
  /** Localized "Guest". */
  guestFallback(): string
  onHostEvent?(state: ShareHostState): void
  onPanes?(panes: ShareHostPaneGuests[]): void
  /** Admitted guests count changed (presence and the renderer throttle hold). */
  onGuestsChanged?(count: number): void
  onApproval?(approval: ShareHostApproval): void
  clock?: ShareClock
  /** Default: SNAOS_SHARE_LOOPBACK=1. */
  allowLoopback?: boolean
}

export class ShareHost {
  private readonly clock: ShareClock
  readonly sessions: HostSessions
  readonly fanout: PaneFanout<HostSession>
  readonly arbiter: InputArbiter<HostSession>
  private readonly coalescer: StatusCoalescer
  private config: ShareHostConfig = { enabled: false, port: 4527 }
  private server: ShareListener | null = null
  private boundPort = 0
  private listening: ShareHostState['listening'] = 'off'
  private listenError: string | undefined
  private pausedAll = false
  private snap: RemoteStateSnapshot | null = null
  /** False until the first renderer snapshot was evaluated: a pane grant missing then is deleted at once. */
  private settled = false
  private readonly allowed = new Map<string, Set<string>>()
  private readonly extras = new Map<string, Map<string, number>>()
  private readonly suspended = new Map<string, { at: number; timer: ShareTimer }>()
  /** Live agent statuses (StatusManager), authoritative when `deps.statuses` exists; else the snapshot's. */
  private readonly statusMap = new Map<string, StatusLike>()
  private readonly statusLive: boolean
  private runningTimer: ShareTimer | null = null
  private maintenanceTimer: ShareTimer | null = null
  private uiScheduled = false
  private panesScheduled = false
  private lastGuestCount = 0
  private readonly allowLoopback: boolean
  /** grantId -> the workspace folder watched for its guests' Files drawers. */
  private readonly filesWatches = new Map<string, string>()

  constructor(private readonly deps: ShareHostDeps) {
    this.clock = deps.clock ?? realShareClock
    this.allowLoopback = deps.allowLoopback ?? shareLoopbackAllowed()
    this.statusLive = typeof deps.statuses === 'function'
    for (const evt of deps.statuses?.() ?? []) if (evt.state != null) this.statusMap.set(evt.paneId, evt)
    this.coalescer = new StatusCoalescer((paneId, status) => {
      for (const s of this.sessions.admitted()) {
        if (!this.isPaused(s) && this.allowedFor(s.grantId).has(paneId)) this.sessions.send(s, { t: 'paneStatus', paneId, status })
      }
    }, this.clock)
    this.sessions = new HostSessions({
      grants: deps.grants,
      hostKey: () => deps.hostKey(),
      appVersion: deps.appVersion,
      hostLabel: () => deps.hostLabel(),
      platform: deps.platform,
      guestFallback: () => deps.guestFallback(),
      grantGate: (grant) => (this.expired(grant) ? 'expired' : this.suspended.has(grant.id) ? 'scope_gone' : 'ok'),
      scopeOf: (grant) => this.scopeOf(grant),
      welcomeState: (session) => {
        const state = this.buildState(session)
        session.stateKey = JSON.stringify(state)
        return state
      },
      onAdmitted: (session) => this.onAdmitted(session),
      onMessage: (session, msg) => this.onMessage(session, msg),
      onClosed: (session, wasAdmitted) => this.onClosed(session, wasAdmitted),
      onApprovalsChanged: () => this.scheduleUi(),
      onApprovalRequest: (a) => deps.onApproval?.(a),
      clock: this.clock,
      ...(deps.protocol ? { protocolMax: deps.protocol.max } : {}),
    })
    this.fanout = new PaneFanout<HostSession>({
      pty: deps.pty,
      send: (s, msg) => this.sessions.send(s, msg),
      bufferedAmount: (s) => s.transport.bufferedAmount(),
      terminate: (s) => this.sessions.close(s, SHARE_CLOSE.GOING_AWAY, 'backpressure'),
      streaming: (s) => s.phase === 'admitted' && !this.isPaused(s),
      clock: this.clock,
      onUserInput: (paneId, data, origin) => this.arbiter.onPtyInput(paneId, data, origin),
      onRunningChange: () => this.scheduleRunningRefresh(),
    })
    this.arbiter = new InputArbiter<HostSession>({
      write: (paneId, data) => {
        const ptyId = deps.pty.ptyIdForPane(paneId)
        if (!ptyId) return false
        deps.pty.write(ptyId, data, 'auto')
        return true
      },
      send: (s, msg) => this.sessions.send(s, msg),
      watchers: (paneId) => this.fanout.sessionsFor(paneId),
      ctxFor: (paneId) => this.ctxFor(paneId),
      permOf: (s) => s.perm,
      paused: (s) => this.isPaused(s),
      clock: this.clock,
      onLeaseChange: () => {
        this.schedulePanes()
        this.scheduleUi()
      },
    })
    this.snap = deps.remote.snapshot()
    if (this.snap) this.refreshScopes()
  }

  /** The PtySink to add to PtyManager. */
  get sink(): PaneFanout<HostSession> {
    return this.fanout
  }

  get guestCount(): number {
    return this.sessions.admitted().length
  }

  get port(): number {
    return this.config.port
  }

  /** Panes some guest watches as Terminal or Chat (hibernation keeps them awake). */
  subscribedPaneIds(): Set<string> {
    const ids = this.fanout.subscribedPaneIds()
    for (const s of this.sessions.admitted()) for (const p of s.chatSubs) ids.add(p)
    return ids
  }

  // --- Config and the listener ------------------------------------------------------

  applyConfig(cfg: Partial<ShareHostConfig> | null | undefined): void {
    const valid = Number.isInteger(cfg?.port) && cfg!.port! >= 1024 && cfg!.port! <= 65535 ? cfg!.port! : 4527
    // Plan A1.3: a worktree dev instance moves the default port (devPort.ts).
    const port = devPort(valid, 4527)
    this.config = { enabled: cfg?.enabled === true, port }
    this.syncListener(true)
    this.scheduleUi()
  }

  private wantListen(): boolean {
    return this.config.enabled && this.deps.grants.list().some((g) => !this.expired(g))
  }

  private syncListener(force = false): void {
    if (!this.wantListen()) {
      if (this.server || this.listening !== 'off') this.stopListener('sharing_off')
      return
    }
    if (this.server && this.boundPort === this.config.port && this.listening !== 'error') return
    if (!force && this.listening === 'error' && this.boundPort === this.config.port) return
    this.stopListener('sharing_off')
    this.startListener(this.config.port)
  }

  private startListener(port: number): void {
    this.boundPort = port
    this.listening = 'starting'
    this.listenError = undefined
    const server = this.deps.listen(port, (t) => {
      if (this.server === server) this.sessions.attach(t)
      else t.close(SHARE_CLOSE.GOING_AWAY, 'sharing_off')
    })
    this.server = server
    if (this.maintenanceTimer === null) this.maintenanceTimer = this.clock.setInterval(() => this.maintenance(), SHARE_MAINTENANCE_MS)
    server
      .start()
      .then(() => {
        if (this.server !== server) return
        this.listening = 'running'
        this.scheduleUi()
      })
      .catch((err: unknown) => {
        if (this.server !== server) return
        const code = (err as NodeJS.ErrnoException | null)?.code
        this.listenError = code === 'EADDRINUSE' ? `Port ${port} is already in use.` : code === 'EACCES' ? `Port ${port} needs elevated privileges.` : err instanceof Error ? err.message : 'listen failed'
        this.listening = 'error'
        this.server = null
        try {
          server.close()
        } catch {
          /* ignore */
        }
        this.scheduleUi()
      })
    this.scheduleUi()
  }

  private stopListener(reason: 'sharing_off' | 'host_quit'): void {
    this.sessions.shutdown(reason)
    if (this.server) {
      try {
        this.server.close()
      } catch {
        /* ignore */
      }
    }
    this.server = null
    this.listening = 'off'
    this.listenError = undefined
    if (this.maintenanceTimer !== null) this.clock.clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = null
    this.scheduleUi()
  }

  /** Every 5 s while listening: keepalive, backpressure, expiry, stale createPane extras. */
  maintenance(): void {
    this.sessions.maintenance()
    this.fanout.maintenance()
    const now = this.clock.now()
    let changed = false
    for (const g of this.deps.grants.list()) {
      if (this.expired(g) && this.sessions.all().some((s) => s.grantId === g.id)) {
        this.sessions.endGrant(g.id, 'expired')
        this.sessions.dropTickets(g.id)
        changed = true
      }
    }
    for (const [grantId, m] of this.extras) {
      let dropped = false
      for (const [paneId, at] of m) {
        if (now - at <= SHARE_EXTRA_PANE_MS) continue
        m.delete(paneId)
        dropped = true
      }
      if (m.size === 0) this.extras.delete(grantId)
      // A createPane pane no snapshot ever listed leaves the scope with its grace.
      const grant = dropped ? this.deps.grants.get(grantId) : undefined
      if (grant && this.snap) {
        this.allowed.set(grantId, this.computeAllowed(grant))
        for (const s of this.sessions.admitted()) if (s.grantId === grantId) this.applyScope(s)
      }
    }
    if (changed) {
      this.syncListener()
      this.scheduleUi()
    } else if (!this.wantListen()) this.syncListener()
  }

  shutdown(): void {
    this.stopListener('host_quit')
    for (const s of this.suspended.values()) this.clock.clearTimeout(s.timer)
    this.suspended.clear()
    if (this.runningTimer !== null) this.clock.clearTimeout(this.runningTimer)
    this.runningTimer = null
    this.fanout.dispose()
    this.arbiter.dispose()
    this.coalescer.reset()
  }

  // --- Inputs from main -------------------------------------------------------------

  /** RemoteManager.onSnapshot: the renderer pushed a snapshot (running and status overlaid). */
  onSnapshot(snap: RemoteStateSnapshot): void {
    this.snap = snap
    this.refreshScopes()
  }

  /** StatusManager listener. */
  onPaneStatus(evt: PaneStatusEvt): void {
    if (evt.state == null) this.statusMap.delete(evt.paneId)
    else this.statusMap.set(evt.paneId, evt)
    if (this.sessions.admitted().length === 0) return
    this.coalescer.push(evt.paneId, toShareStatus(evt))
  }

  /** A note changed: guests reading that workspace's notes reload (a v2 one skips the echo of its own save by `rev`). */
  notesChanged(evt: WsNotesChangedEvt): void {
    const noteId = evt.noteId && /^[A-Za-z0-9_-]{1,64}$/.test(evt.noteId) ? evt.noteId : undefined
    const rev = typeof evt.rev === 'string' && REV_RE.test(evt.rev) ? evt.rev : undefined
    for (const s of this.sessions.admitted()) {
      const grant = this.deps.grants.get(s.grantId)
      if (!grant || grant.scope.kind !== 'workspace' || grant.scope.workspaceId !== evt.workspaceId || !this.capsFor(s, grant).notes || this.isPaused(s)) continue
      this.sessions.send(s, { t: 'notesChanged', ...(noteId ? { noteId } : {}), ...(rev && s.version >= 2 ? { rev } : {}) })
    }
  }

  /** The watched folder of a grant changed: its guests with the Files drawer open reload those folders. */
  private filesChanged(grantId: string, evt: FilesChangedEvt): void {
    let msg: Extract<ShareHostMsg, { t: 'filesChanged' }>
    if (evt.all) msg = { t: 'filesChanged', dirs: [], all: true }
    else {
      // A folder the guest cannot see is not named (a secret one, `.git`).
      const dirs = evt.dirs.filter((d) => isSafeRel(d) && !inGitDir(d) && !relHasShareSecret(d))
      if (!dirs.length) return
      msg = dirs.length > SHARE_LIMITS.filesChangedDirsMax ? { t: 'filesChanged', dirs: [], all: true } : { t: 'filesChanged', dirs }
    }
    const grant = this.deps.grants.get(grantId)
    if (!grant) return
    for (const s of this.sessions.admitted()) {
      if (s.grantId !== grantId || !s.filesWatch || s.version < 2 || this.isPaused(s) || !this.capsFor(s, grant).files) continue
      this.sessions.send(s, msg)
    }
  }

  /** Hold the grant's folder watch while some guest of it has the Files drawer open, release it after. */
  private syncFilesWatch(grantId: string): void {
    const files = this.deps.files?.()
    const g = this.deps.grants.get(grantId)
    const workspaceId = g?.scope.kind === 'workspace' ? g.scope.workspaceId : undefined
    const want = !!files && !!workspaceId && this.sessions.admitted().some((s) => s.grantId === grantId && s.filesWatch)
    const owner = `share:${grantId}`
    const held = this.filesWatches.get(grantId)
    if (held !== undefined && (!want || held !== workspaceId)) {
      files?.releaseWatch(held, owner)
      this.filesWatches.delete(grantId)
    }
    if (!want || !files || !workspaceId || this.filesWatches.has(grantId)) return
    if (files.acquireWatch(workspaceId, owner, (evt) => this.filesChanged(grantId, evt))) this.filesWatches.set(grantId, workspaceId)
  }

  // --- Scope ----------------------------------------------------------------------

  private expired(g: ShareGrant): boolean {
    return g.expiresAt !== undefined && this.clock.now() >= g.expiresAt
  }

  private isPaused(s: HostSession): boolean {
    if (this.pausedAll) return true
    return this.deps.grants.get(s.grantId)?.paused === true
  }

  private findPane(paneId: string): { ws: RemoteWorkspaceInfo; pane: RemotePaneInfo } | null {
    for (const ws of this.snap?.workspaces ?? []) {
      const pane = ws.panes.find((p) => p.id === paneId)
      if (pane) return { ws, pane }
    }
    return null
  }

  private findWorkspace(id: string): RemoteWorkspaceInfo | undefined {
    return this.snap?.workspaces.find((w) => w.id === id)
  }

  allowedFor(grantId: string): ReadonlySet<string> {
    return this.allowed.get(grantId) ?? new Set()
  }

  private computeAllowed(g: ShareGrant): Set<string> {
    if (g.scope.kind === 'pane') return this.findPane(g.scope.paneId) ? new Set([g.scope.paneId]) : new Set()
    const ws = this.findWorkspace(g.scope.workspaceId)
    const out = new Set<string>(ws?.panes.map((p) => p.id) ?? [])
    const extra = this.extras.get(g.id)
    if (extra) {
      for (const paneId of [...extra.keys()]) {
        if (out.has(paneId)) extra.delete(paneId)
        else out.add(paneId)
      }
    }
    return out
  }

  /** Recompute every grant's scope against the snapshot and apply it to the sessions. */
  private refreshScopes(): void {
    if (!this.snap) return
    // An empty first state (a store that failed to load) never deletes grants.
    if (!this.settled && this.snap.workspaces.length === 0) return
    for (const g of this.deps.grants.list()) {
      if (g.scope.kind === 'pane') {
        const found = this.findPane(g.scope.paneId)
        if (found) {
          const sus = this.suspended.get(g.id)
          if (sus) {
            this.clock.clearTimeout(sus.timer)
            this.suspended.delete(g.id)
          }
          if (found.ws.id !== g.scope.workspaceId) this.deps.grants.update(g.id, { scope: { kind: 'pane', paneId: g.scope.paneId, workspaceId: found.ws.id } })
        } else if (!this.settled) {
          this.removeGrant(g.id, 'scope_gone')
          continue
        } else if (!this.suspended.has(g.id)) {
          const timer = this.clock.setTimeout(() => {
            if (this.suspended.has(g.id)) this.removeGrant(g.id, 'scope_gone')
          }, SHARE_SCOPE_GRACE_MS)
          this.suspended.set(g.id, { at: this.clock.now(), timer })
          this.sessions.endGrant(g.id, 'scope_gone')
        }
      } else if (!this.findWorkspace(g.scope.workspaceId)) {
        this.removeGrant(g.id, 'scope_gone')
        continue
      }
      this.allowed.set(g.id, this.computeAllowed(g))
    }
    this.settled = true
    for (const s of this.sessions.admitted()) this.applyScope(s)
    this.scheduleUi()
  }

  private applyScope(s: HostSession): void {
    const allowed = this.allowedFor(s.grantId)
    for (const paneId of [...this.fanout.subsOf(s)]) {
      if (allowed.has(paneId)) continue
      this.fanout.unsub(s, paneId)
      this.arbiter.dropPane(s, paneId)
    }
    for (const paneId of [...s.chatSubs]) {
      if (allowed.has(paneId)) continue
      s.chatSubs.delete(paneId)
      this.deps.chat?.()?.unsub(s, paneId)
    }
    this.pushState(s)
    this.schedulePanes()
  }

  private scheduleRunningRefresh(): void {
    if (this.runningTimer !== null) return
    this.runningTimer = this.clock.setTimeout(() => {
      this.runningTimer = null
      const fresh = this.deps.remote.snapshot()
      if (fresh) this.snap = fresh
      for (const s of this.sessions.admitted()) this.pushState(s)
    }, SHARE_RUNNING_DEBOUNCE_MS)
  }

  private scopeOf(g: ShareGrant): { kind: ShareScopeKind; label: string } {
    let label = g.label
    if (!label) {
      if (g.scope.kind === 'pane') label = this.findPane(g.scope.paneId)?.pane.title ?? ''
      else label = this.findWorkspace(g.scope.workspaceId)?.name ?? ''
    }
    return { kind: g.scope.kind, label: shareText(label, SHARE_LIMITS.labelMax) }
  }

  private capsFor(s: HostSession, g: ShareGrant): ShareCaps {
    return shareCapsOf(s.rights, g.scope.kind, s.version, { chat: !!this.deps.chat?.(), git: !!this.deps.git?.(), notes: !!this.deps.notes?.(), files: !!this.deps.files?.() })
  }

  private paneInfo(p: RemotePaneInfo): SharePaneInfo | null {
    if (!isId(p.id)) return null
    const type = p.type === 'shell' || p.type === 'claude' || p.type === 'codex' || p.type === 'custom' ? p.type : 'shell'
    const info: SharePaneInfo = {
      id: p.id,
      title: shareText(p.title ?? '', SHARE_LIMITS.titleMax),
      type,
      color: shareText(String(p.color ?? ''), 32),
      icon: shareText(String(p.icon ?? ''), 64),
      running: p.running === true,
    }
    if (!info.running && Number.isInteger(p.exitCode)) info.exitCode = p.exitCode
    const status = toShareStatus(this.statusOf(p))
    if (status) info.status = status
    return info
  }

  buildState(s: HostSession): ShareState {
    const g = this.deps.grants.get(s.grantId)
    const caps: ShareCaps = g ? this.capsFor(s, g) : shareCapsOf(SHARE_RIGHTS_NONE, 'pane', s.version, NO_BACKENDS)
    const allowed = this.allowedFor(s.grantId)
    const ws = g ? (g.scope.kind === 'pane' ? this.findPane(g.scope.paneId)?.ws : this.findWorkspace(g.scope.workspaceId)) : undefined
    const panes: SharePaneInfo[] = []
    const seen = new Set<string>()
    for (const w of this.snap?.workspaces ?? []) {
      for (const p of w.panes) {
        if (!allowed.has(p.id) || seen.has(p.id) || panes.length >= SHARE_LIMITS.panesMax) continue
        const info = this.paneInfo(p)
        if (!info) continue
        seen.add(p.id)
        panes.push(info)
      }
    }
    const layoutOrder = (g?.scope.kind === 'pane' ? [g.scope.paneId] : (ws?.layoutOrder ?? [])).filter((id) => seen.has(id)).slice(0, SHARE_LIMITS.panesMax)
    const state: ShareState = {
      scope: g ? this.scopeOf(g) : { kind: 'pane', label: '' },
      perm: s.perm,
      title: shareText(ws?.name ?? '', SHARE_LIMITS.titleMax),
      layoutOrder,
      panes,
      terminalUnicode11: this.snap?.terminalUnicode === '11',
      hostPlatform: this.deps.platform,
      caps,
    }
    if (caps.createPane) {
      const presets: SharePresetInfo[] = []
      for (const p of this.snap?.presets ?? []) {
        if (presets.length >= SHARE_LIMITS.presetsMax || !isId(p.id)) continue
        const type = p.type === 'shell' || p.type === 'claude' || p.type === 'codex' || p.type === 'custom' ? p.type : 'shell'
        presets.push({ id: p.id, name: shareText(p.name ?? '', SHARE_LIMITS.labelMax), type, icon: shareText(String(p.icon ?? ''), 64), color: shareText(String(p.color ?? ''), 32) })
      }
      state.presets = presets
    }
    return state
  }

  private pushState(s: HostSession, force = false): void {
    if (s.phase !== 'admitted') return
    const state = this.buildState(s)
    const key = JSON.stringify(state)
    if (!force && key === s.stateKey) return
    s.stateKey = key
    this.sessions.send(s, { t: 'state', state })
    for (const p of state.panes) this.coalescer.markSent(p.id, p.status ?? null)
  }

  /** The pane's status now: the live one (a snapshot's can be up to a push old). */
  private statusOf(pane: RemotePaneInfo | undefined, paneId = pane?.id ?? ''): StatusLike | undefined {
    return this.statusLive ? this.statusMap.get(paneId) : pane?.status
  }

  private ctxFor(paneId: string): { agent: boolean; state?: StatusLike['state']; precise?: boolean; screenMenu?: boolean } {
    const pane = this.findPane(paneId)?.pane
    const st = this.statusOf(pane, paneId)
    const agent = pane?.type === 'claude' || pane?.type === 'codex' || !!st?.hosted || st?.provider === 'claude' || st?.provider === 'codex'
    const ctx = { agent, state: st?.state ?? null, ...(st?.precise === false ? { precise: false } : {}) }
    // app 2.5.0: an agent with no precise state (over SSH, no hooks) is judged by its screen.
    if (!shareStateImprecise(ctx)) return ctx
    const rows = this.deps.pty.screenRows?.(paneId) ?? null
    return rows ? { ...ctx, screenMenu: parseMenu(rows) != null } : ctx
  }

  // --- Sessions -------------------------------------------------------------------

  private onAdmitted(s: HostSession): void {
    s.pausedSent = this.isPaused(s)
    if (s.pausedSent) this.sessions.send(s, { t: 'paused', on: true })
    this.guestsChanged()
  }

  private onClosed(s: HostSession, wasAdmitted: boolean): void {
    this.fanout.removeSession(s)
    this.arbiter.dropSession(s)
    if (s.chatSubs.size) this.deps.chat?.()?.closed(s)
    s.chatSubs.clear()
    if (s.filesWatch) {
      s.filesWatch = false
      this.syncFilesWatch(s.grantId)
    }
    if (wasAdmitted) this.guestsChanged()
    this.scheduleUi()
  }

  private guestsChanged(): void {
    const n = this.guestCount
    if (n !== this.lastGuestCount) {
      this.lastGuestCount = n
      this.deps.onGuestsChanged?.(n)
    }
    this.schedulePanes()
    this.scheduleUi()
  }

  private syncPause(): void {
    for (const s of this.sessions.admitted()) {
      const p = this.isPaused(s)
      if (p === s.pausedSent) continue
      s.pausedSent = p
      this.sessions.send(s, { t: 'paused', on: p })
      if (p) this.fanout.dropPending(s)
      else {
        this.fanout.resyncAll(s)
        this.pushState(s, true)
      }
    }
  }

  private onMessage(s: HostSession, msg: ShareClientMsg): void {
    const allowed = this.allowedFor(s.grantId)
    switch (msg.t) {
      case 'sub': {
        if (!allowed.has(msg.paneId)) return this.sessions.send(s, { t: 'err', code: 'out_of_scope' })
        this.fanout.sub(s, msg.paneId)
        const lock = this.arbiter.lockFor(s, msg.paneId)
        if (lock) this.sessions.send(s, { t: 'inputLock', paneId: msg.paneId, holder: lock })
        this.schedulePanes()
        this.scheduleUi()
        return
      }
      case 'unsub':
        this.fanout.unsub(s, msg.paneId)
        this.arbiter.dropPane(s, msg.paneId)
        this.schedulePanes()
        this.scheduleUi()
        return
      case 'resync':
        if (!allowed.has(msg.paneId)) return this.sessions.send(s, { t: 'err', code: 'out_of_scope' })
        return this.fanout.resync(s, msg.paneId)
      case 'input':
        if (!allowed.has(msg.paneId)) return this.sessions.send(s, { t: 'inputDenied', paneId: msg.paneId, seq: msg.seq, reason: 'out_of_scope' })
        return this.arbiter.input(s, msg)
      case 'ctl':
        void this.handleCtl(s, msg)
        return
      case 'chatSub':
        return this.chatSub(s, msg.paneId)
      case 'chatUnsub':
        if (!s.chatSubs.delete(msg.paneId)) return
        this.deps.chat?.()?.unsub(s, msg.paneId)
        return
      case 'chatMore': {
        if (!s.chatSubs.has(msg.paneId) || this.isPaused(s)) return
        const offset = Number(msg.before)
        if (!Number.isSafeInteger(offset) || offset < 0) return
        this.deps.chat?.()?.more(s, msg.paneId, offset, this.chatSender(s))
        return
      }
      case 'gitReq':
        void this.handleGit(s, msg)
        return
      case 'notesReq':
        void this.handleNotes(s, msg)
        return
      case 'filesReq':
        if (s.version < 2) return this.sessions.send(s, { t: 'err', code: 'unsupported' })
        void this.handleFiles(s, msg)
        return
      case 'filesWatch':
        if (s.version < 2) return this.sessions.send(s, { t: 'err', code: 'unsupported' })
        return this.filesWatch(s, msg.on)
      default:
        this.sessions.send(s, { t: 'err', code: 'unsupported' })
    }
  }

  /**
   * A rights change took a cap away: the chats it read end now, so no
   * transcript keeps flowing to a session that may not read it, and its Files
   * watch goes. Ctl, git, notes and files check the caps on every request.
   */
  private enforceCaps(s: HostSession): void {
    const g = this.deps.grants.get(s.grantId)
    const caps = g ? this.capsFor(s, g) : null
    if (!caps?.chat) {
      for (const paneId of [...s.chatSubs]) {
        s.chatSubs.delete(paneId)
        this.deps.chat?.()?.unsub(s, paneId)
      }
    }
    if (!caps?.files && s.filesWatch) {
      s.filesWatch = false
      this.syncFilesWatch(s.grantId)
    }
  }

  private chatSender(s: HostSession): (frame: ChatFrame) => void {
    return (frame) => {
      if (s.phase !== 'admitted' || !s.chatSubs.has(frame.paneId) || this.isPaused(s)) return
      const g = this.deps.grants.get(s.grantId)
      if (!g || !this.capsFor(s, g).chat) return
      if (frame.type === 'chatPage') this.sessions.send(s, { t: 'chatPage', paneId: frame.paneId, items: frame.items, cursor: frame.cursor, done: frame.done })
      else this.sessions.send(s, { t: 'chatAppend', paneId: frame.paneId, items: frame.items })
    }
  }

  private chatSub(s: HostSession, paneId: string): void {
    const g = this.deps.grants.get(s.grantId)
    const chat = this.deps.chat?.()
    if (!g || !this.capsFor(s, g).chat || !chat) return this.sessions.send(s, { t: 'err', code: 'unauthorized' })
    if (!this.allowedFor(s.grantId).has(paneId)) return this.sessions.send(s, { t: 'err', code: 'out_of_scope' })
    if (this.isPaused(s)) return this.sessions.send(s, { t: 'err', code: 'paused' })
    if (!s.chatSubs.has(paneId) && s.chatSubs.size >= MAX_CHAT_SUBS) {
      return this.sessions.send(s, { t: 'chatPage', paneId, items: [{ id: 'notice', role: 'system', ts: null, blocks: [{ t: 'notice', code: 'noTranscript' }] }], cursor: null, done: true })
    }
    s.chatSubs.add(paneId)
    chat.sub(s, paneId, this.chatSender(s))
  }

  private async handleCtl(s: HostSession, msg: Extract<ShareClientMsg, { t: 'ctl' }>): Promise<void> {
    const ack = (ok: boolean, extra: { paneId?: string; error?: ShareCtlError } = {}): void => this.sessions.send(s, { t: 'ctlAck', id: msg.id, ok, ...extra })
    const g = this.deps.grants.get(s.grantId)
    if (!g || g.scope.kind !== 'workspace') return ack(false, { error: 'denied' })
    const caps = this.capsFor(s, g)
    if (msg.op === 'closePane' ? !caps.closePane : !caps.createPane) return ack(false, { error: 'denied' })
    if (this.isPaused(s)) return ack(false, { error: 'denied' })
    const now = this.clock.now()
    s.ctlTimes = s.ctlTimes.filter((t) => now - t < SHARE_CTL_WINDOW_MS)
    if (s.ctlTimes.length >= SHARE_CTL_MAX) return ack(false, { error: 'rate' })
    s.ctlTimes.push(now)
    const workspaceId = g.scope.workspaceId
    let action: RemoteCtlAction
    if (msg.op === 'closePane') {
      const found = this.findPane(msg.paneId)
      if (!this.allowedFor(g.id).has(msg.paneId) || !found || found.ws.id !== workspaceId) return ack(false, { error: 'out_of_scope' })
      action = { kind: 'closePane', workspaceId, paneId: msg.paneId }
    } else if (msg.presetId !== undefined) {
      if (!(this.snap?.presets ?? []).some((p) => p.id === msg.presetId)) return ack(false, { error: 'bad_preset' })
      // Only the preset id: never a prompt, a resume or a cwd from a guest.
      action = { kind: 'createPane', workspaceId, presetId: msg.presetId }
    } else {
      action = { kind: 'createPane', workspaceId, paneType: msg.paneType ?? 'shell' }
    }
    let res: RemoteCommandResult
    try {
      res = await this.deps.remote.relayAction(action, this.deps.guestLabel(s.guestName))
    } catch {
      res = { id: '', ok: false, error: 'failed' }
    }
    if (s.phase !== 'admitted') return
    if (!res.ok) return ack(false, { error: 'failed' })
    if (msg.op === 'createPane' && isId(res.paneId)) {
      // The new pane is in the scope now, before the debounced snapshot lists it.
      const grant = this.deps.grants.get(g.id)
      if (grant) {
        let m = this.extras.get(g.id)
        if (!m) {
          m = new Map()
          this.extras.set(g.id, m)
        }
        m.set(res.paneId, this.clock.now())
        this.allowed.set(g.id, this.computeAllowed(grant))
        for (const other of this.sessions.admitted()) if (other.grantId === g.id) this.pushState(other)
      }
      return ack(true, { paneId: res.paneId })
    }
    ack(true)
  }

  private async handleGit(s: HostSession, msg: Extract<ShareClientMsg, { t: 'gitReq' }>): Promise<void> {
    const g = this.deps.grants.get(s.grantId)
    const handler = this.deps.git?.()
    const notFound = (): void => this.sessions.send(s, { t: 'gitRes', id: msg.id, ok: false, data: { error: 'not_found' }, page: 0, done: true })
    if (!g || !handler || !this.capsFor(s, g).git || this.isPaused(s)) return notFound()
    const now = this.clock.now()
    s.gitTimes = s.gitTimes.filter((t) => now - t < GIT_REQ_WINDOW_MS)
    if (s.gitTimes.length >= GIT_REQ_MAX || s.gitInFlight >= GIT_REQ_IN_FLIGHT) {
      return this.sessions.send(s, { t: 'gitRes', id: msg.id, ok: false, data: { error: 'rate' }, page: 0, done: true })
    }
    s.gitTimes.push(now)
    // Always the scoped workspace: a guest never names one.
    const req: RemoteGitRequest = { workspaceId: g.scope.workspaceId, op: msg.op }
    if (msg.path !== undefined) req.path = msg.path
    if (msg.staged !== undefined) req.staged = msg.staged
    if (msg.page !== undefined) req.page = msg.page
    if (!gitPathAllowed(s.gitPaths, req)) return notFound()
    let reply: RemoteGitReply
    s.gitInFlight += 1
    try {
      reply = await handler(req)
    } catch {
      reply = { ok: false, data: { error: 'git_error' }, page: 0, done: true }
    } finally {
      s.gitInFlight -= 1
    }
    recordGitPaths(s.gitPaths, req, reply)
    if (s.phase === 'admitted') this.sessions.send(s, { t: 'gitRes', id: msg.id, ...reply })
  }

  private async handleNotes(s: HostSession, msg: Extract<ShareClientMsg, { t: 'notesReq' }>): Promise<void> {
    const fail = (error: WsNoteError): void => this.sessions.send(s, { t: 'notesRes', id: msg.id, ok: false, error })
    const g = this.deps.grants.get(s.grantId)
    const notes = this.deps.notes?.()
    const caps = g ? this.capsFor(s, g) : null
    // Write, create and delete need notesWrite, which only a v2 session can hold.
    const writes = msg.op === 'write' || msg.op === 'create' || msg.op === 'delete'
    if (!g || !notes || !caps || !(writes ? caps.notesWrite : caps.notes) || this.isPaused(s)) return fail('not_found')
    const now = this.clock.now()
    s.notesTimes = s.notesTimes.filter((t) => now - t < NOTES_REQ_WINDOW_MS)
    if (s.notesTimes.length >= NOTES_REQ_MAX || s.notesInFlight >= NOTES_REQ_IN_FLIGHT) return fail('rate')
    if (msg.op === 'create' || msg.op === 'delete') {
      s.notesOpTimes = s.notesOpTimes.filter((t) => now - t < SHARE_NOTES_OP_WINDOW_MS)
      if (s.notesOpTimes.length >= SHARE_NOTES_OP_MAX) return fail('rate')
      s.notesOpTimes.push(now)
    }
    s.notesTimes.push(now)
    // Always the scoped workspace: a guest never names one.
    const req: ShareHostNotesReq = { workspaceId: g.scope.workspaceId, op: msg.op }
    if ('noteId' in msg && msg.noteId !== undefined) req.noteId = msg.noteId
    if ('text' in msg && msg.text !== undefined) req.text = msg.text
    if ('baseRev' in msg && msg.baseRev !== undefined) req.baseRev = msg.baseRev
    let reply: ShareNotesReply
    s.notesInFlight += 1
    try {
      reply = await notes(req)
    } catch {
      reply = { ok: false, error: 'io' }
    } finally {
      s.notesInFlight -= 1
    }
    if (s.phase !== 'admitted') return
    // `current` (the conflict copy) is v2.
    const { current, ...rest } = reply
    this.sessions.send(s, { t: 'notesRes', id: msg.id, ...rest, ...(current && s.version >= 2 ? { current } : {}) })
  }

  private takeFilesSlot(s: HostSession): boolean {
    const now = this.clock.now()
    s.filesTimes = s.filesTimes.filter((t) => now - t < SHARE_FILES_REQ_WINDOW_MS)
    if (s.filesTimes.length >= SHARE_FILES_REQ_MAX) return false
    s.filesTimes.push(now)
    return true
  }

  private async handleFiles(s: HostSession, msg: Extract<ShareClientMsg, { t: 'filesReq' }>): Promise<void> {
    const send = (reply: ShareFilesReply): void => {
      if (s.phase === 'admitted') this.sessions.send(s, { t: 'filesRes', id: msg.id, ...fitFilesReply(reply) })
    }
    const g = this.deps.grants.get(s.grantId)
    const files = this.deps.files?.()
    if (!g || !files || g.scope.kind !== 'workspace' || !this.capsFor(s, g).files || this.isPaused(s)) return send({ ok: false, error: 'not_found' })
    if (s.filesInFlight >= SHARE_FILES_REQ_IN_FLIGHT || !this.takeFilesSlot(s)) return send({ ok: false, error: 'rate' })
    // Always the scoped workspace: a guest never names one.
    const workspaceId = g.scope.workspaceId
    let reply: ShareFilesReply
    s.filesInFlight += 1
    try {
      if (msg.op === 'list') {
        const res = await files.list(workspaceId, msg.rel, SHARE_LIMITS.filesListMax)
        reply = res.ok ? { ok: true, entries: res.entries, truncated: res.truncated } : { ok: false, error: res.error }
      } else {
        const res = await files.read(workspaceId, msg.rel, { textMax: SHARE_LIMITS.fileTextMax, imageMax: SHARE_LIMITS.fileImageMax })
        if (!res.ok) reply = { ok: false, error: res.error }
        else if (res.kind === 'image') reply = { ok: true, file: { kind: 'image', dataUrl: res.dataUrl, size: res.size, rev: res.rev } }
        else reply = { ok: true, file: { kind: 'text', text: res.text, eol: res.eol, bom: res.bom, rev: res.rev, size: res.size, ...(res.partial ? { partial: true } : {}) } }
      }
    } catch {
      reply = { ok: false, error: 'io' }
    } finally {
      s.filesInFlight -= 1
    }
    send(reply)
  }

  /** The guest's Files drawer opened or closed: its grant's folder watch follows. */
  private filesWatch(s: HostSession, on: boolean): void {
    if (on === s.filesWatch) return
    const g = this.deps.grants.get(s.grantId)
    if (on && (!g || !this.capsFor(s, g).files)) return this.sessions.send(s, { t: 'err', code: 'unauthorized' })
    if (!this.takeFilesSlot(s)) return this.sessions.send(s, { t: 'err', code: 'rate' })
    s.filesWatch = on
    this.syncFilesWatch(s.grantId)
  }

  // --- Host API (registerShareHostIpc) ------------------------------------------------

  hostState(): ShareHostState {
    const port = this.config.port
    let fingerprint: string | undefined
    if (this.deps.grants.list().length > 0) {
      try {
        fingerprint = keyFingerprint(this.deps.hostKey().pub)
      } catch {
        fingerprint = undefined
      }
    }
    return {
      enabled: this.config.enabled,
      port,
      listening: this.listening,
      ...(this.listenError ? { error: this.listenError } : {}),
      pausedAll: this.pausedAll,
      encryption: this.deps.grants.persisted,
      ...(fingerprint ? { fingerprint } : {}),
      endpoints: this.endpointsFor(port),
      grants: this.deps.grants.list().map((g) => this.grantView(g)),
      approvals: this.sessions.approvals(),
    }
  }

  private endpointsFor(port: number): ShareHostState['endpoints'] {
    try {
      return inviteEndpoints(this.deps.endpoints(port), port, this.allowLoopback)
    } catch {
      return []
    }
  }

  private grantView(g: ShareGrant): ShareHostGrantView {
    const sessions = this.sessions.admitted().filter((s) => s.grantId === g.id)
    return {
      id: g.id,
      label: this.scopeOf(g).label,
      scope: g.scope,
      perm: g.perm,
      rights: { ...g.rights },
      hasPassword: !!g.password,
      createdAt: g.createdAt,
      ...(g.expiresAt !== undefined ? { expiresAt: g.expiresAt } : {}),
      paused: g.paused,
      expired: this.expired(g),
      suspended: this.suspended.has(g.id),
      knownGuests: g.knownGuests.length,
      sessions: sessions.map((s) => ({
        id: s.id,
        grantId: g.id,
        name: s.guestName,
        ip: s.ip,
        fingerprint: s.fingerprint,
        perm: s.perm,
        rights: { ...s.rights },
        ...(s.version < 2 ? { legacy: true as const } : {}),
        since: s.since,
        watching: this.fanout.subsOf(s).size,
        typing: [...this.fanout.subsOf(s)].some((p) => this.arbiter.guestHolder(p) === s),
      })),
    }
  }

  panes(): ShareHostPaneGuests[] {
    const out: ShareHostPaneGuests[] = []
    for (const paneId of this.fanout.subscribedPaneIds()) {
      const guests = [...this.fanout.sessionsFor(paneId)].filter((s) => s.phase === 'admitted').map((s) => ({ sessionId: s.id, name: s.guestName, perm: s.perm }))
      if (!guests.length) continue
      const holder = this.arbiter.guestHolder(paneId)
      out.push({ paneId, guests, ...(holder ? { typing: holder.guestName } : {}) })
    }
    return out
  }

  async create(req: ShareCreateReq): Promise<ShareCreateRes> {
    if (!req || typeof req !== 'object' || !isPerm(req.perm)) return { ok: false, error: 'invalid' }
    if (req.rights !== undefined && !isShareRights(req.rights)) return { ok: false, error: 'invalid' }
    const scopeReq = req.scope as { kind?: unknown; paneId?: unknown; workspaceId?: unknown } | undefined
    if (req.expiry !== undefined && !isExpiry(req.expiry)) return { ok: false, error: 'invalid' }
    if (req.password !== undefined && !this.validPassword(req.password)) return { ok: false, error: 'invalid' }
    if (req.label !== undefined && typeof req.label !== 'string') return { ok: false, error: 'invalid' }
    if (!this.snap) return { ok: false, error: 'scope_gone' }
    let scope: ShareGrant['scope']
    let fallbackLabel: string
    if (scopeReq?.kind === 'pane' && isId(scopeReq.paneId)) {
      const found = this.findPane(scopeReq.paneId)
      if (!found) return { ok: false, error: 'scope_gone' }
      scope = { kind: 'pane', paneId: found.pane.id, workspaceId: found.ws.id }
      fallbackLabel = found.pane.title
    } else if (scopeReq?.kind === 'workspace' && isId(scopeReq.workspaceId)) {
      const ws = this.findWorkspace(scopeReq.workspaceId)
      if (!ws) return { ok: false, error: 'scope_gone' }
      scope = { kind: 'workspace', workspaceId: ws.id }
      fallbackLabel = ws.name
    } else return { ok: false, error: 'invalid' }
    if (req.password && !this.deps.grants.persisted) return { ok: false, error: 'encryption_unavailable' }
    if (this.endpointsFor(this.config.port).length === 0) return { ok: false, error: 'no_endpoint' }
    try {
      this.deps.hostKey()
    } catch {
      return { ok: false, error: 'invalid' }
    }
    const label = oneLine(req.label, SHARE_LIMITS.labelMax) || shareText(fallbackLabel, SHARE_LIMITS.labelMax)
    const expiresAt = req.expiry && req.expiry !== 'never' ? this.clock.now() + EXPIRY_MS[req.expiry] : undefined
    const grant = this.deps.grants.create({ label, scope, perm: req.perm, ...(req.rights ? { rights: req.rights } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) })
    if (!grant) return { ok: false, error: 'limit' }
    this.allowed.set(grant.id, this.computeAllowed(grant))
    if (req.password) {
      const r = await this.setPassword(grant.id, req.password)
      if (!r.ok) {
        this.removeGrant(grant.id, 'revoked')
        return r
      }
    }
    const inv = this.invite(grant.id)
    if (!inv.ok) {
      this.removeGrant(grant.id, 'revoked')
      return inv
    }
    this.syncListener()
    this.scheduleUi()
    return { ok: true, grant: this.grantView(grant), invite: inv.invite }
  }

  invite(grantId: unknown): ShareInviteRes {
    if (!isId(grantId)) return { ok: false, error: 'invalid' }
    const g = this.deps.grants.get(grantId)
    if (!g) return { ok: false, error: 'not_found' }
    const port = this.config.port
    const e = this.endpointsFor(port)
    if (e.length === 0) return { ok: false, error: 'no_endpoint' }
    try {
      const invite = encodeShareInvite(
        {
          v: 1,
          h: shareText(this.deps.hostLabel(), SHARE_LIMITS.hostLabelMax),
          pk: toB64u(this.deps.hostKey().pub),
          s: g.shareId,
          k: toB64u(g.inviteKey),
          e,
          sc: { k: g.scope.kind, l: this.scopeOf(g).label },
          pm: g.perm,
          ...(g.expiresAt !== undefined ? { x: g.expiresAt } : {}),
        },
        { allowLoopback: this.allowLoopback },
      )
      return { ok: true, invite }
    } catch {
      return { ok: false, error: 'invalid' }
    }
  }

  rotate(grantId: unknown): ShareInviteRes {
    if (!isId(grantId) || !this.deps.grants.rotate(grantId)) return { ok: false, error: 'not_found' }
    this.scheduleUi()
    return this.invite(grantId)
  }

  update(req: ShareUpdateReq): ShareOpRes {
    if (!req || typeof req !== 'object' || !isId(req.grantId)) return { ok: false, error: 'invalid' }
    if (req.perm !== undefined && !isPerm(req.perm)) return { ok: false, error: 'invalid' }
    if (req.rights !== undefined && !isShareRights(req.rights)) return { ok: false, error: 'invalid' }
    if (req.expiry !== undefined && !isExpiry(req.expiry)) return { ok: false, error: 'invalid' }
    if (req.paused !== undefined && typeof req.paused !== 'boolean') return { ok: false, error: 'invalid' }
    if (req.label !== undefined && typeof req.label !== 'string') return { ok: false, error: 'invalid' }
    const g = this.deps.grants.get(req.grantId)
    if (!g) return { ok: false, error: 'not_found' }
    const permChanged = req.perm !== undefined && req.perm !== g.perm
    const oldPerm = g.perm
    const oldRights = { ...g.rights }
    this.deps.grants.update(g.id, {
      ...(req.perm ? { perm: req.perm } : {}),
      ...(req.rights ? { rights: req.rights } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.expiry !== undefined ? { expiresAt: req.expiry === 'never' ? null : this.clock.now() + EXPIRY_MS[req.expiry] } : {}),
      ...(req.paused !== undefined ? { paused: req.paused } : {}),
    })
    if (permChanged) {
      // The grant perm applies to every live session of it, and to their
      // tickets. One below the old grant perm was lowered on purpose (the join
      // prompt or sessionPerm): a grant change may lower it, never raise it.
      const newPerm = g.perm
      const next = (p: SharePerm): SharePerm => (PERM_RANK[p] < PERM_RANK[oldPerm] ? ShareHost.minPerm(p, newPerm) : newPerm)
      this.sessions.remapTicketPerms(g.id, next)
      for (const s of this.sessions.admitted()) {
        if (s.grantId !== g.id) continue
        const p = next(s.perm)
        if (p === s.perm) continue
        s.perm = p
        this.sessions.send(s, { t: 'permChanged', perm: s.perm })
        this.enforceCaps(s)
      }
    }
    if (!sameShareRights(oldRights, g.rights)) {
      // The same rule as the perm, field by field (remapShareRights).
      const newRights = { ...g.rights }
      const next = (r: typeof newRights): typeof newRights => normalizeShareRights(g.scope.kind, remapShareRights(r, oldRights, newRights))
      this.sessions.remapTicketRights(g.id, next)
      for (const s of this.sessions.admitted()) {
        if (s.grantId !== g.id) continue
        const r = next(s.rights)
        if (sameShareRights(r, s.rights)) continue
        s.rights = r
        this.enforceCaps(s)
      }
    }
    this.syncPause()
    for (const s of this.sessions.admitted()) if (s.grantId === g.id) this.pushState(s)
    this.syncListener()
    this.scheduleUi()
    this.schedulePanes()
    return { ok: true }
  }

  private validPassword(pw: unknown): pw is string {
    return typeof pw === 'string' && pw.length >= SHARE_LIMITS.passwordMin && pw.length <= SHARE_LIMITS.passwordMax
  }

  async setPassword(grantId: unknown, password: unknown): Promise<ShareOpRes> {
    if (!isId(grantId)) return { ok: false, error: 'invalid' }
    if (!this.deps.grants.get(grantId)) return { ok: false, error: 'not_found' }
    if (password === null) {
      this.deps.grants.setPassword(grantId, null)
      this.scheduleUi()
      return { ok: true }
    }
    if (!this.validPassword(password)) return { ok: false, error: 'invalid' }
    if (!this.deps.grants.persisted) return { ok: false, error: 'encryption_unavailable' }
    const salt = newPasswordSalt()
    let key: Buffer
    try {
      key = await derivePasswordKey(password, salt)
    } catch {
      return { ok: false, error: 'invalid' }
    }
    // Revoked while scrypt ran: never brought back.
    const r = this.deps.grants.setPassword(grantId, { salt, key })
    this.scheduleUi()
    return r === 'ok' ? { ok: true } : { ok: false, error: r }
  }

  revoke(grantId: unknown): ShareOpRes {
    if (!isId(grantId) || !this.deps.grants.get(grantId)) return { ok: false, error: 'not_found' }
    this.removeGrant(grantId, 'revoked')
    return { ok: true }
  }

  /** Revoke order: out of memory, the sessions end, then the file. */
  private removeGrant(grantId: string, reason: 'revoked' | 'scope_gone'): void {
    const existed = this.deps.grants.deleteInMemory(grantId)
    this.sessions.endGrant(grantId, reason)
    this.sessions.dropTickets(grantId)
    if (existed) this.deps.grants.persist()
    this.allowed.delete(grantId)
    this.extras.delete(grantId)
    const sus = this.suspended.get(grantId)
    if (sus) this.clock.clearTimeout(sus.timer)
    this.suspended.delete(grantId)
    this.syncListener()
    this.scheduleUi()
  }

  kick(sessionId: unknown): ShareOpRes {
    const s = isId(sessionId) ? this.sessions.byId(sessionId) : undefined
    if (!s || s.phase !== 'admitted') return { ok: false, error: 'not_found' }
    this.sessions.dropTickets(s.grantId, s.guestKey)
    this.sessions.end(s, 'kicked')
    return { ok: true }
  }

  sessionPerm(sessionId: unknown, perm: unknown): ShareOpRes {
    if (!isPerm(perm)) return { ok: false, error: 'invalid' }
    const s = isId(sessionId) ? this.sessions.byId(sessionId) : undefined
    if (!s || s.phase !== 'admitted') return { ok: false, error: 'not_found' }
    if (s.perm !== perm) {
      s.perm = perm
      this.sessions.setTicketPerm(s.grantId, s.guestKey, perm)
      this.sessions.send(s, { t: 'permChanged', perm })
      this.enforceCaps(s)
      this.pushState(s)
    }
    this.scheduleUi()
    this.schedulePanes()
    return { ok: true }
  }

  /** One guest's rights, exactly (Settings > Sharing). */
  sessionRights(sessionId: unknown, rights: unknown): ShareOpRes {
    if (!isShareRights(rights)) return { ok: false, error: 'invalid' }
    const s = isId(sessionId) ? this.sessions.byId(sessionId) : undefined
    const g = s ? this.deps.grants.get(s.grantId) : undefined
    if (!s || s.phase !== 'admitted' || !g) return { ok: false, error: 'not_found' }
    const next = normalizeShareRights(g.scope.kind, rights)
    if (!sameShareRights(next, s.rights)) {
      s.rights = next
      this.sessions.setTicketRights(s.grantId, s.guestKey, next)
      this.enforceCaps(s)
      this.pushState(s)
    }
    this.scheduleUi()
    return { ok: true }
  }

  pauseAll(on: unknown): ShareOpRes {
    this.pausedAll = on === true
    this.syncPause()
    this.scheduleUi()
    return { ok: true }
  }

  resolve(req: ShareResolveReq): void {
    if (!req || typeof req !== 'object' || typeof req.requestId !== 'string' || typeof req.allow !== 'boolean') return
    if (req.perm !== undefined && !isPerm(req.perm)) return
    if (req.rights !== undefined && !isShareRights(req.rights)) return
    this.sessions.resolve(req.requestId, req.allow, req.perm, req.rights)
    this.scheduleUi()
  }

  /** The lower of two perms (tests and the UI). */
  static minPerm(a: SharePerm, b: SharePerm): SharePerm {
    return PERM_RANK[a] <= PERM_RANK[b] ? a : b
  }

  // --- UI pushes --------------------------------------------------------------------

  private scheduleUi(): void {
    if (this.uiScheduled || !this.deps.onHostEvent) return
    this.uiScheduled = true
    queueMicrotask(() => {
      this.uiScheduled = false
      try {
        this.deps.onHostEvent?.(this.hostState())
      } catch {
        /* the window may be gone */
      }
    })
  }

  private schedulePanes(): void {
    if (this.panesScheduled || !this.deps.onPanes) return
    this.panesScheduled = true
    queueMicrotask(() => {
      this.panesScheduled = false
      try {
        this.deps.onPanes?.(this.panes())
      } catch {
        /* the window may be gone */
      }
    })
  }
}
