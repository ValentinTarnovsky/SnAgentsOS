// Adaptado de paperclipai/paperclip (MIT) - packages/adapter-utils/src/server-utils.ts
/**
 * The processes of team runs (app 2.7.0, E10 B2, design 3.5): the only owner
 * of a run's child process (3.0 item 3). Spawn and kill rules ported from
 * paperclip's runChildProcess: no shell, a process group on POSIX, stdin
 * written once with its EPIPE swallowed, the result resolved on `close`
 * (never `exit`), the stdout split into lines that feed the stream parser,
 * the run log and the hooks.
 *
 * Timing (design 3.5 "Run timing", keys of 3.10, all on the shared
 * DeadlineTimer): the first result line arms `run:<id>:linger` (whatever is
 * left alive then is tree-killed while its parent still lives, S5); an
 * `exit` without `close` arms `run:<id>:drain`; a stop signals the tree and
 * arms `run:<id>:stop` (and `run:<id>:kill` on POSIX). The `max` and
 * `conclude` keys belong to TeamService.
 *
 * Once Node emitted `exit` for a run its pid is reaped and the OS may hand it
 * to another process, so no path signals that pid again (decision 64): on
 * win32 nothing is signalled after the exit (taskkill /T could not reach a
 * grandchild whose parent is gone anyway; the drain destroys stdio and logs
 * the orphan), on POSIX only the process group, whose pgid stays reserved
 * while a member lives.
 */
import type { ChildProcess } from 'child_process'
import type { ChatMessage } from '@shared/chat-types'
import { redactCredentials } from '@shared/redact'
import { DRAIN_MS, LINGER_MS, PARSER_LINE_MAX_BYTES, POSIX_KILL_GRACE_MS, STOP_GRACE_MS, type RunMode, type WakeReason } from '@shared/teams'
import type { AgentProvider } from '@shared/types'
import type { DeadlineTimer } from '../DeadlineTimer'
import type { signalTree, treeKillSync } from '../proc/treeKill'
import { spawnTarget, type ResolvedCli } from './agentCli'
import type { RunEnd } from './flow/runs'
import { createClaudeStreamParser } from './parsers/claudeStream'
import { createCodexExecParser } from './parsers/codexExec'
import type { SessionBase, StreamParser } from './parsers/types'
import { RunLog } from './RunLog'

/** Stderr kept for the failure text and the log (the tail). */
export const STDERR_TAIL_BYTES = 16 * 1024

export interface RunSpec {
  runId: string; teamId: string; agentId: string; provider: AgentProvider
  cli: ResolvedCli; argv: string[]; cwd: string; env: Record<string, string>; stdin: string; logFile: string
  promptMeta: { mode: RunMode; trigger: WakeReason }; base: SessionBase
}
export interface RunHooks {
  firstLine(runId: string, at: number, sessionId?: string): void
  /** RunLog items, for the watched run. */
  append(runId: string, items: ChatMessage[], at: number): void
  /** Every line; TeamService throttles the synthetic refresh. */
  signal(runId: string, at: number): void
  result(runId: string, at: number): void
  closed(runId: string, end: RunEnd & { stderrTail: string; logBytes: number; logCut: boolean }): void
  spawnFailed(runId: string, detail: string): void
}
export interface RunSupervisorDeps {
  spawn: typeof import('child_process').spawn
  treeKill: { sync: typeof treeKillSync; signal: typeof signalTree }
  /** POSIX, after a run's `exit`: kill(-pid, sig), the group alone, never the bare pid. Default process.kill(-pid, sig). */
  groupKill?: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void
  timer: DeadlineTimer<string>
  now: () => number
  platform: NodeJS.Platform
  hooks: RunHooks
  log: (l: string) => void
}

interface Live {
  spec: RunSpec
  child: ChildProcess
  pid: number
  parser: StreamParser
  log: RunLog
  /** Chunks of the line being read and their total size. */
  partial: Buffer[]
  partialBytes: number
  /** The line being read is over PARSER_LINE_MAX_BYTES: dropped up to its newline. */
  skipping: boolean
  stderr: string
  sawLine: boolean
  sawResult: boolean
  exited: boolean
  exit: { code: number | null; signal: string | null }
  stopping: boolean
  done: boolean
  lastLineAt?: number
}

const KEYS = ['linger', 'drain', 'stop', 'kill'] as const

