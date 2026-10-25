/**
 * B3 ops (app 2.7.0, E10 B3): the board, the task drawer, the user's task
 * edits and moves, comments and the Lead thread. Every edit is the user's
 * (`ctx.actor`, desktop or phone): it carries the task `rev` and a stale one
 * answers `conflict {rev}` with the current task, so the drawer can show
 * what changed. Reads never touch the disk but for the archived comment
 * counts. B4 adds `resumeTask`, the drawer's Retomar of a stopped task.
 */
import { LEAD_THREAD, type TeamTask } from '@shared/teams'
import type { TaskDetail } from '@shared/team-protocol'
import { addComment, changedScopes, createTask, cycleLoopOf, cycleText, moveTask, releaseOwned, resumeTask, updateTask } from '../flow/tasks'
import type { FlowResult } from '../flow/types'
import { boardPage, commentNumOf, commentView, leadView, needsRowsOf, taskDetail, taskSummary, type TaskViewCtx } from '../views'
import { fail, type OpTable, type TeamInternals, type TeamRecord } from './types'

function viewCtx(svc: TeamInternals, teamId: string, rec: TeamRecord): TaskViewCtx {
  return { def: svc.shownDef(rec), needs: needsRowsOf(rec, svc.trusted(teamId)), archived: (target) => svc.archivedCount(teamId, target) }
}

function detailOf(svc: TeamInternals, teamId: string, rec: TeamRecord, t: TeamTask, commentsBefore?: number): TaskDetail {
  return taskDetail(rec.store.rt, t, {
    ...viewCtx(svc, teamId, rec),
    trusted: svc.trusted(teamId),
    recent: rec.store.recentRuns(),
    lastLineAt: (id) => svc.runLive(id).lastLineAt,
    commentsBefore,
  })
}

/** store.commit with the scopes the result moved (and the task hint). */
function commitTask<R>(svc: TeamInternals, teamId: string, rec: TeamRecord, res: FlowResult<R>, taskId: string): FlowResult<R> {
  if (!res.ok) return res
  return svc.commit(teamId, res, changedScopes(rec.store.rt, res.rt), { taskId })
}

/**
 * A failed task reducer as a reply: a rev conflict carries the current task; a loop of blockers names its tasks as
 * a field (`loop`, the first CYCLE_SHOWN_MAX ids, and `loopMore` for the rest), so the renderer words it without
 * reading `detail`, which keeps the same line the CLI prints (`t-1 -> t-3 -> t-1`).
 */
function taskFail(svc: TeamInternals, teamId: string, rec: TeamRecord, res: Extract<FlowResult<unknown>, { ok: false }>) {
  if (res.error === 'conflict') {
    const cur = res.current as TeamTask | undefined
    const live = cur ? rec.store.rt.tasks.find((t) => t.id === cur.id) : undefined
    return fail('conflict', live ? { reason: res.reason, current: detailOf(svc, teamId, rec, live) } : { reason: res.reason })
  }
  if (res.error === 'cycle') {
    const c = cycleLoopOf(res.current)
    return fail('cycle', c ? { loop: c.loop, ...(c.more > 0 ? { loopMore: c.more } : {}), detail: cycleText(c) } : {})
  }
  return fail(res.error, res.fields ? { fields: res.fields } : {})
}

