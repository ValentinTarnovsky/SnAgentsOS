/**
 * Takeover reducers (app 2.7.0, E10 B9, design 3.4 and the takeover machine of
 * 4.4): "Tomar el control" hands an agent's session to a console of the user,
 * "Devolver al Equipo" gives it back. Pure, no Node imports, copy on write.
 *
 * K1 a live run stops (`requestStop` with reason takeover) and the agent keeps
 * `takeover.stopping` until that run ends; K2 the run's end hands the session
 * over (settleTakeovers, applied by TeamService in that end's own commit); a
 * queued run is a plain cancel and hands over the session its key already
 * had; K3 an idle agent hands over its most recent task session at once
 * (else its lead or free session). Only a session that exists on disk is
 * handed over: `turns > 0`, or the stopped run reached `running` (a Claude
 * uuid minted at admission is no conversation yet: `no_session`).
 * K4 bindTakeover (the op validated the console first), K5 abortTakeover and
 * the `bind:` deadline (dropTakeover), K6 beginRelease / finishRelease, K7
 * reconcileTakeovers (a bound console gone from the config; one under another
 * workspace keeps its takeover, which follows it).
 *
 * Every end of a held session marks it `baseStale` (the next usage delta of a
 * team run is approx) and gives its task back (giveBack): a task the agent
 * runs in its phase that nothing would wake any more gets a continuation.
 * A Lead whose session a console holds decides nothing: its pending small
 * plans go to the user (escalateHeldLead), and Devolver never takes them back.
 */
import {
  LEAD_THREAD,
  STOP_GRACE_MS,
  TAKEOVER_BIND_MS,
  TASK_ID_RE,
  type AgentSession,
  type AgentState,
  type PolicyDecision,
  type RunEndFacts,
  type RunMode,
  type SessionKey,
  type Takeover,
  type TaskPhase,
  type TeamRuntime,
} from '@shared/teams'
import type { AgentProvider } from '@shared/types'
import { modeFits, phaseAgentOf } from './dispatch'
import { requestStop } from './runs'
import { appendComment } from './tasks'
import type { FlowCtx, FlowResult, TeamEffect } from './types'

/** K2: how long the takeover op waits for the stopped run to close (the supervisor forces it at STOP_GRACE_MS); then `busy`. */
export const TAKEOVER_STOP_WAIT_MS = STOP_GRACE_MS + 2_000
/** K4: how long takeoverBound waits for the console to show up in a saved config or to spawn (the renderer saves through a 400 ms debounce). */
export const TAKEOVER_CONFIRM_MS = 5_000

/** The DeadlineTimer key of a takeover waiting for its console (design 3.10). */
export function takeoverBindKey(teamId: string, agentId: string): string {
  return `bind:${teamId}:${agentId}`
}

/** When the `bind:` deadline of a waiting takeover is due. */
export function takeoverBindAt(tk: Extract<Takeover, { phase: 'bindPending' }>): number {
  return tk.at + TAKEOVER_BIND_MS
}

/** A takeover that holds a session (every phase but `stopping`). */
export type HeldTakeover = Exclude<Takeover, { phase: 'stopping' }>

/**
 * A console of the config as reconcileTakeovers reads it: its workspace, its saved lastSession (`sessionId`,
 * `provider`), the session its own live status names (`live`), the waiting session `sessionHolder` names it the
 * holder of (`holds`) and the sessions a notHeld release left it in place for (`left`).
 */
export interface TakeoverPane {
  workspaceId: string
  sessionId?: string
  provider?: AgentProvider
  live?: string
  holds?: string
  left?: readonly string[]
}

export interface TakeoverOpts {
  /** When a session was last used (its lastRunId in the runs ring); its createdAt without one. */
  lastUsed?: (s: AgentSession) => number | undefined
  /** K3: a session a console can resume (the op: its cwd still exists; a removed task worktree's cannot). All without it. */
  usable?: (s: AgentSession) => boolean
  /** The run-end policy of a queued run the takeover cancels (TeamService's). */
  policyOf?: (f: RunEndFacts) => PolicyDecision
}

