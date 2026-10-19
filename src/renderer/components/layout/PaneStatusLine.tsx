import { useStatusLines } from '@/lib/statusLineStore'

/**
 * The console's `snaos status` line in its header (E8-FR-19): one 11 px line
 * after the title, truncated, the full text in the tooltip. It gives way
 * before the title does (the topic still shrinks first).
 */
export function PaneStatusLine({ paneId }: { paneId: string }) {
  const text = useStatusLines((s) => s.lines[paneId])
  if (!text) return null
  return (
    <span data-pane-status-line title={text} className="min-w-0 truncate whitespace-pre text-[11px] text-accent-violet/80 [flex-shrink:999]">
      {` · ${text}`}
    </span>
  )
}
