import type { Workspace } from '@shared/types'

/**
 * The single source of the sidebar's workspace order (E5 G3): favorites float
 * to the top, stable within each group. The Sidebar renders it and Alt+1..9,
 * next/previous workspace use it, so the numbers always match what is on
 * screen. The Smart order (E5-FR-22) plugs in here.
 */
export function sidebarOrder(workspaces: readonly Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0))
}
