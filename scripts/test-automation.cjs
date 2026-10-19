// Automation suite (E8). R22-01: schema 12, the snippets -> quickCommands
// migration, item-by-item parsing, the 100 cap, merge remap and the store's
// Quick Commands actions. R22-12: initial prompt rules (argv/gate/fallback),
// submit (paced 64 KB + late CR, split DECSET 2004, multiline_unsafe), the
// gate, stateOf and running Quick Commands (desktop and the strict phone
// variant). R22-13: composer model, note/taskState store actions, first
// prompt to the first agent console, fs:dirExists. R30-01: schema 13 (v12 ->
// v13 keeps everything, new defaults, PaneSchedule automation fields,
// repoConfig, junk tolerance). R30-12: .snagentsos.json (test-automation-repo.cjs).
// R31-00: schema 14 (v13 -> v14 keeps everything, terminalShellIntegration)
// and the zod of the v3.1 ctl scheduleRun / scheduleToggle.
// Same esbuild + vm harness as test-status.cjs.
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
  check(CONFIG_VERSION === 15, 'CONFIG_VERSION is 15')

  // E8-FR-01: 3 snippets -> 3 global send commands, same order and ids, no Enter.
  const snippets = [{ id: 'snip-a', name: 'Continua', text: 'continua' }, { id: 'snip-b', name: 'Compact', text: '/compact' }, { id: 'snip-c', name: 'Tests', text: 'corre los tests\ny arregla' }]
  const raw = v11({ snippets: clone(snippets) })
  const a = parseConfig(clone(raw))
  check(a && a.version === 15, 'a v11 config with snippets parses and is stamped 15')
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
  check(st.automation.defaultAgentPresetId === '' && st.automation.composerCreateAnother === false, 'automation defaults (schema 12 keys)')
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
    check(written.version === 15 && !('snippets' in written) && written.quickCommands.map(c => c.id).join() === 'snip-a,snip-b,snip-c', 'the upgrade write stores quickCommands and drops snippets')
    check(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).snippets.length === 3, 'the pre-upgrade file with snippets stays in .bak')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

// ---- R30-01: schema 13 (v12 -> v13 keeps everything, defaults only) --------
// A v12 config as the 2.0 renderer writes it: every schema 12 key set to a
// non-default value, quick commands, a one-shot schedule, note and taskState.
function v12Real(extra = {}) {
  return {
    version: 12,
    workspaces: [
      { id: 'w1', name: 'Uno', cwd: 'C:/a', favorite: true, layout: { grid: 2, order: ['p1', 'p2'] }, setupId: 'c1', agentsCollapsed: true, note: 'revisar login', taskState: 'doing', panes: [
        { id: 'p1', type: 'claude', presetId: 'preset-claude', title: 'Claude', color: '#d97757', icon: 'claude', fontSize: 15, schedule: { time: '09:30', prompt: 'segui con el plan', dueAt: 1760000000000 }, lastSession: { provider: 'claude', sessionId: '0123abcd-0000-4000-8000-000000000000', cwd: 'C:/a', at: 7 } },
        { id: 'p2', type: 'shell', cwd: 'C:/a/sub', command: 'pwsh.exe', setupId: 'c1', title: 'Shell', color: '#fff', icon: 'terminal' },
      ] },
    ],
    presets: [{ id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: ['--verbose'], color: '#d97757', icon: 'claude', env: { A: '1' } }],
    settings: {
      ...clone(baseSettings), language: 'es', theme: 'nord', terminalRenderer: 'webgl', keymap: { palette: 'Ctrl+P' },
      terminalUnicode11: false, terminalAgentEndChip: false, awakeMode: 'always', terminalSnapshotMode: 'lazy', persistScrollback: false, persistScrollbackLines: 3000, gitChip: false, explorerMenu: true, updateDismissedVersion: '2.0.1',
      remote: { enabled: true, port: 4600 },
      notifications: { enabled: false, hooksEnabled: true, hookToken: 'a'.repeat(32), inAppWhenFocused: false, onlyWhenAway: true, ntfy: { enabled: true, server: 'https://ntfy.example', topic: 'mi-topic', token: 'tk', notifyAction: false, notifyDone: true } },
      agents: { resumeOnStartup: 'off', awakeDisplay: true, sidebarAgentRows: false, topicAsTitle: false, ctrlDigitFocus: false, resumeModalTimeoutSec: 0, resumeNudge: true, resumeNudgeText: 'Segui', sidebarSort: 'smart' },
      automation: { defaultAgentPresetId: 'preset-claude', composerCreateAnother: true },
    },
    activeWorkspaceId: 'w1',
    quickCommands: [qc(1), qc(2, { workspaceId: 'w1', action: 'agent', enter: true, presetId: 'preset-claude' })],
    connections: [{ id: 'c1', name: 'SSH', steps: [{ send: 'ssh host', waitFor: 'password:', secret: false }] }],
    keyButtons: [{ id: 'k1', label: 'Esc', seq: '\u001b' }],
    ...extra,
  }
}
// Every input value survives (new keys may appear next to them).
function survives(input, output, at = '') {
  if (input === output) return true
  if (typeof input !== 'object' || input === null || typeof output !== 'object' || output === null) throw new Error(`value changed at ${at || '<root>'}: ${JSON.stringify(input)} -> ${JSON.stringify(output)}`)
  for (const k of Object.keys(input)) if (k !== 'version') survives(input[k], output[k], `${at}.${k}`)
  return true
}
const run = (at, extra = {}) => ({ at, scheduledFor: at - 5, trigger: 'scheduled', status: 'sent', ...extra })

