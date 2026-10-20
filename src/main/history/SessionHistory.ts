/**
 * Session history (E3-FR-36..40): an in-memory index of the Claude
 * transcripts (<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/<id>.jsonl)
 * and the Codex rollouts (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl)
 * on this PC, for the phone's History screen and `sessions:list`.
 *
 *  - Each file is keyed by (path, mtime, size): only a new or changed file is
 *    read again, and only its first and last 64KB (title, cwd, last message,
 *    date). At most 1000 files per provider, the most recently written.
 *  - The exact message count is a background job (one file every 50ms),
 *    cached with the entry and exposed only by `sessions:list`. A file that
 *    grew (transcripts are append-only) is counted from where the last count
 *    stopped, so a live session of hundreds of MB is never read whole again.
 *  - Sessions without a real prompt (only slash commands, an empty start)
 *    and sessions without an absolute cwd are never listed.
 *  - Workspace scope (E3-FR-36): the workspace cwd plus each pane's
 *    `pane.cwd ?? preset.defaultCwd ?? workspace.cwd` (resolveLaunch's
 *    precedence), compared resolved, without a trailing separator and
 *    case-insensitively on win32. Codex filters by the cwd of its first
 *    `session_meta` record (E3-FR-40).
 *  - Codex prompts and replies come from `event_msg` user / agent messages,
 *    or, in a rollout without them (Codex 0.163 on), from the `response_item`
 *    messages, injected context skipped.
 *
 * Only regular files directly inside the scanned folders are read (a symlink
 * or a subagent folder is skipped), and nothing read here is ever written
 * back or logged with content.
 */
import { open, readdir, stat } from 'fs/promises'
import { join, posix, win32 } from 'path'
import type { AgentProvider, ConfigFile, PaneStatusEvt } from '@shared/types'
import type { RemoteHistorySession } from '@shared/remote-protocol'
import { isHistorySessionId, type SessionSummary, type SessionsListReq } from '@shared/session-history'
import { claudeProjectsDir } from '../agents/transcripts'
import { numericDirsDesc, sessionsRoot } from '../agents/codexPaths'

/** Bytes read from each end of a file for its summary. */
export const HISTORY_EDGE_BYTES = 64 * 1024
/** Files indexed per provider (the most recently written). */
export const HISTORY_MAX_PER_SCOPE = 1000
/** Pause between two background message counts. */
export const HISTORY_COUNT_INTERVAL_MS = 50
/** A query within this long of the last scan reuses it. */
export const HISTORY_RESCAN_MS = 2000
/**
 * A resume id missing from the index rescans at once, but not more often
 * than this: a phone cannot turn unknown ids into back-to-back full scans.
 */
export const HISTORY_FORCED_RESCAN_MS = 1000
/** First prompt used as a title, in characters (E3-FR-37). */
export const HISTORY_PROMPT_TITLE_MAX = 60
const TITLE_MAX = 120
const LAST_MESSAGE_MAX = 280
const CWD_MAX = 1024
const READ_CONCURRENCY = 8
const COUNT_CHUNK = 256 * 1024

/** `rollout-<timestamp>-<uuid>.jsonl` -> uuid. */
const ROLLOUT_RE = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
/**
 * Text Claude writes as a user record that the user never typed: slash
 * command wrappers, local command output, caveats, hook and system notes.
 */
const CLAUDE_SYNTHETIC_RE = /^(<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|system-reminder|user-prompt-submit-hook)>|Caveat: |\[Request interrupted by user)/
/** Context blocks Codex sends as user messages. */
const CODEX_SYNTHETIC_RE = /^<(environment_context|user_instructions|user_shell_command|turn_aborted)>/
/**
 * v2.2.1: context Codex 0.163 writes as a user `response_item` that nobody
 * typed: AGENTS.md, the environment, and any `<tag>` block an app injects
 * (heartbeat, skills, delegation...).
 */
