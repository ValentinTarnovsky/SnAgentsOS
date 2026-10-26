/**
 * Views of the team runtime (app 2.7.0, E10 B, design 3.9): what the renderer
 * and the phone get, never the raw runtime. B1 builds the list row, the team
 * header and the "Te necesita" input; each later milestone adds its views
 * here (agents B2, board B3, queue B4, needs B5, routines B7, takeover B9).
 * B7: the silence of a live run (quiet, stalled) is TeamService memory, read
 * through a `silence` callback like the live `lastLineAt`.
 * B5: the full approval bodies (the plan text, the hire diff from the
 * canonical text and its risk flags), light ones for every count, and no
 * view shows or counts an approval, card or queue item of a task that is over.
 */
import { basename } from 'path'
import { isGrantable } from '@shared/teamArgv'
import { normalizeDefText, parseDefinition, TEAM_DIR } from '@shared/teamDefinition'
import { needsOfTask, teamNeedsCount, teamNeedsRows, type TeamNeedRow, type TeamNeedsInput } from '@shared/teamNeeds'
import { diffTeamFiles, teamRiskFlags, type TeamFileDiff, type TeamRiskFlag } from '@shared/teamDiff'
import type { BoardSummary } from '@shared/teamPrompt'
import { TEAM_BOARD_PAGE } from '@shared/team-protocol'
import type {
  AgentView,
  ApprovalView,
  CardView,
  CommentView,
  LeadView,
  PlanView,
  QueueItemView,
  RoleSummary,
  RoutineView,
  RunView,
  TaskBlockedView,
  TaskDetail,
  TaskSummary,
  TeamBoardPage,
  TeamListItem,
  TeamNeedsView,
  TeamTakeoverRef,
  TeamTrustState,
  TeamView,
} from '@shared/team-protocol'
import type { PaneSilence, PaneUsage } from '@shared/types'
import {
  BOARD_COLUMNS,
  columnOf,
  DENIED_COMMAND_MAX,
  DENIED_COMMANDS_MAX,
  DIFF_STAT_TOP_MAX,
  LEAD_THREAD,
  PRIORITY_RANK,
  REPO_MAIN,
  TASK_ID_RE,
  TEAM_MAX_CONCURRENT,
  taskNumOf,
  type Actor,
  type AgentState,
  type BoardColumn,
  type DefError,
  type DeferInfo,
  type DispatchPlan,
  type QueueItem,
  type RoleDefinition,
  type RoutineDef,
  type RoutineState,
  type Run,
  type RunState,
  type TaskState,
  type TeamApproval,
  type TeamCard,
  type TeamComment,
  type TeamDefinition,
  type TeamRuntime,
  type TeamTask,
  type TrustedDefinition,
} from '@shared/teams'
import { agentIndex } from './flow/agents'
import type { TeamRecord } from './ops/types'
import type { LoadRes } from './TeamDefinitionLoader'
import { sha256Hex } from './TeamTrust'

/** 'user' | 'system' | the agent id. */
export function actorLabel(a: Actor): string {
  return a.kind === 'agent' ? a.agentId : a.kind
}

export function roleSummary(r: RoleDefinition): RoleSummary {
  const out: RoleSummary = { id: r.id, name: r.name, kind: r.kind, provider: r.provider, permission: r.permission, count: r.kind === 'lead' ? 1 : r.count }
  if (r.model) out.model = r.model
  if (r.effort) out.effort = r.effort
  return out
}

/** "Dev" for the first agent of a role, "Dev 2" for the next ones; the id when the role is gone. */
export function agentName(rt: Readonly<TeamRuntime>, def: TeamDefinition | null, agentId: string): string {
  const a = rt.agents.find((x) => x.id === agentId)
  if (!a) return agentId
  const role = def?.roles.find((r) => r.id === a.roleId)
  if (!role) return agentId
  const n = agentIndex(a)
  return n > 1 ? `${role.name} ${n}` : role.name
}

/**
 * Every problem of a load, each with its severity, in the order the screens list them: a folder that cannot be
 * read (`missing` is no problem: the trust state says it) or the parser's errors, then the unresolved extra repos,
 * then the warnings (a stray or misnamed file, `allowedTools` on a Codex role), which never block.
 */
export function loadIssues(loaded: LoadRes, repoIssues: readonly DefError[] = []): DefError[] {
  if ('error' in loaded) {
    return loaded.error === 'missing' ? [...repoIssues] : [{ file: TEAM_DIR, line: 0, code: loaded.error, severity: 'error' }, ...repoIssues]
  }
  const r = loaded.result
  return r.ok ? [...repoIssues, ...r.warnings] : [...r.errors, ...repoIssues, ...r.warnings]
}

/** Problems shown next to the definition (banner, header): loadIssues of the team's latest load. */
export function defIssuesOf(rec: TeamRecord): DefError[] {
  return loadIssues(rec.loaded, rec.repoIssues)
}

/**
 * The hire of a role as the user decides it (B5, design 4.3): the diff of `roles/<id>.md` against the trusted
 * snapshot, both sides as the canonical definition text main hashes and writes (normalizeDefText: no BOM, LF), never
 * stripped, so the renderer shows every hidden character (it escapes them); and the risk flags of the definition the
 * hire would make (teamRiskFlags of the trusted files plus the role), none when that definition does not parse.
 */
function hireBody(a: Extract<TeamApproval, { kind: 'hire' }>, trusted: TrustedDefinition | null): { diff: TeamFileDiff; risks: TeamRiskFlag[] } {
  const rel = `roles/${a.payload.roleId}.md`
  const text = normalizeDefText(a.payload.text)
  const files = trusted?.files ?? []
  const before = files.filter((f) => f.rel === rel).map((f) => ({ rel: f.rel, text: normalizeDefText(f.text) }))
  const diff = diffTeamFiles(before, [{ rel, text }])[0] ?? { rel, status: 'changed' as const, hunks: [], add: 0, del: 0 }
  let risks: TeamRiskFlag[] = []
  if (trusted) {
    const after = parseDefinition([...files.filter((f) => f.rel !== rel), { rel, text }])
    if (after.ok) risks = teamRiskFlags(trusted.def, after.def)
  }
  return { diff, risks }
}

