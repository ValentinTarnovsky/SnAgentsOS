// Teams dispatch (app 2.7.0, E10 B4, design 2.9 and the 4.1 policy table): every candidate level
// (L1 task.next, L2 assigned, L3 queued comments, L4 the Lead's userMessage, kickoff, leadApproval and
// triage, L5 a routine wake, manual entries), compareRequests, every gate of planDispatch in order with
// its reason and until (G1 team, G1b agent, autonomy off -> enqueue once per key, G2 caps inside one
// pass and across teams, G3 quota, G4 cooldown, G5 session, G6 tree and the settle rule, consoleBusy when only
// a console of the user holds the tree, a lingering orphan, a discarded level skipped before the agent's
// minimum), nextAt, unblockReady and the 3 per hour throttle, claudeAllLimited, classifyOutcome in order
// (with the codex-read and claude-tools fixtures through the B2 parsers) and afterRunPolicy row by row.
// Tanda B close: a skip keyed `agentId|sessionKey|reason` leaves out one Lead level only (the others still enqueue).
// 2.7.0 runtime fixes: a manual entry carries `manual` (the goal change kickoff level does not), and the
// `permissionWait` row (a run waiting on its permission approval: only the provider rows and a fresh session).
// Fixed `now`, no clock reads. Same esbuild + vm harness as test-status.cjs: the bundle runs in an empty
// context (no require, no process), so the module is pure.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const fixtures = path.join(__dirname, 'fixtures', 'teams')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }

