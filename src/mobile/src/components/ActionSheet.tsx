/**
 * Action menu for the viewed workspace/console, plus the global prompt sheet
 * and the settings screen it opens. "Viewed" is the workspace of the pane on
 * screen (E1-FR-07), not the desktop's active one, so Restart and Close reach
 * a pane of another workspace. The header shows that pane's agent status and
 * last reply (E1-FR-02/05). Rows are an ActionList (E1-FR-35); the viewed
 * pane's rows are the same ones the long-press menu shows, including
 * "Relaunch resuming" / "New chat" for a resumable pane (E5-FR-11). Settings
 * is a pushed screen (E1-FR-37). All actions go through the WS control plane
 * (client.sendCtl) and reflect their ack: New console auto-subscribes to the
 * pane id returned in the ack; Global prompt shows a "sent to N" toast.
 */
import { useState, type ReactNode } from 'react'
import { Gauge, Megaphone, Plus, Settings as SettingsIcon } from 'lucide-react'
import { Sheet } from './Sheet'
import { UsageSheet } from './UsageSheet'
import { StatusIndicator } from './StatusIndicator'
import { PaneStatusLines } from './PaneStatusLines'
import { PrimaryButton } from './InfoScreen'
import { ActionList, type ActionItem } from './ActionList'
import { SettingsScreen } from './SettingsScreen'
import { usePaneActionItems } from './PaneActionSheet'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { paneById, viewedWorkspaceId } from '../lib/workspace'
import { t } from '../lib/i18n'

export { ConfirmSheet, type ConfirmState } from './ConfirmSheet'

function GlobalPromptSheet({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean
  onClose: () => void
  workspaceId: string | null
}): ReactNode {
  const [text, setText] = useState('')
  const setToast = useRemoteStore((s) => s.setToast)

  const submit = async (): Promise<void> => {
    if (!workspaceId || !text) return
    const res = await client.sendCtl({ kind: 'globalPrompt', workspaceId, text })
    if (res.ok) setToast(t('act.promptSent', { n: res.info ?? 0 }))
    setText('')
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('act.globalPrompt')}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('act.promptPlaceholder')}
        rows={4}
        className="mb-4 w-full resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet"
      />
      <PrimaryButton onClick={() => void submit()} disabled={text.length === 0}>
        {t('act.send')}
      </PrimaryButton>
    </Sheet>
  )
}

export function ActionSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const activePaneId = useRemoteStore((s) => s.activePaneId)
  const [promptOpen, setPromptOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const activeStatus = useRemoteStore((s) => (s.activePaneId ? s.paneStatus[s.activePaneId] : undefined))

  const workspaceId = snapshot ? viewedWorkspaceId(snapshot, activePaneId) : null
  const activePane = snapshot ? paneById(snapshot, activePaneId) : null
  const paneRef = workspaceId && activePane ? { workspaceId, paneId: activePane.id } : null
  const pane = usePaneActionItems(paneRef, onClose, { rename: false })

  const newConsole = async (): Promise<void> => {
    if (!workspaceId) return
    onClose()
    const res = await client.sendCtl({ kind: 'createPane', workspaceId })
    if (res.ok && res.paneId) await client.switchWorkspaceAndView(workspaceId, res.paneId)
  }

  const items: ActionItem[] = [
    { id: 'newConsole', icon: <Plus size={16} />, label: t('act.newConsole'), onSelect: () => void newConsole() },
    {
      id: 'usage',
      icon: <Gauge size={16} />,
      label: t('act.usage'),
      onSelect: () => {
        onClose()
        setUsageOpen(true)
      },
    },
    {
      id: 'globalPrompt',
      icon: <Megaphone size={16} />,
      label: t('act.globalPrompt'),
      onSelect: () => {
        onClose()
        setPromptOpen(true)
      },
    },
    ...pane.items,
    {
      id: 'settings',
      icon: <SettingsIcon size={16} />,
      label: t('act.settings'),
      onSelect: () => {
        onClose()
        setSettingsOpen(true)
      },
    },
  ]

  return (
    <>
      <Sheet open={open} onClose={onClose} title={t('main.actions')}>
        {activePane && activeStatus && (
          <div data-action-status className="mb-3 flex items-start gap-2 rounded-card border border-border bg-bg-secondary px-3 py-2.5">
            <span className="pt-0.5">
              <StatusIndicator status={activeStatus} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-text-primary">{activePane.title}</span>
              <PaneStatusLines status={activeStatus} now={Date.now()} />
            </span>
          </div>
        )}
        <ActionList items={items} />
      </Sheet>

      {pane.overlays}
      <GlobalPromptSheet open={promptOpen} onClose={() => setPromptOpen(false)} workspaceId={workspaceId} />
      <SettingsScreen open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} />
    </>
  )
}
