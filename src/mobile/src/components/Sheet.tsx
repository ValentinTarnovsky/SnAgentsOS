/**
 * Bottom-sheet primitive: a backdrop + a slide-up panel anchored to the bottom
 * of the keyboard-aware --vvh box (kept in sync by viewport.ts) so the panel and
 * its input dock just above the soft keyboard instead of behind it. Safe-area
 * padding clears the iOS home indicator when no keyboard is up. Content scrolls
 * inside the panel (marked data-scrollable so the overscroll guard lets touch
 * move it).
 */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
}

export function Sheet({ open, onClose, title, children }: SheetProps): ReactNode {
  if (!open) return null
  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex flex-col justify-end"
      style={{ height: 'var(--vvh, 100dvh)' }}
    >
      <div className="fade-in absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        data-scrollable
        className="sheet-up relative overflow-y-auto rounded-t-2xl border-t border-border bg-card"
        style={{ maxHeight: 'calc(var(--vvh, 100dvh) * 0.85)', paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <button
            onPointerDown={(e) => {
              e.preventDefault()
              onClose()
            }}
            className="flex h-9 w-9 items-center justify-center rounded-btn text-text-secondary active:bg-bg-secondary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  )
}
