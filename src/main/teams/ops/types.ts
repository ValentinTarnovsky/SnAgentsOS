/**
 * The Teams op table (app 2.7.0, E10 B, design 3.9, decision 55): one handler
 * per TeamOp, composed in ops/index.ts. Each milestone owns its own file and
 * adds the internals it needs to TeamInternals; the IPC register, the zod
 * union and the preload never change after B1.
 */
import type { ChatMessage } from '@shared/chat-types'
import type { ConfigFile, PaneSilence } from '@shared/types'
import type { IntegratePreview, RoutineView, TeamFail, TeamOp, TeamReply, TeamRequest, TeamScope, TeamTrustState } from '@shared/team-protocol'
import type { WsNoteMeta } from '@shared/ws-notes'
import type { Actor, CardAnswer, DefError, DeferInfo, ResolvedRepo, TeamDefinition, TeamTask, TrustedDefinition } from '@shared/teams'
import type { VerifySuggestion } from '@shared/verifyDetect'
import type { GitRunner } from '../../git/gitExec'
import type { FlowCtx, FlowResult } from '../flow/types'
import type { WorktreeLive } from '../TaskWorktrees'
import type { LoadedDefinition, LoadRes, TeamDefinitionLoader } from '../TeamDefinitionLoader'
import type { TeamIndexEntry, TeamRegistry } from '../TeamRegistry'
import type { TeamStore } from '../TeamStore'
import type { TeamTrust } from '../TeamTrust'

/** What TeamService keeps per registered team while enabled. */
export interface TeamRecord {
  entry: TeamIndexEntry
  store: TeamStore
  /** The latest load of `<repo>/.snagentsos/team/`. */
  loaded: LoadRes
  /** Decision 69: the cached trust state; the request gate and dispatch read it, never the disk. */
  trust: TeamTrustState
  /** When the cached state last left `trusted` (the need row's time). */
  trustSince?: number
  /** Extra repos of the loaded definition that do not resolve (decision 62): they make the trust `invalid`. */
  repoIssues: DefError[]
  /** Resolved extra repos of the trusted definition by repoId (decision 62); `main` is computed from the entry. */
  repos: Map<string, ResolvedRepo | DefError>
  /** Stops the definition watcher. */
  stopWatch: (() => void) | null
}

