import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink } from 'lucide-react'
import { useShareGuestStore } from '@/lib/shareGuestStore'
import { useT } from '@/i18n'

/** Links a shared console may open: http and https only, nothing else (file:, custom schemes...). */
export function openableUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * "Open this link?" for a link that came from a shared console (app 2.4.0,
 * item 8, S3): OSC 8 hyperlinks and detected URLs alike. The host's output
 * is untrusted (the visible text can differ from the target), so the FULL
 * URL is shown and only a click on [Open in browser] opens it. Esc cancels;
 * Enter does not confirm on purpose.
 */
export function ConfirmLinkDialog() {
  const t = useT()
  const prompt = useShareGuestStore((s) => s.linkPrompt)
  const close = useShareGuestStore((s) => s.closeLinkPrompt)

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [prompt, close])

  if (!prompt) return null
  const ok = openableUrl(prompt.url)
  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6" data-share-link-dialog>
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div role="dialog" aria-modal="true" aria-labelledby="share-link-title" className="relative z-10 w-full max-w-md overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="space-y-3 p-5">
          <h2 id="share-link-title" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <ExternalLink size={18} className="shrink-0 text-text-secondary" />
            {t('shareGuest.link.title')}
          </h2>
          <p className="text-sm text-text-secondary">{t('shareGuest.link.msg', { host: prompt.host })}</p>
          <p data-share-link-url className="max-h-32 overflow-y-auto break-all rounded-btn border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary">
            {prompt.url}
          </p>
          {!ok && <p className="text-xs text-state-error" data-share-link-blocked>{t('shareGuest.link.blocked')}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            autoFocus
            onClick={close}
            data-share-link-cancel
            className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
          >
            {t(ok ? 'common.cancel' : 'common.close')}
          </button>
          {ok && (
            <button
              data-share-link-open
              onClick={() => {
                window.snApi.system.openExternal(prompt.url)
                close()
              }}
              className="inline-flex items-center gap-2 rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110"
            >
              {t('shareGuest.link.open')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
