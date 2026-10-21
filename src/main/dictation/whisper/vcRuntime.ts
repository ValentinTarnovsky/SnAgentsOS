import { execFile } from 'child_process'
import { win32 } from 'path'

/**
 * The Microsoft VC++ 2015-2022 runtime check (app 2.5.0). whisper-server.exe
 * imports MSVCP140 / VCRUNTIME140(_1), which neither the whisper.cpp zips nor
 * Electron ship. Binaries built with MSVC 14.40 or later crash (0xC0000005)
 * on the first std::mutex lock against an older msvcp140.dll, so the check
 * reads the installed version from the registry, not just the DLL files.
 */

/** Minimum runtime: 14.40. */
export const VC_MIN_MAJOR = 14
export const VC_MIN_MINOR = 40

/** The fixed download the overlay and Settings offer (`openSettings('vcredist')`). */
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

/** Native x64 view first; some installs only write the WOW6432Node copy. */
export const VC_REG_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
] as const

/** Process exit codes that mean "the runtime is missing or too old". */
export const EXIT_DLL_NOT_FOUND = 0xc0000135
export const EXIT_ACCESS_VIOLATION = 0xc0000005

export interface VcRuntimeInfo {
  installed: boolean
  major: number
  minor: number
}

function dword(out: string, name: string): number | null {
  const m = new RegExp(`^\\s*${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)\\s*$`, 'im').exec(out)
  return m ? parseInt(m[1], 16) : null
}

/** `reg.exe query` output -> Installed / Major / Minor, or null when the values are not there. */
export function parseVcRuntimeReg(out: string): VcRuntimeInfo | null {
  if (typeof out !== 'string') return null
  const installed = dword(out, 'Installed')
  const major = dword(out, 'Major')
  const minor = dword(out, 'Minor')
  if (installed === null || major === null || minor === null) return null
  return { installed: installed === 1, major, minor }
}

export function vcRuntimeOk(info: VcRuntimeInfo | null): boolean {
  if (!info || !info.installed) return false
  return info.major > VC_MIN_MAJOR || (info.major === VC_MIN_MAJOR && info.minor >= VC_MIN_MINOR)
}

/**
 * An exit that points at the VC++ runtime: DLL not found always, an access
 * violation only before the first answer (the msvcp140 < 14.40 mutex crash).
 * Node reports Windows NTSTATUS exits unsigned or signed; both are accepted.
 */
export function isVcRuntimeExit(code: number | null | undefined, servedBefore: boolean): boolean {
  if (typeof code !== 'number' || !Number.isFinite(code)) return false
  const u = code >>> 0
  if (u === EXIT_DLL_NOT_FOUND) return true
  return u === EXIT_ACCESS_VIOLATION && !servedBefore
}

/** reg.exe by absolute path, so one earlier in PATH is never picked up. */
export function regExePath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
}

export type RegQuery = (key: string) => Promise<string | null>

/** The real query: `reg.exe query <key> /reg:64`, hidden, 10 s cap; null on any failure. */
export function regQuery(exe: string = regExePath()): RegQuery {
  return (key) =>
    new Promise((resolve) => {
      try {
        execFile(exe, ['query', key, '/reg:64'], { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => {
          resolve(err ? null : String(stdout))
        })
      } catch {
        resolve(null)
      }
    })
}

/**
 * true when a runtime 14.40 or later is registered. A positive answer is
 * cached for the run; a negative one is asked again (the user may have just
 * installed it from the overlay button).
 */
export function createVcRuntimeCheck(query: RegQuery): () => Promise<boolean> {
  let ok = false
  return async () => {
    if (ok) return true
    for (const key of VC_REG_KEYS) {
      const out = await query(key)
      if (out !== null && vcRuntimeOk(parseVcRuntimeReg(out))) {
        ok = true
        return true
      }
    }
    return false
  }
}
