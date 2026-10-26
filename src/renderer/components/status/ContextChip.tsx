import type { PaneContext, PaneUsage } from '@shared/types'
import { useLang, useT } from '@/i18n'
import { contextLines, contextPercent } from '@/lib/statusSignals'
import { Tooltip } from '@/components/ui/Tooltip'
import { STATUS_TIP_DELAY } from '@/components/ui/StatusDot'

/**
 * How full the agent's context window is (app 2.7.0, A6, ConsoleLedger in
 * main): a small meter and the percent, "estimado" unless the agent
 * reported the call and its window (Codex). `compact` (the pane header,
 * where the title needs the room) shows "~42%" for an estimate and "42%"
 * for an exact one; the word "estimado" then lives in the tooltip and the
 * aria label. The tooltip carries the tokens used of the window and what
 * the console spent, always as an estimate ("costo desconocido" when part
 * has no known price). Monochrome: a full context is no state.
 */
export function ContextChip({ context, usage, compact, noTooltip }: { context: PaneContext; usage?: PaneUsage; compact?: boolean; noTooltip?: boolean }) {
  const t = useT()
  const lang = useLang()
  const pct = contextPercent(context)
  const short = context.exact ? `${pct}%` : t(compact ? 'status.context.approx' : 'status.context.short', { pct })
  const label = context.exact ? t('status.context.label', { pct }) : `${t('status.context.label', { pct })} (${t('status.context.estimated')})`
  const chip = (
    <span
      data-context-chip={pct}
      data-context-exact={context.exact ? 'true' : 'false'}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
      className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border px-1 text-[10px] leading-4 tabular-nums text-text-secondary"
    >
      <span aria-hidden className="relative h-1 w-3.5 overflow-hidden rounded-full bg-text-secondary/25">
        <span className="absolute inset-y-0 left-0 rounded-full bg-text-secondary" style={{ width: `${pct}%` }} />
      </span>
      {short}
    </span>
  )
  if (noTooltip) return chip
  return (
    <Tooltip
      delay={STATUS_TIP_DELAY}
      className="shrink-0"
      label={
        <span className="flex flex-col" data-context-tip>
          {contextLines(context, usage, t, lang).map((line, i) => (
            <span key={i} className={i === 0 ? undefined : 'font-normal text-text-secondary'}>
              {line}
            </span>
          ))}
        </span>
      }
    >
      {chip}
    </Tooltip>
  )
}
