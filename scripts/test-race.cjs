// Agent race and the global prompt (E7-FR-33..35), renderer side: the paste
// path of the global prompt (chosen destinations, plain consoles on one line
// without Enter, Enter only to agents after the paste), the race checks
// (counts, "this workspace" only when it fits, names, slugs, readiness), the
// orchestration over a fake window.snApi (N worktrees from one sha, the task
// with Enter to each agent once ready, the 20 s fallback, all-or-nothing
// worktrees, a new workspace) and the bar's actions (discard clean at once,
// dirty through the FR-30 dialog, keep one). Bundled with esbuild and run in
// a vm like test-worktrees.cjs; no git, pty or user config is touched.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected)), label); checks++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sha = 'f6c3fc4f451077c2689a52f81295236419257c5d'
const calls = { add: [], remove: [], inspect: [], probe: [], writes: [], gitMethods: new Set() }
const fake = { probe: { ok: true, repoName: 'repo', head: sha, headShort: sha.slice(0, 7) }, addFail: null, branchTakenOnce: false, inspect: () => ({ exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }), removeRes: { ok: true } }
const track = (name, fn) => (...a) => { calls.gitMethods.add(name); return fn(...a) }
const snApi = {
  platform: 'win32',
  config: { save() {} },
  clipboard: { writeText() {} },
  pty: { write: (r) => calls.writes.push(r), killPanes: async () => 0 },
  git: {
    worktreeProbe: track('worktreeProbe', async (cwd) => { calls.probe.push(cwd); return fake.probe }),
    worktreeAdd: track('worktreeAdd', async (r) => {
      calls.add.push(r)
      if (fake.branchTakenOnce) { fake.branchTakenOnce = false; return { ok: false, error: 'branch_exists' } }
      if (fake.addFail !== null && calls.add.length === fake.addFail) return { ok: false, error: 'git_error', detail: 'boom' }
      return { ok: true, worktree: { repoRoot: 'C:\\repo', path: `C:\\data\\worktrees\\repo-abc123\\${r.slug}`, branch: `sn/${r.slug}`, base: r.base ?? sha } }
    }),
    worktreeRemove: track('worktreeRemove', async (r) => { calls.remove.push(r); return fake.removeRes }),
    worktreeInspect: track('worktreeInspect', async (r) => { calls.inspect.push(r); return fake.inspect(r) }),
  },
}
const code = buildSync({
  stdin: { contents: `
    export { useAppStore } from './store'
    export { useWorktreeStore } from './worktreeStore'
    export { registerPaster } from './pasteRegistry'
    export { registerPty, unregisterPty } from './ptyRegistry'
    export * from './broadcastPrompt'
    export * from './race'
  `, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') },
  define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text
const mod = { exports: {} }
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, setImmediate, TextEncoder, window: { snApi }, document: { hasFocus: () => true, querySelector: () => null }, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame() {} })
const R = mod.exports
const S = R.useAppStore

// Fake terminals: each pane records what xterm got pasted; `bracketed` per pane.
const pasted = {}
const bracket = {}
function mount(paneId, { bracketed = true } = {}) {
  pasted[paneId] = []
  bracket[paneId] = bracketed
  R.registerPaster(paneId, { paste: (t) => pasted[paneId].push(t), bracketed: () => bracket[paneId] })
  R.registerPty(paneId, `pty-${paneId}`)
}

const claude = { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }
const codex = { id: 'preset-codex', name: 'Codex', type: 'codex', command: 'codex', args: [], color: '#10a37f', icon: 'codex' }
const pane = (id, type = 'shell', extra = {}) => ({ id, type, title: id, color: '#fff', icon: 'terminal', ...extra })

;(async () => {
  // ---- broadcastPrompt (E7-FR-33) ----
  check(R.oneLine('a\r\nb\n\n  c\u2028d\te') === 'a b c d\te', 'oneLine: every break (CRLF, LF, U+2028) becomes one space, inner tabs stay')
  check(R.promptText('x\r\ny\rz\x1b[201~\x03') === 'x\ny\nz\u241b[201~\ufffd', 'promptText: CR to LF, ESC to U+241B, other controls to U+FFFD')

  S.setState({
    hydrated: true, presets: [claude, codex], connections: [], activeWorkspaceId: 'w1',
    workspaces: [{ id: 'w1', name: 'Repo', cwd: 'C:\\repo', panes: [pane('a1', 'claude'), pane('a2', 'codex'), pane('sh'), pane('min', 'claude'), pane('off', 'claude')], favorite: false }],
    minimized: { w1: ['min'] },
    paneStatus: { a1: { state: 'idle', precise: true, provider: 'claude' }, a2: { state: 'idle', precise: false, provider: 'codex' } },
  })
  for (const id of ['a1', 'a2', 'min', 'off']) mount(id)
  mount('sh', { bracketed: false })
  check(R.promptTargetOf({ id: 'a1', type: 'claude' }) === 'agent' && R.promptTargetOf({ id: 'sh', type: 'shell' }) === 'plain', 'agent console vs plain console')
  bracket.sh = true
  check(R.promptTargetOf({ id: 'sh', type: 'shell' }) === 'plain', 'a shell with bracketed paste on is still plain')
  bracket.sh = false

  const ws = () => S.getState().workspaces.find((w) => w.id === 'w1')
  const text = 'fix the bug\nthen run the tests'
  let n = R.broadcastToWorkspace(ws(), text, { paneIds: ['a1', 'a2', 'sh', 'min'], enter: true })
  check(n === 3, `three chosen active consoles received it (got ${n})`)
  check(pasted.off.length === 0, 'an unchecked destination receives nothing')
  check(pasted.min.length === 0, 'a minimized console receives nothing')
  same(pasted.a1, [text], 'an agent gets the multi-line text as one paste')
  same(pasted.sh, ['fix the bug then run the tests'], 'a plain console gets one line')
  check(calls.writes.length === 0, 'no raw pty write before the paste settles')
  await sleep(260)
  same(calls.writes.map((w) => w.ptyId).sort(), ['pty-a1', 'pty-a2'], 'Enter after submitDelayFor goes to the agents only')
  check(calls.writes.every((w) => w.data === '\r'), 'the Enter is a lone CR')
  calls.writes.length = 0
  n = R.broadcastToWorkspace(ws(), 'hola')
  await sleep(260)
  check(n === 4 && calls.writes.length === 0, 'defaults (the phone): every active console, never Enter')
  // A restart between the paste and the Enter: the new pty never gets it.
  R.broadcastToWorkspace(ws(), 'again', { paneIds: ['a1'], enter: true })
  R.registerPty('a1', 'pty-a1-restarted')
  await sleep(260)
  check(calls.writes.length === 0, 'a console restarted in between gets no stray Enter')
  R.registerPty('a1', 'pty-a1')

  // ---- race checks (E7-FR-34) ----
  check(R.raceCountsOk({ claude: 2, codex: 2 }) && !R.raceCountsOk({ claude: 3, codex: 2 }) && !R.raceCountsOk({ claude: 0, codex: 0 }) && !R.raceCountsOk({ claude: -1, codex: 2 }) && !R.raceCountsOk({ claude: 1.5, codex: 0 }), 'counts: 1..4 in all, whole and not negative')
  check(!R.raceFitsHere(10, { claude: 2, codex: 1 }) && R.raceFitsHere(10, { claude: 1, codex: 1 }) && !R.raceFitsHere(12, { claude: 1, codex: 0 }) && R.raceFitsHere(0, { claude: 2, codex: 2 }), 'this workspace only when 12 - panes leaves room for all')
  same(R.defaultRaceCounts({ claude, codex }), { claude: 2, codex: 1 }, 'default counts with both agents: 3 contestants')
  check(!R.raceFitsHere(10, R.defaultRaceCounts({ claude, codex })), 'with 10 consoles the defaults only offer a new workspace')
  same(R.defaultRaceCounts({ codex }), { claude: 0, codex: 2 }, 'default counts with Codex only')
  check(R.raceWorkspaceName('  Arreglar el\nlogin   de usuarios y sumar tests extra', 'Carrera') === 'Carrera - Arreglar el login de usuarios', 'workspace name: first 5 words on one line')
  check(R.raceWorkspaceName('Supercalifragilisticoespialidoso-y-mucho-mas-largo', 'Race').length <= 'Race - '.length + 32, 'workspace name is capped')
  check(R.raceWorkspaceName('   ', 'Race') === 'Race', 'an empty task names it with the prefix alone')
  const slug = R.raceSlug('codex', 2, () => 0.5)
  check(slug === 'race-codex-3-8000' && /^[a-z0-9-]{1,40}$/.test(slug), `slug race-<agent>-<n>-<hex> is a valid worktree slug (${slug})`)
  check(R.raceReady('claude', { state: 'idle', precise: true, provider: 'claude' }, true) && !R.raceReady('claude', undefined, true) && !R.raceReady('claude', { state: 'idle', precise: true, provider: 'claude' }, false), 'Claude: a precise idle (SessionStart hook) plus bracketed paste')
  check(!R.raceReady('claude', { state: 'idle', precise: false, provider: 'claude' }, true), 'a title-only status is not ready (it can be the folder trust dialog)')
  check(!R.raceReady('claude', { state: 'working', precise: true, provider: 'claude' }, true) && R.raceReady('claude', { state: 'done', precise: true, provider: 'claude' }, true), 'only idle or done count, as in the initial prompt gate')
  check(R.raceReady('codex', { state: 'idle', precise: true, provider: 'codex' }, true) && !R.raceReady('codex', { state: 'idle', precise: true, provider: 'claude' }, true) && !R.raceReady('claude', { state: 'idle', precise: true, provider: 'codex' }, true), 'Codex: the Codex bridge start, and each agent only by its own provider')
  check(R.checkoutCommand('sn/race-claude-1-3f2a') === 'git checkout sn/race-claude-1-3f2a', 'copy git checkout text')
  same(Object.keys(R.racePresets({ presets: [claude, codex], settings: {} })), ['claude', 'codex'], 'presets per agent')

  // ---- startRace refusals ----
  S.setState({ workspaces: [{ id: 'w1', name: 'Repo', cwd: 'C:\\repo', panes: Array.from({ length: 10 }, (_, i) => pane(`p${i}`)), favorite: false }], minimized: {}, paneStatus: {} })
  same(await R.startRace({ workspaceId: 'w1', task: 'x', counts: { claude: 2, codex: 1 }, destination: 'here' }), { ok: false, error: 'full' }, 'a race that does not fit is refused for this workspace')
  same(await R.startRace({ workspaceId: 'w1', task: '  ', counts: { claude: 1, codex: 0 }, destination: 'new' }), { ok: false, error: 'no_task' }, 'an empty task is refused')
  same(await R.startRace({ workspaceId: 'w1', task: 'x', counts: { claude: 4, codex: 1 }, destination: 'new' }), { ok: false, error: 'bad_counts' }, 'five contestants are refused')
  S.setState({ connections: [{ id: 'ssh', name: 'Box', steps: [{ expect: '$', send: 'cd x' }] }], workspaces: [{ id: 'w1', name: 'Repo', cwd: 'C:\\repo', setupId: 'ssh', panes: [], favorite: false }] })
  same(await R.startRace({ workspaceId: 'w1', task: 'x', counts: { claude: 1, codex: 0 }, destination: 'here' }), { ok: false, error: 'remote' }, 'a workspace on a connection profile cannot race')
  S.setState({ connections: [], workspaces: [{ id: 'w1', name: 'Repo', cwd: 'C:\\repo', panes: [pane('sh')], favorite: false }] })
  fake.probe = { ok: false, error: 'unborn' }
  same(await R.startRace({ workspaceId: 'w1', task: 'x', counts: { claude: 1, codex: 0 }, destination: 'here' }), { ok: false, error: 'unborn' }, 'a repo without commits is refused before any worktree')
  check(calls.add.length === 0, 'refusals create no worktree')
  fake.probe = { ok: true, repoName: 'repo', head: sha, headShort: sha.slice(0, 7) }

  // ---- all or nothing ----
  fake.addFail = 2
  const failed = await R.startRace({ workspaceId: 'w1', task: 'x', counts: { claude: 2, codex: 1 }, destination: 'here' })
  check(!failed.ok && failed.error === 'worktree' && failed.detail === 'boom', 'a failed worktree fails the race with its detail')
  same(calls.remove.map((r) => [r.path, r.deleteBranch]), [[calls.add[0].slug && `C:\\data\\worktrees\\repo-abc123\\${calls.add[0].slug}`, true]], 'the worktree this call created is removed with its branch')
  check(ws().panes.length === 1, 'no console was added')
  fake.addFail = null
  calls.add.length = 0
  calls.remove.length = 0

  // ---- a race in this workspace ----
  fake.branchTakenOnce = true
  const started = await R.startRace({ workspaceId: 'w1', task: 'Make the login faster\nand add a test', counts: { claude: 2, codex: 1 }, destination: 'here' }, { readyMs: 1500, pollMs: 10, settleMs: 0, rand: (() => { let i = 0; return () => (i++ % 7) / 7 })() })
  check(started.ok && started.workspaceId === 'w1' && started.paneIds.length === 3, 'three consoles start in this workspace')
  check(calls.add.length === 4 && calls.add.every((r) => r.base === sha && r.repoCwd === 'C:\\repo' && r.copyEnv === true && r.linkNodeModules === false), 'every worktree from the same base sha (one retry after a taken branch)')
  check(calls.add[0].slug !== calls.add[1].slug && calls.add[1].slug.startsWith('race-claude-1-'), 'a taken slug retries with a new suffix, the old branch untouched')
  const racers = ws().panes.filter((p) => started.paneIds.includes(p.id))
  check(racers.every((p) => p.worktree && p.worktree.base === sha && p.cwd === p.worktree.path), 'each console runs in its own worktree')
  same(racers.map((p) => p.type), ['claude', 'claude', 'codex'], 'Claude first, then Codex, as counted')
  check(racers[2].title.startsWith('Codex · race-codex-3-'), `title <preset> · <slug> (${racers[2].title})`)
  const race = R.useRaceStore.getState().races.w1
  check(race && race.base === sha && race.contestants.length === 3 && race.contestants.every((c) => c.state === 'starting'), 'the race is registered, everyone starting')
  // Agents come up one by one: Claude by any status, Codex by a codex status.
  const [c1, c2, c3] = started.paneIds
  for (const id of started.paneIds) mount(id)
  bracket[c3] = true
  S.getState().setPaneStatus({ paneId: c1, state: 'idle', precise: true, notify: false, provider: 'claude' })
  S.getState().setPaneStatus({ paneId: c3, state: 'idle', precise: false, notify: false, provider: 'claude' })
  S.getState().setPaneStatus({ paneId: c2, state: 'idle', precise: false, notify: false, provider: 'claude' })
  await sleep(80)
  check(pasted[c1].length === 1 && pasted[c3].length === 0, 'a ready Claude gets the task; a Codex without its codex status waits')
  check(pasted[c2].length === 0, 'a Claude with a title-only status waits for its SessionStart')
  S.getState().setPaneStatus({ paneId: c3, state: 'idle', precise: true, notify: false, provider: 'codex' })
  S.getState().setPaneStatus({ paneId: c2, state: 'idle', precise: true, notify: false, provider: 'claude' })
  const outcome = await started.done
  same(outcome, { sent: 3, late: 0, failed: 0 }, 'the task went to all three')
  check(started.paneIds.every((id) => pasted[id].length === 1 && pasted[id][0] === 'Make the login faster\nand add a test'), 'each agent got the whole task as one paste')
  await sleep(260)
  same(calls.writes.filter((w) => started.paneIds.some((id) => w.ptyId === `pty-${id}`)).map((w) => w.data), ['\r', '\r', '\r'], 'and Enter after it')
  check(R.useRaceStore.getState().races.w1.contestants.every((c) => c.state === 'sent'), 'every contestant is marked sent')
  check([...calls.gitMethods].every((m) => ['worktreeProbe', 'worktreeAdd', 'worktreeRemove', 'worktreeInspect'].includes(m)), 'no merge (nor any other git write) is ever asked')

  // ---- the bar's actions (E7-FR-35) ----
  same(R.liveContestants(R.useRaceStore.getState().races.w1, ws()).length, 3, 'three rows on the bar')
  const dirtyPath = racers[1].worktree.path
  fake.inspect = (r) => (r.path === dirtyPath ? { exists: true, dirtyFiles: 2, commitsAhead: 1, mergedIntoHead: false } : { exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false })
  check((await R.discardContestant('w1', c1)) === 'removed', 'a clean contestant is discarded without a dialog')
  check(calls.remove.at(-1).path === racers[0].worktree.path && calls.remove.at(-1).paneId === c1 && calls.remove.at(-1).deleteBranch === true, 'main deletes its worktree and branch (and kills its pty)')
  check(!ws().panes.some((p) => p.id === c1), 'its console leaves the workspace')
  check((await R.discardContestant('w1', c2)) === 'dialog' && R.useWorktreeStore.getState().close?.paneId === c2, 'a dirty contestant opens the FR-30 dialog instead')
  R.useWorktreeStore.getState().closeClose()
  same(R.liveContestants(R.useRaceStore.getState().races.w1, ws()).map((c) => c.paneId), [c2, c3], 'the bar drops the discarded row')
  const plan = await R.planKeep('w1', c3)
  same(plan.map((r) => r.paneId), [c2], 'keep this one: the others are planned')
  same(R.keepLoss(plan), { needsAck: true, files: 2, commits: 1 }, 'a dirty other needs the checkbox, with the totals')
  same(R.keepLoss([{ paneId: 'x', branch: 'sn/x', info: { exists: true, dirtyFiles: 0, commitsAhead: 2, mergedIntoHead: true } }]), { needsAck: false, files: 0, commits: 0 }, 'merged commits are not lost')
  fake.removeRes = { ok: false, error: 'busy', detail: 'EBUSY' }
  check((await R.discardOthers('w1', plan)) === 0 && ws().panes.some((p) => p.id === c2), 'a failed delete keeps the console')
  fake.removeRes = { ok: true }
  check((await R.discardOthers('w1', plan)) === 1 && !ws().panes.some((p) => p.id === c2) && ws().panes.some((p) => p.id === c3), 'the others go, the kept one stays')

  // ---- the workspace changed while the worktrees were being created ----
  calls.add.length = 0
  calls.remove.length = 0
  S.setState({ workspaces: [{ id: 'w1', name: 'Repo', cwd: 'C:\\repo', panes: Array.from({ length: 9 }, (_, i) => pane(`r${i}`)), favorite: false }], activeWorkspaceId: 'w1' })
  const realAdd = snApi.git.worktreeAdd
  snApi.git.worktreeAdd = async (r) => {
    const res = await realAdd(r)
    if (calls.add.length === 1) S.getState().addPane('w1', pane('late-extra'))
    return res
  }
  const filled = await R.startRace({ workspaceId: 'w1', task: 'x', counts: { claude: 2, codex: 1 }, destination: 'here' })
  same(filled, { ok: false, error: 'full' }, 'a workspace that filled up meanwhile refuses the race')
  check(calls.remove.length === calls.add.length && calls.add.length === 3 && ws().panes.length === 10, 'its worktrees are removed and no console is added')
  calls.add.length = 0
  calls.remove.length = 0
  snApi.git.worktreeAdd = async (r) => {
    const res = await realAdd(r)
    if (calls.add.length === 1) S.setState({ workspaces: [] })
    return res
  }
  same(await R.startRace({ workspaceId: 'w1', task: 'x', counts: { claude: 1, codex: 1 }, destination: 'here' }), { ok: false, error: 'not_found' }, 'a workspace deleted meanwhile refuses the race')
  check(calls.remove.length === 2, 'and leaves no orphan worktree behind')
  snApi.git.worktreeAdd = realAdd

  // ---- late agent and a new workspace ----
  calls.add.length = 0
  calls.writes.length = 0
  S.setState({ workspaces: [{ id: 'w1', name: 'Repo', cwd: 'C:\\repo', panes: Array.from({ length: 10 }, (_, i) => pane(`q${i}`)), favorite: false }], activeWorkspaceId: 'w1' })
  const nw = await R.startRace({ workspaceId: 'w1', task: 'Rename the config loader please', counts: { claude: 1, codex: 1 }, destination: 'new' }, { readyMs: 120, pollMs: 10, settleMs: 0 })
  check(nw.ok && nw.workspaceId !== 'w1', 'a new workspace is created')
  const created = S.getState().workspaces.find((w) => w.id === nw.workspaceId)
  check(created.name === 'Race - Rename the config loader please' && created.cwd === 'C:\\repo' && S.getState().activeWorkspaceId === nw.workspaceId, `named "Race - <first words>" on the same folder and shown (${created.name})`)
  check(created.panes.length === 2 && created.panes.every((p) => p.worktree && p.worktree.base === sha && p.cwd === p.worktree.path), 'only the contestants, each in its worktree')
  const [l1, l2] = nw.paneIds
  mount(l1, { bracketed: true })
  mount(l2, { bracketed: false })
  const late = await nw.done
  same(late, { sent: 0, late: 2, failed: 0 }, 'past the timeout the task goes anyway, marked late')
  same(pasted[l1], ['Rename the config loader please'], 'a late console with bracketed paste gets the task')
  await sleep(260)
  same(calls.writes, [], 'a late console never gets an Enter (it could answer a trust or login screen)')
  same(pasted[l2], ['Rename the config loader please'], 'the other gets it on one line, waiting in its input')
  // A contestant closed before its agent is up gets nothing.
  calls.add.length = 0
  const gone = await R.startRace({ workspaceId: nw.workspaceId, task: 'x', counts: { claude: 1, codex: 0 }, destination: 'here' }, { readyMs: 500, pollMs: 10, settleMs: 0 })
  S.getState().removePane(nw.workspaceId, gone.paneIds[0])
  same(await gone.done, { sent: 0, late: 0, failed: 1 }, 'a contestant closed while starting is marked failed')
  check(R.useRaceStore.getState().races[nw.workspaceId].contestants.length === 1, 'a second race in the same workspace replaces the first')
  R.useRaceStore.getState().end(nw.workspaceId)
  check(!R.useRaceStore.getState().races[nw.workspaceId], 'closing the bar ends the race')

  console.log(`PASS: ${checks} race checks (global prompt paste/Enter, race rules, orchestration, readiness, late, all-or-nothing, new workspace, discard, keep one, no merge)`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
