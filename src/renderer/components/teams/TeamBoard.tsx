import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ListTodo, MessageSquare, Plus } from 'lucide-react'
import { BOARD_COLUMNS, isActiveRun, type BoardColumn as Column, type TaskPriority } from '@shared/teams'
import type { AgentView, TaskSummary, TeamView } from '@shared/team-protocol'
import { boardColumns, columnOf, filterActive, type BoardFilter } from '@shared/teamBoard'
import { useLang, useT } from '@/i18n'
import { DRAG_NONCE } from '@/lib/dragNonce'
import { openAgentDrawer, openTaskDrawer } from '@/lib/teamsStore'
import { boardTasks, loadBoard, loadMoreDone, openNewTask, setBoardFilter, useBoardStore, withOptimistic } from '@/lib/teams/board'
import { agentLabel, loadRoster, runFailText, useRosterStore } from '@/lib/teams/roster'
import { kickoff } from '@/lib/teams/needs'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { ContextMenu } from '@/components/ui/ContextMenu'
import { BoardColumn } from './BoardColumn'
import { BoardFilters } from './BoardFilters'
import { TeamEmptyTab } from './TeamEmptyTab'
import { TASK_DRAG_MIME, agentNameOf, useTaskActions } from './TaskCard'

const NO_FILTER: BoardFilter = {}
const NO_AGENTS: readonly AgentView[] = []
const SMALL = 'inline-flex h-8 items-center gap-1.5 rounded-btn border border-border px-3 text-xs font-medium text-text-primary transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60'

/** The payload of a card drag, accepted only with this renderer's nonce and a task of this team. */
function dropPayload(e: DragEvent<HTMLElement>, teamId: string): string | null {
  let raw = ''
  try {
    raw = e.dataTransfer.getData(TASK_DRAG_MIME)
  } catch {
    return null
  }
  if (!raw || raw.length > 512) return null
  try {
    const d = JSON.parse(raw) as { nonce?: unknown; teamId?: unknown; taskId?: unknown }
    return d.nonce === DRAG_NONCE && d.teamId === teamId && typeof d.taskId === 'string' ? d.taskId : null
  } catch {
    return null
  }
}

/** Scrolls one scroller (a column body, the grid) just enough to show `el` on that axis; nothing else moves. */
function revealIn(scroller: Element | null | undefined, el: HTMLElement, axis: 'x' | 'y'): void {
  if (!scroller) return
  const s = scroller.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (axis === 'y') {
    if (r.top < s.top) scroller.scrollTop -= s.top - r.top + 8
    else if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom + 8
  } else if (r.left < s.left) scroller.scrollLeft -= s.left - r.left + 8
  else if (r.right > s.right) scroller.scrollLeft += r.right - s.right + 8
}

/**
 * "Pedile al Líder que arme las tareas" (B4, decision 43): one Lead run now
 * (reason kickoff) that reads the goal and splits it into the first tasks.
 * Main applies every gate but the autonomy one; a refusal or a defer says why
 * beside the button, in words. While the Lead runs, the button waits.
 */
function KickoffCta({ teamId, view, lead }: { teamId: string; view: TeamView; lead: AgentView | null }) {
  const t = useT()
  const lang = useLang()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const role = view.roles.find((r) => r.kind === 'lead')
  const leadId = lead?.id ?? role?.id ?? null
  const name = lead ? agentLabel(lead) : (role?.name ?? '')
  const working = !!lead?.run && isActiveRun(lead.run.state)
  const go = (): void => {
    setBusy(true)
    setNote(null)
    void kickoff(teamId).then((res) => {
      setBusy(false)
      if (!res.ok) {
        setNote(runFailText(res, name, t, lang, Date.now()))
        return
      }
      const runId = res.runId
      const id = leadId
      toast.success(t('teams.kickoff.started'), id ? { actions: [{ label: t('teams.kickoff.watch'), run: () => openAgentDrawer(id, runId, 'run') }] } : undefined)
      void loadRoster(teamId)
    })
  }
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button size="sm" data-kickoff disabled={busy || working} onClick={go}>
        <ListTodo size={13} aria-hidden />
        {working ? t('teams.kickoff.busy') : t('teams.kickoff.cta')}
      </Button>
      <p className="text-[11px] text-text-secondary">{t('teams.kickoff.hint')}</p>
      {note && (
        <p data-kickoff-note role="status" className="text-xs text-state-error">
          {note}
        </p>
      )}
    </div>
  )
}

