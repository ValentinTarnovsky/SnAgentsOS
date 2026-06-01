import { shell } from 'electron'

// Only these protocols may ever reach the OS shell. This blocks about:,
// file:, javascript: and similar from being handed to shell.openExternal
// (terminal output and window.open() can otherwise smuggle them through).
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** True only for URLs we are willing to open in the OS default handler. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/** Open a URL in the OS default browser, ignoring anything unsafe/malformed. */
export function openExternalSafe(url: unknown): void {
  if (typeof url === 'string' && isSafeExternalUrl(url)) {
    void shell.openExternal(url)
  }
}
