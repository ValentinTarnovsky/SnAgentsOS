import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  PtyFlowReq,
  PtyReattachRes,
  PtyResizeReq,
  PtySpawnReq,
  PtySpawnRes,
  PtyWriteReq,
} from '@shared/ipc-contract'
import type { PtyManager } from '../pty/PtyManager'

export function registerPtyIpc(manager: PtyManager): void {
  ipcMain.handle(CH.PTY_SPAWN, (_e, req: PtySpawnReq): PtySpawnRes => ({
    ptyId: manager.spawn(req),
  }))

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
}
