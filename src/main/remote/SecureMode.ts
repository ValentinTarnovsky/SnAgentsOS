/**
 * Secure mode (E3-FR-42): an https origin for the phone through `tailscale
 * serve`, so the PWA gets a secure context (service worker, Web Push, Wake
 * Lock, clipboard.readText, the live camera) without any certificate of ours.
 *
 * Tailscale terminates TLS on https:443 of this machine's MagicDNS name and
 * proxies to http://127.0.0.1:<port>; the embedded server accepts that Host
 * only from loopback (RemoteServer). What this module does with the CLI:
 *
 *  - `status --json`: the MagicDNS name (`Self.DNSName`) and `CertDomains`.
 *    Without both the tailnet has no certificates: error `no_https` (the UI
 *    links to the admin console),
 *  - `serve status --json`: https:443 must be free or already ours (one "/"
 *    handler proxying to our port). A foreign handler is `port_busy` and an
 *    `AllowFunnel` on it is `funnel`; in both cases nothing is applied,
 *  - `serve --bg --https=443 http://127.0.0.1:<port>` to apply, and
 *    `serve --https=443 off` to remove, only when the handler is ours.
 *
 * It never calls `funnel`. A failing CLI surfaces its stderr as is. Every
 * call goes through an injectable execFile with a 5 s timeout, so the tests
 * drive it with a stub and never touch a real tailnet.
 */
import { execFile as nodeExecFile } from 'child_process'
import { existsSync } from 'fs'
import type { SecureModeError } from '@shared/ipc-contract'

/** Per CLI call (E3 M14). */
export const SECURE_CLI_TIMEOUT_MS = 5000
/** Where the admin console turns on MagicDNS and HTTPS certificates. */
export const TAILSCALE_DNS_CONSOLE = 'https://login.tailscale.com/admin/dns'
/** Longest CLI output kept for the UI. */
const MESSAGE_MAX = 500

export interface ExecResult {
  /** 0 on success; null when the process never ran (ENOENT) or timed out. */
  code: number | null
  stdout: string
  stderr: string
  /** spawn error code (ENOENT, ETIMEDOUT...), when it never finished. */
  error?: string
}

export type SecureExec = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>

export type SecureResult = { ok: true; dnsName: string } | { ok: false; error: SecureModeError; message?: string }

export interface SecureModeDeps {
  exec?: SecureExec
  /** The tailscale binary; default: the installed one, else `tailscale` on PATH. */
  binary?: () => string
}

function defaultBinary(): string {
  const candidates =
    process.platform === 'win32'
      ? [`${process.env.ProgramFiles || 'C:\\Program Files'}\\Tailscale\\tailscale.exe`, 'C:\\Program Files\\Tailscale\\tailscale.exe']
      : process.platform === 'darwin'
        ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']
        : []
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* next */
    }
  }
  return 'tailscale'
}

const defaultExec: SecureExec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    nodeExecFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      const e = err as Error & { code?: number | string; killed?: boolean }
      if (typeof e.code === 'number') return resolve({ code: e.code, stdout: stdout ?? '', stderr: stderr ?? '' })
      resolve({ code: null, stdout: stdout ?? '', stderr: stderr ?? '', error: e.killed ? 'ETIMEDOUT' : String(e.code ?? 'EFAIL') })
    })
  })

