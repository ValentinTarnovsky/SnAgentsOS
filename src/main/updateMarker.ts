import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { UpdateNotApplied } from '@shared/ipc-contract'
import { writeAtomic } from './fsAtomic'

/**
 * Unfinished-update marker (app 2.4.0). The silent NSIS update quits the app
 * before the setup runs, so a declined Windows permission prompt (or a setup
 * that aborts on its own) leaves the old version with no feedback at all.
 * `applyInstall` writes `dataDir()/update-pending.json` right before it starts
 * the setup; the next start reads and deletes it: the version advanced, or the
 * marker is old or malformed, is silent, otherwise the renderer gets one
 * `update:notApplied` toast with [Retry]. Pure parts are exported for
 * scripts/test-update-marker.cjs.
 */
export const UPDATE_MARKER_FILE = 'update-pending.json'
/** A marker older than this is a stale leftover, never a toast. */
export const UPDATE_MARKER_MAX_AGE_MS = 60 * 60 * 1000
/** Clock skew tolerated for a marker dated slightly in the future. */
const FUTURE_SKEW_MS = 5 * 60 * 1000

/** "v1.2.3" / "1.2.3-beta+5" -> [1, 2, 3] (prerelease/build metadata dropped). */
export function parseVersion(v: string): number[] {
  const core = v.replace(/^v/i, '').split('-')[0].split('+')[0]
  return core.split('.').map((n) => parseInt(n, 10) || 0)
}

/** True when `latest` is a strictly higher version than `current` (numeric, never lexical). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

const VERSION = z.string().max(64).regex(/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/)
const markerSchema = z.object({ from: VERSION, to: VERSION, at: z.number().finite().nonnegative() })
export type UpdateMarker = z.infer<typeof markerSchema>

/** The marker in `text`, or null when it is not valid JSON of the expected shape. */
export function parseUpdateMarker(text: string): UpdateMarker | null {
  try {
    const parsed = markerSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * What a marker read at start means for the running `current` version:
 * `{ from, to }` when the update did not land (still below `to`) and the
 * marker is under an hour old, else null (applied, stale or malformed).
 */
export function readUpdateMarker(text: string, current: string, now: number): UpdateNotApplied | null {
  const marker = parseUpdateMarker(text)
  if (!marker) return null
  if (!isNewer(marker.to, current)) return null
  const age = now - marker.at
  if (age > UPDATE_MARKER_MAX_AGE_MS || age < -FUTURE_SKEW_MS) return null
  return { from: marker.from, to: marker.to }
}

/** Writes the marker atomically (tmp + rename, UTF-8 without BOM). */
export async function writeUpdateMarker(dir: string, marker: UpdateMarker): Promise<void> {
  await writeAtomic(join(dir, UPDATE_MARKER_FILE), JSON.stringify(marker))
}

/** Removes the marker (best effort; missing is fine). */
export function clearUpdateMarker(dir: string): void {
  try {
    rmSync(join(dir, UPDATE_MARKER_FILE), { force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Reads the marker once at start and always deletes it, so the toast is
 * one-shot and a malformed file never sticks around. Null when there is none.
 */
export function takeUpdateMarker(dir: string, current: string, now = Date.now()): UpdateNotApplied | null {
  let text: string
  try {
    text = readFileSync(join(dir, UPDATE_MARKER_FILE), 'utf8')
  } catch {
    return null
  }
  clearUpdateMarker(dir)
  return readUpdateMarker(text, current, now)
}
