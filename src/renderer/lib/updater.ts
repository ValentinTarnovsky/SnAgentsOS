import { create } from 'zustand'
import {
  MISSING_CHECKSUM,
  type UpdateInfo,
  type UpdatePhase,
  type UpdateProgress,
  type UpdateState,
} from '@shared/ipc-contract'
import type { TFn } from '@/i18n'

interface UpdaterState {
  /** Last check result. */
  info: UpdateInfo | null
  checking: boolean
  /** main's phase (E4-FR-37); `installing` and `opened` derive from it. */
  phase: UpdatePhase
  /** A download/apply runs in main (phase downloading or installing). */
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

/** Whether a download/apply is running in this phase (blocks closing the window). */
export function isInstallPhase(phase: UpdatePhase): boolean {
  return phase === 'downloading' || phase === 'installing'
}

/** IPC wraps main's error ("Error invoking remote method ...: Error: missing-checksum"). */
function installErrorCode(message: string | null): string | null {
  if (message === null) return null
  return message.includes(MISSING_CHECKSUM) ? MISSING_CHECKSUM : message
}

/** The store fields that mirror main's update state. */
export function mirrorUpdateState(s: UpdateState): Partial<UpdaterState> {
  const out: Partial<UpdaterState> = {
    phase: s.phase,
    installing: isInstallPhase(s.phase),
    opened: s.phase === 'opened',
    progress: s.progress,
    installError: installErrorCode(s.installError),
  }
  if (s.info) out.info = s.info
  return out
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  info: null,
  checking: false,
  phase: 'idle',
  installing: false,
  progress: null,
  error: null,
  installError: null,
  opened: false,
  promptOpen: false,

  check: async () => {
    if (get().checking) return get().info
    set({ checking: true, error: null })
    try {
      const info = await window.snApi.updates.check()
      // While main downloads, its info is the one being installed.
      if (get().installing) set({ checking: false, error: info.error ?? null })
      else set({ info, checking: false, error: info.error ?? null })
      return info
    } catch (err) {
      set({ checking: false, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  install: async () => {
    // main owns the phase and pushes it on `update:state`; this optimistic
    // copy only covers the round trip. A second call joins main's install.
    if (!get().installing) {
      set({
        phase: 'downloading',
        installing: true,
        installError: null,
        opened: false,
        progress: { percent: 0, transferred: 0, total: 0 },
      })
    }
    try {
      const { relaunching } = await window.snApi.updates.downloadAndInstall()
      // When relaunching, the app is about to quit; otherwise we opened the file.
      if (!relaunching) set({ phase: 'opened', installing: false, opened: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ phase: 'failed', installing: false, installError: installErrorCode(message) })
    }
  },

  openPrompt: () => set({ promptOpen: true }),
  closePrompt: () => set({ promptOpen: false }),
}))

/** User-facing text for an install error (known codes get their own message). */
export function installErrorText(t: TFn, error: string): string {
  return error === MISSING_CHECKSUM ? t('update.error.missingChecksum') : t('update.installFailed', { error })
}

let eventsWired = false

/**
 * Wire main's update state into the store (idempotent): the current state
 * first, so a reload mid-download brings the phase and percent back
 * (E4-FR-37), then every phase change and the download-progress stream.
 */
export function initUpdaterEvents(): () => void {
  if (eventsWired) return () => undefined
  eventsWired = true
  const apply = (s: UpdateState): void => useUpdaterStore.setState(mirrorUpdateState(s))
  const offState = window.snApi.updates.onState(apply)
  const offProgress = window.snApi.updates.onProgress((p) => useUpdaterStore.setState({ progress: p }))
  void window.snApi.updates
    .getState()
    .then((s) => {
      if (eventsWired) apply(s)
    })
    .catch(() => undefined)
  return () => {
    eventsWired = false
    offState()
    offProgress()
  }
}
