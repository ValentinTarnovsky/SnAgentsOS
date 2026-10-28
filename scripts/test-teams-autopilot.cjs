// Piloto automatico of Equipos (app 2.9.0). Pure: recommendedOf (`team ask --recommended`, 1 based, and the
// `(recomendado)` suffix as the fallback), setTeamFlags (on turns auto dispatch on too, off leaves it), autopilotPicks
// and autopilotTakes on hand-made runtimes (every approval the user decides, never the Lead's, the integrate step and
// its rebase for a conflict or a verify only, the recommended answer of a single-choice ask only, nothing off or
// paused, the skip keys, a permission key per rev). Through TeamService on real git (the serviceWorld of
// test-teams-integrate.cjs): the settings op, a plan approved, a permission granted, a recommended answer, a clean
// merge integrated to done, a merge conflict sent back to the Dev and AUTOPILOT_REBASE_MAX of them in a row left to the
// user, a dirty checkout left pending with its notice, no notice for what the autopilot clears, nothing while paused
// or off, every decision recorded as the user via `auto`.
// Same esbuild + vm harness as test-teams-integrate.cjs: no Electron, no agent processes, no user data.
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
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-autopilot-'))
const electronStub = { app: { getPath: (name) => (name === 'userData' ? path.join(TMP, 'ud') : TMP), isPackaged: false, commandLine: { hasSwitch: () => false } } }
function loadEntry(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (id) => (id === 'electron' ? electronStub : require(id)), console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, TextEncoder, TextDecoder })
  return mod.exports
}

const M = loadEntry(`
export * as A from './src/main/teams/flow/autopilot'
export { recommendedOf } from './src/main/teams/flow/tools'
export { setTeamFlags } from './src/main/teams/flow/agents'
export { createGitRunner, gitEnv } from './src/main/git/gitExec'
export { WorktreeService } from './src/main/git/WorktreeService'
export { WorktreeManifest } from './src/main/git/WorktreeManifest'
export { TeamService } from './src/main/teams/TeamService'
export { TeamDefinitionLoader } from './src/main/teams/TeamDefinitionLoader'
export { emptyRuntime, teamWorktreeOwner } from './src/shared/teams'
`)
const A = M.A
const NOW = 1_900_000_000_000
const TEAM = 'tm-0123456789ab'
const GEN = 'abcd1234'
const AUTO = { kind: 'user', via: 'auto' }

// ---- 1. pure ------------------------------------------------------------------------------------------------
function recommendedChecks() {
  const opts = ['Postgres', 'SQLite', 'Redis']
  same(M.recommendedOf(2, opts, false), 1, 'recommended 2 is the second option (0 based 1)')
  same(M.recommendedOf(1, opts, false), 0, 'recommended 1 is the first')
  same(M.recommendedOf(3, opts, false), 2, 'recommended 3 is the last')
  for (const bad of [0, 4, -1, 1.5, '1', true]) same(M.recommendedOf(bad, opts, false), null, `recommended ${JSON.stringify(bad)} is not an option: null`)
  same(M.recommendedOf(1, opts, true), null, 'a multi question takes no recommended')
  same(M.recommendedOf(undefined, opts, false), undefined, 'none given and none marked: undefined')
  same(M.recommendedOf(undefined, ['A', 'B (Recomendado)', 'C'], false), 1, 'the (recomendado) suffix marks it (any case)')
  same(M.recommendedOf(undefined, ['A (recommended)', 'B'], false), 0, 'the (recommended) suffix too')
  same(M.recommendedOf(undefined, ['A', 'B (recomendada) '], false), 1, 'and (recomendada), trailing space ignored')
  same(M.recommendedOf(undefined, ['A (recomendado)', 'B (recommended)'], false), undefined, 'two marked: none (the agent was not clear)')
  same(M.recommendedOf(undefined, ['A (recomendado)', 'B'], true), undefined, 'a multi question: no fallback either')
  same(M.recommendedOf(undefined, ['(recomendado) A', 'B'], false), undefined, 'the mark only counts at the end')
  same(M.recommendedOf(3, ['A', 'B (recomendado)', 'C'], false), 2, 'the explicit number wins over a suffix')
}

function flagChecks() {
  const rt = M.emptyRuntime(TEAM, GEN)
  const on = M.setTeamFlags(rt, { autopilot: true }, { now: NOW })
  check(on.ok && on.rt.autopilot === true && on.rt.autoDispatch === true, 'autopilot on turns auto dispatch on too')
  same(on.effects, [{ kind: 'dispatch' }], 'and pokes the dispatcher')
  const keep = M.setTeamFlags(rt, { autopilot: true, autoDispatch: false }, { now: NOW })
  check(keep.rt.autopilot === true && keep.rt.autoDispatch === false, 'an explicit autoDispatch in the same patch wins')
  const off = M.setTeamFlags(on.rt, { autopilot: false }, { now: NOW })
  check(off.ok && !('autopilot' in off.rt) && off.rt.autoDispatch === true, 'autopilot off drops the flag (absent reads off) and leaves auto dispatch on')
  same(off.effects, [], 'turning it off pokes nothing')
  const again = M.setTeamFlags(on.rt, { autopilot: true }, { now: NOW })
  check(again.rt === on.rt, 'on again changes nothing')
  same(M.setTeamFlags(rt, { autopilot: false }, { now: NOW }).rt, rt, 'off when off: the same runtime')
}

