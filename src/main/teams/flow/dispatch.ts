/**
 * Dispatch reducers (app 2.7.0, E10 B4, design 3.4, the task machine's T16
 * and the queue items of 4.5). Pure, no Node imports, copy on write.
 *
 * reconcileTasks runs at the head of every dispatch pass: a task whose
 * blockers are all done leaves blocked{deps} (at most UNBLOCK_WAKES_PER_HOUR
 * times an hour, then one card), a cancelled blocker opens its card, levels
 * that no longer fit their task go (a reassigned task's wake, a phase that
 * moved on, an exec of a task that still needs a plan), queue items whose
 * level is gone are dropped, and a small plan the Lead saw without deciding
 * goes to the user (decision 29). It changes
 * nothing when nothing is due, so a quiet pass commits nothing.
 *
 * enqueue holds the requests autonomy off keeps for "Por despachar" (one item
 * per agent and session key, I13); queueDecide is the user's Despachar /
 * Descartar on them.
 */
import { unblockReady, unblockWake } from '@shared/teamDispatch'
import {
  LEAD_THREAD,
  type Actor,
  type AgentState,
  type QueueItem,
  type RunMode,
  type RunRequest,
  type TeamDefinition,
  type TeamRuntime,
  type TeamTask,
  type WakeMark,
} from '@shared/teams'
import { openSystemCard } from './agents'
import { appendComment } from './tasks'
import type { FlowCtx, FlowResult, TeamEffect } from './types'

/** QUEUE_ID_RE allows 7 digits. */
const QUEUE_NUM_MAX = 9_999_999
/** The T16 unblock window (= teamDispatch's HOUR_MS): an unblock it refused is tried again when it ends. */
const UNBLOCK_WINDOW_MS = 60 * 60_000

function replaceTask(tasks: readonly TeamTask[], t: TeamTask): TeamTask[] {
  return tasks.map((x) => (x.id === t.id ? t : x))
}

/**
 * A system card of `why` for the task already raised, in any state, that `same` accepts: a reason a pass finds again
 * is raised once (a dismissed card stays dismissed; openSystemCard alone dedups only the open ones).
 */
function raised(rt: TeamRuntime, taskId: string, why: 'depCancelled' | 'unblockLimit', same: (vars: Record<string, string | number> | undefined, createdAt: number) => boolean): boolean {
  return rt.cards.some((c) => c.taskId === taskId && c.from.kind === 'system' && c.from.why === why && same(c.from.vars, c.createdAt))
}

/** The agent a phase of the task runs (assignee for todo and doing; its QA agent in qa); undefined in the other phases. */
export function phaseAgentOf(t: Pick<TeamTask, 'state' | 'phase' | 'assignee' | 'review'>): string | undefined {
  if (t.state === 'todo' || t.phase === 'planning' || t.phase === 'executing') return t.assignee
  if (t.phase === 'qa') return t.review.qaAgentId
  return undefined
}

/**
 * A run mode that may run in the task's current pair (I3; todo admits plan and exec, T2 / T3). Executing admits exec
 * only when the task needs no plan or has it approved, the rule of teamDispatch modeFor (B5 review, second round):
 * admitRun refuses any other exec run, so its wake mark and its "Por despachar" item are levels that no longer stand.
 */
export function modeFits(t: Pick<TeamTask, 'state' | 'phase' | 'needsPlan' | 'plan'>, mode: RunMode): boolean {
  if (t.state === 'todo') return mode === 'plan' || mode === 'exec'
  if (mode === 'plan') return t.phase === 'planning'
  if (mode === 'exec') return t.phase === 'executing' && todoModeOf(t) === 'exec'
  if (mode === 'qa') return t.phase === 'qa'
  return false
}

/**
 * True when a task's level for `agentId` still stands: its wake mark, the todo assignee (L2) or comments queued for it
 * (L3), in a mode its phase admits (modeFits: an exec of an executing task that still needs a plan does not). A todo
 * task runs only its todoModeOf (teamDispatch modeFor): a level of the other mode (needsPlan changed in todo since it
 * was queued) no longer stands either, so its "Por despachar" item never offers a plan run that would start as an exec.
 */
