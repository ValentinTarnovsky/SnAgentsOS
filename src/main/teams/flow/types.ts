/**
 * Shapes of the Teams flow reducers (app 2.7.0, E10 B, design 3.4). The
 * reducers in this folder are pure (no Node imports, vm tested): they take a
 * runtime and return a new one (copy on write, never mutating the input) plus
 * the side effects TeamService runs after the commit. The runtime is main's
 * and never exported, which is why they live here and not in src/shared.
 */
import type { ConflictReason } from '@shared/team-protocol'
import type { DeferInfo, Run, StopReason, TaskField, TeamComment, TeamRuntime, TeamTask, TrustedDefinition } from '@shared/teams'

export type FlowError =
  | 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'user_owned' | 'cap' | 'busy' | 'cycle'
  | 'disabled' | 'untrusted' | 'no_session' | 'running' | 'stopping' | 'deferred' | 'unsupported'

/** A side effect a reducer asks for; TeamService.runEffects executes them after the commit (3.0 item 3). */
export type TeamEffect =
  | { kind: 'dispatch' }
  | { kind: 'prepare'; runId: string }
  | { kind: 'stopRun'; runId: string; reason: StopReason }
  | { kind: 'revokeRun'; runId: string }
  | { kind: 'releaseLocks'; runId: string }
  | { kind: 'deleteSystemFile'; runId: string }
  | { kind: 'archiveComments'; target: string; comments: TeamComment[] }
  | { kind: 'archiveTasks'; tasks: TeamTask[] }
  | { kind: 'applyHire'; approvalId: string }
  | { kind: 'startIntegrate'; taskId: string; attempt: number }
  | { kind: 'synthetic'; runId: string; on: boolean }
  | { kind: 'deadline'; key: string; at: number | null }
  /** B2: a run left `activeRuns` in this terminal form; TeamService puts it in the runs ring (runs.json). */
  | { kind: 'ended'; run: Run }
  /** B7: a `team.note` of a Codex block (the CLI path writes its note through the port): TeamService writes the team note file. */
  | { kind: 'teamNote'; runId: string; text: string; title?: string }

export type FlowResult<R = undefined> =
  | { ok: true; rt: TeamRuntime; effects: TeamEffect[]; result: R }
  | { ok: false; error: FlowError; reason?: ConflictReason; fields?: TaskField[]; current?: unknown; defer?: DeferInfo }

/** What every reducer may read besides the runtime: the clock, the trusted definition and the id minters. */
export interface FlowCtx {
  now: number
  def: TrustedDefinition
  newRunId(): string
  newSessionId(): string
}

/**
 * One `snaos team` call (CLI) or one action of a Codex `snaos-team` block. `method` is a TeamCtlMethod of
 * teamTools.ts (B2); spelled as its template here so this B1 file does not import a later module.
 */
export interface TeamToolCall {
  method: `team.${string}`
  params: Record<string, unknown>
  viaBlock?: boolean
}

/** The successful result of a reducer that changed nothing worth committing (TeamStore.commit skips it). */
export function unchanged(rt: TeamRuntime): FlowResult {
  return { ok: true, rt, effects: [], result: undefined }
}
