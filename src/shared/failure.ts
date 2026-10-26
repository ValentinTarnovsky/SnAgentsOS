// Adaptado de paperclipai/paperclip (MIT) - packages/adapters/claude-local/src/server/parse.ts
// Also adapts packages/adapters/codex-local/src/server/parse.ts ("try again at" reset times).
/**
 * Why an agent turn failed (app 2.7.0, E10 SPIKE S6). Pure, with no Node or
 * DOM imports (only ECMAScript `Intl`): main, renderer and mobile share it.
 *
 * - `claudeFailure`: a StopFailure hook (`error` plus `last_assistant_message`
 *   or `error_details`), or the `error` of a `claude -p` stream line.
 * - `codexFailure`: an app-server `codexErrorInfo` (a string or a one-key
 *   object) and its message; a `codex exec` error carries the message only.
 * - `failureFromRateLimit`: a stream-json `rate_limit_event` that was refused.
 * - `parseResetsAt`: the reset time a limit message prints, as epoch ms.
 *
 * `FAILURE_MAP` is the normative S6 table. Text only refines Claude's
 * `rate_limit` (subscription limit or plain rate limit) and `invalid_request`
 * (context window or bad request), and classifies a limit message that comes
 * without any code; an explicit code always keeps its table row otherwise.
 */

export type FailureKind = 'limit' | 'rateLimited' | 'overloaded' | 'auth' | 'billing' | 'context' | 'request' | 'unknown'

/** Every kind, in `status.failure.<kind>` catalog order. */
export const FAILURE_KINDS: readonly FailureKind[] = Object.freeze([
  'limit', 'rateLimited', 'overloaded', 'auth', 'billing', 'context', 'request', 'unknown',
] as const)

export interface FailureInfo {
  kind: FailureKind
  /** When the limit resets (epoch ms), only when the provider said so and it is still ahead. */
  until?: number
  /** The raw provider code (StopFailure `error`, `codexErrorInfo` key, `rateLimitType`), at most 32 characters. */
  code?: string
}

const CODE_MAX = 32
const MIN_MS = 60_000
const DAY_MS = 86_400_000

/** S6: provider code -> kind. Claude's `rate_limit` and `invalid_request` are refined by the text. */
export const FAILURE_MAP: { claude: Readonly<Record<string, FailureKind>>; codex: Readonly<Record<string, FailureKind>> } = Object.freeze({
  /** StopFailure `error`: the 13 values of Claude Code 2.1.309. */
  claude: Object.freeze({
    rate_limit: 'rateLimited',
    overloaded: 'overloaded',
    server_error: 'overloaded',
    authentication_failed: 'auth',
    oauth_org_not_allowed: 'auth',
    account_on_hold: 'auth',
    verification_required: 'auth',
    cloud_credential_error: 'auth',
    billing_error: 'billing',
    invalid_request: 'request',
    model_not_found: 'request',
    max_output_tokens: 'request',
    unknown: 'unknown',
  } satisfies Record<string, FailureKind>),
  /** `codexErrorInfo` (codex-cli 0.163.0 app-server): the string, or the key of the one-key object. */
  codex: Object.freeze({
    usageLimitExceeded: 'limit',
    sessionBudgetExceeded: 'limit',
    rateLimitExceeded: 'rateLimited',
    serverOverloaded: 'overloaded',
    flexUnavailable: 'overloaded',
    internalServerError: 'overloaded',
    unauthorized: 'auth',
    contextWindowExceeded: 'context',
    badRequest: 'request',
    cyberPolicy: 'request',
    misalignmentPolicyViolation: 'request',
    tooManyDenials: 'request',
    sandboxError: 'request',
    threadRollbackFailed: 'request',
    activeTurnNotSteerable: 'request',
    httpConnectionFailed: 'unknown',
    responseStreamConnectionFailed: 'unknown',
    responseStreamDisconnected: 'unknown',
    responseTooManyFailedAttempts: 'unknown',
    other: 'unknown',
  } satisfies Record<string, FailureKind>),
})

