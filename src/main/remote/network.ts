/**
 * Network-interface discovery + address classification for the embedded
 * remote-control server. Two jobs:
 *  - listEndpoints(port): the reachable URLs shown as QR codes to the phone,
 *  - isPrivateOrTailnet(ip): the allow-list used to validate the Host header
 *    on every request (anti DNS-rebinding: only our own private/tailnet IPs).
 */
import { networkInterfaces } from 'os'
import type { RemoteEndpoint } from '@shared/ipc-contract'
import type { RemoteEndpointKind } from '@shared/remote-protocol'

/** Adapters that carry virtual/loopback-ish addresses users never want to scan. */
const VIRTUAL_ADAPTER = /vethernet|wsl|docker|vmware|virtualbox|hyper-v|vbox|loopback/i
/** Tailscale names its interface tailscale0 / Tailscale on the platforms we target. */
const TAILSCALE_ADAPTER = /tailscale/i

/** Parse a dotted IPv4 literal into its four octets, or null if it isn't one. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const
  if (o.some((n) => n > 255)) return null
  return [o[0], o[1], o[2], o[3]]
}

function isLoopback(o: [number, number, number, number]): boolean {
  return o[0] === 127
}

function isRfc1918(o: [number, number, number, number]): boolean {
  return (
    o[0] === 10 ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168)
  )
}

/** CGNAT / carrier-grade NAT range 100.64.0.0/10, used by Tailscale. */
function isCgnat(o: [number, number, number, number]): boolean {
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

/**
 * True when an IP is one the phone may legitimately name in a Host header: our
 * own loopback, an RFC1918 LAN address, or a CGNAT/Tailscale address. Anything
 * routable-public or non-numeric is rejected, which blocks DNS rebinding (a
 * malicious page resolving a hostname to our port cannot pass a raw IP Host).
 */
export function isPrivateOrTailnet(ip: string): boolean {
  const o = parseIpv4(ip)
  if (!o) return false
  return isLoopback(o) || isRfc1918(o) || isCgnat(o)
}

/**
 * Normalize a socket remote address for per-IP bookkeeping: strip the
 * IPv4-mapped IPv6 prefix (::ffff:192.168.0.5 -> 192.168.0.5).
 */
export function normalizeIp(addr: string | undefined): string {
  if (!addr) return ''
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr
}

function classify(name: string, o: [number, number, number, number]): RemoteEndpointKind {
  if (TAILSCALE_ADAPTER.test(name)) return 'tailscale'
  if (isRfc1918(o)) return 'lan'
  // CGNAT without a Tailscale-named adapter, or anything else external.
  return 'other'
}

const KIND_ORDER: Record<RemoteEndpointKind, number> = { lan: 0, tailscale: 1, other: 2 }

/**
 * Every IPv4 address the desktop can be reached at, as ready-to-use URLs. Real
 * adapters sort before virtual ones (vEthernet/WSL/Docker/...), and within that
 * LAN sorts first, then Tailscale, then anything else, so the QR modal's first
 * suggestion is the address most likely to work.
 */
export function listEndpoints(port: number): RemoteEndpoint[] {
  const out: Array<RemoteEndpoint & { virtual: boolean; kindRank: number }> = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    const infos = ifaces[name]
    if (!infos) continue
    for (const info of infos) {
      if (info.family !== 'IPv4' || info.internal) continue
      const o = parseIpv4(info.address)
      if (!o || isLoopback(o)) continue
      const kind = classify(name, o)
      out.push({
        ip: info.address,
        kind,
        url: `http://${info.address}:${port}`,
        virtual: VIRTUAL_ADAPTER.test(name),
        kindRank: KIND_ORDER[kind],
      })
    }
  }
  out.sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0) || a.kindRank - b.kindRank)
  return out.map(({ ip, kind, url }) => ({ ip, kind, url }))
}
