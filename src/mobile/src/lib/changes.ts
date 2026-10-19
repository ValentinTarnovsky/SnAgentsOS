/**
 * Changes on the phone (E3-FR-52, 53): which workspace the Changes screen and
 * the diff were opened for, and the pure helpers both screens use. The
 * requests go through client.requestGit (gitReq, pending by id with the 10s
 * timeout of E3-FR-04); main answers one `gitRes` page per request (E7-FR-22,
 * 23), so the status and the diff are read page by page here.
 *
 *  - Status: page 0 takes a fresh snapshot on the PC and the next pages come
 *    from it; the phone reads STATUS_MAX_PAGES at most (a few thousand files)
 *    and says how many it shows.
 *  - Diff: page 0 first, the next one when the reader gets to 80% of the
 *    scroll. A page whose `diffRev` differs from page 0's means the file
 *    changed: what was read is dropped and the read starts over at page 0. A
 *    hunk cut at a page edge comes back with `continued` and is joined to the
 *    previous one, so its header shows once.
 *
 * Patterned after Orca's mobile-git-status.ts / mobile-diff-format.ts (the
 * idea of grouped sections and flat diff rows; the code is ours).
 */
import { create } from 'zustand'
import type { GitArea, GitDiffHunk, GitDiffLine, GitFileEntry } from '@shared/git-types'
import type { RemoteGitChanges, RemoteGitDiffPage, RemoteGitError, RemoteGitReply, RemotePaneStatus, RemoteStateSnapshot } from '@shared/remote-protocol'
import type { PendingOutcome } from './pending'
import { isAgentPane } from './composerSend'
import type { MobileMessageKey } from './i18n'

/** Section order of the list (FR-52): conflicts first, then the index, the working tree, the new files. */
export const SECTION_ORDER: readonly GitArea[] = ['conflict', 'staged', 'unstaged', 'untracked']
/** Status pages read per refresh (each is up to 48KB, a few hundred files). */
export const STATUS_MAX_PAGES = 4
/** The next diff page is asked for once the reader is this far down (FR-53). */
export const DIFF_PREFETCH_AT = 0.8
/** A file that keeps changing under the reader restarts at most this many times per read. */
export const DIFF_MAX_RESTARTS = 2

/** The file a diff screen shows: `staged` reads the index, else the working tree. */
export interface DiffTarget {
  path: string
  area: GitArea
  staged: boolean
  oldPath?: string
}

interface ChangesState {
  /** Workspace the Changes screen shows; null = closed. */
  workspaceId: string | null
  /** File the diff screen shows over it; null = closed. */
  diff: DiffTarget | null
  /** The files of the last status read, in list order ("Next file"). */
  files: GitFileEntry[]
  /** Bumped to make the Changes screen read the status again. */
  reloadSeq: number
  /** The notes list or the send sheet, over whatever screen is on top. */
  notesUi: 'list' | 'send' | null
  update: (patch: Partial<Omit<ChangesState, 'update'>>) => void
}

export const useChangesStore = create<ChangesState>((set) => ({
  workspaceId: null,
  diff: null,
  files: [],
  reloadSeq: 0,
  notesUi: null,
  update: (patch) => set(patch),
}))

/** Open Changes for a workspace (Home's git chip, the terminal's kebab). */
export function openChanges(workspaceId: string): void {
  useChangesStore.getState().update({ workspaceId, diff: null, files: [], notesUi: null })
}

export function closeChanges(): void {
  useChangesStore.getState().update({ workspaceId: null, diff: null, notesUi: null })
}

export function openDiff(target: DiffTarget): void {
  useChangesStore.getState().update({ diff: target })
}

export function closeDiff(): void {
  useChangesStore.getState().update({ diff: null })
}

/** Ask the Changes screen to read the status again (a diff found its file gone). */
export function reloadChanges(): void {
  const s = useChangesStore.getState()
  s.update({ reloadSeq: s.reloadSeq + 1 })
}

export function openNotesUi(which: 'list' | 'send'): void {
  useChangesStore.getState().update({ notesUi: which })
}

export function closeNotesUi(): void {
  useChangesStore.getState().update({ notesUi: null })
}

// ---- status ---------------------------------------------------------------

