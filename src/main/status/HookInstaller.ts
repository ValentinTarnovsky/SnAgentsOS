import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { StatusHooksStatusRes } from '@shared/types'

/**
 * Installs/removes the SnMultiCC block inside the user's Claude Code settings
 * (~/.claude/settings.json). Ownership marker: any hook handler whose url
 * contains URL_MARKER is ours; nothing else is ever touched. Claude Code
 * AGGREGATES hooks across scopes (they never override each other) and watches
 * the file, so edits apply to running sessions without a restart.
 */
const URL_MARKER = '/cc-hook/'

/** Events observed. Notification is filtered by matcher to the relevant types. */
const HOOK_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
  { event: 'StopFailure' },
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
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
  return join(homedir(), '.claude', 'settings.json')
}

function buildHandler(port: number, token: string): HookHandler {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}${URL_MARKER}${token}`,
    headers: { 'X-Console-Id': '$SNMULTICC_CONSOLE_ID' },
    allowedEnvVars: ['SNMULTICC_CONSOLE_ID'],
    timeout: 3,
  }
}

function isOurs(handler: HookHandler): boolean {
  return typeof handler.url === 'string' && handler.url.includes(URL_MARKER)
}

/** Reads and parses settings.json. Throws on unparseable JSON (never clobber). */
function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '')
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
  if (existsSync(path)) copyFileSync(path, `${path}.snmulticc.bak`)
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

function hooksOf(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks
  if (typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)) {
    return hooks as Record<string, unknown>
  }
  return {}
}

/** Scans every event's matcher groups for our handler; returns its port. */
function findInstalledPort(settings: Record<string, unknown>): number | null {
  for (const groups of Object.values(hooksOf(settings))) {
    if (!Array.isArray(groups)) continue
    for (const group of groups as MatcherGroup[]) {
      for (const handler of group?.hooks ?? []) {
        if (!isOurs(handler)) continue
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(handler.url))
        return m ? Number(m[1]) : null
      }
    }
  }
  return null
}

export function hooksStatus(): StatusHooksStatusRes {
  const path = settingsPath()
  try {
    const port = findInstalledPort(readSettings(path))
    return { installed: port !== null, settingsPath: path, port }
  } catch {
    return { installed: false, settingsPath: path, port: null }
  }
}

/**
 * Merges our matcher group into each observed event, replacing any stale
 * SnMultiCC handler (old port/token) in place. User hooks are preserved
 * verbatim; the hooks object is extended, never replaced.
 */
export function installHooks(port: number, token: string): StatusHooksStatusRes {
  const path = settingsPath()
  const settings = readSettings(path)
  const hooks = hooksOf(settings)
  const handler = buildHandler(port, token)

  for (const { event, matcher } of HOOK_EVENTS) {
    const groups: MatcherGroup[] = Array.isArray(hooks[event])
      ? (hooks[event] as MatcherGroup[])
      : []
    // Drop our stale handlers wherever they live, then prune emptied groups.
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks?.length ?? 0) > 0)
    const group: MatcherGroup = matcher ? { matcher, hooks: [handler] } : { hooks: [handler] }
    hooks[event] = [...cleaned, group]
  }

  settings.hooks = hooks
  writeSettings(path, settings)
  return { installed: true, settingsPath: path, port }
}

/** Removes every SnMultiCC handler; leaves user hooks and unknown keys intact. */
export function uninstallHooks(): StatusHooksStatusRes {
  const path = settingsPath()
  let settings: Record<string, unknown>
  try {
    settings = readSettings(path)
  } catch {
    return { installed: false, settingsPath: path, port: null }
  }
  const hooks = hooksOf(settings)
  let changed = false

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const cleaned = (groups as MatcherGroup[])
      .map((g) => {
        const kept = (g.hooks ?? []).filter((h) => !isOurs(h))
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
