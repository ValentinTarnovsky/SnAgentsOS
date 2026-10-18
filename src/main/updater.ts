import { createWriteStream, mkdtempSync, writeFileSync, chmodSync, rmSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { get as httpsGet } from 'https'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { spawn, type SpawnOptions } from 'child_process'
import { app, net, shell, type ClientRequest } from 'electron'
import {
  MISSING_CHECKSUM,
  type InstallKind,
  type ReleaseSummary,
  type UpdateInfo,
  type UpdateProgress,
} from '@shared/ipc-contract'
import { BRAND } from '@shared/brand'
import { isPortable, portableExeFile } from './paths'
import { updateState } from './updateState'

/** Releases fetched per check; a full page of newer ones reads as "30 or more". */
export const RELEASE_PAGE = 30
/** Budget for the notes of every missed release together (bytes of UTF-8). */
export const NOTES_BUDGET = 64 * 1024
/** Largest JSON / sidecar body collect() buffers before giving up. */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/**
 * owner/repo the releases are published under. 1.x clients still query the old
 * name and reach this repo through GitHub's 301 (followed by makeRequest).
 * `SNAOS_UPDATE_REPO` points a dev build at a test repo; a packaged build
 * ignores it, so a stray environment variable can never redirect real users.
 */
const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
function repo(): string {
  const override = process.env.SNAOS_UPDATE_REPO
  if (!app.isPackaged && override && SAFE_REPO.test(override)) return override
  return BRAND.repo
}
/** The release list (E4-FR-14): one call covers "+N versions" and a half-built newest release. */
const releasesUrl = (): string => `https://api.github.com/repos/${repo()}/releases?per_page=${RELEASE_PAGE}`
/** Fallback when the list fails: the 1.x query, without "+N". */
const latestUrl = (): string => `https://api.github.com/repos/${repo()}/releases/latest`
const userAgent = (): string => `${BRAND.productName}/${app.getVersion()}`
const UPDATE_DIR_PREFIX = `${BRAND.tempPrefix}update-`
const SWAP_DIR_PREFIX = `${BRAND.tempPrefix}swap-`

/**
 * Hosts we will ever fetch from, including the CDN GitHub redirects asset
 * downloads to. Every request uses manual redirect handling so a 3xx can never
 * smuggle us onto an off-list host (the bytes get spawned as native code).
 */
const ALLOWED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host) || host.endsWith('.githubusercontent.com')
}

/** Release asset filenames we accept (also guards join(tmpdir, name) traversal). */
const SAFE_ASSET_NAME = /^[A-Za-z0-9._-]+$/

export interface GhAsset {
  name: string
  browser_download_url: string
  size: number
}
export interface GhRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  prerelease?: boolean
  draft?: boolean
  assets?: GhAsset[]
}

export interface Match {
  asset: GhAsset
  kind: InstallKind
  /** URL of the "<asset>.sha256" sidecar, when the release published one. */
  sha256Url: string | null
}

/** Remembered between a check and the install so the renderer needn't pass it back. */
let lastMatch: Match | null = null

/** "v1.2.3" / "1.2.3-beta+5" -> [1, 2, 3] (prerelease/build metadata dropped). */
function parseVersion(v: string): number[] {
  const core = v.replace(/^v/i, '').split('-')[0].split('+')[0]
  return core.split('.').map((n) => parseInt(n, 10) || 0)
}

/** True when `latest` is a strictly higher version than `current`. */
function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Locate the "<name>.sha256" sidecar asset URL for integrity verification. */
function sidecarFor(assets: GhAsset[], name: string): string | null {
  const sc = assets.find((a) => a.name === `${name}.sha256`)
  return sc ? sc.browser_download_url : null
}

/**
 * Choose the release asset that matches this OS, architecture and install type
 * (portable vs installed). Returns null when nothing safely installable fits, in
 * which case the UI falls back to opening the release page. Matching is by
 * pattern, never by product prefix, so a rename of the artifacts keeps working.
 * Exported for scripts/test-rebrand.cjs.
 */
