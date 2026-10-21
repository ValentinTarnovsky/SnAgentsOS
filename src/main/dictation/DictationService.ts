import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import type { DictationEvt, DictationStartRes } from '@shared/ipc-contract'
import type { ConfigFile, DictationSettings, Language } from '@shared/types'
import {
  DICTATION_CHUNK_MAX_BYTES,
  DICTATION_DEVICES,
  DICTATION_LANG_RE,
  DICTATION_TEXT_MAX,
  type DictationError,
  type WhisperInstallError,
  type WhisperInstallProgress,
  type WhisperPackId,
  type WhisperPackInfo,
  type WhisperStatus,
} from '@shared/dictation'
import { join } from 'path'
import { packInstalled, resolveEngine, type AssetId, type EnginePlan } from './whisper/catalog'
import { keptText } from './whisper/hallucination'
import { buildPrompt, whisperLang } from './whisper/prompt'
import { Segmenter } from './whisper/segmenter'
import { pcmToWav } from './whisper/wav'
import { FIRST_GPU_REQ_TIMEOUT_MS, sameSpec, type ServerSpec, type ServerStartResult, type WhisperServer } from './whisper/WhisperServer'
import { isVcRuntimeExit, VC_REDIST_URL } from './whisper/vcRuntime'

/**
 * Desktop dictation (app 2.5.0): a local whisper.cpp server, GPU (CUDA) or
 * CPU. The renderer streams 16 kHz mono s16 chunks over `dictation:audio`;
 * main cuts phrases with an energy endpointer (Segmenter), POSTs each closed
 * phrase with Silero VAD on, filters Whisper's hallucinations and sends one
 * `final` per phrase (plus a greedy `hyp` of the open phrase on GPU).
 *
 *  - One session at a time; a new start ends the previous one (its `end`
 *    exactly once) and reuses the warm server.
 *  - One request in flight at a time (the server holds one mutex anyway).
 *    Results of a session that already ended are dropped.
 *  - A GPU failure falls back to the CPU pack (`ready.fallback`), and marks
 *    the GPU broken for this run (cleared by a device change or an install).
 *  - A request timeout restarts the server (the request keeps running in
 *    there); two GPU timeouts or a GPU crash move the session to CPU.
 *  - The server is unloaded IDLE_UNLOAD_MS after the last session.
 *  - The GPU warmup after an install runs on its own server instance.
 *  - The log keeps codes and sizes, never dictated text, the prompt or paths.
 *  - Not Windows x64: `unsupported`.
 */

/** What the service needs from the installer (WhisperInstaller). */
export interface InstallerLike {
  installed(): ReadonlySet<AssetId>
  status(): { packs: WhisperPackInfo[]; install: WhisperInstallProgress | null }
  install(pack: WhisperPackId): Promise<{ ok: boolean; error?: WhisperInstallError }>
  cancel(pack: WhisperPackId): void
  remove(pack: WhisperPackId, guard: { inUse: () => boolean; awaitExit?: () => Promise<void> }): Promise<{ ok: boolean; error?: WhisperInstallError }>
  readonly busy: boolean
}

/** What the service needs from one server instance (WhisperServer, or a fake). */
export type EngineServer = Pick<WhisperServer, 'start' | 'infer' | 'stop' | 'spec' | 'running' | 'served' | 'exitCode' | 'onExit'>

export interface DictationDeps {
  platform: NodeJS.Platform
  arch: string
  installer: InstallerLike
  /** A fresh server instance (sessions share one; the warmup gets its own). */
  createServer: () => EngineServer
  /** Absolute paths under the whisper folder for an engine plan. */
  spec: (plan: EnginePlan) => ServerSpec
  /** An NVIDIA GPU is present (cached at bootstrap). */
  nvidia: () => boolean
  /** VC++ runtime 14.40 or later (registry). */
  vcRuntime: () => Promise<boolean>
  /** `<dataDir>/whisper`, shown in Settings. */
  whisperDir: string
  log?: (line: string) => void
  newId?: () => string
  now?: () => number
}

