/**
 * The extras of a shared workspace on the guest (app 2.4.0, item 8, stage
 * S5; per guest rights from app 2.6.0): New console / Close console (relayed
 * ctl), the read-only Chat and Changes drawers, the Notes drawer (read, or
 * read and write) and the read-only Files drawer. Each shows with its cap.
 * Main validates every request (src/main/share/guest) and the host enforces
 * the caps again; this store only keeps what the drawers show. No
 * persistence, and nothing here ever reaches useAppStore.workspaces, the
 * config, the phone snapshot nor the CLI.
 *
 *  - Chat: per shared pane, the phone's list rules (chat/chatModel.ts) with
 *    a first page / "Load earlier" pending state and a 10 s "The host did not
 *    answer" timeout. Pages come on `share:chatEvent`.
 *  - New console: the ack's pane id goes into `pendingPanes` so the cell
 *    shows at once, before the host's next state lists it.
 *  - Notes: `notesChanged` bumps a per-link counter the Notes drawer reloads on.
 *  - Files: the tree lives in filesStore under `share:<linkId>`, read through
 *    the link; `filesChanged` (while the drawer is open) reloads its folders.
 */
import { create } from 'zustand'
import { chatNoticeOf, type ChatMessage, type ChatUnavailableReason } from '@shared/chat-types'
import type { RemoteGitChanges, RemoteGitDiffPage, RemoteGitReply } from '@shared/remote-protocol'
import type { GitDiffHunk, GitDiffRes } from '@shared/git-types'
import type { ShareChatEvt, ShareGuestRequestError, ShareLinkEvt, ShareLinkView } from '@shared/share-guest'
import type { FilesError } from '@shared/files'
import type { ShareCaps, ShareFilesReply, SharePaneInfo, SharePresetInfo, ShareState } from '@shared/share-protocol'
import { EMPTY_LIST, appendList, prependList, replaceList, type ChatList } from '@/components/share/chat/chatModel'
import { applyFilesChanged, dropFiles, type FilesIo, type FilesIoRead } from '@/lib/filesStore'

/** A chat request with no page back in this long shows "The host did not answer [Retry]". */
export const SHARE_CHAT_WAIT_MS = 10_000
/** An acked pane the host's state has not listed yet shows this long at most. */
export const SHARE_PENDING_PANE_MS = 15_000
/** Status pages read per refresh of the Changes drawer. */
export const SHARE_STATUS_MAX_PAGES = 4
/** A file that keeps changing restarts its diff read at most this many times. */
export const SHARE_DIFF_MAX_RESTARTS = 2

export type SharePanel = { kind: 'chat'; paneId: string } | { kind: 'notes' } | { kind: 'changes' } | { kind: 'files' }
export type ChatLoad = 'first' | 'more'

export interface SharedPaneChat {
  list: ChatList
  loading: ChatLoad | null
  failed: ChatLoad | null
  /** Bumped by every first page: the view jumps to the end. */
  version: number
  /** The host has no chat for this console. */
  notice: ChatUnavailableReason | null
}

export const EMPTY_CHAT: SharedPaneChat = { list: EMPTY_LIST, loading: null, failed: null, version: 0, notice: null }

interface ExtrasState {
  /** linkId -> the open drawer (one at a time per link). */
  panel: Record<string, SharePanel | null>
  /** The open drawer covers the whole grid. */
  panelMax: boolean
  /** `extrasKey(linkId, paneId)` -> chat. */
  chats: Record<string, SharedPaneChat>
  /** linkId -> panes a createPane ack named that no state listed yet. */
  pendingPanes: Record<string, SharePaneInfo[]>
  /** linkId -> bumped on every notesChanged (`rev`: the note's rev after it, v2). */
  notesSeq: Record<string, { n: number; noteId?: string; rev?: string }>
  /** linkId -> a ctl is waiting on the host. */
  ctlBusy: Record<string, boolean>

  openPanel: (linkId: string, panel: SharePanel | null) => void
  togglePanel: (linkId: string, panel: SharePanel) => void
  setPanelMax: (on: boolean) => void
}

export function extrasKey(linkId: string, paneId: string): string {
  return `${linkId}\u0000${paneId}`
}

function samePanel(a: SharePanel | null | undefined, b: SharePanel | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind !== 'chat' || (b.kind === 'chat' && a.paneId === b.paneId)
}

