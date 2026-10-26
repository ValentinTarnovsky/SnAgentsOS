// Teams routines, team notes and run silence (app 2.7.0, E10 B7, design 3.8 and 3.10). Covered: the RoutineTicker on
// a manual clock (a key per enabled routine at nextCron, none for a disabled or removed one, a fire at its due time
// with that scheduled time and the next key after it, a retry for a taken wake slot kept across a re-arm, `retry` of a
// displaced wake and whether it armed one, a clock that went back, disarm, lastDue, the catch-up: once when missed by
// less than 2 h, the latest due time only, skipped and logged beyond, skippedFor and a manual run as baselines, the
// trust time for a routine that never fired, an owed displacedFor); the pure
// reducers (the wake of a role agent in lead or free mode with the prompt and its ref, the first idle agent, a taken
// slot, the coalesce rule, a routine's task, patchRoutine, the stalled card once per run, its dismissal, the silence
// ack, `team.note` of a block as a teamNote effect, routineView); and TeamService on a real git repo with the fake
// agent: lastScheduledFor written to state.json before the wake, the wake as a "Por despachar" item with autonomy off,
// coalesce while the previous fire still has a level, a run or a task, the run of a routine's wake (trigger routine,
// lastRunId, its prompt on stdin), "Correr ahora" (runId past autonomy, busy while its run lives, taskId), "Ejecutar
// ahora" of an agent whose routine wake waits (it runs that wake once), the daily-summary template routine waking the
// Lead in lead mode, `team note` writing a team note under dataDir()/teams (UTF-8 without BOM, the notes and note ops,
// the `notes` scope) and never the workspace notes, a Dev refused, a Codex Lead's block note, the catch-up across a
// restart (once within 2 h, skipped and logged beyond), a deadline reached late (asleep) judged the same way, run silence quiet and
// stalled from the run's last line (the roster, the runs op, the board, one stalled card per run), the recovery of a
// stalled run that streams again (silence cleared, rearm, its card dismissed, one change out), the silence ack, the card
// dismissed when its run ends, Seguir esperando and Frenar, the silence settings, and with Labs off zero DeadlineTimer
// keys and no watched run, then routines firing again after Labs on; a new stalled card raising exactly one desktop
// notice (the B5 path), also when a settings change moves a quiet run on show to stalled, and that card dismissed with
// the silence when new minutes no longer reach it; a run inside a long tool that only prints tool_progress heartbeats
// (claude-heartbeat.jsonl, the shape of the real 2.7.0 walkthrough run) going quiet and stalled with its one card,
// while one that streams content every 30 s keeps no silence; a routine wake that a policy
// re-wake of its agent writes over getting its wake-slot retry for the same scheduled time and running once (no retry
// and no 'retry' log line when its next key comes sooner); a displaced wake never lost at a quit or a crash
// (displacedFor in state.json, the reaper's case, the catch-up of the next enable running it once within 2 h and
// skipping it beyond, every verdict and its run clearing it, a bad value repaired at load); and with
// the definition `changed`, routines armed from the trusted snapshot whose marks wait at gate G1 until trust.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data, never a real agent.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), label); checks++ }
const json = (v) => JSON.parse(JSON.stringify(v ?? null))
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
const FIX = path.join(__dirname, 'fixtures', 'teams')
const FAKE = path.join(FIX, 'fake-agent.cjs')
const MIN = 60_000
const HOUR = 60 * MIN

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-routines-'))
const electronStub = { app: { getPath: (name) => (name === 'userData' ? path.join(TMP, 'ud') : TMP), isPackaged: false, commandLine: { hasSwitch: () => false } } }
function loadEntry(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (id) => (id === 'electron' ? electronStub : require(id)), console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, TextEncoder, TextDecoder })
  return mod.exports
}

const M = loadEntry(`
export { TeamService, TEAM_NOTES_MAX } from './src/main/teams/TeamService'
export { RoutineTicker, routineKey, lastDue, ROUTINE_SLOT_RETRY_MS } from './src/main/teams/RoutineTicker'
export * from './src/main/teams/flow/routines'
export * from './src/main/teams/flow/silence'
export { applyTool, applyBlock, noteOf, teamNoteText } from './src/main/teams/flow/tools'
export { routineView } from './src/main/teams/views'
export { TeamDefinitionLoader } from './src/main/teams/TeamDefinitionLoader'
export { createGitRunner, gitEnv } from './src/main/git/gitExec'
export * from './src/shared/teams'
export { nextCron } from './src/shared/cron'
export { defaultDraft, renderTeamFiles, parseDefinition, DAILY_SUMMARY_ID, DAILY_SUMMARY_CRON } from './src/shared/teamDefinition'
export { pidAlive, signalTree, treeKillSync } from './src/main/proc/treeKill'
export { DeadlineTimer } from './src/main/DeadlineTimer'
export { CtlTokens, newToken } from './src/main/cli/CtlTokens'
export { mainTLang } from './src/main/i18n'
`)

const until = async (fn, ms = 15000, label = 'condition') => {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}
const settle = () => new Promise((r) => setTimeout(r, 40))

/** A manual clock and the timer deps of DeadlineTimer on it (deadlines move only on advance). */
function manualClock(start = 1_800_000_000_000) {
  const c = { now: start, timers: new Map(), seq: 0 }
  c.deps = {
    now: () => c.now,
    setTimeout: (fn, ms) => { const id = ++c.seq; c.timers.set(id, { fn, at: c.now + ms }); return id },
    clearTimeout: (id) => c.timers.delete(id),
  }
  c.advance = (ms) => {
    c.now += ms
    for (;;) {
      const due = [...c.timers].filter(([, t]) => t.at <= c.now)
      if (due.length === 0) return
      for (const [id, t] of due) { c.timers.delete(id); t.fn() }
    }
  }
  c.to = (at) => c.advance(Math.max(0, at - c.now))
  return c
}

// ---- 1. RoutineTicker on a manual clock ----------------------------------------------------------
const TEAM = 'tm-0123456789ab'
const R = (id, cron, extra = {}) => ({ id, cron, action: 'wake', role: 'lead', prompt: 'Hacé algo', enabled: true, ...extra })

function tickerWorld() {
  const clock = manualClock()
  const t = { clock, fired: [], logs: [], outcome: undefined }
  t.timer = new M.DeadlineTimer((key) => t.ticker.onDue(key), clock.deps)
  t.ticker = new M.RoutineTicker({
    timer: t.timer,
    now: () => clock.now,
    fire: (teamId, r, at) => {
      t.fired.push({ teamId, id: r.id, at })
      return typeof t.outcome === 'function' ? t.outcome() : t.outcome
    },
    log: (l) => t.logs.push(l),
  })
  return t
}

function tickerChecks() {
  const t = tickerWorld()
  const { clock, timer, ticker } = t
  const cron = '0,30 * * * *'
  const key = M.routineKey(TEAM, 'a')
  const list = [R('a', cron), R('off', '0 * * * *', { enabled: false })]
  ticker.arm(TEAM, list, {})
  const n1 = M.nextCron(cron, clock.now)
  check(timer.at(key) === n1 && !timer.has(M.routineKey(TEAM, 'off')) && timer.size === 1 && ticker.size === 1, 'arm: the enabled routine at nextCron, a disabled one arms nothing')
  check(ticker.nextAt(TEAM, 'a') === n1 && ticker.nextAt(TEAM, 'off') === null, 'nextAt reads the armed deadline')
  clock.advance(n1 - clock.now - 1)
  check(t.fired.length === 0, 'nothing fires before its time (no polling: one platform timer at the deadline)')
  check(clock.timers.size === 1, 'exactly one platform timer pending')
  clock.advance(1)
  same(t.fired, [{ teamId: TEAM, id: 'a', at: n1 }], 'fired at its due time with that scheduled time')
  const n2 = M.nextCron(cron, n1)
  check(timer.at(key) === n2, 'armed again at the next due time after the one it fired for')

  // A taken wake slot: the fire asks for a retry, the key comes back for the same scheduled time.
  t.outcome = () => ({ retryAt: clock.now + M.ROUTINE_SLOT_RETRY_MS })
  clock.to(n2)
  check(t.fired[1].at === n2 && timer.at(key) === n2 + M.ROUTINE_SLOT_RETRY_MS, 'a retry outcome: the key at retryAt')
  t.outcome = undefined
  ticker.arm(TEAM, list, {})
  check(timer.at(key) === n2 + M.ROUTINE_SLOT_RETRY_MS, 'a re-arm keeps a pending retry while the cron is the same')
  clock.advance(M.ROUTINE_SLOT_RETRY_MS)
  check(t.fired.length === 3 && t.fired[2].at === n2, 'the retry fires for the same scheduled time')
  check(timer.at(key) === M.nextCron(cron, clock.now), 'then the next due time after now')
  // A re-arm with another cron drops a pending retry.
  t.outcome = () => ({ retryAt: clock.now + M.ROUTINE_SLOT_RETRY_MS })
  clock.to(timer.at(key))
  t.outcome = undefined
  ticker.arm(TEAM, [R('a', '0 9 * * *')], {})
  check(timer.at(key) === M.nextCron('0 9 * * *', clock.now), 'a re-arm with a new cron replaces the retry')

  // A wake already fired that lost its slot later (TeamService calls retry): the same scheduled time at retryAt; a key
  // that comes due sooner is kept; a routine or a team that is not armed gets none.
  const yearly = '0 0 1 1 *'
  ticker.arm(TEAM, [R('a', yearly)], {})
  const lost = clock.now - MIN
  check(ticker.retry(TEAM, 'a', lost, clock.now + M.ROUTINE_SLOT_RETRY_MS) === true, 'retry answers true when it armed the retry')
  check(timer.at(key) === clock.now + M.ROUTINE_SLOT_RETRY_MS, 'retry: the key at retryAt')
  check(ticker.retry(TEAM, 'a', lost, clock.now + 2 * M.ROUTINE_SLOT_RETRY_MS) === false, 'a later retry answers false')
  check(timer.at(key) === clock.now + M.ROUTINE_SLOT_RETRY_MS, 'a later retry keeps the key that comes due sooner')
  check(ticker.retry(TEAM, 'gone', lost, clock.now + MIN) === false && ticker.retry('tm-ffffffffffff', 'a', lost, clock.now + MIN) === false, 'retry of a routine or a team that is not armed answers false')
  check(timer.size === 1 && ticker.size === 1, 'no key for a routine or a team that is not armed')
  const firedBefore = t.fired.length
  clock.advance(M.ROUTINE_SLOT_RETRY_MS)
  check(t.fired.length === firedBefore + 1 && t.fired[firedBefore].at === lost && timer.at(key) === M.nextCron(yearly, clock.now), 'it fires for that scheduled time, then the next due time')

  // The clock went back: never before the last scheduled time.
  ticker.arm(TEAM, [R('a', cron)], { a: { lastScheduledFor: clock.now + 3 * HOUR } })
  check(timer.at(key) === M.nextCron(cron, clock.now + 3 * HOUR), 'a lastScheduledFor ahead of now: armed after it')

  // Removed, disarmed, other teams.
  ticker.arm(TEAM, [], {})
  check(timer.size === 0 && ticker.size === 0, 'a routine removed by a re-arm: its key goes')
  const other = 'tm-ba9876543210'
  ticker.arm(TEAM, [R('a', cron)], {})
  ticker.arm(other, [R('b', '0 9 * * *')], {})
  ticker.disarm(TEAM)
  check(timer.size === 1 && timer.has(M.routineKey(other, 'b')), 'disarm clears only that team')
  ticker.disarmAll()
  check(timer.size === 0 && ticker.size === 0 && clock.timers.size === 0, 'disarmAll: zero keys and no platform timer')
  check(ticker.onDue(M.routineKey(TEAM, 'gone')) === true && ticker.onDue('dispatch') === false, 'onDue: a stale routine key is the ticker\'s, any other key is not')
  const firedNow = t.fired.length
  ticker.fire(TEAM, 'a', clock.now)
  check(t.fired.length === firedNow && timer.size === 0, 'a fire of a team that is not armed does nothing')

  // A fire that throws is logged and the routine is armed again.
  ticker.arm(TEAM, [R('a', cron)], {})
  t.outcome = () => { throw new Error('boom') }
  clock.to(timer.at(key))
  t.outcome = undefined
  check(t.logs.some((l) => l.includes('fire failed')) && timer.has(key), 'a throwing fire is logged and the routine armed again')
  ticker.disarmAll()
}

