/**
 * The `snaos team` write tools in the store (app 2.7.0, E10 B3 and B5, design
 * 3.4, 4.2 and 5.3): one call of a run (the CLI through teamCtl, or one action
 * of a Codex `snaos-team` block) checked and applied by the flow reducers.
 * Pure.
 *
 * B3 lands the non-terminal tools (task create and update, comment); B5 the
 * terminal ones (ask, needs, plan, review, verdict, done, approve, hire) and
 * applyBlock; `note` is B7's: until then it answers `unsupported`. Reads
 * (show, tasks, task get) never come here: TeamService answers them.
 *
 * A terminal tool moves the task at once (T4, T7..T10, decision 35) and marks
 * the run concluded (`concludedBy`): a later write of that run answers
 * `conflict {concluded}`, and the run has CONCLUDE_GRACE_MS to finish its turn
 * (`run:<id>:conclude`) before it is stopped with reason `concluded`. A block
 * applied at close arms no grace: its run is ending already.
 */
import { redactCredentials } from '@shared/redact'
import { allowedFor, TEAM_BLOCK_REF_RE, teamTool, type TeamBlock, type TeamToolName } from '@shared/teamTools'
import {
  CARD_OPTION_MAX,
  CARD_OPTIONS_MAX,
  CARD_QUESTION_MAX,
  COMMENT_TEXT_MAX,
  CONCLUDE_GRACE_MS,
  LEAD_THREAD,
  TASK_ID_RE,
  TEAM_PLAN_MAX,
  type Actor,
  type Run,
  type TaskPriority,
  type TeamCard,
  type TeamRuntime,
  type TeamTask,
  type TerminalTool,
} from '@shared/teams'
import type { TaskDraft, TaskPatch } from '@shared/team-protocol'
import { openSystemCard } from './agents'
import { addApproval, cancelPending, decideApproval, hireOf, qaAgentFor, sha256Utf8 } from './approvals'
import { addComment, appendComment, createTask, updateTask } from './tasks'
import type { FlowCtx, FlowError, FlowResult, TeamEffect, TeamToolCall } from './types'

type Fail = Extract<FlowResult, { ok: false }>

function fail(error: FlowError, extra: Omit<Fail, 'ok' | 'error'> = {}): Fail {
  return { ok: false, error, ...extra }
}

/** The params each tool takes (5.3); any other key is a shape error, so a misspelled one never drops silently. */
const PARAMS: Readonly<Partial<Record<TeamToolName, readonly string[]>>> = {
  'task.create': ['title', 'body', 'assign', 'repo', 'isolation', 'blockedBy', 'priority', 'noPlan', 'parent'],
  'task.update': ['task', 'rev', 'title', 'body', 'assign', 'priority', 'blockedBy', 'isolation', 'state', 'needsPlan'],
  comment: ['target', 'text'],
  ask: ['text', 'options', 'multi', 'confirm'],
  needs: ['text'],
  plan: ['text', 'small'],
  review: ['text'],
  verdict: ['verdict', 'text'],
  done: ['text'],
  approve: ['plan'],
  hire: ['text'],
}

/** CARD_ID_RE allows 7 digits. */
const CARD_NUM_MAX = 9_999_999
/** C0 except tab and newline, and DEL: never inside an agent's text (CR is normalized first). */
const BODY_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/
/** The block params that name a task id, where a `$<n>` ref may stand (TEAM_BLOCK_REF_RE). */
const REF_KEYS = ['task', 'target', 'parent'] as const
/** The block params teamCtl redacts on the CLI path (the block path does the same before applyTool). */
const TEXT_KEYS = ['text', 'title', 'body'] as const

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
 * An agent's text param: CRLF and CR to LF, redacted (the CLI path redacted it already; a block's comes raw),
 * trimmed, within `max`, no control character but tab and newline. undefined when absent or blank and not
 * required; null when it is not one.
 */
function agentText(v: unknown, max: number, required: boolean): string | null | undefined {
  if (v === undefined || v === null) return required ? null : undefined
  if (typeof v !== 'string') return null
  const s = redactCredentials(v.replace(/\r\n?/g, '\n')).trim()
  if (s.length > max || BODY_BAD_RE.test(s)) return null
  if (s === '') return required ? null : undefined
  return s
}

/** `team ask --options`: 1 to CARD_OPTIONS_MAX one-line answers (controls and runs of spaces to one space). */
function optionsOf(v: unknown): string[] | null | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length === 0 || v.length > CARD_OPTIONS_MAX) return null
  const out: string[] = []
  for (const o of v) {
    if (typeof o !== 'string') return null
    // eslint-disable-next-line no-control-regex
    const s = redactCredentials(o.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim())
    if (s === '' || s.length > CARD_OPTION_MAX) return null
    out.push(s)
  }
  return out
}

