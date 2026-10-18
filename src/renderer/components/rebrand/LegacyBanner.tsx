import { AlertTriangle, FileText, X } from 'lucide-react'
import { LEGACY_BRAND } from '@shared/brand'
import { useT } from '@/i18n'
import { bannerKind, useLegacyStore } from '@/lib/legacyStore'

/**
 * Non-blocking 1.x notices (E0-FR-35): the migration failed (data untouched,
 * retried next start) or leftovers have stayed in use for 5 starts. A status
 * region, not a dialog: it never takes the focus. Closing it lasts for this
 * session only.
 */
export function LegacyBanner() {
  const t = useT()
  const info = useLegacyStore((s) => s.info)
  const dismissed = useLegacyStore((s) => s.dismissed)
  const dismiss = useLegacyStore((s) => s.dismiss)
  const kind = bannerKind(info, dismissed)
  if (!kind || !info) return null

  const text =
    kind === 'failed'
      ? t('legacy.banner.failed', { legacy: LEGACY_BRAND.productName })
      : t('legacy.banner.deferred', { legacy: LEGACY_BRAND.productName, n: info.cleanup.deferred })

  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 border-b border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs text-text-primary"
    >
      <AlertTriangle size={14} className="shrink-0 text-amber-400" />
      <span className="min-w-0 flex-1">{text}</span>
      {kind === 'failed' && (
        <button
          onClick={() => window.snApi.app.legacyOpenLog()}
          className="flex shrink-0 items-center gap-1 rounded-btn border border-border px-2 py-1 text-text-secondary transition-colors hover:text-text-primary"
        >
          <FileText size={12} />
          {t('legacy.banner.viewLog')}
        </button>
      )}
      <button
        onClick={() => dismiss(kind)}
        aria-label={t('legacy.banner.dismiss')}
        title={t('legacy.banner.dismiss')}
        className="shrink-0 text-text-secondary transition-colors hover:text-text-primary"
      >
        <X size={14} />
      </button>
    </div>
  )
}
