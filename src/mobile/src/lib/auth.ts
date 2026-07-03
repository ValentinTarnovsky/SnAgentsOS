/**
 * Per-origin device credentials for the phone client.
 *
 * localStorage is keyed by origin, which is deliberate: a phone paired over the
 * LAN IP and the same phone over the Tailscale IP are two distinct origins and
 * therefore two distinct pairings (see the plan's accepted risks). A DHCP IP
 * change or a port change likewise forces a re-pair - the QR modal hints users
 * toward the stable Tailscale IP.
 */
import { bytesToHex } from './sha256'

const DEVICE_ID_KEY = 'snmulticc.remote.deviceId'
const SECRET_KEY = 'snmulticc.remote.secret'

export interface StoredAuth {
  deviceId: string
  /** 256-bit device secret as lowercase hex. */
  secretHex: string
}

/** Read the stored device credentials, or null if this origin is unpaired. */
export function getStoredAuth(): StoredAuth | null {
  try {
    const deviceId = localStorage.getItem(DEVICE_ID_KEY)
    const secretHex = localStorage.getItem(SECRET_KEY)
    if (deviceId && secretHex) return { deviceId, secretHex }
  } catch {
    /* private mode / storage disabled - treat as unpaired */
  }
  return null
}

/** Persist the credentials returned by a successful pairing. */
export function storeAuth(deviceId: string, secretHex: string): void {
  try {
    localStorage.setItem(DEVICE_ID_KEY, deviceId)
    localStorage.setItem(SECRET_KEY, secretHex)
  } catch {
    /* nothing we can do; the session stays authed in memory until reload */
  }
}

/** Forget this origin's credentials (revocation or manual unpair). */
export function clearAuth(): void {
  try {
    localStorage.removeItem(DEVICE_ID_KEY)
    localStorage.removeItem(SECRET_KEY)
  } catch {
    /* ignore */
  }
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