function replaceTask(tasks: readonly TeamTask[], t: TeamTask): TeamTask[] {
  return tasks.map((x) => (x.id === t.id ? t : x))
}

/** The run concluded with `tool` (decision 35): writes after it answer conflict; the grace deadline unless at close. */
function conclude(rt: TeamRuntime, runId: string, tool: TerminalTool, ctx: Pick<FlowCtx, 'now'>, viaBlock: boolean): { rt: TeamRuntime; effects: TeamEffect[] } {
  const out: TeamRuntime = { ...rt, activeRuns: rt.activeRuns.map((r) => (r.id === runId ? { ...r, concludedBy: { tool, at: ctx.now } } : r)) }
  return { rt: out, effects: viaBlock ? [] : [{ kind: 'deadline', key: `run:${runId}:conclude`, at: ctx.now + CONCLUDE_GRACE_MS }] }
}

/** A terminal tool's state change, before the run is marked concluded. */
type Moved = { ok: true; rt: TeamRuntime; effects: TeamEffect[]; result: Record<string, unknown> } | Fail

/** `team ask` / `team needs` (4.5): an agent card for the user; the run concludes and the answer wakes it again. */
function openAgentCard(rt: TeamRuntime, run: Run, tool: 'ask' | 'needs', c: Pick<TeamCard, 'kind' | 'question' | 'options' | 'multi'>, ctx: Pick<FlowCtx, 'now'>): Moved {
  if (rt.nextIds.card > CARD_NUM_MAX) return fail('cap')
  const id = `k-${rt.nextIds.card}`
  const card: TeamCard = { id, kind: c.kind, question: c.question, options: [...c.options], multi: c.multi, state: 'open', from: { kind: 'agent', agentId: run.agentId, runId: run.id, tool }, createdAt: ctx.now }
  if (run.taskId) card.taskId = run.taskId
  return { ok: true, rt: { ...rt, cards: [...rt.cards, card], nextIds: { ...rt.nextIds, card: rt.nextIds.card + 1 } }, effects: [], result: { cardId: id } }
}

/**
 * The ask guard (4.5): a user comment for this agent on this task, newer than the run's start and not delivered,
 * must be read first (`team task get` delivers it). The Lead thread has no read tool, so a Lead run is not held.
 */
function newerComment(rt: TeamRuntime, run: Run): boolean {
  if (!run.taskId) return false
  const since = run.startedAt ?? run.queuedAt
  return (rt.comments[run.taskId] ?? []).some((c) => c.author.kind === 'user' && c.forAgent === run.agentId && c.deliveredRunId === undefined && c.at > since)
}

/** A comment of the run's agent (or main's `sys` note) on the task, for `forAgent` (or nobody). */
function note(rt: TeamRuntime, effects: TeamEffect[], c: Parameters<typeof appendComment>[1], ctx: Pick<FlowCtx, 'now'>): TeamRuntime | Fail {
  const res = appendComment(rt, c, ctx)
  if (!res.ok) return res
  effects.push(...res.effects)
  return res.rt
}

/** Final OK pending (T8, T10): the task waits on the user in review/userOk. */
function toUserOk(rt: TeamRuntime, task: TeamTask, who: Actor, summary: string, ctx: Pick<FlowCtx, 'now'>, review?: TeamTask['review']): { ok: true; rt: TeamRuntime; id: string } | Fail {
  let out = cancelPending(rt, task.id, 'final', ctx)
  const added = addApproval(out, { kind: 'final', taskId: task.id, decider: 'user', createdBy: who, payload: { hasWorktree: !!task.worktree, summary } }, ctx)
  if (!added.ok) return added
  out = added.rt
  const t: TeamTask = { ...task, state: 'review', phase: 'userOk', stateSince: ctx.now, updatedAt: ctx.now }
  if (review) t.review = review
  delete t.next
  return { ok: true, rt: { ...out, tasks: replaceTask(out.tasks, t) }, id: added.id }
}