const entry = `
export * from './src/shared/teamDispatch'
export { emptyRuntime, NO_PROGRESS_BLOCK_AT, NO_PROGRESS_COOLDOWN_MIN, RETRY_DELAY_MS, LIMIT_FALLBACK_MS } from './src/shared/teams'
export { createClaudeStreamParser } from './src/main/teams/parsers/claudeStream'
export { createCodexExecParser } from './src/main/teams/parsers/codexExec'
`
const code = buildSync({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent' }).outputFiles[0].text
const mod = { exports: {} }
vm.runInNewContext(code, { module: mod, exports: mod.exports })
const D = mod.exports

const NOW = Date.UTC(2026, 9, 24, 15, 0)
const MIN = 60_000
const GOAL = 'g-1'

// ---- builders -----------------------------------------------------------------------------------
const role = (id, kind, permission, provider = 'claude') => ({ id, name: id, kind, provider, permission, count: 1, instructions: '' })
const DEF = {
  name: 'Notas', goal: 'Una app de notas con sync.', rules: '', verifyTimeoutMin: 20, maxRunMinutes: 45, maxConcurrent: 3, leadApprovesSmallPlans: true,
  extraRepos: [], routines: [],
  roles: [role('lead', 'lead', 'readonly'), role('dev', 'dev', 'total'), role('qa', 'qa', 'readonly'), role('research', 'research', 'readonly'), role('cdx', 'dev', 'total', 'codex')],
}
const def = (o = {}) => ({ ...DEF, ...o })
const agent = (id, roleId, roleKind, o = {}) => ({ id, roleId, roleKind, provider: roleId === 'cdx' ? 'codex' : 'claude', status: 'idle', paused: false, sessions: {}, interrupts: 0, ...o })
const counters = (o = {}) => ({ noProgress: 0, continuations: 0, retries: 0, interrupts: 0, unblockWakes: 0, unblockWindowStart: 0, ...o })
const task = (n, o = {}) => ({
  id: `t-${n}`, rev: 1, title: `Tarea ${n}`, body: '', state: 'todo', phase: 'none', priority: 'normal', repoId: 'main', isolation: 'worktree', needsPlan: false,
  blockedBy: [], createdBy: { kind: 'user', via: 'desktop' }, createdAt: NOW - 3_600_000 + n, updatedAt: NOW, stateSince: NOW,
  review: { round: 0, max: 3 }, userOwned: [], counters: counters(), ...o,
})
const comment = (n, target, o = {}) => ({ id: `m-${n}`, target, author: { kind: 'user', via: 'desktop' }, kind: 'comment', at: NOW - 600_000 + n, text: 'hola', ...o })
/** A runtime with the Lead (goal seen), dev, dev-2, qa and research, every one idle. */
function rt(o = {}) {
  const r = D.emptyRuntime('tm-0123456789ab', '0a1b2c3d')
  return {
    ...r, autoDispatch: true, goalSeenHash: GOAL,
    agents: [agent('lead', 'lead', 'lead'), agent('dev', 'dev', 'dev'), agent('dev-2', 'dev', 'dev'), agent('qa', 'qa', 'qa'), agent('research', 'research', 'research')],
    ...o,
  }
}
const facts = (o = {}) => ({
  now: NOW, enabled: true, trusted: true, cliReady: true, globalActive: 0, claudeBlockedUntil: null,
  busySessions: new Set(), busyCwds: new Set(), writerCwds: new Set(), integrateCwds: new Set(), cwdKeys: {}, manual: [], ...o,
})
const reqs = (r, f = {}, d = DEF) => D.candidatesOf(r, d, GOAL, facts(f))
const plan = (r, f = {}, d = DEF) => D.planDispatch(r, d, GOAL, facts(f))
const of = (list, agentId) => list.find((x) => x.agentId === agentId)
const deferOf = (p, agentId) => p.deferred.find((d) => d.request.agentId === agentId)
const run = (id, agentId, o = {}) => ({ id, agentId, roleId: agentId.replace(/-\d$/, ''), roleKind: 'dev', sessionKey: 'free', provider: 'claude', profile: 'total', resumed: false, cwd: 'C:\\repo', repoId: 'main', mode: 'free', trigger: { reason: 'manual', by: 'user' }, state: 'running', reachedRunning: true, resultSeen: false, queuedAt: NOW, ...o })

// ---- candidates ---------------------------------------------------------------------------------
function candidateChecks() {
  check(reqs(rt()).length === 0, 'no work: no candidates')
  // L2: the assignee of a todo task without next.
  let c = reqs(rt({ tasks: [task(1, { assignee: 'dev' })] }))
  same(c.map((x) => [x.agentId, x.taskId, x.mode, x.reason, x.sessionKey, x.approved, x.bypassCooldown]), [['dev', 't-1', 'exec', 'assigned', 't-1', false, false]], 'L2: todo assigned -> exec, keyed by the task')
  check(of(reqs(rt({ tasks: [task(1, { assignee: 'dev', needsPlan: true })] })), 'dev').mode === 'plan', 'L2: needsPlan -> plan')
  check(of(reqs(rt({ tasks: [task(1, { assignee: 'dev', needsPlan: true, plan: { rev: 1, text: 'p', status: 'approved', small: false, at: NOW } })] })), 'dev').mode === 'exec', 'L2: needsPlan with an approved plan -> exec')
  same(reqs(rt({ tasks: [task(1)] })).map((x) => [x.agentId, x.reason]), [['lead', 'triage']], 'an unassigned todo task asks nobody but the Lead (triage)')
  // L1: task.next of the agent when its mode matches the phase.
  const next = (agentId, mode, reason, o = {}) => ({ agentId, mode, reason, since: NOW - 5000, ...o })
  c = reqs(rt({ tasks: [task(2, { state: 'doing', phase: 'executing', assignee: 'dev', next: next('dev', 'exec', 'changes', { refs: ['k-1'] }) })] }))
  same(c.map((x) => [x.agentId, x.mode, x.reason, x.since, x.refs]), [['dev', 'exec', 'changes', NOW - 5000, ['k-1']]], 'L1: task.next with its reason, since and refs')
  check(reqs(rt({ tasks: [task(2, { state: 'doing', phase: 'executing', assignee: 'dev', next: next('dev', 'plan', 'retry') })] })).length === 0, 'L1: a next whose mode does not match the phase is no level')
  check(reqs(rt({ tasks: [task(2, { state: 'doing', phase: 'executing', assignee: 'dev', next: next('dev-2', 'exec', 'retry') })] })).length === 0, 'L1: a next for another agent than the assignee is no level')
  check(of(reqs(rt({ tasks: [task(2, { state: 'review', phase: 'qa', assignee: 'dev', review: { round: 1, max: 3, qaAgentId: 'qa' }, next: next('qa', 'qa', 'review') })] })), 'qa').mode === 'qa', 'L1: the QA agent in phase qa')
  for (const s of [{ state: 'blocked', phase: 'executing' }, { state: 'done', phase: 'none' }, { state: 'cancelled', phase: 'none' }, { state: 'doing', phase: 'planApproval' }, { state: 'review', phase: 'userOk' }]) {
    check(reqs(rt({ tasks: [task(3, { ...s, assignee: 'dev', next: next('dev', 'exec', 'retry') })] })).length === 0, `no level in ${s.state}/${s.phase}`)
  }
  check(of(reqs(rt({ tasks: [task(4, { assignee: 'dev', next: next('dev-2', 'exec', 'retry') })] })), 'dev').reason === 'assigned', 'L2: a todo task whose next is stale still asks its assignee')
  // L3: queued comments for the agent on a target whose phase lets it run.
  c = reqs(rt({ tasks: [task(5, { state: 'doing', phase: 'executing', assignee: 'dev' })], comments: { 't-5': [comment(1, 't-5', { forAgent: 'dev' }), comment(2, 't-5', { forAgent: 'dev', deliveredRunId: 'r-000000000001' })] } }))
  same(c.map((x) => [x.agentId, x.mode, x.reason, x.since]), [['dev', 'exec', 'comment', NOW - 600_000 + 1]], 'L3: a queued comment wakes the assignee (since the oldest queued)')
  check(reqs(rt({ tasks: [task(5, { state: 'doing', phase: 'executing', assignee: 'dev' })], comments: { 't-5': [comment(2, 't-5', { forAgent: 'dev', deliveredRunId: 'r-000000000001' })] } })).length === 0, 'L3: a delivered comment is no level')
  check(reqs(rt({ tasks: [task(6, { state: 'review', phase: 'qa', assignee: 'dev', review: { round: 1, max: 3, qaAgentId: 'qa' } })], comments: { 't-6': [comment(1, 't-6', { forAgent: 'dev' })] } })).length === 0, 'L3: the assignee cannot run while its task is in qa')
  check(of(reqs(rt({ tasks: [task(6, { state: 'review', phase: 'qa', assignee: 'dev', review: { round: 1, max: 3, qaAgentId: 'qa' } })], comments: { 't-6': [comment(1, 't-6', { forAgent: 'qa' })] } })), 'qa').reason === 'comment', 'L3: the QA agent in qa')
  check(reqs(rt({ tasks: [task(6, { state: 'doing', phase: 'planApproval', assignee: 'dev' })], comments: { 't-6': [comment(1, 't-6', { forAgent: 'dev' })] } })).length === 0, 'L3: planApproval waits on the user')
  // A task with an active run yields nothing; a running agent yields nothing.
  check(reqs(rt({ tasks: [task(7, { assignee: 'dev-2' })], activeRuns: [run('r-000000000007', 'dev', { taskId: 't-7', sessionKey: 't-7', mode: 'exec' })] })).length === 0, 'a task with an active run yields no request')
  const busy = rt({ tasks: [task(8, { assignee: 'dev' })], activeRuns: [run('r-000000000008', 'dev')] })
  busy.agents = busy.agents.map((a) => (a.id === 'dev' ? { ...a, status: 'running', runId: 'r-000000000008' } : a))
  check(reqs(busy).length === 0, 'a running agent yields no request')
  // Paused agents still yield (G1b reports it); retired ones and roles gone from the definition do not.
  const paused = rt({ tasks: [task(9, { assignee: 'dev' })] })
  paused.agents = paused.agents.map((a) => (a.id === 'dev' ? { ...a, paused: true } : a))
  check(reqs(paused).length === 1, 'a paused agent still yields its request')
  const retired = rt({ tasks: [task(9, { assignee: 'dev' })] })
  retired.agents = retired.agents.map((a) => (a.id === 'dev' ? { ...a, retired: true } : a))
  check(reqs(retired).length === 0, 'a retired agent yields nothing')
  check(reqs(rt({ tasks: [task(9, { assignee: 'dev' })] }), {}, def({ roles: DEF.roles.filter((r) => r.id !== 'dev') })).length === 0, 'an agent whose role left the definition yields nothing')
  // One per agent, its minimum: the urgent task first; an approved queue item first of all.
  c = reqs(rt({ tasks: [task(10, { assignee: 'dev' }), task(11, { assignee: 'dev', priority: 'urgent' }), task(12, { assignee: 'dev-2', priority: 'low' })] }))
  same(c.map((x) => [x.agentId, x.taskId]), [['dev', 't-11'], ['dev-2', 't-12']], 'one request per agent, its most urgent; sorted by compareRequests')
  const queue = [{ id: 'q-1', agentId: 'dev', sessionKey: 't-10', taskId: 't-10', mode: 'exec', reason: 'assigned', createdAt: NOW - 1000, approvedAt: NOW - 500 }]
  c = reqs(rt({ tasks: [task(10, { assignee: 'dev' }), task(11, { assignee: 'dev', priority: 'urgent' })], queue }))
  same(c.map((x) => [x.taskId, x.approved, x.queueItemId]), [['t-10', true, 'q-1']], 'an approved queue item names the request and wins (approved first)')
  c = reqs(rt({ tasks: [task(10, { assignee: 'dev' })], queue: [{ ...queue[0], approvedAt: undefined }] }))
  check(c[0].queueItemId === 'q-1' && c[0].approved === false, 'a queue item not approved yet: named, not approved')

  // L4: the Lead.
  const lead = (o) => of(reqs(rt(o)), 'lead')
  check(lead({ comments: { lead: [comment(1, 'lead', { forAgent: 'lead' })] } }).reason === 'userMessage', 'L4: the user wrote to the Lead -> userMessage')
  const um = lead({ comments: { lead: [comment(1, 'lead', { forAgent: 'lead' })] } })
  check(um.mode === 'lead' && um.sessionKey === 'lead' && um.priority === 'high' && um.bypassCooldown === true, 'userMessage: lead mode on the lead session, high, it lifts a cooldown')
  check(lead({ goalSeenHash: 'g-0' }).reason === 'kickoff', 'L4: a goal the Lead has not seen -> kickoff (decision 43)')
  check(lead({ goalSeenHash: undefined }).reason === 'kickoff', 'L4: a new team (no goal seen) -> kickoff')
  check(of(reqs(rt({ goalSeenHash: 'g-0' }), {}, def({ goal: '  ' })), 'lead') === undefined, 'L4: an empty goal is no kickoff')
  const approval = (o = {}) => ({ id: 'a-1', taskId: 't-1', kind: 'plan', state: 'pending', decider: 'lead', createdAt: NOW - 9000, createdBy: { kind: 'system' }, payload: { planRev: 1, small: true }, ...o })
  const la = lead({ approvals: [approval()] })
  check(la.reason === 'leadApproval' && JSON.stringify(la.refs) === '["a-1"]' && la.since === NOW - 9000, 'L4: a small plan the Lead decides -> leadApproval with its id')
  check(lead({ approvals: [approval({ leadSeenRunId: 'r-000000000009' })] }) === undefined, 'L4: an approval the Lead already saw is no level')
  check(lead({ approvals: [approval({ decider: 'user' })] }) === undefined, 'L4: a user-decided approval is no Lead level')
  check(lead({ tasks: [task(1)] }).reason === 'triage', 'L4: an unassigned todo task -> triage')
  check(lead({ tasks: [task(1, { triagedAt: NOW - 1 })] }) === undefined, 'L4: a triaged task is no level')
  check(lead({ tasks: [task(1, { createdBy: { kind: 'agent', agentId: 'lead', runId: 'r-000000000001', roleKind: 'lead' } })] }) === undefined, 'L4: a task the Lead created itself never wakes it to triage (self-wake guard)')
  check(lead({ agents: rt().agents.map((a) => (a.id === 'lead' ? { ...a, next: { agentId: 'lead', mode: 'lead', reason: 'retry', since: NOW - 1 } } : a)) }).reason === 'retry', 'L4: agent.next of the Lead')
  check(lead({ tasks: [task(1)], comments: { lead: [comment(1, 'lead', { forAgent: 'lead', at: NOW - 1 })] } }).reason === 'userMessage', 'the user message (high) wins over triage (normal) even when newer')
  // L5: agent.next of a non-lead agent (routine wake -> free), low.
  const routine = rt({ agents: rt().agents.map((a) => (a.id === 'research' ? { ...a, next: { agentId: 'research', mode: 'free', reason: 'routine', since: NOW - 1, detail: 'Resumen diario' } } : a)) })
  const r5 = of(reqs(routine), 'research')
  check(r5.mode === 'free' && r5.sessionKey === 'free' && r5.reason === 'routine' && r5.priority === 'low' && r5.detail === 'Resumen diario', 'L5: a routine wake -> a free run, low, with its prompt')
  check(of(reqs(rt({ tasks: [task(1, { assignee: 'research' })], agents: routine.agents })), 'research').taskId === 't-1', 'L5: a routine wake ranks below a task')

  // Manual entries ("Ejecutar ahora", kickoff): approved and bypassCooldown.
  const m = (o) => ({ agentId: 'dev', reason: 'manual', ...o })
  c = reqs(rt({ tasks: [task(13, { assignee: 'dev', priority: 'low' }), task(14, { assignee: 'dev' })] }), { manual: [m()] })
  same(c.map((x) => [x.agentId, x.taskId, x.mode, x.reason, x.approved, x.bypassCooldown]), [['dev', 't-14', 'exec', 'manual', true, true]], 'manual without a prompt: the agent\'s best level, approved, bypassing the cooldown')
  c = reqs(rt({ tasks: [task(14, { assignee: 'dev' })] }), { manual: [m({ detail: 'Arregla el login' })] })
  same(c.map((x) => [x.mode, x.sessionKey, x.detail, x.taskId ?? null]), [['free', 'free', 'Arregla el login', null]], 'manual with a prompt: a free run with the request')
  check(reqs(rt(), { manual: [m()] })[0].mode === 'free', 'manual with nothing pending: a free run')
  c = reqs(rt({ tasks: [task(15, { state: 'doing', phase: 'planning', assignee: 'dev' })] }), { manual: [m({ taskId: 't-15' })] })
  check(c[0].taskId === 't-15' && c[0].mode === 'plan' && c[0].approved, 'manual on a task: the mode of its phase')
  check(reqs(rt({ tasks: [task(16, { state: 'doing', phase: 'planApproval', assignee: 'dev' })] }), { manual: [m({ taskId: 't-16' })] }).length === 0, 'manual on a task waiting on the user: nothing to run')
  check(reqs(rt({ tasks: [task(16, { assignee: 'dev-2' })] }), { manual: [m({ taskId: 't-16' })] }).filter((x) => x.agentId === 'dev').length === 0, 'manual on another agent\'s task: nothing')
  const kick = of(reqs(rt(), { manual: [{ agentId: 'lead', reason: 'kickoff' }] }), 'lead')
  check(kick.reason === 'kickoff' && kick.mode === 'lead' && kick.approved && kick.bypassCooldown, 'kickoff: a lead request, approved')
  // 2.7.0 runtime fixes: the user's entry is marked (admitRun gives it trigger.by 'user'); the kickoff a goal change
  // raises (the L4 level of the same reason) and every other level are not.
  check(kick.manual === true && of(reqs(rt(), { manual: [m()] }), 'dev').manual === true && of(reqs(rt({ tasks: [task(15, { state: 'doing', phase: 'planning', assignee: 'dev' })] }), { manual: [m({ taskId: 't-15' })] }), 'dev').manual === true, 'a manual entry (kickoff, Ejecutar ahora, on a task) carries manual')
  const auto = of(reqs(rt({ goalSeenHash: 'g-0' })), 'lead')
  check(auto.reason === 'kickoff' && auto.manual === undefined && !auto.approved, 'the goal change kickoff level carries no manual mark')
  check(reqs(rt({ tasks: [task(1, { assignee: 'dev' })], comments: { lead: [comment(1, 'lead', { forAgent: 'lead' })] } })).every((x) => x.manual === undefined), 'nor any other level')
  check(plan(rt({ goalSeenHash: 'g-0' }), { manual: [{ agentId: 'lead', reason: 'kickoff' }] }).start.find((x) => x.agentId === 'lead')?.manual === true, 'planDispatch starts the user\'s kickoff with its mark')
  const mr = of(reqs(busy, { manual: [m()] }), 'dev')
  check(mr && mr.approved, 'manual of a running agent still yields (planDispatch reports running)')

  // compareRequests: approved, rank (userMessage counts high, routines low), since, agentId, task number.
  const R = (o) => ({ agentId: 'dev', sessionKey: 'free', mode: 'free', reason: 'assigned', since: 10, priority: 'normal', approved: false, bypassCooldown: false, ...o })
  check(D.compareRequests(R({ approved: true, priority: 'low' }), R({ priority: 'urgent' })) < 0, 'compare: approved first')
  check(D.compareRequests(R({ priority: 'urgent' }), R({ priority: 'high' })) < 0, 'compare: priority')
  check(D.compareRequests(R({ reason: 'userMessage', priority: 'normal' }), R({ priority: 'high', since: 0 })) > 0 && D.compareRequests(R({ reason: 'userMessage', priority: 'normal' }), R({ priority: 'normal', since: 0 })) < 0, 'compare: userMessage counts as high')
  check(D.compareRequests(R({ reason: 'routine', priority: 'urgent', since: 1 }), R({ priority: 'normal', since: 99 })) > 0, 'compare: a routine counts as low (after a normal one, whatever its own priority)')
  check(D.compareRequests(R({ reason: 'routine', priority: 'urgent', since: 50 }), R({ priority: 'low', since: 10 })) > 0 && D.compareRequests(R({ reason: 'routine', since: 5 }), R({ priority: 'low', since: 10 })) < 0, 'compare: a routine and a low one go by since')
  check(D.compareRequests(R({ since: 1 }), R({ since: 2 })) < 0 && D.compareRequests(R({ agentId: 'a' }), R({ agentId: 'b' })) < 0, 'compare: since, then agentId')
  check(D.compareRequests(R({ taskId: 't-9' }), R({ taskId: 't-10' })) < 0, 'compare: task numbers, not strings')
}

// ---- gates --------------------------------------------------------------------------------------
function gateChecks() {
  const work = (o = {}) => rt({ tasks: [task(1, { assignee: 'dev' })], ...o })
  // G1 team: nothing starts, nothing is enqueued, every request deferred with the reason.
  for (const [f, o, reason] of [[{ enabled: false }, {}, 'disabled'], [{ trusted: false }, {}, 'untrusted'], [{ cliReady: false }, {}, 'cliOff'], [{}, { paused: { reason: 'user', at: NOW } }, 'paused']]) {
    const p = plan(work({ autoDispatch: false, ...o }), f)
    check(p.start.length === 0 && p.enqueue.length === 0 && deferOf(p, 'dev')?.reason === reason, `G1 ${reason}: deferred, nothing enqueued`)
  }
  check(plan(work({ paused: { reason: 'user', at: NOW } }), { enabled: false }).deferred[0].reason === 'disabled', 'G1 in order: disabled before paused')
  // G1b agent paused: deferred, not enqueued even with autonomy off.
  const pausedRt = work({ autoDispatch: false })
  pausedRt.agents = pausedRt.agents.map((a) => (a.id === 'dev' ? { ...a, paused: true } : a))
  let p = plan(pausedRt)
  check(deferOf(p, 'dev').reason === 'agentPaused' && p.enqueue.length === 0, 'G1b agentPaused: deferred, not enqueued')
  // Autonomy off (decision 18): enqueue once per (agentId, sessionKey), report G2..G6, never start.
  p = plan(work({ autoDispatch: false }))
  check(p.start.length === 0 && p.enqueue.length === 1 && p.enqueue[0].taskId === 't-1' && deferOf(p, 'dev').reason === 'autonomyOff', 'autonomy off: enqueued, deferred autonomyOff')
  const item = { id: 'q-1', agentId: 'dev', sessionKey: 't-1', taskId: 't-1', mode: 'exec', reason: 'assigned', createdAt: NOW - 1 }
  p = plan(work({ autoDispatch: false, queue: [item] }))
  check(p.enqueue.length === 0 && deferOf(p, 'dev').reason === 'autonomyOff', 'autonomy off with the item already queued: not enqueued again')
  p = plan(work({ autoDispatch: false }), { cwdKeys: { 't-1': 'wt1' }, writerCwds: new Set(['wt1']) })
  check(p.enqueue.length === 1 && deferOf(p, 'dev').reason === 'treeBusy', 'autonomy off: a later gate is the reason shown, the item is still enqueued')
  p = plan(work({ autoDispatch: false, queue: [{ ...item, approvedAt: NOW - 1 }] }))
  check(p.start.length === 1 && p.start[0].queueItemId === 'q-1', 'an approved item skips the autonomy gate')
  p = plan(work({ autoDispatch: false, queue: [{ ...item, approvedAt: NOW - 1 }] }), { cwdKeys: { 't-1': 'wt1' }, writerCwds: new Set(['wt1']) })
  check(p.start.length === 0 && deferOf(p, 'dev').reason === 'treeBusy', 'an approved item still meets G2..G6 (treeBusy)')
  p = plan(work({ autoDispatch: false, queue: [{ ...item, approvedAt: NOW - 1 }], providerBlockedUntil: { claude: NOW + 5 * MIN } }))
  check(deferOf(p, 'dev').reason === 'quota', 'an approved item still meets G3')
  check(plan(work({ autoDispatch: false }), { manual: [{ agentId: 'dev', reason: 'manual' }] }).start.length === 1, 'a manual entry skips the autonomy gate')
  // Descartar (B4 review): a level the user discarded is left out before the agent's minimum is picked, so the agent's
  // next level becomes its candidate, gets its queue item and is what the roster says it waits for.
  const two = rt({ autoDispatch: false, tasks: [task(20, { assignee: 'dev', priority: 'urgent' }), task(21, { assignee: 'dev' })] })
  const skip = { skip: new Set(['dev|t-20']) }
  same(of(reqs(two), 'dev').taskId, 't-20', 'two tasks for one agent: its most urgent is the candidate')
  same(of(D.candidatesOf(two, DEF, GOAL, facts(), skip), 'dev').taskId, 't-21', 'the discarded level skipped: the next one is the candidate')
  p = D.planDispatch(two, DEF, GOAL, facts(), skip)
  check(p.enqueue.length === 1 && p.enqueue[0].taskId === 't-21' && deferOf(p, 'dev').request.taskId === 't-21' && deferOf(p, 'dev').reason === 'autonomyOff', 'autonomy off: the next level is enqueued and waits autonomyOff (AgentView.waiting reads it)')
  check(D.planDispatch(two, DEF, GOAL, facts({ manual: [{ agentId: 'dev', reason: 'manual', taskId: 't-20' }] }), skip).start.some((x) => x.taskId === 't-20'), 'a manual entry is never skipped')
  p = D.planDispatch(two, DEF, GOAL, facts({ manual: [{ agentId: 'dev', reason: 'manual' }] }), skip)
  check(p.start.length === 1 && p.start[0].taskId === 't-21', `a manual entry without a task runs the level the roster names, not the discarded one (${JSON.stringify(p.start.map((x) => x.taskId ?? null))})`)
  check(!of(D.candidatesOf(two, DEF, GOAL, facts(), { skip: new Set(['dev|t-20', 'dev|t-21']) }), 'dev'), 'every level of the agent discarded: no candidate, nothing to wait for')
  // Tanda B close (finding 6): every Lead level shares the session key 'lead'; a skip keyed `agentId|sessionKey|reason`
  // leaves out only that level, so a discarded message never hides the Lead's triage or a small plan it decides.
  const leadTwo = rt({ autoDispatch: false, tasks: [task(30)], comments: { lead: [comment(1, 'lead', { forAgent: 'lead' })] } })
  same(of(reqs(leadTwo), 'lead').reason, 'userMessage', 'the Lead with a message and an untriaged task: the message is its candidate')
  same(of(D.candidatesOf(leadTwo, DEF, GOAL, facts(), { skip: new Set(['lead|lead|userMessage']) }), 'lead').reason, 'triage', 'the message skipped by its reason: the Lead\'s triage is the candidate')
  const smallPlan = { id: 'a-1', taskId: 't-30', kind: 'plan', state: 'pending', decider: 'lead', createdAt: NOW - 9000, createdBy: { kind: 'system' }, payload: { planRev: 1, small: true } }
  const leadPlan = rt({ autoDispatch: false, approvals: [smallPlan], comments: { lead: [comment(1, 'lead', { forAgent: 'lead' })] } })
  p = D.planDispatch(leadPlan, DEF, GOAL, facts(), { skip: new Set(['lead|lead|userMessage']) })
  check(p.enqueue.some((x) => x.agentId === 'lead' && x.reason === 'leadApproval'), 'a pending small plan the Lead decides still enqueues while its message is skipped')
  check(!of(D.candidatesOf(leadTwo, DEF, GOAL, facts(), { skip: new Set(['lead|lead']) }), 'lead'), 'control: a skip of the whole key leaves the Lead nothing (what the old key did)')
  // A manual entry of a busy agent: running, or stopping.
  const busy = work({ activeRuns: [run('r-000000000002', 'dev')] })
  busy.agents = busy.agents.map((a) => (a.id === 'dev' ? { ...a, status: 'running', runId: 'r-000000000002' } : a))
  check(deferOf(plan(busy, { manual: [{ agentId: 'dev', reason: 'manual' }] }), 'dev').reason === 'running', 'manual of a running agent: running')
  busy.activeRuns = [run('r-000000000002', 'dev', { state: 'stopping', stopReason: 'user' })]
  check(deferOf(plan(busy, { manual: [{ agentId: 'dev', reason: 'manual' }] }), 'dev').reason === 'stopping', 'manual of an agent whose run stops: stopping')

  // G2 caps: inside one pass, queued and stopping runs count, then across teams.
  const four = rt({ tasks: [task(1, { assignee: 'dev' }), task(2, { assignee: 'dev-2' }), task(3, { assignee: 'research' }), task(4, { assignee: 'dev', state: 'review', phase: 'qa', review: { round: 0, max: 3, qaAgentId: 'qa' }, next: { agentId: 'qa', mode: 'qa', reason: 'review', since: NOW - 1 } })] })
  p = plan(four, {}, def({ maxConcurrent: 2 }))
  check(p.start.length === 2 && p.deferred.filter((d) => d.reason === 'teamCap').length === 2 && p.deferred.every((d) => d.until === undefined) && p.nextAt === null, 'G2 teamCap inside one pass: min(maxConcurrent, 3) start, the rest wait with no until')
  check(plan(four, {}, def({ maxConcurrent: 5 })).start.length === 3, 'G2: the team cap never passes 3')
  p = plan({ ...four, activeRuns: [run('r-00000000000a', 'lead', { state: 'queued' }), run('r-00000000000b', 'research', { state: 'stopping' })] }, {}, def({ maxConcurrent: 3 }))
  check(p.start.length === 1, 'G2: queued and stopping runs count toward the cap')
  p = plan(four, { globalActive: 2 })
  check(p.start.length === 1 && p.deferred.filter((d) => d.reason === 'globalCap').length === 3, 'G2 globalCap: GLOBAL_MAX_RUNS across teams')
  const a = plan(four, { globalActive: 0 }, def({ maxConcurrent: 2 }))
  const b = plan(rt({ teamId: 'tm-ba9876543210', tasks: [task(1, { assignee: 'dev' }), task(2, { assignee: 'dev-2' })] }), { globalActive: a.start.length }, def({ maxConcurrent: 2 }))
  check(a.start.length === 2 && b.start.length === 1 && deferOf(b, b.deferred[0].request.agentId).reason === 'globalCap', 'G2 across teams: the second team gets what the first left of the global cap')
  // G3 quota: per provider (decision 19) and every Claude account at its limit.
  p = plan(rt({ tasks: [task(1, { assignee: 'dev' }), task(2, { assignee: 'cdx' })], agents: [...rt().agents, agent('cdx', 'cdx', 'dev')], providerBlockedUntil: { claude: NOW + 10 * MIN } }))
  check(deferOf(p, 'dev').reason === 'quota' && deferOf(p, 'dev').until === NOW + 10 * MIN && p.start.length === 1 && p.start[0].agentId === 'cdx', 'G3: a Claude block holds Claude agents only (Codex runs)')
  p = plan(work(), { claudeBlockedUntil: NOW + 7 * MIN })
  check(deferOf(p, 'dev').reason === 'quota' && deferOf(p, 'dev').until === NOW + 7 * MIN && p.nextAt === NOW + 7 * MIN, 'G3: every Claude account limited -> quota until the reset, nextAt')
  check(plan(work({ providerBlockedUntil: { claude: NOW - 1 } })).start.length === 1 && plan(work(), { claudeBlockedUntil: NOW }).start.length === 1, 'G3: a block in the past holds nothing')
  // G4 cooldown: task.cooldownUntil or next.notBefore, the max; bypassCooldown skips it; a user comment lifts it.
  const cool = (o = {}) => rt({ tasks: [task(1, { state: 'doing', phase: 'executing', assignee: 'dev', cooldownUntil: NOW + 5 * MIN, next: { agentId: 'dev', mode: 'exec', reason: 'continuation', since: NOW - 1, notBefore: NOW + 10 * MIN } })], ...o })
  p = plan(cool())
  check(deferOf(p, 'dev').reason === 'cooldown' && deferOf(p, 'dev').until === NOW + 10 * MIN, 'G4: cooldown until the later of cooldownUntil and notBefore')
  check(plan(cool(), { manual: [{ agentId: 'dev', reason: 'manual', taskId: 't-1' }] }).start.length === 1, 'G4: a manual run bypasses the cooldown')
  check(plan(cool({ comments: { 't-1': [comment(1, 't-1', { forAgent: 'dev' })] } })).start.length === 1, 'G4: a user comment waiting for the agent lifts the cooldown (human comments bypass the rewake throttle)')
  check(deferOf(plan(cool({ comments: { 't-1': [comment(1, 't-1', { forAgent: 'dev', author: { kind: 'agent', agentId: 'qa', runId: 'r-000000000001', roleKind: 'qa' } })] } })), 'dev').reason === 'cooldown', 'G4: an agent comment does not lift it')
  const bypassMark = rt({ tasks: [task(1, { state: 'doing', phase: 'executing', assignee: 'dev', next: { agentId: 'dev', mode: 'exec', reason: 'retry', since: NOW - 1, notBefore: NOW + MIN, bypassCooldown: true } })] })
  check(plan(bypassMark).start.length === 1, 'G4: a mark with bypassCooldown (card retry) skips it')
  // G5 session.
  const withSess = (o = {}) => {
    const r = work(o)
    r.agents = r.agents.map((x) => (x.id === 'dev' ? { ...x, sessions: { 't-1': { provider: 'claude', sessionId: 's-1', cwd: 'C:\\wt1', createdAt: NOW - 1, turns: 1, sysHash: 'h' } } } : x))
    return r
  }
  check(deferOf(plan(withSess(), { busySessions: new Set(['s-1']) }), 'dev').reason === 'sessionBusy', 'G5: a session a console holds -> sessionBusy')
  check(plan(withSess(), { busySessions: new Set(['s-2']) }).start.length === 1, 'G5: another busy session holds nothing')
  const taken = work()
  taken.agents = taken.agents.map((x) => (x.id === 'dev' ? { ...x, status: 'takenOver', takeover: { phase: 'bound', at: NOW, sessionKey: 't-9', sessionId: 's-9', provider: 'claude', cwd: 'C:\\x', paneId: 'p', workspaceId: 'w' } } : x))
  check(deferOf(plan(taken), 'dev').reason === 'takenOver', 'G5: a taken over agent -> takenOver')
  // G6 tree and the settle rule (decision 36).
  check(deferOf(plan(work(), { cwdKeys: { 't-1': 'wt1' }, writerCwds: new Set(['wt1']) }), 'dev').reason === 'treeBusy', 'G6: a writer on a held tree -> treeBusy')
  check(deferOf(plan(work(), { cwdKeys: { 't-1': 'wt1' }, busyCwds: new Set(['wt1']) }), 'dev').reason === 'consoleBusy', 'G6: a writer where only a human console works -> consoleBusy (its own reason: no run holds the tree)')
  check(deferOf(plan(work(), { cwdKeys: { 't-1': 'wt1' }, writerCwds: new Set(['wt1']), busyCwds: new Set(['wt1']) }), 'dev').reason === 'treeBusy', 'G6: a run holding the tree wins over the console (treeBusy)')
  check(deferOf(plan(work({ autoDispatch: false }), { cwdKeys: { 't-1': 'wt1' }, busyCwds: new Set(['wt1']) }), 'dev').reason === 'consoleBusy', 'autonomy off: the queue row reads consoleBusy too')
  check(plan(work(), { cwdKeys: { 't-1': 'wt1' }, writerCwds: new Set(['wt2']), busyCwds: new Set(['wt3']) }).start.length === 1, 'G6: other trees hold nothing')
  const qaRt = rt({ tasks: [task(1, { state: 'review', phase: 'qa', assignee: 'dev', review: { round: 1, max: 3, qaAgentId: 'qa' }, next: { agentId: 'qa', mode: 'qa', reason: 'review', since: NOW - 1 } })] })
  check(deferOf(plan(qaRt, { cwdKeys: { 't-1': 'wt1' }, writerCwds: new Set(['wt1']) }), 'qa').reason === 'treeBusy', 'settle rule: QA waits treeBusy while the Dev\'s writer run still holds the worktree')
  check(plan(qaRt, { cwdKeys: { 't-1': 'wt1' }, busyCwds: new Set(['wt1']) }).start.length === 1, 'a readonly QA run is not held by a human console')
  const leadRt = rt({ comments: { lead: [comment(1, 'lead', { forAgent: 'lead' })] }, agents: rt().agents.map((x) => (x.id === 'research' ? { ...x, next: { agentId: 'research', mode: 'free', reason: 'routine', since: NOW - 1 } } : x)) })
  p = plan(leadRt, { cwdKeys: { lead: 'root', free: 'root' }, writerCwds: new Set(['root']), busyCwds: new Set(['root']) })
  check(p.start.length === 2 && p.start.some((x) => x.agentId === 'lead') && p.start.some((x) => x.agentId === 'research'), 'the Lead and a free readonly run at the repo root are not held by a main-isolation Dev lock nor a console')
  p = plan(leadRt, { cwdKeys: { lead: 'root', free: 'root' }, integrateCwds: new Set(['root']), writerCwds: new Set(['root']) })
  check(deferOf(p, 'lead').reason === 'treeBusy' && deferOf(p, 'research').reason === 'treeBusy', 'an integrate on the root holds the Lead and the free readonly run')
  const freeWriter = rt({ agents: rt().agents.map((x) => (x.id === 'dev' ? { ...x, next: { agentId: 'dev', mode: 'free', reason: 'routine', since: NOW - 1 } } : x)) })
  check(deferOf(plan(freeWriter, { cwdKeys: { free: 'root' }, writerCwds: new Set(['root']) }), 'dev').reason === 'treeBusy', 'a free run of a writing role is a writer: held by the root lock')
  // A pass-local writer: the first main-isolation Dev holds the root for the next one in the same pass.
  const twoMain = rt({ tasks: [task(1, { assignee: 'dev', isolation: 'main' }), task(2, { assignee: 'dev-2', isolation: 'main' }), task(3, { assignee: 'research', isolation: 'main' })] })
  p = plan(twoMain, { cwdKeys: { 't-1': 'root', 't-2': 'root', 't-3': 'root' } })
  check(p.start.length === 1 && p.start[0].agentId === 'dev' && deferOf(p, 'dev-2').reason === 'treeBusy' && deferOf(p, 'research').reason === 'treeBusy', 'G6 inside one pass: a started writer holds its tree for the writers and the task readers after it')
  // A plan run is readonly (effectiveProfile): two plan runs share a tree.
  const twoPlans = rt({ tasks: [task(1, { assignee: 'dev', isolation: 'main', needsPlan: true }), task(2, { assignee: 'dev-2', isolation: 'main', needsPlan: true })] })
  check(plan(twoPlans, { cwdKeys: { 't-1': 'root', 't-2': 'root' } }).start.length === 2, 'a plan run is readonly: it takes no tree')
  // A lingering orphan (decision 64): its session in busySessions, its cwd in writerCwds.
  p = plan(withSess(), { busySessions: new Set(['s-1']), writerCwds: new Set(['wt1']), cwdKeys: { 't-1': 'wt1' } })
  check(deferOf(p, 'dev').reason === 'sessionBusy', 'a lingering orphan session -> sessionBusy')
  const other = withSess()
  other.agents = other.agents.map((x) => (x.id === 'dev' ? { ...x, sessions: {} } : x))
  check(deferOf(plan(other, { writerCwds: new Set(['wt1']), cwdKeys: { 't-1': 'wt1' } }), 'dev').reason === 'treeBusy', 'a lingering orphan cwd -> treeBusy')
  // Gates in order: G2 before G3 before G4 before G5 before G6.
  const all = withSess({ providerBlockedUntil: { claude: NOW + MIN } })
  all.tasks = [{ ...all.tasks[0], cooldownUntil: NOW + 2 * MIN }]
  const f = { busySessions: new Set(['s-1']), cwdKeys: { 't-1': 'wt1' }, writerCwds: new Set(['wt1']) }
  check(deferOf(plan(all, { ...f, globalActive: 3 }), 'dev').reason === 'globalCap', 'order: caps first')
  check(deferOf(plan(all, f), 'dev').reason === 'quota', 'order: quota before cooldown')
  check(deferOf(plan({ ...all, providerBlockedUntil: {} }, f), 'dev').reason === 'cooldown', 'order: cooldown before session')
  check(deferOf(plan({ ...all, providerBlockedUntil: {}, tasks: [task(1, { assignee: 'dev' })] }, f), 'dev').reason === 'sessionBusy', 'order: session before tree')
  // nextAt: the earliest until among the deferred; start order is compareRequests.
  p = plan(rt({ tasks: [task(1, { assignee: 'dev', cooldownUntil: NOW + 5 * MIN }), task(2, { assignee: 'cdx' }), task(3, { assignee: 'dev-2', priority: 'urgent' }), task(4, { assignee: 'research', priority: 'high' })], agents: [...rt().agents, agent('cdx', 'cdx', 'dev')], providerBlockedUntil: { codex: NOW + 3 * MIN } }))
  check(p.nextAt === NOW + 3 * MIN, 'nextAt: the earliest until among the deferred')
  same(p.start.map((x) => x.agentId), ['dev-2', 'research'], 'start in admission order (most urgent first)')
}

// ---- unblock, quota -----------------------------------------------------------------------------
function unblockAndQuotaChecks() {
  const byId = new Map([['t-1', { state: 'done' }], ['t-2', { state: 'doing' }], ['t-3', { state: 'cancelled' }]])
  const u = (blockedBy, archived = {}, state = 'blocked') => D.unblockReady({ state, blockedBy }, byId, archived)
  check(u(['t-1']) === 'ready' && u([]) === 'ready', 'unblock: every blocker done (or none) -> ready')
  check(u(['t-1', 't-2']) === 'waiting', 'unblock: one blocker not done -> waiting')
  check(u(['t-1', 't-9'], { 't-9': 'done' }) === 'ready', 'unblock: an archived done blocker satisfies')
  check(u(['t-9'], { 't-9': 'cancelled' }) === 'cancelledBlocker' && u(['t-2', 't-3']) === 'cancelledBlocker', 'unblock: a cancelled blocker (live or archived) never satisfies, even beside a waiting one')
  check(u(['t-404']) === 'waiting', 'unblock: an unknown id waits')
  check(u(['t-1'], {}, 'done') === 'waiting' && u(['t-1'], {}, 'cancelled') === 'waiting', 'unblock: a done or cancelled task is never ready')
  // 3 unblock wakes per task per hour (T16).
  let c = { unblockWakes: 0, unblockWindowStart: 0 }
  const seen = []
  for (let k = 0; k < 4; k++) {
    const w = D.unblockWake(c, NOW + k * MIN)
    seen.push(w.ok)
    if (w.ok) c = w.counters
  }
  same(seen, [true, true, true, false], 'unblock: 3 wakes per hour, the 4th refused')
  check(c.unblockWakes === 3 && c.unblockWindowStart === NOW, 'unblock: the window opens at the first wake')
  const later = D.unblockWake(c, NOW + 60 * MIN)
  check(later.ok && later.counters.unblockWakes === 1 && later.counters.unblockWindowStart === NOW + 60 * MIN, 'unblock: an hour later a new window opens')

  // claudeAllLimited.
  const iso = (t) => new Date(t).toISOString()
  const win = (percent, resetsAt) => ({ percent, resetsAt: resetsAt === null ? null : iso(resetsAt), at: NOW, source: 'live' })
  const acc = (id, five, seven) => ({ id, rank: 0, role: 'primary', label: '', email: null, organizationName: null, subscriptionType: null, capturedAt: 0, active: false, tokenState: 'ok', needsRecapture: false, identityConfirmed: true, usage: { fiveHour: five, sevenDay: seven } })
  const state = (accounts, blocked = null) => ({ supported: true, liveSwitch: true, accounts, activeId: accounts[0]?.id ?? null, liveIdentity: 'known', autoPaused: null, lastSwitch: null, pending: null, blocked, restartNeeded: [] })
  check(D.claudeAllLimited(null, NOW).limited === false && D.claudeAllLimited(state([]), NOW).limited === false, 'claudeAllLimited: no state or no accounts -> false')
  check(D.claudeAllLimited(state([acc('a', win(40, NOW + MIN), win(10, NOW + 99 * MIN))]), NOW).limited === false, 'claudeAllLimited: an account under its limits -> false')
  same(D.claudeAllLimited(state([acc('a', win(100, NOW + 30 * MIN), win(50, NOW + 99 * MIN)), acc('b', win(100, NOW + 20 * MIN), win(100, NOW + 90 * MIN))]), NOW), { limited: true, until: NOW + 30 * MIN }, 'claudeAllLimited: every account at a limit -> the earliest account back (b waits for its 7 d reset)')
  check(D.claudeAllLimited(state([acc('a', win(100, NOW + 30 * MIN), win(5, null)), acc('b', win(80, NOW + MIN), win(5, null))]), NOW).limited === false, 'claudeAllLimited: one account left -> false')
  check(D.claudeAllLimited(state([acc('a', win(100, NOW - MIN), win(5, null))]), NOW).limited === false, 'claudeAllLimited: a reset already passed -> false')
  same(D.claudeAllLimited(state([acc('a', win(90, NOW + MIN), win(5, null)), acc('b', win(100, NOW + 40 * MIN), win(5, null))], 'allExhausted'), NOW), { limited: true, until: NOW + 40 * MIN }, 'claudeAllLimited: blocked allExhausted -> limited, until the known reset')
  same(D.claudeAllLimited(state([acc('a', win(null, null), win(null, null))], 'allExhausted'), NOW), { limited: true }, 'claudeAllLimited: allExhausted with no known reset -> limited, no until')
}

// ---- classifyOutcome ----------------------------------------------------------------------------
const fixture = (name) => fs.readFileSync(path.join(fixtures, `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
function factsOf(provider, lines) {
  const p = provider === 'claude' ? D.createClaudeStreamParser() : D.createCodexExecParser()
  lines.forEach((l, k) => p.line(typeof l === 'string' ? l : JSON.stringify(l), NOW + k))
  return p.facts({ code: 0 }, '', {}, NOW + 60_000)
}
function evidence(o = {}) {
  return { state: 'succeeded', isError: false, maxTurns: false, finalText: '', digest: { tools: 0, families: {}, files: [] }, teamWrites: 0, concluded: false, mode: 'exec', roleKind: 'dev', fileEdits: 0, ...o }
}
function evidenceOf(facts, o = {}) {
  return evidence({ isError: facts.isError, maxTurns: facts.maxTurns, finalText: facts.finalText, digest: facts.digest, fileEdits: facts.fileEdits, state: facts.failure ? 'failed' : 'succeeded', ...o })
}
function outcomeChecks() {
  const C = (o) => D.classifyOutcome(evidence(o))
  for (const s of ['cancelled', 'takenOver', 'interrupted', 'running', 'queued', 'stopping']) check(C({ state: s, concluded: true, teamWrites: 3 }) === undefined, `outcome: ${s} -> none`)
  check(C({ concluded: true }) === 'concluded' && C({ concluded: true, state: 'failed', isError: true }) === 'concluded', 'outcome: concluded, also when it failed afterwards')
  check(C({ state: 'failed', isError: true, teamWrites: 2 }) === 'failed', 'outcome: failed before any evidence')
  check(C({ maxTurns: true }) === 'progress', 'outcome: max turns -> progress (decision 10)')
  check(C({ teamWrites: 1 }) === 'progress' && C({ fileEdits: 1 }) === 'progress' && C({ treeMoved: true }) === 'progress', 'outcome: team writes, file edits or a moved tree -> progress')
  check(C({ treeMoved: false }) === 'empty', 'outcome: an unmoved tree is no evidence')
  // codex-read: a Codex exec run that only read a file (powershell Get-Content, the run family) is not progress.
  const read = factsOf('codex', fixture('codex-read'))
  check(read.digest.families.run === 1 && read.fileEdits === 0, 'codex-read facts: the run family, no edit')
  check(D.classifyOutcome(evidenceOf(read)) === 'empty', 'outcome: a Codex exec run that only read files is not progress')
  check(D.classifyOutcome(evidenceOf(read, { mode: 'qa', roleKind: 'qa' })) === 'progress', 'outcome: the same reads are the work of a QA run')
  // claude-tools: Read and Grep only.
  const tools = factsOf('claude', fixture('claude-tools'))
  check(D.classifyOutcome(evidenceOf(tools)) === 'empty', 'outcome: an exec run with only reads is not progress')
  check(D.classifyOutcome(evidenceOf(tools, { mode: 'plan' })) === 'progress' && D.classifyOutcome(evidenceOf(tools, { roleKind: 'research' })) === 'progress', 'outcome: plan and research reads are progress')
  // Only `snaos team show` calls: out of the digest (TEAM_CALL_RE), never progress.
  const THREAD = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000'
  const show = factsOf('codex', [
    { type: 'thread.started', thread_id: THREAD }, { type: 'turn.started' },
    { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'snaos team show --json', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'snaos team show --json', aggregated_output: '{}', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Listo.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
  ])
  check(show.teamCalls === 1 && show.digest.tools === 0, 'snaos team show facts: a team call, out of the digest')
  check(D.classifyOutcome(evidenceOf(show)) === 'empty' && D.classifyOutcome(evidenceOf(show, { mode: 'qa' })) === 'empty', 'outcome: a run with only snaos team show calls is not progress, in any mode')
  // Planning-only text.
  check(C({ finalText: "I'll inspect the login handler first." }) === 'planOnly' && C({ finalText: 'Let me check the tests.' }) === 'planOnly', 'outcome: PLANNING_ONLY_RE -> planOnly')
  check(C({ finalText: 'Hecho.\nNext steps:\n- tests' }) === 'planOnly' && C({ finalText: 'Plan: refactor' }) === 'planOnly', 'outcome: PLAN_HEADING_RE -> planOnly')
  check(C({ finalText: 'Done: the login works now.' }) === 'empty' && C({ finalText: '' }) === 'empty', 'outcome: anything else -> empty')
  check(C({ teamWrites: 1, finalText: "I'll check it next." }) === 'progress', 'outcome: evidence wins over planning words')
  check(D.PLAN_HEADING_RE.source === '^\\s*(?:next steps?|plan)\\s*:' && D.PLAN_HEADING_RE.flags.includes('m') && D.PLANNING_ONLY_RE.flags.includes('i'), 'the liveness regexes')
  // Line 1 and 2 of the module name the ported files (regexes: test-docs.cjs treats a file holding the literal header as adapted code).
  const head = fs.readFileSync(path.join(root, 'src/shared/teamDispatch.ts'), 'utf8').split(/\r?\n/)
  check(/^\/\/ Adaptado de paperclipai\/paperclip \(MIT\) - server\/src\/services\/run-liveness\.ts$/.test(head[0]) && /issue-rewake-throttle\.ts/.test(head[1]) && /issue-dependency-wakeups\.ts/.test(head[1]), 'teamDispatch.ts: the paperclip header on line 1, the other two sources on line 2')
  check(!/\bdeclare\b/.test(fs.readFileSync(path.join(root, 'src/shared/teamDispatch.ts'), 'utf8')), 'teamDispatch.ts: no declare left from the contract stub')
}

// ---- afterRunPolicy ----------------------------------------------------------------------------
const RUN = { id: 'r-0000000000aa', agentId: 'dev', roleKind: 'dev', taskId: 't-1', sessionKey: 't-1', mode: 'exec', provider: 'claude', state: 'succeeded', outcome: 'progress', trigger: { reason: 'assigned', by: 'system' }, reachedRunning: true, startedAt: NOW - 10 * MIN, endedAt: NOW }
const TASK = { id: 't-1', state: 'doing', phase: 'executing', counters: counters(), assignee: 'dev', review: { round: 0, max: 3 } }
function endFacts(r = {}, o = {}) {
  const runFacts = { ...RUN, ...r }
  for (const k of Object.keys(runFacts)) if (runFacts[k] === undefined) delete runFacts[k]
  const { task: t, ...rest } = o
  const f = { run: runFacts, task: { ...TASK, ...(t ?? {}), counters: counters(t?.counters ?? {}) }, agentInterrupts: 0, now: NOW, claudeCanSwitch: false, unknownSession: false, ...rest }
  if (t === null) delete f.task
  return f
}
const P = (r, o) => JSON.parse(JSON.stringify(D.afterRunPolicy(endFacts(r, o))))
const mark = (reason, notBefore) => (notBefore === undefined ? { agentId: 'dev', mode: 'exec', reason, since: NOW } : { agentId: 'dev', mode: 'exec', reason, since: NOW, notBefore })
const card = (why) => ({ reason: { kind: 'card', cardId: '', why }, card: { why, actions: ['retry', 'toTodo', 'cancelTask'] } })

function policyChecks() {
  // Row: cancelled by the user with the task still in the run's phase -> blocked {stopped}, next cleared (decision 38).
  let d = P({ state: 'cancelled', stopReason: 'user', outcome: undefined })
  check(d.next === null && d.block?.reason.kind === 'stopped' && d.block.reason.runId === RUN.id && !d.undeliver, 'user stop: blocked {stopped}, next cleared, nothing handed back')
  check(d.block.card === undefined, 'user stop: no card (decision 38: the drawer resumes it, nothing in Te necesita)')
  same(P({ state: 'cancelled', stopReason: 'user', outcome: undefined }, { task: { state: 'review', phase: 'qa' } }), {}, 'user stop with the task out of the run\'s phase: nothing')
  same(P({ state: 'cancelled', stopReason: 'user', outcome: undefined, taskId: undefined, sessionKey: 'free', mode: 'free' }, { task: null }), {}, 'user stop of a free run: nothing')
  // B4 requirement: a run the user stopped just before it exited on its own is never re-woken.
  d = P({ state: 'succeeded', stopReason: 'user', outcome: 'progress' })
  check(d.block?.reason.kind === 'stopped' && d.next === null && !d.counters, 'user stop that ended succeeded (progress): no continuation, blocked {stopped}')
  d = P({ state: 'failed', stopReason: 'user', outcome: 'failed', failure: { kind: 'overloaded' }, reachedRunning: false })
  check(d.next === null && d.block?.reason.kind === 'stopped' && !d.undeliver && !d.counters, 'user stop that ended failed (overloaded, before running): no retry, no undeliver')
  d = P({ state: 'failed', stopReason: 'user', outcome: 'failed', failure: { kind: 'limit', until: NOW + 30 * MIN } })
  check(d.providerBlock?.until === NOW + 30 * MIN && d.next === null, 'user stop that ended on a limit: the provider is blocked, nothing re-woken')
  check(P({ state: 'interrupted', stopReason: 'user', interruptCause: 'shutdown', outcome: undefined }).block?.reason.kind === 'stopped', 'user stop then quit (interrupted): still the user\'s stop')
  check(P({ state: 'succeeded', stopReason: 'user', outcome: 'concluded', concludedBy: { tool: 'ask', at: NOW - 1 } }).block === undefined, 'user stop after a terminal tool: the tool decided, no block')
  // Row: cancelled (taskMoved, deleted, paused), takenOver -> nothing.
  for (const reason of ['taskMoved', 'deleted', 'paused']) same(P({ state: 'cancelled', stopReason: reason, outcome: undefined }), {}, `cancelled ${reason}: nothing`)
  same(P({ state: 'takenOver', stopReason: 'takeover', outcome: undefined }), {}, 'takenOver: nothing')
  // Row: interrupted labsOff / cliOff / sessionConflict -> next interrupted, not counted.
  for (const cause of ['labsOff', 'cliOff', 'sessionConflict']) {
    same(P({ state: 'interrupted', stopReason: cause, interruptCause: cause, outcome: undefined }), { next: mark('interrupted') }, `interrupted ${cause}: next interrupted, not counted`)
  }
  check(P({ state: 'interrupted', stopReason: 'labsOff', interruptCause: 'labsOff', outcome: undefined, reachedRunning: false }).undeliver === true, 'interrupted before running: what it got goes back to queued')
  // Row: interrupted shutdown / crash.
  same(P({ state: 'interrupted', interruptCause: 'shutdown', stopReason: 'shutdown', outcome: undefined }), { next: mark('interrupted'), counters: { interrupts: 1 } }, 'shutdown: next interrupted, interrupts++')
  same(P({ state: 'interrupted', interruptCause: 'crash', outcome: undefined }, { task: { counters: { interrupts: 2 } } }), { block: card('interrupted') }, 'crash at INTERRUPTS_MAX: blocked with the interrupted card')
  same(P({ state: 'interrupted', interruptCause: 'crash', outcome: undefined, trigger: { reason: 'continuation', by: 'system' } }), { block: card('interrupted') }, 'crash of a continuation: blocked')
  check(P({ state: 'interrupted', interruptCause: 'crash', outcome: undefined, reachedRunning: false }).undeliver === true, 'crash before running: undeliver')
  const lead = { agentId: 'lead', roleKind: 'lead', taskId: undefined, sessionKey: 'lead', mode: 'lead' }
  const leadMark = { agentId: 'lead', mode: 'lead', reason: 'interrupted', since: NOW }
  same(P({ ...lead, state: 'interrupted', interruptCause: 'crash', outcome: undefined }, { task: null, agentInterrupts: 1 }), { next: leadMark, agentInterrupts: 2 }, 'task-less crash: next, the streak grows')
  same(P({ ...lead, state: 'interrupted', interruptCause: 'crash', outcome: undefined }, { task: null, agentInterrupts: 2 }), {}, 'task-less crash at the streak cap: nothing')
  same(P({ ...lead, outcome: 'empty' }, { task: null, agentInterrupts: 2 }), { agentInterrupts: 0 }, 'a task-less run that ends normally resets the streak')
  // Row: unknown session (one shot).
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'request' } }, { unknownSession: true }), { freshSession: true, next: mark('context') }, 'unknown session: a fresh session, next context')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'request' }, trigger: { reason: 'context', by: 'system' } }, { unknownSession: true }), { freshSession: true, next: mark('retry', NOW + D.RETRY_DELAY_MS), counters: { retries: 1 } }, 'a second unknown session falls to the request row')
  // Row: limit / rateLimited.
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'limit', until: NOW + 30 * MIN } }), { providerBlock: { provider: 'claude', until: NOW + 30 * MIN }, next: mark('retry', NOW + 30 * MIN) }, 'limit: the provider blocked until the reset, next retry at it')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'rateLimited' } }), { providerBlock: { provider: 'claude', until: NOW + D.LIMIT_FALLBACK_MS }, next: mark('retry', NOW + D.LIMIT_FALLBACK_MS) }, 'rate limited without a reset: now + 15 min')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'limit', until: NOW + 90 * MIN } }, { claudeCanSwitch: true }), { providerBlock: { provider: 'claude', until: NOW + D.LIMIT_FALLBACK_MS }, next: mark('retry', NOW + D.LIMIT_FALLBACK_MS) }, 'limit with another Claude account to switch to: now + 15 min')
  same(P({ state: 'failed', outcome: 'concluded', concludedBy: { tool: 'review', at: NOW - 1 }, failure: { kind: 'limit', until: NOW + 30 * MIN } }), { providerBlock: { provider: 'claude', until: NOW + 30 * MIN } }, 'limit after a terminal tool: the provider block only')
  check(P({ state: 'failed', outcome: 'failed', provider: 'codex', failure: { kind: 'limit', until: NOW + 30 * MIN } }, { claudeCanSwitch: true }).providerBlock.until === NOW + 30 * MIN, 'a Codex limit ignores the Claude switch')
  // Row: auth with an account switch inside the run (decision 40).
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'auth' } }, { claudeSwitchedAt: NOW - 5 * MIN }), { next: mark('retry'), counters: { retries: 1 } }, 'auth during an account switch: a retry, no team pause')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'auth' } }, { claudeSwitchedAt: NOW - 60 * MIN }), { pauseTeam: 'auth', next: mark('retry') }, 'auth with the switch before the run: the team pauses, retry after resume')
  // Row: auth / billing.
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'billing' } }), { pauseTeam: 'billing', next: mark('retry') }, 'billing: the team pauses, retry after resume')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'auth' }, provider: 'codex' }, { claudeSwitchedAt: NOW - 5 * MIN }), { pauseTeam: 'auth', next: mark('retry') }, 'a Codex auth failure is never a Claude switch')
  // Row: context.
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'context' } }), { freshSession: true, next: mark('context') }, 'context: a fresh session with the handoff, next context')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'context' }, trigger: { reason: 'context', by: 'system' } }), { freshSession: true, next: mark('retry', NOW + D.RETRY_DELAY_MS), counters: { retries: 1 } }, 'a fresh session that ran out of context again falls to the request row')
  // Row: overloaded / request / unknown.
  for (const kind of ['overloaded', 'request', 'unknown']) {
    same(P({ state: 'failed', outcome: 'failed', failure: { kind } }), { next: mark('retry', NOW + D.RETRY_DELAY_MS), counters: { retries: 1 } }, `${kind}: one retry 2 min later`)
    same(P({ state: 'failed', outcome: 'failed', failure: { kind } }, { task: { counters: { retries: 1 } } }), { block: card('failure') }, `${kind} after the retry: blocked with the failure card`)
  }
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'unknown', code: 'timeout' } }), { block: card('timeout') }, 'timeout: blocked with the timeout card')
  same(P({ state: 'failed', outcome: 'failed', failure: undefined }), { next: mark('retry', NOW + D.RETRY_DELAY_MS), counters: { retries: 1 } }, 'a failed run without failure info is an unknown failure')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'request' }, reachedRunning: false }), { undeliver: true, next: mark('retry', NOW + D.RETRY_DELAY_MS), counters: { retries: 1 } }, 'a failure before running also hands back what it got')
  same(P({ ...lead, state: 'failed', outcome: 'failed', failure: { kind: 'overloaded' } }, { task: null }), { next: { agentId: 'lead', mode: 'lead', reason: 'retry', since: NOW, notBefore: NOW + D.RETRY_DELAY_MS } }, 'a task-less failure: one retry')
  same(P({ ...lead, state: 'failed', outcome: 'failed', failure: { kind: 'overloaded' }, trigger: { reason: 'retry', by: 'system' } }, { task: null }), {}, 'a task-less retry that fails again: nothing (no block without a task)')
  // Row: concluded -> counters reset.
  same(P({ outcome: 'concluded', concludedBy: { tool: 'review', at: NOW - 1 } }, { task: { counters: { noProgress: 2, continuations: 1, retries: 1, interrupts: 1, unblockWakes: 2 } } }), { counters: { noProgress: 0, continuations: 0, retries: 0, interrupts: 0 } }, 'concluded: the run counters reset (unblock wakes kept), no follow-up')
  same(P({ outcome: 'concluded', concludedBy: { tool: 'review', at: NOW - 1 } }), {}, 'concluded with clean counters: nothing')
  // Row: lead or free, not concluded -> nothing.
  same(P({ ...lead, outcome: 'empty' }, { task: null }), {}, 'a lead run that answered in text: nothing')
  same(P({ agentId: 'dev', taskId: undefined, sessionKey: 'free', mode: 'free', outcome: 'progress' }, { task: null }), {}, 'a free run: nothing')
  // Row: qa without a verdict.
  const qa = { agentId: 'qa', roleKind: 'qa', mode: 'qa', outcome: 'progress' }
  const qaTask = { phase: 'qa', state: 'review' }
  same(P(qa, { task: qaTask }), { next: { agentId: 'qa', mode: 'qa', reason: 'continuation', since: NOW }, counters: { continuations: 1 } }, 'QA without a verdict: one continuation')
  same(P(qa, { task: { ...qaTask, counters: { continuations: 1 } } }), { block: card('qaNoVerdict') }, 'QA without a verdict again: blocked with qaNoVerdict')
  // Row: progress.
  same(P({}), { next: mark('continuation'), counters: { continuations: 1, noProgress: 0 } }, 'progress: one continuation (CONTINUATIONS_MAX = 1)')
  same(P({}, { task: { counters: { continuations: 1 } } }), { block: card('noProgress') }, 'progress at the second time: blocked with noProgress')
  // Row: planOnly / empty: cooldowns 5, 10 and 20 min, the 4th blocks (decision 32, NO_PROGRESS_BLOCK_AT = 4).
  check(D.NO_PROGRESS_BLOCK_AT === 4 && JSON.stringify(D.NO_PROGRESS_COOLDOWN_MIN) === '[5,10,20]', 'decision 32 constants')
  for (const [n, min] of [[0, 5], [1, 10], [2, 20]]) {
    for (const outcome of ['planOnly', 'empty']) {
      same(P({ outcome }, { task: { counters: { noProgress: n } } }), { cooldownUntil: NOW + min * MIN, next: mark('continuation', NOW + min * MIN), counters: { noProgress: n + 1 } }, `${outcome} #${n + 1}: cooldown ${min} min`)
    }
  }
  same(P({ outcome: 'empty' }, { task: { counters: { noProgress: 3 } } }), { block: card('noProgress') }, 'no progress the 4th time: blocked')
  // Row: task gone, done or cancelled -> only the provider rows.
  same(P({ outcome: 'progress' }, { task: null }), {}, 'task gone: nothing')
  same(P({ outcome: 'empty' }, { task: { state: 'done', phase: 'none' } }), {}, 'task done: nothing')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'limit', until: NOW + 30 * MIN } }, { task: { state: 'cancelled', phase: 'none' } }), { providerBlock: { provider: 'claude', until: NOW + 30 * MIN } }, 'task cancelled: the provider block only')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'overloaded' } }, { task: { state: 'blocked', phase: 'executing' } }), {}, 'task blocked meanwhile: no retry')
  same(P({ outcome: 'progress', mode: 'plan' }, { task: { phase: 'planApproval' } }), {}, 'task out of the run\'s phase: no follow-up')

  // Row (2.7.0 runtime fixes, orchestrator decision): the run's denials left its permission approval pending, so the task
  // waits on the user: no continuation, no retry, no count and no block; the provider rows still hold.
  const wait = { permissionWait: true }
  same(P(qa, { task: { ...qaTask, counters: { continuations: 1 } }, ...wait }), {}, 'a QA run without a verdict at its continuation, waiting on a permission: no qaNoVerdict block')
  same(P(qa, { task: qaTask, ...wait }), {}, 'a first QA run waiting on a permission: no continuation, continuations not counted')
  same(P({}, wait), {}, 'progress waiting on a permission: no continuation')
  same(P({}, { task: { counters: { continuations: 1 } }, ...wait }), {}, 'progress at the second time waiting on a permission: no noProgress block')
  for (const outcome of ['planOnly', 'empty']) same(P({ outcome }, { task: { counters: { noProgress: 2 } }, ...wait }), {}, `${outcome} waiting on a permission: no cooldown, no count`)
  same(P({ outcome: 'empty' }, { task: { counters: { noProgress: 3 } }, ...wait }), {}, 'the 4th no progress waiting on a permission: no block')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'request' } }, wait), {}, 'a failure waiting on a permission: no retry (the decision wakes it)')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'unknown', code: 'timeout' } }, wait), {}, 'a timeout waiting on a permission: no timeout block')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'limit', until: NOW + 30 * MIN } }, wait), { providerBlock: { provider: 'claude', until: NOW + 30 * MIN } }, 'a limit waiting on a permission: the provider block, no retry wake')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'billing' } }, wait), { pauseTeam: 'billing' }, 'billing waiting on a permission: the team pauses, no retry wake')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'context' } }, wait), { freshSession: true }, 'a full context waiting on a permission: the decision wakes a fresh session')
  same(P({ state: 'failed', outcome: 'failed', failure: { kind: 'request' } }, { unknownSession: true, ...wait }), { freshSession: true }, 'an unknown session waiting on a permission: a fresh session, no context wake')
  same(P({ outcome: 'concluded', concludedBy: { tool: 'verdict', at: NOW - 1 } }, { task: { counters: { continuations: 1 } }, ...wait }), { counters: { noProgress: 0, continuations: 0, retries: 0, interrupts: 0 } }, 'a concluded run never waits (its counters reset)')
  check(P({ state: 'cancelled', stopReason: 'user', outcome: undefined }, wait).block?.reason.kind === 'stopped', 'a user stop keeps its own row (blocked {stopped})')
  same(P({ state: 'interrupted', interruptCause: 'shutdown', stopReason: 'shutdown', outcome: undefined }, wait), { next: mark('interrupted'), counters: { interrupts: 1 } }, 'an interruption keeps its own row')
  same(P({ agentId: 'dev', taskId: undefined, sessionKey: 'free', mode: 'free', outcome: 'progress' }, { task: null, ...wait }), {}, 'a free run: nothing either way')
}

