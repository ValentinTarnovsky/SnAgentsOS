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
// E3-FR-03 gates the v3.0 message types by name before the schema owners add
// them. This stand-in schema accepts any well-formed frame, so the same
// SessionManager can be driven with historyReq / fitPane today.
const v3Schema = {
  name: 'v3-schema',
  setup(build) {
    build.onResolve({ filter: /remote-protocol-schemas$/ }, () => ({ path: 'schemas', namespace: 'stub' }))
    build.onLoad({ filter: /^schemas$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `
export function parseRemoteClientMsg(raw: unknown): any {
  if (typeof raw !== 'string') return null
  try {
    const m = JSON.parse(raw)
    if (typeof m?.v !== 'number' || typeof m?.type !== 'string') return null
    if (m.type === 'ctl' && (typeof m.id !== 'string' || typeof m.action?.kind !== 'string')) return null
    return m
  } catch { return null }
}` }))
  },
}
let code = ''
let codeV3 = ''
const entry = `
export { RemoteManager, toRemoteStatus, PANE_STATUS_COALESCE_MS } from './src/main/remote/RemoteManager'
export { isRateLimitedMsg, RATE_LIMITED_MSG_TYPES, RATE_LIMITED_CTL_KINDS } from './src/main/remote/SessionManager'
export { TokenBucket, REMOTE_RATE_PER_SEC, REMOTE_RATE_BURST } from './src/main/remote/TokenBucket'
`
const bundleWith = plugins => build({
  stdin: { resolveDir: root, loader: 'ts', contents: entry },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'],
  plugins, alias: { '@shared': path.join(root, 'src/shared') },
}).then(r => r.outputFiles[0].text)
const bundle = async () => {
  code = await bundleWith([stubs])
  codeV3 = await bundleWith([stubs, v3Schema])
}

function world(opts = {}) {
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
  vm.runInNewContext(opts.code || code, ctx)
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
  // A fake renderer: commands relayed by main land here (E2 executor tests).
  const commands = []
  const webContents = { isDestroyed: () => false, setBackgroundThrottling() {}, send: (ch, cmd) => { if (ch === 'remote:controlCmd') commands.push(cmd) } }
  const manager = new api.RemoteManager(pty, () => webContents, '2.0.0', () => statuses, () => 'MI-PC', ...(opts.endpoints ? [opts.endpoints] : []))
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
  const socket = (host = '100.64.0.9') => { const ws = new FakeSocket(); ctx.__server.handlers.onSocket(ws, '100.64.0.9', host); return ws }
  return { api, manager, statuses, writes, commands, socket, advance, get clock() { return clock } }
}

/** Pair a phone through the pairing route; returns its socket and credentials. */
async function pair(w, host) {
  await new Promise(resolve => setImmediate(resolve)) // the stub server's start() settles
  const payload = await w.manager.pairingBegin()
  const ws = w.socket(host)
  ws.msg({ type: 'hello', clientNonce: 'aa'.repeat(32) })
  ws.msg({ type: 'pair', code: payload.code, deviceName: 'Phone' })
  const requestId = w.manager.getUiState().pendingPairing.requestId
  w.manager.pairingResolve(requestId, true)
  const paired = ws.of('paired')[0]
  return { ws, deviceId: paired.deviceId, secret: paired.secret }
}

