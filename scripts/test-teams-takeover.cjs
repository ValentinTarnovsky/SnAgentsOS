// Teams takeover (app 2.7.0, E10 B9, design 4.4 and 8 B9): "Tomar el control" and "Devolver al Equipo".
// Part 1, the pure reducers of src/main/teams/flow/takeover.ts on deep-frozen runtimes (every result checked against
// the invariants I1..I22): K1 a live run stops (refused while stopping, a double click busy), K1 on a queued run (no
// earlier session -> no_session and nothing granted, an earlier session -> held at once), a Claude run still starting
// and a Codex run before thread.started without an earlier session -> no_session, K2 its end hands the session over
// (or drops a takeover without one), K3 an idle agent's most recent task session (else its lead session), K4 the bind
// CAS (the team's workspace recorded), K5 abort, K6 release (busy while the console works, a failed kill bound again),
// K7 reconcile (a bound console gone, a waiting one found by its lastSession or a live holder), the load fix
// (releasing -> bound, a stopping one whose run is gone -> bindPending), the give-back continuation, the takeover
// run-end policy (no card about a run the user now drives) and the grant's workspace pick.
// Part 2, TeamService with the fake agent (scripts/fixtures/teams/fake-agent.cjs) and fake consoles (config, ptys,
// statuses, session holders): K1 + K2 on a real running task run (the grant carries only the session, the cwd, the
// workspace and the names), the second click busy, Frenar then takeover -> stopping, a Claude run still starting ->
// no_session, takeover in the linger window, a console opening the session while the run stops, the dispatcher never
// starting a taken-over agent, takeoverBound validated in main (not in the config, another workspace, another holder ->
// bad_request and still bindPending; the config save that lands later binds it), the sidebar and roster views, release
// busy while working, release killing only a console that holds the session (one that no longer holds it and one gone
// from the config kill nothing), a console closed by hand (sink exit, config reconcile), a renderer reload in
// bindPending, the bind: deadline (timed out, or bound by a holder at the deadline), a restart in bindPending re-arming
// bind: and timing out, a releasing takeover bound again at load, zero DeadlineTimer keys with Labs off and bind: armed
// again at Labs on, the console status binding a waiting takeover, and ownsSession leaving a held session to its console.
// B9 integration: a takeover of the Lead hands every pending lead-decided approval to the user (counts in Te necesita,
// notifies once, also a small plan written while it is held, and on a live Lead run in its end's own commit with the
// needs and lead scopes; Devolver never takes them back), each release busy names
// its case (detail turn, kill, releasing), and the reconcile binds the console whose live status names the session
// first, never one whose live status names another session nor one a notHeld release left in place.
// B9 review: K6 finds the bound console in any workspace (one moved to the user's workspace whose home was deleted is
// still killed as holding the session) and the config reconcile makes the bound workspace follow it; the takeover op's
// decision 64 check that dismisses a dead orphan's card is never undone by the takeover's commit; and the load step's
// effects run (a held Lead's escalation note in a full Lead thread archives the oldest comment, never cuts it).
// Same esbuild + vm harness as test-teams-runner.cjs: no Electron, no user data, never a real agent.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label, detail) {
  assert.ok(condition, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  checks++
}
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), label); checks++ }
const json = (v) => JSON.parse(JSON.stringify(v ?? null))
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
const FIX = path.join(__dirname, 'fixtures', 'teams')
const FAKE = path.join(FIX, 'fake-agent.cjs')

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-takeover-')))
const electronStub = { app: { getPath: (name) => (name === 'userData' ? path.join(TMP, 'ud') : TMP), isPackaged: false, commandLine: { hasSwitch: () => false } } }
function loadEntry(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (id) => (id === 'electron' ? electronStub : require(id)), console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, TextEncoder, TextDecoder })
  return mod.exports
}

const M = loadEntry(`
export * from './src/main/teams/flow/takeover'
export { assertInvariants } from './src/main/teams/flow/invariants'
export { interruptAll, orphanCards, requestStop } from './src/main/teams/flow/runs'
export { grantOf, grantWorkspaceOf, paneHoldsSession } from './src/main/teams/ops/takeover'
export { TeamService } from './src/main/teams/TeamService'
export { TeamDefinitionLoader } from './src/main/teams/TeamDefinitionLoader'
export { createGitRunner, gitEnv } from './src/main/git/gitExec'
export { afterRunPolicy, planDispatch } from './src/shared/teamDispatch'
export { teamNeedsRows } from './src/shared/teamNeeds'
export { pidAlive, signalTree, treeKillSync } from './src/main/proc/treeKill'
export * from './src/shared/teams'
`)

