/**
 * State of the Files drawer (v2.2, E9), per workspace: the folders loaded in
 * the tree, which ones are expanded, and the open tabs with their buffers.
 * It lives outside the drawer, so closing it keeps unsaved edits; when the
 * window unloads (quit, reload) unsaved buffers are stashed in localStorage
 * (`snagentsos.files.unsaved`, at most 2 MB) and come back as unsaved tabs the
 * next time that workspace's drawer opens, like an editor's hot exit.
 *
 * Disk is main's: every read and write goes through window.snApi.files with
 * a workspace id and a relative path. A save carries the rev it loaded; an
 * agent editing the same file in between makes it a conflict, never a
 * silent overwrite.
 *
 * A share guest's read-only Files drawer (app 2.6.0) keeps its tree here too,
 * under the key `share:<linkId>` (a workspace id never has a colon): its I/O
 * goes through the link (setFilesIo), it has no write, and it is never
 * stashed.
 *
 * A worktree console has its own tree (app 2.7.0, A9) under `wsId#paneId`
 * (ids never have a `#`): every call names the pane too, and main roots it at
 * the pane's worktree. The drawer of a workspace shows one tree at a time
 * (`shown`), the workspace's own unless a Ctrl+click on a terminal path of a
 * worktree console switched it.
 */
import { create } from 'zustand'
import { joinRel, parentRel, type FileEntry, type FileReadRes, type FileWriteReq, type FileWriteRes, type FilesChangedEvt, type FilesError, type FilesListRes } from '@shared/files'

export interface FileTab {
  rel: string
  kind: 'text' | 'image'
  /** Bumped on every (re)load: the editor builds a new document. */
  seq: number
  /** The text the editor was loaded with at `seq`. */
  initial: string
  /** The current text (what the editor shows; an editor mounted again starts from it). */
  text: string
  /** The text on disk as last read or written: dirty = text !== saved. */
  saved: string
  rev: string
  eol: 'lf' | 'crlf'
  bom: boolean
  readOnly: boolean
  size: number
  dataUrl?: string
  /** The file changed or vanished on disk while this tab had edits; or a save hit a conflict. */
  external?: 'changed' | 'deleted' | 'conflict'
  /** Restored from the stash of a previous run (unsaved). */
  restored?: boolean
  /** Only the start of the file came (a share guest's read of a long one). */
  partial?: boolean
  /** Put the cursor here once the editor shows (1-based); `seq` grows on every ask. */
  reveal?: { line: number; col: number; seq: number }
}

export interface DirState {
  entries: FileEntry[]
  truncated: boolean
  error?: FilesError
}

interface WsFiles {
  tabs: FileTab[]
  active: string | null
  expanded: string[]
  dirs: Record<string, DirState>
}

interface FilesState {
  byWs: Record<string, WsFiles>
  /** Drawer workspace id -> the tree it shows when not its own (a `wsId#paneId` key). */
  shown: Record<string, string>
}

export const useFilesStore = create<FilesState>(() => ({ byWs: {}, shown: {} }))

/** The key of a worktree console's own tree. */
export function paneFilesKey(wsId: string, paneId: string): string {
  return `${wsId}#${paneId}`
}

/** What a key names to main: the workspace, plus the console of a `wsId#paneId` tree. */
export function filesIds(key: string): { workspaceId: string; paneId?: string } {
  const i = key.indexOf('#')
  return i < 0 ? { workspaceId: key } : { workspaceId: key.slice(0, i), paneId: key.slice(i + 1) }
}

/** The tree the drawer of workspace `drawerWsId` shows. */
export function shownFilesKey(state: FilesState, drawerWsId: string): string {
  return state.shown[drawerWsId] ?? drawerWsId
}

/** Switch the drawer of `drawerWsId` to the tree `key` (its own workspace id: back to it). */
export function showFilesTree(drawerWsId: string, key: string): void {
  useFilesStore.setState((s) => {
    if (shownFilesKey(s, drawerWsId) === key) return s
    const shown = { ...s.shown }
    if (key === drawerWsId) delete shown[drawerWsId]
    else shown[drawerWsId] = key
    return { shown }
  })
}

/** A read as a tree's I/O answers it; `partial`: only the start of the file came. */
export type FilesIoRead = FileReadRes & { partial?: boolean }

/** Where a tree reads (and writes): the workspace's folder through main, or a share link. */
export interface FilesIo {
  list(rel: string): Promise<FilesListRes>
  read(rel: string): Promise<FilesIoRead>
  /** Absent: a read-only tree. */
  write?(req: Omit<FileWriteReq, 'workspaceId'>): Promise<FileWriteRes>
}

