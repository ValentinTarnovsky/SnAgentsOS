/**
 * Defense-in-depth redaction for text that leaves the app by hand (copied
 * diagnostics, E4-FR-24; the phone's connection log, E2-FR-35..39). The real
 * protection is building that text from an allowlist; this only scrubs what
 * slips through. No Node or DOM imports: main, renderer and mobile share it.
 *
 * - each `extraSecrets` value of 4+ characters -> `<redacted>`
 * - Discord webhook URLs -> `<discord-webhook>`
 * - hex runs of 32+ characters (tokens, hashes) -> `<redacted>`
 * - Claude OAuth tokens (`sk-ant-oat01-...`) -> `<redacted>`, emails -> `<email>`
 * - `#pair=...` fragments -> `#pair=<redacted>`
 * - the `home` folder -> `~` (case-insensitive for a Windows path)
 * - private IPv4 (RFC 1918 and 100.64/10) -> `a.b.x.x` (unless `keepIps`)
 *
 * redactCredentials (app 2.7.0) is narrower and meant for notices (`snaos
 * notify`, Equipos): it masks only credential shapes (the snaos token shape
 * among them) and leaves other hashes, ids, paths, IPs, emails and plain URLs
 * readable. See its own comment.
 */
export interface RedactOptions {
  home?: string
  extraSecrets?: string[]
  /** Leave private IPv4 addresses readable (the phone's own connection log). */
  keepIps?: boolean
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
  // Claude OAuth tokens (sk-ant-oat01-..., sk-ant-ort01-..., app 2.3.0) and emails.
  out = out.replace(/sk-ant-[a-z]{2,4}\d{2}-[A-Za-z0-9_-]{20,}/g, '<redacted>')
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<email>')
  out = out.replace(/#pair=[^\s]+/g, '#pair=<redacted>')
  if (opts.home) {
    const windows = /^[A-Za-z]:[\\/]/.test(opts.home) || opts.home.startsWith('\\\\')
    for (const v of homeVariants(opts.home)) {
      out = out.replace(new RegExp(escapeRe(v), windows ? 'gi' : 'g'), '~')
    }
  }
  if (!opts.keepIps) out = out.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (whole) => maskIpv4(whole))
  return out
}

// --- redactCredentials (app 2.7.0) ---

const CREDENTIAL_MASK = '[redacted]'

const PEM_BEGIN = '-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----'
const PEM_END = '-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----'

/**
 * scheme://user:password@host keeps scheme, user and host. The password runs
 * to the last `@` before a `/`, `?`, `#` or whitespace, so a URL without
 * credentials (`https://host:8080/a?mail=x@y.z`) never matches.
 */
