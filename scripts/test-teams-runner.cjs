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
// 2.7.0 runtime walkthrough: a beat (the tool_progress heartbeats of claude-heartbeat.jsonl, a keep_alive, a ping
// style line of either provider) is logged but signals nothing and moves no lastLineAt (nor is a first line).
// B4 additions: the task worktree created at the task's first run (the plan run) through the real WorktreeService
// on a temp manifest, tagged with its owner (teamOwned in list(), the IPC remove refused), the exec resuming the plan
// session in the same cwd, the write lock held and released by CAS, a console working in the tree holding a writer
// (treeBusy), a readonly assignee in the repo root with no worktree, a crash between the create and the commit
// re-adopting the owned tree, the tree mark (treeMoved), an extra-repo task with its worktree in that repo, a removed
// and re-created team getting -r2 for its t-1, runs in series within the caps with autonomy on (AgentView.waiting),
// Por despachar with autonomy off (needs rows with their defer reason, Despachar, Descartar of a derived level kept
// out until it changes, Descartar todo), the kickoff op, R2 triaging the Lead's untriaged tasks, the board scope of a
// task run's start and end, the backoff of a derived level whose prep failed with a card, and one sessionConflict
// card per session. B4 integration: Frenar opens no card and leaves the badge as it was, an owned tree whose folder
// is gone loses its owner once the task has a new one, a task-less re-wake keeps the user's request text across a
// reload (WakeMark.detail), and a prep failure without a card gives back the wake mark its admission consumed.
// B4 review: Descartar of a derived level offers the agent's next one at once, a kickoff on a resumed Lead session
// carries the edited goal, a pass before the orphan check settles never resumes the reaped session (the check pokes
// when it settles), a tree a prep made after its team was removed loses its owner, Retomar (resumeTask) of a stopped
// task through teams:req, and a console alone in the tree reads consoleBusy.
// B5 additions: the Codex block applied at close (codex-readonly-block: a comment then a small plan, in order, the run
// concluded; a refused action stops the list with a teams.log line and a note row in the run chat), a permission
// approval from claude-denied (a custom role's Write), one notice, approve grants the rule and the re-run allows it,
// a second decide already_decided, an approval and a card of a task that is over neither shown nor counted, the hire
// (team hire from a Lead run, phone decide forbidden, the canonical diff with its hidden characters and risks, the
// desktop approve writes roles/<id>.md and trusts that exact hash, an applying hire found at load back to pending, one
// whose file landed but was never trusted approved again with no second write),
// notices once per new need row and zero after a restart with a pending approval and a changed trust (needsSeen
// persisted; a state.json the repair reset notifies its stateReset card once), the Lead's reply in its thread, lead escalation with its note, the goal per Lead session (a Descartar of
// the kickoff item still gives the resumed session the edited goal), the Bash hint after a PowerShell `snaos team`
// denial (no approval, one run), and a prep failure card (blocked on it, Reintentar, Descartar then Retomar, phone
// desktop-only actions forbidden).
// B5 integration: Retomar lifts the prep backoff of a dismissed prep-failure card, `team task get` in the grace of a
// concluded run leaves a newer user comment queued (ctlRead), an escape denial (bash -c) opens no approval and its next
// run reads ESCAPE_HINT, a Bash denial's approval carries the denied command, the grant re-run reads its Bash hint as a
// system hint (never a <request from="user"> block, no WakeMark.detail), and a QA run's prep stores the numstat diff
// stat on the task for the final OK view. Fourth round: a permission approval whose stored rules the policy now refuses
// shows no rule and its Approve answers bad_request with detail nothingToGrant (Reject still works). Fifth round: a
// 64 hex token shape in a Codex block comment (a read-only sandbox reads runtime.json) is masked before it lands.
// Sixth round (the real CtlTokens in the world): a run whose stream holds the master token and team tokens (its own,
// another live run's, one cut by a line end, the piece a 4 KB tool result cut leaves) shows none in runPage (from the
// ring while it lives, from the file after) nor in a pushed append while its log file keeps them,
// every Claude line denies Read of each DATA_SECRET_PATHS entry, and the codex-readonly-block scenario with a live token
// in its comment action stops the list there (bad_request: secret; a cut team token in a later action too).
// Seventh round: a run's summary (the ring, runs.json) and the Lead's reply hold no live token nor a piece of one cut by
// a space or a line end, and a Claude line through a .cmd agent CLI past CMD_LINE_MAX (a custom role of 32 long tools)
// never spawns: spawnFailed with its own card words (vars.what cmdLine), while the same role through an .exe runs.
// B5 review: the Codex block note is a `snaos.note` record of a key and its vars (never an English sentence) that
// RunLog decodes to a system row of them (runNoteText; the old sentence shape, an unknown key or bad vars decode to
// nothing); a hire's apply and the user's trust of an edited definition cancel every other pending hire on the old
// base (error stale, out of Te necesita and the badge) and a decide that raced it answers conflict stale; a denied
// command whose exact rule holds an sk- key or the master token (whole or split) opens no permission approval and a
// prefix rule's denied command is masked whole.
// Tanda B close: a live Codex run paged from its ring keeps each record whole (file_change `N.0` and `N.1`) and the ring
// trim drops whole records; the prep backoff holds the user's message to the Lead too (only a manual entry skips it); a
// Descartar of one Lead level (kickoff, triage, a message) leaves its other levels their item; a queue row whose agent
// runs another run says `running`; a permission decide carries the approval's rev (stale without it, stale after a
// later run merged a rule into it, which notifies once more).
// 2.7.0 runtime fixes, second round: a run whose denial leaves its permission approval pending waits on the user (no
// continuation, count nor cooldown, a teams.log line), Rechazar wakes the same agent on the same session with the reject
// hint and the note, and a kickoff the user asked for reads trigger.by user (RunView.triggerBy) while the goal change
// kickoff reads system.
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
export { afterRunPolicy, classifyOutcome } from './src/shared/teamDispatch'
export { WorktreeService } from './src/main/git/WorktreeService'
export { WorktreeManifest } from './src/main/git/WorktreeManifest'
export { TaskWorktrees } from './src/main/teams/TaskWorktrees'
export { WriteLocks } from './src/main/teams/WriteLocks'
export { DISPATCH_KEY } from './src/main/teams/Dispatcher'
export { OPS } from './src/main/teams/ops/index'
export { TEAM_CALL_HINT, ESCAPE_HINT } from './src/main/teams/flow/approvals'
export { canonicalDefText, normalizeDefText } from './src/shared/teamDefinition'
export { teamNeedsCount } from './src/shared/teamNeeds'
export { mainTLang } from './src/main/i18n'
export { CtlTokens, newToken } from './src/main/cli/CtlTokens'
export { claudePathRule, DATA_SECRET_PATHS } from './src/shared/teamArgv'
export { redactCredentials } from './src/shared/redact'
export { CMD_LINE_MAX, spawnTarget } from './src/main/teams/agentCli'
export { needsEn, needsEs } from './src/renderer/i18n/teams/needs'
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
// The system config an empty file too (B4: real git only in temp repos with an isolated config).
const gitSysCfg = path.join(TMP, 'gitconfig-system')
fs.writeFileSync(gitSysCfg, '')
const gitEnvVars = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitCfg, GIT_CONFIG_SYSTEM: gitSysCfg }
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
    dir, repo, data, clock, logs: [], emitted: [], awake: [], appended: [], revoked: [], spawned: 0, signalled: [], notices: [],
    scenario: path.join(FIX, 'claude-simple.json'), cliReady: true, holders: new Map(), accounts: null,
    procStart: o.procStart ?? (async () => null),
  }
  w.master = M.newToken()
  w.tokens = new M.CtlTokens(w.master)
  const shim = path.join(dir, 'bin', process.platform === 'win32' ? 'snaos.cmd' : 'snaos')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, '')
  w.shim = shim
  w.cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '' }, workspaces: o.workspaces ?? [] }
  // B4: the console worktree service on a temp manifest and root, as registerWorktreeIpc builds it (git isolated).
  if (o.worktrees) {
    w.wtRoot = path.join(data, 'worktrees')
    w.manifest = new M.WorktreeManifest(path.join(data, 'worktrees.json'))
    w.wts = new M.WorktreeService({ runner, manifest: w.manifest, root: () => w.wtRoot, defaultRoot: () => w.wtRoot, removeOptions: { delayMs: 0, retries: 1 } })
  }
  w.statuses = []
  w.spawnCwds = new Map()
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
    status: { snapshot: () => w.statuses, stateOf: () => null, paneForSession: () => null },
    pty: { spawnCwd: (id) => w.spawnCwds.get(id), ptyIdForPane: () => null, killPaneAndWait: async () => undefined },
    sessionHolder: (_p, s) => w.holders.get(s) ?? null,
    ...(w.wts ? { worktrees: w.wts } : {}),
    accounts: () => w.accounts,
    // B5 integration, sixth round: the real CtlTokens (a master token, a team token per run, revoked at its end) behind
    // the live-token refusal of a Codex block and the masking of a run's chat; onToken lets a check see a run's token.
    cli: {
      envForTeam: (runId, teamId, agentId, roleKind) => {
        if (!w.cliReady) return {}
        const token = w.tokens.issueTeam(runId, { runId, teamId, agentId, roleKind })
        w.onToken?.(runId, token)
        return { SNAOS_CTL_ENDPOINT: 'test-pipe', SNAOS_CTL_TOKEN: token, SNAOS_CLI: shim, SNAOS_TEAM_RUN: runId }
      },
      revokeTeam: (runId) => { w.revoked.push(runId); w.tokens.revokeTeam(runId) },
      ready: () => w.cliReady,
      holdsToken: (text) => w.tokens.holdsToken(text),
      maskTokens: (text) => w.tokens.maskTokens(text),
    },
    awake: (e) => w.awake.push(json(e)),
    sendRun: (e) => w.appended.push(json(e)),
    spawn: (...a) => { w.spawned++; return cp.spawn(...a) },
    // w.cliTarget (seventh round): another agent CLI, a .cmd one, in place of the fake agent's exe.
    resolveCli: () => (w.noCli ? null : w.cliTarget ?? { file: process.execPath, args: [FAKE, w.scenario], kind: 'exe' }),
    procStartTime: (pid) => w.procStart(pid),
    // B5: the desktop toast of a new need row.
    notice: (n) => w.notices.push(json(n)),
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
  w.runTask = (agentId, taskId, prompt) => w.svc.request({ op: 'runNow', teamId: w.teamId, agentId, taskId, ...(prompt ? { prompt } : {}) }, 'desktop')
  w.task = (id) => w.rt().tasks.find((t) => t.id === id)
  w.createTask = async (task) => {
    const r = await w.svc.request({ op: 'createTask', teamId: w.teamId, task }, 'desktop')
    assert.ok(r.ok, `createTask: ${JSON.stringify(r)}`)
    return r.task.id
  }
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
  same(await w.svc.request({ op: 'runNow', teamId: w.teamId, agentId: 'dev', taskId: 't-1' }, 'desktop'), { ok: false, error: 'not_found' }, 'B4: a task run of a task that does not exist')
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
  // B6 integration, second round: it resolves once no integrate land is left (none here) with how many it waited for.
  check((await w.svc.prepareInstall()) === 0, 'prepareInstall resolves with no land to wait for')
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
  // The second is QA's (readonly): two writers never share the repo root (G6, decision 36).
  const w1 = await world('reap', { clock: manualClock() })
  w1.use('hang.json')
  const a = await w1.runNow('dev')
  const b = await w1.runNow('qa')
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
  const free = await w2.runNow('qa')
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

  // B close (finding 2): a line that decodes to several messages (a Codex file_change: `N.0` toolUse, `N.1` toolResult)
  // stays whole on a ring page, as on a file page: paging a live run back serves every message once.
  const cfile = path.join(TMP, 'log', 'codex-ring.jsonl')
  const fileChange = (i) => JSON.stringify({ type: 'item.completed', item: { id: `fc${i}`, type: 'file_change', status: 'completed', changes: [{ path: `src/f${i}.ts`, kind: 'update' }] } })
  const clog = new M.RunLog({ file: cfile, provider: 'codex', runId: 'r-0123456789ac', now: () => 1_800_000_000_000 })
  clog.writePrompt('do it', { mode: 'exec', trigger: 'manual' })
  for (let i = 0; i < 30; i++) clog.append(fileChange(i))
  clog.append(JSON.stringify({ type: 'item.completed', item: { id: 'am', type: 'agent_message', text: 'done' } }))
  const want = clog.ring.map((m) => m.id)
  check(want.some((id) => id.endsWith('.1')), 'the file_change lines decode to two messages that share one offset')
  const pageAll = async (ring, cut) => {
    const got = []
    let before = null
    for (let n = 0; n < 20; n++) {
      const pg = await M.RunLog.page(cfile, 'codex', 'r-0123456789ac', before, 48 * 1024, ring, cut)
      got.unshift(...pg.items.map((m) => m.id))
      if (pg.done || pg.cursor === null) break
      before = Number(pg.cursor)
    }
    return got
  }
  same(await pageAll(clog.ring, clog.cutAt), want, 'a live run paged from its ring: every message once, no half record lost at a page end (50 messages a page)')
  same(await pageAll(null, null), want, 'control: the same log paged from the file')
  // The ring trim drops whole records: ring[0] always starts one, and the file serves the rest whole.
  const tfile = path.join(TMP, 'log', 'codex-trim.jsonl')
  const tlog = new M.RunLog({ file: tfile, provider: 'codex', runId: 'r-0123456789ad', now: () => 1_800_000_000_000, ring: 5 })
  tlog.writePrompt('do it', { mode: 'exec', trigger: 'manual' })
  for (let i = 0; i < 3; i++) tlog.append(fileChange(i))
  check(tlog.ring.length === 4 && tlog.ring[0].id.endsWith('.0') && tlog.ring[1].id === tlog.ring[0].id.replace(/\.0$/, '.1'), `the trim past the ring cap drops whole records (${JSON.stringify(tlog.ring.map((m) => m.id))})`)
  const tAll = []
  let tBefore = null
  for (let n = 0; n < 10; n++) {
    const pg = await M.RunLog.page(tfile, 'codex', 'r-0123456789ad', tBefore, 48 * 1024, tlog.ring, tlog.cutAt)
    tAll.unshift(...pg.items.map((m) => m.id))
    if (pg.done || pg.cursor === null) break
    tBefore = Number(pg.cursor)
  }
  same(tAll.length, 7, `a trimmed ring then the file: the prompt and the three records, each whole (${JSON.stringify(tAll)})`)
  clog.close()
  tlog.close()

  // B5 review (finding 5): a `snaos.note` record decodes to a system row of its key and vars (runNoteText), never a
  // sentence, for either provider; the old sentence shape, an unknown key and vars that are not short one-line values
  // decode to nothing, and runNoteOfText reads back only a note.
  const at = '2027-01-15T08:00:00.000Z'
  const stopped = { key: 'blockStopped', vars: { applied: 1, total: 3, at: 2, method: 'team.task.create', error: 'forbidden' } }
  const full = { key: 'blockStateFull', vars: { mb: 8 } }
  for (const provider of ['claude', 'codex']) {
    const dec = M.runDecoder(provider)
    same(dec({ type: 'snaos.note', at, ...stopped }, 77), [{ id: '77', role: 'system', ts: null, blocks: [{ t: 'text', text: M.runNoteText(stopped) }] }], `${provider}: a blockStopped note record decodes to a system row of its key and vars`)
    same(dec({ type: 'snaos.note', at, ...full }, 78)[0].blocks[0].text, M.runNoteText(full), `${provider}: a blockStateFull note too`)
    const bad = [
      { type: 'snaos.note', at, text: 'snaos-team block: 1 of 3 action(s) applied; action 2 (team.task.create) was refused (forbidden) and stopped the list.' },
      { type: 'snaos.note', at, key: 'somethingElse', vars: {} },
      { type: 'snaos.note', at, key: 'blockStopped', vars: { method: 'team.comment\nand more' } },
      { type: 'snaos.note', at, key: 'blockStopped', vars: { method: 'x'.repeat(121) } },
      { type: 'snaos.note', at, key: 'blockStopped', vars: { applied: Infinity } },
      { type: 'snaos.note', at, key: 'blockStopped', vars: { 'bad key': 1 } },
      { type: 'snaos.note', at, key: 'blockStopped', vars: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, i])) },
      { type: 'snaos.note', at, key: 'blockStopped', vars: [1] },
    ]
    same(bad.map((r) => dec(r, 5)), bad.map(() => []), `${provider}: the old sentence shape, an unknown key and bad vars decode to nothing`)
  }
  same([M.runNoteOfText(M.runNoteText(stopped)), M.runNoteOfText(M.runNoteText(full))], [stopped, full], 'runNoteOfText reads back what runNoteText wrote')
  same([M.runNoteOfText(M.RUN_LOG_CUT_TEXT), M.runNoteOfText('{"type":"snaos.note","key":"blockStopped"'), M.runNoteOfText('hola'), M.runNoteOfText(null), M.runNoteOfText(JSON.stringify({ type: 'other', key: 'blockStopped', vars: {} }))], [null, null, null, null, null], 'runNoteOfText: null for any other text')
  check(!/applied;|was refused|stopped the list/.test(M.runNoteText(stopped)), 'the row text is no sentence')
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
  // B4: the Lead's kickoff (a goal it has not seen) waits in "Por despachar" since the first pass (autonomy off): one more row.
  const waitingRows = w.rt().queue.filter((q) => q.approvedAt === undefined).length
  check(teamEmits(e0).some((e) => e.runId === r.runId) && v2.running === 0 && waitingRows === 1 && v2.needsCount === 1 + waitingRows, 'the run end: team, running back to 0, the need counted (with the kickoff waiting in Por despachar)')

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

