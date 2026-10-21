/**
 * Desktop dictation (app 2.5.0): the codes, limits and install contracts
 * main, the preload and the renderer agree on. The engine is a local
 * whisper.cpp server spawned by main (GPU through CUDA, or CPU); the renderer
 * captures the microphone (16 kHz mono s16) and only gets text back, which
 * it types as the user would, never with Enter. Model packs are downloaded
 * from Settings only, into `dataDir()/whisper`.
 */
import type { DictationDevice, Language } from './types'

export const DICTATION_DEVICES: readonly DictationDevice[] = ['auto', 'gpu', 'cpu']

/** Same rule as settings.dictation.language (schema 17) minus 'auto', which the renderer resolves. */
export const DICTATION_LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/

/** Longest dictated text kept from one phrase. */
export const DICTATION_TEXT_MAX = 2000

/** Capture rate: the renderer sends 16 kHz mono signed 16-bit PCM. */
export const DICTATION_SAMPLE_RATE = 16000

/** Largest `dictation:audio` chunk main accepts: 1 s of s16 mono at 16 kHz. */
export const DICTATION_CHUNK_MAX_BYTES = 32000

/**
 * Why a session could not start or stopped.
 *  - model_missing: no installed pack serves the chosen device (Settings > Dictado).
 *  - vcredist: the Microsoft VC++ 2015-2022 runtime (14.40 or later) is missing or too old.
 *  - gpu_failed: the GPU engine failed and the session runs on CPU (only as `fallback`),
 *    or it failed with no CPU pack to fall back to.
 *  - mic_denied / no_mic / audio: the microphone is blocked, absent or unreadable.
 *  - timeout: one phrase took too long (not fatal).
 *  - internal / spawn / exit: main or the engine process failed.
 *  - unsupported: not Windows x64.
 */
export const DICTATION_ERRORS = [
  'model_missing',
  'vcredist',
  'gpu_failed',
  'mic_denied',
  'no_mic',
  'audio',
  'timeout',
  'internal',
  'spawn',
  'exit',
  'unsupported',
] as const
export type DictationError = (typeof DICTATION_ERRORS)[number]

export function isDictationError(v: unknown): v is DictationError {
  return typeof v === 'string' && (DICTATION_ERRORS as readonly string[]).includes(v)
}

/**
 * What the overlay offers for an error: the Windows microphone privacy page,
 * the VC++ runtime download, or Settings > Dictado (the packs). `audio` points
 * to the microphone page too: Chromium reports a mic blocked by Windows
 * privacy as NotReadableError / AbortError.
 */
export function dictationAction(code: DictationError | null | undefined): 'microphone' | 'vcredist' | 'models' | null {
  if (code === 'mic_denied' || code === 'no_mic' || code === 'audio') return 'microphone'
  if (code === 'vcredist') return 'vcredist'
  if (code === 'model_missing' || code === 'gpu_failed') return 'models'
  return null
}

/** Why a pack install or removal failed. */
export const WHISPER_INSTALL_ERRORS = ['network', 'http', 'size', 'sha256', 'disk', 'extract', 'warmup', 'cancelled', 'busy', 'unsupported'] as const
export type WhisperInstallError = (typeof WHISPER_INSTALL_ERRORS)[number]

export function isWhisperInstallError(v: unknown): v is WhisperInstallError {
  return typeof v === 'string' && (WHISPER_INSTALL_ERRORS as readonly string[]).includes(v)
}

/**
 * Downloadable packs. `cpu` = CPU runtime + small model + VAD; `gpu` = the
 * cpu pack + CUDA runtime + large-v3-turbo, so the GPU always has a CPU
 * fallback. Defined only here; main's catalog imports it.
 */
export type WhisperPackId = 'cpu' | 'gpu'
export const PACK_IDS: readonly WhisperPackId[] = ['cpu', 'gpu']

export function isWhisperPackId(v: unknown): v is WhisperPackId {
  return typeof v === 'string' && (PACK_IDS as readonly string[]).includes(v)
}

export type WhisperInstallPhase = 'download' | 'verify' | 'extract' | 'warmup' | 'done' | 'error'

/** Main -> renderer `dictation:installProgress` (throttled). Bytes cover the whole pack. */
export interface WhisperInstallProgress {
  pack: WhisperPackId
  phase: WhisperInstallPhase
  transferred: number
  total: number
  error?: WhisperInstallError
}

export interface WhisperPackInfo {
  id: WhisperPackId
  installed: boolean
  /** Bytes still to download for the whole pack when nothing is installed (catalog total). */
  downloadBytes: number
  /** Bytes the pack takes on disk once installed (extracted runtimes included). */
  diskBytes: number
}

/** `dictation:models`: what Settings shows for the local engine. */
export interface WhisperStatus {
  /** Windows x64 only. */
  supported: boolean
  /** An NVIDIA GPU was found (cached at startup). */
  nvidia: boolean
  /** The VC++ 2015-2022 runtime 14.40 or later is installed. */
  vcRuntime: boolean
  /** Absolute folder the packs live in (`<dataDir>/whisper`), shown in Settings. */
  dataDir: string
  packs: WhisperPackInfo[]
  /** The install that is running, or the last one's final state; null when none. */
  install: WhisperInstallProgress | null
  /** The engine server that is up right now, if any. */
  loaded: { device: 'gpu' | 'cpu' } | null
  /** A GPU warmup (first CUDA JIT) is running. */
  warming: boolean
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Human size with decimal units (1 KB = 1000 B, like download pages). One
 * decimal below 10 units, none above; Spanish uses a decimal comma.
 * formatBytes(199899225, 'es') === '200 MB', formatBytes(1759000704, 'en') === '1.8 GB'.
 */
export function formatBytes(n: number, lang: Language): string {
  const v0 = Number.isFinite(n) && n > 0 ? n : 0
  if (v0 < 1000) return `${Math.round(v0)} B`
  let unit = 0
  let v = v0
  while (v >= 1000 && unit < BYTE_UNITS.length - 1) {
    v /= 1000
    unit++
  }
  let text = v < 10 ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v))
  // 999.6 MB rounds to 1000: show the next unit instead.
  if (Number(text) >= 1000 && unit < BYTE_UNITS.length - 1) {
    unit++
    text = (Math.round((v / 1000) * 10) / 10).toFixed(1)
  }
  if (text.endsWith('.0')) text = text.slice(0, -2)
  if (lang === 'es') text = text.replace('.', ',')
  return `${text} ${BYTE_UNITS[unit]}`
}
