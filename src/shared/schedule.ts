/**
 * Recurring pane automations (E8-FR-28..31). Pure rules shared by the
 * renderer ticker (usePaneScheduler), the schedule dialog, the Settings table
 * and the tests: when the next run is (`nextDue`), what one tick does with a
 * due schedule (`decide`), the bounded run history (`pushHistory`) and the
 * schedule after a run (`afterRun`).
 *
 * Times are local wall-clock times computed with `Date` and `setHours`, like
 * the one-shot schedule always did: on a DST spring-forward day a time inside
 * the gap moves forward with the clock (02:30 runs at 03:30), and a repeated
 * fall-back hour runs once (the first one). A `cron` rule (app 2.7.0) follows
 * the same DST rules through `nextCron` (cron.ts).
 *
 * App 2.7.0 (schema 19): a console holds up to PANE_SCHEDULES_MAX schedules
 * (`Pane.schedules`), each with its own id; every rule here works on one.
 * The time of a next run in a label (`formatRunWhen`) is shared by the
 * desktop and the phone: a run 6 or more days away carries its date.
 */
import type { ClaudePaneState, Language, Pane, PaneSchedule, ScheduleRecurrence, ScheduleRun } from './types'
import { typingBlocked } from './agentTune'
import { cronMinIntervalOk, nextCron, parseCron } from './cron'

/** Schedules one console may hold (schema 19); the schema drops the rest. */
export const PANE_SCHEDULES_MAX = 8
/** A schedule id within its pane, `s1`..`s999`; the migrated single schedule of schema <= 18 is `s1`. */
export const SCHEDULE_ID_RE = /^s[0-9]{1,3}$/
/**
 * `dueAt` of a cron rule with no next run (the latest `Date`), so it never
 * comes due. The schema and the dialog refuse such a rule (`cronRuleError`);
 * this only keeps one that slipped through from firing every hour.
 */
export const SCHEDULE_NEVER = 8_640_000_000_000_000

/** Runs kept per schedule; the 21st drops the oldest (E8-FR-31). */
export const SCHEDULE_HISTORY_MAX = 20
/** Runs the dialog lists before "See all". */
export const SCHEDULE_HISTORY_SHOWN = 5
/** Monday..Friday (`Date.getDay()` numbering, 0 = Sunday). */
export const WEEKDAY_DAYS: readonly number[] = [1, 2, 3, 4, 5]
/** Day toggle order of the dialog: L M X J V S D. */
export const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

const HOUR_MS = 3_600_000
const MIN_MS = 60_000
/**
 * Lateness that never counts against the grace: the 1 s ticker, and Chromium
 * slowing timers to about one per minute while the window sits hidden in the
 * tray. Without it a grace of 0 would log every run as missed.
 */
export const SCHEDULE_DUE_SLACK_MS = 2 * MIN_MS

/** "HH:MM" (00..23, 00..59) to numbers, or null when malformed. */
export function parseTime(time: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return { h, m }
}

/** The repeat rule, defaulting to one-shot (schema 13: absent = once). */
export function recurrenceOf(schedule: Pick<PaneSchedule, 'recurrence'>): ScheduleRecurrence {
  return schedule.recurrence ?? { kind: 'once' }
}

/** Paused only when `enabled` is exactly false (absent = active). */
export function isScheduleEnabled(schedule: Pick<PaneSchedule, 'enabled'>): boolean {
  return schedule.enabled !== false
}

/** Waits for a free agent unless `waitIdle` is exactly false (absent = on). */
export function waitsForIdle(schedule: Pick<PaneSchedule, 'waitIdle'>): boolean {
  return schedule.waitIdle !== false
}

/** Days a day-based rule may run on (`hourly` runs every day). */
function allowedDays(rec: ScheduleRecurrence): readonly number[] | null {
  if (rec.kind === 'weekdays') return WEEKDAY_DAYS
  if (rec.kind === 'weekly') return rec.days.length > 0 ? rec.days : null
  return null
}

/**
 * Next epoch-ms occurrence of an "HH:MM" wall-clock time strictly after
 * `from`: today if it is still ahead, else tomorrow.
 */