/**
 * A subscription limit, not a short rate limit: "You've hit your limit", "usage limit", "5-hour limit reached",
 * and the other prefixes Claude Code 2.1.309 itself treats as one ("You've reached your Fable limit",
 * "You're out of extra usage", "Your org is out of usage").
 */
const LIMIT_TEXT_RE = /hit your|reached your|usage limit|limit reached|out of (?:extra )?usage/i
/** Claude's transient 429 disowns it: "Server is temporarily limiting requests (not your usage limit)". */
const NOT_LIMIT_RE = /\bnot\s+your\s+usage\s+limit/gi
/** A request that did not fit the context window ("Prompt is too long", "exceed context limit"). */
const CONTEXT_TEXT_RE = /prompt is too long|context[\s_-]*(?:window|length|limit)|maximum context|exceed\w*\s+(?:the\s+)?(?:model'?s?\s+)?context/i

function isLimitText(text: string): boolean {
  return LIMIT_TEXT_RE.test(text.replace(NOT_LIMIT_RE, ''))
}

/** Without a code only limit wording classifies, and "Context limit reached" is not a subscription limit. */
function isBareLimit(text: string): boolean {
  return isLimitText(text) && !CONTEXT_TEXT_RE.test(text)
}

/** Own keys only: a code like `constructor` must not reach Object.prototype. */
function kindOf(table: Readonly<Record<string, FailureKind>>, code: string): FailureKind {
  return code && Object.hasOwn(table, code) ? table[code] : 'unknown'
}

function codeOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function failureOf(kind: FailureKind, code: string, until: number | undefined): FailureInfo {
  const out: FailureInfo = { kind }
  if (until !== undefined) out.until = until
  if (code) out.code = code.slice(0, CODE_MAX)
  return out
}

/**
 * A Claude failure from the StopFailure `error` code and its text
 * (`last_assistant_message` or `error_details`). `rate_limit` with limit text
 * is `limit` with `until` from `parseResetsAt`; `invalid_request` with a
 * context-window phrase is `context`. Claude's own "not your usage limit"
 * stays `rateLimited`. Without a code, limit text that is not about the
 * context window still means `limit`; anything else (an unknown code
 * included) is `unknown`.
 */
export function claudeFailure(code: string | undefined, text: string | undefined, now: number): FailureInfo {
  const raw = codeOf(code)
  const body = textOf(text)
  let kind = kindOf(FAILURE_MAP.claude, raw)
  if (raw === 'rate_limit' ? isLimitText(body) : !raw && isBareLimit(body)) kind = 'limit'
  else if (raw === 'invalid_request' && CONTEXT_TEXT_RE.test(body)) kind = 'context'
  return failureOf(kind, raw, kind === 'limit' ? parseResetsAt(body, now) : undefined)
}

/** The `codexErrorInfo` code: the string itself, or the only key of an object. */
function codexCode(info: unknown): string {
  if (typeof info === 'string') return info.trim()
  if (!info || typeof info !== 'object' || Array.isArray(info)) return ''
  const keys = Object.keys(info)
  return keys.length === 1 ? keys[0].trim() : ''
}

/**
 * A Codex failure from `codexErrorInfo` (string or one-key object) and the
 * error message. A limit reads its `until` from the message ("try again at
 * 3:30 PM"). Without a code (`codex exec`), limit text still means `limit`.
 */
export function codexFailure(info: unknown, message: string | undefined, now: number): FailureInfo {
  const raw = codexCode(info)
  const body = textOf(message)
  const kind = raw ? kindOf(FAILURE_MAP.codex, raw) : isBareLimit(body) ? 'limit' : 'unknown'
  return failureOf(kind, raw, kind === 'limit' ? parseResetsAt(body, now) : undefined)
}

/**
 * A stream-json `rate_limit_event` (`rate_limit_info`) as a failure: `limit`
 * when the status is not an allowed one (`allowed`, `allowed_warning`), with
 * `until` from `resetsAt` (epoch seconds) while it is still ahead and the
 * window (`five_hour`, `seven_day`...) as the code. Otherwise null.
 */
export function failureFromRateLimit(
  info: { status?: string; resetsAt?: number; rateLimitType?: string } | undefined,
  now: number,
): FailureInfo | null {
  if (!info || typeof info !== 'object') return null
  const status = codeOf(info.status)
  if (!status || status.startsWith('allowed')) return null
  const at = typeof info.resetsAt === 'number' ? Math.round(info.resetsAt * 1000) : NaN
  return failureOf('limit', codeOf(info.rateLimitType), Number.isFinite(at) && at > now ? at : undefined)
}

/** The i18n key of a kind's label (the strings land with the surfaces, A6). */
export function failureLabelKey(kind: FailureKind): string {
  return `status.failure.${FAILURE_KINDS.includes(kind) ? kind : 'unknown'}`
}

// -- Reset times --------------------------------------------------------------

/** Claude Code before 2.0: "Claude AI usage limit reached|<epoch seconds>". */
const PIPE_RE = /limit reached\s*\|\s*(\d{9,11})(?!\d)/i
/** Where a reset time starts: "resets 3pm", "reset at 5pm", "resets on Oct 25", "try again at 3:30 PM". */
const ANCHOR_RE = /\b(?:resets?|try\s+again)\s+(?:at\s+|on\s+)?/gi
/** How far past an anchor the time may reach. */
const WHEN_SPAN = 120
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/**
 * The time Claude prints in en-US: `3pm`, `3:30pm`, `15:00`, `Oct 25, 3pm`,
 * `Oct 25, 2027, 3:30pm`, each with an optional ` (<IANA zone>)`. Groups:
 * month, day, year, hour, minute, meridiem, zone.
 */
const WHEN_RE = new RegExp(
  '^(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?' +
    '\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?:(\\d{4}),?\\s+)?(?:at\\s+)?)?' +
    '(\\d{1,2})(?::(\\d{2}))?(?:\\s*([ap])\\.?m\\b\\.?)?(?![\\w:])' +
    '(?:\\s*\\(([^()]*)\\))?',
  'i',
)

/** A wall clock reading: an optional date, the time and an optional zone. */
interface Wall {
  year?: number
  month?: number
  day?: number
  hour: number
  minute: number
  zone?: string
}

/**
 * Ms to add to an instant to read its wall clock as a UTC timestamp: the
 * runtime's local zone, or an IANA zone through `Intl.DateTimeFormat`.
 */
type Offset = (t: number) => number

function localOffset(t: number): number {
  return -new Date(t).getTimezoneOffset() * MIN_MS
}

/** The offset function of an IANA zone, or null when the zone is not one. */
function zoneOffset(zone: string): Offset | null {
  if (!zone || zone.length > 64) return null
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
  } catch {
    return null
  }
  return (t) => {
    const p: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {}
    for (const part of fmt.formatToParts(t)) p[part.type] = Number(part.value)
    const wall = Date.UTC(p.year ?? NaN, (p.month ?? NaN) - 1, p.day ?? NaN, (p.hour ?? NaN) % 24, p.minute ?? NaN, p.second ?? NaN)
    return wall - Math.floor(t / 1000) * 1000
  }
}

