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
 * bsdtar, unzip or python's zipfile (GNU tar cannot read zip). Returns the
 * tool used, or null when none is available.
 */
function extractZip(zip, dest) {
  const { spawnSync } = require('node:child_process')
  const sys32tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const candidates = isWin
    ? [[sys32tar, ['-xf', zip, '-C', dest]]]
    : [['bsdtar', ['-xf', zip, '-C', dest]], ...(process.platform === 'darwin' ? [['tar', ['-xf', zip, '-C', dest]]] : []), ['unzip', ['-q', zip, '-d', dest]], ['python3', ['-m', 'zipfile', '-e', zip, dest]]]
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
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
    console.log(`PASS: ${checks} legacy migration and cleanup checks`)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
