/**
 * Two-button confirmation sheet (Cancel / red Confirm) used before every
 * destructive or restarting action on the phone. Opened by setting `state`.
 */
import { useRef, type ReactNode } from 'react'
import { Sheet } from './Sheet'
import { t } from '../lib/i18n'

export interface ConfirmState {
  message: string
  onConfirm: () => void
}

export function ConfirmSheet({
  state,
  onClose,
}: {
  state: ConfirmState | null
  onClose: () => void
}): ReactNode {
  // Keep the text through the exit animation, after the parent cleared state.
  const last = useRef<ConfirmState | null>(null)
  if (state) last.current = state
  const shown = state ?? last.current
  return (
    <Sheet open={state != null} onClose={onClose} title={t('act.confirm')}>
      <p data-confirm-message className="mb-5 text-sm leading-relaxed text-text-secondary">{shown?.message}</p>
      <div className="flex gap-2">
        <button
          onClick={onClose}
          className="h-12 flex-1 rounded-btn border border-border bg-bg-secondary text-sm font-medium text-text-primary active:bg-card"
        >
          {t('act.cancel')}
        </button>
        <button
          data-confirm-ok
          onClick={() => {
            state?.onConfirm()
            onClose()
          }}
          className="h-12 flex-1 rounded-btn bg-red-500 text-sm font-semibold text-white active:brightness-110"
        >
          {t('act.confirm')}
        </button>
      </div>
    </Sheet>
  )
}
