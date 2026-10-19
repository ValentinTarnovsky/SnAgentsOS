/**
 * Web Push to the phone's installed PWA (E3-FR-44..46), with the `web-push`
 * library (MIT, main only; RFC 8291 encryption, VAPID).
 *
 *  - Keys and subscriptions live in `dataDir()/push-keys.json` (atomic tmp +
 *    rename). The VAPID pair is generated the first time the secure mode turns
 *    on; turning it off keeps the file, so the subscriptions survive (FR-46).
 *  - `POST /api/push/subscribe` (after RemoteServer accepted Host and Origin):
 *    404 while the secure mode is off, 401 without a live Bearer `httpToken`,
 *    413 over PUSH_BODY_MAX, 400 for a body that is not a PushSubscription or
 *    whose endpoint is not one of the push services of the allow-list (an
 *    arbitrary URL would turn the desktop into a request relay). 200 stores it
 *    under the device that owns the token.
 *  - notify(): one push per subscription whose device is still paired and has
 *    no visible session (the caller says which). TTL 300 s, `urgency: high`
 *    for action. The payload is only a title, the "<console> - <workspace>"
 *    body, the pane as `tag` and a deep link: never any text of the agent.
 *    A 404/410 from the push service drops that subscription (the phone's
 *    `subscription.unsubscribe()` ends up here too).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'
import { dirname } from 'path'
import * as webpush from 'web-push'
import { z } from 'zod'
import { BRAND } from '@shared/brand'
import type { AttentionReason, ConfigFile } from '@shared/types'
import type { StatusNotice } from '../status/events'
import { mainT } from '../i18n'

/** Largest accepted subscribe body (E3 M14: 4KB). */
export const PUSH_BODY_MAX = 4 * 1024
/** Seconds a push service keeps an undelivered notification (E3 M14). */
export const PUSH_TTL_S = 300
/** Subscriptions kept per device (a phone re-subscribing replaces by endpoint). */
export const PUSH_SUBS_PER_DEVICE = 4
/** Subscriptions kept in total. */
export const PUSH_SUBS_MAX = 40
/** Request timeout towards a push service. */
const PUSH_SEND_TIMEOUT_MS = 10 * 1000
/** VAPID subject: an https URL of the project (web-push needs https: or mailto:). */
const VAPID_SUBJECT = `https://github.com/${BRAND.repo}`

/** Push services a subscription may point at (E3 M14 allow-list). */
const EXACT_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com'])
const SUFFIX_HOSTS = ['.push.apple.com', '.notify.windows.com']

/** True for an https endpoint of an allowed push service, default port, no credentials. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return EXACT_HOSTS.has(host) || SUFFIX_HOSTS.some((s) => host.endsWith(s) && host.length > s.length)
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    // P-256 point (65 bytes, 87-88 chars) and the 16-byte auth secret (22-24).
    p256dh: z.string().min(80).max(100).regex(B64URL),
    auth: z.string().min(16).max(32).regex(B64URL),
  }),
})

const storedSubSchema = z.object({
  deviceId: z.string().min(1).max(128),
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().max(100), auth: z.string().max(32) }),
  createdAt: z.number(),
})
type StoredSub = z.infer<typeof storedSubSchema>

const fileSchema = z.object({
  version: z.literal(1),
  vapid: z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }).optional(),
  subscriptions: z.array(storedSubSchema).catch([]),
})
type PushFile = z.infer<typeof fileSchema>

/** What one push carries (built from a StatusNotice by the caller). */
export interface PushMessage {
  title: string
  body: string
  /** paneId: a newer push of the same console replaces the older one (FR-45). */
  tag: string
  /** Deep link relative to the PWA scope, `./#ws=<id>&pane=<id>` (E2 deep links). */
  url: string
  /** action: `urgency: high`. */
  urgent: boolean
}

/**
 * The push of a StatusNotice (E3-FR-45): "<Agent> needs permission" style
 * title in the config language, "<console> - <workspace>" body, the pane as
 * tag and the deep link relative to the PWA scope. No agent text ever.
 */