const CODEX_ITEM_INJECTED_RE = /^(# AGENTS\.md instructions|<INSTRUCTIONS>|<[a-z][a-z0-9_-]*>)/
/** Codex Desktop puts the attachments first and the request under this heading. */
const CODEX_REQUEST_RE = /\n## My request(?: for Codex)?:[ \t]*\n([\s\S]*)$/

/** One line of text: control characters out, runs of whitespace collapsed. */
function oneLine(text: string): string {
  return text.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).trimEnd() : text
}

/** A cwd the history may hand to a new console: absolute, bounded, no control characters. */
export function isUsableCwd(cwd: unknown): cwd is string {
  if (typeof cwd !== 'string' || !cwd || cwd.length > CWD_MAX || /[\x00-\x1f\x7f]/.test(cwd)) return false
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(cwd)
}

/**
 * The comparable form of a directory (E3-FR-36): resolved, without a
 * trailing separator and lower-cased on win32, so C:\Repo\ and c:\repo match.
 */
export function normalizeCwd(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32'
  const resolved = (win ? win32 : posix).resolve(cwd)
  const trimmed = resolved.length > 1 && !/^[A-Za-z]:\\$/.test(resolved) ? resolved.replace(/[\\/]+$/, '') : resolved
  return win ? trimmed.toLowerCase() : trimmed
}

/**
 * Every directory a workspace's consoles run in (E3-FR-36): `workspace.cwd`
 * and, per pane, `pane.cwd ?? preset.defaultCwd ?? workspace.cwd`. Empty when
 * the workspace does not exist.
 */
export function workspaceCwds(cfg: ConfigFile | null, workspaceId: string, platform: NodeJS.Platform = process.platform): Set<string> {
  const out = new Set<string>()
  const ws = cfg?.workspaces?.find((w) => w.id === workspaceId)
  if (!ws) return out
  const add = (dir: string | undefined): void => {
    if (typeof dir === 'string' && dir.trim()) out.add(normalizeCwd(dir, platform))
  }
  add(ws.cwd)
  for (const pane of ws.panes ?? []) {
    const preset = pane.presetId ? cfg?.presets?.find((p) => p.id === pane.presetId) : undefined
    add(pane.cwd ?? preset?.defaultCwd ?? ws.cwd)
  }
  return out
}

// --- Record parsing (pure, exported for tests) ---------------------------------

/** What the head and tail of one file said about its session. */
export interface SessionDraft {
  sessionId?: string
  cwd?: string
  customTitle?: string
  summary?: string
  firstPrompt?: string
  lastMessage?: string
  lastAt?: number
}

function parseLines(text: string, dropFirst: boolean, dropLast: boolean): unknown[] {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  const out: unknown[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line[0] !== '{') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a partial or foreign line */
    }
  }
  return out
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function timeOf(r: Record<string, unknown>): number | undefined {
  const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
  return Number.isFinite(t) ? t : undefined
}

/** Plain text of a Claude message content (string, or its text blocks). Null when it holds a tool result. */
function claudeText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    const b = rec(block)
    if (!b) continue
    if (b.type === 'tool_result') return null
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** A prompt the user typed in a Claude session, or null for anything else. */
export function claudePrompt(entry: unknown): string | null {
  const r = rec(entry)
  if (!r || r.type !== 'user' || r.isSidechain === true || r.isMeta === true || r.isCompactSummary === true) return null
  const message = rec(r.message)
  if (!message || (message.role !== undefined && message.role !== 'user')) return null
  const text = claudeText(message.content)
  if (text == null) return null
  const trimmed = text.trim()
  if (!trimmed || CLAUDE_SYNTHETIC_RE.test(trimmed)) return null
  return trimmed
}

/** Assistant text of a main-thread Claude record, or null. */
export function claudeReply(entry: unknown): string | null {
  const r = rec(entry)
  if (!r || r.type !== 'assistant' || r.isSidechain === true) return null
  const text = claudeText(rec(r.message)?.content)
  return text && text.trim() ? text.trim() : null
}