export const boardOps: Pick<OpTable, 'board' | 'task' | 'createTask' | 'updateTask' | 'moveTask' | 'resumeTask' | 'releaseOwned' | 'comment' | 'lead' | 'leadSay'> = {
  async board(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const page = boardPage(rec.store.rt, req.teamId, viewCtx(svc, req.teamId, rec), { column: req.column, cursor: req.cursor, limit: req.limit })
    return page ? { ok: true, page } : fail('bad_request')
  },

  async task(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const t = rec.store.rt.tasks.find((x) => x.id === req.taskId)
    if (!t) return fail('not_found')
    const before = req.commentsBefore === undefined ? undefined : commentNumOf(req.commentsBefore)
    if (before === null) return fail('bad_request')
    return { ok: true, task: detailOf(svc, req.teamId, rec, t, before) }
  },

  async createTask(req, { svc, actor }) {
    const rec = svc.team(req.teamId)
    const ctx = svc.flowCtx(req.teamId)
    if (!rec) return fail('not_found')
    if (!ctx) return fail('untrusted')
    const made = createTask(rec.store.rt, actor, req.task, ctx)
    const res = made.ok ? commitTask(svc, req.teamId, rec, made, made.result.task.id) : made
    if (!res.ok) return taskFail(svc, req.teamId, rec, res)
    const t = rec.store.rt.tasks.find((x) => x.id === res.result.task.id) ?? res.result.task
    return { ok: true, task: taskSummary(rec.store.rt, t, viewCtx(svc, req.teamId, rec)) }
  },

  async updateTask(req, { svc, actor }) {
    const rec = svc.team(req.teamId)
    const ctx = svc.flowCtx(req.teamId)
    if (!rec) return fail('not_found')
    if (!ctx) return fail('untrusted')
    const res = commitTask(svc, req.teamId, rec, updateTask(rec.store.rt, actor, req.taskId, req.patch, req.baseRev, ctx), req.taskId)
    if (!res.ok) return taskFail(svc, req.teamId, rec, res)
    const t = rec.store.rt.tasks.find((x) => x.id === req.taskId)
    return t ? { ok: true, task: detailOf(svc, req.teamId, rec, t) } : fail('not_found')
  },

  async moveTask(req, { svc, actor }) {
    const rec = svc.team(req.teamId)
    const ctx = svc.flowCtx(req.teamId)
    if (!rec) return fail('not_found')
    if (!ctx) return fail('untrusted')
    const o: { priority?: typeof req.priority; stopRun?: boolean; text?: string } = {}
    if (req.priority !== undefined) o.priority = req.priority
    if (req.stopRun !== undefined) o.stopRun = req.stopRun
    if (req.text !== undefined) o.text = req.text
    const res = commitTask(svc, req.teamId, rec, moveTask(rec.store.rt, actor, req.taskId, req.to, req.baseRev, o, ctx), req.taskId)
    if (!res.ok) return taskFail(svc, req.teamId, rec, res)
    svc.log(`task ${req.teamId} ${req.taskId} moved to ${req.to}${req.stopRun ? ' (run stopped)' : ''}`)
    const t = rec.store.rt.tasks.find((x) => x.id === req.taskId)
    return t ? { ok: true, task: taskSummary(rec.store.rt, t, viewCtx(svc, req.teamId, rec)) } : fail('not_found')
  },

  /**
   * B4, decision 38: the drawer's Retomar of a task the user stopped, and B5 of a task blocked on a card (a prep
   * failure the user dismissed; a deps block only by its level): T17 puts it back in the pair it was blocked in with a
   * retry level for that phase's agent, which then dispatches like any other (Por despachar with autonomy off). The op
   * also takes a card block whose card is still open and dismisses that card in the same result; the drawer offers
   * Retomar only once the card is closed (an open card resumes by its own action).
   */
  async resumeTask(req, { svc, actor }) {
    const rec = svc.team(req.teamId)
    const ctx = svc.flowCtx(req.teamId)
    if (!rec) return fail('not_found')
    if (!ctx) return fail('untrusted')
    const cur = rec.store.rt.tasks.find((x) => x.id === req.taskId)
    if (!cur) return fail('not_found')
    // B5: a task blocked on a card (a prep failure the user dismissed, design T17) resumes the same way, and like the
    // card's Reintentar its level leaves the prep backoff (the user asked for it now).
    const reason = cur.blocked?.reason
    const kind = reason?.kind
    if (cur.state !== 'blocked' || (kind !== 'stopped' && kind !== 'card')) return fail('conflict', { reason: 'stale', current: detailOf(svc, req.teamId, rec, cur) })
    const res = commitTask(svc, req.teamId, rec, resumeTask(rec.store.rt, actor, req.taskId, ctx), req.taskId)
    if (!res.ok) return taskFail(svc, req.teamId, rec, res)
    if (reason?.kind === 'card') svc.liftPrepBackoff(req.teamId, reason.cardId)
    svc.log(`task ${req.teamId} ${req.taskId} resumed`)
    const t = rec.store.rt.tasks.find((x) => x.id === req.taskId)
    return t ? { ok: true, task: taskSummary(rec.store.rt, t, viewCtx(svc, req.teamId, rec)) } : fail('not_found')
  },

  async releaseOwned(req, { svc, now }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const res = commitTask(svc, req.teamId, rec, releaseOwned(rec.store.rt, req.taskId, req.fields, { now }), req.taskId)
    if (!res.ok) return taskFail(svc, req.teamId, rec, res)
    const t = rec.store.rt.tasks.find((x) => x.id === req.taskId)
    return t ? { ok: true, task: taskSummary(rec.store.rt, t, viewCtx(svc, req.teamId, rec)) } : fail('not_found')
  },

  async comment(req, { svc, actor, now }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const res = commitTask(svc, req.teamId, rec, addComment(rec.store.rt, actor, req.taskId, req.text, 'comment', { now }), req.taskId)
    if (!res.ok) return fail(res.error)
    return { ok: true, comment: commentView(rec.store.rt, svc.shownDef(rec), res.result.comment) }
  },

  async lead(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const before = req.before === undefined ? undefined : commentNumOf(req.before)
    if (before === null) return fail('bad_request')
    const lead = leadView(rec.store.rt, svc.shownDef(rec), { before, recent: rec.store.recentRuns(), lastLineAt: (id) => svc.runLive(id).lastLineAt })
    return { ok: true, lead }
  },

  async leadSay(req, { svc, actor, now }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const made = addComment(rec.store.rt, actor, LEAD_THREAD, req.text, 'comment', { now })
    const res = made.ok ? svc.commit(req.teamId, made, changedScopes(rec.store.rt, made.rt)) : made
    if (!res.ok) return fail(res.error)
    return { ok: true, comment: commentView(rec.store.rt, svc.shownDef(rec), res.result.comment) }
  },
}
