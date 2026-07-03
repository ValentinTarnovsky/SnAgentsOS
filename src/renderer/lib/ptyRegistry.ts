/**
 * Maps live pane ids to their backing pty ids so we can force-kill a
 * workspace's consoles on delete, independent of React unmount timing.
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

/** Kill the ptys backing the given panes (no-op for panes without one). */
export function killPanePtys(paneIds: string[]): void {
  let changed = false
  for (const paneId of paneIds) {
    const ptyId = registry.get(paneId)
    if (ptyId) {
      void window.snApi.pty.kill(ptyId)
      registry.delete(paneId)
      changed = true
    }
  }
  if (changed) notify()
}
