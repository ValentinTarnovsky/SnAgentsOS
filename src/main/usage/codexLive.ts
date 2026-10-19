import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { codexHome } from '../agents/codexPaths'
import { getJson, type JsonResponse } from './httpJson'
import { buildWindow, dedupeByKind, type CodexSnapshot } from './codexWindows'

/**
 * Live Codex quota, the same endpoint the Codex CLI itself reads. The bearer
 * token and account id come from `<CODEX_HOME>/auth.json` on every call (so a
 * token Codex refreshes is picked up); they are never logged and never leave
 * this process. We do not refresh the token ourselves: that would rotate the
 * refresh token under the CLI. A 401/403 just means "use the local fallback".
 */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const USER_AGENT = 'codex_cli_rs/0.0.0'
/** After a 401/403, the same token is not retried for this long. */
const REJECTED_RETRY_MS = 15 * 60_000

interface LiveWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  reset_at?: number
}
interface LiveResponse {
  plan_type?: string | null
  rate_limit?: {
    primary_window?: LiveWindow | null
    secondary_window?: LiveWindow | null
  } | null
}

export type CodexLiveResult =
  | { ok: true; snapshot: CodexSnapshot }
  | { ok: false; reason: 'noauth' | 'unauthorized' | 'unavailable' }

export interface CodexLiveDeps {
  get?: (url: string, headers: Record<string, string>) => Promise<JsonResponse<unknown>>
  now?: () => number
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse a `wham/usage` body. Returns null when it is not the expected shape
 * (no `rate_limit` object). Windows are classified by `limit_window_seconds`;
 * a weekly-only plan therefore yields a single 7d window even though the
 * server reports it as `primary_window`.
 */
export function parseCodexLive(json: unknown, nowMs: number): CodexSnapshot | null {
  if (!isObject(json)) return null
  const body = json as LiveResponse
  const rl = body.rate_limit
  if (!isObject(rl)) return null
  const mk = (w: LiveWindow | null | undefined) => {
    if (!isObject(w)) return null
    const resetsAtSec =
      typeof w.reset_at === 'number'
        ? w.reset_at
        : typeof w.reset_after_seconds === 'number'
          ? Math.floor(nowMs / 1000) + w.reset_after_seconds
          : undefined
    return buildWindow(
      { usedPercent: w.used_percent, windowSeconds: w.limit_window_seconds, resetsAtSec },
      nowMs,
    )
  }
  return {
    planType: typeof body.plan_type === 'string' ? body.plan_type : null,
    windows: dedupeByKind([mk(rl.primary_window), mk(rl.secondary_window)]),
    at: nowMs,
  }
}

interface CodexAuth {
  accessToken: string
  accountId: string
}

async function readAuth(): Promise<CodexAuth | null> {
  try {
    const raw = await readFile(join(codexHome(), 'auth.json'), 'utf8')
    const tokens = (JSON.parse(raw) as { tokens?: { access_token?: unknown; account_id?: unknown } }).tokens
    const accessToken = tokens?.access_token
    const accountId = tokens?.account_id
    if (typeof accessToken !== 'string' || !accessToken || typeof accountId !== 'string' || !accountId) return null
    return { accessToken, accountId }
  } catch {
    return null
  }
}

/** Short digest so a rejected token can be remembered without keeping the token itself. */
function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

let rejected: { fp: string; at: number } | null = null

/** Test seam: forget a remembered 401. */
export function resetCodexLiveState(): void {
  rejected = null
}

export async function fetchCodexLive(deps: CodexLiveDeps = {}): Promise<CodexLiveResult> {
  const get = deps.get ?? ((url, headers) => getJson<unknown>(url, headers))
  const now = deps.now ?? Date.now
  const auth = await readAuth()
  if (!auth) return { ok: false, reason: 'noauth' }
  const fp = fingerprint(auth.accessToken)
  if (rejected && rejected.fp === fp && now() - rejected.at < REJECTED_RETRY_MS) {
    return { ok: false, reason: 'unauthorized' }
  }
  try {
    const res = await get(USAGE_URL, {
      Authorization: `Bearer ${auth.accessToken}`,
      'ChatGPT-Account-Id': auth.accountId,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    })
    if (res.status === 401 || res.status === 403) {
      rejected = { fp, at: now() }
      return { ok: false, reason: 'unauthorized' }
    }
    if (res.status >= 400 || !res.json) return { ok: false, reason: 'unavailable' }
    const snapshot = parseCodexLive(res.json, now())
    if (!snapshot) return { ok: false, reason: 'unavailable' }
    rejected = null
    return { ok: true, snapshot }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
