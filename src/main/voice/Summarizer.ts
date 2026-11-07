/**
 * Hands-free voice (app 2.11.0): one or two spoken sentences from a long agent
 * reply. Runs `claude -p --safe-mode --model haiku --effort low` (spike S6,
 * 2026-11-07: about 4 s on the user's own login; --safe-mode skips hooks,
 * plugins such as the narrator mod, MCP and CLAUDE.md; --bare would need an
 * API key) with the reply on stdin, never on the command line, in an empty
 * folder under `<dataDir>/voice` and without the app's console variables, so
 * the run is no console of the app. One run at a time, at most 3 waiting;
 * results are kept in memory (LRU, never on disk). Three failures in a row
 * switch to the local summary for 10 minutes.
 */
import type { ChildProcess, SpawnOptions } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync } from 'fs'
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'
import { localSummary, type SpeechLang } from '@shared/speechText'

export const SUMMARY_TIMEOUT_MS = 25_000
export const SUMMARY_QUEUE_MAX = 3
export const SUMMARY_CACHE_MAX = 64
export const BREAKER_FAILURES = 3
export const BREAKER_MS = 10 * 60_000
export const SUMMARY_MAX_CHARS = 400
const PROMPT_VERSION = 1

const SYSTEM_PROMPT: Record<SpeechLang, string> = {
  es: 'Resumí la respuesta de un agente de programación en una o dos oraciones para decir en voz alta, en primera persona y en español. Sin código, rutas, comandos ni hashes. Si la respuesta termina con una pregunta para el usuario, terminá con esa pregunta; no agregues preguntas que no están. Devolvé solo el texto a decir.',
  en: 'Summarize a coding agent reply in one or two sentences to be spoken aloud, in the first person, in English. No code, paths, commands or hashes. If the reply ends with a question for the user, end with that question; never add a question that is not there. Return only the text to say.',
}

/** The argv after the CLI (the reply goes on stdin). */
export function summarizerArgv(lang: SpeechLang): string[] {
  return ['-p', '--safe-mode', '--model', 'haiku', '--effort', 'low', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--system-prompt', SYSTEM_PROMPT[lang]]
}

/** The environment of a run: the app's, without its console and Teams variables and the child-session mark. */
export function summarizerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    if (/^SNAOS_/i.test(k) || /^CLAUDE_CODE_CHILD_SESSION$/i.test(k) || /^CLAUDECODE$/i.test(k)) continue
    out[k] = v
  }
  return out
}

/** The text a `--output-format json` run printed, one line, cut; '' when it failed. */
export function summaryOfOutput(stdout: string): string {
  try {
    const j = JSON.parse(stdout.trim()) as { result?: unknown; is_error?: unknown }
    if (j.is_error === true || typeof j.result !== 'string') return ''
    const one = j.result.replace(/\s+/g, ' ').trim()
    return one.length > SUMMARY_MAX_CHARS ? `${one.slice(0, SUMMARY_MAX_CHARS - 3).replace(/\s+\S*$/, '')}...` : one
  } catch {
    return ''
  }
}

export interface SummarizerDeps {
  /** The Claude CLI to run, or null when it is not on PATH. */
  resolve: (env: Record<string, string>) => { file: string; args: string[]; verbatim: boolean } | null
  spawn: (file: string, args: string[], opts: SpawnOptions) => ChildProcess
  kill: (pid: number) => void
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  timer?: DeadlineTimerDeps
  log?: (line: string) => void
}

interface Job {
  key: string
  text: string
  lang: SpeechLang
  waiters: Array<(s: string) => void>
}

export class Summarizer {
  private readonly cache = new Map<string, string>()
  private readonly queue: Job[] = []
  private running: { job: Job; child: ChildProcess } | null = null
  private failures = 0
  private brokenUntil = 0
  private readonly timer: DeadlineTimer<string>
  private readonly now: () => number

  constructor(private readonly deps: SummarizerDeps) {
    this.now = deps.timer?.now ?? (() => Date.now())
    this.timer = new DeadlineTimer<string>((key) => this.due(key), deps.timer)
  }