async function schema13Checks() {
  const raw = v12Real()
  const a = parseConfig(clone(raw))
  check(a && a.version === CONFIG_VERSION, 'a real v12 config parses and is stamped with the current version')
  check(survives(raw, a), 'every v12 value survives v12 -> v13 -> v14 unchanged')
  const st = a.settings
  check(st.remote.phoneFit === true && JSON.stringify(st.remote.https) === '{"enabled":false,"mode":"tailscaleServe"}' && st.remote.enabled === true && st.remote.port === 4600, 'remote gains phoneFit on and https off (tailscaleServe), keeping enabled and port')
  check(st.cliEnabled === true && st.worktreesRoot === '' && st.hibernateIdleMinutes === 0, 'cliEnabled on, worktreesRoot empty (= dataDir()/worktrees) and hibernation off')
  check(JSON.stringify(st.agents.cacheTimer) === '{"enabled":false,"ttlMinutes":5}' && st.agents.sidebarSort === 'smart', 'agents gain cacheTimer off/5 min next to the kept v12 values')
  check(JSON.stringify(st.automation) === JSON.stringify({ defaultAgentPresetId: 'preset-claude', composerCreateAnother: true, cliProtectSsh: true, cliUserPath: false, scheduleGraceMin: 120, scheduleMaxWaitMin: 30, scheduleNotify: false }), 'automation gains the cli/schedule defaults (120 grace, 30 max wait)')
  const sch = a.workspaces[0].panes[0].schedule
  check(JSON.stringify(sch) === JSON.stringify(raw.workspaces[0].panes[0].schedule), 'an old one-shot schedule parses with no new keys (stays one-shot)')
  check(a.workspaces[0].repoConfig === undefined && !('repoConfig' in a.workspaces[0]) && a.workspaces[0].panes.every(p => !('worktree' in p)), 'repoConfig and pane.worktree stay absent')
  check(JSON.stringify(parseConfig(clone(a))) === JSON.stringify(a), 'v13 parse is idempotent')

  // Contract amendment: no top-level repoConfigTrust or automations in config.json.
  const forged = parseConfig(v12Real({ repoConfigTrust: { 'C:/evil': 'f'.repeat(64) }, automations: [{ id: 'x' }] }))
  check(forged && !('repoConfigTrust' in forged) && !('automations' in forged), 'a stray top-level repoConfigTrust or automations is stripped (trust is main-owned)')

  // Values kept, junk values fall back field by field without rejecting the config.
  const set = (patch) => { const c = v12Real(); Object.assign(c.settings, patch); return parseConfig(c) }
  const ok = set({ remote: { enabled: false, port: 4517, phoneFit: false, https: { enabled: true, mode: 'tailscaleServe' } }, cliEnabled: false, worktreesRoot: 'D:/wt', hibernateIdleMinutes: 30, agents: { cacheTimer: { enabled: true, ttlMinutes: 60 } }, automation: { cliProtectSsh: false, cliUserPath: true, scheduleGraceMin: 0, scheduleMaxWaitMin: 240, scheduleNotify: true } })
  check(ok.settings.remote.phoneFit === false && ok.settings.remote.https.enabled === true && ok.settings.cliEnabled === false && ok.settings.worktreesRoot === 'D:/wt' && ok.settings.hibernateIdleMinutes === 30, 'valid v13 settings are kept')
  check(ok.settings.agents.cacheTimer.enabled === true && ok.settings.agents.cacheTimer.ttlMinutes === 60, 'cacheTimer 60 min is kept')
  check(JSON.stringify(ok.settings.automation) === JSON.stringify({ defaultAgentPresetId: '', composerCreateAnother: false, cliProtectSsh: false, cliUserPath: true, scheduleGraceMin: 0, scheduleMaxWaitMin: 240, scheduleNotify: true }), 'automation bounds 0 grace and 240 max wait are kept')
  check(set({ hibernateIdleMinutes: 5 }).settings.hibernateIdleMinutes === 5 && set({ hibernateIdleMinutes: 1440 }).settings.hibernateIdleMinutes === 1440, 'hibernation 5 and 1440 minutes are kept')
  for (const bad of [3, 1441, 12.5, -1, '30', null]) check(set({ hibernateIdleMinutes: bad }).settings.hibernateIdleMinutes === 0, `hibernation ${JSON.stringify(bad)} turns it off`)
  const junk = set({ remote: { enabled: true, port: 4517, phoneFit: 'si', https: { enabled: 'yes', mode: 'manualCert' } }, cliEnabled: 1, worktreesRoot: 5, agents: { cacheTimer: { enabled: true, ttlMinutes: 15 } }, automation: { cliProtectSsh: 'no', cliUserPath: 1, scheduleGraceMin: 2000, scheduleMaxWaitMin: 0, scheduleNotify: 'x' } })
  check(junk && junk.settings.remote.enabled === true && junk.settings.remote.phoneFit === true && JSON.stringify(junk.settings.remote.https) === '{"enabled":false,"mode":"tailscaleServe"}', 'junk phoneFit and https fields fall back (manualCert is not a mode)')
  check(junk.settings.cliEnabled === true && junk.settings.worktreesRoot === '' && junk.settings.agents.cacheTimer.enabled === true && junk.settings.agents.cacheTimer.ttlMinutes === 5, 'junk cliEnabled/worktreesRoot default, cacheTimer 15 min falls back to 5 keeping enabled')
  check(junk.settings.automation.cliProtectSsh === true && junk.settings.automation.cliUserPath === false && junk.settings.automation.scheduleGraceMin === 120 && junk.settings.automation.scheduleMaxWaitMin === 30 && junk.settings.automation.scheduleNotify === false, 'out-of-range grace/max wait and junk booleans fall back to defaults')
  const nonObj = set({ remote: { enabled: true, port: 4517, https: 'on' }, agents: { cacheTimer: 'x' } })
  check(nonObj && nonObj.settings.remote.https.enabled === false && nonObj.settings.agents.cacheTimer.ttlMinutes === 5, 'a non-object https or cacheTimer falls back to defaults')
  check(set({ worktreesRoot: 'x'.repeat(5000) }).settings.worktreesRoot === '' && set({ automation: { scheduleMaxWaitMin: 1.5 } }).settings.automation.scheduleMaxWaitMin === 30, 'an over-long root and a fractional wait fall back')

  // PaneSchedule automation fields (E8-FR-28..31), the contract's `automations`.
  const withSchedule = (schedule) => { const c = v12Real(); c.workspaces[0].panes[0].schedule = schedule; return parseConfig(c) }
  const base = { time: '09:30', prompt: 'segui', dueAt: 1760000000000 }
  const fullSch = { ...base, recurrence: { kind: 'weekly', days: [1, 3, 5] }, waitIdle: false, enabled: false, waitingSince: 1759999990000, history: [run(1), run(2, { status: 'failed', reason: 'agent_not_running' }), run(3, { trigger: 'manual', status: 'skipped_busy' })] }
  const f = withSchedule(clone(fullSch))
  check(JSON.stringify(f.workspaces[0].panes[0].schedule) === JSON.stringify(fullSch), 'a full v13 schedule (weekly, waitIdle, paused, waitingSince, history) round-trips')
  for (const kind of ['once', 'daily', 'weekdays', 'hourly']) check(withSchedule({ ...base, recurrence: { kind } }).workspaces[0].panes[0].schedule.recurrence.kind === kind, `recurrence ${kind} is kept`)
  for (const bad of [{ kind: 'weekly', days: [] }, { kind: 'weekly', days: [1, 1] }, { kind: 'weekly', days: [7] }, { kind: 'weekly' }, { kind: 'monthly' }, 'daily']) {
    const p = withSchedule({ ...base, recurrence: bad })
    check(p && p.workspaces[0].panes[0].schedule.prompt === 'segui' && p.workspaces[0].panes[0].schedule.recurrence === undefined, `a junk recurrence ${JSON.stringify(bad)} is dropped, the schedule stays`)
  }
  const jf = withSchedule({ ...base, waitIdle: 'x', enabled: 0, waitingSince: 'ayer', history: 'nope' }).workspaces[0].panes[0].schedule
  check(jf.prompt === 'segui' && jf.waitIdle === undefined && jf.enabled === undefined && jf.waitingSince === undefined && jf.history === undefined, 'junk waitIdle, enabled, waitingSince and history are dropped field by field')
  const hist = withSchedule({ ...base, history: [run(1), 'basura', run(2, { status: 'exploded' }), run(3, { reason: 'weird' }), { at: 4 }] }).workspaces[0].panes[0].schedule.history
  check(hist.length === 2 && hist[0].at === 1 && hist[1].at === 3 && hist[1].reason === undefined, 'history parses item by item; an unknown reason is dropped, the run kept')
  const many = withSchedule({ ...base, history: Array.from({ length: 25 }, (_, i) => run(100 + i)) }).workspaces[0].panes[0].schedule.history
  check(many.length === 20 && many[0].at === 105 && many[19].at === 124, '25 runs keep the 20 most recent, oldest first')
  const desc = withSchedule({ ...base, history: Array.from({ length: 25 }, (_, i) => run(200 - i)) }).workspaces[0].panes[0].schedule.history
  check(desc.length === 20 && desc[0].at === 200 && desc[19].at === 181, 'newest-first history also keeps the 20 most recent in its order')

  // Workspace repoConfig trace (E8-FR-25).
  const sha = 'ab'.repeat(32)
  const withRepo = (repoConfig) => { const c = v12Real(); c.workspaces[0].repoConfig = repoConfig; return parseConfig(c) }
  const rc = withRepo({ sha256: sha, appliedAt: 5, quickCommandIds: ['qc-1', 'qc-2'] })
  check(JSON.stringify(rc.workspaces[0].repoConfig) === JSON.stringify({ sha256: sha, appliedAt: 5, quickCommandIds: ['qc-1', 'qc-2'] }), 'repoConfig is kept')
  check(withRepo({ sha256: sha, appliedAt: 5, quickCommandIds: Array.from({ length: 25 }, (_, i) => `qc-${i}`) }).workspaces[0].repoConfig.quickCommandIds.length === 20, 'repoConfig keeps at most 20 quick command ids')
  const mixed = withRepo({ sha256: sha, appliedAt: 5, quickCommandIds: ['qc-1', 7, '', 'x'.repeat(129), 'qc-1', 'qc-2', null] })
  check(mixed && JSON.stringify(mixed.workspaces[0].repoConfig.quickCommandIds) === '["qc-1","qc-2"]', 'repoConfig ids parse one by one: junk, empty, over-long and duplicate ids are dropped, the trace kept')
  for (const bad of [{ sha256: 'xyz', appliedAt: 1, quickCommandIds: [] }, { sha256: sha, quickCommandIds: [] }, { sha256: sha, appliedAt: 1, quickCommandIds: 'qc-1' }, 'trusted']) {
    const p = withRepo(bad)
    check(p && p.workspaces[0].name === 'Uno' && p.workspaces[0].repoConfig === undefined, `a malformed repoConfig ${JSON.stringify(bad).slice(0, 40)} is dropped without rejecting the config`)
  }

  // ConfigStore: the renderer load upgrades a real v12 file to 13 once, .bak keeps v12.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-schema13-test-'))
  try {
    const app = { getPath: () => dir, isPackaged: false }
    const { ConfigStore } = load('src/main/store/ConfigStore.ts', { require: id => (id === 'electron' ? { app } : require(id)), process: { ...process, env: {}, argv: ['electron'] } })
    const file = path.join(dir, 'config.json'), text = JSON.stringify(raw)
    fs.writeFileSync(file, text)
    const store = new ConfigStore()
    check(store.load().version === 15 && fs.readFileSync(file, 'utf8') === text, 'a plain load reads v12 as 15 and leaves the file untouched')
    store.load({ upgrade: true })
    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    check(written.version === 15 && survives(raw, written) && written.settings.remote.phoneFit === true && written.settings.automation.scheduleGraceMin === 120, 'the upgrade write stores v14 with every v12 value and the v13 defaults')
    check(fs.readFileSync(file + '.bak', 'utf8') === text, 'the pre-upgrade v12 file stays in .bak')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }

  // Renderer round trip: hydrate -> persist -> parse keeps the v13 fields.
  const saves = [], timers = new Map()
  let seq = 0
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  const r = loadRenderer(`export { startPersistence } from './persist'; export { useAppStore } from './store'`, {
    window: { snApi: { config: { save: cfg => saves.push(clone(cfg)) }, pty: { killPanes: async () => 0 } } },
    document: { hasFocus: () => false },
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
  })
  const S = r.useAppStore
  check(S.getState().settings.remote.phoneFit === true && S.getState().settings.cliEnabled === true && S.getState().settings.automation.scheduleMaxWaitMin === 30 && S.getState().settings.agents.cacheTimer.ttlMinutes === 5, 'the store defaults carry the v13 keys')
  S.getState().hydrate(rc)
  const stop = r.startPersistence()
  S.getState().setPaneSchedule('w1', 'p1', clone(fullSch))
  S.getState().updateSettings({ hibernateIdleMinutes: 45, remote: { ...S.getState().settings.remote, phoneFit: false } })
  flush()
  const back = parseConfig(saves.at(-1))
  check(back && back.version === 15 && JSON.stringify(back.workspaces[0].panes[0].schedule) === JSON.stringify(fullSch) && back.workspaces[0].repoConfig.sha256 === sha, 'schedule fields and repoConfig persist through the store and the schema')
  check(back.settings.hibernateIdleMinutes === 45 && back.settings.remote.phoneFit === false && back.settings.remote.https.mode === 'tailscaleServe', 'v13 settings persist through the store')
  stop()
}
// ---- end R30-01 -------------------------------------------------------------

