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

function testNavigation() {
  // E5-FR-15..20, E4-FR-10: ranking, rows, next waiting, ages, keys (R21-05).
  const g = load('src/shared/agents.ts')
  const P = (id, rank, stateSince, unread = false) => ({ id, rank, stateSince, unread })
  const sorted = list => [...list].sort(g.compareAgents).map(p => p.id)
  check(sorted([P('w', 3, 5), P('i', 4, 9), P('d', 2, 1), P('a', 1, 7), P('e', 1, 3)]).join() === 'e,a,d,w,i', 'compareAgents: action/error > done > working > idle, ranks 1-2 waiting longest first')
  check(sorted([P('seen', 2, 1), P('unread', 2, 9, true)]).join() === 'unread,seen', 'compareAgents: unread done before seen done')
  check(sorted([P('old', 3, 1), P('new', 3, 9)]).join() === 'new,old' && sorted([P('old', 4, 1), P('new', 4, 9)]).join() === 'new,old', 'compareAgents: ranks 3-4 most recent first')
  check(sorted([P('b', 1, 5), P('a', 1, 5)]).join() === 'a,b', 'compareAgents: ties fall back to the id (stable)')
  const lay = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map((id, i) => P(id, i === 6 || i === 7 ? 1 : 4, i))
  const rows = g.pickAgentRows(lay)
  check(rows.hidden === 2 && rows.shown.length === 6 && rows.shown.map(r => r.id).join() === 'p3,p4,p5,p6,p7,p8', 'pickAgentRows: with 8, the 6 best (2 waiting + 4 most recent) in layout order plus +2')
  check(g.pickAgentRows(lay.slice(0, 6)).hidden === 0 && g.pickAgentRows(lay.slice(0, 6)).shown.length === 6, 'pickAgentRows: 6 or fewer show all')
  check(g.formatAgeShort(20_000, 'es') === 'ahora' && g.formatAgeShort(20_000, 'en') === 'now' && g.formatAgeShort(3 * 60_000, 'en') === '3m' && g.formatAgeShort(2 * HOUR, 'es') === '2h' && g.formatAgeShort(30 * HOUR, 'en') === '1d' && g.formatAgeShort(-5, 'en') === 'now', 'formatAgeShort: now/ahora, 3m, 2h, 1d, skew counts as now')

  const fsn = load('src/renderer/lib/formatSince.ts')
  const now = 10_000_000
  const es4 = fsn.formatSince(now - 4 * 60_000, now, 'es')
  check(/hace/.test(es4) && /4/.test(es4), 'formatSince es: "hace 4 min" (' + es4 + ')')
  const en2 = fsn.formatSince(now - 2 * HOUR, now, 'en')
  check(/ago/.test(en2) && /2/.test(en2), 'formatSince en: "2 hr. ago" (' + en2 + ')')
  check(fsn.formatSince(now + 5000, now, 'en') === fsn.formatSince(now, now, 'en'), 'formatSince: clock skew counts as now')
  const { en } = load('src/renderer/i18n/en.ts'), { es } = load('src/renderer/i18n/es.ts')
  const tr = dict => (k, v) => dict[k].replace(/\{(\w+)\}/g, (_m, x) => String(v?.[x]))
  const lines = fsn.statusTipLines({ state: 'action', precise: false, provider: 'claude', pendingCount: 2, stateSince: now - 4 * 60_000 }, tr(es), 'es', now)
  check(lines.length === 4 && lines[0] === 'Claude - Requiere tu intervención' && /hace/.test(lines[1]) && lines[2] === '(aproximado)' && lines[3] === '2 solicitudes pendientes', 'statusTipLines: provider - state, since, approximate and pending count as separate lines')
  check(fsn.statusTipLines({ state: 'working', precise: true, provider: 'codex' }, tr(en), 'en', now).join('|') === 'Codex - Working', 'statusTipLines: a precise single request has one line')

  const nav = load('src/renderer/lib/agentNav.ts')
  const preset = { id: 'pc', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }
  const pane = (id, extra = {}) => ({ id, type: 'claude', presetId: 'pc', title: 'Claude Code', color: '#d97757', icon: 'claude', ...extra })
  const ws1 = { id: 'w1', name: 'Uno', cwd: '', panes: [pane('a'), pane('b'), pane('c'), pane('m')], layout: { grid: 4, order: ['c', 'a', 'b', 'm'] } }
  const ws2 = { id: 'w2', name: 'Dos', cwd: '', panes: [pane('x'), pane('y'), pane('s', { setupId: 'ssh' })] }
  const view = (paneId, extra = {}) => ({ paneId, provider: 'claude', sessionId: '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab', spawnCwd: 'C:/r', activity: 'idle', updatedAt: 50, available: true, ...extra })
  const input = {
    workspaces: [ws1, ws2], presets: [preset], policy: 'ask',
    mountedWorkspaces: { w1: 'full' },
    paneStatus: { a: { state: 'action', precise: true, stateSince: 300 }, b: { state: 'done', precise: true, stateSince: 100 }, c: { state: 'working', precise: true, stateSince: 200, detail: { kind: 'tool', text: 'Edit useXterm.ts' } }, m: { state: 'action', precise: true, stateSince: 50 } },
    paneAttention: { b: true },
    sessions: { x: view('x', { topic: 'Fix login' }), y: view('y', { endedAt: 9 }), s: view('s') },
  }
  const all = nav.allAgents(input)
  check(all.map(e => e.id).join() === 'c,a,b,m,x', 'allAgents: live panes in layout order plus resumable records of unmounted workspaces (not ended, not SSH)')
  check(all.find(e => e.id === 'x').notStarted && all.find(e => e.id === 'x').rank === 4, 'a record that resumes on open is "not started", rank 4')
  check(nav.allAgents({ ...input, policy: 'off' }).every(e => e.id !== 'x'), 'with resumeOnStartup off nothing resumes on open, so no "not started" row')
  check(nav.allAgents({ ...input, mountedWorkspaces: { w1: 'full', w2: ['y'] } }).some(e => e.id === 'x'), 'a partial mount still lists its unspawned records')
  check(nav.paletteWaiting(all, null).join() === 'm,a,b,c,x', 'paletteWaiting: urgency order across workspaces')
  check(nav.paletteWaiting(all, 'm').join() === 'a,b,c,x', 'paletteWaiting: the console being looked at is left out')
  const many = Array.from({ length: 9 }, (_, i) => ({ id: 'q' + i, rank: 3, stateSince: i, unread: false }))
  check(nav.paletteWaiting(many, null).length === 6, 'paletteWaiting: at most 6 rows')
  check(nav.waitingIds(all).join() === 'm,a,b', 'waitingIds: action/error longest waiting first, then unread done')
  check(nav.waitingIds(nav.allAgents({ ...input, paneAttention: {} })).join() === 'm,a', 'waitingIds: a seen done is not waiting')

  // Next waiting: three in action, three presses walk them, the fourth wraps.
  const ids = ['p1', 'p2', 'p3']
  let cursor = null
  const seen = []
  for (let i = 0; i < 4; i++) {
    const step = nav.advanceWaiting(cursor, () => ids, () => true, 1000 + i * 1000)
    cursor = step.cursor
    seen.push(step.target)
  }
  check(seen.join() === 'p1,p2,p3,p1', 'advanceWaiting: presses within 5 s walk the list and wrap to the first')
  check(nav.advanceWaiting(cursor, () => ['p9'], () => true, cursor.at + 4999).target === 'p2', 'advanceWaiting: inside the window the frozen list wins over a fresh one')
  const stale = nav.advanceWaiting(cursor, () => ['p9'], () => true, cursor.at + 5000)
  check(stale.target === 'p9' && stale.cursor.index === 0, 'advanceWaiting: after 5 s it starts over from a fresh list')
  check(nav.advanceWaiting({ ids, index: 0, at: 0 }, () => [], id => id !== 'p2', 10).target === 'p3', 'advanceWaiting: closed consoles are skipped')
  const empty = nav.advanceWaiting(null, () => [], () => true, 0)
  check(empty.target === null && empty.cursor === null, 'advanceWaiting: nobody waiting returns null')

  check(nav.agentTitle(pane('t'), [preset], { topic: 'Fix login bug', firstPrompt: 'hola' }, true) === 'Fix login bug', 'agentTitle: topic replaces an unrenamed title')
  check(nav.agentTitle(pane('t'), [preset], { firstPrompt: 'refactor the store' }, true) === 'refactor the store', 'agentTitle: without topic the first prompt is the title')
  check(nav.agentTitle(pane('t', { title: 'Backend' }), [preset], { topic: 'Fix' }, true) === 'Backend', 'agentTitle: a renamed console keeps its name')
  check(nav.agentTitle(pane('t'), [preset], { topic: 'Fix' }, false) === 'Claude Code', 'agentTitle: topicAsTitle off keeps the console title')

  const T = tr(es)
  const entry = (status, extra = {}) => ({ id: 'e', rank: 1, unread: false, stateSince: now - 2 * 60_000, notStarted: false, ws: ws1, pane: pane('e'), status, ...extra })
  check(nav.agentPhrase(entry({ state: 'working', precise: true, detail: { kind: 'tool', text: 'Edit useXterm.ts' } }), T, 'es', now) === 'Edit useXterm.ts · 2m', 'agentPhrase working: detail plus age')
  check(nav.agentPhrase(entry({ state: 'working', precise: true }), T, 'es', now) === 'Trabajando · 2m', 'agentPhrase working without detail')
  check(nav.agentPhrase(entry({ state: 'action', precise: true, reason: 'question', detail: { kind: 'question', text: 'Sigo?' } }), T, 'es', now) === 'Pregunta: Sigo?', 'agentPhrase action question')
  check(nav.agentPhrase(entry({ state: 'action', precise: true, reason: 'permission', detail: { kind: 'permission', text: 'Bash: npm test' } }), T, 'es', now) === 'Permiso: Bash: npm test', 'agentPhrase action permission')
  check(nav.agentPhrase(entry({ state: 'action', precise: true, reason: 'plan' }), T, 'es', now) === 'Plan listo para revisar' && nav.agentPhrase(entry({ state: 'action', precise: false }), T, 'es', now) === 'Requiere tu intervención', 'agentPhrase action plan and generic')
  check(nav.agentPhrase(entry({ state: 'done', precise: true, lastMessage: 'Listo el fix\nmas texto' }), T, 'es', now) === 'Listo: Listo el fix · hace 2m', 'agentPhrase done: first line of the reply and "hace 2m"')
  check(nav.agentPhrase(entry({ state: 'error', precise: true }), T, 'es', now) === 'Detenido por un error' && nav.agentPhrase(entry({ state: 'unknown', precise: true }), T, 'es', now) === 'Sin conexión con el agente', 'agentPhrase error and unknown have no age')
  check(nav.agentPhrase(entry({ state: 'idle', precise: true }), T, 'es', now) === 'Inactivo · 2m', 'agentPhrase idle with age')
  check(nav.agentPhrase(entry(undefined, { notStarted: true }), T, 'es', now) === 'Sin iniciar · se retoma al abrir', 'agentPhrase not started')
  check(nav.agentPhrase(entry({ state: 'working', precise: true }), T, 'es', now, false) === 'Trabajando', 'agentPhrase without age for the palette')

  check(nav.visibleConsoles(ws1, ['a'], null).join() === 'c,b,m', 'visibleConsoles: grid order without minimized')
  check(nav.visibleConsoles(ws1, [], 'b').join() === 'b', 'visibleConsoles: only the maximized one while maximized')
  check(nav.stepPane(['c', 'b', 'm'], 'm', 1) === 'c' && nav.stepPane(['c', 'b', 'm'], 'c', -1) === 'm' && nav.stepPane(['c', 'b', 'm'], null, 1) === 'c' && nav.stepPane([], 'c', 1) === null, 'stepPane wraps both ways')

  const km = load('src/renderer/lib/keymap.ts')
  const keymap = km.resolveKeymap({})
  check(keymap.nextWaiting === 'Ctrl+Shift+J' && keymap.reopenClosedPane === 'Ctrl+Shift+U' && keymap.focusNextPane === 'Ctrl+Alt+Right' && keymap.focusPrevPane === 'Ctrl+Alt+Left', 'D8 defaults: Ctrl+Shift+J, Ctrl+Shift+U, Ctrl+Alt+Right/Left')
  const accels = Object.values(keymap)
  check(new Set(accels).size === accels.length, 'no default accelerator collides with another')
  check(!accels.some(a => ['Ctrl+J', 'Ctrl+R', 'Ctrl+Shift+Z'].includes(a)), 'forbidden or reserved combos stay free (Ctrl+J, Ctrl+R, redo)')
  // The combos D8 reserved for E6 prompt navigation now belong to it (R31-01).
  check(keymap.promptPrev === 'Ctrl+Shift+PageUp' && keymap.promptNext === 'Ctrl+Shift+PageDown' && accels.filter(a => a.startsWith('Ctrl+Shift+Page')).length === 2, 'Ctrl+Shift+PageUp/PageDown go only to promptPrev/promptNext')
  check(km.KEY_ACTIONS.every(a => typeof en[a.labelKey] === 'string' && typeof es[a.labelKey] === 'string'), 'every action has its label in es and en')
  const target = (tagName, extra = {}) => ({ target: { tagName, isContentEditable: false, classList: { contains: c => (extra.cls ?? []).includes(c) }, ...extra } })
  check(km.isEditableTarget(target('INPUT')) && km.isEditableTarget(target('textarea')) && km.isEditableTarget(target('DIV', { isContentEditable: true })), 'isEditableTarget: input, textarea, contenteditable')
  check(!km.isEditableTarget(target('TEXTAREA', { cls: ['xterm-helper-textarea'] })) && !km.isEditableTarget(target('DIV')) && !km.isEditableTarget({ target: null }), 'isEditableTarget: the xterm helper textarea and plain elements are not')
  const ev = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
  check(km.ctrlDigit(ev('3', { ctrlKey: true })) === 3 && km.ctrlDigit(ev('3')) === null && km.ctrlDigit(ev('3', { ctrlKey: true, shiftKey: true })) === null && km.ctrlDigit(ev('0', { ctrlKey: true })) === null && km.ctrlDigit(ev('3', { ctrlKey: true, altKey: true })) === null, 'ctrlDigit: only plain Ctrl+1..9 (AltGr = Ctrl+Alt is not)')
  check(km.SKIP_IN_EDITABLE.has('reopenClosedPane') && !km.SKIP_IN_EDITABLE.has('palette'), 'reopenClosedPane stays out of text fields')

  const { sidebarOrder } = load('src/renderer/lib/sidebarOrder.ts')
  check(sidebarOrder([{ id: 'a' }, { id: 'b', favorite: true }, { id: 'c' }, { id: 'd', favorite: true }]).map(w => w.id).join() === 'b,d,a,c', 'sidebarOrder: favorites first, stable')

  const extra = ['agents.nobodyWaiting', 'status.pendingMany', 'settings.agents.rows', 'settings.agents.rowsHint', 'settings.agents.topicAsTitle', 'settings.agents.topicAsTitleHint', 'settings.agents.ctrlDigit', 'settings.agents.ctrlDigitHint']
  const navKeys = Object.keys(en).filter(k => /^(agents\.row\.|agents\.glyph\.|sidebar\.sum\.|keys\.|palette\.)/.test(k) || extra.includes(k))
  check(navKeys.length >= 40 && navKeys.every(k => typeof es[k] === 'string' && es[k].length > 0), 'every navigation string exists in es and en')
}

