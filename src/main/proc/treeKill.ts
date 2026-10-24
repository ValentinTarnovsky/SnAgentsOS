// Adaptado de paperclipai/paperclip (MIT) - packages/adapter-utils/src/server-utils.ts
/**
 * Process trees of team runs (app 2.7.0, Tanda B, design 3.5; spike S5).
 * A run's pid may be a `cmd.exe` wrapper or an agent that starts its own
 * tools, so a stop kills the whole tree: `taskkill /T /F` on Windows (no
 * graceful signal exists there), the process group on POSIX (runs spawn
 * `detached`, so the child leads its own group).
 *
 * A persisted pid never authorizes a signal by itself (pid reuse): the
 * orphan check first matches procStartTime against the run (decision 64).
 */
import { execFile as nodeExecFile, spawnSync as nodeSpawnSync } from 'child_process'
import { readFile } from 'fs/promises'
import { win32 } from 'path'

export interface TreeKillDeps { platform?: NodeJS.Platform; spawnSync?: typeof import('child_process').spawnSync; kill?: (pid: number, sig: NodeJS.Signals | 0) => void; execFile?: typeof import('child_process').execFile }

/** Image names a run's root process can have (the agent itself, node for a script agent, cmd for a .cmd wrapper). */
const RUN_IMAGES = new Set(['claude', 'codex', 'node', 'cmd'])
const PROBE_TIMEOUT_MS = 5000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0
const errCode = (e: unknown): unknown => (e as { code?: unknown } | null)?.code
/** A Windows tool from System32 (not whatever the cwd or PATH resolves first), like userPath.ts. */
const system32 = (...rel: string[]): string => win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...rel)

function killOf(deps: TreeKillDeps): (pid: number, sig: NodeJS.Signals | 0) => void {
  return deps.kill ?? ((pid, sig) => void process.kill(pid, sig))
}

/** POSIX: the group first, then the pid alone (not a group leader). A pid already gone counts as done. */
function signalPosix(pid: number, sig: NodeJS.Signals, deps: TreeKillDeps): boolean {
  const kill = killOf(deps)
  try {
    kill(-pid, sig)
    return true
  } catch {
    /* no such group: signal the pid alone */
  }
  try {
    kill(pid, sig)
    return true
  } catch (e) {
    return errCode(e) === 'ESRCH'
  }
}

/** win32: spawnSync(<System32>\taskkill.exe, ['/PID', pid, '/T', '/F'], {windowsHide: true}); exit 0 or 128 (already dead) = true. POSIX: kill(-pid, 'SIGKILL'), fallback kill(pid). */
export function treeKillSync(pid: number, deps: TreeKillDeps = {}): boolean {
  if (!validPid(pid)) return false
  if ((deps.platform ?? process.platform) !== 'win32') return signalPosix(pid, 'SIGKILL', deps)
  const res = (deps.spawnSync ?? nodeSpawnSync)(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
  return res.status === 0 || res.status === 128
}

/** POSIX: signal the process group (fallback the pid); win32: treeKillSync (no graceful signal exists). */
export function signalTree(pid: number, sig: 'SIGTERM' | 'SIGKILL', deps: TreeKillDeps = {}): boolean {
  if (!validPid(pid)) return false
  if ((deps.platform ?? process.platform) === 'win32') return treeKillSync(pid, deps)
  return signalPosix(pid, sig, deps)
}

export function pidAlive(pid: number, kill?: TreeKillDeps['kill']): boolean {
  if (!validPid(pid)) return false
  try {
    killOf({ kill })(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists, it is just not ours to signal.
    return errCode(e) === 'EPERM'
  }
}

/** stdout of a short probe, or null (failed, non-zero, timed out). */
function probe(deps: TreeKillDeps, file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      ;(deps.execFile ?? nodeExecFile)(file, args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', ...(env ? { env } : {}) }, (error, stdout) =>
        resolve(error ? null : String(stdout)),
      )
    } catch {
      resolve(null)
    }
  })
}

/** `node.exe`, `/usr/bin/node`, `Codex` -> `node`, `node`, `codex`. */
function imageOf(raw: string): string {
  const base = raw.trim().replace(/^.*[\\/]/, '').toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

function hit(at: number, rawImage: string): { at: number; image: string } | null {
  const image = imageOf(rawImage)
  return Number.isFinite(at) && at > 0 && RUN_IMAGES.has(image) ? { at, image } : null
}

/** `2026-10-24T13:00:00.1234567Z|node` (a UTC round-trip date, then the process name). */
function parseWindows(out: string): { at: number; image: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z\|(.+)$/.exec(out.trim())
  if (!m) return null
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0
  return hit(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms), m[8])
}

/** `Sat Oct 24 10:00:00 2026     /usr/local/bin/node` (ps lstart in the C locale, local time, then comm). */
function parsePs(out: string): { at: number; image: string } | null {
  const m = /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)$/.exec(out.split('\n')[0] ?? '')
  const month = m ? MONTHS.indexOf(m[1]) : -1
  if (!m || month < 0) return null
  return hit(new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime(), m[7])
}

async function linuxStart(pid: number, deps: TreeKillDeps): Promise<{ at: number; image: string } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    // comm may hold spaces and parens: the fields after it start at the last ')'.
    const close = stat.lastIndexOf(')')
    const comm = stat.slice(stat.indexOf('(') + 1, close)
    const startTicks = Number(stat.slice(close + 2).split(' ')[19])
    const btime = Number(/^btime\s+(\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1])
    const tck = Number((await probe(deps, 'getconf', ['CLK_TCK']))?.trim()) || 100
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null
    return hit(Math.round((btime + startTicks / tck) * 1000), comm)
  } catch {
    return null
  }
}

/**
 * Decision 64: process start time (epoch ms) and image name, or null (dead, denied, timeout 5 s). win32:
 * `powershell.exe -NoProfile -NonInteractive -Command "$p = Get-Process -Id <pid> -ErrorAction Stop; ..."` printing
 * `<StartTime.ToUniversalTime() round-trip>|<ProcessName>` (wmic is gone on current Windows); linux: /proc/<pid>/stat
 * field 22 plus btime; darwin: `ps -o lstart= -o comm= -p <pid>` with LC_ALL=C. Only the image names claude, codex,
 * node and cmd count as a match.
 *
 * Any other image answers null as well: a pid reused by an unrelated program never matches, whatever its start time.
 */
export async function procStartTime(pid: number, deps: TreeKillDeps = {}): Promise<{ at: number; image: string } | null> {
  if (!validPid(pid)) return null
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('o') + '|' + $p.ProcessName`
    const out = await probe(deps, system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script])
    return out === null ? null : parseWindows(out)
  }
  if (platform === 'linux') return linuxStart(pid, deps)
  const out = await probe(deps, 'ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], { ...process.env, LC_ALL: 'C' })
  return out === null ? null : parsePs(out)
}
