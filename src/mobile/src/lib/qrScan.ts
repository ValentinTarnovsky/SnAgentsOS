/**
 * QR ingestion helpers for the in-app pairing scanner. The desktop QR encodes
 * `http://<ip>:<port>/#pair=CODE`; scanning from inside the app only needs the
 * CODE because the phone always connects to its own origin (location.host).
 * The same parser also accepts a bare 8-char code for the manual-entry field.
 */
import jsQR from 'jsqr'

export const PAIR_CODE_LENGTH = 8

/** Extract a pairing code from scanned QR text or manual input, or null. */
export function extractPairCode(text: string): string | null {
  const m = text.match(/[#&?]pair=([^&\s]+)/i)
  let raw: string
  try {
    raw = m ? decodeURIComponent(m[1]) : text
  } catch {
    raw = m ? m[1] : text
  }
  raw = raw.trim().toUpperCase()
  return raw.length === PAIR_CODE_LENGTH && /^[A-Z0-9]+$/.test(raw) ? raw : null
}

/** Decode a QR from the center square of a playing video element, or null. */
export function decodeQrFromVideo(video: HTMLVideoElement, canvas: HTMLCanvasElement): string | null {
  if (video.readyState < 2 || video.videoWidth === 0) return null
  const side = Math.min(video.videoWidth, video.videoHeight)
  const sx = (video.videoWidth - side) / 2
  const sy = (video.videoHeight - side) / 2
  // 400px keeps jsQR fast (~10ms) while leaving plenty of pixels per module.
  const target = 400
  canvas.width = target
  canvas.height = target
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, sx, sy, side, side, 0, 0, target, target)
  const img = ctx.getImageData(0, 0, target, target)
  const hit = jsQR(img.data, target, target, { inversionAttempts: 'dontInvert' })
  return hit && hit.data ? hit.data : null
}

/**
 * Decode a QR from a photo file. This is the native-camera fallback for http
 * origins where getUserMedia does not exist (insecure context): an
 * <input capture> photo still works there. Tries a few downscales: small is
 * faster and often MORE reliable for a photo of a screen (averages out moire),
 * large catches shots taken from further away.
 */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image load failed'))
      el.src = url
    })
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    for (const max of [640, 1024, 1600]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.max(1, Math.round(img.naturalWidth * scale))
      const h = Math.max(1, Math.round(img.naturalHeight * scale))
      canvas.width = w
      canvas.height = h
      ctx.drawImage(img, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h)
      const hit = jsQR(data.data, w, h)
      if (hit && hit.data) return hit.data
      if (scale === 1) break
    }
    return null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
