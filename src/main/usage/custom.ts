import { createReadStream, promises as fsp, type Dirent } from 'fs'
import { join } from 'path'
import type { UsageRow } from '@shared/ipc-contract'
import type { UsageCustomRow } from '@shared/types'
import { sessionsRoot } from '../agents/codexPaths'
import { claudeProjectsDir } from '../agents/transcripts'

/**
 * Bounds of one refresh. Each transcript is parsed once and its usage kept in
 * a per-file cache (size + mtime), so a refresh only reads what was appended
 * since the last one: Claude Code and Codex only ever append. The budget caps
 * that new reading, not the window. With subagents a busy week is ~2.3 GB in
 * ~2400 files, so a first scan of a long window catches up over a few
 * refreshes, newest files first across every row, and the rows it has not
 * finished say `partial` meanwhile. Every row reads the same cache, so a row
 * never starves another nor counts less than an identical one.
 */
export interface ScanLimits {
  /** Files opened per refresh (an unchanged file costs nothing). */
  files: number
  /** Bytes read per refresh: ~1.5 s of streamed parsing, so 5h (~90 MB) lands in one refresh and 7d in ~10. */
  bytes: number
  /** Longest line kept; a longer one is skipped so a scan always moves forward. */
  line: number
  /** Newest transcripts kept per source (bounds the cache); older ones leave the row `partial`. */
  listed: number
}
const LIMITS: ScanLimits = { files: 500, bytes: 256 * 1024 * 1024, line: 32 * 1024 * 1024, listed: 10000 }
/** Chunk size of the streamed reads: main never holds a whole transcript nor blocks on one. */
const READ_CHUNK = 256 * 1024
/** Bytes compared just before the cached offset of a changed file to tell an append from a rewrite. */
const MARK_BYTES = 64
const NO_MARK = Buffer.alloc(0)

type Win = UsageCustomRow['window']

