/**
 * "Shared with me" (app 2.4.0, item 8, stage S3): the guest renderer's view
 * of the shares this PC joined. Main owns every socket, key and state
 * (src/main/share/guest); this store only mirrors `snApi.share.guest`.
 *
 * - No persistence. Shared workspaces NEVER go into useAppStore.workspaces,
 *   so they never reach config.json, the phone snapshot nor the CLI.
 * - Terminal bytes (replay/out/fit/exit) never pass through zustand: they go
 *   straight to the mounted RemoteTerminalPane (`registerShareTerm`).
 * - The overlay guard (`initShareGuest`) is the ONE place that leaves the
 *   shared view: a local workspace switch, any request to focus a local
 *   console (reveal, Ctrl+digit, sidebar row, palette) or a local xterm
 *   taking DOM focus clears `activeLinkId`.
 */
import { create } from 'zustand'
import type { PaneStatus } from '@shared/types'
import type { ShareLinkEvt, ShareLinkView, ShareLinksRes, ShareStreamEvt, ShareStreamItem } from '@shared/share-guest'
import type { ShareAgentStatus, ShareDenyReason, SharePaneInfo, SharePerm, ShareState } from '@shared/share-protocol'
import { useAppStore } from './store'
import { onPaneFocusRequest } from './focus'
import { initShareGuestExtras } from './shareGuestExtras'

export type ShareLockHolder = 'host' | 'you' | 'other' | null
export type ShareNoticeReason = ShareDenyReason | 'offline'

export interface ShareNotice {
  reason: ShareNoticeReason
  at: number
  /** Bumps on every notice, so the same reason twice restarts the banner timer. */
  n: number
}

interface ShareGuestState {
  ready: boolean
  persisted: boolean
  guestFingerprint: string | null
  /** Link ids in main's order. */
  order: string[]
  links: Record<string, ShareLinkView>
  states: Record<string, ShareState>
  /** linkId -> paneId -> live agent status (null = none). */
  statuses: Record<string, Record<string, ShareAgentStatus | null>>
  /** linkId -> paneId -> who holds the input lease. */
  locks: Record<string, Record<string, ShareLockHolder>>
  /** `paneKey(linkId, paneId)` -> the last refused write. */
  notices: Record<string, ShareNotice>
  /** The shared workspace shown over the local grid; null = the local grid. */
  activeLinkId: string | null
  /** linkId -> the locally maximized shared pane. */
  maximized: Record<string, string | null>
  join: { open: boolean; linkId?: string }
  /** The URL waiting in ConfirmLinkDialog (from a shared console). */
  linkPrompt: { url: string; host: string } | null
  /** A shared pane asked to take the keyboard (the view's first pane, a sidebar row). */
  focusReq: { linkId: string; paneId: string; n: number } | null

  activate: (linkId: string, paneId?: string) => void
  leave: () => void
  openJoin: (linkId?: string) => void
  closeJoin: () => void
  confirmLink: (url: string, host: string) => void
  closeLinkPrompt: () => void
  toggleMaximize: (linkId: string, paneId: string) => void
  requestFocus: (linkId: string, paneId: string) => void
  notice: (linkId: string, paneId: string, reason: ShareNoticeReason) => void
}

export function paneKey(linkId: string, paneId: string): string {
  return `${linkId}\u0000${paneId}`
}

let noticeSeq = 0
let focusSeq = 0

/** Drop the DOM focus a local console may still hold, so no key lands in it unseen. */
function blurLocalTerminal(): void {
  if (typeof document === 'undefined') return
  const a = document.activeElement
  if (a instanceof HTMLElement && a.closest('.xterm') && !a.closest('[data-shared-workspace]')) a.blur()
}

export const useShareGuestStore = create<ShareGuestState>((set, get) => ({
  ready: false,
  persisted: true,
  guestFingerprint: null,
  order: [],
  links: {},
  states: {},
  statuses: {},
  locks: {},
  notices: {},
  activeLinkId: null,
  maximized: {},
  join: { open: false },
  linkPrompt: null,
  focusReq: null,

  activate: (linkId, paneId) => {
    if (!get().links[linkId]) return
    blurLocalTerminal()
    set({ activeLinkId: linkId })
    const target = paneId ?? firstPaneOf(get(), linkId)
    if (target) get().requestFocus(linkId, target)
  },
  leave: () => {
    if (get().activeLinkId !== null) set({ activeLinkId: null })
  },
  openJoin: (linkId) => set({ join: { open: true, ...(linkId ? { linkId } : {}) } }),
  closeJoin: () => set({ join: { open: false } }),
  confirmLink: (url, host) => set({ linkPrompt: { url, host } }),
  closeLinkPrompt: () => set({ linkPrompt: null }),
  toggleMaximize: (linkId, paneId) =>
    set((s) => ({ maximized: { ...s.maximized, [linkId]: s.maximized[linkId] === paneId ? null : paneId } })),
  requestFocus: (linkId, paneId) => set({ focusReq: { linkId, paneId, n: ++focusSeq } }),
  notice: (linkId, paneId, reason) =>
    set((s) => ({ notices: { ...s.notices, [paneKey(linkId, paneId)]: { reason, at: Date.now(), n: ++noticeSeq } } })),
}))

