import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ListTodo, MessageSquare, MoreHorizontal, Pencil, Play } from 'lucide-react'
import { TASK_BODY_MAX, TASK_TITLE_MAX, isActiveRun, type TaskField } from '@shared/teams'
import type { AgentView, TaskDetail, TaskPatch, TeamView } from '@shared/team-protocol'
import { columnKey, columnOf, phaseKey, phaseWaitsOnUser, priorityKey } from '@shared/teamBoard'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { closeTeamDrawer, openAgentDrawer } from '@/lib/teamsStore'
import { boardTasks, loadTask, releaseOwned, saveTask, summaryFromDetail, summaryOf, taskKey, useBoardStore, type TaskEntry } from '@/lib/teams/board'
import { agentLabel, loadRoster, runFailText, runNow, useRosterStore } from '@/lib/teams/roster'
import { toast } from '@/lib/toast'
import { RightDrawer } from '@/components/ui/RightDrawer'
import { ContextMenu } from '@/components/ui/ContextMenu'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { ChatMarkdown } from '@/components/chat/Markdown'
import { SMALL_BTN, SMALL_BTN_TEXT } from './RunHeader'
import { CHIP, CHIP_AMBER, CHIP_NEUTRAL, blockedText, taskFailText, useTaskActions } from './TaskCard'
import { TaskFields, FIELD_CLS, TITLE_BAD_RE } from './TaskFields'
import { TaskActivity } from './TaskActivity'
import { BODY_BAD_RE, TaskComments, useLinkConfirm } from './TaskComments'

const NO_AGENTS: readonly AgentView[] = []
const SECTION = 'text-[11px] font-semibold uppercase tracking-wide text-text-secondary'

const FIELD_NAME: Record<TaskField, MessageKey> = {
  title: 'teams.task.fieldName.title',
  body: 'teams.task.fieldName.body',
  priority: 'teams.task.fieldName.priority',
  assignee: 'teams.task.fieldName.assignee',
  state: 'teams.task.fieldName.state',
  blockedBy: 'teams.task.fieldName.blockedBy',
  isolation: 'teams.task.fieldName.isolation',
  repoId: 'teams.task.fieldName.repoId',
  needsPlan: 'teams.task.fieldName.needsPlan',
}

/** UTF-16 units in KB with one decimal ("3,2"), for the description counter (main counts units too). */
function kb(n: number, lang: string): string {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n / 1024)
}

function Section({ title, children, name }: { title: string; children: ReactNode; name: string }) {
  return (
    <section data-task-section={name} className="flex min-w-0 flex-col gap-2 border-t border-border px-4 py-3">
      <h3 className={SECTION}>{title}</h3>
      {children}
    </section>
  )
}

/**
 * The drawer of one task (app 2.7.0, E10 B3), over any tab of the team: its
 * state, phase and why it is blocked; "Ejecutar ahora" for an idle assignee
 * and "Ver chat" of a live run; the title and the description (edited in
 * place); the fields (each saved at once with the task's rev; a `conflict`
 * loads the new version and keeps the change to retry); the review round;
 * the runs of the task; and its comments with the composer. A click on
 * another card switches it (`keepOpenOn`), with its own state per task. B5
 * adds the plan section, B6 the worktree one.
 */
