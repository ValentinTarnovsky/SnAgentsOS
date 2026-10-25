/**
 * Teams (app 2.7.0, Tanda B, behind `labs.teams`): ids, caps, enums and the
 * shapes of a team's definition and runtime. Pure, type-only imports: main,
 * the renderer and the phone share it.
 *
 * The definition lives in the repo (`.snagentsos/team/`, parsed by
 * teamDefinition.ts) and runs read it only from the trusted snapshot. The
 * runtime (`dataDir()/teams/<teamId>/state.json`) is main's: it never travels
 * raw, the views of team-protocol.ts do.
 */
import type { AgentProvider, PaneContext, PaneUsage } from './types'
import type { FailureInfo } from './failure'
import type { TurnDigest } from './toolActivity'
import type { VerifyNote } from './team-protocol'

// ---- ids ---------------------------------------------------------------------------------------
export const TEAM_ID_RE = /^tm-[a-f0-9]{12}$/
export const TASK_ID_RE = /^t-[0-9]{1,5}$/
/** 22 chars max so `<roleId>-4` still matches AGENT_ID_RE (decision 20). */
export const ROLE_ID_RE = /^[a-z][a-z0-9-]{0,21}$/
export const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,23}$/
export const RUN_ID_RE = /^r-[a-f0-9]{12}$/
export const COMMENT_ID_RE = /^m-[0-9]{1,7}$/
export const APPROVAL_ID_RE = /^a-[0-9]{1,7}$/
export const CARD_ID_RE = /^k-[0-9]{1,7}$/
export const QUEUE_ID_RE = /^q-[0-9]{1,7}$/
export const REPO_ID_RE = /^(?:main|[a-z][a-z0-9-]{0,23})$/
export const ROUTINE_ID_RE = /^[a-z][a-z0-9-]{0,23}$/
/** `TeamRuntime.gen`: 8 hex minted by main for each new runtime (decision 63). */
export const TEAM_GEN_RE = /^[a-f0-9]{8}$/
/** Role ids a definition may not use (actor names, CLI words). */
export const RESERVED_ROLE_IDS: readonly string[] = ['user', 'system', 'free', 'all', 'none', 'team']
/** repoId of the team's own repo; extra repos use their own ids. */
export const REPO_MAIN = 'main'
/** Comment target of the Lead conversation (every other target is a task id). */
export const LEAD_THREAD = 'lead'
/** Synthetic pane id of a run: CtlCaller.paneId/ptyId, the rate-limit key and the synthetic status. */
export const TEAM_PANE_PREFIX = 'team:'

export function teamPaneId(runId: string): string {
  return TEAM_PANE_PREFIX + runId
}

export function isTeamPaneId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(TEAM_PANE_PREFIX) && RUN_ID_RE.test(id.slice(TEAM_PANE_PREFIX.length))
}

/** n 1 -> roleId; n 2..4 -> `${roleId}-${n}` (decision 20). */
export function agentIdOf(roleId: string, n: number): string {
  return n <= 1 ? roleId : `${roleId}-${n}`
}

/** 1 for `<roleId>`, n for `<roleId>-n`, null when the id is not of that role. */
export function agentIndexOf(agentId: string, roleId: string): number | null {
  if (agentId === roleId) return 1
  if (!agentId.startsWith(`${roleId}-`)) return null
  const rest = agentId.slice(roleId.length + 1)
  if (!/^[0-9]$/.test(rest)) return null
  const n = Number(rest)
  return n >= 2 && n <= ROLE_COUNT_MAX ? n : null
}

export function taskIdOf(num: number): string {
  return `t-${num}`
}

/** The number of a task id, or null for anything else (a leading zero too: `t-07` is not `taskIdOf(7)`). */
export function taskNumOf(taskId: string): number | null {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return null
  const n = Number(taskId.slice(2))
  return taskIdOf(n) === taskId ? n : null
}

/** Worktree slug of a task: `t-<teamId.slice(3, 9)>-<n>`, passes WORKTREE_SLUG_RE; branch `sn/<slug>`. */
export function taskSlug(teamId: string, taskNum: number): string {
  return `t-${teamId.slice(3, 9)}-${taskNum}`
}

/** Session key of an agent: the task id, 'lead' for lead runs without a task, 'free' for free runs. */
export type SessionKey = string

export function sessionKeyOf(mode: RunMode, taskId?: string): SessionKey {
  if (mode === 'free') return 'free'
  if (taskId) return taskId
  return mode === 'lead' ? LEAD_THREAD : 'free'
}