// ---- 8. pure reducers: the provider rows of afterRunPolicy (B2 rows kept under B4), terminalOf, requestStop on queued ----
function reducerChecks() {
  const now = 1_800_000_000_000
  const base = { id: 'r-0123456789ab', agentId: 'dev', roleId: 'dev', roleKind: 'dev', sessionKey: 'free', provider: 'claude', profile: 'total', resumed: false, cwd: 'C:\\r', repoId: 'main', mode: 'free', trigger: { reason: 'manual', by: 'user' }, state: 'failed', reachedRunning: true, resultSeen: true, queuedAt: now - 10_000, startedAt: now - 9_000, endedAt: now }
  const facts = (run, o = {}) => ({ run, agentInterrupts: 0, now, claudeCanSwitch: false, unknownSession: false, ...o })
  const lim = M.afterRunPolicy(facts({ ...base, failure: { kind: 'limit', until: now + 3_600_000 } }))
  check(lim.providerBlock?.provider === 'claude' && lim.providerBlock.until === now + 3_600_000 && lim.next?.reason === 'retry' && lim.next.notBefore === now + 3_600_000, 'limit: the provider blocked until the reset, a retry after it')
  const sw = M.afterRunPolicy(facts({ ...base, failure: { kind: 'limit' } }, { claudeCanSwitch: true }))
  check(sw.providerBlock.until === now + M.LIMIT_FALLBACK_MS, 'limit with another account to switch to: the 15 min fallback')
  const auth = M.afterRunPolicy(facts({ ...base, failure: { kind: 'auth' } }))
  check(auth.pauseTeam === 'auth' && auth.next?.reason === 'retry', 'auth: the team pauses')
  const switched = M.afterRunPolicy(facts({ ...base, failure: { kind: 'auth' } }, { claudeSwitchedAt: now - 5_000 }))
  check(!switched.pauseTeam && switched.next?.reason === 'retry', 'auth while the account switched during the run: a retry, not a pause (decision 40)')
  const before = M.afterRunPolicy(facts({ ...base, failure: { kind: 'auth' } }, { claudeSwitchedAt: now - 60_000 }))
  check(before.pauseTeam === 'auth', 'a switch before the run started does not count')
  check(M.afterRunPolicy(facts({ ...base, failure: { kind: 'billing' } })).pauseTeam === 'billing', 'billing pauses')
  check(M.afterRunPolicy(facts({ ...base, state: 'failed', reachedRunning: false, failure: { kind: 'request', code: 'no_output' } })).undeliver === true, 'a failure before running hands back what it got')
  check(!M.afterRunPolicy(facts({ ...base, state: 'cancelled', reachedRunning: false, stopReason: 'user' })).undeliver, 'never on a user stop')

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
  const stoppedOk = M.terminalOf(plainStop, end({ resultSeen: true }))
  check(stoppedOk.state === 'succeeded' && !stoppedOk.failure && stoppedOk.outcome === 'empty', 'a stopped run with a result and no failure: succeeded (classifyOutcome: empty)')

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

// ---- 9b. a beat is no sign of life (2.7.0 runtime walkthrough, run r-8ad66ddf8c19) ------------------------
// Claude prints a tool_progress heartbeat every 30 s while a tool runs, also inside a command that hangs: the line is
// logged, but it signals nothing and moves no lastLineAt, so the run's silence (B7) counts from its last real line.
function supervisorBeatChecks() {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const RID = 'r-0123456789ac'
  const hb = fs.readFileSync(path.join(FIX, 'claude-heartbeat.jsonl'), 'utf8').split('\n').filter((l) => l.trim())
  let n = 0
  const make = (provider) => {
    const clock = manualClock()
    const s = { clock, signals: [], first: [], appends: 0, logFile: path.join(TMP, 'sup-beat', `${provider}-${++n}.jsonl`) }
    const child = Object.assign(new EventEmitter(), { pid: 46000 + n, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    const timer = new M.DeadlineTimer((key) => s.sup.onDeadline(key), clock.deps)
    s.sup = new M.RunSupervisor({
      spawn: () => child,
      treeKill: { sync: () => true, signal: () => true },
      groupKill: () => undefined,
      timer, now: () => clock.now, platform: 'win32', log: () => undefined,
      hooks: { firstLine: (id, at, sid) => s.first.push({ at, sid }), append: () => { s.appends++ }, signal: (id, at) => s.signals.push(at), result() {}, closed() {}, spawnFailed() {} },
    })
    assert.ok(s.sup.start({ runId: RID, teamId: 'tm-0123456789ab', agentId: 'dev', provider, cli: { file: process.execPath, args: [], kind: 'exe' }, argv: [], cwd: TMP, env: {}, stdin: 'hola', logFile: s.logFile, promptMeta: { mode: 'free', trigger: 'manual' }, base: {} }).ok, 'the fake child starts')
    child.emit('spawn')
    /** One stdout line after `ms` of the run's clock (the data event the supervisor reads, synchronously). */
    s.line = (text, ms = 0) => {
      clock.advance(ms)
      child.stdout.emit('data', Buffer.from((typeof text === 'string' ? text : JSON.stringify(text)) + '\n'))
    }
    return s
  }

  const c = make('claude')
  c.line(hb[0])
  c.line(hb[1], 5000)
  c.line(hb[2], 1000)
  const toolAt = c.clock.now
  check(c.first.length === 1 && c.signals.length === 3 && c.sup.lastLineAt(RID) === toolAt, 'claude: init, the Bash tool_use and its task_started are signs of life')
  const appends = c.appends
  for (const beat of hb.slice(3)) c.line(beat, 30_000)
  c.line({ type: 'keep_alive' }, 30_000)
  c.line({ type: 'ping' }, 30_000)
  c.line({ type: 'heartbeat' }, 30_000)
  check(c.signals.length === 3 && c.sup.lastLineAt(RID) === toolAt, `claude: ${hb.length - 3} tool_progress heartbeats, a keep_alive and ping or heartbeat lines signal nothing and move no lastLineAt`)
  check(c.appends === appends, 'claude: nor do they add chat rows (the runAppend lastLineAt never moves on a beat)')
  const logged = fs.readFileSync(c.logFile, 'utf8')
  check((logged.match(/"heartbeat":true/g) ?? []).length === hb.length - 3, 'the heartbeats are still logged')
  c.line({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'sigue' }] }, parent_tool_use_id: null, session_id: 's' }, 1000)
  check(c.signals.length === 4 && c.sup.lastLineAt(RID) === c.clock.now, 'claude: the next real line signals again')
  c.sup.shutdownSync()

  const x = make('codex')
  x.line({ type: 'ping' })
  check(x.first.length === 0 && x.signals.length === 0 && x.sup.lastLineAt(RID) === undefined, 'codex: a ping style line before the thread is no first line and no sign of life')
  x.line({ type: 'thread.started', thread_id: '019a0000-0000-7000-8000-0000000000aa' }, 1000)
  const threadAt = x.clock.now
  check(x.first.length === 1 && x.first[0].sid === '019a0000-0000-7000-8000-0000000000aa' && x.signals.length === 1, 'codex: thread.started is the first line, with its thread')
  x.line({ type: 'keepalive' }, 30_000)
  x.line({ type: 'heartbeat' }, 30_000)
  check(x.signals.length === 1 && x.sup.lastLineAt(RID) === threadAt, 'codex: keepalive and heartbeat lines signal nothing')
  x.line({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'OK' } }, 1000)
  check(x.signals.length === 2 && x.sup.lastLineAt(RID) === x.clock.now, 'codex: an item is a sign of life')
  x.sup.shutdownSync()
}

// ---- 10. B4: task worktrees, the exec resume, write locks, the tree mark, extra repos, a re-created team ----
/** Same folder (realpath, case-folded where the filesystem folds it). */
function sameDir(a, b) {
  const k = (p) => { try { p = fs.realpathSync.native(p) } catch { p = path.resolve(p) } return WIN || process.platform === 'darwin' ? p.toLowerCase() : p }
  return !!a && !!b && k(a) === k(b)
}
/** A task patch committed by hand (what B5's terminal tools and approvals will do): the store's CAS and invariants still run. */
function setTask(w, id, patch, drop = []) {
  const rt = w.rt()
  const tasks = rt.tasks.map((t) => {
    if (t.id !== id) return t
    const next = { ...t, ...patch }
    for (const k of drop) delete next[k]
    return next
  })
  const res = w.svc.commit(w.teamId, { ok: true, rt: { ...rt, tasks }, effects: [], result: undefined }, ['board', 'task'], { taskId: id })
  assert.ok(res.ok, `setTask ${id}`)
}

async function worktreeChecks() {
  const w = await world('wt', { worktrees: true })
  const gen = w.rt().gen
  // A Dev task in worktree isolation (the defaults): the plan run (readonly) creates the tree (decision 24).
  const t1 = await w.createTask({ title: 'Login con Google', assignee: 'dev' })
  check(!w.task(t1).worktree, 'no worktree before the first run')
  same(await w.runTask('dev-2', t1), { ok: false, error: 'bad_request' }, 'runNow of a task for an agent its phase does not run: bad_request')
  w.use({ steps: [{ echoArgv: true }, { fixture: 'claude-simple.jsonl', to: 6, rewriteSession: true }, { sleepMs: 400 }, { fixture: 'claude-simple.jsonl', from: 6, rewriteSession: true }] })
  const p = await w.runTask('dev', t1)
  check(p.ok, `runNow with a task admits its plan run (${JSON.stringify(p)})`)
  await w.waitState(p.runId, 'running')
  const startEmits = w.emitted.filter((e) => e.teamId === w.teamId && e.runId === p.runId && e.taskId === t1 && e.scopes.includes('board') && e.scopes.includes('task'))
  check(startEmits.length > 0, 'a task run that starts sends the board and task scopes with its task (the board and the drawer refresh)')
  const e0 = w.emitted.length
  await w.waitEnded(p.runId)
  await settle()
  check(w.emitted.slice(e0).some((e) => e.runId === p.runId && e.taskId === t1 && e.scopes.includes('board')), 'and so does its end')
  const plan = w.ended(p.runId)
  const wt = w.task(t1).worktree
  check(wt && wt.owner === M.teamWorktreeOwner(w.teamId, gen, t1) && wt.slug === M.taskSlug(w.teamId, 1) && wt.branch === `sn/${wt.slug}` && wt.baseBranch === 'main' && /^[0-9a-f]{40}$/.test(wt.base), 'the first run created the task worktree: sn/<slug> from the base, tagged with the task owner')
  check(w.task(t1).frozen === true && plan.mode === 'plan' && plan.profile === 'readonly' && plan.cwd === wt.path, 'the plan run (readonly) ran in it; the task frozen')
  const argv = w.logLines(p.runId).find((l) => l && l.type === 'fake.argv')
  check(argv && sameDir(argv.cwd, wt.path), 'the process cwd is the worktree')
  check(fs.existsSync(path.join(wt.path, 'README.md')) && git(w.repo, 'worktree', 'list', '--porcelain').includes(`refs/heads/${wt.branch}`), 'a real git worktree of the repo on its branch')
  const entry = w.manifest.find(wt.path)
  check(entry && entry.owner === wt.owner && new M.WorktreeManifest(path.join(w.data, 'worktrees.json')).find(wt.path).owner === wt.owner, 'the manifest entry carries the owner, also read back from the file (decision 63)')
  const listed = await w.wts.list()
  check(listed.entries.some((e) => sameDir(e.path, wt.path) && e.teamOwned === true && e.managed), 'list(): the entry is teamOwned (Settings > Git never offers it as an orphan)')
  same(await w.wts.remove({ path: wt.path, deleteBranch: true }), { ok: false, error: 'busy', detail: 'team' }, 'the IPC remove of a team worktree (no owner passed): busy, detail team')
  check(fs.existsSync(wt.path), 'and the tree is still there')
  const sess = w.rt().agents.find((a) => a.id === 'dev').sessions[t1]
  check(sess && sess.cwd === wt.path && sess.sessionId === plan.sessionId && sess.turns === 1, 'the task session lives in the worktree (I20)')

  // The plan approved (B5's T5 by hand): the exec resumes the same session in the same cwd, a writer holding its lock.
  setTask(w, t1, { state: 'doing', phase: 'executing', plan: { rev: 1, text: 'Paso 1', status: 'approved', small: false, at: w.clock.now } }, ['next', 'cooldownUntil'])
  w.use({ steps: [{ echoArgv: true }, { fixture: 'claude-simple.jsonl', to: 6, rewriteSession: true }, { writeFile: { path: 'feature.txt', text: 'hola\n' } }, { sleepMs: 1200 }, { fixture: 'claude-simple.jsonl', from: 6, rewriteSession: true }] })
  const x = await w.runTask('dev', t1)
  check(x.ok, `the exec run is admitted (${JSON.stringify(x)})`)
  await w.waitState(x.runId, 'running')
  const lockKey = w.svc.locks.key(wt.path)
  const live = w.active(x.runId)
  check(live.mode === 'exec' && live.profile === 'total' && live.resumed === true && live.sessionId === plan.sessionId && live.cwd === wt.path, 'exec resumes the plan session (same sessionId) in the same cwd (decision 24)')
  check(w.svc.locks.holderOf(lockKey) === x.runId, 'the writer run holds the write lock of its tree')
  check(live.treeBefore && /^[0-9a-f]{40}$/.test(live.treeBefore.head), 'its tree marked at the prep (decision 68)')
  await w.waitEnded(x.runId)
  const ex = w.ended(x.runId)
  check(ex.treeMoved === true && ex.outcome === 'progress', 'the tree moved (a new file): treeMoved, outcome progress')
  check(w.svc.locks.holderOf(lockKey) === null && w.svc.locks.size === 0, 'the lock released at the end')
  const argv2 = w.logLines(x.runId).find((l) => l && l.type === 'fake.argv')
  check(argv2.argv.includes('--resume') && argv2.argv.includes(plan.sessionId) && sameDir(argv2.cwd, wt.path), 'argv: --resume <the plan session>, in the worktree')

  // WriteLocks: compare-and-clear, a human console inside a tree, integrates outlive a teardown.
  const L = new M.WriteLocks({ platform: process.platform, humanWriters: () => [path.join(w.repo, 'src')] })
  const k = L.key(w.repo)
  check(L.acquire(k, 'r-aaaaaaaaaaaa') && !L.acquire(k, 'r-bbbbbbbbbbbb') && L.acquire(k, 'r-aaaaaaaaaaaa') && L.holderOf(k) === 'r-aaaaaaaaaaaa', 'acquire: one holder per tree (the same holder again is fine)')
  L.release(k, 'r-bbbbbbbbbbbb')
  check(L.holderOf(k) === 'r-aaaaaaaaaaaa', 'a release by another holder clears nothing (CAS)')
  L.release(k, 'r-aaaaaaaaaaaa')
  check(L.holderOf(k) === null && L.busyKeys([w.repo]).has(k) && L.busyKeys([path.join(w.repo, 'src', 'deep')]).has(L.key(path.join(w.repo, 'src', 'deep'))) && L.busyKeys([w.dir]).size === 1, 'busyKeys: a human console inside the tree, the tree inside its cwd, either direction')
  check(L.acquire(L.key(wt.path), 'integrate:t-1') && L.acquire(k, 'r-cccccccccccc') && L.integrateKeys().size === 1, 'integrateKeys: only integrate holders')
  L.releaseRuns()
  check(L.holderOf(L.key(wt.path)) === 'integrate:t-1' && L.holderOf(k) === null, 'releaseRuns keeps an integrate in flight')

  // A human console working in the repo root holds a writer free run there (G6); a readonly one goes on.
  w.statuses = [{ paneId: 'p-human', state: 'working', precise: true, notify: false, provider: 'claude' }]
  w.spawnCwds.set('p-human', w.repo)
  same(await w.runNow('dev-2', 'Arreglá el README'), { ok: false, error: 'deferred', defer: { reason: 'consoleBusy' } }, 'a writer run waits while a console works in its tree (consoleBusy: no run holds it)')
  w.use('claude-simple.json')
  const ro = await w.runNow('qa', 'Revisá el README')
  check(ro.ok, 'a readonly free run is not held by it')
  await w.waitEnded(ro.runId)
  w.statuses = []

  // A readonly assignee (research) never gets a worktree: its worktree task runs in the repo root (decision 24).
  const t2 = await w.createTask({ title: 'Investigar el login', assignee: 'research' })
  w.use('codex-simple.json')
  const r2 = await w.runTask('research', t2)
  check(r2.ok, 'the research task run is admitted')
  await w.waitEnded(r2.runId)
  check(!w.task(t2).worktree && sameDir(w.ended(r2.runId).cwd, w.repo), 'a readonly assignee runs its worktree task in the repo root, no worktree')

  // A crash between the create and the task.worktree commit: the tree its owner holds is adopted, never a -r2.
  const t3 = await w.createTask({ title: 'Despues de un crash', assignee: 'dev-2' })
  const tw = new M.TaskWorktrees({ worktrees: w.wts, git: runner })
  const made = await tw.ensure({ id: w.teamId, gen }, w.svc.repoOf(w.teamId, 'main'), w.task(t3))
  check(made.ok && !w.task(t3).worktree && w.manifest.find(made.worktree.path).owner === M.teamWorktreeOwner(w.teamId, gen, t3), 'an owned tree exists that the task does not name yet')
  w.use('claude-simple.json')
  const r3 = await w.runTask('dev-2', t3)
  await w.waitEnded(r3.runId)
  check(w.task(t3).worktree && w.task(t3).worktree.path === made.worktree.path && w.task(t3).worktree.slug === M.taskSlug(w.teamId, 3) && w.ended(r3.runId).cwd === made.worktree.path, 're-adopted by its exact owner: same path and slug')

  // An owned tree whose folder is gone (B4 integration item 9): the next run makes a new one (-r2) and the stale entry
  // loses its owner, so one owner never names two entries (ownedBy would keep finding the stale one first).
  const t4 = await w.createTask({ title: 'Carpeta borrada', assignee: 'dev-2' })
  const owner4 = M.teamWorktreeOwner(w.teamId, gen, t4)
  const gone = await tw.ensure({ id: w.teamId, gen }, w.svc.repoOf(w.teamId, 'main'), w.task(t4))
  check(gone.ok && w.manifest.find(gone.worktree.path).owner === owner4, 'an owned tree the task does not name yet')
  fs.rmSync(gone.worktree.path, { recursive: true, force: true })
  w.use('claude-simple.json')
  const r4 = await w.runTask('dev-2', t4)
  await w.waitEnded(r4.runId)
  const nw4 = w.task(t4).worktree
  const owned4 = w.manifest.list().filter((e) => e.owner === owner4)
  check(nw4 && !sameDir(nw4.path, gone.worktree.path) && nw4.slug === `${M.taskSlug(w.teamId, M.taskNumOf(t4))}-r2` && owned4.length === 1 && sameDir(owned4[0].path, nw4.path), `a new tree (-r2) is the only entry of its owner (${owned4.length})`)
  const stale4 = w.manifest.find(gone.worktree.path)
  check(stale4 && stale4.owner === undefined && new M.WorktreeManifest(path.join(w.data, 'worktrees.json')).find(gone.worktree.path).owner === undefined, 'the stale entry lost its owner (an ordinary orphan now), on disk too')
  check(w.wts.ownedBy(owner4) && sameDir(w.wts.ownedBy(owner4).path, nw4.path), 'ownedBy names the new tree')

  // A writer free run that changes nothing: its tree did not move.
  w.use('claude-simple.json')
  const f = await w.runNow('dev', 'Mirá el repo')
  await w.waitEnded(f.runId)
  check(w.ended(f.runId).treeBefore && w.ended(f.runId).treeMoved === false, 'a writer run that changes nothing: treeMoved false')

  // An extra repo (decision 62): a task on it gets its worktree in that repo, and its cwd there.
  const lib = makeRepo(path.join(w.dir, 'lib'))
  const teamMd = path.join(w.repo, '.snagentsos', 'team', 'team.md')
  fs.writeFileSync(teamMd, fs.readFileSync(teamMd, 'utf8').replace(/^(name: .*)$/m, '$1\nrepo.lib.path: ../lib'))
  const diff = await w.svc.request({ op: 'trustDiff', teamId: w.teamId }, 'desktop')
  const tr = await w.svc.request({ op: 'trust', teamId: w.teamId, sha256: diff.trust.sha256 }, 'desktop')
  check(tr.ok && 'repoRoot' in w.svc.repoOf(w.teamId, 'lib'), `the extra repo is trusted and resolves (${JSON.stringify(tr.ok ? 'ok' : tr)})`)
  const tx = await w.createTask({ title: 'En la lib', assignee: 'dev', repoId: 'lib' })
  w.use('claude-simple.json')
  const rx = await w.runTask('dev', tx)
  await w.waitEnded(rx.runId)
  const wx = w.task(tx).worktree
  const exEntry = wx ? w.manifest.find(wx.path) : null
  check(wx && exEntry && sameDir(exEntry.repoRoot, lib) && sameDir(w.ended(rx.runId).cwd, wx.path) && git(lib, 'worktree', 'list', '--porcelain').includes(`refs/heads/${wx.branch}`) && !git(w.repo, 'worktree', 'list', '--porcelain').includes(`refs/heads/${wx.branch}`), 'an extra-repo task: its worktree in that repo, the run cwd in it, the main repo untouched')

  // The team removed: its worktrees lose their owner (ordinary orphans now), nothing deleted. Set up again (a new
  // gen): its t-1 gets a new tree with the -r2 suffix and never adopts the old one (decision 63).
  const oldPath = wt.path
  const rm = await w.svc.request({ op: 'remove', teamId: w.teamId }, 'desktop')
  check(rm.ok, 'remove the team')
  check(w.manifest.list().every((e) => !e.owner) && fs.existsSync(oldPath), 'remove disowned every task worktree of the team and deleted none')
  const after = await w.wts.list()
  check(after.entries.some((e) => sameDir(e.path, oldPath) && !e.teamOwned), 'they list as ordinary rows now')
  const probe = await w.svc.request({ op: 'setupProbe', dir: w.repo }, 'desktop')
  const ad = await w.svc.request({ op: 'adopt', repoRoot: w.repo, sha256: probe.probe.existing.sha256 }, 'desktop')
  check(ad.ok && ad.teamId === w.teamId && w.rt().gen !== gen, 'set up again on the same repo: the same team id, a new gen')
  const n1 = await w.createTask({ title: 'Otra vez t-1', assignee: 'dev' })
  check(n1 === 't-1', 'its first task is t-1 again')
  w.use('claude-simple.json')
  const rn = await w.runTask('dev', n1)
  await w.waitEnded(rn.runId)
  const nwt = w.task(n1).worktree
  check(nwt && nwt.slug === `${M.taskSlug(w.teamId, 1)}-r2` && !sameDir(nwt.path, oldPath) && nwt.owner === M.teamWorktreeOwner(w.teamId, w.rt().gen, 't-1'), 'the re-created team gets -r2 for its t-1, its own owner, never the old tree')
  w.svc.dispose()
}

