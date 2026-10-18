/**
 * Per-pane actions opened with a long-press on a tab or a drawer row
 * (E1-FR-33/39): Rename, Restart, Relaunch resuming, New chat and Close (red),
 * each restart or close behind a ConfirmSheet. The header carries the pane's
 * title, its workspace and its full last reply (<= 280 chars). Every ctl uses
 * the pane's own workspace, which may not be the desktop's active one.
 *
 * "Relaunch resuming" / "New chat" send restartPane with resume true / false
 * (E5-FR-11, contract of R21-03) and only show for a `resumable` pane (D10).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { History, MessageSquarePlus, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { Sheet } from './Sheet'
import { ActionList, type ActionItem } from './ActionList'
import { ConfirmSheet, type ConfirmState } from './ConfirmSheet'
import { RenameSheet } from './RenameSheet'
import { StatusIndicator } from './StatusIndicator'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { PaneIcon } from '../lib/paneIcon'
import { paneActionIds, restartAction, type PaneActionId } from '../lib/paneActions'
import type { PaneRef } from '../lib/workspace'
import { t, type MobileMessageKey } from '../lib/i18n'

/** Longest last reply the header shows (the desktop already caps it at 280). */
const MESSAGE_MAX = 280

const LABEL: Record<PaneActionId, MobileMessageKey> = {
  rename: 'act.rename',
  restart: 'act.restart',
  restartResume: 'act.restartResume',
  restartFresh: 'act.restartFresh',
  close: 'act.close',
}

const CONFIRM: Record<Exclude<PaneActionId, 'rename'>, MobileMessageKey> = {
  restart: 'act.restartConfirm',
  restartResume: 'act.restartResumeConfirm',
  restartFresh: 'act.restartFreshConfirm',
  close: 'act.closeConfirm',
}

const ICON: Record<PaneActionId, ReactNode> = {
  rename: <Pencil size={16} />,
  restart: <RotateCcw size={16} />,
  restartResume: <History size={16} />,
  restartFresh: <MessageSquarePlus size={16} />,
  close: <Trash2 size={16} />,
}

/**
 * The action rows for one pane, shared with the main action sheet. `onPick`
 * runs before the action (the caller closes its sheet there).
 */
export function usePaneActionItems(
  ref: PaneRef | null,
  onPick: () => void,
  opts: { rename?: boolean } = {},
): { items: ActionItem[]; overlays: ReactNode } {
  const pane = useRemoteStore((s) => {
    if (!ref || !s.snapshot) return null
    const ws = s.snapshot.workspaces.find((w) => w.id === ref.workspaceId)
    return ws?.panes.find((p) => p.id === ref.paneId) ?? null
  })
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [renaming, setRenaming] = useState<{ ref: PaneRef; title: string } | null>(null)

  const items: ActionItem[] =
    ref && pane
      ? paneActionIds(pane, opts).map((id) => ({
          id,
          icon: ICON[id],
          label: t(LABEL[id]),
          destructive: id === 'close',
          onSelect: () => {
            onPick()
            if (id === 'rename') {
              setRenaming({ ref, title: pane.title })
              return
            }
            const action =
              id === 'close'
                ? ({ kind: 'closePane', workspaceId: ref.workspaceId, paneId: ref.paneId } as const)
                : restartAction(ref.workspaceId, ref.paneId, id)
            setConfirm({ message: t(CONFIRM[id]), onConfirm: () => void client.sendCtl(action) })
          },
        }))
      : []

  const overlays = (
    <>
      <ConfirmSheet state={confirm} onClose={() => setConfirm(null)} />
      <RenameSheet
        open={renaming != null}
        initial={renaming?.title ?? ''}
        onClose={() => setRenaming(null)}
        onSave={(title) => {
          if (renaming) {
            void client.sendCtl({ kind: 'renamePane', workspaceId: renaming.ref.workspaceId, paneId: renaming.ref.paneId, title })
          }
        }}
      />
    </>
  )
  return { items, overlays }
}

export function PaneActionSheet({ target, onClose }: { target: PaneRef | null; onClose: () => void }): ReactNode {
  // Keep the last pane on screen through the exit animation.
  const last = useRef<PaneRef | null>(null)
  if (target) last.current = target
  const ref = target ?? last.current
  const snapshot = useRemoteStore((s) => s.snapshot)
  const status = useRemoteStore((s) => (ref ? s.paneStatus[ref.paneId] : undefined))
  const ws = ref && snapshot ? snapshot.workspaces.find((w) => w.id === ref.workspaceId) : undefined
  const pane = ws?.panes.find((p) => p.id === ref?.paneId)
  const { items, overlays } = usePaneActionItems(ref, onClose)

  // The pane was closed elsewhere (desktop, another phone) while open.
  const gone = target != null && snapshot != null && !pane
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  const message = status?.lastMessage ? status.lastMessage.slice(0, MESSAGE_MAX) : undefined

  return (
    <>
      <Sheet open={target != null && !!pane} onClose={onClose} title={t('act.paneActions')}>
        <div data-pane-actions={ref?.paneId ?? ''}>
          <ActionList
            title={pane?.title}
            subtitle={ws?.name}
            message={message}
            leading={
              pane ? (
                <>
                  <PaneIcon type={pane.type} size={16} />
                  <StatusIndicator status={status} />
                </>
              ) : undefined
            }
            items={items}
          />
        </div>
      </Sheet>
      {overlays}
    </>
  )
}