// ---- R31-00: schema 14 (v13 -> v14 keeps everything) and the v3.1 ctl -------
// A v13 config as the 2.0 renderer writes it: the v12 fixture plus every
// schema 13 key set to a non-default value, a full PaneSchedule, a worktree
// pane and a repoConfig trace.
function v13Real(extra = {}) {
  const c = v12Real()
  c.version = 13
  Object.assign(c.settings, { cliEnabled: false, worktreesRoot: 'D:/wt', hibernateIdleMinutes: 30 })
  c.settings.remote = { enabled: true, port: 4600, phoneFit: false, https: { enabled: true, mode: 'tailscaleServe' } }
  c.settings.agents.cacheTimer = { enabled: true, ttlMinutes: 60 }
  Object.assign(c.settings.automation, { cliProtectSsh: false, cliUserPath: true, scheduleGraceMin: 0, scheduleMaxWaitMin: 240, scheduleNotify: true })
  c.workspaces[0].repoConfig = { sha256: 'cd'.repeat(32), appliedAt: 9, quickCommandIds: ['qc-1'] }
  c.workspaces[0].panes[0].schedule = { time: '09:30', prompt: 'segui', dueAt: 1760000000000, recurrence: { kind: 'weekdays' }, waitIdle: false, enabled: false, waitingSince: 1759999990000, history: [run(1), run(2, { trigger: 'manual', status: 'failed', reason: 'not_delivered' })] }
  c.workspaces[0].panes[1].worktree = { repoRoot: 'C:/a', path: 'D:/wt/a-fix', branch: 'sn/a-fix', base: 'ab12cd34' }
  return Object.assign(c, extra)
}

