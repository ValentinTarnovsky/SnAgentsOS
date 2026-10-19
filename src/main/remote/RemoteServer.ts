/**
 * The embedded HTTP + WebSocket server. Its unauthenticated attack surface is
 * a hardened static file server for the mobile bundle and a WebSocket upgrade
 * on `/ws`; all control flows through the authenticated WS protocol.
 *
 * The only REST routes live under `/api/` and break the old "no REST" rule on
 * purpose (E3 design note 9): `POST /api/upload` (E3-FR-08) takes an image
 * from the phone. It is compensated by the `httpToken` Bearer (32 random
 * bytes bound to one authenticated WS session, dead once that socket closes
 * or the device is revoked) plus the same Host and an exact Origin check, so
 * a foreign page can neither forge nor read it. `POST /api/push/subscribe`
 * (E3-FR-44) takes the phone's PushSubscription under the same rules. Any
 * other `/api/` request is a 404, and attachments are never served back.
 *
 * Secure mode (E3-FR-42, R30-07): `tailscale serve` terminates TLS and proxies
 * to us on loopback. Only then, and only while the mode is on, the exact
 * MagicDNS name is a valid Host, the expected Origin is `https://<Host>` and
 * the client IP for the rate limits comes from the proxy's X-Forwarded-For.
 *
 * Defenses baked in here (the plan's security posture, minus TLS):
 *  - Host header must be one of our own private/tailnet IP literals on the
 *    configured port (anti DNS-rebinding),
 *  - WS upgrades and `/api/` POSTs require an Origin exactly equal to
 *    `http://<Host>` (`https://<Host>` for the secure mode's name),
 *  - static paths are decoded, NUL-rejected, and confined under the bundle root,
 *  - responses carry nosniff + a strict CSP and leak no server version.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Duplex } from 'stream'
import { readFileSync } from 'fs'
import { extname, join, resolve, sep } from 'path'
import { app } from 'electron'
import { BRAND } from '@shared/brand'
import { WebSocketServer, type WebSocket } from 'ws'
import { isLoopbackAddress, isPrivateOrTailnet, normalizeIp } from './network'

/** Largest WS frame accepted (bounds a pre-auth memory-exhaustion attempt). */
const MAX_PAYLOAD = 64 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

// img-src blob: (E3 M10): the upload chip previews the picked image, and the
// image decode fallback loads it through an object URL. wss: and worker-src
// (E3 M14): the https origin's socket and its service worker.
export const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; font-src 'self'; worker-src 'self'"

interface CachedFile {
  body: Buffer
  type: string
}

export interface RemoteServerHandlers {
  /**
   * A validated WS client connected; hand it to the SessionManager. `host` is
   * the IP literal of the already validated Host header, without the port: the
   * address the phone reached us at (E2-FR-42 lastHost).
   */
  onSocket: (ws: WebSocket, ip: string, host: string) => void
  /**
   * `POST /api/upload` with its Host and Origin already accepted (E3-FR-08):
   * UploadService checks the Bearer, type and size and answers. Absent, the
   * route is a 404.
   */
  onUpload?: (req: IncomingMessage, res: ServerResponse) => void
  /**
   * `POST /api/push/subscribe` with Host and Origin accepted (E3-FR-44).
   * PushService answers 404 while the secure mode is off. Absent = 404.
   */
  onPushSubscribe?: (req: IncomingMessage, res: ServerResponse) => void
  /**
   * The secure mode's MagicDNS name while it is on, else null (E3-FR-42).
   * Absent = never on (tests, older wiring).
   */
  secureHost?: () => string | null
}

/** What validateRequest learned from an accepted request. */
interface AcceptedRequest {
  /** The Origin a WS upgrade or `/api/` POST must carry. */
  origin: string
  /** Host without the port: an IP literal, or the MagicDNS name. */
  host: string
  /** Client IP for the per-IP limits. */
  ip: string
}

/** Last valid IP of an X-Forwarded-For (the one the trusted proxy appended). */
export function forwardedIp(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[header.length - 1] : header
  if (typeof raw !== 'string') return null
  const last = raw.split(',').pop()?.trim() ?? ''
  const ip = normalizeIp(last)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]{2,39}$/i.test(ip)) return ip
  return null
}

/** The IP part of a Host header already accepted by validateHost ('192.168.1.5:4517' -> '192.168.1.5'). */
export function hostIp(hostHeader: string): string {
  const first = hostHeader.indexOf(':')
  return first !== -1 && first === hostHeader.lastIndexOf(':') ? hostHeader.slice(0, first) : hostHeader
}

export class RemoteServer {
  /** Bundle root; readFileSync reads straight out of the asar in production. */
  private readonly root = join(__dirname, '../mobile')
  private readonly cache = new Map<string, CachedFile>()
  private readonly prod = app.isPackaged
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
  private http: Server | null = null
  private listening = false

  constructor(
    private readonly port: number,
    private readonly handlers: RemoteServerHandlers,
  ) {}

