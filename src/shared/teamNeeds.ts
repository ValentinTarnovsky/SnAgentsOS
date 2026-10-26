/**
 * "Te necesita" (app 2.7.0, Tanda B, decision 30): the ONE rule of what in a
 * team waits on the user. The sidebar badge, the tab pill, the rows, the
 * phone card and screen and the push all read it from here, so every surface
 * counts the same. Pure, no Node or DOM.
 */
import type { ApprovalKind } from './teams'
import { PRIORITY_RANK } from './teams'
import type { TeamNeedsView } from './team-protocol'

export type TeamNeedKind = 'trust' | 'paused' | 'approval' | 'card' | 'dispatch'
export interface TeamNeedRow {
  id: string                                       // 'trust' | 'paused' | approval id | card id | queue id
  kind: TeamNeedKind
  rank: 1 | 2 | 3                                  // 1 blocks the team, 2 a decision, 3 a run waiting for OK
  at: number; taskId?: string; approvalKind?: ApprovalKind
  push: boolean                                    // rank 1 and 2: main pushes it to the phone when new
}
export type TeamNeedsInput = Pick<TeamNeedsView, 'trust' | 'trustSince' | 'paused' | 'approvals' | 'cards' | 'queue'>

/** A row with its tie-break after `at`: PRIORITY_RANK for queue rows, 0 for the rest. */
interface Ranked { row: TeamNeedRow; prio: number }

function cmp(a: Ranked, b: Ranked): number {
  return a.row.rank - b.row.rank || a.row.at - b.row.at || a.prio - b.prio || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
}

/**
 * The ONE "Te necesita" rule (decision 30, B5 acceptance):
 * trust !== 'trusted' -> {id:'trust', rank 1}; paused with reason auth|billing -> {id:'paused', rank 1} (a user pause
 * never counts); approval state pending|applying and decider 'user' -> rank 2; card state 'open' -> rank 2; queue item
 * with !approved -> rank 3. Order: rank, at ascending, then queue rows by PRIORITY_RANK, then id.
 */
export function teamNeedsRows(input: TeamNeedsInput): TeamNeedRow[] {
  const out: Ranked[] = []
  const add = (row: TeamNeedRow, prio = 0): void => {
    out.push({ row, prio })
  }
  if (input.trust !== 'trusted') add({ id: 'trust', kind: 'trust', rank: 1, at: input.trustSince ?? 0, push: true })
  const paused = input.paused
  if (paused && (paused.reason === 'auth' || paused.reason === 'billing')) add({ id: 'paused', kind: 'paused', rank: 1, at: paused.at, push: true })
  for (const a of input.approvals) {
    if ((a.state !== 'pending' && a.state !== 'applying') || a.decider !== 'user') continue
    const row: TeamNeedRow = { id: a.id, kind: 'approval', rank: 2, at: a.at, approvalKind: a.payload.kind, push: true }
    if (a.taskId !== undefined) row.taskId = a.taskId
    add(row)
  }
  for (const c of input.cards) {
    if (c.state !== 'open') continue
    const row: TeamNeedRow = { id: c.id, kind: 'card', rank: 2, at: c.at, push: true }
    if (c.taskId !== undefined) row.taskId = c.taskId
    add(row)
  }
  for (const q of input.queue) {
    if (q.approved) continue
    const row: TeamNeedRow = { id: q.id, kind: 'dispatch', rank: 3, at: q.at, push: false }
    if (q.taskId !== undefined) row.taskId = q.taskId
    add(row, PRIORITY_RANK[q.priority] ?? PRIORITY_RANK.normal)
  }
  return out.sort(cmp).map((r) => r.row)
}

export function teamNeedsCount(input: TeamNeedsInput): number {
  return teamNeedsRows(input).length
}

export function needsOfTask(rows: readonly TeamNeedRow[], taskId: string): TeamNeedRow[] {
  return rows.filter((r) => r.taskId === taskId)
}

/** i18n key suffix: 'trust' | 'paused' | 'approval.<kind>' | 'card' | 'dispatch'. */
export function teamNeedKey(row: TeamNeedRow): `teams.need.${string}` {
  return row.kind === 'approval' ? `teams.need.approval.${row.approvalKind ?? 'plan'}` : `teams.need.${row.kind}`
}