/** The terminal tools (5.3, the task machine of 4.2). `run` is the caller's active run, its role and mode already checked. */
function terminal(rt: TeamRuntime, run: Run, task: TeamTask | undefined, name: TeamToolName, p: Record<string, unknown>, ctx: FlowCtx): Moved {
  const who: Actor = { kind: 'agent', agentId: run.agentId, runId: run.id, roleKind: run.roleKind }
  const effects: TeamEffect[] = []
  const stale = (): Fail => fail('conflict', { reason: 'stale' })
  switch (name) {
    case 'ask':
    case 'needs': {
      const question = agentText(p.text, CARD_QUESTION_MAX, true)
      if (!question) return fail('bad_request')
      // A task that is over keeps no open card (B5 requirement 3): a Codex block read at close, after the user moved
      // the task to done or cancelled (its run stopping), asks nothing.
      if (run.taskId && (!task || task.state === 'done' || task.state === 'cancelled')) return stale()
      if (name === 'needs') return openAgentCard(rt, run, 'needs', { kind: 'confirm', question, options: [], multi: false }, ctx)
      const options = optionsOf(p.options)
      if (options === null || !optBool(p.multi) || !optBool(p.confirm)) return fail('bad_request')
      if (p.multi === true && !options) return fail('bad_request')
      if (p.confirm === true && (options || p.multi === true)) return fail('bad_request')
      if (newerComment(rt, run)) return fail('conflict', { reason: 'newer_comment_not_delivered' })
      const kind: TeamCard['kind'] = p.confirm === true ? 'confirm' : options ? 'choice' : 'text'
      return openAgentCard(rt, run, 'ask', { kind, question, options: options ?? [], multi: p.multi === true && !!options }, ctx)
    }

    case 'plan': {
      // T4: doing/planning -> planApproval with a pending plan approval; a small one the Lead may decide (decision 29).
      if (!task) return fail('forbidden')
      if (task.state !== 'doing' || task.phase !== 'planning') return stale()
      const text = agentText(p.text, TEAM_PLAN_MAX, true)
      if (!text || !optBool(p.small)) return fail('bad_request')
      const small = p.small === true
      const decider = small && ctx.def.def.leadApprovesSmallPlans ? 'lead' : 'user'
      const rev = (task.plan?.rev ?? 0) + 1
      const added = addApproval(cancelPending(rt, task.id, 'plan', ctx), { kind: 'plan', taskId: task.id, decider, createdBy: who, payload: { planRev: rev, small } }, ctx)
      if (!added.ok) return added
      const t: TeamTask = { ...task, phase: 'planApproval', updatedAt: ctx.now, plan: { rev, text, status: 'pending', small, at: ctx.now, approvalId: added.id } }
      delete t.next
      const out: TeamRuntime = { ...added.rt, tasks: replaceTask(added.rt.tasks, t) }
      // The Lead's `leadApproval` level derives from the pending approval itself (teamDispatch leadLevels: decider
      // lead, not seen yet), so it ends when the user decides first or the task moves on; a durable `agent.next` would
      // outlive it and wake the Lead for a plan that no longer waits.
      if (decider === 'lead') effects.push({ kind: 'dispatch' })
      return { ok: true, rt: out, effects, result: { approvalId: added.id } }
    }

    case 'review': {
      // T7: doing/executing -> review/qa for the task's QA agent; without a QA role straight to the user's OK (T8).
      if (!task) return fail('forbidden')
      if (task.state !== 'doing' || task.phase !== 'executing') return stale()
      const text = agentText(p.text, COMMENT_TEXT_MAX, false)
      if (text === null) return fail('bad_request')
      const qa = qaAgentFor(rt, task)
      if (qa) {
        const t: TeamTask = { ...task, state: 'review', phase: 'qa', stateSince: ctx.now, updatedAt: ctx.now, review: { ...task.review, qaAgentId: qa.id }, next: { agentId: qa.id, mode: 'qa', reason: 'review', since: ctx.now } }
        let out: TeamRuntime | Fail = { ...rt, tasks: replaceTask(rt.tasks, t) }
        if (text) out = note(out, effects, { author: who, target: task.id, kind: 'comment', text, forAgent: qa.id }, ctx)
        if ('ok' in out) return out
        effects.push({ kind: 'dispatch' })
        return { ok: true, rt: out, effects, result: {} }
      }
      const moved = toUserOk(rt, task, who, text ?? '', ctx)
      if (!moved.ok) return moved
      let out: TeamRuntime | Fail = moved.rt
      if (text) out = note(out, effects, { author: who, target: task.id, kind: 'comment', text }, ctx)
      if (!('ok' in out)) out = note(out, effects, { author: { kind: 'system' }, target: task.id, kind: 'system', text: '', sys: { key: 'noQaRole' } }, ctx)
      if ('ok' in out) return out
      return { ok: true, rt: out, effects, result: {} }
    }

    case 'verdict': {
      // T8 approve -> review/userOk with the final approval; T9 changes -> back to the Dev, round + 1, blocked at the max.
      if (!task) return fail('forbidden')
      if (task.state !== 'review' || task.phase !== 'qa') return stale()
      if (task.review.qaAgentId !== run.agentId) return fail('forbidden')
      if (p.verdict !== 'approve' && p.verdict !== 'changes') return fail('bad_request')
      const text = agentText(p.text, COMMENT_TEXT_MAX, true)
      if (!text) return fail('bad_request')
      if (p.verdict === 'approve') {
        const moved = toUserOk(rt, task, who, text, ctx, { ...task.review, lastVerdict: 'approve' })
        if (!moved.ok) return moved
        const out = note(moved.rt, effects, { author: who, target: task.id, kind: 'review', text }, ctx)
        if ('ok' in out) return out
        return { ok: true, rt: out, effects, result: {} }
      }
      const round = Math.min(task.review.round + 1, task.review.max)
      let t: TeamTask = { ...task, state: 'doing', phase: 'executing', stateSince: ctx.now, updatedAt: ctx.now, review: { ...task.review, round, lastVerdict: 'changes' } }
      if (task.assignee) t.next = { agentId: task.assignee, mode: 'exec', reason: 'changes', since: ctx.now }
      else delete t.next
      let out: TeamRuntime = { ...rt, tasks: replaceTask(rt.tasks, t) }
      if (round >= task.review.max) {
        // The last round: the user decides (one more round for the Dev, back to todo, or cancel). The wake stays for a resume.
        const card = openSystemCard(out, { why: 'qaRounds', actions: ['resume', 'toTodo', 'cancelTask'], taskId: task.id, runId: run.id }, ctx)
        if (card.ok) {
          out = card.rt
          const cardId = card.result.cardId ?? out.cards.find((c) => c.state === 'open' && c.taskId === task.id && c.from.kind === 'system' && c.from.why === 'qaRounds')?.id
          if (cardId) {
            t = { ...t, state: 'blocked', blocked: { reason: { kind: 'card', cardId, why: 'qaRounds' }, resume: { state: 'doing', phase: 'executing' }, at: ctx.now } }
            out = { ...out, tasks: replaceTask(out.tasks, t) }
          }
        }
      } else effects.push({ kind: 'dispatch' })
      const forAgent = task.assignee && task.assignee !== run.agentId ? task.assignee : undefined
      const done = note(out, effects, { author: who, target: task.id, kind: 'review', text, forAgent }, ctx)
      if ('ok' in done) return done
      return { ok: true, rt: done, effects, result: {} }
    }

    case 'done': {
      // T10: the user's final OK is always asked (research and custom; a Dev with nothing to merge, allowedFor).
      if (!task) return fail('forbidden')
      const phaseOk = task.state === 'doing' && (task.phase === 'executing' || (run.roleKind === 'research' && task.phase === 'planning'))
      if (!phaseOk) return stale()
      const text = agentText(p.text, COMMENT_TEXT_MAX, false)
      if (text === null) return fail('bad_request')
      const moved = toUserOk(rt, task, who, text ?? '', ctx)
      if (!moved.ok) return moved
      let out: TeamRuntime | Fail = moved.rt
      // The report stays on the task (the approval is decided and gone; the comment is the record).
      if (text) out = note(out, effects, { author: who, target: task.id, kind: 'comment', text }, ctx)
      if ('ok' in out) return out
      return { ok: true, rt: out, effects, result: { approvalId: moved.id } }
    }

    case 'approve': {
      // T5 by the Lead: a small plan it is the decider of (decideApproval checks the rest, decision 29).
      if (!isStr(p.plan) || !TASK_ID_RE.test(p.plan)) return fail('bad_request')
      const target = rt.tasks.find((t) => t.id === p.plan)
      if (!target) return fail('not_found')
      const ap = rt.approvals.find((a) => a.kind === 'plan' && a.taskId === target.id && a.state === 'pending')
      if (!ap) return stale()
      const res = decideApproval(rt, who, ap.id, 'approve', undefined, ctx)
      if (!res.ok) return res
      return { ok: true, rt: res.rt, effects: res.effects, result: {} }
    }

    case 'hire': {
      // 4.3 hire: a role file for the user to approve (desktop only); applied by TeamService through `applying`.
      const h = hireOf(p.text, ctx.def)
      if (!h.ok) return fail(h.error, h.issues ? { current: { issues: h.issues } } : {})
      const added = addApproval(rt, { kind: 'hire', decider: 'user', createdBy: who, payload: { roleId: h.roleId, text: h.text, sha256: sha256Utf8(h.text), baseDefHash: ctx.def.sha256, replaces: h.replaces } }, ctx)
      if (!added.ok) return added
      return { ok: true, rt: added.rt, effects, result: { approvalId: added.id } }
    }

    default:
      return fail('unsupported')
  }
}