function catchUpChecks() {
  const t = tickerWorld()
  const { clock, ticker } = t
  const daily = '0 9 * * *'
  // d = the last 09:00 at or before now.
  const d = M.lastDue(daily, clock.now - 48 * HOUR, clock.now)
  check(typeof d === 'number' && d <= clock.now && M.nextCron(daily, d) > clock.now, 'lastDue: the latest due time up to now')
  check(M.lastDue(daily, d, clock.now) === null, 'lastDue: nothing after the last one')
  check(M.lastDue('0 0 1 1 *', clock.now - 800 * 24 * HOUR, clock.now) === M.lastDue('0 0 1 1 *', clock.now - 400 * 24 * HOUR, clock.now), 'lastDue of a yearly rule: the latest within a long window')
  check(M.lastDue('0,30 * * * *', clock.now - 10 * HOUR, clock.now) === M.lastDue('0,30 * * * *', clock.now - HOUR, clock.now), 'lastDue of a dense rule reads only the last window')
  const r = R('daily', daily)
  clock.now = d + 30 * MIN
  same(json(ticker.catchUp(TEAM, [r], { daily: { lastScheduledFor: d - 24 * HOUR } })), [{ routine: r, scheduledAt: d }], 'missed by 30 min: runs once for that due time')
  clock.now = d + 2 * HOUR
  check(ticker.catchUp(TEAM, [r], { daily: { lastScheduledFor: d - 24 * HOUR } }).length === 1, 'missed by exactly 2 h: still runs')
  clock.now = d + 3 * HOUR
  const skipped = ticker.catchUp(TEAM, [r], { daily: { lastScheduledFor: d - 24 * HOUR } })
  same(json(skipped), [{ routine: r, scheduledAt: d, skipped: true }], 'missed by 3 h: skipped')
  check(t.logs.some((l) => l.includes(`routine ${TEAM} daily skipped`) && l.includes('180 min')), 'the skip is logged with how late it was')
  check(ticker.catchUp(TEAM, [r], { daily: { lastScheduledFor: d } }).length === 0, 'nothing missed: nothing')
  check(ticker.catchUp(TEAM, [r], { daily: { lastScheduledFor: d - 24 * HOUR, skippedFor: d } }).length === 0, 'a due time already skipped is not looked at again')
  clock.now = d + 30 * MIN
  check(ticker.catchUp(TEAM, [r], { daily: { lastScheduledFor: d - 24 * HOUR, lastFiredAt: d + 10 * MIN } }).length === 0, 'a run after the due time (Correr ahora) covers it')
  check(ticker.catchUp(TEAM, [r], {}).length === 0, 'a routine that never fired and no trust time: nothing')
  same(json(ticker.catchUp(TEAM, [r], {}, d - HOUR)), [{ routine: r, scheduledAt: d }], 'a routine that never fired: missed since the trust time')
  check(ticker.catchUp(TEAM, [r], {}, d + MIN).length === 0, 'trusted after the due time: nothing')
  check(ticker.catchUp(TEAM, [{ ...r, enabled: false }], { daily: { lastScheduledFor: d - 24 * HOUR } }).length === 0, 'a disabled routine never catches up')
  // Several due times missed within 2 h: one run, for the latest.
  const hourly = R('h', '0 * * * *')
  const h = M.lastDue('0 * * * *', clock.now - 2 * HOUR, clock.now)
  same(json(ticker.catchUp(TEAM, [hourly], { h: { lastScheduledFor: h - 2 * HOUR } })), [{ routine: hourly, scheduledAt: h }], 'two due times missed: one run for the latest')
  // A displaced wake whose retry never landed (displacedFor): its own scheduled time, when nothing newer came due.
  clock.now = d + 90 * MIN
  const owed = { daily: { lastScheduledFor: d, lastFiredAt: d, displacedFor: d } }
  same(json(ticker.catchUp(TEAM, [r], owed)), [{ routine: r, scheduledAt: d }], 'a displaced wake owed 90 min: runs once for its scheduled time')
  clock.now = d + 3 * HOUR
  const logsBefore = t.logs.length
  same(json(ticker.catchUp(TEAM, [r], owed)), [{ routine: r, scheduledAt: d, skipped: true }], 'owed 3 h: skipped')
  check(t.logs.slice(logsBefore).some((l) => l.includes(`routine ${TEAM} daily skipped`) && l.includes('180 min')), 'the skip of an owed wake is logged like any missed fire')
  const d2 = M.nextCron(daily, d)
  clock.now = d2 + 30 * MIN
  same(json(ticker.catchUp(TEAM, [r], owed)), [{ routine: r, scheduledAt: d2 }], 'a newer due time came: one run for it covers the owed wake')
  clock.now = d + 90 * MIN
  check(ticker.catchUp(TEAM, [r], { daily: { ...owed.daily, displacedFor: Number.NaN } }).length === 0, 'a displacedFor that is not a time is no due time')
  check(ticker.catchUp(TEAM, [{ ...r, enabled: false }], owed).length === 0, 'a disabled routine owes nothing')
}

// ---- 2. pure reducers ----------------------------------------------------------------------------
function draftDef() {
  const files = M.renderTeamFiles({ ...M.defaultDraft('es'), name: 'Equipo', goal: '' })
  const parsed = M.parseDefinition(files)
  assert.ok(parsed.ok, JSON.stringify(parsed.errors ?? null))
  return { def: parsed.def, sha256: 'a'.repeat(64), goalHash: 'b'.repeat(64), trustedAt: 1, files }
}
function agent(id, roleId, roleKind, extra = {}) {
  return { id, roleId, roleKind, provider: 'claude', status: 'idle', paused: false, sessions: {}, interrupts: 0, ...extra }
}
function baseRt() {
  const rt = M.emptyRuntime(TEAM, 'abcd1234')
  return { ...rt, agents: [agent('lead', 'lead', 'lead'), agent('dev', 'dev', 'dev'), agent('dev-2', 'dev', 'dev'), agent('qa', 'qa', 'qa')] }
}
function run(id, agentId, extra = {}) {
  return { id, agentId, roleId: agentId.replace(/-\d$/, ''), roleKind: agentId === 'lead' ? 'lead' : 'dev', sessionKey: 'free', provider: 'claude', profile: 'readonly', resumed: false, cwd: '/r', repoId: 'main', mode: agentId === 'lead' ? 'lead' : 'free', trigger: { reason: 'manual', by: 'user' }, state: 'running', reachedRunning: true, resultSeen: false, queuedAt: 1, startedAt: 2, ...extra }
}

