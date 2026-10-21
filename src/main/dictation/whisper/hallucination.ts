/**
 * Whisper hallucination filter for local dictation (app 2.5.0). Pure, per
 * `verbose_json` segment. Ported from SnClips
 * (apps/api/src/snclips/pipeline/transcribe.py: _CREDIT_PATTERNS,
 * _WEAK_PATTERNS, _normalize, _silence_hallucination) with its constants,
 * plus three rules for dictation:
 * - `tag`: a segment made only of bracket tags or music notes ("[Música]",
 *   "(aplausos)", "[BLANK_AUDIO]", "♪").
 * - `unsure`: a lone "Gracias." or "Thank you." that Whisper was not sure of
 *   (a user may really say it, so a confident one stays).
 * - `prompt`: Whisper sometimes reads the prompt back on near-silence. The
 *   prompt is a list of exactly what a user dictates in a terminal ("git
 *   commit, git push", the workspace name, the vocabulary), so a run of
 *   prompt words alone proves nothing. When Whisper was unsure (low word
 *   probability or log probability, or a high no-speech probability), a
 *   segment of at least ECHO_MIN_WORDS words found word for word in the
 *   prompt, or one of at least ECHO_RATIO_MIN_WORDS words made 80% of prompt
 *   words, is an echo. When it was sure, only the prompt's own head is: its
 *   sentence ("Dictado para una terminal de programación"), a run that starts
 *   with its label ("Términos: ..."), or a run of ECHO_SURE_MIN_WORDS words or
 *   more of the prompt.
 *
 * whisper-server runs with `-nt`, so an answer is one segment and `alone` is
 * always true: the YouTube outros ("Suscríbete al canal") match a confident
 * segment only as the whole phrase (OUTRO_PATTERNS); the looser prefixes
 * (WEAK_PATTERNS) need Whisper to be unsure. "Suscribir el listener al
 * evento" is speech.
 *
 * `no_speech_prob` is near zero on most of these (9.7e-12 for a turbo
 * "Gracias.", 2.3e-6 for a small "[Música]" in the spike), so the `silence`
 * rule is kept for parity; `vad=true` on every request does the real work.
 */
import { PROMPT_HEAD } from './prompt'
import type { VerboseSegment } from './verbose'

export const CREDIT_MAX_WORDS = 10
export const WEAK_PHRASE_MAX_P = 0.5
export const ALONE_MAX_WORDS = 6
export const NO_SPEECH_PROB = 0.6
export const LOW_AVG_LOGPROB = -1.0
export const ECHO_MIN_WORDS = 4
export const ECHO_RATIO_MIN_WORDS = 8
export const ECHO_RATIO = 0.8
/** A confident segment is an echo of the bare term list only from this many prompt words in a row. */
export const ECHO_SURE_MIN_WORDS = 12

/** Lowercase, no accents, no leading punctuation (Spanish inverted marks), single spaces. */
export function normalize(text: string): string {
  const decomposed = String(text ?? '').toLowerCase().normalize('NFKD')
  const stripped = decomposed.replace(/\p{M}/gu, '').replace(/^[^\p{L}\p{N}_]+/u, '')
  return stripped.split(/\s+/).filter(Boolean).join(' ')
}

// Credits Whisper learned from subtitle files: never real speech. Matched on
// the normalized text of segments of at most CREDIT_MAX_WORDS words; the
// domain needs its dot and word boundaries ("Tamara organizó" is speech).
export const CREDIT_PATTERNS: readonly RegExp[] = [
  /\bamara\s*\.\s*org\b/,
  /^subtitul(?:os|ado|ados)\s+(?:realizados\s+|hechos\s+|creados\s+)?por\s+(?:la\s+comunidad|amara)\b/,
  /^subtitles?\s+(?:made\s+)?by\s+(?:the\s+)?(?:amara|community)\b/,
  /^sous-titres?\s+(?:realises\s+)?par\b/,
  /\btranscri\w*\s+(?:\w+\s+){0,2}por\s+la\s+comunidad\s+de\s+amara\b/,
]

// Phrases real speakers also say, as prefixes (SnClips): dropped only when
// Whisper was unsure of them.
export const WEAK_PATTERNS: readonly RegExp[] = [
  /^gracias por (?:ver|mirar)\b/,
  /^(?:no te olvides de |no olvides )?suscrib\w*/,
  /^thanks? (?:you )?for watching\b/,
]

// The same outros as whole phrases: a confident short answer that is
// nothing but one of them is still dropped.
export const OUTRO_PATTERNS: readonly RegExp[] = [
  /^gracias por (?:ver|mirar)(?: (?:el|este|mi) video)?[.!]*$/,
  /^(?:no te olvides de |no olvides )?suscrib(?:ete|anse|irte|ase)(?: (?:a|al) (?:mi |nuestro |este )?canal)?(?: y (?:dale|denle|deja|dejen|activa|activen)\b[^.!?]*)?[.!]*$/,
  /^thanks? (?:you )?for watching(?: (?:this|the|my) video)?[.!]*$/,
]

