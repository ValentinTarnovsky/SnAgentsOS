/**
 * "Direct input" strip (E1-FR-38): in Direct mode with the soft keyboard
 * closed, a 44px row between the terminal and the KeyBar says where typing
 * goes and opens the keyboard on xterm's helper textarea when tapped.
 * MainScreen hides it while the keyboard is up and in Composer mode.
 */
import type { ReactNode } from 'react'
import { Keyboard } from 'lucide-react'
import { getActiveTerm } from '../lib/terminalBus'
import { t } from '../lib/i18n'

export function DirectInputStrip(): ReactNode {
  const open = (): void => {
    const field = getActiveTerm()?.textarea
    if (!field) return
    // A field that kept the focus while the OS hid the keyboard only shows it
    // again after a fresh focus (same as the KeyBar toggle, E1-FR-20).
    if (document.activeElement === field) field.blur()
    field.focus({ preventScroll: true })
  }
  return (
    <button
      type="button"
      data-direct-strip
      // Focus is driven in click (inside the user gesture iOS needs).
      onPointerDown={(e) => e.preventDefault()}
      onClick={open}
      className="flex h-11 w-full shrink-0 items-center gap-2 border-t border-border bg-bg-secondary px-3 text-left text-xs text-text-secondary active:bg-card"
    >
      <Keyboard size={16} className="shrink-0" />
      <span className="truncate">{t('composer.directStrip')}</span>
    </button>
  )
}
