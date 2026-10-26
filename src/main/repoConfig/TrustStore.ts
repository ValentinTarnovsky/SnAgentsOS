import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/** Oldest approvals are dropped past this many repos. */
export const TRUST_MAX_ENTRIES = 500

export interface TrustEntry {
  sha256: string
  approvedAt: number
}

interface TrustFile {
  version: 1
  entries: Record<string, TrustEntry>
}

/**
 * Key of a repo in trusted-repos.json: `path.resolve`, no trailing separator
 * and lower case on Windows (case-insensitive file system).
 */
export function normTrustPath(dir: string, platform: string = process.platform): string {
  let p = resolve(dir)
  while (p.length > 1 && (p.endsWith(sep) || p.endsWith('/')) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1)
  return platform === 'win32' ? p.toLowerCase() : p
}

const SHA_RE = /^[0-9a-f]{64}$/

function parse(raw: unknown): Record<string, TrustEntry> {
  const out: Record<string, TrustEntry> = {}
  if (!raw || typeof raw !== 'object') return out
  const entries = (raw as { entries?: unknown }).entries
  if (!entries || typeof entries !== 'object') return out
  for (const [key, v] of Object.entries(entries as Record<string, unknown>)) {
    const e = v as Partial<TrustEntry> | null
    if (!key || !e || typeof e.sha256 !== 'string' || !SHA_RE.test(e.sha256) || typeof e.approvedAt !== 'number') continue
    out[key] = { sha256: e.sha256, approvedAt: e.approvedAt }
  }
  return out
}

/**
 * Main-owned trust of repo files (E8-FR-24, R30-01 amendment):
 * `dataDir()/trusted-repos.json` = `{ version: 1, entries: { <normPath>: { sha256, approvedAt } } }`.
 * The renderer never writes it and config.json never carries it, so neither
 * a renderer bug nor an imported config can forge an approval. Loaded on
 * first use (after the legacy migration), written atomically on every change.
 * A file that cannot be read right now (EBUSY from an antivirus or an
 * indexer, EACCES...) is never taken as empty (app 2.7.0, B close, as
 * TeamRegistry): nothing is cached for it, nothing reads as trusted, and no
 * write starts from a map that was never read, so one approval never
 * rewrites the file with a single entry.
 */
export class TrustStore {
  private entries: Record<string, TrustEntry> | null = null

  constructor(private readonly opts: { file: () => string; now?: () => number; platform?: string }) {}

  /** The approvals, or null while the file cannot be read (read again on the next call). */
  private tryLoad(): Record<string, TrustEntry> | null {
    if (this.entries) return this.entries
    let text: string
    try {
      text = readFileSync(this.opts.file(), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
      // Missing: nothing is trusted yet.
      this.entries = {}
      return this.entries
    }
    try {
      this.entries = parse(JSON.parse(text))
    } catch {
      // Corrupt: nothing is trusted, every repo asks again.
      this.entries = {}
    }
    return this.entries
  }

  get(dir: string): TrustEntry | null {
    return this.tryLoad()?.[normTrustPath(dir, this.opts.platform)] ?? null
  }

  /** False while the file exists but cannot be read (every `get` answers null then, and no write starts). */
  readable(): boolean {
    return this.tryLoad() !== null
  }

  /** Approve `sha256` for `dir`, replacing any previous hash of that repo. */
  set(dir: string, sha256: string): void {
    if (!SHA_RE.test(sha256) || !this.tryLoad()) return
    this.entries = this.withEntry(dir, sha256)
    this.write()
  }

  /**
   * `set` that reports whether the approval reached the disk (app 2.7.0,
   * Teams): false for a bad hash or a write that did not land, and then the
   * entry in memory is left as it was, so nothing reads as trusted that a
   * restart would forget. Also false while the file cannot be read (B close):
   * a write from a map never read would drop every other approval.
   */
  setChecked(dir: string, sha256: string): boolean {
    if (!SHA_RE.test(sha256)) return false
    const before = this.tryLoad()
    if (!before) return false
    this.entries = this.withEntry(dir, sha256)
    if (this.write()) return true
    this.entries = before
    return false
  }

  /** Forgets the approval of `dir` (a removed team); same write path as `set`. A file that cannot be read keeps it. */
  delete(dir: string): void {
    const key = normTrustPath(dir, this.opts.platform)
    const cur = this.tryLoad()
    if (!cur || !(key in cur)) return
    const entries = { ...cur }
    delete entries[key]
    this.entries = entries
    this.write()
  }

  /** The map plus `dir`'s entry; only called once tryLoad read the file. */
  private withEntry(dir: string, sha256: string): Record<string, TrustEntry> {
    const entries = { ...(this.tryLoad() ?? {}) }
    entries[normTrustPath(dir, this.opts.platform)] = { sha256, approvedAt: (this.opts.now ?? Date.now)() }
    const keys = Object.keys(entries)
    if (keys.length > TRUST_MAX_ENTRIES) {
      keys.sort((a, b) => entries[a].approvedAt - entries[b].approvedAt)
      for (const k of keys.slice(0, keys.length - TRUST_MAX_ENTRIES)) delete entries[k]
    }
    return entries
  }

  private write(): boolean {
    const file = this.opts.file()
    const body: TrustFile = { version: 1, entries: this.entries ?? {} }
    const tmp = `${file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8')
      renameSync(tmp, file)
      return true
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* the folder itself is not writable */
      }
      console.warn(`[repoConfig] could not save trusted repos: ${String(err)}`)
      return false
    }
  }
}