function windowStartMs(win: Win): number {
  const now = Date.now()
  switch (win) {
    case 'session5h':
      return now - 5 * 60 * 60 * 1000
    case 'weekly7d':
      return now - 7 * 24 * 60 * 60 * 1000
    case 'today': {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    case 'all':
    default:
      return 0
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** A line's timestamp; one without a usable timestamp is always inside the window. */
function tsOf(timestamp: unknown): number {
  if (typeof timestamp !== 'string' || !timestamp) return Infinity
  const ts = Date.parse(timestamp)
  return Number.isFinite(ts) ? ts : Infinity
}

// --- per-file cache ---------------------------------------------------------

interface FoundFile {
  path: string
  mtimeMs: number
  size: number
}

interface Cached<T> {
  mtimeMs: number
  /** File size the last read reached; the entry is current when it equals the listed size (same mtime). */
  seen: number
  /** Bytes consumed through the last complete line: the next read resumes here. */
  offset: number
  /** The last read stopped inside an over-long line: drop through the next newline. */
  skipping: boolean
  /** The bytes just before `offset` as read: still there means the file was only appended to. */
  mark: Buffer
  data: T
}

/** The bytes read by one refresh, shared by every row and both sources. */
interface ScanBudget {
  files: number
  bytes: number
  capped: boolean
}

const isCurrent = (e: Cached<unknown> | undefined, f: FoundFile): boolean =>
  !!e && e.seen === f.size && e.mtimeMs === f.mtimeMs

/** The bytes of `path` in [from, to), or null when they cannot be read in full. */
async function readAt(path: string, from: number, to: number): Promise<Buffer | null> {
  if (to <= from) return NO_MARK
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    fh = await fsp.open(path, 'r')
    const b = Buffer.alloc(to - from)
    const { bytesRead } = await fh.read(b, 0, b.length, from)
    return bytesRead === b.length ? b : null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

async function appendedOnly(path: string, e: Cached<unknown>, size: number): Promise<boolean> {
  if (size < e.offset) return false
  const now = await readAt(path, e.offset - e.mark.length, e.offset)
  return !!now && now.equals(e.mark)
}

async function setOffset(path: string, e: Cached<unknown>, offset: number, skipping: boolean): Promise<void> {
  e.offset = offset
  e.skipping = skipping
  e.mark = (await readAt(path, Math.max(0, offset - MARK_BYTES), offset)) ?? NO_MARK
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Brings the cache entry of `f` up to date: reads from the entry's offset (or
 * from 0 for a new, truncated or rewritten file) up to the listed size or the
 * remaining budget, in READ_CHUNK pieces split on the byte '\n', and hands
 * each complete line to `onLine`. Only the listed bytes are read, so a
 * transcript growing meanwhile is picked up next refresh. A last line without
 * its newline is fed only at the end of the file and only once it parses
 * (both agents end every record with '\n', so anything else is still being
 * written). Returns false when the budget stopped the scan; a file that
 * vanishes or locks mid-read keeps what it consumed and stays not current.
 */
async function refreshFile<T>(
  cache: Map<string, Cached<T>>,
  f: FoundFile,
  budget: ScanBudget,
  limits: ScanLimits,
  fresh: () => T,
  onLine: (data: T, line: string) => void,
): Promise<boolean> {
  let entry = cache.get(f.path)
  if (isCurrent(entry, f)) return true
  if (budget.files >= limits.files || budget.bytes >= limits.bytes) {
    budget.capped = true
    return false
  }
  if (entry && !(await appendedOnly(f.path, entry, f.size))) entry = undefined
  if (!entry) {
    entry = { mtimeMs: f.mtimeMs, seen: 0, offset: 0, skipping: false, mark: NO_MARK, data: fresh() }
    cache.set(f.path, entry)
  }
  const start = entry.offset
  const take = Math.min(f.size - start, limits.bytes - budget.bytes)
  if (take <= 0) {
    entry.seen = f.size
    entry.mtimeMs = f.mtimeMs
    return true
  }
  budget.files += 1
  budget.bytes += take
  const end = start + take
  const data = entry.data
  let consumed = start
  let skipping = entry.skipping
  let parts: Buffer[] = []
  let partLen = 0
  let at = start
  try {
    const stream = createReadStream(f.path, { start, end: end - 1, highWaterMark: READ_CHUNK })
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let from = 0
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
        if (!skipping) {
          const piece = chunk.subarray(from, nl)
          onLine(data, (partLen ? Buffer.concat([...parts, piece]) : piece).toString('utf8'))
        }
        skipping = false
        parts = []
        partLen = 0
        from = nl + 1
        consumed = at + from
      }
      if (from < chunk.length && !skipping) {
        parts.push(chunk.subarray(from))
        partLen += chunk.length - from
        if (partLen > limits.line) {
          parts = []
          partLen = 0
          skipping = true
        }
      }
      at += chunk.length
      // The bytes of a skipped line are never read again.
      if (skipping) consumed = at
    }
  } catch {
    await setOffset(f.path, entry, consumed, skipping)
    return true
  }
  if (end === f.size && partLen > 0 && !skipping) {
    const text = Buffer.concat(parts).toString('utf8')
    if (parsesAsJson(text.trim())) {
      onLine(data, text)
      consumed = end
    }
  }
  await setOffset(f.path, entry, consumed, skipping)
  entry.seen = end
  entry.mtimeMs = f.mtimeMs
  if (end < f.size) {
    // The budget ran out inside this file: the next refresh resumes at `offset`.
    budget.capped = true
    return false
  }
  return true
}

/** Keeps only the entries of the files listed this refresh (deleted or out-of-window files go). */
function prune(cache: Map<string, Cached<unknown>>, listed: FoundFile[]): void {
  const keep = new Set(listed.map((f) => f.path))
  for (const path of cache.keys()) if (!keep.has(path)) cache.delete(path)
}

// --- listing ------------------------------------------------------------------

async function dirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function pushIfRecent(out: FoundFile[], path: string, startMs: number): Promise<void> {
  try {
    const { mtimeMs, size } = await fsp.stat(path)
    if (mtimeMs >= startMs) out.push({ path, mtimeMs, size })
  } catch {
    /* ignore */
  }
}

interface Listing {
  /** Newest first. */
  files: FoundFile[]
  /** More files were in the window than `limits.listed`. */
  truncated: boolean
}

function newestFirst(found: FoundFile[], limits: ScanLimits): Listing {
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const truncated = found.length > limits.listed
  return { files: truncated ? found.slice(0, limits.listed) : found, truncated }
}

// --- Claude transcripts: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/<uuid>.jsonl ---
//
// Subagents count. Claude Code writes each subagent (Task tool, workflow
// agents) to `<slug>/<sid>/subagents/agent-<id>.jsonl`, or one level deeper
// under `subagents/workflows/<wf>/`, and those are real API calls billed to
// the same plan, so leaving them out undercounts any session that delegates.
// Only `agent-*.jsonl` is read there (`journal.jsonl` is the workflow log and
// carries no usage). Their message ids are their own API responses, but a
// subagent line can repeat one of its parent's, which the per-id dedup
// absorbs because it spans every file of the row. They are most of the bytes
// (63 of 92 MB in a real 5h window), which is why reads go through the cache.
// Codex has no equivalent: its subagent threads are ordinary rollouts in the
// dated tree.

const SUBAGENT_FILE = /^agent-.*\.jsonl$/
const SUBAGENT_MAX_DEPTH = 3

async function collectSubagents(dir: string, startMs: number, out: FoundFile[], depth: number): Promise<void> {
  for (const e of await dirEntries(dir)) {
    const p = join(dir, e.name)
    if (e.isFile() && SUBAGENT_FILE.test(e.name)) await pushIfRecent(out, p, startMs)
    else if (e.isDirectory() && depth < SUBAGENT_MAX_DEPTH) await collectSubagents(p, startMs, out, depth + 1)
  }
}

/**
 * Every transcript touched since `startMs`. The projects dir follows
 * CLAUDE_CONFIG_DIR like the rest of main; the N Claude accounts share that
 * one dir (a switch swaps `.credentials.json`), so this covers all of them.
 */
async function claudeFiles(startMs: number, limits: ScanLimits): Promise<Listing> {
  const root = claudeProjectsDir()
  const found: FoundFile[] = []
  for (const slug of await dirEntries(root)) {
    if (!slug.isDirectory()) continue
    const dpath = join(root, slug.name)
    for (const e of await dirEntries(dpath)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) await pushIfRecent(found, join(dpath, e.name), startMs)
      else if (e.isDirectory()) await collectSubagents(join(dpath, e.name, 'subagents'), startMs, found, 0)
    }
  }
  return newestFirst(found, limits)
}

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
interface ClaudeLine {
  timestamp?: string
  model?: string
  usage?: ClaudeUsage
  message?: { id?: string; model?: string; usage?: ClaudeUsage }
}

/** One message's usage (flat fields: a 7d window holds ~80k of these). `model` is lowercased. */
interface ClaudeRec {
  ts: number
  model: string
  i: number
  o: number
  cc: number
  cr: number
}
interface ClaudeData {
  byId: Map<string, ClaudeRec>
  /** Lines without a message id: each counts once. */
  unkeyed: ClaudeRec[]
}

/**
 * Claude Code writes one line per content block of an assistant message and
 * repeats `message.usage` on each (a real transcript: 34 lines with usage for
 * 18 ids, a 1.84x overcount), so usage is kept once per `message.id`, field by
 * field at its maximum. The repeats carry the same input and cache counts
 * while `output_tokens` grows as the message streams ([2,7,40609,0] then
 * [2,478,40609,0] for one id), so the max is the final count whatever the line
 * order, where "the last line" would depend on it. The ids are merged again
 * across every file of a row: a resumed or forked session copies earlier
 * messages into its new transcript, and a subagent line can repeat its
 * parent's. A message is in a window by its latest line (the repeats are
 * seconds apart). A line without an id still counts once.
 */
function mergeRec(a: ClaudeRec, b: ClaudeRec): ClaudeRec {
  return {
    ts: Math.max(a.ts, b.ts),
    model: a.model,
    i: Math.max(a.i, b.i),
    o: Math.max(a.o, b.o),
    cc: Math.max(a.cc, b.cc),
    cr: Math.max(a.cr, b.cr),
  }
}

const recTotal = (r: ClaudeRec): number => r.i + r.o + r.cc + r.cr

function claudeLine(data: ClaudeData, raw: string): void {
  const line = raw.trim()
  if (!line || !line.includes('usage')) return
  let obj: ClaudeLine
  try {
    obj = JSON.parse(line) as ClaudeLine
  } catch {
    return
  }
  const u = obj.message?.usage ?? obj.usage
  if (!u || typeof u !== 'object') return
  const rec: ClaudeRec = {
    ts: tsOf(obj.timestamp),
    model: String(obj.message?.model ?? obj.model ?? '').toLowerCase(),
    i: num(u.input_tokens),
    o: num(u.output_tokens),
    cc: num(u.cache_creation_input_tokens),
    cr: num(u.cache_read_input_tokens),
  }
  const id = obj.message?.id
  if (typeof id !== 'string' || !id) {
    data.unkeyed.push(rec)
    return
  }
  const prev = data.byId.get(id)
  data.byId.set(id, prev ? mergeRec(prev, rec) : rec)
}

const claudeCache = new Map<string, Cached<ClaudeData>>()
const freshClaude = (): ClaudeData => ({ byId: new Map(), unkeyed: [] })

function sumClaude(files: FoundFile[], match: string, startMs: number): number {
  const needle = match.trim().toLowerCase()
  const keep = (r: ClaudeRec): boolean => r.ts >= startMs && (!needle || r.model.includes(needle))
  const byId = new Map<string, ClaudeRec>()
  let total = 0
  for (const f of files) {
    const e = claudeCache.get(f.path)
    if (!e) continue
    for (const [id, r] of e.data.byId) {
      if (!keep(r)) continue
      const prev = byId.get(id)
      byId.set(id, prev ? mergeRec(prev, r) : r)
    }
    for (const r of e.data.unkeyed) if (keep(r)) total += recTotal(r)
  }
  for (const r of byId.values()) total += recTotal(r)
  return total
}

// --- Codex sessions: <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl ---

async function numericDirsDesc(dir: string): Promise<string[]> {
  return (await dirEntries(dir))
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(b) - Number(a))
}