export function pickAsset(assets: GhAsset[]): Match | null {
  const find = (re: RegExp): GhAsset | undefined => assets.find((a) => re.test(a.name))
  const wrap = (asset: GhAsset | undefined, kind: InstallKind): Match | null =>
    asset ? { asset, kind, sha256Url: sidecarFor(assets, asset.name) } : null

  if (process.platform === 'win32') {
    if (isPortable()) {
      // Never let the fallback grab a setup.exe (it would clobber the portable exe).
      return wrap(find(/portable.*\.exe$/i) ?? find(/^(?!.*setup).*\.exe$/i), 'win-portable')
    }
    return wrap(find(/setup.*\.exe$/i) ?? find(/^(?!.*portable).*\.exe$/i), 'win-installer')
  }

  if (process.platform === 'darwin') {
    const wantArm = process.arch === 'arm64'
    // No cross-arch fallback: serving an x64 dmg to arm64 (or vice versa) is worse
    // than opening the release page, so require an arch match.
    const dmg = assets.find(
      (x) => /\.dmg$/i.test(x.name) && (wantArm ? /arm64/i.test(x.name) : !/arm64/i.test(x.name)),
    )
    return wrap(dmg, 'mac-dmg')
  }

  if (process.platform === 'linux') {
    // Only an AppImage swap when we actually run as an AppImage with a real path.
    if (process.env.APPIMAGE) {
      const appimage = find(/\.appimage$/i)
      if (appimage) return wrap(appimage, 'linux-appimage')
    }
    const deb = find(/\.deb$/i)
    if (deb) return wrap(deb, 'linux-deb')
    return null
  }

  return null
}

/** A GET request with a strict https + host allowlist enforced across redirects. */
function makeRequest(url: string, onReject: (err: Error) => void): ClientRequest {
  const req = net.request({ url, method: 'GET', redirect: 'manual' })
  req.setHeader('User-Agent', userAgent())
  req.on('redirect', (_status: number, _method: string, redirectUrl: string) => {
    try {
      const u = new URL(redirectUrl)
      if (u.protocol === 'https:' && isAllowedHost(u.hostname)) {
        req.followRedirect()
        return
      }
    } catch {
      /* fall through to abort */
    }
    req.abort()
    onReject(new Error(`Refusing to follow an update redirect to an untrusted host: ${redirectUrl}`))
  })
  return req
}

/**
 * Buffer a small response (release JSON / checksum sidecar). The initial host is
 * allowlisted (not just redirects), and the request is bounded by a timeout so a
 * stalled socket can never hang the install (which would otherwise keep the
 * window's close guard latched forever).
 */
function collect(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' || !isAllowedHost(u.hostname)) {
        reject(new Error(`Refusing to fetch from an untrusted host: ${u.hostname}`))
        return
      }
    } catch {
      reject(new Error('Malformed update URL.'))
      return
    }

    let done = false
    let req: ClientRequest
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        req.abort()
      } catch {
        /* ignore */
      }
      reject(new Error('The update request timed out.'))
    }, 30_000)
    const settle = <T>(fn: (v: T) => void) => (v: T): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn(v)
    }
    const ok = settle(resolve)
    const bad = settle(reject)

    req = makeRequest(url, bad)
    req.setHeader('Accept', 'application/vnd.github+json')
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        if (done) return
        size += c.length
        if (size > MAX_BODY_BYTES) {
          try {
            req.abort()
          } catch {
            /* ignore */
          }
          bad(new Error('The update response was larger than expected.'))
          return
        }
        chunks.push(Buffer.from(c))
      })
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      res.on('error', bad)
    })
    req.on('error', bad)
    req.end()
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  const { status, body } = await collect(url)
  if (status >= 400) throw new Error(`GitHub API responded ${status}`)
  return JSON.parse(body.toString('utf8')) as T
}

async function fetchText(url: string): Promise<string> {
  const { status, body } = await collect(url)
  if (status >= 400) throw new Error(`Checksum fetch failed: HTTP ${status}`)
  return body.toString('utf8')
}

