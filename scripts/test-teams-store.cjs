// Teams store, definition loader, trust and service (app 2.7.0, E10 B1): the zod
// request union (accept and reject), the flow reducers of B1 and the invariants,
// TeamStore (commit, rev, task rev, debounce on a manual clock, sync flush while
// not live, idempotent flush, runs.json before state.json, terminal wins at load,
// corrupt state -> stateReset card, salvage), the registry (ids, trash, purge by
// shape, an unreadable index never cached as empty), TeamTrust (approve, snapshot
// integrity, io when the trust write does not land), the loader (links and
// junctions refused, caps, stamp cache, misnamed files named to the parser and
// never read, write), and TeamService on real git repos with an isolated config:
// enable ends with a list change, an unreadable index answers io and is retried
// (never after dispose),
// setup preview and write, adopt, the trust gate, a changed definition flipped by
// the defwatch deadline, a misnamed role file, extra repos through repoOf, Labs
// off with zero deadline keys, remove, settings, reveal and the IPC register.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), label); checks++ }
const json = (v) => JSON.parse(JSON.stringify(v ?? null))
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
function loadEntry(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, TextEncoder, TextDecoder, ...overrides })
  return mod.exports
}

const M = loadEntry(`
export * from './src/shared/team-protocol-schemas'
export * from './src/shared/teams'
export { PHONE_TEAM_OPS } from './src/shared/team-protocol'
export { defaultDraft, renderTeamFiles, canonicalDefText, parseDefinition } from './src/shared/teamDefinition'
export * from './src/main/teams/flow/agents'
export * from './src/main/teams/flow/invariants'
export { TeamStore, salvageRuntime, TEAM_FLUSH_MS } from './src/main/teams/TeamStore'
export { TeamRegistry, teamIdOf, resolveMainRoot } from './src/main/teams/TeamRegistry'
export { TeamDefinitionLoader } from './src/main/teams/TeamDefinitionLoader'
export { TeamTrust, sha256Hex, goalHashOf } from './src/main/teams/TeamTrust'
export { TeamService } from './src/main/teams/TeamService'
export { TrustStore } from './src/main/repoConfig/TrustStore'
export { DeadlineTimer } from './src/main/DeadlineTimer'
export { writeAtomicSync } from './src/main/fsAtomic'
export { createGitRunner, gitEnv } from './src/main/git/gitExec'
`)

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
const until = async (fn, ms = 5000, label = 'condition') => {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}
const settle = () => new Promise((r) => setTimeout(r, 40))

/** A manual clock and the timer deps of DeadlineTimer on it. */
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

// ---- 1. schemas -------------------------------------------------------------------------------
function schemaChecks() {
  const ok = (req, label) => check(M.teamRequestSchema.safeParse(req).success, `schema accepts ${label}`)
  const no = (req, label) => check(!M.teamRequestSchema.safeParse(req).success, `schema rejects ${label}`)
  const teamId = 'tm-0123456789ab'
  const draft = { ...json(M.defaultDraft('es')), goal: 'Hacer la app' }
  ok({ op: 'list' }, 'list')
  ok({ op: 'get', teamId }, 'get')
  ok({ op: 'setupProbe', dir: 'C:\\repo' }, 'a Windows drive path')
  ok({ op: 'setupProbe', dir: '/home/u/repo' }, 'a POSIX path')
  ok({ op: 'setupProbe', dir: '\\\\server\\share\\repo' }, 'a UNC path')
  no({ op: 'setupProbe', dir: 'repo' }, 'a relative dir')
  no({ op: 'setupProbe', dir: 'C:\\re\0po' }, 'a NUL in the dir')
  no({ op: 'setupProbe', dir: 'C:\\' + 'a'.repeat(4100) }, 'a dir over 4096')
  ok({ op: 'setupPreview', repoRoot: 'C:\\repo', draft }, 'the default draft')
  ok({ op: 'setupWrite', repoRoot: 'C:\\repo', draft, previewHash: 'a'.repeat(64) }, 'setupWrite')
  no({ op: 'setupWrite', repoRoot: 'C:\\repo', draft, previewHash: 'xyz' }, 'a bad preview hash')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, roles: Array.from({ length: 13 }, (_, i) => ({ ...draft.roles[1], id: `r${i}` })) } }, 'more than ROLES_MAX roles')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, roles: [draft.roles[0], draft.roles[0]] } }, 'a duplicate role id')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, roles: [{ ...draft.roles[0], model: 'gpt-5' }] } }, 'a codex model on a claude role')
  ok({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, roles: [{ ...draft.roles[0], provider: 'codex', model: 'gpt-5', effort: 'minimal' }] } }, 'a codex model and effort on a codex role')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, roles: [{ ...draft.roles[0], effort: 'minimal' }] } }, 'a codex effort on a claude role')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, roles: [{ ...draft.roles[1], count: 5 }] } }, 'count 5')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, roles: [{ ...draft.roles[1], id: 'Dev' }] } }, 'a role id off ROLE_ID_RE')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, name: 'a\u0007b' } }, 'a control char in the name')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, goal: 'x'.repeat(8 * 1024 + 1) } }, 'a goal over GOAL_MAX')
  ok({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, goal: 'line 1\n\tline 2' } }, 'newline and tab in a body')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, goal: 'a\u0000b' } }, 'a NUL in a body')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, maxConcurrent: 4 } }, 'maxConcurrent 4')
  no({ op: 'setupPreview', repoRoot: 'C:\\repo', draft: { ...draft, baseBranch: 'a..b' } }, 'a bad base branch')
  ok({ op: 'adopt', repoRoot: '/r', sha256: 'b'.repeat(64) }, 'adopt')
  ok({ op: 'trust', teamId, sha256: 'b'.repeat(64) }, 'trust')
  no({ op: 'trust', teamId: 'tm-XYZ', sha256: 'b'.repeat(64) }, 'a bad team id')
  ok({ op: 'settings', teamId, patch: { autoDispatch: true } }, 'settings')
  no({ op: 'settings', teamId, patch: { autoDispatch: 'yes' } }, 'a non boolean flag')
  ok({ op: 'reveal', teamId, what: 'data' }, 'reveal')
  no({ op: 'reveal', teamId, what: 'C:\\Windows' }, 'reveal of a path')
  ok({ op: 'runNow', teamId, agentId: 'dev-2', prompt: 'hola' }, 'runNow')
  no({ op: 'runNow', teamId, agentId: 'Dev' }, 'a bad agent id')
  ok({ op: 'runPage', teamId, runId: 'r-0123456789ab', before: '123' }, 'runPage')
  no({ op: 'runPage', teamId, runId: 'r-0123456789ab', before: '12a' }, 'a non numeric runPage cursor')
  ok({ op: 'watchRun', teamId, runId: null }, 'watchRun null')
  ok({ op: 'board', teamId, column: 'done', limit: 500 }, 'board limit 500')
  no({ op: 'board', teamId, limit: 0 }, 'board limit 0')
  no({ op: 'board', teamId, limit: 501 }, 'board limit 501')
  ok({ op: 'createTask', teamId, task: { title: 'T', blockedBy: ['t-1'], priority: 'urgent' } }, 'createTask')
  no({ op: 'createTask', teamId, task: { title: '' } }, 'an empty title')
  no({ op: 'createTask', teamId, task: { title: 'a\nb' } }, 'a newline in a title')
  no({ op: 'createTask', teamId, task: { title: 'T', blockedBy: Array.from({ length: 17 }, (_, i) => `t-${i + 1}`) } }, 'more than BLOCKED_BY_MAX blockers')
  ok({ op: 'updateTask', teamId, taskId: 't-3', baseRev: 2, patch: { assignee: null } }, 'updateTask unassign')
  ok({ op: 'moveTask', teamId, taskId: 't-3', baseRev: 2, to: 'cancelled', stopRun: true }, 'moveTask')
  no({ op: 'moveTask', teamId, taskId: 't-3', baseRev: 2, to: 'doing' }, 'a move into doing')
  ok({ op: 'releaseOwned', teamId, taskId: 't-3', fields: ['priority', 'state'] }, 'releaseOwned')
  no({ op: 'releaseOwned', teamId, taskId: 't-3', fields: ['owner'] }, 'an unknown task field')
  ok({ op: 'dispatch', teamId, queueId: 'all', go: true }, 'dispatch all')
  no({ op: 'dispatch', teamId, queueId: 'q-x', go: true }, 'a bad queue id')
  ok({ op: 'answer', teamId, cardId: 'k-1', answer: { choices: [0, 5] } }, 'answer choices 0..5')
  no({ op: 'answer', teamId, cardId: 'k-1', answer: { choices: [6] } }, 'answer choice 6')
  no({ op: 'answer', teamId, cardId: 'k-1', answer: { choices: [0, 1, 2, 3, 4, 5, 0] } }, 'answer with 7 choices')
  no({ op: 'answer', teamId, cardId: 'k-1', answer: { action: 'format' } }, 'an unknown card action')
  ok({ op: 'integrate', teamId, taskId: 't-1', expectTip: 'c'.repeat(40) }, 'integrate')
  no({ op: 'integrate', teamId, taskId: 't-1', expectTip: 'c'.repeat(12) }, 'a short expectTip')
  ok({ op: 'confirmVerify', teamId, repoId: 'main', command: 'npm test' }, 'confirmVerify')
  no({ op: 'confirmVerify', teamId, repoId: 'main', command: 'npm test\nrm -rf /' }, 'a two line verify command')
  ok({ op: 'note', teamId, noteId: 'n-0123456789abcdef' }, 'note')
  ok({ op: 'takeoverBound', teamId, agentId: 'dev', paneId: 'pane-1', workspaceId: 'w1' }, 'takeoverBound')
  no({ op: 'nope', teamId }, 'an unknown op')
  no(null, 'null')
  check(M.parseTeamRequest({ op: 'list' })?.op === 'list' && M.parseTeamRequest({ op: 'x' }) === null, 'parseTeamRequest')
  const phone = (req) => M.phoneTeamRequestSchema.safeParse(req).success
  check(phone({ op: 'board', teamId }) && phone({ op: 'leadSay', teamId, text: 'hola' }) && phone({ op: 'list' }), 'phone schema accepts its ops')
  check(!phone({ op: 'setupWrite', repoRoot: '/r', draft, previewHash: 'a'.repeat(64) }) && !phone({ op: 'trust', teamId, sha256: 'b'.repeat(64) }) && !phone({ op: 'integrate', teamId, taskId: 't-1', expectTip: 'c'.repeat(40) }), 'phone schema rejects desktop ops')
  same(M.PHONE_TEAM_OPS.map((op) => M.phoneTeamRequestSchema.options.some((o) => o.shape.op.value === op)), M.PHONE_TEAM_OPS.map(() => true), 'the phone union holds every PHONE_TEAM_OPS member')
  const [decide, answer, dispatch] = M.teamCtlActionSchemas
  check(decide.safeParse({ kind: 'teamDecide', teamId, approvalId: 'a-1', decision: 'approve' }).success && answer.safeParse({ kind: 'teamAnswer', teamId, cardId: 'k-2', answer: { confirm: true } }).success && dispatch.safeParse({ kind: 'teamDispatch', teamId, queueId: 'q-1', go: false }).success, 'ctl action schemas')
}

// ---- 2. flow reducers and invariants ------------------------------------------------------------
function defOf(roles) {
  const base = json(M.defaultDraft('en'))
  return { def: { name: 'T', goal: 'g', rules: '', verifyTimeoutMin: 20, maxRunMinutes: 45, maxConcurrent: 2, leadApprovesSmallPlans: true, extraRepos: [], routines: [], roles }, sha256: 'a'.repeat(64), goalHash: 'b'.repeat(64), trustedAt: 1, files: [], _base: base }
}
const role = (id, kind, count = 1, provider = 'claude') => ({ id, name: id, kind, provider, permission: kind === 'dev' ? 'total' : 'readonly', count, instructions: 'x' })

