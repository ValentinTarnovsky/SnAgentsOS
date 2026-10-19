/**
 * "A secure version is available [Open]" (E3-FR-43). Shown on Home while this
 * page is plain http and the desktop's secure mode is on (authOk.secureUrl).
 * The https address is another origin, so the phone pairs again there; the
 * card says so. [x] hides it for that address on this phone
 * ('snagentsos.remote.secureCardDismissed').
 */
import { useState, type ReactNode } from 'react'
import { Lock, X } from 'lucide-react'
import { useRemoteStore } from '../../lib/store'
import { STORAGE_PREFIX, storageGet, storageSet } from '../../lib/mobileStorage'
import { t } from '../../lib/i18n'

export const SECURE_CARD_KEY = `${STORAGE_PREFIX}remote.secureCardDismissed`

/** Whether the card shows (pure, for the tests). */
export function showSecureCard(secureUrl: string | null, secureContext: boolean, dismissed: string | null): boolean {
  return !!secureUrl && !secureContext && dismissed !== secureUrl
}

function isSecurePage(): boolean {
  try {
    return window.isSecureContext === true && location.protocol === 'https:'
  } catch {
    return false
  }
}

export function SecureCard(): ReactNode {
  const secureUrl = useRemoteStore((s) => s.secureUrl)
  const [dismissed, setDismissed] = useState(() => storageGet(SECURE_CARD_KEY))
  if (!showSecureCard(secureUrl, isSecurePage(), dismissed) || !secureUrl) return null
  return (
    <section data-secure-card className="mb-4 flex items-start gap-3 rounded-card border border-accent-violet/40 bg-bg-secondary px-3 py-3">
      <Lock size={18} className="mt-0.5 shrink-0 text-accent-violet" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary">{t('secure.card.title')}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">{t('secure.card.body')}</p>
        <a
          data-secure-open
          href={secureUrl}
          className="mt-2 inline-flex min-h-10 items-center rounded-btn bg-accent-violet px-3 text-xs font-medium text-white active:opacity-80"
        >
          {t('secure.card.open')}
        </a>
      </div>
      <button
        data-secure-dismiss
        onClick={() => {
          storageSet(SECURE_CARD_KEY, secureUrl)
          setDismissed(secureUrl)
        }}
        aria-label={t('secure.card.dismiss')}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-card"
      >
        <X size={16} />
      </button>
    </section>
  )
}
