/**
 * The worktree of a team task (app 2.7.0, E10 B4, design 3.6, decisions 24,
 * 62 and 63): created at the task's first run when its assignee's role
 * writes, through the console worktree service, tagged in the shared manifest
 * with the task's owner (`team:<teamId>:<gen>:<taskId>`). Settings > Git never
 * offers such a tree as an orphan and only that owner removes it (B6).
 *
 * Reads for the prompt and the policy: how far the branch is behind its base,
 * how far ahead, the diff stat QA reviews (text for the prompt, numbers for
 * the final OK), and the tree mark a writer run is
 * compared against at its close (decision 68), and (B6) the live state the
 * drawer and the integrate need row show, cached per tip. Every git call has
 * its own timeout; a failure reads as unknown, never as a number.
 */
import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { DIFF_STAT_TOP_MAX, taskNumOf, taskSlug, teamWorktreeOwner, type ResolvedRepo, type TaskDiffStat, type TaskWorktree, type TeamTask, type TreeMark } from '@shared/teams'
import type { WorktreeAddError, WorktreeAddReq, WorktreeAddRes, WorktreeInspectRes, WorktreeRemoveReq, WorktreeRemoveRes } from '@shared/worktree-types'
import { MAX_GIT_PROCS, type GitRunner } from '../git/gitExec'
import { parseNumstatZ, sumNumstat } from '../git/porcelain'

/** Per git call (the small queries); `worktree add` keeps the service's own 120 s. */
export const TASK_GIT_TIMEOUT_MS = 15_000
/** The diff stat QA gets in its prompt (PhaseInput.qa.stat). */
export const QA_STAT_MAX_BYTES = 4 * 1024
/** Slug suffixes tried when the task's slug is taken by a tree this task does not own (`-r2` .. `-r9`). */
export const SLUG_RETRIES = 9
/** Per git call of a live read (the drawer's task op, the needs op wait on it). */
export const LIVE_GIT_TIMEOUT_MS = 3_000
/** Trees whose last live read is kept (the oldest goes first). */
export const LIVE_CACHE_MAX = 500

const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/** What the drawer and the integrate need row show of a task tree (B6 integration): a count is absent when unknown. */
export interface WorktreeLive { exists: boolean; ahead?: number; behind?: number }

/** The console worktree service as a team uses it (WorktreeService, decision 63). */
export interface TeamWorktreeApi {
  create(req: WorktreeAddReq, o?: { owner?: string }): Promise<WorktreeAddRes>
  inspect(req: { path: string; base?: string }): Promise<WorktreeInspectRes>
  remove(req: WorktreeRemoveReq, o?: { owner?: string }): Promise<WorktreeRemoveRes>
  isManaged(path: unknown): boolean
  ownedBy(owner: string): { path: string; branch: string; repoRoot: string; baseSha: string; createdAt: number } | null
  disown(prefix: string): number
  disownAt(path: string, owner: string): boolean
}

export interface TaskWorktreesDeps {
  worktrees: TeamWorktreeApi
  git: GitRunner
  now?: () => number
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** The bytes of `s` cut to `max` UTF-8 bytes on a line boundary, with a marker when cut. */
function capLines(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s
  const marker = '\n[... diff stat cut]'
  const room = max - Buffer.byteLength(marker, 'utf8')
  let out = ''
  for (const line of s.split('\n')) {
    const next = out ? `${out}\n${line}` : line
    if (Buffer.byteLength(next, 'utf8') > room) break
    out = next
  }
  return out + marker
}

export class TaskWorktrees {
  private readonly now: () => number
  /** The last live read per tree path, with the tips its counts were read at (cached per tip). */
  private readonly liveCache = new Map<string, { branch: string; baseBranch: string; tip: string; baseTip: string; live: WorktreeLive }>()

  constructor(private readonly deps: TaskWorktreesDeps) {
    this.now = deps.now ?? Date.now
  }

  private git(args: string[], cwd: string, timeoutMs = TASK_GIT_TIMEOUT_MS): Promise<string> {
    return this.deps.git.run(args, { cwd, timeoutMs })
  }

