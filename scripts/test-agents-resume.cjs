// Agent resume suite (E5-FR-05..11, 14): the argv builder, the launch truth
// table, transcript / rollout availability on fake trees, the durable session
// store under a fake clock and timers in a temp dataDir, its IPC, the phone ctl
// schema, and the renderer side (launch decisions, chips, closed stack, phone
// executor). Never touches the real ~/.claude, CODEX_HOME or user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const alias = { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'], alias }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, queueMicrotask, ...overrides })
  return mod.exports
}
/** Renderer modules bundled together so they share one store instance. */
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, Promise, ...overrides })
  return mod.exports
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-resume-'))
const DAY = 24 * 60 * 60 * 1000
const UUID = '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab'
const UUID2 = '1c8d3a5f-2b3c-4d4e-9fa0-123456789abc'
const UUID3 = '2d9e4b6a-3c4d-4e5f-8a1b-23456789abcd'

function testArgv() {
  const a = load('src/shared/agent-argv.ts')
  check(JSON.stringify(a.tokenize('"C:\\Program Files\\claude.exe" --model opus "fix the login"')) === JSON.stringify(['"C:\\Program Files\\claude.exe"', '--model', 'opus', '"fix the login"']), 'tokenize keeps quoted tokens whole and verbatim')
  check(a.isSafeSessionId(UUID) && a.isSafeSessionId('thread-abc12345') && !a.isSafeSessionId('launch:ab12cd34') && !a.isSafeSessionId('abc') && !a.isSafeSessionId('x; rm -rf') && !a.isSafeSessionId(42), 'isSafeSessionId accepts UUIDs and thread ids only')
  const claude = (cmd) => a.buildResumeCommand('claude', cmd, UUID)
  check(claude('claude --model opus') === `claude --model opus --resume ${UUID}`, 'preset args are kept: claude --model opus --resume <id>')
  check(claude('claude "fix the login"') === `claude --resume ${UUID}`, 'a positional prompt is never re-sent')
  check(claude('claude --continue') === `claude --resume ${UUID}` && claude('claude -c --verbose') === `claude --verbose --resume ${UUID}`, '--continue / -c are replaced, not duplicated')
  check(claude('claude -r old-session-1 --model opus') === `claude --model opus --resume ${UUID}` && claude('claude --resume=abc12345x') === `claude --resume ${UUID}`, 'an existing -r <id> / --resume=<id> is dropped')
  check(claude('claude --session-id 11112222 --fork-session') === `claude --resume ${UUID}`, '--session-id <id> and --fork-session are dropped')
  check(claude('"C:\\Tools\\claude.exe" --permission-mode plan hi') === `"C:\\Tools\\claude.exe" --permission-mode plan --resume ${UUID}`, 'a quoted path and value flags survive, the prompt does not')
  check(a.buildResumeCommand('claude', 'claude', 'launch:abc') === null, 'an unsafe id builds nothing')
  const codex = (cmd) => a.buildResumeCommand('codex', cmd, UUID)
  check(codex('codex -m gpt-5 --profile work "hola"') === `codex -m gpt-5 --profile work resume ${UUID}`, 'codex keeps -m/--profile values, flags go before the resume subcommand')
  check(codex(`codex resume ${UUID2} -c model=o3`) === `codex -c model=o3 resume ${UUID}` && codex('codex resume --last') === `codex resume ${UUID}`, 'codex: an existing resume <id> / --last is replaced; -c is config, not continue')
  check(a.OVERRIDE_RE.test('claude --model opus') && a.OVERRIDE_RE.test('claude.exe --verbose') && a.OVERRIDE_RE.test('codex') && !a.OVERRIDE_RE.test('npx claude') && !a.OVERRIDE_RE.test('claude && x') && !a.OVERRIDE_RE.test('claude "hola"'), 'OVERRIDE_RE: bare CLI plus flags only')
  check(a.OVERRIDE_RE.test('codex -c model=o3 --full-auto') && a.OVERRIDE_RE.test('codex --config=a=b') && !a.OVERRIDE_RE.test('claude; rm x') && !a.OVERRIDE_RE.test('claude | x'), 'OVERRIDE_RE: codex -c key=value resumes, shell operators do not')
  const t0 = Date.now()
  const slow = [a.OVERRIDE_RE.test('claude' + ' --ab-cd'.repeat(5000) + ' "'), a.OVERRIDE_RE.test('claude' + ' ---a'.repeat(5000) + ' !')]
  check(Date.now() - t0 < 500 && !slow[0] && !slow[1], 'OVERRIDE_RE fails a long run of flags in linear time (no catastrophic backtracking)')
  const preset = { type: 'claude', command: 'claude', args: ['--model', 'opus'] }
  check(a.buildAgentArgv({ preset }) === 'claude --model opus' && a.buildAgentArgv({ preset, command: 'claude --verbose' }) === 'claude --verbose', 'without resume: override > preset command+args')
  check(a.buildAgentArgv({ preset: { type: 'shell', command: 'pwsh', args: [] } }) === undefined, 'shell presets type nothing')
  check(a.buildAgentArgv({ preset, resume: { provider: 'claude', sessionId: UUID } }) === `claude --model opus --resume ${UUID}`, 'buildAgentArgv resumes from the preset')
  check(a.buildAgentArgv({ preset, command: 'claude --model sonnet', resume: { provider: 'claude', sessionId: UUID } }) === `claude --model sonnet --resume ${UUID}`, 'a resumable override is the base')
  check(a.buildAgentArgv({ preset, command: 'npx claude', resume: { provider: 'claude', sessionId: UUID } }) === undefined, 'a wrapper override cannot resume')
  check(a.buildAgentArgv({ preset: { type: 'custom', command: 'npx', args: ['claude'] }, resume: { provider: 'claude', sessionId: UUID } }) === `claude --resume ${UUID}`, 'a preset that is not the provider binary falls back to the bare CLI')
  check(a.buildAgentArgv({ resume: { provider: 'codex', sessionId: UUID } }) === `codex resume ${UUID}`, 'no preset (shell pane, explicit resume): bare provider')
  check(a.buildCdPrefix('powershell', "C:\\it's here") === "Set-Location -LiteralPath 'C:\\it''s here'; ", 'powershell cd doubles single quotes')
  check(a.buildCdPrefix('cmd', 'C:\\repo') === 'cd /d "C:\\repo" && ' && a.buildCdPrefix('cmd', 'C:\\100%') === '' && a.buildCdPrefix('cmd', 'C:\\a"b') === '', 'cmd cd quotes and rejects % and "')
  check(a.buildCdPrefix('posix', "/home/me/it's") === "cd -- '/home/me/it'\\''s' && ", 'posix cd escapes single quotes')
  check(a.buildCdPrefix('powershell', 'relative\\dir') === '' && a.buildCdPrefix('posix', '/tmp/a\nb') === '' && a.buildCdPrefix('other', '/tmp') === '' && a.buildCdPrefix('posix', '/' + 'x'.repeat(1100)) === '', 'relative, control chars, unknown shell and > 1024 build no prefix')
}

