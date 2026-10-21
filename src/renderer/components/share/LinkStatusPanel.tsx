import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { SharePasswordRes, ShareLinkView } from '@shared/share-guest'
import { SHARE_LIMITS } from '@shared/share-protocol'
import { Button } from '@/components/ui/Button'
import { useT, type MessageKey } from '@/i18n'
import { linkStatusText } from './shareLabels'

const PW_ERR_KEY: Record<Extract<SharePasswordRes, { ok: false }>['error'], MessageKey> = {
  not_pending: 'shareGuest.join.pwErr.not_pending',
  invalid: 'shareGuest.join.pwErr.invalid',
  offline: 'shareGuest.join.pwErr.offline',
  failed: 'shareGuest.join.pwErr.failed',
}

/** Seconds until `at`, refreshed every second while mounted. */
function useSecondsLeft(at: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (at === undefined) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [at])
  return at === undefined ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

/**
 * What a link that is not streaming shows (app 2.4.0, item 8, S3): the
 * approval wait with its countdown and the optional password, the retry
 * countdown, or why it ended with [Connect]. Used by JoinShareDialog after
 * Join and by the shared view while it has nothing to draw.
 */
export function LinkStatusPanel({ link }: { link: ShareLinkView }) {
  const t = useT()
  const api = window.snApi.share.guest
  const [pw, setPw] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pwErr, setPwErr] = useState<MessageKey | null>(null)
  const pending = link.pending
  const waiting = link.status === 'waiting_approval' || link.status === 'password_required'
  const left = useSecondsLeft(waiting ? pending?.expiresAt : link.status === 'reconnecting' ? link.retryAt : undefined)

  const sendPassword = async (): Promise<void> => {
    if (pw.length < SHARE_LIMITS.passwordMin || busy) return
    setBusy(true)
    setPwErr(null)
    try {
      const r = await api.password({ linkId: link.id, password: pw, remember })
      if (!r.ok) setPwErr(PW_ERR_KEY[r.error])
      else setPw('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-link-panel={link.status} className="flex w-full max-w-sm flex-col gap-3">
      <div className="flex items-center gap-2 text-sm text-text-primary">
        {(link.status === 'connecting' || link.status === 'reconnecting' || waiting) && <Loader2 size={16} className="shrink-0 animate-spin text-text-secondary motion-reduce:animate-none" />}
        <span data-link-panel-text>{waiting ? t('shareGuest.join.waiting', { host: link.host?.label ?? link.hostLabel }) : linkStatusText(link, t)}</span>
      </div>
      {waiting && left !== null && <p className="text-xs text-text-secondary">{t('shareGuest.join.secondsLeft', { seconds: left })}</p>}
      {link.status === 'reconnecting' && left !== null && <p className="text-xs text-text-secondary">{t('shareGuest.join.retryIn', { seconds: left })}</p>}
      <p className="text-[11px] text-text-secondary">
        {t('shareGuest.join.fingerprint')}: <span className="font-mono">{link.hostFingerprint}</span>
      </p>
      {waiting && pending?.password && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void sendPassword()
          }}
        >
          <p className="text-xs text-text-secondary">{t('shareGuest.join.passwordHint')}</p>
          {(pending.passwordFailed || link.status === 'password_required') && (
            <p className="text-xs text-state-error" data-link-pw-wrong>
              {t('shareGuest.join.passwordWrong')}
            </p>
          )}
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('shareGuest.join.password')}
            <input
              type="password"
              data-link-password
              autoComplete="off"
              value={pw}
              maxLength={SHARE_LIMITS.passwordMax}
              onChange={(e) => setPw(e.target.value)}
              className="h-9 rounded-btn border border-border bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent-violet/60"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('shareGuest.join.remember')}
          </label>
          {pwErr && <p className="text-xs text-state-error">{t(pwErr)}</p>}
          <div>
            <Button size="sm" type="submit" disabled={busy || pw.length < SHARE_LIMITS.passwordMin} data-link-pw-send>
              {t('shareGuest.join.sendPassword')}
            </Button>
          </div>
        </form>
      )}
      {(link.status === 'idle' || link.status === 'ended' || link.status === 'reconnecting') && (
        <div>
          <Button size="sm" variant={link.status === 'reconnecting' ? 'ghost' : 'primary'} data-link-connect onClick={() => void api.connect(link.id)}>
            {t(link.status === 'idle' ? 'shareGuest.view.connect' : 'shareGuest.join.retry')}
          </Button>
        </div>
      )}
    </div>
  )
}
