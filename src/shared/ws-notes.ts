/**
 * Markdown notes of a workspace (v2.2, E9): real `.md` files that main keeps
 * under dataDir()/notes/<workspaceId>/<noteId>.md. Distinct from the
 * workspace's one-line `note` (workspaceNote.ts) and from the review notes of
 * the Changes panel. Pure: no Node, no DOM (main, renderer and phone use it).
 */

/** Note and workspace ids: plain ASCII, so they are safe file and folder names. */
export const WS_NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Largest note kept, in UTF-8 bytes. */
export const WS_NOTE_MAX_BYTES = 1024 * 1024
/** Largest note the phone edits, in UTF-8 bytes (it travels in one WS frame); a bigger one is read-only there. */
export const WS_NOTE_PHONE_MAX = 40_000
/** Longest title shown for a note. */
export const WS_NOTE_TITLE_MAX = 80

export interface WsNoteMeta {
  id: string
  /** First heading or first line, <= 80; '' when the note is empty. */
  title: string
  /** Epoch ms of the last write. */
  updatedAt: number
  /** UTF-8 bytes. */
  size: number
  /** Version of the file on disk (mtime and size): a write with another `baseRev` is a conflict. */
  rev: string
}

export interface WsNoteDoc extends WsNoteMeta {
  text: string
  /** Absolute path of the .md file (desktop only: never sent to the phone). */
  path?: string
}

export type WsNoteError = 'not_found' | 'invalid' | 'too_large' | 'conflict' | 'io' | 'rate'

/** Every answer: data on success; on a conflict, the note as it is now. */
export type WsNoteResult<T> = ({ ok: true } & T) | { ok: false; error: WsNoteError; current?: WsNoteDoc }

export interface WsNotesListRes {
  ok: boolean
  notes: WsNoteMeta[]
}

export interface WsNoteReadReq {
  workspaceId: string
  noteId: string
}

export interface WsNoteWriteReq extends WsNoteReadReq {
  text: string
  /** The rev the editor loaded; absent = overwrite. */
  baseRev?: string
}

export interface WsNoteCreateReq {
  workspaceId: string
  text?: string
}

/** Main -> renderer: a note of the workspace was written, created or deleted (by the desktop or a phone). */
export interface WsNotesChangedEvt {
  workspaceId: string
  noteId?: string
  rev?: string
}

/** The title of a note: its first heading, else its first non-empty line, plain and clipped. */
export function noteTitle(text: string): string {
  for (const raw of text.split(/\r?\n/, 200)) {
    const line = raw.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/[*_`~>]/g, '').replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (line.length <= WS_NOTE_TITLE_MAX) return line
    let cut = line.slice(0, WS_NOTE_TITLE_MAX)
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
    return cut.trimEnd()
  }
  return ''
}

/** The rev of a file version (mtime and size). */
export function noteRev(mtimeMs: number, size: number): string {
  return `${Math.floor(mtimeMs)}-${size}`
}

export function isNoteId(v: unknown): v is string {
  return typeof v === 'string' && WS_NOTE_ID_RE.test(v)
}
