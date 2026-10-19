import { readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/** Codex's home, honoring CODEX_HOME (the CLI's own override). */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/** Root of the dated rollout tree: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl. */
export function sessionsRoot(): string {
  return join(codexHome(), 'sessions')
}

/** Numeric child directories (years/months/days), highest value first. */
export function numericDirsDesc(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(b) - Number(a))
  } catch {
    return []
  }
}