async function codexFiles(startMs: number, limits: ScanLimits): Promise<Listing> {
  const root = sessionsRoot()
  const found: FoundFile[] = []
  for (const y of await numericDirsDesc(root)) {
    const yDir = join(root, y)
    for (const m of await numericDirsDesc(yDir)) {
      const mDir = join(yDir, m)
      for (const d of await numericDirsDesc(mDir)) {
        const dDir = join(mDir, d)
        for (const e of await dirEntries(dDir)) {
          if (e.isFile() && /^rollout-.*\.jsonl$/i.test(e.name)) await pushIfRecent(found, join(dDir, e.name), startMs)
        }
      }
    }
  }
  return newestFirst(found, limits)
}

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    info?: { last_token_usage?: { total_tokens?: number } }
  }
}

interface CodexData {
  /** The file's recorded model (its first "model" field), lowercased; null until seen. */
  model: string | null
  /** One entry per `token_count` event: its timestamp and its tokens. */
  ts: number[]
  tokens: number[]
}

function codexLine(data: CodexData, raw: string): void {
  if (data.model === null) {
    const m = raw.match(/"model"\s*:\s*"([^"]+)"/)
    if (m) data.model = m[1].toLowerCase()
  }
  const line = raw.trim()
  if (!line || !line.includes('token_count')) return
  let obj: CodexLine
  try {
    obj = JSON.parse(line) as CodexLine
  } catch {
    return
  }
  if (obj.payload?.type !== 'token_count') return
  const n = num(obj.payload.info?.last_token_usage?.total_tokens)
  if (n === 0) return
  data.ts.push(tsOf(obj.timestamp))
  data.tokens.push(n)
}