/** The empty board: what to do first, and the definition summary (goal, how it works, roles) under it. */
function EmptyBoard({ teamId, view, lead }: { teamId: string; view: TeamView; lead: AgentView | null }) {
  const t = useT()
  const leadId = lead?.id ?? null
  return (
    <div data-board-empty className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-4">
        <div className="flex flex-col items-start gap-3 rounded-card border border-border bg-card/40 px-4 py-4">
          <div>
            <p className="text-sm font-medium text-text-primary">{t('teams.board.empty')}</p>
            <p className="mt-1 text-xs text-text-secondary">{t('teams.board.emptyHint')}</p>
          </div>
          {/* B4: with a goal to read, the Lead can set up the first tasks itself. */}
          {view.goal.trim() !== '' && <KickoffCta teamId={teamId} view={view} lead={lead} />}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-board-new-task onClick={() => openNewTask(teamId)} className={SMALL}>
              <Plus size={13} aria-hidden />
              {t('teams.task.new')}
            </button>
            {leadId && (
              <button type="button" data-board-talk-lead onClick={() => openAgentDrawer(leadId, undefined, 'thread')} className={SMALL}>
                <MessageSquare size={13} aria-hidden />
                {t('teams.board.talkLead')}
              </button>
            )}
          </div>
        </div>
        <TeamEmptyTab tab="board" view={view} />
      </div>
    </div>
  )
}

/**
 * The Tablero of a team (app 2.7.0, E10 B3): the filter bar and five columns
 * (Por hacer, En curso, Revisión, Hecho, Bloqueado) derived from each task's
 * state and phase. Cards drag natively between columns and onto the priority
 * bands; En curso and Revisión refuse drops (the flow moves cards there). A
 * drop is a user move: main marks the fields it touched `userOwned` (the pin
 * on the card), a live run asks first and is stopped, a refusal rolls the
 * card back with its reason. The keyboard does the same: arrows move the
 * selection (Up/Down in a column, Left/Right across), Enter opens the task,
 * Shift+F10 or the menu key opens "Mover a" and "Prioridad". The grid
 * scrolls inside the board, each column on its own.
 */
