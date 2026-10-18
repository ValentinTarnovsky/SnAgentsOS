import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { AgentPreset, AwakeMode } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { iconFor } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { useT, type MessageKey } from '@/i18n'
import { PresetEditor } from '../PresetEditor'
import { SettingRow, ToggleRow } from '../ui'

const AWAKE_MODES: Array<{ mode: AwakeMode; key: MessageKey }> = [
  { mode: 'auto', key: 'awake.mode.auto' },
  { mode: 'always', key: 'awake.mode.always' },
  { mode: 'never', key: 'awake.mode.never' },
]

const headingCls = 'text-xs font-semibold uppercase tracking-wide text-text-secondary'

/**
 * Agent "Behavior" block (E5-FR-29). Each key joins when its FR lands; today:
 * keep the PC awake and its display variant (E5-FR-23/24).
 */
function BehaviorBlock() {
  const t = useT()
  const awakeMode = useAppStore((s) => s.settings.awakeMode)
  const agents = useAppStore((s) => s.settings.agents)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <section className="space-y-4" aria-labelledby="agents-behavior">
      <h4 id="agents-behavior" className={headingCls}>
        {t('settings.agents.behavior')}
      </h4>
      <SettingRow title={t('settings.agents.awake')} description={t('settings.agents.awakeHint')}>
        <div role="radiogroup" aria-label={t('settings.agents.awake')} className="flex flex-wrap gap-2">
          {AWAKE_MODES.map(({ mode, key }) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={awakeMode === mode}
              data-awake-mode={mode}
              onClick={() => updateSettings({ awakeMode: mode })}
              className={cn(
                'rounded-btn border px-3 py-1 text-xs transition-colors',
                awakeMode === mode
                  ? 'border-accent-violet bg-accent-violet text-white'
                  : 'border-border bg-bg-secondary text-text-primary hover:border-accent-violet/40',
              )}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </SettingRow>
      <ToggleRow
        checked={agents.awakeDisplay}
        onChange={(v) => updateSettings({ agents: { ...agents, awakeDisplay: v } })}
        title={t('settings.agents.awakeDisplay')}
        description={t('settings.agents.awakeDisplayHint')}
        disabled={awakeMode === 'never'}
      />
    </section>
  )
}

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
    <div className="space-y-6">
      <BehaviorBlock />
      <section className="space-y-2 border-t border-border pt-5">
        <h4 className={headingCls}>{t('settings.agents.presets')}</h4>
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
      </section>
    </div>
  )
}