function flowChecks() {
  const ctxOf = (def) => ({ now: 1000, def, newRunId: () => 'r-000000000001', newSessionId: () => 'uuid' })
  let rt = M.emptyRuntime('tm-0123456789ab', 'deadbeef')
  const def1 = defOf([role('lead', 'lead'), role('dev', 'dev', 2), role('qa', 'qa')])
  let r = M.reconcileAgents(rt, ctxOf(def1))
  same(r.rt.agents.map((a) => a.id), ['lead', 'dev', 'dev-2', 'qa'], 'reconcileAgents: agentIdOf(role, 1..count) in definition order')
  check(r.rt.agents.every((a) => a.status === 'idle' && !a.paused && a.interrupts === 0), 'new agents are idle')
  check(M.assertInvariants(r.rt, def1).length === 0, 'the roster holds the invariants')
  rt = r.rt
  const again = M.reconcileAgents(rt, ctxOf(def1))
  check(again.rt === rt, 'an unchanged roster returns the same rt (no commit)')
  const def3 = defOf([role('lead', 'lead'), role('dev', 'dev', 3), role('qa', 'qa')])
  r = M.reconcileAgents(rt, ctxOf(def3))
  check(r.rt.agents.find((a) => a.id === 'dev') === rt.agents.find((a) => a.id === 'dev') && r.rt.agents.some((a) => a.id === 'dev-3'), 'raising count keeps the existing agents and adds dev-3')
  // dev-2 running when the count drops: retired, removed once idle.
  const running = { ...rt, agents: rt.agents.map((a) => (a.id === 'dev-2' ? { ...a, status: 'running', runId: 'r-000000000009' } : a)) }
  const def1dev = defOf([role('lead', 'lead'), role('dev', 'dev', 1), role('qa', 'qa')])
  r = M.reconcileAgents(running, ctxOf(def1dev))
  check(r.rt.agents.find((a) => a.id === 'dev-2')?.retired === true, 'a running agent beyond the count is retired')
  r = M.reconcileAgents(rt, ctxOf(def1dev))
  check(!r.rt.agents.some((a) => a.id === 'dev-2'), 'an idle agent beyond the count is removed')
  const withSession = { ...rt, agents: rt.agents.map((a) => (a.id === 'qa' ? { ...a, sessions: { 't-1': { provider: 'claude', sessionId: 's1', cwd: 'C:\\r', createdAt: 1, turns: 1, sysHash: 'h' } } } : a)) }
  r = M.reconcileAgents(withSession, ctxOf(defOf([role('lead', 'lead'), role('dev', 'dev', 2), role('qa', 'qa', 1, 'codex')])))
  const qa = r.rt.agents.find((a) => a.id === 'qa')
  check(qa.provider === 'codex' && Object.keys(qa.sessions).length === 0, 'a provider change drops the sessions of a free agent')
  // setTeamFlags.
  let f = M.setTeamFlags(rt, { autoDispatch: true }, { now: 5 })
  check(f.rt.autoDispatch === true && same0(f.effects, [{ kind: 'dispatch' }]), 'autonomy on pokes the dispatcher')
  f = M.setTeamFlags(f.rt, { paused: true }, { now: 6 })
  check(f.rt.paused.reason === 'user' && f.rt.paused.at === 6 && f.effects.length === 0, 'a user pause')
  f = M.setTeamFlags(f.rt, { paused: false }, { now: 7 })
  check(f.rt.paused === null && f.effects.length === 1, 'unpause pokes')
  check(M.setTeamFlags(rt, {}, { now: 1 }).rt === rt, 'an empty patch changes nothing')
  // system cards.
  let c = M.openSystemCard(rt, { why: 'stateReset', actions: ['dismiss'], vars: { what: 'trust' } }, { now: 9 })
  check(c.result.cardId === 'k-1' && c.rt.nextIds.card === 2 && c.rt.cards[0].question === '' && c.rt.cards[0].from.why === 'stateReset', 'openSystemCard mints k-1')
  check(M.openSystemCard(c.rt, { why: 'stateReset', actions: ['dismiss'], vars: { what: 'trust' } }, { now: 10 }).rt === c.rt, 'the same open reason is raised once')
  check(M.openSystemCard(c.rt, { why: 'stateReset', actions: ['dismiss'], vars: { what: 'state' } }, { now: 10 }).result.cardId === 'k-2', 'another what is another card')
  check(M.dismissSystemCards(c.rt, 'stateReset', 'trust').rt.cards[0].state === 'dismissed', 'dismissSystemCards')
  // invariants catch what they should.
  const bad = (mut, rule) => {
    const x = mut(json(rt))
    check(M.assertInvariants(x, def1).some((l) => l.startsWith(rule + ':')), `invariant ${rule} detected`)
  }
  const task = (id, extra = {}) => ({ id, rev: 1, title: id, body: '', state: 'todo', phase: 'none', priority: 'normal', repoId: 'main', isolation: 'main', needsPlan: false, blockedBy: [], createdBy: { kind: 'user', via: 'desktop' }, createdAt: 1, updatedAt: 1, stateSince: 1, review: { round: 0, max: 3 }, userOwned: [], counters: { noProgress: 0, continuations: 0, retries: 0, interrupts: 0, unblockWakes: 0, unblockWindowStart: 0 }, ...extra })
  bad((x) => { x.agents[1].status = 'running'; return x }, 'I2')
  bad((x) => { x.tasks = [task('t-1', { state: 'doing', phase: 'none' })]; x.nextIds.task = 2; return x }, 'I6')
  bad((x) => { x.tasks = [task('t-1', { state: 'blocked', phase: 'none' })]; x.nextIds.task = 2; return x }, 'I7')
  bad((x) => { x.tasks = [task('t-5')]; return x }, 'I14')
  bad((x) => { x.tasks = [task('t-1', { blockedBy: ['t-2'] }), task('t-2', { blockedBy: ['t-1'] })]; x.nextIds.task = 3; return x }, 'I17')
  bad((x) => { x.tasks = [task('t-1', { userOwned: ['title', 'title'] })]; x.nextIds.task = 2; return x }, 'I16')
  bad((x) => { x.tasks = [task('t-1')]; x.nextIds.task = 2; x.nextIds.comment = 2; x.comments = { 't-1': [{ id: 'm-1', target: 't-1', author: { kind: 'system' }, kind: 'system', at: 1, text: '', }] }; return x }, 'I22')
  bad((x) => { x.queue = [{ id: 'q-1', agentId: 'ghost', sessionKey: 'free', mode: 'free', reason: 'manual', createdAt: 1 }]; x.nextIds.queue = 2; return x }, 'I13')
  check(M.assertInvariants(rt, def1, { prev: rt }).length === 0, 'I15 holds for the same rt')
}
function same0(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

// ---- 3. TeamStore -------------------------------------------------------------------------------
function storeChecks(tmp) {
  const dir = path.join(tmp, 'store', 'tm-0123456789ab')
  const clock = manualClock()
  const timer = new M.DeadlineTimer((key) => { if (key === 'flush:tm-0123456789ab') store.flushSync() }, clock.deps)
  let live = true
  const emits = []
  const logs = []
  const writes = []
  const realFs = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, mkdirSync: fs.mkdirSync, rmSync: fs.rmSync, appendFileSync: fs.appendFileSync, statSync: fs.statSync }
  const spyFs = { ...realFs, renameSync: (a, b) => { writes.push(path.basename(b)); return fs.renameSync(a, b) } }
  const deps = { dir: () => dir, emit: (scopes, hint) => emits.push({ scopes, hint }), timer, live: () => live, now: () => clock.now, fs: spyFs, log: (l) => logs.push(l), strict: true, newGen: () => 'cafebabe' }
  let { store, repaired } = M.TeamStore.load(deps, 'tm-0123456789ab', null)
  check(store.rt.rev === 0 && store.rt.gen === 'cafebabe' && repaired.length === 0, 'a missing state is a fresh runtime with the minted gen')
  check(timer.has('flush:tm-0123456789ab'), 'a fresh runtime is written after the debounce')
  check(Object.isFrozen(store.rt) && Object.isFrozen(store.rt.agents), 'strict mode deep-freezes rt')
  clock.advance(M.TEAM_FLUSH_MS)
  check(fs.existsSync(path.join(dir, 'state.json')) && !fs.readFileSync(path.join(dir, 'state.json')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'state.json written, UTF-8 without BOM')
  check(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp file left')
  // commit, rev, task rev.
  const task = { id: 't-1', rev: 1, title: 'A', body: '', state: 'todo', phase: 'none', priority: 'normal', repoId: 'main', isolation: 'main', needsPlan: false, blockedBy: [], createdBy: { kind: 'user', via: 'desktop' }, createdAt: 1, updatedAt: 1, stateSince: 1, review: { round: 0, max: 3 }, userOwned: [], counters: { noProgress: 0, continuations: 0, retries: 0, interrupts: 0, unblockWakes: 0, unblockWindowStart: 0 } }
  const rt0 = store.rt
  const res = store.commit({ ok: true, rt: { ...rt0, tasks: [task], nextIds: { ...rt0.nextIds, task: 2 } }, effects: [], result: 'x' }, ['board'], { taskId: 't-1' })
  check(res.ok && res.result === 'x' && store.rt.rev === 1 && store.rt.tasks[0].rev === 1, 'commit bumps rt.rev; a new task keeps its rev')
  same(emits.at(-1), { scopes: ['board'], hint: { taskId: 't-1' } }, 'commit emits its scopes and hint')
  const t1 = store.rt.tasks[0]
  store.commit({ ok: true, rt: { ...store.rt, tasks: [{ ...t1, title: 'B' }] }, effects: [], result: undefined }, ['task'])
  check(store.rt.rev === 2 && store.rt.tasks[0].rev === 2 && store.rt.tasks[0].title === 'B', 'a changed task object gets rev + 1')
  const kept = store.rt.tasks[0]
  store.commit({ ok: true, rt: { ...store.rt, autoDispatch: true }, effects: [], result: undefined }, ['team'])
  check(store.rt.tasks[0] === kept && store.rt.tasks[0].rev === 2, 'an untouched task keeps its rev')
  const before = store.rt
  check(store.commit({ ok: false, error: 'conflict', reason: 'rev' }, ['task']).ok === false && store.rt === before, 'a failed result changes nothing')
  check(store.commit({ ok: true, rt: before, effects: [], result: undefined }, ['task']).ok && store.rt.rev === before.rev, 'an unchanged rt is not committed')
  assert.throws(() => store.commit({ ok: true, rt: { ...store.rt, agents: [{ id: 'dev', roleId: 'dev', roleKind: 'dev', provider: 'claude', status: 'running', paused: false, sessions: {}, interrupts: 0 }] }, effects: [], result: undefined }, ['agents']), /I2/); checks++
  check(store.rt === before, 'a commit that breaks an invariant (strict) does not land')
  // debounce: one timer for a burst, written once due.
  check(timer.has('flush:tm-0123456789ab'), 'a dirty commit arms flush')
  const at = timer.at('flush:tm-0123456789ab')
  clock.advance(100)
  store.commit({ ok: true, rt: { ...store.rt, autoDispatch: false }, effects: [], result: undefined }, ['team'])
  check(timer.at('flush:tm-0123456789ab') === at, 'a burst keeps the first deadline (250 ms debounce)')
  writes.length = 0
  clock.advance(M.TEAM_FLUSH_MS)
  same(writes, ['state.json'], 'the debounce writes state.json once')
  check(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).rev === store.rt.rev, 'state.json holds the last rev')
  check(store.lastBytes === Buffer.byteLength(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), 'lastBytes is the size written')
  writes.length = 0
  store.flushSync()
  check(writes.length === 0, 'flushSync of a clean store writes nothing (idempotent)')
  // not live: commits flush synchronously.
  live = false
  store.commit({ ok: true, rt: { ...store.rt, autoDispatch: true }, effects: [], result: undefined }, ['team'])
  check(writes.length === 1 && !timer.has('flush:tm-0123456789ab'), 'a commit while not live flushes at once')
  live = true
  // runs.json before state.json; recentRuns.
  const run = { id: 'r-0123456789ab', agentId: 'dev', roleId: 'dev', roleKind: 'dev', sessionKey: 'free', provider: 'claude', profile: 'total', resumed: false, cwd: 'C:\\r', repoId: 'main', mode: 'free', trigger: { reason: 'manual', by: 'user' }, state: 'succeeded', reachedRunning: true, resultSeen: true, queuedAt: 1, endedAt: 2 }
  writes.length = 0
  store.commit({ ok: true, rt: { ...store.rt, autoDispatch: false }, effects: [], result: undefined }, ['team'])
  store.recordRun(run)
  store.flushSync()
  same(writes, ['runs.json', 'state.json'], 'a flush writes runs.json before state.json')
  check(store.recentRuns().length === 1 && store.recentRuns(1)[0].id === run.id, 'recentRuns holds the ring')
  store.recordRun({ ...run, summary: 'again' })
  check(store.recentRuns().length === 1 && store.recentRuns()[0].summary === 'again', 'recordRun replaces by id')
  // setNeedsSeen: no rev, no emit.
  const rev = store.rt.rev
  const nEmits = emits.length
  store.setNeedsSeen(['trust', 'k-1'])
  check(store.rt.rev === rev && emits.length === nEmits && same0(store.rt.needsSeen, ['trust', 'k-1']), 'setNeedsSeen marks dirty without rev or emit')
  store.appendArchive('tasks', [{ id: 't-9' }])
  store.appendArchive('../x', [{ id: 't-9' }])
  check(fs.readFileSync(path.join(dir, 'archive', 'tasks.jsonl'), 'utf8') === '{"id":"t-9"}\n' && !fs.existsSync(path.join(dir, 'x.jsonl')), 'appendArchive appends jsonl to a known file only')
  store.dispose()
  check(!timer.has('flush:tm-0123456789ab') && JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).needsSeen.length === 2, 'dispose flushes and clears the key')

  // terminal wins at load: a crash between runs.json and state.json.
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  st.agents = [{ id: 'dev', roleId: 'dev', roleKind: 'dev', provider: 'claude', status: 'running', paused: false, runId: run.id, sessions: {}, interrupts: 0 }]
  st.activeRuns = [{ ...run, state: 'running' }]
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st))
  ;({ store, repaired } = M.TeamStore.load({ ...deps, fs: realFs }, 'tm-0123456789ab', null))
  check(store.rt.activeRuns.length === 0 && store.rt.agents[0].status === 'idle' && store.rt.agents[0].runId === undefined && repaired.some((r) => r.includes(run.id)), 'a run terminal in runs.json wins over its active copy')
  store.dispose()

  // salvage: a bad element is dropped and named.
  const st2 = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  st2.agents.push({ id: 'broken' })
  st2.cards = [{ junk: true }]
  st2.nextIds = { task: 'x' }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st2))
  ;({ store, repaired } = M.TeamStore.load({ ...deps, fs: realFs }, 'tm-0123456789ab', null))
  check(store.rt.agents.length === 1 && store.rt.cards.length === 0 && repaired.includes('agents[1]') && repaired.includes('cards[0]') && repaired.includes('nextIds'), 'salvage drops bad elements and falls back per field')
  check(store.rt.nextIds.task === 2, 'a salvaged counter is raised above the kept ids')
  store.dispose()

  // corrupt state -> moved aside, empty runtime with a stateReset card.
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json')
  clock.now += 1000
  ;({ store, repaired } = M.TeamStore.load({ ...deps, fs: realFs, newGen: () => '0badf00d' }, 'tm-0123456789ab', null))
  check(fs.existsSync(path.join(dir, `state.corrupt-${clock.now}.json`)) && repaired.includes('state.json'), 'a corrupt state.json is moved to state.corrupt-<ts>.json')
  const card = store.rt.cards[0]
  check(store.rt.cards.length === 1 && card.from.kind === 'system' && card.from.why === 'stateReset' && card.from.vars.what === 'state' && card.state === 'open', 'a stateReset card is opened')
  check(store.rt.gen === '0badf00d' && store.rt.tasks.length === 0, 'the reset runtime is empty with a new gen')
  store.dispose()
  fs.writeFileSync(path.join(dir, 'runs.json'), '[broken')
  ;({ store, repaired } = M.TeamStore.load({ ...deps, fs: realFs }, 'tm-0123456789ab', null))
  check(store.recentRuns().length === 0 && repaired.includes('runs.json'), 'a corrupt runs.json starts an empty ring')
  store.dispose()
  // A locked state.json (antivirus, EBUSY) fails the load and is never moved aside nor reset.
  const lockedBefore = fs.readFileSync(path.join(dir, 'state.json'), 'utf8')
  const lockedFs = { ...realFs, readFileSync: (p, enc) => { if (path.basename(p) === 'state.json') { const e = new Error('busy'); e.code = 'EBUSY'; throw e } return fs.readFileSync(p, enc) } }
  assert.throws(() => M.TeamStore.load({ ...deps, fs: lockedFs }, 'tm-0123456789ab', null), /unreadable EBUSY/); checks++
  check(fs.readFileSync(path.join(dir, 'state.json'), 'utf8') === lockedBefore && !fs.readdirSync(dir).some((f) => f.startsWith('state.corrupt-') && f !== `state.corrupt-${clock.now}.json`), 'a locked state.json stays as it was')
  check(timer.size === 0, 'no key left after dispose')
  timer.dispose()

  // writeAtomicSync removes the temp file when the rename fails.
  const target = path.join(tmp, 'atomic', 'x.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  assert.throws(() => M.writeAtomicSync(target, 'x', {}, { writeFileSync: fs.writeFileSync, renameSync: () => { throw new Error('busy') }, rmSync: fs.rmSync })); checks++
  check(fs.readdirSync(path.dirname(target)).length === 0, 'writeAtomicSync cleans its temp file on failure')
}

