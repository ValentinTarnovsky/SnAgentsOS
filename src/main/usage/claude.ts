import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { app } from 'electron'
import { getJson, type JsonResponse } from './httpJson'
import type { UsageRow } from '@shared/ipc-contract'

/** Confirmed OAuth usage endpoint used by Claude Code (utilization 0..100 + reset). */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

interface OauthCred {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string }
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

/** Transient = worth retrying. 401/403 (expired token) are not. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * GET the usage endpoint with a bounded retry on transient failures only (a
 * thrown network/timeout error, 429, or 5xx). A single blip used to flip the
 * sidebar usage to "Error" for one poll; retrying here keeps the bars steady.
 * 401/403 (expired) and 2xx return immediately. Throws only if every attempt
 * threw. Worst-case added latency ~1.2s, well under the 30s+ poll interval.
 */
async function getUsageWithRetry(
  headers: Record<string, string>,
  attempts = 3,
): Promise<JsonResponse<UsageResponse>> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await getJson<UsageResponse>(USAGE_URL, headers)
      if (i < attempts - 1 && isTransientStatus(res.status)) {
        await sleep(400 * (i + 1))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        await sleep(400 * (i + 1))
        continue
      }
    }
  }
  throw lastErr ?? new Error('usage request failed')
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

  const cred = readCred()
  const token = cred?.claudeAiOauth?.accessToken
  const expiresAt = cred?.claudeAiOauth?.expiresAt
  // The plan label lives in the local credentials file, not the usage response,
  // so every row (incl. error/expired) can carry it: the MAX badge stays put.
  const planType = cred?.claudeAiOauth?.subscriptionType ?? null

  const all = (status: UsageRow['status']): UsageRow[] =>
    wanted.map(
      (w): UsageRow => ({
        id: w.id,
        provider: 'claude',
        kind: w.kind,
        label: w.label,
        percent: null,
        resetsAt: null,
        planType,
        status,
      }),
    )

  if (!token) return all('nodata')
  if (typeof expiresAt === 'number' && expiresAt <= Date.now()) return all('expired')

  try {
    const { status, json } = await getUsageWithRetry({
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
          planType,
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
        planType,
        status: 'ok',
      }
    })
  } catch {
    return all('error')
  }
}