/**
 * The instants whose wall clock reads `wall` (a wall clock written as a UTC
 * timestamp), earliest first: two in a repeated fall-back hour, and in a
 * skipped spring-forward hour the one the clock moves forward to, as `Date`
 * does with a local time (02:30 becomes 03:30).
 */
function instantsAt(wall: number, offset: Offset): number[] {
  const before = offset(wall - DAY_MS)
  const after = offset(wall + DAY_MS)
  const out: number[] = []
  for (const o of before === after ? [before] : [before, after]) if (offset(wall - o) === o) out.push(wall - o)
  if (!out.length) out.push(wall - before)
  return out.sort((a, b) => a - b)
}

function validDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day
}

/** The first instant after `now` that reads `w`, or undefined. */
function nextAfter(w: Wall, offset: Offset, now: number): number | undefined {
  const at = (year: number, month: number, day: number): number | undefined =>
    validDate(year, month, day) ? instantsAt(Date.UTC(year, month - 1, day, w.hour, w.minute), offset).find((t) => t > now) : undefined
  // Today's date on that clock, read with the getUTC* getters.
  const today = new Date(now + offset(now))
  const year = today.getUTCFullYear()
  if (w.month === undefined || w.day === undefined) {
    // A bare time: today, or tomorrow once it is not after now.
    const tomorrow = new Date(Date.UTC(year, today.getUTCMonth(), today.getUTCDate() + 1))
    return at(year, today.getUTCMonth() + 1, today.getUTCDate())
      ?? at(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate())
  }
  if (w.year !== undefined) return at(w.year, w.month, w.day)
  // A month and day without a year: this year, or next year once it passed.
  return at(year, w.month, w.day) ?? at(year + 1, w.month, w.day)
}