function testDecide() {
  const g = load('src/shared/agents.ts')
  check(g.effectiveProvider({ type: 'claude' }) === 'claude' && g.effectiveProvider({ type: 'shell' }, { type: 'codex', command: 'codex' }) === 'codex', 'preset type wins over the pane type')
  check(g.effectiveProvider({ type: 'custom' }, { type: 'custom', command: 'C:\\Tools\\Claude.EXE' }) === 'claude' && g.effectiveProvider({ type: 'custom' }, { type: 'custom', command: 'npx' }) === null, 'custom presets resolve by binary name')
  check(g.effectiveProvider({ type: 'shell', command: 'claude' }) === null, 'a shell pane has no provider even if it runs claude')
  const session = { paneId: 'p', provider: 'claude', sessionId: UUID, spawnCwd: 'C:\\r', activity: 'unknown', updatedAt: 1, available: true }
  const base = { pane: {}, provider: 'claude', hasSetup: false, session, startupUnconsumed: true, policy: 'auto', modalPending: false }
  const d = (patch) => g.decideLaunch({ ...base, ...patch })
  check(d({}) === 'resume', 'auto + available record resumes')
  check(d({ policy: 'off' }) === 'fresh' && d({ policy: 'off', startupUnconsumed: false }) === 'resume', 'off only blocks the startup decision')
  check(d({ intent: 'fresh' }) === 'fresh' && d({ intent: 'resume', provider: null }) === 'resume', 'explicit intents: fresh always, resume even on a shell pane')
  check(d({ intent: 'resume', session: { ...session, available: false } }) === 'fresh' && d({ intent: 'resume', session: undefined }) === 'fresh', 'explicit resume without an available record starts fresh')
  check(d({ session: { ...session, available: 'unknown' } }) === 'resume', "Codex 'unknown' still tries")
  check(d({ session: undefined }) === 'fresh' && d({ session: { ...session, available: false } }) === 'fresh' && d({ session: { ...session, endedAt: 5 } }) === 'fresh', 'no record, unavailable or ended start fresh')
  check(d({ provider: 'codex' }) === 'fresh' && d({ provider: null }) === 'fresh', 'a provider mismatch (shell pane with a Claude record) never auto-resumes')
  check(d({ hasSetup: true }) === 'fresh' && d({ hasSetup: true, intent: 'resume' }) === 'fresh', 'Connection Profiles never resume')
  check(d({ pane: { command: 'npx claude' } }) === 'fresh' && d({ pane: { command: 'claude --model opus' } }) === 'resume', 'overrides must match OVERRIDE_RE')
  const interrupted = { ...session, interrupted: { activity: 'working', trigger: 'quit', at: 1 } }
  check(d({ policy: 'ask', session: interrupted, modalPending: true }) === 'pending' && d({ policy: 'ask', session: interrupted }) === 'resume' && d({ policy: 'ask', session: interrupted, modalPending: true, startupUnconsumed: false }) === 'resume', 'ask: pending only while the dialog is open; ask acts as auto without it')
  check(g.agentRank('action') === 1 && g.agentRank('error') === 1 && g.agentRank('done') === 2 && g.agentRank('working') === 3 && g.agentRank('idle') === 4 && g.agentRank(undefined) === 4, 'agentRank buckets')
  check(g.formatAge(30_000) === '<1 min' && g.formatAge(5 * 60_000) === '5 min' && g.formatAge(2 * 3600_000 + 5) === '2 h' && g.formatAge(3 * DAY) === '3 d' && g.formatAge(-50) === '<1 min', 'formatAge')
  check(g.ENDING_REASONS.has('prompt_input_exit') && g.ENDING_REASONS.has('logout') && !g.ENDING_REASONS.has('other') && !g.ENDING_REASONS.has('clear'), 'only prompt_input_exit and logout end a chat')
}

