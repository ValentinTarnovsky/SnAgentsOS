// Share (app 2.4.0, item 8) stage S0: the invite string, the "type without
// send" gate (stateful: split frames, the Esc window, pastes as one unit),
// the secure channel handshake and records, the share frame schemas, the
// static identities over a fake DPAPI, and PtyManager.setForcedFast with two
// owners. Stage S1 (host core): GrantStore over a fake DPAPI (concurrent
// persistence), the browser-proof upgrade rules, HostSessions (invite proof,
// lockout, approval with its DoS limits, password, tickets bound to the
// guest key and its effective perm), ShareHost scope and filtered state, the
// data plane (ordering, chunking, backpressure), pause, expiry, revoke, live
// perm changes, the owner and guest leases, the ctl allowlist, read-only
// chat/git/notes, the status relay, the firewall rule names and the
// RemoteManager additions. Stage S5 (workspace extras): a live perm drop ends
// the chats and every extra, pause stops them, a refused or malformed relay
// adds nothing to the scope, and an acked pane no snapshot lists leaves it
// after its grace. A fake PtyManager, in-memory transports and a fake
// clock. esbuild + vm like test-remote.cjs; nothing listens.
const { build, buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-share-'))
const alias = { '@shared': path.join(root, 'src/shared') }
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
    b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(tmp)} }` }))
  },
}

let shareCode = ''
async function bundleShare() {
  const contents = `
