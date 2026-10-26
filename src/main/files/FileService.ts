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
 * The drawer on screen watches its workspace folder; share guests (app 2.6.0)
 * hold watches of their own on the folder they read (FILES_WATCH_MAX folders
 * at most, one watch per folder whoever asks).
 *
 * Share guests read through `guestList` / `guestRead` only: never `.git` (in
 * any case, nor a link into it), never a secret name (isShareSecretName, also
 * through a link), names a guest's schema accepts, and bounded reads.
 *
 * A pane's tree (app 2.7.0, A9): a request may also name a pane of the
 * workspace. Its root is then the pane's worktree, only when WorktreeService
 * manages that folder (`pane.worktree` in the config is the renderer's
 * data, the manifest is what makes it a root), else the workspace folder.
 * `resolveRefs` turns the `file:line` texts of a pane's terminal into files
 * under that same root: a relative path against the folder its shell started
 * in, containment checked on the spelled path before anything is touched
 * (so a `\\host\share` in the output never reaches the network) and again on
 * the realpath, `.git` excluded, regular files only.
 */
import { promises as fsp, realpathSync, statSync, watch as fsWatch } from 'fs'
import { homedir as osHomedir } from 'os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import {
  FILE_EDIT_MAX,
  FILE_IMAGE_MAX,
  FILE_IMAGE_TYPES,
  FILE_REFS_MAX,
  FILE_REL_MAX,
  FILE_VIEW_MAX,
  FILES_LIST_MAX,
  baseName,
  extOf,
  fileRev,
  inGitDir,
  isSafeRel,
  isShareSecretName,
  parentRel,
  relHasShareSecret,
  shareFileNameOk,
  type FileCreateReq,
  type FileEntry,
  type FileReadRes,
  type FileRefResolved,
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
import { parsePathLineCol } from '@shared/termLinks'
import type { ConfigFile, Pane, Workspace } from '@shared/types'
import { writeAtomic } from '../fsAtomic'
import { isInside } from '../remote/pathOpen'
import { nativeRecursiveWatch, watchDirTree, type TreeWatchHandle } from '../git/treeWatch'

/** Bytes looked at for a NUL to call a file binary. */
const BINARY_SNIFF = 8000
/** Changes are gathered this long before they go out. */
export const FILES_WATCH_DEBOUNCE_MS = 250
/** More changed folders than this in one batch: reload everything shown. */
const FILES_WATCH_MAX_DIRS = 200
/** Workspace folders watched at once (the drawer's and the share guests'). */
export const FILES_WATCH_MAX = 4

/** What a share guest reads of a file: text cut at `textMax` bytes (`partial`), an image up to `imageMax`. */
export type GuestReadRes =
  | { ok: true; kind: 'text'; text: string; eol: 'lf' | 'crlf'; bom: boolean; rev: string; size: number; partial: boolean }
  | { ok: true; kind: 'image'; dataUrl: string; size: number; rev: string }
  | { ok: false; error: FilesError }

interface Watcher {
  workspaceId: string
  /** A pane's tree (its events carry it). */
  paneId?: string
  handle: TreeWatchHandle
  timer: ReturnType<typeof setTimeout> | null
  dirs: Set<string>
  owners: Map<string, (evt: FilesChangedEvt) => void>
}

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
  /** WorktreeService.isManaged: only a managed worktree becomes a pane's root (app 2.7.0, A9). */
  isManagedWorktree?: (path: string) => boolean
  /** PtyManager.getSpawnCwd: the folder the pane's live shell started in, for relative refs. */
  spawnCwd?: (paneId: string) => string | undefined
  /** Injectable for tests: the folder a `~` ref expands to. */
  homedir?: () => string
}

type Resolved = { ok: true; root: string; target: string } | { ok: false; error: FilesError }
type Root = { ok: true; root: string; spelled: string } | { ok: false; error: FilesError }

