/**
 * Run reducers (app 2.7.0, E10 B2, design 3.4 and the run machine of 4.1).
 * Pure, no Node imports: a run is born `queued` at admission (decision 17),
 * moves to `starting` once its process spawned, `running` at its first
 * protocol line and ends in one terminal state; every terminal transition
 * frees the agent, applies the run-end policy, leaves `activeRuns` and asks
 * for the side effects (revoke the token, release locks, delete the system
 * file, synthetic status off, clear the run deadlines, dispatch).
 *
 * B4: every run comes from a Dispatcher pass (the manual ones too, through
 * Dispatcher.manual); the outcome is `classifyOutcome` and the run-end policy
 * `afterRunPolicy` (teamDispatch.ts). A task run that writes in a worktree
 * gets it during its prep (`setRunWorktree`, decision 24).
 *
 * B5: a run's end also posts the Lead's reply to its thread, hands a small
 * plan the Lead saw and left to the user (decision 29), and turns its denials
 * into one permission approval (flow/approvals.ts permissionAsk) or, for a
 * `snaos team` call through PowerShell, the agent's Bash hint; a Lead session
 * records the goal hash it read (decision 43); a task run whose prep failed
 * with a card blocks on it.
 *
 * 2.7.0 runtime fixes: a run whose denials leave its permission approval
 * pending waits on the user (permissionWaitOf, the policy's `permissionWait`),
 * a verdict, done or review cancels that approval, and only the user's
 * manual entry gives a run `trigger.by: 'user'` among the kickoffs.
 */
import { redactCredentials } from '@shared/redact'
import { afterRunPolicy, classifyOutcome } from '@shared/teamDispatch'
import {
  LEAD_REPLY_MAX,
  LEAD_THREAD,
  RUN_SUMMARY_MAX,
  type AgentSession,
  type AgentState,
  type CardReason,
  type InterruptCause,
  type PermissionProfile,
  type PolicyDecision,
  type Run,
  type RunEndFacts,
  type RunOutcome,
  type RunRequest,
  type RunState,
  type SessionKey,
  type StopReason,
  type TaskDiffStat,
  type TaskWorktree,
  type TeamRuntime,
  type TeamTask,
  type TreeMark,
  type WakeMark,
} from '@shared/teams'
import type { FailureInfo } from '@shared/failure'
import type { StreamFacts } from '../parsers/types'
import { openSystemCard } from './agents'
import { cancelNeedlessPermission, isEscapeDenial, isTeamCallDenial, PERMISSION_SETTLING_TOOLS, permissionAsk, type PermissionAskOpts } from './approvals'
import { appendComment } from './tasks'
import type { FlowCtx, FlowResult, TeamEffect } from './types'

export interface AdmitFacts { sessionKey: SessionKey; resume: { sessionId: string } | null; cwd: string; profile: PermissionProfile; model?: string; effort?: string; sysHash: string }
export interface RunEnd { at: number; exit: { code: number | null; signal: string | null }; facts: StreamFacts; teamWrites: number; treeMoved?: boolean; lastLineAt?: number }
/**
 * finishRun's clock and (B5 integration, seventh round, security) the live-token mask of what a run's final text
 * leaves in the team state: its summary and the Lead's reply, and (B5 review) the rules and denied commands of its
 * permission ask (PermissionAskOpts.mask). TeamService hands it CtlTokens.maskTokens through TeamServiceDeps.cli (a
 * run reads runtime.json or a console's env as it likes); without it the text stays as is.
 */
export interface RunEndCtx extends Pick<FlowCtx, 'now'> { mask?: (text: string) => string }

/** Deadline keys a run end clears (the RunSupervisor clears its own linger, drain, stop and kill keys). */
const RUN_DEADLINES = ['max', 'conclude'] as const

function fail<R>(error: Extract<FlowResult<R>, { ok: false }>['error'], extra: Omit<Extract<FlowResult<R>, { ok: false }>, 'ok' | 'error'> = {}): FlowResult<R> {
  return { ok: false, error, ...extra }
}

function findRun(rt: TeamRuntime, runId: string): Run | undefined {
  return rt.activeRuns.find((r) => r.id === runId)
}

function replaceRun(rt: TeamRuntime, run: Run): TeamRuntime {
  return { ...rt, activeRuns: rt.activeRuns.map((r) => (r.id === run.id ? run : r)) }
}

function replaceAgent(agents: readonly AgentState[], a: AgentState): AgentState[] {
  return agents.map((x) => (x.id === a.id ? a : x))
}

function replaceTask(tasks: readonly TeamTask[], t: TeamTask): TeamTask[] {
  return tasks.map((x) => (x.id === t.id ? t : x))
}

/** A mode that is bound to a task phase (I3). */
const MODE_PHASE: Readonly<Partial<Record<Run['mode'], TeamTask['phase']>>> = { plan: 'planning', exec: 'executing', qa: 'qa' }

/** The effects every terminal transition asks for (the terminal copy goes to the runs ring). */
function endEffects(run: Run, dispatch: boolean): TeamEffect[] {
  const runId = run.id
  const out: TeamEffect[] = [
    { kind: 'ended', run },
    { kind: 'revokeRun', runId },
    { kind: 'releaseLocks', runId },
    { kind: 'deleteSystemFile', runId },
    { kind: 'synthetic', runId, on: false },
    ...RUN_DEADLINES.map((k): TeamEffect => ({ kind: 'deadline', key: `run:${runId}:${k}`, at: null })),
  ]
  if (dispatch) out.push({ kind: 'dispatch' })
  return out
}

/** The RunEndFacts the policy reads, from the terminal run and the runtime it ends in (`permissionWait`: permissionWaitOf). */
export function runEndFactsOf(rt: TeamRuntime, run: Run, now: number, o: { claudeCanSwitch?: boolean; claudeSwitchedAt?: number; unknownSession?: boolean; permissionWait?: boolean } = {}): RunEndFacts {
  const task = run.taskId ? rt.tasks.find((t) => t.id === run.taskId) : undefined
  const agent = rt.agents.find((a) => a.id === run.agentId)
  const f: RunEndFacts = {
    run: {
      id: run.id, agentId: run.agentId, roleKind: run.roleKind, taskId: run.taskId, sessionKey: run.sessionKey, mode: run.mode, provider: run.provider,
      state: run.state, stopReason: run.stopReason, interruptCause: run.interruptCause, failure: run.failure, outcome: run.outcome,
      continuationOf: run.continuationOf, trigger: run.trigger, concludedBy: run.concludedBy, reachedRunning: run.reachedRunning,
      startedAt: run.startedAt, endedAt: run.endedAt,
    },
    agentInterrupts: agent?.interrupts ?? 0,
    now,
    claudeCanSwitch: o.claudeCanSwitch ?? false,
    unknownSession: o.unknownSession ?? false,
  }
  if (task) f.task = { id: task.id, state: task.state, phase: task.phase, counters: task.counters, assignee: task.assignee, review: task.review }
  if (o.claudeSwitchedAt !== undefined) f.claudeSwitchedAt = o.claudeSwitchedAt
  if (o.permissionWait) f.permissionWait = true
  return f
}

