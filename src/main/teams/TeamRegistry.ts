import { createHash } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { TEAM_ID_RE, TEAM_TRASH_TTL_MS } from '@shared/teams'
import { writeAtomicSync } from '../fsAtomic'
import type { GitRunner } from '../git/gitExec'
import { canonicalPath } from '../git/canonicalPath'
import { normTrustPath } from '../repoConfig/TrustStore'

/** One registered team (`dataDir()/teams/index.json`). */
export interface TeamIndexEntry {
  id: string
  /** The git main root, canonical (git's spelling). */
  repoRoot: string
  name: string
  /** Branch at setup: the fallback base when team.md names none. */
  baseBranch: string
  createdAt: number
}

interface IndexFile {
  v: 1
  teams: TeamIndexEntry[]
}

/** The calls of the trash move; a test fake can make the rename fail. */
export interface RegistryFs {
  mkdirSync(p: string, o: { recursive: true }): unknown
  renameSync(from: string, to: string): void
}

const DELETED_TEAM_RE = /^tm-[a-f0-9]{12}-(\d{13,})$/
const NOTE_TRASH_FILE_RE = /-(\d{13,})\.md$/

function validEntry(e: unknown): e is TeamIndexEntry {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return (
    typeof r.id === 'string' && TEAM_ID_RE.test(r.id) &&
    typeof r.repoRoot === 'string' && r.repoRoot.length > 0 && isAbsolute(r.repoRoot) &&
    typeof r.name === 'string' && typeof r.baseBranch === 'string' &&
    typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
  )
}

/**
 * The registry of teams (app 2.7.0, E10 B1): `dataDir()/teams/index.json`
 * `{v:1, teams}`, read on first use and written synchronously (tmp + rename,
 * UTF-8 without BOM) on every change. A missing or corrupt file registers
 * nothing; the team folders stay on disk untouched. A file that cannot be
 * read right now (EBUSY, EACCES...) throws and is read again on the next
 * call: an empty list is never cached for it, so a put() never rewrites it.
 */
export class TeamRegistry {
  private entries: TeamIndexEntry[] | null = null
  private readonly now: () => number
  private readonly fs: RegistryFs

  constructor(private readonly o: { file: () => string; trashDir: () => string; now?: () => number; log?: (line: string) => void; fs?: RegistryFs }) {
    this.now = o.now ?? Date.now
    this.fs = o.fs ?? { mkdirSync, renameSync }
  }

  private load(): TeamIndexEntry[] {
    if (this.entries) return this.entries
    let text: string | null = null
    try {
      text = readFileSync(this.o.file(), 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.o.log?.(`registry read failed ${code ?? 'error'}`)
        throw err
      }
    }
    const out: TeamIndexEntry[] = []
    if (text !== null) {
      try {
        const raw = JSON.parse(text) as Partial<IndexFile>
        const seen = new Set<string>()
        for (const e of Array.isArray(raw?.teams) ? raw.teams : []) {
          if (!validEntry(e) || seen.has(e.id)) continue
          seen.add(e.id)
          out.push({ id: e.id, repoRoot: e.repoRoot, name: e.name, baseBranch: e.baseBranch, createdAt: e.createdAt })
        }
      } catch {
        // Corrupt: registers nothing.
      }
    }
    this.entries = out
    return out
  }

  list(): TeamIndexEntry[] {
    return [...this.load()]
  }

  get(id: string): TeamIndexEntry | null {
    return this.load().find((e) => e.id === id) ?? null
  }

  /** Adds or replaces the entry with that id. */
  put(e: TeamIndexEntry): void {
    const next = this.load().filter((x) => x.id !== e.id)
    next.push({ ...e })
    this.entries = next
    this.write()
  }

  /**
   * Moves `teams/<id>` to `teams/.trash/<id>-<ts>` and removes the entry. A
   * move that fails (anything but a folder that is not there: EPERM, EBUSY
   * from an antivirus or an indexer) keeps the entry and answers false: the
   * id is the same for that repo, so a re-added team would pick the old
   * state up again.
   */
  trash(id: string): boolean {
    if (!TEAM_ID_RE.test(id)) return false
    const dir = join(dirname(this.o.file()), id)
    try {
      this.fs.mkdirSync(this.o.trashDir(), { recursive: true })
      this.fs.renameSync(dir, join(this.o.trashDir(), `${id}-${this.now()}`))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.o.log?.(`registry trash ${id} failed ${code ?? 'error'}`)
        return false
      }
    }
    this.entries = this.load().filter((x) => x.id !== id)
    this.write()
    return true
  }

  /**
   * Purges `.trash` entries older than TEAM_TRASH_TTL_MS by explicit shapes
   * only: folders `tm-<12 hex>-<stamp>` (deleted teams), and inside a folder
   * `tm-<12 hex>` (the team notes trash) files `-<stamp>.md`. Anything else is
   * left alone: never a whole note-trash folder, never an unknown name.
   */
  purge(): void {
    const root = this.o.trashDir()
    const cutoff = this.now() - TEAM_TRASH_TTL_MS
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(root, name)
      const team = DELETED_TEAM_RE.exec(name)
      try {
        if (team) {
          if (Number(team[1]) < cutoff) rmSync(p, { recursive: true, force: true })
          continue
        }
        if (!TEAM_ID_RE.test(name)) continue
        for (const f of readdirSync(p)) {
          const stamp = NOTE_TRASH_FILE_RE.exec(f)
          if (stamp && Number(stamp[1]) < cutoff) rmSync(join(p, f), { force: true })
        }
      } catch {
        /* busy or gone: next purge */
      }
    }
  }

  private write(): void {
    const file = this.o.file()
    const body: IndexFile = { v: 1, teams: this.entries ?? [] }
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeAtomicSync(file, JSON.stringify(body, null, 2) + '\n')
    } catch (err) {
      this.o.log?.(`registry write failed ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
    }
  }
}

/** `'tm-' + sha256(normTrustPath(mainRoot)).slice(0, 12)` (plan 3.1): one id per repo, stable across spellings of a case-insensitive disk. */
export function teamIdOf(mainRoot: string, platform: NodeJS.Platform = process.platform): string {
  return 'tm-' + createHash('sha256').update(normTrustPath(mainRoot, platform)).digest('hex').slice(0, 12)
}

/**
 * The git main root of the repo `dir` belongs to, canonical (git's spelling):
 * a linked worktree resolves to its main checkout. The same steps as
 * WorktreeService.resolveRepo (`--show-toplevel`, then `--git-common-dir`
 * resolved against it), which work on every supported git; a common dir not
 * named `.git` (a submodule) keeps the top level. Bare, not git or a git
 * failure -> null.
 */
export async function resolveMainRoot(git: GitRunner, dir: string): Promise<string | null> {
  try {
    const top = canonicalPath((await git.run(['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 })).trim())
    if (!top || !isAbsolute(top)) return null
    // Not canonicalPath on .git itself: a .git that is a link must still read as .git.
    const common = resolve(top, (await git.run(['rev-parse', '--git-common-dir'], { cwd: top, timeoutMs: 10_000 })).trim())
    if (basename(common).toLowerCase() !== '.git') return top
    return canonicalPath(dirname(common))
  } catch {
    return null
  }
}
