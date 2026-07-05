import { useEffect, useState } from 'react'
import type { NotificationSettings } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { playStatusSound } from '@/lib/sound'
import { inputCls, labelCls, SettingRow, ToggleRow } from '../ui'
import { Button } from '@/components/ui/Button'

function randomToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function NotificationsSection() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const n = settings.notifications

  const [hooksInstalled, setHooksInstalled] = useState<boolean | null>(null)
  const [hooksPath, setHooksPath] = useState('')
  const [hooksBusy, setHooksBusy] = useState(false)
  const [hooksError, setHooksError] = useState('')

  useEffect(() => {
    window.snApi.status
      .hooksStatus()
      .then((res) => {
        setHooksInstalled(res.installed)
        setHooksPath(res.settingsPath)
      })
      .catch(() => setHooksInstalled(false))
  }, [])

  const patch = (p: Partial<NotificationSettings>): void => {
    updateSettings({ notifications: { ...n, ...p } })
  }

  const installHooks = async (): Promise<void> => {
    setHooksBusy(true)
    setHooksError('')
    try {
      const cfg: NotificationSettings = {
        ...n,
        hooksEnabled: true,
        hookToken: n.hookToken || randomToken(),
      }
      const res = await window.snApi.status.hooksInstall(cfg)
      updateSettings({ notifications: cfg })
      setHooksInstalled(res.installed)
      setHooksPath(res.settingsPath)
    } catch (error) {
      setHooksError(String(error))
    } finally {
      setHooksBusy(false)
    }
  }

  const uninstallHooks = async (): Promise<void> => {
    setHooksBusy(true)
    setHooksError('')
    try {
      const res = await window.snApi.status.hooksUninstall()
      updateSettings({ notifications: { ...n, hooksEnabled: false } })
      setHooksInstalled(res.installed)
    } catch (error) {
      setHooksError(String(error))
    } finally {
      setHooksBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <ToggleRow
        checked={n.enabled}
        onChange={(v) => patch({ enabled: v })}
        title={t('notif.enabled')}
        description={t('notif.enabledHint')}
      />
      <ToggleRow
        checked={n.notifyDone}
        onChange={(v) => patch({ notifyDone: v })}
        title={t('notif.done')}
        disabled={!n.enabled}
      />
      <ToggleRow
        checked={n.notifyAction}
        onChange={(v) => patch({ notifyAction: v })}
        title={t('notif.action')}
        disabled={!n.enabled}
      />
      <ToggleRow
        checked={n.flashTaskbar}
        onChange={(v) => patch({ flashTaskbar: v })}
        title={t('notif.flash')}
        disabled={!n.enabled}
      />

      <div className="space-y-3 border-t border-border pt-5">
        <ToggleRow
          checked={n.sound}
          onChange={(v) => patch({ sound: v })}
          title={t('notif.sound')}
          disabled={!n.enabled}
        />
        <div className="flex items-end gap-3">
          <div className="w-40">
            <label className={labelCls}>{t('notif.soundId')}</label>
            <select
              value={n.soundId}
              disabled={!n.enabled || !n.sound}
              onChange={(e) => patch({ soundId: e.target.value as NotificationSettings['soundId'] })}
              className={inputCls}
            >
              <option value="chime">{t('notif.sound.chime')}</option>
              <option value="ping">{t('notif.sound.ping')}</option>
              <option value="pop">{t('notif.sound.pop')}</option>
            </select>
          </div>
          <div className="flex-1">
            <label className={labelCls}>{t('notif.volume', { volume: n.volume })}</label>
            <input
              type="range"
              min={0}
              max={100}
              value={n.volume}
              disabled={!n.enabled || !n.sound}
              onChange={(e) => patch({ volume: Number(e.target.value) })}
              className="h-9 w-full accent-accent-violet"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!n.enabled || !n.sound}
            onClick={() => playStatusSound(n.soundId, n.volume)}
          >
            {t('notif.test')}
          </Button>
        </div>
      </div>

      <div className="space-y-3 border-t border-border pt-5">
        <SettingRow title={t('notif.hooks.title')} description={t('notif.hooks.desc')}>
          <div className="flex items-center gap-3">
            <Button
              variant={hooksInstalled ? 'ghost' : 'primary'}
              size="sm"
              disabled={hooksBusy || hooksInstalled === null}
              onClick={() => void (hooksInstalled ? uninstallHooks() : installHooks())}
            >
              {hooksInstalled ? t('notif.hooks.uninstall') : t('notif.hooks.install')}
            </Button>
            {hooksInstalled && (
              <span className="text-xs text-emerald-400">{t('notif.hooks.installed')}</span>
            )}
          </div>
          {hooksPath && <p className="text-xs text-text-secondary/70">{hooksPath}</p>}
          {hooksError && <p className="text-xs text-red-400">{hooksError}</p>}
        </SettingRow>
      </div>
    </div>
  )
}
