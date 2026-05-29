/**
 * Resolves the shell to launch for a pty.
 * Native default per OS; callers (presets / panes) may override.
 */
export function defaultShell(): string {
  switch (process.platform) {
    case 'win32':
      // PowerShell is the brand default on Windows ("Multi Command Consoles").
      return 'powershell.exe'
    case 'darwin':
      return process.env.SHELL || '/bin/zsh'
    default:
      return process.env.SHELL || '/bin/bash'
  }
}

/** A clean env map (node-pty requires string values, no undefined). */
export function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value
  }
  return { ...out, ...extra }
}

/** Best-effort home directory as a cwd fallback. */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd()
}
