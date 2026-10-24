// Adaptado de paperclipai/paperclip (MIT) - packages/adapters/codex-local/src/server/parse.ts
// Also adapts packages/adapters/codex-local/src/server/execute.ts (stderr noise and benign lines).
/**
 * The stream parser of a Codex team run (`codex exec --json`, E10 SPIKE S4),
 * after paperclip's JSONL parser:
 *
 *  - `thread.started` is the session (the only source of the thread id);
 *  - the last `agent_message` is the final text (earlier ones are commentary);
 *  - the last of `turn.completed`, `turn.failed` and `error` decides: a
 *    completed turn wins over a non-zero exit (our own linger kill), a failed
 *    one goes through codexExecFailure (decision 67);
 *  - `turn.completed.usage` is cumulative per thread (S4): the run's usage is
 *    the delta against `base.tokensTotal`, `cached_input_tokens` being part of
 *    `input_tokens`; there is no context window in exec --json (decision 11);
 *  - the structural harness-crash rule: a non-zero exit after protocol lines
 *    and before any terminal line.
 *
 * The failure classifier reads the protocol's error message and stderr only,
 * never tool output (`aggregated_output` is the agent's, not the CLI's).
 */
import { codexFailure, parseResetsAt, type FailureInfo } from '@shared/failure'
import { codexCost } from '@shared/rateCard'
import type { RunUsage, TokenTotals } from '@shared/teams'
import { addTool, emptyDigest, fileOfToolInput, type TurnDigest } from '@shared/toolActivity'
import { FINAL_TEXT_MAX, isTeamCall, type ParsedLine, type SessionBase, type StreamFacts, type StreamParser } from './types'

type Rec = Record<string, unknown>

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const round = (v: number, digits: number): number => Math.round(v * 10 ** digits) / 10 ** digits
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,63}$/
const cleanModel = (v: unknown): string | undefined => (typeof v === 'string' && MODEL_RE.test(v) ? v : undefined)

/** Paperclip parse.ts:61: a counter the usage may carry. */
const validCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** The last `max` UTF-16 units, never starting on half a surrogate pair. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text
  const out = text.slice(text.length - max)
  const code = out.charCodeAt(0)
  return code >= 0xdc00 && code <= 0xdfff ? out.slice(1) : out
}

function parse(raw: string): Rec | null {
  const line = raw.trim()
  if (!line.startsWith('{')) return null
  try {
    const v: unknown = JSON.parse(line)
    return isRec(v) ? v : null
  } catch {
    return null
  }
}

/** Event types of `codex exec --json`. */
const EXEC_TYPES: ReadonlySet<string> = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error'])
/** Item types that are tool calls (the digest counts each once). */
const TOOL_ITEMS: ReadonlySet<string> = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'collab_tool_call'])
const FAILED_STATUS_RE = /^(?:failed|errored|error|cancelled|declined)$/i

// Paperclip parse.ts:7-22 verbatim.
const CODEX_TRANSIENT_UPSTREAM_RE =
  /(?:we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand|temporary\s+errors|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|service\s+unavailable|try\s+again\s+later)/i
const CODEX_USAGE_LIMIT_RE =
  /you(?:'|’)ve hit your usage limit for .+\.\s+switch to another model now,\s+or try again at\s+([^.!\n]+)(?:[.!]|\n|$)/i
const CODEX_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit|model (?:is )?at capacity|at capacity for this model|capacity limit)/i
const CODEX_REFRESH_TOKEN_REUSED_RE =
  /(?:refresh[_\s-]?token[_\s-]?reused|refresh token (?:has )?already been used|token reuse detected)/i
const CODEX_REFRESH_TOKEN_EXPIRED_RE =
  /(?:refresh[_\s-]?token[_\s-]?expired|refresh token (?:has )?expired|expired refresh token)/i
const CODEX_REFRESH_TOKEN_INVALIDATED_RE =
  /(?:refresh[_\s-]?token[_\s-]?(?:invalidated|revoked|invalid)|refresh token (?:has been )?(?:invalidated|revoked|invalid)|invalid refresh token|missing bearer)/i
