/**
 * v2.3: the phone's tray (Web Push notifications the service worker showed)
 * follows the desktop's attention with no silent push: whenever the page
 * learns a status (authOk, `state`, `paneStatus`) it closes every tray note
 * whose console no longer needs the user. Coming back on screen alone never
 * runs it: the statuses held then may predate the hide; the frames of the
 * revive (resync `state`, a new authOk) do. A note's tag
 * is its pane id and its `data.state` the state the push announced (sw.js);
 * a note of an older worker has no state and closes only by attention or a
 * missing status. A pane absent from the snapshot is kept: the snapshot can be
 * empty before the desktop renderer's first push. Pure factory with injected
 * deps so the rules run under fakes; client.ts binds it to the store.
 */
import type { RemotePaneStatus, RemoteStateSnapshot } from '@shared/remote-protocol'

/** One notification of `registration.getNotifications()`, as far as this module reads it. */
export interface TrayNote {
  tag: string
  data?: unknown
  close(): void
}

export interface TrayRegistration {
  getNotifications?(): Promise<TrayNote[]>
}

const NOTE_STATES = new Set(['action', 'done', 'error'])

/** Debounce of a reconcile after the last status change. */
export const TRAY_RECONCILE_MS = 150

function hasPane(snap: RemoteStateSnapshot, paneId: string): boolean {
  return snap.workspaces.some((w) => w.panes.some((p) => p.id === paneId))
}

/** The tray note of `tag` (a pane id) announces something its console no longer is. */
export function isStaleTrayNote(tag: string, data: unknown, snap: RemoteStateSnapshot, statuses: Record<string, RemotePaneStatus>): boolean {
  if (!tag || !hasPane(snap, tag)) return false
  const status = statuses[tag]
  if (!status) return true
  if (status.attention === false) return true
  const state = data && typeof data === 'object' ? (data as { state?: unknown }).state : undefined
  return typeof state === 'string' && NOTE_STATES.has(state) && state !== status.state
}

export interface TrayReconcilerDeps {
  /** The service worker registration, undefined without one (http, no SW support). */
  registration?: () => Promise<TrayRegistration | undefined>
  snapshot: () => RemoteStateSnapshot | null
  statuses: () => Record<string, RemotePaneStatus>
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
}

export interface TrayReconciler {
  /** Run once TRAY_RECONCILE_MS after the last call. */
  schedule(): void
  /** Close the stale notes now; resolves with how many were closed. */
  run(): Promise<number>
}

/**
 * The page's service worker registration, guarded: only in a secure context
 * with `getRegistration` (never `ready`, which never resolves without a SW).
 */
export function defaultTrayRegistration(): Promise<TrayRegistration | undefined> {
  try {
    if (typeof window === 'undefined' || !window.isSecureContext) return Promise.resolve(undefined)
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(undefined)
    const sw = navigator.serviceWorker
    if (typeof sw?.getRegistration !== 'function') return Promise.resolve(undefined)
    return sw.getRegistration().then(
      (reg) => (reg ? (reg as unknown as TrayRegistration) : undefined),
      () => undefined,
    )
  } catch {
    return Promise.resolve(undefined)
  }
}

export function createTrayReconciler(deps: TrayReconcilerDeps): TrayReconciler {
  const registration = deps.registration ?? defaultTrayRegistration
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = deps.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let timer: unknown = null

  const run = async (): Promise<number> => {
    if (!deps.snapshot()) return 0
    let notes: TrayNote[]
    try {
      const reg = await registration()
      if (!reg || typeof reg.getNotifications !== 'function') return 0
      notes = await reg.getNotifications()
    } catch {
      return 0
    }
    // Read after the awaits: the freshest status decides.
    const snap = deps.snapshot()
    if (!snap || !Array.isArray(notes)) return 0
    const statuses = deps.statuses()
    let closed = 0
    for (const note of notes) {
      if (!note || typeof note.tag !== 'string' || !isStaleTrayNote(note.tag, note.data, snap, statuses)) continue
      try {
        note.close()
        closed++
      } catch {
        /* already gone */
      }
    }
    return closed
  }

  return {
    schedule() {
      if (timer !== null) clearT(timer)
      timer = setT(() => {
        timer = null
        void run()
      }, TRAY_RECONCILE_MS)
    },
    run,
  }
}
