/**
 * Pure side of the phone's Claude cache countdown (E5-FR-28): this phone's
 * switch and TTL in localStorage `snagentsos.cacheTimer` (try/catch through
 * mobileStorage) and the start tracking over RemotePaneStatus. No store, no
 * DOM, so it runs under node in scripts/test-hibernation.cjs.
 */
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { cacheApplies } from '@shared/hibernation'
import { STORAGE_PREFIX, storageGet, storageSet } from './mobileStorage'

export const CACHE_TIMER_KEY = `${STORAGE_PREFIX}cacheTimer`

export interface CacheTimerPrefs {
  enabled: boolean
  ttlMinutes: 5 | 60
}

export const DEFAULT_CACHE_PREFS: CacheTimerPrefs = { enabled: false, ttlMinutes: 5 }

/** Stored prefs, defaults for anything missing or malformed. */
export function loadCachePrefs(): CacheTimerPrefs {
  const raw = storageGet(CACHE_TIMER_KEY)
  if (!raw) return { ...DEFAULT_CACHE_PREFS }
  try {
    const v = JSON.parse(raw) as Partial<CacheTimerPrefs> | null
    return { enabled: v?.enabled === true, ttlMinutes: v?.ttlMinutes === 60 ? 60 : 5 }
  } catch {
    return { ...DEFAULT_CACHE_PREFS }
  }
}

export function saveCachePrefs(prefs: CacheTimerPrefs): boolean {
  return storageSet(CACHE_TIMER_KEY, JSON.stringify({ enabled: prefs.enabled, ttlMinutes: prefs.ttlMinutes }))
}

/** When one pane's countdown started, and the stateSince it was stamped for. */
export interface CacheStart {
  /** Epoch ms the cache started (phone clock for a live transition, desktop clock from a snapshot). */
  start: number
  since: number
}

/**
 * Next start map after a status change. `delta`: a live paneStatus (a
 * working -> done/idle transition stamps `now`). `snapshot`: authOk/state
 * (a pane newly seen `done`, or `done` again since the last stamp, starts at
 * its stateSince). A pane that is not Claude between turns has no entry.
 */
export function trackCacheStarts(
  prev: Readonly<Record<string, CacheStart>>,
  before: Readonly<Record<string, RemotePaneStatus>>,
  after: Readonly<Record<string, RemotePaneStatus>>,
  mode: 'delta' | 'snapshot',
  now: number,
): Record<string, CacheStart> {
  const next: Record<string, CacheStart> = {}
  for (const [paneId, st] of Object.entries(after)) {
    if (!cacheApplies(st)) continue
    const was = before[paneId]
    const entry = prev[paneId]
    if (mode === 'delta' && was?.state === 'working') {
      next[paneId] = { start: now, since: st.stateSince }
    } else if (entry && !(mode === 'snapshot' && st.state === 'done' && st.stateSince !== entry.since)) {
      next[paneId] = { start: entry.start, since: st.stateSince }
    } else if (st.state === 'done' && typeof st.stateSince === 'number') {
      next[paneId] = { start: st.stateSince, since: st.stateSince }
    }
  }
  return next
}

/** Epoch ms the cache expires, or null. */
export function cacheEnd(start: CacheStart | undefined, prefs: CacheTimerPrefs): number | null {
  if (!prefs.enabled || !start) return null
  return start.start + prefs.ttlMinutes * 60_000
}
