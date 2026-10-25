/**
 * Teams wire contract (app 2.7.0, Tanda B): the one `teams:req` invoke
 * (`TeamRequest -> TeamReply`), its push events and the phone subset
 * (`teamReq` / `teamRes` carry the same shapes). Zod-free and type-only so
 * `remote-protocol.ts` can `import type` it; main validates every request with
 * `team-protocol-schemas.ts` (main only).
 *
 * Views are built by main (`src/main/teams/views.ts`), never the raw runtime;
 * the fields marked "desktop only" never reach the phone.
 */
import type { ChatMessage } from './chat-types'
import type { FailureInfo } from './failure'
import type { AgentProvider, PaneContext, PaneSilence, PaneUsage } from './types'
import type { TurnDigest } from './toolActivity'
import type { WsNoteMeta } from './ws-notes'
import type {
  AgentState, ApprovalState, BlockedReason, BoardColumn, CardAction, CardAnswer, CardReason, CommentKind, DefError,
  DeferInfo, IntegrateError, IntegrateStatus, IntegrateStep, Isolation, PermissionProfile, RoleKind, RunMode,
  RunOutcome, RunState, SysText, Takeover, TaskField, TaskPhase, TaskPlan, TaskPriority, TaskState, TeamCard,
  TeamPause, TeamTask, TerminalTool, WakeReason,
} from './teams'
import type { TeamDefinitionDiff, TeamFileDiff, TeamRiskFlag } from './teamDiff'
import type { TeamSetupDraft } from './teamDefinition'

// ---- views (main builds them in views.ts; never the raw runtime; desktop paths never reach the phone) ----
export type TeamTrustState = 'trusted' | 'untrusted' | 'changed' | 'invalid' | 'missing'
export interface RoleSummary { id: string; name: string; kind: RoleKind; provider: AgentProvider; model?: string; effort?: string; permission: PermissionProfile; count: number }
export interface TeamTakeoverRef { paneId: string; agentId: string; agentName: string; taskId?: string; at: number }
/** Sidebar row and phone Home card. */
export interface TeamListItem {
  id: string; name: string; repoName: string; trust: TeamTrustState; paused: TeamPause | null; autoDispatch: boolean
  agents: number; running: number; needsCount: number; rev: number
  repoRoot: string; takeovers: TeamTakeoverRef[]; workspaceId?: string      // desktop only
}
export type PhoneTeamListItem = Omit<TeamListItem, 'repoRoot' | 'takeovers' | 'workspaceId'>
export interface TeamView {
  id: string; name: string; repoRoot: string; repoName: string; baseBranch: string
  extraRepos: Array<{ id: string; name: string; baseBranch: string }>
  goal: string; trust: TeamTrustState; defIssues: DefError[]
  autoDispatch: boolean; paused: TeamPause | null; maxConcurrent: number; maxRunMinutes: number; leadApprovesSmallPlans: boolean
  verify: Array<{ repoId: string; command: string; confirmed: boolean }>
  roles: RoleSummary[]; rev: number; needsCount: number; running: number
  providerBlockedUntil: Partial<Record<AgentProvider, number>>
  usageToday?: PaneUsage                           // sum of today's run deltas (local day), estimated
  workspaceId?: string
}
export interface TaskBlockedView {
  kind: BlockedReason['kind']; why?: CardReason; text?: string; waitingOn?: string[]
  /** kind 'user' only: who parked it, the Lead (`team task update --state blocked`) or the user (a move). */
  by?: 'lead' | 'user'
}
export interface TaskRunRef { id: string; agentId: string; mode: RunMode; state: RunState; startedAt?: number; silence?: PaneSilence }
export interface TaskSummary {
  id: string; rev: number; title: string; state: TaskState; phase: TaskPhase; column: BoardColumn | null; priority: TaskPriority
  assignee?: string; repoId: string; isolation: Isolation; needsPlan: boolean
  blockedBy: string[]; blocked?: TaskBlockedView; parentId?: string
  createdBy: 'user' | 'system' | string /* agent id */; createdAt: number; updatedAt: number; stateSince: number
  userOwned: TaskField[]; review?: { round: number; max: number }
  branch?: string; integrated?: boolean
  run?: TaskRunRef
  needs: number                                    // teamNeedsRows rows with this taskId
  comments: number; queued: number                 // queued = not yet delivered to its recipient
}
export interface PlanView { rev: number; text: string; status: TaskPlan['status']; small: boolean; decidedBy?: 'user' | 'lead'; at: number; truncated?: boolean }
export interface CommentView {
  id: string; author: 'user' | 'system' | string /* agent id */; authorName: string; kind: CommentKind; text: string; sys?: SysText; at: number; queued: boolean
  /** The agent main fixed as the recipient when the comment was written (4.5); a later reassignment never changes it. Absent: for nobody. */
  recipient?: string; recipientName?: string
}   // sys set -> render t(`teams.sys.${sys.key}`, sys.vars), never `text`
export interface DiffStat { files: number; insertions: number; deletions: number; top: Array<{ path: string; add: number; del: number }> }
export interface RunView {
  id: string; agentId: string; roleId: string; taskId: string | null; mode: RunMode; trigger: WakeReason
  state: RunState; outcome?: RunOutcome; provider: AgentProvider; model?: string; effort?: string; resumed: boolean
  queuedAt: number; startedAt?: number; endedAt?: number; lastLineAt?: number
  failure?: FailureInfo; silence?: PaneSilence; usage?: PaneUsage; context?: PaneContext; digest?: TurnDigest
  summary?: string; concludedBy?: TerminalTool
}
export interface AgentView {
  id: string; roleId: string; roleName: string; kind: RoleKind; index: number
  provider: AgentProvider; model?: string; effort?: string; permission: PermissionProfile
  status: AgentState['status']; paused: boolean; retired: boolean; taskId?: string
  run?: RunView; lastRun?: RunView
  waiting?: DeferInfo                              // planDispatch dry run (B4); absent when nothing is pending
  takeover?: { phase: Takeover['phase']; paneId?: string; at: number }
  context?: PaneContext
}
export type ApprovalPayloadView =
  | { kind: 'plan'; planRev: number; small: boolean; text: string; truncated?: boolean }
  | { kind: 'final'; summary: string; stat?: DiffStat }
  | { kind: 'hire'; roleId: string; diff: TeamFileDiff; risks: TeamRiskFlag[] }
  | { kind: 'permission'; roleId: string; tools: string[] }
  | { kind: 'integrate'; branch: string; base: string; ahead?: number; lastError?: IntegrateError }
