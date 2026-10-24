import { useEffect } from 'react'
import { useT } from '@/i18n'
import { loadRoster, useRosterStore } from '@/lib/teams/roster'
import { Button } from '@/components/ui/Button'
import { AgentCard } from './AgentCard'
import { LeadCard } from './LeadCard'

/**
 * The Agentes tab of a team (app 2.7.0, E10 B2): the Lead on top, full
 * width, then one card per agent of the trusted definition, in main's
 * order. The roster comes from main (`roster`) when the tab shows and again
 * on every change of the team's agents or runs (lib/teams/roster.ts).
 */
export function AgentsRoster({ teamId }: { teamId: string }) {
  const t = useT()
  const roster = useRosterStore((s) => s.rosters[teamId])
  const failed = useRosterStore((s) => !!s.failed[teamId])
  useEffect(() => {
    void loadRoster(teamId)
  }, [teamId])

  if (!roster) {
    return failed ? (
      <div className="mx-auto flex w-full max-w-5xl flex-col items-start gap-3" data-agents-failed>
        <p className="text-sm text-text-secondary">{t('teams.agent.loadFailed')}</p>
        <Button variant="ghost" size="sm" data-agents-retry onClick={() => void loadRoster(teamId)}>
          {t('teams.agent.retry')}
        </Button>
      </div>
    ) : (
      <p className="mx-auto w-full max-w-5xl text-sm text-text-secondary" data-agents-loading>
        {t('teams.agent.loading')}
      </p>
    )
  }

  const lead = roster.agents.find((a) => a.kind === 'lead' && !a.retired) ?? roster.agents.find((a) => a.kind === 'lead')
  const others = roster.agents.filter((a) => a !== lead)
  return (
    <section data-agents-roster={teamId} aria-label={t('teams.agent.roster')} className="mx-auto flex w-full max-w-5xl flex-col gap-3">
      {roster.agents.length === 0 && <p className="text-sm text-text-secondary">{t('teams.agent.none')}</p>}
      {lead && <LeadCard teamId={teamId} agent={lead} />}
      {others.length > 0 && (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))]">
          {others.map((a) => (
            <AgentCard key={a.id} teamId={teamId} agent={a} />
          ))}
        </div>
      )}
    </section>
  )
}
