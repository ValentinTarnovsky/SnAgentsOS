// Hibernation, agents board and cache timer suite (E5-FR-25..28): the pure
// planner (two ticks, lastInputAt, every exclusion, at most 3 per tick), the
// coordinator under a fake clock and interval with an explicit kill against a
// real AgentSessionStore in a temp dataDir (the end after the kill never
// closes the chat), the shared cache helpers, the board model, the sleeping
// navigation entries and the phone's cache start tracking with a skewed clock.
// No real pty, ~/.claude, CODEX_HOME or user data is touched.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const alias = { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'], alias, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, ...overrides })
  return mod.exports
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-hibernation-'))
const MIN = 60_000
const UUID = '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab'

const H = load('src/main/agents/Hibernation.ts')
const S = load('src/shared/hibernation.ts')

/** A console that passes every rule at `now` with idle 5 (done 10 min, input 20 min ago). */
function cand(id, patch = {}, now = 100 * MIN) {
  return { paneId: id, provider: 'claude', state: 'done', stateSince: now - 10 * MIN, lastInputAt: now - 20 * MIN, live: true, visible: false, subscribed: false, schedulePending: false, ...patch }
}

function testPlanner() {
  const now = 100 * MIN
  const plan = (candidates, previous = new Map(), extra = {}) => H.planHibernation({ candidates, idleMinutes: 5, now, previous, isAvailable: () => true, ...extra })
  let r = plan([cand('a')])
  check(r.sleep.length === 0 && r.next.get('a') === `done:${now - 10 * MIN}:${now - 20 * MIN}`, 'first tick: eligible but not confirmed, signature state:stateSince:lastInputAt recorded')
  r = plan([cand('a')], r.next)
  check(r.sleep.join() === 'a', 'second identical tick: the console goes to sleep (2 ticks)')
  check(H.planHibernation({ candidates: [cand('a')], idleMinutes: 0, now, previous: new Map([['a', H.hibernationSignature(cand('a'))]]), isAvailable: () => true }).sleep.length === 0, 'idleMinutes 0: nothing sleeps')
  check(H.planHibernation({ candidates: [cand('a')], idleMinutes: 3, now, previous: new Map([['a', H.hibernationSignature(cand('a'))]]), isAvailable: () => true }).sleep.length === 0, 'an out-of-range minutes value (3) counts as off')
  // lastInputAt: recent input, or input between ticks, keeps it awake.
  const typed = cand('a', { lastInputAt: now - 2 * MIN })
  check(!H.isEligible(typed, 5, now), 'input 2 min ago with N=5: not eligible (a half-typed prompt never sleeps)')
  const r1 = plan([cand('a')])
  const r2 = plan([cand('a', { lastInputAt: now - 6 * MIN })], r1.next)
  check(r2.sleep.length === 0 && r2.next.has('a'), 'an input between ticks changes the signature: the two-tick count restarts')
  const r3 = plan([cand('a', { stateSince: now - 7 * MIN })], r1.next)
  check(r3.sleep.length === 0, 'a new state start between ticks restarts the count')
  check(H.isEligible(cand('a', { lastInputAt: undefined }), 5, now), 'no input ever counts as idle')
  // Exclusions.
  const excluded = {
    visible: cand('x', { visible: true }),
    subscribed: cand('x', { subscribed: true }),
    schedule: cand('x', { schedulePending: true }),
    working: cand('x', { state: 'working' }),
    action: cand('x', { state: 'action' }),
    error: cand('x', { state: 'error' }),
    unknown: cand('x', { state: 'unknown' }),
    shell: cand('x', { provider: undefined }),
    noPty: cand('x', { live: false }),
    recent: cand('x', { stateSince: now - 4 * MIN }),
    noSince: cand('x', { stateSince: undefined }),
    needs: cand('x', { needs: true }),
  }
  for (const [name, c] of Object.entries(excluded)) check(!H.isEligible(c, 5, now), `excluded: ${name}`)
  check(H.isEligible(cand('x', { state: 'idle', provider: 'codex' }), 5, now), 'Codex idle is eligible too')
  let asked = []
  const avail = (id) => { asked.push(id); return id !== 'gone' }
  const prev = new Map(['a', 'gone', 'v'].map((id) => [id, H.hibernationSignature(cand(id))]))
  r = H.planHibernation({ candidates: [cand('a'), cand('gone'), cand('v', { visible: true })], idleMinutes: 5, now, previous: prev, isAvailable: avail })
  check(r.sleep.join() === 'a', 'a record that is not available === true never sleeps')
  check(asked.join() === 'a,gone', 'availability is asked last, only for consoles that passed the other rules')
  // Max 3 per tick, oldest idle first; the rest go on the next tick.
  const five = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => cand(id, { stateSince: now - (20 - i) * MIN }))
  const t1 = plan(five)
  const t2 = plan(five, t1.next)
  check(t2.sleep.join() === 'p1,p2,p3', 'at most 3 per tick, the longest idle first')
  const rest = five.filter((c) => !t2.sleep.includes(c.paneId))
  const t3 = plan(rest, t2.next)
  check(t3.sleep.join() === 'p4,p5', 'the remaining ones sleep on the next tick')
  // schedulePending
  check(!H.schedulePending(undefined, now, 5 * MIN) && !H.schedulePending({ time: '10:00', prompt: 'x', dueAt: now + MIN, enabled: false }, now, 5 * MIN), 'no schedule, or a paused one, does not keep it awake')
  check(H.schedulePending({ time: '10:00', prompt: 'x', dueAt: now + 4 * MIN }, now, 5 * MIN) && H.schedulePending({ time: '10:00', prompt: 'x', dueAt: now - MIN }, now, 5 * MIN), 'a schedule due within the idle window (or overdue) keeps it awake')
  check(H.schedulePending({ time: '10:00', prompt: 'x', dueAt: now + 60 * MIN, waitingSince: now - MIN }, now, 5 * MIN), 'a run waiting for the agent keeps it awake')
  check(!H.schedulePending({ time: '10:00', prompt: 'x', dueAt: now + 60 * MIN }, now, 5 * MIN), 'a schedule an hour away does not')
  // schedulesOf (schema 19): every schedule of every console, from the persisted config.
  const many = H.schedulesOf({ workspaces: [{ id: 'w', panes: [{ id: 'p', schedules: [{ id: 's1', dueAt: 1 }, { id: 's2', dueAt: 2 }] }, { id: 'q', schedules: [] }, { id: 'r' }, { id: 'old', schedule: { dueAt: 3 } }] }, { id: 'x', panes: 'junk' }] })
  check(many.size === 1 && many.get('p').map((s) => s.id).join() === 's1,s2', 'schedulesOf lists both schedules of a console; none, an empty list or a stale single schedule (never a parsed shape) count nothing')
  check(H.schedulesOf(null).size === 0, 'no config, no schedules')
}

