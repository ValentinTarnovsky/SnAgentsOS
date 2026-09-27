import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

type Side = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  label: ReactNode
  side?: Side
  delay?: number
  children: ReactNode
  className?: string
}

interface Coords {
  x: number
  y: number
}

const TRANSFORM: Record<Side, string> = {
  top: 'translate(-50%, -100%)',
  bottom: 'translate(-50%, 0)',
  left: 'translate(-100%, -50%)',
  right: 'translate(0, -50%)',
}

/**
 * Lightweight, themed tooltip. Replaces native `title=""` attributes app-wide.
 * Renders into a portal so it never gets clipped by overflow containers.
 */
export function Tooltip({ label, side = 'top', delay = 350, children, className = '' }: TooltipProps): ReactNode {
  const [coords, setCoords] = useState<Coords | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const el = triggerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const gap = 8
      let x = r.left + r.width / 2
      let y = r.top + r.height / 2
      if (side === 'top') y = r.top - gap
      else if (side === 'bottom') y = r.bottom + gap
      else if (side === 'left') x = r.left - gap
      else if (side === 'right') x = r.right + gap
      setCoords({ x, y })
    }, delay)
  }, [side, delay])

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setCoords(null)
  }, [])

  // Never leak a pending timer or a stuck tooltip if the trigger unmounts.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  useLayoutEffect(() => {
    if (!coords || !tooltipRef.current) return
    const r = tooltipRef.current.getBoundingClientRect()
    const dx = Math.max(8 - r.left, Math.min(0, window.innerWidth - 8 - r.right))
    const dy = Math.max(8 - r.top, Math.min(0, window.innerHeight - 8 - r.bottom))
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) setCoords({ x: coords.x + dx, y: coords.y + dy })
  }, [coords, label])

  useEffect(() => {
    if (!coords) return
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => { window.removeEventListener('resize', hide); window.removeEventListener('scroll', hide, true) }
  }, [coords, hide])

  if (label === undefined || label === null || label === '') {
    return <>{children}</>
  }

  return (
    <span
      ref={triggerRef}
      className={`inline-flex ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onPointerDown={hide}
      onClick={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={coords ? id : undefined}
    >
      {children}
      {createPortal(
        <AnimatePresence>
          {coords && (
            <motion.span
              ref={tooltipRef}
              id={id}
              role="tooltip"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              style={{
                position: 'fixed',
                left: coords.x,
                top: coords.y,
                transform: TRANSFORM[side],
                zIndex: 9999,
                pointerEvents: 'none',
                width: 'max-content',
                maxWidth: 'min(260px, calc(100vw - 16px))',
              }}
              className="max-w-[260px] whitespace-normal break-words rounded-md border border-border bg-card px-2 py-1 text-[12px] font-medium text-text-primary shadow-lg shadow-black/40"
            >
              {label}
            </motion.span>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  )
}
