import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Smartphone } from 'lucide-react'
import { useRemoteStore } from '@/lib/remoteStore'
import { useT } from '@/i18n'

/**
 * Global Allow/Deny prompt for an incoming pairing request. Security prompt:
 * Enter does NOT auto-confirm - the user must click Allow explicitly.
 */
export function RemotePairingPrompt() {
  const t = useT()
  const pending = useRemoteStore((s) => s.pendingPairing)
  const approve = useRemoteStore((s) => s.approve)
  const deny = useRemoteStore((s) => s.deny)

  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [pending])

  if (!pending) return null

  const secondsLeft = Math.max(0, Math.ceil((pending.expiresAt - now) / 1000))

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative z-10 w-full max-w-sm overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="flex flex-col items-center gap-3 px-6 pb-4 pt-6 text-center">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] text-white">
            <Smartphone size={20} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-text-primary">{t('remote.pairing.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t('remote.pairing.wants', { name: pending.deviceName })}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span className="rounded-btn border border-border bg-bg-secondary px-2 py-0.5 font-mono">
              {pending.ip}
            </span>
            <span>{t('remote.pairing.expiresIn', { seconds: secondsLeft })}</span>
          </div>
        </div>

        <div className="flex justify-center gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            onClick={deny}
            className="rounded-btn bg-red-500 px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110"
          >
            {t('remote.pairing.deny')}
          </button>
          <button
            onClick={approve}
            className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110"
          >
            {t('remote.pairing.allow')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