/** Renderer modules bundled together so they share one store instance (agents v2.2). */
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, Promise, ...overrides })
  return mod.exports
}

/** Fake timers with a clock: advance(ms) fires what came due, in order. */
function fakeTimers() {
  let clock = 0, seq = 0
  const timers = new Map()
  const setTimer = (fn, ms) => { timers.set(++seq, { fn, at: clock + ms }); return seq }
  const clearTimer = id => { timers.delete(id) }
  const advance = ms => {
    const end = clock + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); clock = due[1].at; due[1].fn()
    }
    clock = end
  }
  return { setTimer, clearTimer, advance, pending: () => timers.size }
}

// E5-FR-12: dialog model (candidates, groups, phrases) and its countdown.
function testResumeModalModel() {
  const m = load('src/renderer/lib/resumeModal.ts')
  const preset = { id: 'pc', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '', icon: 'claude' }
  const pane = (id, extra = {}) => ({ id, type: 'claude', presetId: 'pc', title: 'Claude Code', color: '', icon: 'claude', ...extra })
  const view = (paneId, extra = {}) => ({ paneId, provider: 'claude', sessionId: '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab', spawnCwd: 'C:/r', activity: 'working', updatedAt: 50, available: true, ...extra })
  const working = { activity: 'working', trigger: 'update', at: 60 }
  const workspaces = [
    { id: 'w1', name: 'Uno', cwd: '', panes: [pane('a'), pane('b'), pane('n')], layout: { grid: 4, order: ['b', 'a', 'n'] } },
    { id: 'w2', name: 'Dos', cwd: '', favorite: true, panes: [pane('c', { type: 'codex', presetId: undefined, title: 'Codex' }), pane('s', { setupId: 'ssh' }), pane('e'), pane('g')] },
  ]
  const sessions = {
    a: view('a', { interrupted: working, topic: 'Fix login', lastPrompt: 'arreglá el login' }),
    b: view('b', { interrupted: { activity: 'action', reason: 'permission', trigger: 'update', at: 60 }, firstPrompt: 'refactor store' }),
    n: view('n'),
    c: view('c', { interrupted: { activity: 'action', reason: 'plan', trigger: 'update', at: 60 }, provider: 'codex' }),
    s: view('s', { interrupted: working }),
    e: view('e', { interrupted: working, endedAt: 70 }),
    g: view('g', { interrupted: working, available: false, unavailableReason: 'transcript' }),
  }
  const startup = { trigger: 'update', interrupted: ['a', 'b', 'c', 's', 'e', 'g', 'gone'] }
  const input = { workspaces, presets: [preset], sessions, startup, policy: 'ask' }
  check(m.resumeModalCandidates(input).join() === 'c,b,a', 'candidates: interrupted and resumable only (no SSH, ended or unavailable), sidebar order (favorites first) then grid order')
  check(m.resumeModalCandidates({ ...input, policy: 'auto' }).length === 0 && m.resumeModalCandidates({ ...input, policy: 'off' }).length === 0, 'auto and off never ask')
  check(m.resumeModalCandidates({ ...input, startup: { trigger: null, interrupted: [] } }).length === 0 && m.resumeModalCandidates({ ...input, startup: null }).length === 0, 'no interrupted chat, no dialog')
  const groups = m.resumeGroups(['c', 'b', 'a'], workspaces, sessions)
  check(groups.length === 2 && groups[0].name === 'Dos' && groups[1].rows.map(r => r.paneId).join() === 'b,a', 'rows grouped by workspace in the order given')
  const [rc] = groups[0].rows, [rb, ra] = groups[1].rows
  check(ra.title === 'Fix login' && rb.title === 'refactor store' && rc.title === 'Codex', 'title: topic, else first prompt, else the console title')
  check(ra.stateKey === 'agents.modal.state.working' && rb.stateKey === 'agents.modal.state.permission' && rc.stateKey === 'agents.modal.state.plan', 'state phrase per interruption (working, permission, plan)')
  check(m.interruptedStateKey({ activity: 'action', reason: 'question' }) === 'agents.modal.state.question' && m.interruptedStateKey({ activity: 'action', reason: 'elicitation' }) === 'agents.modal.state.question' && m.interruptedStateKey({ activity: 'action' }) === 'agents.modal.state.action', 'question and elicitation read "question pending"')
  check(ra.working && !rb.working && ra.lastPrompt === 'arreglá el login' && rc.provider === 'codex', 'rows carry working, last prompt and provider')
  check(['update', 'quit', 'shutdown', 'crash', null].map(m.triggerKey).join() === 'agents.modal.sub.update,agents.modal.sub.quit,agents.modal.sub.shutdown,agents.modal.sub.crash,agents.modal.sub.crash', 'subtitle by trigger')
  check(m.groupCheck(groups[1].rows, new Set(['a', 'b'])) === 'all' && m.groupCheck(groups[1].rows, new Set(['a'])) === 'some' && m.groupCheck(groups[1].rows, new Set()) === 'none', 'tri-state workspace checkbox')
  // Countdown (fake clock values).
  check(m.countdownLeft(1000, 60, 16_000, false) === 45_000 && m.formatCountdown(45_000) === '0:45', '"Resuming automatically in 0:45" 15 s into a 60 s countdown')
  check(m.formatCountdown(44_001) === '0:45' && m.formatCountdown(60_000) === '1:00' && m.formatCountdown(600_000) === '10:00' && m.formatCountdown(9_000) === '0:09' && m.formatCountdown(-1) === '0:00', 'formatCountdown rounds up to whole seconds')
  check(m.countdownLeft(1000, 60, 61_000, false) === 0 && m.countdownLeft(1000, 60, 99_000, false) === 0, 'it reaches 0 at the deadline and stays there')
  check(m.countdownLeft(1000, 0, 2000, false) === null, 'resumeModalTimeoutSec = 0: no countdown')
  check(m.countdownLeft(1000, 60, 2000, true) === null, 'any interaction cancels the countdown')
}

