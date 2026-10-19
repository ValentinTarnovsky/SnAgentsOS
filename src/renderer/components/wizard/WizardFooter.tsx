import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'

interface WizardFooterProps {
  step: number
  isLast: boolean
  canAdvance: boolean
  onBack: () => void
  onNext: () => void
  onCreate: () => void
  onCancel: () => void
}

const ENTER = ['Enter']

export function WizardFooter({
  step,
  isLast,
  canAdvance,
  onBack,
  onNext,
  onCreate,
  onCancel,
}: WizardFooterProps) {
  const t = useT()
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {step > 0 && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={15} />
            {t('common.back')}
          </Button>
        )}
        {/* Steps before the last only have Next: say that Ctrl+Enter skips ahead (E4-FR-29). */}
        {!isLast && (
          <span data-wizard-ctrl-enter className="min-w-0 truncate text-xs text-text-secondary/70">
            {t('wizard.ctrlEnterHint')}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {isLast ? (
          <Button size="sm" onClick={onCreate} disabled={!canAdvance} keyHint={ENTER} data-wizard-primary="create">
            <Check size={15} />
            {t('common.create')}
          </Button>
        ) : (
          <Button size="sm" onClick={onNext} disabled={!canAdvance} keyHint={ENTER} data-wizard-primary="next">
            {t('common.next')}
            <ArrowRight size={15} />
          </Button>
        )}
      </div>
    </div>
  )
}