export function buildPushMessage(notice: StatusNotice, config: ConfigFile | null): PushMessage {
  const agent = notice.provider === 'codex' ? 'Codex' : 'Claude'
  const reason: AttentionReason | 'done' =
    notice.state === 'done' ? 'done' : notice.state === 'error' ? 'failure' : (notice.reason ?? 'permission')
  const title = mainT(config, `webpush.${reason}`, { agent })
  let body: string = BRAND.productName
  let url = './'
  for (const ws of config?.workspaces ?? []) {
    const pane = ws.panes.find((p) => p.id === notice.paneId)
    if (!pane) continue
    body = `${pane.title} - ${ws.name}`
    url = `./#ws=${encodeURIComponent(ws.id)}&pane=${encodeURIComponent(pane.id)}`
    break
  }
  return { title, body: body.slice(0, 200), tag: notice.paneId, url, urgent: notice.state === 'action' }
}

export interface PushSendOpts {
  TTL: number
  urgency: 'high' | 'normal'
  vapidDetails: { subject: string; publicKey: string; privateKey: string }
  timeout: number
}

/** Sends one encrypted push; rejects with `{ statusCode }` like web-push. */
export type PushSend = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, opts: PushSendOpts) => Promise<unknown>

export interface PushServiceDeps {
  /** `dataDir()/push-keys.json`, read when first needed (after the legacy migration). */
  file: () => string
  send?: PushSend
  generateKeys?: () => { publicKey: string; privateKey: string }
  now?: () => number
}

/** Context of one subscribe request (RemoteManager). */
export interface PushSubscribeCtx {
  /** settings.remote.https.enabled: off = 404 (FR-46). */
  enabled: boolean
  resolveToken: (token: string) => { deviceId: string } | null
}

/** Context of one notify (RemoteManager). */
export interface PushNotifyCtx {
  enabled: boolean
  /** The device has a visible session (SessionManager.isDeviceVisible): skip it. */
  isDeviceVisible: (deviceId: string) => boolean
  /** The device is still paired (a revoke drops its subscriptions anyway). */
  isPaired: (deviceId: string) => boolean
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer ([0-9a-f]{64})$/.exec(h.trim())
  return m ? m[1] : null
}

function answer(res: ServerResponse, code: number, body: Record<string, unknown>): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    Connection: 'close',
  })
  res.end(text)
}

export class PushService {
  private data: PushFile | null = null
  private readonly send: PushSend
  private readonly generateKeys: () => { publicKey: string; privateKey: string }
  private readonly now: () => number