// ---- 4. registry ---------------------------------------------------------------------------------
function registryChecks(tmp) {
  const teams = path.join(tmp, 'reg', 'teams')
  let clock = 1_800_000_000_000
  const reg = new M.TeamRegistry({ file: () => path.join(teams, 'index.json'), trashDir: () => path.join(teams, '.trash'), now: () => clock })
  check(reg.list().length === 0, 'a missing index registers nothing')
  // normTrustPath resolves with the host path module: the win32 spellings only mean one folder on Windows.
  const id = M.teamIdOf(path.join(tmp, 'Repos', 'App'))
  check(/^tm-[a-f0-9]{12}$/.test(id) && id === M.teamIdOf(path.join(tmp, 'Repos', 'App') + path.sep), 'teamIdOf: a trailing separator is the same team')
  if (process.platform === 'win32') {
    check(M.teamIdOf('C:\\Repos\\App', 'win32') === M.teamIdOf('c:\\repos\\app\\', 'win32'), 'teamIdOf: case insensitive on win32')
    check(M.teamIdOf('C:\\Repos\\App', 'win32') === 'tm-' + sha('c:\\repos\\app').slice(0, 12), 'teamIdOf is sha256(normTrustPath).slice(0, 12)')
  } else {
    check(M.teamIdOf('/r/App', 'linux') !== M.teamIdOf('/r/app', 'linux'), 'teamIdOf: case sensitive off Windows')
    check(M.teamIdOf('/r/App', 'linux') === 'tm-' + sha('/r/App').slice(0, 12), 'teamIdOf is sha256(normTrustPath).slice(0, 12)')
  }
  reg.put({ id, repoRoot: path.join(tmp, 'repo'), name: 'App', baseBranch: 'main', createdAt: 1 })
  check(new M.TeamRegistry({ file: () => path.join(teams, 'index.json'), trashDir: () => '' }).get(id)?.name === 'App', 'put persists the entry')
  const raw = JSON.parse(fs.readFileSync(path.join(teams, 'index.json'), 'utf8'))
  check(raw.v === 1 && raw.teams.length === 1, 'index.json {v:1, teams}')
  fs.writeFileSync(path.join(teams, 'index.json'), JSON.stringify({ v: 1, teams: [raw.teams[0], { id: 'bad' }, raw.teams[0]] }))
  check(new M.TeamRegistry({ file: () => path.join(teams, 'index.json'), trashDir: () => '' }).list().length === 1, 'junk and duplicate entries are dropped')
  fs.mkdirSync(path.join(teams, id), { recursive: true })
  fs.writeFileSync(path.join(teams, id, 'state.json'), '{}')
  // Finding 2: a move that fails (EBUSY from an antivirus, EPERM) keeps the entry and says so.
  const trashLogs = []
  const busyFs = { mkdirSync: fs.mkdirSync, renameSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e } }
  const regBusy = new M.TeamRegistry({ file: () => path.join(teams, 'index.json'), trashDir: () => path.join(teams, '.trash'), now: () => clock, log: (l) => trashLogs.push(l), fs: busyFs })
  check(regBusy.trash(id) === false && regBusy.get(id)?.name === 'App' && fs.existsSync(path.join(teams, id, 'state.json')), 'a failed move: false, the entry and the folder stay')
  check(JSON.parse(fs.readFileSync(path.join(teams, 'index.json'), 'utf8')).teams.some((e) => e.id === id) && trashLogs.includes(`registry trash ${id} failed EBUSY`), 'index.json keeps the entry; the log has the code')
  const reg2 = new M.TeamRegistry({ file: () => path.join(teams, 'index.json'), trashDir: () => path.join(teams, '.trash'), now: () => clock })
  check(reg2.trash(id) === true, 'trash answers true when the folder moved')
  check(!fs.existsSync(path.join(teams, id)) && fs.existsSync(path.join(teams, '.trash', `${id}-${clock}`, 'state.json')) && reg2.list().length === 0, 'trash moves teams/<id> to .trash/<id>-<ts> and drops the entry')
  const goneId = M.teamIdOf(path.join(tmp, 'gone'))
  reg2.put({ id: goneId, repoRoot: path.join(tmp, 'gone'), name: 'Gone', baseBranch: 'main', createdAt: 1 })
  check(reg2.trash(goneId) === true && !reg2.get(goneId), 'a team without a folder (ENOENT): true, the entry goes')
  check(reg2.trash('not-an-id') === false, 'an id off TEAM_ID_RE is never moved')
  // purge by shape only.
  const trash = path.join(teams, '.trash')
  const old = clock - 31 * 86_400_000
  const recent = clock - 86_400_000
  fs.mkdirSync(path.join(trash, `tm-aaaaaaaaaaaa-${old}`), { recursive: true })
  fs.mkdirSync(path.join(trash, `tm-bbbbbbbbbbbb-${recent}`), { recursive: true })
  fs.mkdirSync(path.join(trash, 'tm-123456789012'), { recursive: true })
  fs.writeFileSync(path.join(trash, 'tm-123456789012', `n-old-${old}.md`), 'x')
  fs.writeFileSync(path.join(trash, 'tm-123456789012', `n-new-${recent}.md`), 'x')
  fs.writeFileSync(path.join(trash, 'tm-123456789012', 'keep.md'), 'x')
  fs.mkdirSync(path.join(trash, `other-${old}`), { recursive: true })
  reg2.purge()
  check(!fs.existsSync(path.join(trash, `tm-aaaaaaaaaaaa-${old}`)) && fs.existsSync(path.join(trash, `tm-bbbbbbbbbbbb-${recent}`)), 'purge removes deleted teams past 30 days only')
  check(fs.existsSync(path.join(trash, 'tm-123456789012')) && !fs.existsSync(path.join(trash, 'tm-123456789012', `n-old-${old}.md`)) && fs.existsSync(path.join(trash, 'tm-123456789012', `n-new-${recent}.md`)) && fs.existsSync(path.join(trash, 'tm-123456789012', 'keep.md')), 'a tm-123456789012 note-trash folder is never removed whole; only stamped entries past 30 days go')
  check(fs.existsSync(path.join(trash, `other-${old}`)), 'an unknown shape is left alone')

  // An index.json that cannot be read (here a folder: EISDIR; EBUSY or EACCES alike) is never cached as empty.
  const lockedDir = path.join(tmp, 'reg-locked', 'teams')
  const lockedFile = path.join(lockedDir, 'index.json')
  fs.mkdirSync(lockedFile, { recursive: true })
  const regLogs = []
  const reg3 = new M.TeamRegistry({ file: () => lockedFile, trashDir: () => path.join(lockedDir, '.trash'), now: () => clock, log: (l) => regLogs.push(l) })
  assert.throws(() => reg3.list()); checks++
  check(regLogs.some((l) => /^registry read failed E[A-Z]+$/.test(l)), 'the read error is logged with its code only')
  assert.throws(() => reg3.put({ id, repoRoot: path.join(tmp, 'repo2'), name: 'Two', baseBranch: 'main', createdAt: 2 })); checks++
  check(fs.statSync(lockedFile).isDirectory(), 'a put() while unreadable writes nothing')
  fs.rmSync(lockedFile, { recursive: true })
  fs.writeFileSync(lockedFile, JSON.stringify({ v: 1, teams: [{ id, repoRoot: path.join(tmp, 'repo'), name: 'App', baseBranch: 'main', createdAt: 1 }] }))
  check(reg3.get(id)?.name === 'App', 'the next call reads the file again')
  const id2 = M.teamIdOf(path.join(tmp, 'repo2'))
  reg3.put({ id: id2, repoRoot: path.join(tmp, 'repo2'), name: 'Two', baseBranch: 'main', createdAt: 2 })
  same(JSON.parse(fs.readFileSync(lockedFile, 'utf8')).teams.map((e) => e.name), ['App', 'Two'], 'and a later put() keeps the entries the file had')
}

