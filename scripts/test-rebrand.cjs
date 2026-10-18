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
function load(file, overrides = {}, sharedDir = path.join(root, 'src/shared')) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': sharedDir } }).outputFiles[0].text
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

  await updaterChecks(BRAND, en, es)

  // No en dash or em dash anywhere under src/ (style rule; check-brand extends it to the repo).
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  const offenders = walk(path.join(root, 'src')).filter(f => /\.(tsx?|html|css|json|webmanifest)$/.test(f) && DASH_RE.test(fs.readFileSync(f, 'utf8')))
  check(offenders.length === 0, `no en/em dash under src/: ${offenders.map(f => path.relative(root, f)).join(', ')}`)

  console.log(`PASS: ${checks} rebrand checks`)
}

// R20-06: updater (E0-FR-06, FR-25 and the swap side of FR-33). updater.ts runs
// against a stubbed electron (net, app, shell), https, child_process and an os
// whose tmpdir() is a throwaway folder, so nothing touches the network, spawns
// a process or writes outside that folder.
async function updaterChecks(BRAND, en, es) {
  const os = require('node:os')
  const crypto = require('node:crypto')
  const { EventEmitter } = require('node:events')
  const { Readable } = require('node:stream')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-r2006-'))
  const version = '2.0.0'
  const base = `https://github.com/${BRAND.repo}/releases/download/v${version}/`
  const latestUrl = `https://api.github.com/repos/${BRAND.repo}/releases/latest`
  const payload = Buffer.from('fake SnAgentsOS 2.0.0 binary')
  const payloadSha = crypto.createHash('sha256').update(payload).digest('hex')
  // The 16 assets of v2.0.0 as electron-builder names them (FR-21), API order.
  const distributables = [
    'SnAgentsOS-2.0.0-arm64-mac.zip', 'SnAgentsOS-2.0.0-arm64.dmg', 'SnAgentsOS-2.0.0-mac.zip', 'SnAgentsOS-2.0.0-portable.exe',
    'SnAgentsOS-2.0.0-setup.exe', 'SnAgentsOS-2.0.0.AppImage', 'SnAgentsOS-2.0.0.dmg', 'snagentsos_2.0.0_amd64.deb',
  ]
  const asset = name => ({ name, browser_download_url: base + name, size: name.endsWith('.sha256') ? 64 : payload.length })
  const release = names => ({ tag_name: `v${version}`, body: '', html_url: `https://github.com/${BRAND.repo}/releases/tag/v${version}`, assets: names.map(asset) })
  const full = distributables.flatMap(n => [n, `${n}.sha256`])
  check(full.length === 16, 'v2.0.0 fixture has the 16 release assets')
  {
    // The fixture follows electron-builder.yml: setup and portable come from its
    // artifactName templates, dmg / zip / AppImage keep the builder defaults and
    // the deb is named after package.json "name" (BRAND.packageName).
    const yml = read('electron-builder.yml')
    const templates = [...yml.matchAll(/^\s+artifactName:\s*(\S+)\s*$/gm)].map(m => m[1])
    const rendered = templates.map(t => t.replace(/\$\{productName\}/g, BRAND.productName).replace(/\$\{version\}/g, version).replace(/\$\{ext\}/g, 'exe'))
    check(templates.length === 2 && rendered.includes('SnAgentsOS-2.0.0-setup.exe') && rendered.includes('SnAgentsOS-2.0.0-portable.exe'), `electron-builder artifactName renders the fixture names: ${rendered.join(', ')}`)
    check(distributables.includes(`${BRAND.packageName}_${version}_amd64.deb`), 'deb name follows the package name')
  }

  // routes(url) may answer a net request with { redirect } or { status, body };
  // anything it leaves undefined falls through to the release JSON, the sidecar
  // or a 404. downloadRedirects maps a download URL to the CDN hop GitHub sends.
  function loadUpdater({ platform, arch = 'x64', env = {}, rel = release(full), sidecar = () => `${payloadSha}  file\n`, routes = () => undefined, downloadRedirects = {}, appVersion = '1.99.0', sharedDir }) {
    const log = { requests: [], followed: [], aborted: 0, downloads: [], spawns: [], opened: [], errors: [] }
    const respond = (req, status, body) => setImmediate(() => {
      const res = new EventEmitter(); res.statusCode = status
      req.emit('response', res)
      res.emit('data', Buffer.from(body)); res.emit('end')
    })
    const net = {
      request(opts) {
        const req = new EventEmitter()
        const headers = {}
        let current = opts.url
        let pending = null
        req.setHeader = (k, v) => { headers[k] = v }
        const dispatch = () => {
          log.requests.push({ url: current, redirect: opts.redirect, headers })
          const route = routes(current)
          if (route?.redirect) {
            pending = route.redirect
            setImmediate(() => req.emit('redirect', route.status ?? 301, 'GET', route.redirect))
          } else if (route) respond(req, route.status, route.body)
          else if (current === latestUrl) respond(req, 200, JSON.stringify(rel))
          else if (current.endsWith('.sha256')) respond(req, 200, sidecar(current))
          else respond(req, 404, '')
        }
        req.followRedirect = () => { log.followed.push(pending); current = pending; dispatch() }
        req.abort = () => { log.aborted++ }
        req.end = dispatch
        return req
      },
    }
    const https = {
      get(url, opts, cb) {
        log.downloads.push({ url, headers: opts.headers })
        const req = new EventEmitter(); req.setTimeout = () => req; req.destroy = () => {}
        const location = downloadRedirects[url]
        setImmediate(() => {
          const res = Readable.from(location ? [] : [payload])
          res.statusCode = location ? 302 : 200
          res.headers = location ? { location } : {}
          cb(res)
        })
        return req
      },
    }
    const electron = {
      app: { getVersion: () => appVersion, getPath: () => tmp },
      net,
      shell: { openPath: async f => { log.opened.push(f); return '' }, showItemInFolder: () => {} },
    }
    const childProcess = { spawn: (command, args, options) => { log.spawns.push({ command, args, options }); return { pid: 4242, on() {}, unref() {} } } }
    const stubs = { electron, https, child_process: childProcess, os: { ...os, tmpdir: () => tmp } }
    const mod = load('src/main/updater.ts', {
      require: id => stubs[id] ?? require(id),
      process: { ...process, platform, arch, env, argv: [process.execPath] },
      console: { ...console, error: (...args) => log.errors.push(args.join(' ')) },
    }, sharedDir)
    return { mod, log }
  }
  const tmpEntries = () => fs.readdirSync(tmp)

  try {
    // pickAsset by pattern over the real v2.0.0 names, in API order and reversed.
    const cases = [
      { label: 'win installed', platform: 'win32', want: 'SnAgentsOS-2.0.0-setup.exe', kind: 'win-installer' },
      { label: 'win portable', platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: tmp }, want: 'SnAgentsOS-2.0.0-portable.exe', kind: 'win-portable' },
      { label: 'mac x64', platform: 'darwin', want: 'SnAgentsOS-2.0.0.dmg', kind: 'mac-dmg' },
      { label: 'mac arm64', platform: 'darwin', arch: 'arm64', want: 'SnAgentsOS-2.0.0-arm64.dmg', kind: 'mac-dmg' },
      { label: 'linux AppImage', platform: 'linux', env: { APPIMAGE: '/opt/SnAgentsOS.AppImage' }, want: 'SnAgentsOS-2.0.0.AppImage', kind: 'linux-appimage' },
      { label: 'linux deb', platform: 'linux', want: 'snagentsos_2.0.0_amd64.deb', kind: 'linux-deb' },
    ]
    for (const c of cases) {
      const { pickAsset } = loadUpdater(c).mod
      for (const order of [full, [...full].reverse()]) {
        const m = pickAsset(order.map(asset))
        check(m && m.asset.name === c.want && m.kind === c.kind, `pickAsset ${c.label}: ${m?.asset.name}`)
        check(m.sha256Url === base + c.want + '.sha256', `pickAsset ${c.label}: sidecar`)
      }
      const bare = pickAsset(distributables.map(asset))
      check(bare && bare.asset.name === c.want && bare.sha256Url === null, `pickAsset ${c.label}: no sidecar gives a null sha256Url`)
    }
    {
      const { pickAsset } = loadUpdater(cases[1]).mod
      const onlySetup = ['SnAgentsOS-2.0.0-setup.exe', 'SnAgentsOS-2.0.0-setup.exe.sha256'].map(asset)
      check(pickAsset(onlySetup) === null, 'portable never falls back to the setup')
    }

    // E0-FR-06 + FR-33 swap: portable update after the first-run rename.
    {
      const oldExe = path.join(tmp, 'SnMultiCC-1.14.1-portable.exe')
      const newExe = path.join(tmp, 'SnAgentsOS-portable.exe')
      const env = { PORTABLE_EXECUTABLE_DIR: tmp, PORTABLE_EXECUTABLE_FILE: oldExe }
      const { mod, log } = loadUpdater({ platform: 'win32', env })
      const info = await mod.checkForUpdate()
      check(info.available && info.installable && info.installKind === 'win-portable' && info.latestVersion === version, 'portable sees 2.0.0 as installable')
      check(log.requests[0].url === latestUrl && log.requests[0].redirect === 'manual', 'latest release queried on the new repo with manual redirects')
      // R20-04 renames the running exe and rewrites the env after the check.
      env.PORTABLE_EXECUTABLE_FILE = newExe
      const progress = []
      const result = await mod.downloadAndInstall(p => progress.push(p))
      check(result.relaunching === true, 'portable swap relaunches')
      check(log.requests.some(r => r.url === base + 'SnAgentsOS-2.0.0-portable.exe.sha256'), 'sidecar fetched before the download')
      check(log.downloads.length === 1 && log.downloads[0].url === base + 'SnAgentsOS-2.0.0-portable.exe', 'portable asset downloaded')
      const agents = [...log.requests.map(r => r.headers['User-Agent']), ...log.downloads.map(d => d.headers['User-Agent'])]
      check(agents.length >= 3 && agents.every(a => a === 'SnAgentsOS/1.99.0'), `User-Agent is SnAgentsOS/<version>: ${agents.join(', ')}`)
      check(progress.length > 0 && progress[progress.length - 1].percent === 100, 'download progress reaches 100')
      const [spawn] = log.spawns
      check(log.spawns.length === 1 && spawn.command === 'cmd.exe' && spawn.args[0] === '/c', 'swap helper spawned once')
      check(spawn.options.env.DST === newExe, `swap writes over the renamed exe: ${spawn.options.env.DST}`)
      check(!Object.values(spawn.options.env).some(v => typeof v === 'string' && v.includes('SnMultiCC-1.14.1')), 'swap never recreates the old exe name')
      const script = spawn.args[1]
      check(path.basename(path.dirname(script)).startsWith('snagentsos-swap-'), 'swap script under snagentsos-swap-')
      check(fs.readFileSync(script, 'utf8').includes('copy /Y "%SRC%" "%DST%"'), 'swap script takes its target from the environment')
      check(path.basename(path.dirname(spawn.options.env.SRC)).startsWith('snagentsos-update-'), 'download under snagentsos-update-')
      check(fs.readFileSync(spawn.options.env.SRC).equals(payload), 'downloaded bytes are the verified asset')
      check(!tmpEntries().some(e => /snmulticc/i.test(e)), 'no legacy temp prefix created')
    }

    // E0-FR-25: no sidecar, no install, on every installable kind.
    for (const c of cases) {
      const { mod, log } = loadUpdater({ ...c, rel: release(distributables) })
      const before = tmpEntries().length
      const info = await mod.checkForUpdate()
      check(info.installable && info.installKind === c.kind, `${c.label}: asset found without sidecar`)
      let error = null
      try { await mod.downloadAndInstall(() => {}) } catch (err) { error = err }
      check(error?.message === 'missing-checksum', `${c.label}: rejects with missing-checksum (${error?.message})`)
      check(log.downloads.length === 0 && log.spawns.length === 0 && log.opened.length === 0, `${c.label}: nothing downloaded, spawned or opened`)
      check(tmpEntries().length === before, `${c.label}: no temp folder left behind`)
    }

    // A sidecar that does not match still blocks the install and removes the file.
    {
      const { mod, log } = loadUpdater({ platform: 'win32', sidecar: () => `${'0'.repeat(64)}  x\n` })
      const before = tmpEntries().length
      await mod.checkForUpdate()
      let error = null
      try { await mod.downloadAndInstall(() => {}) } catch (err) { error = err }
      check(/SHA-256 verification/.test(error?.message ?? ''), 'mismatched sidecar rejects')
      check(log.spawns.length === 0 && log.opened.length === 0, 'mismatched sidecar runs nothing')
      check(log.downloads.length === 1 && tmpEntries().length === before, 'mismatched download and its folder removed')
    }

    // FR-36 counterpart of the FR-33 swap: the AppImage target is read at apply
    // time too, so a rename (and process.env.APPIMAGE rewrite) before the update
    // is honored.
    {
      const env = { APPIMAGE: path.join(tmp, 'Old.AppImage') }
      const { mod, log } = loadUpdater({ platform: 'linux', env })
      await mod.checkForUpdate()
      env.APPIMAGE = path.join(tmp, 'SnAgentsOS.AppImage')
      const result = await mod.downloadAndInstall(() => {})
      const [spawn] = log.spawns
      check(result.relaunching === true && log.spawns.length === 1 && spawn.command === '/bin/bash', 'AppImage swap helper spawned')
      check(spawn.options.env.DST === env.APPIMAGE, `AppImage swap writes over the current APPIMAGE: ${spawn.options.env.DST}`)
      check(path.basename(path.dirname(spawn.args[0])).startsWith('snagentsos-swap-'), 'AppImage swap script under snagentsos-swap-')
    }

    // Redirects on the release query: an allowlisted 301 is followed, anything
    // else is refused before a single byte of it is read.
    {
      const alias = 'https://api.github.com/repositories/987654321/releases/latest'
      const { mod, log } = loadUpdater({ platform: 'win32', routes: url => url === latestUrl ? { redirect: alias } : url === alias ? { status: 200, body: JSON.stringify(release(full)) } : undefined })
      const info = await mod.checkForUpdate()
      check(info.available && info.installKind === 'win-installer' && log.followed.join() === alias, 'allowlisted 301 on the release query is followed')
      const evil = loadUpdater({ platform: 'win32', routes: url => url === latestUrl ? { redirect: 'https://evil.example.com/releases/latest' } : undefined })
      const refused = await evil.mod.checkForUpdate()
      check(!refused.available && /untrusted host/.test(refused.error ?? '') && evil.log.followed.length === 0 && evil.log.aborted === 1 && evil.log.errors.length === 1,`off-list redirect refused: ${refused.error}`)
      const plain = loadUpdater({ platform: 'win32', routes: url => url === latestUrl ? { redirect: 'http://api.github.com/x' } : undefined })
      check(!(await plain.mod.checkForUpdate()).available && plain.log.followed.length === 0, 'non-https redirect refused')
    }

    // An installed 1.14.x after the repo rename (E0-FR-16, W0). updater.ts is
    // the 1.14.1 code except for the BRAND constants and FR-25, so it is loaded
    // with a 1.x BRAND: it queries the old repo, follows GitHub's 301 to the
    // repository id, picks the SnAgentsOS assets by pattern and verifies the
    // sidecar across the CDN redirects before running the setup.
    {
      const { LEGACY_BRAND } = load('src/shared/brand.ts')
      const legacyShared = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-r2006-shared-'))
      try {
        fs.cpSync(path.join(root, 'src/shared'), legacyShared, { recursive: true })
        const legacyBrand = { ...BRAND, productName: LEGACY_BRAND.productName, repo: `ValentinTarnovsky/${LEGACY_BRAND.productName}`, tempPrefix: LEGACY_BRAND.tempPrefix }
        fs.writeFileSync(path.join(legacyShared, 'brand.ts'), `export const BRAND = ${JSON.stringify(legacyBrand)} as const\n`)
        const oldLatest = `https://api.github.com/repos/${legacyBrand.repo}/releases/latest`
        const alias = 'https://api.github.com/repositories/987654321/releases/latest'
        const cdn = name => `https://release-assets.githubusercontent.com/github-production-release-asset/987654321/${name}`
        const setup = 'SnAgentsOS-2.0.0-setup.exe'
        const routes = url => {
          if (url === oldLatest) return { redirect: alias }
          if (url === alias) return { status: 200, body: JSON.stringify(release(full)) }
          if (url === base + setup + '.sha256') return { status: 302, redirect: cdn(setup + '.sha256') }
          if (url === cdn(setup + '.sha256')) return { status: 200, body: `${payloadSha}  ${setup}\n` }
          if (url === latestUrl) return { status: 404, body: '' }
          return undefined
        }
        for (const c of cases) {
          const { pickAsset } = loadUpdater({ ...c, sharedDir: legacyShared }).mod
          const m = pickAsset(full.map(asset))
          check(m && m.asset.name === c.want && m.kind === c.kind && m.sha256Url === base + c.want + '.sha256', `1.14.x pickAsset ${c.label}: ${m?.asset.name}`)
        }
        const { mod, log } = loadUpdater({ platform: 'win32', appVersion: '1.14.1', routes, downloadRedirects: { [base + setup]: cdn(setup) }, sharedDir: legacyShared })
        const info = await mod.checkForUpdate()
        check(log.requests[0].url === oldLatest && log.followed[0] === alias, '1.14.x queries the old repo and follows the 301')
        check(info.available && info.installable && info.installKind === 'win-installer' && info.latestVersion === version, `1.14.x sees 2.0.0 as installable: ${info.error ?? ''}`)
        const result = await mod.downloadAndInstall(() => {})
        check(log.followed.includes(cdn(setup + '.sha256')), '1.14.x follows the sidecar to the asset CDN')
        check(log.downloads.map(d => d.url).join() === [base + setup, cdn(setup)].join(), '1.14.x follows the download to the asset CDN')
        const [spawn] = log.spawns
        check(result.relaunching === false && log.spawns.length === 1 && path.basename(spawn.command) === setup, '1.14.x runs the verified SnAgentsOS setup')
        check(fs.readFileSync(spawn.command).equals(payload), '1.14.x setup bytes match the sidecar')
      } finally {
        fs.rmSync(legacyShared, { recursive: true, force: true })
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // The renderer turns the IPC-wrapped error into update.error.missingChecksum.
  check(en['update.error.missingChecksum'] === "The release doesn't publish a checksum; not installing for safety.", 'en missingChecksum text')
  check(es['update.error.missingChecksum'] === 'El release no publica el checksum; no se instala por seguridad.', 'es missingChecksum text')
  {
    const snApi = { updates: { downloadAndInstall: async () => { throw new Error("Error invoking remote method 'update:install': Error: missing-checksum") } } }
    const { useUpdaterStore, installErrorText } = load('src/renderer/lib/updater.ts', { window: { snApi } })
    await useUpdaterStore.getState().install()
    const stored = useUpdaterStore.getState().installError
    check(stored === 'missing-checksum', `store keeps the missing-checksum code: ${stored}`)
    const t = (key, vars) => (key === 'update.installFailed' ? en[key].replace('{error}', vars.error) : en[key])
    check(installErrorText(t, stored) === en['update.error.missingChecksum'], 'missing-checksum shows its own message')
    check(installErrorText(t, 'HTTP 500') === 'Update failed: HTTP 500', 'other errors keep update.installFailed')
  }
  for (const file of ['src/main/updater.ts', 'src/renderer/lib/updater.ts']) check(!LEGACY_RE.test(read(file)), `${file}: no legacy name`)
  check(read('src/renderer/components/updates/UpdateModal.tsx').includes('installErrorText(t, error)') && read('src/renderer/components/settings/sections/UpdatesSection.tsx').includes('installErrorText(t, installError)'), 'both update views render installErrorText')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