function testShared() {
  check(S.normalizeIdleMinutes(0) === 0 && S.normalizeIdleMinutes(5) === 5 && S.normalizeIdleMinutes(1440) === 1440, 'normalizeIdleMinutes keeps 0 and 5..1440')
  check(S.normalizeIdleMinutes(4) === 0 && S.normalizeIdleMinutes(1441) === 0 && S.normalizeIdleMinutes(30.5) === 0 && S.normalizeIdleMinutes('30') === 0 && S.normalizeIdleMinutes(null) === 0, 'anything else is off')
  check(S.HIBERNATE_SUGGESTED_MINUTES === 30 && S.HIBERNATE_TICK_MS === 60000 && S.HIBERNATE_MAX_PER_TICK === 3 && S.SCHEDULE_WAKE_LEAD_MS === 30000, 'constants: proposes 30, ticks every 60 s, 3 per tick, wakes 30 s before a schedule')
  check(S.formatCountdown(252000) === '4:12' && S.formatCountdown(59001) === '1:00' && S.formatCountdown(59000) === '0:59' && S.formatCountdown(500) === '0:01' && S.formatCountdown(0) === '0:00' && S.formatCountdown(-5) === '0:00', 'formatCountdown: m:ss rounded up, never negative')
  check(S.formatCountdown(3600000) === '60:00', 'the 60 min TTL starts at 60:00')
  check(S.cacheDeadline(1000, 5) === 1000 + 5 * MIN && S.cacheDeadline(1000, 60) === 1000 + 60 * MIN && S.cacheDeadline(undefined, 5) === null && S.cacheDeadline(0, 5) === null, 'cacheDeadline: since + TTL, null without a transition')
  check(S.cacheApplies({ state: 'done', provider: 'claude' }) && S.cacheApplies({ state: 'idle', provider: 'claude' }), 'the cache applies to Claude between turns')
  check(!S.cacheApplies({ state: 'working', provider: 'claude' }) && !S.cacheApplies({ state: 'done', provider: 'codex' }) && !S.cacheApplies({ state: 'done' }) && !S.cacheApplies(null), 'not while working, not for Codex or without a provider')
  check(S.CACHE_WARN_MS === 60000, 'amber in the last minute')
}

