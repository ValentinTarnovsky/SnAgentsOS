import { create } from 'zustand'
import type { LegacyDataInfo } from '@shared/ipc-contract'

/**
 * 1.x migration state as main reports it (E0-FR-10, 28, 35): loaded once on
 * start and kept live by app:legacyStatus. Main owns the marker; the only
 * thing the renderer can ask for is noticeSeen (ack).
 */
interface LegacyState {
  info: LegacyDataInfo | null
  /** Banners closed in this session; a failure shows again on the next start. */
  dismissed: { failed: boolean; deferred: boolean }
  ack: () => void
  dismiss: (kind: 'failed' | 'deferred') => void
}

export const useLegacyStore = create<LegacyState>((set, get) => ({
  info: null,
  dismissed: { failed: false, deferred: false },

  ack: () => {
    const info = get().info
    if (info) set({ info: { ...info, noticeSeen: true } })
    window.snApi.app.legacyAck()
  },
  dismiss: (kind) => set({ dismissed: { ...get().dismissed, [kind]: true } }),
}))

const COMMITTED = new Set(['committed', 'cleaning', 'done'])

/** The welcome notice: once, after a confirmed migration that brought data over (never for noLegacy). */
export function shouldShowNotice(info: LegacyDataInfo | null): boolean {
  return !!info && info.outcome === 'migrated' && COMMITTED.has(info.phase ?? '') && !info.noticeSeen
}

export type CleanupStatus = 'running' | 'done' | 'deferred'

/** Line of the notice: finished, waiting on items in use, or still going. */
export function cleanupStatus(info: LegacyDataInfo): CleanupStatus {
  if (info.phase === 'done') return 'done'
  if (info.cleanup.deferred > 0 && info.cleanup.pending === 0) return 'deferred'
  return 'running'
}

/** Which banner shows, if any: a failed migration wins over leftovers in use. */
export function bannerKind(info: LegacyDataInfo | null, dismissed: LegacyState['dismissed']): 'failed' | 'deferred' | null {
  if (!info) return null
  if (info.failure && !dismissed.failed) return 'failed'
  if (info.showDeferredBanner && !dismissed.deferred) return 'deferred'
  return null
}

/** Expiry date of the backup zip in the UI language (the notice and Settings > Data say the same). */
export function formatBackupDate(ms: number, lang: string): string {
  return new Date(ms).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Loads the state and subscribes to updates. Returns the unsubscribe function. */
export function initLegacyEvents(): () => void {
  let live = false
  const unsub = window.snApi.app.onLegacyStatus((info) => {
    live = true
    // An ack already sent wins over a push computed before main wrote it.
    const seen = useLegacyStore.getState().info?.noticeSeen === true
    useLegacyStore.setState({ info: seen ? { ...info, noticeSeen: true } : info })
  })
  window.snApi.app
    .legacyInfo()
    .then((info) => {
      // A push that arrived first is newer than this reply.
      if (!live) useLegacyStore.setState({ info })
    })
    .catch(() => {})
  return unsub
}
