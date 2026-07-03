/**
 * The embedded HTTP + WebSocket server. Its unauthenticated attack surface is
 * exactly two things: a hardened static file server for the mobile bundle, and
 * a WebSocket upgrade on `/ws`. There are no REST endpoints, so there is no
 * CSRF surface; all control flows through the authenticated WS protocol.
 *
 * Defenses baked in here (the plan's security posture, minus TLS):
 *  - Host header must be one of our own private/tailnet IP literals on the
 *    configured port (anti DNS-rebinding),
 *  - WS upgrades require an Origin exactly equal to `http://<Host>`,
 *  - static paths are decoded, NUL-rejected, and confined under the bundle root,
 *  - responses carry nosniff + a strict CSP and leak no server version.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Duplex } from 'stream'
import { readFileSync } from 'fs'
import { extname, join, resolve, sep } from 'path'
import { app } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import { isPrivateOrTailnet, normalizeIp } from './network'

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

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; font-src 'self'"

interface CachedFile {
  body: Buffer
  type: string
}

export interface RemoteServerHandlers {
  /** A validated WS client connected; hand it to the SessionManager. */
  onSocket: (ws: WebSocket, ip: string) => void
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
      if (!this.validateHost(req.headers.host)) return void socket.destroy()
      // Anti-CSWSH: the Origin must be exactly our own http origin.
      if (req.headers.origin !== `http://${req.headers.host}`) return void socket.destroy()
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handlers.onSocket(ws, normalizeIp(req.socket.remoteAddress))
      })
    } catch {
      socket.destroy()
    }
  }

  // --- Static file serving --------------------------------------------------

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.validateHost(req.headers.host)) return this.sendStatus(res, 400, 'Bad Request')

    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      return this.sendStatus(res, 400, 'Bad Request')
    }
    if (pathname.includes('\0')) return this.sendStatus(res, 400, 'Bad Request')
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

  private sendStatus(res: ServerResponse, code: number, text: string): void {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
    res.end(text)
  }

  private sendMissingBundle(res: ServerResponse): void {
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
    })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>SnMultiCC Remote</title>' +
        '<body style="font-family:system-ui;padding:2rem;background:#111;color:#eee">' +
        '<h1>Mobile bundle not built</h1>' +
        '<p>Run <code>npm run build:mobile</code> (or a full <code>npm run build</code>) ' +
        'so <code>out/mobile</code> exists, then reload.</p>',
    )
  }
}
