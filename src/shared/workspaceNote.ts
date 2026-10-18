/**
 * Workspace note and task state (E8-FR-10), pure so the store, the sidebar
 * and later the CLI (`snaos note`, E8-FR-20) normalize the same way.
 */
import type { WorkspaceTaskState } from './types'

/** Longest note kept, in UTF-16 code units (same unit as the schema's clip). */
export const WORKSPACE_NOTE_MAX = 140

export const TASK_STATES: readonly WorkspaceTaskState[] = ['todo', 'doing', 'review', 'done']

export function isTaskState(v: unknown): v is WorkspaceTaskState {
  return typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v)
}

/**
 * A note as stored: line breaks and other control characters become spaces,
 * runs of whitespace collapse, the ends are trimmed and the text is clipped to
 * 140 without splitting a surrogate pair. Empty (or not a string) -> undefined,
 * which means "no note".
 */
export function normalizeWorkspaceNote(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  let text = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length > WORKSPACE_NOTE_MAX) {
    text = text.slice(0, WORKSPACE_NOTE_MAX)
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
    text = text.trimEnd()
  }
  return text.length > 0 ? text : undefined
}