  /** Resolves once bound; rejects with the listen error (e.g. EADDRINUSE). */
  start(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res))
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
      server.on('error', (err) => {
        // A listen failure surfaces before `listening`; later errors are noise.
        if (!this.listening) reject(err)
      })
      server.listen(this.port, '0.0.0.0', () => {
        this.listening = true
        resolvePromise()
      })
      this.http = server
    })
  }

  /** Drop all sockets and free the port. Safe to call more than once. */
  close(): void {
    for (const client of this.wss.clients) {
      try {
        client.terminate()
      } catch {
        /* ignore */
      }
    }
    try {
      this.wss.close()
    } catch {
      /* ignore */
    }
    if (this.http) {
      try {
        this.http.close()
      } catch {
        /* ignore */
      }
      this.http = null
    }
    this.listening = false
  }

  // --- WebSocket upgrade ----------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (pathname !== '/ws') return void socket.destroy()
      const accepted = this.validateRequest(req)
      if (!accepted) return void socket.destroy()
      // Anti-CSWSH: the Origin must be exactly our own origin.
      if (req.headers.origin !== accepted.origin) return void socket.destroy()
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handlers.onSocket(ws, accepted.ip, accepted.host)
      })
    } catch {
      socket.destroy()
    }
  }

  // --- Static file serving --------------------------------------------------

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const accepted = this.validateRequest(req)
    if (!accepted) return this.sendStatus(res, 400, 'Bad Request')

    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      return this.sendStatus(res, 400, 'Bad Request')
    }
    if (pathname.includes('\0')) return this.sendStatus(res, 400, 'Bad Request')
    if (pathname === '/api' || pathname.startsWith('/api/')) return this.handleApi(req, res, pathname, accepted.origin)
    if (pathname === '/') pathname = '/index.html'

    const resolved = resolve(this.root, '.' + pathname)
    // Confine to the bundle root: reject any '..' escape after normalization.
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      return this.sendStatus(res, 403, 'Forbidden')
    }

    let file = this.load(resolved)
    // SPA fallback: an unknown extension-less path serves the app shell.
    if (!file && !extname(pathname)) file = this.load(join(this.root, 'index.html'))
    if (!file) {
      // A missing shell means the mobile bundle was never built: tell the dev.
      if (!this.load(join(this.root, 'index.html'))) return this.sendMissingBundle(res)
      return this.sendStatus(res, 404, 'Not Found')
    }

    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.body.length,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-cache',
    })
    res.end(file.body)
  }

  // --- REST routes (E3 M10) ---------------------------------------------------

  /**
   * `/api/*`, after the Host check. `POST /api/upload` and `POST
   * /api/push/subscribe` exist; both need an Origin exactly equal to our own
   * (403), then UploadService / PushService take over.
   */
  private handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, origin: string): void {
    const route =
      pathname === '/api/upload' ? this.handlers.onUpload : pathname === '/api/push/subscribe' ? this.handlers.onPushSubscribe : undefined
    if (req.method !== 'POST' || !route) return this.sendStatus(res, 404, 'Not Found', true)
    if (req.headers.origin !== origin) return this.sendStatus(res, 403, 'Forbidden', true)
    route(req, res)
  }

  /** Read a file (cached in production, re-read each request in dev). */
  private load(absPath: string): CachedFile | null {
    if (this.prod) {
      const hit = this.cache.get(absPath)
      if (hit) return hit
    }
    try {
      const body = readFileSync(absPath)
      const type = MIME[extname(absPath).toLowerCase()] ?? 'application/octet-stream'
      const entry: CachedFile = { body, type }
      if (this.prod) this.cache.set(absPath, entry)
      return entry
    } catch {
      return null
    }
  }

  // --- Helpers --------------------------------------------------------------

  /**
   * The Host check of every request (static, `/api/`, WS upgrade). Two kinds
   * pass: one of our own IP literals (validateHost), or, only from a loopback
   * socket while the secure mode is on, its exact MagicDNS name (the `tailscale
   * serve` proxy keeps the browser's Host). A foreign page resolving some
   * other name to our port fails both.
   */
  private validateRequest(req: IncomingMessage): AcceptedRequest | null {
    const hostHeader = req.headers.host
    if (!hostHeader) return null
    const secure = this.handlers.secureHost?.() ?? null
    if (secure && hostHeader.toLowerCase() === secure && isLoopbackAddress(req.socket.remoteAddress)) {
      const ip = forwardedIp(req.headers['x-forwarded-for']) ?? normalizeIp(req.socket.remoteAddress)
      return { origin: `https://${hostHeader}`, host: secure, ip }
    }
    if (!this.validateHost(hostHeader)) return null
    return { origin: `http://${hostHeader}`, host: hostIp(hostHeader), ip: normalizeIp(req.socket.remoteAddress) }
  }

  /**
   * Accept only a Host that is one of our own IP literals (loopback / RFC1918 /
   * CGNAT-Tailscale) on the configured port. A hostname or foreign IP is
   * rejected, which is what stops DNS-rebinding from reaching this server.
   */
  private validateHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false
    let host = hostHeader
    let portStr = ''
    const first = hostHeader.indexOf(':')
    if (first !== -1 && first === hostHeader.lastIndexOf(':')) {
      host = hostHeader.slice(0, first)
      portStr = hostHeader.slice(first + 1)
    }
    if (portStr && Number(portStr) !== this.port) return false
    return isPrivateOrTailnet(host)
  }

  /** A plain-text status; `close` ends the connection so an unread request body is not drained. */
  private sendStatus(res: ServerResponse, code: number, text: string, close = false): void {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...(close ? { 'Cache-Control': 'no-store', Connection: 'close' } : {}),
    })
    res.end(text)
  }

  private sendMissingBundle(res: ServerResponse): void {
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
    })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>' + BRAND.mobileTitle + '</title>' +
        '<body style="font-family:system-ui;padding:2rem;background:#111;color:#eee">' +
        '<h1>Mobile bundle not built</h1>' +
        '<p>Run <code>npm run build:mobile</code> (or a full <code>npm run build</code>) ' +
        'so <code>out/mobile</code> exists, then reload.</p>',
    )
  }
}
