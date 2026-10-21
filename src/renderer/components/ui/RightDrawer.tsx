/**
 * A drawer over the right of the workspace grid (v2.2, E9), the container of
 * the Notes and Files drawers, shaped like the Changes panel: it slides in
 * over the consoles (which stay mounted underneath), its left edge drags to
 * resize (kept per drawer in localStorage `snagentsos.drawer.<id>.width`),
 * it can cover the whole grid, and Esc closes it unless a field inside used
 * the key (the editor's search, a rename). A click on a console beside it
 * closes it (v2.3) unless it is pinned (`snagentsos.drawer.<id>.pinned`, or
 * `snagentsos.drawer.<id>.pinned.<scope>` with a `pinScope`: each workspace
 * keeps its own pin since app 2.5.0, the unscoped key is its old default).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Maximize2, Minimize2, Pin, PinOff, X } from 'lucide-react'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'

const MIN_WIDTH = 360

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function savedWidth(id: string): number | null {
  try {
    const v = Number(storage()?.getItem(`snagentsos.drawer.${id}.width`))
    return Number.isFinite(v) && v >= MIN_WIDTH ? v : null
  } catch {
    return null
  }
}

function saveWidth(id: string, width: number): void {
  try {
    storage()?.setItem(`snagentsos.drawer.${id}.width`, String(Math.round(width)))
  } catch {
    /* blocked storage: the width lasts this session */
  }
}

function pinKey(id: string, scope?: string): string {
  return scope ? `snagentsos.drawer.${id}.pinned.${scope}` : `snagentsos.drawer.${id}.pinned`
}

function savedPinned(id: string, scope?: string): boolean {
  try {
    const own = storage()?.getItem(pinKey(id, scope))
    if (own != null || !scope) return own === '1'
    return storage()?.getItem(pinKey(id)) === '1'
  } catch {
    return false
  }
}

function savePinned(id: string, pinned: boolean, scope?: string): void {
  try {
    // A scoped unpin is stored as '0' so the unscoped default does not pin it again.
    if (pinned) storage()?.setItem(pinKey(id, scope), '1')
    else if (scope) storage()?.setItem(pinKey(id, scope), '0')
    else storage()?.removeItem(pinKey(id))
  } catch {
    /* blocked storage: the pin lasts this session */
  }
}

/**
 * Closes the drawer on a primary press on the grid beside it (a console, a pane
 * header). A native capture listener on the grid wrapper: React would also bubble
 * the presses of portaled menus and dialogs opened from the drawer, and anything
 * outside the grid (sidebar, header toggles, titlebar, backdrops) never closes it.
 * What has focus inside is blurred first, so a pending rename or new file commits.
 * A press on something that takes the focus (a console, a field, a button) keeps
 * it; one on a pane title or a gap gives the keyboard back to the last console.
 */
const TAKES_FOCUS = '.xterm, input, textarea, select, button, a[href], [contenteditable], [tabindex]'

function useCloseOnOutsidePointer(rootRef: RefObject<HTMLDivElement | null>, enabled: boolean, onClose: (opts: { refocus: boolean }) => void): void {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    const scope = rootRef.current?.parentElement
    if (!enabled || !scope) return
    const onDown = (e: globalThis.PointerEvent): void => {
      if (!e.isTrusted || e.button !== 0) return
      const target = e.target as Element | null
      if (!target || target.closest?.('[data-drawer]')) return
      const root = rootRef.current
      const active = document.activeElement
      if (root && active instanceof HTMLElement && root.contains(active)) active.blur()
      latest.current({ refocus: !target.closest(TAKES_FOCUS) })
    }
    scope.addEventListener('pointerdown', onDown, true)
    return () => scope.removeEventListener('pointerdown', onDown, true)
  }, [rootRef, enabled])
}

