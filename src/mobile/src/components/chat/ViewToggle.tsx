/**
 * The [Terminal | Chat] control of the terminal header (E3-FR-24): only for a
 * console whose agent status names Claude or Codex, or a Claude or Codex
 * console whose status names no provider. A choice that differs from "Open
 * agent consoles in Chat" is saved per pane, and the tap switches the
 * subscription (FR-25) through the client.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { MessageSquare, SquareTerminal } from 'lucide-react'
import { client } from '../../lib/client'
import { selectChatEligible, selectPaneView, useRemoteStore } from '../../lib/store'
import { t } from '../../lib/i18n'

export function ViewToggle(): ReactNode {
  const paneId = useRemoteStore((s) => s.activePaneId)
  const eligible = useRemoteStore((s) => selectChatEligible(s, s.activePaneId))
  const view = useRemoteStore((s) => selectPaneView(s, s.activePaneId))
  if (!paneId || !eligible) return null
  const opt = (v: 'terminal' | 'chat', icon: ReactNode, label: string): ReactNode => (
    <button
      type="button"
      role="radio"
      aria-checked={view === v}
      aria-label={label}
      data-view-option={v}
      onClick={() => {
        if (view !== v) client.setPaneView(paneId, v)
      }}
      className={clsx(
        'flex h-10 w-11 items-center justify-center rounded-[7px] transition-colors motion-reduce:transition-none',
        view === v ? 'bg-accent-violet text-white' : 'text-text-secondary active:bg-card',
      )}
    >
      {icon}
    </button>
  )
  return (
    <div data-view-toggle={view} role="radiogroup" aria-label={t('chat.viewLabel')} className="flex shrink-0 items-center rounded-btn border border-border p-0.5">
      {opt('terminal', <SquareTerminal size={17} />, t('chat.viewTerminal'))}
      {opt('chat', <MessageSquare size={17} />, t('chat.viewChat'))}
    </div>
  )
}
