/**
 * Share secure channel (app 2.4.0, item 8): the app-layer encryption every
 * share connection runs over, whatever carries it (LAN or Tailscale today, a
 * relay later). Probed in Electron 33 main (Node 20.18, BoringSSL): X25519,
 * HKDF-SHA256, AES-256-GCM and scrypt with maxmem all exist, so there is no
 * P-256 fallback.
 *
 * Handshake (the host's static key is pinned by the invite, the guest has a
 * static key of its own, so "known guest" is a key, never a claimed id):
 *   hs1  guest -> host  { e: guestEph, s: seal(guestStatic) under DH(guestEph, hostStatic) }
 *   hs2  host -> guest  { e: hostEph }, then a sealed { t: 'ready' }
 *   dh1 = DH(guestEph, hostEph), dh2 = DH(hostStatic, guestEph), dh3 = DH(hostEph, guestStatic)
 *   h   = SHA-256(label | guestEph | hostEph | hostStatic | guestStatic | version)
 *   kG2H | kH2G = HKDF-SHA256(dh1 | dh2 | dh3, salt = h, info = label keys, 64)
 * Only the real host can compute dh2 (a wrong pinned key fails the guest's
 * `ready`), only the holder of the guest static key can compute dh3 (its
 * first sealed frame fails on the host otherwise). `h` binds the channel:
 * the invite, ticket and password proofs are HMACs over it.
 *
 * Records: AES-256-GCM, nonce = 4 zero bytes + 8-byte big-endian counter per
 * direction, capped at 2^48 (implicit, so a replayed, dropped or reordered record fails the
 * tag), AAD = the direction byte. A failed record kills the channel.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type KeyObject,
} from 'crypto'
import {
  SHARE_MIN_VERSION,
  SHARE_PROTOCOL_VERSION,
  SHARE_CLOSE,
  SHARE_SCRYPT,
  type ShareHs1,
  type ShareHs2,
  type ShareHsErr,
} from '@shared/share-protocol'
import { parseShareHandshake } from '@shared/share-protocol-schemas'

const LABEL = 'snaos-share/1'
const DIR_G2H = 0x01
const DIR_H2G = 0x02
const TAG_LEN = 16
/** Records per direction before the channel refuses to go on (far past any session). */
const MAX_COUNTER = 2 ** 48

// --- Encoding helpers ---

/** Canonical base64url without padding. */
export function toB64u(buf: Buffer): string {
  return buf.toString('base64url')
}

/** Strict base64url decode: canonical text of exactly `bytes` bytes, else null. */
export function fromB64u(text: unknown, bytes: number): Buffer | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null
  const buf = Buffer.from(text, 'base64url')
  if (buf.length !== bytes || buf.toString('base64url') !== text) return null
  return buf
}

export function randomB64u(bytes: number): string {
  return toB64u(randomBytes(bytes))
}

/** Constant-time equality of two buffers of any length. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

// --- Keys ---

export interface ShareKeyPair {
  /** Raw X25519 public key, 32 bytes. */
  pub: Buffer
  priv: KeyObject
}

function rawPub(key: KeyObject): Buffer {
  const x = key.export({ format: 'jwk' }).x
  const buf = fromB64u(x, 32)
  if (!buf) throw new Error('x25519 export')
  return buf
}

export function generateShareKeyPair(): ShareKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { pub: rawPub(publicKey), priv: privateKey }
}

export function exportShareKey(pair: ShareKeyPair): Buffer {
  return privateKeyDer(pair.priv)
}

function privateKeyDer(priv: KeyObject): Buffer {
  return priv.export({ format: 'der', type: 'pkcs8' }) as Buffer
}

/** A key pair back from its PKCS#8 DER; throws when it is not an X25519 key. */
export function importShareKey(der: Buffer): ShareKeyPair {
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  if (priv.asymmetricKeyType !== 'x25519') throw new Error('not an x25519 key')
  return { pub: rawPub(createPublicKey(priv)), priv }
}

/** A raw 32-byte X25519 public key as a KeyObject; throws on a bad length or the all-zero key. */
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32 || raw.every((b) => b === 0)) throw new Error('bad x25519 public key')
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: toB64u(raw) }, format: 'jwk' })
}

