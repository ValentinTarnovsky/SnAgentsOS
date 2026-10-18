import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, ChevronUp, Info, X, XCircle } from 'lucide-react'
import { selectVisible, toast, useToastStore, type ToastItem, type ToastKind } from '@/lib/toast'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

const ICONS: Record<Exclude<ToastKind, 'card'>, { Icon: typeof Info; cls: string }> = {
  success: { Icon: CheckCircle2, cls: 'text-emerald-400' },
  info: { Icon: Info, cls: 'text-accent-blue' },
  warning: { Icon: AlertTriangle, cls: 'text-amber-400' },
  error: { Icon: XCircle, cls: 'text-red-400' },
}

/**
 * The desktop toast stack (E4-FR-03), bottom right above the regular modals
 * (z-50 / z-[80]) and below RemotePairingPrompt (z-[85]). Only the cards take
 * the pointer; the container is marked `data-toast-root` so modal backdrops can
 * ignore clicks that start here. Esc never closes a toast.
 */
export function NotificationStack() {
  const t = useT()
  const items = useToastStore((s) => s.items)
  const [expanded, setExpanded] = useState(false)
  const reduced = useReducedMotion()

  // Collapse again once the overflow is gone.
  const { visible, overflow } = selectVisible(items)
  useEffect(() => {
    if (overflow === 0 && expanded) setExpanded(false)
  }, [overflow, expanded])

  const shown = expanded ? [...items].sort((a, b) => a.createdAt - b.createdAt) : visible

  // The newest card sits at the bottom: keep it in view when the stack scrolls.
  const rootRef = useRef<HTMLDivElement>(null)
  const newest = shown[shown.length - 1]?.id
  useEffect(() => {
    const el = rootRef.current
    if (el && !expanded) el.scrollTop = el.scrollHeight
  }, [newest, shown.length, expanded])

  return createPortal(
    <div
      ref={rootRef}
      data-toast-root=""
      role="region"
      aria-label={t('toast.region')}
      className="pointer-events-none fixed bottom-4 right-4 z-[84] flex max-h-[calc(100vh-80px)] w-[360px] flex-col gap-2 overflow-y-auto max-[479px]:left-4 max-[479px]:w-auto"
    >
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="pointer-events-auto flex items-center justify-center gap-1.5 rounded-card border border-border bg-card px-3 py-1.5 text-xs text-text-secondary shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)] transition-colors hover:text-text-primary"
        >
          <ChevronUp size={13} className={cn('transition-transform', expanded && 'rotate-180')} />
          {expanded ? t('toast.collapse') : t('toast.more', { count: overflow })}
        </button>
      )}
      <AnimatePresence initial={false}>
        {shown.map((item) => (
          <motion.div
            key={item.id}
            layout={reduced ? false : 'position'}
            initial={reduced ? false : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: 24 }}
            transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }}
            className="pointer-events-auto shrink-0"
          >
            <ToastCard item={item} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  )
}

/** One card: hover or focus inside pauses its timer; a dedupe replace restarts it. */
function ToastCard({ item }: { item: ToastItem }) {
  const t = useT()
  const paused = useRef(false)
  const remaining = useRef(item.durationMs ?? 0)
  const startedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (item.durationMs === null) return
    remaining.current = item.durationMs
    const start = (): void => {
      if (paused.current) return
      startedAt.current = Date.now()
      timer.current = setTimeout(() => toast.dismiss(item.id), remaining.current)
    }
    start()
    return () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [item.id, item.durationMs, item.rev])

  const pause = (): void => {
    if (paused.current || item.durationMs === null) return
    paused.current = true
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current))
    }
  }
  const resume = (e?: { currentTarget: HTMLElement; relatedTarget?: EventTarget | null }): void => {
    // Focus moving between controls of the same card keeps it paused.
    if (e?.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return
    if (!paused.current || item.durationMs === null) return
    paused.current = false
    startedAt.current = Date.now()
    timer.current = setTimeout(() => toast.dismiss(item.id), remaining.current)
  }

  const isError = item.kind === 'error'
  const meta = item.kind === 'card' ? null : ICONS[item.kind]

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-toast-id={item.id}
      data-toast-kind={item.kind}
      onMouseEnter={pause}
      onMouseLeave={() => {
        if (!document.activeElement || !(document.activeElement as HTMLElement).closest?.(`[data-toast-id="${item.id}"]`)) resume()
      }}
      onFocus={pause}
      onBlur={(e) => resume(e)}
      className="relative flex items-start gap-2.5 rounded-card border border-border bg-card px-3 py-2.5 pr-8 text-sm text-text-primary shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)]"
    >
      {item.kind === 'card' ? (
        <div className="min-w-0 flex-1">{item.node}</div>
      ) : (
        <>
          {meta && <meta.Icon size={16} className={cn('mt-0.5 shrink-0', meta.cls)} />}
          <div className="min-w-0 flex-1">
            <p className="break-words font-medium leading-snug">{item.title}</p>
            {item.body && <p className="mt-0.5 break-words text-xs text-text-secondary">{item.body}</p>}
            {(item.actions?.length || item.link) && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {item.actions?.slice(0, 2).map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={a.run}
                    className="rounded-btn border border-border px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:border-accent-violet/40 hover:bg-bg-secondary"
                  >
                    {a.label}
                  </button>
                ))}
                {item.link && (
                  <button
                    type="button"
                    onClick={item.link.run}
                    className="text-xs text-text-secondary underline-offset-2 transition-colors hover:text-text-primary hover:underline"
                  >
                    {item.link.label}
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() => toast.dismiss(item.id)}
        aria-label={t('toast.close')}
        className="absolute right-2 top-2 rounded-btn p-0.5 text-text-secondary transition-colors hover:text-text-primary"
      >
        <X size={13} />
      </button>
    </div>
  )
}
