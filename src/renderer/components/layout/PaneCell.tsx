import { GripVertical, Maximize2, Minimize2, X } from 'lucide-react'
import { motion } from 'framer-motion'
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
  index: number
  isDragging: boolean
  draggable: boolean
  onToggleMax: () => void
  onClose: () => void
  onDragStartCell: () => void
  onDragEnterCell: () => void
  onDragEndCell: () => void
}

export function PaneCell({
  workspace,
  pane,
  presets,
  workspaceActive,
  maximizedId,
  isDragging,
  draggable,
  onToggleMax,
  onClose,
  onDragStartCell,
  onDragEnterCell,
  onDragEndCell,
}: PaneCellProps) {
  const t = useT()
  const Icon = iconFor(pane.icon)
  const { cwd, initialCommand } = resolveLaunch(pane, workspace, presets)

  const isMax = maximizedId === pane.id
  const hidden = maximizedId !== null && !isMax
  const cellVisible = workspaceActive && !hidden

  return (
    <motion.div
      layout
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={onDragEnterCell}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-bg-primary',
        hidden && 'hidden',
        isDragging ? 'border-accent-violet opacity-40' : 'border-border',
      )}
    >
      <header
        draggable={draggable}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          onDragStartCell()
        }}
        onDragEnd={onDragEndCell}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            onClose()
          }
        }}
        onDoubleClick={onToggleMax}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-card/50 px-2',
          draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
      >
        {draggable && <GripVertical size={13} className="shrink-0 text-text-secondary/40" />}
        <Icon size={13} className="shrink-0" style={{ color: pane.color }} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">
          {pane.title}
        </span>
        <Tooltip label={isMax ? t('pane.restore') : t('pane.maximize')}>
          <button
            draggable={false}
            onClick={onToggleMax}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            {isMax ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </Tooltip>
        <Tooltip label={t('pane.close')}>
          <button
            draggable={false}
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
    </motion.div>
  )
}
