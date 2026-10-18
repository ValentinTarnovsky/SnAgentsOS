/**
 * Text selection on the phone terminal (E2-FR-26/27): geometry between screen
 * pixels and buffer cells, word bounds and the placement of the
 * "Copy | All | Cancel" pill. Cells are absolute buffer coordinates (row 0 is
 * the oldest scrollback line), the same space term.select() uses, so a
 * selection survives scrolling.
 *
 * The pixel math reads the live `.xterm-screen` rect and term.cols/rows, so it
 * follows the fit solver's font size and the pinch scale without extra state.
 */
import type { Terminal } from '@xterm/xterm'

export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP = 10
/** A tap is shorter than TAP_MAX_MS and moves less than TAP_SLOP px (E2-FR-28). */
export const TAP_SLOP = 24
export const TAP_MAX_MS = 300
/** Auto-scroll while a handle is held this close to the top or bottom edge. */
export const EDGE_SCROLL_PX = 40
export const EDGE_SCROLL_MS = 60
/** Touch target of each handle (the visible knob is smaller). */
export const HANDLE_HIT_PX = 44
/** The pill keeps this distance from the selection and from the edges. */
export const PILL_MARGIN = 8

export interface Cell {
  col: number
  /** Absolute buffer row. */
  row: number
}

export interface ScreenGeom {
  left: number
  top: number
  width: number
  height: number
  cols: number
  rows: number
  /** buffer.active.viewportY: absolute row shown at the top. */
  viewportY: number
  /** Last absolute row (buffer length - 1). */
  lastRow: number
}

export function screenGeom(term: Terminal): ScreenGeom | null {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return null
  const r = screen.getBoundingClientRect()
  if (!r.width || !r.height) return null
  const buf = term.buffer.active
  return {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    cols: Math.max(1, term.cols),
    rows: Math.max(1, term.rows),
    viewportY: buf.viewportY,
    lastRow: Math.max(0, buf.length - 1),
  }
}

export function cellSize(g: ScreenGeom): { w: number; h: number } {
  return { w: g.width / g.cols, h: g.height / g.rows }
}

/** Client point -> buffer cell, clamped to the visible grid. */
export function pointToCell(g: ScreenGeom, clientX: number, clientY: number): Cell {
  const { w, h } = cellSize(g)
  const col = Math.min(g.cols - 1, Math.max(0, Math.floor((clientX - g.left) / w)))
  const vrow = Math.min(g.rows - 1, Math.max(0, Math.floor((clientY - g.top) / h)))
  return { col, row: Math.min(g.lastRow, g.viewportY + vrow) }
}

/** Top-left of a cell in client px, or null when its row is scrolled out of view. */
export function cellToPoint(g: ScreenGeom, cell: Cell): { x: number; y: number } | null {
  const vrow = cell.row - g.viewportY
  if (vrow < 0 || vrow >= g.rows) return null
  const { w, h } = cellSize(g)
  return { x: g.left + cell.col * w, y: g.top + vrow * h }
}

export function compareCells(a: Cell, b: Cell): number {
  return a.row - b.row || a.col - b.col
}

/** Ordered [start, end], both inclusive. */
export function orderCells(a: Cell, b: Cell): [Cell, Cell] {
  return compareCells(a, b) <= 0 ? [a, b] : [b, a]
}

/** term.select() length for an inclusive range. */
export function selectionLength(cols: number, start: Cell, end: Cell): number {
  return (end.row - start.row) * cols + (end.col - start.col) + 1
}

/** Characters that end a word: whitespace and the usual terminal punctuation. */
const WORD_BREAK = /[\s()[\]{}<>'"`|,;]/

/**
 * Word bounds around `col` on one row, given the char of each cell ('' for the
 * spacer half of a wide char). A break char under the finger selects just it.
 */
export function wordBounds(cells: string[], col: number): { start: number; end: number } {
  const isBreak = (c: string | undefined): boolean => c === undefined || c === '' ? false : WORD_BREAK.test(c)
  const at = cells[col] ?? ' '
  if (at === ' ' || isBreak(at)) return { start: col, end: col }
  let start = col
  while (start > 0 && (cells[start - 1] ?? ' ') !== ' ' && !isBreak(cells[start - 1])) start--
  let end = col
  while (end < cells.length - 1 && (cells[end + 1] ?? ' ') !== ' ' && !isBreak(cells[end + 1])) end++
  return { start, end }
}

/** Chars of a buffer row, one entry per cell. */
export function rowCells(term: Terminal, row: number): string[] {
  const line = term.buffer.active.getLine(row)
  const out: string[] = []
  if (!line) return out
  const cell = term.buffer.active.getNullCell()
  for (let c = 0; c < term.cols; c++) {
    if (!line.getCell(c, cell)) break
    out.push(cell.getWidth() === 0 ? '' : cell.getChars() || ' ')
  }
  return out
}

/** Select the word under `cell` and return its range. */
export function selectWordAt(term: Terminal, cell: Cell): [Cell, Cell] {
  const { start, end } = wordBounds(rowCells(term, cell.row), cell.col)
  const range: [Cell, Cell] = [{ col: start, row: cell.row }, { col: end, row: cell.row }]
  applySelection(term, range[0], range[1])
  return range
}

export function applySelection(term: Terminal, a: Cell, b: Cell): void {
  const [start, end] = orderCells(a, b)
  term.select(start.col, start.row, selectionLength(term.cols, start, end))
}

/** -1 near the top edge, 1 near the bottom one, 0 elsewhere. */
export function edgeScrollDir(clientY: number, top: number, bottom: number, edge = EDGE_SCROLL_PX): -1 | 0 | 1 {
  if (clientY < top + edge) return -1
  if (clientY > bottom - edge) return 1
  return 0
}

/**
 * Pill placement relative to its container: above the selection, below it
 * when it does not fit, always PILL_MARGIN away from every edge.
 */
export function pillPosition(p: {
  selTop: number
  selBottom: number
  anchorX: number
  pillW: number
  pillH: number
  boxW: number
  boxH: number
}): { left: number; top: number; placement: 'above' | 'below' } {
  const m = PILL_MARGIN
  let placement: 'above' | 'below' = 'above'
  let top = p.selTop - p.pillH - m
  if (top < m) {
    placement = 'below'
    top = p.selBottom + m
  }
  top = Math.max(m, Math.min(top, p.boxH - p.pillH - m))
  const left = Math.max(m, Math.min(p.anchorX - p.pillW / 2, p.boxW - p.pillW - m))
  return { left, top, placement }
}
