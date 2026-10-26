// Preset env (AgentPreset.env): parsing, sanitizing, resolution by pane in
// main, the merge order inside PtyManager and the export sanitization.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone, ...overrides })
  return mod.exports
}

const P = load('src/shared/presetEnv.ts')
const { AGENT_ENV, CLI_ENV, LEGACY_BRAND } = load('src/shared/brand.ts')
const { INITIAL_PROMPT_ENV } = load('src/shared/initialPrompt.ts')
const SHELL_MARK = 'SNAOS_SHELL_MARK'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Parsing the editor text.
{
  const text = [
    '',
    '  # a comment',
    'FOO=bar',
    'URL = https://x.test/?a=1&b=2 ',
    'EMPTY=',
    'no_equals_here',
    '=novalue',
    '1BAD=x',
    'BAD KEY=x',
    'BAD-KEY=x',
    'SNAOS_CTL_TOKEN=evil',
    'snaos_console_id=evil',
    `${INITIAL_PROMPT_ENV}=evil`,
    `${SHELL_MARK}=evil`,
    `${LEGACY_BRAND.envPrefix}X=old`,
    'FOO=last\r',
    '_UNDER=1',
  ].join('\n')
  const env = P.parsePresetEnvText(text)
  check(same(env, { FOO: 'last', URL: 'https://x.test/?a=1&b=2', EMPTY: '', _UNDER: '1' }), `parse keeps valid lines, trims, splits on the first "=", last wins: ${JSON.stringify(env)}`)
  check(P.parsePresetEnvText('') === undefined && P.parsePresetEnvText('# only\n\nSNAOS_X=1') === undefined, 'nothing usable parses to undefined (the field is left out)')
  check(same(P.parsePresetEnvText('A=1\r\nB=2'), { A: '1', B: '2' }), 'CRLF lines parse')
  check(P.presetEnvToText({ A: '1', B: 'x=y' }) === 'A=1\nB=x=y' && P.presetEnvToText(undefined) === '', 'env to text round trips')
  check(same(P.parsePresetEnvText(P.presetEnvToText({ A: '1', B: 'x=y' })), { A: '1', B: 'x=y' }), 'text to env to text is stable')
}

// Reserved keys and sanitizing a stored record.
{
  check(P.isReservedEnvKey('SNAOS_ANY') && P.isReservedEnvKey('Snaos_any') && P.isReservedEnvKey(INITIAL_PROMPT_ENV) && P.isReservedEnvKey(SHELL_MARK), 'every SNAOS_ key is reserved, any case')
  for (const key of [...Object.values(AGENT_ENV), ...Object.values(CLI_ENV)]) check(P.isReservedEnvKey(key), `${key} is reserved`)
  check(!P.isReservedEnvKey('PATH') && !P.isReservedEnvKey('ANTHROPIC_API_KEY'), 'ordinary keys are not reserved')
  const clean = P.sanitizePresetEnv({ OK: 'v', SNAOS_CONSOLE_ID: 'evil', 'BAD KEY': 'x', NUM: 3, NUL: 'a\0b', NESTED: { a: 1 }, EMPTY: '' })
  check(same(clean, { OK: 'v', EMPTY: '' }), `a stored env drops reserved, invalid, non-string and NUL entries: ${JSON.stringify(clean)}`)
  check(same(P.sanitizePresetEnv(null), {}) && same(P.sanitizePresetEnv(['A=1']), {}) && same(P.sanitizePresetEnv('A=1'), {}), 'a non-record env is empty')
}

// Resolution by pane from main's config.
{
  const cfg = {
    presets: [
      { id: 'pre-a', name: 'A', type: 'claude', command: 'claude', args: [], env: { API: 'a', SNAOS_CTL_TOKEN: 'evil' }, color: '', icon: '' },
      { id: 'pre-b', name: 'B', type: 'shell', command: '', args: [], env: { API: 'b' }, color: '', icon: '' },
      { id: 'pre-none', name: 'N', type: 'shell', command: '', args: [], color: '', icon: '' },
    ],
    workspaces: [{ id: 'w', panes: [{ id: 'p-a', presetId: 'pre-a' }, { id: 'p-free' }, { id: 'p-gone', presetId: 'pre-deleted' }] }],
  }
  check(same(P.resolvePresetEnv(cfg, 'p-a'), { API: 'a' }), 'a saved pane gets its preset env, reserved keys dropped')
  check(same(P.resolvePresetEnv(cfg, 'p-a', 'pre-b'), { API: 'a' }), 'a saved pane ignores the renderer hint: the config is authoritative')
  check(same(P.resolvePresetEnv(cfg, 'p-free', 'pre-b'), {}), 'a saved pane without a preset gets nothing, whatever the hint')
  check(same(P.resolvePresetEnv(cfg, 'p-gone'), {}), 'a deleted preset gives nothing')
  check(same(P.resolvePresetEnv(cfg, 'p-new', 'pre-b'), { API: 'b' }), 'a pane not saved yet falls back to the hint')
  check(same(P.resolvePresetEnv(cfg, 'p-new', 'pre-unknown'), {}) && same(P.resolvePresetEnv(cfg, 'p-new'), {}) && same(P.resolvePresetEnv(cfg, 'p-new', 42), {}), 'an unknown, missing or junk hint gives nothing')
  check(same(P.resolvePresetEnv(null, 'p-a', 'pre-a'), {}) && same(P.resolvePresetEnv(cfg, 'p-new', 'pre-none'), {}), 'no config or a preset without env gives nothing')
  // The extracted pane lookup (shared with TranscriptLocator).
  const C = load('src/shared/paneConfig.ts')
  check(C.findPaneInConfig(cfg, 'p-a').ws.id === 'w' && C.findPaneInConfig(cfg, 'x') === null && C.findPaneInConfig(null, 'p-a') === null, 'findPaneInConfig finds a pane and its workspace')
  check(C.presetOfPane(cfg, { presetId: 'pre-b' }).id === 'pre-b' && C.presetOfPane(cfg, {}) === undefined, 'presetOfPane follows pane.presetId')
}

