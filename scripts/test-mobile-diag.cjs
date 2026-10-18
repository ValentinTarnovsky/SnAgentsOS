// Phone diagnostics logic (M9, E2-FR-35..37), run in node:vm with fake browser
// globals: the connection log ring (redaction, 200 cap, 1s sessionStorage
// debounce, < 40KB), the log hooks of the client state machine (auth path with
// a real challenge, 1006 close and retry), the 25s pairing ceiling (timeout,
// pairPending and pairDenied before it, Retry), measureRtt, probeServer and
// the checks / "What this suggests" rules of lib/diagnostics.ts.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createHmac } = require('node:crypto')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const BUNDLE_VERSION = '2.0.0'
const SECRET = 'ab'.repeat(32)
const code = buildSync({
  stdin: {
    resolveDir: root, loader: 'ts', contents: `
export { client, PAIR_CEILING_MS, CONNECT_TIMEOUT_MS } from './src/mobile/src/lib/client'
export { store } from './src/mobile/src/lib/store'
export * as connLog from './src/mobile/src/lib/connLog'
export * as diag from './src/mobile/src/lib/diagnostics'
` },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  define: { __APP_VERSION__: JSON.stringify(BUNDLE_VERSION), 'process.env.NODE_ENV': '"production"' },
  alias: { '@shared': path.join(root, 'src/shared') },
}).outputFiles[0].text

const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, keyButtons: [], activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'W', layoutOrder: ['p'], panes: [{ id: 'p', title: 'P', type: 'shell', running: true }] }] }

function page({ paired = true, hash = '', session = new Map(), hostname = '192.168.1.20' } = {}) {
  let clock = 0, seq = 0
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
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; this.closeCode = null; sockets.push(this) }
    send(data) { this.sent.push(JSON.parse(data)) }
    close(code) { this.closed = true; this.closeCode = code ?? null; this.readyState = 3 }
    open() { this.readyState = 1; this.onopen && this.onopen({}) }
    recv(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify({ v: 1, ...msg }) }) }
    drop(code = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code, wasClean: false, reason: '' }) }
    count(type) { return this.sent.filter(m => m.type === type).length }
  }
  const listeners = { doc: {}, win: {} }
  const on = bag => (type, fn) => { (bag[type] ||= []).push(fn) }
  const document = { visibilityState: 'visible', addEventListener: on(listeners.doc), documentElement: { style: { setProperty() {} } }, head: { appendChild() {} }, querySelector: () => null, createElement: () => ({}) }
  const window = { addEventListener: on(listeners.win) }
  const navigator = { onLine: true, vibrate: () => true }
  const mapStorage = map => ({ get length() { return map.size }, key: i => [...map.keys()][i] ?? null, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) })
  const local = new Map(paired ? [['snagentsos.remote.deviceId', 'dev1'], ['snagentsos.remote.secret', SECRET]] : [])
  const location = { host: `${hostname}:4517`, hostname, hash, pathname: '/', search: '', reload() {} }
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
  return {
    ...api, sockets, session,
    get clock() { return clock },
    state: () => api.store.getState(),
    diagState: () => api.connLog.useDiagStore.getState(),
    logText: () => api.connLog.entries().map(e => e.msg).join('\n'),
    last: () => sockets.at(-1),
    advance: ms => runDue(clock + ms),
  }
}

function testRedact(p) {
  const r = p.connLog.redact
  const nonce = 'f'.repeat(64)
  check(!r(`secret=${SECRET}`).includes(SECRET) && r(`secret=${SECRET}`).includes('<redacted>'), 'secret= value is redacted')
  check(!r(`{"hmac":"0123abcd"}`).includes('0123abcd'), 'JSON hmac value is redacted')
  check(!r('proof: deadbeef').includes('deadbeef') && !r('nonce=abc123').includes('abc123'), 'proof and nonce are redacted')
  check(!r('clientNonce=zz99').includes('zz99') && !r('token=tok_live_1').includes('tok_live_1'), 'clientNonce and token are redacted')
  check(!r('pair sent pairCode=QW12ER34').includes('QW12ER34'), 'pairCode= is redacted')
  check(!r('pair sent code=QW12ER34').includes('QW12ER34'), 'code= is redacted on a pair line')
  check(r('err code=version').includes('code=version'), 'code= outside a pair line is kept')
  check(!r('http://192.168.1.20:4517/#pair=QW12ER34').includes('QW12ER34'), '#pair= fragment is redacted')
  check(!r(`blob ${nonce} end`).includes(nonce), 'a 32+ hex run is redacted')
  check(r('close=1006 clean=false dur=1234') === 'close=1006 clean=false dur=1234', 'close lines are untouched')
  check(r('dial 192.168.1.20:4517').includes('192.168.1.20'), 'the dialed IP stays readable')
}