/** A run mode of the phase its agent runs in (giveBack). */
const PHASE_MODE: Readonly<Partial<Record<TaskPhase, RunMode>>> = { planning: 'plan', executing: 'exec', qa: 'qa' }

function fail<R>(error: Extract<FlowResult<R>, { ok: false }>['error'], extra: Omit<Extract<FlowResult<R>, { ok: false }>, 'ok' | 'error'> = {}): FlowResult<R> {
  return { ok: false, error, ...extra }
}

function stale<R>(): FlowResult<R> {
  return fail('conflict', { reason: 'stale' })
}

function keep(rt: TeamRuntime): FlowResult {
  return { ok: true, rt, effects: [], result: undefined }
}

function replaceAgent(rt: TeamRuntime, a: AgentState): TeamRuntime {
  return { ...rt, agents: rt.agents.map((x) => (x.id === a.id ? a : x)) }
}

/** The agent holding `s` of `key` for a console: takenOver, bindPending. */
function holdSession(a: AgentState, key: SessionKey, s: AgentSession, now: number): AgentState {
  return { ...a, status: 'takenOver', takeover: { phase: 'bindPending', at: now, sessionKey: key, sessionId: s.sessionId, provider: s.provider, cwd: s.cwd } }
}

/**
 * The session K3 hands over: the agent's most recent task session that exists on disk (turns > 0, by `lastUsed`, else
 * its creation; a tie by key), else its lead session, else its free one; null without any. `usable` leaves out a
 * session no console can resume (its cwd is gone).
 */
export function sessionToTake(a: AgentState, lastUsed?: TakeoverOpts['lastUsed'], usable?: TakeoverOpts['usable']): { key: SessionKey; session: AgentSession } | null {
  const used = (s: AgentSession): number => lastUsed?.(s) ?? s.createdAt
  const fits = (s: AgentSession): boolean => s.turns > 0 && s.provider === a.provider && (usable?.(s) ?? true)
  let best: { key: SessionKey; session: AgentSession } | null = null
  for (const [key, s] of Object.entries(a.sessions)) {
    if (!TASK_ID_RE.test(key) || !fits(s)) continue
    if (!best || used(s) > used(best.session) || (used(s) === used(best.session) && key > best.key)) best = { key, session: s }
  }
  if (best) return best
  for (const key of [LEAD_THREAD, 'free']) {
    const s = a.sessions[key]
    if (s && fits(s)) return { key, session: s }
  }
  return null
}

/**
 * The task of an ended takeover goes back to the team: a task the agent runs in its current phase (planning, executing
 * or qa), with no wake mark, no comment queued for the agent, no active run and no open card, would never run again
 * (a run a takeover stopped ends with nothing to follow it, 4.1): it gets a continuation of that mode. The same rt
 * when anything else already wakes it, when it waits on the user, or for a lead or free session.
 */
export function giveBack(rt: TeamRuntime, agentId: string, sessionKey: SessionKey, now: number): TeamRuntime {
  if (!TASK_ID_RE.test(sessionKey)) return rt
  const agent = rt.agents.find((a) => a.id === agentId)
  const t = rt.tasks.find((x) => x.id === sessionKey)
  if (!agent || agent.retired || agent.takeover || !t || t.next) return rt
  if (t.state !== 'doing' && t.state !== 'review') return rt
  const mode = PHASE_MODE[t.phase]
  if (!mode || phaseAgentOf(t) !== agentId || !modeFits(t, mode)) return rt
  if (rt.activeRuns.some((r) => r.taskId === t.id)) return rt
  if ((rt.comments[t.id] ?? []).some((c) => c.forAgent === agentId && !c.deliveredRunId)) return rt
  if (rt.cards.some((c) => c.state === 'open' && c.taskId === t.id)) return rt
  const next = { ...t, next: { agentId, mode, reason: 'continuation' as const, since: now }, updatedAt: now }
  return { ...rt, tasks: rt.tasks.map((x) => (x.id === t.id ? next : x)) }
}

