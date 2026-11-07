/**
 * Hands-free voice (app 2.11.0): the local voice engine, run in an Electron
 * utilityProcess so a crash or a slow synthesis never touches main. It loads
 * the sherpa-onnx N-API addon and the Supertonic model once (paths from main,
 * which only hands in files under `<dataDir>/voice`), then turns text into
 * s16 mono PCM. Electron forbids external ArrayBuffers, so every generate
 * call passes `enableExternalBuffer: false`.
 *
 * Messages in: { t: 'load', addon, model, threads } and
 * { t: 'synth', id, text, sid, speed, lang }. Out: { t: 'loaded', rate,
 * speakers }, { t: 'audio', id, rate, pcm } and { t: 'error', id?, code }.
 */
import { join } from 'path'

interface Addon {
  createOfflineTtsAsync(cfg: unknown): Promise<unknown>
  offlineTtsGenerateAsyncWithConfig(handle: unknown, req: unknown): Promise<{ samples: Float32Array; sampleRate: number }>
  getOfflineTtsSampleRate(handle: unknown): number
  getOfflineTtsNumSpeakers(handle: unknown): number
}

type InMsg =
  | { t: 'load'; addon: string; model: string; threads: number }
  | { t: 'synth'; id: number; text: string; sid: number; speed: number; lang: string }

interface ParentPort {
  on(ev: 'message', fn: (e: { data: unknown }) => void): void
  postMessage(msg: unknown): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort
let addon: Addon | null = null
let handle: unknown = null
let rate = 0
let chain: Promise<unknown> = Promise.resolve()

function post(msg: unknown): void {
  try {
    port?.postMessage(msg)
  } catch {
    /* main went away */
  }
}

/** Float [-1, 1] samples as little-endian s16. */
export function toS16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out.buffer
}

async function load(m: Extract<InMsg, { t: 'load' }>): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require(m.addon) as Addon
    const f = (name: string): string => join(m.model, name)
    handle = await addon.createOfflineTtsAsync({
      model: {
        supertonic: {
          durationPredictor: f('duration_predictor.int8.onnx'),
          textEncoder: f('text_encoder.int8.onnx'),
          vectorEstimator: f('vector_estimator.int8.onnx'),
          vocoder: f('vocoder.int8.onnx'),
          ttsJson: f('tts.json'),
          unicodeIndexer: f('unicode_indexer.bin'),
          voiceStyle: f('voice.bin'),
        },
        numThreads: Math.max(1, Math.min(8, Math.round(m.threads) || 2)),
        debug: 0,
        provider: 'cpu',
      },
      maxNumSentences: 1,
    })
    rate = addon.getOfflineTtsSampleRate(handle)
    post({ t: 'loaded', rate, speakers: addon.getOfflineTtsNumSpeakers(handle) })
  } catch {
    addon = null
    handle = null
    post({ t: 'error', code: 'load' })
  }
}

async function synth(m: Extract<InMsg, { t: 'synth' }>): Promise<void> {
  if (!addon || !handle) {
    post({ t: 'error', id: m.id, code: 'not_loaded' })
    return
  }
  try {
    const speed = Math.max(0.5, Math.min(2, m.speed || 1))
    const audio = await addon.offlineTtsGenerateAsyncWithConfig(handle, {
      text: m.text,
      sid: m.sid,
      speed,
      enableExternalBuffer: false,
      generationConfig: { sid: m.sid, speed, numSteps: 5, extra: { lang: m.lang } },
    })
    post({ t: 'audio', id: m.id, rate: audio.sampleRate || rate, pcm: toS16(audio.samples) })
  } catch {
    post({ t: 'error', id: m.id, code: 'synth' })
  }
}

port?.on('message', (e) => {
  const m = e?.data as InMsg | undefined
  if (!m || typeof m !== 'object') return
  // One at a time: a synthesis waits for the load and for the one before it.
  if (m.t === 'load' && typeof m.addon === 'string' && typeof m.model === 'string') chain = chain.then(() => load(m))
  else if (m.t === 'synth' && typeof m.id === 'number' && typeof m.text === 'string' && m.text.length <= 4000) chain = chain.then(() => synth(m))
})
