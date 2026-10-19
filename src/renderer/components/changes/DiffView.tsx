import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import type { GitDiffRes } from '@shared/git-types'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { chunkRanges, diffRows, hunkStarts, stepHunk, type DiffRow } from '@/lib/changes'

export interface DiffViewHandle {
  /** F7 (1) / Shift+F7 (-1). */
  stepHunk: (dir: 1 | -1) => void
}

/** Row height without wrap: placeholders of unrendered chunks use it. */
const ROW_PX = 18

/**
 * Review notes over the diff (E7-FR-17): what renders under a new-side line
 * (cards, the editor) and how a note starts there.
 */
export interface DiffNotesLayer {
  /** New-side lines with something under them. */
  lines: ReadonlySet<number>
  after: (line: number) => ReactNode
  /** Gutter "+", the `c` key or Shift+click: open the editor on `line` (a range from `startLine`). */
  onAdd: (line: number, startLine?: number) => void
}

type AddFn = (line: number, e: MouseEvent | null) => void

const Row = memo(function Row({ row, wrap, current, onAdd }: { row: DiffRow; wrap: boolean; current: boolean; onAdd: AddFn | null }) {
  if (row.type === 'hunk') {
    return (
      <div
        data-hunk={row.hunk}
        className={cn(
          'sticky left-0 flex min-h-[18px] items-center border-y border-border/60 bg-bg-secondary px-2 text-text-secondary',
          current && 'outline outline-1 -outline-offset-1 outline-accent-violet',
        )}
      >
        <span className={cn(wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>{row.header}</span>
      </div>
    )
  }
  const l = row.line
  const bg = l.kind === 'add' ? 'bg-ansi-green/15' : l.kind === 'del' ? 'bg-ansi-red/15' : ''
  const gutter = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
  // Notes go on the new side: added and context lines (E7-FR-17).
  const newNo = onAdd && (l.kind === 'add' || l.kind === 'ctx') ? l.newNo : undefined
  return (
    <div
      className={cn('group/line relative flex min-h-[18px]', bg, newNo !== undefined && 'outline-none focus:outline focus:outline-1 focus:-outline-offset-1 focus:outline-accent-violet/60')}
      data-line={l.kind}
      data-new-line={newNo}
      tabIndex={newNo !== undefined ? -1 : undefined}
      onClick={newNo !== undefined ? (e) => e.shiftKey && onAdd?.(newNo, e) : undefined}
    >
      {newNo !== undefined && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onAdd?.(newNo, e)
          }}
          className="absolute left-0.5 top-0 z-[1] hidden h-[18px] w-4 items-center justify-center rounded-sm bg-accent-violet text-white group-hover/line:flex"
          data-note-add={newNo}
        >
          <Plus size={11} />
        </button>
      )}
      <span className="w-11 shrink-0 select-none pr-1 text-right text-text-secondary/60">{l.oldNo ?? ''}</span>
      <span className="w-11 shrink-0 select-none pr-1 text-right text-text-secondary/60">{l.newNo ?? ''}</span>
      <span className={cn('w-4 shrink-0 select-none text-center', l.kind === 'add' ? 'text-ansi-green' : l.kind === 'del' ? 'text-ansi-red' : 'text-text-secondary')}>
        {l.kind === 'meta' ? '' : gutter}
      </span>
      <span className={cn('pr-3', l.kind === 'meta' && 'italic text-text-secondary', wrap ? 'min-w-0 flex-1 whitespace-pre-wrap break-all' : 'whitespace-pre')}>
        {l.text || ' '}
      </span>
    </div>
  )
})

