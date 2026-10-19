// Recurring pane automations (E8-FR-28..32, R30-13): nextDue (weekdays from
// a Friday, weekly days, hourly, midnight, DST with a fixed TZ), the decide
// table (busy, precise action, title-only action, shell vs agent without
// state, grace, missed, max wait, paused), the history capped at 20,
// afterRun/withEnabled, and the renderer ticker end to end with a fake pty
// bridge: submit, wait clock, skipped_busy, agent_not_running, missed, the
// partial mount of an unvisited workspace, "Run now" and the pending timeout.
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
  check(d({ now: local(2026, 10, 16, 8, 59), status: { state: 'idle', precise: true } }) === 'idle', 'not due: idle')
  check(S.decide({ ...base, schedule: sched({ enabled: false }), status: { state: 'idle', precise: true } }) === 'idle', 'enabled:false does nothing')
  // Grace (E8-FR-30).
  const at = (late, extra = {}) => S.decide({ ...base, now: sched().dueAt + late, schedule: sched(extra), status: { state: 'idle', precise: true } })
  check(at(60 * MIN) === 'fire', 'one hour late (app opened late) fires once')
  check(at(120 * MIN) === 'fire' && at(120 * MIN + 1) === 'missed', 'the grace bound is inclusive (120 min)')
  check(at(5 * HOUR) === 'missed', 'five hours late is missed')
  check(S.decide({ ...base, graceMin: 0, now: sched().dueAt + 2000, schedule: sched(), status: { state: 'idle', precise: true } }) === 'missed', 'grace 0 misses anything late beyond the same instant')
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
  check(isDeep(cfg.workspaces[0].panes[0].schedule, written), 'a schedule written by afterRun round-trips through the v13 schema')
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
    export { schedulerTick, runScheduleNow, cancelScheduleRun, setScheduleEnabled, handleSchedulePromptResult, useScheduleRuntime, isManualRunPending, isAgentKind, PENDING_DELIVERY_TIMEOUT_MS } from './usePaneScheduler'
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
  const schedOf = (id) => st().workspaces.flatMap((w) => w.panes).find((p) => p.id === id).schedule
  const wsOf = (id) => st().workspaces.find((w) => w.panes.some((p) => p.id === id)).id
  const setSched = (id, s) => st().setPaneSchedule(wsOf(id), id, s)
  const status = (id, state, precise = true) => A.setState((s) => ({ paneStatus: { ...s.paneStatus, [id]: state ? { state, precise } : undefined } }))
  const lastRun = (id) => { const h = schedOf(id).history || []; return h[h.length - 1] }
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
  submits.length = 0
  now = Date.now()
  setSched('p2', { time: '10:00', prompt: 'p', dueAt: now - 1000 })
  status('p2', null)
  r.schedulerTick(now)
  r.schedulerTick(now + 29 * MIN)
  check(submits.length === 0 && schedOf('p2').waitingSince === now, 'an agent pane whose agent exited waits (the text would run in the shell)')
  r.schedulerTick(now + 30 * MIN)
  check(submits.length === 0 && lastRun('p2').status === 'failed' && lastRun('p2').reason === 'agent_not_running', 'after 30 min without an agent: failed with agent_not_running')

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
  check(r.runScheduleNow('p1', '  probar esto  ') === true, 'run now accepts a scheduled pane')
  check(submits.length === 1 && submits[0].text === 'probar esto', 'run now sends the dialog text right away to a free pane')
  await flush()
  check(lastRun('p1').trigger === 'manual' && lastRun('p1').status === 'sent' && schedOf('p1').dueAt === pausedDue && schedOf('p1').enabled === false, 'run now logs a manual run and never moves dueAt or the switch')
  check(!r.isManualRunPending(r.useScheduleRuntime.getState(), 'p1'), 'the manual request is done')
  // Run now on a busy agent waits ("Waiting..."), then fires once free.
  submits.length = 0
  setSched('p2', { time: '10:00', prompt: 'guardado', dueAt: Date.now() + 5 * HOUR })
  status('p2', 'working')
  r.runScheduleNow('p2')
  check(submits.length === 0 && r.isManualRunPending(r.useScheduleRuntime.getState(), 'p2'), 'run now respects "wait for the agent to be free"')
  status('p2', 'idle')
  r.schedulerTick(Date.now())
  check(submits.length === 1 && submits[0].text === 'guardado', 'once free it sends the saved prompt')
  await flush()
  check(lastRun('p2').trigger === 'manual' && schedOf('p2').dueAt > Date.now() + 4 * HOUR && !r.isManualRunPending(r.useScheduleRuntime.getState(), 'p2'), 'and the scheduled run stays where it was')
  status('p2', 'working')
  r.runScheduleNow('p2')
  r.cancelScheduleRun('p2')
  status('p2', 'idle')
  submits.length = 0
  r.schedulerTick(Date.now())
  check(submits.length === 0, 'a cancelled run now sends nothing')
  check(r.runScheduleNow('q3') === false, 'run now on a pane without a schedule is refused')

  // multiline_unsafe.
  submits.length = 0
  submitResult = { ok: false, error: 'multiline_unsafe' }
  setSched('p1', { time: '09:00', prompt: 'a\nb', dueAt: Date.now() - 1000 })
  r.schedulerTick(Date.now())
  await flush()
  check(lastRun('p1').status === 'failed' && lastRun('p1').reason === 'multiline_unsafe', 'multi-line text to a console without bracketed paste: failed multiline_unsafe')
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
  check(submits.length === 0 && r.useScheduleRuntime.getState().inflight.q1.via === 'pending', 'nothing is typed before the agent is ready')
  r.schedulerTick(now + 1000)
  check(st().pendingPrompts.q1 === pend, 'the prompt is handed once')
  r.handleSchedulePromptResult({ paneId: 'q1', result: 'sent_argv' }, now + 5000)
  check(lastRun('q1').status === 'sent' && schedOf('q1').dueAt > now && !r.useScheduleRuntime.getState().inflight.q1, 'the spawn outcome logs the run as sent')
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
  check(st().pendingPrompts.q1 && r.useScheduleRuntime.getState().inflight.q1, 'handed to a spawn again')
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
  r.setScheduleEnabled('q2', true)
  check(schedOf('q2').enabled === true && schedOf('q2').dueAt > Date.now(), 'switching it back on schedules the next occurrence')
  r.setScheduleEnabled('q2', false)
  check(schedOf('q2').enabled === false && schedOf('q2').history.length === 1, 'pausing keeps the history')

  // Desktop notification per run (opt-in).
  st().updateSettings({ automation: { ...st().settings.automation, scheduleNotify: true } })
  setSched('p1', { time: '09:00', prompt: 'n', dueAt: Date.now() - 1000 })
  r.schedulerTick(Date.now())
  await flush()
  check(notifications.length === 1 && notifications[0].title === 'Automatización: T-p1' && notifications[0].body === 'Enviado', 'scheduleNotify shows one desktop notification per run')

  // Labels (header tooltip, table).
  const t = (k, v) => r.translate('es', k, v)
  const label = r.scheduleNextLabel({ time: '09:00', prompt: 'x', dueAt: local(2026, 10, 19, 9, 0), recurrence: { kind: 'weekdays' } }, t, 'es')
  check(label === 'Próxima: lun 09:00 (Lun-Vie)', 'tooltip: "Próxima: lun 09:00 (Lun-Vie)" ' + label)
  check(r.scheduleNextLabel({ time: '09:00', prompt: 'x', dueAt: 1, enabled: false }, t, 'es') === 'Pausada', 'paused tooltip says "Pausada"')
  check(r.recurrenceLabel({ time: '07:15', recurrence: { kind: 'hourly' } }, t, 'es') === 'Cada hora a los :15' && r.recurrenceLabel({ time: '09:00', recurrence: { kind: 'weekly', days: [3, 1] } }, t, 'es') === 'Semanal: lun, mié', 'hourly and weekly labels')
  const te = (k, v) => r.translate('en', k, v)
  check(r.scheduleNextLabel({ time: '09:00', prompt: 'x', dueAt: local(2026, 10, 19, 9, 0), recurrence: { kind: 'daily' } }, te, 'en') === 'Next: Mon 09:00 (Daily)', 'English label')
}

async function main() {
  nextDueChecks()
  decideChecks()
  historyChecks()
  await tickerChecks()
  console.log(`PASS: ${checks} schedule checks (nextDue with DST, decide table, history cap, afterRun, ticker: submit, wait, skipped_busy, agent_not_running, missed, partial mount, run now)`)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
