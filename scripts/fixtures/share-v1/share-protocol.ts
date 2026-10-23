// Frozen copy of src/shared/share-protocol.ts as of app 2.5.0 (share protocol v1): the v1 guest of the compatibility tests. Never edit.
/**
 * Desktop-to-desktop Share wire protocol (app 2.4.0, item 8): the frames a
 * host SnAgentsOS and a guest SnAgentsOS exchange over the share listener
 * (`settings.share.port`, default 4527). Separate from the phone protocol:
 * `PROTOCOL_VERSION`, `remote-protocol*.ts` and SessionManager are untouched.
 *
 * Pure types and constants only - no zod, no Node, no DOM - because main and
 * the renderer (the guest's pre-check and views) both import it. Runtime
 * validation lives in share-protocol-schemas.ts; the byte rules of the
 * "type without send" permission in shareInput.ts.
 *
 * Wire layout: the handshake (`hs1`, `hs2`, `hsErr`) travels as cleartext
 * JSON text frames; after it every frame is one binary AES-256-GCM record of
 * UTF-8 JSON (src/main/share/crypto.ts). Every message carries `t`.
 */
import type { AgentProvider, ClaudePaneState, PaneType, SharePerm } from './types'
import type { ChatMessage } from './chat-types'
import type { RemoteGitReply, RemoteNote } from './remote-protocol'
import type { WsNoteError, WsNoteMeta } from './ws-notes'

export type { SharePerm }

export const SHARE_PROTOCOL_VERSION = 1
/** Oldest peer version this build still speaks. */
export const SHARE_MIN_VERSION = 1

/** Upgrade path, custom header and subprotocol: a browser WebSocket can set neither of the last two. */
export const SHARE_WS_PATH = '/share'
export const SHARE_HEADER = 'x-snaos-share'
export const SHARE_SUBPROTOCOL = 'snaos-share.1'
/** Prefix of an invite string (`snaos-share:1:<base64url JSON>`, src/main/share/invite.ts). */
export const SHARE_INVITE_PREFIX = 'snaos-share:1:'
export const SHARE_DEFAULT_PORT = 4527

/** WebSocket close codes of the share listener. */
export const SHARE_CLOSE = {
  /** Malformed frame or a record that fails authentication. */
  BAD_MSG: 4400,
  /** Unknown share or a wrong invite proof. */
  BAD_INVITE: 4401,
  /** The host denied the request, or revoked the grant. */
  DENIED: 4403,
  /** Handshake, approval or keepalive timeout. */
  TIMEOUT: 4408,
  EXPIRED: 4410,
  /** The shared console or workspace no longer exists. */
  SCOPE_GONE: 4411,
  KICKED: 4412,
  /** No protocol version in common. */
  VERSION: 4426,
  /** Too many failures from this address. */
  LOCKED: 4429,
  /** Host quitting or sharing turned off: the guest may come back later. */
  GOING_AWAY: 1001,
} as const

/** Close codes after which a guest never reconnects on its own. */
export const SHARE_NO_RECONNECT: readonly number[] = [
  SHARE_CLOSE.BAD_INVITE,
  SHARE_CLOSE.DENIED,
  SHARE_CLOSE.EXPIRED,
  SHARE_CLOSE.SCOPE_GONE,
  SHARE_CLOSE.KICKED,
  SHARE_CLOSE.VERSION,
]

/** Bounds both ends enforce (the host is authoritative, the guest validates every host frame). */
export const SHARE_LIMITS = {
  /** One `input` frame's data, in UTF-16 units. */
  inputMax: 8192,
  /** A whole paste (or one IPC input call before chunking): 8 input frames. */
  pasteMax: 65536,
  pasteParts: 8,
  /** `out` and `replay` data per frame, in UTF-16 units (never splits a surrogate pair). */
  outChunkMax: 16384,
  replayChunkMax: 16384,
  /** Host frame size the guest accepts (ws maxPayload), and guest frame size the host accepts. */
  hostFrameMax: 1024 * 1024,
  guestFrameMax: 64 * 1024,
  colsMin: 2,
  colsMax: 1000,
  rowsMin: 1,
  rowsMax: 500,
  panesMax: 64,
  presetsMax: 64,
  titleMax: 128,
  labelMax: 64,
  hostLabelMax: 48,
  guestNameMax: 48,
  appMax: 32,
  passwordMin: 8,
  passwordMax: 128,
} as const

