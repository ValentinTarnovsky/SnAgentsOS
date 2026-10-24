/**
 * The runtime invariants I1..I22 of design 4.6 (app 2.7.0, E10 B). Checked
 * after every commit in tests (thrown) and at load in production (logged).
 * Pure. Each later flow file keeps its own rule here as it lands; a rule that
 * needs data the runtime does not hold (the runs ring, the previous runtime)
 * reads it from `o` and is skipped without it.
 */
import {
  APPROVAL_ID_RE,
  CARD_ID_RE,
  COMMENT_ID_RE,
  LEAD_THREAD,
  QUEUE_ID_RE,
  RUN_ACTIVE,
  TASK_COMMENTS_MAX,
  TASK_FIELDS,
  TEAM_MAX_CONCURRENT,
  taskNumOf,
  teamWorktreeOwner,
  type Run,
  type TaskPhase,
  type TaskState,
  type TeamRuntime,
  type TeamTask,
  type TrustedDefinition,
} from '@shared/teams'

/** Legal (state, phase) pairs (I6); blocked keeps the phase of the pair it resumes to. */
const LEGAL: Readonly<Record<Exclude<TaskState, 'blocked'>, readonly TaskPhase[]>> = {
  todo: ['none'],
  doing: ['planning', 'planApproval', 'executing'],
  review: ['qa', 'userOk', 'integrating'],
  done: ['none'],
  cancelled: ['none'],
}

export function legalPair(state: TaskState, phase: TaskPhase): boolean {
  return state !== 'blocked' && LEGAL[state].includes(phase)
}

/** The phase a task-keyed run mode requires (I3). */
const MODE_PHASE: Readonly<Partial<Record<Run['mode'], TaskPhase>>> = { plan: 'planning', exec: 'executing', qa: 'qa' }

function idNum(id: string, re: RegExp): number | null {
  if (!re.test(id)) return null
  return Number(id.slice(id.indexOf('-') + 1))
}

