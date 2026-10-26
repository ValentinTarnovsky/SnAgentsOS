import { Search, X } from 'lucide-react'
import type { AgentView } from '@shared/team-protocol'
import { filterActive, type BoardFilter } from '@shared/teamBoard'
import { useT } from '@/i18n'
import { setBoardFilter } from '@/lib/teams/board'
import { agentLabel } from '@/lib/teams/roster'

const FIELD = 'h-8 rounded-btn border border-border bg-bg-secondary px-2 text-xs text-text-primary outline-none focus:border-accent-violet/60'

/** The value of the assignee select: '*' everyone, '' unassigned, else the agent id. */
function selectValue(f: BoardFilter): string {
  return f.assignee === undefined || f.assignee === null ? '*' : f.assignee
}

/**
 * The filter bar of the Tablero (app 2.7.0, E10 B3): a search over the id and
 * the title (rankList, accents and case ignored) and the assignee (everyone,
 * unassigned, or one agent). Kept per team in the board store for the
 * session, never in storage. The search box takes its own Esc (it clears the
 * query first; a second Esc closes the overlay as anywhere else).
 */
export function BoardFilters({ teamId, filter, agents }: { teamId: string; filter: BoardFilter; agents: readonly AgentView[] }) {
  const t = useT()
  const active = filterActive(filter)
  const workers = agents.filter((a) => a.kind !== 'lead')
  return (
    <div data-board-filters className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
      <label className="relative flex min-w-[10rem] max-w-xs flex-1 items-center">
        <Search size={13} className="pointer-events-none absolute left-2 text-text-secondary" aria-hidden />
        <input
          type="search"
          data-board-search
          value={filter.query ?? ''}
          aria-label={t('teams.board.search')}
          placeholder={t('teams.board.searchPlaceholder')}
          spellCheck={false}
          onChange={(e) => setBoardFilter(teamId, { query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && (filter.query ?? '') !== '') {
              e.preventDefault()
              setBoardFilter(teamId, { query: '' })
            }
          }}
          className={`${FIELD} w-full pl-7`}
        />
      </label>
      <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-secondary">
        <span className="shrink-0">{t('teams.board.assignee')}</span>
        <select
          data-board-assignee
          value={selectValue(filter)}
          onChange={(e) => setBoardFilter(teamId, { assignee: e.target.value === '*' ? null : e.target.value })}
          className={`${FIELD} min-w-0 max-w-[12rem] truncate`}
        >
          <option value="*">{t('teams.board.assigneeAll')}</option>
          <option value="">{t('teams.board.assigneeNone')}</option>
          {workers.map((a) => (
            <option key={a.id} value={a.id}>
              {agentLabel(a)}
            </option>
          ))}
        </select>
      </label>
      {active && (
        <button
          type="button"
          data-board-clear
          onClick={() => setBoardFilter(teamId, { query: '', assignee: null })}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-btn px-2 text-xs text-text-secondary transition-colors hover:bg-card hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60"
        >
          <X size={13} aria-hidden />
          {t('teams.board.clear')}
        </button>
      )}
    </div>
  )
}
