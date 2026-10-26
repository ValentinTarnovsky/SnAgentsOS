import { memo, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { ArrowRightLeft, Ban, GitBranch, MessageSquare, Pin, Play, Unlock } from 'lucide-react'
import { TASK_PRIORITIES, isActiveRun, type BoardColumn, type TaskPriority } from '@shared/teams'
import type { AgentView, CardView, TaskSummary, TeamFail, TeamError } from '@shared/team-protocol'
import { columnKey, columnOf, dropVerdict, phaseKey, phaseWaitsOnUser, priorityKey, type DropRefusal } from '@shared/teamBoard'
import { useLang, useT, type MessageKey, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { openTaskDrawer, useTeamsStore } from '@/lib/teamsStore'
import { cancelTask, moveTask, releaseOwned, runNowAgentOf, useBoardStore } from '@/lib/teams/board'
import { useNeedsStore } from '@/lib/teams/needs'
import { agentLabel, runFailText, runNow } from '@/lib/teams/roster'
import { visibleName } from '@/lib/teams/issues'
import { StatusGlyph } from '@/components/ui/StatusDot'
import { Tooltip } from '@/components/ui/Tooltip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import type { ContextMenuItem } from '@/components/ui/ContextMenu'
import { RunSilenceChip } from './AgentCard'

/** The MIME of a card drag; the payload is `{nonce, teamId, taskId}` (a drop accepts only this renderer's nonce). */
export const TASK_DRAG_MIME = 'application/x-snaos-task'

export const CHIP = 'inline-flex max-w-full items-center gap-1 rounded border px-1 text-[10px] leading-4'
export const CHIP_NEUTRAL = 'border-border text-text-secondary'
export const CHIP_AMBER = 'border-state-action/60 bg-state-action/15 text-state-action'

export const DROP_KEY: Record<DropRefusal, MessageKey> = {
  phaseColumn: 'teams.drop.phaseColumn',
  same: 'teams.drop.same',
  cancelled: 'teams.drop.cancelled',
}

const FAIL_KEY: Partial<Record<TeamError, MessageKey>> = {
  conflict: 'teams.task.fail.conflict',
  running: 'teams.task.fail.running',
  stopping: 'teams.task.fail.stopping',
  not_found: 'teams.task.fail.not_found',
  cycle: 'teams.task.fail.cycle',
  cap: 'teams.task.fail.cap',
  too_big: 'teams.task.fail.too_big',
  bad_request: 'teams.task.fail.bad_request',
  busy: 'teams.task.fail.busy',
  disabled: 'teams.task.fail.disabled',
  unsupported: 'teams.task.fail.unsupported',
  untrusted: 'teams.task.fail.untrusted',
}

/** Ids of a loop a refusal names before "and N more" (main caps TeamFail.loop at the same count). */
const LOOP_SHOWN_MAX = 20

/**
 * A blocker loop main refused (`cycle`, app 2.7.0, E10 B4) with the tasks that close it, from TeamFail.loop and
 * loopMore (never `detail`): "t-3 → t-5 → t-3", each id with its hiding characters spelled out. Null without a loop.
 */
function cycleLoopText(f: TeamFail, t: TFn): string | null {
  const ids = Array.isArray(f.loop) ? f.loop.filter((id): id is string => typeof id === 'string' && id !== '') : []
  if (ids.length === 0) return null
  const shown = ids.slice(0, LOOP_SHOWN_MAX)
  const more = (typeof f.loopMore === 'number' && Number.isSafeInteger(f.loopMore) && f.loopMore > 0 ? f.loopMore : 0) + ids.length - shown.length
  const loop = shown.map(visibleName).join(' → ')
  return more > 0 ? t('teams.task.fail.cycleLoopMore', { loop, count: more }) : t('teams.task.fail.cycleLoop', { loop })
}

/** A refused task write in the catalog's words (never main's detail). */
export function taskFailText(f: TeamFail, t: TFn): string {
  const loop = f.error === 'cycle' ? cycleLoopText(f, t) : null
  if (loop) return loop
  const key = FAIL_KEY[f.error]
  return key ? t(key) : t('teams.task.fail.other')
}

/**
 * A refused Retomar (`resumeTask`, B4): a task that no longer waits for it (no longer stopped, or B5 no longer
 * blocked on that card) says so, the rest as any task write.
 */
export function resumeFailText(f: TeamFail, t: TFn): string {
  if (f.error === 'conflict') return t('teams.task.resumeFail.conflict')
  const key = FAIL_KEY[f.error]
  return key ? t(key) : t('teams.task.resumeFail.other')
}

/** "Dev 2" for an agent of the roster, the id when the roster does not have it (yet). */
export function agentNameOf(agents: Readonly<Record<string, AgentView>>, id: string): string {
  const a = agents[id]
  return a ? agentLabel(a) : id
}

/** Why a task is blocked, as its card and drawer word it; null when it is not. */
export function blockedText(task: Pick<TaskSummary, 'blocked'>, t: TFn): string | null {
  const b = task.blocked
  if (!b) return null
  switch (b.kind) {
    case 'deps':
      return b.waitingOn && b.waitingOn.length > 0 ? t('teams.blocked.deps', { tasks: b.waitingOn.join(', ') }) : t('teams.blocked.depsNone')
    case 'user':
      // Who parked it: the Lead's `team task update --state blocked`, else the user's own move.
      if (b.by === 'lead') return b.text ? t('teams.blocked.leadText', { text: b.text }) : t('teams.blocked.lead')
      return b.text ? t('teams.blocked.userText', { text: b.text }) : t('teams.blocked.user')
    case 'stopped':
      return t('teams.blocked.stopped')
    default:
      return t('teams.blocked.card')
  }
}

/**
 * A task blocked on a card that is closed (B5: a prep failure card the user dismissed): it waits for Retomar, its
 * card answers nothing any more. `cards` are the cards to look in, only open ones count (the drawer's
 * TaskDetail.cards, the board's Te necesita view). The blocking card is TaskBlockedView.cardId; from a main that
 * does not name it, the task's open system card of the block's reason. Another open card of the task (an orphan
 * process, a question) blocks nothing.
 */
export function cardBlockClosed(task: Pick<TaskSummary, 'id' | 'blocked'>, cards: readonly CardView[]): boolean {
  const b = task.blocked
  if (b?.kind !== 'card') return false
  const id = b.cardId
  return !cards.some((c) => c.state === 'open' && (id ? c.id === id : c.taskId === task.id && c.system?.why === b.why))
}

/**
 * cardBlockClosed for a board card: from the team's Te necesita view (every open card) once it is at least as new
 * as the board page, so a card the page already holds never reads closed from an older view; before that, from the
 * summary's own count (no row of the task waits there).
 */
function useCardBlockClosed(task: TaskSummary): boolean {
  const card = task.blocked?.kind === 'card'
  const teamId = useTeamsStore((s) => (card ? s.openTeamId : null))
  const pageRev = useBoardStore((s) => (teamId ? s.pages[teamId]?.rev : undefined))
  const fromView = useNeedsStore((s) => {
    const n = teamId ? s.needs[teamId] : undefined
    return n && pageRev !== undefined && n.rev >= pageRev ? cardBlockClosed(task, n.cards) : null
  })
  return card && (fromView ?? task.needs === 0)
}

/**
 * Who "Ejecutar ahora" runs a task with, in the drawer and the card menu (app
 * 2.7.0, E10 B4): the agent its phase runs (runNowAgentOf: the assignee, or
 * the QA agent in qa), while that agent is idle, not retired nor in a console,
 * and no run of the task is live (a QA run of it counts too). Undefined: the
 * action is not offered (main's runManual would refuse it).
 */
export function taskRunner(task: Pick<TaskSummary, 'state' | 'phase' | 'assignee' | 'run'>, agents: Readonly<Record<string, AgentView>>, qaAgentId?: string): AgentView | undefined {
  if (task.run && isActiveRun(task.run.state)) return undefined
  const id = runNowAgentOf(task, qaAgentId)
  const a = id ? agents[id] : undefined
  return a && a.status === 'idle' && !a.retired && !a.takeover ? a : undefined
}

/** The columns a user may move a card to (the rest belong to the flow). */
export const MOVE_TARGETS: readonly ('todo' | 'blocked' | 'done')[] = ['todo', 'blocked', 'done']

type Ask =
  | { kind: 'stopsRun' | 'dropsPlan' | 'unintegrated'; task: TaskSummary; to: BoardColumn; band?: TaskPriority }
  | { kind: 'cancel'; task: TaskSummary }

export interface TaskActions {
  /** A drop or "Mover a": refused -> the reason in a toast; a confirm first when the verdict asks for one. */
  move: (task: TaskSummary, to: BoardColumn, band?: TaskPriority) => void
  /** "Cancelar tarea", after its confirm (which says the run stops when one is live). */
  cancel: (task: TaskSummary) => void
  /** The card menu (Shift+F10, right click, the kebab): the same moves as a drag, so the keyboard can do all of it. */
  menuItems: (task: TaskSummary, o?: { open?: boolean }) => ContextMenuItem[]
  /** The confirms; render once where the actions are used. */
  dialogs: ReactNode
}

/**
 * The moves of a task (app 2.7.0, E10 B3), shared by the board and the task
 * drawer: every one goes through dropVerdict (the same rules as a drag), a
 * live run asks first and is stopped by main (`stopRun`), a refusal from main
 * rolls the card back and says why.
 */
export function useTaskActions(teamId: string, agents: Readonly<Record<string, AgentView>>): TaskActions {
  const t = useT()
  const lang = useLang()
  const [ask, setAsk] = useState<Ask | null>(null)

  const perform = (task: TaskSummary, to: BoardColumn, band: TaskPriority | undefined, stop: boolean): void => {
    void moveTask(teamId, task, to, band, stop).then((fail) => {
      if (fail) toast.error(taskFailText(fail, t))
    })
  }
  const move = (task: TaskSummary, to: BoardColumn, band?: TaskPriority): void => {
    const v = dropVerdict(task, to, band)
    if (!v.ok) {
      if (v.reason !== 'same') toast.warning(t(DROP_KEY[v.reason]))
      return
    }
    if (v.confirm) setAsk({ kind: v.confirm, task, to, band })
    else perform(task, to, band, false)
  }
  const cancel = (task: TaskSummary): void => setAsk({ kind: 'cancel', task })
  const live = (task: TaskSummary): boolean => !!task.run && isActiveRun(task.run.state)

  const menuItems = (task: TaskSummary, o?: { open?: boolean }): ContextMenuItem[] => {
    const items: ContextMenuItem[] = []
    if (o?.open !== false) items.push({ label: t('teams.task.open'), onClick: () => openTaskDrawer(task.id) })
    MOVE_TARGETS.forEach((to, i) => {
      const v = dropVerdict(task, to)
      items.push({
        label: t('teams.task.moveTo', { column: t(columnKey(to)) }),
        icon: ArrowRightLeft,
        separated: i === 0 && items.length > 0,
        disabled: !v.ok,
        hint: v.ok ? undefined : t(DROP_KEY[v.reason]),
        onClick: () => move(task, to),
      })
    })
    const col = columnOf(task)
    TASK_PRIORITIES.forEach((p, i) => {
      items.push({
        label: t('teams.task.priority', { priority: t(priorityKey(p)) }),
        checked: task.priority === p,
        separated: i === 0,
        disabled: task.state === 'cancelled' || !col,
        onClick: () => {
          if (col && p !== task.priority) move(task, col, p)
        },
      })
    })
    const extra: ContextMenuItem[] = []
    // The drawer's rule (taskRunner); in qa the QA agent the summary names (B5: `review.qaAgentId`), no detail needed.
    const runner = taskRunner(task, agents, task.review?.qaAgentId)
    if (runner) {
      extra.push({
        label: t('teams.task.runNow'),
        icon: Play,
        onClick: () => {
          void runNow(teamId, runner.id, undefined, task.id).then((fail) => {
            if (fail) toast.error(runFailText(fail, agentLabel(runner), t, lang, Date.now()))
            else toast.success(t('teams.task.runStarted'))
          })
        },
      })
    }
    if (task.userOwned.length > 0) {
      extra.push({
        label: t('teams.task.release'),
        icon: Unlock,
        onClick: () => {
          void releaseOwned(teamId, task.id, task.userOwned).then((fail) => {
            if (fail) toast.error(taskFailText(fail, t))
            else toast.success(t('teams.task.released'))
          })
        },
      })
    }
    extra.forEach((item, i) => items.push({ ...item, separated: i === 0 }))
    if (task.state !== 'cancelled' && task.state !== 'done') items.push({ label: t('teams.task.cancel'), icon: Ban, danger: true, separated: true, onClick: () => cancel(task) })
    return items
  }

  let dialogs: ReactNode = null
  if (ask) {
    const runAgent = ask.task.run ? agentNameOf(agents, ask.task.run.agentId) : ''
    const close = (): void => setAsk(null)
    if (ask.kind === 'cancel') {
      const stop = live(ask.task)
      dialogs = (
        <ConfirmDialog
          open
          danger
          title={t('teams.task.cancelTitle', { id: ask.task.id })}
          message={stop ? t('teams.task.cancelMsgRun', { agent: runAgent }) : t('teams.task.cancelMsg')}
          confirmLabel={t('teams.task.cancelYes')}
          cancelLabel={t('teams.task.keep')}
          onConfirm={() => {
            const task = ask.task
            close()
            void cancelTask(teamId, task, stop).then((fail) => {
              if (fail) toast.error(taskFailText(fail, t))
            })
          }}
          onCancel={close}
        />
      )
    } else {
      const text: Record<'stopsRun' | 'dropsPlan' | 'unintegrated', { title: string; msg: string; yes: string }> = {
        stopsRun: { title: t('teams.drop.stopsRunTitle', { id: ask.task.id }), msg: t('teams.drop.stopsRunMsg', { agent: runAgent }), yes: t('teams.drop.stopsRunYes') },
        dropsPlan: { title: t('teams.drop.dropsPlanTitle'), msg: t('teams.drop.dropsPlanMsg'), yes: t('teams.drop.dropsPlanYes') },
        unintegrated: { title: t('teams.drop.unintegratedTitle'), msg: t('teams.drop.unintegratedMsg'), yes: t('teams.drop.unintegratedYes') },
      }
      const w = text[ask.kind]
      dialogs = (
        <ConfirmDialog
          open
          danger={ask.kind === 'stopsRun'}
          title={w.title}
          message={w.msg}
          confirmLabel={w.yes}
          cancelLabel={t('common.cancel')}
          onConfirm={() => {
            const a = ask
            close()
            perform(a.task, a.to, a.band, a.kind === 'stopsRun')
          }}
          onCancel={close}
        />
      )
    }
  }
  return { move, cancel, menuItems, dialogs }
}

export interface TaskCardProps {
  task: TaskSummary
  /** The assignee's label (null: nobody yet). */
  assigneeName: string | null
  /** The live run's agent label, while one runs. */
  runName: string | null
  selected: boolean
  /** The card that holds the board's tab stop (roving tabIndex). */
  tabbable: boolean
  onSelect: (taskId: string) => void
  onMenu: (task: TaskSummary, x: number, y: number) => void
  onDragStart: (task: TaskSummary, e: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

/**
 * One card of the Tablero (app 2.7.0, E10 B3): id and title; the phase (amber
 * while it waits on the user), the assignee, the live run (B7: and its silence,
 * the chip alone: its ignore button lives on the agent's card), the QA round, why
 * it is blocked, its branch, comments and queued ones, a dot when it needs
 * the user and the pin when the user owns some of its fields. A click or
 * Enter opens the drawer; it drags natively (TASK_DRAG_MIME + the renderer's
 * nonce); Shift+F10, the context menu key and a right click open its menu.
 * Memoized on the summary object: an unchanged task does not render again.
 */
export const TaskCard = memo(function TaskCard({ task, assigneeName, runName, selected, tabbable, onSelect, onMenu, onDragStart, onDragEnd }: TaskCardProps) {
  const t = useT()
  const live = task.run && isActiveRun(task.run.state) ? task.run : undefined
  const pinned = task.userOwned.length > 0
  // Its card closed, "your answer in Te necesita" would point at nothing: Retomar is in the task's drawer.
  const blocked = useCardBlockClosed(task) ? t('teams.blocked.cardClosed') : blockedText(task, t)
  const qa = task.review && (task.phase === 'qa' || task.review.round > 0) ? Math.min(task.review.round + (task.phase === 'qa' ? 1 : 0), task.review.max) : null
  const openMenu = (e: MouseEvent<HTMLElement>): void => {
    e.preventDefault()
    onSelect(task.id)
    onMenu(task, e.clientX, e.clientY)
  }
  return (
    <article
      data-task-card={task.id}
      data-task-state={task.state}
      data-task-phase={task.phase}
      data-task-priority={task.priority}
      data-user-owned={pinned ? 'true' : 'false'}
      data-task-selected={selected ? 'true' : undefined}
      tabIndex={tabbable ? 0 : -1}
      draggable={task.state !== 'cancelled'}
      aria-label={t('teams.card.label', { id: task.id, title: task.title })}
      onClick={() => {
        onSelect(task.id)
        openTaskDrawer(task.id)
      }}
      onContextMenu={openMenu}
      onDragStart={(e) => onDragStart(task, e)}
      onDragEnd={onDragEnd}
      className={cn(
        'flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-btn border bg-card/60 px-2.5 py-2 text-left outline-none transition-colors hover:border-accent-violet/40 focus-visible:ring-1 focus-visible:ring-accent-violet/60',
        selected ? 'border-accent-violet ring-1 ring-accent-violet/40' : 'border-border',
        task.state === 'cancelled' && 'opacity-60',
      )}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <span className="shrink-0 pt-px font-mono text-[11px] text-text-secondary">{task.id}</span>
        <span data-task-title className="line-clamp-2 min-w-0 flex-1 break-words text-[13px] leading-[1.35] text-text-primary">
          {task.title}
        </span>
        {task.needs > 0 && <span data-task-needs={task.needs} role="img" aria-label={t('teams.card.needs')} className="mt-1 h-2 w-2 shrink-0 rounded-full bg-state-action ring-2 ring-state-action/30" />}
        {pinned && (
          <Tooltip label={t('teams.card.userOwned')} className="shrink-0">
            <span data-task-pinned role="img" aria-label={t('teams.card.userOwned')} className="inline-flex text-text-secondary">
              <Pin size={13} />
            </span>
          </Tooltip>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {task.state === 'cancelled' && <span className={cn(CHIP, CHIP_NEUTRAL)}>{t('teams.card.cancelled')}</span>}
        {task.phase !== 'none' && task.state !== 'done' && task.state !== 'cancelled' && (
          <span data-task-phase-chip={task.phase} className={cn(CHIP, phaseWaitsOnUser(task.phase) ? CHIP_AMBER : CHIP_NEUTRAL)}>
            {t(phaseKey(task.phase))}
          </span>
        )}
        {live && (
          <span data-task-running={live.id} className="inline-flex shrink-0 items-center">
            <StatusGlyph kind="working" size={13} label={t('teams.card.running', { agent: runName ?? live.agentId })} />
          </span>
        )}
        <span data-task-assignee={task.assignee ?? ''} className={cn('min-w-0 truncate text-[11px]', assigneeName ? 'text-text-primary/90' : 'text-text-secondary')}>
          {assigneeName ?? t('teams.card.unassigned')}
        </span>
        {qa !== null && task.review && <span data-task-qa className={cn(CHIP, CHIP_NEUTRAL, 'tabular-nums')}>{t('teams.card.qaRound', { round: qa, max: task.review.max })}</span>}
        {live && <RunSilenceChip run={live} />}
      </div>
      {blocked && (
        <p data-task-blocked={task.blocked?.kind} className="min-w-0 truncate text-[11px] text-state-action">
          {blocked}
        </p>
      )}
      {(task.branch || task.comments > 0 || task.queued > 0) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
          {task.branch && (
            <span data-task-branch className="inline-flex min-w-0 items-center gap-1" aria-label={t('teams.card.branch', { branch: task.branch })}>
              <GitBranch size={13} className="shrink-0" />
              <span className="truncate font-mono">{task.branch}</span>
            </span>
          )}
          {task.comments > 0 && (
            <span data-task-comments={task.comments} className="inline-flex shrink-0 items-center gap-1" aria-label={task.comments === 1 ? t('teams.card.commentsOne') : t('teams.card.comments', { count: task.comments })}>
              <MessageSquare size={13} />
              <span className="tabular-nums">{task.comments}</span>
            </span>
          )}
          {task.queued > 0 && (
            <span data-task-queued={task.queued} className={cn(CHIP, CHIP_NEUTRAL, 'shrink-0')}>
              {t('teams.card.queued', { count: task.queued })}
            </span>
          )}
        </div>
      )}
    </article>
  )
})
