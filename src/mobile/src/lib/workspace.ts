/**
 * Pure snapshot selectors for the phone (E1-FR-06/07, E2-FR-04/06/47). The
 * workspace the phone is looking at is the one that owns the viewed pane,
 * never the desktop's active workspace: navigation is phone-only and opening
 * a console never moves the desktop. activeWorkspaceId only feeds the "On the
 * PC" chip and the last default of the new-console picker.
 */
import type { RemotePaneInfo, RemotePaneStatus, RemoteStateSnapshot, RemoteWorkspaceInfo } from '@shared/remote-protocol'
import { needsYou, needsYouCount, needsYouRows, type AttentionItem, type NeedsYouRow } from '@shared/attention'

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

// --- "Needs you" (app 2.7.0, A8): the desktop's rule, src/shared/attention.ts ---

/** One console of the snapshot as the shared "needs you" rule reads it, with what a row renders. */
export interface PhoneAttentionItem extends AttentionItem {
  pane: RemotePaneInfo
  workspaceName: string
  status?: RemotePaneStatus
}

/**
 * Every console of these workspaces, in Home order (workspace, then
 * layoutOrder), with its live status. The phone has neither the desktop's
 * local mark (`marked`) nor its sleep list (`dormant`): a sleeping console
 * carries no status, so it never counts either way.
 */
export function attentionItems(workspaces: readonly RemoteWorkspaceInfo[], statuses: Record<string, RemotePaneStatus>): PhoneAttentionItem[] {
  const out: PhoneAttentionItem[] = []
  for (const ws of workspaces) {
    for (const pane of orderedPanes(ws)) out.push({ paneId: pane.id, workspaceId: ws.id, workspaceName: ws.name, pane, status: statuses[pane.id] })
  }
  return out
}

/** The consoles that need the user across every workspace, most urgent first (Home's "Waiting for you"). */
export function needsYouPanes(snap: RemoteStateSnapshot, statuses: Record<string, RemotePaneStatus>): NeedsYouRow<PhoneAttentionItem>[] {
  return needsYouRows(attentionItems(snap.workspaces, statuses))
}

/**
 * Every pane that needs the user (the shared rule: an open request, a done
 * or error nobody saw, a `snaos needs`; muted ones out), in workspace order
 * and then layoutOrder, excluding the one being viewed (E1-FR-06).
 */
export function waitingPanes(
  snap: RemoteStateSnapshot,
  statuses: Record<string, RemotePaneStatus>,
  activePaneId: string | null,
): PaneRef[] {
  return attentionItems(snap.workspaces, statuses)
    .filter((item) => item.paneId !== activePaneId && needsYou(item))
    .map((item) => ({ workspaceId: item.workspaceId, paneId: item.paneId }))
}

/**
 * The next pane that needs the user after the viewed one, cycling through
 * the global order (workspace, then layoutOrder) and wrapping around.
 */
export function nextWaitingPane(
  snap: RemoteStateSnapshot,
  statuses: Record<string, RemotePaneStatus>,
  activePaneId: string | null,
): PaneRef | null {
  const all = attentionItems(snap.workspaces, statuses)
  const start = activePaneId ? all.findIndex((r) => r.paneId === activePaneId) : -1
  for (let i = 1; i <= all.length; i++) {
    const item = all[(start + i + all.length) % all.length]
    if (item.paneId !== activePaneId && needsYou(item)) return { workspaceId: item.workspaceId, paneId: item.paneId }
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
 * this phone has not seen it (lastViewedAt holds the stateSince of the state
 * last seen, so both sides of the comparison use the desktop clock).
 * v2.3: never with the desktop's attention false (seen or answered on any device).
 */
export function isUnread(status: RemotePaneStatus | undefined, lastViewedAt: number | undefined): boolean {
  if (!status || status.attention === false) return false
  if (status.state !== 'action' && status.state !== 'done' && status.state !== 'error') return false
  return status.stateSince > (lastViewedAt ?? 0)
}

/**
 * action > error > unread done > working > the rest (E2-FR-04). v2.3: an
 * answered action ranks as working and an acknowledged error as the rest.
 * App 2.7.0: a `snaos needs` not muted ranks as an open request, whatever
 * the state (the shared rule's rank 1), a bare status (no agent) included.
 */
export function rowRank(status: RemotePaneStatus | undefined, unread: boolean): number {
  if (status?.needs && status.muted !== true) return 0
  switch (status?.state) {
    case 'action':
      // A muted request still open ranks like the desktop board: with the idle ones (app 2.7.0).
      return status.attention === false ? (status.muted === true ? 4 : 3) : 0
    case 'error':
      return status.attention === false ? 4 : 1
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

/**
 * Consoles of a workspace that need the user: the red badge of its header
 * (E2-FR-04; app 2.7.0: the shared rule, the desktop sidebar badge's count).
 */
export function actionCount(ws: RemoteWorkspaceInfo, statuses: Record<string, RemotePaneStatus>): number {
  return needsYouCount(attentionItems([ws], statuses))
}

/**
 * Workspace menu "Mark all read" (app 2.7.0): its done and error consoles
 * not seen yet (`attention` not false), muted ones included (main publishes
 * a muted console with `attention: false`, so it may be unread under the
 * mute). Main's markRead does nothing for one already seen.
 */
export function markReadTargets(ws: RemoteWorkspaceInfo, statuses: Record<string, RemotePaneStatus>): string[] {
  return orderedPanes(ws)
    .filter((p) => {
      const st = statuses[p.id]
      if (!st || st.bare || (st.state !== 'done' && st.state !== 'error')) return false
      return st.attention !== false || st.muted === true
    })
    .map((p) => p.id)
}
