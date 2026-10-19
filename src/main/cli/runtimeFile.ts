import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { SnaosRuntimeFile } from '@shared/ctl-protocol'

/**
 * dataDir()/runtime.json (E8-FR-12): endpoint + master token of this run,
 * for terminals outside the app. Written atomically (tmp + rename), 0600 on
 * POSIX; UTF-8 without BOM through Node, never through PowerShell.
 */
export function writeRuntimeFile(path: string, data: SnaosRuntimeFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* already gone */
    }
    throw error
  }
}

/** The parsed file, or null when missing or malformed. */
export function readRuntimeFile(path: string): SnaosRuntimeFile | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as Partial<SnaosRuntimeFile>
    if (
      raw?.version !== 1 ||
      typeof raw.pid !== 'number' ||
      typeof raw.token !== 'string' ||
      !raw.transport ||
      typeof raw.transport.endpoint !== 'string' ||
      (raw.transport.kind !== 'named-pipe' && raw.transport.kind !== 'unix')
    )
      return null
    return raw as SnaosRuntimeFile
  } catch {
    return null
  }
}

/**
 * Deletes the file only when it belongs to `pid` (this process): a second
 * instance writing its own file in the same folder is left alone. True when
 * the file was removed.
 */
export function removeRuntimeFileIfOwned(path: string, pid: number = process.pid): boolean {
  const current = readRuntimeFile(path)
  if (!current || current.pid !== pid) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
