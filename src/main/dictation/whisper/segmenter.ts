/**
 * Energy endpointer for local dictation (app 2.5.0). Pure: 16 kHz mono s16
 * comes in as the renderer sends it (any chunk size), and closed phrases come
 * out through `onSegment`. Each phrase is posted to whisper-server with
 * `vad=true`, so Silero inside the server is the real speech gate; this
 * class only decides where a phrase starts and ends.
 *
 * - 30 ms frames; a frame is voiced when its RMS (on [-1, 1]) reaches
 *   max(ABS_MIN_RMS, noiseFloor * NOISE_FACTOR). The noise floor is an
 *   asymmetric tracker over unvoiced frames: it falls fast (NOISE_ALPHA_DOWN)
 *   on any quieter frame and rises slowly (NOISE_ALPHA_UP) only on idle frames
 *   close to it (under NOISE_LEARN_GATE times the floor). Learning from every
 *   unvoiced frame let soft syllables ratchet it up mid-utterance until the
 *   rest of the speech read as silence (review of app 2.5.0).
 * - START_FRAMES voiced frames in a row open a segment, with PRE_ROLL_MS of
 *   audio from before the run.
 * - END_SILENCE_MS of unvoiced frames close it; the segment keeps
 *   POST_ROLL_MS of that silence.
 * - A segment with less than MIN_SPEECH_MS of voiced frames is dropped (a
 *   click, a cough on the desk).
 * - MAX_SEGMENT_MS forces a cut, under Whisper's 30 s window; the audio after
 *   the cut goes on in a new segment.
 * - Steady-noise guard: a noise that is loud from the very first frame never
 *   feeds the floor (every frame is voiced). When the last STEADY_MS of an
 *   open segment hardly change in level (max/min RMS under STEADY_RATIO),
 *   the floor jumps to that level (the window's quietest frame), so the
 *   segment closes as silence and the noise stops opening new ones; quieter
 *   frames later pull it down again. Speech always varies more than that.
 */
import { DICTATION_SAMPLE_RATE } from '@shared/dictation'

export const FRAME_SAMPLES = 480 // 30 ms
export const START_FRAMES = 3 // 90 ms voiced opens a segment
export const END_SILENCE_MS = 700
export const PRE_ROLL_MS = 300
export const POST_ROLL_MS = 300
export const MIN_SPEECH_MS = 250 // shorter voiced runs are dropped (clicks)
export const MAX_SEGMENT_MS = 25000 // forced cut, under Whisper's 30 s window
export const ABS_MIN_RMS = 0.006 // on [-1, 1]
export const NOISE_FACTOR = 3 // threshold = max(ABS_MIN_RMS, noiseFloor * NOISE_FACTOR)
/** The floor follows a quieter frame at this rate (any frame under it, open segment or not). */
export const NOISE_ALPHA_DOWN = 0.1
/** And a louder one at this rate: idle frames under max(floor * NOISE_LEARN_GATE, ABS_MIN_RMS / 2) only. */
export const NOISE_ALPHA_UP = 0.03
export const NOISE_LEARN_GATE = 2
export const STEADY_MS = 2000
export const STEADY_RATIO = 1.25

const FRAME_MS = (FRAME_SAMPLES * 1000) / DICTATION_SAMPLE_RATE
const PRE_ROLL_FRAMES = Math.round(PRE_ROLL_MS / FRAME_MS)
const POST_ROLL_FRAMES = Math.round(POST_ROLL_MS / FRAME_MS)
const END_FRAMES = Math.ceil(END_SILENCE_MS / FRAME_MS)
const MIN_SPEECH_FRAMES = Math.ceil(MIN_SPEECH_MS / FRAME_MS)
const MAX_SEGMENT_SAMPLES = (MAX_SEGMENT_MS * DICTATION_SAMPLE_RATE) / 1000
const STEADY_FRAMES = Math.round(STEADY_MS / FRAME_MS)

/** Duration in ms of `samples` samples at 16 kHz. */
export function samplesToMs(samples: number): number {
  return (samples * 1000) / DICTATION_SAMPLE_RATE
}

function frameRms(frame: Int16Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768
    sum += v * v
  }
  return Math.sqrt(sum / frame.length)
}

