/**
 * Whisper prompt and language for local dictation (app 2.5.0). Pure.
 *
 * whisper.cpp has no hotwords: the `prompt` field is its only bias, and a
 * coding vocabulary turns "paquillei eso uen" into "package.json". The
 * prompt is a base for the language plus the workspace name, the pane's cwd
 * folder name and the user's vocabulary, one line, at most PROMPT_MAX_CHARS.
 * Main looks the workspace and folder up from its config cache by paneId;
 * nothing here comes from the renderer as is. The prompt travels per request,
 * never on argv, and is never logged.
 *
 * The full sentence is only used for Spanish and English: for any other
 * language an English sentence would pull the output toward English, so it
 * gets the bare term list. With `auto`, the app language picks the base.
 */
import type { Language } from '@shared/types'

export const PROMPT_MAX_CHARS = 600
export const VOCAB_MAX_CHARS = 400
/** Workspace and folder names are cut at this length before joining. */
export const NAME_MAX_CHARS = 80

export const WHISPER_LANGS: ReadonlySet<string> = new Set([
  'es', 'en', 'pt', 'fr', 'de', 'it', 'ca', 'gl', 'eu', 'nl', 'pl', 'ru', 'uk', 'ja', 'zh',
  'ko', 'tr', 'ar', 'hi', 'sv', 'da', 'no', 'fi', 'cs', 'ro', 'hu', 'el', 'he',
])

/** The primary subtag ("es-AR" gives "es") when Whisper knows it, else 'auto'. */
export function whisperLang(tag: string): string {
  if (typeof tag !== 'string') return 'auto'
  const primary = tag.trim().toLowerCase().replace(/_/g, '-').split('-')[0]
  return WHISPER_LANGS.has(primary) ? primary : 'auto'
}

export const BASE_TERMS =
  'package.json, npm run typecheck, npm test, npm install, git commit, git push, pull request, merge, branch, TypeScript, JavaScript, React, Electron, Node, Python, Claude, Codex, README, JSON, API, CLI, PowerShell.'

/** The sentence and label before the term list; the echo filter knows a read-back prompt by them. */
export const PROMPT_HEAD: Record<Language, { sentence: string; label: string }> = {
  es: { sentence: 'Dictado para una terminal de programación.', label: 'Términos:' },
  en: { sentence: 'Dictation for a programming terminal.', label: 'Terms:' },
}

export const BASE_PROMPT: Record<Language, string> = {
  es: `${PROMPT_HEAD.es.sentence} ${PROMPT_HEAD.es.label} ${BASE_TERMS}`,
  en: `${PROMPT_HEAD.en.sentence} ${PROMPT_HEAD.en.label} ${BASE_TERMS}`,
}

/** One line of printable text: controls, separators and odd spaces become one space. */
function oneLine(v: string): string {
  return v.replace(/[\p{C}\p{Z}]/gu, ' ').split(/\s+/).filter(Boolean).join(' ')
}

/** `text` cut at `max` chars, at the last space inside when there is one. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd()
}

/** The user's vocabulary as one printable line of at most VOCAB_MAX_CHARS, cut at a word boundary. */
export function cleanVocabulary(v: string): string {
  if (typeof v !== 'string') return ''
  return cutAtWord(oneLine(v), VOCAB_MAX_CHARS)
}

/** The base text for a request language (a tag or 'auto') and the app language. */
export function basePrompt(lang: string, appLang: Language = 'en'): string {
  const l = whisperLang(lang)
  const effective = l === 'auto' ? appLang : l
  if (effective === 'es') return BASE_PROMPT.es
  if (effective === 'en') return BASE_PROMPT.en
  return BASE_TERMS
}

export interface PromptContext {
  workspace?: string
  folder?: string
  vocabulary?: string
  /** Picks the base when `lang` is 'auto'. Defaults to English. */
  appLang?: Language
}

export function buildPrompt(lang: string, ctx: PromptContext = {}): string {
  const names: string[] = []
  for (const raw of [ctx.workspace, ctx.folder]) {
    const name = typeof raw === 'string' ? cutAtWord(oneLine(raw), NAME_MAX_CHARS) : ''
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name)
  }
  const vocab = cleanVocabulary(ctx.vocabulary ?? '')
  const extra = [...names, vocab].filter(Boolean).join(', ')
  const text = oneLine(extra ? `${basePrompt(lang, ctx.appLang)} ${extra}` : basePrompt(lang, ctx.appLang))
  return cutAtWord(text, PROMPT_MAX_CHARS)
}
