// Integrar (app 2.7.0, E10 B6, design 3.7, 4.2 T13 to T15 and 6.1). Pure: verifyDetect (suggestVerify order and
// variants, verifyCommandOk), the flow/integrate reducers (begin, step, T13 closing the task's approvals and cards, T14,
// T15 askRebase with its rebaseConflict and rebaseVerify sys comments, interrupted at load, confirmVerify, the worktree
// removed) under assertInvariants, the merge message, the overwritten-file list, the preflight rules, the verify env and
// GitExecError.exitCode / .stdout. Real git in temp repos with an isolated config (GIT_CONFIG_GLOBAL and
// GIT_CONFIG_SYSTEM empty files, GIT_CONFIG_NOSYSTEM, the identity per repo), core.autocrlf false and true, through the
// real WorktreeService on a temp manifest: the ff-only land, the CAS update-ref land, base_moved (update-ref and ff-only),
// merge_conflict with its files and the merge aborted, a merge failure with no unmerged path (git_error), base_dirty
// (a tracked edit, and an untracked file the ff would overwrite, with the file), base_busy (a console writing there,
// another lock holder), base_checked_out_elsewhere, verify_failed and verify_timeout with the tail (the grandchild
// killed too), alreadyMerged, no_identity, the repo hooks never run (a failing commit-msg and pre-merge-commit, a
// post-merge and a post-checkout that would write a sentinel), the progress events, the node_modules junction left
// whole, the locks released, one integrate per repo (a second task waits) while another repo runs alongside, verify
// logs pruned past the age and the size cap, the sweep of leftovers. After EVERY failure the user's HEAD, branch,
// index and status --porcelain are byte identical. Through TeamService: preview, the unconfirmed verify skipped,
// confirmVerify (only the trusted command), integrate to done with the notice, closeTaskNeeds and the progress of its
// integrationId, removeWorktree (and its refusals), askRebase both ways, a quit mid-integrate interrupted at load,
// an integrate in flight across a Labs toggle written to disk and never interrupted, remove refused while one runs, the
// sweep at enable, the phone refused. B6 integration: verifyInstalls and no node_modules junction for an installing
// verify, the verify runner resolved at its exit plus a 2 s drain (a grandchild holding stdout) and killAll, halt, the
// 10 minute ff-only land, base_dirty files (50 and filesMore), setupProbe.suggestedVerify, payload.ahead and the live
// tree of the task op cached per tip (no git per board), shutdownSync and prepareInstall killing the verify (interrupted,
// counted by the close confirm). Second round: on Windows the direct children of the dead verify shell tree-killed after
// the drain (a real `start /b ping -t` gone; a deeper one let go, never its conhost.exe killed in its place; the seam on
// every platform), prepareInstall waiting for a land already running to its end commit (with the installWait notice)
// and never for a verify, and the live reads of the task and needs ops answering at once from the cache with both git
// slots held, one tree at a time (four integrate rows of one needs op all counted). B6 review: an ignored file of the
// user the branch tracks and an ignored folder where it adds a file are base_dirty in the preview and the land (both
// autocrlf values, the content untouched), git's own refusal with --no-overwrite-ignore for one that appears after the
// check (the folder phrase too), untracked and ignored files out of the way never block; the runner's verifyNote on the
// result and the progress, never in the tail (left stopped or let go, timeout kill, spawn failed); the probe window
// ending at the exit (a reused pid's children never killed); killAll in the drain after the exit stops the leftovers at
// once (a real `start /b ping` too) and never twice; branchLoses keeps the branch on a timeout or a transient error;
// the end commit of an integrate reaches state.json when an enable failed to load its team. B6 review, second round:
// T14 stores the verifyNote and, for a failure at step land, its mode (ffOnly or updateRef, on the result and the failed
// land event; none for a land refused before its mode is known), the integrate approval view's lastStep and lastLanding,
// the rebaseVerify comment with the runner's English words (a verify that could not start), and through the service a
// spawnFailed verify and an ffOnly land timeout stored, in the drawer and in Te necesita. Same esbuild + vm harness as
// test-teams-runner.cjs; never a real agent.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-integrate-'))
const electronStub = { app: { getPath: (name) => (name === 'userData' ? path.join(TMP, 'ud') : TMP), isPackaged: false, commandLine: { hasSwitch: () => false } } }
function loadEntry(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (id) => (id === 'electron' ? electronStub : require(id)), console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, TextEncoder, TextDecoder })
  return mod.exports
}

const M = loadEntry(`
export { Integrator, createVerifyRunner, integrateHolder, mergeMessage, overwrittenFiles, preflightError, pruneLogDir, verifyEnv, VERIFY_LOG_RE, VERIFY_EXIT_DRAIN_MS, VERIFY_KILL_DRAIN_MS, INTEGRATE_LAND_TIMEOUT_MS, INTEGRATE_GIT_TIMEOUT_MS } from './src/main/teams/Integrator'
export * as F from './src/main/teams/flow/integrate'
export { suggestVerify, verifyCommandOk, verifyInstalls, VERIFY_COMMAND_MAX } from './src/shared/verifyDetect'
export { createGitRunner, gitEnv, gitExitCode } from './src/main/git/gitExec'
export { WorktreeService, linkNodeModules } from './src/main/git/WorktreeService'
export { WorktreeManifest } from './src/main/git/WorktreeManifest'
export { WriteLocks } from './src/main/teams/WriteLocks'
export { safeRemoveTree } from './src/main/migration/safeRemove'
export { treeKillSync, pidAlive, childrenSince, CREATION_CLOCK_SLACK_MS } from './src/main/proc/treeKill'
export { TeamService } from './src/main/teams/TeamService'
export { TeamDefinitionLoader } from './src/main/teams/TeamDefinitionLoader'
export { emptyRuntime, teamWorktreeOwner } from './src/shared/teams'
export { assertInvariants } from './src/main/teams/flow/invariants'
export { openSystemCard } from './src/main/teams/flow/agents'
export { approvalView } from './src/main/teams/views'
export { LEGACY_BRAND } from './src/shared/brand'
export { mainTLang } from './src/main/i18n'
`)
const F = M.F
const WIN = process.platform === 'win32'
const NODE = JSON.stringify(process.execPath)

