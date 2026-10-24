import { createHash } from 'crypto'
import { promises as fsp, watch as fsWatch, type FSWatcher, type Stats } from 'fs'
import { join, relative, sep } from 'path'
import {
  canonicalDefText,
  DEF_FILE_MAX_BYTES,
  DEF_FILES_MAX,
  DEF_REL_RE,
  DEF_TOTAL_MAX_BYTES,
  ignoredDefName,
  normalizeDefText,
  parseDefinition,
  TEAM_DIR,
  type DefinitionResult,
} from '@shared/teamDefinition'
import type { DefFile } from '@shared/teams'
import { writeAtomic } from '../fsAtomic'

export interface LoadedDefinition {
  sha256: string
  files: DefFile[]
  result: DefinitionResult
  /** `rel:mtimeMs:size` of every definition file, joined: the cheap "did it move" key. */
  stamp: string
}
export type LoadError = 'missing' | 'too_large' | 'too_many' | 'link' | 'io'
export type LoadRes = LoadedDefinition | { error: LoadError }

/** The fs calls the loader makes; a test fake can replace them. */
export interface LoaderFs {
  lstat(p: string): Promise<Stats>
  readdir(p: string): Promise<string[]>
  readFile(p: string, enc: 'utf8'): Promise<string>
  realpath(p: string): Promise<string>
  mkdir(p: string): Promise<unknown>
}

const nodeFs: LoaderFs = {
  lstat: (p) => fsp.lstat(p),
  readdir: (p) => fsp.readdir(p),
  readFile: (p, enc) => fsp.readFile(p, enc),
  realpath: (p) => fsp.realpath(p),
  mkdir: (p) => fsp.mkdir(p),
}

const SUBDIRS = ['roles', 'routines'] as const

class LoadFail extends Error {
  constructor(readonly code: LoadError) {
    super(code)
  }
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code
}

/** An lstat that reads ENOENT as null and anything else as io. */
async function lstatOrNull(fs: LoaderFs, p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p)
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return null
    throw new LoadFail('io')
  }
}

/** A real directory (no link, no junction), null when absent. */
async function realDir(fs: LoaderFs, p: string): Promise<boolean> {
  const st = await lstatOrNull(fs, p)
  if (!st) return false
  if (st.isSymbolicLink()) throw new LoadFail('link')
  if (!st.isDirectory()) throw new LoadFail('io')
  return true
}

interface Listed {
  rel: string
  abs: string
  size: number
  mtimeMs: number
  /** False for a file of roles/ or routines/ whose name fails DEF_REL_RE: listed by name only. */
  def: boolean
}

/**
 * Reads `<repo>/.snagentsos/team/` (app 2.7.0, E10 B1, design 3.2): lstat
 * only, a link or junction refused at every level, every realpath inside the
 * folder, the caps of teamDefinition.ts (64 files, 64 KB each, 512 KB in all).
 * A file of roles/ or routines/ outside DEF_REL_RE is not part of the
 * definition and is never read nor hashed, but it counts for the 64 and goes
 * to the parser by name with an empty text, so `roles/Dev.md` shows as a
 * `bad_name` warning instead of vanishing. A name starting with "."
 * (`._dev.md`, an editor temp file) is skipped before any lstat: never
 * listed, stamped, counted nor shown. A load is cached per repo by its
 * stamp: the files are re-read and re-hashed only when a name, size or mtime
 * moved.
 */
export class TeamDefinitionLoader {
  private readonly cache = new Map<string, LoadedDefinition>()
  private readonly fs: LoaderFs
  private readonly watchFn: typeof fsWatch

  constructor(o: { fs?: LoaderFs; watch?: typeof fsWatch } = {}) {
    this.fs = o.fs ?? nodeFs
    this.watchFn = o.watch ?? fsWatch
  }

  /** The definition folder of a repo. */
  static dirOf(repoRoot: string): string {
    return join(repoRoot, ...TEAM_DIR.split('/'))
  }