const ios = new Map<string, FilesIo>()

function localIo(key: string): FilesIo {
  const ids = filesIds(key)
  return {
    list: (rel) => window.snApi.files.list({ ...ids, rel }),
    read: (rel) => window.snApi.files.read({ ...ids, rel }),
    write: (req) => window.snApi.files.write({ ...ids, ...req }),
  }
}

function ioOf(key: string): FilesIo {
  return ios.get(key) ?? localIo(key)
}

/** A tree apart from the workspaces (a share link): its reads go through `io`. */
export function setFilesIo(key: string, io: FilesIo): void {
  ios.set(key, io)
}

/** Forget a tree and its I/O (a share link removed). */
export function dropFiles(key: string): void {
  ios.delete(key)
  useFilesStore.setState((s) => {
    if (!(key in s.byWs)) return s
    const byWs = { ...s.byWs }
    delete byWs[key]
    return { byWs }
  })
}

const EMPTY: WsFiles = { tabs: [], active: null, expanded: [''], dirs: {} }
let tabSeq = 0

export function wsFiles(state: FilesState, wsId: string): WsFiles {
  return state.byWs[wsId] ?? EMPTY
}

function patch(wsId: string, fn: (ws: WsFiles) => Partial<WsFiles>): void {
  useFilesStore.setState((s) => {
    const cur = s.byWs[wsId] ?? EMPTY
    return { byWs: { ...s.byWs, [wsId]: { ...cur, ...fn(cur) } } }
  })
}

function patchTab(wsId: string, rel: string, fn: (tab: FileTab) => Partial<FileTab>): void {
  patch(wsId, (ws) => ({ tabs: ws.tabs.map((t) => (t.rel === rel ? { ...t, ...fn(t) } : t)) }))
}

export function isDirty(tab: FileTab): boolean {
  return tab.kind === 'text' && tab.text !== tab.saved
}

// --- Tree ----------------------------------------------------------------------------

export async function loadDir(wsId: string, rel: string): Promise<void> {
  const res = await ioOf(wsId).list(rel).catch(() => null)
  const dir: DirState = res?.ok ? { entries: res.entries, truncated: res.truncated } : { entries: [], truncated: false, error: res && !res.ok ? res.error : 'io' }
  patch(wsId, (ws) => ({ dirs: { ...ws.dirs, [rel]: dir } }))
}

export function toggleDir(wsId: string, rel: string): void {
  const ws = wsFiles(useFilesStore.getState(), wsId)
  const open = ws.expanded.includes(rel)
  patch(wsId, (w) => ({ expanded: open ? w.expanded.filter((d) => d !== rel && !d.startsWith(`${rel}/`)) : [...w.expanded, rel] }))
  if (!open && !ws.dirs[rel]) void loadDir(wsId, rel)
}

export function collapseAll(wsId: string): void {
  patch(wsId, () => ({ expanded: [''] }))
}

/** Reloads every folder shown (the refresh button, a burst of changes). */
export async function reloadTree(wsId: string): Promise<void> {
  const ws = wsFiles(useFilesStore.getState(), wsId)
  await Promise.all(ws.expanded.map((rel) => loadDir(wsId, rel)))
}

// --- Tabs ----------------------------------------------------------------------------

let revealSeq = 0

/**
 * Opens (or activates) a tab. `at` (app 2.7.0, A9) also puts the cursor on
 * that 1-based line and column once the editor shows, open tab or new.
 */
export async function openFile(wsId: string, rel: string, at?: { line?: number | null; col?: number | null }): Promise<FilesError | null> {
  const reveal = at?.line ? { line: at.line, col: at.col || 1, seq: ++revealSeq } : undefined
  const ws = wsFiles(useFilesStore.getState(), wsId)
  if (ws.tabs.some((t) => t.rel === rel)) {
    patch(wsId, (w) => ({ active: rel, ...(reveal ? { tabs: w.tabs.map((t) => (t.rel === rel && t.kind === 'text' ? { ...t, reveal } : t)) } : {}) }))
    return null
  }
  const io = ioOf(wsId)
  const res = await io.read(rel).catch(() => null)
  if (!res) return 'io'
  if (!res.ok) return res.error
  const tab: FileTab =
    res.kind === 'image'
      ? { rel, kind: 'image', seq: ++tabSeq, initial: '', text: '', saved: '', rev: res.rev, eol: 'lf', bom: false, readOnly: true, size: res.size, dataUrl: res.dataUrl }
      : { rel, kind: 'text', seq: ++tabSeq, initial: res.text, text: res.text, saved: res.text, rev: res.rev, eol: res.eol, bom: res.bom, readOnly: res.readOnly || !io.write, size: res.size, ...(res.partial ? { partial: true } : {}), ...(reveal ? { reveal } : {}) }
  patch(wsId, (w) =>
    w.tabs.some((t) => t.rel === rel)
      ? { active: rel, ...(reveal ? { tabs: w.tabs.map((t) => (t.rel === rel && t.kind === 'text' ? { ...t, reveal } : t)) } : {}) }
      : { tabs: [...w.tabs, tab], active: rel },
  )
  return null
}

