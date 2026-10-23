/**
 * Which transcript file is a console's chat (E3 M12, FR-24/33/34). In order:
 *
 *  1. Claude with status hooks: the path its main session reported.
 *  2. Claude without hooks: `<claudeRoot>/projects/<slug(cwd)>/*.jsonl`, only
 *     when exactly one local Claude console runs in that folder and exactly
 *     one file there was created after its spawn (minus 5s) and is not held
 *     by another console. Otherwise `ambiguous` (two consoles, or two files)
 *     or `noTranscript` (none, or no live pty to date the files against).
 *  3. Codex: `rollout-*-<threadId>.jsonl` in today's and yesterday's folders
 *     (then the rest of the tree, names only).
 *  4. Codex with no thread id (the bridge is off, or the command passes
 *     `--no-daemon`): the one rollout of today's or yesterday's folder created
 *     after the spawn (minus 5s), not held by another console, whose first
 *     record (`session_meta`, read up to 64KB) names the console's folder and
 *     an interactive source. Another local Codex console in that folder, or
 *     two such rollouts, is `ambiguous`.
 *
 * A console behind a Connection Profile or running WSL is `notLocal`: its
 * agent writes on another machine. A local agent console whose transcript
 * does not exist yet (Claude and Codex create it with the first message) is
 * `pending`: its session is known (or it just spawned), so the chat opens
 * empty and the file is picked up when it appears. A title-only track that
 * is `ambiguous` while it boots is `pending` too (its hooks name the session
 * shortly). Every path is admitted only when its
 * realpath is a `.jsonl` inside `<claudeRoot>/projects` or `<codexHome>/sessions`
 * (compared case-insensitively on Windows and macOS), so a symlink out of
 * those roots never opens.
 */
import { open, readdir, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import type { ChatUnavailableReason } from '@shared/chat-types'
import type { AgentProvider, ConfigFile, Pane, Workspace } from '@shared/types'
import { findPaneInConfig, presetOfPane } from '@shared/paneConfig'
import { claudeSlug } from '../agents/transcripts'
import { numericDirsDesc } from '../agents/codexPaths'
import { HISTORY_EDGE_BYTES } from '../history/SessionHistory'
import type { PaneTranscriptInfo } from '../status/StatusManager'

/** A file created this long before the spawn still counts (clock skew, slow start). */
export const SPAWN_SLACK_MS = 5000
/** Day folders the Codex fallback walks at most (names only). */
const CODEX_WALK_DAYS = 400
/** A console with no session reported yet waits this long for one (the agent still booting). */
export const PENDING_BOOT_MS = 2 * 60 * 1000
/** `session_meta.source` of a Codex run nobody types into (a driver's `codex exec`, an MCP call); a subagent's is an object. */
const CODEX_UNATTENDED_SOURCES = new Set(['exec', 'mcp'])

/**
 * `pending`: no transcript yet, but one is coming (a known session whose file
 * the agent has not created, or an agent console that just spawned). `reason`
 * is what to tell the phone if the wait gives up.
 */
export type LocateResult =
  | { ok: true; path: string; provider: AgentProvider }
  | { ok: false; reason: ChatUnavailableReason; pending?: true }

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

/**
 * True when `p` names a `.jsonl` that does not exist yet and would land inside
 * `root`: the deepest folder of it that exists is realpath'd, so a symlink on
 * the way out of the root never counts.
 */
export async function awaitable(root: string, p: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!p || !isAbsolute(p) || !/\.jsonl$/i.test(p)) return false
  try {
    await stat(p)
    return false
  } catch {
    /* not there yet */
  }
  const realRoot = await realOrNull(root)
  if (!realRoot) return false
  let dir = dirname(p)
  const rest: string[] = [basename(p)]
  for (let i = 0; i < 8; i++) {
    const real = await realOrNull(dir)
    if (real) return isInside(realRoot, join(real, ...rest), platform)
    const up = dirname(dir)
    if (up === dir) return false
    rest.unshift(basename(dir))
    dir = up
  }
  return false
}

function findPane(cfg: ConfigFile | null, paneId: string): { pane: Pane; ws: Workspace } | null {
  return findPaneInConfig(cfg, paneId)
}

const WSL_RE = /^\s*"?(?:[^"\s]*[\\/])?wsl(?:\.exe)?"?(?:\s|$)/i

