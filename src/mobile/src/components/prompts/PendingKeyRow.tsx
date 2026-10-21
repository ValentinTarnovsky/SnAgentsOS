/**
 * app 2.4.0: the Chat view's answer row for a request the phone has no card
 * for (an elicitation, a tool that is not a simple permission, a plan whose
 * menu did not validate, every Codex request). The Chat view has no terminal
 * to tap into, so instead of "open terminal" it offers the keys an agent menu
 * takes, plus a way back to the terminal:
 *
 *  - [1] [2] [3] pick that option and [Esc] backs out, each one plain
 *    `input` (sendInputTo), never followed by Enter;
 *  - [Terminal] switches the console to the Terminal view (chatUnsub + sub),
 *    where the whole menu is on screen.
 */
import type { ReactNode } from 'react'
import { Terminal } from 'lucide-react'
import { client } from '../../lib/client'
import { store } from '../../lib/store'
import { t } from '../../lib/i18n'

/** The keys of the row: their label and the bytes they send (never "\r"). */
export const PENDING_KEYS: ReadonlyArray<{ id: string; label: string; data: string }> = [
  { id: '1', label: '1', data: '1' },
  { id: '2', label: '2', data: '2' },
  { id: '3', label: '3', data: '3' },
  { id: 'esc', label: 'Esc', data: '\x1b' },
]

export function PendingKeyRow({ paneId, agent }: { paneId: string; agent: string }): ReactNode {
  const press = (data: string): void => {
    if (!client.sendInputTo(paneId, data)) store.getState().setToast(t('prompt.keyRow.offline'))
  }
  return (
    <div
      data-pending-key-row={paneId}
      role="group"
      aria-label={t('prompt.waitingChat', { agent })}
      className="shrink-0 border-t border-state-action/40 bg-state-action/10 px-3 pb-2 pt-2"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
        <span className="h-2 w-2 shrink-0 rounded-full bg-state-action" />
        <span data-pending-key-text className="min-w-0 flex-1 truncate">
          {t('prompt.waitingChat', { agent })}
        </span>
      </div>
      <div className="mt-2 flex gap-1.5">
        {PENDING_KEYS.map((key) => (
          <button
            key={key.id}
            type="button"
            data-pending-key={key.id}
            // Keep the focus (and the keyboard) where it is.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => press(key.data)}
            aria-label={key.id === 'esc' ? t('prompt.keyRow.esc') : t('prompt.keyRow.option', { n: key.label })}
            className="h-11 min-w-0 flex-1 rounded-btn border border-border bg-bg-secondary font-mono text-sm font-medium text-text-primary active:bg-card"
          >
            {key.label}
          </button>
        ))}
        <button
          type="button"
          data-pending-terminal
          onClick={() => client.setPaneView(paneId, 'terminal')}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-btn bg-accent-violet px-3 text-sm font-semibold text-white active:brightness-110"
        >
          <Terminal size={15} aria-hidden />
          {t('prompt.keyRow.terminal')}
        </button>
      </div>
    </div>
  )
}