/** A lone Esc keeps this window open: the next guest write is gated joined to it (shareInput.ts). */
export const SHARE_ESC_WINDOW_MS = 1000
/** Owner keystroke lease (desktop or phone) and guest-to-guest lease. */
export const SHARE_HOST_LEASE_MS = 1500
export const SHARE_GUEST_LEASE_MS = 2000
/** Approval prompt lifetime and reconnect ticket window after the last disconnect. */
export const SHARE_APPROVAL_TTL_MS = 60_000
export const SHARE_TICKET_TTL_MS = 15 * 60_000
/** scrypt parameters of the unattended password (verify is an HMAC, the host never runs scrypt per attempt). */
export const SHARE_SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const

// eslint-disable-next-line no-control-regex
const SHARE_TEXT_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/**
 * One-line display text as the share schemas accept it: control, bidi and
 * zero-width characters removed, trimmed, at most `max` UTF-16 units without
 * splitting a surrogate pair. The host runs titles and labels through it
 * before they go into a ShareState, so a valid host never trips the guest.
 */
export function shareText(s: string, max: number): string {
  let out = s.replace(SHARE_TEXT_STRIP_RE, '').trim()
  if (out.length > max) {
    let end = max
    const code = out.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end--
    out = out.slice(0, end)
  }
  return out
}

export type ShareScopeKind = 'pane' | 'workspace'
export type ShareHostPlatform = 'win32' | 'darwin' | 'linux'

// --- Handshake (cleartext text frames) ---

/**
 * Guest -> host. `e`: the guest's ephemeral X25519 public key (base64url, 32
 * bytes). `s`: the guest's static public key sealed to the host's pinned key
 * (crypto.ts), so a passive observer never sees who joins.
 */
export interface ShareHs1 {
  t: 'hs1'
  sv: number
  min: number
  e: string
  s: string
}

/** Host -> guest: the host's ephemeral key and the version both speak. A sealed `ready` follows. */
export interface ShareHs2 {
  t: 'hs2'
  sv: number
  e: string
}

export interface ShareHsErr {
  t: 'hsErr'
  code: 'version' | 'bad_msg'
  min: number
  max: number
  app?: string
}

export type ShareHandshakeMsg = ShareHs1 | ShareHs2 | ShareHsErr

// --- Shared shapes ---

/** Agent status of a shared pane: RemotePaneStatus without the host-local pending, attention or account fields. */
export interface ShareAgentStatus {
  state: ClaudePaneState
  /** false = inferred from the OSC title; absent = true. */
  precise?: boolean
  provider?: AgentProvider
  /** A shell console running a hand-typed agent. */
  hosted?: true
  stateSince: number
  /** Current tool, <= 120. */
  activity?: string
  model?: string
  effort?: string
}

export interface SharePaneInfo {
  id: string
  title: string
  type: PaneType
  color: string
  icon: string
  running: boolean
  exitCode?: number
  status?: ShareAgentStatus
}

export interface SharePresetInfo {
  id: string
  name: string
  type: PaneType
  icon: string
  color: string
}

/** What the session may do beyond the terminal (only `full` on a workspace scope gets any). */
export interface ShareCaps {
  createPane: boolean
  closePane: boolean
  chat: boolean
  notes: boolean
  git: boolean
}

/** The filtered view of the shared scope: never usage, accounts, quick commands nor other workspaces. */
export interface ShareState {
  scope: { kind: ShareScopeKind; label: string }
  perm: SharePerm
  title: string
  layoutOrder: string[]
  panes: SharePaneInfo[]
  terminalUnicode11: boolean
  hostPlatform: ShareHostPlatform
  caps: ShareCaps
  /** Only with caps.createPane. */
  presets?: SharePresetInfo[]
}

/** Why a guest write was refused (inputDenied). */
export type ShareDenyReason =
  | 'view_only'
  /** CR or LF anywhere in the write (Enter, Ctrl+J, multi-line paste). */
  | 'no_send'
  /** Ctrl+C, Ctrl+D, Ctrl+Z or Ctrl+\. */
  | 'interrupt'
  /** A key outside the "type" allowlist (Ctrl+O/G/X/V/S/Q/]/A/B, Shift+Tab, CSI-u, Meta...). */
  | 'blocked_key'
  /** The agent waits on a request (state action): only Esc passes. */
  | 'awaiting_host'
  /** Agent pane without a precise status: only Esc passes (fail closed). */
  | 'not_precise'
  /** Tab in an agent pane that is not idle (Codex queues the message with Tab). */
  | 'agent_busy'
  /** `~` right after Enter (the OpenSSH escape). */
  | 'ssh_escape'
  | 'host_typing'
  | 'other_typing'
  | 'paused'
  | 'rate'
  | 'out_of_scope'
  | 'paste_too_large'
  | 'paste_incomplete'

