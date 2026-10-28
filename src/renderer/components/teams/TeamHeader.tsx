import { useState } from 'react'
import { ChevronsUpDown, FolderGit2, GitBranch, Pause, Play, Plus, Users, X } from 'lucide-react'
import type { AgentProvider, PaneUsage } from '@shared/types'
import type { TeamListItem, TeamView } from '@shared/team-protocol'
import { closeTeams, openTeams, useTeamsStore } from '@/lib/teamsStore'
import { setTeamPaused } from '@/lib/teams/roster'
import { openNewTask } from '@/lib/teams/board'
import { formatCost, formatTokens, sumUsage, usageLines } from '@/lib/statusSignals'
import { toast } from '@/lib/toast'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { useNow } from '@/components/sidebar/AgentRows'
import { DispatchToggle } from './DispatchToggle'
import { AutopilotToggle } from './AutopilotToggle'

const CHIP = 'inline-flex max-w-[16rem] shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] leading-5'
// The chips that give way first when the header is tight (zoom, the B4 switch and count on the right): repo, base,
// usage. Without shrink-0, which wins over `shrink` in the CSS: else the chip keeps its width while its tooltip
// wrapper shrinks, and it draws over the next chip.
const CHIP_FLEX = 'inline-flex min-w-0 max-w-[16rem] shrink items-center gap-1 overflow-hidden rounded border px-1.5 text-[11px] leading-5'
const NEUTRAL = 'border-border text-text-secondary'
const AMBER = 'border-state-action/60 bg-state-action/15 text-state-action'
const RED = 'border-state-error/60 bg-state-error/15 text-state-error'
const HEADER_BTN = 'rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60'

const TRUST_CHIP: Record<Exclude<TeamListItem['trust'], 'trusted'>, { key: MessageKey; tone: string }> = {
  untrusted: { key: 'teams.host.untrusted', tone: AMBER },
  changed: { key: 'teams.host.changed', tone: AMBER },
  invalid: { key: 'teams.host.invalid', tone: RED },
  missing: { key: 'teams.host.missing', tone: RED },
}

const PAUSE_KEY: Record<NonNullable<TeamListItem['paused']>['reason'], MessageKey> = {
  user: 'teams.host.paused',
  auth: 'teams.host.pausedAuth',
  billing: 'teams.host.pausedBilling',
}

const PROVIDER_KEY: Record<AgentProvider, MessageKey> = {
  claude: 'pane.runningAgent.claude',
  codex: 'pane.runningAgent.codex',
}

/** "15:30", or "25 oct 15:30" when the limit ends another day. */
function untilText(at: number, now: number, lang: string): string {
  const d = new Date(at)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const opts: Intl.DateTimeFormatOptions = sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
  return d.toLocaleString(lang === 'es' ? 'es' : 'en', opts)
}

/** "Límite de Claude hasta 15:30" per provider a limit holds; gone once it passes. */
function LimitChips({ blocked }: { blocked: TeamView['providerBlockedUntil'] }) {
  const t = useT()
  const lang = useLang()
  const now = useNow(30_000)
  const live = (Object.entries(blocked) as Array<[AgentProvider, number | undefined]>).filter((e): e is [AgentProvider, number] => typeof e[1] === 'number' && e[1] > now)
  return (
    <>
      {live.map(([provider, until]) => (
        <span key={provider} data-team-limit={provider} className={cn(CHIP, AMBER)}>
          <span className="truncate">{t('teams.host.limit', { provider: t(PROVIDER_KEY[provider]), time: untilText(until, now, lang) })}</span>
        </span>
      ))}
    </>
  )
}

/** "Hoy: 1,2 M tokens · 0,40 US$ (estimado)": what the team's runs spent today (B2); nothing until one reports usage. */
function UsageToday({ usage }: { usage?: PaneUsage }) {
  const t = useT()
  const lang = useLang()
  const total = sumUsage([usage])
  if (!total || (total.tokens === 0 && !total.costUSD)) return null
  const tokens = formatTokens(total.tokens, lang)
  const text =
    total.costUSD === undefined
      ? t('teams.agent.usageTodayNoCost', { tokens })
      : t(total.unknownCost ? 'teams.agent.usageTodayAtLeast' : 'teams.agent.usageToday', { tokens, cost: formatCost(total.costUSD, lang) })
  return (
    <Tooltip
      side="bottom"
      className="min-w-0 shrink"
      label={
        <span className="flex flex-col" data-team-usage-tip>
          <span>{t('teams.agent.usageTodayTip')}</span>
          {usageLines(total, t, lang).map((line, i) => (
            <span key={i} className="font-normal text-text-secondary">
              {line}
            </span>
          ))}
        </span>
      }
    >
      <span data-team-usage className={cn(CHIP_FLEX, NEUTRAL, 'tabular-nums')}>
        <span className="truncate">{text}</span>
      </span>
    </Tooltip>
  )
}

