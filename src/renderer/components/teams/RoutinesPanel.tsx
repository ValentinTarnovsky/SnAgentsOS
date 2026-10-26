import { useEffect, useId, useState } from 'react'
import { Play, Repeat } from 'lucide-react'
import { formatRunWhen } from '@shared/schedule'
import type { RoleSummary, RoutineView } from '@shared/team-protocol'
import { useLang, useT, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useTickAt } from '@/lib/useTickAt'
import { openAgentDrawer, openTaskDrawer, useTeamsStore } from '@/lib/teamsStore'
import { loadRoutines, routineFailText, routineKey, runRoutine, useRoutinesStore } from '@/lib/teams/routines'
import { loadRoster, useRosterStore } from '@/lib/teams/roster'
import { visibleName } from '@/lib/teams/issues'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { RUN_CHIP, RUN_CHIP_NEUTRAL, SMALL_BTN, SMALL_BTN_TEXT } from './RunHeader'

export const PANEL_TITLE = 'text-[11px] font-semibold uppercase tracking-wide text-text-secondary'

/** A routine's name: its title, else its id, with hiding characters spelled out (it is repo text). */
export function routineName(r: Pick<RoutineView, 'id' | 'title'>): string {
  return visibleName(r.title || r.id)
}

/** "Despierta al Líder", "Despierta a QA", "Crea una tarea para Dev": what a fire does, with the role of the definition. */
function actionText(r: RoutineView, role: RoleSummary | undefined, t: TFn): string {
  const name = role ? role.name : r.role
  if (r.action === 'task') return t('teams.routine.task', { role: name })
  return role?.kind === 'lead' ? t('teams.routine.wakeLead') : t('teams.routine.wake', { role: name })
}

/** "Watch" on the toast of a fired run: the agent whose run it is (from the roster), its drawer on that run. */
async function watchRun(teamId: string, runId: string): Promise<void> {
  const find = (): string | undefined => useRosterStore.getState().rosters[teamId]?.agents.find((a) => a.run?.id === runId || a.lastRun?.id === runId)?.id
  const agentId = find() ?? ((await loadRoster(teamId)) ? find() : undefined)
  if (agentId && useTeamsStore.getState().openTeamId === teamId) openAgentDrawer(agentId, runId, 'run')
}

function RoutineRow({ teamId, routine: r, role, trusted, now }: { teamId: string; routine: RoutineView; role: RoleSummary | undefined; trusted: boolean; now: number }) {
  const t = useT()
  const lang = useLang()
  const busy = useRoutinesStore((s) => !!s.busy[routineKey(teamId, r.id)])
  // Why the last "Correr ahora" did not run, under the row (never a silent no-op).
  const [note, setNote] = useState<string | null>(null)
  const name = routineName(r)

  const go = (): void => {
    setNote(null)
    void runRoutine(teamId, r.id).then((res) => {
      if (!res.ok) {
        setNote(routineFailText(res, t, lang, Date.now()))
        return
      }
      // Main answers the task it made or the run it started, always one of them (a run that cannot start now is a
      // `deferred` refusal under the row).
      if (res.taskId) {
        const task = res.taskId
        toast.success(t('teams.routine.ranTask', { name, task }), { actions: [{ label: t('teams.routine.viewTask'), run: () => openTaskDrawer(task) }] })
      } else if (res.runId) {
        const runId = res.runId
        toast.success(t('teams.routine.ranRun', { name }), { actions: [{ label: t('teams.routine.watch'), run: () => void watchRun(teamId, runId) }] })
      }
    })
  }

  let next: string | null = null
  if (r.enabled) {
    if (r.nextAt === null) next = t('teams.routine.noNext')
    else if (r.nextAt <= now) next = t('teams.routine.due')
    else next = t('teams.routine.next', { when: formatRunWhen(r.nextAt, lang, now) })
  }
  const last = r.last
  const lastState = !last ? 'never' : last.skipped ? 'skipped' : 'ran'
  const lastText = !last
    ? t('teams.routine.never')
    : last.skipped
      ? t('teams.routine.skipped', { when: formatRunWhen(last.at, lang, now) })
      : t('teams.routine.last', { when: formatRunWhen(last.at, lang, now) })
  const lastTask = last && !last.skipped ? last.taskId : undefined

  return (
    <li data-routine={r.id} data-routine-enabled={r.enabled ? 'true' : 'false'} className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-card/40 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Repeat size={13} className="shrink-0 text-text-secondary" aria-hidden />
        <span data-routine-title className="min-w-0 truncate text-sm font-medium text-text-primary">
          {name}
        </span>
        {r.title && <span className="min-w-0 truncate font-mono text-[11px] text-text-secondary">{visibleName(r.id)}</span>}
        <span data-routine-action={r.action} className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'min-w-0')}>
          <span className="truncate">{actionText(r, role, t)}</span>
        </span>
        {!r.enabled && (
          <Tooltip label={t('teams.routine.offTip')} className="shrink-0">
            <span data-routine-off className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0')}>
              {t('teams.routine.off')}
            </span>
          </Tooltip>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          <button type="button" data-routine-run={r.id} disabled={busy || !trusted} onClick={go} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
            <Play size={13} aria-hidden />
            {t('teams.routine.runNow')}
          </button>
        </span>
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-secondary">
        <span data-routine-cron className="min-w-0 break-all font-mono">
          {t('teams.routine.cron', { expr: r.cron.trim().replace(/\s+/g, ' ') })}
        </span>
        {next !== null && (
          <span data-routine-next className="min-w-0 tabular-nums text-text-primary/90">
            {next}
          </span>
        )}
        <span data-routine-last={lastState} className="flex min-w-0 flex-wrap items-center gap-x-1.5 tabular-nums">
          <span className="min-w-0">{lastText}</span>
          {lastTask && (
            <button type="button" data-routine-task={lastTask} onClick={() => openTaskDrawer(lastTask)} className="shrink-0 rounded font-mono text-accent-violet underline-offset-2 hover:underline">
              {t('teams.routine.openTask', { task: lastTask })}
            </button>
          )}
        </span>
      </p>
      {note && (
        <p data-routine-note role="status" className="text-xs text-state-error">
          {note}
        </p>
      )}
    </li>
  )
}