function taskLevelFor(rt: TeamRuntime, t: TeamTask, agentId: string, mode: RunMode): boolean {
  if (t.state === 'done' || t.state === 'cancelled' || t.state === 'blocked') return false
  if (phaseAgentOf(t) !== agentId || !modeFits(t, mode)) return false
  if (t.state === 'todo' && mode !== todoModeOf(t)) return false
  if (t.next && t.next.agentId === agentId) return true
  if (t.state === 'todo' && t.assignee === agentId) return true
  return (rt.comments[t.id] ?? []).some((c) => c.forAgent === agentId && c.deliveredRunId === undefined)
}

/**
 * The Lead's levels (L4), as candidatesOf reads them: its wake mark, an unread user message, a goal it has not seen,
 * a small plan to decide, a task to triage (one the Lead created itself never asks it to).
 */
function leadLevel(rt: TeamRuntime, def: TeamDefinition, a: AgentState, goalHash: string): boolean {
  if (a.next) return true
  if ((rt.comments[LEAD_THREAD] ?? []).some((c) => c.author.kind === 'user' && c.forAgent === a.id && c.deliveredRunId === undefined)) return true
  if (def.goal.trim() !== '' && rt.goalSeenHash !== goalHash) return true
  if (rt.approvals.some((x) => x.kind === 'plan' && x.state === 'pending' && x.decider === 'lead' && !x.leadSeenRunId)) return true
  return rt.tasks.some((t) => t.state === 'todo' && !t.assignee && t.triagedAt === undefined && !(t.createdBy.kind === 'agent' && t.createdBy.roleKind === 'lead'))
}

/** A queue item whose level is gone (its agent, its task, the phase, the reason itself): reconcileTasks drops it. */
function itemAlive(rt: TeamRuntime, def: TeamDefinition, q: QueueItem, goalHash: string): boolean {
  const a = rt.agents.find((x) => x.id === q.agentId)
  if (!a || a.retired) return false
  if (q.taskId) {
    const t = rt.tasks.find((x) => x.id === q.taskId)
    return !!t && taskLevelFor(rt, t, q.agentId, q.mode)
  }
  if (a.roleKind === 'lead') return leadLevel(rt, def, a, goalHash)
  return !!a.next
}

/**
 * The run mode a task wants of its assignee from todo: a plan first while it
 * needs one and has none approved, else the execution (L2, T2 / T3).
 */
export function todoModeOf(t: Pick<TeamTask, 'needsPlan' | 'plan'>): RunMode {
  return t.needsPlan && t.plan?.status !== 'approved' ? 'plan' : 'exec'
}

/**
 * reconcileTasks: T16 unblock, stale levels, queue drop, depCancelled cards, lead escalation (design 3.4). `nextAt`:
 * the end of the earliest unblock window that refused a task (the pass arms its deadline there, nothing polls).
 */
