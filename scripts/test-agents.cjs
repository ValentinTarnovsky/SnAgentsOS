// Agents suite (E5): AwakeService policy under a fake powerSaveBlocker,
// powerMonitor, clock and timers, plus its IPC, tray and renderer helpers.
// No real power request, tray, registry or user config is touched.
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
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'], alias }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, queueMicrotask, ...overrides })
  return mod.exports
}

const HOUR = 60 * 60 * 1000
const { AwakeService, AWAKE_GRACE_MS, AWAKE_STALE_MS, isAwakeMode } = load('src/main/agents/AwakeService.ts')

/** Fake powerSaveBlocker + powerMonitor + clock + timers. */
function harness(opts = {}) {
  const Service = opts.Service ?? AwakeService
  let clock = 1_000_000, nextId = 0, seq = 0
  const started = new Map(), calls = [], timers = new Map(), resume = new Set(), states = []
  const blocker = {
    start(type) { if (opts.failStart) throw new Error('denied'); const id = ++nextId; started.set(id, type); calls.push(['start', type, id]); return id },
    stop(id) { started.delete(id); calls.push(['stop', id]) },
    isStarted(id) { return started.has(id) },
  }
  const power = { on: (ev, cb) => { if (ev === 'resume') resume.add(cb) }, removeListener: (ev, cb) => { if (ev === 'resume') resume.delete(cb) } }
  const svc = new Service({
    blocker, power, now: () => clock,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, at: clock + ms }); return seq },
    clearTimer: id => timers.delete(id),
  })
  svc.onChange(s => states.push(s))
  /** Move the clock and fire every timer that came due, in order. */
  const advance = ms => {
    const end = clock + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); clock = Math.max(clock, due[1].at); due[1].fn()
    }
    clock = end
  }
  const status = (paneId, state, updatedAt = clock) => svc.onPaneStatus({ paneId, state, precise: true, notify: false, updatedAt })
  return {
    svc, calls, states, started, timers, status, advance,
    now: () => clock, jump: ms => { clock += ms },
    resume: () => [...resume].forEach(cb => cb()), resumeListeners: () => resume.size,
    starts: () => calls.filter(c => c[0] === 'start').length, stops: () => calls.filter(c => c[0] === 'stop').length,
    held: () => started.size,
  }
}

function testModes() {
  check(isAwakeMode('auto') && isAwakeMode('always') && isAwakeMode('never') && !isAwakeMode('sometimes') && !isAwakeMode(1), 'isAwakeMode accepts exactly the three modes')
  {
    const h = harness()
    check(h.svc.getState().blocking === false && h.starts() === 0, 'Auto with no agents holds nothing')
    h.status('a', 'working')
    let s = h.svc.getState()
    check(s.blocking && s.reason === 'agents' && s.workingCount === 1 && s.mode === 'auto', 'Auto holds the block while a pane is working')
    check(h.calls[0][1] === 'prevent-app-suspension', 'the default request is prevent-app-suspension')
    h.status('b', 'working')
    check(h.starts() === 1 && h.svc.getState().workingCount === 2, 'a second working pane reuses the same request')
    h.status('a', 'done'); h.status('b', null)
    s = h.svc.getState()
    check(s.blocking && s.reason === 'agents' && s.releaseAt === h.now() + AWAKE_GRACE_MS && s.workingCount === 0, 'when Auto stops needing it the block enters a 120 s grace with releaseAt')
    h.advance(AWAKE_GRACE_MS - 1000)
    check(h.held() === 1 && h.svc.getState().blocking, 'still held one second before the grace ends')
    h.advance(1000)
    check(h.held() === 0 && !h.svc.getState().blocking && h.svc.getState().releaseAt === undefined, 'released when the 120 s grace ends')
  }
  {
    const h = harness()
    h.status('a', 'working'); h.status('a', 'idle'); h.advance(60 * 1000)
    h.status('a', 'working')
    check(h.svc.getState().releaseAt === undefined && h.starts() === 1 && h.timers.size >= 1, 'work resuming inside the grace cancels it without a new request')
    h.status('a', 'done'); h.advance(AWAKE_GRACE_MS)
    check(h.held() === 0, 'a later grace still releases')
  }
  {
    const h = harness()
    h.svc.setMode('always')
    check(h.svc.getState().blocking && h.svc.getState().reason === 'always', 'always holds the block with no agents')
    h.svc.setMode('auto')
    check(h.held() === 0 && h.svc.getState().releaseAt === undefined, 'leaving always for Auto with nothing to do releases at once (no grace)')
    h.status('a', 'working'); h.svc.setMode('never')
    check(h.held() === 0 && !h.svc.getState().blocking, 'never releases immediately even with a working pane')
    const before = h.starts()
    h.status('b', 'working'); h.svc.setDisplay(true)
    check(h.held() === 0 && h.starts() === before, 'never never requests it')
    h.svc.setMode('auto')
    check(h.svc.getState().blocking && h.svc.getState().workingCount === 2, 'back to Auto picks up the working panes')
  }
}

