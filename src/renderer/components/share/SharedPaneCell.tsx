import { useState } from 'react'
import { Maximize2, MessageSquare, Minimize2, X } from 'lucide-react'
import type { SharePaneInfo, SharePerm, ShareState } from '@shared/share-protocol'
import { paneStatusOf, toPaneStatus, useShareGuestStore } from '@/lib/shareGuestStore'
import { chatCapable, closeSharedPane, useShareExtrasStore } from '@/lib/shareGuestExtras'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { iconFor } from '@/lib/icons'
import { StatusDot } from '@/components/ui/StatusDot'
import { Tooltip } from '@/components/ui/Tooltip'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { RemoteTerminalPane } from './RemoteTerminalPane'
import { ctlErrorText } from './SharedWorkspaceExtras'

export interface SharedPaneCellProps {
  linkId: string
  pane: SharePaneInfo
  state: ShareState
  perm: SharePerm
  hostLabel: string
  maximized: boolean
  hidden: boolean
}

/**
 * A cell of the shared grid (app 2.4.0, item 8, S3): icon, title, status dot,
 * a local maximize and the console. Not PaneCell: that one drives the local
 * store (move, close, worktrees, schedules) keyed by workspace id. With full
 * control of a workspace (S5) it adds Chat (agent consoles) and Close, which
 * asks first and is relayed to the host.
 */
export function SharedPaneCell({ linkId, pane, state, perm, hostLabel, maximized, hidden }: SharedPaneCellProps) {
  const t = useT()
  const Icon = iconFor(pane.icon)
  const status = useShareGuestStore((s) => paneStatusOf(s.statuses, linkId, pane))
  const toggleMaximize = useShareGuestStore((s) => s.toggleMaximize)
  const maxLabel = t(maximized ? 'shareGuest.pane.restore' : 'shareGuest.pane.maximize')
  const chatOpen = useShareExtrasStore((s) => { const p = s.panel[linkId]; return p?.kind === 'chat' && p.paneId === pane.id })
  const busy = useShareExtrasStore((s) => s.ctlBusy[linkId] === true)
  const [confirmClose, setConfirmClose] = useState(false)
  const canChat = state.caps.chat && chatCapable(pane, status)
  const close = async (): Promise<void> => {
    setConfirmClose(false)
    const res = await closeSharedPane(linkId, pane.id)
    if (!res.ok) toast.error(t('shareGuest.ctl.closeFailed'), { body: ctlErrorText(t, res.error), dedupeKey: `share-ctl:${linkId}` })
  }
  return (
    <div
      data-shared-pane={pane.id}
      className={cn('relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-bg-primary', hidden && 'hidden')}
    >
      <header
        onDoubleClick={() => toggleMaximize(linkId, pane.id)}
        className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-card/50 px-2"
      >
        <Icon size={13} className="shrink-0" style={{ color: pane.color }} />
        <StatusDot status={toPaneStatus(status)} size={7} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">{pane.title}</span>
        {!pane.running && (
          <span data-shared-exited className="shrink-0 rounded border border-border px-1 text-[10px] font-medium uppercase leading-4 text-text-secondary/80">
            {t('shareGuest.pane.exited')}
          </span>
        )}
        {canChat && (
          <Tooltip label={t('shareGuest.pane.chat')}>
            <button
              type="button"
              aria-label={t('shareGuest.pane.chat')}
              aria-pressed={chatOpen}
              data-shared-pane-chat={pane.id}
              onClick={() => useShareExtrasStore.getState().togglePanel(linkId, { kind: 'chat', paneId: pane.id })}
              className={cn('rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary', chatOpen && 'bg-accent-violet/15 text-text-primary')}
            >
              <MessageSquare size={15} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={maxLabel}>
          <button
            type="button"
            aria-label={maxLabel}
            data-shared-maximize={pane.id}
            onClick={() => toggleMaximize(linkId, pane.id)}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </Tooltip>
        {state.caps.closePane && (
          <Tooltip label={t('shareGuest.pane.close')}>
            <button
              type="button"
              aria-label={t('shareGuest.pane.close')}
              data-shared-pane-close={pane.id}
              disabled={busy}
              onClick={() => setConfirmClose(true)}
              className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-40"
            >
              <X size={15} />
            </button>
          </Tooltip>
        )}
      </header>
      <div className="min-h-0 flex-1">
        <RemoteTerminalPane linkId={linkId} pane={pane} state={state} perm={perm} hostLabel={hostLabel} />
      </div>
      <ConfirmDialog
        open={confirmClose}
        title={t('shareGuest.pane.closeTitle')}
        message={t('shareGuest.pane.closeMsg', { pane: pane.title || t('shareGuest.pane.untitled'), host: hostLabel })}
        confirmLabel={t('shareGuest.pane.closeConfirm')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => void close()}
        onCancel={() => setConfirmClose(false)}
      />
    </div>
  )
}
