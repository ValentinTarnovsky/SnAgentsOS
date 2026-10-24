// Pure logic of the phone client, run in node:vm with fake browser globals.
// Section M2 (E1-FR-10..15, 41): endpointHint, delayFor, classifyConnection and
// the socket generation / liveness / revive / updated state machine of
// src/mobile/src/lib/client.ts driven by a fake WebSocket and a fake clock.
// Section M1 (E1-FR-03..07): statusText, the workspace selectors and
// paneStatus handling.
// Section M9 (E2-FR-42..44, 52; R22-18): the page notifier (toasts with [Go],
// vibration, title), deep links, snagentsos.prefs and visibility frames.
// Section M6 (E2-FR-03..06, 16, 47; R22-14): phone-only navigation (openPane,
// the mount confirmation, mountAndOpen), goLive picking a deep link > lastPane
// > nothing, a closed viewed pane going back to Home, Home row order and
// unread, the row second line, lastViewed LRU and the collapsed sections.
// Section M4 (E1-FR-24, 28): sendInput chunking, draft pruning on the first
// authOk and the composer storage wipe on 4403, revoked and unpair.
// Section M5 (E1-FR-32..36, 39; E5-FR-11): backStack with a fake history,
// createLongPress under fake timers, the sheet drag math, tab order and
// titles, and which per-pane actions show for a resumable pane.
// Section M10 (app 2.7.0, A8): the phone counts "needs you" with the
// desktop's rule (src/shared/attention.ts) in the title, the workspace badge,
// the waiting pill and Home's "Waiting for you"; Mark all read targets; the
// row signals (doing now, failure, silence, needs, context, bare); the status
// marks of the pane actions, gated to a 2.7.0 desktop; the plan sheet outcomes.
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
export { client, RELOAD_FOR_KEY, IDLE_PROBE_MS, PONG_TIMEOUT, CONNECT_TIMEOUT_MS, REVIVE_PROBE_TIMEOUT, AWAIT_NEW_PANE_MS } from './src/mobile/src/lib/client'
export { store } from './src/mobile/src/lib/store'
export { classifyConnection, endpointHint, formatAgo } from './src/mobile/src/lib/connectionHealth'
export { delayFor, RECONNECT_DELAYS } from './src/mobile/src/lib/reconnectSchedule'
export { relativeAge, statusLine, statusAriaLabel, showsTime, rowLine, rowShowsTime, doingNow, failureText, silenceText, needsText, contextShort, contextLabel, agentStatusOf } from './src/mobile/src/lib/statusText'
export { createPaneNotifier, remoteTitle, actionTotal } from './src/mobile/src/lib/notify'
export { parseDeepLink } from './src/mobile/src/lib/deepLink'
export { loadPagePrefs, savePagePrefs } from './src/mobile/src/lib/prefs'
export { viewedWorkspaceId, paneOpenable, isWorkspaceMounted, homeRows, isUnread, actionCount, waitingPanes, nextWaitingPane, statusMapOf, attentionItems, needsYouPanes, markReadTargets } from './src/mobile/src/lib/workspace'
export { needsYouRows, needsYouCount } from './src/shared/attention'
export { planLoadOf } from './src/mobile/src/lib/plan'
export { statusMarkIds, statusMarkAction, statusMarksSupported } from './src/mobile/src/lib/paneActions'
export { withViewed, LAST_VIEWED_MAX } from './src/mobile/src/lib/prefs'
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
  const mapStorage = map => ({ get length() { return map.size }, key: i => [...map.keys()][i] ?? null, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) })
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
    history: { state: null, replaceState: (_s, _t, url) => { location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '' } }, crypto: require('node:crypto').webcrypto, TextEncoder, TextDecoder,
  })
  const api = mod.exports
  const fire = (bag, type, ev = {}) => (bag[type] || []).forEach(fn => fn(ev))
  return {
    ...api, sockets, session, timers, vibrations, local, document,
    get hash() { return location.hash },
    setHash: h => { location.hash = h; fire(listeners.win, 'hashchange') },
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
  // E2-FR-01: going live lands on Home with nothing viewed; open the console.
  if (p.state().phase === 'live') p.client.openPane('p')
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

// Section M9 (E2-FR-42..44, 52; R22-18): page toasts, deep links, page prefs, visibility.
function testPaneNotifier(p) {
  const cs = (state, rest = {}) => st(state, { provider: 'claude', ...rest })
  p.setLang('en')
  let visible = true, screen = 'terminal', active = 'a'
  const prefs = { toasts: true, vibrate: true, toastDone: false }
  const shown = [], vib = []
  const n = p.createPaneNotifier({
    isVisible: () => visible, prefs: () => ({ ...prefs }), screen: () => screen, activePaneId: () => active,
    describe: id => ({ ws: 'W', pane: id.toUpperCase() }), show: t => shown.push(t), vibrate: pat => vib.push(pat.join()),
  })
  const action = cs('action', { reason: 'permission', stateSince: 10 })
  check(n.onPaneStatus('b', cs('working'), action) === 'toast' && shown.at(-1).text === 'Claude W / B: Waiting for permission' && shown.at(-1).kind === 'action' && shown.at(-1).paneId === 'b', 'in a terminal, another console entering action toasts "<Claude> <ws / console>: <reason>" with its pane for [Go]')
  check(vib.join('|') === '60,40,60', 'and vibrates [60, 40, 60]')
  check(n.onPaneStatus('b', action, action) === null, 'staying in action is not a transition')
  check(n.onPaneStatus('b', cs('working'), action) === null && shown.length === 1, 'the same paneId:stateSince never alerts twice')
  check(n.onPaneStatus('a', cs('working'), cs('action', { stateSince: 11 })) === null && shown.length === 1 && vib.length === 1, 'the console on screen never alerts')
  check(n.onPaneStatus('c', cs('working'), cs('error', { provider: 'codex', stateSince: 12 })) === 'toast' && shown.at(-1).text === 'Codex W / C: Error' && shown.at(-1).kind === 'error' && vib.length === 2, 'error toasts and vibrates too (Codex)')
  check(n.onPaneStatus('d', cs('working'), cs('done', { stateSince: 13 })) === null && shown.length === 2, 'done stays quiet while "Alert when a turn ends" is off')
  prefs.toastDone = true
  check(n.onPaneStatus('e', cs('working'), cs('done', { stateSince: 14 })) === 'toast' && shown.at(-1).kind === 'done' && shown.at(-1).text === 'Claude W / E: Done' && vib.length === 2, 'with it on, done toasts without vibrating')
  screen = 'home'
  check(n.onPaneStatus('f', cs('working'), cs('action', { stateSince: 15 })) === 'vibrate' && shown.length === 3 && vib.length === 3, 'on Home: no toast, only the vibration')
  check(n.onPaneStatus('g', cs('working'), cs('done', { stateSince: 16 })) === null, 'on Home a done does nothing')
  screen = 'terminal'; prefs.vibrate = false
  check(n.onPaneStatus('h', cs('working'), cs('action', { stateSince: 17 })) === 'toast' && vib.length === 3, 'Vibrate off: the toast alone')
  prefs.toasts = false; prefs.vibrate = true
  check(n.onPaneStatus('i', cs('working'), cs('action', { stateSince: 18 })) === 'vibrate' && shown.length === 4, 'On-screen alerts off: only the vibration')
  prefs.toasts = true; visible = false
  check(n.onPaneStatus('j', cs('working'), cs('action', { stateSince: 19 })) === null && shown.length === 4 && vib.length === 4, 'nothing while the page is hidden')
  visible = true
  check(n.onPaneStatus('k', cs('working'), cs('action', { provider: undefined, stateSince: 20 })) === 'toast' && shown.at(-1).text === 'W / K: Waiting for you', 'without a provider the agent name is left out')
  check(n.onPaneStatus('k', cs('action'), null) === null && n.onPaneStatus('k', undefined, cs('working')) === null, 'clears and working never alert')
  check(p.remoteTitle(0) === 'SnAgentsOS Remote' && p.remoteTitle(3) === '(3) SnAgentsOS Remote', 'document title: "(N) SnAgentsOS Remote", bare at 0')
  check(p.actionTotal(multi(), { a1: st('action'), b1: st('action'), b3: st('working'), ghost: st('action') }) === 2 && p.actionTotal(null, {}) === 0, 'actionTotal counts consoles in action in the snapshot only')
  // v2.3 attention: an answered action (attention false) is no longer waiting on anybody.
  check(p.actionTotal(multi(), { a1: st('action', { attention: false }), b1: st('action', { attention: true }) }) === 1, 'actionTotal skips an action the desktop says was answered')
  check(p.remoteTitle(p.actionTotal(multi(), { b1: st('action', { attention: false }) })) === 'SnAgentsOS Remote', 'so the title drops the "(1)"')
  const before = shown.length
  check(n.onPaneStatus('z', cs('working'), cs('action', { stateSince: 30, attention: false })) === null && n.onPaneStatus('y', cs('working'), cs('done', { stateSince: 31, attention: false })) === null && shown.length === before, 'a status already seen elsewhere (attention false) never toasts nor vibrates')
  check(n.onPaneStatus('x', cs('working'), cs('action', { stateSince: 32, attention: true })) === 'toast', 'attention true alerts as before')

  // Deep links (E2-FR-42).
  check(JSON.stringify(p.parseDeepLink('#ws=w1&pane=p1')) === '{"ws":"w1","pane":"p1"}', 'parseDeepLink reads #ws=&pane=')
  check(p.parseDeepLink('#x=1&ws=w%201&pane=p%261').pane === 'p&1' && p.parseDeepLink('#x=1&ws=w%201&pane=p%261').ws === 'w 1', 'ids are URI-decoded and other keys may come first')
  check(p.parseDeepLink('#pair=AB12&ws=w&pane=p') === null && p.parseDeepLink('#ws=w&pane=p&pair=AB12') === null, 'a pair= hash always wins: no deep link')
  check(p.parseDeepLink('') === null && p.parseDeepLink('#pane=p&ws=w') === null && p.parseDeepLink('#ws=w') === null && p.parseDeepLink('#ws=%E0&pane=p') === null && p.parseDeepLink('#ws=w&pane=' + 'x'.repeat(129)) === null, 'empty, reordered, partial, malformed or oversized hashes are ignored')

  // Page prefs ('snagentsos.prefs', E2-FR-44), with the E1-FR-40 key as the toasts default.
  const q = page({ paired: false })
  check(JSON.stringify(q.loadPagePrefs()) === '{"toasts":true,"vibrate":true,"toastDone":false}', 'defaults: toasts on, vibrate on, turn end off')
  q.local.set('snagentsos.alerts.inPage', '0')
  check(q.loadPagePrefs().toasts === false, 'the old alerts.inPage switch seeds toasts')
  q.local.set('snagentsos.prefs', JSON.stringify({ version: 1, promptCards: false }))
  q.savePagePrefs({ toastDone: true })
  const saved = JSON.parse(q.local.get('snagentsos.prefs'))
  check(saved.version === 1 && saved.toasts === false && saved.vibrate === true && saved.toastDone === true && saved.promptCards === false, 'a save writes the whole object and keeps keys of other features')
  check(!q.local.has('snagentsos.alerts.inPage'), 'and retires the legacy key')
  q.local.set('snagentsos.prefs', '{broken')
  check(q.loadPagePrefs().vibrate === true, 'a corrupt object reads back as defaults')
}

/** Deep links, visibility, toasts vs vibration and the title through the real client (R22-18). */
async function testClientNotify() {
  // A link in the URL waits for the first goLive, beats lastPane, and the hash is cleared.
  const replaced = []
  {
    const p = page({ hash: '#ws=w2&pane=b1' })
    p.local.set('snagentsos.lastPane', 'a1')
    p.client.start()
    const s = p.last(); s.open()
    s.recv({ type: 'authOk', deviceId: 'dev1', state: multi(), hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
    check(p.state().activePaneId === 'b1' && p.state().screen === 'terminal' && s.sent.some(m => m.type === 'sub' && m.paneId === 'b1'), 'a pending deep link opens its console on the first goLive, before lastPane')
    check(p.hash === '', 'the hash was cleared with replaceState')
    check(!s.sent.some(m => m.type === 'ctl'), 'and never sends an action (no switchWorkspace, no mount)')
    const vis = s.sent.filter(m => m.type === 'visibility')
    check(vis.length === 1 && vis[0].visible === true, 'after auth the page reports visibility once')
    p.hide()
    check(s.sent.filter(m => m.type === 'visibility').at(-1).visible === false, 'hiding the page reports visible:false')
    p.show()
    check(s.sent.filter(m => m.type === 'visibility').at(-1).visible === true, 'and showing it reports visible:true')
  }
  {
    const p = page({ hash: '#ws=w2&pane=b2' })
    p.client.start()
    const s = p.last(); s.open()
    s.recv({ type: 'authOk', deviceId: 'dev1', state: multi(), hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
    check(p.state().mountAsk === 'b2' && p.state().screen === 'home' && !s.sent.some(m => m.type === 'ctl'), 'a link to a workspace the desktop has not mounted asks first and never mounts alone')
  }
  {
    const p = page({ hash: '#ws=w9&pane=nope' })
    p.client.start()
    const s = p.last(); s.open()
    s.recv({ type: 'authOk', deviceId: 'dev1', state: multi(), hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
    check(p.state().screen === 'home' && p.state().toast === 'The console no longer exists', 'a link to a console that is gone stays on Home with the toast')
  }
  {
    const p = page({ paired: false, hash: '#pair=AB12CD34&ws=w2&pane=b1' })
    p.client.start()
    check(p.state().phase === 'pairForm', 'with pair= in the hash pairing wins')
  }

  // Live: hashchange applies at once; toasts in the terminal, vibration on Home; the title.
  const p = page()
  p.client.start()
  const s = p.last(); s.open()
  s.recv({ type: 'authOk', deviceId: 'dev1', state: multi(), hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  check(p.document.title === '(1) SnAgentsOS Remote', 'the title counts the consoles in action of the snapshot')
  check(p.vibrations.length === 0 && p.state().toasts.length === 0, 'the authOk snapshot never alerts')
  p.setHash('#ws=w1&pane=a1')
  check(p.state().activePaneId === 'a1' && p.state().screen === 'terminal', 'a hashchange while live opens the console at once')
  s.recv({ type: 'paneStatus', paneId: 'b3', status: st('action', { reason: 'question', stateSince: 50, provider: 'claude' }) })
  const toast = p.state().toasts.at(-1)
  check(toast && toast.text === 'Claude Back / B3: Question' && toast.paneId === 'b3' && toast.kind === 'action' && p.vibrations.at(-1).join() === '60,40,60', 'in the terminal another console in action toasts with [Go] and vibrates')
  check(p.document.title === '(2) SnAgentsOS Remote', 'the title follows a live paneStatus')
  s.recv({ type: 'paneStatus', paneId: 'a1', status: st('action', { stateSince: 51 }) })
  check(p.state().toasts.length === 1, 'the console on screen does not toast')
  p.client.leaveTerminal()
  const before = p.vibrations.length
  s.recv({ type: 'paneStatus', paneId: 'a2', status: st('error', { stateSince: 52 }) })
  check(p.state().toasts.length === 1 && p.vibrations.length === before + 1, 'on Home an error only vibrates')
  p.state().setPagePref('vibrate', false)
  s.recv({ type: 'paneStatus', paneId: 'b1', status: st('working', { stateSince: 53 }) })
  s.recv({ type: 'paneStatus', paneId: 'b1', status: st('action', { stateSince: 54 }) })
  check(p.vibrations.length === before + 1, 'Vibrate off: no vibration')
  check(JSON.parse(p.local.get('snagentsos.prefs')).vibrate === false, 'the choice persists in snagentsos.prefs')

  // v2.3: a console's toast goes once it changes state or the desktop says it no longer needs the user.
  {
    const q = page()
    q.client.start()
    const t = q.last(); t.open()
    t.recv({ type: 'authOk', deviceId: 'dev1', state: multi(), hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
    q.setHash('#ws=w1&pane=a1')
    t.recv({ type: 'paneStatus', paneId: 'b3', status: st('action', { reason: 'question', stateSince: 60, provider: 'codex', attention: true }) })
    t.recv({ type: 'paneStatus', paneId: 'a2', status: st('error', { stateSince: 61, attention: true }) })
    check(q.state().toasts.map(x => x.paneId).join() === 'b3,a2', 'two consoles toast')
    // app 2.7.0: the desktop's rule, so an error nobody saw (attention true) counts too.
    check(q.document.title === '(3) SnAgentsOS Remote', 'the title counts b1, b3 and the unseen error of a2')
    t.recv({ type: 'paneStatus', paneId: 'b3', status: st('action', { reason: 'question', stateSince: 60, provider: 'codex', attention: false }) })
    check(q.state().toasts.map(x => x.paneId).join() === 'a2', 'an attention flip drops that console\'s toast only')
    check(q.document.title === '(2) SnAgentsOS Remote', 'and the "(N)" follows')
    t.recv({ type: 'paneStatus', paneId: 'a2', status: st('working', { stateSince: 62, attention: false }) })
    check(q.state().toasts.length === 0, 'a state change drops the toast of that console')
    q.state().setToast('Sent')
    t.recv({ type: 'paneStatus', paneId: 'b1', status: st('working', { stateSince: 63 }) })
    check(q.state().toasts.length === 1 && q.state().toasts[0].text === 'Sent', 'a plain notice toast stays')
  }
}

function testWorkspaceSelectors(p) {
  const snap = multi()
  const map = p.statusMapOf(snap)
  check(Object.keys(map).join() === 'a1,b1', 'statusMapOf rebuilds the map from panes[].status')
  check(p.viewedWorkspaceId(snap, 'b2') === 'w2' && p.viewedWorkspaceId(snap, null) === null && p.viewedWorkspaceId(snap, 'gone') === null, 'viewedWorkspaceId = workspace of the viewed pane, never the desktop active one (E2-FR-47)')
  check(p.paneOpenable(snap, 'b1'), 'a running pane of another workspace opens as is')
  check(!p.paneOpenable(snap, 'b2'), 'a stopped pane of a workspace the desktop has not mounted needs the confirmation')
  check(!p.paneOpenable(snap, 'new'), 'a pane missing from the snapshot is not openable')
  snap.mountedWorkspaceIds = ['w1', 'w2']
  check(p.paneOpenable(snap, 'b2') && p.isWorkspaceMounted(snap, 'w2'), 'once w2 is mounted its stopped pane opens (the desktop shows or spawns it)')
  snap.mountedWorkspaceIds = []
  check(!p.isWorkspaceMounted(snap, 'w1'), 'mountedWorkspaceIds wins over activeWorkspaceId when present')
  const statuses = { a1: st('action'), a2: st('action'), b1: st('action'), b3: st('working') }
  check(p.waitingPanes(snap, statuses, null).map(r => r.paneId).join() === 'a2,a1,b1', 'waiting panes follow workspace then layoutOrder')
  check(p.waitingPanes(snap, statuses, 'a1').length === 2, 'the viewed pane is not counted')
  check(p.nextWaitingPane(snap, statuses, 'a1').paneId === 'b1', 'next waiting after a1 is b1')
  check(p.nextWaitingPane(snap, statuses, 'b1').paneId === 'a2', 'the cycle wraps to the first workspace')
  check(p.nextWaitingPane(snap, statuses, 'b3').paneId === 'a2', 'from a non-waiting pane the next one in order')
  check(p.nextWaitingPane(snap, { a1: st('action') }, 'a1') === null, 'nothing else waiting = null')
  // v2.3: an answered action (attention false) is not waiting; undefined keeps the old rule.
  const answered = { ...statuses, a2: st('action', { attention: false }), b1: st('action', { attention: true }) }
  check(p.waitingPanes(snap, answered, null).map(r => r.paneId).join() === 'a1,b1', 'waitingPanes skips an answered action')
  check(p.nextWaitingPane(snap, answered, 'b1').paneId === 'a1', 'nextWaitingPane skips it too')
  check(p.nextWaitingPane(snap, { a1: st('action', { attention: false }) }, null) === null, 'only answered actions = nobody waiting')
}

async function testClientStatus() {
  const p = page(); p.client.start()
  const s = p.last(); s.open()
  s.recv({ type: 'authOk', deviceId: 'dev1', state: multi(), hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  check(p.state().paneStatus.b1.state === 'action' && p.state().paneStatus.a1.state === 'working', 'authOk rebuilds the status map')
  check(p.state().toast === null && p.vibrations.length === 0, 'an authOk snapshot with panes in action never alerts')
  s.recv({ type: 'paneStatus', paneId: 'b3', status: st('action', { reason: 'question' }) })
  check(p.state().paneStatus.b3.reason === 'question', 'paneStatus upserts')
  check(p.state().toast === null && p.vibrations.length === 1, 'a paneStatus into action of a non-viewed pane vibrates (on Home no toast, E2-FR-43)')
  s.recv({ type: 'paneStatus', paneId: 'b3', status: null })
  check(!('b3' in p.state().paneStatus), 'paneStatus null deletes')
  s.recv({ type: 'paneStatus', paneId: 'ghost', status: st('action') })
  check(p.state().paneStatus.ghost && p.vibrations.length === 1, 'an orphan upsert is kept but never alerts')
  const next = multi(); next.workspaces[1].panes[0].status = undefined
  s.recv({ type: 'state', state: next })
  check(!p.state().paneStatus.ghost && !p.state().paneStatus.b1, 'a state frame rebuilds the map and drops orphans')
  check(p.vibrations.length === 1, 'a state frame never alerts')

  // Phone-only navigation (E2-FR-06): opening never sends switchWorkspace.
  const ctls = () => s.sent.filter(m => m.type === 'ctl')
  check(p.state().screen === 'home' && p.state().activePaneId === null, 'going live shows Home with nothing viewed (no pane picked from the desktop workspace)')
  check(p.client.openPane('b1') === 'open', 'openPane on a running pane of another workspace opens it')
  check(ctls().length === 0 && s.sent.at(-1).type === 'sub' && s.sent.at(-1).paneId === 'b1', 'it only subscribes: the desktop never moves')
  check(p.state().activePaneId === 'b1' && p.state().screen === 'terminal', 'the phone views b1 and the terminal slides in')
  check(p.state().lastPane === 'b1' && p.local.get('snagentsos.lastPane') === 'b1', 'it becomes lastPane (snagentsos.lastPane)')
  check(p.client.openPane('b2') === 'needsMount' && p.state().activePaneId === 'b1' && ctls().length === 0, 'a stopped pane of a workspace the desktop has not mounted answers needsMount and changes nothing')
  check(p.client.requestOpen('b2') === 'needsMount' && p.state().mountAsk === 'b2', 'requestOpen opens the confirmation (mountAsk)')
  check(p.client.requestOpen('nope') === 'gone' && p.state().toast === 'The console no longer exists', 'a pane that is not in the snapshot shows the toast')
  const opening = p.client.mountAndOpen('b2')
  check(ctls().length === 1 && ctls()[0].action.kind === 'mountWorkspace' && ctls()[0].action.workspaceId === 'w2', 'Start sends mountWorkspace for the pane workspace, never switchWorkspace')
  s.recv({ type: 'ctlAck', id: ctls()[0].id, ok: true, info: 3 })
  await opening
  check(p.state().activePaneId === 'b2' && s.sent.at(-1).paneId === 'b2' && p.state().screen === 'terminal', 'after the ack the pane is subscribed and viewed')
  const failing = p.client.mountAndOpen('b2')
  s.recv({ type: 'ctlAck', id: ctls().at(-1).id, ok: false, error: 'not_found' })
  await failing
  check(p.state().toast === 'Could not start the consoles', 'a failed mount shows a toast')
  p.client.leaveTerminal()
  check(p.state().screen === 'home' && p.state().activePaneId === 'b2' && p.state().subscribedPaneId === null && s.sent.at(-1).type === 'unsub' && s.sent.at(-1).paneId === 'b2', 'back to Home leaves the stream (unsub, v2.2.1) and remembers the pane')
  p.client.showPane('b2')

  // b2 closes on the desktop while viewed: back to Home with a toast, no other pane picked (E2-FR-47).
  const closed = multi(); closed.workspaces[1].panes = closed.workspaces[1].panes.filter(x => x.id !== 'b2')
  closed.workspaces[1].layoutOrder = ['b1', 'b3']
  s.recv({ type: 'state', state: closed })
  check(p.state().activePaneId === null && p.state().screen === 'home', 'a vanished viewed pane returns to Home without picking another')
  check(p.state().toast === 'The console was closed' && s.sent.at(-1).type === 'unsub' && s.sent.at(-1).paneId === 'b2', 'with the toast "The console was closed", and its subscription dropped')
  p.client.openPane('a1')
  p.client.leaveTerminal()
  p.state().setToast(null)
  const gone = multi(); gone.workspaces = [gone.workspaces[1]]
  s.recv({ type: 'state', state: gone })
  check(p.state().activePaneId === null && p.state().screen === 'home' && p.state().toast === null, 'a vanished pane while on Home just clears the view (no toast)')
  p.state().setInPageAlerts(false)
  p.state().setPagePref('vibrate', false)
  check(JSON.parse(p.local.get('snagentsos.prefs')).toasts === false, 'the preference persists in snagentsos.prefs')
  s.recv({ type: 'paneStatus', paneId: 'a2', status: st('working') })
  s.recv({ type: 'paneStatus', paneId: 'a2', status: st('action') })
  check(p.vibrations.length === 1, 'with the preferences off a transition does not alert')
}

/** Section M4 (E1-FR-24, FR-28): input chunking and the composer storage wiring of client.ts. */
function testComposerWiring() {
  const DAY = 24 * 60 * 60 * 1000, NOW = 1700000000000
  const draft = (text, at) => JSON.stringify({ text, updatedAt: at })
  const composerKeys = p => [...p.local.keys()].filter(k => k.startsWith('snagentsos.draft.') || k.startsWith('snagentsos.inputMode.'))
  const authOk = s => s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  {
    const { p, s } = live()
    s.sent.length = 0
    const big = 'x'.repeat(19990) + '\u{1F600}'.repeat(5)
    check(p.client.sendInput(big) === true, 'sendInput accepts a 20000-char paste')
    const frames = s.sent.filter(m => m.type === 'input')
    check(frames.length === 3 && frames.every(f => f.data.length <= 8192 && f.paneId === 'p'), 'it goes as 3 input frames, none over 8192')
    check(frames.map(f => f.data).join('') === big && !s.closed, 'the frames arrive in order, complete, and the socket stays open')
  }
  {
    const p = page()
    p.local.set('snagentsos.draft.gone', draft('a', NOW - 8 * DAY))
    p.local.set('snagentsos.draft.p', draft('b', NOW - 8 * DAY))
    p.local.set('snagentsos.draft.recent', draft('c', NOW - DAY))
    p.client.start(); p.last().open(); authOk(p.last())
    check(!p.local.has('snagentsos.draft.gone'), 'the first authOk prunes an old draft of a gone pane')
    check(p.local.has('snagentsos.draft.p') && p.local.has('snagentsos.draft.recent'), 'drafts of live panes and recent drafts stay')
    p.local.set('snagentsos.draft.gone2', draft('d', NOW - 9 * DAY))
    p.client.reconnectNow(); p.last().open(); authOk(p.last())
    check(p.local.has('snagentsos.draft.gone2'), 'drafts are pruned once per page, not on every reconnect')
  }
  const seed = p => {
    p.local.set('snagentsos.draft.p', draft('x', NOW))
    p.state().setInputMode('p', 'composer')
    p.local.set('snagentsos.composer.autocorrect', '1')
  }
  {
    const { p, s } = live(); seed(p)
    s.drop(4403)
    check(composerKeys(p).length === 0 && Object.keys(p.state().inputModes).length === 0, 'close 4403 wipes every draft and input mode')
    check(p.local.get('snagentsos.composer.autocorrect') === '1', 'preferences survive the wipe')
  }
  {
    const { p, s } = live(); seed(p)
    s.recv({ type: 'revoked' })
    check(composerKeys(p).length === 0 && p.state().phase === 'revoked', 'the revoked message wipes drafts and input modes')
  }
  {
    const { p } = live(); seed(p)
    p.client.unpair()
    check(composerKeys(p).length === 0 && p.reloads === 1, 'unpair wipes drafts and input modes before reloading')
  }
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

  // pushState refused (sandbox, Safari's rate limit): the claim never pops history.
  h = fakeHistory(); closed = []
  h.pushState = () => { throw new Error('SecurityError') }
  stack = p.createBackStack(h)
  stack.push('refused', () => closed.push('refused'))
  stack.requestClose('refused')
  check(h.backs === 0 && stack.size() === 0, 'a claim whose pushState threw closes without history.back() (which would leave the app)')
  stack.push('refused2', () => closed.push('refused2'))
  h.userBack(stack)
  check(closed.length === 0 && stack.orphanAll() === 0 && h.gos.length === 0, 'a refused claim is never popped by back nor counted by orphanAll')

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
  check(p.tabPanes(snap, null).workspaceId === null && p.tabPanes(snap, null).panes.length === 0, 'with nothing viewed there are no tabs (never the desktop workspace)')

  check(p.paneActionIds({ resumable: true }).join() === 'rename,restart,restartResume,restartFresh,reveal,copyTitle,close', 'a resumable pane offers Relaunch resuming and New chat, then Show on the PC and Copy title (E2-FR-08)')
  check(p.paneActionIds({}).join() === 'rename,restart,reveal,copyTitle,close' && p.paneActionIds({ resumable: false }).join() === 'rename,restart,reveal,copyTitle,close', 'without resumable (SSH, no session, old desktop) both are hidden')
  check(p.paneActionIds({ resumable: true }, { rename: false })[0] === 'restart', 'the main sheet omits Rename')
  check(JSON.stringify(p.restartAction('w', 'p', 'restartResume')) === '{"kind":"restartPane","workspaceId":"w","paneId":"p","resume":true}', 'Relaunch resuming sends restartPane resume:true')
  check(JSON.stringify(p.restartAction('w', 'p', 'restartFresh')) === '{"kind":"restartPane","workspaceId":"w","paneId":"p","resume":false}', 'New chat sends restartPane resume:false')
  check(!('resume' in p.restartAction('w', 'p', 'restart')), 'plain Restart sends no resume (the header button rule)')
}

/** Section M6: pure Home logic (rows, unread, second line, LRU). */
function testHomeLogic(p) {
  p.setLang('en')
  const now = 10 * 24 * 60 * MIN
  const ws = { id: 'w', name: 'W', layoutOrder: ['a', 'b', 'c', 'd', 'e', 'f'], panes: ['f', 'e', 'd', 'c', 'b', 'a'].map(id => ({ id, title: id, type: 'claude', running: true })) }
  const statuses = { b: st('working'), c: st('done', { stateSince: 50 }), d: st('error'), e: st('done', { stateSince: 50 }), f: st('action', { reason: 'question' }) }
  const lastViewed = { e: 100 }
  const order = (map, seen) => p.homeRows(ws, map, seen).map(x => x.id).join()
  check(order(statuses, lastViewed) === 'f,d,c,b,a,e', 'rows: action > error > unread done > working > rest, layoutOrder inside each rank (got ' + order(statuses, lastViewed) + ')')
  check(order({ ...statuses, a: st('action') }, lastViewed).startsWith('a,f'), 'two in action keep layoutOrder between them')
  check(order({}, {}) === 'a,b,c,d,e,f', 'without statuses the order is layoutOrder (stable)')
  check(p.isUnread(st('done', { stateSince: 50 }), undefined) && !p.isUnread(st('done', { stateSince: 50 }), 50) && !p.isUnread(st('working', { stateSince: 50 }), 0) && !p.isUnread(undefined, 0), 'unread = action/done/error newer than the last view')
  check(p.actionCount(ws, { ...statuses, a: st('action') }) === 2, 'actionCount counts the consoles in action (the red badge)')
  // v2.3 attention.
  check(p.actionCount(ws, { ...statuses, a: st('action', { attention: false }) }) === 1, 'actionCount skips an answered action')
  check(!p.isUnread(st('done', { stateSince: 50, attention: false }), undefined) && !p.isUnread(st('error', { stateSince: 50, attention: false }), 0) && p.isUnread(st('done', { stateSince: 50, attention: true }), undefined), 'unread is false once the desktop says seen (attention false)')
  check(order({ ...statuses, f: st('action', { attention: false }), d: st('error', { attention: false }) }, lastViewed) === 'c,b,f,a,d,e', 'rows: an answered action ranks as working, an acknowledged error as the rest (got ' + order({ ...statuses, f: st('action', { attention: false }), d: st('error', { attention: false }) }, lastViewed) + ')')

  const line = (status, rest = {}) => p.rowLine({ status, running: true, mounted: true, ...rest }, now)
  check(line(st('action', { reason: 'permission' })) === 'Waiting for permission' && line(st('action', { reason: 'question' })) === 'Question pending', 'permission / question')
  check(line(st('action', { reason: 'plan' })) === 'Plan to approve' && line(st('action', { reason: 'elicitation' })) === 'MCP response pending', 'plan / elicitation')
  check(line(st('working', { stateSince: now - 2 * MIN })) === 'Working 2m' && line(st('done', { stateSince: now - 3 * MIN })) === 'Done 3m ago' && line(st('error', { stateSince: now - MIN })) === 'Error 1m ago', 'working / done / error with their age')
  check(line(st('unknown')) === 'Lost connection to agent', 'unknown')
  check(line(undefined) === 'Idle' && line(undefined, { running: false }) === 'Stopped' && line(undefined, { running: false, mounted: false }) === 'Not started', 'no status: Idle (running), Stopped, Not started (workspace not mounted)')
  check(line(undefined, { running: false, exitCode: 3 }) === 'Exited (code 3)', 'a shell that ended on its own says so')
  check(p.rowShowsTime(st('error'), now) && p.rowShowsTime(st('working'), now) && !p.rowShowsTime(st('action'), now) && !p.rowShowsTime(undefined, now), 'working, done and error drive the 30s ticker')
  // v2.3: an answered action reads as the desktop glyph does (displayStatus).
  check(line(st('action', { reason: 'permission', attention: false, stateSince: now })) === 'Working' && p.rowShowsTime(st('action', { attention: false }), now), 'an answered action (attention false) reads Working and drives the ticker')
  check(line(st('action', { reason: 'permission', attention: false, precise: false })) === 'Idle' && line(st('action', { reason: 'permission', attention: true })) === 'Waiting for permission', 'title-only answered action reads Idle; attention true keeps the reason')
  p.setLang('es')
  check(line(st('action', { reason: 'question' })) === 'Pregunta pendiente' && line(undefined, { running: false, mounted: false }) === 'Sin iniciar' && line(st('unknown')) === 'Se perdio la conexion con el agente', 'Spanish row lines')
  p.setLang('en')

  let map = {}
  for (let i = 0; i < p.LAST_VIEWED_MAX + 5; i++) map = p.withViewed(map, 'p' + i, 1000 + i)
  check(Object.keys(map).length === p.LAST_VIEWED_MAX && !('p0' in map) && !('p4' in map) && 'p5' in map, 'lastViewed keeps the 200 most recent entries (LRU)')
  map = p.withViewed(map, 'p5', 99999)
  map = p.withViewed(map, 'new', 5000000)
  check('p5' in map && !('p6' in map), 'viewing again refreshes an entry so it survives the trim')
}

/** Section M6: the client's goLive / storage side of Home. */
async function testHomeClient() {
  const authOk = (s, state) => s.recv({ type: 'authOk', deviceId: 'dev1', state, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  {
    // goLive: lastPane is remembered but not streamed while the screen stays Home (v2.2.1).
    const p = page()
    p.state().update({ lastPane: 'b1' })
    p.client.start(); const s = p.last(); s.open(); authOk(s, multi())
    check(p.state().activePaneId === 'b1' && !s.sent.some(m => m.type === 'sub') && p.state().subscribedPaneId === null && p.state().screen === 'home', 'goLive remembers lastPane without subscribing it and stays on Home')
    check(!s.sent.some(m => m.type === 'ctl'), 'and never asks the desktop to switch')
  }
  {
    // lastPane of a stopped pane of an unmounted workspace is not pre-opened.
    const p = page()
    p.state().update({ lastPane: 'b2' })
    p.client.start(); const s = p.last(); s.open(); authOk(s, multi())
    check(p.state().activePaneId === null, 'a lastPane that would need a mount is not subscribed')
  }
  {
    // A pending deep link wins over lastPane and opens the terminal.
    const p = page()
    p.state().update({ lastPane: 'b1' })
    p.client.setPendingDeepLink('a1')
    p.client.start(); const s = p.last(); s.open(); authOk(s, multi())
    check(p.state().activePaneId === 'a1' && p.state().screen === 'terminal' && !s.sent.some(m => m.type === 'sub' && m.paneId === 'b1'), 'a pending deep link is applied in goLive before lastPane')
    p.client.leaveTerminal()
    p.client.setPendingDeepLink('b2')
    check(p.state().mountAsk === 'b2' && p.state().activePaneId === 'a1' && !s.sent.some(m => m.type === 'ctl'), 'a deep link to an unmounted workspace only asks, it never mounts alone')
    p.state().update({ mountAsk: null })
    p.client.setPendingDeepLink('ghost')
    check(p.state().toast === 'The console no longer exists' && p.state().screen === 'home', 'a deep link to a gone pane shows the toast and stays on Home')
  }
  {
    // Reconnect while the viewed pane was closed: Home + toast.
    const p = page(); p.client.start(); let s = p.last(); s.open(); authOk(s, multi())
    p.client.openPane('b3')
    s.drop(1006); p.advance(1000); s = p.last(); s.open()
    const without = multi(); without.workspaces[1].panes = without.workspaces[1].panes.filter(x => x.id !== 'b3')
    authOk(s, without)
    check(p.state().activePaneId === null && p.state().screen === 'home' && p.state().toast === 'The console was closed', 'a reconnect that finds the viewed pane gone returns to Home with the toast')
    const again = p.client.openPane('b1')
    s.drop(1006); p.advance(1000); s = p.last(); s.open(); authOk(s, multi())
    check(again === 'open' && p.state().activePaneId === 'b1' && p.state().screen === 'terminal', 'a reconnect keeps the viewed pane and the terminal')
  }
  {
    // noteViewed: stamped at least at stateSince (desktop clock ahead of the phone).
    const p = page(); p.client.start(); const s = p.last(); s.open()
    const snap = multi(); snap.workspaces[1].panes[0].status = st('done', { stateSince: 1700000000000 + 10 * MIN })
    authOk(s, snap)
    p.client.openPane('b1')
    check(p.state().lastViewedAt.b1 === 1700000000000 + 10 * MIN, 'a view is stamped at the status stateSince when the desktop clock runs ahead')
    check(JSON.parse(p.local.get('snagentsos.lastViewed')).b1 === 1700000000000 + 10 * MIN, 'and persisted in snagentsos.lastViewed')
    p.state().toggleCollapsed('w2')
    check(JSON.parse(p.local.get('snagentsos.home.collapsed')).join() === 'w2', 'collapsing persists snagentsos.home.collapsed')
    p.state().toggleCollapsed('w2')
    check(!p.local.has('snagentsos.home.collapsed') && p.state().homeCollapsed.length === 0, 'expanding everything removes the key (default: all expanded)')
    // promptFallback travels from the ack to the caller.
    const res = p.client.sendCtl({ kind: 'createPane', workspaceId: 'w1', presetId: 'c', prompt: 'x' })
    const ctl = s.sent.filter(m => m.type === 'ctl').at(-1)
    check(ctl.action.prompt === 'x', 'createPane carries the prompt')
    s.recv({ type: 'ctlAck', id: ctl.id, ok: true, paneId: 'n1', promptFallback: true })
    const r = await res
    check(r.ok && r.paneId === 'n1' && r.promptFallback === true, 'the ack promptFallback reaches the caller')
    let settled = false
    void p.client.sendCtl({ kind: 'mountWorkspace', workspaceId: 'w1' }, 30000).then(() => { settled = true })
    p.advance(15000); await Promise.resolve()
    check(!settled, 'sendCtl takes a per-action timeout')
    p.advance(16000); await Promise.resolve(); await Promise.resolve()
    check(settled, 'and times out after it')
    // Toasts: newest last, at most 3, dismissable.
    for (const x of ['1', '2', '3', '4']) p.state().setToast(x)
    check(p.state().toasts.map(x => x.text).join() === '2,3,4' && p.state().toast === '4', 'at most 3 toasts; toast mirrors the newest')
    p.state().dismissToast(p.state().toasts.at(-1).id)
    check(p.state().toast === '3' && p.state().toasts.length === 2, 'dismissing the newest falls back to the previous one')
  }
  {
    // noteViewed uses the desktop clock only: a phone clock 5 minutes ahead
    // must not hide a done that lands after the view.
    const p = page(); p.client.start(); const s = p.last(); s.open()
    const base = 1700000000000
    const snap = multi(); snap.workspaces[1].panes[0].status = st('working', { stateSince: base - 10 * MIN })
    authOk(s, snap)
    p.client.openPane('b1')
    check(p.state().lastViewedAt.b1 === base - 10 * MIN, 'a view is stamped at the stateSince of the state it saw, never the phone clock')
    p.client.leaveTerminal()
    const done = multi(); done.workspaces[1].panes[0].status = st('done', { stateSince: base - 8 * MIN })
    s.recv({ type: 'state', state: done })
    check(p.isUnread(p.state().paneStatus.b1, p.state().lastViewedAt.b1), 'a done after the view reads unread even when it is older than the phone clock')
    p.client.openPane('b1'); p.client.leaveTerminal()
    check(!p.isUnread(p.state().paneStatus.b1, p.state().lastViewedAt.b1), 'and read once it was seen')
    // Switching tabs reads the console being left too.
    p.client.openPane('a1')
    const later = multi(); later.workspaces[0].panes[0].status = st('done', { stateSince: base + MIN })
    s.recv({ type: 'state', state: later })
    p.client.openPane('a2')
    check(p.state().lastViewedAt.a1 === base + MIN && !p.isUnread(p.state().paneStatus.a1, p.state().lastViewedAt.a1), 'a tab switch stamps the console left behind (it finished while on screen)')
  }
  {
    // A console just created may be missing from a state frame built before it existed.
    const p = page(); p.client.start(); const s = p.last(); s.open(); authOk(s, multi())
    p.client.showPane('n1')
    check(p.state().screen === 'terminal' && p.state().activePaneId === 'n1', 'the acked console opens before any snapshot lists it')
    s.recv({ type: 'state', state: multi() })
    check(p.state().screen === 'terminal' && p.state().activePaneId === 'n1' && p.state().toast !== 'The console was closed', 'a stale frame without it does not read as "the console was closed"')
    const withNew = multi(); withNew.workspaces[0].panes.push({ id: 'n1', title: 'N1', type: 'claude', running: false })
    s.recv({ type: 'state', state: withNew })
    check(p.state().activePaneId === 'n1' && p.state().lastPane === 'n1', 'once listed it stays and becomes lastPane')
    s.recv({ type: 'state', state: multi() })
    check(p.state().screen === 'home' && p.state().activePaneId === null && p.state().toast === 'The console was closed', 'after that, a frame without it is a real close')
    p.client.showPane('n2')
    p.advance(p.AWAIT_NEW_PANE_MS + 1)
    s.recv({ type: 'state', state: multi() })
    check(p.state().screen === 'home' && p.state().activePaneId === null, 'a created console that never shows up gives up after AWAIT_NEW_PANE_MS')
  }
}

// --- M10: app 2.7.0 (A8) "needs you", row signals, status marks, full plan ---

function attentionFixture() {
  const now = 10 * 24 * 60 * MIN
  const pane = (id, type = 'claude') => ({ id, title: id.toUpperCase(), type, running: true })
  const snap = {
    language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, keyButtons: [], activeWorkspaceId: 'w1',
    workspaces: [
      { id: 'w1', name: 'Front', layoutOrder: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], panes: ['a6', 'a5', 'a4', 'a3', 'a2', 'a1'].map(id => pane(id)) },
      { id: 'w2', name: 'Back', layoutOrder: ['b1', 'b2', 'b3', 'b4'], panes: [pane('b1', 'shell'), pane('b2'), pane('b3'), pane('b4', 'codex')] },
    ],
  }
  const statuses = {
    // An open request with no `attention` (an older main): the legacy rule.
    a1: st('action', { reason: 'permission', stateSince: now - 5 * MIN }),
    a2: st('done', { stateSince: now - 3 * MIN, attention: true }),
    a3: st('working', { stateSince: now - 12 * MIN, toolFamily: 'edit', activity: 'Edit src/a.ts', silence: { level: 'quiet', since: now - 12 * MIN }, context: { pct: 0.42, used: 84000, window: 200000, exact: false } }),
    a4: st('error', { stateSince: now - 2 * MIN, attention: true, failure: { kind: 'limit', until: now + 2 * 60 * MIN, code: 'rate_limit' } }),
    // A working agent that asked with `snaos needs`: rank 1, aged from the ask.
    a5: st('working', { stateSince: now - MIN, needs: { text: 'Approve the deploy', at: now - 7 * MIN } }),
    // Muted: out, its needs included.
    a6: st('action', { reason: 'question', stateSince: now - 9 * MIN, attention: false, muted: true, needs: { text: 'Muted ask', at: now - 9 * MIN } }),
    // A bare status: a `snaos needs` on a shell with no agent.
    b1: { state: 'idle', precise: false, pendingCount: 0, stateSince: now - 4 * MIN, attention: true, needs: { text: 'Check the PR', at: now - 4 * MIN }, bare: true },
    b2: st('done', { stateSince: now - MIN, attention: false }),
    b3: st('done', { stateSince: now - 6 * MIN, attention: false, muted: true }),
    b4: st('working', { stateSince: now - MIN, provider: 'codex', context: { pct: 0.9, used: 9, window: 10, exact: true } }),
    ghost: st('action'),
  }
  return { now, snap, statuses }
}

function testAttention(p) {
  p.setLang('en')
  const { now, snap, statuses } = attentionFixture()
  const items = p.attentionItems(snap.workspaces, statuses)
  check(items.map(i => i.paneId).join() === 'a1,a2,a3,a4,a5,a6,b1,b2,b3,b4' && items[6].workspaceName === 'Back' && items[0].pane.title === 'A1', 'attentionItems: every console in workspace then layout order, with its pane and workspace name')
  const shared = p.needsYouRows(items).map(r => r.id).join()
  const rows = p.needsYouPanes(snap, statuses)
  check(rows.map(r => r.id).join() === shared && shared === 'a5,a1,b1,a4,a2', 'Waiting for you uses the shared order: needs and requests longest waiting first, then the unseen done (got ' + rows.map(r => r.id).join() + ')')
  check(p.actionTotal(snap, statuses) === p.needsYouCount(items) && p.actionTotal(snap, statuses) === 5, 'the title counts what needsYouCount counts (5): no muted, no seen done, no working, no console outside the snapshot')
  check(p.actionCount(snap.workspaces[0], statuses) === 4 && p.actionCount(snap.workspaces[1], statuses) === 1, 'the workspace badges (4 + 1) add up to the same 5')
  check(p.remoteTitle(p.actionTotal(snap, statuses)) === '(5) SnAgentsOS Remote', 'so the document title reads (5)')
  check(p.waitingPanes(snap, statuses, null).map(r => r.paneId).join() === 'a1,a2,a4,a5,b1' && p.waitingPanes(snap, statuses, 'a4').map(r => r.paneId).join() === 'a1,a2,a5,b1', 'the waiting pill counts the same set, in workspace order, without the viewed console')
  check(p.nextWaitingPane(snap, statuses, 'a4').paneId === 'a5' && p.nextWaitingPane(snap, statuses, 'b1').paneId === 'a1' && p.nextWaitingPane(snap, statuses, 'a6').paneId === 'b1', 'next waiting walks that set (a needs and a bare needs included), wrapping around')
  check(p.markReadTargets(snap.workspaces[0], statuses).join() === 'a2,a4' && p.markReadTargets(snap.workspaces[1], statuses).join() === 'b3', 'Mark all read: unseen done and error consoles, a muted one included, never a seen or a bare one')
  const order = ws => p.homeRows(ws, statuses, {}).map(x => x.id).join()
  check(order(snap.workspaces[0]) === 'a1,a5,a4,a2,a3,a6' && order(snap.workspaces[1]) === 'b1,b4,b2,b3', 'Home rows: a snaos needs not muted ranks with the open requests (got ' + order(snap.workspaces[0]) + ' / ' + order(snap.workspaces[1]) + ')')

  // The row signals (the desktop's words).
  const line = (status, rest = {}) => p.rowLine({ status, running: true, mounted: true, ...rest }, now)
  check(line(statuses.a3) === 'Editing src/a.ts · 12m' && p.doingNow(statuses.a3) === 'Editing src/a.ts', 'doing now: the open tool\'s verb and object, with the age on the row')
  check(p.doingNow(st('working', { toolFamily: 'run', activity: 'Bash: npm test' })) === 'Running npm test' && p.doingNow(st('working', { provider: 'codex', toolFamily: 'run', activity: 'npm test' })) === 'Running npm test', 'a Claude tool name goes, a Codex command line stays')
  check(p.doingNow(st('working', { activity: 'npm test' })) === null && p.doingNow(st('working', { toolFamily: 'edit' })) === null && p.doingNow(st('done', { toolFamily: 'edit', activity: 'Edit a.ts' })) === null && p.doingNow(st('working', { toolFamily: 'agent', activity: 'Task: x', waiting: { kind: 'background', count: 1 } })) === null, 'no toolFamily (a desktop before 2.7.0), no open tool, a finished turn or a background wait = nothing')
  check(line(st('working', { stateSince: now - 6 * MIN, provider: 'claude', activity: 'Edit a.ts' })) === 'Working 6m', 'a 2.6.0 desktop keeps activity on the last tool after it ended: its row keeps "Working 6m"')
  check(line(st('working', { stateSince: now - 5000, toolFamily: 'read', activity: 'Read a.ts' })) === 'Reading a.ts', 'a fresh turn has no age')
  check(p.failureText(statuses.a4.failure, now).startsWith('Usage limit until ') && p.failureText({ kind: 'limit', until: now - MIN }, now) === 'Usage limit' && p.failureText({ kind: 'nope' }, now) === 'Turn failed', 'failure: the label, "until <time>" only while the reset is ahead, junk = Turn failed')
  check(p.silenceText(statuses.a3.silence, now) === 'No signal for 12 min' && p.silenceText({ level: 'stalled', since: now - 25 * MIN - 30000 }, now) === 'Maybe stuck: 25 min without signal', 'silence: quiet and stalled with whole minutes')
  check(p.needsText(statuses.a5.needs) === 'Needs you: Approve the deploy', 'needs: "Needs you: <text>"')
  check(p.contextShort(statuses.a3.context) === '42% est.' && p.contextLabel(statuses.a3.context) === 'Context 42% full (estimated)' && p.contextShort(statuses.b4.context) === '90%' && p.contextLabel(statuses.b4.context) === 'Context 90% full', 'context: "est." unless the agent reported it exactly')
  check(p.agentStatusOf(statuses.b1) === undefined && p.agentStatusOf(statuses.a1) === statuses.a1 && line(statuses.b1) === 'Idle' && !p.rowShowsTime(statuses.b1, now), 'a bare status is no agent status: no state line of its own, no ticker')
  check(p.rowShowsTime(st('idle', { failure: { kind: 'limit', until: now + MIN } }), now) && p.rowShowsTime(st('action', { silence: { level: 'quiet', since: now } }), now), 'a failure reset or a silence drives the 30s ticker too')
  // Main keeps the failure on a track that went idle: once its reset passed the row shows no time, so the clock stops.
  check(!p.rowShowsTime(st('idle', { failure: { kind: 'limit', until: now - MIN } }), now) && !p.rowShowsTime(st('idle', { failure: { kind: 'limit', until: now } }), now) && p.rowShowsTime(st('idle', { failure: { kind: 'limit', until: now - MIN } }), now - 2 * MIN), 'a failure reset counts only while it is ahead: a past one stops the 30s ticker')
  p.setLang('es')
  check(line(statuses.a3) === 'Editando src/a.ts · 12m' && p.failureText(statuses.a4.failure, now).startsWith('Límite de uso hasta ') && p.silenceText(statuses.a3.silence, now) === 'Sin señales hace 12 min' && p.needsText(statuses.a5.needs) === 'Te necesita: Approve the deploy', 'Spanish signals: "Editando", "Límite de uso hasta", "Sin señales hace", "Te necesita"')
  check(p.contextShort(statuses.a3.context) === '42% estimado' && p.contextLabel(statuses.a3.context) === 'Contexto al 42% (estimado)', 'Spanish context: "42% estimado"')
  p.setLang('en')

  // The status marks of the pane actions (handled in main, a 2.7.0 desktop only).
  check(!p.statusMarksSupported('2.6.0') && !p.statusMarksSupported('') && p.statusMarksSupported('2.7.0') && p.statusMarksSupported('dev'), 'the marks need a 2.7.0 desktop (dev counts as new)')
  const ids = (status, marks = true, pane = {}) => p.paneActionIds(pane, { status, marks }).join()
  check(ids(statuses.a2, false) === 'rename,restart,reveal,copyTitle,close', 'an older desktop keeps the plain list')
  check(ids(statuses.a2) === 'markRead,mute,rename,restart,reveal,copyTitle,close' && ids(statuses.a4) === 'markRead,mute,rename,restart,reveal,copyTitle,close', 'a done or error console offers Mark as read and Mute first')
  check(ids(statuses.a3) === 'mute,silenceAck,rename,restart,reveal,copyTitle,close' && ids(statuses.a6) === 'unmute,rename,restart,reveal,copyTitle,close', 'a silent one adds Ignore this turn; a muted one offers Unmute')
  check(ids(statuses.b1) === 'rename,restart,reveal,copyTitle,close' && ids(undefined) === 'rename,restart,reveal,copyTitle,close' && p.statusMarkIds(statuses.b1).length === 0, 'a bare status or none gets no marks')
  check(p.paneActionIds({ resumable: true }, { status: statuses.a2, marks: true, rename: false }).join() === 'markRead,mute,restart,restartResume,restartFresh,reveal,copyTitle,close', 'with the resume rows and without Rename')
  check(JSON.stringify(p.statusMarkAction('p', 'markRead')) === '{"kind":"markRead","paneId":"p"}' && JSON.stringify(p.statusMarkAction('p', 'mute')) === '{"kind":"mutePane","paneId":"p","muted":true}' && JSON.stringify(p.statusMarkAction('p', 'unmute')) === '{"kind":"mutePane","paneId":"p","muted":false}' && JSON.stringify(p.statusMarkAction('p', 'silenceAck')) === '{"kind":"silenceAck","paneId":"p"}', 'each mark sends its ctl: markRead, mutePane true / false, silenceAck')

  // The plan sheet's outcomes.
  const plan = { requestId: 'r1', text: '# Plan', at: 1, truncated: false }
  check(p.planLoadOf({ ok: true, value: { ok: true, plan } }).status === 'ok' && p.planLoadOf({ ok: true, value: { ok: true, plan } }).plan === plan, 'a plan reads ok')
  check(['timeout', 'rate', 'offline'].every(error => p.planLoadOf({ ok: false, error }).status === 'noReply') && p.planLoadOf({ ok: true, value: { ok: false, error: 'rate' } }).status === 'noReply', 'no answer, offline or the PC\'s rate limit = "The PC did not answer [Retry]"')
  check(p.planLoadOf({ ok: true, value: { ok: false, error: 'not_found' } }).status === 'gone' && p.planLoadOf({ ok: true, value: { ok: false, error: 'unsupported' } }).status === 'gone' && p.planLoadOf({ ok: true, value: { ok: true, plan: { ...plan, text: ' ' } } }).status === 'gone', 'not kept any more, an older desktop or an empty plan = no longer available')
}

/** client.requestPlan: nothing goes to an older desktop; planRes answers by id. */
async function testPlanRequest() {
  const p = page()
  p.client.start()
  const s = p.last(); s.open()
  s.recv({ type: 'authOk', deviceId: 'dev1', state: multi(), hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  const old = await p.client.requestPlan('b1', 'tp1')
  check(old.ok && old.value.ok === false && old.value.error === 'unsupported' && s.count('planReq') === 0, 'a desktop older than 2.7.0 gets no planReq (it would strike it): unsupported')
  p.state().update({ appVersion: '2.7.0' })
  const wait = p.client.requestPlan('b1', 'tp1')
  const req = s.sent.find(m => m.type === 'planReq')
  check(req && req.paneId === 'b1' && req.requestId === 'tp1' && /^[0-9a-f]{16}$/.test(req.id), 'a 2.7.0 desktop gets planReq with the pane and the request id')
  s.recv({ type: 'planRes', id: req.id, ok: true, plan: { requestId: 'tp1', text: '# Plan\n\n1. Parse', at: 5, truncated: true } })
  const got = await wait
  check(got.ok && got.value.ok && got.value.plan.truncated === true && p.planLoadOf(got).status === 'ok', 'its planRes resolves the request (truncated kept)')
}

async function main() {
  const p = page({ paired: false })
  testPure(p)
  testStatusText(p)
  testPaneNotifier(p)
  testWorkspaceSelectors(p)
  testBackStack(p)
  testLongPress(page())
  testSheetDrag(p)
  testTabsAndActions(p)
  await testClientStatus()
  testHomeLogic(p)
  testAttention(p)
  await testPlanRequest()
  await testHomeClient()
  await testClientNotify()
  testGeneration()
  testBackoff()
  testLiveness()
  testOffline()
  testDesktopGone()
  testUpdated()
  testComposerWiring()
  console.log(`PASS: ${checks} mobile logic checks`)
}

main().catch(error => { console.error(error); process.exit(1) })
