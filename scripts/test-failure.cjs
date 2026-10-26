process.env.TZ = 'America/New_York'
// Failure classification (app 2.7.0, A2, E10 SPIKE S6): every row of the
// normative FAILURE_MAP table in E10.md for Claude and Codex (read from the
// doc), the text refinements (limit, context), unknown codes and junk,
// rate_limit_event, the label keys, and parseResetsAt: every S6 text format,
// IANA zones (DST gaps and repeated hours, the zone's own date), midnight,
// month and year rollover, the old pipe epoch and junk that never throws.
// Same esbuild + vm harness as test-status.cjs.
//
// Local times need a zone with DST: the TZ is fixed on line 1, before any Date use.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, ...overrides })
  return mod.exports
}

const F = load('src/shared/failure.ts')
/** A wall clock in the suite's local zone (America/New_York), month 1-based. */
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi)
const iso = t => (t === undefined ? 'undefined' : new Date(t).toISOString())
/** Friday 2026-10-23 10:00 EDT (14:00Z); 11:00 in Buenos Aires, Saturday 03:00 in Auckland. */
const N = local(2026, 10, 23, 10, 0)
const LIMIT_TEXT = "You've hit your limit · resets 3pm (America/Argentina/Buenos_Aires)"

function at(text, now, expected, label) {
  const got = F.parseResetsAt(text, now)
  assert.equal(got, expected, `${label}: ${JSON.stringify(text)} at ${iso(now)} gave ${iso(got)}, expected ${iso(expected)}`)
  checks++
}

