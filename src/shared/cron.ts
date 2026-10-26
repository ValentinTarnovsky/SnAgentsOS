/**
 * Cron expressions for pane schedules (app 2.7.0; A10 wires them into
 * schedule.ts). Pure and zod-free so main (schema), the renderer (dialog,
 * ticker) and the phone can share it.
 *
 * Syntax: exactly 5 fields, minute hour day-of-month month day-of-week, with
 * lists (1,15), ranges (1-5), steps (*\/5, 1-10/2, and 5/15 for 5-max/15),
 * month names jan..dec and weekday names sun..sat in any case; 0 and 7 are
 * Sunday. No @daily macros and no ?, L, W or #.
 *
 * Day rule (Vixie cron): when day-of-month and day-of-week are both
 * restricted, a day runs if either one matches ("0 9 1 * 1" is the 1st and
 * every Monday). When either field starts with "*" (so "*\/2" too), a day
 * must match both.
 *
 * Times are local wall-clock times, placed the way `nextOccurrence`
 * (schedule.ts) places a daily time: a time inside a DST spring-forward gap
 * moves forward with the clock (02:30 runs at 03:30, once even when 03:30
 * matches too), and a repeated fall-back hour runs once (the first one).
 * Unlike the `hourly` rule, which steps whole real hours, "30 * * * *" runs
 * at the first 01:30 only, and "*\/15 * * * *" goes from the first 01:45
 * straight to 02:00.
 */

/** A parsed expression: the values each field matches, sorted and unique. */
export interface CronSpec {
  /** The expression trimmed, its fields joined by one space. */
  expr: string
  /** 0..59 */
  minutes: number[]
  /** 0..23 */
  hours: number[]
  /** Day of month, 1..31. */
  days: number[]
  /** 1..12 */
  months: number[]
  /** `Date.getDay()` numbering, 0 = Sunday (a written 7 is stored as 0). */
  weekdays: number[]
  /** The day-of-month field starts with "*": a day matches both day fields, not either. */
  domStar: boolean
  /** The day-of-week field starts with "*": same rule as `domStar`. */
  dowStar: boolean
}

/** Longest expression accepted, untrimmed (the schema caps the stored string the same). */
export const CRON_EXPR_MAX = 120
/** Closest two runs of a cron schedule may be, in minutes (`cronMinIntervalOk`). */
export const CRON_MIN_INTERVAL_MIN = 15

const MIN_MS = 60_000
const DAY_MS = 86_400_000
/** `nextCron` looks this far ahead of `from`; a rule with no run by then never runs. */
const HORIZON_YEARS = 4
/** Longer than any DST jump: enough to see a spring forward that `from` just passed. */
const GAP_LOOKBACK_MS = 3 * 3_600_000

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldDef {
  min: number
  max: number
  /** Upper end of "*" and of an open "5/15": 6 for weekdays, so 7 only counts when written. */
  top: number
  /** Names by value, starting at `min`. */
  names?: readonly string[]
}

const FIELDS: readonly FieldDef[] = [
  { min: 0, max: 59, top: 59 },
  { min: 0, max: 23, top: 23 },
  { min: 1, max: 31, top: 31 },
  { min: 1, max: 12, top: 12, names: MONTH_NAMES },
  { min: 0, max: 7, top: 6, names: DAY_NAMES },
]

function fieldValue(token: string, f: FieldDef): number | null {
  let v: number
  if (/^\d{1,2}$/.test(token)) v = Number(token)
  else if (f.names && /^[a-z]{3}$/i.test(token)) {
    const i = f.names.indexOf(token.toLowerCase())
    if (i < 0) return null
    v = f.min + i
  } else return null
  return v >= f.min && v <= f.max ? v : null
}

