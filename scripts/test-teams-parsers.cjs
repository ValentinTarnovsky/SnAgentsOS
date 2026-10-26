process.env.TZ = 'America/New_York'
// Team run stream parsers (app 2.7.0, E10 B2, design 3.5): the 13 spike
// fixtures of scripts/fixtures/teams (S1, S4, S7) and synthetic streams
// through createClaudeStreamParser and createCodexExecParser down to
// StreamFacts: is_error over subtype, the bad model 404, max turns as no
// failure, denials, sinceLastResult, delta, absolute and partial usage,
// result_index, the context window of modelUsage, rate limit until, the
// Codex cumulative delta, EPERM and readonly write denials, the cost-state
// transcript record not read as a run, teamCalls and fileEdits (decision
// 68), TEAM_CALL_RE, codexExecFailure (decision 67) on synthetic messages and
// never on tool output, unknown sessions, harness crashes and stderr noise;
// then decodeCodexExec rows. Same esbuild + vm harness as test-status.cjs:
// the bundle runs in an empty context (no require, no process), so the
// parsers are pure.
//
// Local times need a fixed zone: the TZ is set on line 1, before any Date use.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const fixtures = path.join(__dirname, 'fixtures', 'teams')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }

const entry = `
export * from './src/main/teams/parsers/types'
export { createClaudeStreamParser } from './src/main/teams/parsers/claudeStream'
export { createCodexExecParser, codexExecFailure } from './src/main/teams/parsers/codexExec'
export { decodeCodexExec } from './src/main/chat/decodeCodexExec'
export { familyOf } from './src/shared/toolActivity'
`
const code = buildSync({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
const mod = { exports: {} }
vm.runInNewContext(code, { module: mod, exports: mod.exports })
const M = mod.exports

/** A wall clock in the suite's local zone (America/New_York), month 1-based. */
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi)
/** Friday 2026-10-23 10:00 EDT (14:00Z), the spike day. */
const T0 = local(2026, 10, 23, 10, 0)
const STEP = 10

const fixture = name => fs.readFileSync(path.join(fixtures, `${name}.jsonl`), 'utf8').split('\n').filter(l => l.trim())
const FIXTURES = ['claude-badmodel', 'claude-denied', 'claude-maxturns', 'claude-resume', 'claude-simple', 'claude-tools', 'claude-transcript-cost-state', 'codex-pipe-eperm', 'codex-read', 'codex-readonly-write', 'codex-resume', 'codex-resume2', 'codex-simple']

/** Feeds raw lines (strings or objects) to a fresh parser; the lines arrive STEP ms apart from T0. */
function feed(provider, lines, { exit = 0, stderr = '', base = {}, now = T0 + 60_000 } = {}) {
  const p = provider === 'claude' ? M.createClaudeStreamParser() : M.createCodexExecParser()
  const parsed = lines.map((l, i) => p.line(typeof l === 'string' ? l : JSON.stringify(l), T0 + i * STEP))
  const facts = p.facts({ code: exit }, stderr, base, now)
  return { parsed, facts, again: () => p.facts({ code: exit }, stderr, base, now) }
}
const flagged = parsed => parsed.map((p, i) => (p && p.result ? i : -1)).filter(i => i >= 0)

// ---- Claude stream builders -------------------------------------------------------------------
const SID = '11111111-2222-4333-8444-555555555555'
const init = (model = 'claude-haiku-5-5') => ({ type: 'system', subtype: 'init', session_id: SID, model, cwd: 'C:\\repo', tools: ['Bash', 'Read'] })
const tu = (id, name, input) => ({ type: 'tool_use', id, name, input })
const asst = (content, o = {}) => ({
  type: 'assistant',
  message: { model: o.model || 'claude-haiku-5-5', id: o.mid || 'msg_1', type: 'message', role: 'assistant', content, ...(o.usage ? { usage: o.usage } : {}) },
  parent_tool_use_id: o.parent ?? null,
  session_id: SID,
  ...(o.error ? { error: o.error, is_api_error_message: true } : {}),
})
const toolResult = (id, isError, text = 'ok') => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, parent_tool_use_id: null, session_id: SID })
const mu = (i, o, cr, cw, costUSD) => ({ 'claude-haiku-5-5': { inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cw, ...(costUSD === undefined ? {} : { costUSD }), contextWindow: 1000000 } })
const result = (o = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: SID, total_cost_usd: 0.01,
  modelUsage: mu(10, 20, 30, 40, 0.01), model_usage_since_last_result: mu(10, 20, 30, 40, 0.01), permission_denials: [],
  terminal_reason: 'completed', result_index: 0, ...o,
})
const rateEvent = (status, resetsAt) => ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType: 'five_hour' }, session_id: SID })

// ---- Codex stream builders --------------------------------------------------------------------
const THREAD = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000'
const started = { type: 'thread.started', thread_id: THREAD }
const turn = { type: 'turn.started' }
const item = (phase, it) => ({ type: `item.${phase}`, item: it })
const completed = (input = 100, cached = 40, output = 7) => ({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 } })
const PS = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe"'

function sourceChecks() {
  const files = {
    types: 'src/main/teams/parsers/types.ts',
    claude: 'src/main/teams/parsers/claudeStream.ts',
    codex: 'src/main/teams/parsers/codexExec.ts',
    decode: 'src/main/chat/decodeCodexExec.ts',
  }
  const text = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(path.join(root, f), 'utf8')]))
  const first = k => text[k].split(/\r?\n/)[0]
  // Regexes, not the literal headers: test-docs.cjs treats a file holding the literal as adapted code.
  check(/^\/\/ Adaptado de paperclipai\/paperclip \(MIT\) - packages\/adapters\/claude-local\/src\/server\/parse\.ts$/.test(first('claude')), 'claudeStream.ts carries the paperclip header on line 1')
  check(/^\/\/ Adaptado de paperclipai\/paperclip \(MIT\) - packages\/adapters\/codex-local\/src\/server\/parse\.ts$/.test(first('codex')), 'codexExec.ts carries the paperclip header on line 1')
  check(/^\/\/ Adaptado de paperclipai\/paperclip \(MIT\) - packages\/adapters\/codex-local\/src\/ui\/parse-stdout\.ts$/.test(first('decode')), 'decodeCodexExec.ts carries the paperclip header on line 1')
  check(!/Adaptado de/.test(text.types), 'parsers/types.ts is original (no header)')
  for (const [k, src] of Object.entries(text)) {
    check(!/from '(?:node:|fs|path|os|child_process|electron)/.test(src) && !/\brequire\(/.test(src), `${files[k]} imports nothing from Node or Electron`)
    check(!/[\u2013\u2014]/.test(src), `${files[k]} has no en or em dash`)
  }
  check(!/[\u2013\u2014]/.test(fs.readFileSync(__filename, 'utf8')), 'this suite has no en or em dash')
  for (const name of FIXTURES) check(fs.existsSync(path.join(fixtures, `${name}.jsonl`)), `fixture ${name} exists`)
}

