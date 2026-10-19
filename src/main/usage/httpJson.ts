import { net, type ClientRequest } from 'electron'

/**
 * Hosts the usage feature is ever allowed to reach. Redirects are followed
 * manually and re-checked against this list so a 3xx can't smuggle us off-list.
 * `chatgpt.com` serves the Codex quota (`/backend-api/wham/usage`).
 */
const ALLOWED_HOSTS = new Set(['api.anthropic.com', 'status.anthropic.com', 'chatgpt.com'])

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host)
}

export interface JsonResponse<T> {
  status: number
  json: T | null
  /** Parsed `Retry-After` in milliseconds (429/503 hints), when the server sent a usable one. */
  retryAfterMs?: number
}

/** `Retry-After` is either delta-seconds or an HTTP-date; anything else is ignored. */
export function parseRetryAfter(value: string | string[] | undefined, nowMs: number = Date.now()): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), 24 * 3600) * 1000
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return undefined
  return Math.max(0, Math.min(at - nowMs, 24 * 3600_000))
}

/**
 * Buffer a small JSON GET behind a strict https + host allowlist and a timeout.
 * Never throws on HTTP status; returns the status so callers can branch on 401
 * (expired token) vs other failures. Network/abort errors reject.
 */
export function getJson<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15000,
): Promise<JsonResponse<T>> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' || !isAllowedHost(u.hostname)) {
        reject(new Error(`Refusing to fetch usage from an untrusted host: ${u.hostname}`))
        return
      }
    } catch {
      reject(new Error('Malformed usage URL.'))
      return
    }

    let done = false
    let req: ClientRequest
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        req.abort()
      } catch {
        /* ignore */
      }
      reject(new Error('The usage request timed out.'))
    }, timeoutMs)

    const settle = <V>(fn: (v: V) => void) => (v: V): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn(v)
    }
    const ok = settle(resolve)
    const bad = settle(reject)

    req = net.request({ url, method: 'GET', redirect: 'manual' })
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    req.on('redirect', (_status, _method, redirectUrl: string) => {
      try {
        const u = new URL(redirectUrl)
        if (u.protocol === 'https:' && isAllowedHost(u.hostname)) {
          req.followRedirect()
          return
        }
      } catch {
        /* fall through to abort */
      }
      req.abort()
      bad(new Error(`Refusing to follow a usage redirect to an untrusted host: ${redirectUrl}`))
    })
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const text = Buffer.concat(chunks).toString('utf8')
        let json: T | null = null
        try {
          json = text ? (JSON.parse(text) as T) : null
        } catch {
          json = null
        }
        const retryAfterMs = parseRetryAfter(res.headers['retry-after'])
        ok(retryAfterMs !== undefined ? { status, json, retryAfterMs } : { status, json })
      })
      res.on('error', bad)
    })
    req.on('error', bad)
    req.end()
  })
}