/** A runtime with one of every kind of row; `edit` adjusts it. */
function rtFixture(edit = (x) => x) {
  const rt = M.emptyRuntime(TEAM, GEN)
  rt.autopilot = true
  const agent = (id, roleKind) => ({ id, roleId: id, roleKind, provider: 'claude', status: 'idle', paused: false, sessions: {}, interrupts: 0 })
  rt.agents = [agent('lead', 'lead'), agent('dev', 'dev')]
  const task = (id, state, phase, extra = {}) => ({
    id, rev: 1, title: id, body: '', state, phase, priority: 'normal', assignee: 'dev', repoId: 'main', isolation: 'worktree', needsPlan: false,
    blockedBy: [], createdBy: { kind: 'user', via: 'desktop' }, createdAt: NOW, updatedAt: NOW, stateSince: NOW, review: { round: 0, max: 3 }, userOwned: [],
    counters: { noProgress: 0, continuations: 0, retries: 0, interrupts: 0, unblockWakes: 0, unblockWindowStart: 0 }, ...extra,
  })
  rt.tasks = [
    task('t-1', 'doing', 'planApproval'),
    task('t-2', 'review', 'userOk'),
    task('t-3', 'doing', 'executing'),
    task('t-4', 'review', 'integrating'),
    task('t-5', 'review', 'integrating', { integrate: { state: 'running', attempt: 1, at: NOW } }),
    task('t-6', 'review', 'integrating', { integrate: { state: 'failed', attempt: 1, error: 'merge_conflict', files: ['a.txt'], at: NOW } }),
    task('t-7', 'review', 'integrating', { integrate: { state: 'failed', attempt: 1, error: 'base_dirty', at: NOW } }),
    task('t-8', 'review', 'integrating', { integrate: { state: 'failed', attempt: 1, error: 'verify_timeout', at: NOW } }),
    task('t-9', 'doing', 'planApproval'),
  ]
  const ap = (id, taskId, kind, payload, at, extra = {}) => ({ id, taskId, kind, payload, state: 'pending', decider: 'user', createdAt: at, createdBy: { kind: 'system' }, ...extra })
  const ib = { branch: 'sn/x', base: 'main' }
  rt.approvals = [
    ap('a-1', 't-1', 'plan', { planRev: 1, small: false }, NOW + 1),
    ap('a-2', 't-2', 'final', { hasWorktree: true, summary: 's' }, NOW + 2),
    ap('a-3', 't-3', 'permission', { roleId: 'dev', runId: 'r-1', tools: ['Bash(npm test:*)'] }, NOW + 3, { rev: 2 }),
    { id: 'a-4', kind: 'hire', payload: { roleId: 'ux', text: 'x', sha256: 's', baseDefHash: 'h', replaces: false }, state: 'pending', decider: 'user', createdAt: NOW + 4, createdBy: { kind: 'system' } },
    ap('a-5', 't-4', 'integrate', ib, NOW + 5),
    ap('a-6', 't-5', 'integrate', ib, NOW + 6),
    ap('a-7', 't-6', 'integrate', ib, NOW + 7),
    ap('a-8', 't-7', 'integrate', ib, NOW + 8),
    ap('a-9', 't-8', 'integrate', ib, NOW + 9),
    ap('a-10', 't-9', 'plan', { planRev: 1, small: true }, NOW + 10, { decider: 'lead' }),
    ap('a-11', 't-1', 'plan', { planRev: 0, small: false }, NOW, { state: 'cancelled' }),
  ]
  const card = (id, extra, at) => ({ id, kind: 'choice', question: 'q', options: ['A', 'B'], multi: false, state: 'open', from: { kind: 'agent', agentId: 'dev', runId: 'r-2', tool: 'ask' }, createdAt: at, taskId: 't-3', ...extra })
  rt.cards = [
    card('k-1', { recommended: 1 }, NOW + 11),
    card('k-2', {}, NOW + 12),
    card('k-3', { multi: true, recommended: 0 }, NOW + 13),
    card('k-4', { kind: 'text', options: [], recommended: 0 }, NOW + 14),
    card('k-5', { kind: 'confirm', options: [], from: { kind: 'agent', agentId: 'dev', runId: 'r-2', tool: 'needs' } }, NOW + 15),
    card('k-6', { recommended: 0, state: 'answered' }, NOW + 16),
    { id: 'k-7', kind: 'choice', question: '', options: [], multi: false, state: 'open', from: { kind: 'system', why: 'failure', actions: ['retry', 'dismiss'] }, createdAt: NOW + 17 },
    card('k-8', { recommended: 5 }, NOW + 18),
  ]
  return edit(rt)
}

