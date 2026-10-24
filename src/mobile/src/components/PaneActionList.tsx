/**
 * Per-pane actions (E1-FR-33/39, E2-FR-08/16/49), opened with a long-press on
 * a Home row, the Resume card or a tab chip, and from the terminal's kebab.
 * Rows, in order: Rename, Restart, Relaunch resuming, New chat, Show on the
 * PC, Copy title and Close (red); every restart or close sits behind a
 * ConfirmSheet. The header carries the pane's title, its workspace and its
 * full last reply (<= 280 chars). Every ctl uses the pane's own workspace,
 * which may not be the desktop's active one (E2-FR-47).
 *
 * "Relaunch resuming" / "New chat" send restartPane with resume true / false
 * (E5-FR-11) and only show for a `resumable` pane (D10); an error ack (no
 * saved session any more) shows a toast. "Show on the PC" sends revealPane:
 * the desktop restores its window and focuses the console (E2-FR-07).
 *
 * App 2.7.0 (A8): on a desktop >= 2.7.0 the status marks come first (Mark as
 * read for a done or error turn, Mute until it changes or Unmute, Ignore
 * this turn while silent), sent at once as markRead / mutePane / silenceAck,
 * which main handles; a failed ack shows a toast. A `bare` status (only a
 * `snaos needs`, no agent) gets none and no agent glyph.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, BellOff, CheckCheck, Copy, EyeOff, History, MessageSquarePlus, MonitorUp, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import type { RemoteCtlAction } from '@shared/remote-protocol'
import { Sheet } from './Sheet'
import { ActionList, type ActionItem } from './ActionList'
import { ConfirmSheet, type ConfirmState } from './ConfirmSheet'
import { RenameSheet } from './RenameSheet'
import { StatusIndicator } from './StatusIndicator'
import { store, useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { PaneIcon } from '../lib/paneIcon'
import { paneActionIds, restartAction, statusMarkAction, statusMarksSupported, type PaneActionId, type StatusMarkId } from '../lib/paneActions'
import { agentStatusOf } from '../lib/statusText'
import type { PaneRef } from '../lib/workspace'
import { t, type MobileMessageKey } from '../lib/i18n'

/** Longest last reply the header shows (the desktop already caps it at 280). */
const MESSAGE_MAX = 280

const MARKS: ReadonlySet<PaneActionId> = new Set<StatusMarkId>(['markRead', 'mute', 'unmute', 'silenceAck'])

function isMark(id: PaneActionId): id is StatusMarkId {
  return MARKS.has(id)
}

const LABEL: Record<PaneActionId, MobileMessageKey> = {
  markRead: 'act.markRead',
  mute: 'act.mute',
  unmute: 'act.unmute',
  silenceAck: 'act.silenceAck',
  rename: 'act.rename',
  restart: 'act.restart',
  restartResume: 'act.restartResume',
  restartFresh: 'act.restartFresh',
  reveal: 'act.reveal',
  copyTitle: 'act.copyTitle',
  close: 'act.close',
}

const CONFIRM: Record<'restart' | 'restartResume' | 'restartFresh' | 'close', MobileMessageKey> = {
  restart: 'act.restartConfirm',
  restartResume: 'act.restartResumeConfirm',
  restartFresh: 'act.restartFreshConfirm',
  close: 'act.closeConfirm',
}

const ICON: Record<PaneActionId, ReactNode> = {
  markRead: <CheckCheck size={16} />,
  mute: <BellOff size={16} />,
  unmute: <Bell size={16} />,
  silenceAck: <EyeOff size={16} />,
  rename: <Pencil size={16} />,
  restart: <RotateCcw size={16} />,
  restartResume: <History size={16} />,
  restartFresh: <MessageSquarePlus size={16} />,
  reveal: <MonitorUp size={16} />,
  copyTitle: <Copy size={16} />,
  close: <Trash2 size={16} />,
}

/**
 * Plain-text copy that works on the http origin (no secure context): an
 * off-screen span selected as a document range and execCommand inside the tap
 * handler. A range (not a textarea) needs no focus, so the soft keyboard and
 * iOS's readonly-field quirks stay out of it.
 */
function copyPlain(text: string): boolean {
  if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => undefined)
    return true
  }
  const selection = window.getSelection()
  if (!selection) return false
  const span = document.createElement('span')
  span.textContent = text
  span.style.position = 'fixed'
  span.style.left = '-9999px'
  span.style.whiteSpace = 'pre'
  span.style.userSelect = 'text'
  span.style.webkitUserSelect = 'text'
  document.body.appendChild(span)
  let ok = false
  try {
    const range = document.createRange()
    range.selectNodeContents(span)
    selection.removeAllRanges()
    selection.addRange(range)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  selection.removeAllRanges()
  span.remove()
  return ok
}

/** Send a pane ctl and turn a failed ack into a toast. */
async function sendPaneCtl(action: RemoteCtlAction): Promise<void> {
  const res = await client.sendCtl(action)
  if (res.ok) return
  const resume = action.kind === 'restartPane' && action.resume !== undefined
  store.getState().setToast(t(resume ? 'toast.noSession' : 'toast.actionFailed'))
}

/**
 * The action rows for one pane. `onPick` runs before the action (the caller
 * closes its sheet there).
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
  const status = useRemoteStore((s) => (ref ? s.paneStatus[ref.paneId] : undefined))
  const marks = useRemoteStore((s) => statusMarksSupported(s.appVersion))
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [renaming, setRenaming] = useState<{ ref: PaneRef; title: string } | null>(null)

  const items: ActionItem[] =
    ref && pane
      ? paneActionIds(pane, { ...opts, status, marks }).map((id) => ({
          id,
          icon: ICON[id],
          label: t(LABEL[id]),
          destructive: id === 'close',
          onSelect: () => {
            onPick()
            if (isMark(id)) {
              void sendPaneCtl(statusMarkAction(ref.paneId, id))
              return
            }
            if (id === 'rename') {
              setRenaming({ ref, title: pane.title })
              return
            }
            if (id === 'reveal') {
              void sendPaneCtl({ kind: 'revealPane', paneId: ref.paneId })
              return
            }
            if (id === 'copyTitle') {
              // Inside the tap: iOS only lets execCommand copy from a user gesture.
              if (copyPlain(pane.title)) store.getState().setToast(t('toast.copied'))
              return
            }
            const action =
              id === 'close'
                ? ({ kind: 'closePane', workspaceId: ref.workspaceId, paneId: ref.paneId } as const)
                : restartAction(ref.workspaceId, ref.paneId, id)
            setConfirm({ message: t(CONFIRM[id]), onConfirm: () => void sendPaneCtl(action) })
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

export function PaneActionList({
  target,
  onClose,
  extraItems,
}: {
  target: PaneRef | null
  onClose: () => void
  /** Rows appended after the pane's own (the terminal kebab adds Quick Commands, E2-FR-16). */
  extraItems?: ActionItem[]
}): ReactNode {
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
  const all = extraItems?.length ? [...items, ...extraItems] : items

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
                  <PaneIcon type={status?.provider ?? pane.type} size={16} />
                  <StatusIndicator status={agentStatusOf(status)} />
                </>
              ) : undefined
            }
            items={all}
          />
        </div>
      </Sheet>
      {overlays}
    </>
  )
}
