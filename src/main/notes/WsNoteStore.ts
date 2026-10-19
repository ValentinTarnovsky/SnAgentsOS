/**
 * Markdown notes of each workspace (v2.2, E9): one real `.md` file per note
 * under <root>/<workspaceId>/<noteId>.md (root = dataDir()/notes), so they
 * open in any editor and an agent can read one by its path. Main owns them;
 * the renderer and the phone only pass ids, never paths: both ids are plain
 * ASCII (WS_NOTE_ID_RE), so no request can name a file outside the root.
 *
 * Writes are atomic (temp + rename, UTF-8 without BOM). A write may carry the
 * `rev` the editor loaded (mtime and size): when the file changed since, the
 * answer is `conflict` with the note as it is now. Deleted notes and the
 * notes of deleted workspaces go to <root>/.trash, purged after 30 days.
 */
import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { join } from 'path'
import {
  WS_NOTE_MAX_BYTES,
  isNoteId,
  noteRev,
  noteTitle,
  type WsNoteDoc,
  type WsNoteMeta,
  type WsNoteResult,
  type WsNotesChangedEvt,
  type WsNotesListRes,
} from '@shared/ws-notes'
import { writeAtomic } from '../fsAtomic'

/** Bytes read from the top of a note to find its title for the list. */
const TITLE_SCAN_BYTES = 4096
/** Trash entries older than this are purged on prune. */
export const WS_NOTE_TRASH_MS = 30 * 24 * 60 * 60 * 1000
const TRASH = '.trash'