// ---- 11. B4: runs in series within the caps (autonomy on), Por despachar (autonomy off), kickoff, triage ---
async function seriesChecks() {
  const w = await world('series', { worktrees: true })
  check(w.svc.trusted(w.teamId).def.maxConcurrent === 2, 'the template runs two at a time')
  w.use('hang.json')
  const ids = []
  for (const [i, who] of ['dev', 'dev-2', 'research'].entries()) ids.push(await w.createTask({ title: `Urgente ${i}`, assignee: who, priority: 'urgent' }))
  check(w.rt().activeRuns.length === 0, 'autonomy off: nothing starts by itself')
  same((await w.svc.request({ op: 'settings', teamId: w.teamId, patch: { autoDispatch: true } }, 'desktop')).ok, true, 'autonomy on')
  check(w.svc.pendingTimers > 0 && w.clock.timers.size > 0, 'turning it on pokes the dispatcher (the dispatch deadline at now)')
  w.clock.advance(0)
  const active = () => w.rt().activeRuns
  check(active().length === 2 && active().every((r) => r.taskId === ids[0] || r.taskId === ids[1]), 'one pass: two runs start (maxConcurrent 2), the most urgent oldest first')
  const roster = await w.svc.request({ op: 'roster', teamId: w.teamId }, 'desktop')
  const waitOf = (id) => roster.agents.find((a) => a.id === id).waiting
  check(waitOf('research')?.reason === 'teamCap' && waitOf('research').taskId === ids[2] && waitOf('lead')?.reason === 'teamCap' && !waitOf('dev'), 'AgentView.waiting: the third task and the Lead kickoff wait on the team cap; a running agent waits on nothing')
  await until(() => active().every((r) => r.state === 'running'), 20000, 'both running')
  const first = active().find((r) => r.taskId === ids[0])
  const openCards = () => w.rt().cards.filter((c) => c.state === 'open')
  const badge = async () => (await w.svc.request({ op: 'list' }, 'desktop')).teams.find((x) => x.id === w.teamId).needsCount
  const badgeBefore = await badge()
  check(openCards().length === 0, 'no open card before Frenar')
  same(await w.svc.request({ op: 'stop', teamId: w.teamId, runId: first.id }, 'desktop'), { ok: true }, 'stop the first')
  await w.waitEnded(first.id)
  check(w.task(ids[0]).state === 'blocked' && w.task(ids[0]).blocked.reason.kind === 'stopped' && w.task(ids[0]).blocked.reason.runId === first.id, 'Frenar blocks its task (decision 38): autonomy never restarts it')
  // Decision 38 (B4 integration item 1): blocked {stopped} and the drawer's resume only, no card in Te necesita.
  check(openCards().length === 0 && !w.rt().cards.some((c) => c.taskId === ids[0]), `Frenar opens no card (${JSON.stringify(openCards().map((c) => c.from))})`)
  same(await badge(), badgeBefore, 'the Te necesita badge is unchanged by a Frenar')
  w.clock.advance(0)
  check(active().length === 2 && active().some((r) => r.taskId === ids[2]) && !active().some((r) => r.taskId === ids[0]), 'its end pokes: the next one starts, still two at a time')
  for (const r of [...active()]) await w.svc.request({ op: 'stop', teamId: w.teamId, runId: r.id }, 'desktop')
  for (const r of [...active()]) await w.waitEnded(r.id)
  w.svc.dispose()
}

async function queueChecks() {
  const w = await world('queue')
  w.use('hang.json')
  const u1 = await w.createTask({ title: 'Sin asignar' })
  const t = await w.createTask({ title: 'Docs', assignee: 'research', needsPlan: false, isolation: 'main' })
  w.clock.advance(0)
  const q = () => w.rt().queue
  check(q().some((x) => x.taskId === t && x.agentId === 'research' && x.mode === 'exec' && x.reason === 'assigned') && q().some((x) => x.agentId === 'lead' && x.reason === 'kickoff'), 'autonomy off: the task run and the Lead kickoff wait in Por despachar (decision 18)')
  check(w.rt().activeRuns.length === 0, 'and nothing started')
  const n0 = q().length
  w.clock.advance(0)
  check(q().length === n0, 'a later pass enqueues nothing twice (one item per agent and session key)')
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  const row = needs.ok && needs.needs.queue.find((x) => x.taskId === t)
  check(row && row.approved === false && row.defer?.reason === 'autonomyOff' && row.mode === 'exec' && needs.needs.tasks[t].title === 'Docs' && needs.needs.rev === w.rt().rev, 'needs: the queue row with the reason it waits on and its task title')

  // kickoff (decision 43): the Lead now, autonomy off or not; its board lists u1 to triage, so R2 triages it.
  const k = await w.svc.request({ op: 'kickoff', teamId: w.teamId }, 'desktop')
  check(k.ok, `kickoff admits the Lead (${JSON.stringify(k)})`)
  await w.waitState(k.runId, 'running')
  const lr = w.active(k.runId)
  check(lr.mode === 'lead' && lr.trigger.reason === 'kickoff' && !q().some((x) => x.agentId === 'lead'), 'a lead run for the kickoff; its queue item went with the admission (R1)')
  // 2.7.0 runtime fixes: the kickoff the user asked for is theirs (Dispatcher.manual marks it), in the run and its view.
  const kr = await w.svc.request({ op: 'roster', teamId: w.teamId }, 'desktop')
  const kView = kr.ok && kr.agents.find((a) => a.id === 'lead').run
  check(lr.trigger.by === 'user' && kView && kView.id === k.runId && kView.trigger === 'kickoff' && kView.triggerBy === 'user', `the user's kickoff: trigger.by user, RunView.triggerBy user (${JSON.stringify([lr.trigger, kView && kView.triggerBy])})`)
  check(w.task(u1).triagedAt === lr.startedAt && w.rt().goalSeenHash === w.svc.trusted(w.teamId).goalHash, 'R2 of the Lead run: the task its board listed to triage is triaged, the goal seen')
  same(await w.svc.request({ op: 'kickoff', teamId: w.teamId }, 'desktop'), { ok: false, error: 'deferred', defer: { reason: 'running' } }, 'a second kickoff while the Lead runs: deferred running')

  // Despachar: approved; the next pass starts it (only the autonomy gate is skipped).
  const tq = q().find((x) => x.taskId === t)
  const go = await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: tq.id, go: true }, 'desktop')
  check(go.ok && go.approved.join() === tq.id && go.dropped.length === 0 && q().find((x) => x.id === tq.id).approvedAt === w.clock.now, 'Despachar sets approvedAt and answers it')
  w.clock.advance(0)
  const tr = w.rt().activeRuns.find((r) => r.taskId === t)
  check(tr && !q().some((x) => x.id === tq.id) && tr.mode === 'exec', 'the next pass starts it; the admission removed the item')

  // Descartar a level the runtime derives (a todo assignee): not offered again until the task changes.
  const t3 = await w.createTask({ title: 'Refactor', assignee: 'dev-2', needsPlan: false, isolation: 'main' })
  w.clock.advance(0)
  const it3 = q().find((x) => x.taskId === t3)
  check(it3 && it3.reason === 'assigned', 'the new task waits in Por despachar')
  same(await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: it3.id, go: false }, 'desktop'), { ok: true, approved: [], dropped: [it3.id] }, 'Descartar answers what it dropped')
  w.clock.advance(0)
  w.svc.poke()
  w.clock.advance(0)
  check(!q().some((x) => x.taskId === t3), 'the next passes do not offer it again')
  await w.svc.request({ op: 'updateTask', teamId: w.teamId, taskId: t3, baseRev: w.task(t3).rev, patch: { priority: 'high' } }, 'desktop')
  w.clock.advance(0)
  check(q().some((x) => x.taskId === t3), 'once the task changes it is offered again')
  same(await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: 'q-9999', go: true }, 'desktop'), { ok: false, error: 'not_found' }, 'an unknown item: not_found')
  same(await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: 'nope', go: true }, 'desktop'), { ok: false, error: 'bad_request' }, 'a queue id off its shape: bad_request')

  // A triage level discarded: the tasks count as triaged (the Lead is not woken for them again).
  const u2 = await w.createTask({ title: 'Otra sin asignar' })
  for (const r of [...w.rt().activeRuns]) await w.svc.request({ op: 'stop', teamId: w.teamId, runId: r.id }, 'desktop')
  for (const r of [...w.rt().activeRuns]) await w.waitEnded(r.id)
  w.clock.advance(0)
  const tri = q().find((x) => x.agentId === 'lead')
  check(tri && tri.reason === 'triage', 'an untriaged task wakes the Lead (triage)')
  const all = await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: 'all', go: false }, 'desktop')
  check(all.ok && all.dropped.includes(tri.id) && q().length === 0 && w.task(u2).triagedAt !== undefined, 'Descartar todo: every item dropped; the discarded triage triages its tasks')
  w.svc.dispose()
}

// A derived level whose prep fails with a card (no agent CLI found) waits RETRY_DELAY_MS before it is admitted again:
// autonomy on would otherwise retry it on every tick.
async function backoffChecks() {
  const w = await world('backoff')
  w.noCli = true
  await w.svc.request({ op: 'settings', teamId: w.teamId, patch: { autoDispatch: true } }, 'desktop')
  w.clock.advance(0)
  const leadRuns = () => w.ring().filter((r) => r.agentId === 'lead')
  check(w.rt().activeRuns.some((r) => r.agentId === 'lead' && r.trigger.reason === 'kickoff'), 'autonomy on: the Lead kickoff is admitted')
  // 2.7.0 runtime fixes: the kickoff a goal the Lead has not seen raised is the team's, not the user's.
  check(w.rt().activeRuns.find((r) => r.agentId === 'lead' && r.trigger.reason === 'kickoff').trigger.by === 'system', 'the goal change kickoff: trigger.by system')
  await until(() => leadRuns().length === 1, 10000, 'the kickoff prep fails')
  const autoRuns = await w.svc.request({ op: 'runs', teamId: w.teamId, agentId: 'lead' }, 'desktop')
  const autoView = autoRuns.ok && autoRuns.runs.find((r) => r.id === leadRuns()[0].id)
  check(autoView && autoView.trigger === 'kickoff' && autoView.triggerBy === 'system', `and its RunView reads triggerBy system (${JSON.stringify(autoView)})`)
  check(leadRuns()[0].failure?.code === 'spawnFailed' && w.rt().cards.filter((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'spawnFailed').length === 1, 'no CLI: spawnFailed with its card')
  w.clock.advance(0)
  w.svc.poke()
  w.clock.advance(0)
  check(w.rt().activeRuns.length === 0 && leadRuns().length === 1, 'the next passes do not admit it again at once (the goal is still unseen)')
  const failedAt = leadRuns()[0].endedAt
  const roster = await w.svc.request({ op: 'roster', teamId: w.teamId }, 'desktop')
  const leadWait = roster.ok && roster.agents.find((a) => a.id === 'lead').waiting
  check(leadWait && leadWait.reason === 'cooldown' && leadWait.until === failedAt + M.RETRY_DELAY_MS, `the roster reads the backoff as cooldown until it ends (${JSON.stringify(leadWait)})`)
  // A backed-off level never takes a cap slot: two readonly task runs (no shared writer tree) start in one pass with
  // maxConcurrent 2 while the Lead waits.
  const ta = await w.createTask({ title: 'Uno', assignee: 'research', needsPlan: false, isolation: 'main' })
  const tb = await w.createTask({ title: 'Dos', assignee: 'qa', needsPlan: false, isolation: 'main' })
  w.clock.advance(0)
  const both = w.rt().activeRuns
  check(both.length === 2 && both.some((r) => r.taskId === ta) && both.some((r) => r.taskId === tb) && !both.some((r) => r.agentId === 'lead'), `the backed-off Lead sits out the plan: both task runs start (maxConcurrent 2; ${JSON.stringify(both.map((r) => [r.agentId, r.taskId]))})`)
  await until(() => w.rt().activeRuns.length === 0, 10000, 'both preps fail (no CLI)')
  const leadCards = () => w.rt().cards.filter((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'spawnFailed' && !c.taskId)
  w.clock.advance(M.RETRY_DELAY_MS)
  await until(() => leadRuns().length === 2, 10000, 'the retry after the backoff')
  check(leadCards().length === 1, 'after RETRY_DELAY_MS one more try; its card is not raised twice')
  w.noCli = false
  w.use('claude-simple.json')
  const manual = await w.runNow('lead', 'Arrancá')
  check(manual.ok, 'a manual run of the same agent never waits on the backoff')
  await w.waitEnded(manual.runId)
  w.svc.dispose()
}

// B close (finding 5): a level that bypasses the cooldown (the user's message to the Lead) still waits out the prep
// backoff; only a manual entry skips it. Without that a prep that keeps failing would be admitted on every pass.
async function backoffUserChecks() {
  const w = await world('backoff-user')
  w.noCli = true
  const said = await w.svc.request({ op: 'leadSay', teamId: w.teamId, text: 'Hola Lider' }, 'desktop')
  check(said.ok, 'the user writes to the Lead')
  await w.svc.request({ op: 'settings', teamId: w.teamId, patch: { autoDispatch: true } }, 'desktop')
  w.clock.advance(0)
  const leadRuns = () => w.ring().filter((r) => r.agentId === 'lead')
  await until(() => leadRuns().length === 1 && w.rt().activeRuns.length === 0, 10000, 'the userMessage prep fails')
  check(leadRuns()[0].trigger.reason === 'userMessage' && leadRuns()[0].failure?.code === 'spawnFailed', `autonomy on: the Lead's message run, spawnFailed (no CLI) (${JSON.stringify(leadRuns()[0].trigger)})`)
  for (let i = 0; i < 5; i++) {
    w.svc.poke()
    w.clock.advance(0)
    check(!w.rt().activeRuns.some((r) => r.agentId === 'lead'), `pass ${i + 1}: the failed message level is not admitted again at once`)
  }
  await settle()
  check(leadRuns().length === 1, 'one failed run, not one per pass')
  const failedAt = leadRuns()[0].endedAt
  const roster = await w.svc.request({ op: 'roster', teamId: w.teamId }, 'desktop')
  const wait = roster.ok && roster.agents.find((a) => a.id === 'lead').waiting
  check(wait && wait.reason === 'cooldown' && wait.until === failedAt + M.RETRY_DELAY_MS, `the Lead reads cooldown until the backoff ends (${JSON.stringify(wait)})`)
  w.clock.advance(M.RETRY_DELAY_MS)
  await until(() => leadRuns().length === 2, 10000, 'the retry after the backoff')
  check(leadRuns()[1].trigger.reason === 'userMessage', 'after RETRY_DELAY_MS the message level tries once more')
  w.svc.dispose()
}

// B close (finding 6): a Descartar of one Lead level never hides the Lead's other levels (they share the session key
// 'lead'): a level the runtime records (kickoff, triage) ends in the discard and needs no skip; the unread message, the
// one it derives, is skipped by its reason until a new message comes.
async function discardLeadChecks() {
  const w = await world('discard-lead')
  w.use('hang.json')
  const q = () => w.rt().queue
  const leadItem = () => q().find((x) => x.agentId === 'lead')
  const drop = async (id) => same(await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: id, go: false }, 'desktop'), { ok: true, approved: [], dropped: [id] }, `Descartar ${id}`)
  const u1 = await w.createTask({ title: 'Sin asignar' })
  w.clock.advance(0)
  check(leadItem()?.reason === 'kickoff', 'autonomy off: the Lead item is the kickoff (it beats triage)')
  await drop(leadItem().id)
  w.clock.advance(0)
  check(w.rt().goalSeenHash === w.svc.trusted(w.teamId).goalHash && leadItem()?.reason === 'triage', `the kickoff discarded: the goal seen, and the Lead's triage gets its item at once (${JSON.stringify(q())})`)
  await drop(leadItem().id)
  w.clock.advance(0)
  check(w.task(u1).triagedAt !== undefined && !leadItem(), 'the triage discarded: its task triaged, no Lead item')
  await w.svc.request({ op: 'leadSay', teamId: w.teamId, text: 'Priorizá el login' }, 'desktop')
  const u2 = await w.createTask({ title: 'Otra sin asignar' })
  w.clock.advance(0)
  check(leadItem()?.reason === 'userMessage', 'a message and an untriaged task: the message first')
  await drop(leadItem().id)
  w.clock.advance(0)
  check(leadItem()?.reason === 'triage', `the message discarded: the Lead's triage still gets its item (${JSON.stringify(q())})`)
  await drop(leadItem().id)
  w.svc.poke()
  w.clock.advance(0)
  check(w.task(u2).triagedAt !== undefined && !leadItem(), 'the discarded message stays out while no new one comes')
  await w.svc.request({ op: 'leadSay', teamId: w.teamId, text: 'Y el registro' }, 'desktop')
  w.clock.advance(0)
  check(leadItem()?.reason === 'userMessage', 'a new message offers it again')
  w.svc.dispose()
}

// B close (finding 7): a queue row the dry run has no request for (its agent is running another run) says what holds
// it, not "starts as soon as you dispatch it".
async function queueDeferChecks() {
  const w = await world('queue-defer')
  w.use('hang.json')
  const t2 = await w.createTask({ title: 'Normal', assignee: 'dev-2', needsPlan: false, isolation: 'main' })
  w.clock.advance(0)
  const q = () => w.rt().queue
  const q1 = q().find((x) => x.taskId === t2)
  check(!!q1, 'the first task waits in Por despachar')
  const t1 = await w.createTask({ title: 'Urgente', assignee: 'dev-2', needsPlan: false, isolation: 'main', priority: 'high' })
  w.clock.advance(0)
  const q2 = q().find((x) => x.taskId === t1)
  check(!!q2 && q().some((x) => x.id === q1.id), 'the urgent one gets its own item, the first stays')
  await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: q2.id, go: true }, 'desktop')
  w.clock.advance(0)
  const run = w.rt().activeRuns.find((r) => r.taskId === t1)
  check(!!run, 'Despachar starts the urgent task')
  await w.waitState(run.id, 'running')
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  const row = needs.ok && needs.needs.queue.find((x) => x.id === q1.id)
  check(row && row.defer?.reason === 'running' && row.defer.taskId === t2, `the other row of that agent waits for its run (${JSON.stringify(row)})`)
  await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: q1.id, go: true }, 'desktop')
  const after = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(after.needs.queue.find((x) => x.id === q1.id)?.defer?.reason === 'running', 'approved, it still says the run holds it')
  await w.svc.request({ op: 'stop', teamId: w.teamId, runId: run.id }, 'desktop')
  await w.waitEnded(run.id)
  w.svc.dispose()
}

