/**
 * Thin banner overlaid on the live terminal when the connection degrades:
 * reconnecting (with attempt count), desktop closed, or remote disabled. The
 * terminal stays visible (stale) underneath so context is not lost.
 */
import type { ReactNode } from 'react'
import { Loader2, PowerOff, WifiOff } from 'lucide-react'
import { useRemoteStore } from '../lib/store'
import { t } from '../lib/i18n'

export function StatusBanner(): ReactNode {
  const banner = useRemoteStore((s) => s.banner)
  if (!banner) return null

  let icon: ReactNode
  let text: string
  let tone = 'bg-amber-500/90 text-black'

  if (banner.kind === 'reconnecting') {
    icon = <Loader2 size={14} className="spin" />
    text = `${t('conn.reconnecting')} ${t('conn.attempt', { n: banner.attempt })}`
  } else if (banner.kind === 'desktopGone') {
    icon = <WifiOff size={14} />
    text = t('conn.desktopGone')
  } else {
    icon = <PowerOff size={14} />
    text = t('conn.disabled')
    tone = 'bg-red-500/90 text-white'
  }

  return (
    <div
      className={`fade-in pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium ${tone}`}
    >
      {icon}
      <span className="truncate">{text}</span>
    </div>
  )
}
