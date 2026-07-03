/** The remaining non-terminal connection states: connecting (initial/backoff),
 * re-pair (secret kept), impostor (mutual-auth failure), and locked (rate
 * limited with a countdown + retry). */
import { useEffect, useState, type ReactNode } from 'react'
import { QrCode, ShieldAlert } from 'lucide-react'
import { InfoScreen, PrimaryButton } from './InfoScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'

export function ConnectingScreen(): ReactNode {
  return <InfoScreen spinner title={t('conn.connecting')} />
}

export function RePairScreen(): ReactNode {
  return (
    <InfoScreen
      tone="accent"
      icon={<QrCode size={30} />}
      title={t('conn.rePair')}
      body={t('conn.rePairBody')}
    />
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
