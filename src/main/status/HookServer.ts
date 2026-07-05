import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'

/** One Claude Code hook event, already attributed to a console. */
export interface HookEvent {
  /** SNMULTICC_CONSOLE_ID forwarded by the hook (the paneId). */
  consoleId: string
  /** hook_event_name: UserPromptSubmit | Stop | StopFailure | Notification | SessionStart | SessionEnd */
  name: string
  /** Notification only: permission_prompt | idle_prompt | elicitation_dialog | ... */
  notificationType?: string
  sessionId?: string
}

const MAX_BODY = 64 * 1024
const REQUEST_TIMEOUT_MS = 3000

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Loopback-only listener for Claude Code hook POSTs. Claude Code is configured
 * (by HookInstaller) with `type: "http"` hooks pointing at
 * `http://127.0.0.1:<port>/cc-hook/<token>` plus an X-Console-Id header
 * interpolated from the SNMULTICC_CONSOLE_ID env var each pty injects.
 *
 * Contract with Claude Code: ALWAYS answer 200 with an empty body. A non-empty
 * body could be parsed as a hook decision and a non-2xx would surface as a
 * hook error inside the user's session, so even malformed requests get 200.
 *
 * Deliberately separate from RemoteServer: that one is LAN-facing and keeps a
 * "no REST endpoints" invariant; this one never leaves 127.0.0.1.
 */
export class HookServer {
  private server: Server | null = null
  private token = ''
  private port = 0
  private listener: ((evt: HookEvent) => void) | null = null

  /** Port actually bound (configured port, or +1 when it was taken). */
  get activePort(): number {
    return this.port
  }

  get running(): boolean {
    return this.server !== null
  }

  onEvent(cb: (evt: HookEvent) => void): void {
    this.listener = cb
  }

  /** Starts listening on 127.0.0.1; falls back to port+1 once if taken. */
  async start(port: number, token: string): Promise<number> {
    await this.stop()
    this.token = token
    this.port = await this.listen(port).catch(() => this.listen(port + 1))
    return this.port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private listen(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res))
      server.on('error', (err) => {
        if (this.server === server) this.server = null
        reject(err)
      })
      server.requestTimeout = REQUEST_TIMEOUT_MS
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        resolve(port)
      })
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? ''
    const match = /^\/cc-hook\/([^/?]+)/.exec(url)
    if (req.method !== 'POST' || !match || !this.token || !safeEqual(match[1], this.token)) {
      res.statusCode = 404
      res.end()
      return
    }

    let body = ''
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      if (overflow) return
      body += chunk.toString('utf8')
      if (body.length > MAX_BODY) overflow = true
    })
    req.on('error', () => {
      res.statusCode = 200
      res.end()
    })
    req.on('end', () => {
      // Always 200 + empty body (see class comment).
      res.statusCode = 200
      res.end()
      if (overflow) return
      const consoleId = String(req.headers['x-console-id'] ?? '').trim()
      // Empty id => a claude launched outside SnMultiCC; not ours to track.
      if (!consoleId) return
      try {
        const json = JSON.parse(body) as Record<string, unknown>
        const name = typeof json.hook_event_name === 'string' ? json.hook_event_name : ''
        if (!name) return
        this.listener?.({
          consoleId,
          name,
          notificationType:
            typeof json.notification_type === 'string' ? json.notification_type : undefined,
          sessionId: typeof json.session_id === 'string' ? json.session_id : undefined,
        })
      } catch {
        console.warn('[hooks] discarded malformed hook payload')
      }
    })
  }
}
