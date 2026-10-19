// Image from the phone (E3-FR-06..10). The real RemoteServer + UploadService
// on an ephemeral loopback port (401/403/400/404/411/413/415/429, PNG/JPEG/
// WEBP, the partial file dropped on abort or overflow, a slow upload that
// outlives its token), the attachments cleanup on a temp folder (utimes: 8 vs
// 6 days, notas.txt and a symlink untouched, the 500MB cap), RemoteManager's
// wiring, and the phone's pure upload rules (sizing, reference, XHR with a
// fake request: progress, abort, 401 retry with the next token).
const { build } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { PassThrough } = require('node:stream')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-upload-'))
const DAY = 24 * 60 * 60 * 1000
const NAME_RE = /^\d{8}-\d{6}-[0-9a-f]{8}\.(png|jpg|webp)$/
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 3)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(60, 1)])
const GOOD = 'a1'.repeat(32), RATE = 'b2'.repeat(32), SLOW = 'c3'.repeat(32), OTHER = 'e5'.repeat(32)

const electronStub = { app: { isPackaged: false, getPath: () => tmp } }
function run(code, extra = {}) {
  const mod = { exports: {} }
  const ctx = {
    module: mod, exports: mod.exports, console, process, Buffer, URL, queueMicrotask,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, AbortController,
    __dirname: path.join(tmp, 'main'), require: id => id === 'electron' ? electronStub : require(id),
    ...extra,
  }
  ctx.globalThis = ctx
  vm.runInNewContext(code, ctx)
  return mod.exports
}
const bundle = (contents, plugins = []) => build({
  stdin: { resolveDir: root, loader: 'ts', contents },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'],
  plugins, alias: { '@shared': path.join(root, 'src/shared') },
}).then(r => r.outputFiles[0].text)

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

/** One request; resolves { status, headers, body }. `body` may be a Buffer or a function(req). */
function request(port, { method = 'POST', url = '/api/upload', headers = {}, body, host, origin } = {}) {
  const h = { Host: host ?? `127.0.0.1:${port}`, ...headers }
  if (origin !== null) h.Origin = origin ?? `http://127.0.0.1:${port}`
  if (Buffer.isBuffer(body) && h['Content-Length'] == null) h['Content-Length'] = body.length
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (typeof body === 'function') return body(req)
    if (body) req.end(body)
    else req.end()
  })
}
const auth = (token, type = 'image/png') => ({ Authorization: `Bearer ${token}`, 'Content-Type': type })
const files = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])