function applyClaude(draft: SessionDraft, entries: unknown[], fromHead: boolean): void {
  for (const entry of entries) {
    const r = rec(entry)
    if (!r) continue
    if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) draft.customTitle = r.customTitle
    else if (r.type === 'summary' && typeof r.summary === 'string' && r.summary.trim()) draft.summary = r.summary
    if (!draft.cwd && isUsableCwd(r.cwd)) draft.cwd = r.cwd
    if (!draft.sessionId && typeof r.sessionId === 'string' && isHistorySessionId(r.sessionId) && r.isSidechain !== true) draft.sessionId = r.sessionId
    const at = timeOf(r)
    if (at !== undefined && (draft.lastAt === undefined || at > draft.lastAt)) draft.lastAt = at
    const prompt = claudePrompt(r)
    if (prompt && fromHead && draft.firstPrompt === undefined) draft.firstPrompt = prompt
    const message = prompt ?? claudeReply(r)
    if (message) draft.lastMessage = message
  }
}

/** Summary of a Claude transcript from its head (and tail, for a file past 64KB). */
export function summarizeClaude(head: string, tail: string | null, truncatedHead: boolean): SessionDraft {
  const draft: SessionDraft = {}
  applyClaude(draft, parseLines(head, false, truncatedHead), true)
  // No prompt in the first 64KB (a huge first record): the tail may hold one.
  if (tail != null) {
    const tailEntries = parseLines(tail, true, false)
    applyClaude(draft, tailEntries, draft.firstPrompt === undefined)
  }
  return draft
}

/** A prompt the user typed in a Codex session (event_msg user_message, before Codex 0.163), or null. */
export function codexPrompt(entry: unknown): string | null {
  const r = rec(entry)
  const p = r && r.type === 'event_msg' ? rec(r.payload) : null
  if (!p || p.type !== 'user_message' || typeof p.message !== 'string') return null
  const text = p.message.trim()
  return text && !CODEX_SYNTHETIC_RE.test(text) ? text : null
}

/** Reply text of a Codex record (event_msg agent_message, before Codex 0.163), or null. */
export function codexReply(entry: unknown): string | null {
  const r = rec(entry)
  const p = r && r.type === 'event_msg' ? rec(r.payload) : null
  if (!p || p.type !== 'agent_message' || typeof p.message !== 'string') return null
  return p.message.trim() || null
}

/** An event_msg user / agent message record of any text (the format before Codex 0.163). */
function isCodexEventMessage(entry: unknown): boolean {
  const r = rec(entry)
  const p = r && r.type === 'event_msg' ? rec(r.payload) : null
  return !!p && (p.type === 'user_message' || p.type === 'agent_message')
}

/** Text of a `response_item` message of `role` (its text parts joined, as decodeCodex reads them), or null. */
function codexItemText(entry: unknown, role: 'user' | 'assistant'): string | null {
  const r = rec(entry)
  const p = r && r.type === 'response_item' ? rec(r.payload) : null
  if (!p || p.type !== 'message' || p.role !== role) return null
  const parts: string[] = []
  if (typeof p.content === 'string') parts.push(p.content)
  else if (Array.isArray(p.content)) {
    for (const part of p.content) {
      const b = rec(part)
      if (b && typeof b.text === 'string' && /^(input_text|output_text|text)$/.test(String(b.type))) parts.push(b.text)
    }
  }
  return parts.join('\n').trim() || null
}

/**
 * v2.2.1: a prompt the user typed, from a Codex 0.163 rollout (no event_msg
 * user_message any more): a user `response_item` message that is not
 * injected context; a Codex Desktop message with attachments gives its request.
 */
export function codexItemPrompt(entry: unknown): string | null {
  const text = codexItemText(entry, 'user')
  if (!text || CODEX_ITEM_INJECTED_RE.test(text)) return null
  const request = CODEX_REQUEST_RE.exec(text)
  return request ? request[1].trim() || null : text
}

