import { promises as fsp } from 'node:fs'
import { isAbsolute } from 'node:path'

/** Longest path the composer may probe (E8-FR-08); anything longer is not a folder. */
const MAX_PATH_LEN = 4096
/** An unreachable network share can stall stat for many seconds. */
const PROBE_TIMEOUT_MS = 1500

type StatFn = (p: string) => Promise<{ isDirectory(): boolean }>

/**
 * `fs:dirExists` (E8-FR-08): whether `p` is an existing folder, for the
 * composer's "folder does not exist" hint. Only absolute paths are probed (a
 * relative one has no meaning before a shell resolves it). A probe that takes
 * longer than the timeout answers true: unknown never shows the warning, and
 * the warning never blocks creating anyway.
 */
export function dirExists(p: unknown, opts: { stat?: StatFn; timeoutMs?: number } = {}): Promise<boolean> {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LEN || p.includes('\0') || !isAbsolute(p)) {
    return Promise.resolve(false)
  }
  const stat = opts.stat ?? ((x: string) => fsp.stat(x))
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), opts.timeoutMs ?? PROBE_TIMEOUT_MS)
    stat(p).then(
      (st) => {
        clearTimeout(timer)
        resolve(st.isDirectory())
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      },
    )
  })
}