// ---- 12. B4: one sessionConflict card per session (extra requirement 2) ----------------------------------
async function conflictChecks() {
  const w = await world('conflict')
  w.use('hang.json')
  const r = await w.runNow('dev')
  await w.waitState(r.runId, 'running')
  const sid = w.active(r.runId).sessionId
  const ev = { paneId: 'pane-x', state: 'working', precise: true, notify: false, provider: 'claude', sessionId: sid }
  w.svc.onPaneStatus(ev)
  w.svc.onPaneStatus(ev)
  await w.waitEnded(r.runId)
  const open = () => w.rt().cards.filter((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'sessionConflict')
  check(open().length === 1 && open()[0].from.vars.what === `session:${sid}`, 'two conflicts on one run: one card, keyed by its session')
  const r2 = await w.runNow('dev')
  await w.waitState(r2.runId, 'running')
  check(w.active(r2.runId).sessionId === sid, 'the next run resumes the same session')
  w.svc.onPaneStatus(ev)
  await w.waitEnded(r2.runId)
  check(w.ended(r2.runId).interruptCause === 'sessionConflict' && open().length === 1, 'a second conflict on the same session while its card is open: no other card')
  w.svc.dispose()
}

// ---- 13. B4 integration items 2 and 3: a re-woken task-less run keeps its request across a reload; a prep failure
// without a card gives the wake mark its admission consumed back as it was -------------------------------------
async function wakeChecks() {
  // Item 2: a free run with the user's request, interrupted by a quit: the policy's re-wake keeps the text, persisted.
  const w1 = await world('wake')
  w1.use('hang.json')
  const ask = 'Revisá el README y contame qué falta'
  const r = await w1.runNow('dev', ask)
  await w1.waitState(r.runId, 'running')
  const pid = w1.active(r.runId).pid
  w1.svc.shutdownSync('quit')
  const st = JSON.parse(fs.readFileSync(path.join(w1.data, 'teams', w1.teamId, 'state.json'), 'utf8'))
  const mark = st.agents.find((a) => a.id === 'dev').next
  check(mark && mark.mode === 'free' && mark.reason === 'interrupted' && mark.detail === ask, `the re-wake of the interrupted free run keeps the request text, written to state.json (${JSON.stringify(mark)})`)
  await until(() => !M.pidAlive(pid), 10000, 'wake: shutdown kill')
  w1.svc.dispose()

  // The second life on the same data: the mark is back with its text. Before the woken run starts, a console takes its
  // session during the prep (sessionBusy, no card): the mark the admission consumed comes back as it was (item 3).
  const w2 = await world('wake', { repo: w1.repo, data: w1.data, clock: manualClock(w1.clock.now + 60_000), noTeam: true, teamId: w1.teamId })
  w2.teamId = w1.teamId
  const dev = () => w2.rt().agents.find((a) => a.id === 'dev')
  const loaded = json(dev().next)
  check(loaded && loaded.detail === ask && loaded.reason === 'interrupted', 'loaded back: the wake mark with its request text')
  const sid = dev().sessions.free?.sessionId
  check(!!sid, 'the free session of the first life')
  const busy = await w2.runNow('dev')
  check(busy.ok, `runNow without a prompt runs the agent's level, the re-wake (${JSON.stringify(busy)})`)
  w2.holders.set(sid, 'pane-console')
  await w2.waitEnded(busy.runId)
  check(w2.ended(busy.runId).failure?.code === 'sessionBusy' && w2.rt().cards.every((c) => c.state !== 'open'), 'a console took the session during the prep: sessionBusy, no card')
  same(dev().next, loaded, 'a manual run without a task built from the agent\'s mark gives that mark back, its request text too')
  w2.holders.clear()
  const stdinFile = path.join(w2.dir, 'wake-stdin.txt')
  w2.use({ saveStdin: stdinFile, steps: [{ fixture: 'claude-simple.jsonl', rewriteSession: true }] })
  const ok = await w2.runNow('dev')
  check(ok.ok, 'the session is free again')
  await w2.waitEnded(ok.runId)
  check(fs.readFileSync(stdinFile, 'utf8').includes(`<request from="user">\n${ask}\n</request>`) && dev().next === undefined, 'the run after the reload carries the request into its stdin; the mark is consumed')

  // Item 3 on a task: Ejecutar ahora of a task waiting on its L1 mark (a continuation in its cooldown); the prep fails
  // without a card, and the task gets that very mark back (reason, cooldown), not a bare retry.
  const t = await w2.createTask({ title: 'Docs', assignee: 'dev', needsPlan: false, isolation: 'main' })
  w2.use('claude-simple.json')
  const first = await w2.runTask('dev', t)
  await w2.waitEnded(first.runId)
  const l1 = json(w2.task(t).next)
  check(l1 && l1.reason === 'continuation' && l1.notBefore > w2.clock.now && w2.task(t).phase === 'executing', `a run without progress leaves a continuation in its cooldown (${JSON.stringify(l1)})`)
  const tsid = dev().sessions[t]?.sessionId
  const manual = await w2.runTask('dev', t)
  check(manual.ok, 'Ejecutar ahora bypasses the cooldown')
  w2.holders.set(tsid, 'pane-console')
  await w2.waitEnded(manual.runId)
  check(w2.ended(manual.runId).failure?.code === 'sessionBusy' && w2.rt().cards.every((c) => c.state !== 'open'), 'its prep fails sessionBusy, no card')
  same(w2.task(t).next, l1, 'the task gets its L1 mark back as it was')
  check(w2.task(t).state === 'doing' && w2.task(t).phase === 'executing', 'so it does not sit in doing with no level')
  w2.holders.clear()
  w2.svc.dispose()
}

// ---- 14. B4 review fixes ------------------------------------------------------------------------------------------
// Descartar of a derived level never hides the agent's next one (finding 1): with autonomy off the next task gets its
// item at once, and the roster names a row Te necesita has.
async function discardNextChecks() {
  const w = await world('discard-next')
  w.use('hang.json')
  const a = await w.createTask({ title: 'Urgente', assignee: 'dev-2', needsPlan: false, isolation: 'main', priority: 'urgent' })
  const b = await w.createTask({ title: 'Normal', assignee: 'dev-2', needsPlan: false, isolation: 'main' })
  w.clock.advance(0)
  const q = () => w.rt().queue
  const ia = q().find((x) => x.agentId === 'dev-2')
  check(ia && ia.taskId === a && !q().some((x) => x.taskId === b), 'autonomy off: one item per agent, its most urgent task')
  same(await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: ia.id, go: false }, 'desktop'), { ok: true, approved: [], dropped: [ia.id] }, 'Descartar the urgent one')
  w.clock.advance(0)
  const ib = q().find((x) => x.agentId === 'dev-2')
  check(ib && ib.taskId === b && ib.reason === 'assigned', `the pass right after Descartar offers the agent's next task (${JSON.stringify(q().map((x) => [x.agentId, x.taskId ?? null]))})`)
  const roster = await w.svc.request({ op: 'roster', teamId: w.teamId }, 'desktop')
  const wait = roster.ok && roster.agents.find((x) => x.id === 'dev-2').waiting
  check(wait && wait.reason === 'autonomyOff' && wait.taskId === b, `the roster says it waits for that task (${JSON.stringify(wait)})`)
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(needs.ok && needs.needs.queue.some((x) => x.id === ib.id && x.defer?.reason === 'autonomyOff'), 'and Te necesita has its row')
  w.svc.poke()
  w.clock.advance(0)
  check(!q().some((x) => x.taskId === a) && q().filter((x) => x.agentId === 'dev-2').length === 1, 'the discarded task stays out while it does not change')
  w.svc.dispose()
}

// A kickoff on a resumed Lead session reads the goal it was asked about (finding 2, decision 43).
async function leadGoalChecks() {
  const w = await world('lead-goal')
  w.use('claude-simple.json')
  const first = await w.runNow('lead')
  check(first.ok, `a Lead run (${JSON.stringify(first)})`)
  await w.waitEnded(first.runId)
  const sess = w.rt().agents.find((x) => x.id === 'lead').sessions.lead
  check(sess && sess.turns === 1 && w.rt().goalSeenHash === w.svc.trusted(w.teamId).goalHash, 'its session on the lead key; the goal seen')
  const teamMd = path.join(w.repo, '.snagentsos', 'team', 'team.md')
  fs.writeFileSync(teamMd, fs.readFileSync(teamMd, 'utf8').replace('Una app de notas', 'Una app de tareas con recordatorios'))
  const diff = await w.svc.request({ op: 'trustDiff', teamId: w.teamId }, 'desktop')
  const tr = await w.svc.request({ op: 'trust', teamId: w.teamId, sha256: diff.trust.sha256 }, 'desktop')
  check(tr.ok && w.svc.trusted(w.teamId).def.goal.includes('tareas con recordatorios') && w.rt().goalSeenHash !== w.svc.trusted(w.teamId).goalHash, 'the goal edited and trusted: the Lead has not seen it')
  const stdinFile = path.join(w.dir, 'kickoff-stdin.txt')
  w.use({ saveStdin: stdinFile, steps: [{ fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  const k = await w.svc.request({ op: 'kickoff', teamId: w.teamId }, 'desktop')
  check(k.ok, `kickoff (${JSON.stringify(k)})`)
  await w.waitEnded(k.runId)
  const run = w.ended(k.runId)
  check(run.resumed === true && run.sessionId === sess.sessionId, 'the kickoff resumes the Lead session (the goal is not in the system text: same sysHash)')
  const stdin = fs.readFileSync(stdinFile, 'utf8')
  check(stdin.includes('Goal (updated') && stdin.includes('Una app de tareas con recordatorios') && stdin.indexOf('tareas con recordatorios') < stdin.indexOf('# Your run'), 'its resumed stdin carries the new goal, marked updated, before section 4')
  check(w.rt().goalSeenHash === w.svc.trusted(w.teamId).goalHash, 'and only then is the goal seen')
  w.svc.dispose()
}

// The orphan check of decision 64 settling after the first pass (finding 7): with autonomy on and a probe that
// answers late, no pass resumes the reaped run's session before it settles; it pokes when it settles.
async function orphanWaitChecks() {
  // First life: the Lead saw the goal (no kickoff later), a Dev's free run hangs; autonomy goes on and the state is
  // written (no pass runs: the manual clock never moves). Then the app "crashes".
  const w1 = await world('orphan-wait')
  w1.use('claude-simple.json')
  const l = await w1.runNow('lead')
  await w1.waitEnded(l.runId)
  w1.use('hang.json')
  const a = await w1.runNow('dev')
  await w1.waitState(a.runId, 'running')
  check((await w1.svc.request({ op: 'settings', teamId: w1.teamId, patch: { autoDispatch: true } }, 'desktop')).ok, 'autonomy on')
  w1.svc.team(w1.teamId).store.flushSync()
  const runA = json(w1.active(a.runId))
  // Second life: the probe waits on a gate (PowerShell takes seconds on Windows); enable's pass runs meanwhile.
  let release
  const gate = new Promise((r) => (release = r))
  let probed = 0
  const w2 = await world('orphan-wait', { repo: w1.repo, data: w1.data, clock: manualClock(w1.clock.now + 60_000), noTeam: true, teamId: w1.teamId, procStart: async () => { probed++; await gate; return null } })
  w2.teamId = w1.teamId
  w2.use('claude-simple.json')
  const dev = () => w2.rt().agents.find((x) => x.id === 'dev')
  check(dev().next?.reason === 'interrupted' && dev().next.mode === 'free' && w2.rt().autoDispatch === true && M.pidAlive(runA.pid), 'the reaper queued the re-wake of the interrupted free run; autonomy on; its process lives')
  w2.clock.advance(0)
  check(probed === 1 && !w2.rt().activeRuns.some((r) => r.agentId === 'dev'), 'a pass before the check settles: the re-wake of the orphan session is not admitted')
  const roster = await w2.svc.request({ op: 'roster', teamId: w2.teamId }, 'desktop')
  check(roster.ok && roster.agents.find((x) => x.id === 'dev').waiting?.reason === 'sessionBusy', 'it waits sessionBusy until then')
  const due = () => [...w2.clock.timers.values()].some((t) => t.at <= w2.clock.now)
  check(!due(), 'no pass armed while the check runs')
  // It settles (the pid is not ours this time): it pokes, and the next pass resumes the session.
  release()
  await until(() => !w2.svc.reapedAtLoad.has(w2.teamId), 5000, 'the check settles')
  check(due(), 'the settled check pokes, also when it found no orphan')
  w2.clock.advance(0)
  const re = w2.rt().activeRuns.find((r) => r.agentId === 'dev')
  check(re && re.resumed === true && re.sessionId === runA.sessionId && re.trigger.reason === 'interrupted', 'then the pass resumes the session')
  await w2.waitEnded(re.id)
  hardKill(runA.pid)
  w2.svc.dispose()
  w1.svc.dispose()
}

// A team removed while a run's prep is inside TaskWorktrees.ensure (findings 5 and 6): the create lands after the
// removal's disown, and the prep disowns the tree it made (an ordinary orphan, decision 63).
async function removeRaceChecks() {
  const w = await world('remove-race', { worktrees: true })
  const t = await w.createTask({ title: 'Repo grande', assignee: 'dev' })
  const owner = M.teamWorktreeOwner(w.teamId, w.rt().gen, t)
  let release
  const gate = new Promise((r) => (release = r))
  let entered = false
  const realCreate = w.wts.create.bind(w.wts)
  w.wts.create = async (req, o) => { entered = true; await gate; return realCreate(req, o) }
  w.use('claude-simple.json')
  const r = await w.runTask('dev', t)
  check(r.ok, `the plan run of a worktree task is admitted (${JSON.stringify(r)})`)
  await until(() => entered, 10000, 'the prep is inside the worktree create')
  const rm = await w.svc.request({ op: 'remove', teamId: w.teamId }, 'desktop')
  check(rm.ok && !w.svc.team(w.teamId), 'the team is removed meanwhile')
  release()
  const slug = M.taskSlug(w.teamId, M.taskNumOf(t))
  await until(() => w.manifest.list().some((e) => e.branch === `sn/${slug}`), 30000, 'the create lands after the removal')
  await until(() => w.manifest.list().every((e) => !e.owner), 5000, 'the prep disowns the tree it made')
  const entry = w.manifest.list().find((e) => e.branch === `sn/${slug}`)
  check(entry && entry.owner === undefined && new M.WorktreeManifest(path.join(w.data, 'worktrees.json')).list().every((e) => e.owner !== owner), 'its entry has no owner, on disk too')
  const rows = await w.wts.list()
  check(rows.entries.some((e) => e.branch === `sn/${slug}` && !e.teamOwned), 'Settings > Git lists it as an ordinary orphan the user may delete')
  check(w.logs.some((x) => x === `run ${r.runId} worktree ${slug} disowned: its team was removed`) && !w.logs.some((x) => x.startsWith(`run ${r.runId} started`)), 'the prep disowned it and started nothing')
  w.svc.dispose()
}

// Retomar of a task the user stopped (finding 4, decision 38): `resumeTask` over T17 through teams:req.
async function resumeChecks() {
  const w = await world('resume')
  w.use('hang.json')
  const t = await w.createTask({ title: 'Frenada', assignee: 'dev', needsPlan: false, isolation: 'main' })
  const other = await w.createTask({ title: 'Otra', assignee: 'dev-2', needsPlan: false, isolation: 'main' })
  const r = await w.runTask('dev', t)
  await w.waitState(r.runId, 'running')
  same(await w.svc.request({ op: 'stop', teamId: w.teamId, runId: r.runId }, 'desktop'), { ok: true }, 'Frenar')
  await w.waitEnded(r.runId)
  check(w.task(t).state === 'blocked' && w.task(t).blocked.reason.kind === 'stopped' && w.task(t).blocked.resume.state === 'doing' && w.task(t).blocked.resume.phase === 'executing', 'blocked {stopped}, to resume in doing/executing')
  same(await w.svc.request({ op: 'resumeTask', teamId: w.teamId, taskId: 't-404' }, 'desktop'), { ok: false, error: 'not_found' }, 'an unknown task: not_found')
  const notStopped = await w.svc.request({ op: 'resumeTask', teamId: w.teamId, taskId: other }, 'desktop')
  check(!notStopped.ok && notStopped.error === 'conflict' && notStopped.reason === 'stale' && notStopped.current?.id === other, 'a task that is not blocked {stopped}: conflict stale, with the current task')
  const res = await w.svc.request({ op: 'resumeTask', teamId: w.teamId, taskId: t }, 'desktop')
  check(res.ok && res.task.id === t && res.task.state === 'doing' && res.task.phase === 'executing' && !res.task.blocked, `Retomar: back in the pair it was stopped in (${JSON.stringify(res.ok ? [res.task.state, res.task.phase] : res)})`)
  const next = w.task(t).next
  check(!w.task(t).blocked && next && next.agentId === 'dev' && next.mode === 'exec' && next.reason === 'retry' && next.bypassCooldown === true, 'with a retry level for the agent of that phase (T17)')
  w.clock.advance(0)
  check(w.rt().queue.some((q) => q.taskId === t && q.agentId === 'dev' && q.reason === 'retry'), 'autonomy off: the resumed task waits in Por despachar')
  const again = await w.svc.request({ op: 'resumeTask', teamId: w.teamId, taskId: t }, 'desktop')
  check(!again.ok && again.error === 'conflict' && again.reason === 'stale', 'a second Retomar: conflict stale')
  w.svc.dispose()
}

// ---- 15. B5: the Codex block at close, permission approvals, the hire, notices, the Lead, hints, cards ----------
/** The team caller a live run's token resolves to (what `snaos team` reaches teamCtl with). */
function whoOf(w, runId) {
  const run = w.active(runId)
  return { runId, teamId: w.teamId, agentId: run.agentId, roleKind: run.roleKind }
}
async function trustAgain(w) {
  const diff = await w.svc.request({ op: 'trustDiff', teamId: w.teamId }, 'desktop')
  const tr = await w.svc.request({ op: 'trust', teamId: w.teamId, sha256: diff.trust.sha256 }, 'desktop')
  assert.ok(tr.ok, `trust: ${JSON.stringify(tr)}`)
}
const teamDirOf = (w) => path.join(w.repo, '.snagentsos', 'team')
/** One Codex exec turn whose last agent message is `text` (a new thread `thread`). */
const codexTurn = (thread, text) => ({
  steps: [
    { emit: { type: 'thread.started', thread_id: thread } },
    { emit: { type: 'turn.started' } },
    { emit: { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } } },
    { emit: { type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 } } },
  ],
})
const phoneCtx = (w) => ({ origin: 'phone', actor: { kind: 'user', via: 'phone' }, svc: w.svc, now: w.clock.now })

// R11: a Codex readonly run's block applied at close, in order, before the policy; a refused action stops the list.
async function blockChecks() {
  const w = await world('b5-block')
  const t = await w.createTask({ title: 'Investigar el bug', assignee: 'research', isolation: 'main' })
  check(t === 't-1', 'the first task is t-1 (the scenario block names it)')
  w.use('codex-readonly-block.json')
  const r = await w.runTask('research', t)
  check(r.ok, `the research plan run (${JSON.stringify(r)})`)
  await w.waitEnded(r.runId)
  const run = w.ended(r.runId)
  check(run.provider === 'codex' && run.mode === 'plan' && run.state === 'succeeded' && run.outcome === 'concluded' && run.concludedBy?.tool === 'plan', `the block concluded the run with team plan (${JSON.stringify([run.state, run.outcome, run.concludedBy])})`)
  const task = w.task(t)
  check(task.state === 'doing' && task.phase === 'planApproval' && task.plan?.status === 'pending' && task.plan.small === true && task.plan.text.includes('Read the code'), 'T4 through the block: the plan pending approval')
  const ap = w.rt().approvals.find((a) => a.kind === 'plan' && a.taskId === t)
  check(ap && ap.state === 'pending' && ap.decider === 'lead', 'a small plan the team lets the Lead approve (decision 29)')
  const c = (w.rt().comments[t] ?? []).find((x) => x.author.kind === 'agent' && x.author.agentId === 'research')
  check(c && c.text === 'Plan written', 'the comment action landed first, in order')
  check(w.logs.includes(`run ${r.runId} block applied=2/2`) && w.logs.includes(`run ${r.runId} team.plan (block)`), 'teams.log: both actions, then the count')
  check(run.denials === undefined && !w.rt().approvals.some((a) => a.kind === 'permission'), 'a Codex run never asks a permission')

  // A refused action stops the list: the comment lands, a Lead-only create is refused, the plan never comes.
  const t2 = await w.createTask({ title: 'Otra pista', assignee: 'research', isolation: 'main' })
  const text = `Listo.\n\n\`\`\`snaos-team\n${JSON.stringify({ v: 1, actions: [
    { method: 'team.comment', params: { target: t2, text: 'Primero esto' } },
    { method: 'team.task.create', params: { title: 'No me toca' } },
    { method: 'team.plan', params: { text: 'Nunca llega' } },
  ] })}\n\`\`\``
  w.use(codexTurn('019a0000-0000-7000-8000-0000000b10c9', text))
  const r2 = await w.runTask('research', t2)
  await w.waitEnded(r2.runId)
  const run2 = w.ended(r2.runId)
  check(run2.outcome !== 'concluded' && !run2.concludedBy && w.task(t2).phase === 'planning' && !w.task(t2).plan, 'the list stopped before the plan: the task stays in planning')
  check((w.rt().comments[t2] ?? []).some((x) => x.text === 'Primero esto') && !w.rt().tasks.some((x) => x.title === 'No me toca'), 'the action before it landed, the refused one changed nothing')
  check(w.logs.includes(`run ${r2.runId} block applied=1/3 stopped=2 team.task.create forbidden`), `teams.log names where and why (${w.logs.filter((l) => l.includes(r2.runId) && l.includes('block')).join(' | ')})`)
  const note = w.logLines(r2.runId).find((l) => l && l.type === 'snaos.note')
  // B5 review (finding 5): the note is a record of its key and vars, never an English sentence; the run chat words it.
  check(note && note.key === 'blockStopped' && JSON.stringify(note.vars) === JSON.stringify({ applied: 1, total: 3, at: 2, method: 'team.task.create', error: 'forbidden' }) && !('text' in note) && typeof note.at === 'string', 'the run log keeps a note record of it: key blockStopped and its vars, no sentence', note)
  const page = await w.svc.request({ op: 'runPage', teamId: w.teamId, runId: r2.runId }, 'desktop')
  const noteRow = page.ok ? page.items.find((m) => m.role === 'system' && m.blocks.some((b) => b.t === 'text' && M.runNoteOfText(b.text))) : undefined
  check(noteRow && noteRow.blocks.length === 1 && noteRow.blocks[0].text === M.runNoteText({ key: 'blockStopped', vars: note.vars }) && JSON.stringify(M.runNoteOfText(noteRow.blocks[0].text)) === JSON.stringify({ key: 'blockStopped', vars: note.vars }), 'its chat shows the note as a system row of that key and vars (runNoteText, read back with runNoteOfText)', noteRow)

  // B5 integration, fifth round (the second net): a Codex read-only sandbox reads any file, so its block could carry
  // the master token of runtime.json; the 64 hex token shape is masked before the comment lands (redactCredentials).
  const t3 = await w.createTask({ title: 'Tercera pista', assignee: 'research', isolation: 'main' })
  const leaked = '9f'.repeat(32)
  const text3 = `Listo.\n\n\`\`\`snaos-team\n${JSON.stringify({ v: 1, actions: [{ method: 'team.comment', params: { target: t3, text: `runtime.json: {"token":"${leaked}"}` } }] })}\n\`\`\``
  w.use(codexTurn('019a0000-0000-7000-8000-0000000b10ca', text3))
  const r3 = await w.runTask('research', t3)
  await w.waitEnded(r3.runId)
  const c3 = (w.rt().comments[t3] ?? []).find((x) => x.author.kind === 'agent' && x.author.agentId === 'research')
  check(c3 && c3.text === 'runtime.json: {"token":"[redacted]"}' && !JSON.stringify(w.rt()).includes(leaked), 'a token shape in a Codex block comment is masked before it lands in the team state (fifth round)', c3)
  w.svc.dispose()
}

// B5 integration, sixth round (security): what a run read never leaves main with a live token of the app in it (its
// chat page and its pushed lines), a Codex block action that carries one is refused like a CLI call, and every Claude
// line denies Read of every secret of the data folder.
async function secretChecks() {
  const w = await world('b6-secrets')
  const lower = (v) => JSON.stringify(v ?? null).toLowerCase()
  // Another run's live team token, and the run's own one, which the stream writes as the run reads them.
  const other = w.tokens.issueTeam('r-00000000beef', { runId: 'r-00000000beef', teamId: w.teamId, agentId: 'qa', roleKind: 'qa' })
  const file = path.join(w.dir, 'scenario-secrets.json')
  fs.writeFileSync(file, '{"steps":[]}')
  let own = ''
  w.onToken = (runId, token) => {
    own = token
    fs.writeFileSync(file, JSON.stringify({ steps: [
      { sleepMs: 250 },
      { emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `runtime.json dice key${w.master}fin y el otro ${other.toUpperCase()}.` }] }, session_id: 'x' }, rewriteSession: true },
      { emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Bash', input: { command: `echo ${token}` } }] }, session_id: 'x' }, rewriteSession: true },
      { emit: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: `{"token":"${w.master.slice(0, 30)}\n${w.master.slice(30)}"}`, is_error: false }] }, session_id: 'x' }, rewriteSession: true },
      // A 4 KB tool result (CHAT_TOOL_TEXT_MAX) whose cut lands inside the master token: 40 of its characters remain.
      { emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s2', name: 'Bash', input: { command: 'cat salida.txt' } }] }, session_id: 'x' }, rewriteSession: true },
      { emit: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s2', content: `${'x'.repeat(4096 - 40)}${w.master} fin`, is_error: false }] }, session_id: 'x' }, rewriteSession: true },
      // Live long enough for a page from the ring.
      { sleepMs: 1500 },
      { fixture: 'claude-simple.jsonl', rewriteSession: true },
    ] }))
  }
  w.scenario = file
  const r = await w.runNow('dev')
  check(r.ok, 'the run that reads the tokens is admitted')
  same(await w.svc.request({ op: 'watchRun', teamId: w.teamId, runId: r.runId }, 'desktop'), { ok: true }, 'and watched')
  const cutPiece = w.master.slice(0, 40)
  const leaks = () => [w.master, other, own, w.master.slice(0, 30), w.master.slice(30), cutPiece]
  // While the run lives, runPage serves its ring (RunLog.page masks each ring row before the frame budget).
  await until(() => w.appended.some((e) => e.runId === r.runId && e.items.some((m) => m.blocks.some((b) => b.t === 'toolResult' && b.toolUseId === 'toolu_s2'))), 15000, 'the long tool result pushed')
  const livePage = await w.svc.request({ op: 'runPage', teamId: w.teamId, runId: r.runId }, 'desktop')
  const livePageText = lower(livePage.items)
  check(livePage.ok && livePage.live === true && livePage.items.some((m) => m.blocks.some((b) => b.t === 'toolResult' && b.toolUseId === 'toolu_s2' && b.text.endsWith('x[redacted]'))), 'runPage of the live run (its ring): the cut tool result ends masked', livePage.live)
  check(!leaks().some((t) => livePageText.includes(t)), 'runPage of the live run holds no live token nor a piece of one (fails without the ring mask)')
  await w.waitEnded(r.runId)
  w.onToken = undefined
  check(/^[0-9a-f]{64}$/.test(own) && w.revoked.includes(r.runId), 'the run had its own live team token (revoked at its end)')
  const raw = fs.readFileSync(w.logFile(r.runId), 'utf8').toLowerCase()
  check(raw.includes(w.master) && raw.includes(other) && raw.includes(own), 'the run log file under dataDir() keeps what the run read as it was written')
  const pushed = w.appended.filter((e) => e.runId === r.runId)
  const pushedText = lower(pushed)
  check(pushed.some((e) => e.items.length > 0) && pushedText.includes('[redacted]'), 'teams:runAppend pushed the watched lines, masked', pushed.length)
  check(!leaks().some((t) => pushedText.includes(t)), 'no pushed append holds the master token, a team token (its own, another live run\'s), half of a cut one nor the piece a 4 KB cut leaves')
  const page = await w.svc.request({ op: 'runPage', teamId: w.teamId, runId: r.runId }, 'desktop')
  const pageText = lower(page.items)
  check(page.ok && page.items.some((m) => m.blocks.some((b) => b.t === 'text' && b.text === 'runtime.json dice key[redacted]fin y el otro [redacted].')), 'runPage: the assistant text with each live token masked in place', page.items)
  check(page.items.some((m) => m.blocks.some((b) => b.t === 'toolResult' && b.text === '[redacted]')) && page.items.some((m) => m.blocks.some((b) => b.t === 'toolUse' && b.summary.includes('[redacted]'))), 'runPage: a tool result with a cut token masked whole, the command that printed the run\'s own token masked')
  check(!leaks().some((t) => pageText.includes(t)), 'runPage holds neither the master token nor a team token nor a piece of one (fails without the masking)')
  check(page.items.some((m) => m.blocks.some((b) => b.t === 'toolResult' && b.toolUseId === 'toolu_s2' && b.text.endsWith('x[redacted]'))), 'runPage from the file: the tool result cut inside the master token ends masked')
  // Control: the same file read without the mask shows them (the page op masks; RunLog.page alone does not).
  const bare = await M.RunLog.page(w.logFile(r.runId), 'claude', r.runId, null)
  check(lower(bare.items).includes(w.master) && lower(bare.items).includes(other), 'control: RunLog.page without a mask shows the tokens the file holds')

  // A Claude line denies Read of every secret of the data folder (TeamService.protectPaths over DATA_SECRET_PATHS).
  w.use({ steps: [{ echoArgv: true }, { fixture: 'claude-simple.jsonl', rewriteSession: true }] })
  const a = await w.runNow('dev-2')
  await w.waitEnded(a.runId)
  const argv = w.logLines(a.runId).find((l) => l && l.type === 'fake.argv').argv
  const reads = M.DATA_SECRET_PATHS.flatMap((p) => (p.endsWith('/') ? [M.claudePathRule('Read', path.join(w.data, p), '/**')] : [M.claudePathRule('Read', path.join(w.data, p)), M.claudePathRule('Read', path.join(w.data, p), '/**')]))
  check(M.DATA_SECRET_PATHS.length === 11 && reads.every((x) => argv.includes(x)), 'every Claude line denies Read of each DATA_SECRET_PATHS entry under the data folder', reads.filter((x) => !argv.includes(x)))
  check(argv.includes(M.claudePathRule('Read', path.join(w.data, 'claude-accounts'), '/**')) && !argv.includes(M.claudePathRule('Read', path.join(w.data, 'claude-accounts'))) && !argv.some((x) => /^(?:Edit|Write|MultiEdit)\(.*remote-devices\.json/.test(x)) && argv.includes(M.claudePathRule('Edit', path.join(w.data, 'runtime.json'))), 'a folder gets its /** rule only; the write denies stay teams/, trusted-teams.json and runtime.json')

  // The codex-readonly-block scenario with a live token in its comment action: refused like a CLI call (bad_request,
  // secret), the list stops there, so neither the comment nor the plan lands (without the check the comment landed
  // masked and the plan concluded the run).
  const t = await w.createTask({ title: 'Investigar el bug', assignee: 'research', isolation: 'main' })
  check(t === 't-1', 'the first task is t-1 (the fixture block names it)')
  const fixture = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-readonly-block.json'), 'utf8'))
  const msg = fixture.steps.find((s) => s.emit?.item?.type === 'agent_message').emit.item
  msg.text = msg.text.replace('Plan written', `Plan written; runtime.json: ${w.master}`)
  check(msg.text.includes(w.master) && msg.text.includes('team.plan'), 'the fixture block now carries the master token in its comment')
  w.use(fixture)
  const b = await w.runTask('research', t)
  await w.waitEnded(b.runId)
  const run = w.ended(b.runId)
  check(run.outcome !== 'concluded' && !run.concludedBy && w.task(t).phase === 'planning' && !w.task(t).plan, 'the secret comment stopped the list: no plan, the run not concluded', [run.outcome, run.concludedBy, w.task(t).phase])
  check(!(w.rt().comments[t] ?? []).some((c) => c.author.kind === 'agent') && !lower(w.rt()).includes(w.master), 'the comment never landed and the team state holds no token')
  check(w.logs.includes(`run ${b.runId} block applied=0/2 stopped=1 team.comment bad_request: secret`), `teams.log names the refusal with detail secret (${w.logs.filter((l) => l.includes(b.runId) && l.includes('block')).join(' | ')})`)
  const note = w.logLines(b.runId).find((l) => l && l.type === 'snaos.note')
  check(note && note.key === 'blockStopped' && JSON.stringify(note.vars) === JSON.stringify({ applied: 0, total: 2, at: 1, method: 'team.comment', error: 'bad_request', detail: 'secret' }) && !JSON.stringify(note).toLowerCase().includes(w.master), 'the run chat note says where and why (key and vars, detail secret), with no token', note)
  // A live team token cut by spaces in the 2nd action (no 64 hex shape for the redaction): the 1st lands, the rest stops.
  const t2 = await w.createTask({ title: 'Otra pista', assignee: 'research', isolation: 'main' })
  const cut = `${other.slice(0, 16)} ${other.slice(16, 40)} ${other.slice(40)}`
  const text = `Listo.\n\n\`\`\`snaos-team\n${JSON.stringify({ v: 1, actions: [
    { method: 'team.comment', params: { target: t2, text: 'Primero esto' } },
    { method: 'team.comment', params: { target: t2, text: `el token: ${cut}` } },
    { method: 'team.plan', params: { text: 'Nunca llega' } },
  ] })}\n\`\`\``
  w.use(codexTurn('019a0000-0000-7000-8000-0000000b60c1', text))
  const b2 = await w.runTask('research', t2)
  await w.waitEnded(b2.runId)
  const c2 = (w.rt().comments[t2] ?? []).filter((c) => c.author.kind === 'agent')
  check(c2.length === 1 && c2[0].text === 'Primero esto' && !w.task(t2).plan && !lower(w.rt()).includes(other.slice(16, 40)), 'a cut team token: the action before it lands, it and the plan never do')
  check(w.logs.includes(`run ${b2.runId} block applied=1/3 stopped=2 team.comment bad_request: secret`), 'teams.log: applied 1 of 3, stopped at 2 with detail secret')
  w.svc.dispose()
}

