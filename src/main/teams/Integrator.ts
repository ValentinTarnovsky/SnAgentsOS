/**
 * Integrar (app 2.7.0, E10 B6, design 3.7; spike S10): a task branch lands on
 * its base branch as a `--no-ff` merge commit, built and checked away from
 * the user's checkout, which is touched only by the land itself:
 *  1. preflight: the task worktree exists, is clean, has nothing half done
 *     and is on its branch, its tip is the one the preview showed; a tip
 *     already in the base ends the task (`alreadyMerged`); the committer
 *     identity is read first (`git var GIT_COMMITTER_IDENT`, `no_identity`);
 *  2. temp: `worktree add --detach <teams/<id>/integrate/<task>-<ts>> <baseTip>`
 *     plus the node_modules junction of WorktreeService, never for a verify
 *     that installs dependencies (`verifyInstalls`: it builds its own there);
 *  3. merge there: `merge --no-ff --no-edit --no-verify -F <msg> <tip>`; a
 *     failure lists the unmerged paths (`--diff-filter=U`) and aborts:
 *     `merge_conflict` with them, `git_error` with none;
 *  4. verify (only a command of the trusted definition the user confirmed):
 *     the shell of the platform in the temp tree with the cleaned env, a log
 *     under `teams/<id>/verify/`, the whole tree killed at the timeout;
 *  5. land: the main checkout on the base, clean, with nothing the merge adds
 *     there untracked or ignored and with nobody writing ->
 *     `merge --ff-only --no-overwrite-ignore <mergeSha>` there (10 minutes: a git killed in the
 *     middle of a checkout can leave it half updated); the base checked out nowhere ->
 *     `update-ref refs/heads/<base> <mergeSha> <baseTip>` (CAS: "but
 *     expected" is `base_moved`); checked out in another worktree ->
 *     `base_checked_out_elsewhere` (also a worktree with a rebase or a
 *     bisect of the base in progress; the main checkout with one: `base_busy`);
 *  6. cleanup, always: the junction unlinked as a link, `worktree remove
 *     --force`, a guarded tree removal as the fallback, `worktree prune`.
 * After any failure the user's HEAD, branch, index and status are exactly as
 * they were (test-teams-integrate asserts it per case). The exit hooks halt
 * every integrate begun (`interrupted` before its next step) and kill the verify
 * trees; the installer also waits for a land that already began
 * (TeamService.prepareInstall).
 *
 * Every git call runs at desktop priority with its own timeout and fixed
 * options (no pager, no external diff, no fsmonitor, long paths, no line end
 * warnings) and with `core.hooksPath` pointed at a folder that does not exist:
 * no hook of the repo runs on the synthetic tree nor on the land (post-checkout,
 * post-merge, reference-transaction; `--no-verify` alone would leave those).
 * No agent text reaches git argv: the merge message (it holds the task title)
 * goes through a file. One integrate per repo at a time across every team
 * (`key(repoRoot)` chain); the task worktree, the temp tree and, while landing,
 * the repo root are write-locked by `integrate:<teamId>:<taskId>`.
 */
import { spawn as nodeSpawn } from 'child_process'
import { createWriteStream, mkdirSync, promises as fsp, type WriteStream } from 'fs'
import { dirname, join, resolve, win32 } from 'path'
import { stripAnsi } from '@shared/ansi'
import { BRAND, LEGACY_BRAND } from '@shared/brand'
import { TEAM_DIR } from '@shared/teamDefinition'
import { DIFF_STAT_TOP_MAX, TEAM_LOGS_MAX_BYTES, TEAM_LOG_TTL_MS, type IntegrateError, type IntegrateStep, type ResolvedRepo, type TeamTask } from '@shared/teams'
import type { DiffStat, IntegratePreview, IntegrateProgressEvt, IntegrateStepState, VerifyNote } from '@shared/team-protocol'
import { verifyInstalls, type VerifySuggestion } from '@shared/verifyDetect'
import type { WorktreeInspectRes } from '@shared/worktree-types'
import { gitErrorCode, gitExitCode, type GitRunner } from '../git/gitExec'
import { parseNumstatZ, parseStatusV2, sumNumstat } from '../git/porcelain'
import { parseWorktreeList, unlinkLink } from '../git/WorktreeService'
import type { PathGuard, RemoveOptions, RemoveResult } from '../migration/safeRemove'
import { childrenSince, childrenSinceSync, CREATION_CLOCK_SLACK_MS } from '../proc/treeKill'
import { VERIFY_NOTE_EN } from './flow/integrate'
import type { TeamWorktreeApi } from './TaskWorktrees'
import { INTEGRATE_HOLDER_PREFIX, type WriteLocks } from './WriteLocks'

/** `worktree add`, the merge and `worktree remove` of the temp tree may move a large tree. */
export const INTEGRATE_GIT_TIMEOUT_MS = 120_000
/**
 * The ff-only land, the one step that updates the user's checkout (B6 integration, design 3.7 said 120 s): a git
 * killed in the middle of a checkout can leave it half updated, so it gets ten minutes to finish a large tree.
 */
export const INTEGRATE_LAND_TIMEOUT_MS = 10 * 60_000
/** Every other git call (tips, counts, status, var, update-ref). */
export const INTEGRATE_QUERY_MS = 15_000
/** The verify output tail a progress event and a failed task carry (UTF-8 bytes, redacted). */
export const VERIFY_TAIL_MAX_BYTES = 8 * 1024
/** A verify log stops growing here (a marker line says so). */
export const VERIFY_LOG_MAX_BYTES = 20 * 1024 * 1024
/** A verify that was killed at its timeout and never closes its pipes is let go this long after the kill. */
export const VERIFY_KILL_DRAIN_MS = 5_000
/** After the command exits its output is read this long more; whatever still holds the pipes then is stopped. */
export const VERIFY_EXIT_DRAIN_MS = 2_000
/** A live verify tail reaches the dialog at most this often (leading edge; the step end always carries the last one). */
export const VERIFY_TAIL_EVERY_MS = 300
/** Dirty or blocking files a failure names. */
export const BLOCKING_FILES_MAX = 50
/** A git failure's own text kept as a tail (the end of stderr and stdout). */
const GIT_TAIL_MAX = 2000
/** A merge title of the task title: one line, at most this many characters. */
const MERGE_TITLE_MAX = 100
/** The paths a land checks on disk at a time (untrackedInTheWay). */
const LSTAT_BATCH = 64
/** The pathspecs of one `ls-files` call, in characters (the Windows command line stops at 32767). */
const PATHSPEC_CHUNK_CHARS = 16_000

/** Temp trees and message files of an integrate: `<taskId>-<ts>` and `<taskId>-<ts>.msg`; the sweep removes nothing else. */
const TEMP_NAME_RE = /^t-[0-9]{1,5}-[0-9]{1,16}$/
const MSG_NAME_RE = /^t-[0-9]{1,5}-[0-9]{1,16}\.msg$/
/** Verify logs: `<taskId>-<ts>.log`. */
export const VERIFY_LOG_RE = /^t-[0-9]{1,5}-[0-9]{1,16}\.log$/
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
/** A folder git looks hooks up in that never exists (design note above). */
const NO_HOOKS_DIR = '.no-hooks'

/** The write-lock holder of a task's integrate: the team id too (two teams may both have a `t-1`). */
export function integrateHolder(teamId: string, taskId: string): string {
  return `${INTEGRATE_HOLDER_PREFIX}${teamId}:${taskId}`
}

