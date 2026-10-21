/**
 * Dictation on the phone (v2.2): the browser's speech recognition
 * (SpeechRecognition, webkitSpeechRecognition on Chrome and Safari) turns
 * speech into text that lands in a field at the caret, never with Enter, so
 * it works the same for a console behind a Connection Profile (SSH): the text
 * is typed into the remote shell like any other.
 *
 * Browsers only give the microphone to a secure origin: on the plain http
 * address the phone offers the desktop's https one (secure mode) or the
 * keyboard's own microphone instead. One dictation at a time, held here so a
 * Send, a pane change or a hidden page can stop it from anywhere.
 */
import { create } from 'zustand'
import { nextFinal, VOICE_LANGS, type VoiceLangPref } from '@shared/voiceText'
import { STORAGE_PREFIX, storageGet, storageSet } from './mobileStorage'

// The pure text rules are shared with the desktop dictation (@shared/voiceText).
export { VOICE_LANGS, voiceLang, cased, spaced, nextFinal, type VoiceLangPref } from '@shared/voiceText'

export type VoiceSupport = 'ok' | 'insecure' | 'unsupported'

/** The slice of the Web Speech API this file uses. */
interface RecognitionResultLike {
  isFinal: boolean
  0?: { transcript: string }
}
interface RecognitionEventLike {
  resultIndex: number
  results: ArrayLike<RecognitionResultLike>
}
export interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: RecognitionEventLike) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
export type RecognitionCtor = new () => RecognitionLike

export function recognitionCtor(win: unknown = typeof window !== 'undefined' ? window : undefined): RecognitionCtor | null {
  const w = win as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } | undefined
  return w?.SpeechRecognition ?? w?.webkitSpeechRecognition ?? null
}

/** Insecure first: on http the advice is the https address even where the API hides. */
export function voiceSupport(win: unknown = typeof window !== 'undefined' ? window : undefined): VoiceSupport {
  try {
    if (!(win as { isSecureContext?: boolean } | undefined)?.isSecureContext) return 'insecure'
    return recognitionCtor(win) ? 'ok' : 'unsupported'
  } catch {
    return 'unsupported'
  }
}

// --- Language -----------------------------------------------------------------------

const VOICE_LANG_KEY = `${STORAGE_PREFIX}remote.voiceLang`

export function loadVoiceLang(): VoiceLangPref {
  const v = storageGet(VOICE_LANG_KEY)
  return (VOICE_LANGS as readonly string[]).includes(v ?? '') ? (v as VoiceLangPref) : 'auto'
}

export function saveVoiceLang(pref: VoiceLangPref): void {
  storageSet(VOICE_LANG_KEY, pref)
}

// --- The one dictation ----------------------------------------------------------------

export type VoiceError = 'denied' | 'noSpeech' | 'failed'

interface VoiceState {
  /** Who is dictating (a field id), or null. */
  owner: string | null
  /** Words heard but not final yet. */
  interim: string
}

export const useVoiceStore = create<VoiceState>(() => ({ owner: null, interim: '' }))

/**
 * The running session. `stopping`: the user ended it and the browser is
 * still delivering its last final words; `discard`: drop them (a Send).
 */
let active: { owner: string; rec: RecognitionLike; stopping: boolean; discard: boolean } | null = null

export interface DictationHandlers {
  /** Final words, already deduplicated; the caller places them (see `spaced`). */
  onFinal(text: string): void
  onError?(error: VoiceError): void
}

/** Starts dictating for `owner` (ending any other dictation). False when it cannot start. */
export function startDictation(owner: string, lang: string, h: DictationHandlers, ctor: RecognitionCtor | null = recognitionCtor()): boolean {
  stopDictation(undefined, true)
  if (!ctor) return false
  let rec: RecognitionLike
  try {
    rec = new ctor()
  } catch {
    return false
  }
  rec.lang = lang
  rec.continuous = true
  rec.interimResults = true
  let committed = ''
  const session = { owner, rec, stopping: false, discard: false }
  const mine = (): boolean => active === session
  rec.onresult = (e) => {
    if (!mine() || session.discard) return
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      const text = r?.[0]?.transcript ?? ''
      if (r?.isFinal) {
        const next = nextFinal(committed, text)
        committed = next.committed
        if (next.fresh) h.onFinal(next.fresh)
      } else interim += text
    }
    if (!session.stopping) useVoiceStore.setState({ interim: interim.replace(/\s+/g, ' ').trim() })
  }
  rec.onerror = (e) => {
    if (!mine()) return
    const code = e?.error ?? ''
    // `aborted` is our own stop; a stop the user asked for is not an error.
    if (code === 'aborted' || session.stopping) return
    h.onError?.(code === 'not-allowed' || code === 'service-not-allowed' ? 'denied' : code === 'no-speech' ? 'noSpeech' : 'failed')
  }
  rec.onend = () => {
    if (!mine()) return
    active = null
    useVoiceStore.setState({ owner: null, interim: '' })
  }
  active = session
  useVoiceStore.setState({ owner, interim: '' })
  try {
    rec.start()
  } catch {
    active = null
    useVoiceStore.setState({ owner: null, interim: '' })
    return false
  }
  return true
}

/**
 * Ends the dictation (of `owner` only, when given). The words the browser
 * finalizes on the way out still arrive, unless `discard` (a Send: what was
 * sent is what the field showed).
 */
export function stopDictation(owner?: string, discard = false): void {
  const session = active
  if (!session || (owner !== undefined && session.owner !== owner)) return
  session.stopping = true
  if (discard) {
    session.discard = true
    active = null
  }
  useVoiceStore.setState({ owner: null, interim: '' })
  try {
    session.rec.stop()
  } catch {
    if (active === session) active = null
  }
}