/** The process group of a POSIX run (it spawns `detached`, so its pid is the pgid). */
const groupKillPosix = (pid: number, sig: 'SIGTERM' | 'SIGKILL'): void => {
  process.kill(-pid, sig)
}

export class RunSupervisor {
  private readonly runs = new Map<string, Live>()

  constructor(private readonly deps: RunSupervisorDeps) {}

  /**
   * spawn(target.file, target.args, {cwd, env, stdio: pipe x3, windowsHide: true, detached: platform !== 'win32', shell: false, windowsVerbatimArguments: target.verbatim});
   * child.stdin.on('error', noop) BEFORE writing; stdin.end(spec.stdin) once; lines split on \n; every line up to
   * PARSER_LINE_MAX_BYTES reaches the parser (a `result` line can carry a denied Write's whole content in
   * permission_denials[].tool_input); RunLog and the ring get a skipped marker instead of a line over MAX_RECORD_BYTES;
   * a line over PARSER_LINE_MAX_BYTES is dropped for both (logged); resolves on 'close', not 'exit'.
   */
  start(spec: RunSpec): { ok: true; pid: number } | { ok: false; detail: string } {
    if (this.runs.has(spec.runId)) return { ok: false, detail: 'duplicate' }
    const target = spawnTarget(spec.cli, spec.argv)
    let child: ChildProcess
    try {
      child = this.deps.spawn(target.file, target.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: this.deps.platform !== 'win32',
        shell: false,
        windowsVerbatimArguments: target.verbatim,
      })
    } catch (err) {
      return { ok: false, detail: (err as NodeJS.ErrnoException).code ?? 'spawn' }
    }
    if (typeof child.pid !== 'number') {
      // ENOENT and friends: node reports them on the next tick; swallow it, the caller fails the run now.
      child.on('error', () => undefined)
      return { ok: false, detail: 'spawn' }
    }
    const log = new RunLog({ file: spec.logFile, provider: spec.provider, runId: spec.runId, now: this.deps.now })
    const live: Live = {
      spec, child, pid: child.pid,
      parser: spec.provider === 'codex' ? createCodexExecParser() : createClaudeStreamParser(),
      log, partial: [], partialBytes: 0, skipping: false, stderr: '',
      sawLine: false, sawResult: false, exited: false, exit: { code: null, signal: null }, stopping: false, done: false,
    }
    this.runs.set(spec.runId, live)
    const promptItems = log.writePrompt(spec.stdin, spec.promptMeta)
    if (promptItems.length) this.deps.hooks.append(spec.runId, promptItems, this.deps.now())