// Case-insensitive merge (Windows).
{
  const win = P.applyPresetEnv({ Path: 'C:\\old', Foo: '1' }, { PATH: 'C:\\new' }, true)
  check(same(win, { Foo: '1', PATH: 'C:\\new' }), `on Windows a preset PATH replaces the inherited Path: ${JSON.stringify(win)}`)
  const posix = P.applyPresetEnv({ Path: 'a' }, { PATH: 'b' }, false)
  check(same(posix, { Path: 'a', PATH: 'b' }), 'elsewhere keys are case sensitive')
  // An empty value means "not set": skipped, the inherited value (and its case variant) stays.
  const skip = P.applyPresetEnv({ PATH: '/usr/bin', HOME: '/h' }, { PATH: '', NEW_EMPTY: '', SET: 'v' }, false)
  check(same(skip, { PATH: '/usr/bin', HOME: '/h', SET: 'v' }), `an empty preset value is skipped and the inherited one kept: ${JSON.stringify(skip)}`)
  const winSkip = P.applyPresetEnv({ Path: 'C:\\old', ClaudeCfg: 'C:\\c' }, { PATH: '', CLAUDECFG: '' }, true)
  check(same(winSkip, { Path: 'C:\\old', ClaudeCfg: 'C:\\c' }), `on Windows an empty value never deletes the inherited case variant: ${JSON.stringify(winSkip)}`)
  check(same(P.parsePresetEnvText('KEY='), { KEY: '' }), 'the editor still stores KEY= (it just has no effect)')
}

// PtyManager: every spawn and restart takes the preset env, under the app's own variables.
{
  const spawned = []
  const impl = (_shell, _args, opts) => { spawned.push(opts.env); return { cols: opts.cols, rows: opts.rows, onData() {}, onExit() {}, write() {}, resize() {}, pause() {}, resume() {}, kill() {} } }
  function manager(platform, statusEnv) {
    const { PtyManager } = load('src/main/pty/PtyManager.ts', {
      console: { ...console, warn() {} },
      require: id => id === 'node-pty' ? { spawn: impl } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
    })
    return new PtyManager(() => ({ isDestroyed: () => false, send() {} }), statusEnv, undefined, platform)
  }
  const calls = []
  const presetEnv = {
    API_KEY: 'from-preset', SHARED: 'preset',
    // A hand edited config: none of these may reach the shell.
    [AGENT_ENV.consoleId]: 'evil', [CLI_ENV.ctlToken]: 'evil', [INITIAL_PROMPT_ENV]: 'evil', [SHELL_MARK]: 'evil', 'BAD KEY': 'x',
  }
  const pm = manager('linux', () => ({ [CLI_ENV.ctlToken]: 'tok' }))
  pm.spawn({ paneId: 'before', cols: 80, rows: 24 })
  check(!('API_KEY' in spawned[0]), 'without a source wired the spawn carries no preset env')
  pm.setPresetEnvSource((paneId, hint) => { calls.push([paneId, hint]); return presetEnv })
  pm.spawn({ paneId: 'pane', cols: 80, rows: 24, env: { SHARED: 'req', ONLY_REQ: 'r' }, presetId: 'pre-x' })
  const env = spawned.at(-1)
  check(calls.length === 1 && calls[0][0] === 'pane' && calls[0][1] === 'pre-x', 'the source is asked by paneId with the renderer hint')
  check(env.API_KEY === 'from-preset' && env.SHARED === 'preset' && env.ONLY_REQ === 'r', 'the preset env is applied over req.env')
  check(env[AGENT_ENV.consoleId] === 'pane' && env[CLI_ENV.ctlToken] === 'tok' && env[AGENT_ENV.ptyId] === pm.ptyIdForPane('pane'), 'the app variables win over a preset')
  check(!(INITIAL_PROMPT_ENV in env) && !(SHELL_MARK in env) && !('BAD KEY' in env), 'a preset never injects the prompt handoff, the shell mark or an invalid key')
  pm.restart({ paneId: 'pane', cols: 80, rows: 24, presetId: 'pre-x' }, 'restarted')
  check(calls.length === 2 && spawned.at(-1).API_KEY === 'from-preset' && spawned.at(-1)[AGENT_ENV.consoleId] === 'pane', 'a restart (resume, retry) resolves the preset env again')
  pm.setPresetEnvSource(() => { throw new Error('config unreadable') })
  pm.spawn({ paneId: 'broken', cols: 80, rows: 24 })
  check(spawned.at(-1)[AGENT_ENV.consoleId] === 'broken' && !('API_KEY' in spawned.at(-1)), 'a failing source never blocks the spawn')
  pm.killAll()

  const win = manager('win32', () => ({}))
  const inheritedPath = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH')
  win.setPresetEnvSource(() => ({ path: 'X:\\preset' }))
  win.spawn({ paneId: 'w', cols: 80, rows: 24 })
  const paths = Object.keys(spawned.at(-1)).filter(k => k.toUpperCase() === 'PATH')
  check(paths.length === 1 && spawned.at(-1)[paths[0]] === 'X:\\preset', `on Windows the preset path is the only PATH entry (inherited ${inheritedPath}): ${paths.join(',')}`)
  // An imported export (blank values) never spawns an empty PATH.
  win.setPresetEnvSource(() => ({ path: '', CLAUDE_CONFIG_DIR: '' }))
  win.spawn({ paneId: 'w2', cols: 80, rows: 24, env: { CLAUDE_CONFIG_DIR: 'C:\\req-cfg' } })
  const blankEnv = spawned.at(-1)
  const blankPaths = Object.keys(blankEnv).filter(k => k.toUpperCase() === 'PATH')
  check(inheritedPath && blankPaths.length === 1 && blankPaths[0] === inheritedPath && blankEnv[inheritedPath] === process.env[inheritedPath] && blankEnv[inheritedPath] !== '', `a blank preset path keeps the inherited ${inheritedPath}: ${blankPaths.join(',')}`)
  check(blankEnv.CLAUDE_CONFIG_DIR === 'C:\\req-cfg', 'a blank preset value never overrides req.env')
  win.killAll()
}

