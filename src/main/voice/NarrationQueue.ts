/**
 * Hands-free voice (app 2.11.0): the one queue every spoken item goes through,
 * so two consoles never talk at once. One item is in flight: it is
 * synthesized (part by part, through the engine router and the phrase cache),
 * sent to the renderer to play, and the next starts only when the renderer
 * says it played (or a watchdog at its length + 2 s). What the user asked
 * for goes first, then requests and failures, then "finished" announcements.
 * While the user dictates, only what the user asked for is said. No Electron
 * import; timers through DeadlineTimer.
 */
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'
import type { TtsAudio } from './LocalTts'

/** 0: what the user asked for; 1: a request or a failure; 2: a finished console. */
export type NarrationPriority = 0 | 1 | 2

export interface NarrationPart {
  text: string
  /** A fixed phrase: synthesized once and kept in the phrase cache. */
  fixed: boolean
}

export interface NarrationItem {
  priority: NarrationPriority
  parts: NarrationPart[]
  /** A later item with the same tag replaces this one while it waits. */
  tag?: string
  /** Called when it is about to be said; false drops it (the console moved on meanwhile). */
  stillValid?: () => boolean
  onSpoken?: () => void
}

export interface NarrationDeps {
  synth: (part: NarrationPart, signal: AbortSignal) => Promise<TtsAudio | null>
  play: (id: number, audio: TtsAudio) => void
  stopPlayback: () => void
  onSpeaking?: (on: boolean, queued: number) => void
  timer?: DeadlineTimerDeps
  log?: (line: string) => void
}

/** Silence between two parts of one item. */
export const PART_GAP_MS = 140
export const WATCHDOG_EXTRA_MS = 2000
export const QUEUE_MAX = 12

/** Joins s16 PCM parts at one rate with a short gap (parts at another rate are resampled by nearest sample). */
export function joinAudio(parts: TtsAudio[], gapMs = PART_GAP_MS): TtsAudio | null {
  const ok = parts.filter((p) => p && p.pcm.byteLength > 0)
  if (!ok.length) return null
  const rate = ok[0].rate
  const gap = Math.round((rate * gapMs) / 1000)
  const chunks = ok.map((p) => {
    const src = new Int16Array(p.pcm)
    if (p.rate === rate) return src
    const n = Math.round((src.length * rate) / p.rate)
    const out = new Int16Array(n)
    for (let i = 0; i < n; i++) out[i] = src[Math.min(src.length - 1, Math.floor((i * p.rate) / rate))]
    return out
  })
  const total = chunks.reduce((n, c) => n + c.length, 0) + gap * (chunks.length - 1)
  const out = new Int16Array(total)
  let at = 0
  chunks.forEach((c, i) => {
    out.set(c, at)
    at += c.length + (i < chunks.length - 1 ? gap : 0)
  })
  return { rate, pcm: out.buffer }
}

interface Queued extends NarrationItem {
  seq: number
}

export class NarrationQueue {
  private readonly items: Queued[] = []
  private current: { id: number; item: Queued; ctrl: AbortController; playing: boolean } | null = null
  private seq = 0
  private playId = 0
  private dictating = false
  private active = false
  private last: TtsAudio | null = null
  private readonly timer: DeadlineTimer<string>
  private readonly now: () => number

  constructor(private readonly deps: NarrationDeps) {
    this.now = deps.timer?.now ?? (() => Date.now())
    this.timer = new DeadlineTimer<string>((key) => this.due(key), deps.timer)
  }

  /** Hands-free is on (nothing is said while it is off). Turning it off drops everything. */
  setActive(on: boolean): void {
    this.active = on
    if (!on) this.stop(true)
  }

  /** The user dictates: only priority 0 items start meanwhile. */
  setDictating(on: boolean): void {
    this.dictating = on
    if (!on) this.pump()
  }

  get size(): number {
    return this.items.length + (this.current ? 1 : 0)
  }

  get speaking(): boolean {
    return !!this.current
  }