/** What the Changes screen shows: the pages read so far, joined. */
export interface StatusView {
  summary: RemoteGitChanges['summary']
  files: GitFileEntry[]
  total: number
  truncated: boolean
  /** Pages read; the list is complete when `complete`. */
  pages: number
  complete: boolean
}

/** Join one status page onto what was read (page 0 starts over). */
export function mergeStatus(prev: StatusView | null, page: number, data: RemoteGitChanges, done: boolean): StatusView {
  const files = page === 0 || !prev ? [...data.files] : [...prev.files, ...data.files]
  return { summary: data.summary, files, total: data.total, truncated: data.truncated, pages: page + 1, complete: done }
}

/** The files grouped by section, in SECTION_ORDER, without empty sections. */
export function groupChanges(files: readonly GitFileEntry[]): Array<{ area: GitArea; files: GitFileEntry[] }> {
  return SECTION_ORDER.map((area) => ({ area, files: files.filter((f) => f.area === area) })).filter((g) => g.files.length > 0)
}

/** The files in the order the screen lists them ("Next file" walks it). */
export function orderedFiles(files: readonly GitFileEntry[]): GitFileEntry[] {
  return groupChanges(files).flatMap((g) => g.files)
}

export function diffTargetOf(f: GitFileEntry): DiffTarget {
  return { path: f.path, area: f.area, staged: f.area === 'staged', ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}) }
}

export function sameTarget(a: Pick<DiffTarget, 'path' | 'area'>, b: Pick<DiffTarget, 'path' | 'area'>): boolean {
  return a.path === b.path && a.area === b.area
}

/** The file after `current` in list order, or null at the end (or when it left the list). */
export function nextFile(files: readonly GitFileEntry[], current: Pick<DiffTarget, 'path' | 'area'>): GitFileEntry | null {
  const list = orderedFiles(files)
  const i = list.findIndex((f) => sameTarget(f, current))
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null
}

/** The badge letter of a file (FR-52: M/A/D/R/U/?); a copy reads as R, a type change as M. */
export function statusBadge(f: Pick<GitFileEntry, 'status'>): 'M' | 'A' | 'D' | 'R' | 'U' | '?' {
  if (f.status === 'C') return 'R'
  if (f.status === 'T') return 'M'
  return f.status
}

/** Last segment of a repo path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

/** Folder part of a repo path ('' at the root), with its trailing slash. */
export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i + 1) : ''
}

const ERROR_KEYS: Partial<Record<RemoteGitError['error'], MobileMessageKey>> = {
  not_repo: 'changes.notRepo',
  git_missing: 'changes.err.gitMissing',
  git_old: 'changes.err.gitOld',
  unsafe_repo: 'changes.err.unsafeRepo',
  not_found: 'changes.err.noTarget',
}

/** The message of a status that failed. */
export function statusErrorKey(error: string): MobileMessageKey {
  return ERROR_KEYS[error as RemoteGitError['error']] ?? 'changes.err.generic'
}

/**
 * How one gitRes ended for the screens: data, "The PC did not answer [Retry]"
 * (no answer in 10s, the phone offline, or main's `rate`/`timeout`), or a
 * git error code.
 */
export type GitOutcome<T> = { kind: 'data'; data: T; page: number; done: boolean } | { kind: 'noReply' } | { kind: 'error'; error: string }

export function gitOutcome<T extends RemoteGitChanges | RemoteGitDiffPage>(res: PendingOutcome<RemoteGitReply>): GitOutcome<T> {
  if (!res.ok) return { kind: 'noReply' }
  const reply = res.value
  if (!reply.ok || 'error' in reply.data) {
    const error = 'error' in reply.data ? String(reply.data.error) : 'git_error'
    return error === 'rate' || error === 'timeout' ? { kind: 'noReply' } : { kind: 'error', error }
  }
  return { kind: 'data', data: reply.data as T, page: reply.page, done: reply.done }
}

// ---- diff -------------------------------------------------------------------

/** A diff being read page by page. */
export interface DiffLoad {
  /** The page header (path, area, diffRev, binary, tooLarge) once page 0 arrived. */
  head: Omit<RemoteGitDiffPage, 'hunks'> | null
  hunks: GitDiffHunk[]
  /** The next page to ask for. */
  nextPage: number
  done: boolean
  /** Times the read started over because the file changed. */
  restarts: number
}

