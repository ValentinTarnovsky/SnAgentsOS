import { execFile } from 'child_process'
import type { Hive, RegistryAccess } from './legacyInventory'

/**
 * RegistryAccess over Windows PowerShell, asynchronous so the background
 * cleanup never blocks the main thread. reg.exe prints in the OEM code page,
 * which mangles non-ASCII paths (a LegacyInstallLocation under C:\Users\José),
 * so each call runs a tiny script whose answer is base64 of UTF-8 (or of the
 * raw bytes for REG_BINARY). Key and value names travel in the child's
 * environment, never inside the script text. Any error or timeout rejects,
 * and callers treat that conservatively (the item is deferred and retried).
 * The timeout is 10 s, not the 3 s of reg.exe and tasklist: a cold PowerShell
 * start on a busy login (Defender, AMSI) alone can take seconds, and these
 * calls only run in the background cleanup, never on the boot path.
 */

export const REGISTRY_TIMEOUT_MS = 10000

const HIVES: Record<Hive, string> = { HKCU: 'HKEY_CURRENT_USER', HKLM: 'HKEY_LOCAL_MACHINE' }

const OPEN = "$p = 'Registry::' + $env:SNAOS_REG_PATH; $n = $env:SNAOS_REG_NAME; $k = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue;"

const SCRIPTS = {
  read:
    OPEN +
    " if ($null -eq $k) { 'ABSENT'; exit 0 }; $v = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames');" +
    " if ($null -eq $v) { 'ABSENT' } elseif ($v -is [byte[]]) { 'B:' + [Convert]::ToBase64String($v) }" +
    " else { 'S:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)) }",
  deleteValue:
    OPEN +
    " if ($null -eq $k -or $null -eq $k.GetValue($n)) { 'ABSENT'; exit 0 };" +
    " Remove-ItemProperty -LiteralPath $p -Name $n -ErrorAction Stop; 'DONE'",
  deleteKey: OPEN + " if ($null -eq $k) { 'ABSENT'; exit 0 }; Remove-Item -LiteralPath $p -Recurse -ErrorAction Stop; 'DONE'",
} as const

function run(script: string, path: string, name: string, timeoutMs: number): Promise<string> {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, env: { ...process.env, SNAOS_REG_PATH: path, SNAOS_REG_NAME: name } },
      (err, stdout) => {
        if (err) reject(Object.assign(new Error('registry'), { code: 'regError' }))
        else resolve(String(stdout).trim())
      },
    )
  })
}

export function createWinRegistry(timeoutMs = REGISTRY_TIMEOUT_MS): RegistryAccess {
  const full = (hive: Hive, key: string): string => `${HIVES[hive]}\\${key}`
  return {
    async read(hive, key, name) {
      const out = await run(SCRIPTS.read, full(hive, key), name, timeoutMs)
      if (out === 'ABSENT') return null
      if (out.startsWith('B:')) return Buffer.from(out.slice(2), 'base64')
      if (out.startsWith('S:')) return Buffer.from(out.slice(2), 'base64').toString('utf8')
      throw Object.assign(new Error('registry'), { code: 'regError' })
    },
    async deleteValue(hive, key, name) {
      const out = await run(SCRIPTS.deleteValue, full(hive, key), name, timeoutMs)
      if (out === 'DONE' || out === 'ABSENT') return out === 'DONE' ? 'done' : 'absent'
      throw Object.assign(new Error('registry'), { code: 'regError' })
    },
    async deleteKey(hive, key) {
      const out = await run(SCRIPTS.deleteKey, full(hive, key), '', timeoutMs)
      if (out === 'DONE' || out === 'ABSENT') return out === 'DONE' ? 'done' : 'absent'
      throw Object.assign(new Error('registry'), { code: 'regError' })
    },
  }
}