// ---- 5. loader ------------------------------------------------------------------------------------
function writeDef(repo, files, o = {}) {
  for (const f of files) {
    const p = path.join(repo, '.snagentsos', 'team', ...f.rel.split('/'))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    let text = f.text
    if (o.crlf) text = text.replace(/\n/g, '\r\n')
    fs.writeFileSync(p, (o.bom ? '\uFEFF' : '') + text)
  }
}

async function loaderChecks(tmp) {
  const L = new M.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) })
  const repo = path.join(tmp, 'ldr')
  fs.mkdirSync(repo, { recursive: true })
  check(json(await L.load(repo)).error === 'missing', 'no folder -> missing')
  const files = json(M.renderTeamFiles({ ...json(M.defaultDraft('en')), goal: 'Ship it' }))
  writeDef(repo, files)
  const a = await L.load(repo)
  check(!a.error && a.result.ok && a.files.length === files.length, 'the default template loads clean')
  check(a.sha256 === sha(M.canonicalDefText(files)), 'the hash is sha256(canonicalDefText)')
  check((await L.load(repo)) === a && !(await L.changed(repo)), 'cached by stamp: the same load, changed() false')
  const crlf = path.join(tmp, 'ldr-crlf')
  writeDef(crlf, files, { crlf: true, bom: true })
  check((await L.load(crlf)).sha256 === a.sha256, 'CRLF and a BOM hash the same')
  fs.writeFileSync(path.join(repo, '.snagentsos', 'team', 'roles', 'README.txt'), 'notes')
  check(await L.changed(repo), 'a new file off DEF_REL_RE moves the stamp')
  const b = await L.load(repo)
  check(!b.error && b.files.length === files.length && b.sha256 === a.sha256, 'a file off DEF_REL_RE is not part of the definition nor of its hash')
  check(b.result.ok && b.result.warnings.some((w) => w.code === 'bad_name' && w.file === 'roles/README.txt' && w.severity === 'warning'), 'but the parser names it (bad_name warning)')
  fs.writeFileSync(path.join(repo, '.snagentsos', 'team', 'roles', 'README.txt'), 'longer notes, written again')
  check(!(await L.changed(repo)), 'its text is never read: an edit of it does not move the stamp')
  // A misnamed role file: a bad_name warning with its name (decision a), never read nor hashed.
  const reads = []
  const lstats = []
  const spyFs = {
    lstat: (p) => { lstats.push(path.basename(p)); return fs.promises.lstat(p) },
    readdir: (p) => fs.promises.readdir(p),
    readFile: (p, enc) => { reads.push(path.basename(p)); return fs.promises.readFile(p, enc) },
    realpath: (p) => fs.promises.realpath(p),
    mkdir: (p) => fs.promises.mkdir(p),
  }
  const LS = new M.TeamDefinitionLoader({ fs: spyFs, watch: () => ({ on() { return this }, close() {} }) })
  const writer = path.join(repo, '.snagentsos', 'team', 'roles', 'Writer.md')
  fs.writeFileSync(writer, '---\nname: Writer\nkind: dev\nprovider: claude\npermission: total\n---\nWrite.\n')
  const mis = await LS.load(repo)
  check(!mis.error && mis.result.ok && mis.result.warnings.some((e) => e.code === 'bad_name' && e.file === 'roles/Writer.md' && e.severity === 'warning'), 'roles/Writer.md: a bad_name warning that names the file')
  check(mis.sha256 === a.sha256 && !mis.files.some((f) => f.rel === 'roles/Writer.md') && !reads.includes('Writer.md') && !reads.includes('README.txt'), 'a misnamed file is never read nor hashed')
  fs.rmSync(writer)
  check(await LS.changed(repo) && (await LS.load(repo)).result.ok, 'renamed away: the stamp moves')
  // Dotfiles (a macOS resource fork, an editor temp file, even a link) are skipped before any lstat.
  const roleDir = path.join(repo, '.snagentsos', 'team', 'roles')
  const settled = await LS.load(repo)
  fs.writeFileSync(path.join(roleDir, '._dev.md'), Buffer.from([0, 5, 22, 7]))
  fs.writeFileSync(path.join(repo, '.snagentsos', 'team', 'routines', '.daily-summary.md.swp'), 'x')
  fs.symlinkSync(path.join(tmp), path.join(roleDir, '.cache'), 'junction')
  lstats.length = 0
  reads.length = 0
  check(!(await LS.changed(repo)) && (await LS.load(repo)) === settled, 'a dotfile never moves the stamp: the same load')
  check(!lstats.some((n) => n.startsWith('.') && n !== '.snagentsos') && !reads.some((n) => n.startsWith('.')), 'a dotfile is never lstat-ed nor read (a dot-named link is not followed)')
  check(settled.result.ok && same0(settled.result.warnings.map((w) => w.file), ['roles/README.txt']), 'and never shown as a warning (only the README is)')
  fs.rmSync(path.join(roleDir, '._dev.md'))
  fs.rmSync(path.join(repo, '.snagentsos', 'team', 'routines', '.daily-summary.md.swp'))
  fs.rmSync(path.join(roleDir, '.cache'))
  // isRealDir: what the reveal op opens.
  check(await L.isRealDir(roleDir) && !(await L.isRealDir(path.join(roleDir, 'dev.md'))) && !(await L.isRealDir(path.join(roleDir, 'nope'))), 'isRealDir: a folder yes; a file or a missing path no')
  fs.rmSync(path.join(repo, '.snagentsos', 'team', 'roles', 'README.txt'))
  fs.appendFileSync(path.join(repo, '.snagentsos', 'team', 'roles', 'dev.md'), '\nMore.\n')
  check(await L.changed(repo), 'an edit moves the stamp')
  const c = await L.load(repo)
  check(c.sha256 !== a.sha256, 'and re-hashes')
  // links and junctions.
  const jrepo = path.join(tmp, 'ldr-junction')
  writeDef(jrepo, files.filter((f) => f.rel === 'team.md'))
  fs.symlinkSync(path.join(repo, '.snagentsos', 'team', 'roles'), path.join(jrepo, '.snagentsos', 'team', 'roles'), 'junction')
  check(json(await L.load(jrepo)).error === 'link', 'a junction (or symlink) roles folder is refused')
  check(!(await L.isRealDir(path.join(jrepo, '.snagentsos', 'team', 'roles'))) && await L.isRealDir(path.join(jrepo, '.snagentsos', 'team')), 'isRealDir: a junction no')
  const trepo = path.join(tmp, 'ldr-teamlink')
  fs.mkdirSync(path.join(trepo, '.snagentsos'), { recursive: true })
  fs.symlinkSync(path.join(repo, '.snagentsos', 'team'), path.join(trepo, '.snagentsos', 'team'), 'junction')
  check(json(await L.load(trepo)).error === 'link', 'a linked team folder is refused')
  const frepo = path.join(tmp, 'ldr-filelink')
  writeDef(frepo, files.filter((f) => f.rel !== 'team.md'))
  let fileLink = true
  try { fs.symlinkSync(path.join(repo, '.snagentsos', 'team', 'team.md'), path.join(frepo, '.snagentsos', 'team', 'team.md'), 'file') } catch { fileLink = false }
  if (fileLink) check(json(await L.load(frepo)).error === 'link', 'a symlinked team.md is refused')
  const mrepo = path.join(tmp, 'ldr-misnamed-link')
  writeDef(mrepo, files)
  fs.symlinkSync(path.join(repo, '.snagentsos', 'team', 'roles'), path.join(mrepo, '.snagentsos', 'team', 'roles', 'Archive'), 'junction')
  check(json(await L.load(mrepo)).error === 'link', 'a link under a name off DEF_REL_RE is still refused')
  // caps.
  const many = path.join(tmp, 'ldr-many')
  writeDef(many, [files[0], ...Array.from({ length: 64 }, (_, i) => ({ rel: `roles/r${i}.md`, text: '---\nname: x\n---\n' }))])
  check(json(await L.load(many)).error === 'too_many', 'more than 64 files -> too_many')
  const manyOdd = path.join(tmp, 'ldr-many-odd')
  writeDef(manyOdd, [files[0], ...Array.from({ length: 63 }, (_, i) => ({ rel: `roles/r${i}.md`, text: '---\nname: x\n---\n' })), { rel: 'routines/notes.txt', text: 'x' }])
  check(json(await L.load(manyOdd)).error === 'too_many', 'a misnamed file counts for the 64')
  const big = path.join(tmp, 'ldr-big')
  writeDef(big, [{ rel: 'team.md', text: '---\nname: x\n---\n' + 'x'.repeat(64 * 1024) }])
  check(json(await L.load(big)).error === 'too_large', 'a file over 64 KB -> too_large')
  const total = path.join(tmp, 'ldr-total')
  writeDef(total, [files[0], ...Array.from({ length: 9 }, (_, i) => ({ rel: `roles/r${i}.md`, text: 'x'.repeat(60 * 1024) }))])
  check(json(await L.load(total)).error === 'too_large', 'more than 512 KB in all -> too_large')
  // write.
  const w = path.join(tmp, 'ldr-write')
  fs.mkdirSync(w, { recursive: true })
  same(await L.write(w, [{ rel: 'team.md', text: '---\r\nname: W\r\n---\r\n' }], { overwrite: false }), { ok: true }, 'write creates the folders and the file')
  const written = fs.readFileSync(path.join(w, '.snagentsos', 'team', 'team.md'))
  check(written.toString('utf8') === '---\nname: W\n---\n' && written[0] !== 0xef, 'written as LF, UTF-8 without BOM')
  same(await L.write(w, [{ rel: 'team.md', text: 'x' }], { overwrite: false }), { ok: false, error: 'exists' }, 'overwrite false refuses an existing file')
  same(await L.write(w, [{ rel: '../evil.md', text: 'x' }], { overwrite: true }), { ok: false, error: 'io' }, 'a rel off DEF_REL_RE is refused')
  const wl = path.join(tmp, 'ldr-write-link')
  fs.mkdirSync(path.join(wl, '.snagentsos'), { recursive: true })
  fs.symlinkSync(path.join(w, '.snagentsos', 'team'), path.join(wl, '.snagentsos', 'team'), 'junction')
  same(await L.write(wl, [{ rel: 'roles/x.md', text: 'x' }], { overwrite: true }), { ok: false, error: 'link' }, 'write never follows a linked folder')
  check(!fs.existsSync(path.join(w, '.snagentsos', 'team', 'roles', 'x.md')), 'nothing was written through the link')
}