/** Pull the first 64-hex SHA-256 token out of a "<hash>  <file>" sidecar. */
function parseSha256(text: string): string | null {
  const m = text.match(/\b[a-f0-9]{64}\b/i)
  return m ? m[0].toLowerCase() : null
}

/**
 * Stream the (large) installer to disk via Node's https, which is a real
 * Readable so write backpressure actually works (Electron's net IncomingMessage
 * is only an EventEmitter and can't be paused). Redirects are followed manually
 * against the same host allowlist; the byte count and the SHA-256 are verified,
 * and the partial file is removed on any failure.
 */
function download(
  url: string,
  dest: string,
  expectedSize: number,
  expectedSha256: string,
  onProgress: (p: UpdateProgress) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }

    const attempt = (current: string, redirectsLeft: number): void => {
      const req = httpsGet(
        current,
        { headers: { 'User-Agent': userAgent() } },
        (res) => {
          const status = res.statusCode ?? 0

          // Follow redirects ourselves so each hop is host-validated.
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume() // drain so the socket can be reused
            if (redirectsLeft <= 0) {
              fail(new Error('Too many redirects while downloading the update.'))
              return
            }
            let next: URL
            try {
              next = new URL(res.headers.location, current)
            } catch {
              fail(new Error('Malformed redirect URL while downloading the update.'))
              return
            }
            if (next.protocol !== 'https:' || !isAllowedHost(next.hostname)) {
              fail(new Error(`Refusing to follow an update redirect to: ${next.hostname}`))
              return
            }
            attempt(next.toString(), redirectsLeft - 1)
            return
          }

          if (status >= 400) {
            res.resume()
            fail(new Error(`Download failed: HTTP ${status}`))
            return
          }

          const out = createWriteStream(dest)
          const hash = createHash('sha256')
          const cleanupFail = (err: Error): void => {
            out.destroy()
            try {
              unlinkSync(dest)
            } catch {
              /* best effort */
            }
            fail(err)
          }
          out.on('error', cleanupFail)
          // Prefer the API-reported size so progress and the integrity check agree.
          const total = expectedSize > 0 ? expectedSize : Number(res.headers['content-length']) || 0
          let transferred = 0
          res.on('data', (chunk: Buffer) => {
            transferred += chunk.length
            hash.update(chunk)
            if (!out.write(chunk)) {
              res.pause()
              out.once('drain', () => res.resume())
            }
            if (total > 0) {
              onProgress({
                percent: Math.min(100, Math.round((transferred / total) * 100)),
                transferred,
                total,
              })
            }
          })
          res.on('end', () => {
            out.end(() => {
              if (settled) return
              if (expectedSize > 0 && transferred !== expectedSize) {
                cleanupFail(new Error(`Size mismatch: got ${transferred}, expected ${expectedSize}`))
                return
              }
              if (hash.digest('hex') !== expectedSha256) {
                cleanupFail(new Error('The downloaded update failed SHA-256 verification.'))
                return
              }
              settled = true
              resolve()
            })
          })
          res.on('error', cleanupFail)
        },
      )
      req.on('error', fail)
      req.setTimeout(60_000, () => req.destroy(new Error('The update download timed out.')))
    }

    attempt(url, 5)
  })
}

/** Spawn a detached helper; returns false when the OS refused to start it. */
function spawnDetached(command: string, args: string[], options: SpawnOptions): boolean {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options })
    child.on('error', (err) => console.error('Update helper failed to start:', err))
    child.unref()
    return child.pid !== undefined
  } catch (err) {
    console.error('Update helper spawn threw:', err)
    return false
  }
}

/**
 * Windows portable swap. The running .exe can't overwrite itself, so a batch
 * helper waits for the lock to release, copies the new exe over the original
 * (PORTABLE_EXECUTABLE_FILE, not the temp extraction) and relaunches it. Paths
 * are passed via environment, never interpolated into the script body, so a
 * folder name containing shell metacharacters can't inject anything.
 */
