/**
 * Remote-control wire protocol: message shapes exchanged over the embedded
 * WebSocket server between the desktop (main process) and phone clients.
 *
 * Pure types only - no zod, no Node, no DOM - because this file is bundled
 * into three targets: main, renderer and the mobile web client. Runtime
 * validation schemas live in remote-protocol-schemas.ts (main-only).
 */
import type { KeyButton, Language, PaneType, Snippet, ThemeName, ThemeTokens } from './types'

export const PROTOCOL_VERSION = 1

/**
 * WebSocket close codes used by the server. Only REVOKED tells the phone to
 * forget its stored secret; UNKNOWN_DEVICE may just mean a different desktop
 * instance answered (re-pair without wiping).
 */
export const REMOTE_CLOSE = {
  UNKNOWN_DEVICE: 4401,
  REVOKED: 4403,
  RATE_LIMITED: 4429,
} as const

export type RemoteEndpointKind = 'lan' | 'tailscale' | 'other'

// --- State snapshot (desktop -> phone) ---

export interface RemotePaneInfo {
  id: string
  title: string
  type: PaneType
  color: string
  icon: string
  /** True when a live pty is bound to this pane (authoritative in main). */
  running: boolean
}

export interface RemoteWorkspaceInfo {
  id: string
  name: string
  /** Pane ids in display order (grid placement). */
  layoutOrder: string[]
  panes: RemotePaneInfo[]
}

/**
 * One usage bar as seen by the phone. Structural mirror of the desktop's
 * `UsageRow` (ipc-contract.ts), duplicated here to keep this wire protocol
 * self-contained (ipc-contract imports THIS file, so it can't be imported back).
 */
export interface RemoteUsageRow {
  id: string
  provider: 'claude' | 'codex' | 'custom'
  kind: '5h' | '7d' | 'custom'
  /** Resolved display label (model name for custom rows). */
  label: string
  /** 0..100 quota utilization, or null for a custom row with no token budget. */
  percent: number | null
  /** Absolute tokens used (custom rows). */
  used?: number
  /** Token budget (custom rows with a configured budget). */
  limit?: number
  /** ISO-8601 reset time, when the source provides one. */
  resetsAt?: string | null
  /** Subscription/plan label (Codex: plus/pro/...). */
  planType?: string | null
  status: 'ok' | 'expired' | 'error' | 'nodata' | 'loading'
}

/** Snapshot of the desktop's live usage bars, mirrored to the phone. */
export interface RemoteUsageSnapshot {
  rows: RemoteUsageRow[]
  /** Epoch ms the snapshot was produced. */
  updatedAt: number
  /** Anthropic service health, when the status dot is enabled. */
  services?: 'operational' | 'degraded' | 'down' | null
}

/** Compact mirror of the desktop state, pushed to every authed phone. */
export interface RemoteStateSnapshot {
  workspaces: RemoteWorkspaceInfo[]
  activeWorkspaceId: string | null
  /** Resolved flat theme tokens (base theme + custom overrides). */
  themeTokens: ThemeTokens
  /** Named theme id (undefined for older desktops mid-upgrade). */
  themeName?: ThemeName
  language: Language
  fontFamily: string
  fontSize: number
  /** Saved prompt snippets, invocable from the phone. */
  snippets?: Snippet[]
  /** Custom phone KeyBar buttons. */
  keyButtons?: KeyButton[]
  /** Live usage bars (undefined/null when the usage widget is off). */
  usage?: RemoteUsageSnapshot | null
}

// --- Control actions (phone -> desktop, executed by the renderer) ---

export type RemoteCtlAction =
  | { kind: 'switchWorkspace'; workspaceId: string }
  | { kind: 'createPane'; workspaceId: string; presetId?: string; paneType?: PaneType }
  | { kind: 'closePane'; workspaceId: string; paneId: string }
  | { kind: 'restartPane'; workspaceId: string; paneId: string }
  | { kind: 'globalPrompt'; workspaceId: string; text: string }
  | { kind: 'setTheme'; theme: ThemeName }
  | { kind: 'renamePane'; workspaceId: string; paneId: string; title: string }

// --- Client -> server messages ---

export type RemoteClientMsg =
  | { v: number; type: 'hello'; deviceId?: string; clientNonce: string }
  | { v: number; type: 'pair'; code: string; deviceName: string }
  | { v: number; type: 'auth'; deviceId: string; hmac: string }
  | { v: number; type: 'sub'; paneId: string }
  | { v: number; type: 'unsub'; paneId: string }
  | { v: number; type: 'input'; paneId: string; data: string }
  | { v: number; type: 'ctl'; id: string; action: RemoteCtlAction }
  | { v: number; type: 'ping'; t: number }

// --- Server -> client messages ---

export type RemotePairDeniedReason = 'denied' | 'expired' | 'badCode' | 'limit'
export type RemoteAuthFailReason = 'unknownDevice' | 'badHmac' | 'locked'
export type RemoteErrCode = 'bad_msg' | 'unauthorized' | 'version' | 'rate'

export type RemoteServerMsg =
  | {
      v: number
      type: 'challenge'
      /** Server nonce the client must HMAC with the device secret. */
      nonce: string
      /**
       * Mutual auth: HMAC(secret, clientNonce) proving the server knows the
       * device secret. The client MUST verify this before sending its own
       * HMAC. Absent during pairing (no secret exists yet).
       */
      proof?: string
    }
  | { v: number; type: 'pairPending' }
  | {
      v: number
      type: 'paired'
      deviceId: string
      /** The only time the shared secret ever travels. */
      secret: string
    }
  | { v: number; type: 'pairDenied'; reason: RemotePairDeniedReason }
  | {
      v: number
      type: 'authOk'
      deviceId: string
      state: RemoteStateSnapshot
      /** Desktop OS (drives e.g. xterm windowsPty on the phone). */
      hostPlatform: string
      appVersion: string
    }
  | { v: number; type: 'authFail'; reason: RemoteAuthFailReason; retryAfterMs?: number }
  | { v: number; type: 'state'; state: RemoteStateSnapshot }
  | {
      v: number
      type: 'replay'
      paneId: string
      /** False = pane exists but no live pty yet (lazy spawn pending). */
      running: boolean
      data: string
      cols: number
      rows: number
    }
  | { v: number; type: 'out'; paneId: string; data: string }
  | { v: number; type: 'exit'; paneId: string; exitCode: number }
  | {
      v: number
      type: 'ctlAck'
      id: string
      ok: boolean
      error?: string
      /** createPane: id of the new pane so the phone can auto-subscribe. */
      paneId?: string
      /** globalPrompt: number of consoles the text was sent to. */
      info?: number
    }
  | { v: number; type: 'revoked' }
  | { v: number; type: 'shutdown'; reason: 'quit' | 'disabled' }
  | { v: number; type: 'pong'; t: number }
  | { v: number; type: 'err'; code: RemoteErrCode; msg?: string }
