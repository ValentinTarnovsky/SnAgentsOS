import { BellOff } from 'lucide-react'
import type { PaneStatus } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { NeedsChip } from './NeedsChip'
import { FailureChip } from './FailureChip'
import { SilenceChip } from './SilenceChip'
import { ContextChip } from './ContextChip'

/** "Silenciada hasta que cambie": a small bell-off mark (status.mute), 13 px like every chip (STYLEGUIDE 7). */
export function MutedMark({ noTooltip }: { noTooltip?: boolean }) {
  const t = useT()
  const mark = (
    <span data-pane-muted role="img" aria-label={t('pane.mutedTip')} className="flex shrink-0 text-text-secondary">
      <BellOff size={13} />
    </span>
  )
  return noTooltip ? mark : <Tooltip label={t('pane.mutedTip')} className="shrink-0">{mark}</Tooltip>
}

/**
 * The 2.7.0 signal chips of one console's status (A6), in reading order:
 * what it asked for (`snaos needs`), why its turn failed, its silence, its
 * context and the mute mark. A `bare` status (a `snaos needs` on a pane
 * with no agent) shows the needs chip alone. `ack` puts "Ignorar este
 * turno" on the silence chip; `compact` (the pane header, where the title
 * must stay readable) words every text chip short: the silence as an
 * hourglass and its minutes, the needs and failure capped at a fixed width
 * (their tooltips carry the whole text) and the context "~42%"; `dense` (a
 * sidebar row) leaves the context chip out and words the silence short;
 * `wrap` (a board card, where the chips wrap) lets the text chips take the
 * whole line; `noTooltip` leaves the hover to a parent.
 */
export function StatusSignals({
  paneId,
  status,
  ack = false,
  compact = false,
  dense = false,
  wrap = false,
  noTooltip,
}: {
  paneId: string
  status: PaneStatus | undefined
  ack?: boolean
  compact?: boolean
  dense?: boolean
  wrap?: boolean
  noTooltip?: boolean
}) {
  if (!status) return null
  // The share of the line a text chip may take next to a title or a phrase;
  // in the pane header a fixed cap, so a long request never eats the title,
  // and a shrink factor far above the title's, so the chip gives way first.
  const share = (cls: string): string | undefined => (wrap ? undefined : compact ? 'max-w-[9rem] [flex-shrink:999]' : cls)
  if (status.bare) return status.needs ? <NeedsChip needs={status.needs} noTooltip={noTooltip} className={share(dense ? 'max-w-full' : 'max-w-[60%]')} /> : null
  return (
    <>
      {status.needs && <NeedsChip needs={status.needs} noTooltip={noTooltip} className={share('max-w-[40%]')} />}
      {status.failure && <FailureChip failure={status.failure} noTooltip={noTooltip} className={share('max-w-[45%]')} />}
      {status.silence && (
        <SilenceChip paneId={paneId} silence={status.silence} ack={ack} form={compact ? 'header' : dense ? 'short' : 'long'} noTooltip={noTooltip} />
      )}
      {!dense && status.context && <ContextChip context={status.context} usage={status.usage} compact={compact} noTooltip={noTooltip} />}
      {status.muted && <MutedMark noTooltip={noTooltip} />}
    </>
  )
}

/** The pane header's signal chips, live from the store, with "Ignorar este turno" and every chip in its short header form. */
export function PaneSignals({ paneId }: { paneId: string }) {
  const status = useAppStore((s) => s.paneStatus[paneId])
  return <StatusSignals paneId={paneId} status={status} ack compact />
}