/** The commits a task's branch has over its base as main last read them (TaskWorktrees.cachedLive); undefined when unknown. */
export type AheadOf = (taskId: string) => number | undefined

/**
 * One approval (design 2.4). `light`: what the "Te necesita" count reads (teamNeedsRows needs only the id, kind,
 * state, decider, time and task), without the plan text, the hire diff or its risks: the list row, the header and
 * every commit's header key build it, the needs op and the task drawer build the full one.
 */
export function approvalView(rt: Readonly<TeamRuntime>, a: TeamApproval, trusted: TrustedDefinition | null, o: { light?: boolean; ahead?: AheadOf } = {}): ApprovalView {
  // rev (B close): what a decide of a permission approval must carry back (it grows with each merge, permissionAsk).
  const base = { id: a.id, state: a.state, decider: a.decider, requestedBy: actorLabel(a.createdBy), at: a.createdAt, rev: a.kind === 'permission' ? a.rev ?? 1 : 1 }
  let payload: ApprovalView['payload']
  switch (a.kind) {
    case 'plan': {
      const plan = o.light ? undefined : rt.tasks.find((t) => t.id === a.taskId)?.plan
      payload = { kind: 'plan', planRev: a.payload.planRev, small: a.payload.small, text: plan && plan.rev === a.payload.planRev ? plan.text : '' }
      break
    }
    case 'final': {
      payload = { kind: 'final', summary: a.payload.summary }
      // B5: the diff stat the task's last QA run read (RunStarter); absent when none was computed.
      const stat = rt.tasks.find((t) => t.id === a.taskId)?.diffStat
      if (stat) payload.stat = { files: stat.files, insertions: stat.insertions, deletions: stat.deletions, top: stat.top.slice(0, DIFF_STAT_TOP_MAX).map((f) => ({ path: f.path, add: f.add, del: f.del })) }
      break
    }
    case 'hire': {
      const rel = `roles/${a.payload.roleId}.md`
      const body = o.light ? { diff: { rel, status: 'changed' as const, hunks: [], add: 0, del: 0 }, risks: [] } : hireBody(a, trusted)
      payload = { kind: 'hire', roleId: a.payload.roleId, diff: body.diff, risks: body.risks }
      break
    }
    case 'permission': {
      // Only the rules the policy still grants (isGrantable, B5 integration, fourth round): one an earlier build stored
      // that it now refuses is neither shown nor granted on Approve (decidePermission); with none left the approval
      // reads as nothing to grant and its Approve answers bad_request (`detail: 'nothingToGrant'`).
      payload = { kind: 'permission', roleId: a.payload.roleId, tools: a.payload.tools.filter(isGrantable) }
      // B5: the shell commands the run was denied (redacted when stored; the renderer escapes them).
      const denied = (a.payload.denied ?? []).slice(0, DENIED_COMMANDS_MAX).map((c) => c.slice(0, DENIED_COMMAND_MAX))
      if (denied.length) payload.denied = denied
      break
    }
    case 'integrate': {
      const last = rt.tasks.find((t) => t.id === a.taskId)?.integrate
      payload = { kind: 'integrate', branch: a.payload.branch, base: a.payload.base }
      // B6 review, second round: where the last attempt failed and how it was landing (the row words a timeout by them).
      if (last?.error) {
        payload.lastError = last.error
        if (last.step) payload.lastStep = last.step
        if (last.step === 'land' && last.landing) payload.lastLanding = last.landing
      }
      // B6 integration: the commits ahead as main last read them (the needs and task ops read them before this view).
      const ahead = a.taskId ? o.ahead?.(a.taskId) : undefined
      if (ahead !== undefined) payload.ahead = ahead
      break
    }
  }
  const out: ApprovalView = { ...base, payload }
  if (a.taskId) out.taskId = a.taskId
  if (a.error) out.error = a.error
  return out
}

export function cardView(c: TeamCard): CardView {
  const out: CardView = { id: c.id, kind: c.kind, state: c.state, at: c.createdAt }
  if (c.taskId) out.taskId = c.taskId
  if (c.from.kind === 'agent') {
    out.agentId = c.from.agentId
    out.question = c.question
    out.options = [...c.options]
    out.multi = c.multi
  } else {
    out.system = { why: c.from.why, actions: [...c.from.actions] }
    if (c.from.vars) out.system.vars = { ...c.from.vars }
  }
  if (c.answer) {
    const { by: _by, at: _at, ...answer } = c.answer
    out.answer = answer
  }
  return out
}

/** A "Por despachar" row; `defer` is why it would not start now (the dispatcher's dry run, B4), absent when nothing holds it. */
export function queueItemView(rt: Readonly<TeamRuntime>, q: QueueItem, defer?: DeferInfo): QueueItemView {
  const task = q.taskId ? rt.tasks.find((t) => t.id === q.taskId) : undefined
  const out: QueueItemView = { id: q.id, agentId: q.agentId, reason: q.reason, mode: q.mode, priority: task?.priority ?? 'normal', at: q.createdAt, approved: q.approvedAt !== undefined }
  if (q.taskId) out.taskId = q.taskId
  if (defer) out.defer = { ...defer }
  return out
}

/**
 * Why each agent's wanted run waits, from a dispatch dry run (AgentView.waiting, QueueItemView.defer): the
 * deferred request of every agent, keyed by agent id and by `agentId|sessionKey`.
 */
export function waitingOf(plan: DispatchPlan | null): { byAgent: Map<string, DeferInfo>; byKey: Map<string, DeferInfo> } {
  const byAgent = new Map<string, DeferInfo>()
  const byKey = new Map<string, DeferInfo>()
  for (const d of plan?.deferred ?? []) {
    const info: DeferInfo = { reason: d.reason }
    if (d.until !== undefined) info.until = d.until
    if (d.request.taskId) info.taskId = d.request.taskId
    if (!byAgent.has(d.request.agentId)) byAgent.set(d.request.agentId, info)
    byKey.set(`${d.request.agentId}|${d.request.sessionKey}`, info)
  }
  return { byAgent, byKey }
}