/** True when `blockedBy` edges of the live tasks contain a cycle (I17). */
function hasCycle(tasks: readonly TeamTask[]): boolean {
  const edges = new Map(tasks.map((t) => [t.id, t.blockedBy]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    const s = state.get(id)
    if (s === 1) return true
    if (s === 2) return false
    state.set(id, 1)
    for (const b of edges.get(id) ?? []) if (edges.has(b) && visit(b)) return true
    state.set(id, 2)
    return false
  }
  return tasks.some((t) => visit(t.id))
}

/**
 * Every violated invariant as one line (`I<n>: what`), [] when I1..I22 hold.
 * `def` null (untrusted, missing) skips the rules that read the definition.
 * `o.recent`: the runs ring (I1 id uniqueness, I19 admissions); `o.prev`: the
 * runtime before the commit (I15).
 */
export function assertInvariants(rt: TeamRuntime, def: TrustedDefinition | null, o: { recent?: readonly Run[]; prev?: TeamRuntime } = {}): string[] {
  const out: string[] = []
  const bad = (rule: string, what: string): void => {
    out.push(`${rule}: ${what}`)
  }
  const agents = new Map(rt.agents.map((a) => [a.id, a]))
  const tasks = new Map(rt.tasks.map((t) => [t.id, t]))

  // I1 activeRuns holds active runs only; ids unique there and against the ring.
  const runIds = new Set<string>()
  for (const r of rt.activeRuns) {
    if (!RUN_ACTIVE.includes(r.state)) bad('I1', `${r.id} is ${r.state} in activeRuns`)
    if (runIds.has(r.id)) bad('I1', `${r.id} twice in activeRuns`)
    runIds.add(r.id)
  }
  for (const r of o.recent ?? []) if (runIds.has(r.id)) bad('I1', `${r.id} active and in the ring`)

  // I2 running <=> runId <=> exactly one active run of that agent.
  for (const a of rt.agents) {
    const mine = rt.activeRuns.filter((r) => r.agentId === a.id)
    const running = a.status === 'running'
    if (running !== (a.runId !== undefined)) bad('I2', `${a.id} status ${a.status} with runId ${a.runId ?? 'none'}`)
    if (running && (mine.length !== 1 || mine[0].id !== a.runId)) bad('I2', `${a.id} running with ${mine.length} active runs`)
    if (!running && mine.length > 0) bad('I2', `${a.id} ${a.status} with an active run`)
  }
  for (const r of rt.activeRuns) if (!agents.has(r.agentId)) bad('I2', `${r.id} of unknown agent ${r.agentId}`)

  // I3 one active run per task; its mode matches the phase (a stopping run may outlive a user move).
  const perTask = new Map<string, number>()
  for (const r of rt.activeRuns) {
    if (!r.taskId) continue
    perTask.set(r.taskId, (perTask.get(r.taskId) ?? 0) + 1)
    const t = tasks.get(r.taskId)
    const want = MODE_PHASE[r.mode]
    if (t && want && r.state !== 'stopping' && t.phase !== want) bad('I3', `${r.id} mode ${r.mode} on ${t.id} phase ${t.phase}`)
  }
  for (const [id, n] of perTask) if (n > 1) bad('I3', `${id} has ${n} active runs`)

  // I4 takenOver <=> a bound-side takeover; stopping implies a running agent whose run stops for a takeover.
  for (const a of rt.agents) {
    const phase = a.takeover?.phase
    const held = phase === 'bindPending' || phase === 'bound' || phase === 'releasing'
    if ((a.status === 'takenOver') !== held) bad('I4', `${a.id} status ${a.status} with takeover ${phase ?? 'none'}`)
    if (phase === 'stopping') {
      const run = rt.activeRuns.find((r) => r.id === a.runId)
      if (a.status !== 'running' || !run || run.state !== 'stopping' || run.stopReason !== 'takeover') bad('I4', `${a.id} takeover stopping without its run stopping`)
    }
  }

  // I5 a session belongs to one agent; no active run shares a held takeover's session.
  const owner = new Map<string, string>()
  for (const a of rt.agents) {
    for (const s of Object.values(a.sessions)) {
      const other = owner.get(s.sessionId)
      if (other !== undefined && other !== a.id) bad('I5', `session ${s.sessionId} in ${other} and ${a.id}`)
      owner.set(s.sessionId, a.id)
    }
  }
  const heldSessions = new Set<string>()
  for (const a of rt.agents) if (a.takeover && a.takeover.phase !== 'stopping') heldSessions.add(a.takeover.sessionId)
  for (const r of rt.activeRuns) if (r.sessionId && heldSessions.has(r.sessionId)) bad('I5', `${r.id} runs a taken-over session`)

  const archived = rt.archivedTasks
  for (const t of rt.tasks) {
    // I6 legal pairs; I7 blocked <=> task.blocked.
    if (t.state === 'blocked') {
      if (!t.blocked) bad('I7', `${t.id} blocked without a reason`)
      else if (!legalPair(t.blocked.resume.state, t.blocked.resume.phase)) bad('I6', `${t.id} resumes to ${t.blocked.resume.state}/${t.blocked.resume.phase}`)
      else if (t.blocked.resume.phase !== t.phase) bad('I6', `${t.id} blocked in phase ${t.phase}, resumes to ${t.blocked.resume.phase}`)
    } else {
      if (t.blocked) bad('I7', `${t.id} ${t.state} with a blocked reason`)
      if (!legalPair(t.state, t.phase)) bad('I6', `${t.id} ${t.state}/${t.phase}`)
    }

    // I8 plan pending <=> planApproval <=> one pending plan approval for that rev.
    const pendingPlans = rt.approvals.filter((a) => a.kind === 'plan' && a.taskId === t.id && a.state === 'pending')
    const inApproval = t.phase === 'planApproval'
    if ((t.plan?.status === 'pending') !== inApproval) bad('I8', `${t.id} plan ${t.plan?.status ?? 'none'} in phase ${t.phase}`)
    if (inApproval && (pendingPlans.length !== 1 || (pendingPlans[0].kind === 'plan' && pendingPlans[0].payload.planRev !== t.plan?.rev))) bad('I8', `${t.id} has ${pendingPlans.length} pending plan approvals`)
    if (!inApproval && pendingPlans.length > 0) bad('I8', `${t.id} pending plan approval outside planApproval`)

    // I9 userOk <=> a pending final; integrating => an approved final and a worktree.
    const finals = rt.approvals.filter((a) => a.kind === 'final' && a.taskId === t.id)
    const pendingFinal = finals.filter((a) => a.state === 'pending').length
    if ((t.phase === 'userOk') !== (pendingFinal === 1)) bad('I9', `${t.id} phase ${t.phase} with ${pendingFinal} pending finals`)
    if (t.phase === 'integrating' && (!finals.some((a) => a.state === 'approved') || !t.worktree)) bad('I9', `${t.id} integrating without an approved final and a worktree`)

    // I10 qa names an existing QA agent; I11 round <= max.
    if (t.phase === 'qa') {
      const qa = t.review.qaAgentId ? agents.get(t.review.qaAgentId) : undefined
      if (!qa || qa.roleKind !== 'qa') bad('I10', `${t.id} in qa without a QA agent`)
    }
    if (t.review.round > t.review.max) bad('I11', `${t.id} round ${t.review.round} > ${t.review.max}`)

    // I16 userOwned is a set of TaskField.
    if (new Set(t.userOwned).size !== t.userOwned.length || t.userOwned.some((f) => !TASK_FIELDS.includes(f))) bad('I16', `${t.id} userOwned ${t.userOwned.join(',')}`)

    // I17 blockers: no self, each live or archived (acyclic below).
    for (const b of t.blockedBy) {
      if (b === t.id) bad('I17', `${t.id} blocks itself`)
      else if (!tasks.has(b) && !(b in archived)) bad('I17', `${t.id} blocked by unknown ${b}`)
    }

    // I19 frozen once admitted or with a worktree; a writing assignee that started in worktree isolation has one.
    const admitted = rt.activeRuns.some((r) => r.taskId === t.id) || (o.recent ?? []).some((r) => r.taskId === t.id)
    if ((admitted || t.worktree) && !t.frozen) bad('I19', `${t.id} not frozen after admission`)
    if (def && t.isolation === 'worktree' && t.assignee && !t.worktree) {
      const role = def.def.roles.find((r) => r.id === agents.get(t.assignee as string)?.roleId)
      const writes = role?.permission === 'total' || role?.permission === 'custom'
      const started = rt.activeRuns.some((r) => r.taskId === t.id && r.agentId === t.assignee && r.state !== 'queued')
      if (writes && started) bad('I19', `${t.id} started without its worktree`)
    }

    // I20 task-keyed sessions run in the task's worktree; I21 its owner is this team's.
    if (t.worktree) {
      for (const a of rt.agents) {
        const s = a.sessions[t.id]
        if (s && s.cwd !== t.worktree.path) bad('I20', `${a.id} session of ${t.id} in another cwd`)
      }
      if (t.worktree.owner !== teamWorktreeOwner(rt.teamId, rt.gen, t.id)) bad('I21', `${t.id} worktree owner ${t.worktree.owner}`)
    }
  }
  if (hasCycle(rt.tasks)) bad('I17', 'blockedBy has a cycle')

  // I12 comments per target and their recipient; I22 text xor sys.
  for (const [target, list] of Object.entries(rt.comments)) {
    if (target !== LEAD_THREAD && !tasks.has(target)) bad('I12', `comments of unknown target ${target}`)
    if (list.length > TASK_COMMENTS_MAX) bad('I12', `${target} has ${list.length} comments`)
    for (const c of list) {
      if (c.target !== target) bad('I12', `${c.id} filed under ${target}`)
      // Reading of "every undelivered comment has forAgent": a delivered comment had a recipient.
      if (c.deliveredRunId && !c.forAgent) bad('I12', `${c.id} delivered without a recipient`)
      if ((c.text !== '') === (c.sys !== undefined)) bad('I22', `${c.id} needs exactly one of text or sys`)
    }
  }

  // I13 queue keys unique, agents exist.
  const keys = new Set<string>()
  for (const q of rt.queue) {
    const key = `${q.agentId}\0${q.sessionKey}`
    if (keys.has(key)) bad('I13', `queue key ${q.agentId}/${q.sessionKey} twice`)
    keys.add(key)
    if (!agents.has(q.agentId)) bad('I13', `${q.id} of unknown agent ${q.agentId}`)
  }

  // I14 every id below its counter.
  const below = (id: string, num: number | null, counter: number, rule = 'I14'): void => {
    if (num === null || num >= counter) bad(rule, `${id} not below its counter ${counter}`)
  }
  for (const t of rt.tasks) below(t.id, taskNumOf(t.id), rt.nextIds.task)
  for (const id of Object.keys(archived)) below(id, taskNumOf(id), rt.nextIds.task)
  for (const list of Object.values(rt.comments)) for (const c of list) below(c.id, idNum(c.id, COMMENT_ID_RE), rt.nextIds.comment)
  for (const a of rt.approvals) below(a.id, idNum(a.id, APPROVAL_ID_RE), rt.nextIds.approval)
  for (const c of rt.cards) below(c.id, idNum(c.id, CARD_ID_RE), rt.nextIds.card)
  for (const q of rt.queue) below(q.id, idNum(q.id, QUEUE_ID_RE), rt.nextIds.queue)

  // I15 rev increases; a changed task object has a higher rev.
  if (o.prev) {
    if (rt !== o.prev && rt.rev <= o.prev.rev) bad('I15', `rev ${rt.rev} after ${o.prev.rev}`)
    const before = new Map(o.prev.tasks.map((t) => [t.id, t]))
    for (const t of rt.tasks) {
      const p = before.get(t.id)
      if (p && p !== t && t.rev <= p.rev) bad('I15', `${t.id} changed at rev ${t.rev}`)
    }
  }

  // I18 active runs within the team cap (queued and stopping count).
  const cap = Math.min(def?.def.maxConcurrent ?? TEAM_MAX_CONCURRENT, TEAM_MAX_CONCURRENT)
  if (rt.activeRuns.length > cap) bad('I18', `${rt.activeRuns.length} active runs over ${cap}`)

  return out
}
