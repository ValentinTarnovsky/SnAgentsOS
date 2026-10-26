/**
 * Search ranking for filter boxes (app 2.7.0; the command palette in A6).
 * Pure, no Node or DOM imports.
 *
 * rankMatch(query, text) scores 0..4, ignoring case and accents:
 *   4 exact: the text is the query (runs of spaces count as one)
 *   3 prefix: the text, or one of its words, starts with the term
 *   2 substring: the term appears anywhere
 *   1 subsequence: the term's characters appear in order; only for terms of 4
 *     or more characters (a shorter one would match almost anything)
 *   0 no match
 * Several space-separated terms must all match, in any order; the score is the
 * lowest term's (a whole query equal to the text still scores 4). An empty
 * query matches everything with 4.
 *
 * rankList keeps the items that match, best score first; equal scores keep the
 * input order (stable).
 */

/** Shortest term that may match as a subsequence. */
export const SUBSEQUENCE_MIN = 4

/** A letter or digit of any script: the text before a "word" start is neither. */
const WORD_CHAR = /[\p{L}\p{N}]/u
const COMBINING_MARKS = /[̀-ͯ]/g

interface Term {
  text: string
  /** Long enough for the subsequence fallback. */
  loose: boolean
}

interface Query {
  whole: string
  terms: Term[]
}

/** Lower case, accents dropped, whitespace collapsed and trimmed. */
export function foldSearchText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function prepare(query: string): Query {
  const whole = foldSearchText(query)
  const terms = whole ? whole.split(' ').map((text) => ({ text, loose: Array.from(text).length >= SUBSEQUENCE_MIN })) : []
  return { whole, terms }
}

function isSubsequence(term: string, text: string): boolean {
  let i = 0
  for (let j = 0; j < text.length && i < term.length; j++) if (text[j] === term[i]) i++
  return i === term.length
}

/** 3 prefix, 2 substring, 1 subsequence, 0 none (exact is decided on the whole query). */
function termScore(term: Term, text: string): number {
  let at = text.indexOf(term.text)
  if (at < 0) return term.loose && isSubsequence(term.text, text) ? 1 : 0
  for (; at >= 0; at = text.indexOf(term.text, at + 1)) {
    if (at === 0 || !WORD_CHAR.test(text[at - 1])) return 3
  }
  return 2
}

function scoreFolded(q: Query, text: string): number {
  if (q.terms.length === 0) return 4
  if (text === q.whole) return 4
  let min = 3
  for (const term of q.terms) {
    const s = termScore(term, text)
    if (s === 0) return 0
    if (s < min) min = s
  }
  return min
}

/** How well `text` matches `query`: 4 exact, 3 prefix, 2 substring, 1 subsequence, 0 none. */
export function rankMatch(query: string, text: string): number {
  return scoreFolded(prepare(query), foldSearchText(text))
}

/**
 * The items matching `query`, best first, ties in input order. An item with
 * several texts scores its best one; empty texts are skipped. An empty query
 * returns every item in order.
 */
export function rankList<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string | readonly (string | null | undefined)[],
): T[] {
  const q = prepare(query)
  if (q.terms.length === 0) return [...items]
  const hits: { item: T; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const texts = textOf(item)
    let best = 0
    for (const t of typeof texts === 'string' ? [texts] : texts) {
      if (typeof t !== 'string' || !t) continue
      best = Math.max(best, scoreFolded(q, foldSearchText(t)))
      if (best === 4) break
    }
    if (best > 0) hits.push({ item, score: best, index })
  })
  return hits.sort((a, b) => b.score - a.score || a.index - b.index).map((h) => h.item)
}
