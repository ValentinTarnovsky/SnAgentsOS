// Adaptado de paperclipai/paperclip (MIT) - packages/adapters/claude-local/src/server/parse.ts
/**
 * The stream parser of a Claude team run (`claude -p --output-format
 * stream-json --verbose`, E10 SPIKE S1), after paperclip's incremental parser:
 * complete lines in, protocol state kept, the run read once at close.
 *
 *  - the first `result` is terminal; a later one (`result_index` > 0) only adds
 *    its `model_usage_since_last_result`;
 *  - failure is decided by `is_error`, never by `subtype` (decision 10: a bad
 *    model is `success` with `is_error: true`), and `error_max_turns` is no
 *    failure at all;
 *  - usage per decision 9: `sinceLastResult` summed over every result, else the
 *    delta of the cumulative `total_cost_usd` / `modelUsage`, else the
 *    streamed messages (`partial`, per `message.id`, field max);
 *  - the context window comes from `result.modelUsage[m].contextWindow`
 *    (decision 11);
 *  - auth, limit and unknown-session text is read from the failed result's own
 *    fields and stderr only (paperclip's two tiers), never from tool output.
 */
import { claudeFailure, failureFromRateLimit, type FailureInfo } from '@shared/failure'
import { claudeContextWindow, fitContextWindow } from '@shared/rateCard'
import type { RunUsage, TokenTotals } from '@shared/teams'
import { addTool, emptyDigest, fileOfToolInput, type TurnDigest } from '@shared/toolActivity'
import type { PaneContext } from '@shared/types'
import { DENIAL_INPUT_MAX, DENIALS_MAX, FINAL_TEXT_MAX, isBeatLine, isTeamCall, type Denial, type ParsedLine, type SessionBase, type StreamFacts, type StreamParser } from './types'

type Rec = Record<string, unknown>
/** failureFromRateLimit reads its fields with typeof checks, so any record may go in. */
type RateInfo = Parameters<typeof failureFromRateLimit>[0]

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** A finite count, 0 otherwise. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

const round = (v: number, digits: number): number => Math.round(v * 10 ** digits) / 10 ** digits
/** A model id worth keeping (the bad-model line says `<synthetic>`). */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,63}$/
const cleanModel = (v: unknown): string | undefined => (typeof v === 'string' && MODEL_RE.test(v) ? v : undefined)

/** At most `max` UTF-16 units from the start, never ending on half a surrogate pair. */
function head(text: string, max: number): string {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

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

/** Record types of the stream-json protocol; transcript-only records (`cost-state`, `summary`...) are not. */
const STREAM_TYPES: ReadonlySet<string> = new Set([
  'system', 'assistant', 'user', 'result', 'rate_limit_event', 'stream_event', 'tool_progress', 'tool_use_summary',
  'auth_status', 'keep_alive', 'control_request', 'control_response', 'control_cancel_request',
])
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_TURN_REASONS: ReadonlySet<string> = new Set(['max_turns', 'max_turns_exhausted', 'turn_limit', 'turn_limit_exhausted'])

// Paperclip parse.ts:13-20 verbatim: the login prompt the CLI prints (tier 1) and the token-failure markers
// (tier 2, a failed result's own fields only). Here tier 1 reads the failed result and stderr, never stdout.
const CLAUDE_LOGIN_PROMPT_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login)|login\s+required|requires\s+login|unauthorized|authentication\s+required|invalid\s+api\s+key[\s\S]{0,120}(?:\/login|claude\s+login|log\s+in))/i
const CLAUDE_AUTH_TOKEN_FAILURE_RE =
  /(?:authentication[_\s-](?:failed|error)|failed\s+to\s+authenticate|invalid\s+bearer\s+token|(?:invalid|expired|revoked)[\s\S]{0,40}(?:bearer|oauth|access)\s+token|(?:bearer|oauth|access)\s+token[\s\S]{0,40}(?:is\s+)?(?:invalid|expired|revoked))/i
// Paperclip parse.ts:353 (isClaudeUnknownSessionError).
const CLAUDE_UNKNOWN_SESSION_RE =
  /no conversation found with session id|unknown session|session .* not found|not a valid UUID|--resume requires a valid session|is not a UUID|does not match any session title/i

/** Trimmed non-empty lines of a text. */
function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

