import { app, ipcMain, powerMonitor, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import { isPortable } from '../paths'
import { openExternalSafe } from '../openExternal'

/**
 * OS login-item integration. No-op on the portable build because the executable
 * path is not stable there (registering it would point at a transient location).
 */
export function registerSystemIpc(getSender: () => WebContents | null): void {
  ipcMain.handle(CH.SYSTEM_SET_LOGIN_ITEM, (_e, enabled: boolean): void => {
    if (isPortable()) return
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
  })

  ipcMain.handle(CH.SYSTEM_GET_LOGIN_ITEM, (): boolean => {
    if (isPortable()) return false
    return app.getLoginItemSettings().openAtLogin
  })

  // Terminal hyperlinks (and any renderer "open in browser" action) route here.
  ipcMain.on(CH.SHELL_OPEN_EXTERNAL, (_e, url: unknown) => openExternalSafe(url))

  // Sleep/resume, screen unlock, and GPU process crashes can bring WebGL back
  // with trashed texture memory: the terminal layout survives but every cell
  // draws the wrong glyph from the corrupted atlas. Tell the renderer so each
  // terminal rebuilds its atlas and repaints.
  const notifyDisplayRecovered = (): void => {
    getSender()?.send(CH.SYSTEM_DISPLAY_RECOVERED)
  }
  powerMonitor.on('resume', notifyDisplayRecovered)
  powerMonitor.on('unlock-screen', notifyDisplayRecovered)
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') notifyDisplayRecovered()
  })
}