const until = async (fn, ms = 15000, label = 'condition') => {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms))
/** The same folder, compared the way the OS does (case-insensitive on Windows). */
const samePath = (a, b) => {
  const k = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return typeof a === 'string' && typeof b === 'string' && k(a) === k(b)
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

// ---- part 1: the reducers ---------------------------------------------------------------------------
const NOW = 1_800_000_000_000
const TEAM = 'tm-0123456789ab'
const REPO = path.join(TMP, 'repo-pure')
const WT = path.join(TMP, 'wt-pure')
const ctx = { now: NOW }

function sess(id, o = {}) {
  return { provider: 'claude', sessionId: id, cwd: REPO, createdAt: NOW - 100_000, turns: 1, sysHash: 'h', ...o }
}
function agent(id, roleKind, o = {}) {
  return { id, roleId: id.replace(/-\d$/, ''), roleKind, provider: 'claude', status: 'idle', paused: false, sessions: {}, interrupts: 0, ...o }
}
function task(id, o = {}) {
  return {
    id, rev: 1, title: id, body: '', state: 'doing', phase: 'executing', priority: 'normal', assignee: 'dev', repoId: 'main', isolation: 'main', needsPlan: false, frozen: true,
    blockedBy: [], createdBy: { kind: 'user', via: 'desktop' }, createdAt: NOW - 200_000, updatedAt: NOW - 200_000, stateSince: NOW - 200_000,
    review: { round: 0, max: 3 }, userOwned: [], counters: { noProgress: 0, continuations: 0, retries: 0, interrupts: 0, unblockWakes: 0, unblockWindowStart: 0 }, ...o,
  }
}
function run(id, o = {}) {
  return {
    id, agentId: 'dev', roleId: 'dev', roleKind: 'dev', taskId: 't-1', sessionKey: 't-1', provider: 'claude', profile: 'total', resumed: true, cwd: REPO, repoId: 'main',
    mode: 'exec', trigger: { reason: 'assigned', by: 'system' }, state: 'running', reachedRunning: true, resultSeen: false, queuedAt: NOW - 5000, startedAt: NOW - 4000, sessionId: 's-1', ...o,
  }
}
/** A runtime with a Lead, a Dev, a Dev 2 and a QA; `patch` edits it before it is frozen. */
function runtime(patch) {
  const rt = M.emptyRuntime(TEAM, 'abcdef01')
  rt.agents = [agent('lead', 'lead'), agent('dev', 'dev'), agent('dev-2', 'dev'), agent('qa', 'qa')]
  rt.tasks = [task('t-1'), task('t-2', { assignee: 'dev-2' })]
  rt.nextIds = { ...rt.nextIds, task: 3 }
  patch?.(rt)
  return deepFreeze(rt)
}
const R1 = 'r-0000000000a1'
const withRun = (state, o = {}) => (rt) => {
  rt.activeRuns = [run(R1, { state, ...o })]
  rt.agents = rt.agents.map((a) => (a.id === 'dev' ? { ...a, status: 'running', runId: R1 } : a))
}
const ag = (rt, id) => rt.agents.find((a) => a.id === id)
function inv(rt, label) {
  const issues = M.assertInvariants(rt, null)
  check(issues.length === 0, `${label}: invariants hold`, issues)
}

function reducerChecks() {
  // K1: a running run stops for the takeover; the agent keeps running with takeover.stopping (I4).
  const live = runtime((rt) => {
    withRun('running')(rt)
    rt.agents = rt.agents.map((a) => (a.id === 'dev' ? { ...a, sessions: { 't-1': sess('s-1', { turns: 2 }) } } : a))
  })
  const k1 = M.beginTakeover(live, 'dev', ctx)
  check(k1.ok && k1.result.immediate === false && k1.result.runId === R1, 'K1: a running run stops (not immediate)', k1)
  const d1 = ag(k1.rt, 'dev')
  check(d1.status === 'running' && d1.runId === R1 && d1.takeover.phase === 'stopping' && d1.takeover.runId === R1 && d1.takeover.sessionKey === 't-1', 'K1: running + takeover.stopping', d1)
  check(k1.rt.activeRuns[0].state === 'stopping' && k1.rt.activeRuns[0].stopReason === 'takeover' && k1.effects.some((e) => e.kind === 'stopRun' && e.runId === R1 && e.reason === 'takeover'), 'K1: R6 with reason takeover and the stopRun effect')
  inv(k1.rt, 'K1')
  check(!M.beginTakeover(k1.rt, 'dev', ctx).ok && M.beginTakeover(k1.rt, 'dev', ctx).error === 'busy', 'a second click while it stops: busy')

  // Refused while a run is stopping for another reason (Frenar).
  const stopping = runtime((rt) => withRun('stopping', { stopReason: 'user' })(rt))
  same(M.beginTakeover(stopping, 'dev', ctx), { ok: false, error: 'stopping' }, 'refused while the run is stopping')

  // A run that reached running holds its session even with none before (a Claude uuid that became a conversation).
  const fresh = runtime((rt) => {
    withRun('running', { resumed: false })(rt)
    rt.agents = rt.agents.map((a) => (a.id === 'dev' ? { ...a, sessions: { 't-1': sess('s-1', { turns: 1 }) } } : a))
  })
  check(M.beginTakeover(fresh, 'dev', ctx).ok, 'K1: a run that reached running is taken over')

  // No session on disk: a Claude run still starting with no earlier session, a Codex run before thread.started.
  const starting = runtime((rt) => withRun('starting', { reachedRunning: false, resumed: false, sessionId: 'minted-uuid' })(rt))
  same(M.beginTakeover(starting, 'dev', ctx), { ok: false, error: 'no_session' }, 'a Claude run still starting with no earlier session: no_session')
  const codex = runtime((rt) => {
    withRun('starting', { reachedRunning: false, resumed: false, provider: 'codex', sessionId: undefined })(rt)
    rt.agents = rt.agents.map((a) => (a.id === 'dev' ? { ...a, provider: 'codex' } : a))
  })
  same(M.beginTakeover(codex, 'dev', ctx), { ok: false, error: 'no_session' }, 'a Codex run before thread.started: no_session')
  // A Codex run whose first line was not thread.started reached running without a thread id: nothing to hand over, nothing stopped.
  const codexNoThread = runtime((rt) => {
    withRun('running', { reachedRunning: true, resumed: false, provider: 'codex', sessionId: undefined })(rt)
    rt.agents = rt.agents.map((a) => (a.id === 'dev' ? { ...a, provider: 'codex' } : a))
  })
  same(M.beginTakeover(codexNoThread, 'dev', ctx), { ok: false, error: 'no_session' }, 'a Codex run running without a thread id: no_session (the run is not stopped)')
  const startingResume = runtime((rt) => {
    withRun('starting', { reachedRunning: false })(rt)
    rt.agents = rt.agents.map((a) => (a.id === 'dev' ? { ...a, sessions: { 't-1': sess('s-1', { turns: 3 }) } } : a))
  })
  check(M.beginTakeover(startingResume, 'dev', ctx).ok, 'a starting run that resumes an earlier session is taken over')

  // K1 on a queued run: a plain cancel; granted only when its key already had a session.
  const queued = runtime((rt) => withRun('queued', { reachedRunning: false, startedAt: undefined })(rt))
  const q0 = M.beginTakeover(queued, 'dev', ctx)
  same(q0, { ok: false, error: 'no_session' }, 'a queued run with no earlier session: no_session')
  const queuedS = runtime((rt) => {
    withRun('queued', { reachedRunning: false, startedAt: undefined })(rt)
    rt.agents = rt.agents.map((a) => (a.id === 'dev' ? { ...a, sessions: { 't-1': sess('s-1', { turns: 2 }) } } : a))
  })
  const q1 = M.beginTakeover(queuedS, 'dev', ctx)
  check(q1.ok && q1.result.immediate && q1.rt.activeRuns.length === 0 && q1.effects.some((e) => e.kind === 'ended' && e.run.state === 'cancelled' && e.run.stopReason === 'takeover'), 'a queued run whose key had a session: cancelled at once', q1)
  const qa = ag(q1.rt, 'dev')
  check(qa.status === 'takenOver' && qa.takeover.phase === 'bindPending' && qa.takeover.sessionId === 's-1' && qa.takeover.cwd === REPO && !qa.runId, 'and the session is held (bindPending)', qa)
  inv(q1.rt, 'K1 queued')

  // K2: the stopped run ends (here through interruptAll, the real endRun): settleTakeovers hands its session over.
  const ended = M.interruptAll(k1.rt, 'shutdown', M.afterRunPolicy, ctx)
  const s1 = M.settleTakeovers(ended.rt, ctx)
  const held = ag(s1.rt, 'dev')
  check(s1.result.held.join() === 'dev' && held.status === 'takenOver' && held.takeover.phase === 'bindPending' && held.takeover.sessionId === 's-1' && held.takeover.provider === 'claude', 'K2: the run end hands the session over', held)
  inv(s1.rt, 'K2')
  check(M.settleTakeovers(s1.rt, ctx).rt === s1.rt && M.settleTakeovers(live, ctx).rt === live, 'settle changes nothing when nothing settles')
  // A run whose end dropped its session (a fresh session): the takeover goes.
  const noSess = deepFreeze({ ...ended.rt, agents: ended.rt.agents.map((a) => (a.id === 'dev' ? { ...a, sessions: {} } : a)) })
  const s2 = M.settleTakeovers(noSess, ctx)
  check(s2.result.dropped.join() === 'dev' && !ag(s2.rt, 'dev').takeover && ag(s2.rt, 'dev').status === 'idle', 'K2 without a session: the takeover goes (the op answers no_session)')
  inv(s2.rt, 'K2 dropped')

  // K3: an idle agent hands over its most recent task session, else its lead session.
  const idle = runtime((rt) => {
    rt.agents = rt.agents.map((a) => {
      if (a.id === 'dev') return { ...a, sessions: { 't-1': sess('s-old', { createdAt: NOW - 90_000, lastRunId: 'r-0000000000b1' }), 't-2x': sess('s-bad'), 't-3': sess('s-new', { createdAt: NOW - 50_000 }), 't-4': sess('s-zero', { turns: 0, createdAt: NOW }) } }
      if (a.id === 'lead') return { ...a, sessions: { lead: sess('s-lead') } }
      return a
    })
  })
  const k3 = M.beginTakeover(idle, 'dev', ctx)
  check(k3.ok && k3.result.immediate && ag(k3.rt, 'dev').takeover.sessionKey === 't-3' && ag(k3.rt, 'dev').takeover.sessionId === 's-new', 'K3: the most recent task session with a turn (by creation without a run end)', ag(k3.rt, 'dev').takeover)
  const used = M.beginTakeover(idle, 'dev', ctx, { lastUsed: (s) => (s.lastRunId === 'r-0000000000b1' ? NOW - 1000 : undefined) })
  check(used.ok && ag(used.rt, 'dev').takeover.sessionKey === 't-1', 'K3: a later run end makes an older session the most recent')
  // A session no console can resume (its cwd is gone: a removed task worktree) is left out; the next one is handed over.
  const noCwd = M.beginTakeover(idle, 'dev', ctx, { usable: (s) => s.sessionId !== 's-new' })
  check(noCwd.ok && ag(noCwd.rt, 'dev').takeover.sessionKey === 't-1', 'K3: a session whose cwd is gone is skipped for the next most recent', noCwd.ok && ag(noCwd.rt, 'dev').takeover)
  same(M.beginTakeover(idle, 'dev', ctx, { usable: () => false }), { ok: false, error: 'no_session' }, 'K3: no session a console can resume -> no_session')
  inv(k3.rt, 'K3')
  const kl = M.beginTakeover(idle, 'lead', ctx)
  check(kl.ok && ag(kl.rt, 'lead').takeover.sessionKey === 'lead' && ag(kl.rt, 'lead').takeover.sessionId === 's-lead', 'K3: the Lead hands over its lead session')
  same(M.beginTakeover(idle, 'qa', ctx), { ok: false, error: 'no_session' }, 'K3: no session -> no_session')
  same(M.beginTakeover(k3.rt, 'dev', ctx), { ok: false, error: 'busy' }, 'a double click on a held takeover: busy')
  same(M.beginTakeover(idle, 'nobody', ctx), { ok: false, error: 'not_found' }, 'an unknown agent: not_found')

  // K4: the bind CAS; the team's workspace recorded once.
  const b = M.bindTakeover(k3.rt, 'dev', 'pane-1', 'ws-1', { now: NOW + 10 })
  const bt = ag(b.rt, 'dev').takeover
  check(b.ok && bt.phase === 'bound' && bt.paneId === 'pane-1' && bt.workspaceId === 'ws-1' && bt.sessionId === 's-new' && b.rt.workspaceId === 'ws-1' && ag(b.rt, 'dev').status === 'takenOver', 'K4: bound, rt.workspaceId set', bt)
  inv(b.rt, 'K4')
  check(M.bindTakeover(b.rt, 'dev', 'pane-1', 'ws-1', ctx).rt === b.rt, 'K4: the same console again is a no-op')
  same(M.bindTakeover(b.rt, 'dev', 'pane-2', 'ws-1', ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'K4: another console once bound: conflict stale')
  same(M.bindTakeover(idle, 'dev', 'pane-1', 'ws-1', ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'K4: nothing waiting: conflict stale')
  const ws2 = M.bindTakeover(deepFreeze({ ...k3.rt, workspaceId: 'ws-team' }), 'dev', 'pane-1', 'ws-1', ctx)
  check(ws2.rt.workspaceId === 'ws-team', 'K4: a team workspace already recorded stays')

  // K5: abort.
  const ab = M.abortTakeover(k3.rt, 'dev', ctx)
  check(ab.ok && !ag(ab.rt, 'dev').takeover && ag(ab.rt, 'dev').status === 'idle' && ag(ab.rt, 'dev').sessions['t-3'].baseStale === true && ab.effects.some((e) => e.kind === 'dispatch'), 'K5: abort -> idle, the session kept as baseStale, a pass')
  inv(ab.rt, 'K5')
  same(M.abortTakeover(k1.rt, 'dev', ctx), { ok: false, error: 'stopping' }, 'K5: abort while the run still stops: stopping')
  check(M.abortTakeover(idle, 'dev', ctx).rt === idle, 'K5: abort without a takeover is a no-op')
  same(M.abortTakeover(b.rt, 'dev', ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'K5: a bound takeover is released, not aborted')

  // K6: release.
  same(M.beginRelease(b.rt, 'dev', true, ctx), { ok: false, error: 'busy' }, 'K6: the console works -> busy, nothing moves')
  const rl = M.beginRelease(b.rt, 'dev', false, ctx)
  check(rl.ok && ag(rl.rt, 'dev').takeover.phase === 'releasing' && rl.result.paneId === 'pane-1' && rl.result.workspaceId === 'ws-1', 'K6: releasing, the console named')
  inv(rl.rt, 'K6 releasing')
  same(M.beginRelease(rl.rt, 'dev', false, ctx), { ok: false, error: 'busy' }, 'K6: a second release in flight: busy')
  same(M.beginRelease(k3.rt, 'dev', false, ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'K6: a takeover still waiting for its console: stale')
  const back = M.finishRelease(rl.rt, 'dev', false, ctx)
  check(back.ok && ag(back.rt, 'dev').takeover.phase === 'bound', 'K6: the kill failed -> bound again')
  const done = M.finishRelease(rl.rt, 'dev', true, ctx)
  check(done.ok && !ag(done.rt, 'dev').takeover && ag(done.rt, 'dev').status === 'idle' && ag(done.rt, 'dev').sessions['t-3'].baseStale === true, 'K6: the console gone -> idle, session kept, baseStale')
  inv(done.rt, 'K6')
  same(M.finishRelease(b.rt, 'dev', true, ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'K6: finish without a release in flight: stale')

  // K7 and K4 by reconcile.
  const gone = M.reconcileTakeovers(b.rt, new Map([['pane-9', { workspaceId: 'ws-1' }]]), ctx)
  check(gone.ok && gone.result.released.join() === 'dev' && !ag(gone.rt, 'dev').takeover && gone.effects.some((e) => e.kind === 'dispatch'), 'K7: the bound console left the config -> idle, nothing killed')
  inv(gone.rt, 'K7')
  check(M.reconcileTakeovers(b.rt, new Map([['pane-1', { workspaceId: 'ws-1' }]]), ctx).rt === b.rt, 'K7: the bound console still in the config: bound')
  // B9 review, findings 1 and 4: the bound console saved under another workspace (moved, its home deleted) keeps its
  // takeover, which records the workspace it is in now.
  const movedWs = M.reconcileTakeovers(b.rt, new Map([['pane-1', { workspaceId: 'ws-user' }]]), ctx)
  const mt = ag(movedWs.rt, 'dev').takeover
  check(movedWs.ok && mt.phase === 'bound' && mt.paneId === 'pane-1' && mt.workspaceId === 'ws-user' && movedWs.result.moved.join() === 'dev' && movedWs.result.released.length === 0 && movedWs.effects.length === 0, 'K7: a bound console under another workspace stays bound and its workspace follows it', { tk: mt, result: movedWs.result })
  check(movedWs.rt.workspaceId === b.rt.workspaceId, '...the team workspace stays')
  inv(movedWs.rt, 'K7 moved')
  check(M.reconcileTakeovers(rl.rt, new Map(), ctx).rt === rl.rt, 'K7: a releasing takeover is left to its release')
  const found = M.reconcileTakeovers(k3.rt, new Map([['pane-x', { workspaceId: 'ws-1', sessionId: 'other' }], ['pane-y', { workspaceId: 'ws-2', sessionId: 's-new', provider: 'claude' }]]), ctx)
  check(found.ok && found.result.bound.join() === 'dev' && ag(found.rt, 'dev').takeover.paneId === 'pane-y' && ag(found.rt, 'dev').takeover.workspaceId === 'ws-2', 'K4 by reconcile: the console whose lastSession is the session')
  const pref = M.reconcileTakeovers(k3.rt, new Map([['pane-a', { workspaceId: 'ws-1', sessionId: 's-new' }], ['pane-b', { workspaceId: 'ws-1', holds: 's-new' }]]), ctx)
  check(ag(pref.rt, 'dev').takeover.paneId === 'pane-b', 'K4 by reconcile: the console sessionHolder names before a saved lastSession')
  check(M.reconcileTakeovers(k3.rt, new Map([['pane-c', { workspaceId: 'ws-1', sessionId: 's-new', provider: 'codex' }]]), ctx).rt === k3.rt, 'K4 by reconcile: another provider never binds')
  // Item 3 of the B9 integration: the console whose live status names the session binds first; one whose saved
  // lastSession names it but whose live status names another session, or that a notHeld release left in place, never.
  const livePick = M.reconcileTakeovers(k3.rt, new Map([
    ['pane-saved', { workspaceId: 'ws-1', sessionId: 's-new', provider: 'claude' }],
    ['pane-holder', { workspaceId: 'ws-1', holds: 's-new' }],
    ['pane-live', { workspaceId: 'ws-2', live: 's-new' }],
  ]), ctx)
  check(ag(livePick.rt, 'dev').takeover.paneId === 'pane-live' && ag(livePick.rt, 'dev').takeover.workspaceId === 'ws-2', 'K4 by reconcile: the console whose live status names the session wins over the holder and a saved lastSession before it', ag(livePick.rt, 'dev').takeover)
  check(M.reconcileTakeovers(k3.rt, new Map([['pane-cleared', { workspaceId: 'ws-1', sessionId: 's-new', provider: 'claude', live: 'other-chat' }]]), ctx).rt === k3.rt, 'K4 by reconcile: a saved lastSession whose live status names another session never binds, even alone')
  const notCleared = M.reconcileTakeovers(k3.rt, new Map([['pane-cleared', { workspaceId: 'ws-1', sessionId: 's-new', live: 'other-chat', holds: 's-new' }], ['pane-next', { workspaceId: 'ws-1', sessionId: 's-new' }]]), ctx)
  check(ag(notCleared.rt, 'dev').takeover.paneId === 'pane-next', 'K4 by reconcile: the console after it binds instead')
  check(M.reconcileTakeovers(k3.rt, new Map([['pane-left', { workspaceId: 'ws-1', sessionId: 's-new', holds: 's-new', left: ['s-new'] }]]), ctx).rt === k3.rt, 'K4 by reconcile: a console a notHeld release left in place never binds that session (not as the holder either)')
  const afterLeft = M.reconcileTakeovers(k3.rt, new Map([['pane-left', { workspaceId: 'ws-1', sessionId: 's-new', left: ['s-new'] }], ['pane-new', { workspaceId: 'ws-1', sessionId: 's-new' }]]), ctx)
  check(ag(afterLeft.rt, 'dev').takeover.paneId === 'pane-new', 'K4 by reconcile: the new console after a left one binds')
  const leftLive = M.reconcileTakeovers(k3.rt, new Map([['pane-new', { workspaceId: 'ws-1', sessionId: 's-new' }], ['pane-left', { workspaceId: 'ws-1', live: 's-new', left: ['s-new'] }]]), ctx)
  check(ag(leftLive.rt, 'dev').takeover.paneId === 'pane-left', 'K4 by reconcile: a left console whose live status names the session again binds (it resumed it)')
  check(M.reconcileTakeovers(k3.rt, new Map([['pane-l2', { workspaceId: 'ws-1', sessionId: 's-new', left: ['s-other'] }]]), ctx).rt !== k3.rt, 'K4 by reconcile: a console left for another session still takes this one')
  same([M.takeoverPaneRank({ workspaceId: 'w', live: 's' }, { sessionId: 's', provider: 'claude' }), M.takeoverPaneRank({ workspaceId: 'w', holds: 's' }, { sessionId: 's', provider: 'claude' }), M.takeoverPaneRank({ workspaceId: 'w', sessionId: 's' }, { sessionId: 's', provider: 'claude' }), M.takeoverPaneRank({ workspaceId: 'w' }, { sessionId: 's', provider: 'claude' })], [0, 1, 2, null], 'takeoverPaneRank: live 0, holder 1, saved 2, nothing null')

  // dropTakeover (K5 deadline, K7, K6 not held).
  const dr = M.dropTakeover(b.rt, 'dev', ctx)
  check(dr.ok && !ag(dr.rt, 'dev').takeover && ag(dr.rt, 'dev').sessions['t-3'].baseStale === true, 'drop: idle without a kill, baseStale')
  check(M.dropTakeover(idle, 'dev', ctx).rt === idle && M.dropTakeover(k1.rt, 'dev', ctx).rt === k1.rt, 'drop: nothing held (none, stopping) is a no-op')
  same(M.dropTakeover(rl.rt, 'dev', ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'drop: a releasing one is the release op\'s')

  // The load fix: releasing -> bound, a stopping takeover whose run the reaper ended -> bindPending.
  const lr = M.takeoversAtLoad(rl.rt, ctx)
  check(ag(lr.rt, 'dev').takeover.phase === 'bound', 'at load: releasing -> bound')
  inv(lr.rt, 'load releasing')
  const reapedLike = deepFreeze({ ...ended.rt })
  const ls = M.takeoversAtLoad(reapedLike, ctx)
  check(ag(ls.rt, 'dev').takeover.phase === 'bindPending' && ag(ls.rt, 'dev').status === 'takenOver', 'at load: a stopping takeover whose run is gone -> bindPending')
  inv(ls.rt, 'load stopping')

  // The give-back continuation: a task the agent runs in its phase that nothing would wake.
  const gb = (patch) => runtime((rt) => {
    rt.agents = rt.agents.map((a) => (a.id === 'dev' ? { ...a, status: 'takenOver', sessions: { 't-1': sess('s-1') }, takeover: { phase: 'bound', at: NOW, sessionKey: 't-1', sessionId: 's-1', provider: 'claude', cwd: REPO, paneId: 'p', workspaceId: 'w' } } : a))
    patch?.(rt)
  })
  const g1 = M.finishRelease(M.beginRelease(gb(), 'dev', false, ctx).rt, 'dev', true, ctx)
  const t1 = g1.rt.tasks.find((t) => t.id === 't-1')
  check(t1.next && t1.next.agentId === 'dev' && t1.next.mode === 'exec' && t1.next.reason === 'continuation' && t1.next.since === NOW, 'give back: an executing task with nothing to wake it gets a continuation', t1.next)
  inv(g1.rt, 'give back')
  const noBack = (label, patch) => {
    const r = M.dropTakeover(gb(patch), 'dev', ctx)
    const t = r.rt.tasks.find((x) => x.id === 't-1')
    check(!t.next || t.next.reason !== 'continuation', `give back: none when ${label}`)
  }
  noBack('the task has a wake mark', (rt) => { rt.tasks = rt.tasks.map((t) => (t.id === 't-1' ? { ...t, next: { agentId: 'dev', mode: 'exec', reason: 'answer', since: NOW - 1 } } : t)) })
  noBack('a comment waits for the agent', (rt) => { rt.comments = { 't-1': [{ id: 'm-1', target: 't-1', author: { kind: 'user', via: 'desktop' }, kind: 'comment', at: NOW, text: 'hola', forAgent: 'dev' }] }; rt.nextIds = { ...rt.nextIds, comment: 2 } })
  noBack('a card of the task is open', (rt) => { rt.cards = [{ id: 'k-1', taskId: 't-1', kind: 'text', question: '?', options: [], multi: false, state: 'open', from: { kind: 'agent', agentId: 'dev', runId: 'r-0000000000c1', tool: 'ask' }, createdAt: NOW }]; rt.nextIds = { ...rt.nextIds, card: 2 } })
  noBack('the task waits on the user (planApproval)', (rt) => { rt.tasks = rt.tasks.map((t) => (t.id === 't-1' ? { ...t, phase: 'planApproval', needsPlan: true, plan: { rev: 1, text: 'p', status: 'pending', small: false, at: NOW } } : t)); rt.approvals = [{ id: 'a-1', taskId: 't-1', state: 'pending', decider: 'user', createdAt: NOW, createdBy: { kind: 'system' }, kind: 'plan', payload: { planRev: 1, small: false } }]; rt.nextIds = { ...rt.nextIds, approval: 2 } })
  noBack('another agent runs the phase', (rt) => { rt.tasks = rt.tasks.map((t) => (t.id === 't-1' ? { ...t, assignee: 'dev-2' } : t)) })
  noBack('the task is done', (rt) => { rt.tasks = rt.tasks.map((t) => (t.id === 't-1' ? { ...t, state: 'done', phase: 'none' } : t)) })
  const lead = M.dropTakeover(M.bindTakeover(kl.rt, 'lead', 'p', 'w', ctx).rt, 'lead', ctx)
  check(lead.ok && lead.rt.tasks.every((t) => !t.next), 'give back: a lead session wakes no task')

  // The takeover run-end policy: no card blocks the task of a run a takeover stopped; the rest stands.
  const block = { block: { reason: { kind: 'card', cardId: '', why: 'noProgress' }, card: { why: 'noProgress', actions: ['retry', 'dismiss'] } }, counters: { noProgress: 3 }, providerBlock: { provider: 'claude', until: NOW + 1 } }
  const tp = M.takeoverPolicy(block, { run: { stopReason: 'takeover' } })
  check(!tp.block && tp.counters.noProgress === 3 && tp.providerBlock.until === NOW + 1, 'takeover policy: the card block goes, the counters and provider facts stay', tp)
  check(M.takeoverPolicy(block, { run: { stopReason: 'user' } }) === block && M.takeoverPolicy({ next: null }, { run: { stopReason: 'takeover' } }).next === null, 'takeover policy: any other stop untouched')

  // The grant's workspace (plan 3.10.2): the team's, else the cwd's, else the repo root's, else absent.
  const cfg = (list) => ({ workspaces: list.map(([id, cwd]) => ({ id, name: id, cwd, panes: [] })) })
  check(M.grantWorkspaceOf(cfg([['w-a', REPO], ['w-team', path.join(TMP, 'x')]]), 'w-team', WT, REPO) === 'w-team', 'grant workspace: the team\'s workspace while it exists')
  const wtAsSaved = process.platform === 'win32' ? WT.toUpperCase() : WT
  check(M.grantWorkspaceOf(cfg([['w-a', REPO], ['w-wt', wtAsSaved]]), 'w-gone', WT, REPO) === 'w-wt', 'grant workspace: else the one whose folder is the session cwd (the worktree; case-insensitive on Windows)')
  check(M.grantWorkspaceOf(cfg([['w-b', path.join(TMP, 'y')], ['w-a', REPO + path.sep]]), undefined, WT, REPO) === 'w-a', 'grant workspace: else the repo root\'s')
  check(M.grantWorkspaceOf(cfg([['w-b', path.join(TMP, 'y')], ['w-c', '']]), undefined, WT, REPO) === undefined && M.grantWorkspaceOf(null, 'w-team', WT, REPO) === undefined, 'grant workspace: else absent (the renderer creates "Equipo <nombre>")')
}

/**
 * Item 1 of the B9 integration (orchestrator decision): a takeover of the Lead hands every pending lead-decided
 * approval to the user, like the lead escalation of a run end (decider user, a leadEscalation note for nobody), also a
 * small plan written while the Lead is held; Devolver never takes them back; another agent's takeover changes nothing.
 */
function leadHoldChecks() {
  const R9 = 'r-0000000000d1'
  const small = (taskId, approvalId, o = {}) => (rt) => {
    rt.tasks = rt.tasks.map((t) => (t.id === taskId ? { ...t, phase: 'planApproval', needsPlan: true, plan: { rev: 1, text: 'p', status: 'pending', small: true, at: NOW, approvalId } } : t))
    rt.approvals = [...rt.approvals, { id: approvalId, taskId, state: 'pending', decider: 'lead', createdAt: NOW, createdBy: { kind: 'system' }, kind: 'plan', payload: { planRev: 1, small: true }, ...o }]
    rt.nextIds = { ...rt.nextIds, approval: Math.max(rt.nextIds.approval, Number(approvalId.slice(2)) + 1) }
  }
  const leadSession = (rt) => { rt.agents = rt.agents.map((a) => (a.id === 'lead' ? { ...a, sessions: { lead: sess('s-lead') } } : a.id === 'dev' ? { ...a, sessions: { 't-1': sess('s-1') } } : a)) }
  const base = runtime((rt) => { leadSession(rt); small('t-1', 'a-1')(rt); small('t-2', 'a-2', { leadSeenRunId: R9 })(rt) })
  inv(base, 'two small plans the Lead decides')
  const ap = (rt, id) => rt.approvals.find((a) => a.id === id)
  const notes = (rt) => (rt.comments.lead ?? []).filter((c) => c.sys?.key === 'leadEscalation')

  // K3 on the Lead: both go to the user at once, one note each, for nobody.
  const k3 = M.beginTakeover(base, 'lead', ctx)
  check(k3.ok && ag(k3.rt, 'lead').takeover.phase === 'bindPending', 'the Lead held (K3)')
  check(ap(k3.rt, 'a-1').decider === 'user' && ap(k3.rt, 'a-2').decider === 'user' && ap(k3.rt, 'a-1').state === 'pending', 'every pending lead-decided approval goes to the user (seen or not by a Lead run)')
  same(notes(k3.rt).map((c) => [c.sys.vars.taskId, c.forAgent ?? null, c.text]), [['t-1', null, ''], ['t-2', null, '']], 'one leadEscalation note per approval in the Lead thread, for nobody')
  inv(k3.rt, 'Lead held, approvals escalated')
  // A dev takeover leaves them to the Lead.
  const dev = M.beginTakeover(base, 'dev', ctx)
  check(dev.ok && ap(dev.rt, 'a-1').decider === 'lead' && notes(dev.rt).length === 0, 'another agent\'s takeover changes no approval')
  check(M.escalateHeldLead(base, ctx).rt === base && M.escalateHeldLead(dev.rt, ctx).rt === dev.rt, 'escalateHeldLead without a held Lead: the same rt')
  // Bound, a small plan written now goes to the user in that same commit (settleTakeovers, which TeamService.commit applies).
  const bound = M.bindTakeover(k3.rt, 'lead', 'pl', 'wl', ctx)
  const later = deepFreeze({ ...bound.rt, approvals: [...bound.rt.approvals, { id: 'a-3', taskId: 't-3', state: 'pending', decider: 'lead', createdAt: NOW, createdBy: { kind: 'system' }, kind: 'plan', payload: { planRev: 1, small: true } }] })
  const settled = M.settleTakeovers(later, ctx)
  check(settled.result.escalated.join() === 'a-3' && ap(settled.rt, 'a-3').decider === 'user' && notes(settled.rt).length === 3, 'a small plan written while the Lead is held goes to the user at once', settled.result)
  check(M.settleTakeovers(bound.rt, ctx).rt === bound.rt, 'settle with nothing left to escalate: the same rt')
  // Devolver never takes them back.
  const back = M.finishRelease(M.beginRelease(bound.rt, 'lead', false, ctx).rt, 'lead', true, ctx)
  check(back.ok && !ag(back.rt, 'lead').takeover && ap(back.rt, 'a-1').decider === 'user' && ap(back.rt, 'a-2').decider === 'user', 'Devolver: the Lead idle, the approvals stay the user\'s')
  inv(back.rt, 'Lead released')
  // K1 on a running Lead run: nothing moves while it stops; its end (K2) hands the session over and escalates the rest.
  const running = runtime((rt) => {
    leadSession(rt)
    small('t-1', 'a-1')(rt)
    rt.activeRuns = [run(R1, { agentId: 'lead', roleId: 'lead', roleKind: 'lead', taskId: undefined, sessionKey: 'lead', mode: 'lead', profile: 'readonly', sessionId: 's-lead' })]
    rt.agents = rt.agents.map((a) => (a.id === 'lead' ? { ...a, status: 'running', runId: R1 } : a))
  })
  const k1 = M.beginTakeover(running, 'lead', ctx)
  check(k1.ok && !k1.result.immediate && ap(k1.rt, 'a-1').decider === 'lead', 'K1 on the Lead: the approval waits while its run stops')
  const ended = M.interruptAll(k1.rt, 'shutdown', M.afterRunPolicy, ctx)
  const s1 = M.settleTakeovers(ended.rt, ctx)
  check(ag(s1.rt, 'lead').takeover.phase === 'bindPending' && ap(s1.rt, 'a-1').decider === 'user' && s1.result.escalated.join() === 'a-1', 'K2: the hand-over escalates it in the run end\'s own commit')
  inv(s1.rt, 'K2 Lead escalated')
  // A queued Lead run whose key had a session: held at once, escalated at once.
  const queuedLead = runtime((rt) => {
    leadSession(rt)
    small('t-1', 'a-1')(rt)
    rt.activeRuns = [run(R1, { agentId: 'lead', roleId: 'lead', roleKind: 'lead', taskId: undefined, sessionKey: 'lead', mode: 'lead', profile: 'readonly', state: 'queued', reachedRunning: false, startedAt: undefined, sessionId: undefined })]
    rt.agents = rt.agents.map((a) => (a.id === 'lead' ? { ...a, status: 'running', runId: R1 } : a))
  })
  const q = M.beginTakeover(queuedLead, 'lead', ctx)
  check(q.ok && q.result.immediate && ap(q.rt, 'a-1').decider === 'user', 'K1 on a queued Lead run: held and escalated at once')
  inv(q.rt, 'queued Lead escalated')
}

// ---- part 2: the service --------------------------------------------------------------------------
/** A manual clock and the timer deps of DeadlineTimer on it (deadlines move only on advance). */
function manualClock(start = NOW) {
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

const gitCfg = path.join(TMP, 'gitconfig')
fs.writeFileSync(gitCfg, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
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

const services = []
/** A service on a repo with a trusted team, the fake agent, and fake consoles: `cfg.workspaces`, `ptys`, `states`, `holders`. */
async function world(name, o = {}) {
  const dir = path.join(TMP, name)
  const repo = o.repo ?? makeRepo(path.join(dir, 'repo'))
  const data = o.data ?? path.join(dir, 'data')
  const clock = o.clock ?? manualClock()
  // `fakePids`: a pid this map names is alive or dead as it says (a decision 64 orphan); every other pid is the real one.
  const w = { dir, repo, data, clock, logs: [], emitted: [], killed: [], notices: [], scenario: path.join(FIX, 'hang.json'), holders: new Map(), states: new Map(), ptys: new Map(), spawnCwds: new Map(), fakePids: new Map() }
  w.cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '' }, workspaces: o.workspaces ?? [] }
  // The run env names the CLI shim (RunStarter refuses a run without it: cliOff); an empty file is enough here.
  const shim = path.join(dir, 'bin', process.platform === 'win32' ? 'snaos.cmd' : 'snaos')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, '')
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
    status: { snapshot: () => [], stateOf: (id) => w.states.get(id) ?? null, paneForSession: () => null },
    pty: {
      spawnCwd: (id) => w.spawnCwds.get(id),
      ptyIdForPane: (id) => w.ptys.get(id) ?? null,
      killPaneAndWait: (id) => {
        w.killed.push(id)
        if (w.killHangs) return new Promise(() => undefined)
        if (!w.killFails) w.ptys.delete(id)
        return Promise.resolve()
      },
    },
    sessionHolder: (_p, s) => w.holders.get(s) ?? null,
    cli: { envForTeam: (runId) => ({ SNAOS_CTL_ENDPOINT: 'test-pipe', SNAOS_CTL_TOKEN: 'x'.repeat(64), SNAOS_CLI: shim, SNAOS_TEAM_RUN: runId }), revokeTeam: () => undefined, ready: () => true, holdsToken: () => false, maskTokens: (t) => t },
    spawn: (...a) => cp.spawn(...a),
    resolveCli: () => ({ file: process.execPath, args: [FAKE, w.scenario], kind: 'exe' }),
    procStartTime: async () => null,
    treeKill: { sync: (pid) => M.treeKillSync(pid), signal: (pid, sig) => M.signalTree(pid, sig), alive: (pid) => (w.fakePids.has(pid) ? w.fakePids.get(pid) : M.pidAlive(pid)) },
    notice: (n) => w.notices.push(json(n)),
    takeoverWait: { stopMs: 8000, paneMs: 120 },
    platform: process.platform,
  })
  services.push(w.svc)
  await w.svc.start(w.cfg)
  if (!o.noTeam) {
    const probe = await w.svc.request({ op: 'setupProbe', dir: repo }, 'desktop')
    const draft = { ...probe.probe.defaults, goal: '', verify: '' }
    const prev = await w.svc.request({ op: 'setupPreview', repoRoot: repo, draft }, 'desktop')
    const wr = await w.svc.request({ op: 'setupWrite', repoRoot: repo, draft, previewHash: prev.preview.hash }, 'desktop')
    assert.ok(wr.ok, `setup ${name}: ${JSON.stringify(wr)}`)
    w.teamId = wr.teamId
  } else w.teamId = o.teamId
  w.req = (r) => w.svc.request({ teamId: w.teamId, ...r }, 'desktop')
  w.rt = () => w.svc.team(w.teamId).store.rt
  w.agent = (id) => w.rt().agents.find((a) => a.id === id)
  w.task = (id) => w.rt().tasks.find((t) => t.id === id)
  w.ring = () => w.svc.team(w.teamId).store.recentRuns()
  w.ended = (id) => w.ring().find((r) => r.id === id)
  w.active = (id) => w.rt().activeRuns.find((r) => r.id === id)
  w.use = (file) => {
    if (typeof file === 'object') {
      const p = path.join(dir, `scenario-${Math.random().toString(16).slice(2)}.json`)
      fs.writeFileSync(p, JSON.stringify(file))
      w.scenario = p
    } else w.scenario = path.join(FIX, file)
  }
  w.waitState = (id, state) => until(() => w.active(id)?.state === state || (!!w.ended(id) && state === 'ended'), 20000, `run ${id} ${state}`)
  w.bindKey = (agentId) => M.takeoverBindKey(w.teamId, agentId)
  w.hasBind = (agentId) => w.svc.timer.has(w.bindKey(agentId))
  /** A console of the config: `ws` workspace, a live pty unless `dead`, lastSession of `session` when given. */
  w.console = (paneId, ws, session, extra = {}) => {
    let wsObj = w.cfg.workspaces.find((x) => x.id === ws)
    if (!wsObj) {
      wsObj = { id: ws, name: ws, cwd: extra.wsCwd ?? path.join(dir, 'elsewhere'), panes: [] }
      w.cfg.workspaces = [...w.cfg.workspaces, wsObj]
    }
    const pane = { id: paneId, type: 'claude', title: 'Dev', color: '', icon: '', cwd: session?.cwd }
    if (session) pane.lastSession = { provider: session.provider ?? 'claude', sessionId: session.sessionId, cwd: session.cwd, at: clock.now }
    w.cfg.workspaces = w.cfg.workspaces.map((x) => (x.id === ws ? { ...x, panes: [...x.panes.filter((p) => p.id !== paneId), pane] } : x))
    if (!extra.dead) w.ptys.set(paneId, `pty-${paneId}`)
  }
  w.dropConsole = (paneId) => {
    w.cfg.workspaces = w.cfg.workspaces.map((x) => ({ ...x, panes: x.panes.filter((p) => p.id !== paneId) }))
  }
  w.saveConfig = () => w.svc.setConfig({ ...w.cfg })
  w.takeIdle = async (agentId) => {
    const r = await w.req({ op: 'takeover', agentId })
    assert.ok(r.ok, `takeover ${agentId}: ${JSON.stringify(r)}`)
    return r.grant
  }
  return w
}

/** A task run of dev on t-1 (exec, main isolation) that reached running and hangs. */
async function devRun(w, scenario = 'hang.json') {
  if (!w.task('t-1')) {
    const c = await w.req({ op: 'createTask', task: { title: 'Login con Google', assignee: 'dev', needsPlan: false, isolation: 'main' } })
    assert.ok(c.ok, JSON.stringify(c))
  }
  w.use(scenario)
  const r = await w.req({ op: 'runNow', agentId: 'dev', taskId: 't-1' })
  assert.ok(r.ok, `runNow: ${JSON.stringify(r)}`)
  await w.waitState(r.runId, 'running')
  return r.runId
}

async function takeoverChecks() {
  const w = await world('takeover')
  const runId = await devRun(w)
  const sessionId = w.active(runId).sessionId
  const cardsBefore = w.rt().cards.length

  // K1: both requests run synchronously up to the stop: the first commits `stopping`, the second (a double click) is busy.
  const first = w.req({ op: 'takeover', agentId: 'dev' })
  const second = w.req({ op: 'takeover', agentId: 'dev' })
  check(w.agent('dev').takeover?.phase === 'stopping' && w.active(runId)?.state === 'stopping' && w.active(runId)?.stopReason === 'takeover', 'K1: the run stops for the takeover (takeover.stopping)')
  same(await second, { ok: false, error: 'busy' }, 'a double click while the run stops: busy')
  // A console opening the session while the run stops changes nothing (the first reason wins, no sessionConflict card).
  w.svc.onPaneStatus({ paneId: 'pane-x', state: 'working', precise: true, notify: false, provider: 'claude', sessionId })
  const r = await first
  check(r.ok, 'K2: the takeover answers once the run ended', r)
  const g = r.grant
  same(Object.keys(g).sort(), ['agentName', 'cwd', 'provider', 'sessionId', 'taskId', 'teamName', 'title'], 'the grant: the session, its cwd and the names, nothing else (no token, no team env, no workspace in a config without one)')
  check(g.provider === 'claude' && g.sessionId === sessionId && samePath(g.cwd, w.repo) && g.taskId === 't-1' && g.agentName === 'Dev' && g.title === 'Dev (t-1)' && g.teamName === w.svc.trusted(w.teamId).def.name, 'the grant: the run session, the repo root, "Dev (t-1)"', g)
  check(!JSON.stringify(g).includes('SNAOS') && !JSON.stringify(g).includes('x'.repeat(64)), 'the grant never carries a token or SNAOS_TEAM_RUN')
  const ended = w.ended(runId)
  check(ended && ended.state === 'takenOver' && ended.stopReason === 'takeover', 'the run ended takenOver', ended)
  const dev = w.agent('dev')
  check(dev.status === 'takenOver' && dev.takeover.phase === 'bindPending' && dev.takeover.sessionId === sessionId && !dev.runId, 'the agent holds the session for a console (bindPending)', dev)
  check(w.hasBind('dev') && w.svc.timer.at(w.bindKey('dev')) === dev.takeover.at + M.TAKEOVER_BIND_MS, 'the bind: deadline is armed at at + TAKEOVER_BIND_MS')
  check(w.rt().cards.length === cardsBefore && !w.rt().cards.some((c) => c.state === 'open' && c.taskId === 't-1'), 'no card about the run the user now drives (no sessionConflict either)')
  check(!w.task('t-1').next && w.task('t-1').state === 'doing', 'the task waits (no wake while the user drives it)')
  // A retry once the grant left main: busy.
  same(await w.req({ op: 'takeover', agentId: 'dev' }), { ok: false, error: 'busy' }, 'a retry after the grant: busy')

  // The dispatcher never starts a taken-over agent (Ejecutar ahora defers takenOver).
  const again = await w.req({ op: 'runNow', agentId: 'dev', taskId: 't-1' })
  check(!again.ok && again.error === 'deferred' && again.defer.reason === 'takenOver', 'Ejecutar ahora on a taken-over agent: deferred takenOver', again)
  check(!w.rt().activeRuns.some((x) => x.agentId === 'dev'), 'no run of the agent')

  // K4: takeoverBound validated in main.
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p-none', workspaceId: 'w1' }), { ok: false, error: 'bad_request' }, 'K4: a console not in the config: bad_request')
  check(w.agent('dev').takeover.phase === 'bindPending', '...still bindPending')
  w.console('p1', 'w1', { sessionId, cwd: w.repo }, { wsCwd: w.repo })
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p1', workspaceId: 'w-other' }), { ok: false, error: 'bad_request' }, 'K4: a console under another workspace: bad_request')
  w.holders.set(sessionId, 'p-someone-else')
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p1', workspaceId: 'w1' }), { ok: false, error: 'bad_request' }, 'K4: another console holds the session: bad_request')
  w.holders.delete(sessionId)
  w.console('p2', 'w1', { sessionId: 'another-session', cwd: w.repo })
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p2', workspaceId: 'w1' }), { ok: false, error: 'bad_request' }, 'K4: a console of another session: bad_request')
  check(w.agent('dev').takeover.phase === 'bindPending' && w.hasBind('dev'), '...still bindPending, its deadline armed')
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: M.teamPaneId(runId), workspaceId: 'w1' }), { ok: false, error: 'bad_request' }, 'K4: a team run pane: bad_request')
  // The renderer saves its config through a debounce: the takeoverBound that comes first waits for the save.
  w.dropConsole('p1')
  w.ptys.delete('p1')
  const emittedBefore = w.emitted.length
  const pending = w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p1', workspaceId: 'w1' })
  await settle(20)
  w.console('p1', 'w1', { sessionId, cwd: w.repo })
  w.saveConfig()
  same(await pending, { ok: true }, 'K4: the config save that lands after the takeoverBound binds it')
  const b = w.agent('dev').takeover
  check(b.phase === 'bound' && b.paneId === 'p1' && b.workspaceId === 'w1' && w.rt().workspaceId === 'w1' && !w.hasBind('dev'), 'bound to p1 in w1; the team workspace recorded; the deadline cleared', b)
  check(w.emitted.slice(emittedBefore).some((e) => e.scopes.includes('list') && e.scopes.includes('agents')), 'the bind emits list and agents')
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p1', workspaceId: 'w1' }), { ok: true }, 'K4: the same console again: ok')
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p2', workspaceId: 'w1' }), { ok: false, error: 'conflict', reason: 'stale' }, 'K4: another console once bound: conflict stale')

  // The views: the sidebar row and the roster card.
  const list = await w.svc.request({ op: 'list' }, 'desktop')
  same(list.teams.find((t) => t.id === w.teamId).takeovers.map((x) => ({ paneId: x.paneId, agentId: x.agentId, agentName: x.agentName, taskId: x.taskId })), [{ paneId: 'p1', agentId: 'dev', agentName: 'Dev', taskId: 't-1' }], 'list: the bound console with its agent and task')
  check(list.teams.find((t) => t.id === w.teamId).workspaceId === 'w1', 'list: the team workspace')
  const roster = await w.req({ op: 'roster' })
  const card = roster.agents.find((a) => a.id === 'dev')
  check(card.status === 'takenOver' && card.takeover.phase === 'bound' && card.takeover.paneId === 'p1' && card.taskId === 't-1' && !card.run, 'roster: takenOver, its console and its task', card)
  check(w.svc.ownsSession(sessionId) === false, 'ownsSession leaves a held session to its console (TranscriptLocator)')

  // The grant of the next takeover names the team's workspace.
  w.console('q1', 'w-qa', null, { wsCwd: w.repo })
  check(M.grantWorkspaceOf(w.cfg, w.rt().workspaceId, w.repo, w.repo) === 'w1', 'the team workspace first')

  // K6: release.
  // Item 2 of the B9 integration: each release busy names its case (TakeoverBusyDetail), so the renderer words each one.
  w.states.set('p1', { paneId: 'p1', state: 'working', precise: true, notify: false })
  same(await w.req({ op: 'release', agentId: 'dev' }), { ok: false, error: 'busy', detail: 'turn' }, 'K6: the console is working: busy turn')
  check(w.agent('dev').takeover.phase === 'bound' && w.killed.length === 0, '...still bound, nothing killed')
  w.states.set('p1', { paneId: 'p1', state: 'action', precise: true, notify: false })
  same(await w.req({ op: 'release', agentId: 'dev' }), { ok: false, error: 'busy', detail: 'turn' }, 'K6: the console asks for something: busy turn')
  w.states.set('p1', { paneId: 'p1', state: 'idle', precise: true, notify: false })
  w.killFails = true
  same(await w.req({ op: 'release', agentId: 'dev' }), { ok: false, error: 'busy', detail: 'kill' }, 'K6: the pty outlives the kill: busy kill')
  check(w.agent('dev').takeover.phase === 'bound' && w.killed.join() === 'p1', '...bound again')
  w.killFails = false
  w.killed.length = 0
  const rel = await w.req({ op: 'release', agentId: 'dev' })
  same(rel, { ok: true, paneId: 'p1', workspaceId: 'w1' }, 'K6: Devolver kills the verified console and names it for removePane')
  check(w.killed.join() === 'p1', 'killPaneAndWait of p1 only')
  const devAfter = w.agent('dev')
  check(devAfter.status === 'idle' && !devAfter.takeover && devAfter.sessions['t-1'].sessionId === sessionId && devAfter.sessions['t-1'].baseStale === true, 'idle, the session kept, baseStale (the next delta is approx)', devAfter)
  const t1 = w.task('t-1')
  check(t1.next && t1.next.agentId === 'dev' && t1.next.mode === 'exec' && t1.next.reason === 'continuation', 'the task goes back to the team: a continuation of the same session', t1.next)
  w.clock.advance(0)
  await settle()
  check(w.rt().queue.some((q) => q.agentId === 'dev' && q.taskId === 't-1'), 'with autonomy off it waits in Por despachar')
  check(w.svc.ownsSession(sessionId) === true, 'released: the team owns the session again')
  w.svc.dispose()
}

async function releaseCornerChecks() {
  const w = await world('release')
  const runId = await devRun(w)
  // Frenar first: a takeover while the run stops for another reason is refused.
  same(await w.req({ op: 'stop', runId }), { ok: true }, 'Frenar')
  same(await w.req({ op: 'takeover', agentId: 'dev' }), { ok: false, error: 'stopping' }, 'takeover refused while the run is stopping')
  await w.waitState(runId, 'ended')
  check(w.ended(runId).state === 'cancelled' && !w.agent('dev').takeover, 'the stop ended as Frenar, no takeover')
  const sessionId = w.agent('dev').sessions['t-1'].sessionId

  // K3: an idle agent hands its session over at once.
  const g = await w.takeIdle('dev')
  check(g.sessionId === sessionId && g.taskId === 't-1' && w.agent('dev').takeover.phase === 'bindPending', 'K3: the idle agent\'s task session at once')
  // The renderer reloaded before its takeoverBound: the config save carrying the console binds it (reconcile).
  w.console('p1', 'w1', { sessionId, cwd: w.repo })
  w.saveConfig()
  check(w.agent('dev').takeover.phase === 'bound' && w.agent('dev').takeover.paneId === 'p1', 'a renderer reload in bindPending: the saved console binds it')
  // K6 when the bound console no longer holds the session: kills nothing, idle, the renderer keeps the console.
  w.console('p1', 'w1', { sessionId: 'the-user-cleared', cwd: w.repo })
  const r1 = await w.req({ op: 'release', agentId: 'dev' })
  same(r1, { ok: false, error: 'conflict', reason: 'stale', detail: 'notHeld' }, 'release when the console no longer holds the session: notHeld (the console stays)')
  check(w.killed.length === 0 && !w.agent('dev').takeover && w.agent('dev').status === 'idle', '...nothing killed, the agent back to the team')
  // The console's own live status names another conversation before its config save lands (a /clear): never killed.
  await w.takeIdle('dev')
  w.console('p2', 'w1', { sessionId, cwd: w.repo })
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p2', workspaceId: 'w1' }), { ok: true }, 'bound to p2')
  w.states.set('p2', { paneId: 'p2', state: 'idle', precise: true, notify: false, provider: 'claude', sessionId: 'the-new-chat' })
  same((await w.req({ op: 'release', agentId: 'dev' })).detail, 'notHeld', 'release while the console status names another session (lastSession not saved yet): notHeld')
  check(w.killed.length === 0 && !w.agent('dev').takeover, '...p2 never killed, the agent back to the team')
  // Item 3 of the B9 integration: the console a notHeld release left in place (p2, its saved lastSession still the
  // session until the renderer's save) never takes that session again: not while its status names the new chat, not
  // once that status is gone, not by takeoverBound; the new console of the next takeover, later in the config, does.
  check(w.svc.consoleLeft(sessionId, 'p2') && w.svc.consoleLeft(sessionId, 'p1') && !w.svc.consoleLeft('another-session', 'p2'), 'p1 and p2 are remembered as left in place for that session only')
  await w.takeIdle('dev')
  w.saveConfig()
  check(w.agent('dev').takeover?.phase === 'bindPending', 'a config save with only the left console (its status on the new chat): still waiting')
  w.states.delete('p2')
  w.saveConfig()
  check(w.agent('dev').takeover?.phase === 'bindPending', '...and once its status is gone (its lastSession still the session): still waiting')
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p2', workspaceId: 'w1' }), { ok: false, error: 'bad_request' }, 'takeoverBound naming the left console: bad_request')
  w.console('p2b', 'w1', { sessionId, cwd: w.repo })
  w.saveConfig()
  check(w.agent('dev').takeover?.phase === 'bound' && w.agent('dev').takeover.paneId === 'p2b', 'the new console binds, never the left one before it in the config', w.agent('dev').takeover)
  same(await w.req({ op: 'release', agentId: 'dev' }), { ok: true, paneId: 'p2b', workspaceId: 'w1' }, 'Devolver p2b')
  check(w.killed.join() === 'p2b', '...killing p2b only')
  w.killed.length = 0
  w.dropConsole('p2b')
  w.saveConfig()
  // Its live status names the session again (the user resumed it there): it holds it now, and it is no longer left.
  await w.takeIdle('dev')
  w.states.set('p2', { paneId: 'p2', state: 'idle', precise: true, notify: false, provider: 'claude', sessionId })
  w.svc.onPaneStatus({ paneId: 'p2', state: 'idle', precise: true, notify: false, provider: 'claude', sessionId })
  check(w.agent('dev').takeover?.phase === 'bound' && w.agent('dev').takeover.paneId === 'p2', 'the left console whose live status names the session again binds')
  check(!w.svc.consoleLeft(sessionId, 'p2'), '...and is no longer remembered as left')
  w.states.delete('p2')
  w.dropConsole('p2')
  w.saveConfig()
  check(!w.agent('dev').takeover, 'p2 gone from the config: back to the team')
  // A console whose saved lastSession names the session but whose live status names another never takes it; the one
  // whose live status names it wins over a saved lastSession before it in the config.
  await w.takeIdle('dev')
  w.console('pa', 'w1', { sessionId, cwd: w.repo })
  w.states.set('pa', { paneId: 'pa', state: 'idle', precise: true, notify: false, provider: 'claude', sessionId: 'another-chat' })
  w.saveConfig()
  check(w.agent('dev').takeover?.phase === 'bindPending', 'a saved lastSession whose live status names another chat: never bound')
  w.console('pb', 'w1', { sessionId, cwd: w.repo })
  w.console('pc', 'w1', null)
  w.states.set('pc', { paneId: 'pc', state: 'idle', precise: true, notify: false, provider: 'claude', sessionId })
  w.saveConfig()
  check(w.agent('dev').takeover?.paneId === 'pc', 'the console whose live status names the session wins over pb (its saved lastSession) and pa', w.agent('dev').takeover)
  for (const id of ['pa', 'pb', 'pc']) {
    w.states.delete(id)
    w.dropConsole(id)
  }
  w.saveConfig()
  check(!w.agent('dev').takeover, 'pc gone from the config: back to the team')
  // Another console holds it now (a live status): never killed either.
  await w.takeIdle('dev')
  w.console('p3', 'w1', { sessionId, cwd: w.repo })
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p3', workspaceId: 'w1' }), { ok: true }, 'bound to p3')
  w.holders.set(sessionId, 'p-other')
  same((await w.req({ op: 'release', agentId: 'dev' })).detail, 'notHeld', 'release while another console holds the session: notHeld')
  check(w.killed.length === 0, '...p3 never killed')
  w.holders.delete(sessionId)
  w.dropConsole('p3')
  // The bound console is gone from the config: ok, nothing killed (removePane finds nothing).
  const g4 = await w.takeIdle('dev')
  check(g4.workspaceId === 'w1', 'the next grant names the team workspace (the first takeover bound it)', g4)
  w.console('p4', 'w1', { sessionId, cwd: w.repo })
  w.saveConfig()
  check(w.agent('dev').takeover.paneId === 'p4', 'bound to p4 (config reconcile)')
  w.dropConsole('p4')
  same(await w.req({ op: 'release', agentId: 'dev' }), { ok: true, paneId: 'p4', workspaceId: 'w1' }, 'release of a console gone from the config: ok')
  check(w.killed.length === 0 && !w.agent('dev').takeover, '...nothing killed')
  same(await w.req({ op: 'release', agentId: 'dev' }), { ok: false, error: 'conflict', reason: 'stale' }, 'release with nothing taken over: conflict stale')

  // K7: closed by hand. The sink exit of a console that left the config ends the takeover; one still listed stays.
  await w.takeIdle('dev')
  w.console('p5', 'w1', { sessionId, cwd: w.repo })
  w.saveConfig()
  w.svc.sink.onExit('pty-p5', 'p5', 0, { current: true, natural: true })
  check(w.agent('dev').takeover.phase === 'bound', 'a bound console that exits but stays in the config stays bound (restartable)')
  w.svc.sink.onExit('pty-old', 'p5', 0, { current: false, natural: false })
  w.dropConsole('p5')
  w.svc.sink.onExit('pty-old', 'p5', 0, { current: false, natural: false })
  check(w.agent('dev').takeover?.phase === 'bound', 'an old pty of the console (not current) changes nothing')
  w.svc.sink.onExit('pty-p5', 'p5', 0, { current: true, natural: true })
  check(!w.agent('dev').takeover && w.agent('dev').status === 'idle' && w.killed.length === 0, 'K7: the console closed by hand (gone from the config) -> idle, nothing killed')
  // ...or the config save that drops it.
  await w.takeIdle('dev')
  w.console('p6', 'w1', { sessionId, cwd: w.repo })
  w.saveConfig()
  w.dropConsole('p6')
  w.saveConfig()
  check(!w.agent('dev').takeover, 'K7: a config save without the bound console -> idle')

  // K5: abort; the bind: deadline; a holder found at the deadline.
  await w.takeIdle('dev')
  same(await w.req({ op: 'takeoverAbort', agentId: 'dev' }), { ok: true }, 'takeoverAbort')
  check(!w.agent('dev').takeover && !w.hasBind('dev'), 'K5: abort -> idle, no deadline left')
  same(await w.req({ op: 'takeoverAbort', agentId: 'dev' }), { ok: true }, 'a second abort is a no-op')
  await w.takeIdle('dev')
  w.clock.advance(M.TAKEOVER_BIND_MS - 1)
  check(w.agent('dev').takeover?.phase === 'bindPending', 'bind: not due yet')
  w.clock.advance(1)
  check(!w.agent('dev').takeover && w.agent('dev').status === 'idle' && w.logs.some((l) => l.includes('bind timed out')), 'K5: the bind: deadline with no console -> idle')
  await w.takeIdle('dev')
  w.console('p7', 'w1', null)
  w.holders.set(sessionId, 'p7')
  w.clock.advance(M.TAKEOVER_BIND_MS)
  check(w.agent('dev').takeover?.phase === 'bound' && w.agent('dev').takeover.paneId === 'p7', 'the bind: deadline with a console holding the session binds it')
  w.holders.delete(sessionId)
  w.dropConsole('p7')
  w.saveConfig()
  check(!w.agent('dev').takeover, 'p7 closed by hand -> idle')

  // A console status naming the session binds a waiting takeover (lazy K4).
  await w.takeIdle('dev')
  w.console('p8', 'w1', null)
  w.holders.set(sessionId, 'p8')
  w.svc.onPaneStatus({ paneId: 'p8', state: 'idle', precise: true, notify: false, provider: 'claude', sessionId })
  check(w.agent('dev').takeover?.phase === 'bound' && w.agent('dev').takeover.paneId === 'p8', 'a console status naming the session binds the waiting takeover')
  w.holders.delete(sessionId)
  w.dropConsole('p8')
  w.saveConfig()

  // takeoverBound wakes on a console spawn too (its pty spawned in the session cwd: K4's third test).
  await w.takeIdle('dev')
  w.console('p9', 'w1', null, { dead: true })
  const pending = w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'p9', workspaceId: 'w1' })
  await settle(10)
  w.spawnCwds.set('p9', w.repo)
  w.ptys.set('p9', 'pty-p9')
  w.svc.sink.onSpawn('pty-p9', 'p9')
  same(await pending, { ok: true }, 'K4: the console spawned in the session cwd binds at its spawn')
  w.svc.dispose()
}

