/**
 * Selection mode of the phone terminal (E2-FR-26/27). A long-press selected a
 * word (RemoteTerminal); this layer covers the terminal while it lasts, so the
 * touch scroll and the pan are off, and shows:
 *
 *  - two handles with a 44px touch area at the ends of the selection. Dragging
 *    one moves that end; held within EDGE_SCROLL_PX of the top or bottom edge
 *    it scrolls one line every EDGE_SCROLL_MS and keeps extending;
 *  - the "Copy | All | Cancel" pill above the selection (below when it does
 *    not fit), PILL_MARGIN from every edge. Copy runs copyText inside the
 *    tap's own click handler (execCommand needs the gesture), shows
 *    "Copied (N characters)" and leaves; when the browser refuses, the text
 *    opens in CopyFallbackSheet to copy by hand. All = term.selectAll().
 *
 * A tap anywhere else, Android back, or the selection vanishing (a replay
 * resets the terminal) leaves the mode.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Terminal } from '@xterm/xterm'
import { Sheet } from './Sheet'
import { copyText } from '../lib/clipboard'
import {
  EDGE_SCROLL_MS,
  HANDLE_HIT_PX,
  applySelection,
  cellSize,
  cellToPoint,
  edgeScrollDir,
  orderCells,
  pillPosition,
  pointToCell,
  screenGeom,
  type Cell,
} from '../lib/selection'
import { useBackClaim } from '../lib/useBackClaim'
import { store } from '../lib/store'
import { t } from '../lib/i18n'

export type SelectionRange = [Cell, Cell]

interface Props {
  term: Terminal
  range: SelectionRange
  onRange: (range: SelectionRange) => void
  onExit: () => void
  /** The browser refused to copy: show the text to copy by hand. */
  onCopyFallback: (text: string) => void
}

type HandleSide = 0 | 1

