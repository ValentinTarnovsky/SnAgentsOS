import { chmodSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BRAND } from '@shared/brand'

/** What the shim needs: never a token (E8-FR-13). */
export interface ShimTarget {
  /** process.execPath: the Electron exe run with ELECTRON_RUN_AS_NODE. */
  execPath: string
  /** out/main/cli.js (inside the asar when packaged). */
  cliPath: string
  /** dataDir()/runtime.json. */
  runtimePath: string
}

/** Message and exit code when the exe is gone (a closed portable, E8-FR-13). */
export const SHIM_NOT_RUNNING = `${BRAND.productName} is not running`
export const SHIM_NOT_RUNNING_EXIT = 5

/** `%` doubled for a batch file, like CodexBridge.writeLauncher. */
const batch = (s: string): string => s.replace(/%/g, '%%')
const sh = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

/**
 * The Windows shim. `setlocal` keeps ELECTRON_RUN_AS_NODE out of the calling
 * shell; the exe check first, so a closed portable (its temp extraction is
 * gone) exits 5 with a clear message.
 *
 * cmd decodes a batch file with the console code page (850, 437...), so a
 * UTF-8 path with an accent (C:\Users\Martín\...) would never be found. When
 * a path is not plain ASCII the shim switches to code page 65001 for its own
 * lines and restores the caller's page before leaving.
 */
export function windowsShim(t: ShimTarget): string {
  const exe = batch(t.execPath)
  // eslint-disable-next-line no-control-regex
  const utf8 = /[^\x00-\x7f]/.test(t.execPath + t.cliPath + t.runtimePath)
  const restore = utf8 ? 'chcp %_snaos_cp% >nul & ' : ''
  return [
    '@echo off',
    'setlocal',
    ...(utf8 ? ['for /f "tokens=2 delims=:." %%a in (\'chcp\') do set "_snaos_cp=%%a"', 'chcp 65001 >nul'] : []),
    `if not exist "${exe}" (echo ${SHIM_NOT_RUNNING} 1>&2 & ${restore}exit /b ${SHIM_NOT_RUNNING_EXIT})`,
    'set ELECTRON_RUN_AS_NODE=1',
    `"${exe}" "${batch(t.cliPath)}" --runtime "${batch(t.runtimePath)}" %*`,
    ...(utf8 ? ['set "_snaos_rc=%errorlevel%"', 'chcp %_snaos_cp% >nul', 'exit /b %_snaos_rc%'] : ['exit /b %errorlevel%']),
    '',
  ].join('\r\n')
}

/** The POSIX shim (mode 0700). */
export function posixShim(t: ShimTarget): string {
  return [
    '#!/bin/sh',
    `if [ ! -x ${sh(t.execPath)} ]; then echo '${SHIM_NOT_RUNNING}' >&2; exit ${SHIM_NOT_RUNNING_EXIT}; fi`,
    `ELECTRON_RUN_AS_NODE=1 exec ${sh(t.execPath)} ${sh(t.cliPath)} --runtime ${sh(t.runtimePath)} "$@"`,
    '',
  ].join('\n')
}

/** File name of the shim on this platform. */
export function shimFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${BRAND.cliBin}.cmd` : BRAND.cliBin
}

/**
 * (Re)writes `<binDir>/snaos.cmd` (Windows) or `<binDir>/snaos` (POSIX, 0700).
 * Rewritten at every start: the portable's execPath changes per run.
 * Returns the shim path.
 */
export function writeShim(binDir: string, target: ShimTarget, platform: NodeJS.Platform = process.platform): string {
  mkdirSync(binDir, { recursive: true })
  const file = join(binDir, shimFileName(platform))
  if (platform === 'win32') writeFileSync(file, windowsShim(target), 'utf8')
  else {
    writeFileSync(file, posixShim(target), { encoding: 'utf8', mode: 0o700 })
    try {
      chmodSync(file, 0o700)
    } catch {
      /* best effort on odd filesystems */
    }
  }
  return file
}
