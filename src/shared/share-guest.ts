/**
 * Guest half of desktop sharing (app 2.4.0, item 8, stage S2): the shapes the
 * `share:*` guest channels carry between main (src/main/share/guest/) and the
 * renderer ("Shared with me"). The wire protocol to the host is
 * share-protocol.ts; this file is only the local IPC view of it.
 *
 * A link is one joined share (one invite): main owns its socket, keys and
 * state; the renderer gets views, never a key, a ticket or a proof. Pure
 * types: no Node, no DOM.
 */
import type { RemoteGitReply } from './remote-protocol'
import type {
  ShareCtlError,
  ShareDeniedReason,
  ShareDenyReason,
  ShareEndReason,
  ShareHostMsg,
  ShareHostPlatform,
  ShareNotesReply,
  SharePerm,
  ShareScopeKind,
  ShareState,
} from './share-protocol'

/** Renderer-facing link ids: 16 random bytes as base64url. */
export const SHARE_LINK_ID_RE = /^[A-Za-z0-9_-]{22}$/
/** Links a guest keeps at most. */
export const SHARE_LINKS_MAX = 32

/**
 * - `idle`: not connected (never started, or the user disconnected).
 * - `connecting`: dialing the endpoints or running the handshake.
 * - `waiting_approval`: the host shows its Allow / Deny prompt (`pending`).
 * - `password_required`: still pending, and the password sent was wrong.
 * - `connected` / `paused` (the host paused the share; the socket stays open).
 * - `reconnecting`: lost, retrying at `retryAt` (backoff 1, 2, 5, 10, 30 s).
 * - `ended`: stopped for good (`ended` says why); only an explicit connect retries.
 */
export type ShareLinkStatus =
  | 'idle'
  | 'connecting'
  | 'waiting_approval'
  | 'password_required'
  | 'connected'
  | 'paused'
  | 'reconnecting'
  | 'ended'

export type ShareLinkEndReason =
  | ShareEndReason
  | ShareDeniedReason
  /** The host does not know this invite any more (rotated or deleted). */
  | 'bad_invite'
  /** No protocol version in common (`version` holds the host range). */
  | 'version'
  /** The endpoints answered with another key than the invite pinned. */
  | 'identity_mismatch'
  /** The host sent a malformed or unauthenticated frame. */
  | 'protocol'

export interface ShareLinkPending {
  expiresAt: number
  /** The share has a password: the guest may type it instead of waiting. */
  password: boolean
  passwordFailed?: boolean
}

export interface ShareLinkView {
  id: string
  hostLabel: string
  /** `AB12-CD34-EF56-7890` of the pinned host key. */
  hostFingerprint: string
  /** From the invite (display only until a welcome replaces it). */
  scope: { kind: ShareScopeKind; label: string }
  permHint: SharePerm
  expiresAt?: number
  addedAt: number
  lastConnectedAt?: number
  /** False = encryption unavailable: forgotten on quit. */
  persisted: boolean
  /** A password key is remembered (never the password itself). */
  rememberedPassword: boolean
  status: ShareLinkStatus
  /** Why it ended, or the last reason it is reconnecting. */
  reason?: ShareLinkEndReason
  pending?: ShareLinkPending
  /** Epoch ms of the next attempt while reconnecting. */
  retryAt?: number
  /** Live once welcomed. */
  perm?: SharePerm
  host?: { label: string; platform: ShareHostPlatform; app: string }
  /** The host's version range after a `version` end. */
  version?: { min: number; max: number; app?: string }
}

export type SharePreviewError = 'format' | 'version' | 'too_long' | 'bad_key' | 'endpoint' | 'self'

export interface SharePreview {
  hostLabel: string
  hostFingerprint: string
  scope: { kind: ShareScopeKind; label: string }
  perm: SharePerm
  expiresAt?: number
  /** The invite's own expiry is past (the host decides, this is a hint). */
  expired: boolean
  endpoints: Array<{ address: string; port: number; kind: 'ts' | 'lan' | 'loop' }>
  /** Id of the link this invite updates (same host key and share), if any. */
  existingId?: string
}