function reducerChecks() {
  const trusted = draftDef()
  const ctx = { now: 1000, def: trusted, newRunId: () => 'r-000000000001', newSessionId: () => 's' }
  const daily = trusted.def.routines.find((r) => r.id === M.DAILY_SUMMARY_ID)
  check(daily && daily.cron === M.DAILY_SUMMARY_CRON && daily.action === 'wake' && daily.role === 'lead' && /snaos team note/.test(daily.prompt), 'the template ships routines/daily-summary.md: the Lead, wake, 0 18 * * 1-5, a prompt that writes a note')
  check(M.routineRef('daily-summary') === 'routine:daily-summary' && M.routineOfRefs(['k-1', 'routine:x']) === 'x' && M.routineOfRefs(['k-1']) === null && M.routineOfRefs(undefined) === null, 'routineRef and routineOfRefs')

  // The wake: lead mode for the Lead, the prompt and the ref, a pass.
  const rt0 = baseRt()
  const w = M.routineWake(rt0, daily, ctx)
  const lead = w.rt.agents.find((a) => a.id === 'lead')
  same(lead.next, { agentId: 'lead', mode: 'lead', reason: 'routine', since: 1000, detail: daily.prompt, refs: ['routine:daily-summary'] }, 'routineWake: the Lead in lead mode, reason routine, the prompt as its request, the ref')
  same(w.effects, [{ kind: 'dispatch' }], 'routineWake pokes the dispatcher')
  check(rt0.agents.find((a) => a.id === 'lead').next === undefined, 'copy on write')
  check(M.routinePending(w.rt, daily) === 'level' && M.routinePending(rt0, daily) === null, 'coalesce: a wake not dispatched holds the routine')
  // Free mode for any other role; the first idle agent of the role, else the first with a free slot.
  const chk = { id: 'check', cron: '0 * * * *', action: 'wake', role: 'dev', prompt: 'Revisá el CI', enabled: true }
  check(M.routineWake(rt0, chk, ctx).rt.agents.find((a) => a.id === 'dev').next.mode === 'free', 'a non-lead role wakes in free mode')
  const devBusy = { ...rt0, agents: rt0.agents.map((a) => (a.id === 'dev' ? { ...a, status: 'running', runId: 'r-000000000009' } : a)) }
  check(M.routineWake(devBusy, chk, ctx).result.agentId === 'dev-2', 'the first idle agent of the role')
  const allBusy = { ...rt0, agents: rt0.agents.map((a) => (a.roleId === 'dev' ? { ...a, status: 'running', runId: `r-00000000000${a.id === 'dev' ? 8 : 9}` } : a)) }
  check(M.routineWake(allBusy, chk, ctx).result.agentId === 'dev', 'none idle: the first with a free slot (its mark waits for its run)')
  const slots = { ...rt0, agents: rt0.agents.map((a) => (a.roleId === 'dev' ? { ...a, next: { agentId: a.id, mode: 'free', reason: 'continuation', since: 1 } } : a)) }
  same(M.routineWake(slots, chk, ctx), { ok: false, error: 'busy' }, 'every slot of the role taken: busy (never overwrites another wake)')
  same(M.routineWake(rt0, { ...chk, role: 'nobody' }, ctx), { ok: false, error: 'not_found' }, 'no agent of the role: not_found')
  const retired = { ...rt0, agents: rt0.agents.map((a) => (a.id === 'dev' ? { ...a, retired: true } : a)) }
  check(M.routineWake(retired, chk, ctx).result.agentId === 'dev-2', 'a retired agent never runs a routine')

  // Coalesce on runs: the wake's run carries the ref; a "Correr ahora" run is lastRunId.
  const withRun = { ...rt0, activeRuns: [run('r-000000000001', 'lead', { trigger: { reason: 'routine', refs: ['routine:daily-summary'], by: 'system' } })] }
  check(M.routinePending(withRun, daily) === 'run', 'coalesce: the active run of its wake')
  const manualRun = { ...rt0, activeRuns: [run('r-000000000002', 'lead')], routines: { 'daily-summary': { lastRunId: 'r-000000000002' } } }
  check(M.routinePending(manualRun, daily) === 'run', 'coalesce: the active run of a "Correr ahora"')
  check(M.routinePending({ ...manualRun, activeRuns: [] }, daily) === null, 'its run over: free again')

  // A task routine.
  const deps = { id: 'deps', cron: '0 9 * * 1', action: 'task', role: 'dev', title: 'Revisar dependencias', prompt: 'Revisá las dependencias.', enabled: true }
  const t1 = M.routineTask(rt0, deps, ctx)
  const task = t1.rt.tasks[0]
  check(t1.ok && t1.result.taskId === 't-1' && task.title === 'Revisar dependencias' && task.body === 'Revisá las dependencias.' && task.assignee === 'dev' && task.createdBy.kind === 'system' && task.userOwned.length === 0, 'routineTask: a system task titled by the routine, its prompt as the body, the first idle agent')
  check(t1.rt.routines.deps.lastTaskId === 't-1' && t1.effects.some((e) => e.kind === 'dispatch'), 'its lastTaskId in the same result, a pass')
  check(M.routineTask(rt0, { ...deps, title: undefined }, ctx).rt.tasks[0].title === 'deps', 'no title: the routine id')
  check(M.routineTask(devBusy, deps, ctx).rt.tasks[0].assignee === 'dev-2', 'the task goes to the first idle agent of the role')
  check(M.routinePending(t1.rt, deps) === 'task', 'coalesce: its task still in todo')
  const doing = { ...t1.rt, tasks: [{ ...task, state: 'doing', phase: 'planApproval' }] }
  check(M.routinePending(doing, deps) === null, 'its task waiting on the user (no run, no level): free')
  check(M.routinePending({ ...doing, tasks: [{ ...doing.tasks[0], next: { agentId: 'dev', mode: 'exec', reason: 'planApproved', since: 1 } }] }, deps) === 'task', 'its task with a wake waiting: held')
  check(M.routinePending({ ...doing, activeRuns: [run('r-000000000003', 'dev', { taskId: 't-1', mode: 'plan' })] }, deps) === 'task', 'a run on its task: held')
  check(M.routinePending({ ...t1.rt, tasks: [{ ...task, state: 'cancelled' }] }, deps) === null, 'its task cancelled: free')

  // patchRoutine.
  const p1 = M.patchRoutine(rt0, 'a', { lastScheduledFor: 5 })
  check(p1 !== rt0 && p1.routines.a.lastScheduledFor === 5, 'patchRoutine sets')
  check(M.patchRoutine(p1, 'a', { lastScheduledFor: 5 }) === p1 && M.patchRoutine(rt0, 'b', { lastRunId: undefined }) === rt0, 'patchRoutine: the same rt when nothing changes')
  const p2 = M.patchRoutine({ ...p1, routines: { a: { lastScheduledFor: 5, lastRunId: 'r-000000000001' } } }, 'a', { lastRunId: undefined, lastFiredAt: 6 })
  same(p2.routines.a, { lastScheduledFor: 5, lastFiredAt: 6 }, 'patchRoutine: undefined drops a key')

  // The stalled card: one per run, dismissed, the ack.
  const live = { ...rt0, activeRuns: [run('r-0000000000a1', 'dev'), run('r-0000000000a2', 'dev-2', { taskId: 't-1' })] }
  const c1 = M.openStalledCard(live, live.activeRuns[0], { now: 7 })
  const card = c1.rt.cards[0]
  check(card.from.kind === 'system' && card.from.why === 'stalled' && card.from.runId === 'r-0000000000a1' && JSON.stringify(card.from.actions) === '["stopRun","keepWaiting"]' && card.from.vars.what === 'r-0000000000a1' && card.state === 'open', 'openStalledCard: a system card stalled with Frenar and Seguir esperando, for that run')
  check(M.openStalledCard(c1.rt, live.activeRuns[0], { now: 8 }).rt === c1.rt, 'one per run: a second stalled of the same run opens none')
  const c2 = M.openStalledCard(c1.rt, live.activeRuns[1], { now: 9 })
  check(c2.rt.cards.length === 2 && c2.rt.cards[1].taskId === 't-1', 'another run gets its own card, on its task')
  const d1 = M.dismissStalledCard(c2.rt, 'r-0000000000a1')
  check(d1.cards[0].state === 'dismissed' && d1.cards[1].state === 'open' && M.dismissStalledCard(d1, 'r-0000000000a1') === d1, 'dismissStalledCard: only that run\'s open card')
  const ack = M.ackRunSilence(c2.rt, 'r-0000000000a2', { now: 10 })
  check(ack.rt.activeRuns[1].silenceAckedAt === 10 && ack.rt.cards[1].state === 'dismissed' && ack.rt.cards[0].state === 'open', 'ackRunSilence: silenceAckedAt and its card dismissed')
  check(M.ackRunSilence(c2.rt, 'r-0000000000ff', { now: 10 }).rt === c2.rt, 'a run that is over: nothing to ignore')
  const stale = M.dismissStaleStalledCards({ ...c2.rt, activeRuns: [live.activeRuns[1]] })
  check(stale.cards[0].state === 'dismissed' && stale.cards[1].state === 'open', 'dismissStaleStalledCards: a card whose run is not active goes')

  // team.note of a block: a teamNote effect, the runtime unchanged.
  const lr = { ...rt0, activeRuns: [run('r-0000000000b1', 'lead')], agents: rt0.agents.map((a) => (a.id === 'lead' ? { ...a, status: 'running', runId: 'r-0000000000b1' } : a)) }
  const leadActor = { kind: 'agent', agentId: 'lead', runId: 'r-0000000000b1', roleKind: 'lead' }
  const note = M.applyTool(lr, leadActor, { method: 'team.note', params: { text: 'Hoy:\r\nt-1 hecha', title: '  Resumen\tdiario ' }, viaBlock: true }, ctx)
  check(note.ok && note.rt === lr, 'team.note leaves the runtime as it is')
  same(note.effects, [{ kind: 'teamNote', runId: 'r-0000000000b1', text: 'Hoy:\nt-1 hecha', title: 'Resumen diario' }], 'its effect: the note text (CRLF to LF) and a one-line title')
  same(M.applyTool(lr, leadActor, { method: 'team.note', params: { title: 'x' } }, ctx), { ok: false, error: 'bad_request' }, 'team.note without a text: bad_request')
  same(M.applyTool(lr, leadActor, { method: 'team.note', params: { text: 'x', title: 7 } }, ctx), { ok: false, error: 'bad_request' }, 'a title that is not a text: bad_request')
  same(M.applyTool(lr, leadActor, { method: 'team.note', params: { text: 'x', task: 't-1' } }, ctx), { ok: false, error: 'bad_request' }, 'an unknown param: bad_request')
  same(M.applyTool(lr, leadActor, { method: 'team.note', params: { text: 'x', title: 'y'.repeat(81) } }, ctx), { ok: false, error: 'bad_request' }, 'a title past 80 characters: bad_request')
  const dr = { ...rt0, activeRuns: [run('r-0000000000b2', 'dev')] }
  same(M.applyTool(dr, { kind: 'agent', agentId: 'dev', runId: 'r-0000000000b2', roleKind: 'dev' }, { method: 'team.note', params: { text: 'x' } }, ctx), { ok: false, error: 'forbidden' }, 'a Dev cannot write a team note')
  const concluded = { ...lr, activeRuns: [{ ...lr.activeRuns[0], concludedBy: { tool: 'ask', at: 1 } }] }
  check(M.applyTool(concluded, leadActor, { method: 'team.note', params: { text: 'x' } }, ctx).error === 'conflict', 'a concluded run writes no note')
  check(M.teamNoteText({ text: 'Cuerpo', title: 'Título' }) === '# Título\n\nCuerpo\n' && M.teamNoteText({ text: 'Solo' }) === 'Solo\n', 'teamNoteText: the title as the first heading')
  same(M.noteOf({ text: '  hola  ', title: '' }), { text: 'hola' }, 'noteOf: an empty title is no title')

  // routineView.
  const rv = M.routineView(daily, { lastScheduledFor: 100, lastFiredAt: 110, lastRunId: 'r-000000000001' }, 500)
  same(rv, { id: 'daily-summary', cron: M.DAILY_SUMMARY_CRON, action: 'wake', role: 'lead', enabled: true, nextAt: 500, title: daily.title, last: { at: 110, runId: 'r-000000000001' } }, 'routineView: next, last fire with its run')
  same(M.routineView(daily, { lastFiredAt: 110, skippedFor: 200 }, null).last, { at: 200, skipped: true }, 'a newer skip shows as skipped')
  same(M.routineView(daily, { lastFiredAt: 300, skippedFor: 200 }, null).last, { at: 300 }, 'a run after the skip shows the run')
  check(M.routineView(daily, undefined, null).last === undefined, 'never ran: no last')
  same(M.routineView(deps, { lastFiredAt: 1, lastTaskId: 't-3' }, null).last, { at: 1, taskId: 't-3' }, 'a task routine names its task')
}

// ---- 3. TeamService on a real repo with the fake agent -------------------------------------------
const gitCfg = path.join(TMP, 'gitconfig')
fs.writeFileSync(gitCfg, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
const gitSysCfg = path.join(TMP, 'gitconfig-system')
fs.writeFileSync(gitSysCfg, '')
const gitEnvVars = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitCfg, GIT_CONFIG_SYSTEM: gitSysCfg }
for (const k of Object.keys(gitEnvVars)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete gitEnvVars[k]
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, env: gitEnvVars, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const runner = M.createGitRunner({ env: () => M.gitEnv(gitEnvVars) })
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

const services = []
async function world(name, o = {}) {
  const dir = path.join(TMP, name)
  const repo = o.repo ?? makeRepo(path.join(dir, 'repo'))
  const data = o.data ?? path.join(dir, 'data')
  const clock = o.clock ?? manualClock()
  const w = { dir, repo, data, clock, logs: [], emitted: [], notices: [], stateWrites: [], scenario: path.join(FIX, 'claude-simple.json') }
  w.tokens = new M.CtlTokens(M.newToken())
  const shim = path.join(dir, 'bin', process.platform === 'win32' ? 'snaos.cmd' : 'snaos')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, '')
  w.cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '', ...(o.agents ? { agents: o.agents } : {}) }, workspaces: [] }
  // The store's fs, recording every state.json it renames into place (what the disk held, write by write).
  const storeFs = {
    readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync, rmSync: fs.rmSync, appendFileSync: fs.appendFileSync, statSync: fs.statSync,
    renameSync: (from, to) => {
      if (path.basename(to) === 'state.json') w.stateWrites.push(JSON.parse(fs.readFileSync(from, 'utf8')))
      fs.renameSync(from, to)
    },
  }
  w.svc = new M.TeamService({
    dataDir: () => data,
    config: () => w.cfg,
    git: runner,
    emit: (e) => w.emitted.push(json(e)),
    notice: (n) => w.notices.push(json(n)),
    openPath: async () => '',
    log: (l) => w.logs.push(l),
    now: () => clock.now,
    timerDeps: clock.deps,
    loader: new M.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) }),
    strict: true,
    storeFs,
    status: { snapshot: () => [], stateOf: () => null, paneForSession: () => null },
    pty: { spawnCwd: () => undefined, ptyIdForPane: () => null, killPaneAndWait: async () => undefined },
    sessionHolder: () => null,
    accounts: () => null,
    cli: {
      envForTeam: (runId, teamId, agentId, roleKind) => ({ SNAOS_CTL_ENDPOINT: 'test-pipe', SNAOS_CTL_TOKEN: w.tokens.issueTeam(runId, { runId, teamId, agentId, roleKind }), SNAOS_CLI: shim, SNAOS_TEAM_RUN: runId }),
      revokeTeam: (runId) => w.tokens.revokeTeam(runId),
      ready: () => true,
      holdsToken: (text) => w.tokens.holdsToken(text),
      maskTokens: (text) => w.tokens.maskTokens(text),
    },
    awake: () => undefined,
    sendRun: () => undefined,
    resolveCli: () => ({ file: process.execPath, args: [FAKE, w.scenario], kind: 'exe' }),
    procStartTime: async () => null,
    platform: process.platform,
  })
  services.push(w.svc)
  await w.svc.start(w.cfg)
  if (!o.noTeam) {
    const probe = await w.svc.request({ op: 'setupProbe', dir: repo }, 'desktop')
    const draft = { ...probe.probe.defaults, goal: '', verify: '' }
    if (o.codexLead) draft.roles = draft.roles.map((r) => (r.kind === 'lead' ? { ...r, provider: 'codex', model: undefined, effort: undefined } : r))
    const prev = await w.svc.request({ op: 'setupPreview', repoRoot: repo, draft }, 'desktop')
    const wr = await w.svc.request({ op: 'setupWrite', repoRoot: repo, draft, previewHash: prev.preview.hash }, 'desktop')
    assert.ok(wr.ok, `setup ${name}: ${JSON.stringify(wr)}`)
    w.teamId = wr.teamId
  } else w.teamId = o.teamId
  w.rt = () => w.svc.team(w.teamId).store.rt
  w.ring = () => w.svc.team(w.teamId).store.recentRuns()
  w.ended = (id) => w.ring().find((r) => r.id === id)
  w.active = (id) => w.rt().activeRuns.find((r) => r.id === id)
  w.req = (op, extra = {}) => w.svc.request({ op, teamId: w.teamId, ...extra }, 'desktop')
  w.use = (file) => {
    if (typeof file === 'object') {
      const p = path.join(dir, `scenario-${Math.random().toString(16).slice(2)}.json`)
      fs.writeFileSync(p, JSON.stringify(file))
      w.scenario = p
    } else w.scenario = path.join(FIX, file)
  }
  w.teamData = () => path.join(data, 'teams', w.teamId)
  w.waitEnded = (id) => until(() => !!w.ended(id), 20000, `run ${id} ended`)
  w.waitState = (id, state) => until(() => w.active(id)?.state === state, 20000, `run ${id} ${state}`)
  w.view = async (id) => (await w.req('routines')).routines.find((r) => r.id === id)
  w.key = (id) => M.routineKey(w.teamId, id)
  return w
}
const teamDirOf = (w) => path.join(w.repo, '.snagentsos', 'team')
const whoOf = (w, runId) => {
  const r = w.active(runId)
  return { runId, teamId: w.teamId, agentId: r.agentId, roleKind: r.roleKind }
}
function routineFile(w, id, fields, prompt) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  fs.writeFileSync(path.join(teamDirOf(w), 'routines', `${id}.md`), `---\n${lines.join('\n')}\n---\n\n${prompt}\n`)
}
async function trustAgain(w) {
  const diff = await w.req('trustDiff')
  const tr = await w.req('trust', { sha256: diff.trust.sha256 })
  assert.ok(tr.ok, `trust: ${JSON.stringify(tr)}`)
}
/** A run that streams its first lines, waits `ms` of real time, sends one more line, then hangs. */
const lateLine = (ms) => ({ steps: [{ fixture: 'claude-simple.jsonl', to: 6, rewriteSession: true }, { sleepMs: ms }, { fixture: 'claude-simple.jsonl', from: 6, to: 7 }, { hang: true }] })

