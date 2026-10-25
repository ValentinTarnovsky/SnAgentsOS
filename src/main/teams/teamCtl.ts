/**
 * `snaos team` in main (app 2.7.0, Tanda B, design 3.9, 5.1 and 5.3): the
 * CtlTeamsView the CLI handler hands every `team.*` call of a team run to.
 * It re-validates every param (ids by the regexes, texts by the caps, enums),
 * resolves the caller's live run through the port, checks the role and the
 * run mode (allowedFor), refuses writes once the run concluded with a terminal
 * tool, redacts every text before it can reach a notice and maps the store's
 * errors to ctl codes (the 5.1 table, one hint per error in English for the
 * agent). The store re-checks all of it (phase, liveness, caps, what the user
 * owns): this layer answers the agent early and in words.
 */
import type { CtlErrorCode, CtlResponse } from '@shared/ctl-protocol'
import { redactCredentials } from '@shared/redact'
import type { ConflictReason } from '@shared/team-protocol'
import {
  AGENT_ID_RE,
  BLOCKED_BY_MAX,
  CARD_OPTION_MAX,
  CARD_OPTIONS_MAX,
  CARD_QUESTION_MAX,
  COMMENT_TEXT_MAX,
  HIRE_TEXT_MAX,
  LEAD_THREAD,
  REPO_ID_RE,
  TASK_BODY_MAX,
  TASK_ID_RE,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  TEAM_PLAN_MAX,
  TEAM_READS_PER_MIN,
  TEAM_STATE_MAX_BYTES,
  TEAM_TASKS_MAX,
  TEAM_WRITES_PER_MIN,
  type AgentState,
  type RoleKind,
  type Run,
  type TeamTask,
  type TerminalTool,
  type TrustedDefinition,
} from '@shared/teams'
import { allowedFor, TEAM_TOOLS, teamTool, type TeamCtlMethod, type TeamToolSpec } from '@shared/teamTools'
import { WS_NOTE_TITLE_MAX } from '@shared/ws-notes'
import type { CtlTeamCaller } from '../cli/CtlTokens'
import type { CtlTeamsView } from '../cli/handlers'
import { cycleLoopOf, cycleText } from './flow/tasks'
import type { FlowResult, TeamToolCall } from './flow/types'

/** The live run behind a caller (the port's `live`). */
export interface TeamLiveRun { teamId: string; run: Run; agent: AgentState; task?: TeamTask; def: TrustedDefinition }

export type TeamReadMethod = 'team.show' | 'team.tasks' | 'team.task.get'

/** What TeamService gives the CLI (design 3.9); TeamService.ctlView = createTeamCtl(port). */
export interface TeamCtlPort {
  /**
   * The live run behind a caller: the active run whose agent equals who.agentId; null -> forbidden; 'disabled' ->
   * Teams is not served (Labs off, frozen or disposed) -> disabled, before any other check.
   */
  live(who: CtlTeamCaller): TeamLiveRun | 'disabled' | null
  /** team.show, team.tasks and team.task.get with the params already checked here (task.get marks delivered what its reply includes, 4.5). */
  read(teamId: string, method: TeamReadMethod, params: Record<string, unknown>, who: CtlTeamCaller): CtlResponse
  /** Every other write but note: applyTool and the commit, inside; or the state cap the port checks before them (`full: 'state'`). */
  apply(teamId: string, call: TeamToolCall, who: CtlTeamCaller): FlowResult<unknown> | ({ ok: false } & TeamFailLike)
  /** B7 (team notes). Absent until then: team.note answers disabled. */
  note?(teamId: string, text: string, title: string | undefined, who: CtlTeamCaller): Promise<CtlResponse>
}

/** A store or flow failure as the port hands it (FlowResult or TeamFail): the error word and its extras. */
export interface TeamFailLike {
  error: string
  reason?: ConflictReason
  fields?: readonly string[]
  current?: unknown
  defer?: { reason: string; until?: number }
  detail?: string
  /** `cycle` as a TeamFail carries it (a flow failure has it in `current`, a CycleLoop). */
  loop?: readonly string[]
  loopMore?: number
  /** `cap` only: 'state' = the write would take state.json past TEAM_STATE_MAX_BYTES (absent: a count cap of the reducer). */
  full?: 'state'
}

