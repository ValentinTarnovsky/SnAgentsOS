/**
 * Maps live pane ids to their backing pty ids so we can force-kill a
 * workspace's consoles on delete — independent of React unmount timing.
 */
const registry = new Map<string, string>()

export function registerPty(paneId: string, ptyId: string): void {
  registry.set(paneId, ptyId)
}

export function unregisterPty(paneId: string): void {
  registry.delete(paneId)
}

/** The live pty id backing a pane, if any (used to write into it directly). */
export function getPtyId(paneId: string): string | undefined {
  return registry.get(paneId)
}

/** Kill the ptys backing the given panes (no-op for panes without one). */
export function killPanePtys(paneIds: string[]): void {
  for (const paneId of paneIds) {
    const ptyId = registry.get(paneId)
    if (ptyId) {
      void window.snApi.pty.kill(ptyId)
      registry.delete(paneId)
    }
  }
}
