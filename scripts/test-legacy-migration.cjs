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

async function main() {
  try {
    await markerChecks()
    await pathsChecks()
    await devUserDataChecks()
    await deviceRegistryChecks()
    console.log(`PASS: ${checks} legacy migration and cleanup checks`)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
