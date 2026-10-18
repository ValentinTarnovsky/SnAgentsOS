/**
 * Bottom-sheet workspace + console picker. Lists every workspace (the viewed
 * one highlighted) and its panes, each with its agent status, a second line
 * and the last reply (E1-FR-05). Every tap goes through
 * client.switchWorkspaceAndView (E1-FR-07): a running pane of another
 * workspace is only subscribed, so the desktop never moves; a pane without a
 * pty asks the desktop to switch first (lazy spawn) and shows a spinner until
 * the server pushes its replay. A long-press on a row (E1-FR-39) opens the
 * same per-pane ActionList as the tabs, through onPaneActions; a tap still
 * opens the console.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { RemotePaneInfo, RemotePaneStatus } from '@shared/remote-protocol'
import { clsx } from 'clsx'
import { Loader2, Pencil, Plus } from 'lucide-react'
import { Sheet } from './Sheet'
import { RenameSheet } from './RenameSheet'
import { StatusIndicator } from './StatusIndicator'
import { PaneStatusLines } from './PaneStatusLines'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { useExitStore } from '../lib/exitState'
import { showsTime, STATUS_TICK_MS } from '../lib/statusText'
import { viewedWorkspaceId, type PaneRef } from '../lib/workspace'
import { useLongPress } from '../lib/longPress'
import { t } from '../lib/i18n'

interface RenameTarget {
  workspaceId: string
  paneId: string
  title: string
}

/** One console row: tap opens it, a long-press opens its actions (E1-FR-39). */
function PaneRow({
  pane,
  workspaceId,
  selected,
  exited,
  status,
  now,
  onPick,
  onRename,
  onPaneActions,
}: {
  pane: RemotePaneInfo
  workspaceId: string
  selected: boolean
  exited: boolean
  status: RemotePaneStatus | undefined
  now: number
  onPick: () => void
  onRename: () => void
  onPaneActions?: (ref: PaneRef) => void
}): ReactNode {
  const press = useLongPress(() => onPaneActions?.({ workspaceId, paneId: pane.id }))
  return (
    <div
      data-pane={pane.id}
      role="button"
      tabIndex={0}
      {...(onPaneActions ? press : {})}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick()
        }
      }}
      className={clsx(
        'flex select-none items-center gap-3 rounded-btn border px-3 py-2.5 text-left transition',
        selected ? 'border-accent-violet bg-accent-violet/10' : 'border-transparent bg-bg-secondary active:bg-card',
      )}
      style={{ WebkitTouchCallout: 'none' }}
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: pane.color || 'var(--color-accent-violet)' }} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm text-text-primary">{pane.title}</span>
          <StatusIndicator status={status} />
        </span>
        <PaneStatusLines status={status} now={now} />
      </span>
      {pane.running ? (
        <span className="text-[10px] font-medium uppercase text-green-400">{t('main.running')}</span>
      ) : exited ? (
        <span data-pane-exited className="text-[10px] font-medium uppercase text-text-secondary">{t('main.exited')}</span>
      ) : (
        <span className="text-[10px] font-medium uppercase text-text-secondary">{t('main.stopped')}</span>
      )}
      {selected && !pane.running && !exited && <Loader2 size={14} className="spin text-accent-violet" />}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRename()
        }}
        onKeyDown={(e) => e.stopPropagation()}
        className="shrink-0 rounded p-1 text-text-secondary transition-colors hover:text-text-primary"
        title={t('act.rename')}
      >
        <Pencil size={14} />
      </button>
    </div>
  )
}

export function ConsoleDrawer({
  open,
  onClose,
  onPaneActions,
}: {
  open: boolean
  onClose: () => void
  onPaneActions?: (ref: PaneRef) => void
}): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const activePaneId = useRemoteStore((s) => s.activePaneId)
  const viewedExit = useExitStore((s) => s.exit)
  const paneStatus = useRemoteStore((s) => s.paneStatus)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // One 30s ticker for every relative time, only while a visible row shows one.
  const ticking = open && !!snapshot && snapshot.workspaces.some((ws) => ws.panes.some((p) => showsTime(paneStatus[p.id])))
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), STATUS_TICK_MS)
    return () => clearInterval(id)
  }, [ticking])
  useEffect(() => {
    if (open) setNow(Date.now())
  }, [open, paneStatus])

  if (!snapshot) return null
  const viewedWs = viewedWorkspaceId(snapshot, activePaneId)

  const pickPane = (workspaceId: string, paneId: string): void => {
    void client.switchWorkspaceAndView(workspaceId, paneId)
    onClose()
  }

  /**
   * Create a console in any workspace (incl. an empty one) and enter it. The
   * ctlAck carries the new pane id; switchWorkspaceAndView switches the desktop
   * first only when that workspace is not on screen there (lazy spawn).
   */
  const createInWorkspace = async (workspaceId: string): Promise<void> => {
    onClose()
    const res = await client.sendCtl({ kind: 'createPane', workspaceId })
    if (!res.ok || !res.paneId) return
    await client.switchWorkspaceAndView(workspaceId, res.paneId)
  }

  return (
    <>
    <Sheet open={open} onClose={onClose} title={t('main.workspaces')}>
      <div className="flex flex-col gap-4">
        {snapshot.workspaces.map((ws) => {
          const isActiveWs = ws.id === viewedWs
          return (
            <div key={ws.id} data-workspace={ws.id}>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <span
                  className={clsx('text-xs font-semibold uppercase tracking-wide', isActiveWs ? 'text-accent-violet' : 'text-text-secondary')}
                >
                  {ws.name}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {ws.panes.map((pane) => {
                  const selected = pane.id === activePaneId
                  // Ended on its own (E6-FR-38): "exited" tag, and no spinner (E6-FR-20).
                  const exited = !pane.running && (pane.exitCode !== undefined || viewedExit?.paneId === pane.id)
                  const status = paneStatus[pane.id]
                  return (
                    <PaneRow
                      key={pane.id}
                      pane={pane}
                      workspaceId={ws.id}
                      selected={selected}
                      exited={exited}
                      status={status}
                      now={now}
                      onPick={() => pickPane(ws.id, pane.id)}
                      onRename={() => setRenameTarget({ workspaceId: ws.id, paneId: pane.id, title: pane.title })}
                      onPaneActions={onPaneActions}
                    />
                  )
                })}
                <button
                  onClick={() => void createInWorkspace(ws.id)}
                  className="flex items-center gap-3 rounded-btn border border-dashed border-border px-3 py-2.5 text-left text-text-secondary transition active:bg-card"
                >
                  <Plus size={16} className="shrink-0" />
                  <span className="text-sm">{t('act.newConsole')}</span>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </Sheet>
    <RenameSheet
      open={renameTarget != null}
      initial={renameTarget?.title ?? ''}
      onClose={() => setRenameTarget(null)}
      onSave={(title) => {
        if (renameTarget) {
          void client.sendCtl({
            kind: 'renamePane',
            workspaceId: renameTarget.workspaceId,
            paneId: renameTarget.paneId,
            title,
          })
        }
      }}
    />
    </>
  )
}