const WIN_SWAP_SCRIPT = [
  '@echo off',
  'set /a tries=0',
  ':wait',
  'ping -n 2 127.0.0.1 >nul',
  'copy /Y "%SRC%" "%DST%" >nul 2>&1',
  'if not errorlevel 1 goto done',
  'set /a tries+=1',
  'if %tries% lss 90 goto wait',
  ':done',
  // Extra settle time so the old process fully releases the single-instance lock.
  'ping -n 3 127.0.0.1 >nul',
  'start "" "%DST%"',
  'del "%SRC%" >nul 2>&1',
  'rmdir "%SRCDIR%" >nul 2>&1',
  '(goto) 2>nul & del "%~f0"',
  '',
].join('\r\n')

/** Linux AppImage swap: same wait-replace-relaunch dance as the Windows portable. */
const UNIX_SWAP_SCRIPT = [
  '#!/bin/bash',
  'for i in $(seq 1 90); do',
  '  if cp -f "$SRC" "$DST" 2>/dev/null; then',
  '    chmod +x "$DST"',
  '    break',
  '  fi',
  '  sleep 1',
  'done',
  'sleep 2',
  'rm -f "$SRC"',
  'rmdir "$SRCDIR" 2>/dev/null',
  'nohup "$DST" >/dev/null 2>&1 &',
  'rm -- "$0"',
  '',
].join('\n')

function writeScript(name: string, body: string): string {
  const script = join(mkdtempSync(join(tmpdir(), SWAP_DIR_PREFIX)), name)
  writeFileSync(script, body, 'utf8')
  return script
}

/**
 * Apply a downloaded update. Returns true when the app will relaunch itself (the
 * caller should quit), false when we merely opened the file or couldn't start
 * the helper (leaving the app running so the user can retry).
 */
async function applyInstall(kind: InstallKind, file: string): Promise<boolean> {
  switch (kind) {
    case 'win-installer': {
      // NSIS setup closes the running instance, upgrades and relaunches on its
      // own, so we DON'T quit here (cancelling the wizard must not strand the user).
      if (!spawnDetached(file, [], { windowsHide: false })) {
        await shell.openPath(file)
      }
      return false
    }
    case 'win-portable': {
      // Resolved now, never cached: the first-run rename (E0-FR-33) updates
      // PORTABLE_EXECUTABLE_FILE, and a stale value would recreate the old name.
      const target = portableExeFile() ?? process.execPath
      const script = writeScript('swap.cmd', WIN_SWAP_SCRIPT)
      return spawnDetached('cmd.exe', ['/c', script], {
        windowsHide: true,
        env: { ...process.env, SRC: file, DST: target, SRCDIR: dirname(file) },
      })
    }
    case 'linux-appimage': {
      const target = process.env.APPIMAGE
      if (!target) {
        // Not actually an AppImage runtime: hand the file to the user instead.
        await shell.openPath(file)
        shell.showItemInFolder(file)
        return false
      }
      try {
        chmodSync(file, 0o755)
      } catch {
        /* best effort */
      }
      const script = writeScript('swap.sh', UNIX_SWAP_SCRIPT)
      return spawnDetached('/bin/bash', [script], {
        env: { ...process.env, SRC: file, DST: target, SRCDIR: dirname(file) },
      })
    }
    case 'mac-dmg':
    case 'linux-deb':
    case 'open':
    case 'none':
    default: {
      // Unsigned mac / packaged .deb can't be applied silently: hand the file to
      // the OS so the user can finish (drag to Applications, run the installer).
      await shell.openPath(file)
      shell.showItemInFolder(file)
      return false
    }
  }
}

/** "v2.1.0" -> "2.1.0". */
function tagVersion(rel: GhRelease): string {
  return typeof rel.tag_name === 'string' ? rel.tag_name.replace(/^v/i, '') : ''
}

/** `text` cut to at most `max` bytes of UTF-8, never splitting a character. */
function clipBytes(text: string, max: number): string {
  if (max <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= max) lo = mid
    else hi = mid - 1
  }
  // Never leave half of a surrogate pair at the end.
  const code = text.charCodeAt(lo - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo)
}