function testStaleAndPhone() {
  {
    const h = harness()
    h.status('old', 'working', h.now() - AWAKE_STALE_MS - 1)
    check(!h.svc.getState().blocking && h.svc.getState().workingCount === 0, 'a working pane not updated for more than 2 h does not keep it')
    h.status('a', 'working')
    check(h.svc.getState().workingCount === 1, 'only the fresh working pane is counted')
    h.advance(2 * HOUR - 10)
    check(h.svc.getState().blocking && h.svc.getState().releaseAt === undefined, 'held up to the 2 h lease')
    h.advance(20)
    check(h.svc.getState().workingCount === 0 && h.svc.getState().releaseAt !== undefined, 'the 2 h lease expiring starts the grace on its own timer')
    h.advance(AWAKE_GRACE_MS)
    check(h.held() === 0, 'and the grace then releases')
    h.status('a', 'working')
    check(h.svc.getState().blocking, 'a fresh update renews the lease')
  }
  {
    const h = harness()
    h.status('a', 'action')
    check(!h.svc.getState().blocking, 'an agent in action without a phone does not keep it')
    h.svc.setPhoneConnected(true)
    check(h.svc.getState().blocking && h.svc.getState().reason === 'agents' && h.svc.getState().workingCount === 0, 'action plus a connected phone keeps it')
    h.svc.setPhoneConnected(false)
    check(h.svc.getState().releaseAt !== undefined, 'the phone leaving starts the grace')
    h.svc.setPhoneConnected(true)
    check(h.svc.getState().releaseAt === undefined, 'the phone back inside the grace cancels it')
    h.status('a', 'done')
    check(h.svc.getState().releaseAt !== undefined, 'the answer arriving starts the grace')
    h.status('b', 'idle'); h.svc.setPhoneConnected(true)
    check(h.svc.getState().releaseAt !== undefined, 'a phone alone (nothing waiting) does not keep it')
  }
}

