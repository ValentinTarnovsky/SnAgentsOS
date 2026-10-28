/**
 * Piloto automatico (app 2.9.0): what a team whose user turned it on
 * (`TeamRuntime.autopilot`) decides without them. Pure, no Node imports;
 * TeamService.autopilotPass applies each pick through the same service
 * methods the user's clicks reach (decide, answer, integratePreview and
 * integrate, askRebase), as the user via `auto` (AUTOPILOT_ACTOR).
 *
 *  - every pending approval the user decides (plan, final OK, permission,
 *    hire) is approved; one the Lead decides stays the Lead's;
 *  - an open agent question with a recommended option (`team ask
 *    --recommended`) takes that option;
 *  - a task waiting on Integrar integrates (TeamService checks the preview
 *    first: a landing that is blocked or a merge that changes the team
 *    definition stays the user's), and one whose integrate failed on a merge
 *    conflict or on the verify goes back to its Dev (T15). While a run of the
 *    task is still active (the QA run that just gave its verdict) it waits:
 *    Integrar would answer `busy`, and that run's end is a commit that asks
 *    for another pass. An integrate that failed on something passing (the base
 *    moved, the app quit, a git timeout) is tried again, within
 *    AUTOPILOT_TRIES_MAX tries of its key.
 *
 * Nothing while the team is paused. `skip` holds the keys TeamService gave up
 * on (a decide that failed, a blocked preview, AUTOPILOT_REBASE_MAX rebases in
 * a row, AUTOPILOT_TRIES_MAX tries that left it waiting): those rows stay in Te
 * necesita and notify like any other.
 */
import type { Actor, TeamApproval, TeamCard, TeamRuntime, TeamTask } from '@shared/teams'
import type { TeamNeedRow } from '@shared/teamNeeds'

/** The user's standing OK: who an autopilot decision is recorded as. */
export const AUTOPILOT_ACTOR: Actor = { kind: 'user', via: 'auto' }

/** Rebases in a row the autopilot asks for one task before it leaves the failed integrate to the user. */
export const AUTOPILOT_REBASE_MAX = 3

/** Times the autopilot applies one key while its subject still waits (a hire whose apply failed is pending again). */
export const AUTOPILOT_TRIES_MAX = 2

export type AutopilotPick =
  | { kind: 'decide'; key: string; approvalId: string; approvalKind: 'plan' | 'final' | 'permission' | 'hire'; rev: number; taskId?: string }
  | { kind: 'answer'; key: string; cardId: string; choice: number; taskId?: string }
  | { kind: 'integrate'; key: string; taskId: string }
  | { kind: 'rebase'; key: string; taskId: string; why: 'conflict' | 'verify' }

/** A permission approval's key carries its rev: rules merged into it later make it a new decision. */
export function approvalKey(a: TeamApproval): string {
  return a.kind === 'permission' ? `${a.id}@${a.rev ?? 1}` : a.id
}

/** The key of a task's Integrar (its integrate approval). */
export function integrateKey(taskId: string): string {
  return `integrate:${taskId}`
}

/** The key of the rebase a task's failed integrate asks for. */
export function rebaseKey(taskId: string): string {
  return `rebase:${taskId}`
}

/** The task of an integrate or rebase key; undefined for an approval or card key. */
export function keyTask(key: string): string | undefined {
  const m = /^(?:integrate|rebase):(.+)$/.exec(key)
  return m ? m[1] : undefined
}

function on(rt: Readonly<TeamRuntime>): boolean {
  return rt.autopilot === true && rt.paused === null
}

/** The recommended option of an open agent question, when the autopilot answers it with that. */
function cardChoice(c: TeamCard): number | undefined {
  if (c.state !== 'open' || c.from.kind !== 'agent' || c.from.tool !== 'ask' || c.kind !== 'choice' || c.multi) return undefined
  const r = c.recommended
  return r !== undefined && Number.isInteger(r) && r >= 0 && r < c.options.length ? r : undefined
}

function integrating(t: TeamTask | undefined): t is TeamTask {
  return !!t && t.state === 'review' && t.phase === 'integrating'
}

/** A run of the task is active: Integrar would answer `busy` until it ends. */
function taskRunning(rt: Readonly<TeamRuntime>, taskId: string): boolean {
  return rt.activeRuns.some((r) => r.taskId === taskId)
}

