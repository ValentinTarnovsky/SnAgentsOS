import { useEffect, useRef } from 'react'
import { Moon, Play } from 'lucide-react'
import { formatAge } from '@shared/agents'
import type { SleepInfo } from '@/lib/agentStore'
import { wakePane } from '@/lib/hibernation'
import { registerFocuser, setFocusedPane, unregisterFocuser } from '@/lib/focus'
import { useNow } from '@/components/sidebar/AgentRows'
import { useT } from '@/i18n'

/** The "slept N ago" line moves this often. */
const AGE_TICK_MS = 60_000

/**
 * Stand-in for a sleeping console (E5-FR-25/26): "Sleeping · the chat is
 * saved", when and why it went to sleep and [Resume]. A click anywhere on it
 * or Enter wakes the console, resuming its chat. It takes the console's place
 * as a focus target, so the palette, a sidebar row or Ctrl+1..9 land here.
 */
export function SleepingOverlay({ paneId, workspaceId, info }: { paneId: string; workspaceId: string; info: SleepInfo }) {
  const t = useT()
  const now = useNow(AGE_TICK_MS)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const focus = (): void => ref.current?.focus()
    registerFocuser(paneId, focus)
    return () => unregisterFocuser(paneId)
  }, [paneId])

  const wake = (): void => {
    wakePane(paneId)
  }

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={t('agents.sleep.title')}
      data-pane-sleeping={paneId}
      onClick={wake}
      onFocus={() => setFocusedPane(paneId, workspaceId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault()
          e.stopPropagation()
          wake()
        }
      }}
      className="flex h-full cursor-pointer flex-col items-center justify-center gap-3 px-4 text-center outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-violet/60"
    >
      <Moon size={22} className="text-accent-violet/80" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">{t('agents.sleep.title')}</p>
        <p data-sleep-since className="text-xs text-text-secondary">
          {t('agents.sleep.since', { minutes: info.idleMinutes, age: formatAge(now - info.at) })}
        </p>
      </div>
      <button
        type="button"
        data-sleep-resume
        onClick={(e) => {
          e.stopPropagation()
          wake()
        }}
        className="flex items-center gap-1.5 rounded-md border border-accent-violet/40 bg-accent-violet/10 px-3 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-accent-violet/20"
      >
        <Play size={12} />
        {t('agents.sleep.resume')}
      </button>
    </div>
  )
}
