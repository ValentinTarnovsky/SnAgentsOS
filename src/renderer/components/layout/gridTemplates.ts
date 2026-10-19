import type { GridPreset } from '@shared/types'

/** Selectable terminal-count presets, in display order. */
export const GRID_PRESETS: GridPreset[] = [1, 2, 4, 6, 8, 10, 12]

/** Column count per preset; rows flow automatically to fit the panes. */
export const GRID_COLS: Record<GridPreset, number> = {
  1: 1,
  2: 2,
  4: 2,
  6: 3,
  8: 4,
  10: 5,
  12: 4,
}

/** Smallest preset that fits `n` panes (caps at 12). */
export function gridForCount(n: number): GridPreset {
  for (const p of GRID_PRESETS) if (p >= n) return p
  return 12
}

/**
 * Visible slot under a point of the grid (pane drag reorder), from the grid's
 * own geometry rather than the cells' animated boxes, so a cell flying by
 * never retargets the drag. A point near a cell's edges (`inset`, a fraction
 * of the cell) or in a gap returns null: the caller keeps its current target,
 * which is what stops the flicker at the junction of two cells.
 */
export function gridSlotAt(
  x: number,
  y: number,
  box: { width: number; height: number },
  cols: number,
  count: number,
  gap: number,
  inset = 0.2,
): number | null {
  if (count <= 0 || cols <= 0) return null
  const rows = Math.ceil(count / cols)
  const cellW = (box.width - gap * (cols - 1)) / cols
  const cellH = (box.height - gap * (rows - 1)) / rows
  if (cellW <= 0 || cellH <= 0 || x < 0 || y < 0) return null
  const col = Math.floor(x / (cellW + gap))
  const row = Math.floor(y / (cellH + gap))
  if (col >= cols || row >= rows) return null
  const lx = x - col * (cellW + gap)
  const ly = y - row * (cellH + gap)
  if (lx < cellW * inset || lx > cellW * (1 - inset) || ly < cellH * inset || ly > cellH * (1 - inset)) return null
  const slot = row * cols + col
  return slot < count ? slot : null
}

/** Order panes by the saved order array; unknown panes are appended. */
export function orderPanes<T extends { id: string }>(panes: T[], order?: string[]): T[] {
  if (!order || order.length === 0) return panes
  const index = new Map(order.map((id, i) => [id, i]))
  return [...panes].sort((a, b) => {
    const ai = index.has(a.id) ? (index.get(a.id) as number) : Number.MAX_SAFE_INTEGER
    const bi = index.has(b.id) ? (index.get(b.id) as number) : Number.MAX_SAFE_INTEGER
    return ai - bi
  })
}