async function testServer(api) {
  const dir = path.join(tmp, 'attachments')
  const tokens = new Map([[GOOD, 'dev-1'], [RATE, 'dev-2'], [SLOW, 'dev-3'], [OTHER, 'dev-4']])
  const uploads = new api.UploadService({ dir: () => dir, resolveToken: t => (tokens.has(t) ? { deviceId: tokens.get(t) } : null) })
  const port = await freePort()
  const server = new api.RemoteServer(port, { onSocket() {}, onUpload: (req, res) => uploads.handle(req, res) })
  await server.start()
  try {
    let r = await request(port, { headers: { 'Content-Type': 'image/png' }, body: PNG })
    check(r.status === 401 && r.headers['www-authenticate'] === 'Bearer', 'no Bearer: 401 with WWW-Authenticate')
    r = await request(port, { headers: auth('ff'.repeat(32)), body: PNG })
    check(r.status === 401, 'an unknown (or closed socket) token: 401')
    r = await request(port, { headers: { Authorization: GOOD, 'Content-Type': 'image/png' }, body: PNG })
    check(r.status === 401, 'a token without the Bearer scheme: 401')
    r = await request(port, { headers: auth(GOOD), body: PNG, origin: 'http://evil.example' })
    check(r.status === 403, 'a foreign Origin: 403')
    r = await request(port, { headers: auth(GOOD), body: PNG, origin: null })
    check(r.status === 403, 'no Origin: 403')
    r = await request(port, { headers: auth(GOOD), body: PNG, host: `evil.example:${port}`, origin: `http://evil.example:${port}` })
    check(r.status === 400, 'a hostname Host (DNS rebinding): 400')
    r = await request(port, { headers: auth(GOOD), body: PNG, host: `127.0.0.1:${port + 1}`, origin: `http://127.0.0.1:${port + 1}` })
    check(r.status === 400, 'a Host on another port: 400')
    r = await request(port, { method: 'GET', headers: auth(GOOD) })
    check(r.status === 404, 'GET /api/upload: 404 (attachments are never served back)')
    r = await request(port, { url: '/api/push/other', headers: auth(GOOD), body: PNG })
    check(r.status === 404 && r.headers['cache-control'] === 'no-store', 'another /api/ route: 404, no-store')
    r = await request(port, { url: '/api', method: 'GET' })
    check(r.status === 404, '/api itself: 404, never the SPA shell')
    check(files(dir).length === 0, 'no request so far wrote anything')

    r = await request(port, { headers: auth(GOOD, 'text/plain'), body: PNG })
    check(r.status === 415, 'a type outside png/jpeg/webp: 415')
    r = await request(port, { headers: auth(GOOD, 'image/gif'), body: PNG })
    check(r.status === 415, 'image/gif: 415')
    r = await request(port, { headers: auth(GOOD, 'image/png'), body: JPEG })
    check(r.status === 415, 'declared PNG but JPEG magic bytes: 415')
    r = await request(port, { headers: auth(GOOD, 'image/webp'), body: Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(40)]) })
    check(r.status === 415, 'a RIFF that is not WEBP: 415')
    await tick()
    check(files(dir).length === 0, 'a rejected type leaves no partial behind')
    r = await request(port, { headers: { ...auth(GOOD), 'Content-Length': String(10 * 1024 * 1024 + 1) }, body: req => req.flushHeaders() })
    check(r.status === 413, 'a Content-Length over 10MB: 413 before any byte is read')
    r = await request(port, { headers: { ...auth(GOOD), 'Transfer-Encoding': 'chunked' }, body: req => { req.write(PNG); req.end() } })
    check(r.status === 411, 'no Content-Length (chunked): 411')

    r = await request(port, { headers: auth(GOOD, 'image/png'), body: PNG })
    const out = JSON.parse(r.body)
    check(r.status === 200 && r.headers['content-type'].startsWith('application/json') && r.headers['cache-control'] === 'no-store' && r.headers['x-content-type-options'] === 'nosniff', 'a PNG: 200 JSON with no-store and nosniff')
    check(path.dirname(out.path) === dir && NAME_RE.test(path.basename(out.path)) && out.path.endsWith('.png'), 'the path is dataDir/attachments/YYYYMMDD-HHmmss-<rand8>.png')
    check(fs.readFileSync(out.path).equals(PNG), 'the file holds exactly the uploaded bytes')
    r = await request(port, { headers: auth(GOOD, 'image/jpeg; charset=binary'), body: JPEG })
    check(r.status === 200 && JSON.parse(r.body).path.endsWith('.jpg'), 'a JPEG (with mime parameters): .jpg')
    r = await request(port, { headers: auth(GOOD, 'image/webp'), body: WEBP })
    check(r.status === 200 && JSON.parse(r.body).path.endsWith('.webp'), 'a WEBP is accepted too: .webp')
    check(files(dir).length === 3 && files(dir).every(n => NAME_RE.test(n)), 'three attachments and no .part left')

    // E3-FR-08: a slow upload whose socket (token) dies halfway still finishes.
    r = await request(port, { headers: { ...auth(SLOW), 'Content-Length': PNG.length }, body: req => {
      req.write(PNG.subarray(0, 40))
      setTimeout(() => { tokens.delete(SLOW); req.end(PNG.subarray(40)) }, 80)
    } })
    check(r.status === 200 && fs.readFileSync(JSON.parse(r.body).path).equals(PNG), 'the token is checked on the headers: a WS that drops mid-upload does not cut it')
    r = await request(port, { headers: auth(SLOW), body: PNG })
    check(r.status === 401, 'once the socket closed, a new POST with that token is 401')

    // The X on the phone: an aborted body leaves no partial.
    const before = files(dir).length
    await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/upload', agent: false, headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, ...auth(GOOD), 'Content-Length': 5000 } })
      req.on('error', () => resolve())
      req.write(PNG)
      setTimeout(() => {
        check(files(dir).some(n => n.endsWith('.part')), 'the body streams to a .part file')
        req.destroy()
        resolve()
      }, 150)
    })
    // Closing the handle can take a while on Windows (antivirus): poll.
    for (let i = 0; i < 100 && files(dir).some(n => n.endsWith('.part')); i++) await tick(20)
    check(files(dir).length === before && !files(dir).some(n => n.endsWith('.part')), 'an aborted upload removes its partial and adds nothing')

    // Rate: 10 accepted requests per minute per device, then 429.
    const codes = []
    for (let i = 0; i < 11; i++) codes.push((await request(port, { headers: auth(RATE, 'text/plain'), body: PNG })).status)
    check(codes.slice(0, 10).every(c => c === 415) && codes[10] === 429, 'the 11th upload of a device in a minute: 429')
    r = await request(port, { headers: auth(OTHER, 'image/png'), body: PNG })
    check(r.status === 200, 'the limit is per device: another device still uploads')

    // CSP of the static side gains blob: for the local preview.
    r = await request(port, { method: 'GET', url: '/', origin: null })
    check(/img-src 'self' data: blob:/.test(r.headers['content-security-policy'] || ''), 'the CSP allows blob: images')
  } finally {
    server.close()
  }
}