// E5-FR-13: the nudge under fake timers.
function testNudge() {
  const { createNudger, NUDGE_START_TIMEOUT_MS, NUDGE_IDLE_WAIT_MS, NUDGE_ENTER_DELAY_MS } = load('src/renderer/lib/resumeNudge.ts')
  check(NUDGE_START_TIMEOUT_MS === 20_000 && NUDGE_IDLE_WAIT_MS === 1000 && NUDGE_ENTER_DELAY_MS === 150, 'nudge timings: 20 s for start, 1 s for idle, Enter 150 ms later')
  const make = () => {
    const t = fakeTimers(), writes = [], action = new Set()
    let hasPty = true
    const n = createNudger({ setTimer: t.setTimer, clearTimer: t.clearTimer, write: (p, d) => { if (!hasPty) return false; writes.push([p, d]); return true }, isAction: p => action.has(p) })
    return { t, writes, action, n, noPty: () => { hasPty = false } }
  }
  const S1 = 'session-1111', S2 = 'session-2222'
  {
    const h = make()
    h.n.arm('p', 'Continuá donde quedaste.')
    h.t.advance(5000)
    h.n.onReady({ paneId: 'p', sessionId: S1, phase: 'start' })
    h.t.advance(999)
    check(h.writes.length === 0, 'nothing before the idle or the 1 s after start')
    h.t.advance(1)
    check(h.writes.length === 1 && h.writes[0][1] === 'Continuá donde quedaste.', 'no idle: the text goes 1 s after start')
    h.t.advance(149)
    check(h.writes.length === 1, 'the Enter waits 150 ms')
    h.t.advance(1)
    check(h.writes.length === 2 && h.writes[1][1] === '\r' && !h.n.isArmed('p') && h.t.pending() === 0, 'then the Enter, once, and nothing stays armed')
  }
  {
    const h = make()
    h.n.arm('p', 'Seguí')
    h.n.onReady({ paneId: 'p', sessionId: S1, phase: 'start' })
    h.t.advance(300)
    h.n.onReady({ paneId: 'p', sessionId: S2, phase: 'idle' })
    check(h.writes.length === 0, 'an idle of another session does not fire it')
    h.n.onReady({ paneId: 'p', sessionId: S1, phase: 'idle' })
    check(h.writes.length === 1 && h.writes[0][1] === 'Seguí', 'the first idle after the session start fires it at once')
    h.t.advance(2000)
    check(h.writes.length === 2 && h.writes[1][1] === '\r', 'the 1 s fallback was cancelled: exactly text + Enter')
  }
  {
    const h = make()
    h.n.arm('p', 'Seguí')
    h.t.advance(20_000)
    h.n.onReady({ paneId: 'p', sessionId: S1, phase: 'start' })
    h.t.advance(5000)
    check(h.writes.length === 0 && !h.n.isArmed('p'), 'no start in 20 s: nothing is written, a late start is ignored')
  }
  {
    const h = make()
    h.n.arm('p', 'Seguí')
    h.n.onReady({ paneId: 'p', sessionId: S1, phase: 'start' })
    h.action.add('p')
    h.t.advance(1000)
    check(h.writes.length === 0 && !h.n.isArmed('p'), 'never sent to a console in action')
  }
  {
    const h = make()
    h.n.arm('p', 'Seguí')
    h.n.onReady({ paneId: 'p', sessionId: S1, phase: 'idle' })
    check(h.writes.length === 0 && h.n.isArmed('p'), 'an idle before any start does not count')
    h.n.arm('q', '   ')
    check(!h.n.isArmed('q'), 'a blank text arms nothing')
    h.n.cancel('p')
    h.n.onReady({ paneId: 'p', sessionId: S1, phase: 'start' })
    h.t.advance(2000)
    check(h.writes.length === 0, 'a cancelled nudge never fires')
    h.n.arm('p', 'Seguí')
    h.noPty()
    h.n.onReady({ paneId: 'p', sessionId: S1, phase: 'start' })
    h.t.advance(2000)
    check(h.writes.length === 0 && h.t.pending() === 0, 'without a pty no Enter is scheduled')
  }
}

