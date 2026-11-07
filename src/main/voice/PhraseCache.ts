/**
 * Hands-free voice (app 2.11.0): the disk cache of fixed phrases ("Terminó
 * API", "Enviado", numbers), so each is synthesized once per engine, voice,
 * model, speed and language: with ElevenLabs that makes the fixed phrases a
 * one-time cost. Files: `voice/cache/<2 hex>/<sha256>.pcm` (s16 mono), and
 * `index.json` with hashes, rate, size and last use, never the text. Least
 * recently used entries go past the size cap. Variable text (summaries,
 * readings) is never cached on disk.
 */
import { createHash } from 'crypto'
import { promises as fsp, readFileSync } from 'fs'
import { join } from 'path'
import { writeAtomic } from '../fsAtomic'
import type { TtsAudio } from './LocalTts'

interface Entry {
  rate: number
  bytes: number
  at: number
}

export interface PhraseKey {
  engine: string
  voice: string
  model: string
  speed: number
  lang: string
  text: string
}

export function phraseHash(k: PhraseKey): string {
  return createHash('sha256').update(JSON.stringify([k.engine, k.voice, k.model, k.speed.toFixed(2), k.lang, k.text])).digest('hex')
}

export class PhraseCache {
  private index: Map<string, Entry> | null = null

  constructor(
    private readonly dir: string,
    private readonly maxBytes: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  private file(hash: string): string {
    return join(this.dir, hash.slice(0, 2), `${hash}.pcm`)
  }

  private load(): Map<string, Entry> {
    if (this.index) return this.index
    const out = new Map<string, Entry>()
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')) as { v?: unknown; entries?: unknown }
      if (raw?.v === 1 && raw.entries && typeof raw.entries === 'object') {
        for (const [h, e] of Object.entries(raw.entries as Record<string, Partial<Entry>>)) {
          if (/^[0-9a-f]{64}$/.test(h) && e && typeof e.rate === 'number' && typeof e.bytes === 'number') out.set(h, { rate: e.rate, bytes: e.bytes, at: typeof e.at === 'number' ? e.at : 0 })
        }
      }
    } catch {
      /* no index yet, or a corrupt one: start empty (orphan files are overwritten) */
    }
    this.index = out
    return out
  }

  private async save(): Promise<void> {
    const entries: Record<string, Entry> = {}
    for (const [h, e] of this.load()) entries[h] = e
    await fsp.mkdir(this.dir, { recursive: true })
    await writeAtomic(join(this.dir, 'index.json'), JSON.stringify({ v: 1, entries }) + '\n')
  }

  /** Total bytes the cache holds. */
  size(): number {
    let n = 0
    for (const e of this.load().values()) n += e.bytes
    return n
  }

  async get(k: PhraseKey): Promise<TtsAudio | null> {
    const h = phraseHash(k)
    const e = this.load().get(h)
    if (!e) return null
    try {
      const buf = await fsp.readFile(this.file(h))
      if (buf.byteLength !== e.bytes) throw new Error('size')
      e.at = this.now()
      return { rate: e.rate, pcm: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer }
    } catch {
      this.load().delete(h)
      return null
    }
  }

  async put(k: PhraseKey, a: TtsAudio): Promise<void> {
    const h = phraseHash(k)
    const bytes = a.pcm.byteLength
    if (bytes === 0 || bytes > this.maxBytes()) return
    try {
      await fsp.mkdir(join(this.dir, h.slice(0, 2)), { recursive: true })
      await writeAtomic(this.file(h), new Uint8Array(a.pcm))
      this.load().set(h, { rate: a.rate, bytes, at: this.now() })
      await this.evict()
      await this.save()
    } catch {
      /* a cache write never fails a phrase */
    }
  }

  private async evict(): Promise<void> {
    const max = this.maxBytes()
    const idx = this.load()
    let total = this.size()
    if (total <= max) return
    const oldest = [...idx.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [h, e] of oldest) {
      if (total <= max) break
      idx.delete(h)
      total -= e.bytes
      await fsp.rm(this.file(h), { force: true }).catch(() => undefined)
    }
  }

  async clear(): Promise<void> {
    this.index = new Map()
    await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
