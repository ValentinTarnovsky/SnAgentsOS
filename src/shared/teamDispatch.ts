// Adaptado de paperclipai/paperclip (MIT) - server/src/services/run-liveness.ts
// Also adapts server/src/services/issue-rewake-throttle.ts and server/src/services/issue-dependency-wakeups.ts.
/**
 * Teams dispatch (app 2.7.0, Tanda B, B4): who runs next, why a wanted run
 * waits, what a finished run did and what happens after it. Pure, no Node or
 * DOM, no clock reads: main's Dispatcher feeds it facts and commits what it
 * returns (design 2.9, 4.1).
 *
 * - candidatesOf: the levels (plan 3.7 candidates): one request per free
 *   agent, at most one per task.
 * - planDispatch: the gates in order (G1 team, G1b agent, autonomy, G2 caps,
 *   G3 quota, G4 cooldown, G5 session, G6 tree with the settle rule).
 * - classifyOutcome: what a finished run achieved (decision 68: reads and
 *   workspace setup alone are not progress).
 * - afterRunPolicy: the 4.1 table (continuations, cooldowns, retries,
 *   provider blocks, team pauses, fresh sessions, block cards).
 *
 * The shapes live in teams.ts (B1 declared them) and are re-exported here.
 */
import type { ClaudeAccountsState } from './claude-accounts'
import type {
  AgentState, CardAction, CardReason, DeferReason, Deferred, DispatchFacts, DispatchPlan, PolicyDecision, RunEndFacts,
  RunEvidence, RunMode, RunOutcome, RunRequest, TaskCounters, TaskPhase, TaskPriority, TeamDefinition, TeamRuntime, TeamTask,
  WakeMark, WakeReason,
} from './teams'
import {
  CONTINUATIONS_MAX, GLOBAL_MAX_RUNS, INTERRUPTS_MAX, LEAD_THREAD, LIMIT_FALLBACK_MS, NO_PROGRESS_BLOCK_AT, NO_PROGRESS_COOLDOWN_MIN,
  PRIORITY_RANK, RETRIES_MAX, RETRY_DELAY_MS, TEAM_MAX_CONCURRENT, UNBLOCK_WAKES_PER_HOUR, taskNumOf,
} from './teams'
import { effectiveProfile } from './teamArgv'

export type { Deferred, DispatchFacts, DispatchPlan, PolicyDecision, RunEndFacts, RunEvidence, RunRequest } from './teams'
export type { AgentState, DeferReason }

// ---- candidates (plan 3.7, design 2.9 L1..L5) ---------------------------------------------------

/** Reasons that count as high whatever the target's priority (compareRequests). */
const HIGH_REASONS: ReadonlySet<WakeReason> = new Set<WakeReason>(['userMessage', 'kickoff', 'leadApproval'])

/** The rank compareRequests orders by: the priority, with userMessage, kickoff and leadApproval at least high and routines low. */
function rankOf(r: Pick<RunRequest, 'priority' | 'reason'>): number {
  if (r.reason === 'routine') return PRIORITY_RANK.low
  const p = PRIORITY_RANK[r.priority] ?? PRIORITY_RANK.normal
  return HIGH_REASONS.has(r.reason) ? Math.min(p, PRIORITY_RANK.high) : p
}

function priorityOf(reason: WakeReason, base: TaskPriority): TaskPriority {
  if (reason === 'routine') return 'low'
  return HIGH_REASONS.has(reason) && PRIORITY_RANK[base] > PRIORITY_RANK.high ? 'high' : base
}

/** approved first, then PRIORITY_RANK (userMessage, kickoff, leadApproval count as high; routines as low), then since, agentId, taskId. */
export function compareRequests(a: RunRequest, b: RunRequest): number {
  if (a.approved !== b.approved) return a.approved ? -1 : 1
  return (
    rankOf(a) - rankOf(b) ||
    a.since - b.since ||
    (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) ||
    (a.taskId ? (taskNumOf(a.taskId) ?? 0) : -1) - (b.taskId ? (taskNumOf(b.taskId) ?? 0) : -1)
  )
}

/** A request plus what the gates read and the request does not carry. */
interface Candidate { req: RunRequest; agent: AgentState; task?: TeamTask; notBefore?: number }

function todoMode(t: Pick<TeamTask, 'needsPlan' | 'plan'>): RunMode {
  return t.needsPlan && t.plan?.status !== 'approved' ? 'plan' : 'exec'
}

/**
 * The run mode the task's (state, phase) lets `agentId` run (4.2), or null: the assignee runs todo (plan or exec),
 * planning (plan) and executing (exec); the task's QA agent runs qa. Every other phase waits on the user or the flow.
 * T3, defensive (B5 review): an executing task that needs a plan and has none approved (a needsPlan turned on after its
 * start) runs nothing, since admitRun refuses that exec run; as a candidate it would stand as its agent's minimum and
 * take a cap slot on every pass, so the agent's other levels would never run.
 */
function modeFor(t: TeamTask, agentId: string): RunMode | null {
  switch (t.state) {
    case 'todo':
      return t.assignee === agentId ? todoMode(t) : null
    case 'doing':
      if (t.assignee !== agentId) return null
      return t.phase === 'planning' ? 'plan' : t.phase === 'executing' && todoMode(t) === 'exec' ? 'exec' : null
    case 'review':
      return t.phase === 'qa' && t.review.qaAgentId === agentId ? 'qa' : null
    default:
      return null
  }
}

