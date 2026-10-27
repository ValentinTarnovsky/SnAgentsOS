// Teams approvals, QA, cards and permission asks (app 2.7.0, E10 B5): the terminal tools through applyTool on a strict
// TeamStore (every commit deep-frozen and checked against I1..I22): T4..T12 (plan, small plans the Lead decides,
// reject notes, QA rounds to blocked, the final OK with and without something to integrate), the decider rules and
// the lead escalation, QA without a verdict (one continuation, then a card), the ask guard, card answers per kind and
// every system card action, permission asks (merge, the grant that re-requests the run, no approval for what the
// profile's own deny list keeps denying, never a PowerShell rule: a PowerShell denial grants Bash only), the hire
// (applying, completeApproval, the phone refusal, a stale base), double decides and answers, integrate never decided
// here, Codex blocks (refs, a rejected action stopping the list), a task that ends closing its approvals and cards,
// the one "Te necesita" count, a pure sha256 equal to Node's, and seeded random op sequences.
// B5 integration: no one-word program prefix grant (the exact rule instead), shell and interpreter escapes never
// grantable (no approval, the escape hint), the grant hint built from the wake refs (never WakeMark.detail), the denied
// commands of a permission approval (redacted, cut, merged) and the final OK's QA diff stat in their views, an orphan
// card that outlives its task's end (also in the random sequences), and the settings op lifting a billing pause with
// its card. Second round: a runner or launcher denial (npx, npm exec, pnpm dlx, find, sed) offers its exact command
// rule, never a prefix, and the blocked view of a task names the card that blocks it. Third round: a prefix rule only
// for a row of GRANT_PREFIX_ALLOWLIST (npm test, make all, npx tsc...), the exact rule for every other command, plain
// words only, and an approval stored with a prefix rule off the allowlist grants only what isGrantable still accepts.
// Fourth round: the view of a permission approval shows only those rules, one with none left (git log, diff or show
// prefixes an earlier build stored) answers bad_request on Approve (Reject still works), and the grant hint never names
// a stored grant the policy now refuses. Seventh round: the protect paths of a permission ask are always given (those
// TeamService.protectPaths builds from DATA_SECRET_PATHS; no fallback of file names), and a prep failure with its own
// words (vars.what cmdLine) gives them to the card it opens.
// B5 review: Pedir cambios on the final OK of a task that needs a plan and never had one approved (research closing
// from its plan run, here with a total role) goes back to planning with a plan wake, never to executing, and admitRun
// refuses an exec run on such a task whatever its phase (the defensive T3 check), which the dispatcher never asks for (so
// it never holds back the agent's other levels); a denied plain-word command that holds
// an sk- key or a live token of the app (whole, or split in two words: the run end's mask, the real CtlTokens) offers
// no rule and opens no approval, and every denied line is masked then redacted (finishRun hands its mask to the ask);
// a hire's apply cancels every other pending hire on the old base (error stale, out of Te necesita) and a decide that
// raced it answers conflict stale. Second review round: reconcileTasks drops the "Por despachar" item and the exec wake
// of an executing task that still needs a plan (modeFits reads it like teamDispatch modeFor), and an apply that fails
// on a base that is no longer the trusted hash cancels its hire stale instead of leaving it pending.
// Tanda B close: a permission approval's rev (a merge that grows it moves it; a decide without it or with another one
// answers conflict stale, other kinds ignore it), and GRANTS_MAX per task (an ask offers only what still fits, an
// approve with nothing that lands answers bad_request grantsFull and wakes nobody).
// 2.7.0 runtime fixes (orchestrator decision): a run whose denials leave its permission approval pending waits on the
// user (no continuation, no count, no qaNoVerdict); approve wakes the QA or the Dev of the phase with grant, reject with
// answer, the reject hint and the note as the user's comment; a verdict, review or done of that role cancels it.
// Same esbuild + vm harness as test-teams-store.cjs: no Electron, no processes, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label, extra) {
  assert.ok(condition, extra === undefined ? label : `${label}: ${JSON.stringify(extra)}`)
  checks++
}
function same(actual, expected, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), label)
  checks++
}
const json = (v) => JSON.parse(JSON.stringify(v ?? null))
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
function loadEntry(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, TextEncoder, TextDecoder })
  return mod.exports
}

const M = loadEntry(`
export * from './src/shared/teams'
export { defaultDraft, renderTeamFiles, canonicalDefText, parseDefinition, serializeRole } from './src/shared/teamDefinition'
export { teamArgv, grantPatternOf, isGrantable, isShellEscape, DATA_SECRET_PATHS } from './src/shared/teamArgv'
export { parseTeamBlock } from './src/shared/teamTools'
export { teamNeedsRows, teamNeedsCount } from './src/shared/teamNeeds'
export { afterRunPolicy, candidatesOf } from './src/shared/teamDispatch'
export * from './src/main/teams/flow/approvals'
export { applyTool, applyBlock } from './src/main/teams/flow/tools'
export { createTask, updateTask, moveTask, addComment, deliverComments, archiveSweep, closeTaskNeeds, resumeTask } from './src/main/teams/flow/tasks'
export { reconcileAgents, openSystemCard, setTeamFlags } from './src/main/teams/flow/agents'
export { admitRun, markStarting, markRunning, requestStop, finishRun, terminalOf, runEndFactsOf, prepFailed, setRunWorktree, permissionWaitOf } from './src/main/teams/flow/runs'
export { reconcileTasks, modeFits, todoModeOf } from './src/main/teams/flow/dispatch'
export { assertInvariants } from './src/main/teams/flow/invariants'
export { needsInputOf, approvalView, taskSummary, taskDetail } from './src/main/teams/views'
export { createClaudeStreamParser } from './src/main/teams/parsers/claudeStream'
export { TeamStore } from './src/main/teams/TeamStore'
export { DeadlineTimer } from './src/main/DeadlineTimer'
export { CtlTokens, newToken } from './src/main/cli/CtlTokens'
`)

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const TEAM_ID = 'tm-0123456789ab'
const GEN = 'cafebabe'
const fixtures = path.join(__dirname, 'fixtures', 'teams')
const user = { kind: 'user', via: 'desktop' }
const phone = { kind: 'user', via: 'phone' }
const NO_DELIVERY = { comments: [], cards: [], approvals: [] }
/** The data folder of the permission asks, and its protect paths as TeamService.protectPaths builds them (DATA_SECRET_PATHS, decision 72). */
const DATA = 'C:\\Users\\u\\AppData\\Roaming\\snagentsos'
const PROTECT = { readDeny: M.DATA_SECRET_PATHS.map((p) => path.win32.join(DATA, p)), writeDeny: [path.win32.join(DATA, 'teams'), path.win32.join(DATA, 'trusted-teams.json'), path.win32.join(DATA, 'runtime.json')] }

/** An in-memory SyncFs: the strict store flushes into it on every commit (live() is false). */
function memFs() {
  const files = new Map()
  const nf = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
  return {
    files,
    readFileSync: (p) => { if (!files.has(p)) throw nf(); return files.get(p) },
    writeFileSync: (p, d) => { files.set(p, String(d)) },
    renameSync: (a, b) => { if (!files.has(a)) throw nf(); files.set(b, files.get(a)); files.delete(a) },
    mkdirSync: () => undefined,
    rmSync: (p) => { files.delete(p) },
    appendFileSync: (p, d) => { files.set(p, (files.get(p) ?? '') + d) },
    statSync: (p) => ({ size: (files.get(p) ?? '').length }),
  }
}

/** The default template (en) plus a custom role (ops) and a second QA agent; `edit` rewrites file texts by rel. */
function filesOf(edit = {}) {
  const draft = json(M.defaultDraft('en'))
  draft.goal = 'Ship the notes screen'
  const files = M.renderTeamFiles(draft).map((f) => (f.rel === 'roles/qa.md' ? { ...f, text: f.text.replace('count: 1', 'count: 2') } : f))
  files.push({ rel: 'roles/ops.md', text: '---\nname: Ops\nkind: custom\nprovider: claude\npermission: custom\nallowedTools: Grep, Bash(npm run build:*)\ncount: 1\n---\n\nYou run the builds.\n' })
  return files.map((f) => (edit[f.rel] ? { ...f, text: edit[f.rel](f.text) } : f))
}
/** A Codex Lead and Codex research (their runs report by block, decision 7). */
const codexEdit = {
  'roles/lead.md': (t) => t.replace('provider: claude\nmodel: opus\neffort: high', 'provider: codex'),
  'roles/research.md': (t) => t.replace('provider: claude\nmodel: sonnet', 'provider: codex'),
}
function trustedOf(files) {
  const parsed = M.parseDefinition(files)
  assert.ok(parsed.ok, `the test definition parses: ${JSON.stringify(parsed.errors)}`)
  return { def: parsed.def, sha256: sha(M.canonicalDefText(files)), goalHash: sha(parsed.def.goal), trustedAt: 1, files }
}

const baseFacts = (o = {}) => ({ sawProtocol: true, resultSeen: true, isError: false, maxTurns: false, unknownSession: false, harnessCrash: false, finalText: '', denials: [], digest: { tools: 0, families: {}, files: [] }, toolCalls: 0, teamCalls: 0, fileEdits: 0, ...o })

/** A strict store on one definition, with the helpers every section uses. */
function world(o = {}) {
  const files = o.files ?? filesOf()
  const def = trustedOf(files)
  const clock = { now: 1_800_000_000_000 }
  let runSeq = 0
  let sessSeq = 0
  const ctx = (d = def) => ({ now: clock.now, def: d, newRunId: () => `r-${(++runSeq).toString(16).padStart(12, '0')}`, newSessionId: () => `${String(++sessSeq).padStart(8, '0')}-0000-4000-8000-000000000000` })
  const timer = new M.DeadlineTimer(() => undefined, { now: () => clock.now, setTimeout: () => 0, clearTimeout: () => undefined })
  const deps = { dir: () => `/mem/${TEAM_ID}`, emit: () => undefined, timer, live: () => false, now: () => clock.now, fs: memFs(), log: () => undefined, strict: true, newGen: () => GEN }
  const { store } = M.TeamStore.load(deps, TEAM_ID, def)
  const w = { def, files, clock, store, ctx }
  w.commit = (res, label) => {
    check(res.ok, `${label} (${res.ok ? 'ok' : `${res.error}${res.reason ? ` ${res.reason}` : ''}`})`)
    return store.commit(res, ['board'])
  }
  w.tick = (ms = 1000) => { clock.now += ms }
  w.rt = () => store.rt
  w.task = (id) => store.rt.tasks.find((t) => t.id === id)
  w.card = (id) => store.rt.cards.find((c) => c.id === id)
  w.approval = (id) => store.rt.approvals.find((a) => a.id === id)
  w.agent = (id) => store.rt.agents.find((a) => a.id === id)
  w.run = (id) => store.rt.activeRuns.find((r) => r.id === id)
  w.create = (title, extra = {}) => w.commit(M.createTask(store.rt, user, { title, ...extra }, ctx()), `create ${title}`).result.task.id
  w.admit = (agentId, taskId, mode, o2 = {}) => {
    const a = w.agent(agentId)
    const role = def.def.roles.find((r) => r.id === a.roleId)
    const profile = mode === 'plan' ? 'readonly' : role.permission
    const sessionKey = taskId ?? (mode === 'lead' ? 'lead' : 'free')
    const req = { agentId, sessionKey, mode, reason: o2.reason ?? 'assigned', since: clock.now, priority: 'normal', approved: true, bypassCooldown: false }
    if (taskId) req.taskId = taskId
    if (o2.refs) req.refs = o2.refs
    // Every run of a task with a worktree works in it (I20); the rest in the repo root.
    const cwd = (taskId && w.task(taskId).worktree?.path) ?? 'C:\\repo'
    const res = M.admitRun(store.rt, req, { sessionKey, resume: null, cwd, profile, sysHash: 'h' }, ctx())
    const id = w.commit(res, `admit ${agentId} ${mode}${taskId ? ` ${taskId}` : ''}`).result.run.id
    w.treeFor(id)
    return id
  }
  /** RunStarter's prep step 2 (decision 24): a writing assignee's worktree task gets its tree at its first run. */
  w.mkWt = (taskId) => ({ path: `C:\\wt\\${taskId}`, branch: `sn/t-012345-${taskId.slice(2)}`, base: 'a'.repeat(40), baseBranch: 'main', slug: `t-012345-${taskId.slice(2)}`, createdAt: clock.now, owner: M.teamWorktreeOwner(TEAM_ID, GEN, taskId) })
  w.treeFor = (runId) => {
    const run = w.run(runId)
    const t = run && run.taskId ? w.task(run.taskId) : undefined
    if (!t || t.worktree || t.isolation !== 'worktree' || !t.assignee) return
    const role = def.def.roles.find((r) => r.id === w.agent(t.assignee).roleId)
    if (role.permission !== 'total' && role.permission !== 'custom') return
    store.commit(M.setRunWorktree(store.rt, runId, w.mkWt(t.id), ctx()), ['board'])
  }
  w.start = (runId, delivered = NO_DELIVERY) => {
    w.commit(M.markStarting(store.rt, runId, { pid: 4242, delivered }, ctx()), `start ${runId}`)
    w.commit(M.markRunning(store.rt, runId, { at: clock.now, sysHash: 'h' }, ctx()), `running ${runId}`)
  }
  w.go = (agentId, taskId, mode, o2) => {
    const id = w.admit(agentId, taskId, mode, o2)
    w.start(id)
    return id
  }
  w.actor = (runId) => {
    const r = w.run(runId)
    return { kind: 'agent', agentId: r.agentId, runId, roleKind: r.roleKind }
  }
  w.tool = (runId, method, params = {}, extra = {}) => M.applyTool(store.rt, w.actor(runId), { method, params, ...extra }, ctx())
  w.finish = (runId, o2 = {}) => {
    const run = w.run(runId)
    const end = { at: clock.now, exit: { code: 0, signal: null }, facts: baseFacts(o2.facts), teamWrites: o2.teamWrites ?? 0 }
    const terminal = M.terminalOf(run, end)
    const policy = M.afterRunPolicy(M.runEndFactsOf(store.rt, terminal, clock.now))
    return w.commit(M.finishRun(store.rt, runId, end, policy, { now: clock.now }), `finish ${runId}`)
  }
  /**
   * The run end as TeamService.finalizeClosed does it (2.7.0 runtime fixes): permissionWaitOf on the runtime before the
   * end, the policy with that fact, then finishRun with the trusted definition, so its follow-ups ask or cancel.
   */
  w.end = (runId, o2 = {}) => {
    const run = w.run(runId)
    const end = { at: clock.now, exit: { code: 0, signal: null }, facts: baseFacts(o2.facts), teamWrites: o2.teamWrites ?? 0 }
    const terminal = M.terminalOf(run, end)
    const endCtx = { now: clock.now }
    const ask = { ctx: ctx(), protect: PROTECT }
    const wait = M.permissionWaitOf(store.rt, terminal, end.facts, endCtx, ask)
    const policy = M.afterRunPolicy(M.runEndFactsOf(store.rt, terminal, clock.now, { permissionWait: wait }))
    w.commit(M.finishRun(store.rt, runId, end, policy, endCtx, ask), `end ${runId}`)
    return wait
  }
  // B close: a permission decide carries the rev the user saw (ApprovalView.rev), as the desktop and the phone send it;
  // `f` given is used as is (the rev checks pass their own).
  const revOf = (id) => {
    const a = store.rt.approvals.find((x) => x.id === id)
    return a?.kind === 'permission' ? { rev: a.rev ?? 1 } : undefined
  }
  w.decide = (actor, id, decision, note, f) => M.decideApproval(store.rt, actor, id, decision, note, ctx(), f ?? revOf(id))
  w.answer = (actor, id, a) => M.answerCard(store.rt, actor, id, a, ctx())
  w.needs = () => M.teamNeedsRows(M.needsInputOf(store.rt, 'trusted', undefined, def))
  w.commit(M.reconcileAgents(store.rt, ctx()), 'the roster')
  return w
}

// ---- 1. sha256Utf8 and the grant patterns -----------------------------------------------------------
function hashAndGrantChecks() {
  for (const s of ['', 'abc', 'Diseñador UX ñandú', '\u{1F600} emoji', 'lone \uD800 surrogate', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'ü'.repeat(70_000)]) {
    check(M.sha256Utf8(s) === sha(s), `sha256Utf8 equals Node's createHash for ${JSON.stringify(s.slice(0, 20))} (${s.length} chars)`)
  }
  // Item 1 of B5 (E10 SPIKE): grants never produce a PowerShell(...) rule, for any input.
  const words = ['npm', 'test', 'git', 'status', 'Get-ChildItem', 'src', 'x&calc', '|', 'npx', 'tsc', 'snaos', 'team', 'node', 'build.cmd', '"quoted"', '$env:X', 'push', 'log', ';', 'a=b']
  let seed = 7
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n }
  let anyPs = false
  let bashSeen = 0
  for (let i = 0; i < 2000; i++) {
    const tool = ['PowerShell', 'Bash', 'powershell', 'Read', 'mcp__x__y'][rnd(5)]
    const cmd = Array.from({ length: 1 + rnd(4) }, () => words[rnd(words.length)]).join(' ')
    const out = M.grantPatternOf({ tool, input: { command: cmd } })
    if (out.some((p) => /powershell/i.test(p))) anyPs = true
    bashSeen += out.filter((p) => p.startsWith('Bash(')).length
    if (!out.every(M.isGrantable)) anyPs = true
  }
  check(!anyPs && bashSeen > 100, 'grantPatternOf never returns a PowerShell rule (2000 random shell denials), each rule isGrantable', { bashSeen })
  same(M.grantPatternOf({ tool: 'PowerShell', input: { command: 'npm test -- --watch' } }), ['Bash(npm test:*)'], 'a PowerShell denial grants its Bash rule only')
  check(!M.isGrantable('PowerShell(npm test:*)') && !M.isGrantable('PowerShell(Get-ChildItem:*)') && !M.isGrantable('powershell(ls:*)') && M.isGrantable('Bash(npm test:*)'), 'isGrantable refuses every PowerShell rule (npm.cmd re-parses %* in cmd.exe: x&calc)')
  // The same hole through Bash: Git Bash hands a .cmd or .bat to cmd.exe too, so a grant never names one.
  const batch = ['Bash(npm.cmd test:*)', 'Bash(NPX.CMD tsc:*)', 'Bash(C:/x/build.bat:*)', 'Bash(./run.cmd)', 'Bash(FOO=1 npm.cmd:*)', 'Bash(env yarn.cmd:*)', 'Bash(build.c:*)', 'Bash(build.:*)', 'Bash(tool.ba:*)', 'Bash(CI=1 tool.cm:*)']
  check(!batch.some(M.isGrantable) && M.isGrantable('Bash(make all:*)') && M.isGrantable('Bash(./build.sh all)') && M.isGrantable('Bash(gcc main.c)'), 'isGrantable refuses a Bash rule that names a batch file (or a prefix whose program word grows into one)', batch.filter(M.isGrantable))
  same([M.grantPatternOf({ tool: 'PowerShell', input: { command: 'npm.cmd test x&calc' } }), M.grantPatternOf({ tool: 'Bash', input: { command: 'C:/tools/build.BAT all' } })], [[], []], 'a denial of a batch file grants nothing')
  // Security decision 1 (B5 integration): a grant never ends in a one-word prefix rule: if `:*` matched by plain text,
  // Bash(make:*) would also match `make.cmd 'x&calc'`. A one-word program gets its exact rule; Bash(npm test:*) stays.
  const prefixes = ['Bash(make:*)', 'Bash(./build.sh:*)', 'Bash(npm.cmdx:*)', 'Bash(CI=1 make:*)', 'Bash(A=1:*)']
  check(!prefixes.some(M.isGrantable) && M.isGrantable('Bash(make)') && M.isGrantable('Bash(npm test:*)'), 'isGrantable: no one-word program prefix; the exact rule and a multi-word prefix are grantable', prefixes.filter(M.isGrantable))
  same([M.grantPatternOf({ tool: 'Bash', input: { command: 'make' } }), M.grantPatternOf({ tool: 'PowerShell', input: { command: 'make' } }), M.grantPatternOf({ tool: 'Bash', input: { command: 'npm test -- -w' } })], [['Bash(make)'], ['Bash(make)'], ['Bash(npm test:*)']], 'grantPatternOf: `make` -> Bash(make) (never make:*), `npm test ...` -> Bash(npm test:*)')
  same(M.grantPatternOf({ tool: 'Bash', input: { command: "make 'x&calc'" } }), [], 'a one-word program with more than plain words: nothing (its exact rule would not match, its prefix is not grantable)')
  // Security decision 2: shell and interpreter escapes are never grantable.
  const esc = ['bash -c "rm -rf x"', 'sh x.sh', 'zsh', 'dash -c x', 'cmd /c del x', 'powershell -c x', 'pwsh -File x.ps1', 'wsl ls', 'env A=1 make', 'xargs rm', 'eval "$X"', 'exec make', 'sudo make', 'start calc', 'nohup make', 'timeout 9 make',
    'node -e "1"', 'node -p 1', 'node --eval 1', 'python -c "1"', 'python3 -c 1', 'py -c 1', 'ruby -e 1', 'perl -e 1', 'deno eval 1', 'bun -e 1']
  same(esc.filter((c) => !M.isShellEscape(c)), [], 'isShellEscape: every listed shell, wrapper and inline-code interpreter')
  same(esc.flatMap((command) => ['Bash', 'PowerShell'].flatMap((tool) => M.grantPatternOf({ tool, input: { command } }))), [], 'none of them grants a rule, through either shell tool')
  check(!['Bash(bash -c:*)', 'Bash(node -e:*)', 'Bash(python -c:*)', 'Bash(env make:*)', 'Bash(xargs -0:*)', 'Bash(deno eval:*)'].some(M.isGrantable), 'nor is any such rule grantable')
  // The allow list of a run drops a PowerShell rule even if one sat in the task's grants (state written before B5).
  const argv = M.teamArgv({ provider: 'claude', profile: 'readonly', grants: ['Bash(npm test:*)', 'PowerShell(npm test:*)'], session: { kind: 'new', sessionId: '00000001-0000-4000-8000-000000000000' }, cwd: 'C:\\repo' }).argv
  check(argv.includes('Bash(npm test:*)') && !argv.some((a) => a.startsWith('PowerShell(npm')), 'teamArgv: a Bash grant reaches --allowedTools, a PowerShell one never does', argv)
}