export const useShareExtrasStore = create<ExtrasState>((set, get) => ({
  panel: {},
  panelMax: false,
  chats: {},
  pendingPanes: {},
  notesSeq: {},
  ctlBusy: {},

  openPanel: (linkId, panel) => set((s) => ({ panel: { ...s.panel, [linkId]: panel } })),
  togglePanel: (linkId, panel) => get().openPanel(linkId, samePanel(get().panel[linkId], panel) ? null : panel),
  setPanelMax: (on) => set({ panelMax: on }),
}))

/** The panel kinds a session may open. */
export function panelAllowed(panel: SharePanel | null | undefined, caps: ShareCaps | undefined): boolean {
  if (!panel || !caps) return false
  if (panel.kind === 'chat') return caps.chat
  if (panel.kind === 'notes') return caps.notes
  if (panel.kind === 'files') return caps.files === true
  return caps.git
}

/** A shared pane with a transcript to read: an agent console or a shell running one. */
export function chatCapable(pane: SharePaneInfo, status: { provider?: string; hosted?: true } | null | undefined): boolean {
  return pane.type === 'claude' || pane.type === 'codex' || status?.hosted === true || status?.provider === 'claude' || status?.provider === 'codex'
}

/**
 * A key that changes on every new host session and on a resume from pause:
 * the drawers read again then (the host forgets a chat reader with its
 * session and drops chat frames while paused). null = not streaming.
 */
export function liveKeyOf(link: ShareLinkView): string | null {
  return link.status === 'connected' ? `c${link.lastConnectedAt ?? 0}` : null
}

// --- Chat ---------------------------------------------------------------------------

const chatTimers = new Map<string, ReturnType<typeof setTimeout>>()

function patchChat(key: string, next: Partial<SharedPaneChat>): void {
  useShareExtrasStore.setState((s) => ({ chats: { ...s.chats, [key]: { ...(s.chats[key] ?? EMPTY_CHAT), ...next } } }))
}

function armChatTimer(key: string, kind: ChatLoad): void {
  const prev = chatTimers.get(key)
  if (prev) clearTimeout(prev)
  chatTimers.set(
    key,
    setTimeout(() => {
      chatTimers.delete(key)
      const cur = useShareExtrasStore.getState().chats[key]
      if (cur?.loading === kind) patchChat(key, { loading: null, failed: kind })
    }, SHARE_CHAT_WAIT_MS),
  )
}

function clearChatTimer(key: string): void {
  const t = chatTimers.get(key)
  if (t) clearTimeout(t)
  chatTimers.delete(key)
}

/** chatSub: the first page (a repeat is a fresh first page on the host). */
export function chatFirst(linkId: string, paneId: string): void {
  const key = extrasKey(linkId, paneId)
  patchChat(key, { loading: 'first', failed: null, notice: null })
  armChatTimer(key, 'first')
  window.snApi.share.guest.chat({ linkId, op: 'sub', paneId })
}

/** "Load earlier": the page before the oldest message held. */
export function chatMore(linkId: string, paneId: string): void {
  const key = extrasKey(linkId, paneId)
  const cur = useShareExtrasStore.getState().chats[key]
  const cursor = cur?.list.cursor
  if (!cur || !cursor || cur.list.done || cur.list.capped || cur.loading) return
  patchChat(key, { loading: 'more', failed: null })
  armChatTimer(key, 'more')
  window.snApi.share.guest.chat({ linkId, op: 'more', paneId, before: cursor })
}

/** Stop reading (the drawer closed, another pane was picked, the link dropped). */
export function chatUnsub(linkId: string, paneId: string): void {
  clearChatTimer(extrasKey(linkId, paneId))
  window.snApi.share.guest.chat({ linkId, op: 'unsub', paneId })
}

export function chatForget(linkId: string, paneId: string): void {
  const key = extrasKey(linkId, paneId)
  clearChatTimer(key)
  useShareExtrasStore.setState((s) => {
    if (!s.chats[key]) return s
    const chats = { ...s.chats }
    delete chats[key]
    return { chats }
  })
}

