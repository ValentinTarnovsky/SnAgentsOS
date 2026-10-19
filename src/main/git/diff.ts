/**
 * Changes panel reads in main (E7-FR-12, 13, 15): the per-file list with its
 * per-area line counts, one file's unified diff parsed into hunks, and opening
 * a listed file. Written from the git documentation (git-diff "Generating
 * patch text with -p", "Combined diff format"); Orca's file-diff.ts was only a
 * reference for the pattern (no code copied).
 *
 * Every path the renderer sends must be one main itself listed for that key
 * (the last `status` entries GitService cached), relative, without `..` and
 * resolving inside the repo root. Diffs run with --no-ext-diff and
 * --no-textconv (plus core.fsmonitor=false from gitExec), so nothing defined
 * by the repo's config or .gitattributes ever runs. Opening a file goes
 * through an extension allowlist checked here, not only in the UI: anything
 * else is shown in its folder, never executed.
 */
import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { dirname, extname, isAbsolute, relative, resolve as resolvePath } from 'path'
import type { GitArea, GitBaseStat, GitChangesRes, GitDiffError, GitDiffHunk, GitDiffLine, GitDiffReply, GitFileEntry, GitSummary } from '@shared/git-types'
import { gitErrorCode, type GitRunner } from './gitExec'
import { parseNumstatZ, type NumstatEntry } from './porcelain'
import { isBaseSha, listAgainstBase, sumBase } from './baseDiff'

/** Above either limit a diff is "too large" until the user asks for it anyway. */
export const DIFF_MAX_LINES = 5000
export const DIFF_MAX_BYTES = 512 * 1024
/** Untracked files are read up to this size; a bigger one only reports its size. */
export const UNTRACKED_READ_BYTES = 512 * 1024
/** Even with force, an untracked file is never read past git's own output cap (gitExec maxBuffer). */
export const UNTRACKED_FORCE_BYTES = 16 * 1024 * 1024
const BINARY_SNIFF = 8192
const MAX_REL_PATH = 4096

/**
 * Extensions "Open with the default app" may open (E7-FR-15): text, code and
 * images whose default handler only shows them. Everything else (.bat, .cmd,
 * .exe, .hta, .reg, .lnk, .ps1, .vbs, no extension...) is revealed in its
 * folder instead. E7's list also had .js .mjs .cjs .py .sh .rb .html .svg, but
 * their default handler runs them (.js in Windows Script Host, .py in the
 * launcher, .sh in Git Bash, .rb in Ruby, .html/.svg as local scripts over
 * file://), the same reason E2-FR-30 keeps them out of its allowlist; they
 * are revealed too.
 */
export const OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt', '.md', '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.xml', '.css', '.scss',
  '.ts', '.tsx', '.jsx', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.php', '.sql', '.gradle', '.properties', '.csv', '.log', '.png',
  '.jpg', '.jpeg', '.gif', '.webp',
])

/** Whether the allowlist lets this path open with its default app. */
export function canOpenWithDefaultApp(p: string): boolean {
  const ext = extname(p).toLowerCase()
  return ext !== '' && OPEN_EXTENSIONS.has(ext)
}

/** C0, DEL, C1 and the Unicode line/paragraph separators. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

/**
 * Absolute path of a repo-relative path, or null when it is not a safe
 * relative path: empty, absolute (any platform's form), a drive or UNC path,
 * a `..` segment, a control char, or anything resolving outside the root.
 */
export function resolveRepoPath(repoRoot: string, rel: string, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > MAX_REL_PATH || hasControl(rel)) return null
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return null
  if (rel.split(/[\\/]/).some((seg) => seg === '..')) return null
  const root = resolvePath(repoRoot)
  const abs = resolvePath(root, rel)
  const caseless = platform === 'win32'
  const r = relative(caseless ? root.toLowerCase() : root, caseless ? abs.toLowerCase() : abs)
  if (!r || r.startsWith('..') || isAbsolute(r)) return null
  return abs
}

/** The listed entry for (path, area), if main listed it. */
export function findListed(files: readonly GitFileEntry[], path: string, area?: GitArea): GitFileEntry | null {
  for (const f of files) if (f.path === path && (area === undefined || f.area === area)) return f
  return null
}

// ---- unified diff parser ---------------------------------------------------