/** The pane a freshly opened view focuses: the maximized one, else the first in layout order. */
function firstPaneOf(s: ShareGuestState, linkId: string): string | null {
  const st = s.states[linkId]
  if (!st) return null
  const max = s.maximized[linkId]
  if (max && st.panes.some((p) => p.id === max)) return max
  return orderedPanes(st)[0]?.id ?? null
}

/** Panes in the host's layout order (unknown ones appended), like gridTemplates' orderPanes. */
export function orderedPanes(state: ShareState): SharePaneInfo[] {
  const index = new Map(state.layoutOrder.map((id, i) => [id, i]))
  const rank = (id: string): number => index.get(id) ?? Number.MAX_SAFE_INTEGER
  return [...state.panes].sort((a, b) => rank(a.id) - rank(b.id))
}

/** The permission in force: a live `permChanged` updates the link before any new state. */
export function effectivePerm(link: ShareLinkView | undefined, state: ShareState | undefined): SharePerm {
  return link?.perm ?? state?.perm ?? link?.permHint ?? 'view'
}

/** A shared pane's status in the shape StatusDot draws. */
export function toPaneStatus(s: ShareAgentStatus | null | undefined): PaneStatus | undefined {
  if (!s) return undefined
  return {
    state: s.state,
    precise: s.precise !== false,
    ...(s.provider ? { provider: s.provider } : {}),
    stateSince: s.stateSince,
    ...(s.activity ? { activity: s.activity } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
  }
}

/** A pane's live status: the stream's last word (null = cleared), else what its state carried. */
export function paneStatusOf(
  statuses: Record<string, Record<string, ShareAgentStatus | null>>,
  linkId: string,
  pane: SharePaneInfo,
): ShareAgentStatus | null {
  const live = statuses[linkId]
  return live && pane.id in live ? live[pane.id] : (pane.status ?? null)
}

/** True while the link streams (connected or paused by the host). */
export function linkLive(link: ShareLinkView | undefined): boolean {
  return link?.status === 'connected' || link?.status === 'paused'
}

// --- Terminal sinks (bytes never pass through zustand) ---

export type ShareTermItem = Extract<ShareStreamItem, { t: 'replay' | 'out' | 'fit' | 'exit' }>
const sinks = new Map<string, (item: ShareTermItem) => void>()

/** A mounted shared terminal receives its pane's replay/out/fit/exit. */
export function registerShareTerm(linkId: string, paneId: string, sink: (item: ShareTermItem) => void): () => void {
  const key = paneKey(linkId, paneId)
  sinks.set(key, sink)
  return () => {
    if (sinks.get(key) === sink) sinks.delete(key)
  }
}

// --- Applying main's events ---

function statusesOf(state: ShareState): Record<string, ShareAgentStatus | null> {
  const out: Record<string, ShareAgentStatus | null> = {}
  for (const p of state.panes) out[p.id] = p.status ?? null
  return out
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

/** Patch one pane of a link's state (running / exit code from the stream). */
function patchPane(linkId: string, paneId: string, patch: Partial<SharePaneInfo>): void {
  useShareGuestStore.setState((s) => {
    const st = s.states[linkId]
    if (!st || !st.panes.some((p) => p.id === paneId)) return s
    const panes = st.panes.map((p) => {
      if (p.id !== paneId) return p
      const next = { ...p, ...patch }
      if (patch.running) delete next.exitCode
      return next
    })
    return { states: { ...s.states, [linkId]: { ...st, panes } } }
  })
}

export function applyLinks(res: ShareLinksRes): void {
  useShareGuestStore.setState((s) => {
    const links: Record<string, ShareLinkView> = {}
    for (const l of res.links) links[l.id] = l
    const states: Record<string, ShareState> = {}
    const statuses: Record<string, Record<string, ShareAgentStatus | null>> = {}
    for (const [id, st] of Object.entries(res.states ?? {})) {
      if (!links[id]) continue
      states[id] = st
      statuses[id] = statusesOf(st)
    }
    // A state that arrived on the event stream before this reply wins.
    for (const [id, st] of Object.entries(s.states)) {
      if (!links[id]) continue
      states[id] = st
      statuses[id] = s.statuses[id] ?? statusesOf(st)
    }
    const activeLinkId = s.activeLinkId && links[s.activeLinkId] ? s.activeLinkId : null
    return {
      ready: true,
      persisted: res.persisted,
      guestFingerprint: res.guestFingerprint,
      order: res.links.map((l) => l.id),
      links: { ...links, ...pick(s.links, links) },
      states,
      statuses,
      activeLinkId,
    }
  })
}

/** Link views that arrived by event while links() was in flight are newer than its reply. */
function pick(cur: Record<string, ShareLinkView>, known: Record<string, ShareLinkView>): Record<string, ShareLinkView> {
  const out: Record<string, ShareLinkView> = {}
  for (const id of Object.keys(cur)) if (known[id]) out[id] = cur[id]
  return out
}

export function applyLinkEvent(evt: ShareLinkEvt): void {
  const store = useShareGuestStore
  switch (evt.t) {
    case 'link': {
      const link = evt.link
      store.setState((s) => {
        const order = s.order.includes(link.id) ? s.order : [...s.order, link.id]
        const live = linkLive(link)
        return {
          order,
          links: { ...s.links, [link.id]: link },
          // Leases mean nothing once the socket is gone.
          ...(live ? {} : { locks: withoutKey(s.locks, link.id) }),
        }
      })
      return
    }
    case 'state':
      store.setState((s) => ({
        states: { ...s.states, [evt.linkId]: evt.state },
        statuses: { ...s.statuses, [evt.linkId]: statusesOf(evt.state) },
      }))
      return
    case 'removed':
      store.setState((s) => {
        const prefix = `${evt.linkId}\u0000`
        const notices: Record<string, ShareNotice> = {}
        for (const [k, v] of Object.entries(s.notices)) if (!k.startsWith(prefix)) notices[k] = v
        return {
          order: s.order.filter((id) => id !== evt.linkId),
          links: withoutKey(s.links, evt.linkId),
          states: withoutKey(s.states, evt.linkId),
          statuses: withoutKey(s.statuses, evt.linkId),
          locks: withoutKey(s.locks, evt.linkId),
          maximized: withoutKey(s.maximized, evt.linkId),
          notices,
          activeLinkId: s.activeLinkId === evt.linkId ? null : s.activeLinkId,
          join: s.join.linkId === evt.linkId ? { open: false } : s.join,
        }
      })
      return
    default:
      // notesChanged belongs to S5's Notes drawer (shareGuestExtras); err is not shown.
      return
  }
}

export function applyStream(evt: ShareStreamEvt): void {
  const { linkId } = evt
  for (const item of evt.items) {
    switch (item.t) {
      case 'replay':
        if (item.first) patchPane(linkId, item.paneId, item.running ? { running: true } : { running: false, ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}) })
        sinks.get(paneKey(linkId, item.paneId))?.(item)
        break
      case 'exit':
        patchPane(linkId, item.paneId, { running: false, ...(item.code !== null ? { exitCode: item.code } : {}) })
        sinks.get(paneKey(linkId, item.paneId))?.(item)
        break
      case 'out':
      case 'fit':
        sinks.get(paneKey(linkId, item.paneId))?.(item)
        break
      case 'paneStatus':
        useShareGuestStore.setState((s) => ({
          statuses: { ...s.statuses, [linkId]: { ...(s.statuses[linkId] ?? {}), [item.paneId]: item.status } },
        }))
        break
      case 'inputLock':
        useShareGuestStore.setState((s) => ({
          locks: { ...s.locks, [linkId]: { ...(s.locks[linkId] ?? {}), [item.paneId]: item.holder } },
        }))
        break
      case 'inputDenied':
      case 'inputRefused':
        useShareGuestStore.getState().notice(linkId, item.paneId, item.reason)
        break
    }
  }
}