export function TeamBoard({ teamId, view }: { teamId: string; view: TeamView }) {
  const t = useT()
  const data = useBoardStore((s) => s.pages[teamId])
  const failed = useBoardStore((s) => !!s.failed[teamId])
  const optimistic = useBoardStore((s) => s.optimistic)
  const filter = useBoardStore((s) => s.filter[teamId]) ?? NO_FILTER
  const moreLoading = useBoardStore((s) => !!s.moreLoading[teamId])
  const roster = useRosterStore((s) => s.rosters[teamId])
  const agents = roster?.agents ?? NO_AGENTS
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])) as Record<string, AgentView>, [agents])
  const actions = useTaskActions(teamId, byId)
  const [dragging, setDragging] = useState<TaskSummary | null>(null)
  const [hover, setHover] = useState<{ column: Column; band?: TaskPriority } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; task: TaskSummary } | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void loadBoard(teamId)
    if (!useRosterStore.getState().rosters[teamId]) void loadRoster(teamId)
  }, [teamId])

  const tasks = useMemo(() => withOptimistic(teamId, boardTasks(data), optimistic), [teamId, data, optimistic])
  const columns = useMemo(() => boardColumns(tasks, filter), [tasks, filter])

  // A dragged card that leaves its column meanwhile (a run moved it, main cancelled it) remounts elsewhere and its
  // dragend never reaches React: drop the drag state then, so no column stays dimmed with a stale reason.
  useEffect(() => {
    if (!dragging) return
    const now = tasks.find((x) => x.id === dragging.id)
    if (now && columnOf(now) === columnOf(dragging)) return
    setDragging(null)
    setHover(null)
  }, [tasks, dragging])
  const filtering = filterActive(filter)
  const lead = agents.find((a) => a.kind === 'lead' && !a.retired) ?? null

  // The tab stop of the board: the selected card when it shows, else the first card.
  const flat = useMemo(() => BOARD_COLUMNS.flatMap((c) => columns[c]), [columns])
  const tabStop = selected && flat.some((x) => x.id === selected) ? selected : (flat[0]?.id ?? null)

  // The card exists already (only the selection moves): it takes the focus at once, its tab stop follows on render.
  // preventScroll: a plain focus would also scroll the app's overflow-hidden root; only the board's own scrollers move.
  const focusCard = (id: string): void => {
    setSelected(id)
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-task-card="${CSS.escape(id)}"]`)
    if (!el) return
    el.focus({ preventScroll: true })
    revealIn(el.closest('[data-board-column-body]'), el, 'y')
    revealIn(gridRef.current, el, 'x')
  }

  const onSelect = useCallback((id: string) => setSelected(id), [])
  const onMenu = useCallback((task: TaskSummary, x: number, y: number) => setMenu({ task, x, y }), [])
  const onDragStart = useCallback(
    (task: TaskSummary, e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(TASK_DRAG_MIME, JSON.stringify({ nonce: DRAG_NONCE, teamId, taskId: task.id }))
      e.dataTransfer.effectAllowed = 'move'
      setSelected(task.id)
      setDragging(task)
    },
    [teamId],
  )
  const onDragEnd = useCallback(() => {
    setDragging(null)
    setHover(null)
  }, [])
  const card = useMemo(() => ({ onSelect, onMenu, onDragStart, onDragEnd }), [onSelect, onMenu, onDragStart, onDragEnd])

  const onDrop = (column: Column, band: TaskPriority | undefined, e: DragEvent<HTMLElement>): void => {
    const id = dropPayload(e, teamId)
    const task = dragging && dragging.id === id ? tasks.find((x) => x.id === id) : undefined
    setDragging(null)
    setHover(null)
    if (task) actions.move(task, column, band)
  }

  const names = (task: TaskSummary): { assignee: string | null; run: string | null } => ({
    assignee: task.assignee ? agentNameOf(byId, task.assignee) : null,
    run: task.run ? agentNameOf(byId, task.run.agentId) : null,
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = (e.target as HTMLElement).closest?.('[data-task-card]') as HTMLElement | null
    const id = el?.dataset.taskCard
    if (!id || e.altKey || e.ctrlKey || e.metaKey) return
    const task = flat.find((x) => x.id === id)
    if (!task) return
    if (e.key === 'Enter') {
      e.preventDefault()
      setSelected(id)
      openTaskDrawer(id)
      return
    }
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      setSelected(id)
      setMenu({ task, x: r.left + 12, y: r.top + Math.min(r.height, 28) })
      return
    }
    if (e.shiftKey) return
    const ci = BOARD_COLUMNS.findIndex((c) => columns[c].some((x) => x.id === id))
    if (ci < 0) return
    const list = columns[BOARD_COLUMNS[ci]]
    const ri = list.findIndex((x) => x.id === id)
    let next: string | undefined
    if (e.key === 'ArrowDown') next = list[ri + 1]?.id
    else if (e.key === 'ArrowUp') next = list[ri - 1]?.id
    else if (e.key === 'Home') next = list[0]?.id
    else if (e.key === 'End') next = list[list.length - 1]?.id
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const step = e.key === 'ArrowRight' ? 1 : -1
      for (let c = ci + step; c >= 0 && c < BOARD_COLUMNS.length; c += step) {
        const other = columns[BOARD_COLUMNS[c]]
        if (other.length) {
          next = other[Math.min(ri, other.length - 1)].id
          break
        }
      }
    } else return
    e.preventDefault()
    if (next) focusCard(next)
  }

  if (!data) {
    return failed ? (
      <div className="flex flex-col items-start gap-3" data-board-failed>
        <p className="text-sm text-text-secondary">{t('teams.board.loadFailed')}</p>
        <Button variant="ghost" size="sm" data-board-retry onClick={() => void loadBoard(teamId)}>
          {t('teams.board.retry')}
        </Button>
      </div>
    ) : (
      <p className="text-sm text-text-secondary" data-board-loading>
        {t('teams.board.loading')}
      </p>
    )
  }

  // Main counts the cancelled ones per page; a task cancelled here since then counts at once.
  const cancelled = Math.max(data.cancelled, tasks.filter((x) => x.state === 'cancelled').length)
  const empty = tasks.length === 0 && cancelled === 0 && !filtering
  const doneFooter = (
    <div className="mt-2 flex flex-col items-start gap-1">
      {!data.doneComplete && data.doneCursor && !filtering && (
        <button type="button" data-board-more-done disabled={moreLoading} onClick={() => void loadMoreDone(teamId)} className="rounded px-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-60">
          {moreLoading ? t('teams.board.loadingMore') : t('teams.board.moreDone')}
        </button>
      )}
      {(cancelled > 0 || filter.showCancelled) && (
        <button
          type="button"
          data-board-show-cancelled={filter.showCancelled ? 'on' : 'off'}
          onClick={() => setBoardFilter(teamId, { showCancelled: !filter.showCancelled })}
          className="rounded px-1 text-[11px] text-text-secondary hover:text-text-primary"
        >
          {filter.showCancelled ? t('teams.board.hideCancelled') : t('teams.board.showCancelled', { count: cancelled })}
        </button>
      )}
    </div>
  )

  return (
    <section data-team-board={teamId} aria-label={t('teams.board.label')} className="flex h-full min-h-0 flex-col gap-3">
      {empty ? (
        <EmptyBoard teamId={teamId} view={view} lead={lead} />
      ) : (
        <>
          <BoardFilters teamId={teamId} filter={filter} agents={agents} />
          {filtering && flat.length === 0 && (
            <p data-board-no-match className="shrink-0 text-xs text-text-secondary">
              {t('teams.board.noMatch')}
            </p>
          )}
          <div
            ref={gridRef}
            data-board-grid
            onKeyDown={onKeyDown}
            className="grid min-h-0 flex-1 auto-cols-[minmax(180px,1fr)] grid-flow-col gap-3 overflow-x-auto overflow-y-hidden pb-1"
          >
            {BOARD_COLUMNS.map((c) => (
              <BoardColumn
                key={c}
                column={c}
                tasks={columns[c]}
                count={filtering ? columns[c].length : c === 'done' ? Math.max(columns.done.filter((x) => x.state === 'done').length, data.counts?.done ?? 0) : columns[c].length}
                dragging={dragging}
                hover={hover?.column === c ? { band: hover.band } : null}
                selectedId={selected}
                tabStopId={tabStop}
                names={names}
                card={card}
                onHover={(column, band) => setHover((h) => (h && h.column === column && h.band === band ? h : { column, band }))}
                onLeave={(column) => setHover((h) => (h?.column === column ? null : h))}
                onDrop={onDrop}
                footer={c === 'done' ? doneFooter : undefined}
                empty={t('teams.board.columnEmpty')}
              />
            ))}
          </div>
        </>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('teams.card.menu')}
          items={actions.menuItems(menu.task)}
          onClose={() => {
            const id = menu.task.id
            setMenu(null)
            // The keyboard goes back to the card unless the item gave it to something else (the drawer, a confirm).
            setTimeout(() => {
              const a = document.activeElement
              if (!a || a === document.body || (a instanceof HTMLElement && a.hasAttribute('data-team-host'))) focusCard(id)
            }, 0)
          }}
        />
      )}
      {actions.dialogs}
    </section>
  )
}
