import { useState } from 'react'
import {
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
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { iconFor } from '@/lib/icons'
import { cn } from '@/lib/cn'

interface MenuState {
  x: number
  y: number
  wsId: string
}

export function Sidebar() {
  const t = useT()
  const {
    workspaces,
    activeWorkspaceId,
    sidebarCollapsed,
    setActive,
    deleteWorkspace,
    renameWorkspace,
    toggleFavorite,
    toggleSidebar,
    setSettingsOpen,
    setWizardOpen,
  } = useAppStore()

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirmWs, setConfirmWs] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const onNew = (): void => setWizardOpen(true)

  // Favorites float to the top (stable within each group).
  const sorted = [...workspaces].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0))

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
        <Tooltip label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')} side="right">
          <button
            onClick={toggleSidebar}
            className="rounded-lg border border-border/70 bg-card/40 p-1 text-text-secondary transition-colors hover:border-accent-violet/40 hover:bg-card hover:text-text-primary"
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </Tooltip>
      </div>

      <div className="px-2 pb-2 pt-1">
        <Tooltip label={sidebarCollapsed ? t('sidebar.newWorkspace') : ''} side="right">
          <button
            onClick={onNew}
            className={cn(
              'flex w-full items-center justify-center overflow-hidden rounded-btn border border-accent-violet/30 bg-accent-violet/10 px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:border-accent-violet/50 hover:bg-accent-violet/20',
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
          </button>
        </Tooltip>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-2">
        {sorted.map((w) => {
          const active = w.id === activeWorkspaceId
          const WsIcon = iconFor(w.panes[0]?.icon)
          const renaming = renamingId === w.id
          return (
            <div
              key={w.id}
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
                <Tooltip label={sidebarCollapsed ? w.name : ''} side="right">
                  <button
                    onClick={() => setActive(w.id)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-[11px] py-2 text-left text-sm',
                      active ? 'text-text-primary' : 'text-text-secondary',
                    )}
                  >
                    <WsIcon
                      size={16}
                      className="shrink-0"
                      style={{ color: active ? (w.panes[0]?.color ?? '#6366f1') : undefined }}
                    />
                    <span
                      className={cn(
                        'min-w-0 flex-1 transition-opacity duration-150',
                        sidebarCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
                      )}
                    >
                      <span className="flex items-center gap-1">
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
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    openMenu(e, w.id)
                  }}
                  className="mr-1 hidden shrink-0 rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary group-hover:block"
                >
                  <MoreVertical size={15} />
                </button>
              )}
            </div>
          )
        })}
      </nav>

      <div className="shrink-0 border-t border-border p-2">
        <Tooltip label={sidebarCollapsed ? t('sidebar.settings') : ''} side="right">
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center gap-2 overflow-hidden rounded-btn px-[11px] py-2 text-sm text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
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
