// Secure mode, service worker and Web Push (E3-FR-42..50, R30-07).
//  - SecureMode with an execFile stub (status/serve parsing, idempotent apply,
//    port change, foreign handler and Funnel untouched, raw CLI errors, the
//    disable that only removes our handler) and a check that no call ever
//    names `funnel`.
//  - PushService: endpoint allow-list, keys file, subscribe 404/401/400/413/200,
//    caps, notify (visible and unpaired devices skipped, TTL/urgency, 404/410
//    drop, off = nothing sent and subscriptions kept), revoke, payload words.
//  - The real RemoteServer on a loopback port: MagicDNS Host only from loopback
//    while on, https Origin, X-Forwarded-For for the IP, CSP wss:/worker-src,
//    the push route.
//  - RemoteManager wiring with stubbed server and services: authOk pushKey and
//    secureUrl, tailscaleHttps endpoint first, setSecure, revoke, notifyPush
//    with isDeviceVisible, deepLinkBase, the notice router gate.
//  - Phone: pushSupport, base64url keys, postSubscription, the Paste key flow,
//    wake lock rule, the secure card, SW message filter, SW build fill and the
//    service worker itself in a fake worker scope.
const { build, buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-secure-'))
const electronStub = { app: { isPackaged: false, getPath: () => tmp } }
const DNS = 'pc.tail1234.ts.net'
const P256 = 'B' + 'A'.repeat(86) // 87 base64url chars, like a real p256dh
const AUTH = 'a'.repeat(22)
const subBody = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc') => ({ endpoint, expirationTime: null, keys: { p256dh: P256, auth: AUTH } })

function run(code, extra = {}) {
  const mod = { exports: {} }
  const ctx = {
    module: mod, exports: mod.exports, console, process, Buffer, URL, URLSearchParams, queueMicrotask, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, AbortController,
    __dirname: path.join(tmp, 'main'), require: id => id === 'electron' ? electronStub : require(id),
    ...extra,
  }
  ctx.globalThis = ctx
  vm.runInNewContext(code, ctx)
  run.lastCtx = ctx
  return mod.exports
}
/** The vm context of the main bundle: its stub RemoteServer leaves __srv there. */
let mainCtx = null
const srv = () => mainCtx.__srv

// --- SecureMode ------------------------------------------------------------------

function tailscaleStub(opts = {}) {
  const calls = []
  const status = opts.status ?? { BackendState: 'Running', Self: { DNSName: 'PC.tail1234.ts.net.' }, CertDomains: [DNS] }
  let serve = opts.serve ?? {}
  const exec = async (file, args, timeout) => {
    calls.push({ file, args, timeout })
    if (opts.enoent) return { code: null, stdout: '', stderr: '', error: 'ENOENT' }
    const cmd = args.join(' ')
    if (cmd === 'status --json') return { code: opts.statusCode ?? 0, stdout: JSON.stringify(status), stderr: '' }
    if (cmd === 'serve status --json') return { code: 0, stdout: serve === null ? '' : JSON.stringify(serve), stderr: '' }
    if (args[0] === 'serve' && args.includes('--bg')) {
      if (opts.applyFails) return { code: 1, stdout: '', stderr: opts.applyFails }
      const target = args[args.length - 1]
      serve = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: target } } } } }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'serve --https=443 off') { serve = {}; return { code: 0, stdout: '', stderr: '' } }
    return { code: 1, stdout: '', stderr: 'unexpected ' + cmd }
  }
  return { exec, calls, get serve() { return serve } }
}
const ours = port => ({ TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } })

async function testSecureMode(api) {
  const all = []
  const mk = opts => { const st = tailscaleStub(opts); all.push(st); return { st, sm: new api.SecureMode({ exec: st.exec, binary: () => 'tailscale.exe' }) } }

  {
    const { st, sm } = mk({})
    const res = await sm.enable(4517)
    check(res.ok && res.dnsName === DNS, 'free 443: enable returns the MagicDNS name lowercased, no trailing dot')
    check(st.calls.some(c => c.args.join(' ') === 'serve --bg --https=443 http://127.0.0.1:4517'), 'free 443: applies serve --bg --https=443 to our loopback port')
    check(st.calls.every(c => c.timeout === api.SECURE_CLI_TIMEOUT_MS && api.SECURE_CLI_TIMEOUT_MS === 5000 && c.file === 'tailscale.exe'), 'every CLI call has the 5 s timeout and the resolved binary')
    const before = st.calls.length
    const again = await sm.enable(4517)
    check(again.ok && st.calls.slice(before).every(c => !c.args.includes('--bg')), 'already ours: enable is idempotent (nothing re-applied)')
  }
  {
    const { st, sm } = mk({ status: { BackendState: 'Running', Self: { DNSName: `${DNS}.` }, CertDomains: [] } })
    const res = await sm.enable(4517)
    check(!res.ok && res.error === 'no_https' && st.calls.length === 1, 'no CertDomains: no_https and serve is never touched')
  }
  {
    const { sm } = mk({ status: { BackendState: 'Running', Self: { DNSName: '' } } })
    check((await sm.enable(4517)).error === 'no_https', 'MagicDNS off (no DNSName): no_https')
  }
  {
    const { sm } = mk({ status: { BackendState: 'NeedsLogin', Self: {} } })
    check((await sm.enable(4517)).error === 'not_running', 'logged out tailscale: not_running')
  }
  {
    const { sm } = mk({ enoent: true })
    check((await sm.enable(4517)).error === 'not_installed', 'no tailscale binary (ENOENT): not_installed')
  }
  {
    const { st, sm } = mk({ serve: { ...ours(4517), AllowFunnel: { [`${DNS}:443`]: true } } })
    const res = await sm.enable(4517)
    check(!res.ok && res.error === 'funnel' && !st.calls.some(c => c.args.includes('--bg') || c.args.includes('off')), 'AllowFunnel on 443: refused, nothing applied or removed')
  }
  {
    const { st, sm } = mk({ serve: ours(3000) })
    const res = await sm.enable(4517)
    check(!res.ok && res.error === 'port_busy' && /3000/.test(res.message) && !st.calls.some(c => c.args.includes('--bg')), 'a foreign proxy on 443: port_busy naming it, nothing applied')
  }
  {
    const { sm } = mk({ serve: { TCP: { 443: { TCPForward: '127.0.0.1:22' } } } })
    check((await sm.enable(4517)).error === 'port_busy', 'a TCP forward on 443: port_busy')
  }
  {
    const { sm } = mk({ serve: { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4517' }, '/x': { Path: 'C:\\x' } } } } } })
    check((await sm.enable(4517)).error === 'port_busy', 'our proxy plus another mount: port_busy (only a lone "/" is ours)')
  }
  {
    const { st, sm } = mk({ serve: ours(4517) })
    const res = await sm.enable(4600, 4517)
    const cmds = st.calls.map(c => c.args.join(' '))
    check(res.ok && cmds.indexOf('serve --https=443 off') < cmds.indexOf('serve --bg --https=443 http://127.0.0.1:4600') && cmds.includes('serve --https=443 off'), 'port change: our old handler goes, then the new port is applied')
  }
  {
    const { sm } = mk({ applyFails: 'serve config denied: run as admin\n' })
    const res = await sm.enable(4517)
    check(!res.ok && res.error === 'cli' && res.message === 'serve config denied: run as admin', 'a failing apply surfaces the raw stderr')
  }
  {
    const { sm } = mk({ serve: null })
    check((await sm.enable(4517)).ok, 'serve status with an empty body counts as free')
  }
  {
    const { st, sm } = mk({ serve: ours(4517) })
    await sm.disable(4517)
    check(st.calls.some(c => c.args.join(' ') === 'serve --https=443 off'), 'disable removes our handler')
    const { st: st2, sm: sm2 } = mk({ serve: ours(3000) })
    const r2 = await sm2.disable(4517)
    check(r2.ok && !st2.calls.some(c => c.args.includes('off')), 'disable leaves a foreign handler alone')
    const { st: st3, sm: sm3 } = mk({})
    await sm3.disable(4517)
    check(!st3.calls.some(c => c.args.includes('off')), 'disable with nothing served runs no off')
  }
  check(api.readServeStatus({}, DNS, [4517]).kind === 'free' && api.normalizeDnsName('A.B.ts.net.') === 'a.b.ts.net', 'pure helpers: empty serve status is free, names normalize')
  check(all.every(st => st.calls.every(c => !c.args.some(a => /funnel/i.test(a)))), 'no CLI call ever names funnel')
}

// --- PushService ------------------------------------------------------------------

function fakeReqRes({ headers = {}, body = '' } = {}) {
  const { PassThrough } = require('node:stream')
  const req = new PassThrough()
  req.headers = headers
  const res = { code: 0, body: '', headersSent: false, writeHead(c) { this.code = c; this.headersSent = true }, end(t) { this.body = t || ''; this.done = true } }
  setImmediate(() => { req.end(body) })
  return { req, res }
}
async function subscribe(push, ctx, headers, body) {
  const { req, res } = fakeReqRes({ headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  push.handleSubscribe(req, res, ctx)
  for (let i = 0; i < 50 && !res.done; i++) await tick(2)
  return res
}

async function testPushService(api) {
  const allow = api.isAllowedPushEndpoint
  check(allow('https://fcm.googleapis.com/fcm/send/x') && allow('https://web.push.apple.com/QW') && allow('https://updates.push.services.mozilla.com/wpush/v2/x') && allow('https://wns2-par02p.notify.windows.com/w/?token=x'), 'allow-list: FCM, Apple, Mozilla and WNS endpoints pass')
  check(!allow('http://fcm.googleapis.com/x') && !allow('https://evil.com/fcm.googleapis.com') && !allow('https://push.apple.com.evil.com/') && !allow('https://fcm.googleapis.com:8443/x') && !allow('https://u:p@fcm.googleapis.com/x') && !allow('https://127.0.0.1/x') && !allow('https://push.apple.com/'), 'allow-list: http, look-alike hosts, ports, credentials and bare suffixes fail')

  const file = path.join(tmp, 'push', 'push-keys.json')
  const sent = []
  let fail = null
  let keyGen = 0
  const push = new api.PushService({
    file: () => file,
    generateKeys: () => { keyGen++; return { publicKey: 'PUB' + keyGen, privateKey: 'PRIV' + keyGen } },
    send: async (sub, payload, opts) => { sent.push({ sub, payload: JSON.parse(payload), opts }); if (fail && fail(sub)) throw Object.assign(new Error('x'), { statusCode: fail(sub) }) },
  })
  const tokens = new Map([['a1'.repeat(32), 'dev-1'], ['b2'.repeat(32), 'dev-2']])
  const ctx = (enabled = true) => ({ enabled, resolveToken: t => (tokens.has(t) ? { deviceId: tokens.get(t) } : null) })
  const bearer = t => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' })

  check((await subscribe(push, ctx(true), bearer('a1'.repeat(32)), subBody())).code === 404, 'no VAPID key yet: 404')
  const pub = push.ensureKeys()
  check(pub === 'PUB1' && push.ensureKeys() === 'PUB1' && keyGen === 1, 'ensureKeys generates once and keeps the pair')
  check(JSON.parse(fs.readFileSync(file, 'utf8')).vapid.privateKey === 'PRIV1', 'the pair is saved in push-keys.json')
  check((await subscribe(push, ctx(false), bearer('a1'.repeat(32)), subBody())).code === 404, 'https off: POST /api/push/subscribe is a 404 (FR-46)')
  check((await subscribe(push, ctx(), {}, subBody())).code === 401 && (await subscribe(push, ctx(), bearer('c3'.repeat(32)), subBody())).code === 401, 'no or unknown Bearer: 401')
  check((await subscribe(push, ctx(), bearer('a1'.repeat(32)), '{nope')).code === 400, 'malformed JSON: 400')
  check((await subscribe(push, ctx(), bearer('a1'.repeat(32)), { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: AUTH } })).code === 400, 'not a PushSubscription: 400')
  check((await subscribe(push, ctx(), bearer('a1'.repeat(32)), subBody('https://attacker.example/push'))).code === 400, 'endpoint outside the allow-list: 400')
  check((await subscribe(push, ctx(), { ...bearer('a1'.repeat(32)), 'content-length': '5000' }, subBody())).code === 413, 'declared body over 4KB: 413')
  check((await subscribe(push, ctx(), bearer('a1'.repeat(32)), JSON.stringify({ ...subBody(), pad: 'x'.repeat(5000) }))).code === 413, 'streamed body over 4KB: 413')
  check(push.list().length === 0, 'nothing stored by the rejected requests')
  const ok = await subscribe(push, ctx(), bearer('a1'.repeat(32)), subBody())
  check(ok.code === 200 && push.list().length === 1 && push.list()[0].deviceId === 'dev-1', '200 stores the subscription under the token owner')
  await subscribe(push, ctx(), bearer('b2'.repeat(32)), subBody())
  check(push.list().length === 1 && push.list()[0].deviceId === 'dev-2', 'the same endpoint moves to the device that posts it')
  await subscribe(push, ctx(), bearer('a1'.repeat(32)), subBody('https://web.push.apple.com/one'))
  for (let i = 0; i < 6; i++) push.add('dev-3', subBody(`https://fcm.googleapis.com/fcm/send/many${i}`))
  check(push.list().filter(s => s.deviceId === 'dev-3').length === api.PUSH_SUBS_PER_DEVICE, 'per-device cap keeps the newest subscriptions')

  const msg = { title: 'Claude needs permission', body: 'api - Web', tag: 'p1', url: './#ws=w&pane=p1', urgent: true }
  const paired = new Set(['dev-1', 'dev-2', 'dev-3'])
  const visible = new Set(['dev-3'])
  const nctx = { enabled: true, isDeviceVisible: id => visible.has(id), isPaired: id => paired.has(id) }
  sent.length = 0
  let n = await push.notify(msg, nctx)
  check(n === 2 && sent.length === 2 && !sent.some(s => s.sub.endpoint.includes('many')), 'notify: a device with a visible session is skipped')
  check(sent.every(s => s.opts.TTL === 300 && s.opts.urgency === 'high' && s.opts.vapidDetails.publicKey === 'PUB1' && /^https:\/\//.test(s.opts.vapidDetails.subject)), 'TTL 300, urgency high for action, VAPID details from the file')
  check(sent.every(s => JSON.stringify(Object.keys(s.payload).sort()) === '["body","tag","title","url"]'), 'the payload is only title, body, tag and url')
  sent.length = 0
  await push.notify({ ...msg, urgent: false }, { ...nctx, isPaired: id => id === 'dev-1' })
  check(sent.length === 1 && sent[0].opts.urgency === 'normal', 'an unpaired device gets nothing; done/error go with normal urgency')
  sent.length = 0
  n = await push.notify(msg, { ...nctx, enabled: false })
  check(n === 0 && sent.length === 0 && push.list().length > 0, 'https off: nothing sent and the subscriptions stay (FR-46)')
  fail = sub => (sub.endpoint.includes('apple') ? 410 : sub.endpoint.includes('fcm/send/abc') ? 500 : 0)
  await push.notify(msg, nctx)
  check(!push.list().some(s => s.endpoint.includes('apple')) && push.list().some(s => s.endpoint.includes('fcm/send/abc')), 'a 410 drops that subscription, a 500 keeps it')
  fail = sub => (sub.endpoint.includes('fcm/send/abc') ? 404 : 0)
  await push.notify(msg, nctx)
  check(!push.list().some(s => s.endpoint.includes('fcm/send/abc')), 'a 404 drops it too (the phone unsubscribed)')
  push.removeDevice('dev-3')
  check(!push.list().some(s => s.deviceId === 'dev-3') && !JSON.parse(fs.readFileSync(file, 'utf8')).subscriptions.some(s => s.deviceId === 'dev-3'), 'removeDevice drops every subscription of a revoked device, on disk too')
  const reread = new api.PushService({ file: () => file, generateKeys: () => { throw new Error('must not regenerate') } })
  check(reread.publicKey() === 'PUB1', 'a fresh instance reads the saved key')
  fs.writeFileSync(path.join(tmp, 'push', 'junk.json'), '{not json')
  check(new api.PushService({ file: () => path.join(tmp, 'push', 'junk.json') }).publicKey() === null, 'a corrupt file reads as empty')

  // Payload words (FR-45).
  const config = l => ({ settings: { language: l }, workspaces: [{ id: 'w 1', name: 'Web', panes: [{ id: 'p&1', title: 'api', type: 'claude' }] }] })
  const b = api.buildPushMessage
  const a1 = b({ paneId: 'p&1', provider: 'claude', state: 'action', reason: 'permission' }, config('es'))
  check(a1.title === 'Claude necesita permiso' && a1.body === 'api - Web' && a1.tag === 'p&1' && a1.urgent === true, 'action: "Claude necesita permiso", "<console> - <workspace>", tag = pane')
  check(a1.url === './#ws=w%201&pane=p%261', 'the deep link is relative to the PWA scope and URI-encoded')
  check(b({ paneId: 'p&1', provider: 'claude', state: 'done' }, config('es')).title === 'Claude terminó' && b({ paneId: 'p&1', provider: 'codex', state: 'error' }, config('es')).title === 'Codex falló', 'done and error titles in Spanish')
  check(b({ paneId: 'p&1', provider: 'codex', state: 'action', reason: 'question' }, config('en')).title === 'Codex has a question', 'English title per reason')
  const unknown = b({ paneId: 'zz', provider: 'claude', state: 'done' }, config('en'))
  check(unknown.body === 'SnAgentsOS' && unknown.url === './' && !unknown.urgent, 'an unknown pane: product name, app root, normal urgency')
}

// --- RemoteServer (real, loopback) ---------------------------------------------------

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
function request(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.end(body)
    else req.end()
  })
}

async function testRemoteServer(api) {
  const port = await freePort()
  let secure = DNS
  const sockets = []
  const pushHits = []
  const server = new api.RemoteServer(port, {
    onSocket: (ws, ip, host) => { sockets.push({ ip, host }); ws.close() },
    onPushSubscribe: (req, res) => { pushHits.push(req.headers.origin); res.writeHead(200); res.end('{}') },
    secureHost: () => secure,
  })
  await server.start()
  try {
    const secureHead = { Host: DNS, Origin: `https://${DNS}`, 'Content-Type': 'application/json' }
    let r = await request(port, { headers: { Host: DNS } })
    check(r.status !== 400, 'the MagicDNS Host is accepted from loopback while the secure mode is on')
    check(/connect-src 'self' ws: wss:/.test(r.headers['content-security-policy']) && /worker-src 'self'/.test(r.headers['content-security-policy']), 'CSP adds wss: and worker-src')
    r = await request(port, { headers: { Host: 'other.tail1234.ts.net' } })
    check(r.status === 400, 'another ts.net name is rejected')
    r = await request(port, { method: 'POST', url: '/api/push/subscribe', headers: secureHead, body: '{}' })
    check(r.status === 200 && pushHits[0] === `https://${DNS}`, 'POST /api/push/subscribe reaches PushService with the https Origin')
    r = await request(port, { method: 'POST', url: '/api/push/subscribe', headers: { ...secureHead, Origin: `http://${DNS}` }, body: '{}' })
    check(r.status === 403, 'an http Origin on the https Host: 403')
    r = await request(port, { method: 'GET', url: '/api/push/subscribe', headers: secureHead })
    check(r.status === 404, 'GET on the push route: 404')
    r = await request(port, { method: 'POST', url: '/api/push/subscribe', headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }, body: '{}' })
    check(r.status === 200, 'the push route also answers on an IP Host with its http Origin (PushService decides)')
    const { WebSocket } = require('ws')
    const upgrade = headers => new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers, origin: headers.Origin })
      ws.on('close', () => resolve(true))
      ws.on('error', () => resolve(false))
    })
    await upgrade({ Host: DNS, Origin: `https://${DNS}`, 'X-Forwarded-For': '6.6.6.6, 100.101.1.2' })
    check(sockets.length === 1 && sockets[0].ip === '100.101.1.2' && sockets[0].host === DNS, 'WS through the proxy: IP from the last X-Forwarded-For entry, host = the MagicDNS name')
    await upgrade({ Host: DNS, Origin: `http://${DNS}` })
    check(sockets.length === 1, 'WS with the wrong Origin is refused')
    secure = null
    r = await request(port, { headers: { Host: DNS } })
    check(r.status === 400, 'secure mode off: the MagicDNS Host is rejected again')
    await upgrade({ Host: DNS, Origin: `https://${DNS}` })
    check(sockets.length === 1, 'secure mode off: no WS on the MagicDNS Host')
    check(api.forwardedIp('1.1.1.1, junk') === null && api.forwardedIp(['a', '9.9.9.9']) === '9.9.9.9', 'forwardedIp takes only a valid last entry')
  } finally {
    server.close()
  }
}