/** The agent a task's phase lets run (assignee, or the QA agent in qa), or undefined. */
function runnerOf(t: TeamTask): string | undefined {
  return t.state === 'review' ? (t.phase === 'qa' ? t.review.qaAgentId : undefined) : t.assignee
}

/** Queued comments (forAgent && !deliveredRunId) per `agentId|target`: count, oldest time, whether the user wrote one. */
interface QueuedInfo { count: number; oldest: number; user: boolean }

function queuedIndex(rt: TeamRuntime): Map<string, QueuedInfo> {
  const out = new Map<string, QueuedInfo>()
  for (const [target, list] of Object.entries(rt.comments)) {
    for (const c of list) {
      if (!c.forAgent || c.deliveredRunId) continue
      const key = `${c.forAgent}|${target}`
      const cur = out.get(key)
      const user = c.author.kind === 'user'
      if (cur) {
        cur.count++
        if (c.at < cur.oldest) cur.oldest = c.at
        if (user) cur.user = true
      } else out.set(key, { count: 1, oldest: c.at, user })
    }
  }
  return out
}

function request(agentId: string, mode: RunMode, sessionKey: string, reason: WakeReason, since: number, priority: TaskPriority, o: { taskId?: string; refs?: string[]; detail?: string; bypass?: boolean } = {}): RunRequest {
  const r: RunRequest = { agentId, sessionKey, mode, reason, since, priority: priorityOf(reason, priority), approved: false, bypassCooldown: !!o.bypass }
  if (o.taskId) r.taskId = o.taskId
  if (o.refs && o.refs.length) r.refs = [...o.refs]
  if (o.detail && o.detail.trim()) r.detail = o.detail
  return r
}

function fromMark(agent: AgentState, m: WakeMark, mode: RunMode, sessionKey: string, priority: TaskPriority, taskId?: string, bypass = false): Candidate {
  const c: Candidate = { req: request(agent.id, mode, sessionKey, m.reason, m.since, priority, { taskId, refs: m.refs, detail: m.detail, bypass: bypass || !!m.bypassCooldown }), agent }
  if (m.notBefore !== undefined) c.notBefore = m.notBefore
  return c
}

/**
 * The level of one task for the agent its phase lets run: L1 task.next when its agent and mode match the phase;
 * L2 a todo task without a matching next (plan when needsPlan and the plan is not approved, else exec; assigned);
 * L3 queued comments for that agent on the task (comment). A user comment waiting for the agent lifts the cooldown
 * (issue-rewake-throttle.ts: human comments bypass the no-progress throttle; agent comments do not).
 */
function taskLevel(t: TeamTask, agent: AgentState, queued: Map<string, QueuedInfo>): Candidate | null {
  const mode = modeFor(t, agent.id)
  if (!mode) return null
  const q = queued.get(`${agent.id}|${t.id}`)
  const userComment = !!q?.user
  if (t.next && t.next.agentId === agent.id && t.next.mode === mode) {
    const c = fromMark(agent, t.next, mode, t.id, t.priority, t.id, userComment)
    c.task = t
    return c
  }
  if (t.state === 'todo') return { req: request(agent.id, mode, t.id, 'assigned', t.createdAt, t.priority, { taskId: t.id, bypass: userComment }), agent, task: t }
  if (q) return { req: request(agent.id, mode, t.id, 'comment', q.oldest, t.priority, { taskId: t.id, bypass: userComment }), agent, task: t }
  return null
}

/**
 * The Lead's levels (L4), each a lead request on the 'lead' session: agent.next; the user's queued messages in the
 * Lead thread (userMessage); a goal it has not seen (kickoff, decision 43); pending plan approvals it decides and has
 * not seen (leadApproval); unassigned todo tasks without triagedAt (triage). A task a Lead created itself never asks
 * it to triage (issue-dependency-wakeups.ts self-block guard: a Lead that creates unassigned tasks would wake itself
 * forever; its own run already knew them).
 */
function leadLevels(rt: TeamRuntime, def: TeamDefinition, goalHash: string, agent: AgentState, queued: Map<string, QueuedInfo>, now: number): Candidate[] {
  const out: Candidate[] = []
  const key = LEAD_THREAD
  if (agent.next) out.push(fromMark(agent, agent.next, 'lead', key, 'normal'))
  const q = queued.get(`${agent.id}|${LEAD_THREAD}`)
  if (q) out.push({ req: request(agent.id, 'lead', key, 'userMessage', q.oldest, 'high', { bypass: q.user }), agent })
  if (def.goal.trim() !== '' && rt.goalSeenHash !== goalHash) out.push({ req: request(agent.id, 'lead', key, 'kickoff', now, 'high'), agent })
  const approvals = rt.approvals.filter((a) => a.kind === 'plan' && a.state === 'pending' && a.decider === 'lead' && !a.leadSeenRunId)
  if (approvals.length) {
    const since = Math.min(...approvals.map((a) => a.createdAt))
    out.push({ req: request(agent.id, 'lead', key, 'leadApproval', since, 'high', { refs: approvals.map((a) => a.id) }), agent })
  }
  let triageSince: number | null = null
  for (const t of rt.tasks) {
    if (t.state !== 'todo' || t.assignee || t.triagedAt !== undefined) continue
    if (t.createdBy.kind === 'agent' && t.createdBy.roleKind === 'lead') continue
    if (triageSince === null || t.createdAt < triageSince) triageSince = t.createdAt
  }
  if (triageSince !== null) out.push({ req: request(agent.id, 'lead', key, 'triage', triageSince, 'normal'), agent })
  return out
}

