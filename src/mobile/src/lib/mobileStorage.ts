/**
 * localStorage wrapper for the phone's per-device state (E1-FR-28). Every
 * access is wrapped in try/catch: a private window, blocked site data or a
 * full quota must never break the live screen, so reads fall back to null and
 * writes report false instead of throwing.
 *
 * All keys carry the brand prefix (`snagentsos.`). clearMobileStorage() wipes
 * the composer's per-pane keys (drafts and input modes) when the device is
 * unpaired or revoked; the pairing keys are auth.ts's business.
 */
import { BRAND } from '@shared/brand'

export const STORAGE_PREFIX = BRAND.mobileStoragePrefix
export const DRAFT_PREFIX = `${STORAGE_PREFIX}draft.`
export const INPUT_MODE_PREFIX = `${STORAGE_PREFIX}inputMode.`
/** E3-FR-54: review notes written on this phone, one key per workspace. */
export const REMOTE_NOTES_PREFIX = `${STORAGE_PREFIX}remote.notes.`

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** True when the value was written. */
export function storageSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* storage blocked: nothing to remove */
  }
}

/** Every stored key that starts with prefix (empty when storage is blocked). */
export function storageKeys(prefix: string): string[] {
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key != null && key.startsWith(prefix)) keys.push(key)
    }
  } catch {
    /* storage blocked */
  }
  return keys
}

let wipeGeneration = 0

/**
 * Bumped by every clearMobileStorage(). A debounced draft write scheduled
 * before a wipe checks it and is dropped, so the composer unmounting right
 * after a revoke (or the pagehide of unpair's reload) cannot write it back.
 */
export function storageWipeGeneration(): number {
  return wipeGeneration
}

/**
 * Remove every `snagentsos.draft.*`, `snagentsos.inputMode.*` and
 * `snagentsos.remote.notes.*` key (unpair, close 4403, `revoked`): a phone
 * that lost its pairing keeps no review notes about the PC's code. Keys are
 * collected first and removed one at a time, so one failure never skips the
 * others. Returns how many were removed.
 */
export function clearMobileStorage(): number {
  wipeGeneration++
  const keys = [...storageKeys(DRAFT_PREFIX), ...storageKeys(INPUT_MODE_PREFIX), ...storageKeys(REMOTE_NOTES_PREFIX)]
  for (const key of keys) storageRemove(key)
  return keys.length
}
