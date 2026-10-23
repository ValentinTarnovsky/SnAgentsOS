import { promises as fsp } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import type { PaneContext, PaneStatusEvt, PaneUsage } from '@shared/types'
import { claudeContextWindow, codexCost, fitContextWindow } from '@shared/rateCard'
import { codexContextPct, type CodexTokenBreakdown, type CodexTokenUsage } from '../status/CodexProtocol'
import type { AgentEvent } from '../status/events'
import type { PaneTranscriptInfo } from '../status/StatusManager'
import { refreshFile, SUBAGENT_FILE, SUBAGENT_MAX_DEPTH, type Cached, type FoundFile, type ScanBudget, type ScanLimits } from './custom'

/** Message ids each pane remembers for the per-id dedup (the repeats of one message are lines apart). */
export const LEDGER_DEDUP_MAX = 4000
/** Subagent transcripts read per pane per turn (the read budget's files, beside the main one). */
export const LEDGER_SUBAGENTS_MAX = 256
/** Directory entries looked at per turn to find them. */
export const LEDGER_WALK_ENTRIES_MAX = 4096
/**
 * Transcript files a pane keeps in its cache (each session's own plus its
 * subagents'). Only a turn's end evicts, the least recently read first and
 * never a file the turn listed: reading one again from the start would count
 * its id-less lines twice, and its messages too once their ids left the
 * dedup window.
 */
const CACHED_FILES_MAX = 512
/** Subagent transcripts listed per turn: the newest that fit in the cache beside the main one. */
export const LEDGER_LISTED_MAX = CACHED_FILES_MAX - 1
/**
 * Evicted transcripts a pane remembers (where their counting stopped, least
 * recent first), so one that comes back (a resumed session, an old subagent
 * written to again) resumes there instead of counting again from the start.
 */
export const LEDGER_TOMBSTONES_MAX = 4096
/** Sessions (Claude) or threads (Codex) a pane keeps apart; an older one folds into the carried sum. */
export const LEDGER_PARTS_MAX = 64
/** Folded Claude sessions a pane remembers with what each added, so one that comes back leaves the carried sum. */
const FOLDED_MAX = 1024
/** One recompute's reading bound (the main transcript plus every subagent); a long first catch-up continues on the next turn. */
const LEDGER_LIMITS: ScanLimits = { files: LEDGER_SUBAGENTS_MAX + 1, bytes: 128 * 1024 * 1024, line: 32 * 1024 * 1024, listed: LEDGER_LISTED_MAX }
/** A model id worth publishing (one line, <= 64, the charset of Claude and Codex ids and aliases). */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,63}$/

/** The listing and stat the ledger needs (injected in tests). `stat` is null for anything but a regular file. */
export interface LedgerFs {
  readdir(dir: string): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>>
  stat(path: string): Promise<FoundFile | null>
}

export interface ConsoleLedgerDeps {
  /** The pane's agent session as StatusManager knows it (`transcriptFor`): only a hook-reported, validated path is read. */
  transcript(paneId: string): PaneTranscriptInfo | null
  /** The model the pane's status names (SessionStart, a tune), for Claude's `[1m]` window and Codex prices. */
  model(paneId: string): string | undefined
  /** StatusManager.setUsage. */
  publish(paneId: string, usage: PaneUsage | null, context: PaneContext | null): void
  fs?: LedgerFs
  /** custom.ts refreshFile (a counting wrapper in tests). */
  refresh?: typeof refreshFile
  limits?: Partial<ScanLimits>
}

