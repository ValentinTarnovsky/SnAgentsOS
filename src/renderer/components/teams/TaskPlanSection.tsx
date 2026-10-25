import type { ApprovalView, TaskDetail } from '@shared/team-protocol'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { loadTask } from '@/lib/teams/board'
import { CHIP, CHIP_AMBER, CHIP_NEUTRAL } from './TaskCard'
import { DecideControls, PlanText } from './ApprovalBody'

const SECTION = 'text-[11px] font-semibold uppercase tracking-wide text-text-secondary'

/** The approval that decides this plan revision, while it waits (decision 29: the user may decide one the Lead holds). */
export function pendingPlanApproval(detail: Pick<TaskDetail, 'plan' | 'approvals'>): ApprovalView | undefined {
  const plan = detail.plan
  if (!plan || plan.status !== 'pending') return undefined
  return detail.approvals.find((a) => a.payload.kind === 'plan' && a.payload.planRev === plan.rev && (a.state === 'pending' || a.state === 'applying'))
}

/**
 * The plan section of the task drawer (app 2.7.0, E10 B5): the plan the agent
 * wrote (`team plan`) in a scroll box with "Ver completo", its version, its
 * state (waiting for the user or for the Lead, approved, changes asked) and,
 * while it waits, Aprobar / Pedir cambios (the note is required and goes to
 * the agent). No exec runs without an approved plan: this and Te necesita are
 * where it gets one. Main's answer reloads the task.
 */
export function TaskPlanSection({ teamId, detail }: { teamId: string; detail: TaskDetail }) {
  const t = useT()
  const plan = detail.plan
  if (!plan) return null
  const approval = pendingPlanApproval(detail)
  const lead = approval?.decider === 'lead'
  const statusKey: MessageKey =
    plan.status === 'approved' ? (plan.decidedBy === 'lead' ? 'teams.plan.approvedLead' : 'teams.plan.approved')
    : plan.status === 'rejected' ? 'teams.plan.rejected'
    : lead ? 'teams.plan.pendingLead' : 'teams.plan.pending'
  const waits = plan.status === 'pending' && !lead
  return (
    <section data-task-section="plan" data-plan-status={plan.status} className="flex min-w-0 flex-col gap-2 border-t border-border px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <h3 className={SECTION}>{t('teams.plan.section')}</h3>
        <span data-plan-state={plan.status} className={cn(CHIP, waits ? CHIP_AMBER : CHIP_NEUTRAL)}>
          {t(statusKey)}
        </span>
        <span className={cn(CHIP, CHIP_NEUTRAL)}>{t('teams.approval.rev', { rev: plan.rev })}</span>
        {plan.small && <span className={cn(CHIP, CHIP_NEUTRAL)}>{t('teams.approval.small')}</span>}
      </div>
      <PlanText text={plan.text} truncated={plan.truncated} name={`${detail.id}-v${plan.rev}`} />
      {approval && (
        <>
          {lead && <p className="text-[11px] text-text-secondary">{t('teams.plan.leadHint')}</p>}
          <DecideControls teamId={teamId} approval={approval} second="changes" scope="plan" onReply={() => void loadTask(teamId, detail.id)} />
        </>
      )}
    </section>
  )
}