/**
 * Applies a policy decision for a run that just ended (its `next`, counters,
 * cooldown, block (and its card, when it names one), provider block, team pause, fresh session, undeliver
 * and the task-less interruption streak). Pure helper of every terminal path.
 */
function applyPolicy(rt: TeamRuntime, run: Run, p: PolicyDecision, ctx: Pick<FlowCtx, 'now'>): TeamRuntime {
  let out = rt
  const task = run.taskId ? out.tasks.find((t) => t.id === run.taskId) : undefined
  if (task) {
    let t: TeamTask = task
    if (p.next !== undefined) {
      if (p.next === null) {
        if (t.next) {
          t = { ...t }
          delete t.next
        }
      } else t = { ...t, next: { ...p.next } }
    }
    if (p.counters) t = { ...t, counters: { ...t.counters, ...p.counters } }
    if (p.cooldownUntil !== undefined) t = { ...t, cooldownUntil: p.cooldownUntil }
    if (t !== task) out = { ...out, tasks: replaceTask(out.tasks, { ...t, updatedAt: ctx.now }) }
    if (p.block && t.state !== 'blocked' && t.state !== 'done' && t.state !== 'cancelled') {
      // A block without a card (a user's Frenar, decision 38) blocks with its reason alone: nothing in Te necesita.
      let reason = p.block.reason
      let blocks = true
      const want = p.block.card
      if (want) {
        const card = openSystemCard(out, { why: want.why, actions: want.actions, taskId: t.id, runId: run.id }, ctx)
        blocks = card.ok
        if (card.ok) {
          out = card.rt
          const cardId = card.result.cardId ?? out.cards.find((c) => c.state === 'open' && c.taskId === t.id && c.from.kind === 'system' && c.from.why === want.why)?.id
          if (reason.kind === 'card' && cardId) reason = { ...reason, cardId }
        }
      }
      if (blocks) {
        const cur = out.tasks.find((x) => x.id === t.id) ?? t
        out = {
          ...out,
          tasks: replaceTask(out.tasks, { ...cur, state: 'blocked', blocked: { reason, resume: { state: cur.state, phase: cur.phase }, at: ctx.now }, stateSince: ctx.now, updatedAt: ctx.now }),
        }
      }
    }
  } else if (p.next !== undefined) {
    const agent = out.agents.find((a) => a.id === run.agentId)
    if (agent) {
      let a: AgentState = agent
      if (p.next === null) {
        if (a.next) {
          a = { ...a }
          delete a.next
        }
      } else a = { ...a, next: { ...p.next } }
      if (a !== agent) out = { ...out, agents: replaceAgent(out.agents, a) }
    }
  }
  if (p.agentInterrupts !== undefined) {
    const agent = out.agents.find((a) => a.id === run.agentId)
    if (agent && agent.interrupts !== p.agentInterrupts) out = { ...out, agents: replaceAgent(out.agents, { ...agent, interrupts: p.agentInterrupts }) }
  }
  if (p.providerBlock) {
    const cur = out.providerBlockedUntil[p.providerBlock.provider] ?? 0
    if (p.providerBlock.until > cur) out = { ...out, providerBlockedUntil: { ...out.providerBlockedUntil, [p.providerBlock.provider]: p.providerBlock.until } }
  }
  if (p.pauseTeam && (!out.paused || out.paused.reason === 'user')) {
    const why: CardReason = p.pauseTeam
    const card = openSystemCard(out, { why, actions: ['resumeTeam', 'dismiss'], runId: run.id, taskId: run.taskId }, ctx)
    if (card.ok) {
      out = card.rt
      const paused: NonNullable<TeamRuntime['paused']> = { reason: p.pauseTeam, at: ctx.now }
      if (card.result.cardId) paused.cardId = card.result.cardId
      if (run.failure) paused.failure = { ...run.failure }
      out = { ...out, paused }
    }
  }
  if (p.freshSession) {
    const agent = out.agents.find((a) => a.id === run.agentId)
    if (agent && agent.sessions[run.sessionKey]) {
      const sessions = { ...agent.sessions }
      delete sessions[run.sessionKey]
      out = { ...out, agents: replaceAgent(out.agents, { ...agent, sessions }) }
    }
  }
  if (p.undeliver) out = undeliver(out, run.id)
  return out
}

/**
 * The vars of a run's sessionConflict card (TeamService.onPaneStatus, the only place that opens one: the run-end
 * policy never does, its `sessionConflict` row only leaves the wake mark): `what` is its session (openSystemCard
 * raises one card per reason, task and `what`), so a second conflict on the same run or session finds the open card
 * and opens no other (extra requirement 2 of B4).
 */
export function sessionCardVars(run: Pick<Run, 'id' | 'agentId' | 'sessionId'>): Record<string, string> {
  return { what: run.sessionId ? `session:${run.sessionId}` : `run:${run.id}`, runId: run.id, agentId: run.agentId }
}

/** Comments, cards and approvals a run received go back to queued (a system failure before `running`). */
function undeliver(rt: TeamRuntime, runId: string): TeamRuntime {
  let changed = false
  const comments: TeamRuntime['comments'] = {}
  for (const [target, list] of Object.entries(rt.comments)) {
    comments[target] = list.map((c) => {
      if (c.deliveredRunId !== runId) return c
      changed = true
      const next = { ...c }
      delete next.deliveredRunId
      return next
    })
  }
  const cards = rt.cards.map((c) => {
    if (c.consumedRunId !== runId) return c
    changed = true
    const next = { ...c }
    delete next.consumedRunId
    return next
  })
  const approvals = rt.approvals.map((a) => {
    if (a.leadSeenRunId !== runId) return a
    changed = true
    const next = { ...a }
    delete next.leadSeenRunId
    return next
  })
  return changed ? { ...rt, comments, cards, approvals } : rt
}

