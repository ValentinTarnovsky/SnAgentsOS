import { useState } from 'react'
import { useAppStore } from '@/lib/store'
import { useTeamsStore } from '@/lib/teamsStore'
import { useT } from '@/i18n'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ToggleRow } from '../ui'

/**
 * Settings > Labs (app 2.7.0): opt-in experimental modules (settings.labs,
 * @shared/labs), each off until turned on here. One literal row per flag:
 * the catalog integrity check counts literal searchId attributes. Turning
 * Teams off while team runs are live asks first (E10 B2, decision 57): main
 * stops them as interrupted.
 */
export function LabsSection() {
  const t = useT()
  const labs = useAppStore((s) => s.settings.labs)
  const updateSettings = useAppStore((s) => s.updateSettings)
  // Live runs of every team, as the sidebar list counts them.
  const running = useTeamsStore((s) => s.list.reduce((n, team) => n + (team.running > 0 ? team.running : 0), 0))
  const [confirmOff, setConfirmOff] = useState(0)

  // The labs of the moment: the confirm may resolve after another toggle changed them.
  const setTeams = (v: boolean): void => updateSettings({ labs: { ...useAppStore.getState().settings.labs, teams: v } })

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
        onChange={(v) => {
          if (!v && labs.teams && running > 0) setConfirmOff(running)
          else setTeams(v)
        }}
        title={t('labs.teams')}
        description={t('labs.teamsHint')}
      />
      <ConfirmDialog
        open={confirmOff > 0}
        title={t('teams.run.labsOffTitle')}
        message={confirmOff === 1 ? t('teams.run.labsOffMsgOne') : t('teams.run.labsOffMsg', { count: confirmOff })}
        confirmLabel={t('teams.run.labsOffYes')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          setConfirmOff(0)
          setTeams(false)
        }}
        onCancel={() => setConfirmOff(0)}
      />
    </div>
  )
}