/** Short human-comparable fingerprint of a public key: `AB12-CD34-EF56-7890`. */
export function keyFingerprint(pub: Buffer): string {
  const hex = createHash('sha256').update(LABEL).update(pub).digest('hex').slice(0, 16).toUpperCase()
  return hex.match(/.{4}/g)!.join('-')
}

function dh(priv: KeyObject, peerRaw: Buffer): Buffer {
  const out = diffieHellman({ privateKey: priv, publicKey: publicKeyFromRaw(peerRaw) })
  if (out.length !== 32 || out.every((b) => b === 0)) throw new Error('low-order point')
  return out
}

// --- Records ---

function nonce(counter: number): Buffer {
  const n = Buffer.alloc(12)
  n.writeUIntBE(counter, 6, 6)
  return n
}

function sealWith(key: Buffer, iv: Buffer, aad: Buffer, plain: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN })
  c.setAAD(aad)
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
}

function openWith(key: Buffer, iv: Buffer, aad: Buffer, frame: Buffer): Buffer | null {
  if (frame.length < TAG_LEN) return null
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN })
    d.setAAD(aad)
    d.setAuthTag(frame.subarray(frame.length - TAG_LEN))
    return Buffer.concat([d.update(frame.subarray(0, frame.length - TAG_LEN)), d.final()])
  } catch {
    return null
  }
}

/** One established channel end: seal outgoing records, open incoming ones in order. */
export class SecureChannel {
  private sendCounter = 0
  private recvCounter = 0
  private dead = false

  constructor(
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
    private readonly sendDir: number,
    /** Channel binding: every proof is an HMAC over it. */
    readonly h: Buffer,
    /** Negotiated SHARE_PROTOCOL_VERSION. */
    readonly version: number,
    /** The peer's static public key (the host's on a guest, the guest's on a host). */
    readonly peerStatic: Buffer,
  ) {}

  /** True after a record failed to open or a counter ran out: the connection must close (4400). */
  get failed(): boolean {
    return this.dead
  }

  seal(message: string | object): Buffer {
    if (this.dead || this.sendCounter >= MAX_COUNTER) throw new Error('channel closed')
    const text = typeof message === 'string' ? message : JSON.stringify(message)
    return sealWith(this.sendKey, nonce(this.sendCounter++), Buffer.from([this.sendDir]), Buffer.from(text, 'utf8'))
  }

  /** The UTF-8 text of the next record, or null (and the channel is dead) when it does not authenticate. */
  open(frame: Buffer): string | null {
    if (this.dead) return null
    if (this.recvCounter >= MAX_COUNTER) {
      this.dead = true
      return null
    }
    const recvDir = this.sendDir === DIR_G2H ? DIR_H2G : DIR_G2H
    const plain = openWith(this.recvKey, nonce(this.recvCounter), Buffer.from([recvDir]), frame)
    if (!plain) {
      this.dead = true
      return null
    }
    this.recvCounter++
    return plain.toString('utf8')
  }
}

// --- Handshake ---

function transcript(guestEph: Buffer, hostEph: Buffer, hostStatic: Buffer, guestStatic: Buffer, version: number): Buffer {
  return createHash('sha256')
    .update(LABEL)
    .update(Buffer.from([0]))
    .update(guestEph)
    .update(hostEph)
    .update(hostStatic)
    .update(guestStatic)
    .update(Buffer.from([version & 0xff, (version >> 8) & 0xff]))
    .digest()
}

function deriveKeys(dh1: Buffer, dh2: Buffer, dh3: Buffer, h: Buffer): { g2h: Buffer; h2g: Buffer } {
  const okm = Buffer.from(hkdfSync('sha256', Buffer.concat([dh1, dh2, dh3]), h, `${LABEL} keys`, 64))
  return { g2h: okm.subarray(0, 32), h2g: okm.subarray(32, 64) }
}

