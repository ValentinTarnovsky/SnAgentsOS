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
 *  - `full` on a workspace scope adds the ctl allowlist (createPane from the
 *    snapshot's presets or a plain type, never prompt/resume/cwd, and
 *    closePane in the scope, both relayed to the renderer executor through
 *    RemoteManager.relayAction; a createPane ack adds its pane to the scope
 *    at once) and read-only Chat, Notes (list/read) and Git (status/diff).
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
  type ShareHostPlatform,
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
import type { WsNotesChangedEvt } from '@shared/ws-notes'
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
import type { ShareTransport } from './transport'
import { realShareClock, type ShareClock, type ShareTimer } from './clock'

export const SHARE_SCOPE_GRACE_MS = 10 * 60_000
export const SHARE_RUNNING_DEBOUNCE_MS = 50
export const SHARE_MAINTENANCE_MS = 5_000
export const SHARE_CTL_MAX = 6
export const SHARE_CTL_WINDOW_MS = 60_000
/** A createPane ack's pane counts as in scope this long before a snapshot lists it. */
export const SHARE_EXTRA_PANE_MS = 10_000

const EXPIRY_MS: Record<Exclude<ShareExpiryChoice, 'never'>, number> = { '1h': 3_600_000, '8h': 8 * 3_600_000, '24h': 24 * 3_600_000 }
const ID_RE = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/
const PERMS: readonly SharePerm[] = ['view', 'type', 'full']
const PERM_RANK: Record<SharePerm, number> = { view: 0, type: 1, full: 2 }

const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)
const isPerm = (v: unknown): v is SharePerm => typeof v === 'string' && (PERMS as readonly string[]).includes(v)
const isExpiry = (v: unknown): v is ShareExpiryChoice => v === 'never' || v === '1h' || v === '8h' || v === '24h'
const oneLine = (v: unknown, max: number): string => (typeof v === 'string' ? shareText(v, max) : '')

/** The PtyManager surface the host uses. */
export interface ShareHostPty extends FanoutPty {
  ptyIdForPane(paneId: string): string | null
  write(ptyId: string, data: string, origin: PtyInputOrigin): void
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
  notes?(): ((req: { workspaceId: string; op: 'list' | 'read'; noteId?: string }) => Promise<ShareNotesReply>) | null
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
    const port = Number.isInteger(cfg?.port) && cfg!.port! >= 1024 && cfg!.port! <= 65535 ? cfg!.port! : 4527
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

  /** A note changed: guests reading that workspace's notes reload. */
  notesChanged(evt: WsNotesChangedEvt): void {
    const noteId = evt.noteId && /^[A-Za-z0-9_-]{1,64}$/.test(evt.noteId) ? evt.noteId : undefined
    for (const s of this.sessions.admitted()) {
      const grant = this.deps.grants.get(s.grantId)
      if (!grant || grant.scope.workspaceId !== evt.workspaceId || !this.capsFor(s, grant).notes || this.isPaused(s)) continue
      this.sessions.send(s, { t: 'notesChanged', ...(noteId ? { noteId } : {}) })
    }
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
    const full = s.perm === 'full' && g.scope.kind === 'workspace'
    return {
      createPane: full,
      closePane: full,
      chat: full && !!this.deps.chat?.(),
      notes: full && !!this.deps.notes?.(),
      git: full && !!this.deps.git?.(),
    }
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
    const caps: ShareCaps = g ? this.capsFor(s, g) : { createPane: false, closePane: false, chat: false, notes: false, git: false }
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

  private ctxFor(paneId: string): { agent: boolean; state?: StatusLike['state']; precise?: boolean } {
    const pane = this.findPane(paneId)?.pane
    const st = this.statusOf(pane, paneId)
    const agent = pane?.type === 'claude' || pane?.type === 'codex' || !!st?.hosted || st?.provider === 'claude' || st?.provider === 'codex'
    return { agent, state: st?.state ?? null, ...(st?.precise === false ? { precise: false } : {}) }
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
      default:
        this.sessions.send(s, { t: 'err', code: 'unsupported' })
    }
  }

  /**
   * A perm change took a cap away (full -> type or view): the chats it read
   * end now, so no transcript keeps flowing to a session that may not read
   * it. Ctl, git and notes check the caps on every request.
   */
  private enforceCaps(s: HostSession): void {
    const g = this.deps.grants.get(s.grantId)
    if (g && this.capsFor(s, g).chat) return
    for (const paneId of [...s.chatSubs]) {
      s.chatSubs.delete(paneId)
      this.deps.chat?.()?.unsub(s, paneId)
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
    const g = this.deps.grants.get(s.grantId)
    const notes = this.deps.notes?.()
    if (!g || !notes || !this.capsFor(s, g).notes || this.isPaused(s)) return this.sessions.send(s, { t: 'notesRes', id: msg.id, ok: false, error: 'not_found' })
    const now = this.clock.now()
    s.notesTimes = s.notesTimes.filter((t) => now - t < NOTES_REQ_WINDOW_MS)
    if (s.notesTimes.length >= NOTES_REQ_MAX || s.notesInFlight >= NOTES_REQ_IN_FLIGHT) return this.sessions.send(s, { t: 'notesRes', id: msg.id, ok: false, error: 'rate' })
    s.notesTimes.push(now)
    let reply: ShareNotesReply
    s.notesInFlight += 1
    try {
      reply = await notes({ workspaceId: g.scope.workspaceId, op: msg.op, ...(msg.noteId !== undefined ? { noteId: msg.noteId } : {}) })
    } catch {
      reply = { ok: false, error: 'io' }
    } finally {
      s.notesInFlight -= 1
    }
    if (s.phase === 'admitted') this.sessions.send(s, { t: 'notesRes', id: msg.id, ...reply })
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
    const grant = this.deps.grants.create({ label, scope, perm: req.perm, ...(expiresAt !== undefined ? { expiresAt } : {}) })
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
    if (req.expiry !== undefined && !isExpiry(req.expiry)) return { ok: false, error: 'invalid' }
    if (req.paused !== undefined && typeof req.paused !== 'boolean') return { ok: false, error: 'invalid' }
    if (req.label !== undefined && typeof req.label !== 'string') return { ok: false, error: 'invalid' }
    const g = this.deps.grants.get(req.grantId)
    if (!g) return { ok: false, error: 'not_found' }
    const permChanged = req.perm !== undefined && req.perm !== g.perm
    const oldPerm = g.perm
    this.deps.grants.update(g.id, {
      ...(req.perm ? { perm: req.perm } : {}),
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

  pauseAll(on: unknown): ShareOpRes {
    this.pausedAll = on === true
    this.syncPause()
    this.scheduleUi()
    return { ok: true }
  }

  resolve(req: ShareResolveReq): void {
    if (!req || typeof req !== 'object' || typeof req.requestId !== 'string' || typeof req.allow !== 'boolean') return
    if (req.perm !== undefined && !isPerm(req.perm)) return
    this.sessions.resolve(req.requestId, req.allow, req.perm)
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
