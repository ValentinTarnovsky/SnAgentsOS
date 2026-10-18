// Pure logic of the phone client, run in node:vm with fake browser globals.
// Section M2 (E1-FR-10..15, 41): endpointHint, delayFor, classifyConnection and
// the socket generation / liveness / revive / updated state machine of
// src/mobile/src/lib/client.ts driven by a fake WebSocket and a fake clock.
// Section M1 (E1-FR-03..07, 40): statusText, inPageAlerts, the workspace
// selectors, paneStatus handling and switchWorkspaceAndView.
// Section M5 (E1-FR-32..36, 39; E5-FR-11): backStack with a fake history,
// createLongPress under fake timers, the sheet drag math, tab order and
// titles, and which per-pane actions show for a resumable pane.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const BUNDLE_VERSION = '2.0.0'
const code = buildSync({
  stdin: {
    resolveDir: root, loader: 'ts', contents: `
export { client, RELOAD_FOR_KEY, IDLE_PROBE_MS, PONG_TIMEOUT, CONNECT_TIMEOUT_MS, REVIVE_PROBE_TIMEOUT } from './src/mobile/src/lib/client'
export { store } from './src/mobile/src/lib/store'
export { classifyConnection, endpointHint, formatAgo } from './src/mobile/src/lib/connectionHealth'
export { delayFor, RECONNECT_DELAYS } from './src/mobile/src/lib/reconnectSchedule'
export { relativeAge, statusLine, statusAriaLabel, showsTime } from './src/mobile/src/lib/statusText'
export { createInPageAlerts, IN_PAGE_ALERTS_KEY } from './src/mobile/src/lib/inPageAlerts'
export { viewedWorkspaceId, needsWorkspaceSwitch, waitingPanes, nextWaitingPane, statusMapOf } from './src/mobile/src/lib/workspace'
export { setLang } from './src/mobile/src/lib/i18n'
export { createBackStack } from './src/mobile/src/lib/backStack'
export { createLongPress, LONG_PRESS_MS, LONG_PRESS_SLOP_PX, LONG_PRESS_VIBRATE_MS } from './src/mobile/src/lib/longPress'
export * as sheetDrag from './src/mobile/src/lib/sheetDrag'
export { paneActionIds, restartAction } from './src/mobile/src/lib/paneActions'
export { tabTitle, tabPanes } from './src/mobile/src/lib/workspace'
` },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  define: { __APP_VERSION__: JSON.stringify(BUNDLE_VERSION), 'process.env.NODE_ENV': '"production"' },
  alias: { '@shared': path.join(root, 'src/shared') },
}).outputFiles[0].text

const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, keyButtons: [], activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'W', layoutOrder: ['p'], panes: [{ id: 'p', title: 'P', type: 'shell', running: true }] }] }

/** A fresh page: fake clock, timers, storage, document/window and WebSocket. */
function page({ paired = true, hash = '', online = true, session = new Map(), hostname = '100.101.1.2' } = {}) {
  let clock = 0, seq = 0, reloads = 0
  const timers = new Map()
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: clock + Math.max(0, ms || 0), fn, every }); return id }
  function runDue(end) {
    for (;;) {
      let best = null
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at || (t.at === best[1].at && id < best[0]))) best = [id, t]
      if (!best) break
      const [id, t] = best
      clock = Math.max(clock, t.at)
      if (t.every) t.at += t.every; else timers.delete(id)
      t.fn()
    }
    clock = Math.max(clock, end)
  }
  const sockets = []
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; this.autoPong = false; sockets.push(this) }
    send(data) {
      const msg = JSON.parse(data); this.sent.push(msg)
      // Replies arrive on a later tick, like a real network round trip.
      if (this.autoPong && msg.type === 'ping') add(() => this.recv({ type: 'pong', t: msg.t }), 20)
    }
    close() { this.closed = true; this.readyState = 3 }
    open() { this.readyState = 1; this.onopen && this.onopen({}) }
    recv(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify({ v: 1, ...msg }) }) }
    drop(code = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code }) }
    count(type) { return this.sent.filter(m => m.type === type).length }
  }
  const listeners = { doc: {}, win: {} }
  const on = bag => (type, fn) => { (bag[type] ||= []).push(fn) }
  const document = {
    visibilityState: 'visible', addEventListener: on(listeners.doc),
    documentElement: { style: { setProperty() {} } }, head: { appendChild() {} },
    querySelector: () => null, createElement: () => ({}),
  }
  const window = { addEventListener: on(listeners.win) }
  const vibrations = []
  const navigator = { onLine: online, vibrate: ms => { vibrations.push(ms); return true } }
  const mapStorage = map => ({ getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) })
  const local = new Map(paired ? [['snagentsos.remote.deviceId', 'dev1'], ['snagentsos.remote.secret', '00'.repeat(32)]] : [])
  const location = { host: `${hostname}:4517`, hostname, hash, pathname: '/', search: '', reload() { reloads++ } }
  class FakeDate extends Date { static now() { return 1700000000000 + clock } }
  const fakeMath = Object.create(Math); fakeMath.random = () => 0.5
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, require, console, process,
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: id => timers.delete(id),
    performance: { now: () => clock }, Date: FakeDate, Math: fakeMath,
    WebSocket: FakeWebSocket, document, window, navigator, location,
    localStorage: mapStorage(local), sessionStorage: mapStorage(session),
    history: { replaceState() {} }, crypto: require('node:crypto').webcrypto, TextEncoder, TextDecoder,
  })
  const api = mod.exports
  const fire = (bag, type, ev = {}) => (bag[type] || []).forEach(fn => fn(ev))
  return {
    ...api, sockets, session, timers, vibrations, local,
    get clock() { return clock },
    get reloads() { return reloads },
    state: () => api.store.getState(),
    last: () => sockets.at(-1),
    advance: ms => runDue(clock + ms),
    /** JS frozen (iOS suspend) without any event: time jumps, nothing runs. */
    freeze: ms => { clock += ms },
    hide: () => { document.visibilityState = 'hidden'; fire(listeners.doc, 'visibilitychange') },
    show: () => { document.visibilityState = 'visible'; fire(listeners.doc, 'visibilitychange') },
    setVisibleSilently: () => { document.visibilityState = 'visible' },
    pageshow: persisted => fire(listeners.win, 'pageshow', { persisted }),
    goOffline: () => { navigator.onLine = false; fire(listeners.win, 'offline') },
    goOnline: () => { navigator.onLine = true; fire(listeners.win, 'online') },
    health: () => { const s = api.store.getState(); return api.classifyConnection({ banner: s.banner, attempt: s.connAttempt, lastConnectedAt: s.lastConnectedAt, now: FakeDate.now(), hostname, online: s.online }) },
  }
}

