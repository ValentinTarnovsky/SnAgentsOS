/**
 * dataDir()/worktrees.json (E7 Design F): the worktrees the app created, or
 * adopted after validating them. Main's source of truth for `remove` (only a
 * listed path may ever be deleted) and for the orphan list. The renderer
 * never sees this file; `pane.worktree` is only a mirror of four fields.
 *
 * Small and rarely written, so every change is written at once: atomic
 * tmp + rename, like agent-sessions.json. A corrupt or foreign file reads as
 * empty and invalid entries are dropped one by one.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { WORKTREE_BRANCH_RE } from '@shared/worktree-types'
import { pathKey } from '../migration/pathUtil'
import { canonicalPath, type RealpathFn } from './canonicalPath'

export const MANIFEST_VERSION = 1
/** Hard cap: far above what a person creates, keeps the file small. */
export const MAX_MANIFEST_ENTRIES = 500

export interface ManifestEntry {
  path: string
  branch: string
  repoRoot: string
  /** 'HEAD' or the commit the request named. */
  baseRef: string
  /** Full sha of the base commit; '' for an adopted orphan whose base is unknown. */
  baseSha: string
  /** Junctions this app created, absolute, each a direct child of `path`. */
  linkedPaths: string[]
  /** Worktree root in force when it was created (a later root change keeps it removable). */
  root: string
  createdAt: number
  /**
   * app 2.7.0 (E10 B4, decision 63): a team task worktree, `team:<teamId>:<gen>:<taskId>`. Set only by main
   * (TaskWorktrees); never offered as an orphan, and removed only by that owner. Absent for a console's own.
   */
  owner?: string
}

/** What an owner may look like (teamWorktreeOwner); anything else is dropped at load, the entry kept. */
const OWNER_RE = /^team:tm-[a-f0-9]{12}:[a-f0-9]{8}:t-[0-9]{1,5}$/

const entrySchema = z.object({
  path: z.string().min(1).max(4096),
  branch: z.string().regex(WORKTREE_BRANCH_RE),
  repoRoot: z.string().min(1).max(4096),
  baseRef: z.string().max(128).catch('HEAD'),
  baseSha: z.string().regex(/^(?:[0-9a-f]{7,64})?$/i).catch(''),
  linkedPaths: z.array(z.string().max(4096)).max(16).catch([]),
  root: z.string().max(4096).catch(''),
  createdAt: z.number().catch(0),
  owner: z.string().regex(OWNER_RE).optional().catch(undefined),
})

export interface ManifestFs {
  readFileSync: (p: string, enc: 'utf8') => string
  writeFileSync: (p: string, data: string, enc: 'utf8') => void
  renameSync: (a: string, b: string) => void
  mkdirSync: (p: string, o: { recursive: true }) => unknown
}

const nodeFs: ManifestFs = { readFileSync, writeFileSync, renameSync, mkdirSync }

export class WorktreeManifest {
  private entries: ManifestEntry[] | null = null
  /** Path as written -> comparable key; a manifest holds at most 500 paths. */
  private readonly keys = new Map<string, string>()

  constructor(
    readonly file: string,
    private readonly fsx: ManifestFs = nodeFs,
    private readonly realpath?: RealpathFn,
  ) {}

  /**
   * Paths compare in git's spelling (canonicalPath), case-insensitive where
   * the filesystem is: an entry written as C:\Users\RUNNER~1\... (or by a
   * version that kept the settings' spelling) is the same folder as the
   * C:\Users\runneradmin\... that git and the service use.
   */
  private key(p: string): string {
    let k = this.keys.get(p)
    if (k === undefined) {
      k = pathKey(canonicalPath(p, this.realpath))
      if (this.keys.size >= MAX_MANIFEST_ENTRIES * 4) this.keys.clear()
      this.keys.set(p, k)
    }
    return k
  }

  private load(): ManifestEntry[] {
    if (this.entries) return this.entries
    let list: ManifestEntry[] = []
    try {
      const raw = JSON.parse(this.fsx.readFileSync(this.file, 'utf8')) as { version?: unknown; entries?: unknown }
      if (raw && raw.version === MANIFEST_VERSION && Array.isArray(raw.entries)) {
        for (const item of raw.entries) {
          const r = entrySchema.safeParse(item)
          if (!r.success) continue
          const e: ManifestEntry = r.data
          if (e.owner === undefined) delete e.owner
          list.push(e)
        }
      }
    } catch {
      list = []
    }
    this.entries = list.slice(0, MAX_MANIFEST_ENTRIES)
    return this.entries
  }

  private save(): void {
    const body = JSON.stringify({ version: MANIFEST_VERSION, entries: this.load() }, null, 2)
    this.fsx.mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    this.fsx.writeFileSync(tmp, body, 'utf8')
    this.fsx.renameSync(tmp, this.file)
  }

  list(): ManifestEntry[] {
    return this.load().map((e) => ({ ...e, linkedPaths: [...e.linkedPaths] }))
  }

  /** The entry for this path, compared like the filesystem does (any spelling of the folder, case-insensitive on Windows and macOS). */
  find(path: string): ManifestEntry | null {
    const key = this.key(path)
    const hit = this.load().find((e) => this.key(e.path) === key)
    return hit ? { ...hit, linkedPaths: [...hit.linkedPaths] } : null
  }

  /** Adds or replaces the entry of `entry.path`. */
  put(entry: ManifestEntry): void {
    const key = this.key(entry.path)
    const rest = this.load().filter((e) => this.key(e.path) !== key)
    this.entries = [...rest, { ...entry, linkedPaths: [...entry.linkedPaths] }].slice(-MAX_MANIFEST_ENTRIES)
    this.save()
  }

  remove(path: string): boolean {
    const key = this.key(path)
    const list = this.load()
    const next = list.filter((e) => this.key(e.path) !== key)
    if (next.length === list.length) return false
    this.entries = next
    this.save()
    return true
  }

  /** The entry an owner holds (decision 63: a team task's worktree), else null. */
  ownedBy(owner: string): ManifestEntry | null {
    if (!owner) return null
    const hit = this.load().find((e) => e.owner === owner)
    return hit ? { ...hit, linkedPaths: [...hit.linkedPaths] } : null
  }

  /** The entry of `path` loses its owner when it is exactly `owner` (a stale tree of a task that got a new one); whether it did. */
  disownAt(path: string, owner: string): boolean {
    if (!owner) return false
    const key = this.key(path)
    let hit = false
    this.entries = this.load().map((e) => {
      if (e.owner !== owner || this.key(e.path) !== key) return e
      hit = true
      const next = { ...e }
      delete next.owner
      return next
    })
    if (hit) this.save()
    return hit
  }

  /** Every entry whose owner starts with `prefix` loses it (a removed team: its trees become ordinary orphans); how many. */
  disown(prefix: string): number {
    if (!prefix) return 0
    let n = 0
    this.entries = this.load().map((e) => {
      if (e.owner === undefined || !e.owner.startsWith(prefix)) return e
      n++
      const next = { ...e }
      delete next.owner
      return next
    })
    if (n > 0) this.save()
    return n
  }
}