async function routineServiceChecks() {
  const w = await world('routines')
  const t = w.svc.trusted(w.teamId)
  const daily = t.def.routines.find((r) => r.id === M.DAILY_SUMMARY_ID)
  check(w.svc.routines.nextAt(w.teamId, M.DAILY_SUMMARY_ID) === M.nextCron(M.DAILY_SUMMARY_CRON, w.clock.now), 'setup: the daily summary armed at its next due time')
  const cron = '0,30 * * * *'
  routineFile(w, 'check', { cron, action: 'wake', role: 'dev', title: 'Revisar CI' }, 'Revisá el CI y contá lo que falla.')
  routineFile(w, 'quiet', { cron: '0 * * * *', role: 'dev', enabled: 'false' }, 'Nunca sola.')
  await trustAgain(w)
  check(w.svc.routines.nextAt(w.teamId, 'check') === M.nextCron(cron, w.clock.now) && w.svc.routines.nextAt(w.teamId, 'quiet') === null, 'a trust arms the new routine; a disabled one arms nothing')
  const views = (await w.req('routines')).routines
  check(views.length === 3 && views.find((v) => v.id === 'quiet').enabled === false && views.find((v) => v.id === 'quiet').nextAt === null && views.find((v) => v.id === 'check').title === 'Revisar CI', 'the routines op lists every routine of the definition')

  // The first due time: lastScheduledFor on disk before the wake, then the wake as a "Por despachar" item.
  const tc1 = M.nextCron(cron, w.clock.now)
  const writesBefore = w.stateWrites.length
  w.clock.to(tc1)
  const writes = w.stateWrites.slice(writesBefore)
  const first = writes.findIndex((s) => s.routines?.check?.lastScheduledFor === tc1)
  check(first >= 0 && !writes[first].agents.some((a) => (a.next?.refs ?? []).includes('routine:check')), 'lastScheduledFor written to state.json before the wake exists')
  const dev = w.rt().agents.find((a) => a.id === 'dev')
  same(dev.next, { agentId: 'dev', mode: 'free', reason: 'routine', since: tc1, detail: 'Revisá el CI y contá lo que falla.', refs: ['routine:check'] }, 'the wake: the role\'s first idle agent, free mode, the prompt, the ref')
  const item = w.rt().queue.find((q) => q.agentId === 'dev')
  check(item && item.reason === 'routine' && item.mode === 'free' && JSON.stringify(item.refs) === '["routine:check"]', 'autonomy off: the wake waits in Por despachar')
  check(w.svc.routines.nextAt(w.teamId, 'check') === M.nextCron(cron, tc1), 'armed again at the next due time')
  same((await w.view('check')).last, { at: tc1 }, 'the view: its last fire')

  // Coalesce: the next due time while that wake still waits.
  const tc2 = M.nextCron(cron, tc1)
  w.clock.to(tc2)
  check(w.logs.some((l) => l === `routine ${w.teamId} check skipped: its previous fire still has a level`), 'the next due time while the wake waits: skipped and logged')
  // (The daily summary may come due in this window too in some time zones: only the check routine's items count.)
  check(w.rt().routines.check.lastScheduledFor === tc2 && w.rt().agents.find((a) => a.id === 'dev').next.since === tc1 && w.rt().queue.filter((q) => (q.refs ?? []).includes('routine:check')).length === 1, 'nothing doubles: one wake, one item')
  check(w.rt().routines.check.lastFiredAt === tc1, 'a skipped due time is no fire')

  // Despachar: the run of the wake carries the routine (trigger routine, the ref), its lastRunId, the prompt on stdin.
  const stdinFile = path.join(w.dir, 'stdin-check.txt')
  w.use({ saveStdin: stdinFile, steps: [{ fixture: 'claude-simple.jsonl', rewriteSession: true }] })
  const go = await w.req('dispatch', { queueId: item.id, go: true })
  check(go.ok, `Despachar (${JSON.stringify(go)})`)
  w.clock.advance(0)
  const r1 = w.rt().activeRuns.find((r) => r.agentId === 'dev')
  check(r1 && r1.trigger.reason === 'routine' && JSON.stringify(r1.trigger.refs) === '["routine:check"]' && r1.mode === 'free', 'the run of the routine: reason routine, the ref, free mode')
  check(w.rt().routines.check.lastRunId === r1.id && w.rt().agents.find((a) => a.id === 'dev').next === undefined, 'its lastRunId in the admission commit; the wake consumed')
  await w.waitEnded(r1.id)
  check(fs.readFileSync(stdinFile, 'utf8').includes('Revisá el CI y contá lo que falla.'), 'the routine prompt reaches the run on stdin')
  same((await w.view('check')).last, { at: tc1, runId: r1.id }, 'the view names its run')

  // "Correr ahora": the user's go, past the autonomy gate; busy while its run lives; a scheduled due time skips.
  w.use('hang.json')
  const rr = await w.req('routineRun', { routineId: 'check' })
  check(rr.ok && typeof rr.runId === 'string', `routineRun of a wake: its run now with autonomy off (${JSON.stringify(rr)})`)
  const r2 = w.active(rr.runId)
  check(r2 && r2.trigger.reason === 'manual' && r2.mode === 'free' && w.rt().routines.check.lastRunId === rr.runId, 'its run is the routine\'s last')
  same(await w.req('routineRun', { routineId: 'check' }), { ok: false, error: 'busy', detail: 'run' }, 'routineRun again while its run lives: busy')
  await w.waitState(rr.runId, 'running')
  const tc3 = M.nextCron(cron, w.clock.now)
  w.clock.to(tc3)
  check(w.logs.some((l) => l === `routine ${w.teamId} check skipped: its previous fire still has a run`), 'a due time while its run lives: skipped')
  await w.req('stop', { runId: rr.runId })
  await w.waitEnded(rr.runId)
  same(await w.req('routineRun', { routineId: 'nope' }), { ok: false, error: 'not_found' }, 'routineRun of an unknown routine: not_found')

  // "Ejecutar ahora" of the agent (no prompt) while the routine's wake waits: it runs that wake, its best level, and
  // consumes it; the routine prompt never runs a second time after it.
  const tc4 = M.nextCron(cron, w.clock.now)
  w.clock.to(tc4)
  check((w.rt().agents.find((a) => a.id === 'dev').next?.refs ?? []).includes('routine:check'), 'the next due time: the wake waits again')
  w.use('hang.json')
  const own = await w.req('runNow', { agentId: 'dev' })
  check(own.ok, `Ejecutar ahora of the agent (${JSON.stringify(own)})`)
  const r3 = w.active(own.runId)
  check(r3 && r3.trigger.reason === 'manual' && JSON.stringify(r3.trigger.refs) === '["routine:check"]', 'it runs the routine wake (its ref)')
  check(w.rt().agents.find((a) => a.id === 'dev').next === undefined && w.rt().routines.check.lastRunId === own.runId, 'the wake consumed, the run is the routine\'s last')
  await w.req('stop', { runId: own.runId })
  await w.waitEnded(own.runId)
  w.clock.advance(0)
  check(w.rt().agents.find((a) => a.id === 'dev').next === undefined && !w.rt().activeRuns.some((r) => r.agentId === 'dev') && !w.rt().queue.some((q) => (q.refs ?? []).includes('routine:check')), 'the routine prompt does not run a second time')

  // A task routine: its task, coalesced while it waits, Correr ahora busy, then free once the task is over.
  routineFile(w, 'deps', { cron: '0 * * * *', action: 'task', role: 'dev', title: 'Revisar dependencias' }, 'Revisá las dependencias del repo.')
  await trustAgain(w)
  const td1 = M.nextCron('0 * * * *', w.clock.now)
  w.clock.to(td1)
  const task = w.rt().tasks.find((x) => x.title === 'Revisar dependencias')
  check(task && task.body === 'Revisá las dependencias del repo.' && task.createdBy.kind === 'system' && task.state === 'todo' && (task.assignee === 'dev' || task.assignee === 'dev-2'), 'the task routine creates its task for the role')
  check(w.rt().routines.deps.lastTaskId === task.id && w.rt().routines.deps.lastScheduledFor === td1, 'its lastTaskId and lastScheduledFor')
  same((await w.view('deps')).last, { at: td1, taskId: task.id }, 'the view names its task')
  w.clock.to(M.nextCron('0 * * * *', td1))
  check(w.logs.some((l) => l === `routine ${w.teamId} deps skipped: its previous fire still has a task`) && w.rt().tasks.filter((x) => x.title === 'Revisar dependencias').length === 1, 'its next due time while the task waits: skipped')
  same(await w.req('routineRun', { routineId: 'deps' }), { ok: false, error: 'busy', detail: 'task' }, 'Correr ahora of a task routine whose task waits: busy')
  const mv = await w.req('moveTask', { taskId: task.id, baseRev: w.rt().tasks.find((x) => x.id === task.id).rev, to: 'cancelled', stopRun: true })
  check(mv.ok, `the task cancelled (${JSON.stringify(mv)})`)
  const again = await w.req('routineRun', { routineId: 'deps' })
  check(again.ok && again.taskId && again.taskId !== task.id && w.rt().routines.deps.lastTaskId === again.taskId, 'its task over: Correr ahora creates a new one')

  // Untrusted: Correr ahora answers untrusted (the trust gate).
  fs.appendFileSync(path.join(teamDirOf(w), 'roles', 'dev.md'), '\nOtra regla.\n')
  await w.req('get')
  same(await w.req('routineRun', { routineId: 'check' }), { ok: false, error: 'untrusted' }, 'a changed definition: routineRun untrusted')
  w.svc.dispose()
  check(w.svc.pendingTimers === 0, 'dispose: no key left')
}