const CODEX_OAUTH_INVALID_GRANT_RE = /\binvalid_grant\b/i
const CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE =
  /(?:(?:oauth|refresh|access[_\s-]?token|bearer|credential).{0,80}(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b)|(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b).{0,80}(?:oauth|refresh|access[_\s-]?token|bearer|credential))/i
// Paperclip parse.ts:140 (isCodexUnknownSessionError).
const CODEX_UNKNOWN_SESSION_RE =
  /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|state db returned stale rollout path|no rollout found for thread id/i
// Paperclip execute.ts:121-122 and :154-157.
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i
const BENIGN_STDERR_RE = /^YOLO mode is enabled\b/i
/** The phrases of failure.ts CONTEXT_TEXT_RE (not exported there): a request that did not fit the context window. */
const CODEX_CONTEXT_RE = /prompt is too long|context[\s_-]*(?:window|length|limit)|maximum context|exceed\w*\s+(?:the\s+)?(?:model'?s?\s+)?context/i
const USAGE_LIMIT_WORDING_RE = /usage\s+limit/i
const RATE_LIMIT_WORDING_RE = /\b429\b|rate[-\s]?limit|too\s+many\s+requests/i

/** Trimmed non-empty lines of stderr without the rollout noise and the benign YOLO notice. */
function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !CODEX_ROLLOUT_NOISE_RE.test(l) && !BENIGN_STDERR_RE.test(l))
}

/** "try again at 11:31 PM" of a usage-limit message (paperclip extractCodexRetryNotBefore), a trailing `PST`-style abbreviation read as local time. */
function retryNotBefore(haystack: string, now: number): number | undefined {
  const m = CODEX_USAGE_LIMIT_RE.exec(haystack)
  if (!m) return undefined
  return parseResetsAt(m[1].trim().replace(/(\b[ap]\.?\s*m\.?)\s+[A-Z]{2,5}$/i, '$1'), now)
}

function failureOf(kind: FailureInfo['kind'], code: string, until?: number): FailureInfo {
  const f: FailureInfo = { kind, code }
  if (until !== undefined) f.until = until
  return f
}

/**
 * Decision 67: exec --json carries only error.message, so codexFailure(undefined, msg) gives only limit or unknown.
 * Evaluated on the error / turn.failed message and stderr ONLY (never tool output), in this order:
 * CODEX_REFRESH_TOKEN_{REUSED,EXPIRED,INVALIDATED}_RE, CODEX_OAUTH_INVALID_GRANT_RE, CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE -> auth;
 * CODEX_USAGE_LIMIT_RE, or CODEX_PROVIDER_QUOTA_RE with usage-limit wording -> limit (until: extractCodexRetryNotBefore,
 * else parseResetsAt); CODEX_PROVIDER_QUOTA_RE with capacity wording -> overloaded;
 * a local CODEX_CONTEXT_RE with the phrases of failure.ts CONTEXT_TEXT_RE (not exported there; never edit A2's file) -> context;
 * CODEX_TRANSIENT_UPSTREAM_RE -> rateLimited when it is 429 / rate-limit / too-many-requests wording, else overloaded;
 * otherwise codexFailure(undefined, message, now). Regexes verbatim from paperclip parse.ts:7-22 (header 1.1).
 * stderr loses its rollout noise and the YOLO notice first; never throws.
 */
