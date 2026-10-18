/**
 * Persistence and reactive state of the KeyBar layout (E2-FR-45, 46). The
 * layout lives in this phone's localStorage under `snagentsos.keybar` as
 * `{version, orderedIds, visibleIds, custom[]}`; the desktop config is
 * untouched, so there is no CONFIG_VERSION bump.
 *
 * The store keeps the layout exactly as it was read, and every consumer sees
 * normalizeLayout(stored, snapshot.keyButtons) instead. That way a snapshot
 * that has not arrived yet (or a desktop key that is gone for a moment) never
 * rewrites what was saved: the reconciled layout is only written back when the
 * user changes something. A corrupt or blocked storage reads as the default.
 * The layout is a device preference, so unpairing does not clear it.
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import type { KeyButton } from '@shared/types'
import { STORAGE_PREFIX, storageGet, storageSet } from './mobileStorage'
import { useRemoteStore } from './store'
import { normalizeLayout, type KeyLayout } from './keys'

export const KEYBAR_STORAGE_KEY = `${STORAGE_PREFIX}keybar`

const NO_DESK_KEYS: readonly KeyButton[] = []

/** The stored layout as parsed JSON, or null when absent, blocked or corrupt. */
export function loadStoredLayout(): unknown {
  const raw = storageGet(KEYBAR_STORAGE_KEY)
  if (raw == null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** True when the layout was written. */
export function saveStoredLayout(layout: KeyLayout): boolean {
  return storageSet(KEYBAR_STORAGE_KEY, JSON.stringify(layout))
}

interface KeyLayoutState {
  /** What `snagentsos.keybar` held (or the last layout saved this session). */
  stored: unknown
  /** Persist a layout and make it current, even when the write fails. */
  save: (layout: KeyLayout) => void
}

export const useKeyLayoutStore = create<KeyLayoutState>((set) => ({
  stored: loadStoredLayout(),
  save: (layout) => {
    saveStoredLayout(layout)
    set({ stored: layout })
  },
}))

export const keyLayoutStore = useKeyLayoutStore

/** The effective layout: the stored one reconciled with the desktop's keyButtons. */
export function useKeyLayout(): { layout: KeyLayout; deskButtons: readonly KeyButton[] } {
  const stored = useKeyLayoutStore((s) => s.stored)
  const deskButtons = useRemoteStore((s) => s.snapshot?.keyButtons) ?? NO_DESK_KEYS
  const layout = useMemo(() => normalizeLayout(stored, deskButtons), [stored, deskButtons])
  return { layout, deskButtons }
}
