// Teams board (app 2.7.0, B3): src/shared/teamBoard.ts (columnOf, compareTasks, boardColumns with the query, the
// assignee and showCancelled, bandsOf, dropVerdict every rule and its confirm order, phaseWaitsOnUser, the key
// helpers), the `teams.*` board catalog (every column, phase and priority key in es and en, `teams.sys.*` en equal
// to SYS_TEXT_EN, no key shared with another area catalog, no dash) and the renderer board store
// (src/renderer/lib/teams/board.ts) over a fake `teams.req`: pages and "Ver más" kept across a reload (a done task a
// newer one pushes out of the first page stays), a move
// shown at once and replaced by the reply, a refusal rolled back with `conflict {current}` applied, a band in the
// same column sent as updateTask {priority}, a live run's move carrying stopRun, cancel, summaryFromDetail (a detail
// keeps the card's comment count from main, never the length of its comment page).
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, structuredClone, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}

const B = load('src/shared/teamBoard.ts')
const T = load('src/shared/teams.ts')
const P = load('src/shared/teamPrompt.ts')

// ---- fixtures --------------------------------------------------------------------------------------
const NOW = 1_700_000_000_000
let n = 0
/** A TaskSummary as main sends it; `column` is main's, the board recomputes it from state and phase. */
const task = (id, x = {}) => ({
  id, rev: 1, title: `Task ${id}`, state: 'todo', phase: 'none', column: 'todo', priority: 'normal',
  repoId: 'main', isolation: 'worktree', needsPlan: true, blockedBy: [], createdBy: 'user',
  createdAt: NOW + (n++) * 1000, updatedAt: NOW, stateSince: NOW, userOwned: [], needs: 0, comments: 0, queued: 0, ...x,
})
const ids = (list) => list.map((t) => t.id).join(',')

function columnChecks() {
  const pairs = [
    ['todo', 'none', 'todo'], ['doing', 'planning', 'doing'], ['doing', 'planApproval', 'doing'], ['doing', 'executing', 'doing'],
    ['review', 'qa', 'review'], ['review', 'userOk', 'review'], ['review', 'integrating', 'review'], ['done', 'none', 'done'],
    ['blocked', 'executing', 'blocked'], ['blocked', 'qa', 'blocked'], ['cancelled', 'none', null],
  ]
  for (const [state, phase, col] of pairs) check(B.columnOf({ state, phase }) === col, `columnOf ${state}/${phase} -> ${col}`)
  check(B.columnOf({ state: 'doing', phase: 'qa' }) === 'review', 'columnOf: a qa phase reads Revisión whatever the state says (the flow phase wins)')
  check(B.columnOf({ state: 'review', phase: 'none' }) === 'review', 'columnOf: doing/review with no flow phase keeps its state')
  // Two bundles, two copies of the function: the same source means the board uses teams.ts's own rule.
  check(B.columnOf.toString() === T.columnOf.toString(), 'teamBoard re-exports the one columnOf of teams.ts')
}

function orderChecks() {
  const a = task('t-10', { priority: 'normal', createdAt: NOW })
  const b = task('t-2', { priority: 'normal', createdAt: NOW })
  const c = task('t-3', { priority: 'urgent', createdAt: NOW + 50_000 })
  const d = task('t-4', { priority: 'low', createdAt: NOW - 50_000 })
  const e = task('t-5', { priority: 'normal', createdAt: NOW - 1 })
  const f = task('t-6', { priority: 'bogus', createdAt: NOW + 1 })
  const sorted = [a, b, c, d, e, f].sort(B.compareTasks)
  check(ids(sorted) === 't-3,t-5,t-2,t-10,t-6,t-4', 'compareTasks: band first, then createdAt, then the numeric id (t-2 before t-10); an unknown priority sorts as normal', ids(sorted))
  check(B.compareTasks(a, a) === 0, 'compareTasks: a task equals itself')
}

