/**
 * Image uploads from the phone (E3-FR-06..10): the body of `POST /api/upload`
 * after RemoteServer has accepted its Host and Origin.
 *
 *  - Auth: `Authorization: Bearer <httpToken>`, checked as soon as the headers
 *    arrive (RemoteManager.resolveHttpToken, constant-time). A slow upload over
 *    4G is never cut later, even when the socket that issued the token drops.
 *  - Rate: UPLOAD_RATE_MAX accepted requests per UPLOAD_RATE_WINDOW_MS per
 *    device (429).
 *  - Type: `Content-Type` in UPLOAD_TYPES and the first bytes must match it
 *    (PNG 89 50 4E 47, JPEG FF D8 FF, WEBP RIFF....WEBP), else 415.
 *  - Size: `Content-Length` is required (411) and at most UPLOAD_MAX_BYTES
 *    (413); the stream is counted too, and going over drops the partial file.
 *  - The body streams to a `.part` file that is renamed atomically to
 *    `<dataDir>/attachments/YYYYMMDD-HHmmss-<rand8>.<png|jpg|webp>`; any failure
 *    or an aborted request removes it. The answer is `200 {path}`.
 *
 * cleanup() (at RemoteManager start and every 6h) deletes attachments older
 * than ATTACHMENT_MAX_AGE_MS, then the oldest ones while the folder is over
 * ATTACHMENT_MAX_TOTAL_BYTES. It only touches regular files (lstat, never a
 * symlink) named like ATTACHMENT_NAME_RE, plus that same name with `.part`
 * (a partial left by a crash), so nothing else a user drops there is at risk.
 */
import { randomBytes } from 'crypto'
import { createWriteStream, promises as fsp } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'
import { join } from 'path'

/** Largest accepted image (CONTRATOS: <= 10MB). */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
/** Accepted uploads per device per window. */
export const UPLOAD_RATE_MAX = 10
export const UPLOAD_RATE_WINDOW_MS = 60 * 1000
/** Attachments older than this go on the next cleanup (a constant, no config key). */
export const ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Folder cap: over it, the oldest attachments go first. */
export const ATTACHMENT_MAX_TOTAL_BYTES = 500 * 1024 * 1024
/** Cleanup period while the app runs. */
export const ATTACHMENT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
/** The only names cleanup may delete. */
export const ATTACHMENT_NAME_RE = /^\d{8}-\d{6}-[0-9a-f]{8}\.(png|jpg|webp)$/
const PARTIAL_NAME_RE = /^\d{8}-\d{6}-[0-9a-f]{8}\.(png|jpg|webp)\.part$/

/** Accepted Content-Type -> file extension. */
export const UPLOAD_TYPES: Readonly<Record<string, 'png' | 'jpg' | 'webp'>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Bytes needed to tell the three formats apart. */
const MAGIC_LEN = 12

