/**
 * Local Whisper packs (app 2.5.0): download, verify, extract and remove the
 * assets of `catalog.ts` under `<dataDir>/whisper`. No Electron import: the
 * network goes through `deps.fetch` (production: `netFetch.ts` over Electron
 * `net`, proxy aware), so the esbuild + vm suite drives it with a fake.
 *
 * - One install or removal at a time; a second one answers `busy`.
 * - Downloads land in `downloads/<id>.part`, hashed (SHA-256) while streaming
 *   and resumed with `Range` after a cancel or a dropped connection.
 * - Redirects are followed by hand: `new URL(location, current)`, https only
 *   and `isAllowedDownloadHost` on every hop, `Range` sent on every hop.
 * - Zips are extracted by `tar.exe` (absolute path, arguments only) into a
 *   `<target>.tmp-<rand>` folder, checked member by member and renamed into
 *   place, retrying EPERM / EBUSY (Defender scanning fresh DLLs).
 * - `installed.json` is written atomically after every asset.
 * - The log gets codes and numbers only: never a URL, a path or a header.
 */
import { createHash, randomBytes, type Hash } from 'crypto'
import { spawn } from 'child_process'
import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { dirname, join, win32 } from 'path'
import { writeAtomic } from '../../fsAtomic'
import type { WhisperInstallError, WhisperInstallPhase, WhisperInstallProgress, WhisperPackInfo, WhisperStatus } from '@shared/dictation'
import { ASSETS, EXTRACT_BYTES, PACKS, PACK_IDS, isAllowedDownloadHost, type AssetId, type WhisperAsset, type WhisperPackId } from './catalog'

/** Socket idle limit: no response or no body bytes for this long fails with `network`. */
export const DOWNLOAD_TIMEOUT_MS = 60_000
export const MAX_REDIRECTS = 5
export const PROGRESS_THROTTLE_MS = 250
/** Free space kept on top of what an install needs. */
export const DISK_MARGIN_BYTES = 200_000_000
/** tar.exe is killed after this long (the CUDA zip takes seconds). */
export const EXTRACT_TIMEOUT_MS = 10 * 60_000
/** Backoff for rename / rm on EPERM, EBUSY, EACCES and ENOTEMPTY (Defender, a dying server). */
export const FS_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000, 2000, 3000]

const INSTALLED_FILE = 'installed.json'
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

/** One response of `deps.fetch`. Header names are lower case. */
export interface HttpRes {
  status: number
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
  /** Drops a response whose body is not read (a redirect, an error status). */
  close?: () => void
}

/**
 * One GET, never following redirects itself (a 3xx comes back with its
 * `location`). The signal aborts the request and the body iteration.
 */
export type HttpFetch = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<HttpRes>

/** Extracts `members` of `zip` into `dest`, stripping the first path component. */
export type ExtractFn = (zip: string, dest: string, members: readonly string[], signal: AbortSignal) => Promise<void>

export interface InstallerDeps {
  /** `whisperDir(dataDir())`, absolute. */
  dir: string
  fetch: HttpFetch
  extract: ExtractFn
  /** Free bytes on the volume of `dir` (production: `statfsFreeBytes`). */
  freeBytes: (dir: string) => Promise<number>
  /** GPU packs only: starts the CUDA server once to pay the PTX JIT. False on failure. */
  warmup: (pack: WhisperPackId) => Promise<boolean>
  emit: (p: WhisperInstallProgress) => void
  log: (line: string) => void
  platform: NodeJS.Platform
  /** Defaults to `process.arch`; anything but x64 is `unsupported`. */
  arch?: string
  now?: () => number
  /** Tests only. */
  idleTimeoutMs?: number
  fsRetryDelaysMs?: readonly number[]
  catalog?: { assets: Readonly<Record<AssetId, WhisperAsset>>; packs: Readonly<Record<WhisperPackId, readonly AssetId[]>> }
}