/** A held takeover ends: the agent idle, its session `baseStale` (the user drove it), its task given back. */
function endHold(rt: TeamRuntime, agentId: string, now: number): TeamRuntime {
  const a = rt.agents.find((x) => x.id === agentId)
  const tk = a?.takeover
  if (!a || !tk || tk.phase === 'stopping') return rt
  const next: AgentState = { ...a, status: 'idle' }
  delete next.takeover
  const s = a.sessions[tk.sessionKey]
  if (s && s.sessionId === tk.sessionId && !s.baseStale) next.sessions = { ...a.sessions, [tk.sessionKey]: { ...s, baseStale: true } }
  return giveBack(replaceAgent(rt, next), agentId, tk.sessionKey, now)
}

/**
 * Orchestrator decision (B9 integration, E10 SPIKE): a Lead whose session a console holds (bindPending, bound or
 * releasing) decides nothing, so every pending approval it is the decider of (a small plan, decision 29) goes to the
 * user the way the lead escalation of a run end does: decider `user` (it counts in Te necesita and notifies once) and
 * one `leadEscalation` note per approval in the Lead thread, for nobody. A small plan written while it is held goes
 * the same way (TeamService applies this to every commit through settleTakeovers); Devolver never takes them back.
 * The same rt when the Lead is not held or nothing waits on it.
 */
export function escalateHeldLead(rt: TeamRuntime, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ escalated: string[] }> {
  const held = rt.agents.some((a) => a.roleKind === 'lead' && !!a.takeover && a.takeover.phase !== 'stopping')
  if (!held || !rt.approvals.some((x) => x.state === 'pending' && x.decider === 'lead')) return { ok: true, rt, effects: [], result: { escalated: [] } }
  let out = rt
  const effects: TeamEffect[] = []
  const escalated: string[] = []
  for (const ap of rt.approvals) {
    if (ap.state !== 'pending' || ap.decider !== 'lead') continue
    out = { ...out, approvals: out.approvals.map((x) => (x.id === ap.id ? { ...x, decider: 'user' as const } : x)) }
    escalated.push(ap.id)
    const note = appendComment(out, { author: { kind: 'system' }, target: LEAD_THREAD, kind: 'system', text: '', sys: { key: 'leadEscalation', vars: { taskId: ap.taskId ?? '' } } }, ctx)
    if (note.ok) {
      out = note.rt
      // A full thread archives its oldest delivered comments: that effect must run, or they are lost.
      effects.push(...note.effects)
    }
  }
  return { ok: true, rt: out, effects, result: { escalated } }
}

/** A takeover reducer's immediate hold, with the escalation of a held Lead (escalateHeldLead) in the same result. */
function withHeldLead<R>(rt: TeamRuntime, effects: TeamEffect[], result: R, ctx: Pick<FlowCtx, 'now'>): FlowResult<R> {
  const esc = escalateHeldLead(rt, ctx)
  if (!esc.ok || esc.rt === rt) return { ok: true, rt, effects, result }
  return { ok: true, rt: esc.rt, effects: [...effects, ...esc.effects], result }
}

/**
 * The takeover op (K1, K3, and K1 on a queued run). `immediate`: the session is held now (bindPending); else the run
 * stops and its end hands the session over (K2). `runId`: the run it stopped or cancelled. Refused: an agent already
 * taken over (`busy`, a double click), a run already stopping (`stopping`), nothing on disk to hand over (`no_session`,
 * nothing changed: a queued run is not even cancelled).
 */
