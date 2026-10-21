import { safeStorage } from 'electron'

/**
 * Encryption of the saved Claude logins (app 2.3.0). The only accounts module
 * that imports Electron; the vault and the service take a `VaultCrypto` so
 * the tests can fake it. Windows uses DPAPI (bound to the Windows user, so a
 * portable folder moved to another user or PC cannot decrypt: the slot asks
 * to be captured again). On Linux the plaintext `basic_text` backend is
 * refused. `safeStorage` needs app ready.
 */
export interface VaultCrypto {
  available(): boolean
  encrypt(s: string): Buffer
  /** Throws when the blob cannot be decrypted. */
  decrypt(b: Buffer): string
}

export function electronCrypto(): VaultCrypto {
  return {
    available(): boolean {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false
        if (process.platform === 'linux') {
          const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
          if (!backend || backend === 'basic_text' || backend === 'unknown') return false
        }
        return true
      } catch {
        return false
      }
    },
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  }
}
