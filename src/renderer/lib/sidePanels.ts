import { create } from 'zustand'
import { useAppStore } from './store'
import { useGitStore } from './gitStore'
import { workspaceOfKey } from './changes'
import { focusPane, getFocusedPane, getLastFocusedPaneForWorkspace } from './focus'

/**
 * The Notes and Files drawers (v2.2, E9): at most one drawer over a
 * workspace's grid at a time, Changes included (opening one closes the
 * others there). Each workspace keeps its own drawer (app 2.5.0): opening or
 * closing one on a workspace never touches the drawer, pin or size of
 * another, and a drawer shows while its workspace is active. Closing gives
 * the keyboard back to the console the user was in. A click on a console
 * beside an unpinned drawer closes it (v2.3).
 */
export type SidePanelKind = 'notes' | 'files'

/** A note to show in the Notes drawer (`snaos notes open`, app 2.3.0); `seq` grows on every ask. */
export interface NoteRequest {
  workspaceId: string
  noteId: string
  seq: number
}

interface SidePanelsState {
  /** The drawer of each workspace that has one open. */
  open: Record<string, SidePanelKind>
  /** Workspaces whose drawer covers the whole grid. */
  maximized: Record<string, boolean>
  /** Consumed (and cleared) by NotesPanel of that workspace. */
  noteRequest: NoteRequest | null
}

export const useSidePanels = create<SidePanelsState>(() => ({ open: {}, maximized: {}, noteRequest: null }))

let noteSeq = 0

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

/** The drawer open on a workspace, or null. */
export function sidePanelOf(workspaceId: string | null | undefined): SidePanelKind | null {
  return (workspaceId && useSidePanels.getState().open[workspaceId]) || null
}

export function setSidePanelMaximized(workspaceId: string, on: boolean): void {
  useSidePanels.setState((s) => ({ maximized: on ? { ...s.maximized, [workspaceId]: true } : withoutKey(s.maximized, workspaceId) }))
}

/** Changes closes when it is over this workspace (one drawer at a time there). */
function closeChangesOn(workspaceId: string): void {
  const panel = useGitStore.getState().panel
  if (panel && workspaceOfKey(useAppStore.getState().workspaces, panel.targetKey) === workspaceId) useGitStore.getState().closeChanges()
}

function openOn(workspaceId: string, kind: SidePanelKind): void {
  closeChangesOn(workspaceId)
  useSidePanels.setState((s) => ({ open: { ...s.open, [workspaceId]: kind } }))
}

/**
 * Opens the Notes drawer of a workspace on one note (`snaos notes open`). The
 * caller already activated the workspace; Changes closes like on any drawer.
 */
export function openNoteInPanel(workspaceId: string, noteId: string): void {
  openOn(workspaceId, 'notes')
  useSidePanels.setState({ noteRequest: { workspaceId, noteId, seq: ++noteSeq } })
}

/** NotesPanel took the request (only the one it read: a newer one stays). */
export function clearNoteRequest(seq: number): void {
  if (useSidePanels.getState().noteRequest?.seq === seq) useSidePanels.setState({ noteRequest: null })
}

export function openSidePanel(kind: SidePanelKind): void {
  const s = useAppStore.getState()
  if (!s.activeWorkspaceId) return
  openOn(s.activeWorkspaceId, kind)
}

/**
 * Closes the active workspace's drawer. `refocus: false` when the close comes
 * from a click on a console, which takes the keyboard itself.
 */
export function closeSidePanel(opts?: { refocus?: boolean }): void {
  const s = useAppStore.getState()
  const wsId = s.activeWorkspaceId
  if (!wsId || !sidePanelOf(wsId)) return
  useSidePanels.setState((p) => ({ open: withoutKey(p.open, wsId), maximized: withoutKey(p.maximized, wsId) }))
  if (opts?.refocus === false) return
  const pane = getLastFocusedPaneForWorkspace(wsId) || getFocusedPane()
  if (pane) requestAnimationFrame(() => focusPane(pane))
}

/** Whether a drawer of this kind shows over the active workspace. */
export function sidePanelOpenHere(kind: SidePanelKind): boolean {
  return sidePanelOf(useAppStore.getState().activeWorkspaceId) === kind
}

export function toggleSidePanel(kind: SidePanelKind): void {
  if (sidePanelOpenHere(kind)) closeSidePanel()
  else openSidePanel(kind)
}

/** Opening Changes over a workspace closes its Notes or Files. */
export function dropSidePanel(workspaceId: string): void {
  if (!sidePanelOf(workspaceId)) return
  useSidePanels.setState((s) => ({ open: withoutKey(s.open, workspaceId), maximized: withoutKey(s.maximized, workspaceId) }))
}
