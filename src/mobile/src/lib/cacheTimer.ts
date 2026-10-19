/**
 * Claude prompt cache countdown on the phone (E5-FR-28). No new WS message
 * or field: the start comes from RemotePaneStatus (M1). A live `paneStatus`
 * delta that carries the working -> done/idle transition stamps the phone's
 * own clock at reception, so the chip never depends on the phone's clock
 * matching the desktop's. With only a snapshot (`authOk` / `state`), a pane
 * already `done` starts at its `stateSince` (desktop clock; the skew is
 * accepted). The switch and the TTL are this phone's own, in localStorage
 * `snagentsos.cacheTimer` (try/catch through mobileStorage).
 */
import { create } from 'zustand'
import { loadCachePrefs, saveCachePrefs, trackCacheStarts, type CacheStart, type CacheTimerPrefs } from './cacheTrack'
import { useRemoteStore } from './store'

export { cacheEnd, CACHE_TIMER_KEY, DEFAULT_CACHE_PREFS, loadCachePrefs, saveCachePrefs, trackCacheStarts } from './cacheTrack'
export type { CacheStart, CacheTimerPrefs } from './cacheTrack'

interface CacheTimerState {
  prefs: CacheTimerPrefs
  starts: Record<string, CacheStart>
  setPrefs: (patch: Partial<CacheTimerPrefs>) => void
}

export const useCacheTimer = create<CacheTimerState>((set, get) => ({
  prefs: loadCachePrefs(),
  starts: {},
  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch }
    saveCachePrefs(prefs)
    set({ prefs })
  },
}))

let started = false

/** Follow the phone store's statuses (call once at boot). Idempotent; returns a stop function. */
export function startCacheTimer(): () => void {
  if (started) return () => undefined
  started = true
  const initial = useRemoteStore.getState().paneStatus
  useCacheTimer.setState({ starts: trackCacheStarts({}, {}, initial, 'snapshot', Date.now()) })
  const off = useRemoteStore.subscribe((s, prev) => {
    if (s.paneStatus === prev.paneStatus) return
    const mode = s.snapshot !== prev.snapshot ? 'snapshot' : 'delta'
    useCacheTimer.setState((c) => ({ starts: trackCacheStarts(c.starts, prev.paneStatus, s.paneStatus, mode, Date.now()) }))
  })
  return () => {
    off()
    started = false
  }
}