export interface ApprovalView { id: string; taskId?: string; state: ApprovalState; decider: 'user' | 'lead'; requestedBy: string; at: number; error?: string; payload: ApprovalPayloadView }
export interface CardView {
  id: string; taskId?: string; agentId?: string; kind: TeamCard['kind']; state: TeamCard['state']; at: number
  question?: string; options?: string[]; multi?: boolean
  system?: { why: CardReason; vars?: Record<string, string | number>; actions: CardAction[] }
  answer?: CardAnswer
}
export interface QueueItemView { id: string; agentId: string; taskId?: string; reason: WakeReason; mode: RunMode; priority: TaskPriority; at: number; approved: boolean; defer?: DeferInfo }
/** TaskSummary's `comments` count becomes the comment list here (the count is `comments.length + commentsArchived` plus older pages). */
export interface TaskDetail extends Omit<TaskSummary, 'comments'> {
  body: string; plan?: PlanView
  reviewInfo: { round: number; max: number; lastVerdict?: 'approve' | 'changes'; qaAgentId?: string }
  worktree?: { path?: string /* desktop only */; branch: string; base: string; baseBranch: string; ahead?: number; behind?: number; exists: boolean }
  comments: CommentView[]; commentsCursor: string | null; commentsArchived: number
  runs: RunView[]                                  // newest 10
  approvals: ApprovalView[]; cards: CardView[]; grants?: string[]
  integrate?: IntegrateStatus; integratedInfo?: TeamTask['integrated']
  truncated?: { body?: boolean; plan?: boolean; comments?: number }
}
export interface TeamNeedsView {
  teamId: string; rev: number; trust: TeamTrustState; trustSince?: number; paused: TeamPause | null
  approvals: ApprovalView[]; cards: CardView[]; queue: QueueItemView[]
  tasks: Record<string, { title: string; state: TaskState; phase: TaskPhase }>
}
export interface TeamBoardPage { teamId: string; rev: number; tasks: TaskSummary[]; cursor: string | null; done: boolean; counts: Record<BoardColumn, number>; cancelled: number }
export interface LeadView { messages: CommentView[]; cursor: string | null; agent: AgentView | null }
export interface RoutineView { id: string; cron: string; action: 'wake' | 'task'; role: string; title?: string; enabled: boolean; nextAt: number | null; last?: { at: number; runId?: string; taskId?: string; skipped?: true } }

