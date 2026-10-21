import type { ClaudePaneState, PaneStatus, Workspace } from './types'

/** This same visibility rule drives notifications, badges and acknowledgement. */
export function visiblePaneIds(workspace: Workspace | undefined, minimized: string[], maximized?: string | null): string[] {
  return workspace?.panes.filter(p => !minimized.includes(p.id) && (!maximized || maximized === p.id)).map(p => p.id) ?? []
}

const priority: Record<PaneStatus['state'], number> = { error: 6, action: 5, working: 4, unknown: 3, done: 2, idle: 1 }
export function aggregateStatus(statuses: Array<PaneStatus | undefined>): PaneStatus | undefined {
  return statuses.reduce<PaneStatus | undefined>((best, status) =>
    status && (!best || priority[status.state] > priority[best.state]) ? status : best, undefined)
}

// --- v2.3 attention (main's derived `attention`; absent = legacy rules) ---

/** The console waits on the user's answer: `action` that main did not mark as answered. */
export function waitsOnUser(s: { state: ClaudePaneState | null; attention?: boolean } | null | undefined): boolean {
  return !!s && s.state === 'action' && s.attention !== false
}

/** The console needs the user (sidebar badge): main's attention, or open requests without it. */
export function needsUser(s: { attention?: boolean; pendingCount?: number } | null | undefined): boolean {
  if (!s) return false
  return s.attention ?? (s.pendingCount ?? 0) > 0
}

/**
 * The status as a glyph shows it: an `action` already answered (attention
 * false) reads as `working` while the agent goes on, or `idle` for a
 * title-only track (its request was a turn that ended). The same object
 * otherwise.
 */
export function displayStatus<T extends { state: ClaudePaneState | null; attention?: boolean; precise?: boolean } | null | undefined>(s: T): T {
  if (!s || s.state !== 'action' || s.attention !== false) return s
  return { ...s, state: s.precise === false ? 'idle' : 'working' }
}
