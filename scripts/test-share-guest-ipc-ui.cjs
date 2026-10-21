// Share (app 2.4.0, item 8) stage S2 in Electron: the guest IPC end to end.
// A hidden window with the real built preload (out/preload/index.js) drives
// window.snApi.share.guest against registerShareGuestIpc in Electron main,
// with the real safeStorage (DPAPI on Windows) and a minimal fake host on
// 127.0.0.1 built from S0's crypto. Checks: preview, join, link events,
// approval wait, welcome state, replay on the stream, typed input reaching
// the host, Enter refused in main, share-links.json sealed, forget.
// Needs `npm run build` (the preload). Throwaway profile; nothing real is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-share-guest-ui-'))
const preload = path.join(root, 'out/preload/index.js')
if (!fs.existsSync(preload)) throw new Error('Run npm run build first')

buildSync({
  stdin: {
    contents: `
import { registerShareGuestIpc } from './src/main/ipc/registerShareGuestIpc'
import { createShareIdentityStore } from './src/main/share/identity'
import { hostHandshake, generateShareKeyPair, verifyShareProof, randomB64u, toB64u } from './src/main/share/crypto'
import { encodeShareInvite } from './src/main/share/invite'
import { parseShareClientMsg } from './src/shared/share-protocol-schemas'
export { registerShareGuestIpc, createShareIdentityStore, hostHandshake, generateShareKeyPair, verifyShareProof, randomB64u, toB64u, encodeShareInvite, parseShareClientMsg }
`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(dir, 'guest-main.cjs'),
  // ws is bundled: the bundle runs from a temp folder outside node_modules.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  alias: { '@shared': path.join(root, 'src/shared') },
  logLevel: 'silent',
})

fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><meta charset="utf-8"></head><body><div id="root">share guest ipc</div></body></html>')
fs.writeFileSync(path.join(dir, 'main.cjs'), `
process.env.SNAOS_SHARE_LOOPBACK = '1'
const { app, BrowserWindow } = require('electron')
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto')
const { WebSocketServer } = require(${JSON.stringify(path.join(root, 'node_modules/ws'))})
app.setPath('userData', path.join(__dirname, 'profile'))
const G = require('./guest-main.cjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Minimal host: hs1 -> hs2 + ready, hello proof, approval on demand, replay on sub, inputs recorded.
function fakeHost() {
  const key = G.generateShareKeyPair(), shareId = G.randomB64u(16), inviteKey = crypto.randomBytes(16)
  const host = { key, shareId, inviteKey, inputs: [], hellos: 0, pending: null, port: 0 }
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: s => (s.has('snaos-share.1') ? 'snaos-share.1' : false) })
  const server = http.createServer((q, r) => { r.writeHead(404); r.end() })
  server.on('upgrade', (req, sock, head) => {
    if (req.url !== '/share' || req.headers['x-snaos-share'] !== '1' || req.headers.origin) { sock.destroy(); return }
    wss.handleUpgrade(req, sock, head, ws => {
      let ch = null
      const send = m => ws.send(ch.seal(m))
      const welcome = () => send({ t: 'welcome', session: { id: 's1' }, grant: { scope: { kind: 'pane', label: 'PowerShell' } }, perm: 'type', host: { label: 'Host PC', platform: 'win32', app: '2.4.0' }, ticket: G.randomB64u(32),
        state: { scope: { kind: 'pane', label: 'PowerShell' }, perm: 'type', title: 'PowerShell', layoutOrder: ['p1'], panes: [{ id: 'p1', title: 'PowerShell', type: 'shell', color: '#888888', icon: 'terminal', running: true }], terminalUnicode11: true, hostPlatform: 'win32', caps: { createPane: false, closePane: false, chat: false, notes: false, git: false } },
        limits: { inputMax: 8192 } })
      ws.on('message', (data, bin) => {
        if (!ch) {
          const r = G.hostHandshake(data.toString(), { hostStatic: key })
          if (!r.ok) { ws.close(r.close); return }
          ch = r.channel; ws.send(r.reply); ws.send(r.ready); return
        }
        const text = ch.open(data); const p = text && G.parseShareClientMsg(text)
        if (!p || !p.ok) { ws.close(4400); return }
        const m = p.msg
        if (m.t === 'hello') {
          host.hellos++
          if (!G.verifyShareProof(inviteKey, 'join', ch.h, m.proof)) { ws.close(4401); return }
          send({ t: 'pending', expiresAt: Date.now() + 60000, password: false })
          host.pending = welcome
        } else if (m.t === 'sub') {
          send({ t: 'replay', paneId: m.paneId, running: true, cols: 100, rows: 30, data: 'PS C:\\\\> ', first: true, last: true })
        } else if (m.t === 'input') host.inputs.push(m.data)
        else if (m.t === 'ping') send({ t: 'pong', ts: m.ts })
      })
    })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => { host.port = server.address().port; r(host) }))
}

app.whenReady().then(async () => {
  const fail = msg => { console.error('FAIL: ' + msg); app.exit(1) }
  try {
    const host = await fakeHost()
    const invite = G.encodeShareInvite({ v: 1, h: 'Host PC', pk: G.toB64u(host.key.pub), s: host.shareId, k: G.toB64u(host.inviteKey), e: [{ a: '127.0.0.1', p: host.port, t: 'loop' }], sc: { k: 'pane', l: 'PowerShell' }, pm: 'type' }, { allowLoopback: true })
    const w = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { preload: ${JSON.stringify(preload)}, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const ids = G.createShareIdentityStore()
    const guest = G.registerShareGuestIpc({ identities: ids, guestName: () => 'Ana', app: '2.4.0', send: (ch, p) => { if (!w.isDestroyed()) w.webContents.send(ch, p) } })
    const errors = []
    w.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) })
    await w.loadFile(path.join(__dirname, 'index.html'))
    const js = code => w.webContents.executeJavaScript(code)
    await js("window.ev={links:[],states:[],items:[]};const g=snApi.share.guest;g.onLinkEvent(e=>{if(e.t==='link')ev.links.push(e.link);if(e.t==='state')ev.states.push(e.state)});g.onStream(e=>ev.items.push(...e.items));true")
    const apiKeys = await js("Object.keys(snApi.share.guest).sort().join()")
    for (const k of ['preview', 'join', 'links', 'connect', 'disconnect', 'forget', 'password', 'ctl', 'git', 'notes', 'sub', 'unsub', 'input', 'flow', 'chat', 'onLinkEvent', 'onStream', 'onChatEvent']) if (!apiKeys.split(',').includes(k)) return fail('snApi.share.guest.' + k + ' missing: ' + apiKeys)
    const pre = await js('snApi.share.guest.preview(' + JSON.stringify(invite) + ')')
    if (!pre.ok || pre.preview.hostLabel !== 'Host PC' || pre.preview.perm !== 'type') return fail('preview ' + JSON.stringify(pre))
    const bad = await js("snApi.share.guest.preview('snaos-share:1:AAAA')")
    if (bad.ok) return fail('a garbage invite previewed')
    const joined = await js('snApi.share.guest.join(' + JSON.stringify(invite) + ')')
    if (!joined.ok) return fail('join ' + JSON.stringify(joined))
    const id = joined.link.id
    const until = async (code, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(code)) return; await sleep(30) } throw new Error('timed out: ' + label) }
    await until("ev.links.some(l=>l.status==='waiting_approval')", 4000, 'waiting_approval')
    host.pending()
    await until("ev.links.some(l=>l.status==='connected')&&ev.states.length>0", 4000, 'connected')
    const list = await js('snApi.share.guest.links()')
    if (list.links.length !== 1 || list.links[0].perm !== 'type' || !list.guestFingerprint) return fail('links ' + JSON.stringify(list))
    if (process.platform === 'win32' && !list.persisted) return fail('DPAPI should be available on Windows')
    if (JSON.stringify(list).includes(G.toB64u(host.inviteKey))) return fail('the invite key reached the renderer')
    await js("snApi.share.guest.sub(" + JSON.stringify(id) + ",'p1');true")
    await until("ev.items.some(i=>i.t==='replay'&&i.first)", 4000, 'replay')
    await js("snApi.share.guest.input({linkId:" + JSON.stringify(id) + ",paneId:'p1',data:'echo hi'});snApi.share.guest.input({linkId:" + JSON.stringify(id) + ",paneId:'p1',data:'\\\\r'});true")
    await until("ev.items.some(i=>i.t==='inputRefused'&&i.reason==='no_send')", 4000, 'enter refused')
    await sleep(150)
    if (host.inputs.join('|') !== 'echo hi') return fail('host inputs ' + JSON.stringify(host.inputs))
    const file = path.join(app.getPath('userData'), 'share-links.json')
    if (list.persisted) {
      const disk = fs.readFileSync(file, 'utf8')
      if (disk.includes(G.toB64u(host.inviteKey)) || !disk.includes('"dpapi"')) return fail('share-links.json is not sealed')
    }
    const forgot = await js('snApi.share.guest.forget(' + JSON.stringify(id) + ')')
    if (!forgot || (await js('snApi.share.guest.links()')).links.length !== 0) return fail('forget')
    guest.dispose()
    if (errors.length) return fail(errors.join('\\n'))
    console.log('PASS: snApi.share.guest end to end (preview, join, approval, welcome, replay, input gate, sealed links file, forget)')
    w.destroy()
    app.exit(0)
  } catch (err) {
    fail(err && err.stack || String(err))
  }
})
`)

const electron = path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const r = spawnSync(electron, [path.join(dir, 'main.cjs')], { stdio: 'inherit', env, timeout: 60_000 })
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
process.exit(r.status ?? 1)
