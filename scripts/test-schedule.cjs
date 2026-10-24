// Recurring pane automations (E8-FR-28..32, R30-13): nextDue (weekdays from
// a Friday, weekly days, hourly, midnight, DST with a fixed TZ), the decide
// table (busy, precise action, title-only action, shell vs agent without
// state, grace, missed, max wait, paused), the history capped at 20,
// afterRun/withEnabled, and the renderer ticker end to end with a fake pty
// bridge: submit, wait clock, skipped_busy, agent_not_running, missed, the
// partial mount of an unvisited workspace, "Run now" and the pending timeout.
// App 2.7.0 (A10): the cron rule in nextDue (DST included), cronRuleError,
// schedule ids, and several schedules in one console run on their own (one
// prompt at a time per console, keyed paneId#scheduleId). The next-run label
// (formatRunWhen, desktop and phone): weekday and time within 6 calendar
// days, with day and month further away, plus the year in another year.
// Same esbuild + vm harness as test-status.cjs.
//
// The DST cases need a zone with DST: the TZ is fixed before any Date use.
process.env.TZ = 'America/New_York'
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
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const isDeep = (a, b) => { try { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); return true } catch { return false } }
const flush = () => new Promise((r) => setImmediate(r))
const MIN = 60_000, HOUR = 3_600_000
const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()
const hm = (ms) => { const d = new Date(ms); return `${d.getDay()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

const S = load('src/shared/schedule.ts')

function nextDueChecks() {
  check(new Date(2026, 2, 8, 2, 30).getHours() === 3, 'the test runs in a DST zone (America/New_York)')
  // 2026-10-16 is a Friday.
  const fri10 = local(2026, 10, 16, 10, 0)
  check(new Date(fri10).getDay() === 5, 'fixture: 2026-10-16 is a Friday')
  const wk = S.nextDue({ time: '09:00', recurrence: { kind: 'weekdays' } }, fri10)
  check(wk === local(2026, 10, 19, 9, 0) && hm(wk) === '1 09:00', 'Mon-Fri 09:00 set on a Friday at 10:00 runs Monday 09:00')
  check(S.nextDue({ time: '11:00', recurrence: { kind: 'weekdays' } }, fri10) === local(2026, 10, 16, 11, 0), 'Mon-Fri later the same Friday runs today')
  check(S.nextDue({ time: '09:00', recurrence: { kind: 'weekdays' } }, local(2026, 10, 17, 8, 0)) === local(2026, 10, 19, 9, 0), 'Mon-Fri from a Saturday runs Monday')
  const wed12 = local(2026, 10, 14, 12, 0)
  check(S.nextDue({ time: '09:00', recurrence: { kind: 'weekly', days: [2, 4] } }, wed12) === local(2026, 10, 15, 9, 0), 'weekly Tue/Thu from Wednesday noon runs Thursday')
  check(S.nextDue({ time: '13:00', recurrence: { kind: 'weekly', days: [3] } }, wed12) === local(2026, 10, 14, 13, 0), 'weekly on the same day later today runs today')
  check(S.nextDue({ time: '11:00', recurrence: { kind: 'weekly', days: [3] } }, wed12) === local(2026, 10, 21, 11, 0), 'weekly on the same day already past runs in 7 days')
  check(S.nextDue({ time: '09:00', recurrence: { kind: 'weekly', days: [0, 6] } }, fri10) === local(2026, 10, 17, 9, 0), 'weekly Sat/Sun from Friday runs Saturday')
  const h = (from) => S.nextDue({ time: '07:15', recurrence: { kind: 'hourly' } }, from)
  check(h(local(2026, 10, 16, 10, 20)) === local(2026, 10, 16, 11, 15) && h(local(2026, 10, 16, 10, 10)) === local(2026, 10, 16, 10, 15), 'hourly takes the minute from the time (:15) and ignores the hour')
  check(h(local(2026, 10, 16, 10, 15)) === local(2026, 10, 16, 11, 15), 'hourly exactly at the minute moves to the next hour (strictly after)')
  check(h(local(2026, 10, 16, 23, 50)) === local(2026, 10, 17, 0, 15), 'hourly crosses midnight')
  check(S.nextDue({ time: '00:30', recurrence: { kind: 'daily' } }, local(2026, 10, 16, 23, 50)) === local(2026, 10, 17, 0, 30), 'daily 00:30 at 23:50 runs after midnight')
  check(S.nextDue({ time: '23:00' }, local(2026, 10, 16, 23, 30)) === local(2026, 10, 17, 23, 0) && S.nextOccurrence('23:00', local(2026, 10, 16, 22, 0)) === local(2026, 10, 16, 23, 0), 'a one-shot (no recurrence) is today if ahead, else tomorrow; nextOccurrence is the same rule')
  check(S.nextDue({ time: '25:99' }, fri10) === fri10 + HOUR && S.nextDue({ time: 'x' }, fri10) === fri10 + HOUR, 'a malformed time falls back to one hour later')

  // DST spring forward (2026-03-08, 02:00 -> 03:00 in New York).
  const before = local(2026, 3, 7, 10, 0)
  const nine = S.nextDue({ time: '09:00', recurrence: { kind: 'daily' } }, before)
  check(hm(nine) === '0 09:00' && nine - local(2026, 3, 7, 9, 0) === 23 * HOUR, 'daily 09:00 across spring forward stays at 09:00 local (a 23 h day)')
  const gap = S.nextDue({ time: '02:30', recurrence: { kind: 'daily' } }, local(2026, 3, 8, 1, 0))
  check(hm(gap) === '0 03:30', 'a time inside the spring-forward gap moves forward with the clock (02:30 runs at 03:30)')
  const afterGap = S.nextDue({ time: '02:30', recurrence: { kind: 'daily' } }, gap)
  check(hm(afterGap) === '1 02:30', 'the next day it is 02:30 again')
  // DST fall back (2026-11-01, 02:00 -> 01:00): hourly steps are real hours.
  const h1 = S.nextDue({ time: '00:30', recurrence: { kind: 'hourly' } }, local(2026, 11, 1, 0, 45))
  const h2 = S.nextDue({ time: '00:30', recurrence: { kind: 'hourly' } }, h1)
  check(new Date(h1).getMinutes() === 30 && h2 - h1 === HOUR && new Date(h2).getMinutes() === 30, 'hourly across fall back keeps :30 one real hour apart')
  const fb = S.nextDue({ time: '09:00', recurrence: { kind: 'daily' } }, local(2026, 10, 31, 10, 0))
  check(hm(fb) === '0 09:00' && fb - local(2026, 10, 31, 9, 0) === 25 * HOUR, 'daily 09:00 across fall back stays at 09:00 local (a 25 h day)')
}

function typingBlockedChecks() {
  // The shared "never type over a menu" rule (global prompt, Quick Commands, snaos send, scheduler).
  const T = load('src/shared/agentTune.ts')
  check(T.typingBlocked({ state: 'action', precise: true }), 'a precise action (permission, question, plan) blocks typing')
  check(T.typingBlocked({ state: 'working', precise: true, pendingCount: 1 }) && T.typingBlocked({ state: 'idle', precise: true, pendingCount: 3 }), 'a precise open request blocks in any state')
  check(!T.typingBlocked({ state: 'action', precise: false }) && !T.typingBlocked({ state: 'action', precise: false, pendingCount: 1 }), 'a title-only action (SSH, WSL, cmd end of turn, pendingCount 1) never blocks')
  for (const state of ['idle', 'done', 'working', 'error', 'unknown']) check(!T.typingBlocked({ state, precise: true, pendingCount: 0 }), `precise ${state} without a request does not block`)
  check(!T.typingBlocked(null) && !T.typingBlocked(undefined) && !T.typingBlocked({ state: null, precise: true }) && !T.typingBlocked({ state: 'action' }), 'no status, a cleared state or an unknown precision does not block')
}

function decideChecks() {
  const now = local(2026, 10, 16, 9, 0, 5)
  const sched = (extra = {}) => ({ time: '09:00', prompt: 'segui', dueAt: local(2026, 10, 16, 9, 0), ...extra })
  const base = { now, agent: true, live: true, graceMin: 120, maxWaitMin: 30 }
  const d = (extra) => S.decide({ ...base, schedule: sched(), ...extra })
  check(d({ status: { state: 'working', precise: true } }) === 'wait', 'working waits')
  check(d({ status: { state: 'working', precise: false } }) === 'wait', 'working from the title waits too')
  check(d({ status: { state: 'action', precise: true } }) === 'wait', 'a precise action (real permission/question/plan) waits: nothing is typed over it')
  check(d({ status: { state: 'action', precise: false } }) === 'fire', 'an action without hooks (end of turn from the title) counts as free')
  for (const state of ['idle', 'done', 'error']) check(d({ status: { state, precise: true } }) === 'fire', `${state} is free`)
  check(d({ status: null }) === 'wait' && d({ status: { state: 'unknown', precise: false } }) === 'wait', 'an agent pane without state (or unknown) waits')
  check(d({ status: null, agent: false }) === 'fire' && d({ status: { state: 'unknown', precise: false }, agent: false }) === 'fire', 'a shell/custom pane without state is free')
  check(d({ status: { state: 'idle', precise: true }, live: false }) === 'wait', 'no live pty waits')
  check(S.decide({ ...base, schedule: sched({ waitIdle: false }), status: { state: 'working', precise: true } }) === 'fire', 'waitIdle off sends over a busy agent')
  check(S.decide({ ...base, schedule: sched({ waitIdle: false }), status: null }) === 'wait', 'waitIdle off still never types into the shell of an agent pane')
  check(S.decide({ ...base, schedule: sched({ waitIdle: false }), status: { state: 'action', precise: true } }) === 'wait', 'waitIdle off never answers a real permission or question (precise action)')
  check(S.decide({ ...base, trigger: 'manual', schedule: sched({ waitIdle: false }), status: { state: 'action', precise: true } }) === 'wait', 'run now with waitIdle off never answers a precise action either')
  // An open request (precise pendingCount > 0) blocks like a precise action, whatever the state.
  check(d({ status: { state: 'idle', precise: true, pendingCount: 1 } }) === 'wait' && S.decide({ ...base, schedule: sched({ waitIdle: false }), status: { state: 'working', precise: true, pendingCount: 2 } }) === 'wait', 'a precise open request waits, waitIdle on or off')
  check(d({ status: { state: 'action', precise: false, pendingCount: 1 } }) === 'fire' && d({ status: { state: 'idle', precise: true, pendingCount: 0 } }) === 'fire', "a title-only end of turn (its pendingCount 1) still fires; pendingCount 0 changes nothing")
  check(d({ now: local(2026, 10, 16, 8, 59), status: { state: 'idle', precise: true } }) === 'idle', 'not due: idle')
  check(S.decide({ ...base, schedule: sched({ enabled: false }), status: { state: 'idle', precise: true } }) === 'idle', 'enabled:false does nothing')
  // Grace (E8-FR-30).
  const at = (late, extra = {}) => S.decide({ ...base, now: sched().dueAt + late, schedule: sched(extra), status: { state: 'idle', precise: true } })
  check(at(60 * MIN) === 'fire', 'one hour late (app opened late) fires once')
  check(S.SCHEDULE_DUE_SLACK_MS === 2 * MIN, 'tick slack is 2 min')
  check(at(122 * MIN) === 'fire' && at(122 * MIN + 1) === 'missed', 'the grace bound (120 min plus the 2 min tick slack) is inclusive')
  check(at(5 * HOUR) === 'missed', 'five hours late is missed')
  const g0 = (late) => S.decide({ ...base, graceMin: 0, now: sched().dueAt + late, schedule: sched(), status: { state: 'idle', precise: true } })
  check(g0(2000) === 'fire' && g0(61_000) === 'fire', 'grace 0 still fires a run seen a tick (or a throttled minute) late')
  check(g0(2 * MIN + 1) === 'missed', 'grace 0 misses anything later than the tick slack')
  // Max wait.
  const wait = (since, now2, status, extra = {}) => S.decide({ ...base, now: now2, schedule: sched({ waitingSince: since, ...extra }), status, ...extra.input })
  const due = sched().dueAt
  check(wait(due, due + 29 * MIN, { state: 'working', precise: true }) === 'wait', 'busy for 29 min still waits')
  check(wait(due, due + 30 * MIN, { state: 'working', precise: true }) === 'skip_busy', 'busy for 30 min is skipped_busy')
  check(wait(due, due + 30 * MIN, null) === 'fail_no_agent', 'no agent state for 30 min fails (agent_not_running)')
  check(wait(due, due + 30 * MIN, { state: 'idle', precise: true }) === 'fire', 'freed right at the limit still fires')
  check(S.decide({ ...base, maxWaitMin: 240, now: due + 200 * MIN, schedule: sched({ waitingSince: due }), status: { state: 'idle', precise: true } }) === 'fire', 'a legit wait longer than the grace (max wait 240) still fires')
  check(wait(due, due + 6 * HOUR, { state: 'idle', precise: true }) === 'missed', 'a stale wait the app outlived (closed while waiting) is missed, not fired hours late')
  // Manual ("Run now").
  const m = (extra) => S.decide({ ...base, trigger: 'manual', schedule: sched({ enabled: false, dueAt: now + 5 * HOUR }), ...extra })
  check(m({ status: { state: 'idle', precise: true } }) === 'fire', 'run now fires even paused and before dueAt')
  check(m({ status: { state: 'working', precise: true } }) === 'wait', 'run now respects waitIdle')
  check(m({ status: { state: 'working', precise: true }, manualSince: now - 30 * MIN }) === 'skip_busy', 'run now has its own max wait clock')
  check(S.decide({ ...base, trigger: 'manual', now: due + 10 * HOUR, schedule: sched(), status: { state: 'idle', precise: true } }) === 'fire', 'run now is never missed')
}

function historyChecks() {
  const run = (at, extra = {}) => ({ at, scheduledFor: at, trigger: 'scheduled', status: 'sent', ...extra })
  let h
  for (let i = 1; i <= 20; i++) h = S.pushHistory(h, run(i))
  check(h.length === 20 && h[0].at === 1, '20 runs are kept')
  h = S.pushHistory(h, run(21))
  check(h.length === 20 && h[0].at === 2 && h[19].at === 21, 'the 21st drops the oldest')
  const mixed = S.pushHistory(Array.from({ length: 20 }, (_, i) => run(100 - i)), run(500))
  check(mixed.length === 20 && !mixed.some((r) => r.at === 81) && mixed[19].at === 500, 'the oldest by at goes, whatever the stored order')
  check(S.recentRuns([run(1), run(3), run(2)]).map((r) => r.at).join() === '3,2,1' && S.recentRuns(undefined).length === 0, 'recentRuns is newest first')

  const now = local(2026, 10, 16, 9, 0, 3)
  const once = { time: '09:00', prompt: 'p', dueAt: local(2026, 10, 16, 9, 0), waitingSince: now - 1000, history: [run(1)] }
  const a = S.afterRun(once, run(now, { scheduledFor: once.dueAt }), now)
  check(a.enabled === false && a.dueAt === once.dueAt && a.history.length === 2 && !('waitingSince' in a), 'a one-shot pauses after its run, keeps dueAt and the history, ends the wait')
  const daily = { ...once, recurrence: { kind: 'weekdays' } }
  const b = S.afterRun(daily, run(now, { scheduledFor: daily.dueAt }), now)
  check(b.enabled === undefined && b.dueAt === local(2026, 10, 19, 9, 0) && !('waitingSince' in b), 'a recurring run moves dueAt to the next occurrence (Friday -> Monday)')
  const c = S.afterRun(daily, run(now, { trigger: 'manual', scheduledFor: now }), now)
  check(c.dueAt === daily.dueAt && c.waitingSince === daily.waitingSince && c.history.length === 2, 'a manual run only appends history (dueAt untouched)')
  const edited = { ...daily, dueAt: local(2026, 10, 16, 18, 0) }
  check(S.afterRun(edited, run(now, { scheduledFor: daily.dueAt }), now).dueAt === edited.dueAt, 'a schedule edited while its run was in flight keeps the new time')
  const missed = S.afterRun({ ...daily, dueAt: now - 5 * HOUR }, run(now, { status: 'missed', scheduledFor: now - 5 * HOUR }), now)
  check(missed.dueAt > now && missed.history.filter((r) => r.status === 'missed').length === 1, 'a missed run logs once and jumps to the next occurrence')

  const paused = S.withEnabled({ ...daily, waitingSince: 5 }, false, now)
  check(paused.enabled === false && !('waitingSince' in paused) && paused.dueAt === daily.dueAt, 'pausing keeps the schedule and drops the wait')
  const resumed = S.withEnabled({ ...a }, true, now)
  check(resumed.enabled === true && resumed.dueAt > now && resumed.history.length === 2, 'resuming a fired one-shot re-arms it at its next occurrence')
  const future = { ...daily, dueAt: now + HOUR, enabled: false }
  check(S.withEnabled(future, true, now).dueAt === future.dueAt, 'resuming before the time keeps dueAt')
  check(S.validWeeklyDays([1, 3]) && !S.validWeeklyDays([]) && !S.validWeeklyDays([1, 1]) && !S.validWeeklyDays([7]), 'weekly days validation matches the schema')

  // What afterRun writes survives the config schema.
  const { parseConfig } = load('src/main/store/schema.ts', { console: { ...console, warn() {} } })
  let hist
  for (let i = 0; i < 25; i++) hist = S.pushHistory(hist, run(1000 + i, i % 3 === 0 ? { status: 'failed', reason: 'agent_not_running' } : {}))
  const written = { ...S.afterRun({ ...daily, history: hist }, run(now, { scheduledFor: daily.dueAt }), now) }
  const cfg = parseConfig({ version: 13, workspaces: [{ id: 'w', name: 'W', cwd: '', panes: [{ id: 'p', type: 'claude', title: 'C', color: '#fff', icon: 'claude', schedule: written }] }], presets: [], settings: { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false } })
  check(isDeep(cfg.workspaces[0].panes[0].schedules, [{ id: 's1', ...written }]) && !('schedule' in cfg.workspaces[0].panes[0]), 'a schedule written by afterRun round-trips through the v13 schema (schema 19: as schedules[0], id s1)')
  const v19 = parseConfig({ ...cfg, workspaces: [{ ...cfg.workspaces[0], panes: [{ ...cfg.workspaces[0].panes[0], schedules: [{ id: 's1', ...written }, { id: 's2', ...written, recurrence: { kind: 'cron', expr: '0 9 * * 1-5' } }] }] }] })
  check(isDeep(v19.workspaces[0].panes[0].schedules[1], { id: 's2', ...written, recurrence: { kind: 'cron', expr: '0 9 * * 1-5' } }), 'a cron schedule written by afterRun round-trips through the schema 19 schedules')
}

// App 2.7.0 (A10): the cron rule in nextDue (delegates to nextCron, before
// parseTime), the storable-cron test shared by the schema and the dialog, and
// the per-console schedule ids.
function cronChecks() {
  const fri10 = local(2026, 10, 16, 10, 0)
  const cron = (expr, from, time = '09:00') => S.nextDue({ time, recurrence: { kind: 'cron', expr } }, from)
  check(cron('0 9 * * 1-5', fri10) === local(2026, 10, 19, 9, 0), 'cron "0 9 * * 1-5" on a Friday at 10:00 runs Monday 09:00')
  check(cron('30 10 * * *', fri10) === local(2026, 10, 16, 10, 30) && cron('0 10 * * *', fri10) === local(2026, 10, 17, 10, 0), 'cron is strictly after from: later today, or tomorrow at the same minute')
  check(cron('0 9 * * 1-5', fri10, 'x') === local(2026, 10, 19, 9, 0) && cron('0 9 * * 1-5', fri10, '23:59') === local(2026, 10, 19, 9, 0), "a cron schedule's time is not part of its rule (a malformed one does not fall back to +1 h)")
  check(cron('0 0 31 2 *', fri10) === S.SCHEDULE_NEVER && cron('basura', fri10) === S.SCHEDULE_NEVER, 'a rule with no next run (or that does not parse) never comes due, it never fires every hour')
  // DST in America/New_York: 2026-03-08 02:00 -> 03:00 and 2026-11-01 02:00 -> 01:00.
  const gap = cron('30 2 * * *', local(2026, 3, 8, 1, 0))
  check(hm(gap) === '0 03:30', 'cron: a time inside the spring-forward gap moves forward with the clock (02:30 runs at 03:30), like a daily time')
  check(hm(cron('30 2 * * *', gap)) === '1 02:30', 'cron: the next day it is 02:30 again')
  const nine = cron('0 9 * * *', local(2026, 3, 7, 10, 0))
  check(hm(nine) === '0 09:00' && nine - local(2026, 3, 7, 9, 0) === 23 * HOUR, 'cron 09:00 across spring forward stays at 09:00 local (a 23 h day)')
  const fb1 = cron('30 1 * * *', local(2026, 11, 1, 0, 0))
  const fb2 = cron('30 1 * * *', fb1)
  check(new Date(fb1).getHours() === 1 && fb2 - fb1 > 23 * HOUR && new Date(fb2).getDate() === 2, 'cron: a repeated fall-back hour runs once (the first 01:30), the next run is the next day')
  check(cron('0 9 * * *', local(2026, 10, 31, 10, 0)) - local(2026, 10, 31, 9, 0) === 25 * HOUR, 'cron 09:00 across fall back stays at 09:00 local (a 25 h day)')
  // afterRun / withEnabled re-arm a cron schedule through nextDue.
  const daily = { id: 's2', time: '', prompt: 'p', dueAt: local(2026, 10, 16, 9, 0), recurrence: { kind: 'cron', expr: '0 9 * * 1-5' } }
  const after = S.afterRun(daily, { at: fri10, scheduledFor: daily.dueAt, trigger: 'scheduled', status: 'sent' }, fri10)
  check(after.dueAt === local(2026, 10, 19, 9, 0) && after.enabled === undefined && after.id === 's2', 'a cron run moves dueAt to the next run and keeps the schedule active and its id')
  check(S.withEnabled({ ...daily, enabled: false }, true, fri10).dueAt === local(2026, 10, 19, 9, 0), 'resuming a past cron schedule re-arms it at its next run')
  // cronRuleError: what the schema stores and the dialog accepts.
  check(S.cronRuleError('0 9 * * 1-5', fri10) === null && S.cronRuleError('*/15 * * * *', fri10) === null && S.cronRuleError('0 0 29 2 *', fri10) === null, 'storable: weekdays 09:00, every 15 minutes, a leap day')
  check(S.cronRuleError('0 9 * *', fri10) === 'invalid' && S.cronRuleError('61 9 * * *', fri10) === 'invalid' && S.cronRuleError('', fri10) === 'invalid', 'invalid: a missing field, a value out of range, empty')
  check(S.cronRuleError('*/5 * * * *', fri10) === 'interval' && S.cronRuleError('0,10 9 * * *', fri10) === 'interval', 'interval: runs less than 15 minutes apart')
  check(S.cronRuleError('0 0 31 2 *', fri10) === 'never' && S.cronRuleError('0 0 30 2 *', fri10) === 'never', 'never: an impossible date')
  // Ids within a console.
  check(S.PANE_SCHEDULES_MAX === 8 && S.SCHEDULE_ID_RE.test('s1') && S.SCHEDULE_ID_RE.test('s999') && !S.SCHEDULE_ID_RE.test('s1000') && !S.SCHEDULE_ID_RE.test('x1') && !S.SCHEDULE_ID_RE.test('s'), 'ids are s1..s999, 8 per console')
  check(S.nextScheduleId(undefined) === 's1' && S.nextScheduleId([{ id: 's1' }, { id: 's3' }]) === 's2' && S.nextScheduleId(Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 10}` }))) === null, 'the next id is the lowest free one; none once the console holds 8')
  check(S.scheduleKey('pane-1', 's2') === 'pane-1#s2' && S.paneSchedules({}).length === 0, 'runtime key paneId#scheduleId; a pane without schedules has none')
}

