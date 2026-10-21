/**
 * Guest facade of desktop sharing (app 2.4.0, item 8, stage S2): the links
 * this PC joined, one LinkConnection each, and the fan-out to the renderer.
 *
 * - Every argument from the renderer is `unknown` here and validated (link id
 *   by regex, pane ids bounded, input <= SHARE_LIMITS.pasteMax per call).
 * - Terminal frames of a link are batched every 16 ms into `share:stream`
 *   (consecutive `out` of a pane joined); the link's batch is flushed before
 *   every `share:linkEvent`, so a state never overtakes the output before it.
 * - Renderer backpressure: `share:flow {pause}` stops forwarding `out` and
 *   `replay` of that pane and marks it dirty; the resume asks the host for a
 *   `resync` (a fresh replay) when anything was dropped.
 * - Shared links never reach config.json, the phone snapshot nor the CLI:
 *   they live in LinkStore and in this process only.
 */
import { CH } from '@shared/ipc-channels'
import { SHARE_LIMITS } from '@shared/share-protocol'
import {
  SHARE_LINK_ID_RE,
  type ShareChatEvt,
  type ShareFlowReq,
  type ShareGuestCtlRes,
  type ShareGuestGitRes,
  type ShareGuestNotesRes,
  type ShareJoinRes,
  type ShareLinkEvt,
  type ShareLinksRes,
  type ShareLinkView,
  type SharePasswordRes,
  type SharePreviewRes,
  type ShareStreamEvt,
  type ShareStreamItem,
} from '@shared/share-guest'
import { keyFingerprint, type ShareKeyPair } from '../crypto'
import { parseShareInvite } from '../invite'
import type { LinkStore } from './LinkStore'
import { LinkConnection, type LinkConnectionDeps, type LinkLive } from './ShareClient'

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const GIT_PATH_MAX = 1024
/** One renderer item of joined output stays under this. */
const OUT_JOIN_MAX = 256 * 1024

export interface ShareGuestDeps {
  store: LinkStore
  /** This PC's guest static key (created on first use; one ShareIdentityStore shared with the host side). */
  guestIdentity(): ShareKeyPair
  /** Its fingerprint without creating it (null before the first join). */
  guestFingerprint(): string | null
  /** This PC's own public keys (host and guest roles, base64url): an invite to ourselves is `self`. */
  ownKeys(): string[]
  /** settings.share.guestName, else the device name. */
  guestName(): string
  app: string
  send(channel: string, payload: unknown): void
  /** Default: SNAOS_SHARE_LOOPBACK=1 (dev and E2E). */
  allowLoopback?: boolean
  now?: () => number
  batchMs?: number
  /** Test seams of every connection (dialer, timers, backoff). */
  connection?: Partial<Pick<LinkConnectionDeps, 'dial' | 'timers' | 'now' | 'random' | 'tune'>>
}

function isLinkId(v: unknown): v is string {
  return typeof v === 'string' && SHARE_LINK_ID_RE.test(v)
}

