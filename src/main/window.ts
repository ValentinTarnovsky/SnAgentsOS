import { join } from 'path'
import { BrowserWindow } from 'electron'
import { openExternalSafe } from './openExternal'

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
    title: 'SnMultiCC',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

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
