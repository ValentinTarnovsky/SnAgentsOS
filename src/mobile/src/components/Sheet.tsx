/**
 * Bottom-sheet primitive (E1-FR-34): a backdrop + a slide-up panel anchored to
 * the bottom of the keyboard-aware --vvh box (kept in sync by viewport.ts) so
 * the panel and its input dock just above the soft keyboard instead of behind
 * it. Safe-area padding clears the iOS home indicator when no keyboard is up.
 * Content scrolls inside the panel (marked data-scrollable so the overscroll
 * guard lets touch move it).
 *
 * Gestures: a 36x4 grab handle with a 44px touch zone and the header drag the
 * panel (touch-action:none, pointer events); the content drags it too, but
 * only scrolled to the top, moving down and with no field focused (touch
 * events, so a scrolled list keeps scrolling natively). Past DISMISS_PX or a
 * flick over DISMISS_VELOCITY it closes, else it springs back in SPRING_MS.
 * The backdrop fades with the drag and a tap on it closes too.
 *
 * Closing animates out (duration from the release speed, clamped 120..300ms)
 * and the panel stays mounted until transitionend, with a 350ms fallback.
 * Every open sheet holds a back-stack claim (useBackClaim): Android back
 * closes the top one, and the sheet's own close affordances pop its entry.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useBackClaim } from '../lib/useBackClaim'
import {
  backdropOpacity,
  canDragFromContent,
  closeDurationMs,
  prefersReducedMotion,
  releaseVelocity,
  shouldDismiss,
  SPRING_MS,
  UNMOUNT_FALLBACK_MS,
  VELOCITY_WINDOW_MS,
  type DragSample,
} from '../lib/sheetDrag'
import { t } from '../lib/i18n'

export {
  DISMISS_PX,
  DISMISS_VELOCITY,
  SPRING_MS,
  CLOSE_MIN_MS,
  CLOSE_MAX_MS,
  UNMOUNT_FALLBACK_MS,
} from '../lib/sheetDrag'

interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /** Allow dragging the sheet down from its content when scrolled to the top (default true). */
  dragFromContent?: boolean
}

interface DragState {
  startY: number
  dy: number
  samples: DragSample[]
  pointerId?: number
}

function fieldFocused(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.classList.contains('xterm-helper-textarea')) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

