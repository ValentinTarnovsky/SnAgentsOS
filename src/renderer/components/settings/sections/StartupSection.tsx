import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { useAppInfo } from '@/lib/useAppInfo'
import { ToggleRow } from '../ui'

export function StartupSection() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const info = useAppInfo()
  const portable = info?.portable ?? false

  // Reflect the real OS login-item state on open (installed build only).
  useEffect(() => {
    if (portable) return
    window.snApi.system
      .getLoginItem()
      .then((enabled) => {
        if (enabled !== settings.launchOnStartup) updateSettings({ launchOnStartup: enabled })
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portable])

  const setLaunch = (v: boolean): void => {
    updateSettings({ launchOnStartup: v })
    void window.snApi.system.setLoginItem(v)
  }

  return (
    <div className="space-y-5">
      <ToggleRow
        checked={settings.restoreLastWorkspace}
        onChange={(v) => updateSettings({ restoreLastWorkspace: v })}
        title={t('settings.restoreLast')}
      />
      <ToggleRow
        checked={settings.confirmCloseRunning}
        onChange={(v) => updateSettings({ confirmCloseRunning: v })}
        title={t('settings.confirmClose')}
      />
      <ToggleRow
        checked={settings.closeToTray}
        onChange={(v) => updateSettings({ closeToTray: v })}
        title={t('settings.closeToTray')}
        description={portable ? t('settings.installedOnly') : undefined}
        disabled={portable}
      />
      <ToggleRow
        checked={settings.launchOnStartup}
        onChange={setLaunch}
        title={t('settings.launchOnStartup')}
        description={portable ? t('settings.installedOnly') : undefined}
        disabled={portable}
      />
    </div>
  )
}
