/**
 * Which per-pane actions the phone offers (E1-FR-33, E5-FR-11, E2-FR-08/49),
 * in the order of E2-FR-08: Rename, Restart, Relaunch resuming, New chat,
 * Show on the PC, Copy title and Close. "Relaunch resuming" and "New chat"
 * only show when the desktop marked the pane `resumable` (D10): an agent pane
 * with no SSH Connection Profile and a resumable last session. Absent means
 * hide both, so an older desktop that never sends the field keeps the plain menu.
 */
import type { RemoteCtlAction, RemotePaneInfo } from '@shared/remote-protocol'

export type PaneActionId = 'rename' | 'restart' | 'restartResume' | 'restartFresh' | 'reveal' | 'copyTitle' | 'close'

export function paneActionIds(pane: Pick<RemotePaneInfo, 'resumable'>, opts: { rename?: boolean } = {}): PaneActionId[] {
  const ids: PaneActionId[] = []
  if (opts.rename !== false) ids.push('rename')
  ids.push('restart')
  if (pane.resumable === true) ids.push('restartResume', 'restartFresh')
  ids.push('reveal', 'copyTitle', 'close')
  return ids
}

/** The ctl a restart row sends: resume true/false for the two resume rows, absent for plain Restart. */
export function restartAction(
  workspaceId: string,
  paneId: string,
  id: 'restart' | 'restartResume' | 'restartFresh',
): Extract<RemoteCtlAction, { kind: 'restartPane' }> {
  if (id === 'restartResume') return { kind: 'restartPane', workspaceId, paneId, resume: true }
  if (id === 'restartFresh') return { kind: 'restartPane', workspaceId, paneId, resume: false }
  return { kind: 'restartPane', workspaceId, paneId }
}
