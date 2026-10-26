/**
 * The board of a team (app 2.7.0, E10 B3): the pure rules of the desktop
 * Tablero (and of the phone board in B8). Columns are derived from the task's
 * (state, phase), never stored; inside a column the cards go by priority band,
 * then age, then id: the order planDispatch reads candidates in, so the board
 * shows what runs next. A drop only ever proposes a user move (main marks the
 * fields it touches `userOwned`); En curso and Revisión belong to the flow
 * (plan, exec and QA runs move cards there), so a drop on them is refused.
 * Pure, type-only imports.
 */
import type { BoardColumn, TaskPhase, TaskPriority } from './teams'
import { BOARD_COLUMNS, PRIORITY_RANK, TASK_PRIORITIES, columnOf, isActiveRun, taskNumOf } from './teams'
import type { TaskSummary } from './team-protocol'
import { rankList } from './fuzzyRank'

export { columnOf }

function rankOf(p: TaskPriority): number {
  return PRIORITY_RANK[p] ?? PRIORITY_RANK.normal
}

/** priority band, then createdAt, then numeric id (the order planDispatch uses). */
export function compareTasks(a: TaskSummary, b: TaskSummary): number {
  return rankOf(a.priority) - rankOf(b.priority) || a.createdAt - b.createdAt || (taskNumOf(a.id) ?? 0) - (taskNumOf(b.id) ?? 0)
}

export interface BoardFilter { query?: string; assignee?: string | null /* '' unassigned */; showCancelled?: boolean }

/** True when a filter would hide some task (an empty query or a null assignee filters nothing). */
export function filterActive(f: BoardFilter | undefined): boolean {
  return !!f && ((f.query ?? '').trim() !== '' || (f.assignee !== undefined && f.assignee !== null))
}

/**
 * Columns in display order; query uses rankList (fuzzyRank.ts) over `id title`. The query and the assignee
 * only pick which cards show: inside a column the order stays compareTasks, so the bands keep their meaning.
 * Cancelled tasks have no column; with showCancelled they go at the end of Hecho.
 */
export function boardColumns(tasks: readonly TaskSummary[], filter?: BoardFilter): Record<BoardColumn, TaskSummary[]> {
  const out: Record<BoardColumn, TaskSummary[]> = { todo: [], doing: [], review: [], done: [], blocked: [] }
  let list: readonly TaskSummary[] = tasks
  const who = filter?.assignee
  if (who !== undefined && who !== null) list = list.filter((t) => (t.assignee ?? '') === who)
  const query = (filter?.query ?? '').trim()
  if (query) {
    const hits = new Set(rankList(list, query, (t) => `${t.id} ${t.title}`))
    list = list.filter((t) => hits.has(t))
  }
  const cancelled: TaskSummary[] = []
  for (const t of list) {
    const c = columnOf(t)
    if (c) out[c].push(t)
    else if (filter?.showCancelled && t.state === 'cancelled') cancelled.push(t)
  }
  for (const c of BOARD_COLUMNS) out[c].sort(compareTasks)
  if (cancelled.length) out.done.push(...cancelled.sort(compareTasks))
  return out
}

/** The bands present in a column, in priority order (separators are drawn only when there are 2 or more). */
export function bandsOf(column: readonly TaskSummary[]): TaskPriority[] {
  const seen = new Set(column.map((t) => t.priority))
  return TASK_PRIORITIES.filter((p) => seen.has(p))
}

export type DropRefusal = 'phaseColumn' | 'same' | 'cancelled'
export type DropVerdict =
  | { ok: true; patch: { to?: 'todo' | 'blocked' | 'done'; priority?: TaskPriority }; confirm?: 'stopsRun' | 'dropsPlan' | 'unintegrated' }
  | { ok: false; reason: DropRefusal }

/**
 * cancelled -> refused; same column: band set and different -> priority patch, else 'same'; doing or review -> 'phaseColumn'
 * (the flow owns them); to todo/blocked/done -> patch; confirm 'stopsRun' when task.run is active (decision 37),
 * 'dropsPlan' when moving to todo with phase !== none, 'unintegrated' when moving to done with a branch not integrated.
 * One confirm at most, in that order: stopping the run is the one main insists on (`running` without stopRun).
 */
export function dropVerdict(task: TaskSummary, to: BoardColumn, band?: TaskPriority): DropVerdict {
  if (task.state === 'cancelled') return { ok: false, reason: 'cancelled' }
  const priority = band && band !== task.priority ? band : undefined
  if (to === columnOf(task)) return priority ? { ok: true, patch: { priority } } : { ok: false, reason: 'same' }
  if (to === 'doing' || to === 'review') return { ok: false, reason: 'phaseColumn' }
  const patch = priority ? { to, priority } : { to }
  if (task.run && isActiveRun(task.run.state)) return { ok: true, patch, confirm: 'stopsRun' }
  if (to === 'todo' && task.phase !== 'none') return { ok: true, patch, confirm: 'dropsPlan' }
  if (to === 'done' && task.branch && !task.integrated) return { ok: true, patch, confirm: 'unintegrated' }
  return { ok: true, patch }
}

/** A phase that waits on the user (the amber chip): planApproval | userOk | integrating. */
export function phaseWaitsOnUser(p: TaskPhase): boolean {
  return p === 'planApproval' || p === 'userOk' || p === 'integrating'
}

export function phaseKey(p: TaskPhase): `teams.phase.${TaskPhase}` {
  return `teams.phase.${p}`
}

export function columnKey(c: BoardColumn): `teams.col.${BoardColumn}` {
  return `teams.col.${c}`
}

export function priorityKey(p: TaskPriority): `teams.prio.${TaskPriority}` {
  return `teams.prio.${p}`
}