// --- RemoteManager wiring ------------------------------------------------------------

const managers = []
function world(api, opts = {}) {
  const pty = {
    addSink() {}, removeSink() {}, setRunningChangeListener() {}, setForcedFast() {},
    runningPaneIds: () => ['p1'], exitedPaneCodes: () => new Map(),
    getReplay: paneId => ({ ptyId: 'pty-' + paneId, replay: '', cols: 80, rows: 24 }),
    ptyIdForPane: paneId => 'pty-' + paneId, write() {}, sizeOf: () => ({ cols: 80, rows: 24 }),
  }
  const webContents = { isDestroyed: () => false, setBackgroundThrottling() {}, send() {} }
  const secureCalls = []
  const secure = {
    enable: async (port, prev) => { secureCalls.push(['enable', port, prev]); return opts.secureResult ?? { ok: true, dnsName: DNS } },
    disable: async port => { secureCalls.push(['disable', port]); return { ok: true, dnsName: DNS } },
  }
  const sent = []
  const push = new api.PushService({
    file: () => path.join(tmp, 'mgr-' + (opts.name || 'a'), 'push-keys.json'),
    generateKeys: () => ({ publicKey: 'VAPIDPUB', privateKey: 'VAPIDPRIV' }),
    send: async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }) },
  })
  const endpoints = (port, host) => [...(host ? [{ kind: 'tailscaleHttps', host, url: `https://${host}` }] : []), { ip: '100.101.1.2', kind: 'tailscale', url: `http://100.101.1.2:${port}` }]
  const manager = new api.RemoteManager(pty, () => webContents, '2.0.0', () => [], () => 'PC', endpoints, { secure, push })
  managers.push(manager)
  class FakeSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.inbox = []; this.handlers = {} }
    on(ev, fn) { this.handlers[ev] = fn }
    send(data) { this.inbox.push(JSON.parse(data)) }
    close() { this.readyState = 3; this.handlers.close && this.handlers.close() }
    terminate() { this.close() }
    msg(obj) { this.handlers.message(JSON.stringify({ v: 1, ...obj })) }
    of(type) { return this.inbox.filter(m => m.type === type) }
  }
  const socket = (host = '100.101.1.2') => { const ws = new FakeSocket(); srv().handlers.onSocket(ws, '100.101.1.2', host); return ws }
  return { manager, secureCalls, sent, push, socket }
}
async function pair(w, host) {
  await tick(5)
  const payload = await w.manager.pairingBegin()
  const ws = w.socket(host)
  ws.msg({ type: 'hello', clientNonce: 'aa'.repeat(32) })
  ws.msg({ type: 'pair', code: payload.code, deviceName: 'Phone' })
  w.manager.pairingResolve(w.manager.getUiState().pendingPairing.requestId, true)
  return { ws, deviceId: ws.of('paired')[0].deviceId, payload }
}

