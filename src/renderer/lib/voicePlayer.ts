/**
 * Hands-free voice (app 2.11.0): plays what main sends (`voice:play`, s16 mono
 * PCM) through one WebAudio context, one item at a time, and tells main when
 * it ended (`voice:played`), so the next one can start. WebAudio from an
 * ArrayBuffer needs no media-src, blob: URL or connect-src: the production
 * CSP stays as it is.
 */
import type { VoicePlay, VoicePlayOutcome } from '@shared/voice'

let ctx: AudioContext | null = null
let current: { id: number; src: AudioBufferSourceNode } | null = null
let endedAt = 0
const listeners = new Set<(playing: boolean) => void>()

function api() {
  return typeof window !== 'undefined' ? window.snApi?.voice : undefined
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn(!!current)
    } catch {
      /* never blocks playback */
    }
  }
}

/** s16 little-endian mono as float samples. */
export function s16ToFloat(pcm: ArrayBuffer): Float32Array<ArrayBuffer> {
  const src = new Int16Array(pcm)
  const out = new Float32Array(new ArrayBuffer(src.length * 4))
  for (let i = 0; i < src.length; i++) out[i] = src[i] / 0x8000
  return out
}

function finish(id: number, outcome: VoicePlayOutcome): void {
  if (current?.id === id) {
    current = null
    endedAt = Date.now()
    notify()
  }
  api()?.played(id, outcome)
}

export function playVoice(p: VoicePlay): void {
  stopVoice()
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    const samples = s16ToFloat(p.pcm)
    if (!samples.length) {
      api()?.played(p.id, 'error')
      return
    }
    const buf = ctx.createBuffer(1, samples.length, p.rate)
    buf.copyToChannel(samples, 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const gain = ctx.createGain()
    gain.gain.value = Math.max(0, Math.min(1, p.gain))
    src.connect(gain).connect(ctx.destination)
    current = { id: p.id, src }
    src.onended = () => finish(p.id, 'ended')
    src.start()
    notify()
  } catch {
    current = null
    notify()
    api()?.played(p.id, 'error')
  }
}

/** Stops what plays now (barge-in, "callate", main's stopPlayback). */
export function stopVoice(): void {
  const cur = current
  if (!cur) return
  current = null
  try {
    cur.src.onended = null
    cur.src.stop()
  } catch {
    /* already stopped */
  }
  endedAt = Date.now()
  notify()
  api()?.played(cur.id, 'stopped')
}

export function isVoicePlaying(): boolean {
  return !!current
}

/** Milliseconds since the last item stopped playing (Infinity before any). */
export function sinceVoiceEnded(now = Date.now()): number {
  return endedAt ? now - endedAt : Infinity
}

export function onVoicePlaying(fn: (playing: boolean) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

let wired = false

/** Subscribes to main's play and stop messages once (App mounts it with the Voice lab on). */
export function wireVoicePlayer(): void {
  if (wired) return
  const a = api()
  if (!a) return
  wired = true
  a.onPlay((p) => playVoice(p))
  a.onEvent((e) => {
    if (e.t === 'stopPlayback') stopVoice()
  })
}

export function __resetVoicePlayerForTests(): void {
  current = null
  endedAt = 0
  wired = false
  listeners.clear()
  ctx = null
}