function teamCallChecks() {
  const yes = [
    'snaos team show',
    'snaos.cmd team tasks',
    '"C:\\Users\\u\\AppData\\Roaming\\snagentsos\\bin\\snaos.cmd" team task get t-1',
    '& "C:\\Program Files\\snagentsos\\snaos.cmd" team show',
    'powershell.exe -Command "snaos team task get t-1"',
    `${PS} -Command 'snaos team comment t-2 --body-file -'`,
    'cat plan.md | snaos team plan --file - --small',
    '/home/u/.local/share/snagentsos/bin/snaos team show',
    'SNAOS team show',
  ]
  for (const c of yes) check(M.TEAM_CALL_RE.test(c) && M.isTeamCall(c), `team call: ${c}`)
  check(M.isTeamCall('snaos team'), 'a bare "snaos team" is a team call (isTeamCall pads the end)')
  check(M.isTeamCall(['powershell.exe', '-Command', 'snaos team show']), 'an argv array is joined first')
  const no = ['snaos status', 'snaos ls', 'mysnaos team show', 'npm run snaos-team', 'echo snaosteam', 'snaos teams', 'git status', '']
  for (const c of no) check(!M.isTeamCall(c), `not a team call: ${JSON.stringify(c)}`)
  check(!M.isTeamCall(undefined) && !M.isTeamCall({ command: 'snaos team show' }) && !M.isTeamCall(42), 'junk is never a team call')
  check(M.FINAL_TEXT_MAX === 256 * 1024 && M.DENIALS_MAX === 64 && M.DENIAL_INPUT_MAX === 2048, 'parser caps')
}

function claudeFixtureChecks() {
  // claude-simple: one turn, one result, usage since the last result.
  const simple = feed('claude', fixture('claude-simple'))
  const f = simple.facts
  check(simple.parsed.every(p => p && p.type), 'every claude-simple line is a protocol line (hooks included)')
  same(flagged(simple.parsed), [7], 'only the result line is flagged terminal')
  check(simple.parsed.every(p => p.sessionId === 'b3a97cac-b7f6-4fc1-8714-caef9a2eb42e'), 'every line names the session')
  check(simple.parsed.every(p => !('items' in p) && !p.denial && !p.rateLimit), 'no items, denials or refusals on claude-simple lines (its rate limit is allowed)')
  check(f.sawProtocol && f.firstLineAt === T0 && f.resultSeen && !f.isError && !f.maxTurns && !f.unknownSession && !f.harnessCrash, 'claude-simple: a clean run')
  check(f.failure === undefined && f.rateLimit === undefined, 'claude-simple: no failure and no refusal')
  check(f.sessionId === 'b3a97cac-b7f6-4fc1-8714-caef9a2eb42e' && f.model === 'claude-haiku-5-5', 'claude-simple: session and model')
  check(f.subtype === 'success' && f.terminalReason === 'completed' && f.apiErrorStatus === undefined, 'claude-simple: subtype and terminal reason')
  check(f.finalText === 'OK', 'claude-simple: result.result is the final text')
  same(f.usage, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 17010, cacheWriteTokens: 18684, costUSD: 0.003909, model: 'claude-haiku-5-5', estimated: true, basis: 'sinceLastResult' }, 'claude-simple: usage from model_usage_since_last_result')
  check(f.cumulativeCost === 0.0039091, 'claude-simple: the cumulative session cost')
  same(f.cumulativeTokens, { input: 2, output: 4, cacheRead: 17010, cacheWrite: 18684 }, 'claude-simple: the cumulative session tokens')
  same(f.context, { pct: 0.0357, used: 35696, window: 1000000, exact: false }, 'claude-simple: context over modelUsage contextWindow (haiku 1M, decision 11)')
  same(f.digest, { tools: 0, families: {}, files: [] }, 'claude-simple: no tools')
  check(f.toolCalls === 0 && f.teamCalls === 0 && f.fileEdits === 0 && f.denials.length === 0, 'claude-simple: no calls, edits or denials')
  same(simple.again(), JSON.parse(JSON.stringify(f)), 'facts() is idempotent')

  // claude-resume: the same session resumed; since_last_result is this run only (decision 9).
  const base = { costTotal: f.cumulativeCost, tokensTotal: f.cumulativeTokens }
  const resume = feed('claude', fixture('claude-resume'), { base })
  same(resume.facts.usage, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 21181, cacheWriteTokens: 14565, costUSD: 0.003127, model: 'claude-haiku-5-5', estimated: true, basis: 'sinceLastResult' }, 'claude-resume: the run usage, not the session total')
  check(resume.facts.cumulativeCost === 0.007036110000000001, 'claude-resume: the session total moves on')
  same(resume.facts.cumulativeTokens, { input: 4, output: 8, cacheRead: 38191, cacheWrite: 33249 }, 'claude-resume: cumulative tokens of the session')
  // A CLI without model_usage_since_last_result: the delta of the cumulative totals.
  const bare = fixture('claude-resume').map(l => {
    const r = JSON.parse(l)
    if (r.type !== 'result') return l
    delete r.model_usage_since_last_result
    return JSON.stringify(r)
  })
  const delta = feed('claude', bare, { base })
  same(delta.facts.usage, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 21181, cacheWriteTokens: 14565, costUSD: 0.003127, model: 'claude-haiku-5-5', estimated: true, basis: 'delta' }, 'no since_last_result: total_cost_usd and modelUsage minus the base equal it')
  same(feed('claude', bare).facts.usage, { inputTokens: 4, outputTokens: 8, cacheReadTokens: 38191, cacheWriteTokens: 33249, costUSD: 0.007036, model: 'claude-haiku-5-5', estimated: true, basis: 'absolute' }, 'no base: absolute (a new session holds only this run)')
  check(feed('claude', bare, { base: { costTotal: 0.0039091 } }).facts.usage.approx === true, 'a cost base without a token base: the tokens are approximate')
  check(feed('claude', bare, { base: { ...base, baseStale: true } }).facts.usage.approx === true, 'a stale base (takeover): approx')
  check(feed('claude', bare, { base: { costTotal: 1 } }).facts.usage.costUSD === 0, 'a base above the total clamps the cost at 0')

  // claude-badmodel: subtype success, is_error true, exit 1 (S1).
  const bad = feed('claude', fixture('claude-badmodel'), { exit: 1 })
  const b = bad.facts
  check(b.resultSeen && b.isError && b.subtype === 'success', 'claude-badmodel: success subtype with is_error')
  same(b.failure, { kind: 'request', code: 'model_not_found' }, 'claude-badmodel: the CLI error line names model_not_found (decision 10: is_error decides)')
  check(b.apiErrorStatus === 404 && b.terminalReason === 'api_error', 'claude-badmodel: 404 and api_error')
  check(b.model === 'not-a-real-model-xyz', 'claude-badmodel: the init model (the <synthetic> one is not a model)')
  check(/issue with the selected model/.test(b.finalText), 'claude-badmodel: the result text')
  same(b.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0, model: 'not-a-real-model-xyz', estimated: true, basis: 'sinceLastResult' }, 'claude-badmodel: an empty since_last_result spent nothing')
  check(b.context === undefined && b.cumulativeTokens === undefined && b.cumulativeCost === 0, 'claude-badmodel: no context, no model entries, cost 0')
  check(!b.harnessCrash && !b.unknownSession && !b.maxTurns, 'claude-badmodel: not a crash, not an unknown session')

  // is_error over subtype, both ways.
  const flip = (lines, patch) => lines.map(l => {
    const r = JSON.parse(l)
    return r.type === 'result' ? JSON.stringify({ ...r, ...patch }) : l
  })
  const subtypeOnly = feed('claude', flip(fixture('claude-simple'), { subtype: 'error_during_execution' })).facts
  check(subtypeOnly.failure === undefined && !subtypeOnly.isError, 'an error subtype with is_error false is no failure')
  const errorOnly = feed('claude', flip(fixture('claude-simple'), { is_error: true }), { exit: 1 }).facts
  check(errorOnly.isError && errorOnly.failure && errorOnly.failure.kind === 'unknown' && errorOnly.subtype === 'success', 'is_error true with subtype success is a failure')
  check(feed('claude', flip(fixture('claude-badmodel'), { is_error: false })).facts.failure === undefined, 'the bad-model result with is_error false is no failure')

  // claude-maxturns: error_max_turns, is_error true, exit 1: progress, never a failure (decision 10).
  const max = feed('claude', fixture('claude-maxturns'), { exit: 1 }).facts
  check(max.maxTurns && !max.isError && max.failure === undefined, 'claude-maxturns: max turns is no failure and no error (terminalOf reads !facts.failure as a clean end)')
  check(max.resultSeen, 'claude-maxturns: the result was seen')
  check(max.subtype === 'error_max_turns' && max.terminalReason === 'max_turns', 'claude-maxturns: subtype and terminal reason')
  same(max.digest, { tools: 3, families: { read: 1, search: 2 }, files: ['cwd1/a.txt'], lastFamily: 'search' }, 'claude-maxturns: Read, Grep and Glob in the digest')
  check(max.finalText === '' && max.toolCalls === 3 && max.fileEdits === 0, 'claude-maxturns: no text, three calls, no edits')
  same(max.usage, { inputTokens: 2, outputTokens: 441, cacheReadTokens: 19669, cacheWriteTokens: 16058, costUSD: 0.003629, model: 'claude-haiku-5-5', estimated: true, basis: 'sinceLastResult' }, 'claude-maxturns: usage')
  same(max.context, { pct: 0.0357, used: 35729, window: 1000000, exact: false }, 'claude-maxturns: one message id over three lines counts once')

  // claude-denied: dontAsk denied a Write (S1).
  const denied = feed('claude', fixture('claude-denied'))
  same(denied.parsed[2].denial, { tool: 'Write', toolUseId: 'toolu_015GswqLmgECFkzBaCQZsSRu' }, 'the system/permission_denied line carries the denial')
  same(denied.facts.denials, [{ tool: 'Write', toolUseId: 'toolu_015GswqLmgECFkzBaCQZsSRu', input: { file_path: 'C:\\work\\cwd1\\b.txt', content: 'x' } }], 'claude-denied: one denial, the result adds its input')
  check(denied.facts.failure === undefined && !denied.facts.isError, 'claude-denied: a denial is no failure')
  check(denied.facts.fileEdits === 0, 'claude-denied: a denied Write is no file edit')
  same(denied.facts.digest, { tools: 1, families: { edit: 1 }, files: ['cwd1/b.txt'], lastFamily: 'edit' }, 'claude-denied: the attempted Write is in the digest')
  check(/denied by the permission mode/.test(denied.facts.finalText), 'claude-denied: final text')

  // claude-tools: Read and Grep, no team calls, no edits.
  const tools = feed('claude', fixture('claude-tools')).facts
  same(tools.digest, { tools: 2, families: { read: 1, search: 1 }, files: ['cwd1/a.txt'], lastFamily: 'search' }, 'claude-tools: digest')
  check(tools.teamCalls === 0 && tools.fileEdits === 0 && tools.toolCalls === 2 && tools.finalText === 'DONE', 'claude-tools: no team calls, no edits')

  // result_index: a second result only adds usage; the first one is terminal.
  const later = JSON.stringify({ ...JSON.parse(fixture('claude-simple')[7]), result_index: 1, is_error: true, result: 'LATER', total_cost_usd: 0.005, model_usage_since_last_result: mu(1, 2, 3, 4, 0.001) })
  const two = feed('claude', [...fixture('claude-simple'), later])
  same(flagged(two.parsed), [7], 'result_index 1 is not flagged terminal')
  check(!two.facts.isError && two.facts.failure === undefined && two.facts.finalText === 'OK', 'the first result decides')
  same(two.facts.usage, { inputTokens: 3, outputTokens: 6, cacheReadTokens: 17013, cacheWriteTokens: 18688, costUSD: 0.004909, model: 'claude-haiku-5-5', estimated: true, basis: 'sinceLastResult' }, 'since_last_result summed over every result')
  check(two.facts.cumulativeCost === 0.005, 'the cumulative cost of the last result')
  const noCost = feed('claude', [init(), result({ model_usage_since_last_result: { ...mu(1, 1, 1, 1, 0.002), other: { inputTokens: 1, outputTokens: 1 } } })]).facts.usage
  check(noCost.unknownCost === true && noCost.costUSD === 0.002 && noCost.inputTokens === 2, 'a model without costUSD: unknownCost, the known part kept')
}

