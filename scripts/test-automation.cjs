// Automation suite (E8). R22-01: schema 12, the snippets -> quickCommands
// migration, item-by-item parsing, the 100 cap, merge remap and the store's
// Quick Commands actions. Same esbuild + vm harness as test-status.cjs.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const warnings = []
const quietConsole = { ...console, warn: (...a) => warnings.push(a.join(' ')) }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console: quietConsole, process, Buffer, structuredClone, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const clone = (v) => JSON.parse(JSON.stringify(v))

const { parseConfig, CONFIG_VERSION } = load('src/main/store/schema.ts')
const QC = load('src/shared/quickCommands.ts')

const baseSettings = { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false }
function v11(extra = {}) {
  return {
    version: 11,
    workspaces: [
      { id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [{ id: 'p1', type: 'shell', title: 'Shell', color: '#fff', icon: 'terminal' }] },
      { id: 'w2', name: 'Dos', cwd: 'C:/b', panes: [{ id: 'p2', type: 'claude', title: 'Claude', color: '#fff', icon: 'claude' }] },
    ],
    presets: [{ id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }],
    settings: clone(baseSettings),
    activeWorkspaceId: 'w1',
    ...extra,
  }
}
const qc = (i, extra = {}) => ({ id: `qc-${i}`, name: `Cmd ${i}`, text: `echo ${i}`, action: 'send', enter: false, ...extra })