// ---- setup, trust ----
export interface TeamFilePreview { rel: string; text: string; bytes: number }
export type SetupWarning = 'totalBypass' | 'codexTotal' | 'codexReadonlyBlock' | 'noVerify' | 'notCommitted'
export interface SetupProbe {
  repoRoot: string; repoName: string; branch: string | null; branches: string[]
  registered?: string                              // team id already registered for this repo
  existing?: { sha256: string; files: TeamFilePreview[]; issues: DefError[]; diff: TeamDefinitionDiff }
  suggestedVerify?: string
  defaults: TeamSetupDraft
}
export interface SetupPreview { files: TeamFilePreview[]; hash: string; issues: DefError[]; warnings: SetupWarning[] }
export interface TrustDiff { sha256: string; approvedSha?: string; diff: TeamDefinitionDiff; issues: DefError[] }

// ---- integrate, takeover ----
export type IntegrateStepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
export interface IntegratePreview {
  branch: string; base: string; tip: string; baseTip: string; ahead: number; behind: number; stat: DiffStat
  alreadyMerged: boolean
  verify: { command: string; confirmed: boolean } | { suggested?: string }
  landing: { mode: 'ffOnly' | 'updateRef' } | { blocked: IntegrateError; path?: string }
  touchesDefinition: boolean                       // the merge changes .snagentsos/team/: landing it makes the team untrusted
  error?: IntegrateError                           // preflight failure: Integrar disabled
}
export interface IntegrateProgressEvt {
  teamId: string; taskId: string; integrationId: string; step: IntegrateStep; state: IntegrateStepState; at: number
  logTail?: string                                 // verify output tail, redacted, <= 8 KB
  files?: string[]; error?: IntegrateError; mergeSha?: string; landing?: 'ffOnly' | 'updateRef' | 'alreadyMerged'
}
/**
 * workspaceId is chosen by main (plan 3.10.2): rt.workspaceId when it still exists in config, else the first config
 * workspace whose cwd samePathKey-matches the task worktree or the repo root; absent -> the renderer creates "Equipo <nombre>".
 */
export interface TakeoverGrant { provider: AgentProvider; sessionId: string; cwd: string; workspaceId?: string; agentName: string; teamName: string; taskId?: string; title: string }

