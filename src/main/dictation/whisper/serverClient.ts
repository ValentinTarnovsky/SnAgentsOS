import { request } from 'http'

/**
 * HTTP client for the local whisper-server (app 2.5.0). Plain node:http to
 * 127.0.0.1, never Electron `net`, so no proxy ever sees the audio. Every
 * route lives under the secret `/<token>` request path; the token and the
 * prompt are never logged.
 */

export interface InferenceParams {
  /** Whisper language code ('es', 'en', ...) or 'auto'. Sent on every request (the server default is 'en'). */
  lang: string
  /** Biasing text, per request (never on the command line). Empty: not sent. */
  prompt: string
  /** Beam search width; unset is greedy. */
  beamSize?: number
  /** Encoder context (CPU short segments only); unset is the full window. */
  audioCtx?: number
  /** Silero VAD inside the server: the real speech gate. */
  vad: boolean
}

/** Longest response body read; a longer one is not ours. */
export const RESPONSE_MAX_BYTES = 1024 * 1024

export type ClientErrorCode = 'timeout' | 'exit' | 'http' | 'size'

/** A request that failed: `timeout` (no answer in time), `exit` (connection refused or reset), `http` (not 200), `size`. */
export class ClientError extends Error {
  constructor(readonly code: ClientErrorCode) {
    super(code)
  }
}

function field(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8')
}

/**
 * multipart/form-data for POST /inference: the WAV as `file`, verbose_json,
 * the language, temperature 0, vad, suppress_nst, and the prompt, beam size
 * and audio context when set. Values are written as is (UTF-8); the boundary
 * is random per request, so the prompt cannot close a part.
 */
export function multipartBody(wav: Buffer, p: InferenceParams, boundary: string): Buffer {
  const parts: Buffer[] = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`, 'utf8'),
    wav,
    Buffer.from('\r\n', 'utf8'),
    field(boundary, 'response_format', 'verbose_json'),
    field(boundary, 'language', p.lang),
    field(boundary, 'temperature', '0'),
    field(boundary, 'vad', p.vad ? 'true' : 'false'),
    field(boundary, 'suppress_nst', 'true'),
  ]
  const prompt = p.prompt.replace(/\r?\n/g, ' ')
  if (prompt) parts.push(field(boundary, 'prompt', prompt))
  if (p.beamSize !== undefined) parts.push(field(boundary, 'beam_size', String(Math.trunc(p.beamSize))))
  if (p.audioCtx !== undefined) parts.push(field(boundary, 'audio_ctx', String(Math.trunc(p.audioCtx))))
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(parts)
}

/** POST /<token>/inference; resolves with the body (status 200 only). The whole request is bounded by `timeoutMs`. */
export function postInference(port: number, token: string, body: Buffer, boundary: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false
    const fail = (code: ClientErrorCode): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.destroy()
      reject(new ClientError(code))
    }
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/${token}/inference`,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          fail('http')
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > RESPONSE_MAX_BYTES) {
            fail('size')
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(Buffer.concat(chunks).toString('utf8'))
        })
        res.on('error', () => fail('exit'))
        res.on('aborted', () => fail('exit'))
      },
    )
    const timer = setTimeout(() => fail('timeout'), timeoutMs)
    req.on('error', () => fail('exit'))
    req.end(body)
  })
}

/** GET /<token>/health: true only on 200 (503 while the model loads). Never rejects. */
export function getHealth(port: number, token: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.destroy()
      resolve(ok)
    }
    const req = request({ host: '127.0.0.1', port, path: `/${token}/health`, method: 'GET', agent: false }, (res) => {
      res.resume()
      finish(res.statusCode === 200)
    })
    const timer = setTimeout(() => finish(false), timeoutMs)
    req.on('error', () => finish(false))
    req.end()
  })
}
