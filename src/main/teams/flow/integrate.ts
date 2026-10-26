/**
 * Integrar reducers (app 2.7.0, E10 B6, design 3.7 and the T13 to T15 rows of
 * 4.2). Pure, no Node imports, copy on write. The Integrator does the git
 * (TeamService runs it); these only describe what the task records:
 *  - beginIntegrate: `integrate = {running, attempt + 1}` on a task in
 *    review/integrating with no run and no integrate in flight;
 *  - integrateStep: the step in flight (the dialog shows it on reopen), CAS on
 *    the attempt;
 *  - endIntegrate: T13 (done, `integrated`, the integrate approval approved
 *    and nothing of the task left open, the B5 closeTaskNeeds rule) or T14
 *    (`integrate.failed` with its error, step, files, tail, verify note and land
 *    mode), CAS on the attempt;
 *  - askRebase: T15, back to the Dev with a `sys` comment that names the
 *    conflicting files or the verify tail;
 *  - interruptedIntegrates: at load, a `running` integrate no process of
 *    this app runs any more is `failed {interrupted}` (a quit mid-integrate);
 *  - confirmVerify: the user confirmed a repo's verify command (its sha256).
 * The worktree base (TaskWorktree.base) follows the merge base the Integrator
 * read, so a Dev's rebase onto a newer base reads the same everywhere (the diff
 * stat, `team diff`, the drawer).
 */
import type { Actor, IntegrateError, IntegrateStep, TeamApproval, TeamRuntime, TeamTask } from '@shared/teams'
import type { VerifyNote } from '@shared/team-protocol'
import { closeTaskNeeds, appendComment } from './tasks'
import type { FlowCtx, FlowError, FlowResult, TeamEffect } from './types'

/** Files a failed integrate keeps on the task (the dialog lists them; a rebase comment names the first ones). */
export const INTEGRATE_FILES_MAX = 200
/** The verify tail a task keeps (characters; the Integrator already cut it to 8 KB). */
export const INTEGRATE_TAIL_MAX = 8 * 1024
/** Files a `rebaseConflict` comment names, then `+N`. */
export const REBASE_FILES_SHOWN = 20
/** Characters of the verify tail a `rebaseVerify` comment carries (its end: where the failure is). */
export const REBASE_TAIL_SHOWN = 2000

const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * The verify runner's own words for each note, English (B6 review): its line in the verify log is `[<words>]`, and a
 * `rebaseVerify` comment carries them when the tail does not (the tail is only what the command printed).
 */
export const VERIFY_NOTE_EN: Record<VerifyNote, string> = {
  leftStopped: 'a process the command left running still held its output: it was stopped',
  leftLetGo: 'a process the command left running still held its output: it was let go',
  timeoutKill: 'killed at the timeout',
  spawnFailed: 'the verify command could not start',
}

type Fail = Extract<FlowResult, { ok: false }>

function fail(error: FlowError, extra: Omit<Fail, 'ok' | 'error'> = {}): Fail {
  return { ok: false, error, ...extra }
}

function replaceTask(tasks: readonly TeamTask[], t: TeamTask): TeamTask[] {
  return tasks.map((x) => (x.id === t.id ? t : x))
}

/** The task waits on Integrar: review/integrating (I9: an approved final and a worktree). */
function integrating(t: TeamTask | undefined): t is TeamTask & { worktree: NonNullable<TeamTask['worktree']> } {
  return !!t && t.state === 'review' && t.phase === 'integrating' && !!t.worktree
}

/** The task's worktree with its base moved to `mergeBase` (a full sha that differs), else the task as is. */
function withBase(t: TeamTask, mergeBase: string | undefined): TeamTask {
  if (!t.worktree || !mergeBase || !FULL_SHA_RE.test(mergeBase) || t.worktree.base === mergeBase.toLowerCase()) return t
  return { ...t, worktree: { ...t.worktree, base: mergeBase.toLowerCase() } }
}

/**
 * The integrate op starts: `integrate = {running, attempt + 1, step preflight}`. A task that is not in
 * review/integrating (moved, blocked, already done) -> `conflict {stale}`; an integrate in flight or an active run of
 * the task -> `busy`.
 */
export function beginIntegrate(rt: TeamRuntime, taskId: string, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ attempt: number }> {
  const task = rt.tasks.find((t) => t.id === taskId)
  if (!task) return fail('not_found')
  if (task.integrate?.state === 'running') return fail('busy')
  if (!integrating(task)) return fail('conflict', { reason: 'stale' })
  if (rt.activeRuns.some((r) => r.taskId === taskId)) return fail('busy')
  const attempt = (task.integrate?.attempt ?? 0) + 1
  const t: TeamTask = { ...task, integrate: { state: 'running', attempt, step: 'preflight', at: ctx.now }, updatedAt: ctx.now }
  return { ok: true, rt: { ...rt, tasks: replaceTask(rt.tasks, t) }, effects: [], result: { attempt } }
}

