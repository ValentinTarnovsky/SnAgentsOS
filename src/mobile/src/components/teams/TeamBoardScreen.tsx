/**
 * A team's board on the phone (app 2.7.0, E10 B8): the columns as tabs with
 * their counts (in a row of their own that scrolls sideways), one column's
 * tasks at a time, paged by the PC (`board {column, cursor}`, "Cargar más"),
 * and read-only chips for what is set on the PC (manual dispatch, paused, a
 * definition to review). The header opens "Te necesita" (with its count, the
 * desktop's) and the Lead chat; the + creates a task. A change of the team's
 * board on the PC reloads the column shown, as many rows as "Cargar más"
 * had loaded (boardReloadLimit).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Bell, Loader2, MessageCircle, Monitor, Pause, Pin, Plus, ShieldAlert, Users } from 'lucide-react'
import { BOARD_COLUMNS, type BoardColumn } from '@shared/teams'
import { TEAM_BOARD_PAGE, type PhoneTeamListItem, type TaskSummary } from '@shared/team-protocol'
import { PushScreen } from '../PushScreen'
import { NoReply } from '../NoReply'
import { FAB_CLEARANCE_PX } from '../home/Fab'
import { NewTaskSheet } from './NewTaskSheet'
import { Chip, GHOST_BTN, LoadFailed, Spinner, loadStatusOf, useTeamChange, type Load } from './TeamBits'
import { blockedText, COL_KEY, isRunLive, PHASE_KEY, PRIO_KEY, refusalOf, replyOf, visibleName } from './teamText'
import { client } from '../../lib/client'
import { closeTeamBoard, openLeadChat, openTeamNeeds, openTeamTask, setTeamColumn, useTeamsUi } from '../../lib/teamsStore'
import { t } from '../../lib/i18n'

interface ColumnPage {
  tasks: TaskSummary[]
  cursor: string | null
  done: boolean
}

/** Phases that wait on the user: their chip is amber (with its words, never color alone). */
const USER_PHASES = new Set(['planApproval', 'userOk'])

/** The most `board.limit` main's schema takes (team-protocol-schemas boardReq): more costs the session a strike. */
const BOARD_LIMIT_MAX = 500

/**
 * The `limit` a reload of a column asks for once "Cargar más" ran: as many
 * rows as are shown (never fewer than a first page), capped by a full page
 * per page loaded and by main's maximum; undefined (the first page as usual)
 * while only the first page was loaded.
 */
export function boardReloadLimit(rows: number, pages: number): number | undefined {
  if (pages <= 1) return undefined
  return Math.min(BOARD_LIMIT_MAX, TEAM_BOARD_PAGE * pages, Math.max(rows, TEAM_BOARD_PAGE))
}

function TaskRow({ teamId, task }: { teamId: string; task: TaskSummary }): ReactNode {
  const live = !!task.run && isRunLive(task.run.state)
  const showPhase = task.column === 'doing' || task.column === 'review'
  return (
    <button
      type="button"
      data-team-task-row={task.id}
      data-task-state={task.state}
      data-task-phase={task.phase}
      onClick={() => openTeamTask(teamId, task.id)}
      className="flex min-h-[56px] w-full min-w-0 flex-col gap-1 rounded-card border border-border bg-bg-secondary px-3 py-2 text-left active:bg-card"
    >
      <span className="flex w-full min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-mono text-[11px] text-text-secondary">{task.id}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{visibleName(task.title)}</span>
        {task.needs > 0 && (
          <span data-task-needs className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-state-action">
            <span className="h-2 w-2 rounded-full bg-state-action" aria-hidden />
            {t('teams.card.needs')}
          </span>
        )}
      </span>
      <span className="flex w-full min-w-0 flex-wrap items-center gap-1">
        {showPhase && <Chip tone={USER_PHASES.has(task.phase) ? 'action' : undefined}>{t(PHASE_KEY[task.phase])}</Chip>}
        {/* A priority is no state: its chip stays neutral (STYLEGUIDE 9), like the desktop's card. */}
        {(task.priority === 'urgent' || task.priority === 'high') && <Chip>{t(PRIO_KEY[task.priority])}</Chip>}
        <Chip>
          <Users size={11} aria-hidden />
          <span className="truncate">{task.assignee ? visibleName(task.assignee) : t('teams.card.unassigned')}</span>
        </Chip>
        {live && task.run && (
          <Chip tone="working" data-task-running="true">
            <Loader2 size={11} className="spin" aria-hidden />
            <span className="truncate">{t('teams.card.running', { agent: visibleName(task.run.agentId) })}</span>
          </Chip>
        )}
        {task.review && task.review.round > 0 && <Chip>{t('teams.card.qaRound', { round: task.review.round, max: task.review.max })}</Chip>}
        {task.comments > 0 && <Chip>{task.comments === 1 ? t('teams.card.commentsOne') : t('teams.card.comments', { count: task.comments })}</Chip>}
        {task.queued > 0 && <Chip data-task-queued={task.queued}>{t('teams.card.queued', { count: task.queued })}</Chip>}
        {task.userOwned.length > 0 && (
          <span title={t('teams.card.userOwned')} aria-label={t('teams.card.userOwned')} className="text-text-secondary">
            <Pin size={13} aria-hidden />
          </span>
        )}
      </span>
      {task.blocked && <span className="w-full min-w-0 text-[11px] text-text-secondary [overflow-wrap:anywhere]">{blockedText(task.blocked)}</span>}
    </button>
  )
}