// ---- requests ----
export interface TaskDraft { title: string; body?: string; assignee?: string; repoId?: string; isolation?: Isolation; blockedBy?: string[]; priority?: TaskPriority; needsPlan?: boolean }
export type TaskPatch = Partial<{
  title: string; body: string; assignee: string | null; priority: TaskPriority; blockedBy: string[]
  isolation: Isolation; needsPlan: boolean; repoId: string
}>
export type TeamRequest =
  // B1
  | { op: 'list' }
  | { op: 'get'; teamId: string }
  | { op: 'setupProbe'; dir: string }
  | { op: 'setupPreview'; repoRoot: string; draft: TeamSetupDraft }
  | { op: 'setupWrite'; repoRoot: string; draft: TeamSetupDraft; previewHash: string }
  | { op: 'adopt'; repoRoot: string; sha256: string }
  | { op: 'trustDiff'; teamId: string }
  | { op: 'trust'; teamId: string; sha256: string }
  | { op: 'remove'; teamId: string }
  | { op: 'settings'; teamId: string; patch: { autoDispatch?: boolean; paused?: boolean } }
  | { op: 'reveal'; teamId: string; what: 'definition' | 'data' }
  // B2
  | { op: 'roster'; teamId: string }
  | { op: 'runNow'; teamId: string; agentId: string; taskId?: string; prompt?: string }
  | { op: 'stop'; teamId: string; runId: string }
  | { op: 'pauseAgent'; teamId: string; agentId: string; on: boolean }
  | { op: 'runs'; teamId: string; agentId?: string; taskId?: string; before?: number }
  | { op: 'runPage'; teamId: string; runId: string; before?: string /* ^\d{1,15}$ byte offset */ }
  | { op: 'watchRun'; teamId: string; runId: string | null }
  // B3
  | { op: 'board'; teamId: string; column?: BoardColumn; cursor?: string; limit?: number }
  | { op: 'task'; teamId: string; taskId: string; commentsBefore?: string }
  | { op: 'createTask'; teamId: string; task: TaskDraft }
  | { op: 'updateTask'; teamId: string; taskId: string; baseRev: number; patch: TaskPatch }
  | { op: 'moveTask'; teamId: string; taskId: string; baseRev: number; to: 'todo' | 'blocked' | 'done' | 'cancelled'; priority?: TaskPriority; stopRun?: boolean; text?: string }
  | { op: 'releaseOwned'; teamId: string; taskId: string; fields: TaskField[] }
  | { op: 'comment'; teamId: string; taskId: string; text: string }
  | { op: 'lead'; teamId: string; before?: string }
  | { op: 'leadSay'; teamId: string; text: string }
  // B4
  | { op: 'dispatch'; teamId: string; queueId: string /* QUEUE_ID_RE or 'all' */; go: boolean }
  | { op: 'kickoff'; teamId: string }
  // B5
  | { op: 'needs'; teamId: string }
  | { op: 'decide'; teamId: string; approvalId: string; decision: 'approve' | 'reject'; note?: string }
  | { op: 'answer'; teamId: string; cardId: string; answer: CardAnswer }
  // B6
  | { op: 'integratePreview'; teamId: string; taskId: string }
  | { op: 'integrate'; teamId: string; taskId: string; expectTip: string }
  | { op: 'askRebase'; teamId: string; taskId: string; why: 'conflict' | 'verify' }
  | { op: 'confirmVerify'; teamId: string; repoId: string; command: string }
  | { op: 'removeWorktree'; teamId: string; taskId: string }
  // B7
  | { op: 'routines'; teamId: string }
  | { op: 'routineRun'; teamId: string; routineId: string }
  | { op: 'notes'; teamId: string }
  | { op: 'note'; teamId: string; noteId: string }
  | { op: 'runSilenceAck'; teamId: string; runId: string }
  // B9
  | { op: 'takeover'; teamId: string; agentId: string }
  | { op: 'takeoverBound'; teamId: string; agentId: string; paneId: string; workspaceId: string }
  | { op: 'takeoverAbort'; teamId: string; agentId: string }
  | { op: 'release'; teamId: string; agentId: string }
