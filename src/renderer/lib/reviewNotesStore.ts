import { create } from 'zustand'
import { useAppStore } from './store'
import type { GitDiffHunk } from '@shared/git-types'
import {
  isPendingNote,
  noteLines,
  REVIEW_BATCH_MAX_BYTES,
  REVIEW_BATCH_MAX_NOTES,
  type ReviewNote,
  type ReviewNotesListRes,
} from '@shared/review-notes'
import { buildReviewNotesText, compareNotes, utf8Bytes, type ReviewNotePayload } from '@shared/review-notes-format'

/**
 * Renderer mirror of main's review notes (E7-FR-17..20), per workspace, plus
 * the pure helpers the Changes panel and the sender share: the shared payload
 * shape, pending notes, where each note sits in a diff (and whether it is
 * outdated), per-row counts and the batch limits. Main is the owner: every
 * change goes through `window.snApi.reviewNotes` and comes back as
 * `git:notesChanged`, which reloads only the workspace that moved.
 */
interface ReviewNotesState {
  /** workspaceId -> notes, loaded on demand (the Changes panel). */
  notes: Record<string, ReviewNote[]>
  revs: Record<string, number>
  load: (workspaceId: string) => Promise<void>
  apply: (workspaceId: string, res: ReviewNotesListRes) => void
  forget: (workspaceIds: readonly string[]) => void
}

export const useReviewNotesStore = create<ReviewNotesState>((set, get) => ({
  notes: {},
  revs: {},
  load: async (workspaceId) => {
    try {
      get().apply(workspaceId, await window.snApi.reviewNotes.list(workspaceId))
    } catch {
      // Main unreachable for a moment: the next change event reloads.
    }
  },
  apply: (workspaceId, res) => {
    const prev = get().revs[workspaceId]
    if (prev !== undefined && res.rev < prev) return
    set((s) => ({ notes: { ...s.notes, [workspaceId]: res.notes }, revs: { ...s.revs, [workspaceId]: res.rev } }))
  },
  forget: (workspaceIds) => {
    const { notes, revs } = get()
    if (!workspaceIds.some((id) => id in notes || id in revs)) return
    const n = { ...notes }
    const r = { ...revs }
    for (const id of workspaceIds) {
      delete n[id]
      delete r[id]
    }
    set({ notes: n, revs: r })
  },
}))

const EMPTY: ReviewNote[] = []

/** A workspace's notes (stable empty array while not loaded). */
export function workspaceNotes(notes: Record<string, ReviewNote[]>, workspaceId: string): ReviewNote[] {
  return notes[workspaceId] ?? EMPTY
}

/** The shape shared with the phone's ctl: `{ file, lines, comment }`. */
export function toPayload(n: Pick<ReviewNote, 'filePath' | 'line' | 'startLine' | 'body'>): ReviewNotePayload {
  return { file: n.filePath, lines: noteLines(n), comment: n.body }
}

/** Notes the next batch takes: not resolved and not sent. */
export function pendingNotes(list: readonly ReviewNote[]): ReviewNote[] {
  return list.filter(isPendingNote)
}

/** Notes shown on one file of one target. */
export function notesForFile(list: readonly ReviewNote[], targetKey: string, path: string, area: string): ReviewNote[] {
  return list.filter((n) => n.targetKey === targetKey && n.filePath === path && n.area === area)
}