/** Start the client and take its first socket live (authOk with appVersion). */
function live(opts = {}, appVersion = BUNDLE_VERSION) {
  const p = page(opts); p.client.start()
  const s = p.last(); s.open(); s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion })
  return { p, s }
}

function testPure(p) {
  const hints = {
    '100.64.0.1': 'tailscale', '100.127.255.254': 'tailscale', '100.63.0.1': 'generic', '100.128.0.1': 'generic',
    'mipc.tail1234.ts.net': 'tailscale', 'MIPC.TS.NET.': 'tailscale',
    '10.0.0.5': 'lan', '172.16.0.1': 'lan', '172.31.9.9': 'lan', '172.32.0.1': 'generic', '192.168.1.20': 'lan', 'desk.local': 'lan',
    'mipc': 'generic', '8.8.8.8': 'generic', '[fd7a:115c:a1e0::1]': 'generic', 'fe80::1': 'generic', '': 'generic', '999.1.1.1': 'generic',
  }
  for (const [host, want] of Object.entries(hints)) check(p.endpointHint(host) === want, `endpointHint(${host || 'empty'}) = ${want}`)

  const seq = Array.from({ length: 14 }, (_, i) => p.delayFor(i + 1, 0.5))
  assert.deepEqual(seq, [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 60000, 60000, 60000, 90000, 90000, 90000]); checks++
  check(p.delayFor(1, 0) === 350 && p.delayFor(1, 1) === 650, 'jitter stays within +-30%')
  check(p.delayFor(40, 0.5) === 90000, 'the 90s trickle continues indefinitely')

  const base = { banner: null, attempt: 0, lastConnectedAt: null, now: 100000, hostname: '192.168.1.2', online: true }
  const tier = o => p.classifyConnection({ ...base, ...o }).tier
  const rec = n => ({ banner: { kind: 'reconnecting', attempt: n }, attempt: n })
  check(tier({}) === 'ok', 'no banner is ok')
  check(tier(rec(1)) === 'reconnecting' && tier(rec(2)) === 'reconnecting', 'attempts 1-2 are neutral')
  check(tier(rec(3)) === 'cantConnect' && tier(rec(11)) === 'cantConnect', 'attempt 3 turns amber')
  check(tier(rec(12)) === 'unreachable', 'attempt 12 turns red')
  check(tier({ ...rec(1), lastConnectedAt: 100000 - 60001 }) === 'unreachable', 'more than 60s since the last good connection turns red')
  check(tier({ ...rec(1), lastConnectedAt: 100000 - 59000 }) === 'reconnecting', '59s is not yet red')
  check(tier({ ...rec(5), online: false }) === 'offline', 'offline wins over the attempt tiers')
  check(tier({ banner: { kind: 'desktopGone' }, attempt: 14 }) === 'desktopGone', 'desktopGone stays through any number of attempts')
  check(tier({ banner: { kind: 'disabled' }, online: false }) === 'disabled', 'disabled wins over offline')
  check(p.classifyConnection({ ...base, lastConnectedAt: 40000 }).sinceMs === 60000, 'sinceMs measures from the last good connection')
  check(p.formatAgo(45000) === '45s' && p.formatAgo(180000) === '3m' && p.formatAgo(7200000) === '2h', 'formatAgo is compact')
}

function testGeneration() {
  {
    const { p, s } = live()
    check(p.state().phase === 'live' && p.client.isOpen(), 'authOk goes live with an open socket')
    const lateClose = s.onclose
    p.client.reconnectNow()
    check(s.closed && s.onclose === null && s.onmessage === null, 'abort detaches the handlers and closes the old socket')
    check(p.sockets.length === 2 && p.state().phase === 'live', 'reconnectNow connects at once and keeps phase live')
    lateClose({ code: 1006 })
    p.advance(5000)
    check(p.sockets.length === 2, 'a late onclose of the old socket schedules nothing')
    p.last().open(); p.last().recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
    check(p.client.isOpen() && p.client.sendInput('x') === true, 'the new socket is still the current one after the late onclose')
  }
  {
    const p = page(); p.client.start()
    p.advance(p.CONNECT_TIMEOUT_MS - 1)
    check(!p.sockets[0].closed, 'connect timeout has not fired before 8s')
    p.advance(1)
    check(p.sockets[0].closed && p.sockets[0].onclose === null, 'a socket that never authenticates is aborted at 8s')
    p.advance(500)
    check(p.sockets.length === 2, 'the timed out attempt schedules the first retry (500ms)')
    p.client.reconnectNow()
    check(p.sockets[1].closed && p.sockets.length === 3 && p.last().readyState === 0, 'Retry during CONNECTING aborts and connects again')
  }
  {
    // Host unreachable (SYN never answered): every attempt dies at 8s, amber < 30s.
    const { p, s } = live()
    const t0 = p.clock; s.drop()
    let guard = 0
    while (p.health().tier !== 'cantConnect' && guard++ < 1000) p.advance(100)
    check(p.clock - t0 < 30000, `unreachable host reaches amber in under 30s (${p.clock - t0}ms)`)
    check(p.sockets.slice(1).every(x => x.closed || x === p.last()), 'each unanswered attempt is aborted')
  }
  {
    const p = page({ paired: false, hash: '#pair=ABCD1234' }); p.client.start()
    check(p.state().phase === 'pairForm', 'pairing code boots into the form')
    p.client.submitPairing('phone'); const s = p.last(); s.open(); s.recv({ type: 'pairPending' })
    p.advance(30000)
    check(!s.closed && p.state().phase === 'pairPending', 'pairPending switches the connect timeout off for the approval wait')
  }
  {
    const p = page(); p.client.start()
    check(p.client.sendInput('x') === false && p.client.isOpen() === false, 'sendInput refuses while CONNECTING')
    const s = p.last(); s.open()
    check(p.client.sendInput('x') === false, 'sendInput refuses before authentication')
  }
}