/**
 * The verify process: ok when it exited 0 before its timeout; `tail` its last output, ANSI stripped and redacted
 * (only what the command printed); `note` what the runner itself had to do (B6 review: the renderer words it, the
 * English line goes to the verify log only).
 */
export type RunVerify = (command: string, cwd: string, timeoutMs: number, logFile: string, onTail?: (tail: string) => void) => Promise<VerifyResult>
export interface VerifyResult { ok: boolean; timedOut: boolean; tail: string; note?: VerifyNote }

/** The verify log's own line for each note (English, never in the tail; a rebaseVerify comment reuses the words). */
const VERIFY_NOTE_LINE: Record<VerifyNote, string> = {
  leftStopped: `[${VERIFY_NOTE_EN.leftStopped}]`,
  leftLetGo: `[${VERIFY_NOTE_EN.leftLetGo}]`,
  timeoutKill: `[${VERIFY_NOTE_EN.timeoutKill}]`,
  spawnFailed: `[${VERIFY_NOTE_EN.spawnFailed}]`,
}

/** createVerifyRunner's RunVerify, which also tracks its processes (B6 integration: the exit hooks stop them). */
export type VerifyRunner = RunVerify & {
  /** Tree-kills every verify in flight (TeamService.shutdownSync and prepareInstall); how many there were. */
  killAll(): number
  /** Verifies in flight. */
  live(): number
}

export type IntegrateResult =
  | { ok: true; mergeSha: string; base: string; landed: 'ffOnly' | 'updateRef' | 'alreadyMerged'; verifyTail?: string; verifyNote?: VerifyNote; mergeBase?: string }
  /** `verifyNote`: the verify's, also for a failure after it; `landing`: a failure at step land whose mode was known. */
  | { ok: false; error: IntegrateError; step: IntegrateStep; files?: string[]; tail?: string; verifyNote?: VerifyNote; landing?: 'ffOnly' | 'updateRef'; mergeBase?: string }

export interface IntegratorDeps {
  git: GitRunner
  worktrees: Pick<TeamWorktreeApi, 'inspect'>
  locks: WriteLocks
  integrateDir: (teamId: string) => string
  verifyLogDir: (teamId: string) => string
  runVerify: RunVerify
  /** Extracted from WorktreeService.createNow (B6): the junctions it made. */
  linkNodeModules: (repoRoot: string, path: string) => Promise<string[]>
  removeTree: (target: string, guard: PathGuard, o: RemoveOptions) => Promise<RemoveResult>
  now: () => number
  progress: (e: IntegrateProgressEvt) => void
  log?: (line: string) => void
}

type Landing = { mode: 'ffOnly' | 'updateRef' } | { blocked: IntegrateError; path?: string; files?: string[]; filesMore?: number }

/** The end of a git failure's stderr and stdout (what it said), never its argv. */
function gitTail(e: unknown): string {
  const err = (e as { stderr?: unknown } | null)?.stderr
  const out = (e as { stdout?: unknown } | null)?.stdout
  const text = [typeof err === 'string' ? err.trim() : '', typeof out === 'string' ? out.trim() : ''].filter(Boolean).join('\n')
  return text.length > GIT_TAIL_MAX ? text.slice(-GIT_TAIL_MAX) : text
}

function stderrOf(e: unknown): string {
  const s = (e as { stderr?: unknown } | null)?.stderr
  return typeof s === 'string' ? s : ''
}

/**
 * A merge refused because it would replace what the user has and git does not track (LC_ALL=C): "... would be
 * overwritten by merge:" (files; with `--no-overwrite-ignore` ignored ones too), "... would be removed by merge:" or
 * "Updating the following directories would lose untracked files in them:" (a folder the merge turns into a file).
 */
const OVERWRITE_RE = /would be (?:overwritten|removed) by merge|would lose untracked files in them/
const OVERWRITE_LINE_RE = /(?:would be (?:overwritten|removed) by merge|would lose untracked files in them):\s*$/

/** The tab-indented paths git lists under those lines, at most BLOCKING_FILES_MAX. */
export function overwrittenFiles(stderr: string): string[] {
  const out: string[] = []
  let inList = false
  for (const line of stderr.split(/\r?\n/)) {
    if (OVERWRITE_LINE_RE.test(line)) {
      inList = true
      continue
    }
    if (inList && /^\t/.test(line)) {
      const p = line.trim()
      if (p && !out.includes(p)) out.push(p)
      if (out.length >= BLOCKING_FILES_MAX) break
    } else inList = false
  }
  return out
}

/** The paths of a porcelain v2 status (distinct): the first BLOCKING_FILES_MAX and how many more. */
function statusPaths(out: string): { files: string[]; more: number } {
  const all = [...new Set(parseStatusV2(out).entries.map((e) => e.path))]
  return { files: all.slice(0, BLOCKING_FILES_MAX), more: Math.max(0, all.length - BLOCKING_FILES_MAX) }
}

/** The merge commit message: `Merge <branch>: <title, one line, <= 100> (<taskId>)`. */
export function mergeMessage(branch: string, title: string, taskId: string): string {
  // eslint-disable-next-line no-control-regex
  let t = title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length > MERGE_TITLE_MAX) t = `${t.slice(0, MERGE_TITLE_MAX - 3).trimEnd()}...`
  return `Merge ${branch}: ${t} (${taskId})\n`
}

/** Why a task worktree cannot be integrated (design 3.7 preflight), or null. */
export function preflightError(insp: WorktreeInspectRes, branch: string): IntegrateError | null {
  if (!insp.exists || insp.noCheckout) return 'missing_worktree'
  if (insp.inProgress) return 'in_progress'
  if (insp.dirtyFiles > 0) return 'dirty_worktree'
  if (insp.headBranch === undefined) return 'git_error'
  // inspect names the branch without refs/heads/ ('' when detached).
  if (insp.headBranch !== branch) return 'wrong_branch'
  if (insp.incomplete) return 'git_error'
  return null
}

/** The last `max` UTF-8 bytes of `s`, cut on a character. */
function tailBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s
  const b = Buffer.from(s, 'utf8')
  let start = b.length - max
  // Never start inside a multi-byte character (continuation bytes are 10xxxxxx).
  while (start < b.length && (b[start] & 0xc0) === 0x80) start++
  return b.subarray(start).toString('utf8')
}

/**
 * Files of `dir` named by `re`, oldest first, removed while they are older than `ttlMs` or their total passes
 * `maxBytes` (design 3.3: 30 days or 200 MB per team); `keep` names files never removed (a log being written). File
 * ages are wall-clock times (mtime), never an injected clock. Returns how many went.
 */
export async function pruneLogDir(dir: string, re: RegExp, o: { ttlMs?: number; maxBytes?: number; keep?: ReadonlySet<string>; now?: number } = {}): Promise<number> {
  const ttl = o.ttlMs ?? TEAM_LOG_TTL_MS
  const cap = o.maxBytes ?? TEAM_LOGS_MAX_BYTES
  const now = o.now ?? Date.now()
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return 0
  }
  const files: Array<{ name: string; at: number; size: number }> = []
  for (const name of names) {
    if (!re.test(name) || o.keep?.has(name)) continue
    const st = await fsp.stat(join(dir, name)).catch(() => null)
    if (st?.isFile()) files.push({ name, at: st.mtimeMs, size: st.size })
  }
  files.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1))
  let total = files.reduce((s, f) => s + f.size, 0)
  let gone = 0
  for (const f of files) {
    if (now - f.at <= ttl && total <= cap) break
    await fsp.rm(join(dir, f.name), { force: true }).catch(() => undefined)
    total -= f.size
    gone++
  }
  return gone
}

