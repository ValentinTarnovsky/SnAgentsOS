import { Share2 } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { shareGuestCount, useShareHostStore } from '@/lib/shareHostStore'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'

/**
 * "Sharing: 2 guests" (app 2.4.0, item 8, S4): the host's sidebar row next to
 * RemoteIndicator. Hidden unless sharing is on and this PC has a share.
 * Click opens Settings > Sharing.
 */
export function ShareHostIndicator() {
  const t = useT()
  const enabled = useAppStore((s) => s.settings.share.enabled)
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const openSettings = useAppStore((s) => s.openSettings)
  const host = useShareHostStore((s) => s.state)

  if (!enabled || host.grants.length === 0) return null

  const guests = shareGuestCount(host)
  const label = host.pausedAll
    ? t('shareHost.indicator.paused')
    : guests === 1
      ? t('shareHost.indicator.one')
      : t('shareHost.indicator.many', { count: guests })
  const dot =
    host.listening === 'error'
      ? 'bg-red-400'
      : host.pausedAll
        ? 'bg-amber-400'
        : host.listening === 'running'
          ? guests > 0
            ? 'bg-emerald-400'
            : 'bg-sky-400'
          : 'bg-text-secondary/50'
  const onClick = (): void => openSettings('share')

  if (collapsed) {
    return (
      <div className="flex shrink-0 justify-center border-t border-border px-2 py-3">
        <Tooltip label={label} side="right">
          <button
            onClick={onClick}
            data-share-indicator={guests}
            aria-label={label}
            className="relative flex h-8 w-8 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
          >
            <Share2 size={16} />
            <span className={cn('absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-bg-secondary', dot)} />
          </button>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-border px-2.5 py-2.5">
      <button
        onClick={onClick}
        data-share-indicator={guests}
        className="flex w-full items-center gap-2 rounded-btn px-1.5 py-1 text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
      >
        <Share2 size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left text-xs">{label}</span>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
      </button>
    </div>
  )
}
