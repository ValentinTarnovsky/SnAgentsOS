/**
 * Line count of untracked files for the chip's `+N` (E7-FR-10). Bounded so a
 * repo full of logs never stalls a refresh: files up to 1 MB, at most 200
 * files and 8 MB read per run, binaries (a NUL in the first 8 KB) skipped.
 * Results are cached by (path, size, mtimeMs), so an unchanged file is never
 * read twice. Anything left uncounted marks the summary `approx`. Symlinks
 * are not followed (lstat), so an untracked link never reads outside the repo.
 */
import { promises as fsp } from 'fs'
import { join } from 'path'

export const UNTRACKED_MAX_FILES = 200
export const UNTRACKED_MAX_FILE_BYTES = 1024 * 1024
export const UNTRACKED_BUDGET_BYTES = 8 * 1024 * 1024
const BINARY_SNIFF = 8192

export interface UntrackedFs {
  stat(p: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>
  readFile(p: string): Promise<Uint8Array>
}

export interface UntrackedResult {
  lines: number
  approx: boolean
  /** Bytes read from disk in this run (cache hits read nothing). */
  bytesRead: number
}

interface CacheEntry {
  size: number
  mtimeMs: number
  /** null = binary. */
  lines: number | null
}

/** Lines the way `git diff --numstat` counts an added file: a last line without '\n' still counts. */
export function countLines(buf: Uint8Array): number | null {
  const sniff = Math.min(buf.length, BINARY_SNIFF)
  for (let i = 0; i < sniff; i++) if (buf[i] === 0) return null
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++
  if (buf.length > 0 && buf[buf.length - 1] !== 10) n++
  return n
}

export class UntrackedCounter {
  private cache = new Map<string, CacheEntry>()
  private fs: UntrackedFs

  constructor(fs?: UntrackedFs) {
    this.fs = fs ?? { stat: (p) => fsp.lstat(p), readFile: (p) => fsp.readFile(p) }
  }

  /** Cached entries (tests). */
  get size(): number {
    return this.cache.size
  }

  async count(repoRoot: string, relPaths: string[]): Promise<UntrackedResult> {
    let lines = 0
    let approx = relPaths.length > UNTRACKED_MAX_FILES
    let bytesRead = 0
    const seen = new Set<string>()
    for (const rel of relPaths.slice(0, UNTRACKED_MAX_FILES)) {
      const abs = join(repoRoot, rel)
      seen.add(abs)
      let st: { size: number; mtimeMs: number; isFile(): boolean }
      try {
        st = await this.fs.stat(abs)
      } catch {
        continue // gone between status and now
      }
      if (!st.isFile()) continue
      if (st.size > UNTRACKED_MAX_FILE_BYTES) {
        approx = true
        continue
      }
      const hit = this.cache.get(abs)
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        lines += hit.lines ?? 0
        continue
      }
      if (bytesRead + st.size > UNTRACKED_BUDGET_BYTES) {
        approx = true
        continue
      }
      let buf: Uint8Array
      try {
        buf = await this.fs.readFile(abs)
      } catch {
        continue
      }
      bytesRead += buf.length
      const n = countLines(buf)
      this.cache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, lines: n })
      lines += n ?? 0
    }
    // Forget files of this repo that are no longer untracked (committed, deleted, ignored).
    const prefix = join(repoRoot, '/')
    for (const key of this.cache.keys()) if (key.startsWith(prefix) && !seen.has(key)) this.cache.delete(key)
    return { lines, approx, bytesRead }
  }

  /** Drop every cached file under a repo (its target went away). */
  forget(repoRoot: string): void {
    const prefix = join(repoRoot, '/')
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key)
  }
}