/** A ref split into path and position; `path` null when it does not parse as a file. */
interface ParsedRef {
  ref: string
  path: string | null
  line?: number
  col?: number
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
}

/** An optional pane id: absent (undefined or null), else it must be an id. */
function paneArg(v: unknown): { ok: true; paneId?: string } | { ok: false } {
  if (v === undefined || v === null) return { ok: true }
  return isId(v) ? { ok: true, paneId: v } : { ok: false }
}

/** The watch of a workspace's tree, or of one of its panes' ('#' is never in an id). */
function watchKey(workspaceId: string, paneId?: string): string {
  return paneId ? `${workspaceId}#${paneId}` : workspaceId
}

function posInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
}

/** line and col as a ref carries them (a col only with a line); a number past safe integers is dropped. */
function position(line: unknown, col: unknown): { line?: number; col?: number } {
  if (!posInt(line)) return {}
  return posInt(col) ? { line, col } : { line }
}

/** A ref of `files:resolveRefs`, or null when it is not one (the request is then malformed). */
function parseRef(raw: unknown): ParsedRef | null {
  if (typeof raw === 'string') {
    if (raw.length > FILE_REL_MAX) return null
    const m = parsePathLineCol(raw.trim())
    if (!m) return { ref: raw, path: null }
    return { ref: raw, path: m.path, ...position(m.line, m.column) }
  }
  const o = obj(raw)
  if (!o || typeof o.path !== 'string' || o.path.length > FILE_REL_MAX) return null
  if ((o.line !== undefined && !posInt(o.line)) || (o.col !== undefined && !posInt(o.col))) return null
  const pos = position(o.line, o.col)
  const ref = o.path + (pos.line ? `:${pos.line}${pos.col ? `:${pos.col}` : ''}` : '')
  return { ref, path: o.path.trim() || null, ...pos }
}

export class FileService {
  private readonly win: boolean
  private readonly watchers = new Map<string, Watcher>()
  /** The tree the drawer on screen watches (owner `local`): a workspace id, or `workspaceId#paneId`. */
  private localWatch: string | null = null

  constructor(private readonly deps: FileServiceDeps) {
    this.win = (deps.platform ?? process.platform) === 'win32'
  }

  /**
   * The workspace's folder, realpath'd, or why there is none. With a pane of
   * that workspace: its worktree when WorktreeService manages the folder
   * (gone from disk: no_root, never the workspace's tree in its place), else
   * the workspace folder.
   */
  private root(workspaceId: unknown, paneId?: unknown): Root {
    if (!isId(workspaceId)) return { ok: false, error: 'invalid' }
    const pane = paneArg(paneId)
    if (!pane.ok) return { ok: false, error: 'invalid' }
    const ws = this.deps.config()?.workspaces?.find((w) => w.id === workspaceId)
    if (!ws) return { ok: false, error: 'not_found' }
    let cwd = typeof ws.cwd === 'string' ? ws.cwd.trim() : ''
    if (pane.paneId !== undefined) {
      const p = (ws.panes ?? []).find((x) => x.id === pane.paneId)
      if (!p) return { ok: false, error: 'not_found' }
      cwd = this.worktreeOf(p) ?? cwd
    }
    if (!cwd || !isAbsolute(cwd)) return { ok: false, error: 'no_root' }
    try {
      return { ok: true, root: realpathSync.native(cwd), spelled: cwd }
    } catch {
      return { ok: false, error: 'no_root' }
    }
  }

  /** The pane's worktree folder when main manages it, else null. */
  private worktreeOf(pane: Pane): string | null {
    const p = pane.worktree?.path
    return typeof p === 'string' && isAbsolute(p) && this.deps.isManagedWorktree?.(p) === true ? p : null
  }

  private abs(root: string, rel: string): string {
    return rel ? join(root, ...rel.split('/')) : root
  }

