import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import type { Readable, Writable } from 'stream'
import { z } from 'zod'
import type { DictationEvt, DictationStartRes } from '@shared/ipc-contract'
import type { DictationEngine } from '@shared/types'
import { DICTATION_ENGINES, DICTATION_ERRORS, DICTATION_LANG_RE, DICTATION_TEXT_MAX } from '@shared/dictation'
import { buildDictationArgs } from './helperScript'

/**
 * Desktop dictation (app 2.4.0): runs the PowerShell helper of
 * helperScript.ts and forwards its JSON lines to the renderer that asked.
 *
 *  - One session at a time: a new start ends the previous one first.
 *  - Stop writes "stop" and kills the helper after 3 s if it is still there.
 *  - A renderer reload or close kills its session (registerDictationIpc), and
 *    so does dispose() on quit.
 *  - Every line is parsed with zod; anything else is dropped. Stderr is never
 *    read (it may hold user data), and the log keeps codes, never text.
 *  - Off Windows the answer is `unsupported`.
 */

/** The slice of a ChildProcess the service uses (a fake one in the tests). */
export interface HelperChild {
  stdout: Readable | null
  stderr: Readable | null
  stdin: Writable | null
  kill(): boolean
  on(event: 'exit', cb: (code: number | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
}

export interface DictationDeps {
  platform: NodeJS.Platform
  /** powershell.exe by absolute path, so one earlier in PATH is never picked up. */
  exe: () => string
  spawn: (exe: string, args: string[], opts: { env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: 'pipe' }) => HelperChild
  /** The environment the helper's is built from (process.env). */
  env: () => NodeJS.ProcessEnv
  /** One line per event, codes only. */
  log?: (line: string) => void
  newId?: () => string
}

export const STOP_KILL_MS = 3000
/** A longer line is not one of ours. */
export const LINE_MAX = 16 * 1024

/** What the helper inherits: what powershell.exe, the CLR and CodeDom (csc, %TEMP%) need, nothing else. */
const ENV_KEEP = [
  'SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'APPDATA', 'LOCALAPPDATA',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'COMPUTERNAME', 'PATH', 'PATHEXT', 'ComSpec',
]

export function helperEnv(src: NodeJS.ProcessEnv, engine: DictationEngine, lang: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ENV_KEEP) {
    const v = src[k]
    if (typeof v === 'string') env[k] = v
  }
  env.SNAOS_DICT_ENGINE = engine
  env.SNAOS_DICT_LANG = lang
  return env
}

/** The start request as main accepts it: an unknown engine is 'auto', a bad tag is '' (the helper uses the system language). */
export function normalizeStart(req: unknown): { engine: DictationEngine; lang: string } {
  const r = req && typeof req === 'object' ? (req as { engine?: unknown; lang?: unknown }) : {}
  const engine = DICTATION_ENGINES.includes(r.engine as DictationEngine) ? (r.engine as DictationEngine) : 'auto'
  const lang = typeof r.lang === 'string' && r.lang.length <= 35 && DICTATION_LANG_RE.test(r.lang) ? r.lang : ''
  return { engine, lang }
}

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** Dictated text: no controls (so never a CR or LF), whitespace collapsed, capped. */
export function cleanText(text: string): string {
  return text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, DICTATION_TEXT_MAX)
}

const code = z.enum(DICTATION_ERRORS)
const text = z.string().max(LINE_MAX).transform(cleanText)
const lineSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('ready'),
    engine: z.enum(['online', 'offline']),
    lang: z.string().max(35).regex(DICTATION_LANG_RE).optional().catch(undefined),
    fallback: code.optional().catch(undefined),
  }),
  z.object({ t: z.literal('hyp'), text }),
  z.object({ t: z.literal('final'), text }),
  z.object({ t: z.literal('error'), code: code.catch('internal') }),
  z.object({ t: z.literal('end') }),
])

export type HelperLine = Omit<DictationEvt, 'sessionId'>

/** One stdout line of the helper, or null when it is not a valid one. */
export function parseHelperLine(line: string): HelperLine | null {
  if (!line || line.length > LINE_MAX) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const res = lineSchema.safeParse(raw)
  if (!res.success) return null
  const v = res.data
  switch (v.t) {
    case 'ready':
      return { t: 'ready', engine: v.engine, ...(v.lang ? { lang: v.lang } : {}), ...(v.fallback ? { fallback: v.fallback } : {}) }
    case 'hyp':
    case 'final':
      return { t: v.t, text: v.text }
    case 'error':
      return { t: 'error', code: v.code }
    default:
      return { t: 'end' }
  }
}

interface Session {
  id: string
  owner: number
  child: HelperChild
  send: (e: DictationEvt) => void
  ended: boolean
  stopping: boolean
  killTimer: ReturnType<typeof setTimeout> | null
}

export class DictationService {
  private session: Session | null = null
  private seq = 0

  constructor(private readonly deps: DictationDeps) {}

