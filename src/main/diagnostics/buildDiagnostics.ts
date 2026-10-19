import type { AppMetrics, CrashRecord, RemoteServerStatus, RenderErrorReport, RendererDiagnostics } from '@shared/ipc-contract'
import type { ConfigFile, StatusHealth } from '@shared/types'
import { redact } from '@shared/redact'

/**
 * "Copy diagnostics" (E4-FR-24): a markdown block of at most 64KB built from
 * an ALLOWLIST. Only the fields named here are ever read; `settings`,
 * `connections` (their `send` can be passwords), quick commands, keyButtons,
 * schedules, the hookToken, the webhook and remote-devices.json are never
 * serialized. `redact()` runs on top as defense in depth. Pattern after
 * Orca's crash-report-copy-text.ts (no code taken). No Electron import, so the
 * suite runs it in a vm with fake inputs.
 */
export const DIAGNOSTICS_MAX_BYTES = 64 * 1024

export interface DiagnosticsAppInfo {
  version: string
  installKind: string
  platform: string
  arch: string
  osRelease: string
  systemVersion: string
  electron: string
  chrome: string
  node: string
  uptimeSec: number
}

export interface DiagnosticsInput {
  app: DiagnosticsAppInfo
  configVersion: number
  config: ConfigFile | null
  /** null when the renderer is gone (breaker dialog). */
  renderer: RendererDiagnostics | null
  /** Render errors main received, used when `renderer` is null. */
  mainRenderErrors: RenderErrorReport[]
  metrics: AppMetrics | null
  health: StatusHealth | null
  remote: RemoteServerStatus | null
  crashes: CrashRecord[]
  logLines: string[]
  home: string
}

/** Boolean / enum settings that may be named (values only, never free text). */
const FEATURE_PATHS: string[] = [
  'remote.enabled',
  'notifications.enabled',
  'notifications.hooksEnabled',
  'notifications.codexEnabled',
  'notifications.discord.enabled',
  'notifications.ntfy.enabled',
  'notifications.onlyWhenAway',
  'notifications.inAppWhenFocused',
  'closeToTray',
  'confirmCloseRunning',
  'launchOnStartup',
  'autoCheckUpdates',
  'globalHotkeyEnabled',
  'gitChip',
  'explorerMenu',
  'persistScrollback',
  'infiniteScrollback',
  'terminalUnicode11',
  'terminalAgentEndChip',
  'terminalSelectionOverride',
  'terminalRenderer',
  'terminalSnapshotMode',
  'terminalShellIntegration',
  'awakeMode',
  'language',
  'theme',
  'usage.enabled',
  'agents.resumeOnStartup',
  'agents.sidebarSort',
]
const ENUM_RE = /^[a-z][a-zA-Z0-9-]{0,23}$/

function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/** Values to scrub even if they slipped into a log line or an error message. */
export function diagnosticsSecrets(config: ConfigFile | null): string[] {
  if (!config) return []
  const out: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out.push(v)
  }
  add(at(config, 'settings.notifications.hookToken'))
  add(at(config, 'settings.notifications.discord.webhookUrl'))
  add(at(config, 'settings.notifications.ntfy.topic'))
  add(at(config, 'settings.notifications.ntfy.token'))
  for (const c of config.connections ?? []) for (const s of c.steps ?? []) add(s.send)
  return out
}

/** Endpoint IPs keep their first two octets only, private or not. */
function maskEndpointIp(ip: string): string {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip)
  return m ? `${m[1]}.${m[2]}.x.x` : ip.includes(':') ? 'ipv6' : 'other'
}

function iso(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '-'
}

function duration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

function clip(text: string | undefined, max: number): string {
  if (!text || max <= 0) return ''
  return text.length > max ? `${text.slice(0, max)}\n...` : text
}