  /** Whether the Claude CLI is on PATH (Settings tells when it is not). */
  available(): boolean {
    return this.deps.resolve(summarizerEnv(this.deps.env ?? process.env)) !== null
  }

  /** A summary already made for this text, or undefined. */
  cached(text: string, lang: SpeechLang): string | undefined {
    return this.cache.get(this.keyOf(text, lang))
  }

  /**
   * The spoken summary of a cleaned reply. Never rejects: the local summary
   * when the CLI is missing, fails, times out, or the breaker is open.
   */
  summarize(text: string, lang: SpeechLang): Promise<string> {
    const key = this.keyOf(text, lang)
    const hit = this.cache.get(key)
    if (hit !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return Promise.resolve(hit)
    }
    if (this.now() < this.brokenUntil) return Promise.resolve(localSummary(text, lang))
    return new Promise<string>((resolve) => {
      const same = this.running?.job.key === key ? this.running.job : this.queue.find((j) => j.key === key)
      if (same) {
        same.waiters.push(resolve)
        return
      }
      // A full queue drops its oldest waiting job (a prefetch nobody asked for yet), which answers locally.
      if (this.queue.length >= SUMMARY_QUEUE_MAX) {
        const dropped = this.queue.shift() as Job
        for (const w of dropped.waiters) w(localSummary(dropped.text, dropped.lang))
      }
      this.queue.push({ key, text, lang, waiters: [resolve] })
      this.pump()
    })
  }

  dispose(): void {
    this.queue.length = 0
    if (this.running?.child.pid) this.deps.kill(this.running.child.pid)
    this.running = null
    this.timer.dispose()
  }

  private keyOf(text: string, lang: SpeechLang): string {
    return createHash('sha256').update(`${PROMPT_VERSION}\u0000${lang}\u0000${text}`).digest('hex')
  }

  private pump(): void {
    if (this.running || !this.queue.length) return
    const job = this.queue.shift() as Job
    const env = summarizerEnv(this.deps.env ?? process.env)
    const target = this.deps.resolve(env)
    if (!target) {
      this.finish(job, '', 'missing')
      return
    }
    try {
      mkdirSync(this.deps.cwd, { recursive: true })
    } catch {
      /* spawn reports it */
    }
    let child: ChildProcess
    try {
      child = this.deps.spawn(target.file, [...target.args, ...summarizerArgv(job.lang)], { cwd: this.deps.cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsVerbatimArguments: target.verbatim })
    } catch {
      this.finish(job, '', 'spawn')
      return
    }
    this.running = { job, child }
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (out.length < 256 * 1024) out += d
    })
    child.on('error', () => this.end(child, ''))
    child.on('close', () => this.end(child, out))
    this.timer.set('run', this.now() + (this.deps.timeoutMs ?? SUMMARY_TIMEOUT_MS))
    try {
      child.stdin?.end(job.text, 'utf8')
    } catch {
      /* close reports it */
    }
  }

  private end(child: ChildProcess, out: string): void {
    if (this.running?.child !== child) return
    const job = this.running.job
    this.running = null
    this.timer.clear('run')
    const summary = summaryOfOutput(out)
    this.finish(job, summary, summary ? '' : 'output')
  }

  private finish(job: Job, summary: string, error: string): void {
    if (summary) {
      this.failures = 0
      this.cache.set(job.key, summary)
      while (this.cache.size > SUMMARY_CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string)
      this.log(`ok chars=${summary.length}`)
    } else {
      this.failures++
      this.log(`fallback error=${error}`)
      if (this.failures >= BREAKER_FAILURES) {
        this.brokenUntil = this.now() + BREAKER_MS
        this.failures = 0
        this.log('breaker open')
      }
    }
    const said = summary || localSummary(job.text, job.lang)
    for (const w of job.waiters) w(said)
    this.pump()
  }

  private due(key: string): void {
    if (key !== 'run' || !this.running) return
    const { child } = this.running
    this.log('timeout')
    if (child.pid) this.deps.kill(child.pid)
    this.end(child, '')
  }

  private log(line: string): void {
    try {
      this.deps.log?.(`summary ${line}`)
    } catch {
      /* never blocks */
    }
  }
}
