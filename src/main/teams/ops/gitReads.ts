/**
 * `snaos team diff` and `snaos team log` (app 2.7.0, E10 B5 integration, fourth round, security): the code changes
 * and the history a team run reads through main. The readonly profile has no git log, diff nor show any more
 * (teamArgv CLAUDE_READONLY_ALLOW): their options come in any order, `--output=<file>` writes any file and `diff
 * --no-index` or `blame --contents` read any one, which no text deny rule can fence.
 *
 * Main picks the tree and the range (TeamService.gitTargetOf): a task with a worktree reads it against the current
 * tip of its base branch (fifth round, like TaskWorktrees.qaStat): the diff from the merge base of
 * `refs/heads/<baseBranch>` and `refs/heads/<branch>` to the working tree (its commits and what is not committed yet),
 * the log `refs/heads/<baseBranch>..refs/heads/<branch>`, so a rebase onto a newer base never shows the base's own
 * commits; a task without one, or none, the repo root against HEAD. Nothing of the caller reaches git argv but the
 * paths after `--`, checked here once more (repoPathError) and kept inside the tree after realpath (a link that leaves
 * it is refused). The options are fixed: no pager (`--no-pager`, `core.pager=cat`), no external diff
 * (`diff.external=`, `--no-ext-diff`), no textconv, no color, no signature check (`--no-show-signature`,
 * `log.showSignature=false`: a `gpg.program` of the repo config never runs), no fsmonitor, no line end warnings
 * (`core.safecrlf=false`), literal pathspecs (`--literal-pathspecs`: a `:(...)` magic or a glob is a file name) and
 * UTF-8 log output. The git runner (GIT_PREFIX, its env, the absolute git binary) runs it at remote priority, so the
 * desktop keeps its slot; the text is cut at its cap with one marker line. TeamService runs one read per run at a time.
 *
 * What stays (E10 SPIKE): a clean or process filter that `.gitattributes` and the repo config name runs on a working
 * tree diff, as it does for the app's own git status and diff stat.
 */
import { dirname, isAbsolute, resolve } from 'path'
import { CTL_TEAM_DIFF_MAX, CTL_TEAM_LOG_MAX, CTL_TEAM_PATH_MAX, type CtlResponse, type CtlTeamGitResult } from '@shared/ctl-protocol'
import { gitErrorCode, gitOverflowed, type GitRunner } from '../../git/gitExec'
import { isSameOrInside } from '../../migration/pathUtil'
import type { TeamFailLike } from '../teamCtl'

/** Per git call (the task reads of TaskWorktrees use the same 15 s). */
export const TEAM_GIT_TIMEOUT_MS = 15_000

/** Before the subcommand: fixed, never the caller's. GIT_PREFIX (gitExec) adds quotePath and autoRefreshIndex off. */
export const TEAM_GIT_GLOBAL = [
  '--no-pager', '--literal-pathspecs',
  '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'log.showSignature=false',
  '-c', 'i18n.logOutputEncoding=UTF-8', '-c', 'color.ui=never', '-c', 'core.safecrlf=false',
] as const
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'] as const
const LOG_FLAGS = ['--no-color', '--no-show-signature', '--no-decorate', '--no-ext-diff', '--no-textconv', '--encoding=UTF-8', '--date=iso', '--pretty=medium'] as const

const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
/** A task branch as TaskWorktrees makes it (`sn/<slug>`): plain ref characters, no `..`, never an option. */
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

/** Where main reads: the tree (cwd), and for a worktree its base branch and its branch (`base`, the sha it left from, is informative). */
export interface TeamGitTarget { cwd: string; where: 'worktree' | 'root'; base?: string; baseBranch?: string; branch?: string; task?: string }
export type TeamGitRequest = { method: 'team.diff'; stat: boolean; paths: readonly string[] } | { method: 'team.log'; n: number; paths: readonly string[] }
export interface TeamGitDeps { git: GitRunner; realpath: (p: string) => Promise<string> }
type Reply = CtlResponse<CtlTeamGitResult> | ({ ok: false } & TeamFailLike)

/**
 * Why a path is not repo relative, or null: a text of CTL_TEAM_PATH_MAX characters at most without a control
 * character, not absolute (a `/` or `\` first, so no UNC either), no drive (`C:`), no `..` segment. Its index names it.
 */