/** Reconnect with stored credentials through the challenge route. */
function reconnect(w, deviceId, secret, host) {
  const ws = w.socket(host)
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

/** E2 Home (R22-14): hostName on every frame, promptFallback in the ack, the new ctl schemas. */
async function testHome() {
  const w = world()
  w.manager.pushState(snapshot)
  const { ws } = await pair(w)
  check(ws.of('authOk')[0].state.hostName === 'MI-PC', 'authOk carries hostName from main')
  w.manager.pushState({ ...snapshot, workspaces: snapshot.workspaces.map(x => ({ ...x, name: x.name + '!' })) })
  const pushed = ws.of('state').at(-1).state
  check(pushed.hostName === 'MI-PC' && pushed.workspaces[0].name === 'One!', 'a later push (a rename) still carries hostName (overlayRunning, not only authOk)')

  ws.msg({ type: 'ctl', id: 'c1', action: { kind: 'createPane', workspaceId: 'w1', presetId: 'claude', prompt: 'explica "x" y $HOME' } })
  const relayed = w.commands.at(-1)
  check(relayed && relayed.action.kind === 'createPane' && relayed.action.prompt === 'explica "x" y $HOME', 'createPane.prompt reaches the renderer executor')
  w.manager.onControlResult({ id: relayed.id, ok: true, paneId: 'p9', promptFallback: true })
  await new Promise(resolve => setImmediate(resolve))
  const ack = ws.of('ctlAck').find(a => a.id === 'c1')
  check(ack && ack.ok && ack.paneId === 'p9' && ack.promptFallback === true, 'handleCtl copies promptFallback into the ctlAck')
  ws.msg({ type: 'ctl', id: 'c2', action: { kind: 'mountWorkspace', workspaceId: 'w2' } })
  w.manager.onControlResult({ id: w.commands.at(-1).id, ok: true, info: 2 })
  await new Promise(resolve => setImmediate(resolve))
  const ack2 = ws.of('ctlAck').find(a => a.id === 'c2')
  check(ack2 && ack2.info === 2 && !('promptFallback' in ack2), 'without the flag the ack carries no promptFallback')

  const { parseRemoteClientMsg } = (() => {
    const mod = { exports: {} }
    const src = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/shared/remote-protocol-schemas.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
    vm.runInNewContext(src, { module: mod, exports: mod.exports, require, URL })
    return mod.exports
  })()
  const frame = action => parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'ctl', id: 'x', action }))
  check(frame({ kind: 'createPane', workspaceId: 'w', presetId: 'p', prompt: 'a'.repeat(16384) }), 'createPane accepts a 16384-char prompt')
  check(!frame({ kind: 'createPane', workspaceId: 'w', prompt: 'a'.repeat(16385) }), 'and rejects 16385')
  check(frame({ kind: 'mountWorkspace', workspaceId: 'w' }) && !frame({ kind: 'mountWorkspace' }), 'mountWorkspace needs a workspaceId')
  check(frame({ kind: 'revealPane', paneId: 'p' }) && !frame({ kind: 'revealPane', paneId: '' }), 'revealPane needs a paneId')
  check(frame({ kind: 'openUrl', url: 'http://localhost:5173/x' }) && frame({ kind: 'openUrl', url: 'https://example.com' }) && frame({ kind: 'openUrl', url: 'mailto:a@b.c' }), 'openUrl accepts http, https and mailto')
  check(frame({ kind: 'openUrl', url: 'file:///C:/Windows/System32/calc.exe' }) && !frame({ kind: 'openUrl', url: '' }), 'the schema only bounds openUrl: the scheme is the executor call (denied_url ack)')
  // A refused scheme is never a malformed frame: it reaches the executor, which acks denied_url.
  const errsBefore = ws.of('err').length
  ws.msg({ type: 'ctl', id: 'c3', action: { kind: 'openUrl', url: 'ms-settings:network' } })
  const relayedUrl = w.commands.at(-1)
  check(relayedUrl && relayedUrl.action.kind === 'openUrl' && ws.of('err').length === errsBefore, 'a link with a refused scheme is relayed (no bad_msg strike)')
  w.manager.onControlResult({ id: relayedUrl.id, ok: false, error: 'denied_url' })
  await new Promise(resolve => setImmediate(resolve))
  const ack3 = ws.of('ctlAck').find(a => a.id === 'c3')
  check(ack3 && !ack3.ok && ack3.error === 'denied_url', 'and the phone gets the denied_url ack')
  check(!frame({ kind: 'openUrl', url: 'https://x.co/' + 'a'.repeat(2048) }), 'openUrl rejects more than 2048 characters')
}

