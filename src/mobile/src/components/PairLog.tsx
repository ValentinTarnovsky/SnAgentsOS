/**
 * Live connection log while pairing (E2-FR-37): the lines of the current
 * pairing attempt as they arrive, newest at the bottom and kept in view. Used
 * by the connecting screen on the pairing path and on its 25s timeout.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { formatEntry, useDiagStore, type LogEntry } from '../lib/connLog'

/** Lines shown at most; the full log lives in Diagnostics. */
export const PAIR_LOG_LINES = 40

export function PairLog({ since }: { since?: number | null }): ReactNode {
  const all = useDiagStore((s) => s.entries)
  const startedAt = useDiagStore((s) => s.pairStartedAt)
  const from = since ?? startedAt ?? 0
  const lines: LogEntry[] = all.filter((e) => e.t >= from).slice(-PAIR_LOG_LINES)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])
  return (
    <div
      ref={ref}
      data-pair-log
      role="log"
      aria-live="polite"
      className="mb-4 max-h-44 overflow-y-auto rounded-card border border-border bg-bg-secondary px-3 py-2 text-left font-mono text-[10px] leading-relaxed text-text-secondary"
    >
      {lines.length === 0 ? (
        <span className="opacity-70">...</span>
      ) : (
        lines.map((e, i) => (
          <div
            key={`${e.t}-${i}`}
            className={clsx('break-all', e.level === 'error' ? 'text-red-400' : e.level === 'warn' ? 'text-amber-400' : '')}
          >
            {formatEntry(e)}
          </div>
        ))
      )}
    </div>
  )
}