/**
 * Takes a run out of `activeRuns` in its terminal form: the agent goes idle
 * (unless a takeover holds it, B9), the policy is applied and the end
 * effects are asked for. `terminal` already carries the terminal state.
 */
function endRun(rt: TeamRuntime, terminal: Run, policy: PolicyDecision, ctx: Pick<FlowCtx, 'now'>, dispatch: boolean): FlowResult<{ run: Run }> {
  let out: TeamRuntime = { ...rt, activeRuns: rt.activeRuns.filter((r) => r.id !== terminal.id) }
  const agent = out.agents.find((a) => a.id === terminal.agentId)
  if (agent && agent.runId === terminal.id) {
    const a: AgentState = { ...agent, status: agent.takeover && agent.takeover.phase !== 'stopping' ? 'takenOver' : 'idle' }
    delete a.runId
    out = { ...out, agents: replaceAgent(out.agents, a) }
  }
  out = applyPolicy(out, terminal, policy, ctx)
  return { ok: true, rt: out, effects: endEffects(terminal, dispatch), result: { run: terminal } }
}

/**
 * R1: a new run, `queued`. The agent must be idle, not paused, not retired
 * and not held by a takeover; a task run also needs the task free of any
 * other active run, and an exec run a task that needs no plan or has its plan
 * approved (T3, `conflict {stale}`). The Claude session id is minted here for a fresh
 * session (Codex learns its thread id from `thread.started`). The agent
 * turns `running`, a task run moves its task to the mode's phase (T2/T3,
 * qa stays) and freezes it (I19), the matching level and queue item go,
 * and the `prepare` effect starts the async prep.
 */
export function admitRun(rt: TeamRuntime, req: RunRequest, a: AdmitFacts, ctx: FlowCtx): FlowResult<{ run: Run }> {
  const agent = rt.agents.find((x) => x.id === req.agentId)
  if (!agent) return fail('not_found')
  if (agent.status === 'takenOver' || agent.takeover) return fail('busy')
  if (agent.status === 'running' || agent.runId) {
    const cur = agent.runId ? findRun(rt, agent.runId) : undefined
    return fail(cur?.state === 'stopping' ? 'stopping' : 'running')
  }
  if (agent.paused || agent.retired) return fail('busy')
  const role = ctx.def.def.roles.find((r) => r.id === agent.roleId)
  if (!role) return fail('not_found')
  let task: TeamTask | undefined
  if (req.taskId) {
    task = rt.tasks.find((t) => t.id === req.taskId)
    if (!task) return fail('not_found')
    if (rt.activeRuns.some((r) => r.taskId === req.taskId)) return fail('running')
    if (task.state === 'done' || task.state === 'cancelled' || task.state === 'blocked') return fail('conflict', { reason: 'stale' })
    // T3, defensive (B5 review, E10-FR-133): no exec run on a task that needs a plan and has none approved, whatever
    // phase a wake or a level put it in; its next run is a plan run.
    if (req.mode === 'exec' && task.needsPlan && task.plan?.status !== 'approved') return fail('conflict', { reason: 'stale' })
  }
  const id = ctx.newRunId()
  const sessionId = a.resume ? a.resume.sessionId : agent.provider === 'claude' ? ctx.newSessionId() : undefined
  // 2.7.0 runtime fixes: a kickoff is the user's only when they asked for it (a manual entry, RunRequest.manual); the
  // one a goal change raised (the Lead's L4 level, the same reason) is the team's.
  const by: Run['trigger']['by'] = req.manual || req.reason === 'manual' || req.reason === 'userMessage' ? 'user' : 'system'
  const trigger: Run['trigger'] = { reason: req.reason, by }
  if (req.refs && req.refs.length) trigger.refs = [...req.refs]
  const run: Run = {
    id, agentId: agent.id, roleId: agent.roleId, roleKind: agent.roleKind, sessionKey: a.sessionKey,
    provider: agent.provider, profile: a.profile, resumed: a.resume !== null, cwd: a.cwd, repoId: task?.repoId ?? 'main',
    mode: req.mode, trigger, state: 'queued', reachedRunning: false, resultSeen: false, queuedAt: ctx.now,
  }
  if (task) run.taskId = task.id
  if (sessionId) run.sessionId = sessionId
  if (a.model) run.model = a.model
  if (a.effort) run.effort = a.effort
  if (req.reason === 'continuation') {
    const prev = agent.sessions[a.sessionKey]?.lastRunId
    if (prev) run.continuationOf = prev
  }

  let nextAgent: AgentState = { ...agent, status: 'running', runId: id }
  if (!task && nextAgent.next && nextAgent.next.mode === req.mode) {
    nextAgent = { ...nextAgent }
    delete nextAgent.next
  }
  let out: TeamRuntime = { ...rt, activeRuns: [...rt.activeRuns, run], agents: replaceAgent(rt.agents, nextAgent) }
  if (task) {
    let t: TeamTask = { ...task, frozen: true, updatedAt: ctx.now }
    delete t.next
    const phase = MODE_PHASE[req.mode]
    if (phase && phase !== 'qa' && t.phase !== phase) t = { ...t, state: 'doing', phase, stateSince: ctx.now }
    out = { ...out, tasks: replaceTask(out.tasks, t) }
  }
  const queue = out.queue.filter((q) => q.id !== req.queueItemId && !(q.agentId === agent.id && q.sessionKey === a.sessionKey))
  if (queue.length !== out.queue.length) out = { ...out, queue }
  return { ok: true, rt: out, effects: [{ kind: 'prepare', runId: id }], result: { run } }
}

/**
 * R2: the process spawned. `startedAt` and the pid; what the prompt carried
 * is marked delivered to this run (comments for this agent, cards,
 * approvals); a lead run records the goal it saw and every task its board
 * listed as untriaged gets `triagedAt` (without it the triage level would
 * wake the Lead again and again). A writer run keeps the tree mark of its
 * prep (decision 68). Arms `run:<id>:max` and turns the synthetic status on.
 * B5: a lead run keeps the goal hash its prompt carried (`goalHash`, the
 * session records it at R5, decision 43), a prompt that carried the Bash or
 * the escape hint consumes the agent's `bashHint` / `escapeHint`, and a QA
 * run's diff stat (what its prompt showed) becomes its task's `diffStat`, the
 * one the final OK shows.
 */