/** Behind a Connection Profile (pane.setupId ?? workspace.setupId, like launch.ts) or WSL. */
export function isNotLocal(cfg: ConfigFile | null, pane: Pane, ws: Workspace, platform: NodeJS.Platform = process.platform): boolean {
  if (pane.setupId ?? ws.setupId) return true
  const preset = presetOfPane(cfg, pane)
  const command = pane.command ?? preset?.command ?? ''
  if (WSL_RE.test(command)) return true
  const shell = cfg?.settings?.defaultShell?.[platform as 'win32' | 'darwin' | 'linux'] ?? ''
  return WSL_RE.test(shell)
}

/** The pane's provider from its config (status unknown). */
function configProvider(cfg: ConfigFile | null, pane: Pane): AgentProvider | null {
  const preset = presetOfPane(cfg, pane)
  const type = preset?.type ?? pane.type
  return type === 'claude' || type === 'codex' ? type : null
}

function launchCwd(cfg: ConfigFile | null, pane: Pane, ws: Workspace): string {
  const preset = presetOfPane(cfg, pane)
  return pane.cwd ?? preset?.defaultCwd ?? ws.cwd ?? ''
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * The payload of a rollout's first record when it is `session_meta`, read
 * from at most the first HISTORY_EDGE_BYTES (a real one is about 20KB), or
 * null (a longer or unfinished first line, another record, an unreadable file).
 */
export async function codexSessionMeta(p: string): Promise<Record<string, unknown> | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(p, 'r')
    const buf = Buffer.alloc(HISTORY_EDGE_BYTES)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const nl = buf.subarray(0, bytesRead).indexOf(10)
    if (nl === -1) return null
    const record: unknown = JSON.parse(buf.subarray(0, nl).toString('utf8'))
    if (!record || typeof record !== 'object') return null
    const { type, payload } = record as { type?: unknown; payload?: unknown }
    return type === 'session_meta' && payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
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
    if (provider === 'codex') {
      return this.orPending(paneId, st, await (st?.sessionId ? this.locateCodex(st.sessionId) : this.locateCodexByCwd(paneId, cfg, pane, ws)))
    }
    if (provider !== 'claude') return { ok: false, reason: 'noTranscript' }
    const projects = join(this.deps.claudeRoot(), 'projects')
    if (st?.transcriptPath) {
      const real = await admit(projects, st.transcriptPath, this.platform)
      if (real) return { ok: true, path: real, provider }
      // The session is known and its file is not written yet (first message).
      if (this.deps.spawnedAt(paneId) !== undefined && (await awaitable(projects, st.transcriptPath, this.platform))) {
        return { ok: false, reason: 'noTranscript', pending: true }
      }
    }
    return this.orPending(paneId, st, await this.locateBySlug(paneId, cfg, pane, ws, projects))
  }

  /**
   * A `noTranscript` of a live local agent console becomes `pending` when its
   * agent reported a session (the file comes with the first message) or the
   * pty spawned less than PENDING_BOOT_MS ago (the session is on its way).
   * v2.2.1: an `ambiguous` of a title-only track (no session reported, so the
   * folder match ran) is `pending` too while the pty boots: hooks name the
   * exact session shortly, and the wait gives up with the notice anyway.
   */
  private orPending(paneId: string, st: PaneTranscriptInfo | null, res: LocateResult): LocateResult {
    if (res.ok) return res
    const spawned = this.deps.spawnedAt(paneId)
    if (spawned === undefined) return res
    const now = this.deps.now?.().getTime() ?? Date.now()
    const booting = now - spawned < PENDING_BOOT_MS
    if (res.reason === 'noTranscript') return st || booting ? { ...res, pending: true } : res
    if (res.reason === 'ambiguous' && st && !st.sessionId && booting) return { ...res, pending: true }
    return res
  }

  /** Other live local consoles of `provider` running in the folder `key`. */
  private peersIn(paneId: string, cfg: ConfigFile | null, key: string, provider: AgentProvider): number {
    let peers = 0
    for (const other of this.deps.runningPanes()) {
      if (other === paneId) continue
      const f = findPane(cfg, other)
      if (!f || isNotLocal(cfg, f.pane, f.ws, this.platform)) continue
      const prov = this.deps.status(other)?.provider ?? configProvider(cfg, f.pane)
      if (prov !== provider) continue
      const otherCwd = this.deps.spawnCwd(other) ?? launchCwd(cfg, f.pane, f.ws)
      if (otherCwd && cwdKey(otherCwd, this.platform) === key) peers++
    }
    return peers
  }

  /** `p`'s realpath when it is a file created at or after `since`, admitted under `root` and not held by another console. */
  private async freshUnclaimed(p: string, root: string, since: number, claims: Map<string, string>, paneId: string): Promise<string | null> {
    try {
      const st = await stat(p)
      const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
      if (!st.isFile() || born < since) return null
      const real = await admit(root, p, this.platform)
      if (!real) return null
      const holder = claims.get(pathKey(real, this.platform))
      return holder && holder !== paneId ? null : real
    } catch {
      return null // gone meanwhile
    }
  }

  /** Today's and yesterday's Codex day folders (local date). */
  private codexDays(root: string): string[] {
    const now = this.deps.now?.() ?? new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    return [now, yesterday].map((d) => join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
  }

  /** Step 2: one local Claude console in the folder and one fresh unclaimed file. */
  private async locateBySlug(paneId: string, cfg: ConfigFile | null, pane: Pane, ws: Workspace, projects: string): Promise<LocateResult> {
    const cwd = this.deps.spawnCwd(paneId) ?? launchCwd(cfg, pane, ws)
    if (!cwd) return { ok: false, reason: 'noTranscript' }
    if (this.peersIn(paneId, cfg, cwdKey(cwd, this.platform), 'claude') > 0) return { ok: false, reason: 'ambiguous' }
    const dir = join(projects, claudeSlug(cwd))
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => /\.jsonl$/i.test(n))
    } catch {
      return { ok: false, reason: 'noTranscript' }
    }
    // No live pty, no session to match: without a spawn time every file of
    // the folder would count, and an old transcript could pass for this one.
    const spawned = this.deps.spawnedAt(paneId)
    if (spawned === undefined) return { ok: false, reason: 'noTranscript' }
    const since = spawned - SPAWN_SLACK_MS
    const claims = this.deps.claims()
    const fresh = (await Promise.all(names.map((name) => this.freshUnclaimed(join(dir, name), projects, since, claims, paneId)))).filter((p): p is string => !!p)
    if (fresh.length === 1) return { ok: true, path: fresh[0], provider: 'claude' }
    return { ok: false, reason: fresh.length > 1 ? 'ambiguous' : 'noTranscript' }
  }

  /** Step 3: the rollout of a known thread. */
  private async locateCodex(threadId: string): Promise<LocateResult> {
    if (!/^[0-9a-f-]{8,64}$/i.test(threadId)) return { ok: false, reason: 'noTranscript' }
    const root = this.deps.codexSessions()
    const want = threadId.toLowerCase()
    const match = (name: string): boolean => /^rollout-.*\.jsonl$/i.test(name) && name.toLowerCase().endsWith(`-${want}.jsonl`)
    const seen = new Set<string>()
    for (const dir of this.codexDays(root)) {
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

  /**
   * Step 4: a Codex console with no thread id. One local Codex console in the
   * folder and one fresh unclaimed rollout of today or yesterday whose
   * `session_meta` names that folder; a driver's `codex exec` or a subagent
   * there never counts. Between an interactive TUI rollout (`cli`) and others
   * (Codex Desktop), the TUI one is this console's.
   */
  private async locateCodexByCwd(paneId: string, cfg: ConfigFile | null, pane: Pane, ws: Workspace): Promise<LocateResult> {
    const cwd = this.deps.spawnCwd(paneId) ?? launchCwd(cfg, pane, ws)
    if (!cwd) return { ok: false, reason: 'noTranscript' }
    const key = cwdKey(cwd, this.platform)
    if (this.peersIn(paneId, cfg, key, 'codex') > 0) return { ok: false, reason: 'ambiguous' }
    const spawned = this.deps.spawnedAt(paneId)
    if (spawned === undefined) return { ok: false, reason: 'noTranscript' }
    const since = spawned - SPAWN_SLACK_MS
    const root = this.deps.codexSessions()
    const claims = this.deps.claims()
    const hits: Array<{ path: string; tui: boolean }> = []
    for (const dir of this.codexDays(root)) {
      let names: string[]
      try {
        names = (await readdir(dir)).filter((n) => /^rollout-.*\.jsonl$/i.test(n))
      } catch {
        continue
      }
      await Promise.all(
        names.map(async (name) => {
          const real = await this.freshUnclaimed(join(dir, name), root, since, claims, paneId)
          const meta = real ? await codexSessionMeta(real) : null
          if (!real || !meta || typeof meta.cwd !== 'string' || cwdKey(meta.cwd, this.platform) !== key) return
          const source = meta.source
          if (source !== undefined && (typeof source !== 'string' || CODEX_UNATTENDED_SOURCES.has(source))) return
          hits.push({ path: real, tui: source === 'cli' })
        }),
      )
    }
    const tui = hits.filter((h) => h.tui)
    const pick = hits.length === 1 ? hits[0] : tui.length === 1 ? tui[0] : null
    if (pick) return { ok: true, path: pick.path, provider: 'codex' }
    return { ok: false, reason: hits.length ? 'ambiguous' : 'noTranscript' }
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
