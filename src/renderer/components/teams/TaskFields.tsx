import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { BLOCKED_BY_MAX, REPO_MAIN, TASK_PRIORITIES, type Isolation } from '@shared/teams'
import type { AgentView, TaskDetail, TaskPatch, TaskSummary, TeamView } from '@shared/team-protocol'
import { priorityKey } from '@shared/teamBoard'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { agentLabel } from '@/lib/teams/roster'
import { Toggle } from '@/components/settings/ui'

/**
 * C0, DEL, C1 and the line and paragraph separators (U+2028, U+2029): main refuses a title with one, so typing or
 * pasting one turns it into a space. Built from char codes so the separators never sit raw in the source.
 */
export const TITLE_BAD_RE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

export const FIELD_CLS = 'h-8 w-full min-w-0 rounded-btn border border-border bg-bg-primary px-2 text-xs text-text-primary outline-none focus:border-accent-violet/60 disabled:cursor-not-allowed disabled:opacity-60'
const LABEL = 'text-[11px] font-medium text-text-secondary'
const HINT = 'text-[11px] leading-4 text-text-secondary/80'

/** Segmented-control button (the composer's and the settings' look). */
export const segBtn = (on: boolean): string =>
  cn(
    'whitespace-nowrap rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60',
    on ? 'bg-accent-violet text-white' : 'text-text-secondary hover:text-text-primary',
  )

export function FieldRow({ name, label, hint, children }: { name: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div data-task-field={name} className="grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1">
      <span className={cn(LABEL, 'pt-2')}>{label}</span>
      <div className="min-w-0 space-y-1">
        {children}
        {hint && <p className={HINT}>{hint}</p>}
      </div>
    </div>
  )
}

/** The agents a task can go to: never the Lead, never a retired one (the current assignee stays listed). */
export function assignableAgents(agents: readonly AgentView[], current?: string): AgentView[] {
  return agents.filter((a) => a.kind !== 'lead' && (!a.retired || a.id === current))
}

/** The hint under Aislamiento: a read-only assignee runs in the repo root with no worktree (decision 24). */
export function isolationHint(isolation: Isolation, assignee: AgentView | undefined, t: ReturnType<typeof useT>): string {
  if (isolation === 'worktree' && assignee && assignee.permission === 'readonly') return t('teams.task.field.readonlyHint', { agent: agentLabel(assignee) })
  return isolation === 'worktree' ? t('teams.task.field.worktreeHint') : t('teams.task.field.mainHint')
}

/**
 * The editable fields of a task in its drawer (app 2.7.0, E10 B3): assignee,
 * priority, repo, isolation, needs plan and blockers. Each change goes to
 * main at once with the task's rev; while a conflicted change waits for
 * Reintentar, its field shows that change (`pending`). Repo, isolation and
 * needs plan change only while the task is in Por hacer (main fixes them at
 * the first run).
 */
