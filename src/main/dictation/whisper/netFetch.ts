/**
 * Production `deps.fetch` of the Whisper installer (app 2.5.0): one GET over
 * Electron `net`, so the system proxy and its auth apply (plain Node https
 * ignores them). Redirects are never followed here (`redirect: 'manual'`):
 * a 3xx resolves with its status and `location`, and the installer checks
 * the next hop itself. The body is an async iterable that pauses the
 * response while chunks wait to be written.
 */
import { net, type ClientRequest, type IncomingMessage } from 'electron'
import type { HttpFetch, HttpRes } from './WhisperInstaller'

/** Chunks buffered before the response is paused, and the level it resumes at. */
const HIGH_WATER = 64
const LOW_WATER = 16

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function lowerHeaders(h: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
  return out
}

const emptyBody: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
}

function bodyOf(req: ClientRequest, res: IncomingMessage, signal: AbortSignal): { body: AsyncIterable<Uint8Array>; close: () => void } {
  const chunks: Buffer[] = []
  let ended = false
  let failed: Error | null = null
  let paused = false
  let wake: (() => void) | null = null
  const flow = res as unknown as { pause?: () => void; resume?: () => void }
  const notify = (): void => {
    const w = wake
    wake = null
    w?.()
  }
  const abort = (): void => {
    try {
      req.abort()
    } catch {
      /* already done */
    }
  }
  const onAbort = (): void => {
    failed ??= abortError()
    abort()
    notify()
  }
  res.on('data', (c: Buffer) => {
    chunks.push(c)
    if (!paused && chunks.length >= HIGH_WATER && flow.pause) {
      paused = true
      flow.pause()
    }
    notify()
  })
  res.on('end', () => {
    ended = true
    notify()
  })
  res.on('error', (e: Error) => {
    failed ??= e
    notify()
  })
  res.on('aborted', () => {
    failed ??= abortError()
    notify()
  })
  req.on('error', (e: Error) => {
    failed ??= e
    notify()
  })
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const close = (): void => {
    signal.removeEventListener('abort', onAbort)
    if (!ended) abort()
  }
  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          if (failed) throw failed
          const c = chunks.shift()
          if (c) {
            if (paused && chunks.length <= LOW_WATER) {
              paused = false
              flow.resume?.()
            }
            yield c
            continue
          }
          if (ended) return
          await new Promise<void>((r) => {
            wake = r
          })
        }
      } finally {
        close()
      }
    },
  }
  return { body, close }
}

export const netFetch: HttpFetch = (url, headers, signal) =>
  new Promise<HttpRes>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    let settled = false
    let req: ClientRequest
    const onAbort = (): void => {
      try {
        req.abort()
      } catch {
        /* already done */
      }
      fail(abortError())
    }
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(e)
    }
    try {
      req = net.request({ url, method: 'GET', redirect: 'manual', cache: 'no-store' })
      for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    } catch (e) {
      reject(e instanceof Error ? e : new Error('request'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('redirect', (status: number, _method: string, redirectUrl: string) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      try {
        req.abort()
      } catch {
        /* already done */
      }
      resolve({ status, headers: { location: redirectUrl }, body: emptyBody })
    })
    req.on('response', (res: IncomingMessage) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      const { body, close } = bodyOf(req, res, signal)
      resolve({ status: res.statusCode, headers: lowerHeaders(res.headers), body, close })
    })
    req.on('error', (e: Error) => fail(e))
    req.end()
  })
