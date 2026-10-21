import { create } from 'zustand'
import { useAppStore } from './store'
import { useGitStore } from './gitStore'
import { focusPane, getFocusedPane, getLastFocusedPaneForWorkspace } from './focus'

/**
 * The Notes and Files drawers (v2.2, E9): at most one drawer over the grid
 * at a time, Changes included (opening one closes the others). A drawer
 * belongs to the workspace it was opened on and shows while that workspace
 * is active. Closing gives the keyboard back to the console the user was in.
 * A click on a console beside an unpinned drawer closes it (v2.3).
 */
export type SidePanelKind = 'notes' | 'files'

/** A note to show in the Notes drawer (`snaos notes open`, app 2.3.0); `seq` grows on every ask. */
export interface NoteRequest {
  workspaceId: string
  noteId: string
  seq: number
}

interface SidePanelsState {
  open: { kind: SidePanelKind; workspaceId: string } | null
  /** The drawer covers the whole grid. */
  maximized: boolean
  /** Consumed (and cleared) by NotesPanel of that workspace. */
  noteRequest: NoteRequest | null
}

export const useSidePanels = create<SidePanelsState>(() => ({ open: null, maximized: false, noteRequest: null }))

let noteSeq = 0

/**
 * Opens the Notes drawer of a workspace on one note (`snaos notes open`). The
 * caller already activated the workspace; Changes closes like on any drawer.
 */
export function openNoteInPanel(workspaceId: string, noteId: string): void {
  if (useGitStore.getState().panel) useGitStore.getState().closeChanges()
  useSidePanels.setState({ open: { kind: 'notes', workspaceId }, noteRequest: { workspaceId, noteId, seq: ++noteSeq } })
}

/** NotesPanel took the request (only the one it read: a newer one stays). */
export function clearNoteRequest(seq: number): void {
  if (useSidePanels.getState().noteRequest?.seq === seq) useSidePanels.setState({ noteRequest: null })
}

export function openSidePanel(kind: SidePanelKind): void {
  const s = useAppStore.getState()
  if (!s.activeWorkspaceId) return
  if (useGitStore.getState().panel) useGitStore.getState().closeChanges()
  useSidePanels.setState({ open: { kind, workspaceId: s.activeWorkspaceId } })
}

/** `refocus: false` when the close comes from a click on a console, which takes the keyboard itself. */
export function closeSidePanel(opts?: { refocus?: boolean }): void {
  if (!useSidePanels.getState().open) return
  useSidePanels.setState({ open: null, maximized: false })
  if (opts?.refocus === false) return
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
