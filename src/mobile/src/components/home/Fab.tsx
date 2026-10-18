/**
 * The "+" FAB (E2-FR-10): 56px, 16px from the right and bottom edges plus the
 * safe area. The Home list reserves FAB_CLEARANCE_PX below its last row so the
 * button never covers a console.
 */
import type { ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { t } from '../../lib/i18n'

export const FAB_CLEARANCE_PX = 88

export function Fab({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <button
      data-fab
      onClick={onClick}
      aria-label={t('newConsole.title')}
      className="fixed z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent-violet text-white shadow-lg ring-1 ring-black/10 active:brightness-110"
      style={{
        right: 'calc(16px + env(safe-area-inset-right))',
        bottom: 'calc(16px + env(safe-area-inset-bottom))',
      }}
    >
      <Plus size={26} />
    </button>
  )
}
