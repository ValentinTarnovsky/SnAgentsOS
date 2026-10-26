import { useState } from 'react'
import { Square } from 'lucide-react'
import { formatAge } from '@shared/agents'
import { isActiveRun, type RunOutcome, type RunState } from '@shared/teams'
import type { PaneUsage } from '@shared/types'
import type { RunView } from '@shared/team-protocol'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { MODE_KEY, runUsageText, stopRun, triggerKey } from '@/lib/teams/roster'
import { Tooltip } from '@/components/ui/Tooltip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { STATUS_TIP_DELAY } from '@/components/ui/StatusDot'
import { useNow } from '@/components/sidebar/AgentRows'
import { FailureChip } from '@/components/status/FailureChip'
import { ContextChip } from '@/components/status/ContextChip'

// cn is plain clsx: these carry no shrink and no text color, so each use adds its own without a clash.
export const RUN_CHIP = 'inline-flex max-w-full items-center gap-1 rounded border px-1 text-[10px] leading-4'
export const RUN_CHIP_NEUTRAL = 'border-border text-text-secondary'
export const SMALL_BTN =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-btn border border-border px-2.5 text-xs font-medium transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60'
export const SMALL_BTN_TEXT = 'text-text-primary'
export const SMALL_BTN_QUIET = 'text-text-secondary hover:text-text-primary'

export const RUN_STATE_KEY: Record<RunState, MessageKey> = {
  queued: 'teams.run.state.queued',
  starting: 'teams.run.state.starting',
  running: 'teams.run.state.running',
  stopping: 'teams.run.state.stopping',
  succeeded: 'teams.run.state.succeeded',
  failed: 'teams.run.state.failed',
  cancelled: 'teams.run.state.cancelled',
  interrupted: 'teams.run.state.interrupted',
  takenOver: 'teams.run.state.takenOver',
}

const OUTCOME_KEY: Record<RunOutcome, MessageKey> = {
  concluded: 'teams.run.outcome.concluded',
  progress: 'teams.run.outcome.progress',
  planOnly: 'teams.run.outcome.planOnly',
  empty: 'teams.run.outcome.empty',
  failed: 'teams.run.outcome.failed',
}

/** How long a live run has been going ("12 min"), on the existing minute clock; mounted only while it runs. */
export function ElapsedChip({ since, tipKey }: { since: number; tipKey: MessageKey }) {
  const t = useT()
  const now = useNow(30_000)
  const age = formatAge(now - since)
  return (
    <Tooltip label={t(tipKey, { age })} delay={STATUS_TIP_DELAY} className="shrink-0">
      <span data-run-elapsed className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0 tabular-nums')} aria-label={t(tipKey, { age })}>
        {age}
      </span>
    </Tooltip>
  )
}

/** What a run spent, always worded as an estimate. Nothing without usage. */
export function UsageChip({ usage }: { usage: PaneUsage | undefined }) {
  const t = useT()
  const lang = useLang()
  const text = runUsageText(usage, t, lang)
  if (!text) return null
  return (
    <span data-run-usage className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'min-w-0 shrink tabular-nums')}>
      <span className="truncate">{text}</span>
    </span>
  )
}

/** Frenar, after a confirm: main stops the run and its whole process tree. Only while the run is live and not stopping. */
export function StopRunButton({ teamId, run, agentName }: { teamId: string; run: Pick<RunView, 'id' | 'state'>; agentName: string }) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!isActiveRun(run.state) || run.state === 'stopping') return null
  return (
    <>
      <button type="button" data-run-stop={run.id} disabled={busy} onClick={() => setAsking(true)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
        <Square size={13} aria-hidden />
        {t('teams.agent.stop')}
      </button>
      <ConfirmDialog
        open={asking}
        title={t('teams.run.stopTitle', { agent: agentName })}
        message={t('teams.run.stopMsg')}
        confirmLabel={t('teams.run.stopYes')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          setAsking(false)
          setBusy(true)
          void stopRun(teamId, run.id).then((fail) => {
            setBusy(false)
            if (fail) toast.error(t('teams.run.stopFailed'))
          })
        }}
        onCancel={() => setAsking(false)}
      />
    </>
  )
}

/**
 * The header of a run in the agent drawer (app 2.7.0, E10 B2): its mode,
 * state and outcome, how long it ran, why it started, its failure, context
 * and spend (an estimate), and Frenar while it is live.
 */
export function RunHeader({ teamId, run, agentName }: { teamId: string; run: RunView; agentName: string }) {
  const t = useT()
  const live = isActiveRun(run.state)
  const took = !live && run.startedAt && run.endedAt && run.endedAt >= run.startedAt ? formatAge(run.endedAt - run.startedAt) : null
  return (
    <div data-run-header={run.id} data-run-state={run.state} className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
      <span data-run-mode={run.mode} className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0')}>
        {t(MODE_KEY[run.mode])}
      </span>
      <span data-run-state-label className="shrink-0 text-xs font-medium text-text-primary">
        {t(RUN_STATE_KEY[run.state])}
      </span>
      {!live && run.outcome && run.state !== 'failed' && (
        <span data-run-outcome={run.outcome} className="shrink-0 text-[11px] text-text-secondary">
          {t(OUTCOME_KEY[run.outcome])}
        </span>
      )}
      {live && run.startedAt ? <ElapsedChip since={run.startedAt} tipKey="teams.run.elapsedTip" /> : null}
      {took && (
        <span data-run-took className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0 tabular-nums')} aria-label={t('teams.run.durationTip', { age: took })}>
          {took}
        </span>
      )}
      {run.failure && <FailureChip failure={run.failure} className="max-w-[60%]" />}
      {run.context && <ContextChip context={run.context} usage={run.usage} />}
      <UsageChip usage={run.usage} />
      {run.resumed && <span className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0')}>{t('teams.run.resumed')}</span>}
      <span data-run-trigger={run.trigger} className="min-w-0 truncate text-[11px] text-text-secondary">
        {t('teams.run.trigger', { reason: t(triggerKey(run)) })}
      </span>
      <div className="ml-auto flex shrink-0 items-center">
        <StopRunButton teamId={teamId} run={run} agentName={agentName} />
      </div>
    </div>
  )
}
