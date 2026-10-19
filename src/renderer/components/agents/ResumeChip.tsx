import { useEffect } from 'react'
import { History, RotateCcw, X } from 'lucide-react'
import { formatAge } from '@shared/agents'
import { useAgentStore } from '@/lib/agentStore'
import { startNewChatAfterFailure } from '@/lib/agentLaunch'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

/** How long the "resumed" / "unavailable" chips stay (E5-FR-08). */
export const RESUME_CHIP_MS = 6000

/**
 * React chip over a console after a launch decision (E5-FR-08). Never
 * written into xterm, so nothing lands in the scrollback:
 *  - resumed: "Chat resumed · Claude · 2 h ago", 6 s,
 *  - unavailable: the previous chat is gone and a new one started, 6 s,
 *  - failed: no session start 20 s after a resume, stays with "Start a new chat".
 */
export function ResumeChip({ paneId }: { paneId: string }) {
  const t = useT()
  const chip = useAgentStore((s) => s.resumeChip[paneId])
  const setChip = useAgentStore((s) => s.setChip)

  useEffect(() => {
    if (!chip || chip.kind === 'failed') return
    const left = Math.max(0, RESUME_CHIP_MS - (Date.now() - chip.shownAt))
    const timer = setTimeout(() => {
      // Only clear the chip this timer was armed for (a newer one keeps its own).
      if (useAgentStore.getState().resumeChip[paneId] === chip) setChip(paneId, null)
    }, left)
    return () => clearTimeout(timer)
  }, [chip, paneId, setChip])

  if (!chip) return null
  const failed = chip.kind === 'failed'
  const text =
    chip.kind === 'resumed'
      ? t('agents.chip.resumed', { provider: chip.provider === 'codex' ? 'Codex' : 'Claude', age: formatAge(chip.shownAt - chip.updatedAt) })
      : chip.kind === 'unavailable'
        ? t('agents.chip.unavailable')
        : t('agents.chip.failed')

  return (
    // Full-width lane so the chip shrinks to the pane, not to half of it.
    <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-center">
      <div
        role={failed ? 'alert' : 'status'}
        data-resume-chip={chip.kind}
        className={cn(
          'pointer-events-auto flex min-w-0 max-w-full items-center gap-2 border bg-card/95 px-3 py-1 text-xs shadow-lg backdrop-blur',
          // The failure chip carries actions: it wraps in narrow panes instead of clipping them.
          failed ? 'flex-wrap justify-center rounded-lg border-amber-400/50 text-text-primary' : 'rounded-full border-border text-text-secondary',
        )}
      >
        <History size={13} className={cn('shrink-0', failed ? 'text-amber-400' : 'text-accent-violet')} />
        <span className={cn('min-w-0', failed ? 'break-words' : 'truncate')}>{text}</span>
        {failed && (
          <>
            <button
              type="button"
              onClick={() => startNewChatAfterFailure(paneId)}
              className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-text-primary transition-colors hover:bg-bg-secondary"
            >
              <RotateCcw size={11} />
              {t('agents.chip.startNew')}
            </button>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={() => setChip(paneId, null)}
              className="shrink-0 rounded p-0.5 text-text-secondary transition-colors hover:text-text-primary"
            >
              <X size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