    // Node emits `spawn` once the process really started; an `error` before it is a spawn failure.
    let spawned = false
    child.once('spawn', () => {
      spawned = true
    })
    child.on('error', (err) => {
      this.deps.log(`run ${spec.runId} process error ${(err as NodeJS.ErrnoException).code ?? err.name}`)
      if (!spawned && !live.sawLine && !live.exited && !live.done) {
        this.cleanup(live)
        this.deps.hooks.spawnFailed(spec.runId, (err as NodeJS.ErrnoException).code ?? 'spawn')
      }
    })
    child.stdin?.on('error', () => undefined)
    child.stdout?.on('data', (chunk: Buffer) => this.onData(live, chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      live.stderr = (live.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    child.on('exit', (code, signal) => {
      live.exited = true
      live.exit = { code, signal }
      if (!live.done) this.deps.timer.set(this.key(spec.runId, 'drain'), this.deps.now() + DRAIN_MS)
    })
    child.on('close', (code, signal) => {
      if (!live.exited) live.exit = { code, signal }
      live.exited = true
      this.finalize(live, 'close')
    })
    try {
      child.stdin?.end(spec.stdin)
    } catch {
      /* the child died before reading its prompt: close reports it */
    }
    return { ok: true, pid: child.pid }
  }

  /** The live last-line time of a run (memory; views, the synthetic status and the run SilenceWatch read it; Run.lastLineAt is written only by real commits). */
  lastLineAt(runId: string): number | undefined {
    return this.runs.get(runId)?.lastLineAt
  }

  /**
   * First call: signalTree SIGTERM (POSIX, plus run:<id>:kill at +POSIX_KILL_GRACE_MS) or taskkill (win32), arms run:<id>:stop at +STOP_GRACE_MS.
   * Idempotent. After the run's `exit` only the POSIX group is signalled, nothing on win32.
   */
  stop(runId: string): void {
    const live = this.runs.get(runId)
    if (!live || live.stopping || live.done) return
    live.stopping = true
    const now = this.deps.now()
    if (this.deps.platform === 'win32') this.kill(live, 'stop')
    else {
      this.signal(live, 'SIGTERM')
      this.deps.timer.set(this.key(runId, 'kill'), now + POSIX_KILL_GRACE_MS)
    }
    this.deps.timer.set(this.key(runId, 'stop'), now + STOP_GRACE_MS)
  }

  /** Handles run:<id>:{linger,drain,stop,kill}; false for other keys. */
  onDeadline(key: string): boolean {
    const m = /^run:(r-[a-f0-9]{12}):(linger|drain|stop|kill)$/.exec(key)
    if (!m) return false
    const live = this.runs.get(m[1])
    if (!live || live.done) return true
    switch (m[2]) {
      case 'linger':
        // A result is out and something still runs (a background task, a grandchild): kill the tree now.
        if (!live.exited) {
          this.deps.log(`run ${live.spec.runId} linger kill`)
          this.kill(live, 'linger')
        }
        break
      case 'kill':
        this.signal(live, 'SIGKILL')
        break
      case 'drain':
        // The parent exited but a grandchild holds the pipes: take the POSIX group down (never the reaped pid), then let go.
        this.deps.log(`run ${live.spec.runId} drain (stdio held after exit)`)
        this.kill(live, 'drain')
        this.destroyStdio(live)
        this.finalize(live, 'drain')
        break
      case 'stop':
        this.kill(live, 'stop')
        this.destroyStdio(live)
        this.finalize(live, 'stop')
        break
    }
    return true
  }

  isAlive(runId: string): boolean {
    const live = this.runs.get(runId)
    return !!live && !live.done && !live.exited
  }

  ring(runId: string): readonly ChatMessage[] | null {
    return this.runs.get(runId)?.log.ring ?? null
  }

  /** The cut point of a live run's log (RunLog.page). */
  cutAt(runId: string): number | null {
    return this.runs.get(runId)?.log.cutAt ?? null
  }

  /** treeKillSync every child (after an exit: the POSIX group only), destroy stdio, close logs; returns the run ids. No hook fires. */
  shutdownSync(): string[] {
    const ids: string[] = []
    for (const live of [...this.runs.values()]) {
      ids.push(live.spec.runId)
      // Also after an exit: on POSIX the group may still hold a grandchild (a drain in progress); `kill` never signals the reaped pid.
      this.kill(live, 'shutdown')
      this.destroyStdio(live)
      this.cleanup(live)
    }
    return ids
  }

  // ---- internals -------------------------------------------------------------------------------

  private key(runId: string, kind: (typeof KEYS)[number]): string {
    return `run:${runId}:${kind}`
  }

  private onData(live: Live, chunk: Buffer): void {
    if (live.done) return
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(0x0a, start)
      if (nl < 0) {
        this.keep(live, chunk.subarray(start))
        return
      }
      this.keep(live, chunk.subarray(start, nl))
      this.flushLine(live)
      start = nl + 1
    }
  }

  private keep(live: Live, part: Buffer): void {
    if (!part.length || live.skipping) return
    if (live.partialBytes + part.length > PARSER_LINE_MAX_BYTES) {
      live.skipping = true
      live.partial = []
      live.partialBytes = 0
      return
    }
    live.partial.push(Buffer.from(part))
    live.partialBytes += part.length
  }

  private flushLine(live: Live): void {
    if (live.skipping) {
      live.skipping = false
      this.deps.log(`run ${live.spec.runId} line over ${PARSER_LINE_MAX_BYTES} bytes dropped`)
      return
    }
    const buf = live.partial.length === 1 ? live.partial[0] : Buffer.concat(live.partial, live.partialBytes)
    live.partial = []
    live.partialBytes = 0
    let raw = buf.toString('utf8')
    if (raw.endsWith('\r')) raw = raw.slice(0, -1)
    if (!raw.trim()) return
    this.onLine(live, raw)
  }

  private onLine(live: Live, raw: string): void {
    const at = this.deps.now()
    const id = live.spec.runId
    let parsed: ReturnType<StreamParser['line']> = null
    try {
      parsed = live.parser.line(raw, at)
    } catch (err) {
      this.deps.log(`run ${id} parser error ${(err as Error).name}`)
    }
    const items = live.log.append(raw)
    live.lastLineAt = at
    if (parsed && parsed.type && !live.sawLine) {
      live.sawLine = true
      this.deps.hooks.firstLine(id, at, parsed.sessionId)
    }
    if (parsed?.result && !live.sawResult) {
      live.sawResult = true
      if (!live.done) this.deps.timer.set(this.key(id, 'linger'), at + LINGER_MS)
      this.deps.hooks.result(id, at)
    }
    this.deps.hooks.signal(id, at)
    if (items.length) this.deps.hooks.append(id, items, at)
  }

  private signal(live: Live, sig: 'SIGTERM' | 'SIGKILL'): void {
    if (live.exited) {
      this.afterExit(live, sig, sig)
      return
    }
    try {
      this.deps.treeKill.signal(live.pid, sig)
    } catch (err) {
      this.deps.log(`run ${live.spec.runId} signal ${sig} failed ${(err as Error).name}`)
    }
  }

  private kill(live: Live, why: string): void {
    if (live.exited) {
      this.afterExit(live, 'SIGKILL', why)
      return
    }
    try {
      if (!this.deps.treeKill.sync(live.pid)) this.deps.log(`run ${live.spec.runId} tree kill (${why}) found nothing to kill`)
    } catch (err) {
      this.deps.log(`run ${live.spec.runId} tree kill (${why}) failed ${(err as Error).name}`)
    }
  }

  /**
   * A kill of a run whose `exit` Node already emitted: the pid is reaped and may be another process's now (pid reuse),
   * so it is never signalled alone. win32 signals nothing (the caller destroys stdio; a grandchild is left as an
   * orphan, logged); POSIX signals the process group only, with no single-pid fallback.
   */
  private afterExit(live: Live, sig: 'SIGTERM' | 'SIGKILL', why: string): void {
    if (this.deps.platform === 'win32') {
      this.deps.log(`run ${live.spec.runId} ${why} after exit: pid ${live.pid} not signalled (a grandchild may be left orphaned)`)
      return
    }
    try {
      ;(this.deps.groupKill ?? groupKillPosix)(live.pid, sig)
    } catch (err) {
      // ESRCH: the group is gone with its last member.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') this.deps.log(`run ${live.spec.runId} group ${sig} (${why}) failed ${code ?? (err as Error).name}`)
    }
  }

  private destroyStdio(live: Live): void {
    for (const s of [live.child.stdin, live.child.stdout, live.child.stderr]) {
      try {
        s?.destroy()
      } catch {
        /* already gone */
      }
    }
  }

  private cleanup(live: Live): void {
    live.done = true
    for (const k of KEYS) this.deps.timer.clear(this.key(live.spec.runId, k))
    live.log.close()
    this.runs.delete(live.spec.runId)
  }

  /** The run is over (close, drain or a forced stop): facts, stderr line, log closed, the closed hook. */
  private finalize(live: Live, how: 'close' | 'drain' | 'stop'): void {
    if (live.done) return
    // A last line without its newline still counts (the child is gone, nothing more comes).
    if (live.partialBytes > 0 || live.skipping) this.flushLine(live)
    const at = this.deps.now()
    const tail = redactCredentials(live.stderr)
    let facts
    try {
      facts = live.parser.facts({ code: live.exit.code }, tail, live.spec.base, at)
    } catch (err) {
      this.deps.log(`run ${live.spec.runId} facts error ${(err as Error).name}`)
      facts = createClaudeStreamParser().facts({ code: live.exit.code }, tail, live.spec.base, at)
    }
    live.log.writeStderr(tail)
    const logBytes = live.log.bytes
    const logCut = live.log.cutAt !== null
    this.cleanup(live)
    if (how !== 'close') this.deps.log(`run ${live.spec.runId} finalized by ${how}`)
    const end: RunEnd & { stderrTail: string; logBytes: number; logCut: boolean } = { at, exit: { ...live.exit }, facts, teamWrites: 0, stderrTail: tail, logBytes, logCut }
    if (live.lastLineAt !== undefined) end.lastLineAt = live.lastLineAt
    this.deps.hooks.closed(live.spec.runId, end)
  }
}
