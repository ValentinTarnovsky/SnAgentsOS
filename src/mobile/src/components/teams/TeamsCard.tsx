/**
 * The Teams card on Home (app 2.7.0, E10 B8, plan 3.1 "una tarjeta en Home
 * que muestra el conteo"): up to three teams (those that need the user
 * first) with what each is doing and the red count of what needs the user,
 * which is the PC's teamNeedsCount, the number its sidebar badge shows.
 * "Ver todos" opens every team. Only a desktop >= 2.7.0 with Teams on and at
 * least one team shows it; an older desktop is never asked (teamsSupported).
 */
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { SECTION_TITLE } from './TeamBits'
import { orderTeams, TeamRow } from './TeamsScreen'
import { openTeamsList, teamsSupported, useTeamsUi } from '../../lib/teamsStore'
import { useRemoteStore } from '../../lib/store'
import { t } from '../../lib/i18n'

/** Teams the card lists before "Ver todos". */
export const HOME_TEAMS_MAX = 3

export function TeamsCard(): ReactNode {
  const supported = useRemoteStore((s) => teamsSupported(s.appVersion))
  const list = useTeamsUi((s) => s.list)
  const listState = useTeamsUi((s) => s.listState)
  if (!supported || listState === 'disabled' || !list || list.length === 0) return null
  const rows = orderTeams(list).slice(0, HOME_TEAMS_MAX)
  return (
    <section data-home-teams className="mb-4">
      <h2 className={SECTION_TITLE}>{t('teams.home.title')}</h2>
      <div className="flex flex-col gap-2">
        {rows.map((item) => (
          <TeamRow key={item.id} item={item} home />
        ))}
      </div>
      {list.length > HOME_TEAMS_MAX && (
        <button
          type="button"
          data-home-teams-all
          onClick={openTeamsList}
          className="mt-1 flex min-h-11 w-full items-center justify-end gap-1 rounded-btn px-2 text-xs font-medium text-accent-violet active:bg-card"
        >
          {t('teams.home.all', { count: list.length })}
          <ChevronRight size={14} aria-hidden />
        </button>
      )}
    </section>
  )
}
