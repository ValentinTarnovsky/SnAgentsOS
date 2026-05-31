import { existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'

let tray: Tray | null = null

export interface TrayLabels {
  show: string
  quit: string
}

function trayIconPath(): string {
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.png'),
    join(app.getAppPath(), '..', 'build', 'icon.png'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return candidates[0]
}

/**
 * Lazily creates the system tray (installed build only). Idempotent, calling
 * it again only refreshes the menu labels (e.g. after a language change).
 */
export function ensureTray(
  getWindow: () => BrowserWindow | null,
  onQuit: () => void,
  labels: TrayLabels,
): void {
  const show = (): void => {
    const win = getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }

  const menu = Menu.buildFromTemplate([
    { label: labels.show, click: show },
    { type: 'separator' },
    { label: labels.quit, click: onQuit },
  ])

  if (tray) {
    tray.setContextMenu(menu)
    return
  }

  const base = nativeImage.createFromPath(trayIconPath())
  const icon = base.isEmpty() ? base : base.resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('SnMultiCC')
  tray.on('click', show)
  tray.on('double-click', show)
  tray.setContextMenu(menu)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