export function TaskDrawer({ teamId, view, taskId }: { teamId: string; view: TeamView; taskId: string }) {
  const t = useT()
  const entry = useBoardStore((s) => s.tasks[taskKey(teamId, taskId)])
  const summary = useBoardStore((s) => s.pages[teamId]?.first.find((x) => x.id === taskId) ?? s.pages[teamId]?.olderDone.find((x) => x.id === taskId))
  const [maximized, setMaximized] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const roster = useRosterStore((s) => s.rosters[teamId])
  const agents = roster?.agents ?? NO_AGENTS
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])) as Record<string, AgentView>, [agents])
  const actions = useTaskActions(teamId, byId)

  useEffect(() => {
    void loadTask(teamId, taskId)
  }, [teamId, taskId])
  useEffect(() => {
    if (!useRosterStore.getState().rosters[teamId]) void loadRoster(teamId)
  }, [teamId])

  const detail = entry?.detail
  const title = detail?.title ?? summary?.title ?? ''
  return (
    <RightDrawer
      id="team-task"
      pinScope={teamId}
      keepOpenOn="[data-task-card]"
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-text-secondary">{taskId}</span>
          <span className="min-w-0 truncate">{title}</span>
        </span>
      }
      icon={<ListTodo size={15} className="shrink-0 text-text-secondary" />}
      actions={
        detail ? (
          <Tooltip label={t('teams.card.menu')} side="bottom">
            <button
              type="button"
              data-task-menu
              aria-label={t('teams.card.menu')}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.left, y: r.bottom + 4 })
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
            >
              <MoreHorizontal size={15} />
            </button>
          </Tooltip>
        ) : undefined
      }
      defaultWidth="clamp(420px, 40%, 760px)"
      maximized={maximized}
      onMaximize={setMaximized}
      onClose={() => closeTeamDrawer()}
    >
      {/* One body per task: a switch to another card starts its own drafts. */}
      <div key={taskId} data-task-drawer={taskId} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {detail && entry ? (
          <TaskBody teamId={teamId} view={view} entry={entry} detail={detail} agents={agents} byId={byId} />
        ) : entry?.failed ? (
          <div className="flex flex-col items-start gap-3 p-4" data-task-load-failed>
            <p className="text-sm text-text-secondary">{summary ? t('teams.task.loadFailed') : t('teams.task.gone')}</p>
            {summary && (
              <Button variant="ghost" size="sm" onClick={() => void loadTask(teamId, taskId)}>
                {t('teams.task.retry')}
              </Button>
            )}
          </div>
        ) : (
          <p className="p-4 text-sm text-text-secondary" data-task-loading>
            {t('teams.task.loading')}
          </p>
        )}
      </div>
      {/* With no card the menu works on the detail (its moves never read the comment count). */}
      {menu && detail && <ContextMenu x={menu.x} y={menu.y} label={t('teams.card.menu')} items={actions.menuItems(summaryOf(teamId, taskId) ?? summaryFromDetail(detail, 0), { open: false })} onClose={() => setMenu(null)} />}
      {actions.dialogs}
    </RightDrawer>
  )
}

type Editing = { field: 'title' | 'body'; text: string } | null