export function nextOccurrence(time: string, from: Date | number = new Date()): number {
  return nextDue({ time }, from)
}

/**
 * Next epoch-ms run of a schedule strictly after `from` (E8-FR-28).
 * once / daily: the next HH:MM; weekdays: the next HH:MM on Mon..Fri;
 * weekly: the next HH:MM on one of `days`; hourly: the next hh:MM, with the
 * minute taken from `time`. A malformed time falls back to 1 h from `from`.
 * cron (app 2.7.0): the expression's next run (`nextCron`), whatever `time`
 * holds; a rule with none gives SCHEDULE_NEVER.
 */
export function nextDue(schedule: Pick<PaneSchedule, 'time' | 'recurrence'>, from: Date | number = new Date()): number {
  const fromMs = typeof from === 'number' ? from : from.getTime()
  const rec = recurrenceOf(schedule)
  // Before parseTime: a cron schedule's `time` is not part of its rule.
  if (rec.kind === 'cron') return nextCron(rec.expr, fromMs) ?? SCHEDULE_NEVER
  const t = parseTime(schedule.time)
  if (!t) return fromMs + HOUR_MS
  if (rec.kind === 'hourly') {
    const due = new Date(fromMs)
    due.setMinutes(t.m, 0, 0)
    // Whole-hour steps keep the minute across a DST change.
    return due.getTime() > fromMs ? due.getTime() : due.getTime() + HOUR_MS
  }
  const days = allowedDays(rec)
  // Eight days always reach every allowed weekday at least once.
  for (let i = 0; i <= 8; i++) {
    const due = new Date(fromMs)
    due.setDate(due.getDate() + i)
    due.setHours(t.h, t.m, 0, 0)
    if (due.getTime() <= fromMs) continue
    if (days && !days.includes(due.getDay())) continue
    return due.getTime()
  }
  return fromMs + HOUR_MS
}

/** What one tick does with a schedule (E8-FR-29/30). */
export type ScheduleDecision = 'idle' | 'wait' | 'fire' | 'missed' | 'skip_busy' | 'fail_no_agent'

/** The pane's live agent state as the status channel reports it. */
export interface ScheduleAgentSignal {
  state: ClaudePaneState
  precise: boolean
  /** Open requests (hooks): one still waiting on the user blocks like a precise `action`. */
  pendingCount?: number
}

export interface DecideInput {
  schedule: PaneSchedule
  now: number
  /** 'manual' ("Run now"): always due, no grace, runs even when paused. */
  trigger?: 'scheduled' | 'manual'
  /** Wait start of a manual run (transient; a scheduled run uses `schedule.waitingSince`). */
  manualSince?: number
  /** `paneStatus[paneId]`, absent when the pane reported nothing. */
  status?: ScheduleAgentSignal | null
  /** The pane runs Claude Code or Codex (by type or preset). */
  agent: boolean
  /** The pane has a live pty to write into. */
  live: boolean
  graceMin: number
  maxWaitMin: number
}

/**
 * Why a due run cannot be sent right now, or null when it can.
 * Free: idle, done, error, or an `action` without hooks (an end of turn read
 * from the title). Busy: working, or a precise `action` (a real permission,
 * question or plan): nothing is ever typed over it. No state (or `unknown`)
 * is free only in a shell/custom pane; in an agent pane the agent may have
 * exited and the text would run in the shell, so it waits. With `waitIdle`
 * off a working agent is typed over, but a precise `action` still blocks:
 * the text plus Enter would answer a real permission or question. An open
 * request (precise `pendingCount` > 0) blocks the same way (`typingBlocked`).
 */
function blocker(input: DecideInput): 'busy' | 'no_agent' | null {
  if (!input.live) return 'no_agent'
  const st = input.status
  if (!st || st.state === 'unknown') return input.agent ? 'no_agent' : null
  if (typingBlocked(st)) return 'busy'
  if (st.state === 'working' && waitsForIdle(input.schedule)) return 'busy'
  return null
}

