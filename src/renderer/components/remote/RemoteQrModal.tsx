import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, RefreshCw, Smartphone, X } from 'lucide-react'
import type { RemoteEndpointKind } from '@shared/remote-protocol'
import { useRemoteStore } from '@/lib/remoteStore'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'

const KIND_KEY: Record<RemoteEndpointKind, MessageKey> = {
  lan: 'remote.kind.lan',
  tailscale: 'remote.kind.tailscale',
  other: 'remote.kind.other',
}

/**
 * Pairing QR modal. Shows one QR per reachable endpoint (selectable), the
 * shared code, the URL, and a countdown that regenerates the code when it
 * expires while open. Closing invalidates the active code.
 */
export function RemoteQrModal() {
  const t = useT()
  const open = useRemoteStore((s) => s.qrOpen)
  const qr = useRemoteStore((s) => s.qr)
  const refreshQr = useRemoteStore((s) => s.refreshQr)
  const cancelQr = useRemoteStore((s) => s.cancelQr)

  const [sel, setSel] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  // Tick the countdown once a second while open.
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open])

  // Regenerate the code once it expires while the modal stays open.
  useEffect(() => {
    if (!open || !qr) return
    if (now >= qr.expiresAt) void refreshQr()
  }, [open, qr, now, refreshQr])

  // Keep the endpoint selection valid across regenerations.
  useEffect(() => {
    if (qr && sel >= qr.endpoints.length) setSel(0)
  }, [qr, sel])

  // Esc closes (and cancels the code).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelQr()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, cancelQr])

  if (!open) return null

  const endpoint = qr?.endpoints[sel] ?? qr?.endpoints[0] ?? null
  const secondsLeft = qr ? Math.max(0, Math.ceil((qr.expiresAt - now) / 1000)) : 0

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={cancelQr} />
      <div className="relative z-10 flex w-full max-w-sm flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] text-white">
              <Smartphone size={16} />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">{t('remote.qr.title')}</h2>
              <p className="text-xs text-text-secondary">{t('remote.qr.scanHint')}</p>
            </div>
          </div>
          <button
            onClick={cancelQr}
            className="text-text-secondary transition-colors hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {qr && qr.endpoints.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {qr.endpoints.map((ep, i) => (
                <button
                  key={ep.url}
                  onClick={() => setSel(i)}
                  className={cn(
                    'rounded-btn border px-2.5 py-1 text-xs transition-colors',
                    i === sel
                      ? 'border-accent-violet bg-accent-violet/10 text-text-primary'
                      : 'border-border text-text-secondary hover:text-text-primary',
                  )}
                >
                  {t(KIND_KEY[ep.kind])} · {ep.ip}
                </button>
              ))}
            </div>
          )}

          <div className="flex justify-center">
            {endpoint ? (
              <img
                src={endpoint.qrDataUrl}
                alt={t('remote.qr.title')}
                className="h-56 w-56 rounded-card border border-border bg-white p-2"
              />
            ) : (
              <div className="grid h-56 w-56 place-items-center rounded-card border border-border bg-bg-secondary text-text-secondary">
                <RefreshCw size={20} className="animate-spin" />
              </div>
            )}
          </div>

          {qr && (
            <>
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-wide text-text-secondary">
                  {t('remote.qr.code')}
                </div>
                <div className="mt-0.5 font-mono text-lg font-semibold tracking-[0.2em] text-text-primary">
                  {qr.code}
                </div>
              </div>

              {endpoint && (
                <div className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
                    {endpoint.url}
                  </span>
                  <button
                    onClick={() => window.snApi.clipboard.writeText(endpoint.url)}
                    title={t('remote.copy')}
                    className="shrink-0 rounded p-1 text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              )}

              <div className="flex items-center justify-between text-xs text-text-secondary">
                <span>
                  {secondsLeft > 0
                    ? t('remote.qr.expiresIn', { seconds: secondsLeft })
                    : t('remote.qr.expired')}
                </span>
                <button
                  onClick={() => void refreshQr()}
                  className="flex items-center gap-1.5 rounded-btn border border-border px-2 py-1 text-text-primary transition-colors hover:border-accent-violet/40"
                >
                  <RefreshCw size={13} />
                  {t('remote.qr.regenerate')}
                </button>
              </div>
            </>
          )}

          <p className="text-[11px] leading-relaxed text-text-secondary">
            {t('remote.qr.tailscaleHint')}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