export function RightDrawer({
  id,
  pinScope,
  title,
  icon,
  actions,
  defaultWidth,
  maximized,
  onMaximize,
  onClose,
  children,
}: {
  id: string
  /** The pin is kept per scope (the workspace id), not shared by every drawer with this id. */
  pinScope?: string
  title: ReactNode
  icon?: ReactNode
  /** Buttons of the header, before maximize and close. */
  actions?: ReactNode
  /** CSS width when nothing was saved, e.g. `clamp(420px, 40%, 820px)`. */
  defaultWidth: string
  maximized: boolean
  onMaximize: (on: boolean) => void
  /** `refocus: false` when a click outside closed it on something that takes the focus itself. */
  onClose: (opts?: { refocus?: boolean }) => void
  children: ReactNode
}) {
  const t = useT()
  const reduced = useReducedMotion()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(() => savedWidth(id))
  const [pinned, setPinned] = useState(() => savedPinned(id, pinScope))
  const drag = useRef<{ startX: number; startW: number; max: number } | null>(null)

  useCloseOnOutsidePointer(rootRef, !pinned && !maximized, onClose)

  // The drawer takes the keyboard when it opens (unless something inside already has it).
  useEffect(() => {
    const el = rootRef.current
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    e.stopPropagation()
    onClose()
  }

  const startDrag = (e: PointerEvent<HTMLDivElement>): void => {
    const el = rootRef.current
    const parent = el?.parentElement
    if (!el || !parent || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startW: el.getBoundingClientRect().width, max: parent.getBoundingClientRect().width - 80 }
  }
  const moveDrag = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    setWidth(Math.max(MIN_WIDTH, Math.min(d.max, d.startW + (d.startX - e.clientX))))
  }
  const endDrag = (): void => {
    if (!drag.current) return
    drag.current = null
    if (width !== null) saveWidth(id, width)
  }

  const btn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary'

  return (
    <motion.div
      ref={rootRef}
      tabIndex={-1}
      role="complementary"
      aria-label={typeof title === 'string' ? title : undefined}
      onKeyDown={onKeyDown}
      initial={reduced ? false : { x: '100%' }}
      animate={{ x: 0 }}
      transition={{ duration: reduced ? 0 : 0.15, ease: 'easeOut' }}
      className="absolute inset-y-0 right-0 z-20 flex max-w-full flex-col border-l border-border bg-bg-primary shadow-[-12px_0_32px_-16px_rgba(0,0,0,0.7)] outline-none"
      style={{ width: maximized ? '100%' : width !== null ? `${width}px` : defaultWidth }}
      data-drawer={id}
    >
      {!maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('drawer.resize')}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => {
            setWidth(null)
            try {
              storage()?.removeItem(`snagentsos.drawer.${id}.width`)
            } catch {
              /* blocked storage */
            }
          }}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent-violet/30"
          data-drawer-resize
        />
      )}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{title}</span>
        {actions}
        <Tooltip label={pinned ? t('drawer.unpin') : t('drawer.pin')} side="bottom">
          <button
            type="button"
            aria-label={pinned ? t('drawer.unpin') : t('drawer.pin')}
            aria-pressed={pinned}
            onClick={() => {
              setPinned(!pinned)
              savePinned(id, !pinned, pinScope)
            }}
            className={cn(btn, pinned && 'bg-accent-violet/20 text-text-primary')}
            data-drawer-pin={pinned ? 'on' : 'off'}
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        </Tooltip>
        <Tooltip label={maximized ? t('drawer.restore') : t('drawer.maximize')} side="bottom">
          <button type="button" aria-label={maximized ? t('drawer.restore') : t('drawer.maximize')} onClick={() => onMaximize(!maximized)} className={btn} data-drawer-maximize>
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </Tooltip>
        <Tooltip label={t('drawer.close')} side="bottom">
          <button type="button" aria-label={t('drawer.close')} onClick={() => onClose()} className={cn(btn)} data-drawer-close>
            <X size={15} />
          </button>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1">{children}</div>
    </motion.div>
  )
}
