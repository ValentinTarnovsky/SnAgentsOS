import type { PaneStatus, Workspace } from './types'

/** This same visibility rule drives notifications, badges and acknowledgement. */
export function visiblePaneIds(workspace: Workspace | undefined, minimized: string[], maximized?: string | null): string[] {
  return workspace?.panes.filter(p => !minimized.includes(p.id) && (!maximized || maximized === p.id)).map(p => p.id) ?? []
}

const priority: Record<PaneStatus['state'], number> = { error: 6, action: 5, working: 4, unknown: 3, done: 2, idle: 1 }
export function aggregateStatus(statuses: Array<PaneStatus | undefined>): PaneStatus | undefined {
  return statuses.reduce<PaneStatus | undefined>((best, status) =>
    status && (!best || priority[status.state] > priority[best.state]) ? status : best, undefined)
}
