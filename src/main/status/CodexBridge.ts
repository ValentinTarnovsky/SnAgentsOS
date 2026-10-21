import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { delimiter, join } from 'path'
import { createInterface } from 'readline'
import type { IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { AGENT_ENV } from '@shared/brand'
import { CodexProtocol } from './CodexProtocol'
import type { AgentEvent } from './events'
import type { PtyExitInfo, PtySink } from '../pty/PtyManager'
import { samePath, statusBinDirs } from '../pty/shellResolver'

/** v2.4: how often environment() may look for codex.exe again while the bridge is down. */
export const CODEX_RESCAN_MS = 60_000

interface Binding { paneId: string; ptyId: string; cwd: string; env?: NodeJS.ProcessEnv; sessionId?: string; finished?: boolean; socket?: WebSocket; child?: ChildProcessWithoutNullStreams }

/** Private loopback bridge. Each PTY gets a random bearer token and a single TUI connection. */
export class CodexBridge implements PtySink {
  readonly id = 'codex-status'
  private server: WebSocketServer | null = null
  private bindings = new Map<string, Binding>()
  private children = new Map<ChildProcessWithoutNullStreams, string>()
  private port = 0
  private executable = ''
  private error: string | undefined
  private enabled = false
  private startPromise: Promise<void> | null = null
  /** v2.4: no codex.exe on PATH at the last scan; a neutral state (on by default, Codex not installed). */
  private missing = false
  /** When the last start scanned for the executable (the lazy rescan's clock). */
  private lastScan = 0
  constructor(private directory: () => string, private runtimePath: string, private emit: (evt: AgentEvent) => void) {}
  get health() { return { enabled: this.enabled, available: !!this.executable, connected: [...this.bindings.values()].filter(b => b.socket?.readyState === WebSocket.OPEN).length, error: this.error, ...(this.enabled && this.missing ? { missing: true } : {}) } }
  async configure(enabled: boolean): Promise<void> {
    this.enabled = enabled
    if (!enabled) return // Existing sessions keep their transport until they exit.
    // A start in flight first: its server exists before it listens.
    if (this.startPromise) return this.startPromise
    if (this.server) return
    this.startPromise = this.start().catch(() => { this.error = 'Could not prepare the Codex launcher'; this.server?.close(); this.server = null }).finally(() => { this.startPromise = null })
    return this.startPromise
  }
  private async start(): Promise<void> {
    this.lastScan = Date.now()
    this.executable = this.findExecutable()
    this.missing = !this.executable
    if (!this.executable) { this.error = undefined; return }
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 32 * 1024 * 1024,
      verifyClient: ({ req }: { req: IncomingMessage }) => !req.headers.origin && typeof req.headers.authorization === 'string' && /^(Bearer|Launch) /.test(req.headers.authorization) && this.bindings.has(req.headers.authorization.slice(7)),
    })
    this.server = server
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) }).catch(() => {
      this.server = null; this.error = 'Could not start the local Codex bridge'
    })
    if (!this.server) return
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    server.on('error', () => { this.error = 'Local Codex bridge connection failed' })
    server.on('connection', (socket, req) => {
      const binding = this.bindings.get((req.headers.authorization ?? '').slice(7))
      if (!binding) { socket.close(1008); return }
      if (req.headers.authorization?.startsWith('Launch ')) {
        // The launcher supplies its actual shell environment and current directory.
        // Keep credentials in memory only; never persist or log this payload.
        const timer = setTimeout(() => socket.terminate(), 3000)
        socket.on('error', () => socket.close())
        socket.once('close', () => clearTimeout(timer))
        socket.once('message', data => {
          try {
            const context = JSON.parse(data.toString())
            if (Number.isInteger(context.exitCode)) {
              binding.finished = true
              if (!binding.sessionId) {
                binding.sessionId = `launch:${randomBytes(8).toString('hex')}`
                this.emit({ paneId: binding.paneId, ptyId: binding.ptyId, provider: 'codex', sessionId: binding.sessionId, kind: 'start' })
              }
              this.emit({ paneId: binding.paneId, ptyId: binding.ptyId, provider: 'codex', sessionId: binding.sessionId, kind: context.exitCode === 0 ? 'end' : 'error' })
            } else {
              if (binding.socket || typeof context.cwd !== 'string' || !context.env || typeof context.env !== 'object' || Array.isArray(context.env) || Object.values(context.env).some(v => typeof v !== 'string')) throw new Error('Invalid launch context')
              binding.cwd = context.cwd; binding.env = context.env; binding.finished = false; binding.sessionId = undefined
            }
            socket.send('{"ok":true}'); socket.close()
          } catch { socket.close(1008) }
        })
        return
      }
      if (binding.socket) { socket.close(1008); return }
      binding.socket = socket
      this.connect(binding, socket)
    })
    this.writeLauncher()
    this.error = undefined
  }
  environment(ptyId: string, paneId: string, cwd: string): Record<string, string> {
    // v2.4: enabled with no bridge (Codex installed later, or a failed start):
    // scan again at most once a minute; the next console spawned gets it
    // (this one never: the server starts listening asynchronously).
    if (this.enabled && !this.server && !this.startPromise && Date.now() - this.lastScan >= CODEX_RESCAN_MS) { void this.configure(true); return {} }
    if (!this.enabled || !this.server || !this.executable || !this.port) return {}
    const route = randomBytes(24).toString('hex')
    this.bindings.set(route, { ptyId, paneId, cwd })
    return { [AGENT_ENV.codexUrl]: `ws://127.0.0.1:${this.port}`, [AGENT_ENV.codexToken]: route, [AGENT_ENV.realCodex]: this.executable, [AGENT_ENV.codexShim]: this.directory() }
  }
  onSpawn(): void {}
  onData(): void {}
  /** Every exit (natural or not) tears down the pty's Codex bridge. */
  onExit(ptyId: string, _paneId?: string, _exitCode?: number, _info?: PtyExitInfo): void {
    for (const [child, owner] of this.children) if (owner === ptyId) child.kill()
    for (const [route, b] of this.bindings) if (b.ptyId === ptyId) {
      b.socket?.close(); b.child?.kill(); this.bindings.delete(route)
    }
  }
  dispose(): void {
    for (const child of this.children.keys()) child.kill()
    this.children.clear()
    for (const b of this.bindings.values()) { b.socket?.terminate(); b.child?.kill() }
    this.bindings.clear(); this.server?.close(); this.server = null
  }
  private connect(binding: Binding, socket: WebSocket): void {
    const protocol = new CodexProtocol(binding.paneId, binding.ptyId, evt => {
      binding.sessionId = evt.sessionId
      // The launcher reported its real directory; the store and the renderer use it as cwd.
      if (!binding.finished) this.emit({ ...evt, cwd: binding.cwd })
    })
    // An isolated stdio server gives this TUI exclusive, observable ownership.
    // The shared daemon control socket uses a different framing protocol.
    // The app server runs Codex's commands: a `claude -p` among them reports
    // its hooks as a sub-session of this console (AGENT_ENV.agentParent).
    const env = { ...(binding.env ?? process.env), ELECTRON_RUN_AS_NODE: undefined, [AGENT_ENV.agentParent]: `codex:${binding.paneId}` }
    const child = spawn(this.executable, ['app-server', '--stdio'], { cwd: binding.cwd, windowsHide: true, stdio: 'pipe', env })
    binding.child = child
    this.children.set(child, binding.ptyId)
    child.once('exit', () => this.children.delete(child))
    child.once('error', () => this.children.delete(child))
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      protocol.server(line)
      if (socket.readyState === WebSocket.OPEN) socket.send(line)
    })
    child.stderr.on('data', () => { /* Never expose backend stderr: it may contain user data. */ })
    child.stdin.on('error', () => socket.close(1011))
    socket.on('message', data => {
      const message = data.toString()
      protocol.client(message)
      if (!child.stdin.destroyed) child.stdin.write(message + '\n')
    })
    const failed = (): void => { this.error = 'Codex connection closed; verify that your CLI supports app-server --stdio and --remote'; protocol.disconnected(); socket.close(1011) }
    child.on('error', failed)
    child.on('exit', () => { if (socket.readyState === WebSocket.OPEN) failed() })
    socket.on('error', () => socket.close())
    socket.on('close', () => {
      protocol.disconnected(); lines.close(); child.stdin.end()
      const timer = setTimeout(() => child.kill(), 2000)
      timer.unref()
      child.once('exit', () => clearTimeout(timer))
      binding.socket = undefined; binding.child = undefined
    })
  }
  private findExecutable(): string {
    // Skip our launcher and the 1.x one an inherited PATH may still carry:
    // taking a shim for the real CLI would recurse into itself.
    const shims = [this.directory(), ...statusBinDirs()]
    for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
      const path = join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'codex.exe' : 'codex')
      if (existsSync(path) && !shims.some(shim => samePath(dir, shim))) return path
    }
    return ''
  }
  private writeLauncher(): void {
    const dir = this.directory()
    mkdirSync(dir, { recursive: true })
    if (process.platform === 'win32') {
      const executable = process.execPath.replace(/%/g, '%%')
      const runtime = this.runtimePath.replace(/%/g, '%%')
      const shim = dir.replace(/%/g, '%%')
      writeFileSync(join(dir, 'codex.cmd'), `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executable}" "${runtime}" --snaos-prepare %*\r\nif errorlevel 11 exit /b 1\r\nif errorlevel 10 goto passthrough\r\nif errorlevel 1 exit /b 1\r\nset ELECTRON_RUN_AS_NODE=\r\nset "PATH=%PATH:${shim};=%"\r\n"%${AGENT_ENV.realCodex}%" --remote "%${AGENT_ENV.codexUrl}%" --remote-auth-token-env ${AGENT_ENV.codexToken} %*\r\nset "${AGENT_ENV.codexExit}=%errorlevel%"\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executable}" "${runtime}" --snaos-end\r\nexit /b %${AGENT_ENV.codexExit}%\r\n:passthrough\r\nset ELECTRON_RUN_AS_NODE=\r\nset "PATH=%PATH:${shim};=%"\r\n"%${AGENT_ENV.realCodex}%" %*\r\n`, 'utf8')
    } else {
      const quote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
      writeFileSync(join(dir, 'codex'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(this.runtimePath)} "$@"\n`, { encoding: 'utf8', mode: 0o700 })
    }
  }
}