export const UNSURE_ONLY: readonly RegExp[] = [/^gracias[.!]?$/, /^thank you[.!]?$/]

/** Tested on the raw trimmed text: normalize() would strip the leading bracket. */
export const TAG_ONLY: readonly RegExp[] = [/^(?:[[(][^\])]{1,40}[\])][\s.,!?]*)+$/u, /^[♪♫\s.]+$/u]

export type DropReason = 'credit' | 'tag' | 'weak' | 'unsure' | 'silence' | 'prompt'

/** Words for the echo check: normalized, punctuation as a separator ("package.json" is "package json"). */
function echoWords(text: string): string[] {
  return normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

const padded = (words: readonly string[]): string => ` ${words.join(' ')} `

export interface PromptEcho {
  /** The prompt's words, space separated and padded with one space at each end. */
  joined: string
  words: ReadonlySet<string>
  /** The head sentences this prompt carries, padded like `joined`. */
  heads: readonly string[]
  /** The words that open its term list ("terminos", "terms"). */
  labels: ReadonlySet<string>
}

/** Precomputes the echo check for a prompt; null for an empty one. */
export function promptEcho(prompt: string): PromptEcho | null {
  const words = echoWords(prompt)
  if (words.length === 0) return null
  const joined = padded(words)
  const heads: string[] = []
  const labels = new Set<string>()
  for (const h of Object.values(PROMPT_HEAD)) {
    const sentence = padded(echoWords(h.sentence))
    const label = echoWords(h.label)[0]
    if (joined.includes(sentence)) heads.push(sentence)
    if (label && joined.includes(` ${label} `)) labels.add(label)
  }
  return { joined, words: new Set(words), heads, labels }
}

/** `sure`: Whisper was confident of the segment (see the file comment). */
function isEcho(text: string, echo: PromptEcho, sure: boolean): boolean {
  const words = echoWords(text)
  if (words.length < ECHO_MIN_WORDS) return false
  const run = padded(words)
  const inPrompt = echo.joined.includes(run)
  if (sure) {
    if (echo.heads.some((h) => run.includes(h))) return true
    return inPrompt && (echo.labels.has(words[0]) || words.length >= ECHO_SURE_MIN_WORDS)
  }
  if (inPrompt) return true
  if (words.length < ECHO_RATIO_MIN_WORDS) return false
  const known = words.filter((w) => echo.words.has(w)).length
  return known / words.length >= ECHO_RATIO
}

/**
 * Why a segment should be dropped, or null to keep it. `alone` means it is
 * the only segment with text in the answer.
 */
export function dropReason(seg: VerboseSegment, alone: boolean, echo: PromptEcho | null = null): DropReason | null {
  const raw = String(seg.text ?? '').trim()
  if (!raw) return null
  if (TAG_ONLY.some((p) => p.test(raw))) return 'tag'
  const norm = normalize(raw)
  if (!norm) return null
  const lowP = seg.meanP !== undefined && seg.meanP < WEAK_PHRASE_MAX_P
  const unsure = lowP || (seg.avgLogprob !== undefined && seg.avgLogprob < LOW_AVG_LOGPROB)
  if (seg.noSpeechProb !== undefined && seg.avgLogprob !== undefined && seg.noSpeechProb > NO_SPEECH_PROB && seg.avgLogprob < LOW_AVG_LOGPROB) return 'silence'
  const words = norm.split(' ').length
  if (words <= CREDIT_MAX_WORDS && CREDIT_PATTERNS.some((p) => p.test(norm))) return 'credit'
  const noSpeech = seg.noSpeechProb !== undefined && seg.noSpeechProb > NO_SPEECH_PROB
  if (echo && isEcho(raw, echo, !(unsure || noSpeech))) return 'prompt'
  if (lowP && WEAK_PATTERNS.some((p) => p.test(norm))) return 'weak'
  if (alone && words <= ALONE_MAX_WORDS && OUTRO_PATTERNS.some((p) => p.test(norm))) return 'weak'
  if (unsure && UNSURE_ONLY.some((p) => p.test(norm))) return 'unsure'
  return null
}

/** The text of the segments that survive, joined with single spaces, and why the others went. */
export function keptText(segs: readonly VerboseSegment[], prompt = ''): { text: string; dropped: DropReason[] } {
  const echo = promptEcho(prompt)
  const withText = segs.filter((s) => String(s.text ?? '').trim() !== '')
  const alone = withText.length === 1
  const kept: string[] = []
  const dropped: DropReason[] = []
  for (const seg of withText) {
    const reason = dropReason(seg, alone, echo)
    if (reason) dropped.push(reason)
    else kept.push(String(seg.text).trim())
  }
  return { text: kept.join(' ').split(/\s+/).filter(Boolean).join(' '), dropped }
}