export function codexExecFailure(message: string, stderrTail: string, now: number): FailureInfo {
  const msg = typeof message === 'string' ? message.trim() : ''
  const stderr = meaningfulLines(typeof stderrTail === 'string' ? stderrTail : '')
  const haystack = [...(msg ? msg.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []), ...stderr].join('\n')
  if (CODEX_REFRESH_TOKEN_REUSED_RE.test(haystack)) return failureOf('auth', 'refresh_token_reused')
  if (CODEX_REFRESH_TOKEN_EXPIRED_RE.test(haystack)) return failureOf('auth', 'refresh_token_expired')
  if (CODEX_REFRESH_TOKEN_INVALIDATED_RE.test(haystack) || CODEX_OAUTH_INVALID_GRANT_RE.test(haystack) || CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE.test(haystack)) {
    return failureOf('auth', 'refresh_token_invalidated')
  }
  const quota = CODEX_PROVIDER_QUOTA_RE.test(haystack)
  if (CODEX_USAGE_LIMIT_RE.test(haystack) || (quota && USAGE_LIMIT_WORDING_RE.test(haystack))) {
    return failureOf('limit', 'usage_limit', retryNotBefore(haystack, now) ?? parseResetsAt(haystack, now))
  }
  if (quota) return failureOf('overloaded', 'capacity')
  if (CODEX_CONTEXT_RE.test(haystack)) return failureOf('context', 'context_window')
  if (CODEX_TRANSIENT_UPSTREAM_RE.test(haystack)) {
    return RATE_LIMIT_WORDING_RE.test(haystack) ? failureOf('rateLimited', 'rate_limit') : failureOf('overloaded', 'transient')
  }
  return codexFailure(undefined, msg || stderr[0] || '', now)
}

