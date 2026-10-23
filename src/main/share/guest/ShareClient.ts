/**
 * The guest end of one share link (app 2.4.0, item 8, stage S2): an outbound
 * WebSocket to the host's share listener, the secure channel over it, and the
 * session protocol (hello, approval, welcome, the terminal plane, requests).
 *
 * The host is untrusted from here: every record must authenticate, every
 * decrypted frame must pass the strict schema (`parseShareHostMsg`) and a
 * violation ends the link for good (`protocol`, no reconnect). Unknown
 * well-formed types are ignored.
 *
 * Dialing: the endpoint that last worked first, then the invite order, 4 s
 * per attempt. An endpoint that answers with another key (`identity_mismatch`)
 * does not stop the round (another PC may hold that LAN address now); the link
 * ends only when no endpoint got through and one of them mismatched. Lost
 * connections retry with backoff 1, 2, 5, 10, 30 s (+-20 % jitter) and the
 * in-memory ticket; the close codes of SHARE_NO_RECONNECT, a denial, a
 * version mismatch or a protocol violation never retry on their own.
 *
 * Input: main gates every write whole with its own ShareInputGate before it
 * is chunked (a paste is judged as one unit and refused as one unit in
 * `type`), chunks never split an ESC sequence or a surrogate pair, and a paste
 * travels as numbered parts the host joins before writing any of it.
 */
import { WebSocket, type RawData } from 'ws'
import {
  SHARE_CLOSE,
  SHARE_HEADER,
  SHARE_LIMITS,
  SHARE_SUBPROTOCOL,
  SHARE_WS_PATH,
  shareText,
  type ShareClientMsg,
  type ShareHostMsg,
  type ShareHostPlatform,
  type ShareFilesReply,
  type ShareNotesOp,
  type ShareNotesReply,
  type SharePaneInfo,
  type SharePerm,
  type ShareScopeKind,
  type ShareState,
} from '@shared/share-protocol'
import { parseShareHostMsg } from '@shared/share-protocol-schemas'
import { chunkShareInput, PASTE_START, ShareInputGate, type ShareInputCtx } from '@shared/shareInput'
import type {
  ShareChatEvt,
  ShareGuestCtlReq,
  ShareGuestCtlRes,
  ShareGuestRequestError,
  ShareInputRefused,
  ShareLinkEndReason,
  ShareLinkStatus,
  ShareStreamItem,
  SharePasswordRes,
} from '@shared/share-guest'
import type { RemoteGitReply } from '@shared/remote-protocol'
import {
  derivePasswordKey,
  fromB64u,
  GuestHandshake,
  shareProof,
  type SecureChannel,
  type ShareKeyPair,
} from '../crypto'
import type { ShareInviteEndpoint } from '../invite'
import type { ShareFrame, ShareTransport } from '../transport'
import type { LinkPassword, LinkRecord } from './LinkStore'

// --- Transport: the outbound WebSocket ---

export type ShareDialer = (ep: ShareInviteEndpoint, timeoutMs: number) => Promise<ShareTransport>

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data as ArrayBuffer)
}

class WsClientTransport implements ShareTransport {
  private readonly messageCbs: Array<(frame: ShareFrame) => void> = []
  private readonly closeCbs: Array<(code: number, reason: string) => void> = []
  private inbox: ShareFrame[] = []
  private isClosed = false

  constructor(
    private readonly ws: WebSocket,
    readonly remoteIp: string,
  ) {
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (this.isClosed) return
      const buf = rawToBuffer(data)
      const frame: ShareFrame = isBinary ? buf : buf.toString('utf8')
      if (this.messageCbs.length === 0) this.inbox.push(frame)
      else for (const cb of this.messageCbs) cb(frame)
    })
    ws.on('close', (code: number, reason: Buffer) => this.finish(code, reason.toString('utf8')))
    ws.on('error', () => {
      // a 'close' always follows
    })
  }

  get closed(): boolean {
    return this.isClosed
  }

  send(frame: ShareFrame): void {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(frame, { binary: typeof frame !== 'string' })
  }

  close(code: number, reason = ''): void {
    if (this.isClosed) return
    try {
      this.ws.close(code, reason)
    } catch {
      this.ws.terminate()
    }
    // A host that never answers the close handshake is cut after 2 s.
    const t = setTimeout(() => this.ws.terminate(), 2000)
    t.unref?.()
    this.finish(code, reason)
  }

  bufferedAmount(): number {
    return this.ws.bufferedAmount
  }

  onMessage(cb: (frame: ShareFrame) => void): void {
    this.messageCbs.push(cb)
    const queued = this.inbox
    this.inbox = []
    for (const frame of queued) cb(frame)
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCbs.push(cb)
  }

  private finish(code: number, reason: string): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const cb of this.closeCbs) cb(code, reason)
  }
}

/**
 * `ws://a:p/share` with the custom header and subprotocol a browser cannot
 * set, no Origin, no compression, no redirects, host frames <= 1MB.
 */