export interface ParsedDiff {
  hunks: GitDiffHunk[]
  binary: boolean
  /** Lines inside the hunks (headers included). */
  totalLines: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
const COMBINED_RE = /^@@@+ /
/** File header lines worth showing when a diff has no hunk (mode change, pure rename). */
const FILE_META_RE = /^(old mode|new mode|deleted file mode|new file mode|similarity index|rename from|rename to|copy from|copy to) /

/**
 * Parse `git diff --no-color -U3` output of one file. A two-way hunk becomes
 * numbered ctx/add/del lines; a combined (conflict) diff and anything else
 * inside a hunk that is not a diff line is kept raw as `meta`. File headers
 * (`diff --git`, `index`, `---`, `+++`, mode and rename lines) are dropped.
 */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  const hunks: GitDiffHunk[] = []
  let binary = false
  let total = 0
  let cur: GitDiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let combined = false
  const fileMeta: GitDiffLine[] = []
  const lines = raw.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (let line of lines) {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const m = HUNK_RE.exec(line)
    if (m) {
      combined = false
      oldNo = Number(m[1])
      newNo = Number(m[3])
      cur = { header: line, oldStart: oldNo, newStart: newNo, lines: [] }
      hunks.push(cur)
      total++
      continue
    }
    if (COMBINED_RE.test(line)) {
      combined = true
      cur = { header: line, oldStart: 0, newStart: 0, lines: [] }
      hunks.push(cur)
      total++
      continue
    }
    if (!cur) {
      if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') binary = true
      else if (FILE_META_RE.test(line)) fileMeta.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      cur = null
      continue
    }
    let out: GitDiffLine
    if (combined) out = { kind: 'meta', text: line }
    else if (line.startsWith('+')) out = { kind: 'add', newNo: newNo++, text: line.slice(1) }
    else if (line.startsWith('-')) out = { kind: 'del', oldNo: oldNo++, text: line.slice(1) }
    else if (line.startsWith(' ') || line === '') out = { kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) }
    else out = { kind: 'meta', text: line } // "\ No newline at end of file"
    cur.lines.push(out)
    total++
  }
  // A mode-only change or a pure rename has no hunk: show what git said instead.
  if (!hunks.length && !binary && fileMeta.length) {
    hunks.push({ header: '', oldStart: 0, newStart: 0, lines: fileMeta })
    total = fileMeta.length
  }
  return { hunks, binary, totalLines: total }
}

/** An untracked file as an all-added diff (or binary). */
export function untrackedDiff(buf: Uint8Array): ParsedDiff {
  const sniff = Math.min(buf.length, BINARY_SNIFF)
  for (let i = 0; i < sniff; i++) if (buf[i] === 0) return { hunks: [], binary: true, totalLines: 0 }
  const text = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf8')
  if (!text) return { hunks: [], binary: false, totalLines: 0 }
  const rows = text.split('\n')
  if (rows[rows.length - 1] === '') rows.pop()
  const lines: GitDiffLine[] = rows.map((r, i) => ({ kind: 'add', newNo: i + 1, text: r.endsWith('\r') ? r.slice(0, -1) : r }))
  if (!text.endsWith('\n')) lines.push({ kind: 'meta', text: '\\ No newline at end of file' })
  return { hunks: [{ header: `@@ -0,0 +1,${rows.length} @@`, oldStart: 0, newStart: 1, lines }], binary: false, totalLines: lines.length + 1 }
}

export function diffRevOf(raw: string | Uint8Array): string {
  return createHash('sha1').update(raw).digest('hex')
}

/** Line count of a raw diff (cheap, before parsing). */
function countRawLines(raw: string): number {
  let n = 0
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) n++
  return raw.length && !raw.endsWith('\n') ? n + 1 : n
}

// ---- reads ------------------------------------------------------------------

export interface DiffFs {
  lstat(p: string): Promise<{ size: number; isFile(): boolean; isSymbolicLink(): boolean; isDirectory(): boolean }>
  readFile(p: string): Promise<Uint8Array>
  readlink(p: string): Promise<string>
}

const realFs: DiffFs = {
  lstat: (p) => fsp.lstat(p),
  readFile: (p) => fsp.readFile(p),
  readlink: (p) => fsp.readlink(p),
}