export interface VerifyRunnerDeps {
  /** The run env base (TeamService: cleanEnv(), no SNAOS_* token); stripped of every app prefix and GIT_* override again here. */
  env: () => Record<string, string>
  /** treeKill.ts treeKillSync: the whole tree (taskkill /T /F; the POSIX group, the child leads it); also each Windows leftover. */
  treeKill: (pid: number) => void
  spawn?: typeof nodeSpawn
  platform?: NodeJS.Platform
  /** The tail as it leaves main (redactCredentials, the live tokens masked). */
  redact?: (s: string) => string
  /** Test seam over the one-shot timers bound to the process (its timeout and the drains after its exit or a kill). */
  setTimer?: (fn: () => void, ms: number) => { clear(): void }
  /** teams.log (a verify whose leftover processes were stopped). */
  log?: (line: string) => void
  /** Test seam over process.kill (the POSIX group signal after the shell exited). */
  kill?: (pid: number, sig: NodeJS.Signals) => void
  /**
   * Windows, after the shell exited (B6 integration, second round): the live processes it started from `sinceMs` to
   * `untilMs` (treeKill.ts childrenSince: their ParentProcessId still names the dead shell; B6 review: never one created
   * after the exit, the pid may be another process's by then). Each is tree-killed.
   */
  children?: (pid: number, sinceMs: number, untilMs: number) => Promise<number[]>
  /** The same query run synchronously (treeKill.ts childrenSinceSync): killAll during the drain after the exit (B6 review). */
  childrenSync?: (pid: number, sinceMs: number, untilMs: number) => number[]
}

const VERIFY_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'ELECTRON_RUN_AS_NODE']

/** The env of a verify: the base minus every SNAOS_ (and legacy) variable and the GIT_* overrides of a polluted app env. */
export function verifyEnv(base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    const up = k.toUpperCase()
    if (typeof v !== 'string' || up.startsWith(BRAND.envPrefix) || up.startsWith(LEGACY_BRAND.envPrefix) || VERIFY_ENV_DROP.includes(up)) continue
    out[k] = v
  }
  return out
}

/**
 * The verify process of design 3.7: the platform's shell by its absolute path (cmd.exe of System32 with `/d /s /c`,
 * else /bin/sh -c; never a shell the cwd could plant), the cleaned env, no window, its own process group on POSIX.
 * stdout and stderr go to `logFile` (capped) and to a rolling tail; at `timeoutMs` the whole tree is killed and the
 * result is `timedOut`. The result is the shell's exit code: once it exits, the timeout no longer applies and its
 * output is read up to VERIFY_EXIT_DRAIN_MS more; a process it left that still holds the pipes then (a daemon, a
 * server) is stopped and the pipes are let go, with a line in the log and a `note` on the result (an exit 0 stays ok;
 * B6 review: the tail carries only what the command printed). Once the shell exited its pid is never signalled alone
 * (it may be another process's by then): POSIX signals its process group, which outlives its leader; Windows keeps no
 * tree for a root that exited, so there every direct child of the dead shell created between the start of the verify
 * and its exit is tree-killed (`children`, one probe), and a deeper process whose own parent already died is only let
 * go. Every verify in flight is tracked: `killAll` stops them (the exit hooks), one in its drain too (B6 review: on
 * Windows its leftovers are probed synchronously there, the app exits right after). One-shot timers bound to the
 * child, never a poll.
 */
