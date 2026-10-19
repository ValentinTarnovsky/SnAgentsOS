/**
 * Review notes (E7-FR-17..21): comments on lines of the Changes panel's diff
 * that go to an agent console in one batch. Main owns them in
 * dataDir()/review-notes.json, per workspace; the renderer mirrors them. The
 * phone never reads or writes this store: its notes travel inline on the
 * `sendReviewNotes` ctl (E7-FR-25). No imports, shared by main and renderer.
 */

/** Longest note body (E7-FR-17). */
export const REVIEW_NOTE_MAX_BODY = 4000
/** Notes kept per workspace (Design D). */
export const REVIEW_NOTES_MAX_PER_WORKSPACE = 500
/** One batch: at most this many notes... (E7-FR-19) */
export const REVIEW_BATCH_MAX_NOTES = 50
/** ...and at most this many UTF-8 bytes of formatted text. */
export const REVIEW_BATCH_MAX_BYTES = 32 * 1024
/** Snapshot of the annotated line kept to flag a note as outdated. */
export const REVIEW_NOTE_MAX_LINE_TEXT = 1000

/** Areas a note can live on (a conflict diff is raw and takes no notes). */
export type ReviewNoteArea = 'staged' | 'unstaged' | 'untracked'

export interface ReviewNote {
  id: string
  workspaceId: string
  /** Git target of the diff: 'ws:<id>' | 'pane:<id>'. */
  targetKey: string
  /** Relative to the repo, with '/'. */
  filePath: string
  area: ReviewNoteArea
  /** First line of a range (new side); absent for a single line. */
  startLine?: number
  /** Line on the new side; 0 = file note. */
  line: number
  /** Text of `line` when the note was written, to flag it "outdated". */
  lineText?: string
  body: string
  createdAt: number
  updatedAt: number
  sentAt?: number
  sentToPaneId?: string
  resolvedAt?: number
}

/** What `notesUpsert` takes: main mints id and times, and owns `sentAt`. */
export type ReviewNoteInput = Omit<ReviewNote, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

export interface ReviewNotesListRes {
  notes: ReviewNote[]
  /** Bumped on every change of the workspace's notes (in memory, per run). */
  rev: number
}

export interface ReviewNotesChangedEvt {
  workspaceId: string
  rev: number
}

export interface ReviewNotesDeleteReq {
  ids?: string[]
  workspaceId?: string
}

export interface ReviewNotesMarkSentReq {
  ids: string[]
  paneId: string
  sentAt: number
}

/** Why a batch was not sent (the codes of the `sendReviewNotes` ctl, E7-FR-25). */
export type SendReviewNotesError = 'not_found' | 'no_pty' | 'not_agent' | 'no_notes' | 'too_large'

/** Not resolved and not sent yet: what the next batch takes (E7-FR-19). */
export function isPendingNote(n: Pick<ReviewNote, 'sentAt' | 'resolvedAt'>): boolean {
  return n.sentAt === undefined && n.resolvedAt === undefined
}

/** The `lines` field of the shared shape: '40', '40-52' or '' for a file note. */
export function noteLines(n: Pick<ReviewNote, 'line' | 'startLine'>): string {
  if (!n.line) return ''
  if (n.startLine && n.startLine < n.line) return `${n.startLine}-${n.line}`
  return String(n.line)
}