/** The step of the integrate `attempt` in flight; anything else (another attempt, not running) changes nothing. */
export function integrateStep(rt: TeamRuntime, taskId: string, attempt: number, step: IntegrateStep, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const task = rt.tasks.find((t) => t.id === taskId)
  const cur = task?.integrate
  if (!task || !cur || cur.state !== 'running' || cur.attempt !== attempt || cur.step === step) return { ok: true, rt, effects: [], result: undefined }
  const t: TeamTask = { ...task, integrate: { ...cur, step, at: ctx.now } }
  return { ok: true, rt: { ...rt, tasks: replaceTask(rt.tasks, t) }, effects: [], result: undefined }
}

export type IntegrateOutcome =
  | { ok: true; mergeSha: string; base: string; landed: 'ffOnly' | 'updateRef' | 'alreadyMerged'; mergeBase?: string }
  | { ok: false; error: IntegrateError; step?: IntegrateStep; files?: string[]; tail?: string; verifyNote?: VerifyNote; landing?: 'ffOnly' | 'updateRef'; mergeBase?: string }

const VERIFY_NOTES: ReadonlySet<string> = new Set(Object.keys(VERIFY_NOTE_EN))

/**
 * The end of the integrate `attempt` (CAS: the task still runs exactly that attempt, else `conflict {stale}` and
 * nothing changes). T13: done/none, `integrated`, its pending integrate approval approved by `actor` (the user who
 * clicked Integrar), and nothing of the task stays open (closeTaskNeeds: other approvals, cards, queue items); the
 * worktree stays for removeWorktree. T14: `integrate = {failed, error, step, files, tail, verifyNote, landing}` in
 * review/integrating (`landing` only for a failure at step land), the integrate approval still pending (Te necesita
 * keeps the row).
 */
export function endIntegrate(rt: TeamRuntime, taskId: string, attempt: number, outcome: IntegrateOutcome, actor: Actor, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ ok: boolean }> {
  const task = rt.tasks.find((t) => t.id === taskId)
  const cur = task?.integrate
  if (!task || !cur || cur.state !== 'running' || cur.attempt !== attempt) return fail('conflict', { reason: 'stale' })
  const effects: TeamEffect[] = [{ kind: 'dispatch' }]
  if (!outcome.ok) {
    let t: TeamTask = withBase(task, outcome.mergeBase)
    const integrate: NonNullable<TeamTask['integrate']> = { state: 'failed', attempt, error: outcome.error, at: ctx.now }
    if (outcome.step) integrate.step = outcome.step
    const files = (outcome.files ?? []).filter((f) => typeof f === 'string' && f !== '').slice(0, INTEGRATE_FILES_MAX)
    if (files.length) integrate.files = files
    if (outcome.tail) integrate.tail = outcome.tail.slice(-INTEGRATE_TAIL_MAX)
    if (outcome.verifyNote && VERIFY_NOTES.has(outcome.verifyNote)) integrate.verifyNote = outcome.verifyNote
    if (outcome.step === 'land' && (outcome.landing === 'ffOnly' || outcome.landing === 'updateRef')) integrate.landing = outcome.landing
    t = { ...t, integrate, updatedAt: ctx.now }
    return { ok: true, rt: { ...rt, tasks: replaceTask(rt.tasks, t) }, effects, result: { ok: false } }
  }
  let t: TeamTask = { ...withBase(task, outcome.mergeBase), state: 'done', phase: 'none', stateSince: ctx.now, updatedAt: ctx.now }
  t.integrated = { mergeSha: outcome.mergeSha.toLowerCase(), base: outcome.base, at: ctx.now, landed: outcome.landed }
  delete t.integrate
  delete t.next
  delete t.cooldownUntil
  delete t.blocked
  let out: TeamRuntime = {
    ...rt,
    tasks: replaceTask(rt.tasks, t),
    approvals: rt.approvals.map((a) => (a.kind === 'integrate' && a.taskId === taskId && a.state === 'pending' ? ({ ...a, state: 'approved', decidedAt: ctx.now, decidedBy: actor } as TeamApproval) : a)),
  }
  out = closeTaskNeeds(out, taskId, ctx)
  return { ok: true, rt: out, effects, result: { ok: true } }
}

/** `a.txt, b/c.txt +3`: the first REBASE_FILES_SHOWN files and how many more. */
function filesVar(files: readonly string[]): string {
  const shown = files.slice(0, REBASE_FILES_SHOWN).join(', ')
  return files.length > REBASE_FILES_SHOWN ? `${shown} +${files.length - REBASE_FILES_SHOWN}` : shown
}

/**
 * T15 (the dialog's "Pedir al Dev que haga rebase"): a task in review/integrating whose last integrate failed on a
 * merge conflict (`why: conflict`, with its files) or on the verify command (`why: verify`, failed or timed out, with
 * its tail) goes back to doing/executing with a system comment for its assignee (`sys rebaseConflict {files}` or
 * `rebaseVerify {tail}`, the tail followed by `[<VERIFY_NOTE_EN>]` of a stored verifyNote it does not already name)
 * and a `rebase` wake of its exec; the integrate approval is cancelled (the next final OK opens
 * a new one) and the failed integrate leaves the task. Its next `team review` goes to QA without a round++ (only a
 * QA verdict counts rounds). An integrate in flight -> `busy`; any other state or failure -> `conflict {stale}`.
 */
