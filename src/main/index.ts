import { readFileSync, writeFileSync } from 'fs'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, session } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { AppInfo, AppMetrics } from '@shared/ipc-contract'
import type { ConfigFile } from '@shared/types'
import { createMainWindow } from './window'
import { getConfigPath, isPortable } from './paths'
import { PtyManager } from './pty/PtyManager'
import { ConfigStore } from './store/ConfigStore'
import { parseConfig } from './store/schema'
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

/** Bring the window to the front from anywhere (tray / global hotkey). */
function showWindow(): void {
  if (!mainWindow) {
    openMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

let currentHotkey: string | null = null

/** (Re)register the global show-app shortcut. Returns false if binding failed. */
function applyGlobalHotkey(enabled: boolean, accelerator: string): boolean {
  if (currentHotkey) {
    try {
      globalShortcut.unregister(currentHotkey)
    } catch {
      /* ignore */
    }
    currentHotkey = null
  }
  if (!enabled || !accelerator || !accelerator.trim()) return true
  try {
    const ok = globalShortcut.register(accelerator, showWindow)
    if (ok) currentHotkey = accelerator
    return ok
  } catch {
    return false
  }
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

  ipcMain.handle(CH.CONFIG_EXPORT, async (_e, config: ConfigFile): Promise<boolean> => {
    const opts = {
      defaultPath: 'snmulticc-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const res = mainWindow
      ? await dialog.showSaveDialog(mainWindow, opts)
      : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return false
    try {
      writeFileSync(res.filePath, JSON.stringify(config, null, 2), 'utf8')
      return true
    } catch (error) {
      console.error('Config export failed:', error)
      return false
    }
  })

  ipcMain.handle(CH.CONFIG_IMPORT, async (): Promise<ConfigFile | null> => {
    const opts = {
      properties: ['openFile' as const],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    try {
      return parseConfig(JSON.parse(readFileSync(res.filePaths[0], 'utf8')))
    } catch (error) {
      console.error('Config import failed:', error)
      return null
    }
  })
}

function registerClipboardIpc(): void {
  ipcMain.on(CH.CLIPBOARD_WRITE, (_e, text: string) => clipboard.writeText(String(text ?? '')))
  ipcMain.handle(CH.CLIPBOARD_READ, (): string => clipboard.readText())
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

function bootstrap(): void {
  registerCsp()
  registerAppIpc()
  registerConfigIpc()
  registerDialogIpc()
  registerClipboardIpc()
  registerPtyIpc(ptyManager)
  registerWindowIpc(() => mainWindow)
  registerSystemIpc()
  ipcMain.handle(CH.SYSTEM_SET_HOTKEY, (_e, p: { enabled: boolean; accelerator: string }) =>
    applyGlobalHotkey(p.enabled, p.accelerator),
  )
  ipcMain.handle(CH.SYSTEM_METRICS, (): AppMetrics => {
    const metrics = app.getAppMetrics()
    let memKB = 0
    let cpu = 0
    for (const m of metrics) {
      memKB += m.memory?.workingSetSize ?? 0
      cpu += m.cpu?.percentCPUUsage ?? 0
    }
    return {
      memMB: Math.round(memKB / 1024),
      cpuPercent: Math.round(cpu * 10) / 10,
      processes: metrics.length,
      consoles: ptyManager.count,
    }
  })
  openMainWindow()

  const startupCfg = configStore.load()
  if (startupCfg?.settings) {
    applyGlobalHotkey(startupCfg.settings.globalHotkeyEnabled, startupCfg.settings.globalHotkey)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
}

// Single-instance lock: if another copy is already running (e.g. hidden in the
// system tray), hand off to it and quit this one instead of opening a duplicate.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(bootstrap)
}

app.on('before-quit', () => {
  isQuitting = true
  ptyManager.killAll()
  destroyTray()
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  ptyManager.killAll()
  if (process.platform !== 'darwin') app.quit()
})