async function schema14Checks() {
  check(CONFIG_VERSION === 15, 'CONFIG_VERSION is 15 (R31-00)')
  const raw = v13Real()
  const a = parseConfig(clone(raw))
  check(a && a.version === 15, 'a real v13 config parses and is stamped 15')
  check(survives(raw, a), 'every v13 value survives v13 -> v14 unchanged (schedule, worktree, repoConfig, remote, cacheTimer, automation)')
  check(a.settings.terminalShellIntegration === true, 'settings.terminalShellIntegration defaults to true')
  check(!('terminalShellIntegration' in raw.settings) && Object.keys(a.workspaces[0]).sort().join() === Object.keys(raw.workspaces[0]).sort().join(), 'the v14 key is the only addition: workspaces keep exactly their v13 keys')
  check(JSON.stringify(parseConfig(clone(a))) === JSON.stringify(a), 'v14 parse is idempotent')
  const fromV10 = parseConfig({ version: 10, workspaces: [], presets: [], settings: clone(baseSettings) })
  check(fromV10 && fromV10.version === 15 && fromV10.settings.terminalShellIntegration === true && fromV10.settings.hibernateIdleMinutes === 0, 'a v10 config walks 11..14 in one parse and gains the v14 default')
  // Schema 15: settings.usage.collapsed, default only.
  check(a.settings.usage.collapsed === false && fromV10.settings.usage.collapsed === false, 'v15: usage.collapsed defaults to false')
  const v14 = clone(a); v14.version = 14; delete v14.settings.usage.collapsed
  const up15 = parseConfig(v14)
  check(up15.version === 15 && up15.settings.usage.collapsed === false && survives(v14, up15), 'v14 -> v15 keeps every value and only adds the default')
  const junk = clone(a); junk.settings.usage.collapsed = 'yes'
  check(parseConfig(junk).settings.usage.collapsed === false, 'a junk usage.collapsed falls back to false')
  const kept = clone(a); kept.settings.usage.collapsed = true
  check(parseConfig(kept).settings.usage.collapsed === true, 'usage.collapsed true is kept')

  // Values kept, junk values fall back without rejecting the config.
  const set = (v) => { const c = v13Real(); c.settings.terminalShellIntegration = v; return parseConfig(c) }
  check(set(false).settings.terminalShellIntegration === false && set(true).settings.terminalShellIntegration === true, 'terminalShellIntegration false and true are kept')
  for (const bad of ['off', 0, 1, null, { on: false }]) {
    const p = set(bad)
    check(p && p.settings.terminalShellIntegration === true && p.settings.cliEnabled === false, `a junk terminalShellIntegration ${JSON.stringify(bad)} falls back to true, the rest kept`)
  }

  // ConfigStore: the renderer load upgrades a real v13 file to 14 once, .bak keeps v13.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-schema14-test-'))
  try {
    const app = { getPath: () => dir, isPackaged: false }
    const { ConfigStore } = load('src/main/store/ConfigStore.ts', { require: id => (id === 'electron' ? { app } : require(id)), process: { ...process, env: {}, argv: ['electron'] } })
    const file = path.join(dir, 'config.json'), text = JSON.stringify(raw)
    fs.writeFileSync(file, text)
    const store = new ConfigStore()
    check(store.load().version === 15 && fs.readFileSync(file, 'utf8') === text, 'a plain load reads v13 as 15 and leaves the file untouched')
    store.load({ upgrade: true })
    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    check(written.version === 15 && survives(raw, written) && written.settings.terminalShellIntegration === true, 'the upgrade write stores v14 with every v13 value and the new default')
    check(fs.readFileSync(file + '.bak', 'utf8') === text, 'the pre-upgrade v13 file stays in .bak')
    store.load({ upgrade: true })
    check(fs.readFileSync(file + '.bak', 'utf8') === text && JSON.parse(fs.readFileSync(file, 'utf8')).version === 15, 'a second upgrade load rewrites nothing (.bak still v13)')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }

  // Renderer: the store default and a persisted toggle round-trip through the schema.
  const saves = [], timers = new Map()
  let seq = 0
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  const r = loadRenderer(`export { startPersistence } from './persist'; export { useAppStore } from './store'`, {
    window: { snApi: { config: { save: cfg => saves.push(clone(cfg)) }, pty: { killPanes: async () => 0 } } },
    document: { hasFocus: () => false },
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
  })
  const S = r.useAppStore
  check(S.getState().settings.terminalShellIntegration === true, 'the store default carries terminalShellIntegration on')
  S.getState().hydrate(a)
  const stop = r.startPersistence()
  S.getState().updateSettings({ terminalShellIntegration: false })
  flush()
  const back = parseConfig(saves.at(-1))
  check(back && back.version === 15 && back.settings.terminalShellIntegration === false && survives(raw.workspaces, back.workspaces), 'turning shell integration off persists as v14 and keeps the v13 workspaces')
  stop()
}

