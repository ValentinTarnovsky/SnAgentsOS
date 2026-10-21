/**
 * Desktop dictation (app 2.4.0): the codes and limits main, the preload and
 * the renderer agree on. The engine runs in a PowerShell helper spawned by
 * main (Windows online recognizer, offline SAPI fallback); the renderer only
 * gets text, and types it as the user would, never with Enter.
 */
import type { DictationEngine } from './types'

export const DICTATION_ENGINES: readonly DictationEngine[] = ['auto', 'online', 'offline']

/** Same rule as settings.dictation.language (schema 17) minus 'auto', which the renderer resolves. */
export const DICTATION_LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/

/** Longest dictated text kept from one helper line. */
export const DICTATION_TEXT_MAX = 2000

/**
 * Why a session could not start or stopped. The helper reports the first
 * eight; `spawn`, `exit` and `unsupported` come from main.
 *  - privacy: "Online speech recognition" is off in Windows (StartAsync 0x80045509).
 *  - mic_denied: Windows blocks the microphone for desktop apps (0x80070005).
 *  - no_mic / audio / network: no input device, bad audio, the online service unreachable.
 *  - no_recognizer: no SAPI recognizer installed (offline engine).
 *  - compile / start: the online recognizer could not be prepared or started.
 */
export const DICTATION_ERRORS = [
  'privacy',
  'mic_denied',
  'no_mic',
  'no_recognizer',
  'compile',
  'start',
  'network',
  'audio',
  'internal',
  'spawn',
  'exit',
  'unsupported',
] as const
export type DictationError = (typeof DICTATION_ERRORS)[number]

export function isDictationError(v: unknown): v is DictationError {
  return typeof v === 'string' && (DICTATION_ERRORS as readonly string[]).includes(v)
}

/** The Windows settings page an error points to; null when none helps. */
export function dictationSettingsPage(code: DictationError | null | undefined): 'speech' | 'microphone' | null {
  if (code === 'privacy') return 'speech'
  if (code === 'mic_denied' || code === 'no_mic') return 'microphone'
  return null
}