  /** Id of the running session, if any (tests and diagnostics). */
  get activeId(): string | null {
    return this.session && !this.session.ended ? this.session.id : null
  }

  start(owner: number, send: (e: DictationEvt) => void, req: unknown): DictationStartRes {
    if (this.deps.platform !== 'win32') return { ok: false, error: 'unsupported' }
    const { engine, lang } = normalizeStart(req)
    if (this.session) this.kill(this.session)
    const id = this.deps.newId?.() ?? `dict-${Date.now().toString(36)}-${++this.seq}`
    let child: HelperChild
    try {
      child = this.deps.spawn(this.deps.exe(), buildDictationArgs(), { env: helperEnv(this.deps.env(), engine, lang), windowsHide: true, stdio: 'pipe' })
    } catch {
      this.log('spawn failed')
      return { ok: false, error: 'spawn' }
    }
    const s: Session = { id, owner, child, send, ended: false, stopping: false, killTimer: null }
    this.session = s
    this.log(`start engine=${engine}`)
    child.stderr?.on('data', () => { /* Never read: it may hold user data. */ })
    child.stdin?.on('error', () => undefined)
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => this.onLine(s, line))
    }
    child.on('error', () => {
      if (s.ended) return
      this.log('spawn error')
      this.emit(s, { t: 'error', code: 'spawn' })
      this.finish(s)
    })
    child.on('exit', (exitCode) => {
      if (s.ended) return
      this.log(`exit code=${exitCode ?? 'null'}`)
      // Gone without its end line: a crash, or killed from outside.
      if (!s.stopping) this.emit(s, { t: 'error', code: 'exit' })
      this.finish(s)
    })
    return { ok: true, sessionId: id }
  }

  /** "stop" to the helper; killed after STOP_KILL_MS. Only the owner's own session. */
  stop(sessionId: string, owner?: number): void {
    const s = this.session
    if (!s || s.ended || s.id !== sessionId || (owner !== undefined && s.owner !== owner) || s.stopping) return
    s.stopping = true
    this.log('stop')
    try {
      s.child.stdin?.write('stop\n')
    } catch {
      /* the kill below still ends it */
    }
    s.killTimer = setTimeout(() => {
      s.killTimer = null
      if (s.ended) return
      this.log('kill after stop')
      this.kill(s)
    }, STOP_KILL_MS)
  }

  /** The renderer reloaded or went away: its session dies with it. */
  stopOwner(owner: number): void {
    if (this.session && this.session.owner === owner) this.kill(this.session)
  }

  dispose(): void {
    if (this.session) this.kill(this.session)
  }

  private onLine(s: Session, line: string): void {
    if (s.ended) return
    const evt = parseHelperLine(line.trim())
    if (!evt) return
    if (evt.t === 'ready') this.log(`ready engine=${evt.engine}${evt.fallback ? ` fallback=${evt.fallback}` : ''}`)
    if (evt.t === 'error') this.log(`error code=${evt.code}`)
    if (evt.t === 'end') {
      this.finish(s)
      return
    }
    this.emit(s, evt)
  }

  private emit(s: Session, evt: HelperLine): void {
    try {
      s.send({ sessionId: s.id, ...evt })
    } catch {
      /* the renderer is gone */
    }
  }

  /** The session is over: one `end` to the renderer, the helper gets EOF. */
  private finish(s: Session): void {
    if (s.ended) return
    s.ended = true
    if (s.killTimer) clearTimeout(s.killTimer)
    s.killTimer = null
    if (this.session === s) this.session = null
    this.log('end')
    try {
      s.child.stdin?.end()
    } catch {
      /* already closed */
    }
    this.emit(s, { t: 'end' })
  }

  private kill(s: Session): void {
    s.stopping = true
    try {
      s.child.kill()
    } catch {
      /* already gone */
    }
    this.finish(s)
  }

  private log(line: string): void {
    try {
      this.deps.log?.(line)
    } catch {
      /* best effort */
    }
  }
}

/** Rotated at 128 KB; one previous file is kept as dictation.log.1. */
const LOG_MAX_BYTES = 128 * 1024

/** dataDir()/logs/dictation.log: one timestamped line per event, codes only. Never throws. */
export function createDictationLog(dataDir: string, now: () => number = Date.now): (line: string) => void {
  const dir = join(dataDir, 'logs')
  const file = join(dir, 'dictation.log')
  return (line: string) => {
    try {
      mkdirSync(dir, { recursive: true })
      try {
        if (statSync(file).size >= LOG_MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        /* no file yet */
      }
      appendFileSync(file, `${new Date(now()).toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`, 'utf8')
    } catch {
      /* best effort */
    }
  }
}

/** The only pages openSettings reaches; any other value opens nothing. */
export function dictationSettingsUri(page: unknown): string | null {
  if (page === 'speech') return 'ms-settings:privacy-speech'
  if (page === 'microphone') return 'ms-settings:privacy-microphone'
  return null
}
