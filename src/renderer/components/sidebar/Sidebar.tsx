import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Pencil,
  Plus,
  Settings,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { ActionTooltipLabel, KeyHint, useActionKeys } from '@/components/ui/KeyHint'
import { ariaKeyshortcuts } from '@/lib/keymap'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { UsageBars } from '@/components/sidebar/UsageBars'
import { RemoteIndicator } from '@/components/sidebar/RemoteIndicator'
import { iconFor } from '@/lib/icons'
import { focusWorkspaceConsole } from '@/lib/focusWorkspace'
import { cn } from '@/lib/cn'
import { StatusDot } from '@/components/ui/StatusDot'
import { aggregateStatus } from '@shared/status'
import type { PaneStatus, Workspace } from '@shared/types'
import { useAgentStore } from '@/lib/agentStore'
import { navInputFrom, workspaceAgents } from '@/lib/agentNav'
import { formatSince, STATUS_LABEL_KEY } from '@/lib/formatSince'
import { sidebarOrder } from '@/lib/sidebarOrder'
import { useLang, type MessageKey } from '@/i18n'
import { AgentRows } from '@/components/sidebar/AgentRows'
import { ExitedDot, allExited, exitedLines } from '@/components/sidebar/ExitedDot'

interface MenuState {
  x: number
  y: number
  wsId: string
}