/** Fake Claude projects tree + Codex sessions tree under tmp. */
function fakeTrees() {
  const claudeDir = path.join(tmp, 'claude'), projects = path.join(claudeDir, 'projects')
  const repo = path.join(tmp, 'work', 'my repo')
  fs.mkdirSync(repo, { recursive: true })
  const T = load('src/main/agents/transcripts.ts')
  const slugDir = path.join(projects, T.claudeSlug(repo))
  fs.mkdirSync(slugDir, { recursive: true })
  fs.writeFileSync(path.join(slugDir, `${UUID}.jsonl`), '{}\n')
  const codexHome = path.join(tmp, 'codex')
  const old = new Date(Date.now() - 90 * DAY)
  const dated = path.join(codexHome, 'sessions', String(old.getFullYear()), String(old.getMonth() + 1).padStart(2, '0'), String(old.getDate()).padStart(2, '0'))
  fs.mkdirSync(dated, { recursive: true })
  fs.writeFileSync(path.join(dated, `rollout-2025-01-01T10-00-00-${UUID2}.jsonl`), '{}\n')
  fs.writeFileSync(path.join(dated, 'notes.txt'), '')
  return { T, claudeDir, projects, repo, slugDir, codexHome }
}

function testTranscripts() {
  const { T, projects, repo, slugDir, codexHome } = fakeTrees()
  check(T.claudeSlug('C:\\Users\\me\\my repo') === 'C--Users-me-my-repo', 'slug: every non alphanumeric becomes -')
  check(T.claudeSlug('C:\\Users\\me\\repo\\') === 'C--Users-me-repo' && T.claudeSlug('/home/me/repo/') === '-home-me-repo' && T.claudeSlug('C:\\') === 'C--' && T.claudeSlug('/') === '-', 'slug: a trailing separator is dropped, a root keeps it')
  check(T.claudeAvailability({ sessionId: UUID, spawnCwd: repo + path.sep }, projects).available === true, 'a pane folder typed with a trailing separator still finds its transcript')
  check(T.claudeAvailability({ sessionId: UUID, spawnCwd: repo }, projects).available === true, 'a seeded record finds its transcript under the slug')
  check(T.claudeAvailability({ sessionId: UUID, spawnCwd: repo, transcriptPath: path.join(slugDir, `${UUID}.jsonl`) }, projects).available === true, 'matching slug and transcript: available')
  const other = path.join(tmp, 'work', 'other')
  fs.mkdirSync(other, { recursive: true })
  const mism = T.claudeAvailability({ sessionId: UUID, spawnCwd: other, transcriptPath: path.join(slugDir, `${UUID}.jsonl`) }, projects)
  check(mism.available === false && mism.reason === 'cwd', 'spawnCwd whose slug is not the transcript folder: cwd')
  const gone = T.claudeAvailability({ sessionId: UUID2, spawnCwd: repo }, projects)
  check(gone.available === false && gone.reason === 'transcript', 'missing .jsonl: transcript')
  const noCwd = T.claudeAvailability({ sessionId: UUID, spawnCwd: path.join(tmp, 'nope'), transcriptPath: path.join(slugDir, `${UUID}.jsonl`) }, projects)
  check(noCwd.available === false && noCwd.reason === 'cwd', 'a launch dir that no longer exists: cwd')
  const idx = new T.CodexRolloutIndex(() => path.join(codexHome, 'sessions'))
  idx.refresh()
  check(idx.has(UUID2) && idx.has(UUID2.toUpperCase()) && !idx.has(UUID) && idx.size === 1, 'the rollout index finds a 90-day-old thread by file name only')
  check(T.codexAvailability({ sessionId: UUID2, spawnCwd: repo }, idx).available === true && T.codexAvailability({ sessionId: UUID, spawnCwd: repo }, idx).available === 'unknown', "codex: indexed = true, absent = 'unknown'")
  check(T.codexAvailability({ sessionId: UUID2, spawnCwd: path.join(tmp, 'nope') }, idx).reason === 'cwd', 'codex with a missing launch dir is not resumable')
  const prevHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
  const P = load('src/main/agents/codexPaths.ts')
  check(P.sessionsRoot() === path.join(codexHome, 'sessions') && P.numericDirsDesc(path.join(codexHome, 'sessions')).length === 1, 'codexPaths honors CODEX_HOME')
  if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome
}

/** AgentSessionStore with fake clock, timers and lookups. */
function storeHarness(opts = {}) {
  const { projects, repo, codexHome } = opts.trees
  const { AgentSessionStore } = load('src/main/agents/AgentSessionStore.ts')
  const { CodexRolloutIndex } = load('src/main/agents/transcripts.ts')
  let clock = opts.clock ?? 10 * DAY, seq = 0
  const timers = new Map(), changed = [], ready = []
  const config = opts.config ?? { workspaces: [{ id: 'w1', cwd: repo, setupId: undefined, panes: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] }, { id: 'w2', cwd: repo, setupId: 'ssh', panes: [{ id: 's1' }] }, { id: 'w3', cwd: repo, panes: [{ id: 's2', setupId: 'ssh' }] }] }
  const store = new AgentSessionStore({
    file: opts.file, getConfig: () => config, spawnCwd: (id) => opts.spawn?.[id] ?? repo,
    codexIndex: new CodexRolloutIndex(() => path.join(codexHome, 'sessions')), projectsDir: () => projects,
    onChanged: (e) => changed.push(e), onReady: (e) => ready.push(e),
    now: () => clock, setTimer: (fn, ms) => { timers.set(++seq, { fn, at: clock + ms }); return seq }, clearTimer: (id) => timers.delete(id),
  })
  const flushTimers = () => { const all = [...timers.values()]; timers.clear(); all.forEach(t => t.fn()) }
  const evt = (paneId, state, cause = {}, extra = {}) => store.onStatus({ paneId, state, precise: true, notify: false, provider: cause.provider ?? 'claude', ...extra }, cause.kind ? { paneId, ptyId: 'x', provider: 'claude', sessionId: UUID, ...cause } : undefined)
  return { store, changed, ready, timers, flushTimers, evt, config, tick: (ms) => { clock += ms }, now: () => clock, read: () => JSON.parse(fs.readFileSync(opts.file, 'utf8')) }
}