/** The Labs gate in the agent's words (main i18n `labs.teamsOff`): the run cannot go on. */
const TEAMS_OFF = 'Teams is off (Settings > Labs): end your turn'

type Params = Record<string, unknown>
type Fail = Extract<CtlResponse, { ok: false }>

/** Section 5.1: the ctl code of each store or flow error; anything else is internal. */
const CODE_OF: Readonly<Record<string, CtlErrorCode>> = {
  bad_request: 'bad_request',
  cycle: 'bad_request',
  too_big: 'bad_request',
  not_found: 'not_found',
  forbidden: 'forbidden',
  untrusted: 'forbidden',
  disabled: 'disabled',
  unsupported: 'disabled',
  busy: 'busy',
  running: 'busy',
  stopping: 'busy',
  cap: 'busy',
  deferred: 'busy',
  rate: 'rate_limited',
  conflict: 'conflict',
  user_owned: 'user_owned',
}

const TASK_STATE_FILTERS = ['todo', 'doing', 'review', 'done', 'blocked', 'cancelled', 'open'] as const
const UPDATE_STATES = ['todo', 'blocked', 'cancelled'] as const
const ISOLATIONS = ['worktree', 'main'] as const
const VERDICTS = ['approve', 'changes'] as const
/** Runs whose terminal tool this layer saw, so a later write is refused before the store (bounded, oldest out). */
const CONCLUDED_MEMORY = 256

function fail(code: CtlErrorCode, message: string, data?: unknown): Fail {
  return data === undefined ? { ok: false, error: { code, message } } : { ok: false, error: { code, message }, data }
}

/** `team task create` for team.task.create: the words the agent typed. */
function words(spec: TeamToolSpec): string {
  return `team ${spec.name.replace('.', ' ')}`
}

/** The tool a terminal word belongs to, as the agent typed it (`approvePlan` -> `approve`). */
function toolWord(tool: TerminalTool): string {
  const spec = TEAM_TOOLS.find((t) => t.terminal === tool)
  return spec ? spec.name : tool
}

// ---- params ----------------------------------------------------------------------------------------

class ParamError extends Error {}

function plain(v: unknown): v is Params {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A key the agent sent, safe to echo: printable ASCII, 40 characters at most. */
function safeName(k: string): string {
  return k.replace(/[^\x20-\x7e]/g, '?').slice(0, 40)
}

function onlyKeys(p: Params, allowed: readonly string[], spec: TeamToolSpec): void {
  for (const k of Object.keys(p)) if (!allowed.includes(k)) throw new ParamError(`${words(spec)} takes no param "${safeName(k)}"`)
}

/** Drops the undefined values (the store reads a missing key as "not given"). */
function defined(p: Params): Params {
  const out: Params = {}
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v
  return out
}

/**
 * A text param, redacted (redactCredentials, before it can reach a notice) and capped after the redaction (what the
 * store keeps). `line` (titles): controls and runs of spaces become one space, trimmed.
 */
function text(p: Params, key: string, max: number, o: { required?: boolean; line?: boolean; label?: string } = {}): string | undefined {
  const label = o.label ?? key
  const v = p[key]
  if (v === undefined || v === null) {
    if (o.required) throw new ParamError(`${label} is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new ParamError(`${label} must be a text`)
  // eslint-disable-next-line no-control-regex
  const raw = o.line ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim() : v
  if (o.required && raw.trim() === '') throw new ParamError(`${label} is empty`)
  const out = redactCredentials(raw)
  if (out.length > max) throw new ParamError(`${label} is longer than ${max} characters`)
  return out
}

function id(p: Params, key: string, re: RegExp, o: { required?: boolean; what: string }): string | undefined {
  const v = p[key]
  if (v === undefined) {
    if (o.required) throw new ParamError(`${key} is required (${o.what})`)
    return undefined
  }
  if (typeof v !== 'string' || !re.test(v)) throw new ParamError(`${key} must be ${o.what}`)
  return v
}

function oneOf<T extends string>(p: Params, key: string, values: readonly T[], required = false): T | undefined {
  const v = p[key]
  if (v === undefined) {
    if (required) throw new ParamError(`${key} is required (${values.join(', ')})`)
    return undefined
  }
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new ParamError(`${key} must be one of ${values.join(', ')}`)
  return v as T
}

function flag(p: Params, key: string): boolean | undefined {
  const v = p[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new ParamError(`${key} must be true or false`)
  return v
}

/** blockedBy: task ids, BLOCKED_BY_MAX at most, duplicates dropped; [] clears (update). */
function taskIds(p: Params, key: string): string[] | undefined {
  const v = p[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !TASK_ID_RE.test(x))) throw new ParamError(`${key} must be a list of task ids (t-1, t-2)`)
  const out = [...new Set(v as string[])]
  if (out.length > BLOCKED_BY_MAX) throw new ParamError(`${key} takes ${BLOCKED_BY_MAX} tasks at most`)
  return out
}

function options(p: Params): string[] | undefined {
  const v = p.options
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length === 0 || v.length > CARD_OPTIONS_MAX) throw new ParamError(`options must be a list of 1 to ${CARD_OPTIONS_MAX} answers`)
  return v.map((o, i) => {
    if (typeof o !== 'string' || o.trim() === '') throw new ParamError(`option ${i + 1} is empty`)
    // eslint-disable-next-line no-control-regex
    const out = redactCredentials(o.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim())
    if (out.length > CARD_OPTION_MAX) throw new ParamError(`option ${i + 1} is longer than ${CARD_OPTION_MAX} characters`)
    return out
  })
}

const TASK_ID = 'a task id like t-12'
const AGENT_ID = 'an agent id of this team (snaos team show)'

/** Section 5.3 params, method by method: the shape the store reads (the same names as a Codex block's params). */
function normalize(spec: TeamToolSpec, p: Params): Params {
  switch (spec.method) {
    case 'team.show':
      onlyKeys(p, [], spec)
      return {}
    case 'team.tasks':
      onlyKeys(p, ['state', 'mine'], spec)
      return defined({ state: oneOf(p, 'state', TASK_STATE_FILTERS), mine: flag(p, 'mine') })
    case 'team.task.get':
      onlyKeys(p, ['task'], spec)
      return { task: id(p, 'task', TASK_ID_RE, { required: true, what: TASK_ID }) }
    case 'team.task.create': {
      onlyKeys(p, ['title', 'body', 'assign', 'repo', 'isolation', 'blockedBy', 'priority', 'noPlan', 'parent'], spec)
      return defined({
        title: text(p, 'title', TASK_TITLE_MAX, { required: true, line: true }),
        body: text(p, 'body', TASK_BODY_MAX),
        assign: p.assign === null ? undefined : id(p, 'assign', AGENT_ID_RE, { what: AGENT_ID }),
        repo: id(p, 'repo', REPO_ID_RE, { what: 'a repo id of this team (main or an extra repo)' }),
        isolation: oneOf(p, 'isolation', ISOLATIONS),
        blockedBy: taskIds(p, 'blockedBy'),
        priority: oneOf(p, 'priority', TASK_PRIORITIES),
        noPlan: flag(p, 'noPlan'),
        parent: id(p, 'parent', TASK_ID_RE, { what: TASK_ID }),
      })
    }
    case 'team.task.update': {
      onlyKeys(p, ['task', 'rev', 'title', 'body', 'assign', 'priority', 'blockedBy', 'isolation', 'state', 'needsPlan'], spec)
      const rev = p.rev
      if (rev !== undefined && !(typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0)) throw new ParamError('rev must be the rev number snaos team task get printed')
      const out = defined({
        task: id(p, 'task', TASK_ID_RE, { required: true, what: TASK_ID }),
        rev,
        title: text(p, 'title', TASK_TITLE_MAX, { required: p.title !== undefined, line: true }),
        body: text(p, 'body', TASK_BODY_MAX),
        // null unassigns (`--assign none`).
        assign: p.assign === null ? null : id(p, 'assign', AGENT_ID_RE, { what: `${AGENT_ID}, or null to unassign` }),
        priority: oneOf(p, 'priority', TASK_PRIORITIES),
        blockedBy: taskIds(p, 'blockedBy'),
        isolation: oneOf(p, 'isolation', ISOLATIONS),
        state: oneOf(p, 'state', UPDATE_STATES),
        needsPlan: flag(p, 'needsPlan'),
      })
      if (Object.keys(out).every((k) => k === 'task' || k === 'rev')) throw new ParamError(`${words(spec)} needs a field to change`)
      return out
    }
    case 'team.comment': {
      onlyKeys(p, ['target', 'text'], spec)
      const target = p.target
      if (typeof target !== 'string' || (target !== LEAD_THREAD && !TASK_ID_RE.test(target))) throw new ParamError(`target must be ${TASK_ID} or "lead" (the Lead thread)`)
      return { target, text: text(p, 'text', COMMENT_TEXT_MAX, { required: true }) }
    }
    case 'team.note':
      onlyKeys(p, ['text', 'title'], spec)
      return defined({ text: text(p, 'text', COMMENT_TEXT_MAX, { required: true }), title: text(p, 'title', WS_NOTE_TITLE_MAX, { line: true }) })
    case 'team.ask': {
      onlyKeys(p, ['text', 'options', 'multi', 'confirm'], spec)
      const out = defined({ text: text(p, 'text', CARD_QUESTION_MAX, { required: true }), options: options(p), multi: flag(p, 'multi'), confirm: flag(p, 'confirm') })
      if (out.multi === true && out.options === undefined) throw new ParamError('multi needs options')
      if (out.confirm === true && (out.options !== undefined || out.multi === true)) throw new ParamError('confirm is a yes or no question: leave out options and multi')
      return out
    }
    case 'team.needs':
      onlyKeys(p, ['text'], spec)
      return { text: text(p, 'text', CARD_QUESTION_MAX, { required: true }) }
    case 'team.plan':
      onlyKeys(p, ['text', 'small'], spec)
      return defined({ text: text(p, 'text', TEAM_PLAN_MAX, { required: true, label: 'the plan' }), small: flag(p, 'small') })
    case 'team.review':
    case 'team.done':
      onlyKeys(p, ['text'], spec)
      return defined({ text: text(p, 'text', COMMENT_TEXT_MAX) })
    case 'team.verdict':
      onlyKeys(p, ['verdict', 'text'], spec)
      return { verdict: oneOf(p, 'verdict', VERDICTS, true), text: text(p, 'text', COMMENT_TEXT_MAX, { required: true, label: 'the verdict text (what you checked, or the changes to make)' }) }
    case 'team.approve':
      onlyKeys(p, ['plan'], spec)
      return { plan: id(p, 'plan', TASK_ID_RE, { required: true, what: `${TASK_ID} (the task whose plan you approve)` }) }
    case 'team.hire':
      onlyKeys(p, ['text'], spec)
      return { text: text(p, 'text', HIRE_TEXT_MAX, { required: true, label: 'the role file' }) }
  }
}

// ---- errors ----------------------------------------------------------------------------------------

/** The ids a call names (for a not_found hint). */
function idsOf(params: Params | undefined): string[] {
  if (!params) return []
  const out: string[] = []
  for (const k of ['task', 'target', 'plan', 'parent', 'assign', 'repo']) if (typeof params[k] === 'string') out.push(params[k] as string)
  if (Array.isArray(params.blockedBy)) for (const b of params.blockedBy) if (typeof b === 'string') out.push(b)
  return out
}

function revOf(current: unknown): number | undefined {
  if (plain(current) && typeof current.rev === 'number') return current.rev
  return undefined
}

/**
 * Section 5.1: a store or flow failure (FlowResult, TeamFail) as the ctl answer, with a hint for the agent: the
 * offending param, the id, the role or mode, the fields the user owns. `data` carries the store's error word and its
 * extras (reason, fields, defer). Exported: the port may build its read errors with it.
 */
export function teamCtlError(f: TeamFailLike, hint: { method: TeamCtlMethod; params?: Params; concludedWith?: string }): Fail {
  const spec = teamTool(hint.method)
  const cmd = spec ? `snaos ${words(spec)}` : 'snaos team'
  const code = CODE_OF[f.error] ?? 'internal'
  const detail = typeof f.detail === 'string' && f.detail.trim() ? f.detail.trim().slice(0, 300) : ''
  const extras = defined({ error: f.error, reason: f.reason, fields: f.fields ? [...f.fields] : undefined, defer: f.defer })
  const ids = idsOf(hint.params)
  const task = typeof hint.params?.task === 'string' ? hint.params.task : typeof hint.params?.target === 'string' ? hint.params.target : '<t-N>'
  let message: string
  switch (f.error) {
    case 'bad_request':
      message = detail || `${cmd}: the team refused these params (check the ids and values with snaos team show and snaos team tasks)`
      break
    case 'cycle': {
      // The loop travels as a field too (data.loop, data.loopMore), the same shape the user's TeamFail carries.
      const c = cycleLoopOf(f.current) ?? (f.loop ? cycleLoopOf({ loop: f.loop, more: f.loopMore }) : null)
      const by = Array.isArray(hint.params?.blockedBy) ? (hint.params.blockedBy as string[]).join(',') : ''
      if (c) {
        extras.loop = c.loop
        if (c.more > 0) extras.loopMore = c.more
      }
      message = c ? `--blocked-by makes a loop of blockers: ${cycleText(c)}` : `--blocked-by ${by} makes a loop of blockers (a task cannot wait on itself through others)`
      break
    }
    case 'too_big':
      message = detail || `${cmd}: the text is too long`
      break
    case 'not_found':
      message = detail || (ids.length === 1 ? `${ids[0]} not found` : ids.length ? `not found: one of ${ids.join(', ')}` : `${cmd}: not found`)
      break
    case 'untrusted':
      message = 'the team definition changed; wait for the user'
      break
    case 'forbidden':
      message = detail || `${cmd} is not allowed for your role in this run`
      break
    case 'disabled':
    case 'unsupported':
      message = `${cmd} is not available in this build`
      break
    case 'cap':
      // What is full decides the hint: the state file, a comment thread, or the board.
      if (f.full === 'state') message = `the team state is full (${Math.floor(TEAM_STATE_MAX_BYTES / (1024 * 1024))} MB): archive or cancel old tasks; this call cannot succeed as is`
      else if (hint.method === 'team.comment') message = `${task === LEAD_THREAD ? 'the Lead thread' : task} has no room for more comments (too many wait to be read): this call cannot succeed as is`
      else message = `the board is full (${TEAM_TASKS_MAX} live tasks): this call cannot succeed as is`
      break
    case 'running':
      message = `${task} has an active run: wait for it to end`
      break
    case 'stopping':
      message = 'this run is stopping: end your turn'
      break
    case 'deferred':
      message = `deferred${f.defer?.reason ? ` (${f.defer.reason})` : ''}: try again later`
      break
    case 'busy':
      message = detail || 'the team is busy with that: try again later'
      break
    case 'rate':
      message = `the budget of ${TEAM_READS_PER_MIN} reads and ${TEAM_WRITES_PER_MIN} writes a minute is spent: wait a minute`
      break
    case 'conflict':
      if (f.reason === 'concluded') message = `this run already concluded with team ${hint.concludedWith ?? 'a tool that ends the run'}`
      else if (f.reason === 'newer_comment_not_delivered') message = `a newer comment for you is waiting: read it with snaos team task get ${task} first`
      else if (f.reason === 'rev') {
        const now = revOf(f.current)
        message = `${task} changed since --rev ${String(hint.params?.rev ?? '')}${now !== undefined ? ` (now rev ${now})` : ''}: read it again with snaos team task get ${task} and retry`
      } else if (f.reason === 'already_decided') message = 'that was already decided'
      else message = `${task} moved on: read it again with snaos team task get ${task}`
      break
    case 'user_owned': {
      const fields = f.fields?.length ? f.fields.join(', ') : 'some fields'
      // The state through a side effect: the agent sent --blocked-by, which would move a task the user placed.
      if (f.fields?.includes('state') && hint.params?.state === undefined && hint.params?.blockedBy !== undefined) message = `the user set the state of ${task} and --blocked-by would move it: the whole update was refused, leave --blocked-by out`
      else message = `the user set ${fields} of ${task}: those fields stay theirs, leave them out`
      break
    }
    default:
      message = 'the team could not apply it'
  }
  return fail(code, message, extras)
}

/** A port answer that carries a bare error word (a TeamFail) becomes a ctl error; a ctl answer passes as is. */
function portReply(r: unknown, hint: { method: TeamCtlMethod; params: Params }): CtlResponse {
  if (!plain(r) || typeof r.ok !== 'boolean') return fail('internal', 'the team could not answer')
  if (r.ok) return r as CtlResponse
  if (typeof r.error === 'string') return teamCtlError(r as unknown as TeamFailLike, hint)
  if (plain(r.error) && typeof r.error.code === 'string' && typeof r.error.message === 'string') return r as CtlResponse
  return fail('internal', 'the team could not answer')
}

/** Why allowedFor said no, in the agent's words. */
function forbiddenWhy(spec: TeamToolSpec, kind: RoleKind, live: TeamLiveRun): string {
  const cmd = `snaos ${words(spec)}`
  const mode = live.run.mode
  if (!spec.roles.includes(kind)) return `${cmd} is not a tool of the ${kind} role`
  if (spec.name === 'task.create') {
    if (kind === 'lead') return `the Lead creates tasks in its lead runs only; this run is in ${mode} mode`
    return `a ${kind} creates only subtasks of its own task, in an exec run: --parent ${live.run.taskId ?? '<your task>'}`
  }
  if (spec.name === 'review' && live.run.profile === 'readonly' && mode === 'exec') return 'this run is read-only and commits nothing to review: report the task with snaos team done'
  if (spec.name === 'done' && kind === 'dev' && live.task?.isolation !== 'main' && mode === 'exec') return 'a dev ends a task with isolation worktree with snaos team review, not done'
  if (spec.modes.length && !spec.modes.includes(mode)) return `${cmd} works only in ${spec.modes.join(' or ')} runs; this run is in ${mode} mode`
  return `${cmd} is not allowed in this run (${mode} mode)`
}

// ---- the view -------------------------------------------------------------------------------------

export function createTeamCtl(port: TeamCtlPort): CtlTeamsView {
  /** runId -> the terminal tool this layer accepted (the store keeps `run.concludedBy` too). */
  const concluded = new Map<string, string>()
  const remember = (runId: string, tool: string): void => {
    concluded.delete(runId)
    concluded.set(runId, tool)
    while (concluded.size > CONCLUDED_MEMORY) concluded.delete(concluded.keys().next().value as string)
  }

  async function handle(method: TeamCtlMethod, raw: Params, who: CtlTeamCaller): Promise<CtlResponse> {
    const spec = teamTool(method)
    if (!spec) return fail('bad_request', 'unknown team method')
    // The Labs gate first, as every Teams request (B1): Teams off answers disabled, never forbidden.
    const live = port.live(who)
    if (live === 'disabled') {
      concluded.delete(who.runId)
      return fail('disabled', TEAMS_OFF)
    }
    let params: Params
    try {
      params = normalize(spec, plain(raw) ? raw : {})
    } catch (e) {
      if (e instanceof ParamError) return fail('bad_request', `${words(spec)}: ${e.message}`)
      throw e
    }
    if (!live || live.run.id !== who.runId) {
      concluded.delete(who.runId)
      return fail('forbidden', 'this team run is not active any more: end your turn')
    }
    const kind = live.run.roleKind
    if (!allowedFor(kind, spec, { mode: live.run.mode, isolation: live.task?.isolation, hasTask: !!live.run.taskId, profile: live.run.profile })) return fail('forbidden', forbiddenWhy(spec, kind, live))
    // A Dev or a custom role splits only the task it runs (5.3); allowedFor knows only that it has one.
    if (spec.name === 'task.create' && kind !== 'lead' && params.parent !== live.run.taskId) return fail('forbidden', forbiddenWhy(spec, kind, live))
    const hint = { method: spec.method, params }
    if (!spec.write) return portReply(port.read(live.teamId, spec.method as TeamReadMethod, params, who), hint)
    // Decision 35: a run that concluded keeps reading but writes no more.
    const concludedWith = live.run.concludedBy ? toolWord(live.run.concludedBy.tool) : concluded.get(live.run.id)
    if (concludedWith) return teamCtlError({ error: 'conflict', reason: 'concluded' }, { ...hint, concludedWith })
    if (live.run.state === 'stopping') return teamCtlError({ error: 'stopping' }, hint)
    if (spec.method === 'team.note') {
      if (!port.note) return teamCtlError({ error: 'unsupported' }, hint)
      return portReply(await port.note(live.teamId, params.text as string, params.title as string | undefined, who), hint)
    }
    const res = port.apply(live.teamId, { method: spec.method, params }, who)
    if (!res.ok) return teamCtlError(res, { ...hint, concludedWith })
    if (spec.terminal) remember(live.run.id, spec.name)
    return { ok: true, data: res.result ?? {} }
  }

  return {
    async handle(method, params, who) {
      try {
        return await handle(method, params, who)
      } catch {
        return fail('internal', 'the team could not answer')
      }
    },
  }
}