export function reconcileTasks(rt: TeamRuntime, def: TeamDefinition, ctx: FlowCtx): FlowResult<{ nextAt: number | null }> {
  let out = rt
  const now = ctx.now
  const byId = new Map(rt.tasks.map((t) => [t.id, t]))
  const effects: TeamEffect[] = []
  let nextAt: number | null = null

  // T16: blocked{deps} whose blockers are all done resume (the unblock budget per hour), a cancelled one opens its card.
  for (const t0 of rt.tasks) {
    if (t0.state !== 'blocked' || t0.blocked?.reason.kind !== 'deps') continue
    const ready = unblockReady(t0, byId, rt.archivedTasks)
    if (ready === 'cancelledBlocker') {
      const blockers = t0.blockedBy.filter((b) => (byId.get(b)?.state ?? rt.archivedTasks[b]) === 'cancelled').join(',')
      if (!raised(out, t0.id, 'depCancelled', (vars) => vars?.blockers === blockers)) {
        const card = openSystemCard(out, { why: 'depCancelled', actions: ['dropBlocker', 'cancelTask', 'dismiss'], taskId: t0.id, vars: { blockers } }, ctx)
        if (card.ok) out = card.rt
      }
      continue
    }
    if (ready !== 'ready') continue
    const t = out.tasks.find((x) => x.id === t0.id) ?? t0
    const wake = unblockWake(t.counters, now)
    if (!wake.ok) {
      // Once per window; its end is a deadline of the pass (the next pass after it unblocks the task).
      const start = wake.counters.unblockWindowStart
      const until = start + UNBLOCK_WINDOW_MS
      if (nextAt === null || until < nextAt) nextAt = until
      if (!raised(out, t.id, 'unblockLimit', (_vars, at) => at >= start)) {
        const card = openSystemCard(out, { why: 'unblockLimit', actions: ['dismiss'], taskId: t.id }, ctx)
        if (card.ok) out = card.rt
      }
      continue
    }
    const resume = t.blocked?.resume ?? { state: 'todo' as const, phase: 'none' as const }
    let next: TeamTask = {
      ...t,
      state: resume.state,
      phase: resume.phase,
      stateSince: now,
      updatedAt: now,
      counters: { ...t.counters, ...wake.counters },
    }
    delete next.blocked
    if (next.assignee && next.state === 'todo') {
      const mark: WakeMark = { agentId: next.assignee, mode: todoModeOf(next), reason: 'unblocked', since: now }
      if (t.blockedBy.length) mark.refs = [...t.blockedBy]
      next = { ...next, next: mark }
    }
    out = { ...out, tasks: replaceTask(out.tasks, next) }
  }

  // Stale levels: a wake of a task that is over, of an agent that is gone or no longer the one of its phase (a
  // reassignment, by the user or the Lead), or of a mode the phase moved past. A blocked task keeps its own.
  const agents = new Map(out.agents.map((a) => [a.id, a]))
  for (const t of out.tasks) {
    const m = t.next
    if (!m) continue
    const agent = agents.get(m.agentId)
    const over = t.state === 'done' || t.state === 'cancelled'
    const stale = over || !agent || agent.retired || (t.state !== 'blocked' && (phaseAgentOf(t) !== m.agentId || !modeFits(t, m.mode)))
    if (!stale) continue
    const next: TeamTask = { ...t, updatedAt: now }
    delete next.next
    out = { ...out, tasks: replaceTask(out.tasks, next) }
  }
  for (const a of out.agents) {
    if (!a.next || !a.retired) continue
    const next: AgentState = { ...a }
    delete next.next
    out = { ...out, agents: out.agents.map((x) => (x.id === a.id ? next : x)) }
  }

  // Queue items whose level is gone.
  const kept = out.queue.filter((q) => itemAlive(out, def, q, ctx.def.goalHash))
  if (kept.length !== out.queue.length) out = { ...out, queue: kept }

  // Lead escalation (decision 29): a small plan the Lead saw in a run that ended without deciding waits for the user.
  const active = new Set(out.activeRuns.map((r) => r.id))
  for (const ap of out.approvals) {
    if (ap.state !== 'pending' || ap.decider !== 'lead' || !ap.leadSeenRunId || active.has(ap.leadSeenRunId)) continue
    out = { ...out, approvals: out.approvals.map((x) => (x.id === ap.id ? { ...x, decider: 'user' as const } : x)) }
    const note = appendComment(out, { author: { kind: 'system' }, target: LEAD_THREAD, kind: 'system', text: '', sys: { key: 'leadEscalation', vars: { taskId: ap.taskId ?? '' } } }, ctx)
    if (note.ok) {
      out = note.rt
      // A full thread archives its oldest delivered comments: that effect must run, or they are lost.
      effects.push(...note.effects)
    }
  }

  return { ok: true, rt: out, effects, result: { nextAt } }
}

/** Autonomy off (decision 18): one "Por despachar" item per agent and session key that has none yet. */
export function enqueue(rt: TeamRuntime, reqs: readonly RunRequest[], ctx: Pick<FlowCtx, 'now'>): FlowResult {
  let out = rt
  for (const r of reqs) {
    if (out.queue.some((q) => q.agentId === r.agentId && q.sessionKey === r.sessionKey)) continue
    if (!out.agents.some((a) => a.id === r.agentId)) continue
    if (out.nextIds.queue > QUEUE_NUM_MAX) break
    const item: QueueItem = { id: `q-${out.nextIds.queue}`, agentId: r.agentId, sessionKey: r.sessionKey, mode: r.mode, reason: r.reason, createdAt: ctx.now }
    if (r.taskId) item.taskId = r.taskId
    if (r.refs && r.refs.length) item.refs = [...r.refs]
    out = { ...out, queue: [...out.queue, item], nextIds: { ...out.nextIds, queue: out.nextIds.queue + 1 } }
  }
  return { ok: true, rt: out, effects: [], result: undefined }
}

