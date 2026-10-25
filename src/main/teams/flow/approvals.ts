/**
 * Approvals, cards and permission asks (app 2.7.0, E10 B5, design 3.4, the
 * approval machine of 4.3 and the cards of 4.5). Pure, no Node imports, copy
 * on write.
 *
 * An approval is `pending` until the user decides it (the Lead may approve a
 * small plan it is the decider of, decision 29); deciding one that is not
 * pending answers `conflict {already_decided}` (a desktop and a phone click
 * race). A hire goes through `applying` (TeamService writes the role file and
 * trusts the folder, then completeApproval). An `integrate` approval is never
 * decided here: only the integrate op lands (decision 50). The phone refusals
 * (a hire decision, the DESKTOP_ONLY_CARD_ACTIONS) are checked again here.
 *
 * A permission ask (permissionAsk, from the run end) turns a run's denials
 * into ONE pending approval per task and role, with the `Bash(...)` rules
 * grantPatternOf returns and never a `PowerShell(...)` one (E10 SPIKE, B5):
 * a `:*` prefix rule only for a command of GRANT_PREFIX_ALLOWLIST (`npm
 * test`, `make all`, `git status`...), any other command as its exact rule
 * (the full command the user approves), never a rule with a word that is
 * not plain (B5 integration, third round) nor one that holds a credential or
 * a live token of the app (B5 review: redactCredentials and the run end's
 * mask would change it), and the denied shell commands behind them
 * (`denied`, masked and redacted). No approval comes from a denial the run's own
 * profile keeps denying (the edit tools of a readonly or plan run, the
 * protect rules of decision 72), from a rule the
 * run already allows, from a `snaos team` call (the run has
 * `Bash(snaos team:*)`: its next run gets TEAM_CALL_HINT instead), from a
 * shell or inline-code escape (`bash -c`, `node -e`: its next run gets
 * ESCAPE_HINT), from a Codex run (no allow list) or a total one (nothing to
 * allow).
 */
import { redactCredentials } from '@shared/redact'
import { CLAUDE_READONLY_ALLOW, CLAUDE_READONLY_DENY, CLAUDE_TEAM_TOOLS, grantPatternOf, isGrantable, isShellEscape } from '@shared/teamArgv'
import { normalizeDefText, parseDefinition, parseFrontmatter, serializeRole, validToolPattern } from '@shared/teamDefinition'
import {
  CARD_TEXT_ANSWER_MAX,
  DECIDE_NOTE_MAX,
  DENIED_COMMAND_MAX,
  DENIED_COMMANDS_MAX,
  DESKTOP_ONLY_CARD_ACTIONS,
  GRANTS_MAX,
  HIRE_TEXT_MAX,
  LEAD_THREAD,
  ROLE_ID_RE,
  type Actor,
  type AgentState,
  type CardAction,
  type CardAnswer,
  type DefError,
  type RoleDefinition,
  type Run,
  type RunMode,
  type TaskGrant,
  type TaskPhase,
  type TaskState,
  type TeamApproval,
  type TeamCard,
  type TeamRuntime,
  type TeamTask,
  type TrustedDefinition,
  type WakeMark,
} from '@shared/teams'
import { isTeamCall, type Denial } from '../parsers/types'
import { dismissPauseCards, reconcileAgents } from './agents'
import { phaseAgentOf, todoModeOf } from './dispatch'
import { requestStop } from './runs'
import { appendComment, closeTaskNeeds, depsOf, moveTask, resumeTask, updateTask } from './tasks'
import type { FlowCtx, FlowError, FlowResult, TeamEffect } from './types'

/** APPROVAL_ID_RE and CARD_ID_RE allow 7 digits. */
const APPROVAL_NUM_MAX = 9_999_999
/** C0 except tab and newline, and DEL: never inside a note or an answer (CR is normalized first). */
const BODY_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/
/** An approval's error text (completeApproval) is a short code from main, never agent text. */
const APPROVAL_ERROR_MAX = 200
/** Definition issues a refused hire carries back (its `current`). */
const HIRE_ISSUES_MAX = 20

/**
 * The next run of an agent whose `snaos team` call was denied through the PowerShell tool (or the `.cmd` name) gets
 * this line (the run end, flow/runs.ts): only `Bash(snaos team:*)` is on its allow list (E10 SPIKE, decision 2).
 */
export const TEAM_CALL_HINT =
  'Your last run tried to call `snaos team` through a tool or name that is not allowed. Call the team tools with your Bash tool, exactly as `snaos team ...`: the PowerShell tool and `snaos.cmd` stay denied in a team run.'

/**
 * The next run of an agent whose run was denied a shell or inline-code command (teamArgv isShellEscape: `bash -c`,
 * `cmd /c`, `env`, `xargs`, `node -e`, `python -c`...) gets this line (the run end, flow/runs.ts): no grant ever allows
 * one, so it opened no approval.
 */
export const ESCAPE_HINT =
  'Your last run was denied a command that starts a shell or runs inline code (bash -c, cmd /c, powershell, env, xargs, node -e, python -c and the like). A team run is never allowed one and no approval will change that: run the steps as plain commands, or, if only that command will do, ask the user to run it with `snaos team needs` and wait for the answer.'

type Fail = Extract<FlowResult, { ok: false }>

function fail(error: FlowError, extra: Omit<Fail, 'ok' | 'error'> = {}): Fail {
  return { ok: false, error, ...extra }
}

function replaceTask(tasks: readonly TeamTask[], t: TeamTask): TeamTask[] {
  return tasks.map((x) => (x.id === t.id ? t : x))
}

function replaceApproval(list: readonly TeamApproval[], a: TeamApproval): TeamApproval[] {
  return list.map((x) => (x.id === a.id ? a : x))
}

function replaceCard(list: readonly TeamCard[], c: TeamCard): TeamCard[] {
  return list.map((x) => (x.id === c.id ? c : x))
}

/** A user note or answer: CRLF and CR to LF, trimmed, within `max`, no control character but tab and newline; null when it is not one. */
function cleanUserText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\r\n?/g, '\n').trim()
  return s.length <= max && !BODY_BAD_RE.test(s) ? s : null
}

/** The run mode of a task-keyed phase (I3). */
const PHASE_MODE: Readonly<Partial<Record<TaskPhase, RunMode>>> = { planning: 'plan', executing: 'exec', qa: 'qa' }

