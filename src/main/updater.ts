import { createWriteStream, mkdtempSync, writeFileSync, chmodSync, rmSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { get as httpsGet } from 'https'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { spawn, type SpawnOptions } from 'child_process'
import { app, net, shell, type ClientRequest } from 'electron'
import type { InstallKind, UpdateInfo, UpdateProgress } from '@shared/ipc-contract'
import { isPortable, portableExeFile } from './paths'

/** owner/repo the releases are published under. */
const REPO = 'ValentinTarnovsky/SnMultiCC'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`

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

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
}
interface GhRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  prerelease?: boolean
  draft?: boolean
  assets?: GhAsset[]
}

interface Match {
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
 * which case the UI falls back to opening the release page.
 */
function pickAsset(assets: GhAsset[]): Match | null {
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
  req.setHeader('User-Agent', `SnMultiCC/${app.getVersion()}`)
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
      res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)))
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
 * against the same host allowlist; the byte count and, when published, the
 * SHA-256 are verified, and the partial file is removed on any failure.
 */
function download(
  url: string,
  dest: string,
  expectedSize: number,
  expectedSha256: string | null,
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
        { headers: { 'User-Agent': `SnMultiCC/${app.getVersion()}` } },
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
              if (expectedSha256 && hash.digest('hex') !== expectedSha256) {
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
  const script = join(mkdtempSync(join(tmpdir(), 'snmulticc-swap-')), name)
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

/** Query GitHub for the latest release and decide if/how we can update. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion()
  try {
    const rel = await fetchJson<GhRelease>(LATEST_URL)
    const latest = (rel.tag_name ?? '').replace(/^v/i, '')
    const available = latest.length > 0 && isNewer(latest, current)
    const match = available ? pickAsset(rel.assets ?? []) : null
    lastMatch = match
    return {
      available,
      currentVersion: current,
      latestVersion: latest || null,
      notes: rel.body ?? '',
      releaseUrl: rel.html_url ?? null,
      installable: Boolean(match),
      installKind: match ? match.kind : available ? 'open' : 'none',
    }
  } catch (err) {
    console.error('Update check failed:', err)
    return {
      available: false,
      currentVersion: current,
      latestVersion: null,
      notes: '',
      releaseUrl: null,
      installable: false,
      installKind: 'none',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Download the matching asset (verifying its SHA-256 when published) and start
 * applying it. Resolves with `relaunching: true` when the app must quit so the
 * swap/installer can run.
 */
export async function downloadAndInstall(
  onProgress: (p: UpdateProgress) => void,
): Promise<{ relaunching: boolean }> {
  let match = lastMatch
  if (!match) {
    await checkForUpdate()
    match = lastMatch
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

  // Fetch the published checksum (over the host-pinned path) before downloading.
  // If a sidecar exists we REQUIRE it to match; only its absence skips the check.
  let expectedSha256: string | null = null
  if (sha256Url) {
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
  }

  const dir = mkdtempSync(join(tmpdir(), 'snmulticc-update-'))
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
