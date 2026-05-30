import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { iconFor } from '@/lib/icons'
import { cn } from '@/lib/cn'
import type { StepProps } from './types'

export function StepAgents({ draft, update }: StepProps) {
  const t = useT()
  const presets = useAppStore((s) => s.presets)

  const setAssignment = (index: number, presetId: string): void => {
    const next = [...draft.assignments]
    next[index] = presetId
    update({ assignments: next })
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{t('wizard.assignAgents')}</p>
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
