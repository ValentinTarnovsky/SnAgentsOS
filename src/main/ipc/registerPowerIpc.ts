import { ipcMain, powerMonitor, powerSaveBlocker, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { PowerState } from '@shared/ipc-contract'
import type { AgentSettings, AwakeMode } from '@shared/types'
import { AwakeService, isAwakeMode } from '../agents/AwakeService'

export interface PowerIpcDeps {
  getSender: () => WebContents | null
  /** Persisted settings at boot (the renderer re-pushes them once hydrated). */
  initialMode: AwakeMode | undefined
  initialDisplay: boolean | undefined
  /** Every state change, after it reached the renderer (the tray menu follows the mode). */
  onState?: (state: PowerState) => void
}

/**
 * "PC awake" channels (E5-FR-23/24, contract `power:*`): creates the
 * AwakeService on the real powerSaveBlocker/powerMonitor (only usable after
 * app ready) and returns it so index.ts can feed status and phone presence.
 */
export function registerPowerIpc(deps: PowerIpcDeps): AwakeService {
  const awake = new AwakeService({ blocker: powerSaveBlocker, power: powerMonitor })
  if (isAwakeMode(deps.initialMode)) awake.setMode(deps.initialMode)
  awake.setDisplay(deps.initialDisplay === true)

  const send = (state: PowerState): void => {
    const wc = deps.getSender()
    if (wc && !wc.isDestroyed()) wc.send(CH.POWER_STATE, state)
  }
  awake.onChange((state) => {
    send(state)
    deps.onState?.(state)
  })

  ipcMain.on(CH.POWER_SET_CONFIG, (_e, mode: unknown) => {
    if (isAwakeMode(mode)) awake.setMode(mode)
    // Always answer, even when nothing changed: the renderer waits for this
    // echo before it trusts `mode` again (tray changes vs. its own pushes).
    send(awake.getState())
  })
  ipcMain.handle(CH.POWER_GET_STATE, (): PowerState => awake.getState())
  ipcMain.on(CH.AGENTS_SET_CONFIG, (_e, cfg: Partial<AgentSettings> | null) => {
    if (cfg && typeof cfg === 'object' && typeof cfg.awakeDisplay === 'boolean') awake.setDisplay(cfg.awakeDisplay)
  })
  return awake
}