function testCoordinator() {
  const dir = fs.mkdtempSync(path.join(tmp, 'coord-'))
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'))
  const { AgentSessionStore } = load('src/main/agents/AgentSessionStore.ts')
  let clock = 1_000 * MIN
  const changed = []
  const store = new AgentSessionStore({
    file: path.join(dir, 'agent-sessions.json'),
    getConfig: () => cfg,
    spawnCwd: () => cwd,
    codexIndex: { has: () => true, refresh() {} },
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
    onChanged: (e) => changed.push(e),
  })
  // Schema 19: console s holds two schedules; only the second one is close.
  let cfg = { workspaces: [{ id: 'w', panes: [{ id: 'a', type: 'codex' }, { id: 'b', type: 'codex' }, { id: 's', type: 'codex', schedules: [{ id: 's1', time: '10:00', prompt: 'x', dueAt: clock + 600 * MIN }, { id: 's2', time: '10:00', prompt: 'x', dueAt: clock + 2 * MIN }] }] }] }
  store.load()
  for (const id of ['a', 'b', 's']) {
    store.onStatus({ paneId: id, state: 'idle', precise: true, notify: false, provider: 'codex', sessionId: UUID.replace('0b7c', id === 'a' ? '1b7c' : id === 'b' ? '2b7c' : '3b7c') }, { kind: 'start', provider: 'codex', sessionId: UUID.replace('0b7c', id === 'a' ? '1b7c' : id === 'b' ? '2b7c' : '3b7c'), paneId: id })
  }
  check(store.isAvailable('a') && store.isAvailable('b'), 'records with an existing cwd and a rollout are available')
  const statuses = new Map(['a', 'b', 's'].map((id) => [id, { paneId: id, state: 'idle', precise: true, notify: false, provider: 'codex', stateSince: clock - 30 * MIN }]))
  const ptys = new Set(['a', 'b', 's'])
  const killed = []
  const seq = []
  let configReads = 0
  let intervals = new Map(), nextId = 0
  const coord = new H.HibernationCoordinator({
    statuses: () => [...statuses.values()],
    lastInputAt: () => undefined,
    hasPty: (id) => ptys.has(id),
    subscribedPaneIds: () => new Set(subscribed),
    isAvailable: (id) => store.isAvailable(id),
    getConfig: () => { configReads++; return cfg },
    hibernate: (evt) => {
      // index.ts order: mark the record, tell the renderer, kill explicitly (D3).
      store.markHibernated(evt.paneId); seq.push(['mark', evt.paneId])
      seq.push(['send', evt.paneId, evt.idleMinutes, evt.at])
      ptys.delete(evt.paneId); killed.push(evt.paneId); seq.push(['kill', evt.paneId])
      // The kill makes the agent report an end; the store must not close the chat.
      store.onStatus({ paneId: evt.paneId, state: 'unknown', precise: true, notify: false, provider: 'codex' }, { kind: 'end', provider: 'codex', paneId: evt.paneId, sessionId: store.list().find((v) => v.paneId === evt.paneId).sessionId })
      statuses.delete(evt.paneId)
    },
    now: () => clock,
    setInterval: (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, ms }); return id },
    clearInterval: (id) => intervals.delete(id),
  })
  let subscribed = []
  check(!coord.running && intervals.size === 0, 'off by default: no interval')
  check(coord.tick().length === 0, 'before the renderer pushed its view nothing sleeps')
  coord.setConfig({ idleMinutes: 0, keep: [] })
  check(!coord.running, 'idleMinutes 0: the interval does not run')
  coord.setConfig({ idleMinutes: 5, keep: ['b'] })
  check(coord.running && intervals.size === 1 && [...intervals.values()][0].ms === 60000, 'idleMinutes 5: one 60 s interval')
  subscribed = []
  const reads0 = configReads
  check(coord.tick().length === 0, 'tick 1: nothing yet (two ticks to confirm)')
  check(configReads === reads0 + 1, 'the config (schedules) is read once per tick, only with candidates')
  clock += MIN
  const slept = coord.tick()
  check(slept.join() === 'a', 'tick 2: the hidden idle console sleeps; the visible one (keep) and the one with a schedule in 2 min (its second one, app 2.7.0) do not')
  check(seq.map((s) => s[0]).join() === 'mark,send,kill' && seq[1][2] === 5 && seq[1][3] === clock, 'explicit order: hibernatedAt first, then the renderer event { paneId, at, idleMinutes }, then the kill')
  const viewA = store.list().find((v) => v.paneId === 'a')
  check(viewA && viewA.hibernatedAt === clock && viewA.endedAt === undefined, 'the end that follows the kill never marks endedAt: the chat stays resumable')
  // A phone subscription keeps a console awake; a reconnecting phone (re-sub) does not wake anything here.
  coord.setConfig({ idleMinutes: 5, keep: [] })
  subscribed = ['b']
  clock += MIN; coord.tick(); clock += MIN
  check(coord.tick().length === 0, 'a console a phone is subscribed to never sleeps')
  subscribed = []
  clock += MIN; coord.tick()
  check(killed.join() === 'a', 'the first tick after the phone leaves only starts the count')
  clock += MIN; coord.tick()
  check(killed.join() === 'a,b', 'once the phone leaves, two ticks later it sleeps')
  // The renderer reloads: no plan until it pushes again.
  coord.rendererGone()
  check(!coord.running && intervals.size === 0 && coord.tick().length === 0, 'renderer gone: interval stopped and no tick acts')
  coord.setConfig({ idleMinutes: 5, keep: [] })
  check(coord.running, 'the next push starts it again')
  coord.setConfig({ idleMinutes: 0, keep: [] })
  check(!coord.running && intervals.size === 0, 'turning it off clears the interval')
  coord.setConfig(null); coord.setConfig({ idleMinutes: 'x', keep: 'nope' })
  check(!coord.running && coord.minutes === 0, 'a malformed push is ignored or turns it off')
  // The resumed session's start clears hibernatedAt.
  store.onStatus({ paneId: 'a', state: 'idle', precise: true, notify: false, provider: 'codex', sessionId: viewA.sessionId }, { kind: 'start', provider: 'codex', sessionId: viewA.sessionId, paneId: 'a' })
  check(store.list().find((v) => v.paneId === 'a').hibernatedAt === undefined, 'a session start after the wake clears hibernatedAt')
  store.snapshotExitOnce('quit')
  check(!store.isAvailable('b'), 'a frozen store (exiting) never offers a console to hibernation')
}