/** What is set on the PC and only shown here: manual dispatch, a pause, a definition to review. */
function BoardChips({ item }: { item: PhoneTeamListItem | undefined }): ReactNode {
  if (!item) return null
  const chips: ReactNode[] = []
  if (item.trust !== 'trusted')
    chips.push(
      <Chip key="review" tone="action" data-board-chip="review">
        <ShieldAlert size={11} aria-hidden />
        {t('teams.chip.review')}
      </Chip>,
    )
  if (item.paused)
    chips.push(
      <Chip key="paused" data-board-chip="paused">
        <Pause size={11} aria-hidden />
        {t('teams.chip.paused')}
      </Chip>,
    )
  if (!item.autoDispatch)
    chips.push(
      <Chip key="manual" data-board-chip="manual">
        <Monitor size={11} aria-hidden />
        {t('teams.chip.manual')}
      </Chip>,
    )
  return chips.length > 0 ? <div className="flex flex-wrap gap-1">{chips}</div> : null
}

export function TeamBoardBody({ teamId }: { teamId: string }): ReactNode {
  const column = useTeamsUi((s) => s.column)
  const item = useTeamsUi((s) => s.list?.find((x) => x.id === teamId))
  const [page, setPage] = useState<Load<ColumnPage>>({ status: 'loading', value: null })
  const [counts, setCounts] = useState<Record<BoardColumn, number> | null>(null)
  const [more, setMore] = useState(false)
  const [agents, setAgents] = useState<string[]>([])
  const [newOpen, setNewOpen] = useState(false)
  const seq = useRef(0)
  const seen = useRef(new Set<string>())
  /** Pages of this column loaded so far (the first and each "Cargar más"), and the rows they show. */
  const pages = useRef(0)
  const shown = useRef(0)
  shown.current = page.value?.tasks.length ?? 0

  const learn = (tasks: readonly TaskSummary[]): void => {
    let grew = false
    for (const task of tasks) {
      for (const id of [task.assignee, task.run?.agentId]) {
        if (id && !seen.current.has(id)) {
          seen.current.add(id)
          grew = true
        }
      }
    }
    if (grew) setAgents([...seen.current].sort())
  }

  /** The column from its start: the first page, or (`keep`, a change on the PC) as many rows as the user loaded. */
  const load = useCallback(async (keep = false): Promise<void> => {
    const n = ++seq.current
    const limit = keep ? boardReloadLimit(shown.current, pages.current) : undefined
    const out = await client.requestTeam({ op: 'board', teamId, column, ...(limit !== undefined ? { limit } : {}) })
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      const status = loadStatusOf(refusalOf(out))
      setPage((cur) => ({ status, value: status === 'gone' ? null : cur.value }))
      return
    }
    const p = ok.page
    if (!keep || pages.current === 0) pages.current = 1
    setCounts(p.counts)
    learn(p.tasks)
    setPage({ status: 'ok', value: { tasks: p.tasks, cursor: p.cursor, done: p.done } })
  }, [teamId, column])

  // Another column (or team): its first page, from nothing.
  useEffect(() => {
    pages.current = 0
    setPage({ status: 'loading', value: null })
    setMore(false)
    void load()
  }, [load])

  // A change on the PC that touches the board reloads the column shown, keeping what "Cargar más" loaded (the list keeps showing meanwhile).
  useTeamChange(teamId, 'board', undefined, () => void load(true))

  const loadMore = async (): Promise<void> => {
    const cur = page.value
    if (!cur?.cursor || more) return
    const n = seq.current
    setMore(true)
    const out = await client.requestTeam({ op: 'board', teamId, column, cursor: cur.cursor })
    setMore(false)
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      // A socket that was down keeps the page as it is (the reconnect reads the column again).
      const status = loadStatusOf(refusalOf(out))
      if (status !== 'loading') setPage((p) => ({ ...p, status }))
      return
    }
    const known = new Set(cur.tasks.map((x) => x.id))
    pages.current++
    setCounts(ok.page.counts)
    learn(ok.page.tasks)
    setPage({ status: 'ok', value: { tasks: [...cur.tasks, ...ok.page.tasks.filter((x) => !known.has(x.id))], cursor: ok.page.cursor, done: ok.page.done } })
  }

  if (page.status === 'gone') return <p className="py-8 text-center text-sm text-text-secondary">{t('teams.board.gone')}</p>
  const total = counts ? BOARD_COLUMNS.reduce((sum, c) => sum + (counts[c] ?? 0), 0) : null
  const tasks = page.value?.tasks ?? []
  return (
    <div data-team-board={teamId} className="flex min-w-0 flex-col gap-3" style={{ paddingBottom: FAB_CLEARANCE_PX }}>
      <BoardChips item={item} />
      <div role="tablist" aria-label={t('teams.board.columns')} data-scrollable data-board-tabs className="flex min-w-0 gap-1.5 overflow-x-auto pb-1">
        {BOARD_COLUMNS.map((col) => (
          <button
            key={col}
            type="button"
            role="tab"
            aria-selected={col === column}
            data-board-tab={col}
            data-tab-count={counts ? counts[col] ?? 0 : undefined}
            onClick={() => setTeamColumn(col)}
            className={clsx(
              'flex h-11 shrink-0 items-center gap-1.5 rounded-btn border px-3 text-sm',
              col === column ? 'border-accent-violet bg-accent-violet/15 font-semibold text-text-primary' : 'border-border bg-bg-secondary text-text-secondary active:bg-card',
            )}
          >
            {t(COL_KEY[col])}
            {counts && <span className="tabular-nums text-xs text-text-secondary">{counts[col] ?? 0}</span>}
          </button>
        ))}
      </div>
      {page.status === 'noReply' && <NoReply onRetry={() => void load(true)} />}
      {page.status === 'failed' && <LoadFailed text={t('teams.board.loadFailed')} onRetry={() => void load(true)} />}
      {!page.value && page.status === 'loading' && <Spinner />}
      {page.value && tasks.length === 0 && (
        <div data-board-empty className="flex flex-col items-center gap-1 px-6 py-8 text-center">
          <p className="text-sm text-text-secondary">{total === 0 ? t('teams.board.empty') : t('teams.board.columnEmpty')}</p>
          {total === 0 && <p className="text-xs text-text-secondary/80">{t('teams.board.emptyPhone')}</p>}
        </div>
      )}
      <div data-board-list className="flex min-w-0 flex-col gap-2">
        {tasks.map((task) => (
          <TaskRow key={task.id} teamId={teamId} task={task} />
        ))}
      </div>
      {page.value && page.value.cursor && !page.value.done && (
        <button type="button" data-board-more disabled={more} onClick={() => void loadMore()} className={GHOST_BTN}>
          {more && <Loader2 size={16} className="spin" />}
          {t('teams.board.more')}
        </button>
      )}
      <button
        type="button"
        data-board-fab
        onClick={() => setNewOpen(true)}
        aria-label={t('teams.task.new')}
        className="fixed z-10 flex h-14 w-14 items-center justify-center rounded-full bg-accent-violet text-white shadow-lg ring-1 ring-black/10 active:brightness-110"
        style={{ right: 'calc(16px + env(safe-area-inset-right))', bottom: 'calc(16px + env(safe-area-inset-bottom))' }}
      >
        <Plus size={26} />
      </button>
      <NewTaskSheet open={newOpen} onClose={() => setNewOpen(false)} teamId={teamId} teamName={item?.name ?? ''} agents={agents} onCreated={() => void load(true)} />
    </div>
  )
}