function claudeSyntheticChecks() {
  // Team calls and edits (decision 68).
  const lines = [
    init(),
    asst([tu('t1', 'Bash', { command: 'snaos team show' })]),
    toolResult('t1', false),
    asst([tu('t2', 'PowerShell', { command: '& "C:\\Users\\u\\AppData\\Roaming\\snagentsos\\bin\\snaos.cmd" team task get t-1' })]),
    asst([tu('t3', 'Bash', { command: 'ls -la' })]),
    asst([tu('t4', 'Edit', { file_path: 'C:\\repo\\src\\a.ts', old_string: 'a', new_string: 'b' })]),
    toolResult('t4', false),
    asst([tu('t5', 'Write', { file_path: 'C:\\repo\\src\\b.ts', content: 'x' })]),
    toolResult('t5', true, 'File has not been read yet'),
    asst([tu('t6', 'Read', { file_path: 'C:\\repo\\src\\c.ts' }), { type: 'text', text: 'subagent words' }], { parent: 'toolu_task', mid: 'msg_sub' }),
    asst([tu('t4', 'Edit', { file_path: 'C:\\repo\\src\\a.ts', old_string: 'a', new_string: 'b' })]),
    asst([tu('t7', 'NotebookEdit', { notebook_path: 'C:\\repo\\n.ipynb' })]),
    result({ result: '' }),
  ]
  const team = feed('claude', lines).facts
  check(team.teamCalls === 2, 'Bash and PowerShell snaos team calls are team calls')
  same(team.digest, { tools: 5, families: { run: 1, edit: 2, read: 1, notebook: 1 }, files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'repo/n.ipynb'], lastFamily: 'notebook' }, 'the digest leaves the team calls out, counts a repeated tool_use once and keeps the subagent call')
  check(team.toolCalls === 7, 'toolCalls = digest.tools + teamCalls')
  check(team.fileEdits === 1, 'only the Edit that came back clean is a file edit (failed Write, NotebookEdit without result)')
  check(team.finalText === '', 'no main-thread text and an empty result: empty final text (subagent text is not the answer)')

  // No result: partial usage per message id, field max; harness crash.
  const partialLines = [
    init(),
    asst([{ type: 'text', text: 'Working' }], { mid: 'm1', usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }),
    asst([{ type: 'text', text: 'still' }], { mid: 'm1', usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }),
    asst([{ type: 'text', text: 'next' }], { mid: 'm2', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } }),
  ]
  const partial = feed('claude', partialLines, { exit: 1 }).facts
  check(!partial.resultSeen && partial.isError && partial.harnessCrash, 'no result after protocol lines and exit 1: harness crash')
  same(partial.failure, { kind: 'unknown', code: 'harness_crash' }, 'harness crash failure')
  same(partial.usage, { inputTokens: 4, outputTokens: 11, cacheReadTokens: 300, cacheWriteTokens: 10, unknownCost: true, model: 'claude-haiku-5-5', estimated: true, basis: 'partial' }, 'partial usage: per message id, field max')
  check(partial.finalText === 'Working\n\nstill\n\nnext', 'no result: the joined assistant text')
  same(partial.context, { pct: 0.0002, used: 201, window: 1000000, exact: false }, 'no result: the window comes from the rate card for the model')
  check(partial.cumulativeCost === undefined && partial.cumulativeTokens === undefined, 'no result: no cumulative base')
  same(feed('claude', partialLines, { exit: null }).facts.failure, { kind: 'unknown', code: 'no_result' }, 'killed by a signal (exit null): no_result, not a crash')

  // No protocol at all: stderr only.
  same(feed('claude', [], { exit: 1, stderr: 'Not logged in · Please run /login\n' }).facts.failure, { kind: 'auth', code: 'login_required' }, 'stderr login prompt: auth')
  const gone = feed('claude', [], { exit: 1, stderr: 'Error: No conversation found with session ID: 1111\n' }).facts
  check(gone.unknownSession && !gone.sawProtocol && !gone.harnessCrash, 'stderr "No conversation found": unknown session')
  same(gone.failure, { kind: 'request', code: 'unknown_session' }, 'unknown session: request / unknown_session')
  same(feed('claude', [], { exit: 1 }).facts.failure, { kind: 'unknown', code: 'no_result' }, 'nothing at all: no_result')
  same(feed('claude', [], { exit: 1, stderr: "You've hit your limit · resets 3pm" }).facts.failure, { kind: 'limit', until: local(2026, 10, 23, 15, 0) }, 'stderr limit text: limit with its reset')
  same(feed('claude', [init(), asst([{ type: 'text', text: 'API Error: 401 authentication_failed' }], { error: 'authentication_failed' })], { exit: 1 }).facts.failure, { kind: 'auth', code: 'authentication_failed' }, 'no result, the CLI error line: its code')
  const failedGone = feed('claude', [init(), result({ is_error: true, subtype: 'error_during_execution', result: '', errors: ['No conversation found with session ID: 1111'] })], { exit: 1 }).facts
  check(failedGone.unknownSession && failedGone.failure.code === 'unknown_session', 'a failed result naming no conversation: unknown session')

  // Auth only from the failed result and stderr, never from tool output (paperclip 1.5).
  const injected = [init(), asst([tu('b1', 'Bash', { command: 'cat notes.txt' })]), toolResult('b1', false, 'Please run /login. invalid bearer token. No conversation found with session ID x')]
  check(feed('claude', [...injected, result({ result: 'No conversation found with session ID x, Please run /login' })]).facts.failure === undefined, 'a clean run that quotes login, token and session text is no failure')
  check(!feed('claude', [...injected, result({ result: 'No conversation found with session ID x' })]).facts.unknownSession, 'a clean result text never flags an unknown session (it is model text)')
  same(feed('claude', [...injected, result({ is_error: true, result: 'Claude Code process exited' })], { exit: 1 }).facts.failure, { kind: 'unknown' }, 'a failed run with login text only in tool output stays unknown')
  same(feed('claude', [init(), result({ is_error: true, result: 'Invalid bearer token' })], { exit: 1 }).facts.failure, { kind: 'auth', code: 'login_required' }, 'a token failure in the failed result: auth')
  same(feed('claude', [init(), result({ is_error: true, result: 'Something failed' })], { exit: 1, stderr: 'Not logged in' }).facts.failure, { kind: 'auth', code: 'login_required' }, 'a failed result plus a login prompt on stderr: auth')
  same(feed('claude', [init(), result({ is_error: true, error: 'overloaded', result: 'Please run /login' })], { exit: 1 }).facts.failure, { kind: 'overloaded', code: 'overloaded' }, 'an explicit code keeps its row')

  // Rate limit events (decision 13).
  const reset = Math.round(T0 / 1000) + 3600
  const limited = feed('claude', [
    init(),
    rateEvent('rejected', reset),
    asst([{ type: 'text', text: "You've hit your limit · resets 3pm (America/New_York)" }], { error: 'rate_limit', model: '<synthetic>' }),
    result({ is_error: true, result: "You've hit your limit · resets 3pm (America/New_York)", terminal_reason: 'api_error', model_usage_since_last_result: {} }),
  ], { exit: 1 })
  same(limited.parsed[1].rateLimit, { kind: 'limit', until: reset * 1000, code: 'five_hour' }, 'a refused rate_limit_event is reported on its line')
  same(limited.facts.rateLimit, { kind: 'limit', until: reset * 1000, code: 'five_hour' }, 'facts carry the refusal')
  same(limited.facts.failure, { kind: 'limit', until: reset * 1000, code: 'rate_limit' }, 'the event until wins over the text (3pm)')
  const pastLines = [init(), rateEvent('rejected', Math.round(T0 / 1000) - 60), result({ is_error: true, result: "You've hit your limit · resets 3pm (America/New_York)", error: 'rate_limit' })]
  same(feed('claude', pastLines, { exit: 1 }).facts.failure, { kind: 'limit', until: local(2026, 10, 23, 15, 0), code: 'rate_limit' }, 'a reset already past: the text until')
  same(feed('claude', [init(), rateEvent('rejected', reset)], { exit: 1 }).facts.failure, { kind: 'limit', until: reset * 1000, code: 'five_hour' }, 'no result after a refusal: limit with the window as code')
  const cleared = feed('claude', [init(), rateEvent('rejected', reset), rateEvent('allowed_warning', reset), result()]).facts
  check(cleared.rateLimit === undefined && cleared.failure === undefined, 'a later allowed event clears the refusal')
  same(feed('claude', [init(), rateEvent('rejected', reset), result({ is_error: true, error: 'authentication_failed', result: 'x' })], { exit: 1 }).facts.failure, { kind: 'auth', code: 'authentication_failed' }, 'a refusal never turns auth into a limit')

  // Denials: dedupe, slim input, cap; a 3 MB result line.
  const big = 'x'.repeat(3 * 1024 * 1024)
  const bigResult = result({ permission_denials: [{ tool_name: 'Write', tool_use_id: 'tw', tool_input: { file_path: 'C:\\a.txt', content: big, nested: { a: 1 }, n: 3 } }] })
  const huge = feed('claude', [init(), { type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 'tw' }, bigResult])
  same(flagged(huge.parsed), [2], 'a 3 MB result line is parsed as the result')
  check(huge.facts.denials.length === 1 && huge.facts.denials[0].input.content.length === 2048, 'the denied content is cut to DENIAL_INPUT_MAX')
  same(Object.keys(huge.facts.denials[0].input).sort(), ['content', 'file_path', 'n'], 'nested input fields are dropped, primitives kept')
  const many = Array.from({ length: 70 }, (_, i) => ({ tool_name: 'Bash', tool_use_id: `b${i}`, tool_input: { command: `rm ${i}` } }))
  check(feed('claude', [init(), result({ permission_denials: many })]).facts.denials.length === 64, 'at most DENIALS_MAX denials')

  // Long text keeps its tail.
  const long = feed('claude', [init(), asst([{ type: 'text', text: 'a'.repeat(200 * 1024) }], { mid: 'a1' }), asst([{ type: 'text', text: 'b'.repeat(200 * 1024) }], { mid: 'a2' })], { exit: 1 }).facts
  check(long.finalText.length <= 256 * 1024 && long.finalText.endsWith('b') && !long.finalText.includes('a'), 'the joined text keeps the newest part within FINAL_TEXT_MAX')
}