function summarize(rel: GhRelease, notes: string): ReleaseSummary {
  return { version: tagVersion(rel), notes, url: rel.html_url ?? null, publishedAt: rel.published_at ?? null }
}

/** What a release list means for this build (E4-FR-14). */
export interface ReleaseSelection {
  /** The release to offer: the newest ready one, else the newest published. */
  offered: GhRelease | null
  /** Its asset when it is ready (this build's asset plus its `.sha256`). */
  match: Match | null
  newerCount: number
  missed: ReleaseSummary[]
  newestNotReady?: string
}

/**
 * Pure release selection, exported for scripts/test-update.cjs. Drafts,
 * prereleases and anything not strictly newer than `current` are dropped and
 * the rest sorted newest first (the API order is not trusted). A release is
 * "ready" only with this build's asset and its `.sha256` sidecar, the rule
 * `pickAsset` + `sidecarFor` apply at install time, so a newest release CI is
 * still filling (about 2.5 min) is skipped for the previous complete one and
 * reported as `newestNotReady`. `newerCount` counts the ready releases (capped
 * at the page size, read as "30 or more") and `missed` carries their notes,
 * newest first, within `NOTES_BUDGET` bytes. With nothing ready the newest is
 * offered for its release page only. `pick` resolves the asset for this
 * machine (pickAsset, which knows the install kind).
 */
export function selectReleases(
  list: unknown,
  current: string,
  pick: (assets: GhAsset[]) => Match | null = pickAsset,
): ReleaseSelection {
  const items = Array.isArray(list) ? (list as GhRelease[]).slice(0, RELEASE_PAGE) : []
  const newer = items
    .filter((r) => r !== null && typeof r === 'object' && !r.draft && !r.prerelease)
    .filter((r) => /^\d/.test(tagVersion(r)) && isNewer(tagVersion(r), current))
    .sort((a, b) => {
      const va = tagVersion(a)
      const vb = tagVersion(b)
      return isNewer(va, vb) ? -1 : isNewer(vb, va) ? 1 : 0
    })
  if (newer.length === 0) return { offered: null, match: null, newerCount: 0, missed: [] }

  const ready: Array<{ rel: GhRelease; match: Match }> = []
  for (const rel of newer) {
    const match = pick(Array.isArray(rel.assets) ? rel.assets : [])
    if (match && match.sha256Url) ready.push({ rel, match })
  }
  const first = ready[0]
  const newestNotReady = !first || first.rel !== newer[0] ? tagVersion(newer[0]) : undefined

  // Notes newest first, sharing one budget; the release that crosses it is cut.
  const sources = ready.length > 0 ? ready.map((x) => x.rel) : [newer[0]]
  const missed: ReleaseSummary[] = []
  let budget = NOTES_BUDGET
  for (const rel of sources) {
    const notes = clipBytes(typeof rel.body === 'string' ? rel.body : '', budget)
    budget -= Buffer.byteLength(notes, 'utf8')
    missed.push(summarize(rel, notes))
  }

  return {
    offered: first ? first.rel : newer[0],
    match: first ? first.match : null,
    newerCount: Math.min(ready.length, RELEASE_PAGE),
    missed,
    ...(newestNotReady ? { newestNotReady } : {}),
  }
}

/** UpdateInfo for an offered release (`match` null = only its release page). */
function infoFor(current: string, rel: GhRelease | null, match: Match | null, extra: Partial<UpdateInfo>): UpdateInfo {
  const latest = rel ? tagVersion(rel) : ''
  const available = latest.length > 0 && isNewer(latest, current)
  return {
    available,
    currentVersion: current,
    latestVersion: latest || null,
    notes: rel && typeof rel.body === 'string' ? clipBytes(rel.body, NOTES_BUDGET) : '',
    releaseUrl: rel?.html_url ?? null,
    installable: Boolean(match),
    installKind: match ? match.kind : available ? 'open' : 'none',
    newerCount: 0,
    missed: [],
    ...extra,
  }
}

