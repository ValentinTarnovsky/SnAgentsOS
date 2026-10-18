import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

const Row = memo(function Row({ row, wrap, current }: { row: DiffRow; wrap: boolean; current: boolean }) {
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
  return (
    <div className={cn('flex min-h-[18px]', bg)} data-line={l.kind}>
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
function Chunk({ rows, start, end, wrap, current, forced, root }: { rows: DiffRow[]; start: number; end: number; wrap: boolean; current: number; forced: boolean; root: HTMLElement | null }) {
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
      {rows.slice(start, end).map((r, i) => (
        <Row key={start + i} row={r} wrap={wrap} current={r.type === 'hunk' && r.hunk === current} />
      ))}
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
export const DiffView = forwardRef<DiffViewHandle, { diff: GitDiffRes; wrap: boolean; fontFamily: string; fontSize: number }>(function DiffView(
  { diff, wrap, fontFamily, fontSize },
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
      >
        <div className={cn(wrap ? 'w-full' : 'w-max min-w-full')}>
          {chunks.map(([s, e], i) => (
            <Chunk key={`${diff.diffRev}:${s}`} rows={rows} start={s} end={e} wrap={wrap} current={current} forced={chunks.length === 1 || forcedChunk === i} root={scroller.current} />
          ))}
        </div>
      </div>
      <div className="sr-only" aria-live="polite" data-changes-announce>
        {announce}
      </div>
    </>
  )
})
