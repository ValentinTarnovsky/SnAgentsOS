/**
 * Review notes of the Changes panel (E7-FR-17..20, Design D), owned by main
 * in dataDir()/review-notes.json so the portable stays self-contained. Kept
 * out of config.json, which the renderer saves whole on every change. Same
 * durability as remote-devices.json: atomic tmp + rename, writes debounced to
 * 300 ms, a synchronous flush at exit; a corrupt file loads as empty (notes
 * are a convenience, not a record). zod checks every input and every stored
 * note, and a workspace keeps at most 500 notes.
 *
 * Each workspace has an in-memory `rev`, bumped on every change and emitted
 * as `git:notesChanged`, so the renderer mirror reloads only what moved.
 * The phone never touches this store (its notes travel inline, E7-FR-25).
 *
 * File, clock, timers and ids are injected so scripts/test-git.cjs runs the
 * whole policy on a temp folder.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  REVIEW_NOTE_MAX_BODY,
  REVIEW_NOTE_MAX_LINE_TEXT,
  REVIEW_NOTES_MAX_PER_WORKSPACE,
  type ReviewNote,
  type ReviewNotesChangedEvt,
  type ReviewNotesListRes,
} from '@shared/review-notes'

export const NOTES_SAVE_DEBOUNCE_MS = 300
const MAX_ID = 200
const MAX_PATH = 1024
const MAX_LINE = 10_000_000

// C0, DEL and C1: never part of a repo-relative path we show or paste.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

/** Repo-relative path with '/': not absolute, no drive, no '.' or '..' segment. */
export function isRelativeRepoPath(p: string): boolean {
  if (!p || p.length > MAX_PATH || CONTROL_RE.test(p)) return false
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return false
  return p.split(/[\\/]/).every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

const idSchema = z.string().min(1).max(MAX_ID)
const targetKeySchema = z.string().regex(/^(ws|pane):[^\s]{1,200}$/)
const areaSchema = z.enum(['staged', 'unstaged', 'untracked'])
const lineSchema = z.number().int().min(0).max(MAX_LINE)
const timeSchema = z.number().int().nonnegative()

/** What the renderer may set. `sentAt` / `sentToPaneId` come only from markSent. */
const inputSchema = z.object({
  id: idSchema.optional(),
  workspaceId: idSchema,
  targetKey: targetKeySchema,
  filePath: z.string().refine(isRelativeRepoPath),
  area: areaSchema,
  startLine: lineSchema.optional(),
  line: lineSchema,
  lineText: z.string().max(64 * 1024).optional(),
  body: z.string().max(REVIEW_NOTE_MAX_BODY).refine((b) => b.trim().length > 0),
  resolvedAt: timeSchema.optional(),
})

const storedSchema = inputSchema.extend({
  id: idSchema,
  lineText: z.string().max(REVIEW_NOTE_MAX_LINE_TEXT).optional(),
  createdAt: timeSchema,
  updatedAt: timeSchema,
  sentAt: timeSchema.optional(),
  sentToPaneId: idSchema.optional(),
})

const fileSchema = z.object({ version: z.literal(1), notes: z.array(z.unknown()) })

export class ReviewNoteError extends Error {
  constructor(readonly code: 'invalid' | 'limit') {
    super(code)
  }
}

export interface ReviewNoteStoreDeps {
  /** dataDir()/review-notes.json (resolved lazily: the legacy migration runs first). */
  file: () => string
  emit?: (evt: ReviewNotesChangedEvt) => void
  now?: () => number
  newId?: () => string
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** A single line range on the new side: `startLine` only when below `line`, none on a file note. */
function normalizeRange(line: number, startLine: number | undefined): { line: number; startLine?: number } {
  if (!line) return { line: 0 }
  return startLine && startLine >= 1 && startLine < line ? { line, startLine } : { line }
}

export class ReviewNoteStore {
  /** workspaceId -> notes, in creation order. */
  private readonly byWorkspace = new Map<string, ReviewNote[]>()
  private readonly revs = new Map<string, number>()
  private loaded = false
  private timer: unknown = null
  private readonly now: () => number
  private readonly newId: () => string
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: ReviewNoteStoreDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Reads the file once; a missing, corrupt or foreign file loads as empty. Bad notes are dropped one by one. */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const file = this.deps.file()
      if (!existsSync(file)) return
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
      if (!parsed.success) return
      const seen = new Set<string>()
      for (const raw of parsed.data.notes) {
        const r = storedSchema.safeParse(raw)
        if (!r.success || seen.has(r.data.id)) continue
        seen.add(r.data.id)
        const list = this.byWorkspace.get(r.data.workspaceId) ?? []
        if (list.length >= REVIEW_NOTES_MAX_PER_WORKSPACE) continue
        list.push({ ...r.data, ...normalizeRange(r.data.line, r.data.startLine) } as ReviewNote)
        this.byWorkspace.set(r.data.workspaceId, list)
      }
    } catch {
      this.byWorkspace.clear()
    }
  }

  list(workspaceId: unknown): ReviewNotesListRes {
    this.load()
    if (typeof workspaceId !== 'string') return { notes: [], rev: 0 }
    return { notes: (this.byWorkspace.get(workspaceId) ?? []).map((n) => ({ ...n })), rev: this.revs.get(workspaceId) ?? 0 }
  }

  /**
   * Creates a note, or updates the one with `id` in the same workspace.
   * Editing the text puts a sent note back to pending (drops `sentAt`).
   * Throws ReviewNoteError('invalid' | 'limit').
   */
  upsert(input: unknown): ReviewNote {
    this.load()
    const r = inputSchema.safeParse(input)
    if (!r.success) throw new ReviewNoteError('invalid')
    const v = r.data
    const now = this.now()
    const list = this.byWorkspace.get(v.workspaceId) ?? []
    const range = normalizeRange(v.line, v.startLine)
    const lineText = v.lineText === undefined || !range.line ? undefined : v.lineText.slice(0, REVIEW_NOTE_MAX_LINE_TEXT)
    const index = v.id ? list.findIndex((n) => n.id === v.id) : -1
    let note: ReviewNote
    if (index >= 0) {
      const prev = list[index]
      const edited = prev.body !== v.body
      note = {
        id: prev.id,
        workspaceId: prev.workspaceId,
        targetKey: v.targetKey,
        filePath: v.filePath,
        area: v.area,
        ...range,
        ...(lineText !== undefined ? { lineText } : {}),
        body: v.body,
        createdAt: prev.createdAt,
        updatedAt: edited ? now : prev.updatedAt,
        ...(!edited && prev.sentAt !== undefined ? { sentAt: prev.sentAt } : {}),
        ...(!edited && prev.sentToPaneId !== undefined ? { sentToPaneId: prev.sentToPaneId } : {}),
        ...(v.resolvedAt !== undefined ? { resolvedAt: v.resolvedAt } : {}),
      }
      if (JSON.stringify(note) === JSON.stringify(prev)) return { ...prev }
      list[index] = note
    } else {
      if (list.length >= REVIEW_NOTES_MAX_PER_WORKSPACE) throw new ReviewNoteError('limit')
      note = {
        id: this.newId(),
        workspaceId: v.workspaceId,
        targetKey: v.targetKey,
        filePath: v.filePath,
        area: v.area,
        ...range,
        ...(lineText !== undefined ? { lineText } : {}),
        body: v.body,
        createdAt: now,
        updatedAt: now,
        ...(v.resolvedAt !== undefined ? { resolvedAt: v.resolvedAt } : {}),
      }
      list.push(note)
      this.byWorkspace.set(v.workspaceId, list)
    }
    this.changed([v.workspaceId])
    return { ...note }
  }

  /** `ids` removes those notes (within `workspaceId` when given); `workspaceId` alone removes all of it. */
  delete(req: unknown): void {
    this.load()
    if (!req || typeof req !== 'object') return
    const { ids, workspaceId } = req as { ids?: unknown; workspaceId?: unknown }
    const wsId = typeof workspaceId === 'string' ? workspaceId : undefined
    const idSet = Array.isArray(ids) ? new Set(ids.filter((i): i is string => typeof i === 'string')) : null
    const touched: string[] = []
    if (!idSet) {
      if (wsId !== undefined && this.byWorkspace.delete(wsId)) touched.push(wsId)
    } else {
      for (const [ws, list] of this.byWorkspace) {
        if (wsId !== undefined && ws !== wsId) continue
        const kept = list.filter((n) => !idSet.has(n.id))
        if (kept.length === list.length) continue
        if (kept.length) this.byWorkspace.set(ws, kept)
        else this.byWorkspace.delete(ws)
        touched.push(ws)
      }
    }
    this.changed(touched)
  }

  /** Stamps `sentAt` / `sentToPaneId` on store notes after a batch reached the console. */
  markSent(req: unknown): void {
    this.load()
    const r = z.object({ ids: z.array(idSchema).max(REVIEW_NOTES_MAX_PER_WORKSPACE), paneId: idSchema, sentAt: timeSchema }).safeParse(req)
    if (!r.success) return
    const idSet = new Set(r.data.ids)
    const touched: string[] = []
    for (const [ws, list] of this.byWorkspace) {
      let hit = false
      for (let i = 0; i < list.length; i++) {
        if (!idSet.has(list[i].id)) continue
        list[i] = { ...list[i], sentAt: r.data.sentAt, sentToPaneId: r.data.paneId }
        hit = true
      }
      if (hit) touched.push(ws)
    }
    this.changed(touched)
  }

  /** Drops the notes of every workspace not in `keep` (the renderer's list after hydrating). */
  prune(keep: unknown): void {
    this.load()
    if (!Array.isArray(keep)) return
    const ids = new Set(keep.filter((k): k is string => typeof k === 'string'))
    const touched = [...this.byWorkspace.keys()].filter((ws) => !ids.has(ws))
    for (const ws of touched) this.byWorkspace.delete(ws)
    this.changed(touched)
  }

  /** Writes a pending change now (exit paths). */
  flush(): void {
    if (this.timer !== null) this.writeNow()
  }

  private changed(workspaceIds: string[]): void {
    if (!workspaceIds.length) return
    for (const ws of workspaceIds) {
      const rev = (this.revs.get(ws) ?? 0) + 1
      this.revs.set(ws, rev)
      this.deps.emit?.({ workspaceId: ws, rev })
    }
    if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null
        this.writeNow()
      }, NOTES_SAVE_DEBOUNCE_MS)
    }
  }

  private writeNow(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    const notes: ReviewNote[] = []
    for (const list of this.byWorkspace.values()) notes.push(...list)
    const file = this.deps.file()
    const tmp = `${file}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, notes }), 'utf8')
      renameSync(tmp, file)
    } catch {
      console.warn('[git] could not write the review notes')
    }
  }
}
