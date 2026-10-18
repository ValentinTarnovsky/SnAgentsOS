/**
 * Connection banner overlaid on the live terminal (E1-FR-13). The tier comes
 * from the pure classifyConnection(): neutral "Reconnecting..." for attempts
 * 1-2, amber "Can't connect" from 3, red "Can't reach the PC" from 12 or after
 * 60s without a good connection, plus offline / desktop closed / disabled.
 * Below the title sits a hint picked from the address the phone used (Tailscale,
 * LAN or generic). Tapping the banner toggles the details; Retry reconnects in
 * place (client.reconnectNow) without leaving the live screen. The terminal
 * stays visible (stale) underneath so context is not lost.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Loader2, MonitorOff, PowerOff, RotateCw, WifiOff } from 'lucide-react'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { classifyConnection, formatAgo, type ConnHint, type ConnTier } from '../lib/connectionHealth'
import { t, type MobileMessageKey } from '../lib/i18n'

export interface ConnectionHealth {
  tier: ConnTier
  hint: ConnHint
  sinceMs: number | null
  attempt: number
}

/**
 * Live classification of the connection, re-evaluated every second while it is
 * degraded so the 60s escalation and the "last connection" age stay current.
 */
export function useConnectionHealth(): ConnectionHealth {
  const banner = useRemoteStore((s) => s.banner)
  const attempt = useRemoteStore((s) => s.connAttempt)
  const lastConnectedAt = useRemoteStore((s) => s.lastConnectedAt)
  const online = useRemoteStore((s) => s.online)
  const [now, setNow] = useState(() => Date.now())
  const degraded = banner !== null || !online
  useEffect(() => {
    if (!degraded) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [degraded])
  const hostname = typeof location === 'undefined' ? '' : location.hostname
  return { ...classifyConnection({ banner, attempt, lastConnectedAt, now, hostname, online }), attempt }
}

const TITLE: Record<Exclude<ConnTier, 'ok'>, MobileMessageKey> = {
  reconnecting: 'conn.reconnecting',
  cantConnect: 'conn.cantConnect',
  unreachable: 'conn.unreachable',
  offline: 'conn.offline',
  desktopGone: 'conn.desktopGone',
  disabled: 'conn.disabled',
}

const HINT: Record<ConnHint, MobileMessageKey> = {
  tailscale: 'conn.hintTailscale',
  lan: 'conn.hintLan',
  generic: 'conn.hintGeneric',
}

/** Background/text classes per tier, shared with the header dot. */
const TONE: Record<Exclude<ConnTier, 'ok'>, string> = {
  reconnecting: 'bg-card/95 text-text-primary ring-1 ring-border',
  cantConnect: 'bg-amber-500/95 text-black',
  unreachable: 'bg-red-500/95 text-white',
  offline: 'bg-card/95 text-text-primary ring-1 ring-border',
  desktopGone: 'bg-amber-500/95 text-black',
  disabled: 'bg-red-500/95 text-white',
}

/** Header dot color for a tier (MainScreen's ConnectionDot). */
export const DOT_COLOR: Record<ConnTier, string> = {
  ok: 'bg-green-400',
  reconnecting: 'bg-text-secondary',
  cantConnect: 'bg-amber-400',
  unreachable: 'bg-red-400',
  offline: 'bg-text-secondary',
  desktopGone: 'bg-amber-400',
  disabled: 'bg-red-400',
}

/** Title line for a degraded tier (also used by the connecting screen). */
export function tierTitle(h: ConnectionHealth): string {
  if (h.tier === 'ok') return ''
  const title = t(TITLE[h.tier])
  return h.tier === 'reconnecting' && h.attempt > 0 ? `${title} ${t('conn.attempt', { n: h.attempt })}` : title
}

/** Detail lines: the troubleshooting hint and the age of the last good link. */
export function tierDetails(h: ConnectionHealth): string[] {
  if (h.tier === 'ok' || h.tier === 'disabled') return []
  const lines: string[] = []
  if (h.tier === 'offline') lines.push(t('conn.offlineHint'))
  else if (h.tier !== 'desktopGone') lines.push(t(HINT[h.hint]))
  if (h.tier === 'desktopGone' && h.attempt > 0) lines.push(t('conn.attempt', { n: h.attempt }))
  if (h.sinceMs != null && (h.tier === 'unreachable' || h.tier === 'desktopGone' || h.tier === 'offline')) {
    lines.push(t('conn.lastSeen', { t: formatAgo(h.sinceMs) }))
  }
  return lines
}

export function StatusBanner(): ReactNode {
  const health = useConnectionHealth()
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const { tier } = health
  // Collapse back to the tier default whenever the connection recovers.
  useEffect(() => {
    if (tier === 'ok') setExpanded(null)
  }, [tier])
  if (tier === 'ok') return null

  const icon =
    tier === 'reconnecting' ? (
      <Loader2 size={14} className="spin shrink-0" />
    ) : tier === 'offline' ? (
      <WifiOff size={14} className="shrink-0" />
    ) : tier === 'disabled' ? (
      <PowerOff size={14} className="shrink-0" />
    ) : (
      <MonitorOff size={14} className="shrink-0" />
    )
  const details = tierDetails(health)
  // Neutral tiers start collapsed; the amber/red ones lead with the hint.
  const open = expanded ?? (tier !== 'reconnecting' && tier !== 'disabled')
  const canRetry = tier !== 'disabled' && tier !== 'offline'

  return (
    <div
      role="status"
      aria-live="polite"
      data-tier={tier}
      className={clsx('fade-in absolute inset-x-2 top-2 z-20 rounded-xl shadow-lg', TONE[tier])}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span className="mt-0.5">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">{tierTitle(health)}</span>
            {open &&
              details.map((line) => (
                <span key={line} className="mt-0.5 block text-[11px] leading-snug opacity-90">
                  {line}
                </span>
              ))}
          </span>
        </button>
        {canRetry && (
          <button
            type="button"
            data-action="retry"
            onClick={() => client.reconnectNow()}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-black/15 px-2.5 text-[11px] font-semibold active:bg-black/25"
          >
            <RotateCw size={12} />
            {t('conn.retry')}
          </button>
        )}
      </div>
    </div>
  )
}