/** A render chunk: real rows once it scrolled near the viewport, a sized placeholder before. */
function Chunk({ rows, start, end, wrap, current, forced, root, onAdd, notes }: { rows: DiffRow[]; start: number; end: number; wrap: boolean; current: number; forced: boolean; root: HTMLElement | null; onAdd: AddFn | null; notes: DiffNotesLayer | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  const visible = seen || forced
  // A chunk F7 rendered stays rendered after the walk moves on (no layout jump).
  useEffect(() => {
    if (forced) setSeen(true)
  }, [forced])
  useEffect(() => {
    if (visible || !ref.current || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { root, rootMargin: '600px 0px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [visible, root])
  if (!visible) return <div ref={ref} style={{ height: (end - start) * ROW_PX }} data-chunk-pending />
  return (
    <div data-chunk={start}>
      {rows.slice(start, end).map((r, i) => {
        const newNo = r.type === 'line' && r.line.kind !== 'del' ? r.line.newNo : undefined
        const under = notes && newNo !== undefined && notes.lines.has(newNo) ? notes.after(newNo) : null
        const row = <Row key={start + i} row={r} wrap={wrap} current={r.type === 'hunk' && r.hunk === current} onAdd={onAdd} />
        if (!under) return row
        return (
          <div key={start + i} data-line-group>
            {row}
            <div className="whitespace-normal" data-line-notes={newNo}>
              {under}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Unified diff of one file (E7-FR-13, 14): old and new line numbers, a
 * `+`/`-` gutter, add/del backgrounds in the theme's ansi green/red at 15%,
 * an `@@` header per hunk and settings.fontFamily. Over 2000 rows it renders
 * in 500-row chunks as they scroll near the viewport. F7 / Shift+F7 walk the
 * hunks (scroll, focus border, aria-live "Hunk 2 of 5"); the parent owns the
 * keys. The scroll position is kept while the diff's rev stays the same.
 */
export const DiffView = forwardRef<DiffViewHandle, { diff: GitDiffRes; wrap: boolean; fontFamily: string; fontSize: number; notes?: DiffNotesLayer | null }>(function DiffView(
  { diff, wrap, fontFamily, fontSize, notes = null },
  ref,
) {
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => diffRows(diff.hunks), [diff.hunks])
  const starts = useMemo(() => hunkStarts(rows), [rows])
  const chunks = useMemo(() => chunkRanges(rows.length), [rows.length])
  const [current, setCurrent] = useState(-1)
  const [forcedChunk, setForcedChunk] = useState<number | null>(null)
  const [announce, setAnnounce] = useState('')
  const pendingScroll = useRef<number | null>(null)
  // Notes: the latest layer behind a stable callback (rows stay memoized), and
  // the last line clicked or focused, where a Shift+click range starts.
  const notesRef = useRef(notes)
  notesRef.current = notes
  const anchor = useRef<number | null>(null)
  const addAt = useCallback<AddFn>((line, e) => {
    const layer = notesRef.current
    if (!layer) return
    if (e?.shiftKey && anchor.current !== null && anchor.current !== line) {
      layer.onAdd(Math.max(line, anchor.current), Math.min(line, anchor.current))
    } else {
      layer.onAdd(line)
    }
    anchor.current = line
  }, [])
  const onAdd = notes ? addAt : null
  useEffect(() => {
    anchor.current = null
  }, [diff.path, diff.area])

  const onNotesKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement
    const line = el.dataset?.newLine
    if (!notesRef.current || line === undefined || e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault()
      e.stopPropagation()
      anchor.current = Number(line)
      notesRef.current.onAdd(Number(line))
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.shiftKey) {
      // Walk the lines a note can go on.
      const all = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-new-line]') ?? [])]
      const next = all[all.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) {
        e.preventDefault()
        anchor.current = Number(next.dataset.newLine)
        next.focus()
        next.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  // A different file or new content restarts the hunk walk; same rev keeps everything.
  useEffect(() => {
    setCurrent(-1)
    setAnnounce('')
    setForcedChunk(null)
  }, [diff.path, diff.area, diff.diffRev])
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0, left: 0 })
  }, [diff.path, diff.area])

  useLayoutEffect(() => {
    const h = pendingScroll.current
    if (h === null) return
    const el = scroller.current?.querySelector<HTMLElement>(`[data-hunk="${h}"]`)
    if (el && scroller.current) {
      pendingScroll.current = null
      scroller.current.scrollTop = el.offsetTop - 4
    }
  })

  useImperativeHandle(
    ref,
    () => ({
      stepHunk: (dir) => {
        const count = diff.hunks.length
        const next = stepHunk(current, count, dir)
        if (next < 0) return
        setCurrent(next)
        setAnnounce(t('changes.hunkOf', { n: next + 1, total: count }))
        const row = starts[next] ?? 0
        const chunk = chunks.findIndex(([s, e]) => row >= s && row < e)
        setForcedChunk(chunk)
        pendingScroll.current = next
        // Rendered already: scroll now (the layout effect covers a chunk that renders on this update).
        const el = scroller.current?.querySelector<HTMLElement>(`[data-hunk="${next}"]`)
        if (el && scroller.current) {
          pendingScroll.current = null
          scroller.current.scrollTop = el.offsetTop - 4
        }
      },
    }),
    [current, diff.hunks.length, starts, chunks, t],
  )

  return (
    <>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto"
        style={{ fontFamily, fontSize, lineHeight: `${ROW_PX}px` }}
        data-changes-diff
        data-wrap={wrap || undefined}
        onKeyDown={onNotesKey}
        onMouseDown={(e) => {
          // A plain click on a line sets where a Shift+click range starts.
          const line = (e.target as HTMLElement).closest<HTMLElement>('[data-new-line]')?.dataset.newLine
          if (line === undefined || !notesRef.current) return
          if (e.shiftKey) e.preventDefault() // no text selection on a range click
          else anchor.current = Number(line)
        }}
      >
        <div className={cn(wrap ? 'w-full' : 'w-max min-w-full')}>
          {chunks.map(([s, e], i) => (
            <Chunk key={`${diff.diffRev}:${s}`} rows={rows} start={s} end={e} wrap={wrap} current={current} forced={chunks.length === 1 || forcedChunk === i} root={scroller.current} onAdd={onAdd} notes={notes} />
          ))}
        </div>
      </div>
      <div className="sr-only" aria-live="polite" data-changes-announce>
        {announce}
      </div>
    </>
  )
})