export const STOP_DRAIN_MS = 20_000
export const IDLE_UNLOAD_MS = 5 * 60_000
export const HYP_INTERVAL_MS = 1000
export const HYP_MIN_MS = 800
/** Shorter encoder window on CPU for short phrases (about 2x faster). */
export const AUDIO_CTX_CPU = 512
export const CPU_SHORT_MS = 9500
export const SESSION_MAX_MS = 10 * 60_000
export const GPU_BEAM_SIZE = 5
/** Closed phrases waiting for the server (slow start): the oldest go first past these caps. */
export const QUEUE_MAX_SEGMENTS = 8
export const QUEUE_MAX_MS = 60_000
/** Audio may run this far ahead of the wall clock (IPC batching), never more. */
export const RATE_SLACK_MS = 5000
/** s16 mono at 16 kHz. */
export const BYTES_PER_MS = 32
/** GPU request timeouts in one session before it moves to CPU. */
export const GPU_TIMEOUTS_BROKEN = 2
/** CPU crashes restarted per session before it gives up with `exit`. */
export const CPU_RESTARTS_MAX = 1

export const DEFAULT_DICTATION: DictationSettings = { device: 'auto', language: 'auto', headerButton: true, interim: true, vocabulary: '' }

/** The settings as main trusts them: the renderer's config is checked field by field. */
export function normalizeDictationSettings(v: unknown): DictationSettings {
  const r = v && typeof v === 'object' ? (v as Partial<Record<keyof DictationSettings, unknown>>) : {}
  return {
    device: DICTATION_DEVICES.includes(r.device as DictationSettings['device']) ? (r.device as DictationSettings['device']) : 'auto',
    language: typeof r.language === 'string' && r.language.length <= 35 ? r.language : 'auto',
    headerButton: typeof r.headerButton === 'boolean' ? r.headerButton : true,
    interim: typeof r.interim === 'boolean' ? r.interim : true,
    vocabulary: typeof r.vocabulary === 'string' ? r.vocabulary.slice(0, 400) : '',
  }
}

/** The start request as main accepts it: a bad tag is '' (Whisper detects the language), a bad pane id is null. */
export function normalizeStart(req: unknown): { lang: string; paneId: string | null } {
  const r = req && typeof req === 'object' ? (req as { lang?: unknown; paneId?: unknown }) : {}
  const lang = typeof r.lang === 'string' && r.lang.length <= 35 && DICTATION_LANG_RE.test(r.lang) ? r.lang : ''
  const paneId = typeof r.paneId === 'string' && r.paneId.length > 0 && r.paneId.length <= 128 ? r.paneId : null
  return { lang, paneId }
}

function lastSegment(p: unknown): string | undefined {
  if (typeof p !== 'string') return undefined
  const parts = p.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1]
  return last && !/^[A-Za-z]:$/.test(last) ? last.slice(0, 80) : undefined
}

/** Workspace name and console folder for the prompt, looked up in main's config by pane id (never taken from the renderer). */
export function paneContextOf(cfg: ConfigFile | null | undefined, paneId: string | null): { workspace?: string; folder?: string } {
  if (!cfg || !paneId || !Array.isArray(cfg.workspaces)) return {}
  for (const ws of cfg.workspaces) {
    if (!ws || !Array.isArray(ws.panes)) continue
    const pane = ws.panes.find((p) => p && p.id === paneId)
    if (!pane) continue
    const workspace = typeof ws.name === 'string' && ws.name.trim() ? ws.name.trim().slice(0, 80) : undefined
    const folder = lastSegment(typeof pane.cwd === 'string' && pane.cwd ? pane.cwd : ws.cwd)
    return { ...(workspace ? { workspace } : {}), ...(folder ? { folder } : {}) }
  }
  return {}
}

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** Dictated text: no controls (so never a CR or LF), whitespace collapsed, capped. */
export function cleanText(text: string): string {
  return text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, DICTATION_TEXT_MAX)
}

/** One `dictation:audio` chunk as s16 samples, or null when it is not a valid one (type, empty, odd, too big). */
export function pcmChunk(pcm: unknown): Int16Array | null {
  let bytes: Uint8Array
  if (Object.prototype.toString.call(pcm) === '[object ArrayBuffer]') bytes = new Uint8Array(pcm as ArrayBuffer)
  else if (ArrayBuffer.isView(pcm)) bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  else return null
  const n = bytes.byteLength
  if (n < 2 || n > DICTATION_CHUNK_MAX_BYTES || n % 2 !== 0) return null
  const copy = new Uint8Array(n)
  copy.set(bytes)
  return new Int16Array(copy.buffer)
}

