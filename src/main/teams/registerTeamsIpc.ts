import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import { teamRequestSchema } from '@shared/team-protocol-schemas'
import type { TeamReply, TeamRequest } from '@shared/team-protocol'
import type { TeamService } from './TeamService'

/**
 * `teams:req` (app 2.7.0, E10 B1): the one Teams invoke. Registered always,
 * Labs on or off (TeamService answers `disabled`), before the window opens.
 * The payload is validated here with the whole zod union; a bad one answers
 * `bad_request` and never reaches the service, which never throws.
 */
export function registerTeamsIpc(svc: Pick<TeamService, 'request'>): void {
  ipcMain.handle(CH.TEAMS_REQ, async (_e, raw: unknown): Promise<TeamReply> => {
    const p = teamRequestSchema.safeParse(raw)
    if (!p.success) return { ok: false, error: 'bad_request' }
    try {
      return await svc.request(p.data as TeamRequest, 'desktop')
    } catch {
      return { ok: false, error: 'io' }
    }
  })
}
