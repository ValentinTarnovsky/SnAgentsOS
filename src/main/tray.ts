import { existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { BRAND } from '@shared/brand'
import type { AwakeMode } from '@shared/types'

let tray: Tray | null = null

export interface TrayLabels {
  show: string
  quit: string
}

/** "Keep PC awake" submenu (E5-FR-24): radios mirroring settings.awakeMode. */
export interface TrayAwake {
  mode: AwakeMode
  labels: { title: string; auto: string; always: string; never: string }
  onMode: (mode: AwakeMode) => void
}

export function hasTray(): boolean {
  return tray !== null
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
 * it again only refreshes the menu (labels after a language change, the awake
 * radio after a mode change).
 */
export function ensureTray(
  getWindow: () => BrowserWindow | null,
  onQuit: () => void,
  labels: TrayLabels,
  awake?: TrayAwake,
): void {
  const show = (): void => {
    const win = getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }

  const template: MenuItemConstructorOptions[] = [{ label: labels.show, click: show }]
  if (awake) {
    const radio = (mode: AwakeMode, label: string): MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked: awake.mode === mode,
      click: () => awake.onMode(mode),
    })
    template.push({
      label: awake.labels.title,
      submenu: [
        radio('auto', awake.labels.auto),
        radio('always', awake.labels.always),
        radio('never', awake.labels.never),
      ],
    })
  }
  template.push({ type: 'separator' }, { label: labels.quit, click: onQuit })
  const menu = Menu.buildFromTemplate(template)

  if (tray) {
    tray.setContextMenu(menu)
    return
  }

  const base = nativeImage.createFromPath(trayIconPath())
  const icon = base.isEmpty() ? base : base.resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip(BRAND.productName)
  tray.on('click', show)
  tray.on('double-click', show)
  tray.setContextMenu(menu)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
