import { Pause, ShieldAlert, Users } from 'lucide-react'
import { openTeams, useTeamsStore } from '@/lib/teamsStore'
import { openTeamSetup } from '@/lib/teams/setup'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { StatusGlyph } from '@/components/ui/StatusDot'
import { AttentionBadge } from '@/components/sidebar/AttentionBadge'
import { TeamPlainHeader } from './TeamHeader'

/**
 * The Teams overlay with no team chosen (app 2.7.0, E10 B1): a card per team
 * (name, repo, running, the "Te necesita" count) and "Nuevo equipo"; with no
 * team at all, what a team is and "Crear equipo".
 */
export function TeamPicker() {
  const t = useT()
  const ready = useTeamsStore((s) => s.ready)
  const list = useTeamsStore((s) => s.list)
  return (
    <div data-team-picker className="flex min-h-0 flex-1 flex-col">
      <TeamPlainHeader title={t('teams.host.pickTitle')} />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {!ready ? (
          <p className="text-sm text-text-secondary">{t('teams.host.loading')}</p>
        ) : list.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-4 pt-[8vh] text-center" data-team-picker-empty>
            <Users size={18} className="text-accent-violet" />
            <h3 className="text-base font-semibold text-text-primary">{t('teams.host.none')}</h3>
            <p className="text-sm leading-6 text-text-secondary">{t('teams.host.empty')}</p>
            <Button onClick={() => openTeamSetup()} data-team-create>
              {t('teams.host.create')}
            </Button>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <p className="text-sm text-text-secondary">{t('teams.host.pickHint')}</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {list.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  data-team-pick={team.id}
                  onClick={() => openTeams(team.id)}
                  className={cn(
                    'flex min-w-0 flex-col gap-1 rounded-card border border-border bg-card/70 px-3 py-2.5 text-left transition-colors hover:border-accent-violet/50',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Users size={15} className="shrink-0 text-accent-violet" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{team.name}</span>
                    {team.trust !== 'trusted' && <ShieldAlert size={13} className="shrink-0 text-state-action" aria-label={t('teams.host.untrusted')} />}
                    {team.paused && <Pause size={13} className="shrink-0 text-text-secondary" aria-label={t('teams.row.paused')} />}
                    <AttentionBadge count={team.needsCount} marker="data-team-badge" />
                  </span>
                  <span className="truncate text-[11px] text-text-secondary">{team.repoName}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                    {team.running > 0 && <StatusGlyph kind="working" size={12} noTooltip />}
                    {team.running > 0 ? t('teams.host.cardRunning', { count: team.running }) : t('teams.host.cardIdle')}
                  </span>
                </button>
              ))}
            </div>
            <div>
              <Button onClick={() => openTeamSetup()} data-team-create>
                {t('teams.new')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