/** Unresolved notes per file-list row (`area:path`) of a target, for the row badges. */
export function noteCountsByRow(list: readonly ReviewNote[], targetKey: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const n of list) {
    if (n.targetKey !== targetKey || n.resolvedAt !== undefined) continue
    const k = `${n.area}:${n.filePath}`
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

export interface DiffAnchors {
  /** New-side line -> notes whose (last) line is there and visible in the diff. */
  byLine: Map<number, ReviewNote[]>
  /** File notes, then notes whose line is no longer in the diff (shown above it). */
  top: ReviewNote[]
  /** Ids flagged "outdated": the annotated line changed or left the diff (E7-FR-18). */
  stale: Set<string>
}

/** Text of each new-side line the diff shows (add and context lines). */
export function newSideLines(hunks: readonly GitDiffHunk[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const h of hunks) for (const l of h.lines) if ((l.kind === 'add' || l.kind === 'ctx') && l.newNo !== undefined) out.set(l.newNo, l.text)
  return out
}

/** Where the notes of one file go in its diff, and which ones are outdated. */
export function anchorNotes(notes: readonly ReviewNote[], hunks: readonly GitDiffHunk[]): DiffAnchors {
  const lines = newSideLines(hunks)
  const byLine = new Map<number, ReviewNote[]>()
  const files: ReviewNote[] = []
  const orphans: ReviewNote[] = []
  const stale = new Set<string>()
  for (const n of [...notes].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!n.line) {
      files.push(n)
      continue
    }
    const text = lines.get(n.line)
    if (text === undefined) {
      orphans.push(n)
      stale.add(n.id)
      continue
    }
    if (n.lineText !== undefined && n.lineText !== text) stale.add(n.id)
    const at = byLine.get(n.line) ?? []
    at.push(n)
    byLine.set(n.line, at)
  }
  return { byLine, top: [...files, ...orphans], stale }
}

export interface BatchCheck {
  ok: boolean
  /** The pasted text (formatted and sanitized). */
  text: string
  bytes: number
}

/** Whether a batch fits the limits: at most 50 notes and 32 KB of text (E7-FR-19). */
export function checkBatch(payloads: readonly ReviewNotePayload[]): BatchCheck {
  const text = buildReviewNotesText(payloads)
  const bytes = utf8Bytes(text)
  return { ok: payloads.length > 0 && payloads.length <= REVIEW_BATCH_MAX_NOTES && bytes <= REVIEW_BATCH_MAX_BYTES, text, bytes }
}

/**
 * "Send in parts": the longest run of notes, in the order the batch prints
 * them, that fits the limits. The rest stay pending for the next send.
 */
export function firstBatch<T extends Pick<ReviewNote, 'filePath' | 'line' | 'startLine' | 'body'>>(notes: readonly T[]): T[] {
  const order = notes.map((n, i) => ({ n, p: toPayload(n), i })).sort((a, b) => compareNotes(a.p, b.p) || a.i - b.i)
  const out: T[] = []
  for (const t of order) {
    if (out.length >= REVIEW_BATCH_MAX_NOTES || !checkBatch([...out, t.n].map(toPayload)).ok) break
    out.push(t.n)
  }
  return out
}

// ---- sync -------------------------------------------------------------------

let stop: (() => void) | null = null

/**
 * Keep the mirror in step with main (call once, after hydrate): reload a
 * loaded workspace on `git:notesChanged`, delete the notes of a workspace
 * the store drops (delete, import) and, after a successful config load,
 * prune notes of workspaces that no longer exist. Returns a stop function.
 */
export function startReviewNotesSync(opts: { prune: boolean }): () => void {
  if (stop) return () => undefined
  const api = window.snApi.reviewNotes
  if (opts.prune) api.prune(useAppStore.getState().workspaces.map((w) => w.id))
  const offChanged = api.onChanged((evt) => {
    const s = useReviewNotesStore.getState()
    if (!(evt.workspaceId in s.notes)) return
    if (s.revs[evt.workspaceId] === evt.rev) return
    void s.load(evt.workspaceId)
  })
  const offWorkspaces = useAppStore.subscribe((state, prev) => {
    if (state.workspaces === prev.workspaces) return
    const alive = new Set(state.workspaces.map((w) => w.id))
    const gone = prev.workspaces.map((w) => w.id).filter((id) => !alive.has(id))
    if (!gone.length) return
    for (const id of gone) void api.delete({ workspaceId: id }).catch(() => undefined)
    useReviewNotesStore.getState().forget(gone)
  })
  stop = () => {
    offChanged()
    offWorkspaces()
    stop = null
  }
  return stop
}
