import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
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

  // High-frequency, fire-and-forget channels use send (not invoke).
  ipcMain.on(CH.PTY_WRITE, (_e, req: PtyWriteReq) => manager.write(req.ptyId, req.data))
  ipcMain.on(CH.PTY_RESIZE, (_e, req: PtyResizeReq) =>
    manager.resize(req.ptyId, req.cols, req.rows),
  )

  ipcMain.handle(CH.PTY_KILL, (_e, ptyId: string) => manager.kill(ptyId))
}