/** `errors[]` of a result: strings or `{message|error|code}` (paperclip extractClaudeErrorMessages). */
function errorMessages(r: Rec): string[] {
  const out: string[] = []
  for (const e of Array.isArray(r.errors) ? r.errors : []) {
    if (typeof e === 'string') {
      if (e.trim()) out.push(e.trim())
    } else if (isRec(e)) {
      const m = str(e.message) || str(e.error) || str(e.code)
      if (m.trim()) out.push(m.trim())
    }
  }
  return out
}

/** The failed result's own text: `result`, `error` and `errors[]` (paperclip collectClaudeTerminalText). */
function terminalText(r: Rec): string {
  return [str(r.result), str(r.error), ...errorMessages(r)].map((s) => s.trim()).filter(Boolean).join('\n')
}

function isMaxTurns(r: Rec): boolean {
  if (str(r.subtype).trim().toLowerCase() === 'error_max_turns') return true
  return [r.terminal_reason, r.stop_reason, r.stopReason, r.error_code, r.errorCode].some((v) => MAX_TURN_REASONS.has(str(v).trim().toLowerCase()))
}

/** A Denial's input: its top-level primitive fields, strings cut (a denied Write carries the whole file). */
function slimInput(v: unknown): Rec | undefined {
  if (!isRec(v)) return undefined
  const out: Rec = {}
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__') continue
    if (typeof val === 'string') out[k] = head(val, DENIAL_INPUT_MAX)
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val
  }
  return out
}

interface Tokens { i: number; o: number; cr: number; cw: number; rs: number }
const noTokens = (): Tokens => ({ i: 0, o: 0, cr: 0, cw: 0, rs: 0 })

/** `modelUsage` / `model_usage_since_last_result` summed: tokens, the cost of the entries that have one, and whether one lacked it. */
function modelTotals(v: unknown): { t: Tokens; usd: number; unknown: boolean; entries: number } {
  const t = noTokens()
  let usd = 0
  let unknown = false
  let entries = 0
  if (isRec(v)) {
    for (const e of Object.values(v)) {
      if (!isRec(e)) continue
      entries++
      t.i += num(e.inputTokens)
      t.o += num(e.outputTokens)
      t.cr += num(e.cacheReadInputTokens)
      t.cw += num(e.cacheCreationInputTokens)
      t.rs += num(e.thinkingTokens)
      const cost = finite(e.costUSD)
      if (cost === undefined) unknown = true
      else usd += Math.max(0, cost)
    }
  }
  return { t, usd, unknown, entries }
}

function totalsOf(t: Tokens): TokenTotals {
  const out: TokenTotals = { input: t.i, output: t.o, cacheRead: t.cr, cacheWrite: t.cw }
  if (t.rs > 0) out.reasoning = t.rs
  return out
}

function minus(t: Tokens, base: TokenTotals | undefined): Tokens {
  if (!base) return t
  return { i: Math.max(0, t.i - num(base.input)), o: Math.max(0, t.o - num(base.output)), cr: Math.max(0, t.cr - num(base.cacheRead)), cw: Math.max(0, t.cw - num(base.cacheWrite)), rs: Math.max(0, t.rs - num(base.reasoning)) }
}

function usageOf(t: Tokens, basis: RunUsage['basis'], usd: number | undefined, unknown: boolean, model: string | undefined): RunUsage {
  const u: RunUsage = { inputTokens: t.i, outputTokens: t.o, cacheReadTokens: t.cr, cacheWriteTokens: t.cw, estimated: true, basis }
  if (usd !== undefined) u.costUSD = round(Math.max(0, usd), 6)
  if (unknown || usd === undefined) u.unknownCost = true
  if (model) u.model = model
  if (t.rs > 0) u.reasoningTokens = t.rs
  return u
}