function testRing() {
  const p = page()
  for (let i = 0; i < 260; i++) p.connLog.log(i % 3 ? 'info' : 'warn', `line ${i} ${'x'.repeat(200)}`)
  const list = p.connLog.entries()
  check(list.length === 200 && list[0].msg.startsWith('line 60 '), 'the ring keeps the last 200 entries')
  check(!p.session.has('snagentsos.diag'), 'the sessionStorage mirror is debounced')
  p.advance(999); check(!p.session.has('snagentsos.diag'), 'nothing is written before 1s')
  p.advance(1)
  const stored = p.session.get('snagentsos.diag')
  check(!!stored && stored.length < 40 * 1024, `the stored copy stays under 40KB (${stored && stored.length} chars)`)
  check(JSON.parse(stored).at(-1).msg.startsWith('line 259 '), 'the stored copy ends with the newest entry')
  // A reload in the same tab reads the mirror back.
  const p2 = page({ session: p.session })
  check(p2.connLog.entries().length > 0 && p2.connLog.entries().at(-1).msg.startsWith('line 259 '), 'a reload restores the log from sessionStorage')
  check(/^\d\d:\d\d:\d\d\.\d{3} [IWE] /.test(p.connLog.formatEntry(list[0])), 'formatEntry prints time, level and message')
}

function testAuthLog() {
  const p = page(); p.client.start()
  const s = p.last(); s.open()
  const hello = s.sent.find(m => m.type === 'hello')
  const key = Buffer.from(SECRET, 'hex')
  const proof = createHmac('sha256', key).update(hello.clientNonce).digest('hex')
  const nonce = 'c'.repeat(64)
  s.recv({ type: 'challenge', nonce, proof })
  const auth = s.sent.find(m => m.type === 'auth')
  check(!!auth, 'a valid proof is answered with auth')
  p.advance(30)
  s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  const text = p.logText()
  for (const ev of ['dial 192.168.1.20:4517', 'open +', 'challenge', 'proof ok', 'auth sent', 'authOk +30ms']) check(text.includes(ev), `log has "${ev}"`)
  p.advance(1000)
  const stored = p.session.get('snagentsos.diag') || ''
  for (const secret of [SECRET, auth.hmac, hello.clientNonce, nonce, proof]) check(!text.includes(secret) && !stored.includes(secret), 'no secret, HMAC, nonce or proof in the log')
  s.drop(1006)
  const after = p.logText()
  check(/close=1006 clean=false dur=\d+/.test(after), 'the close line carries code, clean and duration')
  check(/retry in 500ms attempt=1/.test(after), 'the scheduled retry is logged with delay and attempt')
  check(p.diagState().lastClose.code === 1006 && p.diagState().abnormalStreak === 1 && p.diagState().retries === 1, 'lastClose, streak and retries are tracked')
  p.advance(500); p.last().drop(1006)
  check(p.diagState().abnormalStreak === 2, 'consecutive 1006 closes build the streak')
  p.advance(1000); p.last().open(); p.last().recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  check(p.diagState().abnormalStreak === 0, 'authOk resets the abnormal streak')
  // Version mismatch is logged.
  const q = page(); q.client.start(); q.last().open()
  q.last().recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: '2.0.1' })
  check(q.logText().includes('version mismatch desktop=2.0.1 bundle=2.0.0'), 'a version mismatch is logged')
  // Impostor proof.
  const r = page(); r.client.start(); r.last().open(); r.last().recv({ type: 'challenge', nonce, proof: '00'.repeat(32) })
  check(r.logText().includes('proof mismatch') && r.state().phase === 'impostor', 'a bad proof is logged as mismatch')
}

function testRtt() {
  const p = page(); p.client.start(); const s = p.last(); s.open()
  s.recv({ type: 'authOk', deviceId: 'dev1', state: snapshot, hostPlatform: 'win32', appVersion: BUNDLE_VERSION })
  let got
  p.client.measureRtt().then(v => { got = v })
  const ping = s.sent.filter(m => m.type === 'ping').at(-1)
  check(!!ping, 'measureRtt sends a ping')
  p.advance(42); s.recv({ type: 'pong', t: ping.t })
  return Promise.resolve().then(() => {
    check(got === 42 && p.diagState().rttMs === 42, 'measureRtt resolves with the pong round trip')
    const q = page({ paired: false }); q.client.start()
    return q.client.measureRtt().then(v => check(v === null, 'measureRtt without a live socket resolves null'))
  })
}