function columnsChecks() {
  const list = [
    task('t-1', { title: 'Login con OAuth', assignee: 'dev' }),
    task('t-2', { state: 'doing', phase: 'planning', title: 'Base de datos', assignee: 'dev-2', priority: 'high' }),
    task('t-3', { state: 'review', phase: 'qa', title: 'Diseño del lógin', assignee: 'dev' }),
    task('t-4', { state: 'done', title: 'Readme', priority: 'low' }),
    task('t-5', { state: 'blocked', phase: 'none', title: 'Deploy', blocked: { kind: 'deps', waitingOn: ['t-1'] } }),
    task('t-6', { state: 'cancelled', title: 'Vieja idea' }),
    task('t-7', { title: 'Urgente', priority: 'urgent' }),
    task('t-8', { state: 'doing', phase: 'qa', title: 'Mal estado' }),
  ]
  const cols = B.boardColumns(list)
  check(same(Object.keys(cols), ['todo', 'doing', 'review', 'done', 'blocked']), 'boardColumns: the five columns in display order')
  check(ids(cols.todo) === 't-7,t-1' && ids(cols.doing) === 't-2' && ids(cols.review) === 't-3,t-8' && ids(cols.done) === 't-4' && ids(cols.blocked) === 't-5', 'boardColumns: placement by columnOf, sorted by compareTasks', JSON.stringify(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, ids(v)]))))
  check(!Object.values(cols).flat().some((t) => t.id === 't-6'), 'boardColumns: a cancelled task has no column by default')
  const withCancelled = B.boardColumns(list, { showCancelled: true })
  check(ids(withCancelled.done) === 't-4,t-6', 'boardColumns: showCancelled puts cancelled tasks at the end of Hecho')
  check(ids(B.boardColumns(list, { query: 'login' }).todo) === 't-1' && ids(B.boardColumns(list, { query: 'login' }).review) === 't-3', 'query: rankList over id and title, accents and case ignored (Lógin matches login)')
  check(ids(Object.values(B.boardColumns(list, { query: 't-5' })).flat()) === 't-5', 'query: a task id finds that task')
  check(ids(Object.values(B.boardColumns(list, { query: '   ' })).flat()) === ids(Object.values(cols).flat()), 'query: blank filters nothing')
  check(ids(Object.values(B.boardColumns(list, { assignee: 'dev' })).flat()) === 't-1,t-3', 'assignee: an agent id filters exactly')
  check(ids(Object.values(B.boardColumns(list, { assignee: '' })).flat()) === 't-7,t-8,t-4,t-5', "assignee: '' keeps the unassigned ones")
  check(ids(Object.values(B.boardColumns(list, { assignee: null })).flat()) === ids(Object.values(cols).flat()), 'assignee: null is everyone')
  check(ids(Object.values(B.boardColumns(list, { assignee: 'dev', query: 'diseño' })).flat()) === 't-3', 'query and assignee combine')
  check(ids(B.boardColumns(list, { query: 'o' }).todo) === ids(B.boardColumns(list, { query: 'o' }).todo.slice().sort(B.compareTasks)), 'a query keeps the compareTasks order inside a column (the bands stay meaningful)')
  check(B.filterActive({ query: 'x' }) && B.filterActive({ assignee: '' }) && !B.filterActive({ query: ' ', assignee: null }) && !B.filterActive(undefined) && !B.filterActive({ showCancelled: true }), 'filterActive: a query or an assignee filters; showCancelled alone does not hide anything')
  check(same(B.bandsOf(cols.todo), ['urgent', 'normal']) && same(B.bandsOf([]), []) && same(B.bandsOf(list), ['urgent', 'high', 'normal', 'low']), 'bandsOf: the bands present, in priority order')
}

