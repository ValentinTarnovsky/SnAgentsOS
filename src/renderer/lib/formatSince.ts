/**
 * Relative "since" text for status tooltips (E4-FR-10): "hace 4 min" /
 * "4 min. ago", from Intl.RelativeTimeFormat in the active language, and the
 * tooltip lines of one console's status dot. Pure: no store, no DOM.
 */
import type { AgentWaiting, Language, PaneStatus } from '@shared/types'
import type { MessageKey, TFn } from '@/i18n'

const formatters = new Map<Language, Intl.RelativeTimeFormat>()

function rtf(lang: Language): Intl.RelativeTimeFormat {
  let f = formatters.get(lang)
  if (!f) {
    f = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' })
    formatters.set(lang, f)
  }
  return f
}

/**
 * How long ago `since` was, in the user's language: "now" under a minute,
 * then minutes, hours and days (always in the past; clock skew counts as now).
 */
export function formatSince(since: number, now: number, lang: Language): string {
  const sec = Math.max(0, Math.floor((now - since) / 1000))
  const f = rtf(lang)
  if (sec < 60) return f.format(0, 'second')
  const min = Math.floor(sec / 60)
  if (min < 60) return f.format(-min, 'minute')
  const h = Math.floor(min / 60)
  if (h < 24) return f.format(-h, 'hour')
  return f.format(-Math.floor(h / 24), 'day')
}

export const STATUS_LABEL_KEY: Record<PaneStatus['state'], MessageKey> = {
  working: 'status.working',
  done: 'status.done',
  action: 'status.action',
  idle: 'status.idle',
  error: 'status.error',
  unknown: 'status.unknown',
}

/**
 * v2.2: what a finished turn waits on, "Esperando · 2 en segundo plano",
 * "Esperando a sus sub-sesiones (1)" or, between two of a driver, "Esperando
 * la próxima sub-sesión".
 */
export function waitingPhrase(waiting: AgentWaiting, t: TFn): string {
  if (waiting.kind === 'background') return t('agents.row.waitingBackground', { count: waiting.count })
  return waiting.count > 0 ? t('agents.row.waitingSub', { count: waiting.count }) : t('agents.row.waitingSubNext')
}

/** Display name of the agent behind a status ("Claude" unless Codex). */
export function providerName(status: Pick<PaneStatus, 'provider'>): string {
  return status.provider === 'codex' ? 'Codex' : 'Claude'
}

/**
 * Lines of a console's status tooltip (E4-FR-10), each rendered as its own
 * node: "Claude - Needs your input", "hace 4 min" (from stateSince),
 * "(approximate)" without hooks, "2 pending requests" with more than one.
 */
export function statusTipLines(status: PaneStatus, t: TFn, lang: Language, now: number): string[] {
  const lines = [`${providerName(status)} - ${t(STATUS_LABEL_KEY[status.state])}`]
  if (status.waiting && status.state === 'working') lines.push(waitingPhrase(status.waiting, t))
  if (status.stateSince) lines.push(formatSince(status.stateSince, now, lang))
  if (!status.precise) lines.push(`(${t('status.approximate')})`)
  if (status.state !== 'working' && status.state !== 'idle' && (status.pendingCount ?? 0) > 1) lines.push(t('status.pendingMany', { count: status.pendingCount ?? 0 }))
  return lines
}
