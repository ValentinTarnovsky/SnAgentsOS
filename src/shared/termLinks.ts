// Adaptado de stablyai/orca (MIT) - mobile/src/terminal/document/path-tap.ts (FILE_PATH_RE, SPACED_PATH_RE y el recorte de bordes)
/**
 * Links on one logical terminal line (E2-FR-28/29): an http(s) URL or a file
 * path under a string index. Pure text in, plain data out, so the phone's tap
 * (src/mobile/src/lib/links.ts maps cells to indices) and the desktop find the
 * same links.
 *
 * The path regexes are Orca's, copied verbatim: they accept slash paths, bare
 * names with an extension (README.md) and a `:line:col` suffix. They only
 * propose; main checks that the file exists and stays inside the root.
 */

export type TerminalLink =
  | { kind: 'url'; url: string }
  /** `raw` is what the terminal shows (with :line:col); `path` drops the suffix. */
  | { kind: 'path'; raw: string; path: string; line: number | null; column: number | null }

const URL_RE = /https?:\/\/[^\s<>"'`]+/g
const URL_TRAILING = /[.,;:!?'")\]}>]+$/

const FILE_PATH_RE =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-\/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g
const SPACED_PATH_RE =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
const PATH_LEADING_TRIM = new Set(['(', '[', '{', '"', "'"])
const PATH_TRAILING_TRIM = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

interface Range {
  text: string
  start: number
  end: number
}

function trimBoundary(raw: string, rawStart: number): Range | null {
  let start = 0
  let end = raw.length
  while (start < end && PATH_LEADING_TRIM.has(raw.charAt(start))) start++
  while (end > start && PATH_TRAILING_TRIM.has(raw.charAt(end - 1))) end--
  if (start >= end) return null
  return { text: raw.slice(start, end), start: rawStart + start, end: rawStart + end }
}

/** `src/App.tsx:12:3` -> path, line, column; null for a directory-looking or zero suffix. */
export function parsePathLineCol(value: string): { path: string; line: number | null; column: number | null } | null {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  if (!m) return null
  const path = m[1]
  const last = path.charAt(path.length - 1)
  if (!path || last === '/' || last === '\\') return null
  const line = m[2] ? Number.parseInt(m[2], 10) : null
  const column = m[3] ? Number.parseInt(m[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) return null
  return { path, line, column }
}

/** Path starts after whitespace (`a/b c/d` is two paths, not one spaced path). */
function countPathStarts(text: string): number {
  let count = 0
  const re = /(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g
  while (re.exec(text) !== null) count++
  return count
}

function hasSeparatorAfterWhitespace(text: string): boolean {
  let sawSpace = false
  for (const ch of text) {
    if (/\s/.test(ch)) sawSpace = true
    else if (sawSpace && (ch === '/' || ch === '\\')) return true
  }
  return false
}

/** A spaced path ends at its last extension token; prose after it is not swallowed. */
function trimSpacedProse(range: Range, index?: number): Range | null {
  let selected: string | null = null
  const ext = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g
  let m: RegExpExecArray | null
  while ((m = ext.exec(range.text)) !== null) {
    const end = m.index + m[0].length
    const text = range.text.slice(0, end)
    if (countPathStarts(text) > 1) continue
    if (end < range.text.length || selected === null || /[\\/]/.test(range.text.slice(selected.length, end))) selected = text
  }
  if (selected) {
    if (index !== undefined && index >= range.start + selected.length) return null
    return { text: selected, start: range.start, end: range.start + selected.length }
  }
  const text = range.text.replace(/\s+$/, '')
  return { text, start: range.start, end: range.start + text.length }
}

function hasSpacedExtension(text: string): boolean {
  const range = trimSpacedProse({ text, start: 0, end: text.length })
  if (!range) return false
  const trimmed = range.text.replace(/\s+$/, '')
  return /\s/.test(trimmed) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmed)
}

function pathLink(text: string): TerminalLink | null {
  const parsed = parsePathLineCol(text)
  return parsed ? { kind: 'path', raw: text, ...parsed } : null
}

/** The path under string index `index`, spaced paths first (as Orca does). */
export function pathAt(text: string, index: number): TerminalLink | null {
  SPACED_PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SPACED_PATH_RE.exec(text)) !== null) {
    const trimmed = trimBoundary(m[0], m.index)
    if (!trimmed || (!hasSeparatorAfterWhitespace(trimmed.text) && !hasSpacedExtension(trimmed.text))) continue
    const candidate = trimSpacedProse(trimmed, index)
    if (!candidate || index < candidate.start || index >= candidate.end) continue
    const link = pathLink(candidate.text)
    if (link) return link
  }
  FILE_PATH_RE.lastIndex = 0
  while ((m = FILE_PATH_RE.exec(text)) !== null) {
    if (m[0].length === 0) {
      FILE_PATH_RE.lastIndex++
      continue
    }
    const trimmed = trimBoundary(m[0], m.index)
    if (!trimmed || index < trimmed.start || index >= trimmed.end) continue
    const link = pathLink(trimmed.text)
    if (link) return link
  }
  return null
}

/** URL spans of a line, trailing punctuation trimmed (a closing paren only when unbalanced). */
export function urlRanges(text: string): Range[] {
  const out: Range[] = []
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0]
    for (;;) {
      const trail = URL_TRAILING.exec(url)
      if (!trail) break
      // Keep a ')' that closes a '(' inside the URL (wiki links).
      const opens = (url.match(/\(/g) ?? []).length
      const closes = (url.match(/\)/g) ?? []).length
      if (url.endsWith(')') && opens >= closes && trail[0] === ')') break
      url = url.slice(0, url.length - 1)
    }
    if (/^https?:\/\/[^/]/.test(url)) out.push({ text: url, start: m.index, end: m.index + url.length })
  }
  return out
}

/** The link under string index `index` of a logical line: a URL wins over a path inside it. */
export function linkAt(text: string, index: number): TerminalLink | null {
  const urls = urlRanges(text)
  const hit = urls.find((u) => index >= u.start && index < u.end)
  if (hit) return { kind: 'url', url: hit.text }
  const path = pathAt(text, index)
  if (!path || path.kind !== 'path') return null
  // A bare token without a separator or a known extension is too vague (1.5, e.g.).
  if (!/[\\/]/.test(path.path) && !/\.[A-Za-z][A-Za-z0-9]*$/.test(path.path)) return null
  return path
}