export function repoPathError(p: unknown, i: number): string | null {
  const n = `path ${i + 1}`
  if (typeof p !== 'string' || p === '') return `${n} must be a non-empty text`
  if (p.length > CTL_TEAM_PATH_MAX) return `${n} is longer than ${CTL_TEAM_PATH_MAX} characters`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return `${n} has a control character`
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || isAbsolute(p)) return `${n} must be relative to the repo, not absolute`
  if (p.split(/[\\/]/).includes('..')) return `${n} must stay inside the repo (no .. segment)`
  return null
}

function bad(detail: string): { ok: false } & TeamFailLike {
  return { ok: false, error: 'bad_request', detail }
}

/** The realpath of `p`, or of its nearest folder that exists (a deleted file is a fine diff path); null when none resolves. */
async function realpathNear(realpath: TeamGitDeps['realpath'], p: string): Promise<string | null> {
  let cur = p
  for (let i = 0; i < 64; i++) {
    try {
      return await realpath(cur)
    } catch {
      const up = dirname(cur)
      if (up === cur) return null
      cur = up
    }
  }
  return null
}

/** `s` within `max` UTF-8 bytes, cut at a line end (a single longer line at a character), with `marker` as its last line. */
export function capText(s: string, max: number, marker: string): { text: string; cut: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, cut: false }
  const room = Math.max(0, max - Buffer.byteLength(marker, 'utf8') - 1)
  let out = ''
  let used = 0
  for (const line of s.split('\n')) {
    const cost = Buffer.byteLength(line, 'utf8') + (out ? 1 : 0)
    if (used + cost > room) {
      if (!out) out = Buffer.from(line, 'utf8').subarray(0, room).toString('utf8').replace(/�+$/, '')
      break
    }
    out = out ? `${out}\n${line}` : line
    used += cost
  }
  return { text: `${out}\n${marker}`, cut: true }
}

/**
 * The git argv of a request on a target (the paths already checked), and what it reads (CtlTeamGitResult.range). A
 * worktree's diff starts at `from`, the merge base teamGitRead found (mergeBaseArgv), and runs to the working tree
 * (the commits of the branch and what is not committed yet); its log is the branch over the current base branch.
 */
export function teamGitArgv(target: TeamGitTarget, req: TeamGitRequest, from?: string): { args: string[]; range: string } {
  const paths = ['--', ...req.paths]
  if (req.method === 'team.diff') {
    const start = target.where === 'worktree' && from ? from : 'HEAD'
    return { args: [...TEAM_GIT_GLOBAL, 'diff', ...DIFF_FLAGS, ...(req.stat ? ['--stat=200'] : []), start, ...paths], range: start }
  }
  const range = target.where === 'worktree' && target.baseBranch && target.branch ? `refs/heads/${target.baseBranch}..refs/heads/${target.branch}` : 'HEAD'
  return { args: [...TEAM_GIT_GLOBAL, 'log', ...LOG_FLAGS, `--max-count=${req.n}`, range, ...paths], range }
}

/** Where a worktree's branch left the current tip of its base branch: the start of its diff (fifth round). */
export function mergeBaseArgv(target: TeamGitTarget): string[] {
  return [...TEAM_GIT_GLOBAL, 'merge-base', `refs/heads/${target.baseBranch ?? ''}`, `refs/heads/${target.branch ?? ''}`]
}

/** A git failure as the agent reads it: too_big past the runner's buffer (stderr or not), a timeout in words, else io with git's first stderr line. */
function gitFail(e: unknown, req: TeamGitRequest, context = ''): { ok: false } & TeamFailLike {
  const msg = e instanceof Error ? e.message : String(e)
  const narrow = `narrow it with ${req.method === 'team.diff' ? '--stat or ' : '-n or '}-- <path>`
  // Node kills git past maxBuffer: the code survives through gitExec (gitOverflowed) even when stderr is the message.
  if (gitOverflowed(e) || /maxBuffer/i.test(msg)) return { ok: false, error: 'too_big', detail: `the ${req.method === 'team.diff' ? 'diff' : 'log'} is too large to read at once: ${narrow}` }
  // A killed git says only `Command failed: <its argv>` (execFile): the agent gets what happened and what to do.
  if (gitErrorCode(e) === 'timeout') return { ok: false, error: 'io', detail: `git took longer than ${TEAM_GIT_TIMEOUT_MS / 1000} s: ${narrow}` }
  // git's first stderr line, one line and short (never the whole output): it says what failed. Without stderr, the
  // context speaks alone (never execFile's `Command failed: <argv>`); with none, the error's own message.
  const stderr = (e as { stderr?: unknown } | null)?.stderr
  const source = typeof stderr === 'string' && stderr.trim() ? stderr : context ? '' : msg
  const line = source.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const detail = line.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)
  return { ok: false, error: 'io', detail: context ? `${context}${detail ? `: ${detail}` : ''}` : detail }
}

