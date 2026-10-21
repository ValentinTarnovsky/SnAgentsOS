import type { Session } from 'electron'

/**
 * Web permissions of the app window (app 2.5.0). The renderer needs
 * `new Notification` (scheduled consoles), the sanitized clipboard write,
 * fullscreen and, for desktop dictation, the microphone: `media` is granted
 * only when every requested media type is audio (never the camera, never a
 * screen capture). Everything else is denied. Only the app's own page gets
 * any of them: the dev server origin when ELECTRON_RENDERER_URL is set, else
 * the exact renderer index.html file.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])

/**
 * The media types of a `media` request or check: `types` from a request's
 * `details.mediaTypes`, `type` from a check's `details.mediaType`.
 */
export interface MediaAsk {
  types?: readonly unknown[]
  type?: unknown
}

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

/**
 * Audio only: a request names at least one type and all of them are
 * 'audio'; a check names 'audio'. Missing, empty, 'video', 'unknown' or a
 * mix fail closed.
 */
export function audioOnly(media: MediaAsk | undefined | null): boolean {
  if (!media) return false
  const { types, type } = media
  if (types === undefined && type === undefined) return false
  if (types !== undefined && (!Array.isArray(types) || types.length === 0 || !types.every((t) => t === 'audio'))) return false
  if (type !== undefined && type !== 'audio') return false
  return true
}

export function allowPermission(permission: string, url: string | undefined | null, appUrl: string, win32?: boolean, media?: MediaAsk | null): boolean {
  if (!isAppOrigin(url, appUrl, win32)) return false
  if (permission === 'media') return audioOnly(media)
  return ALLOWED_PERMISSIONS.has(permission)
}

/** Both handlers on the session the window uses (before it loads anything). */
export function installPermissionHandlers(ses: Session, appUrl: string): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const media = permission === 'media' ? { types: (details as { mediaTypes?: unknown[] }).mediaTypes ?? [] } : null
    callback(allowPermission(permission, details.requestingUrl, appUrl, undefined, media))
  })
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const url = details.requestingUrl || wc?.getURL() || requestingOrigin
    const media = permission === 'media' ? { type: details.mediaType ?? 'unknown' } : null
    return allowPermission(permission, url, appUrl, undefined, media)
  })
}