export type SharePreviewRes = { ok: true; preview: SharePreview } | { ok: false; error: SharePreviewError }

export type ShareJoinRes =
  | { ok: true; link: ShareLinkView }
  | { ok: false; error: SharePreviewError | 'limit' | 'unavailable' }

export interface ShareLinksRes {
  /** False = links and passwords cannot be saved on this PC (no encryption). */
  persisted: boolean
  /** This PC's guest key fingerprint, as hosts see it (null until the first join). */
  guestFingerprint: string | null
  links: ShareLinkView[]
}

export interface SharePasswordReq {
  linkId: string
  password: string
  /** Keep the derived key (never the password) for unattended reconnects. */
  remember: boolean
}

export type SharePasswordRes = { ok: true } | { ok: false; error: 'not_pending' | 'invalid' | 'offline' | 'failed' }

export type ShareGuestCtlReq =
  | { linkId: string; op: 'createPane'; presetId?: string; paneType?: 'shell' | 'claude' | 'codex' }
  | { linkId: string; op: 'closePane'; paneId: string }

export interface ShareGuestCtlRes {
  ok: boolean
  paneId?: string
  error?: ShareCtlError | 'offline' | 'timeout'
}

export interface ShareGuestGitReq {
  linkId: string
  op: 'status' | 'diff'
  path?: string
  staged?: boolean
  page?: number
}

export type ShareGuestRequestError = 'offline' | 'timeout' | 'denied' | 'invalid' | 'busy'

export interface ShareGuestGitRes {
  ok: boolean
  reply?: RemoteGitReply
  error?: ShareGuestRequestError
}

export interface ShareGuestNotesReq {
  linkId: string
  op: 'list' | 'read'
  noteId?: string
}

export interface ShareGuestNotesRes {
  ok: boolean
  reply?: ShareNotesReply
  error?: ShareGuestRequestError
}

export interface ShareGuestInputReq {
  linkId: string
  paneId: string
  /** <= SHARE_LIMITS.pasteMax per call; main gates it whole, then chunks it. */
  data: string
  /** A paste (gated and sent as one unit even when short). */
  paste?: boolean
}

export interface ShareFlowReq {
  linkId: string
  paneId: string
  /** true = the renderer's xterm is behind: stop forwarding output; false = resume (a resync follows). */
  pause: boolean
}

export interface ShareChatReq {
  linkId: string
  op: 'sub' | 'unsub' | 'more'
  paneId: string
  /** `more` only: the cursor of the oldest item held. */
  before?: string
}

/** A guest write refused in main before it reached the host (no seq: it was never sent). */
export interface ShareInputRefused {
  t: 'inputRefused'
  paneId: string
  reason: ShareDenyReason | 'offline'
}

/** Terminal-plane items, in arrival order (consecutive `out` of a pane are joined). */
export type ShareStreamItem =
  | Extract<ShareHostMsg, { t: 'replay' | 'out' | 'exit' | 'fit' | 'paneStatus' | 'inputLock' | 'inputDenied' }>
  | ShareInputRefused

/** Main -> renderer `share:stream`, batched every 16 ms per link. */
export interface ShareStreamEvt {
  linkId: string
  items: ShareStreamItem[]
}

/** Main -> renderer `share:linkEvent`. The stream of that link is flushed before each. */
export type ShareLinkEvt =
  | { t: 'link'; link: ShareLinkView }
  /** The filtered scope (welcome or a later `state`); statuses then move on the stream. */
  | { t: 'state'; linkId: string; state: ShareState }
  | { t: 'removed'; linkId: string }
  | { t: 'notesChanged'; linkId: string; noteId?: string }
  /** The host answered a frame with `err` (rate, out_of_scope...). */
  | { t: 'err'; linkId: string; code: Extract<ShareHostMsg, { t: 'err' }>['code'] }

/** Main -> renderer `share:chatEvent`. */
export interface ShareChatEvt {
  linkId: string
  msg: Extract<ShareHostMsg, { t: 'chatPage' | 'chatAppend' }>
}