export function createClaudeStreamParser(): StreamParser {
  let sawProtocol = false
  let firstLineAt: number | undefined
  let sessionId: string | undefined
  let initModel: string | undefined
  let lastModel: string | undefined
  let first: Rec | null = null
  let last: Rec | null = null
  /** `model_usage_since_last_result` of every result, summed. */
  const since = { t: noTokens(), usd: 0, unknown: false, seen: false }
  /** Streamed usage per message id, field max (several lines repeat one message). */
  const messageUsage = new Map<string, Tokens>()
  let anonymous = 0
  /** The newest main-thread message of a real model (the context reads it). */
  let lastMain: { model: string; t: Tokens } | undefined
  const texts: string[] = []
  let textLength = 0
  /** The CLI's own error line (`error` on an assistant record, `is_api_error_message`). */
  let cliError: { code: string; text: string; status?: number } | undefined
  const denials: Denial[] = []
  let rateInfo: RateInfo
  let digest: TurnDigest = emptyDigest()
  let teamCalls = 0
  let fileEdits = 0
  const seenTools = new Set<string>()
  const pendingEdits = new Set<string>()

  function addDenial(d: Denial): void {
    const same = d.toolUseId ? denials.find((x) => x.toolUseId === d.toolUseId) : undefined
    if (same) {
      if (same.input === undefined && d.input !== undefined) same.input = d.input
      return
    }
    if (denials.length < DENIALS_MAX) denials.push(d)
  }

  function denialOf(tool: unknown, id: unknown, input: unknown): Denial | null {
    const name = str(tool).trim()
    if (!name) return null
    const d: Denial = { tool: head(name, 128) }
    const toolUseId = str(id).trim()
    if (toolUseId) d.toolUseId = toolUseId
    const slim = slimInput(input)
    if (slim) d.input = slim
    return d
  }

  function pushText(text: string): void {
    texts.push(text)
    textLength += text.length + 2
    while (textLength > FINAL_TEXT_MAX && texts.length > 1) textLength -= (texts.shift() as string).length + 2
  }

  function onToolUse(block: Rec): void {
    const name = str(block.name)
    if (!name) return
    const id = str(block.id)
    if (id) {
      if (seenTools.has(id)) return
      seenTools.add(id)
    }
    const input = block.input
    if (SHELL_TOOLS.has(name) && isRec(input) && isTeamCall(input.command)) {
      teamCalls++
      return
    }
    digest = addTool(digest, name, { provider: 'claude', file: fileOfToolInput(name, input) })
    if (id && EDIT_TOOLS.has(name)) pendingEdits.add(id)
  }

  function onAssistant(rec: Rec): void {
    const message = isRec(rec.message) ? rec.message : null
    if (!message) return
    const main = rec.parent_tool_use_id == null
    const model = cleanModel(message.model)
    const content = Array.isArray(message.content) ? message.content : []
    const usage = isRec(message.usage) ? message.usage : null
    if (usage) {
      const key = str(message.id) || `anonymous:${anonymous++}`
      const prev = messageUsage.get(key) ?? noTokens()
      const next: Tokens = {
        i: Math.max(prev.i, num(usage.input_tokens)),
        o: Math.max(prev.o, num(usage.output_tokens)),
        cr: Math.max(prev.cr, num(usage.cache_read_input_tokens)),
        cw: Math.max(prev.cw, num(usage.cache_creation_input_tokens)),
        rs: 0,
      }
      messageUsage.set(key, next)
      if (main && model) lastMain = { model, t: next }
    }
    if (main && model) lastModel = model
    const lineTexts: string[] = []
    for (const part of content) {
      if (!isRec(part)) continue
      if (part.type === 'text' && main) {
        const text = str(part.text)
        if (text) {
          pushText(text)
          lineTexts.push(text)
        }
      } else if (part.type === 'tool_use') {
        onToolUse(part)
      }
    }
    const code = str(rec.error).trim()
    if (code && main) {
      cliError = { code, text: lineTexts.join('\n') }
      const status = finite(rec.api_error_status)
      if (status !== undefined) cliError.status = status
    }
  }

  function onUser(rec: Rec): void {
    const message = isRec(rec.message) ? rec.message : null
    if (!message || !Array.isArray(message.content)) return
    for (const part of message.content) {
      if (!isRec(part) || part.type !== 'tool_result') continue
      if (pendingEdits.delete(str(part.tool_use_id)) && part.is_error !== true) fileEdits++
    }
  }

  function onResult(rec: Rec): void {
    const sinceLast = rec.model_usage_since_last_result
    if (isRec(sinceLast)) {
      const m = modelTotals(sinceLast)
      since.seen = true
      since.t.i += m.t.i
      since.t.o += m.t.o
      since.t.cr += m.t.cr
      since.t.cw += m.t.cw
      since.t.rs += m.t.rs
      since.usd += m.usd
      if (m.unknown) since.unknown = true
    }
    if (!first) {
      for (const d of Array.isArray(rec.permission_denials) ? rec.permission_denials : []) {
        if (!isRec(d)) continue
        const denial = denialOf(d.tool_name, d.tool_use_id, d.tool_input)
        if (denial) addDenial(denial)
      }
    }
  }

  function usageFor(base: SessionBase, model: string | undefined): RunUsage | undefined {
    if (since.seen) return usageOf(since.t, 'sinceLastResult', since.usd, since.unknown, model)
    if (last) {
      // A CLI without model_usage_since_last_result: the session totals minus the base (S7: cumulative per session).
      const cumulative = modelTotals(last.modelUsage)
      const total = finite(last.total_cost_usd)
      const hasBase = base.costTotal !== undefined || base.tokensTotal !== undefined
      const usd = total === undefined ? undefined : total - (finite(base.costTotal) ?? 0)
      const u = usageOf(minus(cumulative.t, base.tokensTotal), hasBase ? 'delta' : 'absolute', usd, false, model)
      if (base.baseStale || (hasBase && !base.tokensTotal)) u.approx = true
      return u
    }
    if (!messageUsage.size) return undefined
    const t = noTokens()
    for (const m of messageUsage.values()) {
      t.i += m.i
      t.o += m.o
      t.cr += m.cr
      t.cw += m.cw
    }
    return usageOf(t, 'partial', undefined, true, model)
  }

  function contextFor(): PaneContext | undefined {
    if (!lastMain) return undefined
    const used = lastMain.t.i + lastMain.t.cr + lastMain.t.cw
    if (used <= 0) return undefined
    const byModel = last && isRec(last.modelUsage) ? last.modelUsage : {}
    const entries = Object.values(byModel).filter(isRec)
    const own = Object.prototype.hasOwnProperty.call(byModel, lastMain.model) ? byModel[lastMain.model] : entries.length === 1 ? entries[0] : undefined
    const reported = isRec(own) ? num(own.contextWindow) : 0
    const window = reported > 0 ? reported : fitContextWindow(used, claudeContextWindow(lastMain.model))
    return { pct: round(Math.min(1, used / window), 4), used, window, exact: false }
  }

  return {
    line(raw: string, at: number): ParsedLine | null {
      const rec = parse(raw)
      if (!rec || typeof rec.type !== 'string') return null
      // A tool_progress heartbeat or a keep_alive: no new content (the run's silence goes on).
      const beat = isBeatLine(rec)
      // A keepalive or ping style line outside the stream types: alive, no content, no protocol (as in codexExec).
      if (!STREAM_TYPES.has(rec.type)) return beat ? { type: rec.type, beat: true } : null
      if (!sawProtocol) {
        sawProtocol = true
        firstLineAt = at
      }
      const out: ParsedLine = { type: rec.type }
      if (beat) out.beat = true
      const sid = str(rec.session_id).trim()
      if (sid) {
        sessionId = sid
        out.sessionId = sid
      }
      switch (rec.type) {
        case 'system':
          if (rec.subtype === 'init') initModel = cleanModel(rec.model) ?? initModel
          else if (rec.subtype === 'permission_denied') {
            const d = denialOf(rec.tool_name, rec.tool_use_id, undefined)
            if (d) {
              addDenial(d)
              if (d.toolUseId) pendingEdits.delete(d.toolUseId)
              out.denial = { ...d }
            }
          }
          break
        case 'assistant':
          onAssistant(rec)
          break
        case 'user':
          onUser(rec)
          break
        case 'rate_limit_event': {
          const info = isRec(rec.rate_limit_info) ? (rec.rate_limit_info as RateInfo) : undefined
          const f = failureFromRateLimit(info, at)
          rateInfo = f ? info : undefined
          if (f) out.rateLimit = f
          break
        }
        case 'result':
          onResult(rec)
          if (!first) {
            first = rec
            out.result = true
          }
          last = rec
          break
      }
      return out
    },

    facts(exit: { code: number | null }, stderrTail: string, base: SessionBase, now: number): StreamFacts {
      const r = first
      const stderr = linesOf(typeof stderrTail === 'string' ? stderrTail : '')
      const maxTurns = !!r && isMaxTurns(r)
      // Max turns comes with is_error true and exit 1, but it is progress, not an error (decision 10): it sets no
      // failure, and terminalOf (flow/runs.ts) reads `!facts.failure` as a clean end.
      const failed = (r ? r.is_error === true : true) && !maxTurns
      const isError = failed
      const ownText = r && failed ? terminalText(r) : ''
      const harnessCrash = !r && sawProtocol && (exit.code ?? 0) !== 0
      const unknownSession = failed && [...linesOf(ownText), ...stderr].some((l) => CLAUDE_UNKNOWN_SESSION_RE.test(l))
      const rateLimit = rateInfo ? (failureFromRateLimit(rateInfo, now) ?? undefined) : undefined

      let failure: FailureInfo | undefined
      if (!failed) failure = undefined
      else if (unknownSession) failure = { kind: 'request', code: 'unknown_session' }
      else if (r) {
        const code = str(r.error).trim() || cliError?.code
        failure = claudeFailure(code, ownText, now)
        // Without a code, the login prompt (result or stderr) or a token failure of the result's own fields is auth.
        if (failure.kind === 'unknown' && !code && ([...linesOf(ownText), ...stderr].some((l) => CLAUDE_LOGIN_PROMPT_RE.test(l)) || CLAUDE_AUTH_TOKEN_FAILURE_RE.test(ownText))) {
          failure = { kind: 'auth', code: 'login_required' }
        }
      } else if (stderr.some((l) => CLAUDE_LOGIN_PROMPT_RE.test(l))) {
        failure = { kind: 'auth', code: 'login_required' }
      } else if (cliError) {
        failure = claudeFailure(cliError.code, cliError.text, now)
      } else {
        const f = claudeFailure(undefined, stderr.join('\n'), now)
        failure = f.kind !== 'unknown' ? f : { kind: 'unknown', code: harnessCrash ? 'harness_crash' : 'no_result' }
      }
      // A refused rate_limit_event names the window and its reset: its until wins (decision 13).
      if (failure && rateLimit && (failure.kind === 'limit' || failure.kind === 'rateLimited' || failure.kind === 'unknown')) {
        const until = rateLimit.until ?? failure.until
        // An unknown failure's code is ours (no_result, harness_crash): the window names the limit better.
        const code = failure.kind === 'unknown' ? rateLimit.code : (failure.code ?? rateLimit.code)
        failure = { kind: 'limit' }
        if (until !== undefined) failure.until = until
        if (code) failure.code = code
      }

      const resultText = r ? str(r.result).trim() : ''
      const model = lastModel ?? initModel
      const facts: StreamFacts = {
        sawProtocol,
        resultSeen: !!r,
        isError,
        maxTurns,
        unknownSession,
        harnessCrash,
        finalText: tail(resultText || texts.join('\n\n').trim(), FINAL_TEXT_MAX),
        denials: denials.map((d) => ({ ...d })),
        digest: { ...digest, families: { ...digest.families }, files: [...digest.files] },
        toolCalls: digest.tools + teamCalls,
        teamCalls,
        fileEdits,
      }
      if (firstLineAt !== undefined) facts.firstLineAt = firstLineAt
      if (sessionId) facts.sessionId = sessionId
      if (model) facts.model = model
      if (r) {
        const subtype = str(r.subtype).trim()
        if (subtype) facts.subtype = subtype
        const reason = str(r.terminal_reason).trim()
        if (reason) facts.terminalReason = reason
      }
      const status = (r ? finite(r.api_error_status) : undefined) ?? cliError?.status
      if (status !== undefined) facts.apiErrorStatus = status
      const usage = usageFor(base, model)
      if (usage) facts.usage = usage
      if (last) {
        const cost = finite(last.total_cost_usd)
        if (cost !== undefined) facts.cumulativeCost = cost
        const cumulative = modelTotals(last.modelUsage)
        if (cumulative.entries > 0) facts.cumulativeTokens = totalsOf(cumulative.t)
      }
      const context = contextFor()
      if (context) facts.context = context
      if (rateLimit) facts.rateLimit = rateLimit
      if (failure) facts.failure = failure
      return facts
    },
  }
}
