/**
 * Home empty states (E2-FR-15): a workspace without consoles shows "No
 * consoles" and a primary "New console" that opens the picker on that
 * workspace; a snapshot without workspaces shows a hero that points to the PC.
 */
import type { ReactNode } from 'react'
import { LayoutGrid, Plus } from 'lucide-react'
import { t } from '../../lib/i18n'

export function NoConsoles({ onNew }: { onNew: () => void }): ReactNode {
  return (
    <div data-empty-consoles className="flex items-center justify-between gap-3 rounded-btn border border-dashed border-border px-3 py-3">
      <span className="text-sm text-text-secondary">{t('empty.noConsoles')}</span>
      <button
        data-empty-new
        onClick={onNew}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-btn bg-accent-violet px-3 text-sm font-semibold text-white active:brightness-110"
      >
        <Plus size={16} />
        {t('act.newConsole')}
      </button>
    </div>
  )
}

export function NoWorkspaces(): ReactNode {
  return (
    <div data-empty-workspaces className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-card text-text-secondary">
        <LayoutGrid size={26} />
      </div>
      <p className="text-sm leading-relaxed text-text-secondary">{t('empty.noWorkspaces')}</p>
    </div>
  )
}
