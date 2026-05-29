import { useState } from 'react'
import {
  Check,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { Logo, LogoMark } from '@/components/ui/Logo'
import { cn } from '@/lib/cn'

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
}

export function Sidebar() {
  const {
    workspaces,
    activeWorkspaceId,
    sidebarCollapsed,
    setActive,
    createWorkspace,
    deleteWorkspace,
    toggleSidebar,
  } = useAppStore()
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const onNew = async (): Promise<void> => {
    const dir = await window.snApi.dialog.openDirectory()
    if (dir) createWorkspace(basename(dir), dir)
  }

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-border bg-bg-secondary transition-[width] duration-200 ease-out',
        sidebarCollapsed ? 'w-[56px]' : 'w-[260px]',
      )}
    >
      <div className="flex h-11 shrink-0 items-center justify-between px-3">
        {sidebarCollapsed ? <LogoMark size="sm" /> : <Logo size="sm" />}
        <button
          onClick={toggleSidebar}
          className="text-text-secondary transition-colors hover:text-text-primary"
          title={sidebarCollapsed ? 'Expand' : 'Collapse'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <div className="px-2 pb-2">
        <button
          onClick={onNew}
          className={cn(
            'flex w-full items-center gap-2 rounded-btn border border-border bg-card px-2.5 py-2 text-sm text-text-primary transition-colors hover:border-accent-violet/40',
            sidebarCollapsed && 'justify-center px-0',
          )}
          title="Nuevo workspace"
        >
          <Plus size={16} className="text-accent-violet" />
          {!sidebarCollapsed && <span>Nuevo workspace</span>}
        </button>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
        {workspaces.map((w) => {
          const active = w.id === activeWorkspaceId
          return (
            <div
              key={w.id}
              className={cn(
                'group relative flex items-center rounded-btn',
                active ? 'bg-card' : 'hover:bg-card/60',
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent-violet" />
              )}
              <button
                onClick={() => setActive(w.id)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm',
                  active ? 'text-text-primary' : 'text-text-secondary',
                )}
                title={w.name}
              >
                <TerminalSquare
                  size={16}
                  className="shrink-0"
                  style={{ color: active ? (w.panes[0]?.color ?? '#6366f1') : undefined }}
                />
                {!sidebarCollapsed && (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{w.name}</span>
                    <span className="block truncate text-[11px] text-text-secondary">
                      {w.panes.length} {w.panes.length === 1 ? 'consola' : 'consolas'}
                    </span>
                  </span>
                )}
              </button>

              {!sidebarCollapsed && confirmId !== w.id && (
                <button
                  onClick={() => setConfirmId(w.id)}
                  className="mr-1 hidden shrink-0 rounded p-1 text-text-secondary hover:text-red-400 group-hover:block"
                  title="Eliminar"
                >
                  <Trash2 size={14} />
                </button>
              )}
              {!sidebarCollapsed && confirmId === w.id && (
                <span className="mr-1 flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => {
                      deleteWorkspace(w.id)
                      setConfirmId(null)
                    }}
                    className="rounded p-1 text-red-400 hover:bg-red-400/10"
                    title="Confirmar"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="rounded p-1 text-text-secondary hover:text-text-primary"
                    title="Cancelar"
                  >
                    <X size={14} />
                  </button>
                </span>
              )}
            </div>
          )
        })}
      </nav>

      <div className="shrink-0 border-t border-border p-2">
        <button
          className={cn(
            'flex w-full items-center gap-2 rounded-btn px-2.5 py-2 text-sm text-text-secondary transition-colors hover:bg-card hover:text-text-primary',
            sidebarCollapsed && 'justify-center px-0',
          )}
          title="Ajustes"
        >
          <Settings size={16} />
          {!sidebarCollapsed && <span>Ajustes</span>}
        </button>
        {!sidebarCollapsed && (
          <p className="px-2.5 pt-1 text-[11px] text-text-secondary/70">Engineered in silence.</p>
        )}
      </div>
    </aside>
  )
}
