// Remote overlay + paneStatus transport (E1-FR-03) through the real
// RemoteManager and SessionManager, with a fake socket, a fake PtyManager, a
// fake StatusManager snapshot and a fake clock. The HTTP server and dataDir()
// are stubbed, so nothing listens and the registry lands in a temp folder.
const { build } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-remote-'))
const stubs = {
  name: 'stubs',
  setup(build) {
    build.onResolve({ filter: /\/RemoteServer$/ }, () => ({ path: 'RemoteServer', namespace: 'stub' }))
    build.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
    build.onLoad({ filter: /^RemoteServer$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `
export class RemoteServer {
  constructor(port: number, handlers: any) { (globalThis as any).__server = { port, handlers } }
  start() { return Promise.resolve() }
  close() {}
}` }))
    build.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(dataDir)} }` }))
  },
}
let code = ''
const bundle = () => build({
  stdin: { resolveDir: root, loader: 'ts', contents: `
export { RemoteManager, toRemoteStatus, PANE_STATUS_COALESCE_MS } from './src/main/remote/RemoteManager'
` },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'],
  plugins: [stubs], alias: { '@shared': path.join(root, 'src/shared') },
}).then(r => { code = r.outputFiles[0].text })

function world() {
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

  const writes = []
  const statuses = []
  const pty = {
    addSink() {}, removeSink() {}, setRunningChangeListener() {}, setForcedFast() {},
    runningPaneIds: () => ['p1', 'p2'],
    exitedPaneCodes: () => new Map([['p3', 3]]),
    getReplay: paneId => ({ ptyId: 'pty-' + paneId, replay: 'R:' + paneId, cols: 80, rows: 24 }),
    ptyIdForPane: paneId => 'pty-' + paneId,
    write: (_id, data) => writes.push(data),
  }
  const manager = new api.RemoteManager(pty, () => null, '2.0.0', () => statuses)
  manager.applyConfig({ enabled: true, port: 4600 })

  class FakeSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.inbox = []; this.handlers = {}; this.closed = null }
    on(ev, fn) { this.handlers[ev] = fn }
    send(data) { this.inbox.push(JSON.parse(data)) }
    close(code) { this.closed = code; this.readyState = 3; this.handlers.close && this.handlers.close() }
    terminate() { this.close(1006) }
    msg(obj) { this.handlers.message(JSON.stringify({ v: 1, ...obj })) }
    of(type) { return this.inbox.filter(m => m.type === type) }
  }
  const socket = () => { const ws = new FakeSocket(); ctx.__server.handlers.onSocket(ws, '100.64.0.9'); return ws }
  return { api, manager, statuses, writes, socket, advance, get clock() { return clock } }
}

/** Pair a phone through the pairing route; returns its socket and credentials. */
async function pair(w) {
  await new Promise(resolve => setImmediate(resolve)) // the stub server's start() settles
  const payload = await w.manager.pairingBegin()
  const ws = w.socket()
  ws.msg({ type: 'hello', clientNonce: 'aa'.repeat(32) })
  ws.msg({ type: 'pair', code: payload.code, deviceName: 'Phone' })
  const requestId = w.manager.getUiState().pendingPairing.requestId
  w.manager.pairingResolve(requestId, true)
  const paired = ws.of('paired')[0]
  return { ws, deviceId: paired.deviceId, secret: paired.secret }
}

/** Reconnect with stored credentials through the challenge route. */
function reconnect(w, deviceId, secret) {
  const ws = w.socket()
  const clientNonce = 'bb'.repeat(32)
  ws.msg({ type: 'hello', deviceId, clientNonce })
  const challenge = ws.of('challenge')[0]
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(challenge.nonce).digest('hex')
  ws.msg({ type: 'auth', deviceId, hmac })
  return ws
}

const snapshot = {
  workspaces: [
    { id: 'w1', name: 'One', layoutOrder: ['p1'], panes: [{ id: 'p1', title: 'A', type: 'claude', color: '', icon: '', running: false }] },
    { id: 'w2', name: 'Two', layoutOrder: ['p2', 'p3'], panes: [
      { id: 'p2', title: 'B', type: 'claude', color: '', icon: '', running: false },
      { id: 'p3', title: 'C', type: 'shell', color: '', icon: '', running: true, status: { state: 'done', stateSince: 1 } },
    ] },
  ],
  activeWorkspaceId: 'w1', themeTokens: {}, language: 'en', fontFamily: '', fontSize: 14,
}
const DESKTOP_ONLY = ['sessionId', 'cwd', 'detail', 'topic', 'firstPrompt', 'cacheSince', 'notify', 'delivery', 'paneId', 'updatedAt']
const evt = (paneId, state, rest = {}) => ({ paneId, state, precise: true, notify: false, provider: 'claude', pendingCount: 0, stateSince: 1000, updatedAt: 1234, ...rest })

function testToRemoteStatus(api) {
  const rich = evt('p1', 'action', {
    precise: false, reason: 'permission', pendingCount: 1, lastMessage: 'hi', activity: 'Bash',
    pending: [{ id: 't1', kind: 'permission', summary: 'npm test' }],
    sessionId: '11111111-2222-3333-4444-555555555555', cwd: 'C:\\repo', detail: { kind: 'tool', text: 'x' },
    topic: 'tp', firstPrompt: 'fp', cacheSince: 5, notify: true, delivery: 'native',
  })
  const out = api.toRemoteStatus(rich)
  check(DESKTOP_ONLY.every(k => !(k in out)), 'toRemoteStatus never copies sessionId, cwd or desktop-only fields')
  check(out.state === 'action' && out.precise === false && out.reason === 'permission' && out.pendingCount === 1 && out.lastMessage === 'hi' && out.activity === 'Bash' && out.pending.length === 1 && out.stateSince === 1000, 'toRemoteStatus copies the contract fields')
  check(!('precise' in api.toRemoteStatus(evt('p1', 'idle'))), 'precise is omitted when true (absent = true)')
  check(api.toRemoteStatus(evt('p1', null)) === null, 'a cleared status maps to null')
}

async function testOverlay() {
  const w = world()
  w.statuses.push(evt('p1', 'working', { activity: 'Edit', sessionId: '11111111-2222-3333-4444-555555555555', cwd: 'C:\\r' }), evt('p2', 'action', { reason: 'question', precise: false }))
  w.manager.pushState(snapshot)
  const { ws, deviceId, secret } = await pair(w)
  const viaPair = ws.of('authOk')[0]
  check(!!viaPair, 'the pairing route delivers authOk')
  const panes = s => Object.fromEntries(s.workspaces.flatMap(x => x.panes).map(p => [p.id, p]))
  let p = panes(viaPair.state)
  check(p.p1.status.state === 'working' && p.p1.status.activity === 'Edit', 'authOk (pair route) carries panes[].status from main')
  check(p.p2.status.state === 'action' && p.p2.status.precise === false, 'authOk carries precise:false for approximate panes')
  check(!p.p3.status, 'a stale renderer status is replaced by main (no status = none)')
  check(p.p1.running === true && p.p3.running === false, 'running stays overlaid from the pty table')
  check(p.p3.exitCode === 3 && p.p1.exitCode === undefined, 'exitCode (E6-FR-38) is overlaid next to status for exited panes only')
  check(!JSON.stringify(viaPair.state).includes('sessionId') && !JSON.stringify(viaPair.state).includes('cwd'), 'authOk never carries sessionId or cwd')
  const ws2 = reconnect(w, deviceId, secret)
  p = panes(ws2.of('authOk')[0].state)
  check(p.p1.status.state === 'working' && p.p2.status.reason === 'question', 'authOk (reconnect route) carries panes[].status')
  w.statuses[0] = evt('p1', 'done')
  w.manager.pushState(snapshot)
  const state = ws2.of('state').at(-1)
  check(panes(state.state).p1.status.state === 'done', 'every state frame is overlaid by main')
}

async function testBroadcast() {
  const w = world()
  w.manager.pushState(snapshot)
  const { ws } = await pair(w)
  const stranger = w.socket()
  stranger.msg({ type: 'hello', clientNonce: 'cc'.repeat(32) })
  const frames = () => ws.of('paneStatus')
  w.manager.pushPaneStatus(evt('p1', 'action', { reason: 'permission' }))
  check(frames().length === 1 && frames()[0].status.state === 'action', 'working -> action goes out at once (0 ms)')
  check(stranger.of('paneStatus').length === 0, 'an unauthenticated session receives no paneStatus')
  for (let i = 0; i < 10; i++) { w.manager.pushPaneStatus(evt('p1', 'action', { reason: 'permission' })); w.advance(100) }
  check(frames().length === 1, 'ten unchanged emits in 1s produce no extra paneStatus')

  ws.inbox.length = 0
  w.manager.pushPaneStatus(evt('p2', 'working', { activity: 'Read' }))
  w.advance(10); w.manager.pushPaneStatus(evt('p2', 'working', { activity: 'Grep' }))
  w.advance(10); w.manager.pushPaneStatus(evt('p2', 'working', { activity: 'Edit' }))
  check(frames().length === 0, 'working updates are held inside the 100 ms window')
  w.advance(80)
  check(frames().length === 1 && frames()[0].status.activity === 'Edit', 'the coalesced frame carries the latest activity after 100 ms')
  ws.inbox.length = 0
  for (let i = 0; i < 20; i++) { w.manager.pushPaneStatus(evt('p2', 'working', { activity: 'T' + i })); w.advance(50) }
  w.advance(200)
  check(frames().length >= 9 && frames().length <= 11 && frames().at(-1).status.activity === 'T19', 'a 1s burst of 20 tool changes costs about 10 frames and ends on the latest')
  ws.inbox.length = 0
  w.manager.pushPaneStatus(evt('p2', 'working', { activity: 'Z' }))
  w.advance(20)
  w.manager.pushPaneStatus(evt('p2', 'error'))
  check(frames().length === 1 && frames()[0].status.state === 'error', 'error cancels a held update and goes out at once')
  w.advance(200)
  check(frames().length === 1, 'the cancelled held update never arrives late')
  w.manager.pushPaneStatus(evt('p2', null))
  check(frames().at(-1).status === null, 'a cleared pane sends status:null at once')
  w.manager.pushPaneStatus(evt('p2', null))
  check(frames().filter(f => f.status === null).length === 1, 'a repeated null is deduplicated')
  w.manager.pushPaneStatus(evt('p3', null))
  check(frames().at(-1).paneId === 'p3' && frames().at(-1).status === null, 'null reaches a pane the phone only knew from a snapshot')
  ws.inbox.length = 0
  w.manager.pushPaneStatus(evt('p1', 'done', { sessionId: '11111111-2222-3333-4444-555555555555', cwd: 'C:\\x' }))
  check(frames().length === 1 && !('sessionId' in frames()[0].status) && !('cwd' in frames()[0].status), 'paneStatus never carries sessionId or cwd')
  w.manager.applyConfig({ enabled: false, port: 4600 })
  w.manager.applyConfig({ enabled: true, port: 4600 })
  const { ws: fresh, deviceId, secret } = await pair(w)
  w.manager.pushPaneStatus(evt('p1', 'done', { sessionId: '11111111-2222-3333-4444-555555555555' }))
  check(fresh.of('paneStatus').length === 1, 'a restarted server forgets the dedupe memory')

  // A state frame that overtakes a held update becomes the dedupe baseline.
  const last = (sock, paneId) => sock.of('paneStatus').filter(f => f.paneId === paneId).at(-1)
  const set = activity => { w.statuses.length = 0; w.statuses.push(evt('p2', 'working', { activity })); w.manager.pushPaneStatus(w.statuses[0]) }
  set('A'); w.advance(100)
  check(last(fresh, 'p2').status.activity === 'A', 'baseline A was sent')
  set('B')
  w.manager.pushState(snapshot)
  const viaState = fresh.of('state').at(-1).state.workspaces[1].panes[0]
  check(viaState.status.activity === 'B', 'the state frame carries the held B')
  const before = fresh.of('paneStatus').length
  set('A'); w.advance(100)
  check(fresh.of('paneStatus').length === before + 1 && last(fresh, 'p2').status.activity === 'A', 'going back to A after a state frame showed B still sends A')

  // A phone authenticating mid-window learns a status the others were never sent.
  set('B')
  const late = reconnect(w, deviceId, secret)
  check(late.of('authOk')[0].state.workspaces[1].panes[0].status.activity === 'B', 'authOk carries the held B')
  set('A'); w.advance(100)
  check(last(late, 'p2')?.status.activity === 'A', 'going back to A after an authOk showed B still reaches the new phone')
}

async function testDataPlane() {
  const w = world()
  w.manager.pushState(snapshot)
  const { ws } = await pair(w)
  ws.msg({ type: 'sub', paneId: 'p1' })
  check(ws.of('replay').length === 1, 'sub answers with a replay')
  ws.msg({ type: 'unsub', paneId: 'p1' }); ws.msg({ type: 'sub', paneId: 'p1' })
  check(ws.of('replay').length === 2 && ws.of('replay')[1].data === 'R:p1', 'unsub + sub produces a fresh replay')
  ws.msg({ type: 'input', paneId: 'p1', data: 'x'.repeat(8000) })
  check(w.writes.length === 1 && w.writes[0].length === 8000, 'an 8000-char input is valid and written')
  ws.msg({ type: 'input', paneId: 'p1', data: 'x'.repeat(8193) })
  check(w.writes.length === 1 && ws.of('err').at(-1).code === 'bad_msg', 'an 8193-char input is rejected as bad_msg')
  ws.msg({ type: 'input', paneId: 'p1', data: 'x'.repeat(8193) })
  check(ws.closed === null, 'two strikes keep the socket open')
  ws.msg({ type: 'input', paneId: 'p1', data: 'x'.repeat(8193) })
  check(ws.closed === 1008, 'the third oversized input is the third strike and closes the socket')
}

async function main() {
  await bundle()
  const w = world()
  testToRemoteStatus(w.api)
  await testOverlay()
  await testBroadcast()
  await testDataPlane()
  fs.rmSync(dataDir, { recursive: true, force: true })
  console.log(`PASS: ${checks} remote overlay and paneStatus checks`)
}

main().catch(error => { console.error(error); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(1) })