/** The task's last integrate failed on something that passes by itself: Integrar again. */
function retryable(t: TeamTask): boolean {
  const i = t.integrate
  return !!i && i.state === 'failed' && (i.error === 'base_moved' || i.error === 'interrupted' || i.error === 'timeout')
}

/** Why a failed integrate goes back to the Dev; undefined for a failure the Dev cannot fix (the user's checkout, git itself). */
function rebaseWhy(t: TeamTask): 'conflict' | 'verify' | undefined {
  const i = t.integrate
  if (!i || i.state !== 'failed') return undefined
  if (i.error === 'merge_conflict' && i.files?.length) return 'conflict'
  if (i.error === 'verify_failed' || i.error === 'verify_timeout') return 'verify'
  return undefined
}

/** The pick of one approval; null when the autopilot leaves it. */
function approvalPick(rt: Readonly<TeamRuntime>, a: TeamApproval, skip: ReadonlySet<string>): AutopilotPick | null {
  if (a.state !== 'pending' || a.decider !== 'user') return null
  if (a.kind === 'integrate') {
    const task = rt.tasks.find((t) => t.id === a.taskId)
    if (!integrating(task)) return null
    const i = task.integrate
    if (!i || i.state === 'idle' || retryable(task)) {
      if (taskRunning(rt, task.id)) return null
      return skip.has(integrateKey(task.id)) ? null : { kind: 'integrate', key: integrateKey(task.id), taskId: task.id }
    }
    const why = rebaseWhy(task)
    return why && !skip.has(rebaseKey(task.id)) ? { kind: 'rebase', key: rebaseKey(task.id), taskId: task.id, why } : null
  }
  const key = approvalKey(a)
  if (skip.has(key)) return null
  const out: AutopilotPick = { kind: 'decide', key, approvalId: a.id, approvalKind: a.kind, rev: a.kind === 'permission' ? (a.rev ?? 1) : 1 }
  if (a.taskId) out.taskId = a.taskId
  return out
}

/** What the autopilot does now, in the order Te necesita lists it (oldest first). Empty when it is off or the team is paused. */
export function autopilotPicks(rt: Readonly<TeamRuntime>, skip: ReadonlySet<string>): AutopilotPick[] {
  if (!on(rt)) return []
  const out: Array<{ at: number; pick: AutopilotPick }> = []
  for (const a of rt.approvals) {
    const pick = approvalPick(rt, a, skip)
    if (pick) out.push({ at: a.createdAt, pick })
  }
  for (const c of rt.cards) {
    const choice = cardChoice(c)
    if (choice === undefined || skip.has(c.id)) continue
    const pick: AutopilotPick = { kind: 'answer', key: c.id, cardId: c.id, choice }
    if (c.taskId) pick.taskId = c.taskId
    out.push({ at: c.createdAt, pick })
  }
  return out.sort((x, y) => x.at - y.at).map((x) => x.pick)
}

/**
 * True when the autopilot is about to clear this Te necesita row (TeamService.noticeNeeds sends no notice for it and
 * keeps it out of the seen baseline, so a row it gives up on notifies then).
 */
export function autopilotTakes(row: Pick<TeamNeedRow, 'id' | 'kind'>, rt: Readonly<TeamRuntime>, skip: ReadonlySet<string>): boolean {
  if (!on(rt)) return false
  if (row.kind === 'approval') {
    const a = rt.approvals.find((x) => x.id === row.id)
    if (!a) return false
    // An integrate the autopilot started is still its own while it runs.
    if (a.kind === 'integrate' && a.state === 'pending') {
      const task = rt.tasks.find((t) => t.id === a.taskId)
      if (integrating(task) && task.integrate?.state === 'running' && !skip.has(integrateKey(task.id))) return true
      // One waiting on the task's own run to end is too (it integrates then).
      if (integrating(task) && (!task.integrate || task.integrate.state === 'idle' || retryable(task)) && taskRunning(rt, task.id) && !skip.has(integrateKey(task.id))) return true
    }
    return approvalPick(rt, a, skip) !== null
  }
  if (row.kind === 'card') {
    const c = rt.cards.find((x) => x.id === row.id)
    return !!c && !skip.has(c.id) && cardChoice(c) !== undefined
  }
  return false
}
