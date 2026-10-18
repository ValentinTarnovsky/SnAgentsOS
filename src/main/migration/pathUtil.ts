import { resolve, sep } from 'path'

/**
 * Comparable form of a path: resolved, no trailing separator and, where the
 * filesystem is case-insensitive by default (Windows, macOS), lower-cased, so
 * snmulticc and SnMultiCC compare as the same folder.
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  let r = resolve(p)
  if (r.length > 1 && r.endsWith(sep) && !/^[A-Za-z]:\\$/.test(r)) r = r.slice(0, -1)
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** True when child is strictly below parent. */
export function isInside(child: string, parent: string): boolean {
  const c = pathKey(child)
  const p = pathKey(parent)
  return c !== p && c.startsWith(p.endsWith(sep) ? p : p + sep)
}

export function isSameOrInside(child: string, parent: string): boolean {
  return samePath(child, parent) || isInside(child, parent)
}

/** Same folder, or one inside the other. */
export function overlaps(a: string, b: string): boolean {
  return isSameOrInside(a, b) || isInside(b, a)
}