export function applyChatEvent(evt: ShareChatEvt): void {
  const key = extrasKey(evt.linkId, evt.msg.paneId)
  const cur = useShareExtrasStore.getState().chats[key]
  // Nobody reads this pane any more: a late frame is dropped.
  if (!cur) return
  const msg = evt.msg
  const items: ChatMessage[] = Array.isArray(msg.items) ? msg.items : []
  if (msg.t === 'chatAppend') {
    if (!cur.notice) patchChat(key, { list: appendList(cur.list, items) })
    return
  }
  clearChatTimer(key)
  const notice = chatNoticeOf(items)
  if (notice) {
    patchChat(key, { list: EMPTY_LIST, loading: null, failed: null, notice })
    return
  }
  const page = { items, cursor: typeof msg.cursor === 'string' ? msg.cursor : null, done: msg.done === true }
  if (cur.loading === 'more') patchChat(key, { list: prependList(cur.list, page), loading: null, failed: null })
  else patchChat(key, { list: replaceList(page), loading: null, failed: null, notice: null, version: cur.version + 1 })
}

// --- New / Close console ---------------------------------------------------------------

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

function dropPending(linkId: string, paneId: string): void {
  useShareExtrasStore.setState((s) => {
    const list = s.pendingPanes[linkId]
    if (!list?.some((p) => p.id === paneId)) return s
    return { pendingPanes: { ...s.pendingPanes, [linkId]: list.filter((p) => p.id !== paneId) } }
  })
}

/** A createPane ack: the pane shows now (from the preset it was made from) until a state lists it. */
export function addPendingPane(linkId: string, paneId: string, preset: SharePresetInfo | undefined): void {
  const pane: SharePaneInfo = {
    id: paneId,
    title: preset?.name ?? '',
    type: preset?.type ?? 'shell',
    color: preset?.color ?? '',
    icon: preset?.icon ?? 'terminal',
    running: true,
  }
  useShareExtrasStore.setState((s) => {
    const list = (s.pendingPanes[linkId] ?? []).filter((p) => p.id !== paneId)
    return { pendingPanes: { ...s.pendingPanes, [linkId]: [...list, pane] } }
  })
  const k = extrasKey(linkId, paneId)
  const prev = pendingTimers.get(k)
  if (prev) clearTimeout(prev)
  pendingTimers.set(
    k,
    setTimeout(() => {
      pendingTimers.delete(k)
      dropPending(linkId, paneId)
    }, SHARE_PENDING_PANE_MS),
  )
}

/** The panes the grid shows: the state's, then the acked ones it does not list yet. */
export function withPendingPanes(panes: SharePaneInfo[], pending: SharePaneInfo[] | undefined): SharePaneInfo[] {
  if (!pending?.length) return panes
  const ids = new Set(panes.map((p) => p.id))
  const extra = pending.filter((p) => !ids.has(p.id))
  return extra.length ? [...panes, ...extra] : panes
}

export type ShareCtlOutcome = { ok: true; paneId?: string } | { ok: false; error: string }

async function runCtl(linkId: string, req: Parameters<typeof window.snApi.share.guest.ctl>[0]): Promise<ShareCtlOutcome> {
  if (useShareExtrasStore.getState().ctlBusy[linkId]) return { ok: false, error: 'busy' }
  useShareExtrasStore.setState((s) => ({ ctlBusy: { ...s.ctlBusy, [linkId]: true } }))
  try {
    const res = await window.snApi.share.guest.ctl(req)
    if (!res.ok) return { ok: false, error: res.error ?? 'failed' }
    return { ok: true, ...(res.paneId ? { paneId: res.paneId } : {}) }
  } catch {
    return { ok: false, error: 'failed' }
  } finally {
    useShareExtrasStore.setState((s) => ({ ctlBusy: { ...s.ctlBusy, [linkId]: false } }))
  }
}

/** New console from one of the host's presets (never a prompt, a cwd nor a resume). */
export async function createSharedPane(linkId: string, preset: SharePresetInfo): Promise<ShareCtlOutcome> {
  const res = await runCtl(linkId, { linkId, op: 'createPane', presetId: preset.id })
  if (res.ok && res.paneId) addPendingPane(linkId, res.paneId, preset)
  return res
}

export function closeSharedPane(linkId: string, paneId: string): Promise<ShareCtlOutcome> {
  dropPending(linkId, paneId)
  return runCtl(linkId, { linkId, op: 'closePane', paneId })
}

// --- Changes (pure helpers, like the phone's lib/changes.ts) ---------------------------------

export interface ShareStatusView {
  summary: RemoteGitChanges['summary']
  files: RemoteGitChanges['files']
  total: number
  truncated: boolean
  pages: number
  complete: boolean
}

