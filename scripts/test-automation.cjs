// Automation suite (E8). R22-01: schema 12, the snippets -> quickCommands
// migration, item-by-item parsing, the 100 cap, merge remap and the store's
// Quick Commands actions. R22-12: initial prompt rules (argv/gate/fallback),
// submit (paced 64 KB + late CR, split DECSET 2004, multiline_unsafe), the
// gate, stateOf and running Quick Commands (desktop and the strict phone
// variant). Same esbuild + vm harness as test-status.cjs.
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
  const m = QC.migrateQuickCommandsConfig({ version: 11, snippets: [{ id: 's', name: 'S', text: 't' }] })
  check(m.migrated && m.config.quickCommands.length === 1 && !('snippets' in m.config) && !QC.migrateQuickCommandsConfig(m.config).migrated, 'migrateQuickCommandsConfig converts once and reports it')
}

function storeChecks() {
  const saves = [], timers = new Map()
  let seq = 0
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  const r = loadRenderer(`export { startPersistence } from './persist'; export { useAppStore } from './store'`, {
    window: { snApi: { config: { save: cfg => saves.push(clone(cfg)) }, pty: { killPanes: async () => 0 } } },
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

// --- R22-12: initial prompt rules, submit, the gate, stateOf, Quick Commands ----

const IP = load('src/shared/initialPrompt.ts')
const SK = load('src/shared/shellKind.ts')
const ARGV = load('src/shared/agent-argv.ts')

function promptRuleChecks() {
  const k = (p, plat = 'win32') => SK.shellKind(p, plat)
  check(k('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') === 'powershell' && k('pwsh') === 'powershell' && k('C:\\Tools\\PWSH.EXE') === 'powershell', 'powershell.exe and pwsh are powershell')
  check(k('/bin/bash', 'linux') === 'posix' && k('/usr/bin/zsh', 'darwin') === 'posix' && k('/bin/sh', 'linux') === 'posix' && k('/usr/bin/fish', 'linux') === 'posix' && k('C:\\Program Files\\Git\\bin\\bash.exe') === 'posix', 'bash, zsh, sh and fish are posix (Git Bash too)')
  check(k('C:\\Windows\\System32\\cmd.exe') === 'cmd' && k('CMD.EXE') === 'cmd' && k('cmd', 'linux') === 'unknown', 'cmd.exe is cmd on Windows only')
  check(k('nu.exe') === 'unknown' && k('wsl.exe') === 'unknown' && k('') === 'unknown' && k(undefined) === 'unknown' && k('"C:\\x\\pwsh.exe"') === 'powershell', 'nu, wsl and an empty shell are unknown; quotes are ignored')
  check(SK.promptShellKindOf('other') === 'unknown' && SK.promptShellKindOf('cmd') === 'cmd', "PtyManager's 'other' maps to unknown")

  const s = IP.sanitizeInitialPrompt
  check(s('explica "x" y $HOME') === "explica 'x' y $HOME", 'double quotes become single quotes, the rest is kept')
  check(s('linea uno\r\nlinea dos\nfin') === 'linea uno linea dos fin', 'line breaks become spaces')
  check(s('-x') === ' -x' && s('review') === ' review' && s('-p hola') === ' -p hola', 'a leading dash or a single word gets a leading space')
  check(s('C:\\dir\\') === ' C:\\dir' && s('ver C:\\a b\\\\') === 'ver C:\\a b', 'trailing backslashes are dropped')
  check(s('a\x1b[31mb\x07c d') === 'a[31mbc d', 'control characters are removed')
  check(IP.initialPromptRef('powershell') === ' $env:SNAOS_INITIAL_PROMPT' && IP.initialPromptRef('posix') === ' "$SNAOS_INITIAL_PROMPT"' && IP.initialPromptRef('cmd') === ' "%SNAOS_INITIAL_PROMPT%"' && IP.initialPromptRef('unknown') === null, 'variable reference per shell, none for unknown')

  const base = { text: 'revisa el diff', shell: 'powershell', platform: 'win32', hasSetup: false, launchKind: 'claude' }
  const fb = (o) => IP.initialPromptFallback({ ...base, ...o })
  check(!fb({}) && fb({ text: 'usa %PATH%' }) && fb({ text: 'subilo al 100%' }) && !fb({ text: 'subilo al 100%', platform: 'linux', shell: 'posix' }), '`%` falls back on win32 only')
  check(!fb({ text: 'x '.repeat(1000).trim() + 'y' }) && fb({ text: 'x'.repeat(2001) + ' y' }), 'more than 2000 sanitized characters fall back')
  check(fb({ hasSetup: true }) && fb({ shell: 'unknown' }) && fb({ launchKind: 'other' }) && fb({ text: '   ' }), 'SSH, an unknown shell, a non-agent command or an empty text fall back')

  const d = (o) => IP.chooseDelivery({ ...base, ...o })
  const table = [
    [{}, 'argv', 'one line in PowerShell'],
    [{ text: 'dice "hola" & chau' }, 'argv', 'quotes and & (sanitized, inside the variable)'],
    [{ text: 'update' }, 'argv', 'a single word (gets a leading space)'],
    [{ text: '-h ayuda' }, 'argv', 'a leading dash (gets a leading space)'],
    [{ text: 'linea\notra' }, 'gate', 'a multi-line prompt (keeps its breaks)'],
    [{ launchKind: 'other' }, 'gate', 'a pane.command override or a resume'],
    [{ hasSetup: true }, 'gate', 'a Connection Profile'],
    [{ shell: 'unknown' }, 'gate', 'an unknown shell'],
    [{ text: '50% listo' }, 'gate', 'a % on Windows'],
    [{ shell: 'cmd' }, 'argv', 'cmd.exe'],
    [{ shell: 'posix', platform: 'linux', launchKind: 'codex' }, 'argv', 'codex in bash'],
  ]
  for (const [o, want, label] of table) check(d(o) === want, `delivery table: ${label} -> ${want}`)

  const preset = { type: 'claude', command: 'claude', args: [] }
  check(ARGV.buildAgentArgv({ preset, promptShell: 'powershell' }) === 'claude $env:SNAOS_INITIAL_PROMPT', "a 'revisa el diff' agent in PowerShell runs `claude $env:SNAOS_INITIAL_PROMPT` (D1: the text lives in the variable)")
  check(ARGV.buildAgentArgv({ preset: { ...preset, args: ['--model', 'opus'] }, promptShell: 'posix' }) === 'claude --model opus "$SNAOS_INITIAL_PROMPT"' && ARGV.buildAgentArgv({ preset, promptShell: 'cmd' }) === 'claude "%SNAOS_INITIAL_PROMPT%"', 'posix and cmd references go after the flags')
  check(ARGV.buildAgentArgv({ preset, promptShell: 'unknown' }) === 'claude' && ARGV.buildAgentArgv({ preset, promptShell: 'powershell', resume: { provider: 'claude', sessionId: '0f9d6a3c-1111-2222-3333-444455556666' } }) === 'claude --resume 0f9d6a3c-1111-2222-3333-444455556666', 'no reference for an unknown shell or a resume')

  const p = IP.prepareSubmit
  check(JSON.stringify(p('ls -la', false)) === JSON.stringify({ ok: true, data: 'ls -la' }), 'one line is written as is')
  check(JSON.stringify(p('a\nb', false)) === JSON.stringify({ ok: false, error: 'multiline_unsafe' }) && JSON.stringify(p('a\r\nb\n', false)) === JSON.stringify({ ok: false, error: 'multiline_unsafe' }), 'inner line breaks without bracketed paste are refused')
  check(p('a\r\nb\nc', true).data === '\x1b[200~a\rb\rc\x1b[201~', 'with bracketed paste the text is wrapped and its breaks normalized to CR')
  check(p('ls\n', false).data === 'ls\r' && p('a\nb\n\n', true).data === '\x1b[200~a\rb\x1b[201~\r\r', 'trailing breaks are typed Enters after the paste')
  check(p('x\x1b[201~y\nz', true).data === '\x1b[200~xy\rz\x1b[201~', 'a paste end marker inside the text is removed')
  check(p('hola', true, true).data === '\x1b[200~hola\x1b[201~' && p('hola', false, true).data === 'hola', 'forcePaste wraps a single line only with bracketed paste on')

  const QC2 = load('src/shared/quickCommands.ts')
  const pk = QC2.popoverKey
  check(JSON.stringify(pk('3', '')) === JSON.stringify({ kind: 'run', index: 2 }), 'empty filter: 3 runs the third item')
  check(pk('1', 'comp').kind === 'type' && pk('c', '').kind === 'type' && pk('0', '').kind === 'type', 'with text in the filter a digit filters; letters and 0 always filter')
  check(pk('3', '', { ctrl: true }).kind === 'type' && pk('Escape', 'x').kind === 'close' && pk('Enter', '').kind === 'runSelected' && pk('ArrowDown', '').delta === 1 && pk('ArrowUp', 'a').delta === -1, 'modifiers, Esc, Enter and arrows')
}

// A controllable clock for the PtyManager timers (settle, pacing, submit, gate).
function fakeClock() {
  let now = 1_000_000
  let seq = 0
  const queue = new Map()
  const setT = (fn, ms = 0) => { const id = ++seq; queue.set(id, { at: now + Math.max(0, ms || 0), fn }); return id }
  const clearT = (id) => { queue.delete(id) }
  const micro = () => new Promise((r) => setImmediate(r))
  async function advance(ms) {
    const end = now + ms
    for (;;) {
      await micro()
      let next = null
      for (const [id, t] of queue) if (t.at <= end && (!next || t.at < next.t.at || (t.at === next.t.at && id < next.id))) next = { id, t }
      if (!next) break
      queue.delete(next.id)
      now = next.t.at
      next.t.fn()
    }
    now = end
    await micro()
  }
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now) }
    static now() { return now }
  }
  return { now: () => now, advance, setT, clearT, FakeDate }
}