/** Pure and total: a deep-frozen runtime and facts go through untouched, and a full board stays one linear pass. */
function purityChecks() {
  const freeze = (o) => {
    if (o && typeof o === 'object' && !(o instanceof Set) && !Object.isFrozen(o)) {
      Object.freeze(o)
      for (const v of Object.values(o)) freeze(v)
    }
    return o
  }
  const r = rt({
    autoDispatch: false,
    tasks: [task(1, { assignee: 'dev' }), task(2, { state: 'doing', phase: 'executing', assignee: 'dev-2', next: { agentId: 'dev-2', mode: 'exec', reason: 'changes', since: NOW - 1, refs: ['k-1'] } }), task(3)],
    comments: { lead: [comment(1, 'lead', { forAgent: 'lead' })], 't-2': [comment(2, 't-2', { forAgent: 'dev-2' })] },
    queue: [{ id: 'q-1', agentId: 'dev', sessionKey: 't-1', taskId: 't-1', mode: 'exec', reason: 'assigned', createdAt: NOW - 1, approvedAt: NOW - 1 }],
    approvals: [{ id: 'a-1', taskId: 't-2', kind: 'plan', state: 'pending', decider: 'lead', createdAt: NOW - 1, createdBy: { kind: 'system' }, payload: { planRev: 1, small: true } }],
  })
  const before = JSON.stringify(r)
  freeze(r)
  const f = freeze(facts({ manual: [{ agentId: 'research', reason: 'manual', detail: 'Mirá esto' }], cwdKeys: { 't-1': 'a', 't-2': 'b', lead: 'root', free: 'root' } }))
  const p = D.planDispatch(r, freeze(def()), GOAL, f)
  check(JSON.stringify(r) === before && p.start.length + p.deferred.length === 4, 'planDispatch leaves a deep-frozen runtime untouched')
  const d = D.afterRunPolicy(freeze(endFacts({}, {})))
  check(d.next && d.next.reason === 'continuation', 'afterRunPolicy reads deep-frozen facts')
  // TEAM_TASKS_MAX tasks, 200 queued comments: the same answer as a small board, no quadratic step (no timing asserted).
  const tasks = Array.from({ length: 2000 }, (_, k) => task(k + 1, { assignee: ['dev', 'dev-2', 'research'][k % 3], priority: ['urgent', 'high', 'normal', 'low'][k % 4] }))
  const comments = { 't-5': Array.from({ length: 200 }, (_, k) => comment(k + 1, 't-5', { forAgent: 'dev-2' })) }
  const big = D.planDispatch(rt({ tasks, comments }), DEF, GOAL, facts())
  same(big.start.map((x) => [x.agentId, x.taskId]), [['dev', 't-1'], ['dev-2', 't-5'], ['research', 't-9']], 'a full board: each agent its most urgent, oldest task')
}

function main() {
  candidateChecks()
  gateChecks()
  unblockAndQuotaChecks()
  outcomeChecks()
  policyChecks()
  purityChecks()
  console.log(`PASS: ${checks} teams dispatch checks (candidates, gates G1..G6 and autonomy, caps, nextAt, unblock, claudeAllLimited, classifyOutcome, afterRunPolicy)`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