/**
 * App 2.7.0 (A3): a console with an open `snaos needs` never sleeps, muted or
 * not. The minimal idle status StatusManager publishes for a live pane with
 * no track (an idle Claude console with an old stateSince) carries it, and
 * once cleared that status is gone, so it never makes the pane a candidate.
 */
function testNeeds() {
  let clock = 1_000 * MIN
  class FakeDate extends Date { static now() { return clock } }
  const { StatusManager } = load('src/main/status/StatusManager.ts', {
    require: (id) => (id === 'electron' ? { Notification: { isSupported: () => false } } : require(id)),
    Date: FakeDate, setTimeout: () => 0, clearTimeout: () => {},
  })
  const cfg = { workspaces: [{ id: 'w', name: 'W', panes: [{ id: 'bare', type: 'claude', title: 'B' }, { id: 'done', type: 'codex', title: 'D' }] }] }
  const status = new StatusManager(() => null, () => cfg, () => {})
  status.onSpawn('pty-b', 'bare'); status.onSpawn('pty-d', 'done')
  const codex = (kind) => status.onAgentEvent({ paneId: 'done', ptyId: 'pty-d', provider: 'codex', sessionId: UUID, kind })
  codex('start'); codex('working'); codex('done')
  check(status.setNeeds('bare', 'Revisá el diff') && status.setNeeds('done', 'Aprobá el deploy') && status.setMuted('done', true), 'needs on a pane with no track and on a done Codex console (muted)')
  const bare = status.stateOf('bare')
  check(bare.state === 'idle' && bare.provider === 'claude' && bare.stateSince === clock && bare.needs.text === 'Revisá el diff', 'the bare needs status is an idle Claude console')
  check(status.stateOf('done').muted === true && status.stateOf('done').needs.text === 'Aprobá el deploy', 'muted keeps needs on the status')
  const slept = []
  const coord = new H.HibernationCoordinator({
    statuses: () => status.snapshot(),
    lastInputAt: () => undefined,
    hasPty: () => true,
    subscribedPaneIds: () => new Set(),
    isAvailable: () => true,
    getConfig: () => cfg,
    hibernate: (evt) => slept.push(evt.paneId),
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
  })
  coord.setConfig({ idleMinutes: 5, keep: [] })
  clock += 30 * MIN
  const asCandidate = (s) => ({ paneId: s.paneId, provider: s.provider, state: s.state, stateSince: s.stateSince, live: true, visible: false, subscribed: false, schedulePending: false })
  check(H.isEligible(asCandidate(status.stateOf('bare')), 5, clock) && H.isEligible(asCandidate(status.stateOf('done')), 5, clock), 'without its needs both statuses would pass every other rule')
  coord.tick(); clock += MIN; coord.tick(); clock += MIN; coord.tick()
  check(slept.length === 0, 'with needs open neither sleeps (the bare status and the muted done console)')
  status.setNeeds('bare', null); status.setNeeds('done', null)
  check(status.stateOf('bare') === null && !status.snapshot().some((s) => s.paneId === 'bare'), 'clearing the bare needs drops its status: no candidate at all')
  coord.tick(); clock += MIN; coord.tick()
  check(slept.join() === 'done', 'answered: the done console sleeps two ticks later, the pane with no track never')
  status.dispose()
}