/**
 * One tick of the scheduler for one schedule.
 * - 'idle': nothing to do (paused or not due).
 * - 'missed': later than `graceMin` when first seen (the PC was off or
 *   asleep), or a stale wait the app outlived: record one `missed` and move on.
 * - 'fire': send now.
 * - 'wait': busy or no agent yet; the caller starts the wait clock if unset.
 * - 'skip_busy' / 'fail_no_agent': the wait reached `maxWaitMin`.
 */
export function decide(input: DecideInput): ScheduleDecision {
  const { schedule, now } = input
  const manual = input.trigger === 'manual'
  const since = manual ? input.manualSince : schedule.waitingSince
  if (!manual) {
    if (!isScheduleEnabled(schedule) || now < schedule.dueAt) return 'idle'
    const late = now - schedule.dueAt
    const grace = input.graceMin * MIN_MS + SCHEDULE_DUE_SLACK_MS
    if (since === undefined && late > grace) return 'missed'
    // A legit wait starts within the grace and lasts at most maxWait.
    if (since !== undefined && late > grace + input.maxWaitMin * MIN_MS) return 'missed'
  }
  const block = blocker(input)
  if (!block) return 'fire'
  if (since !== undefined && now - since >= input.maxWaitMin * MIN_MS) return block === 'busy' ? 'skip_busy' : 'fail_no_agent'
  return 'wait'
}

/** Appends a run, keeping the 20 most recent by `at` (stored order kept). */
export function pushHistory(history: readonly ScheduleRun[] | undefined, run: ScheduleRun): ScheduleRun[] {
  const next = [...(history ?? []), run]
  while (next.length > SCHEDULE_HISTORY_MAX) {
    let oldest = 0
    for (let i = 1; i < next.length; i++) if (next[i].at < next[oldest].at) oldest = i
    next.splice(oldest, 1)
  }
  return next
}

/** Newest first, for the dialog and the table. */
export function recentRuns(history: readonly ScheduleRun[] | undefined): ScheduleRun[] {
  return [...(history ?? [])].sort((a, b) => b.at - a.at)
}

/**
 * The schedule after a run. Always appends the run. A manual run moves
 * nothing else ("Run now" never moves `dueAt`). A scheduled run (sent,
 * skipped, missed or failed) ends the wait: a one-shot pauses and keeps its
 * history, a recurring one moves `dueAt` to its next occurrence after `now`.
 * `servedDueAt` is the occurrence the run was for: when the user edited the
 * schedule meanwhile (another `dueAt`), their new time is kept.
 */
export function afterRun(schedule: PaneSchedule, run: ScheduleRun, now: number, servedDueAt: number = run.scheduledFor): PaneSchedule {
  const history = pushHistory(schedule.history, run)
  if (run.trigger === 'manual' || schedule.dueAt !== servedDueAt) return { ...schedule, history }
  const { waitingSince: _ended, ...rest } = schedule
  if (recurrenceOf(schedule).kind === 'once') return { ...rest, enabled: false, history }
  return { ...rest, dueAt: nextDue(schedule, now), history }
}

/**
 * Pause or resume. Resuming a schedule whose time already passed (a fired
 * one-shot, a long pause) moves it to its next occurrence, so it never fires
 * late or logs a `missed` the moment it is switched back on.
 */
export function withEnabled(schedule: PaneSchedule, enabled: boolean, now: number): PaneSchedule {
  const { waitingSince: _reset, ...rest } = schedule
  if (!enabled) return { ...rest, enabled: false }
  const dueAt = schedule.dueAt > now ? schedule.dueAt : nextDue(schedule, now)
  return { ...rest, enabled: true, dueAt }
}

/** Same rule as the schema: 1..7 distinct days in 0..6. */
export function validWeeklyDays(days: readonly number[]): boolean {
  return days.length >= 1 && days.length <= 7 && new Set(days).size === days.length && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
}

/**
 * Why a cron expression cannot be stored, or null when it can (app 2.7.0;
 * the same test in the schema and the dialog): `invalid` does not parse,
 * `never` has no run within the 4 years `nextCron` looks ahead of `now`,
 * `interval` runs less than CRON_MIN_INTERVAL_MIN (15) minutes apart.
 * `cronMinIntervalOk` is not cheap: call this on an edit or a load, never per tick.
 */
