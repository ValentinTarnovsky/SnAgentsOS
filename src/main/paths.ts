import { dirname, join } from 'path'
import { app } from 'electron'

/** True when running as a portable build (electron-builder portable target or --portable flag). */
export function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR) || process.argv.includes('--portable')
}

/**
 * The actual portable .exe the user launched (electron-builder runs the app
 * from a temp extraction, so `process.execPath` is NOT this file). Used by the
 * updater to overwrite the right file. Null when not a portable build.
 */
export function portableExeFile(): string | null {
  return process.env.PORTABLE_EXECUTABLE_FILE ?? null
}

/** Directory next to the executable when portable, else null. */
export function portableDir(): string | null {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR
  if (process.argv.includes('--portable')) return dirname(app.getPath('exe'))
  return null
}

/** Resolved config.json path: next to the exe when portable, else in userData. */
export function getConfigPath(): string {
  const pdir = portableDir()
  if (pdir) return join(pdir, 'snmulticc-data', 'config.json')
  return join(app.getPath('userData'), 'config.json')
}
