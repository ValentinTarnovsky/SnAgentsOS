import { getJson } from './httpJson'

export type ServiceStatus = 'operational' | 'degraded' | 'down'

interface StatusResponse {
  status?: { indicator?: string }
}

/** Map the public Anthropic status page indicator to our coarse health value. */
export async function fetchServiceStatus(): Promise<ServiceStatus | null> {
  try {
    const { status, json } = await getJson<StatusResponse>(
      'https://status.anthropic.com/api/v2/status.json',
      { Accept: 'application/json' },
    )
    if (status >= 400 || !json?.status) return null
    switch (json.status.indicator) {
      case 'none':
        return 'operational'
      case 'minor':
        return 'degraded'
      case 'major':
      case 'critical':
        return 'down'
      default:
        return null
    }
  } catch {
    return null
  }
}
