/**
 * Diagnostics of the phone connection (E2-FR-36): the checks, the "What this
 * suggests" rules and the copied report. Pure functions over a DiagInput the
 * screen assembles, plus probeServer(), a bare WebSocket that has to open in
 * under 4s and is closed with 1000 without sending hello (the server records
 * no failure for it, so the probe can never lock the phone out).
 */
import { REMOTE_CLOSE } from '@shared/remote-protocol'
import { BRAND } from '@shared/brand'
import { endpointHint, formatAgo, type ConnHint } from './connectionHealth'
import { formatEntry, type LastClose, type LogEntry } from './connLog'

export const PROBE_TIMEOUT_MS = 4000
/** Lines of the log in the copied report. */
export const REPORT_LOG_LINES = 50
/** Two abnormal closes in a row count as "repeated" for the 1006 rule. */
export const ABNORMAL_REPEAT = 2

export type CheckResult = 'pass' | 'warn' | 'fail'
export type CheckId = 'paired' | 'route' | 'server' | 'lastClose' | 'version' | 'retries'

export interface DiagCheck {
  id: CheckId
  result: CheckResult
  /** i18n key of the detail line plus its variables. */
  detail: { key: string; vars?: Record<string, string | number> }
}

export type ServerProbe =
  | { kind: 'pending' }
  | { kind: 'rtt'; ms: number }
  | { kind: 'open'; ms: number }
  | { kind: 'fail' }

export interface DiagInput {
  paired: boolean
  hostname: string
  /** An authed socket is open right now. */
  live: boolean
  server: ServerProbe
  lastClose: LastClose | null
  abnormalStreak: number
  /** The desktop's version ('' when unknown). */
  desktopVersion: string
  bundleVersion: string
  retries: number
  lastConnectedAt: number | null
  /** The client parked on 'locked' (rate limited). */
  locked: boolean
  now: number
}

export type SuggestionId = 'abnormal' | 'rePair' | 'revoked' | 'wait' | 'tailscale' | 'reload'

export type CloseMeaning = 'normal' | 'abnormal' | 'unknownDevice' | 'revoked' | 'rateLimited' | 'other'

export function closeMeaning(code: number): CloseMeaning {
  if (code === 1000 || code === 1001) return 'normal'
  if (code === 1006) return 'abnormal'
  if (code === REMOTE_CLOSE.UNKNOWN_DEVICE) return 'unknownDevice'
  if (code === REMOTE_CLOSE.REVOKED) return 'revoked'
  if (code === REMOTE_CLOSE.RATE_LIMITED) return 'rateLimited'
  return 'other'
}

export function routeOf(hostname: string): ConnHint {
  return endpointHint(hostname)
}

function versionsComparable(v: string): boolean {
  return !!v && v !== 'dev'
}

export function buildChecks(i: DiagInput): DiagCheck[] {
  const route = routeOf(i.hostname)
  const checks: DiagCheck[] = []
  checks.push({
    id: 'paired',
    result: i.paired ? 'pass' : 'fail',
    detail: { key: i.paired ? 'diag.paired.yes' : 'diag.paired.no' },
  })
  checks.push({
    id: 'route',
    result: route === 'generic' ? 'warn' : 'pass',
    detail: { key: route === 'tailscale' ? 'diag.route.tailscale' : route === 'lan' ? 'diag.route.lan' : 'diag.route.other', vars: { host: i.hostname } },
  })
  const s = i.server
  checks.push(
    s.kind === 'rtt'
      ? { id: 'server', result: 'pass', detail: { key: 'diag.server.rtt', vars: { ms: s.ms } } }
      : s.kind === 'open'
        ? { id: 'server', result: 'pass', detail: { key: 'diag.server.open', vars: { ms: s.ms } } }
        : s.kind === 'fail'
          ? { id: 'server', result: 'fail', detail: { key: 'diag.server.fail', vars: { s: PROBE_TIMEOUT_MS / 1000 } } }
          : { id: 'server', result: 'warn', detail: { key: 'diag.server.pending' } },
  )
  if (!i.lastClose) {
    checks.push({ id: 'lastClose', result: 'pass', detail: { key: 'diag.close.none' } })
  } else {
    const m = closeMeaning(i.lastClose.code)
    const result: CheckResult = m === 'normal' ? 'pass' : m === 'unknownDevice' || m === 'revoked' ? 'fail' : 'warn'
    checks.push({
      id: 'lastClose',
      result,
      detail: { key: `diag.close.${m}`, vars: { code: i.lastClose.code, t: formatAgo(Math.max(0, i.now - i.lastClose.at)) } },
    })
  }
  if (!versionsComparable(i.desktopVersion) || !versionsComparable(i.bundleVersion)) {
    checks.push({ id: 'version', result: 'warn', detail: { key: 'diag.version.unknown', vars: { b: i.bundleVersion || '?' } } })
  } else {
    const same = i.desktopVersion === i.bundleVersion
    checks.push({
      id: 'version',
      result: same ? 'pass' : 'fail',
      detail: { key: same ? 'diag.version.same' : 'diag.version.diff', vars: { d: i.desktopVersion, b: i.bundleVersion } },
    })
  }
  const last = i.live ? 'now' : i.lastConnectedAt != null ? formatAgo(Math.max(0, i.now - i.lastConnectedAt)) : ''
  checks.push({
    id: 'retries',
    result: i.retries === 0 ? 'pass' : i.live ? 'pass' : 'warn',
    detail: {
      key: i.live ? 'diag.retries.live' : last ? 'diag.retries.last' : 'diag.retries.never',
      vars: { n: i.retries, t: last },
    },
  })
  return checks
}

