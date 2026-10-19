import { create } from 'zustand'
import {
  MISSING_CHECKSUM,
  type UpdateInfo,
  type UpdatePhase,
  type UpdateProgress,
  type UpdateState,
} from '@shared/ipc-contract'
import type { TFn } from '@/i18n'
import { shouldPersistDismiss, shouldRecheck } from '@/components/updates/update-card-visibility'

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
  /** The card was collapsed (download) or closed (failed / opened) into the chip (E4-FR-16). */
  cardCollapsed: boolean
  /** The user reopened the card from the chip: dismissals do not hide it. */
  userInitiated: boolean
  /** A non-installable version closed this session (E4-FR-13, never persisted). */
  sessionDismissed: string | null
  /** ReleaseNotesModal is open (from the card or from Settings). */
  notesOpen: boolean

  check: () => Promise<UpdateInfo | null>
  install: () => Promise<void>
  /**
   * X / [Later] on an offer: an installable version goes to `persist`
   * (settings.updateDismissedVersion), any other only hides for the session.
   */
  dismissCard: (persist: (version: string) => void) => void
  /** Chevron during the download, X on a failed / opened card. */
  collapseCard: () => void
  /** Chip click: bring the card back. */
  showCard: () => void
  setNotesOpen: (open: boolean) => void
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

/**
 * The store fields that mirror main's update state. `prev` is the current
 * phase: a new offer (entering 'available') reopens a collapsed card.
 */
export function mirrorUpdateState(s: UpdateState, prev?: UpdatePhase): Partial<UpdaterState> {
  const out: Partial<UpdaterState> = {
    phase: s.phase,
    installing: isInstallPhase(s.phase),
    opened: s.phase === 'opened',
    progress: s.progress,
    installError: installErrorCode(s.installError),
  }
  if (s.info) out.info = s.info
  if (s.phase === 'available' && prev !== undefined && prev !== 'available') out.cardCollapsed = false
  return out
}

/**
 * sessionStorage key of the collapsed card: it survives a window reload (not a
 * restart), so reloading mid-download brings the chip back instead of the
 * expanded card (E4-FR-16, E4-FR-37). Storage can be missing or throw.
 */
const COLLAPSED_KEY = 'snaos.updateCardCollapsed'

function readCollapsed(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (typeof sessionStorage === 'undefined') return
    if (collapsed) sessionStorage.setItem(COLLAPSED_KEY, '1')
    else sessionStorage.removeItem(COLLAPSED_KEY)
  } catch {
    /* per-window convenience only */
  }
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
  cardCollapsed: readCollapsed(),
  userInitiated: false,
  sessionDismissed: null,
  notesOpen: false,

  check: async () => {
    if (get().checking) return get().info
    set({ checking: true, error: null })
    try {
      const info = await window.snApi.updates.check()
      // While main downloads, its info is the one being installed, and a
      // failed re-check keeps the last good offer (main keeps it too), so a
      // visible card never turns into an error result in place (E4-FR-18).
      const prev = get().info
      if (get().installing || (info.error && prev && !prev.error)) set({ checking: false, error: info.error ?? null })
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
        cardCollapsed: false,
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

  dismissCard: (persist) => {
    const info = get().info
    const latest = info?.latestVersion
    if (latest) {
      if (shouldPersistDismiss({ installable: !!info?.installable })) persist(latest)
      else set({ sessionDismissed: latest })
    }
    set({ userInitiated: false })
  },

  collapseCard: () => set({ cardCollapsed: true, userInitiated: false }),

  showCard: () => set({ cardCollapsed: false, userInitiated: true }),

  setNotesOpen: (open) => set({ notesOpen: open }),
}))

useUpdaterStore.subscribe((s, prev) => {
  if (s.cardCollapsed !== prev.cardCollapsed) writeCollapsed(s.cardCollapsed)
})

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
  const apply = (s: UpdateState): void => useUpdaterStore.setState(mirrorUpdateState(s, useUpdaterStore.getState().phase))
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

/** First automatic check after hydration: never competes with the first paint. */
export const STARTUP_CHECK_DELAY_MS = 2500
/** Periodic re-check while the app stays open (E4-FR-18). */
export const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Re-check after the newest release was still missing assets (E4-FR-14). */
export const NOT_READY_RECHECK_MS = 10 * 60 * 1000
/** Not-ready re-checks per version: an hour covers a CI run with margin. */
export const NOT_READY_MAX_RETRIES = 6

export interface SchedulerTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (h: unknown) => void
}

const realTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

/**
 * Automatic update checks (E4-FR-12, 14, 18): one 2.5 s after hydration, then
 * every 6 h while main is idle or offering (never mid-install), plus a 10 min
 * re-check while the newest release is still being published. `isEnabled`
 * reads settings.autoCheckUpdates on every tick. The card follows the store,
 * so a re-check refreshes a visible card in place. Returns the stop function.
 */
export function startUpdateScheduler(isEnabled: () => boolean, timers: SchedulerTimers = realTimers): () => void {
  let stopped = false
  let retry: unknown = null
  const retries = new Map<string, number>()

  const run = async (): Promise<void> => {
    if (stopped || !isEnabled() || !shouldRecheck({ phase: useUpdaterStore.getState().phase })) return
    const info = await useUpdaterStore.getState().check()
    const pending = info?.newestNotReady
    if (stopped || !pending || retry !== null) return
    const used = retries.get(pending) ?? 0
    if (used >= NOT_READY_MAX_RETRIES) return
    retries.set(pending, used + 1)
    retry = timers.setTimeout(() => {
      retry = null
      void run()
    }, NOT_READY_RECHECK_MS)
  }

  const startup = timers.setTimeout(() => void run(), STARTUP_CHECK_DELAY_MS)
  const interval = timers.setInterval(() => void run(), RECHECK_INTERVAL_MS)
  return () => {
    stopped = true
    timers.clearTimeout(startup)
    timers.clearInterval(interval)
    if (retry !== null) timers.clearTimeout(retry)
  }
}

/** Markdown release notes as up to `lines` plain-text lines (the card excerpt). */
export function notesExcerpt(markdown: string, lines = 3): string[] {
  const out: string[] = []
  let fence = false
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const text = raw
      .replace(/<[^>]*>/g, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*([-*_]\s*){3,}$/, '')
      .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|\s)[*_](\S)/g, '$1$2')
      .replace(/(\S)[*_](?=\s|$|[.,;:!?])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    out.push(text)
    if (out.length >= lines) break
  }
  return out
}