/** ntfy support (R22-18): lastHost and deepLinkBase (E2-FR-42), visibility and isPaneViewed (E2-FR-52). */
async function testNotify() {
  fs.rmSync(path.join(dataDir, 'remote-devices.json'), { force: true })
  const LAN = { ip: '192.168.1.20', kind: 'lan', url: '' }, TS = { ip: '100.64.0.9', kind: 'tailscale', url: '' }
  let endpoints = [LAN, TS]
  const w = world({ endpoints: () => endpoints })
  w.manager.pushState(snapshot)
  await new Promise(resolve => setImmediate(resolve))
  check(w.manager.deepLinkBase() === 'http://100.64.0.9:4600', 'no phone yet: the deep link uses the Tailscale endpoint')
  endpoints = [LAN]
  check(w.manager.deepLinkBase() === 'http://192.168.1.20:4600', 'without Tailscale: the first LAN endpoint')
  endpoints = [LAN, TS]
  const { ws, deviceId, secret } = await pair(w, '192.168.1.20')
  check(ws.of('paired').length === 1 && w.manager.deepLinkBase() === 'http://192.168.1.20:4600', 'the host a phone authenticated through wins over Tailscale')
  endpoints = [TS]
  check(w.manager.deepLinkBase() === 'http://100.64.0.9:4600', 'a lastHost this PC no longer has is skipped')
  endpoints = [{ ip: '127.0.0.1', kind: 'lan', url: '' }, LAN]
  const loop = reconnect(w, deviceId, secret, '127.0.0.1')
  check(loop.of('authOk').length === 1 && w.manager.deepLinkBase() === 'http://192.168.1.20:4600', 'a loopback login never becomes lastHost')

  // E2-FR-52: subscribed + visible + fresh.
  check(!w.manager.isPaneViewed('p1'), 'an authed phone that is not subscribed does not watch p1')
  check(w.manager.subscribedPaneIds().size === 0, 'E5-FR-25: no phone subscription yet')
  ws.msg({ type: 'sub', paneId: 'p1' })
  check(w.manager.subscribedPaneIds().has('p1') && !w.manager.subscribedPaneIds().has('p2'), 'E5-FR-25: a sub (visible or not) keeps p1 out of hibernation')
  check(!w.manager.isPaneViewed('p1'), 'subscribed but no visibility yet: not watching')
  ws.msg({ type: 'visibility', visible: true })
  check(w.manager.isPaneViewed('p1') && !w.manager.isPaneViewed('p2'), 'subscribed and visible: watching p1 only')
  check(ws.of('err').length === 0, 'visibility is a valid post-auth frame')
  w.advance(31000)
  check(!w.manager.isPaneViewed('p1'), 'silent for more than 30s: no longer counts as watching')
  ws.msg({ type: 'ping', t: 1 })
  check(w.manager.isPaneViewed('p1'), 'a ping refreshes it')
  ws.msg({ type: 'visibility', visible: false })
  check(!w.manager.isPaneViewed('p1'), 'hidden page: not watching')
  const stranger = w.socket()
  stranger.msg({ type: 'visibility', visible: true })
  check(stranger.of('err').at(-1).code === 'unauthorized', 'visibility before auth is refused')
  const { parseRemoteClientMsg } = (() => {
    const mod = { exports: {} }
    const src = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/shared/remote-protocol-schemas.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
    vm.runInNewContext(src, { module: mod, exports: mod.exports, require, URL })
    return mod.exports
  })()
  check(parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'visibility', visible: true })) && !parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'visibility', visible: 'yes' })), 'the visibility schema takes a boolean only')
  w.manager.applyConfig({ enabled: false, port: 4600 })
  check(w.manager.deepLinkBase() === null && !w.manager.isPaneViewed('p1'), 'server off: no deep link and nobody watching')
  check(w.manager.subscribedPaneIds().size === 0, 'server off: no subscriptions hold hibernation back')
}

/**
 * E6-FR-24 (R22-20): ctl agentResume. The zod schema, the relay through main
 * (stale ack, the agentEnded marker kept by the overlay) and the renderer
 * executor in the esbuild + vm harness of test-mobile-home.cjs: membership
 * like restartPane, the same text as the desktop chip, the first action of
 * any device wins and the rest ack stale, and the snapshot marker.
 */
