import { useState } from 'react'
import type { Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { GRID_COLS, gridForCount, orderPanes } from './gridTemplates'
import { PaneCell } from './PaneCell'

/**
 * Renders a workspace's terminals in a fixed CSS grid. No tab groups — each
 * cell is one terminal with a slim header. Maximize spans one cell over the
 * others; middle-click closes; drag a cell's header to reorder (smooth reflow).
 */
export function TilingGrid({ workspace, isActive }: { workspace: Workspace; isActive: boolean }) {
  const presets = useAppStore((s) => s.presets)
  const removePane = useAppStore((s) => s.removePane)
  const toggleMaximize = useAppStore((s) => s.toggleMaximize)
  const movePane = useAppStore((s) => s.movePane)
  const maximizedId = useAppStore((s) => s.maximized[workspace.id] ?? null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const grid = workspace.layout?.grid ?? gridForCount(workspace.panes.length)
  const ordered = orderPanes(workspace.panes, workspace.layout?.order)
  const cols = maximizedId ? 1 : GRID_COLS[grid]

  return (
    <div className="h-full w-full p-1.5">
      <div
        className="grid h-full w-full gap-1.5"
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
            index={index}
            isDragging={draggingId === pane.id}
            draggable={!maximizedId}
            onToggleMax={() => toggleMaximize(workspace.id, pane.id)}
            onClose={() => removePane(workspace.id, pane.id)}
            onDragStartCell={() => setDraggingId(pane.id)}
            onDragEnterCell={() => {
              if (draggingId && draggingId !== pane.id) movePane(workspace.id, draggingId, index)
            }}
            onDragEndCell={() => setDraggingId(null)}
          />
        ))}
      </div>
    </div>
  )
}
