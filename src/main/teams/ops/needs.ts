/**
 * B5 ops (app 2.7.0, E10 B5, design 4.3, 4.5 and 6.1): Te necesita, approvals
 * and cards. `needs` answers the trust state, the pause, the approvals that
 * wait (full bodies: the plan text, the hire diff and its risks), the open
 * cards and B4's "Por despachar" rows, each with the reason it waits on (a
 * dispatch dry run). `decide` and `answer` check the origin before any reducer
 * (decision 50): from the phone a hire decide (it rewrites a role file and
 * re-trusts) and a desktop-only card action (`resumeTeam` lifts an auth or
 * billing pause, `killOrphan` signals a process) answer `forbidden`; a decide
 * on an `integrate` approval answers `bad_request` from every origin (only
 * the `integrate` op with its `expectTip` lands a merge).
 */
import { DESKTOP_ONLY_CARD_ACTIONS } from '@shared/teams'
import { needsView } from '../views'
import { fail, type OpTable } from './types'

export const needsOps: Pick<OpTable, 'needs' | 'decide' | 'answer'> = {
  async needs(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    // The dry run first: dropping a dead orphan may commit (its card), so the view is built after it.
    const waiting = svc.dispatchWaiting(req.teamId).byKey
    return { ok: true, needs: needsView(rec, svc.trusted(req.teamId), waiting) }
  },

  async decide(req, { svc, origin, actor }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const ap = rec.store.rt.approvals.find((a) => a.id === req.approvalId)
    if (!ap) return fail('not_found')
    if (ap.kind === 'integrate') return fail('bad_request')
    if (origin === 'phone' && ap.kind === 'hire') return fail('forbidden')
    const failed = await svc.decide(req.teamId, req.approvalId, req.decision, req.note, actor)
    return failed ?? { ok: true }
  },

  async answer(req, { svc, origin, actor }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    if (!rec.store.rt.cards.some((c) => c.id === req.cardId)) return fail('not_found')
    if (origin === 'phone' && req.answer.action && DESKTOP_ONLY_CARD_ACTIONS.includes(req.answer.action)) return fail('forbidden')
    const failed = await svc.answer(req.teamId, req.cardId, req.answer, actor)
    return failed ?? { ok: true }
  },
}