/** Join one status page onto what was read (page 0 starts over). */
export function mergeStatus(prev: ShareStatusView | null, page: number, data: RemoteGitChanges, done: boolean): ShareStatusView {
  const files = page === 0 || !prev ? [...data.files] : [...prev.files, ...data.files]
  return { summary: data.summary, files, total: data.total, truncated: data.truncated, pages: page + 1, complete: done }
}

export interface ShareDiffLoad {
  head: Omit<RemoteGitDiffPage, 'hunks'> | null
  hunks: GitDiffHunk[]
  nextPage: number
  done: boolean
  restarts: number
}

export function emptyDiffLoad(restarts = 0): ShareDiffLoad {
  return { head: null, hunks: [], nextPage: 0, done: false, restarts }
}

/** Join a page's hunks onto the read ones: a `continued` piece goes on in the last hunk. */
export function appendHunks(hunks: readonly GitDiffHunk[], more: readonly GitDiffHunk[]): GitDiffHunk[] {
  const out = hunks.map((h) => ({ ...h, lines: h.lines }))
  for (const h of more) {
    const last = out[out.length - 1]
    if (h.continued && last && last.header === h.header) {
      out[out.length - 1] = { ...last, lines: [...last.lines, ...h.lines] }
    } else {
      const { continued: _c, ...rest } = h
      void _c
      out.push({ ...rest, lines: [...h.lines] })
    }
  }
  return out
}

/** Apply the answer to page `page`; another diffRev than page 0's restarts the read (at most twice). */
export function applyDiffPage(load: ShareDiffLoad, page: number, data: RemoteGitDiffPage, done: boolean): { load: ShareDiffLoad; restart: boolean; unstable: boolean } {
  const { hunks, ...head } = data
  if (page === 0 || !load.head) {
    return { load: { head, hunks: appendHunks([], hunks), nextPage: page + 1, done, restarts: load.restarts }, restart: false, unstable: false }
  }
  if (head.diffRev !== load.head.diffRev) {
    if (load.restarts >= SHARE_DIFF_MAX_RESTARTS) return { load: { ...load, done: true }, restart: false, unstable: true }
    return { load: emptyDiffLoad(load.restarts + 1), restart: true, unstable: false }
  }
  return { load: { ...load, hunks: appendHunks(load.hunks, hunks), nextPage: page + 1, done }, restart: false, unstable: false }
}

/** The read pages in the shape the desktop DiffView draws. */
export function diffResOf(load: ShareDiffLoad): GitDiffRes | null {
  const h = load.head
  if (!h) return null
  let totalLines = 0
  for (const hunk of load.hunks) totalLines += hunk.lines.length
  return {
    path: h.path,
    ...(h.oldPath !== undefined ? { oldPath: h.oldPath } : {}),
    area: h.area,
    binary: h.binary,
    diffRev: h.diffRev,
    hunks: load.hunks,
    totalLines,
  }
}

/**
 * How one git answer ended for the drawer: data, "The host did not answer"
 * (offline, timeout, busy or main's rate limit), or a git error code.
 */
export type ShareGitOutcome<T> = { kind: 'data'; data: T; page: number; done: boolean } | { kind: 'noReply' } | { kind: 'error'; error: string }

export function gitOutcome<T extends RemoteGitChanges | RemoteGitDiffPage>(res: { ok: boolean; reply?: RemoteGitReply; error?: ShareGuestRequestError }): ShareGitOutcome<T> {
  if (!res.ok || !res.reply) return res.error === 'denied' || res.error === 'invalid' ? { kind: 'error', error: 'not_found' } : { kind: 'noReply' }
  const reply = res.reply
  if (!reply.ok || 'error' in reply.data) {
    const error = 'error' in reply.data ? String(reply.data.error) : 'git_error'
    return error === 'rate' || error === 'timeout' ? { kind: 'noReply' } : { kind: 'error', error }
  }
  return { kind: 'data', data: reply.data as T, page: reply.page, done: reply.done }
}

// --- Files (read-only, through the link) ---------------------------------------------------

/** The filesStore key of a link's tree (a workspace id never has a colon). */
export function shareFilesKey(linkId: string): string {
  return `share:${linkId}`
}

/** A request that did not reach the host, or the host's rate limit, as the drawer's error. */
function filesRequestError(error: ShareGuestRequestError | undefined): FilesError {
  if (error === 'denied') return 'not_found'
  if (error === 'invalid' || error === 'too_large') return error
  return 'io'
}

