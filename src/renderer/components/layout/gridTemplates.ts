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