async function testManager(api) {
  // https off
  {
    const w = world(api, { name: 'off' })
    w.manager.applyConfig({ enabled: true, port: 4600, phoneFit: true, https: { enabled: false, mode: 'tailscaleServe' } })
    const { ws } = await pair(w)
    const ok = ws.of('authOk')[0]
    check(ok && !('pushKey' in ok) && !('secureUrl' in ok), 'https off: authOk carries neither pushKey nor secureUrl')
    check(w.secureCalls.length === 0 && !w.manager.getUiState().status.secure, 'https off: no CLI call, no secure status')
    check((await w.manager.notifyPush({ paneId: 'p1', provider: 'claude', state: 'action', reason: 'permission' }, null)) === 0, 'https off: notifyPush sends nothing')
    const st = await w.manager.setSecure(true)
    check(st.state === 'on' && st.url === `https://${DNS}`, 'setSecure(true) with a running server turns it on')
    check(w.manager.getUiState().status.endpoints[0].kind === 'tailscaleHttps' && w.manager.getUiState().status.endpoints[0].url === `https://${DNS}`, 'the https endpoint is listed first')
    check(srv().handlers.secureHost() === DNS, 'RemoteServer now accepts the MagicDNS Host')
    w.manager.applyConfig({ enabled: true, port: 4600, phoneFit: true, https: { enabled: true, mode: 'tailscaleServe' } })
    await tick(5)
    check(w.secureCalls.filter(c => c[0] === 'enable').length === 1, 'the config echo of the toggle runs no second enable')
    const off = await w.manager.setSecure(false)
    check(off.state === 'off' && w.secureCalls.some(c => c[0] === 'disable' && c[1] === 4600) && srv().handlers.secureHost() === null, 'setSecure(false) removes the handler and stops accepting the name')
  }
  // https on from config (boot)
  {
    const w = world(api, { name: 'on' })
    w.manager.applyConfig({ enabled: true, port: 4601, phoneFit: true, https: { enabled: true, mode: 'tailscaleServe' } })
    await tick(5)
    check(w.secureCalls[0][0] === 'enable' && w.secureCalls[0][1] === 4601, 'boot with https on: enable(port) in the background')
    check(w.manager.getUiState().status.secure.state === 'on', 'secure status on after the CLI answered')
    const { ws, deviceId, payload } = await pair(w)
    check(payload.endpoints[0].kind === 'tailscaleHttps' && payload.endpoints[0].host === DNS && !payload.endpoints[0].ip, 'the pairing QR lists the https origin first, without an ip')
    const ok = ws.of('authOk')[0]
    check(ok.pushKey === 'VAPIDPUB' && ok.secureUrl === `https://${DNS}`, 'https on: authOk carries pushKey and secureUrl')
    w.push.add(deviceId, subBody())
    const notice = { paneId: 'p1', provider: 'claude', state: 'action', reason: 'permission' }
    const cfg = { settings: { language: 'en', notifications: { notifyAction: true, notifyDone: false } }, workspaces: [{ id: 'w', name: 'W', panes: [{ id: 'p1', title: 'api' }] }] }
    check((await w.manager.notifyPush(notice, cfg)) === 1 && w.sent[0].payload.title === 'Claude needs permission', 'a hidden phone gets the push')
    ws.msg({ type: 'visibility', visible: true })
    check((await w.manager.notifyPush(notice, cfg)) === 1, 'visible but watching no console: still a push (FR-44)')
    ws.msg({ type: 'sub', paneId: 'p1' })
    check((await w.manager.notifyPush(notice, cfg)) === 0, 'visible and subscribed: no push')
    ws.msg({ type: 'visibility', visible: false })
    check((await w.manager.notifyPush(notice, cfg)) === 1, 'page hidden again: push')
    check((await w.manager.notifyPush({ ...notice, state: 'done' }, cfg)) === 0, 'notifyDone off: no push for done')
    // deep link base: a phone that came in through the https origin
    const w2ws = w.socket(DNS)
    w2ws.msg({ type: 'hello', deviceId, clientNonce: 'bb'.repeat(32) })
    const ch = w2ws.of('challenge')[0]
    const secret = ws.of('paired')[0].secret
    w2ws.msg({ type: 'auth', deviceId, hmac: crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(ch.nonce).digest('hex') })
    check(w2ws.of('authOk').length === 1 && w.manager.deepLinkBase() === `https://${DNS}`, 'deepLinkBase opens the https origin for a phone last seen there')
    await w.manager.revokeDevice(deviceId)
    check(!w.push.list().some(s => s.deviceId === deviceId), 'revoke drops the device push subscriptions')
    // Port change while on
    w.manager.applyConfig({ enabled: true, port: 4602, phoneFit: true, https: { enabled: true, mode: 'tailscaleServe' } })
    await tick(5)
    const last = w.secureCalls[w.secureCalls.length - 1]
    check(last[0] === 'enable' && last[1] === 4602 && last[2] === 4601, 'port change: enable(new, previous)')
    // An import turning it off
    w.manager.applyConfig({ enabled: true, port: 4602, phoneFit: true, https: { enabled: false, mode: 'tailscaleServe' } })
    await tick(5)
    check(w.secureCalls[w.secureCalls.length - 1][0] === 'disable' && !w.manager.getUiState().status.secure, 'config turning https off removes our handler')
  }
  // A failing toggle
  {
    const w = world(api, { name: 'fail', secureResult: { ok: false, error: 'no_https' } })
    w.manager.applyConfig({ enabled: true, port: 4603, phoneFit: true, https: { enabled: false, mode: 'tailscaleServe' } })
    await tick(5)
    const st = await w.manager.setSecure(true)
    check(st.state === 'error' && st.error === 'no_https', 'setSecure reports no_https')
    const { ws } = await pair(w)
    check(!('pushKey' in ws.of('authOk')[0]) && srv().handlers.secureHost() === null, 'a failed toggle leaves push and the name off')
  }
  {
    const w = world(api, { name: 'stopped' })
    w.manager.applyConfig({ enabled: false, port: 4604, phoneFit: true, https: { enabled: false, mode: 'tailscaleServe' } })
    check((await w.manager.setSecure(true)).error === 'server_off', 'setSecure with the server off: server_off')
  }
  for (const m of managers) m.shutdown('quit')
  // Notice router gate
  const pushed = []
  const router = api.createNoticeRouter({
    discord: { notify() {} }, ntfy: { notify() {}, wants: () => false },
    loadConfig: () => ({ settings: { notifications: { onlyWhenAway: true } }, workspaces: [] }),
    isAway: () => false, isPaneViewed: () => false, deepLinkBase: () => null,
    push: n => pushed.push(n),
  })
  router.route({ paneId: 'p', provider: 'claude', state: 'action' })
  check(pushed.length === 0, 'onlyWhenAway with the PC active: no push either')
  const router2 = api.createNoticeRouter({
    discord: { notify() {} }, ntfy: { notify() {}, wants: () => false },
    loadConfig: () => null, isAway: () => undefined, isPaneViewed: () => true, deepLinkBase: () => null,
    push: n => { pushed.push(n); throw new Error('boom') },
  })
  router2.route({ paneId: 'p', provider: 'claude', state: 'done' })
  check(pushed.length === 1, 'the router hands every notice past the gate to push (a throw never blocks the rest)')
}

