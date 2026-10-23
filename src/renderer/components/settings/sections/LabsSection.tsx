import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { ToggleRow } from '../ui'

/**
 * Settings > Labs (app 2.7.0): opt-in experimental modules (settings.labs,
 * @shared/labs), each off until turned on here. One literal row per flag:
 * the catalog integrity check counts literal searchId attributes.
 */
export function LabsSection() {
  const t = useT()
  const labs = useAppStore((s) => s.settings.labs)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <div className="space-y-6">
      <p className="text-xs text-text-secondary">{t('labs.intro')}</p>
      <ToggleRow
        searchId="labs.consoleChat"
        checked={labs.consoleChat}
        onChange={(v) => updateSettings({ labs: { ...labs, consoleChat: v } })}
        title={t('labs.consoleChat')}
        description={t('labs.consoleChatHint')}
      />
      <ToggleRow
        searchId="labs.teams"
        checked={labs.teams}
        onChange={(v) => updateSettings({ labs: { ...labs, teams: v } })}
        title={t('labs.teams')}
        description={t('labs.teamsHint')}
      />
    </div>
  )
}
