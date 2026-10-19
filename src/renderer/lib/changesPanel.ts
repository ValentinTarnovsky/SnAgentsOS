import { useAppStore } from './store'
import { useGitStore } from './gitStore'
import { refreshGit } from './gitSync'
import { focusPane, getFocusedPane, getLastFocusedPaneForWorkspace } from './focus'
import { panelTargets, workspaceOfKey } from './changes'
import { workspaceGitKey } from './gitChip'

/**
 * Open / close the Changes panel (E7-FR-11): the chip, the `toggleChanges`
 * action (Ctrl+Shift+D) and "View changes" in the palette all land here. The
 * panel lives over the active workspace's grid; closing it gives the keyboard
 * back to the console the user was in.
 */
export function openChangesPanel(targetKey?: string, opts: { base?: string } = {}): void {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  if (!ws) return
  const key = targetKey ?? panelTargets(ws)[0]?.key ?? workspaceGitKey(ws.id)
  refreshGit([key])
  useGitStore.getState().openChanges(key, key.startsWith('pane:') ? opts.base : undefined)
}

export function closeChangesPanel(): void {
  if (!useGitStore.getState().panel) return
  useGitStore.getState().closeChanges()
  const s = useAppStore.getState()
  const pane = (s.activeWorkspaceId && getLastFocusedPaneForWorkspace(s.activeWorkspaceId)) || getFocusedPane()
  if (pane) requestAnimationFrame(() => focusPane(pane))
}

/** Whether the panel is showing over the active workspace. */
export function changesPanelOpenHere(): boolean {
  const panel = useGitStore.getState().panel
  const s = useAppStore.getState()
  return panel != null && s.activeWorkspaceId != null && workspaceOfKey(s.workspaces, panel.targetKey) === s.activeWorkspaceId
}

export function toggleChangesPanel(): void {
  if (changesPanelOpenHere()) closeChangesPanel()
  else openChangesPanel()
}
