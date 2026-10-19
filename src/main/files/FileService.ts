/**
 * The Files drawer's file access (v2.2, E9). Every request names a workspace
 * and a relative path (`/` separators, isSafeRel); the root is the
 * workspace's folder as main reads it from the config, realpath'd, and every
 * target's realpath must stay inside it, so neither `..` nor a junction or a
 * symlink reaches out. `.git` is never listed nor written.
 *
 * Text files keep their bytes' shape: a BOM and CRLF line endings are
 * reported on read and restored on save. A save may carry the `rev` the
 * editor loaded (mtime and size): when the file changed on disk since (an
 * agent edited it), the answer is `conflict`. Deletes go to the OS trash.
 * One workspace folder is watched at a time (the drawer on screen).
 */
import { promises as fsp, realpathSync, watch as fsWatch } from 'fs'
import { basename, isAbsolute, join } from 'path'
import {
  FILE_EDIT_MAX,
  FILE_IMAGE_MAX,
  FILE_IMAGE_TYPES,
  FILE_VIEW_MAX,
  FILES_LIST_MAX,
  baseName,
  extOf,
  fileRev,
  inGitDir,
  isSafeRel,
  parentRel,
  type FileCreateReq,
  type FileEntry,
  type FileReadRes,
  type FileRenameReq,
  type FileWriteReq,
  type FileWriteRes,
  type FilesChangedEvt,
  type FilesError,
  type FilesListReq,
  type FilesListRes,
  type FilesOpRes,
  type FilesRootRes,
} from '@shared/files'
import { INERT_OPEN_EXTENSIONS } from '@shared/inertOpen'
import type { ConfigFile } from '@shared/types'
import { writeAtomic } from '../fsAtomic'
import { isInside } from '../remote/pathOpen'
import { nativeRecursiveWatch, watchDirTree, type TreeWatchHandle } from '../git/treeWatch'

/** Bytes looked at for a NUL to call a file binary. */
const BINARY_SNIFF = 8000
/** Changes are gathered this long before they go out. */
export const FILES_WATCH_DEBOUNCE_MS = 250
/** More changed folders than this in one batch: reload everything shown. */
const FILES_WATCH_MAX_DIRS = 200

export interface FileServiceDeps {
  config: () => ConfigFile | null
  emit: (evt: FilesChangedEvt) => void
  /** shell.trashItem */
  trash: (p: string) => Promise<void>
  /** shell.showItemInFolder */
  reveal: (p: string) => void
  /** shell.openPath; resolves '' or an error text */
  openPath: (p: string) => Promise<string>
  platform?: NodeJS.Platform
  /** Injectable for tests: a recursive watch of `root`; null when it cannot watch. */
  watchRoot?: (root: string, onEvent: (rel: string | null) => void, onError: () => void) => TreeWatchHandle | null
}

type Resolved = { ok: true; root: string; target: string } | { ok: false; error: FilesError }

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
}

export class FileService {
  private readonly win: boolean
  private watcher: { workspaceId: string; handle: TreeWatchHandle; timer: ReturnType<typeof setTimeout> | null; dirs: Set<string> } | null = null

  constructor(private readonly deps: FileServiceDeps) {
    this.win = (deps.platform ?? process.platform) === 'win32'
  }

  /** The workspace's folder, realpath'd, or why there is none. */
  private root(workspaceId: unknown): { ok: true; root: string; spelled: string } | { ok: false; error: FilesError } {
    if (!isId(workspaceId)) return { ok: false, error: 'invalid' }
    const ws = this.deps.config()?.workspaces?.find((w) => w.id === workspaceId)
    if (!ws) return { ok: false, error: 'not_found' }
    const cwd = typeof ws.cwd === 'string' ? ws.cwd.trim() : ''
    if (!cwd || !isAbsolute(cwd)) return { ok: false, error: 'no_root' }
    try {
      return { ok: true, root: realpathSync.native(cwd), spelled: cwd }
    } catch {
      return { ok: false, error: 'no_root' }
    }
  }

  private abs(root: string, rel: string): string {
    return rel ? join(root, ...rel.split('/')) : root
  }

  /** The realpath of an existing target, kept inside the root. */
  private existing(workspaceId: unknown, rel: unknown): Resolved {
    const r = this.root(workspaceId)
    if (!r.ok) return r
    if (!isSafeRel(rel) || inGitDir(rel)) return { ok: false, error: 'invalid' }
    let target: string
    try {
      target = realpathSync.native(this.abs(r.root, rel))
    } catch {
      return { ok: false, error: 'not_found' }
    }
    if (!isInside(r.root, target, this.win)) return { ok: false, error: 'denied_path' }
    return { ok: true, root: r.root, target }
  }