async function testAgentResume() {
  const { parseRemoteClientMsg } = (() => {
    const mod = { exports: {} }
    const src = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/shared/remote-protocol-schemas.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
    vm.runInNewContext(src, { module: mod, exports: mod.exports, require, URL })
    return mod.exports
  })()
  const frame = action => parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'ctl', id: 'x', action }))
  const base = { kind: 'agentResume', workspaceId: 'w1', paneId: 'p1' }
  check(frame({ ...base, mode: 'resume' }).action.mode === 'resume' && frame({ ...base, mode: 'new' }).action.mode === 'new', 'agentResume accepts mode resume and new')
  check(!frame({ ...base, mode: 'fresh' }) && !frame(base) && !frame({ ...base, mode: 'resume', paneId: '' }) && !frame({ kind: 'agentResume', paneId: 'p1', mode: 'new' }), 'agentResume rejects another mode, a missing mode, an empty paneId or a missing workspaceId')

  // Main relays it as-is and copies the executor's stale error into the ack.
  const w = world()
  const first = snapshot.workspaces[0]
  const ended = { ...snapshot, workspaces: [{ ...first, panes: first.panes.map((p, j) => j === 0 ? { ...p, agentEnded: { canResume: true } } : p) }, ...snapshot.workspaces.slice(1)] }
  w.manager.pushState(ended)
  const { ws } = await pair(w)
  check(ws.of('authOk')[0].state.workspaces[0].panes[0].agentEnded.canResume === true, 'the overlay keeps the renderer\'s agentEnded marker')
  ws.msg({ type: 'ctl', id: 'a1', action: { kind: 'agentResume', workspaceId: first.id, paneId: first.panes[0].id, mode: 'resume' } })
  const relayed = w.commands.at(-1)
  check(relayed && relayed.action.kind === 'agentResume' && relayed.action.mode === 'resume', 'agentResume reaches the renderer executor')
  w.manager.onControlResult({ id: relayed.id, ok: false, error: 'stale' })
  await new Promise(resolve => setImmediate(resolve))
  const ack = ws.of('ctlAck').find(a => a.id === 'a1')
  check(ack && !ack.ok && ack.error === 'stale', 'the phone gets ctlAck stale')

  // --- Renderer executor ---
  const timers = []
  const fakeSet = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  const flush = () => { while (timers.length) timers.shift().fn() }
  const ptyWrites = [], results = [], states = []
  const snApi = {
    platform: 'win32',
    config: { save() {} },
    pty: { killPanes: async () => 0, submit: async () => ({ ok: true }), write: (req) => ptyWrites.push(req) },
    window: { reveal() {} },
    system: { openExternal() {} },
    remote: { onCommand: (cb) => { snApi._cmd = cb; return () => {} }, commandResult: (res) => results.push(res), pushState: (st) => states.push(st) },
    clipboard: { writeText() {} },
  }
  const rcode = require('esbuild').buildSync({ stdin: { contents: `
    export { useAppStore } from './store'
    export { initRemoteCommands } from './remoteCommands'
    export { startRemoteSnapshotSync } from './remoteSnapshot'
    export { registerPty, unregisterPty } from './ptyRegistry'
    export { registerAgentEndShell, runAgentEnd } from './agentEndRun'
    export { agentEndCommands, AGENT_END_READY_MS } from './agentEnd'
  `, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const rmod = { exports: {} }
  vm.runInNewContext(rcode, { module: rmod, exports: rmod.exports, require, console, process, crypto: globalThis.crypto, setTimeout: fakeSet, clearTimeout() {}, URL, window: { snApi }, document: { hasFocus: () => true, querySelector: () => null }, requestAnimationFrame: () => 0, cancelAnimationFrame() {} })
  const r = rmod.exports
  const S = r.useAppStore
  const UUID = '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab'
  const claude = { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: ['--model', 'opus'], color: '#d97757', icon: 'claude' }
  S.getState().hydrate({
    version: 12,
    workspaces: [
      { id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [{ id: 'p1', type: 'claude', presetId: 'preset-claude', title: 'Claude', color: '#fff', icon: 'claude' }, { id: 'p2', type: 'shell', title: 'Sh', color: '#fff', icon: 'terminal' }] },
      { id: 'w2', name: 'Dos', cwd: 'C:/b', panes: [{ id: 'q1', type: 'claude', presetId: 'preset-claude', title: 'Claude B', color: '#fff', icon: 'claude' }] },
    ],
    presets: [claude],
    connections: [],
    settings: { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false, language: 'es' },
    activeWorkspaceId: 'w1',
  })
  r.initRemoteCommands()
  r.registerPty('p1', 'pty-1')
  r.registerPty('p2', 'pty-2')
  r.registerPty('q1', 'pty-q')
  const offer = (paneId, extra = {}) => S.getState().setAgentEnded({ paneId, ptyId: 'pty', provider: 'claude', sessionId: UUID, reason: 'prompt_input_exit', cwd: 'C:\\repo', at: Date.now() - 5000, ...extra })
  let n = 0
  const ctl = (action) => { snApi._cmd({ id: 'r' + (++n), action }); return results.at(-1) }
  const resumeText = `Set-Location -LiteralPath 'C:\\repo'; claude --model opus --resume ${UUID}\r`

  offer('p1')
  let res = ctl({ kind: 'agentResume', workspaceId: 'w2', paneId: 'p1', mode: 'resume' })
  check(!res.ok && res.error === 'not_found' && ptyWrites.length === 0 && S.getState().agentEnded.p1, 'a paneId of another workspace is rejected and keeps the offer')
  res = ctl({ kind: 'agentResume', workspaceId: 'gone', paneId: 'p1', mode: 'resume' })
  check(!res.ok && res.error === 'not_found', 'an unknown workspace is not_found')

  // The desktop chip's text for the same pane, through the shell its terminal registered.
  const off = r.registerAgentEndShell('p1', () => 'powershell')
  const desk = r.agentEndCommands({ evt: { sessionId: UUID, cwd: 'C:\\repo' }, shellKind: 'powershell', preset: claude, initialCommand: 'claude --model opus' })
  res = ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'resume' })
  check(res.ok && ptyWrites.length === 1 && ptyWrites[0].ptyId === 'pty-1' && ptyWrites[0].data === resumeText && ptyWrites[0].data === desk.resume + '\r', 'Resume types the desktop chip\'s cd prefix + --resume command with a bare CR')
  check(S.getState().agentEnded.p1 === undefined, 'the first action clears the offer')
  res = ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'new' })
  check(!res.ok && res.error === 'stale' && ptyWrites.length === 1, 'a second action acks stale and types nothing')

  // Two devices at once: both ctl frames reach the executor back to back.
  offer('p1')
  snApi._cmd({ id: 'dev-a', action: { kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'resume' } })
  snApi._cmd({ id: 'dev-b', action: { kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'resume' } })
  const a = results.find(x => x.id === 'dev-a'), b = results.find(x => x.id === 'dev-b')
  check(a.ok && !b.ok && b.error === 'stale' && ptyWrites.length === 2, 'two devices tapping Resume together produce one command; the second gets stale')

  offer('p1')
  res = ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'new' })
  check(res.ok && ptyWrites.at(-1).data === desk.fresh + '\r' && desk.fresh === 'claude --model opus', 'New types the pane\'s Claude command, like the desktop chip')

  // The desktop chip goes through the same runner (its first click wins too).
  offer('p1')
  check(r.runAgentEnd('p1', 'resume').ok && ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'resume' }).error === 'stale', 'after a desktop click the phone gets stale')
  off()

  // A pane not mounted on the desktop: the configured default shell (PowerShell on win32).
  offer('q1')
  res = ctl({ kind: 'agentResume', workspaceId: 'w2', paneId: 'q1', mode: 'resume' })
  check(res.ok && ptyWrites.at(-1).ptyId === 'pty-q' && ptyWrites.at(-1).data === resumeText, 'without a mounted terminal the cd prefix follows the default shell')

  offer('p1', { sessionId: 'bad id;' })
  res = ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'resume' })
  check(!res.ok && res.error === 'no_resume' && S.getState().agentEnded.p1, 'an unsafe session id refuses Resume (no_resume) and keeps the offer for New')
  S.getState().clearAgentEnded('p1')

  offer('p2')
  const writesBefore = ptyWrites.length
  S.getState().updateSettings({ terminalAgentEndChip: false })
  res = ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p2', mode: 'new' })
  check(!res.ok && res.error === 'stale' && ptyWrites.length === writesBefore, 'with the chip setting off there is no offer to take (stale)')
  S.getState().updateSettings({ terminalAgentEndChip: true })
  S.getState().clearAgentEnded('p2')

  // No live pty: nothing can take the offer, so it is dropped (no lingering strip).
  offer('p2')
  r.unregisterPty('p2')
  res = ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p2', mode: 'new' })
  check(!res.ok && res.error === 'not_running' && ptyWrites.length === writesBefore && S.getState().agentEnded.p2 === undefined, 'without a live pty the ack is not_running and the offer is dropped')
  r.registerPty('p2', 'pty-2')

  // Too early: the write waits until the shell had AGENT_END_READY_MS to print its prompt.
  offer('p1', { at: Date.now() })
  timers.length = 0
  res = ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'new' })
  const early = timers.find(t => t.ms > 0 && t.ms <= r.AGENT_END_READY_MS)
  check(res.ok && ptyWrites.length === writesBefore && early && S.getState().agentEnded.p1 === undefined, 'an action right after the exit acks ok, clears the offer and defers the write')
  flush()
  check(ptyWrites.length === writesBefore + 1 && ptyWrites.at(-1).data === 'claude --model opus\r', 'and types it once the ready delay elapses')

  // Snapshot marker.
  const stop = r.startRemoteSnapshotSync()
  const paneOf = (st, id) => st.workspaces.flatMap(x => x.panes).find(p => p.id === id)
  check(!('agentEnded' in paneOf(states.at(-1), 'p1')), 'no marker without an offer')
  offer('p1')
  flush()
  check(JSON.stringify(paneOf(states.at(-1), 'p1').agentEnded) === '{"canResume":true}' && !('agentEnded' in paneOf(states.at(-1), 'p2')), 'an offer pushes agentEnded { canResume: true } for that pane only')
  check(!JSON.stringify(states.at(-1)).includes(UUID), 'the session id never travels to the phone')
  S.getState().updateSettings({ terminalAgentEndChip: false })
  flush()
  check(!('agentEnded' in paneOf(states.at(-1), 'p1')), 'the setting off removes the marker')
  S.getState().updateSettings({ terminalAgentEndChip: true })
  flush()
  ctl({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'resume' })
  flush()
  check(!('agentEnded' in paneOf(states.at(-1), 'p1')), 'taking the offer removes the marker from the next push')
  offer('p1', { sessionId: 'x;y' })
  flush()
  check(paneOf(states.at(-1), 'p1').agentEnded.canResume === false, 'an unsafe session id marks canResume false (only New)')
  stop()
}

