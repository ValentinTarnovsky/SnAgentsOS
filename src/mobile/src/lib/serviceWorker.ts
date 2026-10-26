/**
 * Service worker registration (E3-FR-47): only in a secure context (the
 * secure mode's https origin; http has no service workers anyway), scope
 * `./`. A notification tap on an open app arrives as a `snaos-open` message
 * with the deep link hash (E3-FR-45), applied like a hash the user opened:
 * the client's hashchange handler picks the console, or (app 2.7.0, E10 B8)
 * the team and task of a team push.
 *
 * App 2.7.0 (E10 B8): the hash is set with replaceState and the hashchange is
 * dispatched by hand. `location.hash = hash` is a fragment navigation: it adds
 * a history entry and fires a popstate with state null, which BackStackHost
 * reads as the user's back (the pushed screen on top closed, and the entry
 * left behind cost a dead back press later).
 */

const PANE_HASH_RE = /^#ws=[^&#]{1,400}&pane=[^&#]{1,400}$/
/** app 2.7.0: `#team=<id>[&task=<id>]`, the ids of src/shared/teams.ts (else a tap with the app open is dropped). */
const TEAM_HASH_RE = /^#team=tm-[a-f0-9]{12}(?:&task=t-[0-9]{1,5})?$/

/** The hash of a `snaos-open` message, or null for anything else (pure). */
export function openHashOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const msg = data as { type?: unknown; hash?: unknown }
  if (msg.type !== 'snaos-open' || typeof msg.hash !== 'string') return null
  return PANE_HASH_RE.test(msg.hash) || TEAM_HASH_RE.test(msg.hash) ? msg.hash : null
}

/** A tapped notification's hash, applied without a history entry nor a popstate (the back stack's state is kept). */
function openTappedHash(hash: string): void {
  const oldURL = location.href
  try {
    history.replaceState(history.state, '', hash)
  } catch {
    // replaceState refused (Safari's rate limit): the tap only focused the app.
    return
  }
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }))
}

export function registerServiceWorker(): void {
  try {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
      const hash = openHashOf(ev.data)
      if (hash) openTappedHash(hash)
    })
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined)
  } catch {
    /* no service worker: the app works the same without it */
  }
}
