/**
 * iOS-style action list (E1-FR-35): an optional header (title, a grey
 * subtitle and a grey message) above one rounded group of rows separated by
 * hairlines. Each row is at least 48px tall with a 16px icon, its label, an
 * optional grey hint and a red `destructive` variant. Used by the main action
 * sheet and the per-pane actions opened with a long-press.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'

export interface ActionItem {
  id: string
  icon: ReactNode
  label: string
  hint?: string
  destructive?: boolean
  onSelect: () => void
}

export interface ActionListProps {
  title?: string
  /** Grey line under the title (the pane's workspace, for example). */
  subtitle?: string
  message?: string
  /** Leading glyph of the header (status indicator, pane icon). */
  leading?: ReactNode
  items: ActionItem[]
}

export function ActionList({ title, subtitle, message, leading, items }: ActionListProps): ReactNode {
  const hasHeader = !!(title || subtitle || message)
  return (
    <div data-action-list className="flex flex-col gap-3">
      {hasHeader && (
        <div data-action-header className="flex items-start gap-2 px-1">
          {leading && <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-text-secondary">{leading}</span>}
          <div className="flex min-w-0 flex-1 flex-col">
            {title && <span className="truncate text-sm font-semibold text-text-primary">{title}</span>}
            {subtitle && <span className="truncate text-[11px] text-text-secondary">{subtitle}</span>}
            {message && (
              <span data-action-message className="mt-1 whitespace-pre-line break-words text-xs leading-snug text-text-secondary">
                {message}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-card border border-border bg-bg-secondary">
        {items.map((item, i) => (
          <button
            key={item.id}
            data-action={item.id}
            onClick={item.onSelect}
            className={clsx(
              'flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-card',
              i > 0 && 'border-t-[0.5px] border-border',
            )}
          >
            <span className={clsx('flex h-4 w-4 shrink-0 items-center justify-center', item.destructive ? 'text-red-400' : 'text-accent-violet')}>
              {item.icon}
            </span>
            <span className={clsx('min-w-0 flex-1 truncate text-sm font-medium', item.destructive ? 'text-red-400' : 'text-text-primary')}>
              {item.label}
            </span>
            {item.hint && (
              <span data-action-hint className="min-w-0 max-w-[45%] truncate text-xs text-text-secondary">
                {item.hint}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
