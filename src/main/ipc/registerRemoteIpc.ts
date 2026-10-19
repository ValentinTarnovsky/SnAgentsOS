/**
 * Remote-control IPC. Thin wiring between the renderer's SnApi.remote surface
 * and the RemoteManager: invoke channels for request/response (getState,
 * pairingBegin, revokeDevice) and send channels for fire-and-forget pushes
 * (setConfig, pairing resolve/cancel, state sync, command results).
 *
 * The Windows firewall check / fix (E2-FR-38/39) also lives here: the port
 * and the exe come from main only (the renderer just asks), and the network
 * settings page is a fixed ms-settings URI.
 *
 * No persistence lives here: RemoteSettings are saved by the renderer as part
 * of the config blob; the device registry is owned by the manager.
 */
import { execFile } from 'child_process'
import { join } from 'path'
import { app, ipcMain, shell } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { FirewallFixRes, FirewallStatus, PairingQrPayload, RemoteCommandResult, RemoteUiState, SecureModeStatus } from '@shared/ipc-contract'
import type { RemoteStateSnapshot } from '@shared/remote-protocol'
import type { RemoteSettings } from '@shared/types'
import type { RemoteManager } from '../remote/RemoteManager'
import { FirewallService, type RunResult } from '../remote/firewall'
import { listEndpoints } from '../remote/network'
import { isPortable } from '../paths'

/** Absolute path, so a powershell.exe earlier in PATH is never picked up. */
function powershellExe(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function runPowerShell(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      powershellExe(),
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (!err) {
          resolve({ code: 0, stdout, timedOut: false })
          return
        }
        const e = err as Error & { code?: number | string; killed?: boolean }
        resolve({ code: typeof e.code === 'number' ? e.code : null, stdout: stdout ?? '', timedOut: e.killed === true })
      },
    )
  })
}

export function registerRemoteIpc(manager: RemoteManager): void {
  const firewall = new FirewallService({
    platform: process.platform,
    exe: () => app.getPath('exe'),
    port: () => manager.getUiState().status.port,
    programScope: () => app.isPackaged && !isPortable(),
    endpoints: listEndpoints,
    run: runPowerShell,
    now: () => Date.now(),
  })

  ipcMain.on(CH.REMOTE_SET_CONFIG, (_e, cfg: RemoteSettings) => manager.applyConfig(cfg))

  ipcMain.handle(CH.REMOTE_GET_STATE, (): RemoteUiState => manager.getUiState())

  ipcMain.handle(
    CH.REMOTE_PAIRING_BEGIN,
    (): Promise<PairingQrPayload | null> => manager.pairingBegin(),
  )

  ipcMain.on(CH.REMOTE_PAIRING_CANCEL, () => manager.pairingCancel())

  ipcMain.on(
    CH.REMOTE_PAIRING_RESOLVE,
    (_e, p: { requestId: string; allow: boolean }) => manager.pairingResolve(p.requestId, p.allow),
  )

  ipcMain.handle(CH.REMOTE_DEVICE_REVOKE, (_e, deviceId: string): Promise<void> =>
    manager.revokeDevice(deviceId),
  )

  ipcMain.on(CH.REMOTE_STATE_PUSH, (_e, snapshot: RemoteStateSnapshot) =>
    manager.pushState(snapshot),
  )

  ipcMain.on(CH.REMOTE_CONTROL_RESULT, (_e, res: RemoteCommandResult) =>
    manager.onControlResult(res),
  )

  ipcMain.handle(CH.REMOTE_FIREWALL_CHECK, (_e, force: unknown): Promise<FirewallStatus> =>
    firewall.check(force === true),
  )

  ipcMain.handle(CH.REMOTE_FIREWALL_FIX, (): Promise<FirewallFixRes> => firewall.fix())

  // E3-FR-17/19: the strip or a real key/paste gives the size back. The shape
  // is checked here; anything else is dropped.
  ipcMain.on(CH.REMOTE_FIT_RELEASE, (_e, req: unknown) => {
    if (!req || typeof req !== 'object') return
    const r = req as { paneId?: unknown; all?: unknown }
    if (r.all === true) manager.fitRelease({ all: true })
    else if (typeof r.paneId === 'string' && r.paneId.length > 0 && r.paneId.length <= 128) manager.fitRelease({ paneId: r.paneId })
  })

  // E3-FR-42: the secure mode toggle runs the tailscale CLI in main.
  ipcMain.handle(CH.REMOTE_SECURE_SET, (_e, enabled: unknown): Promise<SecureModeStatus> => manager.setSecure(enabled === true))

  ipcMain.on(CH.REMOTE_OPEN_NETWORK_SETTINGS, () => {
    if (process.platform === 'win32') void shell.openExternal('ms-settings:network-status').catch(() => undefined)
  })
}
