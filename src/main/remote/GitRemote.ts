/**
 * The phone's read of git (E7-FR-22..26, Design E): `gitReq` in, one `gitRes`
 * page out. Every answer is cut so the framed `gitRes` stays at or under
 * GIT_FRAME_MAX (48KB): outgoing frames are only bounded by the socket's
 * backpressure, and a big list or diff must never push the subscribed panes'
 * output past BACKPRESSURE_DROP.
 *
 *  - status: the `ws:<workspaceId>` target only (gitReq has no paneId). A cache
 *    older than STATUS_MAX_AGE_MS refreshes first (GitService's single flight
 *    and minimum gap still apply) and the target turns hot for 60s (FR-06f).
 *    Page 0 takes a fresh snapshot of the list; later pages come from that same
 *    snapshot for DIFF_CACHE_MS, so a refresh between two pages never shifts
 *    entries from one page to the next.
 *  - diff: the file must be in the target's current list (one refresh first
 *    when it is not, then not_found). The parsed diff is cached per
 *    (key, path, staged) for DIFF_CACHE_MS, so every page of one read comes
 *    from one version. Any GitService run since the entry was read makes the
 *    next page read the diff again: an unchanged file keeps its `diffRev` and
 *    its pages, a changed one answers with a new `diffRev` and the phone starts
 *    over at page 0.
 *
 * The cwd and the repo root never leave main: summaries carry the chip fields,
 * files their repo-relative paths. Git runs at `remote` priority, so a phone
 * can hold at most one of the two git slots (gitExec) and the desktop chip
 * keeps refreshing while a phone reads. Rate and in-flight limits per session
 * live in SessionManager.
 */
import type { GitArea, GitDiffHunk, GitDiffLine, GitDiffRes, GitError, GitFileEntry, GitSummary } from '@shared/git-types'
import type { RemoteGitChanges, RemoteGitDiffPage, RemoteGitError, RemoteGitReply, RemoteGitRequest } from '@shared/remote-protocol'
import type { GitRunner } from '../git/gitExec'
import { findListed, readFileDiff, resolveRepoPath, withAreaCounts, type DiffFs } from '../git/diff'

/** The largest framed `gitRes` (CONTRATOS: frame <= 48KB). */
export const GIT_FRAME_MAX = 48 * 1024
/** A status older than this refreshes before answering (FR-22). */
export const STATUS_MAX_AGE_MS = 2000
/** Life of a cached diff / status snapshot (FR-23). */
export const DIFF_CACHE_MS = 60000
/** Answer `timeout` past these (FR-26). */
export const GIT_STATUS_TIMEOUT_MS = 10000
export const GIT_DIFF_TIMEOUT_MS = 15000
/** Cached diffs kept at once (oldest out first). */
export const DIFF_CACHE_MAX = 32
/** One diff line never weighs more than this once serialized (a minified file has 100KB lines). */
export const LINE_MAX_BYTES = 8 * 1024
/** Suffix of a line cut to LINE_MAX_BYTES. */
export const LINE_CUT_MARK = ' [...]'

/** Widest id the schema lets in (`^[A-Za-z0-9_-]{1,64}$`) and the highest page: the envelope's worst case. */
const WORST_ID = 'x'.repeat(64)
const WORST_PAGE = 999

/** What GitRemote needs from GitService. */
export interface GitRemoteSource {
  ensureFresh(key: string, maxAgeMs: number): Promise<{ summary: GitSummary | null; error?: GitError; files: GitFileEntry[] } | null>
  get(key: string): { summary: GitSummary | null; error?: GitError; files: GitFileEntry[] } | null
  markHot(key: string): void
}

type Handle = unknown
export interface GitRemoteTimers {
  setTimeout(fn: () => void, ms: number): Handle
  clearTimeout(h: Handle): void
}

export interface GitRemoteDeps {
  source: GitRemoteSource
  /** The app's runner; every call goes out at `remote` priority. */
  runner: Pick<GitRunner, 'run'>
  /** Cached untracked line count by absolute path (UntrackedCounter.peek). */
  untrackedPeek: (abs: string) => number | null | undefined
  fs?: DiffFs
  platform?: NodeJS.Platform
  now?: () => number
  timers?: GitRemoteTimers
}

