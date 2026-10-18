// SnAgentsOS legacy migration and cleanup checks (E0, work package R20-04).
// Same harness as test-rebrand.cjs: esbuild + vm, check() counts assertions,
// one PASS line at the end. Every file system case runs on a fake tree under
// os.tmpdir(); registry, shell, processes and Electron are injected stubs, so
// nothing here reads or writes the real %APPDATA%, %LOCALAPPDATA%, ~/.claude,
// registry Run keys, shortcuts or taskbar pins.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setImmediate, ...overrides })
  return mod.exports
}
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-r2004-'))
let seq = 0
const freshDir = name => { const d = path.join(tmpRoot, `${name}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d }
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }
const isWin = process.platform === 'win32'

/** Electron stub: only what the loaded module touches. */
function electronStub(o = {}) {
  const calls = []
  const paths = { userData: o.userData ?? path.join(tmpRoot, 'userData'), appData: o.appData ?? path.join(tmpRoot, 'appData'), exe: o.exe ?? path.join(tmpRoot, 'exe', 'SnAgentsOS.exe') }
  return {
    calls,
    app: {
      isPackaged: o.isPackaged ?? true,
      commandLine: { hasSwitch: name => (o.switches ?? []).includes(name) },
      getPath: name => paths[name],
      setPath: (name, value) => { calls.push(['setPath', name, value]); paths[name] = value },
      getVersion: () => '2.0.0',
    },
  }
}
const withElectron = (stub, extra = {}) => ({ require: id => (id === 'electron' ? stub : require(id)), ...extra })

// A valid 1.x config (schema v10) with the given counts.
function makeConfig({ ws = 2, presets = 1, version = 10, tag = 'a', launchOnStartup = false, remote = false } = {}) {
  return {
    version,
    workspaces: Array.from({ length: ws }, (_, i) => ({ id: `w${i}`, name: `${tag}-${i}`, cwd: tmpRoot, panes: [] })),
    presets: Array.from({ length: presets }, (_, i) => ({ id: `p${i}`, name: `P${i}`, type: 'shell', command: 'pwsh', args: [], color: '#fff', icon: 'terminal' })),
    settings: { defaultShell: {}, fontFamily: 'mono', fontSize: 14, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false, usage: {}, launchOnStartup, remote: { enabled: remote, port: 4517 } },
  }
}
const devicesJson = (n = 2, secret = 's') => JSON.stringify({ version: 1, devices: Array.from({ length: n }, (_, i) => ({ id: `dev${i}`, name: `Phone ${i}`, secret: `${secret}${i}`.padEnd(64, '0'), createdAt: i, lastSeen: i })) })
const stamp = i => `config-2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}T10-00-00-000Z.json`

/** 1.x data folder: whitelist files plus status-bin, a Chromium cache and the lockfile. */
function seedLegacy(dir, o = {}) {
  write(path.join(dir, 'config.json'), o.config ?? JSON.stringify(makeConfig({ tag: o.tag ?? 'legacy', launchOnStartup: o.launchOnStartup ?? false })))
  if (o.bak !== false) write(path.join(dir, 'config.json.bak'), o.bak ?? JSON.stringify(makeConfig({ tag: 'bak' })))
  if (o.devices !== false) write(path.join(dir, 'remote-devices.json'), o.devices ?? devicesJson())
  for (let i = 0; i < (o.backups ?? 3); i++) write(path.join(dir, 'backups', stamp(i)), JSON.stringify(makeConfig({ tag: `b${i}` })))
  write(path.join(dir, 'status-bin', 'codex.cmd'), '@echo off')
  write(path.join(dir, 'Cache', 'Cache_Data', 'data_0'), 'chromium')
  write(path.join(dir, 'lockfile'), '')
  return dir
}

/** Every file under dir with its hash, relative paths with forward slashes. */
function snapshotTree(dir) {
  const out = {}
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = path.relative(dir, p).split(path.sep).join('/')
      if (e.isSymbolicLink()) out[rel] = 'link'
      else if (e.isDirectory()) { out[rel + '/'] = 'dir'; walk(p) }
      else out[rel] = sha(fs.readFileSync(p))
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
const sameTree = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function loadMigration() {
  const stub = electronStub()
  const opts = withElectron(stub, { process: { ...process, env: {}, argv: ['electron'] } })
  return { ...load('src/main/migration/legacyBrand.ts', opts), ...load('src/main/migration/legacyMarker.ts', opts), ladder: load('src/main/store/ConfigStore.ts', opts).loadLadder }
}

/** runPipeline with a fixed clock and no real waits. */
function pipe(L, o) {
  let t = o.start ?? Date.UTC(2026, 9, 18, 12, 0, 0)
  const lines = []
  const res = L.runPipeline({ appVersion: '2.0.0', mode: 'installed', isLegacyRunning: () => false, now: () => (t += 1000), sleep: () => {}, log: l => lines.push(l), ...o })
  res.lines = lines
  return res
}

/** fs that behaves like node:fs except where a hook says otherwise. */
function hookedFs(hooks) {
  return new Proxy(fs, { get: (target, prop) => hooks[prop] ? hooks[prop] : target[prop] })
}


/** In-memory registry stub: { 'HKCU\\key': { name: value } }, case-insensitive keys. */
function makeRegistry(init = {}) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), { ...v }]))
  const ops = []
  return {
    data, ops,
    read: (hive, key, name) => { const v = data.get(`${hive}\\${key}`.toLowerCase()); return v && name in v ? v[name] : null },
    deleteValue: (hive, key, name) => { ops.push(['deleteValue', hive, key, name]); const v = data.get(`${hive}\\${key}`.toLowerCase()); if (!v || !(name in v)) return 'absent'; delete v[name]; return 'done' },
    deleteKey: (hive, key) => { ops.push(['deleteKey', hive, key]); return data.delete(`${hive}\\${key}`.toLowerCase()) ? 'done' : 'absent' },
  }
}

/** A fake user profile under the test temp root: every root the inventory reads. */
function fakeProfile() {
  const base = freshDir('profile')
  const home = path.join(base, 'home')
  const appData = path.join(home, 'AppData', 'Roaming')
  const roots = {
    appData, localAppData: path.join(home, 'AppData', 'Local'), temp: path.join(home, 'AppData', 'Local', 'Temp'), home,
    desktop: path.join(home, 'Desktop'), claudeDir: path.join(home, '.claude'),
    startMenuPrograms: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    taskbarPins: path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    macApplications: [path.join(base, 'Applications'), path.join(home, 'Applications')],
  }
  for (const d of [roots.appData, roots.localAppData, roots.temp, roots.desktop, roots.claudeDir]) fs.mkdirSync(d, { recursive: true })
  const programFiles = path.join(base, 'Program Files')
  const exeDir = path.join(roots.localAppData, 'Programs', 'SnAgentsOS')
  write(path.join(exeDir, 'SnAgentsOS.exe'), 'new exe')
  return { base, home, roots, programFiles, exeDir, targetDir: path.join(appData, 'snagentsos') }
}

function guardFor(p, extra = {}) {
  return {
    forbiddenExact: [p.roots.appData, p.roots.localAppData, p.roots.temp, p.roots.home, p.roots.claudeDir, path.join(p.roots.localAppData, 'Programs')],
    forbiddenTree: [p.targetDir, ...(extra.tree ?? [p.targetDir])],
    forbiddenContain: [p.exeDir, ...(extra.contain ?? [])],
    ...(extra.allowedRoots ? { allowedRoots: extra.allowedRoots } : {}),
  }
}

function cleanupEnv(p, o = {}) {
  let t = o.start ?? Date.UTC(2026, 9, 18, 13, 0, 0)
  const lines = []
  const env = {
    targetDir: p.targetDir, mode: 'installed', platform: 'win32', roots: p.roots, legacyDataDir: null, portableDir: null,
    exe: { execPath: path.join(p.exeDir, 'SnAgentsOS.exe'), portableExeFile: () => null, setPortableExeFile() {} },
    guard: o.guard ?? guardFor(p), elevation: { platform: 'win32', programFiles: [p.programFiles] },
    registry: makeRegistry(), shortcuts: null, loginItem: null,
    isLegacyProcessRunning: () => false, isFolderLocked: () => false, migrateLegacyHooks: () => 'notNeeded', readMigratedSettings: () => null,
    now: () => (t += 1000), log: l => lines.push(l), simulate: false, delayMs: 0, ...o,
  }
  env.lines = lines
  return env
}

/** The P-LEGACY fixture: 1.x data with an unknown file, a junction to a sentinel and a read-only file, plus every disk leftover. */
function seedProfile(p, o = {}) {
  const legacyDir = seedLegacy(path.join(p.roots.appData, 'snmulticc'), o)
  write(path.join(legacyDir, 'notes.txt'), 'x'.repeat(1024))
  const sentinel = path.join(p.base, 'sentinel'); write(path.join(sentinel, 'keep.txt'), 'keep')
  fs.symlinkSync(sentinel, path.join(legacyDir, 'linked'), isWin ? 'junction' : 'dir')
  const ro = path.join(legacyDir, 'Local Storage', 'leveldb', 'LOCK'); write(ro, 'ro'); fs.chmodSync(ro, 0o444)
  const dev = path.join(p.roots.appData, 'snmulticc-dev'); write(path.join(dev, 'config.json'), 'dev-config'); write(path.join(dev, 'Cache', 'x'), 'c')
  write(path.join(p.roots.localAppData, 'snmulticc-updater', 'installer.exe'), 'old setup')
  write(path.join(p.roots.temp, 'SnMultiCC', 'SnMultiCC.exe'), 'extracted 1.x')
  write(path.join(p.roots.temp, 'snmulticc-update-abc', 'SnMultiCC-1.14.1-setup.exe'), 'dl')
  write(path.join(p.roots.temp, 'snmulticc-swap-xyz', 'swap.cmd'), 'swap')
  write(path.join(p.roots.temp, 'unrelated-update-1', 'x'), 'not ours')
  write(path.join(p.roots.claudeDir, 'settings.json.snmulticc.bak'), '{"old":true}')
  write(path.join(p.roots.claudeDir, 'settings.json'), '{}')
  write(path.join(p.roots.appData, 'other-app', 'data.json'), '{}')
  return { legacyDir, sentinel, dev }
}


/** Shortcut stub: a .lnk is a JSON file { target, ... }; update can be told to fail. */
function makeShortcuts(failing = []) {
  const updates = []
  return {
    updates,
    read: lnk => { try { const j = JSON.parse(fs.readFileSync(lnk, 'utf8')); return typeof j.target === 'string' ? { target: j.target } : null } catch { return null } },
    update: (lnk, o) => { updates.push([lnk, o]); if (failing.includes(path.basename(lnk))) return false; fs.writeFileSync(lnk, JSON.stringify({ ...JSON.parse(fs.readFileSync(lnk, 'utf8')), ...o })); return true },
  }
}
const lnk = (file, target) => write(file, JSON.stringify({ target }))
const utf16 = s => Buffer.from(s, 'utf16le')

async function markerChecks() {
  const M = load('src/main/migration/legacyMarker.ts')
  const dir = freshDir('marker')
  check(M.readMarker(dir).kind === 'absent', 'marker: missing file reads as absent')
  const m = M.newMarker({ phase: 'migrating', mode: 'installed', from: 'legacy', to: dir, appVersion: '2.0.0', now: 1 })
  M.writeMarker(dir, m)
  const raw = fs.readFileSync(path.join(dir, M.MARKER_FILE))
  check(raw[0] === 0x7b && raw.toString('utf8').endsWith('\n'), 'marker: UTF-8 without BOM, trailing newline')
  check(!fs.existsSync(path.join(dir, M.MARKER_PREV_FILE)), 'marker: first write has no prev to copy')
  check(!fs.existsSync(path.join(dir, M.MARKER_FILE + '.tmp')), 'marker: tmp renamed away')
  const first = M.readMarker(dir)
  check(first.kind === 'ok' && first.from === 'main' && first.marker.phase === 'migrating', 'marker: reads back from main')
  M.writeMarker(dir, { ...m, phase: 'verified', at: 2 })
  const prev = JSON.parse(fs.readFileSync(path.join(dir, M.MARKER_PREV_FILE), 'utf8'))
  check(prev.phase === 'migrating', 'marker: the previous version is copied to prev before each write')
  fs.writeFileSync(path.join(dir, M.MARKER_FILE), '{"v":2,"phase":')
  const fallback = M.readMarker(dir)
  check(fallback.kind === 'ok' && fallback.from === 'prev' && fallback.marker.phase === 'migrating', 'marker: torn main falls back to prev')
  fs.writeFileSync(path.join(dir, M.MARKER_FILE), JSON.stringify({ ...m, phase: 'bogus' }))
  check(M.readMarker(dir).from === 'prev', 'marker: out-of-schema main falls back to prev')
  fs.writeFileSync(path.join(dir, M.MARKER_PREV_FILE), 'nope')
  check(M.readMarker(dir).kind === 'corrupt', 'marker: main and prev unreadable is corrupt, not absent')
  const name = M.quarantineMarker(dir, Date.UTC(2026, 9, 18, 12, 0, 0))
  check(name === 'legacy-migration.json.corrupt-2026-10-18T12-00-00-000Z' && fs.existsSync(path.join(dir, name)) && !fs.existsSync(path.join(dir, M.MARKER_FILE)), 'marker: quarantined as .corrupt-<ISO>')
  fs.writeFileSync(path.join(dir, M.MARKER_FILE), JSON.stringify({ v: 1, phase: 'done' }))
  check(M.readMarker(dir).kind === 'absent', 'marker: v1 (test builds only) is treated as absent')
  check(M.isCommittedPhase('committed') && M.isCommittedPhase('cleaning') && M.isCommittedPhase('done') && !M.isCommittedPhase('backedUp') && !M.isCommittedPhase('failed'), 'marker: committed, cleaning and done are the committed phases')
  check(['done', 'absent', 'skipped'].every(M.isTerminalItem) && !M.isTerminalItem('deferred') && !M.isTerminalItem('pending'), 'marker: terminal item states')
  check(Object.keys(M.pendingCleanup()).length === 21 && M.LEGACY_ITEM_IDS[20] === 'L21', 'marker: the commit lists L01-L21 as pending')
  check(M.BACKUP_TTL_MS === 30 * 24 * 3600 * 1000 && M.BACKUP_FILE === 'migration-backup-v1.zip', 'marker: backup name and 30-day TTL')
}

async function pathsChecks() {
  const appData = freshDir('appdata')
  const exeDir = freshDir('portable')
  const base = { ...process, argv: ['electron'], platform: process.platform }
  const loadPaths = (stub, penv) => load('src/main/paths.ts', withElectron(stub, { process: { ...base, env: penv } }))
  {
    const stub = electronStub({ userData: path.join(appData, 'snagentsos'), appData })
    const p = loadPaths(stub, {})
    check(p.getConfigPath() === path.join(appData, 'snagentsos', 'config.json') && p.dataDir() === path.join(appData, 'snagentsos'), 'paths: installed dataDir() is dirname(getConfigPath()) in userData')
    check(p.getLegacyDataDir() === null, 'paths: no legacy folder, null')
    fs.mkdirSync(path.join(appData, 'snmulticc'))
    check(p.getLegacyDataDir() === path.join(appData, 'snmulticc'), 'paths: installed legacy folder is <appData>/snmulticc')
    fs.renameSync(path.join(appData, 'snmulticc'), path.join(appData, 'snmulticc.deleting-2026'))
    check(p.getLegacyDataDir() === null, 'paths: a .deleting-* tombstone is never detected as legacy data')
  }
  {
    const stub = electronStub({ appData })
    const p = loadPaths(stub, { PORTABLE_EXECUTABLE_DIR: exeDir })
    check(p.dataDir() === path.join(exeDir, 'snagentsos-data') && p.getConfigPath() === path.join(exeDir, 'snagentsos-data', 'config.json'), 'paths: portable dataDir() is <exeDir>/snagentsos-data')
    fs.mkdirSync(path.join(exeDir, 'snmulticc-data'))
    check(p.getLegacyDataDir() === path.join(exeDir, 'snmulticc-data'), 'paths: portable legacy folder is <exeDir>/snmulticc-data')
  }
  {
    // Dev reads the parent of the data folders from the environment (fake trees redirect only that).
    const fake = freshDir('fake-appdata')
    const devEnv = isWin ? { APPDATA: fake } : process.platform === 'darwin' ? { HOME: fake } : { XDG_CONFIG_HOME: fake }
    const expected = process.platform === 'darwin' ? path.join(fake, 'Library', 'Application Support') : fake
    check(loadPaths(electronStub({ isPackaged: false, appData }), devEnv).appDataRoot() === expected, 'paths: dev appDataRoot() follows the environment')
    check(loadPaths(electronStub({ isPackaged: true, appData }), devEnv).appDataRoot() === appData, 'paths: packaged appDataRoot() is Electron appData, like 1.x')
  }
}

async function devUserDataChecks() {
  const run = o => { const stub = electronStub(o); load('src/main/devUserData.ts', withElectron(stub)); return stub.calls }
  const appData = path.join(tmpRoot, 'appData')
  const dev = run({ isPackaged: false, appData })
  check(dev.length === 1 && dev[0][1] === 'userData' && dev[0][2] === path.join(appData, 'snagentsos-dev'), 'devUserData: dev without --user-data-dir uses <appData>/snagentsos-dev')
  check(run({ isPackaged: true, appData }).length === 0, 'devUserData: packaged keeps its userData')
  check(run({ isPackaged: false, appData, switches: ['user-data-dir'] }).length === 0, 'devUserData: --user-data-dir wins in dev')
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const firstImport = index.split('\n').find(l => l.startsWith('import '))
  check(firstImport === "import './devUserData'", 'devUserData: first import of index.ts')
}

async function deviceRegistryChecks() {
  const userData = freshDir('registry')
  const stub = electronStub({ userData })
  const { DeviceRegistry, fileSchema } = load('src/main/remote/DeviceRegistry.ts', withElectron(stub, { process: { ...process, env: {}, argv: ['electron'] } }))
  const file = path.join(userData, 'remote-devices.json')
  const devices = [{ id: 'a', name: 'Phone A', secret: 'aa', createdAt: 1, lastSeen: 1 }, { id: 'b', name: 'Phone B', secret: 'bb', createdAt: 2, lastSeen: 2 }]
  const registry = new DeviceRegistry()
  // Written after construction: the constructor must not have read anything yet.
  write(file, JSON.stringify({ version: 1, devices }))
  check(registry.deleteInMemory('a') === true, 'DeviceRegistry: revoking as the very first operation finds the device (ensureLoaded)')
  registry.persist()
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  check(onDisk.devices.length === 1 && onDisk.devices[0].id === 'b', 'DeviceRegistry: the revoked device is gone from the file')
  check(fileSchema.safeParse(onDisk).success && !fileSchema.safeParse({ version: 2, devices: [] }).success, 'DeviceRegistry: fileSchema is exported for verification')
  const late = new DeviceRegistry()
  write(file, JSON.stringify({ version: 1, devices }))
  late.load(); late.load()
  check(late.count === 2, 'DeviceRegistry: load() is explicit and idempotent, path under dataDir()')
  const src = fs.readFileSync(path.join(root, 'src/main/remote/DeviceRegistry.ts'), 'utf8')
  check(!/constructor\s*\(/.test(src) && /get path\(\): string \{\s*return join\(dataDir\(\), 'remote-devices\.json'\)/.test(src), 'DeviceRegistry: no load in a constructor, lazy path getter')
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  check(/remoteManager\.loadDevices\(\)/.test(index) && /loadDevices\(\): void \{\s*this\.registry\.load\(\)/.test(fs.readFileSync(path.join(root, 'src/main/remote/RemoteManager.ts'), 'utf8')), 'DeviceRegistry: bootstrap loads devices through RemoteManager.loadDevices()')
}

async function pipelineChecks() {
  const L = loadMigration()
  const fresh = () => { const base = freshDir('pipe'); return { legacyDir: path.join(base, 'snmulticc'), targetDir: path.join(base, 'snagentsos'), base } }

  // 1. No legacy folder.
  {
    const { legacyDir, targetDir } = fresh()
    const r = pipe(L, { legacyDir: null, targetDir })
    check(r.status === 'committed' && r.marker.outcome === 'noLegacy' && r.marker.phase === 'committed' && r.marker.committedAt > 0, 'pipeline 1: no legacy commits as noLegacy')
    check(Object.keys(r.marker.cleanup).length === 21 && r.marker.hooksMigration === 'pending', 'pipeline 1: every item pending, hooks pending')
    const r2 = pipe(L, { legacyDir, targetDir: fresh().targetDir })
    check(r2.status === 'committed' && r2.marker.outcome === 'noLegacy' && r2.marker.from === null, 'pipeline 1: a missing legacy path is noLegacy too')
  }
  // 2 and 3. Full copy, then a second run that does nothing.
  {
    const { legacyDir, targetDir } = fresh()
    seedLegacy(legacyDir, { backups: 4 })
    const before = snapshotTree(legacyDir)
    const r = pipe(L, { legacyDir, targetDir })
    check(r.status === 'committed' && r.marker.outcome === 'migrated', 'pipeline 2: committed as migrated')
    const got = snapshotTree(targetDir)
    const copied = Object.keys(got).filter(k => !k.startsWith('legacy-migration') && !k.endsWith('/') && !k.endsWith('.zip'))
    const expected = ['config.json', 'config.json.bak', 'remote-devices.json', ...[0, 1, 2, 3].map(i => `backups/${stamp(i)}`)].sort()
    check(JSON.stringify(copied.sort()) === JSON.stringify(expected), `pipeline 2: exactly the whitelist is copied: ${copied}`)
    check(expected.every(rel => got[rel] === before[rel]), 'pipeline 2: byte-identical to the sources')
    check(!fs.existsSync(path.join(targetDir, 'status-bin')) && !fs.existsSync(path.join(targetDir, 'Cache')) && !fs.existsSync(path.join(targetDir, 'lockfile')), 'pipeline 2: no status-bin, Chromium or lockfile')
    check(sameTree(snapshotTree(legacyDir), before), 'pipeline 2: the legacy folder is untouched')
    const v = r.marker.verified
    check(v.legacyConfigLoadable && v.workspaces === 2 && v.presets === 1 && v.devices === 2 && v.backups === 4, 'pipeline 2: verified counts')
    check(r.marker.sources.length === 7 && r.marker.sources.every(s => s.sha256 === before[s.rel]), 'pipeline 2: sources carry the source hashes')
    check(!fs.existsSync(path.join(targetDir, '.legacy-staging')), 'pipeline 2: staging removed after the commit')
    check(JSON.parse(fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8')).version === 10, 'pipeline 2: CONFIG_VERSION stays 10')
    const markerPath = path.join(targetDir, L.MARKER_FILE)
    const mtime = fs.statSync(markerPath).mtimeMs, cfgMtime = fs.statSync(path.join(targetDir, 'config.json')).mtimeMs
    const r3 = pipe(L, { legacyDir, targetDir })
    check(r3.status === 'alreadyCommitted' && fs.statSync(markerPath).mtimeMs === mtime && fs.statSync(path.join(targetDir, 'config.json')).mtimeMs === cfgMtime, 'pipeline 3: second run is alreadyCommitted with no writes')
  }
  // 4. Destination already has config.json and paired devices, no marker.
  {
    const { legacyDir, targetDir } = fresh()
    seedLegacy(legacyDir)
    const own = JSON.stringify(makeConfig({ tag: 'own', ws: 5 }))
    write(path.join(targetDir, 'config.json'), own)
    write(path.join(targetDir, 'config.json.bak'), 'own-bak')
    write(path.join(targetDir, 'remote-devices.json'), devicesJson(1, 'target'))
    const r = pipe(L, { legacyDir, targetDir })
    check(r.status === 'committed' && r.marker.preImportSnapshot && r.marker.preImportSnapshot.startsWith('pre-import/config-'), 'pipeline 4: snapshot recorded in pre-import/')
    const snap = path.join(targetDir, r.marker.preImportSnapshot)
    check(fs.readFileSync(snap, 'utf8') === own && fs.readFileSync(snap + '.bak', 'utf8') === 'own-bak', 'pipeline 4: destination config and .bak saved')
    check(fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8') === fs.readFileSync(path.join(legacyDir, 'config.json'), 'utf8'), 'pipeline 4: the legacy config wins')
    check(JSON.parse(fs.readFileSync(path.join(targetDir, 'remote-devices.json'), 'utf8')).devices[0].secret.startsWith('target') && r.marker.verified.devices === 0, 'pipeline 4: destination devices kept (no resurrected revocations)')
    const { legacyDir: l2, targetDir: t2 } = fresh()
    seedLegacy(l2)
    write(path.join(t2, 'remote-devices.json'), devicesJson(0))
    pipe(L, { legacyDir: l2, targetDir: t2 })
    check(JSON.parse(fs.readFileSync(path.join(t2, 'remote-devices.json'), 'utf8')).devices.length === 2, 'pipeline 4: an empty destination registry takes the legacy devices')
  }
  // 5. Injected failure at the third file, and after the first rename.
  {
    const { legacyDir, targetDir } = fresh()
    seedLegacy(legacyDir)
    const own = JSON.stringify(makeConfig({ tag: 'own' }))
    write(path.join(targetDir, 'config.json'), own)
    const legacyBefore = snapshotTree(legacyDir)
    const r = pipe(L, { legacyDir, targetDir, faultAt: 'copy:3' })
    check(r.status === 'failed' && r.marker.phase === 'failed' && r.marker.lastError.code === 'fault:copy:3' && r.marker.lastError.phase === 'migrating', 'pipeline 5: copy fault is failed with its code')
    check(!fs.existsSync(path.join(targetDir, '.legacy-staging')) && fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8') === own, 'pipeline 5: staging removed, destination untouched')
    const r2 = pipe(L, { legacyDir, targetDir, faultAt: 'move:2' })
    check(r2.status === 'failed' && r2.marker.attempts === 2, 'pipeline 5: rename fault fails, attempts + 1')
    const after = snapshotTree(targetDir)
    check(fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8') === own && !('config.json.bak' in after) && !('remote-devices.json' in after), 'pipeline 5: renamed files rolled back, destination restored')
    check(sameTree(snapshotTree(legacyDir), legacyBefore), 'pipeline 5: legacy intact')
    const r3 = pipe(L, { legacyDir, targetDir })
    check(r3.status === 'committed' && r3.marker.attempts === 3, 'pipeline 5: the next start migrates')
  }
  // 6. More than 12 backups: the 12 newest.
  {
    const { legacyDir, targetDir } = fresh()
    seedLegacy(legacyDir, { backups: 15 })
    const r = pipe(L, { legacyDir, targetDir })
    const names = fs.readdirSync(path.join(targetDir, 'backups')).sort()
    check(r.status === 'committed' && names.length === 12 && names[0] === stamp(3) && names[11] === stamp(14), 'pipeline 6: only the 12 newest backups are copied')
  }
  // 7. A link inside backups/ is ignored (junction on Windows, symlink elsewhere).
  {
    const { legacyDir, targetDir, base } = fresh()
    seedLegacy(legacyDir, { backups: 1 })
    const outside = path.join(base, 'outside'); write(path.join(outside, 'x.json'), '{}')
    fs.symlinkSync(outside, path.join(legacyDir, 'backups', 'config-2099-01-01T00-00-00-000Z.json'), isWin ? 'junction' : 'dir')
    const r = pipe(L, { legacyDir, targetDir })
    check(r.status === 'committed' && fs.readdirSync(path.join(targetDir, 'backups')).length === 1 && r.lines.some(l => l.includes('skip=link')), 'pipeline 7: a link in backups/ is not followed')
  }
  // 8. Portable: snmulticc-data next to the exe into snagentsos-data.
  {
    const exeDir = freshDir('portable-exe')
    const legacyDir = seedLegacy(path.join(exeDir, 'snmulticc-data'))
    const targetDir = path.join(exeDir, 'snagentsos-data')
    const r = pipe(L, { legacyDir, targetDir, mode: 'portable' })
    check(r.status === 'committed' && r.marker.mode === 'portable' && fs.existsSync(path.join(targetDir, 'config.json')) && fs.existsSync(path.join(targetDir, L.MARKER_FILE)), 'pipeline 8: portable migrates into snagentsos-data with its marker')
  }
  // 9. 1.x running: nothing written.
  {
    const { legacyDir, targetDir } = fresh()
    seedLegacy(legacyDir)
    const r = pipe(L, { legacyDir, targetDir, isLegacyRunning: () => true })
    check(r.status === 'legacyRunning' && !fs.existsSync(targetDir), 'pipeline 9: legacyRunning writes nothing')
  }
  // 10. pre-import rotation keeps the first snapshot and the 2 newest, no duplicates.
  {
    const { legacyDir, targetDir } = fresh()
    seedLegacy(legacyDir)
    const configs = [1, 2, 3, 4].map(n => JSON.stringify(makeConfig({ tag: `own${n}`, ws: n })))
    for (const [i, c] of configs.entries()) {
      write(path.join(targetDir, 'config.json'), c)
      check(pipe(L, { legacyDir, targetDir, faultAt: 'move:1', start: Date.UTC(2026, 9, 18, 13 + i) }).status === 'failed', 'pipeline 10: attempt fails after the snapshot')
    }
    const snaps = () => fs.readdirSync(path.join(targetDir, 'pre-import')).filter(n => n.endsWith('.json')).sort()
    const kept = snaps().map(n => fs.readFileSync(path.join(targetDir, 'pre-import', n), 'utf8'))
    check(kept.length === 3 && kept[0] === configs[0] && kept[1] === configs[2] && kept[2] === configs[3], 'pipeline 10: 3 snapshots, the first one survives rotation')
    write(path.join(targetDir, 'config.json'), configs[3])
    pipe(L, { legacyDir, targetDir, faultAt: 'move:1' })
    check(snaps().length === 3, 'pipeline 10: an identical config adds no snapshot')
    fs.copyFileSync(path.join(legacyDir, 'config.json'), path.join(targetDir, 'config.json'))
    pipe(L, { legacyDir, targetDir, faultAt: 'move:1' })
    check(snaps().length === 3, 'pipeline 10: a config equal to a source adds no snapshot')
    // 11. The destination ladder recovers from backups/, never from pre-import/.
    const r = pipe(L, { legacyDir, targetDir })
    check(r.status === 'committed', 'pipeline 11: migrated')
    fs.writeFileSync(path.join(targetDir, 'config.json'), '{broken')
    fs.writeFileSync(path.join(targetDir, 'config.json.bak'), '{broken')
    const hit = L.ladder(targetDir)
    check(hit && hit.source === `backups/${stamp(2)}` && hit.config.workspaces[0].name === 'b2-0', 'pipeline 11: ConfigStore recovers the newest backups/config-*, not a snapshot')
  }
  // 12. Marker: main corrupt uses prev; both corrupt with legacy data is failed: markerCorrupt.
  {
    const { legacyDir, targetDir } = fresh()
    seedLegacy(legacyDir)
    pipe(L, { legacyDir, targetDir, faultAt: 'copy:1' })
    pipe(L, { legacyDir, targetDir, faultAt: 'copy:1' })
    fs.writeFileSync(path.join(targetDir, L.MARKER_FILE), '{"v":2')
    const viaPrev = pipe(L, { legacyDir, targetDir })
    check(viaPrev.status === 'committed' && viaPrev.marker.attempts >= 2, 'pipeline 12: unreadable main falls back to prev and goes on')

    const { legacyDir: l2, targetDir: t2 } = fresh()
    seedLegacy(l2)
    const own = JSON.stringify(makeConfig({ tag: 'own' }))
    write(path.join(t2, 'config.json'), own)
    write(path.join(t2, L.MARKER_FILE), 'garbage'); write(path.join(t2, L.MARKER_PREV_FILE), 'garbage')
    const bad = pipe(L, { legacyDir: l2, targetDir: t2 })
    check(bad.status === 'failed' && bad.marker.lastError.code === 'markerCorrupt', 'pipeline 12: both corrupt with legacy data is failed: markerCorrupt')
    check(fs.readFileSync(path.join(t2, 'config.json'), 'utf8') === own && fs.readdirSync(t2).some(n => n.startsWith('legacy-migration.json.corrupt-')), 'pipeline 12: destination config untouched, corrupt marker set aside')
    check(pipe(L, { legacyDir: l2, targetDir: t2 }).status === 'failed' && fs.readFileSync(path.join(t2, 'config.json'), 'utf8') === own, 'pipeline 12: markerCorrupt is sticky while the legacy folder exists')

    const t3 = fresh().targetDir
    write(path.join(t3, L.MARKER_FILE), 'garbage')
    const rebuilt = pipe(L, { legacyDir: null, targetDir: t3 })
    check(rebuilt.status === 'committed' && rebuilt.marker.outcome === 'noLegacy', 'pipeline 12: without a legacy folder it rebuilds as noLegacy')
  }
  // --user-data-dir pointing into the 1.x folder copies nothing.
  {
    const { legacyDir } = fresh()
    seedLegacy(legacyDir)
    const before = snapshotTree(legacyDir)
    const r = pipe(L, { legacyDir, targetDir: path.join(legacyDir, 'nested') })
    check(r.status === 'committed' && r.marker.outcome === 'noLegacy' && r.lines.some(l => l.includes('skip=overlap')), 'pipeline: overlapping legacy and data folders copy nothing')
    fs.rmSync(path.join(legacyDir, 'nested'), { recursive: true })
    check(sameTree(snapshotTree(legacyDir), before), 'pipeline: overlapping legacy folder untouched')
  }
  // NFR: the synchronous part (migrate, verify, zip, mark) of a ~7 KB config with
  // 12 backups and devices stays under 800 ms. The first run warms the bundle up.
  {
    const config = JSON.stringify(makeConfig({ ws: 45, presets: 25 }))
    const seed = () => { const f = fresh(); seedLegacy(f.legacyDir, { config, backups: 12 }); return f }
    const warm = seed()
    pipe(L, warm)
    const { legacyDir, targetDir } = seed()
    const t0 = process.hrtime.bigint()
    const r = pipe(L, { legacyDir, targetDir })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    check(r.status === 'committed' && r.marker.verified.backups === 12 && fs.existsSync(path.join(targetDir, 'migration-backup-v1.zip')), 'pipeline perf: migrated with 12 backups and the zip')
    check(ms < 800, `pipeline perf: ${Math.round(config.length / 1024)} KB config, 12 backups and devices in under 800 ms (${ms.toFixed(1)} ms)`)
  }
}

async function verificationChecks() {
  const L = loadMigration()
  const fresh = () => { const base = freshDir('verify'); return { legacyDir: path.join(base, 'snmulticc'), targetDir: path.join(base, 'snagentsos') } }
  const failsSafely = (r, legacyDir, before, targetDir, label) => {
    check(r.status === 'failed' && r.marker.phase === 'failed', `${label}: failed (${r.marker && r.marker.lastError && r.marker.lastError.code})`)
    check(sameTree(snapshotTree(legacyDir), before), `${label}: legacy hashes unchanged`)
    check(!fs.existsSync(path.join(targetDir, 'config.json')) && !fs.existsSync(path.join(targetDir, '.legacy-staging')) && !fs.existsSync(path.join(targetDir, 'migration-backup-v1.zip')), `${label}: destination back to its previous state`)
  }
  // A byte altered in the staging copy.
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir); const before = snapshotTree(legacyDir)
    const fsx = hookedFs({ writeFileSync: (p, d, ...rest) => fs.writeFileSync(p, String(p).includes('.legacy-staging') && String(p).endsWith('config.json') ? Buffer.concat([Buffer.from(d), Buffer.from(' ')]) : d, ...rest) })
    const r = pipe(L, { legacyDir, targetDir, fs: fsx })
    failsSafely(r, legacyDir, before, targetDir, 'verify byte')
    check(r.marker.lastError.code === 'stagingHash', 'verify byte: stagingHash')
  }
  // The destination ends up with one workspace less than the legacy config.
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir); const before = snapshotTree(legacyDir)
    const fsx = hookedFs({ renameSync: (a, b) => { fs.renameSync(a, b); if (String(b) === path.join(targetDir, 'config.json')) fs.writeFileSync(b, JSON.stringify(makeConfig({ tag: 'legacy', ws: 1 }))) } })
    failsSafely(pipe(L, { legacyDir, targetDir, fs: fsx }), legacyDir, before, targetDir, 'verify workspace')
  }
  // A different secret in the destination registry.
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir); const before = snapshotTree(legacyDir)
    const fsx = hookedFs({ renameSync: (a, b) => { fs.renameSync(a, b); if (String(b) === path.join(targetDir, 'remote-devices.json')) fs.writeFileSync(b, devicesJson(2, 'other')) } })
    const r = pipe(L, { legacyDir, targetDir, fs: fsx })
    failsSafely(r, legacyDir, before, targetDir, 'verify secret')
    check(!r.lines.some(l => /s0|other0/.test(l)), 'verify secret: no secret in the log')
  }
  // A backups/*.json the whitelist does not copy is what the legacy ladder loads: mismatch.
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir, { config: '{broken', bak: '{broken', backups: 1 })
    write(path.join(legacyDir, 'backups', 'zz-manual.json'), JSON.stringify(makeConfig({ tag: 'manual' })))
    const before = snapshotTree(legacyDir)
    const r = pipe(L, { legacyDir, targetDir })
    failsSafely(r, legacyDir, before, targetDir, 'verify ladder')
    check(r.marker.lastError.code === 'configMismatch', 'verify ladder: configMismatch')
  }
  // A config newer than this build.
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir, { config: JSON.stringify(makeConfig({ version: 99 })) }); const before = snapshotTree(legacyDir)
    const r = pipe(L, { legacyDir, targetDir })
    failsSafely(r, legacyDir, before, targetDir, 'verify version')
    check(r.marker.lastError.code === 'configVersion', 'verify version: configVersion')
  }
  // Injected verification failure (W16 seam).
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir); const before = snapshotTree(legacyDir)
    failsSafely(pipe(L, { legacyDir, targetDir, faultAt: 'verify' }), legacyDir, before, targetDir, 'verify fault')
  }
  // Corrupt config.json with a valid .bak: the effective config is the .bak.
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir, { config: '{broken' })
    const r = pipe(L, { legacyDir, targetDir })
    const eff = L.ladder(targetDir)
    check(r.status === 'committed' && r.marker.verified.legacyConfigLoadable && eff.source === 'config.json.bak' && eff.config.workspaces[0].name === 'bak-0', 'verify bak: migrates with the .bak as effective config')
  }
  // Every config unreadable: legacyConfigLoadable false, nothing config copied, still committed.
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir, { config: '{', bak: '{', backups: 0 })
    write(path.join(legacyDir, 'backups', stamp(0)), 'nope')
    const r = pipe(L, { legacyDir, targetDir })
    check(r.status === 'committed' && r.marker.verified.legacyConfigLoadable === false && r.marker.verified.effectiveConfigSha256 === null, 'verify corrupt: committed with legacyConfigLoadable false')
    check(!fs.existsSync(path.join(targetDir, 'config.json')) && !fs.existsSync(path.join(targetDir, 'backups')) && fs.existsSync(path.join(targetDir, 'remote-devices.json')), 'verify corrupt: no config copied, devices still are')
    check(r.marker.sources.some(s => s.rel === 'config.json'), 'verify corrupt: the raw config is still a source (it goes to the zip)')
  }
  // Unparseable legacy devices: not copied, not a failure.
  {
    const { legacyDir, targetDir } = fresh(); seedLegacy(legacyDir, { devices: '{"version":1,"devices":"x"}' })
    const r = pipe(L, { legacyDir, targetDir })
    check(r.status === 'committed' && !fs.existsSync(path.join(targetDir, 'remote-devices.json')) && r.marker.verified.devices === 0, 'verify devices: an unparseable registry is not copied')
  }
  // A source changes between the copy and the commit.
  {
    let bumps = 0
    const bumpOnBackedUp = (legacyDir, limit) => hookedFs({ renameSync: (a, b) => {
      fs.renameSync(a, b)
      if (String(b).endsWith('legacy-migration.json') && JSON.parse(fs.readFileSync(b, 'utf8')).phase === 'backedUp' && bumps < limit) {
        bumps++; fs.appendFileSync(path.join(legacyDir, 'config.json'), ' ')
      }
    } })
    const once = fresh(); seedLegacy(once.legacyDir)
    const r = pipe(L, { ...once, fs: bumpOnBackedUp(once.legacyDir, 1) })
    check(r.status === 'committed' && bumps === 1 && r.lines.some(l => l.includes('sourcesChanged round=1')), 'verify change: a changed source re-runs the migration')
    check(fs.readFileSync(path.join(once.targetDir, 'config.json'), 'utf8') === fs.readFileSync(path.join(once.legacyDir, 'config.json'), 'utf8'), 'verify change: the destination has the changed source')
    const always = fresh(); seedLegacy(always.legacyDir); bumps = 0
    const r2 = pipe(L, { ...always, fs: bumpOnBackedUp(always.legacyDir, 99) })
    check(r2.status === 'failed' && r2.marker.lastError.code === 'sourcesChanged' && bumps === 3, 'verify change: at most 3 rounds, then failed')
    check(!fs.existsSync(path.join(always.targetDir, 'config.json')), 'verify change: the destination is rolled back')
  }
}

async function resumeChecks() {
  const L = loadMigration()
  for (const point of ['migrating', 'move:2', 'verified', 'backedUp', 'committed']) {
    const base = freshDir('resume')
    const legacyDir = seedLegacy(path.join(base, 'snmulticc')), targetDir = path.join(base, 'snagentsos')
    const own = JSON.stringify(makeConfig({ tag: 'own' }))
    write(path.join(targetDir, 'config.json'), own)
    let crashed = false
    try { pipe(L, { legacyDir, targetDir, faultAt: `crash:${point}` }) } catch (e) { crashed = /crash at/.test(e.message) }
    check(crashed, `resume ${point}: the crash escapes like a killed process`)
    const r = pipe(L, { legacyDir, targetDir })
    const done = point === 'committed' ? r.status === 'alreadyCommitted' : r.status === 'committed'
    check(done && !fs.existsSync(path.join(targetDir, '.legacy-staging')), `resume ${point}: the next start ends committed`)
    const snaps = fs.readdirSync(path.join(targetDir, 'pre-import')).filter(n => n.endsWith('.json'))
    check(snaps.length === 1 && fs.readFileSync(path.join(targetDir, 'pre-import', snaps[0]), 'utf8') === own, `resume ${point}: one snapshot, the original destination config`)
    check(fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8') === fs.readFileSync(path.join(legacyDir, 'config.json'), 'utf8'), `resume ${point}: one copy of the legacy config in place`)
  }
}

/**
 * Extracts a zip with a system tool, the way a user would: Windows' bsdtar
 * (System32\tar.exe, not Git's GNU tar), bsdtar or tar on macOS, and on Linux
 * bsdtar, python's zipfile or unzip (GNU tar cannot read zip). Info-ZIP unzip
 * maps UTF-8 names to the locale charset, so it runs last and with a UTF-8
 * locale (CI runners default to C). Returns the tool used, or null when none
 * is available.
 */
function extractZip(zip, dest) {
  const { spawnSync } = require('node:child_process')
  const sys32tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const candidates = isWin
    ? [[sys32tar, ['-xf', zip, '-C', dest]]]
    : [['bsdtar', ['-xf', zip, '-C', dest]], ...(process.platform === 'darwin' ? [['tar', ['-xf', zip, '-C', dest]]] : []), ['python3', ['-m', 'zipfile', '-e', zip, dest]], ['unzip', ['-q', zip, '-d', dest]]]
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C.UTF-8', PYTHONUTF8: '1' } })
    if (!r.error && r.status === 0) return path.basename(cmd)
  }
  return null
}

async function zipChecks() {
  const L = loadMigration()
  const Z = load('src/main/migration/backupZip.ts')
  const dir = freshDir('zip')
  const entries = [
    { name: 'config.json', data: Buffer.from(JSON.stringify(makeConfig())), source: path.join(dir, 'src', 'config.json') },
    { name: 'backups/config-2026-01-01T10-00-00-000Z.json', data: Buffer.from('x'.repeat(5000)), source: 'b' },
    { name: 'other/notes \u00f1.txt', data: crypto.randomBytes(3000), source: 'n' },
    { name: 'empty.bin', data: Buffer.alloc(0), source: 'e' },
  ]
  const manifest = Z.buildManifest(entries, '2.0.0', 1000, 1000 + 5)
  const zip = path.join(dir, 'migration-backup-v1.zip')
  const res = Z.writeBackupZip(zip, entries, manifest)
  check(res.bytes === fs.statSync(zip).size && res.sha256 === sha(fs.readFileSync(zip)) && !fs.existsSync(zip + '.tmp'), 'zip: written through .tmp + rename, size and hash reported')
  check(Z.verifyBackupZip(zip, manifest), 'zip: verifies entry by entry')
  const decoded = Z.readBackupZip(zip)
  check(decoded.entries.map(e => e.name).join() === entries.map(e => e.name).join() && decoded.entries.every((e, i) => e.data.equals(entries[i].data)), 'zip: reads back every entry, manifest first and not repeated')
  check(Z.crc32(Buffer.from('123456789')) === 0xcbf43926, 'zip: CRC32 check value')
  const out = freshDir('unzip')
  const tool = extractZip(zip, out)
  if (tool) {
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    check(m.entries.length === 4 && m.entries.every(e => sha(fs.readFileSync(path.join(out, ...e.name.split('/')))) === e.sha256), `zip: extracted with ${tool}, every SHA-256 matches the manifest`)
  } else console.log('zip: no system unzipper found, extraction check skipped')
  const bytes = fs.readFileSync(zip)
  const flipped = Buffer.from(bytes); flipped[60] ^= 0xff
  fs.writeFileSync(zip, flipped)
  check(!Z.verifyBackupZip(zip, manifest), 'zip: a byte altered in the file fails verification')
  fs.writeFileSync(zip, bytes)
  check(!Z.verifyBackupZip(zip, { ...manifest, entries: manifest.entries.slice(1) }), 'zip: a manifest that does not match fails verification')
  let tooLarge = null
  try { Z.writeBackupZip(path.join(dir, 'big.zip'), [{ name: 'big', data: crypto.randomBytes(21 * 1024 * 1024), source: 'x' }], Z.buildManifest([], '2.0.0', 1, 2)) } catch (e) { tooLarge = e.code }
  check(tooLarge === 'backupTooLarge' && !fs.existsSync(path.join(dir, 'big.zip')) && !fs.existsSync(path.join(dir, 'big.zip.tmp')), 'zip: over 20 MB is refused before writing')

  // The pipeline zip: whitelist bytes as they were, extras, never status-bin or Chromium.
  const base = freshDir('zip-pipe')
  const legacyDir = seedLegacy(path.join(base, 'snmulticc'), { config: '{corrupt' })
  const targetDir = path.join(base, 'snagentsos')
  const claudeBak = path.join(base, 'home', '.claude', 'settings.json.snmulticc.bak'); write(claudeBak, '{"hooks":{}}')
  const devDir = path.join(base, 'snmulticc-dev'); write(path.join(devDir, 'config.json'), 'dev-config'); write(path.join(devDir, 'remote-devices.json'), 'dev-devices')
  const before = snapshotTree(legacyDir)
  const r = pipe(L, { legacyDir, targetDir, extras: { claudeBak, devDir } })
  const zp = path.join(targetDir, 'migration-backup-v1.zip')
  check(r.status === 'committed' && r.marker.backup && r.marker.backup.file === 'migration-backup-v1.zip', 'zip pipeline: committed with the backup recorded')
  const z = Z.readBackupZip(zp)
  const names = z.entries.map(e => e.name)
  check(r.marker.sources.every(s => z.manifest.entries.find(e => e.name === s.rel).sha256 === before[s.rel]), 'zip pipeline: every legacy file as it was, also the corrupt config')
  check(names.includes('claude/settings.json.snmulticc.bak') && names.includes('dev/config.json') && names.includes('dev/remote-devices.json'), 'zip pipeline: claude bak and dev profile files included')
  check(!names.some(n => /status-bin|Cache|lockfile|\.exe$/i.test(n)), 'zip pipeline: no status-bin, Chromium or executables')
  check(r.marker.backup.expiresAt === r.marker.backup.createdAt + 30 * 24 * 3600 * 1000 && z.manifest.appVersion === '2.0.0' && r.marker.backup.entries === names.length, 'zip pipeline: manifest dates, version and entry count')
  check(r.marker.backup.sha256 === sha(fs.readFileSync(zp)), 'zip pipeline: marker hash matches the file')

  // noLegacy: a zip only when there is a no-data item to keep.
  const nl = pipe(L, { legacyDir: null, targetDir: path.join(freshDir('nl'), 'd'), extras: { claudeBak } })
  check(nl.marker.backup && nl.marker.backup.entries === 1, 'zip noLegacy: only the claude bak')
  const none = pipe(L, { legacyDir: null, targetDir: path.join(freshDir('nl'), 'd') })
  check(!none.marker.backup && !fs.existsSync(path.join(none.marker.to, 'migration-backup-v1.zip')), 'zip noLegacy: nothing to back up, no zip')

  // Over 20 MB of whitelist data fails the phase and leaves no zip.
  {
    const b2 = freshDir('zip-big')
    const big = seedLegacy(path.join(b2, 'snmulticc'), { backups: 0 })
    for (let i = 0; i < 5; i++) write(path.join(big, 'backups', stamp(i)), crypto.randomBytes(4.9 * 1024 * 1024))
    const t2 = path.join(b2, 'snagentsos')
    const rb = pipe(L, { legacyDir: big, targetDir: t2 })
    check(rb.status === 'failed' && rb.marker.lastError.code === 'backupTooLarge' && rb.marker.lastError.phase === 'backedUp', 'zip pipeline: over 20 MB fails the backup phase')
    check(!fs.existsSync(path.join(t2, 'migration-backup-v1.zip')) && !fs.existsSync(path.join(t2, 'config.json')), 'zip pipeline: no zip and the destination rolled back')
  }

  // appendToBackup: post-commit entries keep the dates and are not added twice.
  {
    const m = JSON.parse(fs.readFileSync(path.join(targetDir, L.MARKER_FILE), 'utf8'))
    const created = m.backup.createdAt, expires = m.backup.expiresAt
    const changed = Buffer.from('changed after commit')
    const added = L.appendToBackup(targetDir, m, [{ name: 'post-commit/2026-10-19T00-00-00-000Z/config.json', data: changed, source: path.join(legacyDir, 'config.json') }], created + 5000)
    const z2 = Z.readBackupZip(zp)
    check(added === 1 && z2.manifest.createdAt === created && z2.manifest.expiresAt === expires && z2.entries.length === names.length + 1, 'zip append: post-commit entry added, createdAt and expiresAt kept')
    check(Z.verifyBackupZip(zp, z2.manifest) && m.backup.sha256 === sha(fs.readFileSync(zp)) && m.backup.entries === names.length + 1, 'zip append: verified, marker updated')
    check(L.appendToBackup(targetDir, m, [{ name: 'post-commit/later/config.json', data: changed, source: path.join(legacyDir, 'config.json') }], created + 9000) === 0, 'zip append: same source and hash is not added twice')
  }

  // Expiry with an injected clock, also while cleaning.
  {
    const marker = () => JSON.parse(fs.readFileSync(path.join(targetDir, L.MARKER_FILE), 'utf8'))
    const m = marker()
    const day = 24 * 3600 * 1000
    check(L.maintainBackup(targetDir, m.backup.createdAt + 29 * day) === false && fs.existsSync(zp), 'zip expiry: 29 days keeps the zip')
    L.writeMarker(targetDir, { ...m, phase: 'cleaning' })
    const lines = []
    check(L.maintainBackup(targetDir, m.backup.createdAt + 30 * day + 60000, undefined, l => lines.push(l)) === true && !fs.existsSync(zp), 'zip expiry: 30 days + 1 min deletes it, also in cleaning')
    check(marker().backup.deletedAt === m.backup.createdAt + 30 * day + 60000 && lines.length === 1, 'zip expiry: deletedAt recorded and logged')
    check(L.maintainBackup(targetDir, m.backup.createdAt + 60 * day) === false, 'zip expiry: runs once')
    const f = freshDir('zip-failed')
    L.writeMarker(f, { ...m, phase: 'failed', to: f })
    write(path.join(f, 'migration-backup-v1.zip'), 'x')
    check(L.maintainBackup(f, m.backup.createdAt + 60 * day) === false && fs.existsSync(path.join(f, 'migration-backup-v1.zip')), 'zip expiry: never before the commit')
  }
}

async function safeRemoveChecks() {
  const S = load('src/main/migration/safeRemove.ts')
  const p = fakeProfile()
  const guard = guardFor(p)
  const o = { delayMs: 0, elevation: { platform: 'win32', programFiles: [p.programFiles] } }
  check(await S.safeRemoveTree(path.join(p.roots.appData, 'nope'), guard, o) === 'absent', 'safeRemove: missing target is absent')
  const sentinel = path.join(p.base, 'sentinel'); write(path.join(sentinel, 'keep.txt'), 'keep')
  const asLink = path.join(p.roots.appData, 'link-root')
  fs.symlinkSync(sentinel, asLink, isWin ? 'junction' : 'dir')
  const linkRes = await S.safeRemoveTree(asLink, guard, o)
  check(linkRes.skipped === 'reparsePoint' && fs.existsSync(asLink) && fs.existsSync(path.join(sentinel, 'keep.txt')), 'safeRemove: a link as the target is refused, never followed')
  fs.rmSync(asLink, { recursive: false, force: true }); try { fs.unlinkSync(asLink) } catch {}
  const tree = path.join(p.roots.appData, 'tree')
  write(path.join(tree, 'a', 'b', 'c.txt'), 'c'); write(path.join(tree, 'ro.txt'), 'ro'); fs.chmodSync(path.join(tree, 'ro.txt'), 0o444)
  fs.symlinkSync(sentinel, path.join(tree, 'a', 'inner-link'), isWin ? 'junction' : 'dir')
  check(await S.safeRemoveTree(tree, guard, o) === 'done' && !fs.existsSync(tree), 'safeRemove: nested tree, read-only file and inner link removed')
  check(fs.readFileSync(path.join(sentinel, 'keep.txt'), 'utf8') === 'keep', 'safeRemove: the sentinel behind the inner link is intact')
  // Guards: data folders, exe folder, roots, allowedRoots, case variants.
  const legacy = path.join(p.roots.appData, 'snmulticc'); write(path.join(legacy, 'x'), 'x')
  const flip = s => s.replace(/snmulticc/, 'SnMultiCC')
  for (const [label, g] of [
    ['userData equal', { ...guard, forbiddenTree: [isWin ? flip(legacy) : legacy] }],
    ['userData inside', { ...guard, forbiddenTree: [path.join(legacy, 'sub')] }],
    ['userData containing', { ...guard, forbiddenTree: [p.roots.appData] }],
    ['exe folder inside', { ...guard, forbiddenContain: [path.join(legacy, 'app')] }],
    ['outside allowedRoots', { ...guard, allowedRoots: [p.roots.temp] }],
  ]) {
    const r = await S.safeRemoveTree(legacy, g, o)
    check(r.skipped === 'guard' && fs.existsSync(path.join(legacy, 'x')), `safeRemove guard: ${label}`)
  }
  check((await S.safeRemoveTree(p.roots.appData, guard, o)).skipped === 'guard', 'safeRemove guard: a profile root itself')
  check((await S.safeRemoveTree(path.parse(tmpRoot).root, guard, o)).skipped === 'guard', 'safeRemove guard: a filesystem root')
  check(S.violatesGuard([legacy], { ...guard, allowedRoots: [p.roots.appData] }) === false, 'safeRemove guard: inside allowedRoots passes')
  {
    // 8.3 short name in the lexical path (Windows CI temp): allowedRoots is judged on the realpath.
    const longRoot = path.join(p.base, 'runneradmin', 'Temp'), shortT = path.join(p.base, 'RUNNER~1', 'Temp', 'del-me'), longT = path.join(longRoot, 'del-me')
    const g0 = { forbiddenExact: [], forbiddenTree: [], forbiddenContain: [], allowedRoots: [longRoot] }
    check(S.violatesGuard([shortT, longT], g0, [longT]) === false, 'safeRemove guard: short-name spelling with its realpath inside allowedRoots passes')
    const escaped = path.join(p.base, 'elsewhere', 'del-me')
    check(S.violatesGuard([longT, escaped], g0, [escaped]) === true, 'safeRemove guard: lexically inside but realpath outside allowedRoots is refused')
    check(S.violatesGuard([shortT, longT], { ...g0, allowedRoots: [longRoot], forbiddenTree: [shortT] }, [longT]) === true, 'safeRemove guard: forbidden lists still apply to every spelling')
  }
  // needsElevation: skipped before touching anything.
  const pf = path.join(p.programFiles, 'SnMultiCC'); write(path.join(pf, 'SnMultiCC.exe'), 'x')
  let touched = 0
  const counting = new Proxy(fs.promises, { get: (t, k) => (['unlink', 'rmdir', 'rename', 'chmod'].includes(k) ? (...a) => { touched++; return t[k](...a) } : t[k]) })
  const el = await S.safeRemoveTree(pf, guard, { ...o, fs: counting })
  check(el.skipped === 'needsElevation' && touched === 0 && fs.existsSync(path.join(pf, 'SnMultiCC.exe')), 'safeRemove: Program Files is needsElevation with no attempt')
  check(S.needsElevation('/Applications/SnMultiCC.app', { platform: 'darwin', programFiles: [], uid: 501, ownerUid: () => 0 }) && !S.needsElevation('/Applications/SnMultiCC.app', { platform: 'darwin', programFiles: [], uid: 501, ownerUid: () => 501 }), 'safeRemove: a foreign /Applications bundle needs elevation, an own one does not')
  // EBUSY forever on one file: deferred, the rest goes.
  const busy = path.join(p.roots.temp, 'busy'); write(path.join(busy, 'locked.bin'), 'l'); write(path.join(busy, 'free.bin'), 'f')
  let unlinkCalls = 0
  const ebusy = new Proxy(fs.promises, { get: (t, k) => (k === 'unlink' ? async f => { if (String(f).endsWith('locked.bin')) { unlinkCalls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } return t.unlink(f) } : t[k]) })
  const br = await S.safeRemoveTree(busy, guard, { ...o, fs: ebusy })
  check(br.deferred === 'EBUSY' && unlinkCalls === 4 && fs.existsSync(path.join(busy, 'locked.bin')) && !fs.existsSync(path.join(busy, 'free.bin')), 'safeRemove: EBUSY retries 3 times, defers, siblings removed')
  check(await S.safeRemoveTree(busy, guard, o) === 'done', 'safeRemove: the next call finishes')
  // Tombstone: rename refused keeps everything; crash after the rename leaves only the tombstone.
  const data = path.join(p.roots.appData, 'snmulticc-data-t'); write(path.join(data, 'config.json'), '{}')
  const refuse = new Proxy(fs.promises, { get: (t, k) => (k === 'rename' ? async () => { throw Object.assign(new Error('in use'), { code: 'EPERM' }) } : t[k]) })
  const tr = await S.tombstoneAndRemove(data, guard, { ...o, fs: refuse })
  check(tr.deferred === 'EPERM' && fs.existsSync(path.join(data, 'config.json')), 'tombstone: a refused rename defers and touches nothing')
  const rofs = new Proxy(fs.promises, { get: (t, k) => (k === 'rename' ? async () => { throw Object.assign(new Error('ro'), { code: 'EROFS' }) } : t[k]) })
  check((await S.tombstoneAndRemove(data, guard, { ...o, fs: rofs })).skipped === 'readOnly', 'tombstone: read-only medium is skipped: readOnly')
  let tomb = null
  try { await S.tombstoneAndRemove(data, guard, { ...o, now: () => 0, afterRename: t => { tomb = t; throw new Error('killed') } }) } catch {}
  check(tomb && path.basename(tomb) === 'snmulticc-data-t.deleting-1970-01-01T00-00-00-000Z' && fs.existsSync(tomb) && !fs.existsSync(data), 'tombstone: after the rename only the tombstone exists')
  check(await S.removeTombstones(data, guard, o) === 'done' && !fs.existsSync(tomb), 'tombstone: the next pass finishes it')
  check(await S.removeTombstones(data, guard, o) === 'absent', 'tombstone: nothing left is absent')
  // A real lock: another process holds the file with FileShare.None (Windows only).
  if (isWin) {
    const { spawn } = require('node:child_process')
    const lockedDir = path.join(p.roots.temp, 'real-lock'); const lockedFile = path.join(lockedDir, 'held.bin'); write(lockedFile, 'held')
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${lockedFile.replace(/'/g, "''")}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()`], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    await new Promise((resolve, reject) => { ps.stdout.on('data', d => { if (String(d).includes('locked')) resolve() }); ps.on('error', reject); ps.on('exit', () => resolve()) })
    const held = await S.safeRemoveTree(lockedDir, guard, { ...o, delayMs: 10 })
    check(typeof held === 'object' && held.deferred && fs.existsSync(lockedFile), `safeRemove: a FileShare.None handle defers (${held.deferred})`)
    ps.stdin.write('\n'); ps.stdin.end()
    await new Promise(resolve => ps.on('exit', resolve))
    check(await S.safeRemoveTree(lockedDir, guard, o) === 'done', 'safeRemove: released, the next pass deletes it')
  }
}