/** Discord-style unread pill: consoles in this workspace awaiting the user. */
function AttentionBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <span
      className={cn(
        'flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#EF4444] px-1 text-[11px] font-semibold leading-none text-white',
        className,
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

/** Most console lines in a workspace's combined tooltip before "+N" (E4-FR-11). */
const TIP_MAX_LINES = 8

const SUMMARY_KEY: Record<PaneStatus['state'], MessageKey> = {
  working: 'sidebar.sum.working',
  action: 'sidebar.sum.action',
  done: 'sidebar.sum.done',
  error: 'sidebar.sum.error',
  idle: 'sidebar.sum.idle',
  unknown: 'sidebar.sum.unknown',
}
const SUMMARY_ORDER: PaneStatus['state'][] = ['action', 'error', 'working', 'done', 'idle', 'unknown']

/**
 * Combined status tooltip of a workspace (E4-FR-11): its name (collapsed
 * sidebar only), a summary ("3 working, 1 waiting") and one line per console
 * with a state, up to 8 plus "+N". Built when it opens.
 */
function WorkspaceTip({ ws, paneStatus, showName, extra = [] }: { ws: Workspace; paneStatus: Record<string, PaneStatus>; showName: boolean; extra?: string[] }) {
  const t = useT()
  const lang = useLang()
  const [now] = useState(() => Date.now())
  const withStatus = ws.panes.filter((p) => paneStatus[p.id])
  const counts = new Map<PaneStatus['state'], number>()
  for (const p of withStatus) counts.set(paneStatus[p.id].state, (counts.get(paneStatus[p.id].state) ?? 0) + 1)
  const summary = SUMMARY_ORDER.filter((st) => counts.get(st))
    .map((st) => t(SUMMARY_KEY[st], { count: counts.get(st) ?? 0 }))
    .join(', ')
  const lines = withStatus.slice(0, TIP_MAX_LINES).map((p) => {
    const st = paneStatus[p.id]
    return [p.title, t(STATUS_LABEL_KEY[st.state]), st.stateSince ? formatSince(st.stateSince, now, lang) : '']
      .filter(Boolean)
      .join(' - ')
  })
  return (
    <span className="flex flex-col" data-workspace-tip>
      {showName && <span>{ws.name}</span>}
      {summary && <span className={showName ? 'font-normal' : undefined}>{summary}</span>}
      {lines.map((line, i) => (
        <span key={i} className="font-normal text-text-secondary">
          {line}
        </span>
      ))}
      {withStatus.length > TIP_MAX_LINES && (
        <span className="font-normal text-text-secondary">+{withStatus.length - TIP_MAX_LINES}</span>
      )}
      {/* "<pane>: exited" lines (E6-FR-38). */}
      {extra.map((line, i) => (
        <span key={`x${i}`} className="font-normal text-text-secondary">
          {line}
        </span>
      ))}
    </span>
  )
}

export function Sidebar() {
  const t = useT()
  const {
    workspaces,
    activeWorkspaceId,
    sidebarCollapsed,
    paneAttention,
    paneStatus,
    mountedWorkspaces,
    presets,
    agentSettings,
    setActive,
    deleteWorkspace,
    renameWorkspace,
    toggleFavorite,
    toggleAgentsCollapsed,
    toggleSidebar,
    setSettingsOpen,
    setWizardOpen,
  } = useAppStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      sidebarCollapsed: s.sidebarCollapsed,
      paneAttention: s.paneAttention,
      paneStatus: s.paneStatus,
      mountedWorkspaces: s.mountedWorkspaces,
      presets: s.presets,
      agentSettings: s.settings.agents,
      setActive: s.setActive,
      deleteWorkspace: s.deleteWorkspace,
      renameWorkspace: s.renameWorkspace,
      toggleFavorite: s.toggleFavorite,
      toggleAgentsCollapsed: s.toggleAgentsCollapsed,
      toggleSidebar: s.toggleSidebar,
      setSettingsOpen: s.setSettingsOpen,
      setWizardOpen: s.setWizardOpen,
    })),
  )
  const sessions = useAgentStore((s) => s.sessions)
  // Consoles whose shell ended on its own (E6-FR-38).
  const paneExit = useAppStore((s) => s.paneExit)
  // Agent rows (E5-FR-19): expanded sidebar only, unless turned off.
  const rowsOn = !sidebarCollapsed && agentSettings?.sidebarAgentRows !== false
  const navInput = navInputFrom(
    { workspaces, paneStatus, paneAttention, mountedWorkspaces, presets, settings: { agents: agentSettings } },
    { sessions },
  )

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirmWs, setConfirmWs] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const onNew = (): void => setWizardOpen(true)
  // Shortcut chips from the live keymap (E4-FR-30): a rebind shows at once.
  const newKeys = useActionKeys('newWorkspace')
  const settingsKeys = useActionKeys('openSettings')
  const sidebarKeys = useActionKeys('toggleSidebar')

  // Favorites float to the top (stable within each group); Alt+1..9 use the same order.
  const sorted = sidebarOrder(workspaces)

  const openMenu = (e: { clientX: number; clientY: number }, wsId: string): void => {
    setMenu({ x: e.clientX, y: e.clientY, wsId })
  }

  const startRename = (wsId: string): void => {
    const ws = workspaces.find((w) => w.id === wsId)
    setRenameValue(ws?.name ?? '')
    setRenamingId(wsId)
  }

  const commitRename = (): void => {
    if (renamingId) renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }

  const menuItems = (wsId: string): ContextMenuItem[] => {
    const ws = workspaces.find((w) => w.id === wsId)
    return [
      {
        label: ws?.favorite ? t('ctx.unfavorite') : t('ctx.favorite'),
        icon: ws?.favorite ? StarOff : Star,
        onClick: () => toggleFavorite(wsId),
      },
      { label: t('ctx.rename'), icon: Pencil, onClick: () => startRename(wsId) },
      {
        label: t('ctx.delete'),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () => setConfirmWs(wsId),
      },
    ]
  }

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-bg-secondary transition-[width] duration-200 ease-out',
        sidebarCollapsed ? 'w-[60px]' : 'w-[260px]',
      )}
    >
      <div
        className={cn(
          'flex h-11 shrink-0 items-center px-3',
          sidebarCollapsed ? 'justify-center' : 'justify-between',
        )}
      >
        {!sidebarCollapsed && (
          <span className="pl-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/60">
            {t('sidebar.header')}
          </span>
        )}
        <Tooltip label={<ActionTooltipLabel label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')} action="toggleSidebar" />} side="right">
          <button
            onClick={toggleSidebar}
            aria-keyshortcuts={sidebarKeys.length > 0 ? ariaKeyshortcuts(sidebarKeys) : undefined}
            className="rounded-lg border border-border/70 bg-card/40 p-1 text-text-secondary transition-colors hover:border-accent-violet/40 hover:bg-card hover:text-text-primary"
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </Tooltip>
      </div>

      <div className="px-2 pb-2 pt-1">
        <Tooltip label={sidebarCollapsed ? <ActionTooltipLabel label={t('sidebar.newWorkspace')} action="newWorkspace" /> : ''} side="right">
          <button
            onClick={onNew}
            data-sidebar-new
            aria-keyshortcuts={newKeys.length > 0 ? ariaKeyshortcuts(newKeys) : undefined}
            className={cn(
              'group relative flex w-full items-center justify-center overflow-hidden rounded-btn border border-accent-violet/30 bg-accent-violet/10 px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:border-accent-violet/50 hover:bg-accent-violet/20',
              sidebarCollapsed ? 'gap-0' : 'gap-2',
            )}
          >
            <Plus size={16} className="shrink-0 text-accent-violet" />
            <span
              className={cn(
                'overflow-hidden whitespace-nowrap transition-all duration-200',
                sidebarCollapsed ? 'max-w-0 opacity-0' : 'max-w-[170px] opacity-100',
              )}
            >
              {t('sidebar.newWorkspace')}
            </span>
            {!sidebarCollapsed && (
              <KeyHint keys={newKeys} className="absolute right-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </Tooltip>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-2">
        {sorted.map((w) => {
          const active = w.id === activeWorkspaceId
          const WsIcon = iconFor(w.panes[0]?.icon)
          const renaming = renamingId === w.id
          const attentionCount = w.panes.reduce((n, p) => n + Math.max(paneStatus[p.id]?.pendingCount ?? 0, paneAttention[p.id] ? 1 : 0), 0)
          const status = aggregateStatus(w.panes.map(p => paneStatus[p.id]))
          const exited = exitedLines(w.panes, paneExit, t)
          const statusLabel = w.panes.filter(p => paneStatus[p.id]).map(p => `${p.title}: ${t(`status.${paneStatus[p.id].state}`)}`).concat(exited).join(', ')
          // Gray dot when no agent state is shown and every console has exited (E6-FR-38).
          const exitedDot = !status && allExited(w.panes, paneExit)
          const exitedLabel = exited.join('\n')
          const agents = rowsOn ? workspaceAgents(w, navInput) : []
          return (
            <div key={w.id}>
              <div
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(e, w.id)
                }}
                className={cn(
                  'group relative flex items-center rounded-btn',
                  active ? 'bg-card' : 'hover:bg-card/60',
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent-violet" />
                )}

                {renaming && !sidebarCollapsed ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-[11px] py-2">
                    <WsIcon size={16} className="shrink-0 text-accent-violet" />
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="min-w-0 flex-1 rounded border border-accent-violet/50 bg-bg-primary px-1.5 py-0.5 text-sm text-text-primary outline-none"
                    />
                  </div>
                ) : (
                  <Tooltip
                    label={sidebarCollapsed ? (status ? <WorkspaceTip ws={w} paneStatus={paneStatus} showName extra={exited} /> : w.name) : ''}
                    side="right"
                    delay={sidebarCollapsed && status ? 200 : undefined}
                    className="min-w-0 flex-1"
                  >
                    <button
                      // No dot to hover (no agent state, not every console exited):
                      // the "<pane>: exited" lines go on the row itself (E6-FR-38).
                      title={!sidebarCollapsed && !status && !exitedDot && exitedLabel ? exitedLabel : undefined}
                      onClick={() => {
                        setActive(w.id)
                        // Move focus into the workspace's console right away, even
                        // when re-clicking the already-active one, so the click
                        // never leaves focus parked on this sidebar button.
                        focusWorkspaceConsole(w.id)
                      }}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-[11px] py-2 text-left text-sm',
                        active ? 'text-text-primary' : 'text-text-secondary',
                      )}
                    >
                      <span className="relative shrink-0">
                      <WsIcon
                        size={16}
                        className="shrink-0"
                        style={{ color: active ? (w.panes[0]?.color ?? '#6366f1') : undefined }}
                      />
                      {sidebarCollapsed && (status || exitedDot) && <span className="absolute -bottom-1 -right-1 rounded-full bg-bg-secondary p-0.5">{status ? <StatusDot status={status} label={statusLabel} size={6} noTooltip /> : <ExitedDot label={exitedLabel} size={6} />}</span>}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 transition-opacity duration-150',
                          sidebarCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
                        )}
                      >
                        <span className="flex items-center gap-1">
                          {!sidebarCollapsed && (exitedDot ? <ExitedDot label={exitedLabel} /> : <StatusDot status={status} label={statusLabel} tip={<WorkspaceTip ws={w} paneStatus={paneStatus} showName={false} extra={exited} />} />)}
                          <span className="truncate">{w.name}</span>
                          {w.favorite && (
                            <Star size={11} className="shrink-0 fill-amber-400 text-amber-400" />
                          )}
                        </span>
                        <span className="block truncate text-[11px] text-text-secondary">
                          {w.panes.length === 1
                            ? t('sidebar.consoleOne', { count: w.panes.length })
                            : t('sidebar.consoleMany', { count: w.panes.length })}
                        </span>
                      </span>
                    </button>
                  </Tooltip>
                )}

                {!sidebarCollapsed && !renaming && (
                  <AttentionBadge count={attentionCount} className="mr-1" />
                )}
                {rowsOn && !renaming && agents.length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleAgentsCollapsed(w.id)
                    }}
                    aria-label={w.agentsCollapsed ? t('agents.row.expand') : t('agents.row.collapse')}
                    aria-expanded={!w.agentsCollapsed}
                    data-agents-chevron={w.id}
                    className="shrink-0 rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                  >
                    {w.agentsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                )}
                {sidebarCollapsed && (
                  <AttentionBadge
                    count={attentionCount}
                    className="pointer-events-none absolute right-0.5 top-0.5"
                  />
                )}
                {!sidebarCollapsed && !renaming && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      openMenu(e, w.id)
                    }}
                    aria-label={t('ctx.moreActions')}
                    className="mr-1 shrink-0 rounded p-1 text-text-secondary opacity-0 transition-opacity hover:bg-bg-secondary hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
                  >
                    <MoreVertical size={15} />
                  </button>
                )}
              </div>
              {rowsOn && !w.agentsCollapsed && (
                <AgentRows entries={agents} presets={presets} topicAsTitle={agentSettings?.topicAsTitle !== false} />
              )}
            </div>
          )
        })}
      </nav>

      <RemoteIndicator />
      <UsageBars />

      <div className="shrink-0 border-t border-border p-2">
        <Tooltip label={sidebarCollapsed ? <ActionTooltipLabel label={t('sidebar.settings')} action="openSettings" /> : ''} side="right">
          <button
            onClick={() => setSettingsOpen(true)}
            data-sidebar-settings
            aria-keyshortcuts={settingsKeys.length > 0 ? ariaKeyshortcuts(settingsKeys) : undefined}
            className="group flex w-full items-center gap-2 overflow-hidden rounded-btn px-[11px] py-2 text-sm text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
          >
            <Settings size={16} className="shrink-0" />
            <span
              className={cn(
                'whitespace-nowrap transition-opacity duration-150',
                sidebarCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
              )}
            >
              {t('sidebar.settings')}
            </span>
            {!sidebarCollapsed && (
              <KeyHint keys={settingsKeys} className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </Tooltip>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.wsId)}
          onClose={() => setMenu(null)}
        />
      )}

      {confirmWs && (
        <ConfirmDialog
          open
          title={t('confirm.deleteWorkspaceTitle')}
          message={t('confirm.deleteWorkspaceMsg', {
            name: workspaces.find((w) => w.id === confirmWs)?.name ?? '',
          })}
          confirmLabel={t('confirm.deleteYes')}
          cancelLabel={t('confirm.deleteNo')}
          danger
          onConfirm={() => {
            deleteWorkspace(confirmWs)
            setConfirmWs(null)
          }}
          onCancel={() => setConfirmWs(null)}
        />
      )}
    </aside>
  )
}