const defaultTimers: GitRemoteTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

// ---- framing ------------------------------------------------------------------

/** UTF-8 bytes of a value as JSON. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Bytes of a `gitRes` frame around `data` with the widest id and page (the per-page fixed cost). */
function envelopeBytes(data: unknown): number {
  return jsonBytes({ v: 1, type: 'gitRes', id: WORST_ID, ok: true, data, page: WORST_PAGE, done: false })
}

/** A line cut so its JSON stays within `max` bytes (never splitting a surrogate pair). */
export function clampLine(line: GitDiffLine, max = LINE_MAX_BYTES): GitDiffLine {
  if (jsonBytes(line) <= max) return line
  let text = line.text
  while (text.length > 0) {
    const ratio = max / jsonBytes({ ...line, text: text + LINE_CUT_MARK })
    let cut = Math.floor(text.length * Math.min(0.95, ratio))
    if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--
    text = text.slice(0, cut)
    const next = { ...line, text: text + LINE_CUT_MARK }
    if (jsonBytes(next) <= max) return next
  }
  return { ...line, text: LINE_CUT_MARK.trim() }
}

/** The phone's summary: chip fields plus approx, conflicts and op. No repo root. */
export function remoteSummary(s: GitSummary): RemoteGitChanges['summary'] {
  const up = s.upstream !== null
  return {
    branch: s.branch ?? s.headShort,
    ahead: up ? s.ahead : 0,
    behind: up ? s.behind : 0,
    added: s.added,
    removed: s.removed,
    files: s.files,
    approx: s.approx,
    conflicts: s.conflicts,
    op: s.op,
  }
}

/**
 * Cut a change list into pages whose framed `gitRes` fits in `max` bytes.
 * Every page repeats the summary, `total` and `truncated`; there is always at
 * least one page (an empty list is one page without files).
 */
export function pageChanges(summary: RemoteGitChanges['summary'], files: readonly GitFileEntry[], truncated: boolean, max = GIT_FRAME_MAX): RemoteGitChanges[] {
  const base = { summary, total: files.length, truncated }
  const fixed = envelopeBytes({ ...base, files: [] })
  const pages: RemoteGitChanges[] = []
  let cur: GitFileEntry[] = []
  let used = fixed
  for (const f of files) {
    const b = jsonBytes(f) + 1
    if (cur.length && used + b > max) {
      pages.push({ ...base, files: cur })
      cur = []
      used = fixed
    }
    cur.push(f)
    used += b
  }
  pages.push({ ...base, files: cur })
  return pages
}

/**
 * Cut a parsed diff into pages whose framed `gitRes` fits in `max` bytes. A
 * hunk that does not fit goes on in the next page with the same header and
 * `continued: true`. A binary or too large diff is one page without hunks.
 */
export function pageDiff(diff: GitDiffRes, max = GIT_FRAME_MAX): RemoteGitDiffPage[] {
  const base: Omit<RemoteGitDiffPage, 'hunks'> = {
    path: diff.path,
    ...(diff.oldPath !== undefined ? { oldPath: diff.oldPath } : {}),
    area: diff.area,
    diffRev: diff.diffRev,
    binary: diff.binary,
    ...(diff.tooLarge ? { tooLarge: { lines: diff.tooLarge.lines } } : {}),
  }
  if (diff.binary || diff.tooLarge) return [{ ...base, hunks: [] }]
  const fixed = envelopeBytes({ ...base, hunks: [] })
  const pages: RemoteGitDiffPage[] = []
  let cur: GitDiffHunk[] = []
  let used = fixed
  const flush = (): void => {
    pages.push({ ...base, hunks: cur })
    cur = []
    used = fixed
  }
  for (const hunk of diff.hunks) {
    const head = { header: hunk.header, oldStart: hunk.oldStart, newStart: hunk.newStart }
    const hunkBytes = jsonBytes({ ...head, lines: [], continued: true }) + 1
    // Room for the header and at least one line, else the hunk starts on a fresh page.
    const lineCap = Math.max(256, Math.min(LINE_MAX_BYTES, max - fixed - hunkBytes - 16))
    const lines = hunk.lines.map((l) => clampLine(l, lineCap))
    const lineBytes = lines.map((l) => jsonBytes(l) + 1)
    const whole = hunkBytes + lineBytes.reduce((a, b) => a + b, 0)
    // A hunk that fits a page of its own is never split: it starts the next page whole.
    const fitsAlone = fixed + whole <= max
    if (cur.length && (fitsAlone ? used + whole > max : used + hunkBytes + (lineBytes[0] ?? 0) > max)) flush()
    let piece: GitDiffHunk = { ...head, lines: [], ...(hunk.continued ? { continued: true } : {}) }
    cur.push(piece)
    used += hunkBytes
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const b = lineBytes[i]
      if (used + b > max && piece.lines.length) {
        flush()
        piece = { ...head, lines: [], continued: true }
        cur.push(piece)
        used += hunkBytes
      }
      piece.lines.push(line)
      used += b
    }
  }
  flush()
  return pages
}

