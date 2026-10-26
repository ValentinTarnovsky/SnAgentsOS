import { useState, type MouseEvent } from 'react'
import { Database, FolderOpen, MoreVertical, PanelTop, Pause, Play, Plus, ShieldAlert, ShieldCheck, Trash2, UserPlus, Users, Zap, ZapOff } from 'lucide-react'
import type { TeamListItem } from '@shared/team-protocol'
import { labOn } from '@shared/labs'
import { useAppStore } from '@/lib/store'
import { useAgentStore } from '@/lib/agentStore'
import { openTeams, removeTeam, useTeamsStore } from '@/lib/teamsStore'
import { openTeamSetup } from '@/lib/teams/setup'
import { openTeamTrust } from '@/lib/teams/trust'
import { setTeamPaused } from '@/lib/teams/roster'
import { toast } from '@/lib/toast'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { StatusGlyph } from '@/components/ui/StatusDot'
import { AttentionBadge, FOCUS_RING } from '@/components/sidebar/AttentionBadge'
import { revealTeamFolder } from './TeamBanner'
import { switchAutoDispatch } from './DispatchToggle'

/** The row glyph of a definition that is not trusted as it is on disk. */
const TRUST_ROW_KEY: Record<Exclude<TeamListItem['trust'], 'trusted'>, MessageKey> = {
  untrusted: 'teams.row.untrusted',
  changed: 'teams.row.changed',
  invalid: 'teams.row.invalid',
  missing: 'teams.row.missing',
}

/**
 * "Equipos" in the sidebar (app 2.7.0, E10 B1; Labs teams), between the
 * New workspace row and the workspace list: one row per team (name, a
 * working glyph while it runs, a shield while its definition is not trusted,
 * a pause glyph, the "Te necesita" count) and "Nuevo equipo". These are not
 * workspaces: nothing here enters the workspace list, the sidebar order,
 * Alt+1..9, the config or the phone snapshot. Nothing renders with the lab off.
 */