// E5-FR-22: Smart order, the freeze and Alt+N on the same order.
function testSmartOrder() {
  const { sidebarOrder, liveSidebarOrder, freezeSidebarOrder, releaseSidebarOrder, useSidebarFreeze } = load('src/renderer/lib/sidebarOrder.ts')
  const ws = (id, favorite, paneIds) => ({ id, name: id, cwd: '', favorite, panes: paneIds.map(p => ({ id: p, type: 'claude', title: p, color: '', icon: '' })) })
  const workspaces = [ws('A', false, ['a1']), ws('B', false, ['b1', 'b2']), ws('C', false, ['c1']), ws('D', true, ['d1']), ws('E', true, ['e1']), ws('F', false, ['f1'])]
  const paneStatus = {
    a1: { state: 'idle', precise: true, stateSince: 100 },
    b1: { state: 'working', precise: true, stateSince: 50 }, b2: { state: 'action', precise: true, stateSince: 400 },
    d1: { state: 'working', precise: true, stateSince: 10 },
    e1: { state: 'done', precise: true, stateSince: 20 },
    f1: { state: 'action', precise: true, stateSince: 300 },
  }
  const nav = { workspaces, paneStatus, paneAttention: { e1: true }, mountedWorkspaces: Object.fromEntries(workspaces.map(w => [w.id, 'full'])), sessions: {}, presets: [], policy: 'ask' }
  const ids = list => list.map(w => w.id).join()
  check(ids(sidebarOrder(workspaces)) === 'D,E,A,B,C,F', 'manual: favorites first, stable')
  check(ids(sidebarOrder(workspaces, { sort: 'manual', nav })) === 'D,E,A,B,C,F', 'manual ignores agent state')
  const smart = sidebarOrder(workspaces, { sort: 'smart', nav })
  check(ids(smart) === 'E,D,F,B,A,C', 'smart: favorites stay on top; inside each group the most demanding agent wins (action waiting longest first), agentless workspaces last')
  check(ids(sidebarOrder(workspaces, { sort: 'smart', nav: { ...nav, paneStatus: { ...paneStatus, f1: { state: 'action', precise: true, stateSince: 400 } } } })) === 'E,D,B,F,A,C', 'equal urgency keeps the manual order')
  const frozen = ['D', 'E', 'A', 'B', 'C']
  check(ids(sidebarOrder(workspaces, { sort: 'smart', nav, frozen })) === 'D,E,A,B,C,F', 'frozen: the order shown at freeze time holds, a new workspace goes last')
  check(ids(sidebarOrder(workspaces.map(w => w.id === 'C' ? { ...w, favorite: true } : w), { sort: 'smart', nav, frozen })) === 'D,E,C,A,B,F', 'frozen: a favorite toggle still regroups (favorites stay on top)')
  const app = { workspaces, paneStatus, paneAttention: nav.paneAttention, mountedWorkspaces: nav.mountedWorkspaces, presets: [], settings: { agents: { sidebarSort: 'smart', resumeOnStartup: 'ask' } } }
  check(ids(liveSidebarOrder(app, { sessions: {} })) === 'E,D,F,B,A,C', 'live order (Alt+1..9, next/previous workspace) follows Smart: Alt+1 is the first of the Smart order')
  check(ids(liveSidebarOrder({ ...app, settings: { agents: { sidebarSort: 'manual' } } }, { sessions: {} })) === 'D,E,A,B,C,F', 'live order with manual sort')
  freezeSidebarOrder(['D', 'E', 'A', 'B', 'C', 'F'])
  freezeSidebarOrder(['X'])
  check(useSidebarFreeze.getState().frozen.join() === 'D,E,A,B,C,F', 'a freeze in place is kept (pointer and focus both inside)')
  check(ids(liveSidebarOrder(app, { sessions: {} })) === 'D,E,A,B,C,F', 'while frozen Alt+N matches what is on screen')
  releaseSidebarOrder()
  check(useSidebarFreeze.getState().frozen === null && ids(liveSidebarOrder(app, { sessions: {} })) === 'E,D,F,B,A,C', 'released: the Smart order applies again')
}