/** The mode the task's current pair runs for its phase agent (todo: its plan or exec, T2 / T3); undefined when none runs. */
export function phaseModeOf(t: Pick<TeamTask, 'state' | 'phase' | 'needsPlan' | 'plan'>): RunMode | undefined {
  if (t.state === 'todo') return todoModeOf(t)
  if (t.state === 'doing' || t.state === 'review') return PHASE_MODE[t.phase]
  return undefined
}

/** A task moves to `state`/`phase`; a blocked one keeps its block and resumes to that pair instead (I6). */
function withPair(t: TeamTask, state: Exclude<TaskState, 'blocked'>, phase: TaskPhase, now: number): TeamTask {
  if (t.state === 'blocked' && t.blocked && state !== 'done' && state !== 'cancelled') {
    return { ...t, phase, blocked: { ...t.blocked, resume: { state, phase } }, updatedAt: now }
  }
  const out: TeamTask = { ...t, state, phase, updatedAt: now }
  if (t.state !== state) out.stateSince = now
  delete out.blocked
  return out
}

// ---- creating approvals ------------------------------------------------------------------------------

/** What a new approval carries (the id, state and time are added here). */
export type ApprovalSpec = TeamApproval extends infer A ? (A extends TeamApproval ? Omit<A, 'id' | 'state' | 'createdAt'> : never) : never

/** A new pending approval with the next id; `cap` past APPROVAL_ID_RE. */
export function addApproval(rt: TeamRuntime, spec: ApprovalSpec, ctx: Pick<FlowCtx, 'now'>): { ok: true; rt: TeamRuntime; id: string } | Fail {
  if (rt.nextIds.approval > APPROVAL_NUM_MAX) return fail('cap')
  const id = `a-${rt.nextIds.approval}`
  const a = { ...spec, id, state: 'pending', createdAt: ctx.now } as TeamApproval
  return { ok: true, rt: { ...rt, approvals: [...rt.approvals, a], nextIds: { ...rt.nextIds, approval: rt.nextIds.approval + 1 } }, id }
}

/** Cancels the pending approvals of one task and kind (a newer plan rev, a new final OK). */
export function cancelPending(rt: TeamRuntime, taskId: string, kind: TeamApproval['kind'], ctx: Pick<FlowCtx, 'now'>): TeamRuntime {
  if (!rt.approvals.some((a) => a.taskId === taskId && a.kind === kind && a.state === 'pending')) return rt
  return { ...rt, approvals: rt.approvals.map((a) => (a.taskId === taskId && a.kind === kind && a.state === 'pending' ? ({ ...a, state: 'cancelled', decidedAt: ctx.now } as TeamApproval) : a)) }
}

/** T7: the QA agent of a review: the task's own (sticky), else the first idle QA agent, else the first QA agent; null without a QA role. */
export function qaAgentFor(rt: TeamRuntime, task: Pick<TeamTask, 'review'>): AgentState | null {
  const qas = rt.agents.filter((a) => a.roleKind === 'qa' && !a.retired)
  if (qas.length === 0) return null
  const sticky = task.review.qaAgentId ? qas.find((a) => a.id === task.review.qaAgentId) : undefined
  return sticky ?? qas.find((a) => a.status === 'idle' && !a.paused && !a.takeover) ?? qas[0]
}

// ---- hire ---------------------------------------------------------------------------------------------

/** A role name as a role id: lowercase ASCII, accents dropped, other characters to `-`, a letter first, 22 at most. */
function roleIdOfName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 22)
    .replace(/-+$/, '')
}

export type HireRes =
  | { ok: true; roleId: string; role: RoleDefinition; text: string; replaces: boolean; files: Array<{ rel: string; text: string }> }
  | { ok: false; error: 'bad_request' | 'forbidden'; issues?: DefError[] }

/**
 * `team hire --file -`: a whole role file (frontmatter and instructions, the shape of `roles/<id>.md`) checked against
 * the trusted definition (4.3). The role id is an optional `id:` line of the frontmatter (taken out of the file),
 * else the role's `name` as an id (`Diseñador UX` -> `disenador-ux`). The folder with this file in place must parse
 * clean (one lead, the caps, the allowlists), and the file main writes is `serializeRole` of the parsed role (what the
 * user approves is exactly what is written; a comment line of the agent's text is not). Never the Lead's role, never a
 * second lead (forbidden); a hire that changes nothing is a bad request.
 */
export function hireOf(raw: unknown, def: TrustedDefinition): HireRes {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > HIRE_TEXT_MAX) return { ok: false, error: 'bad_request' }
  let text = normalizeDefText(raw)
  const fm = parseFrontmatter('roles/hire.md', text)
  if (!fm.ok) return { ok: false, error: 'bad_request', issues: [fm.error] }
  if (fm.fields.some((f) => f.key === 'kind' && f.value === 'lead')) return { ok: false, error: 'forbidden' }
  const idField = fm.fields.find((f) => f.key === 'id')
  let roleId: string
  if (idField) {
    roleId = idField.value
    const lines = text.split('\n')
    lines.splice(idField.line - 1, 1)
    text = lines.join('\n')
  } else roleId = roleIdOfName(fm.fields.find((f) => f.key === 'name')?.value ?? '')
  return hireCheck(roleId, text, def)
}

/**
 * The checks of hireOf for a role id already known: TeamService's apply runs it again on `payload.roleId` and
 * `payload.text` against the definition trusted now (4.3 "validate the role text with parseDefinition over the
 * trusted files plus it"); its `text` equals `payload.text` then, and `files` is the folder to write and trust
 * (`sha256(canonicalDefText(files))` is the hash the hire re-trusts).
 */