function testDisplayResumeAndEvents() {
  {
    const h = harness()
    h.svc.setDisplay(true)
    check(h.starts() === 0 && h.svc.getState().display === true, 'awakeDisplay alone requests nothing')
    h.status('a', 'working')
    check(h.calls.at(-1)[1] === 'prevent-display-sleep', 'with awakeDisplay the request is prevent-display-sleep')
    h.svc.setDisplay(false)
    const tail = h.calls.slice(-2)
    check(tail[0][0] === 'stop' && tail[1][0] === 'start' && tail[1][1] === 'prevent-app-suspension' && h.held() === 1, 'switching awakeDisplay while held is stop then start with the new type')
    h.status('a', 'done'); h.svc.setDisplay(true)
    check(h.calls.at(-1)[1] === 'prevent-display-sleep' && h.svc.getState().releaseAt !== undefined, 'switching inside the grace keeps the grace')
  }
  {
    const h = harness()
    h.status('a', 'working')
    const first = [...h.started.keys()][0]
    h.resume()
    check(h.held() === 1 && !h.started.has(first) && h.starts() === 2, 'resume refreshes the request (stop and start again)')
    h.status('a', 'done'); h.jump(AWAKE_GRACE_MS + 5000)
    h.resume()
    check(h.held() === 0 && !h.svc.getState().blocking, 'a grace that ran out while asleep releases on resume')
    h.status('a', 'working', h.now()); h.jump(3 * HOUR); h.resume()
    check(h.svc.getState().workingCount === 0 && h.svc.getState().releaseAt !== undefined, 'a lease that expired while asleep is not counted on resume')
  }
  {
    const h = harness()
    h.status('a', 'working')
    h.started.clear() // the OS or Electron dropped it
    h.status('b', 'working')
    check(h.starts() === 2 && h.held() === 1, 'start runs again only when the old request is no longer started')
    const before = h.starts(); h.status('b', 'working')
    check(h.starts() === before, 'no duplicate start while the request is alive')
  }
  {
    const h = harness()
    const n0 = h.states.length
    h.status('a', 'idle'); h.status('a', 'done')
    check(h.states.length === n0, 'no power:state while nothing visible changes')
    h.status('a', 'working')
    check(h.states.length === n0 + 1 && h.states.at(-1).blocking, 'one state per change')
    h.status('a', 'working')
    check(h.states.length === n0 + 1, 'repeated working updates do not spam')
    h.svc.seed([{ paneId: 'x', state: 'working', precise: false, notify: false, updatedAt: h.now() }])
    check(h.states.at(-1).workingCount === 2, 'seed counts the snapshot panes')
  }
  {
    const warns = []
    const quiet = load('src/main/agents/AwakeService.ts', { console: { ...console, warn: (...a) => warns.push(a.join(' ')) } })
    const h = harness({ failStart: true, Service: quiet.AwakeService })
    h.status('a', 'working')
    check(!h.svc.getState().blocking && warns.length === 1, 'a failed powerSaveBlocker.start is reported as not blocking, without throwing')
  }
  {
    const h = harness()
    h.status('a', 'working'); h.svc.dispose()
    check(h.held() === 0 && h.resumeListeners() === 0 && h.timers.size === 0, 'dispose releases, clears timers and drops the resume listener')
    h.status('b', 'working')
    check(h.held() === 0, 'nothing is requested after dispose')
  }
}

function testIpc() {
  const handlers = new Map(), listeners = new Map(), sent = []
  const started = new Set(); let id = 0
  const electron = {
    ipcMain: { on: (ch, fn) => listeners.set(ch, fn), handle: (ch, fn) => handlers.set(ch, fn) },
    powerSaveBlocker: { start: () => { started.add(++id); return id }, stop: i => started.delete(i), isStarted: i => started.has(i) },
    powerMonitor: { on() {}, removeListener() {} },
  }
  const { registerPowerIpc } = load('src/main/ipc/registerPowerIpc.ts', { require: m => m === 'electron' ? electron : require(m) })
  const { CH } = load('src/shared/ipc-channels.ts')
  const seen = []
  const wc = { isDestroyed: () => false, send: (ch, s) => sent.push([ch, s]) }
  const awake = registerPowerIpc({ getSender: () => wc, initialMode: 'always', initialDisplay: true, onState: s => seen.push(s) })
  check(CH.POWER_SET_CONFIG === 'power:setConfig' && CH.POWER_STATE === 'power:state' && CH.POWER_GET_STATE === 'power:getState' && CH.AGENTS_SET_CONFIG === 'agents:setConfig', 'channel names follow the contract')
  let s = handlers.get(CH.POWER_GET_STATE)()
  check(s.mode === 'always' && s.display === true && s.blocking && started.size === 1, 'boot applies the persisted mode and awakeDisplay')
  const n = sent.length
  listeners.get(CH.POWER_SET_CONFIG)({}, 'always')
  check(sent.length === n + 1 && sent.at(-1)[0] === CH.POWER_STATE && sent.at(-1)[1].mode === 'always', 'power:setConfig is always echoed, even with no change')
  listeners.get(CH.POWER_SET_CONFIG)({}, 'bogus')
  check(handlers.get(CH.POWER_GET_STATE)().mode === 'always', 'an invalid mode is ignored')
  listeners.get(CH.POWER_SET_CONFIG)({}, 'never')
  check(started.size === 0 && seen.at(-1).mode === 'never' && !seen.at(-1).blocking, 'never from the renderer releases and notifies the tray hook')
  listeners.get(CH.AGENTS_SET_CONFIG)({}, { awakeDisplay: false, resumeOnStartup: 'ask' })
  check(handlers.get(CH.POWER_GET_STATE)().display === false, 'agents:setConfig carries awakeDisplay')
  listeners.get(CH.AGENTS_SET_CONFIG)({}, null)
  check(handlers.get(CH.POWER_GET_STATE)().display === false, 'a malformed agents:setConfig is ignored')
  awake.dispose()
}

