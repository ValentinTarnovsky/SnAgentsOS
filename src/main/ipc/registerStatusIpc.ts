import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { StatusTitleReq } from '@shared/ipc-contract'
import type { NotificationSettings, PanePlan, StatusHealth, StatusHooksStatusRes } from '@shared/types'
import { parseTuneHint } from '@shared/agentTune'
import type { StatusManager } from '../status/StatusManager'
import type { HookServer } from '../status/HookServer'
import { hooksStatus, hooksUpToDate, installHooks, uninstallHooks } from '../status/HookInstaller'
import { notificationSettingsSchema, discordSettingsSchema, ntfySettingsSchema } from '../store/schema'
import type { CodexBridge } from '../status/CodexBridge'
import type { DiscordNotifier } from '../status/DiscordNotifier'
import type { NtfyNotifier } from '../status/NtfyNotifier'
import { devPort } from '../devPort'

/** Default of settings.notifications.hookPort (schema.ts), the port devPort() moves. */
const HOOK_DEFAULT_PORT = 43917

/** App 2.7.0 (A3): longest console id and plan request id the renderer may name. */
const PANE_ID_MAX = 64
const PLAN_REQUEST_ID_MAX = 200

/** A renderer value as a console id (non-empty, <= PANE_ID_MAX), or null. */
function paneIdOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= PANE_ID_MAX ? v : null
}

/** A renderer value as a plain object, or null. */
function objOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export interface StatusIpc {
  /** Apply the persisted config once at boot (starts the HookServer if enabled). */
  applyStartup(cfg: NotificationSettings | null | undefined): void
  /** Same payload as `status:health` (copied diagnostics, E4-FR-24). */
  health(): StatusHealth
}

/**
 * IPC surface for the Claude status feature. Also owns the HookServer
 * lifecycle: it runs only while notifications.hooksEnabled is true. Every
 * lifecycle mutation goes through one promise chain, so rapid config toggles
 * or an install racing a boot start can never double-bind the port or leave
 * a stopped flag with a live server.
 */
export function registerStatusIpc(statusManager: StatusManager, hookServer: HookServer, codex: CodexBridge, discord: DiscordNotifier, ntfy: NtfyNotifier): StatusIpc {
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
    // Plan A1.3: a worktree dev instance moves the default port (devPort.ts);
    // installHooks and reconcileInstalled follow hookServer.activePort.
    const port = devPort(cfg.hookPort, HOOK_DEFAULT_PORT)
    if (!hookServer.running || started?.port !== port || started?.token !== cfg.hookToken) {
      await hookServer.start(port, cfg.hookToken)
      started = { port, token: cfg.hookToken }
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

  ipcMain.on(CH.STATUS_TUNE_HINT, (_e, req: unknown) => {
    const hint = parseTuneHint(req)
    if (hint) statusManager.setTuneHint(hint.paneId, hint.hint)
  })

  ipcMain.on(CH.STATUS_SET_CONFIG, (_e, cfg: NotificationSettings) => {
    const result = notificationSettingsSchema.safeParse(cfg)
    if (!result.success) return
    statusManager.setConfig(result.data)
    discord.setConfig(result.data.discord)
    ntfy.setConfig(result.data.ntfy)
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
  const health = (): StatusHealth => ({
    desktop: { error: statusManager.desktopError },
    claude: { ...hooksStatus(), running: hookServer.running, lastEventAt: statusManager.lastClaudeEventAt, ...(lifecycleError ? { error: lifecycleError } : {}) },
    codex: codex.health, discord: discord.health, ntfy: ntfy.health,
  })
  ipcMain.handle(CH.STATUS_HEALTH, health)
  ipcMain.handle(CH.STATUS_DISCORD_TEST, (_e, cfg) => discord.test(discordSettingsSchema.parse(cfg)))
  ipcMain.handle(CH.STATUS_DESKTOP_TEST, () => statusManager.testDesktop())
  // E2-FR-40: the test publishes with the saved config main already holds
  // (the renderer pushes it on every change), never with a renderer payload.
  ipcMain.handle(CH.STATUS_NTFY_TEST, () => ntfy.test())

  // App 2.7.0 (A3): read, mute and silence marks and the full plan. A bad
  // payload answers false / null, never throws.
  ipcMain.handle(CH.STATUS_MARK_READ, (_e, raw: unknown): boolean => {
    const paneId = paneIdOf(raw)
    return paneId ? statusManager.markRead(paneId) : false
  })
  ipcMain.handle(CH.STATUS_MUTE, (_e, raw: unknown): boolean => {
    const req = objOf(raw)
    const paneId = paneIdOf(req?.paneId)
    return paneId && typeof req?.muted === 'boolean' ? statusManager.setMuted(paneId, req.muted) : false
  })
  ipcMain.handle(CH.STATUS_SILENCE_ACK, (_e, raw: unknown): boolean => {
    const paneId = paneIdOf(raw)
    return paneId ? statusManager.ackSilence(paneId) : false
  })
  ipcMain.handle(CH.STATUS_PLAN, (_e, raw: unknown): PanePlan | null => {
    const req = objOf(raw)
    const paneId = paneIdOf(req?.paneId)
    const requestId = req?.requestId
    if (!paneId) return null
    if (requestId === undefined) return statusManager.planOf(paneId)
    return typeof requestId === 'string' && requestId.length > 0 && requestId.length <= PLAN_REQUEST_ID_MAX ? statusManager.planOf(paneId, requestId) : null
  })

  return {
    health,
    applyStartup(cfg) {
      if (!cfg) return
      statusManager.setConfig(cfg)
      discord.setConfig(cfg.discord)
      ntfy.setConfig(ntfySettingsSchema.parse(cfg.ntfy ?? {}))
      void applyHookLifecycle(cfg).catch(() => {})
    },
  }
}
