/**
 * Hands-free voice (app 2.11.0, schema 22, Labs `voice`): settings, limits and
 * the IPC payloads main, renderer and the tests share. Pure, no Node or DOM
 * imports.
 *
 * The local voice is Supertonic 3 through sherpa-onnx (speaker ids below);
 * ElevenLabs is optional and cache-first. Narration lives in main (one queue,
 * never two voices at once); listening, the wake word and the dictation
 * buffer live in the renderer.
 */

export type VoiceLanguage = 'auto' | 'es' | 'en'
export type VoiceGender = 'male' | 'female'
export type VoiceEngine = 'local' | 'elevenlabs'
export type VoiceSummarizer = 'claude' | 'local'
/** fixedOnly: ElevenLabs only for the fixed phrases (generated once, cached); all: summaries too, up to the monthly cap. */
export type ElevenMode = 'fixedOnly' | 'all'

/** Supertonic 3 speaker ids the user picked (2026-11-07): 9 for the male voice, 4 for the female one. */
export const SUPERTONIC_SPEAKERS: Readonly<Record<VoiceGender, number>> = { male: 9, female: 4 }

export interface VoiceNarrationSettings {
  enabled: boolean
  /** Announce a console that finished its turn. */
  done: boolean
  /** Announce a console that waits on a permission, a question or a plan. */
  action: boolean
  /** Announce a console whose turn failed. */
  error: boolean
  /** Consoles that finish within this window go in one announcement. */
  groupMs: number
  /** A reply this short (after cleaning) is read as it is, without a summary. */
  shortMaxChars: number
  summarizer: VoiceSummarizer
  /** Summarize a reply as soon as its console is announced, so "lee X" is instant. */
  prefetch: boolean
  /** No announcement for the console in view while the window has focus. */
  skipInView: boolean
  /** No status chime while hands-free is on (the voice says it). */
  muteChimes: boolean
}

export interface VoiceTtsSettings {
  engine: VoiceEngine
  voice: VoiceGender
  speed: number
  volume: number
}

export interface VoiceElevenSettings {
  voiceId: string
  model: string
  mode: ElevenMode
  /** Characters a month for variable text in mode `all` (fixed phrases are counted too, once). */
  monthlyCap: number
  /** Day of the month the ElevenLabs period starts (1..28). */
  resetDay: number
  cacheMaxMb: number
}

/** settings.voice (schema 22). */
export interface VoiceSettings {
  /** '' = the language default ("Agente" / "Agent"). */
  wakeWord: string
  language: VoiceLanguage
  /** After a bare wake word, the next phrase is a command without it (seconds). */
  followUpSec: number
  /** A dictation with no phrase for this long is held for review (seconds). */
  dictateIdleSec: number
  /** While dictating, a phrase that is only "enviar", "insertar" or "cancelar" counts without the wake word. */
  bareCommands: boolean
  /** Hands-free turns itself off after this many minutes without a command; 0 = never. */
  autoOffMin: number
  /** An Electron accelerator ("CommandOrControl+Alt+V"); '' = none. */
  globalHotkey: string
  narration: VoiceNarrationSettings
  tts: VoiceTtsSettings
  eleven: VoiceElevenSettings
}

export const VOICE_LIMITS = {
  wakeWordMax: 24,
  followUpSec: [3, 15],
  dictateIdleSec: [15, 600],
  autoOffMin: [0, 1440],
  groupMs: [500, 6000],
  shortMaxChars: [0, 600],
  speed: [0.7, 1.6],
  volume: [0, 100],
  monthlyCap: [0, 10_000_000],
  resetDay: [1, 28],
  cacheMaxMb: [16, 2048],
  hotkeyMax: 64,
  voiceIdMax: 64,
  modelMax: 64,
} as const

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  wakeWord: '',
  language: 'auto',
  followUpSec: 6,
  dictateIdleSec: 90,
  bareCommands: true,
  autoOffMin: 240,
  globalHotkey: '',
  narration: { enabled: true, done: true, action: true, error: true, groupMs: 2500, shortMaxChars: 240, summarizer: 'claude', prefetch: true, skipInView: true, muteChimes: true },
  tts: { engine: 'local', voice: 'male', speed: 1.15, volume: 80 },
  eleven: { voiceId: '', model: 'eleven_flash_v2_5', mode: 'fixedOnly', monthlyCap: 10_000, resetDay: 1, cacheMaxMb: 256 },
}

