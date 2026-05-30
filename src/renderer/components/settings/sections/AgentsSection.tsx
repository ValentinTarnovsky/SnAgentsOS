import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { AgentPreset } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { iconFor } from '@/lib/icons'
import { useT } from '@/i18n'
import { PresetEditor } from '../PresetEditor'

export function AgentsSection() {
  const t = useT()
  const presets = useAppStore((s) => s.presets)
  const savePreset = useAppStore((s) => s.savePreset)
  const deletePreset = useAppStore((s) => s.deletePreset)
  const newPresetId = useAppStore((s) => s.newPresetId)
  const [editing, setEditing] = useState<AgentPreset | null>(null)

  const startNew = (): void =>
    setEditing({
      id: newPresetId(),
      name: '',
      type: 'custom',
      command: '',
      args: [],
      color: '#6366f1',
      icon: 'terminal',
    })

  if (editing) {
    return (
      <PresetEditor
        initial={editing}
        onSave={(p) => {
          savePreset(p)
          setEditing(null)
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="space-y-2">
      {presets.map((preset) => {
        const Icon = iconFor(preset.icon)
        return (
          <div
            key={preset.id}
            className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2.5"
          >
            <Icon size={18} style={{ color: preset.color }} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-text-primary">{preset.name}</span>
                <span className="rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-text-secondary">
                  {preset.type}
                </span>
              </div>
              {preset.command && (
                <span className="block truncate font-mono text-[11px] text-text-secondary">
                  {[preset.command, ...preset.args].join(' ')}
                </span>
              )}
            </div>
            <button
              onClick={() => setEditing(preset)}
              className="rounded p-1.5 text-text-secondary hover:text-text-primary"
              title={t('settings.edit')}
            >
              <Pencil size={15} />
            </button>
            <button
              onClick={() => deletePreset(preset.id)}
              className="rounded p-1.5 text-text-secondary hover:text-red-400"
              title={t('ctx.delete')}
            >
              <Trash2 size={15} />
            </button>
          </div>
        )
      })}

      <button
        onClick={startNew}
        className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
      >
        <Plus size={16} />
        {t('settings.newPreset')}
      </button>
    </div>
  )
}