const until = async (fn, ms = 20000, label = 'condition') => {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ---- 1. pure: verifyDetect -------------------------------------------------------------------------
function verifyDetectChecks() {
  const all = M.suggestVerify({ rootFiles: ['pom.xml', 'package.json', 'Cargo.toml', 'go.mod', 'App.sln', 'Makefile', 'pyproject.toml', 'gradlew', 'build.gradle', 'README.md'], npmScripts: ['test', 'build', 'lint'] })
  same(all.map((s) => s.command), ['mvn -q package', './gradlew test', 'npm test', 'npm run build', 'cargo test', 'go test ./...', 'dotnet test', 'make test', 'python -m pytest'], 'suggestVerify: the design order, every source')
  same(all.map((s) => s.source), ['maven', 'gradle', 'npm', 'npm', 'cargo', 'go', 'dotnet', 'make', 'python'], 'suggestVerify: the source of each')
  same(M.suggestVerify({ rootFiles: ['gradlew.bat', 'gradlew'], windows: true }).map((s) => s.command), ['gradlew test'], 'Windows: the wrapper without ./ (cmd.exe looks in the current folder)')
  same(M.suggestVerify({ rootFiles: ['build.gradle.kts'] }).map((s) => s.command), ['gradle test'], 'Gradle without a wrapper: gradle test')
  same(M.suggestVerify({ rootFiles: ['package.json'], npmScripts: ['lint', 'start'] }), [], 'a package.json with neither test nor build suggests nothing')
  same(M.suggestVerify({ rootFiles: ['package.json'] }).map((s) => s.command), ['npm test'], 'unknown scripts: npm test')
  same(M.suggestVerify({ rootFiles: ['package.json'], npmScripts: ['build'] }).map((s) => s.command), ['npm run build'], 'only a build script: npm run build')
  same(M.suggestVerify({ rootFiles: ['POM.XML', 'web.csproj', 'gnumakefile'] }).map((s) => s.source), ['maven', 'dotnet', 'make'], 'root names compared without case')
  same(M.suggestVerify({ rootFiles: [] }), [], 'an empty root suggests nothing')
  check(M.verifyCommandOk('npm test') && M.verifyCommandOk('x'.repeat(M.VERIFY_COMMAND_MAX)) && M.verifyCommandOk(`${NODE} verify.js`), 'verifyCommandOk: one line within the cap')
  check(!['', ' npm test', 'npm test ', 'npm\ntest', 'npm\ttest', 'x'.repeat(M.VERIFY_COMMAND_MAX + 1), 'npm\u202etest', 'npm\u200btest', 'npm\u2028test', 'npm\ufefftest', 'npm\u0085test', 42, null].some((c) => M.verifyCommandOk(c)), 'verifyCommandOk refuses blanks, padding, control, bidi and invisible characters, the cap, non strings')
  // B6 integration, data safety: a verify that installs dependencies gets no node_modules junction.
  const installs = [
    'npm ci', 'npm install', 'npm i', 'pnpm install', 'pnpm i', 'yarn install', 'yarn', 'bun install', 'pip install -r requirements.txt',
    'npm ci && npm test', 'npm --silent ci', 'C:\\tools\\npm.cmd install', 'NPM CI', 'yarn --frozen-lockfile && yarn test', 'npm run build; yarn',
    'cd web && npm install && npm run build', 'sh -c "npm ci"', 'corepack pnpm i', 'python -m pip install -e .', 'pip3 install x', 'npm clean-install', 'npm update', 'pnpm add left-pad', 'bun add x',
  ]
  const missed = installs.filter((c) => !M.verifyInstalls(c))
  same(missed, [], 'verifyInstalls: npm ci/install/i, pnpm install/i, yarn install and plain yarn, bun install, pip install, in any segment, behind a wrapper or a quote')
  const plain = ['npm test', 'npm run build', 'npm run install-deps', 'yarn test', 'yarn build', 'yarn run lint', 'pnpm test', 'bun test', 'mvn -q package', './gradlew test', 'gradlew test', 'cargo test', 'go test ./...', 'dotnet test', 'make test', 'python -m pytest', 'npx tsc --noEmit', `${NODE} verify.js`, '', 42, null]
  same(plain.filter((c) => M.verifyInstalls(c)), [], 'verifyInstalls: every other verify (tests, builds, the suggestions) keeps the junction')
  // A flag's value is never the verb: a workspace install of a monorepo reaches the root node_modules (the junction).
  const valued = ['npm -w web install', 'npm --workspace web ci', 'npm --prefix web ci', 'pnpm -C web i', 'pnpm --filter app install', 'pnpm -F app add x', 'yarn --cwd web', 'yarn --cwd web install', 'yarn workspace web add left-pad', 'bun --cwd web install', 'yarn --cwd && npm ci']
  same(valued.filter((c) => !M.verifyInstalls(c)), [], 'verifyInstalls: the value of -w, --prefix, -C, --filter or --cwd is never the verb; yarn workspace <name> <verb>')
  const valuedPlain = ['npm -w web test', 'pnpm -C web test', 'pnpm --filter app build', 'yarn --cwd web test', 'yarn workspace web build', 'bun --cwd web test']
  same(valuedPlain.filter((c) => M.verifyInstalls(c)), [], 'verifyInstalls: the same flags before a test or a build keep the junction')
}

// ---- 2. pure: the reducers ----------------------------------------------------------------------------
const NOW = 1_900_000_000_000
const TEAM = 'tm-0123456789ab'
const GEN = 'abcd1234'
const USER = { kind: 'user', via: 'desktop' }
function rtFixture() {
  const rt = M.emptyRuntime(TEAM, GEN)
  const agent = (id, roleKind) => ({ id, roleId: id, roleKind, provider: 'claude', status: 'idle', paused: false, sessions: {}, interrupts: 0 })
  rt.agents = [agent('lead', 'lead'), agent('dev', 'dev')]
  const wt = { path: 'C:/data/worktrees/repo-1/t-012345-1', branch: 'sn/t-012345-1', base: 'a'.repeat(40), baseBranch: 'main', slug: 't-012345-1', createdAt: NOW, owner: M.teamWorktreeOwner(TEAM, GEN, 't-1') }
  rt.tasks = [{
    id: 't-1', rev: 3, title: 'Login', body: '', state: 'review', phase: 'integrating', priority: 'normal', assignee: 'dev', repoId: 'main', isolation: 'worktree', needsPlan: true, frozen: true, worktree: wt,
    blockedBy: [], createdBy: USER, createdAt: NOW, updatedAt: NOW, stateSince: NOW, plan: { rev: 1, text: 'p', status: 'approved', small: false, at: NOW },
    review: { round: 1, max: 3, lastVerdict: 'approve' }, userOwned: [], counters: { noProgress: 0, continuations: 0, retries: 0, interrupts: 0, unblockWakes: 0, unblockWindowStart: 0 },
  }]
  const ap = (id, kind, state, payload) => ({ id, taskId: 't-1', state, decider: 'user', createdAt: NOW, createdBy: { kind: 'system' }, kind, payload, ...(state !== 'pending' ? { decidedAt: NOW, decidedBy: USER } : {}) })
  rt.approvals = [
    ap('a-1', 'final', 'approved', { hasWorktree: true, summary: 'ok' }),
    ap('a-2', 'integrate', 'pending', { branch: wt.branch, base: 'main' }),
    ap('a-3', 'permission', 'pending', { roleId: 'dev', runId: 'r-0123456789ab', tools: ['Bash(npm test:*)'] }),
  ]
  rt.cards = [
    { id: 'k-1', taskId: 't-1', kind: 'confirm', question: '', options: [], multi: false, state: 'open', from: { kind: 'system', why: 'failure', actions: ['dismiss'] }, createdAt: NOW },
    { id: 'k-2', taskId: 't-1', kind: 'confirm', question: '', options: [], multi: false, state: 'open', from: { kind: 'system', why: 'orphan', actions: ['killOrphan', 'dismiss'] }, createdAt: NOW },
  ]
  rt.queue = [{ id: 'q-1', agentId: 'dev', taskId: 't-1', sessionKey: 't-1', mode: 'exec', reason: 'comment', createdAt: NOW }]
  rt.nextIds = { task: 2, comment: 1, approval: 4, card: 3, queue: 2 }
  return rt
}
const inv = (rt, label) => same(M.assertInvariants(rt, null), [], `${label}: invariants hold`)

function reducerChecks() {
  const ctx = { now: NOW + 1000 }
  const rt0 = rtFixture()
  inv(rt0, 'fixture')
  const b = F.beginIntegrate(rt0, 't-1', ctx)
  check(b.ok && b.result.attempt === 1 && b.rt.tasks[0].integrate.state === 'running' && b.rt.tasks[0].integrate.step === 'preflight' && b.rt !== rt0 && rt0.tasks[0].integrate === undefined, 'beginIntegrate: attempt 1, running at preflight, copy on write')
  inv(b.rt, 'beginIntegrate')
  same(F.beginIntegrate(b.rt, 't-1', ctx), { ok: false, error: 'busy' }, 'a second begin while one runs: busy')
  same(F.beginIntegrate({ ...rt0, tasks: [{ ...rt0.tasks[0], state: 'done', phase: 'none' }] }, 't-1', ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'a task not in review/integrating: conflict stale')
  same(F.beginIntegrate({ ...rt0, activeRuns: [{ id: 'r-0123456789ab', taskId: 't-1' }] }, 't-1', ctx), { ok: false, error: 'busy' }, 'an active run of the task: busy')
  same(F.beginIntegrate(rt0, 't-9', ctx), { ok: false, error: 'not_found' }, 'unknown task: not_found')
  const st = F.integrateStep(b.rt, 't-1', 1, 'merge', ctx)
  check(st.ok && st.rt.tasks[0].integrate.step === 'merge', 'integrateStep records the step of its attempt')
  check(F.integrateStep(b.rt, 't-1', 2, 'merge', ctx).rt === b.rt, 'integrateStep of another attempt changes nothing (CAS)')

  // T13
  const okOut = { ok: true, mergeSha: 'B'.repeat(40), base: 'main', landed: 'ffOnly', mergeBase: 'c'.repeat(40) }
  same(F.endIntegrate(b.rt, 't-1', 2, okOut, USER, ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'endIntegrate of another attempt: conflict stale')
  const e = F.endIntegrate(b.rt, 't-1', 1, okOut, USER, ctx)
  const t = e.rt.tasks[0]
  check(e.ok && e.result.ok && t.state === 'done' && t.phase === 'none' && !t.integrate && !t.next && t.stateSince === ctx.now, 'T13: done/none, the integrate status gone')
  same(t.integrated, { mergeSha: 'b'.repeat(40), base: 'main', at: ctx.now, landed: 'ffOnly' }, 'T13: integrated {mergeSha, base, at, landed}')
  check(t.worktree.base === 'c'.repeat(40) && t.worktree.path === rt0.tasks[0].worktree.path, 'the worktree stays (for removeWorktree) with its base at the merge base read')
  const byId = (list, id) => list.find((x) => x.id === id)
  check(byId(e.rt.approvals, 'a-2').state === 'approved' && byId(e.rt.approvals, 'a-2').decidedBy.kind === 'user', 'T13: the integrate approval approved by the user who clicked')
  check(byId(e.rt.approvals, 'a-3').state === 'cancelled' && byId(e.rt.approvals, 'a-1').state === 'approved', 'closeTaskNeeds: another pending approval of the task cancelled, the final kept')
  check(byId(e.rt.cards, 'k-1').state === 'dismissed' && byId(e.rt.cards, 'k-2').state === 'open' && e.rt.queue.length === 0, 'closeTaskNeeds: its cards dismissed (the orphan one stays, decision 64), its queue items gone')
  check(e.effects.some((x) => x.kind === 'dispatch'), 'T13 pokes the dispatcher (a task blocked by it)')
  inv(e.rt, 'T13')
  // T14
  const f = F.endIntegrate(b.rt, 't-1', 1, { ok: false, error: 'merge_conflict', step: 'merge', files: ['a.txt', 'b.txt'], mergeBase: 'd'.repeat(40) }, USER, ctx)
  const ft = f.rt.tasks[0]
  check(f.ok && !f.result.ok && ft.state === 'review' && ft.phase === 'integrating' && ft.integrate.state === 'failed' && ft.integrate.error === 'merge_conflict' && ft.integrate.step === 'merge' && ft.integrate.attempt === 1, 'T14: failed with its error and step, still in review/integrating')
  same(ft.integrate.files, ['a.txt', 'b.txt'], 'T14: the conflicting files kept')
  check(byId(f.rt.approvals, 'a-2').state === 'pending' && ft.worktree.base === 'd'.repeat(40), 'T14: the integrate approval still waits; the worktree base follows the merge base')
  inv(f.rt, 'T14')
  const many = F.endIntegrate(b.rt, 't-1', 1, { ok: false, error: 'verify_failed', step: 'verify', tail: 'x'.repeat(F.INTEGRATE_TAIL_MAX + 50), files: Array.from({ length: F.INTEGRATE_FILES_MAX + 5 }, (_, i) => `f${i}`) }, USER, ctx)
  check(many.rt.tasks[0].integrate.tail.length === F.INTEGRATE_TAIL_MAX && many.rt.tasks[0].integrate.files.length === F.INTEGRATE_FILES_MAX, 'T14 caps the tail and the files')
  // B6 review, second round: T14 keeps the runner's note and, for a failure at step land, the land mode.
  const sf = F.endIntegrate(b.rt, 't-1', 1, { ok: false, error: 'verify_failed', step: 'verify', verifyNote: 'spawnFailed', landing: 'ffOnly' }, USER, ctx)
  same(sf.rt.tasks[0].integrate, { state: 'failed', attempt: 1, error: 'verify_failed', step: 'verify', verifyNote: 'spawnFailed', at: ctx.now }, 'T14 stores the verifyNote; a land mode only for a failure at step land')
  const lf = F.endIntegrate(b.rt, 't-1', 1, { ok: false, error: 'timeout', step: 'land', verifyNote: 'leftStopped', landing: 'ffOnly' }, USER, ctx)
  same(lf.rt.tasks[0].integrate, { state: 'failed', attempt: 1, error: 'timeout', step: 'land', verifyNote: 'leftStopped', landing: 'ffOnly', at: ctx.now }, 'T14 at step land: the step, the land mode and the note of the verify before it')
  inv(lf.rt, 'T14 land')
  const ur = F.endIntegrate(b.rt, 't-1', 1, { ok: false, error: 'timeout', step: 'land', landing: 'updateRef' }, USER, ctx)
  check(ur.rt.tasks[0].integrate.landing === 'updateRef' && !('verifyNote' in ur.rt.tasks[0].integrate), 'T14: an updateRef land kept, no note when the runner had none')
  const odd = F.endIntegrate(b.rt, 't-1', 1, { ok: false, error: 'timeout', step: 'land', verifyNote: '[killed at the timeout]', landing: 'alreadyMerged' }, USER, ctx)
  check(!('verifyNote' in odd.rt.tasks[0].integrate) && !('landing' in odd.rt.tasks[0].integrate), 'T14 never stores a note or a land mode it does not know')
  // The integrate approval view (Te necesita, the drawer) names where the last attempt failed and how it was landing.
  const apView = (rt) => M.approvalView(rt, rt.approvals.find((a) => a.id === 'a-2'), null).payload
  const branch = rt0.tasks[0].worktree.branch
  same(apView(lf.rt), { kind: 'integrate', branch, base: 'main', lastError: 'timeout', lastStep: 'land', lastLanding: 'ffOnly' }, 'the integrate approval view: lastError, lastStep and lastLanding of a land timeout')
  same(apView(ur.rt), { kind: 'integrate', branch, base: 'main', lastError: 'timeout', lastStep: 'land', lastLanding: 'updateRef' }, 'the integrate approval view: an updateRef land')
  same(apView(f.rt), { kind: 'integrate', branch, base: 'main', lastError: 'merge_conflict', lastStep: 'merge' }, 'the integrate approval view: a failure before the land has no lastLanding')
  same(apView(b.rt), { kind: 'integrate', branch, base: 'main' }, 'the integrate approval view of an attempt in flight: no last failure')
  const legacy = { ...lf.rt, tasks: [{ ...lf.rt.tasks[0], integrate: { state: 'failed', attempt: 1, error: 'timeout', at: NOW } }] }
  same(apView(legacy), { kind: 'integrate', branch, base: 'main', lastError: 'timeout' }, 'a failure stored without its step (an earlier build): lastError alone')

  // T15
  same(F.askRebase(f.rt, 't-1', 'verify', USER, ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'askRebase verify after a conflict: stale')
  same(F.askRebase(b.rt, 't-1', 'conflict', USER, ctx), { ok: false, error: 'busy' }, 'askRebase while the integrate runs: busy')
  same(F.askRebase(rt0, 't-1', 'conflict', USER, ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'askRebase with no failed integrate: stale')
  const r = F.askRebase(f.rt, 't-1', 'conflict', USER, ctx)
  const rtk = r.rt.tasks[0]
  check(r.ok && rtk.state === 'doing' && rtk.phase === 'executing' && !rtk.integrate, 'T15: back to doing/executing, the failed integrate gone')
  same(rtk.next, { agentId: 'dev', mode: 'exec', reason: 'rebase', since: ctx.now, bypassCooldown: true }, 'T15: a rebase wake of the assignee exec')
  check(byId(r.rt.approvals, 'a-2').state === 'cancelled' && rtk.review.round === 1, 'T15: the integrate approval cancelled, no round++')
  const c = r.rt.comments['t-1'][0]
  same({ kind: c.kind, author: c.author, text: c.text, sys: c.sys, forAgent: c.forAgent }, { kind: 'system', author: { kind: 'system' }, text: '', sys: { key: 'rebaseConflict', vars: { files: 'a.txt, b.txt' } }, forAgent: 'dev' }, 'T15: the rebaseConflict sys comment names the files, for the Dev')
  check(r.effects.some((x) => x.kind === 'dispatch'), 'T15 pokes the dispatcher')
  inv(r.rt, 'T15 conflict')
  const lots = F.endIntegrate(b.rt, 't-1', 1, { ok: false, error: 'merge_conflict', step: 'merge', files: Array.from({ length: 25 }, (_, i) => `f${i}.txt`) }, USER, ctx)
  const lr = F.askRebase(lots.rt, 't-1', 'conflict', USER, ctx)
  check(lr.rt.comments['t-1'][0].sys.vars.files.endsWith('f19.txt +5') && lr.rt.comments['t-1'][0].sys.vars.files.startsWith('f0.txt, f1.txt'), 'rebaseConflict names the first 20 files then +N')
  const vf = F.endIntegrate(b.rt, 't-1', 1, { ok: false, error: 'verify_timeout', step: 'verify', tail: `${'y'.repeat(3000)}\nboom at the end` }, USER, ctx)
  same(F.askRebase(vf.rt, 't-1', 'conflict', USER, ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'askRebase conflict after a verify failure: stale')
  const vr = F.askRebase(vf.rt, 't-1', 'verify', USER, ctx)
  const vc = vr.rt.comments['t-1'][0]
  check(vr.ok && vc.sys.key === 'rebaseVerify' && vc.sys.vars.tail.startsWith('...') && vc.sys.vars.tail.endsWith('boom at the end') && vc.sys.vars.tail.length === F.REBASE_TAIL_SHOWN + 3, 'T15 verify: the rebaseVerify sys comment carries the end of the tail')
  inv(vr.rt, 'T15 verify')
  // B6 review, second round: the runner's own English words reach the Dev (the tail is only what the command printed):
  // a command that could not start (no tail at all), a tail without the runner line, one that already has it.
  const rebaseTail = (out) => F.askRebase(F.endIntegrate(b.rt, 't-1', 1, { ok: false, step: 'verify', ...out }, USER, ctx).rt, 't-1', 'verify', USER, ctx).rt.comments['t-1'][0].sys.vars.tail
  check(rebaseTail({ error: 'verify_failed', verifyNote: 'spawnFailed' }) === `[${F.VERIFY_NOTE_EN.spawnFailed}]` && F.VERIFY_NOTE_EN.spawnFailed === 'the verify command could not start', 'rebaseVerify of a verify that could not start: the runner words, never an empty tail')
  check(rebaseTail({ error: 'verify_timeout', tail: 'npm test\nstill running', verifyNote: 'timeoutKill' }) === 'npm test\nstill running\n[killed at the timeout]', 'rebaseVerify: a tail with no runner line gets it after the output')
  check(rebaseTail({ error: 'verify_failed', tail: 'boom\n[a process the command left running still held its output: it was let go]', verifyNote: 'leftLetGo' }) === 'boom\n[a process the command left running still held its output: it was let go]', 'rebaseVerify: a tail that already has the runner line is not repeated')
  check(rebaseTail({ error: 'verify_failed', tail: 'boom' }) === 'boom', 'rebaseVerify with no note: the tail as is')

  // Load, confirm, removed.
  const it = F.interruptedIntegrates(b.rt, () => false, ctx)
  check(it.ok && it.result.taskIds[0] === 't-1' && it.rt.tasks[0].integrate.state === 'failed' && it.rt.tasks[0].integrate.error === 'interrupted', 'interruptedIntegrates: a running integrate no process runs is failed interrupted')
  check(F.interruptedIntegrates(b.rt, (id) => id === 't-1', ctx).rt === b.rt && F.interruptedIntegrates(rt0, () => false, ctx).rt === rt0, 'one in flight in this app, or none running: unchanged')
  const cv = F.confirmVerify(rt0, 'main', 'npm test', 'e'.repeat(64), ctx)
  same(cv.rt.verifyConfirmed.main, { command: 'npm test', sha256: 'e'.repeat(64), at: ctx.now }, 'confirmVerify records the command and its sha256')
  check(F.confirmVerify(cv.rt, 'main', 'npm test', 'e'.repeat(64), ctx).rt === cv.rt, 'the same confirmation again changes nothing')
  same(F.worktreeRemoved(e.rt, 't-1', 'C:/other', ctx), { ok: false, error: 'conflict', reason: 'stale' }, 'worktreeRemoved CAS on the path')
  const wr = F.worktreeRemoved(e.rt, 't-1', t.worktree.path, ctx)
  check(wr.ok && wr.rt.tasks[0].worktree === undefined && wr.rt.tasks[0].frozen === true, 'worktreeRemoved: the task forgets its tree (frozen stays)')
  inv(wr.rt, 'worktreeRemoved')
}

// ---- 3. pure: Integrator helpers ---------------------------------------------------------------------------
function helperChecks() {
  const msg = M.mergeMessage('sn/t-012345-1', `Login\ncon "comillas" & más ${'x'.repeat(200)}`, 't-1')
  check(msg.startsWith('Merge sn/t-012345-1: Login con "comillas" & más ') && msg.endsWith('... (t-1)\n') && msg.split('\n').length === 2, `the merge message: one line, the title cut (${msg.length})`)
  check(M.mergeMessage('sn/a', 'Short', 't-2') === 'Merge sn/a: Short (t-2)\n', 'a short title as is')
  const err = 'error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt\n\tdir/\u00f1.txt\nPlease move or remove them before you merge.\nAborting\n'
  same(M.overwrittenFiles(err), ['new.txt', 'dir/\u00f1.txt'], 'overwrittenFiles reads the tab-indented list')
  same(M.overwrittenFiles('error: Your local changes to the following files would be overwritten by merge:\r\n\ta.txt\r\nPlease commit'), ['a.txt'], 'and the tracked variant, CRLF too')
  same(M.overwrittenFiles('error: Updating the following directories would lose untracked files in them:\n\tbuild\n\nAborting\n'), ['build'], 'and the folder a merge would turn into a file (B6 review)')
  const ok = { exists: true, dirtyFiles: 0, commitsAhead: 1, mergedIntoHead: false, headBranch: 'sn/x', tip: 'a'.repeat(40) }
  check(M.preflightError(ok, 'sn/x') === null, 'preflight: a clean tree on its branch passes')
  same([
    M.preflightError({ ...ok, exists: false }, 'sn/x'), M.preflightError({ ...ok, noCheckout: true, incomplete: true }, 'sn/x'), M.preflightError({ ...ok, inProgress: 'rebase' }, 'sn/x'),
    M.preflightError({ ...ok, dirtyFiles: 2 }, 'sn/x'), M.preflightError({ ...ok, headBranch: '' }, 'sn/x'), M.preflightError({ ...ok, headBranch: 'sn/y' }, 'sn/x'), M.preflightError({ ...ok, incomplete: true }, 'sn/x'),
  ], ['missing_worktree', 'missing_worktree', 'in_progress', 'dirty_worktree', 'wrong_branch', 'wrong_branch', 'git_error'], 'preflight errors in order')
  const env = M.verifyEnv({ PATH: 'p', SNAOS_CTL_TOKEN: 't', snaos_team_run: 'r', [`${M.LEGACY_BRAND.envPrefix}X`]: 'x', GIT_DIR: 'g', git_work_tree: 'w', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' })
  same(env, { PATH: 'p', HOME: 'h' }, 'verifyEnv: no SNAOS_ (any case), no legacy prefix, no GIT_DIR or work tree override, no Electron node mode')
  check(M.integrateHolder(TEAM, 't-1') === `integrate:${TEAM}:t-1`, 'the holder names the team (two teams may both have a t-1)')
}

// ---- 4. real git -------------------------------------------------------------------------------------------
const gitCfg = path.join(TMP, 'gitconfig')
// Both config files empty (requirement 4 of B6); every repo is made with `init -b main` and sets its own identity.
fs.writeFileSync(gitCfg, '')
const gitSysCfg = path.join(TMP, 'gitconfig-system')
fs.writeFileSync(gitSysCfg, '')
const gitEnvVars = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitCfg, GIT_CONFIG_SYSTEM: gitSysCfg }
// No identity from the env (the no_identity case reads only the repo config; every other repo sets its own).
for (const k of Object.keys(gitEnvVars)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_[A-Z]+|COMMITTER_[A-Z]+)$/i.test(k)) delete gitEnvVars[k]
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, env: gitEnvVars, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const gitTry = (cwd, ...args) => { try { return git(cwd, ...args) } catch { return null } }
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@x']
const runner = M.createGitRunner({ env: () => M.gitEnv(gitEnvVars) })
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const real = (p) => fs.realpathSync.native(p)

const OK_JS = "const fs = require('fs')\nconst keys = Object.keys(process.env).filter((k) => k.toUpperCase().startsWith('SNAOS_'))\nconsole.log('verify env snaos=' + keys.length)\nif (fs.existsSync('FAIL')) { console.error('boom: ' + fs.readFileSync('FAIL', 'utf8').trim()); process.exit(2) }\nif (fs.existsSync('WAIT')) {\n  const flag = fs.readFileSync('WAIT', 'utf8').trim()\n  fs.writeFileSync(flag + '.pid', String(process.pid))\n  const t = setInterval(() => { if (fs.existsSync(flag)) { clearInterval(t); console.log('released'); process.exit(0) } }, 50)\n} else {\n  console.log('line 1')\n  setTimeout(() => { console.log('line 2'); setTimeout(() => { console.log('verify ok'); process.exit(0) }, 350) }, 350)\n}\n"
const HANG_JS = "const cp = require('child_process')\nconst c = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })\nrequire('fs').writeFileSync(process.argv[2], String(c.pid))\nconsole.log('hanging')\nsetInterval(() => {}, 1000)\n"
// Exits 0 and leaves a grandchild holding its stdout (detached on Windows, where node's job would kill it with the
// parent; on POSIX it stays in the verify's process group).
const BG_JS = "const cp = require('child_process')\nconst c = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32', windowsHide: true })\nrequire('fs').writeFileSync(process.argv[2], String(c.pid))\nconsole.log('main done')\nsetTimeout(() => process.exit(0), 50)\n"
// An "install" that writes into node_modules: through a junction it would rewrite the repo's own.
const INSTALL_JS = "const fs = require('fs')\nconst link = (() => { try { return fs.lstatSync('node_modules').isSymbolicLink() } catch { return false } })()\nfs.mkdirSync('node_modules/pkg', { recursive: true })\nfs.writeFileSync('node_modules/pkg/sentinel.txt', 'rewritten by the install\\n')\nconsole.log('installed link=' + link)\n"
const PROBE_JS = "const fs = require('fs')\nconst link = (() => { try { return fs.lstatSync('node_modules').isSymbolicLink() } catch { return false } })()\nconsole.log('probe link=' + link + ' sentinel=' + fs.existsSync('node_modules/pkg/sentinel.txt'))\n"

function makeRepo(dir, o = {}) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  if (o.identity === false) git(dir, 'config', 'user.useConfigOnly', 'true')
  else { git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@x') }
  git(dir, 'config', 'core.autocrlf', o.autocrlf ? 'true' : 'false')
  write(path.join(dir, 'README.md'), '# r\n')
  write(path.join(dir, 'src', 'a.txt'), 'a\nb\nc\n')
  write(path.join(dir, 'conflict.txt'), 'base\n')
  write(path.join(dir, 'verify.js'), OK_JS)
  write(path.join(dir, 'hang.js'), HANG_JS)
  write(path.join(dir, 'install.js'), INSTALL_JS)
  write(path.join(dir, 'probe.js'), PROBE_JS)
  write(path.join(dir, '.gitignore'), 'node_modules/\n')
  // The repo's node_modules: the temp tree links it (a junction) and the cleanup must never enter it.
  write(path.join(dir, 'node_modules', 'pkg', 'sentinel.txt'), 'keep me\n')
  git(dir, 'add', '-A')
  git(dir, ...ID, 'commit', '-qm', 'init')
  return real(dir)
}

/** HEAD, branch, index and status of the user's checkout (and the base ref), compared byte for byte after a failure. */
function snap(repo) {
  return { head: git(repo, 'rev-parse', 'HEAD'), sym: gitTry(repo, 'symbolic-ref', '-q', 'HEAD') ?? '', index: git(repo, 'ls-files', '-s'), status: git(repo, 'status', '--porcelain'), main: git(repo, 'rev-parse', 'refs/heads/main') }
}

const realVerify = M.createVerifyRunner({ env: () => ({ ...process.env }), treeKill: (pid) => M.treeKillSync(pid), platform: process.platform })

let kitSeq = 0
function makeKit(name, o = {}) {
  const dir = path.join(TMP, `${name}-${++kitSeq}`)
  const repo = makeRepo(path.join(dir, 'repo'), o)
  const data = path.join(dir, 'data')
  const manifest = new M.WorktreeManifest(path.join(data, 'worktrees.json'))
  const wtRoot = path.join(data, 'worktrees')
  const wts = new M.WorktreeService({ runner, manifest, root: () => wtRoot, defaultRoot: () => wtRoot, removeOptions: { delayMs: 0, retries: 1 } })
  const kit = { dir, repo, data, wts, humans: [], events: [], logs: [], verifyImpl: null, n: 0 }
  kit.locks = o.locks ?? new M.WriteLocks({ platform: process.platform, humanWriters: () => kit.humans })
  kit.integrateDir = path.join(data, 'teams', TEAM, 'integrate')
  kit.verifyDir = path.join(data, 'teams', TEAM, 'verify')
  kit.integrator = o.integrator ?? new M.Integrator({
    git: o.git ?? runner, worktrees: wts, locks: kit.locks,
    integrateDir: (id) => path.join(data, 'teams', id, 'integrate'),
    verifyLogDir: (id) => path.join(data, 'teams', id, 'verify'),
    runVerify: (...a) => (kit.verifyImpl ?? realVerify)(...a),
    linkNodeModules: (r, p) => M.linkNodeModules(r, p),
    removeTree: (t, g, opt) => M.safeRemoveTree(t, g, opt),
    now: () => Date.now(),
    progress: (e) => kit.events.push(e),
    log: (l) => kit.logs.push(l),
  })
  kit.repoObj = { repoId: 'main', repoRoot: repo, baseBranch: 'main' }
  /** A task worktree from the tip of main with `edits` committed on its branch. */
  kit.task = async (edits, title = 'Agregar login') => {
    const n = ++kit.n
    const slug = `t-a1b2c3-${n}`
    const owner = M.teamWorktreeOwner(TEAM, GEN, `t-${n}`)
    const base = git(repo, 'rev-parse', 'refs/heads/main').trim()
    const res = await wts.create({ repoCwd: repo, slug, base, copyEnv: false, linkNodeModules: true }, { owner })
    assert.ok(res.ok, `worktree create: ${JSON.stringify(res)}`)
    for (const [f, text] of Object.entries(edits)) write(path.join(res.worktree.path, f), text)
    git(res.worktree.path, 'add', '-A')
    // --no-verify: the hooks case installs a failing commit-msg hook in the repo (worktrees share it).
    git(res.worktree.path, ...ID, 'commit', '--no-verify', '-qm', `work of t-${n}`)
    return { id: `t-${n}`, title, worktree: { path: res.worktree.path, branch: res.worktree.branch, base: res.worktree.base, baseBranch: 'main', slug, createdAt: 1, owner } }
  }
  kit.tip = (task) => git(repo, 'rev-parse', `refs/heads/${task.worktree.branch}`).trim()
  kit.run = (task, o2 = {}) => kit.integrator.integrate(TEAM, o2.repo ?? kit.repoObj, task, { expectTip: o2.expectTip ?? kit.tip(task), integrationId: o2.id ?? `i-${task.id}`, ...(o2.verify ? { verify: o2.verify } : {}) })
  kit.stepsOf = (id) => kit.events.filter((e) => e.integrationId === id).map((e) => `${e.step}:${e.state}`)
  kit.tempLeft = () => (fs.existsSync(kit.integrateDir) ? fs.readdirSync(kit.integrateDir) : [])
  kit.listed = () => git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length
  return kit
}

/** What every integrate leaves behind: no temp tree, no git record of one, the junction target whole, no lock. */
function cleanAfter(kit, label, worktrees) {
  same(kit.tempLeft(), [], `${label}: nothing left in integrate/`)
  check(kit.listed() === worktrees, `${label}: git lists no temp tree (${kit.listed()} worktrees)`)
  check(fs.readFileSync(path.join(kit.repo, 'node_modules', 'pkg', 'sentinel.txt'), 'utf8') === 'keep me\n', `${label}: the node_modules the temp tree linked is whole`)
  check(kit.locks.size === 0, `${label}: every lock released`)
}

async function failsIdentical(kit, task, label, o, want) {
  const before = snap(kit.repo)
  const res = await kit.run(task, o)
  check(!res.ok && res.error === want, `${label}: ${want} (${JSON.stringify(res).slice(0, 300)})`)
  same(snap(kit.repo), before, `${label}: the user's HEAD, branch, index and status are byte identical`)
  return res
}

async function integratorChecks(autocrlf) {
  const tag = `autocrlf=${autocrlf}`
  // ff-only land.
  {
    const kit = makeKit('ff', { autocrlf })
    const task = await kit.task({ 'src/login.txt': 'login\nlinea 2\n', 'src/a.txt': 'a\nb\nc\nd\n' }, 'Agregar login "rapido" & bien')
    const baseTip = git(kit.repo, 'rev-parse', 'main').trim()
    const tip = kit.tip(task)
    const prev = await kit.integrator.preview(TEAM, kit.repoObj, task, null, [{ command: 'npm test', source: 'npm' }])
    check(!prev.error && prev.tip === tip && prev.baseTip === baseTip && prev.ahead === 1 && prev.behind === 0 && !prev.alreadyMerged, `${tag} preview: tips and counts`)
    same(prev.landing, { mode: 'ffOnly' }, `${tag} preview: the main checkout on the base, clean: ff-only`)
    same(prev.verify, { suggested: 'npm test' }, `${tag} preview: no verify declared, the suggestion`)
    check(prev.stat.files === 2 && prev.stat.insertions === 3 && !prev.touchesDefinition, `${tag} preview: the diff stat, the definition untouched`)
    const res = await kit.run(task)
    check(res.ok && res.landed === 'ffOnly' && res.base === 'main' && /^[0-9a-f]{40}$/.test(res.mergeSha), `${tag} ff-only land (${JSON.stringify(res)})`)
    const head = git(kit.repo, 'rev-parse', 'HEAD').trim()
    const parents = git(kit.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')
    check(head === res.mergeSha && parents[1] === baseTip && parents[2] === tip, `${tag}: the merge commit on main has the base and the tip as parents`)
    check(git(kit.repo, 'log', '-1', '--format=%s').trim() === `Merge ${task.worktree.branch}: Agregar login "rapido" & bien (t-1)`, `${tag}: the merge message from the file`)
    check(git(kit.repo, 'status', '--porcelain') === '' && fs.readFileSync(path.join(kit.repo, 'src', 'login.txt'), 'utf8').startsWith('login'), `${tag}: the user's checkout is clean on the merge`)
    check(res.mergeBase === baseTip, `${tag}: the merge base read`)
    same(kit.stepsOf('i-t-1'), ['preflight:running', 'preflight:ok', 'temp:running', 'temp:ok', 'merge:running', 'merge:ok', 'verify:skipped', 'land:running', 'land:ok', 'cleanup:running', 'cleanup:ok'], `${tag}: the progress of every step`)
    const landEv = kit.events.find((e) => e.step === 'land' && e.state === 'ok')
    check(landEv.landing === 'ffOnly' && landEv.mergeSha === res.mergeSha && landEv.teamId === TEAM && landEv.taskId === 't-1', `${tag}: the land event names the landing and the merge`)
    cleanAfter(kit, `${tag} ff-only`, 2)
    // The same tip again: already in the base.
    const again = await kit.run(task, { id: 'i-again' })
    check(again.ok && again.landed === 'alreadyMerged' && again.mergeSha === tip, `${tag}: alreadyMerged when the tip is in the base`)
    same(kit.stepsOf('i-again'), ['preflight:running', 'preflight:ok', 'temp:skipped', 'merge:skipped', 'verify:skipped', 'land:ok', 'cleanup:skipped'], `${tag}: alreadyMerged builds nothing`)
    check((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).alreadyMerged, `${tag}: the preview says alreadyMerged`)
  }
  // CAS update-ref land: the base checked out nowhere.
  {
    const kit = makeKit('cas', { autocrlf })
    const task = await kit.task({ 'cas.txt': 'cas\n' })
    git(kit.repo, 'checkout', '-q', '-b', 'other')
    const prev = await kit.integrator.preview(TEAM, kit.repoObj, task, { command: 'npm test', confirmed: true }, [])
    same(prev.landing, { mode: 'updateRef' }, `${tag} preview: the base checked out nowhere: update-ref`)
    same(prev.verify, { command: 'npm test', confirmed: true }, `${tag} preview: the declared verify`)
    const before = snap(kit.repo)
    const res = await kit.run(task)
    check(res.ok && res.landed === 'updateRef' && git(kit.repo, 'rev-parse', 'refs/heads/main').trim() === res.mergeSha, `${tag}: CAS update-ref land`)
    same({ ...snap(kit.repo), main: before.main }, before, `${tag}: update-ref leaves the user's checkout (on another branch) as it was`)
    cleanAfter(kit, `${tag} update-ref`, 2)
    // base_moved: the base advances between the preview and the land (here: during the verify).
    const t2 = await kit.task({ 'cas2.txt': 'x\n' })
    let mid = null
    kit.verifyImpl = async () => {
      const tree = git(kit.repo, 'rev-parse', 'refs/heads/main^{tree}').trim()
      const moved = git(kit.repo, ...ID, 'commit-tree', tree, '-p', 'refs/heads/main', '-m', 'moved').trim()
      git(kit.repo, 'update-ref', 'refs/heads/main', moved)
      mid = snap(kit.repo)
      return { ok: true, timedOut: false, tail: '' }
    }
    const moved = await kit.run(t2, { verify: { command: 'x', timeoutMs: 5000 } })
    kit.verifyImpl = null
    check(!moved.ok && moved.error === 'base_moved' && moved.step === 'land', `${tag}: update-ref CAS "but expected" is base_moved`)
    const movedEv = kit.events.find((e) => e.integrationId === `i-${t2.id}` && e.step === 'land' && e.state === 'failed')
    check(moved.landing === 'updateRef' && movedEv?.landing === 'updateRef', `${tag}: the failed update-ref land names its mode on the result and the event (${JSON.stringify(movedEv)})`)
    same(snap(kit.repo), mid, `${tag} base_moved (update-ref): the user's HEAD, branch, index and status are byte identical`)
    cleanAfter(kit, `${tag} base_moved`, 3)
  }
  // Land A refusals and base_moved on the checkout.
  {
    const kit = makeKit('landA', { autocrlf })
    const task = await kit.task({ 'new.txt': 'from the branch\n', 'src/a.txt': 'a\nB\nc\n' })
    // base_dirty: a tracked edit.
    write(path.join(kit.repo, 'README.md'), '# r edited\n')
    same((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).landing, { blocked: 'base_dirty', files: ['README.md'] }, `${tag} preview: a dirty checkout blocks the landing and names its files`)
    const d = await failsIdentical(kit, task, `${tag} base_dirty`, {}, 'base_dirty')
    same(d.files, ['README.md'], `${tag} base_dirty names the file`)
    check(!('landing' in d), `${tag}: a land refused before its mode is known names no mode`)
    git(kit.repo, 'checkout', '--', 'README.md')
    // base_dirty: an untracked file the ff would overwrite (a clean status with --untracked-files=no). B6 review: the
    // preview says so too (what the branch adds, against the untracked and ignored files of the checkout).
    write(path.join(kit.repo, 'new.txt'), 'mine, untracked\n')
    same((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).landing, { blocked: 'base_dirty', files: ['new.txt'] }, `${tag} preview: an untracked file the merge adds blocks the landing and is named`)
    const u = await failsIdentical(kit, task, `${tag} untracked overwrite`, {}, 'base_dirty')
    same(u.files, ['new.txt'], `${tag}: the untracked file the ff-only would overwrite`)
    check(fs.readFileSync(path.join(kit.repo, 'new.txt'), 'utf8') === 'mine, untracked\n', `${tag}: the untracked file untouched`)
    fs.rmSync(path.join(kit.repo, 'new.txt'))
    // base_busy: a console writing in the repo, then another holder of the root lock.
    kit.humans = [kit.repo]
    same((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).landing, { blocked: 'base_busy' }, `${tag} preview: a console writing there: base_busy`)
    await failsIdentical(kit, task, `${tag} base_busy (console)`, {}, 'base_busy')
    kit.humans = []
    check(kit.locks.acquire(kit.locks.key(kit.repo), 'r-0123456789ab'), 'a run holds the repo root')
    await failsIdentical(kit, task, `${tag} base_busy (lock)`, {}, 'base_busy')
    check(kit.locks.holderOf(kit.locks.key(kit.repo)) === 'r-0123456789ab', `${tag}: the other holder keeps its lock`)
    kit.locks.release(kit.locks.key(kit.repo), 'r-0123456789ab')
    // base_moved on the checkout: the user commits on main during the verify.
    let mid = null
    kit.verifyImpl = async () => {
      write(path.join(kit.repo, 'user.txt'), 'user work\n')
      git(kit.repo, 'add', 'user.txt')
      git(kit.repo, ...ID, 'commit', '-qm', 'user commit')
      mid = snap(kit.repo)
      return { ok: true, timedOut: false, tail: '' }
    }
    const res = await kit.run(task, { verify: { command: 'x', timeoutMs: 5000 } })
    kit.verifyImpl = null
    check(!res.ok && res.error === 'base_moved' && res.landing === 'ffOnly', `${tag}: a commit on the checkout since the merge: base_moved, an ffOnly land`)
    same(snap(kit.repo), mid, `${tag} base_moved (ff-only): byte identical`)
    cleanAfter(kit, `${tag} land A refusals`, 2)
  }
  // B6 review (data safety): an ignored file of the user (a .env) the branch tracks, and an ignored folder where the
  // branch adds a file, are never replaced: the preview and the land's own check say base_dirty with them, and git's
  // own refusal (--no-overwrite-ignore) covers one that appears after that check.
  {
    const hooks = { beforeLand: null }
    const landGit = { run: (args, opts) => { if (args.includes('--ff-only') && hooks.beforeLand) { const f = hooks.beforeLand; hooks.beforeLand = null; f() } return runner.run(args, opts) }, info: (f) => runner.info(f), get running() { return runner.running } }
    const kit = makeKit('ignored', { autocrlf, git: landGit })
    write(path.join(kit.repo, '.gitignore'), 'node_modules/\nsecret.env\nbuild/\n')
    git(kit.repo, 'add', '.gitignore')
    git(kit.repo, ...ID, 'commit', '-qm', 'ignore secret.env and build/')
    // `build/` ignores a folder only: the branch's file named build is added as usual; secret.env is force-added.
    const task = await kit.task({ 'src/feature.txt': 'feature\n', build: 'a file named build\n' })
    write(path.join(task.worktree.path, 'secret.env'), 'from the branch\n')
    git(task.worktree.path, 'add', '-f', 'secret.env')
    git(task.worktree.path, ...ID, 'commit', '--no-verify', '-qm', 'force-add secret.env')
    const secret = path.join(kit.repo, 'secret.env')
    const outBin = path.join(kit.repo, 'build', 'out.bin')
    // The ignored file.
    write(secret, 'USER SECRET\n')
    check(git(kit.repo, 'status', '--porcelain', '--untracked-files=no') === '' && git(kit.repo, 'check-ignore', 'secret.env').trim() === 'secret.env', `${tag}: the user's secret.env is ignored and the checkout clean`)
    same((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).landing, { blocked: 'base_dirty', files: ['secret.env'] }, `${tag} preview: an ignored file the branch tracks blocks the landing and is named`)
    const fi = await failsIdentical(kit, task, `${tag} ignored file`, {}, 'base_dirty')
    same(fi.files, ['secret.env'], `${tag}: base_dirty names the ignored file`)
    check(fs.readFileSync(secret, 'utf8') === 'USER SECRET\n', `${tag}: the ignored file is untouched`)
    check(kit.events.some((e) => e.step === 'land' && e.state === 'failed' && e.error === 'base_dirty' && e.files?.[0] === 'secret.env'), `${tag}: the failed land event names it`)
    fs.rmSync(secret)
    // An ignored folder where the branch adds a file: what is in it is named.
    write(outBin, 'build output\n')
    same((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).landing, { blocked: 'base_dirty', files: ['build/out.bin'] }, `${tag} preview: an ignored folder the branch turns into a file blocks the landing`)
    const fd = await failsIdentical(kit, task, `${tag} ignored folder`, {}, 'base_dirty')
    same(fd.files, ['build/out.bin'], `${tag}: base_dirty names what the ignored folder holds`)
    check(fs.readFileSync(outBin, 'utf8') === 'build output\n', `${tag}: the ignored folder is untouched`)
    fs.rmSync(path.join(kit.repo, 'build'), { recursive: true, force: true })
    // Untracked and ignored files that are not in the way never block: one in a folder the branch adds into, one
    // elsewhere, an ignored one elsewhere (and node_modules, the junction target).
    write(path.join(kit.repo, 'src', 'scratch.txt'), 'scratch\n')
    write(path.join(kit.repo, 'notes.txt'), 'notes\n')
    write(path.join(kit.repo, 'other', 'secret.env'), 'another ignored one\n')
    same((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).landing, { mode: 'ffOnly' }, `${tag} preview: untracked and ignored files out of the way: ff-only`)
    // git's own refusal: the ignored file appears after the land's check, right before the ff-only merge runs.
    hooks.beforeLand = () => write(secret, 'USER SECRET, LATE\n')
    const rl = await failsIdentical(kit, task, `${tag} ignored file after the check`, {}, 'base_dirty')
    same(rl.files, ['secret.env'], `${tag}: --no-overwrite-ignore: git refuses and names the ignored file`)
    check(rl.landing === 'ffOnly' && !('landing' in fi), `${tag}: git's own refusal names the ffOnly land; the land's check before it names none`)
    check(fs.readFileSync(secret, 'utf8') === 'USER SECRET, LATE\n', `${tag}: the late ignored file is untouched`)
    fs.rmSync(secret)
    hooks.beforeLand = () => write(outBin, 'late build output\n')
    const rd = await failsIdentical(kit, task, `${tag} ignored folder after the check`, {}, 'base_dirty')
    same(rd.files, ['build'], `${tag}: git refuses to empty the ignored folder and names it (base_dirty, never base_moved)`)
    check(fs.readFileSync(outBin, 'utf8') === 'late build output\n', `${tag}: the late ignored folder is untouched`)
    fs.rmSync(path.join(kit.repo, 'build'), { recursive: true, force: true })
    // Nothing in the way: it lands, and the files out of the way are as they were.
    const ok = await kit.run(task, { id: `i-ign-${autocrlf}` })
    check(ok.ok && ok.landed === 'ffOnly' && fs.readFileSync(secret, 'utf8').replace(/\r\n/g, '\n') === 'from the branch\n', `${tag}: with nothing in the way it lands (${JSON.stringify(ok).slice(0, 160)})`)
    check(fs.readFileSync(path.join(kit.repo, 'src', 'scratch.txt'), 'utf8') === 'scratch\n' && fs.readFileSync(path.join(kit.repo, 'notes.txt'), 'utf8') === 'notes\n' && fs.readFileSync(path.join(kit.repo, 'other', 'secret.env'), 'utf8') === 'another ignored one\n', `${tag}: the untracked and ignored files out of the way are untouched`)
    cleanAfter(kit, `${tag} ignored`, 2)
  }
  // Conflict, git_error, checked out elsewhere, verify failures, identity, hooks.
  {
    const kit = makeKit('conflict', { autocrlf })
    const task = await kit.task({ 'conflict.txt': 'branch side\n', 'other.txt': 'fine\n' })
    write(path.join(kit.repo, 'conflict.txt'), 'main side\n')
    git(kit.repo, ...ID, 'commit', '-qam', 'main edit')
    const res = await failsIdentical(kit, task, `${tag} merge_conflict`, {}, 'merge_conflict')
    same(res.files, ['conflict.txt'], `${tag}: the conflicting files (--diff-filter=U)`)
    check(res.step === 'merge' && kit.events.some((e) => e.step === 'merge' && e.state === 'failed' && e.error === 'merge_conflict' && e.files?.[0] === 'conflict.txt'), `${tag}: the failed merge event carries the files`)
    cleanAfter(kit, `${tag} conflict (merge aborted)`, 2)
    // A merge that fails with no unmerged path (a repo that wants signed tips) reads git_error, never a conflict.
    const t2 = await kit.task({ 'sig.txt': 'x\n' })
    git(kit.repo, 'config', 'merge.verifySignatures', 'true')
    const g = await failsIdentical(kit, t2, `${tag} merge git_error`, {}, 'git_error')
    check(!g.files && /signature/i.test(g.tail ?? ''), `${tag}: git_error with git's own words, no files (${g.tail})`)
    git(kit.repo, 'config', '--unset', 'merge.verifySignatures')
    // The base checked out in another worktree.
    git(kit.repo, 'checkout', '-q', '-b', 'side')
    const elsewhere = path.join(kit.dir, 'elsewhere')
    git(kit.repo, 'worktree', 'add', '-q', elsewhere, 'main')
    const pe = await kit.integrator.preview(TEAM, kit.repoObj, t2, null, [])
    check(pe.landing.blocked === 'base_checked_out_elsewhere' && real(pe.landing.path) === real(elsewhere), `${tag} preview: checked out elsewhere names the worktree`)
    const beforeElse = snap(elsewhere)
    await failsIdentical(kit, t2, `${tag} base_checked_out_elsewhere`, {}, 'base_checked_out_elsewhere')
    same(snap(elsewhere), beforeElse, `${tag}: that worktree is untouched too`)
    git(kit.repo, 'worktree', 'remove', '--force', elsewhere)
    git(kit.repo, 'checkout', '-q', 'main')
    // verify_failed: the real runner, the tail and the log.
    const t3 = await kit.task({ FAIL: 'the tests broke\n' })
    process.env.SNAOS_CTL_TOKEN = 'never-in-a-verify'
    const vf = await failsIdentical(kit, t3, `${tag} verify_failed`, { verify: { command: `${NODE} verify.js`, timeoutMs: 60000 } }, 'verify_failed')
    delete process.env.SNAOS_CTL_TOKEN
    check(vf.step === 'verify' && vf.tail.includes('boom: the tests broke') && vf.tail.includes('verify env snaos=0'), `${tag}: verify_failed with the tail, and no SNAOS_* var reached it (${vf.tail})`)
    const logs = fs.readdirSync(kit.verifyDir)
    check(logs.length === 1 && M.VERIFY_LOG_RE.test(logs[0]) && fs.readFileSync(path.join(kit.verifyDir, logs[0]), 'utf8').includes('boom: the tests broke'), `${tag}: the verify log under teams/<id>/verify/`)
    cleanAfter(kit, `${tag} verify_failed`, 4)
    // no_identity and the hooks get their own repos below; the verify ok with its live tail here.
    const t4 = await kit.task({ 'ok.txt': 'ok\n' })
    const vo = await kit.run(t4, { verify: { command: `${NODE} verify.js`, timeoutMs: 60000 } })
    check(vo.ok && vo.verifyTail.includes('verify ok'), `${tag}: a verify that exits 0 lands`)
    const tails = kit.events.filter((e) => e.integrationId === 'i-t-4' && e.step === 'verify' && e.state === 'running' && e.logTail)
    check(tails.length >= 1 && tails.some((e) => e.logTail.includes('line 1')), `${tag}: the verify tail arrives live while it runs (${tails.length} events)`)
    cleanAfter(kit, `${tag} verify ok`, 5)
  }
  {
    const kit = makeKit('noid', { autocrlf, identity: false })
    const task = await kit.task({ 'x.txt': 'x\n' })
    check((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).error === 'no_identity', `${tag} preview: no_identity`)
    const r = await failsIdentical(kit, task, `${tag} no_identity`, {}, 'no_identity')
    check(r.step === 'preflight' && kit.tempLeft().length === 0, `${tag}: no_identity before any temp tree (git var GIT_COMMITTER_IDENT)`)
  }
  {
    const kit = makeKit('hooks', { autocrlf })
    const hooks = path.join(kit.repo, '.git', 'hooks')
    const sentinel = path.join(kit.dir, 'hook-ran.txt').replace(/\\/g, '/')
    for (const h of ['commit-msg', 'pre-merge-commit']) { write(path.join(hooks, h), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(hooks, h), 0o755) }
    for (const h of ['post-merge', 'post-checkout', 'reference-transaction']) { write(path.join(hooks, h), `#!/bin/sh\necho ${h} >> "${sentinel}"\n`); fs.chmodSync(path.join(hooks, h), 0o755) }
    // The control: the repo's own commit-msg hook does refuse a commit.
    write(path.join(kit.repo, 'ctl.txt'), 'x\n')
    git(kit.repo, 'add', 'ctl.txt')
    check(gitTry(kit.repo, ...ID, 'commit', '-qm', 'blocked') === null, `${tag}: the failing commit-msg hook is live in the repo`)
    git(kit.repo, 'reset', '-q')
    fs.rmSync(path.join(kit.repo, 'ctl.txt'))
    if (fs.existsSync(sentinel)) fs.rmSync(sentinel)
    const task = await kit.task({ 'h.txt': 'h\n' })
    if (fs.existsSync(sentinel)) fs.rmSync(sentinel)
    const res = await kit.run(task)
    check(res.ok && res.landed === 'ffOnly', `${tag}: a failing commit-msg / pre-merge-commit hook never stops the merge (${JSON.stringify(res)})`)
    check(!fs.existsSync(sentinel), `${tag}: no repo hook ran on the temp tree nor on the land (post-checkout, post-merge, reference-transaction)`)
    cleanAfter(kit, `${tag} hooks`, 2)
  }
}

/** The preflight refusals, verify_timeout (the grandchild killed), one integrate per repo, another repo alongside, the logs prune, the sweep. */
async function integratorOnceChecks() {
  {
    const kit = makeKit('preflight', {})
    const task = await kit.task({ 'p.txt': 'p\n' })
    const tip = kit.tip(task)
    // A tip that moved since the preview: busy (look again), nothing built.
    await failsIdentical(kit, task, 'moved tip', { expectTip: 'f'.repeat(40), id: 'i-moved' }, 'busy')
    same(kit.stepsOf('i-moved'), ['preflight:running', 'preflight:failed', 'cleanup:skipped'], 'a preflight refusal still ends with its cleanup event (the dialog knows it ended)')
    // Uncommitted work in the task tree.
    write(path.join(task.worktree.path, 'wip.txt'), 'not committed\n')
    check((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).error === 'dirty_worktree', 'preview: dirty_worktree')
    await failsIdentical(kit, task, 'dirty task tree', {}, 'dirty_worktree')
    fs.rmSync(path.join(task.worktree.path, 'wip.txt'))
    // The task tree left on another commit (detached): wrong_branch.
    git(task.worktree.path, 'checkout', '-q', '--detach', 'HEAD~1')
    await failsIdentical(kit, task, 'detached task tree', { expectTip: tip }, 'wrong_branch')
    git(task.worktree.path, 'checkout', '-q', task.worktree.branch)
    // A merge left half done in the task tree: in_progress.
    git(task.worktree.path, 'checkout', '-q', '-b', 'side', 'HEAD~1')
    write(path.join(task.worktree.path, 'p.txt'), 'other\n')
    git(task.worktree.path, 'add', '-A')
    git(task.worktree.path, ...ID, 'commit', '--no-verify', '-qm', 'side')
    git(task.worktree.path, 'checkout', '-q', task.worktree.branch)
    check(gitTry(task.worktree.path, ...ID, 'merge', '--no-edit', 'side') === null, 'a conflicting merge left in the task tree')
    await failsIdentical(kit, task, 'merge in progress in the task tree', { expectTip: tip }, 'in_progress')
    git(task.worktree.path, 'merge', '--abort')
    // The task tree gone.
    fs.rmSync(task.worktree.path, { recursive: true, force: true })
    check((await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])).error === 'missing_worktree', 'preview: missing_worktree')
    await failsIdentical(kit, task, 'task tree gone', { expectTip: tip }, 'missing_worktree')
    check(kit.events.filter((e) => e.step === 'temp').length === 0 && kit.locks.size === 0, 'no preflight refusal built a temp tree or kept a lock')
  }
  {
    const kit = makeKit('timeout', {})
    const task = await kit.task({ 't.txt': 't\n' })
    const pidFile = path.join(kit.dir, 'grandchild.pid')
    const before = snap(kit.repo)
    const started = Date.now()
    const res = await kit.run(task, { verify: { command: `${NODE} hang.js ${JSON.stringify(pidFile)}`, timeoutMs: 1500 } })
    check(!res.ok && res.error === 'verify_timeout' && res.tail.includes('hanging') && Date.now() - started < 15000, `verify_timeout with the tail (${JSON.stringify(res).slice(0, 200)})`)
    same(snap(kit.repo), before, 'verify_timeout: byte identical')
    const gpid = Number(fs.readFileSync(pidFile, 'utf8'))
    await until(() => !M.pidAlive(gpid), 10000, 'the grandchild killed with the tree')
    check(!M.pidAlive(gpid), 'the verify tree killed at the timeout, its grandchild too')
    cleanAfter(kit, 'verify_timeout', 2)
  }
  {
    // B6 review: the runner's note reaches the progress event and the result as `verifyNote` (the renderer words it),
    // never as a line of the tail: on the verify ok event of a land, and on a failed verify.
    const kit = makeKit('notes', {})
    const t1 = await kit.task({ 'n1.txt': '1\n' })
    kit.verifyImpl = async () => ({ ok: true, timedOut: false, tail: 'all fine', note: 'leftStopped' })
    const r1 = await kit.run(t1, { verify: { command: 'x', timeoutMs: 60000 }, id: 'i-n1' })
    const okEv = kit.events.find((e) => e.integrationId === 'i-n1' && e.step === 'verify' && e.state === 'ok')
    check(r1.ok && r1.verifyNote === 'leftStopped' && r1.verifyTail === 'all fine', `a land whose verify stopped a leftover: verifyNote on the result (${JSON.stringify(r1).slice(0, 200)})`)
    check(okEv?.verifyNote === 'leftStopped' && okEv.logTail === 'all fine', `the verify ok event carries verifyNote next to its tail (${JSON.stringify(okEv)})`)
    const t2 = await kit.task({ 'n2.txt': '2\n' })
    kit.verifyImpl = async () => ({ ok: false, timedOut: true, tail: 'slow', note: 'timeoutKill' })
    const r2 = await kit.run(t2, { verify: { command: 'x', timeoutMs: 60000 }, id: 'i-n2' })
    const failEv = kit.events.find((e) => e.integrationId === 'i-n2' && e.step === 'verify' && e.state === 'failed')
    check(!r2.ok && r2.error === 'verify_timeout' && r2.verifyNote === 'timeoutKill' && r2.tail === 'slow' && failEv?.verifyNote === 'timeoutKill' && failEv.logTail === 'slow', `verify_timeout with verifyNote on the result and the failed event (${JSON.stringify(failEv)})`)
    const t3 = await kit.task({ 'n3.txt': '3\n' })
    kit.verifyImpl = async () => ({ ok: false, timedOut: false, tail: '', note: 'spawnFailed' })
    const r3 = await kit.run(t3, { verify: { command: 'x', timeoutMs: 60000 }, id: 'i-n3' })
    const spawnEv = kit.events.find((e) => e.integrationId === 'i-n3' && e.step === 'verify' && e.state === 'failed')
    check(!r3.ok && r3.error === 'verify_failed' && r3.verifyNote === 'spawnFailed' && !r3.tail && spawnEv?.verifyNote === 'spawnFailed' && !('logTail' in spawnEv), `a verify that could not start: verify_failed with verifyNote spawnFailed and no tail (${JSON.stringify(spawnEv)})`)
    const t4 = await kit.task({ 'n4.txt': '4\n' })
    kit.verifyImpl = async () => ({ ok: true, timedOut: false, tail: 'plain' })
    await kit.run(t4, { verify: { command: 'x', timeoutMs: 60000 }, id: 'i-n4' })
    check(kit.events.filter((e) => e.integrationId === 'i-n4').every((e) => !('verifyNote' in e)), 'a verify with nothing to say: no verifyNote on any event')
    kit.verifyImpl = null
  }
  {
    // B6 review, second round: a land that fails once its mode is known names it (the dialog words a timeout by it: only
    // an ffOnly one may have half updated the checkout), on the result and the failed land event; the verify's note
    // stays on the result of a later failure (the task keeps it), never on the land event.
    const slow = { ffOnly: false, updateRef: false }
    const timeoutErr = () => Object.assign(new Error('timeout'), { name: 'GitExecError', code: 'timeout', stderr: '', stdout: '', exitCode: null, maxBuffer: false })
    const isSlow = (args) => (slow.ffOnly && args.includes('--ff-only')) || (slow.updateRef && args.includes('update-ref'))
    const slowGit = { run: (args, opts) => (isSlow(args) ? Promise.reject(timeoutErr()) : runner.run(args, opts)), info: (f) => runner.info(f), get running() { return runner.running } }
    const kit = makeKit('landModes', { git: slowGit })
    const t1 = await kit.task({ 'lm1.txt': '1\n' })
    kit.verifyImpl = async () => ({ ok: true, timedOut: false, tail: 'all fine', note: 'leftStopped' })
    slow.ffOnly = true
    const before = snap(kit.repo)
    const r1 = await kit.run(t1, { verify: { command: 'x', timeoutMs: 60000 }, id: 'i-lm1' })
    const ev1 = kit.events.find((e) => e.integrationId === 'i-lm1' && e.step === 'land' && e.state === 'failed')
    check(!r1.ok && r1.error === 'timeout' && r1.step === 'land' && r1.landing === 'ffOnly' && r1.verifyNote === 'leftStopped', `an ffOnly land timeout: step land, landing ffOnly and the verify's note (${JSON.stringify(r1).slice(0, 200)})`)
    check(ev1?.landing === 'ffOnly' && ev1.error === 'timeout' && !('verifyNote' in ev1), `the failed land event names the ffOnly land and no note (${JSON.stringify(ev1)})`)
    same(snap(kit.repo), before, 'an ffOnly land timeout (the fake git never ran it): byte identical')
    slow.ffOnly = false
    kit.verifyImpl = null
    git(kit.repo, 'checkout', '-q', '-b', 'other')
    slow.updateRef = true
    const r2 = await kit.run(t1, { id: 'i-lm2' })
    const ev2 = kit.events.find((e) => e.integrationId === 'i-lm2' && e.step === 'land' && e.state === 'failed')
    check(!r2.ok && r2.error === 'timeout' && r2.step === 'land' && r2.landing === 'updateRef' && !('verifyNote' in r2) && ev2?.landing === 'updateRef', `an updateRef land timeout: landing updateRef, no note without a verify (${JSON.stringify(r2).slice(0, 200)})`)
    slow.updateRef = false
    cleanAfter(kit, 'land modes', 2)
  }
  {
    // B6 integration, item 1: halt() (the exit hooks). One in its verify ends interrupted even when the verify says ok
    // (never a land); one waiting for the repo ends interrupted before anything; one begun later lands.
    const kit = makeKit('halt', {})
    const t1 = await kit.task({ 'h1.txt': '1\n' })
    const t2 = await kit.task({ 'h2.txt': '2\n' })
    let release
    const gate = new Promise((r) => { release = r })
    kit.verifyImpl = async () => { await gate; return { ok: true, timedOut: false, tail: 'all fine' } }
    const before = snap(kit.repo)
    const p1 = kit.run(t1, { verify: { command: 'x', timeoutMs: 60000 }, id: 'i-h1' })
    await until(() => kit.events.some((e) => e.integrationId === 'i-h1' && e.step === 'verify' && e.state === 'running'), 20000, 'the first integrate in its verify')
    const p2 = kit.run(t2, { id: 'i-h2' })
    kit.integrator.halt()
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    check(!r1.ok && r1.error === 'interrupted' && r1.step === 'verify', `halted in its verify: interrupted, not landed (${JSON.stringify(r1).slice(0, 160)})`)
    check(!r2.ok && r2.error === 'interrupted' && r2.step === 'preflight', 'halted while it waited for the repo: interrupted at preflight')
    same(kit.stepsOf('i-h2'), ['preflight:running', 'preflight:failed', 'cleanup:skipped'], 'the waiting one built nothing')
    same(snap(kit.repo), before, 'halt: the user checkout byte identical')
    cleanAfter(kit, 'halt', 3)
    kit.verifyImpl = null
    const r3 = await kit.run(t2, { id: 'i-h3' })
    check(r3.ok && r3.landed === 'ffOnly', 'an integrate begun after the halt lands as usual')
  }
  {
    // B6 integration, item 3: an installing verify gets no node_modules junction (its install writes its own there);
    // any other verify keeps the junction. The real runner and real files.
    const kit = makeKit('install', {})
    const t1 = await kit.task({ 'i1.txt': '1\n' })
    const INSTALL = `${NODE} install.js || npm ci`
    same((await kit.integrator.preview(TEAM, kit.repoObj, t1, { command: INSTALL, confirmed: true }, [])).verify, { command: INSTALL, confirmed: true, installs: true }, 'preview: an installing verify says so (installs)')
    same((await kit.integrator.preview(TEAM, kit.repoObj, t1, { command: 'npm test', confirmed: false }, [])).verify, { command: 'npm test', confirmed: false }, 'preview: any other verify has no installs flag')
    const ri = await kit.run(t1, { verify: { command: INSTALL, timeoutMs: 60000 }, id: 'i-inst' })
    check(ri.ok && ri.verifyTail.includes('installed link=false'), `the install ran in a temp tree with no node_modules link (${ri.verifyTail})`)
    check(fs.readFileSync(path.join(kit.repo, 'node_modules', 'pkg', 'sentinel.txt'), 'utf8') === 'keep me\n', "the repo's node_modules never rewritten through a link")
    check(kit.logs.some((l) => l.includes('no node_modules link (the verify installs)')), 'teams.log says why there is no link')
    const t2 = await kit.task({ 'i2.txt': '2\n' })
    const rp = await kit.run(t2, { verify: { command: `${NODE} probe.js`, timeoutMs: 60000 }, id: 'i-probe' })
    check(rp.ok && rp.verifyTail.includes('probe link=true sentinel=true'), `any other verify keeps the junction (${rp.verifyTail})`)
    cleanAfter(kit, 'install verify', 3)
  }
  {
    // B6 integration, item 4: the ff-only land (the step that updates the user's checkout) gets 10 minutes.
    const calls = []
    const recorder = { run: (args, opts) => { calls.push({ args, timeoutMs: opts.timeoutMs }); return runner.run(args, opts) }, info: (f) => runner.info(f), get running() { return runner.running } }
    const kit = makeKit('landTimeout', { git: recorder })
    const t = await kit.task({ 'lt.txt': 'x\n' })
    const res = await kit.run(t)
    const ff = calls.find((c) => c.args.includes('--ff-only'))
    const add = calls.find((c) => c.args.includes('worktree') && c.args.includes('add'))
    check(res.ok && res.landed === 'ffOnly' && M.INTEGRATE_LAND_TIMEOUT_MS === 600000 && ff?.timeoutMs === M.INTEGRATE_LAND_TIMEOUT_MS, `the ff-only land runs with the 10 minute timeout (${ff?.timeoutMs})`)
    check(add?.timeoutMs === M.INTEGRATE_GIT_TIMEOUT_MS && M.INTEGRATE_GIT_TIMEOUT_MS === 120000, 'the temp worktree add keeps 120 s')
  }
  {
    // B6 integration, item 7: base_dirty names the dirty files, at most 50, and how many more.
    const kit = makeKit('dirty50', {})
    const name = (i) => `many/f${String(i).padStart(2, '0')}.txt`
    for (let i = 0; i < 53; i++) write(path.join(kit.repo, name(i)), 'x\n')
    git(kit.repo, 'add', '-A')
    git(kit.repo, ...ID, 'commit', '-qm', 'many')
    const task = await kit.task({ 'd.txt': 'd\n' })
    for (let i = 0; i < 53; i++) write(path.join(kit.repo, name(i)), 'edited\n')
    const pv = await kit.integrator.preview(TEAM, kit.repoObj, task, null, [])
    check(pv.landing.blocked === 'base_dirty' && pv.landing.files.length === 50 && pv.landing.files[0] === name(0) && pv.landing.files[49] === name(49) && pv.landing.filesMore === 3, `preview base_dirty: 50 files and filesMore 3 (${pv.landing.files?.length}, ${pv.landing.filesMore})`)
    const r = await failsIdentical(kit, task, 'base_dirty with 53 files', {}, 'base_dirty')
    check(r.files.length === 50, 'the failed land names the first 50 too')
  }
  {
    // One integrate per repo across every team; another repo runs alongside.
    const a = makeKit('mutexA', {})
    const b = makeKit('mutexB', { locks: a.locks, integrator: a.integrator })
    b.events = a.events
    const t1 = await a.task({ 'one.txt': '1\n' })
    const t2 = await a.task({ 'two.txt': '2\n' })
    // The extra repo's task is another task of the same team (ids are unique per team).
    b.n = 10
    const tb = await b.task({ 'extra.txt': 'b\n' })
    let release
    const gate = new Promise((r) => { release = r })
    a.verifyImpl = async (_c, cwd) => { if (fs.existsSync(path.join(cwd, 'one.txt'))) await gate; return { ok: true, timedOut: false, tail: '' } }
    const mainA = snap(a.repo)
    const p1 = a.integrator.integrate(TEAM, a.repoObj, t1, { expectTip: a.tip(t1), integrationId: 'i-a1', verify: { command: 'x', timeoutMs: 60000 } })
    await until(() => a.events.some((e) => e.integrationId === 'i-a1' && e.step === 'verify' && e.state === 'running'), 20000, 'the first integrate in its verify')
    const p2 = a.integrator.integrate(TEAM, a.repoObj, t2, { expectTip: a.tip(t2), integrationId: 'i-a2' })
    const pb = a.integrator.integrate(TEAM, b.repoObj, tb, { expectTip: b.tip(tb), integrationId: 'i-b' })
    const rb = await pb
    check(rb.ok && rb.landed === 'ffOnly', 'an extra repo integrates while the main repo is busy (its own mutex key)')
    same(snap(a.repo), mainA, 'the main repo is untouched by the extra repo integrate')
    check(a.events.filter((e) => e.integrationId === 'i-a2').length === 0, 'a second task of the same repo waits for its turn (no step yet)')
    const held = { repos: a.integrator.busyRepos().length, t1: a.locks.holderOf(a.locks.key(t1.worktree.path)), t2: a.locks.holderOf(a.locks.key(t2.worktree.path)) }
    same(held, { repos: 1, t1: M.integrateHolder(TEAM, 't-1'), t2: M.integrateHolder(TEAM, 't-2') }, 'the waiting task and the running one hold their task trees')
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    check(r1.ok && r2.ok && r2.landed === 'ffOnly', 'both land in turn (the second on the new base)')
    const parents = git(a.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')
    check(parents[1] === r1.mergeSha, 'the second merge was built on the first one')
    a.verifyImpl = null
    check(a.integrator.busyRepos().length === 0 && a.locks.size === 0, 'no repo held, no lock left')
  }
  {
    // Verify logs: past 30 days and past the size cap, never one being written.
    const dir = path.join(TMP, 'prune')
    fs.mkdirSync(dir, { recursive: true })
    const old = Date.now() / 1000 - 31 * 86400
    for (let i = 1; i <= 4; i++) {
      const f = path.join(dir, `t-${i}-${1000 + i}.log`)
      fs.writeFileSync(f, 'x'.repeat(100 * i))
      fs.utimesSync(f, Date.now() / 1000 - (5 - i) * 60, Date.now() / 1000 - (5 - i) * 60)
    }
    fs.writeFileSync(path.join(dir, 't-9-1.log'), 'old')
    fs.utimesSync(path.join(dir, 't-9-1.log'), old, old)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a log')
    fs.utimesSync(path.join(dir, 'notes.txt'), old, old)
    check((await M.pruneLogDir(dir, M.VERIFY_LOG_RE)) === 1 && !fs.existsSync(path.join(dir, 't-9-1.log')) && fs.existsSync(path.join(dir, 'notes.txt')), 'a verify log past 30 days goes; another file stays')
    check((await M.pruneLogDir(dir, M.VERIFY_LOG_RE, { maxBytes: 950 })) === 1 && !fs.existsSync(path.join(dir, 't-1-1001.log')) && fs.existsSync(path.join(dir, 't-2-1002.log')), 'past the size cap the oldest goes until the rest fits')
    check((await M.pruneLogDir(dir, M.VERIFY_LOG_RE, { maxBytes: 0, keep: new Set(['t-4-1004.log']) })) === 2 && fs.existsSync(path.join(dir, 't-4-1004.log')), 'a log being written is kept')
  }
  {
    // The sweep: a temp tree and a message file a quit left, its junction removed as a link.
    const kit = makeKit('sweep', {})
    fs.mkdirSync(kit.integrateDir, { recursive: true })
    const left = path.join(kit.integrateDir, 't-7-123')
    git(kit.repo, 'worktree', 'add', '-q', '--detach', left, 'main')
    fs.symlinkSync(path.join(kit.repo, 'node_modules'), path.join(left, 'node_modules'), 'junction')
    write(path.join(kit.integrateDir, 't-7-123.msg'), 'Merge x\n')
    write(path.join(kit.integrateDir, 'keep.txt'), 'not ours\n')
    check(kit.listed() === 2, 'the leftover is a git worktree')
    await kit.integrator.sweep(TEAM, [kit.repo])
    same(fs.readdirSync(kit.integrateDir), ['keep.txt'], 'the sweep removes the temp tree and the message file, nothing else')
    check(kit.listed() === 1, 'worktree prune dropped its git record')
    check(fs.readFileSync(path.join(kit.repo, 'node_modules', 'pkg', 'sentinel.txt'), 'utf8') === 'keep me\n', 'the junction was removed as a link (node_modules whole)')
  }
  {
    // GitExecError carries git's exit code and stdout (decision 70).
    const kit = makeKit('exec', {})
    const err = await runner.run(['rev-parse', '--verify', 'refs/heads/nope'], { cwd: kit.repo }).catch((e) => e)
    check(M.gitExitCode(err) === 128 && err.exitCode === 128, `exitCode 128 of a failed rev-parse (${err.exitCode})`)
    const anc = await runner.run(['merge-base', '--is-ancestor', 'HEAD', 'HEAD~0^{tree}'], { cwd: kit.repo }).catch((e) => e)
    check(typeof anc.exitCode === 'number', 'a failed merge-base has an exit code')
    write(path.join(kit.repo, 'conflict.txt'), 'one\n'); git(kit.repo, ...ID, 'commit', '-qam', 'one')
    git(kit.repo, 'checkout', '-q', '-b', 'b2', 'HEAD~1')
    write(path.join(kit.repo, 'conflict.txt'), 'two\n'); git(kit.repo, ...ID, 'commit', '-qam', 'two')
    const merge = await runner.run(['merge', '--no-edit', 'main'], { cwd: kit.repo }).catch((e) => e)
    check(merge.exitCode === 1 && /CONFLICT/.test(merge.stdout), `a conflicting merge: exit 1 and CONFLICT on its stdout (${merge.exitCode})`)
    git(kit.repo, 'merge', '--abort')
    const notAnc = await runner.run(['merge-base', '--is-ancestor', 'main', 'b2'], { cwd: kit.repo }).catch((e) => e)
    check(notAnc.exitCode === 1 && notAnc.stderr === '', 'not an ancestor: exit 1 with an empty stderr')
  }
}

/** B6 integration, items 1 and 2: the verify runner resolves at the exit (plus its drain) and tracks its processes. */
async function verifyRunnerChecks() {
  const dir = path.join(TMP, 'runner')
  fs.mkdirSync(dir, { recursive: true })
  write(path.join(dir, 'bg.js'), BG_JS)
  write(path.join(dir, 'wait.js'), "require('fs').writeFileSync(process.argv[2], String(process.pid))\nconsole.log('waiting')\nsetInterval(() => {}, 1000)\n")
  const logs = []
  const r = M.createVerifyRunner({ env: () => ({ ...process.env }), treeKill: (pid) => M.treeKillSync(pid), platform: process.platform, log: (l) => logs.push(l) })
  // Exit 0 with a grandchild that keeps stdout open: resolved after the 2 s drain, ok, said in the log.
  const pidFile = path.join(dir, 'bg.pid')
  const logFile = path.join(dir, 'verify', 't-1-1.log')
  const started = Date.now()
  const res = await r(`${NODE} bg.js ${JSON.stringify(pidFile)}`, dir, 60000, logFile)
  const took = Date.now() - started
  const gpid = Number(fs.readFileSync(pidFile, 'utf8'))
  // POSIX stops the group; Windows keeps no tree for a root that exited, so the pipes are let go. B6 review: that is the
  // result's note (the renderer words it); the English line goes to the log only, never to the tail.
  const said = WIN ? 'it was let go' : 'it was stopped'
  check(res.ok && !res.timedOut && res.tail.includes('main done') && res.note === (WIN ? 'leftLetGo' : 'leftStopped') && !res.tail.includes('held its output'), `exit 0 stays ok with the note that a process it left was ${WIN ? 'let go' : 'stopped'}, none of it in the tail (${res.note}; ${res.tail.slice(-160)})`)
  check(took >= M.VERIFY_EXIT_DRAIN_MS - 200 && took < 20000, `resolved at the exit plus its ${M.VERIFY_EXIT_DRAIN_MS} ms drain, not at the 60 s timeout (${took} ms)`)
  check(logs.some((l) => /^verify exited 0: a process it left still held its output/.test(l)), 'teams.log names it')
  // The log stream ends on its own after the result.
  await until(() => fs.readFileSync(logFile, 'utf8').includes('[exit'), 5000, 'the verify log written')
  const logText = fs.readFileSync(logFile, 'utf8')
  check(logText.includes(said) && logText.includes('[exit 0]'), `the verify log says so, then [exit 0] (${logText.slice(-200)})`)
  if (!WIN) {
    await until(() => !M.pidAlive(gpid), 10000, 'the grandchild stopped')
    check(!M.pidAlive(gpid), 'POSIX: the group kill stopped the grandchild that held the pipes')
  } else {
    // Windows keeps no tree for a root that already exited (taskkill /T answers "not found"): the pipes were let go.
    try { process.kill(gpid) } catch { /* gone */ }
  }
  check(r.live() === 0, 'nothing tracked once it resolved')
  // killAll (the exit hooks): the verify in flight is tree-killed and resolves not ok.
  const wpid = path.join(dir, 'wait.pid')
  const p = r(`${NODE} wait.js ${JSON.stringify(wpid)}`, dir, 60000, path.join(dir, 'verify', 't-2-1.log'))
  await until(() => fs.existsSync(wpid) && fs.readFileSync(wpid, 'utf8').length > 0, 20000, 'the verify running')
  check(r.live() === 1, 'the verify in flight is tracked')
  check(r.killAll() === 1, 'killAll stops it')
  const kr = await p
  const vpid = Number(fs.readFileSync(wpid, 'utf8'))
  await until(() => !M.pidAlive(vpid), 10000, 'its tree killed')
  check(!kr.ok && !kr.timedOut && !M.pidAlive(vpid), 'a killed verify resolves, not ok, its process gone')
  check(r.live() === 0 && r.killAll() === 0, 'nothing left to kill')
  if (WIN) {
    // B6 integration, second round: a cmd.exe that starts `ping -t` (start /b: its direct child, holding its stdout)
    // and exits 0. After the drain every direct child of the dead shell is tree-killed: the ping is gone.
    const marker = '1371'
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const pings = () => cp.execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'Name=''PING.EXE''' | Where-Object { $_.CommandLine -like '*-l ${marker} *' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(Number).filter((n) => n > 0)
    try {
      const killed = []
      const wl = []
      const wr = M.createVerifyRunner({ env: () => ({ ...process.env }), treeKill: (pid) => { killed.push(pid); M.treeKillSync(pid) }, platform: 'win32', log: (l) => wl.push(l) })
      const t0 = Date.now()
      const pr = await wr(`start /b ping -t -l ${marker} 127.0.0.1 & echo main done`, dir, 60000, path.join(dir, 'verify', 't-5-1.log'))
      const took = Date.now() - t0
      check(pr.ok && !pr.timedOut && pr.tail.includes('main done') && pr.tail.includes(marker) && pr.note === 'leftStopped' && !pr.tail.includes('it was stopped'), `win32: exit 0 stays ok, the ping ran and the note says it was stopped (${pr.note}; ${pr.tail.slice(-200)})`)
      check(killed.length >= 1 && wl.some((l) => /^verify exited 0: .* was stopped$/.test(l)), `win32: a direct child of the dead shell tree-killed, said in teams.log (${killed.join(',')})`)
      check(took >= M.VERIFY_EXIT_DRAIN_MS - 200 && took < 20000, `win32: settled after the drain and the probe, not at the timeout (${took} ms)`)
      await until(() => pings().length === 0, 15000, 'the ping gone')
      check(pings().length === 0, 'win32: the ping -t the dead shell left is gone after the verify settles')
    } finally {
      for (const pid of pings()) { try { process.kill(pid) } catch { /* gone */ } }
    }
    // A deeper leftover: an inner cmd.exe starts the ping and exits, so the ping's parent is gone too. The dead shell's
    // only direct child then is its console host (conhost.exe), which is never killed in its place: the line says the
    // process was let go, never that it was stopped (it still runs).
    const deep = '1372'
    const deepPings = () => cp.execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'Name=''PING.EXE''' | Where-Object { $_.CommandLine -like '*-l ${deep} *' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(Number).filter((n) => n > 0)
    try {
      const killed = []
      const wl = []
      const wr = M.createVerifyRunner({ env: () => ({ ...process.env }), treeKill: (pid) => { killed.push(pid); M.treeKillSync(pid) }, platform: 'win32', log: (l) => wl.push(l) })
      const pr = await wr(`cmd /d /c start /b ping -t -l ${deep} 127.0.0.1 & echo main done`, dir, 60000, path.join(dir, 'verify', 't-5-2.log'))
      check(pr.ok && pr.tail.includes('main done') && pr.note === 'leftLetGo' && !pr.tail.includes('held its output'), `win32: a deeper leftover (its parent gone): exit 0 stays ok and the note says it was let go (${pr.note}; ${pr.tail.slice(-200)})`)
      check(killed.length === 0 && wl.some((l) => /^verify exited 0: .* was let go$/.test(l)), `win32: no console host killed in its place, teams.log says let go (${killed.join(',')})`)
      check(deepPings().length === 1, 'win32: that ping still runs (the documented residual)')
    } finally {
      for (const pid of deepPings()) { try { process.kill(pid) } catch { /* gone */ } }
    }
    // B6 review: killAll (shutdownSync, prepareInstall) while the verify is in the drain after its exit, the app about to
    // quit: the ping the dead shell left is gone when killAll returns (the probe ran synchronously inside it), never
    // left for the drain's own timer, which never fires once the app is gone.
    const hook = '1373'
    const hookPings = () => cp.execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'Name=''PING.EXE''' | Where-Object { $_.CommandLine -like '*-l ${hook} *' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(Number).filter((n) => n > 0)
    try {
      const killed = []
      const wl = []
      let atKill = null
      let wr = null
      const inDrain = () => {
        const n = wr.killAll()
        atKill = { n, killed: [...killed], pings: hookPings() }
      }
      wr = M.createVerifyRunner({
        env: () => ({ ...process.env }), treeKill: (pid) => { killed.push(pid); M.treeKillSync(pid) }, platform: 'win32', log: (l) => wl.push(l),
        // The real one-shot timers; the drain armed (the shell exited) runs killAll at once, as an exit hook would.
        setTimer: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); if (ms === M.VERIFY_EXIT_DRAIN_MS) setImmediate(inDrain); return { clear: () => clearTimeout(h) } },
      })
      const t0 = Date.now()
      const pr = await wr(`start /b ping -t -l ${hook} 127.0.0.1 & echo main done`, dir, 60000, path.join(dir, 'verify', 't-5-3.log'))
      check(atKill && atKill.n === 1 && atKill.killed.length >= 1 && atKill.pings.length === 0, `win32: killAll in the drain tree-killed the leftover before it returned (${JSON.stringify(atKill)})`)
      check(pr.ok && pr.note === 'leftStopped' && pr.tail.includes('main done') && Date.now() - t0 < 20000, `win32: the verify settles ok with the note that it was stopped (${pr.note})`)
      check(wl.some((l) => /^verify exited 0: the exit hooks stopped \d+ process\(es\) it left$/.test(l)), 'win32: teams.log says the exit hooks stopped it')
      check(wr.live() === 0, 'win32: nothing tracked after it')
    } finally {
      for (const pid of hookPings()) { try { process.kill(pid) } catch { /* gone */ } }
    }
  }
  // The pid rule, on both platforms through the seams: until node saw the exit the whole tree (treeKill); after it,
  // never the pid alone (it may be another process's by then): the POSIX group; on Windows each direct child of the
  // dead shell created since the verify started (second round), never the shell's pid.
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const fakeChild = (rec, pid) => () => { const c = new EventEmitter(); c.pid = pid; c.stdout = new PassThrough(); c.stderr = new PassThrough(); rec.child = c; return c }
  const fakeTimer = (rec) => (fn, ms) => { const t = { fn, ms, cleared: false, clear() { t.cleared = true } }; rec.timers.push(t); return t }
  const SLACK = M.CREATION_CLOCK_SLACK_MS
  for (const [platform, kids] of [['linux', []], ['win32', [7777, 7778]], ['win32', []]]) {
    const rec = { treeKills: [], kills: [], timers: [], child: null, probes: [] }
    const before = Date.now()
    const fake = M.createVerifyRunner({
      env: () => ({}), platform, treeKill: (pid) => rec.treeKills.push(pid), kill: (pid, sig) => rec.kills.push([pid, sig]),
      spawn: fakeChild(rec, 4242),
      setTimer: fakeTimer(rec),
      // Never the real probe here: pid 4242 is a fake.
      children: async (pid, since, until) => { rec.probes.push([pid, since, until]); return kids },
      childrenSync: () => { throw new Error('no exit hook here') },
    })
    const pending = fake('x', dir, 60000, path.join(dir, 'verify', `t-3-${platform}-${kids.length}.log`))
    rec.child.stdout.write('hello\n')
    await new Promise((r) => setImmediate(r))
    const exitFrom = Date.now()
    rec.child.emit('exit', 0, null)
    const exitTo = Date.now()
    const drain = rec.timers.find((t) => t.ms === M.VERIFY_EXIT_DRAIN_MS && !t.cleared)
    check(!!drain && rec.timers.find((t) => t.ms === 60000).cleared, `${platform}: at the exit the timeout is cleared and the drain armed`)
    drain.fn()
    // The leftovers stopped close the pipes meanwhile: the drain still resolves it, with its note.
    rec.child.emit('close', 0, null)
    const fr = await pending
    check(fr.ok && !rec.treeKills.includes(4242), `${platform}: exit 0 with the pipes held stays ok and never tree-kills the exited pid`)
    same(rec.kills, platform === 'win32' ? [] : [[-4242, 'SIGKILL']], `${platform}: after the exit only the POSIX group is signalled`)
    check(fr.tail === 'hello', `${platform}: the tail is only what the command printed (${JSON.stringify(fr.tail)})`)
    if (platform === 'win32') {
      check(rec.probes.length === 1 && rec.probes[0][0] === 4242 && rec.probes[0][1] >= before && rec.probes[0][1] <= exitFrom, `win32: the children of the dead shell probed once, since the verify started (${JSON.stringify(rec.probes)})`)
      check(rec.probes[0][2] >= exitFrom + SLACK && rec.probes[0][2] <= exitTo + SLACK, `win32: B6 review, up to the moment the exit was seen plus the clock slack (${rec.probes[0][2] - exitFrom} ms after it)`)
      same(rec.treeKills, kids, `win32: each direct child tree-killed (${kids.length})`)
      check(fr.note === (kids.length ? 'leftStopped' : 'leftLetGo'), `win32: the note says ${kids.length ? 'stopped' : 'let go'} (${fr.note})`)
    } else check(rec.probes.length === 0 && fr.note === 'leftStopped', 'POSIX: the group kill, no child probe, the note says stopped')
    // killAll before the exit: the tree of the live child.
    const rec2 = { treeKills: [], child: null }
    const fake2 = M.createVerifyRunner({
      env: () => ({}), platform, treeKill: (pid) => rec2.treeKills.push(pid), kill: () => { throw new Error('never the bare pid') },
      spawn: () => { const c = new EventEmitter(); c.pid = 5151; c.stdout = new PassThrough(); c.stderr = new PassThrough(); rec2.child = c; return c },
      setTimer: () => ({ clear() {} }),
    })
    const p2 = fake2('x', dir, 60000, path.join(dir, 'verify', `t-4-${platform}.log`))
    check(fake2.killAll() === 1 && rec2.treeKills[0] === 5151, `${platform}: killAll before the exit tree-kills the child`)
    rec2.child.emit('exit', 1, null)
    rec2.child.emit('close', 1, null)
    check(!(await p2).ok, `${platform}: the killed verify is not ok`)
  }
  // B6 review: a pid reused after the exit. The real childrenSince filter on an injected CIM output with a child from
  // before the verify, one the verify started and one started by a process that took the dead shell's pid after its
  // exit: only the verify's own child is tree-killed.
  {
    const rec = { treeKills: [], timers: [], child: null }
    const iso = (ms) => new Date(ms).toISOString()
    let rows = ''
    const fake = M.createVerifyRunner({
      env: () => ({}), platform: 'win32', treeKill: (pid) => rec.treeKills.push(pid), kill: () => { throw new Error('never a signal on win32') },
      spawn: fakeChild(rec, 4343), setTimer: fakeTimer(rec),
      children: (pid, since, until) => M.childrenSince(pid, since, until, { platform: 'win32', execFile: (_f, _a, _o, cb) => cb(null, rows, '') }),
      childrenSync: () => { throw new Error('no exit hook here') },
    })
    const t0 = Date.now()
    const pending = fake('x', dir, 60000, path.join(dir, 'verify', 't-6-1.log'))
    const t1 = Date.now()
    await new Promise((r) => setTimeout(r, 40))
    rec.child.emit('exit', 0, null)
    const t2 = Date.now()
    rows = `7001|${iso(t0 - 5000)}\r\n7002|${iso(t1 + 5)}\r\n7003|${iso(t2 + SLACK + 200)}\r\n7004|${iso(t2 + 60000)}\r\n`
    rec.timers.find((t) => t.ms === M.VERIFY_EXIT_DRAIN_MS).fn()
    rec.child.emit('close', 0, null)
    const fr = await pending
    same(rec.treeKills, [7002], 'win32: only the child created between the start of the verify and its exit is killed, never one of a process that reused the pid after it (7003, 7004) nor of an older one (7001)')
    check(fr.ok && fr.note === 'leftStopped', `win32: the verify's own leftover stopped (${fr.note})`)
  }
  // B6 review: killAll (shutdownSync, prepareInstall) in the drain after the exit stops the leftovers at once, inside
  // killAll (on Windows the probe runs synchronously: the app exits right after and the drain's timer never fires),
  // whether the drain's own probe is still to come or already on its way; nothing is killed twice.
  for (const [platform, probing] of [['win32', false], ['win32', true], ['linux', false], ['linux', true]]) {
    const rec = { treeKills: [], kills: [], timers: [], child: null, probes: [], syncProbes: [] }
    let releaseProbe = null
    const fake = M.createVerifyRunner({
      env: () => ({}), platform, treeKill: (pid) => rec.treeKills.push(pid), kill: (pid, sig) => rec.kills.push([pid, sig]),
      spawn: fakeChild(rec, 4444), setTimer: fakeTimer(rec),
      children: (pid, since, until) => { rec.probes.push([pid, since, until]); return new Promise((r) => { releaseProbe = () => r([8001, 8002]) }) },
      childrenSync: (pid, since, until) => { rec.syncProbes.push([pid, since, until]); return [8001, 8002] },
    })
    const pending = fake('x', dir, 60000, path.join(dir, 'verify', `t-7-${platform}-${probing}.log`))
    const exitFrom = Date.now()
    rec.child.emit('exit', 0, null)
    const exitTo = Date.now()
    const drain = rec.timers.find((t) => t.ms === M.VERIFY_EXIT_DRAIN_MS)
    if (probing) drain.fn()
    const tag = `${platform}${probing ? ', its own probe on its way' : ''}`
    check(fake.killAll() === 1, `${tag}: killAll counts the verify in its drain`)
    if (platform === 'win32') {
      same(rec.treeKills, [8001, 8002], `${tag}: each leftover tree-killed inside killAll (the synchronous probe)`)
      check(rec.syncProbes.length === 1 && rec.syncProbes[0][0] === 4444 && rec.syncProbes[0][2] >= exitFrom + SLACK && rec.syncProbes[0][2] <= exitTo + SLACK, `${tag}: the same window, up to the exit plus the slack (${JSON.stringify(rec.syncProbes)})`)
    } else same(rec.kills, [[-4444, 'SIGKILL']], `${tag}: the POSIX group signalled inside killAll`)
    check(fake.killAll() === 1 && rec.syncProbes.length <= 1 && rec.kills.length <= 1, `${tag}: a second killAll stops nothing again`)
    if (probing && platform === 'win32') releaseProbe()
    else if (!probing) rec.child.emit('close', 0, null)
    const fr = await pending
    check(fr.ok && fr.note === 'leftStopped', `${tag}: exit 0 stays ok, the note says stopped (${fr.note})`)
    if (platform === 'win32') same(rec.treeKills, [8001, 8002], `${tag}: never killed twice (a pid killAll killed may be another process's by now)`)
    else same(rec.kills, [[-4444, 'SIGKILL']], `${tag}: the group signalled once`)
    if (!probing) check(drain.cleared && rec.probes.length === 0, `${tag}: the drain never ran (cleared when the pipes closed)`)
    check(fake.live() === 0 && fake.killAll() === 0, `${tag}: nothing tracked after it`)
  }
  // B6 review: the runner's own words are a note, never a line of the tail (the log keeps them in English).
  {
    const rec = { treeKills: [], timers: [], child: null }
    const logA = path.join(dir, 'verify', 't-8-1.log')
    const throwing = M.createVerifyRunner({ env: () => ({}), platform: process.platform, treeKill: () => undefined, spawn: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) }, setTimer: fakeTimer(rec) })
    const sf = await throwing('x', dir, 60000, logA)
    check(!sf.ok && !sf.timedOut && sf.note === 'spawnFailed' && sf.tail === '', `a command that cannot start: the note spawnFailed and an empty tail (${JSON.stringify(sf)})`)
    await until(() => fs.existsSync(logA) && fs.readFileSync(logA, 'utf8').includes('[exit'), 5000, 'the spawn failure log')
    check(fs.readFileSync(logA, 'utf8').includes('[the verify command could not start: ENOENT]'), 'the log keeps the English line with the code')
    const errored = M.createVerifyRunner({ env: () => ({}), platform: process.platform, treeKill: () => undefined, spawn: fakeChild(rec, 4545), setTimer: fakeTimer(rec) })
    const pe = errored('x', dir, 60000, path.join(dir, 'verify', 't-8-2.log'))
    rec.child.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }))
    const se = await pe
    check(!se.ok && se.note === 'spawnFailed' && !se.tail.includes('could not start'), `a spawn error event: spawnFailed, not in the tail (${JSON.stringify(se)})`)
    const rt = { treeKills: [], timers: [], child: null }
    const logB = path.join(dir, 'verify', 't-8-3.log')
    const slow = M.createVerifyRunner({ env: () => ({}), platform: process.platform, treeKill: (pid) => rt.treeKills.push(pid), kill: () => undefined, spawn: fakeChild(rt, 4646), setTimer: fakeTimer(rt) })
    const ps2 = slow('x', dir, 1000, logB)
    rt.child.stdout.write('still going\n')
    await new Promise((r) => setImmediate(r))
    rt.timers.find((t) => t.ms === 1000).fn()
    check(rt.treeKills[0] === 4646, 'the timeout kills the tree')
    rt.timers.find((t) => t.ms === M.VERIFY_KILL_DRAIN_MS).fn()
    const st = await ps2
    check(!st.ok && st.timedOut && st.note === 'timeoutKill' && st.tail === 'still going', `a tree that never closes its pipes after the kill: the note timeoutKill, the tail only the output (${JSON.stringify(st)})`)
    await until(() => fs.existsSync(logB) && fs.readFileSync(logB, 'utf8').includes('[exit'), 5000, 'the timeout log')
    check(fs.readFileSync(logB, 'utf8').includes('[killed at the timeout]'), 'the log keeps the English line')
  }
}

// ---- 5. TeamService ------------------------------------------------------------------------------------------
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
async function serviceWorld(name, o = {}) {
  const dir = path.join(TMP, name)
  const repo = makeRepo(path.join(dir, 'repo'), {})
  const data = path.join(dir, 'data')
  const clock = manualClock()
  const w = { dir, repo, data, clock, logs: [], emitted: [], notices: [], progress: [], gitCalls: [] }
  w.cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '' }, workspaces: [] }
  w.wtRoot = path.join(data, 'worktrees')
  w.manifest = new M.WorktreeManifest(path.join(data, 'worktrees.json'))
  w.wts = new M.WorktreeService({ runner, manifest: w.manifest, root: () => w.wtRoot, defaultRoot: () => w.wtRoot, removeOptions: { delayMs: 0, retries: 1 } })
  // Every git call of the service (not of the worktree service), to tell a cached read from a new one; `w.gate`
  // holds the calls it matches until it is released (a land that takes long).
  const counted = {
    run: (args, opts) => {
      w.gitCalls.push(args.join(' '))
      const g = w.gate
      if (g && g.match(args)) { g.hits++; return g.wait.then(() => runner.run(args, opts)) }
      // B6 review: a call made to fail as a slow or busy git would (a timeout, a transient error).
      const f = w.failGit
      if (f && f.match(args)) { f.hits = (f.hits ?? 0) + 1; return Promise.reject(f.error()) }
      return runner.run(args, opts)
    },
    info: (f) => runner.info(f),
    get running() { return runner.running },
  }
  // B6 review: a load of the definition made to fail (an enable that cannot load the team).
  w.loader = new M.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) })
  const realLoad = w.loader.load.bind(w.loader)
  w.loader.load = (...a) => (w.loadFails ? Promise.reject(new Error('the definition could not be read')) : realLoad(...a))
  w.svc = new M.TeamService({
    dataDir: () => data, config: () => w.cfg, git: counted, emit: (e) => w.emitted.push(e), openPath: async () => '', log: (l) => w.logs.push(l),
    now: () => clock.now, timerDeps: clock.deps, loader: w.loader, strict: true,
    worktrees: w.wts, notice: (n) => w.notices.push(n), sendIntegrate: (e) => w.progress.push(e), platform: process.platform,
    // B6 review, second round: `w.spawnImpl` makes a verify that cannot start (spawnFailed); else the real spawn.
    spawn: (...a) => (w.spawnImpl ?? cp.spawn)(...a),
  })
  services.push(w.svc)
  await w.svc.start(w.cfg)
  const probe = await w.svc.request({ op: 'setupProbe', dir: repo }, 'desktop')
  const draft = { ...probe.probe.defaults, goal: 'Una app de notas', verify: o.verify ?? '' }
  const prev = await w.svc.request({ op: 'setupPreview', repoRoot: repo, draft }, 'desktop')
  const wr = await w.svc.request({ op: 'setupWrite', repoRoot: repo, draft, previewHash: prev.preview.hash }, 'desktop')
  assert.ok(wr.ok, `setup ${name}: ${JSON.stringify(wr)}`)
  w.teamId = wr.teamId
  // The definition is committed (the setup's notCommitted warning): the task trees carry it, the checkout is clean.
  git(repo, 'add', '-A')
  git(repo, ...ID, 'commit', '-qm', 'team')
  w.rt = () => w.svc.team(w.teamId).store.rt
  w.task = (id) => w.rt().tasks.find((t) => t.id === id)
  w.req = (r, origin = 'desktop') => w.svc.request({ teamId: w.teamId, ...r }, origin)
  /** A task in review/integrating with an approved final, a pending integrate approval and its worktree (edits committed). */
  w.integratingTask = async (title, edits, extra = {}) => {
    const r = await w.req({ op: 'createTask', task: { title, assignee: 'dev' } })
    assert.ok(r.ok, JSON.stringify(r))
    const id = r.task.id
    const rt = w.rt()
    const repoObj = w.svc.repoOf(w.teamId, 'main')
    const made = await w.svc.taskWorktrees.ensure({ id: w.teamId, gen: rt.gen }, repoObj, w.task(id))
    assert.ok(made.ok, JSON.stringify(made))
    for (const [f, text] of Object.entries(edits)) write(path.join(made.worktree.path, f), text)
    git(made.worktree.path, 'add', '-A')
    git(made.worktree.path, ...ID, 'commit', '-qm', `work ${id}`)
    const store = w.svc.team(w.teamId).store
    const cur = store.rt
    const n = cur.nextIds.approval
    const now = clock.now
    const t = { ...cur.tasks.find((x) => x.id === id), state: 'review', phase: 'integrating', frozen: true, worktree: made.worktree, plan: { rev: 1, text: 'p', status: 'approved', small: false, at: now } }
    const ap = (aid, kind, state, payload) => ({ id: aid, taskId: id, state, decider: 'user', createdAt: now, createdBy: { kind: 'system' }, kind, payload, ...(state !== 'pending' ? { decidedAt: now, decidedBy: USER } : {}) })
    let next = {
      ...cur,
      tasks: cur.tasks.map((x) => (x.id === id ? t : x)),
      approvals: [...cur.approvals, ap(`a-${n}`, 'final', 'approved', { hasWorktree: true, summary: 'ok' }), ap(`a-${n + 1}`, 'integrate', 'pending', { branch: made.worktree.branch, base: made.worktree.baseBranch })],
      queue: cur.queue.filter((q) => q.taskId !== id),
      nextIds: { ...cur.nextIds, approval: n + 2 },
    }
    if (extra.card) {
      const c = M.openSystemCard(next, { why: 'failure', actions: ['dismiss'], taskId: id }, { now })
      next = c.rt
    }
    store.commit({ ok: true, rt: next, effects: [], result: undefined }, ['task'])
    return { id, wt: made.worktree, integrateApproval: `a-${n + 1}` }
  }
  w.tipOf = (wt) => git(repo, 'rev-parse', `refs/heads/${wt.branch}`).trim()
  w.integrate = async (id, wt, expectTip) => {
    const r = await w.req({ op: 'integrate', taskId: id, expectTip: expectTip ?? w.tipOf(wt) })
    assert.ok(r.ok, `integrate: ${JSON.stringify(r)}`)
    await w.svc.integrateIdle()
    return r.integrationId
  }
  return w
}