// --- Phone ------------------------------------------------------------------------

function testPhone() {
  const code = buildSync({
    stdin: {
      resolveDir: root, loader: 'ts', contents: `
export { pushSupport, base64UrlToBytes, sameKey, postSubscription, isIosUserAgent, PUSH_SUBSCRIBE_PATH } from './src/mobile/src/lib/push'
export { pasteFromClipboard } from './src/mobile/src/lib/clipboardPaste'
export { wantsWakeLock, WAKE_LOCK_KEY } from './src/mobile/src/lib/wakeLock'
export { openHashOf } from './src/mobile/src/lib/serviceWorker'
export { fillServiceWorker, precacheList } from './src/mobile/swBuild'
` },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    define: { __APP_VERSION__: '"2.0.0"', 'process.env.NODE_ENV': '"production"' },
    alias: { '@shared': path.join(root, 'src/shared') },
  }).outputFiles[0].text
  const storage = new Map()
  const localStorage = { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k), key: i => [...storage.keys()][i] ?? null, get length() { return storage.size } }
  const api = run(code, { localStorage, atob: s => Buffer.from(s, 'base64').toString('binary') })
  return api
}

async function testPhoneLogic(api) {
  const env = o => ({ secure: true, hasPushManager: true, hasNotification: true, ios: false, standalone: false, pushKey: 'K', ...o })
  check(api.pushSupport(env({ secure: false })) === 'insecure' && api.pushSupport(env({ ios: true })) === 'iosBrowser' && api.pushSupport(env({ ios: true, standalone: true })) === 'ready', 'pushSupport: http hides it, a Safari tab on iOS gets the guide, the installed PWA gets the switch')
  check(api.pushSupport(env({ pushKey: null })) === 'noKey' && api.pushSupport(env({ hasPushManager: false })) === 'unsupported' && api.pushSupport(env({})) === 'ready', 'pushSupport: no key or no PushManager, no switch')
  check(api.isIosUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)') && api.isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5) && !api.isIosUserAgent('Mozilla/5.0 (Linux; Android 14)'), 'iOS detection includes iPadOS as a touch Mac')
  const key = Buffer.from(crypto.randomBytes(65)).toString('base64url')
  const bytes = api.base64UrlToBytes(key)
  check(bytes.length === 65 && Buffer.from(bytes).toString('base64url') === key, 'base64url VAPID key decodes to its 65 bytes')
  check(api.sameKey(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 65), key) && !api.sameKey(new Uint8Array(65).buffer, key) && !api.sameKey(null, key), 'sameKey compares the subscription key bytes')
  const calls = []
  const fakeFetch = status => async (url, init) => { calls.push({ url, init }); return { status } }
  const sub = { endpoint: 'https://fcm.googleapis.com/x', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }
  check((await api.postSubscription(sub, 'tok', fakeFetch(200))) === 'ok', 'postSubscription: 200 is ok')
  check(calls[0].url === '/api/push/subscribe' && calls[0].init.method === 'POST' && calls[0].init.headers.Authorization === 'Bearer tok' && JSON.parse(calls[0].init.body).keys.auth === 'a', 'POST to /api/push/subscribe with the Bearer and the subscription')
  check((await api.postSubscription(sub, 'tok', fakeFetch(401))) === 'unauthorized' && (await api.postSubscription(sub, 'tok', fakeFetch(404))) === 'notFound' && (await api.postSubscription(sub, 'tok', fakeFetch(400))) === 'rejected', 'postSubscription maps 401/404/400')
  check((await api.postSubscription(sub, 'tok', async () => { throw new Error('net') })) === 'offline', 'a network failure is offline')

  // Paste key (FR-48)
  const io = o => {
    const log = []
    return { log, io: { canRead: () => true, readText: async () => 'hola', composerMode: () => false, insertComposer: t => log.push(['insert', t]), pasteDirect: async t => { log.push(['paste', t]); return true }, openComposer: () => log.push(['composer']), ...o(log) } }
  }
  let t = io(() => ({}))
  check((await api.pasteFromClipboard(t.io)) === 'pasted' && JSON.stringify(t.log) === '[["paste","hola"]]', 'secure context: the clipboard goes straight to the console, no composer')
  t = io(() => ({ canRead: () => false }))
  const p = api.pasteFromClipboard(t.io)
  check(JSON.stringify(t.log) === '[["composer"]]', 'http: the one-shot composer opens synchronously inside the tap (D11)')
  check((await p) === 'fallback', 'and the result says fallback')
  t = io(() => ({ readText: async () => { throw new Error('NotAllowedError') } }))
  check((await api.pasteFromClipboard(t.io)) === 'fallback' && t.log[0][0] === 'composer', 'a refused read falls back to the composer')
  t = io(() => ({ readText: async () => '' }))
  check((await api.pasteFromClipboard(t.io)) === 'fallback', 'an empty clipboard falls back to the composer')
  t = io(() => ({ composerMode: () => true }))
  check((await api.pasteFromClipboard(t.io)) === 'composer' && t.log[0][0] === 'insert', 'Composer mode: the text lands at the composer caret')
  t = io(() => ({ pasteDirect: async () => false }))
  check((await api.pasteFromClipboard(t.io)) === 'fallback', 'a paste that could not go out opens the composer')

  // Wake lock (FR-49)
  const wl = o => api.wantsWakeLock({ pref: true, secure: true, supported: true, live: true, screen: 'terminal', visible: true, ...o })
  check(wl({}) && !wl({ screen: 'home' }) && !wl({ visible: false }) && !wl({ secure: false }) && !wl({ pref: false }) && !wl({ live: false }) && !wl({ screen: 'settings' }), 'wake lock: only in a console, visible, secure, with the setting on')
  check(api.WAKE_LOCK_KEY === 'snagentsos.remote.wakeLock', 'the setting key is snagentsos.remote.wakeLock')

  // SW message filter (FR-45)
  check(api.openHashOf({ type: 'snaos-open', hash: '#ws=w%201&pane=p1' }) === '#ws=w%201&pane=p1', 'a snaos-open message carries the deep link hash')
  check(api.openHashOf({ type: 'snaos-open', hash: 'javascript:alert(1)' }) === null && api.openHashOf({ type: 'x', hash: '#ws=a&pane=b' }) === null && api.openHashOf(null) === null, 'anything else is ignored')

  // SW build (FR-47)
  const list = api.precacheList(['assets/index-abc.js', 'assets/index-abc.css', 'assets/inter-latin-400.woff2', 'manifest.webmanifest', 'icons/icon-192.png', 'index.html'])
  check(JSON.stringify(list) === '["./","index.html","assets/index-abc.css","assets/index-abc.js","icons/icon-192.png","manifest.webmanifest"]', 'precache: shell, hashed js/css, manifest and icons; fonts are cached on use')
  const template = fs.readFileSync(path.join(root, 'src/mobile/public/sw.js'), 'utf8')
  const filled = api.fillServiceWorker(template, '2.0.0', list)
  check(/const VERSION = "2\.0\.0"/.test(filled) && filled.includes('const PRECACHE = ["./","index.html"'), 'fillServiceWorker writes the version and the list')
  let threw = false
  try { api.fillServiceWorker('nothing', '1', []) } catch { threw = true }
  check(threw, 'a template without markers fails the build')
  return filled
}