/**
 * Query GitHub's release list and decide if/how we can update (E4-FR-14).
 * When the list fails, the 1.x `/releases/latest` query answers without "+N"
 * and with the 1.x rule (an asset without sidecar is offered, and the install
 * then refuses it with MISSING_CHECKSUM).
 */
async function queryReleases(): Promise<{ info: UpdateInfo; match: Match | null }> {
  const current = app.getVersion()
  let listError: unknown
  try {
    const list = await fetchJson<unknown>(releasesUrl())
    if (!Array.isArray(list)) throw new Error('Unexpected release list.')
    const sel = selectReleases(list, current)
    const info = infoFor(current, sel.offered, sel.match, {
      newerCount: sel.newerCount,
      missed: sel.missed,
      ...(sel.newestNotReady ? { newestNotReady: sel.newestNotReady } : {}),
    })
    return { info, match: sel.match }
  } catch (err) {
    listError = err
  }
  try {
    const rel = await fetchJson<GhRelease>(latestUrl())
    const latest = tagVersion(rel)
    const match = latest.length > 0 && isNewer(latest, current) ? pickAsset(rel.assets ?? []) : null
    return { info: infoFor(current, rel, match, {}), match }
  } catch (err) {
    const listMsg = listError instanceof Error ? listError.message : String(listError)
    console.error('Update check failed:', err, `(release list: ${listMsg})`)
    const info: UpdateInfo = {
      available: false,
      currentVersion: current,
      latestVersion: null,
      notes: '',
      releaseUrl: null,
      installable: false,
      installKind: 'none',
      newerCount: 0,
      missed: [],
      error: err instanceof Error ? err.message : String(err),
    }
    return { info, match: null }
  }
}

/**
 * Check for an update and record it in main's state (E4-FR-37). While a
 * download/apply runs, neither the remembered asset nor the state change, so
 * a check never swaps the file an install is working on.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const { info, match } = await queryReleases()
  if (!updateState.busy) {
    lastMatch = match
    updateState.checked(info)
  }
  return info
}

/**
 * Download the matching asset (verifying its published SHA-256) and start
 * applying it. Resolves with `relaunching: true` when the app must quit so the
 * swap/installer can run.
 */
export async function downloadAndInstall(
  onProgress: (p: UpdateProgress) => void,
): Promise<{ relaunching: boolean }> {
  let match = lastMatch
  if (!match) {
    // Called with the install already 'downloading': query directly, the
    // state-recording check would ignore the result.
    match = (await queryReleases()).match
    lastMatch = match
  }
  if (!match) throw new Error('No installable update is available for this build.')

  const { asset, kind, sha256Url } = match
  if (!SAFE_ASSET_NAME.test(asset.name) || asset.name === '.' || asset.name === '..') {
    throw new Error(`Refusing to install an asset with an unexpected name: ${asset.name}`)
  }
  const parsed = new URL(asset.browser_download_url)
  if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
    throw new Error('Refusing to download an update from an untrusted URL.')
  }

  // Every installable kind runs the downloaded bytes, so a release without the
  // "<asset>.sha256" sidecar is refused outright (E0-FR-25); the renderer maps
  // this message to update.error.missingChecksum.
  if (!sha256Url) throw new Error(MISSING_CHECKSUM)

  // Fetch the published checksum (over the host-pinned path) before downloading.
  let expectedSha256: string | null
  try {
    expectedSha256 = parseSha256(await fetchText(sha256Url))
  } catch (err) {
    throw new Error(
      `Could not fetch the update checksum, aborting for safety: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  if (!expectedSha256) throw new Error('The published update checksum was malformed.')

  const dir = mkdtempSync(join(tmpdir(), UPDATE_DIR_PREFIX))
  const dest = join(dir, asset.name)
  try {
    await download(asset.browser_download_url, dest, asset.size, expectedSha256, onProgress)
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    throw err
  }

  const relaunching = await applyInstall(kind, dest)
  return { relaunching }
}
