/**
 * The Teams op table (app 2.7.0, E10 B, design 3.9, decision 55): one handler
 * per TeamOp, composed in ops/index.ts. Each milestone owns its own file and
 * adds the internals it needs to TeamInternals; the IPC register, the zod
 * union and the preload never change after B1.
 */
import type { ChatMessage } from '@shared/chat-types'
import type { ConfigFile } from '@shared/types'
import type { TeamFail, TeamOp, TeamReply, TeamRequest, TeamScope, TeamTrustState } from '@shared/team-protocol'
import type { Actor, DefError, ResolvedRepo, TeamDefinition, TrustedDefinition } from '@shared/teams'
import type { GitRunner } from '../../git/gitExec'
import type { FlowCtx, FlowResult } from '../flow/types'
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
  /** B2: "Ejecutar ahora" through the manual gate and the admission; the prep runs as the `prepare` effect. */
  runManual(teamId: string, agentId: string, prompt?: string): { runId: string } | TeamFail
  /** B2: the supervisor's memory of a live run (null fields once it ended). */
  runLive(runId: string): { lastLineAt?: number; ring: readonly ChatMessage[] | null; cutAt: number | null; live: boolean }
  /** B2: the one run whose lines the renderer gets as `teams:runAppend` (decision 49); null stops it. */
  watchRun(teamId: string, runId: string | null): void
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
