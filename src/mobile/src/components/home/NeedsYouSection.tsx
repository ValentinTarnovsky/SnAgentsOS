/**
 * "Waiting for you" (app 2.7.0, A8): the consoles that need the user across
 * every workspace, at the top of Home, most urgent first. The desktop's rule
 * and order (src/shared/attention.ts needsYouRows, the one its sidebar badge,
 * the palette's "Waiting for you" and next waiting use): an open request, a
 * done or error nobody saw, a `snaos needs` (as urgent as a request, aged
 * from the ask), muted ones out. So its count is the document title's and
 * the workspace badges' added up. A row names the console and its workspace
 * and says why: the `snaos needs` request, else the row's second line. A tap
 * opens the console (phone-only navigation), a long-press its actions. Hidden
 * while nothing needs the user.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronRight } from 'lucide-react'
import type { NeedsYouRow } from '@shared/attention'
import { StatusIndicator } from '../StatusIndicator'
import { PaneIcon } from '../../lib/paneIcon'
import { useLongPress } from '../../lib/longPress'
import { agentStatusOf, needsText, rowLine } from '../../lib/statusText'
import type { PhoneAttentionItem } from '../../lib/workspace'
import { t } from '../../lib/i18n'

interface RowProps {
  item: PhoneAttentionItem
  now: number
  onOpen: (paneId: string) => void
  onActions: (workspaceId: string, paneId: string) => void
}

function NeedsRow({ item, now, onOpen, onActions }: RowProps): ReactNode {
  const press = useLongPress(() => onActions(item.workspaceId, item.paneId))
  const { pane, status } = item
  const agent = agentStatusOf(status)
  // A console counts here only with a status, so rowLine never reaches the pty fallbacks.
  const reason = status?.needs ? needsText(status.needs) : rowLine({ status, running: pane.running, exitCode: pane.exitCode, mounted: true }, now)
  return (
    <div
      data-needs-row={item.paneId}
      data-needs-ws={item.workspaceId}
      role="button"
      tabIndex={0}
      aria-description={t('tabs.holdHint')}
      {...press}
      onClick={() => onOpen(item.paneId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(item.paneId)
        }
      }}
      className="flex min-h-[56px] select-none items-center gap-3 rounded-btn border border-transparent bg-bg-secondary px-3 py-2 text-left active:bg-card"
      style={{ WebkitTouchCallout: 'none' }}
    >
      <span className="flex w-4 shrink-0 justify-center">
        {agent ? <StatusIndicator status={agent} /> : <span className="h-2 w-2 rounded-full bg-state-idle/40" />}
      </span>
      <PaneIcon type={status?.provider ?? pane.type} size={16} className="text-text-secondary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span data-needs-title className="min-w-0 truncate text-sm font-semibold text-text-primary">
            {pane.title}
          </span>
          <span data-needs-wsname className="min-w-0 flex-1 truncate text-[11px] text-text-secondary">
            {item.workspaceName}
          </span>
        </span>
        <span
          data-needs-line
          className={clsx('truncate text-[11px] leading-tight', status?.needs ? 'font-medium text-state-action' : 'text-text-secondary')}
        >
          {reason}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-text-secondary" />
    </div>
  )
}

export function NeedsYouSection({
  rows,
  now,
  onOpen,
  onActions,
}: {
  /** needsYouPanes(snapshot, paneStatus): every console that needs the user, in order. */
  rows: readonly NeedsYouRow<PhoneAttentionItem>[]
  now: number
  onOpen: (paneId: string) => void
  onActions: (workspaceId: string, paneId: string) => void
}): ReactNode {
  if (rows.length === 0) return null
  return (
    <section data-needs-you={rows.length} className="mb-4">
      <h2 className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        <span className="truncate">{t('home.needsYou')}</span>
        <span
          data-needs-count={rows.length}
          aria-label={t('home.actionBadge', { n: rows.length })}
          className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold normal-case text-white"
        >
          {rows.length}
        </span>
      </h2>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <NeedsRow key={row.id} item={row.item} now={now} onOpen={onOpen} onActions={onActions} />
        ))}
      </div>
    </section>
  )
}