export function hireCheck(roleId: string, raw: string, def: TrustedDefinition): HireRes {
  if (typeof raw !== 'string' || raw.length > HIRE_TEXT_MAX || !ROLE_ID_RE.test(roleId)) return { ok: false, error: 'bad_request' }
  const text = normalizeDefText(raw)
  const leadId = def.def.roles.find((r) => r.kind === 'lead')?.id
  if (roleId === leadId) return { ok: false, error: 'forbidden' }
  const rel = `roles/${roleId}.md`
  const others = def.files.filter((f) => f.rel !== rel)
  const parsed = parseDefinition([...others, { rel, text }])
  if (!parsed.ok) return { ok: false, error: 'bad_request', issues: parsed.errors.slice(0, HIRE_ISSUES_MAX) }
  const role = parsed.def.roles.find((r) => r.id === roleId)
  if (!role) return { ok: false, error: 'bad_request' }
  if (role.kind === 'lead') return { ok: false, error: 'forbidden' }
  const canonical = serializeRole(role)
  const files = [...others, { rel, text: canonical }]
  // The text written must parse to the same role (serializeRole round trip).
  const again = parseDefinition(files)
  const back = again.ok ? again.def.roles.find((r) => r.id === roleId) : undefined
  if (!back || JSON.stringify(back) !== JSON.stringify(role)) return { ok: false, error: 'bad_request' }
  const before = def.files.find((f) => f.rel === rel)
  // The same role in other words (a comment line, another key order) changes nothing either: applying it would only
  // rewrite the user's file.
  const old = def.def.roles.find((r) => r.id === roleId)
  if (before && (normalizeDefText(before.text) === canonical || (old && JSON.stringify(old) === JSON.stringify(role)))) return { ok: false, error: 'bad_request' }
  return { ok: true, roleId, role, text: canonical, replaces: before !== undefined, files }
}

// ---- deciding approvals -------------------------------------------------------------------------------

/**
 * The system hint of a run the user's grant woke (RunStarter, PromptInput.hints, never WakeMark.detail nor a
 * `<request from="user">` block): the Bash rules it allows (a PowerShell denial is granted only as its Bash rule).
 */
export function grantHint(tools: readonly string[]): string | undefined {
  const bash = tools.filter((t) => t.startsWith('Bash('))
  if (bash.length === 0) return undefined
  return `The user allowed ${bash.join(', ')}. Run those commands with your Bash tool: through the PowerShell tool they stay denied.`
}

/**
 * The rules a run's wake refs grant it (RunStarter, for grantHint): the tools of each approved permission approval the
 * refs name, of the run's task and role, that the task's grants of that role still hold.
 */
export function grantedByRefs(rt: Pick<TeamRuntime, 'approvals' | 'tasks'>, run: Pick<Run, 'taskId' | 'roleId' | 'trigger'>): string[] {
  const refs = run.trigger.refs ?? []
  const task = run.taskId ? rt.tasks.find((t) => t.id === run.taskId) : undefined
  if (!task || refs.length === 0) return []
  const held = new Set((task.grants ?? []).filter((g) => g.roleId === run.roleId).map((g) => g.tool))
  const out: string[] = []
  for (const a of rt.approvals) {
    if (a.kind !== 'permission' || a.state !== 'approved' || !refs.includes(a.id) || a.taskId !== task.id || a.payload.roleId !== run.roleId) continue
    // A grant an earlier build stored that the policy now refuses never reaches the run's argv (teamArgv): nor its hint.
    for (const t of a.payload.tools) if (held.has(t) && isGrantable(t) && !out.includes(t)) out.push(t)
  }
  return out
}

/** T5 / T6 (4.3 plan). */
function decidePlan(rt: TeamRuntime, ap: Extract<TeamApproval, { kind: 'plan' }>, decided: TeamApproval, task: TeamTask, approve: boolean, note: string | undefined, actor: Actor, ctx: FlowCtx): FlowResult {
  if (task.phase !== 'planApproval' || !task.plan || task.plan.status !== 'pending' || task.plan.rev !== ap.payload.planRev) return fail('conflict', { reason: 'stale' })
  if (!approve && !note) return fail('bad_request')
  let t = withPair(task, 'doing', approve ? 'executing' : 'planning', ctx.now)
  t.plan = { ...task.plan, status: approve ? 'approved' : 'rejected', decidedBy: actor }
  if (task.assignee) {
    // T5: the same session runs the plan (decision 33, sysHash plan = exec); T6: a new plan run.
    t.next = { agentId: task.assignee, mode: approve ? 'exec' : 'plan', reason: approve ? 'planApproved' : 'planRejected', since: ctx.now }
  } else {
    t = { ...t }
    delete t.next
  }
  let out: TeamRuntime = { ...rt, approvals: replaceApproval(rt.approvals, decided), tasks: replaceTask(rt.tasks, t) }
  const effects: TeamEffect[] = [{ kind: 'dispatch' }]
  if (!approve && note) {
    const c = appendComment(out, { author: actor, target: task.id, kind: 'review', text: note, forAgent: task.assignee }, ctx)
    if (!c.ok) return c
    out = c.rt
    effects.push(...c.effects)
  }
  return { ok: true, rt: out, effects, result: undefined }
}

/** T11 / T12 (4.3 final). */
function decideFinal(rt: TeamRuntime, decided: TeamApproval, task: TeamTask, approve: boolean, note: string | undefined, actor: Actor, ctx: FlowCtx, ahead: number | undefined): FlowResult {
  if (task.phase !== 'userOk') return fail('conflict', { reason: 'stale' })
  if (!approve && !note) return fail('bad_request')
  let out: TeamRuntime = { ...rt, approvals: replaceApproval(rt.approvals, decided) }
  const effects: TeamEffect[] = [{ kind: 'dispatch' }]
  if (approve && task.worktree && ahead !== 0) {
    // T11 with something to merge: the Integrar step (only the integrate op lands it, with expectTip).
    const t = withPair(task, 'review', 'integrating', ctx.now)
    delete t.next
    out = { ...out, tasks: replaceTask(out.tasks, t) }
    const added = addApproval(out, { kind: 'integrate', taskId: task.id, decider: 'user', createdBy: { kind: 'system' }, payload: { branch: task.worktree.branch, base: task.worktree.baseBranch } }, ctx)
    if (!added.ok) return added
    return { ok: true, rt: added.rt, effects, result: undefined }
  }
  if (approve) {
    // T11 with nothing to merge (no worktree, or its branch is not ahead): done, and nothing of it stays open.
    const t = withPair(task, 'done', 'none', ctx.now)
    delete t.next
    delete t.cooldownUntil
    out = { ...out, tasks: replaceTask(out.tasks, t) }
    out = closeTaskNeeds(out, task.id, ctx, decided.id)
    return { ok: true, rt: out, effects, result: undefined }
  }
  // T12: back to the Dev with the note. A task that needs a plan and has none approved (research that closed from its
  // plan run, T10) goes back to planning with a plan wake, never to executing (T3: no exec without an approved plan).
  const mode = todoModeOf(task)
  const t = withPair(task, 'doing', mode === 'plan' ? 'planning' : 'executing', ctx.now)
  if (task.assignee) t.next = { agentId: task.assignee, mode, reason: 'finalRejected', since: ctx.now }
  else delete t.next
  out = { ...out, tasks: replaceTask(out.tasks, t) }
  const c = appendComment(out, { author: actor, target: task.id, kind: 'review', text: note as string, forAgent: task.assignee }, ctx)
  if (!c.ok) return c
  return { ok: true, rt: c.rt, effects: [...effects, ...c.effects], result: undefined }
}

