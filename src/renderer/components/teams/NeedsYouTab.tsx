import { useEffect, useMemo, useRef } from 'react'
import { Scale, ShieldAlert } from 'lucide-react'
import type { AgentView, TeamNeedsView, TeamView } from '@shared/team-protocol'
import { teamNeedsRows, type TeamNeedRow } from '@shared/teamNeeds'
import { ensureNeeds, loadNeeds, needFocused, useNeedsStore } from '@/lib/teams/needs'
import { loadRoster, useRosterStore } from '@/lib/teams/roster'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { TeamEmptyTab } from './TeamEmptyTab'
import { DispatchQueue } from './DispatchQueue'
import { NeedRow } from './NeedRow'

const NO_AGENTS: readonly AgentView[] = []
const SECTION_TITLE = 'text-[11px] font-semibold uppercase tracking-wide text-text-secondary'

/** Scrolls the nearest scrolling ancestor so `el` sits at its top; nothing else moves (no scrollIntoView). */
function revealAtTop(el: HTMLElement): void {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy !== 'auto' && oy !== 'scroll') continue
    p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - 8
    return
  }
}

function NeedGroup({ name, title, icon: Icon, rows, teamId, needs, view, agents }: {
  name: 'block' | 'decisions'; title: string; icon: typeof Scale; rows: readonly TeamNeedRow[]
  teamId: string; needs: TeamNeedsView; view: TeamView; agents: Readonly<Record<string, AgentView>>
}) {
  const titleId = `team-needs-${name}-${teamId}`
  return (
    <section data-needs-group={name} aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Icon size={13} className="shrink-0 text-text-secondary" aria-hidden />
        <h3 id={titleId} className={SECTION_TITLE}>
          {title}
        </h3>
        <span data-needs-group-count={rows.length} className="rounded-full border border-border px-1.5 text-[10px] font-medium leading-4 text-text-secondary">
          {rows.length}
        </span>
      </div>
      <ul className="flex min-w-0 flex-col gap-2">
        {rows.map((r) => (
          <NeedRow key={r.id} teamId={teamId} row={r} needs={needs} view={view} agents={agents} />
        ))}
      </ul>
    </section>
  )
}

/**
 * Te necesita of a team (app 2.7.0, E10 B4 its "Por despachar" section, B5
 * the rest): the rows are teamNeedsRows of the needs view main answers (the
 * one rule the sidebar badge and the tab pill count, each row once with
 * `data-team-need`), grouped by rank: "Frena al equipo" (the trust to review,
 * an auth or billing pause), "Decisiones" (approvals and questions, each with
 * its own buttons) and "Por despachar" (the runs waiting for the user's OK,
 * shown while autonomy is off, where it says what that means, or anything is
 * queued). No primary button in this tab (STYLEGUIDE). The new-need toast's
 * Abrir brings the keyboard to its row.
 */
export function NeedsYouTab({ teamId, view }: { teamId: string; view: TeamView }) {
  const t = useT()
  const needs = useNeedsStore((s) => s.needs[teamId])
  const failed = useNeedsStore((s) => s.failed[teamId])
  const focus = useNeedsStore((s) => (s.focusNeed?.teamId === teamId ? s.focusNeed.rowId : null))
  const roster = useRosterStore((s) => s.rosters[teamId]?.agents) ?? NO_AGENTS
  const agents = useMemo(() => Object.fromEntries(roster.map((a) => [a.id, a])) as Record<string, AgentView>, [roster])
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // The header's count may have asked a moment ago (a team opened on this tab): one pull, not two.
    ensureNeeds(teamId)
    // The rows name their agents ("Dev 2"): the roster may not be loaded when the tab opens first.
    if (!useRosterStore.getState().rosters[teamId]) void loadRoster(teamId)
  }, [teamId])

  // The toast's Abrir: its row takes the keyboard once (focus without a page scroll); a row already gone spends it too.
  useEffect(() => {
    if (!focus || !needs) return
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-team-need="${CSS.escape(focus)}"]`)
    if (el) {
      revealAtTop(el)
      el.focus({ preventScroll: true })
    }
    needFocused()
  }, [focus, needs])

  const rows = useMemo(() => (needs ? teamNeedsRows(needs) : []), [needs])

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

  const block = rows.filter((r) => r.rank === 1)
  const decisions = rows.filter((r) => r.rank === 2)
  const showQueue = !view.autoDispatch || needs.queue.length > 0
  return (
    <div ref={rootRef} data-team-needs={teamId} className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      {block.length > 0 && <NeedGroup name="block" title={t('teams.need.group.block')} icon={ShieldAlert} rows={block} teamId={teamId} needs={needs} view={view} agents={agents} />}
      {decisions.length > 0 && <NeedGroup name="decisions" title={t('teams.need.group.decisions')} icon={Scale} rows={decisions} teamId={teamId} needs={needs} view={view} agents={agents} />}
      {block.length + decisions.length === 0 && !showQueue && (
        <p data-needs-nothing className="text-sm text-text-secondary">
          {t('teams.tab.nothing')}
        </p>
      )}
      {showQueue && <DispatchQueue teamId={teamId} view={view} needs={needs} />}
    </div>
  )
}