// --- E3 transversal (R30-02): httpToken, rate limit, pending map, safePaste ---

async function testHttpToken() {
  const w = world()
  w.manager.pushState(snapshot)
  const { ws, deviceId, secret } = await pair(w)
  const viaPair = ws.of('authOk')[0]
  const resolve = token => w.manager.resolveHttpToken(token)
  check(/^[0-9a-f]{64}$/.test(viaPair.httpToken), 'authOk (pair route) carries a 64-hex httpToken (E3-FR-01)')
  check(viaPair.v === 1 && !('pushKey' in viaPair), 'PROTOCOL_VERSION stays 1 and there is no pushKey without https')
  check(resolve(viaPair.httpToken)?.deviceId === deviceId, 'resolveHttpToken maps the token to its device')
  const ws2 = reconnect(w, deviceId, secret)
  const second = ws2.of('authOk')[0].httpToken
  check(/^[0-9a-f]{64}$/.test(second) && second !== viaPair.httpToken, 'authOk (reconnect route) carries a token of its own per session')
  check(resolve(second)?.deviceId === deviceId, 'both sessions resolve while open')
  check(resolve('') === null && resolve(second.toUpperCase()) === null && resolve('ab'.repeat(32)) === null && resolve(42) === null && resolve(second + '0') === null, 'malformed, unknown or non-string tokens resolve to null')
  ws.close(1000)
  check(resolve(viaPair.httpToken) === null && resolve(second)?.deviceId === deviceId, 'closing a socket kills only its own token')
  await w.manager.revokeDevice(deviceId)
  check(resolve(second) === null, 'revoking the device kills its token at once')

  const w2 = world()
  w2.manager.pushState(snapshot)
  const p2 = await pair(w2)
  const token = p2.ws.of('authOk')[0].httpToken
  check(w2.manager.resolveHttpToken(token)?.deviceId === p2.deviceId, 'a fresh server resolves its token')
  w2.manager.applyConfig({ enabled: false, port: 4600 })
  check(w2.manager.resolveHttpToken(token) === null, 'stopping the server drops every token')
}

