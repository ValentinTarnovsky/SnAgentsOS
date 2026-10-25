import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { StatusHooksStatusRes } from '@shared/types'
import { AGENT_ENV, BRAND, LEGACY_BRAND } from '@shared/brand'

/**
 * Installs/removes our block inside the user's Claude Code settings
 * (~/.claude/settings.json). Ownership marker: any hook handler whose url
 * contains URL_MARKER, or whose statusMessage is ours (new or 1.x), is ours;
 * nothing else is ever touched. Claude Code AGGREGATES hooks across scopes
 * (they never override each other) and watches the file, so edits apply to
 * running sessions without a restart.
 */
const URL_MARKER = '/cc-hook/'

/** Events observed. Notification is filtered by matcher to the relevant types. */
const HOOK_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
  { event: 'StopFailure' },
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
  { event: 'PermissionRequest' },
  { event: 'PreToolUse' },
  { event: 'PostToolUse' },
  { event: 'PostToolUseFailure' },
  { event: 'Elicitation' },
  { event: 'ElicitationResult' },
  { event: 'Notification', matcher: 'permission_prompt|idle_prompt|elicitation_dialog' },
]

interface HookHandler {
  type?: string
  url?: string
  [key: string]: unknown
}

interface MatcherGroup {
  matcher?: string
  hooks?: HookHandler[]
  [key: string]: unknown
}

function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

/**
 * Claude sets CLAUDE_CODE_CHILD_SESSION=1 in its Bash and PowerShell tools,
 * so a `claude -p` a console's agent starts (a driver) inherits it; a Codex
 * console's commands inherit SNAOS_AGENT_PARENT (CodexBridge). Either header
 * marks the hooks of such a sub-session, which never stand for the console's
 * own agent.
 */
const CHILD_ENV = 'CLAUDE_CODE_CHILD_SESSION'

function buildHandler(port: number, token: string): HookHandler {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}${URL_MARKER}${token}`,
    headers: { 'X-Console-Id': '$' + AGENT_ENV.consoleId, 'X-Pty-Id': '$' + AGENT_ENV.ptyId, 'X-Agent-Child': '$' + CHILD_ENV, 'X-Agent-Parent': '$' + AGENT_ENV.agentParent },
    allowedEnvVars: [AGENT_ENV.consoleId, AGENT_ENV.ptyId, CHILD_ENV, AGENT_ENV.agentParent],
    timeout: 3,
  }
}

/** The SessionStart handler has no url, so the statusMessage (new or 1.x) marks it. */
const STATUS_MESSAGES: readonly unknown[] = [BRAND.hookStatusMessage, LEGACY_BRAND.hookStatusMessage]

function isOurs(handler: HookHandler): boolean {
  return !!handler && ((typeof handler.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/cc-hook\//.test(handler.url)) || STATUS_MESSAGES.includes(handler.statusMessage))
}

/**
 * SessionStart does not support HTTP handlers in current Claude releases. A
 * hook command always runs with CLAUDE_CODE_CHILD_SESSION set, so only the
 * parent header travels here (StatusManager settles the rest).
 */
function startHandler(port: number, token: string): HookHandler {
  const url = `http://127.0.0.1:${port}${URL_MARKER}${token}`
  const id = AGENT_ENV.consoleId, pty = AGENT_ENV.ptyId, parent = AGENT_ENV.agentParent
  const command = process.platform === 'win32'
    ? 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(
      `[Console]::InputEncoding=[Text.Encoding]::UTF8; $body=[Console]::In.ReadToEnd(); if($env:${id} -and $env:${pty}){$h=@{'X-Console-Id'=$env:${id};'X-Pty-Id'=$env:${pty}}; if($env:${parent}){$h['X-Agent-Parent']=$env:${parent}}; try{Invoke-WebRequest -UseBasicParsing -Uri '${url}' -Method POST -TimeoutSec 2 -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json' | Out-Null}catch{}}`, 'utf16le').toString('base64')
    : `if [ -n "$${id}" ] && [ -n "$${pty}" ]; then curl --silent --max-time 2 --output /dev/null -H "X-Console-Id: $${id}" -H "X-Pty-Id: $${pty}" -H "X-Agent-Parent: $${parent}" -H 'Content-Type: application/json' --data-binary @- '${url}'; fi; exit 0`
  return { type: 'command', command, timeout: 3, statusMessage: BRAND.hookStatusMessage }
}

function complete(settings: Record<string, unknown>, port: number, token: string): boolean {
  const hooks = hooksOf(settings)
  return HOOK_EVENTS.every(({ event, matcher }) => {
    const groups = hooks[event]
    if (!Array.isArray(groups)) return false
    const expected = event === 'SessionStart' ? startHandler(port, token) : buildHandler(port, token)
    return groups.some(g => g && g.matcher === matcher && Array.isArray(g.hooks) && g.hooks.some((h: HookHandler) => JSON.stringify(h) === JSON.stringify(expected)))
  })
}