/** v2.2.1: reply text of a Codex 0.163 rollout (an assistant `response_item` message), or null. */
export function codexItemReply(entry: unknown): string | null {
  return codexItemText(entry, 'assistant')
}

/**
 * True when the records hold no event_msg user / agent message (Codex 0.163
 * on): their response_item twins stand in. Older rollouts write both, so the
 * twins are never read there (no doubled messages).
 */
function codexUsesItems(entries: unknown[]): boolean {
  return !entries.some(isCodexEventMessage)
}

function applyCodex(draft: SessionDraft, entries: unknown[], fromHead: boolean, items: boolean): void {
  for (const entry of entries) {
    const r = rec(entry)
    if (!r) continue
    // The cwd and id come from the first session_meta only (E3-FR-40).
    if (fromHead && r.type === 'session_meta' && draft.cwd === undefined) {
      const p = rec(r.payload)
      draft.cwd = isUsableCwd(p?.cwd) ? (p!.cwd as string) : ''
      if (typeof p?.id === 'string' && isHistorySessionId(p.id)) draft.sessionId = p.id
    }
    const at = timeOf(r)
    if (at !== undefined && (draft.lastAt === undefined || at > draft.lastAt)) draft.lastAt = at
    const prompt = items ? codexItemPrompt(r) : codexPrompt(r)
    if (prompt && fromHead && draft.firstPrompt === undefined) draft.firstPrompt = prompt
    const message = prompt ?? (items ? codexItemReply(r) : codexReply(r))
    if (message) draft.lastMessage = message
  }
}

/** Summary of a Codex rollout from its head (and tail, for a file past 64KB). */
export function summarizeCodex(head: string, tail: string | null, truncatedHead: boolean): SessionDraft {
  const draft: SessionDraft = {}
  const headEntries = parseLines(head, false, truncatedHead)
  const tailEntries = tail != null ? parseLines(tail, true, false) : []
  const items = codexUsesItems([...headEntries, ...tailEntries])
  applyCodex(draft, headEntries, true, items)
  if (tail != null) applyCodex(draft, tailEntries, draft.firstPrompt === undefined, items)
  return draft
}

/** E3-FR-37: custom title, else summary, else the first real prompt cut to 60. */
export function sessionTitle(draft: Pick<SessionDraft, 'customTitle' | 'summary' | 'firstPrompt'>): string {
  const custom = draft.customTitle ? oneLine(draft.customTitle) : ''
  if (custom) return clip(custom, TITLE_MAX)
  const summary = draft.summary ? oneLine(draft.summary) : ''
  if (summary) return clip(summary, TITLE_MAX)
  return clip(oneLine(draft.firstPrompt ?? ''), HISTORY_PROMPT_TITLE_MAX)
}

/** One message counted by the background job (a real prompt or a reply). */
export function countsAsMessage(provider: AgentProvider, entry: unknown): boolean {
  return provider === 'claude' ? claudePrompt(entry) != null || claudeReply(entry) != null : codexPrompt(entry) != null || codexReply(entry) != null
}

// --- Filtering ------------------------------------------------------------------

/** E3-FR-36: title or last message contains `query` (case-insensitive), or it is the exact id. */
export function matchesQuery(s: Pick<SessionSummary, 'sessionId' | 'title' | 'lastMessage'>, query: string | undefined): boolean {
  const q = query?.trim()
  if (!q) return true
  if (s.sessionId.toLowerCase() === q.toLowerCase()) return true
  const needle = q.toLowerCase()
  return s.title.toLowerCase().includes(needle) || s.lastMessage.toLowerCase().includes(needle)
}

// --- The index --------------------------------------------------------------------

interface FileRef {
  path: string
  provider: AgentProvider
  /** Id from the file name; the records may confirm it. */
  nameId: string
  mtimeMs: number
  size: number
}

interface Entry extends FileRef {
  summary: SessionSummary | null
  /** normalizeCwd(summary.cwd), cached for the scope filter. */
  normCwd: string
}