/** The defer reasons a dry run gives an agent's candidate that hold every level of that agent, not only that one. */
const AGENT_WIDE: ReadonlySet<DeferInfo['reason']> = new Set<DeferInfo['reason']>(['disabled', 'untrusted', 'cliOff', 'paused', 'agentPaused', 'teamCap', 'globalCap', 'quota', 'takenOver', 'running', 'stopping'])

/**
 * B close: what holds a queue item the dry run has no request for (planDispatch makes one per free agent, its
 * minimum): its agent's run (running, stopping), a takeover, or a reason of the agent's current candidate that holds
 * the whole agent (`byAgent`); else undefined (nothing but the user's OK holds it).
 */
function agentDefer(rt: Readonly<TeamRuntime>, q: QueueItem, byAgent: ReadonlyMap<string, DeferInfo> | undefined): DeferInfo | undefined {
  const agent = rt.agents.find((a) => a.id === q.agentId)
  if (!agent) return undefined
  const withTask = (d: DeferInfo): DeferInfo => (q.taskId ? { ...d, taskId: q.taskId } : d)
  if (agent.runId || agent.status === 'running') {
    const run = rt.activeRuns.find((r) => r.id === agent.runId)
    return withTask({ reason: run?.state === 'stopping' ? 'stopping' : 'running' })
  }
  if (agent.status === 'takenOver' || agent.takeover) return withTask({ reason: 'takenOver' })
  const d = byAgent?.get(agent.id)
  if (!d || !AGENT_WIDE.has(d.reason)) return undefined
  const out: DeferInfo = { reason: d.reason }
  if (d.until !== undefined) out.until = d.until
  return withTask(out)
}

/**
 * "Te necesita" of one team (design 2.4): the trust state, the pause, the pending approvals with their full bodies,
 * the open cards, the queue rows with their defer reason (B4), and the titles of the tasks the rows name. The same
 * rows as the count (needsInputOf): an approval, card or queue item of a task that is over is in neither. `ahead`:
 * the integrate rows' commits ahead (B6 integration, the needs op read them first). `byAgent` (B close): the dry
 * run's defer per agent, for a row whose own level has no request in it (agentDefer).
 */
export function needsView(rec: TeamRecord, trusted: TrustedDefinition | null, defer: ReadonlyMap<string, DeferInfo>, o: { ahead?: AheadOf; byAgent?: ReadonlyMap<string, DeferInfo> } = {}): TeamNeedsView {
  const rt = rec.store.rt
  const input = needsInputOf(rt, rec.trust, rec.trustSince, trusted, { full: true, ...(o.ahead ? { ahead: o.ahead } : {}) })
  const queue = rt.queue.filter((q) => openTask(rt, q.taskId)).map((q) => queueItemView(rt, q, defer.get(`${q.agentId}|${q.sessionKey}`) ?? agentDefer(rt, q, o.byAgent)))
  const tasks: TeamNeedsView['tasks'] = {}
  const ids = new Set<string>()
  for (const x of [...input.approvals, ...input.cards, ...queue]) if (x.taskId) ids.add(x.taskId)
  for (const t of rt.tasks) if (ids.has(t.id)) tasks[t.id] = { title: t.title, state: t.state, phase: t.phase }
  const out: TeamNeedsView = { teamId: rec.entry.id, rev: rt.rev, trust: rec.trust, paused: rt.paused, approvals: input.approvals, cards: input.cards, queue, tasks }
  if (rec.trustSince !== undefined) out.trustSince = rec.trustSince
  return out
}

/**
 * True unless `taskId` names a task that is over: done or cancelled, or archived (gone from the board). B5-flow's
 * reducers close the approvals and cards of a task that ends; the views never show or count one either way.
 */
export function openTask(rt: Readonly<TeamRuntime>, taskId: string | undefined): boolean {
  if (taskId === undefined) return true
  const state = stateOfLive(rt).get(taskId)
  return state !== undefined && state !== 'done' && state !== 'cancelled'
}

/** A pending (or applying) approval of a task that is not over: it waits for a decision. */
export function approvalWaits(rt: Readonly<TeamRuntime>, a: TeamApproval): boolean {
  return (a.state === 'pending' || a.state === 'applying') && openTask(rt, a.taskId)
}

/**
 * An open card of a task that is not over: it waits for an answer. An `orphan` card (decision 64) is about a process,
 * not its task: it waits until killOrphan or Descartar, whatever the task did since (closeTaskNeeds never closes it).
 */
export function cardWaits(rt: Readonly<TeamRuntime>, c: TeamCard): boolean {
  return c.state === 'open' && (openTask(rt, c.taskId) || (c.from.kind === 'system' && c.from.why === 'orphan'))
}

/**
 * The input of the one "Te necesita" rule (decision 30) for a team: the approvals that wait (light views unless
 * `full`), the open cards and the queue, none of a task that is over.
 */
export function needsInputOf(rt: Readonly<TeamRuntime>, trust: TeamTrustState, trustSince: number | undefined, trusted: TrustedDefinition | null, o: { full?: boolean; ahead?: AheadOf } = {}): TeamNeedsInput {
  const input: TeamNeedsInput = {
    trust,
    paused: rt.paused,
    approvals: rt.approvals.filter((a) => approvalWaits(rt, a)).map((a) => approvalView(rt, a, trusted, { light: !o.full, ...(o.ahead ? { ahead: o.ahead } : {}) })),
    cards: rt.cards.filter((c) => cardWaits(rt, c)).map(cardView),
    queue: rt.queue.filter((q) => openTask(rt, q.taskId)).map((q) => queueItemView(rt, q)),
  }
  if (trustSince !== undefined) input.trustSince = trustSince
  return input
}

