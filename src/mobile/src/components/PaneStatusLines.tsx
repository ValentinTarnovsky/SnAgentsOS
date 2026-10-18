/**
 * The status text under a pane title (E1-FR-02/05): the second line (attention
 * reason, else time in the state) and the last assistant reply as plain text
 * clamped to two lines. Shared by the console drawer rows and the action sheet
 * header, which draw the StatusIndicator beside the title. `now` comes from
 * the caller's single ticker.
 */
import type { ReactNode } from 'react'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { statusLine } from '../lib/statusText'

export function PaneStatusLines({ status, now }: { status?: RemotePaneStatus; now: number }): ReactNode {
  if (!status) return null
  return (
    <>
      <span data-status-line className="mt-0.5 block truncate text-[11px] leading-tight text-text-secondary">
        {statusLine(status, now)}
      </span>
      {status.lastMessage && (
        <span data-last-message className="mt-0.5 line-clamp-2 break-words text-[11px] leading-snug text-text-secondary/80">
          {status.lastMessage}
        </span>
      )}
    </>
  )
}