/**
 * A manual entry ("Ejecutar ahora", kickoff): the level of the named task, else the agent's best level (no prompt) or a
 * free / lead request. The best level is picked like the agent's candidate, so a level in `skip` (discarded) is not it:
 * the run is the one the roster says the agent waits for. A named task always runs, discarded or not. The request is
 * approved, bypasses the cooldown and carries `manual` (the user started it).
 */
function manualCandidate(rt: TeamRuntime, m: DispatchFacts['manual'][number], agent: AgentState, levels: readonly Candidate[], now: number, skip?: ReadonlySet<string>): Candidate | null {
  const lead = agent.roleKind === 'lead'
  let base: Candidate | null = null
  if (m.taskId) {
    const t = rt.tasks.find((x) => x.id === m.taskId)
    if (!t || rt.activeRuns.some((r) => r.taskId === t.id && r.agentId !== agent.id)) return null
    const mode = modeFor(t, agent.id)
    if (!mode) return null
    const level = levels.find((c) => c.req.taskId === t.id)
    base = { req: request(agent.id, mode, t.id, m.reason, now, t.priority, { taskId: t.id, refs: level?.req.refs }), agent, task: t }
  } else if (!lead && !(m.detail && m.detail.trim())) {
    // No prompt: "run now" runs what the agent would run next; with nothing pending it is a free run.
    const pending = skip && skip.size ? levels.filter((c) => !skipped(skip, c.req)) : levels
    const best = [...pending].sort((a, b) => compareRequests(a.req, b.req))[0]
    if (best) {
      const req: RunRequest = { ...best.req, reason: m.reason, since: now }
      if (best.req.refs) req.refs = [...best.req.refs]
      base = { req, agent, task: best.task }
    }
  }
  if (!base) {
    const mode: RunMode = lead ? 'lead' : 'free'
    base = { req: request(agent.id, mode, lead ? LEAD_THREAD : 'free', m.reason, now, 'high'), agent }
  }
  // The user's prompt replaces a level's detail; without one a level keeps its own (a routine wake's prompt). `manual`
  // marks the user's entry (2.7.0 runtime fixes): a kickoff the user asked for reads `trigger.by: 'user'`, the one a
  // goal change raised (the L4 level of the same reason) 'system'.
  base.req = { ...base.req, approved: true, bypassCooldown: true, manual: true }
  if (m.detail && m.detail.trim()) base.req.detail = m.detail
  return base
}

/**
 * What main adds to a pass beyond DispatchFacts. `skip`: the `agentId|sessionKey` levels the user discarded from "Por
 * despachar" and that did not change since (TeamService keeps them in memory while autonomy is off). They are left out
 * before each agent's minimum is picked, so the agent's next level becomes its candidate (and its queue item); a
 * manual entry is never left out (one that names no task runs the agent's best level among the ones kept). B close:
 * an entry `agentId|sessionKey|reason` leaves out only the level of that reason (the Lead's levels share one session
 * key, so one discarded Lead level never hides the others).
 */
export interface DispatchOptions { skip?: ReadonlySet<string> }

/** True when `skip` names the request's level: by `agentId|sessionKey`, or by `agentId|sessionKey|reason`. */
function skipped(skip: ReadonlySet<string>, r: Pick<RunRequest, 'agentId' | 'sessionKey' | 'reason'>): boolean {
  const key = `${r.agentId}|${r.sessionKey}`
  return skip.has(key) || skip.has(`${key}|${r.reason}`)
}