async function dailySummaryChecks() {
  const w = await world('daily')
  const due = M.nextCron(M.DAILY_SUMMARY_CRON, w.clock.now)
  const prompt = w.svc.trusted(w.teamId).def.routines.find((r) => r.id === M.DAILY_SUMMARY_ID).prompt
  w.clock.to(due)
  const lead = w.rt().agents.find((a) => a.roleKind === 'lead')
  same(lead.next, { agentId: lead.id, mode: 'lead', reason: 'routine', since: due, detail: prompt, refs: ['routine:daily-summary'] }, 'the daily summary wakes the Lead in lead mode')
  const item = w.rt().queue.find((q) => q.agentId === lead.id)
  check(item && item.mode === 'lead' && item.reason === 'routine', 'its item in Por despachar (autonomy off)')
  const stdinFile = path.join(w.dir, 'stdin-daily.txt')
  w.use({ saveStdin: stdinFile, steps: [{ fixture: 'claude-simple.jsonl', to: 6, rewriteSession: true }, { hang: true }] })
  await w.req('dispatch', { queueId: item.id, go: true })
  w.clock.advance(0)
  const run = w.rt().activeRuns.find((r) => r.agentId === lead.id)
  check(run && run.mode === 'lead' && run.trigger.reason === 'routine' && w.rt().routines[M.DAILY_SUMMARY_ID].lastRunId === run.id, 'the Lead\'s run: lead mode, reason routine, the routine\'s last run')
  await w.waitState(run.id, 'running')
  const stdin = fs.readFileSync(stdinFile, 'utf8')
  check(stdin.includes('from="routine"') && stdin.includes('snaos team note'), 'its stdin carries the routine prompt as a routine request')

  // The Lead writes the daily summary with `snaos team note`: a team note, never a workspace note.
  const emittedBefore = w.emitted.length
  const res = await w.svc.ctlView.handle('team.note', { text: 'Hecho: t-1.\nEn curso: t-2.', title: 'Resumen diario' }, whoOf(w, run.id))
  check(res.ok && /^n-[a-f0-9]{16}$/.test(res.data.id), `team note answers its id (${JSON.stringify(res)})`)
  const file = path.join(w.teamData(), `${res.data.id}.md`)
  const bytes = fs.readFileSync(file)
  check(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) && bytes.toString('utf8') === '# Resumen diario\n\nHecho: t-1.\nEn curso: t-2.\n', 'the note file under dataDir()/teams/<team>, UTF-8 without BOM, its title as the heading')
  check(!fs.readdirSync(w.teamData()).some((n) => n.endsWith('.tmp')), 'written tmp + rename: no temp file left')
  check(!fs.existsSync(path.join(w.data, 'notes')), 'the workspace notes are never touched')
  await settle()
  check(w.emitted.slice(emittedBefore).some((e) => e.teamId === w.teamId && e.scopes.includes('notes')), 'the notes scope goes out')
  const list = await w.req('notes')
  check(list.ok && list.notes.length === 1 && list.notes[0].id === res.data.id && list.notes[0].title === 'Resumen diario', 'the notes op lists it')
  const one = await w.req('note', { noteId: res.data.id })
  check(one.ok && one.title === 'Resumen diario' && one.text === '# Resumen diario\n\nHecho: t-1.\nEn curso: t-2.\n' && typeof one.updatedAt === 'number' && !('path' in one), 'the note op reads it (no path)')
  same(await w.req('note', { noteId: 'n-0000000000000000' }), { ok: false, error: 'not_found' }, 'an unknown note: not_found')
  same(await w.req('note', { noteId: '../state' }), { ok: false, error: 'bad_request' }, 'a note id that is not one: bad_request')
  const bare = await w.svc.ctlView.handle('team.note', { text: 'Sin título' }, whoOf(w, run.id))
  check(bare.ok && fs.readFileSync(path.join(w.teamData(), `${bare.data.id}.md`), 'utf8') === 'Sin título\n', 'a note without a title')
  // A Dev may not write one.
  w.use('hang.json')
  const d = await w.req('runNow', { agentId: 'dev' })
  await w.waitState(d.runId, 'running')
  const refused = await w.svc.ctlView.handle('team.note', { text: 'x' }, whoOf(w, d.runId))
  check(!refused.ok && refused.error.code === 'forbidden', 'a Dev run: team note forbidden')
  await w.req('stop', { runId: d.runId })
  await w.req('stop', { runId: run.id })
  await w.waitEnded(d.runId)
  await w.waitEnded(run.id)
  const lastScheduled = w.rt().routines[M.DAILY_SUMMARY_ID].lastScheduledFor
  check(lastScheduled === due, 'lastScheduledFor of the daily summary')

  // Closed across the next due time, back within 2 h: it runs once at start.
  const due2 = M.nextCron(M.DAILY_SUMMARY_CRON, due)
  w.svc.shutdownSync('quit')
  w.svc.dispose()
  const w2 = await world('daily', { repo: w.repo, data: w.data, clock: manualClock(due2 + 90 * MIN), noTeam: true, teamId: w.teamId })
  const lead2 = w2.rt().agents.find((a) => a.roleKind === 'lead')
  check(w2.rt().routines[M.DAILY_SUMMARY_ID].lastScheduledFor === due2 && lead2.next?.reason === 'routine' && lead2.next.since === w2.clock.now, 'missed by 90 min while closed: it runs once at start')
  check(w2.svc.routines.nextAt(w2.teamId, M.DAILY_SUMMARY_ID) === M.nextCron(M.DAILY_SUMMARY_CRON, w2.clock.now), 'then armed at its next due time')
  w2.svc.dispose()
  // Back more than 2 h after the next one: skipped and logged.
  const due3 = M.nextCron(M.DAILY_SUMMARY_CRON, due2)
  const w3 = await world('daily', { repo: w.repo, data: w.data, clock: manualClock(due3 + 3 * HOUR), noTeam: true, teamId: w.teamId })
  check(w3.logs.some((l) => l.startsWith(`routine ${w3.teamId} ${M.DAILY_SUMMARY_ID} skipped: due`) && l.includes('missed by 180 min')), 'missed by 3 h: skipped and logged')
  const st = w3.rt().routines[M.DAILY_SUMMARY_ID]
  check(st.skippedFor === due3 && st.lastScheduledFor === due2, 'skippedFor recorded, lastScheduledFor kept')
  same((await w3.view(M.DAILY_SUMMARY_ID)).last, { at: due3, skipped: true }, 'the view: skipped')
  w3.svc.dispose()
  const w4 = await world('daily', { repo: w.repo, data: w.data, clock: manualClock(due3 + 3 * HOUR + MIN), noTeam: true, teamId: w.teamId })
  check(!w4.logs.some((l) => l.includes('skipped: due')), 'a skipped due time is not skipped again at the next start')
  w4.svc.dispose()
}

async function lateFireChecks() {
  // A deadline the timer reaches late (the machine slept through it): judged like the catch-up at enable.
  const w = await world('late')
  const due = M.nextCron(M.DAILY_SUMMARY_CRON, w.clock.now)
  w.clock.advance(due - w.clock.now + 3 * HOUR)
  const st = w.rt().routines[M.DAILY_SUMMARY_ID] ?? {}
  check(w.logs.some((l) => l.startsWith(`routine ${w.teamId} ${M.DAILY_SUMMARY_ID} skipped: due`) && l.includes('missed by 180 min')), 'a deadline reached 3 h late (asleep): skipped and logged')
  check(st.skippedFor === due && st.lastScheduledFor === undefined && w.rt().agents.find((a) => a.roleKind === 'lead').next === undefined, 'skippedFor recorded, no wake')
  check(w.svc.routines.nextAt(w.teamId, M.DAILY_SUMMARY_ID) === M.nextCron(M.DAILY_SUMMARY_CRON, w.clock.now), 'then armed at its next due time')
  // A dense rule reached 3.5 h late: its latest due time (30 min ago) runs once.
  routineFile(w, 'hourly', { cron: '0 * * * *', action: 'wake', role: 'dev' }, 'Mirá el CI.')
  await trustAgain(w)
  const h1 = M.nextCron('0 * * * *', w.clock.now)
  w.clock.advance(h1 - w.clock.now + 3 * HOUR + 30 * MIN)
  const latest = M.lastDue('0 * * * *', h1, w.clock.now)
  const dev = w.rt().agents.find((a) => a.id === 'dev')
  check(w.clock.now - latest === 30 * MIN && w.rt().routines.hourly.lastScheduledFor === latest && dev.next?.reason === 'routine' && dev.next.since === w.clock.now, 'reached 3.5 h late: one run for the latest due time')
  check(w.svc.routines.nextAt(w.teamId, 'hourly') === M.nextCron('0 * * * *', w.clock.now), 'then armed at the next one')
  w.svc.dispose()
}

async function codexLeadNoteChecks() {
  const w = await world('codex-lead', { codexLead: true })
  const block = '```snaos-team\n{"v":1,"actions":[{"method":"team.note","params":{"title":"Resumen diario","text":"Todo en orden."}}]}\n```'
  w.use({ steps: [
    { emit: { type: 'thread.started', thread_id: '019a0000-0000-7000-8000-00000000c0de' } },
    { emit: { type: 'turn.started' } },
    { emit: { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `Listo.\n\n${block}` } } },
    { emit: { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } } },
  ] })
  const lead = w.rt().agents.find((a) => a.roleKind === 'lead')
  const r = await w.req('runNow', { agentId: lead.id })
  check(r.ok, `a Codex Lead run (${JSON.stringify(r)})`)
  await w.waitEnded(r.runId)
  await until(async () => ((await w.req('notes')).notes ?? []).length === 1, 10000, 'block note written')
  const list = await w.req('notes')
  check(list.notes[0].title === 'Resumen diario' && fs.readFileSync(path.join(w.teamData(), `${list.notes[0].id}.md`), 'utf8') === '# Resumen diario\n\nTodo en orden.\n', 'a Codex Lead\'s block note lands as a team note')
  check(w.logs.some((l) => l.includes(`run ${r.runId} team.note (block) written`)), 'logged with its run')
  w.svc.dispose()
}

