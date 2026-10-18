/**
 * Pure snapshot selectors for the phone (E1-FR-06/07). The workspace the phone
 * is looking at is the one that owns the viewed pane, which may differ from
 * the desktop's active workspace: opening a running pane of another workspace
 * never moves the desktop. Every consumer that used snapshot.activeWorkspaceId
 * to act on "the current workspace" goes through viewedWorkspaceId instead.
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

/** The workspace of the viewed pane, else the desktop's active one. */
export function viewedWorkspaceId(snap: RemoteStateSnapshot, activePaneId: string | null): string | null {
  return (activePaneId ? workspaceOfPane(snap, activePaneId) : null) ?? snap.activeWorkspaceId
}

/**
 * Whether opening `paneId` needs the desktop to switch workspace first. A
 * running pane is streamed from its pty wherever it lives, so the desktop stays
 * put. A pane without a pty (or not in the snapshot yet, e.g. just created)
 * spawns lazily when the renderer mounts its workspace, so that one still
 * needs the switch unless the desktop already shows that workspace.
 */
export function needsWorkspaceSwitch(snap: RemoteStateSnapshot | null, workspaceId: string, paneId: string): boolean {
  if (!snap) return true
  const pane = paneById(snap, paneId)
  if (pane?.running) return false
  return (pane ? workspaceOfPane(snap, paneId) : workspaceId) !== snap.activeWorkspaceId
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