/** A fake IncomingMessage / ServerResponse pair to drive UploadService directly. */
function fakeExchange(headers) {
  const req = new PassThrough()
  req.headers = headers
  req.complete = false
  req.socket = {}
  req.on('end', () => { req.complete = true })
  const res = { code: 0, body: '', headersSent: false, writableEnded: false,
    writeHead(code) { this.code = code; this.headersSent = true }, end(b) { this.body = String(b ?? ''); this.writableEnded = true }, once() {} }
  return { req, res }
}

async function testOverflow(api) {
  const dir = path.join(tmp, 'overflow')
  const svc = new api.UploadService({ dir: () => dir, resolveToken: () => ({ deviceId: 'd' }), maxBytes: 100 })
  // Content-Length can lie only to a parser that does not enforce it; the
  // stream is counted anyway and going over drops the partial.
  const { req, res } = fakeExchange({ authorization: `Bearer ${GOOD}`, 'content-type': 'image/png', 'content-length': '50' })
  svc.handle(req, res)
  await tick(30)
  req.write(PNG.subarray(0, 60))
  req.write(PNG.subarray(60))
  await tick(60)
  check(res.code === 413, 'more bytes than the cap during the stream: 413')
  check(!files(dir).length, 'and the partial is deleted')
}

async function testCleanup(api) {
  const dir = path.join(tmp, 'clean')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const put = (name, ageMs, size = 10) => { const p = path.join(dir, name); fs.writeFileSync(p, Buffer.alloc(size)); const t = (now - ageMs) / 1000; fs.utimesSync(p, t, t); return p }
  const old = put('20240101-101010-0123abcd.png', 8 * DAY)
  const recent = put('20240101-101010-89abcdef.jpg', 6 * DAY)
  const notes = put('notas.txt', 30 * DAY)
  const upper = put('20240101-101010-FEDCBA98.png', 30 * DAY)
  const oldPart = put('20240101-101010-11112222.webp.part', 2 * DAY)
  const freshPart = put('20240101-101010-33334444.webp.part', 60 * 1000)
  fs.mkdirSync(path.join(dir, '20240101-101010-55556666.png'))
  const target = path.join(tmp, 'outside.png')
  fs.writeFileSync(target, 'keep me')
  const link = path.join(dir, '20240101-101010-77778888.png')
  let linked = false
  try { fs.symlinkSync(target, link, 'file'); linked = true } catch {
    try { fs.symlinkSync(tmp, link, 'junction'); linked = true } catch { /* no symlink rights */ }
  }
  if (linked) { try { const t = (now - 30 * DAY) / 1000; fs.lutimesSync(link, t, t) } catch { /* lutimes unsupported */ } }
  const svc = new api.UploadService({ dir: () => dir, resolveToken: () => null })
  const result = await svc.cleanup()
  check(!fs.existsSync(old), 'an attachment from 8 days ago is deleted')
  check(fs.existsSync(recent), 'one from 6 days ago stays')
  check(fs.existsSync(notes) && fs.existsSync(upper), 'notas.txt and a name off the pattern are never touched')
  check(!fs.existsSync(oldPart) && fs.existsSync(freshPart), 'a crash-left .part over a day goes; one in flight stays')
  check(fs.existsSync(path.join(dir, '20240101-101010-55556666.png')), 'a folder with an attachment name stays')
  if (linked) check(fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(target, 'utf8') === 'keep me', 'a symlink named like an attachment stays, and so does its target')
  else console.log('note: no symlink rights here, the symlink check was skipped')
  check(result.removed === 2, 'cleanup reports what it removed')

  const capDir = path.join(tmp, 'cap')
  fs.mkdirSync(capDir)
  const cap = (name, ageMs) => { const p = path.join(capDir, name); fs.writeFileSync(p, Buffer.alloc(100)); const t = (now - ageMs) / 1000; fs.utimesSync(p, t, t); return p }
  const a = cap('20240101-000001-aaaaaaa1.png', 3 * DAY), b = cap('20240101-000002-aaaaaaa2.png', 2 * DAY), c = cap('20240101-000003-aaaaaaa3.png', DAY)
  fs.writeFileSync(path.join(capDir, 'big.bin'), Buffer.alloc(1000))
  const capped = await new api.UploadService({ dir: () => capDir, resolveToken: () => null, maxTotalBytes: 250 }).cleanup()
  check(!fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(c) && capped.keptBytes === 200, 'over the size cap the oldest attachments go first (other files do not count)')
  const none = await new api.UploadService({ dir: () => path.join(tmp, 'missing'), resolveToken: () => null }).cleanup()
  check(none.removed === 0, 'a missing folder is not an error')
  check(api.ATTACHMENT_MAX_AGE_MS === 7 * DAY && api.ATTACHMENT_MAX_TOTAL_BYTES === 500 * 1024 * 1024 && api.ATTACHMENT_CLEANUP_INTERVAL_MS === 6 * 60 * 60 * 1000 && api.UPLOAD_MAX_BYTES === 10 * 1024 * 1024, 'constants: 7 days, 500MB, every 6h, 10MB')
}