/** The "Te necesita" rows of a team (the task cards count theirs from here). */
export function needsRowsOf(rec: TeamRecord, trusted: TrustedDefinition | null): TeamNeedRow[] {
  return teamNeedsRows(needsInputOf(rec.store.rt, rec.trust, rec.trustSince, trusted))
}

/**
 * B9: the consoles that hold an agent's session (bound, or releasing while Devolver kills it): the chip of each
 * console and its "Devolver al Equipo". A waiting takeover has no console yet and is not listed.
 */
function takeoversOf(rt: Readonly<TeamRuntime>, def: TeamDefinition | null): TeamTakeoverRef[] {
  const out: TeamTakeoverRef[] = []
  for (const a of rt.agents) {
    const t = a.takeover
    if (!t || (t.phase !== 'bound' && t.phase !== 'releasing')) continue
    const ref: TeamTakeoverRef = { paneId: t.paneId, agentId: a.id, agentName: agentName(rt, def, a.id), at: t.at }
    if (TASK_ID_RE.test(t.sessionKey)) ref.taskId = t.sessionKey
    out.push(ref)
  }
  return out
}

/** The sidebar row (and, minus the desktop fields, the phone Home card). */
export function teamListItem(rec: TeamRecord, def: TeamDefinition | null, trusted: TrustedDefinition | null): TeamListItem {
  const rt = rec.store.rt
  const out: TeamListItem = {
    id: rec.entry.id,
    name: def?.name ?? rec.entry.name,
    repoName: basename(rec.entry.repoRoot),
    trust: rec.trust,
    paused: rt.paused,
    autoDispatch: rt.autoDispatch,
    agents: rt.agents.filter((a) => !a.retired).length,
    running: liveRuns(rt),
    needsCount: teamNeedsCount(needsInputOf(rt, rec.trust, rec.trustSince, trusted)),
    rev: rt.rev,
    repoRoot: rec.entry.repoRoot,
    takeovers: takeoversOf(rt, def),
  }
  if (rt.workspaceId) out.workspaceId = rt.workspaceId
  return out
}

/** The team header and the definition summary of the overlay; `now` is the service clock (usageToday's day). */
export function teamView(rec: TeamRecord, def: TeamDefinition | null, trusted: TrustedDefinition | null, now: number): TeamView {
  const rt = rec.store.rt
  const confirmed = (repoId: string, command: string): boolean => {
    const c = rt.verifyConfirmed[repoId]
    return !!c && c.command === command && c.sha256 === sha256Hex(command)
  }
  const verify: TeamView['verify'] = []
  if (def?.verify) verify.push({ repoId: REPO_MAIN, command: def.verify, confirmed: confirmed(REPO_MAIN, def.verify) })
  const extraRepos: TeamView['extraRepos'] = []
  for (const x of def?.extraRepos ?? []) {
    const r = rec.repos.get(x.id)
    const resolved = r && 'repoRoot' in r ? r : null
    extraRepos.push({ id: x.id, name: basename(resolved?.repoRoot ?? x.path.replace(/[\\/]+$/, '')), baseBranch: resolved?.baseBranch ?? x.baseBranch ?? '' })
    if (x.verify) verify.push({ repoId: x.id, command: x.verify, confirmed: confirmed(x.id, x.verify) })
  }
  const out: TeamView = {
    id: rec.entry.id,
    name: def?.name ?? rec.entry.name,
    repoRoot: rec.entry.repoRoot,
    repoName: basename(rec.entry.repoRoot),
    baseBranch: def?.baseBranch ?? rec.entry.baseBranch,
    extraRepos,
    goal: def?.goal ?? '',
    trust: rec.trust,
    defIssues: defIssuesOf(rec),
    autoDispatch: rt.autoDispatch,
    paused: rt.paused,
    maxConcurrent: Math.min(def?.maxConcurrent ?? TEAM_MAX_CONCURRENT, TEAM_MAX_CONCURRENT),
    maxRunMinutes: def?.maxRunMinutes ?? 45,
    leadApprovesSmallPlans: def?.leadApprovesSmallPlans ?? true,
    verify,
    roles: (def?.roles ?? []).map(roleSummary),
    rev: rt.rev,
    needsCount: teamNeedsCount(needsInputOf(rt, rec.trust, rec.trustSince, trusted)),
    running: liveRuns(rt),
    providerBlockedUntil: { ...rt.providerBlockedUntil },
  }
  const usage = usageToday(rec.store.recentRuns(), now)
  if (usage) out.usageToday = usage
  if (rt.workspaceId) out.workspaceId = rt.workspaceId
  return out
}

/**
 * The TeamView fields a runtime commit can move, as one comparable key (rev
 * aside): TeamService adds the `team` scope to a commit that changes it, so
 * the header (running, usage today, provider limits, pause) and the Te
 * necesita count never go stale. The definition and trust fields move outside
 * the runtime and emit `team` where they change (defCheck, trust, setup).
 */
export function teamHeaderKey(rec: TeamRecord, trusted: TrustedDefinition | null, now: number): string {
  const rt = rec.store.rt
  return JSON.stringify([
    rt.paused ?? null,
    rt.autoDispatch,
    liveRuns(rt),
    teamNeedsCount(needsInputOf(rt, rec.trust, rec.trustSince, trusted)),
    rt.providerBlockedUntil,
    usageToday(rec.store.recentRuns(), now) ?? null,
    rt.workspaceId ?? null,
    rt.verifyConfirmed,
  ])
}

// ---- runs and agents (B2) ----------------------------------------------------------------------

/** States a process belongs to (the synthetic status, the close confirm, the running counts). */
export const LIVE_RUN_STATES: readonly RunState[] = ['starting', 'running', 'stopping']

/** Runs with a process: queued ones have none yet, so they never count as running. */
export function liveRuns(rt: Readonly<TeamRuntime>): number {
  return rt.activeRuns.filter((r) => LIVE_RUN_STATES.includes(r.state)).length
}