// ---- 6. TeamTrust ----------------------------------------------------------------------------------
async function trustChecks(tmp) {
  const L = new M.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) })
  const repo = path.join(tmp, 'trust-repo')
  const files = json(M.renderTeamFiles({ ...json(M.defaultDraft('es')), goal: 'Meta' }))
  writeDef(repo, files)
  const loaded = await L.load(repo)
  const data = path.join(tmp, 'trust-data')
  const snap = (id) => path.join(data, 'teams', id, 'trusted-def.json')
  const store = new M.TrustStore({ file: () => path.join(data, 'trusted-teams.json') })
  const roots = { 'tm-0123456789ab': repo }
  const T = new M.TeamTrust(store, snap, (id) => roots[id] ?? null, () => 42)
  check(T.state(repo, loaded, 'tm-0123456789ab') === 'untrusted' && T.snapshotState('tm-0123456789ab') === 'none', 'never trusted -> untrusted, no snapshot')
  check(T.state(repo, { error: 'missing' }) === 'missing' && T.state(repo, { error: 'link' }) === 'invalid', 'missing and a load error')
  const ok = T.approve('tm-0123456789ab', repo, loaded, M.goalHashOf('Meta'))
  check(!ok.error && ok.sha256 === loaded.sha256 && ok.trustedAt === 42 && ok.def.name === loaded.result.def.name, 'approve returns the trusted definition')
  check(T.state(repo, loaded, 'tm-0123456789ab') === 'trusted' && T.trusted('tm-0123456789ab')?.sha256 === loaded.sha256, 'trusted after approve')
  const onDisk = JSON.parse(fs.readFileSync(snap('tm-0123456789ab'), 'utf8'))
  check(onDisk.v === 1 && onDisk.sha256 === loaded.sha256 && onDisk.files.length === files.length, 'trusted-def.json {v:1, sha256, trustedAt, goalHash, files}')
  check(new M.TrustStore({ file: () => path.join(data, 'trusted-teams.json') }).get(repo)?.sha256 === loaded.sha256, 'the TrustStore entry landed')
  // a fresh instance re-verifies the snapshot from disk.
  const T2 = new M.TeamTrust(new M.TrustStore({ file: () => path.join(data, 'trusted-teams.json') }), snap, (id) => roots[id] ?? null)
  check(T2.trusted('tm-0123456789ab')?.def.roles.length === 4, 'a fresh instance reads the verified snapshot')
  // edited snapshot -> bad -> changed.
  const edited = { ...onDisk, files: onDisk.files.map((f) => (f.rel === 'roles/dev.md' ? { ...f, text: f.text + '\nrm -rf\n' } : f)) }
  fs.writeFileSync(snap('tm-0123456789ab'), JSON.stringify(edited))
  const T3 = new M.TeamTrust(new M.TrustStore({ file: () => path.join(data, 'trusted-teams.json') }), snap, (id) => roots[id] ?? null)
  check(T3.snapshotState('tm-0123456789ab') === 'bad' && T3.trusted('tm-0123456789ab') === null && T3.state(repo, loaded, 'tm-0123456789ab') === 'changed', 'an edited trusted-def.json fails its check: changed')
  // a TrustStore entry that does not match the snapshot.
  fs.writeFileSync(snap('tm-0123456789ab'), JSON.stringify(onDisk))
  const ts = JSON.parse(fs.readFileSync(path.join(data, 'trusted-teams.json'), 'utf8'))
  for (const k of Object.keys(ts.entries)) ts.entries[k].sha256 = 'f'.repeat(64)
  fs.writeFileSync(path.join(data, 'trusted-teams.json'), JSON.stringify(ts))
  const T4 = new M.TeamTrust(new M.TrustStore({ file: () => path.join(data, 'trusted-teams.json') }), snap, (id) => roots[id] ?? null)
  check(T4.snapshotState('tm-0123456789ab') === 'bad' && T4.state(repo, loaded, 'tm-0123456789ab') === 'changed', 'a TrustStore entry that does not match the snapshot: changed')
  // approve answers io when setChecked fails, and puts the previous snapshot back.
  const prev = fs.readFileSync(snap('tm-0123456789ab'), 'utf8')
  const failing = { get: () => null, setChecked: () => false, delete() {} }
  const T5 = new M.TeamTrust(failing, snap, (id) => roots[id] ?? null)
  same(T5.approve('tm-0123456789ab', repo, loaded, 'g'), { error: 'io' }, 'approve answers io when setChecked fails')
  check(fs.readFileSync(snap('tm-0123456789ab'), 'utf8') === prev, 'the previous snapshot is put back')
  roots['tm-ffffffffffff'] = repo
  same(T5.approve('tm-ffffffffffff', repo, loaded, 'g'), { error: 'io' }, 'io for a first trust too')
  check(!fs.existsSync(snap('tm-ffffffffffff')), 'and no snapshot is left behind')
  // TrustStore.setChecked and delete.
  const s2 = new M.TrustStore({ file: () => path.join(data, 'ts2', 'trusted.json') })
  check(s2.setChecked(repo, 'a'.repeat(64)) && !s2.setChecked(repo, 'nope'), 'setChecked: true when written, false for a bad hash')
  s2.delete(repo)
  check(s2.get(repo) === null && new M.TrustStore({ file: () => path.join(data, 'ts2', 'trusted.json') }).get(repo) === null, 'TrustStore.delete forgets the repo on disk')
  fs.writeFileSync(path.join(data, 'blocker'), 'file')
  const s3 = new M.TrustStore({ file: () => path.join(data, 'blocker', 'x', 'trusted.json') })
  const warn = console.warn
  console.warn = () => {}
  try {
    check(s3.setChecked(repo, 'a'.repeat(64)) === false && s3.get(repo) === null, 'a write that cannot land: false, and memory keeps nothing')
  } finally {
    console.warn = warn
  }
}

// ---- 7. TeamService on real repositories -----------------------------------------------------------
let gitOk = true
try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }

async function serviceChecks(tmp) {
  const cleanEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig') }
  fs.writeFileSync(cleanEnv.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
  for (const k of Object.keys(cleanEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete cleanEnv[k]
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const runner = M.createGitRunner({ env: () => M.gitEnv(cleanEnv) })
  const makeRepo = (dir) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), '# r\n')
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'init')
    return dir
  }
  const app = makeRepo(path.join(tmp, 'app'))
  const outside = (dir) => { try { git(dir, 'rev-parse', '--show-toplevel'); return false } catch { return true } }

  // resolveMainRoot: a linked worktree resolves to its main checkout.
  git(app, 'worktree', 'add', '-q', path.join(tmp, 'app-wt'), '-b', 'side')
  check((await M.resolveMainRoot(runner, path.join(tmp, 'app-wt'))) === app, 'resolveMainRoot: a linked worktree -> its main root')
  fs.mkdirSync(path.join(app, 'src', 'deep'), { recursive: true })
  check((await M.resolveMainRoot(runner, path.join(app, 'src', 'deep'))) === app, 'resolveMainRoot: a subfolder -> the main root')
  const plain = path.join(tmp, 'plain')
  fs.mkdirSync(plain)
  if (outside(plain)) check((await M.resolveMainRoot(runner, plain)) === null, 'resolveMainRoot: not git -> null')
  const bare = path.join(tmp, 'bare.git')
  git(tmp, 'init', '-q', '--bare', bare)
  check((await M.resolveMainRoot(runner, bare)) === null, 'resolveMainRoot: bare -> null')

  const data = path.join(tmp, 'data')
  const clock = manualClock()
  const watchers = []
  const fakeWatch = (p, opts, cb) => {
    const w = { p, cb, closed: false, on() { return w }, close() { w.closed = true } }
    watchers.push(w)
    return w
  }
  const fireWatch = () => { for (const w of watchers) if (!w.closed) w.cb('change', 'x') }
  let cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '' } }
  const emitted = []
  const opened = []
  const logs = []
  // Electron's shell.openPath resolves '' when it opened, else an error string.
  let openResult = ''
  let renameFails = false
  const registryFs = { mkdirSync: fs.mkdirSync, renameSync: (a, b) => { if (renameFails) { const e = new Error('busy'); e.code = 'EPERM'; throw e } return fs.renameSync(a, b) } }
  const mk = (extra = {}) => new M.TeamService({
    dataDir: () => data,
    config: () => cfg,
    git: runner,
    emit: (e) => emitted.push(json(e)),
    openPath: async (p) => { opened.push(p); return openResult },
    registryFs,
    log: (l) => logs.push(l),
    now: () => clock.now,
    timerDeps: clock.deps,
    loader: new M.TeamDefinitionLoader({ watch: fakeWatch }),
    strict: true,
    ...extra,
  })

  // Labs off: disabled, no timer at all.
  const off = mk()
  await off.start({ settings: { labs: { teams: false } } })
  same(await off.request({ op: 'list' }, 'desktop'), { ok: false, error: 'disabled' }, 'Labs off: teams:req answers disabled')
  check(off.pendingTimers === 0 && clock.timers.size === 0, 'Labs off: zero DeadlineTimer keys and no platform timer')
  off.dispose()

  // index.json unreadable (a folder here: EISDIR, like EBUSY or EACCES): no empty registry for the session.
  const data2 = path.join(tmp, 'data-locked')
  const index2 = path.join(data2, 'teams', 'index.json')
  fs.mkdirSync(index2, { recursive: true })
  const broken = mk({ dataDir: () => data2 })
  await broken.start(cfg)
  same(await broken.request({ op: 'list' }, 'desktop'), { ok: false, error: 'io' }, 'an unreadable index.json: the request answers io, not disabled nor an empty list')
  same(await broken.request({ op: 'list' }, 'desktop'), { ok: false, error: 'io' }, 'and every request tries the read again')
  check(broken.pendingTimers === 0 && logs.some((l) => /^registry read failed E[A-Z]+$/.test(l)), 'nothing armed; the log has the error code')
  fs.rmSync(index2, { recursive: true })
  fs.writeFileSync(index2, JSON.stringify({ v: 1, teams: [{ id: M.teamIdOf(app), repoRoot: app, name: 'Locked', baseBranch: 'main', createdAt: 1 }] }))
  const e2 = emitted.length
  const relisted = await broken.request({ op: 'list' }, 'desktop')
  check(relisted.ok && relisted.teams.length === 1 && relisted.teams[0].name === 'Locked', 'once readable, the next request enables and lists the registered team')
  await settle()
  check(emitted.slice(e2).some((e) => e.teamId === '' && e.rev === 0 && same0(e.scopes, ['list'])), 'the enable that finally ran ends with a list change')
  broken.dispose()
  same(await broken.request({ op: 'list' }, 'desktop'), { ok: false, error: 'disabled' }, 'a disposed service never enables again: disabled')
  check(broken.team(M.teamIdOf(app)) === null && broken.pendingTimers === 0, 'and holds no team')

  const svc = mk()
  const e0 = emitted.length
  await svc.start(cfg)
  await settle()
  check(emitted.slice(e0).some((e) => e.teamId === '' && e.rev === 0 && same0(e.scopes, ['list'])), 'enable() ends with a list change (a renderer that got disabled pulls the list)')
  same(await svc.request({ op: 'list' }, 'desktop'), { ok: true, teams: [] }, 'Labs on, no teams: an empty list')
  same(await svc.request({ op: 'setupProbe', dir: 'C:\\x' }, 'phone'), { ok: false, error: 'bad_request' }, 'a phone asking a desktop op: bad_request')
  check((await svc.request({ op: 'list' }, 'phone')).ok, 'list is a phone op')
  same(await svc.request({ op: 'get', teamId: 'tm-0123456789ab' }, 'desktop'), { ok: false, error: 'not_found' }, 'an unknown team: not_found')

  // setupProbe.
  if (outside(plain)) same(await svc.request({ op: 'setupProbe', dir: plain }, 'desktop'), { ok: false, error: 'not_git' }, 'probe of a folder outside git: not_git')
  const probe = await svc.request({ op: 'setupProbe', dir: path.join(app, 'src') }, 'desktop')
  check(probe.ok && probe.probe.repoRoot === app && probe.probe.repoName === 'app' && probe.probe.branch === 'main' && probe.probe.branches.includes('main') && probe.probe.branches.includes('side'), 'probe resolves the main root, branch and branches')
  check(probe.probe.defaults.lang === 'es' && probe.probe.defaults.baseBranch === 'main' && !probe.probe.registered && !probe.probe.existing, 'probe defaults: es template on the current branch; nothing registered or existing')

  // setupPreview.
  const draft = { ...probe.probe.defaults, goal: 'Una app de notas', verify: '' }
  const prev = await svc.request({ op: 'setupPreview', repoRoot: app, draft }, 'desktop')
  const rendered = json(M.renderTeamFiles(draft))
  check(prev.ok && prev.preview.hash === sha(M.canonicalDefText(rendered)) && prev.preview.issues.length === 0, 'preview: the hash of the files main renders, no issues')
  same(prev.preview.files.map((f) => f.rel), rendered.map((f) => f.rel), 'preview lists every file')
  check(prev.preview.files.every((f) => f.bytes === Buffer.byteLength(f.text)), 'preview bytes are UTF-8 bytes')
  same(prev.preview.warnings, ['totalBypass', 'noVerify', 'notCommitted'], 'preview warnings: Total, no verify, not committed')
  const codexDraft = { ...draft, verify: 'npm test', roles: draft.roles.map((r) => (r.id === 'dev' ? { ...r, provider: 'codex', model: 'gpt-5', effort: 'medium' } : r.id === 'qa' ? { ...r, provider: 'codex', model: undefined } : r)) }
  const cprev = await svc.request({ op: 'setupPreview', repoRoot: app, draft: codexDraft }, 'desktop')
  same(cprev.preview.warnings, ['codexTotal', 'codexReadonlyBlock', 'notCommitted'], 'preview warnings: Codex Total and Codex readonly')
  same(await svc.request({ op: 'setupPreview', repoRoot: path.join(app, 'src'), draft }, 'desktop'), { ok: false, error: 'bad_request', detail: 'not_main_root' }, 'preview of a subfolder: bad_request')

  // setupWrite.
  same(await svc.request({ op: 'setupWrite', repoRoot: app, draft, previewHash: 'a'.repeat(64) }, 'desktop'), { ok: false, error: 'changed' }, 'setupWrite with a mismatched preview hash: changed')
  check(!fs.existsSync(path.join(app, '.snagentsos')), 'and nothing was written')
  const w = await svc.request({ op: 'setupWrite', repoRoot: app, draft, previewHash: prev.preview.hash }, 'desktop')
  check(w.ok && w.teamId === M.teamIdOf(app), 'setupWrite registers the team')
  const teamId = w.teamId
  for (const f of rendered) {
    const buf = fs.readFileSync(path.join(app, '.snagentsos', 'team', ...f.rel.split('/')))
    check(buf.toString('utf8') === f.text && buf[0] !== 0xef && !buf.includes(13), `written ${f.rel}: the rendered text, LF, UTF-8 without BOM`)
  }
  const ts = JSON.parse(fs.readFileSync(path.join(data, 'trusted-teams.json'), 'utf8'))
  check(Object.values(ts.entries)[0].sha256 === prev.preview.hash, 'the written hash is trusted')
  check(fs.existsSync(path.join(data, 'teams', teamId, 'trusted-def.json')) && JSON.parse(fs.readFileSync(path.join(data, 'teams', 'index.json'), 'utf8')).teams[0].id === teamId, 'snapshot and registry written under dataDir()/teams')
  same(await svc.request({ op: 'setupWrite', repoRoot: app, draft, previewHash: prev.preview.hash }, 'desktop'), { ok: false, error: 'exists' }, 'a second setupWrite: exists')
  let list = await svc.request({ op: 'list' }, 'desktop')
  check(list.ok && list.teams.length === 1 && list.teams[0].trust === 'trusted' && list.teams[0].agents === 5 && list.teams[0].needsCount === 0 && list.teams[0].repoRoot === app, 'list: one trusted team with 5 agents and nothing that needs the user')
  const get = await svc.request({ op: 'get', teamId }, 'desktop')
  check(get.ok && get.team.goal === 'Una app de notas' && get.team.roles.length === 4 && get.team.baseBranch === 'main' && get.team.maxConcurrent === 2 && get.team.defIssues.length === 0, 'get: the definition summary')
  const order = svc.trusted(teamId).def.roles.flatMap((r) => (r.id === 'dev' ? ['dev', 'dev-2'] : [r.id]))
  same(svc.team(teamId).store.rt.agents.map((a) => a.id), order, 'the roster follows the trusted definition, in its role order')
  same([...order].sort(), ['dev', 'dev-2', 'lead', 'qa', 'research'], 'lead, dev x2, qa and research')
  check(emitted.some((e) => e.teamId === teamId && e.scopes.includes('list')), 'setup emits a list change')

  // The trust gate: runs pass the gate while trusted (the B2 op answers unsupported).
  same(await svc.request({ op: 'runNow', teamId, agentId: 'dev' }, 'desktop'), { ok: false, error: 'unsupported' }, 'trusted: runNow passes the gate (B2 stub)')
  same(await svc.request({ op: 'board', teamId }, 'desktop'), { ok: false, error: 'unsupported' }, 'later ops answer unsupported in B1')

  // Editing roles/dev.md asks to trust again and blocks runs (B1 acceptance).
  const devFile = path.join(app, '.snagentsos', 'team', 'roles', 'dev.md')
  fs.appendFileSync(devFile, '\nSiempre corr\u00E9 los tests.\n')
  fireWatch()
  check(clock.timers.size > 0, 'a watch event arms the defwatch deadline')
  clock.advance(299)
  await settle()
  check(svc.team(teamId).trust === 'trusted', 'debounced: not yet re-checked at 299 ms')
  clock.advance(1)
  await until(() => svc.team(teamId).trust === 'changed', 5000, 'defwatch flip')
  check(svc.team(teamId).trust === 'changed', 'the defwatch deadline flips the cached state to changed')
  same(await svc.request({ op: 'runNow', teamId, agentId: 'dev' }, 'desktop'), { ok: false, error: 'untrusted' }, 'changed: runNow deferred untrusted')
  same(await svc.request({ op: 'kickoff', teamId }, 'desktop'), { ok: false, error: 'untrusted' }, 'changed: kickoff untrusted')
  same(await svc.request({ op: 'dispatch', teamId, queueId: 'all', go: false }, 'desktop'), { ok: false, error: 'unsupported' }, 'dispatch go:false is not gated')
  list = await svc.request({ op: 'list' }, 'desktop')
  check(list.teams[0].trust === 'changed' && list.teams[0].needsCount === 1, 'the trust need row counts in the badge')
  check(emitted.some((e) => e.teamId === teamId && e.scopes.includes('team') && e.scopes.includes('needs')), 'the flip emits team and needs')
  const diff = await svc.request({ op: 'trustDiff', teamId }, 'desktop')
  check(diff.ok && diff.trust.approvedSha === prev.preview.hash && diff.trust.sha256 !== prev.preview.hash, 'trustDiff: the approved sha and the new one')
  same(diff.trust.diff.files.map((f) => [f.rel, f.status]), [['roles/dev.md', 'changed']], 'trustDiff: only roles/dev.md changed')
  check(diff.trust.diff.risks.some((r) => r.code === 'instructionsChanged' && r.roleId === 'dev'), 'trustDiff: instructionsChanged risk')
  same(await svc.request({ op: 'trust', teamId, sha256: prev.preview.hash }, 'desktop'), { ok: false, error: 'changed' }, 'trust of a sha the disk no longer has: changed')
  const tr = await svc.request({ op: 'trust', teamId, sha256: diff.trust.sha256 }, 'desktop')
  check(tr.ok && tr.team.trust === 'trusted' && svc.team(teamId).trust === 'trusted', 'trust approves the shown sha')
  check(svc.trusted(teamId).files.find((f) => f.rel === 'roles/dev.md').text.includes('Siempre corr'), 'runs read the newly trusted snapshot')
  same(await svc.request({ op: 'runNow', teamId, agentId: 'dev' }, 'desktop'), { ok: false, error: 'unsupported' }, 'trusted again: runNow passes the gate')

  // A misnamed file in roles/ never vanishes (decision a): a bad_name warning with its name in the view; the trust
  // state, the sha and the runs are untouched, yet the renderer is told (the problems changed).
  await settle()
  const m0 = emitted.length
  const misnamed = path.join(app, '.snagentsos', 'team', 'roles', 'Writer.md')
  fs.writeFileSync(misnamed, '---\nname: Writer\n---\n')
  fireWatch()
  clock.advance(300)
  await until(() => emitted.slice(m0).some((e) => e.teamId === teamId && e.scopes.includes('team')), 5000, 'misnamed emit')
  const gm = await svc.request({ op: 'get', teamId }, 'desktop')
  same(gm.team.defIssues, [{ file: 'roles/Writer.md', line: 0, code: 'bad_name', severity: 'warning' }], 'a misnamed role file: one bad_name warning with its name in the view')
  check(gm.team.trust === 'trusted' && svc.team(teamId).trust === 'trusted' && gm.team.needsCount === 0, 'a warning never changes the trust state nor counts as a need')
  same(await svc.request({ op: 'runNow', teamId, agentId: 'dev' }, 'desktop'), { ok: false, error: 'unsupported' }, 'a misnamed role file does not block runs')
  const dw = await svc.request({ op: 'trustDiff', teamId }, 'desktop')
  check(dw.ok && dw.trust.sha256 === dw.trust.approvedSha && same0(dw.trust.issues, [{ file: 'roles/Writer.md', line: 0, code: 'bad_name', severity: 'warning' }]), 'trustDiff lists the warning too (same sha: nothing to trust)')
  // One more misnamed file: another warning, another emit.
  await settle()
  const m1 = emitted.length
  const misnamed2 = path.join(app, '.snagentsos', 'team', 'routines', 'Daily.md')
  fs.writeFileSync(misnamed2, 'x')
  fireWatch()
  clock.advance(300)
  await until(() => emitted.slice(m1).some((e) => e.teamId === teamId && e.scopes.includes('team')), 5000, 'second misnamed emit')
  const gm2 = await svc.request({ op: 'get', teamId }, 'desktop')
  same(gm2.team.defIssues.map((i) => [i.file, i.severity]), [['roles/Writer.md', 'warning'], ['routines/Daily.md', 'warning']], 'a second warning shows in the view')
  // A dotfile is ignored entirely: no stamp move, no emit, no issue.
  await settle()
  const m2 = emitted.length
  fs.writeFileSync(path.join(app, '.snagentsos', 'team', 'roles', '._dev.md'), 'x')
  fireWatch()
  clock.advance(300)
  await settle()
  check(!emitted.slice(m2).some((e) => e.teamId === teamId) && (await svc.request({ op: 'get', teamId }, 'desktop')).team.defIssues.length === 2, 'a dotfile: no emit and no issue')
  fs.rmSync(path.join(app, '.snagentsos', 'team', 'roles', '._dev.md'))
  fs.rmSync(misnamed2)
  fs.rmSync(misnamed)
  fireWatch()
  clock.advance(300)
  await until(async () => (await svc.request({ op: 'get', teamId }, 'desktop')).team.defIssues.length === 0, 5000, 'misnamed gone')
  check(svc.team(teamId).trust === 'trusted' && svc.trusted(teamId).sha256 === diff.trust.sha256, 'renamed away: still trusted with the same approved sha')

  // settings and reveal.
  const s1 = await svc.request({ op: 'settings', teamId, patch: { autoDispatch: true } }, 'desktop')
  check(s1.ok && s1.team.autoDispatch === true && svc.team(teamId).store.rt.autoDispatch === true, 'settings: autonomy on')
  const s2 = await svc.request({ op: 'settings', teamId, patch: { paused: true } }, 'desktop')
  check(s2.team.paused.reason === 'user' && (await svc.request({ op: 'list' }, 'desktop')).teams[0].needsCount === 0, 'a user pause never counts as a need')
  // Emits are coalesced per team per tick, scopes merged, with the rev at send time.
  await settle()
  const n0 = emitted.length
  const r0 = svc.team(teamId).store.rt
  svc.commit(teamId, { ok: true, rt: { ...r0, autoDispatch: false }, effects: [], result: undefined }, ['team'])
  svc.commit(teamId, { ok: true, rt: { ...svc.team(teamId).store.rt, autoDispatch: true }, effects: [], result: undefined }, ['board'])
  await settle()
  const burst = emitted.slice(n0)
  check(burst.length === 1 && burst[0].scopes.includes('team') && burst[0].scopes.includes('board') && burst[0].scopes.includes('list') && burst[0].rev === r0.rev + 2, 'two commits in one tick: one teamChanged with both scopes and the latest rev')
  await svc.request({ op: 'reveal', teamId, what: 'definition' }, 'desktop')
  await svc.request({ op: 'reveal', teamId, what: 'data' }, 'desktop')
  same(opened, [path.join(app, '.snagentsos', 'team'), path.join(data, 'teams', teamId)], 'reveal opens only the two folders main computes')
  // Finding 3: Electron's error string is the op's io detail (the renderer toasts it).
  openResult = 'Failed to open path'
  same(await svc.request({ op: 'reveal', teamId, what: 'definition' }, 'desktop'), { ok: false, error: 'io', detail: 'Failed to open path' }, 'a folder the OS did not open: io with Electron\'s error text')
  openResult = ''
  // Findings 1 and 5: only a real directory is ever handed to the OS opener, at every level the repo controls.
  const opens = opened.length
  const sn = path.join(app, '.snagentsos')
  const teamDir = path.join(sn, 'team')
  fs.renameSync(teamDir, path.join(sn, 'team-real'))
  fs.symlinkSync(path.join(sn, 'team-real'), teamDir, 'junction')
  same(await svc.request({ op: 'reveal', teamId, what: 'definition' }, 'desktop'), { ok: false, error: 'not_found' }, 'a linked team folder: not_found')
  fs.rmSync(teamDir)
  fs.writeFileSync(teamDir, '#!/bin/sh\necho pwned\n')
  same(await svc.request({ op: 'reveal', teamId, what: 'definition' }, 'desktop'), { ok: false, error: 'not_found' }, 'a file where the team folder was: not_found')
  fs.rmSync(teamDir)
  same(await svc.request({ op: 'reveal', teamId, what: 'definition' }, 'desktop'), { ok: false, error: 'not_found' }, 'a missing team folder: not_found')
  fs.renameSync(path.join(sn, 'team-real'), teamDir)
  fs.renameSync(sn, path.join(app, '.snagentsos-real'))
  fs.symlinkSync(path.join(app, '.snagentsos-real'), sn, 'junction')
  same(await svc.request({ op: 'reveal', teamId, what: 'definition' }, 'desktop'), { ok: false, error: 'not_found' }, 'a linked .snagentsos (the team folder behind it is real): not_found')
  fs.rmSync(sn)
  fs.renameSync(path.join(app, '.snagentsos-real'), sn)
  const dataDirOf = path.join(data, 'teams', teamId)
  fs.renameSync(dataDirOf, dataDirOf + '-real')
  fs.symlinkSync(dataDirOf + '-real', dataDirOf, 'junction')
  same(await svc.request({ op: 'reveal', teamId, what: 'data' }, 'desktop'), { ok: false, error: 'not_found' }, 'a linked team data folder: not_found')
  fs.rmSync(dataDirOf)
  fs.renameSync(dataDirOf + '-real', dataDirOf)
  check(opened.length === opens, 'none of them reached the OS opener')
  check((await svc.request({ op: 'reveal', teamId, what: 'definition' }, 'desktop')).ok && opened.length === opens + 1, 'put back: it opens again')

  // Labs off then on: flushed, zero keys, disabled, reloaded from disk.
  const revBefore = svc.team(teamId).store.rt.rev
  cfg = { settings: { ...cfg.settings, labs: { teams: false } } }
  svc.setConfig(cfg)
  check(svc.pendingTimers === 0 && clock.timers.size === 0, 'Labs off: zero DeadlineTimer keys')
  same(await svc.request({ op: 'list' }, 'desktop'), { ok: false, error: 'disabled' }, 'Labs off: disabled')
  check(emitted.at(-1).scopes[0] === 'disabled', 'Labs off emits disabled')
  check(JSON.parse(fs.readFileSync(path.join(data, 'teams', teamId, 'state.json'), 'utf8')).rev === revBefore, 'Labs off flushed the state')
  check(watchers.every((x) => x.closed), 'Labs off stops the watchers')

  // Snapshot integrity while off: an edited trusted-def.json -> changed plus one stateReset card.
  const snapFile = path.join(data, 'teams', teamId, 'trusted-def.json')
  const goodSnap = fs.readFileSync(snapFile, 'utf8')
  const evil = JSON.parse(goodSnap)
  evil.files = evil.files.map((f) => (f.rel === 'roles/qa.md' ? { ...f, text: f.text.replace('readonly', 'total') } : f))
  fs.writeFileSync(snapFile, JSON.stringify(evil))
  cfg = { settings: { ...cfg.settings, labs: { teams: true } } }
  svc.setConfig(cfg)
  list = await svc.request({ op: 'list' }, 'desktop')
  const resets = () => svc.team(teamId).store.rt.cards.filter((c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === 'stateReset' && c.from.vars.what === 'trust')
  check(list.teams[0].trust === 'changed' && resets().length === 1 && svc.trusted(teamId) === null, 'an edited snapshot: changed and a stateReset card, no definition for runs')
  check(list.teams[0].needsCount === 2, 'trust row and the card both count')
  same(await svc.request({ op: 'runNow', teamId, agentId: 'dev' }, 'desktop'), { ok: false, error: 'untrusted' }, 'a failed snapshot blocks runs')
  check(svc.team(teamId).store.rt.autoDispatch === true, 'Labs on again reloads the runtime from disk')
  const d2 = await svc.request({ op: 'trustDiff', teamId }, 'desktop')
  check(d2.ok && d2.trust.approvedSha === undefined, 'trustDiff without a verified snapshot has no approved sha')
  const tr2 = await svc.request({ op: 'trust', teamId, sha256: d2.trust.sha256 }, 'desktop')
  check(tr2.ok && resets().length === 0 && svc.trusted(teamId)?.sha256 === d2.trust.sha256, 'trusting again dismisses the stateReset card')
  check(svc.pendingTimers > 0 && clock.timers.size === 1, 'after Labs on again a commit arms the same timer (flush key)')
  clock.advance(M.TEAM_FLUSH_MS)
  check(JSON.parse(fs.readFileSync(path.join(data, 'teams', teamId, 'state.json'), 'utf8')).rev === svc.team(teamId).store.rt.rev, 'and the debounced flush writes the state')
  svc.setConfig({ settings: { ...cfg.settings, labs: { teams: false } } })
  svc.setConfig(cfg)
  await svc.request({ op: 'list' }, 'desktop')
  check(svc.team(teamId).trust === 'trusted' && resets().length === 0, 'a verified snapshot reads trusted after a reload')

  // adopt: a repo that already has a definition (CRLF and BOM, unregistered).
  const lib = makeRepo(path.join(tmp, 'lib'))
  const other = makeRepo(path.join(tmp, 'other'))
  const base = json(M.renderTeamFiles({ ...json(M.defaultDraft('en')), name: 'Other', goal: 'Adopted' }))
  const withRepos = (lines) => base.map((f) => (f.rel === 'team.md' ? { ...f, text: f.text.replace('name: Other\n', `name: Other\n${lines.join('\n')}\n`) } : f))
  writeDef(other, withRepos(['repo.lib.path: ../lib', 'repo.gone.path: ../nope']), { crlf: true, bom: true })
  const op = await svc.request({ op: 'setupProbe', dir: other }, 'desktop')
  check(op.ok && op.probe.existing && op.probe.existing.files.length === base.length, 'probe of a repo with a definition: existing files')
  const goneIssue = op.probe.existing.issues.find((i) => i.key === 'repo.gone.path')
  check(goneIssue && goneIssue.code === 'repo' && goneIssue.detail === 'missing' && goneIssue.line === 4, 'probe issues: a missing extra repo with its team.md line')
  const ad1 = await svc.request({ op: 'adopt', repoRoot: other, sha256: op.probe.existing.sha256 }, 'desktop')
  check(!ad1.ok && ad1.error === 'invalid_definition' && ad1.issues.some((i) => i.detail === 'missing'), 'adopt with an unresolved extra repo: invalid_definition')
  check(!svc.registry.get(M.teamIdOf(other)), 'and nothing is registered')
  writeDef(other, withRepos(['repo.lib.path: ../lib', `repo.abs.path: ${path.join(tmp, 'lib2')}`, 'repo.abs.baseBranch: develop']))
  makeRepo(path.join(tmp, 'lib2'))
  same(await svc.request({ op: 'adopt', repoRoot: other, sha256: op.probe.existing.sha256 }, 'desktop'), { ok: false, error: 'changed' }, 'adopt of a sha the disk no longer has: changed')
  const op2 = await svc.request({ op: 'setupProbe', dir: other }, 'desktop')
  check(op2.probe.existing.issues.length === 0, 'probe: both extra repos resolve')
  const ad2 = await svc.request({ op: 'adopt', repoRoot: other, sha256: op2.probe.existing.sha256 }, 'desktop')
  check(ad2.ok && svc.team(ad2.teamId).trust === 'trusted', 'adopt trusts exactly the sha it read')
  const otherId = ad2.teamId
  same(svc.repoOf(otherId, 'lib'), { repoId: 'lib', repoRoot: lib, baseBranch: 'main' }, 'repoOf: a relative path resolved against the main root')
  same(svc.repoOf(otherId, 'abs'), { repoId: 'abs', repoRoot: path.join(tmp, 'lib2'), baseBranch: 'develop' }, 'repoOf: an absolute path accepted, its own base branch')
  same(svc.repoOf(otherId, 'main'), { repoId: 'main', repoRoot: other, baseBranch: 'main' }, 'repoOf main: the registry root and base branch')
  check(svc.repoOf(otherId, 'zzz').code === 'repo', 'repoOf of an unknown repo: DefError repo')
  const ov = await svc.request({ op: 'get', teamId: otherId }, 'desktop')
  same(ov.team.extraRepos, [{ id: 'lib', name: 'lib', baseBranch: 'main' }, { id: 'abs', name: 'lib2', baseBranch: 'develop' }], 'get: the extra repos by name')
  // A definition check whose repos are still resolving when a trust op replaces the load: the trust op's state stands.
  const orec = svc.team(otherId)
  const trustedLoad = orec.loaded
  orec.loaded = { ...trustedLoad, sha256: 'f'.repeat(64) }
  const stale = svc.recompute(orec)
  orec.loaded = trustedLoad
  await stale
  check(orec.trust === 'trusted' && svc.repoOf(otherId, 'lib').repoRoot === lib, 'a stale recompute never overwrites the state of a newer load')
  // An extra repo that went away: invalid after a reload, repoOf answers its DefError.
  fs.renameSync(lib, path.join(tmp, 'lib-moved'))
  svc.setConfig({ settings: { ...cfg.settings, labs: { teams: false } } })
  svc.setConfig(cfg)
  await svc.request({ op: 'list' }, 'desktop')
  check(svc.team(otherId).trust === 'invalid' && svc.repoOf(otherId, 'lib').detail === 'missing', 'a missing extra repo: trust invalid and repoOf DefError')
  same(await svc.request({ op: 'runNow', teamId: otherId, agentId: 'dev' }, 'desktop'), { ok: false, error: 'untrusted' }, 'invalid blocks runs')
  fs.renameSync(path.join(tmp, 'lib-moved'), lib)

  // Every refusal of the resolver.
  const main = other
  const ext = (id, p) => ({ id, path: p })
  const sub = makeRepo(path.join(main, 'nested'))
  const inData = makeRepo(path.join(data, 'repo-in-data'))
  git(lib, 'worktree', 'add', '-q', path.join(tmp, 'lib-wt'), '-b', 'wt')
  fs.symlinkSync(lib, path.join(tmp, 'lib-link'), 'junction')
  const cases = [
    [ext('link', '../lib-link'), 'link'],
    [ext('nested', 'nested'), 'inside'],
    [ext('data', inData), 'inside'],
    [ext('wt', '../lib-wt'), 'not_main_root'],
    [ext('dup1', '../lib'), null],
    [ext('dup2', lib), 'duplicate'],
    [ext('nope', '../does-not-exist'), 'missing'],
  ]
  if (outside(plain)) cases.push([ext('plain', plain), 'not_git'])
  const res = await svc.resolveRepos(main, { extraRepos: cases.map((c) => c[0]) }, [])
  for (const [x, want] of cases) {
    const got = res.repos.get(x.id)
    if (want === null) check(got && got.repoRoot === lib, `resolver: ${x.id} resolves`)
    else check(got && got.code === 'repo' && got.detail === want, `resolver: ${x.id} -> ${want}`)
  }
  check(res.issues.length === cases.filter((c) => c[1] !== null).length, 'every refusal is an issue')
  check(res.issues.every((i) => i.severity === 'error'), 'a repo that does not resolve is an error')
  void sub

  // Finding 4: a UNC or device path never reaches an lstat, a realpath or git (on Windows that lookup alone
  // authenticates to the host), whether the parser saw it or not.
  const touched = []
  const spyRepoFs = {
    lstat: (p) => { touched.push(['lstat', p]); return fs.promises.lstat(p) },
    realpath: (p) => { touched.push(['realpath', p]); return fs.promises.realpath(p) },
  }
  const spyGit = { run: (args, o) => { touched.push(['git', o.cwd]); return runner.run(args, o) }, info: (f) => runner.info(f), get running() { return runner.running } }
  const uncSvc = mk({ repoFs: spyRepoFs, git: spyGit, dataDir: () => path.join(tmp, 'data-unc') })
  await uncSvc.start(cfg)
  const UNC = ['\\\\203.0.113.5\\s\\lib', '//203.0.113.5/s/lib', '\\\\?\\UNC\\203.0.113.5\\s', '\\\\?\\C:\\work\\lib', '\\\\.\\pipe\\x', '/\\203.0.113.5\\s']
  const uncRes = await uncSvc.resolveRepos(main, { extraRepos: [...UNC.map((p, i) => ext(`u${i}`, p)), ext('ok', '../lib')] }, [])
  check(UNC.every((_, i) => { const e = uncRes.repos.get(`u${i}`); return e && e.code === 'repo' && e.detail === 'unc' && e.severity === 'error' }), 'resolver: every UNC or device path -> DefError repo unc')
  check(uncRes.repos.get('ok')?.repoRoot === lib && touched.length > 0, 'the plain extra repo next to them still resolves (the spies see it)')
  const isUnc = (p) => /^[\\/]{2}/.test(p)
  check(!touched.some(([, p]) => isUnc(p)), 'no lstat, realpath or git call ever got a UNC or device path: ' + JSON.stringify(touched.filter(([, p]) => isUnc(p))))
  if (process.platform === 'win32') {
    touched.length = 0
    const onShare = await uncSvc.resolveRepos('\\\\203.0.113.5\\s\\app', { extraRepos: [ext('rel', '../lib')] }, [])
    check(onShare.repos.get('rel')?.detail === 'unc' && touched.length === 0, 'win32: a relative path that resolves to a share is refused before any call')
  }
  // The same path in a repo's team.md: the probe answers the parser's error on its line and resolves nothing.
  const hostile = makeRepo(path.join(tmp, 'hostile'))
  writeDef(hostile, withRepos(['repo.lib.path: \\\\203.0.113.5\\s\\lib']))
  touched.length = 0
  const hp = await uncSvc.request({ op: 'setupProbe', dir: hostile }, 'desktop')
  check(hp.ok && hp.probe.existing.issues.some((i) => i.code === 'repo' && i.detail === 'unc' && i.key === 'repo.lib.path' && i.line === 3 && i.severity === 'error'), 'probe of a hostile team.md: repo unc on its line')
  check(!touched.some(([, p]) => isUnc(p)) && !touched.some(([k]) => k === 'lstat' || k === 'realpath'), 'and no extra repo was looked up')
  same(await uncSvc.request({ op: 'adopt', repoRoot: hostile, sha256: hp.probe.existing.sha256 }, 'desktop'), { ok: false, error: 'invalid_definition', issues: hp.probe.existing.issues }, 'adopt refuses it as invalid_definition')
  uncSvc.dispose()

  // approve io: the trust write does not land -> io, the team stays untrusted.
  const third = makeRepo(path.join(tmp, 'third'))
  const failing = mk({ trustStore: { get: () => null, setChecked: () => false, delete() {} } })
  await failing.start(cfg)
  const fprev = await failing.request({ op: 'setupPreview', repoRoot: third, draft }, 'desktop')
  same(await failing.request({ op: 'setupWrite', repoRoot: third, draft, previewHash: fprev.preview.hash }, 'desktop'), { ok: false, error: 'io' }, 'setupWrite answers io when the trust write fails')
  check(failing.team(M.teamIdOf(third))?.trust === 'untrusted', 'the team is registered but not trusted')
  failing.dispose()

  // Finding 2: a folder that does not move (EPERM, EBUSY) keeps the whole team: entry, trust, state and watcher.
  // A definition edit whose debounced check is still pending when the remove fails is seen afterwards.
  const pendingDev = path.join(app, '.snagentsos', 'team', 'roles', 'dev.md')
  const pendingText = fs.readFileSync(pendingDev, 'utf8')
  fs.writeFileSync(pendingDev, pendingText + '\nPending check.\n')
  fireWatch()
  renameFails = true
  const openWatchers = watchers.filter((x) => !x.closed).length
  same(await svc.request({ op: 'remove', teamId }, 'desktop'), { ok: false, error: 'io', detail: 'busy' }, 'remove with a folder that does not move: io (busy)')
  check(svc.team(teamId) && svc.registry.get(teamId) && fs.existsSync(path.join(data, 'teams', teamId, 'state.json')) && !fs.readdirSync(path.join(data, 'teams', '.trash')).some((n) => n.startsWith(teamId + '-')), 'the team, its entry and its folder stay where they were')
  check(Object.values(JSON.parse(fs.readFileSync(path.join(data, 'trusted-teams.json'), 'utf8')).entries).some((e) => e.sha256 === diff.trust.sha256) && svc.team(teamId).trust === 'trusted' && svc.trusted(teamId)?.sha256 === diff.trust.sha256, 'and so does its trust')
  check(watchers.filter((x) => !x.closed).length === openWatchers, 'its definition watcher stays armed')
  clock.advance(300)
  await until(() => svc.team(teamId).trust === 'changed', 5000, 'pending defwatch after a failed remove')
  check(svc.team(teamId).trust === 'changed', 'the definition check pending before the failed remove still runs')
  fs.writeFileSync(pendingDev, pendingText)
  fireWatch()
  clock.advance(300)
  await until(() => svc.team(teamId).trust === 'trusted', 5000, 'definition put back')
  check((await svc.request({ op: 'get', teamId }, 'desktop')).ok && logs.some((l) => l === `registry trash ${teamId} failed EPERM`), 'the team still answers; the log has the code')
  renameFails = false

  // remove: trash, forget, repo files untouched.
  const rm = await svc.request({ op: 'remove', teamId }, 'desktop')
  check(rm.ok && !svc.team(teamId) && !svc.registry.get(teamId), 'remove drops the team')
  check(!fs.existsSync(path.join(data, 'teams', teamId)) && fs.readdirSync(path.join(data, 'teams', '.trash')).some((n) => n.startsWith(teamId + '-')), 'the team folder goes to teams/.trash')
  check(fs.existsSync(path.join(app, '.snagentsos', 'team', 'team.md')), 'the repo definition is never touched')
  const tsAfter = JSON.parse(fs.readFileSync(path.join(data, 'trusted-teams.json'), 'utf8'))
  check(!Object.values(tsAfter.entries).some((e) => e.sha256 === diff.trust.sha256), 'the trust entry is forgotten')
  same(await svc.request({ op: 'get', teamId }, 'desktop'), { ok: false, error: 'not_found' }, 'a removed team: not_found')
  const reprobe = await svc.request({ op: 'setupProbe', dir: app }, 'desktop')
  check(reprobe.ok && !reprobe.probe.registered && reprobe.probe.existing, 'after remove the repo offers adopt')
  same(await svc.request({ op: 'setupWrite', repoRoot: app, draft, previewHash: prev.preview.hash }, 'desktop'), { ok: false, error: 'exists' }, 'setupWrite over an existing folder of an unregistered repo: exists')

  // shutdownSync: flushed, frozen, thaw on a request.
  svc.shutdownSync('quit')
  check(svc.pendingTimers === 0, 'shutdownSync clears every key')
  check((await svc.request({ op: 'list' }, 'desktop')).ok, 'a request while frozen and not quitting thaws')
  svc.shutdownSync('quit')
  svc.markQuitting()
  same(await svc.request({ op: 'list' }, 'desktop'), { ok: false, error: 'disabled' }, 'quitting: no thaw')
  svc.dispose()
  check(clock.timers.size === 0, 'dispose leaves no platform timer')
  check(!logs.some((l) => /Una app|Siempre/.test(l)), 'the log carries codes and ids, never definition text')
}