export function beginTakeover(rt: TeamRuntime, agentId: string, ctx: Pick<FlowCtx, 'now'>, o: TakeoverOpts = {}): FlowResult<{ immediate: boolean; runId?: string }> {
  const agent = rt.agents.find((a) => a.id === agentId)
  if (!agent) return fail('not_found')
  if (agent.takeover || agent.status === 'takenOver') return fail('busy')
  if (agent.runId) {
    const run = rt.activeRuns.find((r) => r.id === agent.runId)
    if (!run) return fail('busy')
    if (run.state === 'stopping') return fail('stopping')
    const prev = agent.sessions[run.sessionKey]
    const had = !!prev && prev.turns > 0
    if (run.state === 'queued') {
      // Granted only when the key already had a session (the run would have resumed it); nothing ran yet.
      if (!prev || !had) return fail('no_session')
      const stopped = requestStop(rt, run.id, 'takeover', ctx, o.policyOf)
      if (!stopped.ok) return stopped
      const a = stopped.rt.agents.find((x) => x.id === agentId)
      if (!a || a.runId) return fail('busy')
      return withHeldLead(replaceAgent(stopped.rt, holdSession(a, run.sessionKey, prev, ctx.now)), stopped.effects, { immediate: true, runId: run.id }, ctx)
    }
    // A run that reached `running` made its session exist only once its id is known (a Codex thread id comes with
    // `thread.started`; a first line of another type leaves none): without one nothing could be handed over.
    if (!had && !(run.reachedRunning && run.sessionId)) return fail('no_session')
    const stopped = requestStop(rt, run.id, 'takeover', ctx, o.policyOf)
    if (!stopped.ok) return stopped
    const a = stopped.rt.agents.find((x) => x.id === agentId)
    if (!a) return fail('not_found')
    const takeover: Takeover = { phase: 'stopping', at: ctx.now, runId: run.id, sessionKey: run.sessionKey }
    return { ok: true, rt: replaceAgent(stopped.rt, { ...a, takeover }), effects: stopped.effects, result: { immediate: false, runId: run.id } }
  }
  const pick = sessionToTake(agent, o.lastUsed, o.usable)
  if (!pick) return fail('no_session')
  return withHeldLead(replaceAgent(rt, holdSession(agent, pick.key, pick.session, ctx.now)), [], { immediate: true }, ctx)
}

/**
 * K2: an agent whose takeover still says `stopping` while its run is no longer active hands that run's session over
 * now (bindPending), when it exists on disk; without one (the run's end dropped it: a fresh session) the takeover goes
 * and the op answers `no_session`. The same rt when nothing settles. TeamService applies it to every commit, so the
 * hand-over lands in the run end's own commit whatever path ended the run (close, a forced stop, Labs off, a quit).
 * Last, a held Lead's pending approvals go to the user (escalateHeldLead, `escalated`): the Lead's own hand-over and
 * a small plan written while a console holds the Lead, in that same commit.
 */
export function settleTakeovers(rt: TeamRuntime, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ held: string[]; dropped: string[]; escalated: string[] }> {
  let out = rt
  const held: string[] = []
  const dropped: string[] = []
  for (const a of rt.agents) {
    const tk = a.takeover
    if (tk?.phase !== 'stopping' || a.runId || rt.activeRuns.some((r) => r.id === tk.runId)) continue
    const s = a.sessions[tk.sessionKey]
    if (s && s.turns > 0) {
      out = replaceAgent(out, holdSession(a, tk.sessionKey, s, ctx.now))
      held.push(a.id)
      continue
    }
    const next: AgentState = { ...a, status: 'idle' }
    delete next.takeover
    out = giveBack(replaceAgent(out, next), a.id, tk.sessionKey, ctx.now)
    dropped.push(a.id)
  }
  const esc = escalateHeldLead(out, ctx)
  if (!esc.ok) return { ok: true, rt: out, effects: [], result: { held, dropped, escalated: [] } }
  return { ok: true, rt: esc.rt, effects: esc.effects, result: { held, dropped, escalated: esc.result.escalated } }
}

/**
 * At load (4.4 invariants): a `releasing` takeover is `bound` again (its kill was never confirmed), and a `stopping`
 * one whose run the reaper ended hands its session over (settleTakeovers); TeamService re-arms the `bind:` deadline of
 * every bindPending one at enable (deadlines are memory only).
 */