function pickChecks() {
  const rt = rtFixture()
  const none = new Set()
  same(A.autopilotPicks(rt, none), [
    { kind: 'decide', key: 'a-1', approvalId: 'a-1', approvalKind: 'plan', rev: 1, taskId: 't-1' },
    { kind: 'decide', key: 'a-2', approvalId: 'a-2', approvalKind: 'final', rev: 1, taskId: 't-2' },
    { kind: 'decide', key: 'a-3@2', approvalId: 'a-3', approvalKind: 'permission', rev: 2, taskId: 't-3' },
    { kind: 'decide', key: 'a-4', approvalId: 'a-4', approvalKind: 'hire', rev: 1 },
    { kind: 'integrate', key: 'integrate:t-4', taskId: 't-4' },
    { kind: 'rebase', key: 'rebase:t-6', taskId: 't-6', why: 'conflict' },
    { kind: 'rebase', key: 'rebase:t-8', taskId: 't-8', why: 'verify' },
    { kind: 'answer', key: 'k-1', cardId: 'k-1', choice: 1, taskId: 't-3' },
  ], 'the picks, oldest first: plan, final, permission (key and rev), hire, the clean integrate, a conflict and a verify timeout back to the Dev, the recommended answer; never a running or base_dirty integrate, the Lead\'s small plan, a decided approval, a card without a recommended single choice, a needs, a system card or an out-of-range recommended')
  same(A.autopilotPicks(rtFixture((x) => { delete x.autopilot; return x }), none), [], 'off: nothing')
  same(A.autopilotPicks(rtFixture((x) => ({ ...x, paused: { reason: 'user', at: NOW } })), none), [], 'paused by the user: nothing')
  same(A.autopilotPicks(rtFixture((x) => ({ ...x, paused: { reason: 'billing', at: NOW } })), none), [], 'paused by billing: nothing')
  const skip = new Set(['a-1', 'a-3@2', 'integrate:t-4', 'rebase:t-6', 'k-1'])
  same(A.autopilotPicks(rt, skip).map((p) => p.key), ['a-2', 'a-4', 'rebase:t-8'], 'the skip keys leave their rows to the user')
  same(A.autopilotPicks(rt, new Set(['a-3@1'])).map((p) => p.key).includes('a-3@2'), true, 'a permission skipped at rev 1 is offered again at rev 2 (new rules merged in)')
  same(A.autopilotPicks(rt, new Set(['integrate:t-6'])).map((p) => p.key).includes('rebase:t-6'), true, 'the integrate key does not hold back the rebase of a failure')

  const takes = (id, kind, s = none, r = rt) => A.autopilotTakes({ id, kind }, r, s)
  for (const id of ['a-1', 'a-2', 'a-3', 'a-4', 'a-5', 'a-7', 'a-9']) check(takes(id, 'approval'), `${id}: the autopilot takes the row (no notice)`)
  check(takes('a-6', 'approval'), 'an integrate running stays the autopilot\'s while it runs')
  check(!takes('a-6', 'approval', new Set(['integrate:t-5'])), 'unless it gave up on it')
  check(!takes('a-8', 'approval'), 'a base_dirty failure is the user\'s: it notifies')
  check(!takes('a-10', 'approval'), 'the Lead\'s small plan is not a user row')
  check(takes('k-1', 'card') && !takes('k-2', 'card') && !takes('k-3', 'card') && !takes('k-4', 'card') && !takes('k-5', 'card') && !takes('k-7', 'card') && !takes('k-8', 'card'), 'only the recommended single choice card')
  check(!takes('k-1', 'card', new Set(['k-1'])), 'a skipped card notifies')
  check(!takes('trust', 'trust') && !takes('paused', 'paused') && !takes('q-1', 'dispatch'), 'trust, pause and dispatch rows are never the autopilot\'s')
  check(!takes('a-1', 'approval', none, rtFixture((x) => ({ ...x, paused: { reason: 'user', at: NOW } }))), 'paused: every row notifies')
  // The QA run that just gave its verdict is still active: Integrar would be busy, so the autopilot waits (no notice).
  const qaRun = { id: 'r-0123456789ab', agentId: 'dev', taskId: 't-4', mode: 'qa', state: 'running', concludedBy: { tool: 'verdict', at: NOW } }
  const running = rtFixture((x) => ({ ...x, activeRuns: [qaRun] }))
  check(!A.autopilotPicks(running, none).some((p) => p.key === 'integrate:t-4'), 'a run of the task still active: no integrate pick yet')
  check(takes('a-5', 'approval', none, running), 'and the row stays the autopilot\'s while it waits for that run')
  check(!takes('a-5', 'approval', new Set(['integrate:t-4']), running), 'unless it gave up on it')
  // A failure that passes by itself is tried again; one on the user's side is not.
  for (const error of ['base_moved', 'interrupted', 'timeout']) {
    const r = rtFixture((x) => ({ ...x, tasks: x.tasks.map((t) => (t.id === 't-7' ? { ...t, integrate: { state: 'failed', attempt: 1, error, at: NOW } } : t)) }))
    check(A.autopilotPicks(r, none).some((p) => p.kind === 'integrate' && p.key === 'integrate:t-7'), `${error}: Integrar again`)
    check(takes('a-8', 'approval', none, r), `${error}: the row stays the autopilot's`)
    check(!A.autopilotPicks(r, new Set(['integrate:t-7'])).some((p) => p.key === 'integrate:t-7'), `${error}: not once it gave up`)
  }
  same(A.keyTask('integrate:t-4'), 't-4', 'keyTask of an integrate key')
  same(A.keyTask('rebase:t-12'), 't-12', 'keyTask of a rebase key')
  same(A.keyTask('a-3@2'), undefined, 'keyTask of an approval key')
  same(A.AUTOPILOT_ACTOR, AUTO, 'the actor is the user via auto')
}

