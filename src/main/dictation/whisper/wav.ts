/**
 * WAV helpers for local dictation (app 2.5.0). Pure. `pcmToWav` wraps a
 * segment for the multipart upload to whisper-server; `wavToPcm` reads a
 * PCM s16 mono file back (tests and the gated real-engine run).
 */
import { DICTATION_SAMPLE_RATE } from '@shared/dictation'

export const WAV_HEADER_BYTES = 44

/** A 44-byte RIFF header plus the samples: PCM s16 little-endian, mono. */
export function pcmToWav(pcm: Int16Array, sampleRate: number = DICTATION_SAMPLE_RATE): Buffer {
  const dataBytes = pcm.length * 2
  const buf = Buffer.alloc(WAV_HEADER_BYTES + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], WAV_HEADER_BYTES + i * 2)
  return buf
}

/**
 * The samples of a PCM s16 mono WAV at `sampleRate`, walking the chunks (a
 * LIST chunk before `data` is fine). Anything else gives null.
 */
export function wavToPcm(buf: Buffer, sampleRate: number = DICTATION_SAMPLE_RATE): Int16Array | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let fmtOk = false
  let at = 12
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return null
      fmtOk = buf.readUInt16LE(body) === 1 && buf.readUInt16LE(body + 2) === 1 && buf.readUInt32LE(body + 4) === sampleRate && buf.readUInt16LE(body + 14) === 16
      if (!fmtOk) return null
    } else if (id === 'data') {
      if (!fmtOk) return null
      const end = Math.min(buf.length, body + size)
      const n = Math.floor((end - body) / 2)
      const out = new Int16Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2)
      return out
    }
    at = body + size + (size % 2)
  }
  return null
}
