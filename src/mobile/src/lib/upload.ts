/**
 * Image from the phone (E3-FR-07, 08): decode, downscale and upload.
 *
 *  - prepareImage: decode with createImageBitmap (fallback: an <img> on an
 *    object URL, which is what decodes HEIC on iOS), scale to IMAGE_MAX_SIDE on
 *    the long side and re-encode on an OffscreenCanvas (fallback: a DOM
 *    canvas). A PNG source stays PNG, so screenshots keep their text sharp;
 *    anything else, HEIC included, becomes JPEG_QUALITY JPEG. Over
 *    UPLOAD_MAX_BYTES it retries once as JPEG_RETRY_QUALITY JPEG, then gives up
 *    with 'tooBig'. Re-encoding also drops the photo's EXIF (GPS included).
 *  - uploadImage: XMLHttpRequest POST to /api/upload with the raw body, the
 *    image mime and `Authorization: Bearer <httpToken>`, reporting progress and
 *    aborting on the signal. A 401 (token gone with a reconnect or a
 *    revocation) retries once with the token of the next authOk.
 *
 * Free of React, the store and the socket; the DOM pieces are injectable so
 * the sizing and the request rules run under Node in the tests.
 */

/** The server's cap (CONTRATOS: <= 10MB). */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const IMAGE_MAX_SIDE = 2000
export const JPEG_QUALITY = 0.85
export const JPEG_RETRY_QUALITY = 0.7
export const UPLOAD_PATH = '/api/upload'
/** How long a 401 waits for the next authOk's token before failing. */
export const TOKEN_WAIT_MS = 15 * 1000

export type UploadMime = 'image/png' | 'image/jpeg'

export type UploadErrorCode = 'tooBig' | 'decode' | 'auth' | 'rate' | 'type' | 'network' | 'server' | 'aborted'

export class UploadError extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(code)
    this.name = 'UploadError'
  }
}

/** Fit (width, height) inside max on the long side, never upscaling. */
export function fitSize(width: number, height: number, max: number = IMAGE_MAX_SIDE): { width: number; height: number } {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const long = Math.max(w, h)
  if (long <= max) return { width: w, height: h }
  const scale = max / long
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/** PNG stays PNG; everything else (JPEG, HEIC, WEBP, GIF...) goes JPEG. */
export function outputMime(sourceType: string): UploadMime {
  return sourceType.toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg'
}

/** What lands in the console: the path in double quotes plus a space (E3-FR-09). */
export function attachmentRef(path: string): string {
  return `"${path}" `
}

/**
 * The draft with the reference appended, a space apart from any text before
 * it; null when it would not fit in max characters.
 */
export function appendRef(draft: string, ref: string, max: number): string | null {
  const sep = draft.length && !/\s$/.test(draft) ? ' ' : ''
  const next = draft + sep + ref
  return next.length > max ? null : next
}

// --- decode + downscale ------------------------------------------------------

/** A decoded image that can be drawn on a canvas. */
interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  close(): void
}

async function decodeImage(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
    } catch {
      /* the browser cannot decode it this way (HEIC on iOS): try an <img> */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new UploadError('decode'))
      img.src = url
    })
    if (!img.naturalWidth || !img.naturalHeight) throw new UploadError('decode')
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err instanceof UploadError ? err : new UploadError('decode')
  }
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const c = new OffscreenCanvas(width, height)
      if (typeof c.convertToBlob === 'function') return c
    } catch {
      /* fall back to the DOM canvas */
    }
  }
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

function encode(canvas: AnyCanvas, type: UploadMime, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new UploadError('decode'))), type, quality)
  })
}

export interface PreparedImage {
  blob: Blob
  type: UploadMime
  width: number
  height: number
}

/**
 * Decode, downscale and re-encode a picked image (E3-FR-07). Rejects with an
 * UploadError: 'decode' when the browser cannot read it, 'tooBig' when even
 * the retry is over UPLOAD_MAX_BYTES.
 */