function testBackoff() {
  const p = page(); p.client.start()
  const deltas = []
  for (let i = 0; i < 13; i++) {
    const n = p.sockets.length; p.last().drop(); const t0 = p.clock
    while (p.sockets.length === n) p.advance(100)
    deltas.push(p.clock - t0)
  }
  assert.deepEqual(deltas, [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 60000, 60000, 60000, 90000, 90000]); checks++
  check(p.state().connAttempt === 13 && p.state().phase === 'connecting', 'the attempt counter is exposed before the first snapshot')
  check(p.health().tier === 'unreachable', 'the connecting screen escalates through the same tiers')
  const s = p.last(); s.open(); s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  check(p.state().connAttempt === 0, 'authOk resets the counter')
  const n = p.sockets.length; s.drop(); const t0 = p.clock
  while (p.sockets.length === n) p.advance(100)
  check(p.clock - t0 === 500, 'after authOk the schedule starts over at 500ms')
}

function testLiveness() {
  {
    const { p, s } = live(); s.autoPong = true
    p.advance(120000)
    check(p.sockets.length === 1 && !s.closed, 'a socket that answers pings stays up')
  }
  {
    const { p, s } = live()
    const t0 = p.clock
    p.advance(p.IDLE_PROBE_MS)
    check(s.count('ping') === 1, '20s of silence sends an extra ping')
    p.advance(p.PONG_TIMEOUT - 1)
    check(!s.closed, 'the pong deadline has not expired yet')
    p.advance(1)
    check(s.closed && p.sockets.length === 2, 'a missed pong aborts and reconnects without waiting')
    check(p.clock - t0 <= 28000 && p.state().connAttempt === 0, 'liveness abort within 28s, attempt counter at 0')
    check(p.state().banner && p.state().banner.kind === 'reconnecting' && p.state().phase === 'live', 'the live screen stays with a reconnecting banner')
    check(p.state().lastConnectedAt === 1700000000000 + t0, 'lastConnectedAt is the last frame of the dead socket')
  }
  {
    // Hidden with a deadline armed, back 5 minutes later with the socket alive.
    const { p, s } = live()
    p.advance(p.IDLE_PROBE_MS); check(s.count('ping') === 1, 'deadline armed before hiding')
    p.hide(); p.advance(5 * 60000)
    check(!s.closed, 'no deadline runs while hidden (the 25s keepalive still pings)')
    check(s.count('ping') > 1, 'keepalive pings continue while hidden')
    s.autoPong = true; const subs = s.count('sub'); p.show(); p.advance(1000)
    check(!s.closed && p.sockets.length === 1, 'after 5 minutes hidden with a live socket there is no reconnection')
    check(s.count('unsub') === 1 && s.count('sub') === subs + 1, 'the revive pong re-syncs the viewed pane (unsub then sub)')
  }
  {
    // iOS order on unlock: stale timers may run before the visible event lands.
    const { p, s } = live()
    p.advance(p.IDLE_PROBE_MS); p.hide(); p.freeze(5 * 60000)
    p.setVisibleSilently(); p.advance(0)
    check(!s.closed, 'a deadline armed before hiding never closes the socket on resume')
    s.autoPong = true; p.show(); p.advance(1000)
    check(!s.closed && p.sockets.length === 1, 'the socket survives the unlock')
  }
  {
    // JS frozen without a visibilitychange: the overdue deadline re-probes, never aborts.
    const { p, s } = live()
    p.advance(p.IDLE_PROBE_MS); p.freeze(5 * 60000); p.advance(0)
    check(!s.closed && s.count('ping') >= 2, 'a deadline firing minutes late probes again instead of aborting')
    p.advance(p.REVIVE_PROBE_TIMEOUT)
    check(s.closed && p.sockets.length === 2, 'the re-probe still catches a dead socket')
  }
  {
    const { p, s } = live(); s.autoPong = true
    p.hide(); p.advance(3000); const subs = s.count('sub'); p.show(); p.advance(1000)
    check(s.count('ping') === 1 && s.count('unsub') === 0 && s.count('sub') === subs, 'a 3s app switch probes but does not replay')
  }
  {
    const { p, s } = live()
    p.hide(); p.advance(5 * 60000); const t0 = p.clock; p.show()
    check(s.count('ping') >= 1 && !s.closed, 'revive sends a probe ping')
    p.advance(p.REVIVE_PROBE_TIMEOUT)
    check(s.closed && p.sockets.length === 2 && p.clock - t0 <= 4000, 'a dead socket after unlock reconnects within 4s')
  }
  {
    // bfcache restore that swallowed onclose: readyState CLOSED, handler never ran.
    const { p, s } = live()
    p.hide(); p.advance(60000); s.readyState = 3; p.pageshow(true)
    check(p.sockets.length === 2 && s.onclose === null, 'a CLOSED socket whose onclose never fired is dropped and replaced on revive')
    check(p.state().banner && p.state().banner.kind === 'reconnecting' && p.state().phase === 'live', 'that revive shows the reconnecting banner over the live screen')
  }
  {
    // A CLOSING socket is left to its onclose (it may carry a revoke/re-pair code).
    const { p, s } = live()
    s.readyState = 2; p.pageshow(true)
    check(p.sockets.length === 1 && s.onclose !== null, 'revive does not pre-empt a CLOSING socket')
  }
  {
    // Overdue deadline on a socket that is no longer OPEN: abort, do not re-probe.
    const { p, s } = live()
    p.advance(p.IDLE_PROBE_MS); s.readyState = 2; p.freeze(5 * 60000); p.advance(0)
    check(s.closed && p.sockets.length === 2, 'an overdue deadline on a non-OPEN socket aborts and reconnects')
  }
  {
    // Locked screen Retry with a socket still lingering must not be a dead button.
    const p = page(); p.client.start(); const s = p.last(); s.open()
    s.recv({ type: 'authFail', reason: 'locked', retryAfterMs: 1000 })
    check(p.state().phase === 'locked', 'authFail locked shows the locked screen')
    p.client.retry()
    check(s.closed && p.sockets.length === 2 && p.state().phase === 'connecting', 'retry aborts a lingering socket and connects again')
  }
  {
    const { p, s } = live(); s.autoPong = true
    p.pageshow(true); p.advance(1000)
    check(s.count('unsub') === 1, 'pageshow from the bfcache re-syncs')
    p.pageshow(false); p.advance(1000)
    check(s.count('unsub') === 1, 'a plain pageshow only probes')
  }
}

