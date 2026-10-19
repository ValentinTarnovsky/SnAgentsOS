import type { UsageRow } from '@shared/ipc-contract'

/**
 * Codex quota windows, independent of where they were read (the live `wham`
 * endpoint or a local rollout file). Windows are identified by their DURATION,
 * never by position: a weekly-only plan reports its 7d window as `primary`.
 */

export type CodexKind = '5h' | '7d'

export interface CodexWindow {
  kind: CodexKind
  /** 0..100 */
  percent: number
  /** ISO-8601; null when the provider gave none or the window already reset. */
  resetsAt: string | null
}

export interface CodexSnapshot {
  planType: string | null
  windows: CodexWindow[]
  /** Epoch ms of the data itself (the rollout event time, or the fetch time for live). */
  at: number
}

export interface CodexRowFlags {
  codex5h: boolean
  codex7d: boolean
}

const DAY_S = 86400

/** <= 24h is the short Session window, >= 6 days the Weekly one, anything between is unknown. */
export function classifyWindowSeconds(sec: unknown): CodexKind | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null
  if (sec <= DAY_S) return '5h'
  if (sec >= 6 * DAY_S) return '7d'
  return null
}

export function clampPercent(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x)))
}

export interface RawWindow {
  usedPercent: unknown
  /** Window length in seconds (live `limit_window_seconds`, local `window_minutes * 60`). */
  windowSeconds: unknown
  /** Reset instant, epoch seconds. */
  resetsAtSec: unknown
  /** Kind to assume when the duration is missing (legacy primary/secondary position). */
  fallbackKind?: CodexKind
}

/**
 * Turn one provider window into a CodexWindow, or null when it has no usable
 * percentage or its duration is not a Session/Weekly one. A reset instant in
 * the past means the window already rolled over: 0% used and no reset time.
 */
export function buildWindow(raw: RawWindow, nowMs: number): CodexWindow | null {
  if (typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) return null
  const hasDuration = typeof raw.windowSeconds === 'number'
  const kind = hasDuration ? classifyWindowSeconds(raw.windowSeconds) : (raw.fallbackKind ?? null)
  if (!kind) return null
  const resetMs =
    typeof raw.resetsAtSec === 'number' && Number.isFinite(raw.resetsAtSec) ? raw.resetsAtSec * 1000 : null
  if (resetMs !== null && resetMs <= nowMs) return { kind, percent: 0, resetsAt: null }
  return {
    kind,
    percent: clampPercent(raw.usedPercent),
    resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
  }
}

/** Re-apply the reset rule to a cached snapshot: a window whose reset has since passed reads 0%. */
export function applyExpiry(snap: CodexSnapshot, nowMs: number): CodexSnapshot {
  return {
    ...snap,
    windows: snap.windows.map((w) =>
      w.resetsAt !== null && Date.parse(w.resetsAt) <= nowMs ? { ...w, percent: 0, resetsAt: null } : w,
    ),
  }
}

/** First window of each kind wins (primary before secondary). */
export function dedupeByKind(windows: Array<CodexWindow | null>): CodexWindow[] {
  const out: CodexWindow[] = []
  for (const w of windows) {
    if (w && !out.some((o) => o.kind === w.kind)) out.push(w)
  }
  return out
}

interface WantedRow {
  id: string
  kind: CodexKind
  label: string
}

function wantedRows(flags: CodexRowFlags): WantedRow[] {
  const wanted: WantedRow[] = []
  if (flags.codex5h) wanted.push({ id: 'codex.5h', kind: '5h', label: 'Session' })
  if (flags.codex7d) wanted.push({ id: 'codex.7d', kind: '7d', label: 'Weekly' })
  return wanted
}

/** Rows for a state with no data at all (no auth, no rollouts): one `status` row per enabled window. */
export function emptyCodexRows(flags: CodexRowFlags, status: UsageRow['status'], planType: string | null = null): UsageRow[] {
  return wantedRows(flags).map(
    (w): UsageRow => ({
      id: w.id,
      provider: 'codex',
      kind: w.kind,
      label: w.label,
      percent: null,
      resetsAt: null,
      planType,
      status,
    }),
  )
}

/**
 * Rows for a snapshot. A window the plan does not have is NOT emitted (no
 * "No data" row for it). Only a snapshot with no recognizable window at all
 * falls back to `nodata` rows, since then the plan is unknown, not weekly-only.
 */
export function rowsFromSnapshot(flags: CodexRowFlags, snap: CodexSnapshot): UsageRow[] {
  if (snap.windows.length === 0) return emptyCodexRows(flags, 'nodata', snap.planType)
  const rows: UsageRow[] = []
  for (const w of wantedRows(flags)) {
    const win = snap.windows.find((c) => c.kind === w.kind)
    if (!win) continue
    rows.push({
      id: w.id,
      provider: 'codex',
      kind: w.kind,
      label: w.label,
      percent: win.percent,
      resetsAt: win.resetsAt,
      planType: snap.planType,
      status: 'ok',
    })
  }
  return rows
}
