import { ipcMain, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { UpdateInfo, UpdateProgress } from '@shared/ipc-contract'
import { checkForUpdate, downloadAndInstall } from '../updater'

interface UpdateIpcHooks {
  getSender: () => WebContents | null
  /** Quit + relaunch for an applied update (bypasses tray-hide / close confirm). */
  quitForUpdate: () => void
  /** Reports whether an install is in flight so the main process can block close. */
  setInstalling: (installing: boolean) => void
}

/**
 * Auto-update IPC.
 *  - `update:check`   -> UpdateInfo (queries GitHub releases)
 *  - `update:install` -> downloads + verifies the matching asset, streams
 *                        progress on `update:progress`, then runs it. When the
 *                        build relaunches itself (Windows portable / Linux
 *                        AppImage) it calls `quitForUpdate`; the NSIS installer
 *                        and mac/.deb just open and leave the app running.
 */
export function registerUpdateIpc(hooks: UpdateIpcHooks): void {
  const { getSender, quitForUpdate, setInstalling } = hooks

  ipcMain.handle(CH.UPDATE_CHECK, (): Promise<UpdateInfo> => checkForUpdate())

  ipcMain.handle(CH.UPDATE_INSTALL, async (): Promise<{ relaunching: boolean }> => {
    const emit = (p: UpdateProgress): void => {
      const wc = getSender()
      if (wc && !wc.isDestroyed()) wc.send(CH.UPDATE_PROGRESS, p)
    }
    setInstalling(true)
    try {
      const result = await downloadAndInstall(emit)
      if (result.relaunching) {
        // Give the renderer a tick to settle, then quit so the swap can run.
        setTimeout(quitForUpdate, 400)
      }
      return result
    } finally {
      setInstalling(false)
    }
  })
}
