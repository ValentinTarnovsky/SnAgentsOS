/**
 * Write locks of the trees team runs work in (app 2.7.0, E10 B4, design 3.6):
 * one holder per tree key, across every team. A run whose effective profile
 * writes holds the key of its cwd from its admission to its end; an Integrar
 * holds its temp tree, the task worktree and, while landing, the repo root
 * (holder `integrate:<taskId>`, B6). Memory only: a restart finds no run alive.
 *
 * Release is compare-and-clear (only while the same holder still has it), so
 * a late release of an ended run never frees a key someone else took since.
 */
import { canonicalPath, type RealpathFn } from '../git/canonicalPath'
import { pathKey } from '../migration/pathUtil'

/** Holders of an Integrar start with this (design 3.7). */
export const INTEGRATE_HOLDER_PREFIX = 'integrate:'
/** Path -> key entries kept before the cache starts over (a team has a handful of trees). */
const KEY_CACHE_MAX = 2000

export interface WriteLocksDeps {
  platform: NodeJS.Platform
  /** Spawn cwds of the precise consoles in working | action (a human writing there). */
  humanWriters: () => string[]
  /** Test seam over fs.realpathSync.native (canonicalPath). */
  realpath?: RealpathFn
}

export class WriteLocks {
  private readonly held = new Map<string, string>()
  private readonly keys = new Map<string, string>()

  constructor(private readonly deps: WriteLocksDeps) {}

  /** The comparable key of a tree: git's spelling of the path (canonicalPath), case-folded where the filesystem folds it. */
  key(path: string): string {
    let k = this.keys.get(path)
    if (k === undefined) {
      k = pathKey(canonicalPath(path, this.deps.realpath), this.deps.platform)
      if (this.keys.size >= KEY_CACHE_MAX) this.keys.clear()
      this.keys.set(path, k)
    }
    return k
  }

  /** Every key held now, by any holder (runs and integrates). */
  writerKeys(): Set<string> {
    return new Set(this.held.keys())
  }

  /** Keys an Integrar holds (DispatchFacts.integrateCwds). */
  integrateKeys(): Set<string> {
    const out = new Set<string>()
    for (const [k, h] of this.held) if (h.startsWith(INTEGRATE_HOLDER_PREFIX)) out.add(k)
    return out
  }

  holderOf(key: string): string | null {
    return this.held.get(key) ?? null
  }

  /** Keys of `trees` a human console writes in: its cwd is the tree, inside it, or holds it (either direction). */
  busyKeys(trees: readonly string[]): Set<string> {
    const out = new Set<string>()
    if (trees.length === 0) return out
    let humans: string[]
    try {
      humans = this.deps.humanWriters().filter((p) => typeof p === 'string' && p !== '').map((p) => this.key(p))
    } catch {
      humans = []
    }
    if (humans.length === 0) return out
    for (const t of trees) {
      const k = this.key(t)
      if (humans.some((h) => h === k || this.inside(h, k) || this.inside(k, h))) out.add(k)
    }
    return out
  }

  /** True when `path` is the tree `tree` or inside it, compared by key (B close: a console in a task worktree). */
  within(path: string, tree: string): boolean {
    const k = this.key(path)
    const t = this.key(tree)
    return k === t || this.inside(k, t)
  }

  /** Takes `key` for `holder`; false while another holder has it (the same holder again is a no-op true). */
  acquire(key: string, holder: string): boolean {
    const cur = this.held.get(key)
    if (cur !== undefined && cur !== holder) return false
    this.held.set(key, holder)
    return true
  }

  /** Compare-and-clear: only while `holder` still has it. */
  release(key: string, holder: string): void {
    if (this.held.get(key) === holder) this.held.delete(key)
  }

  releaseAll(holder: string): void {
    for (const [k, h] of [...this.held]) if (h === holder) this.held.delete(k)
  }

  /** Every run holder goes (a teardown: no run lives past it); an Integrar in flight keeps its keys. */
  releaseRuns(): void {
    for (const [k, h] of [...this.held]) if (!h.startsWith(INTEGRATE_HOLDER_PREFIX)) this.held.delete(k)
  }

  get size(): number {
    return this.held.size
  }

  /** Key `child` strictly below key `parent`. */
  private inside(child: string, parent: string): boolean {
    const sep = this.deps.platform === 'win32' ? '\\' : '/'
    const base = parent.endsWith(sep) ? parent : parent + sep
    return child !== parent && child.startsWith(base)
  }
}