/** The usage fields of a run delta (RunUsage minus its basis), as the views carry it. */
function paneUsage(u: NonNullable<Run['usage']>): PaneUsage {
  const out: PaneUsage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, estimated: true }
  if (u.costUSD !== undefined) out.costUSD = u.costUSD
  if (u.unknownCost) out.unknownCost = true
  if (u.model) out.model = u.model
  return out
}

/** Sum of the run deltas that ended today (local day of `now`), estimated; undefined without any. */
export function usageToday(runs: readonly Run[], now: number): PaneUsage | undefined {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const from = day.getTime()
  let out: PaneUsage | undefined
  for (const r of runs) {
    if (!r.usage || (r.endedAt ?? 0) < from) continue
    const u = r.usage
    if (!out) out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: true }
    out.inputTokens += u.inputTokens
    out.outputTokens += u.outputTokens
    out.cacheReadTokens += u.cacheReadTokens
    out.cacheWriteTokens += u.cacheWriteTokens
    if (u.costUSD !== undefined) out.costUSD = (out.costUSD ?? 0) + u.costUSD
    if (u.unknownCost) out.unknownCost = true
  }
  return out
}

/**
 * A run as the renderer and the phone see it; `lastLineAt` is the live value while the process runs, `silence` (B7)
 * the run's silence while it runs (TeamService memory: quiet or stalled since its last line).
 */
export function runView(r: Run, live?: { lastLineAt?: number; silence?: PaneSilence }): RunView {
  const out: RunView = {
    id: r.id, agentId: r.agentId, roleId: r.roleId, taskId: r.taskId ?? null, mode: r.mode, trigger: r.trigger.reason,
    state: r.state, provider: r.provider, resumed: r.resumed, queuedAt: r.queuedAt,
  }
  if (r.outcome) out.outcome = r.outcome
  if (r.model) out.model = r.model
  if (r.effort) out.effort = r.effort
  if (r.startedAt !== undefined) out.startedAt = r.startedAt
  if (r.endedAt !== undefined) out.endedAt = r.endedAt
  const lastLineAt = live?.lastLineAt ?? r.lastLineAt
  if (lastLineAt !== undefined) out.lastLineAt = lastLineAt
  if (r.failure) out.failure = { ...r.failure }
  if (live?.silence) out.silence = { level: live.silence.level, since: live.silence.since }
  if (r.usage) out.usage = paneUsage(r.usage)
  if (r.context) out.context = { ...r.context }
  if (r.digest) out.digest = { ...r.digest, families: { ...r.digest.families }, files: [...r.digest.files] }
  if (r.summary) out.summary = r.summary
  if (r.concludedBy) out.concludedBy = r.concludedBy.tool
  return out
}

/**
 * One roster card: the agent, its role as the trusted definition names it,
 * the active run and the newest ended one. `lastLineAt` reads the live value
 * of the supervisor (never committed on every line, design 3.5). `waiting`
 * (B4): why its wanted run waits, from the dispatcher's dry run. `silenceOf`
 * (B7): the active run's silence (the roster's SilenceChip).
 */
export function agentView(
  rt: Readonly<TeamRuntime>,
  def: TeamDefinition | null,
  a: AgentState,
  recent: readonly Run[],
  lastLineAt: (runId: string) => number | undefined,
  waiting?: DeferInfo,
  silenceOf?: (runId: string) => PaneSilence | undefined,
): AgentView {
  const role = def?.roles.find((r) => r.id === a.roleId)
  const out: AgentView = {
    id: a.id, roleId: a.roleId, roleName: role?.name ?? a.roleId, kind: a.roleKind, index: agentIndex(a),
    provider: a.provider, permission: role?.permission ?? 'readonly', status: a.status, paused: a.paused, retired: !!a.retired,
  }
  if (role?.model) out.model = role.model
  if (role?.effort) out.effort = role.effort
  const active = a.runId ? rt.activeRuns.find((r) => r.id === a.runId) : undefined
  if (active) {
    out.run = runView(active, { lastLineAt: lastLineAt(active.id), silence: silenceOf?.(active.id) })
    if (active.taskId) out.taskId = active.taskId
  }
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].agentId === a.id) {
      out.lastRun = runView(recent[i])
      break
    }
  }
  const ctx = out.run?.context ?? out.lastRun?.context
  if (ctx) out.context = { ...ctx }
  if (waiting && !active) out.waiting = { ...waiting }
  // B9: a takeover (its phase; the console once bound, "Ir a la consola"); a held one names the task its session is of
  // (the card reads "En una consola" on that task, no run is active).
  const t = a.takeover
  if (t) {
    out.takeover = { phase: t.phase, at: t.at }
    if (t.phase === 'bound' || t.phase === 'releasing') out.takeover.paneId = t.paneId
    if (!active && t.phase !== 'stopping' && TASK_ID_RE.test(t.sessionKey)) out.taskId = t.sessionKey
  }
  return out
}

// ---- board, tasks, comments and the Lead thread (B3) --------------------------------------------

/** Comments a task view carries per page (the CLI's `team task get` asks 30). */
export const TASK_COMMENTS_PAGE = 50
/** Newest done (and cancelled) tasks of the desktop board page; `board {column:'done', cursor}` pages more. */
export const BOARD_DONE_PAGE = 100
/** Messages of the Lead thread per page. */
export const LEAD_PAGE = 50
/** Runs a task view lists, newest first. */
export const TASK_RUNS_MAX = 10

/** What the task views read besides the runtime. */
export interface TaskViewCtx {
  def: TeamDefinition | null
  /** teamNeedsRows of the team (needsRowsOf): a card counts its own rows. */
  needs: readonly TeamNeedRow[]
  /** Comments of a target already moved to archive/<target>.jsonl. */
  archived?: (target: string) => number
  /** B7: a live run's silence (the task card's SilenceChip and the drawer's runs). */
  silence?: (runId: string) => PaneSilence | undefined
}