/** What `remove` needs from the service. */
export interface RemoveGuard {
  /** A dictation session is running: removal answers `busy`. */
  inUse: () => boolean
  /** Kills an idle server (and an orphan) and resolves once it exited, so its DLLs are unlocked. */
  awaitExit?: () => Promise<void>
}

export interface InstallResult {
  ok: boolean
  error?: WhisperInstallError
}

interface InstalledRecord {
  version: 1
  assets: Partial<Record<AssetId, { sha256: string; bytes: number; diskBytes: number; at: number }>>
}

class InstallFail extends Error {
  constructor(
    readonly code: WhisperInstallError,
    readonly detail = '',
  ) {
    super(code)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function errCode(err: unknown): string {
  return err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : ''
}

/** Runs a file operation, retrying the transient Windows lock errors with backoff. */
export async function withFsRetry<T>(op: () => Promise<T>, delays: readonly number[] = FS_RETRY_DELAYS_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await op()
    } catch (err) {
      if (i >= delays.length || !RETRY_CODES.has(errCode(err))) throw err
      await sleep(delays[i])
    }
  }
}

/** `bytes N-M/T` -> N; null when absent or malformed. */
export function contentRangeStart(v: string | undefined): number | null {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(v ?? '')
  return m ? Number(m[1]) : null
}

/** The basename of a zip member once `--strip-components 1` drops its first folder. */
export function strippedMember(member: string): string {
  return member.split('/').slice(1).join('/')
}

function statSync(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/** A promise that rejects after `ms` of waiting or when `signal` aborts; the timer never outlives it. */
function guarded<T>(p: Promise<T>, ms: number, signal: AbortSignal, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const finish = (): boolean => {
      if (done) return false
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      return true
    }
    const onAbort = (): void => {
      if (finish()) reject(new InstallFail('cancelled'))
    }
    const timer = setTimeout(() => {
      if (!finish()) return
      onTimeout()
      reject(new InstallFail('network', 'timeout'))
    }, ms)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        if (finish()) resolve(v)
      },
      (e) => {
        if (finish()) reject(e)
      },
    )
  })
}

export class WhisperInstaller {
  private job: { pack: WhisperPackId; ctrl: AbortController } | null = null
  private removing = false
  private warmingPack: WhisperPackId | null = null
  private last: WhisperInstallProgress | null = null
  private lastEmitAt = 0
  private readonly assets: Readonly<Record<AssetId, WhisperAsset>>
  private readonly packs: Readonly<Record<WhisperPackId, readonly AssetId[]>>

  constructor(private readonly deps: InstallerDeps) {
    this.assets = deps.catalog?.assets ?? ASSETS
    this.packs = deps.catalog?.packs ?? PACKS
  }

  /** An install (warmup included) or a removal is running. */
  get busy(): boolean {
    return this.job !== null || this.removing
  }

  /** The GPU warmup of an install is running. */
  get warming(): boolean {
    return this.warmingPack !== null
  }

  get supported(): boolean {
    return this.deps.platform === 'win32' && (this.deps.arch ?? process.arch) === 'x64'
  }

  private get now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private get idleMs(): number {
    return this.deps.idleTimeoutMs ?? DOWNLOAD_TIMEOUT_MS
  }

  private retry<T>(op: () => Promise<T>): Promise<T> {
    return withFsRetry(op, this.deps.fsRetryDelaysMs ?? FS_RETRY_DELAYS_MS)
  }

  private log(line: string): void {
    try {
      this.deps.log(line)
    } catch {
      /* logging never breaks an install */
    }
  }

  private path(...parts: string[]): string {
    return join(this.deps.dir, ...parts)
  }

  private partPath(id: AssetId): string {
    return this.path('downloads', `${id}.part`)
  }

