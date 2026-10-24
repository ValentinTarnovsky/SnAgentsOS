/**
 * One console on Home (E2-FR-05): at least 56px tall, with the agent status
 * indicator (E1/M1), the provider icon (status.provider, else the pane type)
 * and the title, bold while unread. The grey second line comes from rowLine;
 * a done or idle agent with a last reply adds it as a one-line preview. A tap
 * opens the console (phone-only navigation, E2-FR-06) and a long-press opens
 * its actions (E2-FR-08). A request with an answer card adds its line with
 * inline buttons (E2-FR-23). Memoized: a paneStatus re-renders only its own row.
 *
 * App 2.7.0 (A8), the desktop's status signals: the second line says what the
 * agent is doing now while a tool is open; under it what it asked for (`snaos
 * needs`, in the request amber), why its last turn failed (red, "until 15:30"
 * while the reset is ahead) and its silence (quiet or stalled, with the
 * minutes and an "Ignore this turn" button on a desktop >= 2.7.0). The title
 * line carries the mute mark and the context percent ("est." unless the
 * agent reported it). A `bare` status (a `snaos needs` on a console with no
 * agent) shows the request alone: no glyph, no agent state.
 */
import { memo, type ReactNode, type SyntheticEvent } from 'react'
import { clsx } from 'clsx'
import { BellOff, EyeOff } from 'lucide-react'
import type { PaneSilence } from '@shared/types'
import type { RemotePaneInfo, RemotePaneStatus } from '@shared/remote-protocol'
import { StatusIndicator } from '../StatusIndicator'
import { PaneIcon } from '../../lib/paneIcon'
import { useLongPress } from '../../lib/longPress'
import { useExitStore } from '../../lib/exitState'
import { store, useRemoteStore } from '../../lib/store'
import { client } from '../../lib/client'
import { statusMarksSupported } from '../../lib/paneActions'
import { agentStatusOf, contextLabel, contextPercent, contextShort, failureText, needsText, rowLine, silenceText } from '../../lib/statusText'
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

const stop = (e: SyntheticEvent): void => e.stopPropagation()

/** The silence line: its words and, on a desktop that takes it, "Ignore this turn" (silenceAck). */
function SilenceLine({ paneId, silence, now, ack }: { paneId: string; silence: PaneSilence; now: number; ack: boolean }): ReactNode {
  const stalled = silence.level === 'stalled'
  return (
    <span data-row-silence={silence.level} className="flex min-w-0 items-center gap-1">
      <span className={clsx('min-w-0 truncate text-[11px] leading-tight', stalled ? 'font-medium text-text-primary' : 'text-text-secondary')}>
        {silenceText(silence, now)}
      </span>
      {ack && (
        // Its own tap: never the row's open nor its long-press.
        <button
          type="button"
          data-row-silence-ack={paneId}
          aria-label={t('status.silence.ack')}
          onPointerDown={stop}
          onKeyDown={stop}
          onContextMenu={stop}
          onClick={(e) => {
            e.stopPropagation()
            void client.sendCtl({ kind: 'silenceAck', paneId }).then((res) => {
              if (!res.ok) store.getState().setToast(t('toast.actionFailed'))
            })
          }}
          className="-my-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-card"
        >
          <EyeOff size={14} />
        </button>
      )}
    </span>
  )
}

function ConsoleRowImpl({ pane, workspaceId, status, unread, mounted, viewed, now, onOpen, onActions }: ConsoleRowProps): ReactNode {
  const press = useLongPress(() => onActions(workspaceId, pane.id))
  // The viewed console's exit frame can land before main's next snapshot (E6-FR-20/38).
  const stripCode = useExitStore((s) => (s.exit?.paneId === pane.id ? s.exit.exitCode : undefined))
  const marks = useRemoteStore((s) => statusMarksSupported(s.appVersion))
  const exitCode = pane.running ? undefined : (pane.exitCode ?? stripCode)
  const exited = exitCode !== undefined
  // A bare status is no agent status: only its `snaos needs` shows.
  const agent = agentStatusOf(status)
  const bareNeeds = status?.bare ? status.needs : undefined
  const line = rowLine({ status, running: pane.running, exitCode, mounted }, now)
  const preview = agent && (agent.state === 'done' || agent.state === 'idle') ? agent.lastMessage : undefined
  const context = agent?.context
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
        {agent ? <StatusIndicator status={agent} /> : <span className={clsx('h-2 w-2 rounded-full', pane.running ? 'bg-state-idle/40' : 'bg-border')} />}
      </span>
      <PaneIcon type={status?.provider ?? pane.type} size={16} className="text-text-secondary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span data-pane-title className={clsx('min-w-0 flex-1 truncate text-sm text-text-primary', unread ? 'font-bold' : 'font-medium')}>
            {pane.title}
          </span>
          {agent?.muted && (
            <span data-row-muted role="img" aria-label={t('status.muted')} className="flex shrink-0 text-text-secondary">
              <BellOff size={13} />
            </span>
          )}
          {context && (
            <span
              data-row-context={contextPercent(context)}
              data-context-exact={context.exact ? 'true' : 'false'}
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={contextPercent(context)}
              aria-label={contextLabel(context)}
              className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-text-secondary"
            >
              {contextShort(context)}
            </span>
          )}
        </span>
        {bareNeeds ? (
          <span data-status-line data-row-needs className="truncate text-[11px] font-medium leading-tight text-state-action">
            {needsText(bareNeeds)}
          </span>
        ) : (
          <span data-status-line className="truncate text-[11px] leading-tight text-text-secondary">
            {line}
            {exited && <span data-pane-exited className="sr-only">{t('main.exited')}</span>}
          </span>
        )}
        {agent?.needs && (
          <span data-row-needs className="truncate text-[11px] font-medium leading-tight text-state-action">
            {needsText(agent.needs)}
          </span>
        )}
        {agent?.failure && (
          <span data-row-failure={agent.failure.kind} className="truncate text-[11px] font-medium leading-tight text-state-error">
            {failureText(agent.failure, now)}
          </span>
        )}
        {agent?.silence && <SilenceLine paneId={pane.id} silence={agent.silence} now={now} ack={marks} />}
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
