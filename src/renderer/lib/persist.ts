import type { ConfigFile } from '@shared/types'
import { type AppState, useAppStore } from './store'

const CONFIG_VERSION = 1

function toConfig(state: AppState): ConfigFile {
  return {
    version: CONFIG_VERSION,
    workspaces: state.workspaces,
    presets: state.presets,
    settings: { ...state.settings, sidebarCollapsed: state.sidebarCollapsed },
    activeWorkspaceId: state.activeWorkspaceId,
  }
}

/**
 * Debounced persistence: writes the full config blob whenever the store
 * changes, but only after hydration (so we never overwrite saved data with
 * the initial empty state). Returns an unsubscribe function.
 */
export function startPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return useAppStore.subscribe((state) => {
    if (!state.hydrated) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => window.snApi.config.save(toConfig(state)), 400)
  })
}
