import { useState } from 'react'
import type { Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { iconFor } from '@/lib/icons'
import { focusPane, setFocusedPane } from '@/lib/focus'
import { GRID_COLS, gridForCount, orderPanes } from './gridTemplates'
import { PaneCell } from './PaneCell'

/** Stable empty array so the minimized selector keeps a constant reference. */
const NO_MINIMIZED: string[] = []

/**
 * Renders a workspace's terminals in a fixed CSS grid. No tab groups, each
 * cell is one terminal with a slim header. Maximize spans one cell over the
 * others; middle-click closes; drag a cell's header to reorder (smooth reflow).
 */
export function TilingGrid({ workspace, isActive }: { workspace: Workspace; isActive: boolean }) {
  const t = useT()
  const presets = useAppStore((s) => s.presets)
  const removePane = useAppStore((s) => s.removePane)
  const toggleMaximize = useAppStore((s) => s.toggleMaximize)
  const toggleMinimize = useAppStore((s) => s.toggleMinimize)
  const movePane = useAppStore((s) => s.movePane)
  const maximizedId = useAppStore((s) => s.maximized[workspace.id] ?? null)
  const minimizedIds = useAppStore((s) => s.minimized[workspace.id] ?? NO_MINIMIZED)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const ordered = orderPanes(workspace.panes, workspace.layout?.order)
  const minimizedPanes = ordered.filter((p) => minimizedIds.includes(p.id))
  // Size the grid to the count of VISIBLE panes so minimizing one reflows the
  // rest to fill the space instead of leaving an empty cell behind.
  const visibleCount = ordered.length - minimizedPanes.length
  const grid = gridForCount(Math.max(1, visibleCount))
  const cols = maximizedId ? 1 : GRID_COLS[grid]

  const restore = (paneId: string): void => {
    toggleMinimize(workspace.id, paneId)
    setFocusedPane(paneId)
    // Refocus the terminal once the cell is visible again next frame.
    requestAnimationFrame(() => focusPane(paneId))
  }

  return (
    <div className="flex h-full w-full flex-col p-1.5">
      <div
        className="grid min-h-0 w-full flex-1 gap-1.5"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: '1fr',
        }}
      >
        {ordered.map((pane, index) => (
          <PaneCell
            key={pane.id}
            workspace={workspace}
            pane={pane}
            presets={presets}
            workspaceActive={isActive}
            maximizedId={maximizedId}
            minimizedIds={minimizedIds}
            index={index}
            isDragging={draggingId === pane.id}
            draggable={!maximizedId}
            onToggleMax={() => toggleMaximize(workspace.id, pane.id)}
            onToggleMin={() => toggleMinimize(workspace.id, pane.id)}
            onClose={() => removePane(workspace.id, pane.id)}
            onDragStartCell={() => setDraggingId(pane.id)}
            onDragEnterCell={() => {
              if (draggingId && draggingId !== pane.id) movePane(workspace.id, draggingId, index)
            }}
            onDragEndCell={() => setDraggingId(null)}
          />
        ))}
      </div>
      {minimizedPanes.length > 0 && (
        <div className="mt-1.5 flex shrink-0 flex-wrap items-center gap-1.5">
          {minimizedPanes.map((pane) => {
            const Icon = iconFor(pane.icon)
            return (
              <button
                key={pane.id}
                title={t('pane.restore')}
                onClick={() => restore(pane.id)}
                className="flex h-7 max-w-[200px] items-center gap-1.5 rounded-md border border-border bg-card/50 px-2 text-xs text-text-secondary transition-colors hover:border-accent-violet hover:text-text-primary"
              >
                <Icon size={13} className="shrink-0" style={{ color: pane.color }} />
                <span className="min-w-0 truncate">{pane.title}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
