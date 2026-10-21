import { useEffect, useState } from 'react'
import { Share2 } from 'lucide-react'
import type { SharePerm } from '@shared/share-protocol'
import { paneKey, useShareGuestStore } from '@/lib/shareGuestStore'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { DENY_KEY, PERM_KEY, STATUS_KEY } from './shareLabels'

/** A refused key's message stays this long, then the strip goes back to its line. */
export const NOTICE_MS = 3000

export interface GuestShareBannerProps {
  linkId: string
  paneId: string
  perm: SharePerm
  hostLabel: string
}

/**
 * The 28px strip on top of a shared console (app 2.4.0, item 8, S3;
 * MobileDriverBanner pattern): "Shared by <host> - Type only (Enter
 * disabled)", replaced by what blocks input right now ("The host is typing",
 * "Another guest is typing", "Paused by the host") and, for 3 s, by the last
 * refused key ("Enter is disabled"). `role=status` announces the changes.
 */
export function GuestShareBanner({ linkId, paneId, perm, hostLabel }: GuestShareBannerProps) {
  const t = useT()
  const lock = useShareGuestStore((s) => s.locks[linkId]?.[paneId] ?? null)
  const status = useShareGuestStore((s) => s.links[linkId]?.status)
  const notice = useShareGuestStore((s) => s.notices[paneKey(linkId, paneId)])
  const [shownNotice, setShownNotice] = useState<number | null>(null)

  useEffect(() => {
    if (!notice) return
    const left = NOTICE_MS - (Date.now() - notice.at)
    if (left <= 0) return
    setShownNotice(notice.n)
    const id = setTimeout(() => setShownNotice(null), left)
    return () => clearTimeout(id)
  }, [notice])

  let kind: 'notice' | 'host' | 'other' | 'paused' | 'offline' | 'base' = 'base'
  let text: string
  if (notice && shownNotice === notice.n) {
    kind = 'notice'
    text = t(DENY_KEY[notice.reason])
  } else if (status === 'paused') {
    kind = 'paused'
    text = t(STATUS_KEY.paused)
  } else if (status && status !== 'connected') {
    kind = 'offline'
    text = t(STATUS_KEY[status])
  } else if (lock === 'host') {
    kind = 'host'
    text = t('shareGuest.deny.host_typing')
  } else if (lock === 'other') {
    kind = 'other'
    text = t('shareGuest.deny.other_typing')
  } else {
    text = t('shareGuest.banner.base', { host: hostLabel, perm: perm === 'type' ? t('shareGuest.banner.type') : t(PERM_KEY[perm]) })
  }
  const warn = kind !== 'base'
  return (
    <div
      role="status"
      data-guest-banner={kind}
      className={cn(
        'flex h-7 shrink-0 items-center gap-2 overflow-hidden border-b px-2 text-xs text-text-primary',
        warn ? 'border-state-action/40 bg-state-action/15' : 'border-border bg-card/50',
      )}
    >
      <Share2 size={13} className={cn('shrink-0', warn ? 'text-state-action' : 'text-text-secondary')} />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
    </div>
  )
}