  constructor(private readonly deps: PushServiceDeps) {
    this.send = deps.send ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts))
    this.generateKeys = deps.generateKeys ?? (() => webpush.generateVAPIDKeys())
    this.now = deps.now ?? Date.now
  }

  // --- Persistence --------------------------------------------------------------

  private load(): PushFile {
    if (this.data) return this.data
    let parsed: PushFile | null = null
    try {
      const res = fileSchema.safeParse(JSON.parse(readFileSync(this.deps.file(), 'utf8')))
      if (res.success) parsed = res.data
    } catch {
      parsed = null
    }
    this.data = parsed ?? { version: 1, subscriptions: [] }
    return this.data
  }

  private persist(): void {
    const data = this.load()
    const file = this.deps.file()
    const tmp = `${file}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      console.warn('[push] could not save push-keys.json:', err instanceof Error ? err.message : err)
    }
  }

  // --- Keys -----------------------------------------------------------------------

  /** The public VAPID key, generating and saving the pair the first time. */
  ensureKeys(): string {
    const data = this.load()
    if (!data.vapid) {
      data.vapid = this.generateKeys()
      this.persist()
    }
    return data.vapid.publicKey
  }

  /** The public VAPID key if one exists (never generates). */
  publicKey(): string | null {
    return this.load().vapid?.publicKey ?? null
  }

  // --- Subscriptions --------------------------------------------------------------

  /** Stored subscriptions (a copy, for the tests and diagnostics). */
  list(): Array<{ deviceId: string; endpoint: string }> {
    return this.load().subscriptions.map((s) => ({ deviceId: s.deviceId, endpoint: s.endpoint }))
  }

  /**
   * Store a validated subscription under a device: the same endpoint moves
   * to it (a phone re-paired on the same origin), the oldest go past the caps.
   */
  add(deviceId: string, sub: z.infer<typeof pushSubscriptionSchema>): void {
    const data = this.load()
    const rest = data.subscriptions.filter((s) => s.endpoint !== sub.endpoint)
    rest.push({ deviceId, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: this.now() })
    const mine = rest.filter((s) => s.deviceId === deviceId)
    let next = mine.length > PUSH_SUBS_PER_DEVICE ? rest.filter((s) => !mine.slice(0, mine.length - PUSH_SUBS_PER_DEVICE).includes(s)) : rest
    if (next.length > PUSH_SUBS_MAX) next = next.slice(next.length - PUSH_SUBS_MAX)
    data.subscriptions = next
    this.persist()
  }

  /** A revoked device loses every subscription (E3 M14). */
  removeDevice(deviceId: string): void {
    const data = this.load()
    const next = data.subscriptions.filter((s) => s.deviceId !== deviceId)
    if (next.length === data.subscriptions.length) return
    data.subscriptions = next
    this.persist()
  }

  private removeEndpoint(endpoint: string): void {
    const data = this.load()
    const next = data.subscriptions.filter((s) => s.endpoint !== endpoint)
    if (next.length === data.subscriptions.length) return
    data.subscriptions = next
    this.persist()
  }

  // --- HTTP -------------------------------------------------------------------------

  /** `POST /api/push/subscribe`, Host and Origin already accepted by RemoteServer. */
  handleSubscribe(req: IncomingMessage, res: ServerResponse, ctx: PushSubscribeCtx): void {
    if (!ctx.enabled || !this.publicKey()) return answer(res, 404, { error: 'not_found' })
    const token = bearer(req)
    const owner = token ? ctx.resolveToken(token) : null
    if (!owner) return answer(res, 401, { error: 'unauthorized' })
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > PUSH_BODY_MAX) return answer(res, 413, { error: 'too_large' })
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > PUSH_BODY_MAX) {
        done = true
        answer(res, 413, { error: 'too_large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => {
      done = true
    })
    req.on('end', () => {
      if (done) return
      done = true
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return answer(res, 400, { error: 'bad_request' })
      }
      const parsed = pushSubscriptionSchema.safeParse(body)
      if (!parsed.success) return answer(res, 400, { error: 'bad_request' })
      if (!isAllowedPushEndpoint(parsed.data.endpoint)) return answer(res, 400, { error: 'endpoint' })
      // The token may have died while the body arrived (revoke, socket closed).
      const still = ctx.resolveToken(token as string)
      if (!still || still.deviceId !== owner.deviceId) return answer(res, 401, { error: 'unauthorized' })
      this.add(owner.deviceId, parsed.data)
      answer(res, 200, { ok: true })
    })
  }

  // --- Sending ----------------------------------------------------------------------

  /**
   * Push a message to every subscription of a paired device without a visible
   * session. Resolves with how many pushes the services accepted. Nothing goes
   * out while the secure mode is off, and the subscriptions stay (FR-46).
   */
  async notify(msg: PushMessage, ctx: PushNotifyCtx): Promise<number> {
    if (!ctx.enabled) return 0
    const data = this.load()
    const vapid = data.vapid
    if (!vapid || data.subscriptions.length === 0) return 0
    const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag, url: msg.url })
    const opts: PushSendOpts = {
      TTL: PUSH_TTL_S,
      urgency: msg.urgent ? 'high' : 'normal',
      vapidDetails: { subject: VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      timeout: PUSH_SEND_TIMEOUT_MS,
    }
    const targets: StoredSub[] = []
    for (const sub of data.subscriptions) {
      let visible = false
      try {
        if (!ctx.isPaired(sub.deviceId)) continue
        visible = ctx.isDeviceVisible(sub.deviceId)
      } catch {
        visible = false
      }
      if (!visible) targets.push(sub)
    }
    const results = await Promise.all(
      targets.map(async (sub) => {
        try {
          await this.send({ endpoint: sub.endpoint, keys: sub.keys }, payload, opts)
          return true
        } catch (err) {
          const status = (err as { statusCode?: unknown } | null)?.statusCode
          // Gone at the push service: the phone unsubscribed or the browser dropped it.
          if (status === 404 || status === 410) this.removeEndpoint(sub.endpoint)
          else console.warn('[push] send failed:', typeof status === 'number' ? status : err instanceof Error ? err.message : 'error')
          return false
        }
      }),
    )
    return results.filter(Boolean).length
  }
}
