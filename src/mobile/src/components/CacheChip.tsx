/**
 * Claude cache countdown next to a console's name (E5-FR-28), the phone twin
 * of the desktop chip: mono "4:12", amber in the last minute, gone at 0:00
 * or when the agent works again. Nothing renders and no ticker runs while the
 * phone's switch is off or the pane is not Claude between turns.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { CACHE_WARN_MS, cacheApplies, formatCountdown } from '@shared/hibernation'
import { useRemoteStore } from '../lib/store'
import { cacheEnd, useCacheTimer } from '../lib/cacheTimer'
import { t } from '../lib/i18n'

function Countdown({ end, active }: { end: number; active?: boolean }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (Date.now() >= end) return
    const id = setInterval(() => {
      const v = Date.now()
      setNow(v)
      if (v >= end) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [end])
  const left = end - now
  if (left <= 0) return null
  const text = formatCountdown(left)
  const warn = left <= CACHE_WARN_MS
  return (
    <span
      data-cache-chip={warn ? 'warn' : 'ok'}
      role="timer"
      aria-label={t('cache.label', { time: text })}
      className={clsx(
        'shrink-0 rounded border px-1 font-mono text-[10px] leading-4 tabular-nums',
        warn
          ? 'border-amber-400/60 bg-amber-400/15 text-amber-500'
          : active
            ? 'border-white/50 text-white'
            : 'border-border text-text-secondary',
      )}
    >
      {text}
    </span>
  )
}

export function CacheChip({ paneId, active }: { paneId: string; active?: boolean }): ReactNode {
  const status = useRemoteStore((s) => s.paneStatus[paneId])
  const end = useCacheTimer((s) => (cacheApplies(status) ? cacheEnd(s.starts[paneId], s.prefs) : null))
  if (end === null) return null
  return <Countdown end={end} active={active} />
}
