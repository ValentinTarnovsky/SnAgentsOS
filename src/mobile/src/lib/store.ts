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

/** Transient overlay shown on top of the live terminal. */
export type Banner =
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'desktopGone' }
  | { kind: 'disabled' }

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

  update: (partial) => set(partial),
  setCtrlLatch: (on) => set({ ctrlLatch: on }),
  setFontOverride: (size) => set({ fontOverride: size }),
  setToast: (text) => set({ toast: text }),
}))

/** Non-hook accessor for the client and imperative callers. */
export const store = useRemoteStore