  /**
   * The task's worktree, created now: `sn/<slug>` from the tip of the repo's
   * base branch, node_modules linked, no .env copy, the owner in the manifest.
   * A tree this exact owner already holds is adopted (a crash between the create
   * and the `task.worktree` commit); a slug taken by anything else (an old team
   * of the same repo, a console) moves on to `-r2`..`-r9`, never adopting it.
   * An owned entry whose folder is gone loses its owner once the new tree
   * exists (an ordinary orphan from then on): one owner never names two entries.
   */
  async ensure(team: { id: string; gen: string }, repo: ResolvedRepo, task: TeamTask): Promise<{ ok: true; worktree: TaskWorktree } | { ok: false; error: WorktreeAddError | 'base_missing' }> {
    const n = taskNumOf(task.id)
    if (n === null) return { ok: false, error: 'bad_slug' }
    const owner = teamWorktreeOwner(team.id, team.gen, task.id)
    const own = this.deps.worktrees.ownedBy(owner)
    if (own && (await isDir(own.path))) {
      const slug = own.branch.slice('sn/'.length)
      return { ok: true, worktree: { path: own.path, branch: own.branch, base: own.baseSha, baseBranch: repo.baseBranch, slug, createdAt: own.createdAt || this.now(), owner } }
    }
    let base = ''
    try {
      base = (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${repo.baseBranch}^{commit}`], repo.repoRoot)).trim()
    } catch {
      base = ''
    }
    if (!FULL_SHA_RE.test(base)) return { ok: false, error: 'base_missing' }
    const first = taskSlug(team.id, n)
    for (let i = 1; i <= SLUG_RETRIES; i++) {
      const slug = i === 1 ? first : `${first}-r${i}`
      const res = await this.deps.worktrees.create({ repoCwd: repo.repoRoot, slug, base, copyEnv: false, linkNodeModules: true }, { owner })
      if (res.ok) {
        if (own) this.disownStale(owner, res.worktree.path)
        return { ok: true, worktree: { path: res.worktree.path, branch: res.worktree.branch, base: res.worktree.base, baseBranch: repo.baseBranch, slug, createdAt: this.now(), owner } }
      }
      if (res.error !== 'branch_exists' && res.error !== 'path_exists') return { ok: false, error: res.error }
    }
    return { ok: false, error: 'branch_exists' }
  }

  /** Every other entry of `owner` (stale: ensure found its folder gone) loses the owner; `keep` is the tree just made. */
  private disownStale(owner: string, keep: string): void {
    // ownedBy names the oldest entry first: each round clears one, the new tree ends the loop (bounded by the slugs tried).
    try {
      for (let i = 0; i <= SLUG_RETRIES; i++) {
        const stale = this.deps.worktrees.ownedBy(owner)
        if (!stale || stale.path === keep) return
        if (!this.deps.worktrees.disownAt(stale.path, owner)) return
      }
    } catch {
      // The manifest could not be written: the new tree is the task's all the same; the stale entry keeps its owner,
      // and with its folder gone it is never adopted.
    }
  }

  inspect(task: TeamTask): Promise<WorktreeInspectRes> {
    const wt = task.worktree
    if (!wt) return Promise.resolve({ exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false })
    return this.deps.worktrees.inspect({ path: wt.path, base: wt.base })
  }

  /** Commits the base branch has that the task branch lacks (`main -N`), read in the worktree; undefined when unknown. */
  async behind(task: TeamTask): Promise<number | undefined> {
    const wt = task.worktree
    if (!wt) return undefined
    return this.count(`refs/heads/${wt.branch}..refs/heads/${wt.baseBranch}`, wt.path)
  }

  /** Commits of the task branch over its base (decideApproval f.ahead, T11); undefined when unknown. */
  async ahead(task: TeamTask): Promise<number | undefined> {
    const wt = task.worktree
    if (!wt) return undefined
    return this.count(`refs/heads/${wt.baseBranch}..refs/heads/${wt.branch}`, wt.path)
  }

  /**
   * B6 integration: the tree as the drawer and the integrate need row show it, read now with short timeouts: whether
   * its folder is on disk, the commits its branch has over its base branch (`ahead`) and the base over it (`behind`).
   * Both tips come from one `for-each-ref` in the repo (the folder may be gone); the counts (`rev-list --left-right
   * --count`) are read again only when a tip moved since the last read (cached per tip). Never throws: a git call that
   * fails or times out leaves the counts unknown. Only the async task and needs ops call it, never a board render.
   * Second round: never a wait behind the git semaphore (a long land holds a slot for minutes): with no slot free
   * right away the tips are not read and the counts last read stay (only `exists` is new), and a moved tip whose count
   * finds no slot leaves the counts unknown until the next read.
   */
  async live(repoRoot: string, wt: TaskWorktree, timeoutMs = LIVE_GIT_TIMEOUT_MS): Promise<WorktreeLive> {
    const out: WorktreeLive = { exists: await isDir(wt.path) }
    const tipRef = `refs/heads/${wt.branch}`
    const baseRef = `refs/heads/${wt.baseBranch}`
    const c = this.liveCache.get(wt.path)
    const prev = c && c.branch === wt.branch && c.baseBranch === wt.baseBranch ? c : undefined
    // for-each-ref also lists refs below a pattern (`<base>/x`): only the exact names count.
    const refs = this.gitNow(['for-each-ref', '--format=%(objectname) %(refname)', tipRef, baseRef], repoRoot, timeoutMs)
    if (!refs) {
      if (prev?.live.ahead !== undefined) out.ahead = prev.live.ahead
      if (prev?.live.behind !== undefined) out.behind = prev.live.behind
      return this.remember(wt, prev?.tip ?? '', prev?.baseTip ?? '', out)
    }
    let tip = ''
    let baseTip = ''
    try {
      for (const line of (await refs).split('\n')) {
        const [sha, name] = [line.slice(0, line.indexOf(' ')).trim(), line.slice(line.indexOf(' ') + 1).trim()]
        if (!FULL_SHA_RE.test(sha)) continue
        if (name === tipRef) tip = sha.toLowerCase()
        else if (name === baseRef) baseTip = sha.toLowerCase()
      }
    } catch {
      tip = ''
    }
    if (tip && baseTip) {
      if (prev && prev.tip === tip && prev.baseTip === baseTip && prev.live.ahead !== undefined) {
        out.ahead = prev.live.ahead
        if (prev.live.behind !== undefined) out.behind = prev.live.behind
      } else {
        try {
          const counts = this.gitNow(['rev-list', '--left-right', '--count', `${baseTip}...${tip}`], repoRoot, timeoutMs)
          const [behind, ahead] = counts ? (await counts).trim().split(/\s+/).map(Number) : []
          if (Number.isInteger(ahead) && ahead >= 0 && Number.isInteger(behind) && behind >= 0) {
            out.ahead = ahead
            out.behind = behind
          }
        } catch {
          /* unknown counts */
        }
      }
    }
    return this.remember(wt, tip, baseTip, out)
  }

  /**
   * A git call of a live read only when the git semaphore has a slot free right now (B6 integration, second round),
   * else null. Below MAX_GIT_PROCS a desktop call starts at once (gitExec never keeps one waiting while a slot is
   * free), and the check and that start are one synchronous step.
   */
  private gitNow(args: string[], cwd: string, timeoutMs: number): Promise<string> | null {
    return this.deps.git.running >= MAX_GIT_PROCS ? null : this.git(args, cwd, timeoutMs)
  }

  /** The live read of `wt` cached with the tips it was read at (the oldest of LIVE_CACHE_MAX goes); a copy back. */
  private remember(wt: TaskWorktree, tip: string, baseTip: string, live: WorktreeLive): WorktreeLive {
    this.liveCache.delete(wt.path)
    this.liveCache.set(wt.path, { branch: wt.branch, baseBranch: wt.baseBranch, tip, baseTip, live: { ...live } })
    if (this.liveCache.size > LIVE_CACHE_MAX) {
      const oldest = this.liveCache.keys().next().value
      if (oldest !== undefined) this.liveCache.delete(oldest)
    }
    return live
  }

  /** The last live read of `wt` (no git, no disk: a sync view may show it), null when there is none for its branches. */
  cachedLive(wt: TaskWorktree): WorktreeLive | null {
    const c = this.liveCache.get(wt.path)
    return c && c.branch === wt.branch && c.baseBranch === wt.baseBranch ? { ...c.live } : null
  }

  private async count(range: string, cwd: string): Promise<number | undefined> {
    try {
      const n = Number((await this.git(['rev-list', '--count', range], cwd)).trim())
      return Number.isInteger(n) && n >= 0 ? n : undefined
    } catch {
      return undefined
    }
  }

  /**
   * What QA reviews (PhaseInput.qa.stat, <= 4 KB): the branch since it left its
   * base (`diff --stat <base>...<branch>`); a task without a worktree (main
   * isolation) shows the uncommitted changes of its cwd against HEAD. '' when git
   * cannot say.
   */
  async qaStat(task: TeamTask, cwd?: string): Promise<string> {
    const wt = task.worktree
    try {
      const out = wt
        ? await this.git(['diff', '--stat', `refs/heads/${wt.baseBranch}...refs/heads/${wt.branch}`], wt.path)
        : cwd
          ? await this.git(['diff', '--stat', 'HEAD'], cwd)
          : ''
      return capLines(out.replace(/\s+$/, ''), QA_STAT_MAX_BYTES)
    } catch {
      return ''
    }
  }

  /**
   * B5: the same range as qaStat in numbers (`diff --numstat -z`): files, insertions, deletions and the
   * DIFF_STAT_TOP_MAX files with the most lines changed (binaries count 0). The task keeps it as `diffStat`, the one
   * the final OK shows. null when git cannot say or there is no range (no worktree and no cwd).
   */
  async diffStat(task: TeamTask, cwd?: string): Promise<Omit<TaskDiffStat, 'at'> | null> {
    const wt = task.worktree
    const flags = ['--no-ext-diff', '--no-textconv', '-z', '--numstat', '-M']
    try {
      const out = wt
        ? await this.git(['diff', ...flags, `refs/heads/${wt.baseBranch}...refs/heads/${wt.branch}`, '--'], wt.path)
        : cwd
          ? await this.git(['diff', ...flags, 'HEAD', '--'], cwd)
          : null
      if (out === null) return null
      const rows = parseNumstatZ(out)
      const top = rows
        .map((r) => ({ path: r.path.slice(0, 300), add: r.added ?? 0, del: r.removed ?? 0 }))
        .sort((a, b) => b.add + b.del - (a.add + a.del) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .slice(0, DIFF_STAT_TOP_MAX)
      const sum = sumNumstat(rows)
      return { files: rows.length, insertions: sum.added, deletions: sum.removed, top }
    } catch {
      return null
    }
  }

  /**
   * TreeMark of a run cwd (decision 68): HEAD plus the sha256 of the full porcelain status; null when git cannot read
   * it. `timeoutMs` is the budget of both git calls together (the close sequence gives it 5 s), in wall time like
   * the git timeouts themselves (never the injected clock, which a test may hold still or jump).
   */
  async mark(cwd: string, timeoutMs = TASK_GIT_TIMEOUT_MS): Promise<TreeMark | null> {
    try {
      const end = Date.now() + timeoutMs
      const head = (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd, timeoutMs)).trim()
      const left = end - Date.now()
      if (left <= 0) return null
      const status = await this.git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], cwd, left)
      return { head, status: createHash('sha256').update(status, 'utf8').digest('hex') }
    } catch {
      return null
    }
  }

  /**
   * B6, the removeWorktree op (design 3.6): the task's tree and its `sn/` branch through the worktree service, named
   * by the task's owner (decision 63: no other caller may remove it). `expect` is the inspect main just made: the tip
   * the branch delete compares against ('' when the branch is gone) and the uncommitted files the recheck allows, so
   * a commit or a write that lands in between is `changed`, never lost. The caller checked that no run, integrate
   * nor takeover uses the tree.
   */
  remove(task: TeamTask, expect: { tip: string; dirty: number }): Promise<WorktreeRemoveRes> {
    const wt = task.worktree
    if (!wt) return Promise.resolve({ ok: false, error: 'not_managed', detail: 'task' })
    const req: WorktreeRemoveReq = { path: wt.path, deleteBranch: true, expectDirty: Math.max(0, Math.floor(expect.dirty)) }
    if (FULL_SHA_RE.test(expect.tip)) req.expectTip = expect.tip.toLowerCase()
    return this.deps.worktrees.remove(req, { owner: wt.owner }).then((res) => {
      if (res.ok) this.liveCache.delete(wt.path)
      return res
    })
  }

  /** The `remove` op of a team: every manifest entry of `team:<teamId>:` loses its owner (ordinary orphans from then on). */
  disown(teamId: string): number {
    return this.deps.worktrees.disown(`team:${teamId}:`)
  }

  /**
   * One tree loses its owner (only while it is still exactly `wt.owner`): the prep of a run whose team was removed
   * while `ensure` ran, so the tree landed after the team's disown (decision 63: it reads as an ordinary orphan too).
   */
  disownTree(wt: Pick<TaskWorktree, 'path' | 'owner'>): boolean {
    try {
      return this.deps.worktrees.disownAt(wt.path, wt.owner)
    } catch {
      return false
    }
  }
}
