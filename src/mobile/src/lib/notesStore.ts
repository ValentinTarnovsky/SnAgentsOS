/**
 * Review notes written on the phone (E3-FR-54, 55). They live on this phone
 * until sent, one localStorage key per workspace
 * (`snagentsos.remote.notes.<workspaceId>`, the notes keyed by file path) and
 * never sync with the desktop's notes panel (E7-FR-24). Every access goes
 * through mobileStorage (try/catch): blocked storage keeps the notes for this
 * page only.
 *
 * A note anchors to a new-side line of a diff (`line`, up to `endLine` for a
 * range) and keeps that line's text. When the file's diff is read again and
 * the line is gone, or its text changed, the note turns "Outdated" (`stale`);
 * a file that left the change list does the same. Sending goes inline on the
 * `sendReviewNotes` ctl in batches that fit the desktop's limits (50 notes,
 * 32KB of formatted text) and the 64KB WS frame; a batch the desktop acks is
 * stamped `sentAt` and hidden behind "Show sent".
 */
import { create } from 'zustand'
import { buildReviewNotesText, compareNotes, utf8Bytes, type ReviewNotePayload } from '@shared/review-notes-format'
import { REVIEW_BATCH_MAX_BYTES, REVIEW_BATCH_MAX_NOTES, REVIEW_NOTE_MAX_BODY, REVIEW_NOTE_MAX_LINE_TEXT } from '@shared/review-notes'
import { REMOTE_NOTES_PREFIX, storageGet, storageRemove, storageSet } from './mobileStorage'

export const NOTES_PREFIX = REMOTE_NOTES_PREFIX
/** Longest comment (E3-FR-54); the ctl schema takes 4000 too. */
export const NOTE_MAX_CHARS = REVIEW_NOTE_MAX_BODY
/** Notes kept per workspace on the phone. */
export const NOTES_MAX_PER_WORKSPACE = 500
/** Notes JSON per ctl, well under the 64KB WS frame (the envelope and ids are small). */
export const NOTES_FRAME_BUDGET = 48 * 1024

export interface PhoneNote {
  id: string
  /** Repo-relative path, with '/'. */
  file: string
  /** First new-side line. */
  line: number
  /** Last line of a range; absent for one line. */
  endLine?: number
  /** Text of `line` when the note was written (first 1000 characters). */
  lineText?: string
  comment: string
  createdAt: number
  sentAt?: number
  /** The line is gone or changed since (E3-FR-54 "Outdated"). */
  stale?: boolean
}

export type NoteInput = Pick<PhoneNote, 'file' | 'line' | 'endLine' | 'lineText' | 'comment'>

/** What one key stores: the notes of a workspace by file. */
interface StoredNotes {
  v: 1
  files: Record<string, Array<Omit<PhoneNote, 'file'>>>
}

const keyOf = (workspaceId: string): string => NOTES_PREFIX + workspaceId

const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0

function validNote(file: string, raw: unknown): PhoneNote | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  if (typeof n.id !== 'string' || !isPosInt(n.line) || typeof n.comment !== 'string' || !n.comment || typeof n.createdAt !== 'number') return null
  const note: PhoneNote = { id: n.id, file, line: n.line, comment: n.comment.slice(0, NOTE_MAX_CHARS), createdAt: n.createdAt }
  if (isPosInt(n.endLine) && n.endLine > n.line) note.endLine = n.endLine
  if (typeof n.lineText === 'string') note.lineText = n.lineText.slice(0, REVIEW_NOTE_MAX_LINE_TEXT)
  if (typeof n.sentAt === 'number') note.sentAt = n.sentAt
  if (n.stale === true) note.stale = true
  return note
}

