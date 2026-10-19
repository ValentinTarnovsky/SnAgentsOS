import { execFile } from 'child_process'
import { resolve } from 'path'

/**
 * "Add snaos to the user PATH" (E8-FR-22, Windows). Reads the raw value of
 * HKCU\Environment\Path with `reg query`, writes it back with `reg add ...
 * /t REG_EXPAND_SZ` so `%VAR%` entries stay unexpanded, and broadcasts
 * WM_SETTINGCHANGE ("Environment") so new terminals see it. Never `setx`,
 * which truncates at 1024 characters. The registry access is injectable:
 * tests never touch the real HKCU.
 */
export interface RegistryOps {
  /** Raw Path value, '' when it does not exist. */
  read(): Promise<string>
  write(value: string): Promise<void>
  broadcast(): Promise<void>
}

const REG_KEY = 'HKCU\\Environment'

function run(file: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) rej(error)
      else res(String(stdout))
    })
  })
}

/** The value of `Path` in `reg query` output ('' when absent). */
export function parseRegQuery(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i)
    if (m) return m[1].trimEnd()
  }
  return ''
}

/** HKCU access through reg.exe and a one-line PowerShell broadcast. */
export const realRegistry: RegistryOps = {
  async read() {
    try {
      return parseRegQuery(await run('reg.exe', ['query', REG_KEY, '/v', 'Path']))
    } catch {
      // `reg query` exits 1 when the value does not exist.
      return ''
    }
  },
  async write(value) {
    await run('reg.exe', ['add', REG_KEY, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'])
  },
  async broadcast() {
    const script =
      "Add-Type -Namespace SnAgentsOS -Name Env -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'; $r=[UIntPtr]::Zero; [void][SnAgentsOS.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)"
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    } catch {
      /* new terminals pick it up after the next sign-in anyway */
    }
  },
}

/** Comparable form of a PATH entry: unquoted, no trailing separator, case-folded. */
function norm(entry: string): string {
  const raw = entry.trim().replace(/^"|"$/g, '')
  if (!raw) return ''
  // An entry with an unexpanded %VAR% is compared as written.
  const abs = raw.includes('%') ? raw : resolve(raw)
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