// E5-FR-12/13 end to end in the renderer: the dialog holds the spawns, the
// decision becomes intents, the nudge arms, a reload does not ask again.
async function testResumeModalFlow() {
  const UUID = '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab', UUID2 = '1c8d3a5f-2b3c-4d4e-9fa0-123456789abc'
  const flush = () => new Promise(r => setImmediate(r))
  const build = (consumed) => {
    const sent = { forget: [], writes: [] }
    let onReady = null
    const t = fakeTimers()
    const sessions = [
      { paneId: 'pa', provider: 'claude', sessionId: UUID, spawnCwd: 'C:\\repo', activity: 'unknown', updatedAt: 1, available: true, topic: 'Fix login', interrupted: { activity: 'working', trigger: 'update', at: 1 } },
      { paneId: 'pd', provider: 'claude', sessionId: UUID2, spawnCwd: 'C:\\repo', activity: 'unknown', updatedAt: 1, available: true, interrupted: { activity: 'action', reason: 'permission', trigger: 'update', at: 1 } },
    ]
    const snApi = {
      platform: 'win32',
      agents: {
        list: async () => sessions, startup: async () => ({ trigger: 'update', interrupted: ['pa', 'pd'] }),
        consumeStartup: async (id) => { if (consumed.has(id)) return false; consumed.add(id); return true },
        startupPending: async (ids) => ids.filter(id => !consumed.has(id)),
        forget: (id) => sent.forget.push(id), onChanged: () => () => {}, onReady: (cb) => { onReady = cb; return () => {} },
      },
      pty: { kill: async () => {}, killPanes: async () => 0, write: (req) => sent.writes.push(req) },
      config: { save() {} },
    }
    const r = loadRenderer(`export * as launch from './agentLaunch'; export { useAppStore } from './store'; export { useAgentStore } from './agentStore'; export { registerPty } from './ptyRegistry'; export { resolveLaunch } from './launch'`, {
      window: { snApi }, document: { hasFocus: () => false }, setTimeout: t.setTimer, clearTimeout: t.clearTimer,
    })
    const S = r.useAppStore
    const preset = { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#000', icon: 'claude' }
    S.getState().hydrate({
      version: 12, presets: [preset],
      settings: { ...S.getState().settings, notifications: { ...S.getState().settings.notifications, hooksEnabled: true }, agents: { ...S.getState().settings.agents, resumeOnStartup: 'ask', resumeNudge: true } },
      activeWorkspaceId: 'w1',
      workspaces: [
        { id: 'w1', name: 'One', cwd: 'C:\\repo', panes: [{ id: 'pa', type: 'claude', presetId: 'preset-claude', title: 'A', color: '', icon: '' }], layout: { grid: 1, order: ['pa'] } },
        { id: 'w2', name: 'Two', cwd: 'C:\\repo', panes: [{ id: 'pd', type: 'claude', presetId: 'preset-claude', title: 'D', color: '', icon: '' }], layout: { grid: 1, order: ['pd'] } },
      ],
    })
    const base = (paneId) => { const ws = S.getState().workspaces.find(w => w.panes.some(p => p.id === paneId)); return r.resolveLaunch(ws.panes.find(p => p.id === paneId), ws, S.getState().presets, S.getState().connections) }
    return { r, S, A: r.useAgentStore, L: r.launch, t, sent, base, ready: (e) => onReady(e) }
  }

  const consumed = new Set()
  const h = build(consumed)
  await h.L.mountInterruptedAgents()
  let modal = h.A.getState().modal
  check(modal && modal.paneIds.join() === 'pa,pd' && modal.trigger === 'update' && h.A.getState().modalPending, 'ask + 2 interrupted chats in 2 workspaces: the dialog opens with both, from the update')
  check(h.A.getState().gated.pa && h.A.getState().gated.pd, 'their consoles are gated (placeholder)')
  check(h.S.getState().mountedWorkspaces.w2 === undefined, 'a pending pane is not mounted before the decision')
  let settled = null
  const pa = h.L.prepareAgentLaunch('pa', h.base('pa')).then(v => { settled = v })
  await flush(); await flush()
  check(settled === null && consumed.has('pa'), 'the gated spawn waits for the dialog (its startup decision is spent)')
  h.L.applyResumeChoice({ resume: ['pa'], nudge: true })
  await pa
  check(settled.initialCommand === `claude --resume ${UUID}` && settled.cwd === 'C:\\repo', 'a ticked row resumes once the dialog is decided')
  check(!h.A.getState().modal && !h.A.getState().modalPending && Object.keys(h.A.getState().gated).length === 0, 'the dialog closes and releases every gate')
  check(h.A.getState().launchIntent.pd === 'fresh' && h.S.getState().mountedWorkspaces.w2 === undefined, 'an unticked row starts fresh (on its first visit; nothing mounted for it)')
  const pd = await h.L.prepareAgentLaunch('pd', h.base('pd'))
  check(pd.initialCommand === 'claude' && !h.A.getState().resumeChip.pd && h.sent.forget.length === 0, 'unticked: fresh launch, no chip, the record is kept')
  // Nudge: pa was working, resumeNudge is on.
  h.r.registerPty('pa', 'pty-a')
  h.ready({ paneId: 'pa', sessionId: UUID, phase: 'start' })
  h.ready({ paneId: 'pa', sessionId: UUID, phase: 'idle' })
  check(h.sent.writes.length === 1 && h.sent.writes[0].ptyId === 'pty-a' && h.sent.writes[0].data === 'Continue where you left off.', 'the resumed working chat gets the nudge on its first idle (default text in the UI language)')
  h.t.advance(150)
  check(h.sent.writes.length === 2 && h.sent.writes[1].data === '\r', 'and the Enter 150 ms later')

  // A renderer reload after the decision: nothing pending, no dialog.
  const again = build(consumed)
  await again.L.mountInterruptedAgents()
  check(!again.A.getState().modal && !again.A.getState().modalPending, 'a reload after the decision does not ask again')

  // "Start fresh" + "Don't ask again", and the resume counter mounting the other workspace.
  const h2 = build(new Set())
  await h2.L.mountInterruptedAgents()
  h2.L.applyResumeChoice({ resume: ['pa', 'pd'], startFresh: true, dontAskAgain: true, nudge: false })
  check(h2.sent.forget.join() === 'pa,pd' && !h2.A.getState().sessions.pa && h2.A.getState().launchIntent.pa === 'fresh' && h2.A.getState().launchIntent.pd === 'fresh', '"Start fresh" forgets every listed chat and starts them clean')
  check(h2.S.getState().settings.agents.resumeOnStartup === 'auto' && h2.S.getState().settings.agents.resumeNudge === false, '"Don\'t ask again" sets resumeOnStartup=auto; the nudge checkbox is saved')
  const h3 = build(new Set())
  await h3.L.mountInterruptedAgents()
  h3.L.applyResumeChoice({ resume: ['pa', 'pd'] })
  check(JSON.stringify(h3.S.getState().mountedWorkspaces.w2) === '["pd"]' && h3.S.getState().activeWorkspaceId === 'w1', '"Resume 2" mounts the resumed console of a workspace never opened, without switching to it')
  const r3 = await h3.L.prepareAgentLaunch('pd', h3.base('pd'))
  check(r3.initialCommand === `claude --resume ${UUID2}`, 'and it resumes on spawn')
  check(h3.L.nudgeText() === 'Continue where you left off.', 'nudgeText falls back to the i18n default')
  h3.S.getState().updateSettings({ agents: { ...h3.S.getState().settings.agents, resumeNudgeText: '  Seguí con lo tuyo  ' } })
  check(h3.L.nudgeText() === 'Seguí con lo tuyo', 'a custom nudge text wins (trimmed)')
  const h4 = build(new Set())
  h4.S.getState().updateSettings({ agents: { ...h4.S.getState().settings.agents, resumeOnStartup: 'auto' } })
  await h4.L.mountInterruptedAgents()
  check(!h4.A.getState().modal && JSON.stringify(h4.S.getState().mountedWorkspaces.w2) === '["pd"]', 'auto: no dialog, interrupted chats resume and mount right away')
  // A listed console restarted while the dialog is open (its menu, the phone) starts at once and leaves the dialog.
  const h5 = build(new Set())
  await h5.L.mountInterruptedAgents()
  h5.A.getState().setIntent('pd', 'resume')
  const r5 = await h5.L.prepareAgentLaunch('pd', h5.base('pd'))
  check(r5.initialCommand === `claude --resume ${UUID2}` && h5.A.getState().modal.paneIds.join() === 'pa' && !h5.A.getState().gated.pd && h5.A.getState().gated.pa, 'a restarted listed console starts at once, loses its placeholder and leaves the dialog')
  h5.L.applyResumeChoice({ resume: [] })
  check(h5.A.getState().launchIntent.pd === undefined && h5.A.getState().launchIntent.pa === 'fresh', 'the later choice leaves no intent behind for the console that already started')
  const h6 = build(new Set())
  await h6.L.mountInterruptedAgents()
  let p6 = null
  const w6 = h6.L.prepareAgentLaunch('pa', h6.base('pa')).then(v => { p6 = v })
  await flush(); await flush()
  h6.A.getState().setIntent('pd', 'fresh')
  await h6.L.prepareAgentLaunch('pd', h6.base('pd'))
  check(p6 === null && h6.A.getState().modal && h6.A.getState().modal.paneIds.join() === 'pa', 'one console leaving keeps the dialog open for the rest')
  h6.A.getState().setIntent('pa', 'fresh')
  const r6 = await h6.L.prepareAgentLaunch('pa', h6.base('pa'))
  await w6
  check(!h6.A.getState().modal && !h6.A.getState().modalPending && p6 !== null && r6.initialCommand === 'claude', 'the last one leaving closes the dialog and releases the held spawns')
  h6.S.getState().updateSettings({ agents: { ...h6.S.getState().settings.agents, resumeNudgeText: 'Seguí\r\n\x1b[2Jcon\testo' } })
  check(h6.L.nudgeText() === 'Seguí [2Jcon esto', 'control characters in a hand-edited nudge text never reach the pty (no early Enter, no escape)')
}

// agents:startupPending: a peek at the unspent startup decisions (never spends one).
function testStartupPending() {
  const { AgentSessionStore } = load('src/main/agents/AgentSessionStore.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-pending-'))
  try {
    const store = new AgentSessionStore({ file: path.join(dir, 'agent-sessions.json'), getConfig: () => null, spawnCwd: () => dir, projectsDir: () => dir, now: () => 0, setTimer: () => 0, clearTimer: () => {} })
    check(store.startupPending(['a', 'b']).join() === 'a,b', 'nothing spent yet: every pane is pending')
    check(store.consumeStartup('a') === true && store.startupPending(['a', 'b', '']).join() === 'b', 'a spent pane leaves the list; empty ids are dropped')
    check(store.startupPending(['b']).join() === 'b' && store.consumeStartup('b') === true, 'the peek never spends a decision')
    const handlers = new Map()
    const electron = { ipcMain: { on: () => {}, handle: (ch, fn) => handlers.set(ch, fn) } }
    const { registerAgentsIpc } = load('src/main/ipc/registerAgentsIpc.ts', { require: m => m === 'electron' ? electron : require(m) })
    const { CH } = load('src/shared/ipc-channels.ts')
    registerAgentsIpc(store)
    const h = handlers.get(CH.AGENTS_STARTUP_PENDING)
    check(CH.AGENTS_STARTUP_PENDING === 'agents:startupPending' && h({}, ['a', 'c', 42, 'x'.repeat(200)]).join() === 'c', 'IPC: strings only, bounded ids, answered from the store')
    check(h({}, 'c').length === 0 && h({}, Array(1001).fill('c')).length === 0, 'IPC: a non-array or an oversized list answers nothing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function testV22I18n() {
  const { en } = load('src/renderer/i18n/en.ts'), { es } = load('src/renderer/i18n/es.ts')
  const keys = Object.keys(en).filter(k => /^(agents\.modal\.|agents\.nudge\.|settings\.agents\.(sort|resumeTimeout|resumeNudge))/.test(k))
  check(keys.length >= 28 && keys.every(k => typeof es[k] === 'string' && es[k].length > 0), 'every resume dialog, nudge and Smart order string exists in es and en')
  check(es['agents.nudge.default'] === 'Continuá donde quedaste.' && es['agents.modal.dontAsk'] === 'No preguntar más (retomar automáticamente)' && es['agents.modal.gated'].startsWith('Esperando tu decisión sobre retomar el chat'), 'the dialog wording matches the PRD')
}

;(async () => {
  testModes()
  testStaleAndPhone()
  testDisplayResumeAndEvents()
  testIpc()
  testTray()
  testRemotePhones()
  testRendererHelpers()
  testSchema()
  testNavigation()
  testResumeModalModel()
  testNudge()
  testSmartOrder()
  await testResumeModalFlow()
  testStartupPending()
  testV22I18n()
  console.log(`PASS: ${checks} agents checks (AwakeService modes, grace, 2 h lease, action + phone, resume, IPC, tray, renderer sync, agent navigation, resume dialog, countdown, nudge, Smart order)`)
})().catch((err) => { console.error(err); process.exit(1) })
