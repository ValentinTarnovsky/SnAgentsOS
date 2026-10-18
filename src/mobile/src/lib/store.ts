/**
 * Zustand store: the reactive projection of the WS client's state that the
 * React tree renders. The client (client.ts) owns the socket and mutates this
 * store via update(); components read it and call client methods for actions.
 * Kept intentionally lean - no business logic lives here.
 */
import { create } from 'zustand'
import type { ITheme } from '@xterm/xterm'
import type {
  RemoteAuthFailReason,
  RemotePairDeniedReason,
  RemoteStateSnapshot,
} from '@shared/remote-protocol'

/** Top-level screen routing. Banners overlay the 'live' screen separately. */
export type Phase =
  | 'idle'
  | 'connecting'
  | 'welcome'
  | 'pairForm'
  | 'pairPending'
  | 'pairDenied'
  | 'live'
  | 'revoked'
  | 'rePair'
  | 'impostor'
  | 'locked'
  /** The desktop runs a different version than this bundle (E1-FR-15). */
  | 'updated'

/**
 * Transient overlay shown on top of the live terminal. desktopGone is sticky: it
 * stays through the reconnect attempts until the next authOk.
 */
export type Banner =
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'desktopGone' }
  | { kind: 'disabled' }

/** Why the phone entered phase 'updated' (E1-FR-15). */
export interface UpdateInfo {
  /** This bundle's version. */
  from: string
  /** The desktop's version ('' when unknown, e.g. a protocol error before authOk). */
  to: string
  /** mismatch = authOk version differs (can continue); protocol = err:'version'. */
  kind: 'mismatch' | 'protocol'
  /** The mismatch survived a reload already (sessionStorage guard). */
  retried: boolean
}

export interface RemoteState {
  phase: Phase
  banner: Banner | null
  snapshot: RemoteStateSnapshot | null
  /** xterm palette derived from the snapshot theme tokens. */
  xtermTheme: ITheme | null
  hostPlatform: string
  appVersion: string
  /** Pane the phone is currently viewing. */
  activePaneId: string | null
  /** Pane the server subscription is registered for (may lag activePaneId briefly). */
  subscribedPaneId: string | null
  /** True while waiting for the next printable char to become a control code. */
  ctrlLatch: boolean
  /** Manual font-size override from the settings sheet (null = auto-fit). */
  fontOverride: number | null
  /** Pairing pending deadline (epoch ms) for the countdown. */
  pairExpiresAt: number | null
  pairReason: RemotePairDeniedReason | null
  authFailReason: RemoteAuthFailReason | null
  /** Lockout deadline (epoch ms) for the 'locked' screen countdown. */
  lockUntil: number | null
  /** Ephemeral toast text (e.g. "Sent to 3 consoles"). */
  toast: string | null
  /** In-app QR scanner overlay (pairing without the #pair= boot fragment). */
  scanOpen: boolean
  // --- connection health (E1-FR-10..15, 41) ---
  /** Reconnect attempt counter shown by the banner (0 = none pending). */
  connAttempt: number
  /** Epoch ms of the last frame on an authed socket, set when it drops. */
  lastConnectedAt: number | null
  /** navigator.onLine as last observed (online/offline events). */
  online: boolean
  /** An authed socket is OPEN right now (input can be delivered). */
  connected: boolean
  /** Set while phase is 'updated'. */
  updateInfo: UpdateInfo | null

  /** Merge a partial state (used by the client for machine transitions). */
  update: (partial: Partial<RemoteState>) => void
  setCtrlLatch: (on: boolean) => void
  setFontOverride: (size: number | null) => void
  setToast: (text: string | null) => void
}

export const useRemoteStore = create<RemoteState>((set) => ({
  phase: 'idle',
  banner: null,
  snapshot: null,
  xtermTheme: null,
  hostPlatform: '',
  appVersion: '',
  activePaneId: null,
  subscribedPaneId: null,
  ctrlLatch: false,
  fontOverride: null,
  pairExpiresAt: null,
  pairReason: null,
  authFailReason: null,
  lockUntil: null,
  toast: null,
  scanOpen: false,
  connAttempt: 0,
  lastConnectedAt: null,
  online: true,
  connected: false,
  updateInfo: null,

  update: (partial) => set(partial),
  setCtrlLatch: (on) => set({ ctrlLatch: on }),
  setFontOverride: (size) => set({ fontOverride: size }),
  setToast: (text) => set({ toast: text }),
}))

/** Non-hook accessor for the client and imperative callers. */
export const store = useRemoteStore