/** NVIDIA's PCI vendor id. */
export const NVIDIA_VENDOR_ID = 0x10de

/** `app.getGPUInfo('basic')`: any GPU device from NVIDIA. Cached at bootstrap by index.ts. */
export function hasNvidiaGpu(info: unknown): boolean {
  const devices = info && typeof info === 'object' ? (info as { gpuDevice?: unknown }).gpuDevice : null
  if (!Array.isArray(devices)) return false
  return devices.some((d) => d && typeof d === 'object' && (d as { vendorId?: unknown }).vendorId === NVIDIA_VENDOR_ID)
}

/** whisper.cpp threads: about the physical cores on CPU (2 to 8), 4 on GPU (the decoder runs on the card). */
export function engineThreads(device: 'gpu' | 'cpu', logicalCores: number): number {
  if (device === 'gpu') return 4
  const n = Number.isFinite(logicalCores) && logicalCores > 0 ? Math.floor(logicalCores / 2) : 2
  return Math.max(2, Math.min(8, n))
}

/** 1 s of quiet deterministic noise, for the GPU warmup. */
export function warmupNoise(samples = 16000): Int16Array {
  const out = new Int16Array(samples)
  let x = 12345
  for (let i = 0; i < samples; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = (x % 129) - 64
  }
  return out
}

interface Phrase {
  pcm: Int16Array
  ms: number
}

interface Session {
  id: string
  owner: number
  send: (e: DictationEvt) => void
  /** The request tag ('' when Whisper detects it), echoed in `ready`. */
  reqLang: string
  /** Whisper language code or 'auto'. */
  lang: string
  prompt: string
  phase: 'live' | 'stopping' | 'ended'
  seg: Segmenter
  queue: Phrase[]
  queuedMs: number
  /** Closed phrases so far: a hyp of a phrase that closed meanwhile is dropped. */
  segCount: number
  startedAt: number
  audioBytes: number
  rateDropped: boolean
  /** The plan the server runs for this session, once it is up. */
  plan: EnginePlan | null
  fallback: EnginePlan | null
  ready: boolean
  recovering: boolean
  gpuTimeouts: number
  cpuRestarts: number
  drainTimer: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
  hypTimer: ReturnType<typeof setInterval> | null
}

type InferCode = 'timeout' | 'exit' | 'internal'

/** Read through a call so TS does not keep a narrowing across an await. */
function ended(s: Session): boolean {
  return s.phase === 'ended'
}

function inferCode(e: unknown): InferCode {
  const c = e && typeof e === 'object' ? (e as { code?: unknown }).code : null
  return c === 'timeout' || c === 'exit' ? c : 'internal'
}

export class DictationService {
  private session: Session | null = null
  private server: EngineServer | null = null
  private serverOp: Promise<unknown> = Promise.resolve()
  private inflight: { s: Session; kind: 'final' | 'hyp' } | null = null
  private settings: DictationSettings = { ...DEFAULT_DICTATION }
  private config: ConfigFile | null = null
  private gpuBroken = false
  private warming = false
  /** A pack removal runs: no start until it is over. */
  private removing = false
  private warmServer: EngineServer | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private seq = 0

  constructor(private readonly deps: DictationDeps) {}

