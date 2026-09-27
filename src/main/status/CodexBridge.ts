import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { delimiter, join } from 'path'
import { createInterface } from 'readline'
import type { IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { CodexProtocol } from './CodexProtocol'
import type { AgentEvent } from './events'
import type { PtySink } from '../pty/PtyManager'

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
  constructor(private directory: () => string, private runtimePath: string, private emit: (evt: AgentEvent) => void) {}
  get health() { return { enabled: this.enabled, available: !!this.executable, connected: [...this.bindings.values()].filter(b => b.socket?.readyState === WebSocket.OPEN).length, error: this.error } }
  async configure(enabled: boolean): Promise<void> {
    this.enabled = enabled
    if (!enabled) return // Existing sessions keep their transport until they exit.
    if (this.server) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start().catch(() => { this.error = 'Could not prepare the Codex launcher'; this.server?.close(); this.server = null }).finally(() => { this.startPromise = null })
    return this.startPromise
  }
  private async start(): Promise<void> {
    this.executable = this.findExecutable()
    if (!this.executable) { this.error = 'Codex executable not found in PATH'; return }
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
    if (!this.enabled || !this.server || !this.executable) return {}
    const route = randomBytes(24).toString('hex')
    this.bindings.set(route, { ptyId, paneId, cwd })
    return { SNMULTICC_CODEX_URL: `ws://127.0.0.1:${this.port}`, SNMULTICC_CODEX_TOKEN: route, SNMULTICC_REAL_CODEX: this.executable, SNMULTICC_CODEX_SHIM: this.directory() }
  }
  onSpawn(): void {}
  onData(): void {}
  onExit(ptyId: string): void {
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
      if (!binding.finished) this.emit(evt)
    })
    // An isolated stdio server gives this TUI exclusive, observable ownership.
    // The shared daemon control socket uses a different framing protocol.
    const child = spawn(this.executable, ['app-server', '--stdio'], { cwd: binding.cwd, windowsHide: true, stdio: 'pipe', env: { ...(binding.env ?? process.env), ELECTRON_RUN_AS_NODE: undefined } })
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
    for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
      const path = join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'codex.exe' : 'codex')
      if (existsSync(path) && dir !== this.directory()) return path
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
      writeFileSync(join(dir, 'codex.cmd'), `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executable}" "${runtime}" --snmulticc-prepare %*\r\nif errorlevel 11 exit /b 1\r\nif errorlevel 10 goto passthrough\r\nif errorlevel 1 exit /b 1\r\nset ELECTRON_RUN_AS_NODE=\r\nset "PATH=%PATH:${shim};=%"\r\n"%SNMULTICC_REAL_CODEX%" --remote "%SNMULTICC_CODEX_URL%" --remote-auth-token-env SNMULTICC_CODEX_TOKEN %*\r\nset "SNMULTICC_CODEX_EXIT=%errorlevel%"\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executable}" "${runtime}" --snmulticc-end\r\nexit /b %SNMULTICC_CODEX_EXIT%\r\n:passthrough\r\nset ELECTRON_RUN_AS_NODE=\r\nset "PATH=%PATH:${shim};=%"\r\n"%SNMULTICC_REAL_CODEX%" %*\r\n`, 'utf8')
    } else {
      const quote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
      writeFileSync(join(dir, 'codex'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(this.runtimePath)} "$@"\n`, { encoding: 'utf8', mode: 0o700 })
    }
  }
}