async function tickerChecks() {
  const submits = []
  let submitResult = { ok: true }
  const notifications = []
  const snApi = {
    platform: 'win32',
    config: { save() {} },
    pty: { submit: async (req) => { submits.push(req); return submitResult }, onPromptResult: () => () => {}, killPanes: async () => 0 },
  }
  class FakeNotification { constructor(title, opts) { notifications.push({ title, body: opts.body }) } }
  const r = loadRenderer(`
    export { useAppStore } from './store'
    export { registerPty, unregisterPty } from './ptyRegistry'
    export { schedulerTick, runScheduleNow, cancelScheduleRun, setScheduleEnabled, handleSchedulePromptResult, useScheduleRuntime, isManualRunPending, isAgentKind, PENDING_DELIVERY_TIMEOUT_MS, SCHEDULE_SETTLE_MS } from './usePaneScheduler'
    export { scheduleNextLabel, recurrenceLabel, formatWhen, weekdayName } from './scheduleFormat'
    export { translate } from '@/i18n'
  `, { window: { snApi }, Notification: FakeNotification, document: { hasFocus: () => true } })
  const A = r.useAppStore
  const preset = { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }
  const pane = (id, type, extra = {}) => ({ id, type, title: `T-${id}`, color: '#fff', icon: type, ...extra })
  A.getState().hydrate({
    version: 13,
    workspaces: [
      { id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [pane('p1', 'shell'), pane('p2', 'custom', { presetId: 'preset-claude' })] },
      { id: 'w2', name: 'Dos', cwd: 'C:/b', panes: [pane('q1', 'claude', { presetId: 'preset-claude' }), pane('q2', 'shell'), pane('q3', 'shell'), pane('q4', 'claude')] },
    ],
    presets: [preset],
    settings: { ...A.getState().settings, language: 'es', restoreLastWorkspace: true },
    activeWorkspaceId: 'w1',
  })
  const st = () => A.getState()
  const schedOf = (id, sid = 's1') => (st().workspaces.flatMap((w) => w.panes).find((p) => p.id === id).schedules || []).find((s) => s.id === sid)
  const wsOf = (id) => st().workspaces.find((w) => w.panes.some((p) => p.id === id)).id
  const setSched = (id, s, sid = 's1') => st().setPaneSchedule(wsOf(id), id, sid, s)
  const status = (id, state, precise = true) => A.setState((s) => ({ paneStatus: { ...s.paneStatus, [id]: state ? { state, precise } : undefined } }))
  const lastRun = (id, sid = 's1') => { const h = schedOf(id, sid).history || []; return h[h.length - 1] }
  check(r.isAgentKind({ type: 'custom', presetId: 'preset-claude' }, [preset]) && !r.isAgentKind({ type: 'shell' }, [preset]) && r.isAgentKind({ type: 'codex' }, []), 'agent kind by type or preset')
  check(st().mountedWorkspaces.w1 === 'full' && st().mountedWorkspaces.w2 === undefined, 'fixture: only the active workspace is mounted')

  // Shell pane, live pty, daily: sends with Enter and moves to tomorrow.
  r.registerPty('p1', 'pty-p1')
  let now = Date.now()
  setSched('p1', { time: '09:00', prompt: 'npm test', dueAt: now + 60_000, recurrence: { kind: 'daily' } })
  r.schedulerTick(now)
  check(submits.length === 0, 'not due yet: nothing sent')
  setSched('p1', { ...schedOf('p1'), dueAt: now - 500 })
  r.schedulerTick(now)
  check(submits.length === 1 && submits[0].ptyId === 'pty-p1' && submits[0].paneId === 'p1' && submits[0].text === 'npm test' && submits[0].enter === true, 'due: the prompt goes through pty.submit with Enter')
  check(submits[0].origin === 'auto', 'v2.3: a scheduled prompt goes as origin auto (it never acknowledges a done)')
  check(submits[0].userGate === true, 'post 2.6.0: a scheduled prompt asks main to re-check typingBlocked (userGate) before the text and before the deferred Enter')
  r.schedulerTick(now)
  check(submits.length === 1, 'a run in flight is never sent twice')
  await flush()
  check(lastRun('p1').status === 'sent' && lastRun('p1').trigger === 'scheduled' && lastRun('p1').scheduledFor === now - 500, 'the run is logged as sent for its occurrence')
  check(schedOf('p1').dueAt > Date.now() && schedOf('p1').enabled === undefined, 'a daily schedule moves to its next occurrence and stays active')
  check(notifications.length === 0, 'no desktop notification unless scheduleNotify is on')

  // Agent pane (custom type, claude preset): busy -> wait -> title action -> fire.
  r.registerPty('p2', 'pty-p2')
  submits.length = 0
  now = Date.now()
  setSched('p2', { time: '10:00', prompt: 'segui con el plan', dueAt: now - 1000 })
  status('p2', 'working')
  r.schedulerTick(now)
  check(submits.length === 0 && schedOf('p2').waitingSince === now, 'working: waits and persists the wait start')
  status('p2', 'action', true)
  r.schedulerTick(now + 1000)
  check(submits.length === 0 && schedOf('p2').waitingSince === now, 'a precise action (permission) is never typed over; the wait clock keeps its start')
  status('p2', 'action', false)
  r.schedulerTick(now + 2000)
  check(submits.length === 1 && submits[0].text === 'segui con el plan', 'an end of turn read from the title (imprecise action) fires')
  await flush()
  check(lastRun('p2').status === 'sent' && schedOf('p2').enabled === false && !('waitingSince' in schedOf('p2')), 'a one-shot pauses after it fired and its wait ends')

  // Agent exited (no state) -> agent_not_running after max wait.
  // p1's daily 09:00 would fire inside the 30 min jump when the suite runs
  // between 08:30 and 09:00 (New York): pause it so the check is clock-free.
  setSched('p1', { ...schedOf('p1'), enabled: false })
  submits.length = 0
  now = Date.now()
  setSched('p2', { time: '10:00', prompt: 'p', dueAt: now - 1000 })
  status('p2', null)
  r.schedulerTick(now)
  r.schedulerTick(now + 29 * MIN)
  check(submits.length === 0 && schedOf('p2').waitingSince === now, 'an agent pane whose agent exited waits (the text would run in the shell)')
  r.schedulerTick(now + 30 * MIN)
  check(submits.length === 0 && lastRun('p2').status === 'failed' && lastRun('p2').reason === 'agent_not_running', 'after 30 min without an agent: failed with agent_not_running')

  // App 2.7.0 (A3): a bare status (only a `snaos needs`, no agent track: state idle, approximate) is no agent state.
  now = Date.now()
  setSched('p2', { time: '10:00', prompt: 'p', dueAt: now - 1000 })
  A.setState((s) => ({ paneStatus: { ...s.paneStatus, p2: { state: 'idle', precise: false, bare: true, attention: true, pendingCount: 0, stateSince: now, updatedAt: now, needs: { text: 'review the diff', at: now } } } }))
  r.schedulerTick(now)
  check(submits.length === 0 && schedOf('p2').waitingSince === now, 'a bare needs status on an agent pane is no agent state: the run waits, nothing is typed with Enter')
  r.schedulerTick(now + 30 * MIN)
  check(submits.length === 0 && lastRun('p2').status === 'failed' && lastRun('p2').reason === 'agent_not_running', 'and fails with agent_not_running after the max wait, like no status at all')
  status('p2', null)

  // Busy past the max wait -> skipped_busy, hourly moves on.
  now = Date.now()
  setSched('p2', { time: '00:05', prompt: 'p', dueAt: now - 1000, recurrence: { kind: 'hourly' } })
  status('p2', 'working')
  r.schedulerTick(now)
  r.schedulerTick(now + 30 * MIN)
  check(lastRun('p2').status === 'skipped_busy' && schedOf('p2').dueAt > now && !('waitingSince' in schedOf('p2')), 'busy for 30 min: skipped_busy and the hourly schedule moves to its next run')

  // Missed: 5 h late logs once and jumps; 1 h late fires.
  submits.length = 0
  now = Date.now()
  setSched('p1', { time: '09:00', prompt: 'tarde', dueAt: now - 5 * HOUR, recurrence: { kind: 'daily' } })
  r.schedulerTick(now)
  r.schedulerTick(now + 1000)
  check(submits.length === 0 && schedOf('p1').history.filter((h) => h.status === 'missed').length === 1 && schedOf('p1').dueAt > now, 'five hours late: one missed entry, no burst, next occurrence scheduled')
  setSched('p1', { ...schedOf('p1'), dueAt: now - HOUR })
  r.schedulerTick(now)
  check(submits.length === 1 && submits[0].text === 'tarde', 'one hour late (within the 120 min grace) fires once')
  await flush()

  // Paused: never fires.
  submits.length = 0
  setSched('p1', { time: '09:00', prompt: 'x', dueAt: Date.now() - 1000, enabled: false })
  r.schedulerTick(Date.now())
  check(submits.length === 0 && !(schedOf('p1').history || []).length, 'a paused schedule does nothing')

  // Run now: paused one-shot, edited text, dueAt untouched.
  const pausedDue = schedOf('p1').dueAt
  check(r.runScheduleNow('p1', 's1', '  probar esto  ') === true, 'run now accepts a scheduled pane')
  check(submits.length === 1 && submits[0].text === 'probar esto', 'run now sends the dialog text right away to a free pane')
  await flush()
  check(lastRun('p1').trigger === 'manual' && lastRun('p1').status === 'sent' && schedOf('p1').dueAt === pausedDue && schedOf('p1').enabled === false, 'run now logs a manual run and never moves dueAt or the switch')
  check(!r.isManualRunPending(r.useScheduleRuntime.getState(), 'p1', 's1'), 'the manual request is done')
  // Run now on a busy agent waits ("Waiting..."), then fires once free.
  submits.length = 0
  setSched('p2', { time: '10:00', prompt: 'guardado', dueAt: Date.now() + 5 * HOUR })
  status('p2', 'working')
  r.runScheduleNow('p2', 's1')
  check(submits.length === 0 && r.isManualRunPending(r.useScheduleRuntime.getState(), 'p2', 's1'), 'run now respects "wait for the agent to be free"')
  status('p2', 'idle')
  r.schedulerTick(Date.now())
  check(submits.length === 1 && submits[0].text === 'guardado', 'once free it sends the saved prompt')
  await flush()
  check(lastRun('p2').trigger === 'manual' && schedOf('p2').dueAt > Date.now() + 4 * HOUR && !r.isManualRunPending(r.useScheduleRuntime.getState(), 'p2', 's1'), 'and the scheduled run stays where it was')
  status('p2', 'working')
  r.runScheduleNow('p2', 's1')
  r.cancelScheduleRun('p2', 's1')
  status('p2', 'idle')
  submits.length = 0
  r.schedulerTick(Date.now())
  check(submits.length === 0, 'a cancelled run now sends nothing')
  check(r.runScheduleNow('q3', 's1') === false, 'run now on a pane without a schedule is refused')

  // A run now waiting on a busy agent while the scheduled occurrence comes due:
  // the occurrence starts its own wait clock and is served afterwards, not missed.
  submits.length = 0
  now = Date.now()
  st().updateSettings({ automation: { ...st().settings.automation, scheduleGraceMin: 5 } })
  setSched('p2', { time: '10:00', prompt: 'programado', dueAt: now + 60_000, recurrence: { kind: 'daily' } })
  status('p2', 'working')
  r.runScheduleNow('p2', 's1', 'manual')
  r.schedulerTick(now + 61_000)
  check(schedOf('p2').waitingSince === now + 61_000 && submits.length === 0, 'the due occurrence starts waiting while run now holds the pane')
  status('p2', 'idle')
  r.schedulerTick(now + 20 * MIN)
  check(submits.length === 1 && submits[0].text === 'manual', 'run now goes first once free')
  await flush()
  r.schedulerTick(now + 20 * MIN + 1000)
  check(submits.length === 2 && submits[1].text === 'programado', 'then the held occurrence fires instead of being missed (grace 5 min, 19 min late)')
  await flush()
  check(lastRun('p2').status === 'sent' && lastRun('p2').trigger === 'scheduled' && !('waitingSince' in schedOf('p2')), 'the occurrence is logged as sent and its wait ends')
  st().updateSettings({ automation: { ...st().settings.automation, scheduleGraceMin: 120 } })

  // multiline_unsafe.
  submits.length = 0
  submitResult = { ok: false, error: 'multiline_unsafe' }
  setSched('p1', { time: '09:00', prompt: 'a\nb', dueAt: Date.now() - 1000 })
  r.schedulerTick(Date.now())
  await flush()
  check(lastRun('p1').status === 'failed' && lastRun('p1').reason === 'multiline_unsafe', 'multi-line text to a console without bracketed paste: failed multiline_unsafe')

  // userGate outcomes: main saw a menu the renderer's status had not caught up with yet.
  submits.length = 0
  submitResult = { ok: false, error: 'awaiting_user' }
  setSched('p1', { time: '09:00', prompt: 'segui', dueAt: Date.now() - 1000, recurrence: { kind: 'daily' } })
  r.schedulerTick(Date.now())
  await flush()
  check(submits.length === 1 && submits[0].userGate === true, 'fixture: the run went to main with userGate')
  check(lastRun('p1').status === 'skipped_busy' && !('reason' in lastRun('p1')) && schedOf('p1').dueAt > Date.now() && !r.useScheduleRuntime.getState().inflight['p1#s1'], 'awaiting_user (nothing typed): skipped_busy, the daily schedule moves on and the run ends')
  submitResult = { ok: false, error: 'enter_held' }
  setSched('p1', { ...schedOf('p1'), dueAt: Date.now() - 1000 })
  r.schedulerTick(Date.now())
  await flush()
  check(lastRun('p1').status === 'failed' && lastRun('p1').reason === 'enter_held', 'enter_held (text typed, Enter dropped): failed with reason enter_held')
  check(r.translate('es', 'schedule.reason.enter_held').includes('sin enviar') && r.translate('en', 'schedule.reason.enter_held').includes('not sent'), 'the enter_held reason has es and en labels')
  // "Run now" (desktop dialog and the phone's scheduleRun ctl) goes through the same gated submit.
  submits.length = 0
  submitResult = { ok: false, error: 'awaiting_user' }
  r.runScheduleNow('p1', 's1', 'ahora')
  await flush()
  check(submits.length === 1 && submits[0].text === 'ahora' && submits[0].userGate === true && submits[0].enter === true, 'run now submits with userGate too')
  check(lastRun('p1').trigger === 'manual' && lastRun('p1').status === 'skipped_busy' && !r.isManualRunPending(r.useScheduleRuntime.getState(), 'p1', 's1'), 'a run now refused by main is logged skipped_busy and no longer pending')
  submitResult = { ok: true }

  // Partial mount (E8-FR-30): an unvisited 4-console workspace starts only the due console.
  now = Date.now()
  setSched('q1', { time: '09:00', prompt: 'revisa el diff', dueAt: now - 1000, recurrence: { kind: 'daily' } })
  submits.length = 0
  r.schedulerTick(now)
  check(st().activeWorkspaceId === 'w1', 'the workspace is not activated')
  check(JSON.stringify(st().mountedWorkspaces.w2) === JSON.stringify(['q1']), 'only the due console mounts; the other three keep the placeholder')
  const pend = st().pendingPrompts.q1
  check(pend && pend.text === 'revisa el diff' && pend.enter === true && pend.source === 'schedule', 'the agent console gets the prompt as its initial prompt (argv or the precise-ready gate)')
  check(submits.length === 0 && r.useScheduleRuntime.getState().inflight['q1#s1'].via === 'pending', 'nothing is typed before the agent is ready')
  r.schedulerTick(now + 1000)
  check(st().pendingPrompts.q1 === pend, 'the prompt is handed once')
  r.handleSchedulePromptResult({ paneId: 'q1', result: 'sent_argv' }, now + 5000)
  check(lastRun('q1').status === 'sent' && schedOf('q1').dueAt > now && !r.useScheduleRuntime.getState().inflight['q1#s1'], 'the spawn outcome logs the run as sent')
  r.handleSchedulePromptResult({ paneId: 'q1', result: 'not_delivered' }, now + 6000)
  check(schedOf('q1').history.length === 1, 'an outcome for a run that is not pending is ignored')
  // Gate timeout without a precise signal: inserted without Enter.
  setSched('q1', { ...schedOf('q1'), dueAt: now - 1000 })
  st().takePendingPrompt('q1')
  // q1 counts as mounted now (partial list): a pane mounted without a pty waits for it instead.
  A.setState((s) => ({ mountedWorkspaces: { ...s.mountedWorkspaces, w2: undefined } }))
  r.schedulerTick(now)
  r.handleSchedulePromptResult({ paneId: 'q1', result: 'inserted_unconfirmed' }, now + 20_000)
  check(lastRun('q1').status === 'sent_unconfirmed', 'inserted without Enter is sent_unconfirmed')
  // The spawn never came: the pending prompt is withdrawn and logged.
  setSched('q1', { ...schedOf('q1'), dueAt: now - 1000 })
  st().takePendingPrompt('q1')
  A.setState((s) => ({ mountedWorkspaces: { ...s.mountedWorkspaces, w2: undefined } }))
  r.schedulerTick(now)
  check(st().pendingPrompts.q1 && r.useScheduleRuntime.getState().inflight['q1#s1'], 'handed to a spawn again')
  r.schedulerTick(now + r.PENDING_DELIVERY_TIMEOUT_MS + 1)
  check(lastRun('q1').status === 'failed' && lastRun('q1').reason === 'not_delivered' && !st().pendingPrompts.q1, 'no spawn outcome in time: failed not_delivered and the pending prompt is withdrawn')
  // A shell console in the unvisited workspace mounts alone and is written once its pty exists.
  A.setState((s) => ({ mountedWorkspaces: { ...s.mountedWorkspaces, w2: ['q1'] } }))
  submits.length = 0
  now = Date.now()
  setSched('q2', { time: '09:00', prompt: 'git pull', dueAt: now - 1000 })
  r.schedulerTick(now)
  check(JSON.stringify(st().mountedWorkspaces.w2) === JSON.stringify(['q1', 'q2']) && submits.length === 0 && !st().pendingPrompts.q2, 'a shell console mounts alone and waits for its pty (no initial prompt)')
  r.registerPty('q2', 'pty-q2')
  r.schedulerTick(now + 1000)
  check(submits.length === 1 && submits[0].ptyId === 'pty-q2' && submits[0].text === 'git pull', 'once its pty exists the prompt is submitted')
  await flush()
  check(st().mountedWorkspaces.w2.length === 2, 'q3 and q4 never started')

  // Active switch: resuming a fired one-shot re-arms it.
  const fired = schedOf('q2')
  check(fired.enabled === false, 'fixture: the one-shot fired')
  r.setScheduleEnabled('q2', 's1', true)
  check(schedOf('q2').enabled === true && schedOf('q2').dueAt > Date.now(), 'switching it back on schedules the next occurrence')
  r.setScheduleEnabled('q2', 's1', false)
  check(schedOf('q2').enabled === false && schedOf('q2').history.length === 1, 'pausing keeps the history')

  // Desktop notification per run (opt-in).
  st().updateSettings({ automation: { ...st().settings.automation, scheduleNotify: true } })
  setSched('p1', { time: '09:00', prompt: 'n', dueAt: Date.now() - 1000 })
  r.schedulerTick(Date.now())
  await flush()
  check(notifications.length === 1 && notifications[0].title === 'Automatización: T-p1' && notifications[0].body === 'Enviado', 'scheduleNotify shows one desktop notification per run')
  st().updateSettings({ automation: { ...st().settings.automation, scheduleNotify: false } })

  // App 2.7.0 (A10): several schedules in one console, each run on its own.
  const listOf = (id) => st().workspaces.flatMap((w) => w.panes).find((p) => p.id === id).schedules
  const setList = (id, list) => st().setPaneSchedules(wsOf(id), id, list)
  submits.length = 0
  now = Date.now()
  setList('p2', [
    { id: 's1', time: '09:00', prompt: 'uno', dueAt: now - 1000, recurrence: { kind: 'daily' } },
    { id: 's2', time: '09:00', prompt: 'dos', dueAt: now - 1000, recurrence: { kind: 'daily' } },
  ])
  status('p2', 'idle')
  r.schedulerTick(now)
  check(submits.length === 1 && submits[0].text === 'uno' && submits[0].paneId === 'p2', 'two schedules due at once: one prompt at a time per console, in stored order')
  check(schedOf('p2', 's2').waitingSince === now && r.useScheduleRuntime.getState().inflight['p2#s1'] && !r.useScheduleRuntime.getState().inflight['p2#s2'], 'the other one is held: it starts its own wait clock (runtime keyed paneId#scheduleId)')
  await flush()
  check(lastRun('p2', 's1').status === 'sent' && schedOf('p2', 's1').dueAt > now && schedOf('p2', 's1').history.length === 1 && !(schedOf('p2', 's2').history || []).length, 'the run is logged on its own schedule only')
  r.schedulerTick(now + 1000)
  check(submits.length === 1, 'the other schedule holds while the agent status catches up with the prompt that just went in (settle)')
  status('p2', 'working')
  r.schedulerTick(now + r.SCHEDULE_SETTLE_MS + 1000)
  check(submits.length === 1 && schedOf('p2', 's2').waitingSince === now, 'then it follows its own rule: the agent is working, it waits (no Enter is ever added)')
  status('p2', 'idle')
  r.schedulerTick(now + r.SCHEDULE_SETTLE_MS + 2000)
  check(submits.length === 2 && submits[1].text === 'dos' && submits[1].enter === true && submits[1].userGate === true, 'once free the second schedule sends its own prompt through the same gated submit')
  await flush()
  check(lastRun('p2', 's2').status === 'sent' && !('waitingSince' in schedOf('p2', 's2')) && schedOf('p2', 's1').history.length === 1, 'each schedule keeps its own history and wait clock')
  // Run now, pause and delete act on one schedule.
  submits.length = 0
  setList('p2', listOf('p2').map((s) => ({ ...s, dueAt: Date.now() + 5 * HOUR })))
  check(r.runScheduleNow('p2', 's2') === true && submits.length === 1 && submits[0].text === 'dos', 'run now of the second schedule sends its saved prompt')
  check(r.isManualRunPending(r.useScheduleRuntime.getState(), 'p2', 's2') && !r.isManualRunPending(r.useScheduleRuntime.getState(), 'p2', 's1'), 'only that schedule shows its run now as pending')
  await flush()
  check(lastRun('p2', 's2').trigger === 'manual' && schedOf('p2', 's1').history.length === 1, 'the manual run is logged on that schedule only')
  check(r.runScheduleNow('p2', 's9') === false, 'run now of an unknown schedule id is refused')
  r.setScheduleEnabled('p2', 's1', false)
  check(schedOf('p2', 's1').enabled === false && schedOf('p2', 's2').enabled === undefined, 'pausing one schedule leaves the other active')
  setSched('p2', null, 's1')
  check(listOf('p2').map((s) => s.id).join() === 's2', 'deleting one schedule keeps the rest')
  setSched('p2', null, 's2')
  check(!('schedules' in st().workspaces[0].panes.find((p) => p.id === 'p2')), 'deleting the last one drops the schedules field')
  // The store setters keep the schema's bounds.
  setList('p2', [...Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, time: '09:00', prompt: `n${i}`, dueAt: Date.now() + HOUR })), { id: 's1', time: '09:00', prompt: 'dup', dueAt: 1 }])
  check(listOf('p2').length === 8 && listOf('p2')[0].prompt === 'n0', 'setPaneSchedules keeps 8, the first of a repeated id')
  setSched('p2', { time: '09:00', prompt: 'nueve', dueAt: 1 }, 's20')
  check(listOf('p2').length === 8 && !listOf('p2').some((s) => s.id === 's20'), 'a ninth schedule is ignored')
  setSched('p2', { time: '10:00', prompt: 'editado', dueAt: 1 }, 's3')
  check(listOf('p2')[2].id === 's3' && listOf('p2')[2].prompt === 'editado', 'editing one keeps its place and its id')
  setList('p2', [{ id: 'bad', time: '09:00', prompt: 'x', dueAt: 1 }])
  check(!('schedules' in st().workspaces[0].panes.find((p) => p.id === 'p2')), 'a malformed id is dropped (an empty list drops the field)')
  // A cron schedule fires through the same ticker and re-arms at its next run.
  submits.length = 0
  now = Date.now()
  setSched('p1', { time: '', prompt: 'cron', dueAt: now - 1000, recurrence: { kind: 'cron', expr: '*/15 * * * *' } }, 's2')
  setSched('p1', { ...schedOf('p1'), enabled: false })
  r.schedulerTick(now)
  check(submits.length === 1 && submits[0].text === 'cron', 'a due cron schedule fires')
  await flush()
  const nextCronRun = schedOf('p1', 's2').dueAt
  check(lastRun('p1', 's2').status === 'sent' && nextCronRun > Date.now() && nextCronRun - Date.now() <= 15 * MIN && new Date(nextCronRun).getMinutes() % 15 === 0, 'and moves to its next run (the next quarter hour)')
  setSched('p1', null, 's2')
  // One pending-prompt slot per console: an unmounted agent console with two due schedules hands over one prompt at a time.
  submits.length = 0
  now = Date.now()
  setList('q4', [
    { id: 's1', time: '09:00', prompt: 'cuatro uno', dueAt: now - 1000 },
    { id: 's2', time: '09:00', prompt: 'cuatro dos', dueAt: now - 1000 },
  ])
  r.schedulerTick(now)
  check(st().pendingPrompts.q4 && st().pendingPrompts.q4.text === 'cuatro uno' && r.useScheduleRuntime.getState().inflight['q4#s1'].via === 'pending' && schedOf('q4', 's2').waitingSince === now, 'the first schedule takes the pending-prompt slot, the second waits')
  st().takePendingPrompt('q4')
  r.handleSchedulePromptResult({ paneId: 'q4', result: 'sent_argv' }, now + 3000)
  check(lastRun('q4', 's1').status === 'sent' && !(schedOf('q4', 's2').history || []).length, 'the spawn outcome (it names only the console) logs the schedule that handed the prompt over')
  r.registerPty('q4', 'pty-q4')
  status('q4', 'idle')
  r.schedulerTick(now + 3000 + r.SCHEDULE_SETTLE_MS + 1000)
  check(submits.length === 1 && submits[0].ptyId === 'pty-q4' && submits[0].text === 'cuatro dos', 'then the second one is typed once the agent is up and free')
  await flush()
  check(lastRun('q4', 's2').status === 'sent' && schedOf('q4', 's1').enabled === false && schedOf('q4', 's2').enabled === false, 'both one-shots ran once and paused')

  // Labels (header tooltip, table), as of Friday 2026-10-16 10:00.
  const fri = local(2026, 10, 16, 10, 0)
  const t = (k, v) => r.translate('es', k, v)
  const label = r.scheduleNextLabel({ time: '09:00', prompt: 'x', dueAt: local(2026, 10, 19, 9, 0), recurrence: { kind: 'weekdays' } }, t, 'es', fri)
  check(label === 'Próxima: lun 09:00 (Lun-Vie)', 'tooltip: "Próxima: lun 09:00 (Lun-Vie)" ' + label)
  check(r.scheduleNextLabel({ time: '09:00', prompt: 'x', dueAt: 1, enabled: false }, t, 'es') === 'Pausada', 'paused tooltip says "Pausada"')
  check(r.recurrenceLabel({ time: '07:15', recurrence: { kind: 'hourly' } }, t, 'es') === 'Cada hora a los :15' && r.recurrenceLabel({ time: '09:00', recurrence: { kind: 'weekly', days: [3, 1] } }, t, 'es') === 'Semanal: lun, mié', 'hourly and weekly labels')
  const te = (k, v) => r.translate('en', k, v)
  check(r.scheduleNextLabel({ time: '09:00', prompt: 'x', dueAt: local(2026, 10, 19, 9, 0), recurrence: { kind: 'daily' } }, te, 'en', fri) === 'Next: Mon 09:00 (Daily)', 'English label')
  check(r.scheduleNextLabel({ time: '', prompt: 'x', dueAt: local(2026, 10, 19, 9, 0), recurrence: { kind: 'cron', expr: ' 0 9  * * 1-5 ' } }, t, 'es', fri) === 'Próxima: lun 09:00 (Cron: 0 9 * * 1-5)' && r.recurrenceLabel({ time: '', recurrence: { kind: 'cron', expr: '*/15 * * * *' } }, te, 'en') === 'Cron: */15 * * * *', 'a cron rule shows its expression (spaces collapsed) in es and en')
  // A cron run weeks or years away carries its date (it is not this week's Sunday).
  const monthly = { time: '', prompt: 'x', recurrence: { kind: 'cron', expr: '0 9 1 * *' } }
  monthly.dueAt = S.nextDue(monthly, fri)
  check(r.scheduleNextLabel(monthly, t, 'es', fri) === 'Próxima: dom, 1 nov, 09:00 (Cron: 0 9 1 * *)' && r.scheduleNextLabel(monthly, te, 'en', fri) === 'Next: Sun, Nov 1, 09:00 (Cron: 0 9 1 * *)', 'a monthly cron tooltip names its day and month in es and en')
  const leap = { time: '', prompt: 'x', recurrence: { kind: 'cron', expr: '0 0 29 2 *' } }
  leap.dueAt = S.nextDue(leap, fri)
  check(r.scheduleNextLabel(leap, t, 'es', fri) === 'Próxima: mar, 29 feb 2028, 00:00 (Cron: 0 0 29 2 *)' && r.formatWhen(leap.dueAt, 'en', fri) === 'Tue, Feb 29, 2028, 00:00', 'a leap-day cron run two years away also names the year')
  check(r.scheduleNextLabel({ time: '09:00', prompt: 'x', dueAt: local(2026, 10, 21, 9, 0), recurrence: { kind: 'weekly', days: [3] } }, t, 'es', fri) === 'Próxima: mié 09:00 (Semanal: mié)', 'a weekly run within 6 days stays "mié 09:00"')
}