function TaskBody({ teamId, view, entry, detail, agents, byId }: { teamId: string; view: TeamView; entry: TaskEntry; detail: TaskDetail; agents: readonly AgentView[]; byId: Record<string, AgentView> }) {
  const t = useT()
  const lang = useLang()
  const { onLink, dialog } = useLinkConfirm()
  const board = useBoardStore((s) => s.pages[teamId])
  const tasks = useMemo(() => boardTasks(board), [board])
  const [editing, setEditing] = useState<Editing>(null)
  const [pending, setPending] = useState<TaskPatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [runNote, setRunNote] = useState<{ text: string; error: boolean } | null>(null)
  const [running, setRunning] = useState(false)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)

  // The editor that opens takes the keyboard without scrolling anything around the drawer (the app root is overflow-hidden).
  useEffect(() => {
    if (editing?.field === 'title') titleRef.current?.focus({ preventScroll: true })
    else if (editing?.field === 'body') bodyRef.current?.focus({ preventScroll: true })
  }, [editing?.field])

  const save = async (patch: TaskPatch): Promise<boolean> => {
    setSaving(true)
    setError(null)
    const fail = await saveTask(teamId, detail.id, detail.rev, patch)
    setSaving(false)
    if (!fail) {
      setPending(null)
      return true
    }
    if (fail.error === 'conflict') setPending(patch)
    else setError(taskFailText(fail, t))
    return false
  }
  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    const text = editing.field === 'title' ? editing.text.trim() : editing.text
    if (editing.field === 'title' && !text) return
    if (editing.field === 'body' && BODY_BAD_RE.test(text)) return
    const same = editing.field === 'title' ? text === detail.title : text === detail.body
    if (same || (await save(editing.field === 'title' ? { title: text } : { body: text }))) setEditing(null)
  }
  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveEdit()
    } else if (e.key === 'Escape') {
      // A text field, not a console: Esc cancels the edit only (the drawer and the overlay stay).
      e.preventDefault()
      e.stopPropagation()
      setEditing(null)
    }
  }
  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setEditing(null)
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      void saveEdit()
    }
  }

  const col = columnOf(detail)
  const live = detail.run && isActiveRun(detail.run.state) ? detail.run : undefined
  const assignee = detail.assignee ? byId[detail.assignee] : undefined
  const canRun = !!assignee && assignee.status === 'idle' && !assignee.retired && !assignee.takeover && !live && detail.state !== 'done' && detail.state !== 'cancelled'
  const blocked = blockedText(detail, t)
  const bodyUnits = editing?.field === 'body' ? editing.text.length : 0

  const doRun = async (): Promise<void> => {
    if (!assignee) return
    setRunning(true)
    setRunNote(null)
    const fail = await runNow(teamId, assignee.id, undefined, detail.id)
    setRunning(false)
    setRunNote(fail ? { text: runFailText(fail, agentLabel(assignee), t, lang, Date.now()), error: true } : { text: t('teams.task.runStarted'), error: false })
  }

  return (
    <>
      <div className="flex min-w-0 flex-col gap-2 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span data-task-drawer-state={detail.state} className={cn(CHIP, CHIP_NEUTRAL)}>
            {col ? t(columnKey(col)) : t('teams.card.cancelled')}
          </span>
          {detail.phase !== 'none' && detail.state !== 'done' && detail.state !== 'cancelled' && (
            <span className={cn(CHIP, phaseWaitsOnUser(detail.phase) ? CHIP_AMBER : CHIP_NEUTRAL)}>{t(phaseKey(detail.phase))}</span>
          )}
          <span className={cn(CHIP, CHIP_NEUTRAL)}>{t(priorityKey(detail.priority))}</span>
          {detail.branch && <span className={cn(CHIP, CHIP_NEUTRAL, 'font-mono')}>{detail.branch}</span>}
        </div>
        {blocked && (
          <p data-task-drawer-blocked className="text-xs text-state-action">
            {blocked}
          </p>
        )}
        {detail.userOwned.length > 0 && (
          <div data-task-owned={detail.userOwned.join(',')} className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-text-secondary">
            <span className="min-w-0">{t('teams.task.owned', { fields: detail.userOwned.map((f) => t(FIELD_NAME[f])).join(', ') })}</span>
            <button
              type="button"
              data-task-release
              onClick={() =>
                void releaseOwned(teamId, detail.id, detail.userOwned).then((fail) => {
                  if (fail) toast.error(taskFailText(fail, t))
                })
              }
              className="rounded px-1 text-text-primary underline-offset-2 hover:underline"
            >
              {t('teams.task.ownedRelease')}
            </button>
          </div>
        )}
        {(canRun || live) && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {canRun && (
              <button type="button" data-task-run-now disabled={running} onClick={() => void doRun()} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
                <Play size={13} aria-hidden />
                {t('teams.task.runNow')}
              </button>
            )}
            {live && (
              <button type="button" data-task-view-run={live.id} onClick={() => openAgentDrawer(live.agentId, live.id, 'run')} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
                <MessageSquare size={13} aria-hidden />
                {t('teams.task.viewRun')}
              </button>
            )}
          </div>
        )}
        {runNote && (
          <p data-task-run-note={runNote.error ? 'error' : 'ok'} role="status" className={cn('text-[11px]', runNote.error ? 'text-state-error' : 'text-text-secondary')}>
            {runNote.text}
          </p>
        )}
      </div>

      <section data-task-section="title" className="flex min-w-0 flex-col gap-2 border-t border-border px-4 py-3">
        {editing?.field === 'title' ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <input
              ref={titleRef}
              type="text"
              data-task-title-input
              value={editing.text}
              maxLength={TASK_TITLE_MAX}
              aria-label={t('teams.task.title')}
              aria-invalid={editing.text.trim() ? undefined : true}
              onKeyDown={onTitleKey}
              onChange={(e) => setEditing({ field: 'title', text: e.target.value.replace(TITLE_BAD_RE, ' ') })}
              className={cn(FIELD_CLS, 'h-9 text-sm')}
            />
            {!editing.text.trim() && <p className="text-[11px] text-state-error">{t('teams.task.titleRequired')}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" className="h-8" data-task-title-save disabled={saving || !editing.text.trim()} onClick={() => void saveEdit()}>
                {saving ? t('teams.task.saving') : t('teams.task.save')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 items-start gap-2">
            <h2 data-task-drawer-title className="min-w-0 flex-1 break-words text-[15px] font-semibold leading-snug text-text-primary">
              {detail.title}
            </h2>
            {detail.state !== 'cancelled' && (
              <Tooltip label={t('teams.task.editTitle')} side="bottom" className="shrink-0">
                <button type="button" data-task-title-edit aria-label={t('teams.task.editTitle')} onClick={() => setEditing({ field: 'title', text: detail.title })} className="rounded p-1 text-text-secondary hover:bg-card hover:text-text-primary">
                  <Pencil size={13} />
                </button>
              </Tooltip>
            )}
          </div>
        )}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h3 className={SECTION}>{t('teams.task.description')}</h3>
          {editing?.field !== 'body' && detail.state !== 'cancelled' && (
            <button type="button" data-task-body-edit onClick={() => setEditing({ field: 'body', text: detail.body })} className="rounded px-1 text-[11px] text-text-secondary hover:text-text-primary">
              {t('teams.task.edit')}
            </button>
          )}
        </div>
        {editing?.field === 'body' ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <textarea
              ref={bodyRef}
              data-task-body-input
              value={editing.text}
              rows={8}
              maxLength={TASK_BODY_MAX}
              aria-label={t('teams.task.description')}
              onKeyDown={onBodyKey}
              onChange={(e) => setEditing({ field: 'body', text: e.target.value })}
              className="block max-h-96 min-h-[8rem] w-full resize-y rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] leading-[1.45] text-text-primary outline-none focus:border-accent-violet/50"
            />
            <div className="flex min-w-0 items-center gap-2">
              <span className="mr-auto text-[11px] tabular-nums text-text-secondary">{t('teams.task.size', { used: kb(bodyUnits, lang), max: kb(TASK_BODY_MAX, lang) })}</span>
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" className="h-8" data-task-body-save disabled={saving || BODY_BAD_RE.test(editing.text)} onClick={() => void saveEdit()}>
                {saving ? t('teams.task.saving') : t('teams.task.save')}
              </Button>
            </div>
          </div>
        ) : detail.body.trim() ? (
          <div data-task-body className="max-h-72 min-w-0 overflow-y-auto rounded-btn border border-border bg-card/30 px-3 py-2">
            <ChatMarkdown text={detail.body} onLink={onLink} />
          </div>
        ) : (
          <p data-task-body className="text-xs text-text-secondary">
            {t('teams.task.noDescription')}
          </p>
        )}
      </section>

      {(pending || error) && (
        <div data-task-save-note={pending ? 'conflict' : 'error'} role="status" className="mx-4 mb-1 flex min-w-0 flex-wrap items-center gap-2 rounded-btn border border-state-action/50 bg-state-action/10 px-3 py-2 text-xs text-text-primary">
          <span className="min-w-0 flex-1">{pending ? t('teams.task.conflict') : error}</span>
          {pending && (
            <>
              <button type="button" data-task-retry disabled={saving} onClick={() => void save(pending).then((ok) => ok && setEditing(null))} className={cn(SMALL_BTN, SMALL_BTN_TEXT, 'h-7')}>
                {t('teams.task.retry')}
              </button>
              <button
                type="button"
                data-task-discard
                onClick={() => {
                  setPending(null)
                  setEditing(null)
                }}
                className="rounded px-1 text-text-secondary hover:text-text-primary"
              >
                {t('teams.task.discard')}
              </button>
            </>
          )}
        </div>
      )}

      <Section name="fields" title={t('teams.task.section.fields')}>
        <TaskFields detail={detail} view={view} agents={agents} tasks={tasks} pending={pending} busy={saving} onSave={(patch) => void save(patch)} />
      </Section>

      {/* B5 inserts the plan section here (TaskPlanSection), B6 the worktree section (TaskWorktreeSection). */}

      {(detail.reviewInfo.round > 0 || detail.reviewInfo.lastVerdict) && (
        <Section name="review" title={t('teams.task.section.review')}>
          <p className="text-xs text-text-primary">
            {t('teams.task.reviewRound', { round: detail.reviewInfo.round, max: detail.reviewInfo.max })}
            {detail.reviewInfo.lastVerdict && <span className="text-text-secondary"> · {t(detail.reviewInfo.lastVerdict === 'approve' ? 'teams.task.verdict.approve' : 'teams.task.verdict.changes')}</span>}
          </p>
        </Section>
      )}

      <Section name="activity" title={t('teams.task.section.activity')}>
        <TaskActivity runs={detail.runs} agents={byId} />
      </Section>

      <Section name="comments" title={t('teams.task.section.comments')}>
        <TaskComments teamId={teamId} taskId={detail.id} entry={entry} />
      </Section>
      {dialog}
    </>
  )
}