/**
 * One write call of an agent's run. Validation order: shape, existence, role
 * (allowedFor), run liveness (active and, for writes, not concluded; a block
 * applied at close admits a stopping run), phase and mode, caps, userOwned.
 * A rejected call changes nothing. Results: create `{id}`, update `{id, rev}`
 * (the rev the commit gives it: one more for a changed task), comment `{id}`;
 * terminal tools (5.3): ask and needs `{cardId, concluded}`, plan, done and hire
 * `{approvalId, concluded}`, the others `{concluded}` (the tool word: `approvePlan`
 * for approve).
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
  if (!allowedFor(run.roleKind, spec, { mode: run.mode, isolation: task?.isolation, hasTask: !!task, profile: run.profile })) return fail('forbidden')
  if (run.concludedBy) return fail('conflict', { reason: 'concluded' })
  if (run.state === 'stopping' && !call.viaBlock) return fail('stopping')
  const who: Actor = { kind: 'agent', agentId: run.agentId, runId: run.id, roleKind: run.roleKind }

  if (spec.terminal) {
    const moved = terminal(rt, run, task, spec.name, p, ctx)
    if (!moved.ok) return moved
    const done = conclude(moved.rt, run.id, spec.terminal, ctx, !!call.viaBlock)
    return { ok: true, rt: done.rt, effects: [...moved.effects, ...done.effects], result: { ...moved.result, concluded: spec.terminal } }
  }

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
      // B7: note.
      return fail('unsupported')
  }
}

/** A block action's params with its `$<n>` refs resolved and its texts redacted; null when a ref names no earlier create. */
function blockParams(params: Record<string, unknown>, created: ReadonlyArray<string | null>): Record<string, unknown> | null {
  const ref = (v: unknown): unknown | null => {
    if (typeof v !== 'string') return v
    const m = TEAM_BLOCK_REF_RE.exec(v)
    if (!m) return v
    return created[Number(m[1]) - 1] ?? null
  }
  const out: Record<string, unknown> = { ...params }
  for (const k of REF_KEYS) {
    if (!(k in out)) continue
    const v = ref(out[k])
    if (v === null) return null
    out[k] = v
  }
  if (Array.isArray(out.blockedBy)) {
    const list: unknown[] = []
    for (const b of out.blockedBy) {
      const v = ref(b)
      if (v === null) return null
      list.push(v)
    }
    out.blockedBy = list
  }
  for (const k of TEXT_KEYS) if (typeof out[k] === 'string') out[k] = redactCredentials(out[k] as string)
  if (Array.isArray(out.options)) out.options = out.options.map((o) => (typeof o === 'string' ? redactCredentials(o) : o))
  return out
}

