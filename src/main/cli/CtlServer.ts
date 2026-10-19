import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { chmodSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BRAND } from '@shared/brand'
import { CTL_MAX_BODY, CTL_METHODS, CTL_RPC_PATH, type CtlMethod, type CtlResponse, type SnaosRuntimeFile } from '@shared/ctl-protocol'
import type { CtlCaller } from './CtlTokens'

/** Resolves a bearer token: the console it belongs to, 'master', or null. */
export type TokenResolver = (token: string) => CtlCaller | 'master' | null

/** One RPC. `caller` is null with the master token; `signal` aborts when the client goes away. */
export type CtlHandler = (method: CtlMethod, params: Record<string, unknown>, caller: CtlCaller | null, signal: AbortSignal) => Promise<CtlResponse>

/** Longest unix socket path we use (sun_path is ~104-108 bytes). */
const MAX_SOCKET_PATH = 100
/** A body past this is not even drained: the connection is dropped. */
const HARD_BODY_CAP = 8 * CTL_MAX_BODY

/**
 * Where this run listens (E8-FR-12): a random named pipe on Windows, else
 * `<dataDir>/snaos.sock` or, when that path is too long, a random socket in
 * XDG_RUNTIME_DIR / the temp folder.
 */
export function ctlEndpoint(dataDir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SnaosRuntimeFile['transport'] {
  if (platform === 'win32') return { kind: 'named-pipe', endpoint: `\\\\.\\pipe\\${BRAND.packageName}-ctl-${randomBytes(8).toString('hex')}` }
  const preferred = join(dataDir, `${BRAND.cliBin}.sock`)
  if (preferred.length <= MAX_SOCKET_PATH) return { kind: 'unix', endpoint: preferred }
  return { kind: 'unix', endpoint: join(env.XDG_RUNTIME_DIR || tmpdir(), `${BRAND.cliBin}-${randomBytes(4).toString('hex')}.sock`) }
}

function sendJson(res: ServerResponse, status: number, body: unknown, close = false): void {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...(close ? { Connection: 'close' } : {}),
  })
  res.end(text)
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  const m = h.match(/^Bearer\s+(\S+)$/)
  return m ? m[1] : null
}

/**
 * The local control server of the CLI (E8-FR-12). HTTP/1.1 on a pipe or a
 * socket, never TCP: every request needs a valid bearer (master or console
 * token, compared timing-safe by the resolver), a request with an `Origin`
 * header is refused (browsers), the body is capped at 1 MB and there is no
 * CORS. No timers at rest. `requestTimeout` only bounds receiving a request;
 * a `wait` response stays open until it settles or the client leaves.
 */
export class CtlServer {
  private server: Server | null = null

  constructor(
    private readonly transport: SnaosRuntimeFile['transport'],
    private readonly resolveToken: TokenResolver,
    private readonly handle: CtlHandler,
  ) {}

  get running(): boolean {
    return this.server?.listening === true
  }

  get endpoint(): string {
    return this.transport.endpoint
  }

  async start(): Promise<void> {
    if (this.server) return
    if (this.transport.kind === 'unix') {
      // A socket file left by a crashed run would make listen fail with EADDRINUSE.
      try {
        unlinkSync(this.transport.endpoint)
      } catch {
        /* none */
      }
    }
    const server = createServer((req, res) => this.onRequest(req, res))
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.transport.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (this.transport.kind === 'unix') {
      try {
        chmodSync(this.transport.endpoint, 0o600)
      } catch {
        /* best effort */
      }
    }
    server.on('error', (error) => console.warn('[cli] control server error:', error instanceof Error ? error.message : String(error)))
    this.server = server
  }

  /** Closes the listener and drops open connections (pending waits see their socket close). */
  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    if (this.transport.kind === 'unix') {
      try {
        unlinkSync(this.transport.endpoint)
      } catch {
        /* already gone */
      }
    }
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    // Browsers always send Origin on a cross-origin POST: never served.
    if (req.headers.origin !== undefined) {
      req.resume()
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'requests with an Origin header are not accepted' } }, true)
      return
    }
    const token = bearer(req)
    const who = token ? this.resolveToken(token) : null
    if (!who) {
      req.resume()
      sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: 'missing or invalid token' } }, true)
      return
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== CTL_RPC_PATH) {
      req.resume()
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `use POST ${CTL_RPC_PATH}` } })
      return
    }
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > HARD_BODY_CAP) {
      sendJson(res, 413, { ok: false, error: { code: 'bad_request', message: 'request body too large' } }, true)
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = declared > CTL_MAX_BODY
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > HARD_BODY_CAP) {
        sendJson(res, 413, { ok: false, error: { code: 'bad_request', message: 'request body too large' } }, true)
        req.destroy()
        return
      }
      if (size > CTL_MAX_BODY) tooLarge = true
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('error', () => res.destroy())
    req.on('end', () => {
      if (tooLarge) {
        sendJson(res, 413, { ok: false, error: { code: 'bad_request', message: 'request body too large' } }, true)
        return
      }
      void this.dispatch(Buffer.concat(chunks), who === 'master' ? null : who, res)
    })
  }

  private async dispatch(body: Buffer, caller: CtlCaller | null, res: ServerResponse): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 200, { ok: false, error: { code: 'bad_request', message: 'invalid JSON' } })
      return
    }
    const msg = parsed as { v?: unknown; method?: unknown; params?: unknown } | null
    if (!msg || typeof msg !== 'object' || msg.v !== 1 || typeof msg.method !== 'string' || !(CTL_METHODS as readonly string[]).includes(msg.method)) {
      sendJson(res, 200, { ok: false, error: { code: 'bad_request', message: 'unknown method or protocol version' } })
      return
    }
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? (msg.params as Record<string, unknown>) : {}
    // The client leaving (Ctrl+C during a wait) cancels the work.
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    let out: CtlResponse
    try {
      out = await this.handle(msg.method as CtlMethod, params, caller, abort.signal)
    } catch (error) {
      console.warn('[cli] handler failed:', error instanceof Error ? error.message : String(error))
      out = { ok: false, error: { code: 'internal', message: 'internal error' } }
    }
    sendJson(res, 200, out)
  }
}
