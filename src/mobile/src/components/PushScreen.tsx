/**
 * Full-screen page pushed over the live screen (E1-FR-37): slides in with
 * translateX(100%) -> 0 and out the reverse way, SLIDE_MS with SLIDE_EASING,
 * and ignores touches while sliding. With prefers-reduced-motion it appears
 * and disappears at once. Holds a back-stack claim (useBackClaim), so Android
 * back and the header's back arrow both pop it. Stays mounted until its exit
 * animation ends (fallback SLIDE_MS + 50ms).
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useBackClaim } from '../lib/useBackClaim'
import { prefersReducedMotion } from '../lib/sheetDrag'
import { t } from '../lib/i18n'

export const SLIDE_MS = 300
export const SLIDE_EASING = 'cubic-bezier(0.2,0.8,0.2,1)'

type Stage = 'in' | 'shown' | 'out'

export function PushScreen({
  open,
  onClose,
  title,
  children,
  id,
  actions,
  flush,
  bodyRef,
  onScroll,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** data-push-screen value, for tests and styling hooks. */
  id?: string
  /** Buttons at the right end of the header (Changes: notes badge, refresh). */
  actions?: ReactNode
  /** No side padding in the body: rows that run edge to edge (a diff). */
  flush?: boolean
  /** The scrolling body element. */
  bodyRef?: Ref<HTMLDivElement>
  onScroll?: (el: HTMLDivElement) => void
}): ReactNode {
  const { requestClose } = useBackClaim(open, onClose)
  const [mounted, setMounted] = useState(open)
  const [stage, setStage] = useState<Stage>('in')
  const ref = useRef<HTMLDivElement | null>(null)

  if (open && !mounted) {
    setMounted(true)
    setStage('in')
  } else if (mounted && !open && stage !== 'out') {
    setStage('out')
  } else if (open && stage === 'out') {
    setStage('in')
  }

  // Each slide ends on animationend (or the fallback); reduced motion skips it.
  useLayoutEffect(() => {
    if (!mounted || stage === 'shown') return
    const el = ref.current
    const complete = (): void => {
      if (stage === 'in') setStage('shown')
      else setMounted(false)
    }
    if (!el || prefersReducedMotion()) {
      complete()
      return
    }
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      complete()
    }
    const onEnd = (e: AnimationEvent): void => {
      if (e.target === el) finish()
    }
    el.addEventListener('animationend', onEnd)
    const timer = setTimeout(finish, SLIDE_MS + 50)
    return () => {
      done = true
      el.removeEventListener('animationend', onEnd)
      clearTimeout(timer)
    }
  }, [mounted, stage])

  if (!mounted) return null
  const sliding = stage !== 'shown'

  return (
    <div
      ref={ref}
      data-push-screen={id ?? ''}
      data-stage={stage}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className={
        'fixed inset-x-0 top-0 z-40 flex flex-col bg-bg-primary ' + (stage === 'in' ? 'push-in' : stage === 'out' ? 'push-out' : '')
      }
      style={{ height: 'var(--vvh, 100dvh)', pointerEvents: sliding ? 'none' : undefined }}
    >
      <header
        className="flex shrink-0 items-center gap-1 border-b border-border bg-bg-secondary px-1 py-1.5"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 6px)' }}
      >
        <button
          data-push-back
          onClick={requestClose}
          className="flex h-11 w-11 items-center justify-center rounded-btn text-text-secondary active:bg-card"
          aria-label={t('nav.back')}
        >
          <ChevronLeft size={22} />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</h2>
        {actions && <div className="flex shrink-0 items-center gap-1 pr-1">{actions}</div>}
      </header>
      <div
        data-scrollable
        ref={bodyRef}
        onScroll={onScroll ? (e) => onScroll(e.currentTarget) : undefined}
        className={'min-h-0 flex-1 overflow-y-auto ' + (flush ? 'py-0' : 'px-4 py-4')}
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
      >
        {children}
      </div>
    </div>
  )
}