/** A console holding a session right now (status) or last (pane.lastSession). */
export interface OpenSessionRef {
  paneId: string
  provider?: AgentProvider
  sessionId: string
}

export interface SessionHistoryDeps {
  /** <CLAUDE_CONFIG_DIR or ~/.claude>/projects, read on every scan. */
  claudeProjectsDir?: () => string
  /** <CODEX_HOME>/sessions, read on every scan. */
  codexSessionsRoot?: () => string
  getConfig: () => ConfigFile | null
  /** Sessions open in a console, for historyRes.paneId (E3-FR-38). */
  openSessions?: () => OpenSessionRef[]
  platform?: NodeJS.Platform
  now?: () => number
  /** Floor between two forced rescans (HISTORY_FORCED_RESCAN_MS; tests pass 0). */
  forcedRescanMs?: number
  /** Background count timer (tests pass their own). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Open sessions from the live statuses first, then each pane's lastSession. */
export function openSessionsOf(statuses: PaneStatusEvt[], cfg: ConfigFile | null): OpenSessionRef[] {
  const out: OpenSessionRef[] = []
  const live = new Set((cfg?.workspaces ?? []).flatMap((w) => (w.panes ?? []).map((p) => p.id)))
  for (const s of statuses) if (s.sessionId && live.has(s.paneId)) out.push({ paneId: s.paneId, provider: s.provider, sessionId: s.sessionId })
  for (const ws of cfg?.workspaces ?? []) {
    for (const pane of ws.panes ?? []) {
      if (pane.lastSession?.sessionId) out.push({ paneId: pane.id, provider: pane.lastSession.provider, sessionId: pane.lastSession.sessionId })
    }
  }
  return out
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export class SessionHistory {
  private entries = new Map<string, Entry>()
  /** path -> message count, valid for the (mtime, size) it was counted at; `progress` resumes a grown file. */
  private counts = new Map<string, { mtimeMs: number; size: number; count: number; progress: CountProgress }>()
  private scanning: Promise<void> | null = null
  private scannedAt = -Infinity
  private countTimer: unknown = null
  private counting = false
  private disposed = false
  private readonly platform: NodeJS.Platform
  private readonly now: () => number

  constructor(private readonly deps: SessionHistoryDeps) {
    this.platform = deps.platform ?? process.platform
    this.now = deps.now ?? Date.now
  }

  // --- Queries ---

  /** `sessions:list` (E3-FR-36): newest first, with lastMessage and messageCount. */
  async list(req: SessionsListReq = {}): Promise<SessionSummary[]> {
    await this.refresh()
    const cwd = typeof req.cwd === 'string' && req.cwd.trim() ? normalizeCwd(req.cwd, this.platform) : null
    return this.sorted()
      .filter((e) => (!cwd || e.normCwd === cwd) && matchesQuery(e.summary!, req.query))
      .map((e) => ({ ...e.summary!, messageCount: this.countOf(e) }))
  }

  /**
   * historyReq (E3-FR-36..38): newest first, filtered by `query` and, with a
   * workspace, by its directories. The caller caps it at 100 and 48KB.
   */
  async forRemote(req: { query?: string; workspaceId?: string }): Promise<RemoteHistorySession[]> {
    await this.refresh()
    const scope = req.workspaceId ? workspaceCwds(this.deps.getConfig(), req.workspaceId, this.platform) : null
    const open = new Map<string, string>()
    for (const ref of this.deps.openSessions?.() ?? []) {
      for (const provider of ref.provider ? [ref.provider] : (['claude', 'codex'] as const)) {
        const key = `${provider}:${ref.sessionId.toLowerCase()}`
        if (!open.has(key)) open.set(key, ref.paneId)
      }
    }
    const out: RemoteHistorySession[] = []
    for (const e of this.sorted()) {
      const s = e.summary!
      if (scope && !scope.has(e.normCwd)) continue
      if (!matchesQuery(s, req.query)) continue
      const paneId = open.get(`${s.provider}:${s.sessionId.toLowerCase()}`)
      out.push({ provider: s.provider, sessionId: s.sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, ...(paneId ? { paneId } : {}) })
    }
    return out
  }

  /**
   * E3-FR-39: the id is a history id and that session is in the index. A
   * miss rescans once at once (a session started seconds ago).
   */
  async has(provider: AgentProvider, sessionId: string): Promise<boolean> {
    if (!isHistorySessionId(sessionId)) return false
    await this.refresh()
    if (this.find(provider, sessionId)) return true
    await this.refresh(true)
    return !!this.find(provider, sessionId)
  }

  private find(provider: AgentProvider, sessionId: string): Entry | undefined {
    const id = sessionId.toLowerCase()
    for (const e of this.entries.values()) if (e.summary && e.provider === provider && e.summary.sessionId.toLowerCase() === id) return e
    return undefined
  }

  private sorted(): Entry[] {
    return [...this.entries.values()].filter((e) => e.summary).sort((a, b) => b.summary!.updatedAt - a.summary!.updatedAt)
  }

  private countOf(e: Entry): number | null {
    const c = this.counts.get(e.path)
    return c && c.mtimeMs === e.mtimeMs && c.size === e.size ? c.count : null
  }

  // --- Scanning ---

  /** Rescan unless the last scan is fresh; concurrent callers share one scan. */
  refresh(force = false): Promise<void> {
    if (this.scanning) return this.scanning
    const age = this.now() - this.scannedAt
    if (age < (force ? (this.deps.forcedRescanMs ?? HISTORY_FORCED_RESCAN_MS) : HISTORY_RESCAN_MS)) return Promise.resolve()
    this.scanning = this.scan()
      .catch(() => undefined)
      .finally(() => {
        this.scannedAt = this.now()
        this.scanning = null
        this.scheduleCount()
      })
    return this.scanning
  }

  private async scan(): Promise<void> {
    const [claude, codex] = await Promise.all([this.listClaude(), this.listCodex()])
    const next = new Map<string, Entry>()
    const fresh: FileRef[] = []
    for (const ref of [...newest(claude), ...newest(codex)]) {
      const old = this.entries.get(ref.path)
      if (old && old.mtimeMs === ref.mtimeMs && old.size === ref.size) next.set(ref.path, old)
      else fresh.push(ref)
    }
    const built = await mapLimit(fresh, READ_CONCURRENCY, (ref) => this.read(ref))
    for (const entry of built) next.set(entry.path, entry)
    this.entries = next
    for (const path of [...this.counts.keys()]) if (!next.has(path)) this.counts.delete(path)
  }

  private async listClaude(): Promise<FileRef[]> {
    const root = (this.deps.claudeProjectsDir ?? claudeProjectsDir)()
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
    const names: Array<{ path: string; id: string }> = []
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const files = await readdir(join(root, dir.name), { withFileTypes: true }).catch(() => [])
      for (const f of files) {
        if (!f.isFile() || !/\.jsonl$/i.test(f.name)) continue
        const id = f.name.slice(0, -'.jsonl'.length)
        if (isHistorySessionId(id)) names.push({ path: join(root, dir.name, f.name), id })
      }
    }
    return this.statAll(names, 'claude')
  }

  private async listCodex(): Promise<FileRef[]> {
    const root = (this.deps.codexSessionsRoot ?? sessionsRoot)()
    const names: Array<{ path: string; id: string }> = []
    // Newest folders first: stop once the scope is full (names hold the time).
    outer: for (const y of numericDirsDesc(root)) {
      for (const m of numericDirsDesc(join(root, y))) {
        for (const d of numericDirsDesc(join(root, y, m))) {
          const dir = join(root, y, m, d)
          const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
          const day = files.filter((f) => f.isFile() && ROLLOUT_RE.test(f.name)).map((f) => f.name).sort().reverse()
          for (const name of day) {
            names.push({ path: join(dir, name), id: ROLLOUT_RE.exec(name)![1] })
            if (names.length >= HISTORY_MAX_PER_SCOPE * 2) break outer
          }
        }
      }
    }
    return this.statAll(names, 'codex')
  }

  private async statAll(names: Array<{ path: string; id: string }>, provider: AgentProvider): Promise<FileRef[]> {
    const refs = await mapLimit(names, 32, async ({ path, id }) => {
      try {
        const st = await stat(path)
        return st.isFile() ? { path, provider, nameId: id, mtimeMs: st.mtimeMs, size: st.size } : null
      } catch {
        return null
      }
    })
    return refs.filter((r): r is FileRef => r !== null)
  }

  private async read(ref: FileRef): Promise<Entry> {
    const entry: Entry = { ...ref, summary: null, normCwd: '' }
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(ref.path, 'r')
      // Up to two edges' worth is read whole; past that, the first and last
      // 64KB, each without its cut line.
      const whole = ref.size <= 2 * HISTORY_EDGE_BYTES
      const head = Buffer.alloc(whole ? ref.size : HISTORY_EDGE_BYTES)
      await handle.read(head, 0, head.length, 0)
      let tail: string | null = null
      if (!whole) {
        const buf = Buffer.alloc(HISTORY_EDGE_BYTES)
        await handle.read(buf, 0, buf.length, ref.size - HISTORY_EDGE_BYTES)
        tail = buf.toString('utf8')
      }
      const text = head.toString('utf8')
      const draft = ref.provider === 'claude' ? summarizeClaude(text, tail, !whole) : summarizeCodex(text, tail, !whole)
      entry.summary = this.toSummary(ref, draft)
      if (entry.summary) entry.normCwd = normalizeCwd(entry.summary.cwd, this.platform)
    } catch {
      entry.summary = null
    } finally {
      await handle?.close().catch(() => undefined)
    }
    return entry
  }