/**
 * 4.3 permission: the rules join `task.grants` of that role (cap GRANTS_MAX; isGrantable again, so never a PowerShell
 * rule nor a prefix off GRANT_PREFIX_ALLOWLIST that an older version stored in the approval; an approve of an approval
 * with no rule left that isGrantable accepts answers `bad_request`, TeamService.decide adds `detail: 'nothingToGrant'`),
 * and the agent of the task's phase, when it is of that role and its run did not end waiting on the user (an open card
 * of that run), is woken with `grant` (cooldown bypassed: the user just allowed what stopped it). The wake names the
 * approval in its refs; the run it gets is told to use Bash by a system hint built from them (grantedByRefs), never
 * by text in the wake mark (`detail` is the user's request text only).
 */
function decidePermission(rt: TeamRuntime, ap: Extract<TeamApproval, { kind: 'permission' }>, decided: TeamApproval, task: TeamTask, approve: boolean, ctx: FlowCtx): FlowResult {
  let out: TeamRuntime = { ...rt, approvals: replaceApproval(rt.approvals, decided) }
  if (!approve) return { ok: true, rt: out, effects: [], result: undefined }
  // The view shows only these (approvalView): an approval whose every rule the policy now refuses grants nothing.
  const tools = ap.payload.tools.filter(isGrantable)
  if (tools.length === 0) return fail('bad_request')
  const roleId = ap.payload.roleId
  const grants: TaskGrant[] = [...(task.grants ?? [])]
  for (const tool of tools) {
    if (grants.some((g) => g.roleId === roleId && g.tool === tool)) continue
    if (grants.length >= GRANTS_MAX) break
    grants.push({ roleId, tool, at: ctx.now, approvalId: ap.id })
  }
  let t: TeamTask = { ...task, grants, updatedAt: ctx.now }
  const agentId = phaseAgentOf(task)
  const agent = agentId ? rt.agents.find((a) => a.id === agentId) : undefined
  const mode = phaseModeOf(task)
  const waitsOnUser = rt.cards.some((c) => c.state === 'open' && c.from.kind === 'agent' && c.from.runId === ap.payload.runId)
  if (agent && !agent.retired && agent.roleId === roleId && mode && task.state !== 'blocked' && !waitsOnUser) {
    const next: WakeMark = { agentId: agent.id, mode, reason: 'grant', since: ctx.now, refs: [ap.id], bypassCooldown: true }
    t = { ...t, next }
  }
  out = { ...out, tasks: replaceTask(out.tasks, t) }
  return { ok: true, rt: out, effects: [{ kind: 'dispatch' }], result: undefined }
}

/**
 * 4.3: the user (or the Lead, a small plan it decides) decides an approval. Not pending -> `conflict
 * {already_decided}`, but a hire cancelled for its stale base (cancelStaleHires) -> `conflict {stale}`; kind integrate
 * -> `bad_request` from every origin (only the integrate op lands, decision 50); a
 * hire from the phone -> `forbidden` (the op checks it first too). A plan or final reject needs a note (it goes to the
 * Dev as a review comment). A plan approve goes to executing with the same session (T5), a reject back to planning
 * (T6); a final approve integrates (T11; `f.ahead` 0 or no worktree: done) or a reject sends it back (T12: to
 * executing, or to planning with a plan wake when the task needs a plan and has none approved); a
 * permission approve grants and re-requests the run; a hire approve turns `applying` with the `applyHire` effect (its
 * definition base must still be the trusted one, else `conflict {stale}`), a reject leaves a `hireRejected` system
 * note in the Lead thread that wakes nobody.
 */
export function decideApproval(
  rt: TeamRuntime,
  actor: Actor,
  approvalId: string,
  decision: 'approve' | 'reject',
  note: string | undefined,
  ctx: FlowCtx,
  f?: { ahead?: number },
): FlowResult {
  const ap = rt.approvals.find((a) => a.id === approvalId)
  if (!ap) return fail('not_found')
  if (decision !== 'approve' && decision !== 'reject') return fail('bad_request')
  if (ap.kind === 'integrate') return fail('bad_request')
  // A hire cancelled for its stale base (cancelStaleHires) tells a decide that raced the cancel why.
  if (ap.kind === 'hire' && ap.state === 'cancelled' && ap.error === HIRE_STALE) return fail('conflict', { reason: 'stale' })
  if (ap.state !== 'pending') return fail('conflict', { reason: 'already_decided' })
  if (actor.kind === 'system') return fail('forbidden')
  if (actor.kind === 'user' && actor.via === 'phone' && ap.kind === 'hire') return fail('forbidden')
  if (actor.kind === 'agent') {
    // Only the Lead's `team approve --plan` (decision 29): a small plan it is the decider of, while the team allows it.
    if (actor.roleKind !== 'lead' || ap.kind !== 'plan' || decision !== 'approve' || ap.decider !== 'lead' || !ap.payload.small || !ctx.def.def.leadApprovesSmallPlans) return fail('forbidden')
  }
  let clean: string | undefined
  if (note !== undefined && note !== null) {
    const n = cleanUserText(note, DECIDE_NOTE_MAX)
    if (n === null) return fail('bad_request')
    clean = n || undefined
  }
  const task = ap.taskId ? rt.tasks.find((t) => t.id === ap.taskId) : undefined
  // A task archived, done or cancelled closed its approvals (closeTaskNeeds): one found open is stale.
  if (ap.taskId && (!task || task.state === 'done' || task.state === 'cancelled')) return fail('conflict', { reason: 'stale' })
  const approve = decision === 'approve'
  const decided = { ...ap, state: approve ? 'approved' : 'rejected', decidedAt: ctx.now, decidedBy: actor } as TeamApproval
  delete decided.error
  if (clean) decided.note = clean
  else delete decided.note
  switch (ap.kind) {
    case 'plan':
      return task ? decidePlan(rt, ap, decided, task, approve, clean, actor, ctx) : fail('conflict', { reason: 'stale' })
    case 'final':
      return task ? decideFinal(rt, decided, task, approve, clean, actor, ctx, f?.ahead) : fail('conflict', { reason: 'stale' })
    case 'permission':
      return task ? decidePermission(rt, ap, decided, task, approve, ctx) : fail('conflict', { reason: 'stale' })
    case 'hire': {
      if (approve) {
        // The proposal was checked against this trusted definition; one trusted since (other edits) is a stale diff.
        if (ap.payload.baseDefHash !== ctx.def.sha256) return fail('conflict', { reason: 'stale' })
        const applying = { ...decided, state: 'applying' } as TeamApproval
        return { ok: true, rt: { ...rt, approvals: replaceApproval(rt.approvals, applying) }, effects: [{ kind: 'applyHire', approvalId: ap.id }], result: undefined }
      }
      const out: TeamRuntime = { ...rt, approvals: replaceApproval(rt.approvals, decided) }
      const c = appendComment(out, { author: { kind: 'system' }, target: LEAD_THREAD, kind: 'system', text: '', sys: { key: 'hireRejected', vars: { roleId: ap.payload.roleId } } }, ctx)
      return c.ok ? { ok: true, rt: c.rt, effects: c.effects, result: undefined } : c
    }
  }
}