  private readRecord(): InstalledRecord {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path(INSTALLED_FILE), 'utf8')) as unknown
      const assets = raw && typeof raw === 'object' ? (raw as { assets?: unknown }).assets : null
      if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return { version: 1, assets: {} }
      const out: InstalledRecord = { version: 1, assets: {} }
      for (const id of Object.keys(this.assets) as AssetId[]) {
        const e = (assets as Record<string, unknown>)[id] as Record<string, unknown> | undefined
        if (e && typeof e === 'object' && typeof e.sha256 === 'string' && typeof e.bytes === 'number') {
          out.assets[id] = { sha256: e.sha256, bytes: e.bytes, diskBytes: typeof e.diskBytes === 'number' ? e.diskBytes : 0, at: typeof e.at === 'number' ? e.at : 0 }
        }
      }
      return out
    } catch {
      return { version: 1, assets: {} }
    }
  }

  private async writeRecord(rec: InstalledRecord): Promise<void> {
    await writeAtomic(this.path(INSTALLED_FILE), JSON.stringify(rec, null, 2) + '\n')
  }

  private diskBytes(id: AssetId): number {
    const a = this.assets[id]
    return a.kind === 'zip' ? (EXTRACT_BYTES[id] ?? a.bytes) : a.bytes
  }

  /** The asset's files are on disk: a model with its exact size, a runtime with every member. */
  private present(a: WhisperAsset): boolean {
    const target = this.path(a.target)
    if (a.kind === 'file') {
      const st = statSync(target)
      return !!st && st.isFile() && st.size === a.bytes
    }
    const members = a.members ?? []
    return members.length > 0 && members.every((m) => !!statSync(join(target, strippedMember(m)))?.isFile())
  }

  /** Assets recorded in installed.json (with the catalog's hash) whose files are still on disk. Stat only, no rehash. */
  installed(): Set<AssetId> {
    const rec = this.readRecord()
    const out = new Set<AssetId>()
    for (const id of Object.keys(this.assets) as AssetId[]) {
      const e = rec.assets[id]
      if (e && e.sha256 === this.assets[id].sha256 && this.present(this.assets[id])) out.add(id)
    }
    return out
  }

  private packInstalled(pack: WhisperPackId, have: ReadonlySet<AssetId>): boolean {
    return this.packs[pack].every((id) => have.has(id))
  }

  private isGpuPack(pack: WhisperPackId): boolean {
    return this.packs[pack].includes('runtime-cuda')
  }

  /** The installer's part of `dictation:models`; the service adds supported, nvidia, vcRuntime and loaded. */
  status(): Pick<WhisperStatus, 'dataDir' | 'packs' | 'install' | 'warming'> {
    const have = this.installed()
    const packs: WhisperPackInfo[] = PACK_IDS.map((id) => ({
      id,
      installed: this.packInstalled(id, have),
      downloadBytes: this.packs[id].reduce((n, a) => n + this.assets[a].bytes, 0),
      diskBytes: this.packs[id].reduce((n, a) => n + this.diskBytes(a), 0),
    }))
    return { dataDir: this.deps.dir, packs, install: this.last ? { ...this.last } : null, warming: this.warming }
  }

  private progress(p: WhisperInstallProgress, force: boolean): void {
    const phaseChanged = this.last?.phase !== p.phase || this.last?.pack !== p.pack
    this.last = p
    if (phaseChanged) this.log(`install pack=${p.pack} phase=${p.phase}${p.error ? ` error=${p.error}` : ''}`)
    const now = this.now
    if (!force && !phaseChanged && now - this.lastEmitAt < PROGRESS_THROTTLE_MS) return
    this.lastEmitAt = now
    try {
      this.deps.emit({ ...p })
    } catch {
      /* a closed window never breaks an install */
    }
  }

  /** Downloads, verifies and extracts every missing asset of the pack; GPU packs end with a warmup. */
  async install(pack: WhisperPackId): Promise<InstallResult> {
    if (!this.packs[pack]) return { ok: false, error: 'unsupported' }
    if (!this.supported) return { ok: false, error: 'unsupported' }
    if (this.busy) return { ok: false, error: 'busy' }
    const ctrl = new AbortController()
    this.job = { pack, ctrl }
    try {
      return await this.run(pack, ctrl.signal)
    } finally {
      this.job = null
      this.warmingPack = null
    }
  }

  /** Aborts the running install of `pack`; its `.part` stays for a later resume. */
  cancel(pack: WhisperPackId): void {
    if (this.job && this.job.pack === pack) this.job.ctrl.abort()
  }

  private async run(pack: WhisperPackId, signal: AbortSignal): Promise<InstallResult> {
    let total = 0
    let transferred = 0
    let phase: WhisperInstallPhase = 'download'
    const report = (force: boolean): void => this.progress({ pack, phase, transferred, total }, force)
    try {
      for (const sub of ['downloads', 'models', 'runtime']) await fsp.mkdir(this.path(sub), { recursive: true })
      await this.cleanStale()
      const have = this.installed()
      const missing = this.packs[pack].filter((id) => !have.has(id))
      total = missing.reduce((n, id) => n + this.assets[id].bytes, 0)
      report(true)

      if (missing.length) {
        let need = DISK_MARGIN_BYTES
        for (const id of missing) {
          const a = this.assets[id]
          const part = statSync(this.partPath(id))?.size ?? 0
          need += a.bytes - Math.min(part, a.bytes) + (a.kind === 'zip' ? this.diskBytes(id) : 0)
        }
        let free = Number.POSITIVE_INFINITY
        try {
          free = await this.deps.freeBytes(this.deps.dir)
        } catch {
          this.log('install free=unknown')
        }
        if (free < need) throw new InstallFail('disk')
      }

      let done = 0
      for (const id of missing) {
        const a = this.assets[id]
        try {
          phase = 'download'
          report(true)
          await this.download(a, signal, (verifying) => {
            phase = verifying ? 'verify' : 'download'
            report(false)
          }, (n) => {
            transferred = done + n
            report(false)
          })
          transferred = done + a.bytes
          if (a.kind === 'zip') {
            phase = 'extract'
            report(true)
            await this.extractZip(a, signal)
          } else {
            await this.placeFile(a)
          }
          const rec = this.readRecord()
          rec.assets[id] = { sha256: a.sha256, bytes: a.bytes, diskBytes: this.diskBytes(id), at: this.now }
          await this.writeRecord(rec)
          done += a.bytes
          this.log(`asset ${id} ok bytes=${a.bytes}`)
        } catch (err) {
          const code = this.failCode(err, signal)
          this.log(`asset ${id} error=${code}${err instanceof InstallFail && err.detail ? ` reason=${err.detail}` : ''}`)
          throw new InstallFail(code)
        }
      }

      if (this.isGpuPack(pack)) {
        phase = 'warmup'
        this.warmingPack = pack
        report(true)
        let ok = false
        try {
          ok = await this.deps.warmup(pack)
        } catch {
          ok = false
        }
        this.warmingPack = null
        if (!ok) throw new InstallFail('warmup')
      }

      phase = 'done'
      transferred = total
      report(true)
      return { ok: true }
    } catch (err) {
      const error = this.failCode(err, signal)
      this.progress({ pack, phase: 'error', transferred, total, error }, true)
      return { ok: false, error }
    }
  }

  private failCode(err: unknown, signal: AbortSignal): WhisperInstallError {
    if (signal.aborted) return 'cancelled'
    if (err instanceof InstallFail) return err.code
    // Any other error comes from the file system (mkdir, write, rename).
    return 'disk'
  }

  /** Deletes `<target>.tmp-*` folders a killed tar left and installed.json temp files. */
  private async cleanStale(): Promise<void> {
    const parents = new Set(Object.values(this.assets).filter((a) => a.kind === 'zip').map((a) => dirname(this.path(a.target))))
    for (const parent of parents) {
      let names: string[] = []
      try {
        names = await fsp.readdir(parent)
      } catch {
        continue
      }
      for (const n of names) {
        if (/\.tmp-[0-9a-f]+$/.test(n)) await this.retry(() => fsp.rm(join(parent, n), { recursive: true, force: true })).catch(() => undefined)
      }
    }
    try {
      for (const n of await fsp.readdir(this.deps.dir)) {
        if (n.startsWith(`${INSTALLED_FILE}.`) && n.endsWith('.tmp')) await fsp.rm(this.path(n), { force: true }).catch(() => undefined)
      }
    } catch {
      /* nothing to clean */
    }
  }

  /** Follows redirects by hand: https, an allowed host and the same headers on every hop. */
  private async request(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ res: HttpRes; reqCtrl: AbortController; detach: () => void }> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let u: URL
      try {
        u = new URL(current)
      } catch {
        throw new InstallFail('http', 'url')
      }
      if (u.protocol !== 'https:' || u.username || u.password || !isAllowedDownloadHost(u.hostname)) throw new InstallFail('http', 'host')
      const reqCtrl = new AbortController()
      const onAbort = (): void => reqCtrl.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      const detach = (): void => signal.removeEventListener('abort', onAbort)
      let res: HttpRes
      try {
        res = await guarded(
          Promise.resolve().then(() => this.deps.fetch(u.toString(), { ...headers }, reqCtrl.signal)),
          this.idleMs,
          signal,
          () => reqCtrl.abort(),
        )
      } catch (err) {
        detach()
        reqCtrl.abort()
        if (err instanceof InstallFail) throw err
        throw new InstallFail('network')
      }
      if (REDIRECT_STATUS.has(res.status)) {
        const loc = res.headers.location
        try {
          res.close?.()
        } catch {
          /* already closed */
        }
        detach()
        if (!loc) throw new InstallFail('http', 'location')
        try {
          current = new URL(loc, u).toString()
        } catch {
          throw new InstallFail('http', 'location')
        }
        continue
      }
      return { res, reqCtrl, detach }
    }
    throw new InstallFail('http', 'redirects')
  }

  private async hashFile(file: string, hash: Hash, signal: AbortSignal): Promise<void> {
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 })
    try {
      for await (const chunk of stream) {
        if (signal.aborted) throw new InstallFail('cancelled')
        hash.update(chunk as Buffer)
      }
    } finally {
      stream.destroy()
    }
  }

  /**
   * Downloads one asset into its `.part` and checks size and SHA-256. A
   * `.part` left by a cancel is rehashed and resumed with `Range`: a 206 with
   * the right `Content-Range` appends, a 200 starts over, a 416 on a complete
   * file goes straight to the check.
   */
  private async download(a: WhisperAsset, signal: AbortSignal, onPhase: (verifying: boolean) => void, onBytes: (n: number) => void): Promise<void> {
    const part = this.partPath(a.id)
    let hash = createHash('sha256')
    let offset = statSync(part)?.size ?? 0
    if (offset > a.bytes) {
      await fsp.rm(part, { force: true })
      offset = 0
    }
    if (offset > 0) {
      onPhase(true)
      await this.hashFile(part, hash, signal)
      onPhase(false)
      onBytes(offset)
    }
    const restart = async (): Promise<void> => {
      await fsp.rm(part, { force: true })
      hash = createHash('sha256')
      offset = 0
      onBytes(0)
    }

    let restarted = false
    for (;;) {
      const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {}
      const { res, reqCtrl, detach } = await this.request(a.url, headers, signal)
      const drop = (): void => {
        try {
          res.close?.()
        } catch {
          /* already closed */
        }
        detach()
      }
      if (offset > 0 && res.status === 416) {
        drop()
        if (offset === a.bytes) break
        if (restarted) throw new InstallFail('http', 'status=416')
        restarted = true
        await restart()
        continue
      }
      let append = false
      if (offset > 0 && res.status === 206) {
        if (contentRangeStart(res.headers['content-range']) !== offset) {
          drop()
          if (restarted) throw new InstallFail('http', 'range')
          restarted = true
          await restart()
          continue
        }
        append = true
      } else if (res.status === 200) {
        if (offset > 0) {
          hash = createHash('sha256')
          offset = 0
          onBytes(0)
        }
      } else {
        drop()
        throw new InstallFail('http', `status=${res.status}`)
      }
      const len = res.headers['content-length']
      if (len !== undefined && /^\d+$/.test(len.trim()) && Number(len) !== a.bytes - offset) {
        drop()
        await fsp.rm(part, { force: true })
        throw new InstallFail('size')
      }
      try {
        await this.stream(res, part, append, hash, offset, a.bytes, signal, reqCtrl, onBytes)
      } finally {
        drop()
      }
      break
    }

    const size = statSync(part)?.size ?? -1
    if (size !== a.bytes) {
      await fsp.rm(part, { force: true })
      throw new InstallFail('size')
    }
    if (hash.digest('hex') !== a.sha256) {
      await fsp.rm(part, { force: true })
      throw new InstallFail('sha256')
    }
  }

  private async stream(
    res: HttpRes,
    part: string,
    append: boolean,
    hash: Hash,
    offset: number,
    expected: number,
    signal: AbortSignal,
    reqCtrl: AbortController,
    onBytes: (n: number) => void,
  ): Promise<void> {
    let fh: fs.promises.FileHandle
    try {
      fh = await fsp.open(part, append ? 'a' : 'w')
    } catch {
      throw new InstallFail('disk')
    }
    const it = res.body[Symbol.asyncIterator]()
    let received = offset
    let finished = false
    try {
      for (;;) {
        let r: IteratorResult<Uint8Array>
        try {
          r = await guarded(it.next(), this.idleMs, signal, () => reqCtrl.abort())
        } catch (err) {
          if (err instanceof InstallFail) throw err
          throw new InstallFail('network')
        }
        if (r.done) {
          finished = true
          break
        }
        const chunk = r.value
        if (!chunk || !chunk.byteLength) continue
        received += chunk.byteLength
        if (received > expected) {
          reqCtrl.abort()
          await fh.close().catch(() => undefined)
          await fsp.rm(part, { force: true })
          throw new InstallFail('size')
        }
        hash.update(chunk)
        try {
          await fh.write(chunk)
        } catch {
          throw new InstallFail('disk')
        }
        onBytes(received)
      }
    } finally {
      if (!finished) {
        reqCtrl.abort()
        Promise.resolve()
          .then(() => it.return?.())
          .catch(() => undefined)
      }
      await fh.close().catch(() => undefined)
    }
  }

  /** Moves a verified model from `downloads/` to its target, replacing a leftover. */
  private async placeFile(a: WhisperAsset): Promise<void> {
    const target = this.path(a.target)
    await fsp.mkdir(dirname(target), { recursive: true })
    await this.retry(() => fsp.rm(target, { recursive: true, force: true }))
    await this.retry(() => fsp.rename(this.partPath(a.id), target))
  }

  /** tar into `<target>.tmp-<rand>`, check every member, rename over the target, then drop the zip. */
  private async extractZip(a: WhisperAsset, signal: AbortSignal): Promise<void> {
    const target = this.path(a.target)
    const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`
    const members = a.members ?? []
    await fsp.mkdir(tmp, { recursive: true })
    try {
      try {
        await this.deps.extract(this.partPath(a.id), tmp, members, signal)
      } catch {
        throw new InstallFail(signal.aborted ? 'cancelled' : 'extract')
      }
      if (signal.aborted) throw new InstallFail('cancelled')
      if (!members.length || !members.every((m) => !!statSync(join(tmp, strippedMember(m)))?.isFile())) throw new InstallFail('extract', 'members')
      await this.retry(() => fsp.rm(target, { recursive: true, force: true }))
      await this.retry(() => fsp.rename(tmp, target))
    } catch (err) {
      await this.retry(() => fsp.rm(tmp, { recursive: true, force: true })).catch(() => undefined)
      throw err
    }
    await fsp.rm(this.partPath(a.id), { force: true }).catch(() => undefined)
  }

  /**
   * Deletes the pack's assets that no other installed pack needs (removing
   * `cpu` while `gpu` is installed deletes nothing), their `.part` files and,
   * once no GPU pack is left, `cuda-cache/`. `busy` while an install, a
   * warmup or a session runs, or when the files stay locked.
   */
  async remove(pack: WhisperPackId, guard?: RemoveGuard | (() => boolean)): Promise<InstallResult> {
    if (!this.packs[pack]) return { ok: false, error: 'unsupported' }
    const g: RemoveGuard | undefined = typeof guard === 'function' ? { inUse: guard } : guard
    if (this.busy || this.warming) return { ok: false, error: 'busy' }
    if (g?.inUse()) return { ok: false, error: 'busy' }
    this.removing = true
    try {
      if (g?.awaitExit) {
        await g.awaitExit()
        // A session or a warmup that began while the server went down keeps its files.
        if (g.inUse()) {
          this.log(`remove pack=${pack} error=busy in use`)
          return { ok: false, error: 'busy' }
        }
      }
      const have = this.installed()
      const keep = new Set<AssetId>()
      for (const other of PACK_IDS) if (other !== pack && this.packInstalled(other, have)) for (const id of this.packs[other]) keep.add(id)
      const drop = this.packs[pack].filter((id) => !keep.has(id))
      // The record goes first: a file that stays locked is then just a leftover the next install replaces.
      const rec = this.readRecord()
      for (const id of drop) delete rec.assets[id]
      await this.writeRecord(rec)
      for (const id of drop) {
        await this.retry(() => fsp.rm(this.path(this.assets[id].target), { recursive: true, force: true }))
        await this.retry(() => fsp.rm(this.partPath(id), { force: true }))
      }
      const after = this.installed()
      if (!PACK_IDS.some((p) => this.isGpuPack(p) && this.packInstalled(p, after))) {
        await this.retry(() => fsp.rm(this.path('cuda-cache'), { recursive: true, force: true }))
      }
      if (this.last?.pack === pack) this.last = null
      this.log(`remove pack=${pack} ok assets=${drop.length}`)
      return { ok: true }
    } catch (err) {
      this.log(`remove pack=${pack} error=busy code=${errCode(err) || 'unknown'}`)
      return { ok: false, error: 'busy' }
    } finally {
      this.removing = false
    }
  }
}

/** `%SystemRoot%\System32\tar.exe` (bsdtar, in Windows 10 1803 and later). */
export function defaultTarPath(): string {
  return win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
}

/** deps.extract over tar.exe: arguments only (no shell), hidden window, killed on abort or after EXTRACT_TIMEOUT_MS. */
export function extractWithTar(tarExe: string, timeoutMs = EXTRACT_TIMEOUT_MS): ExtractFn {
  return (zip, dest, members, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      let done = false
      const child = spawn(tarExe, ['-xf', zip, '-C', dest, '--strip-components', '1', ...members], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      const finish = (err: Error | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (err) reject(err)
        else resolve()
      }
      const kill = (): void => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
      const onAbort = (): void => {
        kill()
        finish(new Error('aborted'))
      }
      const timer = setTimeout(() => {
        kill()
        finish(new Error('timeout'))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (e) => finish(e))
      child.on('exit', (code) => finish(code === 0 ? null : new Error(`tar exit ${code}`)))
    })
}

/** deps.freeBytes: free bytes for this user on the volume of `dir`. */
export async function statfsFreeBytes(dir: string): Promise<number> {
  const s = await fsp.statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}