/** "What this suggests" (E2 design, Group D), most specific first. */
export function suggestions(i: DiagInput): SuggestionId[] {
  const out: SuggestionId[] = []
  const code = i.lastClose?.code
  if (code === REMOTE_CLOSE.REVOKED) out.push('revoked')
  if (code === REMOTE_CLOSE.UNKNOWN_DEVICE || !i.paired) out.push('rePair')
  if (code === REMOTE_CLOSE.RATE_LIMITED || i.locked) out.push('wait')
  if (
    versionsComparable(i.desktopVersion) &&
    versionsComparable(i.bundleVersion) &&
    i.desktopVersion !== i.bundleVersion
  ) {
    out.push('reload')
  }
  const failing = i.server.kind === 'fail' || i.abnormalStreak >= ABNORMAL_REPEAT
  if (failing && !out.includes('revoked') && !out.includes('wait')) {
    out.push('abnormal')
    if (routeOf(i.hostname) === 'tailscale') out.push('tailscale')
  }
  return out
}

export interface ReportInput extends DiagInput {
  userAgent: string
  host: string
  checks: DiagCheck[]
  entries: LogEntry[]
  /** Render a check line in the active language. */
  describe: (c: DiagCheck) => string
}

/** Plain-text report for [Copy report]: versions, UA, host, checks, last 50 lines (already redacted). */
export function buildReport(r: ReportInput): string {
  const lines: string[] = []
  lines.push(`${BRAND.mobileTitle} diagnostics`)
  lines.push(`date: ${new Date(r.now).toISOString()}`)
  lines.push(`desktop: ${r.desktopVersion || '?'}  bundle: ${r.bundleVersion || '?'}`)
  lines.push(`ua: ${r.userAgent}`)
  lines.push(`host: ${r.host}`)
  lines.push('')
  for (const c of r.checks) lines.push(`[${c.result.toUpperCase()}] ${c.id}: ${r.describe(c)}`)
  lines.push('')
  lines.push(`log (last ${REPORT_LOG_LINES}):`)
  for (const e of r.entries.slice(-REPORT_LOG_LINES)) lines.push(formatEntry(e))
  return lines.join('\n')
}

/**
 * Open a bare socket to the server and close it as soon as it opens. Resolves
 * with the open time, or fail on error / close / the 4s deadline.
 */
export function probeServer(host: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ServerProbe> {
  return new Promise((resolve) => {
    const started = performance.now()
    let done = false
    let ws: WebSocket | null = null
    const finish = (p: ServerProbe): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (ws) {
        ws.onopen = null
        ws.onerror = null
        ws.onclose = null
        try {
          ws.close(1000)
        } catch {
          /* ignore */
        }
      }
      resolve(p)
    }
    const timer = setTimeout(() => finish({ kind: 'fail' }), timeoutMs)
    try {
      ws = new WebSocket(`ws://${host}/ws`)
    } catch {
      finish({ kind: 'fail' })
      return
    }
    ws.onopen = () => finish({ kind: 'open', ms: Math.round(performance.now() - started) })
    ws.onerror = () => finish({ kind: 'fail' })
    ws.onclose = () => finish({ kind: 'fail' })
  })
}

/**
 * Copy text from an http:// page: navigator.clipboard needs a secure context,
 * so a LAN origin falls back to a hidden textarea and execCommand('copy').
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
