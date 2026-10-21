/**
 * Pure text rules for dictation, shared by the phone (Web Speech API) and the
 * desktop (Windows recognizer). The text lands in a field or a console at the
 * caret, never with Enter.
 */
import type { Language } from './types'

// --- Language -----------------------------------------------------------------------

export const VOICE_LANGS = ['auto', 'es-AR', 'es-ES', 'es-MX', 'en-US', 'en-GB'] as const
export type VoiceLangPref = (typeof VOICE_LANGS)[number]

/** The recognition language: the saved one, else the phone's when it matches the app language, else a default of it. */
export function voiceLang(pref: string, appLang: Language, navLang = ''): string {
  if (pref !== 'auto' && (VOICE_LANGS as readonly string[]).includes(pref)) return pref
  const nav = navLang.trim()
  if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(nav) && nav.toLowerCase().startsWith(appLang)) return nav
  return appLang === 'es' ? 'es-ES' : 'en-US'
}

// --- Text ---------------------------------------------------------------------------

/**
 * The engine capitalizes every final result as if it opened a sentence; in the
 * middle of one, a plain Capitalized first word goes lowercase.
 */
export function cased(before: string, chunk: string): string {
  const prev = before.replace(/[ \t]+$/, '')
  // Start of the field, a new line, or after . ! ? ...: keep the engine's capital.
  if (!prev || /[\n.!?…]$/.test(prev)) return chunk
  const m = /^(\p{Lu})(\p{Ll}*)(?=$|[^\p{L}])/u.exec(chunk)
  // Only a plain Capitalized word: "I"/"I'm", acronyms (API) and mixed case (iPhone, GitHub) stay.
  if (!m || (m[1] === 'I' && m[2] === '')) return chunk
  return m[1].toLowerCase() + chunk.slice(1)
}

/** A dictated `chunk` after `before`: one space between words, none before punctuation or after whitespace, and the case of the first word fixed (`cased`). */
export function spaced(before: string, chunk: string): string {
  const text = cased(before, chunk.replace(/\s+/g, ' ').trim())
  if (!text) return ''
  if (!before || /\s$/.test(before) || /^[.,;:!?)\]]/.test(text)) return text
  return ' ' + text
}

/**
 * The new words of a final result. Some Android builds repeat the whole
 * session in every final result; then only what follows the words already
 * committed is new.
 */
export function nextFinal(committed: string, text: string): { fresh: string; committed: string } {
  const full = text.replace(/\s+/g, ' ').trim()
  if (!full) return { fresh: '', committed }
  // Only at a word boundary: "hola" then "holanda" is a new word, not "nda".
  const repeat = !!committed && full.toLowerCase().startsWith(committed.toLowerCase())
    && (full.length === committed.length || full[committed.length] === ' ')
  if (repeat) {
    return { fresh: full.slice(committed.length).trim(), committed: full }
  }
  return { fresh: full, committed: committed ? `${committed} ${full}` : full }
}
