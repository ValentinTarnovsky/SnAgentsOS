/**
 * Maps live pane ids to their backing pty ids (for direct writes and the
 * remote `running` flag). Kills go by paneId through main, so they never
 * depend on this map or on React unmount timing (E4-FR-36).
 */
const registry = new Map<string, string>()

/** Notified whenever a pane's pty binding is added or removed. */
const listeners = new Set<() => void>()

function notify(): void {
  for (const cb of listeners) cb()
}

/**
 * Subscribe to registry changes (a pty registered, unregistered or killed).
 * Used by the remote snapshot sync to refresh each pane's `running` flag.
 * Returns an unsubscribe function.
 */
export function onPtyRegistryChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function registerPty(paneId: string, ptyId: string): void {
  registry.set(paneId, ptyId)
  notify()
}

export function unregisterPty(paneId: string): void {
  if (registry.delete(paneId)) notify()
}

/** The live pty id backing a pane, if any (used to write into it directly). */
export function getPtyId(paneId: string): string | undefined {
  return registry.get(paneId)
}

/**
 * Kill the ptys backing the given panes (E4-FR-36). Main kills by paneId
 * (`pty:killPanes`), so this works even when the registry is empty after a
 * renderer reload; the local bindings are dropped too. Idempotent: a pane
 * without a pty is a no-op in main.
 */
export function killPanePtys(paneIds: string[]): void {
  if (paneIds.length === 0) return
  void window.snApi.pty.killPanes(paneIds).catch(() => undefined)
  let changed = false
  for (const paneId of paneIds) {
    if (registry.delete(paneId)) changed = true
  }
  if (changed) notify()
}