/** The one-shot key that seals the guest static key in hs1 (only the pinned host can open it). */
function hs1Key(es: Buffer, guestEph: Buffer, hostStatic: Buffer): Buffer {
  const salt = createHash('sha256').update(LABEL).update('hs1').update(guestEph).update(hostStatic).digest()
  return Buffer.from(hkdfSync('sha256', es, salt, `${LABEL} hs1`, 32))
}
const HS1_AAD = Buffer.from('hs1')

/** The version both ends speak, or null. */
function negotiate(peerMin: number, peerMax: number, min: number, max: number): number | null {
  const v = Math.min(peerMax, max)
  return v >= Math.max(peerMin, min) ? v : null
}

export interface GuestHandshakeOpts {
  /** The host's static key from the invite (pinned). */
  hostStatic: Buffer
  guestStatic: ShareKeyPair
  minVersion?: number
  maxVersion?: number
}

export type GuestHandshakeResult =
  | { ok: true; channel: SecureChannel }
  /** No common version: the host's range, to show "update SnAgentsOS". */
  | { ok: false; error: 'version'; min: number; max: number; app?: string }
  | { ok: false; error: 'bad_msg' }

/** Guest end: `hello()` gives hs1, `receive(hs2)` the channel; then `confirmReady` on the first record. */
export class GuestHandshake {
  private readonly eph = generateShareKeyPair()
  private readonly min: number
  private readonly max: number

  constructor(private readonly opts: GuestHandshakeOpts) {
    this.min = opts.minVersion ?? SHARE_MIN_VERSION
    this.max = opts.maxVersion ?? SHARE_PROTOCOL_VERSION
    publicKeyFromRaw(opts.hostStatic) // throws early on a bad pinned key
  }

  hello(): string {
    const key = hs1Key(dh(this.eph.priv, this.opts.hostStatic), this.eph.pub, this.opts.hostStatic)
    const sealed = sealWith(key, nonce(0), HS1_AAD, this.opts.guestStatic.pub)
    const msg: ShareHs1 = { t: 'hs1', sv: this.max, min: this.min, e: toB64u(this.eph.pub), s: toB64u(sealed) }
    return JSON.stringify(msg)
  }

  receive(raw: unknown): GuestHandshakeResult {
    const msg = parseShareHandshake(raw)
    if (!msg || msg.t === 'hs1') return { ok: false, error: 'bad_msg' }
    if (msg.t === 'hsErr') {
      return msg.code === 'version' ? { ok: false, error: 'version', min: msg.min, max: msg.max, app: msg.app } : { ok: false, error: 'bad_msg' }
    }
    if (msg.sv < this.min || msg.sv > this.max) return { ok: false, error: 'version', min: msg.sv, max: msg.sv }
    const hostEph = fromB64u(msg.e, 32)
    if (!hostEph) return { ok: false, error: 'bad_msg' }
    try {
      const dh1 = dh(this.eph.priv, hostEph)
      const dh2 = dh(this.eph.priv, this.opts.hostStatic)
      const dh3 = dh(this.opts.guestStatic.priv, hostEph)
      const h = transcript(this.eph.pub, hostEph, this.opts.hostStatic, this.opts.guestStatic.pub, msg.sv)
      const k = deriveKeys(dh1, dh2, dh3, h)
      return { ok: true, channel: new SecureChannel(k.g2h, k.h2g, DIR_G2H, h, msg.sv, Buffer.from(this.opts.hostStatic)) }
    } catch {
      return { ok: false, error: 'bad_msg' }
    }
  }

  /**
   * True when the host's first record is a sealed `ready`. False means the
   * host does not hold the pinned key (`identity_mismatch`): the guest stops
   * and never reconnects on its own.
   */
  static confirmReady(channel: SecureChannel, frame: Buffer): boolean {
    const text = channel.open(frame)
    if (text === null) return false
    try {
      const msg = JSON.parse(text) as { t?: unknown }
      return msg?.t === 'ready' && Object.keys(msg).length === 1
    } catch {
      return false
    }
  }
}

export interface HostHandshakeOpts {
  hostStatic: ShareKeyPair
  minVersion?: number
  maxVersion?: number
  /** App version for the hsErr of a version mismatch. */
  app?: string
}

