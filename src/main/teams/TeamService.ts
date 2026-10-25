import { spawn as nodeSpawn } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { appendFileSync, promises as fsp, readdirSync, readFileSync, rmSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import type { ChatMessage } from '@shared/chat-types'
import type { ClaudeAccountsState } from '@shared/claude-accounts'
import { CTL_TEAM_LOG_DEFAULT, type CtlErrorCode, type CtlResponse } from '@shared/ctl-protocol'
import { normalizeLabs } from '@shared/labs'
import { redactCredentials } from '@shared/redact'
import { DATA_SECRET_PATHS, effectiveProfile, isGrantable, roleWrites } from '@shared/teamArgv'
import { canonicalDefText, definitionIssues, normalizeDefText, parseDefinition, parseFrontmatter, UNC_PATH_RE } from '@shared/teamDefinition'
import { afterRunPolicy, candidatesOf, claudeAllLimited, planDispatch } from '@shared/teamDispatch'
import type { TeamNeedRow } from '@shared/teamNeeds'
import { systemText } from '@shared/teamPrompt'
import { parseTeamBlock } from '@shared/teamTools'
import { isPhoneTeamOp, type IntegratePreview, type IntegrateProgressEvt, type TaskSummary, type TeamChangedEvt, type TeamFail, type TeamOp, type TeamReply, type TeamRequest, type TeamRunAppendEvt, type TeamScope, type TeamTrustState } from '@shared/team-protocol'
import { suggestVerify, type VerifySuggestion } from '@shared/verifyDetect'
import {
  BOARD_COLUMNS,
  columnOf,
  LEAD_THREAD,
  LIMIT_FALLBACK_MS,
  ORPHAN_START_SLACK_MS,
  RETRY_DELAY_MS,
  REPO_MAIN,
  STOP_GRACE_MS,
  TASK_ID_RE,
  TEAM_LOG_TTL_MS,
  TEAM_LOGS_MAX_BYTES,
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
import type { AgentProvider, ConfigFile, PaneStatusEvt } from '@shared/types'
import { splitAppend } from '../chat/chatFrames'
import { mainT, type MainKey } from '../i18n'
import type { CtlTeamCaller } from '../cli/CtlTokens'
import type { CtlTeamsView } from '../cli/handlers'
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'
import { gitExitCode, type GitRunner } from '../git/gitExec'
import { linkNodeModules } from '../git/WorktreeService'
import { isSameOrInside, pathKey } from '../migration/pathUtil'
import { safeRemoveTree } from '../migration/safeRemove'
import { pidAlive, procStartTime as realProcStartTime, signalTree, treeKillSync } from '../proc/treeKill'
import type { PtySink } from '../pty/PtyManager'
import { cleanEnv, statusBinDirs } from '../pty/shellResolver'
import { TrustStore } from '../repoConfig/TrustStore'
import { resolveAgentCli, type ResolvedCli } from './agentCli'
import { Dispatcher, DISPATCH_KEY, type ManualRequest, type StepResult } from './Dispatcher'
import { dismissSystemCards, openSystemCard, reconcileAgents } from './flow/agents'
import { enqueue, phaseAgentOf, queueDecide, reconcileTasks } from './flow/dispatch'
import { admitRun, finishRun, interruptAll, markRunning, orphanCards, reapOnLoad, requestStop, restoreWake, runEndFactsOf, sessionCardVars, terminalOf, withRunDetail, type AdmitFacts, type RunEnd } from './flow/runs'
import { answerCard, cancelStaleHires, completeApproval, decideApproval, HIRE_STALE } from './flow/approvals'
import { archiveSweep, changedScopes, deliverComments } from './flow/tasks'
import { beginIntegrate, endIntegrate, integrateStep, interruptedIntegrates, worktreeRemoved, type IntegrateOutcome } from './flow/integrate'
import { applyBlock, applyTool } from './flow/tools'
import type { FlowCtx, FlowResult, TeamEffect, TeamToolCall } from './flow/types'
import { createVerifyRunner, integrateHolder, Integrator, type IntegrateResult, type VerifyRunner } from './Integrator'
import type { StreamFacts } from './parsers/types'
import { createTeamCtl, paramText, type TeamCtlPort, type TeamLiveRun, type TeamReadReply } from './teamCtl'
import { createClaudeStreamParser } from './parsers/claudeStream'
import { maskMessages } from './RunLog'
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
import { compareTaskOrder, LIVE_RUN_STATES, needsRowsOf, taskDetail, taskSummary, teamHeaderKey, waitingOf, type TaskViewCtx } from './views'

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
 * A desktop notice of a team (design 3.1 Notices, 6.3): one per new "Te necesita" row with `push` (an approval, a
 * card, the trust state, an auth or billing pause) and per integrate result. `title` and `body` come from the main
 * catalog (`teams.push.*`) with the trusted team name and the task id only, never agent text, redacted. `tag` is
 * `team:<teamId>:<rowId>` (B8's push tag); `urgent` for a row that blocks the team (rank 1).
 */
export interface TeamNotice { kind: 'team'; teamId: string; taskId?: string; tag: string; title: string; body: string; urgent: boolean; push: boolean }

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
  trustStore?: Pick<TrustStore, 'get' | 'setChecked' | 'delete'>
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

/** A refused reducer result as the op's reply (FlowError is a subset of TeamError). */
function flowFail(res: Extract<FlowResult<unknown>, { ok: false }>): TeamFail {
  const extra: Omit<TeamFail, 'ok' | 'error'> = {}
  if (res.reason) extra.reason = res.reason
  if (res.fields) extra.fields = res.fields
  if (res.defer) extra.defer = res.defer
  return fail(res.error, extra)
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
  /** B9 binds taken-over panes through it; until then a no-op consumer. */
  readonly sink: PtySink = { id: 'teams', onSpawn: () => undefined, onData: () => undefined, onExit: () => undefined }
  /**
   * B3: what `snaos team` reaches (CliService.attach({teams})): teamCtl checks
   * the params and the role, then reads and writes through this port (B7 adds
   * `note`; without it `team note` answers disabled).
   */
  readonly ctlView: CtlTeamsView = createTeamCtl({
    // Labs off (or frozen, disposed): every team.* answers disabled, like every Teams request.
    live: (who) => (this.live() ? this.ctlLive(who) : 'disabled'),
    read: (teamId, method, params, who) => (method === 'team.diff' || method === 'team.log' ? this.ctlGit(teamId, method, params, who) : this.ctlRead(teamId, method, params, who)),
    apply: (teamId, call, who) => this.ctlApply(teamId, call, who),
  })

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
  /** afterRunPolicy, with the run's request text carried into a task-less re-wake (every run end of this service). */
  private readonly runPolicy = (f: RunEndFacts): PolicyDecision => withRunDetail(afterRunPolicy(f), f.run, this.runDetail.get(f.run.id))
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
    if (!this.labOn || this.frozen) return
    await this.beginEnable()
  }

  /** CONFIG_SAVE: labs.teams off -> disable() (decision 57), on -> enable(); anything else pokes the dispatcher (a no-op while not live). */
  setConfig(cfg: ConfigFile | null): void {
    const on = normalizeLabs(cfg?.settings?.labs).teams
    if (on === this.labOn) {
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
      if (rec && !this.removedRecs.has(rec)) this.notify(teamId, rec, { rowId: `installWait:${taskId}`, taskId, key: 'teams.push.installWait', urgent: false })
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

  /** The only place the DeadlineTimer is disposed; a request after it answers `disabled`. */
  dispose(): void {
    this.disposed = true
    this.teardown()
    this.timer.dispose()
  }

  /** Pending deadlines (tests: zero with Labs off). */
  get pendingTimers(): number {
    return this.timer.size
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
    this.deps.log(`enabled teams=${loadedTeams.length}`)
    this.emit('', ['list'])
    // The rows the load itself opened (a reaped run's card, a repair's) against each team's baseline (design 3.1).
    for (const rec of loadedTeams) this.noticeNeeds(rec.entry.id)
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
    const { store, reaped, repaired } = TeamStore.load(this.storeDeps(e.id), e.id, trusted)
    // Reaped runs (R10: interrupted {crash}) join the runs ring; their pids are never signalled here.
    for (const r of reaped) store.recordRun(r)
    if (reaped.length) this.deps.log(`reaped ${e.id} runs=${reaped.length}`)
    const withPid = reaped.filter((r) => typeof r.pid === 'number' && r.startedAt !== undefined)
    if (withPid.length) this.reapedAtLoad.set(e.id, [...(this.reapedAtLoad.get(e.id) ?? []).filter((r) => !withPid.some((x) => x.id === r.id)), ...withPid])
    this.sweepRunFiles(e.id)
    const rec: TeamRecord = { entry: e, store, loaded, trust: 'missing', repoIssues: [], repos: new Map(), stopWatch: null }
    this.teams.set(e.id, rec)
    this.newestRecs.set(e.id, rec)
    await this.recompute(rec)
    if (epoch !== this.epoch) return rec
    // B5 notices (design 3.1): the baseline is the persisted `needsSeen`, never empty, so a restart re-notifies
    // nothing still pending (a card the reaper or the repair opened at load is new and notifies once). A team
    // written before B5 has none: what waits now is its baseline. A state.json the repair reset lost its baseline
    // with it: its only card is the repair's `stateReset`, which notifies once; the trust and pause rows stay seen.
    if (store.rt.needsSeen === undefined) {
      const reset = repaired.includes('state.json')
      store.setNeedsSeen(needsRowsOf(rec, trusted).filter((r) => !(reset && r.kind === 'card')).map((r) => r.id))
    }
    this.recheckApplying(e.id, rec)
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
    if (this.trust.snapshotState(e.id) === 'bad') {
      // Decision 34: an edited snapshot or a TrustStore entry that does not match it.
      this.commit(e.id, openSystemCard(store.rt, { why: 'stateReset', actions: ['dismiss'], vars: { what: 'trust' } }, { now: this.clock() }), ['needs', 'list'])
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
    for (const [id, rec] of this.teams) {
      rec.stopWatch?.()
      rec.stopWatch = null
      this.timer.clear(`defwatch:${id}`)
      for (const r of rec.store.rt.activeRuns) for (const k of ['max', 'conclude']) this.timer.clear(`run:${r.id}:${k}`)
      rec.store.dispose()
    }
    this.teams.clear()
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
      reap: (rt, recent) => reapOnLoad(rt, recent, this.runPolicy, { now: this.clock() }),
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
  async request(req: TeamRequest, origin: 'desktop' | 'phone'): Promise<TeamReply> {
    try {
      if (this.frozen && !this.quitting) this.thaw()
      const retry = this.labOn && !this.frozen && !this.quitting && !this.disposed
      if (retry && !this.enabled && !this.enabling) void this.beginEnable()
      if (this.enabling) await this.enabling
      if (!this.live()) return fail(retry && this.labOn && !this.frozen ? 'io' : 'disabled')
      if (origin === 'phone' && !isPhoneTeamOp(req.op)) return fail('bad_request')
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
    const out = rec.store.commit(res, scopes, hint)
    if (!out.ok) return out
    // The effects first: a run end joins the runs ring there (usageToday).
    this.runEffects(teamId, out.effects)
    if (header !== null && this.teams.get(teamId) === rec && teamHeaderKey(rec, this.trust.trusted(teamId), this.clock()) !== header) this.emit(teamId, ['team'], hint)
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
        case 'applyHire':
          this.applyHire(teamId, e.approvalId)
          break
        default:
          this.deps.log(`effect ${e.kind} ${teamId} not handled`)
      }
    }
  }

  /** A terminal run: the runs ring, the run memory dropped, the watched renderer told, logs pruned. */
  private runEnded(teamId: string, run: Run): void {
    const rec = this.teams.get(teamId)
    rec?.store.recordRun(run)
    this.runDetail.delete(run.id)
    this.consumedMark.delete(run.id)
    this.awakeAt.delete(run.id)
    this.runWrites.delete(run.id)
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

  /** True for a session id in any AgentState.sessions or active run: TranscriptLocator never picks its transcript for a console. */
  ownsSession(sessionId: string): boolean {
    if (!sessionId) return false
    for (const rec of this.teams.values()) {
      const rt = rec.store.rt
      if (rt.activeRuns.some((r) => r.sessionId === sessionId)) return true
      if (rt.agents.some((a) => Object.values(a.sessions).some((s) => s.sessionId === sessionId))) return true
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
    return { def: this.shownDef(rec), needs: needsRowsOf(rec, this.trust.trusted(teamId)), archived: (target) => this.archivedCount(teamId, target) }
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
    this.commit(teamId, markRunning(rec.store.rt, runId, f, ctx), ['agents', 'run'], { runId })
  }

  /** Line events never emit teamChanged (design 3.1); only the watched run gets its items, masked (maskRun). */
  private onAppend(runId: string, items: ChatMessage[], at: number): void {
    const w = this.watched
    if (!w || w.runId !== runId || !this.deps.sendRun) return
    const run = this.activeRun(w.teamId, runId)
    for (const chunk of splitAppend(teamPaneId(runId), this.maskRun(items))) this.sendRun({ teamId: w.teamId, runId, agentId: run?.agentId ?? '', items: chunk, lastLineAt: at })
  }

  /** Every line: the synthetic status is refreshed at most every SYNTHETIC_REFRESH_MS (decision 58, never a timer). */
  private onSignal(runId: string, at: number): void {
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
    const policy = this.runPolicy(runEndFactsOf(rec.store.rt, terminal, now, { claudeCanSwitch: this.claudeCanSwitch(acc), claudeSwitchedAt: switchedAt, unknownSession: end.facts.unknownSession }))
    const ctx = this.flowCtx(teamId)
    const fin = finishRun(rec.store.rt, runId, full, policy, { now, mask: this.maskTokens }, ctx ? { ctx, protect: this.protectPaths() } : undefined)
    // The Lead's reply and a lead escalation write the Lead thread (`lead`), a permission approval the needs.
    const scopes = [...new Set<TeamScope>(['agents', 'run', 'needs', ...(fin.ok ? changedScopes(rec.store.rt, fin.rt) : [])])]
    const res = this.commit(teamId, fin, scopes, { runId })
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
    if (res.rt !== rec.store.rt) this.commit(teamId, res, changedScopes(rec.store.rt, res.rt), run.taskId ? { taskId: run.taskId } : undefined)
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
   * RETRY_DELAY_MS (a user's "Ejecutar ahora" bypasses the cooldown and never does). Its agent sits out the plan
   * (planDispatch reads it as paused), so it never takes a cap slot the next request in line could use, and its
   * row reads `cooldown` until the backoff ends. A level the user discarded and that did not change is skipped
   * before each agent's minimum (skipOf), so the agent's next level gets its queue item.
   */
  private planOf(teamId: string, rt: Readonly<TeamRuntime>, def: TrustedDefinition, facts: DispatchFacts): DispatchPlan {
    const held = new Map<string, number>()
    const skip = this.skipOf(teamId, rt)
    // Each round holds at least one more agent (a held one is paused, never a start again): at most one per agent.
    for (;;) {
      const view: Readonly<TeamRuntime> = held.size === 0 ? rt : { ...rt, agents: rt.agents.map((a) => (held.has(a.id) ? { ...a, paused: true } : a)) }
      const plan = planDispatch(view, def.def, def.goalHash, facts, { skip })
      let more = false
      for (const req of plan.start) {
        const until = req.bypassCooldown ? undefined : this.backoffOf(teamId, req, facts.now)
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
    // The level R1 consumes (it clears task.next, and the agent's own mark of this mode): a prep failure without a card gives it back.
    const consumed = task ? task.next : agent.next && agent.next.mode === req.mode ? agent.next : undefined
    if (consumed && consumed.agentId === agent.id) this.consumedMark.set(runId, { ...consumed })
    const res = this.commit(teamId, admitRun(rt, req, a, ctx), ['agents', 'run', 'needs'], { runId })
    if (!res.ok) {
      if (lockKey) this.locks.release(lockKey, runId)
      this.runDetail.delete(runId)
      this.consumedMark.delete(runId)
      this.deps.log(`run of ${req.agentId} not admitted: ${res.error}`)
      return null
    }
    this.discarded.delete(`${teamId}|${req.agentId}|${req.sessionKey}`)
    this.deps.log(`run ${runId} admitted agent=${req.agentId} mode=${req.mode} reason=${req.reason}${req.taskId ? ` task=${req.taskId}` : ''} resume=${a.resume ? 'yes' : 'no'}`)
    return runId
  }

  /**
   * What a level the runtime derives looks like (a todo assignee, queued comments, an unread message, the Lead's
   * goal and triage): a discarded item comes back only once this moves.
   */
  private levelSig(rt: Readonly<TeamRuntime>, agentId: string, sessionKey: string, taskId: string | undefined): string {
    const agent = rt.agents.find((a) => a.id === agentId)
    if (taskId) {
      const t = rt.tasks.find((x) => x.id === taskId)
      const queued = (rt.comments[taskId] ?? []).filter((c) => c.forAgent === agentId && c.deliveredRunId === undefined)
      return `t|${t?.rev ?? 0}|${t?.state ?? ''}|${t?.phase ?? ''}|${queued.length}|${queued.at(-1)?.id ?? ''}|${t?.next?.since ?? ''}`
    }
    if (agent?.roleKind === 'lead') {
      const msgs = (rt.comments[LEAD_THREAD] ?? []).filter((c) => c.author.kind === 'user' && c.forAgent === agentId && c.deliveredRunId === undefined)
      const untriaged = rt.tasks.filter((t) => t.state === 'todo' && !t.assignee && t.triagedAt === undefined).length
      const smallPlans = rt.approvals.filter((x) => x.state === 'pending' && x.decider === 'lead' && !x.leadSeenRunId).length
      return `l|${rt.goalSeenHash ?? ''}|${msgs.length}|${msgs.at(-1)?.id ?? ''}|${untriaged}|${smallPlans}|${agent.next?.since ?? ''}`
    }
    return `f|${sessionKey}|${agent?.next?.since ?? ''}`
  }

  /**
   * The `agentId|sessionKey` levels of a team the user discarded and that did not change since (a changed one is
   * forgotten here): planDispatch leaves them out before each agent's minimum, so the agent's next level is its
   * candidate. Only while autonomy is off: with it on nothing waits in "Por despachar" and the level runs.
   */
  private skipOf(teamId: string, rt: Readonly<TeamRuntime>): Set<string> {
    const out = new Set<string>()
    if (rt.autoDispatch || this.discarded.size === 0) return out
    const prefix = `${teamId}|`
    for (const [key, d] of [...this.discarded]) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const bar = rest.indexOf('|')
      const agentId = rest.slice(0, bar)
      const sessionKey = rest.slice(bar + 1)
      if (d.sig === this.levelSig(rt, agentId, sessionKey, d.taskId)) out.add(rest)
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
        const d: { sig: string; taskId?: string } = { sig: this.levelSig(rec.store.rt, q.agentId, q.sessionKey, q.taskId) }
        if (q.taskId) d.taskId = q.taskId
        this.discarded.set(`${teamId}|${q.agentId}|${q.sessionKey}`, d)
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
   */
  async decide(teamId: string, approvalId: string, decision: 'approve' | 'reject', note: string | undefined, actor: Actor): Promise<TeamFail | null> {
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
    const res = decideApproval(rec.store.rt, actor, approvalId, decision, note, ctx, ahead !== undefined ? { ahead } : undefined)
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
    const rows = needsRowsOf(rec, this.trust.trusted(teamId))
    const ids = rows.map((r) => r.id)
    const seen = new Set(rec.store.rt.needsSeen ?? [])
    for (const row of rows) {
      if (!row.push || seen.has(row.id)) continue
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
   * `dirty_worktree {commits}`. A run, an integrate, a takeover or any other lock holder on the tree -> `busy`.
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
    const insp = await tw.inspect(task)
    const again = this.teams.get(teamId) === rec ? rec.store.rt.tasks.find((t) => t.id === taskId) : undefined
    if (!again || again.worktree?.path !== wt.path || (again.state !== 'done' && again.state !== 'cancelled')) return fail('conflict', { reason: 'stale' })
    if (insp.exists && insp.dirtyFiles > 0) return fail('dirty_worktree', { detail: 'files' })
    const repo = this.taskRepo(teamId, task)
    if ('ok' in repo) return repo
    if (await this.branchLoses(repo.repoRoot, wt.branch, wt.baseBranch, insp.tip)) return fail('dirty_worktree', { detail: 'commits' })
    if (this.teams.get(teamId) !== rec) return fail('not_found')
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

  /** One TeamNotice: the trusted team name and the task id only, from the main catalog, redacted. */
  private notify(teamId: string, rec: TeamRecord, o: { rowId: string; taskId?: string; key: MainKey; urgent: boolean }): void {
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
      push: true,
    }
    if (o.taskId) n.taskId = o.taskId
    try {
      this.deps.notice(n)
    } catch (err) {
      this.deps.log(`notice ${teamId} failed ${(err as Error).name}`)
    }
    this.deps.log(`notice ${teamId} ${o.key.slice('teams.push.'.length)} ${o.rowId}`)
  }

  runLive(runId: string): { lastLineAt?: number; ring: readonly ChatMessage[] | null; cutAt: number | null; live: boolean } {
    const out: { lastLineAt?: number; ring: readonly ChatMessage[] | null; cutAt: number | null; live: boolean } = {
      ring: this.supervisor.ring(runId),
      cutAt: this.supervisor.cutAt(runId),
      live: this.supervisor.isAlive(runId),
    }
    const at = this.supervisor.lastLineAt(runId)
    if (at !== undefined) out.lastLineAt = at
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
    this.emit(teamId, ['list', 'team', 'needs'])
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
    this.emit(teamId, ['team', 'needs', 'agents'])
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
    this.teams.delete(teamId)
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
