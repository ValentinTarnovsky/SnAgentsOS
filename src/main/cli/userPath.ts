import { execFile } from 'child_process'
import { win32 } from 'path'

/**
 * "Add snaos to the user PATH" (E8-FR-22, Windows). Reads the raw value of
 * HKCU\Environment\Path (`DoNotExpandEnvironmentNames`), writes it back as
 * REG_EXPAND_SZ so `%VAR%` entries stay unexpanded, and broadcasts
 * WM_SETTINGCHANGE ("Environment") so new terminals see it. Never `setx`,
 * which truncates at 1024 characters, and never `reg query`: reg.exe prints
 * through the OEM code page, so an entry with an accent (a user folder like
 * C:\Users\Martín) would come back mangled and be written back broken. The
 * value travels as base64 of its UTF-8 bytes through a PowerShell script fed
 * on stdin (no command line length or quoting limits). A failed read throws:
 * it never reads as an empty PATH that a write would then replace. The
 * registry access is injectable: tests never touch the real HKCU.
 */
export interface RegistryOps {
  /** Raw Path value, '' when it does not exist. Throws when it cannot be read. */
  read(): Promise<string>
  write(value: string): Promise<void>
  broadcast(): Promise<void>
}

/** powershell.exe from System32 (not whatever PATH resolves first). */
function powershellExe(): string {
  const root = process.env.SystemRoot || process.env.windir
  return root ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
}

/** Runs a one-line PowerShell script given on stdin; resolves its stdout. */
function runPowerShell(script: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) rej(error)
      else res(String(stdout))
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(script + '\r\n')
  })
}

/** Only plain registry subkey paths reach a script (no quote can break out). */
const SUBKEY_RE = /^[A-Za-z0-9_\\-]+$/

/** Prints `@` when Path is absent, else `=` + base64(UTF-8 of the raw value). */
export function readScript(subKey = 'Environment'): string {
  if (!SUBKEY_RE.test(subKey)) throw new Error('invalid registry subkey')
  return `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${subKey}'); if ($k -eq $null) { '@' } else { $v=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $k.Close(); if ($v -eq $null) { '@' } else { '=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)) } }`
}

/** The script that stores `value` (base64 of its UTF-8, so nothing needs quoting). */
export function writeScript(value: string, subKey = 'Environment'): string {
  if (!SUBKEY_RE.test(subKey)) throw new Error('invalid registry subkey')
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  return `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${subKey}'); $k.SetValue('Path',$v,[Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close(); 'ok'`
}

/** The read script's output -> the raw value ('' when absent). Anything else throws. */
export function parseReadOutput(stdout: string): string {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l === '@' || l.startsWith('='))
  if (line === undefined) throw new Error('unexpected registry read output')
  if (line === '@') return ''
  const b64 = line.slice(1)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('unexpected registry read output')
  return Buffer.from(b64, 'base64').toString('utf8')
}

/**
 * HKCU\<subKey> access through PowerShell (.NET Registry). The app only uses
 * `Environment` (realRegistry); tests point it at a throwaway test key.
 */
export function powershellRegistry(subKey = 'Environment', broadcast = true): RegistryOps {
  return {
    async read() {
      return parseReadOutput(await runPowerShell(readScript(subKey)))
    },
    async write(value) {
      const out = await runPowerShell(writeScript(value, subKey))
      if (!out.split(/\r?\n/).some((l) => l.trim() === 'ok')) throw new Error('the user PATH was not written')
    },
    async broadcast() {
      if (!broadcast) return
      const script =
        "Add-Type -Namespace SnAgentsOS -Name Env -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'; $r=[UIntPtr]::Zero; [void][SnAgentsOS.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)"
      try {
        await runPowerShell(script)
      } catch {
        /* new terminals pick it up after the next sign-in anyway */
      }
    },
  }
}

/** HKCU\Environment, with the WM_SETTINGCHANGE broadcast. */
export const realRegistry: RegistryOps = powershellRegistry()

/** Comparable form of a PATH entry (Windows rules on any host): unquoted, no trailing separator, case-folded. */
function norm(entry: string): string {
  const raw = entry.trim().replace(/^"|"$/g, '')
  if (!raw) return ''
  // An entry with an unexpanded %VAR% is compared as written.
  const abs = raw.includes('%') ? raw : win32.resolve(raw)
  return abs.replace(/[\\/]+$/, '').toLowerCase()
}

/** PATH entries, empty ones dropped (a doubled ';' would otherwise grow). */
function entries(value: string): string[] {
  return value.split(';').filter((e) => e.trim() !== '')
}

/** `value` with `dir` appended once (unchanged when already present). */
export function withDir(value: string, dir: string): string {
  const list = entries(value)
  if (list.some((e) => norm(e) === norm(dir))) return value
  return [...list, dir].join(';')
}

/** `value` without any entry equal to `dir`; every other entry kept as written. */
export function withoutDir(value: string, dir: string): string {
  const list = entries(value)
  const kept = list.filter((e) => norm(e) !== norm(dir))
  return kept.length === list.length ? value : kept.join(';')
}

export function hasDir(value: string, dir: string): boolean {
  return entries(value).some((e) => norm(e) === norm(dir))
}

/** Adds `dir` to the user PATH. True when it is there afterwards. */
export async function addToUserPath(dir: string, reg: RegistryOps = realRegistry): Promise<boolean> {
  const current = await reg.read()
  const next = withDir(current, dir)
  if (next === current) return true
  await reg.write(next)
  await reg.broadcast()
  return true
}

/** Removes `dir` from the user PATH (only that entry). True when it is gone afterwards. */
export async function removeFromUserPath(dir: string, reg: RegistryOps = realRegistry): Promise<boolean> {
  const current = await reg.read()
  const next = withoutDir(current, dir)
  if (next === current) return true
  await reg.write(next)
  await reg.broadcast()
  return true
}

export async function isInUserPath(dir: string, reg: RegistryOps = realRegistry): Promise<boolean> {
  return hasDir(await reg.read(), dir)
}
