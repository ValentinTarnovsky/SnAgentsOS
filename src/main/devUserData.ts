import { app } from 'electron'
import { join } from 'path'
import { BRAND } from '@shared/brand'

/**
 * E0-FR-26: a dev run gets its own userData (<appData>/snagentsos-dev) unless
 * --user-data-dir was passed. Otherwise dev would leave a config.json in
 * %APPDATA%\snagentsos and the first packaged start would skip the real
 * migration. Must run before any path is read (index.ts builds the stores at
 * module load) and before requestSingleInstanceLock, so it is the first import
 * of index.ts and runs at import time.
 */
export function isolateDevUserData(): boolean {
  if (app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return false
  app.setPath('userData', join(app.getPath('appData'), BRAND.devUserDataDir))
  return true
}

isolateDevUserData()
