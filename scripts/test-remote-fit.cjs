// Phone-fit (E3 M11, FR-12..23) against the real main and renderer modules:
// the ctl schemas at their limits, FitController + RemoteManager +
// SessionManager with a fake socket, a fake pty table, a fake renderer
// executor and a fake clock (owner, 50ms coalesce, 250ms grace, held, 5 min
// auto restore, chat presence, two devices, exit, server off, reload), the
// replay after a resize with and without the headless mirror (fake node-pty),
// and the renderer side (fitStore geometry, executor cases, desktop release).
// Nothing listens, no pty is spawned and dataDir() is a temp folder.
const { build, buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const tick = () => new Promise(resolve => setImmediate(resolve))

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-fit-'))
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /\/RemoteServer$/ }, () => ({ path: 'RemoteServer', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
    b.onLoad({ filter: /^RemoteServer$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `
export class RemoteServer {
  constructor(port: number, handlers: any) { (globalThis as any).__server = { port, handlers } }
  start() { return Promise.resolve() }
  close() {}
}` }))
    b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(dataDir)} }` }))
  },
}
let code = ''
const entry = `
export { RemoteManager } from './src/main/remote/RemoteManager'
export { FitController, FIT_GRACE_MS, FIT_AUTO_RESTORE_MS, FIT_COALESCE_MS } from './src/main/remote/FitController'
export { parseRemoteClientMsg } from './src/shared/remote-protocol-schemas'
`

const DESKTOP = { p1: { cols: 120, rows: 40 }, p2: { cols: 100, rows: 30 } }

function world(opts = {}) {
  // Each world starts with no paired devices (the registry loads lazily from dataDir).
  for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f), { recursive: true, force: true })
  let clock = 0, seq = 0
  const timers = new Map()
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: clock + Math.max(0, ms || 0), fn, every }); return { id, unref() {}, ref() {} } }
  const del = h => { if (h) timers.delete(typeof h === 'object' ? h.id : h) }
  function advance(ms) {
    const end = clock + ms
    for (;;) {
      let best = null
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t]
      if (!best) break
      const [id, t] = best
      clock = Math.max(clock, t.at)
      if (t.every) t.at += t.every; else timers.delete(id)
      t.fn()
    }
    clock = end
  }
  class FakeDate extends Date { static now() { return 1700000000000 + clock } }
  const ctx = {
    module: { exports: {} }, require: id => id === 'qrcode' ? { toDataURL: async () => 'data:' } : require(id),
    console, process, Buffer, URL, queueMicrotask,
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: del,
    setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: del,
    Date: FakeDate,
  }
  ctx.exports = ctx.module.exports
  ctx.globalThis = ctx
  vm.runInNewContext(code, ctx)
  const api = ctx.module.exports

  // The live pty table: sizes per pane; a resize that changes something is
  // reported to the sink, like PtyManager.resize.
  const sizes = new Map(Object.entries(DESKTOP).map(([k, v]) => [k, { ...v }]))
  const resizes = []
  let sink = null
  const pty = {
    addSink(s) { sink = s }, removeSink() { sink = null }, setRunningChangeListener() {}, setForcedFast() {},
    runningPaneIds: () => [...sizes.keys()],
    exitedPaneCodes: () => new Map(),
    getReplay: paneId => sizes.has(paneId) ? { ptyId: 'pty-' + paneId, replay: 'R:' + paneId, ...sizes.get(paneId) } : null,
    getExited: () => null,
    ptyIdForPane: paneId => sizes.has(paneId) ? 'pty-' + paneId : null,
    sizeOf: paneId => sizes.has(paneId) ? { ...sizes.get(paneId) } : null,
    write() {},
    resizePane(paneId, cols, rows) {
      const cur = sizes.get(paneId)
      if (!cur || (cur.cols === cols && cur.rows === rows)) return
      sizes.set(paneId, { cols, rows })
      resizes.push({ paneId, cols, rows })
      sink && sink.onResize('pty-' + paneId, paneId, cols, rows)
    },
    exit(paneId) { sink && sink.onExit('pty-' + paneId, paneId, 0, { current: true, natural: true }) },
  }
  // A fake renderer executor: records every relayed ctl and, unless told
  // otherwise, applies it the way remoteCommands does (pty size) and acks.
  const commands = []
  let reply = cmd => ({ ok: true })
  const webContents = {
    isDestroyed: () => false, setBackgroundThrottling() {},
    send: (ch, cmd) => {
      if (ch !== 'remote:controlCmd') return
      commands.push(cmd)
      const a = cmd.action
      const res = reply(cmd)
      if (res === null) return // no answer: the 10s timeout
      if (res.ok && a.kind === 'fitPane') pty.resizePane(a.paneId, a.cols, a.rows)
      if (res.ok && a.kind === 'releaseFit') {
        const base = cmd.fit?.baseline ?? DESKTOP[a.paneId]
        if (base) pty.resizePane(a.paneId, base.cols, base.rows)
      }
      queueMicrotask(() => manager.onControlResult({ id: cmd.id, ...res }))
    },
  }
  const manager = new api.RemoteManager(pty, () => webContents, '2.0.0', () => [], () => 'PC')
  manager.applyConfig({ enabled: true, port: 4600, phoneFit: opts.phoneFit !== false })
  manager.pushState(snapshot)

  class FakeSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.inbox = []; this.handlers = {}; this.closed = null }
    on(ev, fn) { this.handlers[ev] = fn }
    send(data) { this.inbox.push(JSON.parse(data)) }
    close(c) { this.closed = c; this.readyState = 3; this.handlers.close && this.handlers.close() }
    terminate() { this.close(1006) }
    msg(obj) { this.handlers.message(JSON.stringify({ v: 1, ...obj })) }
    of(type) { return this.inbox.filter(m => m.type === type) }
  }
  const socket = () => { const ws = new FakeSocket(); ctx.__server.handlers.onSocket(ws, '100.64.0.9', '100.64.0.9'); return ws }
  return {
    api, manager, pty, sizes, resizes, commands, socket, advance,
    setReply(fn) { reply = fn },
    ofKind: kind => commands.filter(c => c.action.kind === kind),
  }
}

async function pair(w) {
  await tick()
  const payload = await w.manager.pairingBegin()
  const ws = w.socket()
  ws.msg({ type: 'hello', clientNonce: 'aa'.repeat(32) })
  ws.msg({ type: 'pair', code: payload.code, deviceName: 'Phone' })
  const requestId = w.manager.getUiState().pendingPairing.requestId
  w.manager.pairingResolve(requestId, true)
  const paired = ws.of('paired')[0]
  return { ws, deviceId: paired.deviceId, secret: paired.secret }
}

const snapshot = {
  workspaces: [{ id: 'w1', name: 'One', layoutOrder: ['p1', 'p2'], panes: [
    { id: 'p1', title: 'A', type: 'claude', color: '', icon: '', running: true },
    { id: 'p2', title: 'B', type: 'shell', color: '', icon: '', running: true },
  ] }],
  activeWorkspaceId: 'w1', themeTokens: {}, language: 'en', fontFamily: '', fontSize: 14,
}

const fitPane = (id, paneId, cols, rows) => ({ type: 'ctl', id, action: { kind: 'fitPane', workspaceId: 'w1', paneId, cols, rows } })
const ack = (ws, id) => ws.of('ctlAck').find(a => a.id === id)
const fitStates = (ws, paneId) => ws.of('fitState').filter(m => m.paneId === paneId)

/** Let time pass with the phone pinging every 25s, so the keepalive keeps the socket. */
function idle(w, sockets, ms) {
  for (let left = ms; left > 0; left -= 20000) {
    for (const ws of sockets) if (ws.readyState === 1) ws.msg({ type: 'ping', t: 1 })
    w.advance(Math.min(20000, left))
  }
}

/** fitPane through the socket, past the coalesce window and the executor round trip. */
async function claim(w, ws, id, paneId, cols, rows) {
  ws.msg(fitPane(id, paneId, cols, rows))
  await tick()
  w.advance(w.api.FIT_COALESCE_MS)
  await tick(); await tick()
  return ack(ws, id)
}

// --- Schemas (E3-FR-20) -----------------------------------------------------------

async function testSchemas() {
  const w = world()
  const parse = obj => w.api.parseRemoteClientMsg(JSON.stringify({ v: 1, ...obj }))
  const at = (cols, rows) => parse(fitPane('x', 'p1', cols, rows))
  check(!at(19, 20) && !!at(20, 20) && !!at(500, 20) && !at(501, 20), 'fitPane cols: 19 and 501 are refused, 20 and 500 pass')
  check(!at(80, 7) && !!at(80, 8) && !!at(80, 300) && !at(80, 301), 'fitPane rows: 7 and 301 are refused, 8 and 300 pass')
  check(!at(80.5, 24) && !at('80', 24) && !parse({ type: 'ctl', id: 'x', action: { kind: 'fitPane', paneId: 'p1', cols: 80, rows: 24 } }), 'non-integer, string or missing workspaceId are malformed')
  check(!!parse({ type: 'ctl', id: 'r', action: { kind: 'releaseFit', paneId: 'p1' } }) && !parse({ type: 'ctl', id: 'r', action: { kind: 'releaseFit' } }), 'releaseFit needs a paneId')

  // Out of range through the real socket: err bad_msg (one strike) and no effect.
  const { ws } = await pair(w)
  ws.msg({ type: 'sub', paneId: 'p1' })
  ws.msg(fitPane('bad', 'p1', 10, 20))
  await tick()
  check(ws.of('err').some(e => e.code === 'bad_msg') && !ack(ws, 'bad') && w.commands.length === 0 && w.sizes.get('p1').cols === 120, 'fitPane with cols=10: err bad_msg, no ack, the pty keeps its size')
}

// --- FitController through RemoteManager + SessionManager ----------------------------

async function testAccepted() {
  const w = world()
  const { ws } = await pair(w)
  ws.msg({ type: 'sub', paneId: 'p1' })
  const a = await claim(w, ws, 'f1', 'p1', 50, 40)
  check(a && a.ok === true, 'a subscribed fitPane is acked ok')
  const sent = w.ofKind('fitPane')
  check(sent.length === 1 && sent[0].action.cols === 50 && sent[0].action.rows === 40 && sent[0].fit.ptyId === 'pty-p1' && !sent[0].fit.chat, 'the executor gets fitPane with the ptyId from main')
  check(w.manager.fit.ownerOf('p1') === 'phone' && w.manager.fit.stateOf('p1').state === 'phone', 'the pane is phone-owned')
  const fs1 = fitStates(ws, 'p1')
  check(fs1.length >= 1 && fs1.every(m => m.owner === 'phone' && m.cols === 50 && m.rows === 40), 'the resize reaches the phone as fitState {owner:phone, 50x40}')

  // A size the pty already has (no resize) still confirms ownership.
  const before = fitStates(ws, 'p1').length
  await claim(w, ws, 'f2', 'p1', 50, 40)
  check(fitStates(ws, 'p1').length === before + 1 && fitStates(ws, 'p1').at(-1).owner === 'phone', 'a fitPane equal to the pty size still answers fitState phone (onFitted)')

  // Coalesce: three in a burst, one relayed (the last), three acks.
  const relayed = w.ofKind('fitPane').length
  ws.msg(fitPane('c1', 'p1', 60, 30)); ws.msg(fitPane('c2', 'p1', 61, 30)); ws.msg(fitPane('c3', 'p1', 62, 31))
  await tick()
  w.advance(w.api.FIT_COALESCE_MS)
  await tick(); await tick()
  const burst = w.ofKind('fitPane').slice(relayed)
  check(burst.length === 1 && burst[0].action.cols === 62 && burst[0].action.rows === 31, 'a burst inside 50ms reaches the executor once, with the last grid')
  check(['c1', 'c2', 'c3'].every(id => ack(ws, id)?.ok === true), 'every fitPane of the burst gets its ack')

  // Desktop resizes while owned are reported with owner phone; out goes first.
  const outBefore = ws.inbox.length
  w.pty.resizePane('p2', 90, 30)
  check(ws.inbox.length === outBefore, 'a resize of a pane the phone does not watch sends it nothing')
  ws.msg({ type: 'sub', paneId: 'p2' })
  const pre = ws.inbox.length
  w.pty.resizePane('p2', 80, 25)
  const last = ws.inbox.slice(pre).filter(m => m.type === 'fitState').at(-1)
  check(last && last.paneId === 'p2' && last.owner === 'desktop' && last.cols === 80 && last.rows === 25, 'a desktop resize goes out as fitState {owner:desktop} to the subscribed phone (FR-12)')
}

async function testRefused() {
  const off = world({ phoneFit: false })
  const { ws } = await pair(off)
  ws.msg({ type: 'sub', paneId: 'p1' })
  const a = await claim(off, ws, 'd1', 'p1', 50, 40)
  const st = fitStates(ws, 'p1')
  check(a && a.ok === false && a.error === 'disabled', 'phoneFit=false answers ctlAck {ok:false, error:disabled}')
  check(st.length === 1 && st[0].owner === 'desktop' && st[0].cols === 120 && st[0].rows === 40, 'and a fitState {owner:desktop} with the pty size')
  check(off.commands.length === 0 && off.sizes.get('p1').cols === 120, 'nothing reaches the executor, the pty keeps its size')

  const w = world()
  const { ws: other } = await pair(w)
  const b = await claim(w, other, 'n1', 'p1', 50, 40)
  check(b && b.ok === false && b.error === 'notSubscribed' && w.commands.length === 0 && w.manager.fit.ownerOf('p1') === 'desktop', 'a session not subscribed to the pane gets notSubscribed and changes nothing')

  // The executor does not know the pane: the owner is dropped.
  w.setReply(cmd => cmd.action.kind === 'fitPane' ? { ok: false, error: 'not_found' } : { ok: true })
  other.msg({ type: 'sub', paneId: 'p1' })
  const c = await claim(w, other, 'n2', 'p1', 50, 40)
  check(c && c.error === 'not_found' && w.manager.fit.ownerOf('p1') === 'desktop', 'an executor not_found leaves no owner behind')

  // A pane whose pty is gone (exited, not respawned yet) has nothing to size.
  w.setReply(() => ({ ok: true }))
  other.msg({ type: 'sub', paneId: 'p2' })
  w.sizes.delete('p2')
  const before = w.commands.length
  const d = await claim(w, other, 'n3', 'p2', 50, 40)
  check(d && d.ok === false && d.error === 'not_running' && w.commands.length === before && w.manager.fit.ownerOf('p2') === 'desktop' && fitStates(other, 'p2').length === 0, 'a pane without a live pty answers not_running: no owner, no executor call, no fitState')
}

async function testTwoDevices() {
  const w = world()
  const A = await pair(w), B = await pair(w)
  A.ws.msg({ type: 'sub', paneId: 'p1' })
  B.ws.msg({ type: 'sub', paneId: 'p1' })
  await claim(w, A.ws, 'a1', 'p1', 50, 40)
  await claim(w, B.ws, 'b1', 'p1', 44, 36)
  check(w.sizes.get('p1').cols === 44 && w.sizes.get('p1').rows === 36, 'the last fitPane wins the pty size')
  const seenByA = fitStates(A.ws, 'p1').at(-1)
  check(seenByA.owner === 'phone' && seenByA.cols === 44 && seenByA.rows === 36, 'phone A sees fitState phone with a size it did not send (another device, FR-16)')
  // A leaving no longer affects B's ownership.
  A.ws.msg({ type: 'unsub', paneId: 'p1' })
  w.advance(1000)
  check(w.manager.fit.stateOf('p1').state === 'phone', 'the previous owner leaving does not hold the pane: B still owns it')
}

async function testGraceHeldRestore() {
  const w = world()
  const { ws } = await pair(w)
  ws.msg({ type: 'sub', paneId: 'p1' })
  await claim(w, ws, 'g1', 'p1', 50, 40)
  // unsub, then re-sub inside the grace: no oscillation.
  ws.msg({ type: 'unsub', paneId: 'p1' })
  w.advance(w.api.FIT_GRACE_MS - 50)
  ws.msg({ type: 'sub', paneId: 'p1' })
  w.advance(1000)
  check(w.manager.fit.stateOf('p1').state === 'phone' && w.ofKind('releaseFit').length === 0, 'a re-sub inside the 250ms grace keeps the owner (no held, no release)')

  // v2.2.1: an explicit unsub (another console, Home) gives the size back
  // right after the grace, with no "PC took it back" for the phone that left.
  ws.msg({ type: 'unsub', paneId: 'p1' })
  const seen = fitStates(ws, 'p1').length
  w.advance(w.api.FIT_GRACE_MS - 1)
  check(w.manager.fit.stateOf('p1').state === 'phone', 'still phone until the grace ends')
  w.advance(1)
  await tick(); await tick()
  const rel = w.ofKind('releaseFit')
  check(w.manager.fit.stateOf('p1') === null && w.manager.fit.ownerOf('p1') === 'desktop', 'after 250ms without a re-sub the owner is released at once (no held)')
  check(rel.length === 1 && rel[0].fit.ptyId === 'pty-p1' && rel[0].fit.baseline.cols === 120 && rel[0].fit.baseline.rows === 40 && w.sizes.get('p1').cols === 120, 'main dispatches releaseFit with the pre-phone baseline, the pty is back at the desktop size')
  check(fitStates(ws, 'p1').length === seen, 'the phone that left gets no fitState desktop (notify false: no reclaimed toast, no saved desktop)')

  // Closing the socket goes through the grace, then holds for 5 minutes.
  const second = await pair(w)
  second.ws.msg({ type: 'sub', paneId: 'p2' })
  await claim(w, second.ws, 'g2', 'p2', 40, 20)
  second.ws.close(1000)
  check(w.manager.fit.stateOf('p2').state === 'phone', 'a closed socket keeps the owner during the grace')
  w.advance(w.api.FIT_GRACE_MS)
  const held = w.manager.fit.stateOf('p2')
  check(held.state === 'held' && held.cols === 40 && held.rows === 20 && w.sizes.get('p2').cols === 40, 'then the size is held, the pty keeps the phone grid, the strip stays (FR-17)')
  const before = w.ofKind('releaseFit').length
  idle(w, [ws], w.api.FIT_AUTO_RESTORE_MS - w.api.FIT_GRACE_MS - 1)
  check(w.ofKind('releaseFit').length === before, 'nothing is restored before 5 minutes')
  idle(w, [ws], w.api.FIT_GRACE_MS + 1)
  await tick(); await tick()
  const back = w.ofKind('releaseFit').slice(before)
  check(back.length === 1 && back[0].fit.baseline.cols === 100 && back[0].fit.baseline.rows === 30, 'at 5 minutes main dispatches releaseFit with the pre-phone baseline')
  check(w.manager.fit.ownerOf('p2') === 'desktop' && w.sizes.get('p2').cols === 100, 'the pane is the desktop\'s again, at its size')
  check(fitStates(ws, 'p2').at(-1).owner === 'desktop', 'a phone that is not watching the pane still learns the auto restore (FR-18)')
}

async function testChatPresence() {
  const w = world()
  const { ws } = await pair(w)
  ws.msg({ type: 'sub', paneId: 'p1' })
  await claim(w, ws, 'h1', 'p1', 50, 40)
  const owner = w.manager.fit.stateOf('p1').session
  // FR-21 (R30-05 wires chatSub): unsub + chatSub of the owner inside the grace.
  ws.msg({ type: 'unsub', paneId: 'p1' })
  w.advance(100)
  w.manager.fit.joined(owner, 'p1', true)
  await tick(); await tick()
  const st = w.manager.fit.stateOf('p1')
  check(st.state === 'phone' && st.chat === true && w.manager.fit.chatOf('p1'), 'the owner in Chat is still the owner, with chat:true')
  const chatCmd = w.ofKind('fitPane').at(-1)
  check(chatCmd.fit.chat === true && chatCmd.action.cols === 50, 'the executor hears chat:true so the strip says "(Chat)"')
  idle(w, [ws], 10 * 60 * 1000)
  check(w.manager.fit.stateOf('p1').state === 'phone' && w.ofKind('releaseFit').length === 0, 'ten minutes in Chat start no timer and restore nothing')
  // chatUnsub without a sub within 250ms: released at once (v2.2.1), the strip goes away.
  const n = w.ofKind('releaseFit').length
  w.manager.fit.left(owner, 'p1')
  w.advance(w.api.FIT_GRACE_MS)
  await tick(); await tick()
  check(w.manager.fit.stateOf('p1') === null && w.ofKind('releaseFit').length === n + 1 && w.sizes.get('p1').cols === 120, 'chatUnsub without a sub releases the size right after the grace')
  // A socket lost while the owner reads Chat holds the size, and the strip loses "(Chat)".
  ws.msg({ type: 'sub', paneId: 'p1' })
  await claim(w, ws, 'h2', 'p1', 50, 40)
  w.manager.fit.joined(w.manager.fit.stateOf('p1').session, 'p1', true)
  await tick()
  ws.close(1000)
  w.advance(w.api.FIT_GRACE_MS)
  await tick()
  check(w.manager.fit.stateOf('p1')?.state === 'held' && w.ofKind('fitPane').at(-1).fit.chat !== true, 'a closed socket in Chat holds the size and clears the chat flag')
}

async function testReleasePaths() {
  const w = world()
  const { ws } = await pair(w)
  ws.msg({ type: 'sub', paneId: 'p1' })
  ws.msg({ type: 'sub', paneId: 'p2' })
  await claim(w, ws, 'r1', 'p1', 50, 40)
  await claim(w, ws, 'r2', 'p2', 40, 20)
  // The phone's own releaseFit.
  ws.msg({ type: 'ctl', id: 'rel', action: { kind: 'releaseFit', paneId: 'p1' } })
  await tick(); await tick()
  check(ack(ws, 'rel')?.ok === true && w.manager.fit.ownerOf('p1') === 'desktop' && w.sizes.get('p1').cols === 120, 'the phone\'s releaseFit restores the desktop size')
  check(fitStates(ws, 'p1').at(-1).owner === 'desktop', 'and the phone gets fitState desktop')
  // remote:fitRelease {paneId} from the desktop (strip or a real key).
  w.manager.fitRelease({ paneId: 'p2' })
  await tick(); await tick()
  check(w.manager.fit.ownerOf('p2') === 'desktop' && w.ofKind('releaseFit').some(c => c.action.paneId === 'p2'), 'remote:fitRelease {paneId} dispatches releaseFit to the executor')
  // {all:true}
  await claim(w, ws, 'r3', 'p1', 50, 40)
  await claim(w, ws, 'r4', 'p2', 40, 20)
  const n = w.ofKind('releaseFit').length
  w.manager.fitRelease({ all: true })
  await tick(); await tick()
  check(w.ofKind('releaseFit').length === n + 2 && w.manager.fit.ownerOf('p1') === 'desktop' && w.manager.fit.ownerOf('p2') === 'desktop', 'remote:fitRelease {all:true} restores every phone-sized pane')
  // Nothing owned: no round trip.
  const m = w.commands.length
  w.manager.fitRelease({ paneId: 'p1' })
  await tick()
  check(w.commands.length === m, 'releasing a pane nobody owns is a no-op')

  // The pty exit clears the owner without telling phones "the PC took it back".
  await claim(w, ws, 'r5', 'p1', 50, 40)
  const before = fitStates(ws, 'p1').length
  w.pty.exit('p1')
  await tick(); await tick()
  const after = fitStates(ws, 'p1').slice(before)
  check(w.manager.fit.ownerOf('p1') === 'desktop' && w.ofKind('releaseFit').at(-1).action.paneId === 'p1', 'the pty exit clears the owner and dispatches releaseFit (FR-20)')
  check(after.every(m2 => m2.owner === 'desktop'), 'only the resize itself is reported, never a phone owner after the exit')

  // phoneFit turned off with owners: everything goes back.
  await claim(w, ws, 'r6', 'p2', 40, 20)
  w.manager.applyConfig({ enabled: true, port: 4600, phoneFit: false })
  await tick(); await tick()
  check(w.manager.fit.ownerOf('p2') === 'desktop', 'switching phone-fit off gives every pane back')
}

async function testServerOffAndReload() {
  const w = world()
  const { ws } = await pair(w)
  ws.msg({ type: 'sub', paneId: 'p1' })
  await claim(w, ws, 's1', 'p1', 50, 40)
  // Renderer reload: the next snapshot re-dispatches the owner (FR-23).
  const n = w.ofKind('fitPane').length
  w.manager.pushState(snapshot)
  check(w.ofKind('fitPane').length === n, 'an ordinary snapshot re-sends nothing')
  w.manager.onRendererNavigate()
  w.manager.pushState(snapshot)
  await tick()
  const again = w.ofKind('fitPane').slice(n)
  check(again.length === 1 && again[0].action.paneId === 'p1' && again[0].action.cols === 50 && again[0].action.workspaceId === 'w1', 'after a renderer reload the first snapshot re-sends the current fitPane')
  // Server off: restore first.
  w.manager.applyConfig({ enabled: false, port: 4600, phoneFit: true })
  await tick(); await tick()
  check(w.ofKind('releaseFit').some(c => c.action.paneId === 'p1') && w.manager.fit.ownerOf('p1') === 'desktop' && w.sizes.get('p1').cols === 120, 'turning the server off restores every pane')
  // Quit only stops timers (nothing to restore into).
  const q = world()
  const qp = await pair(q)
  qp.ws.msg({ type: 'sub', paneId: 'p1' })
  await claim(q, qp.ws, 'q1', 'p1', 50, 40)
  const c = q.commands.length
  q.manager.shutdown('quit')
  await tick()
  check(q.commands.length === c && q.manager.fit.ownerOf('p1') === 'desktop', 'app quit disposes the owners without dispatching')
}

async function testRendererLost() {
  // The executor never answers (renderer reloading): the owner stays.
  const w = world()
  const { ws } = await pair(w)
  ws.msg({ type: 'sub', paneId: 'p1' })
  w.setReply(() => null)
  ws.msg(fitPane('t1', 'p1', 50, 40))
  await tick()
  w.advance(w.api.FIT_COALESCE_MS)
  w.advance(10 * 1000)
  await tick(); await tick()
  check(ack(ws, 't1')?.error === 'timeout' && w.manager.fit.ownerOf('p1') === 'phone', 'an executor timeout keeps the owner for the reload re-send')
}

// --- Replay after a resize (E3-FR-22) ---------------------------------------------------

function loadPty() {
  let current = null
  const codePty = buildSync({ entryPoints: [path.join(root, 'src/main/pty/PtyManager.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(codePty, {
    module: mod, exports: mod.exports, console: { ...console, warn() {} }, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    require: id => id === 'node-pty' ? { spawn: (...a) => current.impl(...a) } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
  })
  function manager(engine) {
    const procs = []
    current = {
      impl: (_shell, _args, o) => {
        const dataCbs = [], exitCbs = []
        const proc = {
          cols: o.cols, rows: o.rows, resizes: 0,
          onData: cb => dataCbs.push(cb), onExit: cb => exitCbs.push(cb),
          write() {}, resize: (c, r) => { proc.cols = c; proc.rows = r; proc.resizes++ }, pause() {}, resume() {},
          kill: () => exitCbs.forEach(cb => cb({ exitCode: 1 })),
          emit: d => dataCbs.forEach(cb => cb(d)),
        }
        procs.push(proc)
        return proc
      },
    }
    const pm = new mod.exports.PtyManager(() => ({ isDestroyed: () => false, send() {} }))
    pm.setEngine(engine)
    return { pm, procs }
  }
  return { mod: mod.exports, manager }
}

const flushPty = () => new Promise(r => setTimeout(r, 30))

async function testReplay() {
  const { mod, manager } = loadPty()
  const CLEAR = mod.REPLAY_CLEAR
  check(CLEAR === '\x1b[2J\x1b[3J\x1b[H', 'the cut replay starts with clear screen + scrollback + home')
  // Ring fallback (mirror off).
  {
    const { pm, procs } = manager({ snapshotMode: 'off' })
    pm.spawn({ paneId: 'p', cols: 120, rows: 40 })
    const events = []
    pm.addSink({ id: 's', onSpawn() {}, onExit() {}, onData: (_i, _p, d) => events.push('data:' + d), onResize: (_i, paneId, c, r) => events.push(`resize:${paneId}:${c}x${r}`) })
    procs[0].emit('\x1b[?2004h' + 'w'.repeat(120) + '\r\nold prompt> ')
    await flushPty()
    const whole = pm.getReplay('p').replay
    check(whole.includes('old prompt> ') && !whole.startsWith(CLEAR), 'without a resize the replay is the whole ring, as before')
    events.length = 0
    procs[0].emit('pending-before-resize')
    pm.resize(pm.ptyIdForPane('p'), 50, 20)
    check(events.join('|') === 'data:pending-before-resize|resize:p:50x20', 'output emitted at the old size reaches sinks before onResize (FR-12 order)')
    pm.resize(pm.ptyIdForPane('p'), 50, 20)
    check(events.filter(e => e.startsWith('resize')).length === 1 && procs[0].resizes === 2, 'the same size again is not an effective resize (no second onResize)')
    procs[0].emit('\x1b[H\x1b[2Knew frame at 50')
    await flushPty()
    const rep = pm.getReplay('p')
    check(rep.cols === 50 && rep.rows === 20, 'the replay carries the current size')
    check(rep.replay.includes(CLEAR) && rep.replay.endsWith('new frame at 50'), 'a ring spanning a resize replays clear + only the bytes after it')
    check(!rep.replay.includes('old prompt> ') && !rep.replay.includes('pending-before-resize'), 'nothing laid out for the old width survives')
    check(rep.replay.startsWith('\x1b[?2004h'), 'the active modes still come first')
    check(pm.reattach('p').replay === rep.replay, 'the desktop reattach gets the same coherent replay')
    check(JSON.stringify(pm.sizeOf('p')) === '{"cols":50,"rows":20}' && pm.sizeOf('nope') === null, 'sizeOf reads the live size')
    pm.killAll()
  }
  // Lazy mirror created after a resize: seeded from the cut ring, not the raw one.
  {
    const { pm, procs } = manager({ snapshotMode: 'lazy', persist: false })
    pm.spawn({ paneId: 'q', cols: 120, rows: 30 })
    procs[0].emit('L'.repeat(120) + '\r\nbefore-resize')
    await flushPty()
    pm.resize(pm.ptyIdForPane('q'), 40, 12)
    procs[0].emit('\x1b[Hafter-resize')
    await flushPty()
    const text = pm.getReplay('q').replay
    check(!text.includes('before-resize') && text.includes('after-resize'), 'a lazy mirror born after a resize is seeded with only the post-resize output')
    pm.killAll()
  }
  // Headless mirror (E6/E5): the replay is laid out at the current width.
  {
    const { pm, procs } = manager({ snapshotMode: 'auto', persist: true })
    pm.spawn({ paneId: 'h', cols: 120, rows: 20 })
    procs[0].emit('A'.repeat(100) + '\r\nshell> ')
    await flushPty()
    pm.resize(pm.ptyIdForPane('h'), 50, 20)
    const rep = pm.getReplay('h')
    check(rep.cols === 50 && !rep.replay.startsWith(CLEAR), 'with the mirror the replay is its snapshot at the new size (no cut)')
    const { Terminal } = require('@xterm/headless')
    const term = new Terminal({ cols: 50, rows: 20, allowProposedApi: true })
    await new Promise(r => term.write(rep.replay, r))
    const lines = []
    for (let i = 0; i < 6; i++) lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '')
    check(lines[0] === 'A'.repeat(50) && lines[1] === 'A'.repeat(50) && lines.some(l => l.startsWith('shell> ')), 'painted into a 50-column terminal, the 100 A wrap into two full rows and the prompt survives: no garbage')
    term.dispose()
    pm.killAll()
  }
}

// --- Renderer side: fitStore + executor ------------------------------------------------

async function testRenderer() {
  const alias = { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }
  const resizes = [], releases = []
  const snApi = {
    platform: 'win32',
    pty: { resize: r => resizes.push(r), kill: async () => {}, killPanes: async () => 0 },
    remote: { fitRelease: r => releases.push(r) },
    config: { save() {} },
  }
  const code2 = buildSync({ stdin: { contents: `export * from './fitStore'; export { runFitPane, runReleaseFit } from './remoteCommands'; export { useAppStore } from './store'; export { registerPty } from './ptyRegistry'`, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code2, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, Promise, window: { snApi }, document: { hasFocus: () => false } })
  const r = mod.exports

  // Geometry (FR-17): a 50x40 phone grid in a quarter of a 1280x820 window.
  const cell = { w: 8.4, h: 17 }
  const geo = r.fitGeometry({ cols: 50, rows: 40 }, { w: 620, h: 370 }, cell, 14)
  check(geo.fontSize >= r.FIT_MIN_FONT && geo.fontSize < 14 && geo.fits, 'a 50x40 grid in a 4-pane cell fits with a smaller font of 6px or more')
  check(geo.baseline.cols === Math.floor(620 / 8.4) && geo.baseline.rows === Math.floor(370 / 17), 'the baseline is the grid the pane would have at its normal font')
  const tiny = r.fitGeometry({ cols: 200, rows: 100 }, { w: 300, h: 200 }, cell, 14)
  check(tiny.fontSize === 6 && !tiny.fits, 'a grid that does not fit at 6px stays at 6px and reports the scroll fallback')
  const roomy = r.fitGeometry({ cols: 40, rows: 10 }, { w: 1200, h: 800 }, cell, 14)
  check(roomy.fontSize === 14 && roomy.fits, 'the font never grows above the pane\'s own size')

  // Executor (remoteCommands).
  r.useAppStore.setState({ workspaces: [{ id: 'w1', name: 'One', cwd: '', panes: [{ id: 'p1', type: 'shell', title: 'A', color: '', icon: '' }] }] })
  let res = r.runFitPane({ kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 50, rows: 40 }, { ptyId: 'pty-main' })
  check(res.ok && JSON.stringify(r.useFitStore.getState().owners.p1) === '{"cols":50,"rows":40,"chat":false}', 'fitPane stores the owner in fitStore')
  check(resizes.at(-1).ptyId === 'pty-main' && resizes.at(-1).cols === 50, 'and resizes the pty by main\'s ptyId even when the pane is not mounted')
  res = r.runFitPane({ kind: 'fitPane', workspaceId: 'w2', paneId: 'p1', cols: 50, rows: 40 }, {})
  check(!res.ok && res.error === 'not_found', 'a pane outside the workspace is not_found')
  r.runFitPane({ kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 50, rows: 40 }, { chat: true })
  check(r.fitOwnerOf('p1').chat === true, 'the chat flag reaches the strip state')
  r.runReleaseFit('p1', { ptyId: 'pty-main', baseline: { cols: 120, rows: 40 } })
  check(!r.fitOwnerOf('p1') && resizes.at(-1).cols === 120, 'releaseFit clears the owner and applies main\'s baseline when the renderer never measured')
  r.setFitBaseline('p1', { cols: 132, rows: 44 })
  r.runFitPane({ kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 50, rows: 40 }, {})
  r.registerPty('p1', 'pty-local')
  r.runReleaseFit('p1', { baseline: { cols: 120, rows: 40 } })
  check(resizes.at(-1).ptyId === 'pty-local' && resizes.at(-1).cols === 132 && resizes.at(-1).rows === 44, 'the latest desktop baseline wins over main\'s pre-phone size (FR-18)')

  // Desktop release (FR-19): main first, then the local owner; throttled per pane.
  r.runFitPane({ kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 50, rows: 40 }, {})
  check(r.releaseFitFromDesktop('p1', 1000) && releases.length === 1 && releases[0].paneId === 'p1' && !r.fitOwnerOf('p1'), 'a real key releases: remote:fitRelease {paneId} and the local owner clears')
  check(!r.releaseFitFromDesktop('p1', 1100) && releases.length === 1, 'with no owner left, further keys send nothing')
  r.runFitPane({ kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 50, rows: 40 }, {})
  r.releaseFitFromDesktop('p1', 1200)
  check(releases.length === 2 && !r.fitOwnerOf('p1'), 'a phone that claimed the pane again inside 500ms is still released in main (no desync)')
  r.runFitPane({ kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 50, rows: 40 }, {})
  r.releaseFitFromDesktop('p1', 1600)
  check(releases.length === 3, 'every new owner gets its own release')
  r.runFitPane({ kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 50, rows: 40 }, {})
  r.releaseAllFitsFromDesktop()
  check(releases.at(-1).all === true && Object.keys(r.useFitStore.getState().owners).length === 0, 'Restore all sends {all:true} and clears every owner')
}

async function main() {
  code = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: entry },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'],
    plugins: [stubs], alias: { '@shared': path.join(root, 'src/shared') },
  }).then(r => r.outputFiles[0].text)
  await testSchemas()
  await testAccepted()
  await testRefused()
  await testTwoDevices()
  await testGraceHeldRestore()
  await testChatPresence()
  await testReleasePaths()
  await testServerOffAndReload()
  await testRendererLost()
  await testReplay()
  await testRenderer()
  fs.rmSync(dataDir, { recursive: true, force: true })
  console.log(`PASS: ${checks} phone-fit checks (schemas, owner, coalesce, grace, held, auto restore, chat, two devices, release paths, server off, reload, replay with and without the mirror, renderer executor)`)
}

main().catch(error => { console.error(error); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(1) })