function testOffline() {
  const { p, s } = live()
  p.goOffline()
  check(p.state().online === false && p.health().tier === 'offline', 'the offline event shows the offline tier at once')
  s.drop(); p.advance(120000)
  check(p.sockets.length === 1, 'no attempts while the phone is offline')
  check(p.client.sendInput('x') === false, 'no input without a socket')
  p.goOnline()
  check(p.sockets.length === 2 && p.state().online === true, 'coming back online connects immediately')
  const p2 = page({ online: false }); p2.client.start()
  check(p2.sockets.length === 0 && p2.state().online === false, 'an offline boot does not attempt to connect')
  p2.goOnline(); check(p2.sockets.length === 1, 'the online event starts the first connection')
}

function testDesktopGone() {
  const { p, s } = live()
  s.recv({ type: 'shutdown', reason: 'quit' }); s.drop(1001)
  check(p.state().banner.kind === 'desktopGone' && p.state().connAttempt === 1, 'desktopGone survives the reconnect schedule, attempts count beside it')
  p.advance(500); p.last().drop(); p.advance(1000)
  check(p.state().banner.kind === 'desktopGone' && p.health().tier === 'desktopGone', 'desktopGone stays fixed across attempts')
  const n = p.last(); n.open(); n.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  check(p.state().banner === null && p.health().tier === 'ok', 'authOk clears desktopGone')
}

function testUpdated() {
  const session = new Map()
  {
    const { p, s } = live({ session }, '2.0.1')
    const info = p.state().updateInfo
    check(p.state().phase === 'updated' && info.from === '2.0.0' && info.to === '2.0.1' && info.kind === 'mismatch' && !info.retried, 'a newer desktop parks the phone on the updated screen')
    check(s.closed && !p.client.isOpen(), 'the socket is closed on entering updated')
    check(session.get(p.RELOAD_FOR_KEY) === '2.0.1', 'the reload guard is stored in sessionStorage')
    s.onmessage = null
    p.advance(70000); p.goOnline(); p.show(); p.pageshow(true); p.client.reconnectNow(); p.advance(70000)
    check(p.state().phase === 'updated' && p.sockets.length === 1, 'updated is stable: no reconnect, trigger or retry leaves it')
  }
  {
    // The handler guard: a state frame that raced the close never takes the phone live.
    const p = page({ session: new Map() }); p.client.start(); const s = p.last(); s.open()
    const onmessage = s.onmessage
    s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: '9.9.9' })
    onmessage({ data: JSON.stringify({ v: 1, type: 'state', state: snapshot }) })
    check(p.state().phase === 'updated', 'a late state frame from the closed socket is dropped')
    p.client.handleState(snapshot); p.client.scheduleReconnect(); p.advance(70000)
    check(p.state().phase === 'updated' && p.sockets.length === 1, 'handleState and scheduleReconnect no-op while updated')
  }
  {
    const { p } = live({ session }, '2.0.1')
    check(p.state().updateInfo.retried === true, 'the mismatch surviving a reload is flagged')
    p.client.continueAnyway()
    const s = p.last(); check(p.sockets.length === 2 && p.state().phase === 'connecting', 'Continue anyway reconnects')
    s.open(); s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: '2.0.1' })
    check(p.state().phase === 'live', 'Continue anyway goes live despite the mismatch')
  }
  {
    const p = page({ session: new Map() }); p.client.start(); const s = p.last(); s.open()
    s.recv({ type: 'err', code: 'version' })
    const info = p.state().updateInfo
    check(p.state().phase === 'updated' && info.kind === 'protocol' && s.closed, "err:'version' enters updated as a protocol mismatch")
    p.client.continueAnyway(); p.advance(30000)
    check(p.state().phase === 'updated' && p.sockets.length === 1, 'a protocol mismatch cannot continue anyway')
  }
  for (const v of ['dev', '']) {
    const { p } = live({ session: new Map() }, v)
    check(p.state().phase === 'live', `desktop version "${v}" never counts as a mismatch`)
  }
  {
    const s2 = new Map([['snagentsos.reloadFor', '2.0.1']])
    const { p } = live({ session: s2 })
    check(p.state().phase === 'live' && !s2.has('snagentsos.reloadFor'), 'a matching authOk clears the reload guard')
  }
}

// --- M1: agent status on the phone (E1-FR-03..07, 40) ---

