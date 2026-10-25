/**
 * The async prep of a queued run (app 2.7.0, E10 B2, design 3.5 "Prep
 * sequence"): the effect `prepare` of an admission. Every await is followed
 * by a CAS on `run.state === 'queued'` (3.0 item 2): a stop or a Labs off
 * that landed meanwhile wins and nothing spawns. In order: the definition on
 * disk against the trusted hash (the authoritative trust check, decision 69),
 * the run cwd, the agent CLI, the CLI env with the team token (decision 71),
 * the argv, the Claude system file, the prompt from the CURRENT store, a late
 * session check, then the sync spawn and the `markStarting` commit.
 *
 * Instructions come only from the trusted snapshot (decision 34); nothing of
 * `team.md` enters the env, and no user text enters the argv (the prompt goes
 * to stdin). B4 adds the task worktree, the tree mark, the qa stat and the
 * behind count; the Codex block is applied at close by TeamService (B5).
 */
import { promises as fsp } from 'fs'
import { delimiter, dirname, join } from 'path'
import { CLI_ENV } from '@shared/brand'
import type { FailureInfo } from '@shared/failure'
import { teamArgv } from '@shared/teamArgv'
import { buildRunPrompt, runRulesOf, sysTextEn, systemText, type PhaseInput, type PromptComment } from '@shared/teamPrompt'
import type { TeamScope } from '@shared/team-protocol'
import {
  LEAD_THREAD,
  type CardReason,
  type DefError,
  type ResolvedRepo,
  type RoleKind,
  type Run,
  type TeamComment,
  type TeamRuntime,
} from '@shared/teams'
import type { AgentProvider } from '@shared/types'
import type { ResolvedCli } from './agentCli'
import type { SessionBase } from './parsers/types'
import { markStarting, prepFailed } from './flow/runs'
import type { FlowCtx, FlowResult } from './flow/types'
import type { RunSupervisor } from './RunSupervisor'
import type { TeamDefinitionLoader } from './TeamDefinitionLoader'
import type { TeamTrust } from './TeamTrust'
import { actorLabel, boardSummaryOf } from './views'

/** Newest comments of the target a fresh session gets as its handoff (decision 66; the prompt budget cuts further). */
const HANDOFF_COMMENTS = 20

export interface RunStarterDeps {
  teamDir: (teamId: string) => string
  loader: Pick<TeamDefinitionLoader, 'load'>
  trust: Pick<TeamTrust, 'trusted'>
  /** Decision 62. */
  repoOf: (teamId: string, repoId: string) => ResolvedRepo | DefError
  /** Decision 72, from dataDir(). */
  protect: () => { readDeny: string[]; writeDeny: string[] }
  cliEnv: { envForTeam(runId: string, teamId: string, agentId: string, roleKind: RoleKind): Record<string, string>; ready(): boolean }
  resolveCli: (p: AgentProvider, env: Record<string, string>) => ResolvedCli | null
  /** Pane holding the session (live ptys only). */
  sessionHolder: (provider: AgentProvider, sessionId: string) => string | null
  supervisor: Pick<RunSupervisor, 'start'>
  now: () => number
  log: (l: string) => void
  /** cleanEnv() of the app (SNAOS_* and the agent session vars stripped). */
  baseEnv: () => Record<string, string>
  platform: NodeJS.Platform
  /** Session ids a lingering orphan of decision 64 still holds. */
  lingering: (teamId: string) => ReadonlySet<string>
  /** Step 1 found the disk moved past the trusted hash: the cached trust state flips (decision 69). */
  untrusted: (teamId: string) => void
}

export interface PrepareIo {
  rt(): Readonly<TeamRuntime>
  /** CAS: the run is still `queued`. */
  check(runId: string): boolean
  commit<R>(res: FlowResult<R>, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): FlowResult<R>
  ctx(): FlowCtx | null
  /** The runs ring (handoff, decision 66). */
  recent(): readonly Run[]
  /** The manual request's text (never persisted; it reaches only the run's stdin). */
  detail?: string
}