function dropChecks() {
  const v = B.dropVerdict
  const todo = task('t-1')
  const planning = task('t-2', { state: 'doing', phase: 'planning', column: 'doing' })
  const live = task('t-3', { state: 'doing', phase: 'executing', run: { id: 'r-aaaaaaaaaaaa', agentId: 'dev', mode: 'exec', state: 'running' } })
  const blockedExec = task('t-4', { state: 'blocked', phase: 'executing' })
  const branchy = task('t-5', { state: 'review', phase: 'userOk', branch: 'sn/t-aaaaaa-5' })
  const merged = task('t-6', { state: 'review', phase: 'userOk', branch: 'sn/t-aaaaaa-6', integrated: true })
  const cancelled = task('t-7', { state: 'cancelled' })
  const doneRun = task('t-8', { state: 'review', phase: 'qa', run: { id: 'r-bbbbbbbbbbbb', agentId: 'qa', mode: 'qa', state: 'succeeded' } })
  check(same(v(cancelled, 'todo'), { ok: false, reason: 'cancelled' }) && same(v(cancelled, 'done', 'high'), { ok: false, reason: 'cancelled' }), 'cancelled: refused whatever the target');
  check(same(v(todo, 'todo'), { ok: false, reason: 'same' }), 'same column, no band: same')
  check(same(v(todo, 'todo', 'normal'), { ok: false, reason: 'same' }), 'same column, its own band: same')
  check(same(v(todo, 'todo', 'urgent'), { ok: true, patch: { priority: 'urgent' } }), 'same column, another band: a priority patch only')
  check(same(v(live, 'doing', 'low'), { ok: true, patch: { priority: 'low' } }), 'a band inside En curso is allowed (priority only, no stopsRun)')
  check(same(v(todo, 'doing'), { ok: false, reason: 'phaseColumn' }) && same(v(todo, 'review'), { ok: false, reason: 'phaseColumn' }) && same(v(blockedExec, 'review', 'high'), { ok: false, reason: 'phaseColumn' }), 'En curso and Revisión from another column: phaseColumn')
  check(same(v(todo, 'blocked'), { ok: true, patch: { to: 'blocked' } }), 'todo -> blocked: a move, no confirm')
  check(same(v(todo, 'done'), { ok: true, patch: { to: 'done' } }), 'todo -> done without a branch: no confirm')
  check(same(v(todo, 'blocked', 'high'), { ok: true, patch: { to: 'blocked', priority: 'high' } }), 'a move onto a band carries the priority')
  check(same(v(todo, 'blocked', 'normal'), { ok: true, patch: { to: 'blocked' } }), 'a move onto its own band carries no priority')
  check(same(v(planning, 'todo'), { ok: true, patch: { to: 'todo' }, confirm: 'dropsPlan' }), 'doing/planning -> todo asks dropsPlan')
  check(same(v(blockedExec, 'todo'), { ok: true, patch: { to: 'todo' }, confirm: 'dropsPlan' }), 'blocked with a phase -> todo asks dropsPlan')
  check(same(v(task('t-9', { state: 'blocked' }), 'todo'), { ok: true, patch: { to: 'todo' } }), 'blocked/none -> todo: no confirm')
  check(same(v(planning, 'blocked'), { ok: true, patch: { to: 'blocked' } }), 'doing/planning -> blocked: no dropsPlan (the phase is kept)')
  check(same(v(live, 'todo'), { ok: true, patch: { to: 'todo' }, confirm: 'stopsRun' }), 'a live run wins over dropsPlan: stopsRun (decision 37)')
  check(same(v(live, 'blocked'), { ok: true, patch: { to: 'blocked' }, confirm: 'stopsRun' }), 'a live run -> blocked asks stopsRun too')
  check(same(v(live, 'done'), { ok: true, patch: { to: 'done' }, confirm: 'stopsRun' }), 'a live run -> done asks stopsRun')
  for (const state of ['queued', 'starting', 'stopping']) {
    check(v(task('t-10', { run: { id: 'r-cccccccccccc', agentId: 'dev', mode: 'plan', state } }), 'blocked').confirm === 'stopsRun', `run ${state} counts as live`)
  }
  check(same(v(doneRun, 'blocked'), { ok: true, patch: { to: 'blocked' } }), 'a finished run is not live: no confirm')
  check(same(v(branchy, 'done'), { ok: true, patch: { to: 'done' }, confirm: 'unintegrated' }), 'done with a branch not integrated asks unintegrated')
  check(same(v(merged, 'done'), { ok: true, patch: { to: 'done' } }), 'done with the branch integrated: no confirm')
  check(same(v(branchy, 'todo'), { ok: true, patch: { to: 'todo' }, confirm: 'dropsPlan' }), 'review/userOk -> todo asks dropsPlan')
  check(same(v(task('t-11', { state: 'done' }), 'todo'), { ok: true, patch: { to: 'todo' } }), 'done -> todo: a move (main decides whether it reopens)')
}