const MIN = 60000
const st = (state, rest = {}) => ({ state, stateSince: 0, ...rest })
const multi = () => ({
  language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, keyButtons: [], activeWorkspaceId: 'w1',
  workspaces: [
    { id: 'w1', name: 'Front', layoutOrder: ['a2', 'a1'], panes: [
      { id: 'a1', title: 'A1', type: 'claude', running: true, status: st('working') },
      { id: 'a2', title: 'A2', type: 'claude', running: true },
    ] },
    { id: 'w2', name: 'Back', layoutOrder: ['b1', 'b2', 'b3'], panes: [
      { id: 'b1', title: 'B1', type: 'claude', running: true, status: st('action', { reason: 'permission' }) },
      { id: 'b2', title: 'B2', type: 'claude', running: false },
      { id: 'b3', title: 'B3', type: 'codex', running: true },
    ] },
  ],
})

function testStatusText(p) {
  p.setLang('en')
  const now = 10 * 24 * 60 * MIN
  const ages = [[0, 'now'], [59000, 'now'], [MIN, '1m'], [59 * MIN, '59m'], [60 * MIN, '1h'], [23 * 60 * MIN + 59 * MIN, '23h'], [24 * 60 * MIN, '1d'], [3 * 24 * 60 * MIN, '3d']]
  for (const [ago, want] of ages) check(p.relativeAge(now - ago, now) === want, `relativeAge ${ago}ms = ${want}`)
  check(p.relativeAge(now + 5 * MIN, now) === 'now', 'a stateSince in the future clamps to now')
  check(p.statusLine(st('action', { reason: 'permission' }), now) === 'Waiting for permission', 'reason permission')
  check(p.statusLine(st('action', { reason: 'question' }), now) === 'Question', 'reason question')
  check(p.statusLine(st('action', { reason: 'plan' }), now) === 'Approve plan', 'reason plan')
  check(p.statusLine(st('action', { reason: 'elicitation' }), now) === 'Waiting for an answer', 'reason elicitation')
  check(p.statusLine(st('working', { stateSince: now - 2 * MIN }), now) === 'Working 2m', 'working with its age')
  check(p.statusLine(st('working', { stateSince: now - 5000 }), now) === 'Working', 'fresh working has no age')
  check(p.statusLine(st('done', { stateSince: now - 3 * MIN }), now) === 'Done 3m ago', 'done 3 minutes ago')
  check(p.statusLine(st('done', { stateSince: now - 3 * MIN }), now + 60000) === 'Done 4m ago', 'two 30s ticks later 3m reads 4m')
  check(p.statusLine(st('done', { stateSince: now + MIN }), now) === 'Done just now', 'a future done clamps to just now')
  check(p.statusLine(st('error', { reason: 'failure' }), now) === 'Error', 'a failure reason reads as Error')
  check(p.statusLine(st('idle'), now) === 'Idle', 'idle')
  check(p.showsTime(st('working')) && p.showsTime(st('done')) && !p.showsTime(st('idle')) && !p.showsTime(st('action', { reason: 'plan' })) && !p.showsTime(undefined), 'only working/done without a reason drive the ticker')
  check(p.statusAriaLabel(st('working')) === 'Claude: working', 'aria label "Claude: working"')
  check(p.statusAriaLabel(st('done', { provider: 'codex', precise: false })) === 'Codex: done (approximate)', 'approximate suffix only for precise:false')
  p.setLang('es')
  check(p.statusAriaLabel(st('working')) === 'Claude: trabajando', 'aria label "Claude: trabajando"')
  check(p.statusLine(st('action', { reason: 'permission' }), now) === 'Esperando permiso' && p.statusLine(st('done', { stateSince: now - 3 * MIN }), now) === 'Listo hace 3m', 'Spanish second line')
  p.setLang('en')
}

function testInPageAlerts(p) {
  let clock = 0, visible = true, enabled = true
  const active = 'a', shown = [], vib = []
  const alerts = p.createInPageAlerts({
    now: () => clock, isVisible: () => visible, enabled: () => enabled, activePaneId: () => active,
    describe: id => ({ ws: 'W', pane: id.toUpperCase() }), show: t => shown.push(t), vibrate: ms => vib.push(ms),
  })
  const action = st('action', { reason: 'permission' })
  check(alerts.onPaneStatus('b', st('working'), action) && shown.at(-1) === 'W / B: Waiting for permission' && vib.join() === '80', 'another pane entering action shows "{ws} / {pane}: reason" and vibrates 80ms')
  check(!alerts.onPaneStatus('b', action, action), 'staying in action is not a transition')
  clock += 3000; shown.length = 0; vib.length = 0
  check(!alerts.onPaneStatus('a', st('working'), action) && shown.length === 0, 'the viewed pane entering action never alerts')
  alerts.onPaneStatus('c', undefined, action); clock += 300
  alerts.onPaneStatus('d', st('idle'), st('action')); clock += 300
  alerts.onPaneStatus('e', st('done'), action)
  check(shown.at(-1) === '3 consoles are waiting for you' && vib.length === 1, 'three panes in 1s make one alert: "3 consoles are waiting for you", one vibration')
  alerts.onPaneStatus('c', st('working'), action)
  check(shown.at(-1) === '3 consoles are waiting for you', 'the same pane is counted once per window')
  clock += 3000; shown.length = 0
  alerts.onPaneStatus('f', st('working'), st('action'))
  check(shown.at(-1) === 'W / F: Waiting for you' && vib.length === 2, 'after the 3s window a new single alert (no reason = Waiting for you)')
  clock += 3000; shown.length = 0; visible = false
  check(!alerts.onPaneStatus('g', st('working'), action) && shown.length === 0, 'no alert while the page is hidden')
  visible = true; enabled = false
  check(!alerts.onPaneStatus('g', st('working'), action) && shown.length === 0, 'no alert with inPageAlerts off')
  enabled = true
  check(!alerts.onPaneStatus('g', action, null) && !alerts.onPaneStatus('g', undefined, st('done')), 'only transitions into action alert')
}