/** True when the first bytes are a real file of the declared extension. */
export function magicMatches(ext: 'png' | 'jpg' | 'webp', head: Buffer): boolean {
  if (ext === 'png') return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  if (ext === 'jpg') return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  return head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP'
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** `YYYYMMDD-HHmmss-<rand8>.<ext>` in local time (what the user reads in the folder). */
export function attachmentName(ext: string, at: Date = new Date(), rand: string = randomBytes(4).toString('hex')): string {
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${day}-${time}-${rand}.${ext}`
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer ([^\s]+)$/i.exec(header.trim())
  return m ? m[1] : null
}

export interface UploadServiceOpts {
  /** The attachments folder (created on demand). */
  dir: () => string
  /** The device behind a Bearer token, or null (RemoteManager.resolveHttpToken). */
  resolveToken: (token: string) => { deviceId: string } | null
  now?: () => number
  /** Overrides for the tests. */
  maxBytes?: number
  maxTotalBytes?: number
}

export interface CleanupResult {
  removed: number
  keptBytes: number
}

export class UploadService {
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly maxTotalBytes: number
  /** deviceId -> start times of its accepted uploads inside the rate window. */
  private readonly recent = new Map<string, number[]>()

  constructor(private readonly opts: UploadServiceOpts) {
    this.now = opts.now ?? (() => Date.now())
    this.maxBytes = opts.maxBytes ?? UPLOAD_MAX_BYTES
    this.maxTotalBytes = opts.maxTotalBytes ?? ATTACHMENT_MAX_TOTAL_BYTES
  }

  /**
   * Handle one `POST /api/upload` whose Host and Origin RemoteServer already
   * accepted. Always answers exactly once.
   */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const token = bearerToken(req.headers.authorization)
    const owner = token ? this.opts.resolveToken(token) : null
    if (!owner) return this.reject(req, res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' })
    if (!this.takeRate(owner.deviceId)) return this.reject(req, res, 429, 'Too Many Requests', { 'Retry-After': '60' })
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    const ext = UPLOAD_TYPES[type]
    if (!ext) return this.reject(req, res, 415, 'Unsupported Media Type')
    const lengthHeader = req.headers['content-length']
    if (lengthHeader == null || !/^\d+$/.test(String(lengthHeader))) return this.reject(req, res, 411, 'Length Required')
    const declared = Number(lengthHeader)
    if (declared > this.maxBytes) return this.reject(req, res, 413, 'Payload Too Large')
    if (declared === 0) return this.reject(req, res, 415, 'Unsupported Media Type')
    void this.receive(req, res, ext)
  }

  private async receive(req: IncomingMessage, res: ServerResponse, ext: 'png' | 'jpg' | 'webp'): Promise<void> {
    const dir = this.opts.dir()
    const name = attachmentName(ext, new Date(this.now()))
    const finalPath = join(dir, name)
    const partPath = finalPath + '.part'
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch {
      return this.reject(req, res, 500, 'Internal Server Error')
    }
    // The client may have gone while the folder was being created.
    if (req.destroyed) return this.reject(req, res, 400, 'Bad Request')
    const out = createWriteStream(partPath, { flags: 'wx' })
    let received = 0
    let head = Buffer.alloc(0)
    let settled = false

    const fail = (code: number, text: string): void => {
      if (settled) return
      settled = true
      // Remove the partial once its handle is closed (Windows keeps an open
      // file listed), including a stream destroyed before it even opened.
      const drop = (): void => void fsp.rm(partPath, { force: true }).catch(() => undefined)
      out.once('close', drop)
      out.destroy()
      if (out.closed) drop()
      this.reject(req, res, code, text)
    }

    out.on('error', () => fail(500, 'Internal Server Error'))
    // A client that goes away mid-body (the X on the phone, a dead network)
    // leaves no partial behind.
    req.on('aborted', () => fail(400, 'Bad Request'))
    req.on('error', () => fail(400, 'Bad Request'))
    req.on('close', () => {
      if (!req.complete) fail(400, 'Bad Request')
    })
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.length
      if (received > this.maxBytes) return fail(413, 'Payload Too Large')
      if (head.length < MAGIC_LEN) {
        head = Buffer.concat([head, chunk.subarray(0, MAGIC_LEN - head.length)])
        if (head.length >= MAGIC_LEN && !magicMatches(ext, head)) return fail(415, 'Unsupported Media Type')
      }
      if (!out.write(chunk)) {
        req.pause()
        out.once('drain', () => req.resume())
      }
    })
    req.on('end', () => {
      if (settled) return
      if (!magicMatches(ext, head)) return fail(415, 'Unsupported Media Type')
      out.end(() => {
        if (settled) return
        fsp
          .rename(partPath, finalPath)
          .then(() => {
            if (settled) return
            settled = true
            const body = JSON.stringify({ path: finalPath })
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(body),
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            })
            res.end(body)
          })
          .catch(() => fail(500, 'Internal Server Error'))
      })
    })
  }

  /** Sliding window per device; only accepted (authed) requests count. */
  private takeRate(deviceId: string): boolean {
    const now = this.now()
    const kept = (this.recent.get(deviceId) ?? []).filter((t) => now - t < UPLOAD_RATE_WINDOW_MS && t <= now)
    if (kept.length >= UPLOAD_RATE_MAX) {
      this.recent.set(deviceId, kept)
      return false
    }
    kept.push(now)
    this.recent.set(deviceId, kept)
    return true
  }

  /**
   * Answer an error and stop reading. The connection closes after the answer,
   * so an unread body is never drained (up to 10MB for nothing).
   */
  private reject(req: IncomingMessage, res: ServerResponse, code: number, text: string, extra: Record<string, string> = {}): void {
    try {
      if (!res.headersSent) {
        res.writeHead(code, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          Connection: 'close',
          ...extra,
        })
      }
      if (!res.writableEnded) res.end(text)
    } catch {
      /* the client is already gone */
    }
    if (!req.complete) req.pause()
  }

  /**
   * Delete attachments over ATTACHMENT_MAX_AGE_MS, then the oldest while the
   * folder is over the size cap. A missing folder is not an error. Regular
   * files with an attachment name only: lstat, so a symlink is never followed
   * nor removed.
   */
  async cleanup(): Promise<CleanupResult> {
    const dir = this.opts.dir()
    let names: string[]
    try {
      names = await fsp.readdir(dir)
    } catch {
      return { removed: 0, keptBytes: 0 }
    }
    const now = this.now()
    const kept: Array<{ path: string; mtime: number; size: number }> = []
    let removed = 0
    for (const name of names) {
      const partial = PARTIAL_NAME_RE.test(name)
      if (!partial && !ATTACHMENT_NAME_RE.test(name)) continue
      const path = join(dir, name)
      let st
      try {
        st = await fsp.lstat(path)
      } catch {
        continue
      }
      if (!st.isFile() || st.isSymbolicLink()) continue
      // A partial is either in flight right now or a crash leftover: only an
      // old one goes, so an upload in progress is never pulled from under it.
      const tooOld = now - st.mtimeMs > (partial ? 24 * 60 * 60 * 1000 : ATTACHMENT_MAX_AGE_MS)
      if (tooOld) {
        if (await this.remove(path)) removed++
        continue
      }
      if (!partial) kept.push({ path, mtime: st.mtimeMs, size: st.size })
    }
    let total = kept.reduce((sum, f) => sum + f.size, 0)
    if (total > this.maxTotalBytes) {
      kept.sort((a, b) => a.mtime - b.mtime)
      for (const f of kept) {
        if (total <= this.maxTotalBytes) break
        if (await this.remove(f.path)) {
          removed++
          total -= f.size
        }
      }
    }
    return { removed, keptBytes: total }
  }

  private async remove(path: string): Promise<boolean> {
    try {
      await fsp.unlink(path)
      return true
    } catch {
      return false
    }
  }
}
