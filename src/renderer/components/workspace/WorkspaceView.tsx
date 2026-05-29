import { Plus } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { DockArea } from '@/components/dock/DockArea'

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const addPane = useAppStore((s) => s.addPane)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium text-text-primary">{workspace.name}</span>
          <span className="truncate font-mono text-xs text-text-secondary">{workspace.cwd}</span>
        </div>
        <button
          onClick={() => addPane(workspace.id, { type: 'shell', title: 'PowerShell' })}
          className="flex shrink-0 items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40"
          title="Agregar terminal"
        >
          <Plus size={14} className="text-accent-violet" />
          Terminal
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <DockArea key={workspace.id} workspace={workspace} />
      </div>
    </div>
  )
}