async function silenceChecks() {
  const w = await world('silence')
  // Room for the silences below inside one run (maxRunMinutes would stop it at 45).
  const teamMd = path.join(teamDirOf(w), 'team.md')
  fs.writeFileSync(teamMd, fs.readFileSync(teamMd, 'utf8').replace(/^---\n/, '---\nmaxRunMinutes: 120\n'))
  await trustAgain(w)
  check(w.svc.trusted(w.teamId).def.maxRunMinutes === 120, 'maxRunMinutes 120 for this team')
  const t = await w.req('createTask', { task: { title: 'Arreglar el build', assignee: 'dev', isolation: 'main', needsPlan: false } })
  const taskId = t.task.id
  w.use(lateLine(3000))
  const r = await w.req('runNow', { agentId: 'dev', taskId })
  check(r.ok, `a task run (${JSON.stringify(r)})`)
  const id = r.runId
  await w.waitState(id, 'running')
  check(w.svc.silenceWatchCount === 1, 'watched from running')
  const firstLine = w.svc.runLive(id).lastLineAt
  check(typeof firstLine === 'number', 'its last line lives in memory')
  const silenceOf = async () => (await w.req('roster')).agents.find((a) => a.id === 'dev').run?.silence

  w.clock.advance(10 * MIN)
  same(await silenceOf(), { level: 'quiet', since: firstLine }, 'quiet after quietMin since its last line (the roster)')
  same((await w.req('runs', { agentId: 'dev' })).runs.find((x) => x.id === id).silence, { level: 'quiet', since: firstLine }, 'the runs op')
  same((await w.req('board')).page.tasks.find((x) => x.id === taskId).run.silence, { level: 'quiet', since: firstLine }, 'the board card of its task')
  check(!w.rt().cards.some((c) => c.from.kind === 'system' && c.from.why === 'stalled'), 'quiet opens no card')
  check(w.emitted.some((e) => e.runId === id && e.scopes.includes('agents') && e.scopes.includes('run')), 'the silence goes out as agents/run')
  w.clock.advance(10 * MIN)
  same(await silenceOf(), { level: 'stalled', since: firstLine }, 'stalled after stalledMin')
  const stalled = () => w.rt().cards.filter((c) => c.from.kind === 'system' && c.from.why === 'stalled' && c.from.runId === id)
  check(stalled().length === 1 && stalled()[0].state === 'open' && stalled()[0].taskId === taskId && JSON.stringify(stalled()[0].from.actions) === '["stopRun","keepWaiting"]', 'one stalled card for the run, on its task')
  const needs = await w.req('needs')
  check(needs.needs.cards.some((c) => c.id === stalled()[0].id), 'the card is in Te necesita')
  w.clock.advance(5 * MIN)
  check(stalled().length === 1, 'still one card')

  // It streams again: silence cleared, rearmed from that line, its card dismissed, one change out.
  const before = w.emitted.length
  await until(() => (w.svc.runLive(id).lastLineAt ?? 0) > firstLine, 15000, 'the late line')
  await settle()
  const later = w.svc.runLive(id).lastLineAt
  check(w.svc.runLive(id).silence === undefined && (await silenceOf()) === undefined, 'the silence clears on a new line')
  check(stalled()[0].state === 'dismissed', 'its stalled card dismissed')
  const outs = w.emitted.slice(before).filter((e) => e.runId === id)
  check(outs.length === 1 && outs[0].scopes.includes('agents') && outs[0].scopes.includes('run'), `one change out for the recovery (${JSON.stringify(outs)})`)
  w.clock.advance(10 * MIN)
  same(await silenceOf(), { level: 'quiet', since: later }, 'rearmed: quiet again counts from the new line')

  // Ignore the rest of this run: no silence, no card, unwatched.
  same(await w.req('runSilenceAck', { runId: id }), { ok: true }, 'runSilenceAck')
  check(w.active(id).silenceAckedAt === w.clock.now && w.svc.silenceWatchCount === 0 && (await silenceOf()) === undefined, 'silenceAckedAt, unwatched, the silence gone')
  w.clock.advance(25 * MIN)
  check((await silenceOf()) === undefined && stalled().length === 1 && w.active(id)?.state === 'running', 'an ignored run reads no silence and opens no card')
  same(await w.req('runSilenceAck', { runId: 'r-000000000000' }), { ok: false, error: 'not_found' }, 'an unknown run: not_found')
  await w.req('stop', { runId: id })
  await w.waitEnded(id)
  same(await w.req('runSilenceAck', { runId: id }), { ok: true }, 'a run that is over: nothing to ignore')

  // A stalled run that ends: its card goes with it. Seguir esperando keeps the run; Frenar stops it.
  w.use('hang.json')
  const a = await w.req('runNow', { agentId: 'dev-2' })
  await w.waitState(a.runId, 'running')
  w.clock.advance(20 * MIN)
  const cardA = w.rt().cards.find((c) => c.from.kind === 'system' && c.from.why === 'stalled' && c.from.runId === a.runId)
  check(cardA && cardA.state === 'open' && cardA.taskId === undefined, 'a free run stalls: its card has no task')
  same(await w.req('answer', { cardId: cardA.id, answer: { action: 'keepWaiting' } }), { ok: true }, 'Seguir esperando')
  check(w.active(a.runId)?.state === 'running' && w.rt().cards.find((c) => c.id === cardA.id).state === 'answered', 'the run keeps going')
  await w.req('stop', { runId: a.runId })
  await w.waitEnded(a.runId)
  check(w.svc.silenceWatchCount === 0, 'an ended run is no longer watched')
  const b = await w.req('runNow', { agentId: 'dev-2' })
  await w.waitState(b.runId, 'running')
  w.clock.advance(20 * MIN)
  const cardB = w.rt().cards.find((c) => c.from.kind === 'system' && c.from.why === 'stalled' && c.from.runId === b.runId)
  same(await w.req('answer', { cardId: cardB.id, answer: { action: 'stopRun' } }), { ok: true }, 'Frenar')
  await w.waitEnded(b.runId)
  check(w.ended(b.runId).stopReason === 'user', 'Frenar stops the run')
  const c = await w.req('runNow', { agentId: 'dev-2' })
  await w.waitState(c.runId, 'running')
  w.clock.advance(20 * MIN)
  const cardC = w.rt().cards.find((x) => x.from.kind === 'system' && x.from.why === 'stalled' && x.from.runId === c.runId)
  await w.req('stop', { runId: c.runId })
  await w.waitEnded(c.runId)
  check(w.rt().cards.find((x) => x.id === cardC.id).state === 'dismissed', 'a stalled run that ends: its card dismissed')

  // The silence settings: off reads nothing; back on, a silence the minutes reach shows again.
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, agents: { silence: { enabled: false, quietMin: 10, stalledMin: 20 } } } }
  w.svc.setConfig(w.cfg)
  const d = await w.req('runNow', { agentId: 'dev-2' })
  await w.waitState(d.runId, 'running')
  const dLine = w.svc.runLive(d.runId).lastLineAt
  w.clock.advance(25 * MIN)
  check(w.svc.runLive(d.runId).silence === undefined && !w.rt().cards.some((x) => x.from.kind === 'system' && x.from.why === 'stalled' && x.from.runId === d.runId), 'silence off: no silence, no card')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, agents: { silence: { enabled: true, quietMin: 10, stalledMin: 20 } } } }
  w.svc.setConfig(w.cfg)
  w.clock.advance(0)
  same(w.svc.runLive(d.runId).silence, { level: 'stalled', since: dLine }, 'back on: the watched run is judged again at once')

  // Labs off: zero keys and no watched run; Labs on: the routines armed again, and they fire.
  check(w.svc.silenceWatchCount === 1 && w.svc.pendingTimers > 0 && w.svc.routines.size > 0, 'before Labs off: a watched run, a routine key and others')
  const dPid = w.active(d.runId).pid
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  check(w.svc.pendingTimers === 0 && w.svc.silenceWatchCount === 0 && w.svc.routines.size === 0 && w.clock.timers.size === 0, 'Labs off: zero DeadlineTimer keys, no routine key, no watched run, no platform timer')
  await until(() => !M.pidAlive(dPid), 10000, 'labs off killed the run')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(async () => (await w.svc.request({ op: 'list' }, 'desktop')).ok, 10000, 'enabled again')
  const next = M.nextCron(M.DAILY_SUMMARY_CRON, w.clock.now)
  check(w.svc.routines.nextAt(w.teamId, M.DAILY_SUMMARY_ID) === next, 'Labs on: the routines armed again')
  w.clock.to(next)
  check(w.rt().routines[M.DAILY_SUMMARY_ID].lastScheduledFor === next && w.rt().agents.find((x) => x.roleKind === 'lead').next?.reason === 'routine', 'after Labs off and on the routine fires again')
  w.svc.shutdownSync('quit')
  check(w.svc.pendingTimers === 0 && w.svc.routines.size === 0, 'shutdownSync: no key left')
  w.svc.dispose()
}

async function stalledNoticeChecks() {
  // A new stalled card raises exactly one desktop notice through the B5 notice path (a new "Te necesita" row): when
  // the watch reports it, and when a settings change moves a quiet run on show to stalled (the same one card).
  const w = await world('stalled-notice', { agents: { silence: { enabled: true, quietMin: 10, stalledMin: 20 } } })
  const stalledOf = (runId) => w.rt().cards.filter((c) => c.from.kind === 'system' && c.from.why === 'stalled' && c.from.runId === runId)
  const noticesOf = (card) => w.notices.filter((n) => n.tag === `team:${w.teamId}:${card.id}`)
  const teamTitle = `Equipo ${w.svc.trusted(w.teamId).def.name}`
  // `running` comes with the first line of hang.json; the manual clock moves only once its last line (the assistant
  // message) is read, so no late line resets the silence under a check.
  const linesRead = (runId) => until(() => (w.svc.runLive(runId).ring ?? []).some((m) => m.role === 'assistant'), 10000, `run ${runId} read its lines`)
  w.use('hang.json')
  const a = await w.req('runNow', { agentId: 'dev' })
  await w.waitState(a.runId, 'running')
  await linesRead(a.runId)
  w.clock.advance(20 * MIN)
  await settle()
  const cardA = stalledOf(a.runId)
  const na = cardA.length === 1 ? noticesOf(cardA[0]) : []
  check(cardA.length === 1 && na.length === 1 && na[0].kind === 'team' && na[0].title === teamTitle && na[0].body === M.mainTLang('es', 'teams.push.cardTeam') && na[0].urgent === false && na[0].push === true, `the watch reports stalled: one card and exactly one desktop notice (${JSON.stringify(w.notices)})`)
  w.clock.advance(10 * MIN)
  await settle()
  check(stalledOf(a.runId).length === 1 && noticesOf(cardA[0]).length === 1, 'still one card and one notice')
  await w.req('stop', { runId: a.runId })
  await w.waitEnded(a.runId)

  // Quiet on show, then minutes that call it stalled: its stalled card (and its notice) at once, exactly as the watch
  // gives them, and the watch's own report of that level after it changes nothing.
  const b = await w.req('runNow', { agentId: 'dev-2' })
  await w.waitState(b.runId, 'running')
  await linesRead(b.runId)
  const bLine = w.svc.runLive(b.runId).lastLineAt
  w.clock.advance(12 * MIN)
  same(w.svc.runLive(b.runId).silence, { level: 'quiet', since: bLine }, 'quiet on show after 12 min')
  check(stalledOf(b.runId).length === 0, 'quiet opens no card')
  const emittedBefore = w.emitted.length
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, agents: { silence: { enabled: true, quietMin: 5, stalledMin: 11 } } } }
  w.svc.setConfig(w.cfg)
  same(w.svc.runLive(b.runId).silence, { level: 'stalled', since: bLine }, 'the new minutes call it stalled')
  const cardB = stalledOf(b.runId)
  check(cardB.length === 1 && cardB[0].state === 'open' && JSON.stringify(cardB[0].from.actions) === '["stopRun","keepWaiting"]', 'its one stalled card opens at the settings change')
  await settle()
  check(w.emitted.slice(emittedBefore).some((e) => e.teamId === w.teamId && e.scopes.includes('needs') && e.scopes.includes('agents')), 'the card goes out with needs and agents')
  check(noticesOf(cardB[0]).length === 1 && noticesOf(cardB[0])[0].body === M.mainTLang('es', 'teams.push.cardTeam'), 'and exactly one desktop notice')
  w.clock.advance(0)
  w.clock.advance(MIN)
  await settle()
  check(stalledOf(b.runId).length === 1 && noticesOf(cardB[0]).length === 1 && w.logs.filter((l) => l === `run ${b.runId} silence stalled`).length === 1, 'the watch judging it again opens no other card, no other notice')
  // Minutes that no longer reach its silence (here the silence turned off): the silence goes and its stalled card
  // with it, in one commit (a later line would not dismiss it: no silence is on show any more).
  const offBefore = w.emitted.length
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, agents: { silence: { enabled: false, quietMin: 5, stalledMin: 11 } } } }
  w.svc.setConfig(w.cfg)
  check(w.svc.runLive(b.runId).silence === undefined && stalledOf(b.runId).length === 1 && stalledOf(b.runId)[0].state === 'dismissed', 'silence off: the silence on show goes, and its stalled card with it')
  await settle()
  check(w.emitted.slice(offBefore).some((e) => e.teamId === w.teamId && e.scopes.includes('needs') && e.scopes.includes('agents')), 'the dismissal goes out with needs and agents')
  await w.req('stop', { runId: b.runId })
  await w.waitEnded(b.runId)
  check(stalledOf(b.runId)[0].state === 'dismissed', 'its card goes with the run')
  w.svc.dispose()
}