/** Priority band, then createdAt, then the numeric id: the order of every task list (teamBoard.ts compareTasks). */
export function compareTaskOrder(a: Pick<TeamTask, 'id' | 'priority' | 'createdAt'>, b: Pick<TeamTask, 'id' | 'priority' | 'createdAt'>): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt || (taskNumOf(a.id) ?? 0) - (taskNumOf(b.id) ?? 0)
}

/** The number of a comment id (`m-12` -> 12), null for anything else. */
export function commentNumOf(id: string): number | null {
  const m = /^m-([0-9]{1,7})$/.exec(id)
  return m ? Number(m[1]) : null
}

/** Not yet delivered to its recipient (4.5). */
export function isQueued(c: TeamComment): boolean {
  return c.forAgent !== undefined && c.deliveredRunId === undefined
}

export function commentView(rt: Readonly<TeamRuntime>, def: TeamDefinition | null, c: TeamComment): CommentView {
  const author = actorLabel(c.author)
  const out: CommentView = {
    id: c.id,
    author,
    authorName: c.author.kind === 'agent' ? agentName(rt, def, c.author.agentId) : author,
    kind: c.kind,
    text: c.sys ? '' : c.text,
    at: c.at,
    queued: isQueued(c),
  }
  // The recipient fixed at write time (4.5), never the task's assignee now: "Queued for X" stays true after a reassignment.
  if (c.forAgent !== undefined) {
    out.recipient = c.forAgent
    out.recipientName = agentName(rt, def, c.forAgent)
  }
  if (c.sys) out.sys = c.sys.vars ? { key: c.sys.key, vars: { ...c.sys.vars } } : { key: c.sys.key }
  return out
}

/**
 * The newest `limit` comments of a target before the comment id `before`
 * (oldest first), and the cursor of the page before it (null at the start of
 * what the runtime holds; older ones live in the archive).
 */
export function commentPage(rt: Readonly<TeamRuntime>, def: TeamDefinition | null, target: string, o: { before?: number; limit?: number } = {}): { comments: CommentView[]; cursor: string | null } {
  const list = rt.comments[target] ?? []
  const limit = o.limit ?? TASK_COMMENTS_PAGE
  let end = list.length
  if (o.before !== undefined) {
    const before = o.before
    end = 0
    while (end < list.length && (commentNumOf(list[end].id) ?? 0) < before) end++
  }
  const start = Math.max(0, end - limit)
  return { comments: list.slice(start, end).map((c) => commentView(rt, def, c)), cursor: start > 0 ? list[start].id : null }
}

/**
 * id -> state of the live tasks, built once per `rt.tasks` array: the runtime is copy on write, so a new board is a
 * new array. A page of 2000 cards with 1000 blocked{deps} reads it 1000 times, never rebuilds it per card.
 */
const liveStates = new WeakMap<readonly TeamTask[], ReadonlyMap<string, TaskState>>()

function stateOfLive(rt: Readonly<TeamRuntime>): ReadonlyMap<string, TaskState> {
  let m = liveStates.get(rt.tasks)
  if (!m) {
    m = new Map(rt.tasks.map((x) => [x.id, x.state]))
    liveStates.set(rt.tasks, m)
  }
  return m
}

function blockedView(rt: Readonly<TeamRuntime>, t: TeamTask): TaskBlockedView | undefined {
  if (!t.blocked) return undefined
  const r = t.blocked.reason
  const out: TaskBlockedView = { kind: r.kind }
  if (r.kind === 'card') {
    out.why = r.why
    // A block whose card id was never filled (applyPolicy found no card) names none: the drawer falls back to `why`.
    if (r.cardId) out.cardId = r.cardId
  }
  if (r.kind === 'user') {
    if (r.text) out.text = r.text
    out.by = r.by ?? 'user'
  }
  if (r.kind === 'deps') {
    const states = stateOfLive(rt)
    out.waitingOn = t.blockedBy.filter((b) => (states.get(b) ?? rt.archivedTasks[b]) !== 'done')
  }
  return out
}

/** One board card (design 2.4): the counts of its comments and needs, its active run. */
export function taskSummary(rt: Readonly<TeamRuntime>, t: TeamTask, v: TaskViewCtx): TaskSummary {
  const list = rt.comments[t.id] ?? []
  const out: TaskSummary = {
    id: t.id, rev: t.rev, title: t.title, state: t.state, phase: t.phase, column: columnOf(t), priority: t.priority,
    repoId: t.repoId, isolation: t.isolation, needsPlan: t.needsPlan, blockedBy: [...t.blockedBy],
    createdBy: actorLabel(t.createdBy), createdAt: t.createdAt, updatedAt: t.updatedAt, stateSince: t.stateSince,
    userOwned: [...t.userOwned],
    needs: needsOfTask(v.needs, t.id).length,
    comments: list.length + (v.archived?.(t.id) ?? 0),
    queued: list.filter(isQueued).length,
  }
  if (t.assignee) out.assignee = t.assignee
  const blocked = blockedView(rt, t)
  if (blocked) out.blocked = blocked
  if (t.parentId) out.parentId = t.parentId
  if (t.review.round > 0 || t.phase === 'qa') {
    out.review = { round: t.review.round, max: t.review.max }
    if (t.review.qaAgentId) out.review.qaAgentId = t.review.qaAgentId
  }
  if (t.worktree) out.branch = t.worktree.branch
  if (t.integrated) out.integrated = true
  const run = rt.activeRuns.find((r) => r.taskId === t.id)
  if (run) {
    out.run = { id: run.id, agentId: run.agentId, mode: run.mode, state: run.state }
    if (run.startedAt !== undefined) out.run.startedAt = run.startedAt
    const silence = v.silence?.(run.id)
    if (silence) out.run.silence = { level: silence.level, since: silence.since }
  }
  return out
}

function planView(t: TeamTask): PlanView | undefined {
  const p = t.plan
  if (!p) return undefined
  const out: PlanView = { rev: p.rev, text: p.text, status: p.status, small: p.small, at: p.at }
  if (p.decidedBy) out.decidedBy = p.decidedBy.kind === 'agent' ? 'lead' : 'user'
  return out
}

