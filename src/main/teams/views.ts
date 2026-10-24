/**
 * Views of the team runtime (app 2.7.0, E10 B, design 3.9): what the renderer
 * and the phone get, never the raw runtime. B1 builds the list row, the team
 * header and the "Te necesita" input; each later milestone adds its views
 * here (agents B2, board B3, queue B4, needs B5, routines B7, takeover B9).
 */
import { basename } from 'path'
import { TEAM_DIR } from '@shared/teamDefinition'
import { teamNeedsCount, type TeamNeedsInput } from '@shared/teamNeeds'
import { diffTeamFiles } from '@shared/teamDiff'
import type {
  ApprovalView,
  CardView,
  QueueItemView,
  RoleSummary,
  TeamListItem,
  TeamTakeoverRef,
  TeamTrustState,
  TeamView,
} from '@shared/team-protocol'
import {
  REPO_MAIN,
  TEAM_MAX_CONCURRENT,
  type Actor,
  type DefError,
  type QueueItem,
  type RoleDefinition,
  type TeamApproval,
  type TeamCard,
  type TeamDefinition,
  type TeamRuntime,
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

export function approvalView(rt: Readonly<TeamRuntime>, a: TeamApproval, trusted: TrustedDefinition | null): ApprovalView {
  const base = { id: a.id, state: a.state, decider: a.decider, requestedBy: actorLabel(a.createdBy), at: a.createdAt }
  let payload: ApprovalView['payload']
  switch (a.kind) {
    case 'plan': {
      const plan = rt.tasks.find((t) => t.id === a.taskId)?.plan
      payload = { kind: 'plan', planRev: a.payload.planRev, small: a.payload.small, text: plan && plan.rev === a.payload.planRev ? plan.text : '' }
      break
    }
    case 'final':
      payload = { kind: 'final', summary: a.payload.summary }
      break
    case 'hire': {
      // B5 completes the risks; the diff is of the role file against the trusted snapshot.
      const rel = `roles/${a.payload.roleId}.md`
      const before = (trusted?.files ?? []).filter((f) => f.rel === rel)
      const diff = diffTeamFiles(before, [{ rel, text: a.payload.text }])[0] ?? { rel, status: 'changed' as const, hunks: [], add: 0, del: 0 }
      payload = { kind: 'hire', roleId: a.payload.roleId, diff, risks: [] }
      break
    }
    case 'permission':
      payload = { kind: 'permission', roleId: a.payload.roleId, tools: [...a.payload.tools] }
      break
    case 'integrate': {
      const err = rt.tasks.find((t) => t.id === a.taskId)?.integrate?.error
      payload = { kind: 'integrate', branch: a.payload.branch, base: a.payload.base }
      if (err) payload.lastError = err
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

export function queueItemView(rt: Readonly<TeamRuntime>, q: QueueItem): QueueItemView {
  const task = q.taskId ? rt.tasks.find((t) => t.id === q.taskId) : undefined
  const out: QueueItemView = { id: q.id, agentId: q.agentId, reason: q.reason, mode: q.mode, priority: task?.priority ?? 'normal', at: q.createdAt, approved: q.approvedAt !== undefined }
  if (q.taskId) out.taskId = q.taskId
  return out
}

/** The input of the one "Te necesita" rule (decision 30) for a team. */
export function needsInputOf(rt: Readonly<TeamRuntime>, trust: TeamTrustState, trustSince: number | undefined, trusted: TrustedDefinition | null): TeamNeedsInput {
  const input: TeamNeedsInput = {
    trust,
    paused: rt.paused,
    approvals: rt.approvals.filter((a) => a.state === 'pending' || a.state === 'applying').map((a) => approvalView(rt, a, trusted)),
    cards: rt.cards.filter((c) => c.state === 'open').map(cardView),
    queue: rt.queue.map((q) => queueItemView(rt, q)),
  }
  if (trustSince !== undefined) input.trustSince = trustSince
  return input
}

function takeoversOf(rt: Readonly<TeamRuntime>, def: TeamDefinition | null): TeamTakeoverRef[] {
  const out: TeamTakeoverRef[] = []
  for (const a of rt.agents) {
    const t = a.takeover
    if (!t || (t.phase !== 'bound' && t.phase !== 'releasing')) continue
    const ref: TeamTakeoverRef = { paneId: t.paneId, agentId: a.id, agentName: agentName(rt, def, a.id), at: t.at }
    if (t.sessionKey.startsWith('t-')) ref.taskId = t.sessionKey
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
    running: rt.activeRuns.length,
    needsCount: teamNeedsCount(needsInputOf(rt, rec.trust, rec.trustSince, trusted)),
    rev: rt.rev,
    repoRoot: rec.entry.repoRoot,
    takeovers: takeoversOf(rt, def),
  }
  if (rt.workspaceId) out.workspaceId = rt.workspaceId
  return out
}

/** The team header and the definition summary of the overlay. */
export function teamView(rec: TeamRecord, def: TeamDefinition | null, trusted: TrustedDefinition | null): TeamView {
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
    running: rt.activeRuns.length,
    providerBlockedUntil: { ...rt.providerBlockedUntil },
  }
  if (rt.workspaceId) out.workspaceId = rt.workspaceId
  return out
}