  private get supported(): boolean {
    return this.deps.platform === 'win32' && this.deps.arch === 'x64'
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Id of the running session, if any (tests and diagnostics). */
  get activeId(): string | null {
    return this.session && this.session.phase !== 'ended' ? this.session.id : null
  }

  /** The GPU failed this run (tests and diagnostics). */
  get gpuFailed(): boolean {
    return this.gpuBroken
  }

  /**
   * main's config cache (CONFIG_SAVE and bootstrap): the dictation settings
   * and the workspaces the prompt context comes from. A device change clears
   * the GPU failure of this run.
   */
  setConfig(cfg: ConfigFile | null | undefined): void {
    const prev = this.settings.device
    this.config = cfg && typeof cfg === 'object' ? cfg : null
    this.settings = normalizeDictationSettings(this.config?.settings?.dictation)
    if (this.settings.device !== prev) this.gpuBroken = false
  }

  async start(owner: number, send: (e: DictationEvt) => void, req: unknown): Promise<DictationStartRes> {
    if (!this.supported || this.disposed) return { ok: false, error: 'unsupported' }
    const { lang, paneId } = normalizeStart(req)
    let vc = false
    try {
      vc = await this.deps.vcRuntime()
    } catch {
      vc = false
    }
    if (!vc) {
      this.log('start error=vcredist')
      return { ok: false, error: 'vcredist' }
    }
    // Checked after the await: a removal that began meanwhile is deleting the runtime and the models.
    if (this.removing || this.disposed) {
      this.log('start error=model_missing removing')
      return { ok: false, error: this.disposed ? 'unsupported' : 'model_missing' }
    }
    const settings = this.settings
    const nvidia = this.nvidiaSafe()
    const installed = this.installedSafe()
    const r = resolveEngine(settings, installed, nvidia, this.gpuBroken)
    if (!r.ok) {
      this.log('start error=model_missing')
      return { ok: false, error: 'model_missing' }
    }
    if (this.session) this.finish(this.session)
    this.clearIdle()

    let primary = r.primary
    let fallback = r.fallback
    let reported = false
    if (primary.device === 'gpu' && this.warming && fallback) {
      // The GPU warmup owns the GPU right now: this session runs on CPU.
      primary = fallback
      fallback = null
    } else if (primary.device === 'cpu' && this.gpuBroken && packInstalled('gpu', installed) && (settings.device === 'gpu' || (settings.device === 'auto' && nvidia))) {
      reported = true
    }

    const wl = lang ? whisperLang(lang) : 'auto'
    const appLang: Language = this.config?.settings?.language === 'es' ? 'es' : 'en'
    const prompt = buildPrompt(wl, { ...paneContextOf(this.config, paneId), vocabulary: settings.vocabulary, appLang })
    const id = this.deps.newId?.() ?? `dict-${Date.now().toString(36)}-${++this.seq}`
    const s: Session = {
      id, owner, send, reqLang: lang, lang: wl, prompt, phase: 'live',
      seg: null as unknown as Segmenter,
      queue: [], queuedMs: 0, segCount: 0, startedAt: this.now(), audioBytes: 0, rateDropped: false,
      plan: null, fallback, ready: false, recovering: false, gpuTimeouts: 0, cpuRestarts: 0,
      drainTimer: null, maxTimer: null, hypTimer: null,
    }
    s.seg = new Segmenter((pcm, ms) => this.onPhrase(s, pcm, ms))
    s.maxTimer = setTimeout(() => {
      s.maxTimer = null
      this.log('session max')
      this.stop(s.id)
    }, SESSION_MAX_MS)
    this.session = s
    this.log(`start device=${primary.device} lang=${wl}`)
    void this.boot(s, primary, fallback, reported)
    return { ok: true, sessionId: id }
  }

  /** One capture chunk. Dropped unless the session is live and the sender's, the chunk is valid and not faster than real time. */
  audio(sessionId: string, owner: number, pcm: unknown): void {
    const s = this.session
    if (!s || s.id !== sessionId || s.owner !== owner || s.phase !== 'live') return
    const samples = pcmChunk(pcm)
    if (!samples) return
    const n = samples.byteLength
    if (s.audioBytes + n > (this.now() - s.startedAt + RATE_SLACK_MS) * BYTES_PER_MS) {
      if (!s.rateDropped) this.log('audio dropped rate')
      s.rateDropped = true
      return
    }
    s.audioBytes += n
    s.seg.push(samples)
  }

  /** Closes the open phrase, waits for the queue (at most STOP_DRAIN_MS), then `end`. Only the owner's own session. */
  stop(sessionId: string, owner?: number): void {
    const s = this.session
    if (!s || s.id !== sessionId || (owner !== undefined && s.owner !== owner) || s.phase !== 'live') return
    s.phase = 'stopping'
    this.clearHyp(s)
    this.log('stop')
    try {
      s.seg.flush()
    } catch {
      /* nothing open */
    }
    if (s.phase !== 'stopping') return
    s.drainTimer = setTimeout(() => {
      s.drainTimer = null
      if (s.phase === 'ended') return
      this.log('drain timeout')
      this.finish(s)
    }, STOP_DRAIN_MS)
    if (s.queue.length === 0 && !(this.inflight?.s === s && this.inflight.kind === 'final')) this.finish(s)
    else this.pump()
  }

  /** The renderer reloaded or went away: its session ends now (queued phrases dropped). */
  stopOwner(owner: number): void {
    const s = this.session
    if (s && s.owner === owner) {
      this.log('owner gone')
      this.finish(s)
    }
  }

  async status(): Promise<WhisperStatus> {
    const supported = this.supported
    let inst: { packs: WhisperPackInfo[]; install: WhisperInstallProgress | null } = { packs: [], install: null }
    try {
      const st = this.deps.installer.status()
      inst = { packs: st.packs, install: st.install }
    } catch {
      /* empty list */
    }
    let vc = false
    if (supported) {
      try {
        vc = await this.deps.vcRuntime()
      } catch {
        vc = false
      }
    }
    const spec = this.server?.running ? this.server.spec : null
    return {
      supported,
      nvidia: this.nvidiaSafe(),
      vcRuntime: vc,
      dataDir: this.deps.whisperDir,
      packs: inst.packs,
      install: inst.install,
      loaded: spec ? { device: spec.device } : null,
      warming: this.warming,
    }
  }

  async install(pack: WhisperPackId): Promise<{ ok: boolean; error?: WhisperInstallError }> {
    if (!this.supported || this.disposed) return { ok: false, error: 'unsupported' }
    if (this.warming) return { ok: false, error: 'busy' }
    const r = await this.deps.installer.install(pack)
    if (r.ok) this.gpuBroken = false
    return r
  }

  cancelInstall(pack: WhisperPackId): void {
    try {
      this.deps.installer.cancel(pack)
    } catch {
      /* nothing running */
    }
  }

  /**
   * Refused while a session, a warmup or an install runs; an idle server is
   * stopped first (its DLLs are locked while it lives). While it runs, a
   * start answers `model_missing`: the files it would spawn from are going.
   */
  async remove(pack: WhisperPackId): Promise<{ ok: boolean; error?: WhisperInstallError }> {
    if (!this.supported || this.disposed) return { ok: false, error: 'unsupported' }
    if (this.session || this.warming || this.removing || this.deps.installer.busy) return { ok: false, error: 'busy' }
    this.clearIdle()
    this.removing = true
    try {
      return await this.deps.installer.remove(pack, {
        inUse: () => this.session !== null || this.warming,
        // The idle server holds the runtime DLLs open; it must be gone before the files go.
        awaitExit: () => this.stopServer(),
      })
    } finally {
      this.removing = false
    }
  }

  /**
   * The GPU pack's last install phase: start the CUDA server on its own
   * instance and POST 1 s of quiet noise twice (greedy, then beam 5) without
   * VAD, so the PTX JIT is paid here and not on the first dictation.
   */
  async warmup(pack: WhisperPackId): Promise<boolean> {
    if (pack !== 'gpu') return true
    if (!this.supported || this.disposed || this.warming) return false
    const r = resolveEngine({ device: 'gpu' }, this.installedSafe(), true, false)
    if (!r.ok || r.primary.device !== 'gpu') return false
    this.warming = true
    const srv = this.deps.createServer()
    this.warmServer = srv
    const t0 = this.now()
    let ok = false
    try {
      const st = await srv.start(this.deps.spec(r.primary))
      if (st.ok) {
        const wav = pcmToWav(warmupNoise())
        await srv.infer(wav, { lang: 'auto', prompt: '', vad: false }, FIRST_GPU_REQ_TIMEOUT_MS)
        await srv.infer(wav, { lang: 'auto', prompt: '', vad: false, beamSize: GPU_BEAM_SIZE }, FIRST_GPU_REQ_TIMEOUT_MS)
        ok = true
      } else {
        this.log(`warmup error=${st.error}`)
      }
    } catch (e) {
      this.log(`warmup error=${inferCode(e)}`)
    } finally {
      this.warmServer = null
      this.warming = false
      await srv.stop().catch(() => undefined)
    }
    if (ok) {
      this.gpuBroken = false
      this.log(`warmup ok ms=${this.now() - t0}`)
    }
    return ok
  }

  /** Quit: the session ends, every server is killed (synchronously), installs are cancelled. */
  dispose(): void {
    this.disposed = true
    if (this.session) this.finish(this.session)
    this.clearIdle()
    const srv = this.server
    this.server = null
    void srv?.stop().catch(() => undefined)
    const warm = this.warmServer
    this.warmServer = null
    void warm?.stop().catch(() => undefined)
    for (const p of ['cpu', 'gpu'] as const) this.cancelInstall(p)
  }

  // --- Server -------------------------------------------------------------------

  /** Serialized: the shared server is started or swapped by one caller at a time. */
  private ensureServer(plan: EnginePlan): Promise<ServerStartResult> {
    const run = async (): Promise<ServerStartResult> => {
      if (this.disposed) return { ok: false, error: 'exit' }
      const spec = this.deps.spec(plan)
      const cur = this.server
      if (cur && cur.running && sameSpec(cur.spec, spec)) return { ok: true }
      if (cur) {
        this.server = null
        await cur.stop().catch(() => undefined)
      }
      const srv = this.deps.createServer()
      this.server = srv
      srv.onExit = (code) => this.onServerExit(srv, code)
      const r = await srv.start(spec)
      if (!r.ok && this.server === srv) this.server = null
      return r
    }
    const p = this.serverOp.then(run, run).catch((): ServerStartResult => ({ ok: false, error: 'spawn' }))
    this.serverOp = p
    return p
  }

  private stopServer(only?: EngineServer): Promise<void> {
    const run = async (): Promise<void> => {
      const cur = this.server
      if (!cur || (only && cur !== only)) {
        if (only && only !== cur) await only.stop().catch(() => undefined)
        return
      }
      this.server = null
      await cur.stop().catch(() => undefined)
    }
    const p = this.serverOp.then(run, run).catch(() => undefined)
    this.serverOp = p
    return p
  }

  private async boot(s: Session, primary: EnginePlan, fallback: EnginePlan | null, reported: boolean): Promise<void> {
    let plan = primary
    let res = await this.ensureServer(plan)
    if (!res.ok && plan.device === 'gpu' && fallback) {
      // Any GPU failure (no CUDA device, a driver fault, VRAM, a missing CUDA DLL) falls back to CPU.
      this.gpuBroken = true
      this.log(`gpu failed error=${res.error}, cpu fallback`)
      plan = fallback
      s.fallback = null
      reported = true
      res = await this.ensureServer(plan)
    }
    if (s.phase === 'ended') return
    if (!res.ok) {
      this.fail(s, res.error)
      return
    }
    s.plan = plan
    s.ready = true
    this.log(`ready engine=${plan.device}${reported ? ' fallback=gpu_failed' : ''}`)
    this.emit(s, { t: 'ready', engine: plan.device, ...(s.reqLang ? { lang: s.reqLang } : {}), ...(reported ? { fallback: 'gpu_failed' as const } : {}) })
    if (plan.device === 'gpu' && s.phase === 'live') this.armHyp(s)
    this.pump()
  }

  private onServerExit(srv: EngineServer, _code: number | null): void {
    if (this.server !== srv) return
    const s = this.session
    if (s && s.phase !== 'ended' && s.ready && !s.recovering) {
      void this.recover(s, srv, 'exit')
      return
    }
    this.server = null
  }

  /**
   * The server timed out (it is still busy inside) or died: restart it. A GPU
   * crash or the second GPU timeout moves the session to CPU (a GPU crash is
   * never read as the VC++ runtime: start() checked the registry, and the CPU
   * plan tells); a CPU crash before the first answer of its process with
   * 0xC0000005 or a missing DLL is `vcredist`; another CPU crash is restarted once.
   */
  private async recover(s: Session, srv: EngineServer, reason: 'timeout' | 'exit'): Promise<void> {
    if (s.recovering) return
    if (this.server !== srv) {
      // Already replaced (a newer start); nothing of this session runs on it.
      if (s.phase !== 'ended') this.pump()
      return
    }
    s.recovering = true
    s.ready = false
    await this.stopServer(srv)
    if (s.phase === 'ended') {
      s.recovering = false
      return
    }
    let plan = s.plan
    if (!plan) {
      s.recovering = false
      this.fail(s, 'exit')
      return
    }
    const vcExit = reason === 'exit' && isVcRuntimeExit(srv.exitCode, srv.served > 0)
    let switched = false
    if (plan.device === 'gpu') {
      if (reason === 'exit' || ++s.gpuTimeouts >= GPU_TIMEOUTS_BROKEN) {
        this.gpuBroken = true
        if (!s.fallback) {
          s.recovering = false
          this.fail(s, reason === 'exit' ? (vcExit ? 'vcredist' : 'exit') : 'gpu_failed')
          return
        }
        plan = this.toFallback(s)
        switched = true
      }
    } else if (vcExit) {
      s.recovering = false
      this.fail(s, 'vcredist')
      return
    } else if (reason === 'exit' && s.cpuRestarts++ >= CPU_RESTARTS_MAX) {
      s.recovering = false
      this.fail(s, 'exit')
      return
    }
    await this.restart(s, plan, switched, reason)
  }

  /** The session leaves the GPU for its CPU plan (the caller checked there is one). */
  private toFallback(s: Session): EnginePlan {
    const plan = s.fallback as EnginePlan
    s.fallback = null
    this.clearHyp(s)
    return plan
  }

  /**
   * Starts `plan` for a session marked `recovering`, then marks it ready. A
   * GPU plan that does not come back falls back to the session's CPU plan,
   * as at boot; only a CPU plan that fails too ends the session.
   */
  private async restart(s: Session, plan: EnginePlan, switched: boolean, reason: string): Promise<void> {
    this.log(`restart engine=${plan.device} reason=${reason}`)
    let r = await this.ensureServer(plan)
    if (!r.ok && plan.device === 'gpu' && s.fallback && !ended(s)) {
      this.gpuBroken = true
      this.log(`gpu failed error=${r.error}, cpu fallback`)
      plan = this.toFallback(s)
      switched = true
      r = await this.ensureServer(plan)
    }
    s.recovering = false
    if (ended(s)) return
    if (!r.ok) {
      this.fail(s, r.error)
      return
    }
    s.plan = plan
    s.ready = true
    if (switched) {
      this.log('ready engine=cpu fallback=gpu_failed')
      this.emit(s, { t: 'ready', engine: 'cpu', ...(s.reqLang ? { lang: s.reqLang } : {}), fallback: 'gpu_failed' })
    }
    this.pump()
  }

  // --- Phrases ------------------------------------------------------------------

  private onPhrase(s: Session, pcm: Int16Array, ms: number): void {
    if (s.phase === 'ended') return
    s.segCount++
    s.queue.push({ pcm, ms })
    s.queuedMs += ms
    while (s.queue.length > 1 && (s.queue.length > QUEUE_MAX_SEGMENTS || s.queuedMs > QUEUE_MAX_MS)) {
      const old = s.queue.shift() as Phrase
      s.queuedMs -= old.ms
      this.log('queue drop')
    }
    this.pump()
  }

  /**
   * Sends the next queued phrase when nothing is in flight and the server is
   * up; ends a drained stopping session. A ready session whose server went
   * away under it (an ended session's timeout restarted the shared server)
   * gets it back here.
   */
  private pump(): void {
    const s = this.session
    if (!s || s.phase === 'ended' || this.inflight || s.recovering) return
    if (s.queue.length === 0 && s.phase === 'stopping') {
      this.finish(s)
      return
    }
    const srv = this.server
    if (s.ready && s.plan && (!srv || !srv.running)) {
      s.recovering = true
      s.ready = false
      void this.restart(s, s.plan, false, 'gone')
      return
    }
    if (s.queue.length === 0 || !s.ready || !srv || !srv.running) return
    const job = s.queue.shift() as Phrase
    s.queuedMs -= job.ms
    void this.runFinal(s, srv, job)
  }

  private async runFinal(s: Session, srv: EngineServer, job: Phrase): Promise<void> {
    this.inflight = { s, kind: 'final' }
    const device = srv.spec?.device ?? 'cpu'
    const t0 = this.now()
    let failed: InferCode | null = null
    try {
      const segs = await srv.infer(pcmToWav(job.pcm), {
        lang: s.lang,
        prompt: s.prompt,
        vad: true,
        ...(device === 'gpu' ? { beamSize: GPU_BEAM_SIZE } : {}),
        ...(device === 'cpu' && job.ms <= CPU_SHORT_MS ? { audioCtx: AUDIO_CTX_CPU } : {}),
      })
      if (s.phase !== 'ended') {
        const kept = keptText(segs, s.prompt)
        const text = cleanText(kept.text)
        this.log(`final ms=${Math.round(job.ms)} req=${this.now() - t0} drop=${kept.dropped.length ? kept.dropped.join('+') : '-'}${text ? '' : ' empty'}`)
        // Also when empty (VAD or the filter dropped it): the renderer types nothing but learns the engine answers (`slow`).
        this.emit(s, { t: 'final', text })
      }
    } catch (e) {
      failed = inferCode(e)
      this.log(`final error=${failed} ms=${Math.round(job.ms)}`)
    }
    if (failed === 'timeout' && s.phase !== 'ended') this.emit(s, { t: 'error', code: 'timeout' })
    await this.afterRequest(s, srv, failed)
  }

  /**
   * A request is over. A timeout or a crash restarts the server: for its own
   * live session through recover(); for an ended session the shared server
   * is stopped (its request still holds it) while the slot stays taken, and
   * pump() brings it back for a newer session.
   */
  private async afterRequest(s: Session, srv: EngineServer, failed: InferCode | null): Promise<void> {
    if (failed === 'timeout' || failed === 'exit') {
      if (ended(s)) {
        await this.stopServer(srv)
        this.inflight = null
      } else {
        this.inflight = null
        await this.recover(s, srv, failed)
      }
    } else {
      this.inflight = null
    }
    this.pump()
  }

  private armHyp(s: Session): void {
    this.clearHyp(s)
    s.hypTimer = setInterval(() => this.hypTick(s), HYP_INTERVAL_MS)
  }

  private clearHyp(s: Session): void {
    if (s.hypTimer) clearInterval(s.hypTimer)
    s.hypTimer = null
  }

  /** GPU only, with interim on: a greedy pass over the open phrase when nothing else waits. */
  private hypTick(s: Session): void {
    if (s.phase !== 'live' || !s.ready || s.recovering || this.inflight || s.queue.length || !this.settings.interim) return
    const srv = this.server
    if (!srv || !srv.running || srv.spec?.device !== 'gpu') return
    if (s.seg.openMs < HYP_MIN_MS) return
    const pcm = s.seg.openPcm()
    if (!pcm) return
    void this.runHyp(s, srv, pcm, s.segCount)
  }

  private async runHyp(s: Session, srv: EngineServer, pcm: Int16Array, at: number): Promise<void> {
    this.inflight = { s, kind: 'hyp' }
    let failed: InferCode | null = null
    try {
      const segs = await srv.infer(pcmToWav(pcm), { lang: s.lang, prompt: s.prompt, vad: true })
      if (s.phase === 'live' && s.segCount === at) {
        const text = cleanText(keptText(segs, s.prompt).text)
        if (text) this.emit(s, { t: 'hyp', text })
      }
    } catch (e) {
      failed = inferCode(e)
      this.log(`hyp error=${failed}`)
    }
    await this.afterRequest(s, srv, failed)
  }

  // --- End ----------------------------------------------------------------------

  private fail(s: Session, code: DictationError): void {
    if (s.phase === 'ended') return
    this.log(`error code=${code}`)
    this.emit(s, { t: 'error', code })
    this.finish(s)
  }

  /** The session is over: one `end`, last; queued phrases are dropped; the idle timer starts. */
  private finish(s: Session): void {
    if (s.phase === 'ended') return
    s.phase = 'ended'
    s.ready = false
    s.queue = []
    s.queuedMs = 0
    this.clearHyp(s)
    if (s.drainTimer) clearTimeout(s.drainTimer)
    if (s.maxTimer) clearTimeout(s.maxTimer)
    s.drainTimer = null
    s.maxTimer = null
    if (this.session === s) this.session = null
    this.log('end')
    this.emit(s, { t: 'end' })
    this.armIdle()
  }

  private armIdle(): void {
    this.clearIdle()
    if (this.disposed) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.session) return
      if (this.server) this.log('idle unload')
      void this.stopServer()
    }, IDLE_UNLOAD_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private emit(s: Session, evt: Omit<DictationEvt, 'sessionId'>): void {
    try {
      s.send({ sessionId: s.id, ...evt })
    } catch {
      /* the renderer is gone */
    }
  }

  private nvidiaSafe(): boolean {
    try {
      return this.deps.nvidia() === true
    } catch {
      return false
    }
  }

  private installedSafe(): ReadonlySet<AssetId> {
    try {
      return this.deps.installer.installed()
    } catch {
      return new Set()
    }
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

/**
 * What openSettings opens: the Windows microphone privacy page or the fixed
 * VC++ runtime download. Any other value opens nothing; a URL is never taken.
 */
export function dictationSettingsUri(page: unknown): string | null {
  if (page === 'microphone') return 'ms-settings:privacy-microphone'
  if (page === 'vcredist') return VC_REDIST_URL
  return null
}
