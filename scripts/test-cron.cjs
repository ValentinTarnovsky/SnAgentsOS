process.env.TZ = 'America/New_York' // before any Date use: the DST cases need a zone with DST
// Cron expressions (app 2.7.0, A2): src/shared/cron.ts. parseCron (5 fields,
// lists, ranges, steps, month and weekday names, 0 and 7 as Sunday,
// whitespace, the 120 character cap, invalid input), nextCron (strictly after
// `from`, field by field, Vixie OR, leap day, the 4 year cap, year rollover,
// DST gap and overlap placed like a daily time of schedule.ts, also in a zone
// with a 30 minute DST), nextRuns and cronMinIntervalOk (exact against
// sampled runs).
// Same esbuild + vm harness as test-status.cjs.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, structuredClone, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
// Values built inside the vm have another realm's prototypes; compare as JSON.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const MIN = 60_000, HOUR = 3_600_000
const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()
const hm = (ms) => { const d = new Date(ms); return `${d.getDay()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const offset = (ms) => new Date(ms).getTimezoneOffset()

const C = load('src/shared/cron.ts')
const S = load('src/shared/schedule.ts')
const fields = (expr) => { const s = C.parseCron(expr); return s && [s.minutes, s.hours, s.days, s.months, s.weekdays] }
const range = (a, b, step = 1) => { const out = []; for (let v = a; v <= b; v += step) out.push(v); return out }

function parseChecks() {
  check(C.CRON_EXPR_MAX === 120 && C.CRON_MIN_INTERVAL_MIN === 15, 'constants: 120 characters, 15 minutes')
  const all = C.parseCron('* * * * *')
  check(same(fields('* * * * *'), [range(0, 59), range(0, 23), range(1, 31), range(1, 12), range(0, 6)]) && all.domStar && all.dowStar && all.expr === '* * * * *', '"* * * * *" matches everything, weekdays 0..6, both day fields unrestricted')
  check(same(C.parseCron('*/5 * * * *').minutes, range(0, 55, 5)), '*/5 is every 5 minutes from 0')
  check(same(C.parseCron('1-10/2 * * * *').minutes, [1, 3, 5, 7, 9]), '1-10/2 steps through a range')
  check(same(C.parseCron('0-59/15 * * * *').minutes, [0, 15, 30, 45]) && same(C.parseCron('5/15 * * * *').minutes, [5, 20, 35, 50]), 'a range with a step; a single value with a step runs to the field maximum')
  check(same(C.parseCron('1,2,3-5,10-20/5 * * * *').minutes, [1, 2, 3, 4, 5, 10, 15, 20]), 'lists mix values, ranges and stepped ranges')
  check(same(C.parseCron('5,5,1,3-4,4 * * * *').minutes, [1, 3, 4, 5]), 'values come out sorted and unique')
  check(same(C.parseCron('0 9-17 * * *').hours, range(9, 17)) && same(C.parseCron('0 */6 * * *').hours, [0, 6, 12, 18]), 'hour ranges and steps')
  check(same(C.parseCron('05 09 07 03 01').minutes, [5]) && same(fields('05 09 07 03 01'), [[5], [9], [7], [3], [1]]), 'leading zeros are fine')
  check(same(C.parseCron('0 0 1,15,31 * *').days, [1, 15, 31]) && same(C.parseCron('0 0 * 1-12/3 *').months, [1, 4, 7, 10]), 'day of month and month fields')

  // Names, any case.
  check(same(C.parseCron('0 0 * jan,mar-may *').months, [1, 3, 4, 5]) && same(C.parseCron('0 0 * JAN-Dec/3 *').months, [1, 4, 7, 10]), 'month names jan..dec in lists, ranges and steps, any case')
  check(same(C.parseCron('0 0 * * mon-fri').weekdays, [1, 2, 3, 4, 5]) && same(C.parseCron('0 0 * * SUN,Sat').weekdays, [0, 6]) && same(C.parseCron('0 0 * * Tue,THU').weekdays, [2, 4]), 'weekday names sun..sat, any case')
  check(same(C.parseCron('0 0 * dec *').months, [12]) && same(C.parseCron('0 0 * * sat').weekdays, [6]), 'the last name of each list')

  // 0 and 7 are Sunday.
  check(same(C.parseCron('0 9 * * 7').weekdays, [0]) && same(C.parseCron('0 9 * * 0').weekdays, [0]) && same(C.parseCron('0 9 * * sun').weekdays, [0]), '7, 0 and sun are all Sunday')
  check(same(C.parseCron('0 9 * * 5-7').weekdays, [0, 5, 6]) && same(C.parseCron('0 9 * * 0-7').weekdays, range(0, 6)) && same(C.parseCron('0 9 * * 0,7').weekdays, [0]), 'a range ending on 7 includes Sunday once')
  check(same(C.parseCron('0 9 * * */2').weekdays, [0, 2, 4, 6]) && same(C.parseCron('0 9 * * 1/2').weekdays, [1, 3, 5]) && same(C.parseCron('0 9 * * 1-7/2').weekdays, [0, 1, 3, 5]), '"*" and an open step stop at Saturday; a written 7 counts')

  // Whitespace.
  const ws = C.parseCron('  0   9 \t *  *   1-5  ')
  check(ws && ws.expr === '0 9 * * 1-5' && same(ws.weekdays, [1, 2, 3, 4, 5]), 'surrounding whitespace is trimmed and runs of spaces or tabs collapse: ' + (ws && ws.expr))
  check(C.parseCron('0 9 * * *\n') !== null && C.parseCron('0 9\n* * *') === null, 'a trailing newline is trimmed; one between fields is not a separator')
  check(C.parseCron('0 9 * * MON').expr === '0 9 * * MON', 'expr keeps the case as typed')

  // Day field flags (Vixie: the field starts with "*").
  const flags = (e) => { const s = C.parseCron(e); return `${s.domStar}/${s.dowStar}` }
  check(flags('0 0 1 * *') === 'false/true' && flags('0 0 * * 1') === 'true/false' && flags('0 0 1 * 1') === 'false/false', 'domStar and dowStar follow which field is restricted')
  check(flags('0 0 */2 * 1') === 'true/false' && flags('0 0 1-31 * 1') === 'false/false' && flags('0 0 1 * */1') === 'false/true', '"*/n" counts as unrestricted; a full range written out does not')

  // The length cap is on the untrimmed string, like the schema.
  const long = '00' + ',0'.repeat(55) + ' * * * *'
  check(long.length === 120 && C.parseCron(long) !== null && same(C.parseCron(long).minutes, [0]), 'a 120 character expression parses')
  check(C.parseCron(' ' + long) === null && C.parseCron(range(0, 59).join(',') + ' * * * *') === null, 'over 120 characters is null, padding included, even when the fields are valid')

  const invalid = [
    '', '   ', '* * * *', '* * * * * *', '0 9 * * 1-5 extra', '@daily', '@reboot',
    '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 0 *', '* * * 13 *', '* * * * 8',
    '-1 * * * *', '+1 * * * *', '1.5 * * * *', '0x1 * * * *', '001 * * * *', '1e1 * * * *',
    '*/0 * * * *', '*/61 * * * *', '* */25 * * *', '* * * * */9', '5-1 * * * *', '* * * * fri-mon', '* * * * sat-sun',
    '1,,2 * * * *', '1, * * * *', ',1 * * * *', '1- * * * *', '-5 * * * *', '1-2-3 * * * *', '*/ * * * *', '*/5/2 * * * *', '/5 * * * *', '**/5 * * * *', '*-5 * * * *',
    'a * * * *', 'jan * * * *', '* jan * * *', '* * jan * *', '* * * foo *', '* * * * monday', '* * * january *', '* * * * jan', '* * * mon *', '* * * * mo',
    '? * * * *', '* * ? * *', '* * L * *', '* * 15W * *', '* * * * 1#2', '* * * * 5L', '* * * * 7/2',
  ]
  const accepted = invalid.filter((e) => C.parseCron(e) !== null)
  check(accepted.length === 0, 'invalid expressions are null: ' + accepted.join(' | '))
  check([null, undefined, 5, {}, ['* * * * *']].every((v) => C.parseCron(v) === null), 'a non-string is null')
}

function nextChecks() {
  // 2026-10-23 is a Friday.
  const fri10 = local(2026, 10, 23, 10, 0)
  check(new Date(fri10).getDay() === 5, 'fixture: 2026-10-23 is a Friday')
  check(C.nextCron('* * * * *', local(2026, 10, 23, 9, 0)) === local(2026, 10, 23, 9, 1) && C.nextCron('* * * * *', local(2026, 10, 23, 9, 0, 59) + 999) === local(2026, 10, 23, 9, 1), 'strictly after `from`, minute precision (seconds of `from` ignored)')
  check(C.nextCron('0 9 * * *', local(2026, 10, 23, 9, 0)) === local(2026, 10, 24, 9, 0) && C.nextCron('0 9 * * *', local(2026, 10, 23, 8, 59, 59)) === local(2026, 10, 23, 9, 0), 'a run exactly at `from` moves on; one second before still runs today')
  check(C.nextCron('30 * * * *', fri10) === local(2026, 10, 23, 10, 30) && C.nextCron('*/20 9-17 * * *', local(2026, 10, 23, 17, 41)) === local(2026, 10, 24, 9, 0), 'minute then hour then the next day')
  check(C.nextCron('0 9 * * 1-5', fri10) === local(2026, 10, 26, 9, 0) && C.nextCron('0 9 * * mon-fri', fri10) === local(2026, 10, 26, 9, 0), 'Mon-Fri 09:00 from Friday 10:00 runs Monday')
  check(C.nextCron('0 9 * * 7', fri10) === local(2026, 10, 25, 9, 0) && C.nextCron('0 9 * * 0', fri10) === C.nextCron('0 9 * * 7', fri10), '7 runs on Sunday like 0')
  check(C.nextCron('0 0 31 * *', local(2026, 4, 1)) === local(2026, 5, 31) && C.nextCron('0 0 31 * *', local(2026, 1, 31, 12)) === local(2026, 3, 31), 'the 31st skips months without one')
  check(C.nextCron('0 12 * feb *', local(2026, 3, 1)) === local(2027, 2, 1, 12, 0), 'a month already past this year runs next year')

  // Year rollover.
  check(C.nextCron('0 0 1 1 *', local(2026, 12, 31, 12, 0)) === local(2027, 1, 1) && C.nextCron('0 0 1 1 *', local(2026, 1, 1)) === local(2027, 1, 1), 'New Year runs once a year, strictly after')
  check(C.nextCron('* * * * *', local(2026, 12, 31, 23, 59, 30)) === local(2027, 1, 1, 0, 0) && C.nextCron('59 23 31 12 *', local(2026, 12, 31, 23, 59)) === local(2027, 12, 31, 23, 59), 'the last minute of the year rolls into the next one')

  // Vixie OR: both day fields restricted means either; a "*" field means both.
  const runs = C.nextRuns('0 9 1 * 1', fri10, 4).map(ymd)
  check(same(runs, ['2026-10-26 09:00', '2026-11-01 09:00', '2026-11-02 09:00', '2026-11-09 09:00']), '"0 9 1 * 1" runs on the 1st and on every Monday: ' + runs.join(', '))
  check(same(C.nextRuns('0 9 1 * mon', fri10, 4), C.nextRuns('0 9 1 * 1', fri10, 4)), 'the same rule with a weekday name')
  check(C.nextCron('0 9 1-31 * 1', fri10) === local(2026, 10, 24, 9, 0), 'a full day-of-month range written out is restricted: OR makes it every day')
  check(C.nextCron('0 9 */2 * 1', fri10) === local(2026, 11, 9, 9, 0), '"*/2" in day of month counts as "*": an odd day that is also a Monday (Nov 9)')
  check(C.nextCron('0 9 1 * *', fri10) === local(2026, 11, 1, 9, 0) && C.nextCron('0 9 * * 1', fri10) === local(2026, 10, 26, 9, 0), 'one restricted day field alone')
  check(C.nextCron('0 0 31 2 1', local(2026, 1, 1)) === local(2026, 2, 2), 'an impossible day of month with a weekday still runs on the weekday (OR)')

  // Leap day and the 4 year cap.
  check(C.nextCron('0 0 29 2 *', fri10) === local(2028, 2, 29), 'the leap day runs on 2028-02-29')
  check(C.nextCron('0 0 29 2 *', local(2028, 2, 29)) === local(2032, 2, 29), 'the next leap day is exactly 4 years later and still inside the cap')
  check(same(C.nextRuns('0 0 29 2 *', fri10, 3).map(ymd), ['2028-02-29 00:00', '2032-02-29 00:00', '2036-02-29 00:00']), 'nextRuns of the leap day')
  check(C.nextCron('0 0 29 2 *', local(2096, 3, 1)) === null, '2100 is not a leap year: 8 years out is past the cap')
  check(C.nextCron('0 0 31 2 *', fri10) === null && C.nextCron('0 0 30 2 *', fri10) === null && C.nextCron('0 0 31 4,6,9,11 *', fri10) === null, 'an impossible date parses but never runs (null at the cap)')
  check(C.parseCron('0 0 31 2 *') !== null && same(C.nextRuns('0 0 31 2 *', fri10, 3), []), 'impossible: valid syntax, no runs')
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) C.nextCron('0 0 31 2 *', fri10 + i * HOUR)
  check(Date.now() - t0 < 2000, 'field by field: 200 searches of an impossible date over 4 years stay fast')

  // Inputs.
  const spec = C.parseCron('15 10 * * 1')
  check(C.nextCron(spec, fri10) === C.nextCron('15 10 * * 1', fri10) && same(C.nextRuns(spec, fri10, 2), C.nextRuns('15 10 * * 1', fri10, 2)), 'a parsed spec and its string give the same runs')
  check(C.nextCron('bad', fri10) === null && C.nextCron('* * * * *', NaN) === null && C.nextCron('* * * * *', Infinity) === null, 'an invalid expression or `from` is null')

  // nextRuns.
  check(same(C.nextRuns('0 9 * * 1-5', fri10, 3).map(hm), ['1 09:00', '2 09:00', '3 09:00']), 'nextRuns: the next three weekday mornings')
  const many = C.nextRuns('*/15 * * * *', fri10, 10)
  check(many.length === 10 && many.every((t, i) => i === 0 || t - many[i - 1] === 15 * MIN) && many[0] === local(2026, 10, 23, 10, 15), 'nextRuns are strictly increasing, starting after `from`')
  check(same(C.nextRuns('* * * * *', fri10, 0), []) && same(C.nextRuns('* * * * *', fri10, -2), []) && same(C.nextRuns('* * * * *', fri10, NaN), []) && same(C.nextRuns('nope', fri10, 3), []), 'nextRuns: n of 0, negative or NaN, or an invalid expression give []')
}

function dstChecks() {
  check(new Date(2026, 2, 8, 2, 30).getHours() === 3, 'the test runs in a DST zone (America/New_York): 02:30 of 2026-03-08 does not exist')
  const first130 = local(2026, 11, 1, 1, 30)
  check(offset(first130) === 240 && offset(first130 + HOUR) === 300 && hm(first130 + HOUR) === '0 01:30', 'and 01:30 of 2026-11-01 happens twice (EDT then EST)')

  // Spring forward (2026-03-08, 02:00 -> 03:00): a gap time moves forward with the clock.
  const gap = C.nextCron('30 2 * * *', local(2026, 3, 8, 1, 0))
  check(hm(gap) === '0 03:30' && C.nextCron('30 2 * * *', gap) === local(2026, 3, 9, 2, 30), '02:30 inside the gap runs at 03:30, the next day at 02:30 again')
  check(C.nextCron('30 2 * * *', local(2026, 3, 8, 3, 10)) === gap, 'from 03:10, right after the jump, the shifted 02:30 is still ahead (03:30)')
  const two = C.nextRuns('0,30 2 * * *', local(2026, 3, 8, 1, 0), 4).map(hm)
  check(same(two, ['0 03:00', '0 03:30', '1 02:00', '1 02:30']), 'two gap times both run, each moved by the gap: ' + two.join(', '))
  const merged = C.nextRuns('0,30 2,3 * * *', local(2026, 3, 8, 1, 0), 3).map(hm)
  check(same(merged, ['0 03:00', '0 03:30', '1 02:00']), 'a gap time that lands on a real run runs once: ' + merged.join(', '))
  const q = C.nextRuns('*/15 * * * *', local(2026, 3, 8, 1, 40), 4)
  check(same(q.map(hm), ['0 01:45', '0 03:00', '0 03:15', '0 03:30']) && q[1] - q[0] === 15 * MIN, '*/15 across the gap: 01:45 then 03:00, 15 real minutes apart')

  // Fall back (2026-11-01, 02:00 -> 01:00): a repeated wall time runs once, the first one.
  const fb = C.nextCron('30 1 * * *', local(2026, 11, 1, 0, 0))
  check(fb === first130 && offset(fb) === 240 && C.nextCron('30 1 * * *', fb) === local(2026, 11, 2, 1, 30), '01:30 runs at the first 01:30 (EDT) and next on the 2nd')
  const half = C.nextRuns('*/30 * * * *', local(2026, 11, 1, 0, 45), 4)
  check(same(half.map(hm), ['0 01:00', '0 01:30', '0 02:00', '0 02:30']) && half[2] - half[1] === 90 * MIN && offset(half[2]) === 300, '*/30 skips the repeated hour: the first 01:30 then 02:00 EST, 90 real minutes later')
  const second140 = local(2026, 11, 1, 1, 40) + HOUR
  check(offset(second140) === 300 && hm(second140) === '0 01:40', 'fixture: 01:40 EST, the second pass')
  check(C.nextCron('*/15 * * * *', second140) === local(2026, 11, 1, 2, 0) && C.nextCron('50 1 * * *', second140) === local(2026, 11, 2, 1, 50), 'from the second pass, the first 01:45 or 01:50 is already behind: 02:00, and 01:50 tomorrow')
  // The `hourly` rule steps real hours; a cron hour field follows the wall clock.
  const hourly = S.nextDue({ time: '00:30', recurrence: { kind: 'hourly' } }, first130)
  check(hourly === first130 + HOUR && C.nextCron('30 * * * *', first130) === first130 + 2 * HOUR, 'unlike hourly (01:30 EST), "30 * * * *" goes from the first 01:30 to 02:30')

  // Same placement as a daily, weekday or weekly time of schedule.ts, `from` swept across both DST days.
  const times = ['00:00', '01:30', '01:59', '02:00', '02:30', '03:00', '09:00', '23:59']
  const rules = [
    [(m, h) => `${m} ${h} * * *`, { kind: 'daily' }],
    [(m, h) => `${m} ${h} * * 1-5`, { kind: 'weekdays' }],
    [(m, h) => `${m} ${h} * * sun,tue`, { kind: 'weekly', days: [0, 2] }],
  ]
  const mismatches = []
  let compared = 0
  for (const [a, b] of [[local(2026, 3, 7), local(2026, 3, 10)], [local(2026, 10, 31), local(2026, 11, 3)]]) {
    for (let from = a; from < b; from += 17 * MIN + 7_000) {
      for (const time of times) {
        const [h, m] = time.split(':').map(Number)
        for (const [expr, recurrence] of rules) {
          const cron = C.nextCron(expr(m, h), from)
          const due = S.nextDue({ time, recurrence }, from)
          compared++
          if (cron !== due) mismatches.push(`${expr(m, h)} from ${ymd(from)}: ${cron && ymd(cron)} vs ${ymd(due)}`)
        }
      }
    }
  }
  check(compared > 10_000 && mismatches.length === 0, `nextCron places a daily, Mon-Fri or weekly time like nextDue across DST (${compared} cases): ` + mismatches.slice(0, 3).join(' | '))
}

function intervalChecks() {
  const ok = (e, min) => C.cronMinIntervalOk(e, min)
  check(!ok('*/5 * * * *') && ok('0 * * * *') && !ok('0,10 9 * * *'), '"*/5" fails, "0 * * * *" passes, "0,10 9 * * *" fails (15 minutes)')
  check(ok('*/15 * * * *') && !ok('*/14 * * * *') && ok('0,15,30,45 * * * *') && ok('0 9 * * 1-5') && ok('0 0 29 2 *'), 'exactly 15 minutes passes')
  check(ok('0,10 9 * * *', 10) && !ok('0,10 9 * * *', 11) && ok('*/5 * * * *', 5), 'minMinutes moves the bar')
  check(!ok('0,50 * * * *') && !ok('0,55 8,9 * * *') && ok('55 8,9 * * *'), 'the last run of an hour against the first of the next one (10 and 5 minutes)')
  check(!ok('5,55 0,23 * * *') && ok('5,55 0,23 * * 1') && ok('5,55 0,23 * * 6,1') && !ok('5,55 0,23 * * 0,6'), 'the last run of a day against the first of the next day that runs (Sat and Sun are consecutive, Sat and Mon are not)')
  check(!ok('5,55 0,23 1,31 * *') && ok('5,55 0,23 1,31 1 *') && !ok('5,55 0,23 28,29 2 *') && ok('5,55 0,23 28 2 *'), 'consecutive days across a month end or a leap day')
  check(!ok('bad') && !ok('* * * *'), 'an invalid expression is not ok')
  check(ok(C.parseCron('0 */2 * * *')) && !ok(C.parseCron('*/10 * * * *')), 'a parsed spec works too')

  // Exact against sampled runs (January and February: no DST in New York).
  const exprs = ['*/5 * * * *', '*/15 * * * *', '0,10 9 * * *', '0 * * * *', '0,50 * * * *', '0,55 8,9 * * *', '5,55 0,23 * * *', '*/20 9-17 * * *', '30 */6 * * *', '0 9 * * 1-5', '15 10 * * 1', '0 0 1 * *', '0 12 * * sat,sun', '0 7,19 * * *', '0 0 1,31 * *']
  const off = []
  for (const expr of exprs) {
    const sample = C.nextRuns(expr, local(2026, 1, 5), 3000).filter((t) => t < local(2026, 3, 7))
    let gap = Infinity
    for (let i = 1; i < sample.length; i++) gap = Math.min(gap, (sample[i] - sample[i - 1]) / MIN)
    if (!(C.cronMinIntervalOk(expr, gap) && !C.cronMinIntervalOk(expr, gap + 1))) off.push(`${expr} (${gap})`)
  }
  check(off.length === 0, 'cronMinIntervalOk(expr, g) holds exactly at the smallest sampled gap g: ' + off.join(', '))
}

// A 30 minute DST (Lord Howe, 2026-10-04 02:00 -> 02:30): a real time right
// after the gap comes before a gap time that moved forward. Last: it changes the zone.
function shortGapChecks() {
  process.env.TZ = 'Australia/Lord_Howe'
  check(hm(local(2026, 10, 4, 2, 15)) === '0 02:45' && offset(local(2026, 10, 4, 1, 59)) === -630 && offset(local(2026, 10, 4, 2, 30)) === -660, 'Lord Howe skips 02:00-02:29 on 2026-10-04')
  const runs = C.nextRuns('15,30 2 * * *', local(2026, 10, 4, 1, 50), 4)
  check(same(runs.map(hm), ['0 02:30', '0 02:45', '1 02:15', '1 02:30']) && runs.every((t, i) => i === 0 || t > runs[i - 1]), 'the real 02:30 runs first, then 02:15 moved to 02:45: ' + runs.map(hm).join(', '))
  const due = S.nextDue({ time: '02:15', recurrence: { kind: 'daily' } }, local(2026, 10, 4, 2, 35))
  check(C.nextCron('15 2 * * *', local(2026, 10, 4, 2, 35)) === due && hm(due) === '0 02:45', 'from 02:35 the shifted 02:15 is still ahead, like nextDue')
  process.env.TZ = 'America/New_York'
}

parseChecks()
nextChecks()
dstChecks()
intervalChecks()
shortGapChecks()
console.log(`PASS: ${checks} cron checks (parseCron syntax, names, 7 as Sunday, invalid input, nextCron field by field, Vixie OR, leap day, 4 year cap, year rollover, DST gap and overlap like schedule.ts, nextRuns, min interval)`)