function environmentChecks() {
  check(process.env.TZ === 'America/New_York', 'TZ is fixed to America/New_York')
  check(new Date(2026, 0, 15).getTimezoneOffset() === 300 && new Date(2026, 6, 15).getTimezoneOffset() === 240, 'the local zone has DST (EST in January, EDT in July)')
  check(N === utc(2026, 10, 23, 14, 0), 'the reference now is 14:00Z')
  const source = fs.readFileSync(path.join(root, 'src/shared/failure.ts'), 'utf8')
  check(!/^\s*import\s/m.test(source) && !/\brequire\(/.test(source), 'failure.ts imports nothing (src/shared stays free of Node and the DOM)')
  // A regex, not the literal header: test-docs.cjs treats a file holding the literal as adapted code.
  check(/^\/\/ Adaptado de paperclipai\/paperclip \(MIT\) - packages\/adapters\/claude-local\/src\/server\/parse\.ts$/.test(source.split(/\r?\n/)[0]), 'the paperclip attribution header is on line 1')
}

function kindsAndMapChecks() {
  same(F.FAILURE_KINDS, ['limit', 'rateLimited', 'overloaded', 'auth', 'billing', 'context', 'request', 'unknown'], 'FAILURE_KINDS lists the eight kinds in catalog order')
  check(Object.isFrozen(F.FAILURE_KINDS) && Object.isFrozen(F.FAILURE_MAP) && Object.isFrozen(F.FAILURE_MAP.claude) && Object.isFrozen(F.FAILURE_MAP.codex), 'the kinds and both maps are frozen')
  for (const provider of ['claude', 'codex']) {
    for (const [code, kind] of Object.entries(F.FAILURE_MAP[provider])) check(F.FAILURE_KINDS.includes(kind), `${provider} ${code} maps to a known kind`)
  }
  same(Object.keys(F.FAILURE_MAP.claude).sort(), [
    'account_on_hold', 'authentication_failed', 'billing_error', 'cloud_credential_error', 'invalid_request', 'max_output_tokens', 'model_not_found',
    'oauth_org_not_allowed', 'overloaded', 'rate_limit', 'server_error', 'unknown', 'verification_required',
  ], 'the Claude map holds exactly the 13 StopFailure error values of S6')
  same(Object.keys(F.FAILURE_MAP.codex).sort(), [
    'activeTurnNotSteerable', 'badRequest', 'contextWindowExceeded', 'cyberPolicy', 'flexUnavailable', 'httpConnectionFailed', 'internalServerError',
    'misalignmentPolicyViolation', 'other', 'rateLimitExceeded', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts',
    'sandboxError', 'serverOverloaded', 'sessionBudgetExceeded', 'threadRollbackFailed', 'tooManyDenials', 'unauthorized', 'usageLimitExceeded',
  ], 'the Codex map holds exactly the 20 codexErrorInfo values of S6')
  for (const kind of F.FAILURE_KINDS) check(F.failureLabelKey(kind) === `status.failure.${kind}`, `label key of ${kind}`)
  check(F.failureLabelKey('nope') === 'status.failure.unknown' && F.failureLabelKey(undefined) === 'status.failure.unknown', 'a junk kind labels as unknown')
}

/** The normative S6 table of docs/snagentsos/epics/E10.md drives these: every code of every row. */
function docTableChecks() {
  const e10 = fs.readFileSync(path.join(root, 'docs/snagentsos/epics/E10.md'), 'utf8')
  const s6 = e10.slice(e10.indexOf('### S6.'), e10.indexOf('### S7.'))
  const rows = [...s6.matchAll(/^\| (Claude|Codex) \| (.+?) \| `(\w+)`/gm)].map(m => ({ provider: m[1].toLowerCase(), cell: m[2], kind: m[3] }))
  check(rows.length === 15, `the S6 table has 8 Claude and 7 Codex rows (${rows.length})`)
  const covered = { claude: new Set(), codex: new Set() }
  for (const row of rows) {
    const keys = Object.keys(F.FAILURE_MAP[row.provider])
    const codes = [...row.cell.matchAll(/`([\w*]+)`/g)].flatMap(([, c]) => c.endsWith('*') ? keys.filter(k => k.startsWith(c.slice(0, -1))) : [c])
    check(codes.length > 0, `row "${row.cell}" names codes`)
    for (const code of codes) {
      covered[row.provider].add(code)
      let got
      if (row.provider === 'codex') {
        got = F.codexFailure(code, 'Something failed', N)
        check(F.FAILURE_MAP.codex[code] === row.kind, `Codex ${code} -> ${row.kind} in the map`)
        same(F.codexFailure({ [code]: { httpStatusCode: 503 } }, undefined, N), { kind: row.kind, code }, `Codex { ${code}: {...} } -> ${row.kind}`)
      } else if (/ con /.test(row.cell)) {
        // Text-refined rows: the limit wording, or a context-window phrase.
        got = F.claudeFailure(code, row.kind === 'limit' ? LIMIT_TEXT : 'Prompt is too long: 210000 tokens > 200000 maximum', N)
      } else if (/ sin /.test(row.cell)) {
        got = F.claudeFailure(code, 'API Error: 429 {"type":"rate_limit_error"}', N)
        check(F.FAILURE_MAP.claude[code] === row.kind, `Claude ${code} -> ${row.kind} in the map`)
      } else {
        got = F.claudeFailure(code, 'Something failed', N)
        check(F.FAILURE_MAP.claude[code] === row.kind, `Claude ${code} -> ${row.kind} in the map`)
      }
      check(got.kind === row.kind && got.code === code, `${row.provider} ${code} (${row.cell}) -> ${row.kind} (got ${got.kind})`)
    }
    if (/desconocido/.test(row.cell)) same(F.codexFailure('neverSeenBefore', 'x', N), { kind: row.kind, code: 'neverSeenBefore' }, 'an unknown Codex code -> unknown, code kept')
  }
  same([...covered.claude].sort(), Object.keys(F.FAILURE_MAP.claude).sort(), 'the S6 table covers every Claude code of the map')
  same([...covered.codex].sort(), Object.keys(F.FAILURE_MAP.codex).sort(), 'the S6 table covers every Codex code of the map')
}

function claudeChecks() {
  const rows = [
    ['rate_limit', LIMIT_TEXT, { kind: 'limit', until: utc(2026, 10, 23, 18, 0), code: 'rate_limit' }, 'session limit in a zone: 3pm Buenos Aires is 18:00Z'],
    ['rate_limit', 'Claude usage limit reached. Your limit will reset at 5pm.', { kind: 'limit', until: local(2026, 10, 23, 17, 0), code: 'rate_limit' }, '"usage limit" with "reset at" in local time'],
    ['rate_limit', '5-hour limit reached ∙ resets 3am', { kind: 'limit', until: local(2026, 10, 24, 3, 0), code: 'rate_limit' }, '"limit reached" with a passed time resets tomorrow'],
    ['rate_limit', 'HIT YOUR WEEKLY LIMIT', { kind: 'limit', code: 'rate_limit' }, 'limit wording is case-insensitive; no time means no until'],
    ['rate_limit', "You've reached your Fable limit.", { kind: 'limit', code: 'rate_limit' }, '"reached your" (a Claude Code limit prefix) is a limit'],
    ['rate_limit', "You're out of extra usage · resets Oct 25, 3pm (America/Argentina/Buenos_Aires)", { kind: 'limit', until: utc(2026, 10, 25, 18, 0), code: 'rate_limit' }, '"out of extra usage" is a limit with until'],
    ['rate_limit', 'Your org is out of usage · add funds to continue', { kind: 'limit', code: 'rate_limit' }, '"out of usage" is a limit'],
    ['rate_limit', 'Claude AI usage limit reached|1792771200', { kind: 'limit', until: 1792771200000, code: 'rate_limit' }, 'the old pipe form gives the epoch'],
    ['rate_limit', 'API Error: 429 rate_limit_error, retrying in 30s', { kind: 'rateLimited', code: 'rate_limit' }, 'a 429 without limit wording is rateLimited'],
    ['rate_limit', 'Request rejected (429) · resets 3pm', { kind: 'rateLimited', code: 'rate_limit' }, 'a reset time alone does not make it a limit, and rateLimited carries no until'],
    ['rate_limit', 'API Error: Server is temporarily limiting requests (not your usage limit) · this may be a temporary capacity issue.', { kind: 'rateLimited', code: 'rate_limit' }, 'Claude Code 2.1.309 transient 429 says "not your usage limit"'],
    ['rate_limit', "Server is temporarily limiting requests (not your usage limit). You've hit your session limit · resets 3pm", { kind: 'limit', until: local(2026, 10, 23, 15, 0), code: 'rate_limit' }, 'the disclaimer does not hide real limit wording next to it'],
    ['rate_limit', undefined, { kind: 'rateLimited', code: 'rate_limit' }, 'rate_limit without text'],
    ['invalid_request', 'Prompt is too long', { kind: 'context', code: 'invalid_request' }, '"Prompt is too long" is context'],
    ['invalid_request', 'input length and `max_tokens` exceed context limit: 197000 + 21333 > 200000', { kind: 'context', code: 'invalid_request' }, '"exceed context limit" is context'],
    ['invalid_request', 'The request exceeds the context window of this model', { kind: 'context', code: 'invalid_request' }, '"context window" is context'],
    ['invalid_request', 'context_length_exceeded', { kind: 'context', code: 'invalid_request' }, '"context_length" is context'],
    ['invalid_request', 'messages.1.content: Input should be a valid list (see the context docs)', { kind: 'request', code: 'invalid_request' }, 'a bare "context" word is not a context-window phrase'],
    ['invalid_request', undefined, { kind: 'request', code: 'invalid_request' }, 'invalid_request without text'],
    ['max_output_tokens', 'Prompt is too long', { kind: 'request', code: 'max_output_tokens' }, 'text refines only invalid_request'],
    ['overloaded', "You've hit your limit · resets 3pm", { kind: 'overloaded', code: 'overloaded' }, 'limit wording refines only rate_limit'],
    ['unknown', "You've hit your limit · resets 3pm", { kind: 'unknown', code: 'unknown' }, 'an explicit unknown keeps its table row'],
    ['teapot_error', 'Something odd', { kind: 'unknown', code: 'teapot_error' }, 'an unknown code is unknown and keeps the code'],
    ['  billing_error\n', 'Credit balance is too low', { kind: 'billing', code: 'billing_error' }, 'the code is trimmed'],
    [undefined, "You've hit your limit · resets 3pm", { kind: 'limit', until: local(2026, 10, 23, 15, 0) }, 'no code with limit wording is a limit'],
    [undefined, 'Prompt is too long', { kind: 'unknown' }, 'no code without limit wording is unknown'],
    [undefined, 'Context limit reached · /compact or /clear to continue', { kind: 'unknown' }, 'no code: "Context limit reached" is not a subscription limit'],
    [undefined, 'API Error: Server is temporarily limiting requests (not your usage limit)', { kind: 'unknown' }, 'no code: "not your usage limit" is not a limit'],
    ['', undefined, { kind: 'unknown' }, 'an empty code and no text'],
  ]
  for (const [code, text, expected, label] of rows) same(F.claudeFailure(code, text, N), expected, `Claude: ${label}`)
  for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) same(F.claudeFailure(code, '', N), { kind: 'unknown', code }, `Claude ${code} does not reach Object.prototype`)
  const long = 'x'.repeat(40)
  same(F.claudeFailure(long, '', N), { kind: 'unknown', code: 'x'.repeat(32) }, 'a long code is clipped to 32 characters')
  same(F.claudeFailure(42, { text: 'hit your limit' }, N), { kind: 'unknown' }, 'a non-string code and text are ignored')
  same(F.claudeFailure('rate_limit', LIMIT_TEXT, NaN), { kind: 'limit', code: 'rate_limit' }, 'a bad clock still classifies, without until')
}

