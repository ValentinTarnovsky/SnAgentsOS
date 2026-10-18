import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  PtyFlowReq,
  PtyReattachRes,
  PtyResizeReq,
  PtyRestartReq,
  PtyRestartRes,
  PtySpawnReq,
  PtySpawnRes,
  PtyWriteReq,
} from '@shared/ipc-contract'
import type { PtyManager } from '../pty/PtyManager'

/**
 * `restartLabel` gives the localized separator text for an in-place restart
 * ("restarted 14:32"), read from the current config language.
 */
export function registerPtyIpc(manager: PtyManager, restartLabel: () => string = () => 'restarted'): void {
  ipcMain.handle(CH.PTY_SPAWN, (_e, req: PtySpawnReq): PtySpawnRes => manager.spawn(req))

  // In-place restart (E6-FR-18/19): rejects when the new shell fails to spawn.
  ipcMain.handle(CH.PTY_RESTART, (_e, req: PtyRestartReq): PtyRestartRes => manager.restart(req, restartLabel()))

  ipcMain.handle(
    CH.PTY_REATTACH,
    (_e, paneId: string): PtyReattachRes | null => manager.reattach(paneId),
  )

  // High-frequency, fire-and-forget channels use send (not invoke).
  ipcMain.on(CH.PTY_WRITE, (_e, req: PtyWriteReq) => manager.write(req.ptyId, req.data))
  ipcMain.on(CH.PTY_RESIZE, (_e, req: PtyResizeReq) =>
    manager.resize(req.ptyId, req.cols, req.rows),
  )
  ipcMain.on(CH.PTY_SET_ACTIVE, (_e, paneIds: string[]) => manager.setActive(paneIds))
  ipcMain.on(CH.PTY_FLOW, (_e, req: PtyFlowReq) => manager.setFlow(req.ptyId, req.pause))

  ipcMain.handle(CH.PTY_KILL, (_e, ptyId: string) => manager.kill(ptyId))

  // Explicit lifecycle (E4-FR-36): an unmount never kills, these do, by paneId.
  ipcMain.handle(CH.PTY_KILL_PANES, (_e, paneIds: unknown): number => manager.killPanes(paneIdList(paneIds)))
  ipcMain.handle(CH.PTY_RECONCILE, (_e, livePaneIds: unknown): number => {
    // A malformed list must never read as "no panes" and kill everything.
    if (!Array.isArray(livePaneIds)) return 0
    return manager.reconcile(paneIdList(livePaneIds))
  })
}

/** The string entries of an IPC paneId list (anything else is dropped). */
function paneIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}