/** The `error` of a hire cancelled for its stale base (cancelStaleHires): a decide that raced it answers `conflict {stale}`. */
export const HIRE_STALE = 'stale'

/**
 * A definition trusted anew (TeamService.approveTrust, the end of a hire's apply), and also the load of a team and a
 * failed apply (B5 review, second round): every pending hire proposed against another trusted hash can never be
 * approved (decideApproval answers `conflict {stale}`), so it is cancelled with `error: HIRE_STALE` and leaves Te
 * necesita; the Lead may propose it again on the new definition. The same runtime when there is none.
 */
export function cancelStaleHires(rt: TeamRuntime, sha256: string, ctx: Pick<FlowCtx, 'now'>): TeamRuntime {
  const stale = (a: TeamApproval): boolean => a.kind === 'hire' && a.state === 'pending' && a.payload.baseDefHash !== sha256
  if (!rt.approvals.some(stale)) return rt
  return { ...rt, approvals: rt.approvals.map((a) => (stale(a) ? ({ ...a, state: 'cancelled', decidedAt: ctx.now, error: HIRE_STALE } as TeamApproval) : a)) }
}

/**
 * The end of an `applying` approval (a hire: TeamService wrote the role file and trusted the folder, or could not):
 * ok -> approved, every other pending hire on another base cancelled (cancelStaleHires), and the roster follows the
 * definition (`ctx.def` is the newly trusted one; reconcileAgents adds the hired agents); a failure -> back to pending
 * with its error code (the user may decide again), but one whose base is no longer the trusted hash (a trust that
 * landed while it applied, or before a quit cut it off) could never be approved: it is cancelled stale like every
 * other pending hire on an old base (B5 review, second round). A failure without a trusted definition (TeamService
 * passes only the clock) has no hash to compare: pending again. CAS: applying.
 */
export function completeApproval(rt: TeamRuntime, approvalId: string, outcome: { ok: true } | { ok: false; error: string }, ctx: FlowCtx): FlowResult {
  const ap = rt.approvals.find((a) => a.id === approvalId)
  if (!ap) return fail('not_found')
  if (ap.state !== 'applying') return fail('conflict', { reason: 'stale' })
  if (outcome.ok) {
    const done = { ...ap, state: 'approved' } as TeamApproval
    delete done.error
    const out: TeamRuntime = cancelStaleHires({ ...rt, approvals: replaceApproval(rt.approvals, done) }, ctx.def.sha256, ctx)
    const roster = reconcileAgents(out, ctx)
    return { ok: true, rt: roster.ok ? roster.rt : out, effects: [{ kind: 'dispatch' }], result: undefined }
  }
  const back = { ...ap, state: 'pending', error: String(outcome.error || 'error').slice(0, APPROVAL_ERROR_MAX) } as TeamApproval
  delete back.decidedAt
  delete back.decidedBy
  const out: TeamRuntime = { ...rt, approvals: replaceApproval(rt.approvals, back) }
  const trusted = (ctx as Partial<FlowCtx>).def
  return { ok: true, rt: trusted ? cancelStaleHires(out, trusted.sha256, ctx) : out, effects: [], result: undefined }
}

// ---- cards --------------------------------------------------------------------------------------------

/** The answer an agent card takes, by its kind; null when it does not fit. */
function agentAnswer(card: TeamCard, a: CardAnswer): CardAnswer | null {
  if (a.action !== undefined) return null
  const out: CardAnswer = {}
  if (a.text !== undefined) {
    const text = cleanUserText(a.text, CARD_TEXT_ANSWER_MAX)
    if (text === null) return null
    if (text) out.text = text
  }
  switch (card.kind) {
    case 'choice': {
      const ch = a.choices
      if (!Array.isArray(ch) || ch.length === 0 || (!card.multi && ch.length !== 1)) return null
      if (ch.some((i) => !Number.isInteger(i) || i < 0 || i >= card.options.length) || new Set(ch).size !== ch.length) return null
      out.choices = [...ch].sort((x, y) => x - y)
      return out
    }
    case 'text':
      if (a.choices !== undefined || a.confirm !== undefined || !out.text) return null
      return out
    case 'confirm':
      if (a.choices !== undefined || typeof a.confirm !== 'boolean') return null
      out.confirm = a.confirm
      return out
  }
}

/** The asker of an answered agent card runs again on its task (or alone) with the answer (4.5); a slot already set keeps its own reason. */
function wakeAsker(rt: TeamRuntime, card: TeamCard & { from: { kind: 'agent' } }, ctx: Pick<FlowCtx, 'now'>): TeamRuntime {
  const asker = card.from.agentId
  const agent = rt.agents.find((a) => a.id === asker)
  if (!agent || agent.retired) return rt
  const mark = (mode: RunMode): WakeMark => ({ agentId: asker, mode, reason: 'answer', since: ctx.now, refs: [card.id] })
  if (card.taskId) {
    const t = rt.tasks.find((x) => x.id === card.taskId)
    const mode = t ? phaseModeOf(t) : undefined
    if (!t || !mode || phaseAgentOf(t) !== asker) return rt
    if (t.next && t.next.agentId === asker && t.next.mode === mode) return rt
    return { ...rt, tasks: replaceTask(rt.tasks, { ...t, next: mark(mode), updatedAt: ctx.now }) }
  }
  if (agent.next) return rt
  return { ...rt, agents: rt.agents.map((a) => (a.id === asker ? { ...a, next: mark(agent.roleKind === 'lead' ? 'lead' : 'free') } : a)) }
}