/**
 * Codex block (R11): applyTool per action in order, resolving TEAM_BLOCK_REF_RE refs from the ids earlier
 * `team.task.create` actions returned; an unresolved ref or a rejected action stops the list there. Always ok: rt and
 * effects of the accepted prefix (the caller commits once), plus where it stopped and why (logged in the run and teams.log).
 */
export function applyBlock(rt: TeamRuntime, actor: Actor & { kind: 'agent' }, block: TeamBlock, ctx: FlowCtx): FlowResult<{ applied: number; stoppedAt?: number; error?: FlowError }> {
  let out = rt
  const effects: TeamEffect[] = []
  // The id each action created (task.create), by its 0-based index; null for any other action.
  const created: Array<string | null> = []
  const actions = block && Array.isArray(block.actions) ? block.actions : []
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    const params = a && typeof a.params === 'object' && a.params !== null && !Array.isArray(a.params) ? blockParams(a.params, created) : null
    if (!params) return { ok: true, rt: out, effects, result: { applied: i, stoppedAt: i, error: 'bad_request' } }
    const res = applyTool(out, actor, { method: a.method, params, viaBlock: true }, ctx)
    if (!res.ok) return { ok: true, rt: out, effects, result: { applied: i, stoppedAt: i, error: res.error } }
    out = res.rt
    effects.push(...res.effects)
    const id = a.method === 'team.task.create' ? (res.result as { id?: unknown } | undefined)?.id : undefined
    created.push(typeof id === 'string' ? id : null)
  }
  return { ok: true, rt: out, effects, result: { applied: actions.length } }
}
