/**
 * App 2.7.0 (A6): the words of a console's 2.7.0 status signals on the
 * desktop. What the agent is doing now (the open tool's verb and object),
 * why its last turn failed, how long it has been silent, what it asked for
 * with `snaos needs`, how full its context is and what it spent. Pure over
 * the values handed in: no store, no DOM, so every surface (pane header,
 * sidebar rows, agents board, palette, workspace header) words them the same.
 */
import type { Language, PaneContext, PaneSilence, PaneStatus, PaneUsage } from '@shared/types'
import { formatAgeShort } from '@shared/agents'
import { displayStatus } from '@shared/status'
import { failureLabelKey, type FailureInfo } from '@shared/failure'
import { familyOf, toolVerbKey, type ToolFamily } from '@shared/toolActivity'
import type { MessageKey, TFn } from '@/i18n'
import { agentPhrase, firstLine, isNoticeOnly, type AgentEntry } from './agentNav'

const MIN_MS = 60_000

/** The status as an agent status: a `bare` one (only a `snaos needs` on a pane with no agent) is none. */
export function agentStatusOf(status: PaneStatus | undefined): PaneStatus | undefined {
  return status && !status.bare ? status : undefined
}

/**
 * What the activity summary says beyond the tool's own name: main words a
 * Claude tool as "Edit a.ts", "Bash: npm test" or "Task: <description>",
 * so the leading name goes when it is a tool of the same family (the verb
 * already says it). A Codex command line ("npm test") keeps every word.
 */
export function toolObject(activity: string, family: ToolFamily): string {
  const text = activity.trim()
  const m = /^(\S+?)(?::\s+|\s+|$)/.exec(text)
  if (!m || family === 'other') return text
  const head = m[1]
  const named = familyOf(head) === family || (family === 'mcp' && head === 'mcp')
  return named ? text.slice(m[0].length).trim() : text
}

/**
 * "Editando a.ts": the verb of the newest open tool plus what it works on,
 * only while the agent works with a tool open (main drops `activity` once
 * the tool ends, so a finished tool never shows). Null otherwise, also for
 * a finished turn that waits on background work.
 */
export function doingNow(status: PaneStatus | undefined, t: TFn): string | null {
  const s = displayStatus(agentStatusOf(status))
  const activity = s?.activity?.trim()
  if (!s || !activity || s.state !== 'working' || s.waiting) return null
  // A main without toolFamily (before 2.7.0) only has the summary.
  if (!s.toolFamily) return activity
  const verb = t(toolVerbKey(s.toolFamily))
  const what = toolObject(activity, s.toolFamily)
  return what ? `${verb} ${what}` : verb
}

/**
 * Second line of an agent row or board card: what it is doing now while a
 * tool is open (plus the age, like agentPhrase), else agentPhrase. A bare
 * status reads as its `snaos needs` text.
 */
export function rowPhrase(e: AgentEntry, t: TFn, lang: Language, now: number, withAge = true): string {
  if (!e.sleeping && !e.notStarted && e.status?.bare) return e.status.needs?.text ?? ''
  const doing = e.sleeping || e.notStarted ? null : doingNow(e.status, t)
  if (!doing) return agentPhrase(e, t, lang, now, withAge)
  return withAge && e.stateSince ? `${doing} · ${formatAgeShort(now - e.stateSince, lang)}` : doing
}

/**
 * Second line of a palette "Waiting for you" row: what the agent asked for
 * (`snaos needs`), "sent you a notice" for a console with no agent state,
 * else rowPhrase without the age (the row shows it), so a console with a
 * tool open says what it is doing now, like its sidebar row and board card.
 */
export function needsYouPhrase(e: AgentEntry, t: TFn, lang: Language, now: number): string {
  const needs = firstLine(e.status?.needs?.text)
  if (needs) return t('attention.row.needs', { text: needs })
  if (isNoticeOnly(e)) return t('attention.row.notice')
  return rowPhrase(e, t, lang, now, false)
}

/** "15:30" today, "25 oct, 15:30" another day, in the user's language. */
export function clockTime(at: number, lang: Language, now: number): string {
  const d = new Date(at)
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  try {
    return sameDay
      ? d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch {
    return d.toTimeString().slice(0, 5)
  }
}

/** "Límite de uso hasta 15:30": the failure's label, plus its reset while it is ahead. */
export function failureText(f: FailureInfo, t: TFn, lang: Language, now: number): string {
  const label = t(failureLabelKey(f.kind) as MessageKey)
  return f.until && f.until > now ? `${label} ${t('status.failure.until', { time: clockTime(f.until, lang, now) })}` : label
}

/** Whole minutes of silence since the last sign of life. */
export function silenceMinutes(s: PaneSilence, now: number): number {
  return Math.max(0, Math.floor((now - s.since) / MIN_MS))
}

/**
 * "Sin señales hace 12 min" (quiet) or "Quizás trabado: 25 min sin señales"
 * (stalled); `short` for a dense row: "12 min sin señales", "Quizás trabado · 25 min".
 */
export function silenceText(s: PaneSilence, t: TFn, now: number, short = false): string {
  const stalled = s.level === 'stalled'
  const key = short ? (stalled ? 'status.silence.stalledShort' : 'status.silence.quietShort') : stalled ? 'status.silence.stalled' : 'status.silence.quiet'
  return t(key, { min: silenceMinutes(s, now) })
}

/** When the next whole minute of `since` ticks over (the one timeout a silence chip keeps). */
export function nextMinuteAt(since: number, now: number): number {
  return since + (Math.floor(Math.max(0, now - since) / MIN_MS) + 1) * MIN_MS
}

/** Context fill as a whole percent, 0..100. */
export function contextPercent(c: PaneContext): number {
  const pct = Number.isFinite(c.pct) ? c.pct : 0
  return Math.round(Math.min(1, Math.max(0, pct)) * 100)
}

const compact = new Map<Language, Intl.NumberFormat>()
const money = new Map<Language, Intl.NumberFormat>()

/** "84 mil" / "84K", "1,2 M" / "1.2M". */
export function formatTokens(n: number, lang: Language): string {
  let f = compact.get(lang)
  if (!f) {
    f = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 })
    compact.set(lang, f)
  }
  return f.format(Math.max(0, Math.round(n)))
}