function testStore() {
  const trees = fakeTrees()
  const file = path.join(tmp, 'data1', 'agent-sessions.json')
  let h = storeHarness({ trees, file })
  h.store.load()
  check(h.read().cleanExit === false && h.store.startup().trigger === null, 'first run: file written at once with cleanExit=false, no trigger')
  h.evt('p1', 'idle', { kind: 'start', cwd: trees.repo })
  check(h.ready.some(r => r.paneId === 'p1' && r.phase === 'start' && r.sessionId === UUID) && h.ready.some(r => r.phase === 'idle'), 'a start emits agents:ready start, then its first idle')
  h.flushTimers()
  let rec = h.read().sessions.p1
  check(rec && rec.provider === 'claude' && rec.sessionId === UUID && rec.spawnCwd === trees.repo, 'SessionStart records {provider, sessionId, spawnCwd}')
  check(h.changed.at(-1).paneId === 'p1' && h.changed.at(-1).available === true, 'agents:changed carries the available view')
  const n = h.changed.length
  h.tick(1000); h.evt('p1', 'working', { kind: 'working', prompt: 'fix the login\nand more' })
  h.tick(1000); h.evt('p1', 'working', { kind: 'working' })
  check(h.changed.length === n, 'activity, updatedAt and lastPrompt alone do not emit agents:changed')
  h.evt('p1', 'working', { kind: 'working' }, { topic: 'Fix login', firstPrompt: 'fix the login' })
  check(h.changed.length === n + 1 && h.changed.at(-1).topic === 'Fix login', 'a topic change emits')
  check(h.store.list().find(v => v.paneId === 'p1').lastPrompt === 'fix the login' && !('transcriptPath' in h.store.list()[0]), 'lastPrompt keeps the first line; the view never carries the transcript path')
  // Descarte
  h.store.onStatus({ paneId: 'p2', state: 'idle', precise: true, notify: false, provider: 'codex' }, { paneId: 'p2', ptyId: 'x', provider: 'codex', sessionId: 'launch:ab12cd34ef', kind: 'start' })
  h.store.onStatus({ paneId: 'p2', state: 'idle', precise: true, notify: false, provider: 'claude' }, { paneId: 'p2', ptyId: 'x', provider: 'claude', sessionId: 'bad id', kind: 'start' })
  h.evt('s1', 'idle', { kind: 'start' }); h.evt('s2', 'idle', { kind: 'start' })
  check(!h.store.list().some(v => ['p2', 's1', 's2'].includes(v.paneId)), 'launch: ids, invalid ids and SSH panes (own and inherited) are never recorded')
  h.store.onStatus({ paneId: 'p2', state: null, precise: false, notify: false })
  // endedAt by reason
  h.evt('p1', 'idle', { kind: 'end', endReason: 'other' })
  h.evt('p1', 'idle', { kind: 'end', endReason: 'clear' })
  check(!h.store.list().find(v => v.paneId === 'p1').endedAt, 'SessionEnd other / clear do not end the chat')
  h.store.onStatus({ paneId: 'p1', state: null, precise: false, notify: false })
  check(h.store.list().some(v => v.paneId === 'p1'), 'state:null (exit, dispose) never deletes the record')
  h.evt('p1', 'idle', { kind: 'end', endReason: 'prompt_input_exit' })
  check(!!h.store.list().find(v => v.paneId === 'p1').endedAt, 'SessionEnd prompt_input_exit ends it')
  h.evt('p1', 'idle', { kind: 'start' })
  check(!h.store.list().find(v => v.paneId === 'p1').endedAt, 'the next SessionStart clears endedAt')
  h.store.markHibernated('p1')
  h.evt('p1', 'idle', { kind: 'end', endReason: 'logout' })
  check(!h.store.list().find(v => v.paneId === 'p1').endedAt, 'a hibernated record ignores the end that follows its kill')
  h.evt('p1', 'idle', { kind: 'start' })
  h.evt('p3', 'idle', { kind: 'start', provider: 'codex', sessionId: UUID2 }, { provider: 'codex' })
  h.evt('p3', 'working', { kind: 'working', provider: 'codex', sessionId: UUID2 }, { provider: 'codex' })
  check(h.store.list().find(v => v.paneId === 'p3').available === true, 'a Codex thread with a rollout is available')
  // claimed
  h.tick(10); h.evt('p2', 'idle', { kind: 'start' })
  const views = Object.fromEntries(h.store.list().map(v => [v.paneId, v]))
  check(views.p2.available === true && views.p1.available === false && views.p1.unavailableReason === 'claimed', 'two panes on one session: only the most recent stays available')
  let mark = h.changed.length
  h.store.forget('p2')
  check(h.changed[mark].removed === true && h.changed[mark].paneId === 'p2', 'forget emits a removal')
  check(h.changed.slice(mark).some(e => e.paneId === 'p1' && e.available === true), 'forgetting the newer pane releases the claimed one (agents:changed available)')
  h.evt('p2', 'working', { kind: 'working' })
  check(!h.store.list().some(v => v.paneId === 'p2'), 'a late event of the forgotten session does not bring it back')
  h.tick(10); h.evt('p2', 'idle', { kind: 'start' })
  check(h.changed.some(e => e.paneId === 'p1' && e.unavailableReason === 'claimed') && h.store.list().find(v => v.paneId === 'p1').unavailableReason === 'claimed', 'a new start on the same session claims it again')
  mark = h.changed.length
  h.tick(10); h.evt('p2', 'idle', { kind: 'start', sessionId: UUID3 })
  check(h.changed.slice(mark).some(e => e.paneId === 'p1' && e.available === true), 'the claiming pane moving to another session (/clear) releases the old one')
  check(h.store.consumeStartup('p1') === true && h.store.consumeStartup('p1') === false && h.store.consumeStartup('p3') === true, 'consumeStartup is true once per pane per run')
  // Snapshot + frozen
  h.evt('p1', 'working', { kind: 'working' })
  h.evt('p3', 'action', { kind: 'request', provider: 'codex', sessionId: UUID2 }, { provider: 'codex', reason: 'permission' })
  h.store.snapshotExitOnce('quit')
  h.store.snapshotExitOnce('update')
  let disk = h.read()
  check(disk.cleanExit === true && disk.lastExit.trigger === 'quit', 'the snapshot writes cleanExit and the trigger synchronously; a second one is a no-op')
  check(disk.sessions.p1.interrupted.trigger === 'quit' && disk.sessions.p1.interrupted.activity === 'working' && disk.sessions.p3.interrupted.activity === 'action' && disk.sessions.p3.interrupted.reason === 'permission', 'working / action records are marked interrupted')
  h.evt('p1', 'idle', { kind: 'end', endReason: 'prompt_input_exit' })
  h.store.forget('p1')
  h.flushTimers()
  disk = h.read()
  check(!disk.sessions.p1.endedAt && disk.sessions.p1.activity === 'working', 'frozen: a SessionEnd after the snapshot (even prompt_input_exit) and forget change nothing')
  // Next run: quit trigger + interrupted list
  h = storeHarness({ trees, file })
  h.store.load()
  check(h.store.startup().trigger === 'quit' && h.store.startup().interrupted.sort().join() === 'p1,p3', 'next start reports the trigger and the interrupted panes')
  check(h.store.list().every(v => v.activity === 'unknown'), 'nothing is running at startup')
  check(h.read().cleanExit === false, 'the run marks itself not cleanly exited')
  h.evt('p1', 'idle', { kind: 'start' })
  h.store.snapshotExitOnce('shutdown')
  disk = h.read()
  check(disk.lastExit.trigger === 'shutdown' && !disk.sessions.p1.interrupted && disk.sessions.p3.interrupted.trigger === 'quit', 'a pane that restarted and idles loses interrupted; an untouched one keeps it')
  // Crash
  h = storeHarness({ trees, file })
  h.store.load()
  h.evt('p1', 'working', { kind: 'working' })
  h.flushTimers()
  h = storeHarness({ trees, file })
  h.store.load()
  check(h.store.startup().trigger === 'crash' && h.store.startup().interrupted.includes('p1') && h.store.list().find(v => v.paneId === 'p1').interrupted.trigger === 'crash', 'no snapshot (killed process): crash, from the last persisted activity')
  // Update trigger + thaw
  h.store.snapshotExitOnce('update')
  check(h.read().lastExit.trigger === 'update' && h.store.isFrozen, 'update trigger')
  h.store.thaw()
  check(!h.store.isFrozen && h.read().cleanExit === false, 'thaw (macOS new window) resumes recording')
  // Pruning
  const cfg = { workspaces: [{ id: 'w1', cwd: trees.repo, panes: [{ id: 'p3' }] }] }
  h = storeHarness({ trees, file, config: cfg, clock: 10 * DAY + 31 * DAY })
  h.store.load()
  check(h.store.list().length === 0, 'records of deleted panes and older than 30 days are pruned at startup')
  // Corrupt file: seed from lastSession
  fs.writeFileSync(file, '{not json')
  const seedCfg = { workspaces: [
    { id: 'w1', cwd: trees.repo, panes: [{ id: 'p1', lastSession: { provider: 'claude', sessionId: UUID, cwd: trees.repo, at: 5 * DAY } }, { id: 'p2', lastSession: { provider: 'claude', sessionId: 'launch:zz', cwd: trees.repo, at: 1 } }] },
    { id: 'w2', cwd: trees.repo, setupId: 'ssh', panes: [{ id: 's1', lastSession: { provider: 'claude', sessionId: UUID2, cwd: trees.repo, at: 5 * DAY } }] },
  ] }
  h = storeHarness({ trees, file, config: seedCfg })
  h.store.load()
  const seeded = h.store.list()
  check(seeded.length === 1 && seeded[0].paneId === 'p1' && seeded[0].available === true && !seeded[0].interrupted && h.store.startup().trigger === null, 'a corrupt file is rebuilt from pane.lastSession (valid ids, no SSH, availability re-checked, no interrupted)')
  check(h.read().version === 1 && !fs.existsSync(file + '.tmp'), 'the rewrite is atomic (tmp + rename)')
  fs.rmSync(path.join(trees.slugDir, `${UUID}.jsonl`))
  check(h.store.list()[0].available === false && h.store.list()[0].unavailableReason === 'transcript', 'deleting the .jsonl makes it unavailable (transcript)')
  fs.writeFileSync(path.join(trees.slugDir, `${UUID}.jsonl`), '{}\n')
}