export function markStarting(
  rt: TeamRuntime,
  runId: string,
  s: { pid: number; delivered: NonNullable<Run['delivered']>; triaged?: readonly string[]; treeBefore?: TreeMark; goalHash?: string; bashHint?: boolean; escapeHint?: boolean; diffStat?: TaskDiffStat },
  ctx: FlowCtx,
): FlowResult {
  const run = findRun(rt, runId)
  if (!run || run.state !== 'queued') return fail('conflict', { reason: 'stale' })
  const started: Run = { ...run, state: 'starting', startedAt: ctx.now, pid: s.pid, delivered: { comments: [...s.delivered.comments], cards: [...s.delivered.cards], approvals: [...s.delivered.approvals] } }
  if (s.treeBefore) started.treeBefore = { ...s.treeBefore }
  const goalHash = run.mode === 'lead' ? s.goalHash ?? ctx.def.goalHash : undefined
  if (goalHash !== undefined) started.goalHash = goalHash
  let out = replaceRun(rt, started)
  const agent = out.agents.find((a) => a.id === run.agentId)
  if (agent && ((s.bashHint && agent.bashHint) || (s.escapeHint && agent.escapeHint))) {
    const a: AgentState = { ...agent }
    if (s.bashHint) delete a.bashHint
    if (s.escapeHint) delete a.escapeHint
    out = { ...out, agents: replaceAgent(out.agents, a) }
  }
  if (s.diffStat && run.mode === 'qa' && run.taskId) {
    const t = out.tasks.find((x) => x.id === run.taskId)
    if (t) out = { ...out, tasks: replaceTask(out.tasks, { ...t, diffStat: { ...s.diffStat, top: s.diffStat.top.map((f) => ({ ...f })) }, updatedAt: ctx.now }) }
  }
  if (run.mode === 'lead' && s.triaged && s.triaged.length) {
    const ids = new Set(s.triaged)
    out = { ...out, tasks: out.tasks.map((t) => (ids.has(t.id) && t.triagedAt === undefined ? { ...t, triagedAt: ctx.now } : t)) }
  }
  if (s.delivered.comments.length) {
    const ids = new Set(s.delivered.comments)
    const comments: TeamRuntime['comments'] = {}
    for (const [target, list] of Object.entries(out.comments)) {
      comments[target] = list.map((c) => (ids.has(c.id) && c.forAgent === run.agentId && !c.deliveredRunId ? { ...c, deliveredRunId: runId } : c))
    }
    out = { ...out, comments }
  }
  if (s.delivered.cards.length) {
    const ids = new Set(s.delivered.cards)
    out = { ...out, cards: out.cards.map((c) => (ids.has(c.id) && !c.consumedRunId ? { ...c, consumedRunId: runId } : c)) }
  }
  if (s.delivered.approvals.length) {
    const ids = new Set(s.delivered.approvals)
    out = { ...out, approvals: out.approvals.map((a) => (ids.has(a.id) && !a.leadSeenRunId ? { ...a, leadSeenRunId: runId } : a)) }
  }
  if (goalHash !== undefined && out.goalSeenHash !== goalHash) out = { ...out, goalSeenHash: goalHash }
  const maxAt = ctx.now + Math.max(1, ctx.def.def.maxRunMinutes) * 60_000
  return {
    ok: true,
    rt: out,
    effects: [
      { kind: 'deadline', key: `run:${runId}:max`, at: maxAt },
      { kind: 'synthetic', runId, on: true },
    ],
    result: undefined,
  }
}

/**
 * R5: the first protocol line. `firstLineAt` and `reachedRunning`; the
 * session record of the agent (a Codex thread id learned now, `turns` + 1,
 * the run's cwd and `sysHash`, a Lead run's `goalHash`). A run already
 * `stopping` stays stopping but still records that its session now exists on
 * disk.
 */
export function markRunning(rt: TeamRuntime, runId: string, f: { at: number; sessionId?: string; sysHash?: string }, _ctx: FlowCtx): FlowResult {
  const run = findRun(rt, runId)
  if (!run || (run.state !== 'starting' && run.state !== 'stopping') || run.reachedRunning) return { ok: true, rt, effects: [], result: undefined }
  const sessionId = run.sessionId ?? f.sessionId
  const next: Run = { ...run, state: run.state === 'starting' ? 'running' : run.state, firstLineAt: f.at, reachedRunning: true }
  if (sessionId) next.sessionId = sessionId
  let out = replaceRun(rt, next)
  const agent = out.agents.find((a) => a.id === run.agentId)
  if (agent && sessionId) {
    const cur = agent.sessions[run.sessionKey]
    const session: AgentSession =
      cur && cur.sessionId === sessionId && cur.provider === run.provider
        ? { ...cur, turns: cur.turns + 1, lastRunId: run.id }
        : { provider: run.provider, sessionId, cwd: run.cwd, createdAt: f.at, turns: 1, sysHash: f.sysHash ?? cur?.sysHash ?? '', lastRunId: run.id }
    if (f.sysHash) session.sysHash = f.sysHash
    // B5 (decision 43): the goal this Lead session read is the one its prompt carried, once the turn runs.
    if (run.goalHash !== undefined) session.goalHash = run.goalHash
    // A session id lives in one agent and one key only (I5).
    const sessions: Record<string, AgentSession> = {}
    for (const [k, s] of Object.entries(agent.sessions)) if (k === run.sessionKey || s.sessionId !== sessionId) sessions[k] = s
    sessions[run.sessionKey] = session
    out = { ...out, agents: replaceAgent(out.agents, { ...agent, sessions }) }
  }
  return { ok: true, rt: out, effects: [], result: undefined }
}

/**
 * R3: the async prep could not spawn the run. `failed` with a request
 * failure; `cwdMissing`, `spawnFailed` and `cliOff` open their system card;
 * `untrusted`, `sessionBusy` and `treeBusy` only fail the run and give its
 * level back (the admission consumed it): the same wake mark, so the next
 * pass after the trust or the free session requests it again, nothing counted.
 * A manual run without a task is the user's click, not a level: it is not
 * requested again; one on a task gets a `retry` wake (its admission moved the
 * task into the mode's phase, where no other level would find it). When the
 * admission consumed a wake mark, TeamService then puts that exact mark back
 * (restoreWake). B5: a task run whose prep failed with a card blocks its task
 * on that card (`blocked {card}`, resume = the pair the admission moved it to):
 * Reintentar resumes it with a `retry` wake (T17, answerCard), and Descartar
 * leaves it blocked, so Retomar (resumeTask) resumes it later: it never sits in
 * doing with nothing to wake it. B5 integration, seventh round: `vars` give the
 * card its own words (`{what: 'cmdLine'}`: the command line through cmd.exe of
 * a `.cmd` agent CLI would pass CMD_LINE_MAX, agentCli.ts).
 */