function testBoardAndNav() {
  const code = buildSync({ stdin: { contents: `
export * from './agentsBoard'
export * from './agentNav'
`, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console })
  const B = mod.exports
  const now = 1_000 * MIN
  const pane = (id) => ({ id, type: 'claude', title: 'T ' + id, color: '#fff', icon: 'claude' })
  const ws = { id: 'w', name: 'W', cwd: 'C:/w', panes: ['a', 'b', 'c', 'd', 'e', 'f', 'z'].map(pane), layout: { grid: 7, order: ['a', 'b', 'c', 'd', 'e', 'f', 'z'] } }
  const st = (state, ago) => ({ state, precise: true, provider: 'claude', stateSince: now - ago * MIN })
  const input = {
    workspaces: [ws],
    paneStatus: { a: st('action', 3), b: st('working', 1), c: st('done', 2), d: st('idle', 9), e: st('error', 1), f: st('done', 5) },
    paneAttention: { f: true },
    mountedWorkspaces: { w: 'full' },
    sessions: {},
    presets: [],
    policy: 'ask',
    sleeping: { z: { at: now - 120 * MIN } },
  }
  const entries = B.allAgents(input)
  const z = entries.find((e) => e.id === 'z')
  check(z && z.sleeping === true && z.rank === 4 && z.stateSince === now - 120 * MIN, 'a sleeping console is an entry of rank 4 with its sleep time')
  const t = (key, vars) => key + (vars ? JSON.stringify(vars) : '')
  check(B.agentPhrase(z, t, 'es', now) === 'agents.row.sleeping · 2h' && B.agentPhrase(z, t, 'es', now, false) === 'agents.row.sleeping', 'its row phrase: "Durmiendo · 2h" (no age when asked)')
  check(B.waitingIds({ ...input, paneAttention: { ...input.paneAttention, z: true } }).every((id) => id !== 'z'), 'a sleeping console never counts as waiting (not even with a local mark)')
  const cols = B.boardColumns(entries)
  check(cols.waiting.map((e) => e.id).join() === 'a,e' || cols.waiting.map((e) => e.id).join() === 'e,a', 'waiting on you: action and error')
  check(cols.waiting.map((e) => e.id).join() === 'a,e', 'waiting column: longest waiting first')
  check(cols.working.map((e) => e.id).join() === 'b', 'working column')
  check(cols.done.map((e) => e.id).join() === 'f,c', 'done column: unread first')
  check(cols.idle.map((e) => e.id).join() === 'd,z', 'idle column: idle and sleeping, most recent first')
  const nav = B.navigableColumns(cols, false)
  check(nav[3].length === 0 && B.navigableColumns(cols, true)[3].length === 2, 'the idle column is skipped by the keys until expanded')
  check(B.firstCard(nav) === 'a' && B.moveSelection(nav, null, 'ArrowDown') === 'a', 'no selection: the first card')
  check(B.moveSelection(nav, 'a', 'ArrowDown') === 'e' && B.moveSelection(nav, 'e', 'ArrowDown') === 'e' && B.moveSelection(nav, 'e', 'ArrowUp') === 'a', 'up/down walk a column, clamped')
  check(B.moveSelection(nav, 'e', 'ArrowRight') === 'b' && B.moveSelection(nav, 'b', 'ArrowRight') === 'f' && B.moveSelection(nav, 'f', 'ArrowRight') === 'f', 'right moves to the next column with cards (clamped row), stops at the last')
  check(B.moveSelection(nav, 'c', 'ArrowLeft') === 'b' && B.moveSelection(nav, 'a', 'ArrowLeft') === 'a', 'left moves back, stops at the first')
  const sparse = [['x'], [], ['y1', 'y2']]
  check(B.moveSelection(sparse, 'x', 'ArrowRight') === 'y1' && B.moveSelection(sparse, 'y2', 'ArrowLeft') === 'x', 'empty columns are skipped')
}

function testMobileTrack() {
  let store = new Map()
  const fakeStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: () => null, length: 0 }
  const M = load('src/mobile/src/lib/cacheTrack.ts', { localStorage: fakeStorage })
  check(M.CACHE_TIMER_KEY === 'snagentsos.cacheTimer', 'the phone stores its prefs in snagentsos.cacheTimer')
  check(JSON.stringify(M.loadCachePrefs()) === '{"enabled":false,"ttlMinutes":5}', 'default: off, 5 min')
  check(M.saveCachePrefs({ enabled: true, ttlMinutes: 60 }) && JSON.stringify(M.loadCachePrefs()) === '{"enabled":true,"ttlMinutes":60}', 'prefs round trip')
  store.set('snagentsos.cacheTimer', '{not json')
  check(JSON.stringify(M.loadCachePrefs()) === '{"enabled":false,"ttlMinutes":5}', 'malformed prefs fall back to the defaults')
  const throwing = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() {}, key: () => null, length: 0 }
  const M2 = load('src/mobile/src/lib/cacheTrack.ts', { localStorage: throwing })
  check(JSON.stringify(M2.loadCachePrefs()) === '{"enabled":false,"ttlMinutes":5}' && M2.saveCachePrefs({ enabled: true, ttlMinutes: 5 }) === false, 'blocked storage never throws')

  const phoneNow = 10_000_000
  const desktopNow = phoneNow + 2 * MIN // the desktop clock runs 2 min ahead
  const claude = (state, since) => ({ state, provider: 'claude', stateSince: since })
  // Live delta: working -> done stamps the phone's own reception time.
  let starts = M.trackCacheStarts({}, { p: claude('working', desktopNow - MIN) }, { p: claude('done', desktopNow) }, 'delta', phoneNow)
  check(starts.p && starts.p.start === phoneNow, 'a live working -> done stamps the phone clock (desktop skew ignored)')
  const desktopDeadline = desktopNow + 5 * MIN
  const phoneDeadline = M.cacheEnd(starts.p, { enabled: true, ttlMinutes: 5 })
  check(phoneDeadline - phoneNow === desktopDeadline - desktopNow, 'with a 2 min skew the phone counts the same time left as the desktop')
  check(M.cacheEnd(starts.p, { enabled: false, ttlMinutes: 5 }) === null && M.cacheEnd(undefined, { enabled: true, ttlMinutes: 5 }) === null, 'switched off (or no start): no deadline')
  starts = M.trackCacheStarts(starts, { p: claude('done', desktopNow) }, { p: claude('idle', desktopNow + 5000) }, 'delta', phoneNow + 5000)
  check(starts.p.start === phoneNow, 'done -> idle keeps the start')
  const working = M.trackCacheStarts(starts, { p: claude('idle', desktopNow + 5000) }, { p: claude('working', desktopNow + 9000) }, 'delta', phoneNow + 9000)
  check(!working.p, 'a new prompt (working) removes it')
  check(!M.trackCacheStarts(starts, { p: claude('idle', 1) }, {}, 'delta', phoneNow).p, 'a cleared status removes it')
  check(!M.trackCacheStarts({}, { q: { state: 'working', provider: 'codex', stateSince: 1 } }, { q: { state: 'done', provider: 'codex', stateSince: 2 } }, 'delta', phoneNow).q, 'Codex never gets a cache chip')
  // Snapshot only (authOk / state): a done pane starts at stateSince; an idle one without history has none.
  const snap = M.trackCacheStarts({}, {}, { p: claude('done', desktopNow - MIN), i: claude('idle', desktopNow - MIN) }, 'snapshot', phoneNow)
  check(snap.p.start === desktopNow - MIN && !snap.i, 'snapshot: done starts at its stateSince (skew accepted), idle without a seen transition has no chip')
  const kept = M.trackCacheStarts({ p: { start: phoneNow - 30000, since: desktopNow - MIN } }, {}, { p: claude('done', desktopNow - MIN) }, 'snapshot', phoneNow)
  check(kept.p.start === phoneNow - 30000, 'a reconnect snapshot keeps a live-stamped start for the same turn')
  const again = M.trackCacheStarts({ p: { start: phoneNow - 30000, since: desktopNow - 9 * MIN } }, {}, { p: claude('done', desktopNow - MIN) }, 'snapshot', phoneNow)
  check(again.p.start === desktopNow - MIN, 'a snapshot with a newer done (a turn ended while away) restamps from stateSince')
  const snapAfterWork = M.trackCacheStarts({}, { p: claude('working', 1) }, { p: claude('done', desktopNow - MIN) }, 'snapshot', phoneNow)
  check(snapAfterWork.p.start === desktopNow - MIN, 'a working -> done seen only through a snapshot uses stateSince, not the reception time')
}

