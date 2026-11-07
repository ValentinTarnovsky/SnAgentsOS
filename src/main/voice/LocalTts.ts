/**
 * Hands-free voice (app 2.11.0): main's side of the local voice engine. It
 * forks the utilityProcess (ttsWorker.ts) on the first synthesis, loads the
 * pack once, sends one text at a time and kills the worker 5 minutes after
 * the last one (DeadlineTimer: no timer while nothing is due). A synthesis
 * that takes longer than SYNTH_TIMEOUT_MS kills the worker (the next one
 * forks it again). No Electron import: the fork is injected.
 */
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'

export interface TtsAudio {
  rate: number
  /** s16 mono PCM. */
  pcm: ArrayBuffer
}

export interface TtsRequest {
  text: string
  lang: 'es' | 'en'
  /** Engine voice: a Supertonic speaker id or an ElevenLabs voice id. */
  voice: string
  speed: number
}

/** What every voice engine does (local Supertonic, ElevenLabs). */
export interface TtsEngine {
  readonly id: 'local' | 'elevenlabs'
  ready(): boolean
  synth(req: TtsRequest, signal?: AbortSignal): Promise<TtsAudio>
}

export interface WorkerLike {
  postMessage(msg: unknown): void
  on(ev: 'message', fn: (msg: unknown) => void): void
  on(ev: 'exit', fn: (code: number) => void): void
  kill(): boolean
}

export interface LocalTtsDeps {
  fork: () => WorkerLike
  /** The installed pack's files, or null while it is not installed. */
  paths: () => { addon: string; model: string } | null
  threads?: number
  idleMs?: number
  synthTimeoutMs?: number
  loadTimeoutMs?: number
  timer?: DeadlineTimerDeps
  log?: (line: string) => void
}

export const TTS_IDLE_MS = 5 * 60_000
export const SYNTH_TIMEOUT_MS = 20_000
export const LOAD_TIMEOUT_MS = 30_000

export class TtsError extends Error {
  constructor(readonly code: 'missing' | 'load' | 'synth' | 'timeout' | 'exit' | 'aborted') {
    super(code)
  }
}

interface Pending {
  resolve: (a: TtsAudio) => void
  reject: (e: TtsError) => void
}

export class LocalTts implements TtsEngine {
  readonly id = 'local' as const
  private worker: WorkerLike | null = null
  private loading: Promise<void> | null = null
  private loaded: { resolve: () => void; reject: (e: TtsError) => void } | null = null
  private readonly pending = new Map<number, Pending>()
  private seq = 0
  private readonly timer: DeadlineTimer<string>
  private readonly now: () => number

  constructor(private readonly deps: LocalTtsDeps) {
    this.now = deps.timer?.now ?? (() => Date.now())
    this.timer = new DeadlineTimer<string>((key) => this.due(key), deps.timer)
  }

  ready(): boolean {
    return this.deps.paths() !== null
  }

  /** The worker is up (tests and diagnostics). */
  get running(): boolean {
    return this.worker !== null
  }

