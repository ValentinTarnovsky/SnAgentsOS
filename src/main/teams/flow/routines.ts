/**
 * Routine reducers (app 2.7.0, E10 B7, design 3.8): the routine state a fire
 * commits first (`lastScheduledFor`, so a crash right after never fires it
 * twice), the coalesce rule, the wake of a role agent and a routine's task.
 * Pure, no Node imports, copy on write. RoutineTicker owns the deadlines;
 * TeamService composes these into its commits.
 *
 * A routine's wake mark and the run it starts carry the ref `routine:<id>`
 * (WakeMark.refs, Run.trigger.refs): the coalesce rule and the routine's
 * `lastRunId` find them by it.
 */
import type { TaskDraft } from '@shared/team-protocol'
import type { AgentState, RoutineDef, RoutineState, TeamRuntime, WakeMark } from '@shared/teams'
import { createTask } from './tasks'
import type { FlowCtx, FlowResult } from './types'

/** The ref prefix of a routine's wake mark and run. */
export const ROUTINE_REF_PREFIX = 'routine:'

export function routineRef(routineId: string): string {
  return ROUTINE_REF_PREFIX + routineId
}

/** The routine a wake mark's or a run's refs name, or null. */
export function routineOfRefs(refs: readonly string[] | undefined): string | null {
  const ref = refs?.find((r) => r.startsWith(ROUTINE_REF_PREFIX))
  return ref ? ref.slice(ROUTINE_REF_PREFIX.length) : null
}

/** rt.routines[id] with `patch` merged (a key set to undefined goes); the same rt when nothing changes. */
export function patchRoutine(rt: TeamRuntime, routineId: string, patch: { [K in keyof RoutineState]?: RoutineState[K] | undefined }): TeamRuntime {
  const cur = rt.routines[routineId]
  const next: RoutineState = { ...cur }
  for (const k of Object.keys(patch) as Array<keyof RoutineState>) {
    const v = patch[k]
    if (v === undefined) delete next[k]
    else (next as Record<string, unknown>)[k] = v
  }
  if ((Object.keys(patch) as Array<keyof RoutineState>).every((k) => cur?.[k] === next[k])) return rt
  return { ...rt, routines: { ...rt.routines, [routineId]: next } }
}

/** Free to run now: idle, not paused, not taken over. */
function idle(a: AgentState): boolean {
  return a.status === 'idle' && !a.runId && !a.paused && !a.takeover
}

/** The agents of a role a routine names (retired ones never run). */
function roleAgents(rt: TeamRuntime, roleId: string): AgentState[] {
  return rt.agents.filter((a) => a.roleId === roleId && !a.retired)
}

/**
 * What still holds a routine's previous fire (design 3.8 coalesce): its run is active (`run`: a wake's run carries
 * its ref; a "Correr ahora" run is its `lastRunId`), its wake mark has not been dispatched yet (`level`: the mark
 * waits, in "Por despachar" too), or the task its previous fire created still waits to run (`task`: todo, a wake
 * mark, or a run on it). Null when the routine is free to fire again.
 */
export function routinePending(rt: TeamRuntime, r: Pick<RoutineDef, 'id' | 'action'>): 'run' | 'level' | 'task' | null {
  const ref = routineRef(r.id)
  const s = rt.routines[r.id]
  if (rt.activeRuns.some((x) => (x.trigger.refs ?? []).includes(ref) || (s?.lastRunId !== undefined && x.id === s.lastRunId))) return 'run'
  if (r.action === 'wake') return rt.agents.some((a) => a.next?.reason === 'routine' && (a.next.refs ?? []).includes(ref)) ? 'level' : null
  const t = s?.lastTaskId ? rt.tasks.find((x) => x.id === s.lastTaskId) : undefined
  if (!t || t.state === 'done' || t.state === 'cancelled') return null
  return t.state === 'todo' || t.next || rt.activeRuns.some((x) => x.taskId === t.id) ? 'task' : null
}

/**
 * Action `wake` (design 3.8): the role's agent gets the routine's wake mark, lead mode for the Lead, free for the
 * rest, reason `routine`, the prompt as its request and the routine's ref. The agent: the first idle one of the role
 * whose wake slot is free, else the first with a free slot (its mark waits for its run to end). Every agent of the
 * role holding another wake in its one slot -> `busy` (the caller tries again later; overwriting would drop that
 * wake). No agent of the role -> `not_found`.
 */
export function routineWake(rt: TeamRuntime, r: Pick<RoutineDef, 'id' | 'role' | 'prompt'>, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ agentId: string }> {
  const agents = roleAgents(rt, r.role)
  if (agents.length === 0) return { ok: false, error: 'not_found' }
  const free = agents.filter((a) => !a.next)
  const agent = free.find(idle) ?? free[0]
  if (!agent) return { ok: false, error: 'busy' }
  const mark: WakeMark = { agentId: agent.id, mode: agent.roleKind === 'lead' ? 'lead' : 'free', reason: 'routine', since: ctx.now, detail: r.prompt, refs: [routineRef(r.id)] }
  const out: TeamRuntime = { ...rt, agents: rt.agents.map((a) => (a.id === agent.id ? { ...a, next: mark } : a)) }
  return { ok: true, rt: out, effects: [{ kind: 'dispatch' }], result: { agentId: agent.id } }
}

/**
 * Action `task` (design 3.8): a task of the system, titled by the routine (`title`, else its id), the prompt as its
 * body, assigned to the role's first idle agent, else its first (the parser never lets a task routine name the Lead).
 * The routine's `lastTaskId` is set in the same result.
 */
export function routineTask(rt: TeamRuntime, r: Pick<RoutineDef, 'id' | 'role' | 'title' | 'prompt'>, ctx: FlowCtx): FlowResult<{ taskId: string }> {
  const agents = roleAgents(rt, r.role).filter((a) => a.roleKind !== 'lead')
  const agent = agents.find(idle) ?? agents[0]
  const d: TaskDraft = { title: r.title ?? r.id, body: r.prompt }
  if (agent) d.assignee = agent.id
  const res = createTask(rt, { kind: 'system' }, d, ctx)
  if (!res.ok) return res
  const id = res.result.task.id
  return { ok: true, rt: patchRoutine(res.rt, r.id, { lastTaskId: id }), effects: res.effects, result: { taskId: id } }
}