// ---- caps (constants, never config) -----------------------------------------------------------
export const GLOBAL_MAX_RUNS = 3
export const TEAM_MAX_CONCURRENT = 3                 // effective = min(def.maxConcurrent, 3)
/** Agents of one role at most (`count` 1..4; the lead is 1). */
export const ROLE_COUNT_MAX = 4
export const TEAM_TASKS_MAX = 2000                   // live tasks (archived do not count)
export const TASK_COMMENTS_MAX = 200                 // per target; older DELIVERED ones go to archive/<target>.jsonl
export const TEAM_STATE_MAX_BYTES = 8 * 1024 * 1024
export const RUNS_META_MAX = 500                     // runs.json ring
export const RUN_LOG_MAX_BYTES = 20 * 1024 * 1024
/** The system row of RunLog's `snaos.cut` line, word for word (main sends it in English, the renderer words it; like CHAT_SKIPPED_TEXT). */
export const RUN_LOG_CUT_TEXT = '[Run log cut: the rest of this run is not kept on disk]'
/**
 * B5: a note main appends to a closed run's log (TeamService.runNote), the record `{ type: 'snaos.note', at, key, vars }`,
 * never a sentence. RunLog decodes it to a system row whose one text is runNoteText (the key and vars as JSON); the run
 * chat reads them back with runNoteOfText and words them through its own es/en keys.
 * - `blockStopped`: a Codex `snaos-team` block stopped at a refused action; vars `applied` and `total` (actions),
 *   `at` (the refused one, 1-based), `method` (its `team.*` method), `error` (the refusal's code) and, when the action
 *   held a live token of the app, `detail: 'secret'`.
 * - `blockStateFull`: the block was not applied, the team state would pass TEAM_STATE_MAX_BYTES; vars `mb` (that cap).
 */
export type RunNoteKey = 'blockStopped' | 'blockStateFull'
export const RUN_NOTE_KEYS: readonly RunNoteKey[] = ['blockStopped', 'blockStateFull']
export interface RunNote { key: RunNoteKey; vars: Record<string, string | number> }
/** A note's vars: at most this many, each a finite number or a one-line string of at most RUN_NOTE_VAR_MAX characters. */
const RUN_NOTE_VARS_MAX = 8
const RUN_NOTE_VAR_MAX = 120
const RUN_NOTE_VAR_NAME_RE = /^[a-z][A-Za-z0-9]{0,31}$/
const RUN_NOTE_VAR_BAD_RE = /[\u0000-\u001f\u007f]/

/** The note of a `snaos.note` record (or of anything shaped `{ key, vars }`), checked; null when it is not one. */
export function runNoteOf(v: unknown): RunNote | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const { key, vars } = v as { key?: unknown; vars?: unknown }
  if (typeof key !== 'string' || !(RUN_NOTE_KEYS as readonly string[]).includes(key)) return null
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return null
  const entries = Object.entries(vars as Record<string, unknown>)
  if (entries.length > RUN_NOTE_VARS_MAX) return null
  const out: Record<string, string | number> = {}
  for (const [name, value] of entries) {
    if (!RUN_NOTE_VAR_NAME_RE.test(name)) return null
    if (typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'string' || value.length > RUN_NOTE_VAR_MAX || RUN_NOTE_VAR_BAD_RE.test(value)) return null
    out[name] = value as string | number
  }
  return { key: key as RunNoteKey, vars: out }
}

/** The one text of a note's system row: `{"type":"snaos.note","key":...,"vars":{...}}`. */
export function runNoteText(n: RunNote): string {
  return JSON.stringify({ type: 'snaos.note', key: n.key, vars: n.vars })
}

/** The note a system row's text holds (runNoteText), else null: any other text, a key it does not know, bad vars. */
export function runNoteOfText(text: unknown): RunNote | null {
  if (typeof text !== 'string' || !text.startsWith('{"type":"snaos.note"')) return null
  try {
    return runNoteOf(JSON.parse(text))
  } catch {
    return null
  }
}
export const RUN_RING_MAX = 500                      // ChatMessages kept in memory per live run
export const TEAM_LOGS_MAX_BYTES = 200 * 1024 * 1024
export const TEAM_LOG_TTL_MS = 30 * 86_400_000
export const TEAM_TRASH_TTL_MS = 30 * 86_400_000
export const TASK_ARCHIVE_AFTER_MS = 30 * 86_400_000
export const TEAM_NAME_MAX = 60
export const GOAL_MAX = 8 * 1024
export const RULES_MAX = 16 * 1024
export const TASK_TITLE_MAX = 200
export const TASK_BODY_MAX = 16 * 1024
export const COMMENT_TEXT_MAX = 8 * 1024
export const TEAM_PLAN_MAX = 32 * 1024               // UTF-16 units, = PLAN_TEXT_MAX of types.ts
export const CARD_QUESTION_MAX = 2000
export const CARD_OPTIONS_MAX = 6
export const CARD_OPTION_MAX = 120
export const CARD_TEXT_ANSWER_MAX = 2000
export const DECIDE_NOTE_MAX = 2000
export const RUN_NOW_PROMPT_MAX = 16 * 1024
export const LEAD_REPLY_MAX = 4 * 1024               // final text of a lead run appended to the Lead thread
export const RUN_SUMMARY_MAX = 2000
export const BLOCKED_BY_MAX = 16
export const GRANTS_MAX = 32
export const DENIED_COMMAND_MAX = 300                // a permission approval's denied command (B5), redacted then cut
export const DENIED_COMMANDS_MAX = 10                // denied commands one permission approval keeps
export const DIFF_STAT_TOP_MAX = 8                   // files a task's diff stat lists (TaskDiffStat.top)
export const HIRE_TEXT_MAX = 64 * 1024
export const PROMPT_BUDGET_BYTES = 48 * 1024         // whole stdin (Codex new thread: instructions block included)
export const HANDOFF_BUDGET_BYTES = 8 * 1024         // fresh-session handoff share of stdin (decision 66)
export const SYSTEM_BUDGET_BYTES = 24 * 1024         // Claude system file
export const PARSER_LINE_MAX_BYTES = 16 * 1024 * 1024 // stdout lines fed to the parser (RunLog and ring still skip > MAX_RECORD_BYTES)
export const ORPHAN_START_SLACK_MS = 30_000          // decision 64: |process start - run.startedAt| allowed
export const TEAM_BLOCK_MAX_BYTES = 64 * 1024        // Codex ```snaos-team block
export const TEAM_BLOCK_ACTIONS_MAX = 21             // 20 non-terminal + 1 terminal
export const TEAM_READS_PER_MIN = 120
export const TEAM_WRITES_PER_MIN = 60

