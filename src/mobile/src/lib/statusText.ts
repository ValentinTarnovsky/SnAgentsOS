/**
 * Text for an agent status on the phone (E1-FR-04/05): the localized state
 * label, the accessible name of the indicator and the status second line
 * (attention reason, else time in the current state). Pure: callers pass the
 * clock, so a single 30s ticker drives every refresh (Home: rowLine below).
 *
 * Relative time uses the phone's clock against the desktop's stateSince, with
 * no skew correction (no serverTime in the contract, E1 risk 24): an instant
 * in the future clamps to "now".
 *
 * App 2.7.0 (A8): the words of a row's status signals, the same as the
 * desktop's (src/renderer/lib/statusSignals.ts): what the agent is doing now,
 * why its last turn failed, its silence, what it asked for with `snaos
 * needs` and how full its context is.
 */
import type { ClaudePaneState, PaneContext, PaneNeeds, PaneSilence } from '@shared/types'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { displayStatus } from '@shared/status'
import { failureLabelKey, type FailureInfo } from '@shared/failure'
import { familyOf, toolVerbKey, type ToolFamily } from '@shared/toolActivity'
import { getLang, t, type MobileMessageKey } from './i18n'

const STATE_KEY: Record<ClaudePaneState, MobileMessageKey> = {
  working: 'status.working',
  action: 'status.action',
  done: 'status.done',
  error: 'status.error',
  idle: 'status.idle',
  unknown: 'status.unknown',
}

const REASON_KEY: Record<'permission' | 'question' | 'plan' | 'elicitation', MobileMessageKey> = {
  permission: 'status.reason.permission',
  question: 'status.reason.question',
  plan: 'status.reason.plan',
  elicitation: 'status.reason.elicitation',
}

/** How often a visible relative time is refreshed (one shared interval). */
export const STATUS_TICK_MS = 30000

