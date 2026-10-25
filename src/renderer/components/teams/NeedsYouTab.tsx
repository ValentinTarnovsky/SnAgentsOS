import { useEffect } from 'react'
import type { TeamView } from '@shared/team-protocol'
import { teamNeedsRows } from '@shared/teamNeeds'
import { ensureNeeds, loadNeeds, useNeedsStore } from '@/lib/teams/needs'
import { loadRoster, useRosterStore } from '@/lib/teams/roster'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { TeamEmptyTab } from './TeamEmptyTab'
import { DispatchQueue } from './DispatchQueue'

/**
 * Te necesita of a team (app 2.7.0, E10 B4 its "Por despachar" section, B5
 * the rest): the rows are teamNeedsRows of the needs view main answers (the
 * one rule the sidebar badge and the tab pill count), grouped by rank: what
 * stops the team (trust, an auth or billing pause), the decisions (approvals,
 * questions) and the runs waiting for the user's OK. B4 renders the last
 * group; until B5 the first two say in one line that something waits. No
 * primary button in this tab (STYLEGUIDE). "Por despachar" shows while
 * autonomy is off (it says what that means) or anything is queued.
 */
export function NeedsYouTab({ teamId, view }: { teamId: string; view: TeamView }) {
  const t = useT()
  const needs = useNeedsStore((s) => s.needs[teamId])
  const failed = useNeedsStore((s) => s.failed[teamId])

  useEffect(() => {
    // The header's count may have asked a moment ago (a team opened on this tab): one pull, not two.
    ensureNeeds(teamId)
    // The rows name their agents ("Dev 2"): the roster may not be loaded when the tab opens first.
    if (!useRosterStore.getState().rosters[teamId]) void loadRoster(teamId)
  }, [teamId])

  if (!needs) {
    // A main without Te necesita yet: the tab's plain line, never a load error.
    if (failed === 'unsupported') return <TeamEmptyTab tab="needs" view={view} />
    return failed ? (
      <div className="flex flex-col items-start gap-3" data-needs-failed>
        <p className="text-sm text-text-secondary">{t('teams.dispatch.loadFailed')}</p>
        <Button variant="ghost" size="sm" data-needs-retry onClick={() => void loadNeeds(teamId)}>
          {t('teams.dispatch.retry')}
        </Button>
      </div>
    ) : (
      <p className="text-sm text-text-secondary" data-needs-loading>
        {t('teams.dispatch.loading')}
      </p>
    )
  }

  const rows = teamNeedsRows(needs)
  const others = rows.filter((r) => r.kind !== 'dispatch').length
  const showQueue = !view.autoDispatch || needs.queue.length > 0
  return (
    <div data-team-needs={teamId} className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      {/* B5: the "Frena al equipo" and "Decisiones" groups (trust, pause, approvals, questions) take this line's place. */}
      {others > 0 && (
        <p data-needs-others={others} className="text-sm text-text-secondary">
          {t(needs.trust !== 'trusted' ? 'teams.tab.needsTrust' : 'teams.tab.soonNeeds')}
        </p>
      )}
      {others === 0 && !showQueue && (
        <p data-needs-nothing className="text-sm text-text-secondary">
          {t('teams.tab.nothing')}
        </p>
      )}
      {showQueue && <DispatchQueue teamId={teamId} view={view} needs={needs} />}
    </div>
  )
}