function fence(text: string): string[] {
  return text ? ['```', text.replace(/```/g, "'''"), '```'] : []
}

interface Budget {
  logs: number
  stack: number
}

function render(i: DiagnosticsInput, b: Budget): string {
  const L: string[] = []
  const a = i.app
  L.push('## Diagnostics', '')
  L.push(`- Version: ${a.version} (${a.installKind})`)
  L.push(`- OS: ${a.platform} ${a.systemVersion || a.osRelease} (${a.osRelease}) ${a.arch}`)
  L.push(`- Electron ${a.electron}, Chrome ${a.chrome}, Node ${a.node}`)
  L.push(`- Uptime: ${duration(a.uptimeSec)}`)
  L.push(`- Config version: ${i.configVersion}`)
  L.push(`- Generated: ${new Date().toISOString()}`)

  L.push('', '### Features')
  const settings = i.config?.settings
  const feats: string[] = []
  for (const p of FEATURE_PATHS) {
    const v = at(settings, p)
    if (typeof v === 'boolean') feats.push(`${p}=${v ? 'on' : 'off'}`)
    else if (typeof v === 'string' && ENUM_RE.test(v)) feats.push(`${p}=${v}`)
  }
  L.push(feats.length ? feats.join(', ') : '-')

  L.push('', '### Counts')
  const cfg = i.config
  const panes = cfg ? cfg.workspaces.reduce((n, w) => n + (w.panes?.length ?? 0), 0) : 0
  const schedules = cfg ? cfg.workspaces.reduce((n, w) => n + (w.panes ?? []).filter((p) => p.schedule != null).length, 0) : 0
  const r = i.renderer
  L.push(
    `- workspaces ${r?.workspaces ?? cfg?.workspaces.length ?? 0}, panes ${r?.panes ?? panes}, connections ${r?.connections ?? cfg?.connections?.length ?? 0}, ` +
      `quick commands ${r?.snippets ?? cfg?.quickCommands?.length ?? 0}, presets ${cfg?.presets.length ?? 0}, key buttons ${cfg?.keyButtons?.length ?? 0}, schedules ${schedules}`,
  )
  if (r?.lang) L.push(`- UI language: ${ENUM_RE.test(r.lang) ? r.lang : '-'}`)

  L.push('', '### Metrics')
  const m = i.metrics
  L.push(m ? `- memory ${m.memMB} MB, cpu ${m.cpuPercent}%, processes ${m.processes}, consoles ${m.consoles}` : '-')

  L.push('', '### Status health')
  const h = i.health
  if (h) {
    L.push(`- desktop notifications: ${h.desktop.error ?? 'ok'}`)
    L.push(
      `- claude hooks: installed ${h.claude.installed}, complete ${h.claude.complete ?? '-'}, running ${h.claude.running ?? '-'}, last event ${iso(h.claude.lastEventAt)}` +
        (h.claude.error ? `, error ${clip(h.claude.error, 200)}` : ''),
    )
    L.push(`- codex: enabled ${h.codex.enabled}, available ${h.codex.available}, connected ${h.codex.connected}` + (h.codex.error ? `, error ${clip(h.codex.error, 200)}` : ''))
    L.push(`- discord: last success ${iso(h.discord.lastSuccessAt)}, queued ${h.discord.queued}` + (h.discord.error ? `, error ${clip(h.discord.error, 200)}` : ''))
  } else L.push('-')

  L.push('', '### Remote')
  const rs = i.remote
  if (rs) {
    // The secure mode's MagicDNS name names the tailnet: never copied (E3-FR-43).
    const eps = rs.endpoints.map((e) => `${e.kind} ${e.ip ? maskEndpointIp(e.ip) : 'ts.net'}`).join(', ') || '-'
    const secure = rs.secure ? `, secure ${rs.secure.state}${rs.secure.error ? ` (${rs.secure.error})` : ''}` : ''
    L.push(`- state ${rs.state}, port ${rs.port}, phones connected ${rs.connectedCount}, endpoints ${eps}${secure}` + (rs.error ? `, error ${clip(rs.error, 200)}` : ''))
  } else L.push('-')

  const errors = (r ? r.renderErrors : i.mainRenderErrors).slice(-10)
  L.push('', `### Render errors (${errors.length})`)
  if (!errors.length) L.push('-')
  for (const e of errors) {
    L.push(`- ${iso(e.at)} [${e.scope}]${e.paneId ? ` pane ${e.paneId}` : ''} ${clip(e.message, 500)}`)
    L.push(...fence(clip([e.stack, e.componentStack].filter(Boolean).join('\n'), b.stack)))
  }

  const crashes = i.crashes.slice(0, 5)
  L.push('', `### Crashes (last ${crashes.length})`)
  if (!crashes.length) L.push('-')
  for (const c of crashes) {
    const bits = [c.reason ? `reason ${c.reason}` : '', c.exitCode !== undefined ? `exit ${c.exitCode}` : '', c.scope ? `scope ${c.scope}` : '', `v${c.version}`].filter(Boolean)
    L.push(`- ${iso(c.at)} ${c.kind} (${bits.join(', ')})${c.message ? ` ${clip(c.message, 300)}` : ''}`)
    L.push(...fence(clip(c.stack, Math.min(b.stack, 1000))))
  }

  const logs = b.logs > 0 ? i.logLines.slice(-b.logs) : []
  L.push('', `### Main log (last ${logs.length} warn/error)`)
  L.push(...(logs.length ? fence(logs.map((l) => clip(l, 400)).join('\n')) : ['-']))
  return L.join('\n') + '\n'
}

const BUDGETS: Budget[] = [
  { logs: 100, stack: 1500 },
  { logs: 40, stack: 600 },
  { logs: 0, stack: 0 },
]

/** The redacted block, always under DIAGNOSTICS_MAX_BYTES. */
export function buildDiagnostics(i: DiagnosticsInput): string {
  const opts = { home: i.home, extraSecrets: diagnosticsSecrets(i.config) }
  let text = ''
  for (const b of BUDGETS) {
    text = redact(render(i, b), opts)
    if (Buffer.byteLength(text, 'utf8') <= DIAGNOSTICS_MAX_BYTES) return text
  }
  // Last resort: cut by bytes (the tail is the least important part).
  const buf = Buffer.from(text, 'utf8').subarray(0, DIAGNOSTICS_MAX_BYTES - 32)
  return `${buf.toString('utf8').replace(/�+$/, '')}\n...(truncated)\n`
}