export interface WsNoteStoreDeps {
  /** dataDir()/notes, resolved on use (after the legacy migration). */
  root: () => string
  emit: (evt: WsNotesChangedEvt) => void
  now?: () => number
  newId?: () => string
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export class WsNoteStore {
  constructor(private readonly deps: WsNoteStoreDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private dir(workspaceId: string): string {
    return join(this.deps.root(), workspaceId)
  }

  private file(workspaceId: string, noteId: string): string {
    return join(this.dir(workspaceId), `${noteId}.md`)
  }

  /** The notes of a workspace, newest first. */
  async list(workspaceId: unknown): Promise<WsNotesListRes> {
    if (!isNoteId(workspaceId)) return { ok: false, notes: [] }
    let names: string[]
    try {
      names = await fsp.readdir(this.dir(workspaceId))
    } catch {
      return { ok: true, notes: [] }
    }
    const notes: WsNoteMeta[] = []
    await Promise.all(
      names.map(async (name) => {
        const id = name.endsWith('.md') ? name.slice(0, -3) : ''
        if (!isNoteId(id)) return
        const meta = await this.meta(workspaceId, id).catch(() => null)
        if (meta) notes.push(meta)
      }),
    )
    notes.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    return { ok: true, notes }
  }

  private async meta(workspaceId: string, noteId: string): Promise<WsNoteMeta | null> {
    const file = this.file(workspaceId, noteId)
    const st = await fsp.stat(file)
    if (!st.isFile()) return null
    const handle = await fsp.open(file, 'r')
    let head = ''
    try {
      const buf = Buffer.alloc(Math.min(TITLE_SCAN_BYTES, st.size))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      head = stripBom(buf.subarray(0, bytesRead).toString('utf8'))
    } finally {
      await handle.close()
    }
    return { id: noteId, title: noteTitle(head), updatedAt: Math.floor(st.mtimeMs), size: st.size, rev: noteRev(st.mtimeMs, st.size) }
  }

  private async doc(workspaceId: string, noteId: string): Promise<WsNoteDoc | null> {
    const file = this.file(workspaceId, noteId)
    let st
    try {
      st = await fsp.stat(file)
    } catch {
      return null
    }
    if (!st.isFile()) return null
    if (st.size > WS_NOTE_MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' })
    const text = stripBom(await fsp.readFile(file, 'utf8'))
    return { id: noteId, title: noteTitle(text), updatedAt: Math.floor(st.mtimeMs), size: st.size, rev: noteRev(st.mtimeMs, st.size), text, path: file }
  }

  async read(req: unknown): Promise<WsNoteResult<{ note: WsNoteDoc }>> {
    const r = obj(req)
    if (!r || !isNoteId(r.workspaceId) || !isNoteId(r.noteId)) return { ok: false, error: 'invalid' }
    try {
      const note = await this.doc(r.workspaceId, r.noteId)
      return note ? { ok: true, note } : { ok: false, error: 'not_found' }
    } catch (err) {
      return { ok: false, error: (err as { code?: string }).code === 'TOO_LARGE' ? 'too_large' : 'io' }
    }
  }

  async write(req: unknown): Promise<WsNoteResult<{ note: WsNoteMeta }>> {
    const r = obj(req)
    if (!r || !isNoteId(r.workspaceId) || !isNoteId(r.noteId) || typeof r.text !== 'string') return { ok: false, error: 'invalid' }
    if (r.baseRev !== undefined && typeof r.baseRev !== 'string') return { ok: false, error: 'invalid' }
    return this.put(r.workspaceId, r.noteId, r.text, r.baseRev as string | undefined)
  }

  async create(req: unknown): Promise<WsNoteResult<{ note: WsNoteMeta }>> {
    const r = obj(req)
    if (!r || !isNoteId(r.workspaceId) || (r.text !== undefined && typeof r.text !== 'string')) return { ok: false, error: 'invalid' }
    const id = this.deps.newId?.() ?? `n-${randomUUID().replace(/-/g, '').slice(0, 16)}`
    return this.put(r.workspaceId, id, (r.text as string | undefined) ?? '')
  }

  private async put(workspaceId: string, noteId: string, text: string, baseRev?: string): Promise<WsNoteResult<{ note: WsNoteMeta }>> {
    if (Buffer.byteLength(text, 'utf8') > WS_NOTE_MAX_BYTES) return { ok: false, error: 'too_large' }
    try {
      if (baseRev !== undefined) {
        const current = await this.doc(workspaceId, noteId).catch(() => null)
        if (current && current.rev !== baseRev) return { ok: false, error: 'conflict', current }
      }
      await fsp.mkdir(this.dir(workspaceId), { recursive: true })
      await writeAtomic(this.file(workspaceId, noteId), text)
      const note = await this.meta(workspaceId, noteId)
      if (!note) return { ok: false, error: 'io' }
      this.deps.emit({ workspaceId, noteId, rev: note.rev })
      return { ok: true, note }
    } catch {
      return { ok: false, error: 'io' }
    }
  }

  /** Moves the note to the trash. */
  async delete(req: unknown): Promise<WsNoteResult<Record<never, never>>> {
    const r = obj(req)
    if (!r || !isNoteId(r.workspaceId) || !isNoteId(r.noteId)) return { ok: false, error: 'invalid' }
    const from = this.file(r.workspaceId, r.noteId)
    try {
      await fsp.stat(from)
    } catch {
      return { ok: false, error: 'not_found' }
    }
    try {
      const trash = join(this.deps.root(), TRASH, r.workspaceId)
      await fsp.mkdir(trash, { recursive: true })
      await fsp.rename(from, join(trash, `${r.noteId}-${this.now()}.md`))
      this.deps.emit({ workspaceId: r.workspaceId, noteId: r.noteId })
      return { ok: true }
    } catch {
      return { ok: false, error: 'io' }
    }
  }

  /**
   * After a real config load: the notes of workspaces that no longer exist go
   * to the trash, and trash older than WS_NOTE_TRASH_MS is purged.
   */
  async prune(keep: unknown): Promise<void> {
    if (!Array.isArray(keep) || !keep.every((id) => typeof id === 'string')) return
    const live = new Set(keep as string[])
    const root = this.deps.root()
    let names: string[]
    try {
      names = await fsp.readdir(root)
    } catch {
      return
    }
    const trashRoot = join(root, TRASH)
    for (const name of names) {
      if (name === TRASH || !isNoteId(name) || live.has(name)) continue
      try {
        await fsp.mkdir(trashRoot, { recursive: true })
        await fsp.rename(join(root, name), join(trashRoot, `${name}-${this.now()}`))
      } catch {
        /* busy: next prune */
      }
    }
    await this.purgeTrash(trashRoot)
  }

  /** Trash entries carry the time they were trashed in their name (a rename keeps the old mtime). */
  private async purgeTrash(trashRoot: string): Promise<void> {
    const cutoff = this.now() - WS_NOTE_TRASH_MS
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        const stamp = /-(\d{12,})(?:\.md)?$/.exec(e.name)
        try {
          if (stamp) {
            if (Number(stamp[1]) < cutoff) await fsp.rm(p, { recursive: true, force: true })
          } else if (e.isDirectory()) await walk(p)
        } catch {
          /* gone meanwhile */
        }
      }
    }
    await walk(trashRoot)
  }

  /** The absolute path of an existing note, for "open outside" (main only). */
  async pathOf(req: unknown): Promise<string | null> {
    const r = obj(req)
    if (!r || !isNoteId(r.workspaceId) || !isNoteId(r.noteId)) return null
    const file = this.file(r.workspaceId, r.noteId)
    try {
      return (await fsp.stat(file)).isFile() ? file : null
    } catch {
      return null
    }
  }
}