export function TeamsSection() {
  const t = useT()
  const teamsOn = useAppStore((s) => labOn(s.settings, 'teams'))
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const disabled = useTeamsStore((s) => s.disabled)
  const list = useTeamsStore((s) => s.list)
  const openTeamId = useTeamsStore((s) => s.openTeamId)
  const overlay = useAgentStore((s) => s.view === 'teams')
  const [menu, setMenu] = useState<{ x: number; y: number; teamId: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  if (!teamsOn || disabled) return null

  const openMenu = (e: MouseEvent, teamId: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, teamId })
  }
  const togglePause = (teamId: string, paused: boolean): void => {
    void setTeamPaused(teamId, !paused).then((fail) => {
      if (fail) toast.error(t(paused ? 'teams.agent.teamResumeFailed' : 'teams.agent.teamPauseFailed'))
    })
  }
  const menuItems = (teamId: string): ContextMenuItem[] => {
    const row = list.find((team) => team.id === teamId)
    const paused = !!row?.paused
    const auto = !!row?.autoDispatch
    return [
      { label: t('teams.menu.open'), icon: PanelTop, onClick: () => openTeams(teamId) },
      // B4: Despacho automático, as the header's switch (the toast says what it means now).
      { label: t(auto ? 'teams.dispatch.turnOff' : 'teams.dispatch.turnOn'), icon: auto ? ZapOff : Zap, onClick: () => void switchAutoDispatch(teamId, !auto, t) },
      // B2: Pausar / Reanudar the whole team, as the header's button.
      { label: t(paused ? 'teams.agent.teamResume' : 'teams.agent.teamPause'), icon: paused ? Play : Pause, onClick: () => togglePause(teamId, paused) },
      { label: t('teams.menu.review'), icon: ShieldCheck, onClick: () => openTeamTrust(teamId) },
      { label: t('teams.menu.revealDefinition'), icon: FolderOpen, onClick: () => revealTeamFolder(teamId, 'definition', t) },
      { label: t('teams.menu.revealData'), icon: Database, separated: true, onClick: () => revealTeamFolder(teamId, 'data', t) },
      { label: t('teams.menu.remove'), icon: Trash2, danger: true, separated: true, onClick: () => setConfirmRemove(teamId) },
    ]
  }

  const newRow = (
    <button
      type="button"
      data-team-new
      onClick={() => openTeamSetup()}
      aria-label={collapsed ? t('teams.new') : undefined}
      className={cn(
        'flex w-full items-center overflow-hidden rounded-btn py-1.5 text-xs text-text-secondary transition-colors hover:bg-card hover:text-text-primary',
        FOCUS_RING,
        collapsed ? 'justify-center px-0' : 'gap-2 px-[11px]',
      )}
    >
      <UserPlus size={13} className="shrink-0" />
      {!collapsed && <span className="truncate">{t('teams.new')}</span>}
    </button>
  )
  const removing = confirmRemove ? list.find((team) => team.id === confirmRemove) : undefined

  return (
    <section data-teams-section className="max-h-[35%] shrink-0 overflow-y-auto overflow-x-hidden border-b border-border px-2 pb-2">
      {!collapsed && (
        <div className="flex items-center justify-between pb-1 pl-[11px] pr-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary/60">{t('teams.section')}</span>
          {list.length > 0 && (
            <Tooltip label={t('teams.new')} side="right">
              <button
                type="button"
                data-team-new
                onClick={() => openTeamSetup()}
                aria-label={t('teams.new')}
                className={cn('rounded p-0.5 text-text-secondary transition-colors hover:bg-card hover:text-text-primary', FOCUS_RING)}
              >
                <Plus size={13} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
      {list.map((team) => {
        const active = overlay && team.id === openTeamId
        const trustKey = team.trust === 'trusted' ? null : TRUST_ROW_KEY[team.trust]
        return (
          <div
            key={team.id}
            data-team-row={team.id}
            onContextMenu={(e) => openMenu(e, team.id)}
            className={cn('group relative flex items-center rounded-btn', active ? 'bg-card' : 'hover:bg-card/60')}
          >
            {active && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent-violet" />}
            <Tooltip
              label={collapsed ? [team.name, team.needsCount > 0 ? t('teams.row.needs', { count: team.needsCount }) : '', trustKey ? t(trustKey) : ''].filter(Boolean).join(' · ') : ''}
              side="right"
              className="min-w-0 flex-1"
            >
              <button
                type="button"
                data-team-open={team.id}
                onClick={() => openTeams(team.id)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex min-w-0 flex-1 items-center overflow-hidden rounded-btn py-1.5 text-left text-sm',
                  FOCUS_RING,
                  collapsed ? 'justify-center px-0' : 'gap-2 px-[11px]',
                  active ? 'text-text-primary' : 'text-text-secondary',
                )}
              >
                <Users size={15} className={cn('shrink-0', active && 'text-accent-violet')} />
                {!collapsed && (
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="min-w-0 truncate">{team.name}</span>
                    {team.running > 0 && (
                      <span data-team-running={team.running} className="flex shrink-0">
                        <StatusGlyph kind="working" size={13} label={t('teams.row.running', { count: team.running })} />
                      </span>
                    )}
                    {trustKey && (
                      <span role="img" data-team-untrusted={team.trust} aria-label={t(trustKey)} title={t(trustKey)} className="flex shrink-0 text-state-action">
                        <ShieldAlert size={13} />
                      </span>
                    )}
                    {team.paused && (
                      <span role="img" data-team-paused aria-label={t('teams.row.paused')} title={t('teams.row.paused')} className="flex shrink-0 text-text-secondary">
                        <Pause size={13} />
                      </span>
                    )}
                  </span>
                )}
              </button>
            </Tooltip>
            {!collapsed && <AttentionBadge count={team.needsCount} marker="data-team-badge" className="mr-1" />}
            {collapsed && <AttentionBadge count={team.needsCount} marker="data-team-badge" className="pointer-events-none absolute right-0.5 top-0.5" />}
            {!collapsed && (
              <button
                type="button"
                onClick={(e) => openMenu(e, team.id)}
                aria-label={t('teams.menu.more')}
                data-team-menu={team.id}
                className="mr-1 shrink-0 rounded p-1 text-text-secondary opacity-0 transition-opacity hover:bg-bg-secondary hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
              >
                <MoreVertical size={15} />
              </button>
            )}
          </div>
        )
      })}
      {list.length === 0 && (collapsed ? <Tooltip label={t('teams.new')} side="right" className="w-full">{newRow}</Tooltip> : newRow)}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.teamId)} onClose={() => setMenu(null)} />}
      {confirmRemove && (
        <ConfirmDialog
          open
          title={t('teams.remove.title', { name: removing?.name ?? '' })}
          message={t('teams.remove.msg')}
          confirmLabel={t('teams.remove.yes')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => {
            const teamId = confirmRemove
            setConfirmRemove(null)
            void removeTeam(teamId).then((ok) => {
              if (!ok) toast.error(t('teams.remove.failed'))
            })
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </section>
  )
}