  async synth(req: TtsRequest, signal?: AbortSignal): Promise<TtsAudio> {
    if (signal?.aborted) throw new TtsError('aborted')
    await this.ensure()
    const w = this.worker
    if (!w) throw new TtsError('exit')
    const id = ++this.seq
    const sid = Number(req.voice)
    this.timer.clear('idle')
    return new Promise<TtsAudio>((resolve, reject) => {
      const done = (): void => {
        this.pending.delete(id)
        this.timer.clear(`req:${id}`)
        signal?.removeEventListener('abort', onAbort)
        if (this.pending.size === 0 && this.worker) this.timer.set('idle', this.now() + (this.deps.idleMs ?? TTS_IDLE_MS))
      }
      const onAbort = (): void => {
        done()
        reject(new TtsError('aborted'))
      }
      this.pending.set(id, {
        resolve: (a) => {
          done()
          resolve(a)
        },
        reject: (e) => {
          done()
          reject(e)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.timer.set(`req:${id}`, this.now() + (this.deps.synthTimeoutMs ?? SYNTH_TIMEOUT_MS))
      w.postMessage({ t: 'synth', id, text: req.text, sid: Number.isInteger(sid) && sid >= 0 ? sid : 0, speed: req.speed, lang: req.lang })
    })
  }

  /** Kills the worker now (pack removal, lab off, quit). Pending syntheses fail with `exit`. */
  unload(): void {
    const w = this.worker
    this.worker = null
    this.loading = null
    this.timer.clear('idle')
    this.timer.clear('load')
    if (w) {
      try {
        w.kill()
      } catch {
        /* already gone */
      }
    }
    this.failAll('exit')
  }

  dispose(): void {
    this.unload()
    this.timer.dispose()
  }

  private ensure(): Promise<void> {
    if (this.worker && this.loading) return this.loading
    const paths = this.deps.paths()
    if (!paths) return Promise.reject(new TtsError('missing'))
    const w = this.deps.fork()
    this.worker = w
    w.on('message', (m) => this.onMessage(w, m))
    w.on('exit', (code) => this.onExit(w, code))
    this.loading = new Promise<void>((resolve, reject) => {
      this.loaded = { resolve, reject }
    })
    this.timer.set('load', this.now() + (this.deps.loadTimeoutMs ?? LOAD_TIMEOUT_MS))
    w.postMessage({ t: 'load', addon: paths.addon, model: paths.model, threads: this.deps.threads ?? 2 })
    const loading = this.loading
    // A failed load forks again on the next synthesis.
    loading.catch(() => {
      if (this.loading === loading) this.unload()
    })
    return loading
  }

  private onMessage(w: WorkerLike, raw: unknown): void {
    if (w !== this.worker || !raw || typeof raw !== 'object') return
    const m = raw as { t?: unknown; id?: unknown; rate?: unknown; pcm?: unknown; code?: unknown }
    if (m.t === 'loaded') {
      this.timer.clear('load')
      this.log('load ok')
      this.loaded?.resolve()
      this.loaded = null
      return
    }
    if (m.t === 'audio' && typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      // By tag, not instanceof: a structured clone may come from another realm.
      const tag = Object.prototype.toString.call(m.pcm)
      const pcm = tag === '[object ArrayBuffer]' ? (m.pcm as ArrayBuffer) : ArrayBuffer.isView(m.pcm) ? new Uint8Array((m.pcm as ArrayBufferView).buffer).slice().buffer : null
      if (!p) return
      if (!pcm || typeof m.rate !== 'number' || m.rate <= 0) p.reject(new TtsError('synth'))
      else p.resolve({ rate: m.rate, pcm })
      return
    }
    if (m.t === 'error') {
      if (typeof m.id === 'number') {
        this.pending.get(m.id)?.reject(new TtsError('synth'))
        this.log('synth error')
      } else {
        this.log('load error')
        this.timer.clear('load')
        this.loaded?.reject(new TtsError('load'))
        this.loaded = null
      }
    }
  }

  private onExit(w: WorkerLike, code: number): void {
    if (w !== this.worker) return
    this.log(`worker exit code=${code}`)
    this.worker = null
    this.loading = null
    this.timer.clear('load')
    this.loaded?.reject(new TtsError('exit'))
    this.loaded = null
    this.failAll('exit')
  }

  private due(key: string): void {
    if (key === 'idle') {
      if (this.pending.size === 0 && this.worker) {
        this.log('idle unload')
        this.unload()
      }
      return
    }
    if (key === 'load') {
      this.log('load timeout')
      this.loaded?.reject(new TtsError('timeout'))
      this.loaded = null
      this.unload()
      return
    }
    if (key.startsWith('req:')) {
      const p = this.pending.get(Number(key.slice(4)))
      if (p) {
        this.log('synth timeout')
        p.reject(new TtsError('timeout'))
        this.unload()
      }
    }
  }

  private failAll(code: TtsError['code']): void {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) p.reject(new TtsError(code))
  }

  private log(line: string): void {
    try {
      this.deps.log?.(`tts ${line}`)
    } catch {
      /* never blocks */
    }
  }
}