/** TeamService internals the op handlers use (each milestone adds what it needs). */
export interface TeamInternals {
  readonly registry: TeamRegistry
  readonly loader: TeamDefinitionLoader
  readonly trust: TeamTrust
  readonly git: GitRunner
  dataDir(): string
  config(): ConfigFile | null
  now(): number
  log(line: string): void
  /** Electron's shell.openPath: '' when it opened, else its error text. */
  openPath(path: string): Promise<string>
  /** The team id of a git main root (teamIdOf with the service's platform). */
  idOf(repoRoot: string): string
  /** The record of a registered and loaded team. */
  team(teamId: string): TeamRecord | null
  /** The trusted definition the runs read (decision 34), or null. */
  trusted(teamId: string): TrustedDefinition | null
  /** The definition to show: the trusted one, else the loaded one when it parses. */
  shownDef(rec: TeamRecord): TeamDefinition | null
  /** list and get: re-checks the definition stamp and reloads when it moved (design 3.2). */
  refreshTrust(teamId: string): Promise<void>
  /** Per-team chain of disk-writing user ops (design 3.0 item 5). */
  serial<T>(teamId: string, fn: () => Promise<T>): Promise<T>
  /** Reducer context; null while the team has no trusted definition. */
  flowCtx(teamId: string): FlowCtx | null
  /** store.commit plus the effects of the result. */
  commit<R>(teamId: string, res: FlowResult<R>, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): FlowResult<R>
  emit(teamId: string, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): void
  /** Extra repos of a definition resolved on disk (decision 62). */
  resolveRepos(mainRoot: string, def: TeamDefinition, files: readonly { rel: string; text: string }[]): Promise<{ repos: Map<string, ResolvedRepo | DefError>; issues: DefError[] }>
  /** Registers a new team for `repoRoot` and trusts exactly `loaded` (setupWrite, adopt). */
  addTeam(repoRoot: string, loaded: LoadedDefinition & { result: { ok: true } }, baseBranch: string): Promise<{ teamId: string } | TeamFail>
  /** Trusts exactly `loaded` for a registered team (trust op, B5 hire). */
  approveTrust(teamId: string, loaded: LoadedDefinition & { result: { ok: true } }): Promise<TeamFail | null>
  /** The remove op: stops what runs, flushes, trashes the folder, forgets the trust; a folder that does not move keeps all of it (`io`). */
  removeTeam(teamId: string): Promise<TeamFail | null>
  /** "Ejecutar ahora" through Dispatcher.manual (B4: a task run too); the prep runs as the `prepare` effect. */
  runManual(teamId: string, agentId: string, prompt?: string, taskId?: string): { runId: string } | TeamFail
  /** B4: the kickoff op (decision 43), the Lead now through Dispatcher.manual. */
  kickoff(teamId: string): { runId: string } | TeamFail
  /** B4: Despachar / Descartar of "Por despachar" (one item or `all`). */
  dispatchQueue(teamId: string, queueId: string, go: boolean, actor: Actor): { approved: string[]; dropped: string[] } | TeamFail
  /** B4: why each agent's (and each queue key's `agentId|sessionKey`) wanted run waits, from a dispatch dry run. */
  dispatchWaiting(teamId: string): { byAgent: Map<string, DeferInfo>; byKey: Map<string, DeferInfo> }
  /** B2: the supervisor's memory of a live run (null fields once it ended). B7: its silence while it runs (quiet, stalled). */
  runLive(runId: string): { lastLineAt?: number; silence?: PaneSilence; ring: readonly ChatMessage[] | null; cutAt: number | null; live: boolean }
  /** B2: the one run whose lines the renderer gets as `teams:runAppend` (decision 49); null stops it. */
  watchRun(teamId: string, runId: string | null): void
  /** B5 integration, sixth round: a run's chat rows as they leave main, credentials and live tokens of the app masked. */
  maskRun(items: readonly ChatMessage[]): ChatMessage[]
  /** B3: comments of a target (task id or `lead`) already moved to `archive/<target>.jsonl`. */
  archivedCount(teamId: string, target: string): number
  /** B5: decide an approval (the op checked the origin); null when it landed. */
  decide(teamId: string, approvalId: string, decision: 'approve' | 'reject', note: string | undefined, actor: Actor): Promise<TeamFail | null>
  /** B5: answer a card or run its system action (the op checked the origin); null when it landed. */
  answer(teamId: string, cardId: string, answer: CardAnswer, actor: Actor): Promise<TeamFail | null>
  /** B5: the level of a prep-failure card's run leaves its prep backoff (Reintentar; Retomar of the task the card blocks). */
  liftPrepBackoff(teamId: string, cardId: string): void
  /** B6: the Integrar preview of a task in review/integrating (read only). */
  integratePreview(teamId: string, taskId: string): Promise<{ preview: IntegratePreview } | TeamFail>
  /** B6: starts an Integrar of the tip the preview showed; its progress arrives as teams:integrateProgress. */
  integrate(teamId: string, taskId: string, expectTip: string, actor: Actor): Promise<{ integrationId: string } | TeamFail>
  /** B6: the worktree and branch of a done or cancelled task go (nothing uncommitted or unmerged is ever dropped). */
  removeTaskWorktree(teamId: string, taskId: string): Promise<TeamFail | null>
  /** B6 integration: what a repo root suggests to verify (design 2.11; root names and package.json script names only). */
  verifySuggestions(repoRoot: string): Promise<VerifySuggestion[]>
  /** B6 integration: reads the trees of these tasks now (TaskWorktrees.live, short timeouts, cached per tip). */
  readWorktreeLive(teamId: string, tasks: readonly TeamTask[]): Promise<void>
  /** B6 integration: a task tree as main last read it (no git, no disk), null when never read or without a tree. */
  worktreeLive(task: TeamTask): WorktreeLive | null
  /** B7: the routines of the definition the team runs (the trusted one, else the loaded one), with their next and last runs. */
  routineViews(teamId: string): RoutineView[]
  /** B7: "Correr ahora" of a routine: a wake runs now through Dispatcher.manual (`runId`), a task routine creates its task (`taskId`). */
  runRoutine(teamId: string, routineId: string): { runId?: string; taskId?: string } | TeamFail
  /** B7: the team notes (the daily summary among them), newest first. */
  teamNotes(teamId: string): Promise<{ notes: WsNoteMeta[] } | TeamFail>
  /** B7: one team note. */
  teamNote(teamId: string, noteId: string): Promise<{ title: string; text: string; updatedAt: number } | TeamFail>
  /** B7: runSilenceAck: the rest of the run's silence is ignored and its stalled card goes. */
  ackRunSilence(teamId: string, runId: string): TeamFail | null
}

export interface OpCtx {
  origin: 'desktop' | 'phone'
  actor: Actor & { kind: 'user' }
  svc: TeamInternals
  now: number
}

export type OpHandler<O extends TeamOp> = (req: Extract<TeamRequest, { op: O }>, ctx: OpCtx) => Promise<TeamReply<O>>
export type OpTable = { [O in TeamOp]: OpHandler<O> }

/** The answer of an op whose milestone has not landed yet. */
export function unsupported(): Promise<TeamFail> {
  return Promise.resolve({ ok: false, error: 'unsupported' })
}

/** A failed reply. */
export function fail(error: TeamFail['error'], extra: Omit<TeamFail, 'ok' | 'error'> = {}): TeamFail {
  return { ok: false, error, ...extra }
}
