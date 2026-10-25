/**
 * The `snaos team` write tools in the store (app 2.7.0, E10 B3, design 3.4
 * and 5.3): one call of a run (the CLI through teamCtl, or one action of a
 * Codex `snaos-team` block) checked and applied by the task reducers. Pure.
 *
 * B3 lands the non-terminal tools (task create and update, comment); the
 * terminal ones (ask, needs, plan, review, verdict, done, approve, hire) and
 * applyBlock are B5's, `note` is B7's: until then they answer `unsupported`.
 * Reads (show, tasks, task get) never come here: TeamService answers them.
 */
import { allowedFor, teamTool, type TeamToolName } from '@shared/teamTools'
import { LEAD_THREAD, TASK_ID_RE, type Actor, type TaskPriority, type TeamRuntime, type TeamTask } from '@shared/teams'
import type { TaskDraft, TaskPatch } from '@shared/team-protocol'
import { addComment, createTask, updateTask } from './tasks'
import type { FlowCtx, FlowError, FlowResult, TeamToolCall } from './types'

type Fail = Extract<FlowResult, { ok: false }>

function fail(error: FlowError, extra: Omit<Fail, 'ok' | 'error'> = {}): Fail {
  return { ok: false, error, ...extra }
}

/** The params each B3 tool takes (5.3); any other key is a shape error, so a misspelled one never drops silently. */
const PARAMS: Readonly<Partial<Record<TeamToolName, readonly string[]>>> = {
  'task.create': ['title', 'body', 'assign', 'repo', 'isolation', 'blockedBy', 'priority', 'noPlan', 'parent'],
  'task.update': ['task', 'rev', 'title', 'body', 'assign', 'priority', 'blockedBy', 'isolation', 'state', 'needsPlan'],
  comment: ['target', 'text'],
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const optStr = (v: unknown): boolean => v === undefined || isStr(v)
const optBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean'
/** A blocker list: string ids, or `none` / [] to clear it (update). */
function blockedByOf(v: unknown, clearOk: boolean): string[] | null | undefined {
  if (v === undefined) return undefined
  if (clearOk && v === 'none') return []
  return Array.isArray(v) && v.every(isStr) ? (v as string[]) : null
}

/**
 * One write call of an agent's run. Validation order: shape, existence, role
 * (allowedFor), run liveness (active and, for writes, not concluded; a block
 * applied at close admits a stopping run), phase and mode, caps, userOwned.
 * A rejected call changes nothing. Results: create `{id}`, update `{id, rev}`
 * (the rev the commit gives it: one more for a changed task), comment `{id}`.
 */
export function applyTool(rt: TeamRuntime, actor: Actor & { kind: 'agent' }, call: TeamToolCall, ctx: FlowCtx): FlowResult<unknown> {
  const spec = teamTool(call.method)
  if (!spec || !spec.write) return fail('bad_request')
  const p = call.params
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return fail('bad_request')
  const allowed = PARAMS[spec.name]
  if (allowed && Object.keys(p).some((k) => !allowed.includes(k))) return fail('bad_request')

  const run = rt.activeRuns.find((r) => r.id === actor.runId)
  if (!run || run.agentId !== actor.agentId || run.state === 'queued') return fail('forbidden')
  const task: TeamTask | undefined = run.taskId ? rt.tasks.find((t) => t.id === run.taskId) : undefined
  if (!allowedFor(run.roleKind, spec, { mode: run.mode, isolation: task?.isolation, hasTask: !!task })) return fail('forbidden')
  if (run.concludedBy) return fail('conflict', { reason: 'concluded' })
  if (run.state === 'stopping' && !call.viaBlock) return fail('stopping')
  const who: Actor = { kind: 'agent', agentId: run.agentId, runId: run.id, roleKind: run.roleKind }

  switch (spec.name) {
    case 'task.create': {
      if (!isStr(p.title) || !optStr(p.body) || !optStr(p.assign) || !optStr(p.repo) || !optStr(p.isolation) || !optStr(p.priority) || !optStr(p.parent) || !optBool(p.noPlan)) return fail('bad_request')
      const blockedBy = blockedByOf(p.blockedBy, false)
      if (blockedBy === null) return fail('bad_request')
      // A Dev or a custom role splits only the task it runs (`--parent` = that task); the Lead may name any task.
      if (run.roleKind !== 'lead' && (!task || p.parent !== task.id)) return fail('forbidden')
      if (p.parent !== undefined && !TASK_ID_RE.test(p.parent as string)) return fail('bad_request')
      const d: TaskDraft & { parentId?: string } = { title: p.title }
      if (p.body !== undefined) d.body = p.body as string
      if (p.assign !== undefined) d.assignee = p.assign as string
      if (p.repo !== undefined) d.repoId = p.repo as string
      if (p.isolation !== undefined) d.isolation = p.isolation as TaskDraft['isolation']
      if (blockedBy !== undefined) d.blockedBy = blockedBy
      if (p.priority !== undefined) d.priority = p.priority as TaskPriority
      if (p.noPlan === true) d.needsPlan = false
      if (p.parent !== undefined) d.parentId = p.parent as string
      const res = createTask(rt, who, d, ctx)
      return res.ok ? { ...res, result: { id: res.result.task.id } } : res
    }
    case 'task.update': {
      if (!isStr(p.task) || !TASK_ID_RE.test(p.task)) return fail('bad_request')
      if (p.rev !== undefined && !(typeof p.rev === 'number' && Number.isInteger(p.rev) && p.rev >= 0)) return fail('bad_request')
      if (!optStr(p.title) || !optStr(p.body) || !optStr(p.priority) || !optStr(p.isolation) || !optStr(p.state) || !optBool(p.needsPlan)) return fail('bad_request')
      if (p.assign !== undefined && p.assign !== null && !isStr(p.assign)) return fail('bad_request')
      const blockedBy = blockedByOf(p.blockedBy, true)
      if (blockedBy === null) return fail('bad_request')
      const patch: TaskPatch & { state?: 'todo' | 'blocked' | 'cancelled' } = {}
      if (p.title !== undefined) patch.title = p.title as string
      if (p.body !== undefined) patch.body = p.body as string
      if (p.assign !== undefined) patch.assignee = p.assign === null || p.assign === 'none' ? null : (p.assign as string)
      if (p.priority !== undefined) patch.priority = p.priority as TaskPriority
      if (blockedBy !== undefined) patch.blockedBy = blockedBy
      if (p.isolation !== undefined) patch.isolation = p.isolation as TaskPatch['isolation']
      if (p.state !== undefined) patch.state = p.state as 'todo' | 'blocked' | 'cancelled'
      if (p.needsPlan !== undefined) patch.needsPlan = p.needsPlan as boolean
      const res = updateTask(rt, who, p.task, patch, p.rev as number | undefined, ctx)
      if (!res.ok) return res
      // TeamStore.commit gives a changed task object rev + 1; an unchanged call keeps it.
      return { ...res, result: { id: res.result.task.id, rev: res.rt === rt ? res.result.task.rev : res.result.task.rev + 1 } }
    }
    case 'comment': {
      if (!isStr(p.target) || !isStr(p.text)) return fail('bad_request')
      if (p.target !== LEAD_THREAD && !TASK_ID_RE.test(p.target)) return fail('bad_request')
      const res = addComment(rt, who, p.target, p.text, 'comment', ctx)
      return res.ok ? { ...res, result: { id: res.result.comment.id } } : res
    }
    default:
      // B5: ask, needs, plan, review, verdict, done, approve, hire; B7: note.
      return fail('unsupported')
  }
}
