import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { app } from 'electron'
import { getJson } from './httpJson'
import type { UsageRow } from '@shared/ipc-contract'

/** Confirmed OAuth usage endpoint used by Claude Code (utilization 0..100 + reset). */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

interface OauthCred {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number }
}
interface UsageWindow {
  utilization?: number | null
  resets_at?: string | null
}
interface UsageResponse {
  five_hour?: UsageWindow | null
  seven_day?: UsageWindow | null
  seven_day_opus?: UsageWindow | null
  seven_day_sonnet?: UsageWindow | null
}

export interface ClaudeRowFlags {
  claude5h: boolean
  claude7d: boolean
  claudeOpus7d: boolean
  claudeSonnet7d: boolean
}

interface WantedWindow {
  id: string
  kind: '5h' | '7d'
  label: string
  key: keyof UsageResponse
}

function readCred(): OauthCred | null {
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    return JSON.parse(raw) as OauthCred
  } catch {
    return null
  }
}

function clampPercent(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x)))
}

/**
 * Fetch the enabled Claude quota windows. The OAuth token is read fresh from
 * disk on every call (so a token Claude Code refreshes is picked up), and is
 * never returned to the renderer. On an expired/401 token the rows report
 * `expired` instead of hammering the endpoint.
 */
export async function fetchClaudeRows(flags: ClaudeRowFlags): Promise<UsageRow[]> {
  const wanted: WantedWindow[] = []
  if (flags.claude5h) wanted.push({ id: 'claude.5h', kind: '5h', label: 'Session', key: 'five_hour' })
  if (flags.claude7d) wanted.push({ id: 'claude.7d', kind: '7d', label: 'Weekly', key: 'seven_day' })
  if (flags.claudeOpus7d)
    wanted.push({ id: 'claude.opus7d', kind: '7d', label: 'Weekly Opus', key: 'seven_day_opus' })
  if (flags.claudeSonnet7d)
    wanted.push({ id: 'claude.sonnet7d', kind: '7d', label: 'Weekly Sonnet', key: 'seven_day_sonnet' })
  if (wanted.length === 0) return []

  const all = (status: UsageRow['status']): UsageRow[] =>
    wanted.map(
      (w): UsageRow => ({
        id: w.id,
        provider: 'claude',
        kind: w.kind,
        label: w.label,
        percent: null,
        resetsAt: null,
        status,
      }),
    )

  const cred = readCred()
  const token = cred?.claudeAiOauth?.accessToken
  const expiresAt = cred?.claudeAiOauth?.expiresAt
  if (!token) return all('nodata')
  if (typeof expiresAt === 'number' && expiresAt <= Date.now()) return all('expired')

  try {
    const { status, json } = await getJson<UsageResponse>(USAGE_URL, {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-code/${app.getVersion()}`,
      Accept: 'application/json',
    })
    if (status === 401 || status === 403) return all('expired')
    if (status >= 400 || !json) return all('error')

    return wanted.map((w): UsageRow => {
      const win = json[w.key]
      if (!win || typeof win.utilization !== 'number') {
        return {
          id: w.id,
          provider: 'claude',
          kind: w.kind,
          label: w.label,
          percent: null,
          resetsAt: null,
          status: 'nodata',
        }
      }
      return {
        id: w.id,
        provider: 'claude',
        kind: w.kind,
        label: w.label,
        percent: clampPercent(win.utilization),
        resetsAt: win.resets_at ?? null,
        status: 'ok',
      }
    })
  } catch {
    return all('error')
  }
}
