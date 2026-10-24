/**
 * Run reducers (app 2.7.0, E10 B2, design 3.4 and the run machine of 4.1).
 * Pure, no Node imports: a run is born `queued` at admission (decision 17),
 * moves to `starting` once its process spawned, `running` at its first
 * protocol line and ends in one terminal state; every terminal transition
 * frees the agent, applies the run-end policy, leaves `activeRuns` and asks
 * for the side effects (revoke the token, release locks, delete the system
 * file, synthetic status off, clear the run deadlines, dispatch).
 *
 * B2 runs are manual ("Ejecutar ahora"): `manualGate` checks the gates of a
 * manual request and `basicPolicy` holds the provider rows of the policy
 * table; B4 replaces both with the Dispatcher and `afterRunPolicy`.
 */
import { redactCredentials } from '@shared/redact'
import {
  GLOBAL_MAX_RUNS,
  LIMIT_FALLBACK_MS,
  RETRIES_MAX,
  RUN_SUMMARY_MAX,
  TEAM_MAX_CONCURRENT,
  type AgentSession,
  type AgentState,
  type CardReason,
  type DeferInfo,
  type DispatchFacts,
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
  type TeamDefinition,
  type TeamRuntime,
  type TeamTask,
  type WakeMark,
} from '@shared/teams'
import type { FailureInfo } from '@shared/failure'
import type { StreamFacts } from '../parsers/types'
import { openSystemCard } from './agents'
import type { FlowCtx, FlowResult, TeamEffect } from './types'

export interface AdmitFacts { sessionKey: SessionKey; resume: { sessionId: string } | null; cwd: string; profile: PermissionProfile; model?: string; effort?: string; sysHash: string }
export interface RunEnd { at: number; exit: { code: number | null; signal: string | null }; facts: StreamFacts; teamWrites: number; treeMoved?: boolean; lastLineAt?: number }

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

/** The RunEndFacts the policy reads, from the terminal run and the runtime it ends in. */
export function runEndFactsOf(rt: TeamRuntime, run: Run, now: number, o: { claudeCanSwitch?: boolean; claudeSwitchedAt?: number; unknownSession?: boolean } = {}): RunEndFacts {
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
  return f
}

/**
 * Applies a policy decision for a run that just ended (its `next`, counters,
 * cooldown, block card, provider block, team pause, fresh session, undeliver
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
      const card = openSystemCard(out, { why: p.block.card.why, actions: p.block.card.actions, taskId: t.id, runId: run.id }, ctx)
      if (card.ok) {
        out = card.rt
        const cardId = card.result.cardId ?? out.cards.find((c) => c.state === 'open' && c.taskId === t.id && c.from.kind === 'system' && c.from.why === p.block?.card.why)?.id
        const reason = p.block.reason.kind === 'card' && cardId ? { ...p.block.reason, cardId } : p.block.reason
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
 * other active run. The Claude session id is minted here for a fresh
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
  }
  const id = ctx.newRunId()
  const sessionId = a.resume ? a.resume.sessionId : agent.provider === 'claude' ? ctx.newSessionId() : undefined
  const by: Run['trigger']['by'] = req.reason === 'manual' || req.reason === 'kickoff' || req.reason === 'userMessage' ? 'user' : 'system'
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
 * approvals); a lead run records the goal it saw. Arms `run:<id>:max` and
 * turns the synthetic status on.
 */
