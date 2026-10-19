import { Smartphone } from 'lucide-react'
import { useFitStore, releaseAllFitsFromDesktop, releaseFitFromDesktop } from '@/lib/fitStore'
import { useT } from '@/i18n'

export interface MobileDriverBannerProps {
  paneId: string
  /** Give the terminal its focus back after a button. */
  onDone?: () => void
}

/**
 * "Your phone controls this console" (E3-FR-17): a 28px strip on top of a
 * pane whose size a phone owns (or holds after it left), with [Recover] for
 * this pane and [Restore all] for every phone-sized pane. "(Chat)" while the
 * owner reads the pane as Chat (FR-21). Renders nothing while the desktop
 * owns the size. Patterned after Orca's mobile driver overlay, rewritten.
 */
export function MobileDriverBanner({ paneId, onDone }: MobileDriverBannerProps) {
  const t = useT()
  const owner = useFitStore((s) => s.owners[paneId])
  if (!owner) return null
  const btn =
    'shrink-0 rounded-full border border-border px-2 py-px text-[11px] leading-4 text-text-primary transition-colors hover:bg-bg-primary'
  return (
    <div
      role="status"
      data-mobile-driver={owner.chat ? 'chat' : 'phone'}
      className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-b border-accent-violet/40 bg-accent-violet/15 px-2 text-xs text-text-primary"
    >
      <Smartphone size={13} className="shrink-0 text-accent-violet" />
      <span className="min-w-0 flex-1 truncate" title={t(owner.chat ? 'fit.banner.chat' : 'fit.banner.phone')}>
        {t(owner.chat ? 'fit.banner.chat' : 'fit.banner.phone')}
        <span className="ml-1.5 font-mono text-[10px] text-text-secondary">
          {owner.cols}x{owner.rows}
        </span>
      </span>
      <button
        type="button"
        data-fit-action="recover"
        className={btn}
        onClick={() => {
          releaseFitFromDesktop(paneId)
          onDone?.()
        }}
      >
        {t('fit.banner.recover')}
      </button>
      <button
        type="button"
        data-fit-action="restoreAll"
        className={btn}
        onClick={() => {
          releaseAllFitsFromDesktop()
          onDone?.()
        }}
      >
        {t('fit.banner.restoreAll')}
      </button>
    </div>
  )
}