export function Sheet({ open, onClose, title, children, dragFromContent = true }: SheetProps): ReactNode {
  const { requestClose } = useBackClaim(open, onClose)
  const [mounted, setMounted] = useState(open)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<DragState | null>(null)
  /** Current translateY of the panel in px (drag offset). */
  const offset = useRef(0)
  /** Release speed of the drag that dismissed the sheet (0 = not a drag). */
  const exitVelocity = useRef(0)
  const backdropDown = useRef(false)
  const closeRef = useRef(requestClose)
  closeRef.current = requestClose

  if (open && !mounted) setMounted(true)

  // Reopened while the exit was still running: glide back up.
  useLayoutEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const backdrop = backdropRef.current
    exitVelocity.current = 0
    if (!panel || !panel.classList.contains('sheet-out')) return
    panel.classList.remove('sheet-out')
    panel.style.transitionDuration = ''
    panel.style.transition = `transform ${SPRING_MS}ms ease-out`
    panel.style.transform = 'translateY(0px)'
    offset.current = 0
    if (backdrop) {
      backdrop.style.transition = `opacity ${SPRING_MS}ms ease-out`
      backdrop.style.opacity = '1'
    }
  }, [open])

  // Exit: animate out from wherever the panel is, unmount on transitionend.
  useLayoutEffect(() => {
    if (open || !mounted) return
    const panel = panelRef.current
    const backdrop = backdropRef.current
    drag.current = null
    if (!panel || prefersReducedMotion()) {
      setMounted(false)
      return
    }
    const height = panel.getBoundingClientRect().height
    const ms = closeDurationMs(height - offset.current, exitVelocity.current)
    panel.classList.remove('sheet-drag')
    panel.style.animation = 'none'
    panel.style.transition = ''
    panel.style.transform = `translateY(${offset.current}px)`
    void panel.offsetHeight
    panel.classList.add('sheet-out')
    panel.style.transitionDuration = `${ms}ms`
    panel.style.transform = 'translateY(100%)'
    if (backdrop) {
      backdrop.style.animation = 'none'
      backdrop.style.transition = `opacity ${ms}ms ease-in`
      backdrop.style.opacity = '0'
    }
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      offset.current = 0
      setMounted(false)
    }
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === panel && e.propertyName === 'transform') finish()
    }
    panel.addEventListener('transitionend', onEnd)
    const timer = setTimeout(finish, UNMOUNT_FALLBACK_MS)
    return () => {
      done = true
      panel.removeEventListener('transitionend', onEnd)
      clearTimeout(timer)
    }
  }, [open, mounted])

  const startDrag = (y: number, pointerId?: number): void => {
    const panel = panelRef.current
    if (!panel || !open) return
    drag.current = { startY: y, dy: 0, samples: [{ t: performance.now(), y }], pointerId }
    panel.style.animation = 'none'
    panel.style.transition = ''
    panel.classList.add('sheet-drag')
    if (backdropRef.current) {
      backdropRef.current.style.animation = 'none'
      backdropRef.current.style.transition = 'none'
    }
  }

  const moveDrag = (y: number): void => {
    const d = drag.current
    const panel = panelRef.current
    if (!d || !panel) return
    const now = performance.now()
    d.dy = Math.max(0, y - d.startY)
    d.samples.push({ t: now, y })
    while (d.samples.length > 2 && now - d.samples[0].t > VELOCITY_WINDOW_MS * 2) d.samples.shift()
    offset.current = d.dy
    panel.style.transform = `translateY(${d.dy}px)`
    if (backdropRef.current) backdropRef.current.style.opacity = String(backdropOpacity(d.dy, panel.getBoundingClientRect().height))
  }

  const springBack = (): void => {
    const panel = panelRef.current
    drag.current = null
    if (!panel) return
    panel.classList.remove('sheet-drag')
    panel.style.transition = `transform ${SPRING_MS}ms ease-out`
    panel.style.transform = 'translateY(0px)'
    offset.current = 0
    if (backdropRef.current) {
      backdropRef.current.style.transition = `opacity ${SPRING_MS}ms ease-out`
      backdropRef.current.style.opacity = '1'
    }
  }

  const endDrag = (): void => {
    const d = drag.current
    if (!d) return
    const velocity = releaseVelocity(d.samples, performance.now())
    if (shouldDismiss(d.dy, velocity)) {
      drag.current = null
      exitVelocity.current = Math.max(0, velocity)
      closeRef.current()
    } else {
      springBack()
    }
  }

  // Content drags use touch events: a passive:false touchmove can take over
  // from native scrolling only at scrollTop 0 and only moving down.
  useEffect(() => {
    const panel = panelRef.current
    if (!mounted || !panel || !dragFromContent) return
    let candidate: { y: number } | null = null
    let dragging = false
    const onStart = (e: TouchEvent): void => {
      dragging = false
      candidate = null
      if (e.touches.length !== 1) return
      if (e.target instanceof Element && e.target.closest('[data-sheet-grab]')) return
      candidate = { y: e.touches[0].clientY }
    }
    const onMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY
      if (y == null) return
      if (!dragging && candidate) {
        const dy = y - candidate.y
        if (canDragFromContent({ scrollTop: panel.scrollTop, dy, inputFocused: fieldFocused() })) {
          dragging = true
          startDrag(candidate.y)
        } else if (dy < 0 || panel.scrollTop > 0) {
          candidate = null
        }
      }
      if (dragging) {
        e.preventDefault()
        moveDrag(y)
      }
    }
    const onEnd = (): void => {
      if (dragging) endDrag()
      dragging = false
      candidate = null
    }
    const onCancel = (): void => {
      if (dragging) springBack()
      dragging = false
      candidate = null
    }
    panel.addEventListener('touchstart', onStart, { passive: true })
    panel.addEventListener('touchmove', onMove, { passive: false })
    panel.addEventListener('touchend', onEnd)
    panel.addEventListener('touchcancel', onCancel)
    return () => {
      panel.removeEventListener('touchstart', onStart)
      panel.removeEventListener('touchmove', onMove)
      panel.removeEventListener('touchend', onEnd)
      panel.removeEventListener('touchcancel', onCancel)
    }
    // startDrag/moveDrag/endDrag only read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, dragFromContent])

  if (!mounted) return null

  const onGrabDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.target instanceof Element && e.target.closest('button')) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    startDrag(e.clientY, e.pointerId)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic or already released pointer */
    }
  }
  const samePointer = (e: ReactPointerEvent): boolean =>
    !!drag.current && (drag.current.pointerId === undefined || drag.current.pointerId === e.pointerId)
  const grabProps = {
    'data-sheet-grab': true,
    onPointerDown: onGrabDown,
    onPointerMove: (e: ReactPointerEvent) => {
      if (samePointer(e)) moveDrag(e.clientY)
    },
    onPointerUp: (e: ReactPointerEvent) => {
      if (samePointer(e)) endDrag()
    },
    onPointerCancel: (e: ReactPointerEvent) => {
      if (samePointer(e)) springBack()
    },
    style: { touchAction: 'none' as const },
  }

  return (
    <div
      data-sheet
      data-open={open}
      className="fixed inset-x-0 top-0 z-50 flex flex-col justify-end"
      style={{ height: 'var(--vvh, 100dvh)', pointerEvents: open ? undefined : 'none' }}
    >
      <div
        ref={backdropRef}
        data-sheet-backdrop
        className="fade-in absolute inset-0 bg-black/50"
        onPointerDown={() => {
          backdropDown.current = true
        }}
        onClick={() => {
          // Only a tap that also started here: the lift of the long-press that
          // opened this sheet must not close it again.
          if (backdropDown.current) requestClose()
          backdropDown.current = false
        }}
      />
      <div
        ref={panelRef}
        data-scrollable
        data-sheet-panel
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet-up relative overflow-y-auto rounded-t-2xl border-t border-border bg-card"
        style={{ maxHeight: 'calc(var(--vvh, 100dvh) * 0.85)', paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
      >
        <div className="sticky top-0 z-10 border-b border-border bg-card">
          <div {...grabProps} data-sheet-handle className="absolute inset-x-0 top-0 flex h-11 justify-center pt-2">
            <span className="block h-1 w-9 rounded-full bg-text-secondary/40" />
          </div>
          <div {...grabProps} className="flex items-center justify-between px-4 pb-2 pt-5">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <button
              onPointerDown={(e) => {
                e.preventDefault()
                requestClose()
              }}
              className="relative z-10 flex h-9 w-9 items-center justify-center rounded-btn text-text-secondary active:bg-bg-secondary"
              aria-label={t('sheet.close')}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  )
}
