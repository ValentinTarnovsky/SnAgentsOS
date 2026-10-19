import { posix, win32 } from 'path'
import { randomUUID } from 'crypto'
import type { OpenRequest } from '@shared/ipc-contract'

export { normalizeOpenPath } from '@shared/openPath'

/**
 * "Open in SnAgentsOS" (E4-FR-32): `--open <path>` / `--open=<path>` from the
 * first launch's argv or a second instance's. The value is only ever a folder
 * to show: nothing from argv is executed. Pure parsing here; the stat lives in
 * validateOpenPath so a dead network share cannot block main.
 */

export const OPEN_SWITCH = '--open'
export const OPEN_MAX_LENGTH = 1024
export const OPEN_STAT_TIMEOUT_MS = 3000

const isWinLike = (p: string): boolean => /^[A-Za-z]:/.test(p) || /^[\\/]{2}/.test(p)

/**
 * Explorer's `"%V"` on a drive root arrives as `C:"`: the shell turns `\"` into
 * a literal quote. Any value that ends in a stray quote gets its separator back.
 */
function unquote(value: string): string {
  let v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  if (v.endsWith('"')) v = v.slice(0, -1) + '\\'
  return v.trim()
}

/**
 * Finds the requested folder in argv. Chromium can append or reorder its own
 * switches in a second instance's argv (`--open --allow-file-access... C:\repo`),
 * so the whole array is walked and switches between `--open` and its value are
 * skipped. Relative values resolve against `cwd` (the event's
 * workingDirectory). Returns null when there is no usable value.
 */
export function parseOpenArg(argv: readonly string[], cwd: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '')
    let value: string | null = null
    if (arg === OPEN_SWITCH) {
      for (let j = i + 1; j < argv.length; j++) {
        const next = String(argv[j] ?? '')
        if (next.startsWith('--')) continue
        value = next
        break
      }
    } else if (arg.startsWith(OPEN_SWITCH + '=')) {
      value = arg.slice(OPEN_SWITCH.length + 1)
    } else {
      continue
    }
    const v = value === null ? '' : unquote(value)
    if (!v) return null
    const mod = isWinLike(v) || (!v.startsWith('/') && isWinLike(cwd)) ? win32 : posix
    const abs = mod.normalize(mod.isAbsolute(v) ? v : cwd ? mod.resolve(cwd, v) : v)
    // No trailing separator, except on a root (`C:\`, `/`).
    const trimmed = abs.replace(/[\\/]+$/, '')
    if (!trimmed) return abs
    return mod === win32 && /^[A-Za-z]:$/.test(trimmed) ? trimmed + '\\' : trimmed
  }
  return null
}

/** Absolute, short enough and not a device path. UNC (`\\server\share`, `\\wsl$\...`) is fine. */
export function isAcceptableOpenPath(p: string): boolean {
  if (!p || p.length > OPEN_MAX_LENGTH) return false
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return false
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(p)) return true
  return p.startsWith('/') && !isWinLike(p)
}

export interface OpenStat {
  isDirectory(): boolean
  isFile(): boolean
}

/**
 * Resolves to the folder to open, or null (with a warning). A file opens its
 * folder. The stat runs with a deadline: an unreachable share is dropped after
 * `timeoutMs` instead of freezing anything.
 */
export async function validateOpenPath(
  p: string | null,
  statAsync: (p: string) => Promise<OpenStat>,
  timeoutMs = OPEN_STAT_TIMEOUT_MS,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): Promise<string | null> {
  if (!p || !isAcceptableOpenPath(p)) {
    if (p) warn(`[open] ignored: not an absolute folder path (${p.length > 80 ? p.slice(0, 80) + '...' : p})`)
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const st = await Promise.race([statAsync(p), deadline])
    if (st === 'timeout') {
      warn(`[open] ignored: no answer from ${p} within ${timeoutMs} ms`)
      return null
    }
    if (st.isDirectory()) return p
    if (st.isFile()) return (isWinLike(p) ? win32 : posix).dirname(p)
    warn(`[open] ignored: ${p} is not a folder`)
    return null
  } catch {
    warn(`[open] ignored: ${p} does not exist`)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function makeOpenRequest(path: string, source: OpenRequest['source']): OpenRequest {
  return { id: randomUUID(), path, source }
}

/**
 * Pending open request held by main until the renderer takes it: a push sent
 * before the renderer hydrated (or across a reload) is never lost, and the
 * renderer dedupes by id. Only the latest request is kept.
 */
export class OpenRequestQueue {
  private pending: OpenRequest | null = null

  constructor(private readonly push: (req: OpenRequest) => void) {}

  offer(req: OpenRequest): void {
    this.pending = req
    this.push(req)
  }

  /** Consumes the pending request (null when there is none). */
  take(): OpenRequest | null {
    const req = this.pending
    this.pending = null
    return req
  }
}
