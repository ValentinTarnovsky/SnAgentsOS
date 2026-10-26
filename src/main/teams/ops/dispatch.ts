/**
 * B4 ops (app 2.7.0, E10 B4): "Por despachar" and the kickoff. `dispatch`
 * approves (`go`) or discards one queue item or `all` of them: an approved
 * item skips only the autonomy gate (decision 18), so its row keeps showing
 * the reason it still waits on. `kickoff` asks the Lead to turn the goal into
 * tasks now (decision 43), through the same manual pass as "Ejecutar ahora".
 * Both are trust-gated by TeamService.request (`dispatch` only with `go`).
 */
import { QUEUE_ID_RE } from '@shared/teams'
import { fail, type OpTable } from './types'

export const dispatchOps: Pick<OpTable, 'dispatch' | 'kickoff'> = {
  async dispatch(req, { svc, actor }) {
    if (req.queueId !== 'all' && !QUEUE_ID_RE.test(req.queueId)) return fail('bad_request')
    const r = svc.dispatchQueue(req.teamId, req.queueId, req.go, actor)
    return 'approved' in r ? { ok: true, approved: r.approved, dropped: r.dropped } : r
  },

  async kickoff(req, { svc }) {
    const r = svc.kickoff(req.teamId)
    return 'runId' in r ? { ok: true, runId: r.runId } : r
  },
}