  /** The realpath of an existing target, kept inside the root. */
  private existing(workspaceId: unknown, rel: unknown, paneId?: unknown): Resolved {
    const r = this.root(workspaceId, paneId)
    if (!r.ok) return r
    if (!isSafeRel(rel) || inGitDir(rel)) return { ok: false, error: 'invalid' }
    let target: string
    try {
      target = realpathSync.native(this.abs(r.root, rel))
    } catch {
      return { ok: false, error: 'not_found' }
    }
    if (!isInside(r.root, target, this.win)) return { ok: false, error: 'denied_path' }
    // A junction or a link that resolves into `.git` (any case) is `.git`.
    if (this.realRel(r.root, target).some((seg) => seg.toLowerCase() === '.git')) return { ok: false, error: 'invalid' }
    return { ok: true, root: r.root, target }
  }

  /** The segments of a contained realpath under the root ([] for the root itself). */
  private realRel(root: string, target: string): string[] {
    const rel = relative(root, target)
    return rel ? rel.split(this.win ? /[\\/]/ : sep) : []
  }

  /** A path to create: its parent exists inside the root and it does not exist yet. */
  private fresh(workspaceId: unknown, rel: unknown, paneId?: unknown): Resolved {
    const r = this.root(workspaceId, paneId)
    if (!r.ok) return r
    if (!isSafeRel(rel) || rel === '' || inGitDir(rel)) return { ok: false, error: 'invalid' }
    const parent = this.existing(workspaceId, parentRel(rel), paneId)
    if (!parent.ok) return parent
    const target = join(parent.target, baseName(rel))
    try {
      realpathSync.native(target)
      return { ok: false, error: 'exists' }
    } catch {
      return { ok: true, root: r.root, target }
    }
  }

  rootInfo(workspaceId: unknown, paneId?: unknown): FilesRootRes {
    const r = this.root(workspaceId, paneId)
    if (!r.ok) return r
    return { ok: true, root: r.spelled, name: basename(r.spelled) || r.spelled }
  }