function runLabelChecks() {
  // As of Friday 2026-10-16 10:00 (America/New_York).
  const fri = local(2026, 10, 16, 10, 0)
  const at = (expr) => S.nextDue({ time: '', recurrence: { kind: 'cron', expr } }, fri)
  const monthly = at('0 9 1 * *')
  check(monthly === local(2026, 11, 1, 9, 0) && S.runWhenStyle(monthly, fri) === 'date', 'fixture: "0 9 1 * *" next runs Sunday 2026-11-01, 16 days away')
  check(S.formatRunWhen(monthly, 'es', fri) === 'dom, 1 nov, 09:00' && S.formatRunWhen(monthly, 'en', fri) === 'Sun, Nov 1, 09:00', 'a monthly run shows day and month (es and en), not "dom 09:00"')
  const leap = at('0 0 29 2 *')
  check(leap === local(2028, 2, 29, 0, 0) && S.runWhenStyle(leap, fri) === 'year', 'fixture: "0 0 29 2 *" next runs 2028-02-29')
  check(S.formatRunWhen(leap, 'es', fri) === 'mar, 29 feb 2028, 00:00' && S.formatRunWhen(leap, 'en', fri) === 'Tue, Feb 29, 2028, 00:00', 'a leap-day run in another year also shows the year')
  // Weekly rules: today and the next five days keep the short label, the sixth on gets the date.
  const weekly = (days, time = '09:00') => S.nextDue({ time, recurrence: { kind: 'weekly', days } }, fri)
  check(S.formatRunWhen(weekly([3]), 'es', fri) === 'mié 09:00' && S.formatRunWhen(weekly([3]), 'en', fri) === 'Wed 09:00', 'a weekly run 5 days ahead (Wednesday) stays short')
  check(S.formatRunWhen(weekly([5], '11:00'), 'es', fri) === 'vie 11:00', 'a run later today stays short')
  check(S.formatRunWhen(weekly([4]), 'es', fri) === 'jue, 22 oct, 09:00', 'a weekly run 6 days ahead (next Thursday) shows the date')
  check(S.formatRunWhen(weekly([5]), 'es', fri) === 'vie, 23 oct, 09:00' && S.formatRunWhen(weekly([5]), 'en', fri) === 'Fri, Oct 23, 09:00', 'the same weekday a week ahead never reads as today')
  check(S.formatRunWhen(local(2026, 10, 21, 23, 59), 'es', fri) === 'mié 23:59' && S.formatRunWhen(local(2026, 10, 22, 0, 0), 'es', fri) === 'jue, 22 oct, 00:00', 'the window is by calendar day: Wednesday 23:59 short, Thursday 00:00 dated')
  check(S.formatRunWhen(local(2026, 10, 15, 9, 0), 'es', fri) === 'jue, 15 oct, 09:00', 'a run before today (an overdue wait) shows the date')
  // Fall back (2026-11-01): five calendar days across a 25 h day stay short.
  check(S.formatRunWhen(local(2026, 11, 2, 23, 30), 'es', local(2026, 10, 28, 0, 30)) === 'lun 23:30', 'five calendar days across fall back (6 x 24 h of real time) stay short')
  // Another year: the year even a day or two ahead.
  const dec30 = local(2026, 12, 30, 10, 0)
  check(S.formatRunWhen(local(2026, 12, 31, 9, 0), 'es', dec30) === 'jue 09:00', 'tomorrow in the same year stays short')
  check(S.formatRunWhen(local(2027, 1, 1, 9, 0), 'es', dec30) === 'vie, 1 ene 2027, 09:00' && S.formatRunWhen(local(2027, 1, 1, 9, 0), 'en', dec30) === 'Fri, Jan 1, 2027, 09:00', 'a run in the next year shows the year')
  // The dialog's next 3 cron runs always carry the date, the year only when it is another.
  check(S.formatRunDate(local(2026, 10, 19, 9, 0), 'es', fri) === 'lun, 19 oct, 09:00' && S.formatRunDate(local(2027, 1, 4, 9, 0), 'en', fri) === 'Mon, Jan 4, 2027, 09:00', 'formatRunDate dates even a run 3 days away')
  // Built from code points so this file carries no literal dash.
  const dashes = new RegExp('[-' + String.fromCharCode(0x2013, 0x2014) + ']')
  check(S.RUN_WEEKDAY_DAYS === 6 && !dashes.test(S.formatRunWhen(leap, 'es', fri) + S.formatRunWhen(leap, 'en', fri) + S.formatRunWhen(monthly, 'es', fri)), 'no dashes in the labels')
}

async function main() {
  nextDueChecks()
  typingBlockedChecks()
  decideChecks()
  historyChecks()
  cronChecks()
  runLabelChecks()
  await tickerChecks()
  console.log(`PASS: ${checks} schedule checks (nextDue with DST and cron, decide table, history cap, afterRun, next-run labels with the date 6 or more days away, ticker: submit, wait, skipped_busy, agent_not_running, missed, partial mount, run now, several schedules per console)`)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
