/**
 * Recursive directory watch for the git chip (refs/heads, refs/remotes).
 *
 * `fs.watch(dir, { recursive: true })` is native only on Windows and macOS.
 * On Linux Node emulates it in JavaScript with one watcher per file and per
 * directory, synchronous scans on the main thread and a prefix based unwatch
 * that drops siblings sharing a name prefix (refs/heads/sn and
 * refs/heads/sn-old); on other platforms it may throw. A refs tree can hold
 * thousands of branch files, so off Windows and macOS the chip watches
 * directories only: one non-recursive watcher per directory, at most
 * TREE_MAX_DIRS, picking up a new subdirectory when its parent reports it.
 * Every event is reported with its name relative to the root, '/' separated,
 * like the native recursive watch does.
 */
import { readdirSync, statSync, watch as fsWatch } from 'fs'
import { join } from 'path'

export const TREE_MAX_DIRS = 256

export interface TreeWatchHandle {
  close(): void
}

export interface TreeWatchDeps {
  /** Non-recursive watch of one directory; null when it can't watch. */
  watch: (dir: string, onEvent: (name: string | null) => void, onError: () => void) => TreeWatchHandle | null
  /** Names of the subdirectories of `dir` (throws or returns [] when it is gone). */
  listDirs: (dir: string) => string[]
  isDir: (p: string) => boolean
  join: (a: string, b: string) => string
}

/** Whether this platform's fs.watch is natively recursive. */
export function nativeRecursiveWatch(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

const nodeTreeDeps: TreeWatchDeps = {
  watch: (dir, onEvent, onError) => {
    try {
      const w = fsWatch(dir, { persistent: false }, (_ev, name) => onEvent(name == null ? null : String(name)))
      w.on('error', onError)
      return w
    } catch {
      return null
    }
  },
  listDirs: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  join,
}

/**
 * Watch `root` and its subdirectories without a recursive fs.watch. Null when
 * the root itself can't be watched (the caller treats it like a failed watch).
 */
export function watchDirTree(
  root: string,
  onEvent: (name: string | null) => void,
  onError: () => void,
  deps: TreeWatchDeps = nodeTreeDeps,
): TreeWatchHandle | null {
  const handles = new Map<string, TreeWatchHandle>()
  let closed = false
  const absOf = (rel: string): string => (rel ? deps.join(root, rel) : root)
  // Whole segments only: dropping heads/sn must keep heads/sn-old.
  const under = (rel: string, dir: string): boolean => !dir || rel === dir || rel.startsWith(`${dir}/`)

  const drop = (dir: string): void => {
    for (const [rel, h] of [...handles]) {
      if (!under(rel, dir)) continue
      handles.delete(rel)
      h.close()
    }
  }

  const add = (rel: string): void => {
    if (closed || handles.has(rel) || handles.size >= TREE_MAX_DIRS) return
    const h = deps.watch(
      absOf(rel),
      (name) => onDirEvent(rel, name),
      () => onDirError(rel),
    )
    if (!h) return
    handles.set(rel, h)
    let kids: string[] = []
    try {
      kids = deps.listDirs(absOf(rel))
    } catch {
      kids = []
    }
    for (const k of kids) add(rel ? `${rel}/${k}` : k)
  }

  const onDirEvent = (dir: string, name: string | null): void => {
    if (closed) return
    if (name == null) {
      onEvent(dir || null)
      return
    }
    const rel = dir ? `${dir}/${name.replace(/\\/g, '/')}` : name.replace(/\\/g, '/')
    if (deps.isDir(absOf(rel))) add(rel)
    else if (handles.has(rel)) drop(rel)
    onEvent(rel)
  }

  const onDirError = (dir: string): void => {
    if (closed) return
    drop(dir)
    if (!dir) {
      closed = true
      onError()
    }
  }

  add('')
  if (!handles.has('')) return null
  return {
    close() {
      closed = true
      for (const h of handles.values()) h.close()
      handles.clear()
    },
  }
}