function testRateUnits(api) {
  check(api.REMOTE_RATE_PER_SEC === 20 && api.REMOTE_RATE_BURST === 40, 'token bucket of 20/s with a burst of 40 (E3-FR-03)')
  let now = 0
  const bucket = new api.TokenBucket(20, 40, () => now)
  let passed = 0
  for (let i = 0; i < 100; i++) if (bucket.take()) passed++
  check(passed === 40, 'a burst passes 40 frames and refuses the rest')
  now = 500
  passed = 0
  for (let i = 0; i < 20; i++) if (bucket.take()) passed++
  check(passed === 10, 'half a second refills 10 tokens')
  now = 100000
  passed = 0
  for (let i = 0; i < 100; i++) if (bucket.take()) passed++
  check(passed === 40, 'a long pause refills up to the burst, never beyond')
  now = 50
  check(!bucket.take(), 'a clock going backwards refills nothing')

  const limited = m => api.isRateLimitedMsg(m)
  check(['chatSub', 'chatUnsub', 'chatMore', 'historyReq', 'gitReq'].every(type => limited({ type })), 'the v3.0 message types are limited')
  check(['fitPane', 'releaseFit', 'sendReviewNotes'].every(kind => limited({ type: 'ctl', action: { kind } })), 'the v3.0 ctl kinds are limited')
  check(limited({ type: 'ctl', action: { kind: 'createPane', workspaceId: 'w1', resume: { provider: 'claude', sessionId: 'x' } } }), 'createPane with resume is limited')
  check(!limited({ type: 'ctl', action: { kind: 'createPane', workspaceId: 'w1' } }), 'a plain createPane is not')
  check(['sub', 'unsub', 'input', 'ping', 'visibility', 'hello', 'auth'].every(type => !limited({ type })), 'the v1 messages are never limited')
  check(!limited({ type: 'ctl', action: { kind: 'revealPane' } }) && !limited({ type: 'ctl' }) && !limited({ type: 'ctl', action: 'x' }), 'v2 ctl kinds and malformed actions are not limited')
}

async function testRateLegacyTraffic() {
  // Real schema: nothing that parses today is rate limited.
  const w = world()
  w.manager.pushState(snapshot)
  const { ws } = await pair(w)
  for (let i = 0; i < 60; i++) ws.msg({ type: 'ctl', id: 'r' + i, action: { kind: 'revealPane', paneId: 'p1' } })
  for (let i = 0; i < 60; i++) ws.msg({ type: 'input', paneId: 'p1', data: 'k' })
  check(w.commands.length === 60 && !ws.of('ctlAck').some(a => a.error === 'rate'), '60 legacy ctl in a row all reach the renderer')
  check(w.writes.length === 60 && ws.closed === null, '60 input frames in a row all reach the pty')
}