/** A small plan of dev on a new task (a plan run, `team plan --small`, its grace run out); the approval it opened. */
async function smallPlan(w, title) {
  const c = await w.req({ op: 'createTask', task: { title, assignee: 'dev', needsPlan: true, isolation: 'main' } })
  assert.ok(c.ok, JSON.stringify(c))
  w.use('hang.json')
  const pr = await w.req({ op: 'runNow', agentId: 'dev', taskId: c.task.id })
  assert.ok(pr.ok, `plan run: ${JSON.stringify(pr)}`)
  await w.waitState(pr.runId, 'running')
  const who = { runId: pr.runId, teamId: w.teamId, agentId: 'dev', roleKind: 'dev' }
  const r = await w.svc.ctlView.handle('team.plan', { text: 'Un paso', small: true }, who)
  assert.ok(r.ok, `team plan: ${JSON.stringify(r)}`)
  w.clock.advance(M.CONCLUDE_GRACE_MS)
  await w.waitState(pr.runId, 'ended')
  await settle()
  return w.rt().approvals.find((a) => a.kind === 'plan' && a.taskId === c.task.id)
}

async function leadEscalationChecks() {
  // Item 1 of the B9 integration (orchestrator decision): Tomar el control of the Lead hands its small plans to the user.
  const w = await world('lead')
  w.use('claude-simple.json')
  const lr = await w.req({ op: 'runNow', agentId: 'lead', prompt: 'Hola' })
  check(lr.ok, 'a Lead run', lr)
  await w.waitState(lr.runId, 'ended')
  check((w.agent('lead').sessions.lead?.turns ?? 0) > 0, 'the Lead has a conversation', w.agent('lead').sessions)
  const ap = await smallPlan(w, 'Chica')
  const tag = (id) => `team:${w.teamId}:${id}`
  const needRows = async () => {
    const n = await w.req({ op: 'needs' })
    assert.ok(n.ok, JSON.stringify(n))
    return M.teamNeedsRows(n.needs).map((r) => r.id)
  }
  check(ap.state === 'pending' && ap.decider === 'lead' && !(await needRows()).includes(ap.id) && !w.notices.some((n) => n.tag === tag(ap.id)), 'a small plan the Lead decides: out of Te necesita, no notice')
  const g = await w.takeIdle('lead')
  check(g.sessionId === w.agent('lead').sessions.lead.sessionId && !g.taskId, 'the Lead session granted')
  await settle()
  const esc = w.rt().approvals.find((a) => a.id === ap.id)
  check(esc.state === 'pending' && esc.decider === 'user', 'the takeover of the Lead hands the approval to the user (bindPending)')
  check((w.rt().comments.lead ?? []).some((c) => c.sys?.key === 'leadEscalation' && c.sys.vars?.taskId === ap.taskId && c.forAgent === undefined), 'with the leadEscalation note in the Lead thread, for nobody')
  check((await needRows()).includes(ap.id), 'it counts in Te necesita')
  check(w.notices.filter((n) => n.tag === tag(ap.id)).length === 1, 'and notifies once', w.notices)
  check(w.emitted.some((e) => e.teamId === w.teamId && e.scopes.includes('needs') && e.scopes.includes('lead')), 'the takeover commit emits needs and lead')
  // Bound: a small plan written now goes to the user in its own commit.
  w.console('pl', 'w1', { sessionId: g.sessionId, cwd: g.cwd })
  w.saveConfig()
  check(w.agent('lead').takeover?.phase === 'bound', 'the Lead bound to its console')
  const ap2 = await smallPlan(w, 'Otra chica')
  check(ap2.state === 'pending' && ap2.decider === 'user' && w.notices.filter((n) => n.tag === tag(ap2.id)).length === 1, 'a small plan written while the Lead is in a console goes to the user at once, one notice', ap2)
  // Devolver never takes them back, and nothing notifies again.
  same(await w.req({ op: 'release', agentId: 'lead' }), { ok: true, paneId: 'pl', workspaceId: 'w1' }, 'Devolver the Lead')
  w.dropConsole('pl')
  w.saveConfig()
  w.clock.advance(0)
  await settle()
  check(!w.agent('lead').takeover && w.rt().approvals.filter((a) => a.id === ap.id || a.id === ap2.id).every((a) => a.state === 'pending' && a.decider === 'user'), 'after Devolver both stay the user\'s')
  const rows = await needRows()
  check(rows.includes(ap.id) && rows.includes(ap2.id) && w.notices.filter((n) => n.tag === tag(ap.id) || n.tag === tag(ap2.id)).length === 2, 'still in Te necesita, no second notice')
  w.svc.dispose()
}

