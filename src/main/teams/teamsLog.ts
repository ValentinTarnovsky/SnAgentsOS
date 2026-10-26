import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

/** teams.log rotates to teams.1.log past this size. */
export const TEAMS_LOG_MAX_BYTES = 2 * 1024 * 1024

/**
 * `dataDir()/logs/teams.log` (app 2.7.0, E10 B): one line per lifecycle event
 * of the Teams module. Callers pass codes and ids only, never prompt, reply or
 * file text. Rotated to `teams.1.log` at 2 MB; never throws.
 */
export function createTeamsLog(dataDir: () => string, now: () => number = Date.now): (line: string) => void {
  return (line: string) => {
    try {
      const dir = join(dataDir(), 'logs')
      const file = join(dir, 'teams.log')
      mkdirSync(dir, { recursive: true })
      try {
        if (statSync(file).size >= TEAMS_LOG_MAX_BYTES) renameSync(file, join(dir, 'teams.1.log'))
      } catch {
        /* no file yet */
      }
      appendFileSync(file, `${new Date(now()).toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`, 'utf8')
    } catch {
      /* best effort */
    }
  }
}