async function serviceChecks() {
  const VERIFY = `${NODE} verify.js`
  const w = await serviceWorld('svc', { verify: VERIFY })
  // Unconfirmed: the preview shows the command, the integrate skips it.
  const a = await w.integratingTask('Agregar login', { 'login.txt': 'login\n' }, { card: true })
  const pv = await w.req({ op: 'integratePreview', taskId: a.id })
  check(pv.ok && pv.preview.ahead === 1 && pv.preview.tip === w.tipOf(a.wt) && !pv.preview.error, `integratePreview through teams:req (${JSON.stringify(pv).slice(0, 200)})`)
  same(pv.preview.verify, { command: VERIFY, confirmed: false }, 'the preview names the trusted verify, unconfirmed')
  same(pv.preview.landing, { mode: 'ffOnly' }, 'the preview landing')
  same(await w.req({ op: 'integratePreview', taskId: a.id }, 'phone'), { ok: false, error: 'bad_request' }, 'Integrar is not a phone op (decision 50)')
  same(await w.req({ op: 'integrate', taskId: a.id, expectTip: w.tipOf(a.wt) }, 'phone'), { ok: false, error: 'bad_request' }, 'nor integrate')
  const ia = await w.integrate(a.id, a.wt)
  check(/^i-[0-9a-f]{12}$/.test(ia), 'integrate answers its integrationId')
  const ta = w.task(a.id)
  check(ta.state === 'done' && ta.integrated?.landed === 'ffOnly' && !ta.integrate, `T13 through the service: done and integrated (${JSON.stringify(ta.integrate ?? ta.integrated)})`)
  const evs = w.progress.filter((e) => e.integrationId === ia)
  check(evs.length > 0 && evs.every((e) => e.teamId === w.teamId && e.taskId === a.id) && evs.some((e) => e.step === 'verify' && e.state === 'skipped'), 'teams:integrateProgress of that id; the unconfirmed verify skipped')
  check(w.rt().approvals.find((x) => x.id === a.integrateApproval).state === 'approved' && w.rt().cards.filter((c) => c.taskId === a.id).every((c) => c.state !== 'open'), 'the integrate approval approved, the task card closed (closeTaskNeeds)')
  check(w.notices.some((n) => n.tag === `team:${w.teamId}:integrated:${a.id}` && n.body.includes(a.id)), 'the integrated notice (teams.push.integrated)')
  check(git(w.repo, 'log', '-1', '--format=%s').trim().startsWith(`Merge ${a.wt.branch}: Agregar login (${a.id})`), 'a merge commit on main')
  check(w.svc.locks.size === 0, 'no lock left after the integrate')
  // removeWorktree of the integrated task.
  same(await w.req({ op: 'removeWorktree', taskId: a.id }), { ok: true }, 'removeWorktree after the integrate')
  check(!fs.existsSync(a.wt.path) && gitTry(w.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${a.wt.branch}`) === null && !w.manifest.find(a.wt.path) && w.task(a.id).worktree === undefined, 'the tree, its branch and its manifest entry gone; the task forgets it')
  same(await w.req({ op: 'removeWorktree', taskId: a.id }), { ok: false, error: 'missing_worktree' }, 'a second remove: missing_worktree')

  // B6 integration, item 5: setupProbe fills suggestedVerify from the same detection (the setup dialog's chip).
  const npmRepo = makeRepo(path.join(w.dir, 'npm-repo'), {})
  write(path.join(npmRepo, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'b', test: 't' } }))
  const sp = await w.svc.request({ op: 'setupProbe', dir: npmRepo }, 'desktop')
  check(sp.ok && sp.probe.suggestedVerify === 'npm test', `setupProbe: suggestedVerify of the repo root (${sp.probe?.suggestedVerify})`)
  const sp2 = await w.svc.request({ op: 'setupProbe', dir: w.repo }, 'desktop')
  check(sp2.ok && !('suggestedVerify' in sp2.probe), 'a root with no build file: no suggestedVerify')

  // B6 integration, item 6: the integrate approval carries payload.ahead and the task op the live tree (exists,
  // ahead, behind), read in the async ops with short timeouts and cached per tip; the board runs no git.
  const live = await w.integratingTask('Vivo', { 'v1.txt': 'v\n' })
  const liveCalls = () => w.gitCalls.filter((c) => c.startsWith('for-each-ref --format=%(objectname) %(refname)') || c.startsWith('rev-list --left-right --count'))
  const integrateRow = async () => (await w.req({ op: 'needs' })).needs.approvals.find((x) => x.payload.kind === 'integrate' && x.taskId === live.id)
  check((await integrateRow())?.payload.ahead === 1, 'the integrate approval of Te necesita carries payload.ahead (1 commit)')
  write(path.join(live.wt.path, 'v2.txt'), 'v2\n')
  git(live.wt.path, 'add', '-A')
  git(live.wt.path, ...ID, 'commit', '-qm', 'v2')
  check((await integrateRow())?.payload.ahead === 2, 'a new commit on the branch: ahead 2 (the cache follows the tip)')
  w.gitCalls.length = 0
  check((await w.req({ op: 'board' })).ok && w.gitCalls.length === 0, 'the board runs no git')
  const tv = await w.req({ op: 'task', taskId: live.id })
  same({ exists: tv.task.worktree.exists, ahead: tv.task.worktree.ahead, behind: tv.task.worktree.behind }, { exists: true, ahead: 2, behind: 0 }, 'the task op: the tree live (exists, ahead, behind)')
  check(tv.task.approvals.find((x) => x.payload.kind === 'integrate')?.payload.ahead === 2, "the drawer's integrate approval carries ahead too")
  w.gitCalls.length = 0
  await w.req({ op: 'task', taskId: live.id })
  same(liveCalls().map((c) => c.split(' ')[0]), ['for-each-ref'], 'same tips: one for-each-ref, the counts from the cache')
  write(path.join(w.repo, 'main-live.txt'), 'main\n')
  git(w.repo, 'add', 'main-live.txt')
  git(w.repo, ...ID, 'commit', '-qm', 'main moves')
  w.gitCalls.length = 0
  const tb1 = await w.req({ op: 'task', taskId: live.id })
  check(tb1.task.worktree.behind === 1 && tb1.task.worktree.ahead === 2 && liveCalls().length === 2, 'the base moved: counted again (behind 1)')
  fs.rmSync(live.wt.path, { recursive: true, force: true })
  const tg = await w.req({ op: 'task', taskId: live.id })
  check(tg.task.worktree.exists === false && tg.task.worktree.ahead === 2, 'the folder gone: exists false, the branch still counted')
  git(w.repo, 'worktree', 'prune')

  // confirmVerify: only the trusted command.
  same(await w.req({ op: 'confirmVerify', repoId: 'main', command: 'npm test' }), { ok: false, error: 'conflict', reason: 'stale' }, 'confirmVerify of another command: stale')
  same(await w.req({ op: 'confirmVerify', repoId: 'docs', command: VERIFY }), { ok: false, error: 'not_found' }, 'confirmVerify of an unknown repo: not_found')
  const cv = await w.req({ op: 'confirmVerify', repoId: 'main', command: VERIFY })
  check(cv.ok && cv.team.verify.find((v) => v.repoId === 'main').confirmed === true && w.rt().verifyConfirmed.main.command === VERIFY, 'confirmVerify of the trusted command: confirmed in the TeamView')

  // A failing verify, then askRebase verify.
  const b = await w.integratingTask('Romper tests', { FAIL: 'the suite broke\n' })
  const ib = await w.integrate(b.id, b.wt)
  const tb = w.task(b.id)
  check(tb.state === 'review' && tb.phase === 'integrating' && tb.integrate.state === 'failed' && tb.integrate.error === 'verify_failed' && tb.integrate.tail.includes('boom: the suite broke'), 'a confirmed verify runs: T14 verify_failed with its tail')
  check(w.progress.some((e) => e.integrationId === ib && e.step === 'verify' && e.state === 'failed' && e.error === 'verify_failed'), 'the failed verify event')
  check(w.notices.some((n) => n.tag === `team:${w.teamId}:integrateFailed:${b.id}`), 'the integrateFailed notice')
  check(w.rt().approvals.find((x) => x.id === b.integrateApproval).state === 'pending', 'the integrate approval still waits (Te necesita keeps the row)')
  same(await w.req({ op: 'askRebase', taskId: b.id, why: 'conflict' }), { ok: false, error: 'conflict', reason: 'stale' }, 'askRebase conflict after a verify failure: stale')
  same(await w.req({ op: 'askRebase', taskId: b.id, why: 'verify' }), { ok: true }, 'askRebase verify')
  const tb2 = w.task(b.id)
  const cb = (w.rt().comments[b.id] ?? []).at(-1)
  check(tb2.state === 'doing' && tb2.phase === 'executing' && tb2.next?.reason === 'rebase' && cb?.sys?.key === 'rebaseVerify' && cb.sys.vars.tail.includes('boom') && cb.forAgent === 'dev', 'T15: back to the Dev with the rebaseVerify comment')
  check(w.rt().approvals.find((x) => x.id === b.integrateApproval).state === 'cancelled', 'T15 cancels the integrate approval')

  // B6 review, second round: a confirmed verify that cannot start (spawnFailed: it printed nothing) is stored with its
  // note; the drawer and the Te necesita row read it, and askRebase tells the Dev in the runner's words.
  const nv = await w.integratingTask('No arranca', { 'nv.txt': 'nv\n' })
  w.spawnImpl = () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
  await w.integrate(nv.id, nv.wt)
  w.spawnImpl = null
  const tnv = w.task(nv.id).integrate
  same(tnv && { state: tnv.state, error: tnv.error, step: tnv.step, verifyNote: tnv.verifyNote, tail: tnv.tail, landing: tnv.landing }, { state: 'failed', error: 'verify_failed', step: 'verify', verifyNote: 'spawnFailed' }, 'a verify that could not start: the task keeps verifyNote spawnFailed, no tail, no land mode')
  const dnv = await w.req({ op: 'task', taskId: nv.id })
  check(dnv.ok && dnv.task.integrate?.verifyNote === 'spawnFailed' && dnv.task.integrate.step === 'verify', 'the task op (the drawer) carries the stored verifyNote and step')
  const rowNv = (await w.req({ op: 'needs' })).needs.approvals.find((x) => x.payload.kind === 'integrate' && x.taskId === nv.id)
  same(rowNv && { e: rowNv.payload.lastError, s: rowNv.payload.lastStep, l: rowNv.payload.lastLanding }, { e: 'verify_failed', s: 'verify' }, 'the Te necesita row: lastError and lastStep, no lastLanding')
  same(await w.req({ op: 'askRebase', taskId: nv.id, why: 'verify' }), { ok: true }, 'askRebase verify of a verify that could not start')
  const cnv = (w.rt().comments[nv.id] ?? []).at(-1)
  check(cnv?.sys?.key === 'rebaseVerify' && cnv.sys.vars.tail === '[the verify command could not start]' && cnv.forAgent === 'dev', `the rebaseVerify comment says why in the runner's words (${JSON.stringify(cnv?.sys)})`)

  // An ffOnly land that times out: the task keeps the step and the land mode, the row names them, the checkout as it was.
  const lt = await w.integratingTask('Tarda en llegar', { 'lt.txt': 'lt\n' })
  const beforeLt = snap(w.repo)
  w.failGit = { match: (args) => args.includes('--ff-only'), error: () => Object.assign(new Error('timeout'), { name: 'GitExecError', code: 'timeout', stderr: '', stdout: '', exitCode: null, maxBuffer: false }) }
  await w.integrate(lt.id, lt.wt)
  check(w.failGit.hits === 1, 'the ff-only land ran once (and timed out)')
  w.failGit = null
  const tlt = w.task(lt.id).integrate
  same(tlt && { error: tlt.error, step: tlt.step, landing: tlt.landing }, { error: 'timeout', step: 'land', landing: 'ffOnly' }, 'an ffOnly land timeout: the task keeps step land and landing ffOnly')
  same(snap(w.repo), beforeLt, 'the land timeout through the service: the checkout byte identical')
  const rowLt = (await w.req({ op: 'needs' })).needs.approvals.find((x) => x.payload.kind === 'integrate' && x.taskId === lt.id)
  same(rowLt && { e: rowLt.payload.lastError, s: rowLt.payload.lastStep, l: rowLt.payload.lastLanding }, { e: 'timeout', s: 'land', l: 'ffOnly' }, 'the Te necesita row: lastError timeout, lastStep land, lastLanding ffOnly')
  check(w.progress.some((e) => e.taskId === lt.id && e.step === 'land' && e.state === 'failed' && e.landing === 'ffOnly'), 'the failed land progress event names the ffOnly land')
  await w.integrate(lt.id, lt.wt)
  check(w.task(lt.id).state === 'done', 'Integrar again lands it')

  // A conflict, then askRebase conflict.
  const c = await w.integratingTask('Chocar', { 'conflict.txt': 'branch\n' })
  write(path.join(w.repo, 'conflict.txt'), 'main\n')
  git(w.repo, ...ID, 'commit', '-qam', 'main edit')
  const before = snap(w.repo)
  await w.integrate(c.id, c.wt)
  same(snap(w.repo), before, 'a conflict through the service leaves the checkout byte identical')
  const tc = w.task(c.id)
  check(tc.integrate.error === 'merge_conflict' && tc.integrate.files?.[0] === 'conflict.txt', 'T14 merge_conflict with its files')
  const ac = await w.req({ op: 'askRebase', taskId: c.id, why: 'conflict' })
  const cc = (w.rt().comments[c.id] ?? []).at(-1)
  check(ac.ok && cc.sys.key === 'rebaseConflict' && cc.sys.vars.files === 'conflict.txt' && w.task(c.id).next?.mode === 'exec', 'T15: the rebaseConflict comment names the file')

  // A moved tip: the integrate stops at preflight (busy: look again), the checkout untouched.
  const d = await w.integratingTask('Mover', { 'm.txt': 'm\n' })
  const stale = w.tipOf(d.wt)
  write(path.join(d.wt.path, 'm2.txt'), 'later\n')
  git(d.wt.path, 'add', '-A')
  git(d.wt.path, ...ID, 'commit', '-qm', 'later')
  await w.integrate(d.id, d.wt, stale)
  check(w.task(d.id).integrate.error === 'busy' && w.task(d.id).integrate.step === 'preflight', 'a tip that moved since the preview: failed busy at preflight')
  // removeWorktree refusals: not done, then a cancelled task with commits its base lacks.
  same(await w.req({ op: 'removeWorktree', taskId: d.id }), { ok: false, error: 'conflict', reason: 'stale' }, 'removeWorktree of a task not over: stale')
  const moved = await w.req({ op: 'moveTask', taskId: d.id, baseRev: w.task(d.id).rev, to: 'cancelled' })
  check(moved.ok && w.task(d.id).state === 'cancelled', 'the task cancelled')
  same(await w.req({ op: 'removeWorktree', taskId: d.id }), { ok: false, error: 'dirty_worktree', detail: 'commits' }, 'a branch with commits the base lacks is never dropped')
  // B6 review: a slow or failing git never reads as "the branch is gone" (the remove would then drop its commits).
  const gitErr = (o) => () => Object.assign(new Error(o.code), { name: 'GitExecError', code: o.code, stderr: o.stderr ?? '', stdout: o.stdout ?? '', exitCode: o.exitCode ?? null, maxBuffer: false })
  const verifyRef = (branch) => (args) => args[0] === 'rev-parse' && args.includes('--quiet') && args.at(-1) === `refs/heads/${branch}^{commit}`
  w.failGit = { match: verifyRef(d.wt.branch), error: gitErr({ code: 'timeout' }) }
  same(await w.req({ op: 'removeWorktree', taskId: d.id }), { ok: false, error: 'dirty_worktree', detail: 'commits' }, 'a rev-parse that would time out: the inspect\'s tip proves the branch is there, its commits are kept')
  check(gitTry(w.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${d.wt.branch}`) !== null && fs.existsSync(d.wt.path), 'the branch and the tree are still there')
  const loses = (branch, knownTip) => w.svc.branchLoses(w.repo, branch, 'main', knownTip)
  w.failGit = { match: verifyRef(d.wt.branch), error: gitErr({ code: 'timeout' }) }
  check((await loses(d.wt.branch)) === true && w.failGit.hits === 1, 'branchLoses: a timeout of its rev-parse keeps the branch (unknown counts as lost)')
  w.failGit = { match: verifyRef(d.wt.branch), error: gitErr({ code: 'git_error', exitCode: 128, stderr: 'fatal: unable to read' }) }
  check((await loses(d.wt.branch)) === true, 'branchLoses: a transient error (exit 128) keeps the branch')
  w.failGit = { match: verifyRef(d.wt.branch), error: gitErr({ code: 'git_error', exitCode: 1, stdout: 'garbage\n' }) }
  check((await loses(d.wt.branch)) === true, 'branchLoses: exit 1 that printed something is not a missing ref')
  w.failGit = { match: verifyRef(d.wt.branch), error: gitErr({ code: 'timeout' }) }
  check((await loses(d.wt.branch, w.tipOf(d.wt))) === true && w.failGit.hits === undefined, 'branchLoses: a known tip skips the rev-parse (the branch is there) and its commits count')
  w.failGit = null
  check((await loses('sn/never-made')) === false, 'branchLoses: git\'s own missing ref (exit 1, nothing printed) loses nothing')
  check((await loses('main', w.tipOf({ branch: 'main' }))) === false, 'branchLoses: a branch already in the base loses nothing')
  write(path.join(d.wt.path, 'dirty.txt'), 'uncommitted\n')
  same(await w.req({ op: 'removeWorktree', taskId: d.id }), { ok: false, error: 'dirty_worktree', detail: 'files' }, 'uncommitted files are never dropped')
  check(fs.existsSync(d.wt.path), 'the refused tree is still there')

  // Labs off mid-integrate: the end commit is written to disk, a Labs on finds it done (never interrupted).
  const flag = path.join(w.dir, 'release.flag')
  const e = await w.integratingTask('Esperar', { WAIT: `${flag}\n`, 'e.txt': 'e\n' })
  const ie = await w.req({ op: 'integrate', taskId: e.id, expectTip: w.tipOf(e.wt) })
  check(ie.ok, 'an integrate that waits in its verify')
  await until(() => w.progress.some((x) => x.integrationId === ie.integrationId && x.step === 'verify' && x.state === 'running'), 20000, 'the verify running')
  same(await w.req({ op: 'remove' }), { ok: false, error: 'busy', detail: 'integrate' }, 'removing the team while an integrate runs: busy')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  check(w.svc.pendingTimers === 0, 'Labs off: zero deadline keys while the integrate runs')
  fs.writeFileSync(flag, 'go')
  await w.svc.integrateIdle()
  const disk = JSON.parse(fs.readFileSync(path.join(w.data, 'teams', w.teamId, 'state.json'), 'utf8'))
  const te = disk.tasks.find((x) => x.id === e.id)
  check(te.state === 'done' && te.integrated?.landed === 'ffOnly', `the end commit of the integrate in flight reached state.json while Labs was off (${te.state})`)
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(() => !!w.svc.team(w.teamId), 20000, 'enabled again')
  check(w.task(e.id).state === 'done' && !w.task(e.id).integrate, 'Labs on: the task is done, not interrupted')

  // Labs off, on and off again mid-integrate: the end commit lands on the newest store, never over what was written since.
  const flag2 = path.join(w.dir, 'release2.flag')
  const g = await w.integratingTask('Esperar dos veces', { WAIT: `${flag2}\n`, 'g.txt': 'g\n' })
  const ig = await w.req({ op: 'integrate', taskId: g.id, expectTip: w.tipOf(g.wt) })
  check(ig.ok, 'a second integrate that waits in its verify')
  await until(() => w.progress.some((x) => x.integrationId === ig.integrationId && x.step === 'verify' && x.state === 'running'), 20000, 'the second verify running')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(() => !!w.svc.team(w.teamId), 20000, 'enabled again (second toggle)')
  check(w.task(g.id).integrate?.state === 'running', 'the integrate in flight across the toggle is still running (never interrupted)')
  const between = await w.req({ op: 'createTask', task: { title: 'Escrita entre medio' } })
  check(between.ok, 'a task written while the integrate runs')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  fs.writeFileSync(flag2, 'go')
  await w.svc.integrateIdle()
  const disk2 = JSON.parse(fs.readFileSync(path.join(w.data, 'teams', w.teamId, 'state.json'), 'utf8'))
  check(disk2.tasks.find((x) => x.id === g.id)?.state === 'done' && disk2.tasks.some((x) => x.id === between.task.id), 'the end commit after a second Labs off lands on the newest store: the task done and the task written since kept')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(() => !!w.svc.team(w.teamId), 20000, 'enabled again (after the second toggle)')
  check(w.task(g.id).state === 'done' && !!w.task(between.task.id), 'Labs on: both are there')

  // B6 review: Labs off and on again mid-integrate with an enable that cannot load this team (the service live, the
  // team not loaded): the end commit still reaches state.json at once (the flush deadline only reaches a loaded store).
  const flag3 = path.join(w.dir, 'release3.flag')
  const h = await w.integratingTask('Esperar sin cargar', { WAIT: `${flag3}\n`, 'h.txt': 'h\n' })
  const ih = await w.req({ op: 'integrate', taskId: h.id, expectTip: w.tipOf(h.wt) })
  check(ih.ok, 'a third integrate that waits in its verify')
  await until(() => w.progress.some((x) => x.integrationId === ih.integrationId && x.step === 'verify' && x.state === 'running'), 20000, 'the third verify running')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  const logsAt = w.logs.length
  w.loadFails = true
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(() => w.logs.slice(logsAt).includes('enabled teams=0'), 20000, 'an enable that could not load the team')
  check(!w.svc.team(w.teamId) && w.logs.slice(logsAt).some((l) => l.startsWith(`load ${w.teamId} failed`)), 'the service is on and the team is not loaded')
  fs.writeFileSync(flag3, 'go')
  await w.svc.integrateIdle()
  const disk3 = JSON.parse(fs.readFileSync(path.join(w.data, 'teams', w.teamId, 'state.json'), 'utf8')).tasks.find((x) => x.id === h.id)
  check(disk3?.state === 'done' && disk3.integrated?.landed === 'ffOnly' && !disk3.integrate, `the end commit reached state.json while the service is on and the team not loaded (${JSON.stringify(disk3?.integrate ?? disk3?.state)})`)
  w.loadFails = false
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(() => !!w.svc.team(w.teamId), 20000, 'enabled again (the team loads)')
  check(w.task(h.id).state === 'done' && !w.task(h.id).integrate, 'loaded again: done, never interrupted')

  // A quit mid-integrate: running at load -> failed interrupted; the sweep clears what it left.
  const f = await w.integratingTask('Cortar', { 'f.txt': 'f\n' })
  const store = w.svc.team(w.teamId).store
  const begun = F.beginIntegrate(store.rt, f.id, { now: w.clock.now })
  store.commit(begun, ['task'])
  const leftover = path.join(w.data, 'teams', w.teamId, 'integrate', `${f.id}-123`)
  git(w.repo, 'worktree', 'add', '-q', '--detach', leftover, 'main')
  write(path.join(w.data, 'teams', w.teamId, 'integrate', `${f.id}-123.msg`), 'Merge\n')
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: false, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  w.cfg = { ...w.cfg, settings: { ...w.cfg.settings, labs: { teams: true, consoleChat: false } } }
  w.svc.setConfig(w.cfg)
  await until(() => !!w.svc.team(w.teamId), 20000, 'enabled again')
  await w.svc.integrateIdle()
  const tf = w.task(f.id)
  check(tf.integrate?.state === 'failed' && tf.integrate.error === 'interrupted' && tf.phase === 'integrating', 'a running integrate found at load: failed interrupted')
  check(w.logs.some((l) => l.includes(`interrupted ${f.id}`)), 'teams.log names it')
  same(fs.readdirSync(path.join(w.data, 'teams', w.teamId, 'integrate')), [], 'the sweep at enable removed the leftover temp tree and message file')
  check(!git(w.repo, 'worktree', 'list', '--porcelain').includes(`${f.id}-123`), 'and git no longer lists it')
  // It integrates again from there.
  await w.integrate(f.id, f.wt)
  check(w.task(f.id).state === 'done', 'an interrupted integrate is retried to done')
  check(w.svc.locks.size === 0, 'no lock left at the end')
}

/**
 * B6 integration, item 1: the exit hooks. shutdownSync tree-kills the verify in flight and the integrate ends
 * interrupted (at the load after the restart at the latest), never landed; prepareInstall does the same without
 * freezing, a new Integrar answers busy {install} until installAborted. The close confirm counts the integrate.
 */
async function haltChecks() {
  const VERIFY = `${NODE} verify.js`
  const w = await serviceWorld('halt', { verify: VERIFY })
  check((await w.req({ op: 'confirmVerify', repoId: 'main', command: VERIFY })).ok, 'the verify confirmed')
  const flag = path.join(w.dir, 'never.flag')
  const a = await w.integratingTask('Cortar al salir', { WAIT: `${flag}\n`, 'a.txt': 'a\n' })
  const before = snap(w.repo)
  check(w.svc.integrateCount() === 0, 'no integrate in flight at first')
  check((await w.req({ op: 'integrate', taskId: a.id, expectTip: w.tipOf(a.wt) })).ok, 'an integrate that waits in its verify')
  await until(() => fs.existsSync(`${flag}.pid`), 30000, 'the verify running')
  const vpid = Number(fs.readFileSync(`${flag}.pid`, 'utf8'))
  check(w.svc.integrateCount() === 1 && w.svc.liveRunCount() === 0, 'the close confirm counts the integrate in flight next to the live runs')
  const closeEs = M.mainTLang('es', 'teams.close.runs', { runs: 2, integrates: 1 })
  const closeEn = M.mainTLang('en', 'teams.close.runs', { runs: 2, integrates: 1 })
  check(closeEs.includes('2 corrida(s) y 1 integración(es)') && closeEn.includes('2 run(s) and 1 integration(s)'), `the close confirm text names both, es and en (${closeEs} / ${closeEn})`)
  w.svc.shutdownSync('test')
  await until(() => !M.pidAlive(vpid), 10000, 'the verify tree killed by shutdownSync')
  check(!M.pidAlive(vpid), 'shutdownSync tree-killed the verify')
  await w.svc.integrateIdle()
  same(snap(w.repo), before, 'nothing landed: the user checkout byte identical')
  check(w.svc.integrateCount() === 0, 'the integrate is over')
  check(w.logs.some((l) => l.includes('integrate halted (test) integrates=1 verifies=1')), 'teams.log: halted with its verify')
  const disk = JSON.parse(fs.readFileSync(path.join(w.data, 'teams', w.teamId, 'state.json'), 'utf8')).tasks.find((x) => x.id === a.id)
  check(disk.integrate?.state === 'running' || disk.integrate?.error === 'interrupted', `on disk: interrupted or still running for the load to read (never verify_failed): ${JSON.stringify(disk.integrate)}`)
  w.svc.thaw()
  await until(() => !!w.svc.team(w.teamId), 20000, 'enabled again')
  const ta = w.task(a.id)
  check(ta.integrate?.state === 'failed' && ta.integrate.error === 'interrupted' && ta.phase === 'integrating', `after the restart: failed interrupted (${JSON.stringify(ta.integrate)})`)
  // prepareInstall: the same kill, not frozen (the end is recorded at once); a new Integrar waits for installAborted.
  const flag2 = path.join(w.dir, 'later.flag')
  const b = await w.integratingTask('Cortar al instalar', { WAIT: `${flag2}\n`, 'b.txt': 'b\n' })
  check((await w.req({ op: 'integrate', taskId: b.id, expectTip: w.tipOf(b.wt) })).ok, 'a second integrate that waits in its verify')
  await until(() => fs.existsSync(`${flag2}.pid`), 30000, 'the second verify running')
  const vpid2 = Number(fs.readFileSync(`${flag2}.pid`, 'utf8'))
  // A verify is not a land: the setup does not wait for it (second round), it stops as before.
  const waited = await w.svc.prepareInstall()
  check(waited === 0, `prepareInstall waits for no land when none began (${waited})`)
  await w.svc.integrateIdle()
  await until(() => !M.pidAlive(vpid2), 10000, 'the verify tree killed by prepareInstall')
  const tb = w.task(b.id)
  check(tb.integrate?.state === 'failed' && tb.integrate.error === 'interrupted' && tb.integrate.step === 'verify', `prepareInstall: interrupted at its verify (${JSON.stringify(tb.integrate)})`)
  same(snap(w.repo), before, 'still nothing landed')
  same(await w.req({ op: 'integrate', taskId: b.id, expectTip: w.tipOf(b.wt) }), { ok: false, error: 'busy', detail: 'install' }, 'a new Integrar while installing: busy {install}')
  w.svc.installAborted()
  fs.writeFileSync(flag2, 'go')
  await w.integrate(b.id, b.wt)
  check(w.task(b.id).state === 'done' && w.task(b.id).integrated?.landed === 'ffOnly', 'after installAborted it integrates to done')

  // B6 integration, second round: a land already running when the installer is about to close the app is waited for,
  // to its end commit (a git killed mid checkout can leave it half updated), with a notice; never cut.
  const c = await w.integratingTask('Aterrizar al instalar', { 'c.txt': 'c\n' })
  let release
  w.gate = { match: (args) => args.includes('--ff-only'), hits: 0, wait: new Promise((r) => { release = r }) }
  check((await w.req({ op: 'integrate', taskId: c.id, expectTip: w.tipOf(c.wt) })).ok, 'an integrate whose land is held')
  await until(() => w.gate.hits > 0, 30000, 'the land running')
  let settled = null
  const install = w.svc.prepareInstall().then((n) => { settled = n })
  await new Promise((r) => setTimeout(r, 400))
  check(settled === null && w.task(c.id).integrate?.state === 'running' && w.task(c.id).integrate.step === 'land', 'prepareInstall has not resolved while the land runs')
  check(w.notices.some((n) => n.tag === `team:${w.teamId}:installWait:${c.id}` && n.body.includes(c.id)), 'the notice says the update waits for that land (teams.push.installWait)')
  check(w.logs.some((l) => l === 'install waits for integrate land(s)=1'), 'teams.log: the install waits for one land')
  release()
  await install
  check(settled === 1, `prepareInstall resolved once the land ended, with the one it waited for (${settled})`)
  const tc = w.task(c.id)
  check(tc.state === 'done' && tc.integrated?.landed === 'ffOnly' && !tc.integrate, `the land finished and its end was recorded: done (${JSON.stringify(tc.integrate ?? tc.integrated)})`)
  const discC = JSON.parse(fs.readFileSync(path.join(w.data, 'teams', w.teamId, 'state.json'), 'utf8')).tasks.find((x) => x.id === c.id)
  check(discC.state === 'done' && discC.integrated?.landed === 'ffOnly', 'and written to state.json before the setup runs')
  check(git(w.repo, 'log', '-1', '--format=%s').trim().startsWith(`Merge ${c.wt.branch}:`) && git(w.repo, 'status', '--porcelain') === '', 'the merge on main, the checkout clean')
  w.gate = null
  w.svc.installAborted()
  const dash = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)
  const waitEs = M.mainTLang('es', 'teams.push.installWait', { task: 't-9' })
  const waitEn = M.mainTLang('en', 'teams.push.installWait', { task: 't-9' })
  check(waitEs.includes('t-9') && waitEn.includes('t-9') && waitEs !== waitEn && /actualización/.test(waitEs) && /update/.test(waitEn) && !dash.test(waitEs + waitEn), `teams.push.installWait in es and en (${waitEs} / ${waitEn})`)
}

/**
 * B6 integration, second round, item 3: the live tree reads of the task and needs ops never wait behind a busy git
 * semaphore (both slots held, as by a long land): the drawer answers at once with the counts last read (or none).
 */
async function busyGitChecks() {
  const w = await serviceWorld('busy')
  const a = await w.integratingTask('Leida antes', { 'a1.txt': 'a\n' })
  const fresh = await w.integratingTask('Nunca leida', { 'f1.txt': 'f\n' })
  const t1 = await w.req({ op: 'task', taskId: a.id })
  same({ exists: t1.task.worktree.exists, ahead: t1.task.worktree.ahead, behind: t1.task.worktree.behind }, { exists: true, ahead: 1, behind: 0 }, 'read once with the semaphore free: exists, ahead 1, behind 0')
  write(path.join(a.wt.path, 'a2.txt'), 'a2\n')
  git(a.wt.path, 'add', '-A')
  git(a.wt.path, ...ID, 'commit', '-qm', 'a2')
  // Both slots of the git semaphore held (a git that reads a stdin nobody closes, until its timeout).
  const HOLD_MS = 6000
  const holds = [0, 1].map(() => runner.run(['hash-object', '--stdin'], { cwd: w.repo, timeoutMs: HOLD_MS }).catch(() => null))
  check(runner.running === 2, `both git slots taken (${runner.running})`)
  w.gitCalls.length = 0
  const s1 = Date.now()
  const busy = await w.req({ op: 'task', taskId: a.id })
  const took = Date.now() - s1
  check(took < 2000, `the task op answers at once with no git slot free, never after the held calls (${took} ms)`)
  same({ exists: busy.task.worktree.exists, ahead: busy.task.worktree.ahead, behind: busy.task.worktree.behind }, { exists: true, ahead: 1, behind: 0 }, 'the counts last read (the new commit is not counted yet)')
  const s2 = Date.now()
  const nv = await w.req({ op: 'task', taskId: fresh.id })
  check(Date.now() - s2 < 2000 && nv.task.worktree.exists === true && nv.task.worktree.ahead === undefined && nv.task.worktree.behind === undefined, 'a tree never read: on disk, no live numbers')
  const s3 = Date.now()
  const needs = await w.req({ op: 'needs' })
  const row = needs.needs.approvals.find((x) => x.payload.kind === 'integrate' && x.taskId === a.id)
  check(Date.now() - s3 < 2000 && row?.payload.ahead === 1, 'the needs op too: at once, payload.ahead from the cache')
  check(!w.gitCalls.some((c) => c.startsWith('for-each-ref') || c.startsWith('rev-list')), 'no live git call was started (none waits in the queue)')
  await Promise.all(holds)
  check(runner.running === 0, 'the held calls ended')
  const after = await w.req({ op: 'task', taskId: a.id })
  check(after.task.worktree.ahead === 2 && after.task.worktree.behind === 0, 'with a slot free again the read counts the new commit (ahead 2)')
  // With git idle one needs op counts every integrate row: its reads run one tree at a time, so they never take each
  // other's slots (four trees, two slots).
  const b = await w.integratingTask('Tercera', { 'b1.txt': 'b\n' })
  const d = await w.integratingTask('Cuarta', { 'd1.txt': 'd\n', 'd2.txt': 'd\n' })
  const many = await w.req({ op: 'needs' })
  const aheadOf = (id) => many.needs.approvals.find((x) => x.payload.kind === 'integrate' && x.taskId === id)?.payload.ahead ?? null
  same([a, fresh, b, d].map((t) => aheadOf(t.id)), [2, 1, 1, 1], 'four integrate rows with git idle: each carries its payload.ahead (none starved by the others)')
}

async function main() {
  try {
    verifyDetectChecks()
    reducerChecks()
    helperChecks()
    await integratorChecks(false)
    await integratorChecks(true)
    await integratorOnceChecks()
    await verifyRunnerChecks()
    await serviceChecks()
    await haltChecks()
    await busyGitChecks()
    console.log(`PASS: ${checks} teams integrate checks (verifyDetect, reducers T13 T14 T15 and the load, the Integrator on real git with autocrlf false and true: ff-only, CAS update-ref, base_moved, merge_conflict, git_error, base_dirty and the untracked overwrite, base_busy, base_checked_out_elsewhere, verify failed, timeout and ok with its live tail, alreadyMerged, no_identity, no repo hook, halt, no node_modules link for an installing verify, the 10 min land, base_dirty files capped, one integrate per repo, an extra repo alongside, the log prune, the sweep, GitExecError; the verify runner: resolved at the exit plus its drain, killAll, the Windows leftovers of the dead shell killed; the service: preview, confirmVerify, integrate to done, removeWorktree, suggestedVerify, the live tree and ahead cached per tip, askRebase, Labs off mid-integrate, interrupted at load, shutdownSync and prepareInstall kill the verify, prepareInstall waits for a land, the live reads never wait on a busy git semaphore; B6 review: ignored files never replaced, verifyNote out of the tail, the probe window ends at the exit, killAll in the drain, branchLoses on a slow git, the end commit with the team not loaded; second round: the stored verifyNote, step and land mode, lastStep and lastLanding, the runner words in rebaseVerify; the checkout byte identical after every failure)`)
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
