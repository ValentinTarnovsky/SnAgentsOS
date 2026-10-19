/**
 * Build step of the service worker (E3-FR-47): public/sw.js is copied as is
 * by Vite, then this fills its two markers with the desktop version (the
 * cache is `snaos-<version>`, so an update drops the old one) and the
 * precache list (the app shell, the hashed js/css, the manifest and icons).
 * Fonts are cached on first use instead: only the subsets a phone needs.
 */

/** Files of a build worth precaching, relative to the bundle root, in a stable order. */
export function precacheList(fileNames: string[]): string[] {
  const picked = fileNames.filter((f) => /^assets\/[^/]+\.(?:js|css)$/.test(f) || f === 'manifest.webmanifest' || /^icons\/[^/]+\.png$/.test(f))
  return ['./', 'index.html', ...[...new Set(picked)].sort()]
}

/** public/sw.js with VERSION and PRECACHE filled; throws when a marker is missing. */
export function fillServiceWorker(template: string, version: string, files: string[]): string {
  const versionMarker = "'dev' /* __SNAOS_VERSION__ */"
  const listMarker = '[] /* __SNAOS_PRECACHE__ */'
  if (!template.includes(versionMarker) || !template.includes(listMarker)) throw new Error('sw.js: build markers not found')
  return template.replace(versionMarker, JSON.stringify(version)).replace(listMarker, JSON.stringify(files))
}
