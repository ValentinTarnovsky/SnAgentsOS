/**
 * Desktop dictation capture (app 2.5.0): the microphone as 16 kHz mono s16
 * PCM in 100 ms chunks (3200 bytes), for `dictation:audio`. Audio only:
 * main's permission handler grants `media` to the app page only when every
 * requested type is audio.
 *
 *  - The AudioContext runs at 16 kHz so Chromium resamples. If that rate is
 *    refused (NotSupportedError from the context or the stream source) it
 *    runs at the device rate and the worklet resamples.
 *  - The worklet is the static `dictation-worklet.js` next to index.html
 *    (src/renderer/public, copied to out/renderer), loaded under the
 *    production CSP `script-src 'self'`.
 *  - Errors carry a DictationError in `.code`: NotAllowedError and
 *    SecurityError are `mic_denied`; NotFoundError and OverconstrainedError
 *    are `no_mic`; anything else (NotReadableError and AbortError, which is
 *    what a mic blocked by Windows privacy usually gives) is `audio`, whose
 *    overlay button opens the microphone privacy page too.
 */
import { DICTATION_SAMPLE_RATE } from '@shared/dictation'

export type CaptureError = 'mic_denied' | 'no_mic' | 'audio'

export interface Capture {
  /** Releases the microphone and the audio graph; no chunk is delivered after it. Idempotent. */
  stop(): void
  /** The context rate (16000, or the device rate when the worklet resamples). */
  readonly rate: number
}

export const WORKLET_FILE = 'dictation-worklet.js'
export const WORKLET_PROCESSOR = 'snaos-pcm'
/** 100 ms of 16 kHz s16 mono. */
export const CHUNK_BYTES = (DICTATION_SAMPLE_RATE / 10) * 2
/** A context that never leaves `suspended` this long is a capture failure. */
export const RESUME_TIMEOUT_MS = 3000

export class CaptureFailure extends Error {
  readonly code: CaptureError
  constructor(code: CaptureError, cause?: unknown) {
    super(`capture: ${code}${cause instanceof Error && cause.name ? ` (${cause.name})` : ''}`)
    this.code = code
  }
}

/** The getUserMedia / Web Audio error name as a DictationError. */
export function captureErrorCode(e: unknown): CaptureError {
  if (e instanceof CaptureFailure) return e.code
  const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'mic_denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'no_mic'
  return 'audio'
}

/** Same-origin worklet URL: next to the page in production, the public dir in dev. */
export function workletUrl(): string {
  return new URL(WORKLET_FILE, document.baseURI).href
}

function isNotSupported(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'name' in e && (e as { name: unknown }).name === 'NotSupportedError'
}

function closeQuietly(ctx: AudioContext | null): void {
  if (!ctx) return
  try {
    void ctx.close().catch(() => undefined)
  } catch {
    /* already closed */
  }
}

async function resumed(ctx: AudioContext): Promise<boolean> {
  if (ctx.state === 'running') return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ctx.resume().catch(() => undefined),
      new Promise<void>((r) => {
        timer = setTimeout(r, RESUME_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return (ctx.state as string) === 'running'
}

/**
 * Opens the microphone and starts delivering chunks. Rejects with a
 * CaptureFailure. `onError` reports a failure after the start (the track
 * ended: the mic was unplugged or revoked); the capture is already stopped then.
 */
export async function startCapture(onChunk: (pcm: ArrayBuffer) => void, onError?: (code: CaptureError) => void): Promise<Capture> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!md?.getUserMedia) throw new CaptureFailure('no_mic')
  let stream: MediaStream
  try {
    stream = await md.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
  } catch (e) {
    throw new CaptureFailure(captureErrorCode(e), e)
  }
  const tracks = stream.getAudioTracks()
  const releaseStream = () => {
    for (const t of stream.getTracks()) {
      try {
        t.stop()
      } catch {
        /* ignore */
      }
    }
  }
  if (tracks.length === 0) {
    releaseStream()
    throw new CaptureFailure('no_mic')
  }

  let ctx: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  try {
    try {
      ctx = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE, latencyHint: 'interactive' })
      source = ctx.createMediaStreamSource(stream)
    } catch (e) {
      if (!isNotSupported(e)) throw e
      // This device or build refuses a 16 kHz context: run at its rate, the worklet resamples.
      closeQuietly(ctx)
      ctx = new AudioContext({ latencyHint: 'interactive' })
      source = ctx.createMediaStreamSource(stream)
    }
    await ctx.audioWorklet.addModule(workletUrl())
    if (!(await resumed(ctx))) throw new CaptureFailure('audio')
  } catch (e) {
    try {
      ;(source as MediaStreamAudioSourceNode | null)?.disconnect()
    } catch {
      /* ignore */
    }
    closeQuietly(ctx)
    releaseStream()
    throw e instanceof CaptureFailure ? e : new CaptureFailure(captureErrorCode(e), e)
  }

  const audioCtx = ctx
  const src = source
  let node: AudioWorkletNode
  try {
    // No outputs: Chromium pulls an output-less worklet node by itself, so nothing plays.
    node = new AudioWorkletNode(audioCtx, WORKLET_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' })
    src.connect(node)
  } catch (e) {
    try {
      src.disconnect()
    } catch {
      /* ignore */
    }
    closeQuietly(audioCtx)
    releaseStream()
    throw new CaptureFailure(captureErrorCode(e), e)
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    node.port.onmessage = null
    for (const t of tracks) t.onended = null
    try {
      src.disconnect()
      node.disconnect()
    } catch {
      /* ignore */
    }
    try {
      node.port.close()
    } catch {
      /* ignore */
    }
    closeQuietly(audioCtx)
    releaseStream()
  }
  node.port.onmessage = (ev: MessageEvent) => {
    if (stopped) return
    const d: unknown = ev.data
    if (Object.prototype.toString.call(d) !== '[object ArrayBuffer]') return
    const buf = d as ArrayBuffer
    if (buf.byteLength > 0 && buf.byteLength % 2 === 0) onChunk(buf)
  }
  for (const t of tracks) {
    t.onended = () => {
      if (stopped) return
      stop()
      onError?.('audio')
    }
  }
  return { stop, rate: audioCtx.sampleRate }
}