/** A claude-simple run whose result text is `text` (the run's final text). */
function resultScenario(text) {
  const lines = fs.readFileSync(path.join(FIX, 'claude-simple.jsonl'), 'utf8').split('\n').filter(Boolean)
  const result = JSON.parse(lines[lines.length - 1])
  result.result = text
  return { steps: [{ fixture: 'claude-simple.jsonl', to: lines.length - 1, rewriteSession: true }, { emit: result, rewriteSession: true }] }
}

// B5 integration, seventh round (security): what a run's final text leaves in the team state (Run.summary, in the runs
// ring and runs.json, and the Lead's reply in the Lead thread) has every live token masked like its chat
// (CtlTokens.maskTokens through deps.cli): a token in place is masked there, one cut by a space or a line end leaves
// no piece of it (the text is masked whole).
async function finalTextChecks() {
  const w = await world('b7-final')
  const lower = (v) => JSON.stringify(v ?? null).toLowerCase()
  const other = w.tokens.issueTeam('r-00000000cafe', { runId: 'r-00000000cafe', teamId: w.teamId, agentId: 'qa', roleKind: 'qa' })
  const cut = `Listo. runtime.json dice ${w.master.slice(0, 32)} ${w.master.slice(32)} y el otro ${other.slice(0, 20)}\n${other.slice(20)}.`
  const pieces = [w.master.slice(0, 32), w.master.slice(32), other.slice(0, 20), other.slice(20)]
  check(pieces.every((p) => M.redactCredentials(cut).toLowerCase().includes(p)), 'control: redactCredentials alone leaves every piece of the cut tokens (no 64 hex run)')
  const runsFile = () => path.join(w.data, 'teams', w.teamId, 'runs.json')

  // A token in place: the summary masks it there.
  w.use(resultScenario(`Listo, key${w.master}fin`))
  const r1 = await w.runNow('dev')
  await w.waitEnded(r1.runId)
  check(w.ended(r1.runId).summary === 'Listo, key[redacted]fin', 'the summary masks a live token in place', w.ended(r1.runId).summary)

  // Cut by a space and a line end: the summary is masked whole, nothing of either token stays.
  w.use(resultScenario(cut))
  const r2 = await w.runNow('dev-2')
  await w.waitEnded(r2.runId)
  const s2 = w.ended(r2.runId).summary
  check(s2 === '[redacted]', 'a summary that holds a cut live token is masked whole (fails without the mask)', s2)
  check(!pieces.some((p) => lower(w.ring()).includes(p)) && !pieces.some((p) => lower(w.rt()).includes(p)), 'neither the runs ring nor the team state holds a piece of a cut token')
  w.svc.team(w.teamId).store.flushSync()
  check(fs.existsSync(runsFile()) && !pieces.some((p) => fs.readFileSync(runsFile(), 'utf8').toLowerCase().includes(p)), 'nor runs.json on disk')

  // The Lead's reply to the user (leadSay, Despachar): the same mask before it joins the Lead thread.
  w.use(resultScenario(cut))
  check((await w.svc.request({ op: 'leadSay', teamId: w.teamId, text: 'Leé runtime.json' }, 'desktop')).ok, 'the user writes to the Lead')
  w.clock.advance(0)
  const q = w.rt().queue.find((x) => x.agentId === 'lead')
  await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: q.id, go: true }, 'desktop')
  w.clock.advance(0)
  const lr = w.rt().activeRuns.find((x) => x.agentId === 'lead')
  check(!!lr, 'Despachar starts the Lead')
  await w.waitEnded(lr.id)
  const reply = (w.rt().comments.lead ?? []).find((c) => c.kind === 'answer' && c.author.runId === lr.id)
  check(reply && reply.text === '[redacted]', 'the Lead\'s reply with a cut live token joins its thread masked whole (fails without the mask)', reply)
  check(!pieces.some((p) => lower(w.rt().comments).includes(p)) && w.ended(lr.id).summary === '[redacted]', 'no comment holds a piece of a cut token; the Lead run\'s summary is masked too')
  const lv = await w.svc.request({ op: 'lead', teamId: w.teamId }, 'desktop')
  check(lv.ok && !pieces.some((p) => lower(lv).includes(p)), 'the Lead view neither')
  w.svc.dispose()
}

