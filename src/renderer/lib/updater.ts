import { create } from 'zustand'
import type { UpdateInfo, UpdateProgress } from '@shared/ipc-contract'

interface UpdaterState {
  /** Last check result. */
  info: UpdateInfo | null
  checking: boolean
  installing: boolean
  progress: UpdateProgress | null
  /** Error from the last check (network / API). */
  error: string | null
  /** Error from the last download/install attempt. */
  installError: string | null
  /** True once an update has been applied but can't auto-install (mac/.deb). */
  opened: boolean
  /** Whether the startup "update available" modal is showing. */
  promptOpen: boolean

  check: () => Promise<UpdateInfo | null>
  install: () => Promise<void>
  openPrompt: () => void
  closePrompt: () => void
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  info: null,
  checking: false,
  installing: false,
  progress: null,
  error: null,
  installError: null,
  opened: false,
  promptOpen: false,

  check: async () => {
    if (get().checking) return get().info
    set({ checking: true, error: null, opened: false })
    try {
      const info = await window.snApi.updates.check()
      set({ info, checking: false, error: info.error ?? null })
      return info
    } catch (err) {
      set({ checking: false, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  install: async () => {
    set({
      installing: true,
      installError: null,
      opened: false,
      progress: { percent: 0, transferred: 0, total: 0 },
    })
    try {
      const { relaunching } = await window.snApi.updates.downloadAndInstall()
      // When relaunching, the app is about to quit; otherwise we opened the file.
      set({ installing: false, opened: !relaunching })
    } catch (err) {
      set({ installing: false, installError: err instanceof Error ? err.message : String(err) })
    }
  },

  openPrompt: () => set({ promptOpen: true }),
  closePrompt: () => set({ promptOpen: false }),
}))

let progressWired = false

/** Wire the main->renderer download-progress stream into the store (idempotent). */
export function initUpdaterEvents(): () => void {
  if (progressWired) return () => undefined
  progressWired = true
  const off = window.snApi.updates.onProgress((p) => useUpdaterStore.setState({ progress: p }))
  return () => {
    progressWired = false
    off()
  }
}
