import { Maximize2, Minimize2, X } from 'lucide-react'
import type { AgentPreset, Pane, Workspace } from '@shared/types'
import { resolveLaunch } from '@/lib/launch'
import { iconFor } from '@/lib/icons'
import { Tooltip } from '@/components/ui/Tooltip'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

interface PaneCellProps {
  workspace: Workspace
  pane: Pane
  presets: AgentPreset[]
  /** Whether the owning workspace is the visible one. */
  workspaceActive: boolean
  /** Currently maximized pane id in this workspace (null = none). */
  maximizedId: string | null
  onToggleMax: () => void
  onClose: () => void
}

export function PaneCell({
  workspace,
  pane,
  presets,
  workspaceActive,
  maximizedId,
  onToggleMax,
  onClose,
}: PaneCellProps) {
  const t = useT()
  const Icon = iconFor(pane.icon)
  const { cwd, initialCommand } = resolveLaunch(pane, workspace, presets)

  const isMax = maximizedId === pane.id
  const hidden = maximizedId !== null && !isMax
  // Terminal is visible (and should refit) only when its workspace is shown
  // and it isn't hidden behind a maximized sibling.
  const cellVisible = workspaceActive && !hidden

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-bg-primary',
        hidden && 'hidden',
      )}
    >
      <header
        className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card/50 px-2.5"
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            onClose()
          }
        }}
        onDoubleClick={onToggleMax}
      >
        <Icon size={13} className="shrink-0" style={{ color: pane.color }} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">
          {pane.title}
        </span>
        <Tooltip label={isMax ? t('pane.restore') : t('pane.maximize')}>
          <button
            onClick={onToggleMax}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            {isMax ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </Tooltip>
        <Tooltip label={t('pane.close')}>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-red-400/10 hover:text-red-400"
          >
            <X size={13} />
          </button>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1">
        <TerminalPane
          paneId={pane.id}
          cwd={cwd}
          initialCommand={initialCommand}
          isActive={cellVisible}
        />
      </div>
    </div>
  )
}
