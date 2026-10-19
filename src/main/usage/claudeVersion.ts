import { execFile } from 'child_process'

/** Used when `claude --version` cannot be run or parsed. */
export const FALLBACK_CLAUDE_VERSION = '2.0.0'

export type RunVersion = () => Promise<string>

/** `claude --version` prints e.g. "2.0.31 (Claude Code)". */
export function parseClaudeVersion(output: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(output)
  return m ? m[1] : null
}

function runClaudeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fixed command, no user input: `shell` only lets Windows resolve claude.cmd / claude.exe.
    execFile(
      'claude',
      ['--version'],
      { timeout: 4000, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 64 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    )
  })
}

let cached: Promise<string> | null = null

/**
 * The installed Claude Code version, for the usage request's User-Agent. Run
 * once (async), cached for the session; any failure resolves to the fallback
 * constant and is cached too, so a missing CLI never re-spawns on every poll.
 */
export function claudeCliVersion(run: RunVersion = runClaudeVersion): Promise<string> {
  if (!cached) {
    cached = run()
      .then((out) => parseClaudeVersion(out) ?? FALLBACK_CLAUDE_VERSION)
      .catch(() => FALLBACK_CLAUDE_VERSION)
  }
  return cached
}

/** Test seam: forget the cached version. */
export function resetClaudeVersionCache(): void {
  cached = null
}