async function leadRunEscalationChecks() {
  // Item 1 on a live Lead run (K1 + K2 in the service): a small plan that came while the Lead run was running (that
  // run never saw it, so its own end escalates nothing) goes to the user in the run end's own commit, and that commit
  // emits needs and lead (TeamService.commit merges the scopes of its settle step).
  const w = await world('lead-run')
  w.use('claude-simple.json')
  const first = await w.req({ op: 'runNow', agentId: 'lead', prompt: 'Hola' })
  check(first.ok, 'a first Lead run', first)
  await w.waitState(first.runId, 'ended')
  w.use('hang.json')
  const lr = await w.req({ op: 'runNow', agentId: 'lead', prompt: 'Seguí' })
  check(lr.ok, 'a Lead run that hangs', lr)
  await w.waitState(lr.runId, 'running')
  const ap = await smallPlan(w, 'Chica')
  check(ap.state === 'pending' && ap.decider === 'lead' && !ap.leadSeenRunId && !!w.active(lr.runId), 'a small plan the running Lead run never saw', ap)
  const mark = w.emitted.length
  const tk = await w.req({ op: 'takeover', agentId: 'lead' })
  check(tk.ok && w.agent('lead').takeover?.phase === 'bindPending', 'K1 + K2 on the Lead run: granted once it ended', tk)
  await settle()
  const esc = w.rt().approvals.find((a) => a.id === ap.id)
  check(esc.state === 'pending' && esc.decider === 'user', 'the run end hands the approval to the user', esc)
  check(w.logs.some((l) => l.includes('the Lead is in a console') && l.includes(ap.id)), 'escalated by the settle step of the run end commit')
  check(w.emitted.slice(mark).some((e) => e.teamId === w.teamId && e.runId === lr.runId && e.scopes.includes('needs') && e.scopes.includes('lead')), 'the run end commit emits needs and lead', w.emitted.slice(mark))
  check(w.notices.filter((n) => n.tag === `team:${w.teamId}:${ap.id}`).length === 1, 'and notifies once')
  w.svc.dispose()
}