export interface FileDiffReq {
  repoRoot: string
  entry: GitFileEntry
  force: boolean
  runner: Pick<GitRunner, 'run'>
  fs?: DiffFs
  platform?: NodeJS.Platform
  /** "Against base" mode (E7-FR-35): a tracked entry diffs the working tree against this full sha. */
  base?: string
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-U3']
/**
 * Paths after `--` are literal: as pathspecs `app/[id]/page.tsx` would also
 * match `app/i/page.tsx` and mix another file's hunks into the diff.
 */
const LITERAL = '--literal-pathspecs'

/** One listed file's diff (E7-FR-13). The entry must come from main's own list. */
export async function readFileDiff(req: FileDiffReq): Promise<GitDiffReply> {
  const { repoRoot, entry, force } = req
  const fs = req.fs ?? realFs
  const abs = resolveRepoPath(repoRoot, entry.path, req.platform)
  if (!abs || (entry.oldPath !== undefined && !resolveRepoPath(repoRoot, entry.oldPath, req.platform))) return { error: 'denied' }
  const base = { path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), area: entry.area }
  try {
    if (entry.area === 'untracked') {
      let st
      try {
        st = await fs.lstat(abs)
      } catch {
        return { error: 'gone' }
      }
      if (st.isSymbolicLink()) {
        const target = await fs.readlink(abs)
        const hunks: GitDiffHunk[] = [{ header: '@@ -0,0 +1,1 @@', oldStart: 0, newStart: 1, lines: [{ kind: 'add', newNo: 1, text: target }] }]
        return { ...base, binary: false, diffRev: diffRevOf(`link:${target}`), hunks, totalLines: 2 }
      }
      if (!st.isFile()) return { ...base, binary: true, diffRev: diffRevOf(`dir:${st.size}`), hunks: [], totalLines: 0 }
      if (force && st.size > UNTRACKED_FORCE_BYTES) return { error: 'git_error' }
      if (st.size > UNTRACKED_READ_BYTES && !force) {
        return { ...base, binary: false, diffRev: diffRevOf(`size:${st.size}`), tooLarge: { lines: 0, bytes: st.size }, hunks: [], totalLines: 0 }
      }
      const buf = await fs.readFile(abs)
      const parsed = untrackedDiff(buf)
      if (!force && !parsed.binary && parsed.totalLines > DIFF_MAX_LINES) {
        return { ...base, binary: false, diffRev: diffRevOf(buf), tooLarge: { lines: parsed.totalLines, bytes: buf.length }, hunks: [], totalLines: parsed.totalLines }
      }
      return { ...base, binary: parsed.binary, diffRev: diffRevOf(buf), hunks: parsed.hunks, totalLines: parsed.totalLines }
    }
    const args = [LITERAL, 'diff', ...DIFF_FLAGS]
    if (req.base !== undefined) {
      if (!isBaseSha(req.base)) return { error: 'denied' }
      args.push('-M', req.base, '--', entry.path)
      if (entry.oldPath) args.push(entry.oldPath)
    } else {
      if (entry.area === 'staged') args.push('--cached')
      if (entry.area !== 'conflict') args.push('-M')
      args.push('--', entry.path)
      if (entry.oldPath && entry.area === 'staged') args.push(entry.oldPath)
    }
    const raw = await req.runner.run(args, { cwd: repoRoot, timeoutMs: 15000 })
    const rev = diffRevOf(raw)
    const lines = countRawLines(raw)
    const bytes = Buffer.byteLength(raw, 'utf8')
    if (!force && (lines > DIFF_MAX_LINES || bytes > DIFF_MAX_BYTES)) {
      const quick = /^Binary files .* differ$/m.test(raw.slice(0, 4096))
      return { ...base, binary: quick, diffRev: rev, ...(quick ? {} : { tooLarge: { lines, bytes } }), hunks: [], totalLines: lines }
    }
    if (!raw.trim()) return { error: 'gone' }
    const parsed = parseUnifiedDiff(raw)
    return { ...base, binary: parsed.binary, diffRev: rev, hunks: parsed.hunks, totalLines: parsed.totalLines }
  } catch (e) {
    return { error: gitErrorCode(e) as GitDiffError }
  }
}

/** numstat rows by path. */
function byPath(list: NumstatEntry[]): Map<string, NumstatEntry> {
  const m = new Map<string, NumstatEntry>()
  for (const e of list) m.set(e.path, e)
  return m
}

/**
 * Fill each listed entry's `+a -d` from the per-area numstats (staged from
 * `diff --cached`, unstaged and conflicts from `diff`), and untracked entries
 * from the line cache (`untrackedLines(path)`: a count, null for a binary,
 * undefined when not counted).
 */
