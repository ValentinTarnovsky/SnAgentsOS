/**
 * Per-origin device credentials for the phone client.
 *
 * localStorage is keyed by origin, which is deliberate: a phone paired over the
 * LAN IP and the same phone over the Tailscale IP are two distinct origins and
 * therefore two distinct pairings (see the plan's accepted risks). A DHCP IP
 * change or a port change likewise forces a re-pair - the QR modal hints users
 * toward the stable Tailscale IP.
 *
 * Keys live under BRAND.mobileStoragePrefix. A phone paired by 1.x still holds
 * them under LEGACY_BRAND.mobileStoragePrefix: the first read of each page load
 * copies those to the new keys, re-reads to confirm and only then removes the
 * legacy ones (E0-FR-18). If the copy cannot be written (private mode, quota)
 * the legacy values serve from memory and stay in storage, so the next load
 * retries. Every storage access is wrapped: a throwing localStorage must never
 * break the boot.
 */
import { BRAND, LEGACY_BRAND } from '@shared/brand'
import { bytesToHex } from './sha256'

type AuthKey = 'deviceId' | 'secret' | 'hostPlatform'
const AUTH_KEYS: AuthKey[] = ['deviceId', 'secret', 'hostPlatform']
const KEY = (k: AuthKey): string => `${BRAND.mobileStoragePrefix}remote.${k}`
const LEGACY_KEY = (k: AuthKey): string => `${LEGACY_BRAND.mobileStoragePrefix}remote.${k}`

export interface StoredAuth {
  deviceId: string
  /** 256-bit device secret as lowercase hex. */
  secretHex: string
}

let migrationTried = false
// Legacy values kept in memory when the migration could not write the new keys.
// Cleared by storeAuth and clearAuth so a revoked device never comes back.
let legacyFallback: Partial<Record<AuthKey, string>> = {}

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** removeItem one key at a time, so one failure never skips the others. */
function removeKeys(keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }
}

/**
 * One-shot migration of the 1.x keys, run on the first read of a page load.
 * Copies every legacy key that exists, confirms each write by reading it back,
 * and removes the legacy keys only after all of them are confirmed. A failed or
 * unconfirmed write rolls back the partial copy (so the next load sees the new
 * keys missing and retries) and keeps the legacy values in memory.
 */
function migrateLegacyAuthOnce(): void {
  if (migrationTried) return
  migrationTried = true
  const legacy: Partial<Record<AuthKey, string>> = {}
  for (const k of AUTH_KEYS) {
    const value = getItem(LEGACY_KEY(k))
    if (value !== null) legacy[k] = value
  }
  if (!legacy.deviceId) return
  if (getItem(KEY('deviceId')) !== null) {
    // Already migrated (a removeItem failed last time): the new keys win, the
    // legacy leftovers only risk resurrecting an older pairing.
    removeKeys(AUTH_KEYS.map(LEGACY_KEY))
    return
  }
  const written: string[] = []
  try {
    for (const k of AUTH_KEYS) {
      const value = legacy[k]
      if (value === undefined) continue
      written.push(KEY(k))
      localStorage.setItem(KEY(k), value)
      if (localStorage.getItem(KEY(k)) !== value) throw new Error('write not confirmed')
    }
  } catch {
    removeKeys(written)
    legacyFallback = legacy
    return
  }
  removeKeys(AUTH_KEYS.map(LEGACY_KEY))
}

/** Read one credential: the stored new key, else the in-memory legacy fallback. */
function readKey(k: AuthKey): string | null {
  migrateLegacyAuthOnce()
  return getItem(KEY(k)) ?? legacyFallback[k] ?? null
}

/** Read the stored device credentials, or null if this origin is unpaired. */
export function getStoredAuth(): StoredAuth | null {
  const deviceId = readKey('deviceId')
  const secretHex = readKey('secret')
  if (deviceId && secretHex) return { deviceId, secretHex }
  return null
}

/**
 * Persist the credentials returned by a successful pairing. The legacy keys go
 * too: left behind they would hold another deviceId's credential.
 */
export function storeAuth(deviceId: string, secretHex: string): void {
  migrationTried = true
  legacyFallback = {}
  try {
    localStorage.setItem(KEY('deviceId'), deviceId)
    localStorage.setItem(KEY('secret'), secretHex)
  } catch {
    /* nothing we can do; the session stays authed in memory until reload */
  }
  removeKeys(AUTH_KEYS.map(LEGACY_KEY))
}

/**
 * Forget this origin's credentials (revocation or manual unpair). The legacy
 * keys are removed as well, as a safety net for a migration that never got to
 * write, so a revoked device cannot come back from them on the next load.
 */
export function clearAuth(): void {
  migrationTried = true
  legacyFallback = {}
  removeKeys([KEY('deviceId'), KEY('secret'), ...AUTH_KEYS.map(LEGACY_KEY)])
}

/**
 * Persist the desktop OS learned from a reconnect's authOk. The pairing path
 * never carries hostPlatform, so caching it lets a later Windows session enable
 * xterm's windowsPty even before the next authOk. Best-effort only.
 */
export function storeHostPlatform(platform: string): void {
  try {
    if (platform) localStorage.setItem(KEY('hostPlatform'), platform)
  } catch {
    /* ignore */
  }
}

/** Read the cached desktop OS, or '' if never learned. */
export function getStoredHostPlatform(): string {
  return readKey('hostPlatform') ?? ''
}

/**
 * Generate a fresh random nonce as lowercase hex. Uses crypto.getRandomValues,
 * which - unlike crypto.subtle - IS available on insecure (http) origins.
 */
export function randomNonceHex(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return bytesToHex(buf)
}
