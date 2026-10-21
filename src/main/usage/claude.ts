import { readFile } from 'fs/promises'
import { join } from 'path'
import { getJson, type JsonResponse } from './httpJson'
import { claudeCliVersion } from './claudeVersion'
import { claudeConfigDir } from '../status/statusDetails'
import type { UsageRow } from '@shared/ipc-contract'

/** Confirmed OAuth usage endpoint used by Claude Code (utilization 0..100 + reset). */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** The part of `.credentials.json` main reads (the token never leaves main). */
export interface OauthCred {
  claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string }
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

export interface ClaudeFetchResult {
  rows: UsageRow[]
  /** The endpoint answered 429: the poller must back off instead of asking again. */
  rateLimited?: boolean
  /** Server-provided wait (`Retry-After`) before the next request, in ms. */
  retryAfterMs?: number
}

export interface ClaudeFetchDeps {
  get?: (url: string, headers: Record<string, string>) => Promise<JsonResponse<UsageResponse>>
  version?: () => Promise<string>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Where the credentials come from (default: the live file, re-read on every call); the parked account passes its own. */
  readCred?: () => Promise<OauthCred | null>
}

interface WantedWindow {
  id: string
  kind: '5h' | '7d'
  label: string
  key: keyof UsageResponse
}

/** Credentials of the configured Claude home (CLAUDE_CONFIG_DIR or ~/.claude), read fresh on every call. */
async function readCred(): Promise<OauthCred | null> {
  try {
    return JSON.parse(await readFile(join(claudeConfigDir(), '.credentials.json'), 'utf8')) as OauthCred
  } catch {
    return null
  }
}

/** Headers Claude Code sends to the OAuth endpoints (usage, profile). */
export function claudeOauthHeaders(token: string, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': `claude-code/${version}`,
    Accept: 'application/json',
  }
}

function clampPercent(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x)))
}

/** 5xx and thrown network errors are worth a short retry. 429 is not: the poller backs off instead. */
function isTransientStatus(status: number): boolean {
  return status >= 500
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * GET the usage endpoint with a bounded retry on transient failures only (a
 * thrown network/timeout error or 5xx). A single blip used to flip the sidebar
 * usage to "Error" for one poll; retrying here keeps the bars steady. 401/403
 * (expired) and 429 (rate limited, `Retry-After` honored by the poller) return
 * immediately, as do 2xx. Throws only if every attempt threw. Worst-case added
 * latency ~1.2s, well under the 30s+ poll interval.
 */
async function getUsageWithRetry(
  get: NonNullable<ClaudeFetchDeps['get']>,
  sleep: (ms: number) => Promise<void>,
  headers: Record<string, string>,
  attempts = 3,
): Promise<JsonResponse<UsageResponse>> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await get(USAGE_URL, headers)
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

function isExpired(cred: OauthCred | null, nowMs: number): boolean {
  const at = cred?.claudeAiOauth?.expiresAt
  return typeof at === 'number' && at <= nowMs
}

/**
 * Fetch the enabled Claude quota windows. The OAuth token is read fresh from
 * disk on every call (so a token Claude Code refreshes is picked up), and is
 * never returned to the renderer. Before reporting `expired` the credentials
 * file is re-read once, because Claude Code may have refreshed the token while
 * we were deciding (or while the request was in flight).
 */
export async function fetchClaudeUsage(
  flags: ClaudeRowFlags,
  deps: ClaudeFetchDeps = {},
): Promise<ClaudeFetchResult> {
  const wanted: WantedWindow[] = []
  if (flags.claude5h) wanted.push({ id: 'claude.5h', kind: '5h', label: 'Session', key: 'five_hour' })
  if (flags.claude7d) wanted.push({ id: 'claude.7d', kind: '7d', label: 'Weekly', key: 'seven_day' })
  if (flags.claudeOpus7d)
    wanted.push({ id: 'claude.opus7d', kind: '7d', label: 'Weekly Opus', key: 'seven_day_opus' })
  if (flags.claudeSonnet7d)
    wanted.push({ id: 'claude.sonnet7d', kind: '7d', label: 'Weekly Sonnet', key: 'seven_day_sonnet' })
  if (wanted.length === 0) return { rows: [] }

  const get = deps.get ?? ((url, headers) => getJson<UsageResponse>(url, headers))
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const read = deps.readCred ?? readCred

  let cred = await read()
  // The plan label lives in the local credentials file, not the usage response,
  // so every row (incl. error/expired) can carry it: the MAX badge stays put.
  let planType = cred?.claudeAiOauth?.subscriptionType ?? null

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

  let token = cred?.claudeAiOauth?.accessToken
  if (!token) return { rows: all('nodata') }
  if (isExpired(cred, now())) {
    cred = await read()
    token = cred?.claudeAiOauth?.accessToken
    planType = cred?.claudeAiOauth?.subscriptionType ?? planType
    if (!token || isExpired(cred, now())) return { rows: all('expired') }
  }

  try {
    const version = await (deps.version ?? claudeCliVersion)()
    const headersFor = (t: string): Record<string, string> => claudeOauthHeaders(t, version)
    let res = await getUsageWithRetry(get, sleep, headersFor(token))
    if (res.status === 401 || res.status === 403) {
      // Claude Code may have rotated the token while the request was in flight.
      const again = await read()
      const next = again?.claudeAiOauth?.accessToken
      if (next && next !== token && !isExpired(again, now())) {
        token = next
        planType = again?.claudeAiOauth?.subscriptionType ?? planType
        res = await getUsageWithRetry(get, sleep, headersFor(token))
      }
    }
    if (res.status === 401 || res.status === 403) return { rows: all('expired') }
    if (res.status === 429) {
      return { rows: all('error'), rateLimited: true, retryAfterMs: res.retryAfterMs }
    }
    const json = res.json
    if (res.status >= 400 || !json) return { rows: all('error'), retryAfterMs: res.retryAfterMs }

    return {
      rows: wanted.map((w): UsageRow => {
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
      }),
    }
  } catch {
    return { rows: all('error') }
  }
}