function testTray() {
  let template = null
  class Tray { setToolTip() {} on() {} setContextMenu() {} destroy() {} }
  const electron = {
    app: { getAppPath: () => root },
    Menu: { buildFromTemplate: t => { template = t; return {} } },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    Tray,
  }
  const fakeProcess = Object.assign(Object.create(process), { resourcesPath: os.tmpdir() })
  const tray = load('src/main/tray.ts', { require: m => m === 'electron' ? electron : require(m), process: fakeProcess })
  const picks = []
  const labels = { title: 'Mantener PC despierta', auto: 'Auto', always: 'Siempre', never: 'Nunca' }
  tray.ensureTray(() => null, () => {}, { show: 'Mostrar', quit: 'Salir' }, { mode: 'always', labels, onMode: m => picks.push(m) })
  const sub = template.find(i => i.submenu)
  check(tray.hasTray() && sub && sub.label === labels.title && sub.submenu.length === 3, 'the tray adds the awake submenu')
  check(sub.submenu.every(i => i.type === 'radio') && sub.submenu.filter(i => i.checked).map(i => i.label).join() === 'Siempre', 'radios mark the current mode')
  sub.submenu[2].click()
  check(picks.join() === 'never', 'picking a radio calls onMode')
  tray.ensureTray(() => null, () => {}, { show: 'Show', quit: 'Quit' })
  check(!template.some(i => i.submenu), 'without the awake option the menu is the old one')
  tray.destroyTray()
  check(!tray.hasTray(), 'destroyTray resets hasTray')

  const { mainTLang } = load('src/main/i18n.ts')
  check(mainTLang('es', 'tray.awake') === 'Mantener PC despierta' && mainTLang('en', 'tray.awake') === 'Keep PC awake', 'tray.awake follows the language')
  check(['tray.awakeAuto', 'tray.awakeAlways', 'tray.awakeNever'].every(k => mainTLang('es', k) !== mainTLang('en', k)), 'tray radios are translated')
}

function testRemotePhones() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-agents-'))
  const electron = { app: { getPath: () => dir, isPackaged: false, getName: () => 'snagentsos-test' } }
  const { RemoteManager } = load('src/main/remote/RemoteManager.ts', { require: m => m === 'electron' ? electron : require(m) })
  const pty = { addSink() {}, removeSink() {}, setRunningChangeListener() {}, runningPaneIds: () => [] }
  const rm = new RemoteManager(pty, () => null, '2.0.0')
  const flips = []
  rm.setPhoneListener(c => flips.push(c))
  check(rm.phoneConnected === false, 'no phone without a server')
  rm.sessions = { connectedCount: 1, dispose() {}, id: 'sessions' }
  rm.onConnectionsChanged()
  rm.onConnectionsChanged()
  check(flips.join() === 'true', 'the first authenticated phone flips presence once')
  rm.sessions.connectedCount = 2; rm.onConnectionsChanged()
  check(flips.length === 1, 'more phones do not re-notify')
  rm.teardownServer()
  check(flips.join() === 'true,false' && rm.phoneConnected === false, 'stopping the server reports the phones gone')
  fs.rmSync(dir, { recursive: true, force: true })
}

