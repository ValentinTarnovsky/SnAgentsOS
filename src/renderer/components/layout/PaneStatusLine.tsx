import { useStatusLines } from '@/lib/statusLineStore'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { doingNow } from '@/lib/statusSignals'

/**
 * The console's `snaos status` line in its header (E8-FR-19): one 11 px line
 * after the title, truncated, the full text in the tooltip. It gives way
 * before the title does (the topic still shrinks first).
 *
 * App 2.7.0 (A6): then what the agent is doing now ("Editando a.ts"), only
 * while a tool is open; it gives way before the status line.
 */
export function PaneStatusLine({ paneId }: { paneId: string }) {
  const t = useT()
  const text = useStatusLines((s) => s.lines[paneId])
  const doing = useAppStore((s) => doingNow(s.paneStatus[paneId], t))
  return (
    <>
      {text && (
        <span data-pane-status-line title={text} className="min-w-0 truncate whitespace-pre text-[11px] text-accent-violet/80 [flex-shrink:999]">
          {` · ${text}`}
        </span>
      )}
      {doing && (
        <span data-pane-doing title={doing} className="min-w-0 truncate whitespace-pre text-[11px] text-text-secondary [flex-shrink:1999]">
          {` · ${doing}`}
        </span>
      )}
    </>
  )
}