export type ShareEndReason = 'revoked' | 'kicked' | 'expired' | 'scope_gone' | 'host_quit' | 'sharing_off'
export type ShareDeniedReason = 'denied' | 'timeout' | 'locked' | 'busy' | 'limit'
export type ShareErrCode = 'bad_msg' | 'out_of_scope' | 'unsupported' | 'rate' | 'paused' | 'unauthorized'
export type ShareCtlError = 'out_of_scope' | 'bad_preset' | 'rate' | 'failed' | 'unsupported' | 'denied'

// --- Guest -> host (sealed) ---

export type ShareClientMsg =
  /**
   * First sealed frame. `proof` = HMAC(inviteKey, 'join', h); `ticket` the
   * reconnect ticket of a previous welcome; `pw` = HMAC(passwordKey, 'pw', h).
   * The guest is identified by its static key, never by a field it asserts.
   */
  | { t: 'hello'; sid: string; guestName: string; app: string; proof: string; ticket?: string; pw?: string }
  /** While pending: the unattended password proof. */
  | { t: 'password'; proof: string }
  | { t: 'sub'; paneId: string }
  | { t: 'unsub'; paneId: string }
  /** Same as unsub + sub (after the guest renderer's backpressure). */
  | { t: 'resync'; paneId: string }
  /**
   * Keystrokes, <= SHARE_LIMITS.inputMax. A paste travels as parts of one
   * `paste.id`; the host gates the joined paste before writing any of it.
   */
  | { t: 'input'; paneId: string; data: string; seq: number; paste?: { id: number; part: number; last: boolean } }
  | { t: 'ctl'; id: string; op: 'createPane'; presetId?: string; paneType?: 'shell' | 'claude' | 'codex' }
  | { t: 'ctl'; id: string; op: 'closePane'; paneId: string }
  | { t: 'chatSub'; paneId: string }
  | { t: 'chatUnsub'; paneId: string }
  | { t: 'chatMore'; paneId: string; before: string }
  | { t: 'gitReq'; id: string; op: 'status' | 'diff'; path?: string; staged?: boolean; page?: number }
  /** Read-only: list and read; write, create and delete do not exist here. */
  | { t: 'notesReq'; id: string; op: 'list' | 'read'; noteId?: string }
  | { t: 'ping'; ts: number }
  | { t: 'bye' }

// --- Host -> guest (sealed) ---

export interface ShareWelcome {
  t: 'welcome'
  session: { id: string }
  grant: { scope: { kind: ShareScopeKind; label: string } }
  perm: SharePerm
  host: { label: string; platform: ShareHostPlatform; app: string }
  /** Reconnect ticket (base64url, 32 bytes): bound to this guest's key and its effective perm. */
  ticket: string
  state: ShareState
  limits: { inputMax: number }
}

/** The notes answer without the write half (no conflict copy). */
export interface ShareNotesReply {
  ok: boolean
  error?: WsNoteError
  notes?: WsNoteMeta[]
  note?: RemoteNote
}

export type ShareHostMsg =
  | { t: 'ready' }
  | { t: 'pending'; expiresAt: number; password: boolean; salt?: string; passwordFailed?: boolean }
  | { t: 'denied'; reason: ShareDeniedReason }
  | ShareWelcome
  | { t: 'state'; state: ShareState }
  /** A pane's replay in parts; the guest resets its terminal on `first`. */
  | { t: 'replay'; paneId: string; running: boolean; cols: number; rows: number; exitCode?: number; data: string; first: boolean; last: boolean }
  | { t: 'out'; paneId: string; data: string }
  | { t: 'exit'; paneId: string; code: number | null }
  | { t: 'fit'; paneId: string; cols: number; rows: number }
  | { t: 'paneStatus'; paneId: string; status: ShareAgentStatus | null }
  | { t: 'inputLock'; paneId: string; holder: 'host' | 'you' | 'other' | null }
  | { t: 'inputDenied'; paneId: string; seq: number; reason: ShareDenyReason }
  | { t: 'permChanged'; perm: SharePerm }
  | { t: 'paused'; on: boolean }
  | { t: 'ctlAck'; id: string; ok: boolean; paneId?: string; error?: ShareCtlError }
  | { t: 'chatPage'; paneId: string; items: ChatMessage[]; cursor: string | null; done: boolean }
  | { t: 'chatAppend'; paneId: string; items: ChatMessage[] }
  | ({ t: 'gitRes'; id: string } & RemoteGitReply)
  | ({ t: 'notesRes'; id: string } & ShareNotesReply)
  | { t: 'notesChanged'; noteId?: string }
  | { t: 'ended'; reason: ShareEndReason }
  | { t: 'pong'; ts: number }
  | { t: 'err'; code: ShareErrCode }

export type ShareClientType = ShareClientMsg['t']
export type ShareHostType = ShareHostMsg['t']
