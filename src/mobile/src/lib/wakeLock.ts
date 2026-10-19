/**
 * "Keep the screen on while I watch a console" (E3-FR-49). A per-phone
 * setting (`snagentsos.remote.wakeLock`, off by default). In a secure context
 * it holds `navigator.wakeLock.request('screen')` while the live screen is a
 * console (Terminal or its Chat view), lets go on Home or in the background,
 * and takes it again when the page comes back (the browser releases it on
 * its own when the page hides). Over plain http Settings shows the switch
 * disabled with "Requires secure mode".
 */
import { create } from 'zustand'
import { STORAGE_PREFIX, storageGet, storageSet } from './mobileStorage'
import { store } from './store'

export const WAKE_LOCK_KEY = `${STORAGE_PREFIX}remote.wakeLock`

export function loadWakeLockPref(): boolean {
  return storageGet(WAKE_LOCK_KEY) === '1'
}

/** Whether the lock should be held right now (pure, for the tests). */
export function wantsWakeLock(s: { pref: boolean; secure: boolean; supported: boolean; live: boolean; screen: string; visible: boolean }): boolean {
  return s.pref && s.secure && s.supported && s.live && s.visible && s.screen === 'terminal'
}

export function isSecure(): boolean {
  try {
    return window.isSecureContext === true
  } catch {
    return false
  }
}

export function wakeLockSupported(): boolean {
  try {
    return window.isSecureContext === true && 'wakeLock' in navigator
  } catch {
    return false
  }
}

export const useWakeLockStore = create<{ pref: boolean; held: boolean; setPref: (on: boolean) => void }>((set) => ({
  pref: loadWakeLockPref(),
  held: false,
  setPref: (on) => {
    storageSet(WAKE_LOCK_KEY, on ? '1' : '0')
    set({ pref: on })
    syncWakeLock()
  },
}))

type Sentinel = { released: boolean; release: () => Promise<void>; addEventListener: (t: 'release', fn: () => void) => void }

let sentinel: Sentinel | null = null
let requesting = false

function want(): boolean {
  const s = store.getState()
  let visible = true
  try {
    visible = document.visibilityState === 'visible'
  } catch {
    visible = true
  }
  return wantsWakeLock({
    pref: useWakeLockStore.getState().pref,
    secure: isSecure(),
    supported: wakeLockSupported(),
    live: s.phase === 'live',
    screen: s.screen,
    visible,
  })
}

/** Take or let go of the lock to match the current screen and setting. */
export function syncWakeLock(): void {
  if (want()) {
    if ((sentinel && !sentinel.released) || requesting) return
    requesting = true
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } }).wakeLock
    if (!wl) {
      requesting = false
      return
    }
    wl.request('screen')
      .then((s) => {
        requesting = false
        sentinel = s
        useWakeLockStore.setState({ held: true })
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null
          useWakeLockStore.setState({ held: false })
        })
        // The screen changed while the request was pending.
        if (!want()) syncWakeLock()
      })
      .catch(() => {
        requesting = false
        useWakeLockStore.setState({ held: false })
      })
    return
  }
  const s = sentinel
  sentinel = null
  if (s && !s.released) void s.release().catch(() => undefined)
  useWakeLockStore.setState({ held: false })
}

let started = false

/** Follow the live screen and the page visibility (main.tsx, once). */
export function startWakeLock(): void {
  if (started) return
  started = true
  store.subscribe((s, prev) => {
    if (s.screen !== prev.screen || s.phase !== prev.phase) syncWakeLock()
  })
  document.addEventListener('visibilitychange', () => syncWakeLock())
  syncWakeLock()
}
