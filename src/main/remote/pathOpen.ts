/**
 * `shell:openPath` (E2-FR-30): a path the phone tapped in a terminal, opened
 * or revealed on the PC. The renderer resolves the root from its own store
 * (the pane's launch cwd, then the workspace's); main never trusts the phone
 * and re-checks everything here:
 *
 *  - the root goes through realpathSync.native ('' = home, like PtyManager);
 *  - `:line:col` is dropped, the path resolves against the root and must stay
 *    inside it lexically (denied_path), exist (not_found) and still be inside
 *    after realpath, so a junction or symlink that leaves the root is denied;
 *  - only an inert extension (shared INERT_OPEN_EXTENSIONS) under a normal
 *    root is opened with shell.openPath; everything else, and every path when
 *    the root is the home folder or a drive root, is revealed with
 *    shell.showItemInFolder;
 *  - one open or reveal per second in total (rate). A denied or missing path
 *    does not spend the budget, so the renderer's retry with the workspace
 *    root goes through.
 */
import { realpathSync, statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { isAbsolute, parse, resolve } from 'node:path'
import {
  OPEN_PATH_MAX,
  isInertOpenPath,
  stripLineCol,
  type OpenPathRes,
} from '@shared/inertOpen'

/** Minimum gap between two opens or reveals (all devices together). */
export const OPEN_PATH_RATE_MS = 1000

export type RootKind = 'home' | 'drive' | 'normal'

export interface PathOpenDeps {
  openPath(target: string): Promise<string>
  showItemInFolder(target: string): void
  homedir?: () => string
  now?: () => number
  platform?: NodeJS.Platform
}

function realpath(p: string): string {
  return realpathSync.native(p)
}

function samePath(a: string, b: string, win: boolean): boolean {
  return win ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** True when `target` is `root` itself or inside it (no prefix confusion). */
export function isInside(root: string, target: string, win = process.platform === 'win32'): boolean {
  if (samePath(root, target, win)) return true
  const sp = win ? '\\' : '/'
  const base = root.endsWith(sp) || root.endsWith('/') ? root : root + sp
  return win ? target.toLowerCase().startsWith(base.toLowerCase()) : target.startsWith(base)
}

/** 'home' for the (real) home folder, 'drive' for a filesystem root, else 'normal'. */
export function classifyRoot(root: string, home: string, win = process.platform === 'win32'): RootKind {
  let realHome = home
  try {
    realHome = realpath(home)
  } catch {
    /* compare against the plain path */
  }
  if (samePath(root, realHome, win)) return 'home'
  if (/^[A-Za-z]:[\\/]?$/.test(root) || root === '/' || parse(root).root === root) return 'drive'
  return 'normal'
}

export type ValidatedPath =
  | { ok: true; root: string; target: string; rootKind: RootKind }
  | { ok: false; error: 'denied_path' | 'not_found' }

/**
 * Resolve `raw` against `cwd` and check containment before and after realpath.
 * An unresolvable root answers denied_path (the renderer then retries with the
 * workspace root).
 */
export function validatePath(cwd: string, raw: string, home: string, win = process.platform === 'win32'): ValidatedPath {
  let root: string
  try {
    root = realpath(cwd || home)
  } catch {
    return { ok: false, error: 'denied_path' }
  }
  let p = stripLineCol(raw.trim()).replace(/^(['"])(.*)\1$/, '$2')
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = home + p.slice(1)
  if (!p) return { ok: false, error: 'not_found' }
  const lexical = resolve(root, p)
  // The spelled root too: an absolute path through a junction alias of cwd.
  const spelled = isAbsolute(cwd) ? resolve(cwd) : root
  if (!isInside(root, lexical, win) && !isInside(spelled, lexical, win)) return { ok: false, error: 'denied_path' }
  let target: string
  try {
    target = realpath(lexical)
  } catch {
    return { ok: false, error: 'not_found' }
  }
  if (!isInside(root, target, win)) return { ok: false, error: 'denied_path' }
  return { ok: true, root, target, rootKind: classifyRoot(root, home, win) }
}

/** The `shell:openPath` handler body, with Electron's shell injected. */
export function createPathOpener(deps: PathOpenDeps): (req: unknown) => Promise<OpenPathRes> {
  const now = deps.now ?? Date.now
  const home = deps.homedir ?? osHomedir
  const win = (deps.platform ?? process.platform) === 'win32'
  let last = -Infinity
  return async (req) => {
    const r = (req ?? {}) as { cwd?: unknown; path?: unknown }
    if (typeof r.cwd !== 'string' || typeof r.path !== 'string') return { ok: false, error: 'bad_request' }
    if (r.cwd.length > OPEN_PATH_MAX || !r.path.trim() || r.path.length > OPEN_PATH_MAX) return { ok: false, error: 'bad_request' }
    if (now() - last < OPEN_PATH_RATE_MS) return { ok: false, error: 'rate' }
    const v = validatePath(r.cwd, r.path, home(), win)
    if (!v.ok) return { ok: false, error: v.error }
    last = now()
    let isFile = false
    try {
      isFile = statSync(v.target).isFile()
    } catch {
      return { ok: false, error: 'not_found' }
    }
    if (isFile && v.rootKind === 'normal' && isInertOpenPath(v.target)) {
      // openPath resolves with an error string ('' = opened); no handler -> reveal.
      const err = await deps.openPath(v.target).catch((e: unknown) => String(e))
      if (!err) return { ok: true }
    }
    deps.showItemInFolder(v.target)
    return { ok: true }
  }
}