function codexChecks() {
  const usage = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:30 PM."
  same(F.codexFailure('usageLimitExceeded', usage, N), { kind: 'limit', until: local(2026, 10, 23, 15, 30), code: 'usageLimitExceeded' }, 'Codex usage limit reads "try again at 3:30 PM" (local) past the URL parentheses')
  same(F.codexFailure({ usageLimitExceeded: null }, 'Usage limit hit, try again at 9:15 AM.', N), { kind: 'limit', until: local(2026, 10, 24, 9, 15), code: 'usageLimitExceeded' }, 'a passed "try again at" means tomorrow')
  same(F.codexFailure('sessionBudgetExceeded', 'Session budget exceeded.', N), { kind: 'limit', code: 'sessionBudgetExceeded' }, 'a limit without a time has no until')
  same(F.codexFailure('rateLimitExceeded', 'Rate limit reached, try again at 3:30 PM', N), { kind: 'rateLimited', code: 'rateLimitExceeded' }, 'rateLimited never carries until')
  same(F.codexFailure({ activeTurnNotSteerable: { turnKind: 'review' } }, undefined, N), { kind: 'request', code: 'activeTurnNotSteerable' }, 'the ts-rs object form with a payload')
  same(F.codexFailure({ httpConnectionFailed: { httpStatusCode: null } }, undefined, N), { kind: 'unknown', code: 'httpConnectionFailed' }, 'a connection failure is unknown')
  same(F.codexFailure(' contextWindowExceeded ', undefined, N), { kind: 'context', code: 'contextWindowExceeded' }, 'the string code is trimmed')
  same(F.codexFailure('quantumFlux', 'x', N), { kind: 'unknown', code: 'quantumFlux' }, 'an unknown string code keeps the code')
  same(F.codexFailure({ quantumFlux: {} }, 'x', N), { kind: 'unknown', code: 'quantumFlux' }, 'an unknown one-key object keeps the key')
  same(F.codexFailure({ badRequest: {}, other: {} }, 'x', N), { kind: 'unknown' }, 'an object with two keys has no code')
  same(F.codexFailure({}, 'x', N), { kind: 'unknown' }, 'an empty object has no code')
  same(F.codexFailure(['usageLimitExceeded'], 'x', N), { kind: 'unknown' }, 'an array is not a code')
  same(F.codexFailure(JSON.parse('{"__proto__": {}}'), 'x', N), { kind: 'unknown', code: '__proto__' }, 'a parsed __proto__ key does not reach Object.prototype')
  same(F.codexFailure('constructor', 'x', N), { kind: 'unknown', code: 'constructor' }, 'constructor is an unknown code')
  for (const junk of [null, undefined, 7, true, '']) same(F.codexFailure(junk, 'boom', N), { kind: 'unknown' }, `junk info ${JSON.stringify(junk)} is unknown`)
  same(F.codexFailure(undefined, usage, N), { kind: 'limit', until: local(2026, 10, 23, 15, 30) }, 'codex exec: no codexErrorInfo, the usage-limit message still is a limit with until')
  same(F.codexFailure(undefined, 'stream disconnected before completion', N), { kind: 'unknown' }, 'codex exec: other messages are unknown')
  same(F.codexFailure(undefined, 'context window limit reached', N), { kind: 'unknown' }, 'codex exec: a context-window message is not a limit')
  // codex-rs prints "%b %-d<suffix>, %Y %-I:%M %p" when the reset is not today.
  same(F.codexFailure('usageLimitExceeded', "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at Oct 25th, 2026 3:30 PM.", N), { kind: 'limit', until: local(2026, 10, 25, 15, 30), code: 'usageLimitExceeded' }, 'Codex dated "try again at Oct 25th, 2026 3:30 PM"')
  same(F.codexFailure('usageLimitExceeded', 'Usage limit hit. Try again at Jan 1st, 2027 12:05 AM.', N), { kind: 'limit', until: local(2027, 1, 1, 0, 5), code: 'usageLimitExceeded' }, 'Codex dated reset with a capital "Try again at" across the year')
  same(F.codexFailure('x'.repeat(50), undefined, N), { kind: 'unknown', code: 'x'.repeat(32) }, 'a long Codex code is clipped to 32 characters')
}