function costStateChecks() {
  const lines = fixture('claude-transcript-cost-state')
  for (const provider of ['claude', 'codex']) {
    const run = feed(provider, lines)
    check(run.parsed.every(p => p === null), `${provider}: a transcript cost-state record is not a protocol line`)
    const f = run.facts
    check(!f.sawProtocol && !f.resultSeen && f.firstLineAt === undefined && f.usage === undefined && f.cumulativeCost === undefined && f.cumulativeTokens === undefined && f.sessionId === undefined, `${provider}: the cost-state fixture is not read as a run`)
    same(f.failure, { kind: 'unknown', code: 'no_result' }, `${provider}: nothing ran`)
  }
}

function codexFixtureChecks() {
  const simple = feed('codex', fixture('codex-simple'), { base: { model: 'gpt-6-luna' } })
  const f = simple.facts
  check(simple.parsed.every(p => p && p.type), 'every codex-simple line is a protocol line')
  same(simple.parsed[0], { type: 'thread.started', sessionId: '01a16976-a319-7192-961e-2c0dabde59b3' }, 'thread.started names the thread')
  same(flagged(simple.parsed), [3], 'turn.completed is the terminal line')
  check(f.sawProtocol && f.firstLineAt === T0 && f.resultSeen && !f.isError && !f.maxTurns && !f.unknownSession && !f.harnessCrash && f.failure === undefined, 'codex-simple: a clean run')
  check(f.sessionId === '01a16976-a319-7192-961e-2c0dabde59b3' && f.model === 'gpt-6-luna' && f.terminalReason === 'turn.completed', 'codex-simple: thread, model from the base, terminal reason')
  check(f.finalText === 'OK' && f.context === undefined && f.denials.length === 0, 'codex-simple: final text, no context (decision 11), no denials')
  same(f.usage, { inputTokens: 19731, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, unknownCost: true, model: 'gpt-6-luna', estimated: true, basis: 'absolute' }, 'codex-simple: a new thread is absolute; no rate card row: unknown cost')
  same(f.cumulativeTokens, { input: 19731, output: 5, cacheRead: 0, cacheWrite: 0 }, 'codex-simple: the thread total as reported')
  same(simple.again(), JSON.parse(JSON.stringify(f)), 'codex facts() is idempotent')

  // codex-resume and codex-resume2: cumulative per thread (S4), the delta against the base.
  const resume = feed('codex', fixture('codex-resume'), { base: { tokensTotal: f.cumulativeTokens, model: 'gpt-6-luna' } })
  same(resume.facts.usage, { inputTokens: 4545, outputTokens: 5, cacheReadTokens: 19584, cacheWriteTokens: 0, unknownCost: true, model: 'gpt-6-luna', estimated: true, basis: 'delta' }, 'codex-resume: delta, cached out of input')
  same(resume.facts.cumulativeTokens, { input: 43860, output: 10, cacheRead: 19584, cacheWrite: 0 }, 'codex-resume: the new thread total')
  const resume2 = feed('codex', fixture('codex-resume2'), { base: { tokensTotal: resume.facts.cumulativeTokens } })
  same(resume2.facts.usage, { inputTokens: 5439, outputTokens: 6, cacheReadTokens: 23936, cacheWriteTokens: 0, unknownCost: true, estimated: true, basis: 'delta' }, 'codex-resume2: delta of the third turn')
  check(resume2.facts.finalText === 'AGAIN' && resume2.facts.model === undefined, 'codex-resume2: final text; no model without a base model')
  check(feed('codex', fixture('codex-resume'), { base: { tokensTotal: f.cumulativeTokens, baseStale: true } }).facts.usage.approx === true, 'a stale base (takeover): approx')
  const linger = feed('codex', fixture('codex-simple'), { exit: 1 }).facts
  check(linger.failure === undefined && !linger.isError && !linger.harnessCrash, 'a completed turn wins over a non-zero exit (the linger kill)')

  // codex-pipe-eperm: the sandbox refused the pipe (S4); the turn still completed.
  const eperm = feed('codex', fixture('codex-pipe-eperm')).facts
  check(eperm.failure === undefined && eperm.finalText === '```text\nPIPEERR EPERM\n```', 'codex-pipe-eperm: a failed tool, a completed turn')
  same(eperm.digest, { tools: 1, families: { run: 1 }, files: [], lastFamily: 'run' }, 'codex-pipe-eperm: one command, counted once over started and completed')
  check(eperm.teamCalls === 0 && eperm.fileEdits === 0 && eperm.toolCalls === 1, 'codex-pipe-eperm: no team call, no edit')

  // codex-read: a powershell Get-Content is the run family and no edit (decision 68).
  const read = feed('codex', fixture('codex-read')).facts
  same(read.digest, { tools: 1, families: { run: 1 }, files: [], lastFamily: 'run' }, 'codex-read: run family')
  check(read.teamCalls === 0 && read.fileEdits === 0 && read.finalText === 'alpha\nbeta line\ngamma\n\nDONE', 'codex-read: zero edits, final text')

  // codex-readonly-write: read-only sandbox denied the write (a tool error, not a file edit).
  const ro = feed('codex', fixture('codex-readonly-write')).facts
  check(ro.failure === undefined && ro.finalText === 'BLOCKED' && ro.fileEdits === 0 && ro.digest.families.run === 1, 'codex-readonly-write: no failure, no edit, BLOCKED')
}

