import type { Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { GRID_COLS, gridForCount, orderPanes } from './gridTemplates'
import { PaneCell } from './PaneCell'

/**
 * Renders a workspace's terminals in a fixed CSS grid. No tab groups — each
 * cell is one terminal with a slim header. Clicking maximize (or double-click
 * the header) spans one cell over the others; middle-click closes a cell.
 */
export function TilingGrid({ workspace, isActive }: { workspace: Workspace; isActive: boolean }) {
  const presets = useAppStore((s) => s.presets)
  const removePane = useAppStore((s) => s.removePane)
  const toggleMaximize = useAppStore((s) => s.toggleMaximize)
  const maximizedId = useAppStore((s) => s.maximized[workspace.id] ?? null)

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
        {ordered.map((pane) => (
          <PaneCell
            key={pane.id}
            workspace={workspace}
            pane={pane}
            presets={presets}
            workspaceActive={isActive}
            maximizedId={maximizedId}
            onToggleMax={() => toggleMaximize(workspace.id, pane.id)}
            onClose={() => removePane(workspace.id, pane.id)}
          />
        ))}
      </div>
    </div>
  )
}
