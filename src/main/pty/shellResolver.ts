import { app } from 'electron'
import { delimiter, join, resolve } from 'path'
import { BRAND, LEGACY_BRAND } from '@shared/brand'

/**
 * Resolves the shell to launch for a pty.
 * Native default per OS; callers (presets / panes) may override.
 */
export function defaultShell(): string {
  switch (process.platform) {
    case 'win32':
      // PowerShell is the default shell on Windows.
      return 'powershell.exe'
    case 'darwin':
      return process.env.SHELL || '/bin/zsh'
    default:
      return process.env.SHELL || '/bin/bash'
  }
}

/**
 * Directory of the per-terminal Codex launcher. It lives in userData (not
 * dataDir()) also in the portable build.
 */
export function statusBinDir(): string {
  return join(app.getPath('userData'), 'status-bin')
}

/**
 * Every launcher directory a parent process may have left in an inherited
 * PATH: the current one and the 1.x one (its userData, also for the 1.x
 * portable). A pty or the Codex lookup must never pick either up (E0-FR-05).
 */
export function statusBinDirs(): string[] {
  return [statusBinDir(), join(app.getPath('appData'), LEGACY_BRAND.packageName, 'status-bin')]
}

/** Normalized form for comparing PATH entries (Windows paths ignore case). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p.trim().replace(/^"|"$/g, ''))
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return !!a.trim() && !!b.trim() && norm(a) === norm(b)
}

/**
 * A clean env map (node-pty requires string values, no undefined). Variables
 * with our env prefix (new or legacy) are dropped from the inherited env only,
 * so a console of another instance does not leak its identity; `extra` (the
 * preset env and our own status env) is merged afterwards, unfiltered.
 */
export function cleanEnv(extra?: Record<string, string>, stripDirs: string[] = statusBinDirs()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (upper.startsWith(LEGACY_BRAND.envPrefix) || upper.startsWith(BRAND.envPrefix)) continue
    out[key] = upper === 'PATH'
      ? value.split(delimiter).filter(entry => !stripDirs.some(dir => samePath(entry, dir))).join(delimiter)
      : value
  }
  return { ...out, ...extra }
}

/** Best-effort home directory as a cwd fallback. */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd()
}
