// Teams runs (app 2.7.0, E10 B2): TeamService with the fake agent (scripts/fixtures/teams/fake-agent.cjs,
// its scenario as argv[2] through the resolveCli override, decision 61) on a real git repo with an
// isolated config. Covered: start -> starting -> running -> succeeded, the live append of the watched
// run only, stop kills the whole tree and ends cancelled, an exit without close drains, the linger
// kill after the result, maxRunMinutes, the prep CAS when stopped during the prep, Labs off interrupts
// (zero DeadlineTimer keys, also after a status and an account event) and Labs off then on, shutdownSync
// (interrupted, written synchronously), prepareInstall / installAborted, a request while frozen thaws,
// the reaper (interrupted, the stored pid never signalled), the orphan check of decision 64 (G5 holds the
// session, a start-time mismatch is ignored, killOrphan), a 3 MB result line, RunLog ids past the cut,
// the CLI switched off mid-run and a server that never started, the synthetic status (Awake only), the
// run env (no SNAOS_CONSOLE_ID, SNAOS_TEAM_RUN set), the prompt on stdin and never in argv, a resumed
// session, a Codex run (its model priced on a new thread), the session conflict of decision 39,
// TranscriptLocator skipping team sessions, the `team` scope of every commit that moves a TeamView field,
// usageToday on the service clock, runs paging over queuedAt ties, removeTeam's wait (no polling, no log prune),
// terminalOf's clean end (!facts.failure), the grandchildren of stop and linger detached on Windows (only taskkill /T
// reaches them), the Claude Code session vars of a parent session kept out of the run env, and the supervisor never
// signalling a pid after its exit (drain, stop, kill and stop deadlines, shutdownSync; the group only on POSIX).
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data, never a real agent.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), label); checks++ }
const json = (v) => JSON.parse(JSON.stringify(v ?? null))
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
const FIX = path.join(__dirname, 'fixtures', 'teams')
const FAKE = path.join(FIX, 'fake-agent.cjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-runner-'))
const electronStub = { app: { getPath: (name) => (name === 'userData' ? path.join(TMP, 'ud') : TMP), isPackaged: false, commandLine: { hasSwitch: () => false } } }
/** The delay of every real setTimeout the bundled code arms: removeTeam waits with one 12 s timeout and never polls. */
const armed = []
const vmSetTimeout = (fn, ms, ...rest) => {
  armed.push(ms)
  return setTimeout(fn, ms, ...rest)
}
function loadEntry(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (id) => (id === 'electron' ? electronStub : require(id)), console, process, Buffer, URL, setTimeout: vmSetTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, TextEncoder, TextDecoder })
  return mod.exports
}

const M = loadEntry(`
export { TeamService, REMOVE_WAIT_MS } from './src/main/teams/TeamService'
export * from './src/main/teams/flow/runs'
export { RunLog, runDecoder, decodeClaudeStream } from './src/main/teams/RunLog'
export { TeamDefinitionLoader } from './src/main/teams/TeamDefinitionLoader'
export { TranscriptLocator } from './src/main/chat/TranscriptLocator'
export { claudeSlug } from './src/main/agents/transcripts'
export { createGitRunner, gitEnv } from './src/main/git/gitExec'
export * from './src/shared/teams'
export { CHAT_SKIPPED_TEXT } from './src/shared/chat-types'
export { pidAlive, signalTree, treeKillSync } from './src/main/proc/treeKill'
export { RunSupervisor } from './src/main/teams/RunSupervisor'
export { DeadlineTimer } from './src/main/DeadlineTimer'
`)
const WIN = process.platform === 'win32'

const until = async (fn, ms = 15000, label = 'condition') => {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}
const settle = () => new Promise((r) => setTimeout(r, 40))

/** A manual clock and the timer deps of DeadlineTimer on it (deadlines move only on advance). */
function manualClock(start = 1_800_000_000_000) {
  const c = { now: start, timers: new Map(), seq: 0 }
  c.deps = {
    now: () => c.now,
    setTimeout: (fn, ms) => { const id = ++c.seq; c.timers.set(id, { fn, at: c.now + ms }); return id },
    clearTimeout: (id) => c.timers.delete(id),
  }
  c.advance = (ms) => {
    c.now += ms
    for (;;) {
      const due = [...c.timers].filter(([, t]) => t.at <= c.now)
      if (due.length === 0) return
      for (const [id, t] of due) { c.timers.delete(id); t.fn() }
    }
  }
  return c
}

// ---- git ------------------------------------------------------------------------------------------
const gitCfg = path.join(TMP, 'gitconfig')
fs.writeFileSync(gitCfg, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
const gitEnvVars = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitCfg }
for (const k of Object.keys(gitEnvVars)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete gitEnvVars[k]
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, env: gitEnvVars, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const runner = M.createGitRunner({ env: () => M.gitEnv(gitEnvVars) })
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

const killed = []
/** Every service built here: a failed check disposes them all, so no fake agent keeps the suite alive. */
const services = []
/** Kills a pid the test spawned (cleanup). */
function hardKill(pid) {
  if (!pid) return
  try { M.treeKillSync(pid) } catch { /* gone */ }
  try { process.kill(pid) } catch { /* gone */ }
  killed.push(pid)
}

// ---- the world: a service, a repo with a trusted team, the fake CLI and agent ----------------------
async function world(name, o = {}) {
  const dir = path.join(TMP, name)
  const repo = o.repo ?? makeRepo(path.join(dir, 'repo'))
  const data = o.data ?? path.join(dir, 'data')
  const clock = o.clock ?? manualClock()
  const w = {
    dir, repo, data, clock, logs: [], emitted: [], awake: [], appended: [], revoked: [], spawned: 0, signalled: [],
    scenario: path.join(FIX, 'claude-simple.json'), cliReady: true, holders: new Map(), accounts: null,
    procStart: o.procStart ?? (async () => null),
  }
  const shim = path.join(dir, 'bin', process.platform === 'win32' ? 'snaos.cmd' : 'snaos')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, '')
  w.shim = shim
  w.cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '' }, workspaces: o.workspaces ?? [] }
  w.svc = new M.TeamService({
    dataDir: () => data,
    config: () => w.cfg,
    git: runner,
    emit: (e) => w.emitted.push(json(e)),
    openPath: async () => '',
    log: (l) => w.logs.push(l),
    now: () => clock.now,
    timerDeps: clock.deps,
    loader: new M.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) }),
    strict: true,
    status: { snapshot: () => [], stateOf: () => null, paneForSession: () => null },
    sessionHolder: (_p, s) => w.holders.get(s) ?? null,
    accounts: () => w.accounts,
    cli: {
      envForTeam: (runId) => (w.cliReady ? { SNAOS_CTL_ENDPOINT: 'test-pipe', SNAOS_CTL_TOKEN: `tok-${runId}`, SNAOS_CLI: shim, SNAOS_TEAM_RUN: runId } : {}),
      revokeTeam: (runId) => w.revoked.push(runId),
      ready: () => w.cliReady,
    },
    awake: (e) => w.awake.push(json(e)),
    sendRun: (e) => w.appended.push(json(e)),
    spawn: (...a) => { w.spawned++; return cp.spawn(...a) },
    resolveCli: () => ({ file: process.execPath, args: [FAKE, w.scenario], kind: 'exe' }),
    procStartTime: (pid) => w.procStart(pid),
    // The real tree kill, recording every pid it is handed (the supervisor never hands it a reaped pid).
    treeKill: { sync: (pid) => { w.signalled.push(pid); return M.treeKillSync(pid) }, signal: (pid, sig) => { w.signalled.push(pid); return M.signalTree(pid, sig) }, alive: (pid) => (o.alive ? o.alive(pid) : M.pidAlive(pid)) },
    platform: process.platform,
  })
  services.push(w.svc)
  await w.svc.start(w.cfg)
  if (!o.noTeam) {
    const probe = await w.svc.request({ op: 'setupProbe', dir: repo }, 'desktop')
    const draft = { ...probe.probe.defaults, goal: 'Una app de notas', verify: '' }
    draft.roles = draft.roles.map((r) => (r.id === 'research' ? { ...r, provider: 'codex', model: o.codexModel, effort: undefined } : r))
    const prev = await w.svc.request({ op: 'setupPreview', repoRoot: repo, draft }, 'desktop')
    const wr = await w.svc.request({ op: 'setupWrite', repoRoot: repo, draft, previewHash: prev.preview.hash }, 'desktop')
    assert.ok(wr.ok, `setup ${name}: ${JSON.stringify(wr)}`)
    w.teamId = wr.teamId
  } else w.teamId = M.TEAM_ID_RE.test(o.teamId ?? '') ? o.teamId : undefined
  w.rt = () => w.svc.team(w.teamId).store.rt
  w.ring = () => w.svc.team(w.teamId).store.recentRuns()
  w.ended = (id) => w.ring().find((r) => r.id === id)
  w.active = (id) => w.rt().activeRuns.find((r) => r.id === id)
  w.runNow = (agentId, prompt) => w.svc.request({ op: 'runNow', teamId: w.teamId, agentId, ...(prompt ? { prompt } : {}) }, 'desktop')
  w.use = (file) => {
    if (typeof file === 'object') {
      const p = path.join(dir, `scenario-${Math.random().toString(16).slice(2)}.json`)
      fs.writeFileSync(p, JSON.stringify(file))
      w.scenario = p
    } else w.scenario = path.join(FIX, file)
  }
  w.logFile = (id) => path.join(data, 'teams', w.teamId, 'runs', `${id}.jsonl`)
  w.logLines = (id) => (fs.existsSync(w.logFile(id)) ? fs.readFileSync(w.logFile(id), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }) : [])
  w.waitEnded = (id, label) => until(() => !!w.ended(id), 20000, label ?? `run ${id} ended`)
  w.waitState = (id, state) => until(() => w.active(id)?.state === state || (!!w.ended(id) && state === 'ended'), 20000, `run ${id} ${state}`)
  return w
}