/** Compact age: under 60s "now", under 60m "Nm", under 24h "Nh", else "Nd". */
export function relativeAge(stateSince: number, now: number): string {
  const s = Math.floor(Math.max(0, now - stateSince) / 1000)
  if (s < 60) return t('status.now')
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function stateLabel(state: ClaudePaneState): string {
  return t(STATE_KEY[state])
}

/** Agent name shown before the state ("Claude: working"). */
export function agentName(status: Pick<RemotePaneStatus, 'provider'>): string {
  return status.provider === 'codex' ? 'Codex' : 'Claude'
}

/** Accessible name of the indicator, with "(approximate)" for title-only status. */
export function statusAriaLabel(status: RemotePaneStatus): string {
  const base = `${agentName(status)}: ${stateLabel(status.state).toLocaleLowerCase()}`
  return status.precise === false ? `${base} (${t('status.approximate')})` : base
}

/** v2.2: what a finished turn waits on (the state reads working meanwhile), or null. */
export function waitingText(status: RemotePaneStatus): string | null {
  const w = status.waiting
  if (!w || status.state !== 'working') return null
  if (w.kind === 'background') return t('row.waitingBackground', { count: w.count })
  return w.count > 0 ? t('row.waitingSub', { count: w.count }) : t('row.waitingSubNext')
}

/** The attention reason as text, or null when the status carries none. */
export function reasonText(status: RemotePaneStatus): string | null {
  const reason = status.reason
  if (!reason || reason === 'failure') return null
  return t(REASON_KEY[reason])
}

/** True while the second line shows a relative time (drives the 30s ticker). */
export function showsTime(status: RemotePaneStatus | undefined): boolean {
  if (!status || reasonText(status)) return false
  return status.state === 'working' || status.state === 'done'
}

/**
 * The status second line: the reason when there is one ("Waiting for
 * permission"), else the state with its age ("Working 2m", "Done 3m ago").
 */
export function statusLine(status: RemotePaneStatus, now: number): string {
  const reason = reasonText(status)
  if (reason) return reason
  const waiting = waitingText(status)
  if (waiting) return waiting
  const fresh = now - status.stateSince < 60000
  switch (status.state) {
    case 'working':
      return fresh ? t('status.working') : t('status.workingFor', { t: relativeAge(status.stateSince, now) })
    case 'done':
      return fresh ? t('status.doneNow') : t('status.doneAgo', { t: relativeAge(status.stateSince, now) })
    case 'action':
      return t('status.reason.elicitation')
    default:
      return stateLabel(status.state)
  }
}

// --- Home row second line (E2-FR-05, table "Textos de la segunda linea") ---

const ROW_REASON_KEY: Record<'permission' | 'question' | 'plan' | 'elicitation', MobileMessageKey> = {
  permission: 'row.permission',
  question: 'row.question',
  plan: 'row.plan',
  elicitation: 'row.elicitation',
}

export interface RowLineInput {
  status: RemotePaneStatus | undefined
  running: boolean
  /** The pane's own exit code when its shell ended (E6-FR-38). */
  exitCode?: number
  /** Its workspace is mounted on the desktop (E2-FR-06). */
  mounted: boolean
}

/**
 * True while a row shows a relative time (drives the 30s ticker): the second
 * line's age, a silence's minutes or a failure's reset, which drops off when
 * it passes.
 */
export function rowShowsTime(raw: RemotePaneStatus | undefined): boolean {
  const status = displayStatus(agentStatusOf(raw))
  if (!status) return false
  if (status.silence || status.failure?.until) return true
  if (status.state === 'action') return false
  return status.state === 'working' || status.state === 'done' || status.state === 'error'
}

/**
 * The Home row's second line: the attention reason, the state with its age
 * ("Working 2m", "Done 3m ago", "Error 1m ago"), "Lost connection to agent",
 * else from the pty: Idle (running), Exited (code), Stopped, or Not started
 * when its workspace is not mounted on the desktop. App 2.7.0: while a tool
 * is open, what the agent is doing with its age ("Editing a.ts · 2m"); a
 * `bare` status (no agent) reads as no status here (the row shows its needs).
 */
export function rowLine(input: RowLineInput, now: number): string {
  // An answered action (attention false) reads working, or idle when title-only.
  const status = displayStatus(agentStatusOf(input.status))
  if (status) {
    const reason = status.reason
    if (status.state === 'action') {
      return reason && reason !== 'failure' ? t(ROW_REASON_KEY[reason]) : t('row.action')
    }
    const fresh = now - status.stateSince < 60000
    const age = relativeAge(status.stateSince, now)
    const waiting = waitingText(status)
    if (waiting) return waiting
    switch (status.state) {
      case 'working': {
        const doing = doingNow(status)
        if (doing) return fresh ? doing : `${doing} · ${age}`
        return fresh ? t('row.working') : t('row.workingFor', { t: age })
      }
      case 'done':
        return fresh ? t('row.doneNow') : t('row.doneAgo', { t: age })
      case 'error':
        return fresh ? t('row.errorNow') : t('row.errorAgo', { t: age })
      case 'unknown':
        return t('row.unknown')
      default:
        break
    }
  }
  if (input.running) return t('row.idle')
  if (input.exitCode !== undefined) return t('row.exited', { code: input.exitCode })
  return input.mounted ? t('row.stopped') : t('row.notStarted')
}

// --- Status signals (app 2.7.0, A8) ---

const MIN_MS = 60_000

/** The status as an agent status: a `bare` one (only a `snaos needs` on a console with no agent) is none. */
export function agentStatusOf(status: RemotePaneStatus | undefined): RemotePaneStatus | undefined {
  return status && !status.bare ? status : undefined
}

/**
 * What the activity summary says beyond the tool's own name, as the desktop
 * words it: main writes a Claude tool as "Edit a.ts", "Bash: npm test" or
 * "Task: <description>", so the leading name goes when it is a tool of the
 * same family (the verb already says it). A Codex command line keeps every word.
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
 * "Editing a.ts": the verb of the newest open tool plus what it works on,
 * only while the agent works with a tool open (since 2.7.0 main sends
 * `activity` with its `toolFamily` while the tool is open, and drops both
 * once it ends). Null otherwise, also for a finished turn that waits on
 * background work and for a status without toolFamily: a desktop before
 * 2.7.0 keeps `activity` on the turn's last tool after it ends, so its row
 * keeps "Working 6m".
 */
export function doingNow(raw: RemotePaneStatus | undefined): string | null {
  const s = displayStatus(agentStatusOf(raw))
  const activity = s?.activity?.trim()
  if (!s || !s.toolFamily || !activity || s.state !== 'working' || s.waiting) return null
  const verb = t(toolVerbKey(s.toolFamily))
  const what = toolObject(activity, s.toolFamily)
  return what ? `${verb} ${what}` : verb
}

/** "15:30" today, "25 oct, 15:30" another day, in the phone's language and clock. */
export function clockTime(at: number, now: number): string {
  const d = new Date(at)
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  const lang = getLang()
  try {
    return sameDay
      ? d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch {
    return d.toTimeString().slice(0, 5)
  }
}

/** "Usage limit until 15:30": the failure's label, plus its reset while it is ahead. */
export function failureText(f: FailureInfo, now: number): string {
  const label = t(failureLabelKey(f.kind) as MobileMessageKey)
  return f.until && f.until > now ? `${label} ${t('status.failure.until', { time: clockTime(f.until, now) })}` : label
}

/** Whole minutes of silence since the last sign of life. */
export function silenceMinutes(s: PaneSilence, now: number): number {
  return Math.max(0, Math.floor((now - s.since) / MIN_MS))
}

/** "No signal for 12 min" (quiet) or "Maybe stuck: 25 min without signal" (stalled). */
export function silenceText(s: PaneSilence, now: number): string {
  return t(s.level === 'stalled' ? 'status.silence.stalled' : 'status.silence.quiet', { min: silenceMinutes(s, now) })
}

/** "Needs you: <text>" (`snaos needs`). */
export function needsText(needs: PaneNeeds): string {
  return t('status.needs.label', { text: needs.text })
}

/** Context fill as a whole percent, 0..100. */
export function contextPercent(c: PaneContext): number {
  const pct = Number.isFinite(c.pct) ? c.pct : 0
  return Math.round(Math.min(1, Math.max(0, pct)) * 100)
}

/** The short form a row shows: "42%" when the agent reported it (Codex), else "42% est.". */
export function contextShort(c: PaneContext): string {
  const pct = contextPercent(c)
  return c.exact ? `${pct}%` : t('status.context.short', { pct })
}

/** The accessible name: "Context 42% full", plus "(estimated)" unless exact. */
export function contextLabel(c: PaneContext): string {
  const label = t('status.context.label', { pct: contextPercent(c) })
  return c.exact ? label : `${label} (${t('status.context.estimated')})`
}
