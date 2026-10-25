/**
 * The only way main runs git (E7 Design B). The chip and the panel only read;
 * WorktreeService (E7 Design F) runs its few writes (worktree add / prune,
 * branch -D) through the same binary resolution, env and semaphore:
 *  - the env drops GIT_DIR and friends, so a polluted app env never points a
 *    query at another repo, and adds GIT_OPTIONAL_LOCKS=0 (status never takes
 *    index.lock while an agent commits), GIT_TERMINAL_PROMPT=0 (no credential
 *    prompt) and LC_ALL=C (stable stderr to classify);
 *  - a fixed `-c` prefix turns off fsmonitor and path quoting, and keeps diff
 *    from refreshing the index;
 *  - a global semaphore runs at most 2 git processes, and a remote (phone)
 *    request can only ever hold 1 of them, so the desktop always has a slot.
 *  - git runs by its absolute path, found in the absolute PATH entries only:
 *    on Windows a bare `git` is searched in the cwd first, so a repo holding
 *    its own git.exe would otherwise run it as soon as its chip refreshes.
 * Flag and env pattern after Orca's status-line-stats.ts and git-process-env.ts
 * (flags only, no code copied).
 */
import { execFile as nodeExecFile } from 'child_process'
import { existsSync, statSync } from 'fs'
import { posix, win32 } from 'path'
import type { GitError, GitInfoRes } from '@shared/git-types'

export const GIT_PREFIX = ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false']
const STRIPPED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CEILING_DIRECTORIES']
export const MAX_GIT_PROCS = 2
/** Slots a remote request can never take. */
export const DESKTOP_RESERVED = 1
export const DEFAULT_TIMEOUT_MS = 10000
export const MIN_GIT_VERSION: [number, number] = [2, 20]

export type GitPriority = 'desktop' | 'remote'

export interface RunGitOpts {
  cwd: string
  timeoutMs?: number
  maxBuffer?: number
  priority?: GitPriority
}

export class GitExecError extends Error {
  constructor(
    readonly code: GitError,
    message: string,
    readonly stderr = '',
    /** App 2.7.0 (B5 integration, fifth round): stdout passed maxBuffer (Node's code), even when git also wrote to stderr. */
    readonly maxBuffer = false,
  ) {
    super(message)
    this.name = 'GitExecError'
  }
}

/** Node's execFile error past maxBuffer (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`; an older Node says it in the message only). */
const MAX_BUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

/** True when a run's output passed its maxBuffer (by shape, so it survives bundling boundaries). */
export function gitOverflowed(e: unknown): boolean {
  return (e as { maxBuffer?: unknown } | null)?.maxBuffer === true
}

type ExecCallback = (err: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string, stderr: string) => void
export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean; encoding: 'utf8' },
  cb: ExecCallback,
) => unknown

/** process.env minus the GIT_* overrides (case-insensitively, as Windows env is), plus our fixed vars. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (STRIPPED_ENV.includes(k.toUpperCase())) continue
    env[k] = v
  }
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  return env
}

const GIT_ERRORS: ReadonlySet<string> = new Set<GitError>(['not_repo', 'git_missing', 'git_old', 'unsafe_repo', 'timeout', 'git_error'])

/** The error class of anything a run threw (by shape, so it survives bundling boundaries). */
export function gitErrorCode(e: unknown): GitError {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && GIT_ERRORS.has(code) ? (code as GitError) : 'git_error'
}

/** stderr / exec error -> the chip's error code. */
export function classifyGitError(err: { code?: unknown; killed?: boolean; signal?: unknown } | null, stderr: string): GitError {
  if (err?.code === 'ENOENT') return 'git_missing'
  if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') return 'timeout'
  const s = stderr.toLowerCase()
  if (s.includes('detected dubious ownership') || s.includes('safe.directory')) return 'unsafe_repo'
  if (s.includes('not a git repository')) return 'not_repo'
  return 'git_error'
}

/** "git version 2.45.1.windows.1" -> [2, 45, 1]. */
export function parseGitVersion(out: string): number[] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

export function versionTooOld(v: number[]): boolean {
  return v[0] < MIN_GIT_VERSION[0] || (v[0] === MIN_GIT_VERSION[0] && v[1] < MIN_GIT_VERSION[1])
}

/** Case-insensitive env lookup (Windows keeps `Path`, POSIX keeps `PATH`). */
function envValue(env: NodeJS.ProcessEnv, key: string): string {
  const hit = Object.keys(env).find((k) => k.toUpperCase() === key)
  return (hit && env[hit]) || ''
}

const defaultIsFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Absolute path of `name` from the absolute PATH entries, or null. Never the
 * cwd and never a relative PATH entry (both would let a repo plant its own
 * git). On Windows only .exe / .com, which execFile runs without a shell.
 */
