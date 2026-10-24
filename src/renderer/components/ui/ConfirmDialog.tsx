import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { ariaKeyshortcuts } from '@/lib/keymap'
import { KeyHint } from './KeyHint'

const CONFIRM_KEYS = ['Enter']

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  /** Styles the confirm button as destructive. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** A small two-button confirmation modal (Esc = cancel, Enter = confirm). */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onConfirm, onCancel])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="p-5">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          {/* break-words: a long word (a link a team agent wrote, a path) wraps instead of being cut by the card. */}
          <p className="mt-2 break-words text-sm text-text-secondary">{message}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
          >
            {cancelLabel}
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            aria-keyshortcuts={ariaKeyshortcuts(CONFIRM_KEYS)}
            data-confirm
            className={cn(
              'inline-flex items-center gap-2 rounded-btn px-4 py-2 text-sm font-medium text-white transition-[filter]',
              danger
                ? 'bg-red-500 hover:brightness-110'
                : 'bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] hover:brightness-110',
            )}
          >
            {confirmLabel}
            <KeyHint keys={CONFIRM_KEYS} tone="onAccent" />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
