import { useState, type DragEvent } from 'react'
import { GripVertical, Maximize2, Minimize2, Pencil, RotateCw, X } from 'lucide-react'
import { motion } from 'framer-motion'
import type { AgentPreset, Pane, Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { resolveLaunch } from '@/lib/launch'
import { getPtyId } from '@/lib/ptyRegistry'
import { iconFor } from '@/lib/icons'
import { Tooltip } from '@/components/ui/Tooltip'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
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
  const connections = useAppStore((s) => s.connections)
  const { cwd, initialCommand, setup } = resolveLaunch(pane, workspace, presets, connections)

  const isMax = maximizedId === pane.id
  const hidden = maximizedId !== null && !isMax
  const cellVisible = workspaceActive && !hidden

  const renamePane = useAppStore((s) => s.renamePane)
  const restartPane = useAppStore((s) => s.restartPane)
  const epoch = useAppStore((s) => s.paneEpoch[pane.id] ?? 0)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameVal, setNameVal] = useState(pane.title)

  const startRename = (): void => {
    setNameVal(pane.title)
    setRenaming(true)
  }
  const commitRename = (): void => {
    renamePane(workspace.id, pane.id, nameVal)
    setRenaming(false)
  }

  // Drop file(s)/folder(s) onto the console. A single folder in a shell cds
  // into it; anything else pastes every dropped path (quoted, space-separated).
  const onDropFolder = (e: DragEvent): void => {
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.snApi.filePath(f))
      .filter(Boolean)
    if (paths.length === 0) return
    const ptyId = getPtyId(pane.id)
    if (!ptyId) return
    const data =
      pane.type === 'shell' && paths.length === 1
        ? `cd "${paths[0]}"\r`
        : `${paths.map((p) => `"${p}"`).join(' ')} `
    window.snApi.pty.write({ ptyId, data })
  }

  const menuItems: ContextMenuItem[] = [
    { label: t('ctx.rename'), icon: Pencil, onClick: startRename },
    {
      label: isMax ? t('pane.restore') : t('pane.maximize'),
      icon: isMax ? Minimize2 : Maximize2,
      onClick: onToggleMax,
    },
    { label: t('pane.restart'), icon: RotateCw, onClick: () => restartPane(pane.id) },
    { label: t('pane.close'), icon: X, danger: true, separated: true, onClick: onClose },
  ]

  return (
    <motion.div
      // "position" (not full `layout`) animates only the cell's position, never
      // its size via a CSS transform. A scale transform would make xterm's fit
      // measure a transient wrong width on mount → the narrow-column glitch.
      layout="position"
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={onDragEnterCell}
      onDrop={onDropFolder}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-bg-primary',
        hidden && 'hidden',
        isDragging ? 'border-accent-violet opacity-40' : 'border-border',
      )}
    >
      <header
        draggable={draggable && !renaming}
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
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-card/50 px-2',
          draggable && !renaming ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
      >
        {draggable && <GripVertical size={13} className="shrink-0 text-text-secondary/40" />}
        <Icon size={13} className="shrink-0" style={{ color: pane.color }} />
        {renaming ? (
          <input
            autoFocus
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="min-w-0 flex-1 rounded border border-accent-violet/50 bg-bg-primary px-1.5 py-0.5 text-xs text-text-primary outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">
            {pane.title}
          </span>
        )}
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
          key={epoch}
          paneId={pane.id}
          workspaceId={workspace.id}
          cwd={cwd}
          initialCommand={initialCommand}
          setup={setup}
          fontSize={pane.fontSize}
          isActive={cellVisible}
        />
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </motion.div>
  )
}
