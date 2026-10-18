import { execFile, execFileSync } from 'child_process'
import * as nodeFs from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { LEGACY_BRAND } from '@shared/brand'

/**
 * Is 1.x running, and closing it (E0-FR-09, FR-36). Two signals:
 *  - the process of the current user: tasklist filtered by image name and
 *    user on Windows (the 1.x portable also runs as SnMultiCC.exe from
 *    %TEMP%\SnMultiCC), pgrep -x on macOS (SnMultiCC) and Linux (snmulticc);
 *  - the Chromium profile lock of a folder about to be migrated or deleted:
 *    lockfile held open on Windows, the SingletonLock symlink <host>-<pid>
 *    with a live pid on POSIX. It also catches a 1.x dev build, which runs as
 *    electron.exe and is invisible to tasklist.
 * Any timeout or error answers "running": the caller then defers, it never deletes.
 * Closing never kills a process tree (no /T): the 1.14.1 updater starts the
 * setup as a child of SnMultiCC.exe, and SnAgentsOS itself may have been
 * launched from a 1.x console.
 */

export const QUERY_TIMEOUT_MS = 3000

export interface ProcessQuery {
  cmd: string
  args: string[]
}

export function legacyProcessQuery(platform: NodeJS.Platform, username: string, uid?: number): ProcessQuery {
  if (platform === 'win32') {
    return { cmd: 'tasklist', args: ['/FI', `IMAGENAME eq ${LEGACY_BRAND.winExe}`, '/FI', `USERNAME eq ${username}`, '/FO', 'CSV', '/NH'] }
  }
  const name = platform === 'darwin' ? LEGACY_BRAND.macProcess : LEGACY_BRAND.linuxProcess
  return { cmd: 'pgrep', args: [...(uid !== undefined ? ['-U', String(uid)] : []), '-x', name] }
}

/** exit code 0/1 and the output of the query, to "running". Anything unexpected is running. */
export function parseLegacyProcess(platform: NodeJS.Platform, code: number | null, stdout: string): boolean {
  if (platform === 'win32') {
    if (code !== 0) return true
    return stdout.toLowerCase().includes(`"${LEGACY_BRAND.winExe.toLowerCase()}"`)
  }
  if (code === 1) return false
  return code !== 0 || stdout.trim().length > 0
}

export type SyncExec = (cmd: string, args: string[], o: { timeout: number; windowsHide: boolean; encoding: 'utf8' }) => string

/** Blocking variant for the boot pipeline (runs before any window exists). */
export function isLegacyRunningSync(platform: NodeJS.Platform, username: string, uid?: number, exec: SyncExec = execFileSync as unknown as SyncExec): boolean {
  const q = legacyProcessQuery(platform, username, uid)
  try {
    return parseLegacyProcess(platform, 0, exec(q.cmd, q.args, { timeout: QUERY_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }))
  } catch (err) {
    const status = (err as { status?: unknown }).status
    return parseLegacyProcess(platform, typeof status === 'number' ? status : null, '')
  }
}

export type AsyncExec = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>

export const defaultAsyncExec: AsyncExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: QUERY_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

/** Non-blocking variant for the background cleanup. */
export async function isLegacyRunningAsync(platform: NodeJS.Platform, username: string, uid?: number, exec: AsyncExec = defaultAsyncExec): Promise<boolean> {
  const q = legacyProcessQuery(platform, username, uid)
  try {
    const r = await exec(q.cmd, q.args)
    return parseLegacyProcess(platform, r.code, r.stdout)
  } catch {
    return true
  }
}

export interface LockDeps {
  fs?: Pick<typeof nodeFs, 'openSync' | 'closeSync' | 'readlinkSync'>
  kill?: (pid: number, signal: 0) => void
  host?: string
}

function errCode(err: unknown): string {
  const c = (err as { code?: unknown })?.code
  return typeof c === 'string' ? c : ''
}

/** The Chromium profile in dir is held by a live process. */
export function isProfileLocked(dir: string, platform: NodeJS.Platform, deps: LockDeps = {}): boolean {
  const fsx = deps.fs ?? nodeFs
  if (platform === 'win32') {
    try {
      fsx.closeSync(fsx.openSync(join(dir, 'lockfile'), 'r+'))
      return false
    } catch (err) {
      return ['EBUSY', 'EPERM', 'EACCES'].includes(errCode(err))
    }
  }
  let target: string
  try {
    target = String(fsx.readlinkSync(join(dir, 'SingletonLock')))
  } catch (err) {
    // No lock (ENOENT), or a plain file where a link should be (EINVAL): nobody holds it.
    return !['ENOENT', 'EINVAL', 'ENOTDIR'].includes(errCode(err))
  }
  const m = /^(.*)-(\d+)$/.exec(target)
  if (!m) return false
  // A lock from another host (shared home) cannot be checked: treat it as held.
  if (m[1] !== (deps.host ?? hostname())) return true
  try {
    ;(deps.kill ?? ((pid: number, sig: 0) => process.kill(pid, sig)))(Number(m[2]), 0)
    return true
  } catch (err) {
    return errCode(err) === 'EPERM'
  }
}

export interface CloseDeps {
  platform: NodeJS.Platform
  username: string
  uid?: number
  exec?: AsyncExec
  /** POSIX signal delivery. */
  kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * FR-09 (a), after the user chose to close 1.x: a polite close, polled every
 * 500 ms; forced after 2 s; true once nothing runs, false after 4 s more.
 * The current user's processes only, never a tree.
 */
export async function closeLegacyApp(d: CloseDeps): Promise<boolean> {
  const exec = d.exec ?? defaultAsyncExec
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const running = (): Promise<boolean> => isLegacyRunningAsync(d.platform, d.username, d.uid, exec)
  const poll = async (ms: number): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 500) {
      if (!(await running())) return true
      await sleep(500)
    }
    return !(await running())
  }
  const signal = async (force: boolean): Promise<void> => {
    if (d.platform === 'win32') {
      await exec('taskkill', ['/IM', LEGACY_BRAND.winExe, '/FI', `USERNAME eq ${d.username}`, ...(force ? ['/F'] : [])])
      return
    }
    const q = legacyProcessQuery(d.platform, d.username, d.uid)
    const { stdout } = await exec(q.cmd, q.args)
    for (const pid of stdout.split(/\s+/).filter(Boolean).map(Number)) {
      try {
        ;(d.kill ?? ((p: number, s: 'SIGTERM' | 'SIGKILL') => process.kill(p, s)))(pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  await signal(false)
  if (await poll(2000)) return true
  await signal(true)
  return poll(4000)
}
