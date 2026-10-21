/**
 * Model, effort and Ultracode of an agent console from the phone (app 2.3.0,
 * ctl `agentTune`). Pure: no Node, no DOM; main (schema, PtyManager gate),
 * the renderer (executor) and the phone (sheet) share it.
 *
 * Every tap becomes exactly one slash command built here from an allowlist,
 * never free text. Claude 2.1.304 takes `/model <alias|id>`,
 * `/effort low|medium|high|xhigh|max|auto` and `/effort ultracode on|off`
 * (independent of the level; `auto` turns it off). Codex 0.163 only has the
 * interactive `/model` picker, so the only Codex set is `picker`.
 */
import type { AgentProvider, ClaudePaneState } from './types'

/** Aliases the sheet offers for Claude (`/model` also saves them as the default for new sessions). */
export const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'opus[1m]', 'sonnet[1m]'] as const
/** Claude's effort levels, slowest last (the sheet's 5 stops, "Faster" to "Smarter"). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]
/** `auto` goes back to the model's own level and turns Ultracode off. */
export type TuneEffort = ClaudeEffort | 'auto'
export const TUNE_EFFORTS: readonly TuneEffort[] = [...CLAUDE_EFFORTS, 'auto']

/** A full Claude model id (`claude-opus-4-5`, `claude-sonnet-4-5[1m]`), <= 64 with the suffix. */
export const CLAUDE_MODEL_ID_RE = /^claude-[a-z0-9.-]{1,53}(\[1m\])?$/

/** What one tap changes. */
export type TuneSet =
  | { kind: 'model'; value: string }
  | { kind: 'effort'; value: TuneEffort }
  | { kind: 'ultracode'; on: boolean }
  | { kind: 'picker' }

/** What main shows after an applied tune (and what the hooks report): optional, one line. */
export interface TuneHint {
  model?: string
  effort?: string
  ultracode?: boolean
}

/** An allowlisted alias or a well-formed full model id, <= 64 (the bound of every `model` field). */
export function isClaudeModel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && ((CLAUDE_MODELS as readonly string[]).includes(value) || CLAUDE_MODEL_ID_RE.test(value))
}

export function isTuneEffort(value: unknown): value is TuneEffort {
  return typeof value === 'string' && (TUNE_EFFORTS as readonly string[]).includes(value)
}

/**
 * The one slash command a tap types, or null when the provider cannot take
 * it (anything but `picker` on Codex) or the value is off the allowlist.
 */
export function tuneCommand(provider: AgentProvider, set: TuneSet): string | null {
  if (set.kind === 'picker') return '/model'
  if (provider !== 'claude') return null
  switch (set.kind) {
    case 'model':
      return isClaudeModel(set.value) ? `/model ${set.value}` : null
    case 'effort':
      return isTuneEffort(set.value) ? `/effort ${set.value}` : null
    case 'ultracode':
      return typeof set.on === 'boolean' ? `/effort ultracode ${set.on ? 'on' : 'off'}` : null
    default:
      return null
  }
}

/** What a tune with Enter says about the console once applied (the optimistic read-back). */
export function tuneHintOf(set: TuneSet): TuneHint | null {
  switch (set.kind) {
    case 'model':
      return { model: set.value }
    case 'effort':
      // `/effort auto` turns Ultracode off too.
      return set.value === 'auto' ? { effort: 'auto', ultracode: false } : { effort: set.value }
    case 'ultracode':
      return { ultracode: set.on }
    default:
      return null
  }
}

/**
 * Validates a `status:tuneHint` request (main trusts no renderer payload):
 * a pane id, and at least one of an allowlisted model, an allowlisted effort
 * and a boolean Ultracode. Null when anything is off.
 */
export function parseTuneHint(req: unknown): { paneId: string; hint: TuneHint } | null {
  if (!req || typeof req !== 'object') return null
  const r = req as Record<string, unknown>
  if (typeof r.paneId !== 'string' || !r.paneId || r.paneId.length > 128) return null
  const hint: TuneHint = {}
  if (r.model !== undefined) {
    if (!isClaudeModel(r.model)) return null
    hint.model = r.model
  }
  if (r.effort !== undefined) {
    if (!isTuneEffort(r.effort)) return null
    hint.effort = r.effort
  }
  if (r.ultracode !== undefined) {
    if (typeof r.ultracode !== 'boolean') return null
    hint.ultracode = r.ultracode
  }
  return hint.model || hint.effort || hint.ultracode !== undefined ? { paneId: r.paneId, hint } : null
}

/** The status fields the Enter gate reads (PaneStatus, PaneStatusEvt, RemotePaneStatus). */
export interface TuneGateStatus {
  state: ClaudePaneState | null
  precise?: boolean
  provider?: AgentProvider
  pendingCount?: number
  /** Main only: the agent's session ended (`/exit`), so the pty is back at its shell. */
  ended?: boolean
}

/**
 * The console may get a slash command with Enter: a precise signal (hooks or
 * the Codex bridge, never a title guess) of this provider at rest (idle or
 * done) with no open request, in a session that did not end (after `/exit`
 * the pty is a bare shell). Main checks it again, plus the unsent input.
 */
export function tuneReady(status: TuneGateStatus | null | undefined, provider: AgentProvider): boolean {
  if (!status || status.precise !== true || status.ended === true) return false
  if (status.state !== 'idle' && status.state !== 'done') return false
  if ((status.pendingCount ?? 0) > 0) return false
  return status.provider === provider
}

/**
 * How a write to an agent's pty changes its input box, for the unsent-input
 * check of a tune with Enter: `report` = terminal replies (never typed) and
 * a lone Esc (an interrupt: it neither types nor clears), `cleared` = it ends
 * in Enter or Ctrl+C (the line went out or was dropped), `typed` = anything
 * else (text, arrows, a paste, Alt+Enter or `\` + Enter, which add a line to
 * the box): it may hold a draft. `prevTail` is the last character of the
 * previous non-report write to this pty, so a `\` and its Enter typed as two
 * keystrokes still read as a new line.
 */
export function inputEffect(data: string, isReport: (data: string) => boolean, prevTail = ''): 'report' | 'cleared' | 'typed' {
  if (!data || isReport(data)) return 'report'
  if (data === '\x1b' || data === '\x1b\x1b') return 'report'
  if (data.endsWith('\x03')) return 'cleared'
  if (data.endsWith('\r')) {
    const prev = data.length > 1 ? data[data.length - 2] : prevTail
    return prev === '\x1b' || prev === '\\' ? 'typed' : 'cleared'
  }
  return 'typed'
}

/** The phone shows the sheet only to a desktop that knows `agentTune` (an older one strikes an unknown ctl). */
export const TUNE_MIN_APP_VERSION = '2.3.0'

/**
 * `appVersion` (authOk) is at least `min`. 'dev' counts as new; an empty or
 * unparsable version as old. Pre-release tags are ignored.
 */
export function appVersionAtLeast(appVersion: string | undefined, min: string = TUNE_MIN_APP_VERSION): boolean {
  if (appVersion === 'dev') return true
  const parse = (v: string | undefined): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(appVersion), b = parse(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}
