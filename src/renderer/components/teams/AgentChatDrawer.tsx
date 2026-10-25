import { useEffect, useMemo, useState } from 'react'
import { Bot } from 'lucide-react'
import type { RunView, TeamView } from '@shared/team-protocol'
import { useLang, useT } from '@/i18n'
import { closeTeamDrawer, openAgentDrawer, type TeamDrawer } from '@/lib/teamsStore'
import { MODE_KEY, agentLabel, loadRoster, useRosterStore } from '@/lib/teams/roster'
import { loadRuns, runsKey, useRunChatStore } from '@/lib/teams/runChat'
import { clockTime } from '@/lib/statusSignals'
import { RightDrawer } from '@/components/ui/RightDrawer'
import { Button } from '@/components/ui/Button'
import { RUN_STATE_KEY, RunHeader } from './RunHeader'
import { RunChatView } from './RunChatView'
import { RunNowComposer } from './RunNowComposer'
import { LeadThreadView } from './LeadThreadView'
import { segBtn } from './TaskFields'

type AgentDrawer = Extract<NonNullable<TeamDrawer>, { kind: 'agent' }>

/** Every run the drawer knows of this agent, newest first, without repeats. */
function runsOf(list: readonly RunView[] | undefined, live: RunView | undefined, last: RunView | undefined): RunView[] {
  const byId = new Map<string, RunView>()
  for (const r of [live, last, ...(list ?? [])]) if (r && !byId.has(r.id)) byId.set(r.id, r)
  return [...byId.values()].sort((a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : -1))
}