function phaseChecks() {
  const waits = ['none', 'planning', 'planApproval', 'executing', 'qa', 'userOk', 'integrating'].filter(B.phaseWaitsOnUser)
  check(same(waits, ['planApproval', 'userOk', 'integrating']), 'phaseWaitsOnUser: planApproval, userOk, integrating', waits)
  check(B.phaseKey('qa') === 'teams.phase.qa' && B.columnKey('done') === 'teams.col.done' && B.priorityKey('urgent') === 'teams.prio.urgent', 'key helpers')
}

function catalogChecks() {
  const cat = (file) => load(`src/renderer/i18n/teams/${file}.ts`)
  const board = cat('board')
  const en = board.boardEn, es = board.boardEs
  const keys = Object.keys(en)
  check(same(Object.keys(es).sort(), keys.slice().sort()), 'board catalog: es has exactly the en keys')
  const phases = ['none', 'planning', 'planApproval', 'executing', 'qa', 'userOk', 'integrating']
  for (const k of [...phases.map(B.phaseKey), ...T.BOARD_COLUMNS.map(B.columnKey), ...T.TASK_PRIORITIES.map(B.priorityKey)]) {
    check(typeof en[k] === 'string' && en[k] && typeof es[k] === 'string' && es[k], `board catalog has ${k} in en and es`)
  }
  const sysKeys = Object.keys(P.SYS_TEXT_EN)
  for (const k of sysKeys) check(en[`teams.sys.${k}`] === P.SYS_TEXT_EN[k], `teams.sys.${k} en equals SYS_TEXT_EN`)
  check(same(keys.filter((k) => k.startsWith('teams.sys.')).map((k) => k.slice(10)).sort(), sysKeys.slice().sort()), 'teams.sys.* has exactly the SysKeys of SYS_TEXT_EN')
  for (const k of sysKeys) {
    const vars = (P.SYS_TEXT_EN[k].match(/\{\w+\}/g) || []).sort().join()
    check((es[`teams.sys.${k}`].match(/\{\w+\}/g) || []).sort().join() === vars, `teams.sys.${k} es keeps the slots ${vars}`)
  }
  // The area catalogs are spread into one object: a shared key would silently take the later area's text.
  const others = { core: 'coreEn', setup: 'setupEn', agents: 'agentsEn', dispatch: 'dispatchEn', needs: 'needsEn', integrate: 'integrateEn', routines: 'routinesEn', takeover: 'takeoverEn' }
  for (const [file, name] of Object.entries(others)) {
    const theirs = Object.keys(cat(file)[name] || {})
    const shared = theirs.filter((k) => k in en)
    check(shared.length === 0, `no board key is also in ${file}.ts`, shared)
  }
  const all = [...Object.values(en), ...Object.values(es)].join('\n')
  // Built from char codes: the dashes themselves may not sit in any repo file (check-brand).
  const dashes = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
  check(!dashes.test(all), 'board catalog: no en or em dash')
  for (const k of keys) {
    const a = (en[k].match(/\{\w+\}/g) || []).sort().join(), b = (es[k].match(/\{\w+\}/g) || []).sort().join()
    if (a !== b) check(false, `${k}: es and en have the same slots`)
  }
  checks++
}