// --- The service worker in a fake scope ---------------------------------------------

async function testServiceWorker(source) {
  const listeners = {}
  const stores = new Map()
  const cacheFor = name => {
    if (!stores.has(name)) stores.set(name, new Map())
    const m = stores.get(name)
    const keyOf = r => (typeof r === 'string' ? r : r.url)
    return { put: async (r, res) => { m.set(keyOf(r), res) }, match: async r => m.get(keyOf(r)), addAll: async reqs => { for (const r of reqs) m.set(new URL(keyOf(r), 'https://pc.ts.net/').href, { ok: true, pre: true }) } }
  }
  const caches = {
    open: async n => cacheFor(n),
    keys: async () => [...stores.keys()],
    delete: async n => stores.delete(n),
    match: async r => { for (const n of stores.keys()) { const hit = await cacheFor(n).match(r); if (hit) return hit } return undefined },
  }
  let online = true
  const fetched = []
  const fetch = async req => { fetched.push(req.url || req); if (!online) throw new TypeError('offline'); return { ok: true, url: req.url, clone() { return { ok: true, url: req.url, cached: true } } } }
  const notifications = []
  const posted = []
  const opened = []
  let clientsList = []
  let claimed = false
  let skipped = false
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn },
    registration: { scope: 'https://pc.ts.net/', showNotification: async (title, opts) => notifications.push({ title, opts }) },
    location: { origin: 'https://pc.ts.net' },
    skipWaiting: () => { skipped = true },
    clients: { claim: async () => { claimed = true }, matchAll: async () => clientsList, openWindow: async url => opened.push(url) },
  }
  class Request { constructor(url, init) { this.url = new URL(url, 'https://pc.ts.net/').href; this.init = init } }
  vm.runInNewContext(source, { self, caches, fetch, Request, URL, console })
  const fire = async (type, event) => {
    let responded = null
    const waits = []
    const ev = { ...event, respondWith: p => { responded = p }, waitUntil: p => waits.push(p) }
    listeners[type](ev)
    await Promise.all(waits)
    return responded
  }
  await fire('install', {})
  check(skipped && stores.has('snaos-2.0.0') && stores.get('snaos-2.0.0').has('https://pc.ts.net/index.html'), 'install: skipWaiting and precache into snaos-<version>')
  stores.set('snaos-1.9.0', new Map())
  stores.set('other-cache', new Map())
  await fire('activate', {})
  check(claimed && !stores.has('snaos-1.9.0') && stores.has('other-cache') && stores.has('snaos-2.0.0'), 'activate: old snaos-* caches go, clients.claim')
  const get = (url, mode = 'no-cors') => ({ request: { method: 'GET', url, mode } })
  check((await fire('fetch', get('https://pc.ts.net/ws'))) === null && (await fire('fetch', get('https://pc.ts.net/api/push/subscribe'))) === null && (await fire('fetch', { request: { method: 'POST', url: 'https://pc.ts.net/api/upload' } })) === null, 'never intercepts /ws, /api/* nor a POST')
  check((await fire('fetch', get('https://elsewhere.com/x.js'))) === null, 'never intercepts another origin')
  fetched.length = 0
  let res = await (await fire('fetch', get('https://pc.ts.net/', 'navigate')))
  check(fetched.length === 1 && res.ok && !res.pre, 'navigation online: network first')
  online = false
  res = await (await fire('fetch', get('https://pc.ts.net/#ws=a&pane=b', 'navigate')))
  check(res && res.ok, 'navigation offline: the cached shell (the app then says it cannot reach the PC)')
  online = true
  fetched.length = 0
  await fire('fetch', get('https://pc.ts.net/assets/index-abc.js'))
  check(fetched.length === 0, 'a precached hashed asset comes from the cache')
  await fire('fetch', get('https://pc.ts.net/assets/inter-latin-400.woff2'))
  await fire('fetch', get('https://pc.ts.net/assets/inter-latin-400.woff2'))
  check(fetched.length === 1, 'hashed assets: cache first after the first fetch (fonts on use)')
  await fire('push', { data: { json: () => ({ title: 'Claude needs permission', body: 'api - Web', tag: 'p1', url: './#ws=w&pane=p1' }) } })
  check(notifications.length === 1 && notifications[0].title === 'Claude needs permission' && notifications[0].opts.tag === 'p1' && notifications[0].opts.body === 'api - Web' && notifications[0].opts.data.url === './#ws=w&pane=p1', 'push: shows the title, body and tag = pane')
  await fire('push', { data: { json: () => { throw new Error('bad') } } })
  check(notifications.length === 2 && notifications[1].title === 'SnAgentsOS', 'a malformed push still shows a notification (userVisibleOnly)')
  let closed = 0
  const focusClient = { url: 'https://pc.ts.net/', focus: async () => {}, postMessage: m => posted.push(m) }
  clientsList = [focusClient]
  await fire('notificationclick', { notification: { close: () => closed++, data: { url: './#ws=w&pane=p1' } } })
  check(closed === 1 && posted.length === 1 && posted[0].type === 'snaos-open' && posted[0].hash === '#ws=w&pane=p1' && opened.length === 0, 'tap with the app open: focus it and send the deep link')
  clientsList = []
  await fire('notificationclick', { notification: { close() {}, data: { url: 'https://evil.com/#ws=x&pane=y' } } })
  check(opened.length === 1 && opened[0] === 'https://pc.ts.net/', 'tap with no window: opens our own origin only (a foreign URL goes to the root)')
  await fire('notificationclick', { notification: { close() {}, data: { url: './#ws=w&pane=p2' } } })
  check(opened[1] === 'https://pc.ts.net/#ws=w&pane=p2', 'tap with no window: opens the deep link')
}

