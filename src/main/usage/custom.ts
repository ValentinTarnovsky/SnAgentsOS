import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageRow } from '@shared/ipc-contract'
import type { UsageCustomRow } from '@shared/types'

/** Bounds so a custom counter can never run away on a huge transcript history. */
const MAX_FILES = 500
const MAX_BYTES = 80 * 1024 * 1024 // 80 MB scanned per refresh

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

/** A running budget shared across all files scanned in one refresh. */
interface ScanBudget {
  files: number
  bytes: number
  capped: boolean
}

function overBudget(budget: ScanBudget): boolean {
  if (budget.files >= MAX_FILES || budget.bytes >= MAX_BYTES) {
    budget.capped = true
    return true
  }
  return false
}

function readCounted(path: string, budget: ScanBudget): string | null {
  if (overBudget(budget)) return null
  try {
    const size = statSync(path).size
    if (budget.bytes + size > MAX_BYTES) {
      budget.capped = true
      return null
    }
    const text = readFileSync(path, 'utf8')
    budget.files += 1
    budget.bytes += size
    return text
  } catch {
    return null
  }
}

// --- Claude transcripts: ~/.claude/projects/<slug>/<uuid>.jsonl ---

function claudeFiles(startMs: number): string[] {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return []
  const out: string[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  for (const dir of dirs) {
    const dpath = join(root, dir)
    let files: string[] = []
    try {
      files = readdirSync(dpath)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(dpath, f)
      try {
        if (statSync(p).mtimeMs >= startMs) out.push(p)
      } catch {
        /* ignore */
      }
    }
  }
  return out
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
  message?: { model?: string; usage?: ClaudeUsage }
}

function sumClaude(match: string, startMs: number, budget: ScanBudget): number {
  const needle = match.trim().toLowerCase()
  let total = 0
  for (const file of claudeFiles(startMs)) {
    const text = readCounted(file, budget)
    if (text === null) break
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let obj: ClaudeLine
      try {
        obj = JSON.parse(line) as ClaudeLine
      } catch {
        continue
      }
      if (obj.timestamp) {
        const ts = Date.parse(obj.timestamp)
        if (Number.isFinite(ts) && ts < startMs) continue
      }
      const model = obj.message?.model ?? obj.model ?? ''
      if (needle && !model.toLowerCase().includes(needle)) continue
      const u = obj.message?.usage ?? obj.usage
      if (!u) continue
      total +=
        num(u.input_tokens) +
        num(u.output_tokens) +
        num(u.cache_creation_input_tokens) +
        num(u.cache_read_input_tokens)
    }
  }
  return total
}

// --- Codex sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ---

function numericDirsDesc(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(b) - Number(a))
  } catch {
    return []
  }
}

function codexFiles(startMs: number): string[] {
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const y of numericDirsDesc(root)) {
    const yDir = join(root, y)
    for (const m of numericDirsDesc(yDir)) {
      const mDir = join(yDir, m)
      for (const d of numericDirsDesc(mDir)) {
        const dDir = join(mDir, d)
        let files: string[] = []
        try {
          files = readdirSync(dDir)
        } catch {
          files = []
        }
        for (const f of files) {
          if (!/^rollout-.*\.jsonl$/i.test(f)) continue
          const p = join(dDir, f)
          try {
            if (statSync(p).mtimeMs >= startMs) out.push(p)
          } catch {
            /* ignore */
          }
        }
        if (out.length >= MAX_FILES) return out
      }
    }
  }
  return out
}

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    info?: { last_token_usage?: { total_tokens?: number } }
  }
}

function sumCodex(match: string, startMs: number, budget: ScanBudget): number {
  const needle = match.trim().toLowerCase()
  let total = 0
  for (const file of codexFiles(startMs)) {
    const text = readCounted(file, budget)
    if (text === null) break
    // Skip a file whose recorded model doesn't match the filter (best-effort).
    if (needle) {
      const m = text.match(/"model"\s*:\s*"([^"]+)"/)
      if (m && !m[1].toLowerCase().includes(needle)) continue
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || !line.includes('token_count')) continue
      let obj: CodexLine
      try {
        obj = JSON.parse(line) as CodexLine
      } catch {
        continue
      }
      if (obj.payload?.type !== 'token_count') continue
      if (obj.timestamp) {
        const ts = Date.parse(obj.timestamp)
        if (Number.isFinite(ts) && ts < startMs) continue
      }
      total += num(obj.payload.info?.last_token_usage?.total_tokens)
    }
  }
  return total
}

/**
 * Compute the enabled custom rows by summing tokens from local transcripts.
 * Totals only (there is no live quota); a configured `tokenBudget` turns the
 * count into a percent bar. Bounded by MAX_FILES / MAX_BYTES per refresh.
 */
export function computeCustomRows(rows: UsageCustomRow[]): UsageRow[] {
  const budget: ScanBudget = { files: 0, bytes: 0, capped: false }
  const out: UsageRow[] = []
  for (const row of rows) {
    if (!row.enabled) continue
    const startMs = windowStartMs(row.window)
    const used =
      row.source === 'codex'
        ? sumCodex(row.modelMatch, startMs, budget)
        : sumClaude(row.modelMatch, startMs, budget)
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
    })
  }
  if (budget.capped) {
    console.warn(
      `[usage] custom-model scan hit its ${MAX_FILES}-file / ${Math.round(MAX_BYTES / 1024 / 1024)}MB budget; totals may be partial.`,
    )
  }
  return out
}
