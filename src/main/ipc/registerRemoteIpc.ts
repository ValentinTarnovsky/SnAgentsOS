/**
 * Remote-control IPC. Thin wiring between the renderer's SnApi.remote surface
 * and the RemoteManager: invoke channels for request/response (getState,
 * pairingBegin, revokeDevice) and send channels for fire-and-forget pushes
 * (setConfig, pairing resolve/cancel, state sync, command results).
 *
 * No persistence lives here: RemoteSettings are saved by the renderer as part
 * of the config blob; the device registry is owned by the manager.
 */
import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { PairingQrPayload, RemoteCommandResult, RemoteUiState } from '@shared/ipc-contract'
import type { RemoteStateSnapshot } from '@shared/remote-protocol'
import type { RemoteSettings } from '@shared/types'
import type { RemoteManager } from '../remote/RemoteManager'

export function registerRemoteIpc(manager: RemoteManager): void {
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
}
