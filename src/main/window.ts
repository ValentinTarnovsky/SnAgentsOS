import { join } from 'path'
import { BrowserWindow } from 'electron'
import { BRAND } from '@shared/brand'
import { openExternalSafe } from './openExternal'
import { isPortable, portableExeFile } from './paths'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0f19',
    autoHideMenuBar: true,
    // Custom frameless title bar, controls live in the renderer (TitleBar.tsx).
    frame: false,
    title: BRAND.productName,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Portable (app 2.4.0): the process runs from a %TEMP% extraction, so a
  // taskbar pin would point there and break on the next launch. These details
  // make the pin (and its relaunch) target the stable portable .exe.
  const portableExe = isPortable() ? portableExeFile() : null
  if (process.platform === 'win32' && portableExe) {
    try {
      win.setAppDetails({
        appId: BRAND.appId,
        appIconPath: portableExe,
        relaunchCommand: `"${portableExe}"`,
        relaunchDisplayName: BRAND.productName,
      })
    } catch (err) {
      console.warn('[window] setAppDetails failed:', err)
    }
  }

  // The app ships no native menu (see Menu.setApplicationMenu(null) in main),
  // which also drops the default DevTools accelerators. Re-add a DevTools
  // toggle in dev only so debugging still works; production stays locked down.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      const key = input.key
      // Ctrl+Shift+Alt+K kills the renderer to exercise the crash recovery
      // (E4-FR-21). Checked first so the combo never reaches DevTools.
      if (input.control && input.shift && input.alt && (key === 'K' || key === 'k')) {
        e.preventDefault()
        win.webContents.forcefullyCrashRenderer()
        return
      }
      const bareF12 = key === 'F12' && !input.control && !input.shift && !input.alt && !input.meta
      if (bareF12 || (input.control && input.shift && !input.alt && (key === 'I' || key === 'i'))) {
        win.webContents.toggleDevTools()
      }
    })
  }

  // Open external links in the OS browser, never in-app. The safe-protocol
  // filter stops stray window.open() calls (e.g. about:blank) from reaching
  // the OS and triggering a "no app for this protocol" prompt.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