async function stateChecks() {
  // A Claude run still starting with no earlier session: no_session, the run goes on.
  const w = await world('starting')
  const c = await w.req({ op: 'createTask', task: { title: 'Lento', assignee: 'dev', needsPlan: false, isolation: 'main' } })
  check(c.ok, 'task')
  w.use({ steps: [{ sleepMs: 4000 }, { hang: true }] })
  const r = await w.req({ op: 'runNow', agentId: 'dev', taskId: 't-1' })
  await w.waitState(r.runId, 'starting')
  same(await w.req({ op: 'takeover', agentId: 'dev' }), { ok: false, error: 'no_session' }, 'a Claude run still starting with no earlier session: no_session')
  check(w.active(r.runId)?.state === 'starting' && !w.agent('dev').takeover, 'nothing stopped, nothing granted')
  same(await w.req({ op: 'stop', runId: r.runId }), { ok: true }, 'stop it')
  await w.waitState(r.runId, 'ended')

  // Takeover in the linger window: the result came, the process lingers; the run ends from its result, the grant comes.
  // (t-1 is blocked {stopped} by that Frenar: the linger run takes another task.)
  const c2 = await w.req({ op: 'createTask', task: { title: 'Con resultado', assignee: 'dev', needsPlan: false, isolation: 'main' } })
  check(c2.ok && c2.task.id === 't-2', 'task t-2')
  // Two runs that end `empty` first: the third would block the task on a noProgress card (decision 32).
  w.use('claude-simple.json')
  for (let i = 0; i < 2; i++) {
    const e = await w.req({ op: 'runNow', agentId: 'dev', taskId: 't-2' })
    check(e.ok, `empty run ${i + 1}`, e)
    await w.waitState(e.runId, 'ended')
  }
  check(w.task('t-2').counters.noProgress === 2 && w.task('t-2').state === 'doing', 'two empty runs: noProgress 2, still doing', w.task('t-2').counters)
  w.use({ steps: [{ fixture: 'claude-simple.jsonl', rewriteSession: true }, { hang: true }] })
  const l = await w.req({ op: 'runNow', agentId: 'dev', taskId: 't-2' })
  check(l.ok, 'the linger run', l)
  const logFile = path.join(w.data, 'teams', w.teamId, 'runs', `${l.runId}.jsonl`)
  await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('"type":"result"'), 15000, 'the result line')
  await settle()
  check(w.active(l.runId)?.state === 'running', 'still running after its result (linger not due: the manual clock)')
  const cards = w.rt().cards.filter((x) => x.state === 'open').length
  const tl = await w.req({ op: 'takeover', agentId: 'dev' })
  check(tl.ok && tl.grant.taskId === 't-2', 'takeover in the linger window: granted', tl)
  check(w.ended(l.runId).state === 'succeeded' && w.ended(l.runId).resultSeen && w.ended(l.runId).stopReason === 'takeover', 'the run ended from its result (succeeded)', w.ended(l.runId))
  check(w.rt().cards.filter((x) => x.state === 'open').length === cards, 'no card opened by that run\'s end')
  check(w.task('t-2').state === 'doing' && !w.task('t-2').blocked && w.ended(l.runId).outcome === 'empty', 'a third empty outcome blocks nothing: no card about a run the user now drives', w.task('t-2'))
  check(w.agent('dev').takeover.phase === 'bindPending', 'bindPending')

  // Autonomy on and a comment waiting for the agent: the dispatcher never starts a taken-over agent (G5 takenOver).
  check((await w.req({ op: 'settings', patch: { autoDispatch: true } })).ok, 'autonomy on')
  check((await w.req({ op: 'comment', taskId: 't-2', text: 'Seguí con esto' })).ok, 'a comment for the agent')
  w.clock.advance(0)
  await settle()
  check(!w.rt().activeRuns.some((x) => x.agentId === 'dev'), 'the dispatcher never starts the taken-over agent')
  const waitingCard = (await w.req({ op: 'roster' })).agents.find((a) => a.id === 'dev')
  check(waitingCard.waiting?.reason === 'takenOver' && waitingCard.takeover.phase === 'bindPending' && waitingCard.taskId === 't-2', 'its roster card waits: takenOver, on its task', waitingCard)
  check((await w.req({ op: 'settings', patch: { autoDispatch: false } })).ok, 'autonomy off again')

  // Zero DeadlineTimer keys with Labs off; Labs on arms bind: again.
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  check(w.svc.pendingTimers === 0, 'Labs off with a waiting takeover: zero DeadlineTimer keys')
  same(await w.req({ op: 'takeover', agentId: 'dev' }), { ok: false, error: 'disabled' }, 'Labs off: disabled')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(() => !!w.svc.team(w.teamId), 5000, 'enabled again')
  check(w.agent('dev').takeover.phase === 'bindPending' && w.hasBind('dev'), 'Labs on: the waiting takeover keeps its session and bind: is armed again')
  // Its grant left main before the reload? No: a Labs toggle keeps that memory, so a retry stays busy.
  same(await w.req({ op: 'takeover', agentId: 'dev' }), { ok: false, error: 'busy' }, 'a retry after the grant (Labs toggled): busy')

  // A restart in bindPending re-arms bind: from its `at` and times out back to idle.
  const at = w.agent('dev').takeover.at
  w.svc.shutdownSync('quit')
  const w2 = await world('starting-2', { repo: w.repo, data: w.data, clock: manualClock(w.clock.now + 30_000), noTeam: true, teamId: w.teamId, workspaces: [{ id: 'w-repo', name: 'Repo', cwd: w.repo, panes: [] }] })
  check(w2.agent('dev').takeover?.phase === 'bindPending' && w2.agent('dev').status === 'takenOver', 'after a restart: still bindPending')
  check(w2.hasBind('dev') && w2.svc.timer.at(w2.bindKey('dev')) === at + M.TAKEOVER_BIND_MS, 'bind: re-armed at enable from its at')
  // Decision 64 on the retry too: a process of the earlier app life still on that session (a reaped live orphan) -> busy
  // orphan, the takeover keeps waiting and its grant is not marked as delivered.
  const sidW2 = w2.agent('dev').takeover.sessionId
  w2.svc.orphanSession = (teamId, sessionId) => teamId === w2.teamId && sessionId === sidW2
  same(await w2.req({ op: 'takeover', agentId: 'dev' }), { ok: false, error: 'busy', detail: 'orphan' }, 'after a restart, a retry while an orphan holds the session: busy orphan')
  check(w2.agent('dev').takeover?.phase === 'bindPending' && !w2.svc.takeoverGranted(w2.teamId, 'dev', at), '...still waiting, the grant not marked')
  delete w2.svc.orphanSession
  // A grant that never reached this app life: a retry hands it out.
  const retry = await w2.req({ op: 'takeover', agentId: 'dev' })
  check(retry.ok && retry.grant.taskId === 't-2', 'after a restart the takeover retry hands the waiting grant out', retry)
  check(retry.grant.workspaceId === 'w-repo', 'a team without a workspace yet: the grant names the workspace of its folder', retry.grant)
  w2.clock.advance(M.TAKEOVER_BIND_MS)
  check(!w2.agent('dev').takeover && w2.agent('dev').status === 'idle', 'the restart in bindPending times out back to idle')

  // A release in flight when the app quits is bound again at load.
  await w2.takeIdle('dev')
  const sid = w2.agent('dev').takeover.sessionId
  w2.console('p1', 'w1', { sessionId: sid, cwd: w2.repo })
  w2.saveConfig()
  w2.killHangs = true
  void w2.req({ op: 'release', agentId: 'dev' })
  await settle()
  check(w2.agent('dev').takeover.phase === 'releasing', 'releasing while the kill waits')
  same(await w2.req({ op: 'release', agentId: 'dev' }), { ok: false, error: 'busy', detail: 'releasing' }, 'a second release while the first kills: busy releasing')
  check(w2.killed.length === 1, '...and it kills nothing more')
  w2.svc.shutdownSync('quit')
  const w3 = await world('starting-3', { repo: w.repo, data: w.data, clock: manualClock(w2.clock.now + 30_000), noTeam: true, teamId: w.teamId, workspaces: json(w2.cfg.workspaces) })
  check(w3.agent('dev').takeover?.phase === 'bound' && w3.agent('dev').takeover.paneId === 'p1', 'a releasing takeover found at load is bound again')
  check(w3.logs.some((x) => x.includes('takeover') && x.includes('at load')), 'logged at load')
  // Its console is gone after the restart: the enable reconcile sends it back.
  const w4cfg = json(w3.cfg.workspaces).map((x) => ({ ...x, panes: [] }))
  w3.svc.shutdownSync('quit')
  const w4 = await world('starting-4', { repo: w.repo, data: w.data, clock: manualClock(w3.clock.now + 30_000), noTeam: true, teamId: w.teamId, workspaces: w4cfg })
  check(!w4.agent('dev').takeover && w4.agent('dev').status === 'idle', 'no agent stays taken over after a restart without its console')
  w4.svc.dispose()
}

