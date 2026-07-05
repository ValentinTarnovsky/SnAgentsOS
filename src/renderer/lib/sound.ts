/**
 * Tiny WebAudio synth for status notification sounds. No binary assets: each
 * variant is a short envelope over one or two oscillators, so the app ships
 * zero audio files and volume is a plain gain multiplier.
 */
let ctx: AudioContext | null = null

function audioContext(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

interface Note {
  freq: number
  /** Seconds after play() the note starts. */
  at: number
  duration: number
  type: OscillatorType
  /** Optional end frequency for a pitch glide. */
  glideTo?: number
}

const SOUNDS: Record<'chime' | 'ping' | 'pop', Note[]> = {
  chime: [
    { freq: 880, at: 0, duration: 0.18, type: 'sine' },
    { freq: 1318.5, at: 0.12, duration: 0.22, type: 'sine' },
  ],
  ping: [{ freq: 1568, at: 0, duration: 0.15, type: 'sine' }],
  pop: [{ freq: 440, at: 0, duration: 0.12, type: 'triangle', glideTo: 220 }],
}

export function playStatusSound(id: 'chime' | 'ping' | 'pop', volume: number): void {
  const audio = audioContext()
  if (!audio) return
  const master = Math.max(0, Math.min(1, volume / 100)) * 0.35
  if (master <= 0) return
  const now = audio.currentTime
  for (const note of SOUNDS[id] ?? SOUNDS.chime) {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = note.type
    const start = now + note.at
    const end = start + note.duration
    osc.frequency.setValueAtTime(note.freq, start)
    if (note.glideTo) osc.frequency.exponentialRampToValueAtTime(note.glideTo, end)
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(master, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(gain)
    gain.connect(audio.destination)
    osc.start(start)
    osc.stop(end + 0.02)
  }
}