async function main() {
  const stubs = {
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^\.\/RemoteServer$/ }, args => (args.importer.endsWith('RemoteManager.ts') ? { path: 'RemoteServer', namespace: 'stub' } : undefined))
      b.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
      b.onLoad({ filter: /^RemoteServer$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `
export class RemoteServer {
  constructor(port: number, handlers: any) { (globalThis as any).__srv = { port, handlers } }
  start() { return Promise.resolve() }
  close() {}
}` }))
      b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(tmp)} }` }))
    },
  }
  const code = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `
export { SecureMode, SECURE_CLI_TIMEOUT_MS, readServeStatus, normalizeDnsName } from './src/main/remote/SecureMode'
export { PushService, isAllowedPushEndpoint, buildPushMessage, PUSH_SUBS_PER_DEVICE } from './src/main/remote/PushService'
export { RemoteManager } from './src/main/remote/RemoteManager'
export { createNoticeRouter } from './src/main/status/noticeRouter'
` },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode', 'web-push'],
    plugins: [stubs], alias: { '@shared': path.join(root, 'src/shared') },
  }).then(r => r.outputFiles[0].text)
  const serverCode = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `export { RemoteServer, forwardedIp } from './src/main/remote/RemoteServer'` },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'],
    alias: { '@shared': path.join(root, 'src/shared') },
  }).then(r => r.outputFiles[0].text)
  const api = run(code, { require: id => id === 'electron' ? electronStub : id === 'qrcode' ? { toDataURL: async () => 'data:' } : require(id) })
  mainCtx = run.lastCtx
  await testSecureMode(api)
  await testPushService(api)
  await testRemoteServer(run(serverCode))
  await testManager(api)
  const phone = testPhone()
  const filled = await testPhoneLogic(phone)
  await testServiceWorker(filled)
  console.log(`PASS: ${checks} secure mode, Web Push, service worker, paste key and wake lock checks`)
  fs.rmSync(tmp, { recursive: true, force: true })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