/**
 * The single place that leaves the shared view (overlay guard): a local
 * workspace switch, a request to focus a local console, or a local xterm
 * taking the DOM focus. Returns its teardown.
 */
function initOverlayGuard(): () => void {
  const leave = (): void => useShareGuestStore.getState().leave()
  const offApp = useAppStore.subscribe((s, prev) => {
    if (s.activeWorkspaceId !== prev.activeWorkspaceId) leave()
  })
  const offFocus = onPaneFocusRequest(leave)
  const onFocusIn = (e: FocusEvent): void => {
    if (useShareGuestStore.getState().activeLinkId === null) return
    const el = e.target
    if (el instanceof HTMLElement && el.classList.contains('xterm-helper-textarea') && !el.closest('[data-shared-workspace]')) leave()
  }
  document.addEventListener('focusin', onFocusIn, true)
  return () => {
    offApp()
    offFocus()
    document.removeEventListener('focusin', onFocusIn, true)
  }
}

/** Wire main's guest streams and the overlay guard for the app's lifetime. */
export function initShareGuest(): () => void {
  const api = window.snApi?.share?.guest
  if (!api) return () => undefined
  const offLink = api.onLinkEvent(applyLinkEvent)
  const offStream = api.onStream(applyStream)
  const offGuard = initOverlayGuard()
  // S5: chat pages, notesChanged and the pending New console panes.
  const offExtras = initShareGuestExtras()
  let alive = true
  void api
    .links()
    .then((res) => {
      if (alive) applyLinks(res)
    })
    .catch(() => {
      if (alive) useShareGuestStore.setState({ ready: true })
    })
  return () => {
    alive = false
    offLink()
    offStream()
    offGuard()
    offExtras()
  }
}

/** True while the shared view covers the local grid (useGlobalKeys, WorkspaceHost). */
export function sharedOverlayActive(): boolean {
  const s = useShareGuestStore.getState()
  return s.activeLinkId !== null && !!s.links[s.activeLinkId]
}
