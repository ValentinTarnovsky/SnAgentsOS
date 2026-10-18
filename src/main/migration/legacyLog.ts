import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { LOG_DIR, LOG_FILE } from './legacyMarker'

/** Rotated at 256 KB; one previous file is kept as legacy-migration.log.1. */
export const LOG_MAX_BYTES = 256 * 1024

export function legacyLogPath(targetDir: string): string {
  return join(targetDir, LOG_DIR, LOG_FILE)
}

/**
 * dataDir()/logs/legacy-migration.log (E0-FR-35): one line per phase
 * transition and per cleanup item (phase, item, result, error code, path).
 * Callers never pass file contents or secrets. Logging never throws: a data
 * folder that cannot be written (read-only medium) must not break the start.
 */
export function createLegacyLog(targetDir: string, now: () => number = Date.now): (line: string) => void {
  const file = legacyLogPath(targetDir)
  return (line: string) => {
    try {
      mkdirSync(join(targetDir, LOG_DIR), { recursive: true })
      try {
        if (statSync(file).size >= LOG_MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        /* no file yet */
      }
      appendFileSync(file, `${new Date(now()).toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`, 'utf8')
    } catch {
      /* best effort */
    }
  }
}