/** `turn.completed.usage` as reported (paperclip's validation), or null when a counter is missing or junk. */
function usageOfEvent(v: unknown): TokenTotals | null {
  if (!isRec(v)) return null
  const cached = v.cached_input_tokens ?? 0
  if (!validCount(v.input_tokens) || !validCount(v.output_tokens) || !validCount(cached) || cached > v.input_tokens) return null
  const write = validCount(v.cache_write_input_tokens) ? v.cache_write_input_tokens : 0
  const reasoning = validCount(v.reasoning_output_tokens) ? v.reasoning_output_tokens : 0
  const out: TokenTotals = { input: v.input_tokens, output: v.output_tokens, cacheRead: cached, cacheWrite: write }
  if (reasoning > 0) out.reasoning = reasoning
  return out
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function createCodexExecParser(): StreamParser {
  let sawProtocol = false
  let firstLineAt: number | undefined
  let threadId: string | undefined
  /** The last terminal line: turn.completed, turn.failed or error. */
  let lastEnd: string | undefined
  /** A turn.completed or turn.failed was seen (ParsedLine.result, StreamFacts.resultSeen). */
  let flagged = false
  let errorMessage: string | undefined
  let tokens: TokenTotals | undefined
  let finalText = ''
  let digest: TurnDigest = emptyDigest()
  let teamCalls = 0
  let fileEdits = 0
  const seenItems = new Set<string>()
  const seenEdits = new Set<string>()

  function onItem(item: unknown, phase: 'started' | 'updated' | 'completed'): void {
    if (!isRec(item)) return
    const type = str(item.type)
    const id = str(item.id)
    if (type === 'agent_message') {
      const text = str(item.text)
      if (phase === 'completed' && text) finalText = text
      return
    }
    if (!TOOL_ITEMS.has(type)) return
    // Once per item: at its first line when it has an id, at its completion when it has none.
    if (id ? !seenItems.has(id) : phase === 'completed') {
      if (id) seenItems.add(id)
      if (type === 'command_execution' && isTeamCall(item.command)) teamCalls++
      else digest = addTool(digest, type, { provider: 'codex', file: fileOfToolInput(type, item) })
    }
    if (type === 'file_change' && phase === 'completed' && !FAILED_STATUS_RE.test(str(item.status)) && (!id || !seenEdits.has(id))) {
      if (id) seenEdits.add(id)
      fileEdits++
    }
  }

  function usageFor(base: SessionBase, model: string | undefined): RunUsage | undefined {
    if (!tokens) return undefined
    const b = base.tokensTotal
    const d = b
      ? { input: Math.max(0, tokens.input - count(b.input)), output: Math.max(0, tokens.output - count(b.output)), cacheRead: Math.max(0, tokens.cacheRead - count(b.cacheRead)), cacheWrite: Math.max(0, tokens.cacheWrite - count(b.cacheWrite)), reasoning: Math.max(0, (tokens.reasoning ?? 0) - count(b.reasoning)) }
      : { ...tokens, reasoning: tokens.reasoning ?? 0 }
    // cached_input_tokens is part of input_tokens (S4): the four counts of PaneUsage do not overlap.
    const cached = Math.min(d.cacheRead, d.input)
    const u: RunUsage = { inputTokens: d.input - cached, outputTokens: d.output, cacheReadTokens: cached, cacheWriteTokens: d.cacheWrite, estimated: true, basis: b ? 'delta' : 'absolute' }
    const cost = codexCost(model, { inputTokens: d.input, cachedInputTokens: cached, outputTokens: d.output })
    if (cost === undefined) u.unknownCost = true
    else u.costUSD = round(Math.max(0, cost), 6)
    if (model) u.model = model
    if (d.reasoning > 0) u.reasoningTokens = d.reasoning
    if (base.baseStale) u.approx = true
    return u
  }

  return {
    line(raw: string, at: number): ParsedLine | null {
      const rec = parse(raw)
      if (!rec || typeof rec.type !== 'string' || !EXEC_TYPES.has(rec.type)) return null
      if (!sawProtocol) {
        sawProtocol = true
        firstLineAt = at
      }
      const type = rec.type
      const out: ParsedLine = { type }
      switch (type) {
        case 'thread.started': {
          const id = str(rec.thread_id).trim()
          if (id) {
            threadId = id
            out.sessionId = id
          }
          break
        }
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          onItem(rec.item, type === 'item.started' ? 'started' : type === 'item.updated' ? 'updated' : 'completed')
          break
        case 'turn.completed':
        case 'turn.failed':
        case 'error': {
          lastEnd = type
          const reported = usageOfEvent(rec.usage)
          if (reported) tokens = reported
          const message = type === 'error' ? str(rec.message).trim() : type === 'turn.failed' && isRec(rec.error) ? str(rec.error.message).trim() : ''
          if (message) errorMessage = message
          if (type !== 'error' && !flagged) {
            flagged = true
            out.result = true
          }
          break
        }
      }
      return out
    },

    facts(exit: { code: number | null }, stderrTail: string, base: SessionBase, now: number): StreamFacts {
      const raw = typeof stderrTail === 'string' ? stderrTail : ''
      const failed = lastEnd !== 'turn.completed'
      const exitBad = (exit.code ?? 0) !== 0
      const harnessCrash = exitBad && sawProtocol && !lastEnd
      let failure: FailureInfo | undefined
      let unknownSession = false
      if (failed) {
        const classified = codexExecFailure(errorMessage ?? '', raw, now)
        // Paperclip 4.5: a resume whose thread is gone prints it before any thread.started; the raw stderr keeps the
        // rollout lines that say so. Auth and limits outrank it (a stale rollout notice must not hide a login failure).
        unknownSession = !threadId && exitBad && classified.kind !== 'auth' && classified.kind !== 'limit'
          && CODEX_UNKNOWN_SESSION_RE.test([errorMessage ?? '', raw].join('\n'))
        if (unknownSession) failure = { kind: 'request', code: 'unknown_session' }
        else if (lastEnd || classified.kind !== 'unknown') failure = classified
        else failure = { kind: 'unknown', code: harnessCrash ? 'harness_crash' : 'no_result' }
      }
      const model = cleanModel(base.model)
      const facts: StreamFacts = {
        sawProtocol,
        // Only a turn.completed / turn.failed: a retry notice (`error`) before a stop must not decide the stopped run.
        resultSeen: flagged,
        isError: failed,
        maxTurns: false,
        unknownSession,
        harnessCrash,
        finalText: tail(finalText.trim(), FINAL_TEXT_MAX),
        denials: [],
        digest: { ...digest, families: { ...digest.families }, files: [...digest.files] },
        toolCalls: digest.tools + teamCalls,
        teamCalls,
        fileEdits,
      }
      if (firstLineAt !== undefined) facts.firstLineAt = firstLineAt
      if (threadId) facts.sessionId = threadId
      if (model) facts.model = model
      if (lastEnd) facts.terminalReason = lastEnd
      const usage = usageFor(base, model)
      if (usage) facts.usage = usage
      if (tokens) facts.cumulativeTokens = { ...tokens }
      if (failure) facts.failure = failure
      return facts
    },
  }
}
