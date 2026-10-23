/**
 * Isolated worktree per console (E7-FR-27..32, FR-36; Design F). Main does
 * every disk and git step and never trusts the renderer:
 *  - create: `git worktree add --no-track -b sn/<slug> <root>/<repo>-<hash6>/<slug> <base>`,
 *    then the optional .env copy and node_modules junction, then the manifest
 *    entry. A failure rolls back only what this call created (flags set after
 *    each step succeeded); a pre-existing sn/<slug> branch is detected first
 *    and never touched.
 *  - remove: the path must be a manifest entry under a worktree root, listed by
 *    `git worktree list` on its branch sn/...; the pane's pty is killed first,
 *    the junctions are unlinked as links (any failure aborts before anything
 *    else), the folder goes through safeRemoveTree (never follows a link, the
 *    contract's primitive for this) with 5 retries of 400 ms, then
 *    `worktree prune` and a compare-and-delete of the branch
 *    (`update-ref -d refs/heads/<b> <tip>`). Once the pty is gone the state is
 *    read again against the inspect the caller sent (`expectTip`,
 *    `expectDirty`): an agent may have committed or written between the
 *    dialog opening and the click, and that is 'changed', never a silent loss.
 *  - inspect / list: read only.
 * Pattern after Orca's worktree-add.ts (--no-track -b, long path flag only on
 * add) and its junction-first docs; rewritten, no code copied.
 */
import { createHash } from 'crypto'
import { constants as fsConstants, promises as nodeFsp } from 'fs'
import { basename, dirname, isAbsolute, join, posix, resolve, sep, win32 } from 'path'
import {
  SHA_RE,
  WORKTREE_BRANCH_RE,
  isValidSlug,
  type WorktreeAddReq,
  type WorktreeAddRes,
  type WorktreeInProgress,
  type WorktreeInspectRes,
  type WorktreeListEntry,
  type WorktreeListRes,
  type WorktreeProbeRes,
  type WorktreeRemoveReq,
  type WorktreeRemoveRes,
} from '@shared/worktree-types'
import { canonicalPath, type RealpathFn } from './canonicalPath'
import { gitErrorCode, type GitRunner } from './gitExec'
import { parseStatusV2 } from './porcelain'
import type { ManifestEntry, WorktreeManifest } from './WorktreeManifest'
import { isInside, isSameOrInside, pathKey, samePath } from '../migration/pathUtil'
import { safeRemoveTree, type PathGuard, type RemoveOptions, type RemoveResult } from '../migration/safeRemove'

/** `worktree add` may check out a large tree. */
export const ADD_TIMEOUT_MS = 120_000
/** Per run timeout of the small git queries. */
export const QUERY_TIMEOUT_MS = 15_000
/** Total bytes the .env copy may move. */
export const ENV_COPY_MAX_BYTES = 50 * 1024 * 1024
export const ENV_FILES = ['.env', '.env.local'] as const
export const REMOVE_RETRIES = 5
export const REMOVE_RETRY_MS = 400
/** A full commit sha (SHA-1 or SHA-256): what inspect reports as `tip` and remove accepts as `expectTip`. */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
/** `git rev-parse --git-path` names whose presence means an operation was left half-done, in report order. */
export const IN_PROGRESS_PATHS: ReadonlyArray<readonly [string, WorktreeInProgress]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
]
const STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--untracked-files=normal']

export type WorktreeFs = Pick<typeof nodeFsp, 'lstat' | 'stat' | 'mkdir' | 'copyFile' | 'symlink' | 'unlink' | 'rmdir' | 'readdir' | 'readFile'>

export interface WorktreeServiceDeps {
  runner: GitRunner
  manifest: WorktreeManifest
  /** settings.worktreesRoot when set, else the default root. */
  root: () => string
  /** dataDir()/worktrees. */
  defaultRoot: () => string
  fs?: WorktreeFs
  /** Exact paths, contained paths (data folder, exe folder) the removal must never touch. allowedRoots is set per call. */
  guard?: () => Omit<PathGuard, 'allowedRoots'>
  /** Kill the pane's pty and wait for it to exit (at most 3 s). */
  killPane?: (paneId: string) => Promise<void>
  /** Test seam over safeRemoveTree. */
  removeTree?: (target: string, guard: PathGuard, o: RemoveOptions) => Promise<RemoveResult>
  removeOptions?: RemoveOptions
  now?: () => number
  /** Test seam over fs.realpathSync.native (see canonicalPath). */
  realpath?: RealpathFn
}

type Fail<E extends string> = { ok: false; error: E; detail?: string }

class StepError extends Error {
  constructor(
    readonly error: Exclude<WorktreeAddRes, { ok: true }>['error'],
    readonly detail?: string,
  ) {
    super(detail ?? error)
  }
}

function errCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : 'error'
}

