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
}

const entrySchema = z.object({
  path: z.string().min(1).max(4096),
  branch: z.string().regex(WORKTREE_BRANCH_RE),
  repoRoot: z.string().min(1).max(4096),
  baseRef: z.string().max(128).catch('HEAD'),
  baseSha: z.string().regex(/^(?:[0-9a-f]{7,64})?$/i).catch(''),
  linkedPaths: z.array(z.string().max(4096)).max(16).catch([]),
  root: z.string().max(4096).catch(''),
  createdAt: z.number().catch(0),
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

  constructor(
    readonly file: string,
    private readonly fsx: ManifestFs = nodeFs,
  ) {}

  private load(): ManifestEntry[] {
    if (this.entries) return this.entries
    let list: ManifestEntry[] = []
    try {
      const raw = JSON.parse(this.fsx.readFileSync(this.file, 'utf8')) as { version?: unknown; entries?: unknown }
      if (raw && raw.version === MANIFEST_VERSION && Array.isArray(raw.entries)) {
        for (const item of raw.entries) {
          const r = entrySchema.safeParse(item)
          if (r.success) list.push(r.data)
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

  /** The entry for this path, compared like the filesystem does (case-insensitive on Windows). */
  find(path: string): ManifestEntry | null {
    const key = pathKey(path)
    const hit = this.load().find((e) => pathKey(e.path) === key)
    return hit ? { ...hit, linkedPaths: [...hit.linkedPaths] } : null
  }

  /** Adds or replaces the entry of `entry.path`. */
  put(entry: ManifestEntry): void {
    const key = pathKey(entry.path)
    const rest = this.load().filter((e) => pathKey(e.path) !== key)
    this.entries = [...rest, { ...entry, linkedPaths: [...entry.linkedPaths] }].slice(-MAX_MANIFEST_ENTRIES)
    this.save()
  }

  remove(path: string): boolean {
    const key = pathKey(path)
    const list = this.load()
    const next = list.filter((e) => pathKey(e.path) !== key)
    if (next.length === list.length) return false
    this.entries = next
    this.save()
    return true
  }
}
