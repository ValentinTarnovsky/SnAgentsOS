/**
 * Tab strip under the header (E1-FR-32): one chip per pane of the viewed
 * workspace in layoutOrder, each with its agent status, the pane type icon and
 * the title cut to 18 characters. The active chip is filled, panes without a
 * pty are dimmed to 50%, and the active chip scrolls into view when it
 * changes. A tap opens the pane through client.requestOpen (phone-only
 * navigation, E2-FR-06); the trailing "+" creates a console in this workspace
 * and enters it. Every chip calls preventDefault on pointerdown so the first tap
 * works with the soft keyboard open (the focused input keeps the focus).
 *
 * A long-press of LONG_PRESS_MS (E1-FR-33) opens the pane's ActionList via
 * onPaneActions instead of switching.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Plus } from 'lucide-react'
import type { RemotePaneInfo } from '@shared/remote-protocol'
import { StatusIndicator } from './StatusIndicator'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { PaneIcon } from '../lib/paneIcon'
import { useLongPress } from '../lib/longPress'
import { tabPanes, tabTitle, type PaneRef } from '../lib/workspace'
import { t } from '../lib/i18n'

const keepFocus = (e: ReactPointerEvent): void => e.preventDefault()

function PaneChip({
  pane,
  workspaceId,
  active,
  onPaneActions,
}: {
  pane: RemotePaneInfo
  workspaceId: string
  active: boolean
  onPaneActions: (ref: PaneRef) => void
}): ReactNode {
  const status = useRemoteStore((s) => s.paneStatus[pane.id])
  const ref = useRef<HTMLButtonElement | null>(null)
  const press = useLongPress(() => onPaneActions({ workspaceId, paneId: pane.id }), keepFocus)

  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [active])

  return (
    <button
      ref={ref}
      data-tab={pane.id}
      data-active={active}
      aria-current={active ? 'page' : undefined}
      aria-description={t('tabs.holdHint')}
      title={pane.title}
      {...press}
      onClick={() => void client.requestOpen(pane.id)}
      className={clsx(
        'flex h-8 max-w-[60vw] shrink-0 select-none items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
        active
          ? 'border-accent-violet bg-accent-violet text-white'
          : 'border-border bg-bg-primary text-text-primary active:bg-card',
        !pane.running && 'opacity-50',
      )}
      style={{ WebkitTouchCallout: 'none' }}
    >
      <StatusIndicator status={status} size={10} />
      <PaneIcon type={pane.type} size={13} />
      <span className="truncate whitespace-nowrap">{tabTitle(pane.title)}</span>
    </button>
  )
}

export function PaneTabs({ onPaneActions }: { onPaneActions: (ref: PaneRef) => void }): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const activePaneId = useRemoteStore((s) => s.activePaneId)
  if (!snapshot) return null
  const { workspaceId, panes } = tabPanes(snapshot, activePaneId)
  if (!workspaceId) return null

  const createHere = async (): Promise<void> => {
    const res = await client.sendCtl({ kind: 'createPane', workspaceId })
    if (res.ok && res.paneId) client.showPane(res.paneId)
    else useRemoteStore.getState().setToast(t('toast.createFailed'))
  }

  return (
    <nav
      data-pane-tabs={workspaceId}
      aria-label={t('tabs.label')}
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-bg-secondary px-3 py-1.5"
      style={{ touchAction: 'pan-x', scrollbarWidth: 'none' }}
      data-scrollable
    >
      {panes.map((pane) => (
        <PaneChip
          key={pane.id}
          pane={pane}
          workspaceId={workspaceId}
          active={pane.id === activePaneId}
          onPaneActions={onPaneActions}
        />
      ))}
      <button
        data-tab-new
        onPointerDown={keepFocus}
        onClick={() => void createHere()}
        aria-label={t('act.newConsole')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-text-secondary active:bg-card"
      >
        <Plus size={15} />
      </button>
    </nav>
  )
}
