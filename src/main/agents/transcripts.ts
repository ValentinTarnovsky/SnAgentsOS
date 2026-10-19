import { existsSync, readdirSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { claudeConfigDir } from '../status/statusDetails'
import { numericDirsDesc, sessionsRoot } from './codexPaths'

/** <CLAUDE_CONFIG_DIR or ~/.claude>/projects, where Claude keeps one folder per launch directory. */
export function claudeProjectsDir(claudeDir = claudeConfigDir()): string {
  return join(claudeDir, 'projects')
}

/**
 * Claude's project folder name for a launch directory: every character that
 * is not an ASCII letter or digit becomes '-' (C:\Users\me\repo ->
 * C--Users-me-repo). `--resume <id>` looks the transcript up there (E5 risk 3).
 * Claude sees a normalized cwd, so a trailing separator the user typed in a
 * pane's folder (C:\repo\) is dropped first; a drive or filesystem root keeps it.
 */
export function claudeSlug(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const dir = trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? cwd : trimmed
  return dir.replace(/[^A-Za-z0-9]/g, '-')
}

/** Expected transcript of a session started in `cwd`. */
export function claudeTranscriptFor(cwd: string, sessionId: string, projectsDir = claudeProjectsDir()): string {
  return join(projectsDir, claudeSlug(cwd), `${sessionId}.jsonl`)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Windows paths compare case-insensitively (a drive letter may come back as c: or C:). */
function sameName(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export interface ClaudeAvailability {
  available: boolean
  reason?: 'transcript' | 'cwd'
}

/**
 * E5-FR-07 for Claude: resumable when the transcript exists, the launch
 * directory exists, and the transcript's folder is that directory's slug.
 * Without a hook-provided transcript path (a record seeded from
 * pane.lastSession) the expected path under the slug is used.
 */
export function claudeAvailability(
  rec: { sessionId: string; spawnCwd?: string; transcriptPath?: string },
  projectsDir = claudeProjectsDir(),
): ClaudeAvailability {
  const transcript = rec.transcriptPath || (rec.spawnCwd ? claudeTranscriptFor(rec.spawnCwd, rec.sessionId, projectsDir) : '')
  if (!transcript || !existsSync(transcript)) return { available: false, reason: 'transcript' }
  if (!rec.spawnCwd || !isDir(rec.spawnCwd)) return { available: false, reason: 'cwd' }
  if (!sameName(basename(dirname(transcript)), claudeSlug(rec.spawnCwd))) return { available: false, reason: 'cwd' }
  return { available: true }
}

/**
 * E5-FR-07 for Codex: true when the thread has a rollout on disk, 'unknown'
 * when it has none (a resume is still attempted, the 20 s watch covers a
 * failure). A launch directory that no longer exists is never resumable.
 */
export function codexAvailability(
  rec: { sessionId: string; spawnCwd?: string },
  index: Pick<CodexRolloutIndex, 'has'> | undefined,
): { available: boolean | 'unknown'; reason?: 'cwd' } {
  if (!rec.spawnCwd || !isDir(rec.spawnCwd)) return { available: false, reason: 'cwd' }
  return { available: index?.has(rec.sessionId) ? true : 'unknown' }
}

/** `rollout-<timestamp>-<uuid>.jsonl` -> uuid (Codex thread id). */
const ROLLOUT_RE = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * Set of Codex thread ids that have a rollout on disk (E5-FR-07). One readdir
 * walk over every YYYY/MM/DD folder (names only, no file reads, no stats);
 * `refresh()` repeats it, which the store does on each Codex session start.
 */
export class CodexRolloutIndex {
  private ids = new Set<string>()
  constructor(private readonly root: () => string = sessionsRoot) {}

  refresh(): void {
    const next = new Set<string>()
    const root = this.root()
    for (const y of numericDirsDesc(root)) {
      for (const m of numericDirsDesc(join(root, y))) {
        for (const d of numericDirsDesc(join(root, y, m))) {
          let files: string[]
          try {
            files = readdirSync(join(root, y, m, d))
          } catch {
            continue
          }
          for (const f of files) {
            const match = ROLLOUT_RE.exec(f)
            if (match) next.add(match[1].toLowerCase())
          }
        }
      }
    }
    this.ids = next
  }

  has(id: string): boolean {
    return this.ids.has(id.toLowerCase())
  }

  get size(): number {
    return this.ids.size
  }
}