function testIpc() {
  const handlers = new Map(), listeners = new Map()
  const electron = { ipcMain: { on: (ch, fn) => listeners.set(ch, fn), handle: (ch, fn) => handlers.set(ch, fn) } }
  const { registerAgentsIpc } = load('src/main/ipc/registerAgentsIpc.ts', { require: m => m === 'electron' ? electron : require(m) })
  const { CH } = load('src/shared/ipc-channels.ts')
  const calls = []
  const store = { list: () => [{ paneId: 'p1' }], startup: () => ({ trigger: 'quit', interrupted: ['p1'] }), consumeStartup: (id) => { calls.push(['consume', id]); return true }, forget: (id) => calls.push(['forget', id]) }
  registerAgentsIpc(store)
  check(CH.AGENTS_LIST === 'agents:list' && CH.AGENTS_STARTUP === 'agents:startup' && CH.AGENTS_CONSUME_STARTUP === 'agents:consumeStartup' && CH.AGENTS_CHANGED === 'agents:changed' && CH.AGENTS_FORGET === 'agents:forget' && CH.AGENTS_READY === 'agents:ready', 'channel names follow the contract')
  check(handlers.get(CH.AGENTS_LIST)()[0].paneId === 'p1' && handlers.get(CH.AGENTS_STARTUP)().trigger === 'quit', 'list and startup answer from the store')
  check(handlers.get(CH.AGENTS_CONSUME_STARTUP)({}, 'p1') === true && handlers.get(CH.AGENTS_CONSUME_STARTUP)({}, 42) === false, 'consumeStartup validates the pane id')
  listeners.get(CH.AGENTS_FORGET)({}, 'p1'); listeners.get(CH.AGENTS_FORGET)({}, { evil: 1 })
  check(calls.filter(c => c[0] === 'forget').length === 1, 'forget ignores a non-string payload')
}

