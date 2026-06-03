import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageRow } from '@shared/ipc-contract'

function sessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions')
}

/** Numeric child directories (years/months/days), highest value first. */
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

/**
 * Locate the most recent `rollout-*.jsonl` under sessions/YYYY/MM/DD without
 * globbing the whole tree (which is huge). Descends newest-first and falls back
 * across day/month/year boundaries when a dated folder holds no rollout files.
 */
function newestRolloutFile(): string | null {
  const root = sessionsRoot()
  if (!existsSync(root)) return null
  for (const y of numericDirsDesc(root)) {
    const yDir = join(root, y)
    for (const m of numericDirsDesc(yDir)) {
      const mDir = join(yDir, m)
      for (const d of numericDirsDesc(mDir)) {
        const dDir = join(mDir, d)
        let best: { path: string; mtime: number } | null = null
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
            const mt = statSync(p).mtimeMs
            if (!best || mt > best.mtime) best = { path: p, mtime: mt }
          } catch {
            /* ignore unreadable entry */
          }
        }
        if (best) return best.path
      }
    }
  }
  return null
}

interface RateWindow {
  used_percent?: number
  window_minutes?: number
  resets_at?: number
}
interface RateLimits {
  primary?: RateWindow
  secondary?: RateWindow
  plan_type?: string | null
}
interface TokenCountPayload {
  type?: string
  rate_limits?: RateLimits
}

/** Scan a rollout file from the end for the last `token_count` rate-limit snapshot. */
function lastRateLimits(file: string): RateLimits | null {
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('token_count')) continue
    try {
      const obj = JSON.parse(line) as { type?: string; payload?: TokenCountPayload }
      const p = obj.payload
      if (obj.type === 'event_msg' && p?.type === 'token_count' && p.rate_limits) {
        return p.rate_limits
      }
    } catch {
      /* skip a malformed line */
    }
  }
  return null
}

export interface CodexRowFlags {
  codex5h: boolean
  codex7d: boolean
}

interface WantedWindow {
  id: string
  kind: '5h' | '7d'
  label: string
  pick: 'primary' | 'secondary'
}

function clampPercent(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x)))
}

function isoFromEpochSec(sec?: number): string | null {
  return typeof sec === 'number' ? new Date(sec * 1000).toISOString() : null
}

/**
 * Read Codex usage from the newest local rollout file. No API, no auth: Codex
 * writes `rate_limits` (primary = 5h / 300min, secondary = weekly / 10080min)
 * into a `token_count` event after every turn.
 */
export function fetchCodexRows(flags: CodexRowFlags): UsageRow[] {
  const wanted: WantedWindow[] = []
  if (flags.codex5h) wanted.push({ id: 'codex.5h', kind: '5h', label: 'Session', pick: 'primary' })
  if (flags.codex7d) wanted.push({ id: 'codex.7d', kind: '7d', label: 'Weekly', pick: 'secondary' })
  if (wanted.length === 0) return []

  const all = (status: UsageRow['status']): UsageRow[] =>
    wanted.map(
      (w): UsageRow => ({
        id: w.id,
        provider: 'codex',
        kind: w.kind,
        label: w.label,
        percent: null,
        resetsAt: null,
        status,
      }),
    )

  const file = newestRolloutFile()
  if (!file) return all('nodata')
  const rl = lastRateLimits(file)
  if (!rl) return all('nodata')
  const planType = rl.plan_type ?? null

  return wanted.map((w): UsageRow => {
    const win = rl[w.pick]
    if (!win || typeof win.used_percent !== 'number') {
      return {
        id: w.id,
        provider: 'codex',
        kind: w.kind,
        label: w.label,
        percent: null,
        resetsAt: null,
        planType,
        status: 'nodata',
      }
    }
    return {
      id: w.id,
      provider: 'codex',
      kind: w.kind,
      label: w.label,
      percent: clampPercent(win.used_percent),
      resetsAt: isoFromEpochSec(win.resets_at),
      planType,
      status: 'ok',
    }
  })
}
