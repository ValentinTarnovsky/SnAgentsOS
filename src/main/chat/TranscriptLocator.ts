/**
 * Which transcript file is a console's chat (E3 M12, FR-24/33/34). In order:
 *
 *  1. Claude with status hooks: the path its main session reported.
 *  2. Claude without hooks: `<claudeRoot>/projects/<slug(cwd)>/*.jsonl`, only
 *     when exactly one local Claude console runs in that folder and exactly
 *     one file there was created after its spawn (minus 5s) and is not held
 *     by another console. Otherwise `ambiguous` (two consoles, or two files)
 *     or `noTranscript` (none).
 *  3. Codex: `rollout-*-<threadId>.jsonl` in today's and yesterday's folders
 *     (then the rest of the tree, names only).
 *
 * A console behind a Connection Profile or running WSL is `notLocal`: its
 * agent writes on another machine. Every path is admitted only when its
 * realpath is a `.jsonl` inside `<claudeRoot>/projects` or `<codexHome>/sessions`
 * (compared case-insensitively on Windows and macOS), so a symlink out of
 * those roots never opens.
 */
import { readdir, realpath, stat } from 'fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'path'
import type { ChatUnavailableReason } from '@shared/chat-types'
import type { AgentProvider, ConfigFile, Pane, Workspace } from '@shared/types'
import { claudeSlug } from '../agents/transcripts'
import { numericDirsDesc } from '../agents/codexPaths'
import type { PaneTranscriptInfo } from '../status/StatusManager'

/** A file created this long before the spawn still counts (clock skew, slow start). */
export const SPAWN_SLACK_MS = 5000
/** Day folders the Codex fallback walks at most (names only). */
const CODEX_WALK_DAYS = 400

export type LocateResult =
  | { ok: true; path: string; provider: AgentProvider }
  | { ok: false; reason: ChatUnavailableReason }

export interface TranscriptLocatorDeps {
  /** <CLAUDE_CONFIG_DIR or ~/.claude>. */
  claudeRoot: () => string
  /** <CODEX_HOME or ~/.codex>/sessions. */
  codexSessions: () => string
  config: () => ConfigFile | null
  /** StatusManager.transcriptFor. */
  status: (paneId: string) => PaneTranscriptInfo | null
  /** PtyManager.getSpawnCwd. */
  spawnCwd: (paneId: string) => string | undefined
  /** StatusManager.spawnedAt. */
  spawnedAt: (paneId: string) => number | undefined
  /** Panes with a live pty. */
  runningPanes: () => string[]
  /** Transcript paths other consoles already hold (normalized with pathKey), pane id per path. */
  claims: () => Map<string, string>
  /** Local date for the Codex day folders; injectable for tests. */
  now?: () => Date
  platform?: NodeJS.Platform
}

function foldCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/** The comparison key of a path (case-folded on Windows and macOS). */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return foldCase(platform) ? p.toLowerCase() : p
}

/** A folder for comparisons: trailing separators off (a drive root keeps its own), case-folded on Windows. */
export function cwdKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const dir = trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? cwd : trimmed
  const norm = platform === 'win32' ? dir.replace(/\//g, '\\') : dir
  return pathKey(norm, platform)
}

/** True when `real` is strictly inside `root` (both realpaths). */
export function isInside(root: string, real: string, platform: NodeJS.Platform = process.platform): boolean {
  const rel = relative(pathKey(root, platform), pathKey(real, platform))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

/** `p`'s realpath when it is a `.jsonl` file inside `root`, else null. */
export async function admit(root: string, p: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (!p || !isAbsolute(p) || !/\.jsonl$/i.test(p)) return null
  const [realRoot, real] = await Promise.all([realOrNull(root), realOrNull(p)])
  if (!realRoot || !real || !/\.jsonl$/i.test(real) || !isInside(realRoot, real, platform)) return null
  try {
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

function findPane(cfg: ConfigFile | null, paneId: string): { pane: Pane; ws: Workspace } | null {
  for (const ws of cfg?.workspaces ?? []) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (pane) return { pane, ws }
  }
  return null
}

const WSL_RE = /^\s*"?(?:[^"\s]*[\\/])?wsl(?:\.exe)?"?(?:\s|$)/i

/** Behind a Connection Profile (pane.setupId ?? workspace.setupId, like launch.ts) or WSL. */
export function isNotLocal(cfg: ConfigFile | null, pane: Pane, ws: Workspace, platform: NodeJS.Platform = process.platform): boolean {
  if (pane.setupId ?? ws.setupId) return true
  const preset = pane.presetId ? cfg?.presets?.find((p) => p.id === pane.presetId) : undefined
  const command = pane.command ?? preset?.command ?? ''
  if (WSL_RE.test(command)) return true
  const shell = cfg?.settings?.defaultShell?.[platform as 'win32' | 'darwin' | 'linux'] ?? ''
  return WSL_RE.test(shell)
}

/** The pane's provider from its config (status unknown). */
function configProvider(cfg: ConfigFile | null, pane: Pane): AgentProvider | null {
  const preset = pane.presetId ? cfg?.presets?.find((p) => p.id === pane.presetId) : undefined
  const type = preset?.type ?? pane.type
  return type === 'claude' || type === 'codex' ? type : null
}