export function SelectionOverlay({ term, range, onRange, onExit, onCopyFallback }: Props): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pillRef = useRef<HTMLDivElement | null>(null)
  const [, setTick] = useState(0)
  const [pillSize, setPillSize] = useState({ w: 0, h: 0 })
  const rangeRef = useRef(range)
  rangeRef.current = range
  const drag = useRef<{ side: HandleSide; dx: number; dy: number; x: number; y: number; timer: ReturnType<typeof setInterval> | null } | null>(null)
  useBackClaim(true, onExit)

  // Keep xterm's highlight in sync with the range.
  useEffect(() => {
    applySelection(term, range[0], range[1])
  }, [term, range])

  // Re-place the handles on scroll and repaint; leave when the selection is gone.
  useEffect(() => {
    const bump = (): void => setTick((n) => n + 1)
    const subs = [
      term.onScroll(bump),
      term.onRender(bump),
      term.onSelectionChange(() => {
        if (!term.hasSelection()) onExit()
      }),
    ]
    window.addEventListener('resize', bump)
    return () => {
      subs.forEach((s) => s.dispose())
      window.removeEventListener('resize', bump)
    }
  }, [term, onExit])

  useLayoutEffect(() => {
    const el = pillRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width !== pillSize.w || r.height !== pillSize.h) setPillSize({ w: r.width, h: r.height })
  })

  const stopEdge = (): void => {
    if (drag.current?.timer != null) clearInterval(drag.current.timer)
    if (drag.current) drag.current.timer = null
  }
  useEffect(() => () => stopEdge(), [])

  /** Move the dragged end to the cell under the finger (minus the grab offset). */
  const track = useCallback((): void => {
    const d = drag.current
    const g = screenGeom(term)
    if (!d || !g) return
    const { h } = cellSize(g)
    const cell = pointToCell(g, d.x - d.dx, d.y - d.dy - h / 2)
    const next: SelectionRange = d.side === 0 ? [cell, rangeRef.current[1]] : [rangeRef.current[0], cell]
    onRange(next)
  }, [term, onRange])

  const onHandleDown = (side: HandleSide) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
    const g = screenGeom(term)
    if (!g) return
    // Grab offset: finger vs the bottom edge of the end cell, so the end does not jump.
    const [start, end] = orderCells(rangeRef.current[0], rangeRef.current[1])
    const cell = side === 0 ? start : end
    const p = cellToPoint(g, cell)
    const { w, h } = cellSize(g)
    const anchorX = p ? p.x + (side === 0 ? 0 : w) : e.clientX
    const anchorY = p ? p.y + h : e.clientY
    // The dragged handle always becomes the moving end of the ordered range.
    onRange([start, end])
    rangeRef.current = [start, end]
    drag.current = { side, dx: e.clientX - anchorX + (side === 0 ? -w / 2 : w / 2), dy: e.clientY - anchorY, x: e.clientX, y: e.clientY, timer: null }
  }

  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    e.preventDefault()
    d.x = e.clientX
    d.y = e.clientY
    track()
    const g = screenGeom(term)
    const dir = g ? edgeScrollDir(e.clientY, g.top, g.top + g.height) : 0
    if (dir === 0) stopEdge()
    else if (d.timer == null) {
      d.timer = setInterval(() => {
        const gg = screenGeom(term)
        const cur = drag.current
        if (!gg || !cur) return stopEdge()
        const nowDir = edgeScrollDir(cur.y, gg.top, gg.top + gg.height)
        if (nowDir === 0) return stopEdge()
        term.scrollLines(nowDir)
        track()
      }, EDGE_SCROLL_MS)
    }
  }

  const onHandleUp = (): void => {
    stopEdge()
    drag.current = null
  }

  const copy = (): void => {
    // xterm joins rows with CRLF; the phone's clipboard wants plain newlines.
    const text = term.getSelection().replace(/\r\n/g, '\n')
    const n = Array.from(text).length
    const ok = copyText(text, () => onCopyFallback(text))
    if (ok) store.getState().setToast(t('sel.copied', { n }))
    else onCopyFallback(text)
    onExit()
  }

  const selectAll = (): void => {
    term.selectAll()
    const pos = term.getSelectionPosition()
    if (pos) onRange([{ col: pos.start.x, row: pos.start.y }, { col: Math.max(0, pos.end.x - 1), row: pos.end.y }])
  }

  // Geometry relative to the overlay box.
  const box = boxRef.current?.getBoundingClientRect()
  const g = screenGeom(term)
  let handles: Array<{ side: HandleSide; x: number; y: number } | null> = [null, null]
  let pill = { left: 8, top: 8 }
  if (g && box) {
    const { w, h } = cellSize(g)
    const [start, end] = orderCells(range[0], range[1])
    const ps = cellToPoint(g, start)
    const pe = cellToPoint(g, end)
    handles = [
      ps ? { side: 0, x: ps.x - box.left, y: ps.y + h - box.top } : null,
      pe ? { side: 1, x: pe.x + w - box.left, y: pe.y + h - box.top } : null,
    ]
    const selTop = ps ? ps.y - box.top : 0
    const selBottom = pe ? pe.y + h - box.top : box.height
    const anchorX = ps && pe && start.row === end.row ? (ps.x + pe.x + w) / 2 - box.left : box.width / 2
    pill = pillPosition({ selTop, selBottom, anchorX, pillW: pillSize.w, pillH: pillSize.h, boxW: box.width, boxH: box.height })
  }

  return (
    <div ref={boxRef} data-selection-overlay className="absolute inset-0 z-20" style={{ touchAction: 'none', WebkitTouchCallout: 'none', userSelect: 'none' }}>
      {/* A tap outside the handles and the pill leaves the mode. */}
      <div data-selection-backdrop className="absolute inset-0" onClick={onExit} />
      {handles.map((hd, i) =>
        hd ? (
          <div
            key={i}
            data-selection-handle={i === 0 ? 'start' : 'end'}
            role="slider"
            aria-label={t(i === 0 ? 'sel.handleStart' : 'sel.handleEnd')}
            aria-valuenow={i}
            onPointerDown={onHandleDown(hd.side)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            className="absolute flex justify-center"
            style={{ left: hd.x - HANDLE_HIT_PX / 2, top: hd.y - 4, width: HANDLE_HIT_PX, height: HANDLE_HIT_PX, touchAction: 'none' }}
          >
            <span className="mt-1 h-3.5 w-3.5 rounded-full bg-accent-violet shadow ring-2 ring-white/80" />
          </div>
        ) : null,
      )}
      <div
        ref={pillRef}
        data-selection-pill
        className="absolute flex overflow-hidden rounded-full bg-card text-xs font-semibold text-text-primary shadow-lg ring-1 ring-border"
        style={{ left: pill.left, top: pill.top, visibility: pillSize.w ? 'visible' : 'hidden' }}
      >
        <button data-sel-action="copy" onClick={copy} className="min-h-10 px-4 active:bg-bg-primary">{t('sel.copy')}</button>
        <button data-sel-action="all" onClick={selectAll} className="min-h-10 border-l-[0.5px] border-border px-4 active:bg-bg-primary">{t('sel.all')}</button>
        <button data-sel-action="cancel" onClick={onExit} className="min-h-10 border-l-[0.5px] border-border px-4 active:bg-bg-primary">{t('sel.cancel')}</button>
      </div>
    </div>
  )
}

/** The text in a selectable field when the browser refused to copy (E2-FR-27). */
export function CopyFallbackSheet({ text, onClose }: { text: string | null; onClose: () => void }): ReactNode {
  return (
    <Sheet open={text != null} onClose={onClose} title={t('sel.fallbackTitle')} dragFromContent={false}>
      <textarea
        data-copy-fallback
        readOnly
        value={text ?? ''}
        className="h-40 w-full resize-none rounded-btn border border-border bg-bg-primary p-2 font-mono text-xs text-text-primary"
        style={{ fontSize: 16, userSelect: 'text', WebkitUserSelect: 'text' }}
      />
      <p className="mt-2 text-xs text-text-secondary">{t('sel.fallbackHint')}</p>
    </Sheet>
  )
}