  private toSummary(ref: FileRef, draft: SessionDraft): SessionSummary | null {
    // E3-FR-37: no real prompt = an empty session, never listed. No cwd = nowhere to resume.
    if (!draft.firstPrompt && !draft.customTitle && !draft.summary) return null
    if (!draft.lastMessage && !draft.firstPrompt) return null
    if (!draft.cwd || !isUsableCwd(draft.cwd)) return null
    const sessionId = ref.provider === 'claude' ? ref.nameId : (draft.sessionId ?? ref.nameId)
    if (!isHistorySessionId(sessionId)) return null
    const title = sessionTitle(draft)
    if (!title) return null
    return {
      provider: ref.provider,
      sessionId,
      cwd: draft.cwd,
      title,
      updatedAt: draft.lastAt ?? Math.round(ref.mtimeMs),
      lastMessage: clip(oneLine(draft.lastMessage ?? ''), LAST_MESSAGE_MAX),
      messageCount: null,
    }
  }

  // --- Background message count ---

  private scheduleCount(): void {
    if (this.disposed || this.countTimer || this.counting) return
    if (!this.nextUncounted()) return
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    })
    this.countTimer = set(() => {
      this.countTimer = null
      void this.countNext().finally(() => this.scheduleCount())
    }, HISTORY_COUNT_INTERVAL_MS)
  }

  private nextUncounted(): Entry | undefined {
    for (const e of this.sorted()) if (this.countOf(e) === null) return e
    return undefined
  }

  /** Count one file (newest uncounted first). False when nothing is left. */
  async countNext(): Promise<boolean> {
    const e = this.nextUncounted()
    if (!e) return false
    this.counting = true
    try {
      // Grown since the last count: carry on from its last complete line.
      const prev = this.counts.get(e.path)
      const from = prev && e.size >= prev.progress.offset ? prev.progress : undefined
      const res = await countMessagesFrom(e.path, e.provider, from)
      this.counts.set(e.path, res ? { mtimeMs: e.mtimeMs, size: e.size, count: res.count, progress: res.progress } : { mtimeMs: e.mtimeMs, size: e.size, count: 0, progress: { offset: 0, count: 0 } })
    } finally {
      this.counting = false
    }
    return true
  }

  dispose(): void {
    this.disposed = true
    if (this.countTimer) (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.countTimer)
    this.countTimer = null
  }
}