function launchCwd(cfg: ConfigFile | null, pane: Pane, ws: Workspace): string {
  const preset = pane.presetId ? cfg?.presets?.find((p) => p.id === pane.presetId) : undefined
  return pane.cwd ?? preset?.defaultCwd ?? ws.cwd ?? ''
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export class TranscriptLocator {
  private readonly platform: NodeJS.Platform

  constructor(private readonly deps: TranscriptLocatorDeps) {
    this.platform = deps.platform ?? process.platform
  }

  async locate(paneId: string): Promise<LocateResult> {
    const cfg = this.deps.config()
    const found = findPane(cfg, paneId)
    if (!found) return { ok: false, reason: 'noTranscript' }
    const { pane, ws } = found
    if (isNotLocal(cfg, pane, ws, this.platform)) return { ok: false, reason: 'notLocal' }
    const st = this.deps.status(paneId)
    const provider = st?.provider ?? configProvider(cfg, pane)
    if (provider === 'codex') return this.locateCodex(st?.sessionId ?? '')
    if (provider !== 'claude') return { ok: false, reason: 'noTranscript' }
    const projects = join(this.deps.claudeRoot(), 'projects')
    if (st?.transcriptPath) {
      const real = await admit(projects, st.transcriptPath, this.platform)
      if (real) return { ok: true, path: real, provider }
    }
    return this.locateBySlug(paneId, cfg, pane, ws, projects)
  }

  /** Step 2: one local Claude console in the folder and one fresh unclaimed file. */
  private async locateBySlug(paneId: string, cfg: ConfigFile | null, pane: Pane, ws: Workspace, projects: string): Promise<LocateResult> {
    const cwd = this.deps.spawnCwd(paneId) ?? launchCwd(cfg, pane, ws)
    if (!cwd) return { ok: false, reason: 'noTranscript' }
    const key = cwdKey(cwd, this.platform)
    let peers = 0
    for (const other of this.deps.runningPanes()) {
      if (other === paneId) continue
      const f = findPane(cfg, other)
      if (!f || isNotLocal(cfg, f.pane, f.ws, this.platform)) continue
      const prov = this.deps.status(other)?.provider ?? configProvider(cfg, f.pane)
      if (prov !== 'claude') continue
      const otherCwd = this.deps.spawnCwd(other) ?? launchCwd(cfg, f.pane, f.ws)
      if (otherCwd && cwdKey(otherCwd, this.platform) === key) peers++
    }
    if (peers > 0) return { ok: false, reason: 'ambiguous' }
    const dir = join(projects, claudeSlug(cwd))
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => /\.jsonl$/i.test(n))
    } catch {
      return { ok: false, reason: 'noTranscript' }
    }
    const since = (this.deps.spawnedAt(paneId) ?? 0) - SPAWN_SLACK_MS
    const claims = this.deps.claims()
    const fresh: string[] = []
    await Promise.all(
      names.map(async (name) => {
        const p = join(dir, name)
        try {
          const st = await stat(p)
          const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
          if (!st.isFile() || born < since) return
          const real = await admit(projects, p, this.platform)
          if (!real) return
          const holder = claims.get(pathKey(real, this.platform))
          if (holder && holder !== paneId) return
          fresh.push(real)
        } catch {
          /* gone meanwhile */
        }
      }),
    )
    if (fresh.length === 1) return { ok: true, path: fresh[0], provider: 'claude' }
    return { ok: false, reason: fresh.length > 1 ? 'ambiguous' : 'noTranscript' }
  }

  /** Step 3: the rollout of a known thread. */
  private async locateCodex(threadId: string): Promise<LocateResult> {
    if (!/^[0-9a-f-]{8,64}$/i.test(threadId)) return { ok: false, reason: 'noTranscript' }
    const root = this.deps.codexSessions()
    const want = threadId.toLowerCase()
    const match = (name: string): boolean => /^rollout-.*\.jsonl$/i.test(name) && name.toLowerCase().endsWith(`-${want}.jsonl`)
    const now = this.deps.now?.() ?? new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const days = [now, yesterday].map((d) => join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
    const seen = new Set<string>()
    for (const dir of days) {
      seen.add(pathKey(dir, this.platform))
      const hit = await this.findIn(dir, match, root)
      if (hit) return { ok: true, path: hit, provider: 'codex' }
    }
    let walked = 0
    for (const y of numericDirsDesc(root)) {
      for (const m of numericDirsDesc(join(root, y))) {
        for (const d of numericDirsDesc(join(root, y, m))) {
          const dir = join(root, y, m, d)
          if (seen.has(pathKey(dir, this.platform))) continue
          if (++walked > CODEX_WALK_DAYS) return { ok: false, reason: 'noTranscript' }
          const hit = await this.findIn(dir, match, root)
          if (hit) return { ok: true, path: hit, provider: 'codex' }
        }
      }
    }
    return { ok: false, reason: 'noTranscript' }
  }

  private async findIn(dir: string, match: (name: string) => boolean, root: string): Promise<string | null> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return null
    }
    for (const name of names) {
      if (!match(basename(name))) continue
      const real = await admit(root, join(dir, name), this.platform)
      if (real) return real
    }
    return null
  }
}
