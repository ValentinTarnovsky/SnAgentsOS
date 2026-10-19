import { BRAND } from '@shared/brand'
import type { ConfigFile, NtfySettings, StatusHealth } from '@shared/types'
import { isPrivateOrTailnet } from '../remote/network'
import { describeNotice, describePlace, type CustomNotice, type StatusNotice } from './events'
import { mainT } from '../i18n'

/**
 * The ntfy server base URL a publish goes to (E2-FR-40): https, or http only
 * for a private or tailnet IP literal (a self-hosted server on the LAN), never
 * with userinfo. Query and fragment are dropped and the path ends in '/', so
 * the JSON publish lands on the server root (or the sub-path it is served at).
 */
export function ntfyServer(value: string): string {
  const url = new URL(value.trim())
  if (url.username || url.password) throw new Error('Invalid ntfy server URL')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateOrTailnet(url.hostname))) throw new Error('Invalid ntfy server URL')
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

export const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Printable ASCII only: a token can never smuggle a header line. */
const NTFY_TOKEN_RE = /^[\x21-\x7e]{1,128}$/

export interface NtfyMessage {
  title: string
  message: string
  /** True for action/error (priority 4, warning tag), false for done. */
  urgent: boolean
  /** Deep link the tap opens (E2-FR-42); omitted when the server is off. */
  click?: string
}

/** The JSON body ntfy expects for a publish to the server root. */
export function ntfyPayload(cfg: NtfySettings, msg: NtfyMessage) {
  const topic = cfg.topic.trim()
  if (!NTFY_TOPIC_RE.test(topic)) throw new Error('Invalid ntfy topic')
  return {
    topic,
    title: msg.title.slice(0, 200),
    message: msg.message.slice(0, 1000),
    priority: msg.urgent ? 4 : 3,
    tags: [msg.urgent ? 'warning' : 'white_check_mark'],
    ...(msg.click ? { click: msg.click } : {}),
  }
}

export function ntfyHeaders(cfg: NtfySettings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = cfg.token.trim()
  if (token) {
    if (!NTFY_TOKEN_RE.test(token)) throw new Error('Invalid ntfy token')
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/** "Claude: Permission requested" + "Front / Builder": reason, workspace and console only. */
export function ntfyNoticeMessage(notice: StatusNotice, config: ConfigFile | null, click?: string): NtfyMessage {
  const { agent, message, place } = describeNotice(notice, config, BRAND.productName)
  return { title: `${agent}: ${message}`, message: place, urgent: notice.state !== 'done', ...(click ? { click } : {}) }
}

type Job = { cfg: NtfySettings; msg: NtfyMessage; epoch: number; resolve: () => void; reject: (error: Error) => void }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/**
 * ntfy push channel next to Discord (E2-FR-40): the same bounded queue (100
 * jobs, 8s timeout, retries on 429 and 5xx, an epoch that cancels pending
 * jobs when the config changes). Failure never blocks a terminal or a hook.
 */
export class NtfyNotifier {
  private cfg: NtfySettings | null = null
  private queue: Job[] = []
  private draining = false
  private epoch = 0
  private abort: AbortController | null = null
  private lastSuccessAt: number | null = null
  private error: string | null = null
  constructor(
    private fetcher: Fetcher = fetch,
    private delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    /** The saved config, for the language of the test push (main/i18n.ts). */
    private getConfig: () => ConfigFile | null = () => null,
  ) {}
  get health(): NonNullable<StatusHealth['ntfy']> { return { lastSuccessAt: this.lastSuccessAt, error: this.error, queued: this.queue.length + Number(this.draining) } }
  /** The config the channel delivers with (the saved one, pushed by the renderer). */
  get config(): NtfySettings | null { return this.cfg ? { ...this.cfg } : null }
  setConfig(cfg: NtfySettings): void {
    if (this.cfg && JSON.stringify(this.cfg) !== JSON.stringify(cfg)) this.cancel()
    this.cfg = { ...cfg }
  }
  /** True when this notice would be published (enabled, topic set, its kind wanted). */
  wants(notice: StatusNotice): boolean {
    const cfg = this.cfg
    return !!cfg?.enabled && NTFY_TOPIC_RE.test(cfg.topic.trim()) && (notice.state === 'done' ? cfg.notifyDone : cfg.notifyAction)
  }
  notify(notice: StatusNotice, config: ConfigFile | null, click?: string): void {
    const cfg = this.cfg
    if (!cfg || !this.wants(notice)) return
    void this.enqueue(cfg, ntfyNoticeMessage(notice, config, click)).catch(() => {})
  }
  /** True when a `snaos notify` would be published (enabled and a valid topic). */
  wantsCustom(): boolean {
    const cfg = this.cfg
    return !!cfg?.enabled && NTFY_TOPIC_RE.test(cfg.topic.trim())
  }
  /** `snaos notify` (kind custom, E8-FR-19): the caller's title, its text and the console. */
  notifyCustom(notice: CustomNotice, config: ConfigFile | null, click?: string): void {
    const cfg = this.cfg
    if (!cfg || !this.wantsCustom()) return
    const { place } = describePlace(notice.paneId, config, BRAND.productName)
    const message = notice.paneId ? `${notice.body}\n${place}` : notice.body
    void this.enqueue(cfg, { title: notice.title, message, urgent: false, ...(click ? { click } : {}) }).catch(() => {})
  }
  /** [Send test] on the saved config: 'Accepted' or the HTTP error. */
  async test(cfg: NtfySettings | null = this.cfg): Promise<{ ok: boolean; error?: string }> {
    if (!cfg) return { ok: false, error: 'ntfy is not configured' }
    try {
      await this.enqueue(cfg, { title: BRAND.productName, message: mainT(this.getConfig(), 'status.push.test'), urgent: false })
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Delivery failed' } }
  }
  dispose(): void { this.cancel() }
  private cancel(): void {
    this.epoch++
    this.abort?.abort()
    for (const job of this.queue.splice(0)) job.reject(new Error('Delivery cancelled: configuration changed'))
  }
  private enqueue(cfg: NtfySettings, msg: NtfyMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      try { ntfyServer(cfg.server); ntfyPayload(cfg, msg); ntfyHeaders(cfg) }
      catch (error) { this.error = error instanceof Error ? error.message : 'Invalid ntfy settings'; reject(new Error(this.error)); return }
      if (this.queue.length >= 100) { this.error = 'ntfy queue full'; reject(new Error(this.error)); return }
      this.queue.push({ cfg: { ...cfg }, msg, epoch: this.epoch, resolve, reject })
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
          this.error = error instanceof Error ? error.message : 'ntfy delivery failed'
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
        response = await this.fetcher(ntfyServer(job.cfg.server), { method: 'POST', headers: ntfyHeaders(job.cfg), body: JSON.stringify(ntfyPayload(job.cfg, job.msg)), redirect: 'error', signal: this.abort.signal })
      } catch {
        // A transport timeout may have published already. Do not duplicate it.
        throw new Error('ntfy delivery unconfirmed: network error or timeout')
      } finally { clearTimeout(timer); this.abort = null }
      if (response.ok) { await response.body?.cancel(); return }
      await response.body?.cancel()
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after') ?? 1)
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('ntfy rate limit: retry later')
        await this.delay(Math.max(100, seconds * 1000))
      } else if (response.status >= 500 && attempt < 2) {
        await this.delay(1000 * (attempt + 1))
      } else {
        throw new Error(`ntfy HTTP ${response.status}`)
      }
    }
  }
}
