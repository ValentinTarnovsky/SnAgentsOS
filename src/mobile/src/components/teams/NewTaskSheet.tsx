/**
 * A new task from the phone (app 2.7.0, E10 B8): title, description with
 * dictation, assignee ("Que decida el Líder" by default, or one of the
 * agents the board names) and priority; the rest (plan, isolation, repo)
 * takes main's defaults. Created only on Crear (`createTask`); main assigns
 * the id and answers the task, the board shows it on its next load.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import { TASK_BODY_MAX, TASK_PRIORITIES, TASK_TITLE_MAX, type TaskPriority } from '@shared/teams'
import type { TaskDraft } from '@shared/team-protocol'
import { Sheet } from '../Sheet'
import { MicButton, VoiceInterim } from '../MicButton'
import { bodyProblem, lineOk, outgoingText, PRIMARY_BTN } from './TeamBits'
import { PRIO_KEY, refusalOf, replyOf, visibleName, writeFailText } from './teamText'
import { client } from '../../lib/client'
import { useRemoteStore } from '../../lib/store'
import { spaced, stopDictation } from '../../lib/voice'
import { t } from '../../lib/i18n'

const MIC_OWNER = 'teamNewTask'

export function NewTaskSheet({
  open,
  onClose,
  teamId,
  teamName,
  agents,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  teamId: string
  teamName: string
  /** Agent ids the board names (assignees, runs): the phone has no roster of its own. */
  agents: readonly string[]
  onCreated: (taskId: string) => void
}): ReactNode {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // A closed sheet starts over the next time.
  useEffect(() => {
    if (open) return
    setTitle('')
    setBody('')
    setAssignee('')
    setPriority('normal')
    setError(null)
  }, [open])

  const create = async (): Promise<void> => {
    const name = title.trim()
    if (!name) {
      setError(t('teams.task.titleRequired'))
      return
    }
    const text = outgoingText(body).trim()
    if (!lineOk(name)) {
      setError(t('teams.comment.control'))
      return
    }
    const problem = name.length > TASK_TITLE_MAX ? t('teams.comment.tooLong') : bodyProblem(text, TASK_BODY_MAX)
    if (problem) {
      setError(problem)
      return
    }
    stopDictation(MIC_OWNER, true)
    const task: TaskDraft = { title: name, priority }
    if (text) task.body = text
    if (assignee) task.assignee = assignee
    setCreating(true)
    setError(null)
    const out = await client.requestTeam({ op: 'createTask', teamId, task })
    setCreating(false)
    const ok = replyOf(out)
    if (ok) {
      useRemoteStore.getState().setToast(t('teams.task.created', { id: ok.task.id }))
      onCreated(ok.task.id)
      onClose()
      return
    }
    setError(writeFailText(refusalOf(out) ?? { error: 'io' }, 'teams.task.createFailed'))
  }

  const field = 'w-full rounded-btn border border-border bg-bg-secondary px-3 py-2 text-[15px] text-text-primary outline-none focus:border-accent-violet'
  return (
    <Sheet open={open} onClose={onClose} title={t('teams.task.newTitle', { team: visibleName(teamName) })}>
      <div data-new-task={teamId} className="flex flex-col gap-3 pb-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-secondary">{t('teams.task.title')}</span>
          <input
            data-new-task-title
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TASK_TITLE_MAX}
            placeholder={t('teams.task.titlePlaceholder')}
            enterKeyHint="next"
            className={clsx(field, 'h-11')}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-secondary">{t('teams.task.description')}</span>
          <VoiceInterim owner={MIC_OWNER} />
          <div className="flex gap-2">
            <textarea
              data-new-task-body
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              maxLength={TASK_BODY_MAX}
              aria-label={t('teams.task.description')}
              placeholder={t('teams.task.bodyPlaceholder')}
              className={clsx(field, 'min-h-[96px] min-w-0 flex-1 resize-none leading-6')}
            />
            <MicButton owner={MIC_OWNER} resetKey={teamId} onFinal={(chunk) => setBody((prev) => prev + spaced(prev, chunk))} />
          </div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-secondary">{t('teams.task.field.assignee')}</span>
          <select data-new-task-assignee value={assignee} onChange={(e) => setAssignee(e.target.value)} className={clsx(field, 'h-11')}>
            <option value="">{t('teams.task.field.leadDecides')}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {visibleName(a)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-secondary">{t('teams.task.field.priority')}</span>
          <div role="radiogroup" aria-label={t('teams.task.field.priority')} className="grid grid-cols-4 gap-1.5">
            {TASK_PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={priority === p}
                data-new-task-prio={p}
                onClick={() => setPriority(p)}
                className={clsx(
                  'flex h-11 min-w-0 items-center justify-center rounded-btn border px-1 text-xs font-medium',
                  priority === p ? 'border-accent-violet bg-accent-violet/15 text-text-primary' : 'border-border bg-bg-secondary text-text-secondary active:bg-card',
                )}
              >
                <span className="truncate">{t(PRIO_KEY[p])}</span>
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p role="alert" data-new-task-error className="text-xs text-state-error">
            {error}
          </p>
        )}
        <button type="button" data-new-task-create disabled={creating} onClick={() => void create()} className={PRIMARY_BTN}>
          {creating && <Loader2 size={16} className="spin" />}
          {creating ? t('teams.task.creating') : t('teams.task.create')}
        </button>
      </div>
    </Sheet>
  )
}