/** The editor applied the tab's reveal `seq` (a newer ask stays). */
export function clearReveal(wsId: string, rel: string, seq: number): void {
  const tab = wsFiles(useFilesStore.getState(), wsId).tabs.find((t) => t.rel === rel)
  if (tab?.reveal?.seq === seq) patchTab(wsId, rel, () => ({ reveal: undefined }))
}

export function setActiveTab(wsId: string, rel: string): void {
  patch(wsId, () => ({ active: rel }))
}

export function closeTab(wsId: string, rel: string): void {
  patch(wsId, (ws) => {
    const i = ws.tabs.findIndex((t) => t.rel === rel)
    const tabs = ws.tabs.filter((t) => t.rel !== rel)
    const active = ws.active === rel ? (tabs[Math.min(i, tabs.length - 1)]?.rel ?? null) : ws.active
    return { tabs, active }
  })
}

export function setTabText(wsId: string, rel: string, text: string): void {
  patchTab(wsId, rel, () => ({ text }))
}

/** Reads the file again into the tab, dropping its edits. */
export async function reloadTab(wsId: string, rel: string): Promise<void> {
  const io = ioOf(wsId)
  const res = await io.read(rel).catch(() => null)
  if (!res?.ok) {
    if (res && !res.ok && res.error === 'not_found') patchTab(wsId, rel, () => ({ external: 'deleted' }))
    return
  }
  if (res.kind === 'image') patchTab(wsId, rel, () => ({ seq: ++tabSeq, dataUrl: res.dataUrl, rev: res.rev, size: res.size, external: undefined }))
  else patchTab(wsId, rel, () => ({ seq: ++tabSeq, initial: res.text, text: res.text, saved: res.text, rev: res.rev, eol: res.eol, bom: res.bom, readOnly: res.readOnly || !io.write, size: res.size, partial: res.partial || undefined, external: undefined, restored: undefined }))
}

/** Writes the tab. `force` overwrites a newer file on disk (Keep mine). */
export async function saveTab(wsId: string, rel: string, force = false): Promise<FilesError | null> {
  const tab = wsFiles(useFilesStore.getState(), wsId).tabs.find((t) => t.rel === rel)
  const io = ioOf(wsId)
  if (!tab || tab.kind !== 'text' || tab.readOnly || !io.write) return null
  const text = tab.text
  const res = await io.write({ rel, text, eol: tab.eol, bom: tab.bom, ...(force || tab.restored ? {} : { baseRev: tab.rev }) }).catch(() => null)
  if (!res) return 'io'
  if (!res.ok) {
    if (res.error === 'conflict') patchTab(wsId, rel, () => ({ external: 'conflict' }))
    return res.error
  }
  patchTab(wsId, rel, () => ({ saved: text, rev: res.rev, size: res.size, external: undefined, restored: undefined }))
  return null
}

export function renameTabs(wsId: string, from: string, to: string): void {
  patch(wsId, (ws) => ({
    tabs: ws.tabs.map((t) => (t.rel === from || t.rel.startsWith(`${from}/`) ? { ...t, rel: to + t.rel.slice(from.length) } : t)),
    active: ws.active && (ws.active === from || ws.active.startsWith(`${from}/`)) ? to + ws.active.slice(from.length) : ws.active,
  }))
}

// --- Changes on disk -----------------------------------------------------------------------

/** The tree a change event is for: the workspace's, or the pane's its watch named. */
export function changedKey(evt: FilesChangedEvt): string {
  return evt.paneId ? paneFilesKey(evt.workspaceId, evt.paneId) : evt.workspaceId
}

