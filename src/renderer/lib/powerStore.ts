import { create } from 'zustand'
import type { PowerState } from '@shared/ipc-contract'
import type { AgentSettings, AwakeMode } from '@shared/types'
import { useAppStore } from './store'
import { createAwakeModeSync } from './awake'

interface PowerStoreState {
  /** Latest "PC awake" state from main, or null until the first answer. */
  state: PowerState | null
}

export const usePowerStore = create<PowerStoreState>(() => ({ state: null }))

const modeSync = createAwakeModeSync(
  (mode) => window.snApi.power.setConfig(mode),
  (mode) => {
    // A mode picked from the tray: main already applied it, persist it here.
    const s = useAppStore.getState()
    if (s.settings.awakeMode !== mode) s.updateSettings({ awakeMode: mode })
  },
)

function applyState(state: PowerState): void {
  usePowerStore.setState({ state })
  modeSync.onState(state)
}

let wired = false

/** Wire the main->renderer power:state stream and pull the first state (idempotent). */
export function initPowerEvents(): () => void {
  if (wired) return () => undefined
  wired = true
  const off = window.snApi.power.onState(applyState)
  void window.snApi.power
    .getState()
    .then(applyState)
    .catch(() => undefined)
  return () => {
    wired = false
    off()
  }
}

/** Push settings.awakeMode to main (it decides whether to hold the block). */
export function syncAwakeMode(mode: AwakeMode): void {
  modeSync.push(mode)
}

/** Push settings.agents to main (awakeDisplay swaps the blocker type). */
export function syncAgentSettings(cfg: AgentSettings): void {
  window.snApi.agents.setConfig(cfg)
}
