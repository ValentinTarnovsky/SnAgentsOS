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
 * to stdin). B4: the task worktree is created at the task's first run when its
 * assignee's role writes (decision 24), a writer run's tree is marked
 * (decision 68), QA gets the diff stat and every task run the behind count of
 * its branch; the Codex block is applied at close by TeamService (B5).
 */
import { promises as fsp } from 'fs'
import { delimiter, dirname, join } from 'path'
import { CLI_ENV } from '@shared/brand'
import type { FailureInfo } from '@shared/failure'
import { roleWrites, teamArgv } from '@shared/teamArgv'
import { buildRunPrompt, runRulesOf, sysTextEn, systemText, type PhaseInput, type PromptComment, type PromptInput } from '@shared/teamPrompt'
import type { TeamScope } from '@shared/team-protocol'
import {
  LEAD_THREAD,
  type CardReason,
  type DefError,
  type ResolvedRepo,
  type RoleKind,
  type Run,
  type TeamCard,
  type TeamComment,
  type TeamRuntime,
  type TeamTask,
  type TreeMark,
  type TrustedDefinition,
} from '@shared/teams'
import type { AgentProvider } from '@shared/types'
import type { ResolvedCli } from './agentCli'
import type { SessionBase } from './parsers/types'
import { markStarting, prepFailed, setRunWorktree } from './flow/runs'
import type { FlowCtx, FlowResult } from './flow/types'
import type { RunSupervisor } from './RunSupervisor'
import type { TaskWorktrees } from './TaskWorktrees'
import type { TeamDefinitionLoader } from './TeamDefinitionLoader'
import type { TeamTrust } from './TeamTrust'
import { actorLabel, boardSummaryOf } from './views'

/** Newest comments of the target a fresh session gets as its handoff (decision 66; the prompt budget cuts further). */
const HANDOFF_COMMENTS = 20
/** Newest QA review comments a task run gets (stdin section 5; the budget cuts the oldest first). */
const QA_COMMENTS = 20

/** The text of an answered card as its asker reads it: the chosen options, the text, the confirmation. */
function answerText(c: TeamCard): string {
  const a = c.answer
  if (!a) return ''
  const parts: string[] = []
  if (a.choices && a.choices.length) parts.push(a.choices.map((i) => c.options[i] ?? `#${i}`).join(', '))
  if (a.text) parts.push(a.text)
  if (a.confirm !== undefined) parts.push(a.confirm ? 'Yes' : 'No')
  if (a.action) parts.push(`(${a.action})`)
  return parts.join('\n')
}

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
  /** B4: the task worktrees (null: no worktree service, a worktree task cannot start). */
  worktrees: Pick<TaskWorktrees, 'ensure' | 'behind' | 'qaStat' | 'mark' | 'disownTree'> | null
  /** B4: a writer run whose cwd was known only now (its new worktree) takes that tree's write lock; false while another holds it. */
  lock: (runId: string, cwd: string) => boolean
}

export interface PrepareIo {
  rt(): Readonly<TeamRuntime>
  /** CAS: the run is still `queued`. */
  check(runId: string): boolean
  commit<R>(res: FlowResult<R>, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): FlowResult<R>
  ctx(): FlowCtx | null
  /** The runs ring (handoff, decision 66). */
  recent(): readonly Run[]
  /** The manual request's text (it reaches only the run's stdin; never argv, a pty or runs.json; a task-less re-wake keeps it in WakeMark.detail, E10-FR-122). */
  detail?: string
  /** B4: the prep failed with this code and card (TeamService backs that agent and key off, a derived level would retry at once; a failure without a card restores the run's wake mark). */
  failed?: (code: string, card: CardReason | null) => void
  /** B4: the team this prep began with was removed (decision 63: its disown may have run before a tree this prep made landed). */
  removed?: () => boolean
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
      const res = io.commit(prepFailed(io.rt(), runId, failure, card, ctx), ['agents', 'run', 'needs'], { runId })
      if (res.ok) io.failed?.(code, card)
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