function schemaChecks() {
  check(CONFIG_VERSION === 12, 'CONFIG_VERSION is 12')

  // E8-FR-01: 3 snippets -> 3 global send commands, same order and ids, no Enter.
  const snippets = [{ id: 'snip-a', name: 'Continua', text: 'continua' }, { id: 'snip-b', name: 'Compact', text: '/compact' }, { id: 'snip-c', name: 'Tests', text: 'corre los tests\ny arregla' }]
  const raw = v11({ snippets: clone(snippets) })
  const a = parseConfig(clone(raw))
  check(a && a.version === 12, 'a v11 config with snippets parses and is stamped 12')
  check(a.quickCommands.length === 3 && a.quickCommands.map(c => c.id).join() === 'snip-a,snip-b,snip-c', 'snippets migrate in order, keeping their ids')
  check(a.quickCommands.every((c, i) => c.action === 'send' && c.enter === false && c.workspaceId === undefined && c.presetId === undefined && c.name === snippets[i].name && c.text === snippets[i].text), 'migrated commands are global send without Enter, same label and text')
  check(!('snippets' in a), 'the parsed config (the next save) no longer carries snippets')
  const b = parseConfig(clone(a))
  check(JSON.stringify(b) === JSON.stringify(a), 'migration is idempotent: a second parse changes nothing')
  const both = parseConfig(v11({ quickCommands: [qc(1)], snippets: clone(snippets) }))
  check(both.quickCommands.length === 1 && both.quickCommands[0].id === 'qc-1' && !('snippets' in both), 'with quickCommands present, leftover snippets never migrate again (no duplicates)')
  const none = parseConfig(v11())
  check(none && none.quickCommands === undefined && !('snippets' in none), 'a config without snippets loads with no quickCommands key')
  const emptySnips = parseConfig(v11({ snippets: [] }))
  check(Array.isArray(emptySnips.quickCommands) && emptySnips.quickCommands.length === 0, 'an empty snippets array migrates to an empty list')

  // Lenient snippet migration: nothing with text is lost.
  const odd = parseConfig(v11({ snippets: [{ id: 'snip-1', name: '', text: '\n  primera linea\nsegunda' }, { id: 'snip-2', name: 'x'.repeat(80), text: 'largo' }, { id: 'snip-3', name: 'Vacio', text: '' }, 'basura', { name: 'sin id', text: 'x' }, { id: 'snip-4', name: 'Ok', text: 't'.repeat(20000) }] }))
  check(odd && odd.quickCommands.map(c => c.id).join() === 'snip-1,snip-2,snip-4', 'malformed snippets are dropped one by one, the rest migrate')
  check(odd.quickCommands[0].name === 'primera linea' && odd.quickCommands[1].name.length === 60 && odd.quickCommands[2].text.length === 16384, 'empty label falls back to the first line, long label and text are clipped')
  const legacyBad = parseConfig(v11({ snippets: 'not an array' }))
  check(legacyBad && legacyBad.quickCommands === undefined, 'a non-array snippets value never rejects the config')

  // Item-by-item parsing of quickCommands.
  warnings.length = 0
  const mixed = parseConfig(v11({ quickCommands: [qc(1), qc(2), { id: 'qc-bad', name: 'Roto', text: 'x', action: 'explode', enter: false }, qc(3), qc(4), qc(5)] }))
  check(mixed && mixed.quickCommands.length === 5 && mixed.quickCommands.map(c => c.id).join() === 'qc-1,qc-2,qc-3,qc-4,qc-5', 'one corrupt command among 5 valid keeps the 5 valid')
  check(warnings.some(w => /dropped 1 invalid quick command/.test(w)), 'dropped commands are logged in main')
  const many = parseConfig(v11({ quickCommands: Array.from({ length: 120 }, (_, i) => qc(i)) }))
  check(many.quickCommands.length === 100 && many.quickCommands[0].id === 'qc-0' && many.quickCommands[99].id === 'qc-99', '120 commands load as the first 100')
  const rules = parseConfig(v11({ quickCommands: [
    qc(1, { name: 'x'.repeat(61) }), qc(2, { name: 'x'.repeat(60) }), qc(3, { name: '   ' }), qc(4, { text: '' }), qc(5, { text: 'x'.repeat(16385) }),
    qc(6, { action: 'agent' }), qc(7, { action: 'agent', presetId: 'preset-claude', enter: false }), qc(2), qc(8, { workspaceId: 'w2', extra: 'drop me' }),
    qc(9, { workspaceId: 5 }), qc(10, { enter: 'yes' }), qc(11, { id: 'x'.repeat(129) }), null, 42,
  ] }))
  const ids = rules.quickCommands.map(c => c.id)
  check(ids.join() === 'qc-2,qc-7,qc-8', 'label 61, blank label, empty or oversized text, agent without preset, duplicate id, bad scope or enter are dropped')
  check(rules.quickCommands[1].enter === true && rules.quickCommands[1].presetId === 'preset-claude', 'an agent command always submits with Enter')
  check(rules.quickCommands[2].workspaceId === 'w2' && !('extra' in rules.quickCommands[2]), 'scope kept, unknown keys stripped')
  const junkArray = parseConfig(v11({ quickCommands: 'nope', snippets: [{ id: 's', name: 'S', text: 't' }] }))
  check(junkArray && junkArray.quickCommands.length === 1 && junkArray.quickCommands[0].id === 's', 'a non-array quickCommands never rejects the config')

  // Workspace note and task state (E8-FR-10).
  const ws = parseConfig(v11({ workspaces: [
    { ...v11().workspaces[0], note: 'revisar login', taskState: 'review' },
    { ...v11().workspaces[1], note: 'n'.repeat(200), taskState: 'blocked' },
    { id: 'w3', name: 'Tres', cwd: '', panes: [], note: 7 },
  ] }))
  check(ws.workspaces[0].note === 'revisar login' && ws.workspaces[0].taskState === 'review', 'note and taskState are kept')
  check(ws.workspaces[1].note.length === 140 && ws.workspaces[1].taskState === undefined && ws.workspaces[2].note === undefined, 'a long note is clipped to 140, junk note and state are dropped without rejecting the config')

  // Schema 12 settings defaults and tolerance.
  const st = a.settings
  check(st.updateDismissedVersion === '' && st.explorerMenu === false && st.persistScrollback === true && st.persistScrollbackLines === 2000 && st.gitChip === true && st.terminalSnapshotMode === 'auto', 'v11 gains the schema 12 settings defaults')
  check(JSON.stringify(st.automation) === JSON.stringify({ defaultAgentPresetId: '', composerCreateAnother: false }), 'automation defaults')
  check(st.agents.resumeModalTimeoutSec === 60 && st.agents.resumeNudge === false && st.agents.resumeNudgeText === '' && st.agents.sidebarSort === 'manual', 'agents v12 defaults')
  check(st.notifications.ntfy.server === 'https://ntfy.sh' && st.notifications.onlyWhenAway === false, 'notification v12 defaults')
  const tol = parseConfig(v11({ settings: { ...clone(baseSettings), persistScrollbackLines: 99999, terminalSnapshotMode: 'x', gitChip: 'on', explorerMenu: 1, updateDismissedVersion: 'v'.repeat(100), agents: { resumeModalTimeoutSec: 9999, sidebarSort: 'random', resumeNudge: true, resumeNudgeText: 'Segui' }, automation: { defaultAgentPresetId: 'preset-claude', composerCreateAnother: 'yes' } } }))
  check(tol && tol.settings.persistScrollbackLines === 5000 && tol.settings.terminalSnapshotMode === 'auto' && tol.settings.gitChip === true && tol.settings.explorerMenu === false && tol.settings.updateDismissedVersion === '', 'junk v12 values normalize without rejecting the config (99999 lines -> 5000)')
  check(tol.settings.agents.resumeModalTimeoutSec === 60 && tol.settings.agents.sidebarSort === 'manual' && tol.settings.agents.resumeNudge === true && tol.settings.agents.resumeNudgeText === 'Segui', 'agents v12 values kept or defaulted field by field')
  check(tol.settings.automation.defaultAgentPresetId === 'preset-claude' && tol.settings.automation.composerCreateAnother === false, 'automation values kept or defaulted field by field')
  const junkObj = parseConfig(v11({ settings: { ...clone(baseSettings), notifications: { ntfy: 'x' }, automation: 7 } }))
  check(junkObj && junkObj.settings.notifications.ntfy.server === 'https://ntfy.sh' && junkObj.settings.notifications.ntfy.enabled === false && junkObj.settings.automation.composerCreateAnother === false, 'a non-object ntfy or automation falls back to defaults without rejecting the config')
  const nullNtfy = parseConfig(v11({ settings: { ...clone(baseSettings), notifications: { ntfy: null } } }))
  check(nullNtfy && nullNtfy.settings.notifications.ntfy.topic === '' && nullNtfy.settings.notifications.ntfy !== junkObj.settings.notifications.ntfy, 'a null ntfy defaults to a fresh object (no shared fallback instance)')
  const low = parseConfig(v11({ settings: { ...clone(baseSettings), persistScrollbackLines: 10, terminalSnapshotMode: 'lazy', agents: { resumeModalTimeoutSec: 0, sidebarSort: 'smart' } } }))
  check(low.settings.persistScrollbackLines === 200 && low.settings.terminalSnapshotMode === 'lazy' && low.settings.agents.resumeModalTimeoutSec === 0 && low.settings.agents.sidebarSort === 'smart', 'lower bound clamps to 200, valid modes and 0 (never) are kept')

  // ConfigStore upgrade: the renderer load rewrites a v11 file without snippets.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-automation-test-'))
  try {
    const app = { getPath: () => dir, isPackaged: false }
    const { ConfigStore } = load('src/main/store/ConfigStore.ts', { require: id => (id === 'electron' ? { app } : require(id)), process: { ...process, env: {}, argv: ['electron'] } })
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify(raw))
    const store = new ConfigStore()
    check(store.load().quickCommands.length === 3 && JSON.parse(fs.readFileSync(file, 'utf8')).snippets.length === 3, 'a plain load migrates in memory and leaves the file untouched')
    store.load({ upgrade: true })
    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    check(written.version === 12 && !('snippets' in written) && written.quickCommands.map(c => c.id).join() === 'snip-a,snip-b,snip-c', 'the upgrade write stores quickCommands and drops snippets')
    check(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).snippets.length === 3, 'the pre-upgrade file with snippets stays in .bak')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function helperChecks() {
  const list = [qc(1), qc(2, { workspaceId: 'w2' }), qc(3), qc(4, { workspaceId: 'w1' }), qc(5, { workspaceId: 'w2' })]
  check(QC.orderQuickCommands(list, 'w2').map(c => c.id).join() === 'qc-2,qc-5,qc-1,qc-3', 'order: this workspace first, then globals, other workspaces left out')
  check(QC.orderQuickCommands(list, null).map(c => c.id).join() === 'qc-1,qc-3', 'without a workspace only globals')
  const n = QC.numbered(Array.from({ length: 12 }, (_, i) => qc(i)))
  check(n[0].digit === 1 && n[8].digit === 9 && n[9].digit === null && n.length === 12, 'only the first 9 get a digit')
  const c = qc(1, { name: 'Corre los tests' })
  check(QC.matchesFilter(c, '') && QC.matchesFilter(c, 'crt') && QC.matchesFilter(c, 'TESTS') && !QC.matchesFilter(c, 'zz') && !QC.matchesFilter(c, 'tsetc'), 'filter is a case-insensitive subsequence over the label')
  const idMap = new Map([['w1', 'ws-new1'], ['w2', 'ws-new2']])
  const remapped = QC.remapScopes(list, idMap)
  check(remapped[1].workspaceId === 'ws-new2' && remapped[3].workspaceId === 'ws-new1' && remapped[0] === list[0] && list[1].workspaceId === 'w2', 'remapScopes re-points scoped commands immutably, globals untouched')
  check(QC.remapScopes([qc(9, { workspaceId: 'gone' })], idMap)[0].workspaceId === 'gone', 'an unknown scope stays (shown as missing workspace)')
  const existing = Array.from({ length: 98 }, (_, i) => qc(`e${i}`))
  const merged = QC.mergeQuickCommands(existing, [qc('e0'), qc('n1', { workspaceId: 'w1' }), qc('n2'), qc('n3'), qc('n4')], idMap)
  check(merged.list.length === 100 && merged.imported === 2 && merged.total === 4, 'merge skips known ids and stops at 100 (imported 2 of 4)')
  check(merged.list[98].id === 'qc-n1' && merged.list[98].workspaceId === 'ws-new1', 'merged scoped commands point at the imported workspace')
  const full = QC.mergeQuickCommands(merged.list, [qc('zz')], idMap)
  check(full.list === merged.list && full.imported === 0 && full.total === 1, 'nothing is added once the list is full')
  check(JSON.stringify(QC.legacySnippets([qc(1), qc(2, { workspaceId: 'w1' }), qc(3, { action: 'agent', presetId: 'p' })])) === JSON.stringify([{ id: 'qc-1', name: 'Cmd 1', text: 'echo 1' }]), 'legacy phone snippets: global send commands only')
  const m = QC.migrateQuickCommandsConfig({ version: 11, snippets: [{ id: 's', name: 'S', text: 't' }] })
  check(m.migrated && m.config.quickCommands.length === 1 && !('snippets' in m.config) && !QC.migrateQuickCommandsConfig(m.config).migrated, 'migrateQuickCommandsConfig converts once and reports it')
}

