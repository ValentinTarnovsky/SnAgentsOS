// Share (app 2.4.0, item 8) stage S2: the guest core over real sockets.
// esbuild bundle of src/main/share/guest (LinkStore, ShareClient, ShareGuest)
// with S0's crypto, invite and schemas, run in plain node; every server
// listens on 127.0.0.1 on a random port.
//
// Part 1 drives the guest against a minimal fake host built from S0's
// hostHandshake / SecureChannel / proofs: the upgrade it sends, join,
// approval, password, terminal plane batching and backpressure, the input
// pre-gate and chunking, requests, keepalive, every close code, reconnect
// with the ticket, server restart, endpoint fallback, identity and version
// mismatch, strict host frames, and the link store.
//
// Part 2 runs against the real ShareServer of src/main/share when it exists
// (S1): browser-style upgrades rejected and the full flows. It is skipped
// (and says so) while the host core is not there.
const { build } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { WebSocketServer } = require('ws')

const root = path.resolve(__dirname, '..')
let checks = 0
let skipped = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-share-net-'))
const alias = { '@shared': path.join(root, 'src/shared') }
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^(\.\.\/)+paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
    b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(tmp)} }` }))
  },
}

async function bundle(contents) {
  const out = await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias, plugins: [stubs], logLevel: 'silent' })
  const mod = { exports: {} }
  const fn = vm.runInThisContext(`(function (module, exports, require) {${out.outputFiles[0].text}\n})`)
  fn(mod, mod.exports, id => (id === 'electron' ? { safeStorage: {}, app: { getPath: () => tmp }, ipcMain: { handle() {}, on() {} } } : require(id)))
  return mod.exports
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(cond, ms = 3000, label = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

let S = null

// --- Fakes ---------------------------------------------------------------------

/** DPAPI stand-in: a reversible tag, so a test can see nothing is stored in clear. */
function fakeVault(available = true) {
  return {
    available: () => available,
    encrypt: s => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'),
    decrypt: b => {
      const t = b.toString('utf8')
      if (!t.startsWith('ENC:')) throw new Error('not ours')
      return Buffer.from(t.slice(4), 'hex').toString('utf8')
    },
  }
}

function makeState(perm, extra = {}) {
  return {
    scope: { kind: 'workspace', label: 'Proyecto' },
    perm,
    title: 'Proyecto',
    layoutOrder: ['p1', 'p2'],
    panes: [
      { id: 'p1', title: 'PowerShell', type: 'shell', color: '#888888', icon: 'terminal', running: true },
      { id: 'p2', title: 'Claude', type: 'claude', color: '#ff8800', icon: 'claude', running: true, status: { state: 'idle', precise: true, provider: 'claude', stateSince: 1 } },
    ],
    terminalUnicode11: true,
    hostPlatform: 'win32',
    caps: { createPane: true, closePane: true, chat: true, notes: true, git: true },
    presets: [{ id: 'pre1', name: 'Shell', type: 'shell', icon: 'terminal', color: '#888888' }],
    ...extra,
  }
}

/**
 * The smallest host S0's crypto allows: hs1 -> hs2 + ready, the hello proof,
 * tickets, approval, an optional password and canned answers. `mode`:
 * approve (welcome at once), pending (wait for approve()), deny, silent.
 */
class FakeHost {
  constructor(opts = {}) {
    this.key = opts.key ?? S.generateShareKeyPair()
    this.shareId = opts.shareId ?? S.randomB64u(16)
    this.inviteKey = opts.inviteKey ?? crypto.randomBytes(16)
    this.mode = opts.mode ?? 'approve'
    this.perm = opts.perm ?? 'type'
    this.minVersion = opts.minVersion
    this.maxVersion = opts.maxVersion
    this.pw = opts.pw ?? null // { salt, key }
    this.tickets = new Set(opts.tickets ?? [])
    this.upgrades = []
    this.conns = []
    this.hellos = []
    this.badFrames = []
    this.onHs = opts.onHs ?? null
    this.server = null
    this.wss = null
    this.port = 0
  }

  async listen(port = 0) {
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: set => (set.has('snaos-share.1') ? 'snaos-share.1' : false) })
    this.server = http.createServer((req, res) => { res.writeHead(404, { Connection: 'close' }); res.end() })
    this.server.on('upgrade', (req, socket, head) => {
      this.upgrades.push({ url: req.url, headers: { ...req.headers } })
      this.wss.handleUpgrade(req, socket, head, ws => this.onWs(ws))
    })
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve) })
    this.port = this.server.address().port
    return this
  }

  async stop(code = 1001) {
    for (const c of this.conns) try { c.ws.close(code) } catch {}
    await new Promise(r => this.wss.close(() => r()))
    await new Promise(r => this.server.close(() => r()))
    for (const c of this.conns) try { c.ws.terminate() } catch {}
  }

  live() { return this.conns.filter(c => c.ws.readyState === 1) }
  last() { return this.conns[this.conns.length - 1] }

  onWs(ws) {
    const c = { ws, channel: null, h: null, phase: 'hs1', msgs: [], inputs: [], welcomed: false, mute: false }
    this.conns.push(c)
    ws.on('message', (data, isBinary) => {
      if (c.phase === 'hs1') {
        const r = S.hostHandshake(isBinary ? '' : data.toString('utf8'), { hostStatic: this.key, minVersion: this.minVersion, maxVersion: this.maxVersion, app: '9.9.9' })
        if (!r.ok) {
          if (r.reply) ws.send(r.reply)
          ws.close(r.close)
          return
        }
        c.channel = r.channel
        c.guestStatic = r.guestStatic
        c.phase = 'live'
        if (this.onHs) this.onHs(c, r, ws)
        else {
          ws.send(r.reply)
          ws.send(r.ready)
        }
        return
      }
      if (!isBinary) { this.badFrames.push('text'); ws.close(4400); return }
      const text = c.channel.open(data)
      if (text === null) { this.badFrames.push('crypto'); ws.close(4400); return }
      const p = S.parseShareClientMsg(text)
      if (!p.ok) { this.badFrames.push(text); ws.close(4400); return }
      c.msgs.push(p.msg)
      if (!c.mute) this.onMsg(c, p.msg)
    })
  }

  send(c, msg) { if (c.ws.readyState === 1) c.ws.send(c.channel.seal(msg)) }

  welcome(c, perm = this.perm) {
    const ticket = S.randomB64u(32)
    this.tickets.add(ticket)
    c.welcomed = true
    this.send(c, { t: 'welcome', session: { id: 'sess' + this.conns.indexOf(c) }, grant: { scope: { kind: 'workspace', label: 'Proyecto' } }, perm, host: { label: 'Host PC', platform: 'win32', app: '2.4.0' }, ticket, state: makeState(perm), limits: { inputMax: 8192 } })
  }

  approve(perm) { const c = this.conns.find(x => x.pendingApproval && x.ws.readyState === 1); if (c) { c.pendingApproval = false; this.welcome(c, perm) } }

  pending(c, extra = {}) {
    c.pendingApproval = true
    this.send(c, { t: 'pending', expiresAt: Date.now() + 60_000, password: !!this.pw, ...(this.pw ? { salt: this.pw.salt.toString('base64url') } : {}), ...extra })
  }

  onMsg(c, m) {
    switch (m.t) {
      case 'hello': {
        this.hellos.push({ msg: m, h: c.h = c.channel.h, guestStatic: c.guestStatic })
        if (m.sid !== this.shareId || !S.verifyShareProof(this.inviteKey, 'join', c.channel.h, m.proof)) { c.ws.close(4401); return }
        if (m.ticket && this.tickets.has(m.ticket)) return this.welcome(c)
        if (this.pw && m.pw) {
          if (S.verifyShareProof(this.pw.key, 'pw', c.channel.h, m.pw)) return this.welcome(c)
          return this.pending(c, { passwordFailed: true })
        }
        if (this.mode === 'approve') return this.welcome(c)
        if (this.mode === 'deny') { this.send(c, { t: 'denied', reason: 'denied' }); c.ws.close(4403); return }
        if (this.mode === 'pending') return this.pending(c)
        return
      }
      case 'password':
        if (this.pw && S.verifyShareProof(this.pw.key, 'pw', c.channel.h, m.proof)) { c.pendingApproval = false; return this.welcome(c) }
        return this.pending(c, { passwordFailed: true })
      case 'sub':
      case 'resync':
        this.send(c, { t: 'replay', paneId: m.paneId, running: true, cols: 120, rows: 30, data: 'hello ', first: true, last: false })
        this.send(c, { t: 'replay', paneId: m.paneId, running: true, cols: 120, rows: 30, data: 'world', first: false, last: true })
        this.send(c, { t: 'fit', paneId: m.paneId, cols: 120, rows: 30 })
        return
      case 'input':
        c.inputs.push(m)
        return
      case 'ctl':
        if (this.mode === 'silent') return
        this.send(c, m.op === 'createPane' ? { t: 'ctlAck', id: m.id, ok: true, paneId: 'p-new' } : { t: 'ctlAck', id: m.id, ok: true })
        return
      case 'gitReq':
        this.send(c, { t: 'gitRes', id: m.id, ok: true, data: { error: 'not_repo' }, page: 0, done: true })
        return
      case 'notesReq':
        if (m.op === 'write') this.send(c, { t: 'notesRes', id: m.id, ok: true, note: { id: m.noteId, title: '', updatedAt: 2, size: 4, rev: '2-4' } })
        else this.send(c, { t: 'notesRes', id: m.id, ok: true, notes: [{ id: 'n1', title: 'Plan', updatedAt: 1, size: 3, rev: 'r1' }] })
        return
      case 'filesReq':
        this.send(c, m.op === 'list'
          ? { t: 'filesRes', id: m.id, ok: true, entries: [{ name: 'src', kind: 'dir', size: 0, mtimeMs: 1 }, { name: 'README.md', kind: 'file', size: 5, mtimeMs: 1 }], truncated: false }
          : { t: 'filesRes', id: m.id, ok: true, file: { kind: 'text', text: '# Hola', eol: 'lf', bom: false, rev: '1-6', size: 6 } })
        return
      case 'ping':
        this.send(c, { t: 'pong', ts: m.ts })
        return
      default:
    }
  }
}

function inviteFor(host, opts = {}) {
  return S.encodeShareInvite({
    v: 1, h: opts.label ?? 'Host PC', pk: S.toB64u(opts.pk ?? host.key.pub), s: host.shareId, k: S.toB64u(host.inviteKey),
    e: opts.endpoints ?? [{ a: '127.0.0.1', p: host.port, t: 'loop' }],
    sc: { k: 'workspace', l: 'Proyecto' }, pm: opts.pm ?? 'type',
  }, { allowLoopback: true })
}

const FAST = { backoffMs: [80, 160, 320], jitter: 0, attemptMs: 1000, handshakeMs: 1500, pingMs: 20_000, silenceMs: 60_000, ctlMs: 400, gitMs: 400, notesMs: 400, filesMs: 400 }

let guestSeq = 0
function makeGuest(opts = {}) {
  const dir = path.join(tmp, `g${++guestSeq}`)
  fs.mkdirSync(dir, { recursive: true })
  const vault = opts.vault ?? fakeVault(true)
  const events = []
  const store = opts.store ?? new S.LinkStore(path.join(dir, 'share-links.json'), vault)
  const ids = new S.ShareIdentityStore(path.join(dir, 'share-identity.json'), vault)
  const dials = []
  const guest = new S.ShareGuest({
    store,
    guestIdentity: () => ids.get('guest'),
    guestFingerprint: () => { const p = ids.peekPub('guest'); return p ? S.keyFingerprint(p) : null },
    ownKeys: () => opts.ownKeys ?? [],
    guestName: () => opts.name ?? 'Ana PC',
    app: '2.4.0',
    send: (ch, p) => events.push({ ch, p }),
    allowLoopback: true,
    batchMs: 16,
    connection: {
      tune: { ...FAST, ...opts.tune },
      ...(opts.protocolMax ? { protocolMax: opts.protocolMax } : {}),
      dial: (ep, ms) => { dials.push(`${ep.a}:${ep.p}`); return S.dialShareWs(ep, ms) },
    },
  })
  const linkEvents = () => events.filter(e => e.ch === S.CH.SHARE_LINK_EVENT).map(e => e.p)
  const links = () => linkEvents().filter(e => e.t === 'link').map(e => e.link)
  const items = () => events.filter(e => e.ch === S.CH.SHARE_STREAM).flatMap(e => e.p.items)
  const status = id => guest.view(id)?.status
  return { guest, store, ids, vault, events, dir, dials, linkEvents, links, items, status, file: path.join(dir, 'share-links.json') }
}

async function joined(host, g, opts = {}) {
  const res = g.guest.join(inviteFor(host, opts))
  check(res.ok, 'join accepted')
  const id = res.link.id
  await waitFor(() => g.status(id) === (opts.expect ?? 'connected'), 3000, `status ${opts.expect ?? 'connected'}`)
  return id
}

// --- 1. Units: backoff, endpoint order, link store --------------------------------

function testUnits() {
  const tune = { backoffMs: [1000, 2000, 5000, 10000, 30000], jitter: 0.2 }
  check([0, 1, 2, 3, 4, 9].map(i => S.shareBackoffDelay(i, tune, () => 0.5)).join() === '1000,2000,5000,10000,30000,30000', 'backoff 1, 2, 5, 10, 30 s, then stays at 30 s')
  check(S.shareBackoffDelay(0, tune, () => 0) === 800 && S.shareBackoffDelay(0, tune, () => 0.999999) === 1200, 'jitter is +-20 %')
  check(S.SHARE_CLIENT_TUNE.attemptMs === 4000 && S.SHARE_CLIENT_TUNE.pingMs === 20000, '4 s per attempt, ping every 20 s')
  const eps = [{ a: '100.64.0.1', p: 4527, t: 'ts' }, { a: '192.168.1.5', p: 4527, t: 'lan' }, { a: '10.0.0.2', p: 4600, t: 'lan' }]
  check(S.orderEndpoints({ endpoints: eps }).map(e => e.a).join() === '100.64.0.1,192.168.1.5,10.0.0.2', 'invite order without a last endpoint')
  check(S.orderEndpoints({ endpoints: eps, lastEndpoint: '10.0.0.2:4600' }).map(e => e.a).join() === '10.0.0.2,100.64.0.1,192.168.1.5', 'the last endpoint that worked is dialed first')
  check(S.orderEndpoints({ endpoints: eps, lastEndpoint: '1.2.3.4:5' }).length === 3, 'a stale last endpoint changes nothing')

  // LinkStore over the fake DPAPI.
  const dir = path.join(tmp, 'store1')
  const file = path.join(dir, 'share-links.json')
  const host = { key: S.generateShareKeyPair(), shareId: S.randomB64u(16), inviteKey: crypto.randomBytes(16), port: 4527 }
  const inv = S.parseShareInvite(inviteFor(host), { allowLoopback: true }).invite
  const store = new S.LinkStore(file, fakeVault(true))
  const a = store.upsertFromInvite(inv)
  check(a.ok && a.created && /^[A-Za-z0-9_-]{22}$/.test(a.link.id), 'a new invite makes a link with a 22-char id')
  const disk = fs.readFileSync(file, 'utf8')
  check(!disk.includes(S.toB64u(host.inviteKey)) && !disk.includes(host.inviteKey.toString('base64')) && !disk.includes(host.inviteKey.toString('hex')), 'the invite key is never on disk in clear')
  check(JSON.parse(disk).links[0].inviteKey.enc === 'dpapi' && disk.charCodeAt(0) !== 0xfeff, 'sealed as dpapi, UTF-8 without BOM')
  check(!fs.existsSync(file + '.tmp'), 'temp file renamed away')
  const b = store.upsertFromInvite(inv)
  check(b.ok && !b.created && b.link.id === a.link.id, 'the same invite refreshes the same link')
  const rotated = { ...inv, k: S.randomB64u(16), e: [{ a: '127.0.0.1', p: 4600, t: 'loop' }] }
  const c = store.upsertFromInvite(rotated)
  check(c.ok && c.link.id === a.link.id && S.toB64u(store.inviteKey(a.link.id)) === rotated.k && c.link.endpoints[0].p === 4600, 'a rotated invite keeps the id and takes the new key and endpoints')
  store.markConnected(a.link.id, '127.0.0.1:4600')
  store.setPassword(a.link.id, { salt: crypto.randomBytes(16), key: Buffer.alloc(32, 7) })
  const again = new S.LinkStore(file, fakeVault(true))
  const back = again.get(a.link.id)
  check(back && back.lastEndpoint === '127.0.0.1:4600' && back.lastConnectedAt > 0, 'last endpoint and connect time survive a restart')
  check(again.password(a.link.id)?.key.equals(Buffer.alloc(32, 7)), 'the remembered password key survives, sealed')
  check(!fs.readFileSync(file, 'utf8').includes(Buffer.alloc(32, 7).toString('base64')), 'the password key is never on disk in clear')
  again.setPassword(a.link.id, null)
  check(new S.LinkStore(file, fakeVault(true)).password(a.link.id) === null, 'forgetting the password key persists')

  // A blob DPAPI cannot open drops the link; a malformed file is ignored.
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc.links.push({ ...doc.links[0], id: S.randomB64u(16), shareId: S.randomB64u(16), inviteKey: { enc: 'dpapi', data: Buffer.from('garbage').toString('base64') } })
  doc.links.push({ ...doc.links[0], id: 'bad', extra: 1 })
  fs.writeFileSync(file, JSON.stringify(doc))
  check(new S.LinkStore(file, fakeVault(true)).list().length === 1, 'an undecryptable or malformed link is dropped, the good one stays')
  fs.writeFileSync(file, '{not json')
  check(new S.LinkStore(file, fakeVault(true)).list().length === 0, 'an unreadable file is ignored')

  // No encryption: memory only, the file is never written.
  const memFile = path.join(tmp, 'store2', 'share-links.json')
  const mem = new S.LinkStore(memFile, fakeVault(false))
  const m = mem.upsertFromInvite(inv)
  mem.setPassword(m.link.id, { salt: crypto.randomBytes(16), key: Buffer.alloc(32, 1) })
  check(m.ok && !mem.persisted && mem.list().length === 1 && mem.password(m.link.id) !== null && !fs.existsSync(memFile), 'without encryption links and password keys live in memory only')

  // At most 32 links.
  const many = new S.LinkStore(path.join(tmp, 'store3', 'share-links.json'), fakeVault(true))
  const firstOfMany = { ...inv, s: S.randomB64u(16) }
  many.upsertFromInvite(firstOfMany)
  for (let i = 1; i < 32; i++) many.upsertFromInvite({ ...inv, s: S.randomB64u(16) })
  const over = many.upsertFromInvite({ ...inv, s: S.randomB64u(16) })
  check(!over.ok && over.error === 'limit' && many.upsertFromInvite(firstOfMany).ok, 'a 33rd link is refused, refreshing an existing one still works')
}

// --- 2. Join, upgrade shape, hello, views -------------------------------------------

async function testJoin() {
  const host = await new FakeHost().listen()
  const g = makeGuest({ name: 'Ana\u0007 PC\u200b' })
  const pre = g.guest.preview(inviteFor(host))
  check(pre.ok && pre.preview.hostLabel === 'Host PC' && pre.preview.perm === 'type' && pre.preview.scope.kind === 'workspace' && /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(pre.preview.hostFingerprint), 'preview shows the host, scope, perm and key fingerprint')
  check(pre.preview.endpoints[0].kind === 'loop' && !pre.preview.existingId && g.store.list().length === 0, 'preview saves nothing')
  check(g.guest.preview('garbage').error === 'format', 'a bad invite previews as an error')
  const self = makeGuest({ ownKeys: [S.toB64u(host.key.pub)] })
  check(self.guest.preview(inviteFor(host)).error === 'self' && self.guest.join(inviteFor(host)).error === 'self', 'an invite of our own key is refused')

  const id = await joined(host, g)
  const up = host.upgrades[0]
  check(up.url === '/share', 'dials the /share path')
  check(up.headers['x-snaos-share'] === '1', 'sends the custom header')
  check(up.headers['sec-websocket-protocol'] === 'snaos-share.1', 'asks for the snaos-share.1 subprotocol')
  check(up.headers.origin === undefined && Object.keys(up.headers).every(k => !k.startsWith('sec-fetch-')), 'no Origin and no sec-fetch headers')
  check(up.headers.host === `127.0.0.1:${host.port}`, 'Host is the IP literal and port')
  check(!up.headers['sec-websocket-extensions'], 'no permessage-deflate offer')

  const hello = host.hellos[0]
  check(hello.msg.sid === host.shareId && hello.msg.app === '2.4.0' && hello.msg.ticket === undefined && hello.msg.pw === undefined, 'hello names the share, the app, no ticket nor password the first time')
  check(hello.msg.guestName === 'Ana PC', 'the guest name is sanitized (controls and zero-width removed)')
  check(hello.guestStatic.equals(g.ids.get('guest').pub), 'the host learns the guest static key from the handshake')

  const seen = g.links().filter(l => l.id === id).map(l => l.status)
  check(seen[0] === 'connecting' && seen[seen.length - 1] === 'connected', 'link events go connecting -> connected')
  const stateEvt = g.linkEvents().find(e => e.t === 'state')
  check(stateEvt && stateEvt.linkId === id && stateEvt.state.panes.length === 2, 'the welcome state reaches the renderer')
  const view = g.guest.view(id)
  check(view.perm === 'type' && view.host.label === 'Host PC' && view.persisted && !view.rememberedPassword && view.lastConnectedAt > 0, 'the view carries perm, host and persistence')
  const list = g.guest.links()
  check(list.persisted && list.links.length === 1 && list.guestFingerprint === S.keyFingerprint(g.ids.get('guest').pub), 'links() lists it with this PC guest fingerprint')
  check(!JSON.stringify(list).includes(S.toB64u(host.inviteKey)) && !JSON.stringify(g.events).includes(S.toB64u(host.inviteKey)), 'no invite key ever reaches the renderer')
  check(g.guest.preview(inviteFor(host)).preview.existingId === id, 'a known invite previews with the existing link')

  // Join again: same link, redialed.
  const again = g.guest.join(inviteFor(host))
  check(again.ok && again.link.id === id && g.store.list().length === 1, 're-joining the same invite keeps one link')
  await waitFor(() => g.status(id) === 'connected' && host.live().length === 1, 3000, 'rejoined')

  // Disconnect: bye, idle, no reconnect.
  const before = host.conns.length
  check(g.guest.disconnect(id), 'disconnect')
  await waitFor(() => host.last().msgs.some(m => m.t === 'bye'), 2000, 'bye')
  await sleep(300)
  check(g.status(id) === 'idle' && host.conns.length === before, 'disconnect sends bye and never reconnects')
  check(g.guest.connect(id), 'connect again')
  await waitFor(() => g.status(id) === 'connected', 3000, 'reconnected by hand')
  check(host.hellos[host.hellos.length - 1].msg.ticket !== undefined, 'a manual reconnect reuses the ticket')

  // Forget.
  check(g.guest.forget(id) && g.store.list().length === 0 && g.linkEvents().some(e => e.t === 'removed' && e.linkId === id), 'forget removes the link and tells the renderer')
  check(!fs.readFileSync(g.file, 'utf8').includes(id), 'the forgotten link is gone from disk')
  check(!g.guest.connect(id) && !g.guest.forget('x'), 'unknown or malformed ids are refused')
  g.guest.dispose()
  self.guest.dispose()
  await host.stop()
}

// --- 3. Terminal plane: batching, scope filter, backpressure, reload ------------------

async function testStream() {
  const host = await new FakeHost().listen()
  const g = makeGuest()
  const id = await joined(host, g)
  const c = host.last()
  g.guest.sub({ linkId: id, paneId: 'p1' })
  await waitFor(() => g.items().some(i => i.t === 'fit'), 2000, 'replay')
  const replay = g.items().filter(i => i.t === 'replay')
  check(replay.length === 2 && replay[0].first && replay[1].last && replay.map(r => r.data).join('') === 'hello world', 'the replay arrives in order with first/last')
  host.send(c, { t: 'out', paneId: 'p1', data: 'a' })
  host.send(c, { t: 'out', paneId: 'p1', data: 'b' })
  host.send(c, { t: 'out', paneId: 'p1', data: 'c' })
  host.send(c, { t: 'out', paneId: 'zz', data: 'nope' })
  await waitFor(() => g.items().some(i => i.t === 'out'), 2000, 'out')
  await sleep(40)
  const outs = g.items().filter(i => i.t === 'out')
  check(outs.length === 1 && outs[0].data === 'abc', 'consecutive output of a pane is batched into one item')
  check(!g.items().some(i => i.paneId === 'zz'), 'frames for panes outside the state never reach the renderer')
  const streamEvt = g.events.find(e => e.ch === S.CH.SHARE_STREAM)
  check(streamEvt.p.linkId === id, 'stream events carry the link id')

  // Backpressure: paused panes drop output; resume asks for a resync.
  g.guest.flowCtl({ linkId: id, paneId: 'p1', pause: true })
  const n = g.items().length
  host.send(c, { t: 'out', paneId: 'p1', data: 'lost' })
  await sleep(60)
  check(g.items().length === n, 'output of a paused pane is not forwarded')
  g.guest.flowCtl({ linkId: id, paneId: 'p1', pause: false })
  await waitFor(() => c.msgs.some(m => m.t === 'resync' && m.paneId === 'p1'), 2000, 'resync')
  await waitFor(() => g.items().filter(i => i.t === 'replay').length === 4, 2000, 'second replay')
  const resyncs = () => c.msgs.filter(m => m.t === 'resync').length
  g.guest.flowCtl({ linkId: id, paneId: 'p1', pause: true })
  g.guest.flowCtl({ linkId: id, paneId: 'p1', pause: false })
  await sleep(60)
  check(resyncs() === 1, 'a pause with nothing dropped resumes without a resync')

  // Statuses update the stored state, and state events flush the stream first.
  host.send(c, { t: 'paneStatus', paneId: 'p2', status: { state: 'working', precise: true, provider: 'claude', stateSince: 2 } })
  host.send(c, { t: 'out', paneId: 'p1', data: 'x' })
  host.send(c, { t: 'state', state: makeState('type', { title: 'Renamed' }) })
  await waitFor(() => g.linkEvents().some(e => e.t === 'state' && e.state.title === 'Renamed'), 2000, 'state')
  const idxOut = g.events.findIndex(e => e.ch === S.CH.SHARE_STREAM && e.p.items.some(i => i.t === 'out' && i.data === 'x'))
  const idxState = g.events.findIndex(e => e.ch === S.CH.SHARE_LINK_EVENT && e.p.t === 'state' && e.p.state.title === 'Renamed')
  check(idxOut >= 0 && idxOut < idxState, 'buffered output is flushed before a link event')
  check(g.items().some(i => i.t === 'paneStatus' && i.status.state === 'working'), 'pane statuses ride the stream')

  // Unknown well-formed types are ignored; err reaches the renderer.
  host.send(c, { t: 'futureThing', x: 1 })
  host.send(c, { t: 'err', code: 'rate' })
  await waitFor(() => g.linkEvents().some(e => e.t === 'err' && e.code === 'rate'), 2000, 'err')
  check(g.status(id) === 'connected', 'an unknown frame type is ignored')

  // Renderer reload: every mount is dropped on the host.
  g.guest.resetRenderer()
  await waitFor(() => c.msgs.some(m => m.t === 'unsub' && m.paneId === 'p1'), 2000, 'unsub on reload')
  check(true, 'a renderer reload unsubscribes its panes')
  g.guest.dispose()
  await host.stop()
}

// --- 4. Input: pre-gate, pastes as a unit, chunking ----------------------------------

async function testInput() {
  const host = await new FakeHost({ perm: 'type' }).listen()
  const g = makeGuest()
  const id = await joined(host, g)
  const c = host.last()
  const refused = () => g.items().filter(i => i.t === 'inputRefused')
  const send = (paneId, data, paste) => g.guest.input({ linkId: id, paneId, data, ...(paste ? { paste: true } : {}) })

  send('p1', 'echo hi')
  await waitFor(() => c.inputs.length === 1, 2000, 'input')
  check(c.inputs[0].data === 'echo hi' && c.inputs[0].paste === undefined && c.inputs[0].paneId === 'p1', 'typed text reaches the host as one input')
  send('p1', '\r')
  send('p1', 'ls\x03')
  send('p1', 'line1\nline2', true)
  await waitFor(() => refused().length === 3, 2000, 'refusals')
  check(refused().map(r => r.reason).join() === 'no_send,interrupt,no_send', 'Enter, Ctrl+C and a multi-line paste are refused in main (type)')
  send('p1', '\x1b')
  send('p1', '[13u')
  await waitFor(() => refused().length === 4, 2000, 'split esc')
  check(refused()[3].reason === 'blocked_key' && c.inputs.map(i => i.data).join('|') === 'echo hi|\x1b', 'Esc passes, a CSI-u Enter split across two calls is refused')
  send('p2', 'hola')
  send('p2', '\t')
  await waitFor(() => c.inputs.length === 4, 2000, 'agent idle input')
  check(c.inputs[3].data === '\t', 'text and Tab pass in an idle agent pane')
  host.send(c, { t: 'paneStatus', paneId: 'p2', status: { state: 'working', precise: true, provider: 'claude', stateSince: 3 } })
  await waitFor(() => g.items().some(i => i.t === 'paneStatus'), 2000, 'status')
  send('p2', '\t')
  host.send(c, { t: 'paneStatus', paneId: 'p2', status: { state: 'action', precise: true, provider: 'claude', stateSince: 4 } })
  await waitFor(() => g.items().filter(i => i.t === 'paneStatus').length === 2, 2000, 'action')
  send('p2', '1')
  send('p2', '\x1b')
  await waitFor(() => refused().length === 6 && c.inputs.length === 5, 2000, 'agent rules')
  check(refused()[4].reason === 'agent_busy' && refused()[5].reason === 'awaiting_host' && c.inputs[4].data === '\x1b', 'Tab is refused while working, only Esc passes while the agent waits')
  send('nope', 'x')
  await waitFor(() => refused().length === 7, 2000, 'scope')
  check(refused()[6].reason === 'out_of_scope', 'a pane outside the state is refused locally')
  g.guest.input({ linkId: id, paneId: 'p1', data: 'x'.repeat(65537) })
  await waitFor(() => refused().length === 8, 2000, 'too large')
  check(refused()[7].reason === 'paste_too_large', 'more than 64KB in one call is refused')

  // Full: a long paste goes as parts that never cut an ESC sequence or a pair.
  host.send(c, { t: 'permChanged', perm: 'full' })
  await waitFor(() => g.guest.view(id).perm === 'full', 2000, 'perm full')
  const unit = '\x1b[200~' + 'a'.repeat(8186) + '\x1b[1;5A' + '\u{1F600}'.repeat(10) + 'b\r\n'.repeat(3000) + '\x1b[201~'
  const before = c.inputs.length
  send('p1', unit, true)
  await waitFor(() => c.inputs.length > before && c.inputs[c.inputs.length - 1].paste?.last, 2000, 'paste parts')
  const parts = c.inputs.slice(before)
  check(parts.length >= 2 && parts.length <= 8 && parts.every((p, i) => p.paste.part === i && p.paste.id === parts[0].paste.id && p.paste.last === (i === parts.length - 1)), 'a paste goes as numbered parts of one id')
  check(parts.every(p => p.data.length <= 8192) && parts.map(p => p.data).join('') === unit, 'parts are <= 8192 and join back to the paste')
  const cutBad = parts.slice(0, -1).some(p => {
    const tail = p.data.slice(-8)
    const hi = p.data.charCodeAt(p.data.length - 1)
    return /\x1b(\[[\x20-\x3f]*)?$/.test(tail) || (hi >= 0xd800 && hi <= 0xdbff)
  })
  check(!cutBad, 'no part ends inside an ESC sequence or a surrogate pair')
  const seqs = c.inputs.map(i => i.seq)
  check(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'input seq grows monotonically')
  send('p1', 'z'.repeat(9000))
  await waitFor(() => c.inputs[c.inputs.length - 1].paste?.last && c.inputs[c.inputs.length - 1].data.endsWith('z'), 2000, 'long write')
  check(c.inputs[c.inputs.length - 2].paste?.part === 0, 'a write over 8192 travels as a paste unit too')

  // View: nothing leaves main.
  host.send(c, { t: 'permChanged', perm: 'view' })
  await waitFor(() => g.guest.view(id).perm === 'view', 2000, 'perm view')
  const n = c.inputs.length
  send('p1', 'a')
  await waitFor(() => refused().some(r => r.reason === 'view_only'), 2000, 'view only')
  check(c.inputs.length === n, 'view never forwards input')

  // Paused by the host: refused locally, status paused.
  host.send(c, { t: 'permChanged', perm: 'type' })
  host.send(c, { t: 'paused', on: true })
  await waitFor(() => g.status(id) === 'paused', 2000, 'paused')
  send('p1', 'a')
  await waitFor(() => refused().some(r => r.reason === 'paused'), 2000, 'paused refusal')
  host.send(c, { t: 'paused', on: false })
  await waitFor(() => g.status(id) === 'connected', 2000, 'resumed')
  check(true, 'pause and resume move the link status')

  // Malformed IPC arguments are ignored.
  g.guest.input({ linkId: 'bad', paneId: 'p1', data: 'x' })
  g.guest.input({ linkId: id, paneId: 'p\n1', data: 'x' })
  g.guest.input(null)
  g.guest.sub({ linkId: id, paneId: 42 })
  await sleep(40)
  check(c.inputs.length === n, 'malformed renderer arguments never reach the host')
  g.guest.dispose()
  await host.stop()
}

// --- 5. Requests: ctl, git, notes, chat -----------------------------------------------

async function testRequests() {
  const host = await new FakeHost({ perm: 'full' }).listen()
  const g = makeGuest()
  const id = await joined(host, g)
  const c = host.last()
  const made = await g.guest.ctl({ linkId: id, op: 'createPane', presetId: 'pre1' })
  check(made.ok && made.paneId === 'p-new' && c.msgs.some(m => m.t === 'ctl' && m.op === 'createPane' && m.presetId === 'pre1'), 'createPane round trip')
  g.guest.sub({ linkId: id, paneId: 'p-new' })
  await waitFor(() => c.msgs.some(m => m.t === 'sub' && m.paneId === 'p-new'), 2000, 'sub new pane')
  check(true, 'a pane named by a createPane ack can be subscribed before the next state')
  check((await g.guest.ctl({ linkId: id, op: 'createPane', presetId: 'nope' })).error === 'bad_preset', 'a preset outside the snapshot is refused locally')
  check((await g.guest.ctl({ linkId: id, op: 'closePane', paneId: 'zz' })).error === 'out_of_scope', 'closing a pane outside the scope is refused locally')
  check((await g.guest.ctl({ linkId: id, op: 'closePane', paneId: 'p1' })).ok, 'closePane round trip')
  const git = await g.guest.git({ linkId: id, op: 'status' })
  check(git.ok && git.reply.data.error === 'not_repo' && git.reply.done, 'git status round trip')
  check((await g.guest.git({ linkId: id, op: 'diff', path: '../etc/passwd' })).error === 'invalid' && (await g.guest.git({ linkId: id, op: 'diff', path: 'C:\\x' })).error === 'invalid', 'git paths that escape are refused in main')
  const notes = await g.guest.notes({ linkId: id, op: 'list' })
  check(notes.ok && notes.reply.notes[0].id === 'n1', 'notes list round trip')
  check((await g.guest.notes({ linkId: id, op: 'read' })).error === 'invalid' && (await g.guest.notes({ linkId: id, op: 'write', text: 'x' })).error === 'invalid' && (await g.guest.notes({ linkId: id, op: 'write', noteId: 'n1' })).error === 'invalid', 'notes need an id to read or write, and a write its text')
  check((await g.guest.notes({ linkId: id, op: 'write', noteId: 'n1', text: 'x' })).error === 'denied' && (await g.guest.files({ linkId: id, op: 'list', rel: '' })).error === 'denied', 'without notesWrite or files (a v1 host sends neither) the guest refuses locally')
  // A v2 host turns on notes write and files.
  host.send(c, { t: 'state', state: makeState('full', { caps: { createPane: true, closePane: true, chat: true, notes: true, git: true, notesWrite: true, files: true } }) })
  await waitFor(() => g.linkEvents().filter(e => e.t === 'state').length === 2, 2000, 'v2 caps state')
  const wr = await g.guest.notes({ linkId: id, op: 'write', noteId: 'n1', text: 'hola', baseRev: 'r1' })
  const sentW = c.msgs.find(m => m.t === 'notesReq' && m.op === 'write')
  check(wr.ok && wr.reply.note.rev === '2-4' && sentW && sentW.text === 'hola' && sentW.baseRev === 'r1' && !('workspaceId' in sentW), 'a note write round trip (never naming a workspace)')
  const before = c.msgs.length
  check((await g.guest.notes({ linkId: id, op: 'write', noteId: 'n1', text: 'ñ'.repeat(20001) })).error === 'too_large', 'past 40000 UTF-8 bytes a note write is refused in main')
  const ctl = String.fromCharCode(1).repeat(40000)
  check((await g.guest.notes({ linkId: id, op: 'write', noteId: 'n1', text: ctl })).error === 'too_large' && c.msgs.length === before, 'a 40000-byte note that escapes past one guest frame is never sent')
  check(g.status(id) === 'connected', 'and the link stays up')
  const fl = await g.guest.files({ linkId: id, op: 'list', rel: '' })
  check(fl.ok && fl.reply.entries.map(e => e.name).join() === 'src,README.md', 'a files list round trip')
  const fr = await g.guest.files({ linkId: id, op: 'read', rel: 'README.md' })
  check(fr.ok && fr.reply.file.text === '# Hola', 'a file read round trip')
  check((await g.guest.files({ linkId: id, op: 'read', rel: '../x' })).error === 'invalid' && (await g.guest.files({ linkId: id, op: 'read', rel: '.GIT/config' })).error === 'invalid' && (await g.guest.files({ linkId: id, op: 'read', rel: '' })).error === 'invalid' && (await g.guest.files({ linkId: id, op: 'write', rel: 'a' })).error === 'invalid', 'paths out, .git, the root as a file and writes are refused in main')
  g.guest.filesWatch({ linkId: id, on: true })
  await waitFor(() => c.msgs.some(m => m.t === 'filesWatch' && m.on === true), 2000, 'filesWatch on')
  host.send(c, { t: 'filesChanged', dirs: ['src'] })
  await waitFor(() => g.linkEvents().some(e => e.t === 'filesChanged' && e.dirs[0] === 'src'), 2000, 'filesChanged')
  check(true, 'filesChanged reaches the renderer while the drawer is open')
  g.guest.resetRenderer()
  await waitFor(() => c.msgs.some(m => m.t === 'filesWatch' && m.on === false), 2000, 'filesWatch off on reset')
  check(true, 'a renderer reload turns the watch off')
  g.guest.chat({ linkId: id, op: 'sub', paneId: 'p2' })
  await waitFor(() => c.msgs.some(m => m.t === 'chatSub' && m.paneId === 'p2'), 2000, 'chatSub')
  host.send(c, { t: 'chatPage', paneId: 'p2', items: [{ id: '1', role: 'user', ts: 1, blocks: [{ t: 'text', text: 'hola' }] }], cursor: null, done: true })
  await waitFor(() => g.events.some(e => e.ch === S.CH.SHARE_CHAT_EVENT), 2000, 'chat event')
  check(g.events.find(e => e.ch === S.CH.SHARE_CHAT_EVENT).p.msg.items[0].blocks[0].text === 'hola', 'chat pages reach the renderer')
  host.send(c, { t: 'notesChanged', noteId: 'n1' })
  await waitFor(() => g.linkEvents().some(e => e.t === 'notesChanged' && e.noteId === 'n1'), 2000, 'notesChanged')
  check(true, 'notesChanged reaches the renderer')

  host.mode = 'silent'
  check((await g.guest.ctl({ linkId: id, op: 'createPane' })).error === 'timeout', 'an unanswered ctl times out')

  // Caps off: refused without a round trip.
  host.send(c, { t: 'state', state: makeState('full', { caps: { createPane: false, closePane: false, chat: false, notes: false, git: false } }) })
  await waitFor(() => g.linkEvents().filter(e => e.t === 'state').length === 3, 2000, 'caps state')
  check((await g.guest.ctl({ linkId: id, op: 'createPane' })).error === 'denied' && (await g.guest.git({ linkId: id, op: 'status' })).error === 'denied' && (await g.guest.notes({ linkId: id, op: 'list' })).error === 'denied', 'requests the caps do not grant are refused locally')
  g.guest.disconnect(id)
  check((await g.guest.git({ linkId: id, op: 'status' })).error === 'offline', 'requests on a disconnected link answer offline')
  g.guest.dispose()
  await host.stop()
}

// --- 6. Approval, password, denial ------------------------------------------------------

async function testApproval() {
  // Waiting, then allowed.
  let host = await new FakeHost({ mode: 'pending' }).listen()
  let g = makeGuest()
  let id = await joined(host, g, { expect: 'waiting_approval' })
  const v = g.guest.view(id)
  check(v.pending && v.pending.password === false && v.pending.expiresAt > Date.now() && !('salt' in v.pending), 'waiting_approval carries the prompt expiry (no salt to the renderer)')
  check((await g.guest.password({ linkId: id, password: 'whatever1', remember: false })).error === 'not_pending', 'no password field without a password share')
  host.approve('view')
  await waitFor(() => g.status(id) === 'connected', 2000, 'approved')
  check(g.guest.view(id).perm === 'view' && !g.guest.view(id).pending, 'approved with the host chosen perm')
  g.guest.dispose()
  await host.stop()

  // Denied: ended, no reconnect.
  host = await new FakeHost({ mode: 'deny' }).listen()
  g = makeGuest()
  id = await joined(host, g, { expect: 'ended' })
  await sleep(300)
  check(g.guest.view(id).reason === 'denied' && host.conns.length === 1, 'a denial ends the link with no retry')
  g.guest.dispose()
  await host.stop()

  // Password: wrong, then right and remembered; the host restarts and the guest gets in alone.
  const salt = crypto.randomBytes(16)
  const pw = { salt, key: await S.derivePasswordKey('correct horse', salt) }
  host = await new FakeHost({ mode: 'pending', pw }).listen()
  g = makeGuest()
  id = await joined(host, g, { expect: 'waiting_approval' })
  check(g.guest.view(id).pending.password === true, 'the prompt says a password is accepted')
  check((await g.guest.password({ linkId: id, password: 'short', remember: true })).error === 'invalid', 'a password under 8 characters is refused locally')
  check((await g.guest.password({ linkId: id, password: 'wrong password', remember: true })).ok, 'a wrong password is sent')
  await waitFor(() => g.status(id) === 'password_required', 3000, 'password_required')
  check(g.guest.view(id).pending.passwordFailed === true && !g.guest.view(id).rememberedPassword, 'a wrong password shows password_required and is not remembered')
  check((await g.guest.password({ linkId: id, password: 'correct horse', remember: true })).ok, 'the right password is sent')
  await waitFor(() => g.status(id) === 'connected', 3000, 'password admitted')
  check(g.guest.view(id).rememberedPassword && g.store.password(id).key.equals(pw.key), 'remember keeps the derived key')
  check(!fs.readFileSync(g.file, 'utf8').includes('correct horse') && !JSON.stringify(g.events).includes('correct horse'), 'the password itself is stored nowhere')
  const port = host.port
  await host.stop()
  await waitFor(() => g.status(id) === 'reconnecting', 2000, 'reconnecting after stop')
  host = await new FakeHost({ key: host.key, shareId: host.shareId, inviteKey: host.inviteKey, mode: 'pending', pw }).listen(port)
  await waitFor(() => g.status(id) === 'connected', 4000, 'unattended reconnect')
  const hello = host.hellos[host.hellos.length - 1].msg
  check(hello.pw && !host.tickets.has(hello.ticket), 'after a host restart the remembered password key gets in (the old ticket is unknown)')

  // The host changed the password: the stale key is dropped and the guest is asked again.
  await host.stop()
  const salt2 = crypto.randomBytes(16)
  host = await new FakeHost({ key: host.key, shareId: host.shareId, inviteKey: host.inviteKey, mode: 'pending', pw: { salt: salt2, key: await S.derivePasswordKey('new password', salt2) } }).listen(port)
  await waitFor(() => g.status(id) === 'password_required', 4000, 'stale password')
  check(!g.store.password(id), 'a remembered key that fails is forgotten')
  g.guest.dispose()
  await host.stop()

  // autoConnect only starts links with a remembered key.
  host = await new FakeHost({ mode: 'approve', pw }).listen()
  const g1 = makeGuest()
  const idA = await joined(host, g1)
  g1.store.setPassword(idA, pw)
  const second = await new FakeHost({ mode: 'approve' }).listen()
  const idB = await joined(second, g1)
  g1.guest.dispose()
  const before = host.conns.length + second.conns.length
  const g2 = makeGuest({ store: new S.LinkStore(g1.file, g1.vault) })
  g2.guest.autoConnect()
  await waitFor(() => g2.status(idA) === 'connected', 3000, 'autoConnect')
  await sleep(200)
  check(g2.status(idB) === 'idle' && host.conns.length + second.conns.length === before + 1, 'autoConnect starts only the links with a remembered password')
  g2.guest.dispose()
  await host.stop()
  await second.stop()
}

// --- 7. Close codes, reconnect, keepalive, restart ---------------------------------------

async function testCloseCodes() {
  const cases = [
    [4401, 'bad_invite', false], [4403, 'denied', false], [4410, 'expired', false], [4411, 'scope_gone', false],
    [4412, 'kicked', false], [4426, 'version', false], [4429, 'locked', false], [4403, 'revoked', true],
  ]
  for (const [code, reason, afterWelcome] of cases) {
    const host = await new FakeHost({ mode: afterWelcome ? 'approve' : 'pending' }).listen()
    const g = makeGuest()
    const id = await joined(host, g, { expect: afterWelcome ? 'connected' : 'waiting_approval' })
    host.last().ws.close(code)
    await waitFor(() => g.status(id) === 'ended', 2000, `ended on ${code}`)
    await sleep(250)
    check(g.guest.view(id).reason === reason && host.conns.length === 1, `close ${code} ends the link (${reason}) with no reconnect`)
    g.guest.dispose()
    await host.stop()
  }
  // The host's own `ended` frame decides before the close.
  for (const [reason, retry] of [['kicked', false], ['revoked', false], ['host_quit', true], ['sharing_off', true]]) {
    const host = await new FakeHost().listen()
    const g = makeGuest()
    const id = await joined(host, g)
    host.send(host.last(), { t: 'ended', reason })
    host.last().ws.close(retry ? 1001 : 4412)
    if (retry) {
      await waitFor(() => host.conns.length === 2 && g.status(id) === 'connected', 3000, `retry after ${reason}`)
      check(true, `ended ${reason} reconnects`)
    } else {
      await waitFor(() => g.status(id) === 'ended', 2000, `ended ${reason}`)
      await sleep(250)
      check(g.guest.view(id).reason === reason && host.conns.length === 1, `ended ${reason} stops for good`)
    }
    g.guest.dispose()
    await host.stop()
  }
  // Approval timeout (4408 while pending): ended timeout.
  {
    const host = await new FakeHost({ mode: 'pending' }).listen()
    const g = makeGuest()
    const id = await joined(host, g, { expect: 'waiting_approval' })
    host.send(host.last(), { t: 'denied', reason: 'timeout' })
    await waitFor(() => g.status(id) === 'ended', 2000, 'approval timeout')
    check(g.guest.view(id).reason === 'timeout', 'an approval timeout ends the link')
    g.guest.dispose()
    await host.stop()
  }
  // busy: retried with backoff.
  {
    const host = await new FakeHost({ mode: 'pending' }).listen()
    const g = makeGuest()
    const id = await joined(host, g, { expect: 'waiting_approval' })
    host.send(host.last(), { t: 'denied', reason: 'busy' })
    host.last().ws.close(4403)
    await waitFor(() => g.status(id) === 'ended' || host.conns.length === 2, 2000, 'busy outcome')
    // 4403 after a 'busy' denial: the close code wins (denied), a host that wants a retry closes 1001/4408.
    check(g.status(id) === 'ended', 'a 4403 close is final even after a busy hint')
    g.guest.dispose()
    await host.stop()
  }
}

async function testReconnect() {
  // Lost socket: reconnect with the ticket, no new approval, mounted panes resubscribed.
  let host = await new FakeHost({ mode: 'pending' }).listen()
  const g = makeGuest()
  const id = await joined(host, g, { expect: 'waiting_approval' })
  host.approve()
  await waitFor(() => g.status(id) === 'connected', 2000, 'approved')
  g.guest.sub({ linkId: id, paneId: 'p1' })
  g.guest.sub({ linkId: id, paneId: 'gone' })
  await waitFor(() => host.last().msgs.some(m => m.t === 'sub' && m.paneId === 'p1'), 2000, 'sub')
  host.last().ws.terminate()
  await waitFor(() => g.status(id) === 'reconnecting', 2000, 'reconnecting')
  const view = g.guest.view(id)
  check(view.retryAt > Date.now() - 50 && view.retryAt <= Date.now() + 200, 'reconnecting carries the next attempt time (first step of the backoff)')
  await waitFor(() => g.status(id) === 'connected' && host.conns.length === 2, 3000, 'back with ticket')
  const hello = host.hellos[host.hellos.length - 1].msg
  check(hello.ticket && host.tickets.has(hello.ticket), 'the reconnect hello carries the ticket and needs no approval')
  await waitFor(() => host.last().msgs.some(m => m.t === 'sub' && m.paneId === 'p1'), 2000, 'resub')
  check(!host.last().msgs.some(m => m.t === 'sub' && m.paneId === 'gone'), 'only mounted panes still in the state are resubscribed')

  // Server restart: tickets gone, a new approval.
  const port = host.port
  await host.stop()
  await waitFor(() => g.status(id) === 'reconnecting', 2000, 'host gone')
  check(g.guest.view(id).reason === 'host_quit', 'a 1001 close reads as host_quit while reconnecting')
  await sleep(200)
  host = await new FakeHost({ key: host.key, shareId: host.shareId, inviteKey: host.inviteKey, mode: 'pending' }).listen(port)
  await waitFor(() => g.status(id) === 'waiting_approval', 4000, 'restart asks again')
  host.approve()
  await waitFor(() => g.status(id) === 'connected', 2000, 'approved after restart')
  check(true, 'after a server restart the guest reconnects on its own and a new approval admits it')
  g.guest.dispose()
  await host.stop()

  // Keepalive: pings flow; a silent host is dropped and redialed.
  host = await new FakeHost().listen()
  const k = makeGuest({ tune: { pingMs: 50, silenceMs: 220 } })
  const kid = await joined(host, k)
  await waitFor(() => host.last().msgs.filter(m => m.t === 'ping').length >= 2, 2000, 'pings')
  check(host.last().msgs.find(m => m.t === 'ping').ts > 0, 'the guest pings on its interval')
  host.last().mute = true
  await waitFor(() => host.conns.length === 2 && k.status(kid) === 'connected', 3000, 'silence redial')
  check(true, 'a host silent past the limit is dropped and redialed')
  k.guest.dispose()
  await host.stop()
}

async function testEndpoints() {
  // First endpoint dead: the second one connects and becomes the first next time.
  const host = await new FakeHost().listen()
  const dead = http.createServer()
  await new Promise(r => dead.listen(0, '127.0.0.1', r))
  const deadPort = dead.address().port
  await new Promise(r => dead.close(r))
  const g = makeGuest()
  const id = await joined(host, g, { endpoints: [{ a: '127.0.0.1', p: deadPort, t: 'loop' }, { a: '127.0.0.1', p: host.port, t: 'loop' }] })
  check(g.dials[0] === `127.0.0.1:${deadPort}` && g.dials[1] === `127.0.0.1:${host.port}`, 'endpoints are dialed in invite order')
  check(g.store.get(id).lastEndpoint === `127.0.0.1:${host.port}`, 'the endpoint that worked is remembered')
  const n = g.dials.length
  host.last().ws.close(1001)
  await waitFor(() => host.conns.length === 2 && g.status(id) === 'connected', 3000, 'redial')
  check(g.dials[n] === `127.0.0.1:${host.port}`, 'the remembered endpoint is dialed first')
  g.guest.dispose()

  // An HTTP server that is not a share listener: retried, never connected.
  const plain = http.createServer((req, res) => { res.writeHead(404); res.end() })
  await new Promise(r => plain.listen(0, '127.0.0.1', r))
  const fake = { key: S.generateShareKeyPair(), shareId: S.randomB64u(16), inviteKey: crypto.randomBytes(16), port: plain.address().port }
  const p = makeGuest()
  const pid = p.guest.join(inviteFor(fake)).link.id
  await waitFor(() => p.status(pid) === 'reconnecting', 2000, 'plain http')
  check(p.guest.view(pid).reason === undefined, 'a 404 upgrade is a failed attempt, retried with backoff')
  p.guest.dispose()
  await new Promise(r => plain.close(r))

  // Mismatch on one endpoint, the right host on the next: connected.
  const impostor = await new FakeHost().listen()
  const m = makeGuest()
  const mid = await joined(host, m, { endpoints: [{ a: '127.0.0.1', p: impostor.port, t: 'loop' }, { a: '127.0.0.1', p: host.port, t: 'loop' }] })
  check(m.status(mid) === 'connected' && m.dials.length === 2, 'another key on the first endpoint does not stop the round')
  m.guest.dispose()
  await impostor.stop()
  await host.stop()
}

async function testMismatch() {
  // The invite pins a key the server does not hold: it cannot open hs1 and closes 4400.
  const host = await new FakeHost().listen()
  const g = makeGuest()
  const id = await joined(host, g, { pk: S.generateShareKeyPair().pub, expect: 'ended' })
  await sleep(300)
  check(g.guest.view(id).reason === 'identity_mismatch' && host.conns.length === 1, 'a host with another key ends the link (identity_mismatch), no reconnect')
  g.guest.dispose()
  await host.stop()

  // A man in the middle that answers hs2 but cannot seal `ready` under the pinned key.
  const mitm = await new FakeHost({
    onHs: (c, r, ws) => {
      ws.send(JSON.stringify({ t: 'hs2', sv: 1, e: S.toB64u(S.generateShareKeyPair().pub) }))
      ws.send(crypto.randomBytes(40))
    },
  }).listen()
  const g2 = makeGuest()
  const id2 = await joined(mitm, g2, { expect: 'ended' })
  check(g2.guest.view(id2).reason === 'identity_mismatch', 'a ready that does not authenticate is identity_mismatch')
  g2.guest.dispose()
  await mitm.stop()

  // Version: no overlap -> ended version with the host range.
  const v = await new FakeHost({ minVersion: 3, maxVersion: 4 }).listen()
  const g3 = makeGuest()
  const id3 = await joined(v, g3, { expect: 'ended' })
  await sleep(250)
  const view = g3.guest.view(id3)
  check(view.reason === 'version' && view.version.min === 3 && view.version.max === 4 && view.version.app === '9.9.9' && v.conns.length === 1, 'no common version ends the link with the host range, no reconnect')
  g3.guest.dispose()
  await v.stop()
}

async function testStrictHostFrames() {
  const bad = [
    ['fit with cols 5000', c => ({ t: 'fit', paneId: 'p1', cols: 5000, rows: 30 })],
    ['replay with rows 0', c => ({ t: 'replay', paneId: 'p1', running: true, cols: 80, rows: 0, data: '', first: true, last: true })],
    ['a state with 65 panes', c => ({ t: 'state', state: makeState('type', { panes: Array.from({ length: 65 }, (_, i) => ({ id: 'p' + i, title: 't', type: 'shell', color: '#fff', icon: 'x', running: true })) }) })],
    ['a title with a bidi override', c => ({ t: 'state', state: makeState('type', { title: 'abc\u202e' }) })],
    ['an extra key', c => ({ t: 'out', paneId: 'p1', data: 'x', extra: 1 })],
    ['an oversized out', c => ({ t: 'out', paneId: 'p1', data: 'x'.repeat(16385) })],
    ['a second welcome', c => null],
  ]
  for (const [label, make] of bad) {
    const host = await new FakeHost().listen()
    const g = makeGuest()
    const id = await joined(host, g)
    const c = host.last()
    const msg = make(c)
    if (msg) host.send(c, msg)
    else host.welcome(c)
    await waitFor(() => g.status(id) === 'ended', 2000, `ended on ${label}`)
    await sleep(150)
    check(g.guest.view(id).reason === 'protocol' && host.conns.length === 1, `${label}: the link ends (protocol), no reconnect`)
    g.guest.dispose()
    await host.stop()
  }
  // A text frame after the handshake, and a record that does not authenticate.
  for (const [label, act] of [['a text frame', c => c.ws.send('{"t":"out"}')], ['a forged record', c => c.ws.send(crypto.randomBytes(64))]]) {
    const host = await new FakeHost().listen()
    const g = makeGuest()
    const id = await joined(host, g)
    act(host.last())
    await waitFor(() => g.status(id) === 'ended', 2000, label)
    check(g.guest.view(id).reason === 'protocol', `${label} ends the link (protocol)`)
    g.guest.dispose()
    await host.stop()
  }
  // Data frames before the welcome are a violation.
  const host = await new FakeHost({ mode: 'pending' }).listen()
  const g = makeGuest()
  const id = await joined(host, g, { expect: 'waiting_approval' })
  host.send(host.last(), { t: 'out', paneId: 'p1', data: 'early' })
  await waitFor(() => g.status(id) === 'ended', 2000, 'early data')
  check(g.guest.view(id).reason === 'protocol' && !g.items().length, 'terminal data before the welcome is a violation and never reaches the renderer')
  g.guest.dispose()
  await host.stop()
}

// --- 8. Against the real ShareServer (S1) ------------------------------------------------

/**
 * The real host from src/main/share (S1): ShareHost over the real
 * ShareServer and GrantStore, with a fake pty and snapshot. Returns null
 * (and the cases are skipped) while those files do not exist or do not
 * bundle. The adapter gives { port, invite(), approve(perm), stop(), start() };
 * stop + start is a host restart (same keys and grants, tickets lost).
 */
async function loadRealHost() {
  const need = ['ShareServer.ts', 'ShareHost.ts', 'GrantStore.ts'].map(f => path.join(root, 'src/main/share', f))
  if (!need.every(f => fs.existsSync(f))) return null
  let R
  try {
    R = await bundle(`