// ---- flow constants -----------------------------------------------------------------------------
export const QA_ROUNDS_MAX = 3
export const CONTINUATIONS_MAX = 1                   // decision 31
export const NO_PROGRESS_COOLDOWN_MIN: readonly number[] = [5, 10, 20]
export const NO_PROGRESS_BLOCK_AT = 4                // decision 32
export const RETRIES_MAX = 1                         // overloaded / request / unknown
export const RETRY_DELAY_MS = 2 * 60_000
export const LIMIT_FALLBACK_MS = 15 * 60_000
export const INTERRUPTS_MAX = 2
export const UNBLOCK_WAKES_PER_HOUR = 3
export const ROUTINE_CATCHUP_MS = 2 * 60 * 60_000
export const LINGER_MS = 5_000                       // after the first result line: treeKill what is left
export const CONCLUDE_GRACE_MS = 3 * 60_000          // after a terminal tool (decision 35)
export const DRAIN_MS = 3_000                        // `exit` without `close`
export const STOP_GRACE_MS = 10_000                  // stop requested -> force finalize
export const POSIX_KILL_GRACE_MS = 3_000             // SIGTERM -> SIGKILL of the group
export const TAKEOVER_BIND_MS = 2 * 60_000

// ---- enums ---------------------------------------------------------------------------------------
export type RoleKind = 'lead' | 'dev' | 'qa' | 'research' | 'custom'
export const ROLE_KINDS: readonly RoleKind[] = ['lead', 'dev', 'qa', 'research', 'custom']
export type PermissionProfile = 'total' | 'readonly' | 'custom'
export const PERMISSION_PROFILES: readonly PermissionProfile[] = ['total', 'readonly', 'custom']
export type TaskState = 'todo' | 'doing' | 'review' | 'done' | 'blocked' | 'cancelled'
export type TaskPhase = 'none' | 'planning' | 'planApproval' | 'executing' | 'qa' | 'userOk' | 'integrating'
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'
export const TASK_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'normal', 'low']
export const PRIORITY_RANK: Readonly<Record<TaskPriority, 0 | 1 | 2 | 3>> = { urgent: 0, high: 1, normal: 2, low: 3 }
export type Isolation = 'worktree' | 'main'
export type RunMode = 'plan' | 'exec' | 'qa' | 'lead' | 'free'
export type RunState = 'queued' | 'starting' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'takenOver'
export const RUN_ACTIVE: readonly RunState[] = ['queued', 'starting', 'running', 'stopping']

export function isActiveRun(s: RunState): boolean {
  return RUN_ACTIVE.includes(s)
}

export type RunOutcome = 'concluded' | 'progress' | 'planOnly' | 'empty' | 'failed'
export type StopReason = 'user' | 'takeover' | 'timeout' | 'concluded' | 'labsOff' | 'cliOff' | 'deleted' | 'taskMoved' | 'sessionConflict' | 'shutdown' | 'paused'
export type InterruptCause = 'shutdown' | 'crash' | 'labsOff' | 'cliOff' | 'sessionConflict'
export type TerminalTool = 'ask' | 'needs' | 'plan' | 'review' | 'verdict' | 'done' | 'approvePlan' | 'hire'
export type WakeReason =
  | 'assigned' | 'comment' | 'planApproved' | 'planRejected' | 'review' | 'changes' | 'finalRejected' | 'rebase'
  | 'answer' | 'grant' | 'unblocked' | 'continuation' | 'retry' | 'interrupted' | 'context' | 'routine'
  | 'userMessage' | 'kickoff' | 'triage' | 'leadApproval' | 'manual'