function storeChecks() {
  const saves = [], timers = new Map()
  let seq = 0
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  const r = loadRenderer(`export { startPersistence } from './persist'; export { useAppStore } from './store'`, {
    window: { snApi: { config: { save: cfg => saves.push(clone(cfg)) }, pty: {} } },
    document: { hasFocus: () => false },
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
  })
  const S = r.useAppStore
  // hydrate also migrates (a config that skipped main's parse).
  S.getState().hydrate({ ...v11(), settings: { ...S.getState().settings }, snippets: [{ id: 'snip-a', name: 'A', text: 'a' }] })
  check(S.getState().quickCommands.length === 1 && S.getState().quickCommands[0].action === 'send', 'hydrate migrates leftover snippets')
  const stop = r.startPersistence()
  check(S.getState().saveQuickCommand(qc(1, { workspaceId: 'w2' })) === true && S.getState().saveQuickCommand(qc(2)) === true, 'saveQuickCommand adds valid commands')
  check(S.getState().saveQuickCommand(qc(3, { name: '' })) === false && S.getState().saveQuickCommand(qc(4, { action: 'agent' })) === false && S.getState().quickCommands.length === 3, 'invalid commands are rejected')
  check(S.getState().newQuickCommandId().startsWith('qc-'), 'new ids use the qc- prefix')
  flush()
  const last = saves.at(-1)
  check(last && last.version === 12 && last.quickCommands.length === 3 && !('snippets' in last), 'the persisted blob writes quickCommands and never snippets')
  S.getState().moveQuickCommand('qc-2', -1)
  check(S.getState().quickCommands.map(c => c.id).join() === 'snip-a,qc-2,qc-1', 'moveQuickCommand moves one slot')
  const before = S.getState().quickCommands
  S.getState().moveQuickCommand('snip-a', -1)
  check(S.getState().quickCommands === before, 'moving past the edge is a no-op')
  S.getState().saveQuickCommand(qc(1, { workspaceId: 'w2', name: 'Editado' }))
  check(S.getState().quickCommands.find(c => c.id === 'qc-1').name === 'Editado' && S.getState().quickCommands.length === 3, 'saving an existing id replaces it in place')
  S.getState().deleteQuickCommand('qc-2')
  check(S.getState().quickCommands.map(c => c.id).join() === 'snip-a,qc-1', 'deleteQuickCommand removes by id')

  // Delete a workspace -> its scoped commands go too.
  S.getState().deleteWorkspace('w2')
  check(S.getState().quickCommands.map(c => c.id).join() === 'snip-a', 'deleting a workspace deletes its scoped commands')

  // The 101st cannot be created; an existing one can still be edited at 100.
  for (let i = 0; i < 99; i++) S.getState().saveQuickCommand(qc(`f${i}`))
  check(S.getState().quickCommands.length === 100 && S.getState().saveQuickCommand(qc('extra')) === false && S.getState().quickCommands.length === 100, 'the 101st command cannot be created')
  check(S.getState().saveQuickCommand(qc('f0', { name: 'Cambiado' })) === true, 'editing works at the limit')

  // Merge import: scopes follow the re-id'd workspaces, cap reported.
  for (let i = 0; i < 5; i++) S.getState().deleteQuickCommand(`qc-f${i}`)
  const incoming = parseConfig(v11({ workspaces: [{ id: 'w9', name: 'Imp', cwd: '', panes: [{ id: 'px', type: 'shell', title: 'S', color: '#fff', icon: 'terminal' }] }], quickCommands: [qc('i1', { workspaceId: 'w9' }), qc('i2'), qc('i3'), qc('i4'), qc('i5'), qc('i6'), qc('i7'), qc('x', { id: 'snip-a' })] }))
  const res = S.getState().mergeConfig(incoming)
  const imported = S.getState().workspaces.find(w => w.name === 'Imp')
  check(imported && imported.id !== 'w9', 'merged workspace gets a fresh id')
  const scoped = S.getState().quickCommands.find(c => c.id === 'qc-i1')
  check(scoped && scoped.workspaceId === imported.id, 'merged scoped command points at the imported workspace (no missing-workspace badge)')
  check(S.getState().quickCommands.length === 100 && res.quickCommands.imported === 5 && res.quickCommands.total === 7, 'merge imports up to the limit and reports N of M')
  const legacyMerge = S.getState().mergeConfig({ ...v11(), workspaces: [], settings: { ...S.getState().settings }, snippets: [{ id: 'snip-z', name: 'Z', text: 'z' }] })
  check(legacyMerge.quickCommands.total === 1 && legacyMerge.quickCommands.imported === 0, 'merging an old export with snippets migrates them (cap still applies)')

  // Replace import migrates an old export too.
  S.getState().importConfig({ ...v11(), settings: { ...S.getState().settings }, snippets: [{ id: 'snip-r', name: 'R', text: 'r' }] })
  check(S.getState().quickCommands.map(c => c.id).join() === 'snip-r', 'replace import migrates snippets')
  stop()
}

schemaChecks()
helperChecks()
storeChecks()
console.log(`PASS: ${checks} automation checks (schema 12, snippets migration, item parsing, 100 cap, merge remap, store actions)`)
