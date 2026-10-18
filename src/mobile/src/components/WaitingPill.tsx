/**
 * "N waiting" pill in the header (E1-FR-06). N counts the panes in 'action'
 * across every workspace, without the one being viewed; it hides at 0. A tap
 * opens the next waiting pane (workspace order, then layoutOrder, cycling from
 * the current one) through client.switchWorkspaceAndView, so a running pane
 * of another workspace never moves the desktop. The wrapper stays mounted as a
 * polite live region so changes of N are announced.
 */
import { useMemo, type ReactNode } from 'react'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { nextWaitingPane, waitingPanes } from '../lib/workspace'
import { t } from '../lib/i18n'

export function WaitingPill(): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const paneStatus = useRemoteStore((s) => s.paneStatus)
  const activePaneId = useRemoteStore((s) => s.activePaneId)
  const count = useMemo(
    () => (snapshot ? waitingPanes(snapshot, paneStatus, activePaneId).length : 0),
    [snapshot, paneStatus, activePaneId],
  )

  const openNext = (): void => {
    if (!snapshot) return
    const ref = nextWaitingPane(snapshot, paneStatus, activePaneId)
    if (ref) void client.switchWorkspaceAndView(ref.workspaceId, ref.paneId)
  }

  return (
    <span aria-live="polite" className="flex shrink-0 items-center">
      {count > 0 && (
        <button
          data-waiting={count}
          onClick={openNext}
          aria-label={t('status.waitingAria', { n: count })}
          className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-state-action/15 px-2.5 text-[11px] font-semibold text-state-action ring-1 ring-state-action/40 active:bg-state-action/25"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-state-action" />
          {t('status.waiting', { n: count })}
        </button>
      )}
    </span>
  )
}