export { ShareServer } from './src/main/share/ShareServer'
export { ShareHost } from './src/main/share/ShareHost'
export { GrantStore } from './src/main/share/GrantStore'
export { FileService } from './src/main/files/FileService'
export { WsNoteStore } from './src/main/notes/WsNoteStore'
export { runNotesRequest } from './src/main/remote/RemoteManager'
`)
  } catch (err) {
    console.log(`  (real host does not bundle yet: ${String(err.message).split('\n')[0]})`)
    return null
  }
  if (typeof R.ShareHost !== 'function' || typeof R.ShareServer !== 'function' || typeof R.GrantStore !== 'function') return null
  return async ({ dataDir }) => {
    fs.mkdirSync(dataDir, { recursive: true })
    const vault = fakeVault(true)
    const hostKey = S.generateShareKeyPair()
    const probe = http.createServer()
    await new Promise(r => probe.listen(0, '127.0.0.1', r))
    const port = probe.address().port
    await new Promise(r => probe.close(r))
    const approvals = []
    const writes = []
    // The real backends of index.ts on a temp workspace folder: FileService (guest half) and the notes store.
    const folder = path.join(dataDir, 'repo')
    fs.mkdirSync(path.join(folder, '.git'), { recursive: true })
    fs.mkdirSync(path.join(folder, 'src'), { recursive: true })
    fs.writeFileSync(path.join(folder, '.git', 'config'), '[remote] url = https://token@example.invalid')
    fs.writeFileSync(path.join(folder, '.env'), 'TOKEN=secret')
    fs.writeFileSync(path.join(folder, 'README.md'), '# Proyecto')
    fs.writeFileSync(path.join(folder, 'src', 'a.ts'), 'const a = 1')
    fs.writeFileSync(path.join(folder, 'big.log'), 'x'.repeat(300 * 1024))
    const files = new R.FileService({ config: () => ({ workspaces: [{ id: 'w1', name: 'Proyecto', cwd: folder, panes: [] }] }), emit: () => {}, trash: async () => {}, reveal: () => {}, openPath: async () => '' })
    let notesHost = null
    const notesRoot = path.join(dataDir, 'notes')
    const wsNotes = new R.WsNoteStore({ root: () => notesRoot, emit: evt => notesHost?.notesChanged(evt) })
    const snapshot = {
      workspaces: [{ id: 'w1', name: 'Proyecto', layoutOrder: ['p1'], panes: [{ id: 'p1', title: 'PowerShell', type: 'shell', color: '#888888', icon: 'terminal', running: true }] }],
      activeWorkspaceId: 'w1', themeTokens: {}, language: 'en', fontFamily: 'Consolas', fontSize: 14,
    }
    const pty = {
      getReplay: id => (id === 'p1' ? { ptyId: 'pt1', replay: 'PS> ', cols: 120, rows: 30 } : null),
      getExited: () => null,
      setForcedFast() {},
      ptyIdForPane: id => (id === 'p1' ? 'pt1' : null),
      write: (_ptyId, data) => writes.push(data),
    }
    let host = null
    let grantId = null
    const grantStore = () => {
      const gs = new R.GrantStore(path.join(dataDir, 'share-grants.json'), vault)
      gs.load()
      return gs
    }
    const make = () => new R.ShareHost({
      pty,
      remote: { snapshot: () => snapshot, relayAction: async () => ({ id: 'x', ok: false }) },
      grants: grantStore(),
      hostKey: () => hostKey,
      listen: (p, onT) => new R.ShareServer(p, onT),
      endpoints: () => [],
      appVersion: '2.4.0',
      platform: 'win32',
      hostLabel: () => 'Real Host',
      guestLabel: n => `${n} (guest)`,
      guestFallback: () => 'Guest',
      onApproval: a => approvals.push(a),
      allowLoopback: true,
      notes: () => req => R.runNotesRequest(wsNotes, req),
      files: () => ({
        list: (ws, rel, max) => files.guestList(ws, rel, max),
        read: (ws, rel, limits) => files.guestRead(ws, rel, limits),
        acquireWatch: (ws, owner, cb) => files.acquireWatch(ws, owner, cb),
        releaseWatch: (ws, owner) => files.releaseWatch(ws, owner),
      }),
    })
    const start = async () => {
      host = make()
      notesHost = host
      host.applyConfig({ enabled: true, port })
      if (!grantId) {
        const created = await host.create({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full', rights: S.shareDefaultRights('full') })
        if (!created.ok) throw new Error(`real host create: ${created.error}`)
        grantId = created.grant.id
      }
      await waitFor(() => host.hostState().listening === 'running', 3000, 'real listener')
    }
    await start()
    return {
      port,
      writes,
      invite: () => {
        const r = host.invite(grantId)
        if (!r.ok) throw new Error(`real host invite: ${r.error}`)
        return r.invite
      },
      approve: perm => {
        const a = approvals.shift()
        if (a) host.resolve({ requestId: a.requestId, allow: true, ...(perm ? { perm } : {}) })
        return !!a
      },
      pendingApprovals: () => approvals.length,
      folder,
      notesRoot,
      watched: () => files.watchedCount,
      state: () => host.hostState(),
      stop: async () => { host?.shutdown(); host = null; await sleep(50) },
      start,
    }
  }
}

function rawUpgrade(port, headers, reqPath = '/share') {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers } })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101) })
    req.on('response', res => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve('error'))
    req.setTimeout(2000, () => { req.destroy(); resolve('timeout') })
    req.end()
  })
}

async function testRealHost() {
  const factory = await loadRealHost()
  if (!factory) {
    skipped += 6
    console.log('SKIP: real ShareServer cases (browser upgrades, join flows, restart, fallback, mismatch): host core S1 not ready')
    return
  }
  const host = await factory({ dataDir: path.join(tmp, 'realhost') })
  try {
    // Browser-style upgrades.
    const good = { 'x-snaos-share': '1', 'Sec-WebSocket-Protocol': 'snaos-share.1', Host: `127.0.0.1:${host.port}` }
    check((await rawUpgrade(host.port, good)) === 101, 'real: a well-formed share upgrade is accepted')
    check((await rawUpgrade(host.port, { ...good, Origin: 'http://evil.example' })) !== 101, 'real: an upgrade with an Origin is refused')
    const noHeader = { ...good }
    delete noHeader['x-snaos-share']
    check((await rawUpgrade(host.port, noHeader)) !== 101, 'real: an upgrade without the custom header is refused')
    const noProto = { ...good }
    delete noProto['Sec-WebSocket-Protocol']
    check((await rawUpgrade(host.port, noProto)) !== 101, 'real: an upgrade without the subprotocol is refused')
    check((await rawUpgrade(host.port, { ...good, Host: 'evil.example' })) !== 101, 'real: a Host that is not our IP literal is refused (DNS rebinding)')
    check((await rawUpgrade(host.port, { ...good, Host: `127.0.0.1:${host.port + 1}` })) !== 101, 'real: a Host with another port is refused')
    check((await rawUpgrade(host.port, { ...good, 'Sec-Fetch-Mode': 'websocket' })) !== 101, 'real: sec-fetch headers are refused')
    check((await rawUpgrade(host.port, good, '/other')) !== 101 && (await rawUpgrade(host.port, good, '/share?x=1')) !== 101, 'real: another path or a query string is refused')
    const plain = await new Promise(resolve => http.get({ host: '127.0.0.1', port: host.port, path: '/' }, res => { res.resume(); resolve(res.statusCode) }).on('error', () => resolve('error')))
    check(plain === 404, 'real: a plain GET gets 404')

    // Full join flow: approval at a lower perm, the replay, a typed write.
    const g = makeGuest()
    const res = g.guest.join(host.invite())
    check(res.ok, 'real: the invite joins')
    const id = res.link.id
    await waitFor(() => g.status(id) === 'waiting_approval' && host.pendingApprovals() > 0, 5000, 'real pending')
    check(host.approve('type'), 'real: the host raised an approval request')
    await waitFor(() => g.status(id) === 'connected', 5000, 'real welcome')
    check(g.guest.view(id).perm === 'type' && g.guest.view(id).host.label === 'Real Host', 'real: admitted at the perm the host chose')
    g.guest.sub({ linkId: id, paneId: 'p1' })
    await waitFor(() => g.items().some(i => i.t === 'replay' && i.last), 5000, 'real replay')
    check(g.items().filter(i => i.t === 'replay').map(i => i.data).join('') === 'PS> ', 'real: the replay of the shared console arrives')
    g.guest.input({ linkId: id, paneId: 'p1', data: 'echo hi' })
    g.guest.input({ linkId: id, paneId: 'p1', data: '\r' })
    await waitFor(() => host.writes.includes('echo hi'), 5000, 'real write')
    await sleep(100)
    check(!host.writes.some(w => w.includes('\r')), 'real: typed text reaches the pty, Enter never does in type')

    // app 2.6.0 over real sockets: notes write and files with the Full defaults, apart from the type perm.
    const st = g.linkEvents().filter(e => e.t === 'state' && e.linkId === id).pop()?.state
    check(st && st.caps.notesWrite === true && st.caps.files === true, 'real: a v2 guest admitted as type still gets the notes write and files rights')
    const made = await g.guest.notes({ linkId: id, op: 'create', text: '# Desde el guest' })
    const nid = made.reply?.note?.id
    check(made.ok && made.reply.ok && nid && fs.readFileSync(path.join(host.notesRoot, 'w1', nid + '.md'), 'utf8') === '# Desde el guest', 'real: a note the guest creates is a file of the shared workspace on the host')
    const rd = await g.guest.notes({ linkId: id, op: 'read', noteId: nid })
    const before = g.linkEvents().length
    const rw = await g.guest.notes({ linkId: id, op: 'write', noteId: nid, text: 'hola', baseRev: rd.reply.note.rev })
    check(rw.ok && rw.reply.ok && fs.readFileSync(path.join(host.notesRoot, 'w1', nid + '.md'), 'utf8') === 'hola', 'real: a guest write with the rev it read lands on disk')
    await waitFor(() => g.linkEvents().slice(before).some(e => e.t === 'notesChanged' && e.noteId === nid && e.rev === rw.reply.note.rev), 3000, 'real notesChanged with rev')
    check(true, 'real: the change comes back with its rev (the guest skips its own echo)')
    const stale = await g.guest.notes({ linkId: id, op: 'write', noteId: nid, text: 'pisada', baseRev: rd.reply.note.rev })
    check(stale.ok && !stale.reply.ok && stale.reply.error === 'conflict' && stale.reply.current.text === 'hola', 'real: an old rev is a conflict with the note as it is now')
    const rl = await g.guest.files({ linkId: id, op: 'list', rel: '' })
    const names = rl.reply?.entries?.map(e => e.name) ?? []
    check(rl.ok && names.includes('README.md') && names.includes('src') && !names.includes('.git') && !names.includes('.env'), 'real: the shared folder lists without .git nor .env')
    check((await g.guest.files({ linkId: id, op: 'read', rel: '.env' })).reply?.error === 'not_found' && (await g.guest.files({ linkId: id, op: 'read', rel: '.git/config' })).error === 'invalid', 'real: .env is not_found and .git never leaves main')
    const big = await g.guest.files({ linkId: id, op: 'read', rel: 'big.log' })
    check(big.ok && big.reply.file.partial === true && big.reply.file.text.length === 256 * 1024, 'real: a long file arrives cut at 256 KB, partial')
    g.guest.filesWatch({ linkId: id, on: true })
    await waitFor(() => host.watched() === 1, 3000, 'real watch')
    const before2 = g.linkEvents().length
    fs.writeFileSync(path.join(host.folder, 'src', 'b.ts'), 'export {}')
    await waitFor(() => g.linkEvents().slice(before2).some(e => e.t === 'filesChanged' && (e.all || e.dirs.includes('src'))), 5000, 'real filesChanged')
    check(true, 'real: a file written on the host reaches the guest as filesChanged while the drawer is open')
    g.guest.filesWatch({ linkId: id, on: false })
    await waitFor(() => host.watched() === 0, 3000, 'real unwatch')
    check(true, 'real: closing the drawer releases the folder watch')
    // An app 2.5 guest (protocol v1) on the same share: v1 caps only, the link stays healthy.
    const old = makeGuest({ protocolMax: 1 })
    const oid = old.guest.join(host.invite()).link.id
    await waitFor(() => old.status(oid) === 'waiting_approval' && host.pendingApprovals() > 0, 5000, 'real v1 pending')
    host.approve()
    await waitFor(() => old.status(oid) === 'connected', 5000, 'real v1 welcome')
    const ost = old.linkEvents().filter(e => e.t === 'state').pop().state
    check(!('files' in ost.caps) && !('notesWrite' in ost.caps) && ost.caps.notes, 'real: a v1 guest gets the v1 caps only')
    check((await old.guest.notes({ linkId: oid, op: 'write', noteId: 'n1', text: 'x' })).error === 'denied' && (await old.guest.notes({ linkId: oid, op: 'list' })).ok, 'real: a v1 guest reads notes, never writes them')
    check(host.state().grants[0].sessions.filter(x => x.legacy).length === 1, 'real: the host marks it legacy')
    old.guest.dispose()

    // Reconnect after a server restart: tickets are gone, a new approval admits it.
    await host.stop()
    await waitFor(() => g.status(id) === 'reconnecting', 5000, 'real host gone')
    await host.start()
    await waitFor(() => g.status(id) === 'waiting_approval' && host.pendingApprovals() > 0, 10_000, 'real restart asks again')
    host.approve('view')
    await waitFor(() => g.status(id) === 'connected', 5000, 'real re-welcome')
    check(g.guest.view(id).perm === 'view', 'real: after a server restart the guest reconnects on its own and needs a new approval')
    g.guest.dispose()

    // Endpoint fallback: a dead first endpoint.
    const inv = S.parseShareInvite(host.invite(), { allowLoopback: true }).invite
    const dead = http.createServer()
    await new Promise(r => dead.listen(0, '127.0.0.1', r))
    const deadPort = dead.address().port
    await new Promise(r => dead.close(r))
    const f = makeGuest()
    const fid = f.guest.join(S.encodeShareInvite({ ...inv, e: [{ a: '127.0.0.1', p: deadPort, t: 'loop' }, ...inv.e] }, { allowLoopback: true })).link.id
    await waitFor(() => f.status(fid) === 'waiting_approval', 6000, 'real fallback')
    check(f.dials[0] === `127.0.0.1:${deadPort}` && f.dials[1] === `127.0.0.1:${host.port}`, 'real: a dead first endpoint falls back to the next')
    f.guest.dispose()

    // Identity mismatch: the invite pins another key.
    const mm = makeGuest()
    const mid = mm.guest.join(S.encodeShareInvite({ ...inv, pk: S.toB64u(S.generateShareKeyPair().pub) }, { allowLoopback: true })).link.id
    await waitFor(() => mm.status(mid) === 'ended', 5000, 'real mismatch')
    check(mm.guest.view(mid).reason === 'identity_mismatch', 'real: a host with another key is identity_mismatch, no reconnect')
    mm.guest.dispose()

    // A wrong invite key: bad_invite, no reconnect.
    const bk = makeGuest()
    const bid = bk.guest.join(S.encodeShareInvite({ ...inv, k: S.randomB64u(16) }, { allowLoopback: true })).link.id
    await waitFor(() => bk.status(bid) === 'ended', 5000, 'real bad invite')
    check(bk.guest.view(bid).reason === 'bad_invite', 'real: a wrong invite key ends the link (bad_invite)')
    bk.guest.dispose()
  } finally {
    await host.stop()
  }
}

async function main() {
  S = await bundle(`
export * from './src/shared/share-protocol'
export * from './src/shared/share-protocol-schemas'
export * from './src/shared/shareInput'
export * from './src/shared/shareRights'
export * from './src/shared/share-guest'
export { CH } from './src/shared/ipc-channels'
export * from './src/main/share/crypto'
export * from './src/main/share/invite'
export * from './src/main/share/identity'
export * from './src/main/share/guest/LinkStore'
export * from './src/main/share/guest/ShareClient'
export * from './src/main/share/guest/ShareGuest'
`)
  const origWarn = console.warn
  console.warn = () => {}
  try {
    testUnits()
    await testJoin()
    await testStream()
    await testInput()
    await testRequests()
    await testApproval()
    await testCloseCodes()
    await testReconnect()
    await testEndpoints()
    await testMismatch()
    await testStrictHostFrames()
    await testRealHost()
  } finally {
    console.warn = origWarn
  }
  console.log(`PASS: ${checks} checks${skipped ? ` (${skipped} real-host groups skipped)` : ''}`)
}

main()
  .catch(err => {
    console.error('FAIL:', err && err.stack ? err.stack : err)
    process.exitCode = 1
  })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref()
  })
