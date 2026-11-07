/**
 * Hands-free voice (app 2.11.0): an agent reply as text to say. Pure, no
 * Node or DOM. Code becomes a word, a path becomes its file's name, hashes
 * and markdown go away; a short reply is read as it is, a long one is
 * summarized (by Haiku in main, or by localSummary here when that fails).
 */

const FENCE = /```[\s\S]*?(?:```|$)/g
const URL_RE = /\bhttps?:\/\/([^/\s)]+)[^\s)]*/gi
const MD_LINK = /\[([^\]]+)\]\((?:[^)]+)\)/g
const INLINE_CODE = /`([^`\n]*)`/g
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi
// A token with a slash or backslash that ends in a file name with an extension, or a bare file name with an extension.
const PATH = /(?:[A-Za-z]:[\\/])?(?:[\w.@~-]+[\\/])+([\w@-]+)\.[A-Za-z0-9]{1,8}\b|(?:[A-Za-z]:[\\/])?(?:[\w.@~-]+[\\/]){2,}([\w@-]+)[\\/]?/g
const FILE = /\b([\w@-]+)\.(?:tsx?|jsx?|cjs|mjs|json|ya?ml|md|java|kt|py|rs|go|cs|cpp|h|css|html|txt|log|toml|xml|sh|ps1|bat)\b/gi

export type SpeechLang = 'es' | 'en'

/** An agent reply cleaned for speech: one paragraph of sentences. */
export function cleanForSpeech(text: string, lang: SpeechLang): string {
  const code = lang === 'en' ? ' (code) ' : ' (código) '
  let s = String(text ?? '').replace(/\r\n?/g, '\n')
  s = s.replace(FENCE, code)
  s = s
    .split('\n')
    // Tables and horizontal rules are not read.
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*[-*_]{3,}\s*$/.test(line))
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''),
    )
    .join('\n')
  s = s.replace(MD_LINK, '$1')
  s = s.replace(URL_RE, (_m, host: string) => host.replace(/^www\./, ''))
  const names = (t: string): string => t.replace(PATH, (_m, file?: string, dir?: string) => file || dir || '').replace(FILE, '$1')
  // Inline code: a path inside says its file name; what is still long is not read.
  s = s.replace(INLINE_CODE, (_m, inner: string) => {
    const said = names(inner)
    return said.length <= 24 ? said : ''
  })
  s = names(s)
  s = s.replace(HASH, '')
  s = s.replace(/\*\*|__|~~/g, '').replace(/(^|\s)[*_](\S)/g, '$1$2').replace(/(\S)[*_](?=\s|$)/g, '$1')
  // Line breaks end a sentence when the line did not.
  s = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;,]$/.test(l) ? l : `${l}.`))
    .join(' ')
  return s
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.!?])\s*\.+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Sentences of a cleaned text (end marks kept). */
export function sentencesOf(text: string): string[] {
  return (String(text ?? '').match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).map((s) => s.trim()).filter(Boolean)
}

/** A cleaned reply short enough to read as it is: at most `maxChars` and two sentences. */
export function isShortReply(clean: string, maxChars: number): boolean {
  return clean.length > 0 && clean.length <= maxChars && sentencesOf(clean).length <= 2
}

/**
 * The summary when the model cannot write one: the first sentence (cut at
 * 160), "y N puntos más" for the rest, and the reply's closing question.
 */
export function localSummary(clean: string, lang: SpeechLang): string {
  const all = sentencesOf(clean)
  if (!all.length) return ''
  const first = all[0].length > 160 ? `${all[0].slice(0, 157).replace(/\s+\S*$/, '')}...` : all[0]
  const last = all[all.length - 1]
  const question = all.length > 1 && /\?$/.test(last) ? last : ''
  const rest = all.length - 1 - (question ? 1 : 0)
  const more = rest > 0 ? (lang === 'en' ? ` And ${rest} more point${rest === 1 ? '' : 's'}.` : ` Y ${rest} punto${rest === 1 ? '' : 's'} más.`) : ''
  return `${first}${more}${question ? ` ${question}` : ''}`.trim()
}

/** "A", "A y B", "A, B y C", "A, B y 3 más" (en: "and", "more"). */
export function joinNames(names: readonly string[], lang: SpeechLang, max = 3): string {
  const and = lang === 'en' ? 'and' : 'y'
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`
  const extra = names.length - (max - 1)
  return `${names.slice(0, max - 1).join(', ')} ${and} ${extra} ${lang === 'en' ? 'more' : 'más'}`
}
