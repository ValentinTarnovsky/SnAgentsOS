/**
 * Remote-control wire protocol: message shapes exchanged over the embedded
 * WebSocket server between the desktop (main process) and phone clients.
 *
 * Pure types only - no zod, no Node, no DOM - because this file is bundled
 * into three targets: main, renderer and the mobile web client. Runtime
 * validation schemas live in remote-protocol-schemas.ts (main-only). It may
 * import only types.ts and git-types.ts, both import-free of Node and DOM.
 */
import type {
  AgentProvider,
  AttentionReason,
  ClaudePaneState,
  KeyButton,
  Language,
  PaneType,
  QuickCommand,
  RemotePending,
  ThemeName,
  ThemeTokens,
} from './types'
import type { RemoteGitChip } from './git-types'

export type { RemotePending, RemoteGitChip }

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

/**
 * Agent status of one pane as the phone sees it (E1-FR-03, CONTRATOS). Main
 * builds it from StatusManager and never copies the desktop-only fields
 * (sessionId, cwd, detail, topic, firstPrompt, cacheSince).
 */
export interface RemotePaneStatus {
  state: ClaudePaneState
  /** false = inferred from the OSC title (SSH or no hooks); absent = true. */
  precise?: boolean
  provider?: AgentProvider
  reason?: AttentionReason
  pendingCount?: number
  /** Desktop clock (epoch ms) of the last state transition. */
  stateSince: number
  /** Last assistant reply, <= 280. */
  lastMessage?: string
  /** Current tool, <= 120. */
  activity?: string
  pending?: RemotePending[]
}

export interface RemotePaneInfo {
  id: string
  title: string
  type: PaneType
  color: string
  icon: string
  /** True when a live pty is bound to this pane (authoritative in main). */
  running: boolean
  /**
   * Agent pane without a Connection Profile whose last session can be resumed
   * (D10, computed in the renderer's remoteSnapshot). Absent = hide "Relaunch
   * resuming" and "New chat".
   */
  resumable?: boolean
  /**
   * Exit code of a console whose shell ended on its own (E6-FR-38), overlaid
   * by main like `running`; absent while running or never started.
   */
  exitCode?: number
  /** Agent status overlaid by main on every state / authOk (E1-FR-03). */
  status?: RemotePaneStatus
}

export interface RemoteWorkspaceInfo {
  id: string
  name: string
  /** Pane ids in display order (grid placement). */
  layoutOrder: string[]
  panes: RemotePaneInfo[]
  /** Git chip of the workspace cwd (E7-FR-09). Omitted without a repo, on error or with settings.gitChip off. */
  git?: RemoteGitChip
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

/** An agent preset as the phone's console picker shows it (E2-FR-10/12). */
export interface RemotePresetInfo {
  id: string
  name: string
  type: PaneType
  icon: string
  color: string
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
  /**
   * Quick Commands (E8-FR-07, replaces `snippets`): globals and every
   * workspace's own. The phone runs them by id (`runQuickCommand`); the
   * desktop resolves the text.
   */
  quickCommands?: QuickCommand[]
  /** Custom phone KeyBar buttons. */
  keyButtons?: KeyButton[]
  /** Live usage bars (undefined/null when the usage widget is off). */
  usage?: RemoteUsageSnapshot | null
  /** xterm unicode width table the desktop uses (E6-FR-15); absent = '6'. */
  terminalUnicode?: '6' | '11'
  /** Agent presets in their desktop order, for the phone's console picker (E2-FR-10/12). */
  presets?: RemotePresetInfo[]
  /** os.hostname() of the desktop, injected by main into every snapshot it emits (E2-FR-02/12). */
  hostName?: string
  /**
   * Workspaces fully mounted on the desktop (D4: the 'full' keys of
   * mountedWorkspaces). Opening a stopped pane of any other workspace asks the
   * phone to confirm `mountWorkspace` first (E2-FR-06/12).
   */
  mountedWorkspaceIds?: string[]
}

// --- Control actions (phone -> desktop, executed by the renderer) ---

export type RemoteCtlAction =
  | { kind: 'switchWorkspace'; workspaceId: string }
  /**
   * `prompt` (E2-FR-11, <= 16384): initial prompt of a claude/codex preset,
   * delivered only through the SNAOS_INITIAL_PROMPT variable. When that is not
   * possible the console opens without it and the ack says `promptFallback`.
   */
  | { kind: 'createPane'; workspaceId: string; presetId?: string; paneType?: PaneType; prompt?: string }
  | { kind: 'closePane'; workspaceId: string; paneId: string }
  /**
   * `resume` (E4/E5-FR-11): true = relaunch resuming the chat, false = new chat
   * (forgets the session), absent = the header restart button's rule (old bundles).
   */
  | { kind: 'restartPane'; workspaceId: string; paneId: string; resume?: boolean }
  | { kind: 'globalPrompt'; workspaceId: string; text: string }
  | { kind: 'setTheme'; theme: ThemeName }
  | { kind: 'renamePane'; workspaceId: string; paneId: string; title: string }
  /**
   * E8-FR-07: run a Quick Command by id. `send` needs `paneId` (the console
   * open on the phone; never the desktop's focus) and answers `not_running`
   * without a live pty; `agent` creates the console in `workspaceId` without
   * activating it and acks its id. The command must be global or scoped to
   * `workspaceId`, else `not_found`.
   */
  | { kind: 'runQuickCommand'; workspaceId: string; paneId?: string; id: string }
  // --- E2 Home (R22-14) ---
  /** Mount every console of a workspace without activating it (E2-FR-06). */
  | { kind: 'mountWorkspace'; workspaceId: string }
  /** "Show on the PC": restore and focus the window, then reveal the pane (E2-FR-07). */
  | { kind: 'revealPane'; paneId: string }
  /**
   * E2-FR-29/30: a path tapped in the phone terminal. The renderer resolves the
   * root from its own store (the pane's launch cwd, then `ws.cwd`) and main
   * opens an inert file or reveals it. Ack errors: denied_path, not_found, rate.
   */
  | { kind: 'openPath'; workspaceId: string; paneId: string; path: string }
  /** E2-FR-28: open a link on the PC (http, https or mailto only, <= 2048; else ack denied_url). */
  | { kind: 'openUrl'; url: string }

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
      /** With running:false: the pty ended on its own and `data` is its last output (E6-FR-20). */
      exitCode?: number
    }
  | { v: number; type: 'out'; paneId: string; data: string }
  | { v: number; type: 'exit'; paneId: string; exitCode: number }
  /** Live agent status change, straight from main (E1-FR-03); null clears it. */
  | { v: number; type: 'paneStatus'; paneId: string; status: RemotePaneStatus | null }
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
      /**
       * createPane with `prompt`: the console opened without it (E2-FR-11);
       * the phone keeps the text in that console's composer draft.
       */
      promptFallback?: boolean
    }
  | { v: number; type: 'revoked' }
  | { v: number; type: 'shutdown'; reason: 'quit' | 'disabled' }
  | { v: number; type: 'pong'; t: number }
  | { v: number; type: 'err'; code: RemoteErrCode; msg?: string }
