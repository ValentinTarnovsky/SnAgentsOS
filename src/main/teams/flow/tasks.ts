/**
 * Task and comment reducers (app 2.7.0, E10 B3, design 3.4, the task machine
 * of 4.2 and the comment delivery of 4.5). Pure, no Node imports, copy on
 * write: every user and agent edit of the board lands here.
 *
 * The user always wins (store rules 3 and 4): a user edit carries the task's
 * `rev` (`baseRev`) and a mismatch changes nothing; every field the user sets
 * joins `userOwned`, and an agent update that would change one of them is
 * refused whole (`user_owned`). Tasks are never deleted, only cancelled; old
 * done and cancelled ones move to the archive (decision 27).
 */
import type { TaskDraft, TaskPatch, TeamScope } from '@shared/team-protocol'
import {
  BLOCKED_BY_MAX,
  COMMENT_TEXT_MAX,
  LEAD_THREAD,
  REPO_ID_RE,
  REPO_MAIN,
  TASK_ARCHIVE_AFTER_MS,
  TASK_BODY_MAX,
  TASK_COMMENTS_MAX,
  TASK_FIELDS,
  TASK_ID_RE,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  TEAM_TASKS_MAX,
  QA_ROUNDS_MAX,
  taskIdOf,
  type Actor,
  type BlockedReason,
  type CommentKind,
  type Isolation,
  type RunMode,
  type SysText,
  type TaskField,
  type TaskPriority,
  type TaskState,
  type TeamComment,
  type TeamRuntime,
  type TeamTask,
  type WakeMark,
} from '@shared/teams'
import { openSystemCard } from './agents'
import { requestStop } from './runs'
import type { FlowCtx, FlowError, FlowResult, TeamEffect } from './types'

/** Highest id numbers the id regexes allow (TASK_ID_RE 5 digits, COMMENT_ID_RE 7). */
const TASK_NUM_MAX = 99_999
const COMMENT_NUM_MAX = 9_999_999

/** C0, DEL, C1 and the Unicode line/paragraph separators: never inside a title (like the request schema). */
const LINE_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/** C0 except tab and newline, and DEL: never inside a body or a comment (CR is normalized first). */
const BODY_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/

type Fail = Extract<FlowResult, { ok: false }>

function fail(error: FlowError, extra: Omit<Fail, 'ok' | 'error'> = {}): Fail {
  return { ok: false, error, ...extra }
}

function replaceTask(tasks: readonly TeamTask[], t: TeamTask): TeamTask[] {
  return tasks.map((x) => (x.id === t.id ? t : x))
}

/** A trimmed one-line title within the cap, or null. */
function cleanTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s !== '' && s.length <= TASK_TITLE_MAX && !LINE_BAD_RE.test(s) ? s : null
}

/** A body or comment text: CRLF and CR to LF, within `max`, no control character but tab and newline; or null. */
function cleanText(v: unknown, max: number, o: { empty: boolean }): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\r\n?/g, '\n')
  if (s.length > max || BODY_BAD_RE.test(s)) return null
  if (!o.empty && s.trim() === '') return null
  return s
}

function isPriority(v: unknown): v is TaskPriority {
  return typeof v === 'string' && (TASK_PRIORITIES as readonly string[]).includes(v)
}

function isIsolation(v: unknown): v is Isolation {
  return v === 'worktree' || v === 'main'
}

/** A repo id the trusted definition names (`main` or one of its extra repos). */
function validRepo(ctx: Pick<FlowCtx, 'def'>, repoId: unknown): repoId is string {
  return typeof repoId === 'string' && REPO_ID_RE.test(repoId) && (repoId === REPO_MAIN || ctx.def.def.extraRepos.some((r) => r.id === repoId))
}

/** An assignee: an existing, non-retired agent that is not the Lead (T1). */
function assigneeError(rt: TeamRuntime, agentId: string): FlowError | null {
  const a = rt.agents.find((x) => x.id === agentId)
  if (!a) return 'not_found'
  return a.roleKind === 'lead' || a.retired ? 'bad_request' : null
}

/** The state of a blocker: live, else the archive (decision 27), else unknown. */
function blockerState(rt: TeamRuntime, id: string): TaskState | undefined {
  return rt.tasks.find((t) => t.id === id)?.state ?? rt.archivedTasks[id]
}

