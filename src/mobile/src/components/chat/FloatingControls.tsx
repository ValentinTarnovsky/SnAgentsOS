/**
 * The Chat view's two floating controls, bottom right (E3-FR-29): expand or
 * fold every tool row, and the "Go to the end" pill with the count of
 * messages that arrived while the reader was scrolled up (it shows past
 * 200px from the end).
 */
import type { ReactNode } from 'react'
import { ArrowDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { t } from '../../lib/i18n'

export function FloatingControls({
  allOpen,
  onToggleAll,
  showJump,
  newCount,
  onJump,
}: {
  allOpen: boolean
  onToggleAll: () => void
  showJump: boolean
  newCount: number
  onJump: () => void
}): ReactNode {
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-2">
      {showJump && (
        <button
          type="button"
          data-chat-jump
          onClick={onJump}
          className="pointer-events-auto flex h-11 items-center gap-1.5 rounded-full border border-border bg-bg-secondary px-3.5 text-xs font-medium text-text-primary shadow-lg active:bg-card"
        >
          <ArrowDown size={14} aria-hidden />
          {newCount > 0 ? t('chat.jumpEndN', { n: newCount }) : t('chat.jumpEnd')}
        </button>
      )}
      <button
        type="button"
        data-chat-toggle-all={allOpen ? 'open' : 'closed'}
        onClick={onToggleAll}
        aria-label={allOpen ? t('chat.collapseAll') : t('chat.expandAll')}
        className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-border bg-bg-secondary text-text-secondary shadow-lg active:bg-card"
      >
        {allOpen ? <ChevronsDownUp size={18} /> : <ChevronsUpDown size={18} />}
      </button>
    </div>
  )
}