/** `machine.tailnet.ts.net.` -> `machine.tailnet.ts.net` (lowercase, no trailing dot). */
export function normalizeDnsName(name: unknown): string {
  return typeof name === 'string' ? name.trim().replace(/\.+$/, '').toLowerCase() : ''
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** What `tailscale status --json` says about certificates (pure, for the tests). */
export function readTailnetStatus(json: Record<string, unknown>): SecureResult {
  const state = typeof json.BackendState === 'string' ? json.BackendState : ''
  if (state && state !== 'Running') return { ok: false, error: 'not_running', message: state }
  const dnsName = normalizeDnsName(obj(json.Self)?.DNSName)
  const certDomains = Array.isArray(json.CertDomains) ? json.CertDomains.map(normalizeDnsName) : []
  if (!dnsName || !certDomains.includes(dnsName)) return { ok: false, error: 'no_https' }
  return { ok: true, dnsName }
}

/** The proxy target of ours for a port, as tailscale may print it. */
function isOurProxy(target: unknown, port: number): boolean {
  if (typeof target !== 'string') return false
  const t = target.trim().replace(/\/+$/, '').toLowerCase()
  return t === `http://127.0.0.1:${port}` || t === `http://localhost:${port}`
}

export type ServeVerdict =
  | { kind: 'free' }
  | { kind: 'ours' }
  | { kind: 'foreign'; detail: string }
  | { kind: 'funnel' }

/**
 * How https:443 of `dnsName` is served (pure, for the tests). `ports` are the
 * targets that count as ours (the current port, plus the previous one while
 * the port changes). Funnel wins over everything: it is never touched.
 */
export function readServeStatus(json: Record<string, unknown>, dnsName: string, ports: number[]): ServeVerdict {
  const hostKey = (k: string): boolean => {
    const i = k.lastIndexOf(':')
    return i > 0 && k.slice(i + 1) === '443' && normalizeDnsName(k.slice(0, i)) === dnsName
  }
  const funnel = obj(json.AllowFunnel)
  if (funnel && Object.entries(funnel).some(([k, v]) => v === true && (hostKey(k) || k.endsWith(':443')))) return { kind: 'funnel' }
  const tcp = obj(obj(json.TCP)?.['443'])
  const web = obj(json.Web)
  const webKeys = web ? Object.keys(web).filter(hostKey) : []
  if (!tcp && webKeys.length === 0) return { kind: 'free' }
  if (tcp && (tcp.TCPForward || tcp.TerminateTLS)) return { kind: 'foreign', detail: String(tcp.TCPForward ?? tcp.TerminateTLS) }
  if (webKeys.length === 0) return { kind: 'foreign', detail: 'tcp:443' }
  for (const k of webKeys) {
    const handlers = obj(obj(web?.[k])?.Handlers) ?? {}
    const mounts = Object.keys(handlers)
    if (mounts.length !== 1 || mounts[0] !== '/') return { kind: 'foreign', detail: mounts.join(', ') || k }
    const proxy = obj(handlers['/'])?.Proxy
    if (!ports.some((p) => isOurProxy(proxy, p))) {
      const h = obj(handlers['/'])
      return { kind: 'foreign', detail: String(proxy ?? h?.Path ?? h?.Text ?? '/') }
    }
  }
  return { kind: 'ours' }
}

function clipMessage(text: string): string {
  return text.trim().slice(0, MESSAGE_MAX)
}

export class SecureMode {
  private readonly exec: SecureExec
  private readonly binary: () => string

  constructor(deps: SecureModeDeps = {}) {
    this.exec = deps.exec ?? defaultExec
    this.binary = deps.binary ?? defaultBinary
  }

  private async run(args: string[]): Promise<ExecResult> {
    return this.exec(this.binary(), args, SECURE_CLI_TIMEOUT_MS)
  }

  /** A CLI run that did not succeed, as a SecureResult. */
  private failure(res: ExecResult): SecureResult {
    if (res.error === 'ENOENT') return { ok: false, error: 'not_installed' }
    const message = clipMessage(res.stderr || res.stdout || res.error || '')
    return { ok: false, error: 'cli', ...(message ? { message } : {}) }
  }

  private async tailnet(): Promise<SecureResult> {
    const res = await this.run(['status', '--json'])
    // A stopped or logged out tailscale still prints JSON with a BackendState.
    const json = parseJson(res.stdout)
    if (json) return readTailnetStatus(json)
    return this.failure(res)
  }

  private async serveVerdict(dnsName: string, ports: number[]): Promise<ServeVerdict | SecureResult> {
    const res = await this.run(['serve', 'status', '--json'])
    if (res.code !== 0) return this.failure(res)
    // Nothing served prints an empty body on some versions, `{}` on others.
    const json = res.stdout.trim() ? parseJson(res.stdout) : {}
    if (!json) return { ok: false, error: 'cli', message: clipMessage(res.stdout) }
    return readServeStatus(json, dnsName, ports)
  }

  /**
   * Make https:443 proxy to our port, idempotent: already ours, nothing runs.
   * `previousPort` (a port change while on) also counts as ours, so the old
   * handler is replaced instead of read as foreign.
   */
  async enable(port: number, previousPort?: number): Promise<SecureResult> {
    const net = await this.tailnet()
    if (!net.ok) return net
    const ports = previousPort && previousPort !== port ? [port, previousPort] : [port]
    const verdict = await this.serveVerdict(net.dnsName, ports)
    if ('ok' in verdict) return verdict
    if (verdict.kind === 'funnel') return { ok: false, error: 'funnel' }
    if (verdict.kind === 'foreign') return { ok: false, error: 'port_busy', message: clipMessage(verdict.detail) }
    if (verdict.kind === 'ours') {
      if (ports.length === 1) return net
      // Ours on the previous port: drop it before pointing at the new one.
      const off = await this.run(['serve', '--https=443', 'off'])
      if (off.code !== 0) return this.failure(off)
    }
    const res = await this.run(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`])
    if (res.code !== 0) return this.failure(res)
    return net
  }

  /** Remove the https:443 handler, only when it is ours; anything else stays. */
  async disable(port: number): Promise<SecureResult | { ok: true; dnsName: string | null }> {
    const net = await this.tailnet()
    if (!net.ok) return net.error === 'cli' || net.error === 'not_installed' ? net : { ok: true, dnsName: null }
    const verdict = await this.serveVerdict(net.dnsName, [port])
    if ('ok' in verdict) return verdict
    if (verdict.kind !== 'ours') return net
    const res = await this.run(['serve', '--https=443', 'off'])
    if (res.code !== 0) return this.failure(res)
    return net
  }
}
