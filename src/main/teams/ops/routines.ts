/**
 * B7 ops (app 2.7.0, E10 B7, design 3.8 and 6.1): the routines panel (read only: routines live in the team files and
 * change only through a trust), "Correr ahora", the team notes the Lead writes with `snaos team note` (the daily
 * summary among them; a second WsNoteStore under dataDir()/teams, never the workspace notes) and the silence ack of a
 * live run. Only ids come from the renderer: a note is found from the team and note ids, never a path.
 */
import { fail, type OpTable } from './types'

export const routineOps: Pick<OpTable, 'routines' | 'routineRun' | 'notes' | 'note' | 'runSilenceAck'> = {
  async routines(req, { svc }) {
    if (!svc.team(req.teamId)) return fail('not_found')
    return { ok: true, routines: svc.routineViews(req.teamId) }
  },

  async routineRun(req, { svc }) {
    const r = svc.runRoutine(req.teamId, req.routineId)
    if ('ok' in r) return r
    svc.log(`routine ${req.teamId} ${req.routineId} run by the user${r.runId ? ` run=${r.runId}` : ''}${r.taskId ? ` task=${r.taskId}` : ''}`)
    return { ok: true, ...r }
  },

  async notes(req, { svc }) {
    if (!svc.team(req.teamId)) return fail('not_found')
    const r = await svc.teamNotes(req.teamId)
    return 'ok' in r ? r : { ok: true, notes: r.notes }
  },

  async note(req, { svc }) {
    if (!svc.team(req.teamId)) return fail('not_found')
    const r = await svc.teamNote(req.teamId, req.noteId)
    return 'ok' in r ? r : { ok: true, title: r.title, text: r.text, updatedAt: r.updatedAt }
  },

  async runSilenceAck(req, { svc }) {
    if (!svc.team(req.teamId)) return fail('not_found')
    return svc.ackRunSilence(req.teamId, req.runId) ?? { ok: true }
  },
}
