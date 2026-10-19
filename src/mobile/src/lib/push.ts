/**
 * Web Push from the desktop (E3-FR-44..46). Only in a secure context (the
 * secure mode's https origin) and with `authOk.pushKey`, the desktop's public
 * VAPID key, which it sends only while https is on.
 *
 *  - iOS pushes only to an installed PWA (`display-mode: standalone`, iOS
 *    16.4+): in a Safari tab Settings shows how to install it instead.
 *  - enablePush: asks for permission (inside the tap), subscribes with the
 *    key through the service worker and `POST /api/push/subscribe` with the
 *    Bearer `httpToken`; a 200 confirms.
 *  - syncPush (each authOk): with the permission already granted, the stored
 *    subscription is posted again (a re-pair or a revoke dropped it on the
 *    desktop) and re-made when the desktop key changed.
 *  - disablePush: `subscription.unsubscribe()` here; the desktop drops it on
 *    the next 404/410 from the push service.
 *
 * The rules (support, key compare, base64url) are pure for the Node tests.
 */
import { create } from 'zustand'
import { store } from './store'

export const PUSH_SUBSCRIBE_PATH = '/api/push/subscribe'
/** How long to wait for the service worker to be ready. */
const SW_READY_MS = 5000

/** Why "Enable notifications" is or is not offered. */
export type PushSupport = 'insecure' | 'iosBrowser' | 'unsupported' | 'noKey' | 'ready'

export interface PushEnv {
  secure: boolean
  hasPushManager: boolean
  hasNotification: boolean
  ios: boolean
  standalone: boolean
  pushKey: string | null
}

/** FR-44: what Settings shows (pure). */
export function pushSupport(env: PushEnv): PushSupport {
  if (!env.secure) return 'insecure'
  if (env.ios && !env.standalone) return 'iosBrowser'
  if (!env.hasPushManager || !env.hasNotification) return 'unsupported'
  if (!env.pushKey) return 'noKey'
  return 'ready'
}

/** iPhone / iPad (iPadOS reports a Mac with touch). */
export function isIosUserAgent(ua: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)
}

export function readPushEnv(pushKey: string | null): PushEnv {
  let secure = false
  let standalone = false
  try {
    secure = window.isSecureContext === true
    standalone =
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch {
    /* no window: not secure */
  }
  return {
    secure,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window && 'serviceWorker' in navigator,
    hasNotification: typeof Notification !== 'undefined',
    ios: typeof navigator !== 'undefined' && isIosUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    standalone,
    pushKey,
  }
}

/** base64url (the VAPID key as the desktop sends it) to bytes. */
export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** True when a subscription was made with this key (an ArrayBuffer from the browser). */
export function sameKey(applicationServerKey: ArrayBuffer | null | undefined, pushKey: string): boolean {
  if (!applicationServerKey) return false
  const a = new Uint8Array(applicationServerKey)
  let b: Uint8Array
  try {
    b = base64UrlToBytes(pushKey)
  } catch {
    return false
  }
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export type PostResult = 'ok' | 'unauthorized' | 'notFound' | 'rejected' | 'offline'

/** POST the subscription with the Bearer; maps the desktop's answer. */
export async function postSubscription(
  sub: PushSubscriptionJSON,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PostResult> {
  try {
    const res = await fetchImpl(PUSH_SUBSCRIBE_PATH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys }),
      credentials: 'omit',
      cache: 'no-store',
    })
    if (res.status === 200) return 'ok'
    if (res.status === 401) return 'unauthorized'
    if (res.status === 404) return 'notFound'
    return 'rejected'
  } catch {
    return 'offline'
  }
}

/** The notifications row of Settings. */
export type PushState = 'off' | 'on' | 'busy' | 'denied' | 'failed'

export const usePushStore = create<{ state: PushState; set: (state: PushState) => void }>((set) => ({
  state: 'off',
  set: (state) => set({ state }),
}))

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(id)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return withTimeout(navigator.serviceWorker.ready, SW_READY_MS)
}

/** The current subscription for this key, re-made when it was for another key. */
async function subscriptionFor(reg: ServiceWorkerRegistration, pushKey: string, create: boolean): Promise<PushSubscription | null> {
  const existing = await reg.pushManager.getSubscription()
  if (existing && sameKey(existing.options?.applicationServerKey, pushKey)) return existing
  if (existing) await existing.unsubscribe().catch(() => false)
  if (!create && !existing) return null
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(pushKey) as BufferSource })
}

async function postCurrent(sub: PushSubscription): Promise<PostResult> {
  const token = store.getState().httpToken
  if (!token) return 'unauthorized'
  return postSubscription(sub.toJSON(), token)
}

/** "Enable notifications" (inside the tap: the permission prompt needs the gesture). */
export async function enablePush(): Promise<PushState> {
  const { pushKey } = store.getState()
  const set = usePushStore.getState().set
  if (pushSupport(readPushEnv(pushKey)) !== 'ready' || !pushKey) return usePushStore.getState().state
  set('busy')
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      set('denied')
      return 'denied'
    }
    const reg = await registration()
    const sub = await subscriptionFor(reg, pushKey, true)
    const res = sub ? await postCurrent(sub) : 'rejected'
    const next: PushState = res === 'ok' ? 'on' : 'failed'
    set(next)
    return next
  } catch {
    set('failed')
    return 'failed'
  }
}

/** "Turn off": unsubscribe on this phone. */
export async function disablePush(): Promise<void> {
  const set = usePushStore.getState().set
  set('busy')
  try {
    const reg = await registration()
    const sub = await reg.pushManager.getSubscription()
    if (sub) await sub.unsubscribe()
  } catch {
    /* nothing subscribed */
  }
  set('off')
}

/** Each authOk: re-post (or re-make) a subscription the user already allowed. */
export async function syncPush(): Promise<void> {
  const { pushKey } = store.getState()
  const set = usePushStore.getState().set
  if (pushSupport(readPushEnv(pushKey)) !== 'ready' || !pushKey) return
  try {
    if (Notification.permission === 'denied') return set('denied')
    if (Notification.permission !== 'granted') return set('off')
    const reg = await registration()
    const sub = await subscriptionFor(reg, pushKey, false)
    if (!sub) return set('off')
    set((await postCurrent(sub)) === 'ok' ? 'on' : 'failed')
  } catch {
    set('failed')
  }
}