async function heartbeatSilenceChecks() {
  // The 2.7.0 runtime walkthrough (run r-8ad66ddf8c19, claude-heartbeat.jsonl): Claude prints a tool_progress heartbeat
  // every 30 s while a tool runs, also inside a command that never ends. A heartbeat carries no new content, so with
  // quietMin 1 and stalledMin 2 the run goes quiet then stalled from its last real line and opens its one stalled card,
  // while a run that streams real content every 30 s keeps no silence. The fake agent sends one line every 250 ms of
  // real time and the run's clock moves 30 s before each one (as in the real run).
  const w = await world('heartbeat', { agents: { silence: { enabled: true, quietMin: 1, stalledMin: 2 } } })
  const logLines = (runId) => {
    try {
      return fs.readFileSync(path.join(w.teamData(), 'runs', `${runId}.jsonl`), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('{"type":"snaos.'))
    } catch {
      return []
    }
  }
  const stalledOf = (runId) => w.rt().cards.filter((c) => c.from.kind === 'system' && c.from.why === 'stalled' && c.from.runId === runId)
  /** Each line of `from..to` of the fixture 30 s of the run's clock after the one before; the silence level after each. */
  const play = async (runId, from, count) => {
    const levels = []
    for (let k = 1; k <= count; k++) {
      w.clock.advance(30_000)
      await until(() => logLines(runId).length >= from + k, 10000, `line ${from + k} of ${runId}`)
      levels.push(w.svc.runLive(runId).silence?.level ?? null)
    }
    return levels
  }

  const HB = 'claude-heartbeat.jsonl'
  w.use({ steps: [{ fixture: HB, to: 3, rewriteSession: true }, { fixture: HB, from: 3, delayMs: 250, rewriteSession: true }, { hang: true }] })
  const a = await w.req('runNow', { agentId: 'dev' })
  check(a.ok, `a run (${JSON.stringify(a)})`)
  await w.waitState(a.runId, 'running')
  await until(() => logLines(a.runId).length >= 3, 10000, 'the tool_use and its task_started')
  const toolLine = w.svc.runLive(a.runId).lastLineAt
  check(typeof toolLine === 'number' && w.svc.silenceWatchCount === 1, 'watched from running, counting from its last real line (the task_started of its Bash)')
  const levels = await play(a.runId, 3, 6)
  check(logLines(a.runId).slice(3).every((l) => l.includes('"type":"tool_progress"') && l.includes('"heartbeat":true')), 'six tool_progress heartbeats read (and logged)')
  same(levels, [null, 'quiet', 'quiet', 'stalled', 'stalled', 'stalled'], 'heartbeats every 30 s keep no sign of life: quiet at 1 min, stalled at 2 min')
  check(w.svc.runLive(a.runId).lastLineAt === toolLine, 'the heartbeats never move its last line')
  same(w.svc.runLive(a.runId).silence, { level: 'stalled', since: toolLine }, 'stalled since the tool started')
  same((await w.req('roster')).agents.find((x) => x.id === 'dev').run?.silence, { level: 'stalled', since: toolLine }, 'the roster shows it')
  const card = stalledOf(a.runId)
  check(card.length === 1 && card[0].state === 'open' && JSON.stringify(card[0].from.actions) === '["stopRun","keepWaiting"]', 'its one stalled card, Frenar and Seguir esperando')
  w.clock.advance(5 * MIN)
  await settle()
  check(stalledOf(a.runId).length === 1, 'still one card')
  await w.req('stop', { runId: a.runId })
  await w.waitEnded(a.runId)
  check(stalledOf(a.runId)[0].state === 'dismissed', 'its card goes with the run')

  // Real content every 30 s (claude-tools.jsonl: tool uses, their results, a rate limit event, the text): no silence.
  const TOOLS = 'claude-tools.jsonl'
  w.use({ steps: [{ fixture: TOOLS, to: 1, rewriteSession: true }, { fixture: TOOLS, from: 1, to: 7, delayMs: 250, rewriteSession: true }, { hang: true }] })
  const b = await w.req('runNow', { agentId: 'dev' })
  await w.waitState(b.runId, 'running')
  await until(() => logLines(b.runId).length >= 1, 10000, 'its init line')
  const streamed = await play(b.runId, 1, 6)
  same(streamed, [null, null, null, null, null, null], 'a line of content every 30 s keeps no silence')
  check(w.svc.runLive(b.runId).lastLineAt === w.clock.now && w.svc.runLive(b.runId).silence === undefined && stalledOf(b.runId).length === 0, 'its last line moves with each one, no silence and no card')
  await w.req('stop', { runId: b.runId })
  await w.waitEnded(b.runId)
  w.svc.dispose()
}

async function displacedWakeChecks() {
  // A routine wake kept in the agent's one slot is never lost to a run-end policy re-wake of that agent: the policy
  // writes its mark, the routine gets its wake-slot retry for the same scheduled time, and its prompt runs once.
  const w = await world('displaced')
  fs.rmSync(path.join(teamDirOf(w), 'routines', `${M.DAILY_SUMMARY_ID}.md`))
  const cron = '0,30 * * * *'
  const prompt = 'Barré el tablero y contá lo que quedó.'
  routineFile(w, 'sweep', { cron, action: 'wake', role: 'lead', title: 'Barrido' }, prompt)
  await trustAgain(w)
  const lead = () => w.rt().agents.find((a) => a.roleKind === 'lead')
  const leadId = lead().id
  w.use('hang.json')
  const r0 = await w.req('runNow', { agentId: leadId })
  check(r0.ok, `the Lead runs (${JSON.stringify(r0)})`)
  await w.waitState(r0.runId, 'running')
  const due = M.nextCron(cron, w.clock.now)
  w.clock.to(due)
  check(lead().next?.reason === 'routine' && JSON.stringify(lead().next.refs) === '["routine:sweep"]' && lead().runId === r0.runId, 'the due time: the wake waits in the slot of the running Lead')

  // A console opens the run's session: it stops (sessionConflict) and the policy re-wakes the Lead over that wake.
  w.svc.onPaneStatus({ paneId: 'console-1', state: 'working', sessionId: w.active(r0.runId).sessionId, provider: 'claude' })
  await w.waitEnded(r0.runId)
  w.clock.advance(0)
  check(lead().next?.reason === 'interrupted' && !(lead().next.refs ?? []).includes('routine:sweep'), 'the policy re-wake (interrupted) took the slot')
  check(w.svc.routines.nextAt(w.teamId, 'sweep') === w.clock.now + M.ROUTINE_SLOT_RETRY_MS, 'the routine gets its wake-slot retry in 5 min')
  check(w.logs.includes(`routine ${w.teamId} sweep wake displaced on ${leadId} by interrupted: retry`), 'logged')

  // The retry while the re-wake still holds the slot (Por despachar, autonomy off): it waits again.
  w.clock.advance(M.ROUTINE_SLOT_RETRY_MS)
  check(lead().next?.reason === 'interrupted' && w.logs.includes(`routine ${w.teamId} sweep waits: every agent of ${lead().roleId} holds another wake`) && w.svc.routines.nextAt(w.teamId, 'sweep') === w.clock.now + M.ROUTINE_SLOT_RETRY_MS, 'a retry that finds the slot still taken waits again')

  // Despachar the re-wake: the slot frees, the next retry puts the routine's wake back for the same scheduled time.
  const item = w.rt().queue.find((q) => q.agentId === leadId && !(q.refs ?? []).includes('routine:sweep'))
  check(item && item.reason === 'interrupted', 'the re-wake waits in Por despachar')
  const go = await w.req('dispatch', { queueId: item.id, go: true })
  w.clock.advance(0)
  const r1 = w.rt().activeRuns.find((r) => r.agentId === leadId)
  check(go.ok && r1 && r1.trigger.reason === 'interrupted' && lead().next === undefined, 'the re-wake runs: the slot is free')
  await w.waitState(r1.id, 'running')
  w.clock.advance(M.ROUTINE_SLOT_RETRY_MS)
  same(lead().next, { agentId: leadId, mode: 'lead', reason: 'routine', since: w.clock.now, detail: prompt, refs: ['routine:sweep'] }, 'the retry puts the wake back')
  check(w.rt().routines.sweep.lastScheduledFor === due && w.svc.routines.nextAt(w.teamId, 'sweep') === M.nextCron(cron, w.clock.now), 'for the same scheduled time, then armed at the next due time')

  // The user stops that run (no re-wake): the routine's wake runs once, its prompt on stdin.
  await w.req('stop', { runId: r1.id })
  await w.waitEnded(r1.id)
  w.clock.advance(0)
  const ritem = w.rt().queue.find((q) => q.agentId === leadId && (q.refs ?? []).includes('routine:sweep'))
  check(lead().next?.reason === 'routine' && ritem && ritem.reason === 'routine', 'a user stop leaves the routine wake: its item in Por despachar')
  const stdinFile = path.join(w.dir, 'stdin-sweep.txt')
  w.use({ saveStdin: stdinFile, steps: [{ fixture: 'claude-simple.jsonl', rewriteSession: true }] })
  await w.req('dispatch', { queueId: ritem.id, go: true })
  w.clock.advance(0)
  const r2 = w.rt().activeRuns.find((r) => r.agentId === leadId)
  check(r2 && r2.trigger.reason === 'routine' && JSON.stringify(r2.trigger.refs) === '["routine:sweep"]' && w.rt().routines.sweep.lastRunId === r2.id, 'the routine run: its ref, its lastRunId')
  await w.waitEnded(r2.id)
  check(fs.readFileSync(stdinFile, 'utf8').includes(prompt), 'its prompt reaches the run')
  w.clock.advance(0)
  check(lead().next === undefined && !w.rt().queue.some((q) => (q.refs ?? []).includes('routine:sweep')) && !w.rt().activeRuns.some((r) => r.agentId === leadId), 'once: no wake and no item left')
  check(w.rt().routines.sweep.displacedFor === undefined, 'nothing owed once its retry landed')
  w.svc.dispose()
}

async function displacedSoonerChecks() {
  // A displacement whose retry would come after the routine's next key arms none: owed, and never logged as a retry.
  const w = await world('sooner')
  fs.rmSync(path.join(teamDirOf(w), 'routines', `${M.DAILY_SUMMARY_ID}.md`))
  const cron = '0,30 * * * *'
  routineFile(w, 'sweep', { cron, action: 'wake', role: 'lead' }, 'Barré el tablero.')
  await trustAgain(w)
  const lead = () => w.rt().agents.find((a) => a.roleKind === 'lead')
  const leadId = lead().id
  const due = M.nextCron(cron, w.clock.now)
  w.clock.to(due - MIN)
  w.use('hang.json')
  const r0 = await w.req('runNow', { agentId: leadId })
  check(r0.ok, `the Lead runs (${JSON.stringify(r0)})`)
  await w.waitState(r0.runId, 'running')
  w.clock.to(due)
  check(lead().next?.reason === 'routine' && lead().runId === r0.runId, 'the wake waits in the slot of the running Lead')
  const next = M.nextCron(cron, due)
  w.clock.to(next - 2 * MIN)
  w.svc.onPaneStatus({ paneId: 'console-1', state: 'working', sessionId: w.active(r0.runId).sessionId, provider: 'claude' })
  await w.waitEnded(r0.runId)
  w.clock.advance(0)
  check(lead().next?.reason === 'interrupted', 'the policy re-wake took the slot')
  check(w.logs.includes(`routine ${w.teamId} sweep wake displaced on ${leadId} by interrupted: owed, its next fire comes sooner`) && !w.logs.some((l) => l.startsWith(`routine ${w.teamId} sweep wake displaced`) && l.endsWith(': retry')), 'its next key 2 min away: no retry armed, and the log does not say retry')
  check(w.svc.routines.nextAt(w.teamId, 'sweep') === next && w.rt().routines.sweep.displacedFor === due, 'the key stays at its next due time; the wake is owed')
  w.clock.to(next)
  check(w.logs.includes(`routine ${w.teamId} sweep waits: every agent of ${lead().roleId} holds another wake`) && w.rt().routines.sweep.displacedFor === due, 'that fire finds the slot taken: it waits, still owed')
  w.svc.dispose()
}