/** Every blocker done -> ready; any cancelled -> cancelled (a cancelled blocker never satisfies); else waiting. */
export function depsOf(rt: TeamRuntime, blockedBy: readonly string[]): 'ready' | 'waiting' | 'cancelled' {
  let waiting = false
  for (const b of blockedBy) {
    const s = blockerState(rt, b)
    if (s === 'cancelled') return 'cancelled'
    if (s !== 'done') waiting = true
  }
  return waiting ? 'waiting' : 'ready'
}

/**
 * The loop `taskId` blocked by `blockedBy` closes over the live `blockedBy`
 * edges (the task's own edges replaced by the new list), as the path from the
 * task back to itself (`['t-1', 't-3', 't-2', 't-1']`: t-1 waits on t-3,
 * which waits on t-2, which waits on t-1); a shortest one (breadth first).
 * Null when there is none.
 */
export function blockersCycle(tasks: readonly TeamTask[], taskId: string, blockedBy: readonly string[]): string[] | null {
  const edges = new Map<string, readonly string[]>(tasks.map((t) => [t.id, t.blockedBy]))
  edges.set(taskId, blockedBy)
  // Each id reached, with the id that waits on it (the way back to taskId).
  const from = new Map<string, string>()
  const queue: string[] = []
  const reach = (b: string, by: string): string[] | null => {
    if (b === taskId) {
      const path = [taskId]
      for (let id = by; id !== taskId; id = from.get(id) as string) path.push(id)
      path.push(taskId)
      return path.reverse()
    }
    if (!from.has(b)) {
      from.set(b, by)
      queue.push(b)
    }
    return null
  }
  for (const b of blockedBy) {
    const loop = reach(b, taskId)
    if (loop) return loop
  }
  for (let i = 0; i < queue.length; i++) {
    for (const b of edges.get(queue[i]) ?? []) {
      const loop = reach(b, queue[i])
      if (loop) return loop
    }
  }
  return null
}

/**
 * A blocker list: ids, no duplicates (first kept), within the cap, no self, each live or archived, acyclic (a loop
 * answers `cycle` with the loop as `current`, so the agent reads which tasks close it).
 */