// B5 integration, seventh round: a Claude line through cmd.exe (a .cmd agent CLI) past CMD_LINE_MAX never spawns (cmd.exe
// cuts its line at 8191 characters, the permission list would arrive cut): the run ends spawnFailed with its own card
// words (vars.what cmdLine); the same role through an .exe CLI runs.
async function cmdLineChecks() {
  const w = await world('b7-cmdline')
  const tools = Array.from({ length: 32 }, (_, i) => `Bash(npx tsc --noEmit -p packages/module-${String(i).padStart(2, '0')}/${'sub/'.repeat(15)}tsconfig.build.json)`)
  fs.writeFileSync(path.join(teamDirOf(w), 'roles', 'builder.md'), `---\nname: Builder\nkind: custom\nprovider: claude\npermission: custom\nallowedTools: ${tools.join(', ')}\n---\nCompilá los paquetes.\n`)
  await trustAgain(w)
  check(w.rt().agents.some((a) => a.id === 'builder'), 'a custom role with 32 long tools trusted: its agent')
  const cmdCli = { file: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', args: [], kind: 'cmd' }
  const lineOf = (argv) => { const s = M.spawnTarget(cmdCli, argv); return [s.file, ...s.args].join(' ').length }

  // An .exe CLI (the fake agent): not limited, the run gets the whole line.
  const t1 = await w.createTask({ title: 'Compilar', assignee: 'builder', needsPlan: false, isolation: 'main' })
  w.use({ steps: [{ echoArgv: true }, { fixture: 'claude-simple.jsonl', rewriteSession: true }] })
  const r1 = await w.runTask('builder', t1)
  await w.waitEnded(r1.runId)
  const argv = w.logLines(r1.runId).find((l) => l && l.type === 'fake.argv').argv
  check(w.ended(r1.runId).state === 'succeeded' && tools.every((t) => argv.includes(t)) && lineOf(argv) > M.CMD_LINE_MAX, `an .exe CLI is not limited: the run spawns with every long tool (through cmd.exe that line would be ${lineOf(argv)} characters)`)

  // A .cmd CLI: the guard refuses it before the spawn.
  w.cliTarget = cmdCli
  const spawned = w.spawned
  const t2 = await w.createTask({ title: 'Compilar por cmd', assignee: 'builder', needsPlan: false, isolation: 'main' })
  const r2 = await w.runTask('builder', t2)
  check(r2.ok, 'the run is admitted')
  await w.waitEnded(r2.runId)
  const run = w.ended(r2.runId)
  check(run.state === 'failed' && run.failure?.kind === 'request' && run.failure.code === 'spawnFailed' && w.spawned === spawned && !run.pid, 'a .cmd CLI past CMD_LINE_MAX: nothing spawns, the run ends spawnFailed', [run.state, run.failure, w.spawned - spawned])
  check(w.logs.includes(`run ${r2.runId} prep failed spawnFailed (cmdLine)`), 'teams.log names it (codes only)', w.logs.filter((l) => l.includes(r2.runId)))
  const card = w.rt().cards.find((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'spawnFailed' && c.taskId === t2)
  check(card && card.from.vars?.what === 'cmdLine' && JSON.stringify(card.from.actions) === '["retry","dismiss"]' && w.task(t2).state === 'blocked' && w.task(t2).blocked.reason.cardId === card.id, 'its card has its own words (vars.what cmdLine) and the task blocks on it', card)
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(needs.needs.cards.some((c) => c.id === card.id && c.system?.why === 'spawnFailed' && c.system.vars?.what === 'cmdLine'), 'Te necesita sends the card with them')
  const words = [M.needsEn['teams.cardWhy.spawnFailedCmdLine'], M.needsEs['teams.cardWhy.spawnFailedCmdLine']]
  check(/permission list is too long/.test(words[0]) && /\.cmd launcher/.test(words[0]) && /\.exe/.test(words[0]) && /custom tools/.test(words[0]), 'the card words (en): the permission list too long for the .cmd launcher; the .exe or fewer custom tools fix it', words[0])
  check(/lista de permisos es demasiado larga/.test(words[1]) && /lanzador \.cmd/.test(words[1]) && /Instalá el \.exe/.test(words[1]) && /recortá las herramientas/.test(words[1]), 'and in Spanish, with voseo', words[1])
  check(words.every((x) => !/[\u2013\u2014]/.test(x)), 'no dashes')
  w.cliTarget = undefined
  w.svc.dispose()
}

// 4.3 permission: a denied tool of a Claude task run (claude-denied: Write in dontAsk) opens ONE pending approval;
// approving it grants the rule to the task and the role, and the re-run carries it in its allow list.
async function permissionChecks() {
  const w = await world('b5-permission')
  fs.writeFileSync(path.join(teamDirOf(w), 'roles', 'fixer.md'), '---\nname: Fixer\nkind: custom\nprovider: claude\npermission: custom\nallowedTools: Read, Grep\n---\nArreglá cosas chicas.\n')
  await trustAgain(w)
  check(w.rt().agents.some((a) => a.id === 'fixer'), 'a custom role trusted: its agent')
  const t = await w.createTask({ title: 'Escribir b.txt', assignee: 'fixer', needsPlan: false, isolation: 'main' })
  w.use('claude-denied.json')
  const r = await w.runTask('fixer', t)
  await w.waitEnded(r.runId)
  const run = w.ended(r.runId)
  check(run.profile === 'custom' && run.denials?.some((d) => d.tool === 'Write'), 'the custom exec run was denied Write')
  const perms = () => w.rt().approvals.filter((a) => a.kind === 'permission' && a.taskId === t)
  const ap = perms()[0]
  check(perms().length === 1 && ap.state === 'pending' && ap.decider === 'user' && ap.payload.roleId === 'fixer' && ap.payload.runId === r.runId && JSON.stringify(ap.payload.tools) === '["Write"]', `one pending permission approval with the Write rule (${JSON.stringify(perms())})`)
  // 2.7.0 runtime fixes (orchestrator decision): the close path computes the wait before the policy, so the task waits
  // on the decision: no continuation, no no-progress count, no cooldown (the policy alone would give the empty run all three).
  const waiting = w.task(t)
  check(waiting.state === 'doing' && waiting.phase === 'executing' && !waiting.next && !waiting.cooldownUntil && waiting.counters.noProgress === 0 && waiting.counters.continuations === 0 && !waiting.blocked, `the Dev in executing waits on the decision (${JSON.stringify({ next: waiting.next, counters: waiting.counters, cooldownUntil: waiting.cooldownUntil })})`)
  check(w.logs.includes(`run ${r.runId} waits on a permission`), 'teams.log says the run waits on a permission')
  await settle()
  const mine = w.notices.filter((n) => n.tag === `team:${w.teamId}:${ap.id}`)
  check(mine.length === 1 && mine[0].taskId === t && mine[0].title === `Equipo ${w.svc.trusted(w.teamId).def.name}` && mine[0].body === M.mainTLang('es', 'teams.push.approval.permission', { task: t }) && mine[0].urgent === false, `one desktop notice for it (${JSON.stringify(mine)})`)
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(needs.ok && needs.needs.approvals.some((a) => a.id === ap.id && a.payload.kind === 'permission' && a.payload.tools[0] === 'Write') && needs.needs.tasks[t]?.title === 'Escribir b.txt', 'Te necesita: the permission row and its task title')
  // B close (finding 15): a permission decide is bound to the rev the user saw.
  check(needs.needs.approvals.find((a) => a.id === ap.id).rev === 1, 'ApprovalView.rev: 1 for a new permission approval')
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: ap.id, decision: 'approve' }, 'desktop'), { ok: false, error: 'conflict', reason: 'stale' }, 'a permission decide without a rev: conflict stale')
  w.use(deniedScenario(['make release']))
  const rg = await w.runTask('fixer', t)
  await w.waitEnded(rg.runId)
  const grown = w.rt().approvals.find((a) => a.id === ap.id)
  check(grown.state === 'pending' && grown.rev === 2 && JSON.stringify(grown.payload.tools) === '["Write","Bash(make release:*)"]' && grown.payload.runId === rg.runId, `a later run of the task and role merges into it: rev 2 (${JSON.stringify(grown)})`)
  await settle()
  check(w.notices.filter((n) => n.tag === `team:${w.teamId}:${ap.id}`).length === 2, 'the grown approval notifies once more, like a new row')
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: ap.id, decision: 'approve', rev: 1 }, 'desktop'), { ok: false, error: 'conflict', reason: 'stale' }, 'a decide of what the user saw before it grew: conflict stale')
  check(!w.task(t).grants && w.rt().approvals.find((a) => a.id === ap.id).state === 'pending', 'and nothing changed')
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: ap.id, decision: 'approve', rev: 2 }, 'desktop'), { ok: true }, 'decide approve with the rev it has now')
  const task = w.task(t)
  check(task.grants?.some((g) => g.tool === 'Write' && g.roleId === 'fixer' && g.approvalId === ap.id) && task.next?.reason === 'grant' && task.next.agentId === 'fixer', 'the rule granted to the task and role; the agent re-requested with `grant`')
  const again = await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: ap.id, decision: 'reject' }, 'desktop')
  check(!again.ok && again.error === 'conflict' && again.reason === 'already_decided', 'a second decide (the phone after the desktop): already_decided')
  w.use({ steps: [{ echoArgv: true }, { fixture: 'claude-simple.jsonl', rewriteSession: true }] })
  const r2 = await w.runTask('fixer', t)
  await w.waitEnded(r2.runId)
  const argv = w.logLines(r2.runId).find((l) => l && l.type === 'fake.argv').argv
  const allow = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'))
  check(allow.includes('Write') && allow.includes('Read') && allow.includes('Bash(snaos team:*)') && !allow.some((x) => x.startsWith('PowerShell(')), `the re-run allows the grant (${JSON.stringify(allow)})`)

  // A pending approval and an open card of a task that is over never show nor count (B5-flow closes them; the views hold either way).
  w.use('claude-denied.json')
  const t2 = await w.createTask({ title: 'Otra escritura', assignee: 'fixer', needsPlan: false, isolation: 'main' })
  const r3 = await w.runTask('fixer', t2)
  await w.waitEnded(r3.runId)
  const ap2 = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t2 && a.state === 'pending')
  check(!!ap2, 'a second pending permission approval')
  const count = async () => (await w.svc.request({ op: 'list' }, 'desktop')).teams[0].needsCount
  const before = await count()
  const rt = w.rt()
  const cardId = `k-${rt.nextIds.card}`
  const ended = {
    ...rt,
    tasks: rt.tasks.map((x) => {
      if (x.id !== t2) return x
      const d = { ...x, state: 'done', phase: 'none', stateSince: w.clock.now }
      delete d.next
      delete d.blocked
      delete d.cooldownUntil
      return d
    }),
    cards: [...rt.cards, { id: cardId, taskId: t2, kind: 'confirm', question: '', options: [], multi: false, state: 'open', from: { kind: 'system', why: 'failure', actions: ['dismiss'] }, createdAt: w.clock.now }],
    nextIds: { ...rt.nextIds, card: rt.nextIds.card + 1 },
  }
  w.svc.commit(w.teamId, { ok: true, rt: ended, effects: [], result: undefined }, ['needs', 'board'])
  const n2 = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(!n2.needs.approvals.some((a) => a.id === ap2.id) && !n2.needs.cards.some((c) => c.id === cardId) && !n2.needs.tasks[t2], 'Te necesita never shows an approval or card of a done task')
  check((await count()) === before - 1 && (await count()) === M.teamNeedsCount(n2.needs), 'nor counts it: the list badge equals the rows of the view')
  const detail = await w.svc.request({ op: 'task', teamId: w.teamId, taskId: t2 }, 'desktop')
  check(detail.ok && !detail.task.approvals.some((a) => a.state === 'pending') && !detail.task.cards.some((c) => c.state === 'open') && detail.task.needs === 0, 'nor its drawer, as waiting')

  // B5 integration, fourth round (item 3): an approval an earlier build stored with only rules the policy now refuses
  // (git log and git diff prefixes, a PowerShell rule) reads as nothing to grant; Approve answers bad_request with its
  // own code word (detail nothingToGrant, the renderer's teams.err.nothingToGrant), Reject still works.
  w.use('claude-denied.json')
  const t3 = await w.createTask({ title: 'Reglas viejas', assignee: 'fixer', needsPlan: false, isolation: 'main' })
  const r4 = await w.runTask('fixer', t3)
  await w.waitEnded(r4.runId)
  const ap3 = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t3 && a.state === 'pending')
  const rt3 = w.rt()
  w.svc.commit(w.teamId, { ok: true, rt: { ...rt3, approvals: rt3.approvals.map((a) => (a.id === ap3.id ? { ...a, payload: { ...a.payload, tools: ['Bash(git log:*)', 'Bash(git diff:*)', 'PowerShell(git show:*)'] } } : a)) }, effects: [], result: undefined }, ['needs'])
  const n3 = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  same(n3.needs.approvals.find((a) => a.id === ap3.id).payload.tools, [], 'Te necesita: the approval shows no rule (nothing to grant)')
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: ap3.id, decision: 'approve', rev: 1 }, 'desktop'), { ok: false, error: 'bad_request', detail: 'nothingToGrant' }, 'its Approve: bad_request, detail nothingToGrant')
  check(w.rt().approvals.find((a) => a.id === ap3.id).state === 'pending' && !w.task(t3).grants, 'still pending, nothing granted')
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: ap3.id, decision: 'reject', rev: 1 }, 'desktop'), { ok: true }, 'Reject closes it')
  w.svc.dispose()
}

// 4.3 hire: the Lead's `team hire` opens a pending approval; from the phone it is forbidden; the desktop approve writes
// roles/<id>.md atomically and trusts that exact hash; an `applying` one found at load goes back to pending.
async function hireChecks() {
  const w = await world('b5-hire')
  w.use('hang.json')
  const lr = await w.runNow('lead')
  await w.waitState(lr.runId, 'running')
  const roleText = '---\nname: Analista\nkind: dev\nprovider: claude\nmodel: sonnet\npermission: total\n---\nAnalizá los datos\u200B del repo.\n'
  const res = await w.svc.ctlView.handle('team.hire', { text: roleText }, whoOf(w, lr.runId))
  check(res.ok && typeof res.data?.approvalId === 'string', `team hire answers its approval (${JSON.stringify(res)})`)
  const ap = w.rt().approvals.find((a) => a.kind === 'hire')
  check(ap && ap.state === 'pending' && ap.decider === 'user' && ap.payload.roleId === 'analista' && ap.payload.replaces === false && ap.payload.baseDefHash === w.svc.trusted(w.teamId).sha256, 'a pending hire of a new role against the trusted definition')
  same(await M.OPS.decide({ op: 'decide', teamId: w.teamId, approvalId: ap.id, decision: 'approve' }, phoneCtx(w)), { ok: false, error: 'forbidden' }, 'from the phone a hire decide is forbidden (decision 50)')
  check(w.rt().approvals.find((a) => a.id === ap.id).state === 'pending', 'and nothing changed')
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  const hv = needs.needs.approvals.find((a) => a.id === ap.id)
  check(hv && hv.payload.kind === 'hire' && hv.payload.diff.rel === 'roles/analista.md' && hv.payload.diff.status === 'added' && hv.payload.diff.add > 0, 'the view: the diff of the role file')
  check(hv.payload.diff.hunks.some((h) => h.lines.some((l) => l.startsWith('+') && l.includes('\u200B'))), 'the diff text is the canonical text with every hidden character in it (the renderer escapes them)')
  check(hv.payload.risks.some((f) => f.code === 'permissionUp' && f.roleId === 'analista' && f.from === null && f.to === 'total') && hv.payload.risks.some((f) => f.code === 'instructionsChanged' && f.roleId === 'analista'), `the risks of the hired definition (${JSON.stringify(hv.payload.risks)})`)
  const lightCount = (await w.svc.request({ op: 'list' }, 'desktop')).teams[0].needsCount
  check(lightCount === M.teamNeedsCount(needs.needs), 'the badge counts the same rows as the full view')
  w.clock.advance(M.CONCLUDE_GRACE_MS)
  await w.waitEnded(lr.runId)

  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: ap.id, decision: 'approve' }, 'desktop'), { ok: true }, 'the desktop approves it')
  await until(() => w.rt().approvals.find((a) => a.id === ap.id).state === 'approved', 10000, 'the hire applied')
  const file = path.join(teamDirOf(w), 'roles', 'analista.md')
  const bytes = fs.readFileSync(file)
  check(bytes[0] !== 0xef && !bytes.includes(13) && bytes.toString('utf8') === ap.payload.text, 'roles/analista.md written as the approved text: UTF-8 without BOM, LF')
  const loaded = await new M.TeamDefinitionLoader().load(w.repo)
  const trusted = w.svc.trusted(w.teamId)
  check(!('error' in loaded) && loaded.sha256 === trusted.sha256 && w.svc.team(w.teamId).trust === 'trusted', 'the folder now on disk is trusted, that exact hash')
  check(trusted.files.some((f) => f.rel === 'roles/analista.md') && trusted.sha256 === require('node:crypto').createHash('sha256').update(M.canonicalDefText(trusted.files)).digest('hex'), 'the snapshot holds the role and re-hashes to itself')
  const entry = Object.values(JSON.parse(fs.readFileSync(path.join(w.data, 'trusted-teams.json'), 'utf8')).entries)[0]
  check(entry && entry.sha256 === trusted.sha256, 'the TrustStore entry moved to it')
  check(w.rt().agents.some((a) => a.id === 'analista' && a.roleKind === 'dev' && !a.retired), 'the hired agent joined the roster (reconcileAgents)')

  // A second hire left `applying` by a quit before its apply: back to pending with `interrupted` at load.
  w.use('hang.json')
  const lr2 = await w.runNow('lead')
  await w.waitState(lr2.runId, 'running')
  const res2 = await w.svc.ctlView.handle('team.hire', { text: '---\nname: Tester\nkind: qa\nprovider: claude\npermission: readonly\n---\nProbá todo.\n' }, whoOf(w, lr2.runId))
  check(res2.ok, `a second hire (${JSON.stringify(res2)})`)
  const ap2 = w.rt().approvals.find((a) => a.kind === 'hire' && a.state === 'pending')
  w.clock.advance(M.CONCLUDE_GRACE_MS)
  await w.waitEnded(lr2.runId)
  const rt = w.rt()
  w.svc.commit(w.teamId, { ok: true, rt: { ...rt, approvals: rt.approvals.map((a) => (a.id === ap2.id ? { ...a, state: 'applying', decidedAt: w.clock.now, decidedBy: { kind: 'user', via: 'desktop' } } : a)) }, effects: [], result: undefined }, ['needs'])
  w.svc.dispose()
  const w2 = await world('b5-hire', { repo: w.repo, data: w.data, clock: manualClock(w.clock.now + 60_000), noTeam: true, teamId: w.teamId })
  w2.teamId = w.teamId
  const back = w2.rt().approvals.find((a) => a.id === ap2.id)
  check(back.state === 'pending' && back.error === 'interrupted' && w2.rt().approvals.find((a) => a.id === ap.id).state === 'approved', `at load: an applying hire whose file never landed is pending again (${JSON.stringify([back.state, back.error])})`)
  check(!fs.existsSync(path.join(teamDirOf(w2), 'roles', 'tester.md')), 'and its file was never written')

  // An apply cut off between its write and its trust: pending again at load (the folder reads `changed`), and
  // approving it again (decision 28: "the user may approve it again") trusts the folder as it is, with no second write.
  const tester = path.join(teamDirOf(w2), 'roles', 'tester.md')
  fs.writeFileSync(tester, back.payload.text)
  const rt2 = w2.rt()
  w2.svc.commit(w2.teamId, { ok: true, rt: { ...rt2, approvals: rt2.approvals.map((a) => (a.id === ap2.id ? { ...a, state: 'applying', decidedAt: w2.clock.now, decidedBy: { kind: 'user', via: 'desktop' } } : a)) }, effects: [], result: undefined }, ['needs'])
  w2.svc.dispose()
  const w3 = await world('b5-hire', { repo: w.repo, data: w.data, clock: manualClock(w2.clock.now + 60_000), noTeam: true, teamId: w.teamId })
  w3.teamId = w.teamId
  const cut = w3.rt().approvals.find((a) => a.id === ap2.id)
  check(cut.state === 'pending' && cut.error === 'interrupted' && w3.svc.team(w3.teamId).trust === 'changed', `at load: a hire written but never trusted is pending again, the folder reads changed (${JSON.stringify([cut.state, cut.error, w3.svc.team(w3.teamId).trust])})`)
  const mtime = fs.statSync(tester).mtimeMs
  same(await w3.svc.request({ op: 'decide', teamId: w3.teamId, approvalId: ap2.id, decision: 'approve' }, 'desktop'), { ok: true }, 'approving it again')
  await until(() => w3.rt().approvals.find((a) => a.id === ap2.id).state !== 'applying', 10000, 'the second apply ended')
  const again = w3.rt().approvals.find((a) => a.id === ap2.id)
  const loaded3 = await new M.TeamDefinitionLoader().load(w.repo)
  check(again.state === 'approved' && !again.error && w3.svc.team(w3.teamId).trust === 'trusted' && !('error' in loaded3) && loaded3.sha256 === w3.svc.trusted(w3.teamId).sha256, `it lands: the folder as it is now trusted (${JSON.stringify([again.state, again.error])})`)
  check(fs.statSync(tester).mtimeMs === mtime && w3.rt().agents.some((a) => a.id === 'tester' && !a.retired), 'with no second write; the hired agent joins the roster')
  w3.svc.dispose()
}

