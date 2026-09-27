import { useEffect, useState } from 'react'
import type { NotificationSettings, StatusHealth, DiscordSettings } from '@shared/types'
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
  const [health, setHealth] = useState<StatusHealth | null>(null)
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)

  useEffect(() => {
    window.snApi.status
      .hooksStatus()
      .then((res) => {
        setHooksInstalled(res.installed)
        setHooksPath(res.settingsPath)
      })
      .catch(() => setHooksInstalled(false))
  }, [])
  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.snApi.status.health().then(h => { if (alive) setHealth(h) }).catch(() => {}) }
    refresh()
    const timer = setInterval(refresh, 2500)
    return () => { alive = false; clearInterval(timer) }
  }, [n.hooksEnabled, n.codexEnabled])

  const patch = (p: Partial<NotificationSettings>): void => {
    updateSettings({ notifications: { ...useAppStore.getState().settings.notifications, ...p } })
  }
  const patchDiscord = (p: Partial<DiscordSettings>): void => { setTestResult(null); patch({ discord: { ...useAppStore.getState().settings.notifications.discord, ...p } }) }

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
      patch({ hooksEnabled: true, hookToken: cfg.hookToken })
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
      patch({ hooksEnabled: false })
      setHooksInstalled(res.installed)
    } catch (error) {
      setHooksError(String(error))
    } finally {
      setHooksBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {(!n.hooksEnabled || !n.codexEnabled) && <p className="rounded-btn border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-text-secondary">{t('notif.integrationHint')}</p>}
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
      <Button variant="ghost" size="sm" onClick={() => {
        void window.snApi.status.testDesktop().catch(() => setHealth(h => h ? { ...h, desktop: { error: 'failed' } } : h))
      }}>{t('notif.desktop.test')}</Button>
      {health?.desktop?.error && <p role="status" className="text-xs text-amber-500">{t(`notif.desktop.${health.desktop.error}`)}</p>}
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
        <div className="flex flex-wrap items-end gap-3">
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
          <div className="min-w-24 flex-1">
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
              variant="primary"
              size="sm"
              disabled={hooksBusy || hooksInstalled === null}
              onClick={() => void installHooks()}
            >
              {hooksInstalled ? t('notif.hooks.repair') : t('notif.hooks.install')}
            </Button>
            {hooksInstalled && <Button variant="ghost" size="sm" disabled={hooksBusy} onClick={() => void uninstallHooks()}>{t('notif.hooks.uninstall')}</Button>}
          </div>
          <p className="text-xs text-text-secondary">{!n.hooksEnabled ? t('notif.health.disabled') : !health?.claude.complete || !health.claude.running ? t('notif.health.incomplete') : health.claude.lastEventAt ? t('notif.health.live') : t('notif.health.waiting')}</p>
          {health?.claude.error && <p className="text-xs text-red-400">{health.claude.error}</p>}
          {hooksPath && <p className="break-all text-xs text-text-secondary/70">{hooksPath}</p>}
          {hooksError && <p className="text-xs text-red-400">{hooksError}</p>}
        </SettingRow>
      </div>
      <div className="space-y-3 border-t border-border pt-5">
        <ToggleRow checked={n.codexEnabled} onChange={v => patch({ codexEnabled: v })} title={t('notif.codex.title')} description={t('notif.codex.desc')} />
        <p className="text-xs text-text-secondary">{!n.codexEnabled ? t('notif.health.disabled') : health?.codex.connected ? t('notif.codex.connected', { count: health.codex.connected }) : t('notif.health.waiting')}</p>
        {n.codexEnabled && health?.codex.error && <p className="text-xs text-red-400">{health.codex.error}</p>}
      </div>
      <div className="space-y-3 border-t border-border pt-5">
        <ToggleRow checked={n.discord.enabled} onChange={v => patchDiscord({ enabled: v })} title={t('notif.discord.title')} description={t('notif.discord.desc')} />
        <label className={labelCls} htmlFor="discord-webhook">{t('notif.discord.url')}</label>
        <input id="discord-webhook" type="password" autoComplete="off" spellCheck={false} maxLength={2048} value={n.discord.webhookUrl} onChange={e => patchDiscord({ webhookUrl: e.target.value.trim() })} className={inputCls} placeholder="https://discord.com/api/webhooks/..." />
        <label className={labelCls} htmlFor="discord-user">{t('notif.discord.user')}</label>
        <input id="discord-user" inputMode="numeric" maxLength={20} value={n.discord.userId} onChange={e => patchDiscord({ userId: e.target.value.trim() })} className={inputCls} />
        <p className="text-xs text-text-secondary">{t('notif.discord.userHint')}</p>
        <ToggleRow checked={n.discord.notifyAction} onChange={v => patchDiscord({ notifyAction: v })} title={t('notif.action')} disabled={!n.discord.enabled} />
        <ToggleRow checked={n.discord.notifyDone} onChange={v => patchDiscord({ notifyDone: v })} title={t('notif.done')} disabled={!n.discord.enabled} />
        <Button variant="ghost" size="sm" disabled={testBusy || !n.discord.webhookUrl.trim()} onClick={() => {
          setTestBusy(true); setTestResult(null)
          void window.snApi.status.testDiscord(n.discord).then(setTestResult).catch(() => setTestResult({ ok: false, error: t('notif.discord.failed') })).finally(() => setTestBusy(false))
        }}>{testBusy ? t('notif.discord.sending') : t('notif.discord.test')}</Button>
        {testResult && <p role="status" className={`break-words text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>{testResult.ok ? t('notif.discord.sent') : testResult.error}</p>}
        {health?.discord.error && !testResult && <p className="break-words text-xs text-red-400">{health.discord.error}</p>}
        <p className="text-xs text-text-secondary">{t('notif.discord.privacy')}</p>
      </div>
    </div>
  )
}