// ---- 2. plan flow: T4, T5, T6, small plans, the Lead, no exec without an approved plan ------------------
function planChecks() {
  const w = world()
  const t1 = w.create('Login con Google', { assignee: 'dev' })
  check(M.todoModeOf(w.task(t1)) === 'plan', 'a task that needs a plan wants a plan run first (T2)')
  const plan1 = w.go('dev', t1, 'plan')
  check(w.task(t1).state === 'doing' && w.task(t1).phase === 'planning' && w.run(plan1).profile === 'readonly', 'admitted: doing/planning, readonly')
  same(w.tool(plan1, 'team.plan', { text: '   ' }).error, 'bad_request', 'an empty plan')
  same(w.tool(plan1, 'team.plan', { text: 'x', extra: 1 }).error, 'bad_request', 'a param outside 5.3')
  same(w.tool(plan1, 'team.review', {}).error, 'forbidden', 'review from a plan run: forbidden by mode')
  w.tick()
  let r = w.tool(plan1, 'team.plan', { text: '1. Read\n2. Change\r\n3. Test' })
  w.commit(r, 'team.plan')
  const ap1 = r.result.approvalId
  same(r.result, { approvalId: ap1, concluded: 'plan' }, 'team.plan answers {approvalId, concluded}')
  let t = w.task(t1)
  check(t.phase === 'planApproval' && t.state === 'doing' && t.plan.rev === 1 && t.plan.status === 'pending' && t.plan.text === '1. Read\n2. Change\n3. Test' && t.plan.approvalId === ap1 && !t.next, 'T4: planApproval, the plan pending rev 1 (CRLF normalized)')
  const a1 = w.approval(ap1)
  check(a1.kind === 'plan' && a1.state === 'pending' && a1.decider === 'user' && a1.payload.planRev === 1 && a1.payload.small === false && a1.createdBy.agentId === 'dev', 'a big plan: the user decides it')
  check(w.run(plan1).concludedBy.tool === 'plan' && r.effects.some((e) => e.kind === 'deadline' && e.key === `run:${plan1}:conclude` && e.at === w.clock.now + M.CONCLUDE_GRACE_MS), 'the run concluded; the grace deadline is armed (decision 35)')
  same(w.tool(plan1, 'team.comment', { target: t1, text: 'otra cosa' }).reason, 'concluded', 'a write after the terminal tool: conflict {concluded}')
  same(w.tool(plan1, 'team.plan', { text: 'again' }).reason, 'concluded', 'a second terminal tool too')
  check(!M.modeFits(w.task(t1), 'exec') && !M.modeFits(w.task(t1), 'plan'), 'no run fits planApproval: no exec without an approved plan (B5 acceptance)')
  check(w.needs().some((n) => n.id === ap1 && n.approvalKind === 'plan'), 'the big plan is in Te necesita')
  w.finish(plan1)
  check(w.task(t1).phase === 'planApproval' && w.rt().activeRuns.length === 0, 'the concluded run ends; the task waits on the user')

  same(w.decide(user, ap1, 'reject', undefined).error, 'bad_request', 'a plan reject needs a note')
  same(w.decide(user, ap1, 'reject', 'a\u0007b').error, 'bad_request', 'a note with a control character')
  w.tick()
  w.commit(w.decide(user, ap1, 'reject', 'Falta el caso offline'), 'T6 reject')
  t = w.task(t1)
  check(t.phase === 'planning' && t.plan.status === 'rejected' && t.plan.decidedBy.kind === 'user' && t.next.agentId === 'dev' && t.next.mode === 'plan' && t.next.reason === 'planRejected', 'T6: back to planning, the plan rejected, a plan wake for the Dev')
  const note = w.rt().comments[t1].at(-1)
  check(note.kind === 'review' && note.text === 'Falta el caso offline' && note.forAgent === 'dev' && !note.deliveredRunId, 'the note goes to the Dev as a review comment')
  same(w.approval(ap1).state, 'rejected', 'the approval is rejected')
  same(w.decide(phone, ap1, 'approve').reason, 'already_decided', 'deciding it again (the phone): already_decided')

  // A small plan: the Lead decides it (decision 29), it is not in Te necesita, and the Lead approves it.
  const plan2 = w.go('dev', t1, 'plan', { reason: 'planRejected' })
  w.tick()
  r = w.tool(plan2, 'team.plan', { text: 'Smaller plan', small: true })
  w.commit(r, 'team.plan small')
  const ap2 = r.result.approvalId
  check(w.task(t1).plan.rev === 2 && w.approval(ap2).decider === 'lead' && w.approval(ap2).payload.small === true, 'T4: rev 2, small, decider lead')
  // The Lead's best level with the goal already read (else its kickoff would be the one an agent's minimum shows).
  const leadWakes = () => M.candidatesOf({ ...w.rt(), goalSeenHash: w.def.goalHash }, w.def.def, w.def.goalHash, { now: w.clock.now, manual: [] }).filter((q) => q.agentId === 'lead').map((q) => q.reason)
  check(leadWakes().includes('leadApproval') && !w.agent('lead').next && r.effects.some((e) => e.kind === 'dispatch'), 'the Lead gets a leadApproval level, derived from the pending approval (no durable wake mark)', leadWakes())
  check(!w.needs().some((n) => n.id === ap2), 'a lead-decided approval does not count in Te necesita')
  w.finish(plan2)
  const devRunNow = w.go('dev-2', undefined, 'free')
  same(M.decideApproval(w.rt(), w.actor(devRunNow), ap2, 'approve', undefined, w.ctx()).error, 'forbidden', 'a Dev never decides an approval')
  w.finish(devRunNow)
  const leadRun = w.go('lead', undefined, 'lead', { reason: 'leadApproval' })
  same(w.tool(leadRun, 'team.approve', { plan: 't-99' }).error, 'not_found', 'team approve of an unknown task')
  w.tick()
  r = w.tool(leadRun, 'team.approve', { plan: t1 })
  w.commit(r, 'team.approve --plan')
  same(r.result, { concluded: 'approvePlan' }, 'team approve answers {concluded: approvePlan}')
  t = w.task(t1)
  check(t.phase === 'executing' && t.plan.status === 'approved' && t.plan.decidedBy.agentId === 'lead' && t.next.mode === 'exec' && t.next.reason === 'planApproved' && t.next.agentId === 'dev', 'T5 by the Lead: executing, a planApproved exec wake for the Dev')
  check(w.approval(ap2).state === 'approved' && w.approval(ap2).decidedBy.kind === 'agent' && M.modeFits(t, 'exec'), 'the approval is the Lead\'s; now an exec run fits')
  w.finish(leadRun)

  // The Lead may not approve a big plan, nor one when the team does not allow it; the user may decide a lead one.
  const t2 = w.create('Buscar notas', { assignee: 'dev-2' })
  const p3 = w.go('dev-2', t2, 'plan')
  w.commit(w.tool(p3, 'team.plan', { text: 'Big plan' }), 'a big plan')
  w.finish(p3)
  const ap3 = w.approval(w.task(t2).plan.approvalId)
  const lead2 = w.go('lead', undefined, 'lead')
  same(w.tool(lead2, 'team.approve', { plan: t2 }).error, 'forbidden', 'the Lead approving a big plan: forbidden')
  w.finish(lead2)
  const noSmall = world({ files: filesOf({ 'team.md': (x) => x.replace('leadApprovesSmallPlans: true', 'leadApprovesSmallPlans: false') }) })
  const nt = noSmall.create('x', { assignee: 'dev' })
  const np = noSmall.go('dev', nt, 'plan')
  noSmall.commit(noSmall.tool(np, 'team.plan', { text: 'tiny', small: true }), 'a small plan with leadApprovesSmallPlans false')
  check(noSmall.approval(noSmall.task(nt).plan.approvalId).decider === 'user', 'leadApprovesSmallPlans false: the user decides even a small plan')
  w.commit(w.decide(user, ap3.id, 'approve', 'Dale'), 'the user approves')
  check(w.task(t2).phase === 'executing' && w.approval(ap3.id).note === 'Dale', 'T5 by the user, with its note')
  // The user decides a small plan before the Lead runs: the Lead's level ends with it (no run for a plan that no longer waits).
  const u = world()
  const ut = u.create('Chica', { assignee: 'dev' })
  const up = u.go('dev', ut, 'plan')
  u.commit(u.tool(up, 'team.plan', { text: 'tiny', small: true }), 'a small plan')
  u.finish(up)
  const uWakes = () => M.candidatesOf({ ...u.rt(), goalSeenHash: u.def.goalHash }, u.def.def, u.def.goalHash, { now: u.clock.now, manual: [] }).filter((q) => q.agentId === 'lead').map((q) => q.reason)
  check(uWakes().includes('leadApproval'), 'the Lead would run for the small plan', uWakes())
  u.commit(u.decide(user, u.task(ut).plan.approvalId, 'approve'), 'the user decides it first')
  check(!uWakes().includes('leadApproval') && !u.agent('lead').next, 'decided by the user first: no leadApproval level is left for the Lead', uWakes())

  // Lead escalation (decision 29): a small plan the Lead saw in a run that ended without deciding goes to the user.
  const t3 = w.create('Exportar', { assignee: 'dev' })
  const p4 = w.go('dev', t3, 'plan')
  w.commit(w.tool(p4, 'team.plan', { text: 'small one', small: true }), 'a small plan')
  w.finish(p4)
  const ap4 = w.task(t3).plan.approvalId
  const lead3 = w.admit('lead', undefined, 'lead')
  w.start(lead3, { comments: [], cards: [], approvals: [ap4] })
  check(w.approval(ap4).leadSeenRunId === lead3, 'R2: the Lead run got the small plan in its prompt')
  w.finish(lead3)
  w.commit(M.reconcileTasks(w.rt(), w.def.def, w.ctx()), 'reconcileTasks')
  check(w.approval(ap4).decider === 'user' && w.needs().some((n) => n.id === ap4), 'the Lead ended without deciding: the decider is the user, and it counts now')
  const esc = w.rt().comments.lead.at(-1)
  check(esc.sys.key === 'leadEscalation' && esc.sys.vars.taskId === t3 && !esc.forAgent && esc.text === '', 'a leadEscalation system note in the Lead thread, for nobody')
}

// ---- 3. QA: T7, T8, T9, rounds to blocked, the sticky QA, QA without a verdict ------------------------
function qaChecks() {
  const w = world()
  const t1 = w.create('Sync', { assignee: 'dev', needsPlan: false })
  let ex = w.go('dev', t1, 'exec')
  same(w.tool(ex, 'team.verdict', { verdict: 'approve', text: 'x' }).error, 'forbidden', 'a Dev cannot give a verdict')
  w.tick()
  let r = w.tool(ex, 'team.review', { text: 'Listo, ver la rama' })
  w.commit(r, 'team.review')
  same(r.result, { concluded: 'review' }, 'team review answers {concluded}')
  let t = w.task(t1)
  check(t.state === 'review' && t.phase === 'qa' && t.review.qaAgentId === 'qa' && t.next.agentId === 'qa' && t.next.mode === 'qa' && t.next.reason === 'review', 'T7: review/qa for the first idle QA agent, a review wake')
  const sum = w.rt().comments[t1].at(-1)
  check(sum.kind === 'comment' && sum.text === 'Listo, ver la rama' && sum.forAgent === 'qa', 'the Dev\'s summary is queued for the QA')
  w.finish(ex)
  const qaIds = []
  for (let round = 1; round <= 3; round++) {
    const qa = w.go(t.review.qaAgentId, t1, 'qa', { reason: 'review' })
    qaIds.push(w.run(qa).agentId)
    w.tick()
    r = w.tool(qa, 'team.verdict', { verdict: 'changes', text: `Ronda ${round}: falta el test` })
    w.commit(r, `verdict changes ${round}`)
    t = w.task(t1)
    const last = w.rt().comments[t1].at(-1)
    check(t.review.round === round && t.review.lastVerdict === 'changes' && last.kind === 'review' && last.forAgent === 'dev', `T9 round ${round}: round + 1, the review comment for the Dev`)
    w.finish(qa)
    if (round < 3) {
      check(t.state === 'doing' && t.phase === 'executing' && t.next.reason === 'changes' && t.next.agentId === 'dev', `round ${round}: back to executing with a changes wake`)
      ex = w.go('dev', t1, 'exec', { reason: 'changes' })
      w.commit(w.tool(ex, 'team.review', {}), `review again ${round}`)
      w.finish(ex)
      t = w.task(t1)
    }
  }
  same(qaIds, ['qa', 'qa', 'qa'], 'the QA agent sticks to the task (another idle QA exists)')
  t = w.task(t1)
  const qaCard = w.card(t.blocked.reason.cardId)
  check(t.state === 'blocked' && t.phase === 'executing' && t.blocked.reason.why === 'qaRounds' && t.blocked.resume.state === 'doing' && t.review.round === t.review.max && qaCard.state === 'open', 'the third changes: blocked {qaRounds}, resume doing/executing, round at the max (I11)')
  same(qaCard.from.actions, ['resume', 'toTodo', 'cancelTask'], 'the qaRounds card offers one more round, back to todo or cancel')
  check(w.needs().some((n) => n.id === qaCard.id), 'the card is in Te necesita')
  w.commit(w.answer(user, qaCard.id, { action: 'resume' }), 'resume from the qaRounds card')
  t = w.task(t1)
  check(t.state === 'doing' && t.phase === 'executing' && t.next.reason === 'changes' && t.next.bypassCooldown === true && w.card(qaCard.id).state === 'answered', 'resumed with the changes wake the block kept')
  ex = w.go('dev', t1, 'exec', { reason: 'changes' })
  w.commit(w.tool(ex, 'team.review', {}), 'review after the extra round')
  w.finish(ex)
  const qa = w.go('qa', t1, 'qa')
  same(w.tool(qa, 'team.verdict', { verdict: 'maybe', text: 'x' }).error, 'bad_request', 'a verdict that is not approve or changes')
  same(w.tool(qa, 'team.verdict', { verdict: 'approve' }).error, 'bad_request', 'a verdict needs its text')
  w.tick()
  r = w.tool(qa, 'team.verdict', { verdict: 'approve', text: 'Probado: login, logout y offline' })
  w.commit(r, 'T8 approve')
  t = w.task(t1)
  const fin = w.rt().approvals.find((a) => a.kind === 'final' && a.taskId === t1 && a.state === 'pending')
  check(t.state === 'review' && t.phase === 'userOk' && t.review.lastVerdict === 'approve' && !t.next && fin && fin.payload.summary === 'Probado: login, logout y offline' && fin.payload.hasWorktree === true, 'T8: review/userOk with the final approval and the QA\'s summary')
  check(w.rt().comments[t1].at(-1).kind === 'review' && !w.rt().comments[t1].at(-1).forAgent, 'the approving verdict stays on the task as a review comment for nobody')
  w.finish(qa)

  // The other QA agent may not give the verdict of a task it does not review.
  const t2 = w.create('Otra', { assignee: 'dev-2', needsPlan: false })
  const e2 = w.go('dev-2', t2, 'exec')
  w.commit(w.tool(e2, 'team.review', {}), 'review t2')
  w.finish(e2)
  const other = w.task(t2).review.qaAgentId === 'qa' ? 'qa-2' : 'qa'
  // An exec or qa run is admitted by its phase agent only in dispatch; here a run of the other QA tries the verdict.
  const wrong = w.go(other, undefined, 'free')
  same(w.tool(wrong, 'team.verdict', { verdict: 'approve', text: 'x' }).error, 'forbidden', 'a QA run that is not the task\'s qa run: forbidden (mode)')
  w.finish(wrong)

  // QA without a verdict (afterRunPolicy, B4): one continuation, then a qaNoVerdict card.
  const q1 = w.go(w.task(t2).review.qaAgentId, t2, 'qa')
  w.finish(q1, { facts: { digest: { tools: 3, families: { read: 3 }, files: [] }, toolCalls: 3 } })
  t = w.task(t2)
  check(t.next && t.next.reason === 'continuation' && t.counters.continuations === 1, 'a QA run without a verdict: one continuation')
  const q2 = w.go(t.review.qaAgentId, t2, 'qa', { reason: 'continuation' })
  w.finish(q2, { facts: { digest: { tools: 1, families: { read: 1 }, files: [] }, toolCalls: 1 } })
  t = w.task(t2)
  check(t.state === 'blocked' && t.blocked.reason.why === 'qaNoVerdict' && w.card(t.blocked.reason.cardId).state === 'open', 'the second: blocked with a qaNoVerdict card')
  // B5 integration, second round: the task view names that exact card (TaskBlockedView.cardId), so the drawer finds it.
  same(M.taskSummary(w.rt(), t, { def: w.def.def, needs: [] }).blocked, { kind: 'card', why: 'qaNoVerdict', cardId: t.blocked.reason.cardId }, 'the blocked view carries the card that blocks the task')
  const unfilled = { ...t, blocked: { ...t.blocked, reason: { ...t.blocked.reason, cardId: '' } } }
  same(M.taskSummary(w.rt(), unfilled, { def: w.def.def, needs: [] }).blocked, { kind: 'card', why: 'qaNoVerdict' }, 'a block whose card id was never filled names no card (the drawer falls back to why)')
  // retry from the card: a fresh series (counters back to 0) and a retry wake for the QA.
  w.commit(w.answer(user, t.blocked.reason.cardId, { action: 'retry' }), 'retry from the qaNoVerdict card')
  t = w.task(t2)
  check(t.state === 'review' && t.phase === 'qa' && t.next.reason === 'retry' && t.next.agentId === t.review.qaAgentId && t.counters.continuations === 0, 'retry: back in qa, a retry wake, counters reset')

  // No QA role: T7 goes straight to the user's OK with a noQaRole system note (T8 at once).
  const noQa = world({ files: filesOf().filter((f) => f.rel !== 'roles/qa.md') })
  const nt = noQa.create('Sin QA', { assignee: 'dev', needsPlan: false })
  const ne = noQa.go('dev', nt, 'exec')
  noQa.commit(noQa.tool(ne, 'team.review', { text: 'Hecho' }), 'review without a QA role')
  const tt = noQa.task(nt)
  const list = noQa.rt().comments[nt]
  check(tt.phase === 'userOk' && !tt.review.qaAgentId && noQa.rt().approvals.some((a) => a.kind === 'final' && a.taskId === nt && a.state === 'pending' && a.payload.summary === 'Hecho'), 'no QA role: review/userOk with the final approval')
  check(list.at(-1).sys.key === 'noQaRole' && list.at(-1).author.kind === 'system' && list.at(-2).text === 'Hecho' && !list.at(-2).forAgent, 'a noQaRole system note, and the summary for nobody')
}

