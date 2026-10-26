import { app } from 'electron'
import { basename, delimiter, dirname, join, resolve } from 'path'
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

/** The userData folder name of a dev instance (devUserData.ts). */
const DEV_DATA_DIR_RE = new RegExp(`^${BRAND.devUserDataDir}(?:-[0-9a-f]{8})?$`, 'i')

/**
 * Every launcher directory a parent process may have left in an inherited
 * PATH: the current one, the 1.x one (its userData, also for the 1.x
 * portable) and the default 2.x one, which differs from the current one when
 * userData is overridden (dev build, --user-data-dir) and the app was started
 * from a console of the installed app. A pty or the Codex lookup must never
 * pick any of them up (E0-FR-05): on POSIX the shim taken for the real CLI
 * would recurse into itself. Plus the launcher of any dev instance found on
 * the inherited PATH (plan A1.3: <appData>/snagentsos-dev or
 * snagentsos-dev-<sha8> of a worktree), so a console of one dev instance that
 * starts another, or the installed app, does not hand the first one's shim on.
 */
export function statusBinDirs(): string[] {
  const appData = app.getPath('appData')
  const dirs = [statusBinDir(), join(appData, LEGACY_BRAND.packageName, 'status-bin'), join(appData, BRAND.packageName, 'status-bin')]
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH')
  for (const entry of (pathKey ? process.env[pathKey] ?? '' : '').split(delimiter)) {
    if (!entry.trim()) continue
    const dir = resolve(entry.trim().replace(/^"|"$/g, ''))
    if (basename(dir).toLowerCase() !== 'status-bin' || !DEV_DATA_DIR_RE.test(basename(dirname(dir)))) continue
    if (samePath(dirname(dirname(dir)), appData) && !dirs.some(d => samePath(d, dir))) dirs.push(dir)
  }
  return dirs
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
 * What Claude Code sets in the processes it starts (its tools, hooks); never inherited by a console or a team run
 * (the app launched from inside a Claude session would hand that session's socket, token and pid to its agents).
 * User configuration such as CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX or ANTHROPIC_* is
 * never in here.
 */
const AGENT_SESSION_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_ENV_FILE', 'CLAUDE_CODE_SESSION', 'CLAUDE_CODE_PARENT_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_TMPDIR',
  'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDE_EFFORT', 'CLAUDE_PID',
])

/**
 * A clean env map (node-pty requires string values, no undefined). Variables
 * with our env prefix (new or legacy), ELECTRON_RUN_AS_NODE and AGENT_SESSION_ENV are dropped
 * from the inherited env only, so a console of another instance does not leak its identity; `extra` (the
 * preset env and our own status env) is merged afterwards, unfiltered.
 */
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
