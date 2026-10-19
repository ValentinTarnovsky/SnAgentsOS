import { create } from 'zustand'
import type { UsageSnapshot } from '@shared/ipc-contract'
import type { UsageSettings } from '@shared/types'

interface UsageState {
  snapshot: UsageSnapshot | null
  refreshing: boolean
  refresh: () => Promise<void>
}

export const useUsageStore = create<UsageState>((set, get) => ({
  snapshot: null,
  refreshing: false,
  refresh: async () => {
    if (get().refreshing) return
    set({ refreshing: true })
    try {
      const snap = await window.snApi.usage.refresh()
      set({ snapshot: snap })
    } catch {
      /* main keeps the previous snapshot; nothing to do */
    } finally {
      set({ refreshing: false })
    }
  },
}))

let wired = false

/** Wire the main->renderer snapshot stream and pull the first snapshot (idempotent). */
export function initUsageEvents(): () => void {
  if (wired) return () => undefined
  wired = true
  const off = window.snApi.usage.onUpdate((s) => useUsageStore.setState({ snapshot: s }))
  void window.snApi.usage
    .get()
    .then((s) => useUsageStore.setState({ snapshot: s }))
    .catch(() => undefined)
  return () => {
    wired = false
    off()
  }
}

let focusHandler: (() => void) | null = null
/** The poll settings main got last (JSON), so a view-only change sends nothing. */
let lastSynced = ''

/**
 * Push the latest usage settings to main (so it can reschedule its pollers) and
 * (re)bind the focus-refresh listener. Call whenever settings.usage changes.
 */
export function syncUsageConfig(cfg: UsageSettings): void {
  // Folding the sidebar panel (`collapsed`) is view state: it must not cost a poll.
  const { collapsed: _view, ...poll } = cfg
  const key = JSON.stringify(poll)
  if (key === lastSynced) return
  lastSynced = key
  window.snApi.usage.setConfig(cfg)
  if (focusHandler) {
    window.removeEventListener('focus', focusHandler)
    focusHandler = null
  }
  if (cfg.enabled && cfg.refreshOnFocus) {
    focusHandler = () => {
      void useUsageStore.getState().refresh()
    }
    window.addEventListener('focus', focusHandler)
  }
}