  /**
   * True only for a real directory: absent, a link, a junction, a file or an
   * lstat error read false. The reveal op opens nothing else (a file or a link
   * the repo put there could be run by the OS file opener).
   */
  async isRealDir(p: string): Promise<boolean> {
    try {
      const st = await this.fs.lstat(p)
      return st.isDirectory() && !st.isSymbolicLink()
    } catch {
      return false
    }
  }

  /**
   * The lstat walk: every definition file with its size and mtime, plus the
   * files of roles/ and routines/ named off DEF_REL_RE, or the reason the
   * folder cannot be read.
   */
  private async list(repoRoot: string): Promise<Listed[] | { error: LoadError }> {
    try {
      if (!(await realDir(this.fs, join(repoRoot, '.snagentsos')))) return { error: 'missing' }
      const dir = TeamDefinitionLoader.dirOf(repoRoot)
      if (!(await realDir(this.fs, dir))) return { error: 'missing' }
      const out: Listed[] = []
      const take = async (rel: string, abs: string, def: boolean): Promise<void> => {
        const st = await lstatOrNull(this.fs, abs)
        if (!st) return
        if (st.isSymbolicLink()) throw new LoadFail('link')
        if (!st.isFile()) return
        // Stops a huge folder early: every listed entry counts for the cap.
        if (out.length >= DEF_FILES_MAX) throw new LoadFail('too_many')
        out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs, def })
      }
      await take('team.md', join(dir, 'team.md'), true)
      for (const sub of SUBDIRS) {
        const subDir = join(dir, sub)
        if (!(await realDir(this.fs, subDir))) continue
        const names = await this.fs.readdir(subDir).catch(() => {
          throw new LoadFail('io')
        })
        for (const name of names.sort()) {
          if (ignoredDefName(name)) continue
          const rel = `${sub}/${name}`
          // A name off DEF_REL_RE is never read, but a link is still refused and a file still listed.
          await take(rel, join(subDir, name), DEF_REL_RE.test(rel))
        }
      }
      let total = 0
      for (const f of out) {
        if (!f.def) continue
        if (f.size > DEF_FILE_MAX_BYTES) return { error: 'too_large' }
        total += f.size
      }
      if (total > DEF_TOTAL_MAX_BYTES) return { error: 'too_large' }
      return out
    } catch (e) {
      return { error: e instanceof LoadFail ? e.code : 'io' }
    }
  }

  /** A name off DEF_REL_RE stamps by its presence only (never read: its size and mtime do not matter), escaped so it cannot forge a separator. */
  private static stampOf(listed: readonly Listed[]): string {
    return listed.map((f) => (f.def ? `${f.rel}:${f.mtimeMs}:${f.size}` : `?${encodeURIComponent(f.rel)}`)).join('|')
  }

  load(repoRoot: string): Promise<LoadRes> {
    return this.loadNow(repoRoot)
  }

  private async loadNow(repoRoot: string): Promise<LoadRes> {
    const listed = await this.list(repoRoot)
    if (!Array.isArray(listed)) {
      this.cache.delete(repoRoot)
      return listed
    }
    const stamp = TeamDefinitionLoader.stampOf(listed)
    const cached = this.cache.get(repoRoot)
    if (cached && cached.stamp === stamp) return cached
    try {
      const dir = TeamDefinitionLoader.dirOf(repoRoot)
      const realRoot = await this.fs.realpath(dir)
      const files: DefFile[] = []
      const misnamed: DefFile[] = []
      for (const f of listed) {
        if (!f.def) {
          misnamed.push({ rel: f.rel, text: '' })
          continue
        }
        const real = await this.fs.realpath(f.abs)
        const rel = relative(realRoot, real)
        if (!rel || rel.startsWith('..') || rel.split(sep).join('/').toLowerCase() !== f.rel.toLowerCase()) return { error: 'link' }
        files.push({ rel: f.rel, text: normalizeDefText(await this.fs.readFile(f.abs, 'utf8')) })
      }
      // The hash, the files and so the trusted snapshot hold the definition files only; the parser also sees the misnamed ones.
      const loaded: LoadedDefinition = {
        sha256: createHash('sha256').update(canonicalDefText(files)).digest('hex'),
        files,
        result: parseDefinition(misnamed.length > 0 ? [...files, ...misnamed] : files),
        stamp,
      }
      this.cache.set(repoRoot, loaded)
      return loaded
    } catch {
      return { error: 'io' }
    }
  }

  /** Cheap: true when the stamp moved since the last load (or nothing was loaded yet). */
  async changed(repoRoot: string): Promise<boolean> {
    const listed = await this.list(repoRoot)
    const cached = this.cache.get(repoRoot)
    if (!Array.isArray(listed)) return cached !== undefined
    return !cached || cached.stamp !== TeamDefinitionLoader.stampOf(listed)
  }

  /** Drops the cached load of a repo (a removed team). */
  forget(repoRoot: string): void {
    this.cache.delete(repoRoot)
  }

  /**
   * setupWrite and hire: atomic tmp + rename per file, UTF-8 without BOM, LF;
   * validated rels only; folders created one level at a time without following
   * links. `overwrite: false` refuses a file that exists already (`exists`).
   */
  async write(repoRoot: string, files: DefFile[], o: { overwrite: boolean }): Promise<{ ok: true } | { ok: false; error: 'exists' | 'link' | 'io' }> {
    if (files.length === 0 || files.some((f) => !DEF_REL_RE.test(f.rel))) return { ok: false, error: 'io' }
    try {
      const dir = TeamDefinitionLoader.dirOf(repoRoot)
      const ensure = async (p: string): Promise<void> => {
        if (await realDir(this.fs, p)) return
        await this.fs.mkdir(p)
      }
      await ensure(join(repoRoot, '.snagentsos'))
      await ensure(dir)
      for (const f of files) {
        const parts = f.rel.split('/')
        if (parts.length === 2) await ensure(join(dir, parts[0]))
        const abs = join(dir, ...parts)
        const st = await lstatOrNull(this.fs, abs)
        if (st?.isSymbolicLink()) return { ok: false, error: 'link' }
        if (st && (!o.overwrite || !st.isFile())) return { ok: false, error: 'exists' }
      }
      for (const f of files) await writeAtomic(join(dir, ...f.rel.split('/')), normalizeDefText(f.text))
      return { ok: true }
    } catch (e) {
      if (e instanceof LoadFail && e.code === 'link') return { ok: false, error: 'link' }
      return { ok: false, error: 'io' }
    }
  }

  /**
   * fs.watch of the definition folder, recursive (Windows, macOS and Linux on
   * Node 20). An event source only: `onChange` fires on every raw event and
   * the caller debounces it (TeamService, DeadlineTimer key `defwatch:<id>`).
   * While the folder does not exist the nearest existing parent is watched
   * instead and the watch moves down as the folders appear. Never polls.
   */
  watch(_teamId: string, repoRoot: string, onChange: () => void): () => void {
    const levels = [TeamDefinitionLoader.dirOf(repoRoot), join(repoRoot, '.snagentsos'), repoRoot]
    let watcher: FSWatcher | null = null
    let level = -1
    let stopped = false
    const open = (): void => {
      if (stopped) return
      for (let i = 0; i < levels.length; i++) {
        if (watcher && i >= level) return
        try {
          const w = this.watchFn(levels[i], { recursive: i < levels.length - 1, persistent: false }, () => {
            onChange()
            if (level > 0) open()
          })
          w.on('error', () => {
            // The watched folder went away (Windows reports EPERM): fall back to the nearest parent.
            w.close()
            if (watcher !== w) return
            watcher = null
            level = -1
            onChange()
            open()
          })
          watcher?.close()
          watcher = w
          level = i
          return
        } catch {
          /* this level does not exist yet: try its parent */
        }
      }
    }
    open()
    return () => {
      stopped = true
      watcher?.close()
      watcher = null
    }
  }
}