export function askRebase(rt: TeamRuntime, taskId: string, why: 'conflict' | 'verify', _actor: Actor, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const task = rt.tasks.find((t) => t.id === taskId)
  if (!task) return fail('not_found')
  if (task.integrate?.state === 'running') return fail('busy')
  if (!integrating(task) || task.integrate?.state !== 'failed') return fail('conflict', { reason: 'stale' })
  const err = task.integrate.error
  let vars: Record<string, string>
  if (why === 'conflict') {
    if (err !== 'merge_conflict' || !task.integrate.files?.length) return fail('conflict', { reason: 'stale' })
    vars = { files: filesVar(task.integrate.files) }
  } else {
    if (err !== 'verify_failed' && err !== 'verify_timeout') return fail('conflict', { reason: 'stale' })
    const tail = (task.integrate.tail ?? '').trim()
    let shown = tail.length > REBASE_TAIL_SHOWN ? `...${tail.slice(-REBASE_TAIL_SHOWN)}` : tail
    // The runner's own words go after it (B6 review, second round): a command that could not start printed nothing.
    const note = task.integrate.verifyNote
    const words = note && VERIFY_NOTES.has(note) ? VERIFY_NOTE_EN[note] : undefined
    if (words && !shown.includes(words)) shown = shown ? `${shown}\n[${words}]` : `[${words}]`
    vars = { tail: shown }
  }
  const t: TeamTask = { ...task, state: 'doing', phase: 'executing', stateSince: ctx.now, updatedAt: ctx.now }
  delete t.integrate
  delete t.cooldownUntil
  if (task.assignee) t.next = { agentId: task.assignee, mode: 'exec', reason: 'rebase', since: ctx.now, bypassCooldown: true }
  else delete t.next
  let out: TeamRuntime = {
    ...rt,
    tasks: replaceTask(rt.tasks, t),
    approvals: rt.approvals.map((a) => (a.kind === 'integrate' && a.taskId === taskId && a.state === 'pending' ? ({ ...a, state: 'cancelled', decidedAt: ctx.now } as TeamApproval) : a)),
  }
  const effects: TeamEffect[] = [{ kind: 'dispatch' }]
  const c = appendComment(out, { author: { kind: 'system' }, target: taskId, kind: 'system', text: '', sys: { key: why === 'conflict' ? 'rebaseConflict' : 'rebaseVerify', vars }, forAgent: task.assignee }, ctx)
  if (!c.ok) return c
  out = c.rt
  effects.push(...c.effects)
  return { ok: true, rt: out, effects, result: undefined }
}

/**
 * At load (design 3.7): every task whose integrate is `running` and is not in flight in this app (`inFlight`: a Labs
 * toggle reloads the store while an integrate still runs) is `failed {interrupted}`: the app quit in the middle. The
 * temp tree it left is swept at enable. Unchanged runtime when there is none.
 */
export function interruptedIntegrates(rt: TeamRuntime, inFlight: (taskId: string) => boolean, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ taskIds: string[] }> {
  const taskIds = rt.tasks.filter((t) => t.integrate?.state === 'running' && !inFlight(t.id)).map((t) => t.id)
  if (taskIds.length === 0) return { ok: true, rt, effects: [], result: { taskIds } }
  const ids = new Set(taskIds)
  const tasks = rt.tasks.map((t) => (ids.has(t.id) && t.integrate ? { ...t, integrate: { ...t.integrate, state: 'failed' as const, error: 'interrupted' as const, at: ctx.now }, updatedAt: ctx.now } : t))
  return { ok: true, rt: { ...rt, tasks }, effects: [], result: { taskIds } }
}

/** The user confirmed the verify command of `repoId` (the op checked it is the trusted definition's): its sha256 as given. */
export function confirmVerify(rt: TeamRuntime, repoId: string, command: string, sha256: string, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const cur = rt.verifyConfirmed[repoId]
  if (cur && cur.command === command && cur.sha256 === sha256) return { ok: true, rt, effects: [], result: undefined }
  return { ok: true, rt: { ...rt, verifyConfirmed: { ...rt.verifyConfirmed, [repoId]: { command, sha256, at: ctx.now } } }, effects: [], result: undefined }
}

/**
 * removeWorktree landed: the task forgets its worktree (CAS on the path the remove got). A done or cancelled task
 * only; its runs are over, so no session reads that folder again (I20 applies only with a worktree).
 */
export function worktreeRemoved(rt: TeamRuntime, taskId: string, path: string, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const task = rt.tasks.find((t) => t.id === taskId)
  if (!task || task.worktree?.path !== path) return fail('conflict', { reason: 'stale' })
  const t: TeamTask = { ...task, updatedAt: ctx.now }
  delete t.worktree
  return { ok: true, rt: { ...rt, tasks: replaceTask(rt.tasks, t) }, effects: [], result: undefined }
}
