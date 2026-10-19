import { create } from 'zustand'
import { useAppStore } from './store'
import { useGitStore } from './gitStore'
import { focusPane, getFocusedPane, getLastFocusedPaneForWorkspace } from './focus'

/**
 * The Notes and Files drawers (v2.2, E9): at most one drawer over the grid
 * at a time, Changes included (opening one closes the others). A drawer
 * belongs to the workspace it was opened on and shows while that workspace
 * is active. Closing gives the keyboard back to the console the user was in.
 */
export type SidePanelKind = 'notes' | 'files'

interface SidePanelsState {
  open: { kind: SidePanelKind; workspaceId: string } | null
  /** The drawer covers the whole grid. */
  maximized: boolean
}

export const useSidePanels = create<SidePanelsState>(() => ({ open: null, maximized: false }))

export function openSidePanel(kind: SidePanelKind): void {
  const s = useAppStore.getState()
  if (!s.activeWorkspaceId) return
  if (useGitStore.getState().panel) useGitStore.getState().closeChanges()
  useSidePanels.setState({ open: { kind, workspaceId: s.activeWorkspaceId } })
}

export function closeSidePanel(): void {
  if (!useSidePanels.getState().open) return
  useSidePanels.setState({ open: null, maximized: false })
  const s = useAppStore.getState()
  const pane = (s.activeWorkspaceId && getLastFocusedPaneForWorkspace(s.activeWorkspaceId)) || getFocusedPane()
  if (pane) requestAnimationFrame(() => focusPane(pane))
}

/** Whether a drawer of this kind shows over the active workspace. */
export function sidePanelOpenHere(kind: SidePanelKind): boolean {
  const open = useSidePanels.getState().open
  return open?.kind === kind && open.workspaceId === useAppStore.getState().activeWorkspaceId
}

export function toggleSidePanel(kind: SidePanelKind): void {
  if (sidePanelOpenHere(kind)) closeSidePanel()
  else openSidePanel(kind)
}

/** Opening Changes closes Notes and Files. */
export function dropSidePanel(): void {
  if (useSidePanels.getState().open) useSidePanels.setState({ open: null, maximized: false })
}