// ---- 1. a run end to end, watched append, synthetic status, env, stdin, argv -----------------------
async function lifecycleChecks() {
  const w = await world('life', { codexModel: 'gpt-5.5' })
  check(w.svc.liveRunCount() === 0 && w.svc.syntheticStatuses().length === 0, 'no live run at first')
  const roster = await w.svc.request({ op: 'roster', teamId: w.teamId }, 'desktop')
  check(roster.ok && roster.agents.length === 5 && roster.agents.every((a) => a.status === 'idle' && !a.run), 'roster: five idle agents')
  check(roster.agents.find((a) => a.id === 'dev-2')?.roleName === 'Dev' && roster.agents.find((a) => a.id === 'dev-2')?.index === 2 && roster.agents.find((a) => a.id === 'dev')?.permission === 'total', 'roster: the role, the index and the permission of each agent')

  // The prompt goes to stdin only, the env carries the team run and never a console id.
  process.env.SNAOS_CONSOLE_ID = 'pane-of-the-parent'
  process.env.SNAOS_PTY_ID = 'pty-of-the-parent'
  // The app started from inside a Claude Code session: none of that session reaches a run, the user's configuration does.
  const parentSession = { CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\parent-claude', CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_EXECPATH: path.join(w.dir, 'parent', 'claude'), CLAUDE_CODE_TMPDIR: path.join(w.dir, 'parent', 'tmp'), CLAUDE_CODE_PLUGIN_DIRS: path.join(w.dir, 'parent', 'plugins'), CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CLAUDE_EFFORT: 'high', CLAUDE_PID: '4242' }
  const userConfig = { CLAUDE_CONFIG_DIR: path.join(w.dir, 'claude-config'), CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://proxy.example' }
  const savedEnv = Object.fromEntries([...Object.keys(parentSession), ...Object.keys(userConfig)].map((k) => [k, process.env[k]]))
  Object.assign(process.env, parentSession, userConfig)
  const stdinFile = path.join(w.dir, 'stdin.txt')
  w.use({ saveStdin: stdinFile, steps: [{ echoArgv: true }, { echoEnv: ['SNAOS_TEAM_RUN', 'SNAOS_CONSOLE_ID', 'SNAOS_PTY_ID', 'SNAOS_WORKSPACE_ID', 'SNAOS_CTL_TOKEN', 'PATH', ...Object.keys(savedEnv)] }, { fixture: 'claude-simple.jsonl', rewriteSession: true, delayMs: 60 }] })
  const secret = 'Revis\u00E1 el login "con comillas" & ampersand'
  const r = await w.runNow('dev', secret)
  check(r.ok && M.RUN_ID_RE.test(r.runId), 'runNow admits a run and answers its id')
  const id = r.runId
  check(w.rt().activeRuns.some((x) => x.id === id && x.state === 'queued') || !!w.active(id), 'born queued at admission (decision 17)')
  same(await w.svc.request({ op: 'watchRun', teamId: w.teamId, runId: id }, 'desktop'), { ok: true }, 'watchRun answers ok')
  await w.waitState(id, 'running')
  const live = w.active(id)
  check(live && live.pid > 0 && live.startedAt === w.clock.now && live.reachedRunning, 'starting then running: pid, startedAt, reachedRunning')
  check(w.svc.liveRunCount() === 1, 'liveRunCount counts it (the close confirm)')
  const syn = w.svc.syntheticStatuses()
  check(syn.length === 1 && syn[0].paneId === M.teamPaneId(id) && syn[0].state === 'working' && syn[0].provider === 'claude' && syn[0].precise === true && syn[0].notify === false, 'syntheticStatuses: a working Claude status per live run (AccountService)')
  check(w.awake.some((e) => e.paneId === M.teamPaneId(id) && e.state === 'working' && e.provider === 'claude'), 'the synthetic status reached Awake at start')
  await w.waitEnded(id)
  const done = w.ended(id)
  check(done.state === 'succeeded' && done.outcome !== 'failed' && done.summary === 'OK', 'succeeded with the result text as its summary')
  check(done.usage && done.usage.estimated === true && done.usage.inputTokens >= 0, 'usage recorded (estimated)')
  check(w.awake.some((e) => e.paneId === M.teamPaneId(id) && e.state === null), 'the synthetic status cleared at the end')
  check(w.awake.every((e) => M.isTeamPaneId(e.paneId)), 'Awake gets only team panes; nothing went through a StatusManager')
  check(w.revoked.includes(id), 'the team token revoked at the end')
  check(!fs.existsSync(path.join(w.data, 'teams', w.teamId, 'runs', `${id}.system.md`)), 'the system file deleted at the end')
  check(w.rt().agents.find((a) => a.id === 'dev').status === 'idle' && !w.rt().agents.find((a) => a.id === 'dev').runId, 'the agent is idle again')
  const sess = w.rt().agents.find((a) => a.id === 'dev').sessions.free
  check(sess && sess.sessionId === done.sessionId && sess.turns === 1 && /^[0-9a-f]{64}$/.test(sess.sysHash) && sess.cwd === w.repo, 'the session recorded at running: id, one turn, sysHash, cwd')

  const stdin = fs.readFileSync(stdinFile, 'utf8')
  const lines = w.logLines(id)
  const argvLine = lines.find((l) => l && l.type === 'fake.argv')
  const envLine = lines.find((l) => l && l.type === 'fake.env')
  check(stdin.includes(secret) && stdin.includes('<request from="user">'), 'the request reached stdin, wrapped as <request>')
  check(stdin.includes('do not commit, do not create or switch branches, and leave your changes uncommitted for the user to review'), 'a free run of a writing role: no commit and no branch on the user checkout')
  check(argvLine && !JSON.stringify(argvLine.argv).includes('Revis') && argvLine.argv.includes('--session-id') && argvLine.argv.includes('--append-system-prompt-file') && argvLine.argv.includes('--setting-sources') && argvLine.argv.includes('bypassPermissions'), 'argv: no user text; session id, system file, isolation flags, the total profile')
  check(argvLine.cwd === w.repo || path.resolve(argvLine.cwd) === path.resolve(w.repo), 'a free run works in the repo root')
  check(envLine && envLine.env.SNAOS_TEAM_RUN === id && envLine.env.SNAOS_CONSOLE_ID === null && envLine.env.SNAOS_PTY_ID === null && envLine.env.SNAOS_WORKSPACE_ID === null && envLine.env.SNAOS_CTL_TOKEN === true, 'env: SNAOS_TEAM_RUN, the token (presence only), no console, pty or workspace id (decision 16)')
  check(envLine.env.PATH.split(path.delimiter)[0] === path.dirname(w.shim), 'env: the CLI shim folder first in PATH')
  check(Object.keys(parentSession).every((k) => envLine.env[k] === (/TOKEN/.test(k) ? false : null)), 'env: no Claude Code session var of a parent session (socket, token, pid, tmp dir, plugin dirs...)')
  check(Object.entries(userConfig).every(([k, v]) => envLine.env[k] === v), 'env: the user Claude configuration stays (CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_*)')
  check(lines[0].type === 'snaos.prompt' && lines[0].mode === 'free' && lines[0].trigger === 'manual' && lines[0].text.includes(secret), 'log line 1: the prompt')
  delete process.env.SNAOS_CONSOLE_ID
  delete process.env.SNAOS_PTY_ID
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  // Watched run: its lines were pushed (never a teamChanged per line); the end pushed its state.
  const mine = w.appended.filter((e) => e.runId === id)
  check(mine.some((e) => e.items.some((m) => m.role === 'assistant')) && mine.every((e) => e.teamId === w.teamId), 'teams:runAppend pushed the watched run lines')
  check(mine.some((e) => e.state === 'succeeded'), 'and its terminal state')
  const page = await w.svc.request({ op: 'runPage', teamId: w.teamId, runId: id }, 'desktop')
  check(page.ok && page.items[0].role === 'user' && page.items.some((m) => m.role === 'assistant') && page.live === false && page.run.state === 'succeeded', 'runPage of an ended run: the prompt first, then the chat, from the file')
  const runs = await w.svc.request({ op: 'runs', teamId: w.teamId, agentId: 'dev' }, 'desktop')
  check(runs.ok && runs.runs.length === 1 && runs.runs[0].id === id && runs.cursor === null, 'runs: the agent runs, newest first')
  const roster2 = await w.svc.request({ op: 'roster', teamId: w.teamId }, 'desktop')
  check(roster2.agents.find((a) => a.id === 'dev').lastRun?.id === id, 'roster: lastRun')

  // Resume: the same session, --resume, the same system hash.
  w.use({ steps: [{ echoArgv: true }, { fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  const r2 = await w.runNow('dev')
  await w.waitEnded(r2.runId)
  const again = w.ended(r2.runId)
  const argv2 = w.logLines(r2.runId).find((l) => l && l.type === 'fake.argv')
  check(again.resumed === true && again.sessionId === done.sessionId && argv2.argv.includes('--resume') && argv2.argv.includes(done.sessionId), 'the next free run resumes the same session (--resume)')
  check(w.rt().agents.find((a) => a.id === 'dev').sessions.free.turns === 2, 'turns + 1')

  // Another run, not watched: nothing appended for it.
  w.use('claude-simple.json')
  await w.svc.request({ op: 'watchRun', teamId: w.teamId, runId: id }, 'desktop')
  const before = w.appended.length
  const r3 = await w.runNow('dev-2')
  await w.waitEnded(r3.runId)
  check(w.appended.slice(before).every((e) => e.runId !== r3.runId), 'a run that is not watched gets no teams:runAppend')
  same(await w.svc.request({ op: 'watchRun', teamId: w.teamId, runId: null }, 'desktop'), { ok: true }, 'watchRun null stops it')

  // Codex: thread id learned from thread.started, readonly block channel, instructions block on stdin.
  const cStdin = path.join(w.dir, 'codex-stdin.txt')
  w.use({ saveStdin: cStdin, steps: [{ echoArgv: true }, { fixture: 'codex-simple.jsonl' }] })
  const r4 = await w.runNow('research', 'Busc\u00E1 el bug')
  await w.waitEnded(r4.runId)
  const cx = w.ended(r4.runId)
  const cArgv = w.logLines(r4.runId).find((l) => l && l.type === 'fake.argv')
  check(cx.state === 'succeeded' && cx.provider === 'codex' && cx.sessionId === '01a16976-a319-7192-961e-2c0dabde59b3', 'Codex: succeeded; the thread id from thread.started')
  check(!cx.resumed && cx.model === 'gpt-5.5' && cx.usage?.model === 'gpt-5.5' && cx.usage.basis === 'absolute', 'Codex new thread: the run model reaches the parser base (codexCost prices it; exec --json names none)')
  check(w.rt().agents.find((a) => a.id === 'research').sessions.free.sessionId === cx.sessionId, 'Codex: the thread recorded as the session')
  check(cArgv.argv[0] === 'exec' && cArgv.argv.includes('read-only') && cArgv.argv.includes('--skip-git-repo-check') && !cArgv.argv.includes('Busc'), 'Codex readonly argv: exec, read-only sandbox, no user text')
  const cs = fs.readFileSync(cStdin, 'utf8')
  check(cs.startsWith('<team-instructions>') && cs.includes('snaos-team') && cs.includes('Busc\u00E1 el bug'), 'Codex new thread: the instructions block, the block channel and the request on stdin')
  check(w.awake.some((e) => e.paneId === M.teamPaneId(r4.runId) && e.provider === 'codex'), 'a Codex synthetic status says codex (AccountService counts only Claude)')

  // A Lead run: lead mode, its contract on stdin, its own session key.
  const lStdin = path.join(w.dir, 'lead-stdin.txt')
  w.use({ saveStdin: lStdin, steps: [{ fixture: 'claude-simple.jsonl', rewriteSession: true }] })
  const r5 = await w.runNow('lead', 'Armá las tareas del sync')
  await w.waitEnded(r5.runId)
  const leadRun = w.ended(r5.runId)
  const ls = fs.readFileSync(lStdin, 'utf8')
  check(leadRun.mode === 'lead' && leadRun.sessionKey === 'lead' && leadRun.profile === 'readonly' && leadRun.state === 'succeeded', 'the Lead runs in lead mode, readonly, on its lead session')
  check(ls.includes('You are the Lead') && ls.includes('<request from="user">\nArmá las tareas del sync\n</request>'), 'lead stdin: the lead contract and the request')
  check(w.rt().goalSeenHash === w.svc.trusted(w.teamId).goalHash, 'a lead run records the goal it saw')

  // ownsSession hides a team transcript (the Lead's, in the repo root slug folder) from the console folder match.
  const sid = leadRun.sessionId
  check(w.svc.ownsSession(sid) && !w.svc.ownsSession('11111111-2222-4333-8444-555555555555'), 'ownsSession: the team session, not another')
  const claudeRoot = path.join(w.dir, 'claude')
  const slugDir = path.join(claudeRoot, 'projects', M.claudeSlug(w.repo))
  fs.mkdirSync(slugDir, { recursive: true })
  const spawnedAt = Date.now() - 2000
  fs.writeFileSync(path.join(slugDir, `${sid}.jsonl`), '{"type":"user"}\n')
  const cfg = { settings: {}, workspaces: [{ id: 'w1', name: 'W', cwd: w.repo, panes: [{ id: 'p1', type: 'claude', title: 'c', color: '', icon: '' }] }] }
  const locDeps = { claudeRoot: () => claudeRoot, codexSessions: () => path.join(w.dir, 'codex'), config: () => cfg, status: () => null, spawnCwd: () => w.repo, spawnedAt: () => spawnedAt, runningPanes: () => ['p1'], claims: () => new Map() }
  const plain = await new M.TranscriptLocator(locDeps).locate('p1')
  check(plain.ok === true, 'without the dep the console would pick the team transcript')
  const guarded = await new M.TranscriptLocator({ ...locDeps, teamSession: (s) => w.svc.ownsSession(s) }).locate('p1')
  check(guarded.ok === false, 'with teamSession the team transcript is never a console transcript')

  w.svc.dispose()
}

// ---- 2. stop, linger, drain, maxRunMinutes, prep CAS, session conflict, CLI off ----------------------
async function stopChecks() {
  const w = await world('stop')
  // Stop kills the whole tree (a grandchild too) and ends cancelled. On Windows the grandchild is detached: out of the
  // agent's kill-on-close job only taskkill /T reaches it (POSIX keeps it in the agent's group, which the stop signals).
  w.use({ steps: [{ fixture: 'claude-simple.jsonl', to: 6, rewriteSession: true }, { spawnChild: { detached: WIN, ms: 120000 } }, { hang: true }] })
  const r = await w.runNow('dev')
  await w.waitState(r.runId, 'running')
  let child = 0
  await until(() => { const l = w.logLines(r.runId).find((x) => x && x.type === 'fake.child'); child = l ? l.pid : 0; return child > 0 }, 15000, 'grandchild pid')
  const parent = w.active(r.runId).pid
  check(M.pidAlive(parent) && M.pidAlive(child), 'agent and grandchild alive')
  same(await w.svc.request({ op: 'stop', teamId: w.teamId, runId: r.runId }, 'desktop'), { ok: true }, 'stop answers ok')
  check(w.active(r.runId)?.state === 'stopping' || !!w.ended(r.runId), 'stopping at once')
  same(await w.svc.request({ op: 'stop', teamId: w.teamId, runId: r.runId }, 'desktop'), { ok: true }, 'a second stop is idempotent')
  await w.waitEnded(r.runId)
  check(w.ended(r.runId).state === 'cancelled' && w.ended(r.runId).stopReason === 'user', 'Frenar ends it cancelled')
  await until(() => !M.pidAlive(child) && !M.pidAlive(parent), 10000, 'tree dead')
  check(!M.pidAlive(child) && !M.pidAlive(parent), 'the whole tree is dead (grandchild included)')

  // Linger: a result, then something keeps running: tree-killed LINGER_MS later, still succeeded (the scenario is
  // inline because the grandchild is detached only on Windows, as above).
  w.use({ steps: [{ fixture: 'claude-simple.jsonl', rewriteSession: true }, { spawnChild: { detached: WIN, ms: 120000 } }, { hang: true }] })
  const l = await w.runNow('dev')
  let lchild = 0
  await until(() => { const x = w.logLines(l.runId).find((y) => y && y.type === 'fake.child'); lchild = x ? x.pid : 0; return lchild > 0 }, 15000, 'linger child')
  await settle()
  check(!w.ended(l.runId), 'still alive after the result (linger not due yet)')
  w.clock.advance(M.LINGER_MS)
  await w.waitEnded(l.runId)
  check(w.ended(l.runId).state === 'succeeded' && w.ended(l.runId).resultSeen, 'linger kill after the result: succeeded')
  await until(() => !M.pidAlive(lchild), 10000, 'linger child dead')
  check(w.logs.some((x) => x.includes(`${l.runId} linger kill`)), 'logged')

  // Exit without close: the parent exits while a grandchild holds stdout; drained DRAIN_MS later.
  w.use('exit-without-close.json')
  const e = await w.runNow('dev')
  await until(() => !!w.active(e.runId)?.pid, 15000, 'drain pid')
  const epid = w.active(e.runId).pid
  let echild = 0
  await until(() => { const x = w.logLines(e.runId).find((y) => y && y.type === 'fake.child'); echild = x ? x.pid : 0; return echild > 0 }, 15000, 'drain child')
  await until(() => !M.pidAlive(epid), 15000, 'parent exit')
  // The exit event marks the run not alive in the supervisor and arms its drain key in the same handler.
  await until(() => !w.svc.supervisor.isAlive(e.runId), 15000, 'exit event')
  check(!w.ended(e.runId), 'exit without close: not finalized yet')
  w.clock.advance(M.DRAIN_MS)
  await w.waitEnded(e.runId)
  check(w.ended(e.runId).state === 'succeeded', 'drained and finalized from the facts (result seen)')
  check(!w.signalled.includes(epid), 'the drain never hands the reaped pid to the tree kill (pid reuse)')
  check(WIN ? w.logs.some((x) => x.includes(`${e.runId} drain after exit: pid ${epid} not signalled`)) : true, 'win32: the drain logs the pid it left alone')
  hardKill(echild)

  // maxRunMinutes stops a hanging run (failed, timeout).
  w.use('hang.json')
  const h = await w.runNow('dev')
  await w.waitState(h.runId, 'running')
  w.clock.advance(w.svc.trusted(w.teamId).def.maxRunMinutes * 60_000)
  await w.waitEnded(h.runId)
  check(w.ended(h.runId).state === 'failed' && w.ended(h.runId).failure?.code === 'timeout' && w.ended(h.runId).stopReason === 'timeout', 'maxRunMinutes: failed {unknown, timeout}')

  // Prep CAS: stopped while the prep awaits: nothing spawns.
  const spawned = w.spawned
  const p = await w.runNow('dev')
  same(await w.svc.request({ op: 'stop', teamId: w.teamId, runId: p.runId }, 'desktop'), { ok: true }, 'stop during the prep')
  check(w.ended(p.runId)?.state === 'cancelled' && w.ended(p.runId).pid === undefined, 'a queued run stops at once: cancelled, no pid')
  await settle()
  await settle()
  check(w.spawned === spawned && !w.active(p.runId), 'the prep CAS failed: no process spawned')

  // Session conflict (decision 39): a console opens the run's session: interrupted, with a card.
  w.use('hang.json')
  const s = await w.runNow('dev')
  await w.waitState(s.runId, 'running')
  const sid = w.active(s.runId).sessionId
  w.svc.onPaneStatus({ paneId: 'pane-x', state: 'working', precise: true, notify: false, provider: 'claude', sessionId: sid })
  check(w.active(s.runId)?.state === 'stopping', 'a console with the run session: the run stops')
  await w.waitEnded(s.runId)
  check(w.ended(s.runId).state === 'interrupted' && w.ended(s.runId).interruptCause === 'sessionConflict', 'interrupted {sessionConflict}, not counted')
  check(w.rt().cards.some((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'sessionConflict'), 'a sessionConflict card')

  // CLI off mid-run: interrupted {cliOff}; a server that never started: deferred cliOff.
  w.use('hang.json')
  const c = await w.runNow('dev')
  await w.waitState(c.runId, 'running')
  w.cliReady = false
  w.svc.onCliState()
  await w.waitEnded(c.runId)
  check(w.ended(c.runId).state === 'interrupted' && w.ended(c.runId).interruptCause === 'cliOff', 'CLI switched off mid-run: interrupted {cliOff}')
  same(await w.runNow('dev'), { ok: false, error: 'deferred', defer: { reason: 'cliOff' } }, 'a server that never started: runNow deferred cliOff')
  w.cliReady = true

  // Gates of a manual run: a busy agent, a paused agent, a team pause, a quota.
  w.use('hang.json')
  const g = await w.runNow('dev')
  await w.waitState(g.runId, 'running')
  same(await w.runNow('dev'), { ok: false, error: 'deferred', defer: { reason: 'running' } }, 'a running agent: deferred running')
  same(await w.svc.request({ op: 'pauseAgent', teamId: w.teamId, agentId: 'dev-2', on: true }, 'desktop'), { ok: true }, 'pauseAgent')
  same(await w.runNow('dev-2'), { ok: false, error: 'deferred', defer: { reason: 'agentPaused' } }, 'a paused agent: deferred agentPaused')
  await w.svc.request({ op: 'pauseAgent', teamId: w.teamId, agentId: 'dev-2', on: false }, 'desktop')
  check(w.active(g.runId)?.state === 'running', 'pausing an agent never stops its run (decision 22)')
  await w.svc.request({ op: 'stop', teamId: w.teamId, runId: g.runId }, 'desktop')
  await w.waitEnded(g.runId)
  await w.svc.request({ op: 'settings', teamId: w.teamId, patch: { paused: true } }, 'desktop')
  same(await w.runNow('dev'), { ok: false, error: 'deferred', defer: { reason: 'paused' } }, 'a paused team: deferred paused')
  await w.svc.request({ op: 'settings', teamId: w.teamId, patch: { paused: false } }, 'desktop')
  same(await w.svc.request({ op: 'runNow', teamId: w.teamId, agentId: 'dev', taskId: 't-1' }, 'desktop'), { ok: false, error: 'unsupported' }, 'a task run waits for B4')
  same(await w.svc.request({ op: 'runNow', teamId: w.teamId, agentId: 'nobody' }, 'desktop'), { ok: false, error: 'not_found' }, 'an unknown agent')
  w.svc.dispose()
}

// ---- 3. Labs off, shutdownSync, install, thaw -----------------------------------------------------
async function lifecycleExitChecks() {
  const w = await world('exit')
  // Labs off interrupts a live run: killed, interrupted {labsOff}, zero keys, also after status and account events.
  w.use('hang.json')
  const r = await w.runNow('dev')
  await w.waitState(r.runId, 'running')
  const pid = w.active(r.runId).pid
  const ringFile = path.join(w.data, 'teams', w.teamId, 'runs.json')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  check(w.svc.pendingTimers === 0 && w.clock.timers.size === 0, 'Labs off: zero DeadlineTimer keys and no platform timer')
  w.svc.onPaneStatus({ paneId: 'p', state: 'working', precise: true, notify: false, provider: 'claude', sessionId: 'x' })
  w.svc.onAccounts()
  w.svc.onCliState()
  check(w.svc.pendingTimers === 0 && w.clock.timers.size === 0, 'still zero keys after a status, an account and a CLI event')
  const runsOff = JSON.parse(fs.readFileSync(ringFile, 'utf8')).runs.find((x) => x.id === r.runId)
  check(runsOff && runsOff.state === 'interrupted' && runsOff.interruptCause === 'labsOff', 'Labs off: the run interrupted {labsOff}, written at once')
  await until(() => !M.pidAlive(pid), 10000, 'labs off kill')
  same(await w.svc.request({ op: 'list' }, 'desktop'), { ok: false, error: 'disabled' }, 'Labs off: disabled')
  check(w.awake.some((e) => e.paneId === M.teamPaneId(r.runId) && e.state === null), 'Labs off: synthetic status cleared')

  // Labs on again: the same timer works (a commit arms the flush, maxRunMinutes stops a new run).
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(async () => (await w.svc.request({ op: 'list' }, 'desktop')).ok, 10000, 'enabled again')
  check(w.ring().some((x) => x.id === r.runId && x.state === 'interrupted'), 'the ring kept the interrupted run across Labs off and on')
  const h = await w.runNow('dev')
  check(h.ok && w.clock.timers.size > 0, 'after Labs on: a commit arms a deadline again')
  await w.waitState(h.runId, 'running')
  w.clock.advance(250)
  const state = JSON.parse(fs.readFileSync(path.join(w.data, 'teams', w.teamId, 'state.json'), 'utf8'))
  check(state.activeRuns.some((x) => x.id === h.runId), 'the debounced flush wrote the live run')
  w.clock.advance(w.svc.trusted(w.teamId).def.maxRunMinutes * 60_000)
  await w.waitEnded(h.runId)
  check(w.ended(h.runId).failure?.code === 'timeout', 'after Labs on: maxRunMinutes still stops a run')

  // shutdownSync: interrupted {shutdown}, the process killed, both files written synchronously, frozen.
  const s = await w.runNow('dev')
  await w.waitState(s.runId, 'running')
  const spid = w.active(s.runId).pid
  w.svc.shutdownSync('quit')
  const runsQuit = JSON.parse(fs.readFileSync(ringFile, 'utf8')).runs.find((x) => x.id === s.runId)
  const stQuit = JSON.parse(fs.readFileSync(path.join(w.data, 'teams', w.teamId, 'state.json'), 'utf8'))
  check(runsQuit && runsQuit.state === 'interrupted' && runsQuit.interruptCause === 'shutdown' && stQuit.activeRuns.length === 0, 'shutdownSync: interrupted {shutdown} in runs.json, no active run in state.json, synchronously')
  check(stQuit.agents.find((a) => a.id === 'dev').status === 'idle', 'the agent written idle')
  check(w.revoked.includes(s.runId) && w.svc.pendingTimers === 0, 'token revoked, zero keys')
  await until(() => !M.pidAlive(spid), 10000, 'shutdown kill')
  check(!M.pidAlive(spid), 'the process tree killed')
  w.svc.shutdownSync('quit')
  check(true, 'shutdownSync is idempotent')

  // A request while frozen and not quitting thaws (a cancelled Windows session end).
  const thawed = await w.svc.request({ op: 'list' }, 'desktop')
  check(thawed.ok && thawed.teams.length === 1, 'a request while frozen and not quitting thaws and answers')

  // prepareInstall: interrupted and flushed, not frozen; runs defer disabled until installAborted.
  const i = await w.runNow('dev')
  await w.waitState(i.runId, 'running')
  w.svc.prepareInstall()
  check(w.ended(i.runId)?.state === 'interrupted', 'prepareInstall interrupts the live run')
  same(await w.runNow('dev'), { ok: false, error: 'deferred', defer: { reason: 'disabled' } }, 'while installing: deferred disabled')
  check((await w.svc.request({ op: 'list' }, 'desktop')).ok, 'not frozen: reads still answer')
  w.svc.installAborted()
  w.use('claude-simple.json')
  const after = await w.runNow('dev')
  check(after.ok, 'installAborted: runs start again')
  await w.waitEnded(after.runId)

  // markQuitting: shutdownSync then a request answers disabled (never thaws again).
  w.svc.markQuitting()
  w.svc.shutdownSync('quit')
  same(await w.svc.request({ op: 'list' }, 'desktop'), { ok: false, error: 'disabled' }, 'quitting: no thaw')
  w.svc.dispose()
}

// ---- 4. reaper and orphans (decision 64) ----------------------------------------------------------
async function reaperChecks() {
  // First life: two hanging runs, state written; the app "crashes" (the service is dropped, children live on).
  const w1 = await world('reap', { clock: manualClock() })
  w1.use('hang.json')
  const a = await w1.runNow('dev')
  const b = await w1.runNow('dev-2')
  await w1.waitState(a.runId, 'running')
  await w1.waitState(b.runId, 'running')
  w1.svc.team(w1.teamId).store.flushSync()
  const runA = json(w1.active(a.runId))
  const runB = json(w1.active(b.runId))
  check(M.pidAlive(runA.pid) && M.pidAlive(runB.pid), 'two live agent processes of the first life')

  // Second life on the same data: A's start time matches (an orphan), B's does not (a reused pid: ignored).
  const w2 = await world('reap', { repo: w1.repo, data: w1.data, clock: manualClock(w1.clock.now + 60_000), noTeam: true, teamId: w1.teamId, procStart: async (pid) => (pid === runA.pid ? { at: runA.startedAt + 2000, image: 'node.exe' } : pid === runB.pid ? { at: runB.startedAt + 3_600_000, image: 'node' } : null) })
  w2.teamId = w1.teamId
  const reapedA = () => w2.svc.team(w2.teamId).store.recentRuns().find((r) => r.id === a.runId)
  check(reapedA()?.state === 'interrupted' && reapedA().interruptCause === 'crash', 'reaper: the run found active is interrupted {crash}')
  check(w2.svc.team(w2.teamId).store.rt.activeRuns.length === 0 && w2.svc.team(w2.teamId).store.rt.agents.every((x) => x.status === 'idle'), 'no active run, every agent idle after load')
  check(M.pidAlive(runA.pid) && M.pidAlive(runB.pid), 'the reaper never signals a stored pid')
  await until(() => w2.svc.team(w2.teamId).store.rt.cards.some((c) => c.from.kind === 'system' && c.from.why === 'orphan'), 10000, 'orphan card')
  const cards = w2.svc.team(w2.teamId).store.rt.cards.filter((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'orphan')
  check(cards.length === 1 && cards[0].from.vars.runId === a.runId && cards[0].from.vars.pid === runA.pid && JSON.stringify(cards[0].from.actions) === '["killOrphan","dismiss"]', 'one orphan card for the matching start time; the mismatch is ignored')
  same(await w2.runNow('dev'), { ok: false, error: 'deferred', defer: { reason: 'sessionBusy' } }, 'the orphan holds its session (G5): the agent defers sessionBusy')
  w2.use('claude-simple.json')
  const free = await w2.runNow('dev-2')
  check(free.ok, 'the agent of the ignored pid is not held')
  await w2.waitEnded(free.runId)
  // Labs off and on keep the orphan (its process still lives): the session stays held and its card still works.
  w2.cfg = { ...w2.cfg, settings: { ...w2.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w2.svc.setConfig(w2.cfg)
  w2.cfg = { ...w2.cfg, settings: { ...w2.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w2.svc.setConfig(w2.cfg)
  await until(async () => (await w2.svc.request({ op: 'list' }, 'desktop')).ok, 10000, 'reap: enabled again')
  same(await w2.runNow('dev'), { ok: false, error: 'deferred', defer: { reason: 'sessionBusy' } }, 'after Labs off and on the orphan still holds its session')
  check((await w2.svc.killOrphan(w2.teamId, 'k-404'))?.error === 'not_found', 'killOrphan of an unknown card: not_found')
  check((await w2.svc.killOrphan(w2.teamId, cards[0].id)) === null, 'killOrphan')
  await until(() => !M.pidAlive(runA.pid), 10000, 'orphan killed')
  check(!M.pidAlive(runA.pid) && M.pidAlive(runB.pid), 'killOrphan killed the confirmed orphan only')
  check(w2.svc.team(w2.teamId).store.rt.cards.find((c) => c.id === cards[0].id).state === 'dismissed', 'its card dismissed')
  const again = await w2.runNow('dev')
  check(again.ok, 'the session is free again: the run is requested again')
  await w2.waitEnded(again.runId)
  hardKill(runB.pid)
  w2.svc.dispose()
  w1.svc.dispose()

  // An orphan that dies by itself: the next gate drops it and dismisses its card, and the admission
  // committed right after keeps that dismissal (the gate's facts are read before the admission's rt).
  const v1 = await world('reap2', { clock: manualClock() })
  v1.use('hang.json')
  const o = await v1.runNow('dev')
  await v1.waitState(o.runId, 'running')
  v1.svc.team(v1.teamId).store.flushSync()
  const runO = json(v1.active(o.runId))
  const dead = new Set()
  const v2 = await world('reap2', { repo: v1.repo, data: v1.data, clock: manualClock(v1.clock.now + 60_000), noTeam: true, teamId: v1.teamId, procStart: async (pid) => (pid === runO.pid ? { at: runO.startedAt, image: 'node' } : null), alive: (pid) => !dead.has(pid) && M.pidAlive(pid) })
  v2.teamId = v1.teamId
  const orphanCard = () => v2.svc.team(v2.teamId).store.rt.cards.find((c) => c.from.kind === 'system' && c.from.why === 'orphan')
  await until(() => !!orphanCard(), 10000, 'reap2 orphan card')
  dead.add(runO.pid)
  v2.use('claude-simple.json')
  const next = await v2.runNow('dev-2')
  check(next.ok && orphanCard().state === 'dismissed', 'a dead orphan: its card dismissed by the gate and kept by the admission commit')
  await v2.waitEnded(next.runId)
  check(orphanCard().state === 'dismissed' && (await v2.svc.killOrphan(v2.teamId, orphanCard().id))?.error === 'not_found', 'still dismissed after the run; killOrphan finds nothing to kill')
  hardKill(runO.pid)
  v2.svc.dispose()
  v1.svc.dispose()
}

// ---- 5. the 3 MB result line and RunLog ids past the cut ------------------------------------------
async function logChecks() {
  const w = await world('log')
  w.use('claude-bigresult.json')
  const r = await w.runNow('dev')
  await w.waitEnded(r.runId, 'big result')
  const run = w.ended(r.runId)
  check(run.state === 'succeeded' && run.resultSeen && JSON.stringify(run.denials) === '[{"tool":"Write","count":1}]', 'a 3 MB result line still reaches the parser: succeeded, its denial counted')
  const page = await w.svc.request({ op: 'runPage', teamId: w.teamId, runId: r.runId }, 'desktop')
  check(page.ok && page.items.some((m) => m.role === 'system' && m.blocks.some((b) => b.text === M.CHAT_SKIPPED_TEXT)), 'the log shows a skipped marker for it')
  check(page.items.some((m) => m.role === 'user') || page.cursor !== null, 'the rest of the chat is there')
  w.svc.dispose()

  // RunLog unit: virtual offsets stay unique and increasing past the cut; pages from the ring and the file.
  const file = path.join(TMP, 'log', 'cut.jsonl')
  const log = new M.RunLog({ file, provider: 'claude', runId: 'r-0123456789ab', now: () => 1_800_000_000_000, maxBytes: 4000 })
  const ids = []
  ids.push(...log.writePrompt('hola', { mode: 'free', trigger: 'manual' }).map((m) => m.id))
  for (let i = 0; i < 60; i++) ids.push(...log.append(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i} ${'x'.repeat(80)}` }] } })).map((m) => m.id))
  log.writeStderr('boom')
  const nums = ids.map(Number)
  check(log.cutAt !== null && fs.statSync(file).size === log.cutAt && log.cutAt <= 4000 + 200, 'the file stops at the cut')
  check(nums.every((n, i) => i === 0 || n > nums[i - 1]) && new Set(nums).size === nums.length, 'message ids stay unique and increasing past the cut')
  check(fs.readFileSync(file, 'utf8').includes('"type":"snaos.cut"'), 'one snaos.cut line in the file')
  check(log.ring.some((m) => m.blocks.some((b) => typeof b.text === 'string' && b.text.includes('stderr:'))), 'stderr past the cut: in the ring only')
  const newest = await M.RunLog.page(file, 'claude', 'r-0123456789ab', null, 48 * 1024, log.ring, log.cutAt)
  check(newest.items.length > 0 && newest.items[newest.items.length - 1].id === log.ring[log.ring.length - 1].id && newest.cursor !== null, 'the newest page comes from the ring')
  let cursor = newest.cursor
  const seen = new Set(newest.items.map((m) => m.id))
  for (let guard = 0; cursor !== null && guard < 50; guard++) {
    const pg = await M.RunLog.page(file, 'claude', 'r-0123456789ab', Number(cursor), 48 * 1024, log.ring, log.cutAt)
    for (const m of pg.items) seen.add(m.id)
    cursor = pg.cursor
  }
  check(seen.has('0') && [...seen].some((id) => Number(id) > log.cutAt), 'paging back reaches the prompt at 0 through the cut')
  log.close()
  const finished = await M.RunLog.page(file, 'claude', 'r-0123456789ab', null, 48 * 1024, null, null)
  check(finished.items.some((m) => m.role === 'system' && m.blocks[0].text === M.RUN_LOG_CUT_TEXT) && M.RUN_LOG_CUT_TEXT.includes('Run log cut'), 'an ended run pages from the file and shows the cut row, the shared RUN_LOG_CUT_TEXT word for word (the renderer words it)')
}

// ---- 6. the `team` scope of every commit that moves a TeamView field, usageToday's clock, runs paging --
async function teamScopeChecks() {
  // A clock in the past: usageToday must read the service clock (a Date.now() day would drop every run).
  const w = await world('scope', { clock: manualClock(1_700_000_000_000) })
  const teamEmits = (from) => w.emitted.slice(from).filter((e) => e.teamId === w.teamId && e.scopes.includes('team'))
  const view = async () => (await w.svc.request({ op: 'get', teamId: w.teamId }, 'desktop')).team

  // A run that starts: running 0 -> 1, at a rev past the view the renderer holds (it reloads an equal or newer one).
  w.use('hang.json')
  const v0 = await view()
  let e0 = w.emitted.length
  const r = await w.runNow('dev')
  await w.waitState(r.runId, 'running')
  await settle()
  const started = teamEmits(e0)
  const v1 = await view()
  check(v0.running === 0 && v1.running === 1 && started.length > 0 && started.every((e) => e.rev > v0.rev && e.rev <= v1.rev), 'a run that starts: teams:changed carries team at the new rev')

  // A commit that moves no TeamView field (an agent pause) carries no team scope.
  e0 = w.emitted.length
  await w.svc.request({ op: 'pauseAgent', teamId: w.teamId, agentId: 'dev-2', on: true }, 'desktop')
  await w.svc.request({ op: 'pauseAgent', teamId: w.teamId, agentId: 'dev-2', on: false }, 'desktop')
  await settle()
  check(w.emitted.slice(e0).some((e) => e.teamId === w.teamId && e.scopes.includes('agents')) && teamEmits(e0).length === 0, 'an agent pause: agents, never team')

  // A need (the session conflict card) and the run end each carry team.
  e0 = w.emitted.length
  w.svc.onPaneStatus({ paneId: 'pane-x', state: 'working', precise: true, notify: false, provider: 'claude', sessionId: w.active(r.runId).sessionId })
  await w.waitEnded(r.runId)
  await settle()
  const v2 = await view()
  check(teamEmits(e0).some((e) => !e.runId && e.scopes.includes('needs')), 'a card that opens (Te necesita count): team with needs')
  check(teamEmits(e0).some((e) => e.runId === r.runId) && v2.running === 0 && v2.needsCount === 1, 'the run end: team, running back to 0, the need counted')

  // usageToday from the service clock, and the end that adds usage carries team.
  w.use('claude-simple.json')
  e0 = w.emitted.length
  const u = await w.runNow('dev-2')
  await w.waitEnded(u.runId)
  await settle()
  const v3 = await view()
  const outToday = w.ring().reduce((s, x) => s + (x.usage?.outputTokens ?? 0), 0)
  check(w.ended(u.runId).usage && v3.usageToday && v3.usageToday.estimated === true && outToday > 0 && v3.usageToday.outputTokens === outToday, 'usageToday counts the runs of the service clock day')
  check(teamEmits(e0).some((e) => e.runId === u.runId), 'the end that adds usage: team')

  // Paging: a page never ends inside a group of runs that share a queuedAt (none skipped, none repeated).
  const rec = w.svc.team(w.teamId)
  const mk = (agentId, i, at) => ({ id: `r-${(0xa00000000000 + i).toString(16)}`, agentId, roleId: agentId, roleKind: agentId, sessionKey: 'free', provider: 'claude', profile: 'readonly', resumed: false, cwd: w.repo, repoId: 'main', mode: 'free', trigger: { reason: 'manual', by: 'user' }, state: 'succeeded', reachedRunning: true, resultSeen: true, queuedAt: at, startedAt: at, endedAt: at + 1 })
  const T = 1_690_000_000_000
  let n = 0
  for (let i = 0; i < 18; i++) rec.store.recordRun(mk('qa', n++, T + 2000))
  for (let i = 0; i < 5; i++) rec.store.recordRun(mk('qa', n++, T + 1000))
  for (let i = 0; i < 3; i++) rec.store.recordRun(mk('qa', n++, T))
  for (let i = 0; i < 25; i++) rec.store.recordRun(mk('research', n++, T + 5000))
  for (let i = 0; i < 2; i++) rec.store.recordRun(mk('research', n++, T + 4000))
  const pagesOf = async (agentId) => {
    const pages = []
    let before
    for (let guard = 0; guard < 10; guard++) {
      const res = await w.svc.request({ op: 'runs', teamId: w.teamId, agentId, ...(before !== undefined ? { before } : {}) }, 'desktop')
      pages.push(res.runs.map((x) => x.id))
      if (res.cursor === null) break
      before = res.cursor
    }
    return pages
  }
  const qa = await pagesOf('qa')
  check(qa.flat().length === 26 && new Set(qa.flat()).size === 26 && qa[0].length === 18, 'runs: the first page stops before the tie group; no run skipped or repeated')
  check(qa[1][0] === mk('qa', 22, 0).id && qa[1][4] === mk('qa', 18, 0).id, 'inside a tie group the order is by run id, newest id first')
  const rs = await pagesOf('research')
  check(rs[0].length === 25 && rs.flat().length === 27 && new Set(rs.flat()).size === 27, 'a tie group that starts the page goes whole')

  // A provider limit (providerBlockedUntil) and its run end carry team.
  const until = 1_700_000_000_000 + 3_600_000
  w.use({ steps: [
    { emit: { type: 'system', subtype: 'init', session_id: 'x', model: 'claude-haiku-4-5' }, rewriteSession: true },
    { emit: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(until / 1000), rateLimitType: 'five_hour' }, session_id: 'x' }, rewriteSession: true },
    { emit: { type: 'result', subtype: 'success', is_error: true, result: 'limit', session_id: 'x' }, rewriteSession: true },
  ], exitCode: 1 })
  e0 = w.emitted.length
  const lim = await w.runNow('dev')
  await w.waitEnded(lim.runId)
  await settle()
  const v4 = await view()
  check(w.ended(lim.runId).failure?.kind === 'limit' && v4.providerBlockedUntil.claude === until && teamEmits(e0).some((e) => e.runId === lim.runId && e.rev === v4.rev), 'a provider limit: providerBlockedUntil in the view, team at its rev')
  w.svc.dispose()
}

// ---- 7. removeTeam waits for its runs from the close path (no polling) -----------------------------
async function removeChecks() {
  const w = await world('remove')
  w.use('hang.json')
  const r = await w.runNow('dev')
  await w.waitState(r.runId, 'running')
  const pid = w.active(r.runId).pid
  const runsDir = path.resolve(w.data, 'teams', w.teamId, 'runs')
  // Every async readdir of the bundled code (the same fs module): the run end of a team being removed prunes no logs.
  const listed = []
  const realReaddir = fs.promises.readdir
  fs.promises.readdir = function (p, ...rest) { listed.push(path.resolve(String(p))); return realReaddir.call(this, p, ...rest) }
  const a0 = armed.length
  const t0 = Date.now()
  let res
  try {
    res = await w.svc.request({ op: 'remove', teamId: w.teamId }, 'desktop')
  } finally {
    fs.promises.readdir = realReaddir
  }
  const took = Date.now() - t0
  const mine = armed.slice(a0)
  check(res.ok && !w.svc.team(w.teamId) && w.logs.includes(`run ${r.runId} ended cancelled`), 'remove with a live run: the run stops (deleted, cancelled), then the team goes')
  check(!mine.includes(25) && mine.filter((ms) => ms === M.REMOVE_WAIT_MS).length === 1 && M.REMOVE_WAIT_MS === 12_000, 'the wait arms one 12 s timeout and never polls')
  check(took < M.REMOVE_WAIT_MS - 2_000, 'it resolves from the run end, not the timeout')
  check(!listed.includes(runsDir), 'the run end of a team being removed prunes no logs (nothing open in the folder the trash rename moves)')
  await until(() => !M.pidAlive(pid), 10000, 'remove kill')
  check(!M.pidAlive(pid), 'the run process is dead')
  w.svc.dispose()
}

// ---- 8. pure reducers: policy rows of B2, requestStop on queued, manualGate -------------------------
function reducerChecks() {
  const now = 1_800_000_000_000
  const base = { id: 'r-0123456789ab', agentId: 'dev', roleId: 'dev', roleKind: 'dev', sessionKey: 'free', provider: 'claude', profile: 'total', resumed: false, cwd: 'C:\\r', repoId: 'main', mode: 'free', trigger: { reason: 'manual', by: 'user' }, state: 'failed', reachedRunning: true, resultSeen: true, queuedAt: now - 10_000, startedAt: now - 9_000, endedAt: now }
  const facts = (run, o = {}) => ({ run, agentInterrupts: 0, now, claudeCanSwitch: false, unknownSession: false, ...o })
  const lim = M.basicPolicy(facts({ ...base, failure: { kind: 'limit', until: now + 3_600_000 } }))
  check(lim.providerBlock?.provider === 'claude' && lim.providerBlock.until === now + 3_600_000 && lim.next?.reason === 'retry' && lim.next.notBefore === now + 3_600_000, 'limit: the provider blocked until the reset, a retry after it')
  const sw = M.basicPolicy(facts({ ...base, failure: { kind: 'limit' } }, { claudeCanSwitch: true }))
  check(sw.providerBlock.until === now + M.LIMIT_FALLBACK_MS, 'limit with another account to switch to: the 15 min fallback')
  const auth = M.basicPolicy(facts({ ...base, failure: { kind: 'auth' } }))
  check(auth.pauseTeam === 'auth' && auth.next?.reason === 'retry', 'auth: the team pauses')
  const switched = M.basicPolicy(facts({ ...base, failure: { kind: 'auth' } }, { claudeSwitchedAt: now - 5_000 }))
  check(!switched.pauseTeam && switched.next?.reason === 'retry', 'auth while the account switched during the run: a retry, not a pause (decision 40)')
  const before = M.basicPolicy(facts({ ...base, failure: { kind: 'auth' } }, { claudeSwitchedAt: now - 60_000 }))
  check(before.pauseTeam === 'auth', 'a switch before the run started does not count')
  check(M.basicPolicy(facts({ ...base, failure: { kind: 'billing' } })).pauseTeam === 'billing', 'billing pauses')
  check(M.basicPolicy(facts({ ...base, state: 'failed', reachedRunning: false, failure: { kind: 'request', code: 'no_output' } })).undeliver === true, 'a failure before running hands back what it got')
  check(!M.basicPolicy(facts({ ...base, state: 'cancelled', reachedRunning: false, stopReason: 'user' })).undeliver, 'never on a user stop')

  // R9 / 4.1: a stop for `concluded` without a result line ends succeeded(concluded); a stopped run has no outcome.
  const parserFacts = (o = {}) => ({ sawProtocol: true, resultSeen: false, isError: false, maxTurns: false, unknownSession: false, harnessCrash: false, finalText: '', denials: [], digest: { tools: 0, families: {}, files: [] }, toolCalls: 0, teamCalls: 0, fileEdits: 0, ...o })
  const end = (o = {}) => ({ at: now, exit: { code: null, signal: 'SIGTERM' }, facts: parserFacts(o), teamWrites: 0 })
  const stopping = { ...base, state: 'stopping', resultSeen: false, concludedBy: { tool: 'ask', at: now - 200_000 } }
  const concluded = M.terminalOf({ ...stopping, stopReason: 'concluded' }, end())
  check(concluded.state === 'succeeded' && !concluded.failure && concluded.outcome === 'concluded', 'concluded stop without a result: succeeded(concluded)')
  const concludedErr = M.terminalOf({ ...stopping, stopReason: 'concluded' }, end({ resultSeen: true, isError: true, failure: { kind: 'overloaded' } }))
  check(concludedErr.state === 'failed' && concludedErr.failure?.kind === 'overloaded' && concludedErr.outcome === 'concluded', 'concluded with an error result: the state from the result, outcome concluded')
  const userStop = M.terminalOf({ ...stopping, stopReason: 'user' }, end())
  check(userStop.state === 'cancelled' && userStop.outcome === undefined, 'a cancelled run carries no outcome, concluded or not (classifyOutcome order)')
  const conflict = M.terminalOf({ ...stopping, stopReason: 'sessionConflict' }, end())
  check(conflict.state === 'interrupted' && conflict.interruptCause === 'sessionConflict' && conflict.outcome === undefined, 'an interrupted run carries no outcome')

  // A clean end is !facts.failure (set exactly when the run failed), never resultSeen && !isError.
  const running = { ...base, state: 'running', resultSeen: false }
  const limitEnd = M.terminalOf(running, end({ resultSeen: true, isError: false, failure: { kind: 'limit', until: now + 60_000 } }))
  check(limitEnd.state === 'failed' && limitEnd.failure?.kind === 'limit' && limitEnd.outcome === 'failed', 'a failure with a clean result line: failed with the parser failure')
  const cleanEnd = M.terminalOf(running, end({ resultSeen: false, isError: true }))
  check(cleanEnd.state === 'succeeded' && !cleanEnd.failure, 'no parser failure: succeeded')
  const plainStop = { ...base, state: 'stopping', resultSeen: false, stopReason: 'user' }
  const stoppedFail = M.terminalOf(plainStop, end({ resultSeen: true, isError: false, failure: { kind: 'overloaded' } }))
  check(stoppedFail.state === 'failed' && stoppedFail.failure?.kind === 'overloaded', 'a stopped run with a result: its state from the parser failure')
  const stoppedOk = M.terminalOf(plainStop, end({ resultSeen: true, isError: true }))
  check(stoppedOk.state === 'succeeded' && !stoppedOk.failure && stoppedOk.outcome === 'empty', 'a stopped run with a result and no failure: succeeded')

  // R4 / K1: a queued run stopped for a takeover is a plain cancel (no process existed).
  const queuedRun = { ...base, state: 'queued', reachedRunning: false, resultSeen: false, startedAt: undefined, endedAt: undefined }
  delete queuedRun.startedAt
  delete queuedRun.endedAt
  const rt = { rev: 1, activeRuns: [queuedRun], agents: [{ id: 'dev', roleId: 'dev', roleKind: 'dev', provider: 'claude', status: 'running', runId: queuedRun.id, paused: false, sessions: {}, interrupts: 0 }], tasks: [], comments: {}, cards: [], approvals: [], queue: [], providerBlockedUntil: {} }
  const tk = M.requestStop(rt, queuedRun.id, 'takeover', { now })
  check(tk.ok && tk.result.immediate && tk.effects.some((e) => e.kind === 'ended' && e.run.state === 'cancelled' && e.run.stopReason === 'takeover'), 'a queued run stopped for a takeover: cancelled at once')
}

// ---- 9. the supervisor never signals a pid after Node emitted its exit (pid reuse) ----------------------
function supervisorKillChecks() {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const RID = 'r-0123456789ab'
  let n = 0
  /** A RunSupervisor on a fake child (its exit and close emitted by hand) and recording kill deps. */
  const make = (platform, o = {}) => {
    const clock = manualClock()
    const s = { clock, calls: [], logs: [], closed: [] }
    s.child = Object.assign(new EventEmitter(), { pid: 40000 + ++n, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    s.pid = s.child.pid
    s.timer = new M.DeadlineTimer((key) => s.sup.onDeadline(key), clock.deps)
    s.sup = new M.RunSupervisor({
      spawn: () => s.child,
      treeKill: { sync: (pid) => { s.calls.push(['sync', pid]); return true }, signal: (pid, sig) => { s.calls.push(['signal', pid, sig]); return true } },
      groupKill: o.groupKill ?? ((pid, sig) => { s.calls.push(['group', pid, sig]) }),
      timer: s.timer, now: () => clock.now, platform, log: (l) => s.logs.push(l),
      hooks: { firstLine() {}, append() {}, signal() {}, result() {}, closed: (id) => s.closed.push(id), spawnFailed() {} },
    })
    const started = s.sup.start({ runId: RID, teamId: 'tm-0123456789ab', agentId: 'dev', provider: 'claude', cli: { file: process.execPath, args: [], kind: 'exe' }, argv: [], cwd: TMP, env: {}, stdin: 'hola', logFile: path.join(TMP, 'sup', `${platform}-${n}.jsonl`), promptMeta: { mode: 'free', trigger: 'manual' }, base: {} })
    assert.ok(started.ok && started.pid === s.pid, 'the fake child starts')
    s.child.emit('spawn')
    s.exit = () => s.child.emit('exit', 0, null)
    /** Calls that hand the bare pid to the tree kill (taskkill /T on win32, kill(pid) fallback on POSIX). */
    s.bare = () => s.calls.filter((c) => c[0] === 'sync' || c[0] === 'signal')
    return s
  }
  for (const p of ['win32', 'linux']) {
    const posix = p !== 'win32'
    // Control: while the process lives, a stop signals its tree as before.
    const a = make(p)
    a.sup.stop(RID)
    same(a.calls, posix ? [['signal', a.pid, 'SIGTERM']] : [['sync', a.pid]], `${p}: a stop of a live run signals its tree`)
    if (posix) {
      a.clock.advance(M.POSIX_KILL_GRACE_MS)
      same(a.calls.at(-1), ['signal', a.pid, 'SIGKILL'], `${p}: then SIGKILL to the live tree`)
    }
    a.sup.shutdownSync()

    // Exit without close, then the drain: the reaped pid is never signalled; POSIX takes the group down.
    const b = make(p)
    b.exit()
    b.clock.advance(M.DRAIN_MS)
    check(b.closed.length === 1 && b.bare().length === 0, `${p}: the drain after the exit never hands the reaped pid to the tree kill`)
    same(b.calls, posix ? [['group', b.pid, 'SIGKILL']] : [], posix ? `${p}: the drain signals the process group only` : `${p}: the drain signals nothing`)
    check(posix || b.logs.some((l) => l.includes(`run ${RID} drain after exit: pid ${b.pid} not signalled`)), `${p}: the pid left alone is logged`)

    // A stop in the drain window, then its kill and stop deadlines (also the removeRecord path, onDeadline stop).
    const c = make(p)
    c.exit()
    c.sup.stop(RID)
    c.sup.onDeadline(`run:${RID}:kill`)
    c.sup.onDeadline(`run:${RID}:stop`)
    check(c.closed.length === 1 && c.bare().length === 0 && c.timer.size === 0, `${p}: stop, kill and stop deadline after the exit: finalized, the reaped pid never signalled, no key left`)
    same(c.calls, posix ? [['group', c.pid, 'SIGTERM'], ['group', c.pid, 'SIGKILL'], ['group', c.pid, 'SIGKILL']] : [], `${p}: after the exit only the group (POSIX) or nothing (win32)`)

    // shutdownSync after the exit (a drain in progress at quit).
    const d = make(p)
    d.exit()
    same(d.sup.shutdownSync(), [RID], `${p}: shutdownSync lists the run`)
    same(d.calls, posix ? [['group', d.pid, 'SIGKILL']] : [], `${p}: shutdownSync after the exit: ${posix ? 'the group only' : 'nothing signalled'}`)
  }
  // POSIX: a group already gone (ESRCH) is quiet; another error is logged; neither throws.
  const err = (code) => Object.assign(new Error(code), { code })
  const gone = make('linux', { groupKill: () => { throw err('ESRCH') } })
  gone.exit()
  gone.clock.advance(M.DRAIN_MS)
  check(gone.closed.length === 1 && !gone.logs.some((l) => l.includes('failed')), 'POSIX: ESRCH from the group kill after the exit is quiet')
  const denied = make('linux', { groupKill: () => { throw err('EPERM') } })
  denied.exit()
  denied.sup.shutdownSync()
  check(denied.logs.some((l) => l.includes('group SIGKILL (shutdown) failed EPERM')), 'POSIX: another group kill error is logged')
}

async function main() {
  try {
    reducerChecks()
    supervisorKillChecks()
    await lifecycleChecks()
    await stopChecks()
    await lifecycleExitChecks()
    await reaperChecks()
    await logChecks()
    await teamScopeChecks()
    await removeChecks()
    console.log(`PASS: ${checks} teams runner checks (fake agent lifecycle, watch, stop tree, linger, drain, max, prep CAS, session conflict, CLI off, gates, Labs off/on, shutdownSync, install, thaw, reaper, orphans, big result, RunLog cut, team scope, usage today, runs paging, remove wait, policy rows, no signal after exit)`)
  } finally {
    // dispose() is idempotent: it kills what a failed section left running (the supervisor's tree kill).
    for (const s of services) { try { s.dispose() } catch { /* already gone */ } }
    for (const pid of killed) { try { process.kill(pid) } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 200))
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* a dying child still holds a file */ }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  // A handle left behind (a grandchild pipe after a failure) never keeps the suite from exiting.
  .finally(() => setTimeout(() => process.exit(), 2000).unref())