export async function withAreaCounts(
  repoRoot: string,
  files: readonly GitFileEntry[],
  runner: Pick<GitRunner, 'run'>,
  untrackedLines: (rel: string) => number | null | undefined,
): Promise<GitFileEntry[]> {
  const flags = ['--no-ext-diff', '--no-textconv', '-z', '--numstat']
  const hasStaged = files.some((f) => f.area === 'staged')
  const hasWork = files.some((f) => f.area === 'unstaged' || f.area === 'conflict')
  const [cached, work] = await Promise.all([
    hasStaged ? runner.run(['diff', '--cached', ...flags, '-M'], { cwd: repoRoot }).then(parseNumstatZ) : Promise.resolve([]),
    hasWork ? runner.run(['diff', ...flags], { cwd: repoRoot }).then(parseNumstatZ) : Promise.resolve([]),
  ])
  const staged = byPath(cached)
  const unstaged = byPath(work)
  return files.map((f) => {
    if (f.area === 'untracked') {
      const n = untrackedLines(f.path)
      return { ...f, added: n === undefined ? null : (n ?? null), removed: n === undefined || n === null ? null : 0, binary: n === null }
    }
    const hit = (f.area === 'staged' ? staged : unstaged).get(f.path)
    return hit ? { ...f, added: hit.added, removed: hit.removed, binary: hit.binary } : f
  })
}

// ---- open ---------------------------------------------------------------------

export interface OpenDeps {
  fs?: Pick<DiffFs, 'lstat'>
  openPath: (p: string) => Promise<string>
  showItemInFolder: (p: string) => void
  platform?: NodeJS.Platform
}

/**
 * "Open with the default app" / "Show in folder" for a listed file (E7-FR-15).
 * Opens only a regular file (never a link, which could point at an
 * executable) whose extension is on the allowlist; anything else is revealed.
 * A deleted file reveals its folder when that still exists.
 */
export async function openRepoFile(repoRoot: string, rel: string, reveal: boolean, deps: OpenDeps): Promise<boolean> {
  const abs = resolveRepoPath(repoRoot, rel, deps.platform)
  if (!abs) return false
  const fs = deps.fs ?? realFs
  let st
  try {
    st = await fs.lstat(abs)
  } catch {
    st = null
  }
  if (!st) {
    // Deleted: its folder (inside the repo, resolveRepoPath checked) if it is still there.
    const dir = dirname(abs)
    try {
      if (!(await fs.lstat(dir)).isDirectory()) return false
    } catch {
      return false
    }
    return (await deps.openPath(dir)) === ''
  }
  if (!reveal && st.isFile() && !st.isSymbolicLink() && canOpenWithDefaultApp(abs)) {
    return (await deps.openPath(abs)) === ''
  }
  deps.showItemInFolder(abs)
  return true
}

// ---- the panel's IPC surface ----------------------------------------------------

/** What the reader needs from GitService (its cached list is the allowlist of paths). */
export interface ChangesSource {
  ensureFresh(key: string, maxAgeMs: number): Promise<{ summary: GitSummary | null; files: GitFileEntry[] } | null>
  get(key: string): { summary: GitSummary | null; files: GitFileEntry[] } | null
}

export interface ChangesReaderDeps {
  source: ChangesSource
  runner: Pick<GitRunner, 'run'>
  /** Cached untracked line count by absolute path (UntrackedCounter.peek). */
  untrackedPeek: (abs: string) => number | null | undefined
  open: Omit<OpenDeps, 'fs' | 'platform'>
  fs?: DiffFs
  platform?: NodeJS.Platform
  /** A `git:status` reuses a run this recent (the panel poll keeps it fresh). */
  maxAgeMs?: number
}

const AREAS: ReadonlySet<string> = new Set<GitArea>(['staged', 'unstaged', 'untracked', 'conflict'])

/** One "against base" list per (target, base): the allowlist of its diffs, rebuilt when the target's status list changes. */
interface BaseList {
  base: string
  of: GitFileEntry[]
  files: Promise<GitFileEntry[]>
  /** The resolved list, once it is in. */
  done?: GitFileEntry[]
}

/** Base lists kept at most (targets come and go with the consoles). */
const MAX_BASE_LISTS = 64

/**
 * `git:status`, `git:fileDiff`, `git:openFile` over a GitService (E7-FR-12,
 * 13, 15), plus their "against base" form and `git:baseStat` for worktree
 * consoles (E7-FR-35): only `pane:` targets, only a full sha.
 */
export class ChangesReader {
  /** Area counts per listed array: a list is replaced on every run, so its identity is the cache key. */
  private counts = new WeakMap<GitFileEntry[], Promise<GitFileEntry[]>>()
  private bases = new Map<string, BaseList>()

  constructor(private deps: ChangesReaderDeps) {}

