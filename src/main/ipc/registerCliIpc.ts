import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { CliUiState, SkillStatus } from '@shared/ctl-protocol'
import type { RemoteCommandResult } from '@shared/ipc-contract'
import type { CliService } from '../cli/CliService'
import { parseSkillRequest } from '../cli/skillInstaller'

/**
 * snaos CLI IPC (E8-FR-21/22): the switch (contract `cli:setEnabled`), the
 * Settings state, the skill and the user PATH. The CLI's renderer ops come
 * back on remote:controlResult, next to RemoteManager's listener: each side
 * only takes the ids it sent.
 */
export function registerCliIpc(cli: CliService): void {
  ipcMain.on(CH.CLI_SET_ENABLED, (_e, enabled: unknown) => {
    void cli.setEnabled(enabled === true)
  })
  ipcMain.handle(CH.CLI_STATE, (): Promise<CliUiState> => cli.uiState())
  ipcMain.handle(CH.CLI_SKILL, (_e, req: unknown): SkillStatus => {
    const { op, target } = parseSkillRequest(req)
    return cli.skill(op, target)
  })
  ipcMain.handle(CH.CLI_USER_PATH, (_e, on: unknown): Promise<boolean> => cli.setUserPath(on === true))
  ipcMain.on(CH.REMOTE_CONTROL_RESULT, (_e, res: RemoteCommandResult) => cli.bus.onResult(res))
}
