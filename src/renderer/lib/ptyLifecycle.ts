import type { Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { getPtyId, killPanePtys } from '@/lib/ptyRegistry'

/**
 * Explicit pty lifecycle (E4-FR-36, D3). Unmounting a terminal never kills its
 * pty: error boundaries, a renderer reload, a workspace that unmounts or a
 * pane that remounts all keep the process alive. The only owner of kills by
 * removal is this module: it watches the store's set of paneIds and kills the
 * ones that disappear, which covers removePane, deleteWorkspace, importConfig,
 * a remote closePane and any future path. restartPaneClean (and hibernation)
 * kill explicitly through killPanePtys.
 */

/** Every paneId across every workspace. */
export function allPaneIds(workspaces: readonly Workspace[]): Set<string> {
  const ids = new Set<string>()
  for (const ws of workspaces) for (const p of ws.panes) ids.add(p.id)
  return ids
}

/** The paneIds in `prev` that are no longer in `next`. */
export function removedPaneIds(prev: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const id of prev) if (!next.has(id)) out.push(id)
  return out
}

/** Whether a pane with this id is still in the store. */
export function paneExists(paneId: string): boolean {
  return useAppStore.getState().workspaces.some((w) => w.panes.some((p) => p.id === paneId))
}

/**
 * A spawn (or in-place restart) that resolves after its terminal unmounted:
 * kill it only when its pane is gone or the pane is already bound to another
 * pty. Otherwise the pty is the pane's, and the next mount reattaches to it.
 */
export function shouldKillLateSpawn(paneId: string, ptyId: string): boolean {
  if (!paneExists(paneId)) return true
  const bound = getPtyId(paneId)
  return bound !== undefined && bound !== ptyId
}

let unsubscribe: (() => void) | null = null

/**
 * Start watching the store for removed panes (call once, after hydrate).
 * Idempotent; returns a stop function.
 */
export function initPtyLifecycle(): () => void {
  if (unsubscribe) return () => undefined
  let known = allPaneIds(useAppStore.getState().workspaces)
  const off = useAppStore.subscribe((state, prev) => {
    if (state.workspaces === prev.workspaces) return
    const next = allPaneIds(state.workspaces)
    const removed = removedPaneIds(known, next)
    known = next
    if (removed.length > 0) killPanePtys(removed)
  })
  unsubscribe = off
  return () => {
    off()
    if (unsubscribe === off) unsubscribe = null
  }
}

/**
 * After hydrate: ask main to kill every pty whose pane is not in the store
 * (deleted while the window was gone, or lost by the loaded config).
 * Resolves to how many were killed.
 */
export function reconcilePtys(): Promise<number> {
  const ids = [...allPaneIds(useAppStore.getState().workspaces)]
  return window.snApi.pty.reconcile(ids).catch(() => 0)
}
