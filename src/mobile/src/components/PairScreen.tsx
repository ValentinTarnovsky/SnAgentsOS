/**
 * Pairing flow UI. Covers three store phases:
 *  - pairForm:    editable device name + Connect button
 *  - pairPending: waiting-for-approval with a 60s countdown
 *  - pairDenied:  denied/expired/badCode/limit with a re-scan hint
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Smartphone, Clock, ShieldX } from 'lucide-react'
import { InfoScreen, PrimaryButton } from './InfoScreen'
import { LinkDeviceButton } from './ScanScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'

/** Best-effort default device name from the user agent. */
function defaultDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  return 'Phone'
}

function useCountdown(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (deadline == null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [deadline])
  if (deadline == null) return 0
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function PairScreen(): ReactNode {
  const phase = useRemoteStore((s) => s.phase)
  const pairReason = useRemoteStore((s) => s.pairReason)
  const pairExpiresAt = useRemoteStore((s) => s.pairExpiresAt)
  const [name, setName] = useState(defaultDeviceName)
  const remaining = useCountdown(pairExpiresAt)

  if (phase === 'pairPending') {
    return (
      <InfoScreen
        tone="accent"
        icon={<Clock size={30} />}
        title={t('pair.pending')}
        body={t('pair.pendingBody')}
      >
        {remaining > 0 && <p className="text-sm font-medium text-text-secondary">{remaining}s</p>}
      </InfoScreen>
    )
  }

  if (phase === 'pairDenied') {
    const key =
      pairReason === 'expired'
        ? 'pair.expired'
        : pairReason === 'limit'
          ? 'pair.limit'
          : pairReason === 'badCode'
            ? 'pair.badCode'
            : 'pair.denied'
    return (
      <InfoScreen tone="danger" icon={<ShieldX size={30} />} title={t(key)} body={t('pair.rescan')}>
        <LinkDeviceButton />
      </InfoScreen>
    )
  }

  // pairForm
  const submit = (): void => {
    const clean = name.trim().slice(0, 48) || defaultDeviceName()
    client.submitPairing(clean)
  }
  return (
    <InfoScreen tone="accent" icon={<Smartphone size={30} />} title={t('pair.title')}>
      <label className="mb-2 block text-left text-xs font-medium text-text-secondary">
        {t('pair.nameLabel')}
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('pair.namePlaceholder')}
        maxLength={48}
        autoCapitalize="words"
        className="mb-4 h-12 w-full rounded-btn border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none focus:border-accent-violet"
      />
      <PrimaryButton onClick={submit} disabled={name.trim().length === 0}>
        {t('pair.connect')}
      </PrimaryButton>
    </InfoScreen>
  )
}
