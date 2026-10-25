/**
 * B5 ops (app 2.7.0, E10 B5): Te necesita, approvals and cards. B4 answers
 * `needs` already (the "Por despachar" section reads its queue rows, each with
 * the reason it waits on, from a dispatch dry run); `decide` and `answer`
 * answer `unsupported` until B5 lands.
 */
import { needsView } from '../views'
import { fail, unsupported, type OpTable } from './types'

export const needsOps: Pick<OpTable, 'needs' | 'decide' | 'answer'> = {
  async needs(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    // The dry run first: dropping a dead orphan may commit (its card), so the view is built after it.
    const waiting = svc.dispatchWaiting(req.teamId).byKey
    return { ok: true, needs: needsView(rec, svc.trusted(req.teamId), waiting) }
  },
  decide: unsupported,
  answer: unsupported,
}