export function TaskFields({
  detail,
  view,
  agents,
  tasks,
  pending,
  busy,
  onSave,
}: {
  detail: TaskDetail
  view: TeamView
  agents: readonly AgentView[]
  /** The board's tasks, to pick blockers from. */
  tasks: readonly TaskSummary[]
  pending: TaskPatch | null
  busy: boolean
  onSave: (patch: TaskPatch) => void
}) {
  const t = useT()
  const todo = detail.state === 'todo'
  const closed = detail.state === 'done' || detail.state === 'cancelled'
  const assignee = pending && 'assignee' in pending ? (pending.assignee ?? undefined) : detail.assignee
  const priority = pending?.priority ?? detail.priority
  const repoId = pending?.repoId ?? detail.repoId
  const isolation = pending?.isolation ?? detail.isolation
  const needsPlan = pending?.needsPlan ?? detail.needsPlan
  const blockedBy = pending?.blockedBy ?? detail.blockedBy
  const options = assignableAgents(agents, assignee)
  const assigneeAgent = agents.find((a) => a.id === assignee)
  const candidates = tasks.filter((x) => x.id !== detail.id && !blockedBy.includes(x.id) && x.state !== 'cancelled')
  const off = busy || closed
  return (
    <div data-task-fields className="flex flex-col gap-3">
      <FieldRow name="assignee" label={t('teams.task.field.assignee')}>
        <select
          data-task-assignee
          value={assignee ?? ''}
          disabled={off}
          onChange={(e) => onSave({ assignee: e.target.value || null })}
          className={FIELD_CLS}
        >
          <option value="">{t('teams.task.field.leadDecides')}</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {agentLabel(a)}
            </option>
          ))}
          {assignee && !options.some((a) => a.id === assignee) && <option value={assignee}>{assignee}</option>}
        </select>
      </FieldRow>
      <FieldRow name="priority" label={t('teams.task.field.priority')}>
        <div role="radiogroup" aria-label={t('teams.task.field.priority')} className="flex w-fit max-w-full flex-wrap gap-1 rounded-btn border border-border bg-bg-primary p-1">
          {TASK_PRIORITIES.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={priority === p} data-priority={p} disabled={off} onClick={() => p !== priority && onSave({ priority: p })} className={segBtn(priority === p)}>
              {t(priorityKey(p))}
            </button>
          ))}
        </div>
      </FieldRow>
      {view.extraRepos.length > 0 && (
        <FieldRow name="repoId" label={t('teams.task.field.repo')} hint={todo ? undefined : t('teams.task.field.onlyTodo')}>
          <select data-task-repo value={repoId} disabled={off || !todo} onChange={(e) => onSave({ repoId: e.target.value })} className={FIELD_CLS}>
            <option value={REPO_MAIN}>{view.repoName}</option>
            {view.extraRepos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </FieldRow>
      )}
      <FieldRow name="isolation" label={t('teams.task.field.isolation')} hint={todo ? isolationHint(isolation, assigneeAgent, t) : t('teams.task.field.onlyTodo')}>
        <div role="radiogroup" aria-label={t('teams.task.field.isolation')} className="flex w-fit max-w-full flex-wrap gap-1 rounded-btn border border-border bg-bg-primary p-1">
          {(['worktree', 'main'] as const).map((iso) => (
            <button key={iso} type="button" role="radio" aria-checked={isolation === iso} data-isolation={iso} disabled={off || !todo} onClick={() => iso !== isolation && onSave({ isolation: iso })} className={segBtn(isolation === iso)}>
              {t(iso === 'worktree' ? 'teams.task.field.isolationWorktree' : 'teams.task.field.isolationMain')}
            </button>
          ))}
        </div>
      </FieldRow>
      <FieldRow name="needsPlan" label={t('teams.task.field.needsPlan')} hint={todo ? t('teams.task.field.needsPlanHint') : t('teams.task.field.onlyTodo')}>
        <div className="pt-1">
          <Toggle checked={needsPlan} disabled={off || !todo} onChange={(v) => onSave({ needsPlan: v })} ariaLabel={t('teams.task.field.needsPlan')} />
        </div>
      </FieldRow>
      <FieldRow name="blockedBy" label={t('teams.task.field.blockedBy')}>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {blockedBy.length === 0 && <span className="pt-1.5 text-xs text-text-secondary">{t('teams.task.field.blockedByNone')}</span>}
          {blockedBy.map((id) => (
            <span key={id} data-blocker={id} className="inline-flex items-center gap-1 rounded border border-border bg-bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
              {id}
              <button
                type="button"
                data-blocker-remove={id}
                disabled={off}
                aria-label={t('teams.task.field.removeBlocker', { id })}
                onClick={() => onSave({ blockedBy: blockedBy.filter((x) => x !== id) })}
                className="rounded text-text-secondary hover:text-text-primary disabled:opacity-50"
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
        {!closed && blockedBy.length < BLOCKED_BY_MAX && candidates.length > 0 && (
          <select
            data-blocker-add
            value=""
            disabled={off}
            aria-label={t('teams.task.field.blockedByAdd')}
            onChange={(e) => e.target.value && onSave({ blockedBy: [...blockedBy, e.target.value] })}
            className={FIELD_CLS}
          >
            <option value="">{t('teams.task.field.blockedByAdd')}</option>
            {candidates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id} · {x.title}
              </option>
            ))}
          </select>
        )}
      </FieldRow>
    </div>
  )
}
