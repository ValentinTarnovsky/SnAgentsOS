/**
 * The Files drawer of a workspace (v2.2, E9): its folder as a tree with a
 * code editor. Main resolves every request against the workspace's folder
 * (`ws.cwd` from the config) and never accepts a path from the renderer: the
 * renderer only names a workspace and a relative path with `/` separators,
 * and main keeps the realpath of every target inside the folder, so a
 * junction or a symlink cannot reach out of it. Pure: no Node, no DOM.
 */

/** Entries listed per folder at most (the rest is `truncated`). */
export const FILES_LIST_MAX = 5000
/** A text file opens for editing up to this many bytes... */
export const FILE_EDIT_MAX = 2 * 1024 * 1024
/** ...read-only up to this, and not at all past it. */
export const FILE_VIEW_MAX = 5 * 1024 * 1024
/** Images show as a preview up to this many bytes. */
export const FILE_IMAGE_MAX = 10 * 1024 * 1024
/** Longest relative path accepted. */
export const FILE_REL_MAX = 1024

/** Images the drawer previews (data URL, img-src data: in the CSP). SVG stays text: it can carry scripts. */
export const FILE_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

export type FilesError = 'no_root' | 'not_found' | 'denied_path' | 'invalid' | 'binary' | 'too_large' | 'conflict' | 'exists' | 'io'

export interface FileEntry {
  name: string
  kind: 'file' | 'dir'
  /** Bytes (0 for a folder). */
  size: number
  mtimeMs: number
  /** A symlink or junction (followed; its target stays inside the folder or it is not listed). */
  link?: boolean
}

export type FilesRootRes = { ok: true; root: string; name: string } | { ok: false; error: FilesError }

export interface FilesListReq {
  workspaceId: string
  /** '' = the workspace folder itself. */
  rel: string
}

export type FilesListRes = { ok: true; entries: FileEntry[]; truncated: boolean } | { ok: false; error: FilesError }

export type FileReadRes =
  | {
      ok: true
      kind: 'text'
      text: string
      /** Line endings of the file on disk; the editor keeps \n and the save restores these. */
      eol: 'lf' | 'crlf'
      bom: boolean
      rev: string
      size: number
      /** Past FILE_EDIT_MAX: shown, never saved. */
      readOnly: boolean
    }
  | { ok: true; kind: 'image'; dataUrl: string; size: number; rev: string }
  | { ok: false; error: FilesError }

export interface FileWriteReq {
  workspaceId: string
  rel: string
  text: string
  eol: 'lf' | 'crlf'
  bom: boolean
  /** The rev the editor loaded; another rev on disk is a conflict. Absent = overwrite. */
  baseRev?: string
}

export type FileWriteRes = { ok: true; rev: string; size: number } | { ok: false; error: FilesError }

export interface FileCreateReq {
  workspaceId: string
  rel: string
  kind: 'file' | 'dir'
}

export interface FileRenameReq {
  workspaceId: string
  from: string
  to: string
}

export type FilesOpRes = { ok: true } | { ok: false; error: FilesError }

/** Main -> renderer: folders of the watched workspace whose content changed ('' = its root). */
export interface FilesChangedEvt {
  workspaceId: string
  dirs: string[]
  /** Too many changes to name: reload everything shown. */
  all?: boolean
}

/** The rev of a file version (mtime and size). */
export function fileRev(mtimeMs: number, size: number): string {
  return `${Math.floor(mtimeMs)}-${size}`
}

/**
 * A relative path as the renderer may send it: `/` separators, no `.` or
 * `..` segment, no empty segment, no drive, no NUL, no leading slash, at most
 * FILE_REL_MAX. '' is the root.
 */
export function isSafeRel(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel.length > FILE_REL_MAX) return false
  if (rel === '') return true
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\:*?"<>|]/.test(rel) || rel.startsWith('/')) return false
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[. ]$/.test(seg))
}

/** A new file or folder name: one segment, the same rules. */
export function isSafeName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 255 && !name.includes('/') && isSafeRel(name) && name !== ''
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

export function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

/** The extension, lower case, without the dot ('' for none). */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** Inside `.git`: listed never, written never. */
export function inGitDir(rel: string): boolean {
  return rel === '.git' || rel.startsWith('.git/')
}