export function TeamBoardScreen(): ReactNode {
  const teamId = useTeamsUi((s) => s.boardFor)
  const item = useTeamsUi((s) => (s.boardFor ? s.list?.find((x) => x.id === s.boardFor) : undefined))
  const needs = item?.needsCount ?? 0
  const actions = teamId ? (
    <>
      <button
        type="button"
        data-board-needs={needs}
        onClick={() => openTeamNeeds(teamId)}
        aria-label={needs > 0 ? t('teams.row.needs', { count: needs }) : t('teams.board.needs')}
        className="relative flex h-11 w-11 items-center justify-center rounded-btn text-text-secondary active:bg-card"
      >
        <Bell size={20} aria-hidden />
        {needs > 0 && (
          <span aria-hidden className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-state-error px-1 text-[10px] font-semibold text-white">
            {needs}
          </span>
        )}
      </button>
      <button type="button" data-board-lead onClick={() => openLeadChat(teamId)} aria-label={t('teams.board.lead')} className="flex h-11 w-11 items-center justify-center rounded-btn text-text-secondary active:bg-card">
        <MessageCircle size={20} aria-hidden />
      </button>
    </>
  ) : undefined
  return (
    <PushScreen id="team-board" open={teamId != null} onClose={closeTeamBoard} title={item ? visibleName(item.name) : t('teams.home.title')} actions={actions} toastBottom={FAB_CLEARANCE_PX}>
      {teamId && <TeamBoardBody key={teamId} teamId={teamId} />}
    </PushScreen>
  )
}
