/**
 * The phone's Notes screen (v2.2, E9): which workspace's .md notes are open
 * and which note, plus a change counter the desktop bumps with
 * `notesChanged` so the screen reloads what it shows. The notes themselves
 * live on the PC (notesReq); the phone keeps nothing.
 */
import { create } from 'zustand'
import { WS_NOTE_PHONE_MAX } from '@shared/ws-notes'

interface WsNotesState {
  workspaceId: string | null
  noteId: string | null
  /** Bumped by every `notesChanged` of the open workspace. */
  changed: number
  /** The note the last change was about ('' = the list). */
  changedNote: string
}

export const useWsNotes = create<WsNotesState>(() => ({ workspaceId: null, noteId: null, changed: 0, changedNote: '' }))

export function openWsNotes(workspaceId: string, noteId: string | null = null): void {
  useWsNotes.setState({ workspaceId, noteId })
}

export function closeWsNotes(): void {
  useWsNotes.setState({ workspaceId: null, noteId: null })
}

export function openNote(noteId: string | null): void {
  useWsNotes.setState({ noteId })
}

/** `notesChanged` from the PC: only the open workspace cares. */
export function noteChanged(workspaceId: string, noteId?: string): void {
  const s = useWsNotes.getState()
  if (s.workspaceId !== workspaceId) return
  useWsNotes.setState({ changed: s.changed + 1, changedNote: noteId ?? '' })
}

/** UTF-8 bytes of a text (what the PC and the frame limit count). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** The phone can save this text (one WS frame). */
export function fitsPhone(text: string): boolean {
  return utf8Bytes(text) <= WS_NOTE_PHONE_MAX
}
