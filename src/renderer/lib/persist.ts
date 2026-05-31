import { CONFIG_VERSION, type ConfigFile } from '@shared/types'
import { type AppState, useAppStore } from './store'

function toConfig(state: AppState): ConfigFile {
  return {
    version: CONFIG_VERSION,
    workspaces: state.workspaces,
    presets: state.presets,
    settings: { ...state.settings, sidebarCollapsed: state.sidebarCollapsed },
    activeWorkspaceId: state.activeWorkspaceId,
    snippets: state.snippets,
  }
}

/** A snapshot of the current config (for export). */
export function snapshotConfig(): ConfigFile {
  return toConfig(useAppStore.getState())
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
