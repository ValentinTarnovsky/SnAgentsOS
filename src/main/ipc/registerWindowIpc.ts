import { BrowserWindow, ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'

/**
 * Window controls for the custom frameless title bar. The renderer drives
 * minimize/maximize/close; the main process forwards maximize-state changes
 * back so the title bar can swap its restore/maximize icon.
 */
export function registerWindowIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.on(CH.WINDOW_MINIMIZE, () => getWindow()?.minimize())

  ipcMain.on(CH.WINDOW_MAXIMIZE, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(CH.WINDOW_CLOSE, () => getWindow()?.close())

  ipcMain.handle(CH.WINDOW_IS_MAXIMIZED, (): boolean => getWindow()?.isMaximized() ?? false)
}

/** Forward maximize/unmaximize events to the renderer for the given window. */
export function wireWindowMaximizeEvents(win: BrowserWindow): void {
  const send = (maximized: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send(CH.WINDOW_MAXIMIZE_CHANGED, maximized)
  }
  win.on('maximize', () => send(true))
  win.on('unmaximize', () => send(false))
}