function isPaneId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128 && !CONTROL_RE.test(v)
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export class ShareGuest {
  private readonly conns = new Map<string, LinkConnection>()
  private readonly queue = new Map<string, ShareStreamItem[]>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** linkId -> paneId -> dirty (something was dropped while paused). */
  private readonly flow = new Map<string, Map<string, boolean>>()
  private disposed = false
  private readonly now: () => number

  constructor(private readonly deps: ShareGuestDeps) {
    this.now = deps.now ?? Date.now
  }

  // --- Links ---

  preview(invite: unknown): SharePreviewRes {
    const r = parseShareInvite(invite, { allowLoopback: this.deps.allowLoopback, ownKeys: this.deps.ownKeys() })
    if (!r.ok) return { ok: false, error: r.error }
    const inv = r.invite
    const existing = this.deps.store.findByShare(inv.pk, inv.s)
    return {
      ok: true,
      preview: {
        hostLabel: inv.h,
        hostFingerprint: keyFingerprint(Buffer.from(inv.pk, 'base64url')),
        scope: { kind: inv.sc.k, label: inv.sc.l },
        perm: inv.pm,
        ...(inv.x !== undefined ? { expiresAt: inv.x } : {}),
        expired: inv.x !== undefined && inv.x < this.now(),
        endpoints: inv.e.map((e) => ({ address: e.a, port: e.p, kind: e.t })),
        ...(existing ? { existingId: existing.id } : {}),
      },
    }
  }

  join(invite: unknown): ShareJoinRes {
    if (this.disposed) return { ok: false, error: 'unavailable' }
    const r = parseShareInvite(invite, { allowLoopback: this.deps.allowLoopback, ownKeys: this.deps.ownKeys() })
    if (!r.ok) return { ok: false, error: r.error }
    let up: ReturnType<LinkStore['upsertFromInvite']>
    try {
      up = this.deps.store.upsertFromInvite(r.invite)
    } catch {
      return { ok: false, error: 'format' }
    }
    if (!up.ok) return { ok: false, error: up.error }
    const conn = this.conn(up.link.id)
    // A refreshed invite (rotated key, new endpoints) dials again from scratch.
    if (!up.created && conn.status !== 'idle' && conn.status !== 'ended') conn.stop()
    conn.start()
    return { ok: true, link: this.view(up.link.id)! }
  }

  links(): ShareLinksRes {
    return {
      persisted: this.deps.store.persisted,
      guestFingerprint: this.deps.guestFingerprint(),
      links: this.deps.store
        .list()
        .map((l) => this.view(l.id))
        .filter((v): v is ShareLinkView => v !== null),
    }
  }

  connect(linkId: unknown): boolean {
    if (this.disposed || !isLinkId(linkId) || !this.deps.store.get(linkId)) return false
    this.conn(linkId).start()
    return true
  }

  disconnect(linkId: unknown): boolean {
    if (!isLinkId(linkId)) return false
    const c = this.conns.get(linkId)
    if (!c) return this.deps.store.get(linkId) !== null
    c.stop()
    this.dropFlow(linkId)
    return true
  }

  forget(linkId: unknown): boolean {
    if (!isLinkId(linkId)) return false
    const c = this.conns.get(linkId)
    if (c) {
      c.dispose()
      this.conns.delete(linkId)
    }
    this.dropFlow(linkId)
    this.queue.delete(linkId)
    const removed = this.deps.store.remove(linkId)
    if (removed) this.emit({ t: 'removed', linkId })
    return removed
  }

  /** At startup: links with a remembered password reconnect on their own (unattended); the rest wait for the user. */
  autoConnect(): void {
    for (const l of this.deps.store.list()) if (this.deps.store.password(l.id)) this.conn(l.id).start()
  }

  async password(req: unknown): Promise<SharePasswordRes> {
    const o = obj(req)
    if (!o || !isLinkId(o.linkId) || typeof o.password !== 'string' || o.password.length > SHARE_LIMITS.passwordMax * 4) {
      return { ok: false, error: 'invalid' }
    }
    const c = this.conns.get(o.linkId)
    if (!c) return { ok: false, error: 'offline' }
    return c.password(o.password, o.remember === true)
  }

  // --- Requests ---

  async ctl(req: unknown): Promise<ShareGuestCtlRes> {
    const o = obj(req)
    if (!o || !isLinkId(o.linkId)) return { ok: false, error: 'failed' }
    const c = this.conns.get(o.linkId)
    if (!c) return { ok: false, error: 'offline' }
    if (o.op === 'createPane') {
      if (o.presetId !== undefined && !isPaneId(o.presetId)) return { ok: false, error: 'bad_preset' }
      if (o.paneType !== undefined && o.paneType !== 'shell' && o.paneType !== 'claude' && o.paneType !== 'codex') return { ok: false, error: 'failed' }
      return c.ctl({
        linkId: o.linkId,
        op: 'createPane',
        ...(o.presetId !== undefined ? { presetId: o.presetId as string } : {}),
        ...(o.paneType !== undefined ? { paneType: o.paneType as 'shell' | 'claude' | 'codex' } : {}),
      })
    }
    if (o.op === 'closePane' && isPaneId(o.paneId)) return c.ctl({ linkId: o.linkId, op: 'closePane', paneId: o.paneId })
    return { ok: false, error: 'failed' }
  }

  async git(req: unknown): Promise<ShareGuestGitRes> {
    const o = obj(req)
    if (!o || !isLinkId(o.linkId) || (o.op !== 'status' && o.op !== 'diff')) return { ok: false, error: 'invalid' }
    const c = this.conns.get(o.linkId)
    if (!c) return { ok: false, error: 'offline' }
    const out: { op: 'status' | 'diff'; path?: string; staged?: boolean; page?: number } = { op: o.op }
    if (o.path !== undefined) {
      const p = o.path
      if (typeof p !== 'string' || p.length < 1 || p.length > GIT_PATH_MAX || CONTROL_RE.test(p) || /^([a-zA-Z]:|[\\/])/.test(p) || p.split(/[\\/]/).includes('..')) {
        return { ok: false, error: 'invalid' }
      }
      out.path = p
    }
    if (o.staged !== undefined) {
      if (typeof o.staged !== 'boolean') return { ok: false, error: 'invalid' }
      out.staged = o.staged
    }
    if (o.page !== undefined) {
      if (typeof o.page !== 'number' || !Number.isInteger(o.page) || o.page < 0 || o.page > 999) return { ok: false, error: 'invalid' }
      out.page = o.page
    }
    return c.git(out)
  }

  async notes(req: unknown): Promise<ShareGuestNotesRes> {
    const o = obj(req)
    if (!o || !isLinkId(o.linkId) || (o.op !== 'list' && o.op !== 'read')) return { ok: false, error: 'invalid' }
    if (o.noteId !== undefined && (typeof o.noteId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.noteId))) return { ok: false, error: 'invalid' }
    if (o.op === 'read' && o.noteId === undefined) return { ok: false, error: 'invalid' }
    const c = this.conns.get(o.linkId)
    if (!c) return { ok: false, error: 'offline' }
    return c.notes({ op: o.op, ...(o.noteId !== undefined ? { noteId: o.noteId as string } : {}) })
  }

  // --- Terminal plane ---

  sub(req: unknown): void {
    const o = obj(req)
    if (!o || !isLinkId(o.linkId) || !isPaneId(o.paneId)) return
    this.conns.get(o.linkId)?.sub(o.paneId)
  }

  unsub(req: unknown): void {
    const o = obj(req)
    if (!o || !isLinkId(o.linkId) || !isPaneId(o.paneId)) return
    this.flow.get(o.linkId)?.delete(o.paneId)
    this.conns.get(o.linkId)?.unsub(o.paneId)
  }

  input(req: unknown): void {
    const o = obj(req)
    if (!o || !isLinkId(o.linkId) || !isPaneId(o.paneId) || typeof o.data !== 'string' || o.data.length === 0) return
    const linkId = o.linkId
    const paneId = o.paneId
    if (o.data.length > SHARE_LIMITS.pasteMax) {
      this.pushStream(linkId, { t: 'inputRefused', paneId, reason: 'paste_too_large' })
      return
    }
    const c = this.conns.get(linkId)
    const reason = c ? c.input(paneId, o.data, o.paste === true) : 'offline'
    if (reason) this.pushStream(linkId, { t: 'inputRefused', paneId, reason })
  }

  flowCtl(req: unknown): void {
    const o = obj(req) as Partial<ShareFlowReq> | null
    if (!o || !isLinkId(o.linkId) || !isPaneId(o.paneId) || typeof o.pause !== 'boolean') return
    const panes = this.flow.get(o.linkId) ?? new Map<string, boolean>()
    if (o.pause) {
      if (!panes.has(o.paneId)) panes.set(o.paneId, false)
      this.flow.set(o.linkId, panes)
      return
    }
    const dirty = panes.get(o.paneId)
    panes.delete(o.paneId)
    if (panes.size === 0) this.flow.delete(o.linkId)
    if (dirty) this.conns.get(o.linkId)?.resync(o.paneId)
  }

  chat(req: unknown): void {
    const o = obj(req)
    if (!o || !isLinkId(o.linkId) || !isPaneId(o.paneId)) return
    if (o.op !== 'sub' && o.op !== 'unsub' && o.op !== 'more') return
    if (o.before !== undefined && typeof o.before !== 'string') return
    this.conns.get(o.linkId)?.chat(o.op, o.paneId, o.before as string | undefined)
  }

  /** The renderer reloaded or died: every mount is gone (links stay connected). */
  resetRenderer(): void {
    for (const c of this.conns.values()) c.unsubAll()
    this.flow.clear()
    this.queue.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const c of this.conns.values()) c.dispose()
    this.conns.clear()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.queue.clear()
  }

  // --- Internals ---

  /** The link's view: the stored record plus the live state of its connection. */
  view(linkId: string): ShareLinkView | null {
    const rec = this.deps.store.get(linkId)
    if (!rec) return null
    const live: LinkLive = this.conns.get(linkId)?.live() ?? { status: 'idle' }
    const v: ShareLinkView = {
      id: rec.id,
      hostLabel: rec.hostLabel,
      hostFingerprint: keyFingerprint(Buffer.from(rec.hostKey, 'base64url')),
      scope: live.scope ?? { ...rec.scope },
      permHint: rec.permHint,
      addedAt: rec.addedAt,
      persisted: this.deps.store.persisted,
      rememberedPassword: this.deps.store.password(rec.id) !== null,
      status: live.status,
    }
    if (rec.expiresAt !== undefined) v.expiresAt = rec.expiresAt
    if (rec.lastConnectedAt !== undefined) v.lastConnectedAt = rec.lastConnectedAt
    if (live.reason) v.reason = live.reason
    if (live.pending) v.pending = live.pending
    if (live.retryAt !== undefined) v.retryAt = live.retryAt
    if (live.perm) v.perm = live.perm
    if (live.host) v.host = live.host
    if (live.version) v.version = live.version
    return v
  }

  private conn(linkId: string): LinkConnection {
    let c = this.conns.get(linkId)
    if (c) return c
    const store = this.deps.store
    c = new LinkConnection({
      record: () => store.get(linkId),
      inviteKey: () => store.inviteKey(linkId),
      password: () => store.password(linkId),
      setPassword: (pw) => store.setPassword(linkId, pw),
      markConnected: (endpoint) => store.markConnected(linkId, endpoint),
      guestStatic: () => this.deps.guestIdentity(),
      guestName: () => this.deps.guestName(),
      app: this.deps.app,
      ...this.deps.connection,
      events: {
        onChange: () => {
          const link = this.view(linkId)
          if (link) this.emit({ t: 'link', link })
        },
        onState: (state) => this.emit({ t: 'state', linkId, state }),
        onStream: (item) => this.pushStream(linkId, item),
        onChat: (msg) => this.emitChat({ linkId, msg }),
        onNotesChanged: (noteId) => this.emit({ t: 'notesChanged', linkId, ...(noteId ? { noteId } : {}) }),
        onErr: (code) => this.emit({ t: 'err', linkId, code }),
      },
    })
    this.conns.set(linkId, c)
    return c
  }

  private dropFlow(linkId: string): void {
    this.flow.delete(linkId)
  }

  private pushStream(linkId: string, item: ShareStreamItem): void {
    if (this.disposed) return
    if (item.t === 'out' || item.t === 'replay') {
      const panes = this.flow.get(linkId)
      if (panes?.has(item.paneId)) {
        panes.set(item.paneId, true)
        return
      }
    }
    let q = this.queue.get(linkId)
    if (!q) {
      q = []
      this.queue.set(linkId, q)
    }
    const last = q[q.length - 1]
    if (item.t === 'out' && last?.t === 'out' && last.paneId === item.paneId && last.data.length + item.data.length <= OUT_JOIN_MAX) {
      q[q.length - 1] = { t: 'out', paneId: item.paneId, data: last.data + item.data }
    } else {
      q.push(item)
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        for (const id of [...this.queue.keys()]) this.flush(id)
      }, this.deps.batchMs ?? 16)
    }
  }

  private flush(linkId: string): void {
    const items = this.queue.get(linkId)
    this.queue.delete(linkId)
    if (!items || items.length === 0) return
    const evt: ShareStreamEvt = { linkId, items }
    this.deps.send(CH.SHARE_STREAM, evt)
  }

  private emit(evt: ShareLinkEvt): void {
    if (this.disposed) return
    this.flush(evt.t === 'link' ? evt.link.id : evt.linkId)
    this.deps.send(CH.SHARE_LINK_EVENT, evt)
  }

  private emitChat(evt: ShareChatEvt): void {
    if (this.disposed) return
    this.flush(evt.linkId)
    this.deps.send(CH.SHARE_CHAT_EVENT, evt)
  }
}
