import { app, ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import { isPortable } from '../paths'

/**
 * OS login-item integration. No-op on the portable build because the executable
 * path is not stable there (registering it would point at a transient location).
 */
export function registerSystemIpc(): void {
  ipcMain.handle(CH.SYSTEM_SET_LOGIN_ITEM, (_e, enabled: boolean): void => {
    if (isPortable()) return
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
  })

  ipcMain.handle(CH.SYSTEM_GET_LOGIN_ITEM, (): boolean => {
    if (isPortable()) return false
    return app.getLoginItemSettings().openAtLogin
  })
}
