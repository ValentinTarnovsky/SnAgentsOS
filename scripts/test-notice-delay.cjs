// Delay of the remote notices (app 2.8.0): noticeDelay (delay 0 sends at once, a notice waits remoteDelaySec and
// goes out at its deadline, dropped when the pane moved on or was answered, at once when a device sees the console,
// while a phone has the app visible, waits again while the PC is in use, a newer notice of the same console replaces
// the older, team notices by tag, push: false at once, no timer while nothing waits, dispose), StatusManager's side
// (the notice's seq, noticeCurrent, the seen listener on every ackPane path) and the schema 20 keys
// (notifications.remoteDelaySec, sidebarBlocks).
// Same esbuild + vm harness as test-notice-coalesce.cjs: fake clock and timers, no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}

const T0 = 1_700_000_000_000
const S = 1000

/** A fake platform: a clock and timers that keep the clock time they are due at. */
function fakePlatform() {
  const p = { clock: T0, seq: 0, timers: new Map() }
  p.now = () => p.clock
  p.setTimeout = (fn, ms) => { p.timers.set(++p.seq, { fn, due: p.clock + ms }); return p.seq }
  p.clearTimeout = (id) => { p.timers.delete(id) }
  p.advance = (ms) => {
    const to = p.clock + ms
    for (;;) {
      const next = [...p.timers].filter(([, t]) => t.due <= to).sort(([, a], [, b]) => a.due - b.due)[0]
      if (!next) break
      p.timers.delete(next[0]); p.clock = Math.max(p.clock, next[1].due); next[1].fn()
    }
    p.clock = to
  }
  p.deps = () => ({ now: p.now, setTimeout: p.setTimeout, clearTimeout: p.clearTimeout })
  return p
}

const { createNoticeDelay } = load('src/main/status/noticeDelay.ts')

function rig(opts = {}) {
  const p = fakePlatform()
  const w = { p, routed: [], teams: [], delay: opts.delay ?? 120, current: new Map(), phone: false, lastInput: T0 - 3600 * S }
  w.delayer = createNoticeDelay({
    loadConfig: () => ({ settings: { notifications: { remoteDelaySec: w.delay } } }),
    route: (n) => w.routed.push(n),
    routeTeam: (n) => w.teams.push(n),
    isCurrent: (paneId, seq) => (w.current.has(paneId) ? w.current.get(paneId) === seq : false),
    isPhoneVisible: () => w.phone,
    idleSec: () => (w.idle === undefined ? Math.floor((p.clock - w.lastInput) / S) : w.idle),
    timers: p.deps(),
  })
  w.notice = (paneId, seq, state = 'action') => { w.current.set(paneId, seq); w.delayer.route({ paneId, provider: 'claude', state, seq }) }
  return w
}

