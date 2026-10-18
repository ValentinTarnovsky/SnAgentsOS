import { existsSync } from 'fs'
import { ipcMain, shell, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { LegacyDataInfo } from '@shared/ipc-contract'
import { deriveLegacyInfo } from '../migration/legacyInfo'
import type { LegacyMigrationMarker } from '../migration/legacyMarker'
import {
  ackLegacyNotice,
  currentLegacyMarker,
  legacyBackupFile,
  legacyLogFile,
  onLegacyStatus,
} from '../migration/runLegacyMigration'

interface LegacyIpcHooks {
  getSender: () => WebContents | null
  /** settings.remote.enabled of the config in use (firewall line of the notice). */
  remoteEnabled: () => boolean
}

/**
 * 1.x migration IPC (E0-FR-10, 28, 35).
 *  - `app:legacyInfo`       -> LegacyDataInfo derived from the marker
 *  - `app:legacyAck`        -> noticeSeen = true (the only marker write the renderer can ask for)
 *  - `app:legacyShowBackup` -> reveals migration-backup-v1.zip
 *  - `app:legacyOpenLog`    -> opens logs/legacy-migration.log
 *  - `app:legacyStatus`     -> pushed on every marker change
 * No channel takes a path or an argument: main resolves every file itself,
 * and there is nothing to import or delete from here (FR-11 retired).
 */
export function registerLegacyIpc(hooks: LegacyIpcHooks): () => void {
  const info = (marker: LegacyMigrationMarker | null): LegacyDataInfo =>
    deriveLegacyInfo(marker, {
      backupPath: legacyBackupFile(),
      backupExists: existsSync,
      remoteEnabled: hooks.remoteEnabled(),
      platform: process.platform,
    })

  ipcMain.handle(CH.APP_LEGACY_INFO, (): LegacyDataInfo => info(currentLegacyMarker()))

  ipcMain.on(CH.APP_LEGACY_ACK, () => {
    ackLegacyNotice()
  })

  ipcMain.on(CH.APP_LEGACY_SHOW_BACKUP, () => {
    const file = legacyBackupFile()
    if (existsSync(file)) shell.showItemInFolder(file)
  })

  ipcMain.on(CH.APP_LEGACY_OPEN_LOG, () => {
    const file = legacyLogFile()
    if (existsSync(file)) void shell.openPath(file)
  })

  return onLegacyStatus((marker) => {
    const wc = hooks.getSender()
    if (wc && !wc.isDestroyed()) wc.send(CH.APP_LEGACY_STATUS, info(marker))
  })
}
