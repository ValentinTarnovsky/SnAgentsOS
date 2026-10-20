// Phone mode on the phone (E3 M11, FR-13..16, 18, 20) in node:vm with fake
// browser globals: phoneGrid at 360/390/430px and 12/13/16px with the 20x8
// floor and the 500x300 ceiling, the keyboard rule (a reduced visualViewport
// or a focused field emits no fitPane), the 150ms scheduler (rotation, forced
// reasons, another device, too narrow), the fitState decisions, the
// phone-wide mode and the migration of the old per-pane keys (v2.2.1), and
// the real client against a fake WebSocket (lastFitSent, another device, the
// PC taking the size back, a refusal, the replay grace, reopening a console,
// Home leaving the stream, a reconnect that is not a new open, the release of
// a pane left while offline) and the one-time reset of the saved Chat views.
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
export * from './src/mobile/src/lib/phoneFit'
export { phoneGrid, PHONE_MIN_COLS, PHONE_MIN_ROWS, PHONE_MAX_COLS, PHONE_MAX_ROWS, PHONE_FONT_SIZES, PHONE_FONT_DEFAULT } from './src/mobile/src/lib/fit'
export { client } from './src/mobile/src/lib/client'
export { store, selectPaneMode } from './src/mobile/src/lib/store'
export { setLang } from './src/mobile/src/lib/i18n'
` },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  define: { __APP_VERSION__: JSON.stringify(BUNDLE_VERSION), 'process.env.NODE_ENV': '"production"' },
  alias: { '@shared': path.join(root, 'src/shared') },
}).outputFiles[0].text

const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, keyButtons: [], activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'W', layoutOrder: ['p', 'q'], panes: [{ id: 'p', title: 'P', type: 'claude', running: true }, { id: 'q', title: 'Q', type: 'shell', running: true }] }] }

/** A fresh page (fake clock, timers, storage, WebSocket); `local` survives "reloads". */
function page(local = new Map([['snagentsos.remote.deviceId', 'dev1'], ['snagentsos.remote.secret', '00'.repeat(32)]]), session = new Map()) {
  let clock = 0, seq = 0
  const timers = new Map()
  const add = (fn, ms) => { const id = ++seq; timers.set(id, { at: clock + Math.max(0, ms || 0), fn }); return id }
  function advance(ms) {
    const end = clock + ms
    for (;;) {
      let best = null
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t]
      if (!best) break
      const [id, t] = best
      clock = Math.max(clock, t.at)
      timers.delete(id)
      t.fn()
    }
    clock = end
  }
  const sockets = []
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this) }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.readyState = 3 }
    open() { this.readyState = 1; this.onopen && this.onopen({}) }
    drop(code = 1006) { this.readyState = 3; this.onclose && this.onclose({ code, wasClean: false, reason: '' }) }
    recv(msg) { this.onmessage && this.onmessage({ data: JSON.stringify({ v: 1, ...msg }) }) }
  }
  const on = () => () => {}
  const document = { visibilityState: 'visible', addEventListener: on(), documentElement: { style: { setProperty() {} } }, head: { appendChild() {} }, querySelector: () => null, createElement: () => ({}) }
  const mapStorage = map => ({ get length() { return map.size }, key: i => [...map.keys()][i] ?? null, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) })
  const location = { host: '100.101.1.2:4517', hostname: '100.101.1.2', hash: '', pathname: '/', search: '', reload() {} }
  class FakeDate extends Date { static now() { return 1700000000000 + clock } }
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, require, console, process,
    setTimeout: (fn, ms) => add(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: () => 0, clearInterval: () => {},
    performance: { now: () => clock }, Date: FakeDate,
    WebSocket: FakeWebSocket, document, window: { addEventListener: on() }, navigator: { onLine: true }, location,
    localStorage: mapStorage(local), sessionStorage: mapStorage(session),
    history: { state: null, replaceState() {} }, crypto: require('node:crypto').webcrypto, TextEncoder, TextDecoder,
  })
  return { api: mod.exports, sockets, local, session, advance, last: () => sockets.at(-1), state: () => mod.exports.store.getState() }
}

function testGrid(api) {
  // No canvas in node: the advance ratio falls back to 0.6 (JetBrains Mono).
  const g = (w, h, f) => api.phoneGrid(w, h, f)
  const at390 = g(390, 600, 13)
  check(at390.cols === 50 && at390.rows === Math.floor(600 / Math.ceil(13 * 1.17)), '390px at 13px: about 50 columns (FR-14 acceptance)')
  check(g(360, 600, 12).cols === 50 && g(360, 600, 13).cols === 46 && g(360, 600, 16).cols === 37, '360px at 12/13/16px')
  check(g(430, 600, 12).cols === 59 && g(430, 600, 13).cols === 55 && g(430, 600, 16).cols === 44, '430px at 12/13/16px')
  check(g(390, 600, 16).rows === Math.floor(600 / Math.ceil(16 * 1.17)), 'rows = floor(height / ceil(font * 1.17)) without a measured row')
  check(api.phoneGrid(390, 600, 13, { w: 8, h: 16 }).cols === 48 && api.phoneGrid(390, 600, 13, { w: 8, h: 16 }).rows === 37, 'a measured cell wins over the estimate')
  check(g(150, 600, 13) === null && g(156, 600, 13).cols === 20, 'under 20 columns there is no grid (the "turn the phone" toast); 20 is the floor')
  check(g(390, 40, 13).rows === api.PHONE_MIN_ROWS && api.PHONE_MIN_ROWS === 8 && api.PHONE_MIN_COLS === 20, 'rows never go below 8')
  check(api.phoneGrid(5000, 9000, 6, { w: 3, h: 7 }).cols === 500 && api.phoneGrid(5000, 9000, 6, { w: 3, h: 7 }).rows === 300, 'cols are capped at 500 and rows at 300 (the desktop schema limits)')
  check(g(0, 600, 13) === null && g(390, 600, 0) === null, 'an unmeasured container gives no grid')
  check(JSON.stringify(api.PHONE_FONT_SIZES) === '[11,12,13,14,16]' && api.PHONE_FONT_DEFAULT === 13, 'phone mode text sizes 11/12/13/14/16, 13 by default')
}

function testKeyboard(api) {
  check(api.keyboardBlocksFit(844, 480, null), 'visualViewport 364px shorter than the window: keyboard open, no fitPane')
  check(!api.keyboardBlocksFit(844, 760, null) && !api.keyboardBlocksFit(844, 844 - 150, null), 'the address bar (under 150px) is not the keyboard')
  check(api.keyboardBlocksFit(844, 844, { tagName: 'TEXTAREA', readOnly: false }), 'a focused editable field counts as the keyboard')
  check(!api.keyboardBlocksFit(844, 844, { tagName: 'TEXTAREA', readOnly: true }), 'the readOnly helper of composer mode does not')
  check(api.keyboardBlocksFit(844, 844, { tagName: 'INPUT', type: 'text' }) && !api.keyboardBlocksFit(844, 844, { tagName: 'INPUT', type: 'checkbox' }) && api.keyboardBlocksFit(844, 844, { isContentEditable: true }), 'text inputs and contentEditable count, checkboxes do not')
}

function scheduler(api, opts = {}) {
  let clock = 0, seq = 0
  const timers = new Map()
  const st = { mode: 'phone', info: null, lastSent: null, kb: false, grid: { cols: 50, rows: 40 }, sent: [], narrow: 0, ...opts }
  const s = new api.PhoneFitScheduler({
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: clock + ms, fn }); return id },
    clearTimeout: id => timers.delete(id),
    keyboardOpen: () => st.kb,
    measure: () => st.grid,
    state: () => ({ mode: st.mode, info: st.info, lastSent: st.lastSent }),
    send: grid => {
      st.sent.push(grid)
      st.lastSent = grid
      st.info = { owner: 'phone', cols: grid.cols, rows: grid.rows, other: false }
    },
    narrow: () => { st.narrow++ },
  })
  const advance = ms => {
    const end = clock + ms
    for (;;) {
      let best = null
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t]
      if (!best) break
      timers.delete(best[0]); clock = best[1].at; best[1].fn()
    }
    clock = end
  }
  return { s, st, advance }
}

function testScheduler(api) {
  check(api.FIT_DEBOUNCE_MS === 150, 'fitPane debounce is 150ms')
  {
    const { s, st, advance } = scheduler(api)
    s.request('enter')
    advance(149)
    check(st.sent.length === 0, 'nothing goes out before 150ms')
    advance(1)
    check(st.sent.length === 1 && st.sent[0].cols === 50, 'entering phone mode sends one fitPane after 150ms')
    // Rotation: a burst of resize events, one fitPane after 150ms.
    st.grid = { cols: 98, rows: 20 }
    for (let i = 0; i < 6; i++) { s.request('rotate'); advance(20) }
    advance(150)
    check(st.sent.length === 2 && st.sent[1].cols === 98, 'a rotation (a burst of events) sends a single fitPane 150ms later')
    s.request('rotate'); advance(150)
    check(st.sent.length === 2, 'an unchanged grid already owned sends nothing')
    s.request('replay'); advance(150)
    check(st.sent.length === 3, 'a replay (respawn or reconnect) always re-claims, even with the same grid')
  }
  {
    // The keyboard rule: five open/close cycles produce no fitPane.
    const { s, st, advance } = scheduler(api, { info: { owner: 'phone', cols: 50, rows: 40, other: false }, lastSent: { cols: 50, rows: 40 } })
    for (let i = 0; i < 5; i++) {
      st.kb = true; st.grid = { cols: 50, rows: 22 }
      s.request('resize'); advance(200)
      st.kb = false; st.grid = { cols: 50, rows: 40 }
      s.keyboardClosed(); advance(200)
    }
    check(st.sent.length === 0, 'opening and closing the keyboard 5 times sends no fitPane (FR-15 acceptance)')
    // A forced reason that arrives with the keyboard up waits for it, then goes out once.
    st.kb = true
    s.request('font'); advance(200)
    check(st.sent.length === 0 && s.waitingForKeyboard, 'a font change with the keyboard open waits')
    st.kb = false; st.grid = { cols: 45, rows: 36 }
    s.keyboardClosed(); s.keyboardClosed(); advance(200)
    check(st.sent.length === 1 && st.sent[0].cols === 45 && !s.waitingForKeyboard, 'the keyboard closing recalculates once and sends the waiting fitPane')
  }
  {
    const { s, st, advance } = scheduler(api, { info: { owner: 'phone', cols: 44, rows: 36, other: true }, lastSent: { cols: 50, rows: 40 } })
    s.request('replay'); s.request('rotate'); advance(200)
    check(st.sent.length === 0, 'another device controls the size: no fitPane (FR-16)')
    s.request('take'); advance(200)
    check(st.sent.length === 1, 'tapping the chip takes control back')
  }
  {
    const { s, st, advance } = scheduler(api, { mode: 'desktop' })
    s.request('enter'); advance(200)
    check(st.sent.length === 0, 'desktop mode never sends')
    st.mode = 'phone'; st.grid = null
    s.request('enter'); advance(200)
    check(st.sent.length === 0 && st.narrow === 1, 'under 20 columns: no fitPane and the narrow fallback runs')
  }
  {
    const { s, st, advance } = scheduler(api)
    s.request('enter'); s.reset(); advance(300)
    check(st.sent.length === 0, 'switching panes drops a queued fitPane')
  }
}

function testDecide(api) {
  const mine = { cols: 50, rows: 40 }
  let d = api.decideFitState('phone', mine, false, { owner: 'phone', cols: 50, rows: 40 })
  check(d.mode === 'phone' && !d.info.other && !d.toast, 'fitState phone with the size this phone sent: it owns the pane')
  d = api.decideFitState('phone', mine, false, { owner: 'phone', cols: 44, rows: 36 })
  check(d.info.other && d.mode === 'phone', 'another size: another device controls it (FR-16)')
  d = api.decideFitState('phone', mine, true, { owner: 'phone', cols: 44, rows: 36 })
  check(!d.info.other, 'while this phone waits for its own ack, a foreign size is not "another device" yet')
  d = api.decideFitState('phone', mine, false, { owner: 'desktop', cols: 120, rows: 40 })
  check(d.mode === 'desktop' && !('persist' in d) && d.toast === 'reclaimed', 'fitState desktop: phone mode ends for this open (never saved, v2.2.1), "The PC took the size back" (FR-18)')
  d = api.decideFitState('phone', mine, true, { owner: 'desktop', cols: 120, rows: 40 })
  check(d.mode === 'phone' && !d.toast && d.info.owner === 'desktop', 'while pending (or right after a replay) the desktop size is only recorded')
  d = api.decideFitState('desktop', null, false, { owner: 'desktop', cols: 132, rows: 44 })
  check(d.mode === 'desktop' && !d.toast && d.info.cols === 132, 'desktop mode just adopts the new size (FR-12)')
}

function testStorage() {
  const p = page()
  const api = p.api
  check(api.resolvePaneMode(undefined, false) === 'desktop' && api.resolvePaneMode(undefined, true) === 'phone' && api.resolvePaneMode('desktop', true) === 'desktop', 'an in-memory override wins; without one, phoneFitDefault (off = desktop)')
  check(p.state().phoneFitDefault === false && p.state().phoneFontSize === 13 && api.selectPaneMode(p.state(), 'p') === 'desktop', 'defaults: desktop mode, 13px')

  // v2.2.1: one phone-wide mode (chip and Settings), overrides only in memory.
  p.state().setPaneMode('p', 'phone')
  check(api.selectPaneMode(p.state(), 'p') === 'phone' && !p.local.has('snagentsos.remote.paneMode.p'), 'a pane override is kept in memory only, never saved')
  p.state().setPhoneModeGlobal('phone')
  p.state().setPhoneFontSize(16)
  check(p.local.get('snagentsos.remote.phoneFitDefault') === 'true' && p.local.get('snagentsos.remote.phoneFontSize') === '16', 'setPhoneModeGlobal saves snagentsos.remote.phoneFitDefault')
  check(Object.keys(p.state().paneModes).length === 0 && api.selectPaneMode(p.state(), 'never-seen') === 'phone', 'and drops every override: a console never opened is in phone mode too')
  p.state().setPaneMode('p', 'desktop')
  check(api.selectPaneMode(p.state(), 'p') === 'desktop' && api.selectPaneMode(p.state(), 'q') === 'phone', 'an override (the PC took p back) touches only that pane')
  p.state().clearPaneOverride('p')
  check(api.selectPaneMode(p.state(), 'p') === 'phone', 'clearPaneOverride puts the pane back on the phone-wide mode')
  p.state().setPaneMode('q', 'desktop')
  const again = page(p.local)
  check(again.api.selectPaneMode(again.state(), 'q') === 'phone' && again.state().phoneFontSize === 16 && again.api.selectPaneMode(again.state(), 'p') === 'phone', 'after a reload the setting survives and no override does (FR-13)')
  p.state().setPaneMode('q', 'phone')
  p.state().setPhoneModeGlobal('desktop')
  check(p.local.get('snagentsos.remote.phoneFitDefault') === 'false' && api.selectPaneMode(p.state(), 'q') === 'desktop', 'switching to desktop also drops the overrides')

  // Migration: the old per-pane keys go away on load and never beat the setting.
  const old = new Map(p.local)
  old.set('snagentsos.remote.phoneFitDefault', 'true')
  old.set('snagentsos.remote.paneMode.p', 'desktop')
  old.set('snagentsos.remote.paneMode.q', 'phone')
  const migrated = page(old)
  check(![...old.keys()].some(k => k.startsWith('snagentsos.remote.paneMode.')) && Object.keys(migrated.state().paneModes).length === 0, 'the snagentsos.remote.paneMode.* keys are removed on load')
  check(migrated.api.selectPaneMode(migrated.state(), 'p') === 'phone', 'a stale saved desktop no longer beats the phone-wide mode')
  p.local.set('snagentsos.remote.phoneFontSize', '15')
  const junk = page(p.local)
  check(junk.state().phoneFontSize === 13, 'unknown stored values fall back')
}

function testClient() {
  const p = page()
  const { client } = p.api
  p.api.setLang('en')
  client.start()
  const s = p.last()
  s.open()
  s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  client.openPane('p')
  p.state().setPaneMode('p', 'phone')
  const toasts = () => p.state().toasts.map(x => x.text)

  // fitPane goes out with the pane's workspace and becomes lastFitSent.
  const done = client.sendFitPane('p', 50, 40)
  const ctl = s.sent.filter(m => m.type === 'ctl').at(-1)
  check(ctl.action.kind === 'fitPane' && ctl.action.workspaceId === 'w' && ctl.action.cols === 50 && JSON.stringify(p.state().lastFitSent.p) === '{"cols":50,"rows":40}', 'sendFitPane sends the ctl and remembers lastFitSent (FR-16)')
  s.recv({ type: 'fitState', paneId: 'p', owner: 'phone', cols: 50, rows: 40 })
  s.recv({ type: 'ctlAck', id: ctl.id, ok: true })
  return done.then(async () => {
    check(p.state().sizeInfo.p.owner === 'phone' && !p.state().sizeInfo.p.other, 'its own fitState: owned')
    s.recv({ type: 'fitState', paneId: 'p', owner: 'phone', cols: 44, rows: 36 })
    check(p.state().sizeInfo.p.other === true && p.api.selectPaneMode(p.state(), 'p') === 'phone', 'another size: "Another device controls the size", still phone mode')
    s.recv({ type: 'fitState', paneId: 'p', owner: 'desktop', cols: 120, rows: 40 })
    check(p.api.selectPaneMode(p.state(), 'p') === 'desktop' && toasts().includes('The PC took the size back'), 'the PC recovering the size: desktop mode, with its toast (FR-18)')
    check(!p.local.has('snagentsos.remote.paneMode.p') && !p.local.has('snagentsos.remote.phoneFitDefault'), 'and nothing is saved: neither a pane key nor the phone-wide setting (v2.2.1)')

    // A refusal: the fitState desktop that comes first is held until the ack.
    p.state().setPaneMode('p', 'phone')
    const refused = client.sendFitPane('p', 50, 40)
    const c2 = s.sent.filter(m => m.type === 'ctl').at(-1)
    s.recv({ type: 'fitState', paneId: 'p', owner: 'desktop', cols: 120, rows: 40 })
    check(p.api.selectPaneMode(p.state(), 'p') === 'phone', 'while the fitPane waits, a desktop fitState does not switch the mode')
    s.recv({ type: 'ctlAck', id: c2.id, ok: false, error: 'disabled' })
    const res = await refused
    check(res.error === 'disabled' && p.api.selectPaneMode(p.state(), 'p') === 'desktop' && toasts().includes('The PC does not allow fitting to the phone'), 'disabled: back to desktop with "The PC does not allow fitting to the phone" (FR-20)')
    check(!p.local.has('snagentsos.remote.paneMode.p') && !p.local.has('snagentsos.remote.phoneFitDefault'), 'the refusal is not saved either')

    // A restarted pty is born at the desktop size: right after its replay the phone stays in phone mode.
    p.state().setPaneMode('p', 'phone')
    s.recv({ type: 'replay', paneId: 'p', running: true, data: '', cols: 120, rows: 40 })
    s.recv({ type: 'fitState', paneId: 'p', owner: 'desktop', cols: 120, rows: 40 })
    check(p.api.selectPaneMode(p.state(), 'p') === 'phone', 'a desktop fitState right after a running replay keeps phone mode (the phone re-claims it)')
    p.advance(p.api.FIT_REPLAY_GRACE_MS + 1)
    s.recv({ type: 'fitState', paneId: 'p', owner: 'desktop', cols: 121, rows: 40 })
    check(p.api.selectPaneMode(p.state(), 'p') === 'desktop', 'past the grace the PC taking it back counts again')

    // The re-claim closes the grace: a desktop release after its ack is honored at once.
    p.state().setPaneMode('p', 'phone')
    s.recv({ type: 'replay', paneId: 'p', running: true, data: '', cols: 120, rows: 40 })
    const reclaim = client.sendFitPane('p', 50, 40)
    const c3 = s.sent.filter(m => m.type === 'ctl').at(-1)
    s.recv({ type: 'fitState', paneId: 'p', owner: 'phone', cols: 50, rows: 40 })
    s.recv({ type: 'ctlAck', id: c3.id, ok: true })
    await reclaim
    s.recv({ type: 'fitState', paneId: 'p', owner: 'desktop', cols: 120, rows: 40 })
    check(p.api.selectPaneMode(p.state(), 'p') === 'desktop', 'after the re-claim was acked, a desktop release inside 1.5s still switches to desktop')

    // A pane this phone does not view still learns the release.
    p.state().setPaneMode('q', 'phone')
    s.recv({ type: 'fitState', paneId: 'q', owner: 'desktop', cols: 100, rows: 30 })
    check(p.api.selectPaneMode(p.state(), 'q') === 'desktop' && p.state().sizeInfo.q.cols === 100, 'a release of another pane switches that pane to desktop too')

    client.releaseFit('p')
    const rel = s.sent.filter(m => m.type === 'ctl').at(-1)
    check(rel.action.kind === 'releaseFit' && rel.action.paneId === 'p', 'releaseFit goes out as its ctl')

    // v2.2.1: phone-wide phone mode; the PC taking p back lasts until p is opened again.
    p.state().setPhoneModeGlobal('phone')
    p.advance(p.api.FIT_REPLAY_GRACE_MS + 1)
    s.recv({ type: 'fitState', paneId: 'p', owner: 'desktop', cols: 120, rows: 40 })
    check(p.api.selectPaneMode(p.state(), 'p') === 'desktop' && p.local.get('snagentsos.remote.phoneFitDefault') === 'true', 'a reclaim under the phone-wide mode is a pane override, the setting stays phone')
    client.viewPane('p')
    check(p.api.selectPaneMode(p.state(), 'p') === 'desktop', 'viewing the same console again (no switch) keeps the override, so the PC and the phone never fight')
    client.viewPane('q')
    check(s.sent.at(-2).type === 'unsub' && s.sent.at(-2).paneId === 'p' && s.sent.at(-1).type === 'sub' && s.sent.at(-1).paneId === 'q', 'switching consoles leaves the old stream (unsub p, sub q)')
    client.viewPane('p')
    check(p.api.selectPaneMode(p.state(), 'p') === 'phone', 'opening p again drops its override: phone mode again')

    // Home leaves the stream so the PC gets its size back; coming back re-subscribes.
    client.leaveTerminal()
    check(s.sent.at(-1).type === 'unsub' && s.sent.at(-1).paneId === 'p' && p.state().subscribedPaneId === null && p.state().screen === 'home', 'going Home sends unsub and drops the subscription')
    check(p.state().activePaneId === 'p', 'the console is still remembered for the way back')
    client.showPane('p')
    check(s.sent.at(-1).type === 'sub' && s.sent.at(-1).paneId === 'p' && p.state().subscribedPaneId === 'p' && p.state().screen === 'terminal', 'opening it again subscribes (a fresh replay re-claims the size)')
  })
}

function testHomeReconnect() {
  // A reconnect while on Home remembers the console but streams nothing (v2.2.1).
  const local = new Map([['snagentsos.remote.deviceId', 'dev1'], ['snagentsos.remote.secret', '00'.repeat(32)], ['snagentsos.lastPane', 'p'], ['snagentsos.remote.phoneFitDefault', 'true']])
  const p = page(local)
  p.api.client.start()
  const s = p.last()
  s.open()
  s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  check(p.state().screen === 'home' && p.state().activePaneId === 'p' && p.state().subscribedPaneId === null && !s.sent.some(m => m.type === 'sub'), 'going live on Home remembers lastPane without subscribing it (no fitPane from Home)')
  p.api.client.showPane('p')
  check(s.sent.at(-1).type === 'sub' && s.sent.at(-1).paneId === 'p', 'Resume subscribes it')
}

const FIT_OWNED = 'snagentsos.fitOwned'
const authOk = { type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION }
const pairedLocal = (extra = []) => new Map([['snagentsos.remote.deviceId', 'dev1'], ['snagentsos.remote.secret', '00'.repeat(32)], ...extra])
const ctls = (s, kind) => s.sent.filter(m => m.type === 'ctl' && m.action.kind === kind)

/** Drop the socket, wait for the reconnect (fake clock), open it and go live again. */
function relive(p, between = () => {}) {
  const before = p.sockets.length
  p.last().drop()
  between()
  for (let i = 0; i < 600 && p.sockets.length === before; i++) p.advance(100)
  check(p.sockets.length === before + 1, 'the client reconnects after the drop')
  const s = p.last()
  s.open()
  s.recv(authOk)
  return s
}

/** This phone sends fitPane for p and gets its own fitState phone and the ack. */
async function ownP(p, s) {
  const done = p.api.client.sendFitPane('p', 50, 40)
  const ctl = s.sent.filter(m => m.type === 'ctl').at(-1)
  s.recv({ type: 'fitState', paneId: 'p', owner: 'phone', cols: 50, rows: 40 })
  s.recv({ type: 'ctlAck', id: ctl.id, ok: true })
  await done
}

async function testReconnectIsNotAnOpen() {
  // v2.2.1: the per-open flags (the PC's reclaim, a refused chat) survive a socket drop.
  const p = page(pairedLocal([['snagentsos.remote.phoneFitDefault', 'true']]))
  const { client } = p.api
  p.api.setLang('en')
  client.start()
  let s = p.last()
  s.open()
  s.recv(authOk)
  client.showPane('p')
  await ownP(p, s)
  check(p.session.get(FIT_OWNED) === '["p"]', 'its own fitState phone records p in sessionStorage snagentsos.fitOwned')
  p.advance(p.api.FIT_REPLAY_GRACE_MS + 1)
  s.recv({ type: 'fitState', paneId: 'p', owner: 'desktop', cols: 120, rows: 40 })
  check(p.api.selectPaneMode(p.state(), 'p') === 'desktop' && !p.session.has(FIT_OWNED), 'the PC took p back: a desktop override, and p is no longer owned')
  p.state().setChatRefused('p', true)
  s = relive(p)
  check(s.sent.some(m => m.type === 'sub' && m.paneId === 'p') && p.state().subscribedPaneId === 'p', 'the console still on screen is subscribed again')
  check(p.api.selectPaneMode(p.state(), 'p') === 'desktop', 'the reconnect keeps the override, so the phone does not shrink the PC again while its user types')
  check(p.state().chatRefused.p === true, 'and a refused chat stays refused (no chatSub, no toast again)')
  check(ctls(s, 'releaseFit').length === 0, 'nothing owned, nothing released')
  client.showPane('q')
  client.showPane('p')
  check(p.api.selectPaneMode(p.state(), 'p') === 'phone' && !p.state().chatRefused.p, 'opening p again on purpose drops both')
}

async function testReleaseLeftWhileOffline() {
  // v2.2.1: a leave that never reached the PC (socket closed) is given back on the next goLive.
  const p = page(pairedLocal([['snagentsos.remote.phoneFitDefault', 'true']]))
  const { client } = p.api
  p.api.setLang('en')
  client.start()
  let s = p.last()
  s.open()
  s.recv(authOk)
  client.showPane('p')
  await ownP(p, s)
  s = relive(p, () => {
    client.leaveTerminal()
    check(p.state().screen === 'home' && p.state().subscribedPaneId === null && p.session.get(FIT_OWNED) === '["p"]', 'Home while offline: the unsub is lost, so p stays owned')
  })
  const rel = ctls(s, 'releaseFit')
  check(rel.length === 1 && rel[0].action.paneId === 'p' && !s.sent.some(m => m.type === 'sub'), 'going live on Home sends releaseFit for p (no sub)')
  check(!p.session.has(FIT_OWNED), 'and forgets it')
  s.recv({ type: 'fitState', paneId: 'p', owner: 'desktop', cols: 120, rows: 40 })
  s.recv({ type: 'ctlAck', id: rel[0].id, ok: true })
  await Promise.resolve()
  check(!p.state().toasts.some(x => x.text === 'The PC took the size back') && p.api.selectPaneMode(p.state(), 'p') === 'phone', 'its fitState desktop is no "PC took it back": p stays in phone mode for the next open')

  // A leave the desktop did receive needs no release later.
  client.showPane('p')
  await ownP(p, s)
  client.leaveTerminal()
  check(s.sent.at(-1).type === 'unsub' && !p.session.has(FIT_OWNED), 'Home online: the unsub reached main (it releases), p is no longer owned')
  s = relive(p)
  check(ctls(s, 'releaseFit').length === 0, 'so the next goLive releases nothing')
}

function testReleaseAfterReload() {
  // A page the browser reloaded starts on Home: sessionStorage still names what it held.
  const session = new Map([[FIT_OWNED, '["p","gone"]']])
  const p = page(pairedLocal([['snagentsos.lastPane', 'p']]), session)
  p.api.client.start()
  const s = p.last()
  s.open()
  s.recv(authOk)
  const rel = ctls(s, 'releaseFit')
  check(p.state().screen === 'home' && rel.length === 1 && rel[0].action.paneId === 'p', 'after a reload on Home, goLive releases the held pane (a pane no longer in the snapshot is skipped)')
  check(!session.has(FIT_OWNED), 'and clears snagentsos.fitOwned')
}

function testPaneViewReset() {
  // v2.2.1 (bug 8): the paneView keys saved up to v2.2.0 go away once, then real exceptions stay.
  const local = pairedLocal([['snagentsos.remote.chatDefault', 'true'], ['snagentsos.remote.paneView.p', 'terminal'], ['snagentsos.remote.paneView.q', 'chat']])
  const p = page(local)
  check(Object.keys(p.state().paneViews).length === 0 && ![...local.keys()].some(k => k.startsWith('snagentsos.remote.paneView.')), 'the old snagentsos.remote.paneView.* keys are removed on load')
  check(local.get('snagentsos.remote.paneViewReset') === '1' && local.get('snagentsos.remote.chatDefault') === 'true', 'the reset is marked done and chatDefault is kept')
  local.set('snagentsos.remote.paneView.p', 'terminal')
  const again = page(local)
  check(again.state().paneViews.p === 'terminal', 'once marked, a saved exception survives the next load')
}

async function main() {
  const p = page()
  testGrid(p.api)
  testKeyboard(p.api)
  testScheduler(p.api)
  testDecide(p.api)
  testStorage()
  await testClient()
  testHomeReconnect()
  await testReconnectIsNotAnOpen()
  await testReleaseLeftWhileOffline()
  testReleaseAfterReload()
  testPaneViewReset()
  console.log(`PASS: ${checks} phone mode checks (phoneGrid, keyboard rule, scheduler, fitState decisions, phone-wide mode and migration, client, Home, reconnect, release left offline, Chat view reset)`)
}

main().catch(error => { console.error(error); process.exit(1) })