/**
 * The task drawer (and `team task get`): body, plan, the comment page, the
 * newest runs, its approvals and cards. `recent` is the runs ring; `lastLineAt`
 * the live value of a running run; `worktree` the tree as main last read it
 * (B6 integration: exists, ahead, behind; without one the tree reads as there).
 */
export function taskDetail(
  rt: Readonly<TeamRuntime>,
  t: TeamTask,
  v: TaskViewCtx & {
    trusted: TrustedDefinition | null; recent: readonly Run[]; lastLineAt?: (runId: string) => number | undefined; commentsBefore?: number; commentsLimit?: number
    worktree?: { exists: boolean; ahead?: number; behind?: number } | null
  },
): TaskDetail {
  const { comments: _count, ...summary } = taskSummary(rt, t, v)
  const page = commentPage(rt, v.def, t.id, { before: v.commentsBefore, limit: v.commentsLimit })
  const runs: RunView[] = []
  const seen = new Set<string>()
  for (const r of [...rt.activeRuns, ...[...v.recent].reverse()]) {
    if (r.taskId !== t.id || seen.has(r.id)) continue
    seen.add(r.id)
    runs.push(runView(r, { lastLineAt: v.lastLineAt?.(r.id), silence: v.silence?.(r.id) }))
    if (runs.length >= TASK_RUNS_MAX) break
  }
  const reviewInfo: TaskDetail['reviewInfo'] = { round: t.review.round, max: t.review.max }
  if (t.review.lastVerdict) reviewInfo.lastVerdict = t.review.lastVerdict
  if (t.review.qaAgentId) reviewInfo.qaAgentId = t.review.qaAgentId
  const live = t.worktree ? v.worktree : null
  const ahead: AheadOf = (taskId) => (taskId === t.id ? live?.ahead : undefined)
  const out: TaskDetail = {
    ...summary,
    body: t.body,
    reviewInfo,
    comments: page.comments,
    commentsCursor: page.cursor,
    commentsArchived: v.archived?.(t.id) ?? 0,
    runs,
    // A task that is over shows its decided approvals and answered cards, never one still waiting (B5).
    approvals: rt.approvals.filter((a) => a.taskId === t.id && (approvalWaits(rt, a) || (a.state !== 'pending' && a.state !== 'applying'))).map((a) => approvalView(rt, a, v.trusted, { ahead })),
    cards: rt.cards.filter((c) => c.taskId === t.id && (cardWaits(rt, c) || c.state !== 'open')).map(cardView),
  }
  const plan = planView(t)
  if (plan) out.plan = plan
  if (t.worktree) {
    // The runtime only knows the tree was created: exists, ahead and behind are main's last read of it (the task op).
    out.worktree = { path: t.worktree.path, branch: t.worktree.branch, base: t.worktree.base, baseBranch: t.worktree.baseBranch, exists: live?.exists ?? true }
    if (live?.ahead !== undefined) out.worktree.ahead = live.ahead
    if (live?.behind !== undefined) out.worktree.behind = live.behind
  }
  // What the task's runs get (teamArgv filters task.grants through isGrantable): never a rule an earlier build stored
  // that the policy now refuses (fourth round), so `team task get` names no grant the run does not have.
  const grants = (t.grants ?? []).map((g) => g.tool).filter(isGrantable)
  if (grants.length) out.grants = grants
  if (t.integrate) out.integrate = { ...t.integrate, ...(t.integrate.files ? { files: [...t.integrate.files] } : {}) }
  if (t.integrated) out.integratedInfo = { ...t.integrated }
  return out
}

/** Done tasks page by recency (newest first), every other column in board order. */
function pageKey(t: TeamTask, column: BoardColumn | null): number[] {
  return column === 'done' || column === null ? [-t.stateSince, -(taskNumOf(t.id) ?? 0)] : [PRIORITY_RANK[t.priority], t.createdAt, taskNumOf(t.id) ?? 0]
}

function cmpKey(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * A board cursor names its column, then the key of the last task a page holds: `done.<stateSince>.<n>` or
 * `<column>.<rank>.<createdAt>.<n>` (`todo.2.1700000000000.5`), so a cursor of one column never pages another.
 */
function encodeCursor(t: TeamTask, column: BoardColumn): string {
  const n = taskNumOf(t.id) ?? 0
  return column === 'done' ? `done.${t.stateSince}.${n}` : `${column}.${PRIORITY_RANK[t.priority]}.${t.createdAt}.${n}`
}

/** The key of a cursor of `column`; null when it does not parse or belongs to another column (bad_request). */
function decodeCursor(cursor: string, column: BoardColumn): number[] | null {
  const parts = cursor.split('.')
  if (parts[0] !== column) return null
  const nums = parts.slice(1).map((p) => (/^[0-9]{1,16}$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => !Number.isSafeInteger(n))) return null
  if (column === 'done') return nums.length === 2 ? [-nums[0], -nums[1]] : null
  return nums.length === 3 ? nums : null
}

/**
 * The board (design 3.9): without a column, every live task that is not done
 * or cancelled plus the newest BOARD_DONE_PAGE done (the cursor pages the rest
 * with `column: 'done'`) and the newest BOARD_DONE_PAGE cancelled, in board
 * order (column, then compareTaskOrder). With a column, one page of it after
 * `cursor` (done newest first). Counts cover every live task. A cursor that
 * does not parse, or that another column minted -> null (bad_request).
 */
export function boardPage(rt: Readonly<TeamRuntime>, teamId: string, v: TaskViewCtx, q: { column?: BoardColumn; cursor?: string; limit?: number } = {}): TeamBoardPage | null {
  const counts = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, 0])) as Record<BoardColumn, number>
  let cancelled = 0
  for (const t of rt.tasks) {
    const c = columnOf(t)
    if (c) counts[c]++
    else cancelled++
  }
  const summary = (t: TeamTask): TaskSummary => taskSummary(rt, t, v)
  if (!q.column) {
    if (q.cursor !== undefined) return null
    const limit = q.limit ?? BOARD_DONE_PAGE
    const open = rt.tasks.filter((t) => t.state !== 'done' && t.state !== 'cancelled')
    const done = rt.tasks.filter((t) => t.state === 'done').sort((a, b) => cmpKey(pageKey(a, 'done'), pageKey(b, 'done')))
    const gone = rt.tasks.filter((t) => t.state === 'cancelled').sort((a, b) => cmpKey(pageKey(a, null), pageKey(b, null)))
    const doneShown = done.slice(0, limit)
    const rank = (t: TeamTask): number => {
      const c = columnOf(t)
      return c ? BOARD_COLUMNS.indexOf(c) : BOARD_COLUMNS.length
    }
    const tasks = [...open, ...doneShown, ...gone.slice(0, BOARD_DONE_PAGE)].sort((a, b) => rank(a) - rank(b) || compareTaskOrder(a, b))
    const more = done.length > doneShown.length
    return { teamId, rev: rt.rev, tasks: tasks.map(summary), cursor: more ? encodeCursor(doneShown[doneShown.length - 1], 'done') : null, done: !more, counts, cancelled }
  }
  const column = q.column
  const after = q.cursor !== undefined ? decodeCursor(q.cursor, column) : null
  if (q.cursor !== undefined && !after) return null
  const all = rt.tasks.filter((t) => columnOf(t) === column).sort((a, b) => cmpKey(pageKey(a, column), pageKey(b, column)))
  const rest = after ? all.filter((t) => cmpKey(pageKey(t, column), after) > 0) : all
  const limit = q.limit ?? (column === 'done' ? BOARD_DONE_PAGE : TEAM_BOARD_PAGE)
  const page = rest.slice(0, limit)
  const more = rest.length > page.length
  return { teamId, rev: rt.rev, tasks: page.map(summary), cursor: more ? encodeCursor(page[page.length - 1], column) : null, done: !more, counts, cancelled }
}