export function emptyDiffLoad(restarts = 0): DiffLoad {
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
      out.push({ ...rest, lines: [...h.lines] })
    }
  }
  return out
}

/**
 * Apply the answer to page `page`. `restart` = the file changed since page 0
 * (another diffRev): the read starts over at page 0, unless it already did
 * DIFF_MAX_RESTARTS times (`unstable`).
 */
export function applyDiffPage(load: DiffLoad, page: number, data: RemoteGitDiffPage, done: boolean): { load: DiffLoad; restart: boolean; unstable: boolean } {
  const { hunks, ...head } = data
  if (page === 0 || !load.head) {
    return { load: { head, hunks: appendHunks([], hunks), nextPage: page + 1, done, restarts: load.restarts }, restart: false, unstable: false }
  }
  if (head.diffRev !== load.head.diffRev) {
    if (load.restarts >= DIFF_MAX_RESTARTS) return { load: { ...load, done: true }, restart: false, unstable: true }
    return { load: emptyDiffLoad(load.restarts + 1), restart: true, unstable: false }
  }
  return { load: { ...load, hunks: appendHunks(load.hunks, hunks), nextPage: page + 1, done }, restart: false, unstable: false }
}

/** Whether the reader is far enough down to ask for the next page (80% of the scroll). */
export function shouldPrefetch(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  if (scrollHeight <= 0) return true
  return (scrollTop + clientHeight) / scrollHeight >= DIFF_PREFETCH_AT
}

/** One row of the diff view. */
export type DiffRow =
  | { kind: 'hunk'; key: string; header: string }
  | {
      kind: 'line'
      key: string
      line: GitDiffLine
      /** The number shown: the new one, or the old one on a deleted line (FR-53). */
      no: number | undefined
      /** New-side line a note can anchor to (add and context lines). */
      noteLine: number | undefined
      /** Last new-side line of this hunk (the range stepper's end). */
      hunkEnd: number
    }

/** The read hunks as flat rows: a header row, then its lines. */
export function diffRows(hunks: readonly GitDiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = []
  hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', key: `h${hi}`, header: h.header })
    let hunkEnd = 0
    for (const l of h.lines) if (l.kind !== 'del' && l.kind !== 'meta' && l.newNo !== undefined) hunkEnd = Math.max(hunkEnd, l.newNo)
    h.lines.forEach((l, li) => {
      const noteLine = (l.kind === 'add' || l.kind === 'ctx') && l.newNo !== undefined ? l.newNo : undefined
      rows.push({ kind: 'line', key: `h${hi}l${li}`, line: l, no: l.kind === 'del' ? l.oldNo : l.newNo, noteLine, hunkEnd })
    })
  })
  return rows
}

/** Text of each new-side line the read hunks show (notes compare against it). */
export function newSideLines(hunks: readonly GitDiffHunk[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const h of hunks) for (const l of h.lines) if ((l.kind === 'add' || l.kind === 'ctx') && l.newNo !== undefined) out.set(l.newNo, l.text)
  return out
}

/** The prefix column of a line. */
export function linePrefix(kind: GitDiffLine['kind']): string {
  return kind === 'add' ? '+' : kind === 'del' ? '-' : ' '
}

// ---- sending notes ------------------------------------------------------------

/**
 * The console "Send N notes" picks first (E3-FR-55): the agent console of
 * the workspace this phone viewed last, else the first agent console, else
 * the first console; null without consoles.
 */
export function defaultNotesTarget(
  snap: RemoteStateSnapshot | null,
  workspaceId: string,
  lastViewedAt: Readonly<Record<string, number>>,
  statuses: Readonly<Record<string, RemotePaneStatus>>,
  lastPane: string | null,
): string | null {
  const ws = snap?.workspaces.find((w) => w.id === workspaceId)
  if (!ws || ws.panes.length === 0) return null
  const agents = ws.panes.filter((p) => isAgentPane(p.type, statuses[p.id]))
  if (lastPane && agents.some((p) => p.id === lastPane)) return lastPane
  let best: string | null = null
  let at = -Infinity
  for (const p of agents) {
    const seen = lastViewedAt[p.id]
    if (seen !== undefined && seen > at) {
      at = seen
      best = p.id
    }
  }
  return best ?? agents[0]?.id ?? ws.panes[0].id
}
