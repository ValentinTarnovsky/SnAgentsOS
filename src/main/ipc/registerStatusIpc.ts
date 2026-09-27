import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { StatusTitleReq } from '@shared/ipc-contract'
import type { NotificationSettings, StatusHooksStatusRes } from '@shared/types'
import type { StatusManager } from '../status/StatusManager'
import type { HookServer } from '../status/HookServer'
import { hooksStatus, hooksUpToDate, installHooks, uninstallHooks } from '../status/HookInstaller'
import { notificationSettingsSchema, discordSettingsSchema } from '../store/schema'
import type { CodexBridge } from '../status/CodexBridge'
import type { DiscordNotifier } from '../status/DiscordNotifier'

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
export function registerStatusIpc(statusManager: StatusManager, hookServer: HookServer, codex: CodexBridge, discord: DiscordNotifier): StatusIpc {
  hookServer.onEvent((evt) => statusManager.onHookEvent(evt))

  let chain: Promise<unknown> = Promise.resolve()
  /** Port+token the server was last started with (requested port, not bound). */
  let started: { port: number; token: string } | null = null
  let lifecycleError: string | undefined

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn)
    chain = run.then(
      () => undefined,
      () => { lifecycleError = 'Could not update the local integration; check the settings file and port' },
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
      await codex.configure(cfg.codexEnabled)
      if (cfg.hooksEnabled && cfg.hookToken) {
        await ensureServer(cfg)
      } else if (hookServer.running) {
        await hookServer.stop()
        started = null
      }
      lifecycleError = undefined
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
    const result = notificationSettingsSchema.safeParse(cfg)
    if (!result.success) return
    statusManager.setConfig(result.data)
    discord.setConfig(result.data.discord)
    void applyHookLifecycle(result.data).catch(() => {})
  })

  ipcMain.handle(
    CH.STATUS_HOOKS_INSTALL,
    (_e, cfg: NotificationSettings): Promise<StatusHooksStatusRes> => {
      cfg = notificationSettingsSchema.parse(cfg)
      if (!cfg.hookToken) throw new Error('Hook token is required')
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
  ipcMain.handle(CH.STATUS_SNAPSHOT, () => statusManager.snapshot())
  ipcMain.handle(CH.STATUS_HEALTH, () => ({
    desktop: { error: statusManager.desktopError },
    claude: { ...hooksStatus(), running: hookServer.running, lastEventAt: statusManager.lastClaudeEventAt, ...(lifecycleError ? { error: lifecycleError } : {}) },
    codex: codex.health, discord: discord.health,
  }))
  ipcMain.handle(CH.STATUS_DISCORD_TEST, (_e, cfg) => discord.test(discordSettingsSchema.parse(cfg)))
  ipcMain.handle(CH.STATUS_DESKTOP_TEST, () => statusManager.testDesktop())

  return {
    applyStartup(cfg) {
      if (!cfg) return
      statusManager.setConfig(cfg)
      discord.setConfig(cfg.discord)
      void applyHookLifecycle(cfg).catch(() => {})
    },
  }
}
