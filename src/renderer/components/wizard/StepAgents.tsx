import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { iconFor } from '@/lib/icons'
import { cn } from '@/lib/cn'
import type { StepProps } from './types'

export function StepAgents({ draft, update }: StepProps) {
  const t = useT()
  const presets = useAppStore((s) => s.presets)
  const connections = useAppStore((s) => s.connections)

  const setAssignment = (index: number, presetId: string): void => {
    const next = [...draft.assignments]
    next[index] = presetId
    update({ assignments: next })
  }

  const applyAll = (presetId: string): void => {
    update({ assignments: draft.assignments.map(() => presetId) })
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{t('wizard.assignAgents')}</p>

      {connections.length > 0 && (
        <div className="rounded-btn border border-border bg-bg-primary px-3 py-2.5">
          <div className="mb-1.5 flex items-baseline gap-2">
            <label className="text-xs font-medium text-text-primary">
              {t('wizard.connection')}
            </label>
            <span className="text-[11px] text-text-secondary">{t('wizard.connectionHint')}</span>
          </div>
          <select
            value={draft.setupId}
            onChange={(e) => update({ setupId: e.target.value })}
            className="h-9 w-full rounded-btn border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet"
          >
            <option value="" className="bg-card">
              {t('wizard.connectionNone')}
            </option>
            {connections.map((c) => (
              <option key={c.id} value={c.id} className="bg-card">
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-btn border border-dashed border-border bg-bg-secondary/40 px-3 py-2">
        <span className="text-xs font-medium text-text-secondary">{t('wizard.applyAll')}</span>
        {presets.map((preset) => {
          const Icon = iconFor(preset.icon)
          return (
            <button
              key={preset.id}
              onClick={() => applyAll(preset.id)}
              className="flex items-center gap-1.5 rounded-btn border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-accent-violet/50 hover:text-text-primary"
            >
              <Icon size={13} style={{ color: preset.color }} />
              {preset.name}
            </button>
          )
        })}
      </div>

      <div className="space-y-2">
        {draft.assignments.map((presetId, i) => (
          <div
            key={i}
            className="flex flex-wrap items-center gap-3 rounded-btn border border-border bg-bg-primary px-3 py-2"
          >
            <span className="w-24 shrink-0 text-xs font-medium text-text-secondary">
              {t('wizard.terminal', { n: i + 1 })}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => {
                const Icon = iconFor(preset.icon)
                const selected = presetId === preset.id
                return (
                  <button
                    key={preset.id}
                    onClick={() => setAssignment(i, preset.id)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-btn border px-2.5 py-1 text-xs transition-colors',
                      selected
                        ? 'border-accent-violet bg-accent-violet/10 text-text-primary'
                        : 'border-border text-text-secondary hover:text-text-primary',
                    )}
                  >
                    <Icon size={13} style={{ color: preset.color }} />
                    {preset.name}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