// Export: preset env values and secret Connection steps are blanked.
{
  const { sanitizeExport } = load('src/main/store/exportConfig.ts')
  const cfg = {
    version: 14, workspaces: [],
    presets: [
      { id: 'a', name: 'A', type: 'claude', command: 'claude', args: [], env: { ANTHROPIC_API_KEY: 'sk-ant-secret', REGION: 'eu-secret' }, color: '', icon: '' },
      { id: 'b', name: 'B', type: 'shell', command: '', args: [], color: '', icon: '' },
    ],
    connections: [{ id: 'c', name: 'Dedi', steps: [{ send: 'ssh me@host' }, { send: 'hunter2-secret', waitFor: 'password:', secret: true }, { send: 'cd /srv', secret: false }] }],
    settings: { notifications: { hookToken: 'h', hooksEnabled: true, discord: { webhookUrl: 'w', enabled: true } } },
  }
  const out = sanitizeExport(cfg)
  const text = JSON.stringify(out)
  check(same(out.presets[0].env, { ANTHROPIC_API_KEY: '', REGION: '' }), 'the export keeps the preset env keys with blank values')
  check(!('env' in out.presets[1]), 'a preset without env stays without env')
  check(out.connections[0].steps[1].send === '' && out.connections[0].steps[1].waitFor === 'password:' && out.connections[0].steps[1].secret === true, 'a secret step keeps its place and wait, not its text')
  check(out.connections[0].steps[0].send === 'ssh me@host' && out.connections[0].steps[2].send === 'cd /srv', 'non-secret steps are kept')
  check(!text.includes('sk-ant') && !text.includes('hunter2') && !text.includes('eu-secret'), 'no preset value or secret step survives in the exported text')
  check(cfg.presets[0].env.ANTHROPIC_API_KEY === 'sk-ant-secret' && cfg.connections[0].steps[1].send === 'hunter2-secret', 'the live config is not mutated')
  const bare = sanitizeExport({ version: 14, workspaces: [], presets: [], settings: { notifications: { discord: {} } } })
  check(!('connections' in bare), 'a config without connections exports without them')
  // Export -> import on another PC: the blank values resolve to no override at all.
  const imported = { ...out, workspaces: [{ id: 'w', panes: [{ id: 'p', presetId: 'a' }] }] }
  const resolved = P.resolvePresetEnv(imported, 'p')
  const inherited = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'mine' }
  check(same(P.applyPresetEnv({ ...inherited }, resolved, false), inherited) && same(P.applyPresetEnv({ ...inherited }, resolved, true), inherited), `an imported export leaves the inherited env untouched: ${JSON.stringify(resolved)}`)
}

console.log(`preset env: ${checks} checks passed`)
