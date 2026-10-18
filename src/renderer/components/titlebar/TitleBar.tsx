import { useEffect, useState } from 'react'
import { AlertTriangle, Copy, Download, Loader2, Minus, Square, X } from 'lucide-react'
import { BRAND } from '@shared/brand'
import { LogoMark } from '@/components/ui/Logo'
import { AwakeIndicator } from '@/components/agents/AwakeIndicator'
import { useUpdateCardVisible } from '@/components/updates/UpdateCard'
import { isUpdateChipVisible } from '@/components/updates/update-card-visibility'
import { isInstallPhase, useUpdaterStore } from '@/lib/updater'
import { useT } from '@/i18n'

/**
 * Update chip right of the wordmark (E4-FR-16): while the card is collapsed
 * or hidden it shows the download percent, "Installing" or "Failed", and a
 * click brings the card back. No-drag, at most 120px.
 */
export function UpdateChip() {
  const t = useT()
  const cardVisible = useUpdateCardVisible()
  const phase = useUpdaterStore((s) => s.phase)
  const percent = useUpdaterStore((s) => s.progress?.percent ?? 0)
  const showCard = useUpdaterStore((s) => s.showCard)
  if (!isUpdateChipVisible({ phase, cardVisible })) return null

  const failed = phase === 'failed'
  const title =
    phase === 'downloading'
      ? t('update.chip.downloading', { percent })
      : phase === 'installing'
        ? t('update.chip.installingTitle')
        : t('update.chip.failedTitle')
  return (
    <button
      type="button"
      onClick={showCard}
      title={title}
      aria-label={title}
      data-update-chip={phase}
      className={
        'app-no-drag flex h-6 max-w-[120px] shrink-0 items-center gap-1 overflow-hidden rounded-btn border px-2 text-[11px] font-medium tabular-nums transition-colors ' +
        (failed
          ? 'border-amber-400/40 text-amber-400 hover:bg-amber-400/10'
          : 'border-border text-text-secondary hover:bg-card hover:text-text-primary')
      }
    >
      {phase === 'downloading' && <Download size={12} className="shrink-0" />}
      {phase === 'installing' && <Loader2 size={12} className="shrink-0 animate-spin" />}
      {failed && <AlertTriangle size={12} className="shrink-0" />}
      <span className="truncate">
        {phase === 'downloading' ? `${percent}%` : phase === 'installing' ? t('update.chip.installing') : t('update.chip.failed')}
      </span>
    </button>
  )
}

/**
 * Custom frameless title bar. The bar is a drag region; the window controls
 * (no-drag) call into the main process over `window.snApi.window`.
 */
export function TitleBar() {
  const t = useT()
  const [maxed, setMaxed] = useState(false)
  // Block closing the window while an update is downloading/installing. The
  // phase is main's (E4-FR-37), so this matches main's close guard, also
  // after a reload mid-download.
  const installing = useUpdaterStore((s) => isInstallPhase(s.phase))

  useEffect(() => {
    window.snApi.window
      .isMaximized()
      .then(setMaxed)
      .catch(() => undefined)
    return window.snApi.window.onMaximizeChange(setMaxed)
  }, [])

  return (
    <div className="app-drag flex h-9 shrink-0 select-none items-center justify-between border-b border-border bg-bg-secondary pl-3">
      <div className="flex items-center gap-2">
        <LogoMark size="sm" />
        <span className="text-xs font-medium text-text-secondary">{BRAND.productName}</span>
        <UpdateChip />
      </div>

      <div className="app-no-drag flex h-full items-stretch">
        <AwakeIndicator />
        <button
          onClick={() => window.snApi.window.minimize()}
          title={t('titlebar.minimize')}
          className="flex w-11 items-center justify-center text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={() => window.snApi.window.maximize()}
          title={maxed ? t('titlebar.restore') : t('titlebar.maximize')}
          className="flex w-11 items-center justify-center text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
        >
          {maxed ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          onClick={() => !installing && window.snApi.window.close()}
          disabled={installing}
          title={t('titlebar.close')}
          className="flex w-11 items-center justify-center text-text-secondary transition-colors hover:bg-red-500 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