export type TaskField = 'title' | 'body' | 'priority' | 'assignee' | 'state' | 'blockedBy' | 'isolation' | 'repoId' | 'needsPlan'
export const TASK_FIELDS: readonly TaskField[] = ['title', 'body', 'priority', 'assignee', 'state', 'blockedBy', 'isolation', 'repoId', 'needsPlan']
export type BoardColumn = 'todo' | 'doing' | 'review' | 'done' | 'blocked'
export const BOARD_COLUMNS: readonly BoardColumn[] = ['todo', 'doing', 'review', 'done', 'blocked']

/** Plan 3.8 table: todo; doing (planning, planApproval, executing); review (qa, userOk, integrating); done; blocked; cancelled -> null. */
export function columnOf(t: { state: TaskState; phase: TaskPhase }): BoardColumn | null {
  switch (t.state) {
    case 'cancelled':
      return null
    case 'todo':
    case 'done':
    case 'blocked':
      return t.state
    default:
      if (t.phase === 'planning' || t.phase === 'planApproval' || t.phase === 'executing') return 'doing'
      if (t.phase === 'qa' || t.phase === 'userOk' || t.phase === 'integrating') return 'review'
      return t.state
  }
}

/**
 * Why a wanted run does not start now. Never persisted (plan 3.3). `treeBusy`: another run (or an integrate, or a
 * lingering orphan) holds the run's folder; `consoleBusy`: only a console of the user working there does (G6).
 */
export type DeferReason =
  | 'disabled' | 'untrusted' | 'cliOff' | 'paused' | 'agentPaused' | 'autonomyOff' | 'teamCap' | 'globalCap'
  | 'quota' | 'cooldown' | 'sessionBusy' | 'takenOver' | 'treeBusy' | 'consoleBusy' | 'running' | 'stopping'
export interface DeferInfo { reason: DeferReason; until?: number; taskId?: string }

/** Who did it. A user edit from the phone is still a user edit. */
export type Actor =
  | { kind: 'user'; via: 'desktop' | 'phone' }
  | { kind: 'agent'; agentId: string; runId: string; roleKind: RoleKind }
  | { kind: 'system' }

// ---- definition (parsed by teamDefinition.ts; frozen in the trusted snapshot) ---------------------
export interface DefFile { rel: string; text: string }    // rel under .snagentsos/team/, '/' separators, normalized text
export type DefErrorCode =
  | 'missing_team' | 'frontmatter' | 'unknown_key' | 'duplicate_key' | 'bad_value' | 'required' | 'too_large'
  | 'too_many' | 'bad_name' | 'reserved_name' | 'no_lead' | 'two_leads' | 'lead_count' | 'cron' | 'cron_interval'
  | 'routine_role' | 'repo' | 'tool_pattern' | 'bad_model' | 'bad_effort' | 'link' | 'io'
/** An `error` makes the definition invalid (no trust, no write, no run); a `warning` is only shown and never blocks. */
export type DefSeverity = 'error' | 'warning'
/**
 * One problem of the repo definition, rendered as t(`teams.def.issue.${code}`, {file, line, key, detail}).
 * `line` is 1-based; 0 means the whole file or folder (a cap, a missing file, a folder-level rule).
 * Every issue main returns carries its severity (warnings travel in the same lists as errors).
 */
export interface DefError { file: string; line: number; key?: string; code: DefErrorCode; detail?: string; severity: DefSeverity }
export interface ExtraRepo { id: string; path: string; baseBranch?: string; verify?: string }   // path: text as written (syntax only)
/** A repo after main resolved it (decision 62, TeamService.repoOf): the only shape git, worktree and lock code accepts. */
export interface ResolvedRepo { repoId: string; repoRoot: string /* git main root, canonical */; baseBranch: string; verify?: string }
export interface RoutineDef { id: string; cron: string; action: 'wake' | 'task'; role: string; title?: string; prompt: string; enabled: boolean }
export interface RoleDefinition {
  id: string; name: string; kind: RoleKind; provider: AgentProvider
  model?: string                                   // claude: isClaudeModel; codex: CODEX_MODEL_RE; 'default' = omitted
  effort?: string                                  // claude: CLAUDE_EFFORTS; codex: CODEX_EFFORTS
  permission: PermissionProfile
  allowedTools?: string[]                          // only with permission 'custom'; each validToolPattern
  count: number                                    // 1..4; the lead is 1
  instructions: string                             // body of roles/<id>.md
}
export interface TeamDefinition {
  name: string; goal: string; rules: string; baseBranch?: string; verify?: string
  verifyTimeoutMin: number                         // 5..60, default 20
  maxRunMinutes: number                            // 5..120, default 45
  maxConcurrent: number                            // 1..3, default 2
  leadApprovesSmallPlans: boolean                  // default true
  extraRepos: ExtraRepo[]                          // <= 4
  routines: RoutineDef[]                           // <= 16
  roles: RoleDefinition[]                          // <= 12, exactly one kind 'lead'
}
/** What TeamTrust keeps: the parsed definition the runs read (decision 34). */
export interface TrustedDefinition { def: TeamDefinition; sha256: string; goalHash: string; trustedAt: number; files: DefFile[] }

