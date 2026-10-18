import * as fs from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { ScrollbackStats } from '@shared/ipc-contract'
import { sanitizeSeed } from './ansiSanitize'

/**
 * Saved console history (E6-FR-08..13, 36, 37): one `dataDir()/scrollback/
 * <paneId>.json` per pane, written atomically (tmp + rename, never straight
 * over the live file), validated and sanitized when read back, moved to
 * `.trash/` when its pane goes away (the next start empties it) and swept of
 * panes the config no longer has. Takes the pattern (no code) of Orca's
 * terminal-scrollback-snapshots: ref validation, tmp + rename, byte limits.
 */

/** Real pane ids are "pane-xxxxxxxx"; anything else never becomes a file name. */
export const PANE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Hard cap of one saved file's `ansi` (E6-FR-09). */
export const MAX_FILE_BYTES = 1024 * 1024
/** Past this the oldest files are deleted at startup (E6-FR-12). */
export const MAX_DIR_BYTES = 50 * 1024 * 1024
/** Waits before retrying a rename that an antivirus or indexer blocked (EPERM). */
export const RENAME_RETRY_MS = [50, 150] as const
const TRASH = '.trash'

export interface PersistSnapshot {
  /** Normal buffer only, no modes, no trailing blank lines. */
  ansi: string
  cols: number
  rows: number
  lines: number
}

const fileSchema = z.object({
  v: z.literal(1),
  paneId: z.string().regex(PANE_ID_RE),
  savedAt: z.number().finite(),
  cols: z.number().int().positive().max(2000),
  rows: z.number().int().positive().max(1000),
  lines: z.number().int().nonnegative(),
  // Characters, not bytes: a 1 MB UTF-8 file never has more characters than bytes.
  ansi: z.string().max(MAX_FILE_BYTES),
})
export type ScrollbackFileV1 = z.infer<typeof fileSchema>

/** What a restore needs: the sanitized text and when it was saved. */
export interface SavedScrollback {
  ansi: string
  savedAt: number
}

