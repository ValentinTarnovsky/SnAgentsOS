import type { Session } from 'electron'

/**
 * Web permissions of the app window (app 2.4.0). The renderer only needs
 * `new Notification` (scheduled consoles), the sanitized clipboard write and
 * fullscreen; everything else is denied, `media` included: dictation runs in
 * main's helper, never through getUserMedia. Only the app's own page gets
 * even those: the dev server origin when ELECTRON_RENDERER_URL is set, else
 * the exact renderer index.html file.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])

/**
 * True when `url` belongs to the page the window loads (`appUrl`). A file
 * page has an opaque origin, so it matches on the file path (case-insensitive
 * on Windows); an http page matches on the origin.
 */
export function isAppOrigin(url: string | undefined | null, appUrl: string, win32 = process.platform === 'win32'): boolean {
  if (!url) return false
  let u: URL
  let app: URL
  try {
    u = new URL(url)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') {
    if (u.protocol !== 'file:' || u.host !== app.host) return false
    const a = decodeURIComponent(u.pathname)
    const b = decodeURIComponent(app.pathname)
    return win32 ? a.toLowerCase() === b.toLowerCase() : a === b
  }
  if (app.protocol !== 'http:' && app.protocol !== 'https:') return false
  return u.origin === app.origin
}

export function allowPermission(permission: string, url: string | undefined | null, appUrl: string, win32?: boolean): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(url, appUrl, win32)
}

/** Both handlers on the session the window uses (before it loads anything). */
export function installPermissionHandlers(ses: Session, appUrl: string): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowPermission(permission, details.requestingUrl, appUrl))
  })
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const url = details.requestingUrl || wc?.getURL() || requestingOrigin
    return allowPermission(permission, url, appUrl)
  })
}
