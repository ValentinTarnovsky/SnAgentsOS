/**
 * Pure classification of the phone's connection health (E1-FR-13). The client
 * feeds it the raw facts (banner, attempt count, last good connection, the
 * browser's online flag) and the banner and the header dot render the result,
 * so the thresholds live in one tested place instead of in JSX.
 *
 * Tiers: attempts 1-2 are a neutral "reconnecting", from attempt 3 an amber
 * "can't connect", and from attempt 12 (or more than 60s since the last good
 * connection) a red "can't reach the PC". offline / desktopGone / disabled are
 * explicit states that win over the attempt-based tiers.
 */
import type { Banner } from './store'

export type ConnTier = 'ok' | 'reconnecting' | 'cantConnect' | 'unreachable' | 'offline' | 'desktopGone' | 'disabled'
export type ConnHint = 'tailscale' | 'lan' | 'generic'

export interface ConnInput {
  banner: Banner | null
  attempt: number
  lastConnectedAt: number | null
  now: number
  hostname: string
  online: boolean
}

export const CANT_CONNECT_AFTER = 3
export const UNREACHABLE_AFTER = 12
export const UNREACHABLE_MS = 60000

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/**
 * Which troubleshooting hint fits the address the phone used to reach the PC:
 * 100.64.0.0/10 (CGNAT, Tailscale's range) or *.ts.net -> tailscale; RFC1918 or
 * *.local -> lan; anything else (a short MagicDNS name, a public IP, IPv6) ->
 * generic, since we cannot tell which network it rides on.
 */
export function endpointHint(hostname: string): ConnHint {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host.includes(':')) return 'generic'
  const ip = parseIpv4(host)
  if (ip) {
    const [a, b] = ip
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
    if (a === 10) return 'lan'
    if (a === 172 && b >= 16 && b <= 31) return 'lan'
    if (a === 192 && b === 168) return 'lan'
    return 'generic'
  }
  if (host.endsWith('.ts.net')) return 'tailscale'
  if (host.endsWith('.local')) return 'lan'
  return 'generic'
}

export function classifyConnection(i: ConnInput): { tier: ConnTier; hint: ConnHint; sinceMs: number | null } {
  const hint = endpointHint(i.hostname)
  const sinceMs = i.lastConnectedAt == null ? null : Math.max(0, i.now - i.lastConnectedAt)
  let tier: ConnTier
  if (i.banner?.kind === 'disabled') tier = 'disabled'
  else if (!i.online) tier = 'offline'
  else if (i.banner?.kind === 'desktopGone') tier = 'desktopGone'
  else if (!i.banner) tier = 'ok'
  else if (i.attempt >= UNREACHABLE_AFTER || (sinceMs != null && sinceMs > UNREACHABLE_MS)) tier = 'unreachable'
  else if (i.attempt >= CANT_CONNECT_AFTER) tier = 'cantConnect'
  else tier = 'reconnecting'
  return { tier, hint, sinceMs }
}

/** Compact elapsed time for "Last connection {t} ago": 45s, 3m, 2h, 3d. */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