/**
 * Discarding an item ends the level it came from where the runtime records one, so the next pass does not offer
 * it again: the task's or the agent's wake mark of that mode, the goal (kickoff: the Lead's CTA still asks for it),
 * the tasks to triage, a small plan the Lead would decide (the user decides it, decision 29). A level the runtime
 * derives (a todo assignee, queued comments, an unread message) stays; TeamService keeps it out of the queue until
 * it changes.
 */
function consumeLevel(rt: TeamRuntime, q: QueueItem, ctx: FlowCtx): TeamRuntime {
  let out = rt
  if (q.taskId) {
    const t = out.tasks.find((x) => x.id === q.taskId)
    if (t?.next && t.next.agentId === q.agentId && t.next.mode === q.mode) {
      const next: TeamTask = { ...t, updatedAt: ctx.now }
      delete next.next
      out = { ...out, tasks: replaceTask(out.tasks, next) }
    }
    return out
  }
  const a = out.agents.find((x) => x.id === q.agentId)
  if (a?.next && a.next.mode === q.mode && a.next.reason === q.reason) {
    const next: AgentState = { ...a }
    delete next.next
    out = { ...out, agents: out.agents.map((x) => (x.id === a.id ? next : x)) }
  }
  if (a?.roleKind !== 'lead') return out
  if (q.reason === 'kickoff' && out.goalSeenHash !== ctx.def.goalHash) out = { ...out, goalSeenHash: ctx.def.goalHash }
  if (q.reason === 'triage') {
    out = { ...out, tasks: out.tasks.map((t) => (t.state === 'todo' && !t.assignee && t.triagedAt === undefined ? { ...t, triagedAt: ctx.now } : t)) }
  }
  if (q.reason === 'leadApproval') {
    out = { ...out, approvals: out.approvals.map((x) => (x.state === 'pending' && x.decider === 'lead' && !x.leadSeenRunId ? { ...x, decider: 'user' as const } : x)) }
  }
  return out
}

/**
 * Despachar (`go`) / Descartar one item, or `all` of them. Despachar sets
 * `approvedAt` (CAS: the item exists) and pokes: the item skips only the
 * autonomy gate, G2..G6 still apply (decision 18). `all` answers in `approved`
 * only the items it approved now (one dispatched before keeps its approvedAt
 * and is not named again); one item is named even when it already was.
 * Descartar removes it.
 */
export function queueDecide(rt: TeamRuntime, actor: Actor, queueId: string, go: boolean, ctx: FlowCtx): FlowResult<{ approved: string[]; dropped: string[] }> {
  const targets = queueId === 'all' ? rt.queue : rt.queue.filter((q) => q.id === queueId)
  if (queueId !== 'all' && targets.length === 0) return { ok: false, error: 'not_found' }
  if (targets.length === 0) return { ok: true, rt, effects: [], result: { approved: [], dropped: [] } }
  if (go) {
    const fresh = new Set(targets.filter((q) => q.approvedAt === undefined).map((q) => q.id))
    const queue = fresh.size ? rt.queue.map((q) => (fresh.has(q.id) ? { ...q, approvedAt: ctx.now, approvedBy: actor } : q)) : rt.queue
    const effects: TeamEffect[] = [{ kind: 'dispatch' }]
    const approved = queueId === 'all' ? [...fresh] : targets.map((q) => q.id)
    return { ok: true, rt: queue === rt.queue ? rt : { ...rt, queue }, effects, result: { approved, dropped: [] } }
  }
  let out: TeamRuntime = { ...rt, queue: rt.queue.filter((q) => !targets.includes(q)) }
  for (const q of targets) out = consumeLevel(out, q, ctx)
  return { ok: true, rt: out, effects: [], result: { approved: [], dropped: targets.map((q) => q.id) } }
}
