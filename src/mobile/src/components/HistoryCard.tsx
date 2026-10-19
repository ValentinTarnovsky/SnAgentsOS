/**
 * One session of the History screen (E3-FR-37): the provider's icon, the
 * title (custom title, summary or first prompt, already chosen by the
 * desktop), the folder (basename of the cwd) and "3h ago". A session the
 * desktop says is open in a console carries a small "open" dot.
 */
import type { ReactNode } from 'react'
import type { RemoteHistorySession } from '@shared/remote-protocol'
import { PaneIcon } from '../lib/paneIcon'
import { agentName } from '../lib/statusText'
import { folderName, historyAgo } from '../lib/history'

export function HistoryCard({
  session,
  now,
  open,
  onSelect,
}: {
  session: RemoteHistorySession
  now: number
  /** The session is open in a console the phone lists. */
  open: boolean
  onSelect: (session: RemoteHistorySession) => void
}): ReactNode {
  return (
    <button
      type="button"
      data-history-card={session.sessionId}
      data-provider={session.provider}
      data-open={open || undefined}
      onClick={() => onSelect(session)}
      className="flex min-h-[56px] w-full items-center gap-3 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-left active:bg-card"
    >
      <span className="shrink-0 text-text-secondary" aria-label={agentName(session)}>
        <PaneIcon type={session.provider} size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-history-title className="line-clamp-2 break-words text-sm font-medium leading-snug text-text-primary">
          {session.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-secondary">
          {open && <span data-history-open-dot className="h-1.5 w-1.5 shrink-0 rounded-full bg-state-done" />}
          <span data-history-folder className="min-w-0 truncate font-mono">{folderName(session.cwd)}</span>
          <span aria-hidden="true">·</span>
          <span data-history-ago className="shrink-0">{historyAgo(session.updatedAt, now)}</span>
        </span>
      </span>
    </button>
  )
}
