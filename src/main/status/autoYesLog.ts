import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

/** autoyes.log rotates to autoyes.log.1 past this size (one previous file kept). */
export const AUTO_YES_LOG_MAX_BYTES = 128 * 1024

/**
 * `dataDir()/logs/autoyes.log` (app 2.10.0): one timestamped line per prompt
 * auto-yes answered (autoYesLogLine: console id, tool name, teammate, mode;
 * never a command or any tool input). Never throws.
 */
export function createAutoYesLog(dataDir: string, now: () => number = Date.now): (line: string) => void {
  const dir = join(dataDir, 'logs')
  const file = join(dir, 'autoyes.log')
  return (line: string) => {
    try {
      mkdirSync(dir, { recursive: true })
      try {
        if (statSync(file).size >= AUTO_YES_LOG_MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        /* no file yet */
      }
      appendFileSync(file, `${new Date(now()).toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`, 'utf8')
    } catch {
      /* best effort */
    }
  }
}
