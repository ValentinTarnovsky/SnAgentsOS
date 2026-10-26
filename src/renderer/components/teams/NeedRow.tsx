import { useState } from 'react'
import { CircleHelp, ClipboardCheck, KeyRound, PauseCircle, Play, ShieldAlert, UserPlus, GitMerge, FileCheck2, CircleAlert } from 'lucide-react'
import type { AgentView, TeamNeedsView, TeamView } from '@shared/team-protocol'
import { teamNeedKey, type TeamNeedRow } from '@shared/teamNeeds'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { openTaskDrawer } from '@/lib/teamsStore'
import { openTeamTrust } from '@/lib/teams/trust'
import { agentLabel, setTeamPaused } from '@/lib/teams/roster'
import { answerCard } from '@/lib/teams/needs'
import { defErrorsOf } from '@/lib/teams/issues'
import { clockTime } from '@/lib/statusSignals'
import { SMALL_BTN, SMALL_BTN_QUIET, SMALL_BTN_TEXT } from './RunHeader'
import { revealTeamFolder } from './TeamBanner'
import { ApprovalBody } from './ApprovalBody'
import { IntegrateNeedBody } from './IntegrateDialog'
import { QuestionCard } from './QuestionCard'

const ICON = {
  trust: ShieldAlert,
  paused: PauseCircle,
  plan: ClipboardCheck,
  final: FileCheck2,
  hire: UserPlus,
  permission: KeyRound,
  integrate: GitMerge,
  card: CircleHelp,
  system: CircleAlert,
} as const

