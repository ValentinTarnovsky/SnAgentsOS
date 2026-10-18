/**
 * Pure helpers of the Changes panel (E7-FR-04, 11..16): sections and row
 * order, the panel keys, targets of a workspace, the absolute path of a row
 * (what a row drag carries and what a pane checks it against), the diff row
 * model with its render chunks, and the word-wrap preference. No React and no
 * store, so scripts/test-changes.cjs runs them in a vm.
 */
import type { GitArea, GitDiffHunk, GitDiffLine, GitFileEntry, GitSummary } from '@shared/git-types'
import type { Pane, Workspace } from '@shared/types'
import { paneGitKey, paneWorktreePath, workspaceGitKey } from './gitChip'

/** Section order of the file list (FR-12). */
export const SECTION_ORDER: readonly GitArea[] = ['conflict', 'staged', 'unstaged', 'untracked']

/** Panel poll while it is open and the window has focus (FR-06e). */
export const PANEL_POLL_MS = 3000
/** Diffs longer than this render in chunks as they scroll into view (Design C). */
export const CHUNK_THRESHOLD = 2000
export const CHUNK_ROWS = 500

export interface FileSection {
  area: GitArea
  files: GitFileEntry[]
}

/** Non-empty sections in panel order. A file staged and modified shows in both. */
export function groupFiles(files: readonly GitFileEntry[]): FileSection[] {
  return SECTION_ORDER.map((area) => ({ area, files: files.filter((f) => f.area === area) })).filter((s) => s.files.length > 0)
}

/** Identity of a row: the same path can be listed in two areas. */
export function rowKey(f: Pick<GitFileEntry, 'area' | 'path'>): string {
  return `${f.area}:${f.path}`
}

/** Rows the keyboard walks: every file of every expanded section, in order. */
export function visibleRows(files: readonly GitFileEntry[], collapsed: ReadonlySet<GitArea>): GitFileEntry[] {
  return groupFiles(files)
    .filter((s) => !collapsed.has(s.area))
    .flatMap((s) => s.files)
}

/** The row `dir` steps away from `current` (clamped), or the first row. */
export function stepRow(rows: readonly GitFileEntry[], current: string | null, dir: 1 | -1): GitFileEntry | null {
  if (!rows.length) return null
  const i = current ? rows.findIndex((r) => rowKey(r) === current) : -1
  if (i < 0) return rows[dir === 1 ? 0 : rows.length - 1]
  return rows[Math.min(rows.length - 1, Math.max(0, i + dir))]
}