function testRendererHelpers() {
  const { createAwakeModeSync, awakeTooltip, awakeIndicatorVisible, formatCountdown } = load('src/renderer/lib/awake.ts')
  {
    const sent = [], persisted = []
    const sync = createAwakeModeSync(m => sent.push(m), m => persisted.push(m))
    sync.push('auto')
    check(sent.join() === 'auto', 'the hydrated mode is pushed')
    sync.onState({ blocking: false, reason: null, mode: 'auto' })
    sync.push('auto')
    check(sent.length === 1, 'a mode main already has is not re-sent')
    sync.push('always')
    sync.onState({ blocking: false, reason: null, mode: 'auto' })
    check(persisted.length === 0, 'a stale power:state in flight does not revert the user choice')
    sync.onState({ blocking: true, reason: 'always', mode: 'always' })
    check(persisted.length === 0, 'the echo of our own push is not persisted again')
    sync.onState({ blocking: false, reason: null, mode: 'never' })
    check(persisted.join() === 'never', 'a mode picked from the tray is persisted')
    sync.push('never')
    check(sent.length === 2, 'persisting the tray pick does not bounce it back to main')
    sync.onState({ blocking: false, reason: null })
    check(persisted.length === 1, 'a state without mode is ignored')
  }
  check(formatCountdown(105000) === '1:45' && formatCountdown(0) === '0:00' && formatCountdown(-5) === '0:00' && formatCountdown(59001) === '1:00', 'formatCountdown rounds up and never goes negative')
  const now = 5_000_000
  check(awakeTooltip({ blocking: true, reason: 'agents', mode: 'auto', workingCount: 2 }, 'auto', now).key === 'awake.tip.workingMany', 'two agents use the plural tooltip')
  check(awakeTooltip({ blocking: true, reason: 'agents', mode: 'auto', workingCount: 2 }, 'auto', now).vars.n === 2, 'the plural tooltip carries the count')
  check(awakeTooltip({ blocking: true, reason: 'agents', mode: 'auto', workingCount: 1 }, 'auto', now).key === 'awake.tip.workingOne', 'one agent uses the singular tooltip')
  check(awakeTooltip({ blocking: true, reason: 'agents', mode: 'auto', workingCount: 0 }, 'auto', now).key === 'awake.tip.phone', 'action plus phone has its own tooltip')
  const grace = awakeTooltip({ blocking: true, reason: 'agents', mode: 'auto', workingCount: 0, releaseAt: now + 105000 }, 'auto', now)
  check(grace.key === 'awake.tip.grace' && grace.vars.time === '1:45', 'the grace tooltip counts down ("se libera en 1:45")')
  check(awakeTooltip({ blocking: true, reason: 'always', mode: 'always' }, 'always', now).key === 'awake.tip.always', 'always has its own tooltip')
  check(!awakeIndicatorVisible(null, 'always') && !awakeIndicatorVisible({ blocking: false, reason: null, mode: 'auto' }, 'auto'), 'the icon hides when nothing is held')
  check(awakeIndicatorVisible({ blocking: false, reason: null, mode: 'always' }, 'auto') && awakeIndicatorVisible({ blocking: true, reason: 'agents', mode: 'auto' }, 'auto'), 'the icon shows while held or in always mode')

  const { en } = load('src/renderer/i18n/en.ts'), { es } = load('src/renderer/i18n/es.ts')
  const keys = Object.keys(en).filter(k => k.startsWith('awake.') || k.startsWith('settings.agents.'))
  check(keys.length >= 16 && keys.every(k => typeof es[k] === 'string' && es[k].length > 0), 'every awake string exists in es and en')
}

function testSchema() {
  // The settings.awakeMode default (and the v10 stamp) are covered by test-status.cjs.
  const { agentSettingsSchema } = load('src/main/store/schema.ts')
  check(agentSettingsSchema.parse({}).awakeDisplay === false, 'awakeDisplay defaults to false')
  check(agentSettingsSchema.parse({ awakeDisplay: true }).awakeDisplay === true, 'a persisted awakeDisplay survives a reload')
}

testModes()
testStaleAndPhone()
testDisplayResumeAndEvents()
testIpc()
testTray()
testRemotePhones()
testRendererHelpers()
testSchema()
console.log(`PASS: ${checks} agents checks (AwakeService modes, grace, 2 h lease, action + phone, resume, IPC, tray, renderer sync)`)
