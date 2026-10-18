import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface ContextMenuItem {
  label: string
  icon?: LucideIcon
  onClick: () => void
  danger?: boolean
  /** Renders a divider above this item. */
  separated?: boolean
  /** Radio item: a check mark when true, an empty slot when false. */
  checked?: boolean
  /** Shown but not clickable; `hint` says why (tooltip). */
  disabled?: boolean
  /** Tooltip, e.g. the reason a disabled item cannot run. */
  hint?: string
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  /** Accessible name for the menu. */
  label?: string
}

/** A small floating menu anchored at (x, y), clamped to the viewport. */
export function ContextMenu({ x, y, items, onClose, label }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let nx = x
    let ny = y
    if (x + r.width + pad > window.innerWidth) nx = window.innerWidth - r.width - pad
    if (y + r.height + pad > window.innerHeight) ny = window.innerHeight - r.height - pad
    setPos({ x: Math.max(pad, nx), y: Math.max(pad, ny) })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={(e) => e.stopPropagation()}
        role="menu"
        aria-label={label}
        className="fixed min-w-[180px] overflow-hidden rounded-card border border-border bg-card py-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.7)]"
      >
        {items.map((item, i) => (
          <div key={i}>
            {item.separated && <div className="my-1 h-px bg-border" />}
            <button
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              aria-disabled={item.disabled || undefined}
              title={item.hint}
              onClick={() => {
                if (item.disabled) return
                item.onClick()
                onClose()
              }}
              className={cn(
                'flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-1.5 text-left text-sm transition-colors',
                item.disabled
                  ? 'cursor-default text-text-secondary/50'
                  : item.danger
                    ? 'text-red-400 hover:bg-red-400/10'
                    : 'text-text-primary hover:bg-bg-secondary',
              )}
            >
              {item.checked !== undefined && (
                <Check size={14} className={cn('shrink-0', !item.checked && 'invisible')} />
              )}
              {item.icon && <item.icon size={15} className="shrink-0" />}
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}