function testCtlSchema() {
  const { parseRemoteClientMsg } = load('src/shared/remote-protocol-schemas.ts')
  const msg = (action) => JSON.stringify({ v: 1, type: 'ctl', id: 'c1', action })
  const base = { kind: 'restartPane', workspaceId: 'w1', paneId: 'p1' }
  check(parseRemoteClientMsg(msg(base)) && parseRemoteClientMsg(msg({ ...base, resume: true })).action.resume === true && parseRemoteClientMsg(msg({ ...base, resume: false })).action.resume === false, 'restartPane with resume true/false or absent (old phones) passes')
  check(parseRemoteClientMsg(msg({ ...base, resume: 'x' })) === null && parseRemoteClientMsg(msg({ ...base, resume: 1 })) === null, 'a non-boolean resume is rejected')
}

async function testRenderer() {
  const sent = { forget: [], consume: new Set(), spawned: [] }
  let onChanged = null, onReady = null
  const timers = new Map(); let seq = 0
  const sessions = [
    { paneId: 'pa', provider: 'claude', sessionId: UUID, spawnCwd: 'C:\\repo', activity: 'unknown', updatedAt: Date.now() - 2 * 3600_000, available: true, interrupted: { activity: 'working', trigger: 'quit', at: 1 } },
    { paneId: 'pb', provider: 'claude', sessionId: UUID2, spawnCwd: 'C:\\gone', activity: 'unknown', updatedAt: 1, available: false, unavailableReason: 'transcript' },
    { paneId: 'pd', provider: 'claude', sessionId: 'dddddddd-1111', spawnCwd: 'C:\\repo', activity: 'unknown', updatedAt: 1, available: true, interrupted: { activity: 'action', trigger: 'quit', at: 1 } },
  ]
  const snApi = {
    platform: 'win32',
    agents: {
      list: async () => sessions, startup: async () => ({ trigger: 'quit', interrupted: ['pa', 'pd'] }),
      consumeStartup: async (id) => { if (sent.consume.has(id)) return false; sent.consume.add(id); return true },
      forget: (id) => sent.forget.push(id), onChanged: (cb) => { onChanged = cb; return () => {} }, onReady: (cb) => { onReady = cb; return () => {} },
    },
    pty: { kill: async () => {} },
    config: { save() {} },
  }
  const r = loadRenderer(`export * as launch from './agentLaunch'; export { useAppStore } from './store'; export { useAgentStore, CLOSED_STACK_MAX } from './agentStore'; export { initRemoteCommands } from './remoteCommands'; export { resolveLaunch } from './launch'`, {
    window: { snApi }, document: { hasFocus: () => false },
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq }, clearTimeout: (id) => timers.delete(id),
  })
  const S = r.useAppStore, A = r.useAgentStore, L = r.launch
  const preset = { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: ['--model', 'opus'], color: '#000', icon: 'claude' }
  S.getState().hydrate({
    version: 11, presets: [preset, { id: 'preset-shell', name: 'Shell', type: 'shell', command: '', args: [], color: '#000', icon: 'terminal' }],
    settings: { ...S.getState().settings, restoreLastWorkspace: true, notifications: { ...S.getState().settings.notifications, hooksEnabled: true }, agents: { ...S.getState().settings.agents, resumeOnStartup: 'auto' } },
    activeWorkspaceId: 'w1',
    workspaces: [
      { id: 'w1', name: 'One', cwd: 'C:\\repo', panes: [{ id: 'pa', type: 'claude', presetId: 'preset-claude', title: 'A', color: '', icon: '' }, { id: 'pb', type: 'claude', presetId: 'preset-claude', title: 'B', color: '', icon: '' }, { id: 'pc', type: 'shell', title: 'C', color: '', icon: '' }], layout: { grid: 4, order: ['pa', 'pb', 'pc'] } },
      { id: 'w2', name: 'Two', cwd: 'C:\\repo', panes: [{ id: 'pd', type: 'claude', presetId: 'preset-claude', title: 'D', color: '', icon: '' }, { id: 'pe', type: 'claude', presetId: 'preset-claude', title: 'E', color: '', icon: '' }], layout: { grid: 2, order: ['pd', 'pe'] } },
      { id: 'w3', name: 'Ssh', cwd: '/srv', setupId: 'conn', panes: [{ id: 'ps', type: 'claude', presetId: 'preset-claude', title: 'S', color: '', icon: '' }] },
    ],
  })
  const ws1 = S.getState().workspaces[0]
  const base = (paneId) => { const ws = S.getState().workspaces.find(w => w.panes.some(p => p.id === paneId)); return r.resolveLaunch(ws.panes.find(p => p.id === paneId), ws, S.getState().presets, S.getState().connections) }
  check(base('pa').initialCommand === 'claude --model opus', 'resolveLaunch builds the preset command through buildAgentArgv')

  await L.mountInterruptedAgents()
  check(JSON.stringify(S.getState().mountedWorkspaces.w2) === '["pd"]' && S.getState().activeWorkspaceId === 'w1', 'auto: an interrupted agent in a workspace never opened is mounted (only that pane) without activating it')

  let launch = await L.prepareAgentLaunch('pa', base('pa'))
  check(launch.initialCommand === `claude --model opus --resume ${UUID}` && launch.cwd === 'C:\\repo', 'startup + auto: resumes in spawnCwd with the preset flags')
  const chip = A.getState().resumeChip.pa
  check(chip.kind === 'resumed' && chip.provider === 'claude', 'the resumed chip is set (React, not xterm)')
  const watch = [...timers.values()].find(t => t.ms === L.RESUME_WATCH_MS)
  check(!!watch, 'a 20 s resume watch is armed when hooks are on')
  watch.fn()
  check(A.getState().resumeChip.pa.kind === 'failed', 'no session start in 20 s: persistent "could not resume" chip')
  onReady({ paneId: 'pa', sessionId: UUID, phase: 'start' })
  check(!A.getState().resumeChip.pa, 'a late start clears the failure chip')

  launch = await L.prepareAgentLaunch('pa', base('pa'))
  check(launch.initialCommand === `claude --model opus --resume ${UUID}`, 'a later restart without intent follows the record (header rule)')

  launch = await L.prepareAgentLaunch('pb', base('pb'))
  check(launch.initialCommand === 'claude --model opus' && A.getState().resumeChip.pb.kind === 'unavailable', 'startup with a gone transcript: fresh + unavailable chip')
  launch = await L.prepareAgentLaunch('pc', base('pc'))
  check(launch.initialCommand === undefined && !A.getState().resumeChip.pc, 'a shell pane without record just spawns')

  // Menu state
  let m = L.resumeMenuState(S.getState(), A.getState().sessions, 'pa')
  check(m.show && m.canResume && m.button === 'resume', 'menu: resumable pane, header button resumes')
  m = L.resumeMenuState(S.getState(), A.getState().sessions, 'pb')
  check(m.show && !m.canResume && m.reason === 'agents.why.transcript' && m.button === 'fresh', 'menu: unavailable is disabled with its reason')
  check(!L.resumeMenuState(S.getState(), A.getState().sessions, 'pc').show && !L.resumeMenuState(S.getState(), A.getState().sessions, 'ps').show, 'menu: shell pane without record and SSH pane hide the entries')
  m = L.resumeMenuState({ ...S.getState(), settings: { ...S.getState().settings, notifications: { ...S.getState().settings.notifications, hooksEnabled: false } } }, A.getState().sessions, 'pa')
  check(!m.canResume && m.reason === 'agents.why.hooks', 'hooks off: "Requires the hooks integration"')
  check(L.resumeMenuState(S.getState(), A.getState().sessions, 'pe').reason === 'agents.why.noRecord', 'agent pane without a record: noRecord')
  m = L.resumeMenuState({ ...S.getState(), settings: { ...S.getState().settings, agents: { ...S.getState().settings.agents, resumeOnStartup: 'off' } } }, A.getState().sessions, 'pa')
  check(m.button === 'fresh' && m.canResume, 'policy off: the header button restarts clean, the menu entry still resumes')
  check(L.paneResumable(ws1.panes[0], ws1, S.getState().presets, A.getState().sessions.pa) && !L.paneResumable(ws1.panes[1], ws1, S.getState().presets, A.getState().sessions.pb) && !L.paneResumable(S.getState().workspaces[2].panes[0], S.getState().workspaces[2], S.getState().presets, A.getState().sessions.pa), 'resumable: agent pane + available record, never SSH')

  // Explicit actions + phone executor
  let cmdHandler = null
  const results = []
  snApi.remote = { onCommand: (cb) => { cmdHandler = cb; return () => {} }, commandResult: (res) => results.push(res) }
  r.initRemoteCommands()
  const epoch = (id) => S.getState().paneEpoch[id] ?? 0
  let e = epoch('pa')
  cmdHandler({ id: 'c1', action: { kind: 'restartPane', workspaceId: 'w1', paneId: 'pa', resume: true } })
  check(results.at(-1).ok && epoch('pa') === e + 1 && A.getState().launchIntent.pa === 'resume', 'phone resume:true restarts with a resume intent')
  launch = await L.prepareAgentLaunch('pa', base('pa'))
  check(launch.initialCommand.endsWith(`--resume ${UUID}`) && !A.getState().launchIntent.pa, 'the intent is consumed by the spawn')
  cmdHandler({ id: 'c2', action: { kind: 'restartPane', workspaceId: 'w1', paneId: 'pa', resume: false } })
  check(sent.forget.includes('pa') && !A.getState().sessions.pa && A.getState().launchIntent.pa === 'fresh', 'phone resume:false forgets the record and restarts fresh')
  launch = await L.prepareAgentLaunch('pa', base('pa'))
  check(launch.initialCommand === 'claude --model opus', 'the fresh restart types the normal command')
  onChanged(sessions[0])
  cmdHandler({ id: 'c3', action: { kind: 'restartPane', workspaceId: 'w1', paneId: 'pa' } })
  check(A.getState().launchIntent.pa === 'resume', 'an old phone without resume follows the header button rule')
  cmdHandler({ id: 'c4', action: { kind: 'restartPane', workspaceId: 'w1', paneId: 'pb', resume: true } })
  launch = await L.prepareAgentLaunch('pb', base('pb'))
  check(launch.initialCommand === 'claude --model opus' && A.getState().resumeChip.pb.kind === 'unavailable', 'resume:true without an available record falls back to a new chat with the chip')
  cmdHandler({ id: 'c4b', action: { kind: 'restartPane', workspaceId: 'w1', paneId: 'pc', resume: true } })
  launch = await L.prepareAgentLaunch('pc', base('pc'))
  check(launch.initialCommand === undefined && !A.getState().resumeChip.pc, 'resume:true on a plain shell without a record just restarts, no "chat unavailable" chip')

  // Closed stack
  cmdHandler({ id: 'c5', action: { kind: 'closePane', workspaceId: 'w1', paneId: 'pb' } })
  check(!S.getState().workspaces[0].panes.some(p => p.id === 'pb') && A.getState().closedStack.at(-1).pane.id === 'pb' && A.getState().closedStack.at(-1).orderIndex === 1, 'a pane closed from the phone goes on the closed stack')
  check(L.reopenClosedConsole() === true, 'reopen restores it')
  const w1 = S.getState().workspaces[0]
  check(w1.layout.order.join() === 'pa,pb,pc' && w1.panes.some(p => p.id === 'pb') && w1.layout.grid === 4, 'same id, same layout.order position, grid recomputed')
  check(A.getState().launchIntent.pb === undefined, 'an unavailable record is not forced to resume on reopen')
  S.getState().closePane('w1', 'pa')
  L.reopenClosedConsole()
  check(A.getState().launchIntent.pa === 'resume' && S.getState().workspaces[0].layout.order[0] === 'pa', 'reopening a pane with an available record resumes it')
  for (let i = 0; i < 11; i++) {
    S.getState().addPane('w2', { type: 'shell' })
    const ws = S.getState().workspaces.find(w => w.id === 'w2')
    S.getState().closePane('w2', ws.panes.at(-1).id)
  }
  check(A.getState().closedStack.length === r.CLOSED_STACK_MAX && r.CLOSED_STACK_MAX === 10, 'with 11 closes the stack keeps the last 10')
  S.getState().closePane('w3', 'ps')
  S.getState().deleteWorkspace('w3')
  const before = A.getState().closedStack.length
  L.reopenClosedConsole()
  check(A.getState().closedStack.length === before - 2 && S.getState().activeWorkspaceId === 'w2', 'an entry of a deleted workspace is dropped and the next one reopens')
  S.getState().clearLastSession('pa')
}

function testI18n() {
  const { en } = load('src/renderer/i18n/en.ts'), { es } = load('src/renderer/i18n/es.ts')
  const keys = Object.keys(en).filter(k => k.startsWith('agents.') || k.startsWith('settings.agents.resume'))
  check(keys.length >= 19 && keys.every(k => typeof es[k] === 'string' && es[k].length > 0 && es[k] !== en[k]), 'every resume string exists and is translated in es and en')
  check(es['agents.why.hooks'] === 'Requiere la integración de hooks (Ajustes > Notificaciones)' && en['agents.chip.resumed'].includes('{age}'), 'the hooks tooltip and the chip text match the PRD')
}

;(async () => {
  try {
    testArgv()
    testDecide()
    testTranscripts()
    testStore()
    testIpc()
    testCtlSchema()
    await testRenderer()
    testI18n()
    console.log(`PASS: ${checks} agent resume checks (argv, truth table, transcripts, session store, IPC, ctl schema, renderer launch, closed stack)`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})().catch((err) => { console.error(err); process.exit(1) })
