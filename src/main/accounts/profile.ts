import { getJson, type JsonResponse } from '../usage/httpJson'
import { claudeCliVersion } from '../usage/claudeVersion'
import { claudeOauthHeaders } from '../usage/claude'

/** Identity of an OAuth access token (SPIKE 2026-10-20: 200 with the token of each account). */
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

interface ProfileResponse {
  account?: { uuid?: unknown; email?: unknown; email_address?: unknown; has_claude_max?: unknown } | null
  organization?: { uuid?: unknown; name?: unknown; rate_limit_tier?: unknown } | null
}

export type ClaudeProfile =
  | {
      ok: true
      accountUuid: string
      email: string | null
      organizationUuid: string | null
      organizationName: string | null
      rateLimitTier: string | null
    }
  | { ok: false; status: number | 'network' }

export interface ProfileDeps {
  get?: (url: string, headers: Record<string, string>) => Promise<JsonResponse<ProfileResponse>>
  version?: () => Promise<string>
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)

/** GET the profile of a token. Never throws and never reports the token or the body. */
export async function fetchClaudeProfile(accessToken: string, deps: ProfileDeps = {}): Promise<ClaudeProfile> {
  const get = deps.get ?? ((url, headers) => getJson<ProfileResponse>(url, headers))
  let res: JsonResponse<ProfileResponse>
  try {
    const version = await (deps.version ?? claudeCliVersion)()
    res = await get(PROFILE_URL, claudeOauthHeaders(accessToken, version))
  } catch {
    return { ok: false, status: 'network' }
  }
  if (res.status !== 200 || !res.json) return { ok: false, status: res.status }
  const accountUuid = str(res.json.account?.uuid, 100)
  if (!accountUuid) return { ok: false, status: res.status }
  return {
    ok: true,
    accountUuid,
    email: str(res.json.account?.email) ?? str(res.json.account?.email_address),
    organizationUuid: str(res.json.organization?.uuid, 100),
    organizationName: str(res.json.organization?.name),
    rateLimitTier: str(res.json.organization?.rate_limit_tier, 100),
  }
}
