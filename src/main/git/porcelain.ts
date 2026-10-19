/**
 * Parsers for `git status --porcelain=v2 --branch -z` and `git diff -z
 * --numstat`. Written from the git documentation (git-status "Porcelain
 * Format Version 2", git-diff "--numstat"); Orca's status-read.ts was only a
 * reference for the cases to cover. Paths come back relative to the repo
 * root with '/', exactly as git prints them (core.quotePath=false, -z).
 */
import type { GitFileEntry } from '@shared/git-types'

/** Status entries kept per target; the rest only count (E7-FR-05 `truncated`). */
export const MAX_STATUS_ENTRIES = 5000

export interface BranchInfo {
  /** Full sha, or null when the repo has no commits yet. */
  oid: string | null
  /** Branch name, or null when detached. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export interface StatusParse {
  branch: BranchInfo
  /** Entries in git order, at most MAX_STATUS_ENTRIES. */
  entries: GitFileEntry[]
  /** Every entry, kept or not. */
  totalEntries: number
  /** Distinct paths over every entry. */
  files: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
  truncated: boolean
}

type Status = GitFileEntry['status']
const STATUS_LETTERS = new Set(['M', 'A', 'D', 'R', 'C', 'T'])

function letter(c: string): Status | null {
  return STATUS_LETTERS.has(c) ? (c as Status) : null
}

/** Split off `n` space separated fields; the rest of the record is the path (it may hold spaces). */
function fields(record: string, n: number): { parts: string[]; rest: string } | null {
  const parts: string[] = []
  let at = 0
  for (let i = 0; i < n; i++) {
    const sp = record.indexOf(' ', at)
    if (sp < 0) return null
    parts.push(record.slice(at, sp))
    at = sp + 1
  }
  return { parts, rest: record.slice(at) }
}

export function parseStatusV2(out: string): StatusParse {
  const branch: BranchInfo = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 }
  const entries: GitFileEntry[] = []
  const paths = new Set<string>()
  let total = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicts = 0
  const push = (e: GitFileEntry): void => {
    total++
    paths.add(e.path)
    if (e.area === 'staged') staged++
    else if (e.area === 'unstaged') unstaged++
    else if (e.area === 'untracked') untracked++
    else conflicts++
    if (entries.length < MAX_STATUS_ENTRIES) entries.push(e)
  }
  const recs = out.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (!rec) continue
    const kind = rec[0]
    if (kind === '#') {
      const m = /^# branch\.(\w+) (.*)$/.exec(rec)
      if (!m) continue
      const [, name, value] = m
      if (name === 'oid') branch.oid = value === '(initial)' ? null : value
      else if (name === 'head') branch.head = value === '(detached)' ? null : value
      else if (name === 'upstream') branch.upstream = value
      else if (name === 'ab') {
        const ab = /^\+(\d+) -(\d+)$/.exec(value)
        if (ab) {
          branch.ahead = Number(ab[1])
          branch.behind = Number(ab[2])
        }
      }
    } else if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = fields(rec, kind === '1' ? 8 : 9)
      if (!f) continue
      const xy = f.parts[1] ?? '..'
      const path = f.rest
      let oldPath: string | undefined
      if (kind === '2') {
        oldPath = recs[i + 1]
        i++
      }
      const x = letter(xy[0])
      const y = letter(xy[1])
      const renamed = kind === '2' && (x === 'R' || x === 'C')
      if (x) push({ path, ...(renamed && oldPath ? { oldPath } : {}), area: 'staged', status: x, added: null, removed: null, binary: false })
      // A worktree-side rename only exists with --find-renames on the worktree; report it like git.
      if (y) push({ path, ...(kind === '2' && !renamed && oldPath ? { oldPath } : {}), area: 'unstaged', status: y, added: null, removed: null, binary: false })
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = fields(rec, 10)
      if (!f) continue
      push({ path: f.rest, area: 'conflict', status: 'U', added: null, removed: null, binary: false })
    } else if (kind === '?') {
      push({ path: rec.slice(2), area: 'untracked', status: '?', added: null, removed: null, binary: false })
    }
    // '!' (ignored) never shows: we do not pass --ignored.
  }
  return {
    branch,
    entries,
    totalEntries: total,
    files: paths.size,
    staged,
    unstaged,
    untracked,
    conflicts,
    truncated: total > MAX_STATUS_ENTRIES,
  }
}

export interface NumstatEntry {
  path: string
  oldPath?: string
  added: number | null
  removed: number | null
  binary: boolean
}

/**
 * `git diff -z --numstat [-M]`: `a\tr\tpath\0`, or for a rename
 * `a\tr\t\0old\0new\0`. `-\t-` marks a binary file.
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const res: NumstatEntry[] = []
  const recs = out.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (!rec) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec)
    if (!m) continue
    const binary = m[1] === '-' && m[2] === '-'
    const added = m[1] === '-' ? null : Number(m[1])
    const removed = m[2] === '-' ? null : Number(m[2])
    if (m[3] === '') {
      const oldPath = recs[i + 1]
      const path = recs[i + 2]
      i += 2
      if (path === undefined || oldPath === undefined) continue
      res.push({ path, oldPath, added, removed, binary })
    } else res.push({ path: m[3], added, removed, binary })
  }
  return res
}

/** Sum of a numstat; binaries count 0. */
export function sumNumstat(list: NumstatEntry[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const e of list) {
    added += e.added ?? 0
    removed += e.removed ?? 0
  }
  return { added, removed }
}