// ---- 2. TeamService on real git -----------------------------------------------------------------------------
const gitCfg = path.join(TMP, 'gitconfig')
fs.writeFileSync(gitCfg, '')
const gitSysCfg = path.join(TMP, 'gitconfig-system')
fs.writeFileSync(gitSysCfg, '')
const gitEnvVars = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitCfg, GIT_CONFIG_SYSTEM: gitSysCfg }
for (const k of Object.keys(gitEnvVars)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_[A-Z]+|COMMITTER_[A-Z]+)$/i.test(k)) delete gitEnvVars[k]
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, env: gitEnvVars, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@x']
const runner = M.createGitRunner({ env: () => M.gitEnv(gitEnvVars) })
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const real = (p) => fs.realpathSync.native(p)

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@x')
  git(dir, 'config', 'core.autocrlf', 'false')
  write(path.join(dir, 'README.md'), '# r\n')
  write(path.join(dir, 'conflict.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, ...ID, 'commit', '-qm', 'init')
  return real(dir)
}

function manualClock(start = 1_800_000_000_000) {
  const c = { now: start, timers: new Map(), seq: 0 }
  c.deps = {
    now: () => c.now,
    setTimeout: (fn, ms) => { const id = ++c.seq; c.timers.set(id, { fn, at: c.now + ms }); return id },
    clearTimeout: (id) => c.timers.delete(id),
  }
  return c
}

const services = []
async function serviceWorld(name) {
  const dir = path.join(TMP, name)
  const repo = makeRepo(path.join(dir, 'repo'))
  const data = path.join(dir, 'data')
  const clock = manualClock()
  const w = { dir, repo, data, clock, logs: [], notices: [] }
  w.cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '' }, workspaces: [] }
  w.wtRoot = path.join(data, 'worktrees')
  w.wts = new M.WorktreeService({ runner, manifest: new M.WorktreeManifest(path.join(data, 'worktrees.json')), root: () => w.wtRoot, defaultRoot: () => w.wtRoot, removeOptions: { delayMs: 0, retries: 1 } })
  w.svc = new M.TeamService({
    dataDir: () => data, config: () => w.cfg, git: runner, emit: () => undefined, openPath: async () => '', log: (l) => w.logs.push(l),
    now: () => clock.now, timerDeps: clock.deps, loader: new M.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) }), strict: true,
    worktrees: w.wts, notice: (n) => w.notices.push(n), sendIntegrate: () => undefined, platform: process.platform,
  })
  services.push(w.svc)
  await w.svc.start(w.cfg)
  const probe = await w.svc.request({ op: 'setupProbe', dir: repo }, 'desktop')
  const draft = { ...probe.probe.defaults, goal: 'Una app de notas', verify: '' }
  const prev = await w.svc.request({ op: 'setupPreview', repoRoot: repo, draft }, 'desktop')
  const wr = await w.svc.request({ op: 'setupWrite', repoRoot: repo, draft, previewHash: prev.preview.hash }, 'desktop')
  assert.ok(wr.ok, `setup ${name}: ${JSON.stringify(wr)}`)
  w.teamId = wr.teamId
  git(repo, 'add', '-A')
  git(repo, ...ID, 'commit', '-qm', 'team')
  w.store = () => w.svc.team(w.teamId).store
  w.rt = () => w.store().rt
  w.task = (id) => w.rt().tasks.find((t) => t.id === id)
  w.approval = (id) => w.rt().approvals.find((a) => a.id === id)
  w.card = (id) => w.rt().cards.find((c) => c.id === id)
  w.req = (r, origin = 'desktop') => w.svc.request({ teamId: w.teamId, ...r }, origin)
  /** The store written directly (no TeamService.commit: no autopilot pass), as a run end or a reducer would leave it. */
  w.put = (edit) => w.store().commit({ ok: true, rt: edit(w.rt()), effects: [], result: undefined }, ['task', 'needs'])
  /** A commit through the service, the kind every op makes: the autopilot pass follows. */
  w.poke = () => w.svc.commit(w.teamId, { ok: true, rt: { ...w.rt() }, effects: [], result: undefined }, ['team'])
  /** Every pass, integrate and the passes they owe settled. */
  w.settle = async () => {
    for (let i = 0; i < 8; i++) {
      await w.svc.autopilotIdle()
      await w.svc.integrateIdle()
    }
  }
  w.newTask = async (title) => {
    const r = await w.req({ op: 'createTask', task: { title, assignee: 'dev' } })
    assert.ok(r.ok, JSON.stringify(r))
    return r.task.id
  }
  /** A task in review/integrating with an approved final, a pending integrate approval and its worktree (edits committed). */
  w.integratingTask = async (title, edits) => {
    const id = await w.newTask(title)
    const made = await w.svc.taskWorktrees.ensure({ id: w.teamId, gen: w.rt().gen }, w.svc.repoOf(w.teamId, 'main'), w.task(id))
    assert.ok(made.ok, JSON.stringify(made))
    for (const [f, text] of Object.entries(edits)) write(path.join(made.worktree.path, f), text)
    git(made.worktree.path, 'add', '-A')
    git(made.worktree.path, ...ID, 'commit', '-qm', `work ${id}`)
    const n = w.rt().nextIds.approval
    const now = clock.now
    w.put((cur) => ({
      ...cur,
      tasks: cur.tasks.map((x) => (x.id === id ? { ...x, state: 'review', phase: 'integrating', frozen: true, worktree: made.worktree, plan: { rev: 1, text: 'p', status: 'approved', small: false, at: now } } : x)),
      approvals: [
        ...cur.approvals,
        { id: `a-${n}`, taskId: id, kind: 'final', state: 'approved', decider: 'user', createdAt: now, createdBy: { kind: 'system' }, decidedAt: now, decidedBy: { kind: 'user', via: 'desktop' }, payload: { hasWorktree: true, summary: 'ok' } },
        { id: `a-${n + 1}`, taskId: id, kind: 'integrate', state: 'pending', decider: 'user', createdAt: now, createdBy: { kind: 'system' }, payload: { branch: made.worktree.branch, base: made.worktree.baseBranch } },
      ],
      queue: cur.queue.filter((q) => q.taskId !== id),
      nextIds: { ...cur.nextIds, approval: n + 2 },
    }))
    return { id, wt: made.worktree, integrateApproval: `a-${n + 1}` }
  }
  return w
}

