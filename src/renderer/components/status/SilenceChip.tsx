import { EyeOff, Hourglass } from 'lucide-react'
import type { PaneSilence } from '@shared/types'
import { useLang, useT } from '@/i18n'
import { clockTime, nextMinuteAt, silenceMinutes, silenceText } from '@/lib/statusSignals'
import { useTickAt } from '@/lib/useTickAt'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { STATUS_TIP_DELAY } from '@/components/ui/StatusDot'

/**
 * How a silence chip is worded: `long` "Sin señales hace 12 min" or
 * "Quizás trabado: 25 min sin señales" (a board card); `short` for a dense
 * row, "12 min sin señales"; `header` for the pane header, where the title
 * keeps its room, an hourglass and "12 min" or "¿Trabado? 25 min".
 */
export type SilenceForm = 'long' | 'short' | 'header'

/**
 * A working agent that has given no sign of life for a while (app 2.7.0,
 * A6, SilenceWatch in main). Monochrome, since silence is no state of its
 * own; the minutes move with one timeout to the next whole minute while
 * mounted. The long wording is always its accessible name and the first
 * line of its tooltip. `ack` puts "Ignorar este turno" (status.silenceAck)
 * inside the chip as an icon button, only where the chip is not inside
 * another button. Nothing here stops or writes to the agent. Short of room
 * the text truncates first, then the chip clips from its end: the ack goes
 * before the hourglass, and nothing paints past the chip.
 */
export function SilenceChip({
  paneId,
  silence,
  ack = false,
  form = 'long',
  noTooltip,
}: {
  paneId: string
  silence: PaneSilence
  ack?: boolean
  form?: SilenceForm
  noTooltip?: boolean
}) {
  const t = useT()
  const lang = useLang()
  const now = Date.now()
  useTickAt(nextMinuteAt(silence.since, now))
  const stalled = silence.level === 'stalled'
  const header = form === 'header'
  const long = silenceText(silence, t, now)
  const text = header
    ? t(stalled ? 'status.silence.stalledHeader' : 'status.silence.quietHeader', { min: silenceMinutes(silence, now) })
    : form === 'short'
      ? silenceText(silence, t, now, true)
      : long
  const status = (
    <span
      data-silence-chip={silence.level}
      role="status"
      aria-label={long}
      // A grid whose text column has no minimum: its own minimum width is the hourglass alone.
      className={cn('grid items-center gap-0.5', header ? 'grid-cols-[auto_minmax(0,max-content)]' : 'grid-cols-[minmax(0,max-content)]')}
    >
      {header && <Hourglass size={13} aria-hidden />}
      <span className="truncate">{text}</span>
    </span>
  )
  return (
    <span
      className={cn(
        'flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded border px-1 text-[10px] leading-4 tabular-nums',
        // In the pane header it gives way long before the title does (PaneCell).
        header && '[flex-shrink:999]',
        stalled ? 'border-text-secondary/60 font-medium text-text-primary' : 'border-border text-text-secondary',
      )}
    >
      {noTooltip ? (
        status
      ) : (
        <Tooltip
          delay={STATUS_TIP_DELAY}
          className="shrink"
          label={
            <span className="flex flex-col" data-silence-tip>
              <span>{long}</span>
              <span className="font-normal text-text-secondary">{t('status.silence.tip', { time: clockTime(silence.since, lang, now) })}</span>
            </span>
          }
        >
          {status}
        </Tooltip>
      )}
      {ack && (
        <Tooltip label={t('status.silence.ack')} className="shrink-0">
          <button
            type="button"
            draggable={false}
            data-silence-ack={paneId}
            aria-label={t('status.silence.ack')}
            onClick={() => void window.snApi.status.silenceAck(paneId).catch(() => false)}
            className="rounded text-text-secondary transition-colors hover:text-text-primary"
          >
            <EyeOff size={13} />
          </button>
        </Tooltip>
      )}
    </span>
  )
}