/** Path functions of a platform; a host path always uses the host's own flavor. */
function flavor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** pathKey in the platform's own path flavor: resolved, no trailing separator, lower-cased where the filesystem folds case. */
function flavorKey(p: string, platform: NodeJS.Platform): string {
  const P = flavor(platform)
  let r = P.resolve(p)
  if (r.length > 1 && r.endsWith(P.sep) && !/^[A-Za-z]:\\$/.test(r)) r = r.slice(0, -1)
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r
}

/**
 * `<repo name>-<hash6>`: a stable folder per repo, readable and collision
 * free. The repo is first brought to git's spelling (canonicalPath), so an
 * 8.3 short name, a junction or /var vs /private/var give the same folder.
 * The repo root always comes from git on this machine; `platform` only lets a
 * test name another OS's path, which is then taken as written.
 */
export function repoFolderName(repoRoot: string, opts: { platform?: NodeJS.Platform; realpath?: RealpathFn } = {}): string {
  const platform = opts.platform ?? process.platform
  const P = flavor(platform)
  const full = platform === process.platform ? canonicalPath(repoRoot, opts.realpath) : P.resolve(repoRoot)
  const name = P.basename(full).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 40) || 'repo'
  const hash = createHash('sha1').update(flavorKey(full, platform)).digest('hex').slice(0, 6)
  return `${name}-${hash}`
}

/** `git worktree list --porcelain` -> path + branch (refs/heads/... or null when detached). */
export function parseWorktreeList(out: string): Array<{ path: string; branch: string | null; prunable: boolean }> {
  const res: Array<{ path: string; branch: string | null; prunable: boolean }> = []
  let cur: { path: string; branch: string | null; prunable: boolean } | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) res.push(cur)
      cur = { path: line.slice('worktree '.length), branch: null, prunable: false }
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice('branch '.length)
    else if (cur && line.startsWith('prunable')) cur.prunable = true
    else if (line === '' && cur) {
      res.push(cur)
      cur = null
    }
  }
  if (cur) res.push(cur)
  return res
}

/** `gitdir: <common>/worktrees/<name>` of a linked worktree's `.git` file -> the main checkout, or null. */
export function repoRootFromGitFile(content: string, worktreePath: string, platform: NodeJS.Platform = process.platform): string | null {
  const P = flavor(platform)
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content)
  if (!m) return null
  // Walked with dirname, not split and joined: a UNC prefix (\\server\share) keeps both slashes.
  const admin = P.dirname(P.resolve(worktreePath, m[1]))
  if (P.basename(admin) !== 'worktrees') return null
  const common = P.dirname(admin)
  if (common === admin || P.basename(common).toLowerCase() !== '.git') return null
  return P.dirname(common)
}

export class WorktreeService {
  private readonly fsx: WorktreeFs
  private chain: Promise<unknown> = Promise.resolve()
  /**
   * pathKey of the worktrees whose folder delete started and stopped half-way
   * ('busy'): their Retry is judged by recheck's `partial` rule. Memory only:
   * after a restart (or from another process) the folder left behind is judged
   * by the plain check, and one git no longer reads as its own checkout (its
   * `.git` went first) is deleted only with the user's `ackIncomplete` (inspect
   * reports it `noCheckout`, the dialog asks for the checkbox), else 'changed'.
   */
  private readonly partial = new Set<string>()

  constructor(private readonly deps: WorktreeServiceDeps) {
    this.fsx = deps.fs ?? nodeFsp
  }

  /** Create and remove never overlap (two creates of one slug, a remove racing a create). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private git(args: string[], cwd: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<string> {
    return this.deps.runner.run(args, { cwd, timeoutMs })
  }

  /** git exits 0: true. Any failure: false. */
  private async gitOk(args: string[], cwd: string): Promise<boolean> {
    try {
      await this.git(args, cwd)
      return true
    } catch {
      return false
    }
  }