  enqueue(item: NarrationItem): void {
    if (!this.active || !item.parts.some((p) => p.text.trim())) return
    if (item.tag) {
      const i = this.items.findIndex((q) => q.tag === item.tag)
      if (i >= 0) this.items.splice(i, 1)
    }
    this.items.push({ ...item, seq: ++this.seq })
    this.items.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
    // Too many waiting: the oldest announcements go first.
    while (this.items.length > QUEUE_MAX) {
      const drop = [...this.items].reverse().findIndex((q) => q.priority === 2)
      this.items.splice(drop >= 0 ? this.items.length - 1 - drop : this.items.length - 1, 1)
    }
    this.notify()
    this.pump()
  }

  /** The renderer played (or stopped, or failed to play) item `id`. */
  played(id: number): void {
    const cur = this.current
    if (!cur || cur.id !== id) return
    this.timer.clear('watchdog')
    this.current = null
    try {
      cur.item.onSpoken?.()
    } catch {
      /* never blocks the queue */
    }
    this.notify()
    this.pump()
  }

  /** Stops what is being said; `all` also drops what waits (else only what the user asked for). */
  stop(all = false): void {
    const cur = this.current
    if (cur) {
      cur.ctrl.abort()
      this.timer.clear('watchdog')
      this.current = null
      if (cur.playing) this.deps.stopPlayback()
    }
    for (let i = this.items.length - 1; i >= 0; i--) if (all || this.items[i].priority === 0) this.items.splice(i, 1)
    this.notify()
    if (!all) this.pump()
  }

  /** Says the last played audio again (priority 0, nothing to synthesize). */
  repeat(): boolean {
    if (!this.last || !this.active) return false
    const audio = this.last
    this.stop()
    const id = ++this.playId
    const item: Queued = { priority: 0, parts: [], seq: ++this.seq }
    this.current = { id, item, ctrl: new AbortController(), playing: true }
    this.armWatchdog(audio)
    this.deps.play(id, audio)
    this.notify()
    return true
  }

  dispose(): void {
    this.stop(true)
    this.timer.dispose()
  }

  private pump(): void {
    if (this.current || !this.active) return
    const i = this.items.findIndex((q) => !this.dictating || q.priority === 0)
    if (i < 0) return
    const item = this.items.splice(i, 1)[0]
    if (item.stillValid && !item.stillValid()) {
      this.notify()
      this.pump()
      return
    }
    const id = ++this.playId
    const ctrl = new AbortController()
    this.current = { id, item, ctrl, playing: false }
    this.notify()
    void this.run(id, item, ctrl)
  }

  private async run(id: number, item: Queued, ctrl: AbortController): Promise<void> {
    const audios: TtsAudio[] = []
    for (const part of item.parts) {
      if (ctrl.signal.aborted) return
      if (!part.text.trim()) continue
      try {
        const a = await this.deps.synth(part, ctrl.signal)
        if (a) audios.push(a)
      } catch {
        this.log('synth failed')
      }
    }
    const cur = this.current
    if (ctrl.signal.aborted || !cur || cur.id !== id) return
    const audio = joinAudio(audios)
    if (!audio) {
      this.current = null
      this.notify()
      this.pump()
      return
    }
    cur.playing = true
    this.last = audio
    this.armWatchdog(audio)
    this.deps.play(id, audio)
  }

  private armWatchdog(audio: TtsAudio): void {
    const ms = (audio.pcm.byteLength / 2 / audio.rate) * 1000
    this.timer.set('watchdog', this.now() + ms + WATCHDOG_EXTRA_MS)
  }

  private due(key: string): void {
    if (key !== 'watchdog' || !this.current) return
    this.log('watchdog')
    this.played(this.current.id)
  }

  private notify(): void {
    try {
      this.deps.onSpeaking?.(!!this.current, this.items.length)
    } catch {
      /* never blocks */
    }
  }

  private log(line: string): void {
    try {
      this.deps.log?.(`queue ${line}`)
    } catch {
      /* never blocks */
    }
  }
}
