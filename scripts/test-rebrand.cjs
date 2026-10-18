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

  // E0-FR-21 / FR-24 (R20-08): release.yml uploads to a draft and publishes only
  // after the 16-asset gate. js-yaml ships with electron-builder (dev tree).
  {
    const yaml = require('js-yaml')
    const workflowText = read('.github/workflows/release.yml')
    const workflow = yaml.load(workflowText)
    const tagExpr = '${{ env.TAG }}', prereleaseExpr = "${{ contains(env.TAG, '-') }}"
    check(!LEGACY_RE.test(workflowText) && !DASH_RE.test(workflowText), 'release.yml: no legacy name and no en/em dash')
    check(workflow.env.TAG === '${{ github.event.inputs.tag || github.ref_name }}', 'release.yml: one TAG for push and workflow_dispatch')
    check(Object.keys(workflow.on).sort().join() === 'push,workflow_dispatch', 'release.yml: tag push and manual re-run triggers')
    const step = (job, name) => workflow.jobs[job].steps.find(s => s.name === name)
    const build = workflow.jobs.build
    check(build.strategy.matrix.include.map(l => l.os).join() === 'windows-2022,macos-latest,ubuntu-latest', 'release.yml: three build legs')
    const attach = step('build', 'Attach artifacts to draft release')
    check(attach && attach.uses === 'softprops/action-gh-release@v3', 'build: uploads with softprops')
    check(attach.with.draft === true, 'build: draft: true, the release stays invisible while legs upload')
    check(attach.with.tag_name === tagExpr && attach.with.prerelease === prereleaseExpr, 'build: same tag, rc tags are prereleases')
    check(!('generate_release_notes' in attach.with), 'build: no per-leg changelog')
    const stepIndex = name => build.steps.findIndex(s => s.name === name)
    check(stepIndex('Status regression tests') < stepIndex('Package artifacts') && stepIndex('Generate SHA-256 checksums') < stepIndex('Attach artifacts to draft release'), 'build: tests before packaging, checksums before upload')

    const notes = workflow.jobs['release-notes']
    check(notes.needs === 'build' && !notes.if, 'release-notes: runs only after every leg succeeds')
    const names = notes.steps.map(s => s.name)
    check(names.join() === 'Checkout,Verify release assets,Compose release notes,Publish release', 'release-notes: verify, compose, then publish')
    check(step('release-notes', 'Checkout').with.ref === tagExpr, 'release-notes: checks out the tag')
    const verify = step('release-notes', 'Verify release assets')
    check(verify.env.GH_TOKEN === '${{ github.token }}' && /gh release view "\$TAG" -R "\$GITHUB_REPOSITORY" --json assets/.test(verify.run), 'verify: reads the draft asset list')
    check(/node scripts\/check-release-assets\.cjs "\$RUNNER_TEMP\/assets\.json" "\$TAG" "\$version"/.test(verify.run) && /exit 1\s*$/.test(verify.run), 'verify: the 16-asset gate fails the job')
    check(!/\$\{\{/.test(verify.run) && !/\$\{\{/.test(step('release-notes', 'Compose release notes').run), 'release-notes: shell steps read the tag from env, no expression injection')
    check(step('release-notes', 'Compose release notes').run.includes('docs/release-notes/$TAG.md'), 'compose: body from docs/release-notes/<tag>.md')
    const publish = step('release-notes', 'Publish release')
    check(publish.uses === 'softprops/action-gh-release@v3' && publish.with.draft === false, 'publish: draft: false')
    check(publish.with.name === 'SnAgentsOS ' + tagExpr && publish.with.tag_name === tagExpr, 'publish: titled SnAgentsOS <tag>')
    check(publish.with.body_path === '${{ runner.temp }}/notes.md' && publish.with.generate_release_notes === true && publish.with.append_body === false, 'publish: notes file plus changelog, replaced not appended')
    check(publish.with.prerelease === prereleaseExpr, 'publish: rc tags stay prereleases, never latest')

    // The checksum and upload globs pick exactly the 8 distributables out of a
    // realistic electron-builder output tree.
    const globRe = glob => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
    const v = '2.0.0'
    const distributables = [
      `SnAgentsOS-${v}-setup.exe`, `SnAgentsOS-${v}-portable.exe`, `SnAgentsOS-${v}.dmg`, `SnAgentsOS-${v}-arm64.dmg`,
      `SnAgentsOS-${v}-mac.zip`, `SnAgentsOS-${v}-arm64-mac.zip`, `SnAgentsOS-${v}.AppImage`, `snagentsos_${v}_amd64.deb`,
    ]
    const tree = [
      ...distributables, `SnAgentsOS-${v}-setup.exe.blockmap`, `SnAgentsOS-${v}.dmg.blockmap`, `SnAgentsOS-${v}-mac.zip.blockmap`,
      'latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'builder-debug.yml', 'builder-effective-config.yaml', '__uninstaller-nsis-snagentsos.exe',
      'win-unpacked/SnAgentsOS.exe', 'win-unpacked/resources/elevate.exe', 'win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/build/Release/OpenConsole.exe',
      'linux-unpacked/snagentsos', 'mac/SnAgentsOS.app/Contents/MacOS/SnAgentsOS',
    ]
    const findNames = [...step('build', 'Generate SHA-256 checksums').run.matchAll(/-name '([^']+)'/g)].map(m => m[1])
    check(findNames.length === 5, 'checksums: five name patterns')
    const hashed = tree.filter(p => findNames.some(n => globRe(n).test(path.posix.basename(p))))
    check(hashed.sort().join() === [...distributables].sort().join(), 'checksums: only the 8 distributables get a .sha256')
    const uploadGlobs = attach.with.files.trim().split('\n').map(s => s.trim())
    check(uploadGlobs.every(g => g.startsWith('release/**/')), 'upload: globs under release/')
    const uploadTree = [...tree, ...hashed.map(p => p + '.sha256')]
    const uploaded = uploadTree.filter(p => uploadGlobs.some(g => globRe(g.slice('release/**/'.length)).test(path.posix.basename(p))))
    check(uploaded.length === 16, `upload: exactly 16 files leave the runners (${uploaded.length})`)

    // The gate itself.
    const gate = require(path.join(root, 'scripts/check-release-assets.cjs'))
    const healthy = ver => {
      const d = distributables.map(n => n.split(v).join(ver))
      return [...d, ...d.map(n => n + '.sha256')]
    }
    check(gate.EXPECTED_ASSETS === 16 && gate.KINDS.length === 8, 'gate: 8 distributables, 16 assets')
    check(gate.checkReleaseAssets(uploaded.map(p => path.posix.basename(p)), { version: v }).ok, 'gate: the uploaded set passes')
    const rc = gate.checkReleaseAssets({ assets: healthy('2.0.0-rc.1').map(name => ({ name, size: 1 })) })
    check(rc.ok && rc.version === '2.0.0-rc.1', 'gate: gh JSON shape and a prerelease version')
    const fails = (list, needle, opts) => { const r = gate.checkReleaseAssets(list, opts); return !r.ok && r.errors.some(e => e.includes(needle)) }
    const good = healthy(v)
    check(fails(good.filter(n => n !== `SnAgentsOS-${v}-setup.exe.sha256`), `SnAgentsOS-${v}-setup.exe is missing its .sha256`), 'gate: a missing .sha256 keeps the draft')
    check(fails(good.filter(n => !n.startsWith(`snagentsos_${v}`)), 'missing linux-deb'), 'gate: a missing leg keeps the draft (14 assets)')
    check(fails([...good, 'notes.txt'], 'expected 16 assets, found 17') && fails([...good, 'notes.txt'], 'unexpected asset notes.txt'), 'gate: an extra asset keeps the draft')
    const legacy = good.map(n => n.replace('SnAgentsOS-', 'SnMultiCC-').replace('snagentsos_', 'snmulticc_'))
    check(legacy.length === 16 && fails(legacy, 'unexpected asset SnMultiCC-'), 'gate: legacy-named assets are rejected')
    const swapped = good.filter(n => n !== `SnAgentsOS-${v}-arm64.dmg`).concat(`SnAgentsOS-${v}-x.dmg`)
    check(fails(swapped, 'mac-dmg-x64 appears 2 times') && fails(swapped, 'missing mac-dmg-arm64'), 'gate: every kind exactly once')
    const mixed = good.map(n => n.startsWith(`SnAgentsOS-${v}-portable`) ? n.replace(v, '1.14.1') : n)
    check(fails(mixed, 'mix versions'), 'gate: one version across distributables')
    check(fails(good, 'expected 2.0.1', { version: '2.0.1' }), 'gate: version must match package.json at the tag')
    check(fails([...good.slice(0, 15), good[0]], 'duplicate asset names'), 'gate: duplicate names rejected')
    check(gate.TAG_RE.test('v2.0.0') && gate.TAG_RE.test('v2.0.0-rc.1') && !gate.TAG_RE.test('v2.0') && !gate.TAG_RE.test('../v2.0.0') && !gate.TAG_RE.test('v2.0.0-rc/../x'), 'gate: tag format')

    // CLI exit codes, as the workflow runs it.
    const { spawnSync } = require('node:child_process')
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'snaos-release-'))
    try {
      const run = (list, tag, ver) => {
        const file = path.join(tmp, 'assets.json')
        fs.writeFileSync(file, JSON.stringify({ assets: list.map(name => ({ name })) }))
        return spawnSync(process.execPath, [path.join(root, 'scripts/check-release-assets.cjs'), file, tag, ...(ver ? [ver] : [])], { encoding: 'utf8' })
      }
      const ok = run(good, 'v2.0.0', v)
      check(ok.status === 0 && ok.stdout.includes('16 assets'), 'cli: healthy release exits 0')
      const bad = run(good.slice(1), 'v2.0.0', v)
      check(bad.status === 1 && bad.stderr.includes('stays a draft'), 'cli: incomplete release exits 1')
      check(run(good, '../../etc', v).status === 1, 'cli: invalid tag exits 1')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }

  // No en dash or em dash anywhere under src/ (style rule; check-brand extends it to the repo).
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  const offenders = walk(path.join(root, 'src')).filter(f => /\.(tsx?|html|css|json|webmanifest)$/.test(f) && DASH_RE.test(fs.readFileSync(f, 'utf8')))
  check(offenders.length === 0, `no en/em dash under src/: ${offenders.map(f => path.relative(root, f)).join(', ')}`)

  console.log(`PASS: ${checks} rebrand checks`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