// ---- 4. the final OK: T10, T11 (integrate, ahead 0, no worktree), T12 --------------------------------
function finalChecks() {
  const w = world()
  // T12 then T11 without a worktree: done.
  const t1 = w.create('Main iso', { assignee: 'dev', needsPlan: false, isolation: 'main' })
  let ex = w.go('dev', t1, 'exec')
  same(w.tool(ex, 'team.verdict', { verdict: 'approve', text: 'x' }).error, 'forbidden', 'a Dev has no verdict')
  w.tick()
  let r = w.tool(ex, 'team.done', { text: 'Cambié el login' })
  w.commit(r, 'T10 done (dev, isolation main)')
  const f1 = r.result.approvalId
  check(r.result.concluded === 'done' && w.task(t1).phase === 'userOk' && w.approval(f1).kind === 'final' && w.approval(f1).payload.summary === 'Cambié el login', 'T10: userOk with the final approval and the report')
  w.finish(ex)
  same(w.decide(user, f1, 'reject').error, 'bad_request', 'a final reject needs a note')
  w.commit(w.decide(user, f1, 'reject', 'No compila'), 'T12 reject')
  let t = w.task(t1)
  check(t.state === 'doing' && t.phase === 'executing' && t.next.reason === 'finalRejected' && w.rt().comments[t1].at(-1).text === 'No compila' && w.rt().comments[t1].at(-1).forAgent === 'dev', 'T12: back to executing with the note for the Dev')
  ex = w.go('dev', t1, 'exec', { reason: 'finalRejected' })
  w.commit(w.tool(ex, 'team.done', {}), 'done again')
  // An open agent card and a pending permission approval of the task: the final OK closes them (requirement 3).
  const extra = M.openSystemCard(w.rt(), { why: 'stalled', actions: ['keepWaiting', 'stopRun'], taskId: t1, runId: ex }, w.ctx())
  w.commit(extra, 'a stalled card on the task')
  const stalledId = extra.result.cardId
  w.finish(ex)
  const f2 = w.rt().approvals.find((a) => a.kind === 'final' && a.taskId === t1 && a.state === 'pending').id
  w.commit(w.decide(user, f2, 'approve'), 'T11 approve without a worktree')
  t = w.task(t1)
  check(t.state === 'done' && t.phase === 'none' && !t.next && w.approval(f2).state === 'approved', 'T11 with no worktree: done')
  check(w.card(stalledId).state === 'dismissed' && !w.needs().some((n) => n.taskId === t1), 'and nothing of the task stays in Te necesita')

  // A worktree task (its tree made at the first run, decision 24): integrating with an integrate approval; f.ahead 0 -> done.
  const withTree = (taskId) => w.go('dev-2', taskId, 'exec')
  const t2 = w.create('Con worktree', { assignee: 'dev-2', needsPlan: false })
  ex = withTree(t2)
  check(!!w.task(t2).worktree && w.run(ex).cwd === w.task(t2).worktree.path, 'the writing assignee\'s first run made the task worktree')
  w.commit(w.tool(ex, 'team.review', {}), 'review t2')
  w.finish(ex)
  let qa = w.go(w.task(t2).review.qaAgentId, t2, 'qa')
  w.commit(w.tool(qa, 'team.verdict', { verdict: 'approve', text: 'ok' }), 'approve t2')
  w.finish(qa)
  const f3 = w.rt().approvals.find((a) => a.kind === 'final' && a.taskId === t2 && a.state === 'pending')
  check(f3.payload.hasWorktree === true, 'the final approval knows the task has a worktree')
  w.commit(w.decide(user, f3.id, 'approve'), 'T11 approve with a worktree (ahead unknown)')
  t = w.task(t2)
  const integ = w.rt().approvals.find((a) => a.kind === 'integrate' && a.taskId === t2)
  check(t.state === 'review' && t.phase === 'integrating' && integ && integ.state === 'pending' && integ.payload.branch === t.worktree.branch && integ.payload.base === 'main', 'T11: integrating with a pending integrate approval')
  same([w.decide(user, integ.id, 'approve').error, w.decide(phone, integ.id, 'approve').error, w.decide(user, integ.id, 'reject', 'x').error], ['bad_request', 'bad_request', 'bad_request'], 'an integrate approval is never decided here, from desktop or phone (decision 50)')
  check(w.needs().some((n) => n.id === integ.id && n.approvalKind === 'integrate'), 'the Integrar step is in Te necesita')

  const t3 = w.create('Nada que integrar', { assignee: 'dev-2', needsPlan: false })
  ex = withTree(t3)
  w.commit(w.tool(ex, 'team.review', {}), 'review t3')
  w.finish(ex)
  // Item 4 (B5 integration): the QA run's diff stat (RunStarter computes it at prep) lands on the task at R2, and the
  // final OK view shows it; a final without a QA run (t1) has none.
  qa = w.admit(w.task(t3).review.qaAgentId, t3, 'qa')
  const stat = { files: 2, insertions: 10, deletions: 3, top: [{ path: 'src/a.ts', add: 8, del: 1 }, { path: 'README.md', add: 2, del: 2 }], at: w.clock.now }
  w.commit(M.markStarting(w.rt(), qa, { pid: 7, delivered: NO_DELIVERY, diffStat: stat }, w.ctx()), 'the QA run starts with its diff stat')
  w.commit(M.markRunning(w.rt(), qa, { at: w.clock.now, sysHash: 'h' }, w.ctx()), 'qa running')
  same(json(w.task(t3).diffStat), json(stat), 'the task keeps the diff stat its QA run read')
  w.commit(w.tool(qa, 'team.verdict', { verdict: 'approve', text: 'ok' }), 'approve t3')
  w.finish(qa)
  const f4 = w.rt().approvals.find((a) => a.kind === 'final' && a.taskId === t3 && a.state === 'pending').id
  same(json(M.approvalView(w.rt(), w.approval(f4), w.def).payload.stat), { files: 2, insertions: 10, deletions: 3, top: stat.top }, 'the final OK view carries that stat')
  check(M.approvalView(w.rt(), w.approval(f2), w.def).payload.stat === undefined && !('stat' in json(M.approvalView(w.rt(), w.approval(f2), w.def).payload)), 'a final OK whose task never had a QA stat: no stat field')
  w.commit(w.decide(user, f4, 'approve', undefined, { ahead: 0, rev: 7 }), 'T11 approve with ahead 0 (a rev on a final approval is ignored, B close)')
  check(w.task(t3).state === 'done' && !w.rt().approvals.some((a) => a.kind === 'integrate' && a.taskId === t3), 'T11 with ahead === 0: done, nothing to integrate')

  // Research closes from its plan run (T10); a Dev with a worktree task may not use done.
  const t4 = w.create('Investigar', { assignee: 'research', needsPlan: true })
  const rs = w.go('research', t4, 'plan')
  r = w.tool(rs, 'team.done', { text: 'Conclusión: usar X' })
  w.commit(r, 'research done from its plan run')
  check(w.task(t4).phase === 'userOk' && w.approval(r.result.approvalId).payload.summary === 'Conclusión: usar X', 'research: plan run -> userOk')
  w.finish(rs)
  const t5 = w.create('Dev worktree', { assignee: 'dev', needsPlan: false })
  const d5 = w.go('dev', t5, 'exec')
  same(w.tool(d5, 'team.done', {}).error, 'forbidden', 'a Dev with isolation worktree ends with review, not done')
  w.finish(d5)
}

// ---- 4b. B5 review: T12 of a task that never had its plan approved, and the defensive T3 check ----------------------
function replanChecks() {
  // The finding's case: a research role with `permission: total` (a supported, editable definition) closes a task that
  // needs a plan from its readonly plan run (T10), so the task reaches the final OK with no plan at all.
  const w = world({ files: filesOf({ 'roles/research.md': (t) => t.replace('permission: readonly', 'permission: total') }) })
  check(w.def.def.roles.find((r) => r.id === 'research').permission === 'total', 'the research role writes (permission total)')
  const t1 = w.create('Investigar', { assignee: 'research' })
  check(w.task(t1).needsPlan === true && M.todoModeOf(w.task(t1)) === 'plan', 'it needs a plan (the default): its first run is a plan run')
  const pr = w.go('research', t1, 'plan')
  check(w.run(pr).profile === 'readonly', 'the plan run is readonly even for a total role')
  w.commit(w.tool(pr, 'team.done', { text: 'Conclusión: usar X' }), 'research done from its plan run (T10)')
  w.finish(pr)
  check(w.task(t1).phase === 'userOk' && !w.task(t1).plan, 'review/userOk with no plan')
  const fin = w.rt().approvals.find((a) => a.kind === 'final' && a.taskId === t1 && a.state === 'pending')
  w.tick()
  w.commit(w.decide(user, fin.id, 'reject', 'Compará también con Y'), 'T12: Pedir cambios on that final OK')
  const t = w.task(t1)
  check(t.state === 'doing' && t.phase === 'planning' && !t.plan && t.next && t.next.agentId === 'research' && t.next.mode === 'plan' && t.next.reason === 'finalRejected', 'T12 of a task without an approved plan: back to planning with a finalRejected plan wake, never executing', t)
  const note = w.rt().comments[t1].at(-1)
  check(note.kind === 'review' && note.text === 'Compará también con Y' && note.forAgent === 'research' && w.approval(fin.id).state === 'rejected', 'the note goes to the assignee as a review comment; the final approval is rejected')
  check(M.modeFits(t, 'plan') && !M.modeFits(t, 'exec') && M.phaseModeOf(t) === 'plan', 'a plan run fits it, an exec run does not')
  const wakes = M.candidatesOf(w.rt(), w.def.def, w.def.goalHash, { now: w.clock.now, manual: [] }).filter((q) => q.taskId === t1)
  check(wakes.length === 1 && wakes[0].agentId === 'research' && wakes[0].mode === 'plan' && wakes[0].reason === 'finalRejected', 'the dispatcher asks for a plan run of it', wakes)
  // The defensive T3 check (admitRun): an exec run of a task that needs a plan and has none approved is refused,
  // whatever phase holds it: here forged into executing with an exec wake (what T12 left before the fix), and in todo.
  const execReq = (taskId) => ({ agentId: 'research', taskId, sessionKey: taskId, mode: 'exec', reason: 'finalRejected', since: w.clock.now, priority: 'normal', approved: true, bypassCooldown: false })
  const facts = (taskId) => ({ sessionKey: taskId, resume: null, cwd: 'C:\\repo', profile: 'total', sysHash: 'h' })
  const forged = { ...w.rt(), tasks: w.rt().tasks.map((x) => (x.id === t1 ? { ...x, phase: 'executing', next: { ...x.next, mode: 'exec' } } : x)) }
  const refused = M.admitRun(forged, execReq(t1), facts(t1), w.ctx())
  check(!refused.ok && refused.error === 'conflict' && refused.reason === 'stale', 'admitRun refuses an exec run on it in executing (conflict stale)', refused)
  const t2 = w.create('Otra investigación', { assignee: 'research' })
  const refused2 = M.admitRun(w.rt(), execReq(t2), facts(t2), w.ctx())
  check(!refused2.ok && refused2.error === 'conflict' && refused2.reason === 'stale', 'and in todo (T3 guard: needsPlan and no approved plan)', refused2)
  const t3 = w.create('Sin plan', { assignee: 'research', needsPlan: false })
  check(M.admitRun(w.rt(), execReq(t3), facts(t3), w.ctx()).ok, 'control: a task that needs no plan admits its exec run')
  // The dispatcher never asks for that refused exec run (teamDispatch modeFor): as the agent's minimum it would hold back
  // every other level of the agent (one candidate per agent) and take a cap slot on every pass.
  const forged2 = { ...w.rt(), tasks: w.rt().tasks.map((x) => (x.id === t1 ? { ...x, phase: 'executing', next: { ...x.next, mode: 'exec' } } : x)) }
  const cands2 = M.candidatesOf(forged2, w.def.def, w.def.goalHash, { now: w.clock.now, manual: [] }).filter((q) => q.agentId === 'research')
  check(cands2.length === 1 && cands2[0].taskId === t2 && cands2[0].mode === 'plan', 'no exec candidate for it: the agent\'s next level (its other task) is its candidate', cands2)
  const manual2 = M.candidatesOf(forged2, w.def.def, w.def.goalHash, { now: w.clock.now, manual: [{ agentId: 'research', taskId: t1, reason: 'manual' }] }).filter((q) => q.taskId === t1)
  check(manual2.length === 0, 'nor from "Ejecutar ahora" on it', manual2)
  // B5 review, second round: reconcileTasks reads an executing task's level with that same rule (modeFits: exec only
  // when todoModeOf is exec), so the "Por despachar" item of the refused exec run is dropped, and so is its exec wake;
  // an executing task that needs no plan keeps both.
  const qItem = (id, taskId) => ({ id, agentId: 'research', sessionKey: taskId, taskId, mode: 'exec', reason: 'retry', createdAt: w.clock.now })
  const forged3 = {
    ...forged2,
    tasks: forged2.tasks.map((x) => (x.id === t3 ? { ...x, state: 'doing', phase: 'executing', next: { agentId: 'research', mode: 'exec', reason: 'retry', since: w.clock.now } } : x)),
    queue: [qItem('q-1', t1), qItem('q-2', t3)],
    nextIds: { ...forged2.nextIds, queue: 3 },
  }
  const t1f = forged3.tasks.find((x) => x.id === t1)
  const t3f = forged3.tasks.find((x) => x.id === t3)
  check(!M.modeFits(t1f, 'exec') && M.modeFits(t3f, 'exec') && M.modeFits({ ...t1f, plan: { rev: 1, text: 'p', status: 'approved', small: false, at: 1 } }, 'exec'), 'modeFits: exec in executing only when the task needs no plan or has it approved')
  const rec3 = M.reconcileTasks(forged3, w.def.def, w.ctx())
  check(rec3.ok && rec3.rt.queue.map((q) => q.id).join() === 'q-2', 'reconcileTasks drops the exec item of the task that still needs a plan, keeps the other', rec3.ok && rec3.rt.queue)
  check(!rec3.rt.tasks.find((x) => x.id === t1).next && rec3.rt.tasks.find((x) => x.id === t3).next?.mode === 'exec', 'and its exec wake (no run would ever take it); the other keeps its own')
  // Verifier of the second round: a todo task runs only its todoModeOf (modeFor), so an item queued in the other mode
  // (needsPlan changed in todo since) is dropped too: a "plan" row never starts an exec run, nor an "exec" row a plan.
  check(w.task(t2).state === 'todo' && M.todoModeOf(w.task(t2)) === 'plan' && w.task(t3).state === 'todo' && M.todoModeOf(w.task(t3)) === 'exec', 'two todo tasks of research: one wants a plan, the other its execution')
  const todoQueue = (items) => M.reconcileTasks({ ...w.rt(), queue: items, nextIds: { ...w.rt().nextIds, queue: 9 } }, w.def.def, w.ctx()).rt.queue.map((q) => q.id).join()
  same(todoQueue([qItem('q-5', t2), qItem('q-6', t3)]), 'q-6', 'exec items: the one of the task that needs a plan goes, the other stays')
  same(todoQueue([{ ...qItem('q-7', t2), mode: 'plan' }, { ...qItem('q-8', t3), mode: 'plan' }]), 'q-7', 'plan items: the one of the task that needs no plan goes, the other stays')
  // Its plan run is admitted, readonly, and may close it again (T10).
  const again = w.go('research', t1, 'plan', { reason: 'finalRejected' })
  check(w.run(again).mode === 'plan' && w.run(again).profile === 'readonly' && w.task(t1).phase === 'planning', 'the plan run of the rejected task is admitted, readonly')
  w.commit(w.tool(again, 'team.done', { text: 'Conclusión: X, comparado con Y' }), 'done again from the plan run')
  w.finish(again)
  check(w.task(t1).phase === 'userOk', 'back to the final OK')
  // A task whose plan was approved still goes back to executing on T12 (exec wake).
  const t4 = w.create('Con plan', { assignee: 'dev-2', isolation: 'main' })
  const p4 = w.go('dev-2', t4, 'plan')
  w.commit(w.tool(p4, 'team.plan', { text: '1. Hacer' }), 'a plan')
  w.finish(p4)
  w.commit(w.decide(user, w.task(t4).plan.approvalId, 'approve'), 'T5')
  const e4 = w.go('dev-2', t4, 'exec', { reason: 'planApproved' })
  check(w.run(e4).mode === 'exec', 'an approved plan admits its exec run')
  w.commit(w.tool(e4, 'team.done', { text: 'Hecho' }), 'done (a Dev with isolation main)')
  w.finish(e4)
  const f4 = w.rt().approvals.find((a) => a.kind === 'final' && a.taskId === t4 && a.state === 'pending')
  w.commit(w.decide(user, f4.id, 'reject', 'Falta un caso'), 'T12 with an approved plan')
  check(w.task(t4).phase === 'executing' && w.task(t4).next.mode === 'exec' && w.task(t4).next.reason === 'finalRejected', 'with its plan approved: back to executing with an exec wake')
}

