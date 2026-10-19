import { homedir, release } from 'os'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { z } from 'zod'
import { CH } from '@shared/ipc-channels'
import { CONFIG_VERSION, type ConfigFile, type StatusHealth } from '@shared/types'
import type { AppMetrics, RecoveryInfo, RemoteServerStatus, RendererDiagnostics } from '@shared/ipc-contract'
import { isPortable } from '../paths'
import { renderErrorReportSchema, type CrashStore } from '../crash/crashStore'
import type { RendererRecovery } from '../crash/rendererRecovery'
import { buildDiagnostics } from '../diagnostics/buildDiagnostics'
import { recentLogLines } from '../diagnostics/logRing'

export interface CrashIpcDeps {
  recovery: RendererRecovery
  crashes: CrashStore
  getConfig(): ConfigFile | null
  consoles(): number
  statusHealth(): StatusHealth | null
  remoteStatus(): RemoteServerStatus | null
}

const rendererDiagnosticsSchema = z.object({
  renderErrors: z.array(renderErrorReportSchema).max(10).catch([]),
  workspaces: z.number().int().min(0).catch(0),
  panes: z.number().int().min(0).catch(0),
  connections: z.number().int().min(0).catch(0),
  snippets: z.number().int().min(0).catch(0),
  lang: z.string().max(8).catch(''),
})

function installKind(): string {
  if (!app.isPackaged) return 'dev'
  if (process.platform === 'win32') return isPortable() ? 'win-portable' : 'win-installer'
  if (process.platform === 'darwin') return 'mac'
  return process.env.APPIMAGE ? 'linux-appimage' : 'linux'
}

function metrics(consoles: number): AppMetrics {
  let memKB = 0
  let cpu = 0
  const list = app.getAppMetrics()
  for (const m of list) {
    memKB += m.memory?.workingSetSize ?? 0
    cpu += m.cpu?.percentCPUUsage ?? 0
  }
  return { memMB: Math.round(memKB / 1024), cpuPercent: Math.round(cpu * 10) / 10, processes: list.length, consoles }
}

/**
 * Diagnostics from main's own state; `renderer` is null when the renderer is
 * gone (breaker dialog). Every source is read defensively: a failing one
 * becomes '-' instead of failing the copy.
 */
export function makeDiagnosticsCollector(deps: CrashIpcDeps): (renderer: RendererDiagnostics | null) => string {
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  return (renderer) =>
    buildDiagnostics({
      app: {
        version: app.getVersion(),
        installKind: installKind(),
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        systemVersion: safe(() => process.getSystemVersion(), ''),
        electron: process.versions.electron ?? '-',
        chrome: process.versions.chrome ?? '-',
        node: process.versions.node ?? '-',
        uptimeSec: process.uptime(),
      },
      configVersion: CONFIG_VERSION,
      config: safe(() => deps.getConfig(), null),
      renderer,
      mainRenderErrors: deps.recovery.recentRenderErrors(),
      metrics: safe(() => metrics(deps.consoles()), null),
      health: safe(() => deps.statusHealth(), null),
      remote: safe(() => deps.remoteStatus(), null),
      crashes: safe(() => deps.crashes.list(5), []),
      logLines: recentLogLines(100),
      home: homedir(),
    })
}

/** IPC of the crash resilience (E4-FR-20..24). */
export function registerCrashIpc(deps: CrashIpcDeps): void {
  const collect = makeDiagnosticsCollector(deps)
  ipcMain.on(CH.APP_RELOAD, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) deps.recovery.manualReload(win)
  })
  ipcMain.handle(CH.APP_TAKE_RECOVERY, (): RecoveryInfo | null => deps.recovery.takeRecovery())
  ipcMain.on(CH.APP_REPORT_RENDER_ERROR, (_e, report: unknown) => {
    deps.recovery.reportRenderError(report)
  })
  ipcMain.handle(CH.APP_DIAGNOSTICS, (_e, renderer: unknown): string => {
    const parsed = rendererDiagnosticsSchema.safeParse(renderer ?? {})
    return collect(parsed.success ? parsed.data : null)
  })
}

/** The breaker dialog's [Copy diagnostics] (no renderer to ask). */
export function copyMainDiagnostics(deps: CrashIpcDeps): void {
  try {
    clipboard.writeText(makeDiagnosticsCollector(deps)(null))
  } catch (error) {
    console.warn('[crash] diagnostics copy failed:', (error as Error)?.message ?? error)
  }
}