/** A burst of changes in the watched folder: reload the folders shown and check the open tabs there. */
export async function applyFilesChanged(evt: FilesChangedEvt): Promise<void> {
  const key = changedKey(evt)
  const ws = wsFiles(useFilesStore.getState(), key)
  const touched = (rel: string): boolean => evt.all === true || evt.dirs.includes(rel)
  await Promise.all(ws.expanded.filter((d) => touched(d) && ws.dirs[d]).map((d) => loadDir(key, d)))
  for (const tab of ws.tabs) {
    if (!touched(parentRel(tab.rel))) continue
    const res = await ioOf(key).read(tab.rel).catch(() => null)
    const cur = wsFiles(useFilesStore.getState(), key).tabs.find((t) => t.rel === tab.rel)
    if (!cur || !res) continue
    if (!res.ok) {
      if (res.error === 'not_found') patchTab(key, tab.rel, () => ({ external: 'deleted' }))
      continue
    }
    if (res.rev === cur.rev) continue
    if (isDirty(cur)) patchTab(key, tab.rel, () => ({ external: 'changed' }))
    else await reloadTab(key, tab.rel)
  }
}

// --- Hot exit -------------------------------------------------------------------------------

const STASH_KEY = 'snagentsos.files.unsaved'
const STASH_MAX = 2 * 1024 * 1024

interface Stashed {
  wsId: string
  rel: string
  text: string
  eol: 'lf' | 'crlf'
  bom: boolean
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readStash(): Stashed[] {
  try {
    const raw = storage()?.getItem(STASH_KEY)
    const all: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(all) ? (all as Stashed[]) : []
  } catch {
    return []
  }
}

/**
 * Unload: unsaved buffers go to localStorage (newest first until 2 MB). The
 * stash of a tree not loaded this run (its drawer never opened) is still
 * there, unrestored: it stays, after this run's buffers.
 */
export function stashUnsaved(): void {
  const byWs = useFilesStore.getState().byWs
  const now: Stashed[] = []
  for (const [wsId, ws] of Object.entries(byWs)) {
    // A share link's tree is read-only: nothing of it to bring back.
    if (wsId.includes(':')) continue
    for (const tab of ws.tabs) if (isDirty(tab)) now.push({ wsId, rel: tab.rel, text: tab.text, eol: tab.eol, bom: tab.bom })
  }
  const loaded = new Set(Object.keys(byWs))
  const older = readStash().filter((s) => s && typeof s.wsId === 'string' && !loaded.has(s.wsId) && !s.wsId.includes(':') && typeof s.rel === 'string' && typeof s.text === 'string')
  const out: Stashed[] = []
  let size = 0
  for (const s of [...now, ...older]) {
    size += s.text.length * 2
    if (size > STASH_MAX) break
    out.push(s)
  }
  try {
    if (out.length) storage()?.setItem(STASH_KEY, JSON.stringify(out))
    else storage()?.removeItem(STASH_KEY)
  } catch {
    /* blocked or full storage: nothing to bring back */
  }
}

/**
 * Opening a tree (the drawer, or a Ctrl+click on a terminal path, app 2.7.0,
 * A9): its stashed buffers come back as unsaved tabs (once). A tab already
 * open on that file that still shows what it read from disk takes the stash;
 * one with edits of this session keeps them (they are newer).
 */
export function restoreUnsaved(wsId: string): void {
  const all = readStash()
  if (!all.length) return
  const mine = all.filter((s) => s && s.wsId === wsId && typeof s.rel === 'string' && typeof s.text === 'string')
  if (!mine.length) return
  const rest = all.filter((s) => !mine.includes(s))
  try {
    if (rest.length) storage()?.setItem(STASH_KEY, JSON.stringify(rest))
    else storage()?.removeItem(STASH_KEY)
  } catch {
    /* blocked storage */
  }
  patch(wsId, (ws) => {
    const tabs = [...ws.tabs]
    for (const s of mine) {
      const i = tabs.findIndex((t) => t.rel === s.rel)
      const open = i < 0 ? null : tabs[i]
      if (open && (open.kind !== 'text' || isDirty(open) || open.text === s.text)) continue
      const tab: FileTab = { rel: s.rel, kind: 'text', seq: ++tabSeq, initial: s.text, text: s.text, saved: '\u0000', rev: '', eol: s.eol === 'crlf' ? 'crlf' : 'lf', bom: !!s.bom, readOnly: false, size: s.text.length, restored: true }
      // The open tab's pending cursor (the Ctrl+click that opened it) still applies.
      if (open) tabs[i] = open.reveal ? { ...tab, reveal: open.reveal } : tab
      else tabs.push(tab)
    }
    return { tabs, active: ws.active ?? tabs[0]?.rel ?? null }
  })
}

/** The absolute path of a relative one under the root as the OS spells it. */
export function absPath(root: string, rel: string, platform: string): string {
  if (!rel) return root
  const sep = platform === 'win32' ? '\\' : '/'
  const base = root.endsWith('\\') || root.endsWith('/') ? root : root + sep
  return base + (platform === 'win32' ? rel.replace(/\//g, '\\') : rel)
}

export { joinRel, parentRel }
