import { spawn as nodeSpawn } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { promises as fsp, readdirSync, readFileSync, rmSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import type { ChatMessage } from '@shared/chat-types'
import type { ClaudeAccountsState } from '@shared/claude-accounts'
import type { CtlErrorCode, CtlResponse } from '@shared/ctl-protocol'
import { normalizeLabs } from '@shared/labs'
import { effectiveProfile, roleWrites } from '@shared/teamArgv'
import { definitionIssues, parseFrontmatter, UNC_PATH_RE } from '@shared/teamDefinition'
import { afterRunPolicy, candidatesOf, claudeAllLimited, planDispatch } from '@shared/teamDispatch'
import { systemText } from '@shared/teamPrompt'
import { isPhoneTeamOp, type TaskSummary, type TeamChangedEvt, type TeamFail, type TeamOp, type TeamReply, type TeamRequest, type TeamRunAppendEvt, type TeamScope, type TeamTrustState } from '@shared/team-protocol'
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
import type { CtlTeamCaller } from '../cli/CtlTokens'
import type { CtlTeamsView } from '../cli/handlers'
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'
import type { GitRunner } from '../git/gitExec'
import { isSameOrInside, pathKey } from '../migration/pathUtil'
import { pidAlive, procStartTime as realProcStartTime, signalTree, treeKillSync } from '../proc/treeKill'
import type { PtySink } from '../pty/PtyManager'
import { cleanEnv, statusBinDirs } from '../pty/shellResolver'
import { TrustStore } from '../repoConfig/TrustStore'
import { resolveAgentCli, type ResolvedCli } from './agentCli'
import { Dispatcher, DISPATCH_KEY, type ManualRequest, type StepResult } from './Dispatcher'
import { dismissSystemCards, openSystemCard, reconcileAgents } from './flow/agents'
import { enqueue, phaseAgentOf, queueDecide, reconcileTasks } from './flow/dispatch'
import { admitRun, finishRun, interruptAll, markRunning, orphanCards, reapOnLoad, requestStop, restoreWake, runEndFactsOf, sessionCardVars, terminalOf, withRunDetail, type AdmitFacts, type RunEnd } from './flow/runs'
import { archiveSweep, changedScopes, deliverComments } from './flow/tasks'
import { applyTool } from './flow/tools'
import type { FlowCtx, FlowResult, TeamEffect, TeamToolCall } from './flow/types'
import { createTeamCtl, type TeamCtlPort, type TeamLiveRun } from './teamCtl'
import { createClaudeStreamParser } from './parsers/claudeStream'
import { RunStarter } from './RunStarter'
import { RunSupervisor } from './RunSupervisor'
import { TaskWorktrees, type TeamWorktreeApi } from './TaskWorktrees'
import { WriteLocks } from './WriteLocks'
import { currentBranch } from './ops/core'
import { OPS } from './ops/index'
import { fail, type OpHandler, type TeamInternals, type TeamRecord } from './ops/types'
import { TeamDefinitionLoader, type LoadedDefinition, type LoaderFs, type LoadRes } from './TeamDefinitionLoader'
import { resolveMainRoot, TeamRegistry, teamIdOf, type RegistryFs, type TeamIndexEntry } from './TeamRegistry'
import { TeamStore, type SyncFs, type TeamStoreDeps } from './TeamStore'
import { goalHashOf, TeamTrust } from './TeamTrust'
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
  /** ready() = CliService.running && shimExists() (decision 71). */
  cli?: { envForTeam(runId: string, teamId: string, agentId: string, roleKind: RoleKind): Record<string, string>; revokeTeam(runId: string): void; ready(): boolean }
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
    read: (teamId, method, params, who) => this.ctlRead(teamId, method, params, who),
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

  /** Decision 72: what a Claude run may never read or write, built from dataDir() (never the whole folder: worktrees live there). */
  private protectPaths(): { readDeny: string[]; writeDeny: string[] } {
    const d = this.deps.dataDir()
    const runtime = join(d, 'runtime.json')
    return { readDeny: [runtime], writeDeny: [join(d, 'teams'), join(d, 'trusted-teams.json'), runtime] }
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
   */
  shutdownSync(trigger?: string): void {
    if (this.frozen) return
    const n = this.stopAllRuns('shutdown')
    if (n > 0) this.deps.log(`shutdown ${trigger ?? 'quit'} interrupted runs=${n}`)
    this.frozen = true
    this.teardown()
  }

  /**
   * persistBeforeInstall (the NSIS setup closes the app without before-quit):
   * the same interrupt, kill, revoke and flush, but NOT frozen (a cancelled
   * wizard leaves the app running); every run defers `disabled` meanwhile.
   */
  prepareInstall(): void {
    this.installing = true
    if (!this.enabled) return
    this.stopAllRuns('shutdown')
    for (const rec of this.teams.values()) rec.store.flushSync()
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
    this.deps.log(`enabled teams=${loadedTeams.length}`)
    this.emit('', ['list'])
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
    const { store, reaped } = TeamStore.load(this.storeDeps(e.id), e.id, trusted)
    // Reaped runs (R10: interrupted {crash}) join the runs ring; their pids are never signalled here.
    for (const r of reaped) store.recordRun(r)
    if (reaped.length) this.deps.log(`reaped ${e.id} runs=${reaped.length}`)
    const withPid = reaped.filter((r) => typeof r.pid === 'number' && r.startedAt !== undefined)
    if (withPid.length) this.reapedAtLoad.set(e.id, [...(this.reapedAtLoad.get(e.id) ?? []).filter((r) => !withPid.some((x) => x.id === r.id)), ...withPid])
    this.sweepRunFiles(e.id)
    const rec: TeamRecord = { entry: e, store, loaded, trust: 'missing', repoIssues: [], repos: new Map(), stopWatch: null }
    this.teams.set(e.id, rec)
    await this.recompute(rec)
    if (epoch !== this.epoch) return rec
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

  /** Line events never emit teamChanged (design 3.1); only the watched run gets its items. */
  private onAppend(runId: string, items: ChatMessage[], at: number): void {
    const w = this.watched
    if (!w || w.runId !== runId || !this.deps.sendRun) return
    const run = this.activeRun(w.teamId, runId)
    for (const chunk of splitAppend(teamPaneId(runId), items)) this.sendRun({ teamId: w.teamId, runId, agentId: run?.agentId ?? '', items: chunk, lastLineAt: at })
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

  /** The `finishRun` commit of a closed run (its policy from the terminal copy), with the tree mark's verdict. */
  private finalizeClosed(runId: string, end: RunEnd & { stderrTail: string; logBytes?: number; logCut?: boolean }, treeMoved: boolean | undefined): void {
    const teamId = this.teamOfRun(runId)
    const rec = teamId ? this.teams.get(teamId) : undefined
    const run = rec?.store.rt.activeRuns.find((r) => r.id === runId)
    if (!teamId || !rec || !run || run.state === 'queued') {
      this.deps.log(`run ${runId} closed after its end`)
      return
    }
    const full: RunEnd = { at: end.at, exit: end.exit, facts: end.facts, teamWrites: this.runWrites.get(runId) ?? 0 }
    if (end.lastLineAt !== undefined) full.lastLineAt = end.lastLineAt
    if (treeMoved !== undefined) full.treeMoved = treeMoved
    const now = this.clock()
    const terminal = terminalOf(run, full)
    const acc = this.deps.accounts?.() ?? null
    const switchedAt = acc?.lastSwitch?.at
    const policy = this.runPolicy(runEndFactsOf(rec.store.rt, terminal, now, { claudeCanSwitch: this.claudeCanSwitch(acc), claudeSwitchedAt: switchedAt, unknownSession: end.facts.unknownSession }))
    const res = this.commit(teamId, finishRun(rec.store.rt, runId, full, policy, { now }), ['agents', 'run', 'needs'], { runId })
    if (res.ok && end.logBytes !== undefined) {
      // Log size of the ended run (Run.logBytes, logTruncated) patched into its ring copy.
      const ended: Run = { ...res.result.run, logBytes: end.logBytes }
      if (end.logCut) ended.logTruncated = true
      rec.store.recordRun(ended)
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
    this.commit(teamId, finishRun(rec.store.rt, runId, full, this.runPolicy(runEndFactsOf(rec.store.rt, terminal, now)), { now }), ['agents', 'run', 'needs'], { runId })
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
    // Every run stops first (`deleted`) and its close is awaited (the supervisor forces it after STOP_GRACE_MS).
    // Its task worktrees are disowned once the folder moved (below); B6 refuses while an integrate runs.
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
