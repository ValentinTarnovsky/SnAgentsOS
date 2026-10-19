/**
 * Agents board model (E5-FR-27): which column each agent console goes to and
 * how the arrow keys move between cards. Pure, over the navigation entries of
 * agentNav, so the rules are unit tested.
 */
import { compareAgents } from '@shared/agents'
import type { AgentEntry } from './agentNav'

export type BoardColumnId = 'waiting' | 'working' | 'done' | 'idle'

/** Screen order: waiting on you, working, done, idle (collapsed by default). */
export const BOARD_COLUMNS: readonly BoardColumnId[] = ['waiting', 'working', 'done', 'idle']

/** Rank (agentRank) -> column: 1 action/error, 2 done, 3 working, 4 idle/unknown/sleeping/not started. */
const COLUMN_OF_RANK: Record<1 | 2 | 3 | 4, BoardColumnId> = { 1: 'waiting', 2: 'done', 3: 'working', 4: 'idle' }

/** Entries split into the four columns, each in urgency order (compareAgents). */
export function boardColumns(entries: readonly AgentEntry[]): Record<BoardColumnId, AgentEntry[]> {
  const cols: Record<BoardColumnId, AgentEntry[]> = { waiting: [], working: [], done: [], idle: [] }
  for (const e of entries) cols[COLUMN_OF_RANK[e.rank]].push(e)
  for (const id of BOARD_COLUMNS) cols[id].sort(compareAgents)
  return cols
}

/** Card ids per column as the keyboard sees them: the idle column only while expanded. */
export function navigableColumns(cols: Record<BoardColumnId, AgentEntry[]>, idleOpen: boolean): string[][] {
  return BOARD_COLUMNS.map((id) => (id === 'idle' && !idleOpen ? [] : cols[id].map((e) => e.id)))
}

/** First card of the first column that has one, or null. */
export function firstCard(columns: readonly string[][]): string | null {
  for (const col of columns) if (col.length > 0) return col[0]
  return null
}

/**
 * The card an arrow key moves to. Up/Down walk the column (clamped), Left/
 * Right jump to the nearest column with cards on that side, keeping the row
 * as close as it can. Unknown or missing selection starts at the first card.
 */
export function moveSelection(columns: readonly string[][], selected: string | null, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): string | null {
  let col = -1
  let row = -1
  if (selected) {
    for (let c = 0; c < columns.length && col < 0; c++) {
      const r = columns[c].indexOf(selected)
      if (r >= 0) {
        col = c
        row = r
      }
    }
  }
  if (col < 0) return firstCard(columns)
  if (key === 'ArrowUp') return columns[col][Math.max(0, row - 1)]
  if (key === 'ArrowDown') return columns[col][Math.min(columns[col].length - 1, row + 1)]
  const step = key === 'ArrowLeft' ? -1 : 1
  for (let c = col + step; c >= 0 && c < columns.length; c += step) {
    if (columns[c].length > 0) return columns[c][Math.min(row, columns[c].length - 1)]
  }
  return selected
}