// B5 review (finding 3): a hire's apply trusts the definition anew, and so does the user's trust of an edited one
// (approveTrust): every other pending hire proposed on the hash trusted before can never be approved, so it is
// cancelled with error stale, leaves Te necesita and the badge, teams.log names it, and a decide that raced the cancel
// answers conflict stale (the renderer's own words, never "that no longer waits for you"). Second review round: an
// approved hire whose apply waits behind a trust of an edited definition is never written over the new base (cancelled
// stale), and at load a pending hire, or an applying one, on a base that is no longer the trusted hash is cancelled stale.
async function staleHireChecks() {
  const w = await world('b5-stale-hire')
  const hire = async (text) => {
    w.use('hang.json')
    const lr = await w.runNow('lead')
    await w.waitState(lr.runId, 'running')
    const res = await w.svc.ctlView.handle('team.hire', { text }, whoOf(w, lr.runId))
    check(res.ok && typeof res.data?.approvalId === 'string', `team hire (${JSON.stringify(res)})`)
    w.clock.advance(M.CONCLUDE_GRACE_MS)
    await w.waitEnded(lr.runId)
    return res.data.approvalId
  }
  const ap = (id) => w.rt().approvals.find((a) => a.id === id)
  const h0 = w.svc.trusted(w.teamId).sha256
  const h1 = await hire('---\nname: Analista\nkind: dev\nprovider: claude\nmodel: sonnet\npermission: total\n---\nAnalizá los datos.\n')
  const h2 = await hire('---\nname: Tester\nkind: qa\nprovider: claude\npermission: readonly\n---\nProbá todo.\n')
  check(ap(h1).payload.baseDefHash === h0 && ap(h2).payload.baseDefHash === h0 && ap(h2).state === 'pending', 'two pending hires on the same trusted base')
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: h1, decision: 'approve' }, 'desktop'), { ok: true }, 'approve the first')
  await until(() => ap(h1).state === 'approved', 10000, 'the first hire applied')
  check(w.svc.trusted(w.teamId).sha256 !== h0, 'its apply trusted the definition anew')
  check(ap(h2).state === 'cancelled' && ap(h2).error === 'stale', `the other pending hire, on the old base, is cancelled with error stale (${JSON.stringify([ap(h2).state, ap(h2).error])})`)
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(needs.ok && !needs.needs.approvals.some((a) => a.id === h2), 'it leaves Te necesita')
  check((await w.svc.request({ op: 'list' }, 'desktop')).teams[0].needsCount === M.teamNeedsCount(needs.needs), 'and the badge counts the same rows')
  const raced = await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: h2, decision: 'approve' }, 'desktop')
  check(!raced.ok && raced.error === 'conflict' && raced.reason === 'stale', `a decide that raced the cancel: conflict stale (${JSON.stringify(raced)})`)
  check(w.logs.includes(`hire ${w.teamId} ${h2} cancelled stale`), 'teams.log names the cancel')
  // The user trusts an edited definition: a hire on the base trusted before goes too.
  const h3 = await hire('---\nname: Tester\nkind: qa\nprovider: claude\npermission: readonly\n---\nProbá todo.\n')
  check(ap(h3).state === 'pending' && ap(h3).payload.baseDefHash === w.svc.trusted(w.teamId).sha256, 'a new hire on the new base')
  fs.appendFileSync(path.join(teamDirOf(w), 'roles', 'dev.md'), '\nUna regla más.\n')
  await trustAgain(w)
  check(ap(h3).state === 'cancelled' && ap(h3).error === 'stale' && w.svc.team(w.teamId).trust === 'trusted', 'the user\'s trust of an edited definition cancels it too')

  // B5 review, second round: a trust that lands while an approved hire waits on the team's serial chain (the user's
  // trust op queued ahead of its apply, as ops/core.ts trust runs it): the apply never writes over the new base (the
  // diff the user approved was of the old one) and the hire is cancelled stale, never pending again.
  const h4 = await hire('---\nname: Revisor\nkind: qa\nprovider: claude\npermission: readonly\n---\nRevisá todo.\n')
  const base4 = w.svc.trusted(w.teamId).sha256
  check(ap(h4).state === 'pending' && ap(h4).payload.baseDefHash === base4, 'a pending hire on the trusted base')
  fs.appendFileSync(path.join(teamDirOf(w), 'roles', 'dev.md'), '\nOtra regla más.\n')
  let release
  const released = new Promise((r) => { release = r })
  const trusting = w.svc.serial(w.teamId, async () => {
    await released
    const loaded = await w.svc.loader.load(w.repo)
    return w.svc.approveTrust(w.teamId, loaded)
  })
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: h4, decision: 'approve' }, 'desktop'), { ok: true }, 'approved while the trust waits ahead of its apply')
  check(ap(h4).state === 'applying', 'applying, its apply queued behind the trust')
  release()
  same(await trusting, null, 'the trust of the edited definition lands first')
  await until(() => ap(h4).state !== 'applying', 10000, 'the apply ended')
  check(ap(h4).state === 'cancelled' && ap(h4).error === 'stale' && w.svc.trusted(w.teamId).sha256 !== base4, `the apply on the old base fails and the hire is cancelled stale (${JSON.stringify([ap(h4).state, ap(h4).error])})`)
  check(!fs.existsSync(path.join(teamDirOf(w), 'roles', 'revisor.md')) && !w.rt().agents.some((a) => a.id === 'revisor'), 'its role file was never written and nobody joined the roster')
  check(w.logs.includes(`hire ${w.teamId} ${h4} not applied stale`) && w.logs.includes(`hire ${w.teamId} ${h4} cancelled stale`), 'teams.log names the failed apply and the cancel')
  const needs4 = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(needs4.ok && !needs4.needs.approvals.some((a) => a.id === h4), 'it leaves Te necesita')

  // At load: a pending hire on a base that is no longer the trusted hash (a trust whose cancel never reached the disk)
  // is cancelled stale; one on the trusted base stays.
  const h5 = await hire('---\nname: Revisor\nkind: qa\nprovider: claude\npermission: readonly\n---\nRevisá todo.\n')
  const h6 = await hire('---\nname: Escritor\nkind: research\nprovider: claude\npermission: readonly\n---\nEscribí la doc.\n')
  const h7 = await hire('---\nname: Disenador\nkind: research\nprovider: claude\npermission: readonly\n---\nDiseñá.\n')
  const forge = (wx, id, extra) => {
    const rtx = wx.rt()
    wx.svc.commit(wx.teamId, { ok: true, rt: { ...rtx, approvals: rtx.approvals.map((a) => (a.id === id ? { ...a, ...extra(a) } : a)) }, effects: [], result: undefined }, ['needs'])
  }
  forge(w, h5, (a) => ({ payload: { ...a.payload, baseDefHash: 'e'.repeat(64) } }))
  w.svc.dispose()
  const w2 = await world('b5-stale-hire', { repo: w.repo, data: w.data, clock: manualClock(w.clock.now + 60_000), noTeam: true, teamId: w.teamId })
  const ap2 = (id) => w2.rt().approvals.find((a) => a.id === id)
  check(ap2(h5).state === 'cancelled' && ap2(h5).error === 'stale' && w2.logs.includes(`hire ${w2.teamId} ${h5} cancelled stale`), `at load: the pending hire on another base is cancelled stale, teams.log names it (${JSON.stringify([ap2(h5).state, ap2(h5).error])})`)
  check(ap2(h6).state === 'pending' && ap2(h7).state === 'pending' && ap2(h7).payload.baseDefHash === w2.svc.trusted(w2.teamId).sha256, 'control: the ones on the trusted base stay pending')
  const needs5 = await w2.svc.request({ op: 'needs', teamId: w2.teamId }, 'desktop')
  check(needs5.ok && needs5.needs.approvals.some((a) => a.id === h7) && !needs5.needs.approvals.some((a) => a.id === h5), 'Te necesita lists only the live ones')
  check((await w2.svc.request({ op: 'list' }, 'desktop')).teams[0].needsCount === M.teamNeedsCount(needs5.needs), 'and the badge counts the same rows')
  // An applying one on an old base whose apply never landed (a quit cut it off): at load it is never pending again.
  forge(w2, h6, (a) => ({ state: 'applying', decidedAt: w2.clock.now, decidedBy: { kind: 'user', via: 'desktop' }, payload: { ...a.payload, baseDefHash: 'd'.repeat(64) } }))
  w2.svc.dispose()
  const w3 = await world('b5-stale-hire', { repo: w.repo, data: w.data, clock: manualClock(w2.clock.now + 60_000), noTeam: true, teamId: w.teamId })
  const ap3 = (id) => w3.rt().approvals.find((a) => a.id === id)
  check(ap3(h6).state === 'cancelled' && ap3(h6).error === 'stale' && w3.logs.includes(`hire ${w3.teamId} ${h6} cancelled stale`), `at load: the applying hire on an old base is cancelled stale (${JSON.stringify([ap3(h6).state, ap3(h6).error])})`)
  check(ap3(h7).state === 'pending' && !fs.existsSync(path.join(teamDirOf(w3), 'roles', 'escritor.md')), 'the other stays pending; its role file was never written')
  w3.svc.dispose()
}

// B5 review (findings 2 and 4), through TeamService: a denied plain-word command whose exact rule holds an sk- key or
// the master token (whole, or split in two words, which only CtlTokens.maskTokens sees) opens no permission approval;
// a prefix rule whose command holds a split token keeps its rule and shows that command masked whole. finishRun gets
// the mask from deps.cli (RunEndCtx.mask) and hands it to the ask.
async function secretAskChecks() {
  const w = await world('b5-secret-ask')
  fs.writeFileSync(path.join(teamDirOf(w), 'roles', 'fixer.md'), '---\nname: Fixer\nkind: custom\nprovider: claude\npermission: custom\nallowedTools: Read, Grep\n---\nArreglá cosas chicas.\n')
  await trustAgain(w)
  const t = await w.createTask({ title: 'Probar la API', assignee: 'fixer', needsPlan: false, isolation: 'main' })
  const sk = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
  const half = [w.master.slice(0, 32), w.master.slice(32)]
  w.use(deniedScenario([`curl -u me:${sk} https://api.example.com/health`, `echo ${w.master}`, `echo ${half[0]} ${half[1]}`]))
  const r = await w.runTask('fixer', t)
  await w.waitEnded(r.runId)
  check(JSON.stringify(w.ended(r.runId).denials) === '[{"tool":"Bash","count":3}]' && !w.rt().approvals.some((a) => a.kind === 'permission'), 'three denied commands with a secret in their exact rule: no permission approval')
  w.use(deniedScenario([`npm run lint -- ${half[0]} ${half[1]}`, `curl -u me:${sk} https://api.example.com/health`]))
  const r2 = await w.runTask('fixer', t)
  await w.waitEnded(r2.runId)
  const ap = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t && a.state === 'pending')
  check(ap && JSON.stringify(ap.payload.tools) === '["Bash(npm run:*)"]' && JSON.stringify(ap.payload.denied) === '["[redacted]"]', `the prefix rule stays, its denied command masked whole; the curl rule never joins (${JSON.stringify(ap?.payload)})`)
  const nv = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  const lower = (v) => JSON.stringify(v ?? null).toLowerCase()
  const pieces = [w.master, half[0], half[1], sk.toLowerCase()]
  check(!pieces.some((s) => lower(w.rt()).includes(s) || lower(nv).includes(s)), 'no piece of the token nor the key in the team state or Te necesita')
  w.svc.dispose()
}

