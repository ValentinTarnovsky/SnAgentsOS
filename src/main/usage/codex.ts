import { open, readdir, stat } from 'fs/promises'
import { join } from 'path'
import type { UsageRow } from '@shared/ipc-contract'
import { numericDirsDesc, sessionsRoot } from '../agents/codexPaths'
import {
  buildWindow,
  dedupeByKind,
  emptyCodexRows,
  rowsFromSnapshot,
  type CodexRowFlags,
  type CodexSnapshot,
} from './codexWindows'

export type { CodexRowFlags } from './codexWindows'

/**
 * Local fallback: read Codex's own rollout files (no API, no auth). After every
 * turn Codex appends an `event_msg` / `token_count` line carrying `rate_limits`.
 *
 * Why this is not "newest file, last line":
 *  - Five consoles write five rollouts at once, each holding a different (older
 *    or newer) snapshot, and on Windows mtime lags the content. So several of
 *    the most recent files are inspected and the snapshot with the newest
 *    `timestamp` wins.
 *  - A session started yesterday keeps appending to yesterday's folder, so the
 *    two newest day folders are scanned, not just the newest.
 *  - Rollouts reach 20MB: only the tail is read, never the whole file.
 */

const DAY_FOLDERS = 2
const MAX_FILES = 5
/** Tail sizes tried in order; the larger one only when the first holds no token_count. */
const TAIL_STEPS = [256 * 1024, 2 * 1024 * 1024]

interface RolloutFile {
  path: string
  mtimeMs: number
}

/** Rollout files of the newest `DAY_FOLDERS` dated folders, newest mtime first, capped at `MAX_FILES`. */
async function candidateFiles(): Promise<RolloutFile[]> {
  const root = sessionsRoot()
  const dayDirs: string[] = []
  outer: for (const y of numericDirsDesc(root)) {
    const yDir = join(root, y)
    for (const m of numericDirsDesc(yDir)) {
      const mDir = join(yDir, m)
      for (const d of numericDirsDesc(mDir)) {
        const dDir = join(mDir, d)
        let names: string[] = []
        try {
          names = await readdir(dDir)
        } catch {
          continue
        }
        if (!names.some((f) => /^rollout-.*\.jsonl$/i.test(f))) continue
        dayDirs.push(dDir)
        if (dayDirs.length >= DAY_FOLDERS) break outer
      }
    }
  }
  const files: RolloutFile[] = []
  for (const dir of dayDirs) {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const f of names) {
      if (!/^rollout-.*\.jsonl$/i.test(f)) continue
      const p = join(dir, f)
      try {
        files.push({ path: p, mtimeMs: (await stat(p)).mtimeMs })
      } catch {
        /* ignore an unreadable entry */
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files.slice(0, MAX_FILES)
}

interface RawLimits {
  limit_id?: string | null
  primary?: RawLimitWindow | null
  secondary?: RawLimitWindow | null
  plan_type?: string | null
}
interface RawLimitWindow {
  used_percent?: number
  window_minutes?: number
  resets_at?: number
}
interface RolloutLine {
  timestamp?: string
  type?: string
  payload?: { type?: string; rate_limits?: RawLimits | null }
}

interface Found {
  /** Epoch ms of the event (its own `timestamp`), or NaN when absent. */
  at: number
  limits: RawLimits
}

/**
 * Read the last `bytes` of a file as raw bytes and cut the partial first line
 * (the read usually starts mid-line). One extra byte before the window tells a
 * cut from a clean line boundary: the bytes up to and including the first
 * newline are dropped either way, so a line that merely starts at the window
 * edge is kept. Returns the complete lines, oldest first.
 */
export async function tailLines(file: string, bytes: number): Promise<{ lines: string[]; wholeFile: boolean }> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const wholeFile = size <= bytes
    const len = wholeFile ? size : bytes + 1
    const buf = Buffer.alloc(len)
    if (len > 0) await fh.read(buf, 0, len, size - len)
    let start = 0
    if (!wholeFile) {
      const nl = buf.indexOf(0x0a)
      start = nl === -1 ? len : nl + 1
    }
    return { lines: buf.subarray(start).toString('utf8').split('\n'), wholeFile }
  } finally {
    await fh.close()
  }
}

/** Newest usable `token_count` rate-limit snapshot in a list of lines (scanned from the end). */
function lastTokenCount(lines: string[]): Found | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('token_count')) continue
    try {
      const obj = JSON.parse(line) as RolloutLine
      const p = obj.payload
      if (obj.type !== 'event_msg' || p?.type !== 'token_count' || !p.rate_limits) continue
      // Per-model limits carry another limit_id; the account quota is "codex".
      const id = p.rate_limits.limit_id
      if (typeof id === 'string' && id !== 'codex') continue
      return { at: obj.timestamp ? Date.parse(obj.timestamp) : NaN, limits: p.rate_limits }
    } catch {
      /* skip a malformed (or cut) line */
    }
  }
  return null
}

async function lastRateLimits(file: RolloutFile): Promise<Found | null> {
  for (let i = 0; i < TAIL_STEPS.length; i++) {
    let lines: string[]
    let wholeFile: boolean
    try {
      ;({ lines, wholeFile } = await tailLines(file.path, TAIL_STEPS[i]))
    } catch {
      return null
    }
    const found = lastTokenCount(lines)
    if (found) return { at: Number.isFinite(found.at) ? found.at : file.mtimeMs, limits: found.limits }
    if (wholeFile) return null
  }
  return null
}

function toSnapshot(found: Found, nowMs: number): CodexSnapshot {
  const { primary, secondary } = found.limits
  const mk = (w: RawLimitWindow | null | undefined, fallbackKind: '5h' | '7d') =>
    w
      ? buildWindow(
          {
            usedPercent: w.used_percent,
            windowSeconds: typeof w.window_minutes === 'number' ? w.window_minutes * 60 : undefined,
            resetsAtSec: w.resets_at,
            fallbackKind,
          },
          nowMs,
        )
      : null
  return {
    planType: found.limits.plan_type ?? null,
    windows: dedupeByKind([mk(primary, '5h'), mk(secondary, '7d')]),
    at: found.at,
  }
}

/** The freshest rate-limit snapshot across the recent rollouts, or null when none holds one. */
export async function readCodexLocal(nowMs: number = Date.now()): Promise<CodexSnapshot | null> {
  let files: RolloutFile[]
  try {
    files = await candidateFiles()
  } catch {
    return null
  }
  let best: Found | null = null
  for (const f of files) {
    const found = await lastRateLimits(f)
    if (found && (!best || found.at > best.at)) best = found
  }
  return best ? toSnapshot(best, nowMs) : null
}

/** Local-only rows (the fallback path). */
export async function fetchCodexRows(flags: CodexRowFlags): Promise<UsageRow[]> {
  if (!flags.codex5h && !flags.codex7d) return []
  const snap = await readCodexLocal()
  return snap ? rowsFromSnapshot(flags, snap) : emptyCodexRows(flags, 'nodata')
}