async function testRateLimit() {
  const w = world({ code: codeV3 })
  w.manager.pushState(snapshot)
  const { ws } = await pair(w)
  const since = ws.inbox.length
  for (let i = 0; i < 41; i++) ws.msg({ type: 'historyReq', id: 'h' + i })
  // Every historyReq let through gets its (empty, no index here) historyRes
  // on the next turn: one reply per frame past the gate (R30-06).
  await new Promise(resolve => setImmediate(resolve))
  const replies = ws.inbox.slice(since)
  check(replies.length === 40 && replies.every(m => m.type === 'historyRes') && !replies.some(m => m.id === 'h40'), 'a burst of 41 historyReq: the 41st gets no answer at all')
  check(!ws.inbox.some(m => m.type === 'err' && m.code === 'rate'), 'a limited message is dropped in silence (no err rate)')
  check(ws.closed === null, 'the socket stays open')
  const relayed = w.commands.length
  ws.msg({ type: 'ctl', id: 'f1', action: { kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 40, rows: 20 } })
  const ack = ws.of('ctlAck').find(a => a.id === 'f1')
  check(ack && ack.ok === false && ack.error === 'rate', 'fitPane past the limit answers ctlAck {ok:false, error:rate}')
  check(w.commands.length === relayed, 'a refused ctl never reaches the renderer')
  ws.msg({ type: 'ctl', id: 'cp', action: { kind: 'createPane', workspaceId: 'w1', resume: { provider: 'claude', sessionId: 's' } } })
  check(ws.of('ctlAck').find(a => a.id === 'cp')?.error === 'rate', 'createPane with resume shares the same bucket')
  ws.msg({ type: 'ctl', id: 'l1', action: { kind: 'revealPane', paneId: 'p1' } })
  ws.msg({ type: 'input', paneId: 'p1', data: 'still' })
  check(w.commands.length === relayed + 1 && w.writes.includes('still'), 'legacy ctl and input still flow with the bucket empty')
  // No strikes were counted: two malformed frames leave the socket open (the limit is 3).
  ws.handlers.message('nope')
  ws.handlers.message('{}')
  check(ws.closed === null, 'rate drops cost no strike (two bad frames later the socket is still open)')
  w.advance(1000)
  const mark = ws.inbox.length
  for (let i = 0; i < 30; i++) ws.msg({ type: 'gitReq', id: 'g' + i, workspaceId: 'w1', op: 'status' })
  // Past the bucket each gitReq gets its gitRes (R30-09a), some after a tick.
  await new Promise(resolve => setImmediate(resolve))
  check(ws.inbox.length - mark === 20, 'one second later 20 more pass (20/s refill)')
  // The bucket is per session: a second phone starts full.
  const other = await pair(w)
  const start = other.ws.inbox.length
  for (let i = 0; i < 45; i++) other.ws.msg({ type: 'chatMore', paneId: 'p1', before: 'c' })
  check(other.ws.inbox.length - start === 40, 'another session has its own full bucket')
}

/** Bundle one pure mobile module and run it in a sandbox with the given globals. */
async function loadMobile(file, globals = {}) {
  const r = await build({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') } })
  const mod = { exports: {} }
  vm.runInNewContext(r.outputFiles[0].text, { module: mod, exports: mod.exports, console, setTimeout, clearTimeout, ...globals })
  return mod.exports
}

async function testPendingMap() {
  let seq = 0
  const timers = new Map()
  const fake = { setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id) }
  const fire = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn() } }
  const p = await loadMobile('src/mobile/src/lib/pending.ts')
  check(p.PENDING_TIMEOUT_MS === 10000, 'pending requests wait 10s (E3-FR-04)')
  const map = new p.PendingMap(p.PENDING_TIMEOUT_MS, fake)
  const a = map.begin('id-a')
  check(!!a && [...timers.values()][0].ms === 10000, 'begin arms a 10s timer')
  check(map.resolve('id-a', { n: 1 }) && timers.size === 0, 'the answer clears the timer')
  check((await a).ok === true && (await a).value.n === 1, 'the request settles with its answer')
  check(map.resolve('id-a', {}) === false, 'a late answer finds nothing waiting')
  const b = map.begin('pane-1')
  check(map.begin('pane-1') === null, 'one request at a time per key (chatSub/chatMore per pane)')
  fire()
  const out = await b
  check(!out.ok && out.error === 'timeout' && p.isNoReply(out.error), 'no answer in 10s fails as timeout: "The PC did not answer"')
  check(!!map.begin('pane-1'), 'after the timeout the same pane can ask again (retry)')
  check(map.fail('pane-1', 'rate') && p.isNoReply('rate') && !p.isNoReply('offline') && !p.isNoReply('not_found'), 'ctlAck rate also shows "did not answer"; other errors do not')
  check(map.size === 0, 'nothing is left waiting')
}