/** Trailing whitespace, blank rows, SGR and the cursor moves serialize() ends with. */
const TRAILING_RE = /(?:[ \t\r\n]|\x1b\[[\d;:]*[ABCDEFGHJKfm])+$/

/**
 * The persisted form of a serialized normal buffer: no trailing blank lines
 * (Claude's empty live area), no final cursor move (the separator goes right
 * after the last line) and no trailing SGR (the seed adds its own reset).
 */
export function trimPersistAnsi(ansi: string): string {
  return ansi.replace(TRAILING_RE, '')
}

/** Rows in a trimmed persisted text (wrapped rows count once per CRLF). */
export function countLines(ansi: string): number {
  if (!ansi) return 0
  let n = 1
  for (let i = ansi.indexOf('\r\n'); i >= 0; i = ansi.indexOf('\r\n', i + 2)) n++
  return n
}

/**
 * A text over `maxBytes`: its last part that fits, starting on a line, so the
 * newest lines survive. Only a last resort after a smaller serialize.
 */
export function capBytes(ansi: string, maxBytes: number = MAX_FILE_BYTES): string {
  const buf = Buffer.from(ansi, 'utf8')
  if (buf.length <= maxBytes) return ansi
  // The cut may split a character; the first line break skips past it.
  const tail = buf.subarray(buf.length - maxBytes).toString('utf8')
  const nl = tail.indexOf('\r\n')
  return nl >= 0 ? tail.slice(nl + 2) : tail.slice(1)
}

/**
 * Pushes everything on screen into the scrollback and homes the cursor. A
 * Windows pty starts with ESC[2J ESC[H (ConPTY), and xterm.js erases the
 * visible rows in place: without this the last screen of the history and the
 * separator would vanish under the new prompt. After it the prompt lands
 * right below the separator on every platform.
 */
export function scrollOff(rows: number): string {
  return '\n'.repeat(Math.max(0, Math.min(1000, Math.floor(rows)) - 1)) + '\x1b[H'
}

/**
 * The seed a restored pane starts with (E6-FR-11): the saved history, a reset,
 * the gray "--- restarted - history from ... ---" line and the scroll-off.
 */
export function buildSeed(ansi: string, label: string, rows: number): string {
  const clean = label.replace(/[\x00-\x1f\x7f-\x9f]/g, '')
  return `${ansi}\x1b[0m\r\n\x1b[2m--- ${clean} ---\x1b[0m\r\n${scrollOff(rows)}`
}

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/** Synchronous sleep for the exit path (main thread, no event loop left to wait on). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* not allowed here: retry right away */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class ScrollbackStore {
  private readonly trashDir: string
  private seq = 0
  /** paneId -> the save in flight, so a trash/remove runs after it, never under it. */
  private readonly inflight = new Map<string, Promise<boolean>>()
  /** paneId -> seq of the newest write that landed: an older async rename is dropped. */
  private readonly landed = new Map<string, number>()

  constructor(
    readonly dir: string,
    private readonly log: (msg: string) => void = (msg) => console.warn(msg),
  ) {
    this.trashDir = join(dir, TRASH)
  }

  /** `<dir>/<paneId>.json`, or null for an id that is not a plain pane id. */
  fileOf(paneId: string): string | null {
    return typeof paneId === 'string' && PANE_ID_RE.test(paneId) ? join(this.dir, `${paneId}.json`) : null
  }

  private trashOf(paneId: string): string {
    return join(this.trashDir, `${paneId}.json`)
  }

  private record(paneId: string, snap: PersistSnapshot, now: number): string {
    const file: ScrollbackFileV1 = { v: 1, paneId, savedAt: now, cols: snap.cols, rows: snap.rows, lines: snap.lines, ansi: snap.ansi }
    return JSON.stringify(file)
  }

  private tmpOf(file: string, seq: number): string {
    return `${file}.${process.pid}.${seq}.tmp`
  }

  /**
   * Checkpoint write (E6-FR-09): tmp + rename, async. A rename blocked by an
   * antivirus (EPERM) is retried after 50 and 150 ms; if it still fails the
   * previous file stays, the tmp goes and it is logged. Resolves to whether
   * the file was replaced.
   */
  save(paneId: string, snap: PersistSnapshot, now: number = Date.now()): Promise<boolean> {
    const file = this.fileOf(paneId)
    if (!file) return Promise.resolve(false)
    const seq = ++this.seq
    const json = this.record(paneId, snap, now)
    const prev = this.inflight.get(paneId) ?? Promise.resolve(true)
    const run = prev.then(async () => {
      const tmp = this.tmpOf(file, seq)
      try {
        await fs.promises.mkdir(this.dir, { recursive: true })
        await fs.promises.writeFile(tmp, json, 'utf8')
        for (let attempt = 0; ; attempt++) {
          // A synchronous exit save landed meanwhile: this older text must not win.
          if ((this.landed.get(paneId) ?? 0) > seq) {
            await fs.promises.rm(tmp, { force: true })
            return false
          }
          try {
            await fs.promises.rename(tmp, file)
            this.landed.set(paneId, seq)
            return true
          } catch (error) {
            if (!isBusyError(error) || attempt >= RENAME_RETRY_MS.length) throw error
            await sleep(RENAME_RETRY_MS[attempt])
          }
        }
      } catch (error) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        this.log(`[scrollback] could not save ${paneId}, keeping the previous file: ${String(error)}`)
        return false
      }
    })
    this.inflight.set(paneId, run)
    void run.finally(() => {
      if (this.inflight.get(paneId) === run) this.inflight.delete(paneId)
    })
    return run
  }

  /** Exit write (E6-FR-10): the same atomic replace, synchronous. */
  saveSync(paneId: string, snap: PersistSnapshot, now: number = Date.now()): boolean {
    const file = this.fileOf(paneId)
    if (!file) return false
    const seq = ++this.seq
    const tmp = this.tmpOf(file, seq)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(tmp, this.record(paneId, snap, now), 'utf8')
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(tmp, file)
          this.landed.set(paneId, seq)
          return true
        } catch (error) {
          if (!isBusyError(error) || attempt >= RENAME_RETRY_MS.length) throw error
          sleepSync(RENAME_RETRY_MS[attempt])
        }
      }
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* best effort */
      }
      this.log(`[scrollback] could not save ${paneId} on exit, keeping the previous file: ${String(error)}`)
      return false
    }
  }

  /**
   * The saved history of a pane, validated (E6-FR-37): a file with another
   * shape is deleted. Falls back to the trashed copy, so a console closed and
   * reopened in this session gets its history back. `ansi` comes sanitized.
   */
  load(paneId: string): SavedScrollback | null {
    const file = this.fileOf(paneId)
    if (!file) return null
    for (const path of [file, this.trashOf(paneId)]) {
      let raw: string
      try {
        raw = fs.readFileSync(path, 'utf8')
      } catch {
        continue
      }
      let parsed: ReturnType<typeof fileSchema.safeParse>
      try {
        parsed = fileSchema.safeParse(JSON.parse(raw))
      } catch {
        parsed = { success: false } as ReturnType<typeof fileSchema.safeParse>
      }
      if (!parsed.success || parsed.data.paneId !== paneId) {
        this.log(`[scrollback] invalid saved history for ${paneId}, deleted`)
        try {
          fs.rmSync(path, { force: true })
        } catch {
          /* best effort */
        }
        continue
      }
      const ansi = sanitizeSeed(parsed.data.ansi)
      return ansi ? { ansi, savedAt: parsed.data.savedAt } : null
    }
    return null
  }

  /** Closed pane or deleted workspace (E6-FR-12): the file waits in `.trash/` until the next start. */
  async trash(paneId: string): Promise<void> {
    const file = this.fileOf(paneId)
    if (!file) return
    await this.settled(paneId)
    try {
      await fs.promises.mkdir(this.trashDir, { recursive: true })
      await fs.promises.rename(file, this.trashOf(paneId))
    } catch {
      /* no saved history, or it could not move: the startup GC sweeps orphans */
    }
  }

  /** "Clear saved history": gone at once, trashed copy included. */
  async remove(paneId: string): Promise<void> {
    const file = this.fileOf(paneId)
    if (!file) return
    await this.settled(paneId)
    await fs.promises.rm(file, { force: true }).catch(() => undefined)
    await fs.promises.rm(this.trashOf(paneId), { force: true }).catch(() => undefined)
  }

  /** Every saved file and the trash (the global button and turning persistence off). */
  async clearAll(): Promise<void> {
    await Promise.all([...this.inflight.values()].map((p) => p.catch(() => false)))
    for (const name of await this.list(this.dir)) {
      if (name.endsWith('.json') || name.endsWith('.tmp')) await fs.promises.rm(join(this.dir, name), { force: true }).catch(() => undefined)
    }
    await fs.promises.rm(this.trashDir, { recursive: true, force: true }).catch(() => undefined)
  }

  /** Saved consoles and their size, for "Clear all saved history (N consoles, X MB)". */
  async stats(): Promise<ScrollbackStats> {
    let files = 0
    let bytes = 0
    for (const name of await this.list(this.dir)) {
      const paneId = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!PANE_ID_RE.test(paneId)) continue
      try {
        bytes += (await fs.promises.stat(join(this.dir, name))).size
        files++
      } catch {
        /* removed meanwhile */
      }
    }
    return { files, bytes }
  }

  /**
   * Startup sweep (E6-FR-12). With `livePaneIds` (a config read from the
   * primary file): empties the trash, drops orphan tmp files and the files of
   * panes the config no longer has. With null (no config, or one recovered
   * from a backup that may have lost panes) nothing of that is touched. Either
   * way, past 50 MB the oldest files go.
   */
  async gc(livePaneIds: ReadonlySet<string> | null, maxDirBytes: number = MAX_DIR_BYTES): Promise<{ removed: string[] }> {
    const removed: string[] = []
    if (livePaneIds) {
      await fs.promises.rm(this.trashDir, { recursive: true, force: true }).catch(() => undefined)
      for (const name of await this.list(this.dir)) {
        const paneId = name.endsWith('.json') ? name.slice(0, -5) : null
        const orphanTmp = name.endsWith('.tmp')
        const orphanFile = paneId !== null && PANE_ID_RE.test(paneId) && !livePaneIds.has(paneId)
        if (!orphanTmp && !orphanFile) continue
        await fs.promises.rm(join(this.dir, name), { force: true }).catch(() => undefined)
        if (orphanFile && paneId) removed.push(paneId)
      }
    }
    const sized: Array<{ name: string; size: number; mtime: number }> = []
    for (const name of await this.list(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const st = await fs.promises.stat(join(this.dir, name))
        sized.push({ name, size: st.size, mtime: st.mtimeMs })
      } catch {
        /* removed meanwhile */
      }
    }
    let total = sized.reduce((sum, f) => sum + f.size, 0)
    sized.sort((a, b) => a.mtime - b.mtime)
    for (const f of sized) {
      if (total <= maxDirBytes) break
      await fs.promises.rm(join(this.dir, f.name), { force: true }).catch(() => undefined)
      total -= f.size
      removed.push(f.name.slice(0, -5))
    }
    return { removed }
  }

  private async settled(paneId: string): Promise<void> {
    await this.inflight.get(paneId)?.catch(() => false)
  }

  private async list(dir: string): Promise<string[]> {
    try {
      return await fs.promises.readdir(dir)
    } catch {
      return []
    }
  }
}
