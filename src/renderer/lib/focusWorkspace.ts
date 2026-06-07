import { focusPaneWhenReady, getLastFocusedPaneForWorkspace } from './focus'
import { useAppStore } from './store'

/**
 * Focus the console the user should land in when a workspace becomes active:
 * a maximized pane if any, else the last console they typed in here, else the
 * first visible (non-minimized) console. Returns a cancel fn (see
 * focusPaneWhenReady) so callers can abort on a rapid re-switch.
 */
export function focusWorkspaceConsole(workspaceId: string): () => void {
  const noop = (): void => {}
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === workspaceId)
  if (!ws) return noop
  const minimized = s.minimized[workspaceId] ?? []
  const order = (ws.layout?.order ?? ws.panes.map((p) => p.id)).filter(
    (id) => !minimized.includes(id),
  )
  const maximized = s.maximized[workspaceId]
  const remembered = getLastFocusedPaneForWorkspace(workspaceId)
  const target =
    (maximized && order.includes(maximized) ? maximized : null) ??
    (remembered && order.includes(remembered) ? remembered : null) ??
    order[0]
  if (!target) return noop
  return focusPaneWhenReady(target)
}