export function createVerifyRunner(deps: VerifyRunnerDeps): VerifyRunner {
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? nodeSpawn
  const redact = deps.redact ?? ((s: string) => s)
  const children = deps.children ?? ((pid: number, sinceMs: number, untilMs: number) => childrenSince(pid, sinceMs, untilMs))
  const childrenSync = deps.childrenSync ?? ((pid: number, sinceMs: number, untilMs: number) => childrenSinceSync(pid, sinceMs, untilMs))
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms)
      h.unref?.()
      return { clear: () => clearTimeout(h) }
    })
  /** The stop of each verify in flight (killAll). */
  const inFlight = new Set<() => void>()
  const run: RunVerify = (command, cwd, timeoutMs, logFile, onTail) =>
    new Promise((resolve) => {
      let raw = ''
      const tail = (): string => redact(tailBytes(stripAnsi(raw).replace(/\s+$/, ''), VERIFY_TAIL_MAX_BYTES))
      let log: WriteStream | null = null
      let logged = 0
      try {
        mkdirSync(dirname(logFile), { recursive: true })
        log = createWriteStream(logFile, { flags: 'a', encoding: 'utf8' })
        log.on('error', () => undefined)
        log.write(`$ ${command}\n`)
      } catch {
        log = null
      }
      let done = false
      let timedOut = false
      let lastTail = 0
      /** The shell's exit code once it exited (null: a signal), undefined before. */
      let exited: number | null | undefined
      /** When node saw that exit (wall clock): no process created after it is a child of the shell (B6 review). */
      let exitedAt = 0
      let killTimer: { clear(): void } | null = null
      let drainTimer: { clear(): void } | null = null
      let exitTimer: { clear(): void } | null = null
      let stop: (() => void) | null = null
      /** The drain after the exit is stopping what it left: the result waits for it (its note goes on the result). */
      let sweeping = false
      /**
       * Whether stopping what the exit left found something, once the drain or killAll did it (B6 review), undefined
       * before: it never runs twice (a pid killed once may be another process's by the second time).
       */
      let leftStopped: boolean | undefined
      const finish = (code: number | null, note?: VerifyNote, line = note ? VERIFY_NOTE_LINE[note] : undefined): void => {
        if (done) return
        done = true
        if (stop) inFlight.delete(stop)
        killTimer?.clear()
        drainTimer?.clear()
        exitTimer?.clear()
        // The runner's own words stay English in the log; the tail is only what the command printed (B6 review).
        if (line) log?.write(`\n${line}\n`)
        if (log) {
          log.end(`\n[exit ${timedOut ? 'timeout' : code === null ? 'none' : code}]\n`)
        }
        resolve({ ok: !timedOut && code === 0, timedOut, tail: tail(), ...(note ? { note } : {}) })
      }
      const spawnFailed = (err: unknown): void => finish(null, 'spawnFailed', `[${VERIFY_NOTE_EN.spawnFailed}: ${(err as NodeJS.ErrnoException | null)?.code ?? 'spawn'}]`)
      const file = platform === 'win32' ? win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh'
      const args = platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command]
      // Wall clock, as the process creation times the Windows leftover probe compares it with.
      const started = Date.now()
      let child: ReturnType<typeof nodeSpawn>
      try {
        child = spawn(file, args, { cwd, env: verifyEnv(deps.env()), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32', windowsVerbatimArguments: platform === 'win32' })
      } catch (err) {
        spawnFailed(err)
        return
      }
      const onData = (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        raw += text
        // Only the tail is kept in memory (a few times the cap, the cut lands past the escapes stripAnsi drops).
        if (raw.length > VERIFY_TAIL_MAX_BYTES * 8) raw = raw.slice(-VERIFY_TAIL_MAX_BYTES * 4)
        if (log && logged < VERIFY_LOG_MAX_BYTES) {
          const n = Buffer.byteLength(text, 'utf8')
          if (logged + n > VERIFY_LOG_MAX_BYTES) log.write('\n[verify log cut: the rest is not kept]\n')
          else log.write(text)
          logged += n
        }
        const now = Date.now()
        if (onTail && now - lastTail >= VERIFY_TAIL_EVERY_MS) {
          lastTail = now
          try {
            onTail(tail())
          } catch {
            /* a progress listener never stops the verify */
          }
        }
      }
      // Decoded per stream (a character split across two chunks stays whole).
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      const killTree = (): boolean => {
        const pid = child.pid
        if (typeof pid !== 'number') return false
        try {
          if (exited === undefined) {
            // Until node saw the exit, the pid is still this child's (its handle keeps it): the whole tree.
            deps.treeKill(pid)
            return true
          }
          // After the exit the pid may already be another process's: never the pid alone. The POSIX group outlives its
          // leader while a member lives and its id is not reused meanwhile; Windows keeps no tree for a root that exited.
          if (platform === 'win32') return false
          ;(deps.kill ?? ((p: number, s: NodeJS.Signals) => void process.kill(p, s)))(-pid, 'SIGKILL')
          return true
        } catch {
          return false
        }
      }
      const killEach = (kids: readonly number[]): void => {
        for (const k of kids) {
          try {
            deps.treeKill(k)
          } catch {
            /* already gone */
          }
        }
      }
      /** The Windows probe's window: from the start of the verify to its exit (a child is created before its parent exits). */
      const untilMs = (): number => exitedAt + CREATION_CLOCK_SLACK_MS
      /**
       * After the exit, what it left: POSIX its process group; Windows every direct child of the dead shell created
       * between the start of the verify and its exit (their ParentProcessId still names it), each with its own tree.
       * True when one was.
       */
      const stopLeftovers = async (): Promise<boolean> => {
        if (platform !== 'win32') {
          if (leftStopped === undefined) leftStopped = killTree()
          return leftStopped
        }
        const pid = child.pid
        if (typeof pid !== 'number') return false
        let kids: number[] = []
        try {
          kids = await children(pid, started, untilMs())
        } catch {
          kids = []
        }
        // killAll stopped them while the probe ran.
        if (leftStopped !== undefined) return leftStopped
        killEach(kids)
        leftStopped = kids.length > 0
        return leftStopped
      }
      stop = () => {
        // Until node saw the exit: the whole tree. After it (B6 review) the leftovers, at once: POSIX the group, Windows
        // the probe run synchronously (the exit hooks cannot wait for it, the app may exit right after).
        if (exited === undefined) {
          void killTree()
          return
        }
        if (leftStopped !== undefined) return
        if (platform !== 'win32') {
          leftStopped = killTree()
          return
        }
        const pid = child.pid
        let kids: number[] = []
        try {
          kids = typeof pid === 'number' ? childrenSync(pid, started, untilMs()) : []
        } catch {
          kids = []
        }
        killEach(kids)
        leftStopped = kids.length > 0
        if (leftStopped) {
          try {
            deps.log?.(`verify exited ${exited ?? 'none'}: the exit hooks stopped ${kids.length} process(es) it left`)
          } catch {
            /* a log line never holds the stop */
          }
        }
      }
      inFlight.add(stop)
      child.on('error', (err) => spawnFailed(err))
      child.on('exit', (code) => {
        exited = typeof code === 'number' ? code : null
        exitedAt = Date.now()
        // Killed at the timeout: the drain after that kill lets it go. Else it ended within its time: the timeout no
        // longer applies, only the drain of what it printed is left.
        if (done || exitTimer || timedOut) return
        killTimer?.clear()
        exitTimer = setTimer(() => {
          // Something it started (a daemon, a server) still holds its output: stop it and let the pipes go.
          sweeping = true
          const letGo = (stopped: boolean): void => {
            child.stdout?.destroy()
            child.stderr?.destroy()
            try {
              deps.log?.(`verify exited ${exited ?? 'none'}: a process it left still held its output after ${VERIFY_EXIT_DRAIN_MS} ms and was ${stopped ? 'stopped' : 'let go'}`)
            } catch {
              /* a log line never holds the result */
            }
            finish(exited ?? null, stopped ? 'leftStopped' : 'leftLetGo')
          }
          void stopLeftovers().then(letGo, () => letGo(false))
        }, VERIFY_EXIT_DRAIN_MS)
      })
      // While the drain stops the leftovers their pipes close too: that drain resolves it, with its note. Leftovers
      // killAll stopped (their pipes closed with them) say so too.
      child.on('close', (code) => {
        if (!sweeping) finish(typeof code === 'number' ? code : (exited ?? null), leftStopped ? 'leftStopped' : undefined)
      })
      killTimer = setTimer(() => {
        timedOut = true
        void killTree()
        // A tree that does not close its pipes after the kill: let it go (the result is a timeout either way).
        drainTimer = setTimer(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(null, 'timeoutKill')
        }, VERIFY_KILL_DRAIN_MS)
      }, Math.max(1, timeoutMs))
    })
  return Object.assign(run, {
    killAll: (): number => {
      const all = [...inFlight]
      for (const s of all) s()
      return all.length
    },
    live: (): number => inFlight.size,
  })
}

export class Integrator {
  /** One integrate per repo at a time (across every team): a promise chain per `key(repoRoot)`. */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Temp trees and message files of the integrates in flight: the sweep never removes one. */
  private readonly inFlight = new Set<string>()
  /** Verify logs being written (the prune keeps them). */
  private readonly writing = new Set<string>()
  /** Bumped by halt(): an integrate that began before it ends `interrupted` at its next step. */
  private haltGen = 0

  constructor(private readonly deps: IntegratorDeps) {}

  /** Repos an integrate holds or waits on now (tests; the remove op of a team). */
  busyRepos(): string[] {
    return [...this.chains.keys()]
  }

  /**
   * The app quits or the installer is about to close it (TeamService.shutdownSync, prepareInstall; the verify runner
   * kills its trees at the same time): every integrate already begun, running or waiting for its repo, ends
   * `interrupted` before its next step (never a temp tree, a verify or a land started after this); one that begins
   * later runs as usual. A step already running finishes (a land is never cut).
   */
  halt(): void {
    this.haltGen++
  }

  private globals(teamId: string): string[] {
    return [
      '--no-pager',
      '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'color.ui=never',
      '-c', 'core.safecrlf=false', '-c', 'core.longpaths=true', '-c', `core.hooksPath=${join(this.deps.integrateDir(teamId), NO_HOOKS_DIR)}`,
    ]
  }

  private git(teamId: string, args: string[], cwd: string, timeoutMs = INTEGRATE_QUERY_MS): Promise<string> {
    return this.deps.git.run([...this.globals(teamId), ...args], { cwd, timeoutMs, priority: 'desktop' })
  }

  /** The full sha `ref` names in `cwd`, '' when it does not resolve. */
  private async sha(teamId: string, cwd: string, ref: string): Promise<string> {
    try {
      const s = (await this.git(teamId, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)).trim()
      return FULL_SHA_RE.test(s) ? s.toLowerCase() : ''
    } catch {
      return ''
    }
  }

  private async count(teamId: string, cwd: string, range: string): Promise<number> {
    try {
      const n = Number((await this.git(teamId, ['rev-list', '--count', range], cwd)).trim())
      return Number.isInteger(n) && n >= 0 ? n : 0
    } catch {
      return 0
    }
  }

