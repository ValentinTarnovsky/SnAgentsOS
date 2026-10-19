import { useEffect, useState } from 'react'
import { CACHE_WARN_MS, cacheApplies, cacheDeadline, formatCountdown } from '@shared/hibernation'
import type { CacheTimerSettings, PaneStatus } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

/**
 * Epoch ms the pane's Claude prompt cache expires (E5-FR-28), or null when
 * the timer is off, the pane is not Claude between turns or no transition
 * was seen. Pure over the store values.
 */
export function paneCacheDeadline(status: PaneStatus | undefined, timer: CacheTimerSettings | undefined): number | null {
  if (!timer?.enabled || !cacheApplies(status)) return null
  return cacheDeadline(status!.cacheSince, timer.ttlMinutes)
}

/**
 * Re-render every second until `deadline`, then stop: no ticker runs while
 * nothing counts down. Returns the current time.
 */
export function useCountdown(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (deadline === null) return
    setNow(Date.now())
    if (Date.now() >= deadline) return
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= deadline) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [deadline])
  return now
}

/** The mono "4:12" chip itself; amber in the last minute, gone at 0:00. */
export function CountdownChip({ deadline, className }: { deadline: number; className?: string }) {
  const t = useT()
  const now = useCountdown(deadline)
  const left = deadline - now
  if (left <= 0) return null
  const text = formatCountdown(left)
  const warn = left <= CACHE_WARN_MS
  return (
    <span
      data-cache-chip={warn ? 'warn' : 'ok'}
      role="timer"
      aria-label={t('agents.cache.label', { time: text })}
      title={t('agents.cache.label', { time: text })}
      className={cn(
        'shrink-0 rounded border px-1 font-mono text-[10px] leading-4 tabular-nums',
        warn ? 'border-amber-400/60 bg-amber-400/15 text-amber-500' : 'border-border text-text-secondary',
        className,
      )}
    >
      {text}
    </span>
  )
}

/**
 * Claude prompt cache countdown of one console (E5-FR-28): in the pane header
 * and on its sidebar row, from the working -> done/idle transition. Renders
 * nothing (and runs no ticker) when the timer is off or does not apply.
 */
export function CacheChip({ paneId, className }: { paneId: string; className?: string }) {
  const deadline = useAppStore((s) => paneCacheDeadline(s.paneStatus[paneId], s.settings.agents?.cacheTimer))
  if (deadline === null) return null
  return <CountdownChip deadline={deadline} className={className} />
}
