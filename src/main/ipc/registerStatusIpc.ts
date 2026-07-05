import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { StatusTitleReq } from '@shared/ipc-contract'
import type { NotificationSettings, StatusHooksStatusRes } from '@shared/types'
import type { StatusManager } from '../status/StatusManager'
import type { HookServer } from '../status/HookServer'
import { hooksStatus, installHooks, uninstallHooks } from '../status/HookInstaller'

/**
 * IPC surface for the Claude status feature. Also owns the HookServer
 * lifecycle: it runs only while notifications.hooksEnabled is true.
 */
export function registerStatusIpc(statusManager: StatusManager, hookServer: HookServer): void {
  hookServer.onEvent((evt) => statusManager.onHookEvent(evt))

  async function applyHookLifecycle(cfg: NotificationSettings): Promise<void> {
    if (cfg.hooksEnabled && cfg.hookToken) {
      if (!hookServer.running) {
        try {
          const port = await hookServer.start(cfg.hookPort, cfg.hookToken)
          // Stale-port trap: hooks installed on a previous run may point at a
          // port someone else now owns. Re-point them at the live port.
          const installed = hooksStatus()
          if (installed.installed && installed.port !== port) {
            installHooks(port, cfg.hookToken)
          }
        } catch (error) {
          console.error('[hooks] server failed to start:', error)
        }
      }
    } else if (hookServer.running) {
      await hookServer.stop()
    }
  }

  ipcMain.on(CH.STATUS_TITLE, (_e, req: StatusTitleReq) => {
    if (req && typeof req.paneId === 'string' && typeof req.title === 'string') {
      statusManager.reportTitle(req.paneId, req.title)
    }
  })

  ipcMain.on(CH.STATUS_VIEWED, (_e, paneIds: string[]) => {
    if (Array.isArray(paneIds)) statusManager.setViewed(paneIds.filter((p) => typeof p === 'string'))
  })

  ipcMain.on(CH.STATUS_SET_CONFIG, (_e, cfg: NotificationSettings) => {
    if (!cfg || typeof cfg !== 'object') return
    statusManager.setConfig(cfg)
    void applyHookLifecycle(cfg)
  })

  ipcMain.handle(
    CH.STATUS_HOOKS_INSTALL,
    async (_e, cfg: NotificationSettings): Promise<StatusHooksStatusRes> => {
      statusManager.setConfig(cfg)
      if (!hookServer.running) await hookServer.start(cfg.hookPort, cfg.hookToken)
      return installHooks(hookServer.activePort, cfg.hookToken)
    },
  )

  ipcMain.handle(CH.STATUS_HOOKS_UNINSTALL, async (): Promise<StatusHooksStatusRes> => {
    const res = uninstallHooks()
    await hookServer.stop()
    return res
  })

  ipcMain.handle(CH.STATUS_HOOKS_STATUS, (): StatusHooksStatusRes => hooksStatus())

  return
}

/** Boot-time hook: start the server if the persisted config enables it. */
export async function applyStartupStatusConfig(
  statusManager: StatusManager,
  hookServer: HookServer,
  cfg: NotificationSettings | null | undefined,
): Promise<void> {
  if (!cfg) return
  statusManager.setConfig(cfg)
  if (cfg.hooksEnabled && cfg.hookToken) {
    try {
      const port = await hookServer.start(cfg.hookPort, cfg.hookToken)
      const installed = hooksStatus()
      if (installed.installed && installed.port !== port) installHooks(port, cfg.hookToken)
    } catch (error) {
      console.error('[hooks] server failed to start at boot:', error)
    }
  }
}