// ---- 5. ask, needs and the answers ----------------------------------------------------------------------
function cardChecks() {
  const w = world()
  const t1 = w.create('Pagos', { assignee: 'dev', needsPlan: false })
  const ex = w.go('dev', t1, 'exec')
  w.tick()
  w.commit(M.addComment(w.rt(), user, t1, 'Usá Stripe', 'comment', w.ctx()), 'a user comment during the run')
  const cid = w.rt().comments[t1].at(-1).id
  check(w.rt().comments[t1].at(-1).forAgent === 'dev', 'it is queued for the Dev')
  same(w.tool(ex, 'team.ask', { text: '¿Stripe o MP?', options: ['Stripe', 'MP'] }).reason, 'newer_comment_not_delivered', 'the ask guard: a newer user comment must be read first')
  w.commit(M.deliverComments(w.rt(), ex, 'dev', [cid]), 'team task get delivers it')
  same(w.tool(ex, 'team.ask', { text: 'x', multi: true }).error, 'bad_request', 'multi without options')
  same(w.tool(ex, 'team.ask', { text: 'x', confirm: true, options: ['a'] }).error, 'bad_request', 'confirm with options')
  same(w.tool(ex, 'team.ask', { text: 'x', options: Array.from({ length: 7 }, (_, i) => `o${i}`) }).error, 'bad_request', 'seven options')
  w.tick()
  let r = w.tool(ex, 'team.ask', { text: '¿Stripe o MP?', options: ['Stripe', '  Mercado\tPago  '], multi: true })
  w.commit(r, 'team.ask with options')
  const k1 = r.result.cardId
  same(r.result, { cardId: k1, concluded: 'ask' }, 'team ask answers {cardId, concluded}')
  const c1 = w.card(k1)
  check(c1.kind === 'choice' && c1.multi === true && c1.options[1] === 'Mercado Pago' && c1.taskId === t1 && c1.from.kind === 'agent' && c1.from.tool === 'ask' && c1.from.runId === ex && c1.state === 'open', 'a choice card, the options on one line each')
  check(w.needs().some((n) => n.id === k1 && n.kind === 'card'), 'an open card is in Te necesita')
  w.finish(ex)
  check(w.task(t1).phase === 'executing' && !w.task(t1).next, 'the asking run concluded; the task waits for the answer')
  same(w.answer(user, k1, { choices: [2] }).error, 'bad_request', 'a choice out of range')
  same(w.answer(user, k1, { choices: [0, 0] }).error, 'bad_request', 'a repeated choice')
  same(w.answer(user, k1, { action: 'dismiss' }).error, 'bad_request', 'a system action on an agent card')
  same(w.answer({ kind: 'system' }, k1, { choices: [0] }).error, 'forbidden', 'only the user answers')
  w.tick()
  w.commit(w.answer(phone, k1, { choices: [1, 0], text: 'Primero MP' }), 'the answer (phone)')
  const a1 = w.card(k1)
  check(a1.state === 'answered' && json(a1.answer.choices).join() === '0,1' && a1.answer.text === 'Primero MP' && a1.answer.by.via === 'phone', 'answered: choices sorted, the text kept, by whom')
  const nx = w.task(t1).next
  check(nx.agentId === 'dev' && nx.mode === 'exec' && nx.reason === 'answer' && nx.refs[0] === k1, 'the asker gets an answer wake on its task')
  same(w.answer(user, k1, { choices: [0] }).reason, 'already_decided', 'a second answer (desktop after phone): already_decided')

  // team needs: a confirm card (Hecho / No puedo).
  const ex2 = w.go('dev', t1, 'exec', { reason: 'answer' })
  r = w.tool(ex2, 'team.needs', { text: 'Necesito la API key de Stripe en .env' })
  w.commit(r, 'team.needs')
  const k2 = r.result.cardId
  check(w.card(k2).kind === 'confirm' && w.card(k2).from.tool === 'needs' && r.result.concluded === 'needs', 'team needs: a confirm card')
  w.finish(ex2)
  same(w.answer(user, k2, {}).error, 'bad_request', 'a confirm answer needs its boolean')
  w.commit(w.answer(user, k2, { confirm: true }), 'Hecho')
  check(w.card(k2).answer.confirm === true && w.task(t1).next.reason === 'answer', 'Hecho wakes the Dev')

  // A text card, and the Lead without a task (agent.next, lead mode).
  const lr = w.go('lead', undefined, 'lead')
  r = w.tool(lr, 'team.ask', { text: '¿Priorizo pagos o login?' })
  w.commit(r, 'the Lead asks')
  const k3 = r.result.cardId
  check(w.card(k3).kind === 'text' && !w.card(k3).taskId, 'a text card with no task')
  w.finish(lr)
  same(w.answer(user, k3, { text: '   ' }).error, 'bad_request', 'a blank text answer')
  same(w.answer(user, k3, { text: 'x'.repeat(M.CARD_TEXT_ANSWER_MAX + 1) }).error, 'bad_request', 'an answer over the cap')
  w.commit(w.answer(user, k3, { text: 'Pagos primero' }), 'answer the Lead')
  check(w.agent('lead').next.mode === 'lead' && w.agent('lead').next.reason === 'answer' && w.agent('lead').next.refs[0] === k3, 'the Lead gets an answer wake in lead mode')
  // The Lead thread has no read tool: no ask guard there.
  const lr2 = w.go('lead', undefined, 'lead', { reason: 'answer' })
  w.tick()
  w.commit(M.addComment(w.rt(), user, 'lead', 'Y no te olvides del logout', 'comment', w.ctx()), 'a user message to the Lead during its run')
  check(w.tool(lr2, 'team.ask', { text: 'ok?' }).ok, 'a Lead run is not held by the ask guard (no way to read the thread)')
  w.finish(lr2)
}

// ---- 6. system card actions ----------------------------------------------------------------------------
function systemCardChecks() {
  const w = world()
  // A prep that failed with a card (cwdMissing, spawnFailed, cliOff): retry re-requests the run and dismiss leaves the
  // task resumable, whether the card blocks the task (T17 through resumeTask) or the task sits in doing (a retry wake).
  const t1 = w.create('Prep', { assignee: 'dev', needsPlan: false })
  let id = w.admit('dev', t1, 'exec')
  w.commit(M.prepFailed(w.rt(), id, { kind: 'request', code: 'cwdMissing' }, 'cwdMissing', w.ctx()), 'prepFailed cwdMissing')
  let card = w.rt().cards.find((c) => c.taskId === t1 && c.from.kind === 'system' && c.from.why === 'cwdMissing' && c.state === 'open')
  let t = w.task(t1)
  const blocks = t.state === 'blocked'
  check(card && (blocks ? t.blocked.reason.kind === 'card' && t.blocked.reason.cardId === card.id && t.blocked.resume.phase === 'executing' : t.state === 'doing' && t.phase === 'executing' && !t.next), `a prep card: the task ${blocks ? 'blocked on it' : 'in doing with no wake'}`)
  same(w.answer(user, card.id, { action: 'toTodo' }).error, 'bad_request', 'an action the card does not offer')
  same(w.answer(user, card.id, { action: 'retry', text: 'x' }).error, 'bad_request', 'a system answer carries only its action')
  w.commit(w.answer(user, card.id, { action: 'retry' }), 'retry')
  t = w.task(t1)
  check(w.card(card.id).state === 'answered' && t.state === 'doing' && t.phase === 'executing' && t.next.agentId === 'dev' && t.next.mode === 'exec' && t.next.reason === 'retry' && t.next.bypassCooldown === true, 'retry: in doing with a retry wake for the agent of the phase')
  id = w.admit('dev', t1, 'exec', { reason: 'retry' })
  w.commit(M.prepFailed(w.rt(), id, { kind: 'request', code: 'spawnFailed' }, 'spawnFailed', w.ctx()), 'prepFailed spawnFailed')
  card = w.rt().cards.find((c) => c.taskId === t1 && c.from.kind === 'system' && c.from.why === 'spawnFailed' && c.state === 'open')
  if (blocks) {
    // The op also takes a card block whose card is still open, and dismisses it (the drawer offers Retomar only once it is closed).
    const early = M.resumeTask(w.rt(), user, t1, w.ctx())
    check(early.ok && early.rt.cards.find((c) => c.id === card.id).state === 'dismissed' && early.rt.tasks.find((x) => x.id === t1).state === 'doing', 'resumeTask of a task blocked on a card still open: the card dismissed in the same result')
  }
  w.commit(w.answer(user, card.id, { action: 'dismiss' }), 'dismiss')
  t = w.task(t1)
  check(w.card(card.id).state === 'dismissed' && !w.needs().some((n) => n.taskId === t1) && t.phase === 'executing' && (blocks ? t.state === 'blocked' : t.state === 'doing' && !t.blocked), 'dismiss: the card leaves Te necesita and the task stays as it was')
  if (blocks) check(M.resumeTask(w.rt(), user, t1, w.ctx()).ok, 'a card block stays resumable (T17)')
  else check(t.state === 'doing' && t.assignee === 'dev' && !t.blocked, 'a task in doing with its assignee stays resumable (Ejecutar ahora)')
  // A card that blocks nothing on a task in a run phase: retry sets the retry wake by itself.
  if (blocks) w.commit(M.resumeTask(w.rt(), user, t1, w.ctx()), 'resume the task')
  const loose = M.openSystemCard(w.rt(), { why: 'spawnFailed', actions: ['retry', 'dismiss'], taskId: t1, vars: { what: 'loose' } }, w.ctx())
  w.commit(loose, 'a card that blocks nothing')
  const looseTask = w.task(t1)
  w.commit({ ok: true, rt: { ...w.rt(), tasks: w.rt().tasks.map((x) => (x.id === t1 ? (() => { const y = { ...x }; delete y.next; return y })() : x)) }, effects: [], result: undefined }, 'no wake on it')
  w.commit(w.answer(user, loose.result.cardId, { action: 'retry' }), 'retry from a card that blocks nothing')
  t = w.task(t1)
  check(looseTask.state === 'doing' && t.state === 'doing' && t.next.reason === 'retry' && t.next.agentId === 'dev', 'retry of a card that blocks nothing: a retry wake for the agent of the phase')
  // B5 integration, seventh round: a prep failure with its own words (RunStarter: a command line too long for the cmd.exe
  // of a .cmd agent CLI) gives the card it opens those vars, the one its task blocks on and the one of a task-less run.
  const tl = w.create('Linea larga', { assignee: 'dev-2', needsPlan: false })
  const rl = w.admit('dev-2', tl, 'exec')
  w.commit(M.prepFailed(w.rt(), rl, { kind: 'request', code: 'spawnFailed' }, 'spawnFailed', w.ctx(), { what: 'cmdLine' }), 'prepFailed spawnFailed with its own words')
  const kl = w.rt().cards.find((c) => c.taskId === tl && c.from.kind === 'system' && c.from.why === 'spawnFailed' && c.state === 'open')
  check(kl && kl.from.vars?.what === 'cmdLine' && w.task(tl).state === 'blocked' && w.task(tl).blocked.reason.cardId === kl.id && json(kl.from.actions).join() === 'retry,dismiss', 'the task blocks on a spawnFailed card with vars.what cmdLine', kl)
  const rf = w.admit('qa-2', undefined, 'free')
  w.commit(M.prepFailed(w.rt(), rf, { kind: 'request', code: 'spawnFailed' }, 'spawnFailed', w.ctx(), { what: 'cmdLine' }), 'a task-less prepFailed with its own words')
  const kf = w.rt().cards.find((c) => !c.taskId && c.from.kind === 'system' && c.from.why === 'spawnFailed' && c.from.runId === rf)
  check(kf && kf.from.vars?.what === 'cmdLine' && json(kf.from.actions).join() === 'dismiss', 'a task-less run: its card carries them too', kf)
  check(!w.rt().cards.some((c) => c.from.kind === 'system' && c.from.why === 'spawnFailed' && c.from.vars?.what === 'cmdLine' && c.id !== kl.id && c.id !== kf.id), 'no other card took those words')

  // A card that blocks the task (noProgress): retry resumes, toTodo, cancelTask.
  const blockWith = (taskId) => {
    const run = w.go('dev', taskId, 'exec')
    const policy = { block: { reason: { kind: 'card', cardId: '', why: 'noProgress' }, card: { why: 'noProgress', actions: ['retry', 'toTodo', 'cancelTask'] } }, counters: { noProgress: 3 } }
    const end = { at: w.clock.now, exit: { code: 0, signal: null }, facts: baseFacts(), teamWrites: 0 }
    w.commit(M.finishRun(w.rt(), run, end, policy, { now: w.clock.now }), 'a run that blocks its task')
    return w.task(taskId).blocked.reason.cardId
  }
  const t2 = w.create('Bloqueada', { assignee: 'dev', needsPlan: false })
  let k = blockWith(t2)
  w.commit(w.answer(user, k, { action: 'retry' }), 'retry a noProgress card')
  t = w.task(t2)
  check(t.state === 'doing' && t.phase === 'executing' && t.next.reason === 'retry' && t.counters.noProgress === 0, 'retry: resumed, a retry wake, the no-progress count back to 0')
  k = blockWith(t2)
  w.commit(w.answer(user, k, { action: 'toTodo' }), 'toTodo')
  t = w.task(t2)
  check(t.state === 'todo' && t.phase === 'none' && t.userOwned.includes('state') && w.card(k).state === 'answered', 'toTodo: back to todo, the state the user\'s')
  k = blockWith(t2)
  // An agent card of the task stays open until the task ends.
  w.commit(M.openSystemCard(w.rt(), { why: 'stalled', actions: ['keepWaiting'], taskId: t2 }, w.ctx()), 'another card of t2')
  w.commit(w.answer(user, k, { action: 'cancelTask' }), 'cancelTask')
  check(w.task(t2).state === 'cancelled' && !w.rt().cards.some((c) => c.taskId === t2 && c.state === 'open') && w.card(k).state === 'answered', 'cancelTask: cancelled, and every other open card of it dismissed')

  // depCancelled: dropBlocker.
  const b1 = w.create('Blocker done')
  const b2 = w.create('Blocker cancelled')
  w.commit(M.moveTask(w.rt(), user, b1, 'done', w.task(b1).rev, {}, w.ctx()), 'b1 done')
  w.commit(M.moveTask(w.rt(), user, b2, 'cancelled', w.task(b2).rev, {}, w.ctx()), 'b2 cancelled')
  const t3 = w.create('Depende', { blockedBy: [b1, b2] })
  const dep = w.rt().cards.find((c) => c.taskId === t3 && c.from.kind === 'system' && c.from.why === 'depCancelled')
  w.commit(w.answer(user, dep.id, { action: 'dropBlocker' }), 'dropBlocker')
  t = w.task(t3)
  check(json(t.blockedBy).join() === b1 && t.state === 'todo' && !t.blocked, 'dropBlocker: the cancelled blocker goes; the done one lets it run')

  // auth pause: resumeTeam is desktop only (decision 50).
  const t4 = w.create('Auth', { assignee: 'dev', needsPlan: false })
  const ar = w.go('dev', t4, 'exec')
  const endA = { at: w.clock.now, exit: { code: 1, signal: null }, facts: baseFacts({ isError: true, failure: { kind: 'auth' } }), teamWrites: 0 }
  const termA = M.terminalOf(w.run(ar), endA)
  w.commit(M.finishRun(w.rt(), ar, endA, M.afterRunPolicy(M.runEndFactsOf(w.rt(), termA, w.clock.now)), { now: w.clock.now }), 'an auth failure')
  const auth = w.rt().cards.find((c) => c.from.kind === 'system' && c.from.why === 'auth' && c.state === 'open')
  check(w.rt().paused && w.rt().paused.reason === 'auth' && w.needs().some((n) => n.id === 'paused'), 'the team pauses (auth) and the pause counts')
  same(w.answer(phone, auth.id, { action: 'resumeTeam' }).error, 'forbidden', 'resumeTeam from the phone: forbidden (decision 50)')
  w.commit(w.answer(user, auth.id, { action: 'resumeTeam' }), 'resumeTeam')
  check(w.rt().paused === null && w.card(auth.id).state === 'answered' && !w.needs().some((n) => n.id === 'paused'), 'resumeTeam: the pause is lifted')
  // Item 5 (B5 integration): Reanudar through the settings op lifts a billing pause and dismisses its card, like resumeTeam.
  const ar2 = w.go('dev', t4, 'exec', { reason: 'retry' })
  const endB = { at: w.clock.now, exit: { code: 1, signal: null }, facts: baseFacts({ isError: true, failure: { kind: 'billing' } }), teamWrites: 0 }
  w.commit(M.finishRun(w.rt(), ar2, endB, M.afterRunPolicy(M.runEndFactsOf(w.rt(), M.terminalOf(w.run(ar2), endB), w.clock.now)), { now: w.clock.now }), 'a billing failure')
  const bill = w.rt().cards.find((c) => c.from.kind === 'system' && c.from.why === 'billing' && c.state === 'open')
  check(w.rt().paused?.reason === 'billing' && !!bill, 'the team pauses (billing) with its card')
  w.commit(M.setTeamFlags(w.rt(), { paused: false }, w.ctx()), 'settings {paused: false}')
  check(w.rt().paused === null && w.card(bill.id).state === 'dismissed' && !w.needs().some((n) => n.id === bill.id || n.id === 'paused'), 'the pause and its billing card both leave Te necesita')
  w.commit(M.setTeamFlags(w.rt(), { paused: true }, w.ctx()), 'a user pause')
  const keepCard = M.openSystemCard(w.rt(), { why: 'auth', actions: ['resumeTeam', 'dismiss'], vars: { what: 'other' } }, w.ctx())
  w.commit(keepCard, 'an auth card while the user paused')
  w.commit(M.setTeamFlags(w.rt(), { paused: false }, w.ctx()), 'lifting a user pause')
  check(w.rt().paused === null && w.card(keepCard.result.cardId).state === 'open', 'lifting a user pause leaves the auth cards alone')
  w.commit(w.answer(user, keepCard.result.cardId, { action: 'dismiss' }), 'dismiss it')

  // stopRun, keepWaiting, newSession, killOrphan.
  const t5 = w.create('Stalled', { assignee: 'dev-2', needsPlan: false })
  const sr = w.go('dev-2', t5, 'exec')
  const stalled = M.openSystemCard(w.rt(), { why: 'stalled', actions: ['stopRun', 'keepWaiting'], taskId: t5, runId: sr }, w.ctx())
  w.commit(stalled, 'a stalled card')
  w.commit(w.answer(user, stalled.result.cardId, { action: 'stopRun' }), 'stopRun')
  check(w.run(sr).state === 'stopping' && w.run(sr).stopReason === 'user', 'stopRun: the card\'s run stops (reason user)')
  w.finish(sr)
  const sess = Object.values(w.agent('dev-2').sessions)[0]
  const ns = M.openSystemCard(w.rt(), { why: 'sessionConflict', actions: ['newSession', 'dismiss'], taskId: t5, vars: { what: `session:${sess.sessionId}`, agentId: 'dev-2' } }, w.ctx())
  w.commit(ns, 'a session card')
  w.commit(w.answer(user, ns.result.cardId, { action: 'newSession' }), 'newSession')
  check(!Object.values(w.agent('dev-2').sessions).some((s) => s.sessionId === sess.sessionId), 'newSession: that session is dropped (the next run starts fresh)')
  const orphan = M.openSystemCard(w.rt(), { why: 'orphan', actions: ['killOrphan', 'dismiss'], vars: { what: 'r-00000000ffff' } }, w.ctx())
  w.commit(orphan, 'an orphan card')
  same(w.answer(user, orphan.result.cardId, { action: 'killOrphan' }).error, 'bad_request', 'killOrphan is TeamService\'s (a process kill), never this reducer')
  same(w.answer(phone, orphan.result.cardId, { action: 'killOrphan' }).error, 'forbidden', 'and desktop only')
}

