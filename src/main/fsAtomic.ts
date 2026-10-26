import { promises as fsp, renameSync, rmSync, writeFileSync } from 'fs'

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

/** Sync file calls writeAtomicSync uses; a test fake replaces them. */
export interface AtomicSyncFs {
  writeFileSync(file: string, data: string | Uint8Array, opts?: { mode?: number }): void
  renameSync(from: string, to: string): void
  rmSync(file: string, opts: { force: true }): void
}

const nodeSyncFs: AtomicSyncFs = { writeFileSync, renameSync, rmSync }

/**
 * `writeAtomic` for exit paths and synchronous stores (app 2.7.0, Teams): the
 * same temp file plus rename, without an await between them, so it can run in
 * a quit handler and never interleaves with another write of the same file.
 * Does not create the parent folder. Throws after removing the temp file.
 */
export function writeAtomicSync(file: string, data: string | Uint8Array, opts: { mode?: number } = {}, fs: AtomicSyncFs = nodeSyncFs): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined)
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* already gone */
    }
    throw err
  }
}
