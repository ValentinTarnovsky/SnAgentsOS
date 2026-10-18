/**
 * Throttle for render-error reports (E4-FR-23), applied in the renderer
 * before sending and again in main before writing a crash record: one report
 * per `scope+message` key every 60 s and at most 10 per rolling minute in
 * total. A render loop throwing the same error 100 times in 10 s yields one.
 */
export const RENDER_ERROR_KEY_MS = 60_000
export const RENDER_ERROR_MAX_PER_MIN = 10

export function renderErrorKey(scope: string, message: string): string {
  return `${scope}\u0000${message.slice(0, 500)}`
}

export class RenderErrorThrottle {
  private readonly lastByKey = new Map<string, number>()
  private recent: number[] = []

  constructor(
    private readonly keyMs = RENDER_ERROR_KEY_MS,
    private readonly maxPerWindow = RENDER_ERROR_MAX_PER_MIN,
    private readonly windowMs = 60_000,
  ) {}

  /** True when a report with this key may go through now (and counts it). */
  allow(key: string, now: number): boolean {
    this.recent = this.recent.filter((t) => now - t < this.windowMs)
    const last = this.lastByKey.get(key)
    if (last !== undefined && now - last < this.keyMs) return false
    if (this.recent.length >= this.maxPerWindow) return false
    this.lastByKey.set(key, now)
    this.recent.push(now)
    if (this.lastByKey.size > 200) {
      for (const [k, t] of this.lastByKey) if (now - t >= this.keyMs) this.lastByKey.delete(k)
    }
    return true
  }
}
