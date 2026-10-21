import { promises as fsp } from 'fs'

/**
 * Atomic write: a temp file next to the target, then a rename over it, so a
 * crash never leaves half a file. The temp file goes away when anything
 * fails. `data` as a string is written as UTF-8 without BOM. `opts.mode`
 * sets the permission bits of the new file (POSIX; ignored by Windows).
 */
export async function writeAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await fsp.writeFile(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined)
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}
