/** The remaining non-terminal connection states: connecting (initial/backoff,
 * and the pairing path with its live log and 25s ceiling, E2-FR-37), re-pair
 * (secret kept), impostor (mutual-auth failure), locked (rate limited with a
 * countdown + retry), and updated (the desktop runs another version). */
import { useEffect, useState, type ReactNode } from 'react'
import { Activity, QrCode, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react'
import { InfoScreen, PrimaryButton } from './InfoScreen'
import { LinkDeviceButton } from './ScanScreen'
import { PairLog } from './PairLog'
import { CopyReportButton, DiagnosticsScreen, useServerProbe } from './DiagnosticsScreen'
import { useRemoteStore } from '../lib/store'
import { client, PAIR_CEILING_MS } from '../lib/client'
import { openDiagnostics, useDiagStore } from '../lib/connLog'
import { t } from '../lib/i18n'
import { tierDetails, tierTitle, useConnectionHealth } from './StatusBanner'

/** Seconds left until an epoch-ms deadline, re-rendered every second. */
function useSecondsLeft(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (deadline == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [deadline])
  return deadline == null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000))
}

/** The pairing attempt got no answer in 25s (E2-FR-37): log, Retry, Copy report. */
function PairTimeoutScreen(): ReactNode {
  const { server } = useServerProbe(true)
  return (
    <InfoScreen
      tone="danger"
      icon={<WifiOff size={30} />}
      title={t('diag.pairTimeout', { s: PAIR_CEILING_MS / 1000 })}
      body={t('diag.pairTimeoutBody')}
    >
      <PairLog />
      <div data-pair-timeout className="flex flex-col gap-2">
        <PrimaryButton onClick={() => client.retry()}>{t('conn.retry')}</PrimaryButton>
        <CopyReportButton server={server} />
      </div>
    </InfoScreen>
  )
}

export function ConnectingScreen(): ReactNode {
  // Before the first snapshot there is no live screen to carry the banner, so
  // the same health tier (from attempt 3, or offline) shows here as the body.
  const health = useConnectionHealth()
  const pairCeilingAt = useDiagStore((s) => s.pairCeilingAt)
  const pairTimedOut = useDiagStore((s) => s.pairTimedOut)
  const left = useSecondsLeft(pairCeilingAt)
  if (pairTimedOut) return <PairTimeoutScreen />
  if (pairCeilingAt != null) {
    // Pairing path: the log lines arrive live under the spinner (E2-FR-37).
    return (
      <InfoScreen spinner title={t('conn.connecting')} body={t('diag.pairWaiting', { s: left })}>
        <PairLog />
      </InfoScreen>
    )
  }
  const degraded = health.tier !== 'ok' && health.tier !== 'reconnecting'
  const body = degraded ? [tierTitle(health), ...tierDetails(health)].join(' ') : undefined
  return (
    <>
      <InfoScreen spinner title={t('conn.connecting')} body={body}>
        {degraded && (
          <button
            type="button"
            data-action="diagnostics"
            onClick={openDiagnostics}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-btn border border-border bg-bg-secondary px-4 text-sm font-medium text-text-primary active:bg-card"
          >
            <Activity size={15} />
            {t('diag.open')}
          </button>
        )}
      </InfoScreen>
      <DiagnosticsScreen />
    </>
  )
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