/** The candidates with what the gates need (candidatesOf drops the extra). */
function collect(rt: TeamRuntime, def: TeamDefinition, goalHash: string, facts: Pick<DispatchFacts, 'now' | 'manual'>, o: DispatchOptions = {}): Candidate[] {
  const roles = new Set(def.roles.map((r) => r.id))
  const queued = queuedIndex(rt)
  const busyTasks = new Set(rt.activeRuns.map((r) => r.taskId).filter((id): id is string => !!id))
  // One candidate per free agent: idle (or taken over, so G5 reports it), not retired, its role still defined.
  const free = (a: AgentState): boolean => (a.status === 'idle' || a.status === 'takenOver') && !a.runId && !a.retired && roles.has(a.roleId)
  const byAgent = new Map<string, Candidate[]>()
  const push = (c: Candidate): void => {
    const list = byAgent.get(c.agent.id)
    if (list) list.push(c)
    else byAgent.set(c.agent.id, [c])
  }
  const agents = new Map(rt.agents.map((a) => [a.id, a]))
  for (const t of rt.tasks) {
    if (busyTasks.has(t.id)) continue
    const who = runnerOf(t)
    const agent = who ? agents.get(who) : undefined
    if (!agent || !free(agent) || agent.roleKind === 'lead') continue
    const c = taskLevel(t, agent, queued)
    if (c) push(c)
  }
  for (const a of rt.agents) {
    if (!free(a)) continue
    if (a.roleKind === 'lead') for (const c of leadLevels(rt, def, goalHash, a, queued, facts.now)) push(c)
    else if (a.next && a.next.mode === 'free') push(fromMark(a, a.next, 'free', 'free', 'normal'))   // L5 (routine wake -> free)
  }
  // Manual entries replace the agent's levels; a busy agent's one still goes out so planDispatch reports running / stopping.
  const manual = new Map<string, Candidate>()
  for (const m of facts.manual) {
    const agent = agents.get(m.agentId)
    if (!agent || agent.retired || !roles.has(agent.roleId)) continue
    const c = manualCandidate(rt, m, agent, byAgent.get(agent.id) ?? [], facts.now, o.skip)
    if (!c) continue
    const cur = manual.get(agent.id)
    if (!cur || compareRequests(c.req, cur.req) < 0) manual.set(agent.id, c)
  }
  // Queue items (decision 18): the item of (agentId, sessionKey) names the request; approvedAt approves it.
  const items = new Map(rt.queue.map((q) => [`${q.agentId}|${q.sessionKey}`, q]))
  const skip = o.skip
  const best: Candidate[] = []
  for (const a of rt.agents) {
    const m = manual.get(a.id)
    const levels = byAgent.get(a.id) ?? []
    const list = m ? [m] : skip && skip.size ? levels.filter((c) => !skipped(skip, c.req)) : levels
    let min: Candidate | null = null
    for (const c of list) {
      const item = items.get(`${c.req.agentId}|${c.req.sessionKey}`)
      if (item) {
        c.req.queueItemId = item.id
        if (item.approvedAt !== undefined) c.req.approved = true
      }
      if (!min || compareRequests(c.req, min.req) < 0) min = c
    }
    if (min) best.push(min)
  }
  // A task yields at most one request (the phase names one agent, so this only guards a manual entry).
  const byTask = new Map<string, Candidate>()
  const out: Candidate[] = []
  for (const c of best) {
    const id = c.req.taskId
    if (!id) {
      out.push(c)
      continue
    }
    const cur = byTask.get(id)
    if (!cur || compareRequests(c.req, cur.req) < 0) byTask.set(id, c)
  }
  out.push(...byTask.values())
  return out.sort((a, b) => compareRequests(a.req, b.req))
}

/**
 * One candidate per free agent (status idle, !retired, role in def; paused agents still yield one so G1b reports it):
 * L1 task.next for the agent (task not done/cancelled/blocked; mode consistent with the phase);
 * L2 assignee of a todo task without next (plan when needsPlan && plan not approved, else exec; reason assigned);
 * L3 queued comments for the agent on a target whose phase lets it run (assignee: todo/planning/executing; QA: qa);
 * L4 lead only: agent.next; undelivered user comments in the lead thread (userMessage); goalSeenHash !== def goalHash
 *    (kickoff); pending plan approvals with decider lead and no leadSeenRunId (leadApproval); unassigned todo tasks
 *    without triagedAt (triage);
 * L5 agent.next of non-lead agents (routine wake -> free);
 * manual entries: the agent's best level or a free/lead request, approved and bypassCooldown.
 * A task yields at most one request; an agent its minimum by compareRequests. A task with an active run yields none; a
 * taken over agent yields its request (G5 reports `takenOver`); a manual entry of a running agent still yields its
 * request (planDispatch defers it `running` / `stopping`); a manual entry whose task cannot run for that agent in its
 * phase yields nothing; a manual entry without a prompt and without a task is the agent's best level, a free run when
 * it has none. A queue item of (agentId, sessionKey) sets queueItemId, and approved once the user approved it. A level
 * in `o.skip` (discarded, unchanged) is never an agent's minimum, nor the best level of its manual entry without a
 * task: its next level is.
 * Sorted by compareRequests.
 */
export function candidatesOf(rt: TeamRuntime, def: TeamDefinition, goalHash: string, facts: Pick<DispatchFacts, 'now' | 'manual'>, o: DispatchOptions = {}): RunRequest[] {
  return collect(rt, def, goalHash, facts, o).map((c) => c.req)
}

// ---- gates (plan 3.7, design 2.9 G1..G6) --------------------------------------------------------

const TASK_MODES: ReadonlySet<RunMode> = new Set<RunMode>(['plan', 'exec', 'qa'])

/**
 * Gates in order, first failure defers:
 * G1 team: !enabled disabled, !trusted untrusted, !cliReady cliOff, rt.paused paused (nothing enqueued);
 * (a manual entry of a running agent: running, or stopping while its run stops);
 * G1b agent.paused agentPaused;
 * (decision 18) autonomy off and !approved: push to enqueue when no queue item exists for (agentId, sessionKey), keep
 *    evaluating G2..G6 only to report the reason, never start;
 * G2 cap: team active + started in pass >= min(def.maxConcurrent, 3) teamCap; global >= GLOBAL_MAX_RUNS globalCap
 *    (queued and stopping runs count; no until: a run end wakes it);
 * G3 quota: providerBlockedUntil[provider] > now, or Claude and claudeBlockedUntil > now -> quota until it;
 * G4 cooldown (skipped with bypassCooldown): task.cooldownUntil or next.notBefore > now -> cooldown until max;
 * G5 session: agent.sessions[key].sessionId in busySessions sessionBusy; agent takenOver takenOver;
 * G6 tree (settle rule, decision 36): a run that writes (effective profile not readonly): cwdKeys[key] in writerCwds
 *    -> treeBusy, else in busyCwds (only a console of the user works there) -> consoleBusy; a readonly task-keyed run
 *    (mode plan, exec or qa): in writerCwds -> treeBusy; a readonly lead or free run: only in integrateCwds -> treeBusy
 *    (a Dev's main-isolation lock never holds the Lead);
 * start: push to start, count it, add its cwd to a pass-local writer set when it writes.
 * The candidates are candidatesOf's with the same `o` (a discarded level left out before the agent's minimum).
 * Pure, total, no clock reads, O(agents + tasks + comments).
 */
