/*
 * SnAgentsOS Remote service worker (E3-FR-47). Registered by main.tsx only in
 * a secure context (the `tailscale serve` https origin of the secure mode).
 *
 *  - Navigations and index.html: network first; the cache is only the offline
 *    fallback, so a desktop update shows up on the next load and the app can
 *    still open (and say it cannot reach the PC) with the PC off.
 *  - Hashed assets (assets/...): cache first, in the cache `snaos-<version>`.
 *  - `activate` deletes every older `snaos-*` cache; skipWaiting + clients.claim
 *    let the "Reload" of a version mismatch (E1-FR-15) land on the new worker.
 *  - Never touches /ws nor /api/*: the socket and the HTTP routes always go
 *    straight to the desktop.
 *  - `push` shows the desktop's notification (title, "<console> - <workspace>",
 *    tag = pane, so they never pile up); `notificationclick` focuses the app
 *    and opens that console through its deep link (E3-FR-45).
 *
 * vite.config.ts fills VERSION and PRECACHE at build time (swBuild.ts).
 */
const VERSION = 'dev' /* __SNAOS_VERSION__ */
const PRECACHE = [] /* __SNAOS_PRECACHE__ */
const CACHE = 'snaos-' + VERSION
const CACHE_PREFIX = 'snaos-'

/** The path of a request relative to the worker's scope ('' = the app root). */
function scopedPath(url) {
  const scope = new URL(self.registration.scope)
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null
  return url.pathname.slice(scope.pathname.length)
}

/** The WS endpoint and the HTTP routes: never cached, never answered here. */
function isBypassed(rel) {
  return rel === 'ws' || rel === 'api' || rel.startsWith('api/')
}

function isShell(request, rel) {
  return request.mode === 'navigate' || rel === '' || rel === 'index.html'
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request)
    if (res && res.ok) await cache.put(cacheKey, res.clone()).catch(() => undefined)
    return res
  } catch (err) {
    const hit = (await cache.match(cacheKey)) || (await caches.match(cacheKey))
    if (hit) return hit
    throw err
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res && res.ok) await cache.put(request, res.clone()).catch(() => undefined)
  return res
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' }))))
      .catch(() => undefined),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  const rel = scopedPath(url)
  if (rel === null || isBypassed(rel)) return
  if (isShell(request, rel)) {
    event.respondWith(networkFirst(request, new URL('index.html', self.registration.scope).href))
    return
  }
  if (rel.startsWith('assets/')) {
    event.respondWith(cacheFirst(request))
    return
  }
  // Manifest and icons: fresh when online, cached for offline.
  event.respondWith(networkFirst(request, request.url))
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'SnAgentsOS'
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' && data.tag ? data.tag : undefined,
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: typeof data.url === 'string' ? data.url : './' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const raw = (event.notification.data && event.notification.data.url) || './'
  let target
  try {
    target = new URL(raw, self.registration.scope)
  } catch {
    target = new URL('./', self.registration.scope)
  }
  // Only our own origin: a payload can never send the app elsewhere.
  if (target.origin !== self.location.origin) target = new URL('./', self.registration.scope)
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of list) {
        if (!client.url.startsWith(self.registration.scope)) continue
        try {
          await client.focus()
        } catch {
          /* focus not allowed: the message still picks the console */
        }
        client.postMessage({ type: 'snaos-open', hash: target.hash })
        return
      }
      await self.clients.openWindow(target.href)
    })(),
  )
})