export function takeoversAtLoad(rt: TeamRuntime, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ held: string[]; dropped: string[]; escalated: string[] }> {
  let out = rt
  for (const a of rt.agents) {
    const tk = a.takeover
    if (tk?.phase === 'releasing') out = replaceAgent(out, { ...a, takeover: { ...tk, phase: 'bound' } })
  }
  return settleTakeovers(out, ctx)
}

/**
 * K4: the console the op validated (it is in the config under that workspace and holds the session) takes the
 * session: CAS bindPending; the same console again is a no-op (the config reconcile may have bound it first); the
 * team's workspace is recorded when it has none.
 */
export function bindTakeover(rt: TeamRuntime, agentId: string, paneId: string, workspaceId: string, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const a = rt.agents.find((x) => x.id === agentId)
  if (!a) return fail('not_found')
  const tk = a.takeover
  if (tk && (tk.phase === 'bound' || tk.phase === 'releasing') && tk.paneId === paneId && tk.workspaceId === workspaceId) return keep(rt)
  if (tk?.phase !== 'bindPending') return stale()
  const bound: Takeover = { phase: 'bound', at: ctx.now, sessionKey: tk.sessionKey, sessionId: tk.sessionId, provider: tk.provider, cwd: tk.cwd, paneId, workspaceId }
  let out = replaceAgent(rt, { ...a, takeover: bound })
  if (!out.workspaceId) out = { ...out, workspaceId }
  return { ok: true, rt: out, effects: [], result: undefined }
}

/**
 * K5 takeoverAbort (the renderer could not open the console): a bindPending takeover ends; none is a no-op; a run
 * still stopping answers `stopping` (abort once its grant came); a bound one is the release's (`conflict {stale}`).
 */
export function abortTakeover(rt: TeamRuntime, agentId: string, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const a = rt.agents.find((x) => x.id === agentId)
  if (!a) return fail('not_found')
  const tk = a.takeover
  if (!tk) return keep(rt)
  if (tk.phase === 'stopping') return fail('stopping')
  if (tk.phase !== 'bindPending') return stale()
  return { ok: true, rt: endHold(rt, agentId, ctx.now), effects: [{ kind: 'dispatch' }], result: undefined }
}

/**
 * K5 (the `bind:` deadline found no console), K7 (the bound console left the config: closed by hand) and K6 when the
 * bound console no longer holds the session: the takeover ends and nothing is killed. A releasing one is the release
 * op's; the same rt without a held takeover.
 */
export function dropTakeover(rt: TeamRuntime, agentId: string, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const a = rt.agents.find((x) => x.id === agentId)
  const tk = a?.takeover
  if (!a || !tk || tk.phase === 'stopping') return keep(rt)
  if (tk.phase === 'releasing') return stale()
  return { ok: true, rt: endHold(rt, agentId, ctx.now), effects: [{ kind: 'dispatch' }], result: undefined }
}

/**
 * K6, first step: a bound takeover turns `releasing` and names its console for the kill; a console working or asking
 * for something (`paneBusy`) answers `busy` and nothing moves; a release already in flight is `busy` too.
 */
export function beginRelease(rt: TeamRuntime, agentId: string, paneBusy: boolean, _ctx: Pick<FlowCtx, 'now'>): FlowResult<{ paneId: string; workspaceId: string }> {
  const a = rt.agents.find((x) => x.id === agentId)
  if (!a) return fail('not_found')
  const tk = a.takeover
  if (!tk || (tk.phase !== 'bound' && tk.phase !== 'releasing')) return stale()
  if (tk.phase === 'releasing' || paneBusy) return fail('busy')
  return { ok: true, rt: replaceAgent(rt, { ...a, takeover: { ...tk, phase: 'releasing' } }), effects: [], result: { paneId: tk.paneId, workspaceId: tk.workspaceId } }
}

