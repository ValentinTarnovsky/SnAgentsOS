import { create } from 'zustand'
import type { Workspace } from '@shared/types'
import { compareAgents, type AgentSessionView, type RankedPane } from '@shared/agents'
import { navInputFrom, workspaceAgents, type NavInput } from './agentNav'

/**
 * The single source of the sidebar's workspace order (E5 G3): favorites float
 * to the top, stable within each group. The Sidebar renders it and Alt+1..9,
 * next/previous workspace use it, so the numbers always match what is on
 * screen.
 *
 * Smart order (E5-FR-22, `settings.agents.sidebarSort: 'smart'`): inside each
 * group, workspaces go by their most demanding agent console (the palette's
 * urgency rank, ties by how long it has been in that state; app 2.7.0: a
 * `snaos needs` not muted ranks first, as workspaceAgents applies the shared
 * "needs you" rule of src/shared/attention.ts); workspaces
 * without agents keep their manual order after them. While the pointer is
 * over the sidebar or the keyboard focus is inside it, the order is frozen
 * (`frozen`), so a row never jumps away from under the user.
 */
export interface SidebarOrderOpts {
  sort?: 'manual' | 'smart'
  /** Agent state the smart order ranks by. */
  nav?: NavInput
  /** Workspace ids in the order shown when the freeze started. */
  frozen?: readonly string[] | null
}

/** Most demanding agent console of a workspace, or null when it has none. */
function bestAgent(ws: Workspace, nav: NavInput): RankedPane | null {
  let best: RankedPane | null = null
  for (const e of workspaceAgents(ws, nav)) if (!best || compareAgents(e, best) < 0) best = e
  return best
}

/** compareAgents without its id tie-break: equal urgency keeps the manual order. */
function compareUrgency(a: RankedPane, b: RankedPane): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.rank === 2 && a.unread !== b.unread) return a.unread ? -1 : 1
  return a.rank <= 2 ? a.stateSince - b.stateSince : b.stateSince - a.stateSince
}

export function sidebarOrder(workspaces: readonly Workspace[], opts: SidebarOrderOpts = {}): Workspace[] {
  const manual = new Map(workspaces.map((w, i) => [w.id, i]))
  const byManual = (a: Workspace, b: Workspace): number => manual.get(a.id)! - manual.get(b.id)!
  let within = byManual
  if (opts.sort === 'smart' && opts.nav) {
    if (opts.frozen) {
      // New workspaces (not on screen when the freeze started) go last.
      const pos = new Map(opts.frozen.map((id, i) => [id, i]))
      const at = (w: Workspace): number => pos.get(w.id) ?? opts.frozen!.length + manual.get(w.id)!
      within = (a, b) => at(a) - at(b)
    } else {
      const nav = opts.nav
      const best = new Map(workspaces.map((w) => [w.id, bestAgent(w, nav)]))
      within = (a, b) => {
        const x = best.get(a.id), y = best.get(b.id)
        if (x && y) return compareUrgency(x, y) || byManual(a, b)
        if (x || y) return x ? -1 : 1
        return byManual(a, b)
      }
    }
  }
  return [...workspaces].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || within(a, b))
}

/**
 * Display order after dropping workspace `dragId` into gap `to` (0 = above
 * the first row, n = below the last) of `shown`, the order on screen. The
 * drop stays inside the workspace's group: favorites always come first, so a
 * plain workspace never lands above a favorite or the other way round. Null
 * when nothing changes.
 */
export function dropWorkspace(shown: readonly Workspace[], dragId: string, to: number): string[] | null {
  const ids = shown.map((w) => w.id)
  const from = ids.indexOf(dragId)
  if (from === -1) return null
  const favCount = shown.filter((w) => w.favorite).length
  const [lo, hi] = shown[from].favorite ? [0, favCount] : [favCount, ids.length]
  let gap = Math.max(lo, Math.min(to, hi))
  if (gap > from) gap -= 1
  if (gap === from) return null
  ids.splice(from, 1)
  ids.splice(gap, 0, dragId)
  return ids
}

/** Freeze of the smart order while the sidebar has the pointer or the focus. */
export const useSidebarFreeze = create<{ frozen: string[] | null }>(() => ({ frozen: null }))

/** Freezes the order shown now (`ids`); a freeze already in place is kept. */
export function freezeSidebarOrder(ids: string[]): void {
  if (!useSidebarFreeze.getState().frozen) useSidebarFreeze.setState({ frozen: ids })
}

/** Lifts the freeze: the next render applies the live smart order. */
export function releaseSidebarOrder(): void {
  if (useSidebarFreeze.getState().frozen) useSidebarFreeze.setState({ frozen: null })
}

/** The order on screen right now, from the stores' current values (Alt+1..9, next/previous workspace). */
export function liveSidebarOrder(
  app: Parameters<typeof navInputFrom>[0] & { settings: { agents?: { sidebarSort?: 'manual' | 'smart' } } },
  agents: { sessions: Record<string, AgentSessionView> },
): Workspace[] {
  if (app.settings.agents?.sidebarSort !== 'smart') return sidebarOrder(app.workspaces)
  return sidebarOrder(app.workspaces, { sort: 'smart', nav: navInputFrom(app, agents), frozen: useSidebarFreeze.getState().frozen })
}
