import type { Workspace } from '@shared/types'
import { gridForCount, orderPanes } from '@/components/layout/gridTemplates'

/**
 * "Move to workspace" is a view convenience of this session only: a console
 * shown in another workspace still belongs to its home. The home is kept in
 * the store's transient `paneHome`, and every reader that outlives the
 * session (config.json, export, reopen after close) sees the console back at
 * home, at the slot it had there.
 */
export interface PaneHome {
  workspaceId: string
  /** Slot the console had in the home workspace's order. */
  orderIndex: number
}

export type PaneHomes = Record<string, PaneHome>

/**
 * `workspaces` with one console moved into `toWsId` (at `toIndex` of its
 * order, else last), in one new array so the pane id never leaves the union
 * of all workspaces (ptyLifecycle would kill its pty). Null when the pane or
 * the target does not exist, or it is already there.
 */
export function transferPane(workspaces: readonly Workspace[], paneId: string, toWsId: string, toIndex?: number): Workspace[] | null {
  const from = workspaces.find((w) => w.panes.some((p) => p.id === paneId))
  const to = workspaces.find((w) => w.id === toWsId)
  if (!from || !to || from === to) return null
  const pane = from.panes.find((p) => p.id === paneId)!
  return workspaces.map((w) => {
    if (w === from) {
      const panes = w.panes.filter((p) => p.id !== paneId)
      const order = orderPanes(w.panes, w.layout?.order).map((p) => p.id).filter((id) => id !== paneId)
      return { ...w, panes, layout: { grid: gridForCount(panes.length), order } }
    }
    if (w === to) {
      const panes = [...w.panes, pane]
      const order = orderPanes(w.panes, w.layout?.order).map((p) => p.id)
      order.splice(toIndex === undefined ? order.length : Math.max(0, Math.min(toIndex, order.length)), 0, paneId)
      return { ...w, panes, layout: { grid: gridForCount(panes.length), order } }
    }
    return w
  })
}

/** Slot of a console in its workspace's order as rendered (0 when absent). */
export function orderIndexOf(ws: Workspace, paneId: string): number {
  return Math.max(0, orderPanes(ws.panes, ws.layout?.order).findIndex((p) => p.id === paneId))
}

/**
 * `workspaces` with every moved console back at its home (what config.json
 * and an export get). A console whose home was deleted stays where it is.
 */
export function withPanesHome(workspaces: Workspace[], homes: PaneHomes): Workspace[] {
  let out = workspaces
  for (const [paneId, home] of Object.entries(homes)) {
    out = transferPane(out, paneId, home.workspaceId, home.orderIndex) ?? out
  }
  return out
}