/** K6, after killPaneAndWait (CAS releasing): the console is gone -> the takeover ends (endHold); else it is bound again. */
export function finishRelease(rt: TeamRuntime, agentId: string, killed: boolean, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const a = rt.agents.find((x) => x.id === agentId)
  if (!a) return fail('not_found')
  const tk = a.takeover
  if (tk?.phase !== 'releasing') return stale()
  if (!killed) return { ok: true, rt: replaceAgent(rt, { ...a, takeover: { ...tk, phase: 'bound' } }), effects: [], result: undefined }
  return { ok: true, rt: endHold(rt, agentId, ctx.now), effects: [{ kind: 'dispatch' }], result: undefined }
}

/**
 * How well a console of the config fits a waiting takeover's session, lower first; null when it never takes it. 0 its
 * own live status names the session; 1 `sessionHolder` names it the holder; 2 its saved lastSession is that session of
 * that provider. A console whose live status names another conversation (a /clear before its debounced save) never
 * takes it, nor one a notHeld release left in place for that session unless its live status names the session again.
 */
export function takeoverPaneRank(pane: TakeoverPane, tk: { sessionId: string; provider: AgentProvider }): 0 | 1 | 2 | null {
  if (pane.live !== undefined) return pane.live === tk.sessionId ? 0 : null
  if (pane.left?.includes(tk.sessionId)) return null
  if (pane.holds === tk.sessionId) return 1
  if (pane.sessionId === tk.sessionId && (pane.provider === undefined || pane.provider === tk.provider)) return 2
  return null
}

/**
 * K4 by reconcile and K7, against the consoles of the saved config (`livePanes`, by pane id): a bound takeover whose
 * console left the config ends (closed by hand), and one whose console the config now lists under another workspace
 * (the user moved it and deleted its home) follows it there (`moved`); a bindPending one binds to the console that fits
 * its session best (takeoverPaneRank: the one whose live status names it first; a tie, the first in the config). A
 * releasing one is left to its release.
 */
export function reconcileTakeovers(rt: TeamRuntime, livePanes: ReadonlyMap<string, TakeoverPane>, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ bound: string[]; released: string[]; moved: string[] }> {
  let out = rt
  const bound: string[] = []
  const released: string[] = []
  const moved: string[] = []
  for (const a of rt.agents) {
    const tk = a.takeover
    if (tk?.phase === 'bound') {
      const pane = livePanes.get(tk.paneId)
      if (pane) {
        if (pane.workspaceId === tk.workspaceId) continue
        out = replaceAgent(out, { ...a, takeover: { ...tk, workspaceId: pane.workspaceId } })
        moved.push(a.id)
        continue
      }
      out = endHold(out, a.id, ctx.now)
      released.push(a.id)
      continue
    }
    if (tk?.phase !== 'bindPending') continue
    let pick: { paneId: string; pane: TakeoverPane; rank: number } | null = null
    for (const [paneId, pane] of livePanes) {
      const rank = takeoverPaneRank(pane, tk)
      if (rank !== null && (!pick || rank < pick.rank)) pick = { paneId, pane, rank }
    }
    if (!pick) continue
    const r = bindTakeover(out, a.id, pick.paneId, pick.pane.workspaceId, ctx)
    if (!r.ok || r.rt === out) continue
    out = r.rt
    bound.push(a.id)
  }
  const effects: TeamEffect[] = released.length ? [{ kind: 'dispatch' }] : []
  return { ok: true, rt: out, effects, result: { bound, released, moved } }
}

/**
 * The run-end policy of a run a takeover stopped (requirement 3 of B9: no card about a run the user now drives): its
 * task is never blocked on a card (a result it reached in the linger window may want noProgress, failure or timeout);
 * everything else of the policy stands (a continuation or retry waits for the takeover to end, the provider facts hold).
 */
export function takeoverPolicy(p: PolicyDecision, f: Pick<RunEndFacts, 'run'>): PolicyDecision {
  if (f.run.stopReason !== 'takeover' || !p.block) return p
  const out: PolicyDecision = { ...p }
  delete out.block
  return out
}