/** v3.1 WS amendments (R31-00): the two Automations ctl through the real zod schema. */
function v31ContractChecks() {
  const { parseRemoteClientMsg } = load('src/shared/remote-protocol-schemas.ts', { URL })
  const frame = (action) => parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'ctl', id: 'c1', action }))
  const run = frame({ kind: 'scheduleRun', workspaceId: 'w1', paneId: 'p1' })
  check(run && run.action.kind === 'scheduleRun' && run.action.workspaceId === 'w1' && run.action.paneId === 'p1', 'scheduleRun { workspaceId, paneId } parses')
  const withText = frame({ kind: 'scheduleRun', workspaceId: 'w1', paneId: 'p1', text: 'rm -rf /', prompt: 'x' })
  check(withText && !('text' in withText.action) && !('prompt' in withText.action), 'scheduleRun never carries text: stray text/prompt fields are stripped')
  for (const bad of [{ kind: 'scheduleRun', paneId: 'p1' }, { kind: 'scheduleRun', workspaceId: 'w1' }, { kind: 'scheduleRun', workspaceId: '', paneId: 'p1' }, { kind: 'scheduleRun', workspaceId: 'w1', paneId: 'x'.repeat(129) }, { kind: 'scheduleRun', workspaceId: 1, paneId: 'p1' }]) {
    check(frame(bad) === null, `scheduleRun rejects ${JSON.stringify(bad).slice(0, 60)}`)
  }
  for (const enabled of [true, false]) {
    const t = frame({ kind: 'scheduleToggle', workspaceId: 'w1', paneId: 'p1', enabled })
    check(t && t.action.kind === 'scheduleToggle' && t.action.enabled === enabled, `scheduleToggle enabled ${enabled} parses`)
  }
  for (const bad of [{ kind: 'scheduleToggle', workspaceId: 'w1', paneId: 'p1' }, { kind: 'scheduleToggle', workspaceId: 'w1', paneId: 'p1', enabled: 'true' }, { kind: 'scheduleToggle', workspaceId: 'w1', paneId: 'p1', enabled: 1 }, { kind: 'scheduleToggle', paneId: 'p1', enabled: true }, { kind: 'scheduleToggle', workspaceId: 'w1', enabled: false }]) {
    check(frame(bad) === null, `scheduleToggle rejects ${JSON.stringify(bad).slice(0, 70)}`)
  }
  check(frame({ kind: 'scheduleEdit', workspaceId: 'w1', paneId: 'p1', prompt: 'x' }) === null, 'there is no ctl to edit a schedule from the phone')
  check(frame({ kind: 'runQuickCommand', workspaceId: 'w1', id: 'qc-1' }) && frame({ kind: 'agentResume', workspaceId: 'w1', paneId: 'p1', mode: 'new' }), 'the earlier ctl kinds still parse next to the v3.1 ones')
}
// ---- end R31-00 -------------------------------------------------------------

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
  check(last && last.version === 15 && last.quickCommands.length === 3 && !('snippets' in last), 'the persisted blob writes quickCommands and never snippets')
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

