// Unfinished-update marker (app 2.4.0): esbuild + vm, no Electron. The silent
// NSIS update quits the app before the setup runs; the marker written under
// dataDir() turns a setup that never completed (a declined permission prompt)
// into one update:notApplied toast on the next start. Covers the pure reader
// (numeric version order, age window, malformed files), the read-and-delete at
// start against a throwaway folder and the one-shot IPC handler. B5 integration (third round): the BOM
// strippers of runtimeFile, repoConfig and HookInstaller (and this suite) spell U+FEFF as an escape.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const DASH_RE = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setImmediate, ...overrides })
  return mod.exports
}

async function main() {
  const m = load('src/main/updateMarker.ts')
  const HOUR = 60 * 60 * 1000
  const now = 1_800_000_000_000
  const text = (o) => JSON.stringify(o)

  // --- numeric version order (the comparator the updater uses too) ---------
  {
    const rows = [
      ['2.10.0', '2.9.0', true], ['2.9.0', '2.10.0', false], ['2.4.0', '2.4.0', false], ['v2.4.1', '2.4.0', true],
      ['2.4.0', '2.4.0-beta.1', false], ['3.0.0', '2.99.99', true], ['2.4', '2.4.0', false], ['2.4.0.1', '2.4.0', true],
    ]
    for (const [a, b, want] of rows) check(m.isNewer(a, b) === want, `isNewer(${a}, ${b}) === ${want}`)
    const updater = fs.readFileSync(path.join(root, 'src/main/updater.ts'), 'utf8')
    check(!/function (isNewer|parseVersion)\b/.test(updater) && /import \{[^}]*\bisNewer\b[^}]*\} from '\.\/updateMarker'/.test(updater), 'updater.ts uses the same comparator (no second copy)')
  }

  // --- the pure reader --------------------------------------------------------
  {
    const fresh = { from: '2.4.0', to: '2.4.1', at: now - 60_000 }
    assert.deepStrictEqual({ ...m.readUpdateMarker(text(fresh), '2.4.0', now) }, { from: '2.4.0', to: '2.4.1' }); checks++
    check(m.readUpdateMarker(text(fresh), '2.4.1', now) === null, 'the version advanced to `to`: silent')
    check(m.readUpdateMarker(text(fresh), '2.5.0', now) === null, 'the version went past `to`: silent')
    // 2.9.0 -> 2.10.0: a string compare would read the landed update as not applied.
    const big = { from: '2.9.0', to: '2.10.0', at: now - 1000 }
    check(m.readUpdateMarker(text(big), '2.10.0', now) === null, '2.9.0 -> 2.10.0 landed: no toast (numeric, never lexical)')
    check(m.readUpdateMarker(text(big), '2.9.0', now)?.to === '2.10.0', '2.9.0 -> 2.10.0 still on 2.9.0: toast')
    check(m.readUpdateMarker(text({ from: '2.10.0', to: '2.11.0', at: now }), '2.9.0', now)?.to === '2.11.0', 'any version below `to` counts as not applied')
    // The age window: under an hour, a small future skew tolerated.
    check(m.readUpdateMarker(text({ ...fresh, at: now - HOUR + 1 }), '2.4.0', now) !== null, 'just under an hour: toast')
    check(m.readUpdateMarker(text({ ...fresh, at: now - HOUR - 1 }), '2.4.0', now) === null, 'over an hour: stale, silent')
    check(m.readUpdateMarker(text({ ...fresh, at: now + 60_000 }), '2.4.0', now) !== null, 'a minute in the future (clock skew): toast')
    check(m.readUpdateMarker(text({ ...fresh, at: now + 2 * HOUR }), '2.4.0', now) === null, 'far in the future: silent')
    // Malformed files never toast.
    const bad = [
      '', 'not json', 'null', '[]', '{}', text({ from: '2.4.0', to: '2.4.1' }), text({ ...fresh, at: 'yesterday' }),
      text({ ...fresh, at: -1 }), text({ ...fresh, to: 'latest' }), text({ ...fresh, from: 42 }), text({ ...fresh, to: '9'.repeat(80) + '.0.0' }),
      text({ ...fresh, to: '2.4.1; rm -rf /' }), '\uFEFF' + text(fresh),
    ]
    for (const b of bad) check(m.readUpdateMarker(b, '2.4.0', now) === null, `malformed marker is silent: ${JSON.stringify(b).slice(0, 60)}`)
    check(m.parseUpdateMarker(text({ ...fresh, extra: 1 }))?.to === '2.4.1', 'unknown fields are ignored')
    check(m.parseUpdateMarker(text({ ...fresh, to: 'v2.4.1-beta.2' }))?.to === 'v2.4.1-beta.2', 'a tag-like version with a prerelease parses')
    check(m.UPDATE_MARKER_FILE === 'update-pending.json' && m.UPDATE_MARKER_MAX_AGE_MS === HOUR, 'file name and age window')
  }

  // --- write + take against a throwaway folder ------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-update-marker-'))
  try {
    const file = path.join(dir, m.UPDATE_MARKER_FILE)
    check(m.takeUpdateMarker(dir, '2.4.0', now) === null, 'no marker: nothing to show')
    await m.writeUpdateMarker(dir, { from: '2.4.0', to: '2.4.1', at: now - 1000 })
    const raw = fs.readFileSync(file)
    check(raw[0] === 0x7b && JSON.parse(raw.toString('utf8')).to === '2.4.1', 'written as plain UTF-8 JSON without BOM')
    check(fs.readdirSync(dir).join() === m.UPDATE_MARKER_FILE, 'atomic write leaves only the marker')
    const taken = m.takeUpdateMarker(dir, '2.4.0', now)
    check(taken && taken.from === '2.4.0' && taken.to === '2.4.1', 'take returns the unfinished update')
    check(!fs.existsSync(file), 'take deletes the marker (one-shot)')
    check(m.takeUpdateMarker(dir, '2.4.0', now) === null, 'a second start shows nothing')
    for (const [content, current, label] of [['garbage', '2.4.0', 'malformed'], [text({ from: '2.4.0', to: '2.4.1', at: now }), '2.4.1', 'applied'], [text({ from: '2.4.0', to: '2.4.1', at: now - 2 * HOUR }), '2.4.0', 'stale']]) {
      fs.writeFileSync(file, content)
      check(m.takeUpdateMarker(dir, current, now) === null && !fs.existsSync(file), `${label} marker: silent and deleted`)
    }
    await m.writeUpdateMarker(dir, { from: '2.4.0', to: '2.4.1', at: now })
    m.clearUpdateMarker(dir)
    m.clearUpdateMarker(dir)
    check(!fs.existsSync(file), 'clear removes it and tolerates a missing file')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // --- the one-shot IPC handler ---------------------------------------------
  {
    const handlers = new Map()
    const electron = { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} } }
    const { CH } = load('src/shared/ipc-channels.ts')
    check(CH.UPDATE_NOT_APPLIED === 'update:notApplied', 'channel update:notApplied')
    const { registerUpdateIpc } = load('src/main/ipc/registerUpdateIpc.ts', { require: (id) => (id === 'electron' ? electron : require(id)) })
    const { UpdateStateStore } = load('src/main/updateState.ts')
    const hooks = { getSender: () => null, quitForUpdate() {}, setInstalling() {}, check: async () => ({}), install: async () => ({ relaunching: false }), state: new UpdateStateStore() }
    registerUpdateIpc({ ...hooks, notApplied: { from: '2.4.0', to: '2.4.1' } })
    const take = handlers.get(CH.UPDATE_NOT_APPLIED)
    check(typeof take === 'function', 'update:notApplied is registered')
    assert.deepStrictEqual({ ...take() }, { from: '2.4.0', to: '2.4.1' }); checks++
    check(take() === null && take() === null, 'answered once, then null (a reload shows no second toast)')
    handlers.clear()
    registerUpdateIpc(hooks)
    check(handlers.get(CH.UPDATE_NOT_APPLIED)() === null, 'without a marker it answers null')
  }

  // --- BOM strippers: the escape, never the invisible character itself -------
  {
    const BOM = String.fromCharCode(0xFEFF)
    const ESC = String.fromCharCode(92) + 'uFEFF'
    for (const rel of ['src/main/cli/runtimeFile.ts', 'src/main/repoConfig/repoConfig.ts', 'src/main/status/HookInstaller.ts', 'scripts/test-update-marker.cjs']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8')
      check(!src.includes(BOM) && src.includes(ESC), `${rel}: a BOM is spelled as its escape, no raw U+FEFF in the source`)
    }
  }

  // --- copy: es/en for every new string, no dashes -------------------------
  {
    const { en } = load('src/renderer/i18n/en.ts')
    const { es } = load('src/renderer/i18n/es.ts')
    for (const key of ['update.notApplied.title', 'update.notApplied.body', 'update.notApplied.retry', 'update.installerNote']) {
      check(typeof en[key] === 'string' && en[key] && typeof es[key] === 'string' && es[key] && en[key] !== es[key], `${key} in es and en`)
      check(!DASH_RE.test(en[key] + es[key]), `${key}: no en/em dash`)
    }
    check(en['update.notApplied.title'].includes('{version}') && es['update.notApplied.title'].includes('{version}'), 'the title names the version')
    check(/reopen/.test(en['update.installerNote']) && /permission/.test(en['update.installerNote']) && /volver/.test(es['update.installerNote']) && /permiso/.test(es['update.installerNote']), 'installer note: closes, updates, reopens, Windows may ask for permission')
  }

  console.log(`PASS: ${checks} update marker checks (version order, age window, malformed files, take-and-delete, one-shot IPC, BOM escapes, copy)`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