export function prepFailed(rt: TeamRuntime, runId: string, failure: FailureInfo, card: CardReason | null, ctx: FlowCtx, vars?: Record<string, string | number>): FlowResult {
  const run = findRun(rt, runId)
  if (!run || run.state !== 'queued') return fail('conflict', { reason: 'stale' })
  const terminal: Run = { ...run, state: 'failed', failure: { ...failure }, outcome: 'failed', endedAt: ctx.now }
  const policy: PolicyDecision = {}
  const manual = run.trigger.reason === 'manual'
  if (card === null && (!manual || run.taskId)) {
    const mark: WakeMark = { agentId: run.agentId, mode: run.mode, reason: manual ? 'retry' : run.trigger.reason, since: run.queuedAt }
    if (run.trigger.refs && run.trigger.refs.length) mark.refs = [...run.trigger.refs]
    policy.next = mark
  }
  // applyPolicy opens the card of a task run and blocks the task on it (its id in the reason).
  if (card !== null && run.taskId) policy.block = { reason: { kind: 'card', cardId: '', why: card }, card: { why: card, actions: ['retry', 'dismiss'] } }
  const ended = endRun(rt, terminal, policy, ctx, true)
  if (!ended.ok || !card) return ended.ok ? { ...ended, result: undefined } : ended
  if (run.taskId) return { ...ended, rt: vars ? withBlockCardVars(rt, ended.rt, run.taskId, vars) : ended.rt, result: undefined }
  const opened = openSystemCard(ended.rt, { why: card, actions: ['dismiss'], runId: run.id, ...(vars ? { vars } : {}) }, ctx)
  return { ok: true, rt: opened.ok ? opened.rt : ended.rt, effects: ended.effects, result: undefined }
}

/** The card a task now blocks on, when this transition opened it (absent from `before`), gets `vars`. */
function withBlockCardVars(before: TeamRuntime, after: TeamRuntime, taskId: string, vars: Record<string, string | number>): TeamRuntime {
  const reason = after.tasks.find((t) => t.id === taskId)?.blocked?.reason
  const cardId = reason?.kind === 'card' ? reason.cardId : undefined
  if (!cardId || before.cards.some((c) => c.id === cardId)) return after
  return { ...after, cards: after.cards.map((c) => (c.id === cardId && c.from.kind === 'system' ? { ...c, from: { ...c.from, vars: { ...vars } } } : c)) }
}

/**
 * After a prepFailed that opened no card (untrusted, sessionBusy, treeBusy): the wake mark the admission consumed
 * (R1 clears task.next, and the agent's own mark of the run's mode) goes back exactly as it was (its reason, refs,
 * request text and cooldown bypass), in place of the one prepFailed derived from the trigger: a manual run built
 * from that mark has only `manual` and gets a `retry` on a task and nothing without one. Only into a slot prepFailed
 * left for this agent and mode, or an empty one, of a task the agent still runs in that phase (a newer level wins).
 */
export function restoreWake(rt: TeamRuntime, taskId: string | undefined, mark: WakeMark, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const keep: FlowResult = { ok: true, rt, effects: [], result: undefined }
  const free = (m: WakeMark | undefined): boolean => !m || (m.agentId === mark.agentId && m.mode === mark.mode)
  const agent = rt.agents.find((a) => a.id === mark.agentId)
  if (!agent || agent.retired) return keep
  if (taskId) {
    const t = rt.tasks.find((x) => x.id === taskId)
    if (!t || t.state === 'done' || t.state === 'cancelled' || t.state === 'blocked' || !free(t.next)) return keep
    if (t.phase !== 'none' && MODE_PHASE[mark.mode] !== t.phase) return keep
    return { ok: true, rt: { ...rt, tasks: replaceTask(rt.tasks, { ...t, next: { ...mark }, updatedAt: ctx.now }) }, effects: [], result: undefined }
  }
  if (!free(agent.next)) return keep
  return { ok: true, rt: { ...rt, agents: replaceAgent(rt.agents, { ...agent, next: { ...mark } }) }, effects: [], result: undefined }
}

/**
 * The run-end policy of a run that carried a request text (the user's prompt of "Ejecutar ahora", a routine's): a
 * task-less run the policy wakes again (interrupted, retry, context) keeps that text in its wake mark, persisted with
 * the runtime (`WakeMark.detail`), so the run it gets, after a reload too, still carries the request.
 */
export function withRunDetail(p: PolicyDecision, run: Pick<Run, 'taskId'>, detail: string | undefined): PolicyDecision {
  if (run.taskId || !detail || !detail.trim() || !p.next || p.next.detail) return p
  return { ...p, next: { ...p.next, detail } }
}

/** The terminal state of a stop that needs no close (queued) or of a forced or closed stopping run without a result. */
function stoppedState(reason: StopReason): { state: RunState; cause?: InterruptCause; failure?: FailureInfo } {
  switch (reason) {
    case 'takeover':
      return { state: 'takenOver' }
    case 'timeout':
      return { state: 'failed', failure: { kind: 'unknown', code: 'timeout' } }
    case 'labsOff':
    case 'cliOff':
    case 'sessionConflict':
    case 'shutdown':
      return { state: 'interrupted', cause: reason }
    case 'user':
    case 'deleted':
    case 'taskMoved':
    case 'paused':
    case 'concluded':
      return { state: 'cancelled' }
  }
}

/**
 * R4 / R6: stop a run. A `queued` run ends at once (`immediate`: no process
 * yet, the prep CAS will see it); a `starting` or `running` one turns
 * `stopping` with the effect that signals its process tree (the first reason
 * wins); a run already stopping answers `already`.
 */