export function planDispatch(rt: TeamRuntime, def: TeamDefinition, goalHash: string, facts: DispatchFacts, o: DispatchOptions = {}): DispatchPlan {
  const plan: DispatchPlan = { start: [], enqueue: [], deferred: [], nextAt: null }
  const cands = collect(rt, def, goalHash, facts, o)
  const now = facts.now
  const team: DeferReason | null = !facts.enabled ? 'disabled' : !facts.trusted ? 'untrusted' : !facts.cliReady ? 'cliOff' : rt.paused ? 'paused' : null
  const cap = Math.min(def.maxConcurrent, TEAM_MAX_CONCURRENT)
  let teamActive = rt.activeRuns.length
  let globalActive = facts.globalActive
  const passWriters = new Set<string>()
  const roles = new Map(def.roles.map((r) => [r.id, r]))
  const defer = (request: RunRequest, reason: DeferReason, until?: number): void => {
    const d: Deferred = { request, reason }
    if (until !== undefined) {
      d.until = until
      if (plan.nextAt === null || until < plan.nextAt) plan.nextAt = until
    }
    plan.deferred.push(d)
  }
  /** G2..G6 for one request: the first failure, or null. */
  const gates = (c: Candidate): { reason: DeferReason; until?: number } | null => {
    const { req, agent, task } = c
    if (teamActive >= cap) return { reason: 'teamCap' }
    if (globalActive >= GLOBAL_MAX_RUNS) return { reason: 'globalCap' }
    const blocked = rt.providerBlockedUntil[agent.provider]
    const claude = agent.provider === 'claude' && facts.claudeBlockedUntil !== null && facts.claudeBlockedUntil > now ? facts.claudeBlockedUntil : null
    if ((blocked !== undefined && blocked > now) || claude !== null) return { reason: 'quota', until: Math.max(blocked !== undefined && blocked > now ? blocked : 0, claude ?? 0) }
    if (!req.bypassCooldown) {
      let until = 0
      if (task?.cooldownUntil !== undefined && task.cooldownUntil > now) until = task.cooldownUntil
      if (c.notBefore !== undefined && c.notBefore > now && c.notBefore > until) until = c.notBefore
      if (until > 0) return { reason: 'cooldown', until }
    }
    const sess = agent.sessions[req.sessionKey]
    if (sess && facts.busySessions.has(sess.sessionId)) return { reason: 'sessionBusy' }
    if (agent.status === 'takenOver' || agent.takeover) return { reason: 'takenOver' }
    const key = facts.cwdKeys[req.sessionKey]
    if (key !== undefined) {
      const role = roles.get(agent.roleId)
      const writes = !!role && effectiveProfile(role.permission, req.mode) !== 'readonly'
      const writerHeld = facts.writerCwds.has(key) || facts.integrateCwds.has(key) || passWriters.has(key)
      if (writes || TASK_MODES.has(req.mode) ? writerHeld : facts.integrateCwds.has(key)) return { reason: 'treeBusy' }
      // Only a console of the user works there: its own reason, so the row names the console, not a run that does not exist.
      if (writes && facts.busyCwds.has(key)) return { reason: 'consoleBusy' }
    }
    return null
  }
  for (const c of cands) {
    const { req, agent } = c
    if (team) {
      defer(req, team)
      continue
    }
    if (agent.runId || agent.status === 'running') {
      const cur = rt.activeRuns.find((r) => r.id === agent.runId)
      defer(req, cur?.state === 'stopping' ? 'stopping' : 'running')
      continue
    }
    if (agent.paused) {
      defer(req, 'agentPaused')
      continue
    }
    const held = !rt.autoDispatch && !req.approved
    if (held && !req.queueItemId) plan.enqueue.push(req)
    const g = gates(c)
    if (g) {
      defer(req, g.reason, g.until)
      continue
    }
    if (held) {
      defer(req, 'autonomyOff')
      continue
    }
    plan.start.push(req)
    teamActive++
    globalActive++
    const role = roles.get(agent.roleId)
    const key = facts.cwdKeys[req.sessionKey]
    if (key !== undefined && role && effectiveProfile(role.permission, req.mode) !== 'readonly') passWriters.add(key)
  }
  return plan
}

// ---- unblock (issue-dependency-wakeups.ts, T16) -------------------------------------------------

/**
 * Level-triggered unblock: every blocker done (live or archived) -> ready; a cancelled blocker never satisfies (card
 * depCancelled) and wins over a waiting one; an unknown id waits. A done or cancelled task is never ready.
 */