// ---- 8. IPC register -----------------------------------------------------------------------------
async function ipcChecks() {
  const handlers = new Map()
  const I = loadEntry(`export { registerTeamsIpc } from './src/main/teams/registerTeamsIpc'`, {
    require: (id) => (id === 'electron' ? { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } } : require(id)),
  })
  const seen = []
  I.registerTeamsIpc({ request: async (req, origin) => { seen.push([req.op, origin]); if (req.op === 'remove') throw new Error('x'); return { ok: true, teams: [] } } })
  const h = handlers.get('teams:req')
  check(typeof h === 'function', 'teams:req is registered')
  same(await h({}, { op: 'setupProbe', dir: 'relative' }), { ok: false, error: 'bad_request' }, 'a payload the union refuses: bad_request')
  same(await h({}, 'junk'), { ok: false, error: 'bad_request' }, 'junk: bad_request')
  same(await h({}, { op: 'list' }), { ok: true, teams: [] }, 'a valid payload reaches the service')
  same(await h({}, { op: 'remove', teamId: 'tm-0123456789ab' }), { ok: false, error: 'io' }, 'a throwing service: io')
  same(seen, [['list', 'desktop'], ['remove', 'desktop']], 'origin desktop, bad payloads never reach the service')
}

async function main() {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-store-')))
  try {
    schemaChecks()
    flowChecks()
    storeChecks(tmp)
    registryChecks(tmp)
    await loaderChecks(tmp)
    await trustChecks(tmp)
    if (gitOk) await serviceChecks(tmp)
    else console.log('git not found: TeamService checks skipped')
    await ipcChecks()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
  console.log(`PASS: ${checks} teams store checks (schemas, flow, store, registry, loader, trust, service, ipc)`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