function concat(frames: readonly Int16Array[], samples: number): Int16Array {
  const out = new Int16Array(samples)
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

export class Segmenter {
  private readonly onSegment: (pcm: Int16Array, ms: number) => void
  /** Samples left over from the last push (less than one frame). */
  private pending = new Int16Array(FRAME_SAMPLES)
  private pendingLen = 0
  private noiseFloor = 0
  // Idle state: the last frames (pre-roll plus the voiced run being counted).
  private ring: Int16Array[] = []
  private run = 0
  // Open state.
  private open = false
  private frames: Int16Array[] = []
  private samples = 0
  private voicedFrames = 0
  private silentRun = 0
  private recentRms: number[] = []

  constructor(onSegment: (pcm: Int16Array, ms: number) => void) {
    this.onSegment = onSegment
  }

  /** Feeds PCM of any length; frames are cut across calls. */
  push(pcm: Int16Array): void {
    let at = 0
    if (this.pendingLen > 0) {
      const take = Math.min(FRAME_SAMPLES - this.pendingLen, pcm.length)
      this.pending.set(pcm.subarray(0, take), this.pendingLen)
      this.pendingLen += take
      at = take
      if (this.pendingLen < FRAME_SAMPLES) return
      this.frame(this.pending.slice())
      this.pendingLen = 0
    }
    for (; at + FRAME_SAMPLES <= pcm.length; at += FRAME_SAMPLES) {
      this.frame(pcm.slice(at, at + FRAME_SAMPLES))
    }
    if (at < pcm.length) {
      this.pending.set(pcm.subarray(at), 0)
      this.pendingLen = pcm.length - at
    }
  }

  /** On stop: closes the open segment when it has at least MIN_SPEECH_MS of voice. */
  flush(): void {
    if (this.open && this.pendingLen > 0) {
      this.frames.push(this.pending.slice(0, this.pendingLen))
      this.samples += this.pendingLen
    }
    this.pendingLen = 0
    if (this.open) this.close(false)
    this.ring = []
    this.run = 0
  }

  /** Length of the open segment in ms, 0 when nothing is open. */
  get openMs(): number {
    return this.open ? samplesToMs(this.samples) : 0
  }

  /** A copy of the open segment (for the interim hypothesis), or null. */
  openPcm(): Int16Array | null {
    return this.open && this.samples > 0 ? concat(this.frames, this.samples) : null
  }

  private threshold(): number {
    return Math.max(ABS_MIN_RMS, this.noiseFloor * NOISE_FACTOR)
  }

  /**
   * The noise floor falls fast and rises slowly, and only on frames near it
   * while no segment is open: soft syllables and the pauses between words
   * (between the floor and the threshold) never push it up, so it cannot
   * ratchet until real speech reads as silence.
   */
  private learnNoise(rms: number, idle: boolean): void {
    if (rms < this.noiseFloor) {
      this.noiseFloor += NOISE_ALPHA_DOWN * (rms - this.noiseFloor)
      return
    }
    if (!idle) return
    if (this.noiseFloor === 0) {
      this.noiseFloor = rms
      return
    }
    if (rms < Math.max(this.noiseFloor * NOISE_LEARN_GATE, ABS_MIN_RMS / 2)) this.noiseFloor += NOISE_ALPHA_UP * (rms - this.noiseFloor)
  }

  private frame(frame: Int16Array): void {
    const rms = frameRms(frame)
    const voiced = rms >= this.threshold()
    if (!this.open) {
      this.ring.push(frame)
      if (this.ring.length > PRE_ROLL_FRAMES + START_FRAMES) this.ring.shift()
      if (!voiced) {
        this.run = 0
        this.learnNoise(rms, true)
        return
      }
      this.run++
      if (this.run < START_FRAMES) return
      // Open with the voiced run and up to PRE_ROLL_MS before it.
      this.open = true
      this.frames = this.ring
      this.samples = this.ring.length * FRAME_SAMPLES
      this.voicedFrames = this.run
      this.silentRun = 0
      this.recentRms = []
      this.ring = []
      this.run = 0
      return
    }

    this.frames.push(frame)
    this.samples += FRAME_SAMPLES
    this.recentRms.push(rms)
    if (this.recentRms.length > STEADY_FRAMES) this.recentRms.shift()
    let isVoice = voiced
    if (isVoice && this.steady()) {
      // A hum, not a voice: learn its level (its quietest frame, so the floor
      // never starts above the noise) so it reads as silence from now on.
      this.noiseFloor = Math.max(this.noiseFloor, Math.min(...this.recentRms))
      isVoice = rms >= this.threshold()
    }
    if (isVoice) {
      this.voicedFrames++
      this.silentRun = 0
    } else {
      this.learnNoise(rms, false)
      this.silentRun++
      if (this.silentRun >= END_FRAMES) {
        this.close(true)
        return
      }
    }
    if (this.samples + FRAME_SAMPLES > MAX_SEGMENT_SAMPLES) this.cut()
  }

  private steady(): boolean {
    if (this.recentRms.length < STEADY_FRAMES) return false
    let lo = Infinity
    let hi = 0
    for (const v of this.recentRms) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return lo > 0 && hi / lo < STEADY_RATIO
  }

  /** Ends the open segment; `trim` keeps only POST_ROLL_MS of the trailing silence. */
  private close(trim: boolean): void {
    let frames = this.frames
    let samples = this.samples
    if (trim) {
      const drop = Math.max(0, this.silentRun - POST_ROLL_FRAMES)
      if (drop > 0) {
        frames = frames.slice(0, frames.length - drop)
        samples -= drop * FRAME_SAMPLES
      }
    }
    const keep = this.voicedFrames >= MIN_SPEECH_FRAMES && samples > 0
    this.open = false
    this.frames = []
    this.samples = 0
    this.voicedFrames = 0
    this.silentRun = 0
    this.recentRms = []
    if (keep) {
      const pcm = concat(frames, samples)
      this.onSegment(pcm, samplesToMs(samples))
    }
  }

  /** MAX_SEGMENT_MS reached: emit what there is and go on in a fresh segment. */
  private cut(): void {
    const pcm = concat(this.frames, this.samples)
    const keep = this.voicedFrames >= MIN_SPEECH_FRAMES
    this.frames = []
    this.samples = 0
    this.voicedFrames = 0
    this.silentRun = 0
    if (keep) this.onSegment(pcm, samplesToMs(pcm.length))
  }
}
