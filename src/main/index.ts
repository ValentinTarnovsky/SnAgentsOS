import { app, BrowserWindow, ipcMain, session } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { AppInfo } from '@shared/ipc-contract'
import { createMainWindow } from './window'
import { getConfigPath, isPortable } from './paths'
import { PtyManager } from './pty/PtyManager'
import { registerPtyIpc } from './ipc/registerPtyIpc'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

let mainWindow: BrowserWindow | null = null
const ptyManager = new PtyManager(() => mainWindow?.webContents ?? null)

function registerCsp(): void {
  const csp = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*;"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

function registerAppIpc(): void {
  ipcMain.handle(
    CH.APP_INFO,
    (): AppInfo => ({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      portable: isPortable(),
      configPath: getConfigPath(),
    }),
  )
}

function openMainWindow(): void {
  mainWindow = createMainWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  registerCsp()
  registerAppIpc()
  registerPtyIpc(ptyManager)
  openMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('before-quit', () => ptyManager.killAll())

app.on('window-all-closed', () => {
  ptyManager.killAll()
  if (process.platform !== 'darwin') app.quit()
})
