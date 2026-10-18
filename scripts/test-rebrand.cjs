// SnAgentsOS rebrand checks (E0). Same harness as test-status.cjs: esbuild +
// vm, check() counts assertions, one PASS line at the end. Each work package of
// the rebrand adds its own section below.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}, external = []) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', ...external], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
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

  // E0-FR-05: pty env, inherited PATH and the Codex launcher. Every path lives
  // in a temp tree injected through an electron stub.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), BRAND.tempPrefix + 'env-test-'))
    try {
      const appData = path.join(tmp, 'appdata'), userData = path.join(appData, BRAND.packageName)
      const electron = { app: { getPath: name => ({ appData, userData })[name] } }
      const withElectron = id => id === 'electron' ? electron : require(id)
      const legacyBin = path.join(appData, LEGACY_BRAND.packageName, 'status-bin'), currentBin = path.join(userData, 'status-bin')
      const tools = path.join(tmp, 'tools')
      const legacyVar = LEGACY_BRAND.envPrefix + 'CONSOLE_ID'
      const inherited = { [legacyVar]: 'old-pane', [AGENT_ENV.ptyId]: 'parent-pty', KEEP: 'yes' }
      const resolver = env => load('src/main/pty/shellResolver.ts', { require: withElectron, process: { ...process, env } })

      check(resolver({}).statusBinDirs().join() === [currentBin, legacyBin].join(), 'status-bin dirs: current userData and the 1.x userData')
      for (const key of ['PATH', 'Path']) {
        const { cleanEnv } = resolver({ ...inherited, [key]: [legacyBin, tools, currentBin].join(path.delimiter) })
        const env = cleanEnv({ SNAOS_FOO: 'preset', [AGENT_ENV.consoleId]: 'pane' })
        check(!(legacyVar in env) && !(AGENT_ENV.ptyId in env), `${key}: inherited legacy and new prefixed vars dropped`)
        check(env.SNAOS_FOO === 'preset' && env[AGENT_ENV.consoleId] === 'pane' && env.KEEP === 'yes', `${key}: extra merged unfiltered, unrelated vars kept`)
        check(env[key] === tools, `${key}: both status-bin entries stripped, the rest kept`)
      }
      if (process.platform === 'win32') {
        const lowerVar = LEGACY_BRAND.envPrefix.toLowerCase() + 'pty_id'
        const { cleanEnv } = resolver({ Path: ['"' + legacyBin.toUpperCase() + '\\"', tools, ''].join(';'), [lowerVar]: 'x' })
        const env = cleanEnv()
        check(env.Path === tools + ';', 'Windows: status-bin match ignores case, quotes and a trailing slash; empty entries untouched')
        check(!(lowerVar in env), 'Windows: env prefix filter ignores case')
      }

      // A real spawn through PtyManager with node-pty stubbed.
      let spawned = null
      const fakePty = { onData() {}, onExit() {}, write() {}, kill() {}, resize() {}, pause() {}, resume() {} }
      const { PtyManager } = load('src/main/pty/PtyManager.ts', {
        require: id => id === 'node-pty' ? { spawn: (_shell, _args, opts) => { spawned = opts; return fakePty } } : withElectron(id),
        process: { ...process, env: { ...inherited, PATH: [legacyBin, tools].join(path.delimiter) } },
      }, ['node-pty'])
      const manager = new PtyManager(() => null, () => ({ [AGENT_ENV.codexShim]: currentBin }))
      const ptyId = manager.spawn({ paneId: 'pane-1', cols: 80, rows: 24, cwd: tmp })
      check(spawned.env[AGENT_ENV.consoleId] === 'pane-1' && spawned.env[AGENT_ENV.ptyId] === ptyId, 'pty receives SNAOS_CONSOLE_ID and SNAOS_PTY_ID')
      check(!Object.keys(spawned.env).some(k => k.startsWith(LEGACY_BRAND.envPrefix)), 'pty env carries no legacy variable')
      check(spawned.env.PATH === [currentBin, tools].join(path.delimiter), 'pty PATH: own shim first, inherited 1.x status-bin gone')

      // Codex lookup skips both launchers, even when they hold a codex binary.
      const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
      for (const dir of [legacyBin, currentBin, tools]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, exe), '') }
      const bridgeEnv = { PATH: [legacyBin, currentBin, tools].join(path.delimiter) }
      const { CodexBridge } = load('src/main/status/CodexBridge.ts', { require: withElectron, process: { ...process, env: bridgeEnv } })
      const lookup = new CodexBridge(() => currentBin, 'runtime.js', () => {})
      check(lookup.findExecutable() === path.join(tools, exe), 'findExecutable ignores the current and the 1.x status-bin')

      const bridge = new CodexBridge(() => currentBin, path.join(tmp, 'runtime.js'), () => {})
      bridge.findExecutable = () => process.execPath
      try {
        await bridge.configure(true)
        const env = bridge.environment('pty', 'pane', tmp)
        check(Object.keys(env).sort().join() === [AGENT_ENV.codexUrl, AGENT_ENV.codexToken, AGENT_ENV.realCodex, AGENT_ENV.codexShim].sort().join(), 'Codex env uses the SNAOS_ names')
        if (process.platform === 'win32') {
          const launcher = fs.readFileSync(path.join(currentBin, 'codex.cmd'), 'utf8')
          check(launcher.includes(' --snaos-prepare %*') && launcher.includes(' --snaos-end\r\n'), 'codex.cmd passes the new flags')
          check(launcher.includes(`"%${AGENT_ENV.realCodex}%" --remote "%${AGENT_ENV.codexUrl}%" --remote-auth-token-env ${AGENT_ENV.codexToken} %*`), 'codex.cmd runs the real CLI with the new names')
          check(launcher.includes(`set "${AGENT_ENV.codexExit}=%errorlevel%"`) && launcher.includes(`exit /b %${AGENT_ENV.codexExit}%`), 'codex.cmd keeps the exit code in SNAOS_CODEX_EXIT')
          check(!LEGACY_RE.test(launcher), 'codex.cmd carries no legacy name')
        } else {
          check(!LEGACY_RE.test(fs.readFileSync(path.join(currentBin, 'codex'), 'utf8')), 'codex launcher carries no legacy name')
        }
      } finally { bridge.dispose() }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }
  {
    // statusRuntime reads only the new names and flags.
    const run = async (argv, env) => {
      const sent = [], errors = []
      let launched = null, exitCode
      class LaunchSocket extends require('events').EventEmitter {
        constructor(_url, opts) { super(); this.auth = opts.headers.Authorization; process.nextTick(() => this.emit('open')) }
        send(raw) { sent.push({ auth: this.auth, ...JSON.parse(raw) }); process.nextTick(() => this.emit('message', Buffer.from('{"ok":true}'))) }
        close() { this.emit('close') }
      }
      const proc = { ...process, argv: ['node', 'runtime', ...argv], env, exit: code => { exitCode = code; throw new Error('exit') } }
      try {
        load('src/main/status/statusRuntime.ts', {
          process: proc, console: { ...console, error: msg => errors.push(msg) },
          require: id => id === 'ws' ? { WebSocket: LaunchSocket } : id === 'child_process' ? { spawn: (_exe, args) => { launched = args; return new (require('events').EventEmitter)() } } : require(id),
        })
      } catch (error) { if (error.message !== 'exit') throw error }
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
      return { sent, errors, launched, exitCode: exitCode ?? proc.exitCode }
    }
    const env = { [AGENT_ENV.realCodex]: 'codex', [AGENT_ENV.codexUrl]: 'ws://127.0.0.1:1', [AGENT_ENV.codexToken]: 'tok', [AGENT_ENV.codexExit]: '3' }
    const end = await run(['--snaos-end'], env)
    check(end.sent.length === 1 && end.sent[0].exitCode === 3 && end.sent[0].auth === 'Launch tok' && end.launched === null, '--snaos-end reports SNAOS_CODEX_EXIT with the SNAOS_CODEX_TOKEN')
    const prepare = await run(['--snaos-prepare'], env)
    check(prepare.sent.length === 1 && typeof prepare.sent[0].cwd === 'string' && prepare.launched === null && prepare.exitCode === 0, '--snaos-prepare sends the context and does not launch')
    const direct = await run([], env)
    check(direct.launched?.join(' ') === `--remote ws://127.0.0.1:1 --remote-auth-token-env ${AGENT_ENV.codexToken}`, 'direct launch names SNAOS_CODEX_TOKEN')
    const legacy = await run(['--' + LEGACY_BRAND.packageName + '-prepare'], { [LEGACY_BRAND.envPrefix + 'REAL_CODEX']: 'codex' })
    check(legacy.exitCode === 1 && legacy.errors[0] === `${BRAND.productName}: Codex executable unavailable`, 'legacy variables are not read; the error names the product')
  }

  // E0-FR-13 / E0-FR-14: Claude hooks, against a temp CLAUDE_CONFIG_DIR.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), BRAND.tempPrefix + 'hooks-test-'))
    try {
      const installer = load('src/main/status/HookInstaller.ts', { process: { ...process, env: { ...process.env, CLAUDE_CONFIG_DIR: tmp } } })
      const file = path.join(tmp, 'settings.json')
      const newBak = `${file}.${BRAND.packageName}.bak`, legacyBak = `${file}.${LEGACY_BRAND.packageName}.bak`
      const port = 45123, token = 'b'.repeat(32), url = `http://127.0.0.1:${port}/cc-hook/${token}`
      const legacyId = LEGACY_BRAND.envPrefix + 'CONSOLE_ID', legacyPty = LEGACY_BRAND.envPrefix + 'PTY_ID'
      const legacyHttp = { type: 'http', url, headers: { 'X-Console-Id': '$' + legacyId, 'X-Pty-Id': '$' + legacyPty }, allowedEnvVars: [legacyId, legacyPty], timeout: 3 }
      const legacyStart = { type: 'command', command: `if [ -n "$${legacyId}" ]; then curl --data-binary @- '${url}'; fi; exit 0`, timeout: 3, statusMessage: LEGACY_BRAND.hookStatusMessage }
      // The 1.x Windows SessionStart hides the variable names in base64: only its statusMessage marks it.
      const legacyEncoded = { ...legacyStart, command: 'powershell.exe -NoLogo -EncodedCommand ' + Buffer.from(`if($env:${legacyId}){Invoke-WebRequest -Uri '${url}'}`, 'utf16le').toString('base64') }
      const userHook = { type: 'command', command: 'user-command' }
      const seed = hooks => fs.writeFileSync(file, JSON.stringify({ custom: 'keep', hooks }, null, 2))
      const settings = () => JSON.parse(fs.readFileSync(file, 'utf8'))
      const handlers = data => Object.values(data.hooks ?? {}).flatMap(groups => groups.flatMap(g => g.hooks))
      const legacyMarks = () => { const raw = fs.readFileSync(file, 'utf8'); return raw.includes(LEGACY_BRAND.envPrefix.slice(0, -1)) || raw.includes(LEGACY_BRAND.hookStatusMessage) }
      const ours = data => handlers(data).filter(h => h.url === url || h.statusMessage === BRAND.hookStatusMessage)
      const legacyBlock = () => ({ Stop: [{ hooks: [userHook] }, { hooks: [legacyHttp] }], UserPromptSubmit: [{ hooks: [legacyHttp] }], SessionStart: [{ hooks: [legacyStart] }] })

      seed(legacyBlock())
      check(installer.hooksStatus().installed && !installer.hooksStatus().complete, 'a 1.x block counts as installed but incomplete (the reconcile rewrites it)')
      fs.writeFileSync(legacyBak, 'old backup')
      check(installer.migrateLegacyHooks() === 'rewritten', 'legacy handlers: rewritten')
      let data = settings()
      check(!legacyMarks(), 'rewritten settings.json has 0 legacy marks')
      check(installer.hooksStatus().port === port && installer.hooksUpToDate(port, token), 'installed port and token kept, block complete')
      check(ours(data).length === 12 && Object.keys(data.hooks).length === 12, 'one handler per observed event, no duplicates')
      check(data.custom === 'keep' && handlers(data).filter(h => h.command === 'user-command').length === 1, 'user hook and unrelated settings kept')
      const http = ours(data).find(h => h.type === 'http')
      check(http.headers['X-Console-Id'] === '$' + AGENT_ENV.consoleId && http.headers['X-Pty-Id'] === '$' + AGENT_ENV.ptyId && http.allowedEnvVars.join() === [AGENT_ENV.consoleId, AGENT_ENV.ptyId].join(), 'http handlers use the SNAOS_ variables')
      const start = data.hooks.SessionStart[0].hooks[0]
      const startScript = process.platform === 'win32' ? Buffer.from(start.command.split(' ').pop(), 'base64').toString('utf16le') : start.command
      check(start.statusMessage === BRAND.hookStatusMessage && startScript.includes(AGENT_ENV.consoleId) && startScript.includes(AGENT_ENV.ptyId), 'SessionStart uses the new statusMessage and variables')
      check(fs.existsSync(newBak) && fs.readFileSync(legacyBak, 'utf8') === 'old backup', 'backup goes to .snagentsos.bak; the 1.x backup is left for the cleanup (L12)')

      let before = fs.readFileSync(file)
      check(installer.migrateLegacyHooks() === 'notNeeded' && fs.readFileSync(file).equals(before), 'second run: notNeeded, file untouched')

      fs.rmSync(newBak)
      fs.writeFileSync(file, '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "user-command"}]}]}}')
      before = fs.readFileSync(file)
      check(installer.migrateLegacyHooks() === 'notNeeded' && fs.readFileSync(file).equals(before) && !fs.existsSync(newBak), 'no hooks of ours: notNeeded, byte for byte, no backup')

      fs.rmSync(file)
      check(installer.migrateLegacyHooks() === 'notNeeded' && !fs.existsSync(file), 'no settings.json: notNeeded, nothing created')

      seed({ Stop: [{ hooks: [userHook] }], SessionStart: [{ hooks: [legacyStart] }] })
      check(installer.migrateLegacyHooks() === 'rewritten', 'only the 1.x SessionStart: handled')
      data = settings()
      check(!('SessionStart' in data.hooks) && ours(data).length === 0 && handlers(data).length === 1 && !legacyMarks(), 'it is removed (no url to rewrite to) and the user hook stays')

      seed({ Stop: [{ hooks: [userHook] }] })
      installer.installHooks(port, token)
      data = settings(); data.hooks.SessionStart = [{ hooks: [legacyEncoded] }]; fs.writeFileSync(file, JSON.stringify(data))
      check(installer.migrateLegacyHooks() === 'rewritten' && !legacyMarks() && installer.hooksUpToDate(port, token), 'a leftover encoded 1.x SessionStart is found by its statusMessage and rewritten')

      fs.writeFileSync(file, '{broken')
      check(installer.migrateLegacyHooks() === 'pending' && fs.readFileSync(file, 'utf8') === '{broken', 'corrupt settings.json: pending, never written')

      const thirdParty = { type: 'command', command: 'echo $' + legacyId }
      seed({ Stop: [{ hooks: [thirdParty] }] })
      before = fs.readFileSync(file)
      check(installer.migrateLegacyHooks() === 'pending' && fs.readFileSync(file).equals(before), 'a third-party hook naming a 1.x variable is never touched (stays pending)')

      seed(legacyBlock())
      installer.uninstallHooks()
      data = settings()
      check(handlers(data).length === 1 && handlers(data)[0].command === 'user-command' && !legacyMarks(), 'uninstallHooks also removes the 1.x handlers')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
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
  // R20-03 scope: the legacy names only come from LEGACY_BRAND.
  const envScope = [
    'src/main/pty/PtyManager.ts', 'src/main/status/CodexBridge.ts', 'src/main/status/statusRuntime.ts',
    'src/main/status/HookInstaller.ts', 'src/main/status/HookServer.ts', 'scripts/test-status.cjs', 'scripts/test-status-ui.cjs', 'scripts/test-mobile-scroll.cjs',
  ]
  for (const file of envScope) check(!LEGACY_RE.test(read(file)), `${file}: no legacy name`)

  // No en dash or em dash anywhere under src/ (style rule; check-brand extends it to the repo).
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  const offenders = walk(path.join(root, 'src')).filter(f => /\.(tsx?|html|css|json|webmanifest)$/.test(f) && DASH_RE.test(fs.readFileSync(f, 'utf8')))
  check(offenders.length === 0, `no en/em dash under src/: ${offenders.map(f => path.relative(root, f)).join(', ')}`)

  console.log(`PASS: ${checks} rebrand checks`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