/** dev idle with a task session (a run that reached running, then Frenar): the K3 takeovers below take it. */
async function idleDevWithSession(w) {
  const runId = await devRun(w)
  same(await w.req({ op: 'stop', runId }), { ok: true }, 'Frenar (a session for the idle takeovers)')
  await w.waitState(runId, 'ended')
  return w.agent('dev').sessions['t-1'].sessionId
}

/**
 * B9 review, findings 1 and 4: K6 finds the bound console by its id in any workspace of the saved config. The user
 * moves the takeover's console into a workspace of theirs and deletes its home, now empty ("Equipo X"): the saved
 * config lists the console under the new workspace (deleteWorkspace keeps a console away from its home where it is).
 * Devolver still kills it as the console holding the session and names the workspace it is in now; the config save of
 * that move makes the bound takeover follow its console.
 */
async function movedConsoleChecks() {
  const w = await world('moved')
  const sessionId = await idleDevWithSession(w)
  w.console('pu', 'w-user', null)
  /** The console moved from `from` into the user's workspace and `from` deleted, as the renderer then saves it. */
  const moveAndDelete = (paneId, from) => {
    const pane = w.cfg.workspaces.find((x) => x.id === from).panes.find((p) => p.id === paneId)
    w.cfg.workspaces = w.cfg.workspaces.filter((x) => x.id !== from).map((x) => (x.id === 'w-user' ? { ...x, panes: [...x.panes, pane] } : x))
  }
  // Devolver before any save of that config reached main: the bound record still names the deleted workspace.
  await w.takeIdle('dev')
  w.console('pm', 'w-equipo', { sessionId, cwd: w.repo })
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'pm', workspaceId: 'w-equipo' }), { ok: true }, 'bound to pm in the takeover workspace')
  moveAndDelete('pm', 'w-equipo')
  check(w.agent('dev').takeover.workspaceId === 'w-equipo', 'main still records the deleted workspace (no config save yet)')
  same(await w.req({ op: 'release', agentId: 'dev' }), { ok: true, paneId: 'pm', workspaceId: 'w-user' }, 'K6: Devolver kills the moved console as holding the session (not notHeld) and names the workspace it is in now')
  check(w.killed.join() === 'pm' && !w.agent('dev').takeover && w.agent('dev').status === 'idle', '...pm killed, the agent back to the team')
  check(!w.svc.consoleLeft(sessionId, 'pm'), '...and pm is not remembered as a console left in place')
  w.killed.length = 0
  w.dropConsole('pm')
  w.saveConfig()
  // The config save of the move: the bound takeover follows its console to the new workspace.
  await w.takeIdle('dev')
  w.console('pm2', 'w-equipo-2', { sessionId, cwd: w.repo })
  same(await w.req({ op: 'takeoverBound', agentId: 'dev', paneId: 'pm2', workspaceId: 'w-equipo-2' }), { ok: true }, 'bound to pm2')
  moveAndDelete('pm2', 'w-equipo-2')
  const emittedBefore = w.emitted.length
  w.saveConfig()
  const tk = w.agent('dev').takeover
  check(tk?.phase === 'bound' && tk.paneId === 'pm2' && tk.workspaceId === 'w-user', 'the config save keeps the takeover bound and records the workspace its console is in now', tk)
  await settle()
  check(w.logs.some((l) => l.includes('console under another workspace') && l.includes('dev')) && w.emitted.slice(emittedBefore).some((e) => e.scopes.includes('agents') && e.scopes.includes('list')), '...logged, with agents and list emitted', { logs: w.logs.slice(-5), emitted: w.emitted.slice(emittedBefore) })
  same(await w.req({ op: 'release', agentId: 'dev' }), { ok: true, paneId: 'pm2', workspaceId: 'w-user' }, 'Devolver pm2')
  check(w.killed.join() === 'pm2' && !w.agent('dev').takeover, '...killing pm2 only')
  w.svc.dispose()
}