// ---- runtime (dataDir()/teams/<teamId>/state.json; main only, never sent raw) ----------------------
export const TEAM_STATE_VERSION = 1
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number }
export interface RunUsage extends PaneUsage {
  /** How the delta was obtained (decision 9). */
  basis: 'sinceLastResult' | 'delta' | 'absolute' | 'partial'
  /** A takeover may have added interactive turns to the cumulative base. */
  approx?: true
  reasoningTokens?: number
}
export interface AgentSession {
  provider: AgentProvider
  sessionId: string                                // Claude: uuid minted by main; Codex: thread_id
  cwd: string                                      // every run of this session uses exactly this cwd (I20)
  createdAt: number
  turns: number                                    // runs that reached `running`
  sysHash: string                                  // sha256 of systemText(); a different one starts a fresh session (decision 33)
  costTotal?: number                               // Claude cumulative total_cost_usd last seen
  tokensTotal?: TokenTotals                        // cumulative tokens last seen (Claude: the result's modelUsage summed; Codex: turn.completed.usage)
  baseStale?: true                                 // set on takeover release: the next delta is approx
  lastRunId?: string
  /** Lead sessions (B5): the goal hash this session last read (decision 43); a resumed Lead run gets the goal again when it differs. */
  goalHash?: string
}
/** A durable level: "this agent should run this mode for this reason" (plan 3.7 candidates). */
export interface WakeMark { agentId: string; mode: RunMode; reason: WakeReason; since: number; notBefore?: number; refs?: string[]; bypassCooldown?: true; detail?: string }
export type Takeover =
  | { phase: 'stopping'; at: number; runId: string; sessionKey: SessionKey }
  | { phase: 'bindPending'; at: number; sessionKey: SessionKey; sessionId: string; provider: AgentProvider; cwd: string; workspaceId?: string }
  | { phase: 'bound' | 'releasing'; at: number; sessionKey: SessionKey; sessionId: string; provider: AgentProvider; cwd: string; paneId: string; workspaceId: string }
export interface AgentState {
  id: string; roleId: string; roleKind: RoleKind; provider: AgentProvider
  status: 'idle' | 'running' | 'takenOver'
  paused: boolean
  retired?: true                                   // role or count gone from the trusted definition; removed once idle
  runId?: string
  sessions: Record<SessionKey, AgentSession>
  next?: WakeMark                                  // task-less wake (lead, free routines)
  interrupts: number                               // task-less interruption streak
  takeover?: Takeover
  /** B5: a run of this agent was denied a `snaos team` call through the PowerShell tool; its next run is told to use the Bash tool. */
  bashHint?: true
  /** B5: a run of this agent was denied a shell or inline-code command no grant ever allows (teamArgv isShellEscape); its next run is told it needs the user. */
  escapeHint?: true
}
export type CardReason =
  | 'noProgress' | 'qaRounds' | 'qaNoVerdict' | 'interrupted' | 'failure' | 'timeout' | 'stalled' | 'depCancelled'
  | 'unblockLimit' | 'cwdMissing' | 'sessionConflict' | 'auth' | 'billing' | 'stateReset' | 'spawnFailed' | 'cliOff' | 'orphan'
export type BlockedReason =
  | { kind: 'deps' }
  | { kind: 'user'; text?: string; by?: 'lead' }   // by 'lead': the Lead's `team task update --state blocked` (T19); absent: the user's move (T18)
  | { kind: 'stopped'; runId: string }
  | { kind: 'card'; cardId: string; why: CardReason }
export interface TaskCounters { noProgress: number; continuations: number; retries: number; interrupts: number; unblockWakes: number; unblockWindowStart: number }
export interface TaskWorktree { path: string; branch: string; base: string /* full sha */; baseBranch: string; slug: string; createdAt: number; owner: string /* manifest owner, decision 63 */ }

/** teamWorktreeOwner(teamId, gen, taskId) = `team:${teamId}:${gen}:${taskId}`; the prefix `team:${teamId}:` disowns a removed team. */
export function teamWorktreeOwner(teamId: string, gen: string, taskId: string): string {
  return `team:${teamId}:${gen}:${taskId}`
}

