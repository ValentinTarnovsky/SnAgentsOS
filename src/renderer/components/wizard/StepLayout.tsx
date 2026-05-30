import { useT } from '@/i18n'
import { GRID_COLS, GRID_PRESETS } from '@/components/layout/gridTemplates'
import { cn } from '@/lib/cn'
import type { StepProps } from './types'

export function StepLayout({ draft, update }: StepProps) {
  const t = useT()

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">{t('wizard.howMany')}</span>
          <span className="text-xs text-text-secondary">{t('wizard.howManyHint')}</span>
        </div>
        <span className="rounded-full bg-accent-violet/15 px-2.5 py-0.5 text-xs font-medium text-accent-violet">
          {draft.grid === 1 ? t('wizard.oneTerminal') : t('wizard.gridOf', { n: draft.grid })}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {GRID_PRESETS.map((preset) => {
          const cols = GRID_COLS[preset]
          const selected = draft.grid === preset
          return (
            <button
              key={preset}
              onClick={() => update({ grid: preset })}
              className={cn(
                'flex aspect-square flex-col items-center justify-center gap-2 rounded-btn border bg-bg-primary p-2 transition-colors',
                selected
                  ? 'border-accent-violet bg-accent-violet/10'
                  : 'border-border hover:border-accent-violet/40',
              )}
            >
              <div
                className="grid w-9 gap-0.5"
                style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
              >
                {Array.from({ length: preset }).map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-2 rounded-[2px]',
                      selected ? 'bg-accent-violet' : 'bg-text-secondary/40',
                    )}
                  />
                ))}
              </div>
              <span
                className={cn(
                  'text-sm font-semibold',
                  selected ? 'text-accent-violet' : 'text-text-secondary',
                )}
              >
                {preset}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
