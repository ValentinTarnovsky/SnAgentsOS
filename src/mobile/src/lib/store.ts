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
  RemotePaneStatus,
  RemoteStateSnapshot,
} from '@shared/remote-protocol'
import {
  loadPagePrefs,
  savePagePrefs,
  loadCollapsed,
  loadInputModes,
  loadLastPane,
  loadLastViewed,
  loadPref,
  resolveInputMode,
  saveCollapsed,
  saveInputMode,
  saveLastPane,
  saveLastViewed,
  savePref,
  withViewed,
  type ComposerPref,
  type InputMode,
  type PagePrefs,
} from './prefs'
import { paneById, workspaceOfPane } from './workspace'
import { loadFontScale, saveFontScale } from './fit'

/**
 * E1-FR-20: the soft keyboard counts as open only while an input field has the
 * focus AND visualViewport says it covers more than this many px.
 */
export const KB_OPEN_MIN_INSET_PX = 120

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

/**
 * The live screen on top (E2-FR-01, 13). Home is always underneath; the
 * terminal and Settings slide over it. LiveShell renders the stack and owns
 * the back claims; the client moves it (open a console, a closed console).
 */
export type LiveScreen = 'home' | 'terminal' | 'settings' | 'diagnostics'

/** What a toast is about: a plain notice, or a console's state (E2-FR-43). */
export type MobileToastKind = 'info' | 'action' | 'error' | 'done'

/** One in-page toast (E2-FR-11, 43, 47). `id` orders and dismisses them. */
export interface MobileToast {
  id: number
  text: string
  /** Default 'info'; action and error last 6s, done 4s (ToastStack). */
  kind?: MobileToastKind
  /** The console [Go] opens (state toasts only). */
  paneId?: string
}

