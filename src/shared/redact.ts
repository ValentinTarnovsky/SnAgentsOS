/**
 * Defense-in-depth redaction for text that leaves the app by hand (copied
 * diagnostics, E4-FR-24; the phone's connection log, E2-FR-35..39). The real
 * protection is building that text from an allowlist; this only scrubs what
 * slips through. No Node or DOM imports: main, renderer and mobile share it.
 *
 * - each `extraSecrets` value of 4+ characters -> `<redacted>`
 * - Discord webhook URLs -> `<discord-webhook>`
 * - hex runs of 32+ characters (tokens, hashes) -> `<redacted>`
 * - `#pair=...` fragments -> `#pair=<redacted>`
 * - the `home` folder -> `~` (case-insensitive for a Windows path)
 * - private IPv4 (RFC 1918 and 100.64/10) -> `a.b.x.x`
 */
export interface RedactOptions {
  home?: string
  extraSecrets?: string[]
}

const MIN_SECRET = 4

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True for 10/8, 172.16/12, 192.168/16 and the CGNAT/Tailscale 100.64/10. */
export function isPrivateIpv4(a: number, b: number): boolean {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** `192.168.1.20` -> `192.168.x.x` when private; anything else unchanged. */
export function maskIpv4(ip: string): string {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return ip
  const parts = m.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return ip
  return isPrivateIpv4(parts[0], parts[1]) ? `${parts[0]}.${parts[1]}.x.x` : ip
}

function homeVariants(home: string): string[] {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (trimmed.length < 2) return []
  const out = new Set<string>([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\'), trimmed.replace(/[\\/]/g, '\\\\')])
  return [...out].sort((a, b) => b.length - a.length)
}

export function redact(text: string, opts: RedactOptions = {}): string {
  let out = String(text ?? '')
  const secrets = [...new Set((opts.extraSecrets ?? []).filter((s) => typeof s === 'string' && s.length >= MIN_SECRET))].sort(
    (a, b) => b.length - a.length,
  )
  for (const s of secrets) out = out.split(s).join('<redacted>')
  out = out.replace(/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/gi, '<discord-webhook>')
  out = out.replace(/\b[0-9a-f]{32,}\b/gi, '<redacted>')
  out = out.replace(/#pair=[^\s]+/g, '#pair=<redacted>')
  if (opts.home) {
    const windows = /^[A-Za-z]:[\\/]/.test(opts.home) || opts.home.startsWith('\\\\')
    for (const v of homeVariants(opts.home)) {
      out = out.replace(new RegExp(escapeRe(v), windows ? 'gi' : 'g'), '~')
    }
  }
  out = out.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (whole) => maskIpv4(whole))
  return out
}
