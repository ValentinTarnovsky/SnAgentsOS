/**
 * A task on the phone (app 2.7.0, E10 B8): its chips and why it is blocked,
 * this task's rows of "Te necesita" first (the same NeedCards), the
 * description (folded after 12 lines; "Sigue en la PC" when the PC sent only
 * part of it), the plan, the activity (each run opens its log) and the
 * comments ("Ver anteriores" pages back) with a composer at the bottom: the
 * comment goes out only on Comentar, dictated words included. A change of
 * the task on the PC reloads it, never while the composer holds text (it
 * reloads once that text is sent or cleared), keeping the earlier comments
 * loaded (keepOlderPages).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronRight, Loader2 } from 'lucide-react'
import { COMMENT_TEXT_MAX } from '@shared/teams'
import type { CommentView, TaskDetail } from '@shared/team-protocol'
import { needsOfTask } from '@shared/teamNeeds'
import { PushScreen } from '../PushScreen'
import { NoReply } from '../NoReply'
import { Markdown } from '../chat/Markdown'
import { NeedCard } from './NeedCard'
import { RunLogSheet } from './RunLogSheet'
import { useTeamNeeds } from './TeamNeedsScreen'
import { COMPOSER_CLEARANCE_PX, Chip, Composer, Folded, GHOST_BTN, LoadFailed, SECTION_TITLE, Spinner, bodyProblem, keepOlderPages, loadStatusOf, outgoingText, useTeamChange, type Load, type OlderPages } from './TeamBits'
import { COL_KEY, MODE_KEY, PHASE_KEY, PRIO_KEY, RUN_STATE_KEY, blockedText, isRunLive, refusalOf, replyOf, sysText, visibleName, visibleText, writeFailText } from './teamText'
import { client } from '../../lib/client'
import { closeTeamTask, useTeamsUi } from '../../lib/teamsStore'
import { relativeAge } from '../../lib/statusText'
import { stopDictation } from '../../lib/voice'
import { t } from '../../lib/i18n'

const MIC_OWNER = 'teamComment'
const USER_PHASES = new Set(['planApproval', 'userOk'])

function CommentRow({ c, now }: { c: CommentView; now: number }): ReactNode {
  const mine = c.author === 'user'
  const who = mine ? t('teams.comment.you') : c.author === 'system' ? t('teams.comment.system') : visibleName(c.authorName || c.author)
  const kind = c.kind === 'review' ? t('teams.comment.kind.review') : c.kind === 'answer' ? t('teams.comment.kind.answer') : null
  return (
    <div data-task-comment={c.id} data-comment-sys={c.sys?.key} data-comment-author={mine ? 'user' : c.author === 'system' ? 'system' : 'agent'} className="flex min-w-0 flex-col gap-1 rounded-btn border border-border bg-bg-secondary px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-1.5 text-[11px] text-text-secondary">
        <span className="min-w-0 truncate font-medium text-text-primary">{who}</span>
        {kind && <span className="shrink-0">{kind}</span>}
        <span className="ml-auto shrink-0">{relativeAge(c.at, now)}</span>
      </div>
      {c.sys ? (
        <p className="whitespace-pre-wrap text-sm text-text-secondary [overflow-wrap:anywhere]">{sysText(c)}</p>
      ) : mine ? (
        <p className="whitespace-pre-wrap text-sm text-text-primary [overflow-wrap:anywhere]">{visibleText(c.text)}</p>
      ) : (
        <div className="min-w-0 text-sm">
          <Markdown text={visibleText(c.text)} />
        </div>
      )}
      {c.queued && (
        <span data-comment-queued className="text-[11px] text-text-secondary">
          {c.recipientName || c.recipient ? t('teams.comment.queued', { agent: visibleName(c.recipientName || c.recipient || '') }) : t('teams.comment.queuedAny')}
        </span>
      )}
    </div>
  )
}

function planStatus(plan: NonNullable<TaskDetail['plan']>): string {
  if (plan.status === 'approved') return t(plan.decidedBy === 'lead' ? 'teams.plan.approvedLead' : 'teams.plan.approved')
  if (plan.status === 'rejected') return t('teams.plan.rejected')
  return t(plan.small ? 'teams.plan.pendingLead' : 'teams.plan.pending')
}

export function TaskBody({ teamId, taskId, onTitle }: { teamId: string; taskId: string; onTitle?: (title: string) => void }): ReactNode {
  const [task, setTask] = useState<Load<TaskDetail>>({ status: 'loading', value: null })
  const [older, setOlder] = useState<OlderPages<CommentView> | null>(null)
  const [olderBusy, setOlderBusy] = useState(false)
  const [olderFailed, setOlderFailed] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runSheet, setRunSheet] = useState<string | null>(null)
  const { needs, rows, hide, reload: reloadNeeds } = useTeamNeeds(teamId)
  const seq = useRef(0)
  const textRef = useRef(text)
  textRef.current = text
  /** A change came while the composer held text: reload once it is empty. */
  const owed = useRef(false)
  const titleRef = useRef(onTitle)
  titleRef.current = onTitle
  /** What a reload keeps: the comments shown and the earlier pages "Ver anteriores" loaded. */
  const shownRef = useRef<{ page: readonly CommentView[]; older: OlderPages<CommentView> | null }>({ page: [], older: null })
  shownRef.current = { page: task.value?.comments ?? [], older }

  const load = useCallback(async (): Promise<void> => {
    const n = ++seq.current
    const out = await client.requestTeam({ op: 'task', teamId, taskId })
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      const status = loadStatusOf(refusalOf(out))
      setTask((cur) => ({ status, value: status === 'gone' ? null : cur.value }))
      return
    }
    const prev = shownRef.current
    setTask({ status: 'ok', value: ok.task })
    setOlder(keepOlderPages(prev.older, prev.page, ok.task.comments, ok.task.commentsCursor))
    titleRef.current?.(ok.task.title)
  }, [teamId, taskId])

  useEffect(() => {
    void load()
  }, [load])

  useTeamChange(teamId, 'task', taskId, () => {
    if (textRef.current.trim()) owed.current = true
    else void load()
  })
  // The composer emptied (sent or cleared): the reload a change asked for meanwhile.
  useEffect(() => {
    if (!text.trim() && owed.current) {
      owed.current = false
      void load()
    }
  }, [text, load])

  const detail = task.value
  const loadOlder = async (): Promise<void> => {
    const cursor = older ? older.cursor : detail?.commentsCursor
    if (!cursor || olderBusy) return
    const n = seq.current
    setOlderBusy(true)
    setOlderFailed(false)
    const out = await client.requestTeam({ op: 'task', teamId, taskId, commentsBefore: cursor })
    setOlderBusy(false)
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      setOlderFailed(true)
      return
    }
    setOlder((cur) => {
      const have = new Set([...(cur?.items ?? []), ...(detail?.comments ?? [])].map((c) => c.id))
      return { items: [...ok.task.comments.filter((c) => !have.has(c.id)), ...(cur?.items ?? [])], cursor: ok.task.commentsCursor }
    })
  }

  const send = async (): Promise<void> => {
    const value = outgoingText(text).trim()
    if (!value || sending) return
    const problem = bodyProblem(value, COMMENT_TEXT_MAX)
    if (problem) {
      setError(problem)
      return
    }
    stopDictation(MIC_OWNER, true)
    const sent = text
    setSending(true)
    setError(null)
    const out = await client.requestTeam({ op: 'comment', teamId, taskId, text: value })
    setSending(false)
    const ok = replyOf(out)
    if (!ok) {
      setError(writeFailText(refusalOf(out) ?? { error: 'io' }, 'teams.comment.failed'))
      return
    }
    setTask((cur) => (cur.value && !cur.value.comments.some((c) => c.id === ok.comment.id) ? { ...cur, value: { ...cur.value, comments: [...cur.value.comments, ok.comment] } } : cur))
    owed.current = true
    // Only what was sent goes: text typed or dictated while the comment was out stays in the field.
    setText((cur) => (cur.startsWith(sent) ? cur.slice(sent.length).replace(/^\s+/, '') : cur))
  }

  if (task.status === 'gone') return <p className="py-8 text-center text-sm text-text-secondary">{t('teams.task.gone')}</p>
  if (!detail) {
    if (task.status === 'loading') return <Spinner />
    if (task.status === 'noReply') return <NoReply onRetry={() => void load()} />
    return <LoadFailed text={t('teams.task.loadFailed')} onRetry={() => void load()} />
  }

  const now = Date.now()
  const taskRows = needs.value ? needsOfTask(rows, taskId) : []
  const comments = [...(older?.items ?? []), ...detail.comments]
  const cursor = older ? older.cursor : detail.commentsCursor
  const showPhase = detail.column === 'doing' || detail.column === 'review'
  const live = !!detail.run && isRunLive(detail.run.state)
  return (
    <div data-task-screen={taskId} className="flex min-w-0 flex-col gap-4">
      {task.status === 'noReply' && <NoReply onRetry={() => void load()} />}
      <div className="flex min-w-0 flex-col gap-2">
        <h2 data-task-title className="text-base font-semibold text-text-primary [overflow-wrap:anywhere]">
          <span className="mr-1.5 font-mono text-xs font-normal text-text-secondary">{detail.id}</span>
          {visibleName(detail.title)}
        </h2>
        <div className="flex min-w-0 flex-wrap gap-1">
          {detail.column && <Chip>{t(COL_KEY[detail.column])}</Chip>}
          {showPhase && <Chip tone={USER_PHASES.has(detail.phase) ? 'action' : undefined}>{t(PHASE_KEY[detail.phase])}</Chip>}
          <Chip>{t(PRIO_KEY[detail.priority])}</Chip>
          <Chip>{detail.assignee ? visibleName(detail.assignee) : t('teams.card.unassigned')}</Chip>
          {detail.reviewInfo.round > 0 && <Chip>{t('teams.task.reviewRound', { round: detail.reviewInfo.round, max: detail.reviewInfo.max })}</Chip>}
          {detail.reviewInfo.lastVerdict && <Chip>{t(detail.reviewInfo.lastVerdict === 'approve' ? 'teams.task.verdict.approve' : 'teams.task.verdict.changes')}</Chip>}
          {live && detail.run && (
            <Chip tone="working">
              <Loader2 size={11} className="spin" aria-hidden />
              {t('teams.card.running', { agent: visibleName(detail.run.agentId) })}
            </Chip>
          )}
        </div>
        {detail.blocked && (
          <p data-task-blocked className="rounded-btn border border-state-action/40 bg-state-action/10 px-3 py-2 text-xs text-text-primary [overflow-wrap:anywhere]">
            {blockedText(detail.blocked)}
          </p>
        )}
      </div>

      {taskRows.length > 0 && needs.value && (
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className={SECTION_TITLE}>{t('teams.card.needs')}</h3>
          {taskRows.map((row) => (
            <NeedCard key={row.id} teamId={teamId} row={row} needs={needs.value as NonNullable<typeof needs.value>} showTask={false} onDone={(id) => hide([id])} onStale={() => void reloadNeeds()} />
          ))}
        </section>
      )}

      <section className="flex min-w-0 flex-col gap-1">
        <h3 className={SECTION_TITLE}>{t('teams.task.description')}</h3>
        {detail.body.trim() ? (
          <div className="min-w-0 rounded-btn border border-border bg-bg-secondary px-3 py-2">
            <Folded data-task-body text={visibleText(detail.body)} markdown cut={!!detail.truncated?.body} />
          </div>
        ) : (
          <p className="px-1 text-sm text-text-secondary">{t('teams.task.noDescription')}</p>
        )}
      </section>

      {detail.plan && (
        <section data-task-plan className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className={clsx(SECTION_TITLE, 'flex-1')}>{t('teams.plan.section')}</h3>
            <span className="shrink-0 text-[11px] text-text-secondary">{planStatus(detail.plan)}</span>
          </div>
          {detail.plan.status === 'pending' && detail.plan.small && <p className="px-1 text-[11px] text-text-secondary">{t('teams.plan.leadHint')}</p>}
          <div className="min-w-0 rounded-btn border border-border bg-bg-secondary px-3 py-2">
            <Folded text={visibleText(detail.plan.text)} markdown cut={!!detail.plan.truncated || !!detail.truncated?.plan} />
          </div>
        </section>
      )}

      <section className="flex min-w-0 flex-col gap-1">
        <h3 className={SECTION_TITLE}>{t('teams.task.section.activity')}</h3>
        {detail.runs.length === 0 ? (
          <p className="px-1 text-sm text-text-secondary">{t('teams.task.noRuns')}</p>
        ) : (
          detail.runs.map((run) => (
            <button
              key={run.id}
              type="button"
              data-task-run={run.id}
              onClick={() => setRunSheet(run.id)}
              className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-left active:bg-card"
            >
              {isRunLive(run.state) && <Loader2 size={13} className="spin shrink-0 text-state-working" aria-hidden />}
              <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{t('teams.task.runLine', { agent: visibleName(run.agentId), mode: t(MODE_KEY[run.mode] ?? 'teams.mode.free') })}</span>
              <span className="shrink-0 text-[11px] text-text-secondary">{t(RUN_STATE_KEY[run.state] ?? 'teams.run.state.running')}</span>
              <span className="shrink-0 text-[11px] text-text-secondary">{relativeAge(run.startedAt ?? run.queuedAt, now)}</span>
              <ChevronRight size={14} className="shrink-0 text-text-secondary" aria-hidden />
            </button>
          ))
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className={SECTION_TITLE}>{t('teams.task.section.comments')}</h3>
        {detail.commentsArchived > 0 && !cursor && <p className="px-1 text-[11px] text-text-secondary">{t('teams.comment.archived', { count: detail.commentsArchived })}</p>}
        {cursor && (
          <button type="button" data-comments-older disabled={olderBusy} onClick={() => void loadOlder()} className={GHOST_BTN}>
            {olderBusy && <Loader2 size={16} className="spin" />}
            {olderBusy ? t('teams.comment.loadingOlder') : t('teams.comment.older')}
          </button>
        )}
        {olderFailed && <p className="px-1 text-[11px] text-state-error">{t('teams.comment.olderFailed')}</p>}
        {comments.length === 0 && <p className="px-1 text-sm text-text-secondary">{t('teams.comment.empty')}</p>}
        {comments.map((c) => (
          <CommentRow key={c.id} c={c} now={now} />
        ))}
      </section>

      {/* The composer stays at the bottom of the screen while the task scrolls under it. */}
      <div className="sticky bottom-0 -mx-4 border-t border-border bg-bg-primary px-4 pb-1 pt-2">
        <Composer
          owner={MIC_OWNER}
          value={text}
          onChange={setText}
          onSend={() => void send()}
          sending={sending}
          label={t('teams.comment.label')}
          placeholder={t('teams.comment.placeholder')}
          sendLabel={t('teams.comment.send')}
          sendingLabel={t('teams.comment.sending')}
          maxLength={COMMENT_TEXT_MAX}
          error={error}
          resetKey={taskId}
          sendAttr="data-task-comment-send"
          fieldAttr="data-task-comment-text"
        />
      </div>
      <RunLogSheet teamId={teamId} runId={runSheet} onClose={() => setRunSheet(null)} />
    </div>
  )
}

export function TaskScreen(): ReactNode {
  const task = useTeamsUi((s) => s.task)
  const [title, setTitle] = useState<{ key: string; title: string } | null>(null)
  const key = task ? `${task.teamId}/${task.taskId}` : null
  const shown = title && title.key === key ? `${task?.taskId} ${visibleName(title.title)}` : (task?.taskId ?? '')
  return (
    <PushScreen id="team-task" open={task != null} onClose={closeTeamTask} title={shown} toastBottom={COMPOSER_CLEARANCE_PX}>
      {task && key && <TaskBody key={key} teamId={task.teamId} taskId={task.taskId} onTitle={(value) => setTitle({ key, title: value })} />}
    </PushScreen>
  )
}