/** The wake word in force: the setting, else "Agente" (es) / "Agent" (en). */
export function wakeWordFor(setting: string | undefined, lang: 'es' | 'en'): string {
  const w = typeof setting === 'string' ? setting.trim() : ''
  return w || (lang === 'en' ? 'Agent' : 'Agente')
}

/** The language hands-free speaks and listens in: the setting, else the app language. */
export function voiceLangOf(setting: VoiceLanguage | undefined, appLang: string | undefined): 'es' | 'en' {
  if (setting === 'es' || setting === 'en') return setting
  return appLang === 'en' ? 'en' : 'es'
}

// --- IPC payloads -----------------------------------------------------------

/** The renderer controller's mode, told to main (voice:mode) for the narration holds. */
export type VoiceMode = 'off' | 'listening' | 'armed' | 'dictating' | 'confirming' | 'paused'
export const VOICE_MODES: readonly VoiceMode[] = ['off', 'listening', 'armed', 'dictating', 'confirming', 'paused']

/**
 * Fixed phrase keys main can say on the renderer's request (`voice:cmd say`):
 * never free text from the renderer. Their words live in src/main/i18n.ts
 * (`voice.say.<key>`); `{name}` is a console or workspace label main checks
 * against the roster, `{n}` a small number.
 */
export const VOICE_SAY_KEYS = [
  'listening', 'off', 'yes', 'notUnderstood', 'workspace', 'console', 'notFound', 'ambiguous',
  'dictating', 'sent', 'inserted', 'cancelled', 'emptyBuffer', 'awaitingUser', 'held', 'noConsole',
  'nothingToRead', 'nothingWaiting', 'help', 'autoOff',
] as const
export type VoiceSayKey = (typeof VOICE_SAY_KEYS)[number]

export type VoiceCmd =
  | { kind: 'read'; paneId?: string; full?: boolean }
  | { kind: 'next' }
  | { kind: 'repeat' }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'say'; key: VoiceSayKey; paneId?: string; workspaceId?: string; options?: string[] }

export interface VoiceCmdRes {
  ok: boolean
  error?: 'disabled' | 'bad_request' | 'not_found' | 'nothing'
}

/** One console of the roster the renderer sends (voice:roster), checked against main's config. */
export interface VoiceRosterPane {
  id: string
  /** What the user says for it (spokenLabels), one line, <= VOICE_LABEL_MAX. */
  label: string
}

export interface VoiceRosterWorkspace {
  id: string
  label: string
  panes: VoiceRosterPane[]
}

export interface VoiceRoster {
  workspaces: VoiceRosterWorkspace[]
}

export const VOICE_LABEL_MAX = 60
export const VOICE_ROSTER_MAX_PANES = 400

/** Main -> renderer: audio to play (s16 mono PCM), one at a time. */
export interface VoicePlay {
  id: number
  rate: number
  pcm: ArrayBuffer
  /** 0..1. */
  gain: number
}

export type VoicePlayOutcome = 'ended' | 'stopped' | 'error'

export type VoiceEvent =
  | { t: 'toggle' }
  | { t: 'stopPlayback' }
  | { t: 'autoOff' }
  | { t: 'speaking'; on: boolean; queued: number }
  | { t: 'notice'; code: 'elevenCap' | 'elevenFailed' | 'engineMissing' | 'engineFailed' }

export type VoicePackPhase = 'download' | 'verify' | 'extract' | 'warmup' | 'done' | 'error'

/** Main -> renderer `voice:installProgress` (throttled): bytes over the whole pack. */
export interface VoiceInstallProgress {
  phase: VoicePackPhase
  transferred: number
  total: number
  /** A WhisperInstallError code (the shared pack installer). */
  error?: string
}

export interface VoiceStatus {
  /** Windows x64 (the local engine and the dictation pipeline are Windows only). */
  supported: boolean
  lab: boolean
  pack: { installed: boolean; downloadBytes: number; diskBytes: number }
  install: VoiceInstallProgress | null
  /** Whisper dictation pack present (hands-free listens through it). */
  dictationReady: boolean
  eleven: { keySet: boolean; last4: string; usedChars: number; periodStart: string }
  /** The Claude CLI was found (summaries); false falls back to the local summary. */
  claudeFound: boolean
  /** narrator@better-claude is enabled in the Claude settings: tell the user to run /narrator off. */
  narratorMod: boolean
}

/** Every renderer string main accepts as a pane id or workspace id. */
export function isVoiceId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128
}