async function serviceChecks() {
  const w = await serviceWorld('svc')
  // Off by default: a pending integrate stays the user's.
  const off = await w.integratingTask('Agregar login', { 'login.txt': 'login\n' })
  w.poke()
  await w.settle()
  check(w.task(off.id).phase === 'integrating' && w.approval(off.integrateApproval).state === 'pending', 'off: nothing is integrated')
  const view0 = await w.req({ op: 'get' })
  check(view0.ok && view0.team.autopilot === undefined, 'the view reads off as absent')

  // The settings op: on (auto dispatch held off here: no agent CLI runs in this suite).
  const on = await w.req({ op: 'settings', patch: { autopilot: true, autoDispatch: false } })
  check(on.ok && on.team.autopilot === true && on.team.autoDispatch === false, 'settings {autopilot}: the view says on')
  check(w.rt().autopilot === true, 'the runtime holds it')
  same(await w.req({ op: 'settings', patch: { autopilot: true } }, 'phone'), { ok: false, error: 'bad_request' }, 'never from the phone (settings is not a phone op)')
  await w.settle()
  const ta = w.task(off.id)
  check(ta.state === 'done' && ta.integrated?.landed === 'ffOnly', `turning it on integrates the pending clean merge (${JSON.stringify(ta.integrate ?? ta.integrated)})`)
  same(w.approval(off.integrateApproval).decidedBy, AUTO, 'the integrate approval approved as the user via auto')
  check(git(w.repo, 'log', '-1', '--format=%s').trim().startsWith(`Merge ${off.wt.branch}`), 'a merge commit on main')
  check(w.logs.some((l) => l === `autopilot ${w.teamId} integrate integrate:${off.id}`), 'the log names it')

  // A plan, a permission and a recommended question opened while it is on: decided, and none notifies.
  const tPlan = await w.newTask('Plan de notas')
  const tPerm = await w.newTask('Correr los tests')
  const before = w.notices.length
  const n = w.rt().nextIds.approval
  const k = w.rt().nextIds.card
  const now = w.clock.now
  w.put((cur) => ({
    ...cur,
    tasks: cur.tasks.map((x) =>
      x.id === tPlan ? { ...x, state: 'doing', phase: 'planApproval', stateSince: now, plan: { rev: 1, text: 'el plan', status: 'pending', small: false, at: now, approvalId: `a-${n}` } }
        : x.id === tPerm ? { ...x, state: 'doing', phase: 'executing', stateSince: now }
          : x),
    approvals: [
      ...cur.approvals,
      { id: `a-${n}`, taskId: tPlan, kind: 'plan', state: 'pending', decider: 'user', createdAt: now, createdBy: { kind: 'system' }, payload: { planRev: 1, small: false } },
      { id: `a-${n + 1}`, taskId: tPerm, kind: 'permission', rev: 1, state: 'pending', decider: 'user', createdAt: now, createdBy: { kind: 'system' }, payload: { roleId: 'dev', runId: 'r-0123456789ab', tools: ['Bash(npm test:*)'] } },
    ],
    cards: [
      ...cur.cards,
      { id: `k-${k}`, taskId: tPerm, kind: 'choice', question: 'Que base?', options: ['Postgres', 'SQLite'], multi: false, recommended: 1, state: 'open', from: { kind: 'agent', agentId: 'dev', runId: 'r-0123456789ab', tool: 'ask' }, createdAt: now },
      { id: `k-${k + 1}`, taskId: tPerm, kind: 'text', question: 'Que nombre?', options: [], multi: false, state: 'open', from: { kind: 'agent', agentId: 'dev', runId: 'r-0123456789ab', tool: 'ask' }, createdAt: now },
    ],
    queue: cur.queue.filter((q) => q.taskId !== tPlan && q.taskId !== tPerm),
    nextIds: { ...cur.nextIds, approval: n + 2, card: k + 2 },
  }))
  await w.settle()
  w.poke()
  await w.settle()
  const pa = w.approval(`a-${n}`)
  check(pa.state === 'approved' && w.task(tPlan).phase === 'executing' && w.task(tPlan).plan.status === 'approved', `the plan approved, the task executing (${pa.state} ${w.task(tPlan).phase})`)
  same(pa.decidedBy, AUTO, 'the plan decided by the user via auto')
  same(w.task(tPlan).plan.decidedBy, AUTO, 'and the plan says so')
  const pe = w.approval(`a-${n + 1}`)
  check(pe.state === 'approved' && (w.task(tPerm).grants ?? []).some((g) => g.tool === 'Bash(npm test:*)' && g.roleId === 'dev'), 'the permission granted to the task\'s role')
  const kc = w.card(`k-${k}`)
  check(kc.state === 'answered' && kc.answer.choices.length === 1 && kc.answer.choices[0] === 1, 'the question answered with its recommended option')
  same(kc.answer.by, AUTO, 'by the user via auto')
  check(w.card(`k-${k + 1}`).state === 'open', 'a free text question stays the user\'s')
  const fresh = w.notices.slice(before).map((x) => x.tag)
  check(!fresh.some((t) => t.endsWith(`:a-${n}`) || t.endsWith(`:a-${n + 1}`) || t.endsWith(`:k-${k}`)), `no notice for what the autopilot cleared (${JSON.stringify(fresh)})`)
  check(fresh.includes(`team:${w.teamId}:k-${k + 1}`), 'the question it cannot answer notifies')

  // A dirty checkout: the preview may not land, the row stays and notifies.
  const dirty = await w.integratingTask('Agregar perfil', { 'perfil.txt': 'p\n' })
  write(path.join(w.repo, 'README.md'), '# r editado\n')
  const nd = w.notices.length
  w.poke()
  await w.settle()
  check(w.task(dirty.id).phase === 'integrating' && w.approval(dirty.integrateApproval).state === 'pending', 'a dirty checkout: nothing landed, the approval still pending')
  check(w.logs.some((l) => l.startsWith(`autopilot ${w.teamId} integrate integrate:${dirty.id} left: base_dirty`)), 'the log says why it left it')
  check(w.notices.slice(nd).some((x) => x.tag === `team:${w.teamId}:${dirty.integrateApproval}`), 'and its row notifies now')
  w.poke()
  await w.settle()
  check(w.task(dirty.id).phase === 'integrating', 'a later commit leaves it to the user (skipped while it waits)')
  git(w.repo, 'checkout', '--', 'README.md')
  const man = await w.req({ op: 'integrate', taskId: dirty.id, expectTip: git(w.repo, 'rev-parse', `refs/heads/${dirty.wt.branch}`).trim() })
  check(man.ok, 'the user integrates it by hand')
  await w.settle()
  check(w.task(dirty.id).state === 'done', 'done')

  // 2.9.2: the final OK lands while the QA run that gave the verdict still finishes its turn. The autopilot waits for
  // that run (it used to try, get busy and leave the task to the user for good), then integrates when it ends.
  const qa = await w.integratingTask('Agregar ajustes', { 'ajustes.txt': 'a\n' })
  const qaRunId = 'r-0123456789ac'
  const t3 = w.clock.now
  w.put((cur) => ({
    ...cur,
    agents: cur.agents.map((a) => (a.id === 'dev' ? { ...a, status: 'running', runId: qaRunId } : a)),
    activeRuns: [...cur.activeRuns, {
      id: qaRunId, agentId: 'dev', roleId: 'dev', roleKind: 'dev', taskId: qa.id, sessionKey: qa.id, provider: 'claude', profile: 'readonly', resumed: false,
      cwd: qa.wt.path, repoId: 'main', mode: 'qa', trigger: { reason: 'review', by: 'system' }, state: 'running', reachedRunning: true, resultSeen: false,
      queuedAt: t3, startedAt: t3, concludedBy: { tool: 'verdict', at: t3 },
    }],
  }))
  const nq = w.notices.length
  w.poke()
  await w.settle()
  check(w.task(qa.id).phase === 'integrating' && w.approval(qa.integrateApproval).state === 'pending', 'its run still active: nothing integrated yet')
  check(!w.logs.some((l) => l.startsWith(`autopilot ${w.teamId} integrate integrate:${qa.id} left:`)), 'and the autopilot did not give up on it')
  check(!w.notices.slice(nq).some((x) => x.tag === `team:${w.teamId}:${qa.integrateApproval}`), 'nor notified its row')
  // The run ends (a commit through the service, as the run supervisor's end makes).
  w.svc.commit(w.teamId, {
    ok: true,
    rt: { ...w.rt(), agents: w.rt().agents.map((a) => { if (a.id !== 'dev') return a; const { runId: _gone, ...rest } = a; return { ...rest, status: 'idle' } }), activeRuns: w.rt().activeRuns.filter((r) => r.id !== qaRunId) },
    effects: [],
    result: undefined,
  }, ['team', 'task'])
  await w.settle()
  const tq = w.task(qa.id)
  check(tq.state === 'done' && tq.integrated?.landed === 'ffOnly', `the run ended: integrated (${JSON.stringify(tq.integrate ?? tq.integrated)})`)
  same(w.approval(qa.integrateApproval).decidedBy, AUTO, 'as the user via auto')
  check(!w.notices.slice(nq).some((x) => x.tag === `team:${w.teamId}:${qa.integrateApproval}`), 'and its row never notified')

  // An integrate that failed on something passing (the base moved under it): Integrar again.
  const moved = await w.integratingTask('Agregar ayuda', { 'ayuda.txt': 'h\n' })
  const t4 = w.clock.now
  w.put((cur) => ({ ...cur, tasks: cur.tasks.map((x) => (x.id === moved.id ? { ...x, integrate: { state: 'failed', attempt: 1, error: 'base_moved', step: 'land', at: t4 } } : x)) }))
  w.poke()
  await w.settle()
  const tm = w.task(moved.id)
  check(tm.state === 'done' && tm.integrated?.landed === 'ffOnly', `a base_moved failure is tried again and lands (${JSON.stringify(tm.integrate ?? tm.integrated)})`)

  // A merge conflict: back to the Dev, then AUTOPILOT_REBASE_MAX in a row and the next one left to the user.
  const conf = await w.integratingTask('Cambiar conflicto', { 'conflict.txt': 'rama\n' })
  write(path.join(w.repo, 'conflict.txt'), 'main\n')
  git(w.repo, 'add', '-A')
  git(w.repo, ...ID, 'commit', '-qm', 'main moves')
  w.poke()
  await w.settle()
  const tc = w.task(conf.id)
  check(tc.state === 'doing' && tc.phase === 'executing' && !tc.integrate, `a conflict goes back to the Dev (${tc.state}/${tc.phase})`)
  check(tc.next?.reason === 'rebase' && tc.next.agentId === 'dev', 'with a rebase wake for its Dev')
  check((w.rt().comments[conf.id] ?? []).some((c) => c.sys?.key === 'rebaseConflict'), 'and the rebaseConflict note with the files')
  check(w.approval(conf.integrateApproval).state === 'cancelled', 'the integrate approval cancelled (the next final OK opens a new one)')
  /** The task failed its integrate on a conflict again (as the next cycle would leave it). */
  const failAgain = () => {
    const m = w.rt().nextIds.approval
    const t0 = w.clock.now
    w.put((cur) => ({
      ...cur,
      tasks: cur.tasks.map((x) => {
        if (x.id !== conf.id) return x
        const y = { ...x, state: 'review', phase: 'integrating', stateSince: t0, integrate: { state: 'failed', attempt: 1, error: 'merge_conflict', files: ['conflict.txt'], at: t0 } }
        delete y.next
        return y
      }),
      approvals: [...cur.approvals, { id: `a-${m}`, taskId: conf.id, kind: 'integrate', state: 'pending', decider: 'user', createdAt: t0, createdBy: { kind: 'system' }, payload: { branch: conf.wt.branch, base: 'main' } }],
      queue: cur.queue.filter((q) => q.taskId !== conf.id),
      nextIds: { ...cur.nextIds, approval: m + 1 },
    }))
    return `a-${m}`
  }
  for (let i = 2; i <= M.A.AUTOPILOT_REBASE_MAX; i++) {
    failAgain()
    w.poke()
    await w.settle()
    check(w.task(conf.id).phase === 'executing', `rebase ${i} of ${M.A.AUTOPILOT_REBASE_MAX}: back to the Dev`)
  }
  const last = failAgain()
  const nc = w.notices.length
  w.poke()
  await w.settle()
  check(w.task(conf.id).phase === 'integrating' && w.task(conf.id).integrate?.state === 'failed', 'past AUTOPILOT_REBASE_MAX the failed integrate stays')
  check(w.logs.some((l) => l.startsWith(`autopilot ${w.teamId} rebase rebase:${conf.id} left: cap`)), 'the log says the cap')
  check(w.notices.slice(nc).some((x) => x.tag === `team:${w.teamId}:${last}`), 'and the row notifies')

  // Paused by the user: nothing; unpaused, the pass runs.
  const tP = await w.newTask('Plan pausado')
  check((await w.req({ op: 'settings', patch: { paused: true } })).ok, 'pause the team')
  const p = w.rt().nextIds.approval
  const t1 = w.clock.now
  w.put((cur) => ({
    ...cur,
    tasks: cur.tasks.map((x) => (x.id === tP ? { ...x, state: 'doing', phase: 'planApproval', stateSince: t1, plan: { rev: 1, text: 'p', status: 'pending', small: false, at: t1, approvalId: `a-${p}` } } : x)),
    approvals: [...cur.approvals, { id: `a-${p}`, taskId: tP, kind: 'plan', state: 'pending', decider: 'user', createdAt: t1, createdBy: { kind: 'system' }, payload: { planRev: 1, small: false } }],
    queue: cur.queue.filter((q) => q.taskId !== tP),
    nextIds: { ...cur.nextIds, approval: p + 1 },
  }))
  w.poke()
  await w.settle()
  check(w.approval(`a-${p}`).state === 'pending', 'paused: the plan waits')
  check((await w.req({ op: 'settings', patch: { paused: false } })).ok, 'unpause')
  await w.settle()
  check(w.approval(`a-${p}`).state === 'approved', 'unpaused: the plan approved')

  // Off again: a new plan waits for the user and notifies.
  const offRes = await w.req({ op: 'settings', patch: { autopilot: false } })
  check(offRes.ok && offRes.team.autopilot === undefined && !('autopilot' in w.rt()), 'settings {autopilot: false}: off')
  const tO = await w.newTask('Plan sin piloto')
  const q = w.rt().nextIds.approval
  const t2 = w.clock.now
  const no = w.notices.length
  w.put((cur) => ({
    ...cur,
    tasks: cur.tasks.map((x) => (x.id === tO ? { ...x, state: 'doing', phase: 'planApproval', stateSince: t2, plan: { rev: 1, text: 'p', status: 'pending', small: false, at: t2, approvalId: `a-${q}` } } : x)),
    approvals: [...cur.approvals, { id: `a-${q}`, taskId: tO, kind: 'plan', state: 'pending', decider: 'user', createdAt: t2, createdBy: { kind: 'system' }, payload: { planRev: 1, small: false } }],
    queue: cur.queue.filter((x) => x.taskId !== tO),
    nextIds: { ...cur.nextIds, approval: q + 1 },
  }))
  w.poke()
  await w.settle()
  check(w.approval(`a-${q}`).state === 'pending', 'off: the plan waits for the user')
  check(w.notices.slice(no).some((x) => x.tag === `team:${w.teamId}:a-${q}`), 'and notifies')
}

async function main() {
  try {
    recommendedChecks()
    flagChecks()
    pickChecks()
    await serviceChecks()
    console.log(`PASS: ${checks} teams autopilot checks (recommendedOf and its suffix fallback, setTeamFlags, autopilotPicks and autopilotTakes, the settings op, a plan, a permission and a recommended answer decided as the user via auto with no notice, a free question left and notified, a clean merge integrated, a dirty checkout left and notified, an integrate that waits for the task's run to end, a transient failure tried again, a conflict back to the Dev and the rebase cap, paused and off)`)
  } finally {
    for (const s of services) { try { s.dispose() } catch { /* already gone */ } }
    await new Promise((r) => setTimeout(r, 200))
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* a dying child still holds a file */ }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => setTimeout(() => process.exit(), 2000).unref())