    // 2. The run cwd: the task's repo (decision 62) and, at the task's first run, its worktree when the assignee's
    // role writes (decision 24; own commit, CAS queued). A worktree made for a run stopped meanwhile stays: it is the
    // task's, and the next run adopts it by its owner. One made for a team removed meanwhile loses its owner here
    // (the removal's disown ran before it landed, decision 63). Then a writer run marks its tree (decision 68).
    const run0b = find()
    if (!run0b) return
    const task0 = run0b.taskId ? io.rt().tasks.find((t) => t.id === run0b.taskId) : undefined
    if (run0b.taskId && !task0) {
      fail('cwdMissing', 'cwdMissing')
      return
    }
    if (task0) {
      const repo = this.deps.repoOf(teamId, task0.repoId)
      if (!('repoRoot' in repo)) {
        fail('cwdMissing', 'cwdMissing')
        return
      }
      if (!task0.worktree && task0.isolation === 'worktree' && this.assigneeWrites(trusted, io.rt(), task0)) {
        const made = this.deps.worktrees ? await this.deps.worktrees.ensure({ id: teamId, gen: io.rt().gen }, repo, task0) : null
        if (!io.check(runId)) {
          if (made?.ok && io.removed?.() && this.deps.worktrees?.disownTree(made.worktree)) this.deps.log(`run ${runId} worktree ${made.worktree.slug} disowned: its team was removed`)
          return
        }
        if (!made || !made.ok) {
          this.deps.log(`run ${runId} worktree ${made ? made.error : 'unavailable'}`)
          fail('cwdMissing', 'cwdMissing')
          return
        }
        const ctx = io.ctx()
        if (!ctx) return
        const set = io.commit(setRunWorktree(io.rt(), runId, made.worktree, ctx), ['board', 'task', 'run', 'agents'], { runId, taskId: task0.id })
        if (!set.ok) {
          fail('cwdMissing', 'cwdMissing')
          return
        }
        this.deps.log(`run ${runId} worktree ${made.worktree.slug} for ${task0.id}`)
        if (run0b.profile !== 'readonly' && !this.deps.lock(runId, made.worktree.path)) {
          fail('treeBusy', null)
          return
        }
      }
    }
    const run = find()
    if (!run) return
    const cwdOk = await isDir(run.cwd)
    if (!io.check(runId)) return
    if (!cwdOk) {
      fail('cwdMissing', 'cwdMissing')
      return
    }
    let treeBefore: TreeMark | undefined
    if (run.profile !== 'readonly' && this.deps.worktrees) {
      treeBefore = (await this.deps.worktrees.mark(run.cwd)) ?? undefined
      if (!io.check(runId)) return
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

    // 7. The prompt from the CURRENT store (comments written during the prep are in); QA's diff stat and the
    // branch's behind count are read first (git, own timeouts), the store again after them.
    const pre = find() ?? run
    const preTask = pre.taskId ? io.rt().tasks.find((t) => t.id === pre.taskId) : undefined
    let qaStat = ''
    let behindMain: number | undefined
    if (preTask && this.deps.worktrees) {
      if (pre.mode === 'qa') qaStat = await this.deps.worktrees.qaStat(preTask, pre.cwd)
      if (preTask.worktree) behindMain = await this.deps.worktrees.behind(preTask)
      if (!io.check(runId)) return
    }
    const rt = io.rt()
    const now = find() ?? run
    const nowTask = now.taskId ? rt.tasks.find((t) => t.id === now.taskId) : undefined
    const target = now.taskId ?? (now.mode === 'lead' ? LEAD_THREAD : null)
    const thread = target ? rt.comments[target] ?? [] : []
    const queuedRaw = thread.filter((c) => c.forAgent === now.agentId && !c.deliveredRunId)
    const queued = queuedRaw.map(promptComment)
    const queuedIds = new Set(queuedRaw.map((c) => c.id))
    let handoff: { comments: PromptComment[]; lastSummary?: string } | undefined
    if (!now.resumed) {
      const prev = [...io.recent()].reverse().find((r) => r.agentId === now.agentId && r.sessionKey === now.sessionKey && r.id !== now.id)
      if (prev) {
        handoff = { comments: thread.slice(-HANDOFF_COMMENTS).map(promptComment) }
        if (prev.summary) handoff.lastSummary = prev.summary
      }
    }
    const board = now.mode === 'lead' ? boardSummaryOf(rt) : null
    const phase = this.phaseOf(now, nowTask, rt, { request: io.detail, board, qaStat })
    const where: PromptInput['where'] = { repoId: now.repoId, cwd: now.cwd }
    if (nowTask?.worktree) {
      where.branch = nowTask.worktree.branch
      where.base = nowTask.worktree.baseBranch
    }
    if (behindMain !== undefined) where.behindMain = behindMain
    // Decision 43: a Lead run on a goal its session has not seen (markStarting records it as seen), or a kickoff, reads
    // the goal even on a resumed session (section 1 is skipped there; the system text never carries the goal).
    const leadGoal: PromptInput['leadGoal'] = now.mode !== 'lead' ? undefined : rt.goalSeenHash !== trusted.goalHash ? 'changed' : now.trigger.reason === 'kickoff' ? 'kickoff' : undefined
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
      task: nowTask ? this.taskInput(rt, nowTask) : undefined,
      where,
      phase,
      // Review comments the run gets as new comments are not repeated in section 5.
      qaComments: nowTask ? thread.filter((c) => c.kind === 'review' && !queuedIds.has(c.id)).slice(-QA_COMMENTS).map(promptComment) : [],
      queued,
      unblocked: nowTask && now.trigger.reason === 'unblocked' ? this.unblockedOf(rt, nowTask) : [],
      answeredCards: rt.cards
        .filter((c) => c.state === 'answered' && !c.consumedRunId && c.from.kind === 'agent' && c.from.agentId === now.agentId && c.taskId === now.taskId)
        .map((c) => ({ id: c.id, question: c.question, answer: answerText(c) })),
      trigger: io.detail && now.mode !== 'free' ? { reason: now.trigger.reason, detail: io.detail } : { reason: now.trigger.reason },
      ...(leadGoal ? { leadGoal } : {}),
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
    const s: Parameters<typeof markStarting>[2] = { pid: started.pid, delivered: { comments: built.deliveredCommentIds, cards: built.consumedCardIds, approvals: built.seenApprovalIds } }
    // R2: the tasks the Lead's board listed to triage (the untriaged line is never cut) are triaged by this run.
    if (board && board.untriaged.length) s.triaged = [...board.untriaged]
    if (treeBefore) s.treeBefore = treeBefore
    io.commit(markStarting(io.rt(), runId, s, ctx), ['agents', 'run'], { runId })
  }