const codexCache = new Map<string, Cached<CodexData>>()
const freshCodex = (): CodexData => ({ model: null, ts: [], tokens: [] })

function sumCodex(files: FoundFile[], match: string, startMs: number): number {
  const needle = match.trim().toLowerCase()
  let total = 0
  for (const f of files) {
    const e = codexCache.get(f.path)
    if (!e) continue
    // Skip a file whose recorded model doesn't match the filter (best-effort:
    // a file whose model is not known yet counts).
    if (needle && e.data.model !== null && !e.data.model.includes(needle)) continue
    const { ts, tokens } = e.data
    for (let k = 0; k < ts.length; k++) if (ts[k] >= startMs) total += tokens[k]
  }
  return total
}

// --- refresh ------------------------------------------------------------------

/** Logged once per catch-up, not on every refresh of it. */
let warnedCap = false
/** Refreshes run one at a time: two reads of one entry would count its lines twice. */
let chain: Promise<unknown> = Promise.resolve()

async function compute(rows: UsageCustomRow[], limits: ScanLimits): Promise<UsageRow[]> {
  const enabled = rows.filter((r) => r.enabled)
  const starts = enabled.map((r) => ({ row: r, startMs: windowStartMs(r.window) }))
  const earliest = (codex: boolean): number | null => {
    const s = starts.filter((x) => (x.row.source === 'codex') === codex).map((x) => x.startMs)
    return s.length ? Math.min(...s) : null
  }
  const claudeStart = earliest(false)
  const codexStart = earliest(true)
  const claude: Listing = claudeStart === null ? { files: [], truncated: false } : await claudeFiles(claudeStart, limits)
  const codex: Listing = codexStart === null ? { files: [], truncated: false } : await codexFiles(codexStart, limits)
  prune(claudeCache, claude.files)
  prune(codexCache, codex.files)

  // One read pass for every row, newest files first across both sources.
  const queue = [
    ...claude.files.map((f) => ({ f, codex: false })),
    ...codex.files.map((f) => ({ f, codex: true })),
  ].sort((a, b) => b.f.mtimeMs - a.f.mtimeMs)
  const budget: ScanBudget = { files: 0, bytes: 0, capped: false }
  for (const { f, codex: isCodex } of queue) {
    const more = isCodex
      ? await refreshFile(codexCache, f, budget, limits, freshCodex, codexLine)
      : await refreshFile(claudeCache, f, budget, limits, freshClaude, claudeLine)
    if (!more) break
  }

  const out: UsageRow[] = []
  for (const { row, startMs } of starts) {
    const isCodex = row.source === 'codex'
    const listing = isCodex ? codex : claude
    const cache: Map<string, Cached<unknown>> = isCodex ? codexCache : claudeCache
    const files = listing.files.filter((f) => f.mtimeMs >= startMs)
    const used = isCodex ? sumCodex(files, row.modelMatch, startMs) : sumClaude(files, row.modelMatch, startMs)
    const partial = listing.truncated || files.some((f) => !isCurrent(cache.get(f.path), f))
    const limit = typeof row.tokenBudget === 'number' && row.tokenBudget > 0 ? row.tokenBudget : undefined
    out.push({
      id: `custom.${row.id}`,
      provider: 'custom',
      kind: 'custom',
      label: row.label.trim() || row.modelMatch.trim() || 'Custom',
      percent: limit ? Math.max(0, Math.min(100, Math.round((used / limit) * 100))) : null,
      used,
      limit,
      resetsAt: null,
      status: 'ok',
      ...(partial ? { partial: true } : {}),
    })
  }
  if (budget.capped && !warnedCap) {
    console.warn(
      `[usage] custom-model scan hit its ${limits.files}-file / ${Math.round(limits.bytes / 1024 / 1024)}MB read budget; catching up over the next refreshes.`,
    )
  }
  warnedCap = budget.capped
  return out
}

/**
 * Compute the enabled custom rows by summing tokens from local transcripts.
 * Totals only (there is no live quota); a configured `tokenBudget` turns the
 * count into a percent bar. Streamed async reads bounded by ScanLimits per
 * refresh, so a refresh never blocks main. `limits` is for tests.
 */
export function computeCustomRows(rows: UsageCustomRow[], limits: Partial<ScanLimits> = {}): Promise<UsageRow[]> {
  const run = chain.then(() => compute(rows, { ...LIMITS, ...limits }))
  chain = run.catch(() => undefined)
  return run
}
