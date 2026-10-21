/**
 * The find widget's logic (v2.3), kept free of React and the DOM so the
 * esbuild + vm suite can run it: the key map of the widget, the "3 of 12"
 * counter and the capped match count.
 */

/** Past this many matches the counter shows "9999+" (a huge file stays responsive). */
export const FIND_COUNT_CAP = 9999

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

/** `index` is 0-based, -1 when the selection is on no match. */
export interface FindResult {
  index: number
  total: number
  capped: boolean
}

export type FindAction =
  | 'next'
  | 'prev'
  | 'close'
  | 'toggleCase'
  | 'toggleWord'
  | 'toggleRegex'
  | 'openReplace'
  | 'replace'
  | 'replaceAll'
  | 'focusFind'

/** Where the key landed: the find field, the replace field or a button of the widget. */
export type FindField = 'find' | 'replace' | 'other'

export interface FindKey {
  key: string
  code?: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** The letter of a key, from `code` when Alt changed `key` (a layout that composes on Alt). */
function letter(e: FindKey): string {
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  return e.key.length === 1 ? e.key.toLowerCase() : ''
}

/**
 * VS Code's keys while the widget has the focus: Enter / F3 next, Shift+Enter /
 * Shift+F3 previous, Esc closes, Alt+C / Alt+W / Alt+R toggle the options,
 * Ctrl+H opens the replace row (its field takes the focus), Ctrl+F goes back to
 * the query alone, Enter in the replace field replaces one and Ctrl+Alt+Enter
 * replaces all. On a button Enter stays the button's.
 */
export function findKeyAction(e: FindKey, field: FindField): FindAction | null {
  const mod = e.ctrlKey || e.metaKey
  if (e.key === 'Escape' && !mod && !e.altKey && !e.shiftKey) return 'close'
  if (e.key === 'F3' && !mod && !e.altKey) return e.shiftKey ? 'prev' : 'next'
  if (e.key === 'Enter') {
    if (mod && e.altKey && field !== 'other') return 'replaceAll'
    if (mod || e.altKey) return null
    if (field === 'find') return e.shiftKey ? 'prev' : 'next'
    if (field === 'replace' && !e.shiftKey) return 'replace'
    return null
  }
  const l = letter(e)
  if (e.altKey && !mod && !e.shiftKey) {
    if (l === 'c') return 'toggleCase'
    if (l === 'w') return 'toggleWord'
    if (l === 'r') return 'toggleRegex'
  }
  if (mod && !e.altKey && !e.shiftKey) {
    if (l === 'h') return 'openReplace'
    if (l === 'f') return 'focusFind'
  }
  return null
}

export type FindLabelKey = 'find.count' | 'find.countCapped' | 'find.none' | 'find.invalidRegex'

/** The counter: '' with nothing to find, "3 of 12", "1 of 9999+", "No results" or the invalid-regex text. */
export function resultLabel(
  query: string,
  result: FindResult | null,
  invalid: boolean,
  t: (key: FindLabelKey, vars?: Record<string, string | number>) => string,
): string {
  if (!query) return ''
  if (invalid) return t('find.invalidRegex')
  if (!result || result.total === 0) return t('find.none')
  const index = result.index >= 0 ? result.index + 1 : '?'
  return t(result.capped ? 'find.countCapped' : 'find.count', { index, total: result.total })
}

export interface MatchRange {
  from: number
  to: number
}

/** The matches of a search cursor, at most `cap` (then `capped`). */
export function collectMatches(cursor: Iterator<MatchRange>, cap = FIND_COUNT_CAP): { ranges: MatchRange[]; capped: boolean } {
  const ranges: MatchRange[] = []
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    if (ranges.length >= cap) return { ranges, capped: true }
    ranges.push({ from: r.value.from, to: r.value.to })
  }
  return { ranges, capped: false }
}

/** Which match the selection is exactly on (ranges sorted by `from`), or -1. */
export function currentIndex(ranges: readonly MatchRange[], sel: MatchRange): number {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (r.from < sel.from) lo = mid + 1
    else if (r.from > sel.from) hi = mid - 1
    else return r.to === sel.to ? mid : -1
  }
  return -1
}

/** The counter's numbers for a search cursor and the editor selection. */
export function countMatches(cursor: Iterator<MatchRange>, sel: MatchRange, cap = FIND_COUNT_CAP): FindResult {
  const { ranges, capped } = collectMatches(cursor, cap)
  return { index: currentIndex(ranges, sel), total: ranges.length, capped }
}
