import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { settingDomId } from './searchCatalog'

export const inputCls =
  'h-9 w-full rounded-btn border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet focus:ring-2 focus:ring-[rgba(99,102,241,0.25)]'

export const labelCls = 'mb-1 block text-xs font-medium text-text-secondary'

/** Deep-link target attributes for a row with a catalog id (E4-FR-27). */
function anchorProps(searchId: string | undefined): { id?: string; 'data-setting-id'?: string } {
  return searchId ? { id: settingDomId(searchId), 'data-setting-id': searchId } : {}
}

/** VS Code-style setting block: title + description + control. */
export function SettingRow({
  title,
  description,
  searchId,
  children,
}: {
  title: string
  description?: string
  /** Catalog id ('<category>.<key>', searchCatalog.ts): makes the row searchable and deep-linkable. */
  searchId?: string
  children?: ReactNode
}) {
  return (
    <div {...anchorProps(searchId)} className="scroll-mt-6 space-y-1.5 rounded-btn">
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
  searchId,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  description?: string
  disabled?: boolean
  /** Catalog id ('<category>.<key>', searchCatalog.ts): makes the row searchable and deep-linkable. */
  searchId?: string
}) {
  return (
    <div {...anchorProps(searchId)} className="flex scroll-mt-6 items-start justify-between gap-4 rounded-btn">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary">{title}</div>
        {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  )
}

/**
 * A static row of the settings search (E4-FR-26): title, description and an
 * optional breadcrumb, no effects. Clicking it deep-links to the live row or,
 * for a custom block (summary), to its category. `control` (an inline switch)
 * keeps its own click.
 */
export function SearchSummaryRow({
  id,
  title,
  description,
  crumb,
  control,
  openLabel,
  onOpen,
}: {
  id: string
  title: ReactNode
  description?: ReactNode
  crumb?: ReactNode
  control?: ReactNode
  openLabel: string
  onOpen: () => void
}) {
  return (
    <div data-search-result={id} className="flex items-start gap-3 rounded-btn px-2 py-2 transition-colors hover:bg-bg-secondary/60">
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        className="flex min-w-0 flex-1 items-start gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-violet"
      >
        <span className="min-w-0 flex-1">
          {crumb && <span className="mb-0.5 block text-[11px] text-text-secondary/80">{crumb}</span>}
          <span className="block text-sm font-medium text-text-primary">{title}</span>
          {description && <span className="mt-0.5 block text-xs text-text-secondary">{description}</span>}
        </span>
        {!control && <ChevronRight size={15} className="mt-0.5 shrink-0 text-text-secondary" />}
      </button>
      {control && <div className="shrink-0 pt-0.5">{control}</div>}
    </div>
  )
}
