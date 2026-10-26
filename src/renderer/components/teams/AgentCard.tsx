import { useState, type ReactNode } from 'react'
import { EyeOff, MessageSquare, Pause, Play } from 'lucide-react'
import { isActiveRun, teamPaneId } from '@shared/teams'
import type { AgentView, RunView, TaskRunRef } from '@shared/team-protocol'
import { useT, type MessageKey, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { openAgentDrawer } from '@/lib/teamsStore'
import { agentLabel, deferReason, openRunNow, pauseAgent } from '@/lib/teams/roster'
import { ackRunSilence, useRunSilence } from '@/lib/teams/routines'
import { StatusGlyph, type GlyphKind } from '@/components/ui/StatusDot'
import { Tooltip } from '@/components/ui/Tooltip'
import { FailureChip } from '@/components/status/FailureChip'
import { ContextChip } from '@/components/status/ContextChip'
import { SilenceChip } from '@/components/status/SilenceChip'
import { KIND_KEY } from './TeamEmptyTab'
import { ElapsedChip, RUN_CHIP, RUN_CHIP_NEUTRAL, SMALL_BTN, SMALL_BTN_QUIET, SMALL_BTN_TEXT, StopRunButton, UsageChip } from './RunHeader'
import { TakeoverButton } from './TakeoverChip'

const PROVIDER_KEY: Record<AgentView['provider'], MessageKey> = {
  claude: 'pane.runningAgent.claude',
  codex: 'pane.runningAgent.codex',
}

/** The card's glyph: working while a run is live, the last run's end otherwise. */
function glyphOf(a: AgentView): GlyphKind {
  if (a.takeover || a.status === 'takenOver') return 'action'
  if (a.run && isActiveRun(a.run.state)) return 'working'
  if (a.waiting) return 'waiting'
  if (a.lastRun?.state === 'failed') return 'error'
  if (a.lastRun?.state === 'succeeded') return 'done'
  return 'idle'
}

/** A takeover's line by its phase (B9): "En una consola" only once a console holds the agent. */
const TAKEOVER_LINE: Record<NonNullable<AgentView['takeover']>['phase'], MessageKey> = {
  stopping: 'teams.agent.takeoverStopping',
  bindPending: 'teams.agent.takeoverWaiting',
  bound: 'teams.agent.inConsole',
  releasing: 'teams.agent.takeoverReleasing',
}

/** Line 2 of a card: what the agent is on ("Trabajando en t-12", "Libre", "Esperando: ..."). */
export function agentLine(a: AgentView, t: TFn): string {
  if (a.takeover) return t(TAKEOVER_LINE[a.takeover.phase])
  if (a.status === 'takenOver') return t('teams.agent.inConsole')
  const run = a.run && isActiveRun(a.run.state) ? a.run : undefined
  if (run) {
    if (run.state === 'queued' || run.state === 'starting') return t('teams.agent.starting')
    if (run.state === 'stopping') return t('teams.agent.stopping')
    const task = run.taskId ?? a.taskId
    return task ? t('teams.agent.workingOn', { task }) : t('teams.agent.working')
  }
  if (a.waiting) {
    const reason = deferReason(a.waiting, t)
    if (reason) return t('teams.agent.waiting', { reason })
  }
  return t('teams.agent.idle')
}

/**
 * A live run that has given no sign of life for a while (app 2.7.0, E10 B7:
 * main's second SilenceWatch over the run's last line): the A6 SilenceChip,
 * monochrome, "Sin señales hace 12 min" or "Quizás trabado: 25 min sin
 * señales". With `teamId` it carries "Ignorar el silencio de esta corrida"
 * (`runSilenceAck`, never the console's status.silenceAck: a run has no
 * pane), which hides it at once; without it (a board card, whose click opens
 * the task) the chip only shows. Nothing here stops or writes to the run.
 */
export function RunSilenceChip({ run, teamId }: { run: Pick<RunView | TaskRunRef, 'id' | 'silence'>; teamId?: string }) {
  const t = useT()
  const silence = useRunSilence(run)
  if (!silence) return null
  return (
    <span data-run-silence={run.id} className="flex min-w-0 max-w-full items-center gap-1">
      <SilenceChip paneId={teamPaneId(run.id)} silence={silence} />
      {teamId && (
        <Tooltip label={t('teams.silence.ack')} className="shrink-0">
          <button
            type="button"
            data-run-silence-ack={run.id}
            aria-label={t('teams.silence.ack')}
            onClick={() => {
              void ackRunSilence(teamId, run.id).then((fail) => {
                if (fail) toast.error(t('teams.silence.ackFailed'))
              })
            }}
            className="flex rounded text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60"
          >
            <EyeOff size={13} />
          </button>
        </Tooltip>
      )}
    </span>
  )
}

/**
 * One agent of the Agentes tab (app 2.7.0, E10 B2): its name, role, agent and
 * model; what it is on; while a run is live how long it runs, plus the run's
 * failure, silence (B7, with its ignore button), context and spend (an
 * estimate); and its actions: the chat drawer,
 * "Ejecutar ahora" (an idle agent: it opens the drawer's composer, nothing
 * runs before its button), Frenar (a live run, after a confirm), "Tomar el
 * control" or, once a console holds it, "Ir a la consola" (B9) and the
 * agent's pause. `wide` is the Lead's full-width look; `children` goes under
 * the actions (the Lead card's extra lines).
 */
export function AgentCard({ teamId, agent: a, wide, hint, children }: { teamId: string; agent: AgentView; wide?: boolean; hint?: string; children?: ReactNode }) {
  const t = useT()
  const [pausing, setPausing] = useState(false)
  const name = agentLabel(a)
  const live = a.run && isActiveRun(a.run.state) ? a.run : undefined
  const shown = live ?? a.lastRun
  const failure = live ? live.failure : a.lastRun?.failure
  const context = live?.context ?? a.context
  const canRun = a.status === 'idle' && !a.retired && !a.takeover
  const togglePause = (): void => {
    const on = !a.paused
    setPausing(true)
    void pauseAgent(teamId, a.id, on).then((fail) => {
      setPausing(false)
      if (fail) toast.error(t(on ? 'teams.agent.pauseFailed' : 'teams.agent.resumeFailed'))
    })
  }
  return (
    <article
      data-agent-card={a.id}
      data-agent-status={a.status}
      data-agent-paused={a.paused ? 'true' : undefined}
      data-agent-kind={a.kind}
      aria-label={name}
      className={cn('flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card/40 px-3 py-2.5', a.retired && 'opacity-70', wide && 'w-full')}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusGlyph kind={glyphOf(a)} size={13} />
        <span data-agent-name className="min-w-0 truncate text-sm font-medium text-text-primary">
          {name}
        </span>
        {/* The role and model give way first: the name stays readable. */}
        <span className="min-w-0 truncate text-[11px] text-text-secondary [flex-shrink:999]">
          {t(KIND_KEY[a.kind])} · {t(PROVIDER_KEY[a.provider])}
          {a.model ? ` · ${a.model}` : ''}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {a.paused && <span className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0')}>{t('teams.agent.paused')}</span>}
          {a.retired && <span className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0')}>{t('teams.agent.retired')}</span>}
        </span>
      </div>
      {hint && <p className="-mt-1 text-[11px] text-text-secondary">{hint}</p>}
      <p data-agent-line className="min-w-0 truncate text-xs text-text-primary/90">
        {agentLine(a, t)}
      </p>
      <div data-agent-chips className="flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden">
        {live?.startedAt ? <ElapsedChip since={live.startedAt} tipKey="teams.agent.elapsedTip" /> : null}
        {failure && <FailureChip failure={failure} className="max-w-full" />}
        {live && <RunSilenceChip run={live} teamId={teamId} />}
        {context && <ContextChip context={context} usage={shown?.usage} />}
        <UsageChip usage={shown?.usage} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button type="button" data-agent-chat={a.id} onClick={() => openAgentDrawer(a.id)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
          <MessageSquare size={13} aria-hidden />
          {t('teams.agent.chat')}
        </button>
        {canRun && (
          <button type="button" data-run-now={a.id} onClick={() => openRunNow(a.id)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
            <Play size={13} aria-hidden />
            {t('teams.agent.runNow')}
          </button>
        )}
        {live && <StopRunButton teamId={teamId} run={live} agentName={name} />}
        <TakeoverButton teamId={teamId} agent={a} name={name} variant="card" />
        {!a.retired && (
          <button
            type="button"
            data-agent-pause={a.paused ? 'on' : 'off'}
            disabled={pausing}
            onClick={togglePause}
            className={cn(SMALL_BTN, SMALL_BTN_QUIET)}
          >
            {a.paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
            {t(a.paused ? 'teams.agent.resume' : 'teams.agent.pause')}
          </button>
        )}
      </div>
      {children}
    </article>
  )
}