async function testPairCeiling() {
  {
    // Wrong IP: nothing ever opens. Retries stay inside the 25s ceiling.
    const p = page({ paired: false, hash: '#pair=QW12ER34' }); p.client.start()
    p.client.submitPairing('phone')
    check(p.state().phase === 'connecting' && p.diagState().pairCeilingAt === 1700000000000 + 25000, 'submitPairing arms the 25s ceiling')
    p.advance(p.CONNECT_TIMEOUT_MS + 600)
    check(p.sockets.length >= 2 && p.state().phase === 'connecting', 'a dead pairing socket retries instead of falling back to the form')
    p.advance(25000 - p.clock - 1)
    check(!p.diagState().pairTimedOut, 'the ceiling has not run out at 24.999s')
    p.advance(1)
    check(p.diagState().pairTimedOut && p.diagState().pairCeilingAt === null && p.state().phase === 'connecting', 'at 25s the attempt times out on the connecting screen')
    check(p.sockets.every(x => x.closed), 'the timeout closes the pending socket')
    const n = p.sockets.length; p.advance(120000)
    check(p.sockets.length === n, 'no more attempts after the timeout')
    check(p.logText().includes('pair ceiling 25s') && !p.logText().includes('QW12ER34'), 'the timeout is logged without the code')
    p.client.retry()
    check(!p.diagState().pairTimedOut && p.diagState().pairCeilingAt !== null && p.sockets.length === n + 1, 'Retry starts a fresh attempt with a new ceiling')
    p.last().open()
    check(p.last().sent.some(m => m.type === 'pair' && m.code === 'QW12ER34'), 'the retry sends the same code')
  }
  {
    const p = page({ paired: false, hash: '#pair=QW12ER34' }); p.client.start(); p.client.submitPairing('phone')
    p.advance(5000); p.last().open(); p.last().recv({ type: 'pairPending' })
    check(p.diagState().pairCeilingAt === null && p.state().pairExpiresAt === 1700000000000 + 5000 + 60000, 'pairPending ends the ceiling and starts the 60s countdown')
    p.advance(30000)
    check(p.state().phase === 'pairPending' && !p.diagState().pairTimedOut, 'pairPending before 25s keeps waiting past the ceiling')
  }
  {
    const p = page({ paired: false, hash: '#pair=QW12ER34' }); p.client.start(); p.client.submitPairing('phone')
    p.advance(3000); p.last().open(); p.last().recv({ type: 'pairDenied', reason: 'badCode' })
    check(p.state().phase === 'pairDenied' && p.diagState().pairCeilingAt === null, 'pairDenied shows the rejection at once')
    p.advance(30000)
    check(p.state().phase === 'pairDenied' && !p.diagState().pairTimedOut, 'the ceiling never fires after pairDenied')
    check(p.logText().includes('pairDenied reason=badCode'), 'pairDenied is logged with its reason')
  }
  {
    const p = page({ paired: false, hash: '#pair=QW12ER34' }); p.client.start(); p.client.submitPairing('phone')
    p.last().open(); p.last().drop(4429)
    p.advance(30000)
    check(p.state().phase === 'locked' && !p.diagState().pairTimedOut && p.diagState().pairCeilingAt === null, 'a rate-limit close keeps the locked screen, the ceiling stays quiet')
  }
  {
    const p = page({ paired: false, hash: '#pair=QW12ER34' }); p.client.start(); p.client.submitPairing('phone')
    p.last().open(); p.last().recv({ type: 'paired', deviceId: 'd2', secret: SECRET })
    check(p.diagState().pairCeilingAt === null && p.logText().includes('paired'), 'paired ends the ceiling')
    check(!p.logText().includes(SECRET), 'the paired secret never reaches the log')
  }
}