/** Pausar / Reanudar of the whole team (B2): a paused team starts no new run; resuming lifts any pause. */
function PauseButton({ teamId, paused }: { teamId: string; paused: boolean }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const label = t(paused ? 'teams.agent.teamResume' : 'teams.agent.teamPause')
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        data-team-pause={paused ? 'on' : 'off'}
        aria-label={label}
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void setTeamPaused(teamId, !paused).then((fail) => {
            setBusy(false)
            if (fail) toast.error(t(paused ? 'teams.agent.teamResumeFailed' : 'teams.agent.teamPauseFailed'))
          })
        }}
        className={cn(HEADER_BTN, 'disabled:opacity-50')}
      >
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </button>
    </Tooltip>
  )
}

/**
 * Header of the Teams overlay (app 2.7.0, E10 B1): the team name, its repo and
 * base branch, the state chips (trust, pause, provider limits), what the runs
 * spent today and the close button. The list item is enough to draw it; the
 * view adds the base branch, the limits and the usage once it arrives. Later
 * milestones add their buttons in the right group (B2 pause, B3 new task, B4
 * autonomy).
 */
export function TeamHeader({ team, view }: { team: TeamListItem; view?: TeamView }) {
  const t = useT()
  const many = useTeamsStore((s) => s.list.length > 1)
  const trust = view?.trust ?? team.trust
  const paused = view ? view.paused : team.paused
  const trustChip = trust === 'trusted' ? null : TRUST_CHIP[trust]
  const blocked = view?.providerBlockedUntil ?? {}
  // The chips' clock runs only while a limit is held.
  const limited = Object.values(blocked).some((until) => typeof until === 'number' && until > Date.now())
  return (
    <header data-team-header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
      <Users size={18} className="shrink-0 text-accent-violet" />
      <h2 className="min-w-0 max-w-[40%] shrink truncate text-sm font-semibold text-text-primary" data-team-name>
        {view?.name ?? team.name}
      </h2>
      {many && (
        <Tooltip label={t('teams.host.pick')} side="bottom" className="shrink-0">
          <button type="button" data-team-picker-open aria-label={t('teams.host.pick')} onClick={() => openTeams(null)} className={HEADER_BTN}>
            <ChevronsUpDown size={15} />
          </button>
        </Tooltip>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <Tooltip label={t('teams.host.repoTip', { path: view?.repoRoot ?? team.repoRoot })} side="bottom" className="min-w-0 shrink">
          <span data-team-repo className={cn(CHIP_FLEX, NEUTRAL)}>
            <FolderGit2 size={13} className="shrink-0" />
            <span className="truncate">{view?.repoName ?? team.repoName}</span>
          </span>
        </Tooltip>
        {view?.baseBranch && (
          <Tooltip label={t('teams.host.baseTip')} side="bottom" className="min-w-0 shrink">
            <span data-team-base className={cn(CHIP_FLEX, NEUTRAL)}>
              <GitBranch size={13} className="shrink-0" />
              <span className="truncate">{view.baseBranch}</span>
            </span>
          </Tooltip>
        )}
        {trustChip && (
          <span data-team-trust-chip={trust} className={cn(CHIP, trustChip.tone)}>
            <span className="truncate">{t(trustChip.key)}</span>
          </span>
        )}
        {paused && (
          <span data-team-paused-chip={paused.reason} className={cn(CHIP, paused.reason === 'user' ? NEUTRAL : AMBER)}>
            <span className="truncate">{t(PAUSE_KEY[paused.reason])}</span>
          </span>
        )}
        {limited && <LimitChips blocked={blocked} />}
        <UsageToday usage={view?.usageToday} />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* B4: the autonomy switch and, while it is off, how many runs wait in "Por despachar". */}
        <DispatchToggle teamId={team.id} on={view ? view.autoDispatch : team.autoDispatch} />
        {/* 2.9.0: Piloto automatico, what Te necesita would ask the user, decided for them. */}
        <AutopilotToggle teamId={team.id} on={!!view?.autopilot} />
        {/* B3: a task for the board, from any tab (the dialog opens over the team). */}
        <button
          type="button"
          data-team-new-task
          onClick={() => openNewTask(team.id)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-btn border border-border px-2.5 text-xs font-medium text-text-primary transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60"
        >
          <Plus size={13} aria-hidden />
          {t('teams.task.new')}
        </button>
        <PauseButton teamId={team.id} paused={!!paused} />
        <Tooltip label={t('teams.host.close')} side="bottom">
          <button type="button" data-team-close aria-label={t('teams.host.close')} onClick={() => closeTeams()} className={HEADER_BTN}>
            <X size={15} />
          </button>
        </Tooltip>
      </div>
    </header>
  )
}

/** Header of the picker and of the loading state: a title and the close button. */
export function TeamPlainHeader({ title }: { title: string }) {
  const t = useT()
  return (
    <header data-team-header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
      <Users size={18} className="shrink-0 text-accent-violet" />
      <h2 className="min-w-0 truncate text-sm font-semibold text-text-primary">{title}</h2>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip label={t('teams.host.close')} side="bottom">
          <button type="button" data-team-close aria-label={t('teams.host.close')} onClick={() => closeTeams()} className={HEADER_BTN}>
            <X size={15} />
          </button>
        </Tooltip>
      </div>
    </header>
  )
}