export interface TaskPlan { rev: number; text: string; status: 'pending' | 'approved' | 'rejected'; small: boolean; at: number; approvalId?: string; decidedBy?: Actor }
export interface TaskGrant { roleId: string; tool: string; at: number; approvalId: string }
/** B5: the diff stat a QA run of the task read (RunStarter, `git diff --numstat` of what QA reviews); the final OK shows it. */
export interface TaskDiffStat { files: number; insertions: number; deletions: number; top: Array<{ path: string; add: number; del: number }>; at: number }
export type IntegrateStep = 'preflight' | 'temp' | 'merge' | 'verify' | 'land' | 'cleanup'
export type IntegrateError =
  | 'missing_worktree' | 'dirty_worktree' | 'in_progress' | 'wrong_branch' | 'busy' | 'merge_conflict' | 'no_identity'
  | 'verify_failed' | 'verify_timeout' | 'base_moved' | 'base_dirty' | 'base_busy' | 'base_checked_out_elsewhere'
  | 'git_error' | 'timeout' | 'interrupted'
/**
 * A failed one (B6 review, second round) also keeps `step` (where it failed), `verifyNote` (what the verify runner
 * itself had to do on this attempt, also when it failed at a later step) and `landing` (a failure at step land whose
 * mode was known: ffOnly lands through the user's checkout, updateRef moves only the branch).
 */
export interface IntegrateStatus {
  state: 'idle' | 'running' | 'failed'; attempt: number; step?: IntegrateStep; error?: IntegrateError; files?: string[]; tail?: string
  verifyNote?: VerifyNote; landing?: 'ffOnly' | 'updateRef'; at: number
}
export interface TeamTask {
  id: string; rev: number
  title: string; body: string
  state: TaskState; phase: TaskPhase               // while blocked: phase = blocked.resume.phase
  priority: TaskPriority
  assignee?: string                                // agent id, never the lead
  repoId: string; isolation: Isolation; needsPlan: boolean
  frozen?: true                                    // repoId and isolation fixed after the first admission (I19)
  worktree?: TaskWorktree
  blockedBy: string[]; parentId?: string
  createdBy: Actor; createdAt: number; updatedAt: number; stateSince: number
  plan?: TaskPlan
  review: { round: number; max: number; lastVerdict?: 'approve' | 'changes'; qaAgentId?: string }
  userOwned: TaskField[]
  counters: TaskCounters
  cooldownUntil?: number
  next?: WakeMark                                  // one durable slot per task
  blocked?: { reason: BlockedReason; resume: { state: TaskState; phase: TaskPhase }; at: number }
  grants?: TaskGrant[]
  diffStat?: TaskDiffStat                          // B5: the last QA diff stat (absent until a QA run read one)
  integrate?: IntegrateStatus
  integrated?: { mergeSha: string; base: string; at: number; landed: 'ffOnly' | 'updateRef' | 'alreadyMerged' }
  triagedAt?: number
}
export type CommentKind = 'comment' | 'review' | 'system' | 'answer'
/**
 * Keys of main-authored comments (decision 65). Each milestone that writes one adds it here (B1-shared writes the B3..B6
 * ones up front), to SYS_TEXT_EN (teamPrompt.ts) and to `teams.sys.*` in i18n/teams/board.ts and i18nTeams.ts.
 */
export type SysKey =
  | 'noQaRole'            // T7: no QA role, straight to the user's OK
  | 'hireRejected'        // 4.3 hire reject, lead thread; vars {roleId}
  | 'rebaseConflict'      // T15 why conflict; vars {files}
  | 'rebaseVerify'        // T15 why verify; vars {tail}
  | 'leadEscalation'      // reconcileTasks: a lead-decided approval handed to the user; vars {taskId}
