import { Fragment, useRef, type DragEvent, type ReactNode } from 'react'
import { TASK_PRIORITIES, type BoardColumn as Column, type TaskPriority } from '@shared/teams'
import type { TaskSummary } from '@shared/team-protocol'
import { bandsOf, columnKey, dropVerdict, priorityKey } from '@shared/teamBoard'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { DROP_KEY, TASK_DRAG_MIME, TaskCard, type TaskCardProps } from './TaskCard'

export interface BoardColumnProps {
  column: Column
  tasks: TaskSummary[]
  /** What the header counts (Hecho counts every done task, loaded or not). */
  count: number
  /** The card being dragged on this board, else null. */
  dragging: TaskSummary | null
  /** This column is under the drag: the band drop zones show (and which band is under the pointer). */
  hover: { band?: TaskPriority } | null
  selectedId: string | null
  tabStopId: string | null
  names: (task: TaskSummary) => { assignee: string | null; run: string | null }
  card: Pick<TaskCardProps, 'onSelect' | 'onMenu' | 'onDragStart' | 'onDragEnd'>
  onHover: (column: Column, band: TaskPriority | undefined) => void
  onLeave: (column: Column) => void
  onDrop: (column: Column, band: TaskPriority | undefined, e: DragEvent<HTMLElement>) => void
  /** Hecho's "Ver más" and "Mostrar canceladas". */
  footer?: ReactNode
  empty: string
}

/** The band under a drag event: the `data-band-drop` zone it is over, else none (keep the priority). */
function bandOf(e: DragEvent<HTMLElement>): TaskPriority | undefined {
  const el = (e.target as Element | null)?.closest?.('[data-band-drop]')
  const v = el?.getAttribute('data-band-drop')
  return TASK_PRIORITIES.includes(v as TaskPriority) ? (v as TaskPriority) : undefined
}

/** A drag of this board's own cards (the payload is only readable on drop; the type is visible while over). */
function ownDrag(e: DragEvent<HTMLElement>, dragging: TaskSummary | null): boolean {
  return !!dragging && Array.from(e.dataTransfer?.types ?? []).includes(TASK_DRAG_MIME)
}

/**
 * One column of the Tablero (app 2.7.0, E10 B3): its header with the count,
 * the cards by priority band (a separator per band once there are two), and
 * while a card is dragged: dimmed with the reason when the drop is refused
 * (En curso and Revisión belong to the flow), else the four band zones show
 * when the drag is over it, so a drop also sets the priority. The body
 * scrolls on its own; the board never makes the page scroll.
 */
export function BoardColumn(p: BoardColumnProps) {
  const t = useT()
  const depth = useRef(0)
  const verdict = p.dragging ? dropVerdict(p.dragging, p.column) : null
  const refused = verdict && !verdict.ok && verdict.reason !== 'same' ? verdict.reason : null
  const bands = bandsOf(p.tasks)
  const zones = !!p.dragging && !!p.hover && !refused

  const over = (e: DragEvent<HTMLElement>): void => {
    if (!ownDrag(e, p.dragging) || !p.dragging) return
    const band = bandOf(e)
    const v = dropVerdict(p.dragging, p.column, band)
    if (v.ok) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    } else e.dataTransfer.dropEffect = 'none'
    if (!p.hover || p.hover.band !== band) p.onHover(p.column, band)
  }

  return (
    <section
      data-board-column={p.column}
      data-column-count={p.count}
      data-drop-refused={refused ?? undefined}
      aria-label={t(columnKey(p.column))}
      onDragEnter={(e) => {
        if (!ownDrag(e, p.dragging)) return
        depth.current++
        over(e)
      }}
      onDragOver={over}
      onDragLeave={(e) => {
        if (!ownDrag(e, p.dragging)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) p.onLeave(p.column)
      }}
      onDrop={(e) => {
        depth.current = 0
        if (!ownDrag(e, p.dragging)) return
        e.preventDefault()
        p.onDrop(p.column, bandOf(e), e)
      }}
      className={cn(
        'flex min-h-0 min-w-0 flex-col rounded-card border bg-bg-secondary/30 transition-[opacity,border-color]',
        p.hover && !refused ? 'border-accent-violet/50' : 'border-border',
        refused && 'opacity-50',
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <h3 className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t(columnKey(p.column))}</h3>
        <span data-column-count-pill className="rounded-full border border-border px-1.5 text-[10px] tabular-nums leading-4 text-text-secondary">
          {p.count}
        </span>
      </header>
      {refused && (
        <p data-drop-reason={refused} className="shrink-0 border-b border-border px-3 py-1.5 text-[11px] leading-4 text-text-secondary">
          {t(DROP_KEY[refused])}
        </p>
      )}
      <div data-board-column-body className="min-h-0 flex-1 overflow-y-auto p-2">
        {zones && (
          <div className="mb-2 flex flex-col gap-1">
            {TASK_PRIORITIES.map((b) => (
              <div
                key={b}
                data-band-drop={b}
                className={cn(
                  'flex h-6 items-center justify-center rounded border border-dashed text-[10px] uppercase tracking-wide',
                  p.hover?.band === b ? 'border-accent-violet bg-accent-violet/15 text-text-primary' : 'border-border text-text-secondary',
                )}
              >
                {t('teams.board.bandDrop', { priority: t(priorityKey(b)) })}
              </div>
            ))}
          </div>
        )}
        {p.tasks.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-text-secondary/80">{p.empty}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {p.tasks.map((task, i) => {
              const sep = bands.length >= 2 && (i === 0 || p.tasks[i - 1].priority !== task.priority)
              const n = p.names(task)
              return (
                <Fragment key={task.id}>
                  {sep && (
                    <p data-band={task.priority} className={cn('px-1 text-[10px] uppercase tracking-wide text-text-secondary', i > 0 && 'pt-1')}>
                      {t(priorityKey(task.priority))}
                    </p>
                  )}
                  <TaskCard
                    task={task}
                    assigneeName={n.assignee}
                    runName={n.run}
                    selected={p.selectedId === task.id}
                    tabbable={p.tabStopId === task.id}
                    {...p.card}
                  />
                </Fragment>
              )
            })}
          </div>
        )}
        {p.footer}
      </div>
    </section>
  )
}