function parseField(text: string, f: FieldDef, weekday: boolean): number[] | null {
  const out = new Set<number>()
  for (const item of text.split(',')) {
    const m = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(item)
    if (!m) return null
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (step < 1 || step > f.max - f.min + 1) return null
    let lo: number
    let hi: number
    if (m[1] === '*') {
      lo = f.min
      hi = f.top
    } else {
      const ends = m[1].split('-')
      if (ends.length > 2) return null
      const a = fieldValue(ends[0], f)
      const b = ends.length === 2 ? fieldValue(ends[1], f) : a
      if (a === null || b === null || a > b) return null
      lo = a
      hi = ends.length === 1 && m[2] !== undefined ? f.top : b
    }
    if (lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(weekday && v === 7 ? 0 : v)
  }
  return [...out].sort((x, y) => x - y)
}

/**
 * Parses a 5-field expression (see the module comment). Surrounding
 * whitespace is trimmed and runs of spaces or tabs between fields collapse.
 * Null for anything else: another field count, a value out of range, a
 * reversed range, a zero step, an unknown name or more than CRON_EXPR_MAX
 * characters.
 */
export function parseCron(expr: string): CronSpec | null {
  if (typeof expr !== 'string' || expr.length > CRON_EXPR_MAX) return null
  const parts = expr.trim().split(/[ \t]+/)
  if (parts.length !== 5) return null
  const values: number[][] = []
  for (let i = 0; i < 5; i++) {
    const v = parseField(parts[i], FIELDS[i], i === 4)
    if (!v) return null
    values.push(v)
  }
  return {
    expr: parts.join(' '),
    minutes: values[0],
    hours: values[1],
    days: values[2],
    months: values[3],
    weekdays: values[4],
    domStar: parts[2].startsWith('*'),
    dowStar: parts[4].startsWith('*'),
  }
}

function toSpec(spec: CronSpec | string): CronSpec | null {
  return typeof spec === 'string' ? parseCron(spec) : (spec ?? null)
}

// Wall-clock times are handled as "wall keys": Date.UTC of the local fields,
// so calendar steps never meet a DST jump. `instantOf` turns one into the
// real epoch ms the way `new Date(y, m, d, h, mi)` does.

function wallKeyOf(ms: number): number {
  const t = new Date(ms)
  return Date.UTC(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes())
}

function instantOf(key: number): number {
  const t = new Date(key)
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes()).getTime()
}

function daysIn(y: number, month: number): number {
  return new Date(Date.UTC(y, month, 0)).getUTCDate()
}

/** The day fields, with the Vixie OR when both are restricted (months checked apart). */
function dayMatches(s: CronSpec, y: number, month: number, d: number): boolean {
  const dom = s.days.includes(d)
  const dow = s.weekdays.includes(new Date(Date.UTC(y, month - 1, d)).getUTCDay())
  return s.domStar || s.dowStar ? dom && dow : dom || dow
}

/**
 * First wall key at or after `key` that matches every field, or null past
 * `limit`. Steps field by field (month, day, hour, minute), jumping to the
 * next allowed value, so even an impossible date costs one pass per month.
 */
function nextWall(s: CronSpec, key: number, limit: number): number | null {
  const t = new Date(key)
  let y = t.getUTCFullYear()
  let month = t.getUTCMonth() + 1
  let d = t.getUTCDate()
  let h = t.getUTCHours()
  let mi = t.getUTCMinutes()
  const lastYear = new Date(limit).getUTCFullYear()
  const nextDay = (): void => {
    h = 0
    mi = 0
    if (++d > daysIn(y, month)) {
      d = 1
      if (++month > 12) {
        month = 1
        y++
      }
    }
  }
  while (y <= lastYear) {
    if (!s.months.includes(month)) {
      const next = s.months.find((v) => v > month)
      d = 1
      h = 0
      mi = 0
      if (next === undefined) {
        month = 1
        y++
      } else month = next
      continue
    }
    if (!dayMatches(s, y, month, d)) {
      nextDay()
      continue
    }
    if (!s.hours.includes(h)) {
      const next = s.hours.find((v) => v > h)
      if (next === undefined) nextDay()
      else {
        h = next
        mi = 0
      }
      continue
    }
    if (!s.minutes.includes(mi)) {
      const next = s.minutes.find((v) => v > mi)
      if (next === undefined) {
        mi = 0
        if (++h > 23) nextDay()
        continue
      }
      mi = next
    }
    const at = Date.UTC(y, month - 1, d, h, mi)
    return at <= limit ? at : null
  }
  return null
}

