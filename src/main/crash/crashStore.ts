import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import type { CrashRecord, RenderErrorReport } from '@shared/ipc-contract'
import { redact, type RedactOptions } from '@shared/redact'

/**
 * Local crash log (E4-FR-23): one JSON per event under dataDir()/crashes,
 * the last 20 kept, at most 16KB each, never uploaded. Written atomically
 * (tmp + rename, UTF-8 without BOM) and redacted (home folder, tokens,
 * connection sends) before they touch the disk. Pattern after Orca's
 * crash-report-store.ts (no code taken). Every write is best effort: a full
 * disk or a locked folder never breaks the recovery path.
 */
export const CRASH_KEEP = 20
export const CRASH_MAX_BYTES = 16 * 1024
export const STACK_MAX = 8 * 1024
const MESSAGE_MAX = 1024

const SCOPES = ['pane', 'paneCell', 'titlebar', 'app', 'root', 'window'] as const

/** zod shape of an incoming `app:reportRenderError` payload; strings trimmed, never rejected for length. */
export const renderErrorReportSchema = z.object({
  scope: z.enum(SCOPES),
  paneId: z.string().max(128).optional(),
  message: z.string().transform((s) => s.slice(0, MESSAGE_MAX)),
  stack: z.string().transform((s) => s.slice(0, STACK_MAX)).optional(),
  componentStack: z.string().transform((s) => s.slice(0, STACK_MAX)).optional(),
  at: z.number().finite(),
})

/** Validate a renderer report; null when it is not one. */
export function parseRenderErrorReport(input: unknown): RenderErrorReport | null {
  const r = renderErrorReportSchema.safeParse(input)
  return r.success ? r.data : null
}

function trimRecord(rec: CrashRecord): CrashRecord {
  const out: CrashRecord = { ...rec }
  if (out.message) out.message = out.message.slice(0, MESSAGE_MAX)
  if (out.stack) out.stack = out.stack.slice(0, STACK_MAX)
  if (out.componentStack) out.componentStack = out.componentStack.slice(0, STACK_MAX)
  // Stay under 16KB whatever the content (multi-byte text): shed the component
  // stack first, then the stack.
  const size = (): number => Buffer.byteLength(JSON.stringify(out), 'utf8')
  while (size() > CRASH_MAX_BYTES && (out.componentStack || out.stack)) {
    if (out.componentStack) out.componentStack = out.componentStack.length > 256 ? out.componentStack.slice(0, Math.floor(out.componentStack.length / 2)) : undefined
    else if (out.stack) out.stack = out.stack.length > 256 ? out.stack.slice(0, Math.floor(out.stack.length / 2)) : undefined
  }
  return out
}

/** Scrub the free-text fields (message, stacks, reason) of a record. */
function redactRecord(rec: CrashRecord, opts: RedactOptions): CrashRecord {
  const out: CrashRecord = { ...rec }
  for (const k of ['message', 'stack', 'componentStack', 'reason'] as const) {
    const v = out[k]
    if (typeof v === 'string') out[k] = redact(v, opts)
  }
  return out
}

let seq = 0

export class CrashStore {
  constructor(
    private readonly dir: string,
    private readonly version: string,
    private readonly keep = CRASH_KEEP,
    /** What to scrub (home, secrets of the current config); read on every write. */
    private readonly redactOptions: () => RedactOptions = () => ({}),
  ) {}

  /** Write one record; returns it (trimmed), or null when the write failed. */
  write(input: Omit<CrashRecord, 'id' | 'version'>): CrashRecord | null {
    // Time, then a per-run sequence, so names sort in write order even within one ms.
    seq = (seq + 1) % 10_000
    const id = `${String(Math.max(0, Math.floor(input.at))).padStart(13, '0')}-${String(seq).padStart(4, '0')}-${input.kind}-${randomBytes(3).toString('hex')}`
    const file = join(this.dir, `${id}.json`)
    const tmp = `${file}.tmp`
    try {
      let opts: RedactOptions = {}
      try {
        opts = this.redactOptions()
      } catch {
        /* the built-in patterns still apply */
      }
      const rec = trimRecord(redactRecord({ ...input, id, version: this.version }, opts))
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8')
      renameSync(tmp, file)
      this.prune()
      return rec
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        /* never written */
      }
      console.warn('[crash] record write failed:', (error as Error)?.message ?? error)
      return null
    }
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    } catch {
      return []
    }
  }

  /** Keep only the newest `keep` records (names sort by time). */
  prune(): void {
    const files = this.files()
    for (const f of files.slice(0, Math.max(0, files.length - this.keep))) {
      try {
        unlinkSync(join(this.dir, f))
      } catch {
        /* best effort */
      }
    }
  }

  /** Newest first, at most `n`. Unreadable files are skipped. */
  list(n = this.keep): CrashRecord[] {
    const out: CrashRecord[] = []
    for (const f of this.files().reverse()) {
      if (out.length >= n) break
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as CrashRecord)
      } catch {
        /* skip a torn or foreign file */
      }
    }
    return out
  }
}