/** Reads and parses settings.json. Throws on unparseable JSON (never clobber). */
function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  if (!raw.trim()) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings.json is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** BOM-less UTF-8, 2-space indent, trailing newline; backs the old file up first. */
function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.${BRAND.packageName}.bak`)
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

function hooksOf(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks
  if (typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)) {
    return hooks as Record<string, unknown>
  }
  return {}
}

/** Scans every event's matcher groups for our handler; returns its full url. */
function findInstalledUrl(settings: Record<string, unknown>): string | null {
  for (const groups of Object.values(hooksOf(settings))) {
    if (!Array.isArray(groups)) continue
    for (const group of groups as MatcherGroup[]) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (isOurs(handler) && typeof handler.url === 'string') return handler.url
      }
    }
  }
  return null
}

export function hooksStatus(): StatusHooksStatusRes {
  const path = settingsPath()
  try {
    const settings = readSettings(path)
    const url = findInstalledUrl(settings)
    const m = url ? /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(url) : null
    const token = url?.split('/').pop() ?? ''
    return { installed: url !== null, settingsPath: path, port: m ? Number(m[1]) : null, complete: !!m && complete(settings, Number(m[1]), token) }
  } catch {
    return { installed: false, settingsPath: path, port: null, complete: false, error: 'Could not read Claude settings.json' }
  }
}

/**
 * True when the installed hook URL matches this exact port + token. Catches
 * both the stale-port trap (fallback bind on a busy port) and token drift
 * (e.g. a config imported from another machine), either of which would leave
 * every hook POST 404ing as a visible hook error inside Claude sessions.
 */
export function hooksUpToDate(port: number, token: string): boolean {
  try {
    return complete(readSettings(settingsPath()), port, token)
  } catch {
    return false
  }
}

/**
 * Merges our matcher group into each observed event, replacing any stale
 * handler of ours (old port/token or 1.x names) in place. User hooks are preserved
 * verbatim; the hooks object is extended, never replaced.
 */
export function installHooks(port: number, token: string): StatusHooksStatusRes {
  const path = settingsPath()
  const settings = readSettings(path)
  const hooks = hooksOf(settings)

  for (const { event, matcher } of HOOK_EVENTS) {
    const handler = event === 'SessionStart' ? startHandler(port, token) : buildHandler(port, token)
    const groups: MatcherGroup[] = Array.isArray(hooks[event])
      ? (hooks[event] as MatcherGroup[])
      : []
    // Drop our stale handlers wherever they live, then prune emptied groups.
    // Tolerate hand-edited files: null/non-object group entries are dropped.
    const cleaned = groups
      .filter((g): g is MatcherGroup => typeof g === 'object' && g !== null)
      .map((g) => ({ ...g, hooks: (Array.isArray(g.hooks) ? g.hooks : []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks?.length ?? 0) > 0)
    const group: MatcherGroup = matcher ? { matcher, hooks: [handler] } : { hooks: [handler] }
    hooks[event] = [...cleaned, group]
  }

  settings.hooks = hooks
  writeSettings(path, settings)
  return { installed: true, settingsPath: path, port, complete: true }
}

/** Removes every handler of ours (1.x ones too); leaves user hooks and unknown keys intact. */
export function uninstallHooks(): StatusHooksStatusRes {
  const path = settingsPath()
  let settings: Record<string, unknown>
  try {
    settings = readSettings(path)
  } catch { throw new Error('Could not read Claude settings.json; no hooks were removed') }
  const hooks = hooksOf(settings)
  let changed = false

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const cleaned = (groups as MatcherGroup[])
      .filter((g): g is MatcherGroup => typeof g === 'object' && g !== null)
      .map((g) => {
        const kept = (Array.isArray(g.hooks) ? g.hooks : []).filter((h) => !isOurs(h))
        if (kept.length !== (g.hooks?.length ?? 0)) changed = true
        return { ...g, hooks: kept }
      })
      .filter((g) => (g.hooks?.length ?? 0) > 0)
    if (cleaned.length === 0) delete hooks[event]
    else hooks[event] = cleaned
  }

  if (changed) {
    settings.hooks = hooks
    writeSettings(path, settings)
  }
  return { installed: false, settingsPath: path, port: null }
}

export type HooksMigrationResult = 'rewritten' | 'notNeeded' | 'pending'

/** Marks of the 1.x handlers: its env prefix (without the underscore) and its statusMessage. */
const LEGACY_MARKS = [LEGACY_BRAND.envPrefix.replace(/_$/, ''), LEGACY_BRAND.hookStatusMessage]

function isLegacy(handler: HookHandler): boolean {
  if (!isOurs(handler)) return false
  const text = JSON.stringify(handler)
  return LEGACY_MARKS.some(mark => text.includes(mark))
}

function hasLegacyHandler(settings: Record<string, unknown>): boolean {
  for (const groups of Object.values(hooksOf(settings))) {
    if (!Array.isArray(groups)) continue
    for (const group of groups as MatcherGroup[]) {
      if ((Array.isArray(group?.hooks) ? group.hooks : []).some(isLegacy)) return true
    }
  }
  return false
}

/**
 * Rewrites the 1.x handlers to the current names (E0-FR-14, item L11), whether
 * or not hooks are enabled: the reconcile only runs with hooksEnabled, so
 * without this they would stay forever. Keeps the installed port and token;
 * with no installed url (only the 1.x SessionStart left) they are removed.
 * Writes nothing when there is nothing legacy or when settings.json does not
 * parse. The caller (the legacy cleanup) runs it only with 1.x closed.
 */
export function migrateLegacyHooks(): HooksMigrationResult {
  const path = settingsPath()
  try {
    const settings = readSettings(path)
    const found = hasLegacyHandler(settings)
    if (found) {
      const url = findInstalledUrl(settings)
      const m = url ? /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(url) : null
      if (url && m) installHooks(Number(m[1]), url.split('/').pop() ?? '')
      else uninstallHooks()
    }
    // Verify on disk: done only with no 1.x mark left anywhere in the file.
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (LEGACY_MARKS.some(mark => raw.includes(mark))) return 'pending'
    return found ? 'rewritten' : 'notNeeded'
  } catch {
    return 'pending'
  }
}
