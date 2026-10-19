/**
 * What a spinner turns into when the desktop never answered a request
 * (E3-FR-04): its 10s pending timeout ran out, or a ctlAck said 'rate'.
 * "The PC did not answer [Retry]"; Retry sends the same request again under
 * a new id (the caller's onRetry). Shared by the v3.0 screens that wait on
 * the desktop (history, chat pages, changes).
 */
import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { t } from '../lib/i18n'

export function NoReply({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div data-no-reply role="status" className="flex items-center justify-center gap-3 px-3 py-4">
      <span className="text-sm text-text-secondary">{t('pending.noReply')}</span>
      <button
        type="button"
        onClick={onRetry}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-btn border border-border px-3 text-xs font-medium text-text-primary active:bg-card"
      >
        <RotateCcw size={14} />
        {t('pending.retry')}
      </button>
    </div>
  )
}
