/**
 * The stream parsers of a team run (app 2.7.0, E10 B2, design 3.5): one per
 * provider, fed with the complete stdout lines of `claude -p --output-format
 * stream-json --verbose` or `codex exec --json`, in order. `line()` answers
 * what RunSupervisor needs right away (the first protocol line, the first
 * terminal line, a denial, a refused limit); `facts()` reads the whole run at
 * close for finishRun, afterRunPolicy and classifyOutcome (decisions 9-11,
 * 13, 67, 68). Pure: no Node imports, no clock reads (every time comes in),
 * and auth or limit text is only read from the CLI's own result fields and
 * stderr, never from tool output (an agent that prints "401 unauthorized"
 * must not pause the team).
 */
import type { FailureInfo } from '@shared/failure'
import type { RunUsage, TokenTotals } from '@shared/teams'
import type { TurnDigest } from '@shared/toolActivity'
import type { PaneContext } from '@shared/types'

/**
 * A tool call the permission rules denied: Claude `system/permission_denied`
 * or `result.permission_denials[]` (Codex has none: its sandbox fails the
 * command instead). `input` is the call's input cut to its top-level
 * primitive fields, strings at DENIAL_INPUT_MAX (enough for grantPatternOf: a
 * denied Write must not keep its whole content in memory).
 */
export interface Denial { tool: string; toolUseId?: string; input?: unknown }

/**
 * What one stdout line says right away, or null when it is not a line of the
 * stream protocol (not JSON, no `type`, or a type the stream never prints,
 * such as a transcript's `cost-state`).
 * - `sessionId`: the session the line names (Claude `session_id`, Codex the
 *   `thread_id` of `thread.started`).
 * - `result`: the run's FIRST terminal line (Claude `result`, Codex
 *   `turn.completed` or `turn.failed`); later terminal lines (a Claude
 *   `result_index` > 0) only add usage and carry no flag. A Codex `error`
 *   event never carries it: codex also prints its retry notices
 *   ("Reconnecting... 1/5") as `error` mid-turn, and the linger kill this
 *   flag arms would end a turn that is still going.
 * - `denial`: a Claude `system/permission_denied` line.
 * - `rateLimit`: a refused `rate_limit_event`, read at the line's time.
 */
export interface ParsedLine { type: string; sessionId?: string; result?: true; denial?: Denial; rateLimit?: FailureInfo; items?: never }

export interface StreamFacts {
  /** line() returned a ParsedLine at least once; firstLineAt is the `at` of the first one. */
  sawProtocol: boolean; firstLineAt?: number
  /** Claude: the last `session_id` seen; Codex: the `thread.started` of THIS output (none on a failed resume). */
  sessionId?: string
  /** Claude: the last main-thread assistant model, else `system/init`'s; Codex: `base.model` (exec --json names none). */
  model?: string
  /**
   * A terminal turn line was seen: Claude `result`, Codex `turn.completed` / `turn.failed` (the lines that carry
   * ParsedLine.result). A Codex `error` event is not one: a retry notice mid-turn must not make a stopped run end
   * "from its result".
   */
  resultSeen: boolean
  /** The run ended in error: Claude the first result's `is_error`, except on max turns (decision 10: no failure); Codex the last of `turn.completed` / `turn.failed` / `error` is not `turn.completed`; true without a terminal line. */
  isError: boolean
  /** Claude `result.subtype` (never trusted alone: decision 10). */
  subtype?: string
  /** Claude `result.terminal_reason`; Codex the type of the last terminal line. */
  terminalReason?: string
  /** Claude `api_error_status` of the result, else of the CLI's own error line (404 for a bad model). */
  apiErrorStatus?: number
  /** Claude `error_max_turns` (decision 10): outcome `progress`, never a failure. */
  maxTurns: boolean
  /** The resumed session does not exist: Claude "No conversation found" in a failed result or stderr; Codex stderr, no `thread.started` and exit != 0. `failure` is then `request` / `unknown_session`. */
  unknownSession: boolean
  /** exit != 0 after protocol lines and before any terminal line (the CLI died mid-turn). */
  harnessCrash: boolean
  /** Claude result.result || joined assistant text; Codex last agent_message text. The tail, at most FINAL_TEXT_MAX characters. */
  finalText: string
  /** This run's own usage (decision 9), always "estimado"; undefined when the CLI reported none. */
  usage?: RunUsage
  /** Claude: the last result's `total_cost_usd`, cumulative per session (the next run's `base.costTotal`). */
  cumulativeCost?: number
  /**
   * The next run's `base.tokensTotal`, cumulative per session or thread: Claude the last result's `modelUsage`
   * summed (`input` without cache reads or writes); Codex the last `turn.completed.usage` as reported (`input`
   * includes `cacheRead`, S4). Only ever compared with a base of the same provider.
   */
  cumulativeTokens?: TokenTotals
  /** Claude only (decision 11): the last main-thread call over `result.modelUsage[m].contextWindow`, exact false. */
  context?: PaneContext
  /** Deduped by toolUseId, at most DENIALS_MAX. */
  denials: Denial[]
  /** The latest `rate_limit_event` when it refused (a later allowed one clears it), read at facts() time (`until` only while it is ahead). */
  rateLimit?: FailureInfo
  /** Set exactly when the run failed (finishRun ends it `failed`): undefined on success and on max turns. */
  failure?: FailureInfo
  /** Every tool call except the `snaos team` ones (TEAM_CALL_RE, decision 68): the line `snaos peek` prints. */
  digest: TurnDigest; toolCalls: number          // toolCalls = digest.tools + teamCalls
  teamCalls: number                                // TEAM_CALL_RE shell calls, out of digest
  /** Claude Edit/Write/MultiEdit/NotebookEdit tool uses and Codex file_change items that came back without an error (a denied or failed edit is no work). */
  fileEdits: number
}

/** The session before this run (the AgentSession fields) and the run's model (Codex is priced by codexCost from it). */
export interface SessionBase { costTotal?: number; tokensTotal?: TokenTotals; baseStale?: boolean; model?: string }

/** A shell tool call that is a `snaos team` call (Bash, PowerShell, Codex command_execution, including a powershell.exe -Command wrapper): counted in StreamFacts.teamCalls, never in digest (decision 68). */
export const TEAM_CALL_RE = /(?:^|[\s"'&;|(])(?:[^\s"'&;|()]*[\\/])?snaos(?:\.cmd)?["']?\s+team\s/i

/** True for a shell command (string or argv array) that calls `snaos team`. */
export function isTeamCall(command: unknown): boolean {
  const text = typeof command === 'string' ? command : Array.isArray(command) ? command.filter((c) => typeof c === 'string').join(' ') : ''
  return TEAM_CALL_RE.test(`${text} `)
}

/** Longest StreamFacts.finalText kept (its end: a Codex `snaos-team` block closes the last message). */
export const FINAL_TEXT_MAX = 256 * 1024
/** Denials kept per run. */
export const DENIALS_MAX = 64
/** Longest string field of a Denial.input. */
export const DENIAL_INPUT_MAX = 2048

export interface StreamParser {
  line(raw: string, at: number): ParsedLine | null
  facts(exit: { code: number | null }, stderrTail: string, base: SessionBase, now: number): StreamFacts
}
