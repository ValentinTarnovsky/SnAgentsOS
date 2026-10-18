import { useAppStore } from './store'
import { focusPaneWhenReady, setFocusedPane } from './focus'
import { toast } from './toast'

/** dedupeKey of the in-app agent card of a console (E4-FR-07). */
export function agentToastKey(paneId: string): string {
  return `agent:${paneId}`
}

/**
 * Bring one console on screen and focus it (E5-FR-04). The single path for a
 * notification click, the [Go] of an agent card, the palette, sidebar rows and
 * every later "take me there" entry point. Steps, in order:
 * 1. remember it as the workspace's focused pane, so WorkspaceHost's
 *    focusWorkspaceConsole effect lands on the same target;
 * 2. mount and activate its workspace;
 * 3. drop a maximize held by another pane;
 * 4. restore it if minimized;
 * 5. clear its attention flag (and close its agent card);
 * 6. focus its terminal once mounted.
 * Returns false when the pane no longer exists.
 */
export function revealPane(paneId: string): boolean {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
  if (!ws) return false
  setFocusedPane(paneId, ws.id)
  s.ensureMounted(ws.id)
  if (s.activeWorkspaceId !== ws.id) s.setActive(ws.id)
  const maximized = useAppStore.getState().maximized[ws.id]
  if (maximized && maximized !== paneId) s.clearMaximize(ws.id)
  if ((useAppStore.getState().minimized[ws.id] ?? []).includes(paneId)) s.toggleMinimize(ws.id, paneId)
  s.clearPaneAttention(paneId)
  toast.dismissByKey(agentToastKey(paneId))
  focusPaneWhenReady(paneId)
  return true
}
