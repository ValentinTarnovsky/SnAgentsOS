import { useSyncExternalStore } from 'react'

/**
 * Forced render errors to exercise the error boundaries (E4-FR-19..20, 25).
 * `window.__snaosDev` is only installed in dev (main.tsx); a flag makes the
 * component that reads it throw on render until its boundary resets it, so
 * React's synchronous retry of a failed render throws again and the fallback
 * really shows. In a production build nothing sets a flag, so `useDevThrow`
 * is a cheap no-op subscription.
 */
export type DevThrowKey = `pane:${string}` | `paneHeader:${string}` | 'app' | 'titlebar'

const flags = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setDevThrow(key: DevThrowKey): void {
  flags.add(key)
  emit()
}

/** Called by a boundary when it resets, so the remount renders normally. */
export function clearDevThrow(key: DevThrowKey): void {
  if (flags.delete(key)) emit()
}

/** Throw during render while `key` is flagged. */
export function useDevThrow(key: DevThrowKey): void {
  const on = useSyncExternalStore(
    subscribe,
    () => flags.has(key),
    () => false,
  )
  if (on) throw new Error(`Forced render error (${key})`)
}

export interface SnaosDevHooks {
  throwPane(paneId: string): void
  throwPaneHeader(paneId: string): void
  throwApp(): void
  throwTitleBar(): void
  /** Busy-loop the renderer for `ms` (unresponsive dialog, FR-25). */
  blockRenderer(ms: number): void
}

declare global {
  interface Window {
    __snaosDev?: SnaosDevHooks
  }
}

export function installDevHooks(): void {
  window.__snaosDev = {
    throwPane: (paneId) => setDevThrow(`pane:${paneId}`),
    throwPaneHeader: (paneId) => setDevThrow(`paneHeader:${paneId}`),
    throwApp: () => setDevThrow('app'),
    throwTitleBar: () => setDevThrow('titlebar'),
    blockRenderer: (ms) => {
      const end = Date.now() + Math.max(0, Number(ms) || 0)
      while (Date.now() < end) {
        /* intentionally blocking */
      }
    },
  }
}