/**
 * Next epoch-ms run strictly after `from`, in local time with minute
 * precision, or null when the expression is invalid or nothing runs within 4
 * years ("0 0 31 2 *"; a leap day 4 years ahead still counts). DST as in the
 * module comment.
 */
export function nextCron(spec: CronSpec | string, from: number): number | null {
  const s = toSpec(spec)
  if (!s || !Number.isFinite(from)) return null
  const now = wallKeyOf(from)
  const w = new Date(now)
  const limit = Date.UTC(w.getUTCFullYear() + HORIZON_YEARS, w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes())
  // Right after a spring forward, a time inside the gap may still be ahead
  // (it runs as late as the gap), so the search starts back by that much.
  const jumpMin = Math.max(0, new Date(from - GAP_LOOKBACK_MS).getTimezoneOffset() - new Date(from).getTimezoneOffset())
  let key = now + MIN_MS - jumpMin * MIN_MS
  let best: number | null = null
  let bestWall = Infinity
  for (;;) {
    const c = nextWall(s, key, limit)
    // Any later wall time runs later than a run already found there.
    if (c === null || c >= bestWall) return best
    const at = instantOf(c)
    // A repeated hour's first instance may already be behind `from`.
    if (at > from && (best === null || at < best)) {
      best = at
      bestWall = wallKeyOf(at)
      // A real wall time is the earliest from here on. One inside a gap runs
      // as late as the gap, and a real time right after a short gap (30 min)
      // can still come before it.
      if (bestWall === c) return best
    }
    key = c + MIN_MS
  }
}

/** The next `n` runs after `from`, fewer when the rule runs out within the cap of `nextCron`. */
export function nextRuns(spec: CronSpec | string, from: number, n: number): number[] {
  const s = toSpec(spec)
  const out: number[] = []
  if (!s || !Number.isFinite(n)) return out
  let at = from
  while (out.length < n) {
    const next = nextCron(s, at)
    if (next === null) break
    out.push(next)
    at = next
  }
  return out
}

const SCAN_FROM = Date.UTC(2024, 0, 1)
const SCAN_TO = Date.UTC(2053, 0, 1)

/**
 * Whether two days the rule runs on sit fewer than `within` days apart.
 * 2024-2052 holds a whole 28-year cycle of weekday and leap year alignments
 * (the Gregorian calendar repeats that way from 1901 to 2099).
 */
function runDaysCloserThan(s: CronSpec, within: number): boolean {
  let last = -Infinity
  for (let t = SCAN_FROM, i = 0; t < SCAN_TO; t += DAY_MS, i++) {
    const d = new Date(t)
    const month = d.getUTCMonth() + 1
    if (!s.months.includes(month) || !dayMatches(s, d.getUTCFullYear(), month, d.getUTCDate())) continue
    if (i - last < within) return true
    last = i
  }
  return false
}

/**
 * Whether no two consecutive runs are closer than `minMinutes`, worked out
 * from the fields: runs in the same hour, the last run of an hour and the
 * first of the next hour that runs, and the last run of a day and the first
 * of the next day that runs (only rules that run near both 00:00 and 23:59
 * scan the calendar). "*\/5 * * * *" and "0,10 9 * * *" fail, "0 * * * *"
 * passes. Wall-clock gaps: a spring-forward night can bring two runs up to an
 * hour closer once a year. False for an invalid expression.
 */
export function cronMinIntervalOk(spec: CronSpec | string, minMinutes: number = CRON_MIN_INTERVAL_MIN): boolean {
  const s = toSpec(spec)
  if (!s || s.minutes.length === 0 || s.hours.length === 0) return false
  const { minutes: m, hours: h } = s
  for (let i = 1; i < m.length; i++) if (m[i] - m[i - 1] < minMinutes) return false
  const inHour = m[m.length - 1] - m[0]
  for (let i = 1; i < h.length; i++) if ((h[i] - h[i - 1]) * 60 - inHour < minMinutes) return false
  // Run days k apart leave k * 1440 - inDay minutes between them.
  const inDay = h[h.length - 1] * 60 + m[m.length - 1] - (h[0] * 60 + m[0])
  const within = (minMinutes + inDay) / 1440
  return within <= 1 || !runDaysCloserThan(s, within)
}