export function requestStop(
  rt: TeamRuntime,
  runId: string,
  reason: StopReason,
  ctx: Pick<FlowCtx, 'now'>,
  policyOf: (f: RunEndFacts) => PolicyDecision = afterRunPolicy,
): FlowResult<{ already: boolean; immediate: boolean }> {
  const run = findRun(rt, runId)
  if (!run) return fail('not_found')
  if (run.state === 'stopping') return { ok: true, rt, effects: [], result: { already: true, immediate: false } }
  if (run.state === 'queued') {
    // R4 (and K1): no process yet, so a takeover stop of a queued run is a plain cancel.
    const s: ReturnType<typeof stoppedState> = reason === 'takeover' ? { state: 'cancelled' } : stoppedState(reason)
    const terminal: Run = { ...run, state: s.state, stopReason: reason, endedAt: ctx.now }
    if (s.cause) terminal.interruptCause = s.cause
    if (s.failure) terminal.failure = s.failure
    const ended = endRun(rt, terminal, policyOf(runEndFactsOf(rt, terminal, ctx.now)), ctx, true)
    return ended.ok ? { ...ended, result: { already: false, immediate: true } } : ended
  }
  const stopping: Run = { ...run, state: 'stopping', stopReason: reason }
  return { ok: true, rt: replaceRun(rt, stopping), effects: [{ kind: 'stopRun', runId, reason }], result: { already: false, immediate: false } }
}

/** A short summary of a run's final text: every live token masked (`mask`), redacted, then cut. */
function summaryOf(text: string, mask: RunEndCtx['mask']): string | undefined {
  const trimmed = text.trim()
  const t = redactCredentials(mask ? mask(trimmed) : trimmed)
  if (!t) return undefined
  return t.length > RUN_SUMMARY_MAX ? t.slice(0, RUN_SUMMARY_MAX - 1) + '…' : t
}

/** classifyOutcome (decision 68) of a terminal copy: the parser facts, the run's team writes and its tree mark. */
function outcomeOf(state: RunState, run: Run, end: RunEnd): RunOutcome | undefined {
  const f = end.facts
  return classifyOutcome({
    state,
    isError: f.isError,
    maxTurns: f.maxTurns,
    finalText: f.finalText ?? '',
    digest: f.digest ?? { tools: 0, families: {}, files: [] },
    teamWrites: end.teamWrites,
    concluded: !!run.concludedBy,
    mode: run.mode,
    roleKind: run.roleKind,
    fileEdits: f.fileEdits ?? 0,
    ...(end.treeMoved !== undefined ? { treeMoved: end.treeMoved } : {}),
  })
}

/**
 * The terminal copy of a closing run (R7 / R8 / R9), without touching the
 * runtime: the caller builds the policy facts from it before `finishRun`
 * (which computes the same copy again). A clean end is `!facts.failure`, the
 * one field the parsers set exactly when the run failed (max turns is no
 * failure, decision 10); a stopped run without a result ends by its reason.
 * The outcome is classifyOutcome's (on the raw final text); the summary is
 * masked with `mask` (RunEndCtx).
 */
export function terminalOf(run: Run, end: RunEnd, mask?: RunEndCtx['mask']): Run {
  const facts = end.facts
  let state: RunState
  let failure: FailureInfo | undefined
  let cause: InterruptCause | undefined
  if (run.state === 'stopping' && run.stopReason) {
    if (facts.resultSeen) {
      state = facts.failure ? 'failed' : 'succeeded'
      failure = facts.failure
    } else if (run.stopReason === 'concluded') {
      // R9 / 4.1 succeeded(concluded): the terminal tool already landed; only the turn's tail was cut.
      state = 'succeeded'
    } else {
      const s = stoppedState(run.stopReason)
      state = s.state
      failure = s.failure
      cause = s.cause
    }
  } else if (!facts.failure) {
    state = 'succeeded'
  } else {
    state = 'failed'
    failure = facts.failure
  }
  const terminal: Run = { ...run, state, endedAt: end.at, exit: { ...end.exit }, resultSeen: run.resultSeen || facts.resultSeen }
  if (failure) terminal.failure = { ...failure }
  else delete terminal.failure
  if (cause) terminal.interruptCause = cause
  if (!terminal.firstLineAt && facts.firstLineAt) terminal.firstLineAt = facts.firstLineAt
  if (end.lastLineAt !== undefined) terminal.lastLineAt = end.lastLineAt
  if (end.treeMoved !== undefined) terminal.treeMoved = end.treeMoved
  if (!terminal.sessionId && facts.sessionId && run.reachedRunning) terminal.sessionId = facts.sessionId
  if (facts.usage) terminal.usage = { ...facts.usage }
  if (facts.context) terminal.context = { ...facts.context }
  if (facts.digest) terminal.digest = { ...facts.digest, families: { ...facts.digest.families }, files: [...facts.digest.files] }
  const summary = summaryOf(facts.finalText ?? '', mask)
  if (summary) terminal.summary = summary
  if (facts.denials.length) {
    const counts = new Map<string, number>()
    for (const d of facts.denials) counts.set(d.tool, (counts.get(d.tool) ?? 0) + 1)
    terminal.denials = [...counts].map(([tool, count]) => ({ tool, count }))
  }
  const outcome = outcomeOf(state, terminal, end)
  if (outcome) terminal.outcome = outcome
  else delete terminal.outcome
  return terminal
}

/**
 * R7 / R8 / R9: the process closed (or a stop was forced). Terminal state,
 * usage, context, digest, summary, the session bases (Claude cumulative cost,
 * Codex cumulative tokens), the agent idle, the policy, and the end effects.
 * A run already finalized by another path, or still queued, is left alone.
 * The final text reaches the team state masked by `ctx.mask` (the summary,
 * the Lead's reply).
 */
export function finishRun(rt: TeamRuntime, runId: string, end: RunEnd, policy: PolicyDecision, ctx: RunEndCtx, ask?: RunEndAsk): FlowResult<{ run: Run }> {
  const run = findRun(rt, runId)
  if (!run || run.state === 'queued') return fail('conflict', { reason: 'stale' })
  const facts = end.facts
  const terminal = terminalOf(run, end, ctx.mask)

  // Session bases for the next delta (decision 9).
  let out = rt
  const agent = out.agents.find((a) => a.id === run.agentId)
  const sid = terminal.sessionId
  const sess = agent && sid ? agent.sessions[run.sessionKey] : undefined
  if (agent && sess && sess.sessionId === sid) {
    const s: AgentSession = { ...sess, lastRunId: run.id }
    if (facts.cumulativeCost !== undefined) s.costTotal = facts.cumulativeCost
    if (facts.cumulativeTokens) s.tokensTotal = { ...facts.cumulativeTokens }
    delete s.baseStale
    out = { ...out, agents: replaceAgent(out.agents, { ...agent, sessions: { ...agent.sessions, [run.sessionKey]: s } }) }
  }
  const ended = endRun(out, terminal, policy, ctx, true)
  if (!ended.ok) return ended
  return runEndFollowUps(ended, terminal, facts, ctx, ask)
}

