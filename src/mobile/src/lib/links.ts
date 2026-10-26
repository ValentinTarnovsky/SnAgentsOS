/**
 * What a tap on the phone terminal landed on (E2-FR-28/29): an http(s) URL or
 * a file path, found on the logical line under the finger (rows joined while
 * xterm marks them `isWrapped`, so a URL that wraps is one link).
 *
 * The link finding itself is pure and lives in `@shared/termLinks` (re-exported
 * here); this file maps buffer cells to string indices and picks the PC action.
 */
import type { Terminal } from '@xterm/xterm'
import { isInertOpenPath } from '@shared/inertOpen'
import { linkAt, type TerminalLink } from '@shared/termLinks'

export { INERT_OPEN_EXTENSIONS, isInertOpenPath } from '@shared/inertOpen'
export { linkAt, parsePathLineCol, pathAt, urlRanges, type TerminalLink } from '@shared/termLinks'

/** One logical line: its text and, per string index, the buffer cell it came from. */
export interface LogicalLine {
  text: string
  cells: Array<{ row: number; col: number }>
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