/** "src/app/main.ts" -> name "main.ts", dir "src/app". */
export function splitName(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

/** "+12 -3", or "bin", or "" when not counted. */
export function rowCounts(f: GitFileEntry): string {
  if (f.binary) return 'bin'
  if (f.added === null && f.removed === null) return ''
  return `+${f.added ?? 0} -${f.removed ?? 0}`
}

/**
 * Absolute path of a repo-relative row, with the separator of the repo root
 * (backslashes for a Windows root). The drag payload and the pane's check
 * both use this, so "exact match" holds.
 */
export function absRepoPath(repoRoot: string, rel: string): string {
  const win = /^[a-zA-Z]:/.test(repoRoot) || repoRoot.startsWith('\\\\') || repoRoot.includes('\\')
  const s = win ? '\\' : '/'
  const root = repoRoot.replace(/[\\/]+$/, '')
  return `${root}${s}${win ? rel.replace(/\//g, '\\') : rel}`
}

/**
 * FR-04: whether an absolute path is exactly a file in the current list of
 * some target. `files` and `summaries` are the gitStore maps.
 */
export function isListedPath(abs: string, files: Record<string, GitFileEntry[]>, summaries: Record<string, GitSummary>): boolean {
  for (const [key, list] of Object.entries(files)) {
    const root = summaries[key]?.repoRoot
    if (!root) continue
    for (const f of list) if (absRepoPath(root, f.path) === abs) return true
  }
  return false
}

export interface PanelTarget {
  key: string
  /** Pane title for a worktree target; undefined for the workspace. */
  paneTitle?: string
}

/** What the target selector lists: the workspace (when it has a cwd) and each pane worktree. */
export function panelTargets(ws: Workspace): PanelTarget[] {
  const out: PanelTarget[] = []
  if (ws.cwd) out.push({ key: workspaceGitKey(ws.id) })
  for (const p of ws.panes as Pane[]) if (paneWorktreePath(p)) out.push({ key: paneGitKey(p.id), paneTitle: p.title })
  return out
}

/** Workspace a target key belongs to. */
export function workspaceOfKey(workspaces: readonly Workspace[], key: string): string | null {
  if (key.startsWith('ws:')) {
    const id = key.slice(3)
    return workspaces.some((w) => w.id === id) ? id : null
  }
  if (key.startsWith('pane:')) {
    const id = key.slice(5)
    return workspaces.find((w) => w.panes.some((p) => p.id === id))?.id ?? null
  }
  return null
}

// ---- keys ----------------------------------------------------------------

export type PanelKey = 'close' | 'nextHunk' | 'prevHunk' | 'nextFile' | 'prevFile' | 'wrap'

/**
 * Keys the panel owns while focus is inside it (FR-14): F7 / Shift+F7 hunks,
 * Alt+Down / Alt+Up files, Alt+Z wrap, Esc closes. None reaches xterm or a
 * global binding.
 */
export function panelKeyOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): PanelKey | null {
  if (e.ctrlKey || e.metaKey) return null
  if (e.key === 'F7' && !e.altKey) return e.shiftKey ? 'prevHunk' : 'nextHunk'
  if (e.altKey && !e.shiftKey && e.key === 'ArrowDown') return 'nextFile'
  if (e.altKey && !e.shiftKey && e.key === 'ArrowUp') return 'prevFile'
  if (e.altKey && !e.shiftKey && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) return 'wrap'
  if (e.key === 'Escape' && !e.altKey && !e.shiftKey) return 'close'
  return null
}

/** Next hunk index for F7 (`dir` 1) or Shift+F7 (-1), clamped; -1 = none yet. */
export function stepHunk(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0) return dir === 1 ? 0 : count - 1
  return Math.min(count - 1, Math.max(0, current + dir))
}

// ---- diff rows -------------------------------------------------------------

export type DiffRow = { type: 'hunk'; hunk: number; header: string } | { type: 'line'; hunk: number; line: GitDiffLine }

/** Flat rows of a diff (a header row per hunk, then its lines). */
export function diffRows(hunks: readonly GitDiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = []
  hunks.forEach((h, i) => {
    if (h.header) rows.push({ type: 'hunk', hunk: i, header: h.header })
    for (const line of h.lines) rows.push({ type: 'line', hunk: i, line })
  })
  return rows
}

/** Row index where each hunk starts. */
export function hunkStarts(rows: readonly DiffRow[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => {
    if (out[r.hunk] === undefined) out[r.hunk] = i
  })
  return out
}

/** Render chunks [start, end) of a diff: one chunk below the threshold. */
export function chunkRanges(total: number, threshold = CHUNK_THRESHOLD, size = CHUNK_ROWS): Array<[number, number]> {
  if (total <= threshold) return [[0, total]]
  const out: Array<[number, number]> = []
  for (let i = 0; i < total; i += size) out.push([i, Math.min(total, i + size)])
  return out
}

// ---- word wrap (FR-14) ------------------------------------------------------

export const WRAP_STORAGE_KEY = 'snagentsos.changes.wrap'

/** Alt+Z preference; default off. Storage can be missing or throw. */
export function loadWrap(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage?.getItem(WRAP_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function saveWrap(storage: Pick<Storage, 'setItem'> | null | undefined, on: boolean): void {
  try {
    storage?.setItem(WRAP_STORAGE_KEY, on ? '1' : '0')
  } catch {
    // Private window or blocked storage: the toggle still works for this session.
  }
}