function testKeymapAndI18n() {
  const km = load('src/renderer/lib/keymap.ts')
  const keymap = km.resolveKeymap({})
  check(keymap.agentsBoard === 'Ctrl+Shift+A', 'agentsBoard defaults to Ctrl+Shift+A (D8 amendment)')
  // An action with no default ('') cannot collide: only real chords are compared.
  const accels = Object.values(keymap).filter(Boolean)
  check(new Set(accels).size === accels.length, 'no default accelerator is shared')
  const { en } = load('src/renderer/i18n/en.ts')
  const { es } = load('src/renderer/i18n/es.ts')
  const keys = ['keys.agentsBoard', 'agents.row.sleeping', 'agents.sleep.title', 'agents.sleep.since', 'agents.sleep.resume', 'agents.cache.label', 'agents.board.toggle', 'agents.board.title', 'agents.board.count', 'agents.board.close', 'agents.board.waiting', 'agents.board.working', 'agents.board.done', 'agents.board.idle', 'agents.board.empty', 'agents.board.cache', 'settings.agents.hibernate', 'settings.agents.hibernateHint', 'settings.agents.hibernateMinutes', 'settings.agents.hibernateMinutesHint', 'settings.agents.cacheTimer', 'settings.agents.cacheTimerHint', 'settings.agents.cacheTtl', 'settings.agents.cacheTtlHint', 'settings.agents.cacheTtlMin']
  check(keys.every((k) => typeof en[k] === 'string' && typeof es[k] === 'string' && en[k] && es[k]), 'every new desktop string exists in es and en')
  check(es['agents.sleep.title'] === 'Durmiendo · el chat está guardado' && es['agents.sleep.resume'] === 'Retomar' && es['agents.board.waiting'] === 'Te esperan', 'Spanish copy follows the PRD')
  const mi = load('src/mobile/src/lib/i18n.ts')
  const mkeys = ['cache.title', 'cache.toggle', 'cache.toggleHint', 'cache.ttl', 'cache.ttlMin', 'cache.label']
  mi.setLang('en')
  const enOk = mkeys.every((k) => mi.t(k) && mi.t(k) !== k)
  mi.setLang('es')
  const esOk = mkeys.every((k) => mi.t(k) && mi.t(k) !== k)
  check(enOk && esOk && mi.t('cache.label', { time: '4:12' }) === 'La caché de Claude vence en 4:12', 'every new phone string exists in es and en')
}

testPlanner()
testShared()
testCoordinator()
testNeeds()
testBoardAndNav()
testMobileTrack()
testKeymapAndI18n()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`PASS: ${checks} hibernation checks (planner 2 ticks, lastInputAt, exclusions, 3 per tick, schedules, coordinator interval and explicit kill on a real session store, needs never sleeps, cache helpers, board columns and keys, sleeping entries, phone cache tracking with clock skew, keymap, i18n)`)