function testWorkspaceSelectors(p) {
  const snap = multi()
  const map = p.statusMapOf(snap)
  check(Object.keys(map).join() === 'a1,b1', 'statusMapOf rebuilds the map from panes[].status')
  check(p.viewedWorkspaceId(snap, 'b2') === 'w2' && p.viewedWorkspaceId(snap, null) === 'w1' && p.viewedWorkspaceId(snap, 'gone') === 'w1', 'viewedWorkspaceId = workspace of the viewed pane, else the active one')
  check(!p.needsWorkspaceSwitch(snap, 'w2', 'b1'), 'a running pane of another workspace needs no switch')
  check(p.needsWorkspaceSwitch(snap, 'w2', 'b2'), 'a pane without a pty in another workspace needs the switch')
  check(p.needsWorkspaceSwitch(snap, 'w2', 'new'), 'a pane missing from the snapshot needs the switch to its workspace')
  check(!p.needsWorkspaceSwitch(snap, 'w1', 'new') && p.needsWorkspaceSwitch(null, 'w1', 'a1'), 'a new pane of the shown workspace needs none; no snapshot always switches')
  const statuses = { a1: st('action'), a2: st('action'), b1: st('action'), b3: st('working') }
  check(p.waitingPanes(snap, statuses, null).map(r => r.paneId).join() === 'a2,a1,b1', 'waiting panes follow workspace then layoutOrder')
  check(p.waitingPanes(snap, statuses, 'a1').length === 2, 'the viewed pane is not counted')
  check(p.nextWaitingPane(snap, statuses, 'a1').paneId === 'b1', 'next waiting after a1 is b1')
  check(p.nextWaitingPane(snap, statuses, 'b1').paneId === 'a2', 'the cycle wraps to the first workspace')
  check(p.nextWaitingPane(snap, statuses, 'b3').paneId === 'a2', 'from a non-waiting pane the next one in order')
  check(p.nextWaitingPane(snap, { a1: st('action') }, 'a1') === null, 'nothing else waiting = null')
}

