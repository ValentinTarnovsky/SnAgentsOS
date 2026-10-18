import * as nodeFs from 'fs'
import { createHash } from 'crypto'
import { deflateRawSync, inflateRawSync } from 'zlib'

/**
 * Minimal zip writer and reader for migration-backup-v1.zip (E0-FR-28), with
 * zlib and a table CRC32 so no dependency is added. Standard layout (local
 * headers, central directory, end record; deflate or store, UTF-8 names, no
 * zip64 since the file is capped at 20 MB), readable by the Windows Explorer
 * and by tar. manifest.json is always the first entry and lists every other
 * entry with its source path, size and SHA-256, so the file proves its own
 * contents after a write and before anything legacy is deleted.
 */

export interface BackupEntry {
  /** Path inside the zip: 'config.json', 'backups/config-...json', 'claude/settings.json.snmulticc.bak', 'dev/config.json', 'other/...', 'post-commit/<ISO>/...'. */
  name: string
  data: Buffer
  /** Where the bytes came from (absolute path), for the manifest. */
  source: string
}

export interface BackupManifest {
  v: 1
  appVersion: string
  createdAt: number
  expiresAt: number
  entries: Array<{ name: string; source: string; bytes: number; sha256: string }>
}

export const MANIFEST_NAME = 'manifest.json'
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024

type ZipFs = Pick<typeof nodeFs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** An Error with a code, so the pipeline and the cleanup log a stable reason. */
function codeError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

export function buildManifest(entries: BackupEntry[], appVersion: string, createdAt: number, expiresAt: number): BackupManifest {
  return {
    v: 1,
    appVersion,
    createdAt,
    expiresAt,
    entries: entries.map((e) => ({ name: e.name, source: e.source, bytes: e.data.length, sha256: sha256(e.data) })),
  }
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms)
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** Serializes the zip in memory (manifest first). Throws backupTooLarge over 20 MB. */
export function encodeZip(entries: BackupEntry[], manifest: BackupManifest): Buffer {
  const files = [{ name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') }, ...entries]
  const { time, date } = dosDateTime(manifest.createdAt)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8')
    const deflated = deflateRawSync(f.data)
    const stored = deflated.length >= f.data.length
    const body = stored ? f.data : deflated
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(f.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
    if (offset > MAX_BACKUP_BYTES) throw codeError('backupTooLarge')
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  const out = Buffer.concat([...locals, cd, end])
  if (out.length > MAX_BACKUP_BYTES) throw codeError('backupTooLarge')
  return out
}

/** Writes dest.tmp, then renames it over dest. Returns the final size and hash. */
export function writeBackupZip(dest: string, entries: BackupEntry[], manifest: BackupManifest, fsx: ZipFs = nodeFs): { bytes: number; sha256: string } {
  const zip = encodeZip(entries, manifest)
  const tmp = `${dest}.tmp`
  try {
    fsx.writeFileSync(tmp, zip)
    fsx.renameSync(tmp, dest)
  } catch (err) {
    fsx.rmSync(tmp, { force: true })
    throw err
  }
  return { bytes: zip.length, sha256: sha256(zip) }
}

export interface DecodedZip {
  manifest: BackupManifest
  /** Every entry except manifest.json, in file order. */
  entries: BackupEntry[]
}

/** Parses the zip from its central directory; throws on any structural or CRC error. */
export function decodeZip(zip: Buffer): DecodedZip {
  const endAt = zip.length - 22
  if (endAt < 0 || zip.readUInt32LE(endAt) !== 0x06054b50) throw codeError('backupFormat')
  const count = zip.readUInt16LE(endAt + 10)
  let p = zip.readUInt32LE(endAt + 16)
  const files: Array<{ name: string; data: Buffer }> = []
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw codeError('backupFormat')
    const method = zip.readUInt16LE(p + 10)
    const crc = zip.readUInt32LE(p + 16)
    const csize = zip.readUInt32LE(p + 20)
    const usize = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (zip.readUInt32LE(local) !== 0x04034b50) throw codeError('backupFormat')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const body = zip.subarray(start, start + csize)
    const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null
    if (!data || data.length !== usize || crc32(data) !== crc) throw codeError('backupCrc')
    files.push({ name, data })
  }
  if (files[0]?.name !== MANIFEST_NAME) throw codeError('backupFormat')
  const manifest = JSON.parse(files[0].data.toString('utf8')) as BackupManifest
  const sources = new Map(manifest.entries.map((e) => [e.name, e.source]))
  return { manifest, entries: files.slice(1).map((f) => ({ name: f.name, data: f.data, source: sources.get(f.name) ?? '' })) }
}

export function readBackupZip(path: string, fsx: ZipFs = nodeFs): DecodedZip {
  return decodeZip(fsx.readFileSync(path) as Buffer)
}

/**
 * Reopens the file and checks it entry by entry: the stored manifest equals
 * the expected one, every listed entry is there with its size and SHA-256 and
 * nothing else is. False on any difference or read error.
 */
export function verifyBackupZip(path: string, manifest: BackupManifest, fsx: ZipFs = nodeFs): boolean {
  try {
    const decoded = readBackupZip(path, fsx)
    if (JSON.stringify(decoded.manifest) !== JSON.stringify(manifest)) return false
    if (decoded.entries.length !== manifest.entries.length) return false
    return manifest.entries.every((e, i) => {
      const got = decoded.entries[i]
      return got.name === e.name && got.data.length === e.bytes && sha256(got.data) === e.sha256
    })
  } catch {
    return false
  }
}