export * from './src/shared/share-protocol'
export * from './src/shared/share-protocol-schemas'
export * from './src/shared/shareInput'
export * from './src/main/share/crypto'
export * from './src/main/share/identity'
export * from './src/main/share/invite'
export * from './src/main/share/transport'
export * from './src/main/share/GrantStore'
export * from './src/main/share/HostSessions'
export * from './src/main/share/PaneFanout'
export * from './src/main/share/InputArbiter'
export * from './src/main/share/StatusCoalescer'
export * from './src/main/share/ShareHost'
export { checkShareUpgrade } from './src/main/share/ShareServer'
export { buildFixScript, FW_RULES_SHARE, FW_RULES_REMOTE } from './src/main/remote/firewall'
export { sanitizeDeviceName } from './src/main/remote/PairingService'
`
  shareCode = (await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'], alias, plugins: [stubs] })).outputFiles[0].text
}

function loadShare(env = {}) {
  const code = shareCode
  const mod = { exports: {} }
  const proc = { ...process, env: { ...env } }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, process: proc, console: { ...console, warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    require: id => (id === 'electron' ? { safeStorage: {}, app: { getPath: () => tmp } } : id === 'qrcode' ? { toDataURL: async () => 'data:' } : require(id)) })
  return mod.exports
}

let S = null

// --- 1. Invite ---------------------------------------------------------------
function testInvite() {
  const host = S.generateShareKeyPair()
  const base = {
    v: 1, h: 'Valen PC', pk: S.toB64u(host.pub), s: S.randomB64u(16), k: S.randomB64u(16),
    e: [{ a: '100.101.102.103', p: 4527, t: 'ts' }, { a: '192.168.1.5', p: 4527, t: 'lan' }],
    sc: { k: 'pane', l: 'PowerShell' }, pm: 'type', x: 1_900_000_000_000,
  }
  const text = S.encodeShareInvite(base)
  check(text.startsWith('snaos-share:1:') && text.length < 600, 'invite has the prefix and stays short')
  const back = S.parseShareInvite(`  ${text}\n`, { allowLoopback: false })
  check(back.ok && JSON.stringify(back.invite) === JSON.stringify(base), 'invite round trip (surrounding whitespace ignored)')

  const enc = obj => 'snaos-share:1:' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
  const err = (obj, opts = { allowLoopback: false }) => { const r = S.parseShareInvite(typeof obj === 'string' ? obj : enc(obj), opts); return r.ok ? 'ok' : r.error }
  check(err({ ...base, e: [{ a: '8.8.8.8', p: 4527, t: 'lan' }] }) === 'endpoint', 'a public IP is refused')
  check(err({ ...base, e: [{ a: '010.0.0.1', p: 4527, t: 'lan' }] }) === 'endpoint', 'leading zeros (octal to a URL parser) are refused')
  check(err({ ...base, e: [{ a: 'host.example', p: 4527, t: 'lan' }] }) === 'endpoint', 'a host name is refused (no DNS)')
  check(err({ ...base, e: [{ a: '192.168.1.5', p: 4527, t: 'ts' }] }) === 'endpoint', 'the endpoint kind must match its address class')
  check(err({ ...base, e: [{ a: '192.168.1.5', p: 80, t: 'lan' }] }) === 'endpoint', 'a port under 1024 is refused')
  check(err({ ...base, e: [] }) === 'endpoint', 'an invite needs an endpoint')
  check(err({ ...base, e: Array.from({ length: 7 }, (_, i) => ({ a: `10.0.0.${i + 1}`, p: 4527, t: 'lan' })) }) === 'endpoint', 'at most 6 endpoints')
  check(err({ ...base, pk: base.pk.slice(0, 42) }) === 'bad_key', 'a short host key is refused')
  check(err({ ...base, pk: 'A'.repeat(43) }) === 'bad_key', 'the all-zero host key is refused')
  check(err({ ...base, pk: base.pk.slice(0, 42) + 'B' }) === 'bad_key', 'a non-canonical base64url key (stray low bits) is refused')
  check(err({ ...base, k: 'short' }) === 'bad_key', 'a bad invite key is refused')
  check(err('snaos-share:1:' + 'A'.repeat(3000)) === 'too_long', 'an oversized invite is refused')
  check(err({ ...base, extra: 1 }) === 'format', 'an unknown key is refused (strict)')
  check(err({ ...base, v: 2 }) === 'version' && err('snaos-share:2:' + enc(base).slice(14)) === 'version', 'another invite version is refused')
  check(err('hello') === 'format' && err('snaos-share:1:!!!') === 'format', 'garbage is refused')
  check(err({ ...base, h: 'evil\u202ename' }) === 'format', 'a bidi override in the host label is refused')
  const loop = { ...base, e: [{ a: '127.0.0.1', p: 4600, t: 'loop' }] }
  check(err(loop) === 'endpoint', 'loopback is refused without SNAOS_SHARE_LOOPBACK=1')
  check(err(loop, { allowLoopback: true }) === 'ok', 'loopback passes with the flag')
  const envOff = loadShare({}), envOn = loadShare({ SNAOS_SHARE_LOOPBACK: '1' })
  check(!envOff.parseShareInvite(enc(loop)).ok && envOn.parseShareInvite(enc(loop)).ok, 'the default follows the environment flag')
  check(err(base, { allowLoopback: false, ownKeys: [base.pk] }) === 'self', 'an invite to our own host key is self')
  assert.throws(() => S.encodeShareInvite({ ...base, e: [{ a: '8.8.8.8', p: 4527, t: 'lan' }] })); checks++
  const eps = S.inviteEndpoints([
    { ip: '192.168.1.5', kind: 'lan' }, { ip: '172.20.0.1', kind: 'lan', virtual: true }, { ip: '100.90.1.2', kind: 'tailscale' },
    { ip: '100.90.1.2', kind: 'tailscale' }, { ip: '44.1.2.3', kind: 'other' },
  ], 4527, true)
  check(JSON.stringify(eps.map(e => `${e.t}:${e.a}`)) === JSON.stringify(['loop:127.0.0.1', 'ts:100.90.1.2', 'lan:192.168.1.5']), 'invite endpoints: loopback (flag), Tailscale, then LAN; no virtual, no other, no duplicates')
  check(S.inviteEndpoints([{ ip: '192.168.1.5', kind: 'lan' }], 4527, false).every(e => e.t !== 'loop'), 'no loopback endpoint without the flag')
  check(S.shareText('  a\u0007b\u200bc  ', 64) === 'abc' && S.shareText('x'.repeat(5) + '\ud83d\ude00', 6) === 'xxxxx', 'shareText strips controls and never splits a surrogate pair')
}

// --- 2. The gate -------------------------------------------------------------
function testGate() {
  let now = 1000
  const gateAt = () => new S.ShareInputGate(() => now)
  const SHELL = { agent: false, lastByte: 'a' }
  const IDLE = { agent: true, state: 'idle', precise: true, lastByte: 'a' }
  const WORK = { agent: true, state: 'working', precise: true, lastByte: 'a' }
  const DONE = { agent: true, state: 'done', precise: true, lastByte: 'a' }
  const ACTION = { agent: true, state: 'action', precise: true, lastByte: 'a' }
  const TITLE = { agent: true, state: 'idle', precise: false, lastByte: 'a' }
  const NONE = { agent: true, state: null, lastByte: 'a' }
  const UNKNOWN = { agent: true, state: 'unknown', precise: true, lastByte: 'a' }
  const verdict = (data, perm = 'type', ctx = SHELL) => { const v = gateAt().check(data, perm, ctx); return v.ok ? 'ok' : v.drop ? 'drop' : v.reason }
  const table = [
    // printable text
    ['hello', 'type', SHELL, 'ok'], ['echo hi', 'type', SHELL, 'ok'], ['\u00f1and\u00fa \ud83d\ude00', 'type', SHELL, 'ok'],
    // send
    ['\r', 'type', SHELL, 'no_send'], ['\n', 'type', SHELL, 'no_send'], ['a\rb', 'type', SHELL, 'no_send'], ['\x1b\r', 'type', SHELL, 'no_send'],
    ['line1\nline2', 'type', SHELL, 'no_send'], ['\x1b[200~one\rtwo\x1b[201~', 'type', SHELL, 'no_send'],
    // interrupts
    ['\x03', 'type', SHELL, 'interrupt'], ['\x04', 'type', SHELL, 'interrupt'], ['\x1a', 'type', SHELL, 'interrupt'], ['\x1c', 'type', SHELL, 'interrupt'], ['ab\x03', 'type', SHELL, 'interrupt'],
    // blocked C0
    ['\x0f', 'type', SHELL, 'blocked_key'], ['\x07', 'type', SHELL, 'blocked_key'], ['\x18', 'type', SHELL, 'blocked_key'], ['\x16', 'type', SHELL, 'blocked_key'],
    ['\x13', 'type', SHELL, 'blocked_key'], ['\x11', 'type', SHELL, 'blocked_key'], ['\x1d', 'type', SHELL, 'blocked_key'], ['\x00', 'type', SHELL, 'blocked_key'],
    ['\x01', 'type', SHELL, 'blocked_key'], ['\x02', 'type', SHELL, 'blocked_key'], ['\x1e', 'type', SHELL, 'blocked_key'], ['\u009b', 'type', SHELL, 'blocked_key'],
    // allowed C0 (line editing, history)
    ...['\x05', '\x06', '\x08', '\x0b', '\x0c', '\x0e', '\x10', '\x12', '\x14', '\x15', '\x17', '\x19', '\x1f', '\x7f'].map(c => [c, 'type', SHELL, 'ok']),
    // Tab
    ['\t', 'type', SHELL, 'ok'], ['\t', 'type', IDLE, 'ok'], ['\t', 'type', WORK, 'agent_busy'], ['ab\t', 'type', DONE, 'agent_busy'],
    // Esc and the ESC allowlist
    ['\x1b', 'type', SHELL, 'ok'], ['\x1b\x1b', 'type', SHELL, 'ok'],
    ...['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1bOA', '\x1bOD', '\x1bOH', '\x1bOF', '\x1b[1;5C', '\x1b[1;2D',
      '\x1b[1~', '\x1b[2~', '\x1b[3~', '\x1b[4~', '\x1b[5~', '\x1b[6~', '\x1b[3;5~', '\x1b\x1b[A'].map(s => [s, 'type', SHELL, 'ok']),
    ...['\x1b[Z', '\x1b[13u', '\x1b[99;5u', '\x1b[27;5;13~', '\x1b[27;2;9~', '\x1bb', '\x1bOM', '\x1b[', '\x1bO', '\x1b[1;5', '\x1b[15~', '\x1bOP',
      '\x1b\x7f', 'ab\x1bd', '\x1b[1;9A', 'a\x1b]52;c;aGk=\x07'].map(s => [s, 'type', SHELL, 'blocked_key']),
    // a guest OSC (clipboard, title) is a report-shaped frame: never written
    ['\x1b]52;c;aGk=\x07', 'type', SHELL, 'drop'], ['\x1b]0;title\x07', 'full', SHELL, 'drop'],
    // pastes
    ['\x1b[200~some text\x1b[201~', 'type', SHELL, 'ok'], ['\x1b[200~', 'type', SHELL, 'ok'], ['tail\x1b[201~', 'type', SHELL, 'ok'],
    // reports
    ['\x1b[I', 'type', SHELL, 'drop'], ['\x1b[O', 'full', SHELL, 'drop'], ['\x1b[12;40R', 'type', SHELL, 'drop'], ['\x1b[?1;2c', 'full', SHELL, 'drop'],
    ['\x1b[<0;10;5M', 'type', SHELL, 'drop'], ['\x1b[<0;10;5M\x1b[<0;10;5m', 'full', SHELL, 'ok'], ['\x1b[<0;10;5M', 'view', SHELL, 'drop'],
    ['\x1b[I\x1b[<0;1;1M', 'full', SHELL, 'drop'], ['', 'type', SHELL, 'drop'],
    // view and full
    ['a', 'view', SHELL, 'view_only'], ['\x1b', 'view', SHELL, 'view_only'], ['\r', 'full', SHELL, 'ok'], ['\x03', 'full', ACTION, 'ok'], ['\x1b[Z', 'full', SHELL, 'ok'],
    // agents: the action block and fail closed
    ['1', 'type', ACTION, 'awaiting_host'], ['y', 'type', ACTION, 'awaiting_host'], ['\x1b[B', 'type', ACTION, 'awaiting_host'],
    ['\x1b', 'type', ACTION, 'ok'], ['\x1b\x1b', 'type', ACTION, 'ok'],
    ['1', 'type', TITLE, 'not_precise'], ['\x1b', 'type', TITLE, 'ok'], ['a', 'type', NONE, 'not_precise'], ['\x1b', 'type', NONE, 'ok'], ['a', 'type', UNKNOWN, 'not_precise'],
    ['1', 'type', IDLE, 'ok'], ['fix the bug', 'type', WORK, 'ok'],
    // the SSH escape
    ['~.', 'type', { agent: false, lastByte: '\r' }, 'ssh_escape'], ['~', 'type', { agent: false, lastByte: '\n' }, 'ssh_escape'],
    ['~', 'type', { agent: false, lastByte: '' }, 'ssh_escape'], ['~', 'type', { agent: false, lastByte: 'a' }, 'ok'], ['a~', 'type', { agent: false, lastByte: '\r' }, 'ok'],
    ['~.', 'full', { agent: false, lastByte: '\r' }, 'ok'],
  ]
  for (const [data, perm, ctx, want] of table) {
    const got = verdict(data, perm, ctx)
    check(got === want, `gate ${perm} ${JSON.stringify(data)} ${ctx.agent ? `agent:${ctx.state}${ctx.precise === false ? '/title' : ''}` : 'shell'}: want ${want}, got ${got}`)
  }

  // Split frames: a lone Esc joins the next write for 1 s.
  for (const tail of ['[13u', '[Z', 'OM', 'b', '[27;5;13~', '[99;5u', '~']) {
    const g = gateAt()
    check(g.check('\x1b', 'type', SHELL).ok, `split ${JSON.stringify(tail)}: the lone Esc passes`)
    g.commit('\x1b')
    const v = g.check(tail, 'type', SHELL)
    check(!v.ok && v.reason === 'blocked_key', `split frames: '\\x1b' then ${JSON.stringify(tail)} is gated as the joined sequence`)
  }
  {
    const g = gateAt(); g.commit('\x1b')
    check(g.check('[A', 'type', SHELL).ok, 'Esc then [A joins into an allowed arrow')
    g.commit('[A')
    check(g.check('[Z', 'type', SHELL).ok && !g.escPending, 'after a write that does not end in Esc the window is closed')
  }
  {
    const g = gateAt(); now = 5000; g.commit('\x1b')
    now = 5500
    check(!g.check('b', 'type', SHELL).ok, 'a denied follow-up 500 ms later is still joined')
    now = 6000
    check(!g.check('[13u', 'type', SHELL).ok, 'the window holds for the full second')
    now = 6001
    check(g.check('[13u', 'type', SHELL).ok, 'after 1 s the text stands alone (escape timeouts have passed)')
  }
  {
    const g = gateAt(); g.commit('abc\x1b')
    check(!g.check('b', 'type', SHELL).ok, 'text ending in Esc opens the window too')
    const g2 = gateAt(); g2.commit('\x1b'); g2.commit('\x1b')
    check(g2.check('\x1b', 'type', SHELL).ok && !g2.check('[Z', 'type', SHELL).ok, 'Esc Esc keeps the window; Shift+Tab after it is blocked')
    const g3 = gateAt(); g3.commit('\x1b')
    check(!g3.check('[Z', 'type', ACTION).ok && g3.check('\x1b', 'type', ACTION).ok, 'with the agent waiting only Esc passes, joined or not')
    const g4 = gateAt(); g4.commit('x\x1b')
    check(g4.check('[Z', 'full', SHELL).ok && !g4.check('[Z', 'type', SHELL).ok, 'the window is tracked in every perm (full then a live downgrade to type)')
    const g5 = gateAt(); g5.commit('\x1b')
    check(g5.check('\x1b[<0;1;1M', 'type', SHELL).drop === true && g5.escPending, 'a dropped report leaves the window as it was')
  }

  // Paste state and closing a cut paste.
  {
    const g = gateAt()
    g.commit('\x1b[200~part one')
    check(g.pasteOpen, 'an admitted paste start opens the paste')
    check(g.cutPaste() === '\x1b[201~' && !g.pasteOpen && g.cutPaste() === '', 'cutPaste closes it once')
    g.commit('\x1b[200~whole\x1b[201~')
    check(!g.pasteOpen, 'a complete paste leaves nothing open')
    g.commit('\x1b[200~a'); g.commit('b\x1b[201~')
    check(!g.pasteOpen, 'a paste closed by a later write is not open')
    g.commit('\x1b[200~z'); g.reset()
    check(!g.pasteOpen && !g.escPending, 'reset forgets everything')
  }
}

// --- 3. Pastes as one unit -------------------------------------------------
function testPaste() {
  const big = 'a'.repeat(20000)
  const frames = S.splitSharePaste(big, 7)
  check(frames.length === 3 && frames.every((f, i) => f.paste.id === 7 && f.paste.part === i && f.paste.last === (i === 2)) && frames.map(f => f.data).join('') === big, 'a paste splits into numbered parts with the last flagged')
  check(S.splitSharePaste('x'.repeat(65537), 1) === null && S.splitSharePaste('', 1) === null, 'a paste over 64K (or empty) does not split')
  const marker = 'x'.repeat(8190) + '\x1b[200~' + 'y'
  const parts = S.chunkShareInput(marker)
  check(parts[0].length === 8190 && parts[1].startsWith('\x1b[200~') && parts.join('') === marker, 'chunking never cuts a paste marker')
  const emoji = 'x'.repeat(8191) + '\ud83d\ude00'
  const ep = S.chunkShareInput(emoji)
  check(ep[0].length === 8191 && ep[1] === '\ud83d\ude00', 'chunking never cuts a surrogate pair')
  check(S.chunkShareInput('abc').length === 1 && S.chunkShareInput('a'.repeat(16384)).length === 2, 'chunk sizes')

  const asm = new S.SharePasteAssembler()
  let r
  for (const f of frames) r = asm.push('p1', f.data, f.paste)
  check(r.kind === 'done' && r.data === big && !asm.pending, 'the assembler joins the parts in order')
  asm.push('p1', 'a', { id: 1, part: 0, last: false })
  r = asm.push('p1', 'b', { id: 1, part: 2, last: true })
  check(r.kind === 'error' && r.reason === 'paste_incomplete', 'a gap discards the paste')
  asm.push('p1', 'a', { id: 2, part: 0, last: false })
  r = asm.push('p2', 'b', { id: 2, part: 1, last: true })
  check(r.kind === 'error' && r.reason === 'paste_incomplete', 'another pane discards the paste')
  r = asm.push('p1', 'b', { id: 3, part: 1, last: true })
  check(r.kind === 'error' && r.reason === 'paste_incomplete', 'a part without its start is incomplete')
  for (let i = 0; i < 7; i++) asm.push('p1', 'x', { id: 4, part: i, last: false })
  r = asm.push('p1', 'x', { id: 4, part: 7, last: false })
  check(r.kind === 'error' && r.reason === 'paste_too_large', 'more than 8 parts is too large')
  asm.push('p1', 'x'.repeat(8192), { id: 5, part: 0, last: false })
  check(asm.reset() && !asm.pending, 'reset drops an unfinished paste')

  // The host gates the joined paste: a newline in a middle part refuses all of it.
  const multi = 'a'.repeat(9000) + '\n' + 'b'.repeat(9000)
  const mf = S.splitSharePaste(multi, 9)
  const plainParts = mf.map(f => new S.ShareInputGate().check(f.data, 'type', { agent: false, lastByte: 'a' }).ok)
  check(plainParts.includes(true), 'gated part by part, some parts would land (the bug pastes-as-unit avoids)')
  const asm2 = new S.SharePasteAssembler()
  for (const f of mf) r = asm2.push('p1', f.data, f.paste)
  const v = new S.ShareInputGate().check(r.data, 'type', { agent: false, lastByte: 'a' })
  check(r.kind === 'done' && !v.ok && v.reason === 'no_send', 'gated whole, the multi-line paste is refused as one unit')
  const bracket = '\x1b[200~' + 'z'.repeat(12000) + '\x1b[201~'
  const bf = S.splitSharePaste(bracket, 10)
  const asm3 = new S.SharePasteAssembler()
  for (const f of bf) r = asm3.push('p1', f.data, f.paste)
  check(r.kind === 'done' && new S.ShareInputGate().check(r.data, 'type', { agent: false, lastByte: 'a' }).ok, 'a long single-line bracketed paste passes whole')
}

// --- 4. Handshake and records ---------------------------------------------
async function testHandshake() {
  const hostStatic = S.generateShareKeyPair()
  const guestStatic = S.generateShareKeyPair()
  const g = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic })
  const hs1 = g.hello()
  check(!hs1.includes(S.toB64u(guestStatic.pub)), 'hs1 never shows the guest static key in clear')
  const h = S.hostHandshake(hs1, { hostStatic, app: '2.4.0' })
  check(h.ok && h.version === 1 && h.guestStatic.equals(guestStatic.pub), 'the host opens hs1 and learns the guest static key')
  const gr = g.receive(h.reply)
  check(gr.ok, 'the guest derives the channel from hs2')
  const gc = gr.channel, hc = h.channel
  check(S.GuestHandshake.confirmReady(gc, h.ready), 'the sealed ready proves the pinned host key')
  check(gc.h.equals(hc.h) && gc.peerStatic.equals(hostStatic.pub) && hc.peerStatic.equals(guestStatic.pub), 'both ends share the binding h and know the peer static key')

  const f1 = gc.seal({ t: 'hello', n: 1 }), f2 = gc.seal('{"t":"bye"}')
  check(hc.open(f1) === '{"t":"hello","n":1}' && hc.open(f2) === '{"t":"bye"}', 'guest records open on the host in order')
  const back = hc.seal({ t: 'pong', ts: 5 })
  check(gc.open(back) === '{"t":"pong","ts":5}', 'host records open on the guest')
  check(hc.open(f1) === null && hc.failed, 'a replayed record fails and kills the channel')
  check(hc.open(gc.seal({ t: 'x' })) === null, 'a dead channel opens nothing more')

  // Tamper and reorder on a fresh pair.
  const pair = () => {
    const g2 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic })
    const h2 = S.hostHandshake(g2.hello(), { hostStatic })
    const r2 = g2.receive(h2.reply)
    S.GuestHandshake.confirmReady(r2.channel, h2.ready)
    return { gc: r2.channel, hc: h2.channel }
  }
  {
    const { gc: a, hc: b } = pair()
    const f = Buffer.from(a.seal({ t: 'input', data: 'x' }))
    f[3] ^= 0x01
    check(b.open(f) === null && b.failed, 'a flipped bit fails the tag')
  }
  {
    const { gc: a, hc: b } = pair()
    const x = a.seal('1'), y = a.seal('2')
    check(b.open(y) === null, 'a reordered (skipped) record fails')
    void x
  }
  {
    const { gc: a, hc: b } = pair()
    const f = b.seal({ t: 'ready' })
    check(b.open(f) === null, 'a host record reflected back to the host fails (direction and key)')
    void a
  }
  {
    const { hc: b } = pair()
    check(b.open(Buffer.alloc(5)) === null, 'a short record fails')
  }
  {
    const a = pair(), b = pair()
    check(b.hc.open(a.gc.seal('x')) === null, 'a record from another session fails')
  }

  // Wrong pinned key: the guest pinned a key the answering host does not hold.
  {
    const impostor = S.generateShareKeyPair()
    const g3 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic })
    const h3 = S.hostHandshake(g3.hello(), { hostStatic: impostor })
    check(!h3.ok && h3.error === 'bad_msg' && h3.close === 4400, 'an impostor host cannot open hs1 sealed to the pinned key')
    // Even an impostor that skipped hs1 checks cannot answer: build hs2 from its own ephemeral key.
    const g4 = new S.GuestHandshake({ hostStatic: impostor.pub, guestStatic })
    const real = S.hostHandshake(g4.hello(), { hostStatic: impostor })
    const g5 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic })
    g5.hello()
    const r5 = g5.receive(real.reply)
    check(r5.ok && !S.GuestHandshake.confirmReady(r5.channel, real.ready), 'a ready from a host without the pinned key fails (identity_mismatch)')
  }
  // A guest replaying someone else's static key cannot speak.
  {
    const victim = S.generateShareKeyPair(), attacker = S.generateShareKeyPair()
    const forged = { pub: victim.pub, priv: attacker.priv }
    const g6 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic: forged })
    const h6 = S.hostHandshake(g6.hello(), { hostStatic })
    check(h6.ok && h6.guestStatic.equals(victim.pub), 'the host reads the claimed static key')
    const r6 = g6.receive(h6.reply)
    const forgedHello = r6.channel.seal({ t: 'hello' })
    check(r6.ok && !S.GuestHandshake.confirmReady(r6.channel, h6.ready) && r6.channel.failed, 'without the victim private key the attacker derives other keys')
    check(h6.channel.open(forgedHello) === null, 'and its first record fails on the host (the claimed key is never trusted)')
  }
  // Version mismatch both ways.
  {
    const g7 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic, minVersion: 2, maxVersion: 3 })
    const h7 = S.hostHandshake(g7.hello(), { hostStatic, app: '2.4.0' })
    check(!h7.ok && h7.error === 'version' && h7.close === 4426, 'no common version: hsErr and close 4426')
    const r7 = g7.receive(h7.reply)
    check(!r7.ok && r7.error === 'version' && r7.min === 1 && r7.max === 1 && r7.app === '2.4.0', 'the guest reads the host range from hsErr')
    const g8 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic, minVersion: 1, maxVersion: 5 })
    const h8 = S.hostHandshake(g8.hello(), { hostStatic })
    check(h8.ok && h8.version === 1, 'a newer guest falls back to the highest common version')
    const g9 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic })
    g9.hello()
    check(g9.receive(JSON.stringify({ t: 'hs2', sv: 2, e: S.toB64u(S.generateShareKeyPair().pub) })).error === 'version', 'an hs2 outside the guest range is a version error')
  }
  // Malformed handshake frames.
  {
    check(S.hostHandshake('not json', { hostStatic }).close === 4400, 'garbage hs1 closes 4400')
    check(S.hostHandshake(JSON.stringify({ t: 'hs1', sv: 1, min: 1, e: 'A'.repeat(43), s: 'A'.repeat(64), extra: 1 }), { hostStatic }).close === 4400, 'hs1 with an extra key is malformed')
    check(S.hostHandshake(JSON.stringify({ t: 'hs1', sv: 1, min: 1, e: 'A'.repeat(43), s: 'A'.repeat(64) }), { hostStatic }).close === 4400, 'the all-zero ephemeral key is refused')
    const g10 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic })
    const hs = JSON.parse(g10.hello())
    hs.s = hs.s.slice(0, 63) + (hs.s[63] === 'A' ? 'B' : 'A')
    check(!S.hostHandshake(JSON.stringify(hs), { hostStatic }).ok, 'a tampered sealed static key is refused')
    assert.throws(() => new S.GuestHandshake({ hostStatic: Buffer.alloc(32), guestStatic })); checks++
  }

  // Over an in-memory transport, as S1/S2 will run it.
  {
    const { guest, host } = S.createMemoryTransportPair('192.168.1.9')
    const got = []
    let hostChannel = null
    host.onMessage(frame => {
      if (!hostChannel) {
        const r = S.hostHandshake(frame, { hostStatic })
        if (!r.ok) return host.close(r.close)
        hostChannel = r.channel
        host.send(r.reply); host.send(r.ready)
        return
      }
      const text = hostChannel.open(frame)
      if (text === null) return host.close(4400)
      got.push(text)
    })
    const g11 = new S.GuestHandshake({ hostStatic: hostStatic.pub, guestStatic })
    let channel = null, ready = false
    guest.onMessage(frame => {
      if (!channel) { const r = g11.receive(frame); channel = r.ok ? r.channel : null; return }
      if (!ready) { ready = S.GuestHandshake.confirmReady(channel, frame); if (ready) guest.send(channel.seal({ t: 'bye' })) }
    })
    guest.send(g11.hello())
    check(ready && got.length === 1 && got[0] === '{"t":"bye"}' && host.remoteIp === '192.168.1.9', 'handshake and a record over the memory transport')
    let closed = null
    guest.onClose(code => { closed = code })
    host.close(4412, 'kicked')
    check(closed === 4412 && guest.closed && host.closed, 'a close reaches both ends')
  }

  // Proofs and the password key.
  {
    const key = Buffer.from(S.randomB64u(16), 'base64url')
    const p = S.shareProof(key, 'join', hc.h)
    check(p.length === 43 && S.verifyShareProof(key, 'join', hc.h, p), 'the invite proof verifies')
    check(!S.verifyShareProof(key, 'pw', hc.h, p), 'a proof under another label fails')
    check(!S.verifyShareProof(key, 'join', Buffer.alloc(32), p), 'a proof bound to another channel fails (no relay of proofs)')
    check(!S.verifyShareProof(Buffer.alloc(16), 'join', hc.h, p) && !S.verifyShareProof(key, 'join', hc.h, 'x') && !S.verifyShareProof(key, 'join', hc.h, 5), 'wrong key or malformed proof fails')
    check(S.sameToken('abc', 'abc') && !S.sameToken('abc', 'abd') && !S.sameToken('abc', 'ab') && !S.sameToken('abc', null), 'tickets compare in constant time')
    const salt = S.newPasswordSalt()
    const k1 = await S.derivePasswordKey('correct horse', salt)
    const k2 = await S.derivePasswordKey('correct horse'.normalize('NFD'), salt)
    const k3 = await S.derivePasswordKey('correct horse', S.newPasswordSalt())
    check(k1.length === 32 && k1.equals(k2) && !k1.equals(k3), 'scrypt password key: 32 bytes, NFC-normalized, salted')
    check(S.fromB64u('AAAA', 3) !== null && S.fromB64u('AAA=', 2) === null && S.fromB64u('AAAB', 3) !== null && S.fromB64u('AAAA', 4) === null, 'strict base64url decode')
    check(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(S.keyFingerprint(guestStatic.pub)) && S.keyFingerprint(guestStatic.pub) !== S.keyFingerprint(hostStatic.pub), 'key fingerprints')
  }
}

// --- 5. Schemas --------------------------------------------------------------
function testSchemas() {
  const C = raw => S.parseShareClientMsg(typeof raw === 'string' ? raw : JSON.stringify(raw))
  const H = raw => S.parseShareHostMsg(typeof raw === 'string' ? raw : JSON.stringify(raw))
  const b43 = 'A'.repeat(42) + 'Q', b22 = 'A'.repeat(21) + 'g'
  check(C({ t: 'hello', sid: b22, guestName: 'Ana', app: '2.4.0', proof: b43 }).ok, 'hello parses')
  check(!C({ t: 'hello', sid: b22, guestName: 'Ana', app: '2.4.0', proof: b43, guestId: 'x' }).ok, 'an unknown key in hello is malformed (strict)')
  check(C({ t: 'input', paneId: 'p-1', data: 'x'.repeat(8192), seq: 1 }).ok && !C({ t: 'input', paneId: 'p-1', data: 'x'.repeat(8193), seq: 1 }).ok, 'input data is at most 8192')
  check(C({ t: 'input', paneId: 'p-1', data: 'x', seq: 2, paste: { id: 1, part: 7, last: true } }).ok && !C({ t: 'input', paneId: 'p-1', data: 'x', seq: 2, paste: { id: 1, part: 8, last: true } }).ok, 'paste parts are 0..7')
  check(!C({ t: 'input', paneId: 'p\n1', data: 'x', seq: 1 }).ok && !C({ t: 'input', paneId: 'p', data: '', seq: 1 }).ok, 'ids are one line and input is not empty')
  check(C({ t: 'ctl', id: 'r1', op: 'createPane', presetId: 'pre-1' }).ok && C({ t: 'ctl', id: 'r1', op: 'closePane', paneId: 'p-1' }).ok, 'ctl createPane and closePane parse')
  check(!C({ t: 'ctl', id: 'r1', op: 'closePane' }).ok && !C({ t: 'ctl', id: 'r1', op: 'createPane', prompt: 'rm -rf' }).ok && !C({ t: 'ctl', id: 'r1', op: 'createPane', cwd: 'C:/' }).ok, 'ctl never takes prompt or cwd, closePane needs its pane')
  check(!C({ t: 'ctl', id: 'r1', op: 'restartPane', paneId: 'p' }).ok, 'other ctl ops do not exist')
  check(C({ t: 'notesReq', id: 'n1', op: 'read', noteId: 'abc' }).ok && !C({ t: 'notesReq', id: 'n1', op: 'write', noteId: 'abc' }).ok, 'notes are read-only')
  check(!C({ t: 'gitReq', id: 'g1', op: 'diff', path: '../secret' }).ok && C({ t: 'gitReq', id: 'g1', op: 'diff', path: 'src/a.ts' }).ok, 'git paths stay relative')
  const unk = C({ t: 'futureThing', x: 1 })
  check(!unk.ok && unk.unknown, 'a well-formed unknown type is reported as unknown (err unsupported, no strike)')
  check(!C('{bad').unknown && !C({ x: 1 }).unknown && !C('x'.repeat(70000)).ok, 'garbage, no type and oversized frames are malformed')

  const pane = { id: 'p-1', title: 'PowerShell', type: 'shell', color: '#fff', icon: 'terminal', running: true }
  const state = { scope: { kind: 'pane', label: 'PowerShell' }, perm: 'type', title: 'Work', layoutOrder: ['p-1'], panes: [pane], terminalUnicode11: true, hostPlatform: 'win32', caps: { createPane: false, closePane: false, chat: false, notes: false, git: false } }
  check(H({ t: 'state', state }).ok, 'state parses')
  check(!H({ t: 'state', state: { ...state, panes: Array.from({ length: 65 }, (_, i) => ({ ...pane, id: `p${i}` })) } }).ok, 'at most 64 panes')
  check(!H({ t: 'state', state: { ...state, title: 'x'.repeat(129) } }).ok && !H({ t: 'state', state: { ...state, title: 'a\x1b]0;b' } }).ok, 'titles are bounded and free of controls')
  check(H({ t: 'fit', paneId: 'p-1', cols: 2, rows: 1 }).ok && H({ t: 'fit', paneId: 'p-1', cols: 1000, rows: 500 }).ok, 'fit at the bounds')
  check(!H({ t: 'fit', paneId: 'p-1', cols: 1001, rows: 40 }).ok && !H({ t: 'fit', paneId: 'p-1', cols: 1, rows: 40 }).ok && !H({ t: 'fit', paneId: 'p-1', cols: 80, rows: 501 }).ok && !H({ t: 'fit', paneId: 'p-1', cols: 80, rows: 0 }).ok, 'cols 2..1000, rows 1..500')
  check(!H({ t: 'replay', paneId: 'p-1', running: true, cols: 65535, rows: 65535, data: '', first: true, last: true }).ok, 'a hostile replay size is refused')
  check(H({ t: 'out', paneId: 'p-1', data: 'x'.repeat(16384) }).ok && !H({ t: 'out', paneId: 'p-1', data: 'x'.repeat(16385) }).ok, 'out chunks are at most 16K')
  check(H({ t: 'replay', paneId: 'p-1', running: true, cols: 120, rows: 40, data: 'x'.repeat(16384), first: true, last: false }).ok && !H({ t: 'replay', paneId: 'p-1', running: true, cols: 120, rows: 40, data: 'x'.repeat(16385), first: true, last: false }).ok, 'replay chunks are at most 16K')
  check(H({ t: 'paneStatus', paneId: 'p-1', status: { state: 'working', provider: 'codex', stateSince: 5 } }).ok && !H({ t: 'paneStatus', paneId: 'p-1', status: { state: 'working', stateSince: 5, pending: [] } }).ok, 'pane status never carries pending')
  check(H({ t: 'inputDenied', paneId: 'p-1', seq: 3, reason: 'no_send' }).ok && !H({ t: 'inputDenied', paneId: 'p-1', seq: 3, reason: 'nope' }).ok, 'deny reasons are a closed set')
  const welcome = { t: 'welcome', session: { id: 's1' }, grant: { scope: { kind: 'pane', label: 'PowerShell' } }, perm: 'type', host: { label: 'Valen PC', platform: 'win32', app: '2.4.0' }, ticket: b43, state, limits: { inputMax: 8192 } }
  check(H(welcome).ok && !H({ ...welcome, limits: { inputMax: 9000 } }).ok, 'welcome parses with bounded limits')
  check(H({ t: 'chatPage', paneId: 'p-1', items: [{ id: '123', role: 'assistant', ts: null, blocks: [{ t: 'text', text: 'hi' }] }], cursor: null, done: true }).ok, 'chat pages parse')
  check(!H({ t: 'chatPage', paneId: 'p-1', items: [{ id: '123', role: 'assistant', ts: null, blocks: [{ t: 'html', text: '<b>' }] }], cursor: null, done: true }).ok, 'unknown chat blocks are refused')
  check(H({ t: 'notesRes', id: 'n1', ok: true, notes: [{ id: 'a', title: 'T', updatedAt: 1, size: 2, rev: 'r' }] }).ok, 'notes answers parse')
  check(H({ t: 'gitRes', id: 'g1', ok: false, data: { error: 'not_repo' }, page: 0, done: true }).ok, 'git answers parse')
  const hu = H({ t: 'somethingNew' })
  check(!hu.ok && hu.unknown, 'the guest sees unknown host types as unknown (ignored)')
  check(S.parseShareHandshake(JSON.stringify({ t: 'hs2', sv: 1, e: b43 })) !== null && S.parseShareHandshake(JSON.stringify({ t: 'ready' })) === null, 'handshake frames parse apart from sealed ones')
}

// --- 6. Identities -----------------------------------------------------------
function testIdentity() {
  let available = true
  const vault = {
    available: () => available,
    encrypt: s => Buffer.from('dpapi:' + s, 'utf8'),
    decrypt: b => { const s = b.toString('utf8'); if (!s.startsWith('dpapi:')) throw new Error('bad blob'); return s.slice(6) },
  }
  const file = path.join(tmp, 'share-identity.json')
  const a = new S.ShareIdentityStore(file, vault)
  check(a.peekPub('host') === null, 'no host key before first use')
  const host = a.get('host')
  check(host.persisted && !host.regenerated && fs.existsSync(file), 'the host identity is created and persisted')
  const raw = fs.readFileSync(file)
  check(raw[0] !== 0xef && JSON.parse(raw.toString('utf8')).host.priv.enc === 'dpapi', 'saved as UTF-8 without BOM, sealed by DPAPI')
  const guest = a.get('guest')
  check(!guest.pub.equals(host.pub) && a.get('host') === host, 'host and guest keys are separate; get is cached')
  const b = new S.ShareIdentityStore(file, vault)
  check(b.peekPub('host').equals(host.pub) && b.get('host').pub.equals(host.pub) && b.get('guest').pub.equals(guest.pub), 'a new run reads both identities back')
  check(b.get('host').fingerprint === host.fingerprint, 'the fingerprint is stable')

  // No encryption: memory only, the file untouched.
  available = false
  const before = fs.readFileSync(file, 'utf8')
  const c = new S.ShareIdentityStore(file, vault)
  const mem = c.get('host')
  check(!mem.persisted && !mem.pub.equals(host.pub) && fs.readFileSync(file, 'utf8') === before, 'without DPAPI the key lives in memory and the file is untouched')
  const freshFile = path.join(tmp, 'none', 'share-identity.json')
  new S.ShareIdentityStore(freshFile, vault).get('guest')
  check(!fs.existsSync(freshFile), 'without DPAPI nothing is ever written (no enc none)')
  available = true

  // A plaintext entry is never trusted; an entry DPAPI cannot open is replaced.
  const doc = JSON.parse(before)
  doc.host = { pub: doc.host.pub, priv: { enc: 'none', data: 'AAAA' }, createdAt: 1 }
  fs.writeFileSync(file, JSON.stringify(doc))
  const d = new S.ShareIdentityStore(file, vault).get('host')
  check(d.regenerated && d.persisted && !d.pub.equals(host.pub) && JSON.parse(fs.readFileSync(file, 'utf8')).host.priv.enc === 'dpapi', 'an enc none entry is replaced by a DPAPI one')
  check(new S.ShareIdentityStore(file, vault).get('guest').pub.equals(guest.pub), 'replacing one role keeps the other')
  const doc2 = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc2.guest.priv.data = Buffer.from('other-pc-blob').toString('base64')
  fs.writeFileSync(file, JSON.stringify(doc2))
  const e = new S.ShareIdentityStore(file, vault).get('guest')
  check(e.regenerated && !e.pub.equals(guest.pub), 'an entry this PC cannot decrypt is regenerated')
  const doc3 = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc3.host.pub = S.toB64u(S.generateShareKeyPair().pub)
  fs.writeFileSync(file, JSON.stringify(doc3))
  check(new S.ShareIdentityStore(file, vault).get('host').regenerated, 'a public key that does not match its private key is not trusted')
  fs.writeFileSync(file, '{not json')
  check(!new S.ShareIdentityStore(file, vault).get('host').regenerated, 'a corrupt file loads as empty')
  check(S.shareIdentityPath() === path.join(tmp, 'share-identity.json'), 'the identity file lives under dataDir()')
}

// --- 7. setForcedFast with two owners -------------------------------------
function testForcedFast() {
  const impl = (_shell, _args, opts) => ({ cols: opts.cols, rows: opts.rows, onData() {}, onExit() {}, write() {}, resize() {}, pause() {}, resume() {}, kill() {} })
  const code = buildSync({ entryPoints: [path.join(root, 'src/main/pty/PtyManager.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'], alias }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval, console: { ...console, warn() {} },
    require: id => id === 'node-pty' ? { spawn: impl } : id === 'electron' ? { app: { getPath: () => tmp } } : require(id) })
  const pm = new mod.exports.PtyManager(() => ({ isDestroyed: () => false, send() {} }), () => ({}), () => null)
  pm.spawn({ paneId: 'a', cols: 80, rows: 24 })
  const fast = () => [...pm.forcedFast].sort().join(',')
  pm.setForcedFast(['a', 'b'])
  check(fast() === 'a,b', 'the phone default owner sets its panes')
  pm.setForcedFast(['c'], 'share')
  check(fast() === 'a,b,c', 'a share update adds to the phone set')
  pm.setForcedFast(['b'])
  check(fast() === 'b,c', 'a phone update keeps the share set')
  pm.setForcedFast([], 'share')
  check(fast() === 'b', 'clearing share keeps the phone panes')
  pm.setForcedFast(['b'], 'share'); pm.setForcedFast([])
  check(fast() === 'b', 'a pane both watch stays fast until both let go')
  pm.setForcedFast([], 'share')
  check(fast() === '', 'nobody watching: no forced panes')
}

// =============================================================================
// Stage S1: the host core
// =============================================================================

function fakeClock(start = 1_700_000_000_000) {
  let now = start, seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id },
    clearTimeout: id => { timers.delete(id) },
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn, every: ms }); return id },
    clearInterval: id => { timers.delete(id) },
    advance(ms) {
      const end = now + ms
      for (;;) {
        let best = null
        for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t]
        if (!best) break
        const [id, t] = best
        now = Math.max(now, t.at)
        if (t.every) t.at += t.every; else timers.delete(id)
        t.fn()
      }
      now = end
    },
  }
}

const fakeVault = (state = { available: true }) => ({
  available: () => state.available,
  encrypt: s => Buffer.from('dpapi:' + s, 'utf8'),
  decrypt: b => { const s = b.toString('utf8'); if (!s.startsWith('dpapi:')) throw new Error('bad blob'); return s.slice(6) },
})

const tick = () => new Promise(r => setImmediate(r))

/** A PtyManager stand-in: replay = everything emitted, a pending tail flushed by getReplay (like the real one). */
function fakePty() {
  const sinks = []
  const panes = new Map()
  const writes = []
  const fast = { share: [], remote: [] }
  const pty = {
    sinks, panes, writes, fast,
    add(paneId, opts = {}) { panes.set(paneId, { ptyId: 'pty-' + paneId + '-' + (opts.gen ?? 1), replay: opts.replay ?? '', pending: '', cols: opts.cols ?? 120, rows: opts.rows ?? 40, exited: null }) },
    flush(paneId) { const p = panes.get(paneId); if (!p || !p.pending) return; const d = p.pending; p.pending = ''; for (const s of sinks) s.onData(p.ptyId, paneId, d) },
    emit(paneId, data, now = true) { const p = panes.get(paneId); p.replay += data; p.pending += data; if (now) pty.flush(paneId) },
    getReplay(paneId) { const p = panes.get(paneId); if (!p || p.exited) return null; pty.flush(paneId); return { ptyId: p.ptyId, replay: p.replay, cols: p.cols, rows: p.rows } },
    getExited(paneId) { const p = panes.get(paneId); return p && p.exited ? { data: p.replay, cols: p.cols, rows: p.rows, exitCode: p.exited.code } : null },
    setForcedFast(ids, owner = 'remote') { fast[owner] = [...ids].sort() },
    ptyIdForPane(paneId) { const p = panes.get(paneId); return p && !p.exited ? p.ptyId : null },
    write(ptyId, data, origin = 'user') {
      const entry = [...panes].find(([, p]) => p.ptyId === ptyId)
      if (!entry) return
      // Like PtyManager.write: the sinks see it before it reaches the pty.
      for (const s of sinks) s.onUserInput?.(ptyId, entry[0], data, origin)
      writes.push({ paneId: entry[0], data, origin })
    },
    respawn(paneId) { const p = panes.get(paneId); p.ptyId = p.ptyId.replace(/-(\d+)$/, (_m, n) => '-' + (Number(n) + 1)); p.replay = 'fresh:'; p.exited = null; for (const s of sinks) s.onSpawn(p.ptyId, paneId) },
    exit(paneId, code, natural = true) { const p = panes.get(paneId); pty.flush(paneId); p.exited = { code }; for (const s of sinks) s.onExit(p.ptyId, paneId, code, { current: true, natural }) },
    resize(paneId, cols, rows) { const p = panes.get(paneId); p.cols = cols; p.rows = rows; for (const s of sinks) s.onResize?.(p.ptyId, paneId, cols, rows) },
  }
  return pty
}

const pane = (id, type = 'shell', extra = {}) => ({ id, title: 'T ' + id, type, color: '#abc', icon: 'terminal', running: true, ...extra })
function baseSnapshot() {
  return {
    workspaces: [
      { id: 'w1', name: 'Work', layoutOrder: ['p1', 'p2'], panes: [pane('p1'), pane('p2', 'claude')], git: { branch: 'main', ahead: 0, behind: 0, added: 1, removed: 0, files: 1 }, note: 'secret note' },
      { id: 'w2', name: 'Other', layoutOrder: ['p3'], panes: [pane('p3')] },
    ],
    activeWorkspaceId: 'w1', themeTokens: {}, language: 'en', fontFamily: '', fontSize: 14,
    quickCommands: [{ id: 'q1', text: 'rm -rf' }], usage: { rows: [{ id: 'u' }], updatedAt: 1, activeAccount: { label: 'me' } },
    presets: [{ id: 'pre1', name: 'Claude', type: 'claude', icon: 'bot', color: '#f00' }], terminalUnicode: '11', schedules: [],
  }
}

function hostWorld(opts = {}) {
  const clock = fakeClock()
  const pty = fakePty()
  for (const id of ['p1', 'p2', 'p3']) pty.add(id, { replay: 'R:' + id + ';' })
  let snap = opts.noSnapshot ? null : baseSnapshot()
  const relayed = []
  const remote = {
    snapshot: () => snap,
    relayAction: async (action, label) => { relayed.push({ action, label }); return opts.relay ? opts.relay(action) : { id: 'x', ok: true, ...(action.kind === 'createPane' ? { paneId: 'p-new' } : {}) } },
  }
  const vaultState = { available: opts.vault !== false }
  const file = path.join(tmp, `grants-${Math.random().toString(36).slice(2)}.json`)
  const grants = new S.GrantStore(file, fakeVault(vaultState), clock.now)
  grants.load()
  const hostKey = S.generateShareKeyPair()
  const listeners = []
  let onTransport = null
  const events = { host: [], panes: [], guests: [], approvals: [] }
  const chat = { subs: [], unsubs: [], closed: [], sub(owner, paneId, send) { chat.subs.push({ owner, paneId, send }); send({ type: 'chatPage', paneId, items: [{ id: '1', role: 'assistant', ts: null, blocks: [{ t: 'text', text: 'hi' }] }], cursor: null, done: true }) }, unsub(owner, paneId) { chat.unsubs.push(paneId) }, more() {}, closed(owner) { chat.closed.push(owner) } }
  const gitCalls = [], notesCalls = []
  const statuses = [{ paneId: 'p2', state: 'idle', precise: true, provider: 'claude', stateSince: 5, updatedAt: 5 }]
  const host = new S.ShareHost({
    pty, remote, grants,
    hostKey: () => hostKey,
    listen: (port, cb) => { onTransport = cb; const l = { port, closed: false, start: () => Promise.resolve(), close() { l.closed = true } }; listeners.push(l); return l },
    endpoints: () => opts.noEndpoints ? [] : [{ ip: '192.168.1.2', kind: 'lan' }, { ip: '100.90.1.2', kind: 'tailscale' }],
    appVersion: '2.4.0', platform: 'win32', hostLabel: () => 'Valen PC',
    statuses: () => statuses,
    chat: () => chat,
    git: () => async req => { gitCalls.push(req); return req.op === 'status' ? { ok: true, data: { summary: { branch: 'main', ahead: 0, behind: 0, added: 1, removed: 0, files: 1, approx: false, conflicts: 0, op: null }, files: [{ path: 'src/a.ts', area: 'unstaged', status: 'M', added: 1, removed: 0, binary: false }], total: 1, truncated: false }, page: 0, done: true } : { ok: true, data: { path: req.path, area: 'unstaged', diffRev: 'r', binary: false, hunks: [] }, page: 0, done: true } },
    notes: () => async req => { notesCalls.push(req); return req.op === 'list' ? { ok: true, notes: [] } : { ok: false, error: 'not_found' } },
    guestLabel: name => `${name} (guest)`,
    guestFallback: () => 'Guest',
    onHostEvent: s => events.host.push(s),
    onPanes: p => events.panes.push(p),
    onGuestsChanged: n => events.guests.push(n),
    onApproval: a => events.approvals.push(a),
    clock,
    allowLoopback: false,
  })
  pty.sinks.push(host.sink)
  host.applyConfig({ enabled: true, port: 4527 })
  function wrapT(t) {
    const w = { buf: 0, get remoteIp() { return t.remoteIp }, get closed() { return t.closed }, send: f => t.send(f), close: (c, r) => t.close(c, r), bufferedAmount: () => w.buf, onMessage: cb => t.onMessage(cb), onClose: cb => t.onClose(cb) }
    return w
  }
  function connect(ip = '192.168.1.20', key = S.generateShareKeyPair(), pinned = hostKey.pub) {
    const pair = S.createMemoryTransportPair(ip, '192.168.1.2')
    const hostEnd = wrapT(pair.host)
    const g = { msgs: [], code: null, ready: false, channel: null, bad: [], key, hostEnd }
    const hs = new S.GuestHandshake({ hostStatic: pinned, guestStatic: key })
    pair.guest.onMessage(frame => {
      if (!g.channel) { const r = hs.receive(frame); if (r.ok) g.channel = r.channel; else g.hsErr = r; return }
      if (!g.ready) { g.ready = S.GuestHandshake.confirmReady(g.channel, frame); return }
      const text = g.channel.open(frame)
      if (text === null) { g.bad.push('crypto'); return }
      if (!S.parseShareHostMsg(text).ok) g.bad.push(text)
      g.msgs.push(JSON.parse(text))
    })
    pair.guest.onClose(code => { if (g.code === null) g.code = code })
    if (onTransport) onTransport(hostEnd)
    pair.guest.send(hs.hello())
    g.send = msg => pair.guest.send(g.channel.seal(msg))
    g.of = t => g.msgs.filter(m => m.t === t)
    g.last = t => g.of(t).pop()
    g.clear = () => { g.msgs.length = 0 }
    g.closed = () => pair.guest.closed
    return g
  }
  function join(grant, o = {}) {
    const g = connect(o.ip, o.key)
    if (!g.channel) return g
    g.send({ t: 'hello', sid: grant.shareId, guestName: o.name ?? 'Ana', app: '2.4.0', proof: o.proof ?? S.shareProof(grant.inviteKey, 'join', g.channel.h), ...(o.ticket ? { ticket: o.ticket } : {}), ...(o.pwKey ? { pw: S.shareProof(o.pwKey, 'pw', g.channel.h) } : {}) })
    return g
  }
  function approve(perm, allow = true) {
    const a = host.hostState().approvals[0]
    host.resolve({ requestId: a.requestId, allow, ...(perm ? { perm } : {}) })
    return a
  }
  async function grant(req) {
    const r = await host.create(req)
    assert.ok(r.ok, 'create ' + JSON.stringify(r))
    return { view: r.grant, invite: r.invite, g: grants.get(r.grant.id) }
  }
  return {
    clock, pty, host, grants, file, vaultState, hostKey, listeners, events, relayed, chat, gitCalls, notesCalls, statuses, connect, join, approve, grant,
    setSnap(next) { snap = next; if (next) host.onSnapshot(next) },
    snap: () => snap,
  }
}

// --- 8. GrantStore -------------------------------------------------------------
async function testGrantStore() {
  const clock = fakeClock()
  const file = path.join(tmp, 'share-grants.json')
  const vault = fakeVault()
  const a = new S.GrantStore(file, vault, clock.now)
  a.load()
  const g = a.create({ label: 'PowerShell', scope: { kind: 'pane', paneId: 'p1', workspaceId: 'w1' }, perm: 'type' })
  check(g && g.shareId.length === 22 && g.inviteKey.length === 16 && fs.existsSync(file), 'a grant is created and persisted')
  const raw = fs.readFileSync(file)
  const doc = JSON.parse(raw.toString('utf8'))
  check(raw[0] !== 0xef && doc.version === 1 && doc.grants[0].inviteKey.enc === 'dpapi' && !raw.toString('utf8').includes(g.inviteKey.toString('base64')), 'saved as UTF-8 without BOM, the invite key sealed by DPAPI (never in clear)')
  const salt = S.newPasswordSalt(), key = await S.derivePasswordKey('correct horse', salt)
  check(a.setPassword(g.id, { salt, key }) === 'ok', 'a password key is stored')
  a.noteGuest(g.id, S.toB64u(S.generateShareKeyPair().pub), 'Ana')
  const b = new S.GrantStore(file, vault, clock.now)
  b.load()
  const back = b.get(g.id)
  check(back && back.inviteKey.equals(g.inviteKey) && back.password.key.equals(key) && back.password.salt.equals(salt) && back.knownGuests.length === 1 && back.perm === 'type', 'a new run reads the grant, its secrets and its known guests back')
  check(!fs.readFileSync(file, 'utf8').includes(key.toString('base64')), 'the password key is never written in clear')

  // Concurrent persistence: a revoke and a knownGuests update in the same tick.
  const g2 = a.create({ label: 'W', scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full' })
  a.deleteInMemory(g.id)
  a.noteGuest(g2.id, S.toB64u(S.generateShareKeyPair().pub), 'Luis')
  a.persist()
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  check(after.grants.length === 1 && after.grants[0].id === g2.id && after.grants[0].knownGuests[0].name === 'Luis', 'a revoke next to a knownGuests update never brings the revoked grant back')
  // The async password (scrypt) racing a revoke: committed only while the grant exists.
  const w = hostWorld()
  const { g: pg } = await w.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'type' })
  const pending = w.host.setPassword(pg.id, 'hunter2hunter2')
  w.host.revoke(pg.id)
  const res = await pending
  check(!res.ok && res.error === 'not_found' && !w.grants.get(pg.id) && !(JSON.parse(fs.readFileSync(w.file, 'utf8')).grants.some(x => x.id === pg.id)), 'a password set while its grant is revoked never resurrects it')

  // No DPAPI: memory only, no password, nothing written.
  const noFile = path.join(tmp, 'none', 'share-grants.json')
  const state = { available: false }
  const c = new S.GrantStore(noFile, fakeVault(state), clock.now)
  c.load()
  const g3 = c.create({ label: 'x', scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'view' })
  check(g3 && !fs.existsSync(noFile) && !c.persisted, 'without DPAPI a grant lives in memory and nothing is written')
  check(c.setPassword(g3.id, { salt, key }) === 'encryption_unavailable', 'without DPAPI a password is refused')
  const w2 = hostWorld({ vault: false })
  const r2 = await w2.host.create({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'type', password: 'longenough' })
  check(!r2.ok && r2.error === 'encryption_unavailable' && w2.grants.list().length === 0, 'share:create with a password and no DPAPI fails before making a grant')

  // A blob this PC cannot open drops the grant; enc none is never trusted.
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'))
  tampered.grants.push({ ...tampered.grants[0], id: 'other', shareId: S.randomB64u(16), inviteKey: { enc: 'none', data: 'AAAA' } })
  tampered.grants.push({ ...tampered.grants[0], id: 'foreign', shareId: S.randomB64u(16), inviteKey: { enc: 'dpapi', data: Buffer.from('xx').toString('base64') } })
  fs.writeFileSync(file, JSON.stringify(tampered))
  const d = new S.GrantStore(file, vault, clock.now)
  d.load()
  check(d.list().length === 1 && d.get(g2.id), 'enc none and undecryptable grants are dropped')
  const many = new S.GrantStore(path.join(tmp, 'many.json'), vault, clock.now)
  many.load()
  for (let i = 0; i < 20; i++) many.create({ label: 'x', scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'view' })
  check(many.create({ label: 'x', scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'view' }) === null, 'at most 20 grants')
  check(S.shareGrantsPath() === path.join(tmp, 'share-grants.json'), 'the grants file lives under dataDir()')
}

// --- 9. Admission rules ----------------------------------------------------
function testAdmission() {
  const ok = { url: '/share', headers: { host: '192.168.1.2:4527', 'x-snaos-share': '1', 'sec-websocket-protocol': 'snaos-share.1' }, remoteAddress: '::ffff:192.168.1.20' }
  const v = (patch = {}, headers = {}, drop = []) => {
    const h = { ...ok.headers, ...headers }
    for (const k of drop) delete h[k]
    return S.checkShareUpgrade({ ...ok, ...patch, headers: h }, 4527)
  }
  check(v(), 'a well-formed share upgrade from the LAN passes')
  check(v({}, { host: '100.90.1.2:4527' }) && v({ remoteAddress: '100.101.1.1' }) && v({ remoteAddress: '127.0.0.1' }, { host: '127.0.0.1:4527' }), 'tailnet and loopback pass')
  check(!v({ url: '/ws' }) && !v({ url: '/share?x=1' }), 'only the /share path')
  check(!v({}, {}, ['x-snaos-share']) && !v({}, { 'x-snaos-share': '2' }), 'the custom header is required (a browser WebSocket cannot set it)')
  check(!v({}, { origin: 'http://evil.example' }) && !v({}, { origin: 'null' }), 'any Origin header is refused')
  check(!v({}, { 'sec-fetch-mode': 'websocket' }) && !v({}, { 'Sec-Fetch-Site': 'cross-site' }), 'Fetch Metadata headers are refused')
  check(!v({}, {}, ['sec-websocket-protocol']) && !v({}, { 'sec-websocket-protocol': 'chat' }) && v({}, { 'sec-websocket-protocol': 'x, snaos-share.1' }), 'the share subprotocol must be offered')
  check(!v({}, { host: 'evil.example:4527' }) && !v({}, { host: '8.8.8.8:4527' }) && !v({}, { host: '192.168.1.2:4528' }) && !v({}, { host: '192.168.1.2' }), 'Host must be a private IP literal on our port (no DNS rebinding)')
  check(!v({ remoteAddress: '8.8.8.8' }) && !v({ remoteAddress: undefined }), 'a public source address is refused (port forward)')
}

// --- 10. Join: proof, lockout, approval, password, tickets ----------------------
async function testJoin() {
  const w = hostWorld()
  const { g: grant, invite } = await w.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'type', label: 'PowerShell' })
  const inv = S.parseShareInvite(invite, { allowLoopback: false })
  check(inv.ok && inv.invite.s === grant.shareId && inv.invite.pk === S.toB64u(w.hostKey.pub) && inv.invite.k === S.toB64u(grant.inviteKey) && inv.invite.pm === 'type' && inv.invite.e[0].t === 'ts', 'the invite carries the share id, the pinned host key, the invite key and Tailscale first')
  check(w.listeners.length === 1 && w.host.hostState().listening !== 'off', 'the listener starts with sharing on and a live grant')

  // Wrong pinned key: the guest never confirms ready.
  const imp = w.connect('192.168.1.30', S.generateShareKeyPair(), S.generateShareKeyPair().pub)
  check(!imp.ready, 'a guest pinning another key never sees a valid ready')

  // Bad proof, unknown share, lockout.
  let g = w.join(grant, { proof: S.toB64u(Buffer.alloc(32, 7)) })
  check(g.code === 4401, 'a wrong invite proof closes 4401')
  g = w.join({ ...grant, shareId: S.randomB64u(16) })
  check(g.code === 4401, 'an unknown share closes 4401')
  for (let i = 0; i < 3; i++) w.join(grant, { proof: S.toB64u(Buffer.alloc(32, i)) })
  g = w.join(grant)
  check(g.code === 4429 && g.last('denied')?.reason === 'locked', 'five failures lock the address out, even with a good proof (4429)')
  w.clock.advance(31_000)
  g = w.join(grant)
  check(g.code === null && g.last('pending'), 'the lockout ends after 30 s')
  g.send({ t: 'bye' })

  // First sealed record must be hello.
  const h = w.connect('192.168.1.40')
  h.send({ t: 'sub', paneId: 'p1' })
  check(h.code === 4400, 'a first record other than hello closes 4400')
  const slow = w.connect('192.168.1.41')
  w.clock.advance(10_001)
  check(slow.code === 4408, 'no hello within 10 s closes 4408')
  const crowd = [1, 2, 3, 4, 5].map(() => w.connect('192.168.1.42'))
  check(crowd.slice(0, 4).every(c => c.code === null) && crowd[4].code === 4429, 'at most 4 unauthenticated sockets per address')
  for (const c of crowd.slice(0, 4)) c.send({ t: 'bye' })

  // Approval: allow with the dropdown's perm, known guest by key.
  const ana = S.generateShareKeyPair()
  g = w.join(grant, { ip: '192.168.1.50', key: ana })
  const p = g.last('pending')
  check(p && p.password === false && p.expiresAt > w.clock.now(), 'no ticket and no password: pending')
  let a = w.host.hostState().approvals[0]
  check(a && a.guestName === 'Ana' && a.ip === '192.168.1.50' && a.fingerprint === S.keyFingerprint(ana.pub) && !a.known && a.perm === 'type' && w.events.approvals.length >= 1, 'the prompt shows name, address, key fingerprint, first time and the grant perm')
  w.approve('view')
  const welcome = g.last('welcome')
  check(welcome && welcome.perm === 'view' && welcome.state.perm === 'view' && welcome.ticket.length === 43 && welcome.host.label === 'Valen PC', 'Allow with the perm dropdown: welcome at that perm with a ticket')
  check(g.bad.length === 0, 'every host frame passes the guest schema')
  check(w.host.guestCount === 1 && w.events.guests.at(-1) === 1, 'the guest count goes up')
  // Ticket: reconnect at the effective perm (view), no prompt.
  g.send({ t: 'bye' })
  check(w.host.guestCount === 0, 'bye ends the session')
  const r1 = w.join(grant, { ip: '192.168.1.50', key: ana, ticket: welcome.ticket })
  check(r1.last('welcome')?.perm === 'view' && w.host.hostState().approvals.length === 0, 'a ticket reconnect comes back at the approved perm (view), not the grant perm')
  // The ticket is bound to the guest key.
  const thief = w.join(grant, { ip: '192.168.1.51', ticket: r1.last('welcome').ticket })
  check(thief.last('pending') && !thief.last('welcome'), 'a ticket from another guest key is not accepted')
  thief.send({ t: 'bye' })
  // A known guest is flagged by key.
  const again = w.join(grant, { ip: '192.168.1.52', key: ana })
  check(w.host.hostState().approvals.find(x => x.ip === '192.168.1.52')?.known === true, 'the same key later is a known guest')
  again.send({ t: 'bye' })
  // Per-session perm change rewrites the ticket.
  const sid = r1.last('welcome').session.id
  check(w.host.sessionPerm(sid, 'full').ok && r1.last('permChanged')?.perm === 'full' && r1.last('state').state.perm === 'full', 'a live per-session perm change reaches the guest')
  const t2 = r1.last('welcome').ticket
  r1.send({ t: 'bye' })
  w.clock.advance(60_000)
  const r2 = w.join(grant, { ip: '192.168.1.50', key: ana, ticket: t2 })
  check(r2.last('welcome')?.perm === 'full', 'the ticket follows the per-session perm change')
  // Kick invalidates the ticket.
  const t3 = r2.last('welcome').ticket
  check(w.host.kick(r2.last('welcome').session.id).ok && r2.code === 4412 && r2.last('ended')?.reason === 'kicked', 'kick: ended kicked, 4412')
  const r3 = w.join(grant, { ip: '192.168.1.50', key: ana, ticket: t3 })
  check(r3.last('pending') && !r3.last('welcome'), 'a kicked guest needs a new approval')
  w.approve()
  const t4 = r3.last('welcome').ticket
  r3.send({ t: 'bye' })
  w.clock.advance(15 * 60_000 + 1)
  const r4 = w.join(grant, { ip: '192.168.1.50', key: ana, ticket: t4 })
  check(r4.last('pending') && !r4.last('welcome'), 'a ticket dies 15 min after the last session closed')
  r4.send({ t: 'bye' })

  // Deny and timeout count as failures; 1 pending per address; 3 per host; cooldown after a deny.
  const w2 = hostWorld()
  const { g: g2 } = await w2.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full' })
  const d1 = w2.join(g2, { ip: '10.0.0.5' })
  const d2 = w2.join(g2, { ip: '10.0.0.5' })
  check(d1.last('pending') && d2.last('denied')?.reason === 'busy' && d2.code === 4403, 'one pending request per address')
  w2.join(g2, { ip: '10.0.0.6' }); w2.join(g2, { ip: '10.0.0.7' })
  const d4 = w2.join(g2, { ip: '10.0.0.8' })
  check(w2.host.hostState().approvals.length === 3 && d4.last('denied')?.reason === 'busy', 'at most 3 pending requests per host')
  const first = w2.host.hostState().approvals.find(x => x.ip === '10.0.0.5')
  w2.host.resolve({ requestId: first.requestId, allow: false })
  check(d1.last('denied')?.reason === 'denied' && d1.code === 4403, 'Deny: denied, 4403')
  const d5 = w2.join(g2, { ip: '10.0.0.5' })
  check(d5.last('denied')?.reason === 'busy', 'a short cooldown follows a Deny for that address')
  w2.clock.advance(60_001)
  check(w2.host.hostState().approvals.length === 0, 'the prompts time out after 60 s')
  const timedOut = w2.connect('10.0.0.9')
  timedOut.send({ t: 'hello', sid: g2.shareId, guestName: 'x', app: '2.4.0', proof: S.shareProof(g2.inviteKey, 'join', timedOut.channel.h) })
  w2.clock.advance(60_001)
  check(timedOut.last('denied')?.reason === 'timeout' && timedOut.code === 4408, 'an approval timeout: denied timeout, 4408')
  // An invite holder spinning new keys from one address: deny and timeout feed the lockout.
  const w3 = hostWorld()
  const { g: g3 } = await w3.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'view' })
  for (let i = 0; i < 5; i++) {
    w3.join(g3, { ip: '10.1.1.1', key: S.generateShareKeyPair() })
    w3.approve(undefined, false)
    w3.clock.advance(16_000)
  }
  const spam = w3.join(g3, { ip: '10.1.1.1', key: S.generateShareKeyPair() })
  check(spam.last('denied')?.reason === 'locked' && w3.host.hostState().approvals.length === 0, 'repeated denials lock the address out (approval DoS)')

  // Password: unattended, wrong password falls back to the prompt, password while pending.
  const w4 = hostWorld()
  const { g: g4 } = await w4.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'type', password: 'correct horse battery' })
  const pwKey = await S.derivePasswordKey('correct horse battery', g4.password.salt)
  const u = w4.join(g4, { pwKey })
  check(u.last('welcome')?.perm === 'type' && w4.host.hostState().approvals.length === 0, 'the right password admits without a prompt at the grant perm')
  const wrongKey = await S.derivePasswordKey('wrong', g4.password.salt)
  const bad = w4.join(g4, { ip: '192.168.1.60', pwKey: wrongKey })
  const bp = bad.last('pending')
  check(bp && bp.password === true && bp.salt === S.toB64u(g4.password.salt) && bp.passwordFailed === true && w4.host.hostState().approvals[0].passwordFailed, 'a wrong password falls back to the prompt, flagged, with the salt to retry')
  bad.send({ t: 'password', proof: S.shareProof(pwKey, 'pw', bad.channel.h) })
  check(bad.last('welcome')?.perm === 'type' && w4.host.hostState().approvals.length === 0, 'the password sent while pending admits and dismisses the prompt')
  check(w4.host.hostState().grants[0].hasPassword && !(await w4.host.setPassword(g4.id, 'short')).ok, 'hasPassword shows; a short password is refused')
  check((await w4.host.setPassword(g4.id, null)).ok && !w4.grants.get(g4.id).password, 'the password can be cleared')
}

// --- 11. Scope, state, data plane ---------------------------------------------
async function testScopeAndStream() {
  const w = hostWorld()
  const { g: grant } = await w.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'type' })
  const g = w.join(grant)
  w.approve()
  const st = g.last('welcome').state
  check(st.panes.length === 1 && st.panes[0].id === 'p1' && JSON.stringify(st.layoutOrder) === '["p1"]' && st.scope.kind === 'pane' && st.terminalUnicode11 === true, 'pane scope: the state has only that pane')
  const json = JSON.stringify(g.msgs)
  check(!/usage|quickCommands|rm -rf|activeAccount|secret note|schedules|"git":\{|branch|themeTokens|presets/.test(json) && !json.includes('Other'), 'never usage, accounts, quick commands, notes text, the git chip nor other workspaces')
  check(st.caps.createPane === false && st.caps.chat === false && st.presets === undefined, 'type on a pane: no caps, no presets')

  // Data plane: replay is the exact prefix of the out frames.
  w.pty.emit('p1', 'before-', false)
  g.send({ t: 'sub', paneId: 'p1' })
  const rep = g.of('replay')
  check(rep.length === 1 && rep[0].data === 'R:p1;before-' && rep[0].first && rep[0].last && rep[0].running && rep[0].cols === 120, 'sub: one replay including the pending tail')
  w.pty.emit('p1', 'after')
  w.clock.advance(16)
  check(g.of('out').map(m => m.data).join('') === 'after', 'then out frames, no gap and no overlap')
  check(w.pty.fast.share.join() === 'p1' && w.host.subscribedPaneIds().has('p1'), 'a watched pane is forced fast (owner share) and kept awake')
  // Chunking.
  g.clear()
  w.pty.emit('p1', 'x'.repeat(16383) + '\ud83d\ude00' + 'y'.repeat(20000))
  w.clock.advance(16)
  const outs = g.of('out')
  check(outs.length === 3 && outs.every(o => o.data.length <= 16384) && outs[0].data.length === 16383 && outs.map(o => o.data).join('') === 'x'.repeat(16383) + '\ud83d\ude00' + 'y'.repeat(20000), 'out is split into <= 16K frames without splitting a surrogate pair')
  g.clear()
  w.pty.panes.get('p1').replay = 'z'.repeat(40000)
  g.send({ t: 'resync', paneId: 'p1' })
  const parts = g.of('replay')
  check(parts.length === 3 && parts[0].first && !parts[0].last && parts[2].last && !parts[2].first && parts.map(x => x.data).join('').length === 40000, 'replay is split into parts with first and last')
  g.clear()
  w.pty.resize('p1', 100, 30)
  check(g.last('fit')?.cols === 100 && g.last('fit').rows === 30, 'a resize sends fit')
  w.pty.respawn('p1')
  check(g.last('replay')?.data === 'fresh:' && g.last('replay').first, 'a new pty pushes a fresh replay')
  w.pty.exit('p1', 3)
  check(g.last('exit')?.code === 3, 'a natural exit sends exit')
  w.snap().workspaces[0].panes[0].running = false
  w.clock.advance(60)
  check(g.last('state')?.state.panes[0].running === false, 'running follows the snapshot after a spawn/exit (50 ms debounce)')
  w.snap().workspaces[0].panes[0].running = true
  w.pty.respawn('p1')

  // Out of scope: err, never a strike.
  for (let i = 0; i < 5; i++) g.send({ t: 'sub', paneId: 'p3' })
  g.send({ t: 'input', paneId: 'p3', data: 'x', seq: 9 })
  check(g.code === null && g.of('err').filter(e => e.code === 'out_of_scope').length === 5 && g.last('inputDenied')?.reason === 'out_of_scope' && !w.pty.writes.some(x => x.paneId === 'p3'), 'a pane outside the scope answers out_of_scope with no strike')
  g.send({ t: 'futureThing', x: 1 })
  check(g.last('err')?.code === 'unsupported' && g.code === null, 'an unknown type answers unsupported, no strike')

  // Pane moved to another workspace: still shared.
  const moved = baseSnapshot()
  moved.workspaces[0].panes = [pane('p2', 'claude')]
  moved.workspaces[0].layoutOrder = ['p2']
  moved.workspaces[1].panes.push(pane('p1'))
  moved.workspaces[1].layoutOrder.push('p1')
  w.setSnap(moved)
  check(g.code === null && g.last('state').state.panes[0].id === 'p1' && g.last('state').state.title === 'Other' && w.grants.get(grant.id).scope.workspaceId === 'w2', 'a pane moved to another workspace stays shared')
  // Pane closed: suspended, reopened inside the grace: back.
  const closed = baseSnapshot()
  closed.workspaces[0].panes = [pane('p2', 'claude')]
  w.setSnap(closed)
  check(g.code === 4411 && g.last('ended')?.reason === 'scope_gone' && w.host.hostState().grants[0].suspended, 'a closed pane suspends the grant: ended scope_gone, 4411')
  const knock = w.join(grant, { ip: '192.168.1.77' })
  check(knock.code === 4411, 'a suspended grant answers 4411')
  w.setSnap(baseSnapshot())
  check(w.grants.get(grant.id) && !w.host.hostState().grants[0].suspended, 'reopening the pane inside the grace restores the same grant')
  w.setSnap(closed)
  w.clock.advance(10 * 60_000 + 1)
  check(!w.grants.get(grant.id) && w.listeners[0].closed, 'past the grace the grant is deleted and the listener stops')

  // Multiple malformed frames close.
  const w2 = hostWorld()
  const { g: wg } = await w2.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'type' })
  const m = w2.join(wg)
  w2.approve()
  const ws = m.last('welcome').state
  check(ws.panes.map(p => p.id).join() === 'p1,p2' && ws.layoutOrder.join() === 'p1,p2' && ws.title === 'Work', 'workspace scope: its panes in layout order')
  m.send({ t: 'sub', paneId: 'p1' }); m.send({ t: 'sub', paneId: 'p2' })
  const sm = new Set(m.of('replay').map(r => r.paneId))
  check(sm.has('p1') && sm.has('p2'), 'every pane of the workspace can be watched')
  for (let i = 0; i < 3; i++) m.send({ t: 'input', paneId: 'p1' })
  check(m.code === 4400, 'three malformed frames close 4400')
  // Workspace gone deletes its grants.
  const w3 = hostWorld()
  const { g: g3 } = await w3.grant({ scope: { kind: 'workspace', workspaceId: 'w2' }, perm: 'view' })
  const v = w3.join(g3); w3.approve()
  const gone = baseSnapshot(); gone.workspaces.pop()
  w3.setSnap(gone)
  check(v.code === 4411 && !w3.grants.get(g3.id), 'a workspace that is gone deletes its grant')
  // First snapshot after boot: a missing pane grant is deleted at once.
  const w4 = hostWorld({ noSnapshot: true })
  const stale = w4.grants.create({ label: 'old', scope: { kind: 'pane', paneId: 'gone', workspaceId: 'w1' }, perm: 'view' })
  check(!(await w4.host.create({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'view' })).ok, 'no grant can be made before the first snapshot')
  w4.setSnap({ ...baseSnapshot(), workspaces: [] })
  check(w4.grants.get(stale.id), 'an empty first state never deletes grants')
  w4.setSnap(baseSnapshot())
  check(!w4.grants.get(stale.id), 'the first real snapshot after boot deletes a pane grant whose pane is gone')

  // Backpressure (PaneFanout directly).
  const sent = []
  const sessions = { a: { buf: 0 }, b: { buf: 0 } }
  const killed = []
  const fpty = fakePty(); fpty.add('p1', { replay: 'R;' })
  const fclock = fakeClock()
  const fan = new S.PaneFanout({ pty: fpty, clock: fclock, send: (s, msg) => sent.push({ s, msg }), bufferedAmount: s => s.buf, terminate: s => { killed.push(s); fan.removeSession(s) }, streaming: () => true })
  fpty.sinks.push(fan)
  fan.sub(sessions.a, 'p1'); fan.sub(sessions.b, 'p1')
  sessions.a.buf = 600 * 1024
  fpty.emit('p1', 'lost'); fclock.advance(16)
  const aOut = () => sent.filter(x => x.s === sessions.a && x.msg.t === 'out')
  check(aOut().length === 0 && sent.some(x => x.s === sessions.b && x.msg.t === 'out' && x.msg.data === 'lost'), 'past 512KB buffered the pane drops for that session only')
  sessions.a.buf = 100 * 1024
  fan.maintenance()
  check(!sent.some(x => x.s === sessions.a && x.msg.t === 'replay' && x.msg.data.includes('lost')), 'no recovery until under 64KB')
  sessions.a.buf = 10
  fan.maintenance()
  check(sent.filter(x => x.s === sessions.a && x.msg.t === 'replay').pop().msg.data === 'R;lost', 'drained: the congested pane gets a replay')
  sessions.b.buf = 5 * 1024 * 1024
  fan.maintenance()
  check(killed.includes(sessions.b), 'past 4MB buffered the session is killed')
  sessions.a.buf = 600 * 1024
  fpty.emit('p1', 'more'); fclock.advance(16)
  sessions.a.buf = 300 * 1024
  fclock.advance(30_001); fan.maintenance()
  check(killed.includes(sessions.a) && fpty.fast.share.length === 0, 'congested for 30 s kills the session; nobody left watching')
}

// --- 12. Pause, expiry, revoke, perm change -------------------------------------
async function testLifecycle() {
  const w = hostWorld()
  const { g: grant } = await w.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'type', expiry: '1h' })
  check(grant.expiresAt === w.clock.now() + 3_600_000, 'expiry 1h')
  const g = w.join(grant); w.approve()
  g.send({ t: 'sub', paneId: 'p1' })
  check(w.host.update({ grantId: grant.id, paused: true }).ok && g.last('paused')?.on === true, 'pause: paused on')
  g.clear()
  w.pty.emit('p1', 'hidden'); w.clock.advance(16)
  g.send({ t: 'input', paneId: 'p1', data: 'x', seq: 1 })
  check(!g.of('out').length && g.last('inputDenied')?.reason === 'paused' && !w.pty.writes.length, 'paused: no out, input refused')
  const late = w.join(grant, { ip: '192.168.1.90' }); w.approve()
  check(late.last('welcome') && late.last('paused')?.on === true && late.msgs.indexOf(late.last('paused')) > late.msgs.indexOf(late.last('welcome')), 'a guest admitted to a paused grant gets paused right after welcome')
  late.send({ t: 'bye' })
  w.host.update({ grantId: grant.id, paused: false })
  check(g.last('paused')?.on === false && g.last('replay')?.data.includes('hidden'), 'resume: paused off and a replay')
  w.host.pauseAll(true)
  check(g.last('paused')?.on === true && w.host.hostState().pausedAll, 'pause all')
  w.host.pauseAll(false)
  check(g.last('paused')?.on === false, 'resume all')
  // Live grant perm change.
  w.host.update({ grantId: grant.id, perm: 'view' })
  check(g.last('permChanged')?.perm === 'view' && g.last('state').state.perm === 'view', 'a grant perm change reaches the live session')
  w.clock.advance(600)
  g.send({ t: 'input', paneId: 'p1', data: 'x', seq: 2 })
  check(g.last('inputDenied')?.reason === 'view_only', 'and applies at once')
  // Expiry (moved close so the guest's 60 s keepalive does not end it first).
  g.send({ t: 'ping', ts: 1 })
  check(g.last('pong')?.ts === 1, 'ping answers pong')
  w.grants.get(grant.id).expiresAt = w.clock.now() + 1000
  w.clock.advance(5001)
  check(g.last('ended')?.reason === 'expired' && g.code === 4410, 'an expired grant ends its sessions (4410)')
  check(w.listeners[0].closed && w.host.hostState().listening === 'off', 'no live grant left: the listener stops')
  const exp = w.join(grant)
  check(exp.code !== null || exp.hsErr || !exp.ready, 'nothing listens for an expired grant')

  // Revoke mid-stream.
  const w2 = hostWorld()
  const { g: g2 } = await w2.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'full' })
  const r = w2.join(g2); w2.approve()
  r.send({ t: 'sub', paneId: 'p1' })
  w2.host.revoke(g2.id)
  check(r.last('ended')?.reason === 'revoked' && r.code === 4403 && !w2.grants.get(g2.id), 'revoke: ended revoked, 4403')
  check(!JSON.parse(fs.readFileSync(w2.file, 'utf8')).grants.length, 'and the file no longer has it')
  const before = w2.pty.writes.length
  try { r.send({ t: 'input', paneId: 'p1', data: 'x', seq: 1 }) } catch { /* closed */ }
  check(w2.pty.writes.length === before, 'input after a revoke is never written')
  // Rotate: old invite keys stop working, live sessions stay.
  const w3 = hostWorld()
  const { g: g3 } = await w3.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'view' })
  const live = w3.join(g3); w3.approve()
  const oldKey = Buffer.from(g3.inviteKey)
  const rot = w3.host.rotate(g3.id)
  check(rot.ok && live.code === null, 'rotate keeps live sessions')
  const stale = w3.join({ ...g3, inviteKey: oldKey }, { ip: '192.168.1.99' })
  check(stale.code === 4401, 'the old invite key is refused after a rotate')
  // Sharing off.
  w3.host.applyConfig({ enabled: false, port: 4527 })
  check(live.last('ended')?.reason === 'sharing_off' && live.code === 1001 && w3.host.hostState().listening === 'off', 'sharing off ends every session (1001)')
  w3.host.applyConfig({ enabled: true, port: 4600 })
  check(w3.listeners.at(-1).port === 4600, 'a port change restarts the listener there')
  const nep = hostWorld({ noEndpoints: true })
  check((await nep.host.create({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'view' })).error === 'no_endpoint' && nep.grants.list().length === 0, 'no address to invite to: no grant')
}

// --- 13. Leases and the gate ---------------------------------------------------
async function testLeases() {
  const w = hostWorld()
  const { g: grant } = await w.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'type' })
  const a = w.join(grant, { name: 'Ana' }); w.approve()
  const b = w.join(grant, { ip: '192.168.1.21', name: 'Luis' }); w.approve()
  for (const g of [a, b]) { g.send({ t: 'sub', paneId: 'p1' }); g.send({ t: 'sub', paneId: 'p2' }) }
  a.send({ t: 'input', paneId: 'p1', data: 'echo hi', seq: 1 })
  const wr = w.pty.writes.at(-1)
  check(wr.data === 'echo hi' && wr.origin === 'auto', 'an admitted guest write goes in with origin auto')
  check(a.last('inputLock')?.holder === 'you' && b.last('inputLock')?.holder === 'other', 'the lease: you / other')
  check(w.events.panes.length >= 0 && w.host.panes().find(p => p.paneId === 'p1')?.typing === 'Ana', 'share:panes says who is typing')
  b.send({ t: 'input', paneId: 'p1', data: 'x', seq: 1 })
  check(b.last('inputDenied')?.reason === 'other_typing', 'another guest is refused while the lease holds')
  w.clock.advance(2001)
  check(a.last('inputLock')?.holder === null, 'the guest lease ends after 2 s')
  b.send({ t: 'input', paneId: 'p1', data: 'x', seq: 2 })
  check(w.pty.writes.at(-1).data === 'x', 'then the other guest may type')
  // The owner's key revokes the guest at once.
  w.pty.write('pty-p1-1', 'k', 'user')
  check(a.last('inputLock')?.holder === 'host' && b.last('inputLock')?.holder === 'host', 'an owner key: holder host for every watcher')
  w.clock.advance(600)
  b.send({ t: 'input', paneId: 'p1', data: 'y', seq: 3 })
  check(b.last('inputDenied')?.reason === 'host_typing', 'the guest is refused while the owner types')
  w.clock.advance(1500)
  check(a.last('inputLock')?.holder === null, 'the owner lease ends 1.5 s after the last key')
  w.pty.write('pty-p1-1', '\x1b[I', 'user')
  w.pty.write('pty-p1-1', 'auto text', 'auto')
  b.clear()
  b.send({ t: 'input', paneId: 'p1', data: 'z', seq: 4 })
  check(w.pty.writes.at(-1).data === 'z' && !b.of('inputDenied').length, 'reports and automations never arm the owner lease')
  w.clock.advance(2001)

  // The gate on the host: type rules, Esc window, throttled denials.
  a.clear()
  a.send({ t: 'input', paneId: 'p1', data: '\r', seq: 10 })
  check(a.last('inputDenied')?.reason === 'no_send' && w.pty.writes.at(-1).data !== '\r', 'type: Enter is refused')
  a.send({ t: 'input', paneId: 'p1', data: '\x03', seq: 11 })
  check(a.of('inputDenied').length === 1, 'denials are throttled (one per 500 ms per pane)')
  w.clock.advance(501)
  a.send({ t: 'input', paneId: 'p1', data: '\x1b', seq: 12 })
  check(w.pty.writes.at(-1).data === '\x1b', 'Esc is allowed')
  a.send({ t: 'input', paneId: 'p1', data: '[13u', seq: 13 })
  check(a.last('inputDenied')?.reason === 'blocked_key' && w.pty.writes.at(-1).data === '\x1b', 'Esc then [13u in two frames is CSI-u Enter: refused')
  w.clock.advance(2001)
  // Agent rules come from the live status (p2 is Claude, idle and precise).
  a.send({ t: 'input', paneId: 'p2', data: 'hola', seq: 14 })
  check(w.pty.writes.at(-1).data === 'hola' && w.pty.writes.at(-1).paneId === 'p2', 'an idle precise agent pane takes typing')
  w.host.onPaneStatus({ paneId: 'p2', state: 'action', precise: true, provider: 'claude', stateSince: 9, pending: [{ id: 'r1', kind: 'permission' }], attention: true })
  w.clock.advance(600)
  a.send({ t: 'input', paneId: 'p2', data: '1', seq: 15 })
  check(a.last('inputDenied')?.reason === 'awaiting_host', 'an agent waiting on a request: a digit is refused')
  w.clock.advance(2001)
  a.send({ t: 'input', paneId: 'p2', data: '\x1b', seq: 16 })
  check(w.pty.writes.at(-1).data === '\x1b' && w.pty.writes.at(-1).paneId === 'p2', 'but Esc still passes')
  const ps = a.of('paneStatus').pop()
  check(ps && ps.status.state === 'action' && !('pending' in ps.status) && !('attention' in ps.status), 'pane status reaches the guest without pending nor attention')
  check(!b.bad.length && !a.bad.length, 'every frame passes the guest schema')

  // A paste as one unit; an admitted open paste is closed by the host.
  const w2 = hostWorld()
  const { g: g2 } = await w2.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'type' })
  const c = w2.join(g2); w2.approve(); c.send({ t: 'sub', paneId: 'p1' })
  const frames = S.splitSharePaste('\x1b[200~' + 'a'.repeat(9000) + '\x1b[201~', 7)
  for (const f of frames) c.send({ t: 'input', paneId: 'p1', data: f.data, seq: 1, paste: f.paste })
  check(w2.pty.writes.length === 1 && w2.pty.writes[0].data.length === 9012, 'a paste in parts is written whole, once')
  const nl = S.splitSharePaste('\x1b[200~' + 'a'.repeat(9000) + '\nrm -rf /\x1b[201~', 8)
  for (const f of nl) c.send({ t: 'input', paneId: 'p1', data: f.data, seq: 2, paste: f.paste })
  check(w2.pty.writes.length === 1 && c.last('inputDenied')?.reason === 'no_send', 'a paste with a newline in a later part writes nothing at all')
  w2.clock.advance(2001)
  c.send({ t: 'input', paneId: 'p1', data: '\x1b[200~abc', seq: 3 })
  w2.pty.write('pty-p1-1', 'K', 'user')
  const tail = w2.pty.writes.slice(-3).map(x => x.data)
  check(tail[0] === '\x1b[200~abc' && tail[1] === '\x1b[201~' && tail[2] === 'K', 'the owner taking the pane closes the paste the guest left open first')
  w2.clock.advance(2001)
  c.send({ t: 'input', paneId: 'p1', data: '\x1b[200~def', seq: 4 })
  c.send({ t: 'bye' })
  check(w2.pty.writes.at(-1).data === '\x1b[201~', 'a session that ends with an open paste gets it closed')
  // Rate bucket.
  const w3 = hostWorld()
  const { g: g3 } = await w3.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'full' })
  const d = w3.join(g3); w3.approve()
  for (let i = 0; i < 230; i++) d.send({ t: 'input', paneId: 'p1', data: 'a', seq: i })
  check(w3.pty.writes.length === 200 && d.of('inputDenied').some(x => x.reason === 'rate'), 'input is rate limited (burst 200)')
  w3.clock.advance(2001)
  d.send({ t: 'input', paneId: 'p1', data: '\r', seq: 999 })
  check(w3.pty.writes.at(-1).data === '\r', 'full: Enter passes')
}

// --- 14. ctl, chat, git, notes, status coalescing -------------------------------
async function testControl() {
  const w = hostWorld()
  const { g: grant } = await w.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full' })
  const g = w.join(grant, { name: 'Ana\u202e' }); w.approve()
  const st = g.last('welcome').state
  check(st.caps.createPane && st.caps.closePane && st.caps.chat && st.caps.notes && st.caps.git && st.presets.length === 1 && st.presets[0].id === 'pre1', 'full on a workspace: every cap and the presets')
  check(w.host.hostState().grants[0].sessions[0].name === 'Ana', 'guest names are cleaned (bidi override gone)')
  check(JSON.stringify(st.panes[1].status) === JSON.stringify({ state: 'idle', stateSince: 5, provider: 'claude' }) && st.panes[0].status === undefined, 'the state carries the live agent status (StatusManager), bounded and without host-local fields')
  g.send({ t: 'ctl', id: 'c1', op: 'createPane', presetId: 'pre1' })
  await tick()
  check(JSON.stringify(w.relayed[0].action) === JSON.stringify({ kind: 'createPane', workspaceId: 'w1', presetId: 'pre1' }) && w.relayed[0].label === 'Ana (guest)', 'createPane relays only the workspace and the preset id, labeled as the guest')
  const ack = g.last('ctlAck')
  check(ack.ok && ack.paneId === 'p-new', 'the ack carries the new pane')
  w.pty.add('p-new', { replay: 'N;' })
  g.send({ t: 'sub', paneId: 'p-new' })
  check(g.last('replay')?.paneId === 'p-new' && !g.of('err').length, 'the new pane is in scope at once (before the snapshot lists it)')
  g.send({ t: 'ctl', id: 'c2', op: 'createPane', presetId: 'nope' })
  await tick()
  check(g.last('ctlAck').error === 'bad_preset' && w.relayed.length === 1, 'an unknown preset is refused in main')
  g.send({ t: 'ctl', id: 'c3', op: 'createPane', paneType: 'codex' })
  await tick()
  check(JSON.stringify(w.relayed[1].action) === JSON.stringify({ kind: 'createPane', workspaceId: 'w1', paneType: 'codex' }), 'a plain type, never prompt, resume nor cwd')
  g.send({ t: 'ctl', id: 'c4', op: 'closePane', paneId: 'p3' })
  await tick()
  check(g.last('ctlAck').error === 'out_of_scope' && w.relayed.length === 2, 'closePane outside the scope is refused')
  g.send({ t: 'ctl', id: 'c5', op: 'closePane', paneId: 'p1' })
  await tick()
  check(JSON.stringify(w.relayed[2].action) === JSON.stringify({ kind: 'closePane', workspaceId: 'w1', paneId: 'p1' }), 'closePane in the scope is relayed')
  for (let i = 0; i < 4; i++) g.send({ t: 'ctl', id: 'r' + i, op: 'createPane' })
  await tick()
  check(g.of('ctlAck').filter(x => x.error === 'rate').length === 3 && w.relayed.length === 4, 'at most 6 ctl per minute')

  // Chat.
  g.send({ t: 'chatSub', paneId: 'p2' })
  check(w.chat.subs[0].owner && w.chat.subs[0].paneId === 'p2' && g.last('chatPage')?.items[0].blocks[0].text === 'hi', 'chatSub reaches the hub and pages come back as share frames')
  g.send({ t: 'chatSub', paneId: 'p3' })
  check(g.last('err').code === 'out_of_scope' && w.chat.subs.length === 1, 'chat outside the scope is refused')
  check(w.host.subscribedPaneIds().has('p2'), 'a pane read as chat stays awake')
  // Git: always the scoped workspace, diffs only of listed paths.
  g.send({ t: 'gitReq', id: 'g1', op: 'diff', path: 'src/a.ts' })
  await tick()
  check(g.last('gitRes').data.error === 'not_found' && w.gitCalls.length === 0, 'a diff of a path no status listed never reaches git')
  g.send({ t: 'gitReq', id: 'g2', op: 'status' })
  await tick()
  g.send({ t: 'gitReq', id: 'g3', op: 'diff', path: 'src/a.ts' })
  await tick()
  check(w.gitCalls.length === 2 && w.gitCalls.every(r => r.workspaceId === 'w1') && g.last('gitRes').id === 'g3' && g.last('gitRes').ok, 'git status then diff, on the scoped workspace')
  // Notes: list/read of the scoped workspace; notesChanged only for it.
  g.send({ t: 'notesReq', id: 'n1', op: 'list' })
  await tick()
  check(w.notesCalls[0].workspaceId === 'w1' && w.notesCalls[0].op === 'list' && g.last('notesRes').ok, 'notes list on the scoped workspace')
  g.clear()
  w.host.notesChanged({ workspaceId: 'w2', noteId: 'a' })
  w.host.notesChanged({ workspaceId: 'w1', noteId: 'b' })
  check(g.of('notesChanged').length === 1 && g.last('notesChanged').noteId === 'b', 'notesChanged only for the shared workspace')

  // Status coalescing.
  g.clear()
  for (let i = 0; i < 5; i++) w.host.onPaneStatus({ paneId: 'p2', state: 'working', precise: true, provider: 'claude', stateSince: 100, activity: 'Bash ' + i })
  w.host.onPaneStatus({ paneId: 'p3', state: 'working', stateSince: 1 })
  check(g.of('paneStatus').length === 0, 'working updates are held')
  w.clock.advance(100)
  const held = g.of('paneStatus')
  check(held.length === 1 && held[0].status.activity === 'Bash 4' && held[0].paneId === 'p2', 'at most one per 100 ms per pane, the latest, and only panes in scope')
  w.host.onPaneStatus({ paneId: 'p2', state: 'done', stateSince: 200, provider: 'claude' })
  check(g.last('paneStatus').status.state === 'done', 'done goes out at once')

  // type perm on a workspace: no caps.
  const w2 = hostWorld()
  const { g: g2 } = await w2.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'type' })
  const t = w2.join(g2); w2.approve()
  t.send({ t: 'ctl', id: 'x', op: 'createPane' })
  t.send({ t: 'gitReq', id: 'gx', op: 'status' })
  t.send({ t: 'notesReq', id: 'nx', op: 'list' })
  t.send({ t: 'chatSub', paneId: 'p1' })
  await tick()
  check(t.last('ctlAck').error === 'denied' && t.last('gitRes').data.error === 'not_found' && t.last('notesRes').error === 'not_found' && t.last('err').code === 'unauthorized' && !w2.relayed.length && !w2.gitCalls.length && !w2.notesCalls.length && !w2.chat.subs.length, 'type: no ctl, git, notes nor chat')
  // full on a pane scope: still no ctl.
  const w3 = hostWorld()
  const { g: g3 } = await w3.grant({ scope: { kind: 'pane', paneId: 'p1' }, perm: 'full' })
  const f = w3.join(g3); w3.approve()
  f.send({ t: 'ctl', id: 'y', op: 'closePane', paneId: 'p1' })
  await tick()
  check(f.last('ctlAck').error === 'denied' && !w3.relayed.length, 'full on one console: no ctl')
}

// --- 14b. S5 host restrictions: perm drops, pause, failed relays, stale extras ---
async function testControlLimits() {
  // A live downgrade from full ends the chats and every extra at once.
  const w = hostWorld()
  const { g: grant } = await w.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full' })
  const g = w.join(grant); w.approve()
  const moreCalls = []
  w.chat.more = (owner, paneId, before) => moreCalls.push({ paneId, before })
  g.send({ t: 'chatSub', paneId: 'p2' })
  g.send({ t: 'chatMore', paneId: 'p2', before: 'abc' })
  g.send({ t: 'chatMore', paneId: 'p1', before: '10' })
  g.send({ t: 'chatMore', paneId: 'p2', before: '12' })
  check(moreCalls.length === 1 && moreCalls[0].before === 12 && moreCalls[0].paneId === 'p2', 'chatMore needs a chat read and a numeric cursor')
  const hubSend = w.chat.subs[0].send
  const sid = w.host.hostState().grants[0].sessions[0].id
  g.clear()
  check(w.host.sessionPerm(sid, 'type').ok, 'session perm change accepted')
  const st = g.last('state').state
  check(g.last('permChanged').perm === 'type' && !st.caps.createPane && !st.caps.closePane && !st.caps.chat && !st.caps.notes && !st.caps.git && st.presets === undefined, 'full -> type: the new state has no caps and no presets')
  check(w.chat.unsubs.includes('p2') && !w.host.subscribedPaneIds().has('p2'), 'full -> type: the chat read ends at the hub (and stops keeping the pane awake)')
  hubSend({ type: 'chatAppend', paneId: 'p2', items: [{ id: '2', role: 'assistant', ts: null, blocks: [{ t: 'text', text: 'leak' }] }] })
  check(!g.of('chatAppend').length, 'a late hub frame never reaches the downgraded guest')
  g.send({ t: 'chatMore', paneId: 'p2', before: '5' })
  g.send({ t: 'ctl', id: 'd1', op: 'createPane', presetId: 'pre1' })
  g.send({ t: 'ctl', id: 'd2', op: 'closePane', paneId: 'p1' })
  g.send({ t: 'gitReq', id: 'dg', op: 'status' })
  g.send({ t: 'notesReq', id: 'dn', op: 'list' })
  await tick()
  check(moreCalls.length === 1 && g.of('ctlAck').every(a => !a.ok && a.error === 'denied') && g.of('ctlAck').length === 2 && w.relayed.length === 0, 'after the downgrade: no chatMore, no createPane, no closePane')
  check(g.last('gitRes').data.error === 'not_found' && g.last('notesRes').error === 'not_found' && w.gitCalls.length === 0 && w.notesCalls.length === 0, 'after the downgrade: no git nor notes')
  w.host.notesChanged({ workspaceId: 'w1', noteId: 'n' })
  check(!g.of('notesChanged').length, 'after the downgrade: no notesChanged')
  // The grant perm moving down (Settings) does the same for every session of it.
  g.send({ t: 'chatSub', paneId: 'p2' })
  check(g.last('err').code === 'unauthorized', 'type: chatSub refused')
  w.host.sessionPerm(sid, 'full')
  g.send({ t: 'chatSub', paneId: 'p2' })
  const unsubs0 = w.chat.unsubs.length
  check(w.host.update({ grantId: grant.id, perm: 'view' }).ok && w.chat.unsubs.length === unsubs0 + 1 && g.last('permChanged').perm === 'view', 'grant full -> view ends the chats of its sessions')

  // Paused: the extras stop with the terminal.
  const p = hostWorld()
  const { g: pg } = await p.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full' })
  const pgst = p.join(pg); p.approve()
  pgst.send({ t: 'chatSub', paneId: 'p2' })
  const pSend = p.chat.subs[0].send
  check(p.host.update({ grantId: pg.id, paused: true }).ok && pgst.last('paused').on === true, 'the grant pauses')
  pgst.clear()
  pSend({ type: 'chatAppend', paneId: 'p2', items: [{ id: '3', role: 'assistant', ts: null, blocks: [{ t: 'text', text: 'held' }] }] })
  pgst.send({ t: 'ctl', id: 'p1', op: 'createPane', presetId: 'pre1' })
  pgst.send({ t: 'gitReq', id: 'pg', op: 'status' })
  pgst.send({ t: 'notesReq', id: 'pn', op: 'list' })
  pgst.send({ t: 'chatSub', paneId: 'p1' })
  await tick()
  check(!pgst.of('chatAppend').length && pgst.last('ctlAck').error === 'denied' && pgst.last('gitRes').data.error === 'not_found' && pgst.last('notesRes').error === 'not_found' && pgst.last('err').code === 'paused', 'paused: no chat frames, ctl, git, notes nor a new chat')
  check(!p.relayed.length && !p.gitCalls.length && !p.notesCalls.length, 'paused: nothing reached the renderer executor, git or notes')
  p.host.notesChanged({ workspaceId: 'w1' })
  check(!pgst.of('notesChanged').length, 'paused: no notesChanged')

  // A relay the renderer refused: ack failed, nothing enters the scope.
  const r = hostWorld({ relay: () => ({ id: 'x', ok: false, error: 'not_found' }) })
  const { g: rg } = await r.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full' })
  const rs = r.join(rg); r.approve()
  rs.send({ t: 'ctl', id: 'f1', op: 'createPane', presetId: 'pre1' })
  await tick()
  check(rs.last('ctlAck').ok === false && rs.last('ctlAck').error === 'failed' && rs.last('ctlAck').paneId === undefined, 'a refused relay acks failed without a pane')
  // A relay that answers a malformed pane id adds nothing either.
  const bad = hostWorld({ relay: () => ({ id: 'x', ok: true, paneId: 'bad\u0000id' }) })
  const { g: bg } = await bad.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full' })
  const bs = bad.join(bg); bad.approve()
  bs.send({ t: 'ctl', id: 'b1', op: 'createPane' })
  await tick()
  check(bs.last('ctlAck').ok === true && bs.last('ctlAck').paneId === undefined && bad.host.allowedFor(bg.id).size === 2, 'a malformed pane id from the executor never enters the scope')

  // An acked pane no snapshot lists leaves the scope after its grace.
  const e = hostWorld()
  const { g: eg } = await e.grant({ scope: { kind: 'workspace', workspaceId: 'w1' }, perm: 'full' })
  const es = e.join(eg); e.approve()
  es.send({ t: 'ctl', id: 'e1', op: 'createPane', presetId: 'pre1' })
  await tick()
  check(es.last('ctlAck').paneId === 'p-new' && e.host.allowedFor(eg.id).has('p-new'), 'the acked pane is in scope')
  es.send({ t: 'ctl', id: 'e2', op: 'closePane', paneId: 'p-new' })
  await tick()
  check(es.last('ctlAck').error === 'out_of_scope' && e.relayed.length === 1, 'closePane of a pane no snapshot listed yet is refused (the executor could not find it)')
  e.clock.advance(S.SHARE_EXTRA_PANE_MS + 1)
  e.host.maintenance()
  es.clear()
  es.send({ t: 'sub', paneId: 'p-new' })
  check(!e.host.allowedFor(eg.id).has('p-new') && es.last('err')?.code === 'out_of_scope', 'past the grace an unlisted pane is out of scope again')
  // Listed by a snapshot in time: it stays for good.
  es.send({ t: 'ctl', id: 'e3', op: 'createPane', presetId: 'pre1' })
  await tick()
  const snap = e.snap()
  snap.workspaces[0].panes.push(pane('p-new', 'claude'))
  snap.workspaces[0].layoutOrder.push('p-new')
  e.setSnap(snap)
  e.clock.advance(S.SHARE_EXTRA_PANE_MS + 1)
  e.host.maintenance()
  check(e.host.allowedFor(eg.id).has('p-new') && es.last('state').state.panes.some(x => x.id === 'p-new'), 'a pane the snapshot lists stays in scope and in the state')
}

// --- 15. Firewall names, guest names, RemoteManager additions ----------------
async function testHostMisc() {
  const share = S.buildFixScript({ exe: 'C:\\a.exe', port: 4527, programScope: true, tailnet: true, domain: false, rules: S.FW_RULES_SHARE })
  check(share.includes("-Name 'SnAgentsOS.Share.TCP'") && share.includes("-Name 'SnAgentsOS.Share.Tailnet'") && share.includes("'SnAgentsOS Share (TCP 4527)'") && share.includes("'SnAgentsOS Share Tailscale (TCP 4527)'") && !share.includes('Remote (TCP') && !share.includes('Remote.TCP'), 'the Share fix script has its own rule names and display names')
  const phone = S.buildFixScript({ exe: 'C:\\a.exe', port: 4517, programScope: true, tailnet: true, domain: false })
  check(phone.includes("-Name 'SnAgentsOS.Remote.TCP'") && phone.includes("'SnAgentsOS Remote (TCP 4517)'") && phone.includes("'SnAgentsOS Remote Tailscale (TCP 4517)'"), 'the phone fix script is unchanged by default')
  check(S.sanitizeDeviceName('', 'Guest') === 'Guest' && S.sanitizeDeviceName('') === 'Phone' && S.sanitizeDeviceName('Ana\u202e') === 'Ana', 'sanitizeDeviceName takes a fallback, Phone by default')

  // RemoteManager: snapshot(), onSnapshot(), relayAction(), setThrottleHold().
  const stub = {
    name: 'rm-stubs',
    setup(b) {
      b.onResolve({ filter: /\/RemoteServer$/ }, () => ({ path: 'RemoteServer', namespace: 'stub' }))
      b.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
      b.onLoad({ filter: /^RemoteServer$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: 'export class RemoteServer { constructor() {} start() { return Promise.resolve() } close() {} }' }))
      b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(tmp)} }` }))
    },
  }
  const code = (await build({ stdin: { contents: "export { RemoteManager } from './src/main/remote/RemoteManager'", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'], alias, plugins: [stub] })).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, process, console: { ...console, warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL,
    require: id => id === 'qrcode' ? { toDataURL: async () => 'data:' } : id === 'electron' ? { safeStorage: {}, app: { getPath: () => tmp } } : require(id) })
  const sent = [], throttle = []
  const wc = { isDestroyed: () => false, setBackgroundThrottling: v => throttle.push(v), send: (ch, cmd) => sent.push({ ch, cmd }) }
  const pty = { addSink() {}, removeSink() {}, setRunningChangeListener() {}, setForcedFast() {}, runningPaneIds: () => ['p1'], exitedPaneCodes: () => new Map(), ptyIdForPane: id => 'pty-' + id, sizeOf: () => null }
  const rm = new mod.exports.RemoteManager(pty, () => wc, '2.4.0', () => [{ paneId: 'p1', state: 'working', stateSince: 3, pending: [{ id: 'x' }], attention: true }], () => 'PC', () => [], { secure: { enable: async () => ({ ok: false, error: 'cli' }), disable: async () => ({ ok: true }) }, push: { ensureKeys() {}, publicKey: () => null, notify: async () => 0, removeDevice() {}, handleSubscribe() {} } })
  check(rm.snapshot() === null, 'snapshot() is null before the first renderer push')
  const seen = []
  const off = rm.onSnapshot(s => seen.push(s))
  rm.pushState({ workspaces: [{ id: 'w1', name: 'W', layoutOrder: ['p1'], panes: [{ id: 'p1', title: 't', type: 'shell', color: '', icon: '', running: false }] }], activeWorkspaceId: 'w1', themeTokens: {}, language: 'en', fontFamily: '', fontSize: 14 })
  check(seen.length === 1 && seen[0].workspaces[0].panes[0].running === true && seen[0].workspaces[0].panes[0].status.state === 'working', 'onSnapshot fires on every push with running and status overlaid, phone server off')
  check(rm.snapshot().workspaces[0].panes[0].running === true, 'snapshot() returns the overlaid state')
  off()
  rm.pushState({ workspaces: [], activeWorkspaceId: null, themeTokens: {}, language: 'en', fontFamily: '', fontSize: 14 })
  check(seen.length === 1, 'onSnapshot unsubscribes')
  const p = rm.relayAction({ kind: 'closePane', workspaceId: 'w1', paneId: 'p1' }, 'Ana (guest)')
  const cmd = sent.find(x => x.ch === 'remote:controlCmd').cmd
  check(cmd.action.kind === 'closePane' && cmd.deviceName === 'Ana (guest)', 'relayAction sends the action to the renderer executor with the label')
  rm.onControlResult({ id: cmd.id, ok: true })
  check((await p).ok, 'and resolves with its result')
  rm.setThrottleHold('share', true)
  check(throttle.at(-1) === false, 'a throttle hold turns background throttling off')
  rm.setThrottleHold('share', false)
  check(throttle.at(-1) === true, 'releasing the last hold turns it back on')
  rm.shutdown('quit')
}

async function main() {
  await bundleShare()
  S = loadShare()
  testInvite()
  testGate()
  testPaste()
  await testHandshake()
  testSchemas()
  testIdentity()
  testForcedFast()
  await testGrantStore()
  testAdmission()
  await testJoin()
  await testScopeAndStream()
  await testLifecycle()
  await testLeases()
  await testControl()
  await testControlLimits()
  await testHostMisc()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`PASS: ${checks} share checks (S0 invite, gate, paste, handshake, schema, identity, forced-fast; S1 grants, admission, join, scope, stream, lifecycle, leases, control; S5 limits)`)
}

main().catch(error => { console.error(error); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1) })