/** Most toasts shown at once; older ones drop first. */
export const TOASTS_MAX = 3

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
  /** Text size multiplier on the auto-fit size (pinch / Settings presets, E2-FR-34). */
  fontScale: number
  /** Pairing pending deadline (epoch ms) for the countdown. */
  pairExpiresAt: number | null
  pairReason: RemotePairDeniedReason | null
  authFailReason: RemoteAuthFailReason | null
  /** Lockout deadline (epoch ms) for the 'locked' screen countdown. */
  lockUntil: number | null
  /** Ephemeral toast text (e.g. "Sent to 3 consoles"): the newest of `toasts`. */
  toast: string | null
  /** Toasts on screen, oldest first (at most TOASTS_MAX; E2-FR-43 kinds and [Go]). */
  toasts: MobileToast[]
  // --- Home (E2-FR-01..16, 47; R22-14) ---
  screen: LiveScreen
  /** Last console the terminal showed ('snagentsos.lastPane'), for the Resume card. */
  lastPane: string | null
  /** paneId -> when this phone last saw it ('snagentsos.lastViewed'), for unread rows. */
  lastViewedAt: Record<string, number>
  /** Collapsed workspace sections ('snagentsos.home.collapsed'). */
  homeCollapsed: string[]
  /** A stopped console of a workspace the desktop has not mounted: confirm first (E2-FR-06). */
  mountAsk: string | null
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
  /** Soft keyboard overlap in px, measured by viewport.ts (keyboardInset). */
  keyboardInset: number
  /** Input field holding the focus: 'direct' (xterm helper textarea), the
   * data-kb-input value of another field (the composer), or null. */
  kbFocus: string | null
  /** Derived: kbFocus is set and keyboardInset > KB_OPEN_MIN_INSET_PX. */
  kbOpen: boolean
  /** xterm unicode width table sent by the desktop (E6-FR-15). */
  terminalUnicode: '6' | '11'
  /**
   * Agent status per pane (E1-FR-03). Rebuilt from panes[].status on every
   * authOk / state; a live paneStatus upserts or deletes one entry.
   */
  paneStatus: Record<string, RemotePaneStatus>
  /** "On-screen alerts" (E2-FR-44 `toasts`, 'snagentsos.prefs'): state toasts in the terminal. */
  inPageAlerts: boolean
  /** "Vibrate" on action and error (E2-FR-44). */
  alertVibrate: boolean
  /** "Alert when a turn ends": done toasts too (E2-FR-44). */
  alertDone: boolean
  // --- composer (E1-FR-22..31) ---
  /** Saved explicit input mode per pane ('snagentsos.inputMode.<paneId>'). */
  inputModes: Record<string, InputMode>
  /** AI consoles without a saved mode open in Composer (E1-FR-22). */
  composerDefaultForAgents: boolean
  /** Phone keyboard autocorrect in the composer (E1-FR-30). */
  composerAutocorrect: boolean
  /** Pane whose composer the Paste key opened for one send while it was in
   * Direct (E1-FR-31); it returns to Direct after Send or Insert. */
  composerOneShot: string | null
  /** Slash command typing progress (E1-FR-25), null while idle. */
  slashProgress: { done: number; total: number } | null

  /** Merge a partial state (used by the client for machine transitions). */
  update: (partial: Partial<RemoteState>) => void
  setCtrlLatch: (on: boolean) => void
  /** Set and persist the text size preset ('snagentsos.fontScale'). */
  setFontScale: (scale: number) => void
  /** Shortcut: push a toast (null clears every toast). */
  setToast: (text: string | null) => void
  /** Push a toast with a kind and an optional console for [Go] (E2-FR-43). */
  pushToast: (toast: Omit<MobileToast, 'id'>) => void
  dismissToast: (id: number) => void
  setScreen: (screen: LiveScreen) => void
  /**
   * The terminal showed (or stopped showing) paneId: it becomes lastPane and
   * read up to now (E2-FR-16). The stamp is the status's own stateSince (the
   * desktop clock), so a phone clock ahead of or behind the desktop never
   * hides a later state nor leaves a seen one unread; without a status the
   * previous stamp stays (any status that shows up later is news).
   */
  noteViewed: (paneId: string) => void
  toggleCollapsed: (workspaceId: string) => void
  /** Feed keyboard signals from viewport.ts; recomputes kbOpen. */
  setKeyboard: (k: { inset?: number; focus?: string | null }) => void
  /** Toggle and persist the on-screen alerts preference. */
  setInPageAlerts: (on: boolean) => void
  /** Toggle and persist one page alert preference ('snagentsos.prefs'). */
  setPagePref: (name: keyof PagePrefs, on: boolean) => void
  /** Persist an explicit mode for a pane; ends a one-shot on it. */
  setInputMode: (paneId: string, mode: InputMode) => void
  /** Toggle and persist a composer preference. */
  setComposerPref: (name: ComposerPref, on: boolean) => void
}

let toastSeq = 0