async function testSafePaste() {
  const sp = await loadMobile('src/mobile/src/lib/safePaste.ts')
  const ESC = '\x1b'
  const START = ESC + '[200~', END = ESC + '[201~'
  check(sp.PASTE_START === START && sp.PASTE_END === END && sp.PASTE_FRAME_MAX <= 8192, 'paste markers and a frame size under the 8192 schema limit')
  const dirty = 'a\x00b\x07c\x08d\x0be\x0cf\x1bg\x1fh\x7fi\u0080j\u0085k\u009bl\tm\nn\ro'
  check(sp.sanitizePasteText(dirty) === 'abcdefghijkl\tm\nn\ro', 'sanitizePasteText drops ESC, C0, DEL and C1 and keeps tab, \\n and \\r')
  check(sp.sanitizePasteText('ñandú \u{1F600} 日本') === 'ñandú \u{1F600} 日本', 'printable unicode is untouched')
  check(sp.buildPasteFrames('line 1\nline 2\r\nline 3', true).join('|') === START + 'line 1\rline 2\rline 3' + END, 'a 3-line prompt is ONE bracketed frame with \\r line breaks')
  check(sp.buildPasteFrames('a\nb', false).join('|') === 'a\rb', 'without bracketed paste there are no markers')
  const evil = sp.buildPasteFrames('x' + END + 'rm -rf /' + ESC + '[0m', true).join('')
  check(evil === START + 'x[201~rm -rf /[0m' + END && evil.split(ESC).length === 3, 'a text with \\x1b[201~ arrives without its ESC: only the real markers remain')
  const body = 'y'.repeat(20000)
  const frames = sp.buildPasteFrames(body, true)
  check(frames.length === 3 && frames.join('') === START + body + END, '20000 chars go in 3 frames inside ONE bracketed paste')
  check(frames.every(f => f.length <= sp.PASTE_FRAME_MAX) && frames[0].startsWith(START) && frames[2].endsWith(END), 'every frame fits and the markers open the first and close the last')
  {
    // The closing marker would straddle the cut at 8000: the cut moves before its ESC.
    const f = sp.buildPasteFrames('z'.repeat(7992), true)
    check(f.length === 2 && f[0] === START + 'z'.repeat(7992) && f[1] === END, 'a cut never splits the closing sequence')
    const g = sp.splitPasteFrames(START + 'q'.repeat(20), 10)
    check(g[0] === START.slice(0, 6) + 'qqqq' && g.join('') === START + 'q'.repeat(20), 'the opening sequence stays whole even with tiny frames')
  }
  {
    const f = sp.buildPasteFrames('a'.repeat(7993) + '\u{1F600}b', true)
    check(f[0].length === 7999 && f[1].startsWith('\u{1F600}'), 'a surrogate pair at the cut moves whole to the next frame')
  }
  check(sp.pasteBracketed(false, { state: 'idle', stateSince: 0, provider: 'claude' }) === true && sp.pasteBracketed(undefined, { state: 'idle', stateSince: 0, provider: 'codex' }) === true, 'claude and codex panes always paste bracketed')
  check(sp.pasteBracketed(true, null) === true && sp.pasteBracketed(false, null) === false && sp.pasteBracketed(undefined, null) === undefined, 'otherwise the last xterm mode decides (unknown stays unknown)')
  check(sp.buildPasteFrames('\x1b\x00\x07', true).length === 0, 'nothing left after sanitizing yields no frame')

  const run = async (text, opts, { live = () => true, open = true, onSleep } = {}) => {
    const sent = [], sleeps = []
    const io = { sendInput: d => { if (!open) return false; sent.push(d); return true }, sleep: async ms => { sleeps.push(ms); onSleep?.() } }
    const ok = await sp.safePaste(text, { signal: new AbortController().signal, live, ...opts }, io)
    return { ok, sent, sleeps }
  }
  let r = await run('hola\nchau', { bracketed: true, enter: true })
  check(r.ok && r.sent.length === 2 && r.sent[0] === START + 'hola\rchau' + END && r.sent[1] === '\r' && r.sleeps[0] === 50, 'enter:true sends \\r after the closing marker, 50ms later')
  r = await run('hola', { bracketed: true, enter: false })
  check(r.ok && r.sent.length === 1, 'enter:false sends no Enter')
  let alive = true
  r = await run('hola', { bracketed: true, enter: true }, { live: () => alive, onSleep: () => { alive = false } })
  check(r.ok && r.sent.length === 1, 'a pane change during the gap drops the Enter')
  r = await run('hola', { bracketed: true, enter: true }, { open: false })
  check(!r.ok && r.sent.length === 0, 'a closed socket sends nothing and keeps the text')
  r = await run('\x07', { bracketed: true, enter: true })
  check(!r.ok && r.sent.length === 0, 'an all-control text sends nothing, not even Enter')
  r = await run('y'.repeat(20000), { bracketed: true, enter: true })
  check(r.ok && r.sent.length === 4 && r.sent[3] === '\r' && r.sent.slice(0, 3).join('') === START + 'y'.repeat(20000) + END, 'a 20000-char Send is 3 paste frames then Enter')
}

async function main() {
  await bundle()
  const w = world()
  testToRemoteStatus(w.api)
  await testOverlay()
  await testBroadcast()
  await testDataPlane()
  await testHome()
  await testNotify()
  await testAgentResume()
  await testHttpToken()
  testRateUnits(w.api)
  await testRateLegacyTraffic()
  await testRateLimit()
  await testPendingMap()
  await testSafePaste()
  fs.rmSync(dataDir, { recursive: true, force: true })
  console.log(`PASS: ${checks} remote overlay, paneStatus, lastHost, visibility, agentResume, httpToken, rate limit, pending and safePaste checks`)
}

main().catch(error => { console.error(error); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(1) })