export function cronRuleError(expr: string, now: number): 'invalid' | 'never' | 'interval' | null {
  const spec = parseCron(expr)
  if (!spec) return 'invalid'
  if (nextCron(spec, now) === null) return 'never'
  if (!cronMinIntervalOk(spec)) return 'interval'
  return null
}

/** A console's schedules in their stored order (schema 19; absent = none). */
export function paneSchedules(pane: Pick<Pane, 'schedules'>): PaneSchedule[] {
  return pane.schedules ?? []
}

/** The lowest free id (`s1`, `s2`, ...) for a new schedule, or null once the console holds PANE_SCHEDULES_MAX. */
export function nextScheduleId(schedules: readonly Pick<PaneSchedule, 'id'>[] | undefined): string | null {
  const list = schedules ?? []
  if (list.length >= PANE_SCHEDULES_MAX) return null
  const taken = new Set(list.map((s) => s.id))
  for (let n = 1; n <= 999; n++) if (!taken.has(`s${n}`)) return `s${n}`
  return null
}

/** `paneId#scheduleId`: the key of one schedule in the scheduler runtime and the phone's rows. */
export function scheduleKey(paneId: string, scheduleId: string): string {
  return `${paneId}#${scheduleId}`
}

/**
 * Calendar days, today included, whose run a "next run" label names by its
 * weekday alone: today and the next five, six different weekdays that all
 * read as this week's. A cron rule (app 2.7.0) can run weeks, months or
 * years ahead, so "dom 09:00" a month away would read as this Sunday.
 */
export const RUN_WEEKDAY_DAYS = 6

/** How a run's label names its day: weekday alone, with day and month, or with the year too. */
export type RunWhenStyle = 'weekday' | 'date' | 'year'

/**
 * `weekday` within the RUN_WEEKDAY_DAYS calendar days that start on `now`'s,
 * `date` further away (or before today), `year` in a year other than `now`'s,
 * even a day or two ahead.
 */
export function runWhenStyle(at: number, now: number): RunWhenStyle {
  const run = new Date(at)
  const today = new Date(now)
  if (run.getFullYear() !== today.getFullYear()) return 'year'
  // Local midnights, rounded: a 23 h or 25 h DST day still counts as one.
  const days = Math.round((new Date(run.getFullYear(), run.getMonth(), run.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / (24 * HOUR_MS))
  return days >= 0 && days < RUN_WEEKDAY_DAYS ? 'weekday' : 'date'
}

const runFormats = new Map<string, Intl.DateTimeFormat>()

function runFormat(lang: Language, style: RunWhenStyle): Intl.DateTimeFormat {
  const key = `${lang}:${style}`
  let f = runFormats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(
      lang,
      style === 'weekday'
        ? { weekday: 'short' }
        : { weekday: 'short', day: 'numeric', month: 'short', ...(style === 'year' ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    )
    runFormats.set(key, f)
  }
  return f
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * The local time of a run as every "next run" label shows it (the desktop's
 * header clock, schedule list and Settings table, the phone's cards):
 * "lun 09:00" / "Mon 09:00" within RUN_WEEKDAY_DAYS days, else with the date,
 * "dom, 1 nov, 09:00" / "Sun, Nov 1, 09:00", and the year when it is not
 * `now`'s, "mar, 29 feb 2028, 00:00" / "Tue, Feb 29, 2028, 00:00".
 */
export function formatRunWhen(at: number, lang: Language, now: number = Date.now()): string {
  const style = runWhenStyle(at, now)
  const d = new Date(at)
  // Dot-free like the rest of the weekday names ("lun", never "lun.").
  if (style === 'weekday') return `${runFormat(lang, 'weekday').format(d).replace(/\.$/, '')} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return runFormat(lang, style).format(d)
}

/** A run with its date even when it is only days away (the year when it is not `now`'s): the dialog's next 3 cron runs, listed together. */
export function formatRunDate(at: number, lang: Language, now: number = Date.now()): string {
  return runFormat(lang, new Date(at).getFullYear() !== new Date(now).getFullYear() ? 'year' : 'date').format(new Date(at))
}