// ---- the service ----------------------------------------------------------------

interface StatusSnap {
  files: GitFileEntry[]
  at: number
  pages: RemoteGitChanges[]
}

interface DiffSnap {
  /** The listed array the diff was read against: another one means a run happened since. */
  files: GitFileEntry[]
  at: number
  pages: RemoteGitDiffPage[]
}

const fail = (error: RemoteGitError['error']): RemoteGitReply => ({ ok: false, data: { error }, page: 0, done: true })

/** Areas a diff without `staged` may come from, in order: the working tree first. */
const WORKTREE_AREAS: readonly GitArea[] = ['unstaged', 'conflict', 'untracked']

export class GitRemote {
  private readonly status = new Map<string, StatusSnap>()
  private readonly diffs = new Map<string, DiffSnap>()
  /** Area counts per listed array (its identity changes with every GitService run). */
  private readonly counts = new WeakMap<GitFileEntry[], Promise<GitFileEntry[]>>()
  private readonly runner: Pick<GitRunner, 'run'>
  private readonly now: () => number
  private readonly timers: GitRemoteTimers

  constructor(private readonly deps: GitRemoteDeps) {
    const base = deps.runner
    this.runner = { run: (args, opts) => base.run(args, { ...opts, priority: 'remote' }) }
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? defaultTimers
  }

  /** Answer one `gitReq`. Never throws: every failure is a RemoteGitError. */
  async handle(req: RemoteGitRequest): Promise<RemoteGitReply> {
    const key = `ws:${req.workspaceId}`
    const page = req.page ?? 0
    if (req.op === 'diff' && !req.path) return fail('not_found')
    this.deps.source.markHot(key)
    const work = req.op === 'status' ? this.statusPage(key, page) : this.diffPage(key, req.path as string, req.staged === true, page)
    const reply = await this.withTimeout(work, req.op === 'status' ? GIT_STATUS_TIMEOUT_MS : GIT_DIFF_TIMEOUT_MS)
    return reply
  }

  /** Drop every cached snapshot (the server stopped). */
  clear(): void {
    this.status.clear()
    this.diffs.clear()
  }

  private withTimeout(work: Promise<RemoteGitReply>, ms: number): Promise<RemoteGitReply> {
    return new Promise((resolve) => {
      let settled = false
      const timer = this.timers.setTimeout(() => {
        if (settled) return
        settled = true
        resolve(fail('timeout'))
      }, ms)
      work.then(
        (r) => r,
        () => fail('git_error'),
      ).then((r) => {
        if (settled) return
        settled = true
        this.timers.clearTimeout(timer)
        resolve(r)
      })
    })
  }

  // ---- status (FR-22) ---------------------------------------------------