/**
 * One `team.diff` or `team.log` of a run: the paths checked again and inside the tree after realpath (bad_request),
 * git with the fixed options (a failure: io with git's first stderr line, a timeout in words; an output past the
 * runner's buffer: too_big, narrow it), the text cut at CTL_TEAM_DIFF_MAX or CTL_TEAM_LOG_MAX with a marker line.
 * A worktree's diff first asks git for its merge base with the base branch (mergeBaseArgv); a worktree whose folder
 * is gone answers io in words (sixth round).
 */
export async function teamGitRead(deps: TeamGitDeps, target: TeamGitTarget, req: TeamGitRequest): Promise<Reply> {
  if (target.where === 'worktree' && (!target.baseBranch || !BRANCH_RE.test(target.baseBranch) || !target.branch || !BRANCH_RE.test(target.branch)))
    return { ok: false, error: 'io', detail: 'the worktree of the task has no base branch or branch git can read' }
  // Sixth round: a worktree folder that is gone (removed or moved) says so, never git's merge base or spawn error.
  if (target.where === 'worktree') {
    try {
      await deps.realpath(target.cwd)
    } catch {
      return { ok: false, error: 'io', detail: `the worktree folder of ${target.task ?? 'the task'} is missing (it was removed or moved), so git cannot read its changes` }
    }
  }
  const label = req.method === 'team.diff' ? 'team diff' : 'team log'
  for (let i = 0; i < req.paths.length; i++) {
    const why = repoPathError(req.paths[i], i)
    if (why) return bad(`${label}: ${why}`)
  }
  if (req.paths.length > 0) {
    let root: string
    try {
      root = await deps.realpath(target.cwd)
    } catch {
      return { ok: false, error: 'io', detail: 'the working tree is gone' }
    }
    for (let i = 0; i < req.paths.length; i++) {
      const abs = resolve(root, req.paths[i])
      const real = isSameOrInside(abs, root) ? await realpathNear(deps.realpath, abs) : null
      if (!real || !isSameOrInside(real, root)) return bad(`${label}: path ${i + 1} leaves the repo (through a link)`)
    }
  }
  const run = (args: string[]): Promise<string> => deps.git.run(args, { cwd: target.cwd, timeoutMs: TEAM_GIT_TIMEOUT_MS, priority: 'remote' })
  let from: string | undefined
  if (req.method === 'team.diff' && target.where === 'worktree') {
    // The current tip of the base branch, not the sha the worktree left from: a rebase onto a newer base shows only the task's work.
    const where = `git found no commit where ${target.branch} left ${target.baseBranch}`
    try {
      from = (await run(mergeBaseArgv(target))).trim()
    } catch (e) {
      return gitFail(e, req, where)
    }
    if (!FULL_SHA_RE.test(from)) return { ok: false, error: 'io', detail: where }
  }
  const { args, range } = teamGitArgv(target, req, from)
  let out: string
  try {
    out = await run(args)
  } catch (e) {
    return gitFail(e, req)
  }
  const diff = req.method === 'team.diff'
  const max = diff ? CTL_TEAM_DIFF_MAX : CTL_TEAM_LOG_MAX
  const marker = diff
    ? `[... cut at ${max / 1024} KB: narrow it with --stat, or name paths after --]`
    : `[... cut at ${max / 1024} KB: ask for fewer commits with -n, or name paths after --]`
  const { text, cut } = capText(out.trimEnd(), max, marker)
  const data: CtlTeamGitResult = { where: target.where, range, text }
  if (target.task) data.task = target.task
  if (cut) data.cut = true
  return { ok: true, data }
}
