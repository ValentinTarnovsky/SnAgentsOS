/**
 * Which per-pane actions the phone offers (E1-FR-33, E5-FR-11, E2-FR-08/49),
 * in the order of E2-FR-08: Rename, Restart, Relaunch resuming, New chat,
 * Show on the PC, Copy title and Close. "Relaunch resuming" and "New chat"
 * only show when the desktop marked the pane `resumable` (D10): an agent pane
 * with no SSH Connection Profile and a resumable last session. Absent means
 * hide both, so an older desktop that never sends the field keeps the plain menu.
 *
 * App 2.7.0 (A8): the status marks go first, on a console with an agent
 * status and only for a desktop >= 2.7.0 (an older one strikes the unknown
 * ctl kinds): Mark as read for a done or error turn, Mute until it changes
 * or Unmute, and Ignore this turn while its agent is silent.
 */
import type { RemoteCtlAction, RemotePaneInfo, RemotePaneStatus } from '@shared/remote-protocol'
import { APP_2_7_0, appVersionAtLeast } from '@shared/agentTune'

export type StatusMarkId = 'markRead' | 'mute' | 'unmute' | 'silenceAck'

export type PaneActionId = StatusMarkId | 'rename' | 'restart' | 'restartResume' | 'restartFresh' | 'reveal' | 'copyTitle' | 'close'

export interface PaneActionOpts {
  rename?: boolean
  /** App 2.7.0: the console's live status, for the status marks. */
  status?: RemotePaneStatus
  /** App 2.7.0: the desktop handles markRead, mutePane and silenceAck (statusMarksSupported). */
  marks?: boolean
}

/** The desktop handles the status mark ctls (app 2.7.0). */
export function statusMarksSupported(appVersion: string | undefined): boolean {
  return appVersionAtLeast(appVersion, APP_2_7_0)
}

/** The status marks of one console; none without an agent status (a bare `snaos needs` included). */
export function statusMarkIds(status: RemotePaneStatus | undefined): StatusMarkId[] {
  if (!status || status.bare) return []
  const ids: StatusMarkId[] = []
  if (status.state === 'done' || status.state === 'error') ids.push('markRead')
  ids.push(status.muted === true ? 'unmute' : 'mute')
  if (status.silence) ids.push('silenceAck')
  return ids
}

export function paneActionIds(pane: Pick<RemotePaneInfo, 'resumable'>, opts: PaneActionOpts = {}): PaneActionId[] {
  const ids: PaneActionId[] = opts.marks ? statusMarkIds(opts.status) : []
  if (opts.rename !== false) ids.push('rename')
  ids.push('restart')
  if (pane.resumable === true) ids.push('restartResume', 'restartFresh')
  ids.push('reveal', 'copyTitle', 'close')
  return ids
}

/** The ctl a status mark sends (handled in main, never relayed). */
export function statusMarkAction(paneId: string, id: StatusMarkId): RemoteCtlAction {
  if (id === 'markRead') return { kind: 'markRead', paneId }
  if (id === 'silenceAck') return { kind: 'silenceAck', paneId }
  return { kind: 'mutePane', paneId, muted: id === 'mute' }
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
