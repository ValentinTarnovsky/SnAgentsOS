import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { StatusTitleReq } from '@shared/ipc-contract'
import type { NotificationSettings, StatusHooksStatusRes } from '@shared/types'
import type { StatusManager } from '../status/StatusManager'
import type { HookServer } from '../status/HookServer'
import { hooksStatus, hooksUpToDate, installHooks, uninstallHooks } from '../status/HookInstaller'

export interface StatusIpc {
  /** Apply the persisted config once at boot (starts the HookServer if enabled). */
  applyStartup(cfg: NotificationSettings | null | undefined): void
}

/**
 * IPC surface for the Claude status feature. Also owns the HookServer
 * lifecycle: it runs only while notifications.hooksEnabled is true. Every
 * lifecycle mutation goes through one promise chain, so rapid config toggles
 * or an install racing a boot start can never double-bind the port or leave
 * a stopped flag with a live server.
 */
export function registerStatusIpc(statusManager: StatusManager, hookServer: HookServer): StatusIpc {
  hookServer.onEvent((evt) => statusManager.onHookEvent(evt))

  let chain: Promise<unknown> = Promise.resolve()
  /** Port+token the server was last started with (requested port, not bound). */
  let started: { port: number; token: string } | null = null

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn)
    chain = run.then(
      () => undefined,
      (err) => console.error('[hooks] lifecycle step failed:', err),
    )
    return run
  }

  /** Repoint installed hooks when their URL drifted from the live server. */
  function reconcileInstalled(token: string): void {
    if (hooksStatus().installed && !hooksUpToDate(hookServer.activePort, token)) {
      installHooks(hookServer.activePort, token)
    }
  }

  async function ensureServer(cfg: NotificationSettings): Promise<void> {
    if (!hookServer.running || started?.port !== cfg.hookPort || started?.token !== cfg.hookToken) {
      await hookServer.start(cfg.hookPort, cfg.hookToken)
      started = { port: cfg.hookPort, token: cfg.hookToken }
    }
    reconcileInstalled(cfg.hookToken)
  }

  function applyHookLifecycle(cfg: NotificationSettings): Promise<void> {
    return enqueue(async () => {
      if (cfg.hooksEnabled && cfg.hookToken) {
        await ensureServer(cfg)
      } else if (hookServer.running) {
        await hookServer.stop()
        started = null
      }
    })
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
    (_e, cfg: NotificationSettings): Promise<StatusHooksStatusRes> => {
      statusManager.setConfig(cfg)
      return enqueue(async () => {
        await ensureServer(cfg)
        return installHooks(hookServer.activePort, cfg.hookToken)
      })
    },
  )

  ipcMain.handle(CH.STATUS_HOOKS_UNINSTALL, (): Promise<StatusHooksStatusRes> => {
    return enqueue(async () => {
      const res = uninstallHooks()
      await hookServer.stop()
      started = null
      return res
    })
  })

  ipcMain.handle(CH.STATUS_HOOKS_STATUS, (): StatusHooksStatusRes => hooksStatus())

  return {
    applyStartup(cfg) {
      if (!cfg) return
      statusManager.setConfig(cfg)
      void applyHookLifecycle(cfg)
    },
  }
}