function RunPicker({ runs, value, onPick }: { runs: RunView[]; value: string; onPick: (runId: string) => void }) {
  const t = useT()
  const lang = useLang()
  const now = Date.now()
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <label htmlFor="team-run-picker" className="shrink-0 text-[11px] font-medium text-text-secondary">
        {t('teams.run.picker')}
      </label>
      <select
        id="team-run-picker"
        data-run-picker
        value={value}
        onChange={(e) => onPick(e.target.value)}
        className="h-7 min-w-0 flex-1 truncate rounded-btn border border-border bg-bg-secondary px-2 text-xs text-text-primary outline-none focus:border-accent-violet"
      >
        {runs.map((r) => (
          <option key={r.id} value={r.id} data-run-option={r.id}>
            {t('teams.run.pickerItem', { time: clockTime(r.startedAt ?? r.queuedAt, lang, now), mode: t(MODE_KEY[r.mode]), state: t(RUN_STATE_KEY[r.state]) })}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The Lead's drawer: Conversación (the thread, B3) or Corrida (its runs, B2), a segmented control. */
function LeadViewSwitch({ value, onPick }: { value: 'thread' | 'run'; onPick: (v: 'thread' | 'run') => void }) {
  const t = useT()
  return (
    <div className="flex shrink-0 items-center border-b border-border px-3 py-1.5">
      <div role="radiogroup" aria-label={t('teams.lead.view')} data-lead-view={value} className="flex w-fit gap-1 rounded-btn border border-border bg-bg-primary p-1">
        {(['thread', 'run'] as const).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} data-lead-tab={v} onClick={() => v !== value && onPick(v)} className={segBtn(value === v)}>
            {t(v === 'thread' ? 'teams.lead.thread' : 'teams.lead.run')}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The drawer of one agent (app 2.7.0, E10 B2), over the team body: a run
 * picker of its runs, the chosen run's header and chat, and the "Ejecutar
 * ahora" composer. With no run picked it follows the agent: its live run,
 * else its last one. Mounted with `key={agentId}`. The Lead's drawer (B3)
 * opens on the conversation (LeadThreadView) and switches to its runs.
 */
export function AgentChatDrawer({ teamId, view, drawer }: { teamId: string; view: TeamView; drawer: AgentDrawer }) {
  const t = useT()
  const agentId = drawer.agentId
  const roster = useRosterStore((s) => s.rosters[teamId])
  const rosterFailed = useRosterStore((s) => !!s.failed[teamId])
  const agent = roster?.agents.find((a) => a.id === agentId)
  const listed = useRunChatStore((s) => s.runs[runsKey(teamId, agentId)])
  const [maximized, setMaximized] = useState(false)

  // Every open reads the roster again: the drawer also opens from places that never loaded it (the task drawer's
  // activity, the board's empty state), and the agent's live run picks the run shown.
  useEffect(() => {
    void loadRoster(teamId)
  }, [teamId])
  // A new live run (this composer's, the dispatcher's) joins the picker.
  const liveId = agent?.run?.id
  useEffect(() => {
    void loadRuns(teamId, agentId)
  }, [teamId, agentId, liveId])

  const runs = useMemo(() => runsOf(listed, agent?.run, agent?.lastRun), [listed, agent?.run, agent?.lastRun])
  const runId = drawer.runId ?? agent?.run?.id ?? agent?.lastRun?.id ?? runs[0]?.id ?? null
  const chatRun = useRunChatStore((s) => (runId ? s.chats[runId]?.run : undefined))
  const run = runId ? (chatRun ?? runs.find((r) => r.id === runId)) : undefined
  const name = agent ? agentLabel(agent) : agentId
  const pickable = runId && !runs.some((r) => r.id === runId) && run ? [run, ...runs] : runs
  // B3: the Lead's drawer opens on the conversation unless a run was asked for.
  const isLead = agent?.kind === 'lead'
  const leadView = isLead ? (drawer.view ?? (drawer.runId ? 'run' : 'thread')) : 'run'

  return (
    <RightDrawer
      id="team-agent"
      pinScope={teamId}
      title={name}
      icon={<Bot size={15} className="shrink-0 text-text-secondary" />}
      defaultWidth="clamp(420px, 46%, 860px)"
      maximized={maximized}
      onMaximize={setMaximized}
      onClose={() => closeTeamDrawer()}
    >
      <div data-agent-drawer={agentId} className="flex min-w-0 flex-1 flex-col">
        {/* Only the roster says whether this is the Lead (thread first) or not: nothing of the run view shows before it. */}
        {!roster ? (
          rosterFailed ? (
            <div className="flex flex-col items-start gap-3 p-4" data-agent-load-failed>
              <p className="text-sm text-text-secondary">{t('teams.agent.loadFailed')}</p>
              <Button variant="ghost" size="sm" data-agent-retry onClick={() => void loadRoster(teamId)}>
                {t('teams.agent.retry')}
              </Button>
            </div>
          ) : (
            <p data-agent-loading className="p-4 text-sm text-text-secondary">
              {t('teams.agent.loading')}
            </p>
          )
        ) : !agent ? (
          <p data-agent-gone className="p-4 text-sm text-text-secondary">
            {t('teams.agent.gone')}
          </p>
        ) : isLead && leadView === 'thread' ? (
          <>
            <LeadViewSwitch value="thread" onPick={(v) => openAgentDrawer(agentId, drawer.runId, v)} />
            <LeadThreadView teamId={teamId} lead={agent} />
          </>
        ) : (
          <>
            {isLead && <LeadViewSwitch value="run" onPick={(v) => openAgentDrawer(agentId, drawer.runId, v)} />}
            {runId && pickable.length > 0 && <RunPicker runs={pickable} value={runId} onPick={(id) => openAgentDrawer(agentId, id, drawer.view)} />}
            {runId ? (
              <>
                {run && <RunHeader teamId={teamId} run={run} agentName={name} />}
                <RunChatView key={runId} teamId={teamId} runId={runId} run={run} agentName={name} />
              </>
            ) : (
              <p data-run-empty className="min-h-0 flex-1 p-4 text-sm text-text-secondary">
                {t('teams.run.none')}
              </p>
            )}
            <RunNowComposer teamId={teamId} agent={agent} trusted={view.trust === 'trusted'} />
          </>
        )}
      </div>
    </RightDrawer>
  )
}
