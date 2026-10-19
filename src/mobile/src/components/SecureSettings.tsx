/**
 * The Settings rows that need the secure mode's https origin (E3 M14):
 *  - Notifications (E3-FR-44): "Enable notifications" with authOk.pushKey in a
 *    secure context; in a Safari tab on iPhone, how to install the PWA
 *    instead. Hidden over http and where the browser has no Web Push.
 *  - Keep the screen on while watching a console (E3-FR-49): disabled over
 *    http with "Requires secure mode".
 */
import { useEffect, type ReactNode } from 'react'
import { useRemoteStore } from '../lib/store'
import { enablePush, disablePush, pushSupport, readPushEnv, syncPush, usePushStore } from '../lib/push'
import { isSecure, useWakeLockStore, wakeLockSupported } from '../lib/wakeLock'
import { PrefToggle, SettingsSection } from './SettingsScreen'
import { t } from '../lib/i18n'

export function PushSettings(): ReactNode {
  const pushKey = useRemoteStore((s) => s.pushKey)
  const state = usePushStore((s) => s.state)
  const support = pushSupport(readPushEnv(pushKey))
  // Settings opening re-reads the subscription the browser holds.
  useEffect(() => {
    if (support === 'ready') void syncPush()
  }, [support])
  if (support === 'iosBrowser') {
    return (
      <SettingsSection id="push" title={t('push.title')}>
        <p data-push-ios className="rounded-card border border-border bg-bg-secondary px-4 py-3 text-[12px] leading-relaxed text-text-secondary">
          {t('push.iosGuide')}
        </p>
      </SettingsSection>
    )
  }
  if (support !== 'ready') return null
  const hint = state === 'denied' ? t('push.denied') : state === 'failed' ? t('push.failed') : t('push.hint')
  return (
    <SettingsSection id="push" title={t('push.title')}>
      <PrefToggle
        pref="push"
        label={t('push.enable')}
        hint={hint}
        checked={state === 'on'}
        disabled={state === 'busy'}
        onChange={(on) => void (on ? enablePush() : disablePush())}
      />
    </SettingsSection>
  )
}

export function WakeLockSettings(): ReactNode {
  const pref = useWakeLockStore((s) => s.pref)
  const setPref = useWakeLockStore((s) => s.setPref)
  const available = isSecure() && wakeLockSupported()
  return (
    <SettingsSection id="screen" title={t('wake.title')}>
      <PrefToggle
        pref="wakeLock"
        label={t('wake.label')}
        hint={available ? t('wake.hint') : isSecure() ? t('wake.unsupported') : t('wake.needsSecure')}
        checked={available && pref}
        disabled={!available}
        onChange={setPref}
      />
    </SettingsSection>
  )
}
