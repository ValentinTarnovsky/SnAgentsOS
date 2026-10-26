/**
 * The teams of the PC on the phone (app 2.7.0, E10 B8): every team as a row
 * (its name, its repo, what it is doing or why it waits, and the count of
 * what needs the user, the same teamNeedsCount the desktop's badge shows). A
 * tap opens its board. The Home card shows the first three with these rows;
 * "Ver todos" opens this screen. Nothing here changes a team.
 */
import type { ReactNode } from 'react'
import { ChevronRight, Users } from 'lucide-react'
import type { PhoneTeamListItem } from '@shared/team-protocol'
import { PushScreen } from '../PushScreen'
import { NoReply } from '../NoReply'
import { Spinner } from './TeamBits'
import { teamLine, visibleName } from './teamText'
import { closeTeamsList, loadTeamList, openTeamBoard, useTeamsUi } from '../../lib/teamsStore'
import { t } from '../../lib/i18n'

/** Teams that need the user first, then the ones working, else the PC's order. */
export function orderTeams(list: readonly PhoneTeamListItem[]): PhoneTeamListItem[] {
  const rank = (x: PhoneTeamListItem): number => (x.needsCount > 0 ? 0 : x.running > 0 ? 1 : 2)
  return list.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((e) => e.x)
}

/** One team: a tap opens its board. `home` marks it as a Home card row (data-team-card), else a list row. */
export function TeamRow({ item, home }: { item: PhoneTeamListItem; home?: boolean }): ReactNode {
  const attr = home ? { 'data-team-card': item.id } : { 'data-team-row': item.id }
  const needs = item.needsCount
  return (
    <button
      type="button"
      {...attr}
      onClick={() => openTeamBoard(item.id)}
      className="flex min-h-[56px] w-full items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2 text-left active:bg-card"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-bg-primary text-text-secondary">
        <Users size={18} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold text-text-primary">{visibleName(item.name)}</span>
          <span className="shrink truncate text-[11px] text-text-secondary">{visibleName(item.repoName)}</span>
        </span>
        <span data-team-line className="truncate text-xs text-text-secondary">
          {teamLine(item)}
        </span>
      </span>
      {needs > 0 && (
        <span
          {...(home ? { 'data-team-card-needs': needs } : { 'data-team-row-needs': needs })}
          aria-label={t('teams.row.needs', { count: needs })}
          className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-state-error px-1.5 text-xs font-semibold text-white"
        >
          {needs}
        </span>
      )}
      <ChevronRight size={16} className="shrink-0 text-text-secondary" aria-hidden />
    </button>
  )
}

export function TeamsBody(): ReactNode {
  const list = useTeamsUi((s) => s.list)
  const listState = useTeamsUi((s) => s.listState)
  if (listState === 'disabled') return <p className="py-8 text-center text-sm text-text-secondary">{t('teams.list.disabled')}</p>
  if (!list) return listState === 'noReply' ? <NoReply onRetry={() => void loadTeamList()} /> : <Spinner />
  return (
    <div data-teams-list className="flex flex-col gap-2 pb-6">
      {listState === 'noReply' && <NoReply onRetry={() => void loadTeamList()} />}
      {list.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <Users size={26} className="text-text-secondary/60" aria-hidden />
          <p className="text-sm text-text-secondary">{t('teams.list.empty')}</p>
        </div>
      )}
      {orderTeams(list).map((item) => (
        <TeamRow key={item.id} item={item} />
      ))}
    </div>
  )
}

export function TeamsScreen(): ReactNode {
  const open = useTeamsUi((s) => s.listOpen)
  return (
    <PushScreen id="teams" open={open} onClose={closeTeamsList} title={t('teams.home.title')}>
      <TeamsBody />
    </PushScreen>
  )
}