function checkBlockers(rt: TeamRuntime, selfId: string | null, v: unknown): { ok: true; ids: string[] } | Fail {
  if (!Array.isArray(v)) return fail('bad_request')
  const ids: string[] = []
  for (const b of v) {
    if (typeof b !== 'string' || !TASK_ID_RE.test(b)) return fail('bad_request')
    if (!ids.includes(b)) ids.push(b)
  }
  if (ids.length > BLOCKED_BY_MAX) return fail('bad_request')
  if (selfId !== null && ids.includes(selfId)) return fail('bad_request')
  if (ids.some((b) => blockerState(rt, b) === undefined)) return fail('not_found')
  const loop = selfId !== null ? blockersCycle(rt.tasks, selfId, ids) : null
  if (loop) return fail('cycle', { current: loop })
  return { ok: true, ids }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The open depCancelled card of a task blocked by a cancelled task (T1); actions drop it or cancel the task. */
function depCancelledCard(rt: TeamRuntime, task: TeamTask, ctx: Pick<FlowCtx, 'now'>): TeamRuntime {
  const cancelled = task.blockedBy.filter((b) => blockerState(rt, b) === 'cancelled')
  const card = openSystemCard(rt, { why: 'depCancelled', actions: ['dropBlocker', 'cancelTask', 'dismiss'], taskId: task.id, vars: { blockers: cancelled.join(',') } }, ctx)
  return card.ok ? card.rt : rt
}

/** A task leaves or enters blocked{deps} by its blockers (T1 on create, a blockedBy edit later; T16 stays reconcileTasks'). */
function applyDeps(rt: TeamRuntime, t: TeamTask, ctx: Pick<FlowCtx, 'now'>): { rt: TeamRuntime; task: TeamTask } {
  const deps = depsOf(rt, t.blockedBy)
  if (t.state === 'todo' && t.phase === 'none' && deps !== 'ready') {
    const task: TeamTask = { ...t, state: 'blocked', blocked: { reason: { kind: 'deps' }, resume: { state: 'todo', phase: 'none' }, at: ctx.now }, stateSince: ctx.now }
    return { rt, task }
  }
  if (t.state === 'blocked' && t.blocked?.reason.kind === 'deps' && deps === 'ready') {
    const task: TeamTask = { ...t, state: t.blocked.resume.state, phase: t.blocked.resume.phase, stateSince: ctx.now }
    delete task.blocked
    return { rt, task }
  }
  return { rt, task: t }
}

/** The fields a user create filled (store rule 4: they stay the user's). */
function filledFields(d: TaskDraft): TaskField[] {
  const out: TaskField[] = ['title']
  if (d.body !== undefined && d.body.trim() !== '') out.push('body')
  if (d.assignee !== undefined) out.push('assignee')
  if (d.repoId !== undefined) out.push('repoId')
  if (d.isolation !== undefined) out.push('isolation')
  if (d.blockedBy !== undefined && d.blockedBy.length > 0) out.push('blockedBy')
  if (d.priority !== undefined) out.push('priority')
  if (d.needsPlan !== undefined) out.push('needsPlan')
  return TASK_FIELDS.filter((f) => out.includes(f))
}

function ownAdd(owned: readonly TaskField[], add: readonly TaskField[]): TaskField[] {
  const set = new Set([...owned, ...add])
  return TASK_FIELDS.filter((f) => set.has(f))
}

/**
 * T1: a new task (the user, the Lead, a Dev's subtask, a routine). Defaults:
 * priority normal, repo `main`, isolation worktree, a plan first. Blockers
 * that are not done create it blocked{deps} (resume todo); a cancelled one
 * also opens a depCancelled card. Over TEAM_TASKS_MAX live tasks the old done
 * and cancelled ones are archived first; still full -> `cap`.
 */
export function createTask(rt: TeamRuntime, actor: Actor, d: TaskDraft & { parentId?: string }, ctx: FlowCtx): FlowResult<{ task: TeamTask }> {
  const title = cleanTitle(d.title)
  if (title === null) return fail('bad_request')
  const body = d.body === undefined ? '' : cleanText(d.body, TASK_BODY_MAX, { empty: true })
  if (body === null) return fail('bad_request')
  if (d.assignee !== undefined) {
    const e = assigneeError(rt, d.assignee)
    if (e) return fail(e)
  }
  const repoId = d.repoId ?? REPO_MAIN
  if (!validRepo(ctx, repoId)) return fail('bad_request')
  if (d.isolation !== undefined && !isIsolation(d.isolation)) return fail('bad_request')
  if (d.priority !== undefined && !isPriority(d.priority)) return fail('bad_request')
  if (d.needsPlan !== undefined && typeof d.needsPlan !== 'boolean') return fail('bad_request')
  const blockers = checkBlockers(rt, null, d.blockedBy ?? [])
  if (!blockers.ok) return blockers
  if (d.parentId !== undefined && !rt.tasks.some((t) => t.id === d.parentId)) return fail('not_found')

  let base = rt
  const effects: TeamEffect[] = []
  if (base.tasks.length >= TEAM_TASKS_MAX) {
    const swept = archiveSweep(base, ctx)
    if (swept.ok) {
      base = swept.rt
      effects.push(...swept.effects)
    }
  }
  if (base.tasks.length >= TEAM_TASKS_MAX || base.nextIds.task > TASK_NUM_MAX) return fail('cap')

  const id = taskIdOf(base.nextIds.task)
  let task: TeamTask = {
    id, rev: 1, title, body,
    state: 'todo', phase: 'none',
    priority: d.priority ?? 'normal',
    repoId, isolation: d.isolation ?? 'worktree', needsPlan: d.needsPlan ?? true,
    blockedBy: blockers.ids,
    createdBy: actor, createdAt: ctx.now, updatedAt: ctx.now, stateSince: ctx.now,
    review: { round: 0, max: QA_ROUNDS_MAX },
    userOwned: actor.kind === 'user' ? filledFields(d) : [],
    counters: { noProgress: 0, continuations: 0, retries: 0, interrupts: 0, unblockWakes: 0, unblockWindowStart: 0 },
  }
  if (d.assignee !== undefined) task.assignee = d.assignee
  if (d.parentId !== undefined) task.parentId = d.parentId
  let out: TeamRuntime = { ...base, nextIds: { ...base.nextIds, task: base.nextIds.task + 1 } }
  ;({ rt: out, task } = applyDeps(out, task, ctx))
  out = { ...out, tasks: [...out.tasks, task] }
  if (task.state === 'blocked' && depsOf(out, task.blockedBy) === 'cancelled') out = depCancelledCard(out, task, ctx)
  effects.push({ kind: 'dispatch' })
  return { ok: true, rt: out, effects, result: { task } }
}

/** The run mode of a task phase (I3), for the level a resume sets. */
const PHASE_MODE: Readonly<Partial<Record<TeamTask['phase'], RunMode>>> = { planning: 'plan', executing: 'exec', qa: 'qa' }

/**
 * A task leaves for `to` (T18 for the user, T19 for the Lead): its level and
 * queue items go; leaving its phase (todo, done, cancelled) cancels its
 * pending approvals; back to todo it starts over (the plan, the QA round and
 * the counters go); to blocked it keeps its phase to resume to, and a block
 * of the Lead says so (`by: 'lead'`, never read as the user's own). Moot
 * cards are dismissed: the blocking card when it unblocks, every open card
 * when it is done or cancelled. The caller stopped the run first.
 */
function moveTo(
  rt: TeamRuntime,
  task: TeamTask,
  to: 'todo' | 'blocked' | 'done' | 'cancelled',
  o: { text?: string; byLead?: boolean },
  ctx: Pick<FlowCtx, 'now'>,
): { rt: TeamRuntime; task: TeamTask } {
  let t: TeamTask = { ...task, updatedAt: ctx.now }
  delete t.next
  let out = rt
  if (to === 'blocked') {
    const reason: Extract<BlockedReason, { kind: 'user' }> = { kind: 'user' }
    if (o.text) reason.text = o.text
    if (o.byLead) reason.by = 'lead'
    const resume = task.blocked ? task.blocked.resume : { state: task.state, phase: task.phase }
    t = { ...t, state: 'blocked', blocked: { reason, resume, at: ctx.now } }
    if (task.state !== 'blocked') t.stateSince = ctx.now
  } else {
    if (task.phase !== 'none') {
      out = {
        ...out,
        approvals: out.approvals.map((a) => (a.taskId === task.id && a.state === 'pending' ? { ...a, state: 'cancelled' as const, decidedAt: ctx.now } : a)),
      }
    }
    if (to === 'todo') {
      delete t.plan
      delete t.cooldownUntil
      t.review = { ...t.review, round: 0 }
      delete t.review.lastVerdict
      t.counters = { ...t.counters, noProgress: 0, continuations: 0, retries: 0, interrupts: 0 }
    } else if (t.plan?.status === 'pending') delete t.plan
    t = { ...t, state: to, phase: 'none', stateSince: ctx.now }
    delete t.blocked
  }
  const blockingCard = task.blocked?.reason.kind === 'card' ? task.blocked.reason.cardId : null
  const dismissAll = to === 'done' || to === 'cancelled'
  if (dismissAll || (blockingCard && to !== 'blocked')) {
    out = {
      ...out,
      cards: out.cards.map((c) => (c.state === 'open' && c.taskId === task.id && (dismissAll || c.id === blockingCard) ? { ...c, state: 'dismissed' as const } : c)),
    }
  }
  if (to !== 'blocked' && out.queue.some((q) => q.taskId === task.id)) out = { ...out, queue: out.queue.filter((q) => q.taskId !== task.id) }
  return { rt: out, task: t }
}

/**
 * T19 / T20: an edit of a task's fields (the drawer, `team task update`).
 * `baseRev` (user ops, an agent's `--rev`) must equal `task.rev`, else
 * `conflict {rev}` with the current task. An agent that would change a field
 * the user owns is refused whole (`user_owned {fields}`), a side effect
 * included: a blockedBy edit that would move a task whose state the user owns
 * answers `user_owned ['state']`. A user edit makes the fields it changed the
 * user's, but for "Lead decides" (assignee null), which hands `assignee` back
 * to the Lead. Isolation and repo only before the first admission (`frozen`);
 * a new assignee while a run is active: an agent gets `busy`, the user
 * `running` (stop the run first, decision 37). `state` is the Lead's (todo,
 * blocked, cancelled from todo, doing or blocked, no active run; its block is
 * `blocked {user, by: 'lead'}`). A blockedBy edit moves a todo task into
 * blocked{deps}, and one whose blockers are now done back out.
 */
export function updateTask(
  rt: TeamRuntime,
  actor: Actor,
  taskId: string,
  patch: TaskPatch & { state?: 'todo' | 'blocked' | 'cancelled' },
  baseRev: number | undefined,
  ctx: FlowCtx,
): FlowResult<{ task: TeamTask }> {
  const task = rt.tasks.find((t) => t.id === taskId)
  if (!task) return fail('not_found')
  if (baseRev !== undefined && baseRev !== task.rev) return fail('conflict', { reason: 'rev', current: task })
  const touched: TaskField[] = []
  let t: TeamTask = { ...task }
  if (patch.title !== undefined) {
    const title = cleanTitle(patch.title)
    if (title === null) return fail('bad_request')
    if (title !== task.title) {
      t.title = title
      touched.push('title')
    }
  }
  if (patch.body !== undefined) {
    const body = cleanText(patch.body, TASK_BODY_MAX, { empty: true })
    if (body === null) return fail('bad_request')
    if (body !== task.body) {
      t.body = body
      touched.push('body')
    }
  }
  if (patch.assignee !== undefined) {
    const next = patch.assignee ?? undefined
    if (next !== undefined) {
      const e = assigneeError(rt, next)
      if (e) return fail(e)
    }
    if (next !== task.assignee) {
      if (next === undefined) delete t.assignee
      else t.assignee = next
      touched.push('assignee')
    }
  }
  if (patch.priority !== undefined) {
    if (!isPriority(patch.priority)) return fail('bad_request')
    if (patch.priority !== task.priority) {
      t.priority = patch.priority
      touched.push('priority')
    }
  }
  if (patch.blockedBy !== undefined) {
    const blockers = checkBlockers(rt, task.id, patch.blockedBy)
    if (!blockers.ok) return blockers
    if (!sameList(blockers.ids, task.blockedBy)) {
      t.blockedBy = blockers.ids
      touched.push('blockedBy')
    }
  }
  if (patch.isolation !== undefined) {
    if (!isIsolation(patch.isolation)) return fail('bad_request')
    if (patch.isolation !== task.isolation) {
      if (task.frozen) return fail('bad_request')
      t.isolation = patch.isolation
      touched.push('isolation')
    }
  }
  if (patch.repoId !== undefined) {
    if (!validRepo(ctx, patch.repoId)) return fail('bad_request')
    if (patch.repoId !== task.repoId) {
      if (task.frozen) return fail('bad_request')
      t.repoId = patch.repoId
      touched.push('repoId')
    }
  }
  if (patch.needsPlan !== undefined) {
    if (typeof patch.needsPlan !== 'boolean') return fail('bad_request')
    if (patch.needsPlan !== task.needsPlan) {
      t.needsPlan = patch.needsPlan
      touched.push('needsPlan')
    }
  }
  if (patch.state !== undefined && patch.state !== 'todo' && patch.state !== 'blocked' && patch.state !== 'cancelled') return fail('bad_request')
  const toState = patch.state !== undefined && patch.state !== task.state ? patch.state : undefined
  if (toState !== undefined) touched.push('state')
  if (touched.length === 0) return { ok: true, rt, effects: [], result: { task } }

  // Phase and run checks, then what the user owns (the order of applyTool).
  const run = rt.activeRuns.find((r) => r.taskId === task.id)
  if (toState !== undefined) {
    // T19: the Lead moves only what is not under review or over, and never under a running run.
    if (actor.kind === 'user' || (task.state !== 'todo' && task.state !== 'doing' && task.state !== 'blocked')) return fail('forbidden')
    if (run || task.integrate?.state === 'running') return fail('busy')
  }
  if (run && touched.includes('assignee')) return fail(actor.kind === 'user' ? 'running' : 'busy')
  if (actor.kind === 'agent') {
    const owned = TASK_FIELDS.filter((f) => touched.includes(f) && task.userOwned.includes(f))
    if (owned.length > 0) return fail('user_owned', { fields: owned })
  }
  let out = rt
  if (toState !== undefined) {
    const moved = moveTo(out, t, toState, { byLead: actor.kind === 'agent' }, ctx)
    out = moved.rt
    t = moved.task
  }
  // The Lead's todo honors the blockers (the user's own move to todo is the user's call, T18).
  if (touched.includes('blockedBy') || toState === 'todo') ({ rt: out, task: t } = applyDeps(out, t, ctx))
  // A blocker edit of an agent never moves a task the user placed (store rule 4: refused whole, the user wins).
  if (actor.kind === 'agent' && task.userOwned.includes('state') && (t.state !== task.state || t.phase !== task.phase)) return fail('user_owned', { fields: ['state'] })
  t.updatedAt = ctx.now
  if (actor.kind === 'user') {
    // "Lead decides" (assignee null) hands the field to the Lead instead of fixing it to nobody.
    const owned = ownAdd(task.userOwned, touched)
    t.userOwned = patch.assignee === null ? owned.filter((f) => f !== 'assignee') : owned
  }
  out = { ...out, tasks: replaceTask(out.tasks, t) }
  if (touched.includes('blockedBy') && t.state === 'blocked' && t.blocked?.reason.kind === 'deps' && depsOf(out, t.blockedBy) === 'cancelled') out = depCancelledCard(out, t, ctx)
  return { ok: true, rt: out, effects: [{ kind: 'dispatch' }], result: { task: t } }
}

/**
 * T18: the user drags or moves a task to todo, blocked{user}, done or
 * cancelled (a manual done never integrates). `baseRev` must match. A task
 * with an active run needs `stopRun: true` (the run stops with `taskMoved`),
 * else `running` (decision 37). `state` (and `priority` when given) join
 * `userOwned`. A cancelled task stays cancelled (`bad_request`). The same
 * state only applies the priority (in blocked, only over the user's own
 * block: a block of the Lead becomes the user's).
 */
export function moveTask(
  rt: TeamRuntime,
  _actor: Actor & { kind: 'user' },
  taskId: string,
  to: 'todo' | 'blocked' | 'done' | 'cancelled',
  baseRev: number,
  o: { priority?: TaskPriority; stopRun?: boolean; text?: string },
  ctx: FlowCtx,
): FlowResult<{ task: TeamTask }> {
  const task = rt.tasks.find((t) => t.id === taskId)
  if (!task) return fail('not_found')
  if (baseRev !== task.rev) return fail('conflict', { reason: 'rev', current: task })
  if (task.state === 'cancelled') return fail('bad_request')
  if (to !== 'todo' && to !== 'blocked' && to !== 'done' && to !== 'cancelled') return fail('bad_request')
  if (o.priority !== undefined && !isPriority(o.priority)) return fail('bad_request')
  const text = o.text === undefined ? undefined : cleanText(o.text, COMMENT_TEXT_MAX, { empty: true })
  if (text === null) return fail('bad_request')
  const prio = o.priority !== undefined && o.priority !== task.priority ? o.priority : undefined
  // A block of the Lead is not the user's: moving it to blocked makes it theirs (and its state).
  const reason = task.blocked?.reason
  const sameState = to === task.state && (to !== 'blocked' || (reason?.kind === 'user' && reason.by === undefined))
  if (sameState) {
    if (prio === undefined) return { ok: true, rt, effects: [], result: { task } }
    const t: TeamTask = { ...task, priority: prio, updatedAt: ctx.now, userOwned: ownAdd(task.userOwned, ['priority']) }
    return { ok: true, rt: { ...rt, tasks: replaceTask(rt.tasks, t) }, effects: [{ kind: 'dispatch' }], result: { task: t } }
  }

  // An Integrar in flight finishes its bounded steps first (B6): the task waits for its end commit.
  if (task.integrate?.state === 'running') return fail('busy')
  let out = rt
  const effects: TeamEffect[] = []
  const run = rt.activeRuns.find((r) => r.taskId === task.id)
  if (run && run.state !== 'stopping') {
    if (!o.stopRun) return fail('running')
    const stopped = requestStop(out, run.id, 'taskMoved', ctx)
    if (!stopped.ok) return stopped
    out = stopped.rt
    effects.push(...stopped.effects)
  }
  const cur = out.tasks.find((t) => t.id === task.id) ?? task
  const moved = moveTo(out, cur, to, { text: text || undefined }, ctx)
  out = moved.rt
  let t = moved.task
  if (prio !== undefined) t = { ...t, priority: prio }
  t.userOwned = ownAdd(cur.userOwned, prio !== undefined ? ['state', 'priority'] : ['state'])
  out = { ...out, tasks: replaceTask(out.tasks, t) }
  effects.push({ kind: 'dispatch' })
  return { ok: true, rt: out, effects, result: { task: t } }
}

/**
 * T17: a task blocked by a card, the user or a stop resumes to the pair it
 * was blocked in, with a `retry` level for the agent of that phase (the card
 * action resume / retry, B5). A todo resume whose blockers are not done goes
 * to blocked{deps} instead. blocked{deps} resumes only by level (T16).
 */
export function resumeTask(rt: TeamRuntime, _actor: Actor, taskId: string, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const task = rt.tasks.find((t) => t.id === taskId)
  if (!task) return fail('not_found')
  if (task.state !== 'blocked' || !task.blocked || task.blocked.reason.kind === 'deps') return fail('conflict', { reason: 'stale' })
  const { resume, reason } = task.blocked
  let t: TeamTask = { ...task, state: resume.state, phase: resume.phase, stateSince: ctx.now, updatedAt: ctx.now }
  delete t.blocked
  const mode = PHASE_MODE[resume.phase]
  const agentId = resume.phase === 'qa' ? task.review.qaAgentId : task.assignee
  if (mode && agentId) {
    const next: WakeMark = { agentId, mode, reason: 'retry', since: ctx.now, bypassCooldown: true }
    t.next = next
  }
  let out = rt
  if (t.state === 'todo' && depsOf(rt, t.blockedBy) !== 'ready') {
    t = { ...t, state: 'blocked', blocked: { reason: { kind: 'deps' }, resume: { state: 'todo', phase: 'none' }, at: ctx.now } }
  }
  if (reason.kind === 'card') {
    out = { ...out, cards: out.cards.map((c) => (c.id === reason.cardId && c.state === 'open' ? { ...c, state: 'dismissed' as const } : c)) }
  }
  out = { ...out, tasks: replaceTask(out.tasks, t) }
  return { ok: true, rt: out, effects: [{ kind: 'dispatch' }], result: undefined }
}

/** The user hands fields back (an agent may change them again). */
export function releaseOwned(rt: TeamRuntime, taskId: string, fields: TaskField[], ctx: Pick<FlowCtx, 'now'>): FlowResult<{ task: TeamTask }> {
  const task = rt.tasks.find((t) => t.id === taskId)
  if (!task) return fail('not_found')
  if (!Array.isArray(fields) || fields.some((f) => !TASK_FIELDS.includes(f))) return fail('bad_request')
  const left = task.userOwned.filter((f) => !fields.includes(f))
  if (left.length === task.userOwned.length) return { ok: true, rt, effects: [], result: { task } }
  const t: TeamTask = { ...task, userOwned: left, updatedAt: ctx.now }
  return { ok: true, rt: { ...rt, tasks: replaceTask(rt.tasks, t) }, effects: [], result: { task: t } }
}

/**
 * The recipient of a comment, fixed at write time (4.5): the Lead thread ->
 * the Lead, and only for the user (agent and system comments never wake the
 * Lead, risk 10); a task in qa -> its QA agent, else its assignee; a done or
 * cancelled task -> nobody; never the author itself.
 */
export function recipientOf(rt: TeamRuntime, target: string, author: Actor): string | undefined {
  if (target === LEAD_THREAD) {
    if (author.kind !== 'user') return undefined
    return (rt.agents.find((a) => a.roleKind === 'lead' && !a.retired) ?? rt.agents.find((a) => a.roleKind === 'lead'))?.id
  }
  const task = rt.tasks.find((t) => t.id === target)
  if (!task || task.state === 'done' || task.state === 'cancelled') return undefined
  const r = task.phase === 'qa' ? task.review.qaAgentId : task.assignee
  if (!r || (author.kind === 'agent' && author.agentId === r)) return undefined
  return r
}

/**
 * Appends one comment to a target with its recipient (4.5). Over
 * TASK_COMMENTS_MAX the oldest comments that wait for nobody move to the
 * archive (effect archiveComments); a target full of queued comments ->
 * `cap`. Exported for the main-authored `sys` comments of later milestones.
 */
export function appendComment(
  rt: TeamRuntime,
  c: { author: Actor; target: string; kind: CommentKind; text: string; sys?: SysText; forAgent?: string },
  ctx: Pick<FlowCtx, 'now'>,
): FlowResult<{ comment: TeamComment }> {
  if (rt.nextIds.comment > COMMENT_NUM_MAX) return fail('cap')
  const list = rt.comments[c.target] ?? []
  const effects: TeamEffect[] = []
  let kept = list
  if (list.length >= TASK_COMMENTS_MAX) {
    const need = list.length - TASK_COMMENTS_MAX + 1
    const drop = new Set<string>()
    for (const x of list) {
      if (drop.size >= need) break
      if (x.forAgent === undefined || x.deliveredRunId !== undefined) drop.add(x.id)
    }
    if (drop.size < need) return fail('cap')
    kept = list.filter((x) => !drop.has(x.id))
    effects.push({ kind: 'archiveComments', target: c.target, comments: list.filter((x) => drop.has(x.id)) })
  }
  const comment: TeamComment = { id: `m-${rt.nextIds.comment}`, target: c.target, author: c.author, kind: c.kind, at: ctx.now, text: c.sys ? '' : c.text }
  if (c.sys) comment.sys = c.sys
  if (c.forAgent !== undefined) comment.forAgent = c.forAgent
  if (comment.forAgent) effects.push({ kind: 'dispatch' })
  return {
    ok: true,
    rt: { ...rt, comments: { ...rt.comments, [c.target]: [...kept, comment] }, nextIds: { ...rt.nextIds, comment: rt.nextIds.comment + 1 } },
    effects,
    result: { comment },
  }
}

/** A user or agent comment on a task or in the Lead thread (`lead`). A comment for a recipient pokes the dispatcher. */
export function addComment(rt: TeamRuntime, actor: Actor, target: string, text: string, kind: CommentKind, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ comment: TeamComment }> {
  if (target !== LEAD_THREAD && !rt.tasks.some((t) => t.id === target)) return fail('not_found')
  const clean = cleanText(text, COMMENT_TEXT_MAX, { empty: false })
  if (clean === null) return fail('bad_request')
  return appendComment(rt, { author: actor, target, kind, text: clean, forAgent: recipientOf(rt, target, actor) }, ctx)
}

/**
 * `team task get` (4.5): the queued comments of `agentId` its reply carries
 * are delivered to its run. The caller checks the run is neither concluded
 * nor stopping.
 */
export function deliverComments(rt: TeamRuntime, runId: string, agentId: string, ids: readonly string[]): FlowResult {
  if (ids.length === 0) return { ok: true, rt, effects: [], result: undefined }
  const want = new Set(ids)
  let changed = false
  const comments: TeamRuntime['comments'] = {}
  for (const [target, list] of Object.entries(rt.comments)) {
    comments[target] = list.map((c) => {
      if (!want.has(c.id) || c.forAgent !== agentId || c.deliveredRunId !== undefined) return c
      changed = true
      return { ...c, deliveredRunId: runId }
    })
  }
  return { ok: true, rt: changed ? { ...rt, comments } : rt, effects: [], result: undefined }
}

/**
 * Decision 27: done and cancelled tasks older than TASK_ARCHIVE_AFTER_MS
 * (since their state), with no active run and named by no blockedBy of a task
 * that stays, move to `archive/tasks.jsonl` with their comments; their ids
 * stay known in `archivedTasks` (blockers read them there) and their queue
 * items go.
 */
export function archiveSweep(rt: TeamRuntime, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const cutoff = ctx.now - TASK_ARCHIVE_AFTER_MS
  const busy = new Set(rt.activeRuns.map((r) => r.taskId).filter((id): id is string => !!id))
  const old = new Set(rt.tasks.filter((t) => (t.state === 'done' || t.state === 'cancelled') && t.stateSince < cutoff && !busy.has(t.id)).map((t) => t.id))
  if (old.size === 0) return { ok: true, rt, effects: [], result: undefined }
  // Until nothing moves: a task kept because a live one names it keeps its own blockers live too.
  for (let kept = true; kept; ) {
    kept = false
    for (const t of rt.tasks) if (!old.has(t.id)) for (const b of t.blockedBy) if (old.delete(b)) kept = true
  }
  if (old.size === 0) return { ok: true, rt, effects: [], result: undefined }
  const gone = rt.tasks.filter((t) => old.has(t.id))
  const effects: TeamEffect[] = [{ kind: 'archiveTasks', tasks: gone }]
  const comments: TeamRuntime['comments'] = { ...rt.comments }
  for (const id of old) {
    const list = comments[id]
    if (list?.length) effects.push({ kind: 'archiveComments', target: id, comments: list })
    delete comments[id]
  }
  const archivedTasks = { ...rt.archivedTasks }
  for (const t of gone) archivedTasks[t.id] = t.state as 'done' | 'cancelled'
  return {
    ok: true,
    rt: { ...rt, tasks: rt.tasks.filter((t) => !old.has(t.id)), comments, archivedTasks, queue: rt.queue.filter((q) => !q.taskId || !old.has(q.taskId)) },
    effects,
    result: undefined,
  }
}

/**
 * The scopes a commit touches, from what moved between two runtimes (the
 * header `team` scope is TeamService.commit's): tasks -> board and task,
 * comments of the Lead thread -> lead, of a task -> task and board (its
 * counts), cards, approvals and the queue -> needs, runs and agents -> agents
 * and run.
 */
export function changedScopes(prev: Readonly<TeamRuntime>, next: Readonly<TeamRuntime>): TeamScope[] {
  const out = new Set<TeamScope>()
  if (prev.tasks !== next.tasks) {
    out.add('board')
    out.add('task')
  }
  if (prev.comments !== next.comments) {
    const keys = new Set([...Object.keys(prev.comments), ...Object.keys(next.comments)])
    for (const k of keys) {
      if (prev.comments[k] === next.comments[k]) continue
      if (k === LEAD_THREAD) out.add('lead')
      else {
        out.add('task')
        out.add('board')
      }
    }
  }
  if (prev.cards !== next.cards || prev.approvals !== next.approvals || prev.queue !== next.queue) out.add('needs')
  if (prev.activeRuns !== next.activeRuns || prev.agents !== next.agents) {
    out.add('agents')
    out.add('run')
  }
  return [...out]
}