/**
 * B9 review, finding 3: the takeover op's decision 64 check can commit (the open card of an orphan whose process died
 * is dismissed); the takeover is reduced again after it, so the takeover's own commit never puts that card back.
 */
async function orphanCardChecks() {
  const w = await world('orphan-card')
  const sessionId = await idleDevWithSession(w)
  // A live orphan of an earlier app life on another session of the team, with its open card, as orphanCheck leaves it.
  const PID = 2_000_000_011
  const R = 'r-0000000000f1'
  w.fakePids.set(PID, true)
  const opened = w.svc.commit(w.teamId, M.orphanCards(w.rt(), [{ runId: R, agentId: 'dev', pid: PID }], { now: w.clock.now }), ['needs'])
  const cardId = opened.ok ? opened.result.cards[0]?.cardId : undefined
  check(!!cardId, 'the orphan card', opened)
  w.svc.lingering.set(w.teamId, [{ runId: R, agentId: 'dev', pid: PID, startedAt: w.clock.now - 60_000, cwd: w.repo, sessionId: 's-orphan', cardId }])
  const card = () => w.rt().cards.find((c) => c.id === cardId)
  check(w.svc.orphanSession(w.teamId, 's-orphan') && card().state === 'open', 'the live orphan holds its session, its card open')
  // The orphan exits on its own; the next gate is Tomar el control of the idle dev (K3, the immediate path).
  w.fakePids.set(PID, false)
  const g = await w.takeIdle('dev')
  check(g.sessionId === sessionId && w.agent('dev').takeover?.phase === 'bindPending', 'the takeover holds the dev session')
  check(card().state === 'dismissed', 'the card the takeover\'s own orphan check dismissed stays dismissed (the takeover is reduced after it)', card())
  check(!w.svc.orphanSession(w.teamId, 's-orphan'), '...and its lingering entry is gone')
  const n = await w.req({ op: 'needs' })
  check(n.ok && !M.teamNeedsRows(n.needs).some((r) => r.id === cardId), 'no stale orphan row in Te necesita')
  w.svc.dispose()
}

