import { create } from 'zustand'
import { MISSING_CHECKSUM, type UpdateInfo, type UpdateProgress } from '@shared/ipc-contract'
import type { TFn } from '@/i18n'

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
      // IPC wraps the main error ("Error invoking remote method ...: Error:
      // missing-checksum"), so the known code is matched inside the message.
      const message = err instanceof Error ? err.message : String(err)
      set({ installing: false, installError: message.includes(MISSING_CHECKSUM) ? MISSING_CHECKSUM : message })
    }
  },

  openPrompt: () => set({ promptOpen: true }),
  closePrompt: () => set({ promptOpen: false }),
}))

/** User-facing text for an install error (known codes get their own message). */
export function installErrorText(t: TFn, error: string): string {
  return error === MISSING_CHECKSUM ? t('update.error.missingChecksum') : t('update.installFailed', { error })
}

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