function filesReplyError(reply: ShareFilesReply): FilesError {
  return !reply.error || reply.error === 'rate' ? 'io' : reply.error
}

/** The tree's I/O of a link: list and read through main and the host, never a write. */
export function shareFilesIo(linkId: string): FilesIo {
  const api = window.snApi.share.guest
  return {
    list: async (rel) => {
      const res = await api.files({ linkId, op: 'list', rel }).catch(() => null)
      if (!res?.ok || !res.reply) return { ok: false, error: filesRequestError(res?.error ?? 'offline') }
      const r = res.reply
      return r.ok ? { ok: true, entries: r.entries ?? [], truncated: r.truncated === true } : { ok: false, error: filesReplyError(r) }
    },
    read: async (rel): Promise<FilesIoRead> => {
      const res = await api.files({ linkId, op: 'read', rel }).catch(() => null)
      if (!res?.ok || !res.reply) return { ok: false, error: filesRequestError(res?.error ?? 'offline') }
      const r = res.reply
      const f = r.file
      if (!r.ok || !f) return { ok: false, error: filesReplyError(r) }
      if (f.kind === 'image') return { ok: true, kind: 'image', dataUrl: f.dataUrl, size: f.size, rev: f.rev }
      return { ok: true, kind: 'text', text: f.text, eol: f.eol, bom: f.bom, rev: f.rev, size: f.size, readOnly: true, ...(f.partial ? { partial: true } : {}) }
    },
  }
}

// --- Main's events ---------------------------------------------------------------------

function onState(linkId: string, state: ShareState): void {
  const s = useShareExtrasStore.getState()
  const pending = s.pendingPanes[linkId]
  if (pending?.length) {
    const ids = new Set(state.panes.map((p) => p.id))
    for (const p of pending) if (ids.has(p.id)) dropPending(linkId, p.id)
  }
  // A cap taken away (perm changed) closes its drawer, and so does the chat of a console that closed.
  const panel = s.panel[linkId]
  const paneGone = panel?.kind === 'chat' && !state.panes.some((p) => p.id === panel.paneId) && !pending?.some((p) => p.id === panel.paneId)
  if (panel && (!panelAllowed(panel, state.caps) || paneGone)) s.openPanel(linkId, null)
}

function forgetLink(linkId: string): void {
  const prefix = `${linkId}\u0000`
  for (const k of [...chatTimers.keys()]) if (k.startsWith(prefix)) clearChatTimer(k)
  useShareExtrasStore.setState((s) => {
    const chats: Record<string, SharedPaneChat> = {}
    for (const [k, v] of Object.entries(s.chats)) if (!k.startsWith(prefix)) chats[k] = v
    const without = <T>(rec: Record<string, T>): Record<string, T> => {
      if (!(linkId in rec)) return rec
      const next = { ...rec }
      delete next[linkId]
      return next
    }
    return { chats, panel: without(s.panel), pendingPanes: without(s.pendingPanes), notesSeq: without(s.notesSeq), ctlBusy: without(s.ctlBusy) }
  })
  dropFiles(shareFilesKey(linkId))
}

export function applyExtrasLinkEvent(evt: ShareLinkEvt): void {
  switch (evt.t) {
    case 'state':
      return onState(evt.linkId, evt.state)
    case 'notesChanged':
      useShareExtrasStore.setState((s) => ({
        notesSeq: { ...s.notesSeq, [evt.linkId]: { n: (s.notesSeq[evt.linkId]?.n ?? 0) + 1, ...(evt.noteId ? { noteId: evt.noteId } : {}), ...(evt.rev ? { rev: evt.rev } : {}) } },
      }))
      return
    case 'filesChanged':
      void applyFilesChanged({ workspaceId: shareFilesKey(evt.linkId), dirs: evt.dirs, ...(evt.all ? { all: true } : {}) })
      return
    case 'removed':
      return forgetLink(evt.linkId)
    default:
      return
  }
}

/** Wire main's chat pages and the extras' link events (called by initShareGuest). */
export function initShareGuestExtras(): () => void {
  const api = window.snApi?.share?.guest
  if (!api) return () => undefined
  const offChat = api.onChatEvent(applyChatEvent)
  const offLink = api.onLinkEvent(applyExtrasLinkEvent)
  return () => {
    offChat()
    offLink()
  }
}
