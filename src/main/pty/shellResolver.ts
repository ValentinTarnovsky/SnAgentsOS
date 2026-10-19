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
 * PATH: the current one, the 1.x one (its userData, also for the 1.x
 * portable) and the default 2.x one, which differs from the current one when
 * userData is overridden (dev build, --user-data-dir) and the app was started
 * from a console of the installed app. A pty or the Codex lookup must never
 * pick any of them up (E0-FR-05): on POSIX the shim taken for the real CLI
 * would recurse into itself.
 */
export function statusBinDirs(): string[] {
  const appData = app.getPath('appData')
  return [statusBinDir(), join(appData, LEGACY_BRAND.packageName, 'status-bin'), join(appData, BRAND.packageName, 'status-bin')]
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
 * with our env prefix (new or legacy) and ELECTRON_RUN_AS_NODE are dropped
 * from the inherited env only, so a console of another instance does not leak its identity; `extra` (the
 * preset env and our own status env) is merged afterwards, unfiltered.
 */
/** What Claude Code sets in the processes it starts (its tools, hooks); never inherited by a console. */
const AGENT_SESSION_ENV = new Set(['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_ENV_FILE'])

export function cleanEnv(extra?: Record<string, string>, stripDirs: string[] = statusBinDirs()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (upper.startsWith(LEGACY_BRAND.envPrefix) || upper.startsWith(BRAND.envPrefix)) continue
    // A parent's `snaos` shim or Codex launcher may leak Node mode into a shell (E8-FR-13).
    if (upper === 'ELECTRON_RUN_AS_NODE') continue
    // The app started from inside an agent session (a dev run from Claude):
    // its consoles' agents are not that session's sub-sessions.
    if (AGENT_SESSION_ENV.has(upper)) continue
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