/** The Lead thread (newest LEAD_PAGE before `before`, oldest first) and the Lead's roster card. */
export function leadView(
  rt: Readonly<TeamRuntime>,
  def: TeamDefinition | null,
  o: { before?: number; recent: readonly Run[]; lastLineAt: (runId: string) => number | undefined; silence?: (runId: string) => PaneSilence | undefined },
): LeadView {
  const page = commentPage(rt, def, LEAD_THREAD, { before: o.before, limit: LEAD_PAGE })
  const lead = rt.agents.find((a) => a.roleKind === 'lead' && !a.retired) ?? rt.agents.find((a) => a.roleKind === 'lead')
  return { messages: page.comments, cursor: page.cursor, agent: lead ? agentView(rt, def, lead, o.recent, o.lastLineAt, undefined, o.silence) : null }
}

// ---- routines (B7) --------------------------------------------------------------------------------

/**
 * One routine of the definition (design 2.4, the read-only panel): `nextAt` is its armed deadline (null while it does
 * not run on its own: off in its file, the team not trusted, the lab off). `last`: the newest of its last fire (a
 * scheduled one, a catch-up or "Correr ahora", with the run or the task it made) and a due time it skipped because the
 * app was closed past ROUTINE_CATCHUP_MS (`skipped`).
 */
export function routineView(r: RoutineDef, s: RoutineState | undefined, nextAt: number | null): RoutineView {
  const out: RoutineView = { id: r.id, cron: r.cron, action: r.action, role: r.role, enabled: r.enabled, nextAt }
  if (r.title) out.title = r.title
  const fired = s?.lastFiredAt
  if (s?.skippedFor !== undefined && (fired === undefined || s.skippedFor > fired)) out.last = { at: s.skippedFor, skipped: true }
  else if (fired !== undefined) {
    out.last = { at: fired }
    if (s?.lastRunId) out.last.runId = s.lastRunId
    if (s?.lastTaskId && r.action === 'task') out.last.taskId = s.lastTaskId
  }
  return out
}

/**
 * The board as the Lead's stdin reads it (design 2.8): the open tasks in
 * board order (buildRunPrompt cuts the lowest priority first, before any
 * queued message of the Lead thread), the counts of
 * every state, the pending approvals, the unassigned todo tasks not triaged
 * yet and the roster.
 */
export function boardSummaryOf(rt: Readonly<TeamRuntime>): BoardSummary {
  const counts: Record<TaskState, number> = { todo: 0, doing: 0, review: 0, done: 0, blocked: 0, cancelled: 0 }
  for (const t of rt.tasks) counts[t.state]++
  const rows = rt.tasks
    .filter((t) => t.state !== 'done' && t.state !== 'cancelled')
    .sort(compareTaskOrder)
    .map((t) => {
      const row: BoardSummary['rows'][number] = { id: t.id, title: t.title, state: t.state, phase: t.phase, priority: t.priority, blockedBy: [...t.blockedBy] }
      if (t.assignee) row.assignee = t.assignee
      return row
    })
  // Never one of a task that is over (B5: the views hold even when a reducer left one open).
  const pendingApprovals = rt.approvals
    .filter((a) => a.state === 'pending' && openTask(rt, a.taskId))
    .map((a) => {
      const p: BoardSummary['pendingApprovals'][number] = { id: a.id, kind: a.kind }
      if (a.taskId) p.taskId = a.taskId
      if (a.kind === 'plan') p.small = a.payload.small
      return p
    })
  const untriaged = rt.tasks.filter((t) => t.state === 'todo' && !t.assignee && t.triagedAt === undefined).sort(compareTaskOrder).map((t) => t.id)
  const agents = rt.agents
    .filter((a) => !a.retired)
    .map((a) => {
      const row: BoardSummary['agents'][number] = { id: a.id, kind: a.roleKind, status: a.status }
      const run = a.runId ? rt.activeRuns.find((r) => r.id === a.runId) : undefined
      if (run?.taskId) row.taskId = run.taskId
      return row
    })
  return { rows, counts, pendingApprovals, untriaged, agents }
}
