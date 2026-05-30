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
    <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3">
      <div>
        {step > 0 && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={15} />
            {t('common.back')}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {isLast ? (
          <Button size="sm" onClick={onCreate} disabled={!canAdvance}>
            <Check size={15} />
            {t('common.create')}
          </Button>
        ) : (
          <Button size="sm" onClick={onNext} disabled={!canAdvance}>
            {t('common.next')}
            <ArrowRight size={15} />
          </Button>
        )}
      </div>
    </div>
  )
}
