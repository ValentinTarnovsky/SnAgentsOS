import { CONFIG_VERSION, type ConfigFile } from '@shared/types'
import { type AppState, useAppStore } from './store'

function toConfig(state: AppState): ConfigFile {
  return {
    version: CONFIG_VERSION,
    workspaces: state.workspaces,
    presets: state.presets,
    settings: { ...state.settings, sidebarCollapsed: state.sidebarCollapsed },
    activeWorkspaceId: state.activeWorkspaceId,
    quickCommands: state.quickCommands,
    keyButtons: state.keyButtons,
    connections: state.connections,
  }
}

/**
 * The store slices that end up in config.json; compared by reference to gate
 * writes (same pattern as remoteSnapshot's relevant()). Transient state such
 * as paneStatus, paneAttention or mountedWorkspaces never triggers a write.
 */
function relevant(s: AppState): unknown[] {
  return [
    s.workspaces,
    s.presets,
    s.settings,
    s.quickCommands,
    s.keyButtons,
    s.connections,
    s.activeWorkspaceId,
    s.sidebarCollapsed,
  ]
}

/** A snapshot of the current config (for export). */
export function snapshotConfig(): ConfigFile {
  return toConfig(useAppStore.getState())
}

/**
 * Debounced persistence: writes the full config blob whenever a persisted
 * slice changes by reference, but only after hydration (so we never overwrite
 * saved data with the initial empty state). Returns an unsubscribe function.
 */
export function startPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let prev = relevant(useAppStore.getState())
  return useAppStore.subscribe((state) => {
    if (!state.hydrated) return
    const next = relevant(state)
    if (next.every((v, i) => v === prev[i])) return
    prev = next
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      window.snApi.config.save(toConfig(useAppStore.getState()))
    }, 400)
  })
}
