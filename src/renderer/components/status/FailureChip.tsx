import type { FailureInfo } from '@shared/failure'
import { useLang, useT } from '@/i18n'
import { failureText } from '@/lib/statusSignals'
import { useTickAt } from '@/lib/useTickAt'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { STATUS_TIP_DELAY } from '@/components/ui/StatusDot'

/**
 * Why the console's last turn failed (app 2.7.0, A6): "Límite de uso hasta
 * 15:30", in the error state's red. The reset drops off on its own when it
 * passes (one timeout to it, no ticker); the tooltip adds the provider's
 * code. `noTooltip` leaves the hover to a parent (a sidebar row).
 */
export function FailureChip({ failure, noTooltip, className }: { failure: FailureInfo; noTooltip?: boolean; className?: string }) {
  const t = useT()
  const lang = useLang()
  const now = Date.now()
  useTickAt(failure.until && failure.until > now ? failure.until : null)
  const text = failureText(failure, t, lang, now)
  const chip = (
    <span
      data-failure-chip={failure.kind}
      role="status"
      aria-label={text}
      className={cn(
        'flex min-w-0 shrink items-center rounded border border-state-error/50 bg-state-error/10 px-1 text-[10px] font-medium leading-4 text-state-error',
        // cn is plain clsx: one max-width class only, or the stylesheet order picks.
        noTooltip && className ? className : 'max-w-full',
      )}
    >
      <span className="truncate">{text}</span>
    </span>
  )
  if (noTooltip) return chip
  return (
    <Tooltip
      delay={STATUS_TIP_DELAY}
      className={cn('min-w-0', className)}
      label={
        <span className="flex flex-col" data-failure-tip>
          <span>{text}</span>
          {failure.code && <span className="font-normal text-text-secondary">{t('status.failure.code', { code: failure.code })}</span>}
        </span>
      }
    >
      {chip}
    </Tooltip>
  )
}
