/**
 * Text for an agent status on the phone (E1-FR-04/05): the localized state
 * label, the accessible name of the indicator and the status second line
 * (attention reason, else time in the current state). Pure: callers pass the
 * clock, so a single 30s ticker drives every refresh (Home: rowLine below).
 *
 * Relative time uses the phone's clock against the desktop's stateSince, with
 * no skew correction (no serverTime in the contract, E1 risk 24): an instant
 * in the future clamps to "now".
 */
import type { ClaudePaneState } from '@shared/types'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { displayStatus } from '@shared/status'
import { t, type MobileMessageKey } from './i18n'

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

/** True while a row's second line shows a relative time (drives the 30s ticker). */
export function rowShowsTime(raw: RemotePaneStatus | undefined): boolean {
  const status = displayStatus(raw)
  if (!status) return false
  if (status.state === 'action') return false
  return status.state === 'working' || status.state === 'done' || status.state === 'error'
}

/**
 * The Home row's second line: the attention reason, the state with its age
 * ("Working 2m", "Done 3m ago", "Error 1m ago"), "Lost connection to agent",
 * else from the pty: Idle (running), Exited (code), Stopped, or Not started
 * when its workspace is not mounted on the desktop.
 */
export function rowLine(input: RowLineInput, now: number): string {
  // An answered action (attention false) reads working, or idle when title-only.
  const status = displayStatus(input.status)
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
      case 'working':
        return fresh ? t('row.working') : t('row.workingFor', { t: age })
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
