import type { PaneNeeds } from '@shared/types'
import { useLang, useT } from '@/i18n'
import { clockTime } from '@/lib/statusSignals'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { STATUS_TIP_DELAY } from '@/components/ui/StatusDot'

/**
 * What the agent asked of the user with `snaos needs "<action>"` (app 2.7.0,
 * A6), in the amber of a request (`state-action`): the text, truncated, and
 * in the tooltip the whole text and when it asked. On a pane with no agent
 * (a `bare` status) it is all that shows. `noTooltip` leaves the hover to a
 * parent (a sidebar row).
 */
export function NeedsChip({ needs, noTooltip, className }: { needs: PaneNeeds; noTooltip?: boolean; className?: string }) {
  const t = useT()
  const lang = useLang()
  const label = t('status.needs.label', { text: needs.text })
  const chip = (
    <span
      data-needs-chip
      role="status"
      aria-label={label}
      className={cn(
        'flex min-w-0 items-center rounded border border-state-action/60 bg-state-action/15 px-1 text-[10px] font-medium leading-4 text-state-action',
        // cn is plain clsx: one max-width class only, or the stylesheet order picks.
        noTooltip && className ? className : 'max-w-full',
      )}
    >
      <span className="truncate">{needs.text}</span>
    </span>
  )
  if (noTooltip) return chip
  return (
    <Tooltip
      delay={STATUS_TIP_DELAY}
      className={cn('min-w-0', className)}
      label={
        <span className="flex flex-col" data-needs-tip>
          <span>{label}</span>
          <span className="font-normal text-text-secondary">{t('status.needs.tip', { time: clockTime(needs.at, lang, Date.now()) })}</span>
        </span>
      }
    >
      {chip}
    </Tooltip>
  )
}
