import { Users } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { PERM_KEY, useShareHostStore } from '@/lib/shareHostStore'
import { useT } from '@/i18n'

/**
 * "Shared with Ana (Type only) - Ana is typing" (app 2.4.0, item 8, S4): a
 * 28px strip on top of a console while at least one Share guest has it open,
 * above the phone's MobileDriverBanner. Manage opens Settings > Sharing.
 * Renders nothing while no guest watches this console.
 */
export function ShareHostBanner({ paneId }: { paneId: string }) {
  const t = useT()
  const entry = useShareHostStore((s) => s.panes[paneId])
  if (!entry || entry.guests.length === 0) return null
  const who = entry.guests.map((g) => t('shareHost.banner.guest', { name: g.name, perm: t(PERM_KEY[g.perm]) })).join(', ')
  const text = t('shareHost.banner.with', { guests: who })
  return (
    <div
      role="status"
      data-share-host-banner={paneId}
      className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-bg-secondary px-2 text-xs text-text-primary"
    >
      <Users size={13} className="shrink-0 text-text-secondary" />
      <span className="min-w-0 flex-1 truncate" title={entry.typing ? `${text} - ${t('shareHost.banner.typing', { name: entry.typing })}` : text}>
        {text}
        {entry.typing && (
          <span data-share-host-typing className="ml-1.5 text-text-secondary">
            {'- '}
            {t('shareHost.banner.typing', { name: entry.typing })}
          </span>
        )}
      </span>
      <button
        type="button"
        data-share-host-manage
        className="shrink-0 rounded-full border border-border px-2 py-px text-[11px] leading-4 text-text-primary transition-colors hover:bg-bg-primary"
        onClick={() => useAppStore.getState().openSettings('share')}
      >
        {t('shareHost.banner.manage')}
      </button>
    </div>
  )
}