async function displacedAtQuitChecks() {
  // A displaced wake is never lost at a quit or a crash: the commit (or the reaper) that writes over it persists its
  // scheduled time (displacedFor) and the catch-up of the next enable runs it once within 2 h; beyond, skipped and logged.
  const w = await world('owed')
  const id = M.DAILY_SUMMARY_ID
  const due = M.nextCron(M.DAILY_SUMMARY_CRON, w.clock.now)
  const leadOf = (x) => x.rt().agents.find((a) => a.roleKind === 'lead')
  const leadId = leadOf(w).id
  const later = (data, at, name) => world(name, { repo: w.repo, data, clock: manualClock(at), noTeam: true, teamId: w.teamId })
  w.clock.to(due - MIN)
  w.use('hang.json')
  const r0 = await w.req('runNow', { agentId: leadId })
  check(r0.ok, `the Lead runs (${JSON.stringify(r0)})`)
  await w.waitState(r0.runId, 'running')
  w.clock.to(due)
  check(leadOf(w).next?.reason === 'routine' && JSON.stringify(leadOf(w).next.refs) === `["routine:${id}"]` && leadOf(w).runId === r0.runId, 'the daily summary waits in the slot of the running Lead')
  // What the disk holds now is a crash's state: copied for a later life.
  w.svc.team(w.teamId).store.flushSync()
  const crashData = path.join(w.dir, 'data-crash')
  fs.cpSync(w.data, crashData, { recursive: true })
  const crashData2 = path.join(w.dir, 'data-crash-2')
  fs.cpSync(w.data, crashData2, { recursive: true })

  // The quit: the interrupt's re-wake of the Lead writes over the wake, displacedFor reaches state.json.
  w.svc.shutdownSync('quit')
  check(w.logs.includes(`routine ${w.teamId} ${id} wake displaced on ${leadId} by interrupted: retry`), 'shutdownSync: the displaced wake is logged with its retry')
  const disk = JSON.parse(fs.readFileSync(path.join(w.teamData(), 'state.json'), 'utf8'))
  check(disk.routines[id].displacedFor === due && disk.routines[id].lastScheduledFor === due && disk.agents.find((a) => a.id === leadId).next?.reason === 'interrupted', 'state.json: displacedFor is its scheduled time, the re-wake holds the slot')
  w.svc.dispose()
  const beyondData = path.join(w.dir, 'data-beyond')
  fs.cpSync(w.data, beyondData, { recursive: true })
  const badData = path.join(w.dir, 'data-bad')
  fs.cpSync(w.data, badData, { recursive: true })

  // Back within 2 h: the catch-up fires it once (the slot still taken: it waits), then the retry places it.
  const w2 = await later(w.data, due + 90 * MIN, 'owed-2')
  check(w2.logs.includes(`routine ${w2.teamId} ${id} waits: every agent of ${leadOf(w2).roleId} holds another wake`) && w2.svc.routines.nextAt(w2.teamId, id) === w2.clock.now + M.ROUTINE_SLOT_RETRY_MS, 'back in 90 min: the catch-up fires the owed wake (the slot is taken: it waits)')
  check(w2.rt().routines[id].displacedFor === due, 'still owed while it waits')
  w2.clock.advance(0)
  const item = w2.rt().queue.find((q) => q.agentId === leadId && q.reason === 'interrupted')
  check(item, 'the re-wake waits in Por despachar')
  check((await w2.req('dispatch', { queueId: item.id, go: false })).ok && leadOf(w2).next === undefined, 'Descartar the re-wake: the slot frees')
  w2.clock.advance(M.ROUTINE_SLOT_RETRY_MS)
  const prompt = w2.svc.trusted(w2.teamId).def.routines.find((r) => r.id === id).prompt
  same(leadOf(w2).next, { agentId: leadId, mode: 'lead', reason: 'routine', since: w2.clock.now, detail: prompt, refs: [`routine:${id}`] }, 'the retry places the wake')
  const st2 = w2.rt().routines[id]
  check(st2.displacedFor === undefined && st2.lastScheduledFor === due && w2.logs.filter((l) => l === `routine ${w2.teamId} ${id} fired: wake ${leadId}`).length === 1, 'once, for its scheduled time; nothing owed')
  // Every verdict lands an owed wake: a fire that finds its previous wake still waiting (coalesce) too.
  const owe = () => {
    const rt = w2.rt()
    w2.svc.commit(w2.teamId, { ok: true, rt: { ...rt, routines: { ...rt.routines, [id]: { ...rt.routines[id], displacedFor: due } } }, effects: [], result: undefined }, ['routines'])
  }
  owe()
  w2.clock.to(M.nextCron(M.DAILY_SUMMARY_CRON, w2.clock.now))
  check(w2.logs.includes(`routine ${w2.teamId} ${id} skipped: its previous fire still has a level`) && w2.rt().routines[id].displacedFor === undefined, 'the next due time while the wake waits: coalesced, nothing owed')
  // Its run is the wake running: a displacedFor still set then goes in the admission commit.
  owe()
  w2.clock.advance(0)
  const ritem = w2.rt().queue.find((q) => q.agentId === leadId && (q.refs ?? []).includes(`routine:${id}`))
  check(ritem && w2.rt().routines[id].displacedFor === due, 'its item in Por despachar, owed again')
  w2.use('claude-simple.json')
  check((await w2.req('dispatch', { queueId: ritem.id, go: true })).ok, 'Despachar the wake')
  w2.clock.advance(0)
  const run2 = w2.rt().activeRuns.find((r) => r.agentId === leadId)
  check(run2 && run2.trigger.reason === 'routine' && w2.rt().routines[id].lastRunId === run2.id && w2.rt().routines[id].displacedFor === undefined, 'the run of the wake: its lastRunId, nothing owed')
  await w2.waitEnded(run2.id)
  w2.svc.dispose()
  const w2b = await later(w.data, w2.clock.now + MIN, 'owed-2b')
  check(!w2b.logs.some((l) => l.startsWith(`routine ${w2b.teamId} ${id} `)), 'a next start fires nothing again')
  w2b.svc.dispose()

  // Back more than 2 h after it: skipped and logged like any missed fire, nothing owed, no wake.
  const w3 = await later(beyondData, due + 3 * HOUR, 'owed-3')
  check(w3.logs.some((l) => l.startsWith(`routine ${w3.teamId} ${id} skipped: due ${new Date(due).toISOString()}`) && l.includes('missed by 180 min')), 'back in 3 h: skipped and logged')
  const st3 = w3.rt().routines[id]
  check(st3.skippedFor === due && st3.displacedFor === undefined && !(leadOf(w3).next?.refs ?? []).includes(`routine:${id}`) && w3.svc.routines.nextAt(w3.teamId, id) === M.nextCron(M.DAILY_SUMMARY_CRON, w3.clock.now), 'skippedFor recorded, nothing owed, no wake, armed at its next due time')
  w3.svc.dispose()

  // A displacedFor that is not a time is repaired at load (the store's schema), never kept.
  const badState = path.join(badData, 'teams', w.teamId, 'state.json')
  const bad = JSON.parse(fs.readFileSync(badState, 'utf8'))
  bad.routines[id].displacedFor = 'soon'
  fs.writeFileSync(badState, JSON.stringify(bad))
  const w5 = await later(badData, due + 30 * MIN, 'owed-5')
  check(w5.logs.some((l) => l.startsWith(`store ${w5.teamId} repaired`) && l.includes(`routines.${id}`)), 'a bad displacedFor: the routine state is repaired')
  w5.svc.dispose()

  // The crash: the reaper's re-wake of the Lead writes over the wake at load; the catch-up of that enable owes it.
  const w4 = await later(crashData, due + 90 * MIN, 'owed-4')
  check(w4.logs.includes(`routine ${w4.teamId} ${id} wake displaced on ${leadId} by interrupted at load: owed to the catch-up`), 'a crash: the reaper logs the displaced wake as owed')
  check(w4.rt().routines[id].displacedFor === due && w4.logs.includes(`routine ${w4.teamId} ${id} waits: every agent of ${leadOf(w4).roleId} holds another wake`) && w4.svc.routines.nextAt(w4.teamId, id) === w4.clock.now + M.ROUTINE_SLOT_RETRY_MS, 'the catch-up fires it (the slot is taken: it waits, still owed)')
  // The slot still taken 2 h past its due time: skipped, nothing owed.
  w4.clock.advance(30 * MIN)
  check(w4.logs.includes(`routine ${w4.teamId} ${id} skipped: every agent of ${leadOf(w4).roleId} still holds another wake`) && w4.rt().routines[id].displacedFor === undefined, 'its slot taken past 2 h: skipped, nothing owed')
  w4.svc.dispose()
  // Its retry reached late (the PC asleep): judged like the catch-up, skipped, nothing owed.
  const w6 = await later(crashData2, due + 90 * MIN, 'owed-6')
  check(w6.rt().routines[id].displacedFor === due, 'owed again in a second crash life')
  w6.clock.advance(3 * HOUR)
  const st6 = w6.rt().routines[id]
  check(w6.logs.some((l) => l.startsWith(`routine ${w6.teamId} ${id} skipped: due ${new Date(due).toISOString()}`) && l.includes('missed by 270 min')) && st6.skippedFor === due && st6.displacedFor === undefined, 'a retry reached 3 h late: skipped, nothing owed')
  w6.svc.dispose()
}

async function changedDefinitionChecks() {
  // With the definition `changed`, routines stay armed from the trusted snapshot and their marks wait at gate G1
  // (no run, no Por despachar item) until the user trusts again.
  const w = await world('changed')
  fs.rmSync(path.join(teamDirOf(w), 'routines', `${M.DAILY_SUMMARY_ID}.md`))
  const cron = '0 * * * *'
  routineFile(w, 'watch', { cron, action: 'wake', role: 'dev' }, 'Mirá el CI y contá qué falla.')
  await trustAgain(w)
  same((await w.req('settings', { patch: { autoDispatch: true } })).ok, true, 'autonomy on')
  routineFile(w, 'fresh', { cron: '15 * * * *', action: 'wake', role: 'dev' }, 'Una rutina nueva.')
  await w.req('get')
  check(w.svc.team(w.teamId).trust === 'changed', 'a new routine file: the definition reads changed')
  const due = M.nextCron(cron, w.clock.now)
  check(w.svc.routines.nextAt(w.teamId, 'watch') === due && w.svc.routines.nextAt(w.teamId, 'fresh') === null, 'routines stay armed from the trusted snapshot; one only on disk arms nothing')
  w.use('hang.json')
  w.clock.to(due)
  w.clock.advance(0)
  const dev = () => w.rt().agents.find((a) => a.id === 'dev')
  check((dev().next?.refs ?? []).includes('routine:watch') && w.rt().routines.watch.lastScheduledFor === due, 'it fires on time: its wake mark')
  const waiting = (await w.req('roster')).agents.find((a) => a.id === 'dev').waiting
  check(w.rt().activeRuns.length === 0 && !w.rt().queue.some((q) => (q.refs ?? []).includes('routine:watch')) && waiting?.reason === 'untrusted', `its mark waits at G1: no run, no item, waiting untrusted (${JSON.stringify(waiting)})`)
  await trustAgain(w)
  w.clock.advance(0)
  const run = w.rt().activeRuns.find((r) => r.agentId === 'dev')
  check(run && run.trigger.reason === 'routine' && JSON.stringify(run.trigger.refs) === '["routine:watch"]' && w.rt().routines.watch.lastRunId === run.id, 'trusted again: its run starts (autonomy on)')
  check(w.svc.routines.nextAt(w.teamId, 'fresh') === M.nextCron('15 * * * *', w.clock.now), 'and the new routine is armed')
  await w.req('stop', { runId: run.id })
  await w.waitEnded(run.id)
  w.svc.dispose()
}

async function main() {
  try {
    tickerChecks()
    catchUpChecks()
    reducerChecks()
    await routineServiceChecks()
    await dailySummaryChecks()
    await lateFireChecks()
    await codexLeadNoteChecks()
    await silenceChecks()
    await stalledNoticeChecks()
    await heartbeatSilenceChecks()
    await displacedWakeChecks()
    await displacedSoonerChecks()
    await displacedAtQuitChecks()
    await changedDefinitionChecks()
  } finally {
    for (const s of services) {
      try { s.dispose() } catch { /* already */ }
    }
    await settle()
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* a child may still hold a file on Windows */ }
  }
  console.log(`PASS: ${checks} teams routines checks (ticker, catch-up, reducers, routine fires and coalesce, Correr ahora, daily summary, team notes, restart catch-up, run silence, Labs off, stalled card notices, heartbeats are no sign of life, a displaced routine wake, one owed across a quit or a crash, a changed definition)`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