/**
 * B9 review (integration verifier): the app dies while a takeover stops the Lead run. At load the reaper ends that run,
 * the Lead holds its session again and its pending small plan goes to the user with a leadEscalation note in a full
 * Lead thread: TeamStore.load hands back that step's effects and the service runs them, so the oldest comment the
 * thread drops goes to archive/lead.jsonl instead of being cut.
 */
async function loadArchiveChecks() {
  const w = await world('load-archive')
  w.use('claude-simple.json')
  const first = await w.req({ op: 'runNow', agentId: 'lead', prompt: 'Hola' })
  check(first.ok, 'a first Lead run', first)
  await w.waitState(first.runId, 'ended')
  w.use('hang.json')
  const lr = await w.req({ op: 'runNow', agentId: 'lead', prompt: 'Seguí' })
  check(lr.ok, 'a Lead run that hangs', lr)
  await w.waitState(lr.runId, 'running')
  const ap = await smallPlan(w, 'Chica')
  check(ap.state === 'pending' && ap.decider === 'lead', 'a small plan the Lead decides', ap)
  // The takeover commits `stopping` synchronously: what the disk holds right then is what a crash leaves.
  const pending = w.req({ op: 'takeover', agentId: 'lead' })
  check(w.agent('lead').takeover?.phase === 'stopping', 'the Lead run stops for the takeover')
  w.svc.team(w.teamId).store.flushSync()
  const dir = path.join(w.data, 'teams', w.teamId)
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  const runs = fs.readFileSync(path.join(dir, 'runs.json'), 'utf8')
  check(state.activeRuns.some((r) => r.id === lr.runId) && state.agents.find((a) => a.id === 'lead').takeover.phase === 'stopping', 'the snapshot: the Lead run active, its takeover stopping')
  check((await pending).ok, 'granted once the run ended')
  w.svc.shutdownSync('quit')
  // The crash: that snapshot, with a full Lead thread whose oldest comments are for nobody.
  const lead = state.comments.lead ?? []
  const pad = []
  for (let i = 0; pad.length + lead.length < M.TASK_COMMENTS_MAX; i++) pad.push({ id: `m-${state.nextIds.comment + i}`, target: 'lead', author: { kind: 'system' }, kind: 'system', at: w.clock.now - 10_000 + i, text: `nota ${i}` })
  state.comments = { ...state.comments, lead: [...pad, ...lead] }
  state.nextIds = { ...state.nextIds, comment: state.nextIds.comment + pad.length }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
  fs.writeFileSync(path.join(dir, 'runs.json'), runs)
  const archive = path.join(dir, 'archive', 'lead.jsonl')
  check(!fs.existsSync(archive) && pad.length > 0, 'nothing archived from the Lead thread yet')
  const w2 = await world('load-archive-2', { repo: w.repo, data: w.data, clock: manualClock(w.clock.now + 30_000), noTeam: true, teamId: w.teamId })
  const held = w2.agent('lead')
  check(held.takeover?.phase === 'bindPending' && held.status === 'takenOver', 'at load the stopping takeover holds the Lead session', held.takeover)
  check(w2.rt().approvals.find((a) => a.id === ap.id)?.decider === 'user', 'its small plan goes to the user at load')
  check(w2.logs.some((l) => l.includes('at load') && l.includes(`escalated=${ap.id}`)), 'escalated by the load step')
  const thread = w2.rt().comments.lead
  check(thread.length === M.TASK_COMMENTS_MAX && thread.some((c) => c.sys?.key === 'leadEscalation' && c.sys.vars?.taskId === ap.taskId) && !thread.some((c) => c.id === pad[0].id), 'the full Lead thread takes the leadEscalation note and drops its oldest comment', thread.length)
  const archived = fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  same(archived.map((c) => [c.id, c.text]), [[pad[0].id, pad[0].text]], 'that comment goes to archive/lead.jsonl (never cut)')
  w2.svc.dispose()
}

async function main() {
  // The service's own waits are unref'ed timers (the app keeps its loop alive): one ref'ed timer holds this suite's.
  const keepAlive = setTimeout(() => undefined, 10 * 60_000)
  try {
    reducerChecks()
    leadHoldChecks()
    await takeoverChecks()
    await releaseCornerChecks()
    await leadEscalationChecks()
    await leadRunEscalationChecks()
    await stateChecks()
    await movedConsoleChecks()
    await orphanCardChecks()
    await loadArchiveChecks()
    console.log(`PASS: ${checks} teams takeover checks (K1..K7 reducers on frozen runtimes and their invariants, queued and starting runs, Codex before thread.started, the load fix, give back, the takeover run-end policy, the grant workspace; the service: K1 + K2 on a real run, the grant fields, double click and stopping refusals, no card, the dispatcher holding a taken-over agent, takeoverBound validated in main and confirmed by a late config save, a status or a spawn, the views, release busy and kill rules, closed by hand, renderer reload, bind: deadline, restart, releasing at load, Labs off zero keys and on again, ownsSession; the Lead's small plans to the user on its takeover, the release busy details, the reconcile console ranking; the B9 review: K6 on a console moved to another workspace whose home was deleted and the bound workspace following it, an orphan card the takeover's own check dismissed kept dismissed, the load's escalation archiving the oldest comment of a full Lead thread)`)
  } finally {
    clearTimeout(keepAlive)
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