/** The HISTORY_MAX_PER_SCOPE most recently written files. */
function newest(refs: FileRef[]): FileRef[] {
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, HISTORY_MAX_PER_SCOPE)
}

/** Where a count stopped: the byte after its last complete line, and the messages before it. */
export interface CountProgress {
  offset: number
  count: number
  /**
   * v2.2.1, Codex only: the response_item messages before `offset`, the
   * count of a rollout with no event_msg message (Codex 0.163 on).
   */
  items?: number
}

/** Exact message count of one file, read in chunks; null when it cannot be read. */
export async function countMessages(path: string, provider: AgentProvider): Promise<number | null> {
  return (await countMessagesFrom(path, provider))?.count ?? null
}

/**
 * countMessages from `from` on (a file that only grew since): `count` also
 * holds an unterminated last line, `progress` stops before it so the next
 * count reads that line again once it is complete. Null when unreadable.
 */
export async function countMessagesFrom(
  path: string,
  provider: AgentProvider,
  from?: CountProgress,
): Promise<{ count: number; progress: CountProgress } | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    const buf = Buffer.alloc(COUNT_CHUNK)
    let pos = from?.offset ?? 0
    let lineStart = pos
    let count = from?.count ?? 0
    // v2.2.1: Codex 0.163 messages (response_item), counted on the side.
    let items = from?.items ?? 0
    const codex = provider === 'codex'
    // Bytes of the line being read, split across chunks. Lines are cut at
    // newline bytes, which never sit inside a multi-byte UTF-8 character.
    let pending: Buffer[] = []
    /** 'message': a counted record; 'item': a Codex response_item message. */
    const take = (bytes: Buffer): 'message' | 'item' | null => {
      // Byte-level pre-filter: most lines are never decoded at all.
      if (!codex ? bytes.indexOf('"user"') === -1 && bytes.indexOf('"assistant"') === -1 : bytes.indexOf('user_message') === -1 && bytes.indexOf('agent_message') === -1 && bytes.indexOf('"role"') === -1) return null
      const s = bytes.toString('utf8').trim()
      if (!s || s[0] !== '{') return null
      // Cheap pre-filter before JSON.parse: every counted record names its type.
      if (!codex ? !/"type"\s*:\s*"(user|assistant)"/.test(s) : !/"(user_message|agent_message)"|"role"\s*:\s*"(user|assistant)"/.test(s)) return null
      try {
        const entry: unknown = JSON.parse(s)
        if (countsAsMessage(provider, entry)) return 'message'
        return codex && (codexItemPrompt(entry) != null || codexItemReply(entry) != null) ? 'item' : null
      } catch {
        return null
      }
    }
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
      if (bytesRead <= 0) break
      const chunk = buf.subarray(0, bytesRead)
      let start = 0
      for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, nl)
        const line = pending.length ? Buffer.concat([...pending, piece]) : piece
        pending = []
        const kind = take(line)
        if (kind === 'message') count++
        else if (kind === 'item') items++
        start = nl + 1
        lineStart = pos + start
      }
      // The buffer is reused: keep a copy of the unfinished line.
      if (start < bytesRead) pending.push(Buffer.from(chunk.subarray(start)))
      pos += bytesRead
    }
    const progress: CountProgress = codex ? { offset: lineStart, count, items } : { offset: lineStart, count }
    const last = pending.length ? take(Buffer.concat(pending)) : null
    const total = count + (last === 'message' ? 1 : 0), totalItems = items + (last === 'item' ? 1 : 0)
    // A rollout with no event_msg message (Codex 0.163 on) counts its response_item messages.
    return { count: codex && total === 0 ? totalItems : total, progress }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