function codexSyntheticChecks() {
  const lines = [
    started, turn,
    item('started', { id: 'item_0', type: 'command_execution', command: `${PS} -Command "snaos team show"`, status: 'in_progress' }),
    item('completed', { id: 'item_0', type: 'command_execution', command: `${PS} -Command "snaos team show"`, aggregated_output: '{}', exit_code: 0, status: 'completed' }),
    item('started', { id: 'item_1', type: 'command_execution', command: 'git status', status: 'in_progress' }),
    item('completed', { id: 'item_1', type: 'command_execution', command: 'git status', aggregated_output: 'clean', exit_code: 0, status: 'completed' }),
    item('completed', { id: 'item_2', type: 'file_change', status: 'completed', changes: [{ path: 'C:\\repo\\src\\a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] }),
    item('completed', { id: 'item_3', type: 'file_change', status: 'failed', changes: [{ path: 'c.ts', kind: 'update' }] }),
    item('completed', { id: 'item_2', type: 'file_change', status: 'completed', changes: [{ path: 'C:\\repo\\src\\a.ts', kind: 'update' }] }),
    item('completed', { id: 'item_4', type: 'web_search', query: 'electron tree kill' }),
    item('started', { id: 'item_5', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'teams' }, status: 'in_progress' }),
    item('completed', { id: 'item_5', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'teams' }, result: { content: [{ type: 'text', text: 'found 3' }] }, status: 'completed' }),
    item('updated', { id: 'item_6', type: 'todo_list', items: [{ text: 'a', completed: false }] }),
    item('completed', { id: 'item_6', type: 'todo_list', items: [{ text: 'a', completed: true }] }),
    item('completed', { id: 'item_7', type: 'agent_message', text: 'first' }),
    item('completed', { id: 'item_8', type: 'agent_message', text: 'last' }),
    completed(),
  ]
  const f = feed('codex', lines).facts
  check(f.teamCalls === 1, 'a powershell -Command "snaos team ..." wrapper is a team call')
  same(f.digest, { tools: 6, families: { run: 1, edit: 2, web: 1, mcp: 1, todo: 1 }, files: ['src/a.ts', 'c.ts'], lastFamily: 'todo' }, 'every tool item once by id, team calls out')
  check(f.fileEdits === 1, 'a completed file_change is an edit; a failed one and a repeated id are not')
  check(f.toolCalls === 7 && f.finalText === 'last', 'toolCalls and the last agent_message')

  // Failures through the parser.
  const reused = feed('codex', [started, turn, { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: refresh_token_reused' } }], { exit: 1 })
  same(reused.facts.failure, { kind: 'auth', code: 'refresh_token_reused' }, 'turn.failed: the refresh class')
  check(reused.facts.resultSeen && reused.facts.isError && reused.facts.terminalReason === 'turn.failed' && !reused.facts.harnessCrash, 'turn.failed is terminal')
  same(flagged(reused.parsed), [2], 'turn.failed is flagged terminal')
  const toolOutput = feed('codex', [
    started, turn,
    item('completed', { id: 'c1', type: 'command_execution', command: 'curl https://api', aggregated_output: 'HTTP 401 Unauthorized: invalid oauth access token; refresh_token_reused; please run codex login', exit_code: 1, status: 'failed' }),
    { type: 'turn.failed', error: { message: 'agent gave up' } },
  ], { exit: 1 }).facts
  same(toolOutput.failure, { kind: 'unknown' }, 'a tool output with "401 unauthorized" stays out of the classifier')
  const retried = feed('codex', [started, turn, { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' }, item('completed', { id: 'i', type: 'agent_message', text: 'OK' }), completed()])
  check(retried.facts.failure === undefined && !retried.facts.isError, 'an error event followed by turn.completed: success')
  same(flagged(retried.parsed), [4], 'an error event never arms the linger kill; turn.completed does')
  const errorOnly = feed('codex', [started, turn, { type: 'error', message: "You've hit your usage limit for GPT-6. Switch to another model now, or try again at 11:31 PM." }], { exit: 1 }).facts
  same(errorOnly.failure, { kind: 'limit', code: 'usage_limit', until: local(2026, 10, 23, 23, 31) }, 'a final error event: its message classifies')
  check(!errorOnly.resultSeen && errorOnly.isError && !errorOnly.harnessCrash && errorOnly.terminalReason === 'error', 'an error event ends the protocol (no crash) but is no turn result')
  const stoppedAfterRetry = feed('codex', [started, turn, { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: rate limit exceeded)' }], { exit: null }).facts
  check(!stoppedAfterRetry.resultSeen && stoppedAfterRetry.isError, 'a run stopped after a retry notice saw no result (a stop ends it by its reason, not from the notice)')
  const crash = feed('codex', [started, turn, item('started', { id: 'c', type: 'command_execution', command: 'npm test' })], { exit: 1 }).facts
  check(crash.harnessCrash && !crash.resultSeen && crash.isError, 'exit 1 mid-turn: harness crash')
  same(crash.failure, { kind: 'unknown', code: 'harness_crash' }, 'harness crash failure')
  same(feed('codex', [started, turn], { exit: null }).facts.failure, { kind: 'unknown', code: 'no_result' }, 'killed by a signal: no_result')
  const usageFailed = feed('codex', [started, turn, { type: 'turn.failed', error: { message: 'x' }, usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }], { exit: 1 }).facts
  same(usageFailed.usage, { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0, unknownCost: true, estimated: true, basis: 'absolute' }, 'turn.failed usage counts')
  check(feed('codex', [started, { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 9, output_tokens: 1 } }]).facts.usage === undefined, 'cached above input: no usage (paperclip validation)')
  check(feed('codex', [started, { type: 'turn.completed', usage: { input_tokens: '5', output_tokens: 1 } }]).facts.usage === undefined, 'a junk counter: no usage')

  // Unknown sessions (paperclip 4.5) and stderr noise.
  const goneLines = 'Error: thread/resume failed: no rollout found for thread id 0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000\n'
  const gone = feed('codex', [], { exit: 1, stderr: goneLines }).facts
  check(gone.unknownSession && gone.sessionId === undefined && !gone.sawProtocol, 'no thread.started, exit 1, unknown thread on stderr: unknown session')
  same(gone.failure, { kind: 'request', code: 'unknown_session' }, 'unknown session: request / unknown_session')
  const noise = '2026-10-23T14:00:00.123Z ERROR codex_core::rollout::list: state db missing rollout path for thread 0199abcd-0000\n'
  const startedNoise = feed('codex', [started, turn], { exit: 1, stderr: noise }).facts
  check(!startedNoise.unknownSession && startedNoise.harnessCrash, 'a started thread with a stale rollout notice is no unknown session')
  check(feed('codex', [], { exit: 1, stderr: noise }).facts.unknownSession, 'no thread and the rollout notice: unknown session (raw stderr)')
  check(!feed('codex', [], { exit: 0, stderr: goneLines }).facts.unknownSession, 'exit 0: never an unknown session')
  same(feed('codex', [], { exit: 1, stderr: `${noise}YOLO mode is enabled. All commands run without approval.\nError: refresh token has already been used\n` }).facts.failure, { kind: 'auth', code: 'refresh_token_reused' }, 'auth outranks the rollout notice')
  same(feed('codex', [], { exit: 2, stderr: "YOLO mode is enabled.\nerror: unexpected argument '--bogus' found\n" }).facts.failure, { kind: 'unknown', code: 'no_result' }, 'an argv error without protocol: no_result')
}

function codexExecFailureChecks() {
  const F = (message, stderr = '') => M.codexExecFailure(message, stderr, T0)
  same(F('provider error: refresh_token_reused'), { kind: 'auth', code: 'refresh_token_reused' }, 'refresh token reuse')
  same(F('', 'OAuth failed: refresh token has expired'), { kind: 'auth', code: 'refresh_token_expired' }, 'refresh token expired, from stderr')
  same(F('Your refresh token has been invalidated'), { kind: 'auth', code: 'refresh_token_invalidated' }, 'refresh token invalidated')
  same(F('token endpoint said invalid_grant'), { kind: 'auth', code: 'refresh_token_invalidated' }, 'invalid_grant')
  same(F('credential refresh returned 401 Unauthorized'), { kind: 'auth', code: 'refresh_token_invalidated' }, 'a contextual 401')
  same(F('chatgpt wham api returned 401'), { kind: 'unknown' }, 'a bare 401 is not auth')
  same(F("Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."), { kind: 'context', code: 'context_window' }, 'context window overflow')
  same(F('Your input exceeds the context length of this model.'), { kind: 'context', code: 'context_window' }, 'context length')
  same(F("We're currently experiencing high demand, which may cause temporary errors."), { kind: 'overloaded', code: 'transient' }, 'high demand')
  same(F('exceeded retry limit, last status: 429 Too Many Requests'), { kind: 'rateLimited', code: 'rate_limit' }, '429')
  same(F('stream error: service unavailable'), { kind: 'overloaded', code: 'transient' }, 'service unavailable')
  const LIMIT = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM."
  same(F(LIMIT), { kind: 'limit', code: 'usage_limit', until: local(2026, 10, 23, 23, 31) }, 'usage limit: "try again at" in local time')
  same(F(LIMIT.replace('11:31 PM.', '11:31 PM (America/Chicago).')), { kind: 'limit', code: 'usage_limit', until: utc(2026, 10, 24, 4, 31) }, 'usage limit with an IANA zone')
  same(F(LIMIT.replace('11:31 PM.', '11:31 PM PST.')), { kind: 'limit', code: 'usage_limit', until: local(2026, 10, 23, 23, 31) }, 'an abbreviation is read as local time')
  same(F("You've hit your usage limit for GPT-6. Switch to another model now, or try again at 9:00 AM."), { kind: 'limit', code: 'usage_limit', until: local(2026, 10, 24, 9, 0) }, 'a time already past today is tomorrow')
  same(F('You have reached your usage limit.'), { kind: 'limit', code: 'usage_limit' }, 'usage-limit wording without a time: limit, no until')
  same(F('The requested model is at capacity. Please try again later.'), { kind: 'overloaded', code: 'capacity' }, 'capacity wording: overloaded')
  same(F(`${LIMIT} refresh_token_reused`), { kind: 'auth', code: 'refresh_token_reused' }, 'auth outranks the limit')
  same(F('', 'YOLO mode is enabled.\n2026-10-23T14:00:00.000Z ERROR codex_core::rollout::list: state db missing rollout path for thread 0199abcd\nsomething broke'), { kind: 'unknown' }, 'noise and an unknown line: unknown')
  same(F('', "You've hit your usage limit · try again at 3:30 PM"), { kind: 'limit', code: 'usage_limit', until: local(2026, 10, 23, 15, 30) }, 'stderr usage limit: parseResetsAt of the text')
  same(M.codexExecFailure(null, undefined, T0), { kind: 'unknown' }, 'junk never throws')
  same(F('usage limit reached|1792800000'), { kind: 'limit', code: 'usage_limit', until: 1792800000 * 1000 }, 'the old pipe epoch through parseResetsAt')
}

function decodeChecks() {
  const D = M.decodeCodexExec
  const at = (name, i) => D(JSON.parse(fixture(name)[i]), 100 + i)
  same(at('codex-simple', 0), [], 'thread.started shows nothing')
  same(at('codex-simple', 1), [], 'turn.started shows nothing')
  same(at('codex-simple', 2), [{ id: '102', ts: null, role: 'assistant', blocks: [{ t: 'text', text: 'OK' }] }], 'agent_message: assistant text')
  same(at('codex-simple', 3), [], 'turn.completed shows nothing')
  same(at('codex-pipe-eperm', 2), [{ id: '102', ts: null, role: 'assistant', blocks: [{ t: 'text', text: 'I’ll run the command exactly as written and return its output verbatim.' }] }], 'commentary agent_message: assistant text')
  same(at('codex-pipe-eperm', 3), [{ id: '103', ts: null, role: 'assistant', blocks: [{ t: 'toolUse', id: 'item_1', name: 'command_execution', summary: 'node "C:/Users/user/work/s4/pipe-client.cjs"' }] }], 'command_execution started: the call, the shell wrapper unwrapped')
  same(at('codex-pipe-eperm', 4), [{ id: '104', ts: null, role: 'tool', blocks: [{ t: 'toolResult', toolUseId: 'item_1', isError: true, text: 'PIPEERR EPERM' }] }], 'command_execution completed with exit 1: an error result')
  same(at('codex-read', 2)[0].blocks[0].summary, 'Get-Content -Raw -LiteralPath a.txt', 'a powershell -Command body is the summary')
  const readResult = at('codex-read', 3)[0].blocks[0]
  check(readResult.t === 'toolResult' && !readResult.isError && !readResult.text.includes('\r') && readResult.text.endsWith('alpha\nbeta line\ngamma'), 'exit 0: a clean result, CRLF read as LF, trailing space cut')
  same(at('codex-readonly-write', 2)[0].blocks[0].summary, "Set-Content -LiteralPath b.txt -Value 'x' -NoNewline", 'a double-quoted body is unwrapped')
  check(at('codex-readonly-write', 3)[0].blocks[0].isError === true, 'the denied write is an error result')
  for (const name of FIXTURES.filter(n => n.startsWith('codex-'))) {
    fixture(name).forEach((l, i) => { const out = D(JSON.parse(l), i); check(Array.isArray(out), `${name} line ${i} decodes`) })
  }

  same(D({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: '**Planning**' } }, 5), [{ id: '5', ts: null, role: 'assistant', blocks: [{ t: 'thinking', text: '**Planning**' }] }], 'reasoning: thinking')
  same(D({ type: 'item.completed', item: { id: 'f', type: 'file_change', status: 'completed', changes: [{ path: 'C:\\repo\\src\\a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] } }, 7), [
    { id: '7.0', ts: null, role: 'assistant', blocks: [{ t: 'toolUse', id: 'f', name: 'file_change', summary: 'a.ts, b.ts' }] },
    { id: '7.1', ts: null, role: 'tool', blocks: [{ t: 'toolResult', toolUseId: 'f', isError: false, text: 'update C:\\repo\\src\\a.ts\nadd src/b.ts' }] },
  ], 'file_change: the call and its result from one line')
  check(D({ type: 'item.completed', item: { id: 'f', type: 'file_change', status: 'failed', changes: [] } }, 7)[1].blocks[0].isError === true, 'a failed file_change is an error')
  same(D({ type: 'item.started', item: { id: 'f', type: 'file_change' } }, 7), [], 'file_change started shows nothing')
  same(D({ type: 'item.started', item: { id: 'm', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'teams' } } }, 8)[0].blocks, [{ t: 'toolUse', id: 'm', name: 'mcp__docs__search', summary: 'teams' }], 'mcp_tool_call started: mcp__server__tool')
  same(D({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'docs', tool: 'search', result: { content: [{ type: 'text', text: 'found 3' }] }, status: 'completed' } }, 9)[0].blocks, [{ t: 'toolResult', toolUseId: 'm', isError: false, text: 'found 3' }], 'mcp_tool_call completed: its text content')
  same(D({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', error: { message: 'boom' }, status: 'failed' } }, 9)[0].blocks, [{ t: 'toolResult', toolUseId: 'm', isError: true, text: 'boom' }], 'mcp_tool_call failed: its error')
  same(D({ type: 'item.completed', item: { id: 'w', type: 'web_search', query: 'electron tree kill' } }, 10).map(m => m.blocks[0]), [{ t: 'toolUse', id: 'w', name: 'web_search', summary: 'electron tree kill' }, { t: 'toolResult', toolUseId: 'w', isError: false, text: '' }], 'web_search: the query and a done result')
  same(D({ type: 'item.completed', item: { id: 't', type: 'todo_list', items: [{ text: 'read code', completed: true }, { text: 'write tests', completed: false }] } }, 11).map(m => m.blocks[0]), [{ t: 'toolUse', id: 't', name: 'todo_list', summary: 'write tests' }, { t: 'toolResult', toolUseId: 't', isError: false, text: '[x] read code\n[ ] write tests' }], 'todo_list: the open item and the list')
  same(D({ type: 'error', message: 'Reconnecting... 1/5' }, 12), [{ id: '12', ts: null, role: 'system', blocks: [{ t: 'text', text: 'Reconnecting... 1/5' }] }], 'an error event: a system row')
  same(D({ type: 'turn.failed', error: { message: 'boom' } }, 13), [{ id: '13', ts: null, role: 'system', blocks: [{ t: 'text', text: 'boom' }] }], 'turn.failed: a system row')
  same(D({ type: 'item.completed', item: { id: 'e', type: 'error', message: 'model fell back' } }, 14)[0].role, 'system', 'an error item: a system row')
  same(D({ type: 'turn.failed', error: {} }, 15), [], 'a failure without words shows nothing')
  same(D({ type: 'item.started', item: { id: 'a', type: 'agent_message', text: 'partial' } }, 16), [], 'agent_message started shows nothing')
  same(D({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: '   ' } }, 16), [], 'an empty message shows nothing')
  same(D({ type: 'item.completed', item: { id: 'x', type: 'brand_new_item' } }, 17), [], 'an unknown item shows nothing')
  for (const junk of [null, undefined, 3, 'x', [], {}, { type: 'item.completed' }, { type: 'item.completed', item: 'x' }, { type: 'turn.failed' }]) check(Array.isArray(D(junk, 1)) && D(junk, 1).length === 0, `junk ${JSON.stringify(junk)} shows nothing`)
  check(D({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'hi' }, timestamp: '2026-10-23T14:00:00.000Z' }, 1)[0].ts === utc(2026, 10, 23, 14, 0), 'a timestamp is kept when present')
  const longOut = D({ type: 'item.completed', item: { id: 'c', type: 'command_execution', aggregated_output: 'y'.repeat(10000), exit_code: 0 } }, 1)[0].blocks[0]
  check(longOut.text.length === 4096 && longOut.truncated === true, 'a long output is cut to CHAT_TOOL_TEXT_MAX and flagged')
  same(D({ type: 'item.started', item: { type: 'command_execution', command: 'bash -lc "npm test"' } }, 20)[0].blocks[0], { t: 'toolUse', id: 'item:20', name: 'command_execution', summary: 'npm test' }, 'an item without id gets one from the offset; bash -lc unwrapped')
  same(D({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'git log --oneline' } }, 21)[0].blocks[0].summary, 'git log --oneline', 'a plain command as is')
  same(D({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: ['bash', '-lc', 'ls'] } }, 22)[0].blocks[0].summary, 'ls', 'an argv command is joined, then unwrapped')
  const families = ['command_execution', 'file_change', 'mcp__docs__search', 'web_search', 'todo_list'].map(n => M.familyOf(n))
  same(families, ['run', 'edit', 'mcp', 'web', 'todo'], 'the decoded tool names fall in the chat families')
}

function robustnessChecks() {
  const junk = ['', '   ', 'not json', '[1,2]', '42', 'null', '{', '{"type":5}', '{"no":"type"}', '\ufeff{"type":"result"}', '{"type":"turn.completed","usage":"x"}', '{"type":"item.completed","item":null}', '{"type":"assistant","message":"x"}', '{"type":"assistant","message":{"content":"x","usage":[1]}}', '{"type":"result","modelUsage":"x","model_usage_since_last_result":[1],"permission_denials":"x"}', '{"type":"user","message":{"content":[null,1,{"type":"tool_result"}]}}', '{"type":"system","subtype":"permission_denied"}', '{"type":"rate_limit_event","rate_limit_info":"x"}', '{"type":"thread.started","thread_id":5}']
  for (const provider of ['claude', 'codex']) {
    const p = provider === 'claude' ? M.createClaudeStreamParser() : M.createCodexExecParser()
    let threw = false
    try {
      for (const l of junk) p.line(l, T0)
      p.facts({ code: null }, undefined, {}, T0)
      p.facts({ code: 1 }, 'x', { tokensTotal: { input: 'x' }, costTotal: 'y', model: 5 }, T0)
    } catch (e) {
      threw = e
    }
    check(threw === false, `${provider}: junk lines and junk bases never throw (${threw})`)
  }
  check(M.createClaudeStreamParser().line('{"type":"cost-state"}', T0) === null && M.createCodexExecParser().line('{"type":"result"}', T0) === null, 'each parser reads only its own protocol')
  const p = M.createClaudeStreamParser()
  const out = p.line(JSON.stringify(result()), T0)
  check(out.result === true && p.line(JSON.stringify(result()), T0 + 1).result === undefined, 'only the first result is flagged')
}

function main() {
  sourceChecks()
  teamCallChecks()
  claudeFixtureChecks()
  claudeSyntheticChecks()
  costStateChecks()
  codexFixtureChecks()
  codexSyntheticChecks()
  codexExecFailureChecks()
  decodeChecks()
  robustnessChecks()
  console.log(`PASS: ${checks} teams parsers checks (13 fixtures, Claude and Codex facts, usage bases, failures, TEAM_CALL_RE, decodeCodexExec)`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