/** A main-authored comment: rendered as t(`teams.sys.${key}`, vars); the model gets SYS_TEXT_EN[key]. */
export interface SysText { key: SysKey; vars?: Record<string, string | number> }
export interface TeamComment {
  id: string; target: string                       // task id | LEAD_THREAD
  author: Actor; kind: CommentKind; at: number
  text: string                                     // agent and user text only; '' when `sys` is set
  sys?: SysText                                    // every comment main writes (author system, or a system note in a review)
  forAgent?: string                                // recipient fixed at write time; undefined wakes nobody
  deliveredRunId?: string                          // forAgent && !deliveredRunId = queued for forAgent
}
export type ApprovalKind = 'plan' | 'final' | 'hire' | 'permission' | 'integrate'
export type ApprovalState = 'pending' | 'applying' | 'approved' | 'rejected' | 'cancelled'
export interface ApprovalBase {
  id: string; taskId?: string; state: ApprovalState
  decider: 'user' | 'lead'                         // who is expected; the user may always decide (decision 29)
  createdAt: number; createdBy: Actor; decidedAt?: number; decidedBy?: Actor; note?: string; error?: string
  leadSeenRunId?: string                           // a lead run already got it in its prompt
}
export type TeamApproval = ApprovalBase & (
  | { kind: 'plan'; payload: { planRev: number; small: boolean } }
  | { kind: 'final'; payload: { hasWorktree: boolean; summary: string } }
  | { kind: 'hire'; payload: { roleId: string; text: string; sha256: string; baseDefHash: string; replaces: boolean } }
  | { kind: 'permission'; payload: { roleId: string; runId: string; tools: string[]; denied?: string[] /* B5: shell commands denied, redacted, DENIED_COMMANDS_MAX x DENIED_COMMAND_MAX */ } }
  | { kind: 'integrate'; payload: { branch: string; base: string } }
)
export type CardAction = 'retry' | 'resume' | 'toTodo' | 'cancelTask' | 'stopRun' | 'keepWaiting' | 'dropBlocker' | 'resumeTeam' | 'newSession' | 'killOrphan' | 'dismiss'
/** Card actions the phone may not run (decision 50): main answers forbidden from origin phone. */
export const DESKTOP_ONLY_CARD_ACTIONS: readonly CardAction[] = ['resumeTeam', 'killOrphan']
export interface CardAnswer { choices?: number[]; text?: string; confirm?: boolean; action?: CardAction }
export interface TeamCard {
  id: string; taskId?: string; kind: 'choice' | 'text' | 'confirm'
  question: string                                 // agent text (redacted before any notice); '' for system cards
  options: string[]; multi: boolean
  state: 'open' | 'answered' | 'dismissed'
  from:
    | { kind: 'agent'; agentId: string; runId: string; tool: 'ask' | 'needs' }
    | { kind: 'system'; why: CardReason; runId?: string; actions: CardAction[]; vars?: Record<string, string | number> }
  answer?: CardAnswer & { by: Actor; at: number }
  consumedRunId?: string                           // agent card: the run that received the answer
  createdAt: number
}
export interface QueueItem { id: string; agentId: string; taskId?: string; sessionKey: SessionKey; mode: RunMode; reason: WakeReason; refs?: string[]; createdAt: number; approvedAt?: number; approvedBy?: Actor }
/** `git rev-parse HEAD` plus sha256 of `status --porcelain=v2 -z --untracked-files=all` of the run cwd. */
export interface TreeMark { head: string; status: string }
export interface Run {
  id: string; agentId: string; roleId: string; roleKind: RoleKind; taskId?: string; sessionKey: SessionKey
  provider: AgentProvider; model?: string; effort?: string; profile: PermissionProfile
  sessionId?: string                               // Claude: set at admission; Codex new thread: set by thread.started
  resumed: boolean; cwd: string; repoId: string
  mode: RunMode; trigger: { reason: WakeReason; refs?: string[]; by: Actor['kind'] }; continuationOf?: string
  state: RunState; stopReason?: StopReason; interruptCause?: InterruptCause
  reachedRunning: boolean; resultSeen: boolean
  pid?: number                                     // never signalled after a restart without the start-time match of decision 64
  queuedAt: number; startedAt?: number; firstLineAt?: number; resultAt?: number; endedAt?: number
  lastLineAt?: number                              // written only on real commits; live value in RunSupervisor memory (3.5)
  treeBefore?: TreeMark                            // writer runs: the tree at prep, compared at close (decision 68)
  treeMoved?: boolean                              // set at close from treeBefore vs the tree then
  exit?: { code: number | null; signal: string | null }
  failure?: FailureInfo; outcome?: RunOutcome
  usage?: RunUsage; context?: PaneContext; digest?: TurnDigest; summary?: string   // summary <= RUN_SUMMARY_MAX, redacted
  concludedBy?: { tool: TerminalTool; at: number }
  delivered?: { comments: string[]; cards: string[]; approvals: string[] }
  denials?: Array<{ tool: string; count: number }>
  logBytes?: number; logTruncated?: true
  silenceAckedAt?: number
  /** Lead runs (B5): the goal hash the prompt carried (markStarting), recorded on the session once it runs (R5). */
  goalHash?: string
}
export interface TeamPause { reason: 'user' | 'auth' | 'billing'; at: number; cardId?: string; failure?: FailureInfo }
export interface RoutineState { lastScheduledFor?: number; lastFiredAt?: number; lastRunId?: string; lastTaskId?: string; skippedFor?: number }
export interface TeamRuntime {
  v: typeof TEAM_STATE_VERSION; teamId: string; rev: number
  gen: string                                      // 8 hex minted by main (randomBytes) for emptyRuntime: a re-created team never adopts the old team's worktrees (decision 63)
  autoDispatch: boolean                            // default false
  paused: TeamPause | null
  verifyConfirmed: Record<string, { command: string; sha256: string; at: number }>   // by repoId
  agents: AgentState[]
  tasks: TeamTask[]
  comments: Record<string, TeamComment[]>          // key: task id | LEAD_THREAD
  approvals: TeamApproval[]
  cards: TeamCard[]
  queue: QueueItem[]
  activeRuns: Run[]                                // RUN_ACTIVE only (I1); terminal runs go to runs.json
  providerBlockedUntil: Partial<Record<AgentProvider, number>>
  nextIds: { task: number; comment: number; approval: number; card: number; queue: number }
  routines: Record<string, RoutineState>
  archivedTasks: Record<string, 'done' | 'cancelled'>
  goalSeenHash?: string
  workspaceId?: string                             // workspace bound by the first takeover
  needsSeen?: string[]                             // TeamStore only: need row ids already notified (3.1 Notices baseline)
}