  /** The base list of a pane target, from cache while its status list and base stay the same. */
  private baseList(key: string, base: string, summary: GitSummary, files: GitFileEntry[]): Promise<GitFileEntry[]> {
    const id = `${key}\0${base.toLowerCase()}`
    const prev = this.bases.get(id)
    if (prev && prev.of === files) return prev.files
    const repoRoot = summary.repoRoot
    const entry: BaseList = {
      base,
      of: files,
      files: listAgainstBase(repoRoot, base, files, this.deps.runner, (rel) => {
        const abs = resolveRepoPath(repoRoot, rel, this.deps.platform)
        return abs ? this.deps.untrackedPeek(abs) : undefined
      }),
      // While it rebuilds, the last list stays the allowlist (a diff click never sees a gap).
      ...(prev?.done ? { done: prev.done } : {}),
    }
    entry.files.then(
      (list) => {
        entry.done = list
      },
      () => {
        if (this.bases.get(id) !== entry) return
        if (prev) this.bases.set(id, prev)
        else this.bases.delete(id)
      },
    )
    this.bases.delete(id)
    this.bases.set(id, entry)
    if (this.bases.size > MAX_BASE_LISTS) this.bases.delete(this.bases.keys().next().value as string)
    return entry.files
  }

  /** The last resolved base list of a target for exactly this base, if any. */
  private listedAgainst(key: string, base: string): GitFileEntry[] | null {
    return this.bases.get(`${key}\0${base.toLowerCase()}`)?.done ?? null
  }

  async status(key: unknown, base?: unknown): Promise<GitChangesRes | null> {
    if (typeof key !== 'string') return null
    if (base !== undefined && (!key.startsWith('pane:') || !isBaseSha(base))) return null
    const view = await this.deps.source.ensureFresh(key, this.deps.maxAgeMs ?? 2500)
    if (!view || !view.summary) return null
    const { summary, files } = view
    if (typeof base === 'string') {
      try {
        return { summary, files: await this.baseList(key, base, summary, files) }
      } catch {
        return null
      }
    }
    let pending = this.counts.get(files)
    if (!pending) {
      const repoRoot = summary.repoRoot
      pending = withAreaCounts(repoRoot, files, this.deps.runner, (rel) => {
        const abs = resolveRepoPath(repoRoot, rel, this.deps.platform)
        return abs ? this.deps.untrackedPeek(abs) : undefined
      }).catch(() => files)
      this.counts.set(files, pending)
    }
    return { summary, files: await pending }
  }

  async fileDiff(req: unknown): Promise<GitDiffReply> {
    const { key, path, area, force, base } = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>
    if (typeof key !== 'string' || typeof path !== 'string' || typeof area !== 'string' || !AREAS.has(area)) return { error: 'denied' }
    if (base !== undefined && (!key.startsWith('pane:') || !isBaseSha(base))) return { error: 'denied' }
    const view = this.deps.source.get(key)
    if (!view?.summary) return { error: 'gone' }
    const list = typeof base === 'string' ? this.listedAgainst(key, base) : view.files
    const entry = list ? findListed(list, path, area as GitArea) : null
    if (!entry) return { error: 'gone' }
    // An untracked file reads the same with or without a base: no git diff runs for it.
    const withBase = typeof base === 'string' && entry.area !== 'untracked' ? { base } : {}
    return readFileDiff({ repoRoot: view.summary.repoRoot, entry, force: force === true, runner: this.deps.runner, fs: this.deps.fs, platform: this.deps.platform, ...withBase })
  }

  async openFile(req: unknown): Promise<boolean> {
    const { key, path, reveal, base } = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>
    if (typeof key !== 'string' || typeof path !== 'string') return false
    if (base !== undefined && (!key.startsWith('pane:') || !isBaseSha(base))) return false
    const view = this.deps.source.get(key)
    const list = typeof base === 'string' ? this.listedAgainst(key, base) : view?.files
    if (!view?.summary || !list || !findListed(list, path)) return false
    return openRepoFile(view.summary.repoRoot, path, reveal === true, { ...this.deps.open, fs: this.deps.fs, platform: this.deps.platform })
  }

  /** `git:baseStat`: a worktree console's `+a -d N files` against its base (the race bar); null when unreadable. */
  async baseStat(req: unknown): Promise<GitBaseStat | null> {
    const { key, base } = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>
    if (typeof key !== 'string' || !key.startsWith('pane:') || !isBaseSha(base)) return null
    const view = await this.deps.source.ensureFresh(key, this.deps.maxAgeMs ?? 2500)
    if (!view?.summary) return null
    try {
      return sumBase(await this.baseList(key, base, view.summary, view.files), view.summary)
    } catch {
      return null
    }
  }
}