  /**
   * git's spelling of a path (canonicalPath). Every path that comes from the
   * user, the settings or the renderer goes through it before it is compared
   * with a path git printed or the manifest holds.
   */
  private canon(p: string): string {
    return canonicalPath(p, this.deps.realpath)
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await this.fsx.lstat(p)
      return true
    } catch (e) {
      return errCode(e) !== 'ENOENT'
    }
  }

  /**
   * The main checkout of the repo `cwd` belongs to: a linked worktree (a
   * "Duplicate in worktree" from a worktree pane) resolves to its repo, so the
   * new folder lands beside the others and the manifest names the real repo.
   */
  private async resolveRepo(cwd: string): Promise<string> {
    const top = this.canon((await this.git(['rev-parse', '--show-toplevel'], cwd)).trim())
    // Not canon() on .git itself: a .git that is a link must still read as .git.
    const common = resolve(top, (await this.git(['rev-parse', '--git-common-dir'], top)).trim())
    if (basename(common).toLowerCase() !== '.git') return top
    return this.canon(dirname(common))
  }

  private rootsFor(entry: ManifestEntry | null): string[] {
    const roots = [this.deps.root(), this.deps.defaultRoot()]
    if (entry?.root) roots.push(entry.root)
    return roots.filter(Boolean).map((r) => this.canon(r))
  }

  /** Exactly `<root>/<repo>-<hash>/<slug>` under one of the roots, or null. */
  private rootOf(path: string, roots: string[]): string | null {
    for (const r of roots) {
      if (!isInside(path, r)) continue
      // Counted on the keys isInside compared: relative() is case-sensitive on macOS.
      const rel = pathKey(path).slice(pathKey(r).length).split(sep).filter(Boolean)
      if (rel.length === 2) return r
    }
    return null
  }

  async probe(repoCwd: unknown): Promise<WorktreeProbeRes> {
    if (typeof repoCwd !== 'string' || !isAbsolute(repoCwd)) return { ok: false, error: 'not_repo' }
    let repoRoot: string
    try {
      repoRoot = await this.resolveRepo(repoCwd)
    } catch (e) {
      return { ok: false, error: gitErrorCode(e) === 'not_repo' ? 'not_repo' : 'git_error' }
    }
    try {
      const head = (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], repoRoot)).trim()
      if (!SHA_RE.test(head)) return { ok: false, error: 'unborn' }
      return { ok: true, repoName: basename(repoRoot), head, headShort: head.slice(0, 7) }
    } catch {
      return { ok: false, error: 'unborn' }
    }
  }

  create(req: unknown): Promise<WorktreeAddRes> {
    return this.serial(() => this.createNow(req))
  }

  private async createNow(raw: unknown): Promise<WorktreeAddRes> {
    const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorktreeAddReq>
    if (!isValidSlug(req.slug)) return { ok: false, error: 'bad_slug' }
    if (typeof req.repoCwd !== 'string' || !isAbsolute(req.repoCwd)) return { ok: false, error: 'not_repo' }
    if (req.base !== undefined && (typeof req.base !== 'string' || !SHA_RE.test(req.base))) return { ok: false, error: 'git_error', detail: 'bad_base' }
    const slug = req.slug
    const branch = `sn/${slug}`

    let repoRoot: string
    try {
      repoRoot = await this.resolveRepo(req.repoCwd)
    } catch (e) {
      const c = gitErrorCode(e)
      return c === 'not_repo' ? { ok: false, error: 'not_repo' } : { ok: false, error: c === 'timeout' ? 'timeout' : 'git_error', detail: c }
    }
    // Both in git's spelling: a root typed through an 8.3 name or a link still counts as inside the repo.
    const root = this.canon(this.deps.root())
    if (isSameOrInside(root, repoRoot)) return { ok: false, error: 'root_inside_repo' }

    let baseSha: string
    try {
      baseSha = (await this.git(['rev-parse', '--verify', '--quiet', `${req.base ?? 'HEAD'}^{commit}`], repoRoot)).trim()
    } catch {
      baseSha = ''
    }
    if (!SHA_RE.test(baseSha)) return req.base ? { ok: false, error: 'git_error', detail: 'bad_base' } : { ok: false, error: 'unborn' }

    if (!(await this.gitOk(['check-ref-format', '--branch', branch], repoRoot))) return { ok: false, error: 'bad_slug' }
    if (await this.gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)) return { ok: false, error: 'branch_exists' }

    const path = join(root, repoFolderName(repoRoot), slug)
    if (await this.exists(path)) return { ok: false, error: 'path_exists' }

    let createdWorktree = false
    let createdBranch = false
    const createdJunctions: string[] = []
    try {
      await this.fsx.mkdir(dirname(path), { recursive: true })
      try {
        await this.git(['-c', 'core.longpaths=true', 'worktree', 'add', '--no-track', '-b', branch, path, baseSha], repoRoot, ADD_TIMEOUT_MS)
      } catch (e) {
        // git cleans up after itself, but a half-done add may leave the branch
        // or the folder: both did not exist a moment ago, so they are ours.
        createdBranch = await this.gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
        createdWorktree = await this.exists(path)
        const c = gitErrorCode(e)
        throw new StepError(c === 'timeout' ? 'timeout' : 'git_error', (e as Error).message)
      }
      createdWorktree = true
      createdBranch = true

      if (req.copyEnv === true) await this.copyEnv(repoRoot, path)
      if (req.linkNodeModules === true) {
        const target = join(repoRoot, 'node_modules')
        const link = join(path, 'node_modules')
        let isDir = false
        try {
          isDir = (await this.fsx.stat(target)).isDirectory()
        } catch {
          isDir = false
        }
        if (isDir && !(await this.exists(link))) {
          await this.fsx.symlink(target, link, 'junction')
          createdJunctions.push(link)
        }
      }

      this.deps.manifest.put({
        path,
        branch,
        repoRoot,
        baseRef: req.base ?? 'HEAD',
        baseSha,
        linkedPaths: createdJunctions,
        root,
        createdAt: (this.deps.now ?? Date.now)(),
      })
      return { ok: true, worktree: { repoRoot, path, branch, base: baseSha } }
    } catch (e) {
      await this.rollback({ repoRoot, path, branch, root, createdWorktree, createdBranch, createdJunctions })
      if (e instanceof StepError) return { ok: false, error: e.error, ...(e.detail ? { detail: e.detail } : {}) }
      return { ok: false, error: 'git_error', detail: (e as Error)?.message ?? String(e) }
    }
  }

  /** `.env` / `.env.local` of the repo, only untracked regular files, 50 MB in total. */
  private async copyEnv(repoRoot: string, path: string): Promise<void> {
    let budget = ENV_COPY_MAX_BYTES
    for (const name of ENV_FILES) {
      const src = join(repoRoot, name)
      let size: number
      try {
        const st = await this.fsx.lstat(src)
        if (!st.isFile()) continue
        size = st.size
      } catch {
        continue
      }
      if (size > budget) continue
      // Tracked: already checked out in the worktree.
      if (await this.gitOk(['ls-files', '--error-unmatch', '--', name], repoRoot)) continue
      const dest = join(path, name)
      if (await this.exists(dest)) continue
      await this.fsx.copyFile(src, dest, fsConstants.COPYFILE_EXCL)
      budget -= size
    }
  }

  private async rollback(s: { repoRoot: string; path: string; branch: string; root: string; createdWorktree: boolean; createdBranch: boolean; createdJunctions: string[] }): Promise<void> {
    for (const link of [...s.createdJunctions].reverse()) await this.unlinkLink(link).catch(() => undefined)
    if (s.createdWorktree) {
      await this.removeTree(s.path, s.root).catch(() => undefined)
      await this.git(['worktree', 'prune'], s.repoRoot).catch(() => undefined)
    }
    if (s.createdBranch) await this.git(['branch', '-D', s.branch], s.repoRoot).catch(() => undefined)
  }

  /** A link (junction or symlink) removed as a link: unlink, rmdir for a directory junction. Never recursive. */
  private async unlinkLink(p: string): Promise<void> {
    try {
      await this.fsx.unlink(p)
    } catch (e) {
      const c = errCode(e)
      if (c === 'ENOENT') return
      if (c === 'EPERM' || c === 'EISDIR') await this.fsx.rmdir(p)
      else throw e
    }
  }

  private removeTree(target: string, root: string): Promise<RemoveResult> {
    const base = this.deps.guard?.() ?? { forbiddenExact: [], forbiddenTree: [], forbiddenContain: [] }
    const guard: PathGuard = { ...base, allowedRoots: [root] }
    const opts: RemoveOptions = { retries: REMOVE_RETRIES, delayMs: REMOVE_RETRY_MS, ...this.deps.removeOptions }
    return (this.deps.removeTree ?? safeRemoveTree)(target, guard, opts)
  }

  async inspect(raw: unknown): Promise<WorktreeInspectRes> {
    const req = (raw && typeof raw === 'object' ? raw : {}) as { path?: unknown; base?: unknown }
    const empty: WorktreeInspectRes = { exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }
    if (typeof req.path !== 'string' || !isAbsolute(req.path)) return empty
    const path = this.canon(req.path)
    let present: boolean
    try {
      present = (await this.fsx.stat(path)).isDirectory()
    } catch {
      present = false
    }
    const entry = this.deps.manifest.find(path)
    const recorded = entry && WORKTREE_BRANCH_RE.test(entry.branch) ? entry : null
    const base = entry?.baseSha || (typeof req.base === 'string' && SHA_RE.test(req.base) ? req.base : '')
    if (!present) {
      // Gone by hand (FR-36): its branch can still be deleted, and that delete
      // compares against this tip. The commits it would drop are read in the
      // repo, so the dialog asks for the checkbox as for a live folder.
      const tip = recorded ? await this.branchTip(recorded.repoRoot, recorded.branch) : ''
      return recorded && tip ? { ...empty, ...(await this.branchLoss(recorded.repoRoot, tip, base)), tip } : empty
    }
    if (!(await this.isOwnCheckout(path))) {
      // On disk but no longer this worktree for git: its `.git` went (a delete
      // that stopped half-way, by hand). Never "gone": what is left (and what
      // was written since) cannot be counted, so it is unknown work, the
      // dialog asks for the checkbox and the delete needs `ackIncomplete`.
      // The branch side is read in the repo, as for a gone folder.
      const tip = recorded ? await this.branchTip(recorded.repoRoot, recorded.branch) : ''
      const loss = recorded && tip ? await this.branchLoss(recorded.repoRoot, tip, base) : null
      return {
        exists: true,
        dirtyFiles: 0,
        commitsAhead: loss?.commitsAhead ?? 0,
        mergedIntoHead: loss?.mergedIntoHead ?? false,
        incomplete: true,
        noCheckout: true,
        ...(tip ? { tip } : {}),
      }
    }
    // A step git could not answer must never read as "nothing to lose": the
    // close dialog then asks for the checkbox anyway (FR-30).
    let incomplete = false
    let dirtyFiles = 0
    // Kept apart from `incomplete` (which a missing base also sets): a real
    // count is sent back as expectDirty even when another step failed.
    let dirtyRead = true
    try {
      dirtyFiles = await this.dirtyCount(path, entry)
    } catch {
      dirtyFiles = 0
      incomplete = true
      dirtyRead = false
    }
    let commitsAhead = 0
    if (base) {
      try {
        commitsAhead = Number((await this.git(['rev-list', '--count', `${base}..HEAD`], path)).trim()) || 0
      } catch {
        commitsAhead = 0
        incomplete = true
      }
    }
    let mergedIntoHead = false
    const repoRoot = entry?.repoRoot
    if (repoRoot && WORKTREE_BRANCH_RE.test(entry.branch)) {
      mergedIntoHead = await this.gitOk(['merge-base', '--is-ancestor', `refs/heads/${entry.branch}`, 'HEAD'], repoRoot)
    }
    // Without a base the commits over it are unknown, unless the branch is merged.
    if (!base && !mergedIntoHead) incomplete = true
    // The tip a delete compares against: the recorded branch, else whatever the folder has checked out.
    let tip = recorded ? await this.branchTip(recorded.repoRoot, recorded.branch) : ''
    if (!recorded) {
      try {
        tip = (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], path)).trim()
      } catch {
        tip = ''
      }
    }
    let headBranch: string | undefined
    try {
      const sym = (await this.git(['rev-parse', '--symbolic-full-name', 'HEAD'], path)).trim()
      headBranch = sym.startsWith('refs/heads/') ? sym.slice('refs/heads/'.length) : ''
    } catch {
      incomplete = true
    }
    let inProgress: WorktreeInProgress | null = null
    try {
      inProgress = await this.inProgressOf(path)
    } catch {
      incomplete = true
    }
    return {
      exists: true,
      dirtyFiles,
      commitsAhead,
      mergedIntoHead,
      ...(incomplete ? { incomplete: true } : {}),
      ...(incomplete && dirtyRead ? { dirtyRead: true } : {}),
      ...(FULL_SHA_RE.test(tip) ? { tip } : {}),
      ...(headBranch !== undefined ? { headBranch } : {}),
      ...(inProgress ? { inProgress } : {}),
    }
  }

  /**
   * Uncommitted files of a worktree; our own node_modules junction is not the
   * user's work. Throws when git cannot read it. `skipDeleted` leaves out the
   * paths whose only change is a deletion in the folder (unstaged 'D'): what
   * a half-done delete of our own leaves behind, never new work.
   */
  private async dirtyCount(path: string, entry: ManifestEntry | null, skipDeleted = false): Promise<number> {
    const st = parseStatusV2(await this.git(STATUS_ARGS, path))
    const linked = new Set((entry?.linkedPaths ?? []).map((p) => basename(p)))
    const kept = skipDeleted ? st.entries.filter((e) => !(e.area === 'unstaged' && e.status === 'D')) : st.entries
    return new Set(kept.map((e) => e.path.replace(/\/$/, '')).filter((p) => !linked.has(p))).size
  }

  /**
   * The operation left half-done in a worktree, or null. `--git-path` names
   * the per-worktree admin file (relative to the folder for a main checkout,
   * absolute for a linked one); its existence is the signal. Throws when git
   * cannot answer.
   */
  private async inProgressOf(path: string): Promise<WorktreeInProgress | null> {
    const out = await this.git(['rev-parse', ...IN_PROGRESS_PATHS.flatMap(([name]) => ['--git-path', name])], path)
    const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length !== IN_PROGRESS_PATHS.length) throw new Error('git_path')
    for (let i = 0; i < lines.length; i++) {
      if (await this.exists(resolve(path, lines[i].trim()))) return IN_PROGRESS_PATHS[i][1]
    }
    return null
  }

  /** Full sha of refs/heads/<branch> in the repo, '' when it does not resolve. */
  private async branchTip(repoRoot: string, branch: string): Promise<string> {
    try {
      const sha = (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], repoRoot)).trim()
      return FULL_SHA_RE.test(sha) ? sha.toLowerCase() : ''
    } catch {
      return ''
    }
  }

  /**
   * The inspect fields of a branch whose folder is gone, read in the repo:
   * commits from `base` to `tip` and whether `tip` is in the repo HEAD.
   * Without a base (or when git cannot count) and not merged it is incomplete.
   */
  private async branchLoss(repoRoot: string, tip: string, base: string): Promise<Pick<WorktreeInspectRes, 'commitsAhead' | 'mergedIntoHead' | 'incomplete'>> {
    const mergedIntoHead = await this.gitOk(['merge-base', '--is-ancestor', tip, 'HEAD'], repoRoot)
    let commitsAhead = 0
    let incomplete = !base && !mergedIntoHead
    if (base) {
      try {
        commitsAhead = Number((await this.git(['rev-list', '--count', `${base}..${tip}`], repoRoot)).trim()) || 0
      } catch {
        incomplete = !mergedIntoHead
      }
    }
    return { commitsAhead, mergedIntoHead, ...(incomplete ? { incomplete: true } : {}) }
  }

  /** Deleting the branch at `tip` drops commits: not in the repo HEAD and over the recorded base (unknown counts as lost). */
  private async losesCommits(entry: ManifestEntry, tip: string): Promise<boolean> {
    if (await this.gitOk(['merge-base', '--is-ancestor', tip, 'HEAD'], entry.repoRoot)) return false
    if (!entry.baseSha) return true
    try {
      return Number((await this.git(['rev-list', '--count', `${entry.baseSha}..${tip}`], entry.repoRoot)).trim()) !== 0
    } catch {
      return true
    }
  }

  /**
   * The state the delete may remove, read once the pane's shell is gone (an
   * agent may commit or write between the inspect the user saw and the
   * click). Returns the tip the branch delete compares against, or why it is
   * 'changed':
   *  - `expectTip` (with deleteBranch): the branch must still point there, else 'tip'.
   *  - `expectDirty`: more uncommitted files is 'dirty', an unreadable count 'unreadable'.
   *  - an operation started since is 'in_progress'.
   *  - neither expectation (a caller that never inspected: an older renderer,
   *    a future CLI or phone path): main confirms nothing on the user's behalf,
   *    so the delete goes on only when it loses no work, as the dialog would
   *    without its checkbox: no uncommitted file, no unreadable state and,
   *    with the branch, no commit outside the base and the repo HEAD; else
   *    'unconfirmed'. With `expectTip` alone (the dialog after an inspect git
   *    could not fully read, whose checkbox the user ticked) the files are not
   *    counted again; without `expectTip` the commits get the same check.
   *  - a retry after our own delete stopped half-way ('busy', see `partial`):
   *    the folder is no longer a checkout to judge. Every tracked file that
   *    delete already removed reads as a deletion, and the `.git` file may be
   *    gone too (it sorts early), so a plain re-count would answer 'dirty' or
   *    'unreadable' on every Retry. The tip is still compared (read in the
   *    repo, not in the folder). While the folder is still its own checkout
   *    the files are counted without the deletions (new or modified files
   *    still are 'dirty': a delete only removes); once git no longer resolves
   *    the folder to itself nothing there can be read as this worktree (git
   *    would answer for no repo or for a parent one), so files and operations
   *    are not re-checked: the user confirmed this delete and main passed this
   *    same check before removing anything. Ignoring deletions is never
   *    applied outside that retry, where an agent's own deletions count.
   *  - a folder git no longer reads as its own checkout without that record (a
   *    restart after 'busy', a `.git` removed by hand): nothing there can be
   *    counted, and whatever is left (or written since) would go unseen, so it
   *    is 'unreadable' unless the user ticked "may lose work" on an inspect
   *    that said so (`ackIncomplete`); then files and operations are not
   *    re-checked (there is nothing git can read) and the tip still is.
   */
  private async recheck(entry: ManifestEntry, path: string, onDisk: boolean, req: { expectTip: string | null; expectDirty: number | null; deleteBranch: boolean; ackIncomplete: boolean }, partial = false): Promise<{ tip: string } | { changed: string }> {
    const legacy = req.expectTip === null && req.expectDirty === null
    const own = onDisk && (await this.isOwnCheckout(path))
    if (onDisk && !own && !partial && !req.ackIncomplete) return { changed: 'unreadable' }
    // Only a folder git reads as this worktree is re-counted (a parent repo would answer for another one).
    if (own) {
      let op: WorktreeInProgress | null = null
      let opKnown = true
      try {
        op = await this.inProgressOf(path)
      } catch {
        opKnown = false
      }
      if (op) return { changed: 'in_progress' }
      if (!opKnown && legacy) return { changed: 'unreadable' }
      if (req.expectDirty !== null || legacy) {
        let dirty: number
        try {
          dirty = await this.dirtyCount(path, entry, partial)
        } catch {
          return { changed: 'unreadable' }
        }
        if (dirty > (req.expectDirty ?? 0)) return { changed: req.expectDirty !== null ? 'dirty' : 'unconfirmed' }
      }
    }
    if (!req.deleteBranch) return { tip: '' }
    const tip = await this.branchTip(entry.repoRoot, entry.branch)
    // No branch left: nothing to lose and nothing to delete.
    if (!tip) return { tip: '' }
    if (req.expectTip !== null) return tip === req.expectTip ? { tip } : { changed: 'tip' }
    return (await this.losesCommits(entry, tip)) ? { changed: 'unconfirmed' } : { tip }
  }

  /** git resolves `path` to itself (its own `.git` is still there), not to no repo or a parent one. */
  private async isOwnCheckout(path: string): Promise<boolean> {
    try {
      const top = (await this.git(['rev-parse', '--show-toplevel'], path)).trim()
      return top !== '' && samePath(this.canon(top), path)
    } catch {
      return false
    }
  }

  /**
   * The app's own branch, compare-and-delete: only while no worktree has it
   * checked out (update-ref, unlike `branch -D`, would not refuse) and only
   * while it still points at `tip`, so a commit landing after the recheck
   * keeps the branch.
   */
  private async deleteBranchAt(entry: ManifestEntry, tip: string): Promise<WorktreeRemoveRes> {
    let list: Array<{ path: string; branch: string | null; prunable: boolean }>
    try {
      list = await this.listed(entry.repoRoot)
    } catch (e) {
      return { ok: false, error: 'git_error', detail: gitErrorCode(e) }
    }
    if (list.some((w) => w.branch === `refs/heads/${entry.branch}`)) return { ok: false, error: 'git_error', detail: 'checked_out' }
    try {
      await this.git(['update-ref', '-d', `refs/heads/${entry.branch}`, tip], entry.repoRoot)
    } catch (e) {
      const now = await this.branchTip(entry.repoRoot, entry.branch)
      if (now && now !== tip) return { ok: false, error: 'changed', detail: 'tip_after_delete' }
      return { ok: false, error: 'git_error', detail: (e as Error).message }
    }
    return { ok: true }
  }

  private async listed(repoRoot: string): Promise<Array<{ path: string; branch: string | null; prunable: boolean }>> {
    return parseWorktreeList(await this.git(['worktree', 'list', '--porcelain'], repoRoot))
  }

  remove(req: unknown): Promise<WorktreeRemoveRes> {
    return this.serial(() => this.removeNow(req))
  }

  private async removeNow(raw: unknown): Promise<WorktreeRemoveRes> {
    const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorktreeRemoveReq>
    const notManaged = (detail: string): Fail<'not_managed'> => ({ ok: false, error: 'not_managed', detail })
    if (typeof req.path !== 'string' || !isAbsolute(req.path)) return notManaged('path')
    const path = this.canon(req.path)
    const entry = this.deps.manifest.find(path)
    if (!entry) return notManaged('manifest')
    const root = this.rootOf(path, this.rootsFor(entry))
    if (!root) return notManaged('root')
    if (!WORKTREE_BRANCH_RE.test(entry.branch)) return notManaged('branch')
    const deleteBranch = req.deleteBranch === true
    // What the caller's inspect showed (optional, validated like any payload).
    if (req.expectTip !== undefined && (typeof req.expectTip !== 'string' || !FULL_SHA_RE.test(req.expectTip))) return { ok: false, error: 'git_error', detail: 'bad_expect' }
    if (req.expectDirty !== undefined && (typeof req.expectDirty !== 'number' || !Number.isInteger(req.expectDirty) || req.expectDirty < 0)) return { ok: false, error: 'git_error', detail: 'bad_expect' }
    if (req.ackIncomplete !== undefined && typeof req.ackIncomplete !== 'boolean') return { ok: false, error: 'git_error', detail: 'bad_expect' }
    const expect = { expectTip: req.expectTip?.toLowerCase() ?? null, expectDirty: req.expectDirty ?? null, deleteBranch, ackIncomplete: req.ackIncomplete === true }

    let list: Array<{ path: string; branch: string | null; prunable: boolean }>
    try {
      list = await this.listed(entry.repoRoot)
    } catch (e) {
      return { ok: false, error: 'git_error', detail: gitErrorCode(e) }
    }
    const row = list.find((w) => samePath(this.canon(w.path), path))
    const onDisk = await this.exists(path)
    const key = pathKey(path)
    // Without a folder there is nothing half-deleted left to judge.
    if (!onDisk) this.partial.delete(key)
    if (!row) {
      // Gone by hand and already pruned: nothing on disk to delete, only the
      // record and (asked for) the app's own branch, if no worktree has it out.
      if (onDisk) return notManaged('not_listed')
      if (deleteBranch) {
        const state = await this.recheck(entry, path, false, expect)
        if ('changed' in state) return { ok: false, error: 'changed', detail: state.changed }
        if (state.tip) {
          const del = await this.deleteBranchAt(entry, state.tip)
          // A branch checked out elsewhere stays, as before; a moved one is the caller's to see.
          if (!del.ok && del.error === 'changed') return del
        }
      }
      this.deps.manifest.remove(path)
      return { ok: true }
    }
    if (row.branch !== `refs/heads/${entry.branch}`) return notManaged('branch_mismatch')

    // Every recorded link must still be a link, directly inside the worktree.
    for (const link of entry.linkedPaths) {
      // The folder holding the link, never the link itself: canon() would follow it.
      if (!samePath(this.canon(dirname(resolve(link))), path)) return notManaged('linked_path')
      try {
        if (!(await this.fsx.lstat(link)).isSymbolicLink()) return notManaged('linked_path')
      } catch (e) {
        if (errCode(e) !== 'ENOENT') return notManaged('linked_path')
      }
    }

    if (typeof req.paneId === 'string' && req.paneId && this.deps.killPane) {
      await this.deps.killPane(req.paneId).catch(() => undefined)
    }

    // Read again now that nothing writes there any more: the inspect behind the click may be stale.
    const state = await this.recheck(entry, path, onDisk, expect, this.partial.has(key))
    if ('changed' in state) return { ok: false, error: 'changed', detail: state.changed }

    for (const link of entry.linkedPaths) {
      try {
        await this.unlinkLink(link)
      } catch (e) {
        return { ok: false, error: 'unlink_failed', detail: errCode(e) }
      }
    }

    if (onDisk) {
      const res = await this.removeTree(path, root)
      if (typeof res === 'object' && 'deferred' in res) {
        // safeRemoveTree goes on past a locked entry: what it could delete is gone.
        this.partial.add(key)
        return { ok: false, error: 'busy', detail: res.deferred }
      }
      if (typeof res === 'object' && 'skipped' in res) return notManaged(res.skipped)
      this.partial.delete(key)
    }
    // The folder is gone: prune drops git's record of it.
    await this.git(['worktree', 'prune'], entry.repoRoot).catch(() => undefined)
    if (deleteBranch && state.tip) {
      // On failure the entry stays: a retry takes the "gone" path above.
      const del = await this.deleteBranchAt(entry, state.tip)
      if (!del.ok) return del
    }
    this.deps.manifest.remove(path)
    return { ok: true }
  }

  /** Revealing a folder is only offered for one the manifest knows. */
  isManaged(path: unknown): path is string {
    return typeof path === 'string' && isAbsolute(path) && this.deps.manifest.find(path) != null
  }

  /**
   * Manifest entries plus a scan of `<root>/*\/*` (FR-31). A scanned folder
   * the manifest lacks is adopted only when git lists it on an sn/ branch;
   * anything else shows as unmanaged and can never be deleted from here.
   */
  async list(): Promise<WorktreeListRes> {
    const out = new Map<string, WorktreeListEntry>()
    const roots = new Map(this.rootsFor(null).map((r) => [pathKey(r), r]))
    for (const root of roots.values()) {
      let repos: string[] = []
      try {
        repos = (await this.fsx.readdir(root)).map(String)
      } catch {
        continue
      }
      for (const repoDir of repos) {
        let slugs: string[] = []
        try {
          slugs = (await this.fsx.readdir(join(root, repoDir))).map(String)
        } catch {
          continue
        }
        for (const slug of slugs) {
          const path = join(root, repoDir, slug)
          if (this.deps.manifest.find(path)) continue
          let content: string
          try {
            const st = await this.fsx.lstat(join(path, '.git'))
            if (!st.isFile()) continue
            content = String(await this.fsx.readFile(join(path, '.git'), 'utf8'))
          } catch {
            continue
          }
          const repoRoot = repoRootFromGitFile(content, path)
          if (!repoRoot) continue
          await this.adopt(path, this.canon(repoRoot), root, out)
        }
      }
    }
    for (const e of this.deps.manifest.list()) {
      const exists = await this.exists(e.path)
      out.set(pathKey(this.canon(e.path)), {
        path: e.path,
        branch: e.branch,
        repoName: basename(e.repoRoot),
        dirty: exists ? await this.isDirty(e) : null,
        managed: true,
        exists,
        repoRoot: e.repoRoot,
        ...(e.baseSha ? { base: e.baseSha } : {}),
      })
    }
    return { entries: [...out.values()] }
  }

  private async adopt(path: string, repoRoot: string, root: string, out: Map<string, WorktreeListEntry>): Promise<void> {
    let row: { path: string; branch: string | null } | undefined
    try {
      row = (await this.listed(repoRoot)).find((w) => samePath(this.canon(w.path), path))
    } catch {
      row = undefined
    }
    const branch = row?.branch?.startsWith('refs/heads/') ? row.branch.slice('refs/heads/'.length) : ''
    if (!row || !WORKTREE_BRANCH_RE.test(branch)) {
      out.set(pathKey(path), { path, branch: branch || '?', repoName: basename(repoRoot), dirty: null, managed: false, exists: true })
      return
    }
    let baseSha = ''
    try {
      baseSha = (await this.git(['merge-base', `refs/heads/${branch}`, 'HEAD'], repoRoot)).trim()
    } catch {
      baseSha = ''
    }
    this.deps.manifest.put({
      path,
      branch,
      repoRoot,
      baseRef: 'HEAD',
      baseSha: SHA_RE.test(baseSha) ? baseSha : '',
      linkedPaths: [],
      root,
      createdAt: (this.deps.now ?? Date.now)(),
    })
  }

  private async isDirty(e: ManifestEntry): Promise<boolean | null> {
    try {
      return (await this.dirtyCount(e.path, e)) > 0
    } catch {
      return null
    }
  }
}
