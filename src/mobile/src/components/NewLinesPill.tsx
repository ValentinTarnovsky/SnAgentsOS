/**
 * "New lines" pill (E2-FR-32): centred at the bottom of the terminal, just
 * above the KeyBar, while the user reads history (viewportY < baseY) and new
 * output arrived. A tap jumps to the end; reaching the bottom hides it.
 * RemoteTerminal owns the state (term.onScroll / onWriteParsed).
 */
import type { ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { t } from '../lib/i18n'

export function NewLinesPill({ visible, onTap }: { visible: boolean; onTap: () => void }): ReactNode {
  if (!visible) return null
  return (
    <button
      data-new-lines
      onPointerDown={(e) => e.preventDefault()}
      onClick={onTap}
      aria-label={t('term.newLinesAria')}
      className="fade-in absolute bottom-12 left-1/2 z-20 flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent-violet px-3.5 text-xs font-semibold text-white shadow-lg"
    >
      <ArrowDown size={14} />
      {t('term.newLines')}
    </button>
  )
}
