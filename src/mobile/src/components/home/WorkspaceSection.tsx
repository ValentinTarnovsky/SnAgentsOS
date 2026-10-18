/**
 * One workspace on Home (E2-FR-04, 09, 15, 50). The header shows the chevron,
 * the name, how many consoles it has, a red badge with the ones in action
 * (visible while collapsed too), the "On the PC" chip when it is the desktop's
 * active workspace, the git chip under the name and a kebab. A tap on the
 * header collapses or expands it (persisted in snagentsos.home.collapsed;
 * everything starts expanded). Rows follow homeRows: action > error > unread
 * done > working > the rest, layoutOrder inside each rank.
 */
import { memo, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronDown, ChevronRight, MoreVertical } from 'lucide-react'
import type { RemotePaneStatus, RemoteWorkspaceInfo } from '@shared/remote-protocol'
import { ConsoleRow } from './ConsoleRow'
import { GitChip } from './GitChip'
import { NoConsoles } from './EmptyStates'
import { actionCount, homeRows, isUnread } from '../../lib/workspace'
import { t } from '../../lib/i18n'

export interface WorkspaceSectionProps {
  ws: RemoteWorkspaceInfo
  statuses: Record<string, RemotePaneStatus>
  lastViewedAt: Record<string, number>
  collapsed: boolean
  /** The desktop shows this workspace right now ("On the PC" chip). */
  onPc: boolean
  mounted: boolean
  viewedPaneId: string | null
  now: number
  onToggle: (workspaceId: string) => void
  onMenu: (workspaceId: string) => void
  onNew: (workspaceId: string) => void
  onOpen: (paneId: string) => void
  onActions: (workspaceId: string, paneId: string) => void
}

function WorkspaceSectionImpl(props: WorkspaceSectionProps): ReactNode {
  const { ws, statuses, lastViewedAt, collapsed, onPc, mounted, viewedPaneId, now } = props
  const waiting = actionCount(ws, statuses)
  const rows = collapsed ? [] : homeRows(ws, statuses, lastViewedAt)
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <section data-workspace={ws.id} data-collapsed={collapsed} className="mb-4">
      <div className="mb-1.5 flex items-center gap-1">
        <button
          data-ws-toggle
          onClick={() => props.onToggle(ws.id)}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'home.expand' : 'home.collapse', { ws: ws.name })}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-btn px-1 text-left active:bg-card"
        >
          <Chevron size={16} className="shrink-0 text-text-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-semibold uppercase tracking-wide text-text-primary">{ws.name}</span>
              <span data-ws-count className="shrink-0 text-[11px] text-text-secondary">{ws.panes.length}</span>
              {waiting > 0 && (
                <span
                  data-ws-badge={waiting}
                  aria-label={t('home.actionBadge', { n: waiting })}
                  className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white"
                >
                  {waiting}
                </span>
              )}
              {onPc && (
                <span data-on-pc className="shrink-0 rounded-full bg-card px-1.5 py-0.5 text-[10px] font-medium text-text-secondary ring-1 ring-border">
                  {t('home.onPc')}
                </span>
              )}
            </span>
            <GitChip git={ws.git} />
          </span>
        </button>
        <button
          data-ws-menu
          onClick={() => props.onMenu(ws.id)}
          aria-label={t('home.wsMenu')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-card"
        >
          <MoreVertical size={18} />
        </button>
      </div>
      {!collapsed && (
        <div className={clsx('flex flex-col gap-1')}>
          {ws.panes.length === 0 ? (
            <NoConsoles onNew={() => props.onNew(ws.id)} />
          ) : (
            rows.map((pane) => (
              <ConsoleRow
                key={pane.id}
                pane={pane}
                workspaceId={ws.id}
                status={statuses[pane.id]}
                unread={isUnread(statuses[pane.id], lastViewedAt[pane.id])}
                mounted={mounted}
                viewed={pane.id === viewedPaneId}
                now={now}
                onOpen={props.onOpen}
                onActions={props.onActions}
              />
            ))
          )}
        </div>
      )}
    </section>
  )
}

export const WorkspaceSection = memo(WorkspaceSectionImpl)
