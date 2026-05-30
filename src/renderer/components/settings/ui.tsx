import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const inputCls =
  'h-9 w-full rounded-btn border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet focus:ring-2 focus:ring-[rgba(99,102,241,0.25)]'

export const labelCls = 'mb-1 block text-xs font-medium text-text-secondary'

/** VS Code-style setting block: title + description + control. */
export function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <div className="text-sm font-medium text-text-primary">{title}</div>
        {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
      </div>
      {children}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border px-0.5 transition-colors',
        checked ? 'border-accent-violet bg-accent-violet' : 'border-border bg-bg-secondary',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-150',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  )
}

export function ToggleRow({
  checked,
  onChange,
  title,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  description?: string
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary">{title}</div>
        {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  )
}
