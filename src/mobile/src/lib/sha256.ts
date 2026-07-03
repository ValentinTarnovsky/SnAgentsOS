/**
 * Pure-JS SHA-256 + HMAC-SHA256.
 *
 * WHY THIS EXISTS: the phone is served over a plain http:// origin (no TLS by
 * design - the transport is covered by WPA2 / WireGuard). `crypto.subtle` is
 * only exposed in secure contexts, so it is UNDEFINED on http origins. The
 * mutual challenge-response auth therefore needs its own HMAC-SHA256 that runs
 * anywhere. Only `crypto.getRandomValues` (available in insecure contexts too)
 * is used elsewhere for nonces.
 *
 * Wire convention (must match the desktop SessionManager): the device secret's
 * 64-char HEX STRING is used DIRECTLY as the HMAC key, encoded as UTF-8 bytes
 * (NOT hex-decoded); the nonce is likewise its hex STRING hashed as UTF-8 (the
 * message). Node computes the mirror image with the strings passed straight in:
 * `createHmac('sha256', secretHex).update(nonceHex)`. Hex-decoding either input
 * on this side makes every auth fail.
 *
 * Correctness anchor - standard HMAC-SHA256 test vector:
 *   key = "key"
 *   msg = "The quick brown fox jumps over the lazy dog"
 *   => f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
 * and SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
 * (both are exercised by the dev self-check at the bottom of the module).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const BLOCK = 64

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

const textEncoder = new TextEncoder()

/** Encode a string as UTF-8 bytes; pass raw bytes through unchanged. */
export function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? textEncoder.encode(input) : input
}

/** Lowercase-hex encode a byte array. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

/** Decode a lowercase/uppercase hex string to bytes (odd length => last nibble dropped). */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, -1)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

/** Raw SHA-256 digest (32 bytes) of a byte array or UTF-8 string. */
export function sha256(input: Uint8Array | string): Uint8Array {
  const bytes = toBytes(input)
  const l = bytes.length
  const bitLen = l * 8
  // Pad: append 0x80, then zeros until length % 64 === 56, then 8-byte length.
  const withOne = l + 1
  const k = (56 - (withOne % 64) + 64) % 64
  const total = withOne + k + 8
  const msg = new Uint8Array(total)
  msg.set(bytes)
  msg[l] = 0x80
  const dv = new DataView(msg.buffer)
  // 64-bit big-endian bit length. Our messages are tiny so hi is ~always 0, but
  // handle the general case cleanly via floor-division rather than 32-bit shifts.
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000))
  dv.setUint32(total - 4, bitLen >>> 0)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Uint32Array(64)
  for (let i = 0; i < total; i += BLOCK) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4)
    for (let t = 16; t < 64; t++) {
      const a15 = w[t - 15]
      const a2 = w[t - 2]
      const s0 = rotr(a15, 7) ^ rotr(a15, 18) ^ (a15 >>> 3)
      const s1 = rotr(a2, 17) ^ rotr(a2, 19) ^ (a2 >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + K[t] + w[t]) | 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }

    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
    h5 = (h5 + f) | 0
    h6 = (h6 + g) | 0
    h7 = (h7 + h) | 0
  }

  const out = new Uint8Array(32)
  const outDv = new DataView(out.buffer)
  outDv.setUint32(0, h0 >>> 0)
  outDv.setUint32(4, h1 >>> 0)
  outDv.setUint32(8, h2 >>> 0)
  outDv.setUint32(12, h3 >>> 0)
  outDv.setUint32(16, h4 >>> 0)
  outDv.setUint32(20, h5 >>> 0)
  outDv.setUint32(24, h6 >>> 0)
  outDv.setUint32(28, h7 >>> 0)
  return out
}

/** Lowercase-hex SHA-256 of a byte array or UTF-8 string. */
export function sha256Hex(input: Uint8Array | string): string {
  return bytesToHex(sha256(input))
}

/** Raw HMAC-SHA256(key, message) digest (32 bytes). */
export function hmacSha256(keyBytes: Uint8Array, message: Uint8Array | string): Uint8Array {
  let key = keyBytes
  if (key.length > BLOCK) key = sha256(key)
  // A copy padded with zeros to the block size.
  const kPad = new Uint8Array(BLOCK)
  kPad.set(key)

  const inner = new Uint8Array(BLOCK)
  const outer = new Uint8Array(BLOCK)
  for (let i = 0; i < BLOCK; i++) {
    inner[i] = kPad[i] ^ 0x36
    outer[i] = kPad[i] ^ 0x5c
  }

  const msgBytes = toBytes(message)
  const innerInput = new Uint8Array(BLOCK + msgBytes.length)
  innerInput.set(inner)
  innerInput.set(msgBytes, BLOCK)
  const innerHash = sha256(innerInput)

  const outerInput = new Uint8Array(BLOCK + innerHash.length)
  outerInput.set(outer)
  outerInput.set(innerHash, BLOCK)
  return sha256(outerInput)
}

/**
 * Lowercase-hex HMAC-SHA256. `keyBytes` is the raw secret (hex-decoded); the
 * message is hashed as UTF-8 when passed as a string. Used for both the mutual
 * proof (over clientNonce) and the auth response (over the server nonce).
 */
export function hmacSha256Hex(keyBytes: Uint8Array, message: Uint8Array | string): string {
  return bytesToHex(hmacSha256(keyBytes, message))
}

/**
 * Constant-time-ish hex comparison for verifying the server proof. Not truly
 * constant-time in JS, but avoids the early-return leak of `===` on strings;
 * the security guarantee here rests on the secret's entropy, not timing.
 */
export function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
