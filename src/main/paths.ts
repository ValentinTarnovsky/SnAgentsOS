import { lstatSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { BRAND, LEGACY_BRAND } from '@shared/brand'

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
  if (pdir) return join(pdir, BRAND.portableDataDir, 'config.json')
  return join(app.getPath('userData'), 'config.json')
}

/**
 * Current data folder: always dirname(getConfigPath()), so the portable stays
 * self-contained. Every new persistent file of any epic lives under it, never
 * under app.getPath('userData') directly (status-bin is the inherited exception).
 */
export function dataDir(): string {
  return dirname(getConfigPath())
}

/**
 * Parent of the per-app data folders. Packaged builds use what Electron (and
 * so 1.x) used. Dev builds derive it from the environment instead: Electron
 * reads the Windows known folder and ignores %APPDATA%, and the fake trees of
 * the migration tests (P-LEGACY) only redirect the environment.
 */
export function appDataRoot(): string {
  if (!app.isPackaged) {
    const env = process.env
    if (process.platform === 'win32' && env.APPDATA) return env.APPDATA
    if (process.platform === 'darwin' && env.HOME) return join(env.HOME, 'Library', 'Application Support')
    if (process.platform === 'linux' && (env.XDG_CONFIG_HOME || env.HOME)) return env.XDG_CONFIG_HOME || join(env.HOME as string, '.config')
  }
  return app.getPath('appData')
}

function isRealDir(p: string): boolean {
  try {
    const st = lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Data folder of 1.x, or null. Installed: <appData>/snmulticc (or the product
 * name on a case-sensitive filesystem). Portable: <exeDir>/snmulticc-data.
 * Only exact names match, so a <name>.deleting-<ISO> tombstone left by an
 * interrupted cleanup is never detected as legacy data, and a link in place of
 * the folder is not followed.
 */
export function getLegacyDataDir(): string | null {
  const pdir = portableDir()
  const root = appDataRoot()
  const candidates = pdir
    ? [join(pdir, LEGACY_BRAND.portableDataDir)]
    : [join(root, LEGACY_BRAND.packageName), join(root, LEGACY_BRAND.productName)]
  return candidates.find(isRealDir) ?? null
}