/** What finishRun needs for the permission approvals of a run's denials (B5): the trusted definition and the protect paths of decision 72. */
export interface RunEndAsk { ctx: FlowCtx; protect: PermissionAskOpts['protect'] }

/**
 * 2.7.0 runtime fixes (orchestrator decision), the policy fact `permissionWait` of a closing run (TeamService computes
 * it before the policy, which finishRun applies before its follow-ups ask): true when the run is a task run that did
 * not conclude and its denials open, grow or ask again the pending permission approval of its task and role (the
 * approval permissionAsk would answer, read without committing it). Without `ask` (an untrusted team) nothing is
 * asked, so nothing waits. Only a run that ended succeeded or failed and that the user did not stop waits: a user
 * stop, a cancel, a takeover and an interruption keep their own policy rows (and teams.log never says it waits).
 */
export function permissionWaitOf(rt: TeamRuntime, run: Run, facts: Pick<StreamFacts, 'denials'>, ctx: RunEndCtx, ask: RunEndAsk | undefined): boolean {
  const denials = facts.denials ?? []
  if ((run.state !== 'succeeded' && run.state !== 'failed') || run.stopReason === 'user') return false
  if (!ask || !run.taskId || run.concludedBy || denials.length === 0) return false
  const asked = permissionAsk(rt, run, denials, { ...ask.ctx, now: ctx.now }, { protect: ask.protect, mask: ctx.mask })
  return asked.ok && asked.result.approvalId !== null
}