async function storeChecks() {
  const reqs = []
  let answer = () => ({ ok: false, error: 'unsupported' })
  let gate = null
  const snApi = { teams: { req: async (r) => { reqs.push(r); if (gate) await gate; return answer(r) }, onChanged: () => () => {}, onRunAppend: () => () => {}, onIntegrateProgress: () => () => {} } }
  const storage = new Map()
  const window = { snApi, localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) } }
  const R = loadRenderer(`export * as board from './teams/board'; export { useTeamsStore } from './teamsStore'`, { window, document: { hasFocus: () => false, activeElement: null } })
  const S = R.board
  const TEAM = 'tm-aaaaaaaaaaaa'
  const counts = { todo: 2, doing: 1, review: 0, done: 3, blocked: 0 }
  const first = [task('t-1', { rev: 4 }), task('t-2', { rev: 2, state: 'doing', phase: 'executing', run: { id: 'r-aaaaaaaaaaaa', agentId: 'dev', mode: 'exec', state: 'running' } }), task('t-3', { rev: 1, state: 'done' })]
  answer = (r) => (r.op === 'board' && !r.column ? { ok: true, page: { teamId: TEAM, rev: 7, tasks: first, cursor: 'c1', done: false, counts, cancelled: 1 } } : { ok: false, error: 'unsupported' })
  const data = await S.loadBoard(TEAM)
  check(data && data.rev === 7 && ids(S.boardTasks(data)) === 't-1,t-2,t-3' && data.doneCursor === 'c1' && !data.doneComplete && data.cancelled === 1, 'loadBoard: the first page, its done cursor and the cancelled count')
  answer = (r) => (r.op === 'board' && r.column === 'done' ? { ok: true, page: { teamId: TEAM, rev: 7, tasks: [task('t-3', { state: 'done' }), task('t-9', { state: 'done' })], cursor: null, done: true, counts, cancelled: 1 } } : { ok: false, error: 'io' })
  await S.loadMoreDone(TEAM)
  check(same(reqs.at(-1), { op: 'board', teamId: TEAM, column: 'done', cursor: 'c1' }), 'Ver más asks the done column after the cursor')
  let page = S.useBoardStore.getState().pages[TEAM]
  check(ids(S.boardTasks(page)) === 't-1,t-2,t-3,t-9' && page.doneComplete, 'Ver más joins the older done page by id once; no cursor left: complete')
  answer = (r) => (r.op === 'board' && !r.column ? { ok: true, page: { teamId: TEAM, rev: 8, tasks: first, cursor: 'c1', done: false, counts, cancelled: 1 } } : { ok: false, error: 'io' })
  await S.loadBoard(TEAM)
  page = S.useBoardStore.getState().pages[TEAM]
  check(ids(S.boardTasks(page)) === 't-1,t-2,t-3,t-9' && page.rev === 8 && page.doneComplete, 'a reload of the first page keeps the older done pages and their cursor')
  // A newly done task pushes the oldest done one (t-3) out of the first page: with older pages held it joins them.
  answer = (r) => (r.op === 'board' && !r.column ? { ok: true, page: { teamId: TEAM, rev: 9, tasks: [first[0], first[1], task('t-4', { state: 'done' })], cursor: 'c2', done: false, counts, cancelled: 1 } } : { ok: false, error: 'io' })
  await S.loadBoard(TEAM)
  page = S.useBoardStore.getState().pages[TEAM]
  check(ids(S.boardTasks(page)) === 't-1,t-2,t-4,t-3,t-9' && page.doneComplete, 'a done task pushed out of the first page stays on the board (it joins the older done pages)', ids(S.boardTasks(page)))
  answer = (r) => (r.op === 'board' && !r.column ? { ok: true, page: { teamId: TEAM, rev: 10, tasks: first, cursor: 'c1', done: false, counts, cancelled: 1 } } : { ok: false, error: 'io' })
  await S.loadBoard(TEAM)

  // A move shows at once, the reply replaces it.
  let release
  gate = new Promise((r) => { release = r })
  answer = (r) => (r.op === 'moveTask' ? { ok: true, task: task('t-1', { rev: 5, state: 'blocked', column: 'blocked', userOwned: ['state'], comments: 120 }) } : { ok: false, error: 'io' })
  const moving = S.moveTask(TEAM, S.summaryOf(TEAM, 't-1'), 'blocked')
  await Promise.resolve()
  let shown = S.withOptimistic(TEAM, S.boardTasks(S.useBoardStore.getState().pages[TEAM]), S.useBoardStore.getState().optimistic)
  check(shown.find((t) => t.id === 't-1').state === 'blocked', 'the move shows before main answers (optimistic)')
  release(); gate = null
  check((await moving) === null, 'moveTask resolves null once main applied it')
  check(same(reqs.at(-1), { op: 'moveTask', teamId: TEAM, taskId: 't-1', baseRev: 4, to: 'blocked' }), 'moveTask carries the task rev as baseRev and no stopRun')
  const after = S.summaryOf(TEAM, 't-1')
  check(after.rev === 5 && after.state === 'blocked' && same(after.userOwned, ['state']) && Object.keys(S.useBoardStore.getState().optimistic).length === 0, 'the reply task replaces the card (userOwned from main), nothing optimistic left')
  const untouched = S.boardTasks(S.useBoardStore.getState().pages[TEAM])
  check(S.withOptimistic(TEAM, untouched, {}) === untouched, 'withOptimistic hands the same array back when nothing is pending (memoized cards)')

  // A refusal rolls back; a conflict brings the task as main has it.
  answer = () => ({ ok: false, error: 'running' })
  const fail = await S.moveTask(TEAM, S.summaryOf(TEAM, 't-2'), 'todo')
  check(fail && fail.error === 'running' && S.summaryOf(TEAM, 't-2').state === 'doing' && Object.keys(S.useBoardStore.getState().optimistic).length === 0, 'a refused move rolls the card back and returns the failure')
  // t-1 has 120 comments (the card's count is main's); a detail carries only the newest page of 50 and its cursor.
  const page50 = Array.from({ length: 50 }, (_, i) => ({ id: `m-${71 + i}` }))
  const detailOf = (t, x = {}) => {
    const out = { ...t, body: '', reviewInfo: { round: 0, max: 3 }, comments: page50, commentsCursor: 'm-71', commentsArchived: 0, runs: [], approvals: [], cards: [], ...x }
    delete out.column
    return out
  }
  const current = detailOf(task('t-1', { rev: 9, state: 'todo', title: 'Retitled by the Lead' }))
  answer = () => ({ ok: false, error: 'conflict', reason: 'rev', current })
  const conflict = await S.moveTask(TEAM, S.summaryOf(TEAM, 't-1'), 'done')
  const t1 = S.summaryOf(TEAM, 't-1')
  check(conflict && conflict.error === 'conflict' && t1.rev === 9 && t1.title === 'Retitled by the Lead', 'conflict {current}: the card shows main\'s version')
  check(t1.comments === 120, 'conflict {current}: the card keeps main\'s comment count, never the length of the detail\'s page', t1.comments)
  check(S.useBoardStore.getState().tasks[`${TEAM}/t-1`]?.detail?.rev === 9, 'conflict {current} also fills the drawer entry')
  check(!('body' in t1) && !('runs' in t1) && !('commentsArchived' in t1), 'summaryFromDetail drops the detail-only fields')
  // Opening the drawer (loadTask) puts the detail on the card: its count stays 120.
  answer = (r) => (r.op === 'task' ? { ok: true, task: { ...current, queued: 4 } } : { ok: false, error: 'io' })
  await S.loadTask(TEAM, 't-1')
  check(S.summaryOf(TEAM, 't-1').comments === 120 && S.summaryOf(TEAM, 't-1').queued === 4 && S.useBoardStore.getState().tasks[`${TEAM}/t-1`].detail.comments.length === 50, 'loadTask: the card keeps 120 comments (the drawer holds the page of 50), the queued count comes from main', S.summaryOf(TEAM, 't-1').comments)
  // A task with no card: it joins the board only from a detail that holds every comment (counted with the archived ones).
  answer = (r) => (r.op === 'task' ? { ok: true, task: detailOf(task(r.taskId), r.taskId === 't-31' ? { comments: [{ id: 'm-1' }, { id: 'm-2' }], commentsCursor: null, commentsArchived: 3 } : {}) } : { ok: false, error: 'io' })
  await S.loadTask(TEAM, 't-30')
  await S.loadTask(TEAM, 't-31')
  check(S.summaryOf(TEAM, 't-30') === undefined && S.useBoardStore.getState().tasks[`${TEAM}/t-30`].detail.id === 't-30', 'a detail with older comment pages and no card fills the drawer only (the board page brings its count)')
  check(S.summaryOf(TEAM, 't-31')?.comments === 5, 'a detail that holds every comment adds its card with them all (2 + 3 archived)', S.summaryOf(TEAM, 't-31'))

  // A band inside the same column is updateTask {priority}; a live run's move carries stopRun; cancel.
  answer = (r) => (r.op === 'updateTask' ? { ok: true, task: { ...current, rev: 10, priority: 'urgent', userOwned: ['priority'] } } : { ok: false, error: 'io' })
  check((await S.moveTask(TEAM, S.summaryOf(TEAM, 't-1'), 'todo', 'urgent')) === null, 'a band drop in the same column applies')
  check(same(reqs.at(-1), { op: 'updateTask', teamId: TEAM, taskId: 't-1', baseRev: 9, patch: { priority: 'urgent' } }), 'a band drop in the same column is updateTask {priority} with the rev')
  check(S.summaryOf(TEAM, 't-1').priority === 'urgent', 'its reply lands on the card')
  answer = (r) => (r.op === 'moveTask' ? { ok: true, task: task('t-2', { rev: 3, state: 'todo' }) } : { ok: false, error: 'io' })
  await S.moveTask(TEAM, S.summaryOf(TEAM, 't-2'), 'todo', 'high', true)
  check(same(reqs.at(-1), { op: 'moveTask', teamId: TEAM, taskId: 't-2', baseRev: 2, to: 'todo', priority: 'high', stopRun: true }), 'a confirmed move of a live task carries stopRun and the band')
  const refused = await S.moveTask(TEAM, S.summaryOf(TEAM, 't-2'), 'doing')
  check(refused && refused.error === 'bad_request' && refused.detail === 'phaseColumn' && reqs.at(-1).op === 'moveTask' && reqs.at(-1).to === 'todo', 'a drop the verdict refuses sends nothing')
  answer = (r) => (r.op === 'moveTask' ? { ok: true, task: task('t-2', { rev: 4, state: 'cancelled', column: null }) } : { ok: false, error: 'io' })
  await S.cancelTask(TEAM, S.summaryOf(TEAM, 't-2'), false)
  check(same(reqs.at(-1), { op: 'moveTask', teamId: TEAM, taskId: 't-2', baseRev: 3, to: 'cancelled' }) && S.summaryOf(TEAM, 't-2').state === 'cancelled', 'cancelTask is moveTask to cancelled')

  // New task: the dialog state and the error kept for it.
  S.openNewTask(TEAM)
  answer = () => ({ ok: false, error: 'cap' })
  check((await S.createTask(TEAM, { title: 'Otra' })) === null && S.useBoardStore.getState().newTask.error.error === 'cap', 'createTask refused: null, the dialog keeps the error')
  answer = (r) => (r.op === 'createTask' ? { ok: true, task: task('t-12', { title: r.task.title }) } : { ok: false, error: 'io' })
  check((await S.createTask(TEAM, { title: 'Otra' })) === 't-12' && S.useBoardStore.getState().newTask === null && S.summaryOf(TEAM, 't-12').title === 'Otra', 'createTask: the id, the dialog closes and the card joins the board')
}

async function main() {
  columnChecks()
  orderChecks()
  columnsChecks()
  dropChecks()
  phaseChecks()
  catalogChecks()
  await storeChecks()
  console.log(`PASS: ${checks} teams board checks (columnOf, compareTasks, boardColumns, bandsOf, dropVerdict, catalog, board store)`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