/** The store fields that project 'snagentsos.prefs'. */
function pagePrefsState(p: PagePrefs): Pick<RemoteState, 'inPageAlerts' | 'alertVibrate' | 'alertDone'> {
  return { inPageAlerts: p.toasts, alertVibrate: p.vibrate, alertDone: p.toastDone }
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
  fontScale: loadFontScale(),
  pairExpiresAt: null,
  pairReason: null,
  authFailReason: null,
  lockUntil: null,
  toast: null,
  toasts: [],
  screen: 'home',
  lastPane: loadLastPane(),
  lastViewedAt: loadLastViewed(),
  homeCollapsed: loadCollapsed(),
  mountAsk: null,
  scanOpen: false,
  connAttempt: 0,
  lastConnectedAt: null,
  online: true,
  connected: false,
  updateInfo: null,
  keyboardInset: 0,
  kbFocus: null,
  kbOpen: false,
  terminalUnicode: '6',
  paneStatus: {},
  ...pagePrefsState(loadPagePrefs()),
  inputModes: loadInputModes(),
  composerDefaultForAgents: loadPref('composerDefaultForAgents'),
  composerAutocorrect: loadPref('composerAutocorrect'),
  composerOneShot: null,
  slashProgress: null,

  update: (partial) => set(partial),
  setCtrlLatch: (on) => set({ ctrlLatch: on }),
  setFontScale: (scale) => {
    saveFontScale(scale)
    set({ fontScale: scale })
  },
  setToast: (text) =>
    set((s) => {
      if (text == null) return { toast: null, toasts: [] }
      const toasts = [...s.toasts, { id: ++toastSeq, text }].slice(-TOASTS_MAX)
      return { toast: text, toasts }
    }),
  pushToast: (toast) =>
    set((s) => {
      const toasts = [...s.toasts, { ...toast, id: ++toastSeq }].slice(-TOASTS_MAX)
      return { toast: toast.text, toasts }
    }),
  dismissToast: (id) =>
    set((s) => {
      const toasts = s.toasts.filter((x) => x.id !== id)
      if (toasts.length === s.toasts.length) return s
      return { toasts, toast: toasts.at(-1)?.text ?? null }
    }),
  setScreen: (screen) => set({ screen }),
  noteViewed: (paneId) =>
    set((s) => {
      if (!s.snapshot || !workspaceOfPane(s.snapshot, paneId)) return s
      const at = s.paneStatus[paneId]?.stateSince
      let lastViewedAt = s.lastViewedAt
      if (at !== undefined && at !== lastViewedAt[paneId]) {
        lastViewedAt = withViewed(lastViewedAt, paneId, at)
        saveLastViewed(lastViewedAt)
      }
      if (s.lastPane !== paneId) saveLastPane(paneId)
      return { lastViewedAt, lastPane: paneId }
    }),
  toggleCollapsed: (workspaceId) =>
    set((s) => {
      const homeCollapsed = s.homeCollapsed.includes(workspaceId)
        ? s.homeCollapsed.filter((id) => id !== workspaceId)
        : [...s.homeCollapsed, workspaceId]
      saveCollapsed(homeCollapsed)
      return { homeCollapsed }
    }),
  setKeyboard: (k) =>
    set((s) => {
      const inset = k.inset ?? s.keyboardInset
      const focus = k.focus !== undefined ? k.focus : s.kbFocus
      if (inset === s.keyboardInset && focus === s.kbFocus) return s
      return { keyboardInset: inset, kbFocus: focus, kbOpen: focus != null && inset > KB_OPEN_MIN_INSET_PX }
    }),
  setInPageAlerts: (on) => {
    set(pagePrefsState(savePagePrefs({ toasts: on })))
  },
  setPagePref: (name, on) => {
    set(pagePrefsState(savePagePrefs({ [name]: on })))
  },
  setInputMode: (paneId, mode) => {
    saveInputMode(paneId, mode)
    set((s) => ({
      inputModes: { ...s.inputModes, [paneId]: mode },
      composerOneShot: s.composerOneShot === paneId ? null : s.composerOneShot,
    }))
  },
  setComposerPref: (name, on) => {
    savePref(name, on)
    set(name === 'composerDefaultForAgents' ? { composerDefaultForAgents: on } : { composerAutocorrect: on })
  },
}))

/**
 * The viewed pane's effective input mode (E1-FR-22, FR-31): a one-shot opened
 * by the Paste key wins, then the saved choice, then the agents default.
 */
export function selectInputMode(s: RemoteState): InputMode {
  const paneId = s.activePaneId
  if (!paneId) return 'direct'
  if (s.composerOneShot === paneId) return 'composer'
  const pane = s.snapshot ? paneById(s.snapshot, paneId) : undefined
  return resolveInputMode(s.inputModes[paneId], pane?.type, s.composerDefaultForAgents)
}

/** Non-hook accessor for the client and imperative callers. */
export const store = useRemoteStore