export function markStarting(rt: TeamRuntime, runId: string, s: { pid: number; delivered: NonNullable<Run['delivered']> }, ctx: FlowCtx): FlowResult {
  const run = findRun(rt, runId)
  if (!run || run.state !== 'queued') return fail('conflict', { reason: 'stale' })
  const started: Run = { ...run, state: 'starting', startedAt: ctx.now, pid: s.pid, delivered: { comments: [...s.delivered.comments], cards: [...s.delivered.cards], approvals: [...s.delivered.approvals] } }
  let out = replaceRun(rt, started)
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
  if (run.mode === 'lead' && out.goalSeenHash !== ctx.def.goalHash) out = { ...out, goalSeenHash: ctx.def.goalHash }
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
 * the run's cwd and `sysHash`). A run already `stopping` stays stopping but
 * still records that its session now exists on disk.
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
 * `untrusted` and `sessionBusy` only fail the run (the level re-requests it,
 * nothing is counted).
 */
export function prepFailed(rt: TeamRuntime, runId: string, failure: FailureInfo, card: CardReason | null, ctx: FlowCtx): FlowResult {
  const run = findRun(rt, runId)
  if (!run || run.state !== 'queued') return fail('conflict', { reason: 'stale' })
  const terminal: Run = { ...run, state: 'failed', failure: { ...failure }, outcome: 'failed', endedAt: ctx.now }
  const ended = endRun(rt, terminal, {}, ctx, true)
  if (!ended.ok || !card) return ended.ok ? { ...ended, result: undefined } : ended
  const opened = openSystemCard(ended.rt, { why: card, actions: run.taskId ? ['retry', 'dismiss'] : ['dismiss'], taskId: run.taskId, runId: run.id }, ctx)
  return { ok: true, rt: opened.ok ? opened.rt : ended.rt, effects: ended.effects, result: undefined }
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
  policyOf: (f: RunEndFacts) => PolicyDecision = basicPolicy,
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

/** A short, redacted summary of a run's final text. */
function summaryOf(text: string): string | undefined {
  const t = redactCredentials(text.trim())
  if (!t) return undefined
  return t.length > RUN_SUMMARY_MAX ? t.slice(0, RUN_SUMMARY_MAX - 1) + '…' : t
}

/** Outcome without the B4 classifier (same order as classifyOutcome): none for a stopped run, concluded, failed, or progress / empty from the hard evidence. */
function basicOutcome(state: RunState, run: Run, end: RunEnd): RunOutcome | undefined {
  if (state === 'cancelled' || state === 'takenOver' || state === 'interrupted') return undefined
  if (run.concludedBy) return 'concluded'
  if (state === 'failed') return 'failed'
  if (state !== 'succeeded') return undefined
  if (end.facts.maxTurns || end.teamWrites > 0 || end.facts.fileEdits > 0 || end.treeMoved) return 'progress'
  return 'empty'
}

/**
 * The terminal copy of a closing run (R7 / R8 / R9), without touching the
 * runtime: the caller builds the policy facts from it before `finishRun`
 * (which computes the same copy again). A clean end is `!facts.failure`, the
 * one field the parsers set exactly when the run failed (max turns is no
 * failure, decision 10); a stopped run without a result ends by its reason.
 */
export function terminalOf(run: Run, end: RunEnd): Run {
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
  const summary = summaryOf(facts.finalText ?? '')
  if (summary) terminal.summary = summary
  if (facts.denials.length) {
    const counts = new Map<string, number>()
    for (const d of facts.denials) counts.set(d.tool, (counts.get(d.tool) ?? 0) + 1)
    terminal.denials = [...counts].map(([tool, count]) => ({ tool, count }))
  }
  const outcome = basicOutcome(state, terminal, end)
  if (outcome) terminal.outcome = outcome
  else delete terminal.outcome
  return terminal
}

/**
 * R7 / R8 / R9: the process closed (or a stop was forced). Terminal state,
 * usage, context, digest, summary, the session bases (Claude cumulative cost,
 * Codex cumulative tokens), the agent idle, the policy, and the end effects.
 * A run already finalized by another path, or still queued, is left alone.
 */
export function finishRun(rt: TeamRuntime, runId: string, end: RunEnd, policy: PolicyDecision, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ run: Run }> {
  const run = findRun(rt, runId)
  if (!run || run.state === 'queued') return fail('conflict', { reason: 'stale' })
  const facts = end.facts
  const terminal = terminalOf(run, end)

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
  return endRun(out, terminal, policy, ctx, true)
}

/** The wake mark of the same agent, mode and session for a run's follow-up. */
function sameAs(run: RunEndFacts['run'], reason: WakeMark['reason'], now: number, notBefore?: number): WakeMark {
  const m: WakeMark = { agentId: run.agentId, mode: run.mode, reason, since: now }
  if (notBefore !== undefined) m.notBefore = notBefore
  return m
}

/**
 * B2 only (until B4): the provider rows of the policy table (limit and rate
 * limit block the provider; auth and billing pause the team, unless the
 * account switched during the run, decision 40: then it is a retry) plus the
 * delivery rule (a run that never reached `running` hands back what it got).
 */
export function basicPolicy(f: RunEndFacts): PolicyDecision {
  const run = f.run
  const out: PolicyDecision = {}
  const concluded = !!run.concludedBy
  if ((run.state === 'failed' || run.state === 'interrupted') && !run.reachedRunning && run.stopReason !== 'user') out.undeliver = true
  const failure = run.state === 'failed' ? run.failure : undefined
  if (!failure) return out
  if (failure.kind === 'limit' || failure.kind === 'rateLimited') {
    const until = f.claudeCanSwitch && run.provider === 'claude' ? f.now + LIMIT_FALLBACK_MS : failure.until ?? f.now + LIMIT_FALLBACK_MS
    out.providerBlock = { provider: run.provider, until }
    if (!concluded) out.next = sameAs(run, 'retry', f.now, until)
    return out
  }
  if (failure.kind === 'auth') {
    const switched = f.claudeSwitchedAt !== undefined && run.provider === 'claude' && run.startedAt !== undefined && f.claudeSwitchedAt >= run.startedAt && f.claudeSwitchedAt <= (run.endedAt ?? f.now)
    if (switched) {
      if (!concluded) out.next = sameAs(run, 'retry', f.now)
      if (f.task) out.counters = { retries: Math.min(RETRIES_MAX + 1, f.task.counters.retries + 1) }
      return out
    }
  }
  if (failure.kind === 'auth' || failure.kind === 'billing') {
    out.pauseTeam = failure.kind
    if (!concluded) out.next = sameAs(run, 'retry', f.now)
  }
  return out
}

/**
 * B2 only (until B4 replaces it with a Dispatcher pass): G1, G1b, G2, G3, G5
 * for a manual request, in that order. Busy agents answer `running` /
 * `stopping`. Null: the request may be admitted now.
 */
export function manualGate(rt: TeamRuntime, def: TeamDefinition, req: RunRequest, facts: Omit<DispatchFacts, 'manual'>): DeferInfo | null {
  const withTask = (d: DeferInfo): DeferInfo => (req.taskId ? { ...d, taskId: req.taskId } : d)
  if (!facts.enabled) return withTask({ reason: 'disabled' })
  if (!facts.trusted) return withTask({ reason: 'untrusted' })
  if (!facts.cliReady) return withTask({ reason: 'cliOff' })
  if (rt.paused) return withTask({ reason: 'paused' })
  const agent = rt.agents.find((a) => a.id === req.agentId)
  if (!agent) return withTask({ reason: 'disabled' })
  if (agent.status === 'takenOver' || agent.takeover) return withTask({ reason: 'takenOver' })
  if (agent.runId) {
    const cur = findRun(rt, agent.runId)
    return withTask({ reason: cur?.state === 'stopping' ? 'stopping' : 'running' })
  }
  if (agent.paused) return withTask({ reason: 'agentPaused' })
  const cap = Math.min(def.maxConcurrent, TEAM_MAX_CONCURRENT)
  if (rt.activeRuns.length >= cap) return withTask({ reason: 'teamCap' })
  if (facts.globalActive >= GLOBAL_MAX_RUNS) return withTask({ reason: 'globalCap' })
  const blocked = rt.providerBlockedUntil[agent.provider]
  if (blocked !== undefined && blocked > facts.now) return withTask({ reason: 'quota', until: blocked })
  if (agent.provider === 'claude' && facts.claudeBlockedUntil !== null && facts.claudeBlockedUntil > facts.now) return withTask({ reason: 'quota', until: facts.claudeBlockedUntil })
  const sess = agent.sessions[req.sessionKey]
  if (sess && facts.busySessions.has(sess.sessionId)) return withTask({ reason: 'sessionBusy' })
  return null
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