/** The opening line of a Codex `snaos-team` fence (5.6): what follows it is main's to apply, not the Lead's words. */
const TEAM_FENCE_LINE_RE = /^ {0,3}`{3,}[ \t]*snaos-team[ \t]*$/

/**
 * The Lead's reply as the Lead thread shows it: the final text without a trailing `snaos-team` block (a Codex Lead
 * reports its actions in one), every live token masked (`mask`, after the block is cut), redacted, within LEAD_REPLY_MAX.
 */
function leadReplyText(run: Run, finalText: string, mask: RunEndCtx['mask']): string {
  let text = finalText
  if (run.provider === 'codex') {
    const lines = text.split(/\r\n|\r|\n/)
    let cut = -1
    for (let i = 0; i < lines.length; i++) if (TEAM_FENCE_LINE_RE.test(lines[i])) cut = i
    if (cut >= 0) text = lines.slice(0, cut).join('\n')
  }
  const trimmed = text.trim()
  const t = redactCredentials(mask ? mask(trimmed) : trimmed)
  return t.length > LEAD_REPLY_MAX ? t.slice(0, LEAD_REPLY_MAX - 1) + '…' : t
}

/**
 * B5, after the terminal transition of finishRun (design 4.1 "Lead runs" and "Permission denials"):
 * - the Lead's reply: a lead run that answered the user (a userMessage or kickoff wake, or one that got a user
 *   message of the Lead thread in its prompt) and ended well appends its final text (leadReplyText, with the live
 *   tokens masked by `ctx.mask`) to the Lead thread as an `answer` comment for nobody (it wakes no one);
 * - lead escalation (decision 29): a small plan this run saw and did not decide waits for the user now, with the
 *   `leadEscalation` note in the Lead thread;
 * - denials: a `snaos team` call through the PowerShell tool or `snaos.cmd` (its profile allows the CLI only as
 *   `Bash(snaos team:*)`) sets the agent's `bashHint`, so its next run gets TEAM_CALL_HINT, instead of an approval; a
 *   shell or inline-code escape (isEscapeDenial: never grantable) sets its `escapeHint`, so its next run gets
 *   ESCAPE_HINT (the command needs the user: `snaos team needs`); the rest go to permissionAsk (its rules: no approval
 *   for what the profile keeps denying, never a PowerShell grant, never mcp / Task / Agent), only with `ask` (the
 *   trusted definition: an untrusted team asks nothing);
 * - 2.7.0 runtime fixes: a task run that concluded with a verdict, `done` or `review` asks nothing and cancels the
 *   pending permission approval of its task and role (cancelNeedlessPermission: no longer needed).
 */
function runEndFollowUps(ended: Extract<FlowResult<{ run: Run }>, { ok: true }>, run: Run, facts: StreamFacts, ctx: RunEndCtx, ask: RunEndAsk | undefined): FlowResult<{ run: Run }> {
  let out = ended.rt
  const effects = [...ended.effects]

  if (run.mode === 'lead' && run.state === 'succeeded') {
    const lead = out.comments[LEAD_THREAD] ?? []
    const delivered = new Set(run.delivered?.comments ?? [])
    const answered = run.trigger.reason === 'userMessage' || run.trigger.reason === 'kickoff' || lead.some((c) => delivered.has(c.id) && c.author.kind === 'user')
    const text = answered ? leadReplyText(run, facts.finalText ?? '', ctx.mask) : ''
    if (text) {
      const reply = appendComment(out, { author: { kind: 'agent', agentId: run.agentId, runId: run.id, roleKind: run.roleKind }, target: LEAD_THREAD, kind: 'answer', text }, ctx)
      if (reply.ok) {
        out = reply.rt
        effects.push(...reply.effects)
      }
    }
  }

  for (const ap of out.approvals) {
    if (ap.state !== 'pending' || ap.decider !== 'lead' || ap.leadSeenRunId !== run.id) continue
    out = { ...out, approvals: out.approvals.map((x) => (x.id === ap.id ? { ...x, decider: 'user' as const } : x)) }
    const note = appendComment(out, { author: { kind: 'system' }, target: LEAD_THREAD, kind: 'system', text: '', sys: { key: 'leadEscalation', vars: { taskId: ap.taskId ?? '' } } }, ctx)
    if (note.ok) {
      out = note.rt
      effects.push(...note.effects)
    }
  }

  const denials = facts.denials ?? []
  if (denials.some(isTeamCallDenial)) {
    const agent = out.agents.find((a) => a.id === run.agentId)
    if (agent && !agent.bashHint) out = { ...out, agents: replaceAgent(out.agents, { ...agent, bashHint: true }) }
  }
  if (denials.some(isEscapeDenial)) {
    const agent = out.agents.find((a) => a.id === run.agentId)
    if (agent && !agent.escapeHint) out = { ...out, agents: replaceAgent(out.agents, { ...agent, escapeHint: true }) }
  }
  if (run.taskId && run.concludedBy && PERMISSION_SETTLING_TOOLS.includes(run.concludedBy.tool)) {
    // 2.7.0 runtime fixes (orchestrator decision): a verdict, done or review wins: the task moved on, and the pending
    // permission of its task and role is no longer needed (cancelled with its own reason), nor asked again.
    out = cancelNeedlessPermission(out, run.taskId, run.roleId, ctx)
  } else if (denials.length > 0 && ask) {
    // The live-token mask of the run end too (B5 review): a rule or a denied line never enters the state with a token.
    const asked = permissionAsk(out, run, denials, { ...ask.ctx, now: ctx.now }, { protect: ask.protect, mask: ctx.mask })
    if (asked.ok) {
      out = asked.rt
      effects.push(...asked.effects)
    }
  }
  return out === ended.rt ? ended : { ok: true, rt: out, effects, result: ended.result }
}

/**
 * Prep step 2 (decision 24): the task's worktree, created for this queued run,
 * is the task's from now on and the run's cwd (CAS: the run is still queued,
 * the task has no other worktree). A session of the task kept in another cwd
 * could never resume in the worktree (a Claude session lives in its cwd slug):
 * it goes, so every task-keyed session runs in the task's cwd (I20).
 */
export function setRunWorktree(rt: TeamRuntime, runId: string, wt: TaskWorktree, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const run = findRun(rt, runId)
  if (!run || run.state !== 'queued' || !run.taskId) return fail('conflict', { reason: 'stale' })
  const task = rt.tasks.find((t) => t.id === run.taskId)
  if (!task || (task.worktree && task.worktree.path !== wt.path)) return fail('conflict', { reason: 'stale' })
  // The admission of a task whose worktree was still to come never resumes (TeamService.admitFacts): a new session here.
  if (run.resumed) return fail('conflict', { reason: 'stale' })
  let out: TeamRuntime = replaceRun(rt, { ...run, cwd: wt.path })
  out = { ...out, tasks: replaceTask(out.tasks, { ...task, worktree: { ...wt }, frozen: true, updatedAt: ctx.now }) }
  const agents = out.agents.map((a) => {
    const s = a.sessions[task.id]
    if (!s || s.cwd === wt.path) return a
    const sessions = { ...a.sessions }
    delete sessions[task.id]
    return { ...a, sessions }
  })
  if (agents.some((a, i) => a !== out.agents[i])) out = { ...out, agents }
  return { ok: true, rt: out, effects: [], result: undefined }
}

/**
 * Every active run ends `interrupted` (Labs off, quit): the processes are
 * killed by the caller (RunSupervisor.shutdownSync), nothing is counted, the
 * agents go idle and the policy is applied in the same commit.
 */
export function interruptAll(rt: TeamRuntime, cause: 'shutdown' | 'labsOff', policyOf: (f: RunEndFacts) => PolicyDecision, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ runIds: string[] }> {
  if (rt.activeRuns.length === 0) return { ok: true, rt, effects: [], result: { runIds: [] } }
  let out = rt
  const effects: TeamEffect[] = []
  const runIds: string[] = []
  for (const run of rt.activeRuns) {
    const terminal: Run = { ...run, state: 'interrupted', interruptCause: cause, endedAt: ctx.now }
    if (!terminal.stopReason) terminal.stopReason = cause
    const ended = endRun(out, terminal, policyOf(runEndFactsOf(out, terminal, ctx.now)), ctx, false)
    if (!ended.ok) continue
    out = ended.rt
    effects.push(...ended.effects)
    runIds.push(run.id)
  }
  return { ok: true, rt: out, effects, result: { runIds } }
}

/**
 * R10 at load: every run found active belongs to a process of an earlier
 * app life. It becomes `interrupted {cause: crash}`; its pid is never
 * signalled here (decision 64: only killOrphan does, after the start-time
 * check). The terminal copies come back for the runs ring.
 */
export function reapOnLoad(rt: TeamRuntime, _recent: readonly Run[], policyOf: (f: RunEndFacts) => PolicyDecision, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ reaped: Run[] }> {
  if (rt.activeRuns.length === 0) return { ok: true, rt, effects: [], result: { reaped: [] } }
  let out = rt
  const reaped: Run[] = []
  for (const run of rt.activeRuns) {
    const terminal: Run = { ...run, state: 'interrupted', interruptCause: 'crash', endedAt: ctx.now }
    const ended = endRun(out, terminal, policyOf(runEndFactsOf(out, terminal, ctx.now)), ctx, false)
    if (!ended.ok) continue
    out = ended.rt
    reaped.push(ended.result.run)
  }
  // A stopping takeover lost its run: B9 re-arms the binding; nothing holds it here.
  return { ok: true, rt: out, effects: [], result: { reaped } }
}

/**
 * Decision 64, after the async start-time check at enable: one `orphan`
 * system card per confirmed orphan (vars {runId, agentId, pid}; `what` is the
 * run id so two orphans keep two cards), actions killOrphan and dismiss.
 */
export function orphanCards(rt: TeamRuntime, orphans: ReadonlyArray<{ runId: string; agentId: string; taskId?: string; pid: number }>, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ cards: Array<{ runId: string; cardId: string }> }> {
  let out = rt
  const cards: Array<{ runId: string; cardId: string }> = []
  for (const o of orphans) {
    const opened = openSystemCard(out, { why: 'orphan', actions: ['killOrphan', 'dismiss'], taskId: o.taskId, runId: o.runId, vars: { what: o.runId, runId: o.runId, agentId: o.agentId, pid: o.pid } }, ctx)
    if (!opened.ok) continue
    out = opened.rt
    const id = opened.result.cardId ?? out.cards.find((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'orphan' && c.from.vars?.what === o.runId)?.id
    if (id) cards.push({ runId: o.runId, cardId: id })
  }
  return { ok: true, rt: out, effects: [], result: { cards } }
}

/** The agent pause (decision 22, orthogonal to its status): a running run keeps going; unpausing pokes the dispatcher. */
export function setAgentPaused(rt: TeamRuntime, agentId: string, on: boolean, _ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const agent = rt.agents.find((a) => a.id === agentId)
  if (!agent) return fail('not_found')
  if (agent.paused === on) return { ok: true, rt, effects: [], result: undefined }
  return { ok: true, rt: { ...rt, agents: replaceAgent(rt.agents, { ...agent, paused: on }) }, effects: on ? [] : [{ kind: 'dispatch' }], result: undefined }
}