function ptyHarness(agentState) {
  const clock = fakeClock()
  const procs = [], sent = [], spawnCalls = []
  const impl = (shell, args, opts) => {
    spawnCalls.push({ shell, args, opts })
    const dataCbs = [], exitCbs = []
    const proc = {
      cols: opts.cols, rows: opts.rows, writes: [], killed: false,
      onData: (cb) => dataCbs.push(cb), onExit: (cb) => exitCbs.push(cb),
      write: (d) => proc.writes.push({ d, at: clock.now() }), resize() {}, pause() {}, resume() {},
      kill: () => { proc.killed = true; proc.exit(1) },
      emit: (d) => dataCbs.forEach((cb) => cb(d)),
      exit: (code) => exitCbs.forEach((cb) => cb({ exitCode: code })),
      text: () => proc.writes.map((w) => w.d).join(''),
    }
    procs.push(proc)
    return proc
  }
  const code = buildSync({ entryPoints: [path.join(root, 'src/main/pty/PtyManager.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, console: { ...console, warn() {} }, process, Buffer, URL,
    require: (id) => (id === 'node-pty' ? { spawn: impl } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id)),
    setTimeout: clock.setT, clearTimeout: clock.clearT, setInterval: () => 0, clearInterval() {}, Date: clock.FakeDate,
  })
  const pm = new mod.exports.PtyManager(() => ({ isDestroyed: () => false, send: (ch, p) => sent.push({ ch, p }) }), () => ({}), agentState)
  pm.setEngine({ snapshotMode: 'off' })
  const results = () => sent.filter((e) => e.ch === 'pty:promptResult').map((e) => e.p.result)
  return { pm, procs, sent, spawnCalls, clock, results }
}

// Real files so resolveShell accepts them; the name decides the shell family.
const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-qc-shells-'))
const win = process.platform === 'win32'
const fakeShell = (name) => { const f = path.join(shellDir, win ? `${name}.exe` : name); fs.writeFileSync(f, ''); return f }
const PWSH = fakeShell('pwsh')
const BASH = fakeShell('bash')
const CMD = win ? fakeShell('cmd') : null

async function submitChecks() {
  {
    const { pm, procs, clock } = ptyHarness()
    const { ptyId } = pm.spawn({ paneId: 'p1', shell: PWSH, cols: 80, rows: 24 })
    const proc = procs[0]
    const t0 = clock.now()
    const pending = pm.submit(ptyId, 'hola mundo', true)
    check(proc.text() === 'hola mundo', 'a one-line submit writes the text right away')
    await clock.advance(149)
    check(!proc.text().includes('\r'), 'no Enter before 150 ms')
    await clock.advance(1)
    const res = await pending
    check(res.ok && proc.writes.at(-1).d === '\r' && proc.writes.at(-1).at - t0 === 150, 'the CR follows 150 ms after the text')
    check(pm.lastSubmitAt('p1') === clock.now(), 'a submit with Enter records lastSubmitAt')
    check(JSON.stringify(await pm.submit('nope', 'x', true)) === JSON.stringify({ ok: false, error: 'not_running' }), 'an unknown pty is not_running')
    const noEnter = await pm.submit(ptyId, 'sin enter', false)
    check(noEnter.ok && !proc.text().endsWith('sin enter\r'), 'without enter nothing else is written')
    pm.killAll()
  }
  {
    const { pm, procs, clock } = ptyHarness()
    const { ptyId } = pm.spawn({ paneId: 'big', shell: PWSH, cols: 80, rows: 24 })
    const proc = procs[0]
    const text = 'z'.repeat(64 * 1024)
    const pending = pm.submit(ptyId, text, true)
    let done = false
    void pending.then(() => { done = true })
    await clock.advance(2000)
    check(done, 'the 64 KB submit resolves')
    const chunks = proc.writes.filter((w) => w.d !== '\r')
    const last = chunks.at(-1).at
    const cr = proc.writes.find((w) => w.d === '\r')
    check(chunks.length === 16 && chunks.every((w) => w.d.length <= 4096) && chunks.map((w) => w.d).join('') === text, '64 KB goes out in 16 paced 4 KB chunks, intact')
    check(cr && cr.at - last >= 150 && proc.writes.at(-1).d === '\r', `the late CR lands >= 150 ms after the last chunk (${cr && cr.at - last} ms)`)
    pm.killAll()
  }
  {
    const { pm, procs, clock } = ptyHarness()
    const { ptyId } = pm.spawn({ paneId: 'bp', shell: PWSH, cols: 80, rows: 24 })
    const proc = procs[0]
    const refused = await pm.submit(ptyId, 'linea 1\nlinea 2', true)
    check(!refused.ok && refused.error === 'multiline_unsafe' && proc.writes.length === 0, 'multi-line without DECSET 2004 (cmd.exe) is refused and writes nothing')
    proc.emit('prompt \x1b[?20')
    proc.emit('04h> ')
    check(pm.bracketedPasteOf('bp') === true, 'a DECSET 2004 split across two chunks still registers')
    const wrapped = pm.submit(ptyId, 'linea 1\nlinea 2', true)
    await clock.advance(200)
    check((await wrapped).ok && proc.text() === '\x1b[200~linea 1\rlinea 2\x1b[201~\r', 'multi-line with 2004 arrives wrapped in bracketed paste, then Enter')
    proc.emit('\x1b[?2004l')
    check(!(await pm.submit(ptyId, 'a\nb', false)).ok, 'DECRST 2004 makes multi-line unsafe again')
    const viaPane = pm.submitToPane('stale-id', 'bp', 'por pane', false)
    check((await viaPane).ok && proc.text().endsWith('por pane'), 'submitToPane resolves the pane when the pty id is stale (phone after a reload)')
    const dying = pm.submit(ptyId, 'x'.repeat(10000), true)
    proc.exit(0)
    await clock.advance(500)
    check(JSON.stringify(await dying) === JSON.stringify({ ok: false, error: 'not_running' }), 'a pty that dies before its Enter answers not_running')
  }
}

async function gateChecks() {
  const prompt = (text, extra = {}) => ({ text, enter: true, ...extra })
  {
    const { pm, procs, spawnCalls, clock, results } = ptyHarness()
    pm.spawn({ paneId: 'a1', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('revisa el diff') })
    check(spawnCalls[0].opts.env.SNAOS_INITIAL_PROMPT === 'revisa el diff', 'argv: the sanitized prompt is in the pty env')
    await clock.advance(400)
    check(procs[0].text() === 'claude $env:SNAOS_INITIAL_PROMPT\r', 'argv: PowerShell types the agent with the variable reference')
    check(JSON.stringify(results()) === '["sent_argv"]' && pm.lastSubmitAt('a1') > 0, 'argv reports sent_argv and records lastSubmitAt')
    pm.spawn({ paneId: 'a2', shell: BASH, cols: 80, rows: 24, initialCommand: 'codex', launchKind: 'codex', initialPrompt: prompt('dice "hola"') })
    await clock.advance(400)
    check(procs[1].text() === 'codex "$SNAOS_INITIAL_PROMPT"\r' && spawnCalls[1].opts.env.SNAOS_INITIAL_PROMPT === "dice 'hola'", 'argv in bash quotes the variable; the text is sanitized')
    if (CMD) {
      pm.spawn({ paneId: 'a3', shell: CMD, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('update') })
      await clock.advance(400)
      check(procs[2].text() === 'claude "%SNAOS_INITIAL_PROMPT%"\r' && spawnCalls[2].opts.env.SNAOS_INITIAL_PROMPT === ' update', 'argv in cmd.exe; a single word gets its leading space')
    }
    pm.spawn({ paneId: 'a4', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', env: { SNAOS_INITIAL_PROMPT: 'leak' } })
    check(!('SNAOS_INITIAL_PROMPT' in spawnCalls.at(-1).opts.env), 'without a prompt the variable is never inherited from a preset env')
    pm.killAll()
  }
  {
    // Gate without hooks: only an approximate (title) idle, never an Enter.
    let state = null
    const { pm, procs, clock, results } = ptyHarness(() => state)
    pm.spawn({ paneId: 'g1', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude --model opus', launchKind: 'other', initialPrompt: prompt('revisa el diff') })
    await clock.advance(400)
    check(procs[0].text() === 'claude --model opus\r', 'gate: the command is typed without any reference (pane.command override)')
    state = { state: 'idle', precise: false }
    await clock.advance(19_000)
    check(procs[0].text() === 'claude --model opus\r' && results().length === 0, 'a title-only idle never sends the prompt')
    await clock.advance(1000)
    check(JSON.stringify(results()) === '["not_delivered"]' && procs[0].text() === 'claude --model opus\r', 'at 20 s without bracketed paste nothing is written: not_delivered')
    pm.spawn({ paneId: 'g2', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('arregla\nlos tests') })
    await clock.advance(400)
    procs[1].emit('\x1b[?2004h')
    await clock.advance(20_000)
    check(results().at(-1) === 'inserted_unconfirmed' && procs[1].text() === 'claude\r\x1b[200~arregla\rlos tests\x1b[201~', 'at 20 s with bracketed paste the text is inserted as a paste, without Enter')
    pm.killAll()
  }
  {
    // Gate with hooks: SessionStart (precise idle) releases it with Enter.
    const states = {}
    const { pm, procs, clock, results } = ptyHarness((id) => states[id] ?? null)
    pm.spawn({ paneId: 'h1', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('usa 50% de cpu') })
    await clock.advance(400)
    check(procs[0].text() === 'claude\r', 'a % prompt on Windows goes through the gate')
    await clock.advance(3000)
    states.h1 = { state: 'working', precise: true }
    await clock.advance(500)
    check(procs[0].text() === 'claude\r', 'a precise working state is not ready')
    states.h1 = { state: 'idle', precise: true }
    await clock.advance(100)
    check(procs[0].text() === 'claude\rusa 50% de cpu', 'precise idle (SessionStart) types the prompt')
    await clock.advance(150)
    check(procs[0].text() === 'claude\rusa 50% de cpu\r' && JSON.stringify(results()) === '["sent_gate"]', 'then Enter, once: sent_gate')
    await clock.advance(30_000)
    check(procs[0].text() === 'claude\rusa 50% de cpu\r', 'the prompt is consumed once')
    // Restart in place never resends it.
    const restarted = pm.restart({ paneId: 'h1', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('otra vez') }, 'restarted')
    await clock.advance(30_000)
    check(restarted.ptyId && procs[1].text() === 'claude\r' && results().length === 1, 'restarting the console does not send the initial prompt again')
    // A pty that exits before its agent is ready drops the prompt.
    pm.spawn({ paneId: 'h2', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('linea\notra') })
    await clock.advance(1000)
    procs[2].exit(0)
    check(results().at(-1) === 'dropped_exit', 'an exit before delivery reports dropped_exit')
    // SSH: always the gate, started after the setup sequence.
    states.h3 = { state: 'idle', precise: true }
    pm.spawn({ paneId: 'h3', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', setup: [{ send: 'ssh host', delayMs: 10 }], initialPrompt: prompt('hola remoto') })
    await clock.advance(2000)
    check(procs[3].text() === 'ssh host\rclaude\rhola remoto\r' && results().at(-1) === 'sent_gate', 'a Connection Profile uses the gate after the setup and the agent command')
    // The phone's argvOnly never types a fallback.
    pm.spawn({ paneId: 'h4', shell: PWSH, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('100% listo', { mode: 'argvOnly' }) })
    check(results().at(-1) === 'not_delivered', 'argvOnly without argv reports not_delivered at spawn')
    await clock.advance(30_000)
    check(procs[4].text() === 'claude\r', 'and types nothing but the agent')
    pm.killAll()
  }
}

function stateOfChecks() {
  const { StatusManager } = load('src/main/status/StatusManager.ts', {
    require: (id) => (id === 'electron' ? { Notification: { isSupported: () => false } } : require(id)),
    setTimeout: () => 0, clearTimeout() {},
  })
  const sm = new StatusManager(() => null, () => null)
  sm.onSpawn('pty', 'pane')
  check(sm.stateOf('pane') === null, 'stateOf is null for a pane without status')
  sm.reportTitle('pane', 'claude')
  const approx = sm.stateOf('pane')
  check(approx && approx.state === 'idle' && approx.precise === false, 'a title-only claude is idle but not precise (never releases the gate)')
  sm.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session-0001', name: 'SessionStart' })
  const ready = sm.stateOf('pane')
  check(ready.state === 'idle' && ready.precise === true, 'SessionStart makes it a precise idle (gate ready)')
  sm.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session-0001', name: 'UserPromptSubmit', prompt: 'x' })
  check(sm.stateOf('pane').state === 'working', 'a submitted prompt is working')
  sm.onExit('pty', 'pane')
  check(sm.stateOf('pane') === null, 'the pty exit clears it')
}

async function quickRunChecks() {
  const submits = [], rafs = []
  let submitResult = { ok: true }
  const snApi = {
    config: { save() {} },
    pty: { killPanes: async () => 0, submit: async (req) => { submits.push(req); return submitResult } },
    remote: { onCommand: (cb) => { snApi._cmd = cb; return () => {} }, commandResult: (res) => snApi._results.push(res), pushState: (st) => snApi._states.push(st) },
    clipboard: { writeText: (t) => snApi._clip.push(t) },
    _results: [], _clip: [], _states: [],
  }
  const r = loadRenderer(`
    export { useAppStore } from './store'
    export { initRemoteCommands } from './remoteCommands'
    export { runQuickCommand, sendTarget } from './quickCommands'
    export { registerPty } from './ptyRegistry'
    export { setFocusedPane } from './focus'
    export { useToastStore } from './toast'
    export { handlePromptResult, rememberPrompt } from './promptDelivery'
    export { resolveLaunch } from './launch'
    export { KEY_ACTIONS, resolveKeymap } from './keymap'
    export { startRemoteSnapshotSync } from './remoteSnapshot'
  `, { window: { snApi }, document: { hasFocus: () => true, querySelector: () => null }, requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length }, cancelAnimationFrame() {} })
  const S = r.useAppStore
  const preset = { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }
  S.getState().hydrate({
    ...v11(),
    workspaces: [
      { id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [{ id: 'p1', type: 'shell', title: 'Shell', color: '#fff', icon: 'terminal' }, { id: 'p2', type: 'shell', title: 'Dos', color: '#fff', icon: 'terminal' }], layout: { grid: 2, order: ['p2', 'p1'] } },
      { id: 'w2', name: 'Dos', cwd: 'C:/b', panes: [{ id: 'q1', type: 'shell', title: 'Remota', color: '#fff', icon: 'terminal' }] },
    ],
    presets: [preset],
    settings: { ...S.getState().settings, language: 'es' },
    activeWorkspaceId: 'w1',
    quickCommands: [qc('g'), qc('w1only', { workspaceId: 'w1' }), qc('w2only', { workspaceId: 'w2', text: 'npm test', enter: true }), qc('agent', { action: 'agent', presetId: 'preset-claude', text: 'revisa el diff', enter: true }), qc('ghost', { action: 'agent', presetId: 'gone', text: 'x', enter: true })],
  })
  const toasts = () => r.useToastStore.getState().items
  const keys = r.resolveKeymap(undefined)
  const accels = Object.values(keys)
  check(keys.quickCommands === 'Ctrl+Shift+Q' && r.KEY_ACTIONS.some((k) => k.id === 'quickCommands' && k.labelKey === 'keys.quickCommands'), 'quickCommands is a remappable action, Ctrl+Shift+Q by default')
  check(new Set(accels).size === accels.length, 'no default accelerator conflicts')
  const qcOf = (id) => S.getState().quickCommands.find((c) => c.id === `qc-${id}`)

  // Desktop send (E8-FR-05).
  let res = await r.runQuickCommand(qcOf('g'))
  check(!res.ok && res.error === 'no_console' && submits.length === 0 && toasts().at(-1).title === 'No hay consola activa', 'send without live consoles shows the toast and writes nothing')
  r.registerPty('p1', 'pty-p1'); r.registerPty('p2', 'pty-p2'); r.registerPty('q1', 'pty-q1')
  res = await r.runQuickCommand(qcOf('g'))
  check(res.ok && submits.at(-1).ptyId === 'pty-p2' && submits.at(-1).text === 'echo g' && submits.at(-1).enter === false, 'send without a focused console goes to the first live console in grid order')
  check(toasts().at(-1).title === 'Enviado: Cmd g', 'send feedback toast')
  r.setFocusedPane('q1', 'w2')
  await r.runQuickCommand(qcOf('g'))
  check(submits.at(-1).ptyId === 'pty-p2', 'a focused console outside the active workspace is not the target')
  r.setFocusedPane('p1', 'w1')
  await r.runQuickCommand(qcOf('g'))
  check(submits.at(-1).ptyId === 'pty-p1', 'the focused console of the active workspace is the target')
  submitResult = { ok: false, error: 'multiline_unsafe' }
  res = await r.runQuickCommand(qcOf('g'))
  check(!res.ok && toasts().at(-1).title === 'Texto multilínea: esta consola no acepta pegado seguro', 'multiline_unsafe shows its toast')
  submitResult = { ok: true }

  // Desktop agent.
  res = await r.runQuickCommand(qcOf('agent'))
  const w1 = S.getState().workspaces.find((w) => w.id === 'w1')
  const created = w1.panes.find((p) => p.id === res.paneId)
  check(res.ok && created && created.presetId === 'preset-claude' && created.type === 'claude', 'agent adds a console with the preset to the active workspace')
  check(S.getState().pendingPrompts[res.paneId].text === 'revisa el diff' && S.getState().pendingPrompts[res.paneId].enter === true, 'its prompt waits for the first spawn')
  check(S.getState().takePendingPrompt(res.paneId).text === 'revisa el diff' && S.getState().takePendingPrompt(res.paneId) === null, 'the pending prompt is consumed once (a restart finds nothing)')
  check(toasts().at(-1).title === 'Abriendo Claude Code: Cmd agent', 'agent feedback toast')
  const closed = (await r.runQuickCommand(qcOf('agent'))).paneId
  S.getState().removePane('w1', closed)
  check(!(closed in S.getState().pendingPrompts), 'closing a console before its spawn drops its pending prompt (a reopen never delivers it)')
  const before = S.getState().quickCommands.length
  res = await r.runQuickCommand(qcOf('ghost'))
  check(!res.ok && res.error === 'no_preset' && toasts().at(-1).title === 'El preset de este Quick Command ya no existe' && S.getState().settingsOpen && S.getState().quickEdit.id === 'qc-ghost' && S.getState().quickCommands.length === before, 'a deleted preset shows the toast and opens the editor on it')

  // launchKind (E8-FR-02b): only the preset's own claude/codex command.
  const wsL = { id: 'wl', name: 'L', cwd: 'C:/l', panes: [] }
  const pane = (o) => ({ id: 'x', type: 'claude', title: 'x', color: '', icon: '', presetId: 'preset-claude', ...o })
  check(r.resolveLaunch(pane({}), wsL, [preset], []).launchKind === 'claude', 'a claude preset launches as claude')
  check(r.resolveLaunch(pane({ command: 'claude --model opus' }), wsL, [preset], []).launchKind === 'other', 'a pane.command override is other (never argv)')
  check(r.resolveLaunch(pane({ presetId: undefined, type: 'shell' }), wsL, [preset], []).launchKind === 'other', 'a shell is other')

  // Phone (E8-FR-07), strict, through the real executor.
  r.initRemoteCommands()
  const ctl = async (action) => { snApi._cmd({ id: `c${snApi._results.length}`, action }); await new Promise((res2) => setImmediate(res2)); return snApi._results.at(-1) }
  const n = submits.length
  let ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', id: 'qc-w2only' })
  check(!ack.ok && ack.error === 'bad_request' && submits.length === n, 'a phone send without paneId is bad_request')
  ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', paneId: 'q1', id: 'qc-w1only' })
  check(!ack.ok && ack.error === 'not_found', 'a command of another workspace is not_found')
  ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', paneId: 'q1', id: 'qc-nope' })
  check(!ack.ok && ack.error === 'not_found', 'an unknown id is not_found')
  ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', paneId: 'p1', id: 'qc-w2only' })
  check(!ack.ok && ack.error === 'not_found', 'a pane outside the phone workspace is not_found')
  r.setFocusedPane('p1', 'w1')
  ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', paneId: 'q1', id: 'qc-w2only' })
  check(ack.ok && submits.at(-1).ptyId === 'pty-q1' && submits.at(-1).paneId === 'q1' && submits.at(-1).text === 'npm test' && submits.at(-1).enter === true, "send writes to the phone's console with the desktop's text, even with the desktop focused elsewhere")
  ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', paneId: 'q1', id: 'qc-g' })
  check(ack.ok && submits.at(-1).ptyId === 'pty-q1', 'a global command runs in any workspace')
  submitResult = { ok: false, error: 'not_running' }
  ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', paneId: 'q1', id: 'qc-g' })
  check(!ack.ok && ack.error === 'not_running', 'a console without a live pty answers not_running')
  submitResult = { ok: true }
  const activeBefore = S.getState().activeWorkspaceId
  ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', id: 'qc-agent' })
  const w2 = S.getState().workspaces.find((w) => w.id === 'w2')
  check(ack.ok && ack.paneId && w2.panes.some((p) => p.id === ack.paneId), 'agent creates the console in the phone workspace and acks its id')
  check(S.getState().activeWorkspaceId === activeBefore, 'the desktop keeps its active workspace')
  const mount = S.getState().mountedWorkspaces.w2
  check(Array.isArray(mount) && mount.length === 1 && mount[0] === ack.paneId, 'only the new console mounts (partial mount)')
  check(S.getState().pendingPrompts[ack.paneId].source === 'quick', 'its prompt waits for the spawn')
  ack = await ctl({ kind: 'runQuickCommand', workspaceId: 'w2', id: 'qc-ghost' })
  check(!ack.ok && ack.error === 'no_preset', 'a deleted preset answers no_preset')

  // Snapshot and ctl schema (E8-FR-07).
  const stopSync = r.startRemoteSnapshotSync()
  const snap = snApi._states.at(-1)
  check(Array.isArray(snap.quickCommands) && snap.quickCommands.length === S.getState().quickCommands.length && !('snippets' in snap), 'the snapshot carries quickCommands (QuickCommand[]) and no snippets')
  check(snap.quickCommands.some((c) => c.workspaceId === 'w2' && c.action === 'send') && snap.quickCommands.some((c) => c.action === 'agent'), 'scoped and agent commands travel too')
  stopSync()
  const { parseRemoteClientMsg } = load('src/shared/remote-protocol-schemas.ts')
  const frame = (action) => parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'ctl', id: 'c1', action }))
  check(frame({ kind: 'runQuickCommand', workspaceId: 'w1', paneId: 'p1', id: 'qc-1' }) && frame({ kind: 'runQuickCommand', workspaceId: 'w1', id: 'qc-1' }), 'the ctl schema accepts runQuickCommand with and without paneId')
  check(!frame({ kind: 'runQuickCommand', workspaceId: 'w1', id: 'x'.repeat(129) }) && !frame({ kind: 'runQuickCommand', id: 'qc-1' }) && !frame({ kind: 'runQuickCommand', workspaceId: 'w1', id: 'qc', text: 'rm -rf' }).action.text, 'it rejects a long id or a missing workspace and never carries text')

  // Prompt outcome toasts (E8-FR-02b).
  r.rememberPrompt('p1', 'texto largo')
  r.handlePromptResult({ paneId: 'p1', result: 'not_delivered' })
  const t1 = toasts().at(-1)
  check(t1.kind === 'error' && t1.title === 'No se pudo entregar el prompt' && t1.actions[0].label === 'Copiar', 'not_delivered shows an error with Copy')
  t1.actions[0].run()
  check(snApi._clip.at(-1) === 'texto largo', 'Copy puts the prompt on the clipboard')
  r.handlePromptResult({ paneId: 'p2', result: 'inserted_unconfirmed' })
  check(toasts().at(-1).title === 'Prompt insertado sin Enter: no se confirmó que el agente estuviera listo', 'inserted_unconfirmed shows its warning')
  const count = toasts().length
  r.handlePromptResult({ paneId: 'p3', result: 'sent_argv' })
  check(toasts().length === count, 'a delivered prompt shows nothing')
}

async function main() {
  schemaChecks()
  helperChecks()
  storeChecks()
  promptRuleChecks()
  await submitChecks()
  await gateChecks()
  stateOfChecks()
  await quickRunChecks()
  fs.rmSync(shellDir, { recursive: true, force: true })
  console.log(`PASS: ${checks} automation checks (schema 12, snippets migration, item parsing, 100 cap, merge remap, store actions, prompt rules, submit, gate, stateOf, Quick Commands)`)
}
main().catch((err) => {
  fs.rmSync(shellDir, { recursive: true, force: true })
  console.error(err)
  process.exit(1)
})