  /** The assignee's role writes (total or custom): only then a worktree task gets its tree (decision 24; research and readonly roles run in the repo root). */
  private assigneeWrites(trusted: TrustedDefinition, rt: Readonly<TeamRuntime>, task: TeamTask): boolean {
    const agent = task.assignee ? rt.agents.find((a) => a.id === task.assignee) : undefined
    const role = agent ? trusted.def.roles.find((r) => r.id === agent.roleId) : undefined
    return !!role && roleWrites(role.permission)
  }

  /** Stdin section 2: the task, its blockers (live or archived) and its parent. */
  private taskInput(rt: Readonly<TeamRuntime>, t: TeamTask): NonNullable<PromptInput['task']> {
    const byId = new Map(rt.tasks.map((x) => [x.id, x]))
    const blockedBy = t.blockedBy.map((id) => {
      const b = byId.get(id)
      return { id, title: b?.title ?? '', state: b?.state ?? rt.archivedTasks[id] ?? 'done' }
    })
    const out: NonNullable<PromptInput['task']> = { id: t.id, title: t.title, body: t.body, priority: t.priority, isolation: t.isolation, needsPlan: t.needsPlan, blockedBy }
    const parent = t.parentId ? byId.get(t.parentId) : undefined
    if (parent) out.parent = { id: parent.id, title: parent.title }
    return out
  }

  /** Stdin section 7: the blockers that are done now (an `unblocked` wake). */
  private unblockedOf(rt: Readonly<TeamRuntime>, t: TeamTask): Array<{ id: string; title: string }> {
    const byId = new Map(rt.tasks.map((x) => [x.id, x]))
    return t.blockedBy.filter((id) => (byId.get(id)?.state ?? rt.archivedTasks[id]) === 'done').map((id) => ({ id, title: byId.get(id)?.title ?? '' }))
  }

  /** Stdin section 4's phase input: the request of a free run, the Lead's board, the plan to write or to execute, QA's stat. */
  private phaseOf(run: Run, task: TeamTask | undefined, rt: Readonly<TeamRuntime>, x: { request?: string; board: ReturnType<typeof boardSummaryOf> | null; qaStat: string }): PhaseInput {
    switch (run.mode) {
      case 'free':
        return x.request ? { mode: 'free', request: x.request } : { mode: 'free' }
      case 'lead':
        return { mode: 'lead', board: x.board ?? boardSummaryOf(rt) }
      case 'qa':
        return { mode: 'qa', stat: x.qaStat, round: task?.review.round ?? 0, max: task?.review.max ?? 0 }
      case 'plan': {
        const p = task?.plan
        if (!p || p.status !== 'rejected') return { mode: 'plan' }
        const note = p.approvalId ? rt.approvals.find((a) => a.id === p.approvalId)?.note : undefined
        return { mode: 'plan', previousPlan: note ? { rev: p.rev, text: p.text, note } : { rev: p.rev, text: p.text } }
      }
      case 'exec': {
        const p = task?.plan
        return p && p.status === 'approved' ? { mode: 'exec', plan: { rev: p.rev, text: p.text } } : { mode: 'exec' }
      }
    }
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
