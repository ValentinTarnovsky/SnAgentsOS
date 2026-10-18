/**
 * In-app drags of a file path (rows of the Changes panel) carry
 * `application/x-snaos-path` = JSON `{nonce, path}`. Another Chromium app can
 * put the same custom MIME on a drag, so a pane only accepts the payload when
 * the nonce is this renderer's own, the path is one the app is currently
 * listing, and it is a short single line (E7-FR-04).
 */
export const INTERNAL_PATH_MIME = 'application/x-snaos-path'

/** Random per renderer load; never leaves the process. */
export const DRAG_NONCE: string = crypto.randomUUID()

/** Longest path accepted from an in-app drag. */
export const MAX_DRAG_PATH = 1024

type KnownPathResolver = (path: string) => boolean

// Until a source of listed paths registers (the git panel), every in-app path
// drag is rejected.
let knownPathResolver: KnownPathResolver = () => false

/** Set who decides whether an absolute path is currently listed in the app. */
export function setKnownPathResolver(resolver: KnownPathResolver | null): void {
  knownPathResolver = resolver ?? (() => false)
}

export function isKnownDragPath(path: string): boolean {
  try {
    return knownPathResolver(path) === true
  } catch {
    return false
  }
}

/** Payload a drag source puts under INTERNAL_PATH_MIME. */
export function encodeInternalPath(path: string, nonce: string = DRAG_NONCE): string {
  return JSON.stringify({ nonce, path })
}

/**
 * Validate an INTERNAL_PATH_MIME payload. Returns the path, or null when any
 * check fails (the drop is then ignored without writing anything).
 */
export function parseInternalPath(
  raw: string,
  nonce: string = DRAG_NONCE,
  isKnown: KnownPathResolver = isKnownDragPath,
): string | null {
  if (!raw || raw.length > MAX_DRAG_PATH * 8) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const { nonce: n, path } = data as { nonce?: unknown; path?: unknown }
  if (typeof n !== 'string' || n !== nonce) return null
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_DRAG_PATH) return null
  if (hasLineOrControlChar(path)) return null
  return isKnown(path) ? path : null
}

/** C0, DEL, C1 and the Unicode line/paragraph separators (U+2028/U+2029). */
function hasLineOrControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}