/**
 * T17 from a card (retry, resume): a task this card blocks resumes to its pair with a wake for the agent of that
 * phase (resumeTask); a task in a run phase that no block holds (a prep that failed with a card) gets a `retry` wake.
 * The user's retry starts a fresh series (the no-progress, continuation, retry and interruption counters go back to
 * 0), and a wake the block kept (QA's `changes`) keeps its reason.
 */
function retryTask(rt: TeamRuntime, actor: Actor, card: TeamCard, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const task = card.taskId ? rt.tasks.find((t) => t.id === card.taskId) : undefined
  if (!task) return { ok: true, rt, effects: [], result: undefined }
  const counters = { ...task.counters, noProgress: 0, continuations: 0, retries: 0, interrupts: 0 }
  if (task.state === 'blocked') {
    if (task.blocked?.reason.kind !== 'card' || task.blocked.reason.cardId !== card.id) return { ok: true, rt, effects: [], result: undefined }
    const kept = task.next
    const res = resumeTask(rt, actor, task.id, ctx)
    if (!res.ok) return res
    let t = res.rt.tasks.find((x) => x.id === task.id) as TeamTask
    t = { ...t, counters }
    delete t.cooldownUntil
    if (kept && t.next && kept.agentId === t.next.agentId && kept.mode === t.next.mode) {
      // The user's go: now, past any cooldown or not-before the kept wake had.
      const next: WakeMark = { ...kept, since: ctx.now, bypassCooldown: true }
      delete next.notBefore
      t.next = next
    }
    return { ok: true, rt: { ...res.rt, tasks: replaceTask(res.rt.tasks, t) }, effects: res.effects, result: undefined }
  }
  const mode = phaseModeOf(task)
  const agentId = phaseAgentOf(task)
  if (task.state === 'done' || task.state === 'cancelled' || !mode || !agentId) return { ok: true, rt, effects: [], result: undefined }
  const t: TeamTask = { ...task, counters, next: { agentId, mode, reason: 'retry', since: ctx.now, bypassCooldown: true }, updatedAt: ctx.now }
  delete t.cooldownUntil
  return { ok: true, rt: { ...rt, tasks: replaceTask(rt.tasks, t) }, effects: [{ kind: 'dispatch' }], result: undefined }
}

/** The action of a system card, in the same commit as its answer (4.5). */
function cardAction(rt: TeamRuntime, actor: Actor & { kind: 'user' }, card: TeamCard & { from: { kind: 'system' } }, action: CardAction, ctx: FlowCtx): FlowResult {
  const keep: FlowResult = { ok: true, rt, effects: [], result: undefined }
  const task = card.taskId ? rt.tasks.find((t) => t.id === card.taskId) : undefined
  switch (action) {
    case 'dismiss':
    case 'keepWaiting':
      // Dismissed, the task stays as it is: a block still resumes from the drawer, a doing task with "Ejecutar ahora".
      return keep
    case 'retry':
    case 'resume':
      return retryTask(rt, actor, card, ctx)
    case 'toTodo':
    case 'cancelTask': {
      if (!task || task.state === 'done' || task.state === 'cancelled') return keep
      const res = moveTask(rt, actor, task.id, action === 'toTodo' ? 'todo' : 'cancelled', task.rev, { stopRun: true }, ctx)
      return res.ok ? { ...res, result: undefined } : res
    }
    case 'dropBlocker': {
      if (!task) return keep
      const left = task.blockedBy.filter((b) => depsOf(rt, [b]) !== 'cancelled')
      if (left.length === task.blockedBy.length) return keep
      const res = updateTask(rt, actor, task.id, { blockedBy: left }, undefined, ctx)
      return res.ok ? { ...res, result: undefined } : res
    }
    case 'stopRun': {
      const runId = card.from.runId
      if (!runId || !rt.activeRuns.some((r) => r.id === runId)) return keep
      const res = requestStop(rt, runId, 'user', ctx)
      return res.ok ? { ...res, result: undefined } : res
    }
    case 'resumeTeam': {
      let out = rt
      if (out.paused && out.paused.reason !== 'user') out = { ...out, paused: null }
      // The pause is lifted: every auth or billing card goes with it (the settings op does the same).
      out = dismissPauseCards(out)
      return { ok: true, rt: out, effects: [{ kind: 'dispatch' }], result: undefined }
    }
    case 'newSession': {
      const vars = card.from.vars ?? {}
      const what = typeof vars.what === 'string' && vars.what.startsWith('session:') ? vars.what.slice('session:'.length) : ''
      const agentId = typeof vars.agentId === 'string' ? vars.agentId : ''
      const agent = rt.agents.find((a) => a.id === agentId)
      if (!agent || !what) return keep
      const sessions = Object.fromEntries(Object.entries(agent.sessions).filter(([, s]) => s.sessionId !== what))
      if (Object.keys(sessions).length === Object.keys(agent.sessions).length) return keep
      return { ok: true, rt: { ...rt, agents: rt.agents.map((a) => (a.id === agent.id ? { ...a, sessions } : a)) }, effects: [{ kind: 'dispatch' }], result: undefined }
    }
    case 'killOrphan':
      // A process kill, not a reducer: the answer op calls TeamService.killOrphan (decision 64) instead.
      return fail('bad_request')
  }
}

/**
 * 4.5: the user answers a card. Not open -> `conflict {already_decided}`. An agent card takes the answer of its kind
 * (choice: indexes, one unless multi; text; confirm: Hecho / No puedo, a boolean; an optional text with the first
 * and last) and wakes its asker with `answer` (its run reads it in stdin section 8). A system card takes one of its
 * own actions, applied in the same result; from the phone a DESKTOP_ONLY_CARD_ACTIONS one is `forbidden` (the op
 * checks it first too), and `killOrphan` is TeamService's (`bad_request` here). Only the user answers cards.
 */