export function resolveGitBin(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = defaultIsFile,
  name = 'git',
): string | null {
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const candidates = win ? (/\.(exe|com)$/i.test(name) ? [name] : [`${name}.exe`, `${name}.com`]) : [name]
  for (const raw of envValue(env, 'PATH').split(p.delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    // Windows: a drive path or UNC only; "\dir" hangs off the cwd's drive.
    if (!dir || !p.isAbsolute(dir) || (win && !/^([a-z]:[\\/]|\\\\)/i.test(dir))) continue
    for (const c of candidates) {
      const hit = p.join(dir, c)
      if (isFile(hit)) return hit
    }
  }
  return null
}

interface Waiter {
  priority: GitPriority
  start: () => void
}

export interface GitRunner {
  run(args: string[], opts: RunGitOpts): Promise<string>
  info(force?: boolean): Promise<GitInfoRes>
  /** Processes currently running (tests). */
  readonly running: number
}

export interface GitRunnerDeps {
  execFile?: ExecFileFn
  env?: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Fixed git binary (tests). Default: resolveGitBin over the env's PATH. */
  gitBin?: string
  isFile?: (p: string) => boolean
}

/** A git runner with its own semaphore. The app uses the `gitRunner` singleton. */
export function createGitRunner(deps: GitRunnerDeps = {}): GitRunner {
  const exec: ExecFileFn = deps.execFile ?? (nodeExecFile as unknown as ExecFileFn)
  const envOf = deps.env ?? (() => gitEnv())
  const platform = deps.platform ?? process.platform
  let bin: string | null | undefined = deps.gitBin
  const binOf = (force = false): string | null => {
    if (deps.gitBin) return deps.gitBin
    if (bin === undefined || force) bin = resolveGitBin(envOf(), platform, deps.isFile)
    return bin
  }
  let running = 0
  let remoteRunning = 0
  const queue: Waiter[] = []
  let infoCache: Promise<GitInfoRes> | null = null

  const canStart = (p: GitPriority): boolean =>
    running < MAX_GIT_PROCS && (p === 'desktop' || remoteRunning < MAX_GIT_PROCS - DESKTOP_RESERVED)

  const pump = (): void => {
    // Desktop waiters first, then remote ones while they fit.
    for (const pass of ['desktop', 'remote'] as const) {
      for (let i = 0; i < queue.length; ) {
        const w = queue[i]
        if (w.priority === pass && canStart(w.priority)) {
          queue.splice(i, 1)
          w.start()
        } else i++
      }
    }
  }

  const acquire = (priority: GitPriority): Promise<() => void> =>
    new Promise((resolve) => {
      const start = (): void => {
        running++
        if (priority === 'remote') remoteRunning++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          running--
          if (priority === 'remote') remoteRunning--
          pump()
        })
      }
      // Never jump ahead of a queued waiter of the same or a higher priority.
      const waiting = priority === 'desktop' ? queue.some((w) => w.priority === 'desktop') : queue.length > 0
      if (canStart(priority) && !waiting) start()
      else {
        queue.push({ priority, start })
        pump()
      }
    })

  const execRaw = (file: string, args: string[], cwd: string, timeoutMs: number, maxBuffer: number): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      try {
        exec(file, args, { cwd, env: envOf(), timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
          const errText = String(stderr ?? '')
          if (err) {
            // A spawn ENOENT with a git we just found means the cwd is gone, not git.
            const code = err.code === 'ENOENT' && !existsSync(cwd) ? 'not_repo' : classifyGitError(err, errText)
            const overflow = err.code === MAX_BUFFER_CODE || /maxBuffer/i.test(err.message)
            reject(new GitExecError(code, errText.trim() || err.message, errText, overflow))
          } else resolve({ stdout: String(stdout ?? ''), stderr: errText })
        })
      } catch (e) {
        reject(new GitExecError(classifyGitError(e as { code?: unknown }, ''), (e as Error).message))
      }
    })

  return {
    get running() {
      return running
    },
    async run(args, opts) {
      const file = binOf()
      if (!file) throw new GitExecError('git_missing', 'git not found in PATH')
      const release = await acquire(opts.priority ?? 'desktop')
      try {
        const { stdout } = await execRaw(file, [...GIT_PREFIX, ...args], opts.cwd, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.maxBuffer ?? 16 * 1024 * 1024)
        return stdout
      } finally {
        release()
      }
    },
    info(force = false) {
      if (infoCache && !force) return infoCache
      infoCache = (async (): Promise<GitInfoRes> => {
        const file = binOf(force)
        if (!file) return { available: false }
        let version: number[] | null = null
        let raw = ''
        try {
          raw = (await execRaw(file, ['--version'], platform === 'win32' ? win32.dirname(file) : posix.dirname(file), 5000, 64 * 1024)).stdout.trim()
          version = parseGitVersion(raw)
        } catch {
          return { available: false }
        }
        const label = version ? version.join('.') : raw.replace(/^git version\s*/, '')
        return { available: true, version: label, path: deps.gitBin ? undefined : file, tooOld: version ? versionTooOld(version) : false }
      })()
      return infoCache
    },
  }
}

export const gitRunner = createGitRunner()