function rateLimitChecks() {
  const reset = 1792771200 // 2026-10-23T16:00:00Z
  check(F.failureFromRateLimit(undefined, N) === null, 'no info is no failure')
  check(F.failureFromRateLimit({}, N) === null, 'no status is no failure')
  check(F.failureFromRateLimit({ status: 'allowed', resetsAt: reset, rateLimitType: 'five_hour' }, N) === null, 'allowed is no failure')
  check(F.failureFromRateLimit({ status: 'allowed_warning', resetsAt: reset, rateLimitType: 'five_hour' }, N) === null, 'allowed_warning is no failure')
  check(F.failureFromRateLimit({ status: '  ', resetsAt: reset }, N) === null && F.failureFromRateLimit({ status: 3 }, N) === null, 'a blank or non-string status is no failure')
  check(F.failureFromRateLimit('rejected', N) === null && F.failureFromRateLimit(null, N) === null, 'a non-object is no failure')
  same(F.failureFromRateLimit({ status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour' }, N), { kind: 'limit', until: reset * 1000, code: 'five_hour' }, 'rejected: limit until resetsAt (seconds to ms), window as code')
  same(F.failureFromRateLimit({ status: 'rejected', resetsAt: reset }, N), { kind: 'limit', until: reset * 1000 }, 'without rateLimitType there is no code')
  same(F.failureFromRateLimit({ status: 'rejected', resetsAt: N / 1000 - 3600, rateLimitType: 'seven_day' }, N), { kind: 'limit', code: 'seven_day' }, 'a resetsAt already past gives no until')
  same(F.failureFromRateLimit({ status: 'rejected', resetsAt: N / 1000 }, N), { kind: 'limit' }, 'a resetsAt equal to now gives no until')
  for (const bad of [String(reset), NaN, Infinity, 1e308, null]) same(F.failureFromRateLimit({ status: 'rejected', resetsAt: bad }, N), { kind: 'limit' }, `resetsAt ${String(bad)} gives no until`)
  same(F.failureFromRateLimit({ status: 'rejected', rateLimitType: 'w'.repeat(40) }, N), { kind: 'limit', code: 'w'.repeat(32) }, 'a long rateLimitType is clipped')
  // The real S1 capture: an allowed event in a successful run.
  const line = fs.readFileSync(path.join(root, 'scripts/fixtures/teams/claude-simple.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'rate_limit_event')
  check(line && line.rate_limit_info.status === 'allowed' && F.failureFromRateLimit(line.rate_limit_info, N) === null, 'the S1 fixture rate_limit_event (allowed) is no failure')
  same(F.failureFromRateLimit({ ...line.rate_limit_info, status: 'rejected' }, line.rate_limit_info.resetsAt * 1000 - 1), { kind: 'limit', until: line.rate_limit_info.resetsAt * 1000, code: line.rate_limit_info.rateLimitType }, 'the same event refused is a limit until its resetsAt')
}

function formatChecks() {
  // S6 formats in local time, from Friday 10:00.
  at('resets 3pm', N, local(2026, 10, 23, 15, 0), 'resets 3pm')
  at('resets 3:30pm', N, local(2026, 10, 23, 15, 30), 'resets 3:30pm')
  at('resets 15:00', N, local(2026, 10, 23, 15, 0), 'resets 15:00')
  at('3pm', N, local(2026, 10, 23, 15, 0), 'bare 3pm')
  at('3:30pm', N, local(2026, 10, 23, 15, 30), 'bare 3:30pm')
  at('15:00', N, local(2026, 10, 23, 15, 0), 'bare 15:00')
  at('  15:00.  ', N, local(2026, 10, 23, 15, 0), 'bare time with spaces and a final period')
  at('resets 3 PM', N, local(2026, 10, 23, 15, 0), 'space and capitals')
  at('resets 3:30 p.m.', N, local(2026, 10, 23, 15, 30), 'p.m. with periods')
  at('resets at 3pm', N, local(2026, 10, 23, 15, 0), 'resets at')
  at('Oct 25, 3pm', N, local(2026, 10, 25, 15, 0), 'bare Oct 25, 3pm')
  at('resets Oct 25, 3pm', N, local(2026, 10, 25, 15, 0), 'resets Oct 25, 3pm')
  at('resets October 25, 3pm', N, local(2026, 10, 25, 15, 0), 'full month name')
  at('resets on Oct 25 at 3pm', N, local(2026, 10, 25, 15, 0), 'on <date> at <time>')
  at('Oct 25, 2027, 3:30pm', N, local(2027, 10, 25, 15, 30), 'bare Oct 25, 2027, 3:30pm')
  at('resets Oct 25, 2027, 3:30pm', N, local(2027, 10, 25, 15, 30), 'resets Oct 25, 2027, 3:30pm')
  at('resets Nov 2, 9am', N, utc(2026, 11, 2, 14, 0), 'a date after the DST change is read in EST')
  at('resets Feb 29, 2028, 3pm', N, local(2028, 2, 29, 15, 0), 'a leap day with its year')

  // Not after now -> tomorrow; noon and midnight.
  at('resets 10am', N, local(2026, 10, 24, 10, 0), 'a time equal to now means tomorrow')
  at('resets 9:59am', N, local(2026, 10, 24, 9, 59), 'a time just passed means tomorrow')
  at('resets 10:01am', N, local(2026, 10, 23, 10, 1), 'a time just ahead is today')
  at('resets 12pm', N, local(2026, 10, 23, 12, 0), '12pm is noon')
  at('resets 12am', N, local(2026, 10, 24, 0, 0), '12am is the coming midnight')
  at('resets 12:30am', N, local(2026, 10, 24, 0, 30), '12:30am is after the coming midnight')
  at('resets 0:00', N, local(2026, 10, 24, 0, 0), '0:00 is the coming midnight')
  at('resets 23:59', N, local(2026, 10, 23, 23, 59), '23:59 today')
  const late = local(2026, 10, 23, 23, 30)
  at('resets 12:15am', late, local(2026, 10, 24, 0, 15), 'across midnight')
  at('resets 11:45pm', late, local(2026, 10, 23, 23, 45), 'before midnight')
  at('resets 11pm', late, local(2026, 10, 24, 23, 0), 'passed at 23:30 means tomorrow')
  at('resets 9pm', local(2026, 10, 31, 22, 0), utc(2026, 11, 2, 2, 0), 'month rollover onto the DST end day (Nov 1 21:00 EST)')

  // Year rollover.
  const nye = local(2026, 12, 31, 23, 30)
  at('resets 12:30am', nye, local(2027, 1, 1, 0, 30), 'a bare time across the new year')
  at('resets Jan 1, 3am', nye, local(2027, 1, 1, 3, 0), 'Jan 1 without a year on Dec 31 is next year')
  at('resets Dec 31, 11:45pm', nye, local(2026, 12, 31, 23, 45), 'later today keeps this year')
  at('resets Dec 31, 11pm', nye, local(2027, 12, 31, 23, 0), 'passed today without a year means next year')
  at('resets Oct 20, 3pm', N, local(2027, 10, 20, 15, 0), 'a month/day already past means next year')
  at('resets Oct 23, 9am', N, local(2027, 10, 23, 9, 0), 'today but earlier, with a date, means next year')
  at('resets Oct 23, 3pm', N, local(2026, 10, 23, 15, 0), 'today and later, with a date, is today')
  at('resets Oct 20, 2026, 3pm', N, undefined, 'a full date already past has no next occurrence')
  at('Oct 23, 2026, 10:00', N, undefined, 'a full date equal to now has no next occurrence')

  // Local DST: the repeated hour (Nov 1 2026) and the skipped hour (Mar 14 2027).
  at('resets 1:30am', local(2026, 10, 31, 12, 0), utc(2026, 11, 1, 5, 30), 'repeated hour: the first 1:30 (EDT)')
  at('resets 1:30am', utc(2026, 11, 1, 5, 45), utc(2026, 11, 1, 6, 30), 'repeated hour after the first 1:30: the second one (EST)')
  at('resets 1:30am', utc(2026, 11, 1, 6, 45), utc(2026, 11, 2, 6, 30), 'after both 1:30s: tomorrow')
  const sat = local(2027, 3, 13, 12, 0)
  at('resets 2:30am', sat, utc(2027, 3, 14, 7, 30), 'skipped hour: 2:30 moves forward to 3:30 EDT')
  check(F.parseResetsAt('resets 2:30am', sat) === new Date(2027, 2, 14, 2, 30).getTime(), 'the skipped hour moves forward like Date does')
  at('resets 1:59am', sat, utc(2027, 3, 14, 6, 59), 'just before the gap (EST)')
  at('resets 3am', sat, utc(2027, 3, 14, 7, 0), 'just after the gap (EDT)')
}

function zoneChecks() {
  const BA = 'America/Argentina/Buenos_Aires'
  at(`resets 3pm (${BA})`, N, utc(2026, 10, 23, 18, 0), 'Buenos Aires (UTC-3, no DST)')
  at(`resets 15:00 (${BA})`, N, utc(2026, 10, 23, 18, 0), '24-hour time in a zone')
  at(`resets 10am (${BA})`, N, utc(2026, 10, 24, 13, 0), 'passed in the zone (11:00 there) means tomorrow there')
  at(`resets 10am (${BA})`, local(2026, 10, 23, 8, 30), utc(2026, 10, 23, 13, 0), 'still ahead in the zone (9:30 there) is today there')
  at(`resets 12am (${BA})`, N, utc(2026, 10, 24, 3, 0), 'midnight in the zone')
  at(`resets 3pm ( ${BA} )`, N, utc(2026, 10, 23, 18, 0), 'spaces inside the parentheses')
  at(`resets Oct 25, 2027, 3:30pm (${BA})`, N, utc(2027, 10, 25, 18, 30), 'full date in a zone')
  at('resets 3pm (UTC)', N, utc(2026, 10, 23, 15, 0), 'UTC')
  at('resets 1pm (UTC)', N, utc(2026, 10, 24, 13, 0), 'UTC passed means tomorrow')
  at('resets 9am (Pacific/Auckland)', N, utc(2026, 10, 23, 20, 0), "the zone's own date: Saturday 9:00 NZDT is Friday 20:00Z")
  at('resets 3:30pm (Asia/Kolkata)', N, utc(2026, 10, 24, 10, 0), 'half-hour offset, passed there (19:30 IST)')
  at('resets Oct 24, 3pm (Europe/London)', N, utc(2026, 10, 24, 14, 0), 'London before its DST end (BST)')
  at('resets Oct 25, 3pm (Europe/London)', N, utc(2026, 10, 25, 15, 0), 'London after its DST end (GMT)')
  at('resets Oct 25, 2026, 1:30am (Europe/London)', N, utc(2026, 10, 25, 0, 30), 'zone repeated hour: the first 1:30 (BST)')
  at('resets Oct 25, 2026, 1:30am (Europe/London)', utc(2026, 10, 25, 0, 45), utc(2026, 10, 25, 1, 30), 'zone repeated hour after the first: the second 1:30 (GMT)')
  at('resets Mar 28, 2027, 1:30am (Europe/London)', N, utc(2027, 3, 28, 1, 30), 'zone skipped hour: 1:30 moves forward to 2:30 BST')
  at('resets Mar 14, 2027, 2:30am (America/Chicago)', N, utc(2027, 3, 14, 8, 30), 'zone skipped hour in another zone: 3:30 CDT')
  at('resets Mar 14, 2027, 2:30am (America/New_York)', N, utc(2027, 3, 14, 7, 30), 'an explicit zone equal to the local one agrees with local time')
  const nye = utc(2026, 12, 31, 23, 30)
  at(`resets 12:30am (${BA})`, nye, utc(2027, 1, 1, 3, 30), 'zone year rollover (20:30 on Dec 31 there)')
  at('resets Jan 1, 9am (UTC)', nye, utc(2027, 1, 1, 9, 0), 'Jan 1 in UTC on Dec 31 UTC')
  at('resets Jan 1, 9am (Asia/Tokyo)', nye, utc(2027, 1, 1, 0, 0), "the zone's year: it is already Jan 1 2027 08:30 in Tokyo")
  at('resets Jan 1, 3am (Asia/Tokyo)', nye, utc(2027, 12, 31, 18, 0), 'passed in Tokyo on its Jan 1 means Jan 1 2028')
  at('resets 3pm (Mars/Olympus_Mons)', N, undefined, 'an invalid zone gives undefined')
  at('resets 3pm (local time)', N, undefined, 'a parenthesis that is not a zone gives undefined')
  at('resets 3pm ()', N, undefined, 'empty parentheses give undefined')
  at(`resets 3pm (${'A/'.repeat(40)}x)`, N, undefined, 'an overlong zone gives undefined')
}

function messageChecks() {
  at(LIMIT_TEXT, N, utc(2026, 10, 23, 18, 0), 'the S6 session-limit message')
  at("You've hit your limit · resets Oct 25, 3pm (America/Argentina/Buenos_Aires)", N, utc(2026, 10, 25, 18, 0), 'the S6 message more than a day ahead')
  at("You've hit your limit · resets Oct 25, 2027, 3:30pm (America/Argentina/Buenos_Aires).", N, utc(2027, 10, 25, 18, 30), 'the S6 message with a year')
  at('Usage resets weekly. Your session resets 4pm', N, local(2026, 10, 23, 16, 0), 'an anchor that does not parse is skipped for the next one')
  at('Try again at 3:30 PM.', N, local(2026, 10, 23, 15, 30), 'try again at')
  at('please try again later', N, undefined, '"try again later" has no time')
  at('Claude AI usage limit reached|1792771200', N, 1792771200000, 'the old pipe form')
  at('usage limit reached | 1792771200', N, 1792771200000, 'the pipe form with spaces')
  at('Claude AI usage limit reached|1700000000', N, undefined, 'a pipe epoch already past gives undefined')
  at('usage limit reached|123', N, undefined, 'a pipe with too few digits is not an epoch')
  at('Claude AI usage limit reached|1792771200 resets 3pm', N, 1792771200000, 'the pipe epoch wins over a printed time')
  at(`${'resets x '.repeat(20000)}resets 3pm`, N, local(2026, 10, 23, 15, 0), 'a long text still finds the time')
}

function junkChecks() {
  const junkTexts = [
    '', '   ', 'resets soon', 'resets 13pm', 'resets 0am', 'resets 3:60pm', 'resets 24:00', 'resets 3', 'resets 3pmx', 'resets 15:00pm', 'resets 15:005',
    'resets 3:3pm', 'resets Feb 30, 3pm', 'resets Feb 29, 3pm', 'resets Oct 32, 3pm', 'resets Foo 25, 3pm', 'resets 25 Oct, 3pm', 'resets in 2 hours',
    '3pm and more text', 'Error at 12:30', 'resets -3pm', 'resets 3:30:15pm', '\u0000resets\u0000', 'resets Oct 25, 99999, 3pm',
  ]
  for (const text of junkTexts) at(text, N, undefined, 'junk text')
  for (const text of [undefined, null, 42, {}, ['3pm'], () => '3pm']) check(F.parseResetsAt(text, N) === undefined, `non-string text ${typeof text} gives undefined`)
  for (const now of [NaN, Infinity, -Infinity, undefined, '1792771200000', null]) check(F.parseResetsAt('resets 3pm', now) === undefined, `a bad now (${String(now)}) gives undefined`)
  let threw = null
  const weird = [{ toString() { throw new Error('boom') } }, Symbol('x'), 'resets 3pm (\u0000)', 'resets Dec 31, 275760, 3pm', `resets 3pm (${'('.repeat(1000)}`, 'resets '.repeat(5000)]
  for (const text of weird) { try { F.parseResetsAt(text, N) } catch (e) { threw = e } }
  try { F.parseResetsAt('resets 3pm', 8.64e15) } catch (e) { threw = e }
  check(threw === null, `parseResetsAt never throws (${threw})`)
  check(F.parseResetsAt('resets 3pm', 8.64e15) === undefined, 'a clock at the end of the Date range gives undefined')
}

/** Every hour and half hour, in 12- and 24-hour form, from clocks around DST and the new year: strictly after now, within a day. */
function propertyChecks() {
  const nows = [N, utc(2026, 11, 1, 5, 45), local(2027, 3, 13, 23, 30), local(2027, 3, 14, 1, 59), local(2026, 12, 31, 23, 59), local(2028, 2, 28, 23, 15)]
  let ok = 0
  for (const now of nows) {
    for (let h = 0; h < 24; h++) {
      for (const mi of ['00', '30']) {
        const h24 = F.parseResetsAt(`resets ${h}:${mi}`, now)
        const h12 = F.parseResetsAt(`resets ${h % 12 || 12}:${mi}${h < 12 ? 'am' : 'pm'}`, now)
        assert.ok(h24 !== undefined && h24 > now && h24 - now <= 25 * 3600_000 && Number.isInteger(h24), `${h}:${mi} at ${iso(now)} gave ${iso(h24)}`)
        assert.equal(h12, h24, `${h}:${mi} reads the same in 12- and 24-hour form at ${iso(now)}`)
        ok++
      }
    }
  }
  checks += ok
  check(ok === nows.length * 48, 'every hour and half hour checked')
}

function main() {
  environmentChecks()
  kindsAndMapChecks()
  docTableChecks()
  claudeChecks()
  codexChecks()
  rateLimitChecks()
  formatChecks()
  zoneChecks()
  messageChecks()
  junkChecks()
  propertyChecks()
  console.log(`PASS: ${checks} failure checks (S6 table for Claude and Codex, text refinements, unknown codes, rate_limit_event, label keys, parseResetsAt formats, zones with DST, midnight and year rollover, pipe epoch, junk)`)
}

try { main() } catch (error) { console.error(error); process.exitCode = 1 }
