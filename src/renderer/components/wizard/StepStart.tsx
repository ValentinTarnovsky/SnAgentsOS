import { Folder, FolderOpen } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { iconFor } from '@/lib/icons'
import type { StepProps } from './types'

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
}

export function StepStart({ draft, update }: StepProps) {
  const t = useT()
  const workspaces = useAppStore((s) => s.workspaces)
  const recent = [...workspaces].reverse().slice(0, 6)

  const browse = async (): Promise<void> => {
    const dir = await window.snApi.dialog.openDirectory()
    if (dir) update({ cwd: dir, name: draft.name.trim() ? draft.name : basename(dir) })
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1.5 flex items-baseline gap-2">
          <label className="text-sm font-medium text-text-primary">{t('wizard.workingFolder')}</label>
          <span className="text-xs text-text-secondary">{t('wizard.workingFolderHint')}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-btn border border-border bg-bg-primary px-3 py-2">
            <Folder size={15} className="shrink-0 text-accent-violet" />
            <input
              value={draft.cwd}
              onChange={(e) => update({ cwd: e.target.value })}
              placeholder={t('wizard.folderPlaceholder')}
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-secondary"
            />
          </div>
          <button
            onClick={browse}
            className="flex shrink-0 items-center gap-1.5 rounded-btn border border-border bg-card px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent-violet/40"
          >
            <FolderOpen size={15} className="text-accent-violet" />
            {t('common.browse')}
          </button>
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-text-primary">
          {t('wizard.name')}
        </label>
        <input
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder={draft.cwd ? basename(draft.cwd) : 'workspace'}
          className="w-full rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet/50 placeholder:text-text-secondary"
        />
      </div>

      {recent.length > 0 && (
        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {t('wizard.recent')}
          </label>
          <div className="grid grid-cols-2 gap-2">
            {recent.map((w) => {
              const Icon = iconFor(w.panes[0]?.icon)
              return (
                <button
                  key={w.id}
                  onClick={() => update({ cwd: w.cwd, name: w.name })}
                  className="flex min-w-0 items-center gap-2.5 rounded-btn border border-border bg-bg-primary px-3 py-2 text-left transition-colors hover:border-accent-violet/40"
                >
                  <Icon size={16} className="shrink-0 text-accent-violet" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text-primary">{w.name}</span>
                    <span className="block truncate font-mono text-[11px] text-text-secondary">
                      {w.cwd}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