async function cleanupChecks() {
  const L = loadMigration()
  const I = load('src/main/migration/legacyInventory.ts', withElectron(electronStub(), { process: { ...process, env: {}, argv: ['electron'] } }))
  const migrate = (p, o = {}) => pipe(L, { legacyDir: path.join(p.roots.appData, 'snmulticc'), targetDir: p.targetDir, extras: { claudeBak: path.join(p.roots.claudeDir, 'settings.json.snmulticc.bak'), devDir: path.join(p.roots.appData, 'snmulticc-dev') }, ...o })
  const marker = p => JSON.parse(fs.readFileSync(path.join(p.targetDir, 'legacy-migration.json'), 'utf8'))
  const state = (p, id) => marker(p).cleanup[id]

  // The full disk pass on the fixture: exactly L01, L12-L16 and L18 go.
  {
    const p = fakeProfile(); const { sentinel } = seedProfile(p)
    check(migrate(p).status === 'committed', 'cleanup: fixture migrated')
    const before = snapshotTree(p.base)
    const env = cleanupEnv(p)
    await I.runCleanup(env)
    const after = snapshotTree(p.base)
    const gone = Object.keys(before).filter(k => !(k in after))
    const roots = ['home/AppData/Roaming/snmulticc/', 'home/.claude/settings.json.snmulticc.bak', 'home/AppData/Local/snmulticc-updater/', 'home/AppData/Local/Temp/SnMultiCC/', 'home/AppData/Local/Temp/snmulticc-update-abc/', 'home/AppData/Local/Temp/snmulticc-swap-xyz/', 'home/AppData/Roaming/snmulticc-dev/']
    const expectedGone = Object.keys(before).filter(k => roots.some(r => k === r || k.startsWith(r)))
    check(JSON.stringify(gone.sort()) === JSON.stringify(expectedGone.sort()), `cleanup: removed exactly the L01, L12-L16, L18 paths: ${gone.filter(k => !expectedGone.includes(k))} / ${expectedGone.filter(k => !gone.includes(k))}`)
    const changed = Object.keys(after).filter(k => k in before && before[k] !== after[k] && !k.includes('snagentsos/'))
    check(changed.length === 0, `cleanup: no other path changed: ${changed}`)
    check(fs.readFileSync(path.join(sentinel, 'keep.txt'), 'utf8') === 'keep', 'cleanup: the junction target outside the legacy folder is intact')
    const m = marker(p)
    check(['L01', 'L12', 'L13', 'L14', 'L15', 'L16', 'L18'].every(id => m.cleanup[id].state === 'done'), 'cleanup: disk items done')
    check(m.cleanup.L02.state === 'absent' && m.cleanup.L03.state === 'absent' && m.cleanup.L19.state === 'absent' && m.cleanup.L20.state === 'absent', 'cleanup: items of the other mode and the documented exceptions are absent')
    check(m.phase === 'done' && m.cleanup.L05.reason === 'unexpectedUninstallEntry', 'cleanup: every item final, phase done')
    const Z = load('src/main/migration/backupZip.ts')
    const z = Z.readBackupZip(path.join(p.targetDir, 'migration-backup-v1.zip'))
    const names = z.entries.map(e => e.name)
    check(names.includes('other/notes.txt') && !names.some(n => n.startsWith('other/linked')) && z.entries.find(e => e.name === 'other/notes.txt').data.length === 1024, 'cleanup: the unknown 1 KB file is in other/, the link is not')
    check(names.includes('claude/settings.json.snmulticc.bak') && names.includes('dev/config.json'), 'cleanup: claude bak and dev config are in the zip before deletion')
    check(Z.verifyBackupZip(path.join(p.targetDir, 'migration-backup-v1.zip'), z.manifest) && m.backup.entries === names.length, 'cleanup: the rewritten zip verifies')
    check(env.lines.some(l => l.includes('item=L01 result=done')) && !env.lines.some(l => /s0|secret/.test(l)), 'cleanup: one log line per item, no secrets')
  }
  // Dev without SNAOS_FORCE_LEGACY_CLEANUP: simulation, nothing deleted, everything logged.
  {
    const p = fakeProfile(); seedProfile(p); migrate(p)
    const before = snapshotTree(p.base)
    const env = cleanupEnv(p, { simulate: true })
    const res = await I.runCleanup(env)
    check(res.simulated && sameTree(snapshotTree(p.base), before), 'cleanup dev: simulation deletes nothing and does not touch the marker')
    check(env.lines.some(l => l.startsWith('simulate item=L01 path=')) && env.lines.some(l => l.startsWith('simulate item=L14')), 'cleanup dev: every target is logged')
  }
  // userData or the exe folder overlapping the legacy folder: L01 skipped: guard.
  for (const [label, extra] of [
    ['userData equal (case variant)', p => ({ tree: [isWin ? path.join(p.roots.appData, 'SnMultiCC') : path.join(p.roots.appData, 'snmulticc')] })],
    ['userData inside', p => ({ tree: [path.join(p.roots.appData, 'snmulticc', 'profile')] })],
    ['userData containing', p => ({ tree: [p.roots.appData] })],
    ['exe folder inside', p => ({ contain: [path.join(p.roots.appData, 'snmulticc', 'app')] })],
  ]) {
    const p = fakeProfile(); seedProfile(p); migrate(p)
    await I.runCleanup(cleanupEnv(p, { guard: guardFor(p, extra(p)) }))
    check(state(p, 'L01').state === 'skipped' && state(p, 'L01').reason === 'guard' && fs.existsSync(path.join(p.roots.appData, 'snmulticc', 'config.json')), `cleanup guard: ${label}`)
  }
  // EBUSY on one item: deferred with attempts, the others finish, the next pass completes it.
  {
    const p = fakeProfile(); seedProfile(p); migrate(p)
    const ebusy = new Proxy(fs.promises, { get: (t, k) => (k === 'unlink' ? async f => { if (String(f).includes(`${path.sep}SnMultiCC${path.sep}`)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return t.unlink(f) } : t[k]) })
    await I.runCleanup(cleanupEnv(p, { fs: ebusy }))
    check(state(p, 'L14').state === 'deferred' && state(p, 'L14').reason === 'EBUSY' && state(p, 'L14').attempts === 1, 'cleanup busy: L14 deferred with attempts')
    check(state(p, 'L01').state === 'done' && state(p, 'L16').state === 'done', 'cleanup busy: the other items finish')
    await I.runCleanup(cleanupEnv(p, { fs: ebusy, firstPassOfStart: true }))
    check(state(p, 'L14').attempts === 2 && marker(p).cleanupStarts === 1, 'cleanup busy: attempts grow, a start with deferred items counts')
    await I.runCleanup(cleanupEnv(p))
    check(state(p, 'L14').state === 'done' && !fs.existsSync(path.join(p.roots.temp, 'SnMultiCC')), 'cleanup busy: released, L14 done')
  }
  // A source changed after the commit: post-commit/ in the zip, destination unchanged, L01 done.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p); migrate(p)
    const destBefore = fs.readFileSync(path.join(p.targetDir, 'config.json'))
    fs.writeFileSync(path.join(legacyDir, 'config.json'), JSON.stringify(makeConfig({ tag: 'opened-1x-again', ws: 3 })))
    write(path.join(legacyDir, 'backups', 'config-2030-01-01T00-00-00-000Z.json'), JSON.stringify(makeConfig({ tag: 'new' })))
    await I.runCleanup(cleanupEnv(p))
    const Z = load('src/main/migration/backupZip.ts')
    const z = Z.readBackupZip(path.join(p.targetDir, 'migration-backup-v1.zip'))
    const post = z.entries.filter(e => e.name.startsWith('post-commit/'))
    const m = marker(p)
    check(post.length === 2 && post.some(e => e.name.endsWith('/config.json') && e.data.toString().includes('opened-1x-again')) && m.postCommitBackup.entries === 2, 'cleanup post-commit: changed and new sources are in post-commit/')
    check(Z.verifyBackupZip(path.join(p.targetDir, 'migration-backup-v1.zip'), z.manifest) && z.manifest.createdAt === m.backup.createdAt, 'cleanup post-commit: zip verifies and keeps its dates')
    check(fs.readFileSync(path.join(p.targetDir, 'config.json')).equals(destBefore) && m.cleanup.L01.state === 'done' && !fs.existsSync(legacyDir), 'cleanup post-commit: destination unchanged, never re-migrated, L01 done')
  }
  // Unknown entries over 5 MB keep the folder.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p); migrate(p)
    write(path.join(legacyDir, 'my-videos', 'big.bin'), crypto.randomBytes(5 * 1024 * 1024 + 10))
    const env = cleanupEnv(p)
    await I.runCleanup(env)
    check(state(p, 'L01').state === 'skipped' && state(p, 'L01').reason === 'unknownFiles' && fs.existsSync(path.join(legacyDir, 'my-videos', 'big.bin')), 'cleanup unknown: over 5 MB is skipped: unknownFiles, folder kept')
    check(env.lines.some(l => l.includes('result=unknownFiles') && l.includes('my-videos')), 'cleanup unknown: the names are logged')
  }
  // 1.x running: folder items deferred, temp prefixes still go; a locked profile defers L01 alone.
  {
    const p = fakeProfile(); seedProfile(p); migrate(p)
    await I.runCleanup(cleanupEnv(p, { isLegacyProcessRunning: () => true }))
    check(['L01', 'L11', 'L12', 'L13', 'L14', 'L18'].every(id => state(p, id).state === 'deferred' && state(p, id).reason === 'legacyRunning'), 'cleanup running: legacy folders deferred')
    check(state(p, 'L15').state === 'done' && state(p, 'L16').state === 'done' && fs.existsSync(path.join(p.roots.appData, 'snmulticc')), 'cleanup running: temp downloads go, the data folder stays')
    await I.runCleanup(cleanupEnv(p, { isFolderLocked: d => d.endsWith('snmulticc') }))
    check(state(p, 'L01').state === 'deferred' && state(p, 'L01').reason === 'legacyRunning' && state(p, 'L18').state === 'done', 'cleanup running: a held lockfile defers only its folder')
  }
  // Hooks: L11 records the result; pending defers L11 and L12.
  {
    const p = fakeProfile(); seedProfile(p); migrate(p)
    await I.runCleanup(cleanupEnv(p, { migrateLegacyHooks: () => 'pending' }))
    check(state(p, 'L11').state === 'deferred' && state(p, 'L12').state === 'deferred' && state(p, 'L12').reason === 'waitingL11' && fs.existsSync(path.join(p.roots.claudeDir, 'settings.json.snmulticc.bak')), 'cleanup hooks: pending keeps L11 and the claude bak')
    await I.runCleanup(cleanupEnv(p, { migrateLegacyHooks: () => 'rewritten' }))
    check(marker(p).hooksMigration === 'rewritten' && state(p, 'L11').state === 'done' && state(p, 'L12').state === 'done', 'cleanup hooks: rewritten recorded, then the claude bak goes')
  }
  // Crash after item k and between the tombstone rename and its deletion.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p); migrate(p)
    let crashed = false
    try { await I.runCleanup(cleanupEnv(p, { faultAt: 'crash:item:L12' })) } catch (e) { crashed = /crash at item:L12/.test(e.message) }
    check(crashed && state(p, 'L12').state === 'done' && state(p, 'L01').state === 'pending', 'cleanup crash: L12 persisted before the crash, later items pending')
    crashed = false
    try { await I.runCleanup(cleanupEnv(p, { faultAt: 'crash:tombstone:L01' })) } catch (e) { crashed = /crash at tombstone:L01/.test(e.message) }
    const tombs = fs.readdirSync(p.roots.appData).filter(n => n.startsWith('snmulticc.deleting-'))
    check(crashed && !fs.existsSync(legacyDir) && tombs.length === 1, 'cleanup crash: mid L01 only the tombstone remains')
    const again = migrate(p)
    check(again.status === 'alreadyCommitted', 'cleanup crash: the next start does not migrate again')
    const P = load('src/main/paths.ts', withElectron(electronStub({ appData: p.roots.appData }), { process: { ...process, env: {}, argv: ['electron'] } }))
    check(P.getLegacyDataDir() === null, 'cleanup crash: detection ignores the tombstone')
    const zips = fs.readdirSync(p.targetDir).filter(n => n.endsWith('.zip'))
    await I.runCleanup(cleanupEnv(p))
    check(state(p, 'L01').state === 'done' && fs.readdirSync(p.roots.appData).every(n => !n.startsWith('snmulticc')) && zips.length === 1, 'cleanup crash: the tombstone is finished, one zip')
  }
  // Portable: L02 next to the exe, L03 kept with data or with a registered 1.x install.
  {
    const p = fakeProfile()
    const exeDir = path.join(p.base, 'usb'); write(path.join(exeDir, 'SnMultiCC-1.14.1-portable.exe'), 'portable')
    const legacyDir = seedLegacy(path.join(exeDir, 'snmulticc-data'))
    const target = path.join(exeDir, 'snagentsos-data')
    const roam = path.join(p.roots.appData, 'snmulticc'); write(path.join(roam, 'Cache', 'x'), 'c'); write(path.join(roam, 'config.json'), '{}')
    check(pipe(L, { legacyDir, targetDir: target, mode: 'portable' }).status === 'committed', 'cleanup portable: migrated')
    const pp = { ...p, targetDir: target }
    const env = cleanupEnv(pp, { mode: 'portable', portableDir: exeDir, guard: guardFor(pp, { contain: [exeDir] }) })
    await I.runCleanup(env)
    const m = JSON.parse(fs.readFileSync(path.join(target, 'legacy-migration.json'), 'utf8'))
    check(m.cleanup.L02.state === 'done' && !fs.existsSync(legacyDir) && fs.existsSync(path.join(exeDir, 'SnMultiCC-1.14.1-portable.exe')), 'cleanup portable: snmulticc-data next to the exe removed, inside the exe folder is allowed')
    check(m.cleanup.L01.state === 'absent' && m.cleanup.L03.state === 'skipped' && m.cleanup.L03.reason === 'ownedByInstalled' && fs.existsSync(roam), 'cleanup portable: %APPDATA% legacy with data is ownedByInstalled')
    fs.rmSync(path.join(roam, 'config.json'))
    m.cleanup.L03 = { state: 'pending', attempts: 1 }; m.phase = 'cleaning'
    fs.writeFileSync(path.join(target, 'legacy-migration.json'), JSON.stringify(m))
    const reg = makeRegistry({ [`HKLM\\${I.REG.uninstall}`]: { DisplayName: 'SnMultiCC 1.14.1' } })
    await I.runCleanup({ ...env, registry: reg })
    check(JSON.parse(fs.readFileSync(path.join(target, 'legacy-migration.json'), 'utf8')).cleanup.L03.reason === 'ownedByInstalled' && fs.existsSync(roam), 'cleanup portable: a registered 1.x install keeps it too')
    const m2 = JSON.parse(fs.readFileSync(path.join(target, 'legacy-migration.json'), 'utf8'))
    m2.cleanup.L03 = { state: 'pending', attempts: 2 }; m2.phase = 'cleaning'
    fs.writeFileSync(path.join(target, 'legacy-migration.json'), JSON.stringify(m2))
    await I.runCleanup(env)
    check(JSON.parse(fs.readFileSync(path.join(target, 'legacy-migration.json'), 'utf8')).cleanup.L03.state === 'done' && !fs.existsSync(roam), 'cleanup portable: no data, no install: removed')
  }
  // The dev sandbox check that unlocks real deletion in dev.
  {
    const realHome = path.join(tmpRoot, 'realhome')
    const tempBase = path.join(realHome, 'AppData', 'Local', 'Temp')
    const fake = path.join(tempBase, 'snaos-fake')
    const winEnv = { SNAOS_FORCE_LEGACY_CLEANUP: '1', APPDATA: path.join(fake, 'appdata'), LOCALAPPDATA: path.join(fake, 'local'), TEMP: path.join(fake, 'temp'), TMP: path.join(fake, 'temp'), USERPROFILE: path.join(fake, 'home'), CLAUDE_CONFIG_DIR: path.join(fake, 'claude') }
    const ok = I.devCleanupSandbox({ env: winEnv, platform: 'win32', realHome })
    check(ok.ok && ok.roots.length === 6, 'dev sandbox: forced with every path in the system temp is allowed')
    check(I.devCleanupSandbox({ env: { ...winEnv, SNAOS_FORCE_LEGACY_CLEANUP: undefined }, platform: 'win32', realHome }).reason === 'notForced', 'dev sandbox: not forced is simulation')
    check(I.devCleanupSandbox({ env: { ...winEnv, APPDATA: path.join(realHome, 'AppData', 'Roaming') }, platform: 'win32', realHome }).reason === 'outsideTemp:APPDATA', 'dev sandbox: the real APPDATA is refused')
    check(I.devCleanupSandbox({ env: { ...winEnv, TEMP: tempBase }, platform: 'win32', realHome }).reason === 'outsideTemp:TEMP', 'dev sandbox: the temp folder itself is not inside it')
    check(I.devCleanupSandbox({ env: { ...winEnv, CLAUDE_CONFIG_DIR: undefined }, platform: 'win32', realHome }).reason === 'missing:CLAUDE_CONFIG_DIR', 'dev sandbox: an unset path is refused (the real ~/.claude)')
    check(I.devCleanupSandbox({ env: { SNAOS_FORCE_LEGACY_CLEANUP: '1', HOME: '/tmp/snaos-fake/home', CLAUDE_CONFIG_DIR: '/tmp/snaos-fake/claude' }, platform: 'linux', realHome: '/home/u' }).ok, 'dev sandbox: POSIX fake tree under /tmp')
    const macReal = q => { if (q === '/tmp' || q.startsWith('/tmp/')) return '/private' + q; if (q === '/' || q.startsWith('/private') || q.startsWith('/var') || q.startsWith('/Users')) return q; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    check(I.devCleanupSandbox({ env: { SNAOS_FORCE_LEGACY_CLEANUP: '1', HOME: '/tmp/snaos-fake/home', CLAUDE_CONFIG_DIR: '/tmp/snaos-fake/claude' }, platform: 'darwin', realHome: '/Users/u', realpath: macReal }).ok, 'dev sandbox: macOS /tmp fake tree that does not exist yet resolves through /private/tmp')
    check(I.devCleanupSandbox({ env: { SNAOS_FORCE_LEGACY_CLEANUP: '1', HOME: '/Users/u', CLAUDE_CONFIG_DIR: '/tmp/snaos-fake/claude' }, platform: 'darwin', realHome: '/Users/u', realpath: macReal }).reason === 'outsideTemp:HOME', 'dev sandbox: macOS real HOME is refused')
    check(I.devCleanupSandbox({ env: { SNAOS_FORCE_LEGACY_CLEANUP: '1', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/tmp/x/claude' }, platform: 'linux', realHome: '/home/u' }).reason === 'outsideTemp:HOME', 'dev sandbox: the real HOME is refused')
  }
}

async function windowsItemChecks() {
  const L = loadMigration()
  const I = load('src/main/migration/legacyInventory.ts', withElectron(electronStub(), { process: { ...process, env: {}, argv: ['electron'] } }))
  const { INSTALLER_REG } = load('src/shared/brand.ts')
  const G = 'Software\\8c5f793e-c93a-5e95-add6-ae90c4af8c04'
  check(INSTALLER_REG.key === G, 'windows: installer values live under Software\\<GUID>')
  const marker = p => JSON.parse(fs.readFileSync(path.join(p.targetDir, 'legacy-migration.json'), 'utf8'))
  const state = (p, id) => marker(p).cleanup[id]
  const committed = (o = {}) => { const p = fakeProfile(); check(pipe(L, { legacyDir: null, targetDir: p.targetDir, ...o }).status === 'committed', 'windows: committed'); return p }

  // L04: install residue from LegacyInstallLocation.
  {
    const p = committed()
    const old = path.join(p.roots.localAppData, 'Programs', 'SnMultiCC')
    for (const f of ['SnMultiCC.exe', 'Uninstall SnMultiCC.exe', 'ffmpeg.dll', 'resources.pak', 'icudtl.dat', 'v8_context_snapshot.bin', 'vk_swiftshader_icd.json', 'LICENSES.chromium.html', 'resources/app.asar', 'locales/es.pak']) write(path.join(old, f), 'x')
    const custom = path.join(p.base, 'D', 'Apps', 'SnMultiCC'); write(path.join(custom, 'SnMultiCC.exe'), 'x'); write(path.join(custom, 'notas.txt'), 'mine')
    const reg = makeRegistry({ [`HKCU\\${G}`]: { LegacyInstallLocation: old } })
    await I.runCleanup(cleanupEnv(p, { registry: reg }))
    check(state(p, 'L04').state === 'done' && !fs.existsSync(old), 'L04: only the electron-builder layout: the old folder is removed')
    const p2 = committed()
    await I.runCleanup(cleanupEnv(p2, { registry: makeRegistry({ [`HKCU\\${G}`]: { LegacyInstallLocation: custom } }) }))
    check(state(p2, 'L04').state === 'skipped' && state(p2, 'L04').reason === 'unknownFiles' && fs.readFileSync(path.join(custom, 'notas.txt'), 'utf8') === 'mine', 'L04: a foreign file (notas.txt) keeps the folder: unknownFiles')
    const pf = path.join(p.programFiles, 'SnMultiCC'); write(path.join(pf, 'SnMultiCC.exe'), 'x')
    const p3 = committed()
    await I.runCleanup(cleanupEnv(p3, { registry: makeRegistry({ [`HKLM\\${G}`]: { LegacyInstallLocation: pf } }) }))
    check(state(p3, 'L04').reason === 'needsElevation' && fs.existsSync(pf), 'L04: per-machine (HKLM / Program Files) is needsElevation, untouched')
    const p4 = committed()
    const nested = path.join(p4.base, 'X', 'SnMultiCC'); write(path.join(nested, 'SnMultiCC.exe'), 'x')
    await I.runCleanup(cleanupEnv(p4, { registry: makeRegistry({ [`HKCU\\${G}`]: { LegacyInstallLocation: nested } }), exe: { execPath: path.join(nested, 'SnAgentsOS', 'SnAgentsOS.exe'), portableExeFile: () => null, setPortableExeFile() {} } }))
    check(state(p4, 'L04').reason === 'guard' && fs.existsSync(nested), 'L04: the running exe inside the old folder keeps it (guard)')
  }
  // L05: installer values go once L04 and L08 are final; the uninstall entry is never deleted.
  {
    const p = committed()
    const entries = { [`HKCU\\${I.REG.uninstall}`]: { DisplayName: 'SnAgentsOS 2.0.0' }, [`HKCU\\${G}`]: { InstallLocation: p.exeDir, LegacyInstallLocation: path.join(p.base, 'gone'), LegacyTaskbarPinned: '1' } }
    const reg = makeRegistry(entries)
    await I.runCleanup(cleanupEnv(p, { registry: reg, shortcuts: makeShortcuts() }))
    const m = marker(p)
    check(m.cleanup.L05.state === 'done' && reg.read('HKCU', G, 'LegacyInstallLocation') === null && reg.read('HKCU', G, 'LegacyTaskbarPinned') === null, 'L05: LegacyInstallLocation and LegacyTaskbarPinned deleted')
    check(reg.read('HKCU', I.REG.uninstall, 'DisplayName') === 'SnAgentsOS 2.0.0' && reg.read('HKCU', G, 'InstallLocation') === p.exeDir && !reg.ops.some(o => o[0] === 'deleteKey' && o[2] === I.REG.uninstall), 'L05: the 2.x uninstall entry and InstallLocation are never touched')
    check(m.pinRetargeted === false, 'L08: LegacyTaskbarPinned=1 with no live pin asks to pin again')
    const p2 = committed()
    const reg2 = makeRegistry({ [`HKCU\\${I.REG.uninstall}`]: { DisplayName: 'SnAgentsOS 2.0.0' }, [`HKLM\\${I.REG.uninstall}`]: { DisplayName: 'SnMultiCC 1.14.1' } })
    await I.runCleanup(cleanupEnv(p2, { registry: reg2 }))
    check(state(p2, 'L05').state === 'skipped' && state(p2, 'L05').reason === 'needsElevation' && reg2.read('HKLM', I.REG.uninstall, 'DisplayName') === 'SnMultiCC 1.14.1', 'L05: a 1.x left in HKLM is needsElevation (manual uninstall), not touched')
    const p3 = committed()
    const reg3 = makeRegistry({ [`HKCU\\${I.REG.uninstall}`]: { DisplayName: 'Something Else' }, [`HKCU\\${G}`]: { LegacyInstallLocation: 'x' } })
    await I.runCleanup(cleanupEnv(p3, { registry: reg3 }))
    check(state(p3, 'L05').reason === 'unexpectedUninstallEntry' && reg3.read('HKCU', G, 'LegacyInstallLocation') === 'x', 'L05: an unexpected DisplayName deletes nothing')
  }
  // L06, L07: legacy shortcuts.
  {
    const p = committed()
    const start = path.join(p.roots.startMenuPrograms, 'SnMultiCC.lnk'); lnk(start, path.join(p.base, 'gone', 'SnMultiCC.exe'))
    const desk = path.join(p.roots.desktop, 'SnMultiCC.lnk'); lnk(desk, path.join(p.base, 'other', 'tool.exe')); write(path.join(p.base, 'other', 'tool.exe'), 'x')
    const mine = path.join(p.roots.desktop, 'Notes.lnk'); lnk(mine, path.join(p.base, 'gone', 'SnMultiCC.exe'))
    await I.runCleanup(cleanupEnv(p, { shortcuts: makeShortcuts() }))
    check(state(p, 'L06').state === 'done' && !fs.existsSync(start), 'L06: Start Menu SnMultiCC.lnk to the 1.x exe is removed')
    check(state(p, 'L07').state === 'skipped' && fs.existsSync(desk) && fs.existsSync(mine), 'L07: a SnMultiCC.lnk retargeted by the user is kept, other names are never looked at')
  }
  // L08: live pin retargeted in place, orphan removed, foreign untouched.
  {
    const p = committed()
    const dir = p.roots.taskbarPins
    const live = path.join(dir, 'SnMultiCC.lnk'); lnk(live, path.join(p.base, 'gone', 'SnMultiCC.exe'))
    const orphan = path.join(dir, 'SnMultiCC (2).lnk'); lnk(orphan, path.join(p.base, 'gone2', 'SnMultiCC.exe'))
    const foreign = path.join(dir, 'Code.lnk'); lnk(foreign, path.join(p.base, 'code.exe'))
    const favorites = Buffer.concat([Buffer.from([1, 2, 3]), utf16('Code.lnk'), Buffer.from([0]), utf16('SnMultiCC.lnk')])
    const sh = makeShortcuts()
    await I.runCleanup(cleanupEnv(p, { shortcuts: sh, registry: makeRegistry({ [`HKCU\\${I.REG.taskband}`]: { Favorites: favorites } }) }))
    const j = JSON.parse(fs.readFileSync(live, 'utf8'))
    check(j.target === path.join(p.exeDir, 'SnAgentsOS.exe') && j.appUserModelId === 'com.sndevelopment.snagentsos' && j.iconIndex === 0, 'L08: the live pin keeps its file name and opens SnAgentsOS with the new AUMID')
    check(!fs.existsSync(orphan) && JSON.parse(fs.readFileSync(foreign, 'utf8')).target === path.join(p.base, 'code.exe'), 'L08: the orphan pin is removed, a foreign pin untouched')
    check(marker(p).pinRetargeted === true && state(p, 'L08').state === 'done', 'L08: pinRetargeted true')
    const p2 = committed()
    const live2 = path.join(p2.roots.taskbarPins, 'SnMultiCC.lnk'); lnk(live2, 'C:\\gone\\SnMultiCC.exe')
    await I.runCleanup(cleanupEnv(p2, { shortcuts: makeShortcuts(['SnMultiCC.lnk']), registry: makeRegistry() }))
    check(!fs.existsSync(live2) && marker(p2).pinRetargeted === false, 'L08: no Favorites value means alive; a failed write removes the pin and asks to pin again')
    check(j.cwd === p.exeDir, 'L08: the retargeted pin starts in the new exe folder (the old one is deleted)')
    // Portable whose exe is renamed only at exit: the pin waits for the new name, it is not dropped.
    const p3 = committed()
    const live3 = path.join(p3.roots.taskbarPins, 'SnMultiCC.lnk'); lnk(live3, path.join(p3.roots.temp, 'SnMultiCC', 'SnMultiCC.exe'))
    const pdir = path.join(p3.base, 'usb')
    const pending = path.join(pdir, 'SnAgentsOS-portable.exe')
    await I.runCleanup(cleanupEnv(p3, { mode: 'portable', portableDir: pdir, shortcuts: makeShortcuts(), exe: { execPath: path.join(p3.roots.temp, 'SnAgentsOS', 'SnAgentsOS.exe'), portableExeFile: () => pending, setPortableExeFile() {} } }))
    check(state(p3, 'L08').state === 'deferred' && state(p3, 'L08').reason === 'targetMissing' && fs.existsSync(live3) && marker(p3).pinRetargeted === undefined, 'L08: a live pin whose new exe does not exist yet is kept and retried')
    write(pending, 'renamed at exit')
    await I.runCleanup(cleanupEnv(p3, { mode: 'portable', portableDir: pdir, shortcuts: makeShortcuts(), exe: { execPath: path.join(p3.roots.temp, 'SnAgentsOS', 'SnAgentsOS.exe'), portableExeFile: () => pending, setPortableExeFile() {} } }))
    check(state(p3, 'L08').state === 'done' && JSON.parse(fs.readFileSync(live3, 'utf8')).target === pending && marker(p3).pinRetargeted === true, 'L08: the next pass retargets it to the renamed exe')
  }
  // A registry that cannot be read (PowerShell timeout) defers L03 and L13; it never skips them for good.
  {
    const p = committed()
    const upd = path.join(p.roots.localAppData, 'snmulticc-updater'); write(path.join(upd, 'installer.exe'), 'old setup')
    const broken = { read: async () => { throw Object.assign(new Error('registry'), { code: 'regError' }) }, deleteValue: async () => { throw new Error('x') }, deleteKey: async () => { throw new Error('x') } }
    await I.runCleanup(cleanupEnv(p, { registry: broken }))
    check(state(p, 'L13').state === 'deferred' && state(p, 'L13').reason === 'regError' && fs.existsSync(upd), 'L13: registry unreadable: deferred, the folder kept')
    await I.runCleanup(cleanupEnv(p, { registry: makeRegistry() }))
    check(state(p, 'L13').state === 'done' && !fs.existsSync(upd), 'L13: the next pass with a readable registry deletes it')
    const pp = committed({ mode: 'portable' })
    const ad = path.join(pp.roots.appData, 'snmulticc'); write(path.join(ad, 'status-bin', 'x.cmd'), 'x')
    await I.runCleanup(cleanupEnv(pp, { mode: 'portable', portableDir: path.join(pp.base, 'usb'), registry: broken }))
    check(state(pp, 'L03').state === 'deferred' && state(pp, 'L03').reason === 'regError' && fs.existsSync(ad), 'L03: registry unreadable: deferred, not ownedByInstalled')
  }
  // L09: the old AUMID notification key.
  {
    const p = committed()
    const reg = makeRegistry({ [`HKCU\\${I.REG.notifications}`]: { ShowInActionCenter: '1' } })
    await I.runCleanup(cleanupEnv(p, { registry: reg }))
    check(state(p, 'L09').state === 'done' && !reg.data.has(`HKCU\\${I.REG.notifications}`.toLowerCase()), 'L09: Notifications\\Settings\\<old AUMID> deleted')
    const p2 = committed()
    await I.runCleanup(cleanupEnv(p2, { registry: makeRegistry() }))
    check(state(p2, 'L09').state === 'absent', 'L09: absent counts as success')
  }
  // L10: the login item, new value before removing the legacy ones (Run and StartupApproved\Run).
  {
    const p = committed()
    const order = []
    const reg = makeRegistry({ [`HKCU\\${I.REG.run}`]: { 'com.sndevelopment.snmulticc': '"C:\\old\\SnMultiCC.exe"', Other: 'keep' }, [`HKCU\\${I.REG.startupApproved}`]: { 'com.sndevelopment.snmulticc': 'bin' } })
    const del = reg.deleteValue
    reg.deleteValue = (...a) => { order.push(`delete:${a[1].split('\\').pop()}`); return del(...a) }
    await I.runCleanup(cleanupEnv(p, { registry: reg, loginItem: { enable: () => order.push('enable') }, readMigratedSettings: () => ({ launchOnStartup: true }) }))
    check(order.slice(0, 3).join() === 'enable,delete:Run,delete:Run', `L10: the new login item is registered before the legacy values go (${order})`)
    check(reg.read('HKCU', I.REG.run, 'com.sndevelopment.snmulticc') === null && reg.read('HKCU', I.REG.startupApproved, 'com.sndevelopment.snmulticc') === null && reg.read('HKCU', I.REG.run, 'Other') === 'keep', 'L10: both legacy values removed, others kept')
    check(state(p, 'L10').state === 'done' && marker(p).loginItemMigrated === true, 'L10: done, loginItemMigrated')
    const p2 = committed()
    let enabled = 0
    await I.runCleanup(cleanupEnv(p2, { registry: makeRegistry(), loginItem: { enable: () => enabled++ }, readMigratedSettings: () => ({ launchOnStartup: false }) }))
    check(enabled === 0 && state(p2, 'L10').state === 'absent', 'L10: launchOnStartup off registers nothing, missing values are absent')
    const p3 = committed({ mode: 'portable' })
    const reg3 = makeRegistry({ [`HKCU\\${I.REG.run}`]: { 'com.sndevelopment.snmulticc': 'x' } })
    await I.runCleanup(cleanupEnv(p3, { mode: 'portable', registry: reg3, loginItem: { enable: () => enabled++ }, readMigratedSettings: () => ({ launchOnStartup: true }) }))
    check(enabled === 0 && state(p3, 'L10').state === 'absent' && reg3.read('HKCU', I.REG.run, 'com.sndevelopment.snmulticc') === 'x', 'L10: the portable has no login item and touches nothing')
  }
  // L17: the portable exe is renamed, siblings removed, shortcuts to it retargeted.
  {
    const p = fakeProfile()
    const usb = path.join(p.base, 'usb')
    const oldExe = path.join(usb, 'SnMultiCC-1.14.1-portable.exe'); write(oldExe, 'running 2.0 bytes')
    const sibling = path.join(usb, 'SnMultiCC-1.14.0-portable.exe'); write(sibling, 'older')
    const userNamed = path.join(usb, 'my-terminal.exe'); write(userNamed, 'user')
    const deskLnk = path.join(p.roots.desktop, 'Portable.lnk'); lnk(deskLnk, oldExe)
    const pinLnk = path.join(p.roots.taskbarPins, 'SnMultiCC-1.14.1-portable.lnk'); lnk(pinLnk, oldExe)
    const target = path.join(usb, 'snagentsos-data')
    pipe(L, { legacyDir: null, targetDir: target, mode: 'portable' })
    let current = oldExe
    const pp = { ...p, targetDir: target }
    const env = cleanupEnv(pp, { mode: 'portable', portableDir: usb, shortcuts: makeShortcuts(), guard: guardFor(pp, { contain: [usb] }), exe: { execPath: path.join(p.roots.temp, 'SnAgentsOS', 'SnAgentsOS.exe'), portableExeFile: () => current, setPortableExeFile: v => { current = v } } })
    await I.runCleanup(env)
    const m = JSON.parse(fs.readFileSync(path.join(target, 'legacy-migration.json'), 'utf8'))
    const renamed = path.join(usb, 'SnAgentsOS-portable.exe')
    check(m.cleanup.L17.state === 'done' && fs.readFileSync(renamed, 'utf8') === 'running 2.0 bytes' && !fs.existsSync(oldExe), 'L17: the running exe is renamed to SnAgentsOS-portable.exe')
    check(current === renamed && m.portableExeRenamedTo === renamed, 'L17: PORTABLE_EXECUTABLE_FILE follows the rename (the updater swap then keeps the new name)')
    check(!fs.existsSync(sibling) && fs.existsSync(userNamed), 'L17: the versioned 1.x sibling is removed, a user-named exe untouched')
    check(JSON.parse(fs.readFileSync(deskLnk, 'utf8')).target === renamed && JSON.parse(fs.readFileSync(pinLnk, 'utf8')).target === renamed && JSON.parse(fs.readFileSync(pinLnk, 'utf8')).appUserModelId === 'com.sndevelopment.snagentsos', 'L17: desktop shortcut and pin to the old exe now open the renamed one')
    check(m.cleanup.L06.state === 'absent' && m.cleanup.L10.state === 'absent', 'L17: the portable registers no shortcuts or login item of its own')
  }
  {
    // Name conflict: a different SnAgentsOS-portable.exe already there deletes nothing.
    const p = fakeProfile(); const usb = path.join(p.base, 'usb')
    const oldExe = path.join(usb, 'SnMultiCC-1.14.1-portable.exe'); write(oldExe, 'a')
    const sibling = path.join(usb, 'SnMultiCC-1.14.0-portable.exe'); write(sibling, 'older')
    write(path.join(usb, 'SnAgentsOS-portable.exe'), 'different')
    const target = path.join(usb, 'snagentsos-data'); pipe(L, { legacyDir: null, targetDir: target, mode: 'portable' })
    const pp = { ...p, targetDir: target }
    await I.runCleanup(cleanupEnv(pp, { mode: 'portable', portableDir: usb, guard: guardFor(pp, { contain: [usb] }), exe: { execPath: 'x', portableExeFile: () => oldExe, setPortableExeFile() { throw new Error('must not rename') } } }))
    const m = JSON.parse(fs.readFileSync(path.join(target, 'legacy-migration.json'), 'utf8'))
    check(m.cleanup.L17.state === 'skipped' && m.cleanup.L17.reason === 'nameConflict' && fs.existsSync(oldExe) && fs.existsSync(sibling), 'L17: nameConflict deletes no exe')
  }
  {
    // Same bytes already under the new name, and a rename refused while running: both go to the exit helper.
    const p = fakeProfile(); const usb = path.join(p.base, 'usb')
    const oldExe = path.join(usb, 'snmulticc.exe'); write(oldExe, 'same')
    write(path.join(usb, 'SnAgentsOS-portable.exe'), 'same')
    const target = path.join(usb, 'snagentsos-data'); pipe(L, { legacyDir: null, targetDir: target, mode: 'portable' })
    const helpers = []; let current = oldExe
    const pp = { ...p, targetDir: target }
    const exe = { execPath: 'x', portableExeFile: () => current, setPortableExeFile: v => { current = v }, scheduleExitHelper: op => { helpers.push(op); return true } }
    await I.runCleanup(cleanupEnv(pp, { mode: 'portable', portableDir: usb, guard: guardFor(pp, { contain: [usb] }), exe }))
    check(helpers.length === 1 && helpers[0].from === oldExe && !helpers[0].to && fs.existsSync(oldExe) && current.endsWith('SnAgentsOS-portable.exe'), 'L17: identical new name: the old running file is deleted by the exit helper')
    const p2 = fakeProfile(); const usb2 = path.join(p2.base, 'usb'); const old2 = path.join(usb2, 'SnMultiCC-2.exe'); write(old2, 'x')
    const t2 = path.join(usb2, 'snagentsos-data'); pipe(L, { legacyDir: null, targetDir: t2, mode: 'portable' })
    const helpers2 = []; let cur2 = old2
    const busy = new Proxy(fs.promises, { get: (t, k) => (k === 'rename' ? async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } : t[k]) })
    const pp2 = { ...p2, targetDir: t2 }
    await I.runCleanup(cleanupEnv(pp2, { fs: busy, mode: 'portable', portableDir: usb2, guard: guardFor(pp2, { contain: [usb2] }), exe: { execPath: 'x', portableExeFile: () => cur2, setPortableExeFile: v => { cur2 = v }, scheduleExitHelper: op => { helpers2.push(op); return true } } }))
    const m2 = JSON.parse(fs.readFileSync(path.join(t2, 'legacy-migration.json'), 'utf8'))
    check(helpers2[0].to.endsWith('SnAgentsOS-portable.exe') && m2.cleanup.L17.state === 'deferred' && m2.cleanup.L17.reason === 'renameAtExit', 'L17: a refused hot rename is done by the exit helper')
    const ro = new Proxy(fs.promises, { get: (t, k) => (k === 'rename' ? async () => { throw Object.assign(new Error('ro'), { code: 'EROFS' }) } : t[k]) })
    m2.cleanup.L17 = { state: 'pending', attempts: 0 }; m2.phase = 'cleaning'; fs.writeFileSync(path.join(t2, 'legacy-migration.json'), JSON.stringify(m2)); cur2 = old2
    await I.runCleanup(cleanupEnv(pp2, { fs: ro, mode: 'portable', portableDir: usb2, guard: guardFor(pp2, { contain: [usb2] }), exe: { execPath: 'x', portableExeFile: () => cur2, setPortableExeFile: v => { cur2 = v } } }))
    check(JSON.parse(fs.readFileSync(path.join(t2, 'legacy-migration.json'), 'utf8')).cleanup.L17.reason === 'readOnly' && fs.existsSync(old2), 'L17: a read-only folder is skipped: readOnly')
  }
  // A full Windows pass (installed) ends in done with the documented exceptions.
  {
    const p = fakeProfile(); seedProfile(p)
    pipe(L, { legacyDir: path.join(p.roots.appData, 'snmulticc'), targetDir: p.targetDir })
    const reg = makeRegistry({ [`HKCU\\${I.REG.uninstall}`]: { DisplayName: 'SnAgentsOS 2.0.0' } })
    const env = cleanupEnv(p, { registry: reg, shortcuts: makeShortcuts(), loginItem: { enable() {} }, platform: 'win32' })
    const res = await I.runCleanup({ ...env, platform: 'win32' })
    const open = Object.entries(res.marker.cleanup).filter(([, s]) => !['done', 'absent', 'skipped'].includes(s.state)).map(([id]) => id)
    check(open.length === 0 && res.marker.phase === 'done' && res.marker.cleanup.L05.state === 'absent', `windows pass: every item final, phase done (${open})`)
  }
}

/** The real PowerShell registry accessor, only under a throwaway HKCU test key. */
async function winRegistryChecks() {
  if (!isWin) return
  const { execFileSync } = require('node:child_process')
  const { createWinRegistry } = load('src/main/migration/winRegistry.ts')
  const key = `Software\\SnAgentsOSTest-${crypto.randomBytes(6).toString('hex')}`
  const reg = createWinRegistry(15000)
  try {
    execFileSync('reg', ['add', `HKCU\\${key}`, '/v', 'Loc', '/t', 'REG_SZ', '/d', 'C:\\Users\\Jos\u00e9\\SnMultiCC \u00f1', '/f'], { windowsHide: true })
    execFileSync('reg', ['add', `HKCU\\${key}`, '/v', 'Fav', '/t', 'REG_BINARY', '/d', '0a0b0c', '/f'], { windowsHide: true })
    execFileSync('reg', ['add', `HKCU\\${key}\\Sub`, '/v', 'X', '/t', 'REG_SZ', '/d', '1', '/f'], { windowsHide: true })
    check(await reg.read('HKCU', key, 'Loc') === 'C:\\Users\\Jos\u00e9\\SnMultiCC \u00f1', 'winRegistry: a non-ASCII REG_SZ path reads back intact')
    const fav = await reg.read('HKCU', key, 'Fav')
    check(Buffer.isBuffer(fav) && fav.toString('hex') === '0a0b0c', 'winRegistry: REG_BINARY reads as bytes')
    check(await reg.read('HKCU', key, 'Missing') === null && await reg.read('HKCU', `${key}\\Nope`, 'X') === null, 'winRegistry: absent value and key read as null')
    check(await reg.deleteValue('HKCU', key, 'Loc') === 'done' && await reg.deleteValue('HKCU', key, 'Loc') === 'absent' && await reg.read('HKCU', key, 'Loc') === null, 'winRegistry: deleteValue, then absent')
    check(await reg.deleteKey('HKCU', `${key}\\Sub`) === 'done' && await reg.deleteKey('HKCU', `${key}\\Sub`) === 'absent', 'winRegistry: deleteKey, then absent')
    check(await reg.read('HKCU', key, "x'; Remove-Item -Recurse HKCU:\\Software\\Nothing; '") === null, 'winRegistry: names are data, never script')
  } finally {
    try { execFileSync('reg', ['delete', `HKCU\\${key}`, '/f'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
}

async function posixItemChecks() {
  const L = loadMigration()
  const I = load('src/main/migration/legacyInventory.ts', withElectron(electronStub(), { process: { ...process, env: {}, argv: ['electron'] } }))
  const marker = d => JSON.parse(fs.readFileSync(path.join(d, 'legacy-migration.json'), 'utf8'))
  // macOS: ~/Library/Application Support/snmulticc through the same pipeline, SnMultiCC.app to the Trash.
  {
    const p = fakeProfile()
    const appSupport = path.join(p.home, 'Library', 'Application Support')
    const roots = { ...p.roots, appData: appSupport, localAppData: null, startMenuPrograms: null, taskbarPins: null, desktop: null }
    const legacyDir = seedLegacy(path.join(appSupport, 'snmulticc'), { launchOnStartup: true })
    const targetDir = path.join(appSupport, 'snagentsos')
    check(pipe(L, { legacyDir, targetDir }).status === 'committed', 'mac: migrated from Application Support')
    const [sysApps, userApps] = p.roots.macApplications
    const legacyApp = path.join(sysApps, 'SnMultiCC.app'); write(path.join(legacyApp, 'Contents', 'Info.plist'), 'legacy')
    const otherApp = path.join(userApps, 'SnMultiCC.app'); write(path.join(otherApp, 'Contents', 'Info.plist'), 'other')
    const trashed = []; let enabled = 0
    const pp = { ...p, roots, targetDir }
    const env = cleanupEnv(pp, {
      platform: 'darwin', roots, registry: null, elevation: { platform: 'darwin', programFiles: [] },
      guard: { forbiddenExact: [appSupport, p.home], forbiddenTree: [targetDir], forbiddenContain: [p.exeDir] },
      bundleId: a => (a === legacyApp ? 'com.sndevelopment.snmulticc' : 'com.example.other'),
      trash: async a => { trashed.push(a); fs.renameSync(a, path.join(p.base, 'Trash-' + trashed.length)) },
      loginItem: { enable: () => enabled++ }, readMigratedSettings: () => ({ launchOnStartup: true }),
    })
    await I.runCleanup(env)
    const m = marker(targetDir)
    check(m.cleanup.L01.state === 'done' && !fs.existsSync(legacyDir), 'mac: L01 removes ~/Library/Application Support/snmulticc')
    check(trashed.length === 1 && trashed[0] === legacyApp && fs.existsSync(otherApp) && m.cleanup.L21.state === 'skipped' && m.cleanup.L21.reason === 'guard', 'mac: only the bundle with the 1.x id goes to the Trash')
    check(enabled === 1 && m.cleanup.L10.state === 'done' && m.loginItemMigrated, 'mac: launchOnStartup registers the new login item')
    check(m.phase === 'done' && ['L04', 'L05', 'L06', 'L08', 'L09', 'L14'].every(id => m.cleanup[id].state === 'absent'), 'mac: Windows-only items are absent, phase done')
    // A foreign-owned bundle that cannot be trashed is needsElevation; a held profile defers.
    const p2 = fakeProfile(); const t2 = path.join(p2.base, 'data'); pipe(L, { legacyDir: null, targetDir: t2 })
    const app2 = path.join(p2.roots.macApplications[0], 'SnMultiCC.app'); write(path.join(app2, 'x'), 'x')
    const pp2 = { ...p2, targetDir: t2 }
    const base2 = { platform: 'darwin', registry: null, bundleId: () => 'com.sndevelopment.snmulticc', elevation: { platform: 'darwin', programFiles: [] } }
    await I.runCleanup(cleanupEnv(pp2, { ...base2, isFolderLocked: () => true }))
    check(marker(t2).cleanup.L21.state === 'deferred' && marker(t2).cleanup.L21.reason === 'legacyRunning', 'mac: SingletonLock held defers the bundle')
    await I.runCleanup(cleanupEnv(pp2, { ...base2, trash: async () => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }) } }))
    check(marker(t2).cleanup.L21.state === 'skipped' && marker(t2).cleanup.L21.reason === 'needsElevation' && fs.existsSync(app2), 'mac: no permission to trash is needsElevation (manual action)')
  }
  // Linux: ~/.config/snmulticc, the AppImage renamed, the .deb documented.
  {
    const p = fakeProfile()
    const config = path.join(p.home, '.config')
    const roots = { ...p.roots, appData: config, localAppData: null, startMenuPrograms: null, taskbarPins: null, desktop: null }
    const legacyDir = seedLegacy(path.join(config, 'snmulticc'))
    const targetDir = path.join(config, 'snagentsos')
    pipe(L, { legacyDir, targetDir })
    const apps = path.join(p.home, 'Apps'); const image = path.join(apps, 'SnMultiCC-1.14.1.AppImage'); write(image, 'appimage 2.0')
    let current = image
    const pp = { ...p, roots, targetDir }
    const env = cleanupEnv(pp, {
      platform: 'linux', roots, registry: null, elevation: { platform: 'linux', programFiles: [] },
      guard: { forbiddenExact: [config, p.home], forbiddenTree: [targetDir], forbiddenContain: [p.exeDir] },
      exe: { execPath: path.join(p.base, 'tmp-mount', 'snagentsos'), portableExeFile: () => null, setPortableExeFile() {}, appImage: () => current, setAppImage: v => { current = v } },
    })
    await I.runCleanup(env)
    const m = marker(targetDir)
    check(m.cleanup.L01.state === 'done' && !fs.existsSync(legacyDir), 'linux: L01 removes ~/.config/snmulticc')
    check(current === path.join(apps, 'SnAgentsOS.AppImage') && fs.readFileSync(current, 'utf8') === 'appimage 2.0' && !fs.existsSync(image) && m.cleanup.L17.state === 'done', 'linux: the AppImage is renamed and APPIMAGE follows')
    check(m.cleanup.L21.state === 'absent' && m.cleanup.L21.reason === 'debNeedsRoot' && m.phase === 'done', 'linux: the .deb is documented, not removed; phase done')
    const p2 = fakeProfile(); const t2 = path.join(p2.base, 'data'); pipe(L, { legacyDir: null, targetDir: t2 })
    const img2 = path.join(p2.home, 'SnMultiCC.AppImage'); write(img2, 'a'); write(path.join(p2.home, 'SnAgentsOS.AppImage'), 'b')
    await I.runCleanup(cleanupEnv({ ...p2, targetDir: t2 }, { platform: 'linux', registry: null, exe: { execPath: 'x', portableExeFile: () => null, setPortableExeFile() {}, appImage: () => img2, setAppImage() { throw new Error('no') } } }))
    check(marker(t2).cleanup.L17.reason === 'nameConflict' && fs.existsSync(img2), 'linux: a different SnAgentsOS.AppImage is a nameConflict')
  }
}

async function processChecks() {
  const P = load('src/main/migration/legacyProcess.ts')
  const win = P.legacyProcessQuery('win32', 'ana')
  check(win.cmd === 'tasklist' && win.args.join(' ') === '/FI IMAGENAME eq SnMultiCC.exe /FI USERNAME eq ana /FO CSV /NH', 'process: tasklist filtered by image and current user')
  check(P.legacyProcessQuery('darwin', 'ana', 501).args.join(' ') === '-U 501 -x SnMultiCC' && P.legacyProcessQuery('linux', 'ana').args.join(' ') === '-x snmulticc', 'process: pgrep -x SnMultiCC on mac, snmulticc on Linux')
  check(P.parseLegacyProcess('win32', 0, '"SnMultiCC.exe","1234","Console","1","90.000 K"') && !P.parseLegacyProcess('win32', 0, 'INFORMACION: no hay tareas ejecutandose'), 'process: tasklist output parsed (localized "none" is not running)')
  check(!P.parseLegacyProcess('linux', 1, '') && P.parseLegacyProcess('linux', 0, '4321\n') && P.parseLegacyProcess('linux', null, ''), 'process: pgrep 1 is none, a pid is running, an error counts as running')
  const throwing = status => () => { throw Object.assign(new Error('x'), status === undefined ? {} : { status }) }
  check(P.isLegacyRunningSync('linux', 'u', undefined, throwing(1)) === false && P.isLegacyRunningSync('win32', 'u', undefined, throwing(undefined)) === true, 'process: no match is not running, a timeout is running (defer, never delete)')
  check(await P.isLegacyRunningAsync('win32', 'u', undefined, async () => ({ code: 0, stdout: '"SnMultiCC.exe","1"' })) === true, 'process: async variant')
  // Profile locks.
  const ebusy = { openSync: () => { throw Object.assign(new Error('b'), { code: 'EBUSY' }) }, closeSync() {}, readlinkSync() {} }
  const enoent = { openSync: () => { throw Object.assign(new Error('n'), { code: 'ENOENT' }) }, closeSync() {}, readlinkSync() {} }
  check(P.isProfileLocked('x', 'win32', { fs: ebusy }) && !P.isProfileLocked('x', 'win32', { fs: enoent }), 'lock: a held lockfile is running, no lockfile is not')
  if (isWin) {
    const d = freshDir('lock'); write(path.join(d, 'lockfile'), '')
    check(!P.isProfileLocked(d, 'win32'), 'lock: a free lockfile on disk is not running')
  }
  const link = target => ({ openSync() {}, closeSync() {}, readlinkSync: () => target })
  check(P.isProfileLocked('x', 'linux', { fs: link('box-42'), host: 'box', kill: () => {} }), 'lock: SingletonLock with a live pid is running')
  check(!P.isProfileLocked('x', 'linux', { fs: link('box-42'), host: 'box', kill: () => { throw Object.assign(new Error('s'), { code: 'ESRCH' }) } }), 'lock: a dead pid is not running')
  check(P.isProfileLocked('x', 'darwin', { fs: link('other-42'), host: 'box', kill: () => { throw new Error('unused') } }), 'lock: another host holds it')
  check(!P.isProfileLocked('x', 'linux', { fs: { readlinkSync: () => { throw Object.assign(new Error('n'), { code: 'ENOENT' }) } } }), 'lock: no SingletonLock is not running')
  if (!isWin) {
    const d = freshDir('singleton')
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(d, 'SingletonLock'))
    check(P.isProfileLocked(d, process.platform), 'lock: a real SingletonLock to this live process is running')
  }
  // Closing 1.x: polite, then forced; the user's processes only, never the tree.
  {
    const calls = []; let alive = true
    const exec = async (cmd, args) => { calls.push([cmd, ...args]); if (cmd === 'taskkill' && args.includes('/F')) alive = false; return cmd === 'tasklist' ? { code: 0, stdout: alive ? '"SnMultiCC.exe","9"' : 'INFO' } : { code: 0, stdout: '' } }
    const ok = await P.closeLegacyApp({ platform: 'win32', username: 'ana', exec, sleep: async () => {} })
    const kills = calls.filter(c => c[0] === 'taskkill')
    check(ok && kills.length === 2 && kills.every(k => !k.includes('/T') && k.includes('USERNAME eq ana') && k.includes('SnMultiCC.exe')) && kills[1].includes('/F') && !kills[0].includes('/F'), 'close: taskkill without /T, current user only, /F after the polite try')
    const stuck = await P.closeLegacyApp({ platform: 'win32', username: 'ana', exec: async c => (c === 'tasklist' ? { code: 0, stdout: '"SnMultiCC.exe"' } : { code: 0, stdout: '' }), sleep: async () => {} })
    check(stuck === false, 'close: still running after the forced try reports failure (retry dialog)')
    const signals = []; let live = true
    const ok2 = await P.closeLegacyApp({ platform: 'linux', username: 'u', uid: 1000, exec: async () => (live ? { code: 0, stdout: '77\n' } : { code: 1, stdout: '' }), kill: (pid, sig) => { signals.push([pid, sig]); if (sig === 'SIGKILL') live = false }, sleep: async () => {} })
    check(ok2 && signals.map(s => s.join(':')).join() === '77:SIGTERM,77:SIGKILL', 'close: POSIX SIGTERM then SIGKILL to the pgrep pids')
  }
}

/** A P-LEGACY fake tree: every path variable inside the test temp root, plus the env the app would see. */
function fakeTree(extraEnv = {}) {
  const f = freshDir('p-legacy')
  const env = {
    APPDATA: path.join(f, 'appdata'), LOCALAPPDATA: path.join(f, 'localappdata'), TEMP: path.join(f, 'temp'), TMP: path.join(f, 'temp'), TMPDIR: path.join(f, 'temp'),
    USERPROFILE: path.join(f, 'home'), HOME: path.join(f, 'home'), XDG_CONFIG_HOME: path.join(f, 'appdata'), CLAUDE_CONFIG_DIR: path.join(f, 'claude'), ...extraEnv,
  }
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) if (env[k]) fs.mkdirSync(env[k], { recursive: true })
  const appDataRoot = process.platform === 'darwin' ? path.join(env.HOME, 'Library', 'Application Support') : env.APPDATA
  return { f, env, appDataRoot }
}

/** runLegacyMigration.ts against an electron stub and a fake process environment. */
function loadOrchestrator(t, o = {}) {
  const dialogs = []
  const app = {
    isPackaged: o.isPackaged ?? false,
    commandLine: { hasSwitch: () => false },
    getPath: name => {
      // A fake profile can leave Windows unable to resolve known folders (seen in the P-DESK smoke).
      if (o.throwingPaths && o.throwingPaths.includes(name)) throw new Error(`Failed to get '${name}' path`)
      return ({ userData: o.userData, appData: t.appDataRoot, home: t.env.HOME, desktop: path.join(t.env.HOME, 'Desktop'), exe: path.join(t.f, 'exe', 'SnAgentsOS.exe') })[name]
    },
    getVersion: () => '2.0.0', getLocale: () => o.locale ?? 'en-US', getAppPath: () => path.join(t.f, 'app'),
    exit: code => { throw new Error(`app.exit(${code})`) }, on() {}, setLoginItemSettings() { throw new Error('dev must not register login items') },
  }
  const electron = { app, dialog: { showMessageBoxSync: opts => { dialogs.push(opts); return 1 } }, shell: { readShortcutLink() { throw new Error('none') }, writeShortcutLink: () => false, trashItem: async () => {} } }
  const code = buildSync({ entryPoints: [path.join(root, 'src/main/migration/runLegacyMigration.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') }, define: o.define ?? {} }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: id => (id === 'electron' ? electron : require(id)), console, process: { ...process, env: t.env, argv: ['electron'] }, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate })
  return { ...mod.exports, dialogs }
}

async function orchestrationChecks() {
  const markerAt = dir => { const p = path.join(dir, 'legacy-migration.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null }
  const fakeWin = { isVisible: () => true, once() {} }
  const timers = () => { const list = []; return { list, setTimeout: (fn, ms) => { list.push({ fn, ms }) }, setInterval: () => {} } }
  // Dev without SNAOS_FORCE_LEGACY_MIGRATION: nothing runs, nothing is written.
  {
    const t = fakeTree(); seedLegacy(path.join(t.appDataRoot, 'snmulticc'))
    const userData = path.join(t.appDataRoot, 'snagentsos-dev')
    const R = loadOrchestrator(t, { userData })
    check(await R.runLegacyMigrationAtBoot() === 'continue' && !fs.existsSync(userData), 'boot dev: no migration without SNAOS_FORCE_LEGACY_MIGRATION')
  }
  // Dev with SNAOS_FORCE_LEGACY_MIGRATION on a fake tree: migrates into the dev userData; cleanup is a simulation.
  {
    const t = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1' })
    const legacyDir = seedLegacy(path.join(t.appDataRoot, 'snmulticc'))
    write(path.join(t.env.CLAUDE_CONFIG_DIR, 'settings.json.snmulticc.bak'), '{"x":1}')
    const userData = path.join(t.appDataRoot, 'snagentsos-dev')
    const R = loadOrchestrator(t, { userData })
    const seen = []
    R.onLegacyStatus(m => seen.push(m && m.phase))
    check(await R.runLegacyMigrationAtBoot() === 'continue', 'boot dev forced: continues')
    const m = markerAt(userData)
    check(m && m.phase === 'committed' && m.outcome === 'migrated' && fs.existsSync(path.join(userData, 'config.json')) && seen.includes('committed'), 'boot dev forced: migrated into snagentsos-dev, status emitted')
    const log = fs.readFileSync(path.join(userData, 'logs', 'legacy-migration.log'), 'utf8')
    check(/phase=committed outcome=migrated/.test(log) && !/s0|"secret"|legacy-0/.test(log), 'boot: log lines per transition, no contents or secrets')
    check(R.readLegacyMarker().phase === 'committed' && R.legacyBackupFile() === path.join(userData, 'migration-backup-v1.zip') && R.legacyLogFile() === path.join(userData, 'logs', 'legacy-migration.log'), 'boot: marker, zip and log paths are computed in main')
    const tm = timers()
    const pass = R.scheduleLegacyCleanup(fakeWin, { setTimeout: tm.setTimeout, setInterval: tm.setInterval })
    check(tm.list.length === 1 && tm.list[0].ms === 3000, 'cleanup: starts 3 s after the window is shown')
    await pass()
    check(fs.existsSync(path.join(legacyDir, 'config.json')) && fs.existsSync(path.join(t.env.CLAUDE_CONFIG_DIR, 'settings.json.snmulticc.bak')) && markerAt(userData).phase === 'committed', 'cleanup dev: without SNAOS_FORCE_LEGACY_CLEANUP nothing is deleted, marker untouched')
    const log2 = fs.readFileSync(path.join(userData, 'logs', 'legacy-migration.log'), 'utf8')
    check(/mode=simulation reason=notForced/.test(log2) && /simulate item=L01 path=/.test(log2), 'cleanup dev: the simulation is logged')
    check(R.scheduleLegacyCleanup(fakeWin, {}) !== pass && tm.list.length === 1, 'cleanup: scheduled once per start')
  }
  // Dev with SNAOS_FORCE_LEGACY_CLEANUP=1 and every path in the temp folder: real deletion, inside the fake roots only.
  {
    const t = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1', SNAOS_FORCE_LEGACY_CLEANUP: '1' })
    const legacyDir = seedLegacy(path.join(t.appDataRoot, 'snmulticc'))
    write(path.join(t.env.TEMP, 'snmulticc-update-1', 'x.exe'), 'x')
    const userData = path.join(t.appDataRoot, 'snagentsos-dev')
    const R = loadOrchestrator(t, { userData, throwingPaths: ['appData', 'home', 'desktop'] })
    await R.runLegacyMigrationAtBoot()
    const policy = R.cleanupPolicy()
    check(!policy.simulate && policy.reason === 'devSandbox' && policy.sandbox.length >= 5, `cleanup dev forced: sandbox accepted (${policy.reason})`)
    const guard = R.buildGuard(R.legacyRoots(), policy.sandbox)
    check(JSON.stringify(guard.allowedRoots) === JSON.stringify(policy.sandbox) && guard.forbiddenTree.includes(userData), 'cleanup dev forced: the guard only allows the fake roots and protects the data folder')
    const tm = timers()
    const pass = R.scheduleLegacyCleanup(fakeWin, { setTimeout: tm.setTimeout, setInterval: tm.setInterval })
    await pass()
    const m = markerAt(userData)
    check(!fs.existsSync(legacyDir) && !fs.existsSync(path.join(t.env.TEMP, 'snmulticc-update-1')) && m.cleanup.L01.state === 'done', 'cleanup dev forced: the fake legacy folder and temp leftovers are deleted')
    check(['L04', 'L05', 'L09', 'L10'].every(id => m.cleanup[id].state === 'absent') && m.phase === 'done', 'cleanup dev forced: no registry or login item in dev, phase done')
    check(tm.list.length === 1, 'cleanup: nothing open, no retry scheduled')
    const outside = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1', SNAOS_FORCE_LEGACY_CLEANUP: '1', CLAUDE_CONFIG_DIR: '' })
    check(loadOrchestrator(outside, { userData }).cleanupPolicy().simulate === true, 'cleanup dev forced: one path variable missing keeps the simulation')
  }
  // Deferred items retry at 60 s, then every 5 min; a deferred start counts.
  {
    const t = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1', SNAOS_FORCE_LEGACY_CLEANUP: '1' })
    seedLegacy(path.join(t.appDataRoot, 'snmulticc'))
    const userData = path.join(t.appDataRoot, 'snagentsos-dev')
    const R = loadOrchestrator(t, { userData })
    await R.runLegacyMigrationAtBoot()
    const tm = timers()
    const pass = R.scheduleLegacyCleanup(fakeWin, { setTimeout: tm.setTimeout, setInterval: tm.setInterval, isLegacyProcessRunning: () => true })
    await pass(); await pass()
    check(tm.list.map(x => x.ms).join() === '3000,60000,300000' && markerAt(userData).cleanup.L01.state === 'deferred', 'cleanup: deferred items retry at 60 s, then every 5 min')
  }
  // The daily check expires the zip while the app stays open (here with the marker in cleaning).
  {
    const t = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1', SNAOS_FORCE_LEGACY_CLEANUP: '1' })
    seedLegacy(path.join(t.appDataRoot, 'snmulticc'))
    const userData = path.join(t.appDataRoot, 'snagentsos-dev')
    const R = loadOrchestrator(t, { userData })
    await R.runLegacyMigrationAtBoot()
    const m0 = markerAt(userData)
    const zip = path.join(userData, 'migration-backup-v1.zip')
    let now = m0.backup.createdAt + 29 * 24 * 3600 * 1000
    const intervals = []
    const pass = R.scheduleLegacyCleanup(fakeWin, { setTimeout: () => {}, setInterval: (fn, ms) => intervals.push({ fn, ms }), isLegacyProcessRunning: () => true, now: () => now })
    await pass()
    check(intervals.length === 1 && intervals[0].ms === 24 * 3600 * 1000 && markerAt(userData).phase === 'cleaning', 'expiry: a daily check is scheduled with the cleanup')
    intervals[0].fn()
    check(fs.existsSync(zip) && markerAt(userData).backup.deletedAt === undefined, 'expiry daily: 29 days keeps the zip')
    now = m0.backup.createdAt + 30 * 24 * 3600 * 1000 + 60000
    intervals[0].fn()
    check(!fs.existsSync(zip) && markerAt(userData).backup.deletedAt === now && markerAt(userData).phase === 'cleaning', 'expiry daily: past expiresAt the zip goes and deletedAt is recorded, also in cleaning')
  }
  // Packaged fresh install, no 1.x anywhere: no process query, no zip, no dialog, and cheap.
  {
    const t = fakeTree()
    const userData = path.join(t.appDataRoot, 'snagentsos')
    const R = loadOrchestrator(t, { userData, isPackaged: true })
    let queried = 0
    const deps = { isLegacyRunning: () => { queried++; return false }, closeLegacy: async () => { throw new Error('no close') }, showMessageBox: () => { throw new Error('no dialog') } }
    await R.runLegacyMigrationAtBoot(deps) // warm-up of the bundle (module init, zod)
    fs.rmSync(userData, { recursive: true, force: true })
    const t0 = process.hrtime.bigint()
    const res = await R.runLegacyMigrationAtBoot(deps)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const m = markerAt(userData)
    check(res === 'continue' && queried === 0 && m.phase === 'committed' && m.outcome === 'noLegacy' && !m.backup && !fs.existsSync(path.join(userData, 'migration-backup-v1.zip')) && !fs.existsSync(path.join(userData, 'config.json')), 'fresh install: noLegacy committed, nothing copied, no zip, no process query')
    check(ms < 50, `fresh install: the boot step costs under 50 ms (${ms.toFixed(1)} ms)`)
    const t1 = process.hrtime.bigint()
    check(await R.runLegacyMigrationAtBoot(deps) === 'continue' && Number(process.hrtime.bigint() - t1) / 1e6 < 50 && queried === 0 && markerAt(userData).at === m.at, 'fresh install: the next start writes nothing and stays under 50 ms')
  }
  // The exit helper renames the old portable exe, but never over a newer exe already under the new name.
  if (isWin) {
    const { EXIT_SCRIPT } = loadOrchestrator(fakeTree(), { userData: freshDir('exit-ud') })
    const { execFileSync } = require('node:child_process')
    const runHelper = (env) => {
      const dir = freshDir('exit-helper')
      const script = path.join(dir, 'helper.cmd')
      fs.writeFileSync(script, EXIT_SCRIPT, 'utf8')
      const childEnv = { ...process.env, ...env }
      if (!env.TO) delete childEnv.TO
      execFileSync('cmd.exe', ['/c', script], { windowsHide: true, env: childEnv, stdio: 'ignore' })
      return dir
    }
    const d1 = freshDir('exit-a'); const from1 = path.join(d1, 'SnMultiCC-1.14.1-portable.exe'); const to1 = path.join(d1, 'SnAgentsOS-portable.exe'); write(from1, 'old name')
    const h1 = runHelper({ FROM: from1, TO: to1 })
    check(!fs.existsSync(from1) && fs.readFileSync(to1, 'utf8') === 'old name' && !fs.existsSync(h1), 'exit helper: renames the exe at exit and removes itself and its folder')
    const d2 = freshDir('exit-b'); const from2 = path.join(d2, 'SnMultiCC-1.14.1-portable.exe'); const to2 = path.join(d2, 'SnAgentsOS-portable.exe'); write(from2, 'old'); write(to2, 'updated in this session')
    runHelper({ FROM: from2, TO: to2 })
    check(!fs.existsSync(from2) && fs.readFileSync(to2, 'utf8') === 'updated in this session', 'exit helper: a newer exe under the new name is kept, the old file only deleted')
    const d3 = freshDir('exit-c'); const from3 = path.join(d3, 'SnMultiCC-1.14.1-portable.exe'); write(from3, 'dup')
    runHelper({ FROM: from3 })
    check(!fs.existsSync(from3), 'exit helper: without TO the old file is deleted')
  }
  // Packaged with 1.x open: the only dialog; [Quit] writes nothing, [Close] closes and migrates.
  {
    const t = fakeTree()
    seedLegacy(path.join(t.appDataRoot, 'snmulticc'), { config: JSON.stringify({ ...makeConfig(), settings: { ...makeConfig().settings, language: 'es' } }) })
    const userData = path.join(t.appDataRoot, 'snagentsos')
    const R = loadOrchestrator(t, { userData, isPackaged: true })
    let running = true, closes = 0
    const quit = await R.runLegacyMigrationAtBoot({ isLegacyRunning: () => running, closeLegacy: async () => { closes++; running = false; return true }, showMessageBox: o => { R.dialogs.push(o); return 1 } })
    const d = R.dialogs[0]
    check(quit === 'quit' && closes === 0 && !fs.existsSync(userData), '1.x open, [Quit]: no marker, no log, nothing written')
    check(d.buttons.length === 2 && d.defaultId === 0 && d.cancelId === 1 && d.message === 'SnMultiCC sigue abierto' && d.buttons[0] === 'Cerrar SnMultiCC y continuar' && !/\{\w+\}/.test(d.detail), '1.x open: dialog in the legacy config language, {legacy} interpolated, default and cancel set')
    R.dialogs.length = 0
    const go = await R.runLegacyMigrationAtBoot({ isLegacyRunning: () => running, closeLegacy: async () => { closes++; running = false; return true }, showMessageBox: o => { R.dialogs.push(o); return 0 } })
    check(go === 'continue' && closes === 1 && markerAt(userData).phase === 'committed', '1.x open, [Close]: closed, then migrated')
    const t2 = fakeTree(); seedLegacy(path.join(t2.appDataRoot, 'snmulticc'))
    const u2 = path.join(t2.appDataRoot, 'snagentsos')
    const R2 = loadOrchestrator(t2, { userData: u2, isPackaged: true, locale: 'en-GB' })
    let r2 = true; const answers = [0, 0]; let attempts = 0
    const res2 = await R2.runLegacyMigrationAtBoot({ isLegacyRunning: () => r2, closeLegacy: async () => { attempts++; if (attempts === 2) r2 = false; return attempts === 2 }, showMessageBox: o => { R2.dialogs.push(o); return answers.shift() ?? 1 } })
    check(res2 === 'continue' && attempts === 2 && R2.dialogs[1].message === 'SnMultiCC could not be closed' && R2.dialogs[1].buttons.join() === 'Retry,Quit', '1.x that will not close: [Retry] [Quit], retry then migrate')
  }
  // Fault injection only in a build defining __SNAOS_TEST_FAULTS__ (W16).
  {
    const t = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1', SNAOS_TEST_FAULT: 'verify' })
    const legacyDir = seedLegacy(path.join(t.appDataRoot, 'snmulticc')); const before = snapshotTree(legacyDir)
    const userData = path.join(t.appDataRoot, 'snagentsos-dev')
    await loadOrchestrator(t, { userData, define: { __SNAOS_TEST_FAULTS__: 'true' } }).runLegacyMigrationAtBoot()
    check(markerAt(userData).phase === 'failed' && sameTree(snapshotTree(legacyDir), before) && !fs.existsSync(path.join(userData, 'config.json')), 'fault build: SNAOS_TEST_FAULT=verify fails and keeps the legacy data (W16)')
    const t2 = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1', SNAOS_TEST_FAULT: 'verify' }); seedLegacy(path.join(t2.appDataRoot, 'snmulticc'))
    const u2 = path.join(t2.appDataRoot, 'snagentsos-dev')
    await loadOrchestrator(t2, { userData: u2 }).runLegacyMigrationAtBoot()
    check(markerAt(u2).phase === 'committed', 'release build: SNAOS_TEST_FAULT is ignored')
    const cfg = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8')
    check(cfg.includes("__SNAOS_TEST_FAULTS__: JSON.stringify(process.env.SNAOS_TEST_FAULTS_BUILD === '1')"), 'build: the fault define is false unless SNAOS_TEST_FAULTS_BUILD=1')
  }
  // A data folder that cannot be written (read-only portable, FR-33): the failure
  // stays in memory for the session, so the FR-35 banner still shows (R20-05).
  {
    const t = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1' })
    const legacyDir = seedLegacy(path.join(t.appDataRoot, 'snmulticc')); const before = snapshotTree(legacyDir)
    const blocker = path.join(t.f, 'blocker')
    fs.writeFileSync(blocker, 'not a folder')
    const userData = path.join(blocker, 'snagentsos-dev')
    const R = loadOrchestrator(t, { userData })
    const seen = []
    R.onLegacyStatus(m => seen.push(m))
    check(await R.runLegacyMigrationAtBoot() === 'continue', 'unwritable data folder: the start continues')
    const cur = R.currentLegacyMarker()
    check(R.readLegacyMarker() === null && cur && cur.phase === 'failed' && seen.length === 1 && seen[0] === cur, 'unwritable data folder: the failed result stands for the session (banner)')
    check(sameTree(snapshotTree(legacyDir), before), 'unwritable data folder: the legacy data is untouched')
    const ok = fakeTree({ SNAOS_FORCE_LEGACY_MIGRATION: '1' }); seedLegacy(path.join(ok.appDataRoot, 'snmulticc'))
    const R2 = loadOrchestrator(ok, { userData: path.join(ok.appDataRoot, 'snagentsos-dev') })
    await R2.runLegacyMigrationAtBoot()
    check(R2.currentLegacyMarker().phase === 'committed', 'a committed start reads the stored marker')
  }
  // The log rotates at 256 KB and keeps one file.
  {
    const { createLegacyLog, LOG_MAX_BYTES } = load('src/main/migration/legacyLog.ts')
    const dir = freshDir('log')
    const log = createLegacyLog(dir, () => 0)
    const line = 'phase=cleaning item=L01 result=done ' + 'x'.repeat(1000)
    for (let i = 0; i < 300; i++) log(line)
    const main = path.join(dir, 'logs', 'legacy-migration.log')
    check(LOG_MAX_BYTES === 256 * 1024 && fs.existsSync(main + '.1') && fs.statSync(main).size < LOG_MAX_BYTES && fs.statSync(main + '.1').size >= LOG_MAX_BYTES && !fs.existsSync(main + '.2'), 'log: rotated at 256 KB, one previous file kept')
    check(fs.readFileSync(main, 'utf8').startsWith('1970-01-01T00:00:00.000Z phase=cleaning'), 'log: ISO time stamp per line')
    const ro = createLegacyLog(path.join(dir, 'logs', 'legacy-migration.log', 'nested'))
    ro('never throws'); checks++
  }
  // Wiring in index.ts: before any IPC, config or device read; cleanup after the window.
  {
    const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
    const boot = index.slice(index.indexOf('async function bootstrap()'))
    const at = s => boot.indexOf(s)
    check(at('runLegacyMigrationAtBoot()') > 0 && at('runLegacyMigrationAtBoot()') < at('remoteManager.loadDevices()') && at('remoteManager.loadDevices()') < at('registerAppIpc()') && at('runLegacyMigrationAtBoot()') < at('configStore.load()'), 'index: the pipeline runs before devices, IPC and config are read')
    check(at('openMainWindow()') < at('scheduleLegacyCleanup(mainWindow)'), 'index: the cleanup is scheduled after the window opens')
    check(at("app.setAppUserModelId(BRAND.appId)") < at('runLegacyMigrationAtBoot()'), 'index: after the AUMID')
  }
  // The main-process dialog strings carry no legacy literal (they interpolate {legacy}).
  {
    const { mainTLang } = load('src/main/i18n.ts')
    const keys = ['legacy.running.title', 'legacy.running.detail', 'legacy.running.close', 'legacy.running.quit', 'legacy.failed.title', 'legacy.failed.detail', 'legacy.failed.retry', 'legacy.failed.quit']
    for (const lang of ['en', 'es']) check(keys.every(k => !/\{\w+\}/.test(mainTLang(lang, k, { legacy: 'SnMultiCC', app: 'SnAgentsOS' }))), `i18n ${lang}: legacy dialog keys interpolate`)
    check(!/snmulticc|multicc/i.test(fs.readFileSync(path.join(root, 'src/main/i18n.ts'), 'utf8')), 'i18n: no legacy literal in main strings')
  }
}

/** 8.3 short form of an existing Windows path, or null where short names are off. */
function shortPath(p) {
  if (!isWin) return null
  const { spawnSync } = require('node:child_process')
  const r = spawnSync('cmd.exe', [`/d /c for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, shell: false })
  const s = String(r.stdout || '').trim()
  return s && s.toLowerCase() !== p.toLowerCase() && fs.existsSync(s) ? s : null
}

/**
 * Data-safety review of R20-04: sequences that tried to delete data that was
 * not verified and backed up, or anything outside the allowlist.
 */
async function reviewChecks() {
  const L = loadMigration()
  const Z = load('src/main/migration/backupZip.ts')
  const S = load('src/main/migration/safeRemove.ts')
  const I = load('src/main/migration/legacyInventory.ts', withElectron(electronStub(), { process: { ...process, env: {}, argv: ['electron'] } }))
  const linkType = isWin ? 'junction' : 'dir'
  const migrate = (p, o = {}) => pipe(L, { legacyDir: path.join(p.roots.appData, 'snmulticc'), targetDir: p.targetDir, extras: { claudeBak: path.join(p.roots.claudeDir, 'settings.json.snmulticc.bak'), devDir: path.join(p.roots.appData, 'snmulticc-dev') }, ...o })
  const marker = p => JSON.parse(fs.readFileSync(path.join(p.targetDir, 'legacy-migration.json'), 'utf8'))
  const zipOf = p => Z.readBackupZip(path.join(p.targetDir, 'migration-backup-v1.zip'))
  const zipHas = (p, buf) => zipOf(p).entries.some(e => e.data.equals(buf))

  // userData (or dataDir) spelled through a junction to the 1.x folder: the guard still holds.
  {
    const p = fakeProfile()
    const legacy = path.join(p.roots.appData, 'snmulticc'); write(path.join(legacy, 'config.json'), 'live data')
    const alias = path.join(p.base, 'userdata-alias'); fs.symlinkSync(legacy, alias, linkType)
    const o = { delayMs: 0, elevation: { platform: 'win32', programFiles: [p.programFiles] } }
    const g = { ...guardFor(p), forbiddenTree: [p.targetDir, alias] }
    check((await S.safeRemoveTree(legacy, g, o)).skipped === 'guard' && fs.existsSync(path.join(legacy, 'config.json')), 'review guard: userData through a junction to the legacy folder is honored')
    check((await S.tombstoneAndRemove(legacy, g, o)).skipped === 'guard' && fs.existsSync(path.join(legacy, 'config.json')), 'review guard: the tombstone path honors it too, nothing renamed')
    const inner = path.join(p.base, 'exe-alias'); fs.symlinkSync(p.roots.appData, inner, linkType)
    check((await S.safeRemoveTree(legacy, { ...guardFor(p), forbiddenContain: [path.join(inner, 'snmulticc', 'app')] }, o)).skipped === 'guard', 'review guard: an exe folder spelled through a junction inside the target is honored')
    const allowedAlias = path.join(p.base, 'allowed-alias'); fs.symlinkSync(p.roots.temp, allowedAlias, linkType)
    write(path.join(p.roots.temp, 'del-me', 'x'), 'x')
    check(await S.safeRemoveTree(path.join(p.roots.temp, 'del-me'), { ...guardFor(p), allowedRoots: [allowedAlias] }, o) === 'done', 'review guard: allowedRoots spelled through a junction still allows its real children')
    const short = shortPath(legacy)
    if (short) check((await S.safeRemoveTree(legacy, { ...guardFor(p), forbiddenTree: [short] }, o)).skipped === 'guard' && fs.existsSync(path.join(legacy, 'config.json')), 'review guard: userData as an 8.3 short name is honored')
    // End to end: the cleanup keeps the folder and its data.
    seedLegacy(legacy); write(path.join(legacy, 'notes.txt'), 'n')
    check(migrate(p).status === 'committed', 'review guard: fixture migrated')
    await I.runCleanup(cleanupEnv(p, { guard: { ...guardFor(p), forbiddenTree: [p.targetDir, alias] } }))
    check(marker(p).cleanup.L01.state === 'skipped' && marker(p).cleanup.L01.reason === 'guard' && fs.existsSync(path.join(legacy, 'config.json')), 'review guard: L01 skipped: guard with userData through a junction')
    check(!zipOf(p).entries.some(e => e.name.startsWith('other/')), 'review guard: a guarded folder is refused before any backup work')
  }
  // The data folder reached through a junction to the 1.x folder: never migrated into itself.
  {
    const base = freshDir('review-alias')
    const legacyDir = seedLegacy(path.join(base, 'snmulticc'))
    const before = snapshotTree(legacyDir)
    const alias = path.join(base, 'alias'); fs.symlinkSync(legacyDir, alias, linkType)
    for (const targetDir of [alias, path.join(alias, 'nested', 'deeper')]) {
      const r = pipe(L, { legacyDir, targetDir })
      check(r.status === 'committed' && r.marker.outcome === 'noLegacy' && r.lines.some(l => l.includes('skip=overlap')), `review alias: ${path.basename(targetDir)} through a junction is an overlap, nothing copied`)
      const after = snapshotTree(legacyDir)
      check(Object.keys(before).every(k => after[k] === before[k]), `review alias: ${path.basename(targetDir)} leaves every legacy file as it was`)
    }
  }
  // The legacy config loads from config.json.bak (no config.json): it still wins over the destination's.
  {
    const base = freshDir('review-bak')
    const legacyDir = path.join(base, 'snmulticc'), targetDir = path.join(base, 'snagentsos')
    const legacyCfg = JSON.stringify(makeConfig({ tag: 'legacy-bak', ws: 3 }))
    write(path.join(legacyDir, 'config.json.bak'), legacyCfg); write(path.join(legacyDir, 'remote-devices.json'), devicesJson())
    const own = JSON.stringify(makeConfig({ tag: 'own', ws: 1 }))
    write(path.join(targetDir, 'config.json'), own)
    const r = pipe(L, { legacyDir, targetDir })
    check(r.status === 'committed' && L.ladder(targetDir).config.workspaces[0].name === 'legacy-bak-0', `review bak: committed and the legacy config wins (${r.marker.lastError && r.marker.lastError.code})`)
    check(r.marker.preImportSnapshot && fs.readFileSync(path.join(targetDir, r.marker.preImportSnapshot), 'utf8') === own && !fs.existsSync(path.join(targetDir, 'config.json')), 'review bak: the destination config is in pre-import/, not shadowing the legacy one')
    // Legacy loading only from backups/; the destination has a lone config.json.bak.
    const base2 = freshDir('review-bak2')
    const l2 = path.join(base2, 'snmulticc'), t2 = path.join(base2, 'snagentsos')
    write(path.join(l2, 'backups', stamp(0)), JSON.stringify(makeConfig({ tag: 'legacy-hist' })))
    write(path.join(t2, 'config.json.bak'), 'own lone bak')
    const r2 = pipe(L, { legacyDir: l2, targetDir: t2 })
    const pre = fs.existsSync(path.join(t2, 'pre-import')) ? fs.readdirSync(path.join(t2, 'pre-import')) : []
    check(r2.status === 'committed' && L.ladder(t2).config.workspaces[0].name === 'legacy-hist-0', 'review bak: a legacy config from backups/ wins too')
    check(pre.some(n => n.endsWith('.json.bak') && fs.readFileSync(path.join(t2, 'pre-import', n), 'utf8') === 'own lone bak'), 'review bak: the lone destination .bak is kept in pre-import/')
    // A failure after the displacement puts the destination back.
    const base3 = freshDir('review-bak3')
    const l3 = path.join(base3, 'snmulticc'), t3 = path.join(base3, 'snagentsos')
    write(path.join(l3, 'config.json.bak'), legacyCfg)
    write(path.join(t3, 'config.json'), own)
    check(pipe(L, { legacyDir: l3, targetDir: t3, faultAt: 'move:1' }).status === 'failed' && fs.readFileSync(path.join(t3, 'config.json'), 'utf8') === own, 'review bak: a failed run restores the displaced destination config')
  }
  // A crash leaves a torn journal: the originals moved aside are put back, never dropped with the staging.
  {
    const base = freshDir('review-journal')
    const legacyDir = seedLegacy(path.join(base, 'snmulticc')), targetDir = path.join(base, 'snagentsos')
    const own = JSON.stringify(makeConfig({ tag: 'own' }))
    write(path.join(targetDir, 'config.json'), own); write(path.join(targetDir, 'config.json.bak'), 'own-bak')
    let crashed = false
    try { pipe(L, { legacyDir, targetDir, faultAt: 'crash:move:3' }) } catch (e) { crashed = /crash at move:3/.test(e.message) }
    const journal = path.join(targetDir, '.legacy-staging', 'undo', 'journal.json')
    check(crashed && fs.existsSync(journal) && !fs.existsSync(journal + '.tmp'), 'review journal: written through tmp + rename')
    fs.writeFileSync(journal, '{"entries":[{"rel":"conf')
    const r = pipe(L, { legacyDir: null, targetDir })
    check(r.status === 'committed' && fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8') === own && fs.readFileSync(path.join(targetDir, 'config.json.bak'), 'utf8') === 'own-bak', 'review journal: an unreadable journal still restores the destination originals')
  }
  // A rollback that cannot finish keeps undo/ for the next start.
  {
    const base = freshDir('review-rollback')
    const legacyDir = seedLegacy(path.join(base, 'snmulticc')), targetDir = path.join(base, 'snagentsos')
    const own = JSON.stringify(makeConfig({ tag: 'own' }))
    write(path.join(targetDir, 'config.json'), own)
    const undo = `${path.sep}undo${path.sep}files${path.sep}`
    const fsx = hookedFs({ renameSync: (a, b) => { if (String(a).includes(undo) && !String(b).includes(undo)) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return fs.renameSync(a, b) } })
    const r = pipe(L, { legacyDir, targetDir, fs: fsx, faultAt: 'move:2' })
    check(r.status === 'failed' && fs.readFileSync(path.join(targetDir, '.legacy-staging', 'undo', 'files', 'config.json'), 'utf8') === own, 'review rollback: the original stays in undo/ when it cannot be put back')
    const r2 = pipe(L, { legacyDir: null, targetDir })
    check(r2.status === 'committed' && fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8') === own, 'review rollback: the next start restores it')
  }
  // The marker is lost after a commit: the zip there may hold the only copy of cleaned items. It is carried, never overwritten.
  {
    const p = fakeProfile(); seedProfile(p)
    check(migrate(p).status === 'committed', 'review lost marker: migrated')
    await I.runCleanup(cleanupEnv(p, { isFolderLocked: d => d.endsWith('snmulticc') }))
    check(marker(p).cleanup.L12.state === 'done' && marker(p).cleanup.L18.state === 'done' && fs.existsSync(path.join(p.roots.appData, 'snmulticc')), 'review lost marker: claude bak and dev profile cleaned, L01 still there')
    const oldZip = fs.readFileSync(path.join(p.targetDir, 'migration-backup-v1.zip'))
    for (const f of ['legacy-migration.json', 'legacy-migration.prev.json']) fs.rmSync(path.join(p.targetDir, f))
    // First a run that fails after writing its zip: the old zip comes back byte for byte.
    let markerRenames = 0
    const failing = hookedFs({ renameSync: (a, b) => { if (String(a).endsWith('legacy-migration.json.tmp') && ++markerRenames === 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.renameSync(a, b) } })
    const f = migrate(p, { fs: failing })
    check(f.status === 'failed' && fs.readFileSync(path.join(p.targetDir, 'migration-backup-v1.zip')).equals(oldZip), 'review lost marker: a failed re-run puts the previous zip back')
    const r = migrate(p)
    const prev = zipOf(p).entries.find(e => e.name === 'previous/migration-backup-v1.zip')
    check(r.status === 'committed' && prev && prev.data.equals(oldZip), 'review lost marker: the new zip carries the previous one whole')
    check(Z.readBackupZip(path.join(p.targetDir, 'migration-backup-v1.zip')).entries.length === r.marker.backup.entries && Z.decodeZip(prev.data).entries.some(e => e.name === 'claude/settings.json.snmulticc.bak'), 'review lost marker: the claude bak survives inside it')
  }
  // 1.x writes between the last check and the tombstone rename: the late bytes reach the zip before anything is deleted.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p); migrate(p)
    let done = false
    const late = new Proxy(fs.promises, { get: (t, k) => (k === 'rename' ? async (a, b) => { if (!done && String(b).includes('snmulticc.deleting-')) { done = true; fs.writeFileSync(path.join(String(a), 'config.json'), 'written by 1.x at the last moment'); fs.writeFileSync(path.join(String(a), 'late-notes.txt'), 'late') } return t.rename(a, b) } : t[k]) })
    await I.runCleanup(cleanupEnv(p, { fs: late }))
    const names = zipOf(p).entries.map(e => e.name)
    check(done && marker(p).cleanup.L01.state === 'done' && !fs.existsSync(legacyDir), 'review late write: L01 done')
    check(zipHas(p, Buffer.from('written by 1.x at the last moment')) && names.some(n => /^post-commit\/.+\/config\.json$/.test(n)) && names.includes('other/late-notes.txt'), 'review late write: the late config and the late unknown file are in the zip')
    check(Z.verifyBackupZip(path.join(p.targetDir, 'migration-backup-v1.zip'), zipOf(p).manifest), 'review late write: the zip verifies')
  }
  // A backup that fails right after the rename: the folder goes back under its own name, nothing deleted.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p); migrate(p)
    const before = snapshotTree(legacyDir)
    let done = false
    const late = new Proxy(fs.promises, { get: (t, k) => (k === 'rename' ? async (a, b) => { if (!done && String(b).includes('snmulticc.deleting-')) { done = true; write(path.join(String(a), 'big-late', 'x.bin'), crypto.randomBytes(5 * 1024 * 1024 + 1)) } return t.rename(a, b) } : t[k]) })
    await I.runCleanup(cleanupEnv(p, { fs: late }))
    const after = snapshotTree(legacyDir)
    check(marker(p).cleanup.L01.reason === 'unknownFiles' && Object.keys(before).every(k => after[k] === before[k]) && fs.readdirSync(p.roots.appData).every(n => !n.includes('.deleting-')), 'review late write: over 5 MB after the rename keeps the folder under its own name')
  }
  // The zip expired while L01 stayed deferred: when L01 finally goes, its data is in a zip again.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p)
    const m0 = migrate(p).marker
    await I.runCleanup(cleanupEnv(p, { isFolderLocked: d => d.endsWith('snmulticc') }))
    check(marker(p).cleanup.L01.state === 'deferred', 'review expiry: L01 deferred by the lock')
    const legacyCfg = fs.readFileSync(path.join(legacyDir, 'config.json'))
    check(L.maintainBackup(p.targetDir, m0.backup.createdAt + 31 * 24 * 3600 * 1000) && !fs.existsSync(path.join(p.targetDir, 'migration-backup-v1.zip')), 'review expiry: the zip expired while cleaning')
    await I.runCleanup(cleanupEnv(p))
    check(marker(p).cleanup.L01.state === 'done' && !fs.existsSync(legacyDir) && zipHas(p, legacyCfg) && marker(p).backup.deletedAt === undefined, 'review expiry: the legacy data went back into a zip before L01 deleted it')
  }
  // An unreadable zip: L01 never deletes against it.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p); migrate(p)
    fs.writeFileSync(path.join(p.targetDir, 'migration-backup-v1.zip'), 'not a zip')
    await I.runCleanup(cleanupEnv(p))
    check(marker(p).cleanup.L01.state === 'deferred' && fs.existsSync(path.join(legacyDir, 'config.json')), 'review zip: a corrupt zip defers L01, the folder stays')
  }
  // Our own data the whitelist leaves out: older backups, files under backups/, an oversized config.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p, { backups: 15 })
    write(path.join(legacyDir, 'backups', 'readme.txt'), 'my note in backups')
    migrate(p)
    const oldest = [0, 1, 2].map(i => fs.readFileSync(path.join(legacyDir, 'backups', stamp(i))))
    await I.runCleanup(cleanupEnv(p))
    const names = zipOf(p).entries.map(e => e.name)
    check(marker(p).cleanup.L01.state === 'done' && [0, 1, 2].every(i => names.includes(`other/backups/${stamp(i)}`)) && oldest.every(b => zipHas(p, b)), 'review whitelist: backups past the newest 12 are in the zip before L01 goes')
    check(names.includes('other/backups/readme.txt') && !names.some(n => n === `other/backups/${stamp(14)}`), 'review whitelist: other files under backups/ too, the copied ones not twice')
    const extracted = freshDir('review-unzip')
    const tool = extractZip(path.join(p.targetDir, 'migration-backup-v1.zip'), extracted)
    if (tool) {
      const man = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'))
      check(man.entries.length === names.length && man.entries.every(e => sha(fs.readFileSync(path.join(extracted, ...e.name.split('/')))) === e.sha256), `review whitelist: the rewritten zip extracts with ${tool} and every SHA-256 matches`)
    }
  }
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p)
    const huge = Buffer.concat([Buffer.from('{corrupt '), crypto.randomBytes(5 * 1024 * 1024 + 10)])
    fs.writeFileSync(path.join(legacyDir, 'config.json'), huge)
    check(migrate(p).status === 'committed', 'review oversized: a config over 5 MB is not copied, the .bak is')
    await I.runCleanup(cleanupEnv(p))
    check(marker(p).cleanup.L01.state === 'skipped' && marker(p).cleanup.L01.reason === 'unknownFiles' && fs.readFileSync(path.join(legacyDir, 'config.json')).equals(huge), 'review oversized: the uncopied config keeps the folder (skipped: unknownFiles)')
  }
  // L18: the dev profile's .bak and backups/ go to the zip too.
  {
    const p = fakeProfile(); const { dev } = seedProfile(p)
    write(path.join(dev, 'config.json.bak'), 'dev-bak'); write(path.join(dev, 'backups', stamp(0)), 'dev-history')
    migrate(p)
    await I.runCleanup(cleanupEnv(p))
    const names = zipOf(p).entries.map(e => e.name)
    check(marker(p).cleanup.L18.state === 'done' && names.includes('dev/config.json') && names.includes('dev/other/config.json.bak') && names.includes(`dev/other/backups/${stamp(0)}`), 'review dev: config, .bak and backups of snmulticc-dev are in the zip')
  }
  // Leftover tombstones are secured before they go.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p); migrate(p)
    const tomb = path.join(p.roots.appData, 'snmulticc.deleting-2026-10-18T00-00-00-000Z')
    fs.renameSync(legacyDir, tomb)
    fs.writeFileSync(path.join(tomb, 'config.json'), 'changed before the crash')
    write(path.join(tomb, 'diary.txt'), 'unknown in a tombstone')
    await I.runCleanup(cleanupEnv(p))
    check(marker(p).cleanup.L01.state === 'done' && !fs.existsSync(tomb) && zipHas(p, Buffer.from('changed before the crash')) && zipHas(p, Buffer.from('unknown in a tombstone')), 'review tombstone: a crash leftover is backed up, then deleted')
    const p2 = fakeProfile(); const s2 = seedProfile(p2); migrate(p2)
    const tomb2 = path.join(p2.roots.appData, 'snmulticc.deleting-2026-10-18T00-00-00-000Z')
    fs.renameSync(s2.legacyDir, tomb2)
    write(path.join(tomb2, 'videos', 'big.bin'), crypto.randomBytes(5 * 1024 * 1024 + 1))
    await I.runCleanup(cleanupEnv(p2))
    check(marker(p2).cleanup.L01.reason === 'unknownFiles' && fs.existsSync(path.join(tomb2, 'videos', 'big.bin')) && fs.existsSync(path.join(tomb2, 'config.json')), 'review tombstone: over 5 MB unknown keeps the tombstone')
  }
  // L03 (portable): unknown files go to the zip first; backups/ alone means data.
  {
    const p = fakeProfile()
    const exeDir = path.join(p.base, 'usb')
    const legacyDir = seedLegacy(path.join(exeDir, 'snmulticc-data'))
    const target = path.join(exeDir, 'snagentsos-data')
    pipe(L, { legacyDir, targetDir: target, mode: 'portable' })
    const roam = path.join(p.roots.appData, 'snmulticc'); write(path.join(roam, 'Cache', 'x'), 'c'); write(path.join(roam, 'my-script.ps1'), 'keep me')
    const pp = { ...p, targetDir: target }
    await I.runCleanup(cleanupEnv(pp, { mode: 'portable', portableDir: exeDir, guard: guardFor(pp, { contain: [exeDir] }) }))
    const m = JSON.parse(fs.readFileSync(path.join(target, 'legacy-migration.json'), 'utf8'))
    check(m.cleanup.L03.state === 'done' && !fs.existsSync(roam) && Z.readBackupZip(path.join(target, 'migration-backup-v1.zip')).entries.some(e => e.name === 'appdata/other/my-script.ps1'), 'review L03: an unknown file in %APPDATA%\\snmulticc is in the zip before deletion')
    const p2 = fakeProfile()
    const exe2 = path.join(p2.base, 'usb'); const l2 = seedLegacy(path.join(exe2, 'snmulticc-data')); const t2 = path.join(exe2, 'snagentsos-data')
    pipe(L, { legacyDir: l2, targetDir: t2, mode: 'portable' })
    const roam2 = path.join(p2.roots.appData, 'snmulticc'); write(path.join(roam2, 'backups', stamp(0)), 'history of an installed 1.x')
    const pp2 = { ...p2, targetDir: t2 }
    await I.runCleanup(cleanupEnv(pp2, { mode: 'portable', portableDir: exe2, guard: guardFor(pp2, { contain: [exe2] }) }))
    check(JSON.parse(fs.readFileSync(path.join(t2, 'legacy-migration.json'), 'utf8')).cleanup.L03.reason === 'ownedByInstalled' && fs.existsSync(path.join(roam2, 'backups', stamp(0))), 'review L03: backups/ alone is data of an install, kept')
  }
  // L01 deletes only the computed <appData>\snmulticc, never a marker "from" that points elsewhere.
  {
    const p = fakeProfile(); seedProfile(p); migrate(p)
    fs.renameSync(path.join(p.roots.appData, 'snmulticc'), path.join(p.base, 'moved-away'))
    const docs = path.join(p.home, 'Documents'); write(path.join(docs, 'thesis.txt'), 'irreplaceable')
    const m = marker(p); m.from = docs
    fs.writeFileSync(path.join(p.targetDir, 'legacy-migration.json'), JSON.stringify(m))
    await I.runCleanup(cleanupEnv(p, { legacyDataDir: null }))
    check(marker(p).cleanup.L01.state === 'absent' && fs.readFileSync(path.join(docs, 'thesis.txt'), 'utf8') === 'irreplaceable', 'review L01: a marker from outside <appData>\\snmulticc is never deleted')
  }
  // L17 in a dev sandbox: the portable exe outside the fake roots is not renamed.
  {
    const p = fakeProfile()
    const usb = path.join(p.base, 'real-usb'); const oldExe = path.join(usb, 'SnMultiCC-1.14.1-portable.exe'); write(oldExe, 'exe')
    const l = seedLegacy(path.join(usb, 'snmulticc-data')); const t = path.join(usb, 'snagentsos-data')
    pipe(L, { legacyDir: l, targetDir: t, mode: 'portable' })
    const pp = { ...p, targetDir: t }
    await I.runCleanup(cleanupEnv(pp, { mode: 'portable', portableDir: usb, guard: guardFor(pp, { contain: [usb], allowedRoots: [p.roots.temp] }), exe: { execPath: 'x', portableExeFile: () => oldExe, setPortableExeFile() { throw new Error('must not rename') } } }))
    const m = JSON.parse(fs.readFileSync(path.join(t, 'legacy-migration.json'), 'utf8'))
    check(m.cleanup.L17.state === 'skipped' && m.cleanup.L17.reason === 'guard' && fs.existsSync(oldExe) && m.cleanup.L02.reason === 'guard' && fs.existsSync(l), 'review L17: outside the dev sandbox nothing is renamed or deleted')
  }
  // A junction inside backups/ to an outside folder: removed as a link, never zipped or followed.
  {
    const p = fakeProfile(); const { legacyDir } = seedProfile(p)
    const outside = path.join(p.base, 'outside-backups'); write(path.join(outside, 'precious.json'), 'outside')
    fs.symlinkSync(outside, path.join(legacyDir, 'backups', 'linked-dir'), linkType)
    migrate(p)
    await I.runCleanup(cleanupEnv(p))
    check(marker(p).cleanup.L01.state === 'done' && fs.readFileSync(path.join(outside, 'precious.json'), 'utf8') === 'outside' && !zipOf(p).entries.some(e => e.name.includes('linked-dir')), 'review link: a junction in backups/ is unlinked, its target intact and not zipped')
  }
  // The portable exe living inside %APPDATA%\snmulticc: L03 never deletes its own folder.
  {
    const p = fakeProfile()
    const roam = path.join(p.roots.appData, 'snmulticc'); write(path.join(roam, 'Cache', 'x'), 'c')
    const exeDir = path.join(roam, 'tools'); write(path.join(exeDir, 'SnAgentsOS-portable.exe'), 'exe')
    const t = path.join(exeDir, 'snagentsos-data')
    pipe(L, { legacyDir: null, targetDir: t, mode: 'portable' })
    const pp = { ...p, targetDir: t }
    await I.runCleanup(cleanupEnv(pp, { mode: 'portable', portableDir: exeDir, guard: guardFor(pp, { contain: [exeDir] }) }))
    const m = JSON.parse(fs.readFileSync(path.join(t, 'legacy-migration.json'), 'utf8'))
    check(m.cleanup.L03.state === 'skipped' && m.cleanup.L03.reason === 'guard' && fs.existsSync(path.join(exeDir, 'SnAgentsOS-portable.exe')) && fs.existsSync(path.join(t, 'legacy-migration.json')), 'review portable: an exe folder inside %APPDATA%\\snmulticc keeps it (skipped: guard)')
  }
  // L14: a %TEMP%\SnMultiCC that is not the unpacked app (a clone of the old repo) is not deleted.
  {
    const p = fakeProfile(); seedProfile(p); migrate(p)
    const clone = path.join(p.roots.temp, 'SnMultiCC')
    write(path.join(clone, '.git', 'HEAD'), 'ref: refs/heads/main'); write(path.join(clone, 'src', 'main', 'index.ts'), 'code')
    await I.runCleanup(cleanupEnv(p))
    check(marker(p).cleanup.L14.state === 'skipped' && marker(p).cleanup.L14.reason === 'unknownFiles' && fs.existsSync(path.join(clone, '.git', 'HEAD')), 'review L14: a folder that is not the electron-builder layout is kept')
  }
}

async function main() {
  try {
    await markerChecks()
    await pathsChecks()
    await devUserDataChecks()
    await deviceRegistryChecks()
    await pipelineChecks()
    await verificationChecks()
    await resumeChecks()
    await zipChecks()
    await safeRemoveChecks()
    await cleanupChecks()
    await windowsItemChecks()
    await winRegistryChecks()
    await posixItemChecks()
    await processChecks()
    await orchestrationChecks()
    await reviewChecks()
    console.log(`PASS: ${checks} legacy migration and cleanup checks`)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