export function answerCard(rt: TeamRuntime, actor: Actor, cardId: string, a: CardAnswer, ctx: FlowCtx): FlowResult {
  const card = rt.cards.find((c) => c.id === cardId)
  if (!card) return fail('not_found')
  if (card.state !== 'open') return fail('conflict', { reason: 'already_decided' })
  if (actor.kind !== 'user') return fail('forbidden')
  if (typeof a !== 'object' || a === null) return fail('bad_request')
  if (card.from.kind === 'agent') {
    const answer = agentAnswer(card, a)
    if (!answer) return fail('bad_request')
    const answered: TeamCard = { ...card, state: 'answered', answer: { ...answer, by: actor, at: ctx.now } }
    let out: TeamRuntime = { ...rt, cards: replaceCard(rt.cards, answered) }
    out = wakeAsker(out, answered as TeamCard & { from: { kind: 'agent' } }, ctx)
    return { ok: true, rt: out, effects: [{ kind: 'dispatch' }], result: undefined }
  }
  const action = a.action
  if (!action || !card.from.actions.includes(action) || a.choices !== undefined || a.text !== undefined || a.confirm !== undefined) return fail('bad_request')
  if (actor.via === 'phone' && DESKTOP_ONLY_CARD_ACTIONS.includes(action)) return fail('forbidden')
  const closed: TeamCard = { ...card, state: action === 'dismiss' ? 'dismissed' : 'answered', answer: { action, by: actor, at: ctx.now } }
  // The card closes first, so a move that dismisses the task's open cards leaves this answer as it is.
  const res = cardAction({ ...rt, cards: replaceCard(rt.cards, closed) }, actor, closed as TeamCard & { from: { kind: 'system' } }, action, ctx)
  return res
}

// ---- permission asks ----------------------------------------------------------------------------------

/** True for a denied shell call of `snaos team` (the PowerShell tool, or `snaos.cmd` through Bash): never an approval. */
export function isTeamCallDenial(d: Pick<Denial, 'tool' | 'input'>): boolean {
  if (d.tool !== 'PowerShell' && d.tool !== 'Bash') return false
  const command = d.input && typeof d.input === 'object' ? (d.input as { command?: unknown }).command : undefined
  return isTeamCall(command)
}

/** A path in one comparable form: `/` separators, a drive as `/c/`, no trailing `/`, lowercase (Windows paths ignore case; elsewhere a false match only drops an approval). */
function pathKeyOf(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(s)
  if (drive) s = `/${drive[1]}${s.slice(2)}`
  return s.toLowerCase()
}

function underAny(path: string, roots: readonly string[]): boolean {
  const k = pathKeyOf(path)
  return roots.some((r) => {
    const q = pathKeyOf(r)
    return q !== '' && (k === q || k.startsWith(`${q}/`))
  })
}

/** The path a file tool was denied on. */
function denialPath(d: Pick<Denial, 'input'>): string | null {
  if (!d.input || typeof d.input !== 'object') return null
  const i = d.input as { file_path?: unknown; path?: unknown; notebook_path?: unknown }
  const p = i.file_path ?? i.notebook_path ?? i.path
  return typeof p === 'string' && p !== '' ? p : null
}

/**
 * A denial a protect rule of decision 72 denies (Read of every DATA_SECRET_PATHS entry; Edit, Write and MultiEdit of
 * teams/**, trusted-teams.json, runtime.json), by the paths the run's line carries, nowhere else.
 */
function protectDenies(d: Pick<Denial, 'tool' | 'input'>, protect: PermissionAskOpts['protect']): boolean {
  const reads = d.tool === 'Read'
  const writes = d.tool === 'Edit' || d.tool === 'Write' || d.tool === 'MultiEdit'
  if (!reads && !writes) return false
  const p = denialPath(d)
  if (!p) return false
  return underAny(p, reads ? protect.readDeny : protect.writeDeny)
}

export interface PermissionAskOpts {
  /**
   * The protect paths of decision 72 (TeamService.protectPaths, absolute, the ones every Claude line denies): a denial
   * they cause is never an approval. Always given (B5 integration, seventh round: the fallback of file names that
   * stood in for them went, it was a second list no caller reached).
   */
  protect: { readDeny: readonly string[]; writeDeny: readonly string[] }
  /**
   * The live-token mask of the run end (RunEndCtx.mask, CtlTokens.maskTokens through TeamServiceDeps.cli; B5 review):
   * a rule it would change is never offered, and each denied line goes through it before redactCredentials.
   */
  mask?: (text: string) => string
}

/**
 * The rules a permission ask would carry for one run's denials, in order and deduped, each isGrantable (so never a
 * PowerShell rule): a Claude run with an allow list (readonly or custom) only; not a `snaos team` call; not a tool
 * the effective profile denies (CLAUDE_READONLY_DENY in a readonly or plan run) or a protect rule denies; not a rule
 * the run already allows (its profile's list, CLAUDE_TEAM_TOOLS, the custom role's tools, the task's grants of that
 * role: what denied it is a deny rule, granting it again changes nothing); never a rule redactCredentials or the
 * live-token mask would change (a credential or a token of the app, whole or cut: masked, it is no longer the command
 * that ran, and as is it would enter the team state, the view and the argv).
 */
export function permissionPatterns(run: Pick<Run, 'provider' | 'profile' | 'roleId' | 'taskId'>, denials: readonly Pick<Denial, 'tool' | 'input'>[], task: Pick<TeamTask, 'grants'> | undefined, def: TrustedDefinition, o: PermissionAskOpts): string[] {
  return askOf(run, denials, task, def, o).tools
}

/** A denied shell command as a permission approval shows it: CR normalized, trimmed, live tokens masked (`mask`), redacted, cut to DENIED_COMMAND_MAX. */
function deniedLine(command: string, mask: PermissionAskOpts['mask']): string {
  const trimmed = command.replace(/\r\n?/g, '\n').trim()
  const t = redactCredentials(mask ? mask(trimmed) : trimmed)
  return t.length > DENIED_COMMAND_MAX ? t.slice(0, DENIED_COMMAND_MAX - 1) + '…' : t
}

/** True when neither redactCredentials nor the live-token mask changes a candidate rule (askOf offers only those). */
function unmasked(rule: string, mask: PermissionAskOpts['mask']): boolean {
  return redactCredentials(rule) === rule && (!mask || mask(rule) === rule)
}

/**
 * permissionPatterns plus `denied`: the command of each shell denial that asks for a rule (deniedLine; at most
 * DENIED_COMMANDS_MAX, deduped, in order), what the user reads next to the rules (B5).
 */