export type HostHandshakeResult =
  /** Send `reply` (text) then `ready` (binary); the guest is authenticated by its first record. */
  | { ok: true; reply: string; ready: Buffer; channel: SecureChannel; guestStatic: Buffer; version: number }
  /** Send `reply` when present, then close with `close`. */
  | { ok: false; error: 'version' | 'bad_msg'; reply?: string; close: number }

/** Host end: one hs1 in, the hs2 + sealed ready out, or the close to apply. */
export function hostHandshake(raw: unknown, opts: HostHandshakeOpts): HostHandshakeResult {
  const min = opts.minVersion ?? SHARE_MIN_VERSION
  const max = opts.maxVersion ?? SHARE_PROTOCOL_VERSION
  const msg = parseShareHandshake(raw)
  if (!msg || msg.t !== 'hs1') return { ok: false, error: 'bad_msg', close: SHARE_CLOSE.BAD_MSG }
  const version = negotiate(msg.min, msg.sv, min, max)
  if (version === null) {
    const err: ShareHsErr = { t: 'hsErr', code: 'version', min, max, ...(opts.app ? { app: opts.app.slice(0, 32) } : {}) }
    return { ok: false, error: 'version', reply: JSON.stringify(err), close: SHARE_CLOSE.VERSION }
  }
  const guestEph = fromB64u(msg.e, 32)
  const sealed = fromB64u(msg.s, 32 + TAG_LEN)
  if (!guestEph || !sealed) return { ok: false, error: 'bad_msg', close: SHARE_CLOSE.BAD_MSG }
  try {
    const hostPub = opts.hostStatic.pub
    const guestStatic = openWith(hs1Key(dh(opts.hostStatic.priv, guestEph), guestEph, hostPub), nonce(0), HS1_AAD, sealed)
    if (!guestStatic || guestStatic.length !== 32) return { ok: false, error: 'bad_msg', close: SHARE_CLOSE.BAD_MSG }
    const eph = generateShareKeyPair()
    const dh1 = dh(eph.priv, guestEph)
    const dh2 = dh(opts.hostStatic.priv, guestEph)
    const dh3 = dh(eph.priv, guestStatic)
    const h = transcript(guestEph, eph.pub, hostPub, guestStatic, version)
    const k = deriveKeys(dh1, dh2, dh3, h)
    const channel = new SecureChannel(k.h2g, k.g2h, DIR_H2G, h, version, guestStatic)
    const hs2: ShareHs2 = { t: 'hs2', sv: version, e: toB64u(eph.pub) }
    return { ok: true, reply: JSON.stringify(hs2), ready: channel.seal({ t: 'ready' }), channel, guestStatic, version }
  } catch {
    return { ok: false, error: 'bad_msg', close: SHARE_CLOSE.BAD_MSG }
  }
}

// --- Proofs, tickets and the unattended password ---

export type ShareProofLabel = 'join' | 'pw'

/** HMAC-SHA256(key, label | 0 | h) as base64url (43 chars). */
export function shareProof(key: Buffer, label: ShareProofLabel, h: Buffer): string {
  return toB64u(createHmac('sha256', key).update(label).update(Buffer.from([0])).update(h).digest())
}

export function verifyShareProof(key: Buffer, label: ShareProofLabel, h: Buffer, proof: unknown): boolean {
  const got = fromB64u(proof, 32)
  if (!got) return false
  return safeEqual(Buffer.from(shareProof(key, label, h), 'base64url'), got)
}

/** Constant-time comparison of two base64url tokens (tickets). */
export function sameToken(a: string, b: unknown): boolean {
  return typeof b === 'string' && safeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export function newPasswordSalt(): Buffer {
  return randomBytes(16)
}

/**
 * The password key both ends derive (scrypt N=2^15, r=8, p=1, 32 bytes).
 * The host stores only this key (DPAPI-sealed) and verifies an HMAC with it,
 * so a guest guessing online costs the host no scrypt. Async: never blocks main.
 */
export function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password.normalize('NFC'), 'utf8'),
      salt,
      SHARE_SCRYPT.keyLen,
      { N: SHARE_SCRYPT.N, r: SHARE_SCRYPT.r, p: SHARE_SCRYPT.p, maxmem: SHARE_SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}