  async list(req: unknown): Promise<FilesListRes> {
    const q = obj(req) as Partial<FilesListReq> | null
    const dir = this.existing(q?.workspaceId, q?.rel, q?.paneId)
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
      if (d.name.toLowerCase() === '.git') continue
      if (entries.length >= FILES_LIST_MAX) {
        truncated = true
        break
      }
      const p = join(dir.target, d.name)
      try {
        const link = d.isSymbolicLink()
        if (link) {
          const real = realpathSync.native(p)
          if (!isInside(dir.root, real, this.win) || this.realRel(dir.root, real).some((seg) => seg.toLowerCase() === '.git')) continue
        }
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
    const file = this.existing(q?.workspaceId, q?.rel, q?.paneId)
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

  /** A share guest's view of the target: no secret name on the way there nor at its real place. */
  private guestExisting(workspaceId: unknown, rel: unknown): Resolved {
    if (typeof rel !== 'string' || relHasShareSecret(rel)) return { ok: false, error: 'not_found' }
    const t = this.existing(workspaceId, rel)
    if (!t.ok) return t
    if (this.realRel(t.root, t.target).some(isShareSecretName)) return { ok: false, error: 'not_found' }
    return t
  }

  /**
   * A folder as a share guest gets it (app 2.6.0): no secret name, nothing
   * that resolves to one, only names its schema accepts, at most `max`.
   */
  async guestList(workspaceId: string, rel: string, max: number): Promise<FilesListRes> {
    const dir = this.guestExisting(workspaceId, rel)
    if (!dir.ok) return dir
    const res = await this.list({ workspaceId, rel })
    if (!res.ok) return res
    const entries: FileEntry[] = []
    let truncated = res.truncated
    for (const e of res.entries) {
      if (!shareFileNameOk(e.name) || isShareSecretName(e.name)) continue
      if (e.link) {
        try {
          const real = realpathSync.native(join(dir.target, e.name))
          if (this.realRel(dir.root, real).some(isShareSecretName)) continue
        } catch {
          continue
        }
      }
      if (entries.length >= max) {
        truncated = true
        break
      }
      entries.push(e)
    }
    return { ok: true, entries, truncated }
  }

  /**
   * A file as a share guest reads it (app 2.6.0): text up to `textMax` UTF-8
   * bytes (the rest cut, `partial`; it is never saved from a share), an image
   * up to `imageMax` bytes, binary refused. Only the head of a big text file
   * is read.
   */
  async guestRead(workspaceId: string, rel: string, limits: { textMax: number; imageMax: number }): Promise<GuestReadRes> {
    const file = this.guestExisting(workspaceId, rel)
    if (!file.ok) return file
    let fh: Awaited<ReturnType<typeof fsp.open>> | null = null
    try {
      const st = await fsp.stat(file.target)
      if (!st.isFile()) return { ok: false, error: 'invalid' }
      const rev = fileRev(st.mtimeMs, st.size)
      const mime = FILE_IMAGE_TYPES[extOf(file.target)]
      if (mime) {
        if (st.size > limits.imageMax) return { ok: false, error: 'too_large' }
        const buf = await fsp.readFile(file.target)
        if (buf.length > limits.imageMax) return { ok: false, error: 'too_large' }
        return { ok: true, kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: st.size, rev }
      }
      fh = await fsp.open(file.target, 'r')
      // 3 more bytes: a BOM does not count against the text.
      const want = Math.min(st.size, limits.textMax + 3)
      const buf = Buffer.alloc(want)
      let got = 0
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, got)
        if (bytesRead === 0) break
        got += bytesRead
      }
      const head = buf.subarray(0, got)
      if (head.subarray(0, BINARY_SNIFF).includes(0)) return { ok: false, error: 'binary' }
      const bom = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
      let body = head.subarray(bom ? 3 : 0)
      const partial = st.size - (bom ? 3 : 0) > limits.textMax
      if (body.length > limits.textMax) body = body.subarray(0, limits.textMax)
      let raw = body.toString('utf8')
      // A cut in the middle of a character or of a CRLF.
      if (partial) raw = raw.replace(/\uFFFD+$/, '').replace(/\r$/, '')
      const crlfs = raw.match(/\r\n/g)?.length ?? 0
      const crlf = crlfs > 0 && crlfs >= (raw.match(/(?<!\r)\n/g)?.length ?? 0)
      return { ok: true, kind: 'text', text: crlf ? raw.replace(/\r\n/g, '\n') : raw, eol: crlf ? 'crlf' : 'lf', bom, rev, size: st.size, partial }
    } catch {
      return { ok: false, error: 'io' }
    } finally {
      await fh?.close().catch(() => undefined)
    }
  }

  async write(req: unknown): Promise<FileWriteRes> {
    const q = obj(req) as Partial<FileWriteReq> | null
    if (!q || typeof q.text !== 'string' || (q.eol !== 'lf' && q.eol !== 'crlf') || typeof q.bom !== 'boolean') return { ok: false, error: 'invalid' }
    if (q.baseRev !== undefined && typeof q.baseRev !== 'string') return { ok: false, error: 'invalid' }
    const file = this.existing(q.workspaceId, q.rel, q.paneId)
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
    const p = this.fresh(q.workspaceId, q.rel, q.paneId)
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
    const from = this.existing(q.workspaceId, q.from, q.paneId)
    if (!from.ok) return from
    if (from.target === from.root) return { ok: false, error: 'invalid' }
    const to = this.fresh(q.workspaceId, q.to, q.paneId)
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
    const t = this.existing(q?.workspaceId, q?.rel, q?.paneId)
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
    const t = this.existing(q?.workspaceId, q?.rel, q?.paneId)
    if (!t.ok) return t
    this.deps.reveal(t.target)
    return { ok: true }
  }