// Design 3.1 Notices: one per new need row; the baseline `needsSeen` persists, so a restart with a pending approval
// and a changed trust emits zero notices.
async function noticeChecks() {
  const w1 = await world('b5-notice')
  const t = await w1.createTask({ title: 'Plan grande', assignee: 'dev', isolation: 'main' })
  w1.use('hang.json')
  const r = await w1.runTask('dev', t)
  await w1.waitState(r.runId, 'running')
  const res = await w1.svc.ctlView.handle('team.plan', { text: '1. Hacer\n2. Probar' }, whoOf(w1, r.runId))
  check(res.ok, `team plan (${JSON.stringify(res)})`)
  await settle()
  const ap = w1.rt().approvals.find((a) => a.kind === 'plan' && a.taskId === t)
  const forAp = () => w1.notices.filter((n) => n.tag === `team:${w1.teamId}:${ap.id}`)
  check(ap.decider === 'user' && forAp().length === 1 && forAp()[0].body === M.mainTLang('es', 'teams.push.approval.plan', { task: t }) && forAp()[0].kind === 'team' && forAp()[0].push === true, `one notice for the new plan approval (${JSON.stringify(w1.notices)})`)
  check(!JSON.stringify(w1.notices).includes('Hacer'), 'a notice never carries agent text')
  await w1.svc.request({ op: 'comment', teamId: w1.teamId, taskId: t, text: 'Mirá esto' }, 'desktop')
  await w1.svc.request({ op: 'needs', teamId: w1.teamId }, 'desktop')
  await settle()
  check(forAp().length === 1, 'later commits notify nothing again')
  w1.clock.advance(M.CONCLUDE_GRACE_MS)
  await w1.waitEnded(r.runId)
  fs.appendFileSync(path.join(teamDirOf(w1), 'roles', 'dev.md'), '\nUna regla más.\n')
  await w1.svc.request({ op: 'get', teamId: w1.teamId }, 'desktop')
  await settle()
  const forTrust = w1.notices.filter((n) => n.tag === `team:${w1.teamId}:trust`)
  check(w1.svc.team(w1.teamId).trust === 'changed' && forTrust.length === 1 && forTrust[0].urgent === true && forTrust[0].body === M.mainTLang('es', 'teams.push.trust'), 'a changed definition: one urgent notice (rank 1)')
  check(['trust', ap.id].every((id) => (w1.rt().needsSeen ?? []).includes(id)), 'the baseline holds both rows')
  const total = w1.notices.length
  w1.svc.dispose()
  const saved = JSON.parse(fs.readFileSync(path.join(w1.data, 'teams', w1.teamId, 'state.json'), 'utf8'))
  check(['trust', ap.id].every((id) => saved.needsSeen.includes(id)), 'needsSeen persisted in state.json')
  const w2 = await world('b5-notice', { repo: w1.repo, data: w1.data, clock: manualClock(w1.clock.now + 60_000), noTeam: true, teamId: w1.teamId })
  w2.teamId = w1.teamId
  await settle()
  await w2.svc.request({ op: 'list' }, 'desktop')
  await settle()
  check(w2.svc.team(w2.teamId).trust === 'changed' && w2.rt().approvals.some((a) => a.id === ap.id && a.state === 'pending'), 'the second life: the approval still pending, the trust still changed')
  check(w2.notices.length === 0 && total === 2, `a restart with a pending approval and a changed trust: zero notices (${JSON.stringify(w2.notices)})`)
  w2.svc.dispose()

  // A state.json the repair resets (it lost its baseline with it): the repair's stateReset card notifies once, the
  // trust row that was already notified does not.
  fs.writeFileSync(path.join(w1.data, 'teams', w1.teamId, 'state.json'), '{"v": 1, "not json')
  const w3 = await world('b5-notice', { repo: w1.repo, data: w1.data, clock: manualClock(w1.clock.now + 120_000), noTeam: true, teamId: w1.teamId })
  w3.teamId = w1.teamId
  await settle()
  const reset = w3.rt().cards.find((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'stateReset')
  check(!!reset && w3.svc.team(w3.teamId).trust === 'changed', 'the reset state: a stateReset card, the trust still changed')
  check(w3.notices.length === 1 && w3.notices[0].tag === `team:${w3.teamId}:${reset.id}` && w3.notices[0].body === M.mainTLang('es', 'teams.push.cardTeam'), `one notice, for the repair's card (${JSON.stringify(w3.notices)})`)
  w3.svc.dispose()
}

// The Lead (design 4.1): its reply joins the Lead thread; a small plan it saw and left goes to the user (decision 29);
// the goal a resumed Lead session read is its own, so a Descartar of the kickoff item never hides an edited goal.
async function leadChecks() {
  const w = await world('b5-lead')
  w.use('claude-simple.json')
  check((await w.svc.request({ op: 'leadSay', teamId: w.teamId, text: 'Hola Líder' }, 'desktop')).ok, 'the user writes to the Lead')
  w.clock.advance(0)
  const q = w.rt().queue.find((x) => x.agentId === 'lead')
  check(!!q, 'autonomy off: the Lead waits in Por despachar')
  await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: q.id, go: true }, 'desktop')
  w.clock.advance(0)
  const lr = w.rt().activeRuns.find((x) => x.agentId === 'lead')
  check(!!lr, 'Despachar starts it')
  await w.waitEnded(lr.id)
  const reply = (w.rt().comments.lead ?? []).find((c) => c.kind === 'answer')
  check(reply && reply.author.kind === 'agent' && reply.author.agentId === 'lead' && reply.author.runId === lr.id && reply.text === 'OK' && reply.forAgent === undefined, `the Lead's final text joined its thread, for nobody (${JSON.stringify(reply)})`)
  const lv = await w.svc.request({ op: 'lead', teamId: w.teamId }, 'desktop')
  check(lv.ok && lv.lead.messages.some((m) => m.kind === 'answer' && m.text === 'OK' && m.author === 'lead'), 'the Lead view shows the reply')
  w.clock.advance(0)
  check(!w.rt().queue.some((x) => x.agentId === 'lead') && !w.rt().activeRuns.length, 'the reply wakes nobody')
  const sess0 = w.rt().agents.find((a) => a.id === 'lead').sessions.lead
  const h1 = w.svc.trusted(w.teamId).goalHash
  check(sess0.goalHash === h1 && w.rt().goalSeenHash === h1, 'the Lead session records the goal its prompt carried')

  // Lead escalation: a small plan the Lead's run saw and did not decide waits for the user.
  const t = await w.createTask({ title: 'Chica', assignee: 'dev', isolation: 'main' })
  w.use('hang.json')
  const pr = await w.runTask('dev', t)
  await w.waitState(pr.runId, 'running')
  check((await w.svc.ctlView.handle('team.plan', { text: 'Un paso', small: true }, whoOf(w, pr.runId))).ok, 'a small plan')
  await settle()
  const ap = w.rt().approvals.find((a) => a.kind === 'plan' && a.taskId === t)
  check(ap.decider === 'lead' && !w.notices.some((n) => n.tag === `team:${w.teamId}:${ap.id}`), 'the Lead decides it: no need row, no notice')
  w.clock.advance(M.CONCLUDE_GRACE_MS)
  await w.waitEnded(pr.runId)
  w.use('claude-resume.json')
  const seen = await w.runNow('lead', 'Mirá el tablero')
  await w.waitEnded(seen.runId)
  const after = w.rt().approvals.find((a) => a.id === ap.id)
  check(after.state === 'pending' && after.decider === 'user' && after.leadSeenRunId === seen.runId, 'the run that saw it ended without deciding: the user decides it now')
  check((w.rt().comments.lead ?? []).some((c) => c.sys?.key === 'leadEscalation' && c.sys.vars?.taskId === t && c.forAgent === undefined), 'with the leadEscalation note in the Lead thread, for nobody')
  await settle()
  check(w.notices.filter((n) => n.tag === `team:${w.teamId}:${ap.id}`).length === 1, 'and now it notifies once')
  check(!(w.rt().comments.lead ?? []).some((c) => c.kind === 'answer' && c.author.runId === seen.runId), 'a manual Lead run that answered no message posts no reply')

  // Decision 43 edge (B4 review): a Descartar of the kickoff item sets the team-wide goalSeenHash, yet the session
  // never read the edited goal: its next resumed run gets the goal block.
  const teamMd = path.join(teamDirOf(w), 'team.md')
  fs.writeFileSync(teamMd, fs.readFileSync(teamMd, 'utf8').replace('Una app de notas', 'Una app de notas con etiquetas'))
  await trustAgain(w)
  const h2 = w.svc.trusted(w.teamId).goalHash
  w.clock.advance(0)
  const kq = w.rt().queue.find((x) => x.agentId === 'lead' && x.reason === 'kickoff')
  check(h2 !== h1 && !!kq, 'the edited goal asks for a kickoff (Por despachar)')
  await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: kq.id, go: false }, 'desktop')
  const sess1 = w.rt().agents.find((a) => a.id === 'lead').sessions.lead
  check(w.rt().goalSeenHash === h2 && sess1.goalHash === h1, 'Descartar marks the goal seen for the team, not for the session')
  const stdinFile = path.join(w.dir, 'lead-goal-stdin.txt')
  w.use({ saveStdin: stdinFile, steps: [{ fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  const m = await w.runNow('lead', 'Seguimos')
  await w.waitEnded(m.runId)
  const mr = w.ended(m.runId)
  const stdin = fs.readFileSync(stdinFile, 'utf8')
  check(mr.resumed === true && mr.sessionId === sess0.sessionId && stdin.includes('Goal (updated') && stdin.includes('con etiquetas') && stdin.indexOf('con etiquetas') < stdin.indexOf('# Your run'), 'the resumed Lead run reads the edited goal, marked updated, before section 4')
  check(w.rt().agents.find((a) => a.id === 'lead').sessions.lead.goalHash === h2, 'then its session has read it')
  const stdin2File = path.join(w.dir, 'lead-goal-stdin2.txt')
  w.use({ saveStdin: stdin2File, steps: [{ fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  const m2 = await w.runNow('lead', 'Otra')
  await w.waitEnded(m2.runId)
  check(!fs.readFileSync(stdin2File, 'utf8').includes('Goal (updated'), 'and the run after it gets no goal block')
  w.svc.dispose()
}

// Extra requirement 1: a `snaos team` call through the PowerShell tool is no approval; the agent's next run (only
// that one) is told to call it with Bash (TEAM_CALL_HINT).
async function hintChecks() {
  const w = await world('b5-hint')
  const lines = fs.readFileSync(path.join(FIX, 'claude-simple.jsonl'), 'utf8').split('\n').filter(Boolean)
  const result = JSON.parse(lines[lines.length - 1])
  result.permission_denials = [{ tool_name: 'PowerShell', tool_use_id: 'toolu_ps1', tool_input: { command: 'snaos team show --json' } }]
  result.result = 'No pude llamar al equipo.'
  const t = await w.createTask({ title: 'Probar el canal', assignee: 'dev', isolation: 'main' })
  w.use({ steps: [{ fixture: 'claude-simple.jsonl', to: lines.length - 1, rewriteSession: true }, { emit: result, rewriteSession: true }] })
  const r = await w.runTask('dev', t)
  await w.waitEnded(r.runId)
  check(w.ended(r.runId).denials?.some((d) => d.tool === 'PowerShell') && w.ended(r.runId).profile === 'readonly', 'the plan run (readonly) was denied a PowerShell call')
  check(!w.rt().approvals.some((a) => a.kind === 'permission'), 'a PowerShell `snaos team` denial opens no approval')
  check(w.rt().agents.find((a) => a.id === 'dev').bashHint === true, 'the agent keeps the Bash hint for its next run')
  const s1 = path.join(w.dir, 'hint-stdin1.txt')
  w.use({ saveStdin: s1, steps: [{ fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  const r2 = await w.runTask('dev', t)
  await w.waitEnded(r2.runId)
  const stdin = fs.readFileSync(s1, 'utf8')
  check(stdin.includes(M.TEAM_CALL_HINT) && stdin.indexOf(M.TEAM_CALL_HINT) > stdin.indexOf('# Your run'), 'the next run reads TEAM_CALL_HINT in section 4')
  check(!w.rt().agents.find((a) => a.id === 'dev').bashHint, 'and consumed it')
  const s2 = path.join(w.dir, 'hint-stdin2.txt')
  w.use({ saveStdin: s2, steps: [{ fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  const r3 = await w.runTask('dev', t)
  await w.waitEnded(r3.runId)
  check(!fs.readFileSync(s2, 'utf8').includes(M.TEAM_CALL_HINT), 'the run after it has no hint')
  w.svc.dispose()
}

// Extra requirement 5 (from B4): a task run whose prep failed with a card blocks on it; Reintentar re-requests the
// run, Descartar leaves it blocked for Retomar; the phone may not run a desktop-only action.
async function cardChecks() {
  const w = await world('b5-cards')
  const t = await w.createTask({ title: 'Sin CLI', assignee: 'dev', needsPlan: false, isolation: 'main' })
  w.noCli = true
  const r = await w.runTask('dev', t)
  await w.waitEnded(r.runId)
  const openCard = () => w.rt().cards.find((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'spawnFailed' && c.taskId === t)
  const card = openCard()
  check(card && JSON.stringify(card.from.actions) === '["retry","dismiss"]' && card.from.runId === r.runId, 'the prep failure opened its card: Reintentar, Descartar')
  const blocked = w.task(t).blocked
  check(w.task(t).state === 'blocked' && blocked?.reason.kind === 'card' && blocked.reason.cardId === card.id && blocked.reason.why === 'spawnFailed' && blocked.resume.state === 'doing' && blocked.resume.phase === 'executing', 'the task blocks on it (it never sits in doing with nothing to wake it)')
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  const list = await w.svc.request({ op: 'list' }, 'desktop')
  check(needs.needs.cards.some((c) => c.id === card.id && c.system?.why === 'spawnFailed') && list.teams[0].needsCount === M.teamNeedsCount(needs.needs), 'Te necesita shows the card, and the badge counts its rows')
  same(await M.OPS.answer({ op: 'answer', teamId: w.teamId, cardId: card.id, answer: { action: 'resumeTeam' } }, phoneCtx(w)), { ok: false, error: 'forbidden' }, 'from the phone a desktop-only action is forbidden (decision 50)')
  same(await M.OPS.answer({ op: 'answer', teamId: w.teamId, cardId: card.id, answer: { action: 'killOrphan' } }, phoneCtx(w)), { ok: false, error: 'forbidden' }, 'killOrphan too')
  w.noCli = false
  same(await w.svc.request({ op: 'answer', teamId: w.teamId, cardId: card.id, answer: { action: 'retry' } }, 'desktop'), { ok: true }, 'Reintentar')
  const next = w.task(t).next
  check(w.task(t).state === 'doing' && w.task(t).phase === 'executing' && next?.agentId === 'dev' && next.mode === 'exec' && next.reason === 'retry' && next.bypassCooldown === true, 'the run is requested again (T17, retry)')
  check(w.rt().cards.find((c) => c.id === card.id).state === 'answered', 'the card answered')
  const twice = await w.svc.request({ op: 'answer', teamId: w.teamId, cardId: card.id, answer: { action: 'dismiss' } }, 'desktop')
  check(!twice.ok && twice.error === 'conflict' && twice.reason === 'already_decided', 'a second answer: already_decided')
  w.use('claude-simple.json')
  w.clock.advance(0)
  const qi = w.rt().queue.find((x) => x.taskId === t)
  check(qi && qi.reason === 'retry', 'autonomy off: the retry waits in Por despachar')
  await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: qi.id, go: true }, 'desktop')
  w.clock.advance(0)
  const rr = w.rt().activeRuns.find((x) => x.taskId === t)
  check(!!rr, 'Despachar starts it')
  await w.waitEnded(rr.id)
  check(w.ended(rr.id).state === 'succeeded', 'and it runs')
  // Descartar: the task stays blocked on the card, Retomar (the resumeTask op, T17) resumes it later.
  w.noCli = true
  const r3 = await w.runTask('dev', t)
  await w.waitEnded(r3.runId)
  const card2 = openCard()
  check(card2 && card2.id !== card.id && w.task(t).state === 'blocked', 'a second prep failure blocks it again, on a new card')
  same(await w.svc.request({ op: 'answer', teamId: w.teamId, cardId: card2.id, answer: { action: 'dismiss' } }, 'desktop'), { ok: true }, 'Descartar')
  check(w.rt().cards.find((c) => c.id === card2.id).state === 'dismissed' && w.task(t).state === 'blocked' && w.task(t).blocked.reason.cardId === card2.id, 'the card goes, the task stays blocked on it')
  const after = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(!after.needs.cards.some((c) => c.id === card2.id), 'and leaves Te necesita')
  // Item 6 (B5 integration): Retomar of a task blocked on a dismissed prep-failure card lifts the prep backoff, like Reintentar.
  const backoffKey = `${w.teamId}|dev|${t}`
  check(w.svc.prepBackoff.has(backoffKey), 'the prep failure backed its level off (Descartar keeps the backoff)')
  w.noCli = false
  const res = await w.svc.request({ op: 'resumeTask', teamId: w.teamId, taskId: t }, 'desktop')
  check(res.ok && w.task(t).state === 'doing' && w.task(t).phase === 'executing' && w.task(t).next?.reason === 'retry', `Retomar resumes it later (${JSON.stringify(res.ok ? res.task.state : res)})`)
  check(!w.svc.prepBackoff.has(backoffKey), 'and lifts the prep backoff of its level (the user asked for it now)')
  w.svc.dispose()
}

// ---- 16. B5 integration ----------------------------------------------------------------------------------------
// Item 10: `team task get` from a run that concluded (its grace) never marks a newer user comment delivered
// (TeamService.ctlRead); a live run's get does.
async function graceReadChecks() {
  const w = await world('b5-grace')
  const t = await w.createTask({ title: 'Leer en la gracia', assignee: 'dev', isolation: 'main' })
  w.use('hang.json')
  const r = await w.runTask('dev', t)
  await w.waitState(r.runId, 'running')
  const who = whoOf(w, r.runId)
  const say = async (text) => {
    check((await w.svc.request({ op: 'comment', teamId: w.teamId, taskId: t, text }, 'desktop')).ok, `the user comments "${text}"`)
    return (w.rt().comments[t] ?? []).at(-1)
  }
  const c1 = await say('Antes del plan')
  check(c1.forAgent === 'dev' && !c1.deliveredRunId, 'queued for the dev')
  const get1 = await w.svc.ctlView.handle('team.task.get', { task: t }, who)
  check(get1.ok && w.rt().comments[t].find((c) => c.id === c1.id).deliveredRunId === r.runId, 'a live run: team task get delivers it')
  check((await w.svc.ctlView.handle('team.plan', { text: '1. Hacer' }, who)).ok && !!w.active(r.runId).concludedBy && w.active(r.runId).state === 'running', 'team plan concludes the run; it still runs (its grace)')
  const c2 = await say('Una cosa más')
  check(c2.forAgent === 'dev' && !c2.deliveredRunId, 'a newer comment, queued for the dev')
  const get2 = await w.svc.ctlView.handle('team.task.get', { task: t }, who)
  check(get2.ok && get2.data.task.comments.some((c) => c.id === c2.id && c.queued === true), 'the concluded run still reads it, as queued')
  check(!w.rt().comments[t].find((c) => c.id === c2.id).deliveredRunId, 'and it stays queued: never delivered to a run that concluded (the next run reads it)')
  w.clock.advance(M.CONCLUDE_GRACE_MS)
  await w.waitEnded(r.runId)
  check(!w.rt().comments[t].find((c) => c.id === c2.id).deliveredRunId, 'still queued after the run ended')
  w.svc.dispose()
}

/** A claude-simple run whose result carries these permission denials (claude-denied style). */
function deniedScenario(denials, text = 'No pude.') {
  const lines = fs.readFileSync(path.join(FIX, 'claude-simple.jsonl'), 'utf8').split('\n').filter(Boolean)
  const result = JSON.parse(lines[lines.length - 1])
  result.permission_denials = denials.map((command, i) => ({ tool_name: 'Bash', tool_use_id: `toolu_b${i}`, tool_input: { command } }))
  result.result = text
  return { steps: [{ fixture: 'claude-simple.jsonl', to: lines.length - 1, rewriteSession: true }, { emit: result, rewriteSession: true }] }
}

// Items 2, 4 and 7: an escape denial opens no approval and its next run hears it needs the user; a Bash denial's
// approval carries the denied command; the grant's re-run gets its Bash hint as a system hint in section 4, never as
// the user's request text.
async function hintsChecks() {
  const w = await world('b5-hints')
  fs.writeFileSync(path.join(teamDirOf(w), 'roles', 'fixer.md'), '---\nname: Fixer\nkind: custom\nprovider: claude\npermission: custom\nallowedTools: Read, Grep\n---\nArreglá cosas chicas.\n')
  await trustAgain(w)
  const t = await w.createTask({ title: 'Correr los tests', assignee: 'fixer', needsPlan: false, isolation: 'main' })
  // Item 2: bash -c is never grantable.
  w.use(deniedScenario(['bash -c "npm test"']))
  const r = await w.runTask('fixer', t)
  await w.waitEnded(r.runId)
  check(w.ended(r.runId).denials?.some((d) => d.tool === 'Bash') && !w.rt().approvals.some((a) => a.kind === 'permission'), 'a `bash -c` denial opens no approval')
  check(w.rt().agents.find((a) => a.id === 'fixer').escapeHint === true, 'the agent keeps the escape hint for its next run')
  const s1 = path.join(w.dir, 'esc-stdin.txt')
  w.use({ saveStdin: s1, steps: [{ fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  const r2 = await w.runTask('fixer', t)
  await w.waitEnded(r2.runId)
  const st1 = fs.readFileSync(s1, 'utf8')
  check(st1.includes(M.ESCAPE_HINT) && st1.indexOf(M.ESCAPE_HINT) > st1.indexOf('# Your run') && /snaos team needs/.test(M.ESCAPE_HINT), 'its next run reads ESCAPE_HINT in section 4 (the command needs the user: snaos team needs)')
  check(!w.rt().agents.find((a) => a.id === 'fixer').escapeHint, 'and consumed it')
  // Items 4 and 7: a Bash denial asks for its rule with the denied command; the grant re-run gets a system hint.
  w.use(deniedScenario(['npm test -- --watch']))
  const r3 = await w.runTask('fixer', t)
  await w.waitEnded(r3.runId)
  const ap = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t && a.state === 'pending')
  check(ap && JSON.stringify(ap.payload.tools) === '["Bash(npm test:*)"]' && JSON.stringify(ap.payload.denied) === '["npm test -- --watch"]', 'the approval: the Bash rule and the denied command', ap?.payload)
  const nv = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  check(JSON.stringify(nv.needs.approvals.find((a) => a.id === ap.id).payload.denied) === '["npm test -- --watch"]', 'Te necesita sends the denied command (ApprovalPayloadView.denied)')
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: ap.id, decision: 'approve', rev: 1 }, 'desktop'), { ok: true }, 'approve it')
  check(w.task(t).next?.reason === 'grant' && w.task(t).next.detail === undefined && JSON.stringify(w.task(t).next.refs) === JSON.stringify([ap.id]), 'the grant wake names the approval, no detail (that is the user request text only)', w.task(t).next)
  w.clock.advance(0)
  const qi = w.rt().queue.find((x) => x.taskId === t)
  check(qi && qi.reason === 'grant', 'autonomy off: the grant re-run waits in Por despachar')
  const s2 = path.join(w.dir, 'grant-stdin.txt')
  w.use({ saveStdin: s2, steps: [{ echoArgv: true }, { fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: qi.id, go: true }, 'desktop')
  w.clock.advance(0)
  const gr = w.rt().activeRuns.find((x) => x.taskId === t)
  check(!!gr && gr.trigger.reason === 'grant', 'Despachar starts it')
  await w.waitEnded(gr.id)
  const st2 = fs.readFileSync(s2, 'utf8')
  const hint = 'The user allowed Bash(npm test:*). Run those commands with your Bash tool'
  check(st2.includes(hint) && st2.indexOf(hint) > st2.indexOf('# Your run') && !st2.includes('<request from="user">'), 'the grant re-run: the Bash hint in section 4 as main\'s text, no <request from="user"> block', st2.slice(st2.indexOf('# Your run'), st2.indexOf('# Your run') + 1200))
  const allow = w.logLines(gr.id).find((l) => l && l.type === 'fake.argv').argv
  check(allow.includes('Bash(npm test:*)') && !allow.some((x) => /^PowerShell\(npm/.test(x)), 'its allow list carries the Bash rule')
  // 2.7.0 runtime fixes (orchestrator decision): the denied run waits on the decision; Rechazar wakes the same agent with
  // `answer`, and its run resumes the same session and reads the reject hint in section 4 (main's text) and the note.
  w.use(deniedScenario(['make release']))
  const r4 = await w.runTask('fixer', t)
  await w.waitEnded(r4.runId)
  const apr = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t && a.state === 'pending')
  check(apr && JSON.stringify(apr.payload.tools) === '["Bash(make release:*)"]' && !w.task(t).next, 'a denied make release: its approval, and the task waits on it (no wake of its own)', { payload: apr?.payload, next: w.task(t).next })
  same(await w.svc.request({ op: 'decide', teamId: w.teamId, approvalId: apr.id, decision: 'reject', note: 'Sin release por ahora', rev: 1 }, 'desktop'), { ok: true }, 'reject it with a note')
  check(w.task(t).next?.reason === 'answer' && w.task(t).next.agentId === 'fixer' && JSON.stringify(w.task(t).next.refs) === JSON.stringify([apr.id]), 'the reject wakes the same agent with answer, the approval in its refs', w.task(t).next)
  w.clock.advance(0)
  const qr = w.rt().queue.find((x) => x.taskId === t)
  check(qr && qr.reason === 'answer', 'autonomy off: it waits in Por despachar')
  const s3 = path.join(w.dir, 'reject-stdin.txt')
  w.use({ saveStdin: s3, steps: [{ fixture: 'claude-resume.jsonl', rewriteSession: true }] })
  await w.svc.request({ op: 'dispatch', teamId: w.teamId, queueId: qr.id, go: true }, 'desktop')
  w.clock.advance(0)
  const rj = w.rt().activeRuns.find((x) => x.taskId === t)
  check(!!rj && rj.trigger.reason === 'answer' && rj.resumed === true && rj.sessionId === w.ended(r4.runId).sessionId, 'Despachar starts it on the same session', rj && { trigger: rj.trigger, resumed: rj.resumed, sessionId: rj.sessionId })
  await w.waitEnded(rj.id)
  const st3 = fs.readFileSync(s3, 'utf8')
  const rhint = 'The user did not allow Bash(make release:*).'
  check(st3.includes(rhint) && st3.indexOf(rhint) > st3.indexOf('# Your run') && st3.includes('Sin release por ahora') && !st3.includes('The user allowed'), 'its prompt: the reject hint in section 4 and the user\'s note', st3.slice(st3.indexOf('# Your run'), st3.indexOf('# Your run') + 1200))
  w.svc.dispose()
}

// Item 4: a QA run's prep computes the diff stat (numstat of what QA reviews), the task keeps it, the final OK shows it.
async function qaStatChecks() {
  const w = await world('b5-qastat', { worktrees: true })
  const t = await w.createTask({ title: 'Con diff', assignee: 'dev' })
  w.use('claude-simple.json')
  const p = await w.runTask('dev', t)
  await w.waitEnded(p.runId)
  const wt = w.task(t).worktree
  check(!!wt, 'the plan run made the task worktree')
  fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'uno\ndos\ntres\n')
  fs.writeFileSync(path.join(wt.path, 'README.md'), '# r\notra\n')
  git(wt.path, 'add', '-A')
  git(wt.path, 'commit', '-qm', 'feature')
  setTask(w, t, { state: 'review', phase: 'qa', plan: { rev: 1, text: 'Paso 1', status: 'approved', small: false, at: w.clock.now }, review: { round: 1, max: 3, qaAgentId: 'qa' } }, ['next', 'cooldownUntil'])
  w.use('hang.json')
  const q = await w.runTask('qa', t)
  check(q.ok, `the QA run is admitted (${JSON.stringify(q)})`)
  await w.waitState(q.runId, 'running')
  const ds = w.task(t).diffStat
  check(ds && ds.files === 2 && ds.insertions === 4 && ds.deletions === 0 && ds.top[0].path === 'feature.txt' && ds.top[0].add === 3 && ds.top[1].path === 'README.md' && ds.at === w.clock.now, 'the QA prep stored the diff stat of the branch on the task', ds)
  const res = await w.svc.ctlView.handle('team.verdict', { verdict: 'approve', text: 'Revisé feature.txt' }, whoOf(w, q.runId))
  check(res.ok && w.task(t).phase === 'userOk', `QA approves: the final OK (${JSON.stringify(res)})`)
  const needs = await w.svc.request({ op: 'needs', teamId: w.teamId }, 'desktop')
  const fin = needs.needs.approvals.find((a) => a.payload.kind === 'final' && a.taskId === t)
  same(fin?.payload.stat, { files: 2, insertions: 4, deletions: 0, top: [{ path: 'feature.txt', add: 3, del: 0 }, { path: 'README.md', add: 1, del: 0 }] }, 'the final OK view carries the stat QA read')
  w.clock.advance(M.CONCLUDE_GRACE_MS)
  await w.waitEnded(q.runId)
  w.svc.dispose()
}

async function main() {
  try {
    reducerChecks()
    supervisorKillChecks()
    supervisorBeatChecks()
    await lifecycleChecks()
    await stopChecks()
    await lifecycleExitChecks()
    await reaperChecks()
    await logChecks()
    await teamScopeChecks()
    await removeChecks()
    await worktreeChecks()
    await seriesChecks()
    await queueChecks()
    await backoffChecks()
    await backoffUserChecks()
    await conflictChecks()
    await wakeChecks()
    await discardNextChecks()
    await discardLeadChecks()
    await queueDeferChecks()
    await leadGoalChecks()
    await orphanWaitChecks()
    await removeRaceChecks()
    await resumeChecks()
    await blockChecks()
    await secretChecks()
    await finalTextChecks()
    await cmdLineChecks()
    await permissionChecks()
    await hireChecks()
    await staleHireChecks()
    await secretAskChecks()
    await noticeChecks()
    await leadChecks()
    await hintChecks()
    await cardChecks()
    await graceReadChecks()
    await hintsChecks()
    await qaStatChecks()
    console.log(`PASS: ${checks} teams runner checks (fake agent lifecycle, watch, stop tree, linger, drain, max, prep CAS, session conflict, CLI off, gates, Labs off/on, shutdownSync, install, thaw, reaper, orphans, big result, RunLog cut, team scope, usage today, runs paging, remove wait, policy rows, no signal after exit, a heartbeat is no sign of life; B4: task worktrees and the exec resume, write locks, tree mark, extra repo, a re-created team, runs in series within the caps, Por despachar, kickoff, triage, prep failure backoff, one sessionConflict card; integration: Frenar opens no card, a stale owned tree disowned, a re-wake keeps its request across a reload, a prep failure gives its wake mark back; review: Descartar offers the next level, a resumed kickoff reads the goal, no resume before the orphan check settles, a tree made after its team's removal disowned, Retomar a stopped task; B5: the Codex block at close, permission approval and grant, views of an ended task, hire apply and re-trust, applying at load, notices once and none after a restart, the Lead reply, lead escalation, the goal per Lead session, the Bash hint, prep failure cards; B5 integration: Retomar lifts the prep backoff, no delivery in the grace, the escape hint, the denied command, the grant system hint, the QA diff stat; fourth round: nothing to grant; fifth round: a token shape in a Codex block masked; sixth round: live tokens masked in runPage and runAppend, a Codex block action with a live token refused, a Read deny per secret of the data folder; seventh round: the summary and the Lead reply masked, the cmd.exe line guard; review: the snaos.note record of key and vars, stale hires cancelled at a re-trust, no permission rule with a secret; second review round: an apply whose base a trust replaced cancelled stale, stale hires cancelled at load; runtime fixes: a run waits on its permission approval, the reject wake and hint, the user's kickoff apart from a goal change)`)
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