  private async statusPage(key: string, page: number): Promise<RemoteGitReply> {
    const t = this.now()
    for (const [k, s] of this.status) if (t - s.at > DIFF_CACHE_MS) this.status.delete(k)
    let snap = this.status.get(key)
    if (page === 0 || !snap) {
      const view = await this.deps.source.ensureFresh(key, STATUS_MAX_AGE_MS)
      if (!view) return fail('not_found')
      if (!view.summary) return fail(view.error ?? 'git_error')
      if (snap && snap.files === view.files) {
        // No run since the snapshot: same list, same pages.
        snap.at = this.now()
      } else {
        const files = await this.areaCounts(view.summary.repoRoot, view.files)
        snap = { files: view.files, at: this.now(), pages: pageChanges(remoteSummary(view.summary), files, view.summary.truncated) }
        this.status.set(key, snap)
      }
    }
    return pick(snap.pages, page, (last) => ({ ...last, files: [] }))
  }

  private areaCounts(repoRoot: string, files: GitFileEntry[]): Promise<GitFileEntry[]> {
    let pending = this.counts.get(files)
    if (!pending) {
      pending = withAreaCounts(repoRoot, files, this.runner, (rel) => {
        const abs = resolveRepoPath(repoRoot, rel, this.deps.platform)
        return abs ? this.deps.untrackedPeek(abs) : undefined
      }).catch(() => files)
      this.counts.set(files, pending)
    }
    return pending
  }

  // ---- diff (FR-23) -----------------------------------------------------

  private async diffPage(key: string, path: string, staged: boolean, page: number): Promise<RemoteGitReply> {
    let view = this.deps.source.get(key) ?? (await this.deps.source.ensureFresh(key, STATUS_MAX_AGE_MS))
    if (!view) return fail('not_found')
    let entry = view.summary ? listedFor(view.files, path, staged) : null
    if (!entry) {
      // A file newer than the cached list: one refresh before not_found.
      view = await this.deps.source.ensureFresh(key, 0)
      if (!view) return fail('not_found')
      if (!view.summary) return fail(view.error ?? 'git_error')
      entry = listedFor(view.files, path, staged)
      if (!entry) return fail('not_found')
    }
    const summary = view.summary as GitSummary
    const cacheKey = `${key}\0${staged ? 's' : 'w'}\0${path}`
    const t = this.now()
    this.evictDiffs(t)
    let snap = this.diffs.get(cacheKey)
    const fresh = snap && snap.files === view.files && t - snap.at <= (page === 0 ? STATUS_MAX_AGE_MS : DIFF_CACHE_MS)
    if (!snap || !fresh) {
      const res = await readFileDiff({ repoRoot: summary.repoRoot, entry, force: false, runner: this.runner, fs: this.deps.fs, platform: this.deps.platform })
      if ('error' in res) {
        this.diffs.delete(cacheKey)
        // 'gone' (no changes left) and 'denied' (not a path main listed) both read as not_found.
        return fail(res.error === 'gone' || res.error === 'denied' ? 'not_found' : res.error)
      }
      snap = { files: view.files, at: this.now(), pages: pageDiff(res) }
    }
    this.diffs.delete(cacheKey)
    this.diffs.set(cacheKey, snap)
    while (this.diffs.size > DIFF_CACHE_MAX) this.diffs.delete(this.diffs.keys().next().value as string)
    return pick(snap.pages, page, (last) => ({ ...last, hunks: [] }))
  }

  private evictDiffs(t: number): void {
    for (const [k, s] of this.diffs) if (t - s.at > DIFF_CACHE_MS) this.diffs.delete(k)
  }
}

/** The listed entry a diff request means: `staged` reads the index, else the working tree. */
function listedFor(files: readonly GitFileEntry[], path: string, staged: boolean): GitFileEntry | null {
  if (staged) return findListed(files, path, 'staged')
  for (const area of WORKTREE_AREAS) {
    const hit = findListed(files, path, area)
    if (hit) return hit
  }
  return null
}

/**
 * Page `n` of a paged answer. Past the end it answers an empty last page with
 * `done: true` (a diff that shrank still tells its new diffRev).
 */
function pick<T extends RemoteGitChanges | RemoteGitDiffPage>(pages: T[], n: number, empty: (last: T) => T): RemoteGitReply {
  const last = pages.length - 1
  if (n > last) return { ok: true, data: empty(pages[last]), page: n, done: true }
  return { ok: true, data: pages[n], page: n, done: n === last }
}