// The delivery rules depend on the OS the shells run on (a `%` forces the gate
// on win32 only): the harness pins it, Windows by default since these checks
// spell out PowerShell / cmd.exe behavior, so every CI host runs the same rules.
function ptyHarness(agentState, platform = 'win32') {
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
  const pm = new mod.exports.PtyManager(() => ({ isDestroyed: () => false, send: (ch, p) => sent.push({ ch, p }) }), () => ({}), agentState, platform)
  pm.setEngine({ snapshotMode: 'off' })
  const results = () => sent.filter((e) => e.ch === 'pty:promptResult').map((e) => e.p.result)
  return { pm, procs, sent, spawnCalls, clock, results }
}

// Real files so resolveShell (host lookup) accepts them; the name decides the
// shell family under the pinned platform, so cmd.exe is covered on every host.
const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-qc-shells-'))
const win = process.platform === 'win32'
const fakeShell = (name) => { const f = path.join(shellDir, win ? `${name}.exe` : name); fs.writeFileSync(f, ''); return f }
const PWSH = fakeShell('pwsh')
const BASH = fakeShell('bash')
const CMD = fakeShell('cmd')

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
    pm.spawn({ paneId: 'a3', shell: CMD, cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('update') })
    await clock.advance(400)
    check(procs[2].text() === 'claude "%SNAOS_INITIAL_PROMPT%"\r' && spawnCalls[2].opts.env.SNAOS_INITIAL_PROMPT === ' update', 'argv in cmd.exe; a single word gets its leading space')
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
  {
    // The same spawns on Linux / macOS: `%` is plain text there, so argv stays;
    // a POSIX name matches exactly (no .exe) and `cmd` is no known shell.
    const posixShell = (name) => { const f = path.join(shellDir, name); fs.writeFileSync(f, ''); return f }
    const { pm, procs, spawnCalls, clock, results } = ptyHarness(() => null, 'linux')
    pm.spawn({ paneId: 'x1', shell: posixShell('bash'), cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('usa 50% de cpu') })
    await clock.advance(400)
    check(procs[0].text() === 'claude "$SNAOS_INITIAL_PROMPT"\r' && spawnCalls[0].opts.env.SNAOS_INITIAL_PROMPT === 'usa 50% de cpu' && JSON.stringify(results()) === '["sent_argv"]', 'a % prompt off Windows goes through argv')
    pm.spawn({ paneId: 'x2', shell: posixShell('pwsh'), cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('100% listo', { mode: 'argvOnly' }) })
    await clock.advance(400)
    check(procs[1].text() === 'claude $env:SNAOS_INITIAL_PROMPT\r' && results().at(-1) === 'sent_argv', 'argvOnly with a % off Windows is delivered by argv')
    pm.spawn({ paneId: 'x3', shell: posixShell('cmd'), cols: 80, rows: 24, initialCommand: 'claude', launchKind: 'claude', initialPrompt: prompt('hola') })
    await clock.advance(400)
    check(procs[2].text() === 'claude\r' && !('SNAOS_INITIAL_PROMPT' in spawnCalls[2].opts.env), 'off Windows `cmd` is an unknown shell: the gate, no variable')
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
  check(!res.ok && res.error === 'no_console' && submits.length === 0 && toasts().at(-1).title === 'No hay consola activa' && toasts().at(-1).kind === 'error', 'send without live consoles shows the toast and writes nothing')
  r.registerPty('p1', 'pty-p1'); r.registerPty('p2', 'pty-p2'); r.registerPty('q1', 'pty-q1')
  res = await r.runQuickCommand(qcOf('g'))
  check(res.ok && submits.at(-1).ptyId === 'pty-p2' && submits.at(-1).text === 'echo g' && submits.at(-1).enter === false, 'send without a focused console goes to the first live console in grid order')
  check(toasts().at(-1).title === 'Enviado: Cmd g a Dos', 'send feedback toast names the command and the console (E4-FR-06)')
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

// --- R22-13: workspace composer, note and task state (E8-FR-08..10) -------------
async function composerChecks() {
  // Note normalization (shared with the CLI later).
  const N = load('src/shared/workspaceNote.ts')
  check(N.WORKSPACE_NOTE_MAX === 140 && N.TASK_STATES.join() === 'todo,doing,review,done', 'note max and task states')
  check(N.normalizeWorkspaceNote('  revisar\nel\r\nlogin\t ok ') === 'revisar el login ok', 'line breaks and tabs become single spaces, ends trimmed')
  check(N.normalizeWorkspaceNote('   ') === undefined && N.normalizeWorkspaceNote('') === undefined && N.normalizeWorkspaceNote(7) === undefined && N.normalizeWorkspaceNote(null) === undefined, 'blank or non-string is no note')
  check(N.normalizeWorkspaceNote('x'.repeat(141)).length === 140 && N.normalizeWorkspaceNote('x'.repeat(140)).length === 140, '141 characters are clipped to 140')
  const emoji = N.normalizeWorkspaceNote('a'.repeat(139) + '\u{1F600}')
  check(emoji === 'a'.repeat(139), 'the clip never leaves half a surrogate pair')
  check(N.isTaskState('review') && !N.isTaskState('blocked') && !N.isTaskState(null), 'isTaskState')

  // Composer model.
  const C = loadRenderer(`export * from '@/components/wizard/composerModel'`)
  const wss = [{ cwd: 'C:/a' }, { cwd: 'C:/repos/api' }, { cwd: '' }, { cwd: 'c:\\A\\' }, { cwd: 'D:/web' }, { cwd: 'C:/repos/api/' }]
  check(C.folderSuggestions(wss, '').join('|') === 'C:/repos/api/|D:/web|c:\\A\\', 'suggestions: most recent first, one per folder (normalized), empty cwd skipped')
  check(C.folderSuggestions(wss, 'REPOS').join('|') === 'C:/repos/api/', 'a query filters case-insensitively')
  check(C.folderSuggestions(wss, 'C:\\repos\\api').length === 0, 'the folder already typed is not suggested')
  const many = Array.from({ length: 12 }, (_, i) => ({ cwd: `C:/p${i}` }))
  check(C.folderSuggestions(many, '').length === 8 && C.folderSuggestions(many, '')[0] === 'C:/p11', 'at most 8 suggestions, the newest first')
  check(C.basenameOf('C:\\repos\\api\\') === 'api' && C.basenameOf('/home/me/web') === 'web' && C.basenameOf('') === '', 'basenameOf')
  const presets = [
    { id: 'sh', name: 'Shell', type: 'shell', command: '', args: [], color: '#111', icon: 'terminal' },
    { id: 'cx', name: 'Codex', type: 'codex', command: 'codex', args: [], color: '#222', icon: 'codex' },
    { id: 'cl', name: 'Claude', type: 'claude', command: 'claude', args: [], color: '#333', icon: 'claude' },
  ]
  check(C.resolveDefaultPreset(presets, 'cx') === 'cx', 'the saved default agent wins')
  check(C.resolveDefaultPreset(presets, 'gone') === 'cl' && C.resolveDefaultPreset(presets, '') === 'cl', 'a deleted or empty default falls back to the first claude')
  check(C.resolveDefaultPreset(presets.slice(0, 2), '') === 'sh' && C.resolveDefaultPreset([], '') === '', 'without claude the first preset, without presets nothing')
  const ev = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o })
  const el = (tagName, attrs = {}) => ({ tagName, getAttribute: (n) => (n in attrs ? attrs[n] : null) })
  check(C.composerKeyAction(ev('Enter', { ctrlKey: true }), el('TEXTAREA'), true) === 'create', 'Ctrl+Enter creates from the textarea')
  check(C.composerKeyAction(ev('Enter', { ctrlKey: true }), el('TEXTAREA'), false) === 'block', 'Ctrl+Enter without a folder is swallowed')
  check(C.composerKeyAction(ev('Enter'), el('TEXTAREA'), true) === null, 'Enter in the prompt is a newline')
  check(C.composerKeyAction(ev('Enter'), el('BUTTON', { 'data-composer-agent': 'cl', role: 'radio' }), true) === 'create', 'Enter on the agent selector creates')
  check(C.composerKeyAction(ev('Enter'), el('INPUT'), true) === 'create' && C.composerKeyAction(ev('Enter'), el('INPUT'), false) === 'block', 'Enter in a text field creates, or is blocked without a folder')
  check(C.composerKeyAction(ev('Enter'), el('BUTTON'), true) === null && C.composerKeyAction(ev('Enter'), el('SELECT'), true) === null, 'other buttons and the profile select keep their Enter')
  check(C.composerKeyAction(ev('Enter', { isComposing: true }), el('INPUT'), true) === null && C.composerKeyAction(ev('a'), el('INPUT'), true) === null && C.composerKeyAction(ev('Enter', { altKey: true }), el('INPUT'), true) === null, 'IME, other keys and Alt+Enter are not ours')
  const panes = C.composerPanes(presets[2], 4)
  check(panes.length === 4 && panes.every((p) => p.presetId === 'cl' && p.type === 'claude' && p.title === 'Claude') && panes[0] !== panes[1], 'every grid cell gets the same agent (own objects)')
  check(C.composerPanes(undefined, 1)[0].type === 'shell', 'a missing preset makes a shell')
  check(C.COMPOSER_GRIDS.join() === '1,2,4', 'grid choices 1 / 2 / 4')
  check(C.nextAgentIndex('ArrowRight', 2, 3) === 0 && C.nextAgentIndex('ArrowLeft', 0, 3) === 2 && C.nextAgentIndex('End', 0, 3) === 2 && C.nextAgentIndex('x', 0, 3) === null, 'agent selector arrows wrap')

  // Store: note, task state, first prompt, composer and advanced wizard.
  const r = loadRenderer(`export { useAppStore } from './store'`, {
    window: { snApi: { config: { save() {} }, pty: { killPanes: async () => 0 } } },
    document: { hasFocus: () => false },
  })
  const S = r.useAppStore
  S.getState().hydrate({ ...v11(), settings: { ...S.getState().settings } })
  S.getState().setWorkspaceNote('w1', '  revisar\nlogin ')
  check(S.getState().workspaces[0].note === 'revisar login', 'setWorkspaceNote normalizes line breaks')
  S.getState().setWorkspaceNote('w1', 'n'.repeat(141))
  check(S.getState().workspaces[0].note.length === 140, 'the store never keeps 141 characters')
  const before = S.getState().workspaces
  S.getState().setWorkspaceNote('w1', 'n'.repeat(141))
  check(S.getState().workspaces === before, 'the same note again changes nothing')
  S.getState().setWorkspaceNote('w1', '  ')
  check(!('note' in S.getState().workspaces[0]), 'a blank note removes the key')
  S.getState().setWorkspaceTaskState('w2', 'review')
  check(S.getState().workspaces[1].taskState === 'review', 'setWorkspaceTaskState sets it')
  S.getState().setWorkspaceTaskState('w2', 'blocked')
  check(!('taskState' in S.getState().workspaces[1]), 'an unknown state clears it')
  S.getState().setWorkspaceTaskState('w2', 'done')
  S.getState().setWorkspaceTaskState('w2', null)
  check(!('taskState' in S.getState().workspaces[1]), 'null clears it')
  S.getState().setWorkspaceNote('nope', 'x')
  check(S.getState().workspaces.every((w) => !w.note), 'an unknown workspace is ignored')

  const pane = (type, presetId) => ({ type, presetId, title: type, color: '#fff', icon: type })
  const id1 = S.getState().createWorkspaceFull({ name: 'Nuevo', cwd: 'C:/n', grid: 4, panes: [pane('shell'), pane('claude', 'cl'), pane('claude', 'cl'), pane('codex', 'cx')], firstPrompt: 'arregla el login' })
  const ws1 = S.getState().workspaces.find((w) => w.id === id1)
  const pending = S.getState().pendingPrompts
  check(S.getState().activeWorkspaceId === id1, 'the created workspace is active')
  check(Object.keys(pending).length === 1 && pending[ws1.panes[1].id] && pending[ws1.panes[1].id].text === 'arregla el login' && pending[ws1.panes[1].id].enter === true && pending[ws1.panes[1].id].source === 'composer', 'the first prompt goes only to the first agent console, with Enter')
  S.getState().createWorkspaceFull({ name: 'Solo shell', cwd: 'C:/s', grid: 1, panes: [pane('shell')], firstPrompt: 'hola' })
  S.getState().createWorkspaceFull({ name: 'Blanco', cwd: 'C:/b', grid: 1, panes: [pane('claude', 'cl')], firstPrompt: '   ' })
  check(Object.keys(S.getState().pendingPrompts).length === 1, 'no agent console or a blank prompt queues nothing')
  check(S.getState().takePendingPrompt(ws1.panes[1].id).text === 'arregla el login' && S.getState().takePendingPrompt(ws1.panes[1].id) === null, 'the prompt is consumed once')

  S.getState().setWizardOpen(true, { cwd: 'C:/pre' })
  let st = S.getState()
  check(st.wizardOpen && st.composerOpen && st.wizardPrefill.cwd === 'C:/pre' && st.wizardDraft === null, 'setWizardOpen(true) opens the composer with the prefill')
  S.getState().openAdvancedWizard({ name: 'api', cwd: 'C:/api', grid: 2, presetId: 'cl', setupId: '' })
  st = S.getState()
  check(st.wizardOpen && !st.composerOpen && st.wizardDraft.cwd === 'C:/api' && st.wizardDraft.grid === 2 && st.wizardPrefill === null, '"Advanced..." swaps in the wizard with the draft, the flow stays open')
  S.getState().setWizardOpen(false)
  st = S.getState()
  check(!st.wizardOpen && !st.composerOpen && st.wizardDraft === null && st.wizardPrefill === null, 'closing clears the whole flow')

  // Persisted fields survive a round trip through the schema.
  S.getState().setWorkspaceNote('w1', 'nota final')
  S.getState().setWorkspaceTaskState('w1', 'doing')
  const round = parseConfig(clone({ ...v11(), workspaces: S.getState().workspaces }))
  check(round.workspaces[0].note === 'nota final' && round.workspaces[0].taskState === 'doing', 'note and taskState persist through the schema')

  // fs:dirExists probe.
  const { dirExists } = load('src/main/dirExists.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-direxists-'))
  try {
    const file = path.join(tmp, 'f.txt')
    fs.writeFileSync(file, 'x')
    check((await dirExists(tmp)) === true && (await dirExists(file)) === false && (await dirExists(path.join(tmp, 'nope'))) === false, 'dirExists: folder yes, file and missing no')
    check((await dirExists('relative/dir')) === false && (await dirExists('')) === false && (await dirExists(42)) === false && (await dirExists(tmp + '\0x')) === false && (await dirExists('C:/' + 'x'.repeat(5000))) === false, 'relative, empty, non-string, NUL and over-long paths are not folders')
    const hang = await dirExists(tmp, { stat: () => new Promise(() => {}), timeoutMs: 30 })
    check(hang === true, 'a stalled probe (unreachable share) answers true after the timeout')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

async function main() {
  schemaChecks()
  await schema13Checks()
  await schema14Checks()
  v31ContractChecks()
  helperChecks()
  storeChecks()
  promptRuleChecks()
  await submitChecks()
  await gateChecks()
  stateOfChecks()
  await quickRunChecks()
  await composerChecks()
  await require('./test-automation-repo.cjs').run({ check, load, loadRenderer }) // R30-12 .snagentsos.json
  fs.rmSync(shellDir, { recursive: true, force: true })
  console.log(`PASS: ${checks} automation checks (schema 12, 13 and 14, v3.1 schedule ctl, snippets migration, item parsing, 100 cap, merge remap, store actions, prompt rules, submit, gate, stateOf, Quick Commands, composer, note and task state, .snagentsos.json)`)
}
main().catch((err) => {
  fs.rmSync(shellDir, { recursive: true, force: true })
  console.error(err)
  process.exit(1)
})