function askOf(run: Pick<Run, 'provider' | 'profile' | 'roleId' | 'taskId'>, denials: readonly Pick<Denial, 'tool' | 'input'>[], task: Pick<TeamTask, 'grants'> | undefined, def: TrustedDefinition, o: PermissionAskOpts): { tools: string[]; denied: string[] } {
  const tools: string[] = []
  const denied: string[] = []
  if (run.provider !== 'claude' || run.profile === 'total') return { tools, denied }
  const allowed = new Set<string>(CLAUDE_TEAM_TOOLS)
  if (run.profile === 'readonly') for (const t of CLAUDE_READONLY_ALLOW) allowed.add(t)
  else for (const t of def.def.roles.find((r) => r.id === run.roleId)?.allowedTools ?? []) if (validToolPattern(t)) allowed.add(t)
  for (const g of task?.grants ?? []) if (g.roleId === run.roleId) allowed.add(g.tool)
  for (const d of denials) {
    if (!d || typeof d.tool !== 'string' || isTeamCallDenial(d)) continue
    if (run.profile === 'readonly' && (CLAUDE_READONLY_DENY as readonly string[]).includes(d.tool)) continue
    if (protectDenies(d, o.protect)) continue
    // A denial whose only rule a mask would change opens nothing (nor its denied line).
    const asks = grantPatternOf(d).filter((p) => isGrantable(p) && !allowed.has(p) && unmasked(p, o.mask))
    if (asks.length === 0) continue
    for (const p of asks) if (!tools.includes(p)) tools.push(p)
    const command = shellCommandOf(d)
    if (command !== null) {
      const line = deniedLine(command, o.mask)
      if (line && !denied.includes(line) && denied.length < DENIED_COMMANDS_MAX) denied.push(line)
    }
  }
  return { tools, denied }
}

/** The command of a Bash or PowerShell denial, else null. */
function shellCommandOf(d: Pick<Denial, 'tool' | 'input'>): string | null {
  if (d.tool !== 'PowerShell' && d.tool !== 'Bash') return null
  const command = d.input && typeof d.input === 'object' ? (d.input as { command?: unknown }).command : undefined
  return typeof command === 'string' ? command : null
}

/** True for a denied shell command that starts a shell or runs inline code (teamArgv isShellEscape): never an approval, the agent's next run gets ESCAPE_HINT. */
export function isEscapeDenial(d: Pick<Denial, 'tool' | 'input'>): boolean {
  const command = shellCommandOf(d)
  return command !== null && isShellEscape(command)
}

/**
 * The run end (finishRun, flow/runs.ts): a Claude task run's denials open, or merge into, ONE pending permission
 * approval of that task and the run's role (permissionPatterns; at most GRANTS_MAX rules), with the denied shell
 * commands that ask for them (`denied`, merged like the rules, at most DENIED_COMMANDS_MAX). A task over (done,
 * cancelled, archived) or a run without a task asks nothing. Result: the approval it opened or grew, else null.
 */
export function permissionAsk(rt: TeamRuntime, run: Run, denials: readonly Denial[], ctx: FlowCtx, o: PermissionAskOpts): FlowResult<{ approvalId: string | null }> {
  const none: FlowResult<{ approvalId: string | null }> = { ok: true, rt, effects: [], result: { approvalId: null } }
  if (!run.taskId || denials.length === 0) return none
  const task = rt.tasks.find((t) => t.id === run.taskId)
  if (!task || task.state === 'done' || task.state === 'cancelled') return none
  const { tools, denied } = askOf(run, denials, task, ctx.def, o)
  if (tools.length === 0) return none
  const cur = rt.approvals.find((a): a is Extract<TeamApproval, { kind: 'permission' }> => a.kind === 'permission' && a.state === 'pending' && a.taskId === task.id && a.payload.roleId === run.roleId)
  if (cur) {
    const merged = [...cur.payload.tools]
    for (const t of tools) if (!merged.includes(t) && merged.length < GRANTS_MAX) merged.push(t)
    const lines = [...(cur.payload.denied ?? [])]
    for (const l of denied) if (!lines.includes(l) && lines.length < DENIED_COMMANDS_MAX) lines.push(l)
    if (merged.length === cur.payload.tools.length && lines.length === (cur.payload.denied ?? []).length && cur.payload.runId === run.id) return { ...none, result: { approvalId: cur.id } }
    const payload: typeof cur.payload = { ...cur.payload, runId: run.id, tools: merged }
    if (lines.length) payload.denied = lines
    const next: TeamApproval = { ...cur, payload }
    return { ok: true, rt: { ...rt, approvals: replaceApproval(rt.approvals, next) }, effects: [], result: { approvalId: cur.id } }
  }
  const by: Actor = { kind: 'agent', agentId: run.agentId, runId: run.id, roleKind: run.roleKind }
  const payload: Extract<TeamApproval, { kind: 'permission' }>['payload'] = { roleId: run.roleId, runId: run.id, tools: tools.slice(0, GRANTS_MAX) }
  if (denied.length) payload.denied = denied
  const added = addApproval(rt, { kind: 'permission', taskId: task.id, decider: 'user', createdBy: by, payload }, ctx)
  if (!added.ok) return added
  return { ok: true, rt: added.rt, effects: [], result: { approvalId: added.id } }
}

// ---- sha256 (pure) ------------------------------------------------------------------------------------

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/** UTF-8 bytes of a string as Node writes them (a lone surrogate is U+FFFD). */
function utf8Of(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00)
      i++
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return out
}

/**
 * sha256 hex of the UTF-8 bytes of `text` (FIPS 180-4), so a reducer can name the exact bytes main writes: a hire's
 * `payload.sha256` is `sha256Utf8(payload.text)`, the same value as Node's `createHash('sha256').update(text, 'utf8')`.
 */
export function sha256Utf8(text: string): string {
  const bytes = utf8Of(text)
  const bits = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bits / 0x100000000)
  const lo = bits >>> 0
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array<number>(64)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = (bytes[i + 4 * t] << 24) | (bytes[i + 4 * t + 1] << 16) | (bytes[i + 4 * t + 2] << 8) | bytes[i + 4 * t + 3]
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, k] = h
    for (let t = 0; t < 64; t++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + w[t]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      k = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
    h[5] = (h[5] + f) | 0
    h[6] = (h[6] + g) | 0
    h[7] = (h[7] + k) | 0
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}