  /** `merge-base --is-ancestor a b`: exit 0 yes, exit 1 with no stderr no, anything else unknown (decision 70). */
  private async isAncestor(teamId: string, cwd: string, a: string, b: string): Promise<'yes' | 'no' | 'error'> {
    try {
      await this.git(teamId, ['merge-base', '--is-ancestor', a, b], cwd)
      return 'yes'
    } catch (e) {
      return gitExitCode(e) === 1 && stderrOf(e).trim() === '' ? 'no' : 'error'
    }
  }

  private async mergeBase(teamId: string, cwd: string, a: string, b: string): Promise<string | undefined> {
    try {
      const s = (await this.git(teamId, ['merge-base', a, b], cwd)).trim()
      return FULL_SHA_RE.test(s) ? s.toLowerCase() : undefined
    } catch {
      return undefined
    }
  }

  private async identityOk(teamId: string, cwd: string): Promise<boolean> {
    try {
      return (await this.git(teamId, ['var', 'GIT_COMMITTER_IDENT'], cwd)).trim() !== ''
    } catch {
      return false
    }
  }

  /**
   * What the merge `revs` would add that the user's checkout `root` already has untracked or ignored (B6 review, data
   * safety: a fast-forward replaces an ignored file, or empties an ignored folder, without a word): the paths it adds
   * (`diff --diff-filter=A --no-renames`; a changed or deleted path is tracked in a clean checkout on the base) and the
   * folders above them, kept when they are on disk (a path as anything, a folder above it only as a file or a link), then
   * `ls-files -z -o` over those (no exclude: untracked and ignored alike; a folder lists what is in it). Distinct, in
   * git's order; null when git cannot tell.
   */
  private async untrackedInTheWay(teamId: string, root: string, revs: string[]): Promise<string[] | null> {
    let added: string[]
    try {
      added = (await this.git(teamId, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--diff-filter=A', ...revs, '--'], root)).split('\0').filter(Boolean)
    } catch {
      return null
    }
    if (added.length === 0) return []
    const paths = new Set(added)
    const above = new Set<string>()
    for (const p of added) for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) if (!paths.has(p.slice(0, i))) above.add(p.slice(0, i))
    const onDisk: string[] = []
    /** `folderFine`: a folder above an added path, in the way only as a file or a link. */
    const probe = async (rel: string, folderFine: boolean): Promise<void> => {
      const st = await fsp.lstat(join(root, rel)).catch(() => null)
      if (st && (!folderFine || !st.isDirectory())) onDisk.push(rel)
    }
    const all: Array<[string, boolean]> = [...[...paths].map((p): [string, boolean] => [p, false]), ...[...above].map((d): [string, boolean] => [d, true])]
    for (let i = 0; i < all.length; i += LSTAT_BATCH) await Promise.all(all.slice(i, i + LSTAT_BATCH).map(([p, folderFine]) => probe(p, folderFine)))
    // A Set (insertion order is git's): a folder in the way may list many thousands of files.
    const found = new Set<string>()
    // Pathspecs in chunks that keep each command line well under the Windows limit.
    for (let i = 0; i < onDisk.length; ) {
      const chunk: string[] = []
      let len = 0
      while (i < onDisk.length && (chunk.length === 0 || len + onDisk[i].length + 1 <= PATHSPEC_CHUNK_CHARS)) {
        len += onDisk[i].length + 1
        chunk.push(onDisk[i++])
      }
      try {
        for (const f of (await this.git(teamId, ['--literal-pathspecs', 'ls-files', '-z', '-o', '--', ...chunk], root)).split('\0')) if (f) found.add(f)
      } catch {
        return null
      }
    }
    return [...found]
  }

  /**
   * Where the base would land (design 3.7 land A / B): the main checkout on the base -> ff-only when it is clean
   * (tracked files), nothing the merge `incoming` adds is there untracked or ignored (B6 review), no console writes
   * there and no other holder has its lock; the base checked out in another worktree -> that path; checked out nowhere
   * -> CAS update-ref.
   */
  private async landing(teamId: string, repo: ResolvedRepo, base: string, holder: string, incoming?: string[]): Promise<Landing> {
    let list: Array<{ path: string; branch: string | null }>
    try {
      list = parseWorktreeList(await this.git(teamId, ['worktree', 'list', '--porcelain'], repo.repoRoot))
    } catch {
      return { blocked: 'git_error' }
    }
    const ref = `refs/heads/${base}`
    // B close: a rebase or a bisect of the base leaves its worktree detached, yet git counts the base as checked out
    // there (`git branch -f` refuses it) and the rebase's last update_ref would fail on a base moved meanwhile.
    const busy = await this.operationOn(list, base)
    if (busy === 0) return { blocked: 'base_busy' }
    if (busy > 0) return { blocked: 'base_checked_out_elsewhere', path: list[busy].path }
    // git lists the main worktree first.
    if (list[0]?.branch === ref) {
      const key = this.deps.locks.key(repo.repoRoot)
      const held = this.deps.locks.holderOf(key)
      if ((held !== null && held !== holder) || this.deps.locks.busyKeys([repo.repoRoot]).size > 0) return { blocked: 'base_busy' }
      let status: string
      try {
        status = await this.git(teamId, ['status', '--porcelain=v2', '-z', '--untracked-files=no'], repo.repoRoot)
      } catch {
        return { blocked: 'git_error' }
      }
      const dirty = statusPaths(status)
      if (dirty.files.length > 0) return { blocked: 'base_dirty', files: dirty.files, ...(dirty.more > 0 ? { filesMore: dirty.more } : {}) }
      if (incoming) {
        const inTheWay = await this.untrackedInTheWay(teamId, repo.repoRoot, incoming)
        if (inTheWay === null) return { blocked: 'git_error' }
        const more = inTheWay.length - BLOCKING_FILES_MAX
        if (inTheWay.length > 0) return { blocked: 'base_dirty', files: inTheWay.slice(0, BLOCKING_FILES_MAX), ...(more > 0 ? { filesMore: more } : {}) }
      }
      return { mode: 'ffOnly' }
    }
    const other = list.find((w, i) => i > 0 && w.branch === ref)
    if (other) return { blocked: 'base_checked_out_elsewhere', path: other.path }
    return { mode: 'updateRef' }
  }

  /**
   * B close: the index in `list` of the first worktree with a rebase (`rebase-merge/head-name`,
   * `rebase-apply/head-name`) or a bisect (`BISECT_START`, the short name) of `base` in progress in its gitdir, or -1.
   * The gitdir is the worktree's `.git` folder, or the one its `.git` file names; one that cannot be read has none.
   */
  private async operationOn(list: ReadonlyArray<{ path: string }>, base: string): Promise<number> {
    const ref = `refs/heads/${base}`
    const read = (p: string): Promise<string | null> => fsp.readFile(p, 'utf8').then((t) => t.trim(), () => null)
    const busy = await Promise.all(list.map(async (w) => {
      const dotGit = join(w.path, '.git')
      const st = await fsp.lstat(dotGit).catch(() => null)
      if (!st) return false
      let gitDir = dotGit
      if (!st.isDirectory()) {
        const m = /^gitdir:\s*(.+)$/m.exec((await read(dotGit)) ?? '')
        if (!m) return false
        gitDir = resolve(w.path, m[1].trim())
      }
      const [merge, apply, bisect] = await Promise.all([read(join(gitDir, 'rebase-merge', 'head-name')), read(join(gitDir, 'rebase-apply', 'head-name')), read(join(gitDir, 'BISECT_START'))])
      return merge === ref || apply === ref || bisect === base || bisect === ref
    }))
    return busy.indexOf(true)
  }

  /**
   * The preview of design 6.1 (read only): tips, counts, the diff stat, whether the tip is already in the base,
   * whether the merge touches the team definition, the verify command (`installs` when it installs dependencies: the
   * temp tree then gets no node_modules junction) and where it would land (a dirty checkout names its files). A
   * preflight failure (`error`) disables Integrar; a blocked landing says why it would stop there.
   */
  async preview(teamId: string, repo: ResolvedRepo, task: TeamTask, verify: { command: string; confirmed: boolean } | null, suggestions: VerifySuggestion[]): Promise<IntegratePreview> {
    const wt = task.worktree
    const out: IntegratePreview = {
      branch: wt?.branch ?? '',
      base: wt?.baseBranch ?? repo.baseBranch,
      tip: '',
      baseTip: '',
      ahead: 0,
      behind: 0,
      stat: { files: 0, insertions: 0, deletions: 0, top: [] },
      alreadyMerged: false,
      verify: verify ? { command: verify.command, confirmed: verify.confirmed, ...(verifyInstalls(verify.command) ? { installs: true as const } : {}) } : suggestions[0] ? { suggested: suggestions[0].command } : {},
      landing: { blocked: 'git_error' },
      touchesDefinition: false,
    }
    if (!wt) {
      out.error = 'missing_worktree'
      return out
    }
    const holder = integrateHolder(teamId, task.id)
    out.tip = await this.sha(teamId, repo.repoRoot, `refs/heads/${wt.branch}`)
    out.baseTip = await this.sha(teamId, repo.repoRoot, `refs/heads/${wt.baseBranch}`)
    // B6 review: what the branch adds since the merge base (what the merge would bring) against the user's untracked
    // and ignored files too; the land checks the merge commit itself again.
    const land = await this.landing(teamId, repo, wt.baseBranch, holder, out.tip && out.baseTip ? [`${out.baseTip}...${out.tip}`] : undefined)
    out.landing =
      'mode' in land
        ? { mode: land.mode }
        : { blocked: land.blocked, ...(land.path ? { path: land.path } : {}), ...(land.files?.length ? { files: land.files } : {}), ...(land.filesMore ? { filesMore: land.filesMore } : {}) }
    let insp: WorktreeInspectRes
    try {
      insp = await this.deps.worktrees.inspect({ path: wt.path, base: wt.base })
    } catch {
      out.error = 'git_error'
      return out
    }
    const pre = preflightError(insp, wt.branch)
    if (pre) out.error = pre
    if (!out.tip || !out.baseTip) {
      out.error = out.error ?? (out.tip ? 'git_error' : 'missing_worktree')
      return out
    }
    out.ahead = await this.count(teamId, repo.repoRoot, `${out.baseTip}..${out.tip}`)
    out.behind = await this.count(teamId, repo.repoRoot, `${out.tip}..${out.baseTip}`)
    const merged = await this.isAncestor(teamId, repo.repoRoot, out.tip, out.baseTip)
    if (merged === 'error') out.error = out.error ?? 'git_error'
    out.alreadyMerged = merged === 'yes'
    out.stat = await this.diffStat(teamId, repo.repoRoot, out.baseTip, out.tip)
    try {
      const names = await this.git(teamId, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', `${out.baseTip}...${out.tip}`, '--', TEAM_DIR], repo.repoRoot)
      out.touchesDefinition = names.split('\0').some(Boolean)
    } catch {
      out.touchesDefinition = false
    }
    if (!out.error && !out.alreadyMerged && !(await this.identityOk(teamId, repo.repoRoot))) out.error = 'no_identity'
    return out
  }

  /** `diff --numstat` of the merge base to the tip, as the final OK's stat (DIFF_STAT_TOP_MAX files). */
  private async diffStat(teamId: string, cwd: string, baseTip: string, tip: string): Promise<DiffStat> {
    try {
      const rows = parseNumstatZ(await this.git(teamId, ['diff', '--no-ext-diff', '--no-textconv', '-z', '--numstat', '-M', `${baseTip}...${tip}`, '--'], cwd))
      const top = rows
        .map((r) => ({ path: r.path.slice(0, 300), add: r.added ?? 0, del: r.removed ?? 0 }))
        .sort((a, b) => b.add + b.del - (a.add + a.del) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .slice(0, DIFF_STAT_TOP_MAX)
      const sum = sumNumstat(rows)
      return { files: rows.length, insertions: sum.added, deletions: sum.removed, top }
    } catch {
      return { files: 0, insertions: 0, deletions: 0, top: [] }
    }
  }

  private serialRepo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    const tail = next.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return next
  }

  /**
   * One Integrar of `task` into `repo` (design 3.7): the steps above, each reported as `progress` events of
   * `integrationId` (`running` then `ok`, `failed` or `skipped`); the last event is always the `cleanup` step (`ok`
   * after a temp tree, else `skipped`), so the dialog knows the integrate ended. The task worktree is write-locked
   * first (another holder -> `busy`), then the integrate waits for the repo's turn. Resolves with the land or the
   * first failure (its step, files and tail); never throws. The locks of `integrate:<teamId>:<taskId>` are released
   * before it resolves.
   */
  async integrate(
    teamId: string,
    repo: ResolvedRepo,
    task: TeamTask,
    o: { expectTip: string; verify?: { command: string; timeoutMs: number }; integrationId: string; onStep?: (step: IntegrateStep) => void },
  ): Promise<IntegrateResult> {
    const holder = integrateHolder(teamId, task.id)
    const gen = this.haltGen
    let ended = false
    const ev = (step: IntegrateStep, state: IntegrateStepState, extra: Partial<IntegrateProgressEvt> = {}): void => {
      if (state === 'running') {
        try {
          o.onStep?.(step)
        } catch {
          /* the step record never stops an integrate */
        }
      } else if (step === 'cleanup') ended = true
      try {
        this.deps.progress({ teamId, taskId: task.id, integrationId: o.integrationId, step, state, at: this.deps.now(), ...extra })
      } catch {
        /* a progress listener never stops an integrate */
      }
    }
    try {
      const wt = task.worktree
      if (!wt) {
        ev('preflight', 'failed', { error: 'missing_worktree' })
        return { ok: false, error: 'missing_worktree', step: 'preflight' }
      }
      const locks = this.deps.locks
      if (!locks.acquire(locks.key(wt.path), holder)) {
        ev('preflight', 'failed', { error: 'busy' })
        return { ok: false, error: 'busy', step: 'preflight' }
      }
      try {
        return await this.serialRepo(locks.key(repo.repoRoot), () => this.run(teamId, repo, task, wt, o, holder, ev, () => this.haltGen !== gen))
      } catch (err) {
        this.deps.log?.(`integrate ${teamId} ${task.id} failed ${(err as Error).name}`)
        return { ok: false, error: 'git_error', step: 'cleanup' }
      } finally {
        locks.releaseAll(holder)
      }
    } finally {
      // A refusal before any temp tree (preflight, a lock) still ends with its cleanup event.
      if (!ended) ev('cleanup', 'skipped')
    }
  }

  private async run(
    teamId: string,
    repo: ResolvedRepo,
    task: TeamTask,
    wt: NonNullable<TeamTask['worktree']>,
    o: { expectTip: string; verify?: { command: string; timeoutMs: number } },
    holder: string,
    ev: (step: IntegrateStep, state: IntegrateStepState, extra?: Partial<IntegrateProgressEvt>) => void,
    halted: () => boolean,
  ): Promise<IntegrateResult> {
    const root = repo.repoRoot
    const failAt = (step: IntegrateStep, error: IntegrateError, extra: { files?: string[]; tail?: string; mergeBase?: string; verifyNote?: VerifyNote; landing?: 'ffOnly' | 'updateRef' } = {}): IntegrateResult => {
      const note = extra.verifyNote ? { verifyNote: extra.verifyNote } : {}
      const landing = extra.landing ? { landing: extra.landing } : {}
      // The event names the note at the end of the verify only; the result keeps it for the task whatever the step.
      ev(step, 'failed', { error, ...(extra.files?.length ? { files: extra.files } : {}), ...(extra.tail ? { logTail: extra.tail } : {}), ...(step === 'verify' ? note : {}), ...landing })
      return { ok: false, error, step, ...(extra.files?.length ? { files: extra.files } : {}), ...(extra.tail ? { tail: extra.tail } : {}), ...note, ...landing, ...(extra.mergeBase ? { mergeBase: extra.mergeBase } : {}) }
    }

    // 1. preflight
    ev('preflight', 'running')
    // The app began to quit (or the installer to close it) while this one waited for its repo: nothing starts.
    if (halted()) return failAt('preflight', 'interrupted')
    let insp: WorktreeInspectRes
    try {
      insp = await this.deps.worktrees.inspect({ path: wt.path, base: wt.base })
    } catch {
      return failAt('preflight', 'git_error')
    }
    const pre = preflightError(insp, wt.branch)
    if (pre) return failAt('preflight', pre)
    const expect = o.expectTip.toLowerCase()
    // The tip moved since the preview (an agent committed, the user did): look again first.
    if ((insp.tip ?? '').toLowerCase() !== expect) return failAt('preflight', 'busy')
    const tip = await this.sha(teamId, root, `refs/heads/${wt.branch}`)
    const baseTip = await this.sha(teamId, root, `refs/heads/${wt.baseBranch}`)
    if (!tip || !baseTip) return failAt('preflight', 'git_error')
    if (tip !== expect) return failAt('preflight', 'busy')
    const mergeBase = await this.mergeBase(teamId, root, baseTip, tip)
    const merged = await this.isAncestor(teamId, root, tip, baseTip)
    if (merged === 'error') return failAt('preflight', 'git_error', { mergeBase })
    if (merged === 'yes') {
      ev('preflight', 'ok')
      for (const s of ['temp', 'merge', 'verify'] as const) ev(s, 'skipped')
      ev('land', 'ok', { landing: 'alreadyMerged', mergeSha: tip })
      ev('cleanup', 'skipped')
      return { ok: true, mergeSha: tip, base: wt.baseBranch, landed: 'alreadyMerged', ...(mergeBase ? { mergeBase } : {}) }
    }
    if (!(await this.identityOk(teamId, root))) return failAt('preflight', 'no_identity', { mergeBase })
    if (halted()) return failAt('preflight', 'interrupted', { mergeBase })
    ev('preflight', 'ok')

    // 2. temp
    ev('temp', 'running')
    const dir = this.deps.integrateDir(teamId)
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch {
      return failAt('temp', 'git_error', { mergeBase })
    }
    const stamp = `${task.id}-${Math.max(0, Math.floor(this.deps.now()))}`
    const tmp = join(dir, stamp)
    const msg = join(dir, `${stamp}.msg`)
    const tmpKey = this.deps.locks.key(tmp)
    this.inFlight.add(tmp)
    this.inFlight.add(msg)
    this.deps.locks.acquire(tmpKey, holder)
    let created = false
    let junctions: string[] = []
    try {
      try {
        await this.git(teamId, ['worktree', 'add', '--detach', tmp, baseTip], root, INTEGRATE_GIT_TIMEOUT_MS)
        created = true
      } catch (e) {
        created = await fsp.lstat(tmp).then(() => true, () => false)
        return failAt('temp', gitErrorCode(e) === 'timeout' ? 'timeout' : 'git_error', { tail: gitTail(e), mergeBase })
      }
      if (o.verify && verifyInstalls(o.verify.command)) {
        // B6 integration, data safety: an install (npm ci, yarn, pip install...) builds its own node_modules in the temp
        // tree; through the junction it would delete or rewrite the repo's.
        this.deps.log?.(`integrate ${teamId} ${task.id} no node_modules link (the verify installs)`)
      } else {
        try {
          junctions = await this.deps.linkNodeModules(root, tmp)
        } catch {
          // No link: a verify that needs node_modules fails on its own; the merge never needs it.
          junctions = []
        }
      }
      ev('temp', 'ok')

      // 3. merge
      ev('merge', 'running')
      try {
        await fsp.writeFile(msg, mergeMessage(wt.branch, task.title, task.id), { encoding: 'utf8' })
      } catch {
        return failAt('merge', 'git_error', { mergeBase })
      }
      try {
        await this.git(teamId, ['merge', '--no-ff', '--no-edit', '--no-verify', '--no-gpg-sign', '-F', msg, tip], tmp, INTEGRATE_GIT_TIMEOUT_MS)
      } catch (e) {
        let files: string[] = []
        try {
          files = (await this.git(teamId, ['diff', '--no-ext-diff', '--name-only', '--diff-filter=U', '-z'], tmp)).split('\0').filter(Boolean)
        } catch {
          files = []
        }
        await this.git(teamId, ['merge', '--abort'], tmp).catch(() => undefined)
        if (gitErrorCode(e) === 'timeout') return failAt('merge', 'timeout', { mergeBase })
        // Never a conflict without its files (decision 70): anything else is git's own error, with what it said.
        if (files.length > 0) return failAt('merge', 'merge_conflict', { files: files.slice(0, BLOCKING_FILES_MAX * 4), mergeBase })
        return failAt('merge', 'git_error', { tail: gitTail(e), mergeBase })
      }
      const mergeSha = await this.sha(teamId, tmp, 'HEAD')
      if (!mergeSha || mergeSha === baseTip) return failAt('merge', 'git_error', { mergeBase })
      ev('merge', 'ok', { mergeSha })

      // 4. verify
      let verifyTail: string | undefined
      let verifyNote: VerifyNote | undefined
      if (o.verify) {
        if (halted()) return failAt('verify', 'interrupted', { mergeBase })
        ev('verify', 'running')
        const logName = `${stamp}.log`
        this.writing.add(logName)
        let res: VerifyResult
        try {
          res = await this.deps.runVerify(o.verify.command, tmp, o.verify.timeoutMs, join(this.deps.verifyLogDir(teamId), logName), (t) => ev('verify', 'running', { logTail: t }))
        } catch {
          res = { ok: false, timedOut: false, tail: '' }
        } finally {
          this.writing.delete(logName)
        }
        verifyNote = res.note
        // Stopped by the exit hooks (halt and the runner's killAll): never a verify failure the Dev should fix.
        if (halted()) return failAt('verify', 'interrupted', { tail: res.tail, mergeBase, verifyNote })
        if (!res.ok) return failAt('verify', res.timedOut ? 'verify_timeout' : 'verify_failed', { tail: res.tail, mergeBase, verifyNote })
        verifyTail = res.tail
        ev('verify', 'ok', { ...(res.tail ? { logTail: res.tail } : {}), ...(verifyNote ? { verifyNote } : {}) })
      } else ev('verify', 'skipped')

      // 5. land
      if (halted()) return failAt('land', 'interrupted', { mergeBase, verifyNote })
      ev('land', 'running')
      const landed = await this.land(teamId, repo, wt.baseBranch, baseTip, mergeSha, holder)
      if (!landed.ok) return failAt('land', landed.error, { files: landed.files, tail: landed.tail, mergeBase, verifyNote, landing: landed.landing })
      ev('land', 'ok', { landing: landed.landed, mergeSha })
      return { ok: true, mergeSha, base: wt.baseBranch, landed: landed.landed, ...(verifyTail ? { verifyTail } : {}), ...(verifyNote ? { verifyNote } : {}), ...(mergeBase ? { mergeBase } : {}) }
    } finally {
      // 6. cleanup, always (never fails the result).
      ev('cleanup', 'running')
      if (created) await this.removeTemp(teamId, root, tmp, junctions)
      await fsp.rm(msg, { force: true }).catch(() => undefined)
      this.deps.locks.release(tmpKey, holder)
      this.inFlight.delete(tmp)
      this.inFlight.delete(msg)
      await this.pruneVerifyLogs(teamId)
      ev('cleanup', 'ok')
    }
  }

  /**
   * Land A (the main checkout on the base: CAS on its HEAD, then `merge --ff-only`) or land B (`update-ref` CAS).
   * Nothing of the user's checkout moves before the land itself; a refusal leaves it as it was. A failure once the
   * mode is known names it (`landing`, B6 review second round): only an ffOnly timeout may have half updated the checkout.
   */
  private async land(teamId: string, repo: ResolvedRepo, base: string, baseTip: string, mergeSha: string, holder: string): Promise<{ ok: true; landed: 'ffOnly' | 'updateRef' } | { ok: false; error: IntegrateError; files?: string[]; tail?: string; landing?: 'ffOnly' | 'updateRef' }> {
    const root = repo.repoRoot
    const where = await this.landing(teamId, repo, base, holder, [baseTip, mergeSha])
    if (!('mode' in where)) return { ok: false, error: where.blocked, ...(where.files?.length ? { files: where.files } : {}) }
    if (where.mode === 'ffOnly') {
      const landing = 'ffOnly' as const
      const locks = this.deps.locks
      if (!locks.acquire(locks.key(root), holder)) return { ok: false, error: 'base_busy', landing }
      // CAS on the checkout: still the base and still the tip the merge was built on (a reset or a commit since is base_moved).
      let sym = ''
      try {
        sym = (await this.git(teamId, ['rev-parse', '--symbolic-full-name', 'HEAD'], root)).trim()
      } catch {
        return { ok: false, error: 'git_error', landing }
      }
      if (sym !== `refs/heads/${base}`) return { ok: false, error: 'base_moved', landing }
      if ((await this.sha(teamId, root, 'HEAD')) !== baseTip) return { ok: false, error: 'base_moved', landing }
      try {
        // --no-overwrite-ignore (B6 review): git's default replaces an ignored file of the user (a .env) the merge tracks.
        await this.git(teamId, ['merge', '--ff-only', '--no-overwrite-ignore', mergeSha], root, INTEGRATE_LAND_TIMEOUT_MS)
      } catch (e) {
        const err = stderrOf(e)
        if (OVERWRITE_RE.test(err)) return { ok: false, error: 'base_dirty', files: overwrittenFiles(err), landing }
        if (gitErrorCode(e) === 'timeout') return { ok: false, error: 'timeout', landing }
        return { ok: false, error: 'base_moved', tail: gitTail(e), landing }
      }
      return { ok: true, landed: 'ffOnly' }
    }
    const landing = 'updateRef' as const
    try {
      await this.git(teamId, ['update-ref', '-m', 'snagentsos: integrate', `refs/heads/${base}`, mergeSha, baseTip], root)
    } catch (e) {
      if (/but expected/i.test(stderrOf(e))) return { ok: false, error: 'base_moved', landing }
      return { ok: false, error: gitErrorCode(e) === 'timeout' ? 'timeout' : 'git_error', tail: gitTail(e), landing }
    }
    return { ok: true, landed: 'updateRef' }
  }

  /** The guard of a temp tree removal: strictly inside the team's integrate folder, nothing else. */
  private guardOf(teamId: string): PathGuard {
    return { forbiddenExact: [], forbiddenTree: [], forbiddenContain: [], allowedRoots: [this.deps.integrateDir(teamId)] }
  }

  /**
   * A temp tree goes: its junctions first, as links (a failure keeps git away from the folder: `worktree remove`
   * is left out and the guarded removal never follows a link), `worktree remove --force`, the guarded removal for
   * whatever is left, `worktree prune`.
   */
  private async removeTemp(teamId: string, root: string, tmp: string, junctions: readonly string[]): Promise<void> {
    let linksGone = true
    for (const link of [...junctions].reverse()) {
      try {
        await unlinkLink(link)
      } catch {
        linksGone = false
      }
    }
    if (linksGone) await this.git(teamId, ['worktree', 'remove', '--force', tmp], root, INTEGRATE_GIT_TIMEOUT_MS).catch(() => undefined)
    if (await fsp.lstat(tmp).then(() => true, () => false)) {
      const res = await this.deps.removeTree(tmp, this.guardOf(teamId), { retries: 3, delayMs: 200 }).catch(() => null)
      if (res && typeof res === 'object') this.deps.log?.(`integrate ${teamId} temp left ${'deferred' in res ? 'deferred' : 'skipped'}`)
    }
    await this.git(teamId, ['worktree', 'prune'], root).catch(() => undefined)
  }

  /** Verify logs past 30 days or 200 MB of the team (design 3.3), never one being written. */
  pruneVerifyLogs(teamId: string, o: { maxBytes?: number; ttlMs?: number } = {}): Promise<number> {
    return pruneLogDir(this.deps.verifyLogDir(teamId), VERIFY_LOG_RE, { ...o, keep: this.writing })
  }

  /**
   * At enable (design 3.7): what a quit mid-integrate left in `teams/<id>/integrate/` (temp trees, message files)
   * goes, never one of an integrate still in flight in this app (a Labs toggle), then, when something went,
   * `worktree prune` in the main repo and every resolved extra repo; then the verify log prune.
   */
  async sweep(teamId: string, repoRoots: readonly string[]): Promise<void> {
    const dir = this.deps.integrateDir(teamId)
    let names: string[] = []
    try {
      names = await fsp.readdir(dir)
    } catch {
      names = []
    }
    let swept = 0
    for (const name of names) {
      const p = join(dir, name)
      if (this.inFlight.has(p)) continue
      if (MSG_NAME_RE.test(name)) {
        await fsp.rm(p, { force: true }).catch(() => undefined)
        swept++
      } else if (TEMP_NAME_RE.test(name)) {
        const res = await this.deps.removeTree(p, this.guardOf(teamId), { retries: 3, delayMs: 200 }).catch(() => null)
        if (res === 'done' || res === 'absent') swept++
      }
    }
    // git's record of a removed temp tree goes with a prune; with nothing swept there is nothing of ours to prune.
    if (swept > 0) {
      for (const r of repoRoots) await this.git(teamId, ['worktree', 'prune'], r).catch(() => undefined)
      this.deps.log?.(`integrate ${teamId} swept ${swept}`)
    }
    await this.pruneVerifyLogs(teamId)
  }
}
