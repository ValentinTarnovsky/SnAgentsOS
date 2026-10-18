// Adaptado de stablyai/orca (MIT) - mobile/src/terminal/document/path-tap.ts (FILE_PATH_RE, SPACED_PATH_RE y el recorte de bordes)
/**
 * What a tap on the phone terminal landed on (E2-FR-28/29): an http(s) URL or
 * a file path, found on the logical line under the finger (rows joined while
 * xterm marks them `isWrapped`, so a URL that wraps is one link).
 *
 * The path regexes are Orca's, copied verbatim: they accept slash paths, bare
 * names with an extension (README.md) and a `:line:col` suffix. They only
 * propose; main checks that the file exists and stays inside the root.
 */
import type { Terminal } from '@xterm/xterm'
import { isInertOpenPath } from '@shared/inertOpen'

export { INERT_OPEN_EXTENSIONS, isInertOpenPath } from '@shared/inertOpen'

export type TerminalLink =
  | { kind: 'url'; url: string }
  /** `raw` is what the terminal shows (with :line:col); `path` drops the suffix. */
  | { kind: 'path'; raw: string; path: string; line: number | null; column: number | null }

/** One logical line: its text and, per string index, the buffer cell it came from. */
export interface LogicalLine {
  text: string
  cells: Array<{ row: number; col: number }>
}

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

/** Localhost URLs are hidden from "Open on the phone": they point at the phone itself. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
  } catch {
    return false
  }
}

/** Label of the PC action for a path: open an inert file, reveal anything else. */
export function pcActionFor(path: string): 'open' | 'reveal' {
  return isInertOpenPath(path) ? 'open' : 'reveal'
}

/**
 * The logical line containing buffer row `row`: walks up while the row is a
 * wrap continuation, then down while the next one is. Wide characters take
 * one string index (their spacer cell is skipped); empty cells read as space.
 */
export function logicalLineAt(term: Terminal, row: number): LogicalLine | null {
  const buf = term.buffer.active
  if (!buf.getLine(row)) return null
  let first = row
  while (first > 0 && buf.getLine(first)?.isWrapped) first--
  const text: string[] = []
  const cells: LogicalLine['cells'] = []
  const cell = buf.getNullCell()
  for (let r = first; r < buf.length; r++) {
    const line = buf.getLine(r)
    if (!line || (r > first && !line.isWrapped)) break
    for (let c = 0; c < term.cols; c++) {
      if (!line.getCell(c, cell)) break
      if (cell.getWidth() === 0) continue
      const ch = cell.getChars() || ' '
      // UTF-16 units, so string indices line up with cells (an emoji is two).
      for (let k = 0; k < ch.length; k++) {
        text.push(ch[k])
        cells.push({ row: r, col: c })
      }
    }
  }
  return { text: text.join(''), cells }
}

/** String index of cell (col,row) in a logical line, or -1. */
export function indexOfCell(line: LogicalLine, col: number, row: number): number {
  let best = -1
  for (let i = 0; i < line.cells.length; i++) {
    const c = line.cells[i]
    if (c.row === row && c.col <= col) best = i
    if (c.row > row) break
  }
  return best
}

/** The link under buffer cell (col,row), or null. */
export function linkAtCell(term: Terminal, col: number, row: number): TerminalLink | null {
  const line = logicalLineAt(term, row)
  if (!line) return null
  const index = indexOfCell(line, col, row)
  if (index < 0) return null
  return linkAt(line.text, index)
}
