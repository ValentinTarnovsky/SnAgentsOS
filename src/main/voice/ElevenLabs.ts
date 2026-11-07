/**
 * Hands-free voice (app 2.11.0): the optional ElevenLabs engine, cache-first.
 * main is the only one that talks to the API (the renderer's CSP has no
 * connect-src): POST /v1/text-to-speech/{voice}?output_format=pcm_24000 with
 * the user's key, sealed with the OS (DPAPI) in `voice/eleven-key.json` and
 * never sent back to the renderer (only "set" and its last 4 characters).
 * Characters sent are counted per ElevenLabs period in `voice/credits.json`.
 * Only api.elevenlabs.io is ever called. Neither the key nor any text is logged.
 */
import { promises as fsp, readFileSync } from 'fs'
import { join } from 'path'
import { writeAtomic } from '../fsAtomic'
import type { VoiceElevenSettings } from '@shared/voice'
import { TtsError, type TtsAudio, type TtsEngine, type TtsRequest } from './LocalTts'

export const ELEVEN_HOST = 'api.elevenlabs.io'
export const ELEVEN_RATE = 24000
const KEY_FILE = 'eleven-key.json'
const CREDITS_FILE = 'credits.json'
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/

/** The part of the Fetch API this module uses (production: Electron `net.fetch`). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>

export interface SealCrypto {
  available(): boolean
  encrypt(s: string): Buffer
  decrypt(b: Buffer): string
}

export interface ElevenDeps {
  dir: string
  crypto: SealCrypto
  fetch: FetchLike
  settings: () => VoiceElevenSettings
  now?: () => number
  log?: (line: string) => void
}

export type ElevenError = 'unauthorized' | 'rate_limited' | 'quota' | 'network' | 'bad_voice' | 'no_key' | 'unavailable'

export class ElevenFail extends TtsError {
  constructor(readonly reason: ElevenError) {
    super('synth')
  }
}

/** The local date (YYYY-MM-DD) the period containing `now` started, given its reset day (1..28). */
export function periodStart(now: number, resetDay: number): string {
  const d = new Date(now)
  const day = Math.max(1, Math.min(28, Math.round(resetDay) || 1))
  let y = d.getFullYear()
  let m = d.getMonth()
  if (d.getDate() < day) {
    m -= 1
    if (m < 0) {
      m = 11
      y -= 1
    }
  }
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export class ElevenLabs implements TtsEngine {
  readonly id = 'elevenlabs' as const
  private key: string | null = null
  private keyLoaded = false
  private credits: { periodStart: string; chars: number } | null = null

  constructor(private readonly deps: ElevenDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private log(line: string): void {
    try {
      this.deps.log?.(`eleven ${line}`)
    } catch {
      /* never blocks */
    }
  }

  private loadKey(): string | null {
    if (this.keyLoaded) return this.key
    this.keyLoaded = true
    try {
      const raw = JSON.parse(readFileSync(join(this.deps.dir, KEY_FILE), 'utf8')) as { v?: unknown; enc?: unknown; data?: unknown }
      if (raw?.v === 1 && raw.enc === 'os' && typeof raw.data === 'string' && this.deps.crypto.available()) {
        const key = this.deps.crypto.decrypt(Buffer.from(raw.data, 'base64'))
        this.key = KEY_RE.test(key) ? key : null
      }
    } catch {
      this.key = null
    }
    return this.key
  }

  keyState(): { keySet: boolean; last4: string } {
    const k = this.loadKey()
    return { keySet: !!k, last4: k ? k.slice(-4) : '' }
  }

  /** Stores (or with null removes) the key. A key that is not a plain token is refused; without OS encryption nothing is stored. */
  async setKey(key: string | null): Promise<{ ok: boolean; error?: 'bad_key' | 'unavailable' }> {
    const file = join(this.deps.dir, KEY_FILE)
    if (key === null || key === '') {
      await fsp.rm(file, { force: true }).catch(() => undefined)
      this.key = null
      this.keyLoaded = true
      this.log('key removed')
      return { ok: true }
    }
    const k = String(key).trim()
    if (!KEY_RE.test(k)) return { ok: false, error: 'bad_key' }
    if (!this.deps.crypto.available()) return { ok: false, error: 'unavailable' }
    await fsp.mkdir(this.deps.dir, { recursive: true })
    await writeAtomic(file, JSON.stringify({ v: 1, enc: 'os', data: this.deps.crypto.encrypt(k).toString('base64') }) + '\n')
    this.key = k
    this.keyLoaded = true
    this.log('key set')
    return { ok: true }
  }

  ready(): boolean {
    return !!this.loadKey() && /^[A-Za-z0-9_-]{1,64}$/.test(this.deps.settings().voiceId)
  }

  // --- credits ----------------------------------------------------------------

  private loadCredits(): { periodStart: string; chars: number } {
    const start = periodStart(this.now, this.deps.settings().resetDay)
    if (!this.credits) {
      try {
        const raw = JSON.parse(readFileSync(join(this.deps.dir, CREDITS_FILE), 'utf8')) as { v?: unknown; periodStart?: unknown; chars?: unknown }
        if (raw?.v === 1 && typeof raw.periodStart === 'string' && typeof raw.chars === 'number' && raw.chars >= 0) this.credits = { periodStart: raw.periodStart, chars: Math.floor(raw.chars) }
      } catch {
        /* no file yet */
      }
    }
    if (!this.credits || this.credits.periodStart !== start) this.credits = { periodStart: start, chars: 0 }
    return this.credits
  }

  usage(): { usedChars: number; periodStart: string } {
    const c = this.loadCredits()
    return { usedChars: c.chars, periodStart: c.periodStart }
  }

  /** Variable text may go to ElevenLabs: mode `all` and the period's characters stay within the cap. */
  canSpend(chars: number): boolean {
    const s = this.deps.settings()
    return s.mode === 'all' && this.loadCredits().chars + chars <= s.monthlyCap
  }

  private async record(chars: number): Promise<void> {
    const c = this.loadCredits()
    c.chars += chars
    try {
      await fsp.mkdir(this.deps.dir, { recursive: true })
      await writeAtomic(join(this.deps.dir, CREDITS_FILE), JSON.stringify({ v: 1, periodStart: c.periodStart, chars: c.chars }) + '\n')
    } catch {
      /* the count stays in memory */
    }
  }

  // --- API --------------------------------------------------------------------

  async synth(req: TtsRequest, signal?: AbortSignal): Promise<TtsAudio> {
    const key = this.loadKey()
    if (!key) throw new ElevenFail('no_key')
    const s = this.deps.settings()
    const voice = req.voice || s.voiceId
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(voice)) throw new ElevenFail('bad_voice')
    const url = `https://${ELEVEN_HOST}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_${ELEVEN_RATE}`
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.deps.fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
        body: JSON.stringify({ text: req.text, model_id: s.model, ...(req.lang ? { language_code: req.lang } : {}), voice_settings: { speed: Math.max(0.7, Math.min(1.2, req.speed)) } }),
        signal,
      })
    } catch {
      if (signal?.aborted) throw new TtsError('aborted')
      this.log('error=network')
      throw new ElevenFail('network')
    }
    if (res.status === 401 || res.status === 403) {
      const quota = await res
        .json()
        .then((j) => JSON.stringify(j).includes('quota'))
        .catch(() => false)
      this.log(`error=${quota ? 'quota' : 'unauthorized'} status=${res.status}`)
      throw new ElevenFail(quota ? 'quota' : 'unauthorized')
    }
    if (res.status === 429) {
      this.log('error=rate_limited')
      throw new ElevenFail('rate_limited')
    }
    if (res.status === 404 || res.status === 422) {
      this.log(`error=bad_voice status=${res.status}`)
      throw new ElevenFail('bad_voice')
    }
    if (res.status < 200 || res.status >= 300) {
      this.log(`error=network status=${res.status}`)
      throw new ElevenFail('network')
    }
    const pcm = await res.arrayBuffer()
    await this.record(req.text.length)
    this.log(`ok chars=${req.text.length} bytes=${pcm.byteLength}`)
    return { rate: ELEVEN_RATE, pcm }
  }

  /** One subscription read, on demand (Settings > Probar): the key works and how many characters are left. */
  async test(): Promise<{ ok: boolean; error?: ElevenError; used?: number; limit?: number }> {
    const key = this.loadKey()
    if (!key) return { ok: false, error: 'no_key' }
    try {
      const res = await this.deps.fetch(`https://${ELEVEN_HOST}/v1/user/subscription`, { method: 'GET', headers: { 'xi-api-key': key, Accept: 'application/json' } })
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'unauthorized' }
      if (res.status < 200 || res.status >= 300) return { ok: false, error: 'network' }
      const j = (await res.json()) as { character_count?: unknown; character_limit?: unknown }
      return { ok: true, ...(typeof j.character_count === 'number' ? { used: j.character_count } : {}), ...(typeof j.character_limit === 'number' ? { limit: j.character_limit } : {}) }
    } catch {
      return { ok: false, error: 'network' }
    }
  }
}