export function unblockReady(task: Pick<TeamTask, 'state' | 'blockedBy'>, byId: ReadonlyMap<string, Pick<TeamTask, 'state'>>, archived: Readonly<Record<string, 'done' | 'cancelled'>>): 'ready' | 'waiting' | 'cancelledBlocker' {
  let waiting = task.state === 'done' || task.state === 'cancelled'
  for (const id of task.blockedBy) {
    const s = byId.get(id)?.state ?? archived[id]
    if (s === 'cancelled') return 'cancelledBlocker'
    if (s !== 'done') waiting = true
  }
  return waiting ? 'waiting' : 'ready'
}

const HOUR_MS = 60 * 60_000

/**
 * T16 throttle: at most UNBLOCK_WAKES_PER_HOUR unblock wakes per task in an hour window that opens at the first wake
 * (a window older than an hour starts again at `now`). `counters` is what the task stores after an allowed wake; a
 * refused one leaves the task as it is (reconcileTasks raises the `unblockLimit` card once).
 */
export function unblockWake(c: Pick<TaskCounters, 'unblockWakes' | 'unblockWindowStart'>, now: number): { ok: boolean; counters: Pick<TaskCounters, 'unblockWakes' | 'unblockWindowStart'> } {
  const fresh = !(c.unblockWindowStart > 0) || now - c.unblockWindowStart >= HOUR_MS || now < c.unblockWindowStart
  const wakes = fresh ? 0 : c.unblockWakes
  const start = fresh ? now : c.unblockWindowStart
  if (wakes >= UNBLOCK_WAKES_PER_HOUR) return { ok: false, counters: { unblockWakes: wakes, unblockWindowStart: start } }
  return { ok: true, counters: { unblockWakes: wakes + 1, unblockWindowStart: start } }
}

// ---- quota ---------------------------------------------------------------------------------------

/**
 * blocked === 'allExhausted', or every account's 5h or 7d percent >= 100 with resetsAt ahead (blocked is only set with
 * autoSwitch and >= 2 accounts). No accounts: false. `until`: the earliest time an account is back (each account
 * waits for the latest reset of its windows at the limit); absent when no reset ahead is known.
 */
export function claudeAllLimited(state: ClaudeAccountsState | null, now: number): { limited: boolean; until?: number } {
  if (!state || state.accounts.length === 0) return { limited: false }
  let every = true
  let until: number | null = null
  for (const a of state.accounts) {
    let back: number | null = null
    for (const w of [a.usage.fiveHour, a.usage.sevenDay]) {
      if (w.percent === null || w.percent < 100 || !w.resetsAt) continue
      const t = Date.parse(w.resetsAt)
      if (!Number.isFinite(t) || t <= now) continue
      back = back === null ? t : Math.max(back, t)
    }
    if (back === null) every = false
    else if (until === null || back < until) until = back
  }
  if (!every && state.blocked !== 'allExhausted') return { limited: false }
  return until === null ? { limited: true } : { limited: true, until }
}

// ---- outcome (run-liveness.ts, decision 68) -----------------------------------------------------

