// Usage bars: Codex window classification (live endpoint + local rollouts), the
// Codex live/local policy, and the Claude fetch / poll policy. esbuild + vm, like
// test-status.cjs. Fixtures are shaped like the real `wham/usage` response and
// rollout `token_count` lines (ids, emails and tokens redacted or fake).
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  const fakeRequire = id => id === 'electron' ? { net: {}, app: { getVersion: () => '0.0.0-app' } } : require(id)
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: fakeRequire, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
// Renderer modules bundled with the i18n tables (the sidebar row view, no React rendering).
function loadRenderer(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, setTimeout, clearTimeout, window: { addEventListener() {}, snApi: {} }, localStorage: { getItem: () => null, setItem() {} }, document: {}, navigator: { language: 'en' } })
  return mod.exports
}
const tmpDirs = []
function tmp(name) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `snagentsos-usage-${name}-`)); tmpDirs.push(d); return d }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const nowSec = () => Math.floor(Date.now() / 1000)
const FUTURE = () => nowSec() + 3 * 86400
const PAST = () => nowSec() - 3600

// ---- fixtures ------------------------------------------------------------
// Real probe of GET chatgpt.com/backend-api/wham/usage on a weekly-only plan (user_id, account_id, email redacted).
const liveWeeklyOnly = () => ({
  user_id: '<redacted>', account_id: '<redacted>', email: '<redacted>', plan_type: 'prolite',
  rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 27, limit_window_seconds: 604800, reset_after_seconds: 471437, reset_at: FUTURE() }, secondary_window: null },
  code_review_rate_limit: null, additional_rate_limits: null,
  model_usage: { 'gpt-6-astra': { available: true, available_at: null, credits_would_enable: false } },
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0', approx_local_messages: [0, 0], approx_cloud_messages: [0, 0] },
  spend_control: { reached: false, individual_limit: null }, rate_limit_reached_type: null, promo: null,
  rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 },
})
const liveBoth = () => ({
  plan_type: 'plus',
  rate_limit: { primary_window: { used_percent: 12.4, limit_window_seconds: 18000, reset_at: nowSec() + 7200 }, secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: FUTURE() } },
})
const tcLine = (ts, limits) => JSON.stringify({ timestamp: ts, ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: limits } })
const limits = (primary, secondary = null, extra = {}) => ({ limit_id: 'codex', limit_name: null, primary, secondary, credits: null, plan_type: 'prolite', ...extra })
const weeklyWin = (used, resets = FUTURE()) => ({ used_percent: used, window_minutes: 10080, resets_at: resets })
const sessionWin = (used, resets = nowSec() + 7200) => ({ used_percent: used, window_minutes: 300, resets_at: resets })
const otherLine = n => JSON.stringify({ timestamp: '2026-10-18T00:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'm' + n } })
const both = { codex5h: true, codex7d: true }

async function main() {
  const W = load('src/main/usage/codexWindows.ts')
  const { visibleUsageRows } = load('src/shared/usageRows.ts')

  // ---- classification by duration ---------------------------------------
  {
    check(W.classifyWindowSeconds(18000) === '5h' && W.classifyWindowSeconds(86400) === '5h', 'up to 24h is the Session window')
    check(W.classifyWindowSeconds(604800) === '7d' && W.classifyWindowSeconds(6 * 86400) === '7d', 'six days or more is the Weekly window')
    check(W.classifyWindowSeconds(3 * 86400) === null && W.classifyWindowSeconds(0) === null && W.classifyWindowSeconds(undefined) === null && W.classifyWindowSeconds('x') === null, 'in-between, zero and non-numeric durations are unknown')

    const now = Date.now()
    const weekly = W.buildWindow({ usedPercent: 27, windowSeconds: 604800, resetsAtSec: now / 1000 + 100, fallbackKind: '5h' }, now)
    check(weekly.kind === '7d' && weekly.percent === 27, 'a long window is Weekly whatever its position or fallback says')
    const expired = W.buildWindow({ usedPercent: 83, windowSeconds: 604800, resetsAtSec: now / 1000 - 5 }, now)
    check(expired.percent === 0 && expired.resetsAt === null && expired.kind === '7d', 'a reset in the past reads 0% with no reset time')
    check(W.buildWindow({ usedPercent: 40, windowSeconds: 18000, resetsAtSec: undefined }, now).resetsAt === null, 'a window without a reset time keeps its percent and has no reset')
    check(W.buildWindow({ usedPercent: 40, windowSeconds: undefined, resetsAtSec: now / 1000 + 9, fallbackKind: '5h' }, now).kind === '5h', 'a legacy window without a duration falls back to its position')
    check(W.buildWindow({ usedPercent: 40, windowSeconds: undefined, resetsAtSec: 1 }, now) === null && W.buildWindow({ usedPercent: 'x', windowSeconds: 18000 }, now) === null, 'no duration and no fallback, or no percent, yields no window')
    check(W.buildWindow({ usedPercent: 140.6, windowSeconds: 18000, resetsAtSec: now / 1000 + 5 }, now).percent === 100, 'percent is clamped to 100')

    const cached = { planType: 'plus', at: now, windows: [{ kind: '7d', percent: 50, resetsAt: new Date(now - 1000).toISOString() }, { kind: '5h', percent: 20, resetsAt: new Date(now + 60000).toISOString() }] }
    const after = W.applyExpiry(cached, now)
    check(after.windows[0].percent === 0 && after.windows[0].resetsAt === null && after.windows[1].percent === 20, 'applyExpiry zeroes only the windows whose reset has passed')

    const weeklyOnly = { planType: 'prolite', at: now, windows: [{ kind: '7d', percent: 27, resetsAt: null }] }
    const rows = W.rowsFromSnapshot(both, weeklyOnly)
    check(rows.length === 1 && rows[0].id === 'codex.7d' && rows[0].kind === '7d' && rows[0].label === 'Weekly' && rows[0].percent === 27 && rows[0].planType === 'prolite' && rows[0].status === 'ok', 'a weekly-only plan yields exactly one Weekly row (no Session, no "No data" row)')
    const full = W.rowsFromSnapshot(both, { planType: 'plus', at: now, windows: [{ kind: '5h', percent: 10, resetsAt: null }, { kind: '7d', percent: 20, resetsAt: null }] })
    check(full.map(r => r.id).join() === 'codex.5h,codex.7d' && full[0].label === 'Session', 'a plan with both windows yields both rows, Session first')
    check(W.rowsFromSnapshot({ codex5h: true, codex7d: false }, weeklyOnly).length === 0, 'an enabled window the plan lacks is not emitted')
    const unknown = W.rowsFromSnapshot(both, { planType: 'pro', at: now, windows: [] })
    check(unknown.length === 2 && unknown.every(r => r.status === 'nodata' && r.planType === 'pro'), 'a snapshot with no recognizable window is "unknown": nodata rows that still carry the plan')
    check(W.emptyCodexRows(both, 'nodata').length === 2 && W.emptyCodexRows({ codex5h: false, codex7d: false }, 'nodata').length === 0, 'emptyCodexRows follows the enabled flags')

    const mixed = [{ provider: 'codex', status: 'ok', id: 'a' }, { provider: 'codex', status: 'nodata', id: 'b' }, { provider: 'claude', status: 'nodata', id: 'c' }, { provider: 'claude', status: 'nodata', id: 'd' }, { provider: 'claude', status: 'expired', id: 'e' }]
    check(visibleUsageRows(mixed).map(r => r.id).join() === 'a,c,d,e', 'visibleUsageRows drops nodata beside an answered sibling and keeps it when nothing is ok')
  }

  // ---- live response parsing ---------------------------------------------
  {
    const { parseCodexLive } = load('src/main/usage/codexLive.ts')
    const now = Date.now()
    const snap = parseCodexLive(liveWeeklyOnly(), now)
    check(snap.planType === 'prolite' && snap.windows.length === 1 && snap.windows[0].kind === '7d' && snap.windows[0].percent === 27 && !!snap.windows[0].resetsAt, 'the real weekly-only response parses to one 7d window with the plan')
    const rows = W.rowsFromSnapshot(both, snap)
    check(rows.length === 1 && rows[0].label === 'Weekly', 'and renders as a single Weekly row')
    const two = parseCodexLive(liveBoth(), now)
    check(two.windows.map(w => w.kind).join() === '5h,7d' && two.windows[0].percent === 12 && two.planType === 'plus', 'a two-window response classifies each window by limit_window_seconds')
    const swapped = liveBoth(); const p = swapped.rate_limit.primary_window; swapped.rate_limit.primary_window = swapped.rate_limit.secondary_window; swapped.rate_limit.secondary_window = p
    const sw = parseCodexLive(swapped, now)
    check(sw.windows.find(w => w.kind === '5h').percent === 12 && sw.windows.find(w => w.kind === '7d').percent === 60, 'swapping primary and secondary changes nothing')
    const afterOnly = parseCodexLive({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 604800, reset_after_seconds: 120 } } }, now)
    check(afterOnly.windows[0].resetsAt === new Date(Math.floor(now / 1000) * 1000 + 120000).toISOString(), 'reset_after_seconds is used when reset_at is absent')
    const stale = parseCodexLive({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 604800, reset_at: nowSec() - 10 } } }, now)
    check(stale.windows[0].percent === 0 && stale.windows[0].resetsAt === null, 'an expired reset in a live response reads 0%')
    check(parseCodexLive(null, now) === null && parseCodexLive({ plan_type: 'x' }, now) === null && parseCodexLive([], now) === null, 'a body without rate_limit is not a snapshot')
    check(parseCodexLive({ rate_limit: { primary_window: null, secondary_window: null } }, now).windows.length === 0, 'a plan with no windows parses to an empty (unknown) snapshot')
  }

  // ---- live fetch: headers, auth, fallbacks, no token in logs -------------
  {
    const logs = []
    const spy = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), debug: (...a) => logs.push(a.join(' ')) }
    const L = load('src/main/usage/codexLive.ts', { console: spy })
    const home = tmp('codex-auth')
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      check((await L.fetchCodexLive({ get: async () => { throw new Error('should not be called') } })).reason === 'noauth', 'no auth.json means "noauth" and no request')
      write(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'ID-FAKE', access_token: 'AT-FAKE-1', refresh_token: 'RT-FAKE', account_id: 'ACCT-FAKE' } }))
      const calls = []
      let status = 200
      const get = async (url, headers) => { calls.push({ url, headers }); return { status, json: liveWeeklyOnly() } }
      const ok = await L.fetchCodexLive({ get })
      check(ok.ok && ok.snapshot.windows.length === 1 && ok.snapshot.planType === 'prolite', 'a 200 returns the parsed snapshot')
      check(calls[0].url === 'https://chatgpt.com/backend-api/wham/usage' && calls[0].headers.Authorization === 'Bearer AT-FAKE-1' && calls[0].headers['ChatGPT-Account-Id'] === 'ACCT-FAKE' && /^codex_cli_rs\//.test(calls[0].headers['User-Agent']), 'the request carries the bearer token, account id header and a codex user agent')

      status = 401
      const denied = await L.fetchCodexLive({ get })
      check(!denied.ok && denied.reason === 'unauthorized', '401 means fall back to local')
      const before = calls.length
      const again = await L.fetchCodexLive({ get })
      check(!again.ok && again.reason === 'unauthorized' && calls.length === before, 'the same rejected token is not retried')
      write(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'AT-FAKE-2', account_id: 'ACCT-FAKE' } }))
      status = 200
      check((await L.fetchCodexLive({ get })).ok && calls.length === before + 1, 'a refreshed token is tried right away')
      status = 403
      write(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'AT-FAKE-3', account_id: 'ACCT-FAKE' } }))
      check((await L.fetchCodexLive({ get })).reason === 'unauthorized', '403 is also an auth failure')
      status = 500
      write(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'AT-FAKE-4', account_id: 'ACCT-FAKE' } }))
      check((await L.fetchCodexLive({ get })).reason === 'unavailable', 'a 5xx is "unavailable"')
      check((await L.fetchCodexLive({ get: async () => { throw new Error('socket hang up') } })).reason === 'unavailable', 'a network error is "unavailable"')
      check((await L.fetchCodexLive({ get: async () => ({ status: 200, json: { nope: true } }) })).reason === 'unavailable', 'an unexpected body is "unavailable"')
      write(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fake' }))
      check((await L.fetchCodexLive({ get })).reason === 'noauth', 'an API-key login (no ChatGPT tokens) is "noauth"')
      check(!logs.some(l => /AT-FAKE|RT-FAKE|ID-FAKE|ACCT-FAKE|sk-fake/.test(l)), 'no token or account id is ever logged')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev
    }
  }

  // ---- local fallback ------------------------------------------------------
  {
    const C = load('src/main/usage/codex.ts')
    const home = tmp('codex-local')
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    const sessions = path.join(home, 'sessions')
    try {
      check((await C.fetchCodexRows(both)).every(r => r.status === 'nodata') && (await C.fetchCodexRows(both)).length === 2, 'no sessions folder: nodata rows')
      check((await C.fetchCodexRows({ codex5h: false, codex7d: false })).length === 0, 'no rows enabled: nothing to read')

      // Newest folder: newest mtime but no token_count. Yesterday: the newest snapshot by timestamp, but the OLDEST mtime.
      const empty = path.join(sessions, '2026', '10', '19', 'rollout-2026-10-19T09-00-00-empty.jsonl')
      const a = path.join(sessions, '2026', '10', '19', 'rollout-2026-10-19T08-00-00-a.jsonl')
      const b = path.join(sessions, '2026', '10', '18', 'rollout-2026-10-18T22-00-00-b.jsonl')
      const c = path.join(sessions, '2026', '10', '17', 'rollout-2026-10-17T23-00-00-c.jsonl')
      write(empty, [otherLine(1), otherLine(2)].join('\n') + '\n')
      write(a, [otherLine(1), tcLine('2026-10-19T10:00:00.000Z', limits(weeklyWin(30)))].join('\n') + '\n')
      write(b, [otherLine(1), tcLine('2026-10-19T11:00:00.000Z', limits(weeklyWin(41))), otherLine(3)].join('\n') + '\n')
      write(c, tcLine('2026-10-19T23:00:00.000Z', limits(weeklyWin(99))) + '\n')
      const t0 = Date.now() / 1000
      fs.utimesSync(b, t0 - 5000, t0 - 5000)
      fs.utimesSync(a, t0 - 100, t0 - 100)
      fs.utimesSync(c, t0 - 9000, t0 - 9000)
      fs.utimesSync(empty, t0, t0)
      const rows = await C.fetchCodexRows(both)
      check(rows.length === 1 && rows[0].id === 'codex.7d' && rows[0].percent === 41, 'the token_count with the newest timestamp wins across files, folders and mtimes (mtime and an empty newest file do not mislead)')
      check(rows[0].planType === 'prolite' && rows[0].label === 'Weekly', 'the weekly-only snapshot is one Weekly row with the plan')
      const snap = await C.readCodexLocal()
      check(snap.windows.length === 1 && snap.windows[0].percent === 41, 'readCodexLocal returns the same snapshot (the third day folder is never scanned)')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev
    }
  }
  {
    const C = load('src/main/usage/codex.ts')
    const prev = process.env.CODEX_HOME
    try {
      // Both windows, secondary expired.
      const home = tmp('codex-expiry'); process.env.CODEX_HOME = home
      write(path.join(home, 'sessions', '2026', '10', '19', 'rollout-x.jsonl'), tcLine('2026-10-19T10:00:00.000Z', limits(sessionWin(64), weeklyWin(88, PAST()))) + '\n')
      const rows = await C.fetchCodexRows(both)
      check(rows.length === 2 && rows[0].percent === 64 && rows[1].percent === 0 && rows[1].resetsAt === null, 'an expired reset in a rollout snapshot reads 0% with no reset time')

      // Primary/secondary swapped: still classified by window_minutes.
      const home2 = tmp('codex-swapped'); process.env.CODEX_HOME = home2
      write(path.join(home2, 'sessions', '2026', '10', '19', 'rollout-x.jsonl'), tcLine('2026-10-19T10:00:00.000Z', limits(weeklyWin(70), sessionWin(15))) + '\n')
      const sw = await C.fetchCodexRows(both)
      check(sw[0].id === 'codex.5h' && sw[0].percent === 15 && sw[1].id === 'codex.7d' && sw[1].percent === 70, 'positions do not decide the row: durations do')

      // Per-model limits (other limit_id) are ignored even when newer.
      const home3 = tmp('codex-limitid'); process.env.CODEX_HOME = home3
      write(path.join(home3, 'sessions', '2026', '10', '19', 'rollout-x.jsonl'), [tcLine('2026-10-19T10:00:00.000Z', limits(weeklyWin(20))), tcLine('2026-10-19T12:00:00.000Z', limits(weeklyWin(95), null, { limit_id: 'codex_other' }))].join('\n') + '\n')
      check((await C.fetchCodexRows(both))[0].percent === 20, 'a newer snapshot of another limit_id does not replace the account quota')

      // A rollout whose only token_count carries no usable window: unknown, but the plan survives.
      const home4 = tmp('codex-nowin'); process.env.CODEX_HOME = home4
      write(path.join(home4, 'sessions', '2026', '10', '19', 'rollout-x.jsonl'), tcLine('2026-10-19T10:00:00.000Z', limits(null, null, { plan_type: 'team' })) + '\n')
      const nw = await C.fetchCodexRows(both)
      check(nw.length === 2 && nw.every(r => r.status === 'nodata' && r.planType === 'team'), 'a snapshot with no windows is nodata with the plan type on every row')

      // Tail read with a partial first line: a 600KB line, then the snapshot.
      const home5 = tmp('codex-tail'); process.env.CODEX_HOME = home5
      const big = JSON.stringify({ timestamp: '2026-10-19T09:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(600 * 1024) } })
      write(path.join(home5, 'sessions', '2026', '10', '19', 'rollout-x.jsonl'), [tcLine('2026-10-19T08:00:00.000Z', limits(weeklyWin(5))), big, tcLine('2026-10-19T10:00:00.000Z', limits(weeklyWin(55)))].join('\n') + '\n')
      check((await C.fetchCodexRows(both))[0].percent === 55, 'the tail read cuts the partial first line and finds the last snapshot in a file bigger than the tail')

      // The only snapshot sits before a line larger than the first tail window: the second, larger window finds it.
      const home6 = tmp('codex-tail2'); process.env.CODEX_HOME = home6
      const pad = JSON.stringify({ timestamp: '2026-10-19T08:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: limits(weeklyWin(90)), info: 'y'.repeat(300 * 1024) } })
      write(path.join(home6, 'sessions', '2026', '10', '19', 'rollout-x.jsonl'), [pad, otherLine(1)].join('\n') + '\n')
      check((await C.fetchCodexRows(both))[0].percent === 90, 'a snapshot beyond the first tail window is still found by the larger second read')

      // tailLines: the first line of a window is dropped only when the window cuts it.
      const tl = path.join(tmp('codex-taillines'), 'f.jsonl')
      write(tl, 'AAA\nBBB\nCCC\n')
      const lines = async n => (await C.tailLines(tl, n)).lines.filter(Boolean).join()
      check(await lines(100) === 'AAA,BBB,CCC' && (await C.tailLines(tl, 100)).wholeFile === true, 'a window larger than the file reads it whole')
      check(await lines(8) === 'BBB,CCC' && (await C.tailLines(tl, 8)).wholeFile === false, 'a window that starts exactly on a line boundary keeps that first line')
      check(await lines(7) === 'CCC' && await lines(5) === 'CCC' && await lines(3) === '', 'a window that cuts a line drops the partial first line')

      // Malformed trailing line (Codex mid-write) is skipped.
      const home8 = tmp('codex-torn'); process.env.CODEX_HOME = home8
      write(path.join(home8, 'sessions', '2026', '10', '19', 'rollout-x.jsonl'), tcLine('2026-10-19T10:00:00.000Z', limits(weeklyWin(33))) + '\n' + '{"timestamp":"2026-10-19T10:00:05.000Z","type":"event_msg","payload":{"type":"token_count","rate_li')
      check((await C.fetchCodexRows(both))[0].percent === 33, 'a torn last line falls back to the previous snapshot')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev
    }
  }

  // ---- Codex live / local policy ------------------------------------------
  {
    const { CodexUsage, MIN_CODEX_LIVE_MS, FORCE_MIN_GAP_MS } = load('src/main/usage/codexUsage.ts')
    check(MIN_CODEX_LIVE_MS === 60000 && FORCE_MIN_GAP_MS === 5000, 'live cadence floor is 60s and forced refreshes keep a 5s gap')
    let clock = 1_000_000, liveCalls = 0, localCalls = 0, liveOk = true
    const liveSnap = pct => ({ planType: 'prolite', at: clock, windows: [{ kind: '7d', percent: pct, resetsAt: null }] })
    const localSnap = { planType: 'prolite', at: 1, windows: [{ kind: '7d', percent: 11, resetsAt: null }] }
    const usage = new CodexUsage({
      now: () => clock,
      live: async () => { liveCalls++; return liveOk ? { ok: true, snapshot: liveSnap(40 + liveCalls) } : { ok: false, reason: 'unauthorized' } },
      local: async () => { localCalls++; return localSnap },
    })
    let rows = await usage.refresh(both, 10000)
    check(liveCalls === 1 && localCalls === 0 && rows.length === 1 && rows[0].percent === 41, 'live is preferred and local is not read')
    clock += 10000
    rows = await usage.refresh(both, 10000)
    check(liveCalls === 1 && localCalls === 0 && rows[0].percent === 41, 'the 10s tick reuses the live snapshot (live runs at most every 60s)')
    clock += 50001
    rows = await usage.refresh(both, 10000)
    check(liveCalls === 2 && rows[0].percent === 42, 'after 60s the live endpoint is asked again')
    clock += 1000
    await usage.refresh(both, 10000, true)
    check(liveCalls === 2, 'a forced refresh inside the 5s gap does not hit the endpoint')
    clock += 6000
    rows = await usage.refresh(both, 10000, true)
    check(liveCalls === 3 && rows[0].percent === 43, 'a forced refresh after the gap does')
    clock += 120000
    liveOk = false
    rows = await usage.refresh(both, 10000)
    check(liveCalls === 4 && localCalls === 1 && rows[0].percent === 11, 'when live fails the local rollouts answer')
    clock += 10000
    rows = await usage.refresh(both, 10000)
    check(liveCalls === 4 && localCalls === 2 && rows[0].percent === 11, 'with live down, the local fallback runs on the configured cadence and live waits its 60s')
    clock += 60000
    liveOk = true
    rows = await usage.refresh(both, 10000)
    check(liveCalls === 5 && rows[0].percent === 45, 'live recovery is picked up on its next slot')
    check((await usage.refresh({ codex5h: false, codex7d: false }, 10000)).length === 0, 'nothing enabled, nothing fetched')
    clock += 200000
    const slow = new CodexUsage({ now: () => clock, live: async () => { liveCalls++; return { ok: true, snapshot: liveSnap(7) } }, local: async () => localSnap })
    const before = liveCalls
    await slow.refresh(both, 300000); clock += 120000; await slow.refresh(both, 300000)
    check(liveCalls === before + 1, 'a configured interval above 60s stretches the live cadence')
    const none = new CodexUsage({ now: () => clock, live: async () => ({ ok: false, reason: 'noauth' }), local: async () => null })
    const nothing = await none.refresh(both, 10000)
    check(nothing.length === 2 && nothing.every(r => r.status === 'nodata'), 'no live and no local data: nodata rows')
  }

  // ---- Claude fetch ----------------------------------------------------------
  {
    const V = load('src/main/usage/claudeVersion.ts')
    check(V.parseClaudeVersion('2.0.31 (Claude Code)\n') === '2.0.31' && V.parseClaudeVersion('nonsense') === null, 'claude --version output is parsed')
    let spawns = 0
    check(await V.claudeCliVersion(async () => { spawns++; return '3.4.5 (Claude Code)' }) === '3.4.5' && await V.claudeCliVersion(async () => { spawns++; return '9.9.9' }) === '3.4.5' && spawns === 1, 'the CLI version is detected once and cached')
    V.resetClaudeVersionCache()
    check(await V.claudeCliVersion(async () => { throw new Error('ENOENT') }) === V.FALLBACK_CLAUDE_VERSION && V.FALLBACK_CLAUDE_VERSION === '2.0.0', 'a missing CLI falls back to a constant')
    V.resetClaudeVersionCache()

    const H = load('src/main/usage/httpJson.ts')
    check(H.parseRetryAfter('30') === 30000 && H.parseRetryAfter(['5']) === 5000 && H.parseRetryAfter(undefined) === undefined && H.parseRetryAfter('soon') === undefined, 'Retry-After delta-seconds are parsed, junk ignored')
    check(H.parseRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0) === 60000 && H.parseRetryAfter('Thu, 01 Jan 1970 00:00:00 GMT', 100000) === 0, 'Retry-After HTTP dates are parsed against now')
    check(H.parseRetryAfter('999999999') === 24 * 3600 * 1000, 'an absurd Retry-After is capped')

    const K = load('src/main/usage/claude.ts')
    const home = tmp('claude-home')
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = home
    const credPath = path.join(home, '.credentials.json')
    const cred = (token, expiresAt = Date.now() + 3600_000, sub = 'max') => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt, subscriptionType: sub } })
    const flags = { claude5h: true, claude7d: true, claudeOpus7d: false, claudeSonnet7d: false }
    const good = () => ({ five_hour: { utilization: 41.2, resets_at: '2026-10-19T20:00:00Z' }, seven_day: { utilization: 12, resets_at: '2026-10-25T20:00:00Z' }, seven_day_opus: null, seven_day_sonnet: null })
    const noSleep = async () => {}
    try {
      check((await K.fetchClaudeUsage(flags, { get: async () => { throw new Error('no') }, version: async () => '1' })).rows.every(r => r.status === 'nodata'), 'no credentials file: nodata, no request')

      write(credPath, cred('TOK-1'))
      const calls = []
      const get = async (url, headers) => { calls.push({ url, headers }); return { status: 200, json: good() } }
      const ok = await K.fetchClaudeUsage(flags, { get, version: async () => '2.7.1', sleep: noSleep })
      check(ok.rows.length === 2 && ok.rows[0].percent === 41 && ok.rows[0].planType === 'max' && ok.rows[1].status === 'ok', 'a good response yields the two enabled rows with the plan')
      check(calls[0].headers['User-Agent'] === 'claude-code/2.7.1' && calls[0].headers.Authorization === 'Bearer TOK-1' && !/0\.0\.0-app/.test(calls[0].headers['User-Agent']), 'the user agent carries the Claude Code version, not the app version')
      const opus = await K.fetchClaudeUsage({ ...flags, claudeOpus7d: true }, { get, version: async () => '2.7.1', sleep: noSleep })
      check(opus.rows.length === 3 && opus.rows[2].status === 'nodata', 'a bucket the response lacks stays a nodata row (the UI hides it beside answered siblings)')

      // 429: honored, not retried inside the call.
      let n = 0
      const limited = await K.fetchClaudeUsage(flags, { get: async () => { n++; return { status: 429, json: null, retryAfterMs: 90000 } }, version: async () => '1', sleep: noSleep })
      check(n === 1 && limited.rateLimited === true && limited.retryAfterMs === 90000 && limited.rows.every(r => r.status === 'error'), '429 is not retried in-call and reports Retry-After for the poller')
      n = 0
      const flaky = await K.fetchClaudeUsage(flags, { get: async () => { n++; return n < 3 ? { status: 503, json: null } : { status: 200, json: good() } }, version: async () => '1', sleep: noSleep })
      check(n === 3 && flaky.rows[0].status === 'ok', '5xx is retried (bounded)')

      // Expired by timestamp: re-read once, no request.
      write(credPath, cred('TOK-OLD', Date.now() - 1000))
      let asked = 0
      const exp = await K.fetchClaudeUsage(flags, { get: async () => { asked++; return { status: 200, json: good() } }, version: async () => '1', sleep: noSleep })
      check(asked === 0 && exp.rows.every(r => r.status === 'expired' && r.planType === 'max'), 'a token past expiresAt reports expired without a request')

      // 401 while Claude Code rotated the token meanwhile: retried once with the new token.
      write(credPath, cred('TOK-A'))
      const seen = []
      const rotated = await K.fetchClaudeUsage(flags, { get: async (_u, h) => { seen.push(h.Authorization); if (seen.length === 1) { write(credPath, cred('TOK-B')); return { status: 401, json: null } } return { status: 200, json: good() } }, version: async () => '1', sleep: noSleep })
      check(seen.join() === 'Bearer TOK-A,Bearer TOK-B' && rotated.rows[0].status === 'ok', 'a 401 re-reads the credentials once and retries with a rotated token')
      write(credPath, cred('TOK-C'))
      let denied = 0
      const still = await K.fetchClaudeUsage(flags, { get: async () => { denied++; return { status: 401, json: null } }, version: async () => '1', sleep: noSleep })
      check(denied === 1 && still.rows.every(r => r.status === 'expired'), 'a 401 with an unchanged token is expired (no loop)')
      check((await K.fetchClaudeUsage(flags, { get: async () => { throw new Error('offline') }, version: async () => '1', sleep: noSleep })).rows.every(r => r.status === 'error'), 'a thrown network error is an error row')
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev
    }
  }

  // ---- Claude poll policy -----------------------------------------------------
  {
    const P = load('src/main/usage/claudePoll.ts')
    const row = (status, percent = null, extra = {}) => ({ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent, resetsAt: null, planType: 'max', status, ...extra })
    const okRes = pct => ({ rows: [row('ok', pct)] })
    const errRes = extra => ({ rows: [row('error')], ...extra })
    const BASE = 60000
    let now = 0
    const poll = new P.ClaudePoll()
    check(poll.apply(okRes(40), BASE, now) === BASE && poll.rows[0].percent === 40 && !poll.rows[0].stale, 'a good poll shows fresh rows at the base cadence')

    now += BASE
    let next = poll.apply(errRes(), BASE, now)
    check(poll.rows[0].percent === 40 && poll.rows[0].stale === true && poll.rows[0].status === 'ok', 'the first failure holds the last good rows, flagged stale')
    check(next === 60000 && !poll.canFetch(now + 59999) && poll.canFetch(now + 60000), 'the first failure waits one base interval before the endpoint is asked again')
    now += next
    next = poll.apply(errRes(), BASE, now)
    check(poll.rows[0].stale === true && poll.rows[0].percent === 40 && next === 120000, 'the second failure is still within grace and the wait doubles')
    now += next
    next = poll.apply(errRes(), BASE, now)
    check(poll.rows[0].status === 'error' && next === 240000, 'the third consecutive failure surfaces Error and the wait doubles again')
    now += next
    next = poll.apply(errRes(), BASE, now)
    check(next === 480000, 'it keeps doubling')
    now += next
    next = poll.apply(errRes(), BASE, now)
    check(next === 600000, 'the doubling stops at 10 minutes')
    check(poll.skipDelay(BASE, now + 1000) === 599000, 'a skipped tick re-arms for the rest of the back-off')

    now += next
    next = poll.apply(okRes(55), BASE, now)
    check(next === BASE && poll.rows[0].percent === 55 && !poll.rows[0].stale && poll.canFetch(now), 'a success resets the back-off and the stale flag')
    now += BASE
    next = poll.apply(errRes({ rateLimited: true, retryAfterMs: 5 * 60000 }), BASE, now)
    check(next === 300000 && !poll.canFetch(now + 299999) && poll.canFetch(now + 300000), 'a Retry-After larger than the back-off is honored')
    now += next
    poll.apply(okRes(56), BASE, now)
    poll.apply(errRes({ rateLimited: true, retryAfterMs: 5 * 3600 * 1000 }), BASE, now)
    check(poll.skipDelay(BASE, now) === P.MAX_RETRY_AFTER_MS && P.MAX_RETRY_AFTER_MS === 30 * 60000, 'an enormous Retry-After is capped at 30 minutes')

    const fresh = new P.ClaudePoll()
    check(fresh.apply(errRes(), BASE, 0) === BASE && fresh.rows[0].status === 'error' && !fresh.rows[0].stale, 'a failure with no good rows to hold shows Error at once')

    const ex = new P.ClaudePoll()
    const expiredRes = { rows: [row('expired')] }
    check(ex.apply(expiredRes, BASE, 0) === P.EXPIRED_RETRY_MS && P.EXPIRED_RETRY_MS === 30000 && ex.rows[0].status === 'expired', 'expired shows at once and schedules one early retry in 30s')
    check(ex.apply(expiredRes, BASE, 30000) === BASE, 'a second expired in a row goes back to the normal cadence')
    ex.apply(okRes(10), BASE, 90000)
    check(ex.apply(expiredRes, BASE, 150000) === P.EXPIRED_RETRY_MS, 'after a success the early retry is armed again')
    check(new P.ClaudePoll().apply({ rows: [row('expired')] }, 20000, 0) === 20000, 'the early retry never lengthens a short base interval')
  }

  // ---- sidebar row view: labels by kind, stale tooltip ---------------------------
  {
    const { viewRow, en, es } = loadRenderer("export { viewRow } from './components/sidebar/UsageBars'\nexport { en } from './i18n/en'\nexport { es } from './i18n/es'")
    const t = key => en[key]
    const row = (id, kind, extra = {}) => ({ id, provider: id.split('.')[0], kind, label: 'RAW', percent: 27, resetsAt: null, planType: 'prolite', status: 'ok', ...extra })
    check(viewRow(row('codex.7d', '7d'), t).label === 'Weekly' && viewRow(row('codex.5h', '5h'), t).label === 'Session', 'labels follow the window kind')
    check(viewRow(row('codex.5h', '7d'), t).label === 'Weekly' && viewRow(row('codex.7d', '5h'), t).label === 'Session', 'a mislabeled id never decides the label: the kind does')
    check(viewRow(row('claude.opus7d', '7d'), t).label === 'Weekly Opus' && viewRow(row('claude.sonnet7d', '7d'), t).label === 'Weekly Sonnet', 'per-model weekly buckets keep their model name')
    check(viewRow(row('custom.abc', 'custom', { provider: 'custom' }), t).label === 'RAW', 'custom rows keep their own label')
    check(viewRow(row('claude.5h', '5h', { stale: true }), t).title === en['aiusage.stale'] && viewRow(row('claude.5h', '5h'), t).title === undefined, 'a held (stale) row carries the tooltip, a fresh row does not')
    check(typeof es['aiusage.stale'] === 'string' && es['aiusage.stale'].length > 0 && en['aiusage.stale'] !== es['aiusage.stale'], 'the stale tooltip exists in es and en')
  }

  console.log(`PASS: ${checks} usage checks (Codex window classification, live parsing and fetch, rollout tail fallback, live/local policy, Claude fetch and poll policy, sidebar row labels)`)
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })
