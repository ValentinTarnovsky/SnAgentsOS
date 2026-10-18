// SnAgentsOS rebrand checks (E0). Same harness as test-status.cjs: esbuild +
// vm, check() counts assertions, one PASS line at the end. Each work package of
// the rebrand adds its own section below.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, fetch, Response, AbortController, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const LEGACY_RE = /snmulticc|multicc|multi command/i
const DASH_RE = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')

async function main() {
  // E0-FR-01: brand constants.
  const { BRAND, LEGACY_BRAND, AGENT_ENV } = load('src/shared/brand.ts')
  assert.deepStrictEqual({ ...BRAND }, {
    productName: 'SnAgentsOS', packageName: 'snagentsos', appId: 'com.sndevelopment.snagentsos', repo: 'ValentinTarnovsky/SnAgentsOS',
    cliBin: 'snaos', repoConfigFile: '.snagentsos.json', skillDir: 'snagentsos', envPrefix: 'SNAOS_', mobileTitle: 'SnAgentsOS Remote',
    portableDataDir: 'snagentsos-data', devUserDataDir: 'snagentsos-dev', mobileStoragePrefix: 'snagentsos.',
    hookStatusMessage: 'SnAgentsOS session status', exportFileName: 'snagentsos-config.json', tempPrefix: 'snagentsos-',
  }); checks++
  assert.deepStrictEqual({ ...LEGACY_BRAND }, {
    productName: 'SnMultiCC', packageName: 'snmulticc', appId: 'com.sndevelopment.snmulticc', nsisGuid: '8c5f793e-c93a-5e95-add6-ae90c4af8c04',
    winExe: 'SnMultiCC.exe', macProcess: 'SnMultiCC', linuxProcess: 'snmulticc', envPrefix: 'SNMULTICC_', portableDataDir: 'snmulticc-data',
    mobileStoragePrefix: 'snmulticc.', hookStatusMessage: 'SnMultiCC session status', tempPrefix: 'snmulticc-',
    updaterCacheDir: 'snmulticc-updater', portableUnpackDir: 'SnMultiCC',
  }); checks++
  check(Object.keys(AGENT_ENV).length === 7 && Object.values(AGENT_ENV).every(v => v.startsWith(BRAND.envPrefix)), 'every agent env var uses the new prefix')
  check(new Set(Object.values(AGENT_ENV)).size === 7, 'agent env vars are distinct')
  check(!Object.values(BRAND).some(v => LEGACY_RE.test(v)), 'BRAND carries no legacy value')
  check(Object.values(LEGACY_BRAND).every(v => /snmulticc|8c5f793e/i.test(v)), 'LEGACY_BRAND carries only legacy values')

  // E0-FR-03: renderer i18n.
  const { en } = load('src/renderer/i18n/en.ts')
  const { es } = load('src/renderer/i18n/es.ts')
  const appKeys = ['notif.desktop.blocked', 'usage.hint', 'remote.firewallHint', 'remote.pairing.wants', 'remote.keybar.hint']
  const interpolate = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m)
  for (const [lang, dict] of [['en', en], ['es', es]]) {
    check(Object.keys(dict).length === Object.keys(en).length, `${lang}: same key set as en`)
    for (const key of appKeys) {
      check(dict[key].includes('{app}'), `${lang}: ${key} uses {app}`)
      const shown = interpolate(dict[key], { app: BRAND.productName, name: 'Phone' })
      check(shown.includes(BRAND.productName) && !/\{\w+\}/.test(shown), `${lang}: ${key} interpolates with no literal placeholder`)
    }
    check(!('tray.show' in dict), `${lang}: unused tray.show removed`)
    check(!Object.values(dict).some(v => LEGACY_RE.test(v)), `${lang}: no legacy name in any message`)
  }
  check(en['empty.title'] === 'Agents command center' && es['empty.title'] === 'Centro de mando de agentes', 'empty.title is the nameless tagline')

  // Every call site of the {app} keys passes the product name.
  const renderer = file => read(path.join('src/renderer/components', file))
  const calls = {
    'usage.hint': 'settings/sections/UsageSection.tsx',
    'remote.firewallHint': 'settings/sections/RemoteSection.tsx',
    'remote.keybar.hint': 'settings/sections/RemoteSection.tsx',
    'remote.pairing.wants': 'remote/RemotePairingPrompt.tsx',
  }
  for (const [key, file] of Object.entries(calls)) {
    const sites = renderer(file).match(new RegExp(`t\\('${key.replace(/\./g, '\\.')}'[^)]*\\)`, 'g')) ?? []
    check(sites.length > 0 && sites.every(s => s.includes('app: BRAND.productName')), `${key} call sites pass {app}`)
  }
  check(/t\(`notif\.desktop\.\$\{[^}]+\}`, \{ app: BRAND\.productName \}\)/.test(renderer('settings/sections/NotificationsSection.tsx')), 'notif.desktop.* call site passes {app}')

  // E0-FR-03: main-process strings (tray, dialog, toast, Discord, export).
  const { mainT } = load('src/main/i18n.ts')
  const cfg = language => ({ settings: { language } })
  check(mainT(cfg('en'), 'tray.show', { app: BRAND.productName }) === 'Show SnAgentsOS', 'tray menu en')
  check(mainT(cfg('es'), 'tray.show', { app: BRAND.productName }) === 'Mostrar SnAgentsOS', 'tray menu es')
  const index = read('src/main/index.ts')
  check(index.includes("mainT(cfg, 'tray.show', { app: BRAND.productName })"), 'tray label interpolates the product name')
  check(/title: BRAND\.productName,\s*message: mainT\(cfg, 'dialog\.activeTitle'\)/.test(index), 'active consoles dialog titled with the product name')
  check(index.includes('defaultPath: BRAND.exportFileName'), 'export suggests snagentsos-config.json')
  {
    // Window, tray and native toast run against an electron stub, so the checks
    // cover what each module hands to Electron, not how the source spells it.
    const noop = () => {}
    const fakeWebContents = { on: noop, setWindowOpenHandler: noop, toggleDevTools: noop }
    let windowOptions = null
    class BrowserWindow { constructor(opts) { windowOptions = opts; this.webContents = fakeWebContents } once() {} show() {} loadFile() {} loadURL() {} }
    const { ELECTRON_RENDERER_URL: _dev, ...env } = process.env
    const { createMainWindow } = load('src/main/window.ts', {
      require: id => id === 'electron' ? { BrowserWindow, shell: { openExternal: noop } } : require(id),
      process: { ...process, env }, __dirname: path.join(root, 'out/main'),
    })
    createMainWindow()
    check(windowOptions?.title === BRAND.productName, 'window title')

    let tooltip = null, template = null
    class Tray { constructor() {} setToolTip(text) { tooltip = text } on() {} setContextMenu() {} destroy() {} }
    const tray = load('src/main/tray.ts', {
      require: id => id === 'electron' ? {
        app: { getAppPath: () => root }, Tray,
        Menu: { buildFromTemplate: items => { template = items; return items } },
        nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
      } : require(id),
      process: { ...process, resourcesPath: root },
    })
    tray.ensureTray(() => null, noop, { show: mainT(cfg('es'), 'tray.show', { app: BRAND.productName }), quit: mainT(cfg('es'), 'tray.quit') })
    check(tooltip === BRAND.productName, 'tray tooltip')
    check(template?.[0]?.label === 'Mostrar SnAgentsOS', 'tray menu shows the interpolated label')
    tray.destroyTray()

    const toasts = []
    class Notification { static isSupported() { return true } constructor(opts) { toasts.push(opts) } on() {} show() {} }
    const { StatusManager } = load('src/main/status/StatusManager.ts', { require: id => id === 'electron' ? { Notification } : require(id) })
    new StatusManager(() => null, () => cfg('en')).testDesktop()
    check(toasts.length === 1 && toasts[0].title === BRAND.productName && toasts[0].body === 'Desktop notification test', 'native toast title')
  }
  {
    const { DiscordNotifier } = load('src/main/status/DiscordNotifier.ts')
    const discord = { enabled: true, notifyDone: true, notifyAction: true, webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/fake-token', userId: '' }
    const sent = []
    const notifier = new DiscordNotifier(async (_url, init) => { sent.push(JSON.parse(init.body).content); return new Response('{}', { status: 200 }) }, async () => {})
    check((await notifier.test(discord)).ok && sent[0] === 'SnAgentsOS: notification test / prueba de notificacion', 'Discord test message')
    notifier.setConfig(discord)
    notifier.notify({ paneId: 'unknown', state: 'done', provider: 'claude' }, { settings: { language: 'en' }, workspaces: [] })
    for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
    check(sent[1]?.split('\n')[1] === BRAND.productName, 'Discord default place')
  }

  // E0-FR-04: AUMID, packaged Windows only.
  check(/if \(process\.platform === 'win32' && app\.isPackaged\) \{\s*app\.setAppUserModelId\(BRAND\.appId\)/.test(index), 'packaged Windows AUMID is the new appId')

  // E0-FR-03: window title, TitleBar and wordmark.
  check(read('src/renderer/index.html').includes(`<title>${BRAND.productName}</title>`), 'renderer index.html title')
  check(read('src/renderer/components/titlebar/TitleBar.tsx').includes('{BRAND.productName}</span>'), 'TitleBar shows the product name')
  const wordmark = read('src/renderer/components/ui/Logo.tsx').match(/to-accent-blue">\s*(\w+)\s*<\/span>\s*<span className="text-text-primary">(\w+)<\/span>/)
  check(wordmark && wordmark[1] + wordmark[2] === BRAND.productName && wordmark[1] === 'Sn', 'wordmark is gradient Sn plus AgentsOS')

  // E0-FR-17: mobile titles.
  const mobileHtml = read('src/mobile/index.html')
  check(mobileHtml.includes(`<title>${BRAND.mobileTitle}</title>`), 'mobile tab title')
  check(mobileHtml.includes(`name="apple-mobile-web-app-title" content="${BRAND.mobileTitle}"`), 'apple web app title')
  const manifest = JSON.parse(read('src/mobile/public/manifest.webmanifest'))
  check(manifest.name === BRAND.mobileTitle && manifest.short_name === BRAND.productName, 'manifest name and short_name')
  check(manifest.description.includes(BRAND.productName) && !LEGACY_RE.test(manifest.description), 'manifest description')
  {
    const mobile = load('src/mobile/src/lib/i18n.ts')
    mobile.setLang('en'); const enTitle = mobile.t('welcome.title')
    mobile.setLang('es'); const esTitle = mobile.t('welcome.title')
    check(enTitle === BRAND.mobileTitle && esTitle === BRAND.mobileTitle, 'welcome.title is the fixed client name in en and es')
  }
  check(read('src/main/remote/RemoteServer.ts').includes("<title>' + BRAND.mobileTitle + '</title>"), 'missing-bundle page title')

  // E0-FR-18: phone credentials move from the legacy localStorage keys once.
  {
    const NEW = k => BRAND.mobileStoragePrefix + 'remote.' + k
    const OLD = k => LEGACY_BRAND.mobileStoragePrefix + 'remote.' + k
    const KEYS = ['deviceId', 'secret', 'hostPlatform']
    const SECRET = 'ab'.repeat(32)
    const legacyCreds = (id = 'dev-legacy') => ({ [OLD('deviceId')]: id, [OLD('secret')]: SECRET, [OLD('hostPlatform')]: 'win32' })
    // Map-backed localStorage. failSet(key) decides per call whether setItem
    // throws (quota, private mode); dropSet makes writes vanish silently.
    function fakeStorage(initial = {}, opts = {}) {
      const map = new Map(Object.entries(initial))
      const log = []
      const api = {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem(k, v) {
          log.push('set ' + k)
          if (opts.failSet?.(k)) throw new Error('QuotaExceededError')
          if (!opts.dropSet) map.set(k, String(v))
        },
        removeItem(k) { log.push('remove ' + k); map.delete(k) },
      }
      return { map, log, api, opts }
    }
    const authKeys = s => [...s.map.keys()].filter(k => k.includes('remote.')).sort()
    const hasLegacy = s => [...s.map.keys()].some(k => k.startsWith(LEGACY_BRAND.mobileStoragePrefix))
    const loadAuth = s => load('src/mobile/src/lib/auth.ts', { localStorage: s.api, TextEncoder })

    // First load migrates, second load touches nothing.
    const s1 = fakeStorage(legacyCreds())
    let auth = loadAuth(s1)
    check(s1.log.length === 0, 'migration waits for the first read')
    assert.deepStrictEqual({ ...auth.getStoredAuth() }, { deviceId: 'dev-legacy', secretHex: SECRET }); checks++
    check(auth.getStoredHostPlatform() === 'win32', 'hostPlatform carried over')
    check(KEYS.every(k => s1.map.get(NEW(k)) === legacyCreds()[OLD(k)]), 'all three legacy values copied to the new keys')
    check(!hasLegacy(s1), 'legacy keys removed after the confirmed copy')
    const firstLog = s1.log.join('|')
    check(firstLog.indexOf('remove ') > firstLog.lastIndexOf('set '), 'legacy keys removed only after every write')
    s1.log.length = 0
    auth = loadAuth(s1)
    assert.deepStrictEqual({ ...auth.getStoredAuth() }, { deviceId: 'dev-legacy', secretHex: SECRET }); checks++
    check(s1.log.length === 0, 'second load writes and removes nothing')

    // Legacy pairing without a cached hostPlatform migrates the two credentials.
    const s2 = fakeStorage({ [OLD('deviceId')]: 'dev-2', [OLD('secret')]: SECRET })
    auth = loadAuth(s2)
    check(auth.getStoredAuth()?.deviceId === 'dev-2' && auth.getStoredHostPlatform() === '', 'migration without hostPlatform')
    assert.deepStrictEqual(authKeys(s2), [NEW('deviceId'), NEW('secret')]); checks++

    // setItem throwing: legacy values serve from memory and stay in storage.
    const s3 = fakeStorage(legacyCreds(), { failSet: () => true })
    auth = loadAuth(s3)
    assert.deepStrictEqual({ ...auth.getStoredAuth() }, { deviceId: 'dev-legacy', secretHex: SECRET }); checks++
    check(auth.getStoredHostPlatform() === 'win32', 'hostPlatform from memory when the write fails')
    assert.deepStrictEqual(Object.fromEntries(s3.map), legacyCreds()); checks++
    // Failing midway (deviceId written, secret refused) rolls the copy back.
    const s4 = fakeStorage(legacyCreds(), { failSet: k => k === NEW('secret') })
    auth = loadAuth(s4)
    check(auth.getStoredAuth()?.deviceId === 'dev-legacy', 'partial write still boots from memory')
    assert.deepStrictEqual(Object.fromEntries(s4.map), legacyCreds()); checks++
    // A write that does not read back is not trusted either.
    const s5 = fakeStorage(legacyCreds(), { dropSet: true })
    auth = loadAuth(s5)
    check(auth.getStoredAuth()?.deviceId === 'dev-legacy' && hasLegacy(s5), 'unconfirmed write keeps the legacy keys')
    // The next load retries once storage works again.
    s4.opts.failSet = undefined
    auth = loadAuth(s4)
    check(auth.getStoredAuth()?.deviceId === 'dev-legacy' && !hasLegacy(s4) && s4.map.get(NEW('secret')) === SECRET, 'next load retries the migration')

    // New keys plus legacy leftovers (a removeItem failed): the new keys win.
    const s6 = fakeStorage({ ...legacyCreds('dev-old'), [NEW('deviceId')]: 'dev-new', [NEW('secret')]: SECRET })
    auth = loadAuth(s6)
    check(auth.getStoredAuth()?.deviceId === 'dev-new' && !hasLegacy(s6), 'new keys win over legacy leftovers, which are removed')

    // A storage that throws on every call boots unpaired instead of crashing.
    const denied = () => { throw new Error('denied') }
    auth = load('src/mobile/src/lib/auth.ts', { TextEncoder, localStorage: { getItem: denied, setItem: denied, removeItem: denied } })
    check(auth.getStoredAuth() === null && auth.getStoredHostPlatform() === '', 'throwing storage reads as unpaired')
    assert.doesNotThrow(() => { auth.storeAuth('x', SECRET); auth.clearAuth(); auth.storeHostPlatform('linux') }); checks++

    // clearAuth after a failed migration wipes memory and storage: no resurrection.
    const s7 = fakeStorage(legacyCreds(), { failSet: () => true })
    auth = loadAuth(s7)
    check(auth.getStoredAuth() !== null, 'failed migration boots paired')
    auth.clearAuth()
    check(auth.getStoredAuth() === null && !hasLegacy(s7), 'clearAuth drops the in-memory fallback and the legacy keys')
    check(loadAuth(s7).getStoredAuth() === null, 'reload after clearAuth stays unpaired')

    // storeAuth after a failed migration leaves no legacy credential behind.
    const s8 = fakeStorage(legacyCreds('dev-old'), { failSet: () => true })
    auth = loadAuth(s8)
    auth.getStoredAuth()
    s8.opts.failSet = undefined
    auth.storeAuth('dev-new', 'cd'.repeat(32))
    check(!hasLegacy(s8) && s8.map.get(NEW('deviceId')) === 'dev-new', 'storeAuth removes the legacy keys')
    check(auth.getStoredAuth()?.deviceId === 'dev-new', 'storeAuth replaces the in-memory fallback')
    check(!LEGACY_RE.test(read('src/mobile/src/lib/auth.ts')), 'auth.ts reads the legacy prefix from LEGACY_BRAND only')

    // E0-FR-18 + E0-FR-19 through the real client: revocation, unpair, new
    // pairing, and a 1.14.1 phone reconnecting with no QR and no rePair.
    const { createHmac } = require('node:crypto')
    const hmac = (secretHex, msg) => createHmac('sha256', Buffer.from(secretHex, 'hex')).update(msg).digest('hex')
    const clientCode = buildSync({
      stdin: { contents: "export { client } from './src/mobile/src/lib/client'\nexport { store } from './src/mobile/src/lib/store'", resolveDir: root, loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') },
    }).outputFiles[0].text
    // Each call is a fresh page load against the given storage.
    function loadClient(storage, hash = '') {
      const sockets = []
      const timers = []
      let reloads = 0
      class FakeWebSocket {
        static OPEN = 1
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this) }
        send(data) { this.sent.push(JSON.parse(data)) }
        close() { this.readyState = 3 }
      }
      const mod = { exports: {} }
      vm.runInNewContext(clientCode, {
        module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, TextEncoder,
        localStorage: storage.api, WebSocket: FakeWebSocket,
        location: { hash, host: '192.168.1.20:4517', pathname: '/', search: '', reload: () => { reloads++ } },
        history: { replaceState() {} },
        document: { addEventListener() {}, visibilityState: 'visible' },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimeout() {},
        setInterval: () => 0, clearInterval() {},
      })
      const open = ws => { ws.readyState = 1; ws.onopen() }
      const deliver = (ws, msg) => ws.onmessage({ data: JSON.stringify({ v: 1, ...msg }) })
      return { ...mod.exports, sockets, timers, open, deliver, reloads: () => reloads }
    }
    const { PROTOCOL_VERSION, REMOTE_CLOSE } = load('src/shared/remote-protocol.ts')
    check(PROTOCOL_VERSION === 1, 'E0 keeps PROTOCOL_VERSION at 1')

    // A 1.14.1 phone loads the 2.0 bundle: migrated credentials authenticate.
    const p1 = fakeStorage(legacyCreds())
    let app = loadClient(p1)
    app.client.start()
    check(app.store.getState().phase === 'connecting' && app.sockets.length === 1, 'legacy pairing boots the auth path, not rePair or welcome')
    check(!hasLegacy(p1) && p1.map.get(NEW('deviceId')) === 'dev-legacy', 'boot migrated the keys')
    app.open(app.sockets[0])
    const hello = app.sockets[0].sent[0]
    check(hello.type === 'hello' && hello.v === 1 && hello.deviceId === 'dev-legacy', 'hello carries the legacy deviceId')
    app.deliver(app.sockets[0], { type: 'challenge', nonce: 'cafe01', proof: hmac(SECRET, hello.clientNonce) })
    const authMsg = app.sockets[0].sent[1]
    check(authMsg?.type === 'auth' && authMsg.deviceId === 'dev-legacy' && authMsg.hmac === hmac(SECRET, 'cafe01'), 'auth HMAC uses the migrated secret')

    // Page open across the desktop update: the socket drops and the backoff
    // reconnects with the credentials already in memory, without a reload.
    p1.map.clear()
    app.sockets[0].onclose({ code: 1006 })
    check(app.store.getState().phase === 'connecting' && app.timers.length === 1, 'drop schedules a backoff reconnect')
    app.timers.shift().fn()
    check(app.sockets.length === 2, 'backoff opens a new socket')
    app.open(app.sockets[1])
    check(app.sockets[1].sent[0].deviceId === 'dev-legacy' && app.store.getState().phase === 'connecting', 'reconnect reuses the in-memory deviceId with no rePair')
    check(app.reloads() === 0, 'reconnect needs no reload')

    // Revocation (4403) wipes new and legacy keys; reload stays unpaired.
    const p2 = fakeStorage(legacyCreds(), { failSet: () => true })
    app = loadClient(p2)
    app.client.start()
    check(app.store.getState().phase === 'connecting' && hasLegacy(p2), 'failed migration still connects from memory')
    app.open(app.sockets[0])
    app.sockets[0].onclose({ code: REMOTE_CLOSE.REVOKED })
    check(app.store.getState().phase === 'revoked' && authKeys(p2).length === 0, '4403 removes new and legacy credentials')
    app = loadClient(p2)
    app.client.start()
    check(app.store.getState().phase === 'welcome' && app.sockets.length === 0, 'no resurrection after revocation')

    // unpair() wipes both and reloads; the reload stays unpaired.
    const p3 = fakeStorage(legacyCreds())
    app = loadClient(p3)
    app.client.start()
    app.client.unpair()
    check(app.reloads() === 1 && !p3.map.has(NEW('deviceId')) && !p3.map.has(NEW('secret')) && !hasLegacy(p3), 'unpair removes new and legacy credentials')
    app = loadClient(p3)
    app.client.start()
    check(app.store.getState().phase === 'welcome', 'no resurrection after unpair')

    // A new pairing leaves no legacy credential behind.
    const p4 = fakeStorage(legacyCreds('dev-old'), { failSet: () => true })
    app = loadClient(p4)
    app.client.start()
    p4.opts.failSet = undefined
    app.client.startPairing('ABC123')
    app.client.submitPairing('Phone')
    const ws = app.sockets[app.sockets.length - 1]
    app.open(ws)
    check(ws.sent.some(m => m.type === 'pair' && m.code === 'ABC123'), 'pairing request sent')
    app.deliver(ws, { type: 'paired', deviceId: 'dev-new', secret: 'cd'.repeat(32) })
    check(p4.map.get(NEW('deviceId')) === 'dev-new' && p4.map.get(NEW('secret')) === 'cd'.repeat(32), 'pairing stores the new keys')
    check(!hasLegacy(p4), 'pairing removes the legacy keys')
  }

  // R20-01 scope: every file it rebrands is free of the legacy name.
  const scope = [
    'src/main/window.ts', 'src/main/index.ts', 'src/main/tray.ts', 'src/main/i18n.ts',
    'src/main/status/StatusManager.ts', 'src/main/status/DiscordNotifier.ts', 'src/main/remote/RemoteServer.ts',
    'src/main/pty/shellResolver.ts', 'src/shared/types.ts', 'src/shared/ipc-contract.ts',
    'src/renderer/index.html', 'src/renderer/components/titlebar/TitleBar.tsx', 'src/renderer/components/ui/Logo.tsx',
    'src/renderer/components/terminal/useXterm.ts', 'src/renderer/i18n/en.ts', 'src/renderer/i18n/es.ts',
    'src/renderer/components/remote/RemotePairingPrompt.tsx', 'src/renderer/components/settings/sections/NotificationsSection.tsx',
    'src/renderer/components/settings/sections/RemoteSection.tsx', 'src/renderer/components/settings/sections/UsageSection.tsx',
    'src/renderer/components/ui/UsageRing.tsx', 'src/renderer/App.tsx',
    'src/mobile/index.html', 'src/mobile/public/manifest.webmanifest', 'src/mobile/src/lib/i18n.ts',
  ]
  for (const file of scope) check(!LEGACY_RE.test(read(file)), `${file}: no legacy name`)

  // No en dash or em dash anywhere under src/ (style rule; check-brand extends it to the repo).
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  const offenders = walk(path.join(root, 'src')).filter(f => /\.(tsx?|html|css|json|webmanifest)$/.test(f) && DASH_RE.test(fs.readFileSync(f, 'utf8')))
  check(offenders.length === 0, `no en/em dash under src/: ${offenders.map(f => path.relative(root, f)).join(', ')}`)

  console.log(`PASS: ${checks} rebrand checks`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
