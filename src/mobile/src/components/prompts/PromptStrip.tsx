/**
 * One-line strip above the composer and the KeyBar (E2-FR-22, 25): a folded
 * answer card ("Claude asks for permission: Bash - tap to answer") or, with
 * no card, the generic "<Agent> is waiting for your answer - open terminal",
 * which brings the keyboard up on the console's input.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronUp, Keyboard } from 'lucide-react'
import { getActiveTerm, getComposerHandle } from '../../lib/terminalBus'
import { selectInChat, selectInputMode, store } from '../../lib/store'

/**
 * Bring the soft keyboard up where typing goes now: the composer in Composer
 * mode, else xterm's helper textarea (same refocus dance as DirectInputStrip).
 * Called inside the tap, the user gesture iOS needs. app 2.4.0: in the Chat
 * view the composer is the only input (the xterm is hidden), so it always
 * gets the focus there.
 */
export function openTerminalKeyboard(): void {
  const st = store.getState()
  if (selectInChat(st) || selectInputMode(st) === 'composer') {
    getComposerHandle()?.focus()
    return
  }
  const field = getActiveTerm()?.textarea
  if (!field) return
  if (document.activeElement === field) field.blur()
  field.focus({ preventScroll: true })
}

export function PromptStrip({
  text,
  variant,
  onTap,
}: {
  text: string
  /** 'folded' expands a card; 'waiting' opens the keyboard. */
  variant: 'folded' | 'waiting'
  onTap: () => void
}): ReactNode {
  return (
    <button
      type="button"
      data-prompt-strip={variant}
      // Keep the focus where it is until the tap decides (keyboard on 'waiting').
      onPointerDown={(e) => e.preventDefault()}
      onClick={onTap}
      className={clsx(
        'flex h-11 w-full shrink-0 items-center gap-2 border-t px-3 text-left text-xs font-medium active:bg-card',
        'border-state-action/40 bg-state-action/10 text-text-primary',
      )}
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-state-action" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {variant === 'folded' ? <ChevronUp size={16} className="shrink-0 text-text-secondary" /> : <Keyboard size={16} className="shrink-0 text-text-secondary" />}
    </button>
  )
}
