/**
 * Strip above the KeyBar when the viewed console's shell ended on its own
 * (E6-FR-20): "The console exited (code N)" with [Restart] (ctl restartPane,
 * an in-place restart on the desktop) and [Close] (ctl closePane, behind the
 * same confirmation sheet the action menu uses). It goes away with the next
 * replay that brings `running: true`.
 */
import { useState, type ReactNode } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { ConfirmSheet, type ConfirmState } from './ConfirmSheet'
import { useRemoteStore } from '../lib/store'
import { useExitStore } from '../lib/exitState'
import { client } from '../lib/client'
import { t } from '../lib/i18n'

export function ExitStrip(): ReactNode {
  const exit = useExitStore((s) => s.exit)
  const paneId = useRemoteStore((s) => s.subscribedPaneId)
  const workspaceId = useRemoteStore((s) =>
    exit ? (s.snapshot?.workspaces.find((w) => w.panes.some((p) => p.id === exit.paneId))?.id ?? null) : null,
  )
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const sheet = <ConfirmSheet state={confirm} onClose={() => setConfirm(null)} />
  if (!exit || exit.paneId !== paneId || !workspaceId) return sheet
  const target = { workspaceId, paneId: exit.paneId }

  return (
    <>
      <div
        data-exit-strip
        role="status"
        className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-secondary px-3 py-2"
      >
        <span className="min-w-0 flex-1 text-xs text-text-secondary">{t('exit.strip', { n: exit.exitCode })}</span>
        <button
          onClick={() => setConfirm({ message: t('exit.closeConfirm'), onConfirm: () => void client.sendCtl({ kind: 'closePane', ...target }) })}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-btn border border-border px-3 text-xs font-medium text-text-primary active:bg-card"
        >
          <X size={14} />
          {t('exit.close')}
        </button>
        <button
          data-exit-restart
          onClick={() => void client.sendCtl({ kind: 'restartPane', ...target })}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-btn bg-accent-violet px-3 text-xs font-semibold text-white active:brightness-110"
        >
          <RotateCcw size={14} />
          {t('exit.restart')}
        </button>
      </div>
      {sheet}
    </>
  )
}
