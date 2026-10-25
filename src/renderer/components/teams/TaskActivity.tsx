import { MessageSquare } from 'lucide-react'
import { formatAge } from '@shared/agents'
import { isActiveRun } from '@shared/teams'
import type { AgentView, RunView } from '@shared/team-protocol'
import { useLang, useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { clockTime } from '@/lib/statusSignals'
import { openAgentDrawer } from '@/lib/teamsStore'
import { MODE_KEY, TRIGGER_KEY } from '@/lib/teams/roster'
import { FailureChip } from '@/components/status/FailureChip'
import { RUN_CHIP, RUN_CHIP_NEUTRAL, RUN_STATE_KEY, SMALL_BTN, SMALL_BTN_TEXT, UsageChip } from './RunHeader'
import { agentNameOf } from './TaskCard'

/**
 * The runs of a task (app 2.7.0, E10 B3), newest first (main sends the
 * newest 10): who ran, in which mode and why, how it ended and how long it
 * took, its failure and its spend (always an estimate), and the run's own
 * summary. "Ver chat" opens that run in the agent drawer.
 */
export function TaskActivity({ runs, agents }: { runs: readonly RunView[]; agents: Readonly<Record<string, AgentView>> }) {
  const t = useT()
  const lang = useLang()
  if (runs.length === 0) return <p className="text-xs text-text-secondary">{t('teams.task.noRuns')}</p>
  const now = Date.now()
  const sorted = [...runs].sort((a, b) => b.queuedAt - a.queuedAt)
  return (
    <ol data-task-activity className="flex flex-col gap-2">
      {sorted.map((r) => {
        const live = isActiveRun(r.state)
        const took = !live && r.startedAt && r.endedAt && r.endedAt >= r.startedAt ? formatAge(r.endedAt - r.startedAt) : null
        return (
          <li key={r.id} data-task-run={r.id} data-run-state={r.state} className="min-w-0 rounded-btn border border-border bg-card/40 px-2.5 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 truncate text-xs font-medium text-text-primary">{t('teams.task.runLine', { agent: agentNameOf(agents, r.agentId), mode: t(MODE_KEY[r.mode]) })}</span>
              <span className={cn(RUN_CHIP, live ? 'border-state-working/60 text-text-primary' : RUN_CHIP_NEUTRAL, 'shrink-0')}>{t(RUN_STATE_KEY[r.state])}</span>
              {took && <span className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0 tabular-nums')}>{took}</span>}
              <span className="text-[11px] tabular-nums text-text-secondary">{clockTime(r.startedAt ?? r.queuedAt, lang, now)}</span>
              <button type="button" data-task-run-chat={r.id} onClick={() => openAgentDrawer(r.agentId, r.id, 'run')} className={cn(SMALL_BTN, SMALL_BTN_TEXT, 'ml-auto h-6 px-2')}>
                <MessageSquare size={13} aria-hidden />
                {t('teams.task.viewRun')}
              </button>
            </div>
            <p className="mt-1 min-w-0 truncate text-[11px] text-text-secondary">{t('teams.run.trigger', { reason: t(TRIGGER_KEY[r.trigger]) })}</p>
            {(r.failure || r.usage) && (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                {r.failure && <FailureChip failure={r.failure} className="max-w-full" />}
                <UsageChip usage={r.usage} />
              </div>
            )}
            {r.summary && <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-text-primary/90">{r.summary}</p>}
          </li>
        )
      })}
    </ol>
  )
}