/** The stored notes of a workspace, oldest first (bad entries skipped). */
export function readNotes(workspaceId: string): PhoneNote[] {
  const raw = storageGet(keyOf(workspaceId))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as StoredNotes
    if (!parsed || parsed.v !== 1 || !parsed.files || typeof parsed.files !== 'object') return []
    const out: PhoneNote[] = []
    for (const [file, list] of Object.entries(parsed.files)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const note = validNote(file, item)
        if (note) out.push(note)
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}

/** Write a workspace's notes (none = the key goes away). False when storage refused it. */
export function writeNotes(workspaceId: string, notes: readonly PhoneNote[]): boolean {
  if (!notes.length) {
    storageRemove(keyOf(workspaceId))
    return true
  }
  const files: StoredNotes['files'] = {}
  for (const { file, ...rest } of notes) (files[file] ??= []).push(rest)
  return storageSet(keyOf(workspaceId), JSON.stringify({ v: 1, files } satisfies StoredNotes))
}

let seq = 0
/** An id without crypto.randomUUID (missing on plain http, which is not a secure context). */
function newId(): string {
  seq = (seq + 1) % 1e6
  return `${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** `lines` of the shared shape: '42' or '42-50'. */
export function noteLines(n: Pick<PhoneNote, 'line' | 'endLine'>): string {
  return n.endLine && n.endLine > n.line ? `${n.line}-${n.endLine}` : String(n.line)
}

export function toPayload(n: PhoneNote): ReviewNotePayload {
  return { file: n.file, lines: noteLines(n), comment: n.comment }
}

export const isSent = (n: Pick<PhoneNote, 'sentAt'>): boolean => n.sentAt !== undefined

/** The notes still to send, in the order the batch prints them. */
export function pendingNotes(notes: readonly PhoneNote[]): PhoneNote[] {
  return notes.filter((n) => !isSent(n)).sort((a, b) => compareNotes(toPayload(a), toPayload(b)) || a.createdAt - b.createdAt)
}

/** The line snapshot a note keeps. */
export function lineSnapshot(text: string): string {
  return text.slice(0, REVIEW_NOTE_MAX_LINE_TEXT)
}

/**
 * Whether a note is outdated against the read part of its file's diff:
 * its line shows with other text, or it is gone from a diff read to the end.
 * Undefined = cannot tell yet (the line is not in the pages read so far).
 */
export function staleAgainst(n: Pick<PhoneNote, 'line' | 'lineText'>, lines: ReadonlyMap<number, string>, complete: boolean): boolean | undefined {
  const text = lines.get(n.line)
  if (text === undefined) return complete ? true : undefined
  return n.lineText !== undefined && n.lineText !== lineSnapshot(text)
}

/**
 * Cut notes into ctl batches: each one at most 50 notes, 32KB of formatted
 * text (the desktop's too_large) and NOTES_FRAME_BUDGET of JSON. Order is the
 * printed one, so a batch never splits a file's notes out of order.
 */
export function chunkNotes(notes: readonly PhoneNote[]): PhoneNote[][] {
  const out: PhoneNote[][] = []
  let cur: PhoneNote[] = []
  let json = 0
  for (const n of pendingNotes(notes)) {
    const bytes = utf8Bytes(JSON.stringify(toPayload(n))) + 1
    const next = [...cur, n]
    const fits =
      next.length <= REVIEW_BATCH_MAX_NOTES &&
      json + bytes <= NOTES_FRAME_BUDGET &&
      utf8Bytes(buildReviewNotesText(next.map(toPayload))) <= REVIEW_BATCH_MAX_BYTES
    if (!fits && cur.length) {
      out.push(cur)
      cur = [n]
      json = bytes
    } else {
      cur = next
      json += bytes
    }
  }
  if (cur.length) out.push(cur)
  return out
}

// ---- the store -----------------------------------------------------------------

interface NotesState {
  /** Notes per workspace, loaded on first use. */
  byWs: Record<string, PhoneNote[]>
  /** Load a workspace's notes from storage (once per page). */
  ensure: (workspaceId: string) => PhoneNote[]
  /** Add a note; null at NOTES_MAX_PER_WORKSPACE or with an empty comment. */
  add: (workspaceId: string, input: NoteInput) => PhoneNote | null
  /** Edit a note's comment and range; the edit makes it pending again. */
  edit: (workspaceId: string, id: string, patch: Pick<PhoneNote, 'comment'> & { endLine?: number }) => void
  remove: (workspaceId: string, ids: readonly string[]) => void
  markSent: (workspaceId: string, ids: readonly string[], at: number) => void
  /** Recompute "Outdated" for a file's notes against the read part of its diff. */
  refreshStale: (workspaceId: string, file: string, lines: ReadonlyMap<number, string>, complete: boolean) => void
  /** Notes of files that left a complete change list turn "Outdated". */
  markGoneFiles: (workspaceId: string, listed: ReadonlySet<string>) => void
}

export const useNotesStore = create<NotesState>((set, get) => {
  const commit = (workspaceId: string, notes: PhoneNote[]): void => {
    writeNotes(workspaceId, notes)
    set((s) => ({ byWs: { ...s.byWs, [workspaceId]: notes } }))
  }
  const current = (workspaceId: string): PhoneNote[] => get().ensure(workspaceId)
  return {
    byWs: {},
    ensure: (workspaceId) => {
      const have = get().byWs[workspaceId]
      if (have) return have
      const notes = readNotes(workspaceId)
      set((s) => ({ byWs: { ...s.byWs, [workspaceId]: notes } }))
      return notes
    },
    add: (workspaceId, input) => {
      const comment = input.comment.trim().slice(0, NOTE_MAX_CHARS)
      const notes = current(workspaceId)
      if (!comment || !isPosInt(input.line) || notes.length >= NOTES_MAX_PER_WORKSPACE) return null
      const note: PhoneNote = { id: newId(), file: input.file, line: input.line, comment, createdAt: Date.now() }
      if (input.endLine && input.endLine > input.line) note.endLine = input.endLine
      if (input.lineText !== undefined) note.lineText = lineSnapshot(input.lineText)
      commit(workspaceId, [...notes, note])
      return note
    },
    edit: (workspaceId, id, patch) => {
      const comment = patch.comment.trim().slice(0, NOTE_MAX_CHARS)
      if (!comment) return
      commit(
        workspaceId,
        current(workspaceId).map((n) => {
          if (n.id !== id) return n
          const { sentAt: _s, endLine: _e, ...rest } = n
          return { ...rest, comment, ...(patch.endLine && patch.endLine > n.line ? { endLine: patch.endLine } : {}) }
        }),
      )
    },
    remove: (workspaceId, ids) => {
      const drop = new Set(ids)
      commit(workspaceId, current(workspaceId).filter((n) => !drop.has(n.id)))
    },
    markSent: (workspaceId, ids, at) => {
      const sent = new Set(ids)
      commit(workspaceId, current(workspaceId).map((n) => (sent.has(n.id) ? { ...n, sentAt: at } : n)))
    },
    refreshStale: (workspaceId, file, lines, complete) => {
      const notes = current(workspaceId)
      let changed = false
      const next = notes.map((n) => {
        if (n.file !== file) return n
        const stale = staleAgainst(n, lines, complete)
        if (stale === undefined || stale === !!n.stale) return n
        changed = true
        if (stale) return { ...n, stale: true }
        const { stale: _s, ...rest } = n
        return rest
      })
      if (changed) commit(workspaceId, next)
    },
    markGoneFiles: (workspaceId, listed) => {
      const notes = current(workspaceId)
      if (!notes.some((n) => !listed.has(n.file) && !n.stale)) return
      commit(workspaceId, notes.map((n) => (!listed.has(n.file) && !n.stale ? { ...n, stale: true } : n)))
    },
  }
})
