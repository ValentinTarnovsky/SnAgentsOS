import { useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import type { AgentPreset, Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { iconFor } from '@/lib/icons'
import { DockArea } from '@/components/dock/DockArea'
import { cn } from '@/lib/cn'

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const addPane = useAppStore((s) => s.addPane)
  const presets = useAppStore((s) => s.presets)
  const [open, setOpen] = useState(false)

  const launch = (preset: AgentPreset): void => {
    addPane(workspace.id, {
      type: preset.type,
      presetId: preset.id,
      title: preset.name,
      color: preset.color,
      icon: preset.icon,
    })
    setOpen(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium text-text-primary">{workspace.name}</span>
          <span className="truncate font-mono text-xs text-text-secondary">{workspace.cwd}</span>
        </div>

        <div className="relative shrink-0">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40"
            title="Nueva consola"
          >
            <Plus size={14} className="text-accent-violet" />
            Nueva consola
            <ChevronDown size={13} className="text-text-secondary" />
          </button>

          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute right-0 z-20 mt-1.5 w-52 overflow-hidden rounded-card border border-border bg-card py-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]">
                {presets.map((preset) => {
                  const Icon = iconFor(preset.icon)
                  return (
                    <button
                      key={preset.id}
                      onClick={() => launch(preset)}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-bg-secondary"
                    >
                      <Icon size={15} style={{ color: preset.color }} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                      {preset.type !== 'shell' && preset.command && (
                        <span className="shrink-0 font-mono text-[10px] text-text-secondary">
                          {preset.command}
                        </span>
                      )}
                    </button>
                  )
                })}
                {presets.length === 0 && (
                  <p className={cn('px-3 py-2 text-xs text-text-secondary')}>Sin presets</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <DockArea key={workspace.id} workspace={workspace} />
      </div>
    </div>
  )
}
