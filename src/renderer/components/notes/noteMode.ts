/**
 * What the local Notes drawer and a share guest's Notes drawer (app 2.6.0)
 * share: the autosave delay and the Edit / Split / Preview mode, remembered
 * in localStorage (`snagentsos.notes.mode`).
 */

/** A note saves this long after the last keystroke. */
export const NOTE_SAVE_DEBOUNCE_MS = 600

export type NoteMode = 'edit' | 'split' | 'preview'

const MODE_KEY = 'snagentsos.notes.mode'

export function noteStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadNoteMode(): NoteMode {
  try {
    const v = noteStorage()?.getItem(MODE_KEY)
    return v === 'edit' || v === 'split' || v === 'preview' ? v : 'split'
  } catch {
    return 'split'
  }
}

export function saveNoteMode(mode: NoteMode): void {
  try {
    noteStorage()?.setItem(MODE_KEY, mode)
  } catch {
    /* blocked storage */
  }
}