  /** A path to create: its parent exists inside the root and it does not exist yet. */
  private fresh(workspaceId: unknown, rel: unknown): Resolved {
    const r = this.root(workspaceId)
    if (!r.ok) return r
    if (!isSafeRel(rel) || rel === '' || inGitDir(rel)) return { ok: false, error: 'invalid' }
    const parent = this.existing(workspaceId, parentRel(rel))
    if (!parent.ok) return parent
    const target = join(parent.target, baseName(rel))
    try {
      realpathSync.native(target)
      return { ok: false, error: 'exists' }
    } catch {
      return { ok: true, root: r.root, target }
    }
  }

  rootInfo(workspaceId: unknown): FilesRootRes {
    const r = this.root(workspaceId)
    if (!r.ok) return r
    return { ok: true, root: r.spelled, name: basename(r.spelled) || r.spelled }
  }

  async list(req: unknown): Promise<FilesListRes> {
    const q = obj(req) as Partial<FilesListReq> | null
    const dir = this.existing(q?.workspaceId, q?.rel)
    if (!dir.ok) return dir
    let dirents
    try {
      dirents = await fsp.readdir(dir.target, { withFileTypes: true })
    } catch {
      return { ok: false, error: 'io' }
    }
    const entries: FileEntry[] = []
    let truncated = false
    for (const d of dirents) {
      if (d.name === '.git') continue
      if (entries.length >= FILES_LIST_MAX) {
        truncated = true
        break
      }
      const p = join(dir.target, d.name)
      try {
        const link = d.isSymbolicLink()
        if (link && !isInside(dir.root, realpathSync.native(p), this.win)) continue
        const st = await fsp.stat(p)
        entries.push({ name: d.name, kind: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size, mtimeMs: Math.floor(st.mtimeMs), ...(link ? { link: true } : {}) })
      } catch {
        /* broken link or gone meanwhile */
      }
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    entries.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1))
    return { ok: true, entries, truncated }
  }

  async read(req: unknown): Promise<FileReadRes> {
    const q = obj(req)
    const file = this.existing(q?.workspaceId, q?.rel)
    if (!file.ok) return file
    try {
      const st = await fsp.stat(file.target)
      if (!st.isFile()) return { ok: false, error: 'invalid' }
      const rev = fileRev(st.mtimeMs, st.size)
      const mime = FILE_IMAGE_TYPES[extOf(file.target)]
      if (mime) {
        if (st.size > FILE_IMAGE_MAX) return { ok: false, error: 'too_large' }
        const buf = await fsp.readFile(file.target)
        return { ok: true, kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: st.size, rev }
      }
      if (st.size > FILE_VIEW_MAX) return { ok: false, error: 'too_large' }
      const buf = await fsp.readFile(file.target)
      if (buf.subarray(0, BINARY_SNIFF).includes(0)) return { ok: false, error: 'binary' }
      const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      const raw = buf.subarray(bom ? 3 : 0).toString('utf8')
      const crlf = (raw.match(/\r\n/g)?.length ?? 0) > 0 && (raw.match(/\r\n/g)?.length ?? 0) >= (raw.match(/(?<!\r)\n/g)?.length ?? 0)
      return { ok: true, kind: 'text', text: crlf ? raw.replace(/\r\n/g, '\n') : raw, eol: crlf ? 'crlf' : 'lf', bom, rev, size: st.size, readOnly: st.size > FILE_EDIT_MAX }
    } catch {
      return { ok: false, error: 'io' }
    }
  }

  async write(req: unknown): Promise<FileWriteRes> {
    const q = obj(req) as Partial<FileWriteReq> | null
    if (!q || typeof q.text !== 'string' || (q.eol !== 'lf' && q.eol !== 'crlf') || typeof q.bom !== 'boolean') return { ok: false, error: 'invalid' }
    if (q.baseRev !== undefined && typeof q.baseRev !== 'string') return { ok: false, error: 'invalid' }
    const file = this.existing(q.workspaceId, q.rel)
    if (!file.ok) return file
    const body = Buffer.from(q.eol === 'crlf' ? q.text.replace(/\r?\n/g, '\r\n') : q.text, 'utf8')
    const data = q.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
    if (data.length > FILE_EDIT_MAX) return { ok: false, error: 'too_large' }
    try {
      const st = await fsp.stat(file.target)
      if (!st.isFile()) return { ok: false, error: 'invalid' }
      if (q.baseRev !== undefined && fileRev(st.mtimeMs, st.size) !== q.baseRev) return { ok: false, error: 'conflict' }
      await writeAtomic(file.target, data)
      // The temp file was created with the default mode: keep an executable script executable.
      if (!this.win) await fsp.chmod(file.target, st.mode & 0o7777).catch(() => undefined)
      const now = await fsp.stat(file.target)
      return { ok: true, rev: fileRev(now.mtimeMs, now.size), size: now.size }
    } catch {
      return { ok: false, error: 'io' }
    }
  }

  async create(req: unknown): Promise<FilesOpRes> {
    const q = obj(req) as Partial<FileCreateReq> | null
    if (!q || (q.kind !== 'file' && q.kind !== 'dir')) return { ok: false, error: 'invalid' }
    const p = this.fresh(q.workspaceId, q.rel)
    if (!p.ok) return p
    try {
      if (q.kind === 'dir') await fsp.mkdir(p.target)
      else await fsp.writeFile(p.target, '', { flag: 'wx' })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as { code?: string }).code === 'EEXIST' ? 'exists' : 'io' }
    }
  }

  async rename(req: unknown): Promise<FilesOpRes> {
    const q = obj(req) as Partial<FileRenameReq> | null
    if (!q || q.from === '' || q.from === q.to) return { ok: false, error: 'invalid' }
    const from = this.existing(q.workspaceId, q.from)
    if (!from.ok) return from
    if (from.target === from.root) return { ok: false, error: 'invalid' }
    const to = this.fresh(q.workspaceId, q.to)
    if (!to.ok) return to
    try {
      await fsp.rename(from.target, to.target)
      return { ok: true }
    } catch {
      return { ok: false, error: 'io' }
    }
  }

  async trash(req: unknown): Promise<FilesOpRes> {
    const q = obj(req)
    const t = this.existing(q?.workspaceId, q?.rel)
    if (!t.ok) return t
    if (t.target === t.root) return { ok: false, error: 'invalid' }
    try {
      await this.deps.trash(t.target)
      return { ok: true }
    } catch {
      return { ok: false, error: 'io' }
    }
  }

  reveal(req: unknown): FilesOpRes {
    const q = obj(req)
    const t = this.existing(q?.workspaceId, q?.rel)
    if (!t.ok) return t
    this.deps.reveal(t.target)
    return { ok: true }
  }

  /** Opens an inert format (text, images, PDF) with its app; anything else is only revealed. */
  async openExternal(req: unknown): Promise<FilesOpRes> {
    const q = obj(req)
    const t = this.existing(q?.workspaceId, q?.rel)
    if (!t.ok) return t
    try {
      const st = await fsp.stat(t.target)
      if (st.isFile() && INERT_OPEN_EXTENSIONS.includes(`.${extOf(t.target)}`)) {
        const err = await this.deps.openPath(t.target)
        if (!err) return { ok: true }
      }
      this.deps.reveal(t.target)
      return { ok: true }
    } catch {
      return { ok: false, error: 'io' }
    }
  }

  /** Watch one workspace folder (null: stop). Changes go out per folder, gathered for 250 ms. */
  watch(workspaceId: unknown): void {
    if (workspaceId !== null && this.watcher?.workspaceId === workspaceId) return
    this.unwatch()
    if (workspaceId === null) return
    const r = this.root(workspaceId)
    if (!r.ok) return
    const id = workspaceId as string
    const onEvent = (name: string | null): void => {
      const w = this.watcher
      if (!w || w.workspaceId !== id) return
      const rel = name == null ? null : name.replace(/\\/g, '/').replace(/^\/+/, '')
      if (rel !== null && inGitDir(rel)) return
      w.dirs.add(rel === null ? '*' : parentRel(rel))
      if (w.timer) return
      w.timer = setTimeout(() => this.flushWatch(), FILES_WATCH_DEBOUNCE_MS)
    }
    const handle = (this.deps.watchRoot ?? defaultWatchRoot(this.deps.platform ?? process.platform))(r.root, onEvent, () => this.unwatch())
    if (handle) this.watcher = { workspaceId: id, handle, timer: null, dirs: new Set() }
  }

  private flushWatch(): void {
    const w = this.watcher
    if (!w) return
    w.timer = null
    const dirs = [...w.dirs]
    w.dirs.clear()
    if (!dirs.length) return
    const all = dirs.includes('*') || dirs.length > FILES_WATCH_MAX_DIRS
    this.deps.emit({ workspaceId: w.workspaceId, dirs: all ? [] : dirs, ...(all ? { all: true } : {}) })
  }

  unwatch(): void {
    const w = this.watcher
    this.watcher = null
    if (!w) return
    if (w.timer) clearTimeout(w.timer)
    w.handle.close()
  }
}

/** A recursive watch: native on Windows and macOS, a per-folder tree elsewhere. */
function defaultWatchRoot(platform: NodeJS.Platform) {
  return (root: string, onEvent: (rel: string | null) => void, onError: () => void): TreeWatchHandle | null => {
    if (!nativeRecursiveWatch(platform)) return watchDirTree(root, onEvent, onError)
    try {
      const w = fsWatch(root, { recursive: true, persistent: false }, (_ev, name) => onEvent(name == null ? null : String(name)))
      w.on('error', onError)
      return w
    } catch {
      return null
    }
  }
}