/** run-liveness.ts:66-67 verbatim: a final text that only announces work. */
export const PLANNING_ONLY_RE =
  /\b(?:i(?:'ll| will| am going to|'m going to)|let me|i need to|next(?:,| i will| i'll)?|my next step is|the next step is)\s+(?:first\s+)?(?:inspect|check|review|look|investigate|analy[sz]e|open|read|start|begin|work on|implement|fix|test|update|create|add)\b/i
/** run-liveness.ts NEXT_STEPS_RE: a "Next steps:" or "Plan:" heading. */
export const PLAN_HEADING_RE = /^\s*(?:next steps?|plan)\s*:/im

/**
 * Decision 68 (paperclip run-liveness: workspace setup or reads alone are not evidence):
 * cancelled | takenOver | interrupted -> undefined; concluded -> 'concluded' (also when failed afterwards); failed ->
 * 'failed'; maxTurns -> 'progress'; teamWrites > 0, fileEdits > 0 or treeMoved -> 'progress'; mode plan|qa or roleKind
 * research with digest.tools > 0 (reads are the work there) -> 'progress'; the `run` family alone (a shell that read files
 * or ran git status or tests) is NOT progress in exec mode; PLANNING_ONLY_RE or PLAN_HEADING_RE on the final text ->
 * 'planOnly'; else 'empty'. A run still active has no outcome either.
 */
export function classifyOutcome(e: RunEvidence): RunOutcome | undefined {
  if (e.state !== 'succeeded' && e.state !== 'failed') return undefined
  if (e.concluded) return 'concluded'
  if (e.state === 'failed' || (e.isError && !e.maxTurns)) return 'failed'
  if (e.maxTurns) return 'progress'
  if (e.teamWrites > 0 || e.fileEdits > 0 || e.treeMoved === true) return 'progress'
  if ((e.mode === 'plan' || e.mode === 'qa' || e.roleKind === 'research') && (e.digest?.tools ?? 0) > 0) return 'progress'
  const text = e.finalText ?? ''
  if (PLANNING_ONLY_RE.test(text) || PLAN_HEADING_RE.test(text)) return 'planOnly'
  return 'empty'
}

// ---- after a run (4.1 policy table) -------------------------------------------------------------

/** The phase a task-keyed mode runs in (I3). */
const MODE_PHASE: Readonly<Partial<Record<RunMode, TaskPhase>>> = { plan: 'planning', exec: 'executing', qa: 'qa' }
/** Actions of a card that blocks a task after a run: run it again, send it back to todo, or cancel it. */
const BLOCK_ACTIONS: readonly CardAction[] = ['retry', 'toTodo', 'cancelTask']

/** The wake of the same agent, mode and session key (the caller stores it in task.next, or agent.next without a task). */
function sameAs(run: RunEndFacts['run'], reason: WakeReason, now: number, notBefore?: number): WakeMark {
  const m: WakeMark = { agentId: run.agentId, mode: run.mode, reason, since: now }
  if (notBefore !== undefined) m.notBefore = notBefore
  return m
}

function blockCard(why: CardReason): NonNullable<PolicyDecision['block']> {
  // applyPolicy fills the card id it opens.
  return { reason: { kind: 'card', cardId: '', why }, card: { why, actions: [...BLOCK_ACTIONS] } }
}

/**
 * Section 4.1 policy table, first matching row (S = same agent, mode and session key; `next` goes to task.next for a
 * task run, agent.next otherwise). Concluded runs skip every task follow-up but still apply the provider rows, and a
 * task follow-up needs the task still in the run's phase (not done, cancelled or blocked), else only the provider rows
 * apply. Requests and rows beyond the table:
 * - stopReason 'user' whatever the end state (a run stopped just before it exited on its own ends succeeded or failed
 *   from its result): never re-woken (no continuation, no retry, no undeliver); a task run still in its phase blocks
 *   {stopped} (decision 38); a limit or auth failure still blocks the provider or pauses the team.
 * - A second context failure in a row (the run was already a `context` wake) falls to the request row like a second
 *   unknown session: the fresh session itself overflowed.
 * - Task-less runs have no task counters: their retry is one shot (a `retry` wake does not retry again), their
 *   interruption streak is `agentInterrupts` (< INTERRUPTS_MAX re-wakes), reset to 0 by a run that ends otherwise.
 * - Any failed or interrupted run that never reached `running` and that the user did not stop hands back what it was
 *   given (`undeliver`, 4.5).
 * - 2.7.0 runtime fixes: a task run that ended succeeded or failed without concluding and whose denials left a
 *   permission approval of its task and role pending (`permissionWait`) waits on the user: only the provider rows (and
 *   a fresh session for an unknown or full one) apply, never a continuation, a retry, a count or a block (qaNoVerdict,
 *   noProgress, failure, timeout). A user stop, a cancel, a takeover and an interruption keep their own rows.
 */
export function afterRunPolicy(f: RunEndFacts): PolicyDecision {
  const run = f.run
  const out: PolicyDecision = {}
  const now = f.now
  const task = run.taskId ? f.task : undefined
  const taskRun = run.taskId !== undefined
  const concluded = !!run.concludedBy || run.outcome === 'concluded'
  const inPhase = !!task && task.state !== 'done' && task.state !== 'cancelled' && task.state !== 'blocked' && task.phase === MODE_PHASE[run.mode]
  /** A follow-up may wake the run's agent again: the run did not conclude and, for a task run, its task is still in the phase. */
  const live = !concluded && (!taskRun || inPhase)
  const counters = task?.counters
  // A failed run that carries no failure is an unknown one (the request row).
  const failure = run.state === 'failed' ? (run.failure ?? { kind: 'unknown' as const }) : undefined
  const userStop = run.stopReason === 'user'

  if ((run.state === 'failed' || run.state === 'interrupted') && !run.reachedRunning && !userStop) out.undeliver = true
  if (concluded && counters && (counters.noProgress || counters.continuations || counters.retries || counters.interrupts)) {
    out.counters = { noProgress: 0, continuations: 0, retries: 0, interrupts: 0 }
  }
  // The task-less interruption streak breaks on any end of a run that ran and was not interrupted.
  if (!taskRun && run.reachedRunning && run.state !== 'interrupted' && f.agentInterrupts > 0) out.agentInterrupts = 0

  // Provider facts hold whatever the run did next: a limit blocks the provider, an auth or billing failure pauses the team.
  let limitUntil: number | undefined
  let switched = false
  if (failure && (failure.kind === 'limit' || failure.kind === 'rateLimited')) {
    limitUntil = f.claudeCanSwitch && run.provider === 'claude' ? now + LIMIT_FALLBACK_MS : failure.until ?? now + LIMIT_FALLBACK_MS
    out.providerBlock = { provider: run.provider, until: limitUntil }
  } else if (failure && failure.kind === 'auth') {
    // Decision 40: AccountService switched accounts while the run ran, so the failure was the old login's: a retry.
    const end = run.endedAt ?? now
    switched = f.claudeSwitchedAt !== undefined && run.provider === 'claude' && run.startedAt !== undefined && f.claudeSwitchedAt >= run.startedAt && f.claudeSwitchedAt <= end
    if (!switched) out.pauseTeam = 'auth'
  } else if (failure && failure.kind === 'billing') out.pauseTeam = 'billing'

  // Row: cancelled by the user (and any user stop, requirement of B4) -> blocked {stopped}, next cleared. No card
  // (decision 38): the user just stopped it, so nothing asks for them in Te necesita; the drawer resumes it.
  if (userStop) {
    if (taskRun && inPhase && !concluded) {
      out.next = null
      out.block = { reason: { kind: 'stopped', runId: run.id } }
    }
    return out
  }
  // Row: cancelled (taskMoved, deleted, paused), takenOver -> nothing.
  if (run.state === 'cancelled' || run.state === 'takenOver') return out

  if (run.state === 'interrupted') {
    const cause = run.interruptCause
    if (cause === 'labsOff' || cause === 'cliOff' || cause === 'sessionConflict') {
      // Not counted; the gates hold it until the cause clears (the sessionConflict card is TeamService's, at the stop).
      if (live) out.next = sameAs(run, 'interrupted', now)
      return out
    }
    // shutdown / crash
    if (taskRun) {
      if (!live || !counters) return out
      if (run.trigger.reason !== 'continuation' && counters.interrupts < INTERRUPTS_MAX) {
        out.next = sameAs(run, 'interrupted', now)
        out.counters = { ...out.counters, interrupts: counters.interrupts + 1 }
      } else out.block = blockCard('interrupted')
      return out
    }
    if (live && f.agentInterrupts < INTERRUPTS_MAX) {
      out.next = sameAs(run, 'interrupted', now)
      out.agentInterrupts = f.agentInterrupts + 1
    }
    return out
  }

  // Row (2.7.0 runtime fixes, orchestrator decision): the run's denials left a permission approval of its task and role
  // pending, so the task waits on the user's decision, which wakes the phase agent (approve: `grant`, reject: `answer`,
  // flow/approvals.ts): no continuation, no retry, no count and no block. The provider rows above still hold, and a
  // session that is gone or full still starts fresh for the run the decision wakes.
  if (f.permissionWait && taskRun && !concluded) {
    if (f.unknownSession || failure?.kind === 'context') out.freshSession = true
    return out
  }

  // Row: an unknown session (one shot) -> a fresh session with the handoff (decision 66).
  let fallToRequest = false
  if (f.unknownSession) {
    out.freshSession = true
    if (run.trigger.reason !== 'context') {
      if (live) out.next = sameAs(run, 'context', now)
      return out
    }
    fallToRequest = true
  }

  if (failure && !fallToRequest) {
    if (limitUntil !== undefined) {
      if (live) out.next = sameAs(run, 'retry', now, limitUntil)
      return out
    }
    if (failure.kind === 'auth' && switched) {
      if (live) {
        out.next = sameAs(run, 'retry', now)
        if (counters) out.counters = { ...out.counters, retries: counters.retries + 1 }
      }
      return out
    }
    if (failure.kind === 'auth' || failure.kind === 'billing') {
      if (live) out.next = sameAs(run, 'retry', now)   // runs after the user resumes the team
      return out
    }
    if (failure.kind === 'context') {
      out.freshSession = true
      if (run.trigger.reason !== 'context') {
        if (live) out.next = sameAs(run, 'context', now)
        return out
      }
      fallToRequest = true
    }
  }

  if (failure || fallToRequest) {
    // overloaded / request / unknown (and the second context or unknown session).
    if (!live) return out
    if (failure?.code === 'timeout') {
      if (taskRun) out.block = blockCard('timeout')
      return out
    }
    const retries = counters ? counters.retries : run.trigger.reason === 'retry' ? RETRIES_MAX : 0
    if (retries < RETRIES_MAX) {
      out.next = sameAs(run, 'retry', now, now + RETRY_DELAY_MS)
      if (counters) out.counters = { ...out.counters, retries: counters.retries + 1 }
    } else if (taskRun) out.block = blockCard('failure')
    return out
  }

  // Row: concluded -> the counters reset above; the terminal tool already moved the task.
  if (concluded) return out
  // Row: lead or free, not concluded -> nothing (a lead may answer in text; its reply is in the thread).
  if (!taskRun || run.mode === 'lead' || run.mode === 'free') return out
  // Row: task gone, done, cancelled or out of the run's phase -> only the provider rows.
  if (!live || !counters) return out

  if (run.mode === 'qa') {
    if (counters.continuations < 1) {
      out.next = sameAs(run, 'continuation', now)
      out.counters = { ...out.counters, continuations: counters.continuations + 1 }
    } else out.block = blockCard('qaNoVerdict')
    return out
  }
  if (run.outcome === 'progress') {
    if (counters.continuations < CONTINUATIONS_MAX) {
      out.next = sameAs(run, 'continuation', now)
      out.counters = { ...out.counters, continuations: counters.continuations + 1, noProgress: 0 }
    } else out.block = blockCard('noProgress')
    return out
  }
  if (run.outcome === 'planOnly' || run.outcome === 'empty') {
    const n = counters.noProgress + 1
    if (n < NO_PROGRESS_BLOCK_AT) {
      const min = NO_PROGRESS_COOLDOWN_MIN[Math.min(n - 1, NO_PROGRESS_COOLDOWN_MIN.length - 1)] ?? 5
      const until = now + min * 60_000
      out.cooldownUntil = until
      out.next = sameAs(run, 'continuation', now, until)
      out.counters = { ...out.counters, noProgress: n }
    } else out.block = blockCard('noProgress')
    return out
  }
  return out
}
