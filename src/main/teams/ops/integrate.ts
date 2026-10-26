/**
 * B6 ops (app 2.7.0, E10 B6, design 3.7, 4.2 T13 to T15 and 6.1): Integrar.
 * `integratePreview` reads (tips, counts, the diff stat, the verify command,
 * where it would land); `integrate` starts one with the tip the preview showed
 * (`expectTip`) and answers its id, its steps arrive as
 * teams:integrateProgress; `askRebase` sends a task whose integrate failed on
 * a conflict or on the verify back to its Dev (T15); `confirmVerify` records
 * the user's OK of the exact verify command of the trusted definition (never
 * a command from anywhere else); `removeWorktree` removes a done or cancelled
 * task's tree and branch. None is a phone op (decision 50: Integrar stays on
 * the desktop; TeamService.request refuses them from the phone).
 */
import { REPO_MAIN } from '@shared/teams'
import { verifyCommandOk } from '@shared/verifyDetect'
import { askRebase, confirmVerify } from '../flow/integrate'
import { changedScopes } from '../flow/tasks'
import { sha256Hex } from '../TeamTrust'
import { teamView } from '../views'
import { fail, type OpTable } from './types'

export const integrateOps: Pick<OpTable, 'integratePreview' | 'integrate' | 'askRebase' | 'confirmVerify' | 'removeWorktree'> = {
  async integratePreview(req, { svc }) {
    const res = await svc.integratePreview(req.teamId, req.taskId)
    return 'ok' in res ? res : { ok: true, preview: res.preview }
  },

  async integrate(req, { svc, actor }) {
    const res = await svc.integrate(req.teamId, req.taskId, req.expectTip, actor)
    return 'ok' in res ? res : { ok: true, integrationId: res.integrationId }
  },

  async askRebase(req, { svc, actor }) {
    const rec = svc.team(req.teamId)
    const ctx = svc.flowCtx(req.teamId)
    if (!rec) return fail('not_found')
    if (!ctx) return fail('untrusted')
    const res = askRebase(rec.store.rt, req.taskId, req.why, actor, ctx)
    if (!res.ok) return fail(res.error, res.reason ? { reason: res.reason } : {})
    svc.commit(req.teamId, res, [...new Set([...changedScopes(rec.store.rt, res.rt), 'needs' as const])], { taskId: req.taskId })
    svc.log(`integrate ${req.teamId} ${req.taskId} rebase asked (${req.why})`)
    return { ok: true }
  },

  /**
   * Only the command the trusted definition declares for that repo (`verify` of team.md, or of its `repo.<id>`), as
   * the user saw it: another text -> `conflict {stale}` (the definition changed under the dialog), no command
   * declared -> `bad_request`. Its sha256 is what an integrate compares before it runs anything.
   */
  async confirmVerify(req, { svc }) {
    const rec = svc.team(req.teamId)
    const def = svc.trusted(req.teamId)
    const ctx = svc.flowCtx(req.teamId)
    if (!rec) return fail('not_found')
    if (!def || !ctx) return fail('untrusted')
    if (!verifyCommandOk(req.command)) return fail('bad_request')
    const declared = req.repoId === REPO_MAIN ? def.def.verify : def.def.extraRepos.find((r) => r.id === req.repoId)?.verify
    if (req.repoId !== REPO_MAIN && !def.def.extraRepos.some((r) => r.id === req.repoId)) return fail('not_found')
    if (!declared) return fail('bad_request', { detail: 'noVerify' })
    if (declared !== req.command) return fail('conflict', { reason: 'stale' })
    const res = confirmVerify(rec.store.rt, req.repoId, req.command, sha256Hex(req.command), ctx)
    if (!res.ok) return fail(res.error)
    svc.commit(req.teamId, res, ['team'])
    svc.log(`verify ${req.teamId} ${req.repoId} confirmed`)
    return { ok: true, team: teamView(rec, svc.shownDef(rec), def, svc.now()) }
  },

  async removeWorktree(req, { svc }) {
    const failed = await svc.removeTaskWorktree(req.teamId, req.taskId)
    return failed ?? { ok: true }
  },
}
