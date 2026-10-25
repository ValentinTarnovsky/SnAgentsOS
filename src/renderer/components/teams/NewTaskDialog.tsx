/**
 * "Nueva tarea" (app 2.7.0, E10 B3), from the team header, the palette and
 * the empty board: title (required), description, assignee ("Que decida el
 * Líder" by default), priority (normal), needs plan (on), isolation (own
 * worktree; a read-only assignee still runs in the repo folder, the hint
 * says so), repo (with extra repos) and blockers. Main creates it and marks
 * every field the user filled as theirs, so only the fields touched here go
 * in the draft (an untouched default stays the Lead's to change). Esc
 * cancels, Ctrl+Enter creates; the drawer opens on the new task. Mounted
 * once in App; nothing while closed.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ListPlus, Loader2, X } from 'lucide-react'
import { labOn } from '@shared/labs'
import { BLOCKED_BY_MAX, REPO_MAIN, TASK_BODY_MAX, TASK_PRIORITIES, TASK_TITLE_MAX, type Isolation, type TaskPriority } from '@shared/teams'
import type { AgentView, TaskDraft } from '@shared/team-protocol'
import { priorityKey } from '@shared/teamBoard'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/lib/store'
import { setTeamTab, useTeamsStore } from '@/lib/teamsStore'
import { boardTasks, closeNewTask, createTask, loadBoard, useBoardStore } from '@/lib/teams/board'
import { agentLabel, loadRoster, useRosterStore } from '@/lib/teams/roster'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/settings/ui'
import { toast } from '@/lib/toast'
import { FIELD_CLS, TITLE_BAD_RE, assignableAgents, isolationHint, segBtn } from './TaskFields'
import { taskFailText } from './TaskCard'
import { BODY_BAD_RE } from './TaskComments'

const NO_AGENTS: readonly AgentView[] = []
const CREATE_KEYS = ['Ctrl', 'Enter']
const LABEL = 'text-xs font-medium text-text-secondary'
const HINT = 'text-[11px] text-text-secondary/80'

type Touched = 'assignee' | 'priority' | 'needsPlan' | 'isolation' | 'repoId' | 'blockedBy'

function Field({ label, hint, children, name }: { label: string; hint?: string; children: ReactNode; name: string }) {
  return (
    <div data-new-task-field={name} className="min-w-0 space-y-1.5">
      <span className={LABEL}>{label}</span>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  )
}

export function NewTaskDialog() {
  const open = useBoardStore((s) => s.newTask)
  const disabled = useTeamsStore((s) => s.disabled)
  const teamsOn = useAppStore((s) => labOn(s.settings, 'teams'))
  // Labs off while open (here, or main answered `disabled`): nothing of Teams stays on screen.
  useEffect(() => {
    if (open && (disabled || !teamsOn)) closeNewTask()
  }, [open, disabled, teamsOn])
  if (!open || disabled || !teamsOn) return null
  return <DialogBody key={open.teamId} teamId={open.teamId} />
}

function DialogBody({ teamId }: { teamId: string }) {
  const t = useT()
  const view = useTeamsStore((s) => s.views[teamId])
  const name = useTeamsStore((s) => s.views[teamId]?.name ?? s.list.find((x) => x.id === teamId)?.name ?? '')
  const state = useBoardStore((s) => s.newTask)
  const board = useBoardStore((s) => s.pages[teamId])
  const agents = useRosterStore((s) => s.rosters[teamId]?.agents) ?? NO_AGENTS
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [needsPlan, setNeedsPlan] = useState(true)
  const [isolation, setIsolation] = useState<Isolation>('worktree')
  const [repoId, setRepoId] = useState<string>(REPO_MAIN)
  const [blockedBy, setBlockedBy] = useState<string[]>([])
  const [touched, setTouched] = useState<ReadonlySet<Touched>>(new Set())
  const titleRef = useRef<HTMLInputElement | null>(null)
  const busy = state?.busy === true
  const touch = (f: Touched): void => setTouched((s) => (s.has(f) ? s : new Set([...s, f])))

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
    if (!useRosterStore.getState().rosters[teamId]) void loadRoster(teamId)
    if (!useBoardStore.getState().pages[teamId]) void loadBoard(teamId)
  }, [teamId])

  const ready = title.trim() !== '' && !BODY_BAD_RE.test(body) && !busy
  const submit = async (): Promise<void> => {
    if (!ready) return
    const draft: TaskDraft = { title: title.trim() }
    if (body.trim()) draft.body = body
    if (touched.has('assignee') && assignee) draft.assignee = assignee
    if (touched.has('priority')) draft.priority = priority
    if (touched.has('needsPlan')) draft.needsPlan = needsPlan
    if (touched.has('isolation')) draft.isolation = isolation
    if (touched.has('repoId')) draft.repoId = repoId
    if (touched.has('blockedBy') && blockedBy.length) draft.blockedBy = blockedBy
    const id = await createTask(teamId, draft)
    if (id) {
      setTeamTab('board')
      toast.success(t('teams.task.created', { id }))
    }
  }

  // Esc closes only this dialog (never the team host or the drawer behind it); Ctrl+Enter creates.
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault()
        e.stopPropagation()
        closeNewTask()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        e.stopPropagation()
        void submitRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const options = assignableAgents(agents)
  const picked = agents.find((a) => a.id === assignee)
  const candidates = boardTasks(board).filter((x) => x.state !== 'cancelled' && !blockedBy.includes(x.id))
  const error = state?.error

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={() => !busy && closeNewTask()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-new-task-title"
        data-new-task={teamId}
        aria-busy={busy || undefined}
        className="relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <ListPlus size={18} className="shrink-0 text-accent-violet" />
          <h2 id="team-new-task-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
            {t('teams.task.newTitle', { team: name })}
          </h2>
          <button type="button" aria-label={t('common.close')} onClick={() => closeNewTask()} className="rounded p-1 text-text-secondary hover:bg-bg-secondary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Field name="title" label={t('teams.task.title')}>
            <input
              ref={titleRef}
              type="text"
              data-new-task-title
              value={title}
              maxLength={TASK_TITLE_MAX}
              placeholder={t('teams.task.titlePlaceholder')}
              onChange={(e) => setTitle(e.target.value.replace(TITLE_BAD_RE, ' '))}
              className={cn(FIELD_CLS, 'h-9 text-sm')}
            />
          </Field>
          <Field name="body" label={t('teams.task.description')}>
            <textarea
              data-new-task-body
              value={body}
              rows={5}
              maxLength={TASK_BODY_MAX}
              placeholder={t('teams.task.bodyPlaceholder')}
              onChange={(e) => setBody(e.target.value)}
              className="block max-h-72 min-h-[6rem] w-full resize-y rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] leading-[1.45] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-accent-violet/50"
            />
            {BODY_BAD_RE.test(body) && <p className="text-[11px] text-state-error">{t('teams.comment.control')}</p>}
          </Field>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field name="assignee" label={t('teams.task.field.assignee')}>
              <select
                data-new-task-assignee
                value={assignee}
                onChange={(e) => {
                  setAssignee(e.target.value)
                  touch('assignee')
                }}
                className={FIELD_CLS}
              >
                <option value="">{t('teams.task.field.leadDecides')}</option>
                {options.map((a) => (
                  <option key={a.id} value={a.id}>
                    {agentLabel(a)}
                  </option>
                ))}
              </select>
            </Field>
            {view && view.extraRepos.length > 0 && (
              <Field name="repoId" label={t('teams.task.field.repo')}>
                <select
                  data-new-task-repo
                  value={repoId}
                  onChange={(e) => {
                    setRepoId(e.target.value)
                    touch('repoId')
                  }}
                  className={FIELD_CLS}
                >
                  <option value={REPO_MAIN}>{view.repoName}</option>
                  {view.extraRepos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <Field name="priority" label={t('teams.task.field.priority')}>
            <div role="radiogroup" aria-label={t('teams.task.field.priority')} className="flex w-fit max-w-full flex-wrap gap-1 rounded-btn border border-border bg-bg-primary p-1">
              {TASK_PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={priority === p}
                  data-new-task-priority={p}
                  onClick={() => {
                    setPriority(p)
                    touch('priority')
                  }}
                  className={segBtn(priority === p)}
                >
                  {t(priorityKey(p))}
                </button>
              ))}
            </div>
          </Field>
          <Field name="isolation" label={t('teams.task.field.isolation')} hint={isolationHint(isolation, picked, t)}>
            <div role="radiogroup" aria-label={t('teams.task.field.isolation')} className="flex w-fit max-w-full flex-wrap gap-1 rounded-btn border border-border bg-bg-primary p-1">
              {(['worktree', 'main'] as const).map((iso) => (
                <button
                  key={iso}
                  type="button"
                  role="radio"
                  aria-checked={isolation === iso}
                  data-new-task-isolation={iso}
                  onClick={() => {
                    setIsolation(iso)
                    touch('isolation')
                  }}
                  className={segBtn(isolation === iso)}
                >
                  {t(iso === 'worktree' ? 'teams.task.field.isolationWorktree' : 'teams.task.field.isolationMain')}
                </button>
              ))}
            </div>
          </Field>
          <div data-new-task-field="needsPlan" className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-text-primary">{t('teams.task.field.needsPlan')}</div>
              <p className={HINT}>{t('teams.task.field.needsPlanHint')}</p>
            </div>
            <Toggle
              checked={needsPlan}
              onChange={(v) => {
                setNeedsPlan(v)
                touch('needsPlan')
              }}
              ariaLabel={t('teams.task.field.needsPlan')}
            />
          </div>
          <Field name="blockedBy" label={t('teams.task.field.blockedBy')}>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {blockedBy.map((id) => (
                <span key={id} data-new-task-blocker={id} className="inline-flex items-center gap-1 rounded border border-border bg-bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
                  {id}
                  <button type="button" aria-label={t('teams.task.field.removeBlocker', { id })} onClick={() => setBlockedBy((b) => b.filter((x) => x !== id))} className="rounded text-text-secondary hover:text-text-primary">
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
            {blockedBy.length < BLOCKED_BY_MAX && candidates.length > 0 ? (
              <select
                data-new-task-blocker-add
                value=""
                aria-label={t('teams.task.field.blockedByAdd')}
                onChange={(e) => {
                  const id = e.target.value
                  if (!id) return
                  setBlockedBy((b) => [...b, id])
                  touch('blockedBy')
                }}
                className={FIELD_CLS}
              >
                <option value="">{t('teams.task.field.blockedByAdd')}</option>
                {candidates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.id} · {x.title}
                  </option>
                ))}
              </select>
            ) : (
              blockedBy.length === 0 && <p className={HINT}>{t('teams.task.field.blockedByNone')}</p>
            )}
          </Field>
          {error && (
            <p data-new-task-error={error.error} role="alert" className="text-xs text-state-error">
              {error.error === 'io' || error.error === 'bad_request' ? t('teams.task.createFailed') : taskFailText(error, t)}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <Button variant="ghost" size="sm" data-new-task-cancel onClick={() => closeNewTask()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" data-new-task-create disabled={!ready} keyHint={CREATE_KEYS} onClick={() => void submit()}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? t('teams.task.creating') : t('teams.task.create')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
