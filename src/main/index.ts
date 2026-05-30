import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { AppInfo } from '@shared/ipc-contract'
import type { ConfigFile } from '@shared/types'
import { createMainWindow } from './window'
import { getConfigPath, isPortable } from './paths'
import { PtyManager } from './pty/PtyManager'
import { ConfigStore } from './store/ConfigStore'
import { registerPtyIpc } from './ipc/registerPtyIpc'
import { registerWindowIpc, wireWindowMaximizeEvents } from './ipc/registerWindowIpc'
import { registerSystemIpc } from './ipc/registerSystemIpc'
import { ensureTray, destroyTray } from './tray'
import { mainT } from './i18n'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

let mainWindow: BrowserWindow | null = null
let isQuitting = false
const ptyManager = new PtyManager(() => mainWindow?.webContents ?? null)
const configStore = new ConfigStore()

function quitApp(): void {
  isQuitting = true
  app.quit()
}

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

function registerConfigIpc(): void {
  ipcMain.handle(CH.CONFIG_LOAD, (): ConfigFile | null => configStore.load())
  ipcMain.on(CH.CONFIG_SAVE, (_e, config: ConfigFile) => configStore.save(config))
}

function registerDialogIpc(): void {
  ipcMain.handle(CH.DIALOG_OPEN_DIR, async (): Promise<string | null> => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}

function openMainWindow(): void {
  mainWindow = createMainWindow()
  const win = mainWindow
  wireWindowMaximizeEvents(win)

  let forceClose = false
  win.on('close', (event) => {
    const cfg = configStore.load()
    // Installed build: hide to tray instead of quitting (keeps consoles running).
    const useTray = !isPortable() && cfg?.settings?.closeToTray !== false
    if (useTray && !isQuitting) {
      event.preventDefault()
      win.hide()
      ensureTray(() => mainWindow, quitApp, {
        show: mainT(cfg, 'tray.show'),
        quit: mainT(cfg, 'tray.quit'),
      })
      return
    }
    if (forceClose) return
    const shouldConfirm = cfg?.settings?.confirmCloseRunning !== false
    if (shouldConfirm && ptyManager.count > 0) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: [mainT(cfg, 'dialog.cancel'), mainT(cfg, 'dialog.closeAnyway')],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        title: 'SnMultiCC',
        message: mainT(cfg, 'dialog.activeTitle'),
        detail: mainT(cfg, 'dialog.activeDetail', { n: ptyManager.count }),
      })
      if (choice === 0) {
        event.preventDefault()
        isQuitting = false
        return
      }
    }
    forceClose = true
  })

  win.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  registerCsp()
  registerAppIpc()
  registerConfigIpc()
  registerDialogIpc()
  registerPtyIpc(ptyManager)
  registerWindowIpc(() => mainWindow)
  registerSystemIpc()
  openMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  ptyManager.killAll()
  destroyTray()
})

app.on('window-all-closed', () => {
  ptyManager.killAll()
  if (process.platform !== 'darwin') app.quit()
})