function delayChecks() {
  {
    const w = rig({ delay: 0 })
    w.notice('p1', 1)
    check(w.routed.length === 1 && w.p.timers.size === 0 && w.delayer.pendingCount() === 0, 'delay 0: routed at once, no timer')
    w.delayer.routeTeam({ kind: 'team', teamId: 't', tag: 'team:t:r1', title: 'a', body: 'b', urgent: false, push: true })
    check(w.teams.length === 1, 'delay 0: a team notice routed at once')
  }
  {
    const w = rig()
    check(w.p.timers.size === 0, 'nothing waits: no timer')
    w.notice('p1', 1)
    check(w.routed.length === 0 && w.delayer.pendingCount() === 1 && w.p.timers.size === 1, 'a notice waits, one timer')
    w.p.advance(119 * S)
    check(w.routed.length === 0, 'not before the delay')
    w.p.advance(1 * S)
    check(w.routed.length === 1 && w.routed[0].paneId === 'p1' && w.p.timers.size === 0 && w.delayer.pendingCount() === 0, 'at the delay, still standing and the PC still: routed, no timer left')
  }
  {
    const w = rig()
    w.notice('p1', 1)
    w.current.set('p1', 2) // answered at the PC: the pane moved to another state
    w.p.advance(120 * S)
    check(w.routed.length === 0 && w.delayer.pendingCount() === 0 && w.p.timers.size === 0, 'the pane moved on: dropped')
  }
  {
    const w = rig()
    w.notice('p1', 1)
    w.current.delete('p1') // seen, answered or muted: no attention any more
    w.p.advance(120 * S)
    check(w.routed.length === 0, 'no longer asking for attention: dropped')
  }
  {
    const w = rig()
    w.notice('p1', 1); w.notice('p2', 1)
    w.p.advance(10 * S)
    w.delayer.seen('p1')
    check(w.delayer.pendingCount() === 1, 'a device saw p1: its notice goes at once')
    w.delayer.seen('p9')
    w.p.advance(110 * S)
    check(w.routed.length === 1 && w.routed[0].paneId === 'p2', 'p2 still goes out, p1 never')
  }
  {
    const w = rig()
    w.notice('p1', 1)
    w.phone = true
    w.p.advance(120 * S)
    check(w.routed.length === 0 && w.delayer.pendingCount() === 0, 'a phone has the app visible at the deadline: dropped')
  }
  {
    const w = rig()
    w.notice('p1', 1)
    w.lastInput = T0 + 100 * S // the PC was used during the wait
    w.p.advance(120 * S)
    check(w.routed.length === 0 && w.delayer.pendingCount() === 1 && w.p.timers.size === 1, 'the PC in use: waits again')
    w.p.advance(99 * S)
    check(w.routed.length === 0, 'not before the PC has been still for the whole delay')
    w.p.advance(1 * S)
    check(w.routed.length === 1, 'the PC still for the delay: routed')
  }
  {
    const w = rig()
    w.idle = undefined; w.notice('p1', 1)
    w.idle = NaN
    w.p.advance(120 * S)
    check(w.routed.length === 1, 'an unknown idle time sends')
  }
  {
    const w = rig()
    w.notice('p1', 1, 'done')
    w.p.advance(60 * S)
    w.notice('p1', 2, 'action')
    check(w.delayer.pendingCount() === 1, 'a newer notice of the same console replaces the older')
    w.p.advance(60 * S)
    check(w.routed.length === 0, 'and restarts the wait')
    w.p.advance(60 * S)
    check(w.routed.length === 1 && w.routed[0].state === 'action' && w.routed[0].seq === 2, 'only the newer goes out')
  }
  {
    const w = rig()
    const team = (tag, push = true) => ({ kind: 'team', teamId: 't', tag, title: 'a', body: 'b', urgent: true, push })
    w.delayer.routeTeam(team('team:t:r1', false))
    check(w.teams.length === 1 && w.delayer.pendingCount() === 0, 'a push: false team notice goes at once (the router drops it)')
    w.delayer.routeTeam(team('team:t:r2')); w.delayer.routeTeam(team('team:t:r3'))
    w.delayer.seen('t')
    check(w.delayer.pendingCount() === 2, 'team notices wait by tag; seeing a console never drops them')
    w.p.advance(120 * S)
    check(w.teams.length === 3, 'team notices routed at the deadline')
    w.delayer.routeTeam(team('team:t:r4')); w.phone = true
    w.p.advance(120 * S)
    check(w.teams.length === 3, 'a team notice dropped while a phone has the app visible')
  }
  {
    const w = rig()
    w.notice('p1', 1)
    w.delay = 0 // changed meanwhile: the notice keeps the wait it started with
    w.p.advance(120 * S)
    check(w.routed.length === 1, 'a notice keeps the delay it started with')
  }
  {
    const w = rig()
    w.notice('p1', 1); w.notice('p2', 1)
    w.delayer.dispose()
    check(w.delayer.pendingCount() === 0 && w.p.timers.size === 0, 'dispose: nothing waits, no timer')
    w.p.advance(200 * S)
    check(w.routed.length === 0, 'nothing goes out after dispose')
  }
  {
    const p = fakePlatform(), routed = []
    const d = createNoticeDelay({
      loadConfig: () => { throw new Error('x') },
      route: (n) => routed.push(n), routeTeam: () => {},
      isCurrent: () => true, isPhoneVisible: () => false, idleSec: () => 9999, timers: p.deps(),
    })
    d.route({ paneId: 'p1', provider: 'claude', state: 'action', seq: 1 })
    check(routed.length === 1, 'an unreadable config: no delay')
  }
  {
    const w = rig()
    w.delay = 99999; w.notice('p1', 1)
    w.p.advance(3600 * S)
    check(w.routed.length === 1, 'a delay past the max is clamped to one hour')
  }
}

// --- StatusManager: the notice's seq, noticeCurrent and the seen listener -----------------------