/**
 * The routines of a team under the Agentes roster (app 2.7.0, E10 B7), read
 * only: they live in the team's `routines/<id>.md` files and a change goes
 * through trust. Each row: its name, what a fire does (wake its role's agent
 * or create a task for it), its cron with the next run (`formatRunWhen`, the
 * A10 rule: the weekday within the next days, the date beyond), its last run
 * (or the one main skipped because over 2 h went by with the app closed, the
 * lab off or the PC asleep) and "Correr ahora" (`routineRun`; a refusal says
 * why under the row). Nothing is sent to a console.
 */
export function RoutinesPanel({ teamId }: { teamId: string }) {
  const t = useT()
  const headId = useId()
  const list = useRoutinesStore((s) => s.routines[teamId])
  const failed = useRoutinesStore((s) => !!s.routinesFailed[teamId])
  const view = useTeamsStore((s) => s.views[teamId])
  useEffect(() => {
    void loadRoutines(teamId)
  }, [teamId])

  const now = Date.now()
  // The soonest next run re-renders the panel (its label then says it runs in a moment) and, once one is due, the
  // routines come again a little later in case its fire brought no change event: one timeout, never an interval.
  const ahead = (list ?? []).filter((r) => r.enabled && r.nextAt !== null && r.nextAt > now).map((r) => r.nextAt as number)
  useTickAt(ahead.length > 0 ? Math.min(...ahead) : null)
  const overdue = (list ?? []).some((r) => r.enabled && r.nextAt !== null && r.nextAt <= now)
  useEffect(() => {
    if (!overdue) return
    const id = setTimeout(() => void loadRoutines(teamId), 5000)
    return () => clearTimeout(id)
  }, [overdue, teamId])

  const trusted = !view || view.trust === 'trusted'
  let body
  if (!list) {
    body = failed ? (
      <div className="flex flex-col items-start gap-2" data-routines-failed>
        <p className="text-sm text-text-secondary">{t('teams.routine.loadFailed')}</p>
        <Button variant="ghost" size="sm" data-routines-retry onClick={() => void loadRoutines(teamId)}>
          {t('teams.routine.retry')}
        </Button>
      </div>
    ) : (
      <p className="text-sm text-text-secondary" data-routines-loading>
        {t('teams.routine.loading')}
      </p>
    )
  } else if (list.length === 0) {
    body = (
      <p className="text-sm text-text-secondary" data-routines-empty>
        {t('teams.routine.empty')}
      </p>
    )
  } else {
    body = (
      <ul className="flex min-w-0 flex-col gap-2">
        {list.map((r) => (
          <RoutineRow key={r.id} teamId={teamId} routine={r} role={view?.roles.find((x) => x.id === r.role)} trusted={trusted} now={now} />
        ))}
      </ul>
    )
  }
  return (
    <section data-routines-panel={teamId} aria-labelledby={headId} className="flex min-w-0 flex-col gap-2 pt-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 id={headId} className={PANEL_TITLE}>
          {t('teams.routine.title')}
        </h3>
        <p className="text-[11px] text-text-secondary">{t('teams.routine.hint')}</p>
        {!trusted && list && list.length > 0 && (
          <p data-routines-untrusted className="text-[11px] text-state-action">
            {t('teams.routine.untrusted')}
          </p>
        )}
      </div>
      {body}
    </section>
  )
}
