/**
 * One console on Home (E2-FR-05): at least 56px tall, with the agent status
 * indicator (E1/M1), the provider icon (status.provider, else the pane type)
 * and the title, bold while unread. The grey second line comes from rowLine;
 * a done or idle agent with a last reply adds it as a one-line preview. A tap
 * opens the console (phone-only navigation, E2-FR-06) and a long-press opens
 * its actions (E2-FR-08). A request with an answer card adds its line with
 * inline buttons (E2-FR-23). Memoized: a paneStatus re-renders only its own row.
 */
import { memo, type ReactNode } from 'react'
import { clsx } from 'clsx'
import type { RemotePaneInfo, RemotePaneStatus } from '@shared/remote-protocol'
import { StatusIndicator } from '../StatusIndicator'
import { PaneIcon } from '../../lib/paneIcon'
import { useLongPress } from '../../lib/longPress'
import { useExitStore } from '../../lib/exitState'
import { rowLine } from '../../lib/statusText'
import { RowPrompt } from '../prompts/RowPrompt'
import { t } from '../../lib/i18n'

export interface ConsoleRowProps {
  pane: RemotePaneInfo
  workspaceId: string
  status: RemotePaneStatus | undefined
  unread: boolean
  /** Its workspace is mounted on the desktop (else "Not started"). */
  mounted: boolean
  /** The phone's terminal is showing this console right now. */
  viewed: boolean
  /** Shared 30s clock of the relative times. */
  now: number
  onOpen: (paneId: string) => void
  onActions: (workspaceId: string, paneId: string) => void
}

function ConsoleRowImpl({ pane, workspaceId, status, unread, mounted, viewed, now, onOpen, onActions }: ConsoleRowProps): ReactNode {
  const press = useLongPress(() => onActions(workspaceId, pane.id))
  // The viewed console's exit frame can land before main's next snapshot (E6-FR-20/38).
  const stripCode = useExitStore((s) => (s.exit?.paneId === pane.id ? s.exit.exitCode : undefined))
  const exitCode = pane.running ? undefined : (pane.exitCode ?? stripCode)
  const exited = exitCode !== undefined
  const line = rowLine({ status, running: pane.running, exitCode, mounted }, now)
  const preview = status && (status.state === 'done' || status.state === 'idle') ? status.lastMessage : undefined
  return (
    <div
      data-pane={pane.id}
      data-unread={unread || undefined}
      role="button"
      tabIndex={0}
      aria-description={t('tabs.holdHint')}
      {...press}
      onClick={() => onOpen(pane.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(pane.id)
        }
      }}
      className={clsx(
        'flex min-h-[56px] select-none items-center gap-3 rounded-btn border px-3 py-2 text-left transition',
        viewed ? 'border-accent-violet/60 bg-accent-violet/10' : 'border-transparent bg-bg-secondary active:bg-card',
      )}
      style={{ WebkitTouchCallout: 'none' }}
    >
      <span className="flex w-4 shrink-0 justify-center">
        {status ? <StatusIndicator status={status} /> : <span className={clsx('h-2 w-2 rounded-full', pane.running ? 'bg-state-idle/40' : 'bg-border')} />}
      </span>
      <PaneIcon type={status?.provider ?? pane.type} size={16} className="text-text-secondary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-pane-title className={clsx('truncate text-sm text-text-primary', unread ? 'font-bold' : 'font-medium')}>
          {pane.title}
        </span>
        <span data-status-line className="truncate text-[11px] leading-tight text-text-secondary">
          {line}
          {exited && <span data-pane-exited className="sr-only">{t('main.exited')}</span>}
        </span>
        {preview && (
          <span data-last-message className="truncate text-[11px] leading-tight text-text-secondary/80">
            {preview}
          </span>
        )}
        <RowPrompt paneId={pane.id} status={status} />
      </span>
    </div>
  )
}

export const ConsoleRow = memo(ConsoleRowImpl)
