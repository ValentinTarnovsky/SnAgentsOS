/**
 * B2 ops (app 2.7.0, E10 B2): the roster, "Ejecutar ahora" (free mode for
 * the agents, lead mode for the Lead; a task run waits for B4's Dispatcher),
 * stop, the agent pause, the run list and the run chat pages. Paths never
 * leave main: the run log is found from the team and run ids.
 */
import { join } from 'path'
import { CHAT_FRAME_MAX_BYTES } from '@shared/chat-types'
import { isActiveRun, type Run } from '@shared/teams'
import { requestStop, setAgentPaused } from '../flow/runs'
import { RunLog } from '../RunLog'
import { agentView, runView } from '../views'
import { fail, type OpTable, type TeamRecord } from './types'

/** Runs per `runs` page. */
export const RUNS_PAGE = 20

/** An active run, else the newest copy in the runs ring. */
function findRun(rec: TeamRecord, runId: string): Run | undefined {
  const active = rec.store.rt.activeRuns.find((r) => r.id === runId)
  if (active) return active
  const ring = rec.store.recentRuns()
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i].id === runId) return ring[i]
  return undefined
}

export const runOps: Pick<OpTable, 'roster' | 'runNow' | 'stop' | 'pauseAgent' | 'runs' | 'runPage' | 'watchRun'> = {
  async roster(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const rt = rec.store.rt
    const def = svc.shownDef(rec)
    const recent = rec.store.recentRuns()
    const agents = rt.agents.map((a) => agentView(rt, def, a, recent, (id) => svc.runLive(id).lastLineAt))
    return { ok: true, agents, rev: rt.rev }
  },

  async runNow(req, { svc }) {
    // B4 routes task runs through the Dispatcher (plan, exec and qa phases).
    if (req.taskId) return fail('unsupported')
    const r = svc.runManual(req.teamId, req.agentId, req.prompt)
    return 'runId' in r ? { ok: true, runId: r.runId } : r
  },

  async stop(req, { svc, now }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const run = findRun(rec, req.runId)
    if (!run) return fail('not_found')
    // Already over: nothing to stop, the user's intent holds.
    if (!isActiveRun(run.state)) return { ok: true }
    const res = svc.commit(req.teamId, requestStop(rec.store.rt, req.runId, 'user', { now }), ['agents', 'run'], { runId: req.runId })
    if (!res.ok) return fail(res.error)
    svc.log(`run ${req.runId} stop requested by the user`)
    return { ok: true }
  },

  async pauseAgent(req, { svc, now }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const res = svc.commit(req.teamId, setAgentPaused(rec.store.rt, req.agentId, req.on, { now }), ['agents'])
    if (!res.ok) return fail(res.error)
    return { ok: true }
  },

  async runs(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const seen = new Set<string>()
    const all: Run[] = []
    for (const r of [...rec.store.rt.activeRuns, ...[...rec.store.recentRuns()].reverse()]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      if (req.agentId && r.agentId !== req.agentId) continue
      if (req.taskId && r.taskId !== req.taskId) continue
      if (req.before !== undefined && r.queuedAt >= req.before) continue
      all.push(r)
    }
    // Newest first, ties by run id. The cursor is a queuedAt and the next page takes only older ones, so a page
    // never ends inside a group that shares one (a pass admits several runs at the same now): it stops before
    // the group, or takes it whole when the group starts the page.
    all.sort((a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    let end = Math.min(RUNS_PAGE, all.length)
    if (end < all.length && all[end].queuedAt === all[end - 1].queuedAt) {
      let start = end - 1
      while (start > 0 && all[start - 1].queuedAt === all[end].queuedAt) start--
      if (start > 0) end = start
      else while (end < all.length && all[end].queuedAt === all[0].queuedAt) end++
    }
    const page = all.slice(0, end)
    const runs = page.map((r) => runView(r, svc.runLive(r.id)))
    return { ok: true, runs, cursor: end < all.length ? page[page.length - 1].queuedAt : null }
  },

  async runPage(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const run = findRun(rec, req.runId)
    if (!run) return fail('not_found')
    const file = join(svc.dataDir(), 'teams', req.teamId, 'runs', `${run.id}.jsonl`)
    const live = svc.runLive(run.id)
    const before = req.before === undefined ? null : Number(req.before)
    const page = await RunLog.page(file, run.provider, run.id, before, CHAT_FRAME_MAX_BYTES, live.ring, live.cutAt)
    return { ok: true, run: runView(run, live), items: page.items, cursor: page.cursor, done: page.done, live: isActiveRun(run.state) }
  },

  async watchRun(req, { svc }) {
    if (req.runId === null) {
      svc.watchRun(req.teamId, null)
      return { ok: true }
    }
    const rec = svc.team(req.teamId)
    if (!rec || !findRun(rec, req.runId)) return fail('not_found')
    svc.watchRun(req.teamId, req.runId)
    return { ok: true }
  },
}