function testHelpers(api) {
  check(api.attachmentName('png', new Date(2026, 9, 18, 7, 5, 9), '0a1b2c3d') === '20261018-070509-0a1b2c3d.png', 'attachmentName is YYYYMMDD-HHmmss-<rand8>.<ext>')
  check(NAME_RE.test(api.attachmentName('jpg')), 'a random name matches the cleanup pattern')
  check(api.bearerToken('Bearer abc') === 'abc' && api.bearerToken('bearer abc') === 'abc' && api.bearerToken('Basic abc') === null && api.bearerToken(undefined) === null && api.bearerToken('Bearer a b') === null, 'bearerToken parsing')
  check(api.magicMatches('png', PNG) && api.magicMatches('jpg', JPEG) && api.magicMatches('webp', WEBP) && !api.magicMatches('png', JPEG) && !api.magicMatches('webp', PNG), 'magic bytes per type')
}

async function testManagerWiring() {
  const dataDir = path.join(tmp, 'data')
  const att = path.join(dataDir, 'attachments')
  fs.mkdirSync(att, { recursive: true })
  const stale = path.join(att, '20240101-101010-deadbeef.png')
  fs.writeFileSync(stale, 'x')
  const t = (Date.now() - 9 * DAY) / 1000
  fs.utimesSync(stale, t, t)
  const stubs = { name: 'stubs', setup(b) {
    b.onResolve({ filter: /\/RemoteServer$/ }, () => ({ path: 'RemoteServer', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
    b.onLoad({ filter: /^RemoteServer$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `
export class RemoteServer {
  constructor(port: number, handlers: any) { (globalThis as any).__holder.handlers = handlers }
  start() { return Promise.resolve() }
  close() {}
}` }))
    b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(dataDir)} }` }))
  } }
  const code = await bundle(`export { RemoteManager } from './src/main/remote/RemoteManager'`, [stubs])
  const holder = {}
  const api = run(code, { __holder: holder })
  const pty = { addSink() {}, removeSink() {}, setRunningChangeListener() {}, setForcedFast() {}, runningPaneIds: () => [], exitedPaneCodes: () => new Map(), getReplay: () => null, ptyIdForPane: () => null, write() {} }
  const wc = { isDestroyed: () => false, setBackgroundThrottling() {}, send() {} }
  const manager = new api.RemoteManager(pty, () => wc, '2.0.0', () => [], () => 'PC', () => [])
  manager.loadDevices()
  for (let i = 0; i < 20 && fs.existsSync(stale); i++) await tick(10)
  check(!fs.existsSync(stale), 'RemoteManager prunes old attachments as it starts (E3-FR-10), server on or off')
  manager.applyConfig({ enabled: true, port: 4601 })
  await tick(0)
  check(typeof holder.handlers?.onUpload === 'function', 'the running server routes POST /api/upload to the UploadService')
  manager.shutdown('quit')
}

async function testMobileRules() {
  const r = await build({ entryPoints: [path.join(root, 'src/mobile/src/lib/upload.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') } })
  const up = run(r.outputFiles[0].text)
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  check(eq(up.fitSize(4032, 3024), { width: 2000, height: 1500 }), 'a 4032x3024 photo goes 2000 on the long side')
  check(eq(up.fitSize(1170, 2532), { width: 924, height: 2000 }), 'a 1170x2532 screenshot goes 924x2000')
  check(eq(up.fitSize(800, 600), { width: 800, height: 600 }), 'a small image is never upscaled')
  check(up.outputMime('image/png') === 'image/png' && up.outputMime('image/heic') === 'image/jpeg' && up.outputMime('image/jpeg') === 'image/jpeg' && up.outputMime('image/webp') === 'image/jpeg' && up.outputMime('') === 'image/jpeg', 'PNG stays PNG, anything else (HEIC included) goes JPEG')
  check(up.UPLOAD_MAX_BYTES === 10 * 1024 * 1024 && up.JPEG_QUALITY === 0.85 && up.JPEG_RETRY_QUALITY === 0.7 && up.IMAGE_MAX_SIDE === 2000, 'constants: 10MB, JPEG 0.85 then 0.7, 2000px')
  const p = 'C:\\Users\\me\\attachments\\20261018-070509-0a1b2c3d.png'
  check(up.attachmentRef(p) === `"${p}" `, 'the reference is the path in double quotes plus a space')
  check(up.appendRef('', 'R ', 100) === 'R ' && up.appendRef('mira', 'R ', 100) === 'mira R ' && up.appendRef('mira ', 'R ', 100) === 'mira R ' && up.appendRef('x\n', 'R ', 100) === 'x\nR ', 'appending keeps one separator from the draft')
  check(up.appendRef('abcd', 'R ', 6) === null, 'a reference that does not fit is refused')
  check(up.statusError(401) === 'auth' && up.statusError(413) === 'tooBig' && up.statusError(415) === 'type' && up.statusError(429) === 'rate' && up.statusError(0) === 'network' && up.statusError(500) === 'server', 'HTTP statuses map to error codes')

  const xhrs = []
  class FakeXhr {
    constructor() { this.headers = {}; this.upload = { onprogress: null }; this.status = 0; this.responseText = ''; this.aborted = false; xhrs.push(this) }
    open(m, u) { this.method = m; this.url = u }
    setRequestHeader(k, v) { this.headers[k] = v }
    send(body) { this.body = body }
    abort() { this.aborted = true; this.onabort && this.onabort() }
    respond(status, text = '') { this.status = status; this.responseText = text; this.onload() }
  }
  const next = () => xhrs[xhrs.length - 1]
  let token = GOOD
  const progress = []
  const opts = (extra = {}) => ({ token: () => token, waitForNewToken: async () => null, onProgress: v => progress.push(v), signal: new AbortController().signal, createXhr: () => new FakeXhr(), ...extra })
  const blob = { size: 3 }
  let pending = up.uploadImage(blob, 'image/png', opts())
  const x = next()
  check(x.method === 'POST' && x.url === '/api/upload' && x.headers.Authorization === `Bearer ${GOOD}` && x.headers['Content-Type'] === 'image/png' && x.body === blob, 'POST /api/upload with the Bearer, the mime and the raw body')
  x.upload.onprogress({ lengthComputable: true, loaded: 42, total: 100 })
  check(progress.at(-1) === 42, 'progress is reported in percent')
  x.respond(200, JSON.stringify({ path: p }))
  check((await pending) === p, 'a 200 resolves with the PC path')

  const failWith = async (status, text) => { const pr = up.uploadImage(blob, 'image/png', opts()); next().respond(status, text); try { await pr; return 'ok' } catch (e) { return e.code } }
  check((await failWith(500)) === 'server' && (await failWith(413)) === 'tooBig' && (await failWith(200, 'nope')) === 'server', 'errors and a malformed body reject with a code')
  pending = up.uploadImage(blob, 'image/png', opts()); next().onerror()
  check(await pending.then(() => 'ok', e => e.code) === 'network', 'a network error rejects as network')

  const ac = new AbortController()
  pending = up.uploadImage(blob, 'image/png', opts({ signal: ac.signal }))
  const toAbort = next()
  ac.abort()
  check(toAbort.aborted && await pending.then(() => 'ok', e => e.code) === 'aborted', 'the X aborts the request')

  // 401: one retry with the next authOk's token.
  const NEW = 'dd'.repeat(32)
  let waited = null
  pending = up.uploadImage(blob, 'image/png', opts({ waitForNewToken: async used => { waited = used; token = NEW; return NEW } }))
  next().respond(401)
  await tick(0)
  const retry = next()
  check(waited === GOOD && retry.headers.Authorization === `Bearer ${NEW}`, 'a 401 waits for the next token and retries once with it')
  retry.respond(200, JSON.stringify({ path: p }))
  check((await pending) === p, 'the retry succeeds')
  token = GOOD
  pending = up.uploadImage(blob, 'image/png', opts({ waitForNewToken: async () => null }))
  next().respond(401)
  check(await pending.then(() => 'ok', e => e.code) === 'auth', 'no new token in time: auth error')
  const count = xhrs.length
  pending = up.uploadImage(blob, 'image/png', opts({ waitForNewToken: async () => { token = NEW; return NEW } }))
  next().respond(401); await tick(0); next().respond(401)
  check(await pending.then(() => 'ok', e => e.code) === 'auth' && xhrs.length === count + 2, 'only one retry: a second 401 fails')
  token = null
  check(await up.uploadImage(blob, 'image/png', opts()).then(() => 'ok', e => e.code) === 'auth', 'without a token nothing is sent')
}

async function main() {
  const code = await bundle(`
export { RemoteServer } from './src/main/remote/RemoteServer'
export * from './src/main/remote/UploadService'
`)
  const api = run(code)
  testHelpers(api)
  await testServer(api)
  await testOverflow(api)
  await testCleanup(api)
  await testManagerWiring()
  await testMobileRules()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`PASS: ${checks} upload route, attachments cleanup and phone upload checks`)
}

main().catch(error => { console.error(error); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1) })