function promptComment(c: TeamComment): PromptComment {
  return { id: c.id, author: actorLabel(c.author), kind: c.kind, text: c.sys ? sysTextEn(c.sys) : c.text, at: c.at }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export class RunStarter {
  constructor(private readonly deps: RunStarterDeps) {}

  /** Effect `prepare`: async steps, each followed by a CAS `run.state === 'queued'` through `check()`. */
  async prepare(teamId: string, runId: string, io: PrepareIo): Promise<void> {
    const find = (): Run | undefined => io.rt().activeRuns.find((r) => r.id === runId)
    const fail = (code: string, card: CardReason | null): void => {
      const ctx = io.ctx()
      if (!ctx || !io.check(runId)) return
      const failure: FailureInfo = { kind: 'request', code }
      this.deps.log(`run ${runId} prep failed ${code}`)
      io.commit(prepFailed(io.rt(), runId, failure, card, ctx), ['agents', 'run', 'needs'], { runId })
    }
    const run0 = find()
    if (!run0 || run0.state !== 'queued') return

    // 1. The definition on disk is still the trusted one (decision 69: the authoritative check, right before spawn).
    const main = this.deps.repoOf(teamId, 'main')
    const trusted = this.deps.trust.trusted(teamId)
    if (!trusted || !('repoRoot' in main)) {
      fail('untrusted', null)
      return
    }
    let sameDef = false
    try {
      const loaded = await this.deps.loader.load(main.repoRoot)
      sameDef = !('error' in loaded) && loaded.sha256 === trusted.sha256
    } catch {
      sameDef = false
    }
    if (!io.check(runId)) return
    if (!sameDef) {
      this.deps.untrusted(teamId)
      fail('untrusted', null)
      return
    }

    // 2. The run cwd (fixed at admission; B4 adds the task worktree here).
    const run = find()
    if (!run) return
    const cwdOk = await isDir(run.cwd)
    if (!io.check(runId)) return
    if (!cwdOk) {
      fail('cwdMissing', 'cwdMissing')
      return
    }

    // 3. The agent CLI (decision 12: never the app's own shims, .exe before .cmd).
    const base = this.deps.baseEnv()
    const cli = this.deps.resolveCli(run.provider, base)
    if (!cli) {
      fail('spawnFailed', 'spawnFailed')
      return
    }

    // 4. The control server and the team token (decision 71): no `snaos team` -> no run.
    if (!this.deps.cliEnv.ready()) {
      fail('cliOff', 'cliOff')
      return
    }
    const teamEnv = this.deps.cliEnv.envForTeam(runId, teamId, run.agentId, run.roleKind)
    const shim = teamEnv[CLI_ENV.cli]
    if (!shim) {
      fail('cliOff', 'cliOff')
      return
    }
    const env: Record<string, string> = { ...base, ...teamEnv }
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    env[pathKey] = dirname(shim) + delimiter + (env[pathKey] ?? '')

    // 5. The argv (allowlists and main-built paths only).
    const role = trusted.def.roles.find((r) => r.id === run.roleId)
    if (!role) {
      fail('untrusted', null)
      return
    }
    const task = run.taskId ? io.rt().tasks.find((t) => t.id === run.taskId) : undefined
    const grants = (task?.grants ?? []).filter((g) => g.roleId === run.roleId).map((g) => g.tool)
    const systemFile = run.provider === 'claude' ? join(this.deps.teamDir(teamId), 'runs', `${runId}.system.md`) : undefined
    let argv
    try {
      argv = teamArgv({
        provider: run.provider,
        profile: run.profile,
        allowedTools: role.permission === 'custom' ? role.allowedTools : undefined,
        grants,
        model: run.model,
        effort: run.effort,
        session: run.resumed && run.sessionId ? { kind: 'resume', sessionId: run.sessionId } : { kind: 'new', sessionId: run.sessionId },
        systemFile,
        cwd: run.cwd,
        protect: this.deps.protect(),
      })
    } catch (err) {
      this.deps.log(`run ${runId} argv failed ${(err as Error).name}`)
      fail('spawnFailed', 'spawnFailed')
      return
    }

    // 6. The Claude system file (deterministic text, deleted at finalize, swept at enable).
    const team = { name: trusted.def.name, goal: trusted.def.goal, rules: trusted.def.rules }
    const roleIn = { id: role.id, name: role.name, kind: role.kind, instructions: role.instructions }
    if (systemFile) {
      try {
        await fsp.mkdir(dirname(systemFile), { recursive: true })
        await fsp.writeFile(systemFile, systemText({ team, role: roleIn }), 'utf8')
      } catch (err) {
        if (!io.check(runId)) return
        this.deps.log(`run ${runId} system file failed ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
        fail('spawnFailed', 'spawnFailed')
        return
      }
      if (!io.check(runId)) return
    }

    // 7. The prompt from the CURRENT store (comments written during the prep are in).
    const rt = io.rt()
    const now = find() ?? run
    const target = now.taskId ?? (now.mode === 'lead' ? LEAD_THREAD : null)
    const thread = target ? rt.comments[target] ?? [] : []
    const queued = thread.filter((c) => c.forAgent === now.agentId && !c.deliveredRunId).map(promptComment)
    let handoff: { comments: PromptComment[]; lastSummary?: string } | undefined
    if (!now.resumed) {
      const prev = [...io.recent()].reverse().find((r) => r.agentId === now.agentId && r.sessionKey === now.sessionKey && r.id !== now.id)
      if (prev) {
        handoff = { comments: thread.slice(-HANDOFF_COMMENTS).map(promptComment) }
        if (prev.summary) handoff.lastSummary = prev.summary
      }
    }
    const phase: PhaseInput =
      now.mode === 'free' ? { mode: 'free', request: io.detail } : now.mode === 'lead' ? { mode: 'lead', board: boardSummaryOf(rt) } : now.mode === 'qa' ? { mode: 'qa', stat: '', round: task?.review.round ?? 0, max: task?.review.max ?? 0 } : { mode: now.mode }
    const built = buildRunPrompt({
      provider: now.provider,
      resumed: now.resumed,
      codexInstructions: argv.instructionsInStdin,
      reportsByBlock: argv.reportsByBlock,
      rules: runRulesOf(now.profile, now.mode),
      win32: this.deps.platform === 'win32',
      team,
      role: roleIn,
      handoff,
      task: task ? { id: task.id, title: task.title, body: task.body, priority: task.priority, isolation: task.isolation, needsPlan: task.needsPlan, blockedBy: [] } : undefined,
      where: { repoId: now.repoId, cwd: now.cwd },
      phase,
      qaComments: [],
      queued,
      unblocked: [],
      answeredCards: [],
      trigger: io.detail && now.mode !== 'free' ? { reason: now.trigger.reason, detail: io.detail } : { reason: now.trigger.reason },
    })

    // 8. Late session check: a console (or a lingering orphan) took the session during the prep.
    if (now.sessionId && now.resumed && (this.deps.sessionHolder(now.provider, now.sessionId) || this.deps.lingering(teamId).has(now.sessionId))) {
      fail('sessionBusy', null)
      return
    }

    // 9. Spawn, synchronously right after the last CAS.
    if (!io.check(runId)) return
    const ctx = io.ctx()
    if (!ctx) return
    const started = this.deps.supervisor.start({
      runId,
      teamId,
      agentId: now.agentId,
      provider: now.provider,
      cli,
      argv: argv.argv,
      cwd: now.cwd,
      env,
      stdin: built.stdin,
      logFile: join(this.deps.teamDir(teamId), 'runs', `${runId}.jsonl`),
      promptMeta: { mode: now.mode, trigger: now.trigger.reason },
      base: this.sessionBase(rt, now),
    })
    if (!started.ok) {
      fail('spawnFailed', 'spawnFailed')
      return
    }
    this.deps.log(`run ${runId} started pid=${started.pid} provider=${now.provider} mode=${now.mode} resumed=${now.resumed}`)
    io.commit(
      markStarting(io.rt(), runId, { pid: started.pid, delivered: { comments: built.deliveredCommentIds, cards: built.consumedCardIds, approvals: built.seenApprovalIds } }, ctx),
      ['agents', 'run'],
      { runId },
    )
  }

  /**
   * The cumulative bases the run's usage is a delta against (decision 9), only
   * for the session it resumes; the run's model always (a new Codex thread is
   * priced by codexCost from it too: exec --json names no model).
   */
  private sessionBase(rt: Readonly<TeamRuntime>, run: Run): SessionBase {
    const base: SessionBase = {}
    if (run.model) base.model = run.model
    const sess = rt.agents.find((a) => a.id === run.agentId)?.sessions[run.sessionKey]
    if (!run.resumed || !sess || sess.sessionId !== run.sessionId) return base
    if (sess.costTotal !== undefined) base.costTotal = sess.costTotal
    if (sess.tokensTotal) base.tokensTotal = { ...sess.tokensTotal }
    if (sess.baseStale) base.baseStale = true
    return base
  }
}