/** A `WHEN_RE` match as a wall clock, or null when a field is out of range. */
function wallOf(m: RegExpExecArray): Wall | null {
  const [, month, day, year, hour, minute, meridiem, zone] = m
  const h = Number(hour)
  const w: Wall = { hour: h, minute: minute === undefined ? 0 : Number(minute) }
  if (w.minute > 59) return null
  if (meridiem) {
    if (h < 1 || h > 12) return null
    w.hour = (h % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0)
  } else if (minute === undefined || h > 23) {
    // Without am/pm only a 24-hour HH:MM is a time ("resets 3" is not).
    return null
  }
  if (month !== undefined) {
    w.month = MONTHS.indexOf(month.slice(0, 3).toLowerCase()) + 1
    w.day = Number(day)
    if (year !== undefined) w.year = Number(year)
  }
  if (zone !== undefined) w.zone = zone.trim()
  return w
}

/** Parses a time at the start of `s` (the whole of `s` when `whole`). */
function resetFrom(s: string, now: number, whole: boolean): number | undefined {
  const m = WHEN_RE.exec(s)
  if (!m || (whole && !/^[\s.,;!]*$/.test(s.slice(m[0].length)))) return undefined
  const w = wallOf(m)
  if (!w) return undefined
  const offset = w.zone === undefined ? localOffset : zoneOffset(w.zone)
  return offset ? nextAfter(w, offset, now) : undefined
}

/**
 * When a limit resets, as epoch ms strictly after `now`, from a message such as
 * "You've hit your limit · resets 3pm (America/Argentina/Buenos_Aires)",
 * "try again at 3:30 PM", a bare "15:00" or "Oct 25, 2027, 3:30pm", or the old
 * "usage limit reached|<epoch seconds>". A time with a ` (<IANA zone>)` is read
 * in that zone, one without in the runtime's local time. A bare time not after
 * `now` means tomorrow and a month/day already past means next year; a full
 * date already past, an unparsable text or an invalid zone give undefined.
 * Never throws.
 */
export function parseResetsAt(text: string, now: number): number | undefined {
  try {
    if (typeof text !== 'string' || !Number.isFinite(now)) return undefined
    const pipe = PIPE_RE.exec(text)
    if (pipe) {
      const at = Number(pipe[1]) * 1000
      return at > now ? at : undefined
    }
    for (const m of text.matchAll(ANCHOR_RE)) {
      const start = (m.index ?? 0) + m[0].length
      const at = resetFrom(text.slice(start, start + WHEN_SPAN), now, false)
      if (at !== undefined) return at
    }
    return resetFrom(text.trim(), now, true)
  } catch {
    return undefined
  }
}
