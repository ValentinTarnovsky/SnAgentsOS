import { spawn as nodeSpawn } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { appendFileSync, promises as fsp, readdirSync, readFileSync, rmSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import type { ChatMessage } from '@shared/chat-types'
import type { ClaudeAccountsState } from '@shared/claude-accounts'
import { CTL_TEAM_LOG_DEFAULT, type CtlErrorCode, type CtlResponse } from '@shared/ctl-protocol'
import { normalizeLabs } from '@shared/labs'
import { redactCredentials } from '@shared/redact'
import { normalizeSilence } from '@shared/silence'
import { DATA_SECRET_PATHS, effectiveProfile, isGrantable, roleWrites } from '@shared/teamArgv'
import { canonicalDefText, definitionIssues, normalizeDefText, parseDefinition, parseFrontmatter, UNC_PATH_RE } from '@shared/teamDefinition'
import { afterRunPolicy, candidatesOf, claudeAllLimited, planDispatch } from '@shared/teamDispatch'
import type { TeamNeedRow } from '@shared/teamNeeds'
import { systemText } from '@shared/teamPrompt'
import { parseTeamBlock } from '@shared/teamTools'
import { isPhoneTeamOp, type IntegratePreview, type IntegrateProgressEvt, type PhoneTeamRequest, type RoutineView, type TaskSummary, type TeamChangedEvt, type TeamCtlAction, type TeamFail, type TeamOp, type TeamReply, type TeamRequest, type TeamRunAppendEvt, type TeamScope, type TeamTrustState } from '@shared/team-protocol'
import { suggestVerify, type VerifySuggestion } from '@shared/verifyDetect'
import type { WsNoteMeta } from '@shared/ws-notes'
import {
  BOARD_COLUMNS,
  columnOf,
  COMMENT_TEXT_MAX,
  LEAD_THREAD,
  LIMIT_FALLBACK_MS,
  ORPHAN_START_SLACK_MS,
  RETRY_DELAY_MS,
  REPO_MAIN,
  ROUTINE_CATCHUP_MS,
  STOP_GRACE_MS,
  TASK_ID_RE,
  TEAM_LOG_TTL_MS,
  TEAM_LOGS_MAX_BYTES,
  TEAM_PANE_PREFIX,
  TEAM_STATE_MAX_BYTES,
  teamPaneId,
  isTeamPaneId,
  type Actor,
  type CardAnswer,
  type DefError,
  type DeferInfo,
  type DispatchFacts,
  type DispatchPlan,
  type PolicyDecision,
  type ResolvedRepo,
  type RoleKind,
  type RoutineDef,
  type Run,
  type RunEndFacts,
  type RunMode,
  type RunNote,
  type RunRequest,
  type TaskState,
  type TeamDefinition,
  type TeamRuntime,
  type TeamTask,
  type TrustedDefinition,
  type WakeMark,
} from '@shared/teams'
import type { AgentProvider, ConfigFile, PaneSilence, PaneStatusEvt } from '@shared/types'
import type { RemoteCommandResult } from '@shared/ipc-contract'
import { splitAppend } from '../chat/chatFrames'
import { mainT, type MainKey } from '../i18n'
import type { CtlTeamCaller } from '../cli/CtlTokens'
import type { CtlTeamsView } from '../cli/handlers'
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'
import { gitExitCode, type GitRunner } from '../git/gitExec'
import { linkNodeModules } from '../git/WorktreeService'
import { isSameOrInside, pathKey } from '../migration/pathUtil'
import { safeRemoveTree } from '../migration/safeRemove'
import { WsNoteStore } from '../notes/WsNoteStore'
import { pidAlive, procStartTime as realProcStartTime, signalTree, treeKillSync } from '../proc/treeKill'
import type { PtySink } from '../pty/PtyManager'
import { cleanEnv, statusBinDirs } from '../pty/shellResolver'
import type { RemoteTeamsView } from '../remote/RemoteManager'
import { TrustStore } from '../repoConfig/TrustStore'
import type { TeamNotice } from '../status/events'
import { SilenceWatch } from '../status/SilenceWatch'
import { resolveAgentCli, type ResolvedCli } from './agentCli'
import { Dispatcher, DISPATCH_KEY, type ManualRequest, type StepResult } from './Dispatcher'
import { dismissSystemCards, openSystemCard, reconcileAgents } from './flow/agents'
import { enqueue, phaseAgentOf, queueDecide, reconcileTasks } from './flow/dispatch'
import { admitRun, finishRun, interruptAll, markRunning, orphanCards, permissionWaitOf, reapOnLoad, requestStop, restoreWake, runEndFactsOf, sessionCardVars, terminalOf, withRunDetail, type AdmitFacts, type RunEnd } from './flow/runs'
import { answerCard, cancelStaleHires, completeApproval, decideApproval, HIRE_STALE, PERMISSION_NOT_NEEDED } from './flow/approvals'
import { archiveSweep, changedScopes, deliverComments } from './flow/tasks'
import { askRebase, beginIntegrate, endIntegrate, integrateStep, interruptedIntegrates, worktreeRemoved, type IntegrateOutcome } from './flow/integrate'
import { approvalKey, AUTOPILOT_ACTOR, AUTOPILOT_REBASE_MAX, AUTOPILOT_TRIES_MAX, autopilotPicks, autopilotTakes, keyTask, type AutopilotPick } from './flow/autopilot'
import { patchRoutine, routineOfRefs, routinePending, routineTask, routineWake } from './flow/routines'
import { ackRunSilence as ackSilenceFlow, dismissStaleStalledCards, dismissStalledCard, openStalledCard } from './flow/silence'
import { dropTakeover, reconcileTakeovers, settleTakeovers, TAKEOVER_CONFIRM_MS, TAKEOVER_STOP_WAIT_MS, takeoverBindAt, takeoverBindKey, takeoverPolicy, takeoversAtLoad, type TakeoverPane } from './flow/takeover'
import { applyBlock, applyTool, noteOf, teamNoteText } from './flow/tools'
import type { FlowCtx, FlowResult, TeamEffect, TeamToolCall } from './flow/types'
import { createVerifyRunner, integrateHolder, Integrator, type IntegrateResult, type VerifyRunner } from './Integrator'
import type { StreamFacts } from './parsers/types'
import { createTeamCtl, paramText, type TeamCtlPort, type TeamLiveRun, type TeamReadReply } from './teamCtl'
import { createClaudeStreamParser } from './parsers/claudeStream'
import { phoneTeamReply, teamCtlRequest, teamCtlResult } from './phoneFit'
import { maskMessages } from './RunLog'
import { lastDue, ROUTINE_SLOT_RETRY_MS, RoutineTicker, type RoutineFireOutcome } from './RoutineTicker'
import { RunStarter } from './RunStarter'
import { RunSupervisor } from './RunSupervisor'
import { TaskWorktrees, type TeamWorktreeApi, type WorktreeLive } from './TaskWorktrees'
import { WriteLocks } from './WriteLocks'
import { currentBranch } from './ops/core'
import { teamGitRead, type TeamGitRequest, type TeamGitTarget } from './ops/gitReads'
import { OPS } from './ops/index'
import { fail, type OpHandler, type TeamInternals, type TeamRecord } from './ops/types'
import { TeamDefinitionLoader, type LoadedDefinition, type LoaderFs, type LoadRes } from './TeamDefinitionLoader'
import { resolveMainRoot, TeamRegistry, teamIdOf, type RegistryFs, type TeamIndexEntry } from './TeamRegistry'
import { TeamStore, type SyncFs, type TeamStoreDeps } from './TeamStore'
import { goalHashOf, sha256Hex, TeamTrust } from './TeamTrust'
import { compareTaskOrder, LIVE_RUN_STATES, needsRowsOf, routineView, taskDetail, taskSummary, teamHeaderKey, waitingOf, type TaskViewCtx } from './views'

/** `team.tasks` answers at most this many tasks (design 5.3); `team task get` carries the newest 30 comments. */
export const CTL_TASKS_MAX = 200
export const CTL_TASK_COMMENTS = 30
/** Archive files a comment count is read from (TeamStore.appendArchive writes the same names). */
const ARCHIVE_TARGET_RE = /^(?:lead|t-[0-9]{1,5})$/
/** `team tasks --state`: a task state, or `open` (anything not done or cancelled). */
const CTL_TASK_STATES: readonly string[] = ['todo', 'doing', 'review', 'done', 'blocked', 'cancelled', 'open']

function ctlErr(code: CtlErrorCode, message: string): CtlResponse {
  return { ok: false, error: { code, message } }
}

/** fs.watch events of a definition folder are debounced this long (design 3.10 `defwatch:<teamId>`). */
export const DEFWATCH_MS = 300

/**
 * Ops refused with `untrusted` while the cached trust state is not `trusted`
 * (design 3.9): what could start a run or touch git. Reads, edits, comments
 * and decisions keep working so the user can see the diff and tidy the board.
 */
const TRUST_GATED_OPS: ReadonlySet<TeamOp> = new Set<TeamOp>(['runNow', 'kickoff', 'resumeTask', 'routineRun', 'integrate', 'dispatch'])

/**
 * B8 (design 6.2): the ops of the phone's three ctls (teamDecide, teamAnswer, teamDispatch). They are not phone
 * requests (PHONE_TEAM_OPS), so only remoteView.ctl lets them past that gate; the origin checks of each op still
 * apply (ops/needs.ts: a hire decide and a PC-only card action are forbidden from the phone).
 */
const PHONE_CTL_OPS: ReadonlySet<TeamOp> = new Set<TeamOp>(['decide', 'answer', 'dispatch'])

/** The problems of a load as one comparable key: the load error, or the parser's errors and warnings. */
function issueKey(loaded: LoadRes): string {
  if ('error' in loaded) return loaded.error
  return JSON.stringify(definitionIssues(loaded.result))
}

export interface TeamServiceDeps {
  dataDir: () => string
  config: () => ConfigFile | null
  platform?: NodeJS.Platform
  now?: () => number
  git: GitRunner
  /** Renderer + RemoteManager.teamChanged (B8). */
  emit: (evt: TeamChangedEvt) => void
  /** The reveal op (main computes and lstats the folder): Electron's shell.openPath, '' when it opened, else its error text. */
  openPath: (path: string) => Promise<string>
  /** teamsLog: codes and ids only, never prompt or reply text. */
  log: (line: string) => void
  /** Test seam (manual clock). */
  timerDeps?: DeadlineTimerDeps
  /** Test seams: a fake trust store, a fake loader, the store's fs, the registry's trash move, the extra repo lookups, strict invariants. */
  trustStore?: Pick<TrustStore, 'get' | 'setChecked' | 'delete'> & Partial<Pick<TrustStore, 'readable'>>
  loader?: TeamDefinitionLoader
  storeFs?: SyncFs
  registryFs?: RegistryFs
  repoFs?: Pick<LoaderFs, 'lstat' | 'realpath'>
  strict?: boolean

  // ---- B2 (runs). Optional: without them no run starts (cliOff) and nothing is reported. ----
  /** The status of the consoles (session conflict, decision 39). */
  status?: { snapshot(): PaneStatusEvt[]; stateOf(paneId: string): PaneStatusEvt | null; paneForSession(sessionId: string): string | null }
  /** Pane holding the session: live precise status, agent session record or config lastSession; live ptys only. */
  sessionHolder?: (provider: AgentProvider, sessionId: string) => string | null
  /** Wired as ptyManager.getSpawnCwd / ptyIdForPane / killPaneAndWait. */
  pty?: { spawnCwd(paneId: string): string | undefined; ptyIdForPane(paneId: string): string | null; killPaneAndWait(paneId: string): Promise<void> }
  accounts?: () => ClaudeAccountsState | null
  /**
   * ready() = CliService.running && shimExists() (decision 71). B5 integration, sixth round (security): the live tokens
   * of the app (CliService.tokens): holdsToken refuses a Codex block action that carries one (applyRunBlock, like
   * teamCtl does a CLI call), maskTokens masks them in a run's chat rows before they leave main (maskRun).
   */
  cli?: {
    envForTeam(runId: string, teamId: string, agentId: string, roleKind: RoleKind): Record<string, string>
    revokeTeam(runId: string): void
    ready(): boolean
    holdsToken(text: string): boolean
    maskTokens(text: string): string
  }
  /** treeKill.ts procStartTime (decision 64); test seam. */
  procStartTime?: (pid: number) => Promise<{ at: number; image: string } | null>
  /** AwakeService.onPaneStatus: the synthetic status of a live run (never StatusManager). */
  awake?: (evt: PaneStatusEvt) => void
  /** teams:runAppend to the renderer, only for the watched run. */
  sendRun?: (evt: TeamRunAppendEvt) => void
  /** Test seams: the child spawn, the agent CLI lookup (the fake agent), the run env base, the tree kill. */
  spawn?: typeof import('child_process').spawn
  resolveCli?: (provider: AgentProvider, env: Record<string, string>) => ResolvedCli | null
  baseEnv?: () => Record<string, string>
  treeKill?: { sync: typeof treeKillSync; signal: typeof signalTree; alive: (pid: number) => boolean }

  // ---- B4 (dispatch). ----
  /** The console worktree service (registerWorktreeIpc's instance): task worktrees, tagged with their owner (decision 63). Without it a worktree task cannot start. */
  worktrees?: TeamWorktreeApi | null

  // ---- B5 (needs). ----
  /** A new need row the user should hear about (design 3.1 Notices): B5 the desktop toast, B8 also the phone push. */
  notice?: (n: TeamNotice) => void

  // ---- B6 (Integrar). ----
  /** teams:integrateProgress to the renderer (every step of every integrate; the dialog filters its integrationId). */
  sendIntegrate?: (evt: IntegrateProgressEvt) => void

  // ---- B9 (takeover). ----
  /** Test seam: the takeover op's wait for a stopped run (TAKEOVER_STOP_WAIT_MS) and takeoverBound's wait for its console (TAKEOVER_CONFIRM_MS). */
  takeoverWait?: { stopMs?: number; paneMs?: number }
}

/** A deferred run waits on a console (its session or its tree): a console status change pokes the dispatcher. */
const CONSOLE_DEFERS: ReadonlySet<DeferInfo['reason']> = new Set(['sessionBusy', 'treeBusy', 'consoleBusy'])
/** The run-end close budget of the tree mark (design 3.5 close sequence). */
const CLOSE_MARK_MS = 5_000

/** = SIGNAL_REFRESH_MS of StatusManager (10 min): the synthetic status of a live run is pushed again at most this often (decision 58). */
export const SYNTHETIC_REFRESH_MS = 10 * 60 * 1000
/** removeTeam waits this long (12 s) for its stopped runs to close: the supervisor forces each at STOP_GRACE_MS. */
export const REMOVE_WAIT_MS = STOP_GRACE_MS + 2_000
/** Images a reaped pid must run to count as an orphan of ours (decision 64). */
const ORPHAN_IMAGES = new Set(['claude', 'codex', 'node', 'cmd'])
/** B7: team notes one team keeps; `team note` past it answers busy (a Lead writes about one a day). */
export const TEAM_NOTES_MAX = 500
/** B9: consoles a notHeld release left in place that main remembers (consoleLeft); the oldest goes first. */
export const LEFT_CONSOLES_MAX = 64

/** A runtime built in place (B7: a routine's state, a card dismissed) as a reducer result for commit. */
function committed(rt: TeamRuntime): FlowResult {
  return { ok: true, rt, effects: [], result: undefined }
}

/** B7: a routine wake another mark wrote over in its agent's slot (TeamService.displacedWakes); `owed` while the routine is on. */
interface DisplacedWake { agentId: string; routineId: string; by: WakeMark['reason']; scheduledAt: number; owed: boolean }

/** `rt` with the `displacedFor` of every owed wake, so a quit, Labs off, an install or a crash before its retry lands never loses it. */
function withDisplaced(rt: TeamRuntime, list: readonly DisplacedWake[]): TeamRuntime {
  let out = rt
  for (const d of list) if (d.owed) out = patchRoutine(out, d.routineId, { displacedFor: d.scheduledAt })
  return out
}

/** A refused reducer result as the op's reply (FlowError is a subset of TeamError). */
function flowFail(res: Extract<FlowResult<unknown>, { ok: false }>): TeamFail {
  const extra: Omit<TeamFail, 'ok' | 'error'> = {}
  if (res.reason) extra.reason = res.reason
  if (res.fields) extra.fields = res.fields
  if (res.defer) extra.defer = res.defer
  if (res.detail) extra.detail = res.detail
  return fail(res.error, extra)
}

/**
 * A need row's key in the notices baseline (`needsSeen`): its id, and for a permission approval a later run grew (rev
 * past 1, B close) the id with its rev, so the grown approval reads as new and notifies once more. A rev 1 row keeps
 * the bare id, as a baseline written before the rev existed holds it.
 */
function needSeenKey(row: TeamNeedRow, rt: Readonly<TeamRuntime>): string {
  if (row.kind !== 'approval' || row.approvalKind !== 'permission') return row.id
  const a = rt.approvals.find((x) => x.id === row.id)
  const rev = a?.kind === 'permission' ? a.rev ?? 1 : 1
  return rev > 1 ? `${row.id}@${rev}` : row.id
}

/** The `teams.push.*` body key of a need row (design 6.3): its kind, the pause reason, the approval kind, a card with or without a task. */
function noticeKey(row: TeamNeedRow, paused: TeamRuntime['paused']): MainKey {
  switch (row.kind) {
    case 'trust':
      return 'teams.push.trust'
    case 'paused':
      return paused?.reason === 'billing' ? 'teams.push.paused.billing' : 'teams.push.paused.auth'
    case 'approval':
      switch (row.approvalKind) {
        case 'plan':
          return row.taskId ? 'teams.push.approval.plan' : 'teams.push.approval'
        case 'final':
          return row.taskId ? 'teams.push.approval.final' : 'teams.push.approval'
        case 'permission':
          return row.taskId ? 'teams.push.approval.permission' : 'teams.push.approval'
        case 'integrate':
          return row.taskId ? 'teams.push.approval.integrate' : 'teams.push.approval'
        case 'hire':
          return 'teams.push.approval.hire'
        default:
          return 'teams.push.approval'
      }
    case 'card':
      return row.taskId ? 'teams.push.card' : 'teams.push.cardTeam'
    case 'dispatch':
      return 'teams.push.dispatch'
  }
}

/** A Codex run whose sandbox is read-only (readonly or custom profile) reports its team actions in a `snaos-team` block (decision 7). */
function reportsByBlock(run: Pick<Run, 'provider' | 'profile'>): boolean {
  return run.provider === 'codex' && run.profile !== 'total'
}

/** A process of a run of an earlier app life that is still alive (decision 64): it holds its session and its cwd. */
interface Lingering { runId: string; agentId: string; pid: number; startedAt: number; sessionId?: string; cwd: string; cardId?: string }

/**
 * Teams facade (app 2.7.0, E10 B, design 3.1): the only owner of team state.
 * With `labs.teams` off it holds no team, arms no timer and every request
 * answers `disabled`. Enabled, it keeps one TeamStore per registered team, the
 * cached trust state of each (decision 69) and one DeadlineTimer for every
 * deadline of the module, built once here and disposed only by dispose()
 * (design 3.0 item 6).
 */
export class TeamService implements TeamInternals {
  readonly registry: TeamRegistry
  readonly loader: TeamDefinitionLoader
  readonly trust: TeamTrust
  readonly git: GitRunner
  /**
   * B9 (design 4.4): the ptys of the consoles. A spawn may be the console of a waiting takeover (K4, lazy: the saved
   * config or its status names it); the exit of a bound console that left the config ends its takeover (K7, closed
   * by hand). Never throws on the pty path.
   */
  readonly sink: PtySink = {
    id: 'teams',
    onSpawn: (_ptyId, paneId) => this.onConsoleSpawn(paneId),
    onData: () => undefined,
    onExit: (_ptyId, paneId, _code, info) => this.onConsoleExit(paneId, info.current),
  }
  /**
   * B3: what `snaos team` reaches (CliService.attach({teams})): teamCtl checks
   * the params and the role, then reads and writes through this port (B7:
   * `note` writes a team note).
   */
  readonly ctlView: CtlTeamsView = createTeamCtl({
    // Labs off (or frozen, disposed): every team.* answers disabled, like every Teams request.
    live: (who) => (this.live() ? this.ctlLive(who) : 'disabled'),
    read: (teamId, method, params, who) => (method === 'team.diff' || method === 'team.log' ? this.ctlGit(teamId, method, params, who) : this.ctlRead(teamId, method, params, who)),
    apply: (teamId, call, who) => this.ctlApply(teamId, call, who),
    note: (teamId, text, title, who) => this.ctlNote(teamId, text, title, who),
  })
  /**
   * B8 (design 6.2): what the phone reaches (RemoteManager.setTeams). `request`: a PHONE_TEAM_OPS request with origin
   * phone, its reply masked, without the desktop fields and fitted to one frame (phoneFit). `ctl`: teamDecide,
   * teamAnswer and teamDispatch as the decide, answer and dispatch ops with origin phone, past the PHONE_TEAM_OPS gate
   * (PHONE_CTL_OPS) and through each op's origin checks; the ack carries the error code only (teamCtlResult).
   */
  readonly remoteView: RemoteTeamsView = {
    request: (req: PhoneTeamRequest) => phoneTeamReply(req, (r) => this.request(r, 'phone'), this.phoneMask),
    ctl: async (action: TeamCtlAction): Promise<RemoteCommandResult> => teamCtlResult(await this.serve(teamCtlRequest(action), 'phone', true)),
  }

  private readonly clock: () => number
  private readonly repoFs: Pick<LoaderFs, 'lstat' | 'realpath'>
  private readonly timer: DeadlineTimer<string>
  private readonly teams = new Map<string, TeamRecord>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly checks = new Map<string, Promise<void>>()
  private readonly pendingEmits = new Map<string, { teamId: string; scopes: TeamScope[]; taskId?: string; runId?: string }>()
  private emitQueued = false
  /** labs.teams as last seen. */
  private labOn = false
  /** Teams are loaded and served. */
  private enabled = false
  /** shutdownSync ran (exit hooks); thaw() undoes it unless the app is really quitting. */
  private frozen = false
  private quitting = false
  /** dispose() ran: nothing enables again (the timer is gone). */
  private disposed = false
  private enabling: Promise<void> | null = null
  /** Bumped by every enable and teardown: an enable that lost the race drops what it loaded. */
  private epoch = 0

  // ---- B2 runs ----
  /** The only owner of the run processes (3.0 item 3). */
  readonly supervisor: RunSupervisor
  private readonly starter: RunStarter
  private readonly platform: NodeJS.Platform
  /** persistBeforeInstall ran (prepareInstall): every run defers `disabled` until installAborted. */
  private installing = false
  /**
   * The request text of an active run (the user's prompt of "Ejecutar ahora", a routine's), from its admission to
   * its end: the prep puts it in the stdin, and the run-end policy copies it into the wake mark of a task-less run
   * it wakes again (`withRunDetail`, persisted as WakeMark.detail from then on). Memory only.
   */
  private readonly runDetail = new Map<string, string>()
  /** The wake mark an admission consumed (R1), until the prep of its run reads it: a prep failure without a card puts it back (restoreWake). */
  private readonly consumedMark = new Map<string, WakeMark>()
  /**
   * afterRunPolicy, with the run's request text carried into a task-less re-wake (every run end of this service). B9:
   * a run a takeover stopped never blocks its task on a card (takeoverPolicy: the user drives that session now).
   */
  private readonly runPolicy = (f: RunEndFacts): PolicyDecision => takeoverPolicy(withRunDetail(afterRunPolicy(f), f.run, this.runDetail.get(f.run.id)), f)
  /** The run the renderer watches (teams:runAppend), one at a time (decision 49). */
  private watched: { teamId: string; runId: string } | null = null
  /** Last synthetic push per live run (decision 58). */
  private readonly awakeAt = new Map<string, number>()
  /** Team writes per live run (B3's CLI counts them; classifyOutcome reads them at close). */
  private readonly runWrites = new Map<string, number>()
  /** Decision 64: live processes of runs reaped at load, per team. */
  private readonly lingering = new Map<string, Lingering[]>()
  /** Runs reaped (with a pid) by the last load of each team, waiting for the orphan check; they hold their sessions and trees until it settles. */
  private readonly reapedAtLoad = new Map<string, Run[]>()
  /** removeTeam waiters per team, resolved when its last active run ends (runsEnded). */
  private readonly idleWaiters = new Map<string, Array<() => void>>()
  /** Teams a removeTeam is taking down: their run ends prune no logs (the folder moves to the trash right after). */
  private readonly removing = new Set<string>()
  /** Records a removeTeam took out (not a teardown): a prep still inside TaskWorktrees.ensure disowns the tree it made. */
  private readonly removedRecs = new WeakSet<TeamRecord>()
  /** B3: archived comments per `<teamId>|<target>` (lines of archive/<target>.jsonl), read once and bumped on append. */
  private readonly archivedCounts = new Map<string, number>()
  /** B5 integration, fifth round: runs with a `team diff` or `team log` in flight (one at a time per run, ctlGit). */
  private readonly gitReading = new Set<string>()
  private readonly treeKill: NonNullable<TeamServiceDeps['treeKill']>

  // ---- B4 dispatch ----
  /** One pass at a time over every team (design 3.6). */
  readonly dispatcher: Dispatcher
  /** The write locks of every team's run trees (and B6's integrates). */
  readonly locks: WriteLocks
  /** Task worktrees (decision 24, 63); null without the worktree service. */
  readonly taskWorktrees: TaskWorktrees | null
  /**
   * "Descartar" of a level the runtime derives (a todo assignee, queued comments, an unread message): its
   * `<teamId>|<agentId>|<sessionKey>`, its task and what it looked like, so the next passes leave it out (the
   * agent's next level is its candidate instead) until it changes. Memory only (a restart offers it once more).
   */
  private readonly discarded = new Map<string, { sig: string; taskId?: string }>()
  /** Teams whose last pass deferred a run on a console's session or tree: a console status change pokes. */
  private readonly waitsOnConsoles = new Set<string>()
  /**
   * `<teamId>|<agentId>|<sessionKey>` -> until when a level does not start again after its prep failed with a card
   * (no CLI found, a missing cwd, the control server): a level the runtime derives (the goal, queued comments) would
   * otherwise be admitted again by the very next pass and fail the same way, on every tick. Memory only.
   */
  private readonly prepBackoff = new Map<string, number>()

  // ---- B6 Integrar ----
  /** The temp merge, the verify and the land (design 3.7); null without the worktree service (no task has a worktree then). */
  readonly integrator: Integrator | null
  /** The verify processes of every integrate (B6 integration: the exit hooks tree-kill them). */
  private readonly verifyRunner: VerifyRunner
  /**
   * `<teamId>|<taskId>` of every integrate in flight in this app, with the attempt it runs, whether it began its land
   * and its job (prepareInstall waits for the job of one that did). Outlives a teardown: an integrate finishes its
   * bounded steps across a Labs toggle (design 3.1), and a load leaves these `running` (only one no process runs any
   * more is `interrupted`).
   */
  private readonly integrating = new Map<string, { integrationId: string; attempt: number; land: boolean; job?: Promise<void> }>()
  /**
   * The newest record of each team (set at every load and add, kept across a teardown, dropped by a remove): a B6
   * commit that lands while the team is not loaded writes on it, never on an older store the integrate began on (Labs
   * off, on and off again meanwhile would put that store's stale runtime over everything written since).
   */
  private readonly newestRecs = new Map<string, TeamRecord>()
  /** Integrates and sweeps in flight (integrateIdle, tests). */
  private readonly integrateJobs = new Set<Promise<unknown>>()

  // ---- 2.9.0 Piloto automatico ----
  /**
   * Per team, the autopilotPicks keys the autopilot gave up on (a decide or answer refused, a preview it may not land,
   * AUTOPILOT_REBASE_MAX rebases): their rows stay the user's, and notify. Each key goes once its subject is no longer
   * waiting (autopilotSkipOf). Memory only: a restart tries them once more.
   */
  private readonly autopilotSkip = new Map<string, Set<string>>()
  /** Per team, how many times each key was applied while its subject kept waiting (AUTOPILOT_TRIES_MAX). */
  private readonly autopilotTries = new Map<string, Map<string, number>>()
  /** `<teamId>|<taskId>` -> rebases the autopilot asked for since the task last integrated. Memory only. */
  private readonly autopilotRebases = new Map<string, number>()
  /** Teams with a pass queued (one microtask) or running, and `again` when a commit landed while it ran. */
  private readonly autopilotState = new Map<string, 'queued' | 'running' | 'again'>()
  /** Passes in flight (autopilotIdle, tests). */
  private readonly autopilotJobs = new Set<Promise<void>>()

  // ---- B7 routines, team notes, run silence ----
  /** Routine deadlines on the shared timer (design 3.8, 3.10): armed at enable (with catch-up), after a fire and a trust. */
  readonly routines: RoutineTicker
  /**
   * Team notes (design 3.8): a second WsNoteStore under dataDir()/teams, workspaceId = teamId. Its changes go out as
   * the `notes` scope only (never remoteManager.notesChanged, Share or the wsNotes IPC), and it is never prune()d:
   * TeamRegistry owns the purge of the trash under teams/ (9.1 risk 16).
   */
  private readonly notes: WsNoteStore
  /**
   * Decision 58: the silence of the live runs, a second SilenceWatch (its own DeadlineTimer) whose signal is the
   * run's last line. Built once here and disposed only by dispose(); Labs off and a freeze unwatch every run.
   */
  private readonly silence: SilenceWatch
  /** Runs the silence watch follows: from `running` to their end, unless the user ignored their silence. */
  private readonly silenceWatched = new Set<string>()
  /** The silence on show of a watched run (memory only, design 3.8). */
  private readonly runSilence = new Map<string, PaneSilence>()

  // ---- B9 takeover ----
  /** Takeover ops waiting for the run their takeover stops (K2), woken by the commit that ends it, or by their timeout. */
  private readonly takeoverWaits = new Set<{ teamId: string; agentId: string; done: () => void }>()
  /** takeoverBound ops waiting for their console (K4): each re-checks at a config save, a console status or a spawn. */
  private readonly paneWaits = new Set<(final: boolean) => void>()
  /** `<teamId>|<agentId>` -> the `at` of the waiting takeover whose grant already left main (a second click is busy). */
  private readonly grantedAt = new Map<string, number>()
  /**
   * `<sessionId>|<paneId>` of each console a notHeld release left in place (K6), oldest first, at most
   * LEFT_CONSOLES_MAX: that session binds to it again only once its live status names it. A bind to it clears it.
   */
  private readonly leftConsoles = new Set<string>()

  constructor(private readonly deps: TeamServiceDeps) {
    this.clock = deps.now ?? Date.now
    this.git = deps.git
    this.platform = deps.platform ?? process.platform
    const timerDeps: DeadlineTimerDeps = {
      now: this.clock,
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms)
        h.unref?.()
        return h
      },
      ...deps.timerDeps,
    }
    this.timer = new DeadlineTimer<string>((key) => this.onDue(key), timerDeps)
    const teamsDir = (): string => join(deps.dataDir(), 'teams')
    this.routines = new RoutineTicker({ timer: this.timer, now: this.clock, fire: (teamId, r, at) => this.fireRoutine(teamId, r, at), log: deps.log })
    this.notes = new WsNoteStore({ root: teamsDir, emit: (e) => this.onNoteWritten(e.workspaceId), now: this.clock })
    this.silence = new SilenceWatch(
      { signalAt: (paneId) => this.supervisor.lastLineAt(paneId.slice(TEAM_PANE_PREFIX.length)), onSilence: (paneId, s) => this.onRunSilence(paneId, s) },
      timerDeps,
    )
    this.registry = new TeamRegistry({ file: () => join(teamsDir(), 'index.json'), trashDir: () => join(teamsDir(), '.trash'), now: this.clock, log: deps.log, fs: deps.registryFs })
    this.repoFs = deps.repoFs ?? { lstat: (p) => fsp.lstat(p), realpath: (p) => fsp.realpath(p) }
    this.loader = deps.loader ?? new TeamDefinitionLoader()
    const store = deps.trustStore ?? new TrustStore({ file: () => join(deps.dataDir(), 'trusted-teams.json'), now: this.clock, platform: deps.platform })
    this.trust = new TeamTrust(store, (id) => join(teamsDir(), id, 'trusted-def.json'), (id) => this.registry.get(id)?.repoRoot ?? null, this.clock)
    this.treeKill = deps.treeKill ?? { sync: (pid) => treeKillSync(pid), signal: (pid, sig) => signalTree(pid, sig), alive: (pid) => pidAlive(pid) }
    this.locks = new WriteLocks({ platform: this.platform, humanWriters: () => this.humanWriters() })
    this.taskWorktrees = deps.worktrees ? new TaskWorktrees({ worktrees: deps.worktrees, git: deps.git, now: this.clock }) : null
    // Requirement of B6: the verify runs with the run env base (cleanEnv: no SNAOS_* token), its tree killed at the
    // timeout and by the exit hooks (shutdownSync, prepareInstall).
    this.verifyRunner = createVerifyRunner({
      env: deps.baseEnv ?? (() => cleanEnv()),
      treeKill: (pid) => void this.treeKill.sync(pid),
      spawn: deps.spawn,
      platform: this.platform,
      redact: (s) => redactCredentials(this.maskTokens(s)),
      log: deps.log,
    })
    this.integrator = deps.worktrees
      ? new Integrator({
          git: deps.git,
          worktrees: deps.worktrees,
          locks: this.locks,
          integrateDir: (id) => join(teamsDir(), id, 'integrate'),
          verifyLogDir: (id) => join(teamsDir(), id, 'verify'),
          runVerify: this.verifyRunner,
          linkNodeModules: (repoRoot, path) => linkNodeModules(repoRoot, path),
          removeTree: (target, guard, o) => safeRemoveTree(target, guard, o),
          now: this.clock,
          progress: (e) => this.sendIntegrate(e),
          log: deps.log,
        })
      : null
    this.dispatcher = new Dispatcher({
      teams: () => [...this.teams.keys()],
      facts: (teamId, pass, manual) => this.dispatchFacts(teamId, pass, manual),
      step: (teamId, facts) => this.dispatchStep(teamId, facts),
      plan: (teamId, facts) => this.dryPlan(teamId, facts),
      unplanned: (teamId, m) => this.unplanned(teamId, m),
      timer: this.timer,
      now: this.clock,
      live: () => this.live() && !this.installing,
      log: deps.log,
    })
    this.supervisor = new RunSupervisor({
      spawn: deps.spawn ?? nodeSpawn,
      treeKill: { sync: this.treeKill.sync, signal: this.treeKill.signal },
      timer: this.timer,
      now: this.clock,
      platform: this.platform,
      log: deps.log,
      hooks: {
        firstLine: (runId, at, sessionId) => this.onFirstLine(runId, at, sessionId),
        append: (runId, items, at) => this.onAppend(runId, items, at),
        signal: (runId, at) => this.onSignal(runId, at),
        result: () => undefined,
        closed: (runId, end) => this.onClosed(runId, end),
        spawnFailed: (runId, detail) => this.onSpawnFailed(runId, detail),
      },
    })
    this.starter = new RunStarter({
      teamDir: (id) => join(teamsDir(), id),
      loader: this.loader,
      trust: this.trust,
      repoOf: (teamId, repoId) => this.repoOf(teamId, repoId),
      protect: () => this.protectPaths(),
      cliEnv: {
        envForTeam: (runId, teamId, agentId, roleKind) => deps.cli?.envForTeam(runId, teamId, agentId, roleKind) ?? {},
        ready: () => deps.cli?.ready() ?? false,
      },
      resolveCli: (p, env) => (deps.resolveCli ? deps.resolveCli(p, env) : this.defaultResolveCli(p, env)),
      sessionHolder: (p, s) => deps.sessionHolder?.(p, s) ?? null,
      supervisor: this.supervisor,
      now: this.clock,
      log: deps.log,
      baseEnv: deps.baseEnv ?? (() => cleanEnv()),
      platform: this.platform,
      lingering: (teamId) => new Set(this.orphanHolds(teamId).map((l) => l.sessionId).filter((s): s is string => !!s)),
      untrusted: (teamId) => void this.defCheck(teamId),
      worktrees: this.taskWorktrees,
      lock: (runId, cwd) => this.locks.acquire(this.locks.key(cwd), runId),
    })
  }

  /** Spawn cwds of the precise consoles a human is working in (working | action): their trees are busy (G6, Integrar). */
  private humanWriters(): string[] {
    const out: string[] = []
    let snap: PaneStatusEvt[] = []
    try {
      snap = this.deps.status?.snapshot() ?? []
    } catch {
      snap = []
    }
    for (const e of snap) {
      if (!e || isTeamPaneId(e.paneId) || !e.precise || (e.state !== 'working' && e.state !== 'action')) continue
      const cwd = this.deps.pty?.spawnCwd(e.paneId)
      if (cwd) out.push(cwd)
    }
    return out
  }

  /**
   * Decision 72: what a Claude run may never read or write, built from dataDir() (never the whole folder: worktrees
   * live there). Sixth round of the B5 integration: Read of every secret of the folder (DATA_SECRET_PATHS, the list the
   * client guard of a team run shares); the write denies stay teams/, trusted-teams.json and runtime.json, since each
   * path costs six rules on a line cmd.exe caps at 8191 characters when Claude's CLI is a `.cmd`.
   */
  private protectPaths(): { readDeny: string[]; writeDeny: string[] } {
    const d = this.deps.dataDir()
    return { readDeny: DATA_SECRET_PATHS.map((p) => join(d, p)), writeDeny: [join(d, 'teams'), join(d, 'trusted-teams.json'), join(d, 'runtime.json')] }
  }

  /** Decision 12: PATH dirs only, never the app's own shims (status-bin, <dataDir>/bin). */
  private defaultResolveCli(provider: AgentProvider, env: Record<string, string>): ResolvedCli | null {
    let skip: string[] = []
    try {
      skip = statusBinDirs()
    } catch {
      skip = []
    }
    return resolveAgentCli(provider, env, { platform: this.platform, skipDirs: [...skip, join(this.deps.dataDir(), 'bin')] })
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** After CLI init: no-op with Labs off; else enable(). */
  async start(cfg: ConfigFile | null): Promise<void> {
    this.labOn = normalizeLabs(cfg?.settings?.labs).teams
    this.configureSilence(cfg)
    if (!this.labOn || this.frozen) return
    await this.beginEnable()
  }

  /**
   * CONFIG_SAVE: labs.teams off -> disable() (decision 57), on -> enable(); anything else pokes the dispatcher (a no-op
   * while not live). B7: `settings.agents.silence` configures the run silence watch (it arms nothing while no run is watched).
   * B9 (4.4): the takeovers against the saved consoles (a waiting one finds its console, K4; a bound one whose console
   * left the config goes back, K7), then every takeoverBound waiting for its console looks again.
   */
  setConfig(cfg: ConfigFile | null): void {
    this.configureSilence(cfg)
    const on = normalizeLabs(cfg?.settings?.labs).teams
    if (on === this.labOn) {
      if (this.live()) {
        for (const id of [...this.teams.keys()]) this.reconcileTakeoverPanes(id, cfg)
        this.wakePaneWaits()
      }
      // A saved config may free a session a run waits on (a console's lastSession, design 3.6 pokes); no-op while not live.
      this.poke()
      return
    }
    this.labOn = on
    if (on) {
      if (!this.frozen) void this.beginEnable()
    } else this.disable()
  }

  /**
   * The exit hook (snapshotAgentsOnce: before-quit, window-all-closed and the
   * Windows session end, before cliService.shutdown() and ptyManager.killAll()):
   * every active run `interrupted {shutdown}` in one commit per team, every
   * process tree killed synchronously, the tokens revoked, the system files
   * deleted, every store flushed synchronously, every key cleared, the
   * watchers stopped, frozen. Idempotent; nothing is disposed (3.0 item 6).
   * B6 integration: every integrate in flight is halted and its verify tree
   * killed (haltIntegrates); it ends `interrupted` (at the next load at the latest).
   */
  shutdownSync(trigger?: string): void {
    if (this.frozen) return
    const n = this.stopAllRuns('shutdown')
    if (n > 0) this.deps.log(`shutdown ${trigger ?? 'quit'} interrupted runs=${n}`)
    this.haltIntegrates(trigger ?? 'quit')
    this.frozen = true
    this.teardown()
  }

  /**
   * persistBeforeInstall (the NSIS setup closes the app without before-quit):
   * the same interrupt, kill, revoke and flush, but NOT frozen (a cancelled
   * wizard leaves the app running); every run defers `disabled` meanwhile, and
   * (B6 integration) the integrates in flight are halted with their verify
   * trees killed, and a new Integrar answers `busy {install}` until installAborted.
   * Second round: an integrate that already began its land is waited for, to its
   * end commit (a git killed in the middle of a checkout can leave the user's
   * half updated; the land is bounded by its own 10 minute timeout), with a
   * notice that the update waits for it; the others still stop before their
   * next step. Resolves with how many it waited for.
   */
  async prepareInstall(): Promise<number> {
    this.installing = true
    // An integrate outlives Labs off (design 3.1): halted even with the service not enabled.
    this.haltIntegrates('install')
    // No land starts after the halt: these are every land of this app that may still be running.
    const landing = [...this.integrating.entries()].filter(([, v]) => v.land && v.job)
    if (this.enabled) {
      this.stopAllRuns('shutdown')
      for (const rec of this.teams.values()) rec.store.flushSync()
    }
    if (landing.length === 0) return 0
    this.deps.log(`install waits for integrate land(s)=${landing.length}`)
    for (const [key] of landing) {
      const [teamId, taskId] = key.split('|')
      const rec = this.teams.get(teamId) ?? this.newestRecs.get(teamId)
      // B8: a desktop toast only (the update waits on this PC), never a push to the phone.
      if (rec && !this.removedRecs.has(rec)) this.notify(teamId, rec, { rowId: `installWait:${taskId}`, taskId, key: 'teams.push.installWait', urgent: false, push: false })
    }
    await Promise.allSettled(landing.map(([, v]) => v.job))
    // A loaded store defers the flush of their end commits (one that is not live wrote them at once): flushed here,
    // before the setup runs.
    for (const rec of this.teams.values()) rec.store.flushSync()
    this.deps.log(`install: integrate land(s) over`)
    return landing.length
  }

  /** setInstalling(false): the wizard did not proceed. */
  installAborted(): void {
    if (!this.installing) return
    this.installing = false
    this.poke()
  }

  /** Interrupts every active run of every team (one commit per team), then kills every process tree; the run count. */
  private stopAllRuns(cause: 'shutdown' | 'labsOff'): number {
    let n = 0
    for (const [teamId, rec] of this.teams) {
      if (rec.store.rt.activeRuns.length === 0) continue
      const res = this.commit(teamId, interruptAll(rec.store.rt, cause, this.runPolicy, { now: this.clock() }), ['agents', 'run', 'list'])
      if (res.ok) n += res.result.runIds.length
    }
    this.supervisor.shutdownSync()
    return n
  }

  /** Unfreeze and enable again (a cancelled session end, macOS activate); refused once the app is quitting. */
  thaw(): void {
    if (!this.frozen || this.quitting) return
    this.frozen = false
    if (this.labOn) void this.beginEnable()
  }

  /** before-quit and will-quit: thaw() is refused from here on. */
  markQuitting(): void {
    this.quitting = true
  }

  /** The only place the DeadlineTimer and the run SilenceWatch are disposed; a request after it answers `disabled`. */
  dispose(): void {
    this.disposed = true
    this.teardown()
    this.timer.dispose()
    this.silence.dispose()
  }

  /** Pending deadlines (tests: zero with Labs off). */
  get pendingTimers(): number {
    return this.timer.size
  }

  /** Runs the silence watch follows (tests: none with Labs off). */
  get silenceWatchCount(): number {
    return this.silenceWatched.size
  }

  private live(): boolean {
    return this.enabled && !this.frozen
  }

  private beginEnable(): Promise<void> {
    if (this.enabled || this.disposed) return Promise.resolve()
    if (this.enabling) return this.enabling
    const p = this.enable().finally(() => {
      if (this.enabling === p) this.enabling = null
    })
    this.enabling = p
    return p
  }

  /**
   * Registry, trash purge, then every team: store, definition, trust, roster,
   * watcher; a `list` change at the end (a renderer that got `disabled` meanwhile
   * pulls the list at once). An index.json that cannot be read (logged by the
   * registry) leaves the service not enabled: the next request tries again.
   */
  private async enable(): Promise<void> {
    const epoch = ++this.epoch
    let entries: TeamIndexEntry[]
    try {
      entries = this.registry.list()
    } catch {
      return
    }
    this.registry.purge()
    const loadedTeams: TeamRecord[] = []
    for (const e of entries) {
      let rec: TeamRecord | null = null
      try {
        rec = await this.loadTeam(e, epoch)
      } catch (err) {
        // One team that cannot load never keeps the others down.
        this.teams.get(e.id)?.store.dispose()
        this.teams.delete(e.id)
        this.deps.log(`load ${e.id} failed ${(err as Error).name}`)
      }
      if (epoch !== this.epoch) {
        rec?.store.dispose()
        for (const r of loadedTeams) {
          r.stopWatch?.()
          r.store.dispose()
        }
        return
      }
      if (rec) loadedTeams.push(rec)
    }
    this.enabled = true
    for (const rec of loadedTeams) rec.stopWatch = this.loader.watch(rec.entry.id, rec.entry.repoRoot, () => this.onDefEvent(rec.entry.id))
    // B6 (design 3.7): what a quit mid-integrate left in each team's integrate folder, then its verify log prune.
    for (const rec of loadedTeams) this.track(this.sweepIntegrate(rec))
    // B7 (design 3.8): routines armed again, with what came due while the app or the lab was off (once within 2 h).
    for (const rec of loadedTeams) this.armRoutines(rec.entry.id, true)
    // B9 (4.4): every takeover against the saved consoles (a bound one whose console is gone goes back, a waiting one
    // finds its console), then the `bind:` deadline of each one still waiting (deadlines are memory only).
    const cfg = this.deps.config()
    for (const rec of loadedTeams) {
      this.reconcileTakeoverPanes(rec.entry.id, cfg)
      this.syncBindKeys(rec.entry.id)
    }
    this.deps.log(`enabled teams=${loadedTeams.length}`)
    this.emit('', ['list'])
    // The rows the load itself opened (a reaped run's card, a repair's) against each team's baseline (design 3.1).
    for (const rec of loadedTeams) this.noticeNeeds(rec.entry.id)
    for (const rec of loadedTeams) if (rec.store.rt.autopilot) this.autopilotSoon(rec.entry.id)
    // Decision 64: the processes of reaped runs that still live (main crashed, the children did not).
    for (const rec of loadedTeams) {
      // Dropped from reapedAtLoad only by a check that completes (a teardown first leaves it for the next enable).
      // Until then those runs hold their sessions and trees (orphanHolds), so this pass and any other before the
      // check settles cannot resume them; the check pokes again when it settles.
      const reaped = this.reapedAtLoad.get(rec.entry.id) ?? []
      if (reaped.length) void this.orphanCheck(rec.entry.id, reaped, epoch)
    }
    this.poke()
  }


  private async loadTeam(e: TeamIndexEntry, epoch: number): Promise<TeamRecord | null> {
    const loaded = await this.loader.load(e.repoRoot)
    if (epoch !== this.epoch) return null
    this.trust.reload(e.id)
    const trusted = this.trust.trusted(e.id)
    const { store, reaped, repaired, effects } = TeamStore.load(this.storeDeps(e.id), e.id, trusted)
    // Reaped runs (R10: interrupted {crash}) join the runs ring; their pids are never signalled here.
    for (const r of reaped) store.recordRun(r)
    if (reaped.length) this.deps.log(`reaped ${e.id} runs=${reaped.length}`)
    const withPid = reaped.filter((r) => typeof r.pid === 'number' && r.startedAt !== undefined)
    if (withPid.length) this.reapedAtLoad.set(e.id, [...(this.reapedAtLoad.get(e.id) ?? []).filter((r) => !withPid.some((x) => x.id === r.id)), ...withPid])
    this.sweepRunFiles(e.id)
    const rec: TeamRecord = { entry: e, store, loaded, trust: 'missing', repoIssues: [], repos: new Map(), stopWatch: null }
    this.teams.set(e.id, rec)
    this.newestRecs.set(e.id, rec)
    // The effects of the load's reaper step (B9: the comments a held Lead's escalation note archived) run on this store.
    this.runEffects(e.id, effects)
    await this.recompute(rec)
    if (epoch !== this.epoch) return rec
    // B5 notices (design 3.1): the baseline is the persisted `needsSeen`, never empty, so a restart re-notifies
    // nothing still pending (a card the reaper or the repair opened at load is new and notifies once). A team
    // written before B5 has none: what waits now is its baseline. A state.json the repair reset lost its baseline
    // with it: its only card is the repair's `stateReset`, which notifies once; the trust and pause rows stay seen.
    if (store.rt.needsSeen === undefined) {
      const reset = repaired.includes('state.json')
      store.setNeedsSeen(needsRowsOf(rec, trusted).filter((r) => !(reset && r.kind === 'card')).map((r) => needSeenKey(r, store.rt)))
    }
    this.recheckApplying(e.id, rec)
    // B7: a run's stalled card goes with its run (design 3.8); the reaper ended those runs without the run-end path.
    const stalled = dismissStaleStalledCards(store.rt)
    if (stalled !== store.rt) this.commit(e.id, committed(stalled), ['needs'])
    // B6 (design 3.7): an integrate the app quit in the middle of is `failed {interrupted}`; one still in flight in this
    // app (a Labs toggle reloaded the store meanwhile) keeps running and its end commit lands on this store.
    const stale = interruptedIntegrates(store.rt, (taskId) => this.integrating.has(`${e.id}|${taskId}`), { now: this.clock() })
    if (stale.ok && stale.result.taskIds.length) {
      this.commit(e.id, stale, ['task', 'board', 'needs'])
      this.deps.log(`integrate ${e.id} interrupted ${stale.result.taskIds.join(',')}`)
    }
    // B5 review, second round: a pending hire on a base that is no longer the trusted hash (a trust whose cancel never
    // reached the disk, a state written before the cancel existed) can never be approved: cancelled stale at load too.
    const trustedNow = this.trust.trusted(e.id)
    if (trustedNow) this.dropStaleHires(e.id, rec, trustedNow.sha256)
    const snap = this.trust.snapshotState(e.id)
    if (snap === 'bad') {
      // Decision 34: an edited snapshot or a TrustStore entry that does not match it.
      this.commit(e.id, openSystemCard(store.rt, { why: 'stateReset', actions: ['dismiss'], vars: { what: 'trust' } }, { now: this.clock() }), ['needs', 'list'])
    } else if (snap === 'unreadable') {
      // B close: a lock or a permission is no tampering: no card, nothing trusted until a read lands.
      this.deps.log(`trust ${e.id} unreadable`)
    }
    const ctx = this.flowCtx(e.id)
    if (ctx) this.commit(e.id, reconcileAgents(store.rt, ctx), ['agents'])
    // Decision 27: old done and cancelled tasks move to the archive (at load, and when a create finds the board full).
    const swept = archiveSweep(store.rt, { now: this.clock() })
    if (swept.ok && swept.rt !== store.rt) {
      const n = store.rt.tasks.length - swept.rt.tasks.length
      this.commit(e.id, swept, changedScopes(store.rt, swept.rt))
      this.deps.log(`archived ${e.id} tasks=${n}`)
    }
    return rec
  }

  /** Labs off (decision 57): live runs interrupted (not counted), flush, clear every key, stop the watchers, answer `disabled`. */
  private disable(): void {
    const had = this.enabled || this.enabling !== null
    if (this.enabled) this.stopAllRuns('labsOff')
    this.teardown()
    // Changes still queued for this tick name teams that are gone: `disabled` is the last word.
    this.pendingEmits.clear()
    if (had) this.deps.emit({ teamId: '', rev: 0, scopes: ['disabled'] })
  }

  private teardown(): void {
    this.epoch++
    this.enabled = false
    this.enabling = null
    // Nothing runs past here (a disposed or frozen service kills what is left, and owns no key).
    this.supervisor.shutdownSync()
    this.dispatcher.stop()
    this.locks.releaseRuns()
    this.discarded.clear()
    this.waitsOnConsoles.clear()
    this.prepBackoff.clear()
    // B7 (3.0 item 6): no routine key and no watched run is left (the timer and the watch themselves stay).
    this.routines.disarmAll()
    for (const runId of [...this.silenceWatched]) this.unwatchSilence(runId)
    this.runSilence.clear()
    for (const [id, rec] of this.teams) {
      rec.stopWatch?.()
      rec.stopWatch = null
      this.timer.clear(`defwatch:${id}`)
      for (const r of rec.store.rt.activeRuns) for (const k of ['max', 'conclude']) this.timer.clear(`run:${r.id}:${k}`)
      // B9: a waiting takeover's `bind:` deadline is armed again by the next enable (from its `at`).
      for (const a of rec.store.rt.agents) this.timer.clear(takeoverBindKey(id, a.id))
      rec.store.dispose()
    }
    this.teams.clear()
    // B9: a takeover op waiting for its run or its console answers now (its team is gone: not_found).
    for (const w of [...this.takeoverWaits]) w.done()
    this.wakePaneWaits(true)
    // A removeTeam waiting for its runs goes on (it then finds its team gone: not_found).
    for (const id of [...this.idleWaiters.keys()]) this.wakeIdle(id)
    this.watched = null
    this.runDetail.clear()
    this.consumedMark.clear()
    this.awakeAt.clear()
    this.runWrites.clear()
    this.archivedCounts.clear()
    // The orphans of decision 64 (and a check not done yet) outlive a Labs toggle or a freeze: their processes
    // still live, their cards stay open in the store, and only pidAlive or killOrphan lets their sessions go.
  }

  private storeDeps(teamId: string): TeamStoreDeps {
    return {
      dir: () => join(this.deps.dataDir(), 'teams', teamId),
      emit: (scopes, hint) => this.emit(teamId, scopes, hint),
      timer: this.timer,
      live: () => this.live(),
      now: this.clock,
      log: this.deps.log,
      fs: this.deps.storeFs,
      strict: this.deps.strict,
      reap: (rt, recent) => {
        const res = reapOnLoad(rt, recent, this.runPolicy, { now: this.clock() })
        if (!res.ok) return res
        // B7: a routine wake the reaper's re-wake wrote over (a crash) is owed; the catch-up of this enable runs it.
        const displaced = this.displacedWakes(teamId, rt, res.rt)
        for (const d of displaced) this.deps.log(`routine ${teamId} ${d.routineId} wake displaced on ${d.agentId} by ${d.by} at load: ${d.owed ? 'owed to the catch-up' : 'dropped, the routine is off'}`)
        let out = displaced.length ? withDisplaced(res.rt, displaced) : res.rt
        let effects = res.effects
        // B9 (4.4): a releasing takeover is bound again, a stopping one whose run the reaper ended hands its session
        // over (bindPending; enable arms its `bind:` deadline), before the load checks the invariants.
        const tk = takeoversAtLoad(out, { now: this.clock() })
        if (tk.ok && tk.rt !== out) {
          out = tk.rt
          // A held Lead's leadEscalation note in a full Lead thread archives its oldest delivered comments: loadTeam
          // runs that effect once the store is held, or they would be cut.
          effects = [...effects, ...tk.effects]
          this.deps.log(`takeover ${teamId} at load: held=${tk.result.held.join(',') || '-'} dropped=${tk.result.dropped.join(',') || '-'} escalated=${tk.result.escalated.join(',') || '-'}`)
        }
        return out === res.rt ? res : { ...res, rt: out, effects }
      },
    }
  }

  private teamDir(teamId: string): string {
    return join(this.deps.dataDir(), 'teams', teamId)
  }

  /**
   * At enable (no run is active then): the system files left by an earlier
   * life (deleted at finalize, design 3.3), and the run logs past 30 days or
   * beyond TEAM_LOGS_MAX_BYTES per team, oldest first, never a live run's.
   */
  private sweepRunFiles(teamId: string): void {
    const dir = join(this.teamDir(teamId), 'runs')
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    const active = new Set(this.teams.get(teamId)?.store.rt.activeRuns.map((r) => r.id) ?? [])
    for (const n of names) {
      const m = /^(r-[a-f0-9]{12})\.system\.md$/.exec(n)
      if (m && !active.has(m[1])) rmSync(join(dir, n), { force: true })
    }
    void this.pruneRunLogs(teamId)
  }

  /** Run logs pruned by age and size (design 3.3), never a live run's; at enable and after each run end. */
  private async pruneRunLogs(teamId: string): Promise<void> {
    const dir = join(this.teamDir(teamId), 'runs')
    try {
      // File ages are wall-clock times (mtime), never the injected clock.
      const now = Date.now()
      const live = new Set(this.teams.get(teamId)?.store.rt.activeRuns.map((r) => r.id) ?? [])
      const files: Array<{ name: string; at: number; size: number }> = []
      for (const name of await fsp.readdir(dir)) {
        const m = /^(r-[a-f0-9]{12})\.jsonl$/.exec(name)
        if (!m || live.has(m[1])) continue
        const st = await fsp.stat(join(dir, name)).catch(() => null)
        if (st?.isFile()) files.push({ name, at: st.mtimeMs, size: st.size })
      }
      files.sort((a, b) => a.at - b.at)
      let total = files.reduce((s, f) => s + f.size, 0)
      for (const f of files) {
        if (now - f.at <= TEAM_LOG_TTL_MS && total <= TEAM_LOGS_MAX_BYTES) break
        await fsp.rm(join(dir, f.name), { force: true }).catch(() => undefined)
        total -= f.size
      }
    } catch {
      /* no runs folder yet */
    }
  }

  /**
   * Decision 64, async after enable: a reaped pid that is alive with a start
   * time inside `[startedAt - 30 s, startedAt + 30 s]` and one of our images is
   * an orphan: it keeps its session and cwd busy (the lingering set) and gets
   * one `orphan` card. A mismatch is somebody else's process and is ignored.
   */
  private async orphanCheck(teamId: string, reaped: readonly Run[], epoch: number): Promise<void> {
    const probe = this.deps.procStartTime ?? ((pid: number) => realProcStartTime(pid))
    const found: Lingering[] = []
    for (const r of reaped) {
      if (typeof r.pid !== 'number' || r.startedAt === undefined) continue
      let info: { at: number; image: string } | null = null
      try {
        info = await probe(r.pid)
      } catch {
        info = null
      }
      if (!info || !this.orphanMatch(info, r.startedAt)) continue
      const l: Lingering = { runId: r.id, agentId: r.agentId, pid: r.pid, startedAt: r.startedAt, cwd: r.cwd }
      if (r.sessionId) l.sessionId = r.sessionId
      found.push(l)
    }
    // A teardown came first: the runs stay in reapedAtLoad and the next enable checks them again.
    if (epoch !== this.epoch || !this.live()) return
    const rec = this.teams.get(teamId)
    if (!rec) return
    // Settled: until here every reaped run with a live pid held its session and tree (orphanHolds); a pass now sees
    // only the confirmed orphans, so the check pokes once it settles, whatever it found.
    this.reapedAtLoad.delete(teamId)
    if (found.length === 0) {
      this.poke()
      return
    }
    const byRun = new Map(reaped.map((r) => [r.id, r]))
    const res = this.commit(
      teamId,
      orphanCards(rec.store.rt, found.map((l) => ({ runId: l.runId, agentId: l.agentId, taskId: byRun.get(l.runId)?.taskId, pid: l.pid })), { now: this.clock() }),
      ['needs', 'agents'],
    )
    if (res.ok) {
      for (const c of res.result.cards) {
        const l = found.find((x) => x.runId === c.runId)
        if (l) l.cardId = c.cardId
      }
    }
    this.lingering.set(teamId, [...(this.lingering.get(teamId) ?? []).filter((l) => !found.some((x) => x.runId === l.runId)), ...found])
    this.deps.log(`orphans ${teamId} n=${found.length}`)
    this.poke()
  }

  private orphanMatch(info: { at: number; image: string }, startedAt: number): boolean {
    const image = info.image.toLowerCase().replace(/\.exe$/, '')
    return ORPHAN_IMAGES.has(image) && Math.abs(info.at - startedAt) <= ORPHAN_START_SLACK_MS
  }

  /**
   * Lingering entries whose process died go (their cards dismissed), and so do
   * the ones whose card the user dismissed (a reused pid would hold the
   * session forever): checked on every gate, never on a timer.
   */
  private dropDeadOrphans(teamId: string): void {
    const list = this.lingering.get(teamId)
    if (!list || list.length === 0) return
    const rec = this.teams.get(teamId)
    const open = new Set(rec?.store.rt.cards.filter((c) => c.state === 'open').map((c) => c.id) ?? [])
    const alive = list.filter((l) => (!l.cardId || open.has(l.cardId)) && this.treeKill.alive(l.pid))
    if (alive.length === list.length) return
    this.lingering.set(teamId, alive)
    if (!rec) return
    const gone = new Set(list.filter((l) => !alive.includes(l)).map((l) => l.cardId).filter((id): id is string => !!id))
    const cards = rec.store.rt.cards.map((c) => (gone.has(c.id) && c.state === 'open' ? { ...c, state: 'dismissed' as const } : c))
    this.commit(teamId, { ok: true, rt: { ...rec.store.rt, cards }, effects: [], result: undefined }, ['needs'])
  }

  /**
   * The `killOrphan` card action (B5's answer op calls it): the start time is
   * confirmed again right before the tree kill (a reused pid is never
   * signalled), then the entry and its card go; the run is requested again by
   * its level (or by hand) once the session is free.
   */
  async killOrphan(teamId: string, cardId: string): Promise<TeamFail | null> {
    const list = this.lingering.get(teamId) ?? []
    const l = list.find((x) => x.cardId === cardId)
    if (!l) return fail('not_found')
    const probe = this.deps.procStartTime ?? ((pid: number) => realProcStartTime(pid))
    let info: { at: number; image: string } | null = null
    try {
      info = await probe(l.pid)
    } catch {
      info = null
    }
    if (info && this.orphanMatch(info, l.startedAt)) {
      this.treeKill.sync(l.pid)
      this.deps.log(`orphan ${l.runId} killed`)
    } else this.deps.log(`orphan ${l.runId} gone or not ours: not signalled`)
    this.lingering.set(teamId, (this.lingering.get(teamId) ?? []).filter((x) => x !== l))
    const rec = this.teams.get(teamId)
    if (rec) {
      const cards = rec.store.rt.cards.map((c) => (c.id === cardId && c.state === 'open' ? { ...c, state: 'dismissed' as const } : c))
      this.commit(teamId, { ok: true, rt: { ...rec.store.rt, cards }, effects: [{ kind: 'dispatch' }], result: undefined }, ['needs', 'agents'])
    }
    return null
  }

  /**
   * What the processes of decision 64 hold in a team: the lingering orphans and, until the team's orphan check
   * settles, every run its load reaped whose pid still lives (the probe takes seconds on Windows, and a pass before
   * it ends would resume the orphan's session next to it, or write in its tree).
   */
  private orphanHolds(teamId: string): Array<{ sessionId?: string; cwd: string }> {
    const out: Array<{ sessionId?: string; cwd: string }> = [...(this.lingering.get(teamId) ?? [])]
    for (const r of this.reapedAtLoad.get(teamId) ?? []) {
      if (typeof r.pid !== 'number' || !this.treeKill.alive(r.pid)) continue
      out.push(r.sessionId ? { sessionId: r.sessionId, cwd: r.cwd } : { cwd: r.cwd })
    }
    return out
  }

  /** Session ids and cwds the lingering orphans of a team hold (G5 / G6), the runs its orphan check still probes included. */
  lingeringOf(teamId: string): { sessions: Set<string>; cwds: Set<string> } {
    this.dropDeadOrphans(teamId)
    const list = this.orphanHolds(teamId)
    return { sessions: new Set(list.map((l) => l.sessionId).filter((s): s is string => !!s)), cwds: new Set(list.map((l) => this.locks.key(l.cwd))) }
  }

  // ---- deadlines -------------------------------------------------------------------------------

  private onDue(key: string): void {
    const colon = key.indexOf(':')
    const kind = colon < 0 ? key : key.slice(0, colon)
    const rest = colon < 0 ? '' : key.slice(colon + 1)
    switch (kind) {
      case DISPATCH_KEY:
        this.dispatcher.onDue()
        return
      case 'flush':
        this.teams.get(rest)?.store.flushSync()
        return
      case 'defwatch':
        void this.defCheck(rest)
        return
      case 'routine':
        this.routines.onDue(key)
        return
      case 'run': {
        // linger, drain, stop and kill are the supervisor's; max and conclude stop the run through the store.
        if (this.supervisor.onDeadline(key)) return
        const m = /^(r-[a-f0-9]{12}):(max|conclude)$/.exec(rest)
        const teamId = m ? this.teamOfRun(m[1]) : null
        if (!m || !teamId) return
        const rec = this.teams.get(teamId)
        if (!rec) return
        const reason = m[2] === 'max' ? 'timeout' : 'concluded'
        this.deps.log(`run ${m[1]} stop ${reason}`)
        this.commit(teamId, requestStop(rec.store.rt, m[1], reason, { now: this.clock() }, this.runPolicy), ['agents', 'run'], { runId: m[1] })
        return
      }
      case 'bind':
        this.onBindDue(rest)
        return
      default:
        this.deps.log(`deadline ${kind} not handled`)
    }
  }

  private onDefEvent(teamId: string): void {
    if (!this.live() || !this.teams.has(teamId)) return
    this.timer.set(`defwatch:${teamId}`, this.clock() + DEFWATCH_MS)
  }

  /** One definition check per team at a time: a check asked while one runs waits for it, then looks again. */
  private defCheck(teamId: string): Promise<void> {
    const prev = this.checks.get(teamId) ?? Promise.resolve()
    const next = prev.then(() => this.defCheckNow(teamId)).catch((err) => this.deps.log(`defcheck ${teamId} failed ${(err as Error).name}`))
    this.checks.set(teamId, next)
    void next.then(() => {
      if (this.checks.get(teamId) === next) this.checks.delete(teamId)
    })
    return next
  }

  /** The definition moved on disk: re-load, re-resolve, re-derive the cached trust state; emit when it changed anything. */
  private async defCheckNow(teamId: string): Promise<void> {
    const rec = this.teams.get(teamId)
    if (!rec || !this.live()) return
    const epoch = this.epoch
    // load() is the stamp walk and returns its cached result while nothing moved; compared with
    // this record's own load, so a load made by another op (a probe) never hides a change.
    const loaded = await this.loader.load(rec.entry.repoRoot)
    if (epoch !== this.epoch || this.teams.get(teamId) !== rec) return
    const prev = rec.loaded
    if (loaded === prev || ('error' in loaded && 'error' in prev && loaded.error === prev.error)) return
    const before = rec.trust
    const sha = 'error' in rec.loaded ? null : rec.loaded.sha256
    const issues = issueKey(rec.loaded)
    rec.loaded = loaded
    await this.recompute(rec)
    const shaNow = 'error' in loaded ? null : loaded.sha256
    // The problems too: a misnamed file comes and goes without moving the sha, and an invalid team stays invalid.
    if (before !== rec.trust || sha !== shaNow || issues !== issueKey(loaded)) {
      this.deps.log(`defcheck ${teamId} ${before}->${rec.trust}`)
      this.emit(teamId, ['team', 'list', 'needs'])
    }
  }

  async refreshTrust(teamId: string): Promise<void> {
    await this.defCheck(teamId)
  }

  /** Extra repos and the cached trust state of a team from its latest load. */
  private async recompute(rec: TeamRecord): Promise<void> {
    const id = rec.entry.id
    const loaded = rec.loaded
    let repoIssues: DefError[] = []
    let loadedRepos: Map<string, ResolvedRepo | DefError> | null = null
    if (!('error' in loaded) && loaded.result.ok) {
      const r = await this.resolveRepos(rec.entry.repoRoot, loaded.result.def, loaded.files)
      repoIssues = r.issues
      loadedRepos = r.repos
    }
    const trusted = this.trust.trusted(id)
    let repos = new Map<string, ResolvedRepo | DefError>()
    if (trusted) {
      repos = loadedRepos && !('error' in loaded) && loaded.sha256 === trusted.sha256 ? loadedRepos : (await this.resolveRepos(rec.entry.repoRoot, trusted.def, trusted.files)).repos
    }
    // A trust op replaced the load while the repos resolved: its state stands (a later check
    // compares against that load by identity and would never repair a stale `changed`).
    if (rec.loaded !== loaded || this.trust.trusted(id) !== trusted) return
    rec.repos = repos
    rec.repoIssues = repoIssues
    let state = this.trust.state(rec.entry.repoRoot, loaded, id)
    if (repoIssues.length > 0 && state !== 'missing') state = 'invalid'
    this.setTrust(rec, state)
  }

  private setTrust(rec: TeamRecord, state: TeamTrustState): void {
    if (state === rec.trust && (state === 'trusted' || rec.trustSince !== undefined)) return
    if (state === 'trusted') delete rec.trustSince
    else if (rec.trust === 'trusted' || rec.trustSince === undefined) rec.trustSince = this.clock()
    rec.trust = state
  }

  // ---- requests --------------------------------------------------------------------------------

  /**
   * registerTeamsIpc and the phone entry. Frozen and not quitting -> thaw()
   * first; Labs on but a failed enable (index.json unreadable) -> enable again,
   * io while it still fails; Labs off -> disabled; a phone asking a
   * desktop-only op -> bad_request; unknown team -> not_found; the trust gate;
   * then the op. Never throws (io).
   */
  request(req: TeamRequest, origin: 'desktop' | 'phone'): Promise<TeamReply> {
    return this.serve(req, origin, false)
  }

  /** request(); `ctl` (B8) lets one of the phone ctls' ops (PHONE_CTL_OPS) past the PHONE_TEAM_OPS gate, only from remoteView.ctl. */
  private async serve(req: TeamRequest, origin: 'desktop' | 'phone', ctl: boolean): Promise<TeamReply> {
    try {
      if (this.frozen && !this.quitting) this.thaw()
      const retry = this.labOn && !this.frozen && !this.quitting && !this.disposed
      if (retry && !this.enabled && !this.enabling) void this.beginEnable()
      if (this.enabling) await this.enabling
      if (!this.live()) return fail(retry && this.labOn && !this.frozen ? 'io' : 'disabled')
      if (origin === 'phone' && !isPhoneTeamOp(req.op) && !(ctl && PHONE_CTL_OPS.has(req.op))) return fail('bad_request')
      if ('teamId' in req) {
        const rec = this.teams.get(req.teamId)
        if (!rec) return fail('not_found')
        const gated = TRUST_GATED_OPS.has(req.op) && !(req.op === 'dispatch' && !req.go)
        if (gated && rec.trust !== 'trusted') return fail('untrusted')
      }
      const handler = OPS[req.op] as OpHandler<TeamOp>
      return await handler(req as never, { origin, actor: { kind: 'user', via: origin }, svc: this, now: this.clock() })
    } catch (err) {
      this.deps.log(`request ${req.op} failed ${(err as Error).name}`)
      return fail('io')
    }
  }

  // ---- TeamInternals ---------------------------------------------------------------------------

  dataDir(): string {
    return this.deps.dataDir()
  }

  config(): ConfigFile | null {
    return this.deps.config()
  }

  now(): number {
    return this.clock()
  }

  log(line: string): void {
    this.deps.log(line)
  }

  openPath(path: string): Promise<string> {
    return this.deps.openPath(path)
  }

  idOf(repoRoot: string): string {
    return teamIdOf(repoRoot, this.deps.platform)
  }

  team(teamId: string): TeamRecord | null {
    return this.teams.get(teamId) ?? null
  }

  trusted(teamId: string): TrustedDefinition | null {
    return this.trust.trusted(teamId)
  }

  shownDef(rec: TeamRecord): TeamDefinition | null {
    const trusted = this.trust.trusted(rec.entry.id)
    if (trusted) return trusted.def
    return 'error' in rec.loaded || !rec.loaded.result.ok ? null : rec.loaded.result.def
  }

  serial<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(teamId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    const tail = next.catch(() => undefined)
    this.chains.set(teamId, tail)
    void tail.then(() => {
      if (this.chains.get(teamId) === tail) this.chains.delete(teamId)
    })
    return next
  }

  flowCtx(teamId: string): FlowCtx | null {
    const def = this.trust.trusted(teamId)
    if (!def) return null
    return {
      now: this.clock(),
      def,
      newRunId: () => `r-${randomBytes(6).toString('hex')}`,
      newSessionId: () => randomUUID(),
    }
  }

  /**
   * store.commit plus the effects of the result. A commit that moves a
   * TeamView field (teamHeaderKey: a run that starts or ends, the usage of
   * today, a provider limit, a pause, a need) also carries the `team` scope,
   * at its new rev, so the header and the Te necesita count never go stale.
   */
  commit<R>(teamId: string, res: FlowResult<R>, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): FlowResult<R> {
    const rec = this.teams.get(teamId)
    if (!rec) return res
    // B9 (K2): a run that ends while a takeover stops it hands its session over in that end's own commit, whatever
    // path ended it (its close, a forced stop, Labs off, a quit); a held Lead's pending approvals go to the user in
    // that same commit (escalateHeldLead). What it moved joins the scopes and its effects run with the rest.
    if (res.ok) {
      const settled = settleTakeovers(res.rt, { now: this.clock() })
      if (settled.ok && settled.rt !== res.rt) {
        scopes = [...new Set<TeamScope>([...scopes, ...changedScopes(res.rt, settled.rt)])]
        res = { ...res, rt: settled.rt, effects: [...res.effects, ...settled.effects] }
        if (settled.result.held.length) this.deps.log(`takeover ${teamId} run ended: holding ${settled.result.held.join(',')}`)
        if (settled.result.dropped.length) this.deps.log(`takeover ${teamId} run ended without a session: ${settled.result.dropped.join(',')}`)
        if (settled.result.escalated.length) this.deps.log(`takeover ${teamId} the Lead is in a console: ${settled.result.escalated.join(',')} to the user`)
      }
    }
    // A task run that is admitted, starts or ends moves its card (run glyph, phase): the board and the task drawer refresh.
    const hintRun = hint?.runId
    if (res.ok && hintRun && !hint?.taskId) {
      const run = rec.store.rt.activeRuns.find((r) => r.id === hintRun) ?? res.rt.activeRuns.find((r) => r.id === hintRun)
      if (run?.taskId) {
        hint = { ...hint, taskId: run.taskId }
        scopes = [...new Set<TeamScope>([...scopes, 'board', 'task'])]
      }
    } else if (res.ok && hint?.runId && hint.taskId && !scopes.includes('board')) {
      scopes = [...new Set<TeamScope>([...scopes, 'board', 'task'])]
    }
    const header = res.ok && !scopes.includes('team') ? teamHeaderKey(rec, this.trust.trusted(teamId), this.clock()) : null
    const before = rec.store.rt
    // B7: a routine wake this result writes over in its agent's slot is owed in the same commit (displacedFor).
    const displaced = res.ok && res.rt !== before ? this.displacedWakes(teamId, before, res.rt) : []
    const out = rec.store.commit(displaced.length && res.ok ? { ...res, rt: withDisplaced(res.rt, displaced) } : res, scopes, hint)
    if (!out.ok) return out
    if (displaced.length) this.retryDisplaced(teamId, displaced)
    // The effects first: a run end joins the runs ring there (usageToday).
    this.runEffects(teamId, out.effects)
    // B9: the takeover ops waiting on a run end and the `bind:` deadlines follow the committed agents.
    if (out.rt.agents !== before.agents) this.takeoversMoved(teamId)
    if (header !== null && this.teams.get(teamId) === rec && teamHeaderKey(rec, this.trust.trusted(teamId), this.clock()) !== header) this.emit(teamId, ['team'], hint)
    // 2.9.0: what this commit opened (an approval, a question, a failed integrate) the autopilot may clear.
    if (out.rt.autopilot && out.rt !== before && this.teams.get(teamId) === rec) this.autopilotSoon(teamId)
    return out
  }

  /** Effects of a committed result (design 3.0 item 3); each later milestone handles its own kinds. */
  private runEffects(teamId: string, effects: readonly TeamEffect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case 'dispatch':
          this.poke()
          break
        case 'deadline':
          if (e.at === null) this.timer.clear(e.key)
          else if (this.live()) this.timer.set(e.key, e.at)
          break
        case 'ended':
          this.runEnded(teamId, e.run)
          break
        case 'prepare':
          this.prepare(teamId, e.runId)
          break
        case 'stopRun':
          this.supervisor.stop(e.runId)
          break
        case 'revokeRun':
          try {
            this.deps.cli?.revokeTeam(e.runId)
          } catch (err) {
            this.deps.log(`revoke ${e.runId} failed ${(err as Error).name}`)
          }
          break
        case 'releaseLocks':
          this.locks.releaseAll(e.runId)
          break
        case 'deleteSystemFile':
          try {
            rmSync(join(this.teamDir(teamId), 'runs', `${e.runId}.system.md`), { force: true })
          } catch {
            /* swept at the next enable */
          }
          break
        case 'synthetic':
          this.synthetic(teamId, e.runId, e.on)
          break
        case 'archiveComments': {
          this.teams.get(teamId)?.store.appendArchive(e.target, e.comments)
          const key = `${teamId}|${e.target}`
          const n = this.archivedCounts.get(key)
          if (n !== undefined) this.archivedCounts.set(key, n + e.comments.length)
          break
        }
        case 'archiveTasks':
          this.teams.get(teamId)?.store.appendArchive('tasks', e.tasks)
          break
        case 'disownWorktree':
          // B close: only while the manifest still names this task as the owner (disownAt CASes it).
          if (this.taskWorktrees?.disownTree({ path: e.path, owner: e.owner })) this.deps.log(`worktree ${teamId} ${e.taskId} disowned: archived`)
          break
        case 'applyHire':
          this.applyHire(teamId, e.approvalId)
          break
        case 'teamNote':
          // B7: a Codex block's `team.note` (the CLI path writes through ctlNote and answers the id).
          void this.writeTeamNote(teamId, { text: e.text, ...(e.title ? { title: e.title } : {}) }).then((r) =>
            this.deps.log(`run ${e.runId} team.note (block) ${'id' in r ? `written ${r.id}` : `failed ${r.error}`}`),
          )
          break
        default:
          this.deps.log(`effect ${e.kind} ${teamId} not handled`)
      }
    }
  }

  /**
   * A terminal run: the runs ring, the run memory dropped, the watched renderer told, logs pruned. B7: its silence is
   * no longer watched and its stalled card goes with it (design 3.8).
   */
  private runEnded(teamId: string, run: Run): void {
    const rec = this.teams.get(teamId)
    rec?.store.recordRun(run)
    this.runDetail.delete(run.id)
    this.consumedMark.delete(run.id)
    this.awakeAt.delete(run.id)
    this.runWrites.delete(run.id)
    this.unwatchSilence(run.id)
    if (rec) {
      const rt = dismissStalledCard(rec.store.rt, run.id)
      if (rt !== rec.store.rt) this.commit(teamId, committed(rt), ['needs'])
    }
    if (this.watched?.runId === run.id) this.sendRun({ teamId, runId: run.id, agentId: run.agentId, items: [], state: run.state })
    this.deps.log(`run ${run.id} ended ${run.state}${run.failure ? ` ${run.failure.kind}${run.failure.code ? `:${run.failure.code}` : ''}` : ''}${run.interruptCause ? ` cause=${run.interruptCause}` : ''}`)
    if (rec && rec.store.rt.activeRuns.length === 0) this.wakeIdle(teamId)
    // Not while the team is removed: an async readdir or stat in its runs folder would race the trash rename (EPERM on Windows).
    if (this.live() && !this.removing.has(teamId)) void this.pruneRunLogs(teamId)
  }

  /** Wakes the Dispatcher: one pass on the next tick (timer key `dispatch`). No-op while not live or installing (3.0 item 6). */
  poke(): void {
    if (!this.live() || this.installing) return
    this.dispatcher.poke()
  }

  // ---- runs (B2) -------------------------------------------------------------------------------

  /** The team of an active run (a handful of teams and runs: a scan). */
  private teamOfRun(runId: string): string | null {
    for (const [id, rec] of this.teams) if (rec.store.rt.activeRuns.some((r) => r.id === runId)) return id
    return null
  }

  private activeRun(teamId: string, runId: string): Run | undefined {
    return this.teams.get(teamId)?.store.rt.activeRuns.find((r) => r.id === runId)
  }

  /** sha256 of the role's system text from the trusted snapshot (decision 33: a different one starts a fresh session). */
  private sysHashOf(teamId: string, roleId: string): string | undefined {
    const def = this.trust.trusted(teamId)?.def
    const role = def?.roles.find((r) => r.id === roleId)
    if (!def || !role) return undefined
    const text = systemText({ team: { name: def.name, goal: def.goal, rules: def.rules }, role: { id: role.id, name: role.name, kind: role.kind, instructions: role.instructions } })
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }

  /**
   * The `prepare` effect: the async prep, CAS on `queued` after every await (RunStarter). A prep failure with a card
   * backs that agent and key off; one without a card gives back the wake mark the admission consumed, as it was.
   */
  private prepare(teamId: string, runId: string): void {
    const rec = this.teams.get(teamId)
    const consumed = this.consumedMark.get(runId)
    this.consumedMark.delete(runId)
    if (!rec) return
    const detail = this.runDetail.get(runId)
    const current = (): TeamRecord | undefined => (this.teams.get(teamId) === rec ? rec : undefined)
    this.starter
      .prepare(teamId, runId, {
        rt: () => rec.store.rt,
        check: (id) => this.live() && !this.installing && !!current() && rec.store.rt.activeRuns.some((r) => r.id === id && r.state === 'queued'),
        commit: (res, scopes, hint) => (current() ? this.commit(teamId, res, scopes, hint) : res),
        ctx: () => (current() ? this.flowCtx(teamId) : null),
        recent: () => rec.store.recentRuns(),
        detail,
        removed: () => this.removedRecs.has(rec),
        failed: (_code, card) => {
          if (!current()) return
          const run = rec.store.recentRuns().find((r) => r.id === runId)
          if (!run) return
          if (card !== null) {
            this.prepBackoff.set(`${teamId}|${run.agentId}|${run.sessionKey}`, this.clock() + RETRY_DELAY_MS)
            return
          }
          if (!consumed) return
          const res = restoreWake(rec.store.rt, run.taskId, consumed, { now: this.clock() })
          if (res.ok && res.rt !== rec.store.rt) this.commit(teamId, res, changedScopes(rec.store.rt, res.rt), run.taskId ? { taskId: run.taskId } : undefined)
        },
      })
      .catch((err) => this.deps.log(`run ${runId} prep error ${(err as Error).name}`))
  }

  /** The synthetic status of a live run (design 3.5): AwakeService only, never StatusManager. */
  private syntheticOf(run: Run): PaneStatusEvt {
    const evt: PaneStatusEvt = { paneId: teamPaneId(run.id), state: 'working', precise: true, notify: false, provider: run.provider }
    const since = run.startedAt ?? run.queuedAt
    evt.updatedAt = since
    evt.stateSince = since
    const signalAt = this.supervisor.lastLineAt(run.id)
    if (signalAt !== undefined) evt.signalAt = signalAt
    return evt
  }

  private synthetic(teamId: string, runId: string, on: boolean): void {
    if (!this.deps.awake) return
    try {
      if (on) {
        const run = this.activeRun(teamId, runId)
        if (!run) return
        this.awakeAt.set(runId, this.clock())
        this.deps.awake(this.syntheticOf(run))
      } else {
        this.awakeAt.delete(runId)
        this.deps.awake({ paneId: teamPaneId(runId), state: null, precise: false, notify: false })
      }
    } catch (err) {
      this.deps.log(`awake ${runId} failed ${(err as Error).name}`)
    }
  }

  /** Live runs (starting | running | stopping) as working statuses: AccountService deps only. */
  syntheticStatuses(): PaneStatusEvt[] {
    const out: PaneStatusEvt[] = []
    for (const rec of this.teams.values()) for (const r of rec.store.rt.activeRuns) if (LIVE_RUN_STATES.includes(r.state)) out.push(this.syntheticOf(r))
    return out
  }

  /** Live runs of every team (starting | running | stopping): the close confirm counts them (3.12 step 12). */
  liveRunCount(): number {
    let n = 0
    for (const rec of this.teams.values()) n += rec.store.rt.activeRuns.filter((r) => LIVE_RUN_STATES.includes(r.state)).length
    return n
  }

  /** Integrates in flight in this app, of every team and also with Labs off (B6 integration: the close confirm counts them too). */
  integrateCount(): number {
    return this.integrating.size
  }

  /**
   * True for a session id in any AgentState.sessions or active run: TranscriptLocator never picks its transcript for a
   * console. B9: except a session a takeover holds for a console of the user (bindPending, bound, releasing), whose
   * console finds its own transcript like any other.
   */
  ownsSession(sessionId: string): boolean {
    if (!sessionId) return false
    for (const rec of this.teams.values()) {
      const rt = rec.store.rt
      if (rt.activeRuns.some((r) => r.sessionId === sessionId)) return true
      if (rt.agents.some((a) => !(a.takeover && a.takeover.phase !== 'stopping' && a.takeover.sessionId === sessionId) && Object.values(a.sessions).some((s) => s.sessionId === sessionId))) return true
    }
    return false
  }

  /**
   * statusManager listener: a console that opens a session an active run
   * holds stops that run (decision 39: two writers corrupt one transcript; the
   * human wins), `interrupted {sessionConflict}`, with a card. No-op while
   * not live.
   */
  onPaneStatus(evt: PaneStatusEvt): void {
    if (!this.live() || !evt || isTeamPaneId(evt.paneId)) return
    // A console that stopped working may free a session or a tree a deferred run waits on (G5, G6): one pass.
    if (this.waitsOnConsoles.size > 0 && evt.state !== 'working' && evt.state !== 'action') this.poke()
    if (evt.state === null || !evt.sessionId) return
    // B9 (K4, lazy): a console's status names the session a waiting takeover hands over.
    this.onConsoleSession(evt.sessionId)
    for (const [teamId, rec] of this.teams) {
      for (const run of rec.store.rt.activeRuns) {
        if (run.sessionId !== evt.sessionId || (run.state !== 'starting' && run.state !== 'running')) continue
        if ((evt.provider ?? 'claude') !== run.provider) continue
        this.deps.log(`run ${run.id} session conflict with a console`)
        const stopped = this.commit(teamId, requestStop(rec.store.rt, run.id, 'sessionConflict', { now: this.clock() }, this.runPolicy), ['agents', 'run'], { runId: run.id })
        // One card per session (decision 39, extra requirement 2): a second conflict on the same run or session,
        // while its card is open, opens none (openSystemCard dedups by reason, task and `what`, the session).
        if (stopped.ok && !stopped.result.already) {
          this.commit(teamId, openSystemCard(rec.store.rt, { why: 'sessionConflict', actions: ['dismiss'], taskId: run.taskId, runId: run.id, vars: sessionCardVars(run) }, { now: this.clock() }), ['needs'])
        }
      }
    }
  }

  /** AccountService emit hook: the account state moved (a switch, decision 40, is read from `lastSwitch` at close); pokes. */
  onAccounts(): void {
    if (!this.live()) return
    this.poke()
  }

  /** CliService.onState listener (decision 71): running -> poke; stopped -> every live run stops with `cliOff` (interrupted, not counted). */
  onCliState(): void {
    if (!this.live()) return
    if (this.deps.cli?.ready()) {
      this.poke()
      return
    }
    for (const [teamId, rec] of this.teams) {
      for (const run of [...rec.store.rt.activeRuns]) {
        if (run.state === 'stopping') continue
        this.commit(teamId, requestStop(rec.store.rt, run.id, 'cliOff', { now: this.clock() }, this.runPolicy), ['agents', 'run'], { runId: run.id })
      }
    }
  }

  /** The B3 CLI counts the team writes of a run (classifyOutcome reads them at close). */
  noteTeamWrite(runId: string): void {
    this.runWrites.set(runId, (this.runWrites.get(runId) ?? 0) + 1)
  }

  // ---- takeover (B9, design 4.4; the ops are ops/takeover.ts) ------------------------------------

  paneHolder(provider: AgentProvider, sessionId: string): string | null {
    try {
      return this.deps.sessionHolder?.(provider, sessionId) ?? null
    } catch {
      return null
    }
  }

  paneState(paneId: string): PaneStatusEvt | null {
    try {
      return this.deps.status?.stateOf(paneId) ?? null
    } catch {
      return null
    }
  }

  paneSpawnCwd(paneId: string): string | undefined {
    return this.deps.pty?.spawnCwd(paneId)
  }

  panePty(paneId: string): string | null {
    return this.deps.pty?.ptyIdForPane(paneId) ?? null
  }

  async killPane(paneId: string): Promise<void> {
    await this.deps.pty?.killPaneAndWait(paneId)
  }

  orphanSession(teamId: string, sessionId: string): boolean {
    return this.lingeringOf(teamId).sessions.has(sessionId)
  }

  runEndPolicy(f: RunEndFacts): PolicyDecision {
    return this.runPolicy(f)
  }

  takeoverGranted(teamId: string, agentId: string, at: number, mark = false): boolean {
    const key = `${teamId}|${agentId}`
    if (mark) this.grantedAt.set(key, at)
    return this.grantedAt.get(key) === at
  }

  consoleLeft(sessionId: string, paneId: string, mark = false): boolean {
    const key = `${sessionId}|${paneId}`
    if (mark) {
      this.leftConsoles.delete(key)
      this.leftConsoles.add(key)
      for (const old of this.leftConsoles) {
        if (this.leftConsoles.size <= LEFT_CONSOLES_MAX) break
        this.leftConsoles.delete(old)
      }
    }
    return this.leftConsoles.has(key)
  }

  /** K2: resolves once the agent's takeover leaves `stopping` (takeoversMoved, after the commit that ended its run), or at the stop wait. Never polls. */
  takeoverSettled(teamId: string, agentId: string): Promise<void> {
    const stopping = (): boolean => this.teams.get(teamId)?.store.rt.agents.find((a) => a.id === agentId)?.takeover?.phase === 'stopping'
    if (!stopping()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const w: { teamId: string; agentId: string; done: () => void } = {
        teamId,
        agentId,
        done: () => {
          if (timer !== undefined) clearTimeout(timer)
          this.takeoverWaits.delete(w)
          resolve()
        },
      }
      this.takeoverWaits.add(w)
      timer = setTimeout(w.done, this.deps.takeoverWait?.stopMs ?? TAKEOVER_STOP_WAIT_MS)
      timer.unref?.()
    })
  }

  /** K4: `check` again at every config save, console status and spawn (wakePaneWaits) until it holds; false at the confirm wait. Never polls. */
  awaitPane(check: () => boolean): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const w = (final: boolean): void => {
        let ok = false
        try {
          ok = check()
        } catch {
          ok = false
        }
        if (!ok && !final) return
        if (timer !== undefined) clearTimeout(timer)
        this.paneWaits.delete(w)
        resolve(ok)
      }
      this.paneWaits.add(w)
      timer = setTimeout(() => w(true), this.deps.takeoverWait?.paneMs ?? TAKEOVER_CONFIRM_MS)
      timer.unref?.()
    })
  }

  /** Every takeoverBound waiting for its console looks again (`final`: it answers now, a teardown). */
  private wakePaneWaits(final = false): void {
    for (const w of [...this.paneWaits]) w(final)
  }

  /**
   * After a commit that moved the agents: the takeover ops whose run ended go on, the `bind:` deadlines follow, and a
   * console bound again (its live status named the session) is no longer one a notHeld release left in place.
   */
  private takeoversMoved(teamId: string): void {
    const rec = this.teams.get(teamId)
    if (!rec) return
    for (const w of [...this.takeoverWaits]) {
      if (w.teamId === teamId && rec.store.rt.agents.find((a) => a.id === w.agentId)?.takeover?.phase !== 'stopping') w.done()
    }
    this.syncBindKeys(teamId)
    if (this.leftConsoles.size === 0) return
    for (const a of rec.store.rt.agents) {
      const tk = a.takeover
      if (tk?.phase === 'bound') this.leftConsoles.delete(`${tk.sessionId}|${tk.paneId}`)
    }
  }

  /** `bind:<teamId>:<agentId>` armed at `at + TAKEOVER_BIND_MS` for every waiting takeover while live, cleared for the rest (design 3.10). */
  private syncBindKeys(teamId: string): void {
    const rec = this.teams.get(teamId)
    if (!rec) return
    for (const a of rec.store.rt.agents) {
      const key = takeoverBindKey(teamId, a.id)
      const tk = a.takeover
      if (tk?.phase === 'bindPending' && this.live()) {
        const at = takeoverBindAt(tk)
        if (this.timer.at(key) !== at) this.timer.set(key, at)
      } else if (this.timer.has(key)) this.timer.clear(key)
    }
  }

  /** K5: a waiting takeover's `bind:` deadline. A console that holds its session after all binds it; else the agent goes back (G5 still protects a console that shows up later). */
  private onBindDue(rest: string): void {
    const i = rest.indexOf(':')
    const teamId = i < 0 ? rest : rest.slice(0, i)
    const agentId = i < 0 ? '' : rest.slice(i + 1)
    const rec = this.teams.get(teamId)
    if (!rec || !this.live()) return
    const waiting = (): boolean => rec.store.rt.agents.find((a) => a.id === agentId)?.takeover?.phase === 'bindPending'
    if (!waiting()) return
    this.reconcileTakeoverPanes(teamId, this.deps.config())
    if (!waiting() || this.teams.get(teamId) !== rec) return
    const rt = rec.store.rt
    const res = dropTakeover(rt, agentId, { now: this.clock() })
    if (!res.ok || res.rt === rt) return
    this.commit(teamId, res, [...new Set<TeamScope>(['agents', 'list', ...changedScopes(rt, res.rt)])])
    this.deps.log(`takeover ${teamId} ${agentId} bind timed out: back to the team`)
  }

  /** True when some team has a takeover in this phase. */
  private anyTakeover(phase: 'bindPending' | 'bound'): boolean {
    for (const rec of this.teams.values()) if (rec.store.rt.agents.some((a) => a.takeover?.phase === phase)) return true
    return false
  }

  /**
   * K4 by reconcile and K7, one team against the saved consoles: a waiting takeover binds to the console that fits
   * its session best (takeoverPaneRank: its live status names it, else `sessionHolder` names it, else its lastSession
   * is it; never one whose live status names another session or that a notHeld release left in place), a bound one
   * whose console left the config goes back and one whose console sits under another workspace now records it.
   * Commits only what moved.
   */
  private reconcileTakeoverPanes(teamId: string, cfg: ConfigFile | null): void {
    const rec = this.teams.get(teamId)
    if (!rec) return
    const rt = rec.store.rt
    if (!rt.agents.some((a) => a.takeover?.phase === 'bindPending' || a.takeover?.phase === 'bound')) return
    const res = reconcileTakeovers(rt, this.consolePanes(cfg, rt), { now: this.clock() })
    if (!res.ok || res.rt === rt) return
    this.commit(teamId, res, [...new Set<TeamScope>(['agents', 'list', ...changedScopes(rt, res.rt)])])
    if (res.result.bound.length) this.deps.log(`takeover ${teamId} bound by the saved consoles: ${res.result.bound.join(',')}`)
    if (res.result.released.length) this.deps.log(`takeover ${teamId} console gone from the config: ${res.result.released.join(',')} back to the team`)
    if (res.result.moved.length) this.deps.log(`takeover ${teamId} console under another workspace: ${res.result.moved.join(',')} follow it`)
  }

  /**
   * The consoles of a saved config by pane id: their workspace, lastSession and the session their own live status
   * names; for each waiting takeover, the console `sessionHolder` names (`holds`) and those a notHeld release left in
   * place for its session (`left`).
   */
  private consolePanes(cfg: ConfigFile | null, rt: Readonly<TeamRuntime>): Map<string, TakeoverPane> {
    const out = new Map<string, TakeoverPane>()
    for (const ws of cfg?.workspaces ?? []) {
      for (const p of ws?.panes ?? []) {
        if (!p || typeof p.id !== 'string' || isTeamPaneId(p.id) || out.has(p.id)) continue
        const pane: TakeoverPane = { workspaceId: ws.id }
        if (p.lastSession?.sessionId) {
          pane.sessionId = p.lastSession.sessionId
          pane.provider = p.lastSession.provider
        }
        const live = this.paneState(p.id)?.sessionId
        if (live) pane.live = live
        out.set(p.id, pane)
      }
    }
    for (const a of rt.agents) {
      const tk = a.takeover
      if (tk?.phase !== 'bindPending') continue
      const holder = this.paneHolder(tk.provider, tk.sessionId)
      const pane = holder ? out.get(holder) : undefined
      if (holder && pane) out.set(holder, { ...pane, holds: tk.sessionId })
      if (this.leftConsoles.size === 0) continue
      for (const [paneId, p] of out) {
        if (this.consoleLeft(tk.sessionId, paneId)) out.set(paneId, { ...p, left: [...(p.left ?? []), tk.sessionId] })
      }
    }
    return out
  }

  /** The sink's spawn: the console of a waiting takeover may be listed by now (K4, lazy); every takeoverBound looks again. */
  private onConsoleSpawn(paneId: string): void {
    try {
      if (!this.live() || isTeamPaneId(paneId)) return
      if (this.anyTakeover('bindPending')) for (const id of [...this.teams.keys()]) this.reconcileTakeoverPanes(id, this.deps.config())
      this.wakePaneWaits()
    } catch (err) {
      this.deps.log(`takeover spawn check failed ${(err as Error).name}`)
    }
  }

  /**
   * The sink's exit (K7): the live pty of a bound console ended and the console left the saved config (closed by
   * hand): its takeover ends, nothing to kill. One still in the config stays bound (it can be restarted); the config
   * save that drops it later reconciles it (setConfig). A release's own kill finds its takeover `releasing`: untouched.
   */
  private onConsoleExit(paneId: string, current: boolean): void {
    try {
      if (!this.live() || !current || isTeamPaneId(paneId) || !this.anyTakeover('bound')) return
      const cfg = this.deps.config()
      if ((cfg?.workspaces ?? []).some((w) => (w?.panes ?? []).some((p) => p?.id === paneId))) return
      for (const [teamId, rec] of this.teams) {
        for (const a of rec.store.rt.agents) {
          const tk = a.takeover
          if (tk?.phase !== 'bound' || tk.paneId !== paneId) continue
          const rt = rec.store.rt
          const res = dropTakeover(rt, a.id, { now: this.clock() })
          if (!res.ok || res.rt === rt) continue
          this.commit(teamId, res, [...new Set<TeamScope>(['agents', 'list', ...changedScopes(rt, res.rt)])])
          this.deps.log(`takeover ${teamId} ${a.id} console closed: back to the team`)
        }
      }
    } catch (err) {
      this.deps.log(`takeover exit check failed ${(err as Error).name}`)
    }
  }

  /** A console's status names a session: a waiting takeover of it may bind (K4, lazy), and every takeoverBound looks again. */
  private onConsoleSession(sessionId: string): void {
    let waiting = false
    for (const rec of this.teams.values()) if (rec.store.rt.agents.some((a) => a.takeover?.phase === 'bindPending' && a.takeover.sessionId === sessionId)) waiting = true
    if (waiting) for (const id of [...this.teams.keys()]) this.reconcileTakeoverPanes(id, this.deps.config())
    if (waiting || this.paneWaits.size > 0) this.wakePaneWaits()
  }

  // ---- the `snaos team` port (B3, design 3.9) ---------------------------------------------------

  /** Comments of a target already archived (lines of archive/<target>.jsonl), read once per target. */
  archivedCount(teamId: string, target: string): number {
    if (!ARCHIVE_TARGET_RE.test(target) || !this.teams.has(teamId)) return 0
    const key = `${teamId}|${target}`
    const hit = this.archivedCounts.get(key)
    if (hit !== undefined) return hit
    let n = 0
    try {
      const text = readFileSync(join(this.teamDir(teamId), 'archive', `${target}.jsonl`), 'utf8')
      n = text.split('\n').length - 1
    } catch {
      n = 0
    }
    this.archivedCounts.set(key, n)
    return n
  }

  private taskViewCtx(teamId: string, rec: TeamRecord): TaskViewCtx {
    return { def: this.shownDef(rec), needs: needsRowsOf(rec, this.trust.trusted(teamId)), archived: (target) => this.archivedCount(teamId, target), silence: (runId) => this.runSilence.get(runId) }
  }

  /** The live run behind a team token: its active run (stopping included: a concluded run keeps reading until revoke). */
  private ctlLive(who: CtlTeamCaller): TeamLiveRun | null {
    if (!this.live()) return null
    const rec = this.teams.get(who.teamId)
    const def = this.trust.trusted(who.teamId)
    const run = rec?.store.rt.activeRuns.find((r) => r.id === who.runId)
    if (!rec || !def || !run || run.agentId !== who.agentId) return null
    const agent = rec.store.rt.agents.find((a) => a.id === run.agentId)
    if (!agent) return null
    const task = run.taskId ? rec.store.rt.tasks.find((t) => t.id === run.taskId) : undefined
    return task ? { teamId: who.teamId, run, agent, task, def } : { teamId: who.teamId, run, agent, def }
  }

  /**
   * `team show`, `team tasks` and `team task get` (design 5.3). A task get
   * delivers to the calling run the queued comments of its agent that the
   * reply carries, only while the run is neither concluded nor stopping
   * (4.5: a run in its grace window reads without taking them).
   */
  private ctlRead(teamId: string, method: 'team.show' | 'team.tasks' | 'team.task.get', params: Record<string, unknown>, who: CtlTeamCaller): CtlResponse {
    const l = this.ctlLive(who)
    const rec = this.teams.get(teamId)
    if (!l || l.teamId !== teamId || !rec) return ctlErr('forbidden', 'this team run is over')
    const rt = rec.store.rt
    const v = this.taskViewCtx(teamId, rec)
    switch (method) {
      case 'team.show': {
        const run: { id: string; mode: RunMode; taskId?: string } = { id: l.run.id, mode: l.run.mode }
        if (l.run.taskId) run.taskId = l.run.taskId
        const data: { team: { id: string; name: string; goal: string }; you: { agentId: string; roleId: string; kind: RoleKind }; run: typeof run; task?: TaskSummary } = {
          team: { id: teamId, name: l.def.def.name, goal: l.def.def.goal },
          you: { agentId: l.agent.id, roleId: l.agent.roleId, kind: l.agent.roleKind },
          run,
        }
        if (l.task) data.task = taskSummary(rt, l.task, v)
        return { ok: true, data }
      }
      case 'team.tasks': {
        const state = params.state
        if (state !== undefined && (typeof state !== 'string' || !CTL_TASK_STATES.includes(state))) return ctlErr('bad_request', 'state: todo, doing, review, done, blocked, cancelled or open')
        if (params.mine !== undefined && typeof params.mine !== 'boolean') return ctlErr('bad_request', 'mine: a boolean')
        const keep = (t: TeamTask): boolean => {
          if (state === 'open' ? t.state === 'done' || t.state === 'cancelled' : state !== undefined && t.state !== (state as TaskState)) return false
          return !params.mine || t.assignee === who.agentId || (t.phase === 'qa' && t.review.qaAgentId === who.agentId)
        }
        const rank = (t: TeamTask): number => {
          const c = columnOf(t)
          return c ? BOARD_COLUMNS.indexOf(c) : BOARD_COLUMNS.length
        }
        const tasks = rt.tasks.filter(keep).sort((a, b) => rank(a) - rank(b) || compareTaskOrder(a, b)).slice(0, CTL_TASKS_MAX)
        return { ok: true, data: { tasks: tasks.map((t) => taskSummary(rt, t, v)) } }
      }
      case 'team.task.get': {
        const id = params.task
        if (typeof id !== 'string' || !TASK_ID_RE.test(id)) return ctlErr('bad_request', 'task: a task id like t-12')
        let t = rt.tasks.find((x) => x.id === id)
        if (!t) return ctlErr('not_found', rt.archivedTasks[id] ? `${id} is archived` : `no task ${id}`)
        const view = (): ReturnType<typeof taskDetail> =>
          taskDetail(rec.store.rt, t as TeamTask, { ...v, trusted: l.def, recent: rec.store.recentRuns(), lastLineAt: (rid) => this.supervisor.lastLineAt(rid), commentsLimit: CTL_TASK_COMMENTS })
        const first = view()
        if (!l.run.concludedBy && l.run.state !== 'stopping') {
          const ids = first.comments.filter((c) => c.queued).map((c) => c.id)
          const queuedForMe = (rt.comments[id] ?? []).filter((c) => ids.includes(c.id) && c.forAgent === who.agentId).map((c) => c.id)
          if (queuedForMe.length > 0) {
            const res = deliverComments(rec.store.rt, l.run.id, who.agentId, queuedForMe)
            if (res.ok && res.rt !== rec.store.rt) this.commit(teamId, res, changedScopes(rec.store.rt, res.rt), { taskId: id })
            t = rec.store.rt.tasks.find((x) => x.id === id) ?? t
            return { ok: true, data: { task: view() } }
          }
        }
        return { ok: true, data: { task: first } }
      }
    }
  }

  /**
   * Where `team diff` and `team log` read (B5 integration, fourth round): a task with its worktree -> that tree
   * against the current tip of its base branch (fifth round: the merge base, like TaskWorktrees.qaStat); any other
   * task -> the root of its repo against HEAD (an extra repo that does not resolve: null); no task -> the main repo
   * root. Like runCwdOf, from the team's own state only.
   */
  private gitTargetOf(teamId: string, task: TeamTask | undefined): TeamGitTarget | null {
    const main = this.repoOf(teamId, REPO_MAIN)
    if (!('repoRoot' in main)) return null
    if (!task) return { cwd: main.repoRoot, where: 'root' }
    const wt = task.worktree
    if (wt) return { cwd: wt.path, where: 'worktree', base: wt.base, baseBranch: wt.baseBranch, branch: wt.branch, task: task.id }
    const repo = this.repoOf(teamId, task.repoId)
    return 'repoRoot' in repo ? { cwd: repo.repoRoot, where: 'root', task: task.id } : null
  }

  /**
   * `team diff` and `team log` (B5 integration, fourth round, security): the params teamCtl checked, the task of the
   * caller's own team (`task`, else the run's own; any role reads any task of its team, never another team's: the
   * token names the team), then ops/gitReads (the paths again, realpath, git with fixed options, the cap). Fifth
   * round: one read of a run in flight at a time; a second one meanwhile answers busy, so a run never queues reads
   * ahead of the phone and the other runs in the one git slot a remote caller may hold.
   */
  private async ctlGit(teamId: string, method: 'team.diff' | 'team.log', params: Record<string, unknown>, who: CtlTeamCaller): Promise<TeamReadReply> {
    const l = this.ctlLive(who)
    const rec = this.teams.get(teamId)
    if (!l || l.teamId !== teamId || !rec) return ctlErr('forbidden', 'this team run is over')
    if (this.gitReading.has(who.runId)) return { ok: false, error: 'busy', detail: `another snaos team diff or log of this run is still reading: wait for its answer, then run snaos ${method.replace('.', ' ')} again` }
    this.gitReading.add(who.runId)
    try {
      return await this.ctlGitRead(rec, l, method, params)
    } finally {
      this.gitReading.delete(who.runId)
    }
  }

  /** ctlGit's read, one per run at a time: the task, the target, the request. */
  private async ctlGitRead(rec: TeamRecord, l: TeamLiveRun, method: 'team.diff' | 'team.log', params: Record<string, unknown>): Promise<TeamReadReply> {
    const teamId = l.teamId
    const rt = rec.store.rt
    const taskId = typeof params.task === 'string' ? params.task : l.run.taskId
    let task: TeamTask | undefined
    if (taskId !== undefined) {
      if (!TASK_ID_RE.test(taskId)) return ctlErr('bad_request', 'task: a task id like t-12')
      task = rt.tasks.find((t) => t.id === taskId)
      if (!task) return ctlErr('not_found', rt.archivedTasks[taskId] ? `${taskId} is archived` : `no task ${taskId}`)
    }
    const target = this.gitTargetOf(teamId, task)
    if (!target) return { ok: false, error: 'io', detail: `the repo of ${task?.id ?? 'the team'} is not available` }
    const paths = Array.isArray(params.paths) ? (params.paths as string[]) : []
    const req: TeamGitRequest = method === 'team.diff' ? { method, stat: params.stat === true, paths } : { method, n: typeof params.n === 'number' ? params.n : CTL_TEAM_LOG_DEFAULT, paths }
    return teamGitRead({ git: this.git, realpath: (p) => this.repoFs.realpath(p) }, target, req)
  }

  /**
   * One write of a run (commit inside): the growth cap of the store rules (an
   * agent's write is refused past TEAM_STATE_MAX_BYTES with `cap` and `full:
   * 'state'`, its own hint; the user's still pass), applyTool, the commit with
   * the scopes it moved, and every accepted write counted for the run
   * (classifyOutcome, decision 68).
   */
  private ctlApply(teamId: string, call: TeamToolCall, who: CtlTeamCaller): ReturnType<TeamCtlPort['apply']> {
    const l = this.ctlLive(who)
    const rec = this.teams.get(teamId)
    const ctx = this.flowCtx(teamId)
    if (!l || l.teamId !== teamId || !rec) return { ok: false, error: 'forbidden' }
    if (!ctx) return { ok: false, error: 'untrusted' }
    let incoming = 0
    try {
      incoming = Buffer.byteLength(JSON.stringify(call.params ?? {}), 'utf8')
    } catch {
      return { ok: false, error: 'bad_request' }
    }
    if (rec.store.lastBytes + incoming > TEAM_STATE_MAX_BYTES) return { ok: false, error: 'cap', full: 'state' }
    const actor: Actor & { kind: 'agent' } = { kind: 'agent', agentId: l.agent.id, runId: l.run.id, roleKind: l.agent.roleKind }
    const res = applyTool(rec.store.rt, actor, call, ctx)
    if (!res.ok) return res
    const p = call.params ?? {}
    const created = (res.result as { id?: unknown } | undefined)?.id
    const taskId = [p.task, p.target, created].find((x): x is string => typeof x === 'string' && TASK_ID_RE.test(x))
    const out = this.commit(teamId, res, changedScopes(rec.store.rt, res.rt), taskId ? { taskId } : undefined)
    if (out.ok) {
      this.noteTeamWrite(l.run.id)
      this.deps.log(`run ${l.run.id} ${call.method}${call.viaBlock ? ' (block)' : ''}`)
    }
    return out
  }

  /**
   * `team note` (B7, design 3.8 and 5.3): teamCtl checked the role (the Lead, in lead and free runs), the run (live,
   * not concluded, not stopping), redacted the texts and refused a live token; noteOf checks them once more, then the
   * note is written as a team note (dataDir()/teams/<teamId>/<noteId>.md, tmp + rename, UTF-8 without BOM), never a
   * workspace note. A write the run made (classifyOutcome); `{id}` is the note's id.
   */
  private async ctlNote(teamId: string, text: string, title: string | undefined, who: CtlTeamCaller): Promise<CtlResponse> {
    const l = this.ctlLive(who)
    if (!l || l.teamId !== teamId || !this.teams.has(teamId)) return ctlErr('forbidden', 'this team run is over')
    const n = noteOf(title === undefined ? { text } : { text, title })
    if (!n) return ctlErr('bad_request', `team note: the text is required (${COMMENT_TEXT_MAX} characters at most) and the title is one line`)
    const r = await this.writeTeamNote(teamId, n)
    if (!('id' in r)) {
      this.deps.log(`run ${l.run.id} team.note failed ${r.error}`)
      return r.error === 'busy'
        ? ctlErr('busy', `the team keeps ${TEAM_NOTES_MAX} notes at most: no more fit`)
        : r.error === 'too_big'
          ? ctlErr('bad_request', 'team note: the note is too large')
          : ctlErr('internal', 'the team note could not be saved')
    }
    this.noteTeamWrite(l.run.id)
    this.deps.log(`run ${l.run.id} team.note ${r.id}`)
    return { ok: true, data: { id: r.id } }
  }

  /**
   * A team note written (the CLI path and a Codex block's effect): the team's cap, then WsNoteStore.create. A team
   * that is gone or being removed gets none (the write would make its folder again next to the trashed one).
   */
  private async writeTeamNote(teamId: string, n: { text: string; title?: string }): Promise<{ id: string } | { error: 'busy' | 'too_big' | 'io' }> {
    let count = 0
    try {
      count = (await fsp.readdir(this.teamDir(teamId))).filter((f) => f.endsWith('.md')).length
    } catch {
      count = 0
    }
    if (count >= TEAM_NOTES_MAX) return { error: 'busy' }
    if (!this.teams.has(teamId) || this.removing.has(teamId)) return { error: 'io' }
    const res = await this.notes.create({ workspaceId: teamId, text: teamNoteText(n) })
    if (!res.ok) return { error: res.error === 'too_large' ? 'too_big' : 'io' }
    return { id: res.note.id }
  }

  /** The team notes store wrote one: the `notes` scope of that team only (design 3.8: never the workspace notes' events). */
  private onNoteWritten(teamId: string): void {
    if (this.teams.has(teamId)) this.emit(teamId, ['notes'])
  }

  teamNotes(teamId: string): Promise<{ notes: WsNoteMeta[] } | TeamFail> {
    return this.notes.list(teamId).then((r) => (r.ok ? { notes: r.notes } : fail('io')))
  }

  async teamNote(teamId: string, noteId: string): Promise<{ title: string; text: string; updatedAt: number } | TeamFail> {
    const r = await this.notes.read({ workspaceId: teamId, noteId })
    if (r.ok) return { title: r.note.title, text: r.note.text, updatedAt: r.note.updatedAt }
    return fail(r.error === 'not_found' ? 'not_found' : r.error === 'invalid' ? 'bad_request' : r.error === 'too_large' ? 'too_big' : 'io')
  }

  private sendRun(evt: TeamRunAppendEvt): void {
    try {
      this.deps.sendRun?.(evt)
    } catch (err) {
      this.deps.log(`runAppend failed ${(err as Error).name}`)
    }
  }

  private onFirstLine(runId: string, at: number, sessionId?: string): void {
    const teamId = this.teamOfRun(runId)
    const rec = teamId ? this.teams.get(teamId) : undefined
    const ctx = teamId ? this.flowCtx(teamId) : null
    const run = rec?.store.rt.activeRuns.find((r) => r.id === runId)
    if (!teamId || !rec || !ctx || !run) return
    const f: { at: number; sessionId?: string; sysHash?: string } = { at }
    if (sessionId) f.sessionId = sessionId
    const sysHash = this.sysHashOf(teamId, run.roleId)
    if (sysHash) f.sysHash = sysHash
    const res = this.commit(teamId, markRunning(rec.store.rt, runId, f, ctx), ['agents', 'run'], { runId })
    // B7 (design 3.8): the silence watch follows the run from `running`, counting from this line.
    if (res.ok && rec.store.rt.activeRuns.find((r) => r.id === runId)?.state === 'running') this.watchSilence(runId)
  }

  /** Line events never emit teamChanged (design 3.1); only the watched run gets its items, masked (maskRun). */
  private onAppend(runId: string, items: ChatMessage[], at: number): void {
    const w = this.watched
    if (!w || w.runId !== runId || !this.deps.sendRun) return
    const run = this.activeRun(w.teamId, runId)
    for (const chunk of splitAppend(teamPaneId(runId), this.maskRun(items))) this.sendRun({ teamId: w.teamId, runId, agentId: run?.agentId ?? '', items: chunk, lastLineAt: at })
  }

  /**
   * Every line with content (RunSupervisor never signals a beat: a Claude tool_progress heartbeat or a keepalive is no
   * sign of life, so a run stuck inside a long command still goes quiet and stalled): a silence on show ends (B7,
   * design 3.8: once per recovery), and the synthetic status is refreshed at most every SYNTHETIC_REFRESH_MS (decision
   * 58, never a timer; AWAKE_STALE_MS, 2 h, is not under the longest maxRunMinutes, so the beats need not refresh it).
   */
  private onSignal(runId: string, at: number): void {
    if (this.runSilence.has(runId)) this.silenceRecovered(runId)
    const last = this.awakeAt.get(runId)
    if (last === undefined || at - last < SYNTHETIC_REFRESH_MS) return
    const teamId = this.teamOfRun(runId)
    if (teamId) this.synthetic(teamId, runId, true)
  }

  /**
   * Close sequence (design 3.5): parser facts, then (B4) the tree mark and
   * (B5) the Codex block, then the policy and the `finishRun` commit with a
   * CAS on the run state (a run another path already finalized is left alone).
   */
  private onClosed(runId: string, end: RunEnd & { stderrTail: string; logBytes?: number; logCut?: boolean }): void {
    const teamId = this.teamOfRun(runId)
    const rec = teamId ? this.teams.get(teamId) : undefined
    const run = rec?.store.rt.activeRuns.find((r) => r.id === runId)
    if (!teamId || !rec || !run || run.state === 'queued') {
      this.deps.log(`run ${runId} closed after its end`)
      return
    }
    // A writer run's tree is marked again (5 s budget): a moved HEAD or status is progress (decision 68). The
    // finalize after it is a CAS: a run another path ended meanwhile (Labs off, a quit) is left alone.
    const before = run.treeBefore
    if (before && this.taskWorktrees) {
      void this.taskWorktrees
        .mark(run.cwd, CLOSE_MARK_MS)
        .catch(() => null)
        .then((m) => this.finalizeClosed(runId, end, m ? m.head !== before.head || m.status !== before.status : undefined))
        .catch((err) => this.deps.log(`run ${runId} finalize failed ${(err as Error).name}`))
      return
    }
    this.finalizeClosed(runId, end, end.treeMoved)
  }

  /**
   * The `finishRun` commit of a closed run (its policy from the terminal copy), with the tree mark's verdict. B5: a
   * Codex run that reports by block applies its block first (R11), so the policy and the outcome see what it did;
   * finishRun gets the trusted definition for the permission approvals of its denials.
   */
  private finalizeClosed(runId: string, end: RunEnd & { stderrTail: string; logBytes?: number; logCut?: boolean }, treeMoved: boolean | undefined): void {
    const teamId = this.teamOfRun(runId)
    const rec = teamId ? this.teams.get(teamId) : undefined
    const run0 = rec?.store.rt.activeRuns.find((r) => r.id === runId)
    if (!teamId || !rec || !run0 || run0.state === 'queued') {
      this.deps.log(`run ${runId} closed after its end`)
      return
    }
    const full: RunEnd = { at: end.at, exit: end.exit, facts: end.facts, teamWrites: 0 }
    if (end.lastLineAt !== undefined) full.lastLineAt = end.lastLineAt
    if (treeMoved !== undefined) full.treeMoved = treeMoved
    // R11: only a run that would end succeeded or failed (never one the user, a takeover or a quit stopped).
    if (reportsByBlock(run0)) {
      const would = terminalOf(run0, full).state
      if (would === 'succeeded' || would === 'failed') this.applyRunBlock(teamId, run0, end)
    }
    const run = rec.store.rt.activeRuns.find((r) => r.id === runId) ?? run0
    full.teamWrites = this.runWrites.get(runId) ?? 0
    const now = this.clock()
    const terminal = terminalOf(run, full)
    const acc = this.deps.accounts?.() ?? null
    const switchedAt = acc?.lastSwitch?.at
    const ctx = this.flowCtx(teamId)
    const endCtx = { now, mask: this.maskTokens }
    const ask = ctx ? { ctx, protect: this.protectPaths() } : undefined
    // 2.7.0 runtime fixes: a run whose denials leave its permission approval pending waits on the user's decision.
    const permissionWait = permissionWaitOf(rec.store.rt, terminal, end.facts, endCtx, ask)
    const policy = this.runPolicy(runEndFactsOf(rec.store.rt, terminal, now, { claudeCanSwitch: this.claudeCanSwitch(acc), claudeSwitchedAt: switchedAt, unknownSession: end.facts.unknownSession, permissionWait }))
    const fin = finishRun(rec.store.rt, runId, full, policy, endCtx, ask)
    // The Lead's reply and a lead escalation write the Lead thread (`lead`), a permission approval the needs.
    const scopes = [...new Set<TeamScope>(['agents', 'run', 'needs', ...(fin.ok ? changedScopes(rec.store.rt, fin.rt) : [])])]
    const before = rec.store.rt
    const res = this.commit(teamId, fin, scopes, { runId })
    if (res.ok) {
      for (const a of rec.store.rt.approvals) {
        if (a.kind === 'permission' && a.state === 'cancelled' && a.error === PERMISSION_NOT_NEEDED && before.approvals.some((b) => b.id === a.id && b.state === 'pending')) this.deps.log(`permission ${teamId} ${a.id} cancelled notNeeded`)
      }
    }
    if (res.ok && permissionWait) this.deps.log(`run ${runId} waits on a permission`)
    if (res.ok && end.logBytes !== undefined) {
      // Log size of the ended run (Run.logBytes, logTruncated) patched into its ring copy.
      const ended: Run = { ...res.result.run, logBytes: end.logBytes }
      if (end.logCut) ended.logTruncated = true
      rec.store.recordRun(ended)
    }
  }

  /**
   * R11 (design 3.5 close sequence, 5.6): the LAST complete `snaos-team` block of a Codex run's last message,
   * applied through applyTool in order (applyBlock: `$<n>` refs, `viaBlock` admits the stopping run) in ONE commit,
   * every accepted action counted as a team write (classifyOutcome). A refused action or an unresolved ref stops the
   * list there: teams.log and a note row in the run's chat say where and why. The state cap of ctlApply holds.
   * B5 integration, sixth round (security): an action whose params hold a live token of the app (deps.cli.holdsToken,
   * the check teamCtl runs on a CLI call; a read-only sandbox reads runtime.json) is refused like a rejected action,
   * `bad_request` with detail `secret`: the list stops there and nothing of it lands.
   */
  private applyRunBlock(teamId: string, run: Run, end: { facts: StreamFacts; logCut?: boolean }): void {
    const rec = this.teams.get(teamId)
    const ctx = this.flowCtx(teamId)
    if (!rec || !ctx) return
    const block = parseTeamBlock(end.facts.finalText ?? '')
    if (!block) {
      this.deps.log(`run ${run.id} block none`)
      return
    }
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(block.actions), 'utf8')
    } catch {
      bytes = Infinity
    }
    if (rec.store.lastBytes + bytes > TEAM_STATE_MAX_BYTES) {
      this.deps.log(`run ${run.id} block refused: state full`)
      this.runNote(teamId, run.id, end, { key: 'blockStateFull', vars: { mb: Math.floor(TEAM_STATE_MAX_BYTES / (1024 * 1024)) } })
      return
    }
    const actor: Actor & { kind: 'agent' } = { kind: 'agent', agentId: run.agentId, runId: run.id, roleKind: run.roleKind }
    // The first action that carries a live token, checked on its raw params (before the redaction of blockParams), read
    // as teamCtl reads a CLI call's params (paramText).
    const cli = this.deps.cli
    const secretAt = cli ? block.actions.findIndex((a) => cli.holdsToken(paramText(a.params))) : -1
    const res = applyBlock(rec.store.rt, actor, secretAt === -1 ? block : { ...block, actions: block.actions.slice(0, secretAt) }, ctx)
    if (!res.ok) {
      this.deps.log(`run ${run.id} block failed ${res.error}`)
      return
    }
    const { applied } = res.result
    // The actions before the secret one all landed: the list stops at it.
    const secret = res.result.stoppedAt === undefined && secretAt !== -1
    const stoppedAt = secret ? secretAt : res.result.stoppedAt
    const why = secret ? 'bad_request: secret' : res.result.error ?? 'refused'
    // B7: a block of team notes only changes no runtime; its `teamNote` effects still run through the commit.
    if (res.rt !== rec.store.rt || res.effects.length > 0) this.commit(teamId, res, changedScopes(rec.store.rt, res.rt), run.taskId ? { taskId: run.taskId } : undefined)
    for (let i = 0; i < applied; i++) {
      this.noteTeamWrite(run.id)
      this.deps.log(`run ${run.id} ${block.actions[i].method} (block)`)
    }
    if (stoppedAt === undefined) {
      this.deps.log(`run ${run.id} block applied=${applied}/${block.actions.length}`)
      return
    }
    const method = block.actions[stoppedAt]?.method ?? '?'
    this.deps.log(`run ${run.id} block applied=${applied}/${block.actions.length} stopped=${stoppedAt + 1} ${method} ${why}`)
    const vars: RunNote['vars'] = { applied, total: block.actions.length, at: stoppedAt + 1, method, error: secret ? 'bad_request' : res.result.error ?? 'refused' }
    if (secret) vars.detail = 'secret'
    this.runNote(teamId, run.id, end, { key: 'blockStopped', vars })
  }

  /**
   * A main note at the end of a closed run's log (`snaos.note`, a system row of its chat): the RunLog is closed by
   * then, so the line is appended to its file; a log past its cut keeps it out (its tail lives only in the ring). The
   * record carries the note's key and vars (`{ type, at, key, vars }`, RunNote), never a sentence: the run chat words it.
   */
  private runNote(teamId: string, runId: string, end: { logCut?: boolean }, note: RunNote): void {
    if (end.logCut) return
    try {
      appendFileSync(join(this.teamDir(teamId), 'runs', `${runId}.jsonl`), JSON.stringify({ type: 'snaos.note', at: new Date(this.clock()).toISOString(), key: note.key, vars: note.vars }) + '\n', 'utf8')
    } catch (err) {
      this.deps.log(`run ${runId} note failed ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
    }
  }

  /** An `error` from the child before it ever spawned: the run fails as a spawn failure (rare: start() checks the pid). */
  private onSpawnFailed(runId: string, detail: string): void {
    const teamId = this.teamOfRun(runId)
    const rec = teamId ? this.teams.get(teamId) : undefined
    const run = rec?.store.rt.activeRuns.find((r) => r.id === runId)
    if (!teamId || !rec || !run || run.state === 'queued') return
    const now = this.clock()
    const facts = createClaudeStreamParser().facts({ code: null }, '', {}, now)
    facts.failure = { kind: 'request', code: `spawn_${detail}`.slice(0, 32) }
    const full: RunEnd = { at: now, exit: { code: null, signal: null }, facts, teamWrites: 0 }
    const terminal = terminalOf(run, full)
    const fin = finishRun(rec.store.rt, runId, full, this.runPolicy(runEndFactsOf(rec.store.rt, terminal, now)), { now, mask: this.maskTokens })
    // A lead escalation of this run's end writes the Lead thread (B5).
    this.commit(teamId, fin, [...new Set<TeamScope>(['agents', 'run', 'needs', ...(fin.ok ? changedScopes(rec.store.rt, fin.rt) : [])])], { runId })
  }

  /** autoSwitch on and another usable account (afterRunPolicy's claudeCanSwitch). */
  private claudeCanSwitch(acc: ClaudeAccountsState | null): boolean {
    if (!acc || acc.accounts.length < 2 || acc.autoPaused || acc.blocked === 'allExhausted') return false
    return acc.accounts.some((a) => a.id !== acc.activeId && (a.usage.fiveHour.percent ?? 0) < 100 && (a.usage.sevenDay.percent ?? 0) < 100)
  }

  // ---- dispatch (B4, design 3.6) ----------------------------------------------------------------

  /** Every Claude account at its limit (claudeAllLimited): its earliest reset, else the fallback; null while one is usable. */
  private claudeBlockedUntil(now: number): number | null {
    const lim = claudeAllLimited(this.deps.accounts?.() ?? null, now)
    if (!lim.limited) return null
    return lim.until !== undefined && lim.until > now ? lim.until : now + LIMIT_FALLBACK_MS
  }

  /** The assignee's role writes (total, custom): a worktree task then gets its tree (decision 24). */
  private assigneeWrites(rt: Readonly<TeamRuntime>, def: TrustedDefinition, task: TeamTask): boolean {
    const agent = task.assignee ? rt.agents.find((a) => a.id === task.assignee) : undefined
    const role = agent ? def.def.roles.find((r) => r.id === agent.roleId) : undefined
    return !!role && roleWrites(role.permission)
  }

  /**
   * Where a run would work (design 3.6): a task with its worktree -> that tree; a worktree task whose assignee
   * writes and that has none yet -> pending (the prep creates it; the repo root holds its place until then);
   * any other task -> the root of its repo (decision 62; an unresolved one fails the prep with cwdMissing);
   * lead and free -> the main repo root.
   */
  private runCwdOf(teamId: string, rt: Readonly<TeamRuntime>, def: TrustedDefinition, task: TeamTask | undefined): { cwd: string; pending: boolean } | null {
    const main = this.repoOf(teamId, REPO_MAIN)
    if (!('repoRoot' in main)) return null
    if (!task) return { cwd: main.repoRoot, pending: false }
    if (task.worktree) return { cwd: task.worktree.path, pending: false }
    const repo = this.repoOf(teamId, task.repoId)
    const root = 'repoRoot' in repo ? repo.repoRoot : main.repoRoot
    return { cwd: root, pending: task.isolation === 'worktree' && this.assigneeWrites(rt, def, task) }
  }

  /** The DispatchFacts cwd key of a run's tree: its write-lock key, or a key nobody holds for a worktree still to come. */
  private cwdKeyOf(teamId: string, taskId: string | undefined, where: { cwd: string; pending: boolean }): string {
    return where.pending ? `pending-worktree:${teamId}:${taskId ?? ''}` : this.locks.key(where.cwd)
  }

  /**
   * One team's facts for a pass, from memory only (design 3.6): the cached trust state (decision 69), the CLI,
   * the counts, the Claude accounts, the write locks, the lingering orphans of decision 64 (their sessions are
   * busy, their cwds are writers) and, for the candidates only, who holds their sessions and their trees.
   */
  private dispatchFacts(teamId: string, pass: { globalActive: number; writers: Set<string> }, manual: readonly ManualRequest[]): DispatchFacts | null {
    const rec = this.teams.get(teamId)
    if (!rec) return null
    const now = this.clock()
    // The lingering set first: dropping a dead orphan commits (its card), so `rt` is read after it.
    const lingering = this.lingeringOf(teamId)
    const rt = rec.store.rt
    const trusted = this.trust.trusted(teamId)
    let globalActive = 0
    for (const r of this.teams.values()) globalActive += r.store.rt.activeRuns.length
    const busySessions = new Set<string>(lingering.sessions)
    const writerCwds = new Set<string>([...this.locks.writerKeys(), ...lingering.cwds, ...pass.writers])
    const cwdKeys: Record<string, string> = {}
    const trees: string[] = []
    const facts: DispatchFacts = {
      now,
      enabled: this.live() && !this.installing,
      trusted: rec.trust === 'trusted' && trusted !== null,
      cliReady: this.deps.cli?.ready() ?? false,
      globalActive: Math.max(globalActive, pass.globalActive),
      claudeBlockedUntil: this.claudeBlockedUntil(now),
      busySessions,
      busyCwds: new Set(),
      writerCwds,
      integrateCwds: this.locks.integrateKeys(),
      cwdKeys,
      manual: [...manual],
    }
    if (!trusted) return facts
    let cands: RunRequest[] = []
    try {
      cands = candidatesOf(rt, trusted.def, trusted.goalHash, { now, manual: facts.manual }, { skip: this.skipOf(teamId, rt) })
    } catch (err) {
      this.deps.log(`dispatch ${teamId} candidates failed ${(err as Error).name}`)
    }
    for (const c of cands) {
      const agent = rt.agents.find((a) => a.id === c.agentId)
      const s = agent?.sessions[c.sessionKey]
      if (s && !busySessions.has(s.sessionId) && this.deps.sessionHolder?.(s.provider, s.sessionId)) busySessions.add(s.sessionId)
      if (cwdKeys[c.sessionKey] !== undefined) continue
      const task = c.taskId ? rt.tasks.find((t) => t.id === c.taskId) : undefined
      const where = this.runCwdOf(teamId, rt, trusted, task)
      if (!where) continue
      cwdKeys[c.sessionKey] = this.cwdKeyOf(teamId, task?.id, where)
      if (!where.pending) trees.push(where.cwd)
    }
    facts.busyCwds = this.locks.busyKeys(trees)
    return facts
  }

  /**
   * One team's step of a pass (design 3.11 item 2): the reconcileTasks commit, planDispatch, the "Por despachar"
   * items it asks for (a discarded level that did not change is no candidate: planOf skips it) and the admissions,
   * each its own commit (its `prepare` effect starts the async prep).
   */
  private dispatchStep(teamId: string, given: DispatchFacts): StepResult {
    const rec = this.teams.get(teamId)
    const ctx0 = this.flowCtx(teamId)
    const none: StepResult = { plan: { start: [], enqueue: [], deferred: [], nextAt: null }, started: [] }
    if (!rec || !ctx0) return none
    let facts = given
    let unblockAt: number | null = null
    if (facts.enabled && facts.trusted) {
      const r = reconcileTasks(rec.store.rt, ctx0.def.def, ctx0)
      if (r.ok) {
        unblockAt = r.result.nextAt
        if (r.rt !== rec.store.rt) {
          this.commit(teamId, r, changedScopes(rec.store.rt, r.rt))
          // A task it unblocked is a new candidate: its session and tree are looked up again (the pass's counts kept).
          facts = this.dispatchFacts(teamId, { globalActive: given.globalActive, writers: new Set(given.writerCwds) }, given.manual) ?? given
        }
      }
    }
    const rt = rec.store.rt
    const plan = this.planOf(teamId, rt, ctx0.def, facts)
    // A task an unblock window refused is unblocked by the first pass after the window: its end is a deadline too.
    if (unblockAt !== null && (plan.nextAt === null || unblockAt < plan.nextAt)) plan.nextAt = unblockAt
    if (plan.deferred.some((d) => CONSOLE_DEFERS.has(d.reason))) this.waitsOnConsoles.add(teamId)
    else this.waitsOnConsoles.delete(teamId)
    if (plan.enqueue.length > 0) {
      const e = enqueue(rec.store.rt, plan.enqueue, ctx0)
      if (e.ok && e.rt !== rec.store.rt) this.commit(teamId, e, ['needs', 'agents'])
    }
    const started: StepResult['started'] = []
    for (const req of plan.start) {
      const runId = this.admit(teamId, req)
      if (runId) started.push({ request: req, runId })
    }
    return { plan, started }
  }

  /**
   * planDispatch with the prep-failure backoff applied: a level whose prep just failed with a card waits
   * RETRY_DELAY_MS (only a manual entry of `facts.manual`, the user's "Ejecutar ahora" or the kickoff op, never does;
   * B close: a level that bypasses the cooldown, such as the user's message to the Lead, still waits it out, or a prep
   * that keeps failing would loop on every pass). Its agent sits out the plan
   * (planDispatch reads it as paused), so it never takes a cap slot the next request in line could use, and its
   * row reads `cooldown` until the backoff ends. A level the user discarded and that did not change is skipped
   * before each agent's minimum (skipOf), so the agent's next level gets its queue item.
   */
  private planOf(teamId: string, rt: Readonly<TeamRuntime>, def: TrustedDefinition, facts: DispatchFacts): DispatchPlan {
    const held = new Map<string, number>()
    const skip = this.skipOf(teamId, rt)
    // A manual candidate (manualCandidate): approved, bypassing the cooldown, with the reason of its agent's entry.
    const manual = (req: RunRequest): boolean => req.approved && req.bypassCooldown && facts.manual.some((m) => m.agentId === req.agentId && m.reason === req.reason)
    // Each round holds at least one more agent (a held one is paused, never a start again): at most one per agent.
    for (;;) {
      const view: Readonly<TeamRuntime> = held.size === 0 ? rt : { ...rt, agents: rt.agents.map((a) => (held.has(a.id) ? { ...a, paused: true } : a)) }
      const plan = planDispatch(view, def.def, def.goalHash, facts, { skip })
      let more = false
      for (const req of plan.start) {
        const until = manual(req) ? undefined : this.backoffOf(teamId, req, facts.now)
        if (until === undefined) continue
        held.set(req.agentId, until)
        more = true
      }
      if (more) continue
      if (held.size === 0) return plan
      plan.deferred = plan.deferred.map((d) => {
        const until = held.get(d.request.agentId)
        return until !== undefined && d.reason === 'agentPaused' ? { request: d.request, reason: 'cooldown', until } : d
      })
      for (const until of held.values()) if (plan.nextAt === null || until < plan.nextAt) plan.nextAt = until
      return plan
    }
  }

  /** The end of a level's prep-failure backoff (`<teamId>|<agentId>|<sessionKey>`), or undefined; an expired one is forgotten. */
  private backoffOf(teamId: string, req: RunRequest, now: number): number | undefined {
    const key = `${teamId}|${req.agentId}|${req.sessionKey}`
    const until = this.prepBackoff.get(key)
    if (until === undefined) return undefined
    if (until > now) return until
    this.prepBackoff.delete(key)
    return undefined
  }

  /** planDispatch of the current runtime with the prep backoff, no commit (dry runs). */
  private dryPlan(teamId: string, facts: DispatchFacts): DispatchPlan {
    const rec = this.teams.get(teamId)
    const def = this.trust.trusted(teamId)
    if (!rec || !def) return { start: [], enqueue: [], deferred: [], nextAt: null }
    return this.planOf(teamId, rec.store.rt, def, facts)
  }

  /** A manual request no candidate came from: its agent is busy (running, stopping, taken over) or the team cannot run. */
  private unplanned(teamId: string, m: ManualRequest): DeferInfo {
    const rec = this.teams.get(teamId)
    const withTask = (d: DeferInfo): DeferInfo => (m.taskId ? { ...d, taskId: m.taskId } : d)
    if (!rec || rec.trust !== 'trusted' || !this.trust.trusted(teamId)) return withTask({ reason: 'untrusted' })
    if (!this.live() || this.installing) return withTask({ reason: 'disabled' })
    const rt = rec.store.rt
    const agent = rt.agents.find((a) => a.id === m.agentId)
    if (agent && (agent.status === 'takenOver' || agent.takeover)) return withTask({ reason: 'takenOver' })
    const run = agent?.runId ? rt.activeRuns.find((r) => r.id === agent.runId) : m.taskId ? rt.activeRuns.find((r) => r.taskId === m.taskId) : undefined
    return withTask({ reason: run?.state === 'stopping' ? 'stopping' : 'running' })
  }

  /**
   * Admits one request of a pass (R1): where and how it runs, the write lock of its tree for a writer run (a
   * pending worktree takes it in the prep, once its path exists), the admission commit. The run id, or null when
   * the state moved under it (the request stays a level; the next pass sees it again).
   */
  private admit(teamId: string, req: RunRequest): string | null {
    const rec = this.teams.get(teamId)
    const ctx0 = this.flowCtx(teamId)
    if (!rec || !ctx0) return null
    const rt = rec.store.rt
    const agent = rt.agents.find((a) => a.id === req.agentId)
    const role = agent ? ctx0.def.def.roles.find((r) => r.id === agent.roleId) : undefined
    const task = req.taskId ? rt.tasks.find((t) => t.id === req.taskId) : undefined
    if (!agent || !role || (req.taskId && !task)) return null
    const where = this.runCwdOf(teamId, rt, ctx0.def, task)
    if (!where) return null
    const sysHash = this.sysHashOf(teamId, role.id) ?? ''
    const sess = agent.sessions[req.sessionKey]
    const resume = !where.pending && sess && sess.turns > 0 && sess.sysHash === sysHash && sess.provider === agent.provider && pathKey(sess.cwd) === pathKey(where.cwd) ? { sessionId: sess.sessionId } : null
    const a: AdmitFacts = { sessionKey: req.sessionKey, resume, cwd: where.cwd, profile: effectiveProfile(role.permission, req.mode), sysHash }
    if (role.model) a.model = role.model
    if (role.effort) a.effort = role.effort
    const runId = ctx0.newRunId()
    const ctx: FlowCtx = { ...ctx0, newRunId: () => runId }
    const lockKey = a.profile !== 'readonly' && !where.pending ? this.locks.key(where.cwd) : null
    if (lockKey && !this.locks.acquire(lockKey, runId)) {
      this.deps.log(`run of ${req.agentId} not admitted: tree held by ${this.locks.holderOf(lockKey) ?? '?'}`)
      return null
    }
    if (req.detail) this.runDetail.set(runId, req.detail)
    // B7: the routine whose wake this request runs (its ref: a dispatched wake, or "Ejecutar ahora" without a prompt,
    // which runs the agent's best level with reason manual); re-wakes never carry the ref.
    const routineId = !task ? routineOfRefs(req.refs) : null
    // B7: a routine's wake mark is never swallowed by another run of the same agent and mode (R1 clears the agent's
    // mark of the mode it admits, and its prompt would be gone): it stays and runs after this one. The run of that
    // very wake consumes it (kept, its prompt would run twice).
    const mark = !task && agent.next && agent.next.mode === req.mode && agent.next.reason === 'routine' ? agent.next : undefined
    const keepRoutine = mark && req.reason !== 'routine' && (routineId === null || routineId !== routineOfRefs(mark.refs)) ? mark : undefined
    // The level R1 consumes (it clears task.next, and the agent's own mark of this mode): a prep failure without a card gives it back.
    const consumed = task ? task.next : agent.next && agent.next.mode === req.mode && !keepRoutine ? agent.next : undefined
    if (consumed && consumed.agentId === agent.id) this.consumedMark.set(runId, { ...consumed })
    // B7: the run of a routine's wake is its `lastRunId` (the panel's last run, the coalesce rule), in the same commit;
    // a wake it still owed (displacedFor) is this run.
    let admitted = admitRun(rt, req, a, ctx)
    if (admitted.ok && (keepRoutine || routineId)) {
      let out = admitted.rt
      if (keepRoutine) out = { ...out, agents: out.agents.map((x) => (x.id === agent.id ? { ...x, next: keepRoutine } : x)) }
      if (routineId) out = patchRoutine(out, routineId, { lastRunId: runId, displacedFor: undefined })
      admitted = { ...admitted, rt: out }
    }
    const res = this.commit(teamId, admitted, routineId ? ['agents', 'run', 'needs', 'routines'] : ['agents', 'run', 'needs'], { runId })
    if (!res.ok) {
      if (lockKey) this.locks.release(lockKey, runId)
      this.runDetail.delete(runId)
      this.consumedMark.delete(runId)
      this.deps.log(`run of ${req.agentId} not admitted: ${res.error}`)
      return null
    }
    const level = `${teamId}|${req.agentId}|${req.sessionKey}`
    for (const k of [...this.discarded.keys()]) if (k === level || k.startsWith(`${level}|`)) this.discarded.delete(k)
    this.deps.log(`run ${runId} admitted agent=${req.agentId} mode=${req.mode} reason=${req.reason}${req.taskId ? ` task=${req.taskId}` : ''} resume=${a.resume ? 'yes' : 'no'}`)
    return runId
  }

  /**
   * What a level the runtime derives looks like (a todo assignee, queued comments, an unread message, the Lead's
   * goal and triage): a discarded item comes back only once this moves. `reason` (B close): a skip of one Lead level
   * (userMessage) reads only what that level derives from, the unread messages.
   */
  private levelSig(rt: Readonly<TeamRuntime>, agentId: string, sessionKey: string, taskId: string | undefined, reason?: string): string {
    const agent = rt.agents.find((a) => a.id === agentId)
    if (taskId) {
      const t = rt.tasks.find((x) => x.id === taskId)
      const queued = (rt.comments[taskId] ?? []).filter((c) => c.forAgent === agentId && c.deliveredRunId === undefined)
      return `t|${t?.rev ?? 0}|${t?.state ?? ''}|${t?.phase ?? ''}|${queued.length}|${queued.at(-1)?.id ?? ''}|${t?.next?.since ?? ''}`
    }
    if (agent?.roleKind === 'lead') {
      const msgs = (rt.comments[LEAD_THREAD] ?? []).filter((c) => c.author.kind === 'user' && c.forAgent === agentId && c.deliveredRunId === undefined)
      if (reason === 'userMessage') return `m|${msgs.length}|${msgs.at(-1)?.id ?? ''}`
      const untriaged = rt.tasks.filter((t) => t.state === 'todo' && !t.assignee && t.triagedAt === undefined).length
      const smallPlans = rt.approvals.filter((x) => x.state === 'pending' && x.decider === 'lead' && !x.leadSeenRunId).length
      return `l|${rt.goalSeenHash ?? ''}|${msgs.length}|${msgs.at(-1)?.id ?? ''}|${untriaged}|${smallPlans}|${agent.next?.since ?? ''}`
    }
    return `f|${sessionKey}|${agent?.next?.since ?? ''}`
  }

  /**
   * The `agentId|sessionKey` levels of a team the user discarded and that did not change since (a changed one is
   * forgotten here), and the `agentId|sessionKey|reason` ones of a single Lead level (B close): planDispatch leaves
   * them out before each agent's minimum, so the agent's next level is its candidate. Only while autonomy is off:
   * with it on nothing waits in "Por despachar" and the level runs.
   */
  private skipOf(teamId: string, rt: Readonly<TeamRuntime>): Set<string> {
    const out = new Set<string>()
    if (rt.autoDispatch || this.discarded.size === 0) return out
    const prefix = `${teamId}|`
    for (const [key, d] of [...this.discarded]) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      // Agent ids, session keys (a task id, 'lead', 'free') and reasons never hold a '|'.
      const [agentId, sessionKey, reason] = rest.split('|')
      if (d.sig === this.levelSig(rt, agentId, sessionKey, d.taskId, reason)) out.add(rest)
      else this.discarded.delete(key)
    }
    return out
  }

  /**
   * "Ejecutar ahora" (decision 44): through Dispatcher.manual, which bypasses only the autonomy gate; every other
   * gate answers `deferred` with its reason. Without a task: the agent's best level, else a free run (lead mode
   * for the Lead). With a task: the run its phase wants of that agent (its assignee in todo and doing, its QA in
   * qa); a task over, blocked or waiting on the user answers `conflict {stale}`, another agent `bad_request`.
   * The prompt rides in memory to the prep and the run's end; only a task-less re-wake the policy asks for keeps it,
   * in its persisted wake mark (withRunDetail).
   */
  runManual(teamId: string, agentId: string, prompt?: string, taskId?: string): { runId: string } | TeamFail {
    const rec = this.teams.get(teamId)
    const def = this.trust.trusted(teamId)
    if (!rec) return fail('not_found')
    if (!def) return fail('untrusted')
    const rt = rec.store.rt
    const agent = rt.agents.find((a) => a.id === agentId)
    if (!agent || !def.def.roles.some((r) => r.id === agent.roleId)) return fail('not_found')
    if (agent.retired) return fail('busy')
    if (taskId) {
      const task = rt.tasks.find((t) => t.id === taskId)
      if (!task) return fail('not_found')
      const run = rt.activeRuns.find((r) => r.taskId === taskId)
      if (run && run.agentId !== agentId) return fail('deferred', { defer: { reason: run.state === 'stopping' ? 'stopping' : 'running', taskId } })
      if (!run) {
        const who = phaseAgentOf(task)
        if (task.state === 'done' || task.state === 'cancelled' || task.state === 'blocked' || who === undefined) return fail('conflict', { reason: 'stale' })
        if (who !== agentId) return fail('bad_request')
      }
    }
    const m: ManualRequest = { agentId, reason: 'manual' }
    if (taskId) m.taskId = taskId
    if (prompt && prompt.trim()) m.detail = prompt
    const r = this.dispatcher.manual(teamId, m)
    return 'runId' in r ? r : fail('deferred', { defer: r.defer })
  }

  /** The kickoff op (decision 43): the Lead turns the goal into tasks now, through Dispatcher.manual like runNow. */
  kickoff(teamId: string): { runId: string } | TeamFail {
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    if (!this.trust.trusted(teamId)) return fail('untrusted')
    const lead = rec.store.rt.agents.find((a) => a.roleKind === 'lead' && !a.retired)
    if (!lead) return fail('not_found')
    const r = this.dispatcher.manual(teamId, { agentId: lead.id, reason: 'kickoff' })
    return 'runId' in r ? r : fail('deferred', { defer: r.defer })
  }

  /**
   * Despachar / Descartar of "Por despachar" (one item or `all`): queueDecide commit, then a pass for what was
   * approved. A discarded level the runtime derives is kept out of the candidates until it changes (memory only),
   * and the pass right after a Descartar offers the agent's next level in its place.
   */
  dispatchQueue(teamId: string, queueId: string, go: boolean, actor: Actor): { approved: string[]; dropped: string[] } | TeamFail {
    const rec = this.teams.get(teamId)
    const ctx = this.flowCtx(teamId)
    if (!rec) return fail('not_found')
    if (!ctx) return fail('untrusted')
    const targets = rec.store.rt.queue.filter((q) => queueId === 'all' || q.id === queueId)
    const res = this.commit(teamId, queueDecide(rec.store.rt, actor, queueId, go, ctx), ['needs', 'agents'])
    if (!res.ok) return fail(res.error)
    if (!go) {
      for (const q of targets) {
        // B close: a task-less level the runtime records (the Lead's goal, triage, small plans, a wake mark) ended in
        // queueDecide (consumeLevel) and needs no skip; the Lead's unread message is the one it derives, skipped by its
        // reason (every Lead level shares the 'lead' session key, so its other levels still enqueue).
        let key = `${teamId}|${q.agentId}|${q.sessionKey}`
        if (!q.taskId) {
          const lead = rec.store.rt.agents.find((a) => a.id === q.agentId)?.roleKind === 'lead'
          if (!lead || q.reason !== 'userMessage') continue
          key += `|${q.reason}`
        }
        const d: { sig: string; taskId?: string } = { sig: this.levelSig(rec.store.rt, q.agentId, q.sessionKey, q.taskId, q.taskId ? undefined : q.reason) }
        if (q.taskId) d.taskId = q.taskId
        this.discarded.set(key, d)
      }
      if (targets.length > 0) this.poke()
    }
    this.deps.log(`dispatch ${teamId} ${go ? 'approved' : 'dropped'} ${(go ? res.result.approved : res.result.dropped).join(',')}`)
    return res.result
  }

  /** Why each agent's and each queue item's run waits now (a dispatch dry run, no commit). */
  dispatchWaiting(teamId: string): { byAgent: Map<string, DeferInfo>; byKey: Map<string, DeferInfo> } {
    return waitingOf(this.dispatcher.dryRun(teamId))
  }

  // ---- needs: approvals, cards, the hire, notices (B5) -----------------------------------------------

  /**
   * The decide op (design 4.3, 6.1; the origin checks are the op's, ops/needs.ts). A final approve of a task with a
   * worktree first reads how far its branch is ahead of its base (T11: nothing to merge goes straight to done); the
   * reducer CASes the approval's state after that await, so a second decide (the desktop and the phone) answers
   * `conflict {already_decided}`. A hire approve turns `applying`: its `applyHire` effect writes and trusts the role.
   * `rev` (B close): the permission approval's rev the user saw (decideApproval answers `conflict {stale}` without it).
   */
  async decide(teamId: string, approvalId: string, decision: 'approve' | 'reject', note: string | undefined, actor: Actor, rev?: number): Promise<TeamFail | null> {
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    const ap = rec.store.rt.approvals.find((a) => a.id === approvalId)
    if (!ap) return fail('not_found')
    let ahead: number | undefined
    if (ap.kind === 'final' && decision === 'approve' && ap.state === 'pending') {
      const task = ap.taskId ? rec.store.rt.tasks.find((t) => t.id === ap.taskId) : undefined
      if (task?.worktree && this.taskWorktrees) ahead = await this.taskWorktrees.ahead(task)
      if (this.teams.get(teamId) !== rec) return fail('not_found')
    }
    const ctx = this.flowCtx(teamId)
    if (!ctx) return fail('untrusted')
    const f: { ahead?: number; rev?: number } = {}
    if (ahead !== undefined) f.ahead = ahead
    if (rev !== undefined) f.rev = rev
    const res = decideApproval(rec.store.rt, actor, approvalId, decision, note, ctx, f)
    // A permission approval with no rule the policy still grants (an earlier build stored them): its own words.
    if (!res.ok && res.error === 'bad_request' && ap.kind === 'permission' && decision === 'approve' && !ap.payload.tools.some(isGrantable)) return fail('bad_request', { detail: 'nothingToGrant' })
    if (!res.ok) return flowFail(res)
    this.commit(teamId, res, [...new Set<TeamScope>(['needs', ...changedScopes(rec.store.rt, res.rt)])], ap.taskId ? { taskId: ap.taskId } : undefined)
    this.deps.log(`decide ${teamId} ${approvalId} ${ap.kind} ${decision}`)
    return null
  }

  /**
   * The answer op (design 4.5; the origin checks are the op's). `killOrphan` is this service's (decision 64: the
   * start time is confirmed again before the tree kill); every other answer and system action goes through answerCard
   * in one commit (a second answer: `conflict {already_decided}`). A retried level is lifted from its prep backoff
   * (the user asked for it now).
   */
  async answer(teamId: string, cardId: string, answer: CardAnswer, actor: Actor): Promise<TeamFail | null> {
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    const card = rec.store.rt.cards.find((c) => c.id === cardId)
    if (!card) return fail('not_found')
    if (answer.action === 'killOrphan') {
      if (card.state !== 'open') return fail('conflict', { reason: 'already_decided' })
      if (card.from.kind !== 'system' || !card.from.actions.includes('killOrphan')) return fail('bad_request')
      return this.killOrphan(teamId, cardId)
    }
    const ctx = this.flowCtx(teamId)
    if (!ctx) return fail('untrusted')
    const res = answerCard(rec.store.rt, actor, cardId, answer, ctx)
    if (!res.ok) return flowFail(res)
    this.commit(teamId, res, [...new Set<TeamScope>(['needs', ...changedScopes(rec.store.rt, res.rt)])], card.taskId ? { taskId: card.taskId } : undefined)
    if (answer.action === 'retry') this.liftPrepBackoff(teamId, cardId)
    this.deps.log(`answer ${teamId} ${cardId}${answer.action ? ` ${answer.action}` : ''}`)
    return null
  }

  /**
   * The user asked for the run of a prep-failure card now (its Reintentar, or Retomar of the task it blocks after a
   * Descartar): the level of the card's run leaves its prep backoff (TeamInternals).
   */
  liftPrepBackoff(teamId: string, cardId: string): void {
    const rec = this.teams.get(teamId)
    const card = rec?.store.rt.cards.find((c) => c.id === cardId)
    const runId = card && card.from.kind === 'system' ? card.from.runId : undefined
    const run = runId ? rec?.store.recentRuns().find((r) => r.id === runId) : undefined
    if (run) this.prepBackoff.delete(`${teamId}|${run.agentId}|${run.sessionKey}`)
  }

  // ---- 2.9.0 Piloto automatico -------------------------------------------------------------------

  /** A pass of the autopilot after this tick (one per team: a commit while it runs owes one more when it ends). */
  private autopilotSoon(teamId: string): void {
    const s = this.autopilotState.get(teamId)
    if (s === 'queued' || s === 'again') return
    if (s === 'running') {
      this.autopilotState.set(teamId, 'again')
      return
    }
    this.autopilotState.set(teamId, 'queued')
    queueMicrotask(() => {
      const job = this.autopilotPass(teamId)
      this.autopilotJobs.add(job)
      void job.finally(() => this.autopilotJobs.delete(job))
    })
  }

  /** Every autopilot pass settled, the ones they owe included (tests). */
  async autopilotIdle(): Promise<void> {
    for (;;) {
      await Promise.resolve()
      if (this.autopilotJobs.size === 0 && this.autopilotState.size === 0) return
      await Promise.allSettled([...this.autopilotJobs])
    }
  }

  /** The skip keys of a team, without the ones whose subject no longer waits (decided, answered, out of Integrar). */
  private autopilotSkipOf(teamId: string, rt: Readonly<TeamRuntime>): Set<string> {
    let skip = this.autopilotSkip.get(teamId)
    if (!skip) {
      skip = new Set()
      this.autopilotSkip.set(teamId, skip)
    }
    const waits = (key: string): boolean => {
      const taskId = keyTask(key)
      if (taskId) return rt.tasks.some((t) => t.id === taskId && t.state === 'review' && t.phase === 'integrating')
      // A hire `applying` still waits: its apply may fail it back to pending (the tries must survive that).
      return rt.approvals.some((a) => (a.state === 'pending' || a.state === 'applying') && approvalKey(a) === key) || rt.cards.some((c) => c.state === 'open' && c.id === key)
    }
    for (const key of [...skip]) if (!waits(key)) skip.delete(key)
    const tries = this.autopilotTries.get(teamId)
    if (tries) for (const key of [...tries.keys()]) if (!waits(key)) tries.delete(key)
    for (const key of [...this.autopilotRebases.keys()]) {
      if (!key.startsWith(`${teamId}|`)) continue
      const task = rt.tasks.find((t) => `${teamId}|${t.id}` === key)
      if (!task || task.state === 'done' || task.state === 'cancelled') this.autopilotRebases.delete(key)
    }
    return skip
  }

  /** One pass: every pick of autopilotPicks in order, each through the method the user's click reaches. */
  private async autopilotPass(teamId: string): Promise<void> {
    this.autopilotState.set(teamId, 'running')
    try {
      const rec = this.teams.get(teamId)
      if (!rec || !this.live() || !this.trust.trusted(teamId)) return
      const skip = this.autopilotSkipOf(teamId, rec.store.rt)
      let tries = this.autopilotTries.get(teamId)
      if (!tries) {
        tries = new Map()
        this.autopilotTries.set(teamId, tries)
      }
      const picks = autopilotPicks(rec.store.rt, skip)
      for (const p of picks) {
        if (this.teams.get(teamId) !== rec || !rec.store.rt.autopilot) break
        const n = tries.get(p.key) ?? 0
        if (n >= AUTOPILOT_TRIES_MAX) {
          // Applied before and waiting again (a hire whose apply failed): it is the user's now.
          skip.add(p.key)
          this.deps.log(`autopilot ${teamId} ${p.kind} ${p.key} left: no progress`)
          continue
        }
        tries.set(p.key, n + 1)
        const failed = await this.autopilotApply(teamId, p)
        if (failed) {
          skip.add(p.key)
          this.deps.log(`autopilot ${teamId} ${p.kind} ${p.key} left: ${failed.error}${failed.reason ? ` ${failed.reason}` : ''}${failed.detail ? ` ${failed.detail}` : ''}`)
        } else this.deps.log(`autopilot ${teamId} ${p.kind} ${p.key}`)
      }
      // What it left now waits on the user: its rows notify.
      if (picks.length && this.teams.get(teamId) === rec) this.noticeNeeds(teamId)
    } catch (err) {
      this.deps.log(`autopilot ${teamId} failed ${(err as Error).name}`)
    } finally {
      const again = this.autopilotState.get(teamId) === 'again'
      this.autopilotState.delete(teamId)
      if (again) this.autopilotSoon(teamId)
    }
  }

  private async autopilotApply(teamId: string, p: AutopilotPick): Promise<TeamFail | null> {
    switch (p.kind) {
      case 'decide':
        return this.decide(teamId, p.approvalId, 'approve', undefined, AUTOPILOT_ACTOR, p.rev)
      case 'answer':
        return this.answer(teamId, p.cardId, { choices: [p.choice] }, AUTOPILOT_ACTOR)
      case 'integrate':
        return this.autopilotIntegrate(teamId, p.taskId)
      case 'rebase':
        return this.autopilotRebase(teamId, p.taskId, p.why)
    }
  }

  /**
   * Integrar for the user: the preview first, and only a clean one lands (no preflight error, a landing mode, no change
   * to the team definition, which would leave the team untrusted); its verify runs as the user's Integrar runs it.
   */
  private async autopilotIntegrate(teamId: string, taskId: string): Promise<TeamFail | null> {
    const pre = await this.integratePreview(teamId, taskId)
    if ('ok' in pre) return pre
    const v = pre.preview
    if (v.error) return fail(v.error)
    if (!('mode' in v.landing)) return fail(v.landing.blocked)
    if (v.touchesDefinition) return fail('conflict', { detail: 'touchesDefinition' })
    const res = await this.integrate(teamId, taskId, v.tip, AUTOPILOT_ACTOR)
    return 'ok' in res ? res : null
  }

  /** T15 for the user: a merge conflict or a failed verify back to the task's Dev, AUTOPILOT_REBASE_MAX times in a row at most. */
  private autopilotRebase(teamId: string, taskId: string, why: 'conflict' | 'verify'): TeamFail | null {
    const rec = this.teams.get(teamId)
    const ctx = this.flowCtx(teamId)
    if (!rec) return fail('not_found')
    if (!ctx) return fail('untrusted')
    const key = `${teamId}|${taskId}`
    const n = this.autopilotRebases.get(key) ?? 0
    if (n >= AUTOPILOT_REBASE_MAX) return fail('cap', { detail: 'rebases' })
    const res = askRebase(rec.store.rt, taskId, why, AUTOPILOT_ACTOR, ctx)
    if (!res.ok) return flowFail(res)
    this.autopilotRebases.set(key, n + 1)
    this.commit(teamId, res, [...new Set<TeamScope>([...changedScopes(rec.store.rt, res.rt), 'needs'])], { taskId })
    return null
  }

  /** The `applyHire` effect (design 4.3): through the team's serial chain of disk-writing ops (3.0 item 5). */
  private applyHire(teamId: string, approvalId: string): void {
    void this.serial(teamId, () => this.applyHireNow(teamId, approvalId)).catch((err) => this.deps.log(`hire ${teamId} ${approvalId} failed ${(err as Error).name}`))
  }

  /**
   * An approved hire, `applying` (design 4.3, 3.2 Hire): the definition on disk must still be the trusted one (else
   * `untrusted`: the user reviews the other edits first), the role text must parse with the trusted files, then
   * `roles/<id>.md` is written atomically (TeamDefinitionLoader: UTF-8 without BOM, LF, no link followed), the folder
   * is loaded again and must hash exactly as the trusted files plus the role, and that exact hash is trusted
   * (approveTrust: the snapshot, the repos, reconcileAgents). completeApproval ends it approved, or pending with the
   * error. A role already trusted with exactly this text (an apply that landed before a restart) is approved as is;
   * else a trusted hash that is no longer the hire's base fails it `stale` (cancelled, B5 review, second round);
   * a folder that already is the trusted files plus exactly this role (an apply cut off between its write and its
   * trust: back to pending at load, decision 28) is trusted without writing again, so approving it again lands.
   */
  private async applyHireNow(teamId: string, approvalId: string): Promise<void> {
    const rec = this.teams.get(teamId)
    const ap0 = rec?.store.rt.approvals.find((a) => a.id === approvalId)
    if (!rec || !ap0 || ap0.kind !== 'hire' || ap0.state !== 'applying') return
    const ap = ap0
    const done = (outcome: { ok: true } | { ok: false; error: string }): void => {
      if (this.teams.get(teamId) !== rec) return
      this.completeHire(teamId, rec, approvalId, outcome)
    }
    const trusted = this.trust.trusted(teamId)
    if (!trusted) return done({ ok: false, error: 'untrusted' })
    const rel = `roles/${ap.payload.roleId}.md`
    const text = normalizeDefText(ap.payload.text)
    if (trusted.files.some((f) => f.rel === rel && normalizeDefText(f.text) === text)) return done({ ok: true })
    // The approve CASed the base (decideApproval), but a trust may land while this apply waits on the serial chain (the
    // user's trust op queued first): the diff the user approved was of the old base, so it is never written over the
    // new one. completeApproval cancels it stale (B5 review, second round).
    if (trusted.sha256 !== ap.payload.baseDefHash) return done({ ok: false, error: HIRE_STALE })
    const files = [...trusted.files.filter((f) => f.rel !== rel), { rel, text }]
    const want = sha256Hex(canonicalDefText(files))
    const loaded = await this.loader.load(rec.entry.repoRoot)
    if (this.teams.get(teamId) !== rec) return
    const landed = !('error' in loaded) && loaded.result.ok && loaded.sha256 === want
    if (!landed && ('error' in loaded || loaded.sha256 !== trusted.sha256)) return done({ ok: false, error: 'untrusted' })
    if (!parseDefinition(files).ok) return done({ ok: false, error: 'invalid_definition' })
    if (!landed) {
      const written = await this.loader.write(rec.entry.repoRoot, [{ rel, text }], { overwrite: trusted.files.some((f) => f.rel === rel) })
      if (this.teams.get(teamId) !== rec) return
      if (!written.ok) return done({ ok: false, error: written.error })
    }
    const after = landed ? loaded : await this.loader.load(rec.entry.repoRoot)
    if (this.teams.get(teamId) !== rec) return
    if ('error' in after || !after.result.ok || after.sha256 !== want) return done({ ok: false, error: 'changed' })
    const failed = await this.approveTrust(teamId, after as LoadedDefinition & { result: { ok: true } })
    if (failed) return done({ ok: false, error: failed.error })
    done({ ok: true })
  }

  /**
   * Decision 28 at load: a hire found `applying` (a quit in the middle of its apply) is approved when its role file
   * on disk has exactly its text and the folder is trusted as it is; else it goes back to pending with
   * `interrupted` (the user may approve it again).
   */
  private recheckApplying(teamId: string, rec: TeamRecord): void {
    const trusted = this.trust.trusted(teamId)
    for (const ap of rec.store.rt.approvals) {
      if (ap.kind !== 'hire' || ap.state !== 'applying') continue
      const rel = `roles/${ap.payload.roleId}.md`
      const onDisk = 'error' in rec.loaded ? undefined : rec.loaded.files.find((f) => f.rel === rel)
      const landed = !!trusted && !('error' in rec.loaded) && rec.loaded.sha256 === trusted.sha256 && !!onDisk && normalizeDefText(onDisk.text) === normalizeDefText(ap.payload.text)
      this.completeHire(teamId, rec, ap.id, landed ? { ok: true } : { ok: false, error: 'interrupted' })
    }
  }

  /**
   * completeApproval of a hire in one commit: approved (the roster follows the newly trusted definition), or back to
   * pending with its error, or cancelled stale when that pending would sit on an old base. An approve needs the trusted
   * definition (reconcileAgents reads it): without one it fails.
   */
  private completeHire(teamId: string, rec: TeamRecord, approvalId: string, outcome: { ok: true } | { ok: false; error: string }): void {
    const ctx = this.flowCtx(teamId)
    const out = outcome.ok && !ctx ? { ok: false as const, error: 'untrusted' } : outcome
    // Without a trusted definition a failure reads only the clock (no hash to call a base stale against).
    const before = rec.store.rt
    const res = completeApproval(before, approvalId, out, ctx ?? ({ now: this.clock() } as FlowCtx))
    if (res.ok) this.commit(teamId, res, [...new Set<TeamScope>(['needs', 'agents', ...changedScopes(before, res.rt)])])
    this.deps.log(`hire ${teamId} ${approvalId} ${out.ok ? 'applied' : `not applied ${out.error}`}`)
    if (res.ok) this.logStaleHires(teamId, before, res.rt)
  }

  /**
   * B5 review: every pending hire whose base is no longer `sha256` (the trusted hash) is cancelled stale in one commit
   * (cancelStaleHires; a trust, the load), and teams.log names each one.
   */
  private dropStaleHires(teamId: string, rec: TeamRecord, sha256: string): void {
    const before = rec.store.rt
    const stale = cancelStaleHires(before, sha256, { now: this.clock() })
    if (stale === before) return
    this.commit(teamId, { ok: true, rt: stale, effects: [], result: undefined }, ['needs'])
    this.logStaleHires(teamId, before, stale)
  }

  /** `hire <teamId> <id> cancelled stale` for each hire waiting (pending or applying) before and cancelled stale after. */
  private logStaleHires(teamId: string, before: TeamRuntime, after: TeamRuntime): void {
    for (const a of before.approvals) {
      if (a.kind !== 'hire' || (a.state !== 'pending' && a.state !== 'applying')) continue
      const now = after.approvals.find((x) => x.id === a.id)
      if (now?.state === 'cancelled' && now.error === HIRE_STALE) this.deps.log(`hire ${teamId} ${a.id} cancelled stale`)
    }
  }

  /**
   * The notices of a team (design 3.1 Notices), after the changes of a tick: each "Te necesita" row that is new
   * against the persisted baseline (`needsSeen`) and has `push` gives one TeamNotice; the baseline then becomes the
   * current rows (TeamStore.setNeedsSeen: written with the state, no rev, no emit). The baseline survives a restart, a
   * Labs toggle and a thaw, so nothing still pending notifies twice.
   */
  private noticeNeeds(teamId: string): void {
    const rec = this.teams.get(teamId)
    if (!rec || !this.live()) return
    // 2.9.0: a row the autopilot is about to clear never notifies nor joins the baseline (one it gives up on notifies then).
    const skip = this.autopilotSkip.get(teamId) ?? new Set<string>()
    const rows = needsRowsOf(rec, this.trust.trusted(teamId)).filter((r) => !autopilotTakes(r, rec.store.rt, skip))
    const ids = rows.map((r) => needSeenKey(r, rec.store.rt))
    const seen = new Set(rec.store.rt.needsSeen ?? [])
    for (const [i, row] of rows.entries()) {
      if (!row.push || seen.has(ids[i])) continue
      this.notify(teamId, rec, { rowId: row.id, taskId: row.taskId, key: noticeKey(row, rec.store.rt.paused), urgent: row.rank === 1 })
    }
    rec.store.setNeedsSeen(ids)
  }

  /** The end of an Integrar (design 3.1 Notices, B6 calls it): `integrated` or `integrateFailed` of a task, once per end. */
  integrateNotice(teamId: string, taskId: string, ok: boolean): void {
    const rec = this.teams.get(teamId)
    if (!rec || !this.live()) return
    this.notify(teamId, rec, { rowId: `${ok ? 'integrated' : 'integrateFailed'}:${taskId}`, taskId, key: ok ? 'teams.push.integrated' : 'teams.push.integrateFailed', urgent: false })
  }

  // ---- routines and run silence (B7, design 3.8) ----------------------------------------------------

  /**
   * The routine keys of a team from its trusted definition (enable, a trust); `catchUp` (enable only) first runs once
   * what came due while the app or the lab was off (a displaced wake that never landed among it, `displacedFor`), when
   * its last due time is within ROUTINE_CATCHUP_MS, and records an older one as skipped (`skippedFor`, logged by the
   * ticker; an owed wake goes with it). Not live or no trusted definition: no key.
   */
  private armRoutines(teamId: string, catchUp: boolean): void {
    const rec = this.teams.get(teamId)
    const trusted = this.trust.trusted(teamId)
    if (!this.live() || !rec || !trusted) {
      this.routines.disarm(teamId)
      return
    }
    const routines = trusted.def.routines
    const missed = catchUp ? this.routines.catchUp(teamId, routines, rec.store.rt.routines, trusted.trustedAt) : []
    this.routines.arm(teamId, routines, rec.store.rt.routines)
    for (const m of missed) {
      if (m.skipped) this.commit(teamId, committed(patchRoutine(rec.store.rt, m.routine.id, { skippedFor: m.scheduledAt, displacedFor: undefined })), ['routines'])
      else this.routines.fire(teamId, m.routine.id, m.scheduledAt)
    }
  }

  /**
   * A routine's due time (the ticker's `fire`, design 3.8). Coalesce: while its previous fire still holds it (an active
   * run, a wake not dispatched, its task still waiting) it is skipped and logged. Else `lastScheduledFor` is committed
   * and written FIRST (no double fire after a crash), then the wake (the role agent's wake mark: lead mode for the
   * Lead, free for the rest, the prompt as its request) or the task, then a pass. A wake whose agents all hold
   * another wake in their one slot waits ROUTINE_SLOT_RETRY_MS and tries again, until ROUTINE_CATCHUP_MS past the
   * due time. A deadline the timer reaches more than ROUTINE_CATCHUP_MS late (the machine slept through it, what
   * schedule.ts calls missed) is judged like the catch-up at enable: its latest due time up to now runs once when it
   * is within ROUTINE_CATCHUP_MS, else it is skipped and logged (`skippedFor`). Every verdict but a wait lands a wake
   * the routine still owed (`displacedFor` goes): placed again, covered by the pending fire, or skipped.
   */
  private fireRoutine(teamId: string, r: RoutineDef, scheduledAt: number): RoutineFireOutcome {
    const rec = this.teams.get(teamId)
    const ctx = this.flowCtx(teamId)
    if (!this.live() || !rec || !ctx) return undefined
    const now = ctx.now
    let at = scheduledAt
    if (now - at > ROUTINE_CATCHUP_MS) {
      at = lastDue(r.cron, at, now) ?? at
      if (now - at > ROUTINE_CATCHUP_MS) {
        this.deps.log(`routine ${teamId} ${r.id} skipped: due ${new Date(at).toISOString()} missed by ${Math.round((now - at) / 60_000)} min`)
        this.commit(teamId, committed(patchRoutine(rec.store.rt, r.id, { skippedFor: at, displacedFor: undefined })), ['routines'])
        return undefined
      }
    }
    const pending = routinePending(rec.store.rt, r)
    if (pending) {
      this.deps.log(`routine ${teamId} ${r.id} skipped: its previous fire still has a ${pending}`)
      this.commit(teamId, committed(patchRoutine(rec.store.rt, r.id, { lastScheduledFor: at, displacedFor: undefined })), ['routines'])
      return undefined
    }
    if (r.action === 'wake') {
      const probe = routineWake(rec.store.rt, r, ctx)
      if (!probe.ok) {
        if (probe.error === 'busy' && now + ROUTINE_SLOT_RETRY_MS - at <= ROUTINE_CATCHUP_MS) {
          this.deps.log(`routine ${teamId} ${r.id} waits: every agent of ${r.role} holds another wake`)
          return { retryAt: now + ROUTINE_SLOT_RETRY_MS }
        }
        this.deps.log(`routine ${teamId} ${r.id} skipped: ${probe.error === 'busy' ? `every agent of ${r.role} still holds another wake` : `no agent of ${r.role}`}`)
        this.commit(teamId, committed(patchRoutine(rec.store.rt, r.id, { lastScheduledFor: at, displacedFor: undefined })), ['routines'])
        return undefined
      }
    }
    this.commit(teamId, committed(patchRoutine(rec.store.rt, r.id, { lastScheduledFor: at, lastFiredAt: now, lastRunId: undefined, lastTaskId: undefined, displacedFor: undefined })), ['routines'])
    rec.store.flushSync()
    if (r.action === 'wake') {
      const res = this.commit(teamId, routineWake(rec.store.rt, r, ctx), ['agents', 'routines'])
      this.deps.log(`routine ${teamId} ${r.id} fired: ${res.ok ? `wake ${res.result.agentId}` : `wake failed ${res.error}`}`)
    } else {
      const before = rec.store.rt
      const made = routineTask(before, r, ctx)
      const res = made.ok ? this.commit(teamId, made, [...new Set<TeamScope>([...changedScopes(before, made.rt), 'routines'])], { taskId: made.result.taskId }) : made
      this.deps.log(`routine ${teamId} ${r.id} fired: ${res.ok ? `task ${res.result.taskId}` : `task failed ${res.error}`}`)
    }
    this.poke()
    return undefined
  }

  /**
   * The routine wakes `before` held in an agent's one slot (agent.next) that `after` wrote another mark over: a run-end
   * policy re-wake of that agent (retry, interrupted, context of a task-less run; also the interrupt of a quit, Labs
   * off, an install, and the reaper after a crash) or the level a failed prep gives back. Each stands for the routine's
   * scheduled time (`lastScheduledFor`, else the mark's since) and is owed while the routine is on in the trusted
   * definition. A mark that just went (its run took it, the user dropped it) is no displacement.
   */
  private displacedWakes(teamId: string, before: TeamRuntime, after: TeamRuntime): DisplacedWake[] {
    if (before.agents === after.agents) return []
    const out: DisplacedWake[] = []
    let on: ReadonlySet<string> | undefined
    for (const a of before.agents) {
      const mark = a.next
      const routineId = mark?.reason === 'routine' ? routineOfRefs(mark.refs) : null
      if (!mark || !routineId) continue
      const next = after.agents.find((x) => x.id === a.id)?.next
      if (!next || (next.reason === 'routine' && routineOfRefs(next.refs) === routineId)) continue
      on ??= new Set((this.trust.trusted(teamId)?.def.routines ?? []).filter((r) => r.enabled).map((r) => r.id))
      out.push({ agentId: a.id, routineId, by: next.reason, scheduledAt: after.routines[routineId]?.lastScheduledFor ?? mark.since, owed: on.has(routineId) })
    }
    return out
  }

  /**
   * After the commit that persisted them (withDisplaced): each owed wake gets its wake-slot retry, the same scheduled
   * time again in ROUTINE_SLOT_RETRY_MS, judged then like any fire (a slot still taken waits again), so its prompt
   * still runs once. A key of the routine that comes due sooner, or no armed routine, arms none: that fire, or the
   * catch-up of the next enable, lands it. The log says `retry` only for a retry armed.
   */
  private retryDisplaced(teamId: string, list: readonly DisplacedWake[]): void {
    for (const d of list) {
      const head = `routine ${teamId} ${d.routineId} wake displaced on ${d.agentId} by ${d.by}`
      if (!d.owed) {
        this.deps.log(`${head}: dropped, the routine is off`)
        continue
      }
      const armed = this.routines.retry(teamId, d.routineId, d.scheduledAt, this.clock() + ROUTINE_SLOT_RETRY_MS)
      this.deps.log(`${head}: ${armed ? 'retry' : this.routines.nextAt(teamId, d.routineId) !== null ? 'owed, its next fire comes sooner' : 'owed to the catch-up'}`)
    }
  }

  routineViews(teamId: string): RoutineView[] {
    const rec = this.teams.get(teamId)
    if (!rec) return []
    return (this.shownDef(rec)?.routines ?? []).map((r) => routineView(r, rec.store.rt.routines[r.id], this.routines.nextAt(teamId, r.id)))
  }

  /**
   * "Correr ahora" (the routineRun op, trust gated like runNow): the user's go for one routine of the trusted
   * definition, off in its file or not. Its previous fire still holding it answers `busy` (the coalesce rule). A task
   * routine creates its task now; a wake runs its agent now through runManual (decision 44: past the autonomy gate
   * only; any other gate answers `deferred` with its reason), the prompt as its request. The run or the task is the
   * routine's last one.
   */
  runRoutine(teamId: string, routineId: string): { runId?: string; taskId?: string } | TeamFail {
    const rec = this.teams.get(teamId)
    const ctx = this.flowCtx(teamId)
    if (!rec) return fail('not_found')
    if (!ctx) return fail('untrusted')
    const r = ctx.def.def.routines.find((x) => x.id === routineId)
    if (!r) return fail('not_found')
    const pending = routinePending(rec.store.rt, r)
    if (pending) return fail('busy', { detail: pending })
    if (r.action === 'task') {
      const before = rec.store.rt
      const made = routineTask(before, r, ctx)
      if (!made.ok) return flowFail(made)
      const res = this.commit(teamId, { ...made, rt: patchRoutine(made.rt, r.id, { lastFiredAt: ctx.now, lastRunId: undefined }) }, [...new Set<TeamScope>([...changedScopes(before, made.rt), 'routines'])], { taskId: made.result.taskId })
      return res.ok ? { taskId: made.result.taskId } : flowFail(res)
    }
    const agents = rec.store.rt.agents.filter((a) => a.roleId === r.role && !a.retired)
    const agent = agents.find((a) => a.status === 'idle' && !a.runId && !a.paused && !a.takeover) ?? agents[0]
    if (!agent) return fail('not_found')
    const started = this.runManual(teamId, agent.id, r.prompt)
    if (!('runId' in started)) return started
    this.commit(teamId, committed(patchRoutine(rec.store.rt, r.id, { lastFiredAt: this.clock(), lastRunId: started.runId, lastTaskId: undefined })), ['routines'])
    return { runId: started.runId }
  }

  /**
   * runSilenceAck: the user ignores the rest of the run's silence (Run.silenceAckedAt, the watch lets it go) and its
   * stalled card goes. A run that is over has nothing to ignore (ok); an unknown run is not_found.
   */
  ackRunSilence(teamId: string, runId: string): TeamFail | null {
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    const active = rec.store.rt.activeRuns.find((r) => r.id === runId)
    if (!active && !rec.store.recentRuns().some((r) => r.id === runId)) return fail('not_found')
    if (!active) return null
    const shown = this.runSilence.has(runId)
    this.unwatchSilence(runId)
    const res = ackSilenceFlow(rec.store.rt, runId, { now: this.clock() })
    const changed = res.ok && res.rt !== rec.store.rt
    this.commit(teamId, res, ['agents', 'run', 'needs'], { runId })
    if (!changed && shown) this.emitRun(teamId, active)
    this.deps.log(`run ${runId} silence ignored by the user`)
    return null
  }

  /** The silence watch follows a run that reached `running` (and whose silence the user did not ignore). */
  private watchSilence(runId: string): void {
    const teamId = this.teamOfRun(runId)
    const run = teamId ? this.activeRun(teamId, runId) : undefined
    if (!run || run.silenceAckedAt !== undefined) return
    this.silenceWatched.add(runId)
    this.silence.watch(teamPaneId(runId))
  }

  private unwatchSilence(runId: string): void {
    this.silence.unwatch(teamPaneId(runId))
    this.silenceWatched.delete(runId)
    this.runSilence.delete(runId)
  }

  /** The changes of a run's silence: its card (agents, run) and its task's card (board, task). */
  private emitRun(teamId: string, run: Pick<Run, 'id' | 'taskId'>): void {
    if (run.taskId) this.emit(teamId, ['agents', 'run', 'board', 'task'], { runId: run.id, taskId: run.taskId })
    else this.emit(teamId, ['agents', 'run'], { runId: run.id })
  }

  /**
   * The run SilenceWatch's host (design 3.8): a run quiet or stalled since its last line. The level lives in memory on
   * the run (views and roster), goes out as `agents`/`run`, and `stalled` opens the run's one stalled card (Frenar,
   * Seguir esperando). A run no longer running, or whose silence the user ignored, is let go.
   */
  private onRunSilence(paneId: string, s: PaneSilence): void {
    const runId = paneId.slice(TEAM_PANE_PREFIX.length)
    const teamId = this.live() ? this.teamOfRun(runId) : null
    const rec = teamId ? this.teams.get(teamId) : undefined
    const run = rec?.store.rt.activeRuns.find((r) => r.id === runId)
    if (!teamId || !rec || !run || run.state !== 'running' || run.silenceAckedAt !== undefined) {
      this.unwatchSilence(runId)
      return
    }
    const cur = this.runSilence.get(runId)
    if (cur && cur.level === s.level && cur.since === s.since) return
    this.runSilence.set(runId, { level: s.level, since: s.since })
    this.deps.log(`run ${runId} silence ${s.level}`)
    if (s.level === 'stalled') {
      const card = openStalledCard(rec.store.rt, run, { now: this.clock() })
      if (card.ok && card.rt !== rec.store.rt) {
        this.commit(teamId, card, ['needs', 'agents', 'run'], { runId })
        return
      }
    }
    this.emitRun(teamId, run)
  }

  /**
   * A line of a run whose silence is on show (the host's recovery, SilenceWatch.ts): the silence clears, the watch
   * counts again from this line (rearm) and the run's open stalled card goes, in one commit: one change out per
   * recovery (line events never emit otherwise).
   */
  private silenceRecovered(runId: string): void {
    this.runSilence.delete(runId)
    if (this.silenceWatched.has(runId)) this.silence.rearm(teamPaneId(runId))
    const teamId = this.teamOfRun(runId)
    const rec = teamId ? this.teams.get(teamId) : undefined
    const run = rec?.store.rt.activeRuns.find((r) => r.id === runId)
    if (!teamId || !rec || !run) return
    this.deps.log(`run ${runId} silence over`)
    const rt = dismissStalledCard(rec.store.rt, runId)
    if (rt !== rec.store.rt) this.commit(teamId, committed(rt), ['needs', 'agents', 'run'], { runId })
    else this.emitRun(teamId, run)
  }

  /**
   * `settings.agents.silence` (the same minutes as the consoles, normalizeSilence). A change re-judges every watched
   * run at once (the watch); a silence on show the new minutes no longer reach goes with its open stalled card, in one
   * commit (no line would dismiss that card later: nothing is on show), one they still reach keeps its level, and one
   * they move to another level takes it through the watch's own host path (onRunSilence): a quiet run the new minutes
   * call stalled opens its one stalled card (and its notice) here, and the watch's next report of that same level
   * changes nothing.
   */
  private configureSilence(cfg: ConfigFile | null): void {
    if (!this.silence.configure(normalizeSilence(cfg?.settings?.agents?.silence))) return
    for (const [runId, s] of [...this.runSilence]) {
      const level = this.silence.levelFor(this.clock() - s.since)
      if (level === s.level) continue
      if (level) {
        this.onRunSilence(teamPaneId(runId), { level, since: s.since })
        continue
      }
      this.runSilence.delete(runId)
      const teamId = this.teamOfRun(runId)
      const rec = teamId ? this.teams.get(teamId) : undefined
      const run = rec?.store.rt.activeRuns.find((r) => r.id === runId)
      if (!teamId || !rec || !run) continue
      const rt = dismissStalledCard(rec.store.rt, runId)
      if (rt !== rec.store.rt) this.commit(teamId, committed(rt), ['needs', 'agents', 'run'], { runId })
      else this.emitRun(teamId, run)
    }
  }

  // ---- Integrar (B6) -----------------------------------------------------------------------------

  /** A job of the Integrar side (an integrate, a sweep) kept until it settles: integrateIdle waits on them. */
  private track(job: Promise<unknown>): void {
    const p = job.catch((err) => this.deps.log(`integrate job failed ${(err as Error).name}`))
    this.integrateJobs.add(p)
    void p.finally(() => this.integrateJobs.delete(p))
  }

  /** Resolves once no integrate nor sweep of this service is in flight (tests; nothing in the app waits on it). */
  async integrateIdle(): Promise<void> {
    while (this.integrateJobs.size > 0) await Promise.allSettled([...this.integrateJobs])
  }

  /**
   * The exit hooks (B6 integration): every integrate begun ends `interrupted` before its next step (Integrator.halt:
   * no temp tree, verify or land starts after this; a step already running, a land too, finishes) and every verify
   * tree is killed now (treeKill.ts). What the end commit does not reach before the app exits, the load reads as
   * `interrupted` (interruptedIntegrates).
   */
  private haltIntegrates(why: string): void {
    this.integrator?.halt()
    const killed = this.verifyRunner.killAll()
    if (this.integrating.size > 0 || killed > 0) this.deps.log(`integrate halted (${why}) integrates=${this.integrating.size} verifies=${killed}`)
  }

  /** Integrates in flight of a team. */
  private integratesOf(teamId: string): number {
    let n = 0
    for (const k of this.integrating.keys()) if (k.startsWith(`${teamId}|`)) n++
    return n
  }

  private sendIntegrate(e: IntegrateProgressEvt): void {
    try {
      this.deps.sendIntegrate?.(e)
    } catch (err) {
      this.deps.log(`integrate progress failed ${(err as Error).name}`)
    }
  }

  /**
   * The verify command of a repo (requirement 2 of B6: only the trusted definition names it, `ResolvedRepo.verify`
   * comes from the trusted snapshot) and whether the user confirmed that exact text (its sha256 in verifyConfirmed).
   */
  private verifyOf(rt: Readonly<TeamRuntime>, repo: ResolvedRepo): { command: string; confirmed: boolean } | null {
    if (!repo.verify) return null
    const c = rt.verifyConfirmed[repo.repoId]
    return { command: repo.verify, confirmed: !!c && c.command === repo.verify && c.sha256 === sha256Hex(repo.verify) }
  }

  /**
   * B6 integration: the trees of `tasks` read now (TaskWorktrees.live: on disk, ahead and behind, short timeouts,
   * cached per tip), for the views the task and needs ops build next. A task without a tree or whose repo does not
   * resolve is skipped; never throws. Second round: never behind a busy git semaphore (a long land, a temp tree being
   * added): with no slot free right away a read keeps the cached counts, so the drawer never waits for one.
   */
  async readWorktreeLive(teamId: string, tasks: readonly TeamTask[]): Promise<void> {
    const tw = this.taskWorktrees
    if (!tw) return
    // One tree at a time: a live read takes a git slot only when one is free right away, so reads run together would
    // take each other's (three trees and two slots would leave one unread on every needs op, with git idle).
    for (const t of tasks) {
      if (!t.worktree) continue
      const repo = this.repoOf(teamId, t.repoId)
      if (!('repoRoot' in repo)) continue
      try {
        await tw.live(repo.repoRoot, t.worktree)
      } catch (err) {
        this.deps.log(`worktree ${teamId} ${t.id} live read failed ${(err as Error).name}`)
      }
    }
  }

  /** B6 integration: a task tree as readWorktreeLive last read it (no git, no disk); null when never read. */
  worktreeLive(task: TeamTask): WorktreeLive | null {
    return task.worktree ? (this.taskWorktrees?.cachedLive(task.worktree) ?? null) : null
  }

  /**
   * What the repo's root suggests to verify (design 2.11): the names of its root entries and the script names of its
   * package.json (a regular file of 1 MB at most), nothing else read and nothing run. The Integrar preview (no verify
   * declared) and, since the B6 integration, the setup probe's chip.
   */
  async verifySuggestions(repoRoot: string): Promise<VerifySuggestion[]> {
    let rootFiles: string[] = []
    try {
      rootFiles = (await fsp.readdir(repoRoot)).slice(0, 5000)
    } catch {
      return []
    }
    let npmScripts: string[] | undefined
    if (rootFiles.some((n) => n.toLowerCase() === 'package.json')) {
      try {
        const file = join(repoRoot, 'package.json')
        const st = await fsp.lstat(file)
        if (st.isFile() && st.size <= 1024 * 1024) {
          const scripts = (JSON.parse(await fsp.readFile(file, 'utf8')) as { scripts?: unknown })?.scripts
          if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) npmScripts = Object.keys(scripts).slice(0, 200)
        }
      } catch {
        npmScripts = undefined
      }
    }
    return suggestVerify({ rootFiles, npmScripts, windows: this.platform === 'win32' })
  }

  /** The resolved repo of a task (decision 62), or why it does not resolve. */
  private taskRepo(teamId: string, task: TeamTask): ResolvedRepo | TeamFail {
    const repo = this.repoOf(teamId, task.repoId)
    return 'repoRoot' in repo ? repo : fail('git_error', { detail: 'repo' })
  }

  /** The integratePreview op (design 6.1): read only, for a task in review/integrating (an integrate in flight included). */
  async integratePreview(teamId: string, taskId: string): Promise<{ preview: IntegratePreview } | TeamFail> {
    const integrator = this.integrator
    if (!integrator) return fail('unsupported')
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    const task = rec.store.rt.tasks.find((t) => t.id === taskId)
    if (!task) return fail('not_found')
    if (task.state !== 'review' || task.phase !== 'integrating') return fail('conflict', { reason: 'stale' })
    const repo = this.taskRepo(teamId, task)
    if ('ok' in repo) return repo
    const verify = this.verifyOf(rec.store.rt, repo)
    const suggestions = verify ? [] : await this.verifySuggestions(repo.repoRoot)
    const preview = await integrator.preview(teamId, repo, task, verify, suggestions)
    if (this.teams.get(teamId) !== rec) return fail('not_found')
    return { preview }
  }

  /**
   * The integrate op (design 3.7, 6.1): the definition is checked again first (design 3.9: an edit since the last
   * check makes it untrusted), then `beginIntegrate` commits the attempt and the Integrator runs in the background;
   * the reply is its id (its progress arrives as teams:integrateProgress). A verify runs only when the trusted
   * definition declares one and the user confirmed that exact command; an unconfirmed one is skipped. The end commit
   * is T13 (done, closeTaskNeeds) or T14 (failed) with a notice; the write locks of `integrate:<teamId>:<taskId>`
   * are released on every path.
   */
  async integrate(teamId: string, taskId: string, expectTip: string, actor: Actor): Promise<{ integrationId: string } | TeamFail> {
    const integrator = this.integrator
    if (!integrator) return fail('unsupported')
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    if (this.removing.has(teamId)) return fail('busy', { detail: 'remove' })
    // B6 integration: the installer is about to close the app (prepareInstall halted what was in flight).
    if (this.installing) return fail('busy', { detail: 'install' })
    await this.defCheck(teamId)
    if (this.teams.get(teamId) !== rec || this.removing.has(teamId)) return fail('not_found')
    if (this.installing) return fail('busy', { detail: 'install' })
    if (rec.trust !== 'trusted') return fail('untrusted')
    const task = rec.store.rt.tasks.find((t) => t.id === taskId)
    if (!task) return fail('not_found')
    if (this.integrating.has(`${teamId}|${taskId}`)) return fail('busy')
    const repo = this.taskRepo(teamId, task)
    if ('ok' in repo) return repo
    const ctx = this.flowCtx(teamId)
    if (!ctx) return fail('untrusted')
    const v = this.verifyOf(rec.store.rt, repo)
    const verify = v?.confirmed ? { command: v.command, timeoutMs: ctx.def.def.verifyTimeoutMin * 60_000 } : undefined
    const begun = this.commit(teamId, beginIntegrate(rec.store.rt, taskId, ctx), ['task', 'needs'], { taskId })
    if (!begun.ok) return flowFail(begun)
    const attempt = begun.result.attempt
    const integrationId = `i-${randomBytes(6).toString('hex')}`
    const entry: { integrationId: string; attempt: number; land: boolean; job?: Promise<void> } = { integrationId, attempt, land: false }
    this.integrating.set(`${teamId}|${taskId}`, entry)
    const cur = rec.store.rt.tasks.find((t) => t.id === taskId) ?? task
    this.deps.log(`integrate ${teamId} ${taskId} start ${integrationId} attempt=${attempt}${verify ? ' verify' : v ? ' verify-unconfirmed' : ''}`)
    entry.job = this.runIntegrate(teamId, rec, cur, repo, { expectTip, verify, integrationId, attempt, actor })
    this.track(entry.job)
    return { integrationId }
  }

  /**
   * A commit of an integrate on the team's current store; with none (Labs off, a freeze since the integrate began,
   * an enable that failed to load the team) on the newest store the team had, written at once (design 3.1: the end
   * commit of an integrate in flight is written synchronously). B6 review: whatever live() says, since the flush
   * deadline of the service only reaches a loaded store. Never the store the integrate began on when a later load
   * replaced it (its runtime is stale). A removed team's store gets nothing.
   */
  private integrateCommit<R>(teamId: string, rec: TeamRecord, reduce: (rt: TeamRuntime) => FlowResult<R>, scopes: TeamScope[], taskId: string): FlowResult<R> | null {
    const cur = this.teams.get(teamId)
    if (cur) return this.commit(teamId, reduce(cur.store.rt), scopes, { taskId })
    const last = this.newestRecs.get(teamId) ?? rec
    if (this.removedRecs.has(rec) || this.removedRecs.has(last)) return null
    const res = last.store.commit(reduce(last.store.rt), scopes, { taskId })
    last.store.flushSync()
    return res
  }

  private async runIntegrate(
    teamId: string,
    rec: TeamRecord,
    task: TeamTask,
    repo: ResolvedRepo,
    o: { expectTip: string; verify?: { command: string; timeoutMs: number }; integrationId: string; attempt: number; actor: Actor },
  ): Promise<void> {
    const key = `${teamId}|${task.id}`
    let res: IntegrateResult
    try {
      res = await (this.integrator as Integrator).integrate(teamId, repo, task, {
        expectTip: o.expectTip,
        integrationId: o.integrationId,
        ...(o.verify ? { verify: o.verify } : {}),
        onStep: (step) => {
          // Its land began (after the halt check, in the same tick): prepareInstall waits for this integrate's end.
          const live = this.integrating.get(key)
          if (step === 'land' && live?.integrationId === o.integrationId) live.land = true
          void this.integrateCommit(teamId, rec, (rt) => integrateStep(rt, task.id, o.attempt, step, { now: this.clock() }), ['task'], task.id)
        },
      })
    } catch (err) {
      this.deps.log(`integrate ${teamId} ${task.id} threw ${(err as Error).name}`)
      res = { ok: false, error: 'git_error', step: 'cleanup' }
    } finally {
      // Every exit path frees what the integrate held (the Integrator released them too: compare-and-clear).
      this.locks.releaseAll(integrateHolder(teamId, task.id))
    }
    const outcome: IntegrateOutcome = res.ok
      ? { ok: true, mergeSha: res.mergeSha, base: res.base, landed: res.landed, ...(res.mergeBase ? { mergeBase: res.mergeBase } : {}) }
      : {
          ok: false, error: res.error, step: res.step, ...(res.files ? { files: res.files } : {}), ...(res.tail ? { tail: res.tail } : {}),
          // B6 review, second round: the drawer, the reopened dialog and a rebaseVerify comment read them from the task.
          ...(res.verifyNote ? { verifyNote: res.verifyNote } : {}), ...(res.landing ? { landing: res.landing } : {}),
          ...(res.mergeBase ? { mergeBase: res.mergeBase } : {}),
        }
    let ended: FlowResult<{ ok: boolean }> | null
    try {
      ended = this.integrateCommit(teamId, rec, (rt) => endIntegrate(rt, task.id, o.attempt, outcome, o.actor, { now: this.clock() }), ['task', 'board', 'needs'], task.id)
    } finally {
      // After the end commit (a load meanwhile must not read this attempt as interrupted), and even when it threw:
      // a key left behind would answer `busy` to every later Integrar of the task.
      this.integrating.delete(key)
    }
    if (!ended || !ended.ok) {
      this.deps.log(`integrate ${teamId} ${task.id} end not recorded (stale)`)
      return
    }
    this.deps.log(`integrate ${teamId} ${task.id} ${res.ok ? `landed ${res.landed}` : `failed ${res.error} at ${res.step}`}`)
    this.integrateNotice(teamId, task.id, res.ok)
  }

  /** The repos a team integrates into: its main root and every resolved extra repo. */
  private repoRootsOf(rec: TeamRecord): string[] {
    const out = [rec.entry.repoRoot]
    for (const r of rec.repos.values()) if ('repoRoot' in r && !out.includes(r.repoRoot)) out.push(r.repoRoot)
    return out
  }

  /** At enable: the Integrator's sweep of the team's integrate folder (design 3.7), then its verify log prune. */
  private async sweepIntegrate(rec: TeamRecord): Promise<void> {
    if (!this.integrator) return
    await this.integrator.sweep(rec.entry.id, this.repoRootsOf(rec))
  }

  /**
   * The removeWorktree op (design 6.1, plan 3.9 step 6): the worktree and the `sn/` branch of a done or cancelled
   * task go, through TaskWorktrees.remove with the task's owner, compared against an inspect made right before
   * (a commit or a write in between is `conflict {stale}`). Nothing is ever dropped here: uncommitted files are
   * `dirty_worktree {files}`, commits its base branch does not have (a task moved to done by hand, a cancelled one)
   * `dirty_worktree {commits}`. A run, an integrate, a takeover or any other lock holder on the tree -> `busy`; a
   * console of the saved config in that folder (B close: the one "Abrir consola en el worktree" opens has no
   * `worktree` attribute) -> `busy {detail: 'shared'}`.
   */
  async removeTaskWorktree(teamId: string, taskId: string): Promise<TeamFail | null> {
    const tw = this.taskWorktrees
    if (!tw) return fail('unsupported')
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    const task = rec.store.rt.tasks.find((t) => t.id === taskId)
    if (!task) return fail('not_found')
    const wt = task.worktree
    if (!wt) return fail('missing_worktree')
    if (task.state !== 'done' && task.state !== 'cancelled') return fail('conflict', { reason: 'stale' })
    if (task.integrate?.state === 'running' || this.integrating.has(`${teamId}|${taskId}`)) return fail('busy', { detail: 'integrate' })
    const wtKey = this.locks.key(wt.path)
    const rt = rec.store.rt
    if (rt.activeRuns.some((r) => r.taskId === taskId || this.locks.key(r.cwd) === wtKey)) return fail('busy', { detail: 'run' })
    if (rt.agents.some((a) => a.takeover && 'cwd' in a.takeover && this.locks.key(a.takeover.cwd) === wtKey)) return fail('busy', { detail: 'takeover' })
    if (this.locks.holderOf(wtKey) !== null || this.lingeringOf(teamId).cwds.has(wtKey)) return fail('busy', { detail: 'lock' })
    if (this.consoleIn(wt.path)) return fail('busy', { detail: 'shared' })
    const insp = await tw.inspect(task)
    const again = this.teams.get(teamId) === rec ? rec.store.rt.tasks.find((t) => t.id === taskId) : undefined
    if (!again || again.worktree?.path !== wt.path || (again.state !== 'done' && again.state !== 'cancelled')) return fail('conflict', { reason: 'stale' })
    if (insp.exists && insp.dirtyFiles > 0) return fail('dirty_worktree', { detail: 'files' })
    const repo = this.taskRepo(teamId, task)
    if ('ok' in repo) return repo
    if (await this.branchLoses(repo.repoRoot, wt.branch, wt.baseBranch, insp.tip)) return fail('dirty_worktree', { detail: 'commits' })
    if (this.teams.get(teamId) !== rec) return fail('not_found')
    // Again after the awaits: a console opened meanwhile keeps the folder too.
    if (this.consoleIn(wt.path)) return fail('busy', { detail: 'shared' })
    const res = await tw.remove(again, { tip: insp.tip ?? '', dirty: insp.dirtyFiles })
    if (!res.ok) {
      this.deps.log(`worktree ${teamId} ${taskId} not removed ${res.error}${'detail' in res && res.detail ? ` ${res.detail}` : ''}`)
      const detail = 'detail' in res && typeof res.detail === 'string' ? res.detail : undefined
      switch (res.error) {
        case 'changed':
          return fail('conflict', { reason: 'stale', ...(detail ? { detail } : {}) })
        case 'busy':
        case 'shared':
          return fail('busy', { detail: detail ?? res.error })
        case 'not_managed':
          return fail('missing_worktree', detail ? { detail } : {})
        default:
          return fail('git_error', detail ? { detail } : {})
      }
    }
    const done = this.integrateCommit(teamId, rec, (r) => worktreeRemoved(r, taskId, wt.path, { now: this.clock() }), ['task', 'board'], taskId)
    this.deps.log(`worktree ${teamId} ${taskId} removed`)
    return done && !done.ok ? flowFail(done) : null
  }

  /** B close: a console of the saved config (any workspace) whose cwd, its own or its workspace's, is `tree` or inside it. */
  private consoleIn(tree: string): boolean {
    for (const ws of this.deps.config()?.workspaces ?? []) {
      for (const p of ws.panes ?? []) {
        const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : ws.cwd
        if (typeof cwd === 'string' && cwd && this.locks.within(cwd, tree)) return true
      }
    }
    return false
  }

  /**
   * Deleting `branch` would drop commits: it resolves and is not in `base` (merge-base --is-ancestor exit 1), or git
   * cannot tell (unknown counts as lost). A branch that is gone loses nothing; B6 review: gone is only git's own answer
   * for a missing ref (rev-parse --verify --quiet exits 1 and prints nothing), never a timeout or another failure, and a
   * tip the inspect just read (`knownTip`) proves the branch is there.
   */
  private async branchLoses(repoRoot: string, branch: string, base: string, knownTip?: string): Promise<boolean> {
    const run = (args: string[]): Promise<string> => this.git.run(args, { cwd: repoRoot, timeoutMs: 15_000, priority: 'desktop' })
    if (!knownTip) {
      try {
        await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
      } catch (e) {
        const out = (e as { stdout?: unknown } | null)?.stdout
        return !(gitExitCode(e) === 1 && (typeof out !== 'string' || out.trim() === ''))
      }
    }
    try {
      await run(['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${base}`])
      return false
    } catch {
      // Exit 1: not in the base; anything else: git cannot tell. Both keep the branch.
      return true
    }
  }

  /**
   * One TeamNotice: the trusted team name and the task id only, from the main catalog, redacted. `push` (default true,
   * B8): false keeps it a desktop toast (noticeRouter.routeTeam sends nothing remote for it).
   */
  private notify(teamId: string, rec: TeamRecord, o: { rowId: string; taskId?: string; key: MainKey; urgent: boolean; push?: boolean }): void {
    if (!this.deps.notice) return
    const cfg = this.deps.config()
    const team = this.trust.trusted(teamId)?.def.name ?? rec.entry.name
    const n: TeamNotice = {
      kind: 'team',
      teamId,
      tag: `team:${teamId}:${o.rowId}`,
      title: redactCredentials(mainT(cfg, 'teams.push.title', { team })),
      body: redactCredentials(mainT(cfg, o.key, { team, task: o.taskId ?? '' })),
      urgent: o.urgent,
      push: o.push !== false,
    }
    if (o.taskId) n.taskId = o.taskId
    try {
      this.deps.notice(n)
    } catch (err) {
      this.deps.log(`notice ${teamId} failed ${(err as Error).name}`)
    }
    this.deps.log(`notice ${teamId} ${o.key.slice('teams.push.'.length)} ${o.rowId}`)
  }

  runLive(runId: string): { lastLineAt?: number; silence?: PaneSilence; ring: readonly ChatMessage[] | null; cutAt: number | null; live: boolean } {
    const out: { lastLineAt?: number; silence?: PaneSilence; ring: readonly ChatMessage[] | null; cutAt: number | null; live: boolean } = {
      ring: this.supervisor.ring(runId),
      cutAt: this.supervisor.cutAt(runId),
      live: this.supervisor.isAlive(runId),
    }
    const at = this.supervisor.lastLineAt(runId)
    if (at !== undefined) out.lastLineAt = at
    const silence = this.runSilence.get(runId)
    if (silence) out.silence = { ...silence }
    return out
  }

  watchRun(teamId: string, runId: string | null): void {
    this.watched = runId ? { teamId, runId } : null
  }

  /**
   * B5 integration, sixth round (security): a run's chat rows as they leave main (runPage, teams:runAppend), every
   * text with redactCredentials and every live token of the app masked (CtlTokens.maskTokens through deps.cli). A run
   * reads what it can (runtime.json, a console's env); its log file under dataDir() keeps the raw lines.
   */
  maskRun(items: readonly ChatMessage[]): ChatMessage[] {
    return maskMessages(items, (text) => redactCredentials(this.maskTokens(text)))
  }

  /** B8: one text as it may leave for the phone, the mask of maskRun (phoneFit runs it on every string of a teamRes). */
  private readonly phoneMask = (text: string): string => redactCredentials(this.maskTokens(text))

  /**
   * `text` with every live token of the app masked (CtlTokens.maskTokens through deps.cli; as is without it). Seventh
   * round of the B5 integration: also what a run's final text leaves in the team state (finishRun's RunEndCtx.mask:
   * Run.summary and the Lead's reply).
   */
  private readonly maskTokens = (text: string): string => {
    const cli = this.deps.cli
    return cli ? cli.maskTokens(text) : text
  }

  /**
   * Coalesced per team (and task/run hint) per tick; `rev` is the runtime rev
   * when the event leaves. The trust state and the definition live outside the
   * runtime, so their changes (defCheckNow, approveTrust, addTeam) may leave at
   * an unchanged rev: the renderer drops only an older rev and refetches an equal one.
   */
  emit(teamId: string, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): void {
    const all = new Set<TeamScope>(scopes)
    if (all.has('team') || all.has('needs') || all.has('agents') || all.has('run')) all.add('list')
    const key = `${teamId}|${hint?.taskId ?? ''}|${hint?.runId ?? ''}`
    const cur = this.pendingEmits.get(key)
    if (cur) {
      for (const s of all) if (!cur.scopes.includes(s)) cur.scopes.push(s)
    } else {
      const evt: { teamId: string; scopes: TeamScope[]; taskId?: string; runId?: string } = { teamId, scopes: [...all] }
      if (hint?.taskId) evt.taskId = hint.taskId
      if (hint?.runId) evt.runId = hint.runId
      this.pendingEmits.set(key, evt)
    }
    if (this.emitQueued) return
    this.emitQueued = true
    void Promise.resolve().then(() => this.flushEmits())
  }

  private flushEmits(): void {
    this.emitQueued = false
    const list = [...this.pendingEmits.values()]
    this.pendingEmits.clear()
    for (const e of list) {
      const evt: TeamChangedEvt = { teamId: e.teamId, rev: this.teams.get(e.teamId)?.store.rt.rev ?? 0, scopes: e.scopes }
      if (e.taskId) evt.taskId = e.taskId
      if (e.runId) evt.runId = e.runId
      try {
        this.deps.emit(evt)
      } catch (err) {
        this.deps.log(`emit failed ${(err as Error).name}`)
      }
    }
    // B5: every change of a tick, a commit or a trust state, may add a need row (the notices diff, design 3.1).
    for (const teamId of new Set(list.map((e) => e.teamId))) if (teamId) this.noticeNeeds(teamId)
  }

  /**
   * Decision 62: the resolved repo of a team, or why it does not resolve.
   * `main` is the registry root with the trusted base branch; extra repos come
   * from the cache filled at load and at every trust.
   */
  repoOf(teamId: string, repoId: string): ResolvedRepo | DefError {
    const missing: DefError = { file: 'team.md', line: 0, key: `repo.${repoId}.path`, code: 'repo', detail: 'missing', severity: 'error' }
    const rec = this.teams.get(teamId)
    if (!rec) return missing
    const def = this.trust.trusted(teamId)?.def
    if (repoId === REPO_MAIN) {
      const r: ResolvedRepo = { repoId, repoRoot: rec.entry.repoRoot, baseBranch: def?.baseBranch ?? rec.entry.baseBranch }
      if (def?.verify) r.verify = def.verify
      return r
    }
    return rec.repos.get(repoId) ?? missing
  }

  /**
   * Extra repos on disk (decision 62): a relative path against the main root;
   * no link or junction at any level (the realpath equals the lexical path);
   * a git main root (not a linked worktree, not bare); not inside the main
   * root, dataDir() or the worktree root; not twice. A UNC or device path
   * (as written, or resolved on win32: a team on a share) is refused before
   * any lstat, realpath or git call: on Windows that lookup alone reaches the
   * network and hands the user's NTLM hash to the host (`unc`).
   */
  async resolveRepos(mainRoot: string, def: TeamDefinition, files: readonly { rel: string; text: string }[]): Promise<{ repos: Map<string, ResolvedRepo | DefError>; issues: DefError[] }> {
    const repos = new Map<string, ResolvedRepo | DefError>()
    const issues: DefError[] = []
    if (def.extraRepos.length === 0) return { repos, issues }
    const team = files.find((f) => f.rel === 'team.md')
    const fm = team ? parseFrontmatter('team.md', team.text) : null
    const lineOf = (key: string): number => (fm && fm.ok ? fm.fields.find((f) => f.key === key)?.line ?? 0 : 0)
    const cfgRoot = this.deps.config()?.settings?.worktreesRoot?.trim()
    const fenced = [mainRoot, this.deps.dataDir(), ...(cfgRoot && isAbsolute(cfgRoot) ? [cfgRoot] : [])]
    const win = (this.deps.platform ?? process.platform) === 'win32'
    const seen: string[] = []
    for (const x of def.extraRepos) {
      const key = `repo.${x.id}.path`
      const bad = (detail: 'unc' | 'missing' | 'link' | 'not_git' | 'not_main_root' | 'inside' | 'duplicate'): void => {
        const e: DefError = { file: 'team.md', line: lineOf(key), key, code: 'repo', detail, severity: 'error' }
        repos.set(x.id, e)
        issues.push(e)
      }
      if (UNC_PATH_RE.test(x.path)) {
        bad('unc')
        continue
      }
      const abs = isAbsolute(x.path) ? resolve(x.path) : resolve(mainRoot, x.path)
      if (win && UNC_PATH_RE.test(abs)) {
        bad('unc')
        continue
      }
      let real: string
      try {
        const st = await this.repoFs.lstat(abs)
        if (st.isSymbolicLink()) {
          bad('link')
          continue
        }
        if (!st.isDirectory()) {
          bad('missing')
          continue
        }
        real = await this.repoFs.realpath(abs)
      } catch {
        bad('missing')
        continue
      }
      if (pathKey(real) !== pathKey(abs)) {
        bad('link')
        continue
      }
      if (fenced.some((f) => isSameOrInside(real, f))) {
        bad('inside')
        continue
      }
      const main = await resolveMainRoot(this.git, real)
      if (main === null) {
        bad('not_git')
        continue
      }
      if (pathKey(main) !== pathKey(real)) {
        bad('not_main_root')
        continue
      }
      if (seen.some((s) => pathKey(s) === pathKey(main))) {
        bad('duplicate')
        continue
      }
      seen.push(main)
      const r: ResolvedRepo = { repoId: x.id, repoRoot: main, baseBranch: x.baseBranch ?? (await currentBranch(this.git, main)) ?? 'main' }
      if (x.verify) r.verify = x.verify
      repos.set(x.id, r)
    }
    return { repos, issues }
  }

  async addTeam(repoRoot: string, loaded: LoadedDefinition & { result: { ok: true } }, baseBranch: string): Promise<{ teamId: string } | TeamFail> {
    const teamId = this.idOf(repoRoot)
    if (this.registry.get(teamId) || this.teams.has(teamId)) return fail('exists')
    const def = loaded.result.def
    const r = await this.resolveRepos(repoRoot, def, loaded.files)
    if (r.issues.length > 0) return fail('invalid_definition', { issues: r.issues })
    if (!this.live()) return fail('disabled')
    const entry: TeamIndexEntry = { id: teamId, repoRoot, name: def.name, baseBranch, createdAt: this.clock() }
    this.registry.put(entry)
    this.trust.reload(teamId)
    const { store } = TeamStore.load(this.storeDeps(teamId), teamId, null)
    const rec: TeamRecord = { entry, store, loaded, trust: 'untrusted', repoIssues: [], repos: new Map(), stopWatch: null }
    this.teams.set(teamId, rec)
    this.newestRecs.set(teamId, rec)
    rec.stopWatch = this.loader.watch(teamId, repoRoot, () => this.onDefEvent(teamId))
    const approved = this.trust.approve(teamId, repoRoot, loaded, goalHashOf(def.goal))
    if ('error' in approved) {
      await this.recompute(rec)
      this.emit(teamId, ['list'])
      return fail('io')
    }
    rec.repos = r.repos
    store.setDef(approved)
    this.setTrust(rec, 'trusted')
    const ctx = this.flowCtx(teamId)
    if (ctx) this.commit(teamId, reconcileAgents(store.rt, ctx), ['agents'])
    this.armRoutines(teamId, false)
    this.emit(teamId, ['list', 'team', 'needs', 'routines'])
    return { teamId }
  }

  async approveTrust(teamId: string, loaded: LoadedDefinition & { result: { ok: true } }): Promise<TeamFail | null> {
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    const def = loaded.result.def
    const r = await this.resolveRepos(rec.entry.repoRoot, def, loaded.files)
    if (this.teams.get(teamId) !== rec) return fail('not_found')
    if (r.issues.length > 0) {
      rec.loaded = loaded
      rec.repoIssues = r.issues
      this.setTrust(rec, 'invalid')
      this.emit(teamId, ['team', 'needs'])
      return fail('invalid_definition', { issues: r.issues })
    }
    const approved = this.trust.approve(teamId, rec.entry.repoRoot, loaded, goalHashOf(def.goal))
    if ('error' in approved) return fail('io')
    rec.loaded = loaded
    rec.repoIssues = []
    rec.repos = r.repos
    rec.store.setDef(approved)
    this.setTrust(rec, 'trusted')
    if (rec.entry.name !== def.name) {
      rec.entry = { ...rec.entry, name: def.name }
      this.registry.put(rec.entry)
    }
    this.commit(teamId, dismissSystemCards(rec.store.rt, 'stateReset', 'trust'), ['needs'])
    // A pending hire proposed against another trusted hash can never be approved now (conflict stale): it leaves Te
    // necesita, cancelled with its own error (a hire's apply lands here too, for every other pending hire).
    this.dropStaleHires(teamId, rec, approved.sha256)
    const ctx = this.flowCtx(teamId)
    if (ctx) this.commit(teamId, reconcileAgents(rec.store.rt, ctx), ['agents'])
    // B7 (design 3.10): the routines of the newly trusted definition (a routine it dropped or turned off arms nothing).
    this.armRoutines(teamId, false)
    this.emit(teamId, ['team', 'needs', 'agents', 'routines'])
    this.poke()
    return null
  }

  /**
   * Resolves once the team has no active run: woken by the end of its last
   * one (the `ended` effect of the run-closed path, wakeIdle) or by a
   * teardown, else by one timeout after `ms`. Never polls.
   */
  private runsEnded(teamId: string, rec: TeamRecord, ms: number): Promise<void> {
    if (rec.store.rt.activeRuns.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        const left = (this.idleWaiters.get(teamId) ?? []).filter((w) => w !== done)
        if (left.length) this.idleWaiters.set(teamId, left)
        else this.idleWaiters.delete(teamId)
        resolve()
      }
      this.idleWaiters.set(teamId, [...(this.idleWaiters.get(teamId) ?? []), done])
      timer = setTimeout(done, ms)
      timer.unref?.()
    })
  }

  /** The team's last active run ended (or the service tore down): every runsEnded waiter resolves. */
  private wakeIdle(teamId: string): void {
    const list = this.idleWaiters.get(teamId)
    if (!list) return
    this.idleWaiters.delete(teamId)
    for (const w of list) w()
  }

  async removeTeam(teamId: string): Promise<TeamFail | null> {
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    this.removing.add(teamId)
    try {
      return await this.removeRecord(teamId, rec)
    } finally {
      this.removing.delete(teamId)
    }
  }

  private async removeRecord(teamId: string, rec: TeamRecord): Promise<TeamFail | null> {
    // B6: an integrate in flight finishes first (its land is bounded and aborting it midway is worse): the team stays whole.
    if (this.integratesOf(teamId) > 0) return fail('busy', { detail: 'integrate' })
    // Every run stops first (`deleted`) and its close is awaited (the supervisor forces it after STOP_GRACE_MS).
    // Its task worktrees are disowned once the folder moved (below).
    for (const run of [...rec.store.rt.activeRuns]) {
      if (run.state !== 'stopping') this.commit(teamId, requestStop(rec.store.rt, run.id, 'deleted', { now: this.clock() }, this.runPolicy), ['agents', 'run'], { runId: run.id })
    }
    await this.runsEnded(teamId, rec, REMOVE_WAIT_MS)
    for (const run of [...rec.store.rt.activeRuns]) this.supervisor.onDeadline(`run:${run.id}:stop`)
    if (rec.store.rt.activeRuns.length > 0) this.commit(teamId, interruptAll(rec.store.rt, 'shutdown', this.runPolicy, { now: this.clock() }), ['agents', 'run'])
    if (this.teams.get(teamId) !== rec) return fail('not_found')
    // Written now, so the folder that moves holds the last state (dispose only flushes: the store stays usable).
    rec.store.dispose()
    if (!this.registry.trash(teamId)) {
      // The folder did not move (EPERM, EBUSY): the team stays whole, entry, trust, watcher and a pending
      // definition check included, or re-adding the repo (same id) would pick the old state up. The user can try again.
      return fail('io', { detail: 'busy' })
    }
    // Only once the folder moved: until then an edit of the definition is still seen.
    rec.stopWatch?.()
    rec.stopWatch = null
    this.timer.clear(`defwatch:${teamId}`)
    this.routines.disarm(teamId)
    // B9: a takeover of the team ends with it (its console stays an ordinary console of the user).
    for (const a of rec.store.rt.agents) {
      this.timer.clear(takeoverBindKey(teamId, a.id))
      this.grantedAt.delete(`${teamId}|${a.id}`)
    }
    this.teams.delete(teamId)
    for (const w of [...this.takeoverWaits]) if (w.teamId === teamId) w.done()
    this.removedRecs.add(rec)
    if (this.newestRecs.get(teamId) === rec) this.newestRecs.delete(teamId)
    // Decision 63: its task worktrees lose their owner and read as ordinary orphans in Settings > Git (never deleted
    // here). After the trash: a team whose folder did not move keeps owning them. A tree a prep is still creating
    // lands after this; that prep sees the record removed and disowns it (RunStarter step 2).
    try {
      const n = this.taskWorktrees?.disown(teamId) ?? 0
      if (n > 0) this.deps.log(`remove ${teamId} disowned worktrees=${n}`)
    } catch (err) {
      this.deps.log(`remove ${teamId} disown failed ${(err as Error).name}`)
    }
    for (const k of [...this.discarded.keys()]) if (k.startsWith(`${teamId}|`)) this.discarded.delete(k)
    this.waitsOnConsoles.delete(teamId)
    // Its orphans' cards went with the folder; a team set up again on the repo starts without them.
    this.lingering.delete(teamId)
    this.reapedAtLoad.delete(teamId)
    // Its archive went to the trash too: a team set up again (same id) counts its own archived comments.
    for (const k of [...this.archivedCounts.keys()]) if (k.startsWith(`${teamId}|`)) this.archivedCounts.delete(k)
    this.trust.forget(rec.entry.repoRoot, teamId)
    this.loader.forget(rec.entry.repoRoot)
    this.emit(teamId, ['list'])
    return null
  }
}