/** The trust row: why nothing runs, worded like the trust strip, and the same ways out (the trust dialog, the folder). */
function TrustBody({ teamId, view, needs }: { teamId: string; view: TeamView; needs: TeamNeedsView }) {
  const t = useT()
  const trust = needs.trust
  const errors = defErrorsOf(view.defIssues)
  const text =
    trust === 'untrusted' ? t('teams.banner.untrusted')
    : trust === 'changed' ? t('teams.banner.changed')
    : trust === 'invalid' ? t('teams.banner.invalid', { count: errors.length })
    : t('teams.banner.missing')
  // A link or an unreadable folder: main would not open it (the strip's rule).
  const canOpen = trust === 'invalid' && errors.length > 0 && !errors.some((e) => e.code === 'link' || e.code === 'io')
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="break-words text-xs text-text-primary">{text}</p>
      {/* A folder that is gone has nothing to review nor to open. */}
      {trust !== 'missing' && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <button type="button" data-need-trust-review onClick={() => openTeamTrust(teamId)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
            <ShieldAlert size={13} aria-hidden />
            {t(trust === 'changed' ? 'teams.banner.review' : 'teams.banner.reviewFirst')}
          </button>
          {canOpen && (
            <button type="button" data-need-open-folder onClick={() => revealTeamFolder(teamId, 'definition', t)} className={cn(SMALL_BTN, SMALL_BTN_QUIET)}>
              {t('teams.banner.openFolder')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The open system card that offers to lift this pause: the one the pause names, else any auth or billing card with
 * Reanudar el equipo. Its `resumeTeam` lifts the pause and closes every auth and billing card in one commit; the
 * `settings` op lifts the pause alone and would leave that card up, saying the team is paused.
 */
function pauseCardOf(needs: TeamNeedsView): string | undefined {
  const offers = (c: TeamNeedsView['cards'][number]): boolean => !!c.system?.actions.includes('resumeTeam')
  const named = needs.paused?.cardId ? needs.cards.find((c) => c.id === needs.paused?.cardId && offers(c)) : undefined
  return (named ?? needs.cards.find((c) => offers(c) && (c.system?.why === 'auth' || c.system?.why === 'billing')))?.id
}

/** An auth or billing pause (a user pause never shows here): what to fix, then Reanudar, which lifts it. */
function PausedBody({ teamId, needs }: { teamId: string; needs: TeamNeedsView }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const reason = needs.paused?.reason
  const resume = async (): Promise<void> => {
    setBusy(true)
    const cardId = pauseCardOf(needs)
    const viaCard = cardId ? await answerCard(teamId, cardId, { action: 'resumeTeam' }) : undefined
    // No card offers it, or main refused it (gone, an untrusted definition): the pause alone, the user always wins.
    if (viaCard !== null && (await setTeamPaused(teamId, false))) toast.error(t('teams.agent.teamResumeFailed'))
    setBusy(false)
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="break-words text-xs text-text-primary">{t(reason === 'billing' ? 'teams.need.pausedBilling' : 'teams.need.pausedAuth')}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-need-resume
          disabled={busy}
          onClick={() => void resume()}
          className={cn(SMALL_BTN, SMALL_BTN_TEXT)}
        >
          <Play size={13} aria-hidden />
          {t('teams.need.resume')}
        </button>
      </div>
    </div>
  )
}

/**
 * One row of Te necesita (app 2.7.0, E10 B5): a teamNeedsRows row, so the tab
 * shows exactly what the sidebar badge and the tab pill count
 * (`data-team-need` once per row). The head says what it is, for which task
 * (a click opens its drawer), who asked and since when; the body is the trust
 * state, the pause, the approval (ApprovalBody; B6: a branch to integrate has
 * Integrar..., IntegrateNeedBody) or the card (QuestionCard).
 */
export function NeedRow({ teamId, row, needs, view, agents }: { teamId: string; row: TeamNeedRow; needs: TeamNeedsView; view: TeamView; agents: Readonly<Record<string, AgentView>> }) {
  const t = useT()
  const lang = useLang()
  const approval = row.kind === 'approval' ? needs.approvals.find((a) => a.id === row.id) : undefined
  const card = row.kind === 'card' ? needs.cards.find((c) => c.id === row.id) : undefined
  const fromId = approval ? approval.requestedBy : card?.agentId
  const from = fromId && fromId !== 'user' && fromId !== 'system' ? agents[fromId] : undefined
  const fromName = from ? agentLabel(from) : fromId && fromId !== 'user' && fromId !== 'system' ? fromId : null
  const task = row.taskId ? needs.tasks[row.taskId] : undefined
  const Icon = approval ? ICON[approval.payload.kind] : card ? (card.system ? ICON.system : ICON.card) : row.kind === 'trust' ? ICON.trust : ICON.paused
  const titleKey: MessageKey = card?.system ? 'teams.need.cardSystem' : card ? 'teams.need.card' : (teamNeedKey(row) as MessageKey)
  const titleId = `team-need-${row.id}`

  return (
    <li
      data-team-need={row.id}
      data-need-kind={row.kind}
      {...(row.approvalKind ? { 'data-need-approval': row.approvalKind } : {})}
      {...(card?.system ? { 'data-need-card': card.system.why } : card ? { 'data-need-card': card.kind } : {})}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={cn(
        'flex min-w-0 flex-col gap-2.5 rounded-card border bg-card/40 px-3 py-2.5 outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60',
        row.rank === 1 ? 'border-state-action/50' : 'border-border',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon size={14} aria-hidden className={cn('shrink-0', row.rank === 1 ? 'text-state-action' : 'text-text-secondary')} />
        <h4 id={titleId} className="min-w-0 text-sm font-medium text-text-primary">
          {t(titleKey)}
        </h4>
        {row.taskId && (
          <button
            type="button"
            data-need-task={row.taskId}
            aria-label={t('teams.need.openTask', { id: row.taskId })}
            onClick={() => openTaskDrawer(row.taskId as string)}
            className="min-w-0 max-w-full truncate rounded text-left text-xs text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60"
          >
            <span className="font-mono text-text-secondary">{row.taskId}</span>
            {task ? ` ${task.title}` : ''}
          </button>
        )}
        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 text-[11px] text-text-secondary">
          {fromName && (
            <span data-need-from={fromId} className="min-w-0 truncate">
              {card && !card.system ? t('teams.need.q.asks', { agent: fromName }) : t('teams.need.from', { agent: fromName })}
            </span>
          )}
          {row.at > 0 && <span className="whitespace-nowrap">{t('teams.need.since', { time: clockTime(row.at, lang, Date.now()) })}</span>}
        </span>
      </div>
      {row.kind === 'trust' && <TrustBody teamId={teamId} view={view} needs={needs} />}
      {row.kind === 'paused' && <PausedBody teamId={teamId} needs={needs} />}
      {approval &&
        (approval.payload.kind === 'integrate' ? (
          <IntegrateNeedBody teamId={teamId} approval={approval} />
        ) : (
          <ApprovalBody teamId={teamId} approval={approval} view={view} fromQa={from?.kind === 'qa'} />
        ))}
      {card && <QuestionCard teamId={teamId} card={card} />}
    </li>
  )
}