async function testClientStatus() {
  const p = page(); p.client.start()
  const s = p.last(); s.open()
  s.recv({ type: 'authOk', deviceId: 'dev1', state: multi(), hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  check(p.state().paneStatus.b1.state === 'action' && p.state().paneStatus.a1.state === 'working', 'authOk rebuilds the status map')
  check(p.state().toast === null && p.vibrations.length === 0, 'an authOk snapshot with panes in action never alerts')
  s.recv({ type: 'paneStatus', paneId: 'b3', status: st('action', { reason: 'question' }) })
  check(p.state().paneStatus.b3.reason === 'question', 'paneStatus upserts')
  check(p.state().toast === 'Back / B3: Question' && p.vibrations.length === 1, 'a paneStatus into action of a non-viewed pane alerts')
  s.recv({ type: 'paneStatus', paneId: 'b3', status: null })
  check(!('b3' in p.state().paneStatus), 'paneStatus null deletes')
  s.recv({ type: 'paneStatus', paneId: 'ghost', status: st('action') })
  check(p.state().paneStatus.ghost && p.vibrations.length === 1, 'an orphan upsert is kept but never alerts')
  const next = multi(); next.workspaces[1].panes[0].status = undefined
  s.recv({ type: 'state', state: next })
  check(!p.state().paneStatus.ghost && !p.state().paneStatus.b1, 'a state frame rebuilds the map and drops orphans')
  check(p.vibrations.length === 1, 'a state frame never alerts')

  // switchWorkspaceAndView (E1-FR-07): running panes never move the desktop.
  const ctls = () => s.sent.filter(m => m.type === 'ctl')
  void p.client.switchWorkspaceAndView('w2', 'b1')
  check(ctls().length === 0 && s.sent.at(-1).type === 'sub' && s.sent.at(-1).paneId === 'b1', 'opening a running pane of another workspace only subscribes')
  check(p.state().activePaneId === 'b1', 'the phone views b1 on its own')
  const opening = p.client.switchWorkspaceAndView('w2', 'b2')
  check(ctls().length === 1 && ctls()[0].action.kind === 'switchWorkspace' && ctls()[0].action.workspaceId === 'w2', 'a pane with running:false sends switchWorkspace first')
  s.recv({ type: 'ctlAck', id: ctls()[0].id, ok: true })
  await opening
  check(p.state().activePaneId === 'b2' && s.sent.at(-1).paneId === 'b2', 'after the ack the pane is subscribed and viewed')

  // b2 closes on the desktop while viewed: fall back inside its workspace (w2), not the desktop's w1.
  const closed = multi(); closed.workspaces[1].panes = closed.workspaces[1].panes.filter(x => x.id !== 'b2')
  closed.workspaces[1].layoutOrder = ['b1', 'b3']
  s.recv({ type: 'state', state: closed })
  check(['b1', 'b3'].includes(p.state().activePaneId), 'a vanished pane falls back inside the viewed workspace')
  const gone = multi(); gone.workspaces = [gone.workspaces[0]]
  s.recv({ type: 'state', state: gone })
  check(['a1', 'a2'].includes(p.state().activePaneId), 'a vanished workspace falls back to the desktop active one')
  p.state().setInPageAlerts(false)
  check(p.local.get('snagentsos.alerts.inPage') === '0' && p.IN_PAGE_ALERTS_KEY === 'snagentsos.alerts.inPage', 'the preference persists under snagentsos.alerts.inPage')
  s.recv({ type: 'paneStatus', paneId: 'a2', status: st('working') })
  s.recv({ type: 'paneStatus', paneId: 'a2', status: st('action') })
  check(p.vibrations.length === 1, 'with the preference off a transition does not alert')
}

/**
 * A fake History: `depth` = entries above the live root. back() and go(n)
 * queue a traversal like the real API; settle() runs them, one popstate each.
 */
function fakeHistory() {
  const h = { depth: 0, pushes: [], backs: 0, gos: [], queue: [] }
  h.pushState = state => { h.depth++; h.pushes.push(state.snagentsos) }
  h.back = () => { h.backs++; h.queue.push(-1) }
  h.go = n => { h.gos.push(n); h.queue.push(n) }
  h.settle = stack => {
    while (h.queue.length) { h.depth = Math.max(0, h.depth + h.queue.shift()); stack.onPopState() }
  }
  /** The user presses the browser / Android back. */
  h.userBack = stack => { h.depth = Math.max(0, h.depth - 1); stack.onPopState() }
  return h
}

function testBackStack(p) {
  // Double pop: closing from the UI pops once; the popstate it causes closes nothing else.
  let h = fakeHistory(), closed = []
  let stack = p.createBackStack(h)
  stack.push('a', () => closed.push('a'))
  check(h.pushes.join() === 'a' && h.depth === 1, 'a claim pushes one entry {snagentsos:id}')
  stack.requestClose('a')
  check(h.backs === 1 && closed.length === 0, 'closing from the UI calls history.back() once and not onClose')
  h.settle(stack)
  check(closed.length === 0 && stack.size() === 0 && h.depth === 0, 'its popstate is consumed: no double pop, nothing else closes')
  stack.requestClose('a')
  check(h.backs === 1, 'a second requestClose of the same claim is a no-op')

  // Two claims: back closes only the newest.
  h = fakeHistory(); closed = []
  stack = p.createBackStack(h)
  stack.push('drawer', () => closed.push('drawer'))
  stack.push('actions', () => closed.push('actions'))
  check(h.depth === 2, 'two stacked sheets own two entries')
  h.userBack(stack)
  check(closed.join() === 'actions' && stack.has('drawer') && !stack.has('actions'), 'one back closes only the top sheet')
  h.userBack(stack)
  check(closed.join() === 'actions,drawer' && stack.size() === 0 && h.depth === 0, 'the next back closes the one below')
  h.userBack(stack)
  check(closed.length === 2, 'a back with nothing claimed closes nothing (the browser leaves the app)')

  // Closing the lower of two from the UI keeps the count exact.
  h = fakeHistory(); closed = []
  stack = p.createBackStack(h)
  stack.push('drawer', () => closed.push('drawer'))
  stack.push('actions', () => closed.push('actions'))
  stack.requestClose('drawer')
  h.settle(stack)
  check(stack.has('actions') && !stack.has('drawer') && h.depth === 1 && closed.length === 0, 'closing the lower sheet from the UI keeps one entry for the top one')
  h.userBack(stack)
  check(closed.join() === 'actions' && h.depth === 0, 'and back still closes the top one')

  // Close one sheet and open the next in the same tick: the push waits for the pop.
  h = fakeHistory(); closed = []
  stack = p.createBackStack(h)
  stack.push('actions', () => closed.push('actions'))
  stack.requestClose('actions')
  stack.push('confirm', () => closed.push('confirm'))
  check(h.pushes.join() === 'actions', 'a push issued while a back is in flight is deferred')
  h.settle(stack)
  check(h.pushes.join() === 'actions,confirm' && h.depth === 1 && stack.has('confirm'), 'it lands after the popstate, keeping one entry per claim')
  h.userBack(stack)
  check(closed.join() === 'confirm', 'and back then closes the new sheet, not nothing')
  stack.push('x', () => closed.push('x'))
  stack.requestClose('x')
  stack.push('y', () => closed.push('y'))
  stack.requestClose('y')
  h.settle(stack)
  check(h.pushes.at(-1) === 'x' && stack.size() === 0 && h.depth === 0, 'a deferred claim closed before it reached history pushes nothing')

  // orphanAll: the host unmounts (phase change) with claims open.
  h = fakeHistory(); closed = []
  stack = p.createBackStack(h)
  stack.push('drawer', () => closed.push('drawer'))
  stack.push('actions', () => closed.push('actions'))
  const n = stack.orphanAll()
  check(n === 2 && h.gos.join() === '-2' && stack.size() === 0, 'orphanAll drops every claim and calls history.go(-n)')
  h.settle(stack)
  check(closed.length === 0 && h.depth === 0, 'orphaned claims do not run onClose and leave no entry behind (one back exits)')
  h = fakeHistory()
  stack = p.createBackStack(h)
  stack.push('a', () => {}); stack.push('b', () => {}); stack.requestClose('b')
  check(stack.orphanAll() === 1 && h.gos.join() === '-1', 'a claim already closing is not counted twice')
  h.settle(stack)
  check(h.depth === 0, 'the in-flight back plus go(-1) clear both entries')
  check(p.createBackStack(fakeHistory()).orphanAll() === 0, 'nothing open: no traversal')
}

function testLongPress(p) {
  const fired = [], vib = []
  const lp = p.createLongPress(() => fired.push(p.clock), { vibrate: ms => vib.push(ms) })
  check(p.LONG_PRESS_MS === 450 && p.LONG_PRESS_SLOP_PX === 10 && p.LONG_PRESS_VIBRATE_MS === 10, 'one long-press constant: 450ms, 10px slop, 10ms buzz')
  const t0 = p.clock
  lp.down({ clientX: 0, clientY: 0, pointerId: 1 })
  p.advance(449)
  check(fired.length === 0, 'nothing at 449ms')
  p.advance(1)
  check(fired.length === 1 && fired[0] - t0 === 450 && vib.join() === '10', 'fires at 450ms and vibrates 10ms')
  check(lp.up() === true && lp.consumeFired() === true && lp.consumeFired() === false, 'the click after a fired hold is swallowed once')

  lp.down({ clientX: 0, clientY: 0, pointerId: 1 })
  lp.move({ clientX: 6, clientY: 6, pointerId: 1 })
  p.advance(500)
  check(fired.length === 2, 'moving 8.5px stays within the slop and still fires')
  lp.up()
  lp.down({ clientX: 0, clientY: 0, pointerId: 1 })
  lp.move({ clientX: 0, clientY: 11, pointerId: 1 })
  p.advance(500)
  check(fired.length === 2 && lp.up() === false, 'moving more than 10px cancels it (a scroll)')
  lp.down({ clientX: 0, clientY: 0, pointerId: 1 })
  p.advance(300); lp.up(); p.advance(300)
  check(fired.length === 2 && lp.consumeFired() === false, 'lifting early is a plain tap: the click goes through')
  lp.down({ clientX: 0, clientY: 0, pointerId: 1 })
  p.advance(100); lp.cancel(); p.advance(500)
  check(fired.length === 2, 'pointercancel stops the timer')
  lp.down({ clientX: 0, clientY: 0, pointerId: 1 })
  lp.move({ clientX: 50, clientY: 50, pointerId: 2 })
  p.advance(450)
  check(fired.length === 3, 'another finger moving does not cancel the press')
  lp.up()
}

function testSheetDrag(p) {
  const d = p.sheetDrag
  check(d.DISMISS_PX === 80 && d.DISMISS_VELOCITY === 500 && d.SPRING_MS === 200 && d.CLOSE_MIN_MS === 120 && d.CLOSE_MAX_MS === 300 && d.UNMOUNT_FALLBACK_MS === 350, 'sheet constants match the contract')
  check(d.shouldDismiss(100, 0) && !d.shouldDismiss(40, 100) && d.shouldDismiss(40, 900), '100px closes, a slow 40px springs back, a fast 40px flick closes')
  const slow = Array.from({ length: 11 }, (_, i) => ({ t: i * 40, y: 200 + i * 4 }))
  check(Math.round(d.releaseVelocity(slow, 400)) === 100, 'release speed is measured over the last 100ms (4px / 40ms = 100px/s)')
  const flick = [{ t: 0, y: 200 }, { t: 500, y: 200 }, { t: 520, y: 215 }, { t: 540, y: 240 }]
  check(d.releaseVelocity(flick, 540) === 1000, 'a late flick after a pause still reads fast (40px in 40ms)')
  check(d.releaseVelocity(slow, 600) === 0 && d.releaseVelocity([{ t: 0, y: 0 }], 0) === 0, 'a resting finger or a single sample is 0px/s')
  check(d.closeDurationMs(300, 1000) === 300 && d.closeDurationMs(300, 5000) === 120 && d.closeDurationMs(200, 1000) === 200, 'exit duration follows the speed, clamped to 120..300ms')
  check(d.closeDurationMs(400, 0) === d.CLOSE_DEFAULT_MS, 'a close without a drag uses the default duration')
  check(d.canDragFromContent({ scrollTop: 0, dy: 10, inputFocused: false }), 'content drags at the top, moving down')
  check(!d.canDragFromContent({ scrollTop: 120, dy: 10, inputFocused: false }), 'a list scrolled halfway scrolls instead of closing')
  check(!d.canDragFromContent({ scrollTop: 0, dy: -10, inputFocused: false }) && !d.canDragFromContent({ scrollTop: 0, dy: 10, inputFocused: true }), 'never moving up nor with a field focused')
  check(d.backdropOpacity(0, 400) === 1 && d.backdropOpacity(200, 400) === 0.5 && d.backdropOpacity(800, 400) === 0, 'the backdrop fades with the drag')
}

function testTabsAndActions(p) {
  check(p.tabTitle('Short') === 'Short' && p.tabTitle('  padded  ') === 'padded', 'short titles stay whole')
  const cut = p.tabTitle('A very long console title here')
  check(Array.from(cut).length === 18 && cut.endsWith('…'), 'titles are cut to 18 characters with an ellipsis')
  check(Array.from(p.tabTitle('\u{1F680}'.repeat(30))).length === 18, 'the cut counts code points, never splits a surrogate pair')
  const snap = multi(); snap.workspaces[1].layoutOrder = ['b3', 'b1']
  const tabs = p.tabPanes(snap, 'b1')
  check(tabs.workspaceId === 'w2' && tabs.panes.map(x => x.id).join() === 'b3,b1,b2', 'tabs list the viewed workspace in layoutOrder, then the rest')
  check(p.tabPanes(snap, null).workspaceId === 'w1', 'with nothing viewed the tabs follow the desktop workspace')

  check(p.paneActionIds({ resumable: true }).join() === 'rename,restart,restartResume,restartFresh,close', 'a resumable pane offers Relaunch resuming and New chat')
  check(p.paneActionIds({}).join() === 'rename,restart,close' && p.paneActionIds({ resumable: false }).join() === 'rename,restart,close', 'without resumable (SSH, no session, old desktop) both are hidden')
  check(p.paneActionIds({ resumable: true }, { rename: false })[0] === 'restart', 'the main sheet omits Rename')
  check(JSON.stringify(p.restartAction('w', 'p', 'restartResume')) === '{"kind":"restartPane","workspaceId":"w","paneId":"p","resume":true}', 'Relaunch resuming sends restartPane resume:true')
  check(JSON.stringify(p.restartAction('w', 'p', 'restartFresh')) === '{"kind":"restartPane","workspaceId":"w","paneId":"p","resume":false}', 'New chat sends restartPane resume:false')
  check(!('resume' in p.restartAction('w', 'p', 'restart')), 'plain Restart sends no resume (the header button rule)')
}

async function main() {
  const p = page({ paired: false })
  testPure(p)
  testStatusText(p)
  testInPageAlerts(p)
  testWorkspaceSelectors(p)
  testBackStack(p)
  testLongPress(page())
  testSheetDrag(p)
  testTabsAndActions(p)
  await testClientStatus()
  testGeneration()
  testBackoff()
  testLiveness()
  testOffline()
  testDesktopGone()
  testUpdated()
  console.log(`PASS: ${checks} mobile logic checks`)
}

main().catch(error => { console.error(error); process.exit(1) })