const CONN_RE = /([A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)([^\s:\/@?#]{0,256}):([^\s\/?#]{1,256})@(?=[^\s@\/?#])/g

/** `Bearer <token>`: the token needs a digit, so prose ("Bearer authentication") stays. */
const BEARER_RE = /\b(bearer)([ \t]+)([A-Za-z0-9._~+\/=-]{8,})/gi

/**
 * Token shapes, each after the start or a character that cannot belong to a
 * token (group 1, kept). The edge is matched, not looked behind: lookbehind
 * does not parse on Safari < 16.4 and this module ships to the phone.
 */
const TOKEN_RE = new RegExp(
  '(^|[^A-Za-z0-9_-])(' +
    [
      'sk-[A-Za-z0-9_-]{20,}', // OpenAI, Anthropic (sk-ant-...) and other sk- keys; see isSkKey
      'gh[pousr]_[A-Za-z0-9]{20,}', // GitHub tokens
      'github_pat_[A-Za-z0-9_]{20,}', // GitHub fine-grained tokens
      'xox[abposr]-\\d[A-Za-z0-9-]{9,}', // Slack
      '(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])', // AWS access key ids
      'AIza[A-Za-z0-9_-]{30,}', // Google API keys
      'npm_[A-Za-z0-9]{30,}', // npm
      'eyJ[A-Za-z0-9_-]{6,}\\.eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]*', // JWT (an unsigned one ends in a dot)
    ].join('|') +
    ')',
  'g',
)

/**
 * The snaos tokens (B5 integration, fifth round): the master token of runtime.json and every console or team token
 * are 64 hex characters (newToken), here alone between characters that are no letter or digit, in any case. A second
 * net behind main's refusal of a live token in a team text (CtlTokens.holdsToken): a SHA-256 hex digest has the same
 * shape and is masked too, while a 40-hex git SHA, a UUID or a longer hex run stays.
 */
const SNAOS_TOKEN_RE = /(^|[^0-9A-Za-z])[0-9a-fA-F]{64}(?![0-9A-Za-z])/g

const HAS_DIGIT = /\d/
const HAS_LETTER = /[A-Za-z]/

/**
 * An sk- run is a key when it has a digit and, between its dashes, a random
 * part of 16 or more characters or two key-like parts (a digit plus a letter,
 * or 8+ characters: `sk-lf-<uuid>`). A kebab name (a path segment, a branch,
 * `sk-feature-login-fix-2024`, `sk-utils-v2`) has words and at most one such
 * part.
 */
function isSkKey(token: string): boolean {
  if (!HAS_DIGIT.test(token)) return false
  let keyLike = 0
  for (const part of token.split('-')) {
    if (part.length >= 16) return true
    if (HAS_DIGIT.test(part) && (part.length >= 8 || HAS_LETTER.test(part)) && ++keyLike >= 2) return true
  }
  return false
}

/** PEM private key blocks; one cut short (no END line, a clipped notice) is masked to the end. */
function maskPem(text: string): string {
  if (!text.includes('PRIVATE KEY')) return text
  const begin = new RegExp(PEM_BEGIN, 'g')
  const end = new RegExp(PEM_END, 'g')
  let out = ''
  let from = 0
  for (let m = begin.exec(text); m; m = begin.exec(text)) {
    out += text.slice(from, m.index) + CREDENTIAL_MASK
    end.lastIndex = m.index + m[0].length
    const close = end.exec(text)
    if (!close) return out
    from = close.index + close[0].length
    begin.lastIndex = from
  }
  return out + text.slice(from)
}

/** How many dots end the token (a sentence's full stop is not part of it). */
function trailingDots(token: string): number {
  let n = 0
  while (n < token.length && token[token.length - 1 - n] === '.') n++
  return n
}

/**
 * Credentials in free text -> `[redacted]` (app 2.7.0: `snaos notify` and
 * every Equipos notice, plan A5): PEM private keys, connection string
 * passwords, `Bearer <token>`, JWTs, the prefixed key shapes in TOKEN_RE and
 * (B5 integration, fifth round) the 64 hex snaos token shape (SNAOS_TOKEN_RE).
 * Unlike redact() it keeps hashes (a 40-hex git SHA), UUIDs, paths, IPs,
 * emails and URLs without credentials. Every pattern starts on a fixed prefix
 * or edge with bounded or non-overlapping runs, so it is linear on any input
 * (a 1 MB notice included). Idempotent; never throws (a failure gives '').
 */
export function redactCredentials(text: string): string {
  try {
    let out = typeof text === 'string' ? text : String(text ?? '')
    out = maskPem(out)
    if (out.includes('://')) out = out.replace(CONN_RE, (_m, scheme: string, user: string) => `${scheme}${user}:${CREDENTIAL_MASK}@`)
    out = out.replace(BEARER_RE, (whole: string, word: string, gap: string, token: string) => {
      if (!HAS_DIGIT.test(token)) return whole
      const dots = trailingDots(token)
      return word + gap + CREDENTIAL_MASK + token.slice(token.length - dots)
    })
    out = out.replace(TOKEN_RE, (whole: string, edge: string, token: string) =>
      token.startsWith('sk-') && !isSkKey(token) ? whole : edge + CREDENTIAL_MASK,
    )
    out = out.replace(SNAOS_TOKEN_RE, (_whole: string, edge: string) => edge + CREDENTIAL_MASK)
    return out
  } catch {
    return ''
  }
}