const defaultFs: LedgerFs = {
  readdir: async (dir) => {
    try {
      return await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
  },
  stat: async (path) => {
    try {
      const st = await fsp.stat(path)
      return st.isFile() ? { path, mtimeMs: st.mtimeMs, size: st.size } : null
    } catch {
      return null
    }
  },
}

/** input (not cached), output, cache read, cache creation: Claude's four disjoint counts. */
interface Tokens {
  i: number
  o: number
  cr: number
  cc: number
}
const noTokens = (): Tokens => ({ i: 0, o: 0, cr: 0, cc: 0 })
const tokenSum = (t: Tokens): number => t.i + t.o + t.cr + t.cc
const maxTokens = (a: Tokens, b: Tokens): Tokens => ({ i: Math.max(a.i, b.i), o: Math.max(a.o, b.o), cr: Math.max(a.cr, b.cr), cc: Math.max(a.cc, b.cc) })

function addTokens(into: Tokens, t: Tokens, sign = 1): void {
  into.i += sign * t.i
  into.o += sign * t.o
  into.cr += sign * t.cr
  into.cc += sign * t.cc
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

const round = (v: number, digits: number): number => Math.round(v * 10 ** digits) / 10 ** digits
const cleanModel = (v: unknown): string | undefined => (typeof v === 'string' && MODEL_RE.test(v) ? v : undefined)

/** What one Claude transcript holds for the ledger (the cache's per-file data). */
interface ClaudeFile {
  /** The session's own transcript, not a subagent's: only it has the cost-state and the main thread. */
  main: boolean
  /** Its last `cost-state`: cumulative per session, so the last one wins (E10 SPIKE S7). */
  cost?: { usd: number; unknown: boolean }
  /** A usage line was read (a session with usage and no cost-state has an unknown cost). */
  used: boolean
  /** The newest main-thread assistant message: its id, model and usage (max per field over its lines). */
  last?: { id: string; model: string; t: Tokens }
}

/** What an evicted cache entry leaves: where its read stopped, its mark as a string (lighter than a Buffer). */
interface Tombstone {
  mtimeMs: number
  seen: number
  offset: number
  skipping: boolean
  mark: string
  data: ClaudeFile
}

/** A Claude session's cost as its own transcript last said. */
interface SessionCost {
  usd?: number
  unknown: boolean
}

/** The folded sessions' sum, and how many of them had a known or an unknown cost. */
interface Carried {
  usd: number
  known: number
  unknown: number
}

function carry(into: Carried, s: SessionCost, sign: 1 | -1): void {
  if (s.usd !== undefined) {
    into.usd += sign * s.usd
    into.known += sign
  }
  if (s.unknown) into.unknown += sign
}

interface ClaudeLedger {
  files: Map<string, Cached<ClaudeFile>>
  /** Path -> the tombstone of a transcript evicted from `files`, least recent first (a path is in one of the two at most). */
  gone: Map<string, Tombstone>
  /** message.id -> its usage counted so far (max per field), least recently seen first. */
  seen: Map<string, Tokens>
  /** Every message counted once, main and subagents, every session of the console. */
  totals: Tokens
  /** Main transcript path -> that session's cost, least recent first. */
  sessions: Map<string, SessionCost>
  /** The sessions folded out of `sessions`. */
  carried: Carried
  /** Main transcript path -> what that folded session added to `carried`, least recent first. */
  folded: Map<string, SessionCost>
  /** Reads run one at a time: two reads of one cache entry would count its lines twice. */
  chain: Promise<void>
}

/** Codex counts the ledger sums; `input` includes `cached` (E10 SPIKE S4, S8). */
interface CodexTokens {
  input: number
  cached: number
  cacheWrite: number
  output: number
}
const noCodexTokens = (): CodexTokens => ({ input: 0, cached: 0, cacheWrite: 0, output: 0 })
const codexTokens = (b: CodexTokenBreakdown): CodexTokens => ({ input: num(b.inputTokens), cached: num(b.cachedInputTokens), cacheWrite: num(b.cacheWriteInputTokens), output: num(b.outputTokens) })

/** a - b per field, never below 0. */
function codexMinus(a: CodexTokens, b: CodexTokens): CodexTokens {
  return { input: Math.max(0, a.input - b.input), cached: Math.max(0, a.cached - b.cached), cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite), output: Math.max(0, a.output - b.output) }
}

function addCodex(into: CodexTokens, t: CodexTokens): void {
  into.input += t.input
  into.cached += t.cached
  into.cacheWrite += t.cacheWrite
  into.output += t.output
}

interface CodexThread {
  /** The thread's total before the first call this console saw. */
  base: CodexTokens
  total: CodexTokens
}

interface CodexLedger {
  ptyId: string
  /** threadId -> its baseline and latest total, least recent first. */
  threads: Map<string, CodexThread>
  /** What the threads folded out of `threads` had added. */
  carried: CodexTokens
}

/**
 * App 2.7.0 (A4): per console, the tokens and cost its agent spent and how
 * full its context is, published through StatusManager.setUsage as `usage`
 * (desktop) and `context` (desktop and phone). Every figure is an estimate.
 *
 * Event driven, never polled: Claude recomputes on the turn's `done` (the
 * status listener sees it after the 700 ms debounce), Codex on each
 * `thread/tokenUsage/updated` of the root thread (one per model call, the last
 * one ends the turn). No timer of its own. A pane is forgotten when its
 * status clears (`state: null`: the pty exited or respawned, the track went
 * away) or another agent takes it (a status or a usage of the other
 * provider), so that agent starts from zero.
 *
 * Claude: the hook-reported transcript and its subagents' (`agent-*.jsonl`
 * under `<sid>/subagents/`, up to 3 levels deep: the layout custom.ts reads,
 * walked with a bound) are read incrementally with custom.ts `refreshFile`
 * into the pane's own cache, so a turn reads only what was appended. A file
 * evicted from the cache leaves a tombstone (its offset and mark), so a
 * session resumed after others pushed it out reads only what it appended;
 * past LEDGER_TOMBSTONES_MAX tombstones the oldest goes, and that file would
 * count again from the start. Each assistant message counts once per
 * `message.id` (max per field: Claude repeats the usage on every line of a
 * message and output grows while it streams), across every session the
 * console ran; the dedup keeps the last LEDGER_DEDUP_MAX ids, so a repeat
 * older than that would count again. The cost is each session's last
 * `cost-state` (`totalCostUSD`, `hasUnknownModelCost`), summed; a session
 * with usage and no cost-state has an unknown cost. The context is the main
 * thread's last assistant usage (input + cache read + cache creation +
 * output) over claudeContextWindow, approximate, and only once the main
 * transcript is caught up: while a long first read continues over several
 * turns its last message read is one from the middle of the history. A read
 * publishes onto the session it read: if the console reports another
 * transcript when it ends (a /clear, a resume), only the usage goes out (the
 * console's, which the new session keeps) with no context, and nothing if
 * another agent took the console.
 *
 * Codex: `total` is cumulative per thread, so a thread's baseline is its
 * total before the first call this console saw (total - last at first sight)
 * and the console's usage is the sum over its threads of total - baseline.
 * The cost comes from the rate card (unknown off the card); the context is
 * codexContextPct, exact.
 */
export class ConsoleLedger {
  private readonly claude = new Map<string, ClaudeLedger>()
  private readonly codex = new Map<string, CodexLedger>()
  private readonly fs: LedgerFs
  private readonly refresh: typeof refreshFile
  private readonly limits: ScanLimits

  constructor(private readonly deps: ConsoleLedgerDeps) {
    this.fs = deps.fs ?? defaultFs
    this.refresh = deps.refresh ?? refreshFile
    this.limits = { ...LEDGER_LIMITS, ...deps.limits }
  }

  /**
   * StatusManager listener: a Claude turn that is done (its `done` cause,
   * once the debounce settled) recomputes; a cleared status forgets the pane,
   * and a status of one agent forgets what the other counted. Nothing else
   * reads a file. The promise is for tests.
   */
  onStatus(evt: PaneStatusEvt, cause?: AgentEvent): Promise<void> | undefined {
    if (evt.state === null) {
      this.forget(evt.paneId)
      return undefined
    }
    // Another agent took the console (even one that never reports a usage): it starts from zero.
    if (evt.provider === 'codex') this.claude.delete(evt.paneId)
    else if (evt.provider === 'claude') this.codex.delete(evt.paneId)
    if (cause?.kind === 'done' && cause.provider === 'claude' && !cause.subagent && cause.paneId === evt.paneId) return this.claudeDone(evt.paneId)
    return undefined
  }

  /** Drops everything the ledger knows of the pane; a read in flight publishes nothing. */
  forget(paneId: string): void {
    this.claude.delete(paneId)
    this.codex.delete(paneId)
  }

  /** Recomputes the pane's Claude usage from its transcripts and publishes it. */
  claudeDone(paneId: string): Promise<void> {
    const info = this.deps.transcript(paneId)
    const path = info?.provider === 'claude' ? info.transcriptPath : undefined
    if (!path || !isAbsolute(path) || !/\.jsonl$/i.test(path)) return Promise.resolve()
    this.codex.delete(paneId)
    let ledger = this.claude.get(paneId)
    if (!ledger) {
      ledger = { files: new Map(), gone: new Map(), seen: new Map(), totals: noTokens(), sessions: new Map(), carried: { usd: 0, known: 0, unknown: 0 }, folded: new Map(), chain: Promise.resolve() }
      this.claude.set(paneId, ledger)
    }
    const own = ledger
    // Never rejects: index.ts drops the promise (`void`) in a status listener.
    own.chain = own.chain.then(() => this.readClaude(paneId, own, path)).catch(() => console.warn('[ledger] a console recompute failed'))
    return own.chain
  }

  /** A root-thread token usage from the Codex bridge: recomputes and publishes at once (no file is read). */
  codexUsage(paneId: string, ptyId: string, usage: CodexTokenUsage): void {
    this.claude.delete(paneId)
    let ledger = this.codex.get(paneId)
    // A new pty is a new Codex process: what the old one saw is not this console's run any more.
    if (!ledger || ledger.ptyId !== ptyId) {
      ledger = { ptyId, threads: new Map(), carried: noCodexTokens() }
      this.codex.set(paneId, ledger)
    }
    const total = codexTokens(usage.total)
    const prev = ledger.threads.get(usage.threadId)
    const thread: CodexThread = prev ? { base: prev.base, total } : { base: codexMinus(total, codexTokens(usage.last)), total }
    ledger.threads.delete(usage.threadId)
    ledger.threads.set(usage.threadId, thread)
    while (ledger.threads.size > LEDGER_PARTS_MAX) {
      const [oldest, gone] = ledger.threads.entries().next().value!
      addCodex(ledger.carried, codexMinus(gone.total, gone.base))
      ledger.threads.delete(oldest)
    }
    this.deps.publish(paneId, this.codexUsageOf(paneId, ledger), codexContext(usage))
  }

  // --- Claude ------------------------------------------------------------------

  private async readClaude(paneId: string, ledger: ClaudeLedger, path: string): Promise<void> {
    if (this.claude.get(paneId) !== ledger) return
    const budget: ScanBudget = { files: 0, bytes: 0, capped: false }
    // Every file the turn lists stays cached until it ends (evict).
    const listed = new Set([path])
    let caughtUp = false
    try {
      const main = await this.fs.stat(path)
      if (main && (await this.readFile(ledger, main, true, budget))) {
        // refreshFile also says true for a read that failed mid-file (it keeps what it consumed): only a current entry is caught up.
        const read = ledger.files.get(path)
        caughtUp = !!read && read.seen === main.size && read.mtimeMs === main.mtimeMs
        const subs = await this.subagents(path)
        for (const f of subs) listed.add(f.path)
        for (const f of subs) if (!(await this.readFile(ledger, f, false, budget))) break
      }
      this.noteSession(ledger, path)
    } finally {
      this.evict(ledger, listed)
    }
    if (this.claude.get(paneId) !== ledger) return
    // The console may have moved on while the files were read: the old session's context never lands on another track.
    const now = this.deps.transcript(paneId)
    if (now?.provider !== 'claude') return
    const last = caughtUp && now.transcriptPath === path ? ledger.files.get(path)?.data.last : undefined
    this.deps.publish(paneId, this.claudeUsageOf(paneId, ledger, last), this.claudeContext(paneId, last))
  }

  /** Brings one transcript up to date in the pane's cache (most recently read last), resuming from its tombstone if it has one. */
  private async readFile(ledger: ClaudeLedger, f: FoundFile, main: boolean, budget: ScanBudget): Promise<boolean> {
    const entry = ledger.files.get(f.path)
    if (entry) {
      ledger.files.delete(f.path)
      ledger.files.set(f.path, entry)
    } else {
      const t = ledger.gone.get(f.path)
      if (t) {
        ledger.gone.delete(f.path)
        ledger.files.set(f.path, { mtimeMs: t.mtimeMs, seen: t.seen, offset: t.offset, skipping: t.skipping, mark: Buffer.from(t.mark, 'latin1'), data: t.data })
      }
    }
    return this.refresh(ledger.files, f, budget, this.limits, (): ClaudeFile => ({ main, used: false }), (data, line) => this.claudeLine(ledger, data, line))
  }

  /**
   * The turn's end: the least recently read entries past CACHED_FILES_MAX
   * become tombstones, never one the turn listed (they fit: the listing is
   * capped at LEDGER_LISTED_MAX beside the main transcript).
   */
  private evict(ledger: ClaudeLedger, listed: Set<string>): void {
    for (const [path, e] of ledger.files) {
      if (ledger.files.size <= CACHED_FILES_MAX) break
      if (listed.has(path)) continue
      ledger.files.delete(path)
      ledger.gone.set(path, { mtimeMs: e.mtimeMs, seen: e.seen, offset: e.offset, skipping: e.skipping, mark: e.mark.toString('latin1'), data: e.data })
    }
    while (ledger.gone.size > LEDGER_TOMBSTONES_MAX) ledger.gone.delete(ledger.gone.keys().next().value!)
  }

  /**
   * The newest LEDGER_LISTED_MAX `agent-*.jsonl` under `<dir>/<sid>/subagents/`
   * of a main transcript, newest first, walked with a bound on depth and
   * entries. An unchanged one costs nothing and the read budget caps the
   * files read per turn, so a turn that finished more than
   * LEDGER_SUBAGENTS_MAX of them reads the newest and the rest on the next
   * turn: the directory order never leaves one out for good.
   */
  private async subagents(mainPath: string): Promise<FoundFile[]> {
    const root = join(dirname(mainPath), basename(mainPath).replace(/\.jsonl$/i, ''), 'subagents')
    const out: FoundFile[] = []
    let entries = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const e of await this.fs.readdir(dir)) {
        if (++entries > LEDGER_WALK_ENTRIES_MAX) return
        const p = join(dir, e.name)
        if (e.isFile() && SUBAGENT_FILE.test(e.name)) {
          const st = await this.fs.stat(p)
          if (st) out.push(st)
        } else if (e.isDirectory() && depth < SUBAGENT_MAX_DEPTH) await walk(p, depth + 1)
      }
    }
    await walk(root, 0)
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, LEDGER_LISTED_MAX)
  }

  private claudeLine(ledger: ClaudeLedger, data: ClaudeFile, raw: string): void {
    const line = raw.trim()
    if (!line) return
    const costLine = line.includes('cost-state')
    if (!costLine && !line.includes('usage')) return
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
    if (obj.type === 'cost-state') {
      const usd = obj.totalCostUSD
      if (data.main && typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) data.cost = { usd, unknown: obj.hasUnknownModelCost === true }
      return
    }
    const u = obj.message?.usage ?? obj.usage
    if (!u || typeof u !== 'object') return
    const t: Tokens = { i: num(u.input_tokens), o: num(u.output_tokens), cr: num(u.cache_read_input_tokens), cc: num(u.cache_creation_input_tokens) }
    data.used = true
    const id = typeof obj.message?.id === 'string' ? obj.message.id : ''
    this.count(ledger, id, t)
    // The main thread's latest call is the context: not a sidechain, not a synthetic (API error) message.
    if (!data.main || obj.type !== 'assistant' || obj.isSidechain === true) return
    if (obj.message?.model === '<synthetic>' || tokenSum(t) === 0) return
    const model = cleanModel(obj.message?.model) ?? ''
    const prev = data.last
    data.last = prev && id && prev.id === id ? { id, model: prev.model || model, t: maxTokens(prev.t, t) } : { id, model, t }
  }

  /** Adds a message's usage once per id (what grew since its last line); an id-less line counts once. */
  private count(ledger: ClaudeLedger, id: string, t: Tokens): void {
    if (!id) {
      addTokens(ledger.totals, t)
      return
    }
    const prev = ledger.seen.get(id)
    const next = prev ? maxTokens(prev, t) : t
    addTokens(ledger.totals, next)
    if (prev) {
      addTokens(ledger.totals, prev, -1)
      ledger.seen.delete(id)
    }
    ledger.seen.set(id, next)
    while (ledger.seen.size > LEDGER_DEDUP_MAX) ledger.seen.delete(ledger.seen.keys().next().value!)
  }

  /** The session's cost as its transcript says now (only once its transcript was read). */
  private noteSession(ledger: ClaudeLedger, path: string): void {
    const data = ledger.files.get(path)?.data
    if (!data) return
    // A folded session that comes back: its cost-state is cumulative, so what it added leaves the carried sum.
    const back = ledger.folded.get(path)
    if (back) {
      carry(ledger.carried, back, -1)
      ledger.folded.delete(path)
    }
    ledger.sessions.delete(path)
    ledger.sessions.set(path, data.cost ? { usd: data.cost.usd, unknown: data.cost.unknown } : { unknown: data.used })
    while (ledger.sessions.size > LEDGER_PARTS_MAX) {
      const [oldest, gone] = ledger.sessions.entries().next().value!
      carry(ledger.carried, gone, 1)
      ledger.folded.set(oldest, gone)
      ledger.sessions.delete(oldest)
    }
    while (ledger.folded.size > FOLDED_MAX) ledger.folded.delete(ledger.folded.keys().next().value!)
  }

  /** `last` is the current session's newest main-thread message, only when the read caught up with it. */
  private claudeUsageOf(paneId: string, ledger: ClaudeLedger, last: ClaudeFile['last']): PaneUsage | null {
    let { usd } = ledger.carried
    let known = ledger.carried.known > 0
    let unknown = ledger.carried.unknown > 0
    for (const s of ledger.sessions.values()) {
      if (s.usd !== undefined) {
        usd += s.usd
        known = true
      }
      if (s.unknown) unknown = true
    }
    const t = ledger.totals
    if (tokenSum(t) <= 0 && !known) return null
    const usage: PaneUsage = { inputTokens: t.i, outputTokens: t.o, cacheReadTokens: t.cr, cacheWriteTokens: t.cc, estimated: true }
    if (known) usage.costUSD = round(Math.max(0, usd), 6)
    if (unknown || !known) usage.unknownCost = true
    const model = cleanModel(last?.model) ?? cleanModel(this.deps.model(paneId))
    if (model) usage.model = model
    return usage
  }

  /** Approximate: the window is assumed from the model ids (and bumped to 1M when the usage outgrew it). */
  private claudeContext(paneId: string, last: ClaudeFile['last']): PaneContext | null {
    if (!last) return null
    const used = tokenSum(last.t)
    if (used <= 0) return null
    const window = fitContextWindow(used, Math.max(claudeContextWindow(this.deps.model(paneId)), claudeContextWindow(last.model)))
    return { pct: round(Math.min(1, used / window), 4), used, window, exact: false }
  }

  // --- Codex -------------------------------------------------------------------

  private codexUsageOf(paneId: string, ledger: CodexLedger): PaneUsage | null {
    const d = { ...ledger.carried }
    for (const thread of ledger.threads.values()) addCodex(d, codexMinus(thread.total, thread.base))
    if (d.input + d.cacheWrite + d.output <= 0) return null
    const cached = Math.min(d.cached, d.input)
    const usage: PaneUsage = { inputTokens: d.input - cached, outputTokens: d.output, cacheReadTokens: cached, cacheWriteTokens: d.cacheWrite, estimated: true }
    const model = cleanModel(this.deps.model(paneId))
    const cost = codexCost(model, { inputTokens: d.input, cachedInputTokens: cached, outputTokens: d.output })
    if (cost === undefined) usage.unknownCost = true
    else usage.costUSD = round(cost, 6)
    if (model) usage.model = model
    return usage
  }
}

/** Exact: the latest call and the window the CLI reported, or null without a window. */
function codexContext(usage: CodexTokenUsage): PaneContext | null {
  const pct = codexContextPct(usage)
  if (pct === null || usage.modelContextWindow === null) return null
  return { pct: round(pct, 4), used: num(usage.last.inputTokens) + num(usage.last.outputTokens), window: usage.modelContextWindow, exact: true }
}
