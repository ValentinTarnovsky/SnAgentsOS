/**
 * Pure snapshot selectors for the phone (E1-FR-06/07, E2-FR-04/06/47). The
 * workspace the phone is looking at is the one that owns the viewed pane,
 * never the desktop's active workspace: navigation is phone-only and opening
 * a console never moves the desktop. activeWorkspaceId only feeds the "On the
 * PC" chip and the last default of the new-console picker.
 */
import type { RemotePaneInfo, RemotePaneStatus, RemoteStateSnapshot } from '@shared/remote-protocol'

export function workspaceOfPane(snap: RemoteStateSnapshot, paneId: string): string | null {
  const ws = snap.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
  return ws ? ws.id : null
}

export function paneById(snap: RemoteStateSnapshot, paneId: string | null): RemotePaneInfo | null {
  if (!paneId) return null
  for (const ws of snap.workspaces) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (pane) return pane
  }
  return null
}

/** The workspace of the viewed pane (E2-FR-47); null on Home with nothing viewed. */
export function viewedWorkspaceId(snap: RemoteStateSnapshot, activePaneId: string | null): string | null {
  return activePaneId ? workspaceOfPane(snap, activePaneId) : null
}

/**
 * Whether the desktop has every console of the workspace mounted (D4). A
 * snapshot without the field (an older desktop) counts only its active one.
 */
export function isWorkspaceMounted(snap: RemoteStateSnapshot, workspaceId: string): boolean {
  if (snap.mountedWorkspaceIds) return snap.mountedWorkspaceIds.includes(workspaceId)
  return snap.activeWorkspaceId === workspaceId
}

/**
 * Whether the phone can open `paneId` as is (E2-FR-06): a running pane streams
 * from its pty wherever it lives, and a stopped one of a mounted workspace is
 * one the desktop already shows (exited) or is spawning. Any other needs the
 * user to confirm `mountWorkspace` first. False for a pane not in the snapshot.
 */
export function paneOpenable(snap: RemoteStateSnapshot, paneId: string): boolean {
  const pane = paneById(snap, paneId)
  if (!pane) return false
  if (pane.running) return true
  const wsId = workspaceOfPane(snap, paneId)
  return wsId != null && isWorkspaceMounted(snap, wsId)
}

export interface PaneRef {
  workspaceId: string
  paneId: string
}

/** Panes of a workspace in display order (layoutOrder first, then the rest). */
export function orderedPanes(ws: RemoteStateSnapshot['workspaces'][number]): RemotePaneInfo[] {
  const byId = new Map(ws.panes.map((p) => [p.id, p]))
  const out: RemotePaneInfo[] = []
  for (const id of ws.layoutOrder) {
    const pane = byId.get(id)
    if (pane) {
      out.push(pane)
      byId.delete(id)
    }
  }
  for (const pane of byId.values()) out.push(pane)
  return out
}

/**
 * Every pane waiting on the user (state 'action'), in workspace order and then
 * layoutOrder, excluding the one being viewed (E1-FR-06).
 */
export function waitingPanes(
  snap: RemoteStateSnapshot,
  statuses: Record<string, RemotePaneStatus>,
  activePaneId: string | null,
): PaneRef[] {
  const out: PaneRef[] = []
  for (const ws of snap.workspaces) {
    for (const pane of orderedPanes(ws)) {
      if (pane.id !== activePaneId && statuses[pane.id]?.state === 'action') out.push({ workspaceId: ws.id, paneId: pane.id })
    }
  }
  return out
}

/**
 * The next waiting pane after the viewed one, cycling through the global
 * order (workspace, then layoutOrder) and wrapping around.
 */
export function nextWaitingPane(
  snap: RemoteStateSnapshot,
  statuses: Record<string, RemotePaneStatus>,
  activePaneId: string | null,
): PaneRef | null {
  const all: PaneRef[] = []
  for (const ws of snap.workspaces) for (const pane of orderedPanes(ws)) all.push({ workspaceId: ws.id, paneId: pane.id })
  const start = activePaneId ? all.findIndex((r) => r.paneId === activePaneId) : -1
  for (let i = 1; i <= all.length; i++) {
    const ref = all[(start + i + all.length) % all.length]
    if (ref.paneId !== activePaneId && statuses[ref.paneId]?.state === 'action') return ref
  }
  return null
}

/** Rebuild the status map from a snapshot's panes[].status (authOk / state). */
export function statusMapOf(snap: RemoteStateSnapshot): Record<string, RemotePaneStatus> {
  const map: Record<string, RemotePaneStatus> = {}
  for (const ws of snap.workspaces) for (const pane of ws.panes) if (pane.status) map[pane.id] = pane.status
  return map
}

/** Longest pane title a tab chip shows before it is cut (E1-FR-32). */
export const TAB_TITLE_MAX = 18

/** A pane title cut to `max` characters (code points) with an ellipsis. */
export function tabTitle(title: string, max = TAB_TITLE_MAX): string {
  const chars = Array.from(title.trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, max - 1).join('').trimEnd() + '\u2026'
}

/** Panes of the workspace the phone is looking at, in tab order (E1-FR-32). */
export function tabPanes(snap: RemoteStateSnapshot, activePaneId: string | null): { workspaceId: string | null; panes: RemotePaneInfo[] } {
  const workspaceId = viewedWorkspaceId(snap, activePaneId)
  const ws = snap.workspaces.find((w) => w.id === workspaceId)
  return { workspaceId: ws ? ws.id : null, panes: ws ? orderedPanes(ws) : [] }
}

// --- Home rows (E2-FR-04/05) ---

/**
 * Unread (E2-FR-05): the console sits in action, done or error since a moment
 * this phone has not seen it (lastViewedAt is stamped at least at stateSince
 * when viewed, so the two clocks never disagree about a view).
 */
export function isUnread(status: RemotePaneStatus | undefined, lastViewedAt: number | undefined): boolean {
  if (!status) return false
  if (status.state !== 'action' && status.state !== 'done' && status.state !== 'error') return false
  return status.stateSince > (lastViewedAt ?? 0)
}

/** action > error > unread done > working > the rest (E2-FR-04). */
export function rowRank(status: RemotePaneStatus | undefined, unread: boolean): number {
  switch (status?.state) {
    case 'action':
      return 0
    case 'error':
      return 1
    case 'done':
      return unread ? 2 : 4
    case 'working':
      return 3
    default:
      return 4
  }
}

/**
 * A workspace's consoles in Home order (E2-FR-04): by rank, then layoutOrder.
 * Stable by construction: two rows only swap when a status changes.
 */
export function homeRows(
  ws: RemoteStateSnapshot['workspaces'][number],
  statuses: Record<string, RemotePaneStatus>,
  lastViewedAt: Record<string, number>,
): RemotePaneInfo[] {
  const ordered = orderedPanes(ws)
  const rank = new Map(ordered.map((p) => [p.id, rowRank(statuses[p.id], isUnread(statuses[p.id], lastViewedAt[p.id]))]))
  return ordered
    .map((pane, index) => ({ pane, index }))
    .sort((a, b) => (rank.get(a.pane.id) ?? 4) - (rank.get(b.pane.id) ?? 4) || a.index - b.index)
    .map((x) => x.pane)
}

/** Consoles of a workspace in action: the red badge of its header (E2-FR-04). */
export function actionCount(ws: RemoteStateSnapshot['workspaces'][number], statuses: Record<string, RemotePaneStatus>): number {
  return ws.panes.reduce((n, p) => (statuses[p.id]?.state === 'action' ? n + 1 : n), 0)
}