async function testDiagRules(p) {
  const d = p.diag
  const base = { paired: true, hostname: '192.168.1.20', live: false, server: { kind: 'open', ms: 30 }, lastClose: null, abnormalStreak: 0, desktopVersion: '2.0.0', bundleVersion: '2.0.0', retries: 0, lastConnectedAt: null, locked: false, now: 100000 }
  const byId = (i) => Object.fromEntries(d.buildChecks({ ...base, ...i }).map(c => [c.id, c.result]))
  const ok = byId({})
  check(Object.keys(ok).join() === 'paired,route,server,lastClose,version,retries', 'six checks in order')
  check(Object.values(ok).every(r => r === 'pass'), 'a healthy setup passes every check')
  check(byId({ paired: false }).paired === 'fail' && byId({ hostname: 'pc.example.com' }).route === 'warn', 'not paired fails, an unknown route warns')
  check(byId({ server: { kind: 'fail' } }).server === 'fail' && byId({ server: { kind: 'rtt', ms: 9 } }).server === 'pass', 'server check reads the probe')
  check(byId({ lastClose: { code: 4403, reason: '', clean: true, at: 90000 } }).lastClose === 'fail', '4403 fails the last close')
  check(byId({ lastClose: { code: 1006, reason: '', clean: false, at: 90000 } }).lastClose === 'warn', '1006 warns')
  check(byId({ desktopVersion: '2.0.1' }).version === 'fail' && byId({ desktopVersion: '' }).version === 'warn', 'version mismatch fails, unknown warns')
  check(byId({ retries: 3 }).retries === 'warn' && byId({ retries: 3, live: true }).retries === 'pass', 'retries warn only while not live')
  const sug = (i) => d.suggestions({ ...base, ...i })
  check(sug({}).length === 0, 'no suggestion when healthy')
  check(sug({ server: { kind: 'fail' } }).includes('abnormal'), 'desktop closed: the probe failure suggests firewall / Wi-Fi / sleeping PC')
  check(sug({ abnormalStreak: 2, server: { kind: 'pending' } }).includes('abnormal') && !sug({ abnormalStreak: 1, server: { kind: 'pending' } }).includes('abnormal'), 'repeated 1006 suggests the same, a single one does not')
  check(sug({ lastClose: { code: 4401, reason: '', clean: true, at: 1 } }).includes('rePair'), '4401 suggests pairing again')
  check(sug({ lastClose: { code: 4403, reason: '', clean: true, at: 1 } })[0] === 'revoked', '4403 suggests revoked')
  check(sug({ lastClose: { code: 4429, reason: '', clean: true, at: 1 } }).includes('wait') && sug({ locked: true }).includes('wait'), '4429 or locked suggests waiting')
  check(sug({ hostname: '100.101.1.2', server: { kind: 'fail' } }).includes('tailscale'), 'Tailscale route with failures suggests toggling Tailscale')
  check(sug({ desktopVersion: '2.0.1' }).includes('reload'), 'another desktop version suggests reloading')
  const report = d.buildReport({ ...base, userAgent: 'UA/1', host: '192.168.1.20:4517', checks: d.buildChecks(base), entries: Array.from({ length: 80 }, (_, i) => ({ t: 0, level: 'info', msg: 'l' + i })), describe: c => c.id })
  check(report.includes('desktop: 2.0.0  bundle: 2.0.0') && report.includes('ua: UA/1') && report.includes('host: 192.168.1.20:4517'), 'report has versions, UA and host')
  check(report.includes('[PASS] server') && report.includes(' l79') && !report.includes(' l29\n'), 'report has the checks and only the last 50 lines')
  check(d.closeMeaning(1000) === 'normal' && d.closeMeaning(4429) === 'rateLimited' && d.closeMeaning(1011) === 'other', 'closeMeaning maps the codes')

  // probeServer: a host that never answers fails at 4s; one that opens is closed with 1000 and gets nothing.
  const q = page()
  let res = null
  q.diag.probeServer('10.0.0.9:4517').then(v => { res = v })
  q.advance(3999); await Promise.resolve(); check(res === null, 'the probe is still waiting at 3.999s')
  q.advance(1); await Promise.resolve(); await Promise.resolve()
  check(res && res.kind === 'fail' && q.last().closed, 'the probe fails at 4s and closes its socket')
  res = null
  q.diag.probeServer('192.168.1.20:4517').then(v => { res = v })
  const ps = q.last(); q.advance(25); ps.open(); await Promise.resolve(); await Promise.resolve()
  check(res && res.kind === 'open' && res.ms === 25, 'the probe resolves with its open time')
  check(ps.closed && ps.closeCode === 1000 && ps.sent.length === 0 && ps.url === 'ws://192.168.1.20:4517/ws', 'the probe closes with 1000 without sending hello')
}

async function main() {
  const p = page()
  testRedact(p)
  testRing()
  testAuthLog()
  await testRtt()
  await testPairCeiling()
  await testDiagRules(p)
  console.log(`PASS: ${checks} mobile diagnostics checks`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
