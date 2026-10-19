/**
 * Service worker registration (E3-FR-47): only in a secure context (the
 * secure mode's https origin; http has no service workers anyway), scope
 * `./`. A notification tap on an open app arrives as a `snaos-open` message
 * with the deep link hash (E3-FR-45), applied like a hash the user opened:
 * the client's hashchange handler picks the console.
 */

/** The hash of a `snaos-open` message, or null for anything else (pure). */
export function openHashOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const msg = data as { type?: unknown; hash?: unknown }
  if (msg.type !== 'snaos-open' || typeof msg.hash !== 'string') return null
  return /^#ws=[^&#]{1,400}&pane=[^&#]{1,400}$/.test(msg.hash) ? msg.hash : null
}

export function registerServiceWorker(): void {
  try {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
      const hash = openHashOf(ev.data)
      if (hash) location.hash = hash
    })
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined)
  } catch {
    /* no service worker: the app works the same without it */
  }
}
