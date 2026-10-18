/**
 * The only way main runs git (E7 Design B). Read-only and side-effect free:
 *  - the env drops GIT_DIR and friends, so a polluted app env never points a
 *    query at another repo, and adds GIT_OPTIONAL_LOCKS=0 (status never takes
 *    index.lock while an agent commits), GIT_TERMINAL_PROMPT=0 (no credential
 *    prompt) and LC_ALL=C (stable stderr to classify);
 *  - a fixed `-c` prefix turns off fsmonitor and path quoting, and keeps diff
 *    from refreshing the index;
 *  - a global semaphore runs at most 2 git processes, and a remote (phone)
 *    request can only ever hold 1 of them, so the desktop always has a slot.
 * Flag and env pattern after Orca's status-line-stats.ts and git-process-env.ts
 * (flags only, no code copied).
 */
import { execFile as nodeExecFile } from 'child_process'
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
  ) {
    super(message)
    this.name = 'GitExecError'
  }
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
  gitBin?: string
}

/** A git runner with its own semaphore. The app uses the `gitRunner` singleton. */
export function createGitRunner(deps: GitRunnerDeps = {}): GitRunner {
  const exec: ExecFileFn = deps.execFile ?? (nodeExecFile as unknown as ExecFileFn)
  const envOf = deps.env ?? (() => gitEnv())
  const platform = deps.platform ?? process.platform
  const bin = deps.gitBin ?? 'git'
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
            const code = classifyGitError(err, errText)
            reject(new GitExecError(code, errText.trim() || err.message, errText))
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
      const release = await acquire(opts.priority ?? 'desktop')
      try {
        const { stdout } = await execRaw(bin, [...GIT_PREFIX, ...args], opts.cwd, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.maxBuffer ?? 16 * 1024 * 1024)
        return stdout
      } finally {
        release()
      }
    },
    info(force = false) {
      if (infoCache && !force) return infoCache
      infoCache = (async (): Promise<GitInfoRes> => {
        let version: number[] | null = null
        let raw = ''
        try {
          raw = (await execRaw(bin, ['--version'], process.cwd(), 5000, 64 * 1024)).stdout.trim()
          version = parseGitVersion(raw)
        } catch {
          return { available: false }
        }
        let where: string | undefined
        try {
          const out = await execRaw(platform === 'win32' ? 'where' : 'which', [bin], process.cwd(), 5000, 64 * 1024)
          where = out.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
        } catch {
          /* the version is what matters; the path is a hint */
        }
        const label = version ? version.join('.') : raw.replace(/^git version\s*/, '')
        return { available: true, version: label, path: where, tooOld: version ? versionTooOld(version) : false }
      })()
      return infoCache
    },
  }
}

export const gitRunner = createGitRunner()