  /** Opens an inert format (text, images, PDF) with its app; anything else is only revealed. */
  async openExternal(req: unknown): Promise<FilesOpRes> {
    const q = obj(req)
    const t = this.existing(q?.workspaceId, q?.rel, q?.paneId)
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

  /**
   * `files:resolveRefs` (app 2.7.0, A9): the `file:line` refs of a pane's
   * terminal, one answer each. Main finds the pane's workspace in its own
   * config; a pane run through a connection profile shows another machine's
   * paths, so nothing of it resolves. A malformed request answers [].
   */
  resolveRefs(req: unknown): FileRefResolved[] {
    const q = obj(req)
    if (!q || !isId(q.paneId) || !Array.isArray(q.refs) || q.refs.length > FILE_REFS_MAX) return []
    const refs: ParsedRef[] = []
    for (const raw of q.refs) {
      const p = parseRef(raw)
      if (!p) return []
      refs.push(p)
    }
    const scope = this.refScope(q.paneId)
    return refs.map((p) => this.resolveRef(scope, p))
  }

  /** The root a pane's refs resolve in and the folder relative ones start from, or null. */
  private refScope(paneId: string): { root: string; spelled: string; base: string } | null {
    let ws: Workspace | undefined
    let pane: Pane | undefined
    for (const w of this.deps.config()?.workspaces ?? []) {
      pane = (w.panes ?? []).find((p) => p.id === paneId)
      if (pane) {
        ws = w
        break
      }
    }
    // Same precedence as the launch: setupId '' (a resumed history console) runs local.
    if (!ws || !pane || (pane.setupId ?? ws.setupId)) return null
    const r = this.root(ws.id, paneId)
    if (!r.ok) return null
    // The folder node-pty started the shell in; the root when there is no live shell.
    let base = r.root
    const spawn = this.deps.spawnCwd?.(paneId)
    if (typeof spawn === 'string' && isAbsolute(spawn)) {
      try {
        base = realpathSync.native(spawn)
      } catch {
        base = resolve(spawn)
      }
    }
    return { root: r.root, spelled: resolve(r.spelled), base }
  }

  private resolveRef(scope: { root: string; spelled: string; base: string } | null, p: ParsedRef): FileRefResolved {
    const pos = { ...(p.line ? { line: p.line } : {}), ...(p.col ? { col: p.col } : {}) }
    const no: FileRefResolved = { ref: p.ref, exists: false, ...pos }
    if (!scope || !p.path) return no
    let raw = p.path
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(raw)) return no
    // A colon past the drive is an NTFS stream (or another drive's relative path), never a file of the tree.
    if (this.win && raw.indexOf(':', 2) !== -1) return no
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) raw = (this.deps.homedir ?? osHomedir)() + raw.slice(1)
    const lexical = isAbsolute(raw) ? resolve(raw) : resolve(scope.base, raw)
    // Spelled containment first: a path out of the root (a UNC share among them) is never touched.
    if (!isInside(scope.root, lexical, this.win) && !isInside(scope.spelled, lexical, this.win)) return no
    let target: string
    try {
      target = realpathSync.native(lexical)
    } catch {
      return no
    }
    if (!isInside(scope.root, target, this.win)) return no
    const segs = this.realRel(scope.root, target)
    if (segs.some((seg) => seg.toLowerCase() === '.git')) return no
    const rel = segs.join('/')
    // Exactly what files:* opens with this rel (existing() resolves it to the same target).
    if (!rel || !isSafeRel(rel)) return no
    try {
      if (!statSync(target).isFile()) return no
    } catch {
      return no
    }
    return { ref: p.ref, exists: true, path: target, rel, ...pos }
  }

  /** The drawer on screen watches one folder: a workspace's, or one of its panes' (null: stop). Changes go out per folder, gathered for 250 ms. */
  watch(workspaceId: unknown, paneId?: unknown): void {
    // Only an id: `w#p` spelled as a workspace id would name a pane's watch.
    const id = isId(workspaceId) ? workspaceId : null
    const pane = paneArg(paneId)
    const key = id !== null && pane.ok ? watchKey(id, pane.paneId) : null
    if (key !== null && this.localWatch === key && this.watchers.get(key)?.owners.has('local')) return
    this.unwatch()
    if (id === null || !pane.ok) return
    if (this.acquire(id, pane.paneId, 'local', (evt) => this.deps.emit(evt))) this.localWatch = key
  }

  /** The drawer's watch stops (window closing, drawer gone). */
  unwatch(): void {
    const key = this.localWatch
    this.localWatch = null
    if (key !== null) this.release(key, 'local')
  }

  /**
   * Another reader of a workspace folder (a share grant whose guests have the
   * Files drawer open). One watch per folder whoever holds it; false when the
   * folder has no root or FILES_WATCH_MAX folders are watched already.
   */
  acquireWatch(workspaceId: string, owner: string, cb: (evt: FilesChangedEvt) => void): boolean {
    return this.acquire(workspaceId, undefined, owner, cb)
  }

  /** One watch per tree (a workspace's, or a pane's keyed `workspaceId#paneId`) whoever holds it. */
  private acquire(workspaceId: string, paneId: string | undefined, owner: string, cb: (evt: FilesChangedEvt) => void): boolean {
    // Ids only, so a `w#p` workspace id never joins (or releases) a pane's watch.
    if (!isId(workspaceId) || (paneId !== undefined && !isId(paneId))) return false
    const key = watchKey(workspaceId, paneId)
    const cur = this.watchers.get(key)
    if (cur) {
      cur.owners.set(owner, cb)
      return true
    }
    if (this.watchers.size >= FILES_WATCH_MAX) return false
    const r = this.root(workspaceId, paneId)
    if (!r.ok) return false
    const onEvent = (name: string | null): void => {
      const w = this.watchers.get(key)
      if (!w) return
      const rel = name == null ? null : name.replace(/\\/g, '/').replace(/^\/+/, '')
      if (rel !== null && inGitDir(rel)) return
      w.dirs.add(rel === null ? '*' : parentRel(rel))
      if (w.timer) return
      w.timer = setTimeout(() => this.flushWatch(key), FILES_WATCH_DEBOUNCE_MS)
    }
    const handle = (this.deps.watchRoot ?? defaultWatchRoot(this.deps.platform ?? process.platform))(r.root, onEvent, () => this.closeWatch(key))
    if (!handle) return false
    this.watchers.set(key, { workspaceId, ...(paneId ? { paneId } : {}), handle, timer: null, dirs: new Set(), owners: new Map([[owner, cb]]) })
    return true
  }

  releaseWatch(workspaceId: string, owner: string): void {
    this.release(workspaceId, owner)
  }

  private release(key: string, owner: string): void {
    const w = this.watchers.get(key)
    if (!w || !w.owners.delete(owner) || w.owners.size > 0) return
    this.closeWatch(key)
  }

  /** Folders watched now (tests). */
  get watchedCount(): number {
    return this.watchers.size
  }

  private closeWatch(key: string): void {
    const w = this.watchers.get(key)
    if (!w) return
    this.watchers.delete(key)
    if (this.localWatch === key) this.localWatch = null
    if (w.timer) clearTimeout(w.timer)
    w.handle.close()
  }

  private flushWatch(key: string): void {
    const w = this.watchers.get(key)
    if (!w) return
    w.timer = null
    const dirs = [...w.dirs]
    w.dirs.clear()
    if (!dirs.length) return
    const all = dirs.includes('*') || dirs.length > FILES_WATCH_MAX_DIRS
    const evt: FilesChangedEvt = { workspaceId: w.workspaceId, ...(w.paneId ? { paneId: w.paneId } : {}), dirs: all ? [] : dirs, ...(all ? { all: true } : {}) }
    for (const cb of [...w.owners.values()]) {
      try {
        cb(evt)
      } catch {
        /* one reader failing never stops the others */
      }
    }
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
