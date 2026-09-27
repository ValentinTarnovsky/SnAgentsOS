import type { ConfigFile, DiscordSettings, StatusHealth } from '@shared/types'
import type { StatusNotice } from './events'

export function discordUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname) || url.port || url.username || url.password || !/^\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error('Invalid Discord webhook URL')
  url.search = '?wait=true'
  url.hash = ''
  return url.toString()
}
export function discordPayload(cfg: DiscordSettings, text: string) {
  const id = cfg.userId.trim()
  if (id && !/^\d{17,20}$/.test(id)) throw new Error('Invalid Discord user ID')
  return { content: `${id ? `<@${id}>\n` : ''}${text}`.slice(0, 2000), allowed_mentions: { parse: [], users: id ? [id] : [] } }
}
type Job = { cfg: DiscordSettings; text: string; epoch: number; resolve: () => void; reject: (error: Error) => void }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** Bounded asynchronous delivery. Failure never blocks a terminal or hook response. */
export class DiscordNotifier {
  private cfg: DiscordSettings | null = null
  private queue: Job[] = []
  private draining = false
  private epoch = 0
  private abort: AbortController | null = null
  private lastSuccessAt: number | null = null
  private error: string | null = null
  constructor(private fetcher: Fetcher = fetch, private delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}
  get health(): StatusHealth['discord'] { return { lastSuccessAt: this.lastSuccessAt, error: this.error, queued: this.queue.length + Number(this.draining) } }
  setConfig(cfg: DiscordSettings): void {
    if (this.cfg && JSON.stringify(this.cfg) !== JSON.stringify(cfg)) this.cancel()
    this.cfg = { ...cfg }
  }
  notify(notice: StatusNotice, config: ConfigFile | null): void {
    const cfg = this.cfg
    if (!cfg?.enabled || !(notice.state === 'done' ? cfg.notifyDone : cfg.notifyAction)) return
    const es = config?.settings.language === 'es'
    let place = 'SnMultiCC'
    for (const ws of config?.workspaces ?? []) {
      const pane = ws.panes.find(p => p.id === notice.paneId)
      if (pane) { place = `${ws.name} / ${pane.title}`; break }
    }
    const reasons = es
      ? { permission: 'Permiso pendiente', question: 'Pregunta pendiente', plan: 'Plan para aprobar', elicitation: 'Respuesta MCP pendiente', failure: 'El agente se detuvo por un error' }
      : { permission: 'Permission requested', question: 'Question pending', plan: 'Plan approval requested', elicitation: 'MCP response requested', failure: 'Agent stopped with an error' }
    const message = notice.state === 'done' ? (es ? 'Turno terminado' : 'Turn complete') : reasons[notice.reason ?? (notice.state === 'error' ? 'failure' : 'question')]
    const text = `${notice.provider === 'codex' ? 'Codex' : 'Claude'}: ${message}\n${place}\n${new Date().toISOString()}`
    void this.enqueue(cfg, text).catch(() => {})
  }
  async test(cfg: DiscordSettings): Promise<{ ok: boolean; error?: string }> {
    try { await this.enqueue(cfg, 'SnMultiCC: notification test / prueba de notificacion'); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Delivery failed' } }
  }
  dispose(): void { this.cancel() }
  private cancel(): void {
    this.epoch++
    this.abort?.abort()
    for (const job of this.queue.splice(0)) job.reject(new Error('Delivery cancelled: configuration changed'))
  }
  private enqueue(cfg: DiscordSettings, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try { discordUrl(cfg.webhookUrl); discordPayload(cfg, text) }
      catch { this.error = 'Invalid Discord webhook URL or user ID'; reject(new Error(this.error)); return }
      if (this.queue.length >= 100) { this.error = 'Discord queue full'; reject(new Error(this.error)); return }
      this.queue.push({ cfg: { ...cfg }, text, epoch: this.epoch, resolve, reject })
      void this.drain()
    })
  }
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!
        try {
          await this.deliver(job)
          this.lastSuccessAt = Date.now(); this.error = null; job.resolve()
        } catch (error) {
          this.error = error instanceof Error ? error.message : 'Discord delivery failed'
          job.reject(new Error(this.error))
        }
      }
    } finally { this.draining = false }
  }
  private async deliver(job: Job): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (job.epoch !== this.epoch) throw new Error('Delivery cancelled: configuration changed')
      this.abort = new AbortController()
      const timer = setTimeout(() => this.abort?.abort(), 8000)
      let response: Response
      try {
        response = await this.fetcher(discordUrl(job.cfg.webhookUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(discordPayload(job.cfg, job.text)), redirect: 'error', signal: this.abort.signal })
      } catch {
        // A transport timeout may have delivered the message already. Do not duplicate it.
        throw new Error('Discord delivery unconfirmed: network error or timeout')
      } finally { clearTimeout(timer); this.abort = null }
      if (response.ok) { await response.body?.cancel(); return }
      if (response.status === 429 && attempt < 2) {
        const body = await response.json().catch(() => ({})) as { retry_after?: number }
        const seconds = Number(body.retry_after ?? response.headers.get('retry-after') ?? 1)
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('Discord rate limit: retry later')
        await this.delay(Math.max(100, seconds * 1000))
      } else if (response.status >= 500 && attempt < 2) {
        await response.body?.cancel()
        await this.delay(1000 * (attempt + 1))
      } else {
        await response.body?.cancel()
        throw new Error(`Discord HTTP ${response.status}`)
      }
    }
  }
}