export type TeamOp = TeamRequest['op']
type Empty = Record<never, never>
/** One reply shape per op; `TeamReply<O>` indexes it with every TeamOp, so a missing op fails to compile. */
export interface TeamReplyMap {
  list: { teams: TeamListItem[] }; get: { team: TeamView }
  setupProbe: { probe: SetupProbe }; setupPreview: { preview: SetupPreview }; setupWrite: { teamId: string }; adopt: { teamId: string }
  trustDiff: { trust: TrustDiff }; trust: { team: TeamView }; remove: Empty; settings: { team: TeamView }; reveal: Empty
  roster: { agents: AgentView[]; rev: number }; runNow: { runId: string }; stop: Empty; pauseAgent: Empty
  runs: { runs: RunView[]; cursor: number | null }
  runPage: { run: RunView; items: ChatMessage[]; cursor: string | null; done: boolean; live: boolean }
  watchRun: Empty
  board: { page: TeamBoardPage }; task: { task: TaskDetail }
  createTask: { task: TaskSummary }; updateTask: { task: TaskDetail }; moveTask: { task: TaskSummary }; releaseOwned: { task: TaskSummary }
  comment: { comment: CommentView }; lead: { lead: LeadView }; leadSay: { comment: CommentView }
  dispatch: { approved: string[]; dropped: string[] }; kickoff: { runId: string }
  needs: { needs: TeamNeedsView }; decide: Empty; answer: Empty
  integratePreview: { preview: IntegratePreview }; integrate: { integrationId: string }; askRebase: Empty
  confirmVerify: { team: TeamView }; removeWorktree: Empty
  routines: { routines: RoutineView[] }; routineRun: { runId?: string; taskId?: string }
  notes: { notes: WsNoteMeta[] }; note: { title: string; text: string; updatedAt: number }; runSilenceAck: Empty
  takeover: { grant: TakeoverGrant }; takeoverBound: Empty; takeoverAbort: Empty; release: { paneId: string; workspaceId: string }
}
export type ConflictReason = 'rev' | 'stale' | 'concluded' | 'already_decided' | 'newer_comment_not_delivered'
export type TeamError =
  | 'disabled' | 'bad_request' | 'not_found' | 'unsupported' | 'conflict' | 'user_owned' | 'untrusted' | 'invalid_definition'
  | 'busy' | 'stopping' | 'running' | 'deferred' | 'exists' | 'changed' | 'not_git' | 'no_session' | 'cap' | 'cycle'
  | 'forbidden' | 'too_big' | 'rate' | 'io' | 'cli_off'
  | IntegrateError
export interface TeamFail {
  ok: false; error: TeamError
  reason?: ConflictReason
  current?: TaskDetail                             // conflict on a task op (desktop; the phone reloads)
  defer?: DeferInfo                                // deferred
  issues?: DefError[]                              // invalid_definition
  fields?: TaskField[]                             // user_owned
  files?: string[]; detail?: string
}
export type TeamReply<O extends TeamOp = TeamOp> = ({ ok: true } & TeamReplyMap[O]) | TeamFail
export type TeamReplyFor<R extends { op: TeamOp }> = TeamReply<R['op']>

// ---- events ----
export type TeamScope = 'list' | 'team' | 'board' | 'task' | 'agents' | 'run' | 'needs' | 'lead' | 'notes' | 'routines' | 'disabled'
/** `rev` = the team runtime rev; `taskId` with 'task', `runId` with 'run'. */
export interface TeamChangedEvt { teamId: string; rev: number; scopes: TeamScope[]; taskId?: string; runId?: string }
export interface TeamRunAppendEvt { teamId: string; runId: string; agentId: string; items: ChatMessage[]; state?: RunState; lastLineAt?: number }

// ---- phone subset and frame caps ----
export const PHONE_TEAM_OPS = ['list', 'board', 'task', 'needs', 'runPage', 'createTask', 'comment', 'leadSay', 'lead'] as const
export type PhoneTeamOp = (typeof PHONE_TEAM_OPS)[number]
export type PhoneTeamRequest = Extract<TeamRequest, { op: PhoneTeamOp }>

export function isPhoneTeamOp(op: string): op is PhoneTeamOp {
  return (PHONE_TEAM_OPS as readonly string[]).includes(op)
}

export const TEAM_FRAME_MAX_BYTES = 48 * 1024     // teamRes serialized with its envelope
export const TEAM_BOARD_PAGE = 150
export const TEAM_REQ_MAX = 30
export const TEAM_REQ_WINDOW_MS = 10_000
export const TEAM_REQ_IN_FLIGHT = 2
export const TEAM_PHONE_BODY_MAX = 8000
export const TEAM_PHONE_PLAN_MAX = 16000
export const TEAM_PHONE_HIRE_LINES = 200
/** Phone ctl actions (B8), handled in main. */
export type TeamCtlAction =
  | { kind: 'teamDecide'; teamId: string; approvalId: string; decision: 'approve' | 'reject'; note?: string }
  | { kind: 'teamAnswer'; teamId: string; cardId: string; answer: CardAnswer }
  | { kind: 'teamDispatch'; teamId: string; queueId: string; go: boolean }