function statusChecks() {
  const { notificationSettingsSchema } = load('src/main/store/schema.ts')
  const notices = [], seen = []
  let focused = false, tid = 0
  const timers = new Map()
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((fn) => fn()) }
  const { StatusManager } = load('src/main/status/StatusManager.ts', {
    require: (id) => (id === 'electron' ? { Notification: { isSupported: () => false } } : require(id)),
    setTimeout: (fn) => { timers.set(++tid, fn); return tid }, clearTimeout: (id) => timers.delete(id),
  })
  const manager = new StatusManager(() => ({ isDestroyed: () => false, isFocused: () => focused, webContents: { send() {} }, flashFrame() {} }), () => null, (n) => notices.push(n))
  manager.setConfig(notificationSettingsSchema.parse({}))
  manager.setSeenListener((paneId) => seen.push(paneId))
  manager.onSpawn('pty', 'pane')
  const hook = (name, rest = {}) => manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session', name, ...rest })
  hook('UserPromptSubmit'); hook('PermissionRequest', { toolUseId: 'one' })
  const n = notices.at(-1)
  check(n && n.state === 'action' && typeof n.seq === 'number', 'an action notice carries its seq')
  check(manager.noticeCurrent('pane', n.seq) === true, 'noticeCurrent: the open request still stands')
  check(manager.noticeCurrent('pane', n.seq + 1) === false && manager.noticeCurrent('nope', n.seq) === false, 'noticeCurrent: another seq or no track does not')
  manager.ackPane('pane')
  check(seen.at(-1) === 'pane' && manager.noticeCurrent('pane', n.seq) === true, 'ackPane tells the seen listener; looking does not answer an action')
  hook('PostToolUse', { toolUseId: 'one' })
  check(manager.noticeCurrent('pane', n.seq) === false, 'answered: the action notice no longer stands')
  hook('Stop'); flush()
  const done = notices.at(-1)
  check(done.state === 'done' && done.seq !== n.seq && manager.noticeCurrent('pane', done.seq), 'a done notice with its own seq stands')
  focused = true; seen.length = 0
  manager.setViewed(['pane'])
  check(seen.includes('pane') && manager.noticeCurrent('pane', done.seq) === false, 'a focused desktop view: seen, the done no longer stands')
  seen.length = 0
  manager.onWindowFocus()
  check(seen.includes('pane'), 'the window gaining focus tells the seen listener for the viewed panes')
  manager.dispose()
}

// --- Schema 20 -----------------------------------------------------------------------------------

function schemaChecks() {
  const { notificationSettingsSchema, sidebarBlocksSettingsSchema, CONFIG_VERSION } = load('src/main/store/schema.ts')
  const { SIDEBAR_BLOCK_KEYS, DEFAULT_SIDEBAR_BLOCKS, sidebarBlockOn } = load('src/shared/sidebarBlocks.ts')
  const { normalizeNoticeDelay, NOTICE_DELAY_MAX_SEC } = load('src/shared/noticeDelay.ts')
  check(CONFIG_VERSION === 20, 'schema 20')
  check(notificationSettingsSchema.parse({}).remoteDelaySec === 0, 'remoteDelaySec defaults to 0')
  check(notificationSettingsSchema.parse({ remoteDelaySec: 120 }).remoteDelaySec === 120, 'remoteDelaySec keeps 120')
  for (const junk of [-1, 1.5, 'x', 99999, null]) check(notificationSettingsSchema.parse({ remoteDelaySec: junk }).remoteDelaySec === 0, `remoteDelaySec junk ${JSON.stringify(junk)} falls back to 0`)
  check(NOTICE_DELAY_MAX_SEC === 3600 && normalizeNoticeDelay(4000) === 3600 && normalizeNoticeDelay(-3) === 0 && normalizeNoticeDelay('a') === 0 && normalizeNoticeDelay(12.4) === 12, 'normalizeNoticeDelay')
  const blocks = sidebarBlocksSettingsSchema.parse({})
  check(SIDEBAR_BLOCK_KEYS.length === 6 && SIDEBAR_BLOCK_KEYS.every((k) => blocks[k] === true && DEFAULT_SIDEBAR_BLOCKS[k] === true), 'every sidebar block shown by default')
  check(sidebarBlocksSettingsSchema.parse({ teams: false, usageBars: 'x' }).teams === false && sidebarBlocksSettingsSchema.parse({ usageBars: 'x' }).usageBars === true, 'a hidden block stays hidden, junk shows it')
  check(sidebarBlockOn(null, 'teams') && sidebarBlockOn({ sidebarBlocks: { teams: 'x' } }, 'teams') && !sidebarBlockOn({ sidebarBlocks: { teams: false } }, 'teams'), 'sidebarBlockOn: only false hides')
}

delayChecks()
statusChecks()
schemaChecks()
console.log(`notice delay: ${checks} checks passed`)
