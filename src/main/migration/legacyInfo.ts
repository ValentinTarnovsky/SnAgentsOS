import type { LegacyDataInfo, LegacyManualAction, LegacyPhase as SharedLegacyPhase } from '@shared/ipc-contract'
import { isCommittedPhase, LEGACY_ITEM_IDS, type LegacyMigrationMarker, type LegacyPhase } from './legacyMarker'

/**
 * Renderer view of the marker (E0-FR-10, 28, 35). Pure: main feeds it the
 * marker, where the zip lives and what the config says, so the welcome notice,
 * the banners and the Settings > Data line all read one derivation.
 */

// The shared union mirrors LEGACY_PHASES; a drift on either side fails the typecheck.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const phasesInSync: Same<LegacyPhase, SharedLegacyPhase> = true
void phasesInSync

/** Starts with something still deferred before the "leftovers in use" banner shows. */
export const DEFERRED_BANNER_STARTS = 5

/**
 * What the user does about an item left skipped: needsElevation. Windows only
 * flags Program Files or an HKLM entry (a per-machine 1.x: uninstall it), macOS
 * only a bundle under /Applications (move it to the Trash). Linux has no such
 * line: the old .deb is documented in the README and nothing else asks for root.
 */
function manualActionFor(platform: NodeJS.Platform): LegacyManualAction | null {
  if (platform === 'win32') return 'uninstallPerMachine'
  if (platform === 'darwin') return 'trashMacApp'
  return null
}

export interface LegacyInfoInput {
  /** Where migration-backup-v1.zip lives (dataDir()). */
  backupPath: string
  backupExists(path: string): boolean
  remoteEnabled: boolean
  platform: NodeJS.Platform
}

export function emptyLegacyInfo(): LegacyDataInfo {
  return {
    phase: null,
    outcome: null,
    counts: null,
    cleanup: { pending: 0, deferred: 0, done: 0, skipped: 0 },
    showDeferredBanner: false,
    failure: null,
    backup: null,
    pinRetargeted: null,
    manualActions: [],
    firewallHint: false,
    noticeSeen: false,
  }
}

export function deriveLegacyInfo(marker: LegacyMigrationMarker | null, input: LegacyInfoInput): LegacyDataInfo {
  if (!marker) return emptyLegacyInfo()
  const cleanup = { pending: 0, deferred: 0, done: 0, skipped: 0 }
  const manual = new Set<LegacyManualAction>()
  // Before the commit nothing is scheduled yet: the items only exist once committed.
  if (isCommittedPhase(marker.phase)) {
    for (const id of LEGACY_ITEM_IDS) {
      const item = marker.cleanup[id]
      const state = item?.state ?? 'pending'
      if (state === 'done' || state === 'absent') cleanup.done++
      else cleanup[state]++
      const action = state === 'skipped' && item?.reason === 'needsElevation' ? manualActionFor(input.platform) : null
      if (action) manual.add(action)
    }
  }
  const counts = marker.verified
    ? { workspaces: marker.verified.workspaces, presets: marker.verified.presets, devices: marker.verified.devices, backups: marker.verified.backups }
    : null
  const b = marker.backup
  const backup = b && b.deletedAt === undefined && input.backupExists(input.backupPath) ? { path: input.backupPath, expiresAt: b.expiresAt } : null
  return {
    phase: marker.phase,
    outcome: marker.outcome ?? null,
    counts,
    cleanup,
    showDeferredBanner: cleanup.deferred > 0 && marker.cleanupStarts >= DEFERRED_BANNER_STARTS,
    failure: marker.phase === 'failed' ? { phase: marker.lastError?.phase ?? 'failed', attempts: marker.attempts } : null,
    backup,
    pinRetargeted: marker.pinRetargeted ?? null,
    manualActions: [...manual],
    firewallHint: input.platform === 'win32' && (input.remoteEnabled || (counts?.devices ?? 0) > 0),
    noticeSeen: marker.noticeSeen,
  }
}
