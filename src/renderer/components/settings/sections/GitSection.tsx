import { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Settings } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useGitStore } from '@/lib/gitStore'
import { gitChipEnabled } from '@/lib/gitChip'
import { useT } from '@/i18n'
import { SettingRow, ToggleRow } from '../ui'

/**
 * Settings > Git (E7-FR-10): the settings.gitChip switch and which git the app
 * found. Poll interval, focus refresh and the untracked budget are fixed
 * constants with no config key (shared contracts), so they are only described.
 */
export function GitSection() {
  const t = useT()
  const chipOn = useAppStore((s) => gitChipEnabled(s.settings))
  const updateSettings = useAppStore((s) => s.updateSettings)
  const info = useGitStore((s) => s.info)
  const loadInfo = useGitStore((s) => s.loadInfo)

  useEffect(() => {
    if (!info) void loadInfo()
  }, [info, loadInfo])

  // settings.gitChip is a schema 12 key; written through the generic patch.
  const setChip = (v: boolean): void => updateSettings({ gitChip: v } as unknown as Partial<Settings>)

  let diag: string
  let bad = false
  if (!info) diag = t('settings.git.checking')
  else if (!info.available) {
    diag = t('settings.git.missing')
    bad = true
  } else if (info.tooOld) {
    diag = t('settings.git.old', { version: info.version ?? '?' })
    bad = true
  } else diag = info.path ? t('settings.git.found', { version: info.version ?? '?', path: info.path }) : t('settings.git.foundNoPath', { version: info.version ?? '?' })

  return (
    <div className="space-y-6">
      <ToggleRow checked={chipOn} onChange={setChip} title={t('settings.git.chip')} description={t('settings.git.chipHint')} />
      <SettingRow title={t('settings.git.diag')} description={t('settings.git.refreshHint')}>
        <div className="flex items-center gap-3">
          <p data-git-diag className={bad ? 'min-w-0 break-all text-xs text-state-error' : 'min-w-0 break-all font-mono text-xs text-text-primary'}>
            {diag}
          </p>
          <button
            type="button"
            onClick={() => void loadInfo(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40"
          >
            <RefreshCw size={13} className="text-accent-violet" />
            {t('settings.git.recheck')}
          </button>
        </div>
      </SettingRow>
    </div>
  )
}
