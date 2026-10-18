/** The remaining non-terminal connection states: connecting (initial/backoff),
 * re-pair (secret kept), impostor (mutual-auth failure), locked (rate limited
 * with a countdown + retry), and updated (the desktop runs another version). */
import { useEffect, useState, type ReactNode } from 'react'
import { QrCode, RefreshCw, ShieldAlert } from 'lucide-react'
import { InfoScreen, PrimaryButton } from './InfoScreen'
import { LinkDeviceButton } from './ScanScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'
import { tierDetails, tierTitle, useConnectionHealth } from './StatusBanner'

export function ConnectingScreen(): ReactNode {
  // Before the first snapshot there is no live screen to carry the banner, so
  // the same health tier (from attempt 3, or offline) shows here as the body.
  const health = useConnectionHealth()
  const degraded = health.tier !== 'ok' && health.tier !== 'reconnecting'
  const body = degraded ? [tierTitle(health), ...tierDetails(health)].join(' ') : undefined
  return <InfoScreen spinner title={t('conn.connecting')} body={body} />
}

/**
 * The desktop runs another version than this bundle (E1-FR-15). The socket is
 * closed and reconnection is off; Reload fetches the new bundle (the server
 * sends it with no-cache). Continue anyway exists only for a plain version
 * mismatch: a protocol error means this bundle cannot talk to the desktop.
 */
export function UpdatedScreen(): ReactNode {
  const info = useRemoteStore((s) => s.updateInfo)
  const title =
    info && info.from && info.to
      ? t('updated.title', { a: info.from, b: info.to })
      : t('updated.titleUnknown')
  const body = [
    t(info?.kind === 'protocol' ? 'updated.protocolBody' : 'updated.body'),
    info?.retried ? t('updated.retried') : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <InfoScreen tone="accent" icon={<RefreshCw size={30} />} title={title} body={body}>
      <PrimaryButton onClick={() => location.reload()}>{t('updated.reload')}</PrimaryButton>
      {info?.kind === 'mismatch' && (
        <button
          type="button"
          data-action="continue"
          onClick={() => client.continueAnyway()}
          className="mt-3 h-11 w-full rounded-btn px-4 text-sm font-medium text-text-secondary active:bg-card"
        >
          {t('updated.continue')}
        </button>
      )}
    </InfoScreen>
  )
}

export function RePairScreen(): ReactNode {
  return (
    <InfoScreen
      tone="accent"
      icon={<QrCode size={30} />}
      title={t('conn.rePair')}
      body={t('conn.rePairBody')}
    >
      <LinkDeviceButton />
    </InfoScreen>
  )
}

export function ImpostorScreen(): ReactNode {
  return (
    <InfoScreen
      tone="danger"
      icon={<ShieldAlert size={30} />}
      title={t('conn.impostor')}
      body={t('conn.impostorBody')}
    />
  )
}

export function LockedScreen(): ReactNode {
  const lockUntil = useRemoteStore((s) => s.lockUntil)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])
  const remaining = lockUntil ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0
  return (
    <InfoScreen
      tone="danger"
      icon={<ShieldAlert size={30} />}
      title={t('conn.locked')}
      body={t('conn.lockedBody', { s: remaining })}
    >
      <PrimaryButton onClick={() => client.retry()} disabled={remaining > 0}>
        {t('conn.retry')}
      </PrimaryButton>
    </InfoScreen>
  )
}