export const dialShareWs: ShareDialer = (ep, timeoutMs) =>
  new Promise<ShareTransport>((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://${ep.a}:${ep.p}${SHARE_WS_PATH}`, [SHARE_SUBPROTOCOL], {
        headers: { [SHARE_HEADER]: '1' },
        perMessageDeflate: false,
        maxPayload: SHARE_LIMITS.hostFrameMax,
        handshakeTimeout: timeoutMs,
        followRedirects: false,
      })
    } catch (err) {
      reject(err)
      return
    }
    let done = false
    const fail = (err: unknown): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws.terminate()
      } catch {
        // already gone
      }
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs + 250)
    ws.on('error', fail)
    ws.once('close', () => fail(new Error('closed')))
    ws.once('open', () => {
      if (done) return
      if (ws.protocol !== SHARE_SUBPROTOCOL) {
        fail(new Error('subprotocol'))
        return
      }
      done = true
      clearTimeout(timer)
      ws.removeListener('error', fail)
      resolve(new WsClientTransport(ws, ep.a))
    })
  })

// --- Link connection ---

export interface ShareTimers {
  setTimeout(cb: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(cb: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realTimers: ShareTimers = {
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (cb, ms) => {
    const t = setInterval(cb, ms)
    t.unref?.()
    return t
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

export interface ShareClientTune {
  backoffMs: number[]
  /** +- fraction of each backoff step. */
  jitter: number
  /** TCP + upgrade, per endpoint. */
  attemptMs: number
  /** From the upgrade to the sealed `ready`. */
  handshakeMs: number
  pingMs: number
  /** No frame from the host for this long: the socket is dead. */
  silenceMs: number
  ctlMs: number
  gitMs: number
  notesMs: number
  filesMs: number
}

export const SHARE_CLIENT_TUNE: ShareClientTune = {
  backoffMs: [1000, 2000, 5000, 10_000, 30_000],
  jitter: 0.2,
  attemptMs: 4000,
  handshakeMs: 10_000,
  pingMs: 20_000,
  silenceMs: 60_000,
  ctlMs: 15_000,
  gitMs: 20_000,
  notesMs: 10_000,
  filesMs: 15_000,
}

/** The delay before retry number `attempt` (0-based), jittered with `random()` in [0, 1). */
export function shareBackoffDelay(attempt: number, tune: Pick<ShareClientTune, 'backoffMs' | 'jitter'>, random: () => number): number {
  const steps = tune.backoffMs
  const base = steps[Math.min(Math.max(0, attempt), steps.length - 1)]
  return Math.max(0, Math.round(base * (1 + (random() * 2 - 1) * tune.jitter)))
}

/** lastEndpoint first, then the invite order, without repeats. */
export function orderEndpoints(link: Pick<LinkRecord, 'endpoints' | 'lastEndpoint'>): ShareInviteEndpoint[] {
  const list = [...link.endpoints]
  const i = link.lastEndpoint ? list.findIndex((e) => `${e.a}:${e.p}` === link.lastEndpoint) : -1
  if (i > 0) list.unshift(...list.splice(i, 1))
  return list
}

export interface LinkConnectionEvents {
  /** Status, reason, pending, perm or host changed (the facade sends a link view). */
  onChange(): void
  onState(state: ShareState): void
  onStream(item: ShareStreamItem): void
  onChat(msg: ShareChatEvt['msg']): void
  onNotesChanged(noteId?: string, rev?: string): void
  /** v2: folders of the shared workspace changed while the Files drawer is open. */
  onFilesChanged(dirs: string[], all: boolean): void
  onErr(code: Extract<ShareHostMsg, { t: 'err' }>['code']): void
}

export interface LinkConnectionDeps {
  record(): LinkRecord | null
  inviteKey(): Buffer | null
  password(): LinkPassword | null
  setPassword(pw: LinkPassword | null): void
  markConnected(endpoint: string): void
  guestStatic(): ShareKeyPair
  guestName(): string
  app: string
  events: LinkConnectionEvents
  dial?: ShareDialer
  timers?: ShareTimers
  now?: () => number
  random?: () => number
  tune?: Partial<ShareClientTune>
  /** Highest protocol version offered (tests: 1 plays an app 2.5 guest). */
  protocolMax?: number
}

export interface LinkLive {
  status: ShareLinkStatus
  reason?: ShareLinkEndReason
  pending?: { expiresAt: number; password: boolean; passwordFailed?: boolean }
  retryAt?: number
  perm?: SharePerm
  host?: { label: string; platform: ShareHostPlatform; app: string }
  scope?: { kind: ShareScopeKind; label: string }
  version?: { min: number; max: number; app?: string }
}

type Outcome = 'ok' | 'mismatch' | 'version' | 'fail'
type ReqKind = 'ctl' | 'git' | 'notes' | 'files'
type Reply = Extract<ShareHostMsg, { t: 'ctlAck' | 'gitRes' | 'notesRes' | 'filesRes' }>
type SendResult = 'ok' | 'offline' | 'too_large'

/** A notes request of the renderer, already validated by ShareGuest. */
export interface LinkNotesReq {
  op: ShareNotesOp
  noteId?: string
  text?: string
  baseRev?: string
}
type ReqResult = { ok: true; msg: Reply } | { ok: false; error: ShareGuestRequestError }

const REQUESTS_MAX = 32
/** Files requests in flight per link (the host allows 2). */
const FILES_IN_FLIGHT = 2
const RECONNECT_ON_DENIED = new Set(['busy', 'limit'])
const RECONNECT_ON_ENDED = new Set(['host_quit', 'sharing_off'])
const PRE_WELCOME = new Set(['ready', 'pending', 'denied', 'welcome', 'ended', 'pong', 'err'])
const STREAM_TYPES = new Set(['replay', 'out', 'exit', 'fit', 'inputLock', 'inputDenied'])

export class LinkConnection {
  private readonly timers: ShareTimers
  private readonly now: () => number
  private readonly random: () => number
  private readonly tune: ShareClientTune
  private readonly dial: ShareDialer

  private statusValue: ShareLinkStatus = 'idle'
  private reason: ShareLinkEndReason | undefined
  private pending: (LinkLive['pending'] & { salt?: string }) | undefined
  private retryAt: number | undefined
  private perm: SharePerm | undefined
  private host: LinkLive['host']
  private scope: LinkLive['scope']
  private versionInfo: LinkLive['version']

  /** Bumped by every new round, stop and end: a stale async step sees it changed and quits. */
  private gen = 0
  private stopped = true
  private transport: ShareTransport | null = null
  private channel: SecureChannel | null = null
  private endpointKey = ''
  private welcomed = false
  private paused = false
  private ticket: string | null = null
  private inputMax: number = SHARE_LIMITS.inputMax
  private lastRx = 0
  private backoffIdx = 0
  private retryTimer: unknown = null
  private pingTimer: unknown = null
  /** A denial or end the host announced before closing: decides what the close means. */
  private closeHint: ShareLinkEndReason | undefined
  /** The hello carried the remembered password key. */
  private sentPw = false
  private pwChoice: { remember: boolean; pw: LinkPassword } | null = null

  private state: ShareState | null = null
  /** Panes a createPane ack named, valid before the next state lists them. */
  private readonly acked = new Set<string>()
  /** Panes the renderer has mounted (resubscribed after a reconnect). */
  private readonly mounted = new Set<string>()
  private readonly gates = new Map<string, ShareInputGate>()
  private readonly lastSent = new Map<string, string>()
  private seq = 0
  private pasteId = 0
  private reqSeq = 0
  private readonly requests = new Map<string, { kind: ReqKind; timer: unknown; resolve: (r: ReqResult) => void }>()
  /** The renderer's Files drawer is open; `filesWatchSent` is what the host was told on this socket. */
  private wantFilesWatch = false
  private filesWatchSent = false
  private filesInFlight = 0

  constructor(private readonly deps: LinkConnectionDeps) {
    this.timers = deps.timers ?? realTimers
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? Math.random
    this.tune = { ...SHARE_CLIENT_TUNE, ...deps.tune }
    this.dial = deps.dial ?? dialShareWs
  }

  get status(): ShareLinkStatus {
    return this.statusValue
  }

  live(): LinkLive {
    const out: LinkLive = { status: this.statusValue }
    if (this.reason) out.reason = this.reason
    if (this.pending) {
      const { salt: _salt, ...pending } = this.pending
      void _salt
      out.pending = pending
    }
    if (this.retryAt !== undefined) out.retryAt = this.retryAt
    if (this.perm) out.perm = this.perm
    if (this.host) out.host = { ...this.host }
    if (this.scope) out.scope = { ...this.scope }
    if (this.versionInfo) out.version = { ...this.versionInfo }
    return out
  }

  latestState(): ShareState | null {
    return this.state
  }

  /** Connect (or retry now). A link that is live or already dialing is left alone. */
  start(): void {
    if (!this.stopped && this.statusValue !== 'reconnecting') return
    this.clearRetry()
    this.stopped = false
    this.reason = undefined
    this.versionInfo = undefined
    this.backoffIdx = 0
    void this.round()
  }

  /** The user disconnects: `bye`, close, no reconnect. */
  stop(): void {
    this.gen++
    this.stopped = true
    this.clearRetry()
    // The ticket stays: reconnecting within its window needs no new approval.
    this.dropTransport(1000, true)
    this.setStatus('idle')
  }

  /** App quit: like stop, with no event. */
  dispose(): void {
    this.gen++
    this.stopped = true
    this.clearRetry()
    this.dropTransport(1001, true)
  }

  // --- Terminal plane ---

  sub(paneId: string): void {
    this.mounted.add(paneId)
    if (this.live_() && this.known(paneId)) this.send({ t: 'sub', paneId })
  }

  unsub(paneId: string): void {
    this.mounted.delete(paneId)
    this.gates.delete(paneId)
    if (this.live_()) this.send({ t: 'unsub', paneId })
  }

  /** Every mount at once (renderer reload). */
  unsubAll(): void {
    const live = this.live_()
    for (const paneId of this.mounted) if (live) this.send({ t: 'unsub', paneId })
    this.mounted.clear()
    this.gates.clear()
  }

  resync(paneId: string): void {
    if (this.live_() && this.mounted.has(paneId) && this.known(paneId)) this.send({ t: 'resync', paneId })
  }

  /** null = sent (or silently dropped, terminal reports); otherwise why it never left main. */
  input(paneId: string, data: string, paste: boolean): ShareInputRefused['reason'] | null {
    if (!this.live_()) return 'offline'
    if (this.paused) return 'paused'
    if (!this.known(paneId)) return 'out_of_scope'
    const perm = this.perm ?? 'view'
    if (perm === 'view') return 'view_only'
    if (data.length > SHARE_LIMITS.pasteMax) return 'paste_too_large'
    let gate = this.gates.get(paneId)
    if (!gate) {
      gate = new ShareInputGate(this.now)
      this.gates.set(paneId, gate)
    }
    const verdict = gate.check(data, perm, this.ctxFor(paneId))
    if (!verdict.ok) return verdict.drop ? null : verdict.reason
    const max = Math.max(1, Math.min(SHARE_LIMITS.inputMax, this.inputMax))
    const frames: ShareClientMsg[] = []
    if (paste || data.length > max || data.includes(PASTE_START)) {
      const parts = chunkShareInput(data, max)
      if (parts.length > SHARE_LIMITS.pasteParts) return 'paste_too_large'
      const id = this.pasteId
      this.pasteId = (this.pasteId + 1) % 2 ** 31
      parts.forEach((part, i) => frames.push({ t: 'input', paneId, data: part, seq: this.seq++, paste: { id, part: i, last: i === parts.length - 1 } }))
    } else {
      frames.push({ t: 'input', paneId, data, seq: this.seq++ })
    }
    gate.commit(data)
    this.lastSent.set(paneId, data[data.length - 1])
    for (const f of frames) this.send(f)
    return null
  }

  chat(op: 'sub' | 'unsub' | 'more', paneId: string, before?: string): boolean {
    if (!this.live_() || !this.state?.caps.chat || !this.known(paneId)) return false
    if (op === 'sub') return this.send({ t: 'chatSub', paneId })
    if (op === 'unsub') return this.send({ t: 'chatUnsub', paneId })
    if (!before || !/^\d{1,15}$/.test(before)) return false
    return this.send({ t: 'chatMore', paneId, before })
  }

  // --- Requests ---

  async ctl(req: ShareGuestCtlReq): Promise<ShareGuestCtlRes> {
    if (!this.live_()) return { ok: false, error: 'offline' }
    const caps = this.state?.caps
    let msg: Record<string, unknown>
    if (req.op === 'createPane') {
      if (!caps?.createPane) return { ok: false, error: 'denied' }
      if (req.presetId !== undefined && !this.state?.presets?.some((p) => p.id === req.presetId)) return { ok: false, error: 'bad_preset' }
      msg = { t: 'ctl', op: 'createPane', ...(req.presetId !== undefined ? { presetId: req.presetId } : {}), ...(req.paneType ? { paneType: req.paneType } : {}) }
    } else {
      if (!caps?.closePane) return { ok: false, error: 'denied' }
      if (!this.known(req.paneId)) return { ok: false, error: 'out_of_scope' }
      msg = { t: 'ctl', op: 'closePane', paneId: req.paneId }
    }
    const r = await this.request('ctl', msg, this.tune.ctlMs)
    if (!r.ok) return { ok: false, error: r.error === 'timeout' ? 'timeout' : r.error === 'offline' ? 'offline' : 'failed' }
    const ack = r.msg as Extract<ShareHostMsg, { t: 'ctlAck' }>
    if (ack.ok && ack.paneId) this.acked.add(ack.paneId)
    return { ok: ack.ok, ...(ack.paneId ? { paneId: ack.paneId } : {}), ...(ack.error ? { error: ack.error } : {}) }
  }

  async git(req: { op: 'status' | 'diff'; path?: string; staged?: boolean; page?: number }): Promise<{ ok: boolean; reply?: RemoteGitReply; error?: ShareGuestRequestError }> {
    if (!this.live_()) return { ok: false, error: 'offline' }
    if (!this.state?.caps.git) return { ok: false, error: 'denied' }
    const r = await this.request('git', { t: 'gitReq', ...req }, this.tune.gitMs)
    if (!r.ok) return { ok: false, error: r.error }
    const { t: _t, id: _id, ...reply } = r.msg as Extract<ShareHostMsg, { t: 'gitRes' }>
    void _t
    void _id
    return { ok: true, reply: reply as RemoteGitReply }
  }

  async notes(req: LinkNotesReq): Promise<{ ok: boolean; reply?: ShareNotesReply; error?: ShareGuestRequestError }> {
    if (!this.live_()) return { ok: false, error: 'offline' }
    const caps = this.state?.caps
    // Write, create and delete exist from v2 on, with notesWrite.
    const writes = req.op === 'write' || req.op === 'create' || req.op === 'delete'
    if (!(writes ? caps?.notesWrite : caps?.notes)) return { ok: false, error: 'denied' }
    if (req.text !== undefined && Buffer.byteLength(req.text, 'utf8') > SHARE_LIMITS.noteTextMax) return { ok: false, error: 'too_large' }
    // One exact shape per op (the host's schema is strict).
    let msg: Record<string, unknown>
    if (req.op === 'list') msg = { t: 'notesReq', op: 'list' }
    else if (req.op === 'create') msg = { t: 'notesReq', op: 'create', ...(req.text !== undefined ? { text: req.text } : {}) }
    else if (req.noteId === undefined) return { ok: false, error: 'invalid' }
    else if (req.op === 'write') {
      if (req.text === undefined) return { ok: false, error: 'invalid' }
      msg = { t: 'notesReq', op: 'write', noteId: req.noteId, text: req.text, ...(req.baseRev !== undefined ? { baseRev: req.baseRev } : {}) }
    } else msg = { t: 'notesReq', op: req.op, noteId: req.noteId }
    const r = await this.request('notes', msg, this.tune.notesMs)
    if (!r.ok) return { ok: false, error: r.error }
    const { t: _t, id: _id, ...reply } = r.msg as Extract<ShareHostMsg, { t: 'notesRes' }>
    void _t
    void _id
    return { ok: true, reply: reply as ShareNotesReply }
  }

  /** v2: a folder or a file of the shared workspace, read-only. */
  async files(req: { op: 'list' | 'read'; rel: string }): Promise<{ ok: boolean; reply?: ShareFilesReply; error?: ShareGuestRequestError }> {
    if (!this.live_()) return { ok: false, error: 'offline' }
    if (!this.state?.caps.files) return { ok: false, error: 'denied' }
    if (this.filesInFlight >= FILES_IN_FLIGHT) return { ok: false, error: 'busy' }
    this.filesInFlight += 1
    let r: ReqResult
    try {
      r = await this.request('files', { t: 'filesReq', op: req.op, rel: req.rel }, this.tune.filesMs)
    } finally {
      this.filesInFlight -= 1
    }
    if (!r.ok) return { ok: false, error: r.error }
    const { t: _t, id: _id, ...reply } = r.msg as Extract<ShareHostMsg, { t: 'filesRes' }>
    void _t
    void _id
    return { ok: true, reply: reply as ShareFilesReply }
  }

  /** v2: the renderer's Files drawer opened or closed; kept across reconnects. */
  filesWatch(on: boolean): void {
    this.wantFilesWatch = on
    this.syncFilesWatch()
  }

  private syncFilesWatch(): void {
    // Without the cap the host already dropped the watch: nothing to say.
    if (!this.live_() || !this.state?.caps.files) {
      this.filesWatchSent = false
      return
    }
    if (this.wantFilesWatch === this.filesWatchSent) return
    if (this.send({ t: 'filesWatch', on: this.wantFilesWatch })) this.filesWatchSent = this.wantFilesWatch
  }

  /** The unattended password while the host's prompt is up. */
  async password(password: string, remember: boolean): Promise<SharePasswordRes> {
    const pending = this.pending
    const channel = this.channel
    if (!channel || this.welcomed || !pending?.password || !pending.salt) return { ok: false, error: 'not_pending' }
    if (password.length < SHARE_LIMITS.passwordMin || password.length > SHARE_LIMITS.passwordMax) return { ok: false, error: 'invalid' }
    const salt = fromB64u(pending.salt, 16)
    if (!salt) return { ok: false, error: 'failed' }
    let key: Buffer
    try {
      key = await derivePasswordKey(password, salt)
    } catch {
      return { ok: false, error: 'failed' }
    }
    if (this.channel !== channel || this.welcomed) return { ok: false, error: 'offline' }
    if (!this.send({ t: 'password', proof: shareProof(key, 'pw', channel.h) })) return { ok: false, error: 'offline' }
    this.pwChoice = { remember, pw: { salt, key } }
    return { ok: true }
  }

  // --- Internals ---

  private live_(): boolean {
    return this.transport !== null && this.channel !== null && this.welcomed
  }

  private known(paneId: string): boolean {
    return this.acked.has(paneId) || (this.state?.panes.some((p) => p.id === paneId) ?? false)
  }

  private pane(paneId: string): SharePaneInfo | undefined {
    return this.state?.panes.find((p) => p.id === paneId)
  }

  private ctxFor(paneId: string): ShareInputCtx {
    const pane = this.pane(paneId)
    const st = pane?.status
    return {
      // A pane only an ack names (just created) is judged like an agent until the state says otherwise.
      agent: !pane || pane.type === 'claude' || pane.type === 'codex' || st?.hosted === true || st?.provider !== undefined,
      state: st?.state ?? null,
      precise: st?.precise,
      // The host knows the real last byte; the pre-check never refuses `~` on a guess.
      lastByte: this.lastSent.get(paneId) ?? 'x',
    }
  }

  private setStatus(status: ShareLinkStatus): void {
    this.statusValue = status
    if (status !== 'reconnecting') this.retryAt = undefined
    if (status !== 'waiting_approval' && status !== 'password_required') this.pending = undefined
    this.deps.events.onChange()
  }

  private send(msg: ShareClientMsg): boolean {
    return this.sendFrame(msg) === 'ok'
  }

  /**
   * Seal and send one frame. One past SHARE_LIMITS.guestFrameMax UTF-8 bytes
   * is never sent (the host's socket would close on it): `too_large`.
   */
  private sendFrame(msg: ShareClientMsg): SendResult {
    const t = this.transport
    const ch = this.channel
    if (!t || !ch || t.closed) return 'offline'
    const text = JSON.stringify(msg)
    if (Buffer.byteLength(text, 'utf8') > SHARE_LIMITS.guestFrameMax) return 'too_large'
    try {
      t.send(ch.seal(text))
      return 'ok'
    } catch {
      return 'offline'
    }
  }

  private request(kind: ReqKind, msg: Record<string, unknown>, ms: number): Promise<ReqResult> {
    if (this.requests.size >= REQUESTS_MAX) return Promise.resolve({ ok: false, error: 'busy' })
    this.reqSeq = (this.reqSeq + 1) % 1e9
    const id = `${kind[0]}${this.reqSeq}`
    const sent = this.sendFrame({ ...msg, id } as ShareClientMsg)
    if (sent !== 'ok') return Promise.resolve({ ok: false, error: sent })
    return new Promise<ReqResult>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.requests.delete(id)
        resolve({ ok: false, error: 'timeout' })
      }, ms)
      this.requests.set(id, { kind, timer, resolve })
    })
  }

  private settle(kind: ReqKind, msg: Reply): void {
    const req = this.requests.get(msg.id)
    if (!req || req.kind !== kind) return
    this.requests.delete(msg.id)
    this.timers.clearTimeout(req.timer)
    req.resolve({ ok: true, msg })
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /** Forget the live socket (its late close is ignored) and close it. */
  private dropTransport(code: number, bye: boolean): void {
    const t = this.transport
    if (t && bye && this.welcomed) this.send({ t: 'bye' })
    this.transport = null
    this.channel = null
    this.welcomed = false
    this.paused = false
    this.filesWatchSent = false
    this.acked.clear()
    this.gates.clear()
    this.lastSent.clear()
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer)
    this.pingTimer = null
    for (const [id, req] of this.requests) {
      this.timers.clearTimeout(req.timer)
      req.resolve({ ok: false, error: 'offline' })
      this.requests.delete(id)
    }
    if (t && !t.closed) t.close(code)
  }

  private end(reason: ShareLinkEndReason, code = 1000): void {
    this.gen++
    this.stopped = true
    this.clearRetry()
    this.dropTransport(code, false)
    this.ticket = null
    this.reason = reason
    this.setStatus('ended')
  }

  private retry(reason?: ShareLinkEndReason): void {
    if (this.stopped) return
    this.clearRetry()
    const delay = shareBackoffDelay(this.backoffIdx, this.tune, this.random)
    this.backoffIdx++
    this.reason = reason
    this.statusValue = 'reconnecting'
    this.pending = undefined
    this.retryAt = this.now() + delay
    const gen = this.gen
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null
      if (gen === this.gen && !this.stopped) void this.round()
    }, delay)
    this.deps.events.onChange()
  }

  private async round(): Promise<void> {
    const gen = ++this.gen
    const rec = this.deps.record()
    const key = this.deps.inviteKey()
    const hostKey = rec ? fromB64u(rec.hostKey, 32) : null
    if (!rec || !key || !hostKey) {
      this.end('bad_invite')
      return
    }
    // A first connect shows `connecting`; a retry stays `reconnecting` (without its retryAt) until it lands.
    this.setStatus(this.statusValue === 'reconnecting' ? 'reconnecting' : 'connecting')
    let mismatch = false
    for (const ep of orderEndpoints(rec)) {
      if (gen !== this.gen) return
      let t: ShareTransport
      try {
        t = await this.dial(ep, this.tune.attemptMs)
      } catch {
        continue
      }
      if (gen !== this.gen) {
        t.close(1000)
        return
      }
      const outcome = await this.handshake(t, ep, hostKey, gen)
      if (gen !== this.gen) return
      if (outcome === 'ok') return
      if (outcome === 'version') {
        this.end('version')
        return
      }
      if (outcome === 'mismatch') mismatch = true
    }
    if (gen !== this.gen) return
    if (mismatch) this.end('identity_mismatch')
    else this.retry(this.reason)
  }

  private handshake(t: ShareTransport, ep: ShareInviteEndpoint, hostKey: Buffer, gen: number): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      let phase: 'hs2' | 'ready' | 'live' = 'hs2'
      let channel: SecureChannel | null = null
      let settled = false
      let hs: GuestHandshake
      try {
        hs = new GuestHandshake({ hostStatic: hostKey, guestStatic: this.deps.guestStatic(), ...(this.deps.protocolMax ? { maxVersion: this.deps.protocolMax } : {}) })
      } catch {
        t.close(1000)
        resolve('mismatch')
        return
      }
      const finish = (o: Outcome): void => {
        if (settled) return
        settled = true
        this.timers.clearTimeout(timer)
        if (o !== 'ok' && !t.closed) t.close(o === 'mismatch' ? SHARE_CLOSE.BAD_MSG : 1000)
        resolve(o)
      }
      const timer = this.timers.setTimeout(() => finish('fail'), this.tune.handshakeMs)
      t.onMessage((frame) => {
        if (phase === 'live') {
          this.onFrame(t, frame)
          return
        }
        if (settled) return
        if (gen !== this.gen) {
          finish('fail')
          return
        }
        if (phase === 'hs2') {
          if (typeof frame !== 'string') {
            finish('mismatch')
            return
          }
          const r = hs.receive(frame)
          if (!r.ok) {
            if (r.error === 'version') {
              this.versionInfo = { min: r.min, max: r.max, ...(r.app ? { app: shareText(r.app, SHARE_LIMITS.appMax) } : {}) }
              finish('version')
            } else finish('mismatch')
            return
          }
          channel = r.channel
          phase = 'ready'
          return
        }
        if (typeof frame === 'string' || !channel || !GuestHandshake.confirmReady(channel, frame)) {
          finish('mismatch')
          return
        }
        phase = 'live'
        this.attach(t, channel, `${ep.a}:${ep.p}`)
        finish('ok')
      })
      t.onClose((code) => {
        if (phase === 'live') {
          this.onClosed(t, code)
          return
        }
        // Before `ready`: a host that cannot open our sealed hs1 closes 4400 (another key).
        finish(code === SHARE_CLOSE.VERSION ? 'version' : code === SHARE_CLOSE.BAD_MSG ? 'mismatch' : 'fail')
      })
      if (t.closed) {
        finish('fail')
        return
      }
      t.send(hs.hello())
    })
  }

  private attach(t: ShareTransport, channel: SecureChannel, endpoint: string): void {
    this.transport = t
    this.channel = channel
    this.endpointKey = endpoint
    this.welcomed = false
    this.paused = false
    this.closeHint = undefined
    this.lastRx = this.now()
    this.pingTimer = this.timers.setInterval(() => this.keepalive(t), this.tune.pingMs)
    const rec = this.deps.record()
    const key = this.deps.inviteKey()
    if (!rec || !key) {
      this.end('bad_invite')
      return
    }
    const pw = this.deps.password()
    this.sentPw = pw !== null
    const name = shareText(this.deps.guestName(), SHARE_LIMITS.guestNameMax)
    this.send({
      t: 'hello',
      sid: rec.shareId,
      guestName: name,
      app: shareText(this.deps.app, SHARE_LIMITS.appMax),
      proof: shareProof(key, 'join', channel.h),
      ...(this.ticket ? { ticket: this.ticket } : {}),
      ...(pw ? { pw: shareProof(pw.key, 'pw', channel.h) } : {}),
    })
  }

  private keepalive(t: ShareTransport): void {
    if (t !== this.transport) return
    if (this.now() - this.lastRx > this.tune.silenceMs) {
      this.dropTransport(SHARE_CLOSE.TIMEOUT, false)
      this.retry()
      return
    }
    this.send({ t: 'ping', ts: this.now() })
  }

  private violation(): void {
    this.end('protocol', SHARE_CLOSE.BAD_MSG)
  }

  private onFrame(t: ShareTransport, frame: ShareFrame): void {
    if (t !== this.transport || !this.channel) return
    this.lastRx = this.now()
    if (typeof frame === 'string') {
      this.violation()
      return
    }
    const text = this.channel.open(frame)
    if (text === null) {
      this.violation()
      return
    }
    const parsed = parseShareHostMsg(text)
    if (!parsed.ok) {
      if (!parsed.unknown) this.violation()
      return
    }
    this.handle(parsed.msg)
  }

  private handle(msg: ShareHostMsg): void {
    if (!this.welcomed && !PRE_WELCOME.has(msg.t)) {
      this.violation()
      return
    }
    switch (msg.t) {
      case 'ready':
      case 'pong':
        return
      case 'pending':
        return this.onPending(msg)
      case 'denied':
        if (RECONNECT_ON_DENIED.has(msg.reason)) this.closeHint = msg.reason
        else this.end(msg.reason)
        return
      case 'ended':
        if (RECONNECT_ON_ENDED.has(msg.reason)) this.closeHint = msg.reason
        else this.end(msg.reason)
        return
      case 'welcome':
        return this.onWelcome(msg)
      case 'err':
        this.deps.events.onErr(msg.code)
        return
      case 'state':
        return this.onState(msg.state)
      case 'permChanged':
        this.perm = msg.perm
        if (this.state) this.state = { ...this.state, perm: msg.perm }
        this.gates.clear()
        this.deps.events.onChange()
        return
      case 'paused':
        this.paused = msg.on
        this.setStatus(msg.on ? 'paused' : 'connected')
        return
      case 'ctlAck':
        return this.settle('ctl', msg)
      case 'gitRes':
        return this.settle('git', msg)
      case 'notesRes':
        return this.settle('notes', msg)
      case 'filesRes':
        return this.settle('files', msg)
      case 'filesChanged':
        if (this.state?.caps.files) this.deps.events.onFilesChanged(msg.dirs, msg.all === true)
        return
      case 'chatPage':
      case 'chatAppend':
        if (this.known(msg.paneId)) this.deps.events.onChat(msg)
        return
      case 'notesChanged':
        this.deps.events.onNotesChanged(msg.noteId, msg.rev)
        return
      case 'paneStatus': {
        const s = this.state
        if (!s || !s.panes.some((p) => p.id === msg.paneId)) return
        this.state = {
          ...s,
          panes: s.panes.map((p) => {
            if (p.id !== msg.paneId) return p
            const { status: _old, ...rest } = p
            void _old
            return msg.status ? { ...rest, status: msg.status } : rest
          }),
        }
        this.deps.events.onStream(msg)
        return
      }
      default:
        if (STREAM_TYPES.has(msg.t) && this.known((msg as { paneId: string }).paneId)) this.deps.events.onStream(msg as ShareStreamItem)
    }
  }

  private onPending(msg: Extract<ShareHostMsg, { t: 'pending' }>): void {
    if (this.welcomed) return
    const stored = this.deps.password()
    if (stored && (!msg.password || (msg.salt !== undefined && msg.salt !== stored.salt.toString('base64url')) || (msg.passwordFailed && this.sentPw))) {
      this.deps.setPassword(null)
    }
    if (msg.passwordFailed) this.pwChoice = null
    this.sentPw = false
    const status: ShareLinkStatus = msg.passwordFailed ? 'password_required' : 'waiting_approval'
    this.statusValue = status
    this.retryAt = undefined
    this.pending = {
      expiresAt: msg.expiresAt,
      password: msg.password,
      ...(msg.passwordFailed ? { passwordFailed: true } : {}),
      ...(msg.salt ? { salt: msg.salt } : {}),
    }
    this.deps.events.onChange()
  }

  private onWelcome(msg: Extract<ShareHostMsg, { t: 'welcome' }>): void {
    if (this.welcomed) {
      this.violation()
      return
    }
    this.welcomed = true
    this.ticket = msg.ticket
    this.perm = msg.perm
    this.host = { ...msg.host }
    this.scope = { ...msg.grant.scope }
    this.inputMax = msg.limits.inputMax
    this.backoffIdx = 0
    this.reason = undefined
    this.paused = false
    this.deps.markConnected(this.endpointKey)
    const choice = this.pwChoice
    this.pwChoice = null
    if (choice) this.deps.setPassword(choice.remember ? choice.pw : null)
    this.state = msg.state
    this.deps.events.onState(msg.state)
    this.setStatus('connected')
    for (const paneId of this.mounted) if (this.known(paneId)) this.send({ t: 'sub', paneId })
    this.syncFilesWatch()
  }

  private onState(state: ShareState): void {
    this.state = state
    if (state.perm !== this.perm) {
      this.perm = state.perm
      this.gates.clear()
      this.deps.events.onChange()
    }
    const ids = new Set(state.panes.map((p) => p.id))
    for (const id of this.acked) if (ids.has(id)) this.acked.delete(id)
    for (const id of [...this.gates.keys()]) if (!ids.has(id) && !this.acked.has(id)) this.gates.delete(id)
    this.syncFilesWatch()
    this.deps.events.onState(state)
  }

  private onClosed(t: ShareTransport, code: number): void {
    if (t !== this.transport) return
    const wasWelcomed = this.welcomed
    const wasPending = this.statusValue === 'waiting_approval' || this.statusValue === 'password_required'
    const hint = this.closeHint
    this.closeHint = undefined
    this.transport = null
    this.dropTransport(code, false)
    if (this.stopped) return
    switch (code) {
      case SHARE_CLOSE.BAD_INVITE:
        return this.end('bad_invite')
      case SHARE_CLOSE.DENIED:
        return this.end(wasWelcomed ? 'revoked' : 'denied')
      case SHARE_CLOSE.EXPIRED:
        return this.end('expired')
      case SHARE_CLOSE.SCOPE_GONE:
        return this.end('scope_gone')
      case SHARE_CLOSE.KICKED:
        return this.end('kicked')
      case SHARE_CLOSE.VERSION:
        return this.end('version')
      case SHARE_CLOSE.LOCKED:
        return this.end('locked')
      case SHARE_CLOSE.TIMEOUT:
        if (wasPending) return this.end('timeout')
        break
      default:
        break
    }
    this.retry(hint ?? (code === SHARE_CLOSE.GOING_AWAY ? 'host_quit' : undefined))
  }
}