export async function prepareImage(file: Blob, maxBytes: number = UPLOAD_MAX_BYTES): Promise<PreparedImage> {
  const decoded = await decodeImage(file)
  try {
    const { width, height } = fitSize(decoded.width, decoded.height)
    const canvas = makeCanvas(width, height)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) throw new UploadError('decode')
    const draw = (opaque: boolean): void => {
      ctx.clearRect(0, 0, width, height)
      // JPEG has no alpha: a transparent source would turn black.
      if (opaque) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)
      }
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(decoded.source, 0, 0, width, height)
    }
    const type = outputMime(file.type)
    draw(type === 'image/jpeg')
    let blob = await encode(canvas, type, JPEG_QUALITY)
    if (blob.size > maxBytes) {
      if (type === 'image/png') draw(true)
      blob = await encode(canvas, 'image/jpeg', JPEG_RETRY_QUALITY)
      if (blob.size > maxBytes) throw new UploadError('tooBig')
      return { blob, type: 'image/jpeg', width, height }
    }
    return { blob, type, width, height }
  } finally {
    decoded.close()
  }
}

// --- upload ------------------------------------------------------------------

/** The subset of XMLHttpRequest the upload uses (a fake in the tests). */
export interface UploadXhr {
  status: number
  responseText: string
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  ontimeout: (() => void) | null
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: Blob): void
  abort(): void
}

export interface UploadOpts {
  /** The current httpToken (null: not connected). */
  token: () => string | null
  /** After a 401: resolves with the next authOk's token, or null after TOKEN_WAIT_MS. */
  waitForNewToken: (used: string) => Promise<string | null>
  /** 0..100. */
  onProgress?: (percent: number) => void
  signal: AbortSignal
  createXhr?: () => UploadXhr
}

/** HTTP status -> error code. */
export function statusError(status: number): UploadErrorCode {
  if (status === 401) return 'auth'
  if (status === 413) return 'tooBig'
  if (status === 415) return 'type'
  if (status === 429) return 'rate'
  if (status === 0) return 'network'
  return 'server'
}

function sendOnce(blob: Blob, type: UploadMime, token: string, opts: UploadOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new UploadError('aborted'))
    const xhr = opts.createXhr ? opts.createXhr() : (new XMLHttpRequest() as unknown as UploadXhr)
    const onAbort = (): void => xhr.abort()
    const done = (): void => opts.signal.removeEventListener('abort', onAbort)
    xhr.open('POST', UPLOAD_PATH)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', type)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(100, Math.floor((e.loaded / e.total) * 100)))
    }
    xhr.onload = () => {
      done()
      if (xhr.status !== 200) return reject(new UploadError(statusError(xhr.status)))
      try {
        const body: unknown = JSON.parse(xhr.responseText)
        const path = body && typeof body === 'object' ? (body as { path?: unknown }).path : null
        if (typeof path === 'string' && path) return resolve(path)
      } catch {
        /* not JSON */
      }
      reject(new UploadError('server'))
    }
    xhr.onerror = () => {
      done()
      reject(new UploadError('network'))
    }
    xhr.ontimeout = xhr.onerror
    xhr.onabort = () => {
      done()
      reject(new UploadError('aborted'))
    }
    opts.signal.addEventListener('abort', onAbort)
    xhr.send(blob)
  })
}

/**
 * Upload a prepared image; resolves with the PC-side path. A 401 retries once
 * with the next authOk's token (the WS reconnected or the token was renewed).
 */
export async function uploadImage(blob: Blob, type: UploadMime, opts: UploadOpts): Promise<string> {
  const first = opts.token()
  if (!first) throw new UploadError('auth')
  try {
    return await sendOnce(blob, type, first, opts)
  } catch (err) {
    if (!(err instanceof UploadError) || err.code !== 'auth' || opts.signal.aborted) throw err
  }
  const current = opts.token()
  const next = current && current !== first ? current : await opts.waitForNewToken(first)
  if (opts.signal.aborted) throw new UploadError('aborted')
  if (!next || next === first) throw new UploadError('auth')
  opts.onProgress?.(0)
  return sendOnce(blob, type, next, opts)
}