/** A fresh runtime at rev 0 with every id counter at 1. Pure: the caller mints gen (TEAM_GEN_RE). */
export function emptyRuntime(teamId: string, gen: string): TeamRuntime {
  return {
    v: TEAM_STATE_VERSION,
    teamId,
    rev: 0,
    gen,
    autoDispatch: false,
    paused: null,
    verifyConfirmed: {},
    agents: [],
    tasks: [],
    comments: {},
    approvals: [],
    cards: [],
    queue: [],
    activeRuns: [],
    providerBlockedUntil: {},
    nextIds: { task: 1, comment: 1, approval: 1, card: 1, queue: 1 },
    routines: {},
    archivedTasks: {},
  }
}

// ---- dispatch and policy shapes (declared HERE by B1-shared, copied verbatim from section 2.9, so B2 code can use them
// before B4; teamDispatch.ts re-exports them and owns only the functions) ----
export interface RunRequest {
  agentId: string; taskId?: string; sessionKey: SessionKey; mode: RunMode
  reason: WakeReason; refs?: string[]; detail?: string; since: number; priority: TaskPriority
  queueItemId?: string; approved: boolean; bypassCooldown: boolean
}
export interface Deferred { request: RunRequest; reason: DeferReason; until?: number }
export interface DispatchFacts {
  now: number
  enabled: boolean                                 // labs.teams on, the service not frozen and not installing
  trusted: boolean                                 // the cached trust state (decision 69), never a disk read
  cliReady: boolean                                // CliService.running && shimExists() (decision 71)
  globalActive: number                             // active runs of ALL teams, admissions of earlier teams in this pass included
  claudeBlockedUntil: number | null                // claudeAllLimited -> earliest reset, else null
  busySessions: ReadonlySet<string>                // session ids held by a live pane (sessionHolder) or a lingering orphan (decision 64)
  busyCwds: ReadonlySet<string>                    // cwd keys with a human console in working/action
  writerCwds: ReadonlySet<string>                  // cwd keys held by an active writer run of ANY team (WriteLocks) or a lingering orphan
  integrateCwds: ReadonlySet<string>               // cwd keys held by an integrate (holder 'integrate:<taskId>'): temp tree, task worktree, repo root while landing
  cwdKeys: Readonly<Record<SessionKey, string>>    // sessionKey -> normalized cwd key of the run it would start
  manual: ReadonlyArray<{ agentId: string; taskId?: string; reason: 'manual' | 'kickoff'; detail?: string }>
}
export interface DispatchPlan {
  start: RunRequest[]                              // admission order
  enqueue: RunRequest[]                            // autonomy off, no queue item yet
  deferred: Deferred[]                             // UI chips (AgentView.waiting, QueueItemView.defer); never persisted
  nextAt: number | null                            // earliest `until` among deferred
}
export interface RunEvidence {
  state: RunState; isError: boolean; maxTurns: boolean; finalText: string
  digest: TurnDigest                               // `snaos team` calls excluded by the parser (TEAM_CALL_RE, 3.5)
  teamWrites: number; concluded: boolean; mode: RunMode; roleKind: RoleKind
  fileEdits: number                                // Claude Edit/Write/MultiEdit/NotebookEdit tool_use, Codex file_change items
  treeMoved?: boolean                              // writer runs: TreeMark at prep !== TreeMark at close (Run.treeMoved)
}
export interface RunEndFacts {
  run: Pick<Run, 'id' | 'agentId' | 'roleKind' | 'taskId' | 'sessionKey' | 'mode' | 'provider' | 'state' | 'stopReason' | 'interruptCause' | 'failure' | 'outcome' | 'continuationOf' | 'trigger' | 'concludedBy' | 'reachedRunning' | 'startedAt' | 'endedAt'>
  task?: Pick<TeamTask, 'id' | 'state' | 'phase' | 'counters' | 'assignee' | 'review'>
  agentInterrupts: number
  now: number
  claudeCanSwitch: boolean                         // autoSwitch on and another usable account
  claudeSwitchedAt?: number                        // last account switch (decision 40)
  unknownSession: boolean                          // parser: "No conversation found" / unknown thread
}
export interface PolicyDecision {
  next?: WakeMark | null                           // undefined leave, null clear (task.next or agent.next)
  counters?: Partial<TaskCounters>
  cooldownUntil?: number
  /** No card: the task blocks with its reason alone (a user's Frenar, decision 38: the drawer resumes it, nothing in Te necesita). */
  block?: { reason: BlockedReason; card?: { why: CardReason; actions: CardAction[] } }
  providerBlock?: { provider: AgentProvider; until: number }
  pauseTeam?: 'auth' | 'billing'
  freshSession?: boolean                           // drop agent.sessions[sessionKey]
  undeliver?: boolean
  agentInterrupts?: number
}
