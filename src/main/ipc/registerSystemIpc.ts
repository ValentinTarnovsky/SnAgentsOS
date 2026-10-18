import { app, ipcMain, powerMonitor, screen, shell, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { ExplorerMenuResult } from '@shared/ipc-contract'
import { isPortable } from '../paths'
import { openExternalSafe } from '../openExternal'
import { createPathOpener } from '../remote/pathOpen'
import type { OpenRequestQueue } from '../openRequest'
import { applyExplorerMenu, readExplorerMenu } from '../shellIntegration'

/**
 * OS login-item integration. No-op on the portable build because the executable
 * path is not stable there (registering it would point at a transient location).
 */
export function registerSystemIpc(getSender: () => WebContents | null, openRequests?: OpenRequestQueue): void {
  ipcMain.handle(CH.SYSTEM_SET_LOGIN_ITEM, (_e, enabled: boolean): void => {
    if (isPortable()) return
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
  })

  ipcMain.handle(CH.SYSTEM_GET_LOGIN_ITEM, (): boolean => {
    if (isPortable()) return false
    return app.getLoginItemSettings().openAtLogin
  })

  // "Open in SnAgentsOS" (E4-FR-32..34). The renderer pulls the request main
  // holds (a push before hydrate is never lost) and toggles the Explorer menu;
  // the language rides along because the config on disk can lag the debounce.
  if (openRequests) ipcMain.handle(CH.APP_TAKE_PENDING_OPEN, () => openRequests.take())
  ipcMain.handle(CH.SYSTEM_SET_EXPLORER_MENU, (_e, req: { enabled?: unknown; language?: unknown }): Promise<ExplorerMenuResult> =>
    applyExplorerMenu(req?.enabled === true, req?.language === 'es' ? 'es' : 'en'),
  )
  ipcMain.handle(CH.SYSTEM_GET_EXPLORER_MENU, (): Promise<ExplorerMenuResult> => readExplorerMenu())

  // Terminal hyperlinks (and any renderer "open in browser" action) route here.
  ipcMain.on(CH.SHELL_OPEN_EXTERNAL, (_e, url: unknown) => openExternalSafe(url))
  // A path tapped on the phone (E2-FR-30): contained in the root, inert opens, the rest reveals.
  const openPath = createPathOpener({ openPath: (p) => shell.openPath(p), showItemInFolder: (p) => shell.showItemInFolder(p) })
  ipcMain.handle(CH.SHELL_OPEN_PATH, (_e, req: unknown) => openPath(req))

  // Sleep/resume, screen unlock, GPU process crashes, and monitor/DPI changes
  // can bring WebGL back with a context that is alive but invalid (trashed
  // texture memory): the terminal layout survives but every cell draws the
  // wrong glyph from the corrupted atlas. Tell the renderer so each terminal
  // recreates its renderer and repaints. The renderer debounces these, so a
  // burst (e.g. dragging a window across monitors) coalesces into one reload.
  const notifyDisplayRecovered = (): void => {
    getSender()?.send(CH.SYSTEM_DISPLAY_RECOVERED)
  }
  powerMonitor.on('resume', notifyDisplayRecovered)
  powerMonitor.on('unlock-screen', notifyDisplayRecovered)
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') notifyDisplayRecovered()
  })
  screen.on('display-metrics-changed', notifyDisplayRecovered)
}