// ---- 7. permission asks ------------------------------------------------------------------------------
/** The claude-denied fixture rewritten as a PowerShell denial of `command` (a claude-denied-style fixture, B5). */
function deniedFacts(tool, input) {
  const p = M.createClaudeStreamParser()
  const lines = fs.readFileSync(path.join(fixtures, 'claude-denied.jsonl'), 'utf8').split('\n').filter(Boolean)
  lines.forEach((l, i) => {
    const r = JSON.parse(l)
    if (r.type === 'system' && r.subtype === 'permission_denied') r.tool_name = tool
    if (r.type === 'result') r.permission_denials = r.permission_denials.map((d) => ({ ...d, tool_name: tool, tool_input: input }))
    p.line(JSON.stringify(r), 1000 + i)
  })
  return p.facts({ code: 0 }, '', {}, 5000)
}
function permissionChecks() {
  const w = world()
  const ask = (runId, denials, o = { protect: PROTECT }) => M.permissionAsk(w.rt(), w.run(runId), denials, w.ctx(), o)
  const t1 = w.create('Build', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const run1 = w.go('ops', t1, 'exec')
  const ps = deniedFacts('PowerShell', { command: 'npm test -- --watch' })
  same(json(ps.denials.map((d) => [d.tool, d.input.command])), [['PowerShell', 'npm test -- --watch']], 'the PowerShell-style fixture: one PowerShell denial with its command')
  let r = ask(run1, ps.denials)
  w.commit(r, 'permissionAsk of a PowerShell denial')
  const p1 = r.result.approvalId
  same(json(w.approval(p1).payload.tools), ['Bash(npm test:*)'], 'a PowerShell denial asks only for its Bash rule (never PowerShell(npm test:*), E10 SPIKE B5)')
  check(w.approval(p1).decider === 'user' && w.approval(p1).payload.roleId === 'ops' && w.approval(p1).payload.runId === run1 && w.approval(p1).createdBy.agentId === 'ops', 'one pending permission approval of the task and the role')
  // Merge: the same denial again changes nothing; another one joins the same approval.
  check(ask(run1, ps.denials).rt === w.rt(), 'the same denial again: the same approval, unchanged (its rev too)')
  check(w.approval(p1).rev === undefined && M.approvalView(w.rt(), w.approval(p1), w.def).rev === 1, 'a new permission approval: no rev stored, its view reads rev 1')
  r = ask(run1, [{ tool: 'Bash', input: { command: 'npx cowsay hi' } }, { tool: 'Write', input: { file_path: 'C:\\repo\\src\\a.ts' } }])
  w.commit(r, 'merge')
  same([r.result.approvalId, json(w.approval(p1).payload.tools)], [p1, ['Bash(npm test:*)', 'Bash(npx cowsay hi)', 'Write']], 'a second denial merges into the same approval (deduped, in order)')
  // Security (B5 integration, second and third rounds): a command off GRANT_PREFIX_ALLOWLIST (here npx with a package
  // that is not one of its rows) offers its exact command rule, the full command the user approves, never a prefix.
  check(!json(w.approval(p1).payload.tools).includes('Bash(npx cowsay:*)'), 'the npx denial never asks for Bash(npx cowsay:*)')
  // What the profile keeps denying asks nothing.
  const none = (label, runId, denials, o) => check(ask(runId, denials, o).result.approvalId === null, label)
  none('a protect rule: Write of runtime.json', run1, [{ tool: 'Write', input: { file_path: 'c:/users/u/appdata/roaming/snagentsos/runtime.json' } }])
  none('a protect rule: Edit under teams/**', run1, [{ tool: 'Edit', input: { file_path: 'C:\\Users\\u\\AppData\\Roaming\\snagentsos\\teams\\tm-0123456789ab\\state.json' } }])
  none('a protect rule: Read of runtime.json (the custom role has no Read)', run1, [{ tool: 'Read', input: { file_path: 'C:\\Users\\u\\AppData\\Roaming\\snagentsos\\runtime.json' } }])
  // B5 integration, seventh round: the protect paths are the ones every Claude line denies (TeamService.protectPaths over
  // DATA_SECRET_PATHS, one list; the fallback of file names that stood in for them is gone): a Read of each secret of
  // the data folder asks nothing, and a file of the same name elsewhere is no protect rule's, so it asks.
  for (const p of M.DATA_SECRET_PATHS) none(`a protect rule: Read of ${p} in the data folder`, run1, [{ tool: 'Read', input: { file_path: path.win32.join(DATA, p.endsWith('/') ? `${p}saved.json` : p) } }])
  const named = ask(run1, [{ tool: 'Read', input: { file_path: 'C:\\repo\\config.json' } }, { tool: 'Edit', input: { file_path: 'D:\\data\\trusted-teams.json' } }])
  check(named.ok && named.result.approvalId === p1 && json(named.rt.approvals.find((a) => a.id === p1).payload.tools).includes('Read') && json(named.rt.approvals.find((a) => a.id === p1).payload.tools).includes('Edit'), 'a secret\'s file name outside the data folder asks (protect rules by their paths only)', named.ok && named.rt.approvals.find((a) => a.id === p1).payload.tools)
  none('a PowerShell snaos team call (the run has Bash(snaos team:*): a hint, not an approval)', run1, [{ tool: 'PowerShell', input: { command: 'snaos team comment t-1 x&calc' } }])
  check(M.isTeamCallDenial({ tool: 'PowerShell', input: { command: 'snaos.cmd team show --json' } }) && M.isTeamCallDenial({ tool: 'Bash', input: { command: 'C:/bin/snaos.cmd team show' } }) && !M.isTeamCallDenial({ tool: 'PowerShell', input: { command: 'npm test' } }), 'isTeamCallDenial: snaos team through PowerShell or the .cmd name')
  check(typeof M.TEAM_CALL_HINT === 'string' && /Bash tool/.test(M.TEAM_CALL_HINT) && !/[\u2013\u2014]/.test(M.TEAM_CALL_HINT), 'the hint for it names the Bash tool')
  none('mcp__x, Task and Agent never become an approval', run1, [{ tool: 'mcp__github__create_issue' }, { tool: 'Task' }, { tool: 'Agent' }])
  none('a git push denial', run1, [{ tool: 'Bash', input: { command: 'git push origin main' } }])
  none('a rule the role already allows (Grep)', run1, [{ tool: 'Grep', input: { path: 'C:\\repo' } }])
  // Security decision 2 (B5 integration): a shell or interpreter escape is never an approval.
  none('a shell or inline-code escape (bash -c, cmd /c, node -e, env, xargs) makes no approval', run1, [
    { tool: 'Bash', input: { command: 'bash -c "npm test"' } }, { tool: 'PowerShell', input: { command: 'cmd /c npm test' } },
    { tool: 'Bash', input: { command: 'node -e "require(1)"' } }, { tool: 'Bash', input: { command: 'env CI=1 make' } }, { tool: 'Bash', input: { command: 'ls src && xargs rm' } },
  ])
  check(M.isEscapeDenial({ tool: 'PowerShell', input: { command: 'python -c 1' } }) && !M.isEscapeDenial({ tool: 'Bash', input: { command: 'npm test' } }) && !M.isEscapeDenial({ tool: 'Write', input: { file_path: 'bash' } }), 'isEscapeDenial: a shell tool denial of an escape only')
  // Item 4: the approval carries the denied command lines (redacted, cut, at most 10, merged like the rules).
  same(json(w.approval(p1).payload.denied), ['npm test -- --watch', 'npx cowsay hi'], 'the approval keeps the denied commands that ask for its rules (the Write denial has none)')
  w.finish(run1)
  const tl = w.create('Launchers', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const rl = w.go('ops', tl, 'exec')
  r = ask(rl, ['pnpm dlx create-vite app', 'npm exec -- vitest run', 'find . -name x', 'sed -n 1p a.txt', 'npm start', 'go env GOPATH', 'go run .', 'npx tsc --noEmit', 'make all -j4', 'node scripts/gen.js --out x'].map((command) => ({ tool: 'Bash', input: { command } })))
  w.commit(r, 'a permission ask of launcher denials')
  const pl = r.result.approvalId
  same(json(w.approval(pl).payload.tools), ['Bash(pnpm dlx create-vite app)', 'Bash(npm exec -- vitest run)', 'Bash(find . -name x)', 'Bash(sed -n 1p a.txt)', 'Bash(npm start)', 'Bash(go env GOPATH)', 'Bash(go run .)', 'Bash(npx tsc:*)', 'Bash(make all:*)', 'Bash(node scripts/gen.js:*)'],
    'the approval offers each command off the allowlist its exact rule (npm start and go env too, third round) and each row of it its prefix (npx tsc, make all, node <script>)')
  same(json(M.approvalView(w.rt(), w.approval(pl), w.def).payload.tools).slice(0, 4), ['Bash(pnpm dlx create-vite app)', 'Bash(npm exec -- vitest run)', 'Bash(find . -name x)', 'Bash(sed -n 1p a.txt)'], 'and its view shows those exact rules')
  none('a launcher command that is not plain words alone asks nothing (no exact rule, never its prefix)', rl, [{ tool: 'Bash', input: { command: 'npx cowsay "hi"' } }, { tool: 'Bash', input: { command: 'find . -exec rm {} +' } }, { tool: 'Bash', input: { command: 'echo $HOME' } }])
  w.finish(rl)
  const tden = w.create('Denied', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const rd = w.go('ops', tden, 'exec')
  r = ask(rd, [{ tool: 'Bash', input: { command: 'npm test -- --watch' } }])
  w.commit(r, 'a denied command')
  const pd = r.result.approvalId
  r = ask(rd, [{ tool: 'Bash', input: { command: 'npm test -- --watch' } }, { tool: 'Bash', input: { command: 'npm run lint -- --token ghp_0123456789abcdefghijABCDEFGHIJ012345' } }])
  w.commit(r, 'a merge with a secret in the command')
  const den = w.approval(pd).payload.denied
  check(r.result.approvalId === pd && den.length === 2 && den[1].startsWith('npm run lint') && !den[1].includes('ghp_0123456789') && json(w.approval(pd).payload.tools).includes('Bash(npm run:*)'), 'merged once each, the secret redacted', den)
  const long = ask(rd, [{ tool: 'Bash', input: { command: `npm test ${'x'.repeat(400)}` } }, ...Array.from({ length: 12 }, (_, i) => ({ tool: 'Bash', input: { command: `tool${i} go` } }))])
  w.commit(long, 'a long command and many more')
  const den2 = w.approval(pd).payload.denied
  check(den2.length === M.DENIED_COMMANDS_MAX && den2[2].length === M.DENIED_COMMAND_MAX && den2[2].endsWith('…'), 'each cut to 300 characters, at most 10 kept', den2.map((d) => d.length))
  const view = (id) => M.approvalView(w.rt(), w.approval(id), w.def)
  same(json(view(pd).payload.denied), json(den2), 'approvalView sends them (ApprovalPayloadView.denied)')
  check(json(M.needsInputOf(w.rt(), 'trusted', undefined, w.def).approvals.find((a) => a.id === pd).payload.denied).length === M.DENIED_COMMANDS_MAX, 'the light view of the count carries them too (cheap)')
  w.finish(rd)
  const tw = w.create('Solo Write', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const wr = w.go('ops', tw, 'exec')
  r = ask(wr, [{ tool: 'Write', input: { file_path: 'C:\\repo\\only.ts' } }])
  w.commit(r, 'a Write-only ask')
  check(w.approval(r.result.approvalId).payload.denied === undefined && view(r.result.approvalId).payload.denied === undefined, 'no shell command denied: the field is absent (store and view)')
  w.finish(wr)
  // The run end: an escape denial sets the agent's escapeHint (its next prompt says it needs the user), no approval.
  const te = w.create('Escape', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const re = w.go('ops', te, 'exec')
  const beforeApprovals = w.rt().approvals.length
  w.finish(re, { facts: { denials: [{ tool: 'Bash', input: { command: 'bash -c "make all"' } }] } })
  check(w.agent('ops').escapeHint === true && w.rt().approvals.length === beforeApprovals, 'an escape denial: the agent keeps escapeHint, no approval')
  const re2 = w.admit('ops', te, 'exec', { reason: 'retry' })
  w.commit(M.markStarting(w.rt(), re2, { pid: 1, delivered: NO_DELIVERY, escapeHint: true }, w.ctx()), 'the next run delivers the hint')
  check(!w.agent('ops').escapeHint, 'and consumes it')
  w.commit(M.markRunning(w.rt(), re2, { at: w.clock.now, sysHash: 'h' }, w.ctx()), 'running')
  w.finish(re2)
  // A readonly plan run: the edit tools stay denied by its profile; an allowed read was denied by a deny rule.
  const t2 = w.create('Plan', { assignee: 'dev' })
  const pr = w.go('dev', t2, 'plan')
  none('Edit and Write in a readonly plan run', pr, [{ tool: 'Edit', input: { file_path: 'C:\\repo\\a.ts' } }, { tool: 'Write', input: { file_path: 'C:\\repo\\b.ts' } }, { tool: 'NotebookEdit', input: { notebook_path: 'C:\\repo\\n.ipynb' } }])
  none('Read is already allowed in readonly (a deny rule denied it)', pr, [{ tool: 'Read', input: { file_path: 'C:\\repo\\x' } }])
  r = ask(pr, [{ tool: 'Bash', input: { command: 'npm run lint' } }])
  check(r.ok && r.result.approvalId && r.rt.approvals.find((a) => a.id === r.result.approvalId).payload.tools.join() === 'Bash(npm run:*)', 'a shell denial in a readonly run asks for its Bash rule')
  // A total run, a Codex run, a run with no task, a task that is over.
  const t3 = w.create('Total', { assignee: 'dev-2', needsPlan: false })
  const tr = w.go('dev-2', t3, 'exec')
  none('a total run asks nothing (bypassPermissions: only its deny rules deny)', tr, ps.denials)
  w.finish(tr)
  const fr = w.go('qa', undefined, 'free')
  none('a run with no task asks nothing (grants are per task)', fr, ps.denials)
  w.finish(fr)
  const cw = world({ files: filesOf(codexEdit) })
  const ct = cw.create('Codex', { assignee: 'research', needsPlan: false })
  const cr = cw.go('research', ct, 'exec')
  check(M.permissionAsk(cw.rt(), cw.run(cr), ps.denials, cw.ctx(), { protect: PROTECT }).result.approvalId === null, 'a Codex run asks nothing (no allow list, 5.4)')

  // B close (finding 15): a permission decide is bound to the rev the user saw. p1 grew once (the merge above): rev 2.
  check(w.approval(p1).rev === 2 && M.approvalView(w.rt(), w.approval(p1), w.def).rev === 2, 'the merge that grew p1 moved its rev to 2, and its view carries it')
  check(M.approvalView(w.rt(), w.approval(pl), w.def).rev === 1, 'a permission approval nothing grew: rev 1 (absent reads as 1)')
  same([w.decide(user, p1, 'approve', undefined, {}).reason, w.decide(user, p1, 'approve', undefined, { rev: 1 }).reason, w.decide(user, p1, 'reject', undefined, { rev: 3 }).reason], ['stale', 'stale', 'stale'], 'a decide without the rev, with the one before the merge or another one: conflict stale, approve or reject')
  check(w.approval(p1).state === 'pending' && !w.task(t1).grants, 'and nothing changed')
  // The grant: Bash only, and the run it wakes is told to use Bash; its argv carries the rule.
  w.tick()
  w.commit(w.decide(user, p1, 'approve', undefined, { rev: 2 }), 'approve the permission at its rev')
  const t = w.task(t1)
  same(json(t.grants.map((g) => [g.roleId, g.tool, g.approvalId])), [['ops', 'Bash(npm test:*)', p1], ['ops', 'Bash(npx cowsay hi)', p1], ['ops', 'Write', p1]], 'task.grants of the role gain the approved rules')
  check(t.next.agentId === 'ops' && t.next.mode === 'exec' && t.next.reason === 'grant' && t.next.bypassCooldown === true && t.next.refs[0] === p1, 'a grant wake for the agent of the phase (the denied run did not conclude)')
  // Item 7 (B5 integration): the hint is main's system text, never the user's request text of the wake mark.
  check(t.next.detail === undefined, 'the grant wake carries no detail (that is the user request text only)', t.next)
  const rerun = w.admit('ops', t1, 'exec', { reason: 'grant', refs: t.next.refs })
  const run = w.run(rerun)
  same(json(run.trigger.refs), [p1], 'the re-run names the approval in its trigger refs')
  const hint = M.grantHint(M.grantedByRefs(w.rt(), run))
  check(/Bash tool/.test(hint) && hint.includes('Bash(npm test:*)') && hint.includes('Bash(npx cowsay hi)') && !hint.includes('Write') && !/PowerShell\(/.test(hint), 'its system hint (grantedByRefs): run the granted Bash rules with the Bash tool', hint)
  check(M.grantedByRefs(w.rt(), { ...run, trigger: { ...run.trigger, refs: [] } }).length === 0 && M.grantedByRefs(w.rt(), { ...run, roleId: 'dev' }).length === 0, 'no refs or another role: no grant hint')
  const role = w.def.def.roles.find((x) => x.id === 'ops')
  const grants = w.task(t1).grants.filter((g) => g.roleId === run.roleId).map((g) => g.tool)
  const argv = M.teamArgv({ provider: 'claude', profile: run.profile, allowedTools: role.allowedTools, grants, session: { kind: 'new', sessionId: run.sessionId }, cwd: run.cwd }).argv
  const allow = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'))
  check(allow.includes('Bash(npm test:*)') && allow.includes('Write') && !allow.some((a) => a.startsWith('PowerShell(')), 'the re-run is allowed Bash(npm test:*): the same call through Bash is not denied again', allow)
  w.start(rerun)
  check(ask(rerun, [{ tool: 'Bash', input: { command: 'npm test -- --watch' } }]).result.approvalId === null, 'and the same denial again (a deny rule elsewhere) asks nothing: the rule is granted already')
  w.finish(rerun)
  // Reject, and the grant cap.
  const t4 = w.create('Cap', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const r4 = w.go('ops', t4, 'exec')
  const many = Array.from({ length: 40 }, (_, i) => ({ tool: 'Bash', input: { command: `tool${i} run` } }))
  r = ask(r4, many)
  w.commit(r, 'forty denials')
  check(w.approval(r.result.approvalId).payload.tools.length === M.GRANTS_MAX, 'at most GRANTS_MAX rules in one approval')
  w.commit(w.decide(user, r.result.approvalId, 'reject'), 'reject a permission (no note needed)')
  check(w.approval(r.result.approvalId).state === 'rejected' && !w.task(t4).grants, 'rejected: no grant')
  w.finish(r4)
  // B close (finding 8): GRANTS_MAX counts every role's grants of the task. An ask offers only the rules that still fit
  // (with their denied commands), a merge with no room adds nothing, and an approve none of whose rules lands answers
  // bad_request {detail: grantsFull}, wakes nobody and leaves the approval pending.
  const t9 = w.create('Full', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const r9 = w.go('ops', t9, 'exec')
  const oldGrants = (n) => Array.from({ length: n }, (_, i) => ({ roleId: i % 2 ? 'qa' : 'ops', tool: `Bash(old${i} go)`, at: w.clock.now, approvalId: 'a-1' }))
  const setGrants = (grants, label) => w.commit({ ok: true, rt: { ...w.rt(), tasks: w.rt().tasks.map((x) => (x.id === t9 ? { ...x, grants } : x)) }, effects: [], result: undefined }, label)
  setGrants(oldGrants(M.GRANTS_MAX - 2), 'the task holds GRANTS_MAX - 2 grants of two roles')
  r = ask(r9, Array.from({ length: 5 }, (_, i) => ({ tool: 'Bash', input: { command: `new${i} go` } })))
  w.commit(r, 'five denials with room for two')
  const p9 = r.result.approvalId
  same(json([w.approval(p9).payload.tools, w.approval(p9).payload.denied]), [['Bash(new0 go)', 'Bash(new1 go)'], ['new0 go', 'new1 go']], 'the ask offers only as many rules as the task has room for, and only their denied commands')
  check(ask(r9, [{ tool: 'Bash', input: { command: 'new9 go' } }]).rt === w.rt(), 'no room left: a later denial merges nothing')
  setGrants(oldGrants(M.GRANTS_MAX), 'another approval filled the task cap meanwhile')
  const before9 = JSON.stringify(w.task(t9))
  const full = w.decide(user, p9, 'approve')
  same(json(full), { ok: false, error: 'bad_request', detail: 'grantsFull' }, 'an approve none of whose rules fits: bad_request, detail grantsFull')
  check(w.approval(p9).state === 'pending' && JSON.stringify(w.task(t9)) === before9 && !w.task(t9).next, 'still pending, the task as it was: no grant wake (the woken run would be denied again)')
  setGrants(oldGrants(M.GRANTS_MAX - 1), 'room for one again')
  w.commit(w.decide(user, p9, 'approve'), 'an approve with room for one rule')
  check(w.task(t9).grants.length === M.GRANTS_MAX && w.task(t9).grants.at(-1).tool === 'Bash(new0 go)' && w.task(t9).next?.reason === 'grant', 'the rule that fits lands and the grant wake is set')
  w.finish(r9)
  // A permission approval whose run ended waiting on the user does not wake it (the answer does).
  const t5 = w.create('Waits', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const r5 = w.go('ops', t5, 'exec')
  w.commit(ask(r5, [{ tool: 'Bash', input: { command: 'make all' } }]), 'a denial')
  w.commit(w.tool(r5, 'team.ask', { text: '¿Sigo?' }), 'then it asks')
  w.finish(r5)
  const p5 = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t5).id
  w.commit(w.decide(user, p5, 'approve'), 'approve it')
  check(w.task(t5).grants.length === 1 && !w.task(t5).next, 'granted, but no grant wake: the open card will wake it')
  same(json(w.task(t5).grants.map((g) => g.tool)), ['Bash(make all:*)'], 'make <target> is a row of the allowlist: its prefix rule')
  // Third round: an approval an older version stored with prefix rules off the allowlist (or a word that is not plain)
  // grants only what isGrantable still accepts.
  const t6 = w.create('Old rules', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const r6 = w.go('ops', t6, 'exec')
  w.commit(ask(r6, [{ tool: 'Bash', input: { command: 'make all' } }]), 'a denial')
  const p6 = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t6).id
  const stored = w.approval(p6)
  const olderTools = ['Bash(npm install:*)', 'Bash(make all:*)', 'Bash(ls src:*)', 'Bash(echo $HOME)', 'Bash(go run .)', 'Bash(git grep:*)']
  w.commit({ ok: true, rt: { ...w.rt(), approvals: w.rt().approvals.map((a) => (a.id === p6 ? { ...stored, payload: { ...stored.payload, tools: olderTools } } : a)) }, effects: [], result: undefined }, 'the approval as an older version stored it')
  w.finish(r6)
  // Fourth round (item 3): the view shows only what isGrantable still accepts, so the user approves what is granted.
  same(json(M.approvalView(w.rt(), w.approval(p6), w.def).payload.tools), ['Bash(make all:*)', 'Bash(go run .)'], 'the view of the stored approval shows only the rules the policy still grants')
  check(json(w.approval(p6).payload.tools).includes('Bash(npm install:*)'), 'the store keeps what it holds (only the view and the grant filter)')
  w.commit(w.decide(user, p6, 'approve'), 'approve the stored rules')
  same(json(w.task(t6).grants.map((g) => g.tool)), ['Bash(make all:*)', 'Bash(go run .)'], 'only an allowlist row and an exact rule of plain words join task.grants (npm install:*, ls src:*, git grep:* and $HOME are refused)')
  // Fourth round: an approval an earlier build stored with only rules the policy now refuses (git log, git diff and git
  // show prefixes, a PowerShell rule) reads as nothing to grant, and its Approve answers bad_request (Reject still works).
  const t7 = w.create('Old git reads', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const r7 = w.go('ops', t7, 'exec')
  w.commit(ask(r7, [{ tool: 'Bash', input: { command: 'make all' } }]), 'a denial')
  const p7 = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t7).id
  const stored7 = w.approval(p7)
  w.commit({ ok: true, rt: { ...w.rt(), approvals: w.rt().approvals.map((a) => (a.id === p7 ? { ...stored7, payload: { ...stored7.payload, tools: ['Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git branch --list:*)', 'PowerShell(npm test:*)'] } } : a)) }, effects: [], result: undefined }, 'stored by an earlier build')
  w.finish(r7)
  same(json(M.approvalView(w.rt(), w.approval(p7), w.def).payload.tools), [], 'its view: no rule (the renderer reads "nothing to grant")')
  const before7 = JSON.stringify(w.task(t7))
  const refusedApprove = w.decide(user, p7, 'approve')
  check(refusedApprove.ok === false && refusedApprove.error === 'bad_request' && w.approval(p7).state === 'pending' && JSON.stringify(w.task(t7)) === before7 && !w.task(t7).grants, 'Approve of nothing to grant: bad_request, still pending, the task as it was (no grant, no grant wake)', refusedApprove)
  w.commit(w.decide(user, p7, 'reject'), 'reject it')
  check(w.approval(p7).state === 'rejected', 'Reject still closes it')
  // grantedByRefs: a grant an earlier build stored that the policy now refuses never reaches the hint (nor argv).
  const t8 = w.create('Old grant', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const r8 = w.go('ops', t8, 'exec')
  w.commit(ask(r8, [{ tool: 'Bash', input: { command: 'make all' } }]), 'a denial')
  w.finish(r8)
  const p8 = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === t8).id
  w.commit(w.decide(user, p8, 'approve'), 'approve make all')
  const s8 = w.approval(p8)
  const task8 = w.task(t8)
  w.commit({ ok: true, rt: { ...w.rt(), approvals: w.rt().approvals.map((a) => (a.id === p8 ? { ...s8, payload: { ...s8.payload, tools: [...s8.payload.tools, 'Bash(git log:*)'] } } : a)), tasks: w.rt().tasks.map((x) => (x.id === t8 ? { ...task8, grants: [...task8.grants, { roleId: 'ops', tool: 'Bash(git log:*)', at: w.clock.now, approvalId: p8 }] } : x)) }, effects: [], result: undefined }, 'an older grant of git log')
  const hint8 = M.grantHint(M.grantedByRefs(w.rt(), { taskId: t8, roleId: 'ops', trigger: { reason: 'grant', refs: [p8] } }))
  check(hint8.includes('Bash(make all:*)') && !hint8.includes('git log'), 'the grant hint names only what the run gets', hint8)
  same(json(M.taskDetail(w.rt(), w.task(t8), { def: w.def.def, needs: [], trusted: w.def, recent: [] }).grants), ['Bash(make all:*)'], 'nor the task view (team task get): no grant the run does not get')

  // B5 review (findings 2 and 4): an exact rule is the whole command, so one that holds a credential or a live token of
  // the app (whole, or split in two words, which only the live-token mask sees) is never offered: it would enter
  // state.json, the needs view, task.grants and the argv as is, and masked it is no longer the command that ran.
  const live = M.newToken()
  const tokens = new M.CtlTokens(live)
  const mask = (text) => tokens.maskTokens(text)
  const sk = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
  const half = [live.slice(0, 32), live.slice(32)]
  const asBash = (command) => ({ tool: 'Bash', input: { command } })
  const secretCmds = [`curl -u me:${sk} https://api.example.com/health`, `curl -d ${live} https://x.example/h`, `echo ${half[0]} ${half[1]}`]
  same(secretCmds.map((c) => M.grantPatternOf(asBash(c))), secretCmds.map((c) => [`Bash(${c})`]), 'control: each is a plain-word command whose exact rule grantPatternOf offers')
  const ts = w.create('Secretos', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const rs = w.go('ops', ts, 'exec')
  const masked = { protect: PROTECT, mask }
  none('a denied command holding an sk- key, a whole live token or one split in two words opens no approval', rs, secretCmds.map(asBash), masked)
  check(ask(rs, [asBash(secretCmds[2])]).result.approvalId !== null, 'control: the split token passes redactCredentials alone (the run end\'s mask is what drops it)')
  w.commit(ask(rs, [asBash('make all')], masked), 'a plain denial opens the approval')
  const psId = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === ts && a.state === 'pending').id
  w.commit(ask(rs, [...secretCmds.map(asBash), asBash(`npm run lint -- ${half[0]} ${half[1]}`), asBash(`npm test -- --token ${live}`)], masked), 'a merge with the secret commands and two prefix rules')
  same(json(w.approval(psId).payload.tools), ['Bash(make all:*)', 'Bash(npm run:*)', 'Bash(npm test:*)'], 'only rules no mask changes join it (a prefix rule stands: the secret is past its words)')
  same(json(w.approval(psId).payload.denied), ['make all', '[redacted]', 'npm test -- --token [redacted]'], 'each denied line is masked, then redacted: a token in place masked there, a split one masks the whole line')
  const leaks = (v) => [live, half[0], half[1], sk].filter((s) => JSON.stringify(v ?? null).toLowerCase().includes(s.toLowerCase()))
  same([leaks(w.rt()), leaks(M.approvalView(w.rt(), w.approval(psId), w.def)), leaks(M.needsInputOf(w.rt(), 'trusted', undefined, w.def))], [[], [], []], 'no piece of the token nor the key in the team state, the approval view or the needs input')
  w.finish(rs)
  // The run end hands its mask to the ask (finishRun's RunEndCtx.mask, the one TeamService gives the summary).
  const tf = w.create('Fin con secreto', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const rf = w.go('ops', tf, 'exec')
  const endF = { at: w.clock.now, exit: { code: 0, signal: null }, facts: baseFacts({ denials: [asBash(`echo ${half[0]} ${half[1]}`), asBash(`npm run lint -- ${half[0]} ${half[1]}`)] }), teamWrites: 0 }
  const termF = M.terminalOf(w.run(rf), endF, mask)
  w.commit(M.finishRun(w.rt(), rf, endF, M.afterRunPolicy(M.runEndFactsOf(w.rt(), termF, w.clock.now)), { now: w.clock.now, mask }, { ctx: w.ctx(), protect: PROTECT }), 'the run end with its mask and the trusted definition')
  const pf = w.rt().approvals.find((a) => a.kind === 'permission' && a.taskId === tf && a.state === 'pending')
  same(json(pf ? { tools: pf.payload.tools, denied: pf.payload.denied } : null), { tools: ['Bash(npm run:*)'], denied: ['[redacted]'] }, 'finishRun: the split-token rule never joins, the denied line is masked whole')
  same(leaks(w.rt()), [], 'and the team state holds no piece of the token')
}

// ---- 7b. 2.7.0 runtime fixes: the run that asked for a permission waits on the user's decision ------------------
// Orchestrator decision: a run whose denials leave a permission approval of its task and role pending (opened, grown or
// asked again) leaves its task waiting on that decision (no continuation, no count, no qaNoVerdict or other block);
// approve wakes the phase agent with `grant` and the grant hint, reject with `answer`, the reject hint (go on without
// the command; QA decides by reading the change) and the user's note as their comment; a verdict, done or review of a
// run of that role wins and cancels the pending approval (error notNeeded; a decide that raced it answers stale).
function permissionWaitChecks() {
  const w = world()
  const reads = { digest: { tools: 2, families: { read: 2 }, files: [] }, toolCalls: 2 }
  const bash = (command) => [{ tool: 'Bash', input: { command } }]
  const pendingOf = (taskId, roleId) => w.rt().approvals.filter((a) => a.kind === 'permission' && a.state === 'pending' && a.taskId === taskId && a.payload.roleId === roleId)
  const levelOf = (taskId) => M.candidatesOf(w.rt(), w.def.def, w.def.goalHash, { now: w.clock.now, manual: [] }).find((r) => r.taskId === taskId)
  /** A task the Dev sent to review (no summary, so nothing is queued for the QA): its sticky QA, `qa`, runs it next. */
  const inQa = (title) => {
    const id = w.create(title, { assignee: 'dev', needsPlan: false })
    const ex = w.go('dev', id, 'exec')
    w.commit(w.tool(ex, 'team.review', {}), `review ${title}`)
    w.finish(ex)
    return id
  }

  // QA, approve. A first QA run without a verdict and no denial takes its one continuation (the control); the second is
  // denied `npm test`: the task waits, where the policy alone would block it with qaNoVerdict.
  const t1 = inQa('QA aprueba')
  const q1 = w.go('qa', t1, 'qa', { reason: 'review' })
  check(w.end(q1, { facts: reads }) === false && w.task(t1).next?.reason === 'continuation' && w.task(t1).counters.continuations === 1, 'control: a QA run without a verdict nor a denial takes its continuation')
  const q2 = w.go('qa', t1, 'qa', { reason: 'continuation' })
  check(w.end(q2, { facts: { ...reads, denials: bash('npm test') } }) === true, 'permissionWaitOf: the QA run\'s denial opens a pending permission approval, so the run waits')
  let t = w.task(t1)
  const [a1] = pendingOf(t1, 'qa')
  check(!!a1 && json(a1.payload.tools).join() === 'Bash(npm test:*)' && a1.payload.runId === q2, 'one pending permission approval of the task and the QA role', a1)
  check(t.state === 'review' && t.phase === 'qa' && !t.next && !t.blocked && t.counters.continuations === 1 && !t.cooldownUntil, 'the task waits on the decision: no continuation, no count, no qaNoVerdict block', t)
  check(!w.rt().cards.some((c) => c.taskId === t1 && c.state === 'open') && w.needs().some((n) => n.id === a1.id), 'no card: the approval is what Te necesita shows')
  check(levelOf(t1) === undefined, 'and nothing wakes the QA meanwhile (no level of the task)')
  w.tick()
  w.commit(w.decide(user, a1.id, 'approve'), 'approve the QA permission')
  t = w.task(t1)
  check(t.next?.agentId === 'qa' && t.next.mode === 'qa' && t.next.reason === 'grant' && t.next.bypassCooldown === true && json(t.next.refs).join() === a1.id, 'approve: the grant wakes the QA of review/qa', t.next)
  check(levelOf(t1)?.reason === 'grant' && levelOf(t1).sessionKey === t1, 'its level: the grant on the task\'s session (the same session resumes, TeamService.admitFacts)')
  const q3 = w.admit('qa', t1, 'qa', { reason: 'grant', refs: t.next.refs })
  const gh = M.grantHint(M.grantedByRefs(w.rt(), w.run(q3)))
  check(!!gh && gh.includes('Bash(npm test:*)') && M.rejectHint(w.rt(), w.run(q3)) === undefined, 'the woken run reads the grant hint, no reject hint', gh)
  w.start(q3)
  w.commit(w.tool(q3, 'team.verdict', { verdict: 'approve', text: 'Tests verdes' }), 'the QA gives its verdict with the grant')
  w.end(q3)
  check(w.task(t1).phase === 'userOk' && w.approval(a1.id).state === 'approved', 'the verdict moves it on; the approved permission stays approved')

  // QA, reject with a note: the same QA goes on without the command and decides by reading the change.
  const t2 = inQa('QA rechazado')
  const r1 = w.go('qa', t2, 'qa', { reason: 'review' })
  check(w.end(r1, { facts: { ...reads, denials: bash('npm test') } }) === true, 'a QA run denied npm test waits')
  const [a2] = pendingOf(t2, 'qa')
  const before2 = (w.rt().comments[t2] ?? []).length
  w.tick()
  w.commit(w.decide(user, a2.id, 'reject', 'No corras los tests: leé el diff'), 'reject with a note')
  t = w.task(t2)
  check(w.approval(a2.id).state === 'rejected' && w.approval(a2.id).note === 'No corras los tests: leé el diff' && !t.grants, 'rejected with its note, nothing granted')
  check(t.next?.agentId === 'qa' && t.next.mode === 'qa' && t.next.reason === 'answer' && t.next.bypassCooldown === true && json(t.next.refs).join() === a2.id, 'reject: the same QA is woken with answer and the approval in its refs', t.next)
  const note = w.rt().comments[t2].at(-1)
  check(w.rt().comments[t2].length === before2 + 1 && note.author.kind === 'user' && note.kind === 'comment' && note.text === 'No corras los tests: leé el diff' && note.forAgent === 'qa' && !note.deliveredRunId, 'the note reaches the QA as the user\'s comment, queued for it', note)
  const r2 = w.admit('qa', t2, 'qa', { reason: 'answer', refs: t.next.refs })
  const rh = M.rejectHint(w.rt(), w.run(r2))
  check(!!rh && rh.includes('Bash(npm test:*)') && rh.includes('snaos team diff') && rh.includes('snaos team log') && /verdict/.test(rh) && !/[\u2013\u2014]/.test(rh), 'its reject hint: not allowed, decide by reading the change', rh)
  check(M.grantHint(M.grantedByRefs(w.rt(), w.run(r2))) === undefined, 'and no grant hint')
  check(M.rejectHint(w.rt(), { ...w.run(r2), roleId: 'dev' }) === undefined && M.rejectHint(w.rt(), { ...w.run(r2), trigger: { reason: 'answer', refs: [] } }) === undefined, 'another role or no refs: no reject hint')
  w.start(r2)
  w.commit(w.tool(r2, 'team.verdict', { verdict: 'changes', text: 'Falta un test, lo vi en el diff' }), 'the QA decides by reading')
  w.end(r2)
  check(w.task(t2).phase === 'executing' && w.task(t2).next?.reason === 'changes', 'its verdict moves the task on')

  // A verdict in a run of that role wins: the pending permission is no longer needed.
  const t3 = inQa('QA con veredicto')
  const v1 = w.go('qa', t3, 'qa', { reason: 'review' })
  w.end(v1, { facts: { ...reads, denials: bash('npm test') } })
  const [a3] = pendingOf(t3, 'qa')
  check(!!a3, 'a pending permission of the QA')
  // The user runs the QA by hand; this run is denied again and gives its verdict from reading the change.
  const v2 = w.go('qa', t3, 'qa', { reason: 'manual' })
  w.commit(w.tool(v2, 'team.verdict', { verdict: 'approve', text: 'Leí el cambio' }), 'a verdict in the run that was denied again')
  w.tick()
  check(w.end(v2, { facts: { ...reads, denials: bash('npm test') } }) === false, 'a run that concluded never waits')
  const c3 = w.approval(a3.id)
  check(w.task(t3).phase === 'userOk' && c3.state === 'cancelled' && c3.error === M.PERMISSION_NOT_NEEDED && c3.error === 'notNeeded' && c3.decidedAt === w.clock.now && pendingOf(t3, 'qa').length === 0, 'the verdict wins: the task moves on and the pending permission is cancelled as no longer needed', c3)
  check(!w.needs().some((n) => n.id === a3.id), 'out of Te necesita')
  same(json(w.decide(user, a3.id, 'approve', undefined, { rev: 1 })), { ok: false, error: 'conflict', reason: 'stale' }, 'a decide that raced it: conflict stale')
  const t3b = inQa('QA de una')
  const v3 = w.go('qa', t3b, 'qa', { reason: 'review' })
  w.commit(w.tool(v3, 'team.verdict', { verdict: 'approve', text: 'Ok' }), 'a verdict')
  w.end(v3, { facts: { ...reads, denials: bash('npm test') } })
  check(!w.rt().approvals.some((a) => a.kind === 'permission' && a.taskId === t3b), 'denied and the verdict in one run with nothing pending: no approval at all')

  // A Dev in executing (a custom role, isolation main): the same wait, approve and reject; review and done win.
  const t4 = w.create('Dev con permiso', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const e1 = w.go('ops', t4, 'exec')
  check(w.end(e1, { facts: { denials: bash('make all') } }) === true, 'a Dev exec run denied make all waits')
  t = w.task(t4)
  const [a4] = pendingOf(t4, 'ops')
  check(!!a4 && t.state === 'doing' && t.phase === 'executing' && !t.next && !t.blocked && !t.cooldownUntil && t.counters.noProgress === 0 && t.counters.continuations === 0, 'executing waits on the decision: no no-progress count, no cooldown, no continuation', t)
  check(levelOf(t4) === undefined, 'nothing wakes the Dev meanwhile')
  w.commit(w.decide(user, a4.id, 'approve'), 'approve the Dev permission')
  t = w.task(t4)
  check(t.next?.agentId === 'ops' && t.next.mode === 'exec' && t.next.reason === 'grant' && json(t.next.refs).join() === a4.id && t.grants.some((g) => g.tool === 'Bash(make all:*)' && g.roleId === 'ops'), 'approve: the Dev in executing is woken with grant and the rule')
  const e2 = w.go('ops', t4, 'exec', { reason: 'grant', refs: t.next.refs })
  check(w.end(e2, { facts: { denials: bash('make deploy') } }) === true && pendingOf(t4, 'ops').length === 1, 'the granted run is denied another command: a new pending approval, it waits again')
  const a4b = pendingOf(t4, 'ops')[0]
  const e3 = w.go('ops', t4, 'exec', { reason: 'manual' })
  w.commit(w.tool(e3, 'team.review', {}), 'the Dev sends it to review')
  w.end(e3, { facts: { denials: bash('make deploy') } })
  check(w.task(t4).phase === 'qa' && w.approval(a4b.id).state === 'cancelled' && w.approval(a4b.id).error === 'notNeeded', 'review wins: the task moves on and the pending permission is cancelled')
  const t5 = w.create('Dev rechazado', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const d1 = w.go('ops', t5, 'exec')
  w.end(d1, { facts: { denials: bash('make release') } })
  const [a5] = pendingOf(t5, 'ops')
  w.commit(w.decide(user, a5.id, 'reject'), 'reject without a note')
  t = w.task(t5)
  check(t.next?.reason === 'answer' && t.next.mode === 'exec' && t.next.agentId === 'ops' && json(t.next.refs).join() === a5.id && (w.rt().comments[t5] ?? []).length === 0, 'reject without a note: the Dev is woken with answer, no comment')
  const d2 = w.admit('ops', t5, 'exec', { reason: 'answer', refs: t.next.refs })
  const dh = M.rejectHint(w.rt(), w.run(d2))
  check(!!dh && dh.includes('Bash(make release:*)') && /rest of your work/.test(dh) && !dh.includes('snaos team diff'), 'the Dev reads: go on without it', dh)
  w.start(d2)
  check(w.end(d2, { facts: { denials: bash('make release') } }) === true && pendingOf(t5, 'ops').length === 1, 'denied the same command again: a new pending approval (the rejected one is closed), it waits')
  const a5b = pendingOf(t5, 'ops')[0]
  const d3 = w.go('ops', t5, 'exec', { reason: 'manual' })
  w.commit(w.tool(d3, 'team.done', { text: 'Hecho sin release' }), 'done')
  w.end(d3)
  check(w.task(t5).phase === 'userOk' && w.approval(a5b.id).state === 'cancelled' && w.approval(a5b.id).error === 'notNeeded', 'done wins: the pending permission is cancelled')
  // A run that ends waiting on its own card still waits on the card: the grant does not wake it (the answer does).
  const t6 = w.create('Dev pregunta', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const k1 = w.go('ops', t6, 'exec')
  w.commit(w.tool(k1, 'team.ask', { text: '¿Puedo correr make all?' }), 'it asks')
  check(w.end(k1, { facts: { denials: bash('make all') } }) === false, 'a run that concluded with ask does not wait on the permission')
  const [a6] = pendingOf(t6, 'ops')
  w.commit(w.decide(user, a6.id, 'reject'), 'reject it')
  check(!w.task(t6).next && w.approval(a6.id).state === 'rejected', 'the reject wakes nobody: the open card will')
  // A run the user stopped keeps its own row even when it ended with its result: it never waits (nor does teams.log say
  // so), its task blocks {stopped}, and its denial still opens the approval.
  const t7 = w.create('Dev frenado', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const s1 = w.go('ops', t7, 'exec')
  w.commit(M.requestStop(w.rt(), s1, 'user', w.ctx()), 'the user stops it')
  check(w.end(s1, { facts: { denials: bash('make all') } }) === false, 'a run the user stopped does not wait on its permission')
  check(w.task(t7).blocked?.reason.kind === 'stopped' && pendingOf(t7, 'ops').length === 1, 'its task blocks {stopped} and its denial still opens the approval', w.task(t7))
}

// ---- 8. hire --------------------------------------------------------------------------------------------
function hireChecks() {
  const w = world()
  const roleText = (o = {}) => `---\n${o.id ? `id: ${o.id}\n` : ''}name: ${o.name ?? 'Designer'}\nkind: ${o.kind ?? 'custom'}\nprovider: claude\nmodel: sonnet\npermission: custom\nallowedTools: Read, Grep\n# a comment line\ncount: ${o.count ?? 1}\n---\n\nYou design screens.\r\n`
  const lr = w.go('lead', undefined, 'lead')
  same(w.tool(lr, 'team.hire', { text: 'not a role file' }).error, 'bad_request', 'a text that is not a role file')
  const bad = w.tool(lr, 'team.hire', { text: roleText({ count: 9 }) })
  check(bad.error === 'bad_request' && bad.current.issues.some((i) => i.key === 'count'), 'an invalid role: bad_request with the definition issues')
  same(w.tool(lr, 'team.hire', { text: roleText({ kind: 'lead', name: 'Lead 2' }) }).error, 'forbidden', 'never a second lead')
  same(w.tool(lr, 'team.hire', { text: roleText({ id: 'lead' }) }).error, 'forbidden', 'never the Lead\'s own role')
  const devText = w.files.find((f) => f.rel === 'roles/dev.md').text
  same(w.tool(lr, 'team.hire', { text: devText }).error, 'bad_request', 'a hire that changes nothing')
  same(w.tool(lr, 'team.hire', { text: devText.replace('\n---\n', '\n# only a comment\n---\n') }).error, 'bad_request', 'nor the same role in other words (a comment line): it would only rewrite the file')
  check(M.hireOf(roleText({ name: 'Diseñador UX' }), w.def).roleId === 'disenador-ux', 'the role id from the name: accents dropped, lowercase, dashes')
  w.tick()
  let r = w.tool(lr, 'team.hire', { text: roleText({ id: 'designer', name: 'Diseño' }) })
  w.commit(r, 'team.hire')
  const h1 = w.approval(r.result.approvalId)
  check(r.result.concluded === 'hire' && h1.kind === 'hire' && h1.state === 'pending' && h1.decider === 'user' && !h1.taskId, 'team hire: a pending hire approval, no task')
  check(h1.payload.roleId === 'designer' && h1.payload.replaces === false && h1.payload.baseDefHash === w.def.sha256 && !h1.payload.text.includes('id:') && !h1.payload.text.includes('# a comment') && !h1.payload.text.includes('\r'), 'an `id:` line names the role (and is not written); the file is serializeRole of the parsed role')
  check(h1.payload.sha256 === sha(h1.payload.text), 'payload.sha256 = the sha256 of the exact bytes written (Node equal)')
  const again = M.hireCheck(h1.payload.roleId, h1.payload.text, w.def)
  check(again.ok && again.text === h1.payload.text && again.files.some((f) => f.rel === 'roles/designer.md' && f.text === h1.payload.text) && again.files.length === w.files.length + 1, 'hireCheck (the apply\'s re-check) passes on the payload and gives the folder to write and trust')
  check(!M.hireCheck('lead', h1.payload.text, w.def).ok && !M.hireCheck('Bad Id', h1.payload.text, w.def).ok, 'hireCheck refuses the Lead\'s id and an id off ROLE_ID_RE')
  check(w.needs().some((n) => n.id === h1.id && n.approvalKind === 'hire'), 'the hire is in Te necesita')
  w.finish(lr)
  // B5 review (finding 3): a second Lead run proposes another hire on the same trusted base.
  const lrS = w.go('lead', undefined, 'lead')
  r = w.tool(lrS, 'team.hire', { text: roleText({ id: 'writer', name: 'Writer' }) })
  w.commit(r, 'a second hire on the same base')
  const hsId = r.result.approvalId
  check(w.approval(hsId).payload.baseDefHash === w.def.sha256 && w.approval(hsId).state === 'pending', 'pending on the base of the first')
  w.finish(lrS)
  same(w.decide(phone, h1.id, 'approve').error, 'forbidden', 'a hire decided from the phone: forbidden (decision 50)')
  same(w.decide(phone, h1.id, 'reject').error, 'forbidden', 'also a reject')
  // A stale base: the definition was trusted again since.
  same(M.decideApproval(w.rt(), user, h1.id, 'approve', undefined, { ...w.ctx(), def: { ...w.def, sha256: 'f'.repeat(64) } }).reason, 'stale', 'approving a hire built on another trusted definition: conflict {stale}')
  w.tick()
  r = w.decide(user, h1.id, 'approve')
  w.commit(r, 'approve the hire')
  check(w.approval(h1.id).state === 'applying' && r.effects.some((e) => e.kind === 'applyHire' && e.approvalId === h1.id), 'applying, with the applyHire effect')
  check(w.needs().some((n) => n.id === h1.id), 'applying still counts (it is not done)')
  same(w.decide(user, h1.id, 'approve').reason, 'already_decided', 'a double decide while applying: already_decided')
  // TeamService could not write it: back to pending with the error.
  w.commit(M.completeApproval(w.rt(), h1.id, { ok: false, error: 'untrusted' }, w.ctx()), 'the apply failed')
  check(w.approval(h1.id).state === 'pending' && w.approval(h1.id).error === 'untrusted' && !w.approval(h1.id).decidedBy, 'a failed apply: pending again with its error')
  check(w.approval(hsId).state === 'pending', 'a failed apply trusts nothing new: the other hire stays pending')
  w.commit(w.decide(user, h1.id, 'approve'), 'approve again')
  // It wrote and trusted the folder: approved, and the roster follows the new definition.
  const newFiles = [...w.files.filter((f) => f.rel !== 'roles/designer.md'), { rel: 'roles/designer.md', text: h1.payload.text }]
  const def2 = trustedOf(newFiles)
  w.tick()
  w.commit(M.completeApproval(w.rt(), h1.id, { ok: true }, w.ctx(def2)), 'the apply landed')
  check(w.approval(h1.id).state === 'approved' && !!w.agent('designer'), 'approved: the hired agent joins the roster')
  same(M.completeApproval(w.rt(), h1.id, { ok: true }, w.ctx(def2)).reason, 'stale', 'completeApproval only ends an applying one')
  // B5 review (finding 3): the other hire, on the base trusted before, can never be approved: it is cancelled with its
  // own error and leaves Te necesita, and a decide that raced the cancel answers conflict stale (never already_decided).
  const hs = w.approval(hsId)
  check(hs.state === 'cancelled' && hs.error === M.HIRE_STALE && M.HIRE_STALE === 'stale' && hs.decidedAt === w.clock.now && !hs.decidedBy, 'the apply cancels every other pending hire on the old base (error stale)', hs)
  check(!w.needs().some((n) => n.id === hsId) && !M.teamNeedsRows(M.needsInputOf(w.rt(), 'trusted', undefined, def2)).some((n) => n.id === hsId), 'it leaves Te necesita (and the badge)')
  same([w.decide(user, hsId, 'approve', undefined).reason, w.decide(user, hsId, 'reject', 'x').reason, M.decideApproval(w.rt(), user, hsId, 'approve', undefined, w.ctx(def2)).reason], ['stale', 'stale', 'stale'], 'a decide that raced it: conflict stale, either way and on either definition')
  const otherCancel = { ...w.rt(), approvals: w.rt().approvals.map((a) => (a.id === hsId ? { ...a, error: undefined } : a)) }
  same(M.decideApproval(otherCancel, user, hsId, 'approve', undefined, w.ctx(def2)).reason, 'already_decided', 'control: a hire cancelled for another reason answers already_decided')
  // cancelStaleHires itself: a hire on the trusted base stays, one on another goes; nothing to cancel is the same runtime.
  const onBase = (id, base) => ({ ...hs, id, state: 'pending', payload: { ...hs.payload, baseDefHash: base }, error: undefined, decidedAt: undefined })
  const rtC = { ...w.rt(), approvals: [...w.rt().approvals, onBase('a-90', def2.sha256), onBase('a-91', w.def.sha256)] }
  const outC = M.cancelStaleHires(rtC, def2.sha256, w.ctx(def2))
  same([outC.approvals.find((a) => a.id === 'a-90').state, outC.approvals.find((a) => a.id === 'a-91').state, outC.approvals.find((a) => a.id === 'a-91').error], ['pending', 'cancelled', 'stale'], 'cancelStaleHires: the hire on the trusted base stays pending, the one on another is cancelled')
  check(M.cancelStaleHires(w.rt(), def2.sha256, w.ctx(def2)) === w.rt(), 'nothing pending on another base: the same runtime')
  // B5 review, second round: an apply that fails would put its hire back to pending; on a base that is no longer the
  // trusted hash (a trust landed while it applied) it could never be approved, so it is cancelled stale instead, and so
  // is every other pending hire on an old base. On the trusted base it is pending again with its error; without a
  // trusted definition (TeamService passes only the clock) nothing is called stale.
  const applying = (id, base) => ({ ...onBase(id, base), state: 'applying', decidedAt: w.clock.now - 5, decidedBy: user })
  const rtF = { ...w.rt(), approvals: [...w.rt().approvals, applying('a-92', w.def.sha256), applying('a-93', def2.sha256), onBase('a-94', w.def.sha256)] }
  w.tick()
  const outF = M.completeApproval(rtF, 'a-92', { ok: false, error: 'untrusted' }, w.ctx(def2))
  const f92 = outF.rt.approvals.find((a) => a.id === 'a-92')
  check(outF.ok && f92.state === 'cancelled' && f92.error === M.HIRE_STALE && f92.decidedAt === w.clock.now && !f92.decidedBy, 'a failed apply on an old base: cancelled stale, never pending again', f92)
  check(outF.rt.approvals.find((a) => a.id === 'a-94').state === 'cancelled' && outF.rt.approvals.find((a) => a.id === 'a-93').state === 'applying', 'the other pending hire on the old base goes with it; the one applying on the trusted base is not touched')
  check(!M.teamNeedsRows(M.needsInputOf(outF.rt, 'trusted', undefined, def2)).some((n) => n.id === 'a-92') && M.decideApproval(outF.rt, user, 'a-92', 'approve', undefined, w.ctx(def2)).reason === 'stale', 'out of Te necesita; a decide that raced it answers conflict stale')
  const f93 = M.completeApproval(rtF, 'a-93', { ok: false, error: 'changed' }, w.ctx(def2)).rt.approvals.find((a) => a.id === 'a-93')
  check(f93.state === 'pending' && f93.error === 'changed' && !f93.decidedBy, 'control: a failed apply on the trusted base is pending again with its error', f93)
  const f92c = M.completeApproval(rtF, 'a-92', { ok: false, error: 'untrusted' }, { now: w.clock.now }).rt.approvals.find((a) => a.id === 'a-92')
  check(f92c.state === 'pending' && f92c.error === 'untrusted', 'without a trusted definition (only the clock): pending again, no hash to call it stale', f92c)
  // A replace of an existing role, and a reject with its system note.
  const lr2 = w.go('lead', undefined, 'lead')
  r = w.tool(lr2, 'team.hire', { text: devText.replace('count: 2', 'count: 3') })
  w.commit(r, 'hire: more devs')
  const h2 = w.approval(r.result.approvalId)
  check(h2.payload.roleId === 'dev' && h2.payload.replaces === true, 'the same name replaces its role')
  w.finish(lr2)
  w.commit(w.decide(user, h2.id, 'reject', 'Con dos alcanza'), 'reject the hire')
  const note = w.rt().comments.lead.at(-1)
  check(w.approval(h2.id).state === 'rejected' && note.sys.key === 'hireRejected' && note.sys.vars.roleId === 'dev' && !note.forAgent && note.author.kind === 'system', 'rejected: a hireRejected system note in the Lead thread that wakes nobody')
}

// ---- 9. Codex blocks (R11) ------------------------------------------------------------------------------
const agentText = (scenario) => JSON.parse(fs.readFileSync(path.join(fixtures, `${scenario}.json`), 'utf8')).steps.map((s) => s.emit).find((e) => e && e.type === 'item.completed').item.text
function blockChecks() {
  const w = world({ files: filesOf(codexEdit) })
  const t1 = w.create('Investigar API', { assignee: 'research' })
  const rr = w.go('research', t1, 'plan')
  const block = M.parseTeamBlock(agentText('codex-readonly-block'))
  check(block && block.actions.length === 2, 'the codex-readonly-block fixture parses to two actions')
  let r = M.applyBlock(w.rt(), w.actor(rr), block, w.ctx())
  w.commit(r, 'applyBlock')
  const t = w.task(t1)
  check(r.result.applied === 2 && r.result.stoppedAt === undefined && w.rt().comments[t1].at(-1).text === 'Plan written' && t.phase === 'planApproval' && t.plan.text === '1. Read the code\n2. Change it', 'the block happy path: a comment, then the plan (planApproval)')
  check(w.run(rr).concludedBy.tool === 'plan' && !r.effects.some((e) => e.kind === 'deadline' && /conclude$/.test(e.key)), 'a block concludes its run without a grace deadline (its run is ending)')
  w.finish(rr)

  // A rejected action stops the list there.
  const t2 = w.create('Otra', { assignee: 'research' })
  const r2 = w.go('research', t2, 'plan')
  const stop = { v: 1, actions: [
    { method: 'team.comment', params: { target: t2, text: 'uno' } },
    { method: 'team.task.update', params: { task: t2, title: 'x' } },
    { method: 'team.comment', params: { target: t2, text: 'tres' } },
  ] }
  r = M.applyBlock(w.rt(), w.actor(r2), stop, w.ctx())
  w.commit(r, 'a block with a refused action')
  same(json(r.result), { applied: 1, stoppedAt: 1, error: 'forbidden' }, 'the refused action stops the list (applied 1, stopped at 1)')
  check(w.rt().comments[t2].map((c) => c.text).join() === 'uno', 'only the accepted prefix landed')
  // A block on a stopping run (the user stopped it; the block is read at close).
  w.commit(M.requestStop(w.rt(), r2, 'user', w.ctx()), 'stop the run')
  r = M.applyBlock(w.rt(), w.actor(r2), { v: 1, actions: [{ method: 'team.comment', params: { target: t2, text: 'al cerrar ghp_0123456789abcdefghijABCDEFGHIJ012345' } }] }, w.ctx())
  w.commit(r, 'a block of a stopping run')
  check(r.result.applied === 1 && !w.rt().comments[t2].at(-1).text.includes('ghp_0123456789'), 'a stopping run\'s block still applies (viaBlock), its texts redacted like the CLI path')
  w.finish(r2)
  // A block read at close after the user moved the task to done or cancelled: no card opens on a task that is over.
  for (const to of ['done', 'cancelled']) {
    const tx = w.create(`Cerrada ${to}`, { assignee: 'research', needsPlan: false })
    const rx = w.go('research', tx, 'exec')
    w.commit(M.moveTask(w.rt(), user, tx, to, w.task(tx).rev, { stopRun: true }, w.ctx()), `move to ${to} with the run live`)
    for (const method of ['team.ask', 'team.needs']) {
      r = M.applyBlock(w.rt(), w.actor(rx), { v: 1, actions: [{ method, params: { text: '¿Sigo?' } }] }, w.ctx())
      check(r.result.applied === 0 && r.result.error === 'conflict' && !r.rt.cards.some((c) => c.taskId === tx && c.state === 'open'), `${method} in a block after a move to ${to}: refused, no open card on the task`)
    }
    w.finish(rx)
  }

  // A Codex Lead block: t-5 then t-6 blocked by it ($1), a plan with code fences in a ```` fence.
  const lw = world({ files: filesOf(codexEdit) })
  for (let i = 1; i <= 4; i++) lw.create(`Previa ${i}`)
  const lr = lw.go('lead', undefined, 'lead')
  const refs = M.parseTeamBlock(agentText('codex-block-refs'))
  r = M.applyBlock(lw.rt(), lw.actor(lr), refs, lw.ctx())
  lw.commit(r, 'the codex-block-refs block')
  const t5 = lw.task('t-5')
  const t6 = lw.task('t-6')
  check(r.result.applied === 2 && t5 && t5.title === 'A' && t5.body.includes('```js') && t6 && json(t6.blockedBy).join() === 't-5' && t6.state === 'blocked', 'the Lead creates t-5, then t-6 blocked by "$1" = t-5')
  // An unresolved ref ($3) and a ref that names no create stop the list.
  r = M.applyBlock(lw.rt(), lw.actor(lr), { v: 1, actions: [
    { method: 'team.task.create', params: { title: 'C' } },
    { method: 'team.task.create', params: { title: 'D', blockedBy: ['$3'] } },
  ] }, lw.ctx())
  lw.commit(r, 'a block with an unresolved ref')
  same(json(r.result), { applied: 1, stoppedAt: 1, error: 'bad_request' }, 'an unresolved $3 stops the list')
  check(lw.task('t-7') && lw.task('t-7').title === 'C' && !lw.task('t-8'), 'the create before it landed, the one after did not')
  r = M.applyBlock(lw.rt(), lw.actor(lr), { v: 1, actions: [
    { method: 'team.comment', params: { target: 'lead', text: 'hola' } },
    { method: 'team.comment', params: { target: '$1', text: 'x' } },
  ] }, lw.ctx())
  same(json(r.result), { applied: 1, stoppedAt: 1, error: 'bad_request' }, 'a ref to an action that created nothing stops the list')
}

// ---- 10. a task that ends closes its approvals and cards (requirement 3) --------------------------------
function endPathsChecks() {
  const w = world()
  /** A task with a pending permission approval, an open agent card and a queue item. */
  const loaded = (title) => {
    const id = w.create(title, { assignee: 'ops', needsPlan: false, isolation: 'main' })
    const run = w.go('ops', id, 'exec')
    w.commit(M.permissionAsk(w.rt(), w.run(run), [{ tool: 'Bash', input: { command: `make ${id}` } }], w.ctx(), { protect: PROTECT }), `a permission ask on ${id}`)
    w.commit(w.tool(run, 'team.ask', { text: `¿Sigo con ${id}?` }), `an ask on ${id}`)
    w.finish(run)
    const rt = w.rt()
    w.commit({ ok: true, rt: { ...rt, queue: [...rt.queue, { id: `q-${rt.nextIds.queue}`, agentId: 'ops', taskId: id, sessionKey: id, mode: 'exec', reason: 'answer', createdAt: w.clock.now }], nextIds: { ...rt.nextIds, queue: rt.nextIds.queue + 1 } }, effects: [], result: undefined }, `a queue item on ${id}`)
    check(w.needs().filter((n) => n.taskId === id).length === 3, `${id}: an approval, a card and a queue item in Te necesita`)
    return id
  }
  const closed = (id, label) => {
    check(!w.rt().approvals.some((a) => a.taskId === id && (a.state === 'pending' || a.state === 'applying')) && !w.rt().cards.some((c) => c.taskId === id && c.state === 'open') && !w.rt().queue.some((q) => q.taskId === id), `${label}: no approval, card or queue item of it stays open`)
    check(!w.needs().some((n) => n.taskId === id), `${label}: nothing of it in Te necesita`)
  }
  const a = loaded('Mover a hecha')
  // Item 3 (B5 integration, decision 64): an orphan card is about a process, not the task: it outlives the task's end.
  const orphan = M.openSystemCard(w.rt(), { why: 'orphan', actions: ['killOrphan', 'dismiss'], taskId: a, runId: 'r-0000000000aa', vars: { what: 'r-0000000000aa', runId: 'r-0000000000aa', agentId: 'ops', pid: 4321 } }, w.ctx())
  w.commit(orphan, 'an orphan card on the task')
  w.commit(M.moveTask(w.rt(), user, a, 'done', w.task(a).rev, {}, w.ctx()), 'the user moves it to done')
  check(!w.rt().approvals.some((x) => x.taskId === a && x.state === 'pending') && !w.rt().queue.some((q) => q.taskId === a) && w.rt().cards.filter((c) => c.taskId === a && c.state === 'open').map((c) => c.id).join() === orphan.result.cardId, 'a user move to done: everything of it closed but the orphan card')
  check(w.needs().some((n) => n.id === orphan.result.cardId) && w.needs().filter((n) => n.taskId === a).length === 1, 'which stays in Te necesita with its killOrphan')
  check(M.closeTaskNeeds(w.rt(), a, w.ctx()) === w.rt(), 'closeTaskNeeds leaves it too (nothing else is open)')
  w.commit(w.answer(user, orphan.result.cardId, { action: 'dismiss' }), 'Descartar closes it')
  closed(a, 'a user move to done')
  const b = loaded('Cancelar')
  w.commit(M.moveTask(w.rt(), phone, b, 'cancelled', w.task(b).rev, {}, w.ctx()), 'the user cancels it (phone)')
  closed(b, 'a user cancel')
  const c = loaded('El Lider cancela')
  const lr = w.go('lead', undefined, 'lead')
  w.commit(w.tool(lr, 'team.task.update', { task: c, state: 'cancelled' }), 'the Lead cancels it')
  w.finish(lr)
  closed(c, 'the Lead\'s cancel (T19)')
  // T11 to done (team done, then the final OK).
  const d = w.create('Final', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const dr = w.go('ops', d, 'exec')
  w.commit(M.permissionAsk(w.rt(), w.run(dr), [{ tool: 'Bash', input: { command: 'make final' } }], w.ctx(), { protect: PROTECT }), 'a permission ask on the final task')
  w.commit(w.tool(dr, 'team.done', { text: 'listo' }), 'team done')
  w.commit(M.openSystemCard(w.rt(), { why: 'stalled', actions: ['keepWaiting'], taskId: d, runId: dr }, w.ctx()), 'a card while it waits')
  w.finish(dr)
  const fin = w.rt().approvals.find((x) => x.kind === 'final' && x.taskId === d && x.state === 'pending')
  w.commit(w.decide(user, fin.id, 'approve'), 'the final OK')
  check(w.approval(fin.id).state === 'approved' && w.task(d).state === 'done', 'the final approval itself is approved, the task done')
  closed(d, 'team done and the final OK (T11)')
  // The archive sweep closes what an old done task left open (a state from before B5).
  const old = w.create('Vieja')
  w.commit(M.moveTask(w.rt(), user, old, 'done', w.task(old).rev, {}, w.ctx()), 'an old task done')
  const rt = w.rt()
  const leftover = { ...rt, cards: [...rt.cards, { id: `k-${rt.nextIds.card}`, taskId: old, kind: 'confirm', question: '', options: [], multi: false, state: 'open', from: { kind: 'system', why: 'stalled', actions: ['dismiss'] }, createdAt: rt.tasks[0].createdAt }], nextIds: { ...rt.nextIds, card: rt.nextIds.card + 1 } }
  w.commit({ ok: true, rt: leftover, effects: [], result: undefined }, 'a leftover open card of the done task')
  w.tick(M.TASK_ARCHIVE_AFTER_MS + 1)
  w.commit(M.archiveSweep(w.rt(), w.ctx()), 'the archive sweep')
  check(w.rt().archivedTasks[old] === 'done' && !w.rt().cards.some((x) => x.taskId === old && x.state === 'open'), 'archived: its open card is dismissed')
  // A decision on an approval of a task that is over is stale.
  const e = w.create('Stale', { assignee: 'ops', needsPlan: false, isolation: 'main' })
  const er = w.go('ops', e, 'exec')
  const asked = M.permissionAsk(w.rt(), w.run(er), [{ tool: 'Bash', input: { command: 'make e' } }], w.ctx(), { protect: PROTECT })
  w.commit(asked, 'a permission ask')
  w.finish(er)
  const forged = { ...w.rt(), tasks: w.rt().tasks.map((t) => (t.id === e ? { ...t, state: 'cancelled', phase: 'none' } : t)) }
  same(M.decideApproval(forged, user, asked.result.approvalId, 'approve', undefined, w.ctx(), { rev: 1 }).reason, 'stale', 'an approval of a cancelled task is stale')
}

// ---- 11. the grace window: team task get after team review leaves a newer comment queued ------------------
function graceChecks() {
  const w = world()
  const t1 = w.create('Grace', { assignee: 'dev', needsPlan: false })
  const ex = w.go('dev', t1, 'exec')
  w.commit(w.tool(ex, 'team.review', {}), 'team review')
  w.tick()
  w.commit(M.addComment(w.rt(), user, t1, 'Una cosa más', 'comment', w.ctx()), 'a user comment during the grace')
  const c = w.rt().comments[t1].at(-1)
  // TeamService.ctlRead delivers only while the run is neither concluded nor stopping (4.5): the run says it concluded.
  check(!!w.run(ex).concludedBy && w.run(ex).state === 'running', 'the run is concluded but still running (grace)')
  check(c.forAgent === 'qa' && !c.deliveredRunId, 'the newer comment is queued (for the QA now) and stays so')
  same(w.tool(ex, 'team.comment', { target: t1, text: 'x' }).reason, 'concluded', 'and the run writes no more')
}

// ---- 12. "Te necesita": one count -----------------------------------------------------------------------
function needsChecks() {
  const w = world()
  const t1 = w.create('A', { assignee: 'dev' })
  const p = w.go('dev', t1, 'plan')
  w.commit(w.tool(p, 'team.plan', { text: 'small', small: true }), 'a small plan (the Lead decides)')
  w.finish(p)
  const t2 = w.create('B', { assignee: 'dev-2', needsPlan: false })
  const e = w.go('dev-2', t2, 'exec')
  w.commit(w.tool(e, 'team.ask', { text: '?' }), 'a card')
  w.finish(e)
  w.commit(M.setTeamFlags(w.rt(), { paused: true }, w.ctx()), 'a user pause')
  const input = M.needsInputOf(w.rt(), 'trusted', undefined, w.def)
  const rows = M.teamNeedsRows(input)
  check(M.teamNeedsCount(input) === rows.length && rows.length === 1 && rows[0].kind === 'card', 'one count: the card only (a lead-decided approval and a user pause do not count)', rows)
  const changed = M.teamNeedsRows(M.needsInputOf(w.rt(), 'changed', w.clock.now, w.def))
  check(changed[0].id === 'trust' && changed[0].rank === 1 && changed.length === 2, 'a changed definition adds the trust row first')
}

// ---- 13. seeded random op sequences (I1..I22 after every commit: the strict store throws) -----------------
function randomChecks() {
  let orphansSeen = 0
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = world()
    let s = seed * 7919
    // Math.imul keeps the LCG in 32-bit integers (a float product past 2^53 loses its low bits and picks 3 ops of 12);
    // the high bits pick (an LCG's low bits cycle).
    const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) % n }
    const pick = (list) => list[rnd(list.length)]
    let commits = 0
    const tryCommit = (res) => {
      if (res && res.ok) {
        w.store.commit(res, ['board'])
        commits++
      }
    }
    const agents = ['dev', 'dev-2', 'qa', 'qa-2', 'research', 'ops']
    for (let step = 0; step < 250; step++) {
      w.tick(rnd(5000))
      const rt = w.rt()
      const op = rnd(12)
      try {
        if (op === 0 && rt.tasks.length < 12) tryCommit(M.createTask(rt, user, { title: `T${step}`, assignee: pick(['dev', 'dev-2', 'research', 'ops']), needsPlan: rnd(2) === 0, isolation: pick(['main', 'worktree']) }, w.ctx()))
        else if (op === 1) {
          // Admit a run its task's phase wants.
          const t = pick(rt.tasks.filter((x) => x.state === 'todo' || x.state === 'doing' || (x.state === 'review' && x.phase === 'qa')))
          // Within the team cap (I18): the dispatcher's gate, which a direct admitRun skips.
          if (t && !rt.activeRuns.some((r) => r.taskId === t.id) && rt.activeRuns.length < Math.min(w.def.def.maxConcurrent, M.TEAM_MAX_CONCURRENT)) {
            const agentId = t.phase === 'qa' ? t.review.qaAgentId : t.assignee
            const mode = t.state === 'todo' ? M.todoModeOf(t) : { planning: 'plan', executing: 'exec', qa: 'qa' }[t.phase]
            const a = rt.agents.find((x) => x.id === agentId)
            if (a && a.status === 'idle' && mode) {
              const role = w.def.def.roles.find((r) => r.id === a.roleId)
              const req = { agentId, taskId: t.id, sessionKey: t.id, mode, reason: 'assigned', since: w.clock.now, priority: 'normal', approved: true, bypassCooldown: false }
              const res = M.admitRun(rt, req, { sessionKey: t.id, resume: null, cwd: t.worktree?.path ?? 'C:\\repo', profile: mode === 'plan' ? 'readonly' : role.permission, sysHash: 'h' }, w.ctx())
              tryCommit(res)
              if (res.ok) {
                w.treeFor(res.result.run.id)
                tryCommit(M.markStarting(w.rt(), res.result.run.id, { pid: 1, delivered: NO_DELIVERY }, w.ctx()))
                tryCommit(M.markRunning(w.rt(), res.result.run.id, { at: w.clock.now, sysHash: 'h' }, w.ctx()))
              }
            }
          }
        } else if (op >= 2 && op <= 5) {
          // A tool call of a live run.
          const run = pick(rt.activeRuns)
          if (run) {
            const method = pick(['team.plan', 'team.review', 'team.verdict', 'team.done', 'team.ask', 'team.needs', 'team.comment'])
            const params = { 'team.plan': { text: 'p', small: rnd(2) === 0 }, 'team.review': {}, 'team.verdict': { verdict: pick(['approve', 'changes']), text: 'v' }, 'team.done': {}, 'team.ask': { text: '?' }, 'team.needs': { text: '!' }, 'team.comment': { target: run.taskId ?? 'lead', text: 'c' } }[method]
            tryCommit(M.applyTool(rt, { kind: 'agent', agentId: run.agentId, runId: run.id, roleKind: run.roleKind }, { method, params }, w.ctx()))
          }
        } else if (op === 6) {
          const run = pick(rt.activeRuns)
          if (run) {
            const end = { at: w.clock.now, exit: { code: 0, signal: null }, facts: baseFacts({ digest: { tools: rnd(3), families: {}, files: [] } }), teamWrites: rnd(2) }
            const terminal = M.terminalOf(run, end)
            tryCommit(M.finishRun(rt, run.id, end, M.afterRunPolicy(M.runEndFactsOf(rt, terminal, w.clock.now)), { now: w.clock.now }))
          }
        } else if (op === 7) {
          const ap = pick(rt.approvals.filter((a) => a.state === 'pending' && a.kind !== 'integrate' && a.kind !== 'hire'))
          // A permission decide mostly with the rev it has (the view's), sometimes with an older one (stale, nothing moves).
          if (ap) tryCommit(M.decideApproval(rt, pick([user, phone]), ap.id, pick(['approve', 'reject']), pick([undefined, 'nota']), w.ctx(), { ahead: pick([undefined, 0, 2]), ...(ap.kind === 'permission' ? { rev: pick([ap.rev ?? 1, ap.rev ?? 1, 1]) } : {}) }))
        } else if (op === 8) {
          const c = pick(rt.cards.filter((x) => x.state === 'open'))
          if (c) {
            const a = c.from.kind === 'system' ? { action: pick(c.from.actions) } : c.kind === 'choice' ? { choices: [0] } : c.kind === 'confirm' ? { confirm: rnd(2) === 0 } : { text: 'r' }
            tryCommit(M.answerCard(rt, user, c.id, a, w.ctx()))
          }
        } else if (op === 9) {
          const t = pick(rt.tasks.filter((x) => x.state !== 'cancelled'))
          if (t) tryCommit(M.moveTask(rt, user, t.id, pick(['todo', 'blocked', 'done', 'cancelled']), t.rev, { stopRun: rnd(2) === 0 }, w.ctx()))
        } else if (op === 10) {
          const run = pick(rt.activeRuns.filter((r) => r.taskId))
          if (run) tryCommit(M.permissionAsk(rt, run, [{ tool: pick(['Bash', 'PowerShell', 'Write', 'Edit', 'mcp__x']), input: { command: `cmd${rnd(4)} x`, file_path: 'C:\\repo\\f' } }], w.ctx(), { protect: PROTECT }))
        } else if (op === 11 && step % 3 === 0) {
          // Decision 64: an orphan card on a task (a process of an earlier life); it outlives the task's end.
          const t = pick(rt.tasks)
          if (t) tryCommit(M.openSystemCard(rt, { why: 'orphan', actions: ['killOrphan', 'dismiss'], taskId: t.id, vars: { what: `r-${step}` } }, w.ctx()))
        } else tryCommit(M.reconcileTasks(rt, w.def.def, w.ctx()))
      } catch (err) {
        throw new Error(`seed ${seed} step ${step} op ${op}: ${err.message}`)
      }
      // Requirement 3 at every step: nothing open belongs to a task that is over, but an orphan card (decision 64: it
      // is about a process, its killOrphan stays).
      const over = new Set(w.rt().tasks.filter((t) => t.state === 'done' || t.state === 'cancelled').map((t) => t.id))
      if (w.rt().approvals.some((a) => a.taskId && over.has(a.taskId) && a.state === 'pending') || w.rt().cards.some((c) => c.taskId && over.has(c.taskId) && c.state === 'open' && !(c.from.kind === 'system' && c.from.why === 'orphan'))) {
        throw new Error(`seed ${seed} step ${step}: an approval or card of a task that is over stayed open`)
      }
      orphansSeen += w.rt().cards.filter((c) => c.from.kind === 'system' && c.from.why === 'orphan' && c.state === 'open' && over.has(c.taskId)).length > 0 ? 1 : 0
      if (w.rt().tasks.some((t) => (t.grants ?? []).some((g) => /^powershell/i.test(g.tool)))) throw new Error(`seed ${seed} step ${step}: a PowerShell grant`)
    }
    check(commits > 60, `seed ${seed}: ${commits} random commits held I1..I22, closed what ended and granted no PowerShell rule`)
  }
  check(orphansSeen > 0, 'the random sequences kept an orphan card open past its task end at least once (decision 64)', orphansSeen)
}

hashAndGrantChecks()
planChecks()
qaChecks()
finalChecks()
replanChecks()
cardChecks()
systemCardChecks()
permissionChecks()
permissionWaitChecks()
hireChecks()
blockChecks()
endPathsChecks()
graceChecks()
needsChecks()
randomChecks()
console.log(`PASS: ${checks} teams approvals checks (terminal tools, approvals, QA rounds, cards, permission grants, hire, Codex block)`)