/** USD in the user's language ("1,75 US$" / "$1.75"); under a cent reads "< 0,01 US$". */
export function formatCost(usd: number, lang: Language): string {
  let f = money.get(lang)
  if (!f) {
    f = new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
    money.set(lang, f)
  }
  return usd > 0 && usd < 0.01 ? `< ${f.format(0.01)}` : f.format(Math.max(0, usd))
}

/** A sum of usages (one console's, or a workspace's). `costUSD` covers the part with a known price. */
export interface UsageTotal {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  tokens: number
  costUSD?: number
  /** Some of it has no known price (the cost, if any, is a lower bound). */
  unknownCost: boolean
  /** Consoles that reported usage. */
  consoles: number
}

/**
 * Sum of the usages handed in (A4: a workspace's total is summed here, in
 * the renderer, never in main). Null when none reported any. A console
 * with tokens but no cost leaves the total's cost incomplete.
 */
export function sumUsage(usages: ReadonlyArray<PaneUsage | undefined>): UsageTotal | null {
  let total: UsageTotal | null = null
  for (const u of usages) {
    if (!u) continue
    total ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, tokens: 0, unknownCost: false, consoles: 0 }
    const n = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)
    total.inputTokens += n(u.inputTokens)
    total.outputTokens += n(u.outputTokens)
    total.cacheReadTokens += n(u.cacheReadTokens)
    total.cacheWriteTokens += n(u.cacheWriteTokens)
    total.tokens = total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens
    if (typeof u.costUSD === 'number' && Number.isFinite(u.costUSD)) total.costUSD = (total.costUSD ?? 0) + Math.max(0, u.costUSD)
    if (u.unknownCost || typeof u.costUSD !== 'number') total.unknownCost = true
    total.consoles++
  }
  return total
}

/** "Costo estimado: 1,75 US$", "... o más (una parte tiene costo desconocido)" or "Costo desconocido". */
export function costLine(u: UsageTotal, t: TFn, lang: Language): string {
  if (u.costUSD === undefined) return t('status.usage.costUnknown')
  return t(u.unknownCost ? 'status.usage.costAtLeast' : 'status.usage.cost', { cost: formatCost(u.costUSD, lang) })
}

/** Tooltip lines of a usage: total tokens, their parts and the cost, all as an estimate. */
export function usageLines(u: UsageTotal, t: TFn, lang: Language): string[] {
  return [
    t('status.usage.tokens', { tokens: formatTokens(u.tokens, lang) }),
    t('status.usage.breakdown', {
      input: formatTokens(u.inputTokens, lang),
      output: formatTokens(u.outputTokens, lang),
      cacheRead: formatTokens(u.cacheReadTokens, lang),
      cacheWrite: formatTokens(u.cacheWriteTokens, lang),
    }),
    costLine(u, t, lang),
  ]
}

/** Tooltip lines of a context chip: used of the window (estimated unless exact), then the console's usage. */
export function contextLines(c: PaneContext, usage: PaneUsage | undefined, t: TFn, lang: Language): string[] {
  const lines = [t(c.exact ? 'status.context.tip' : 'status.context.tipEstimated', { used: formatTokens(c.used, lang), window: formatTokens(c.window, lang) })]
  const total = sumUsage([usage])
  return total ? [...lines, ...usageLines(total, t, lang)] : lines
}

/**
 * The signal lines of a status for a tooltip that stands in for the chips
 * (a sidebar row): the needs text, the failure, the silence, the context and
 * the mute, each when present.
 */
export function signalTipLines(status: PaneStatus | undefined, t: TFn, lang: Language, now: number): string[] {
  if (!status) return []
  const lines: string[] = []
  if (status.needs) lines.push(t('status.needs.label', { text: status.needs.text }))
  if (status.bare) return lines
  if (status.failure) lines.push(status.failure.code ? `${failureText(status.failure, t, lang, now)} (${status.failure.code})` : failureText(status.failure, t, lang, now))
  if (status.silence) lines.push(silenceText(status.silence, t, now))
  if (status.context) lines.push(t('status.context.label', { pct: contextPercent(status.context) }) + (status.context.exact ? '' : ` (${t('status.context.estimated')})`))
  if (status.muted) lines.push(t('pane.mutedTip'))
  return lines
}
