/**
 * Share listener (app 2.4.0, item 8): its own port (`settings.share.port`,
 * default 4527), separate from the phone server, serving nothing but the
 * `/share` WebSocket upgrade. Every plain HTTP request is 404 with
 * `Connection: close`.
 *
 * An upgrade is admitted only when ALL hold, so no web page can reach it
 * (a browser's WebSocket API cannot set custom headers, always sends Origin
 * and, in current browsers, the Fetch Metadata headers):
 *  - path `/share` (query string refused);
 *  - `x-snaos-share: 1`;
 *  - no `Origin` header and no `Sec-Fetch-*` header;
 *  - `Sec-WebSocket-Protocol` offers `snaos-share.1`;
 *  - the Host header is an IPv4 literal on our port that passes
 *    isPrivateOrTailnet (no DNS names: DNS rebinding is out);
 *  - the socket's source address is loopback, RFC 1918 or tailnet (defense
 *    in depth against an accidental port forward).
 * ws runs with `noServer`, `maxPayload` = guest frame cap + AEAD overhead
 * and no permessage-deflate. Per-IP limits, handshake timeout, admission and
 * everything after live in HostSessions; this file only hands it a
 * ShareTransport per accepted socket.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer, WebSocket } from 'ws'
import { SHARE_HEADER, SHARE_LIMITS, SHARE_SUBPROTOCOL, SHARE_WS_PATH } from '@shared/share-protocol'
import { isPrivateOrTailnet, normalizeIp } from '../remote/network'
import type { ShareFrame, ShareTransport } from './transport'

/** AES-GCM tag plus slack over the guest frame cap. */
export const SHARE_WS_MAX_PAYLOAD = SHARE_LIMITS.guestFrameMax + 64

export interface ShareUpgradeReq {
  url?: string
  headers: IncomingHttpHeaders
  remoteAddress?: string
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

/** The upgrade rules above; pure, so the tests run them without a socket. */
export function checkShareUpgrade(req: ShareUpgradeReq, port: number): boolean {
  if (req.url !== SHARE_WS_PATH) return false
  const h = req.headers
  if (headerValue(h[SHARE_HEADER]) !== '1') return false
  if (h.origin !== undefined) return false
  for (const name of Object.keys(h)) if (name.toLowerCase().startsWith('sec-fetch-')) return false
  const protocols = (headerValue(h['sec-websocket-protocol']) ?? '').split(',').map((p) => p.trim())
  if (!protocols.includes(SHARE_SUBPROTOCOL)) return false
  const host = headerValue(h.host) ?? ''
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(host)
  if (!m || Number(m[2]) !== port || !isPrivateOrTailnet(m[1])) return false
  const src = normalizeIp(req.remoteAddress)
  return isPrivateOrTailnet(src)
}

/** A ws socket as a ShareTransport (host end). */
export class WsShareTransport implements ShareTransport {
  readonly remoteIp: string

  constructor(private readonly ws: WebSocket, ip: string) {
    this.remoteIp = ip
  }

  get closed(): boolean {
    return this.ws.readyState !== WebSocket.OPEN
  }

  send(frame: ShareFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(frame, { binary: typeof frame !== 'string' })
    } catch {
      /* dying socket: the close handler cleans up */
    }
  }

  close(code: number, reason = ''): void {
    try {
      this.ws.close(code, reason.slice(0, 120))
    } catch {
      try {
        this.ws.terminate()
      } catch {
        /* ignore */
      }
    }
  }

  bufferedAmount(): number {
    return this.ws.bufferedAmount
  }

  onMessage(cb: (frame: ShareFrame) => void): void {
    this.ws.on('message', (data, isBinary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      cb(isBinary ? buf : buf.toString('utf8'))
    })
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.ws.on('close', (code, reason) => cb(code, reason.toString('utf8')))
    this.ws.on('error', () => {
      /* 'close' follows */
    })
  }
}

export interface ShareListener {
  start(): Promise<void>
  close(): void
}

export class ShareServer implements ShareListener {
  private http: Server | null = null
  private listening = false
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: SHARE_WS_MAX_PAYLOAD,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SHARE_SUBPROTOCOL) ? SHARE_SUBPROTOCOL : false),
  })

  constructor(
    private readonly port: number,
    private readonly onTransport: (transport: ShareTransport) => void,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(404, { Connection: 'close', 'Content-Type': 'text/plain' })
        res.end()
      })
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
      server.on('error', (err) => {
        if (!this.listening) reject(err)
      })
      server.listen(this.port, '0.0.0.0', () => {
        this.listening = true
        resolve()
      })
      this.http = server
    })
  }

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
        this.http.closeAllConnections?.()
      } catch {
        /* ignore */
      }
      this.http = null
    }
    this.listening = false
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      if (!checkShareUpgrade({ url: req.url, headers: req.headers, remoteAddress: req.socket.remoteAddress }, this.port)) {
        socket.destroy()
        return
      }
      const ip = normalizeIp(req.socket.remoteAddress)
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onTransport(new WsShareTransport(ws, ip)))
    } catch {
      socket.destroy()
    }
  }
}
