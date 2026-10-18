import { useEffect, useState, type DragEvent } from 'react'
import {
  Clock,
  GripVertical,
  Maximize2,
  Minimize2,
  Minus,
  Paintbrush,
  Pencil,
  Play,
  RotateCw,
  X,
} from 'lucide-react'
import { motion } from 'framer-motion'
import type { AgentPreset, Pane, Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { isPaneMounted } from '@/lib/mounting'
import { resolveLaunch } from '@/lib/launch'
import { getPtyId } from '@/lib/ptyRegistry'
import { redrawPane } from '@/lib/redrawRegistry'
import { focusPane } from '@/lib/focus'
import { isBracketedPaste, pasteToPane } from '@/lib/pasteRegistry'
import { isAgentPane } from '@/lib/agentPane'
import { buildDropPayload, type DropMode } from '@/lib/dropPaths'
import { INTERNAL_PATH_MIME, parseInternalPath } from '@/lib/dragNonce'
import { isPathDrag, nextDragDepth, type DragHoverEvent } from '@/lib/dropHover'
import { iconFor } from '@/lib/icons'
import { Tooltip } from '@/components/ui/Tooltip'
import { PaneStatusDot } from '@/components/ui/StatusDot'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
import { ScheduleDialog } from '@/components/layout/ScheduleDialog'
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
  /** Pane ids minimized (collapsed to the strip) in this workspace. */
  minimizedIds: string[]
  index: number
  isDragging: boolean
  draggable: boolean
  onToggleMax: () => void
  onToggleMin: () => void
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
  minimizedIds,
  isDragging,
  draggable,
  onToggleMax,
  onToggleMin,
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
  const isMin = minimizedIds.includes(pane.id)
  const hidden = (maximizedId !== null && !isMax) || isMin
  const cellVisible = workspaceActive && !hidden

  const renamePane = useAppStore((s) => s.renamePane)
  const restartPane = useAppStore((s) => s.restartPane)
  const epoch = useAppStore((s) => s.paneEpoch[pane.id] ?? 0)
  // Partial mount (D4): a console outside the mounted list shows a placeholder
  // instead of spawning. The visible workspace always counts as mounted.
  const mounted = useAppStore(
    (s) => workspaceActive || isPaneMounted(s.mountedWorkspaces, workspace.id, pane.id),
  )
  const ensureMounted = useAppStore((s) => s.ensureMounted)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameVal, setNameVal] = useState(pane.title)
  const [scheduling, setScheduling] = useState(false)
  const isScheduled = pane.schedule != null

  const startRename = (): void => {
    setNameVal(pane.title)
    setRenaming(true)
  }
  const commitRename = (): void => {
    renamePane(workspace.id, pane.id, nameVal)
    setRenaming(false)
  }

  // Drop feedback (E7-FR-03): a depth counter of dragenter/dragleave, so the
  // overlay stays put while the pointer crosses the header or the xterm canvas.
  const [dragDepth, setDragDepth] = useState(0)
  const dropHover = dragDepth > 0
  const stepDrag = (event: DragHoverEvent): void => setDragDepth((d) => nextDragDepth(d, event))
  useEffect(() => {
    if (!dropHover) return
    // A drag that ends elsewhere (Esc, drop on another target) may never send
    // the last dragleave here; any window-level end clears the overlay.
    const reset = (): void => setDragDepth(0)
    window.addEventListener('dragend', reset, true)
    window.addEventListener('drop', reset, true)
    return () => {
      window.removeEventListener('dragend', reset, true)
      window.removeEventListener('drop', reset, true)
    }
  }, [dropHover])

  // Drop file(s)/folder(s) onto the console (E7-FR-01..02): paste the path(s)
  // in the format the console understands. An agent pane gets images it can
  // attach as [Image #N], a bracketed-paste shell gets escaped paths, a plain
  // console keeps the 1.14.1 quoted write. Never a `cd`, never an Enter.
  const onDropFolder = (e: DragEvent): void => {
    const files = e.dataTransfer.files
    const internal = e.dataTransfer.types.includes(INTERNAL_PATH_MIME)
    if ((!files || files.length === 0) && !internal) return
    e.preventDefault()
    e.stopPropagation()
    stepDrag('reset')
    let paths: string[]
    if (files && files.length > 0) {
      paths = Array.from(files)
        .map((f) => window.snApi.filePath(f))
        .filter(Boolean)
    } else {
      // In-app path drag: nonce + currently listed path, else ignored silently.
      const path = parseInternalPath(e.dataTransfer.getData(INTERNAL_PATH_MIME))
      paths = path ? [path] : []
    }
    if (paths.length === 0) return
    const ptyId = getPtyId(pane.id)
    if (!ptyId) return
    const bracketed = isBracketedPaste(pane.id)
    if (bracketed === null) return // no xterm mounted: nothing to paste into
    const status = useAppStore.getState().paneStatus[pane.id]
    const mode: DropMode = !bracketed ? 'plain' : isAgentPane(pane, status, bracketed) ? 'agent' : 'safe'
    const payload = buildDropPayload(paths, mode)
    if (!payload) return
    if (payload.kind === 'paste') {
      // One xterm paste per part: an agent sees each image as its own paste.
      for (const part of payload.parts) {
        if (!pasteToPane(pane.id, part)) return
      }
    } else {
      window.snApi.pty.write({ ptyId, data: payload.text })
    }
    const target = pane.id
    requestAnimationFrame(() => focusPane(target))
  }

  const menuItems: ContextMenuItem[] = [
    { label: t('ctx.rename'), icon: Pencil, onClick: startRename },
    {
      label: isMax ? t('pane.restore') : t('pane.maximize'),
      icon: isMax ? Minimize2 : Maximize2,
      onClick: onToggleMax,
    },
    { label: t('pane.minimize'), icon: Minus, onClick: onToggleMin },
    {
      label: isScheduled ? t('schedule.edit') : t('pane.schedule'),
      icon: Clock,
      onClick: () => setScheduling(true),
    },
    { label: t('pane.restart'), icon: RotateCw, onClick: () => restartPane(pane.id) },
    { label: t('pane.redraw'), icon: Paintbrush, onClick: () => redrawPane(pane.id) },
    { label: t('pane.close'), icon: X, danger: true, separated: true, onClick: onClose },
  ]

  return (
    <motion.div
      // "position" (not full `layout`) animates only the cell's position, never
      // its size via a CSS transform. A scale transform would make xterm's fit
      // measure a transient wrong width on mount → the narrow-column glitch.
      layout="position"
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      onDragOver={(e) => {
        e.preventDefault()
        if (isPathDrag(e.dataTransfer.types)) e.dataTransfer.dropEffect = 'copy'
      }}
      onDragEnter={(e) => {
        if (isPathDrag(e.dataTransfer.types)) stepDrag('enter')
        onDragEnterCell()
      }}
      onDragLeave={(e) => {
        if (isPathDrag(e.dataTransfer.types)) stepDrag('leave')
      }}
      onDrop={onDropFolder}
      data-drop-hover={dropHover || undefined}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-bg-primary',
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
        <PaneStatusDot paneId={pane.id} />
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
        <Tooltip label={isScheduled ? t('schedule.active', { time: pane.schedule!.time }) : t('pane.schedule')}>
          <button
            draggable={false}
            onClick={() => setScheduling(true)}
            className={cn(
              'rounded p-1 transition-colors hover:bg-bg-secondary',
              isScheduled
                ? 'text-accent-violet hover:text-accent-violet'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            <Clock size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t('pane.restart')}>
          <button
            draggable={false}
            onClick={() => restartPane(pane.id)}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            <RotateCw size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t('pane.minimize')}>
          <button
            draggable={false}
            onClick={onToggleMin}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            <Minus size={13} />
          </button>
        </Tooltip>
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
        {mounted ? (
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
        ) : (
          <div
            data-pane-placeholder={pane.id}
            className="flex h-full flex-col items-center justify-center gap-2 text-xs text-text-secondary"
          >
            <span>{t('pane.notStarted')}</span>
            <button
              onClick={() => ensureMounted(workspace.id, { only: [pane.id] })}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-text-primary transition-colors hover:bg-bg-secondary"
            >
              <Play size={12} />
              {t('pane.start')}
            </button>
          </div>
        )}
      </div>

      {dropHover && (
        <div
          aria-hidden
          data-drop-overlay
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-accent-violet bg-accent-violet/10"
        >
          <span className="rounded-md border border-accent-violet/40 bg-card px-3 py-1.5 text-xs font-medium text-text-primary shadow-lg">
            {t('drop.hint')}
          </span>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {scheduling && (
        <ScheduleDialog
          workspaceId={workspace.id}
          paneId={pane.id}
          paneTitle={pane.title}
          schedule={pane.schedule}
          onClose={() => setScheduling(false)}
        />
      )}
    </motion.div>
  )
}
