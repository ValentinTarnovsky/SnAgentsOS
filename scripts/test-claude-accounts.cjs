// Claude multi-account (app 2.3.0, item 9; app 2.4.0: N accounts in priority
// order, vault v2 in accounts.v2.json with v1 frozen): schema 17, the switch policy, the
// encrypted vault, capture / switch / reconcile with the SPIKE rules (re-capture
// on every change and before leaving, rollback when the target's refresh empties
// the file, locked on a decrypt failure, no plaintext backup next to Claude's
// file), the usage seams and the IPC / WS validation. esbuild + vm like
// test-usage.cjs. Every Claude folder is a temporary CLAUDE_CONFIG_DIR (the real
// ~/.claude is never read or written), tokens are fake and never printed.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

// The vm sees a process whose env we control (CLAUDE_CONFIG_DIR per case).
const env = { CLAUDE_CONFIG_DIR: '' }
const proc = Object.create(process)
proc.env = env
const ipcHandlers = new Map()
const fakeElectron = {
  net: {},
  app: { getVersion: () => '0.0.0-app', getPath: () => os.tmpdir() },
  safeStorage: {},
  ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), on: (ch, fn) => ipcHandlers.set(ch, fn) },
}
function load(contents, extra = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  const fakeRequire = id => (id === 'electron' ? fakeElectron : require(id))
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: fakeRequire, console: { ...console, warn() {} }, process: proc, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, ...extra })
  return mod.exports
}

const M = load(`
export * from './src/main/accounts/AccountService'
export { AccountVault, parseMeta, parseMetaV2, migrateV1 } from './src/main/accounts/AccountVault'
export * from './src/main/accounts/switchPolicy'
export * as files from './src/main/accounts/claudeFiles'
export { fetchClaudeProfile } from './src/main/accounts/profile'
export * from './src/shared/claude-accounts'
export { fetchClaudeUsage } from './src/main/usage/claude'
export { ClaudePoll } from './src/main/usage/claudePoll'
export { claudeFetchFlags, displayRows, registerUsageIpc } from './src/main/ipc/registerUsageIpc'
export { registerAccountsIpc } from './src/main/ipc/registerAccountsIpc'
export { parseConfig, CONFIG_VERSION } from './src/main/store/schema'
export { parseRemoteClientMsg } from './src/shared/remote-protocol-schemas'
export { CH } from './src/shared/ipc-channels'
`)

const tmpDirs = []
function tmp(name) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `snagentsos-accounts-${name}-`)); tmpDirs.push(d); return d }
const sleep = ms => new Promise(r => setTimeout(r, ms))
// Waits for what a usage reading set off: the policy's switch in flight
// (`evaluating`, cleared once switchWith settled, which may decide again) and
// the serialized mutations (`chain`). A fixed sleep lost the race on a loaded
// runner (app 2.5.0 release build).
async function settle(svc) {
  for (let i = 0; i < 500; i++) {
    await svc.chain
    await sleep(1)
    if (!svc.evaluating) {
      await svc.chain
      return
    }
  }
  throw new Error('settle: the account service never went idle')
}
const T0 = 1_800_000_000_000
let now = T0
const H = 3600_000, MIN = 60_000

// Fake tokens: 'at-<acct><n>' / 'rt-<acct><n>'. The profile fake maps the account letter to an identity.
const cred = (acct, n, opts = {}) => JSON.stringify({ claudeAiOauth: { accessToken: `at-${acct}${n}`, refreshToken: `rt-${acct}${n}`, expiresAt: opts.expiresAt ?? T0 + 1000 * H, scopes: ['user:inference'], subscriptionType: opts.sub ?? 'max', rateLimitTier: 'tier' } })
const EMPTY = JSON.stringify({ claudeAiOauth: { expiresAt: 0, scopes: [] } })
const IDS = { A: { accountUuid: 'uuid-a', organizationUuid: 'org-a', email: 'ana@example.com' }, B: { accountUuid: 'uuid-b', organizationUuid: 'org-b', email: 'beto@example.com' }, C: { accountUuid: 'uuid-c', organizationUuid: 'org-c', email: 'carla@example.com' } }
for (const L of 'EFGHIJ') IDS[L] = { accountUuid: 'uuid-' + L.toLowerCase(), organizationUuid: 'org-' + L.toLowerCase(), email: L.toLowerCase() + '@example.com' }
let profileUp = true
let profileCalls = 0
async function fakeProfile(token) {
  profileCalls++
  if (!profileUp) return { ok: false, status: 'network' }
  const who = IDS[token.slice(3, 4)]
  return who ? { ok: true, ...who, organizationName: 'Org', rateLimitTier: 'tier' } : { ok: false, status: 401 }
}
const fakeCrypto = (opts = {}) => ({
  available: () => opts.available !== false,
  encrypt: s => Buffer.from('FAKEENC:' + Buffer.from(s, 'utf8').toString('base64')),
  decrypt: b => { if (opts.broken) throw new Error('decrypt'); const t = b.toString('utf8'); if (!t.startsWith('FAKEENC:')) throw new Error('decrypt'); return Buffer.from(t.slice(8), 'base64').toString('utf8') },
})

function makeService(opts = {}) {
  const dir = opts.dir ?? tmp('claude')
  env.CLAUDE_CONFIG_DIR = dir
  const vaultDir = opts.vaultDir ?? tmp('vault')
  const crypto = opts.crypto ?? fakeCrypto()
  const vault = new M.AccountVault(vaultDir, crypto, () => now)
  const out = { dir, vaultDir, vault, events: [], alerts: [], emits: [], refreshes: 0, republishes: 0, statuses: opts.statuses ?? [], lang: opts.lang ?? 'en' }
  out.file = path.join(dir, '.credentials.json')
  out.svc = new M.AccountService({
    vault, crypto, profile: fakeProfile, fetchUsage: opts.fetchUsage, files: opts.files,
    statuses: () => out.statuses, emit: s => out.emits.push(s), event: e => out.events.push(e), alert: a => out.alerts.push(a),
    config: () => ({ settings: { language: out.lang } }), now: () => now, platform: opts.platform ?? 'win32', watch: null, autoStart: false, verifyDelayMs: 5,
    usageEnabled: () => true, usageIntervalMs: () => 60000,
  })
  out.svc.setUsageControl({ refreshActive: async () => { out.refreshes++ }, republish: () => { out.republishes++ } })
  out.write = text => fs.writeFileSync(out.file, text)
  out.read = () => fs.readFileSync(out.file, 'utf8')
  return out
}
/** A world with A captured first (#1) and B (the live login now) second (#2). */
async function twoAccounts(opts = {}) {
  const w = makeService(opts)
  await w.svc.init(opts.cfg ?? null)
  w.write(cred('A', 1, { expiresAt: opts.expA }))
  const a = await w.svc.capture({ label: opts.labelA ?? 'Work' })
  w.write(cred('B', 1, { expiresAt: opts.expB }))
  const b = await w.svc.capture()
  w.idA = a.state.accounts.find(x => x.rank === 0).id
  w.idB = b.state.accounts.find(x => x.rank === 1).id
  return w
}
/** A world with N accounts captured in order (letters from 'ABCEFGHIJ'; D is the unknown login); the last one is live. */
async function nAccounts(n, opts = {}) {
  const w = makeService(opts)
  await w.svc.init(opts.cfg ?? null)
  w.ids = []
  for (let i = 0; i < n; i++) {
    const L = 'ABCEFGHIJ'[i]
    w.write(cred(L, 1, { expiresAt: opts.exp?.[L] }))
    const r = await w.svc.capture()
    if (!r.ok) throw new Error('capture ' + L + ': ' + r.error)
    w.ids.push(r.state.activeId)
  }
  return w
}
const noSecrets = text => !/(?:at|rt)-[A-J]\d/.test(text) && !text.includes('accessToken') && !text.includes('refreshToken')

async function schemaChecks() {
  const { parseConfig, CONFIG_VERSION, normalizeAccountsSettings, DEFAULT_CLAUDE_ACCOUNTS_SETTINGS } = M
  check(CONFIG_VERSION === 20, 'CONFIG_VERSION is 20')
  const v15 = { version: 15, workspaces: [], presets: [], settings: { defaultShell: {}, fontFamily: 'mono', fontSize: 14, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false, usage: { enabled: true, collapsed: true } } }
  const up = parseConfig(JSON.parse(JSON.stringify(v15)))
  check(up.version === CONFIG_VERSION && JSON.stringify(up.settings.claudeAccounts) === JSON.stringify(DEFAULT_CLAUDE_ACCOUNTS_SETTINGS), 'a v15 config gains the claudeAccounts defaults')
  check(up.settings.claudeAccounts.autoSwitch === false && up.settings.usage.collapsed === true && up.settings.fontSize === 14, 'automatic switching is off by default and every other value is kept')
  const junk = JSON.parse(JSON.stringify(v15)); junk.settings.claudeAccounts = { autoSwitch: 'yes', switchAtPercent: 'x', returnBelowPercent: 95.5, deferMaxMinutes: 999, minDwellMinutes: 30, pollParked: false }
  const j = parseConfig(junk).settings.claudeAccounts
  check(j.autoSwitch === false && j.switchAtPercent === 99 && j.returnBelowPercent === 90 && j.deferMaxMinutes === 3, 'junk values fall back field by field')
  check(j.minDwellMinutes === 30 && j.pollParked === false, 'valid values are kept')
  check(parseConfig({ ...v15, settings: { ...v15.settings, claudeAccounts: 'nope' } }).settings.claudeAccounts.switchAtPercent === 99, 'a junk block falls back to the defaults')
  const n = normalizeAccountsSettings({ switchAtPercent: 60, returnBelowPercent: 80, minDwellMinutes: -5, returnMarginMinutes: 1e9 })
  check(n.switchAtPercent === 60 && n.returnBelowPercent === 59 && n.minDwellMinutes === 0 && n.returnMarginMinutes === 120, 'normalize clamps and keeps returnBelow below switchAt')
  check(JSON.stringify(normalizeAccountsSettings(null)) === JSON.stringify(DEFAULT_CLAUDE_ACCOUNTS_SETTINGS), 'normalize(null) is the defaults')
  check(M.cleanAccountLabel('  Work\n\tlaptop ' + 'x'.repeat(60)).length === 40 && M.cleanAccountLabel('a\nb') === 'a b' && M.cleanAccountLabel(5) === '', 'labels are one line of at most 40')
}

function policyChecks() {
  const { decide, effectivePercent, emptyPolicyMemory, normalizeAccountsSettings } = M
  const cfg = (o = {}) => normalizeAccountsSettings({ autoSwitch: true, ...o })
  const win = (percent, resetsAt = now + 2 * H, at = now) => ({ percent, resetsAt, at })
  // A rank (0 = highest), or a 2.3.0 role name for the two-account cases.
  const acct = (id, rank, five, seven, extra = {}) => ({ id, rank: typeof rank === 'number' ? rank : rank === 'primary' ? 0 : 1, exhaustedUntil: null, fiveHour: five, sevenDay: seven, fresh: true, usable: true, ...extra })
  const run = (o = {}) => decide({ now, cfg: cfg(o.cfg), activeId: 'activeId' in o ? o.activeId : 'A', anchorId: o.anchorId ?? null, accounts: o.accounts ?? [acct('A', 'primary', win(10), win(10)), acct('B', 'secondary', win(5), win(5), { fresh: false })], paused: o.paused ?? false, workingClaude: o.working ?? 0, mem: { ...emptyPolicyMemory(), ...(o.mem ?? {}) } })
  // Staying put.
  check(run({ cfg: { autoSwitch: false } }).decision.why === 'off', 'off stays')
  check(run({ paused: true }).decision.why === 'paused', 'paused stays')
  check(run({ accounts: [acct('A', 'primary', win(99), win(10))] }).decision.why === 'single', 'one account is single')
  check(run({ activeId: null }).decision.why === 'single', 'no active account is single')
  check(run({ mem: { lastSwitchAt: now - 5 * MIN } }).decision.why === 'dwell', 'a switch inside minDwell stays (dwell)')
  check(run({ accounts: [acct('A', 'primary', win(99), win(10), { fresh: false }), acct('B', 'secondary', win(5), win(5))] }).decision.why === 'noData', 'stale active rows give noData')
  check(run({ accounts: [acct('A', 'primary', win(null), win(null)), acct('B', 'secondary', win(5), win(5))] }).decision.why === 'noData', 'error or expired active rows (no percent) give noData')
  check(run().decision.why === 'ok', '10% stays ok')
  // Switching out.
  const reset = now + 90 * MIN
  const out = run({ accounts: [acct('A', 'primary', win(99, reset), win(10)), acct('B', 'secondary', win(5), win(5), { fresh: false })] })
  check(out.decision.kind === 'switch' && out.decision.to === 'B' && out.decision.reason === 'auto_exhausted' && out.decision.window === '5h' && out.decision.exhaustedUntil === reset, '5h at 99 switches to the secondary with exhaustedUntil = its reset')
  check(run({ accounts: [acct('A', 'primary', win(40), win(99)), acct('B', 'secondary', win(5), win(5))] }).decision.window === '7d', '7d at 99 also switches')
  check(run({ accounts: [acct('A', 'primary', win(98), win(98)), acct('B', 'secondary', win(5), win(5))] }).decision.why === 'ok', '98 stays')
  check(run({ cfg: { switchAtPercent: 80 }, accounts: [acct('A', 'primary', win(85), win(1)), acct('B', 'secondary', win(5), win(5))] }).decision.kind === 'switch', 'the threshold is the setting')
  check(run({ accounts: [acct('A', 'primary', win(99), win(10)), acct('B', 'secondary', win(null, null, null), win(null, null, null), { fresh: false })] }).decision.kind === 'switch', 'an unknown parked window counts as available')
  check(run({ accounts: [acct('A', 'primary', win(99), win(10)), acct('B', 'secondary', win(5), win(5), { usable: false })] }).decision.kind === 'blocked', 'a slot that needs a capture is never a target')
  const both = [acct('A', 'primary', win(99), win(10)), acct('B', 'secondary', win(99.5, now + H, now - H), win(20), { fresh: false })]
  const b1 = run({ accounts: both })
  check(b1.decision.kind === 'blocked' && b1.decision.notify === true && b1.mem.allExhaustedLatched, 'both exhausted: blocked and notify the first time')
  const b2 = run({ accounts: both, mem: b1.mem })
  check(b2.decision.kind === 'blocked' && b2.decision.notify === false, 'then blocked without notifying again')
  const b3 = run({ accounts: [acct('A', 'primary', win(50), win(10)), both[1]], mem: b2.mem })
  check(b3.decision.why === 'ok' && b3.mem.allExhaustedLatched === false, 'the latch clears once the active one is below the limit')
  // Returning to the primary.
  const back = (o = {}) => run({ activeId: 'B', mem: { lastSwitchAt: now - H, lastSwitchReason: o.reason ?? 'auto_exhausted' }, accounts: [acct('A', 'primary', win(o.p ?? 89), win(o.p7 ?? 30), { fresh: o.fresh ?? true, exhaustedUntil: o.until ?? now - 10 * MIN }), acct('B', 'secondary', win(40), win(40))], cfg: o.cfg })
  check(back().decision.kind === 'switch' && back().decision.to === 'A' && back().decision.reason === 'auto_return', 'back to the primary at 89 after its reset plus margin')
  check(back({ until: now - 2 * MIN }).decision.why === 'ok', 'not before reset + margin (5 min)')
  check(back({ p: 90 }).decision.why === 'ok', 'not when the primary is fresh at 90')
  check(back({ fresh: false }).decision.why === 'ok', 'not without a fresh reading of the primary')
  check(back({ reason: 'manual' }).decision.why === 'ok', 'a manual pick of the secondary is never undone')
  check(back({ cfg: { returnToPrimary: false } }).decision.why === 'ok', 'returnToPrimary off stays')
  // Returning when no fresh reading of the primary can come (its parked access token expired).
  const stalePrimary = (five, seven, until) => run({ activeId: 'B', mem: { lastSwitchAt: now - 3 * 24 * H, lastSwitchReason: 'auto_exhausted' }, accounts: [acct('A', 'primary', five, seven, { fresh: false, stale: true, exhaustedUntil: until }), acct('B', 'secondary', win(40), win(40))] })
  const r5 = stalePrimary(win(99, now - 10 * MIN, now - 6 * H), win(30, now + 3 * 24 * H, now - 6 * H), now - 10 * MIN)
  check(r5.decision.kind === 'switch' && r5.decision.reason === 'auto_return', 'stale primary, 5h exhaustion: back after its reset + margin by the estimate')
  const r7 = stalePrimary(win(20, now + H, now - 5 * 24 * H), win(100, now - 10 * MIN, now - 5 * 24 * H), now - 10 * MIN)
  check(r7.decision.kind === 'switch' && r7.decision.to === 'A', 'stale primary, 7d exhaustion days later: back once the weekly reset + margin passed')
  check(stalePrimary(win(20, now + H, now - H), win(100, now + 2 * H, now - H), now + 2 * H).decision.why === 'ok', 'stale primary before its reset: stays')
  check(stalePrimary(win(95, now + H, now - H), win(100, now - 10 * MIN, now - 5 * 24 * H), now - 10 * MIN).decision.why === 'ok', 'stale primary whose other window was last seen high: stays')
  check(back({ fresh: false }).decision.why === 'ok', 'not fresh and not stale (a fresh reading can still come): waits for it')
  // Defer.
  const ex = [acct('A', 'primary', win(99), win(10)), acct('B', 'secondary', win(5), win(5))]
  const d1 = run({ accounts: ex, working: 2 })
  check(d1.decision.kind === 'defer' && d1.decision.to === 'B' && d1.mem.deferSince === now, 'defers while a Claude console works')
  const d2 = run({ accounts: ex, working: 2, mem: { deferSince: now - 3 * MIN - 1 } })
  check(d2.decision.kind === 'switch' && d2.mem.deferSince === null, 'switches after deferMax')
  check(run({ accounts: ex, working: 2, cfg: { deferWhileWorking: false } }).decision.kind === 'switch', 'deferWhileWorking off switches at once')
  check(run({ mem: { deferSince: now - MIN } }).mem.deferSince === null, 'deferSince resets on stay')
  // effectivePercent.
  check(effectivePercent(win(70, now - H), now, 5 * MIN, true) === 70, 'a fresh reading counts as is, even past its reset')
  check(effectivePercent(win(70, now - H), now, 5 * MIN, false) === 0, 'a stale reading whose reset + margin passed is estimated at 0')
  check(effectivePercent(win(70, now - 2 * MIN), now, 5 * MIN, false) === 70, 'inside the margin it keeps the old value')
  check(effectivePercent(win(70, null), now, 0, false) === 70 && effectivePercent(win(null, null), now, 0, false) === null, 'no reset keeps the last value; nothing known is null')

  // --- app 2.4.0: N accounts in priority order ---
  const low = () => win(5)
  const full = (reset = now + H) => win(99, reset)
  const three = (a, b, c) => [acct('A', 0, ...a), acct('B', 1, ...b), acct('C', 2, ...c)]
  // Exhaustion walks the order: A to B, then B to C.
  const ab = run({ accounts: three([full(), low()], [low(), low(), { fresh: false }], [low(), low(), { fresh: false }]) })
  check(ab.decision.kind === 'switch' && ab.decision.to === 'B', 'A exhausted: the first available by rank (B)')
  const bc = run({ activeId: 'B', accounts: three([full(), low(), { fresh: false, exhaustedUntil: now + H }], [full(), low()], [low(), low(), { fresh: false }]) })
  check(bc.decision.kind === 'switch' && bc.decision.to === 'C' && bc.decision.exhaustedUntil === now + H, 'B exhausted with A still before its reset: C')
  const shuffled = run({ accounts: [acct('C', 2, low(), low(), { fresh: false }), acct('A', 0, full(), low()), acct('B', 1, low(), low(), { fresh: false })] })
  check(shuffled.decision.to === 'B', 'the policy sorts by rank, whatever order the input has')
  const allOut = run({ activeId: 'C', accounts: three([full(), low(), { fresh: false, exhaustedUntil: now + H }], [full(), low(), { fresh: false, exhaustedUntil: now + 2 * H }], [full(), low()]) })
  check(allOut.decision.kind === 'blocked' && allOut.decision.notify === true, 'B and C exhausted after A: blocked, notify once')
  // Per-account exhaustedUntil blocks ping-pong on an old low reading.
  const ping = run({ activeId: 'B', accounts: [acct('A', 0, win(10, now - H, now - 2 * H), win(10), { fresh: false, exhaustedUntil: now + 30 * MIN }), acct('B', 1, full(), low())] })
  check(ping.decision.kind === 'blocked', 'an account left at its limit is no target before its own reset, even with an old low reading')
  const afterReset = run({ activeId: 'B', accounts: [acct('A', 0, win(10, now - H, now - 2 * H), win(10), { fresh: false, exhaustedUntil: now - 10 * MIN }), acct('B', 1, full(), low())] })
  check(afterReset.decision.kind === 'switch' && afterReset.decision.to === 'A', 'past its reset plus the margin it is a target again')
  check(run({ accounts: three([full(), low()], [low(), low(), { usable: false }], [low(), low(), { fresh: false }]) }).decision.to === 'C', 'an account that needs a capture is skipped, the next by rank is taken')
  // The staged return: C to B when B resets, B to A when A does.
  const autoMem = (reason = 'auto_exhausted') => ({ lastSwitchAt: now - H, lastSwitchReason: reason })
  const ret = (o) => run({ activeId: o.active ?? 'C', anchorId: o.anchor ?? null, mem: autoMem(o.reason), accounts: three(o.a, o.b, [win(40), win(40)]) })
  const aWait = [win(95, now + H), win(30), { exhaustedUntil: now + H }]
  const bBack = [win(20), win(20), { exhaustedUntil: now - 10 * MIN }]
  const r1 = ret({ a: aWait, b: bBack })
  check(r1.decision.kind === 'switch' && r1.decision.to === 'B' && r1.decision.reason === 'auto_return', 'return: B reset first, C goes back to B')
  const r2 = run({ activeId: 'B', mem: autoMem('auto_return'), accounts: three([win(20), win(20), { exhaustedUntil: now - 10 * MIN }], [win(40), win(40)], [win(5), win(5)]) })
  check(r2.decision.kind === 'switch' && r2.decision.to === 'A' && r2.decision.reason === 'auto_return', 'then A resets: B goes back to A (after an auto_return too)')
  const r3 = ret({ a: [win(20), win(20), { exhaustedUntil: now - 10 * MIN }], b: bBack })
  check(r3.decision.to === 'A', 'both reset: straight to the highest priority one')
  check(ret({ a: aWait, b: [win(20), win(20), { exhaustedUntil: now + 10 * MIN }] }).decision.why === 'ok', 'nobody past its reset: stays')
  check(ret({ a: aWait, b: [win(92), win(20), { exhaustedUntil: now - 10 * MIN }] }).decision.why === 'ok', 'a reset account still reading above returnBelow: stays')
  // The anchor: a manual pick of B means the return never climbs to A.
  const anchored = ret({ anchor: 'B', a: [win(20), win(20), { exhaustedUntil: now - 10 * MIN }], b: bBack })
  check(anchored.decision.to === 'B', 'anchored on B: the return stops at B, never A')
  check(run({ activeId: 'B', anchorId: 'B', mem: autoMem('auto_return'), accounts: three([win(5), win(5)], [win(40), win(40)], [win(5), win(5)]) }).decision.why === 'ok', 'on the anchor itself: no return above it')
  check(ret({ anchor: 'C', a: [win(5), win(5)], b: [win(5), win(5)] }).decision.why === 'ok', 'anchored on the active account: stays')
  check(ret({ anchor: 'gone', a: [win(5), win(5)], b: [win(5), win(5)] }).decision.to === 'A', 'an unknown anchor counts as #1')
  check(ret({ reason: 'manual', a: [win(5), win(5)], b: [win(5), win(5)] }).decision.why === 'ok', 'after a manual switch there is no return at all')
  check(run({ activeId: 'C', mem: autoMem(), accounts: three([win(5), win(5), { usable: false }], [win(5), win(5), { fresh: false }], [win(40), win(40)]) }).decision.why === 'ok', 'no return to an unusable account or one without a fresh or stale reading')
}

async function vaultChecks() {
  const dir = tmp('vaultonly')
  const v = new M.AccountVault(dir, fakeCrypto(), () => now)
  await v.putSnapshot('acc_0123456789ab', { v: 1, credentialsRaw: cred('A', 1), capturedAt: now })
  const back = await v.getSnapshot('acc_0123456789ab')
  check(back && back.credentialsRaw === cred('A', 1), 'encrypted round trip is byte faithful')
  check(!fs.readFileSync(path.join(dir, 'acc_0123456789ab.bin'), 'utf8').includes('at-A1'), 'the .bin file is not plain text')
  let threw = false
  try { await v.putSnapshot('../escape', { v: 1, credentialsRaw: 'x', capturedAt: 0 }) } catch { threw = true }
  check(threw && !fs.existsSync(path.join(dir, '..', 'escape.bin')), 'a bad id is rejected before any path is built')
  const broken = new M.AccountVault(dir, fakeCrypto({ broken: true }), () => now)
  const r = await broken.readSnapshot('acc_0123456789ab')
  check(r.snap === null && r.failed === true, 'a decrypt failure returns null (failed)')
  check((await v.readSnapshot('acc_ffffffffffff')).failed === false, 'a missing snapshot is not a decrypt failure')
  fs.writeFileSync(path.join(dir, 'accounts.v2.json'), '{ not json')
  const meta = v.load()
  check(meta.accounts.length === 0 && meta.version === 2 && fs.readdirSync(dir).some(f => f.startsWith('accounts.v2.json.corrupt-')), 'a corrupt accounts.v2.json is set aside and the vault starts empty')
  const parsed = M.parseMeta(JSON.stringify({ version: 1, activeId: 'acc_000000000001', accounts: [{ id: 'acc_000000000001', role: 'primary', accountUuid: 'u' }, { id: 'acc_000000000002', role: 'primary', accountUuid: 'v' }, { id: 'bad', role: 'secondary', accountUuid: 'w' }] }))
  check(parsed.accounts.length === 1 && parsed.activeId === 'acc_000000000001', 'v1: one account per role, bad ids dropped')
  await vaultV2Checks()
}

/** app 2.4.0: accounts.v2.json, the v1 migration (accounts.json never touched) and the parse limits. */
async function vaultV2Checks() {
  const sha = f => require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  const acc1 = (id, role, uuid, extra = {}) => ({ id, role, label: '', email: uuid + '@example.com', accountUuid: uuid, organizationUuid: 'org', organizationName: null, subscriptionType: 'max', rateLimitTier: null, capturedAt: 1, updatedAt: 1, identityConfirmed: true, needsRecapture: false, ...extra })
  const P1 = 'acc_000000000001', P2 = 'acc_000000000002'
  const v1 = (o = {}) => JSON.stringify({ version: 1, activeId: P2, lastSwitch: { at: 5, from: P1, to: P2, reason: 'auto_exhausted' }, autoPaused: null, exhaustedUntil: 12345, verify: null, accounts: [acc1(P2, 'secondary', 'u2', { label: 'Casa' }), acc1(P1, 'primary', 'u1', { label: 'Trabajo' })], ...o }, null, 2)
  {
    // Only v1: migrated in priority order, v1 left byte-identical.
    const dir = tmp('v1only')
    fs.writeFileSync(path.join(dir, 'accounts.json'), v1())
    const before = sha(path.join(dir, 'accounts.json'))
    const vault = new M.AccountVault(dir, fakeCrypto(), () => now)
    const m = vault.load()
    check(vault.migratedFromV1 && m.version === 2 && m.accounts.map(a => a.id).join() === [P1, P2].join(), 'v1 to v2: the primary first, then the secondary')
    check(m.accounts[0].exhaustedUntil === 12345 && m.accounts[1].exhaustedUntil === null, 'the global exhaustedUntil goes to the account the automatic switch left')
    check(m.anchorId === P1 && m.activeId === P2 && m.lastSwitch.reason === 'auto_exhausted', 'after an automatic switch the anchor is the primary')
    check(!('role' in m.accounts[0]) && m.accounts[0].label === 'Trabajo', 'v2 accounts carry no role, the rest is kept')
    await vault.saveMeta(m)
    check(sha(path.join(dir, 'accounts.json')) === before, 'accounts.json (v1) is byte-identical after the migration and a save')
    const again = new M.AccountVault(dir, fakeCrypto(), () => now)
    const m2 = again.load()
    check(!again.migratedFromV1 && JSON.stringify(m2) === JSON.stringify(m), 'the next start reads accounts.v2.json as written')
    check(m2.v1Seen && m2.v1Seen.size === fs.statSync(path.join(dir, 'accounts.json')).size, 'the save records the accounts.json it saw (v1Seen)')
    // A 2.3.0 ran after it (a downgrade rewrote accounts.json): merged into v2, a copy of v2 kept as a .bak.
    const later = new Date(Date.now() + 60_000)
    fs.writeFileSync(path.join(dir, 'accounts.json'), v1({ lastSwitch: { at: 9, from: P2, to: P1, reason: 'manual' }, activeId: P1, exhaustedUntil: 99999 }))
    fs.utimesSync(path.join(dir, 'accounts.json'), later, later)
    const down = new M.AccountVault(dir, fakeCrypto(), () => now)
    const m3 = down.load()
    check(down.migratedFromV1 && m3.activeId === P1 && m3.anchorId === P1 && fs.readdirSync(dir).some(f => f.startsWith('accounts.v2.json.bak-')) && fs.existsSync(path.join(dir, 'accounts.v2.json')), 'a changed accounts.json is merged again; v2 is copied to a .bak, never moved')
    check(m3.accounts[0].exhaustedUntil === 99999 && m3.lastSwitch.reason === 'manual', 'the later exhaustedUntil 2.3.0 left and its last switch are taken')
    // The merge is saved once; a future mtime on accounts.json never re-merges after that.
    await down.saveMeta(m3)
    const steady = new M.AccountVault(dir, fakeCrypto(), () => now)
    steady.load()
    check(!steady.migratedFromV1, 'an accounts.json with a future mtime the last save already saw is not merged again')
  }
  {
    // A downgrade with 5 accounts: 2.3.0 knows 2 of them; nothing 2.4.0 keeps alone is lost.
    const dir = tmp('v1downgrade5')
    const ids = [1, 2, 3, 4, 5].map(i => 'acc_00000000000' + i)
    const crypto = fakeCrypto()
    const vault = new M.AccountVault(dir, crypto, () => now)
    for (const id of ids.slice(0, 4)) await vault.putSnapshot(id, { v: 1, credentialsRaw: cred(id, 1), capturedAt: now })
    // acc_5 has no .bin (2.3.0 never had it and it was removed by hand): it is dropped.
    const v2acc = (id, i, extra = {}) => ({ ...acc1(id, undefined, 'u' + i), label: 'L' + i, updatedAt: 10, exhaustedUntil: i === 3 ? 4444 : null, ...extra })
    const v2meta = { version: 2, activeId: ids[2], anchorId: ids[3], lastSwitch: { at: 8, from: ids[0], to: ids[2], reason: 'manual' }, autoPaused: null, verify: null,
      accounts: [v2acc(ids[3], 3), v2acc(ids[2], 2), v2acc(ids[0], 0), v2acc(ids[1], 1), v2acc(ids[4], 4)] }
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ version: 1, activeId: ids[0], lastSwitch: null, autoPaused: null, exhaustedUntil: null, verify: null, accounts: [acc1(ids[0], 'primary', 'u0', { label: 'Old', updatedAt: 5 }), acc1(ids[1], 'secondary', 'u1', { label: 'Renamed in 2.3.0', updatedAt: 20, needsRecapture: true })] }))
    await vault.saveMeta(v2meta)
    // 2.3.0 runs: unknownAccount (the live login is #3) and rewrites accounts.json.
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ version: 1, activeId: null, lastSwitch: null, autoPaused: 'unknownAccount', exhaustedUntil: null, verify: null, accounts: [acc1(ids[0], 'primary', 'u0', { label: 'Old', updatedAt: 5 }), acc1(ids[1], 'secondary', 'u1', { label: 'Renamed in 2.3.0', updatedAt: 20, needsRecapture: true })] }) + ' ')
    const up = new M.AccountVault(dir, crypto, () => now)
    const m = up.load()
    check(up.migratedFromV1 && m.accounts.map(a => a.id).join() === [ids[3], ids[2], ids[0], ids[1]].join(), 'downgrade merge: the 2.4.0 order and accounts #3+ stay; a v2-only account without its .bin is dropped')
    check(m.anchorId === ids[3] && m.activeId === ids[2] && m.lastSwitch.to === ids[2] && m.autoPaused === null && m.accounts[0].exhaustedUntil === 4444, 'downgrade merge: anchor, active account, last switch and exhaustedUntil from v2 (2.3.0 had no active account)')
    check(m.accounts[2].label === 'L0' && m.accounts[3].label === 'Renamed in 2.3.0' && m.accounts[3].needsRecapture === true && m.accounts[3].updatedAt === 20, 'downgrade merge: a label 2.3.0 edited later wins, an older one does not; v1 owns needsRecapture')
  }
  {
    // A manual / phone / cli / external last switch anchors its target.
    for (const reason of ['manual', 'phone', 'cli', 'external']) {
      const m = M.migrateV1(M.parseMeta(v1({ lastSwitch: { at: 5, from: P1, to: P2, reason } })))
      check(m.anchorId === P2 && m.accounts[0].exhaustedUntil === 12345, 'v1 last switch ' + reason + ': anchored on its target')
    }
    const m = M.migrateV1(M.parseMeta(v1({ lastSwitch: null, accounts: [acc1(P2, 'secondary', 'u2')] })))
    check(m.anchorId === null && m.accounts.length === 1 && m.accounts[0].exhaustedUntil === null, 'only a secondary: no anchor, nobody gets the exhaustedUntil')
  }
  {
    // A corrupt v2 with a v1 next to it: set aside, migrated from v1.
    const dir = tmp('v2corrupt')
    fs.writeFileSync(path.join(dir, 'accounts.json'), v1())
    fs.writeFileSync(path.join(dir, 'accounts.v2.json'), '{"version":2,')
    const vault = new M.AccountVault(dir, fakeCrypto(), () => now)
    const m = vault.load()
    check(vault.migratedFromV1 && m.accounts.length === 2 && fs.readdirSync(dir).some(f => f.startsWith('accounts.v2.json.corrupt-')), 'a corrupt v2 is set aside and v1 migrated again')
    // A corrupt v1 alone is never renamed (it stays as 2.3.0 left it).
    const d2 = tmp('v1corrupt')
    fs.writeFileSync(path.join(d2, 'accounts.json'), '{ nope')
    const empty = new M.AccountVault(d2, fakeCrypto(), () => now).load()
    check(empty.accounts.length === 0 && fs.readdirSync(d2).join() === 'accounts.json', 'a corrupt v1 alone: an empty vault, accounts.json untouched')
  }
  {
    // parseMetaV2: unique ids and identities, at most MAX_CLAUDE_ACCOUNTS, anchor and active must exist.
    const ids = Array.from({ length: 10 }, (_, i) => 'acc_' + String(i).padStart(12, '0'))
    const raw = { version: 2, activeId: ids[9], anchorId: ids[1], lastSwitch: null, autoPaused: null, verify: null, accounts: ids.map((id, i) => ({ ...acc1(id, undefined, 'u' + i), exhaustedUntil: i === 1 ? 99 : 'x' })) }
    raw.accounts.splice(2, 0, { ...acc1(ids[0], undefined, 'other') }, { ...acc1('acc_ffffffffffff', undefined, 'u0') })
    const m = M.parseMetaV2(JSON.stringify(raw))
    check(m.accounts.length === M.MAX_CLAUDE_ACCOUNTS && M.MAX_CLAUDE_ACCOUNTS === 8 && new Set(m.accounts.map(a => a.id)).size === 8, 'v2 is trimmed to 8 accounts with unique ids')
    check(!m.accounts.some(a => a.id === 'acc_ffffffffffff'), 'a second account with the same identity is dropped')
    check(m.activeId === null && m.anchorId === ids[1] && m.accounts[1].exhaustedUntil === 99 && m.accounts[0].exhaustedUntil === null, 'an active id that was trimmed is null; exhaustedUntil per account, junk is null')
    check(M.parseMetaV2(JSON.stringify({ ...raw, version: 1 })) === null && M.parseMeta(JSON.stringify(raw)) === null, 'each parser takes only its own version')
  }
}

async function captureChecks() {
  {
    const w = makeService()
    await w.svc.init(null)
    check((await w.svc.capture()).error === 'no_login', 'no live login: no_login')
    w.write(EMPTY)
    check((await w.svc.capture()).error === 'no_login', 'an emptied file: no_login')
  }
  {
    const w = makeService({ crypto: fakeCrypto({ available: false }) })
    await w.svc.init(null)
    w.write(cred('A', 1))
    const r = await w.svc.capture()
    check(r.error === 'encryption_unavailable' && r.state.supported === false && r.state.unsupportedReason === 'encryption_unavailable', 'no safeStorage: encryption_unavailable')
  }
  {
    const w = makeService({ platform: 'darwin' })
    await w.svc.init(null)
    check(w.svc.status().unsupportedReason === 'keychain' && (await w.svc.switchTo('primary', 'manual')).error === 'unsupported', 'macOS (Keychain) is unsupported')
  }
  {
    const w = makeService()
    await w.svc.init(null)
    // .claude.json holds a stale identity (C): the profile of the token wins.
    fs.writeFileSync(path.join(w.dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-c', emailAddress: 'carla@example.com', organizationUuid: 'org-c' }, projects: {} }))
    w.write(cred('A', 1))
    const r = await w.svc.capture({ label: 'Work' })
    const a = r.state.accounts[0]
    check(r.ok && a.email === 'ana@example.com' && a.identityConfirmed && a.active && a.label === 'Work' && a.subscriptionType === 'max', 'capture: the profile identity wins over oauthAccount')
    check(r.state.activeId === a.id && /^acc_[0-9a-f]{12}$/.test(a.id) && a.rank === 0 && a.role === 'primary', 'the captured login is the active one, with a main-made id, #1')
    check(r.state.anchorId === a.id, 'a capture that changes the live account anchors it')
    const dup = await w.svc.capture()
    check(dup.ok && dup.state.accounts.length === 1, 'the same account again re-captures in place (no second copy)')
    w.write(cred('B', 1))
    const appended = await w.svc.capture()
    const idB = appended.state.activeId
    check(appended.ok && appended.state.accounts.length === 2 && appended.state.accounts[1].email === 'beto@example.com' && appended.state.accounts[1].rank === 1 && appended.state.accounts[1].role === 'secondary', 'another account is appended as #2')
    check((await w.svc.capture({ replaceId: a.id })).error === 'duplicate', 'replacing another account with a login saved already: duplicate')
    check((await w.svc.capture({ replaceId: 'acc_ffffffffffff' })).error === 'not_found', 'replacing an unknown id: not_found')
    // Re-capture only: the live login must be that account.
    check((await w.svc.capture({ recaptureId: a.id })).error === 'duplicate', 'recaptureId of A while B is live: duplicate, nothing saved')
    w.write(cred('C', 1))
    check((await w.svc.capture({ recaptureId: a.id })).error === 'unknown_live_account' && (await w.vault.getSnapshot(a.id)).credentialsRaw === cred('A', 1), 'recaptureId with an unsaved live login: unknown_live_account, A untouched')
    // replaceId: the new login takes that account's rank, the old one is deleted.
    const rep = await w.svc.capture({ replaceId: a.id })
    check(rep.ok && rep.state.accounts.length === 2 && rep.state.accounts[0].email === 'carla@example.com' && rep.state.accounts[0].rank === 0 && rep.state.accounts[1].id === idB, 'replaceId puts the new login at the replaced rank')
    check((await w.vault.getSnapshot(a.id)) === null, 'the replaced account\'s login is deleted')
    const metaText = fs.readFileSync(path.join(w.vaultDir, 'accounts.v2.json'), 'utf8')
    check(noSecrets(metaText) && metaText.includes('carla@example.com') && !fs.existsSync(path.join(w.vaultDir, 'accounts.json')), 'accounts.v2.json holds no token, only metadata; no accounts.json is ever written')
    check(noSecrets(JSON.stringify(w.svc.status())), 'the state (IPC) carries no token')
    // 2.3.0 shape: { role, replace } replaces the account at that rank.
    w.write(cred('A', 2))
    const legacy = await w.svc.capture({ role: 'secondary', replace: true })
    check(legacy.ok && legacy.state.accounts.length === 2 && legacy.state.accounts[1].email === 'ana@example.com' && legacy.state.accounts[0].email === 'carla@example.com', 'the 2.3.0 { role: secondary, replace } replaces #2')
    // Re-capture of the live account updates the snapshot in place.
    w.write(cred('A', 3))
    const again = await w.svc.capture({ recaptureId: legacy.state.activeId })
    check(again.ok && again.state.accounts.length === 2 && (await w.vault.getSnapshot(legacy.state.activeId)).credentialsRaw === cred('A', 3), 'recaptureId of the live account re-captures it')
    // Profile down: the .claude.json hint, unconfirmed.
    profileUp = false
    fs.writeFileSync(path.join(w.dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-b', emailAddress: 'beto@example.com', organizationUuid: 'org-b' } }))
    w.write(cred('B', 2))
    const hinted = await w.svc.capture()
    check(hinted.ok && hinted.state.accounts.find(x => x.email === 'beto@example.com').identityConfirmed === false, 'profile down + oauthAccount: identityConfirmed false')
    fs.rmSync(path.join(w.dir, '.claude.json'))
    w.write(cred('B', 3))
    check((await w.svc.capture()).error === 'identity_failed', 'profile down and no hint: identity_failed')
    profileUp = true
  }
  {
    // Up to 8 accounts: the 9th answers limit_reached; replacing one still works.
    const w = await nAccounts(8)
    check(w.svc.status().accounts.map(a => a.rank).join() === '0,1,2,3,4,5,6,7' && w.svc.status().accounts.every((a, i) => a.id === w.ids[i]), 'eight captures in order: ranks 0..7')
    w.write(cred('J', 1))
    const ninth = await w.svc.capture()
    check(ninth.error === 'limit_reached' && ninth.state.accounts.length === 8, 'a 9th account: limit_reached')
    const rep = await w.svc.capture({ replaceId: w.ids[3] })
    check(rep.ok && rep.state.accounts.length === 8 && rep.state.accounts[3].email === 'j@example.com' && rep.state.accounts[3].active, 'at the limit replaceId still works, in place')
  }
}

async function switchChecks() {
  const w = await twoAccounts()
  check(w.svc.status().activeId === w.idB && w.svc.status().liveIdentity === 'known', 'two accounts, B live')
  // Each capture made a new login the active one: its usage is fetched at once
  // (the rows polled while it was unknown were dropped), not on the next poll.
  check(w.refreshes === 2, 'a capture that changes the active account refreshes the usage')
  w.write(cred('B', 1))
  check((await w.svc.capture('secondary')).ok && w.refreshes === 3, 'a re-capture of the active account with no reading yet refreshes too')
  w.svc.onActiveUsage([{ id: 'claude.5h', provider: 'claude', status: 'ok', percent: 10 }, { id: 'claude.7d', provider: 'claude', status: 'ok', percent: 20 }], now)
  check((await w.svc.capture('secondary')).ok && w.refreshes === 3, 'a re-capture of the active account that has a reading does not')
  w.refreshes = 0
  // B rotates while live (Claude refreshed it): the file changes.
  w.write(cred('B', 2))
  const r = await w.svc.switchTo('primary', 'manual')
  check(r.ok && w.read() === cred('A', 1), 'switchTo writes the target bytes exactly')
  check((await w.vault.getSnapshot(w.idB)).credentialsRaw === cred('B', 2), 'the account being left is re-captured with the live (rotated) login')
  check(fs.readdirSync(w.dir).join() === '.credentials.json', 'no backup or temp file is left in the Claude folder')
  const prev = path.join(w.vaultDir, 'prev.bin')
  check(fs.existsSync(prev) && !fs.readFileSync(prev, 'utf8').includes('rt-B2'), 'the replaced blob is kept encrypted in the vault (prev.bin)')
  check(w.refreshes === 1 && w.alerts.length === 0, 'refreshActive once; a manual switch raises no alert')
  const sw = w.events.at(-1)
  check(sw.kind === 'switched' && sw.reason === 'manual' && sw.from === w.idB && sw.to === w.idA && !sw.auto, 'a switched event (manual)')
  check(w.svc.status().lastSwitch.reason === 'manual' && w.svc.status().activeId === w.idA, 'lastSwitch and activeId follow')
  const mtime = fs.statSync(w.file).mtimeMs
  const same = await w.svc.switchTo(w.idA, 'manual')
  check(same.ok && fs.statSync(w.file).mtimeMs === mtime && w.refreshes === 1, 'the active account again is a no-op')
  check((await w.svc.switchTo('acc_ffffffffffff', 'manual')).error === 'not_found', 'an unknown id: not_found')
  await sleep(20) // the 1.5 s re-check (5 ms here) sees our own write and does nothing
  const evCount = w.events.length
  await w.svc.reconcile()
  check(w.events.length === evCount, 'reconcile ignores our own write')
  // Back to B: the rotated B2 goes live, not the stale B1.
  const toB = await w.svc.switchTo('secondary', 'auto_exhausted')
  check(toB.ok && w.read() === cred('B', 2), 'switching back writes the re-captured login')
  check(w.alerts.length === 1 && /Claude account switched/.test(w.alerts[0].title) && !w.alerts[0].body.includes('@'), 'an automatic switch alerts (alertOnSwitch), by label, never by email')
  // Unknown live login (C): nothing is overwritten.
  w.write(cred('C', 1))
  const unk = await w.svc.switchTo('primary', 'manual')
  check(unk.error === 'unknown_live_account' && w.read() === cred('C', 1), 'an unknown live login: unknown_live_account, the file untouched')
  check(unk.state.autoPaused === 'unknownAccount' && unk.state.liveIdentity === 'unknown' && unk.state.liveEmail === 'carla@example.com', 'automatic switching pauses (unknownAccount)')
  // The profile unreachable on a changed login: identity_failed, nothing written.
  w.write(cred('A', 9))
  profileUp = false
  const nf = await w.svc.switchTo('secondary', 'manual')
  profileUp = true
  check(nf.error === 'identity_failed' && w.read() === cred('A', 9), 'an unidentified live login is never overwritten (identity_failed)')
  // EPERM on the rename is retried; other errors carry only the code.
  let calls = 0
  await M.files.writeCredentials('x', path.join(w.dir, 'other.json'), { write: async () => { calls++; if (calls === 1) { const e = new Error('EPERM: secret path'); e.code = 'EPERM'; throw e } }, wait: async () => undefined })
  check(calls === 2, 'EPERM on the first write is retried')
  let msg = ''
  try { await M.files.writeCredentials('x', path.join(w.dir, 'other.json'), { write: async () => { const e = new Error('EINVAL: at-A1 leaked'); e.code = 'EINVAL'; throw e } }) } catch (e) { msg = e.message }
  check(msg === 'EINVAL', 'a failed write reports the code only')
}

async function reconcileChecks() {
  // The profile is asked at most once a minute: each look happens a bit later.
  const rec = async w => { now += 2 * MIN; await w.svc.reconcile() }
  {
    const w = await twoAccounts()
    // A refresh of the active account (rotation): re-captured.
    w.write(cred('B', 2))
    await rec(w)
    check((await w.vault.getSnapshot(w.idB)).credentialsRaw === cred('B', 2), 'a refresh of the active account re-captures it')
    // The parked refresh token in the file: an external switch, no pause.
    w.write(cred('A', 1))
    await rec(w)
    const st = w.svc.status()
    check(st.activeId === w.idA && st.lastSwitch.reason === 'external' && st.autoPaused === null && w.events.at(-1).reason === 'external', 'the parked refresh token gives an external switch')
    // Unknown, then known again.
    w.write(cred('C', 1))
    await rec(w)
    check(w.svc.status().autoPaused === 'unknownAccount' && w.events.some(e => e.kind === 'unknownAccount'), 'an unknown account pauses once')
    w.write(cred('A', 1))
    await rec(w)
    check(w.svc.status().autoPaused === null && w.svc.status().liveIdentity === 'known', 'the pause clears on a known login')
    // No file: noLogin.
    fs.rmSync(w.file)
    await rec(w)
    check(w.svc.status().liveIdentity === 'none' && w.svc.status().autoPaused === 'noLogin' && w.svc.status().activeId === null, 'a missing file gives noLogin')
  }
  {
    // Write-back: right after our switch A -> B, a console refreshes A and writes it
    // (the window is 3 min; the profile is asked at most once a minute).
    const w = await twoAccounts()
    await w.svc.switchTo('primary', 'manual')
    await w.svc.switchTo('secondary', 'manual')
    const refreshesBefore = w.refreshes
    w.write(cred('A', 2))
    now += 61_000; await w.svc.reconcile()
    check((await w.vault.getSnapshot(w.idA)).credentialsRaw === cred('A', 2) && w.read() === cred('B', 1), 'a write-back is saved into the parked account and B is re-written once')
    check(w.refreshes === refreshesBefore + 1, 'the re-assert refreshes the usage (an in-flight fetch with the written-back tokens is dropped)')
    w.write(cred('A', 3))
    now += 61_000; await w.svc.reconcile()
    const st = w.svc.status()
    check(st.autoPaused === 'conflict' && st.activeId === w.idA && w.events.at(-1).kind === 'conflict' && w.alerts.at(-1).event.kind === 'conflict', 'a second write-back pauses with conflict and follows the file')
    check((await w.svc.resumeAuto()).state.autoPaused === null, 'resumeAuto clears conflict')
  }
  {
    // A /login of the account we left, minutes after the switch, is the user's own: followed, never reverted.
    const w = await twoAccounts()
    await w.svc.switchTo('primary', 'manual')
    await w.svc.switchTo('secondary', 'manual')
    now += 5 * MIN
    w.write(cred('A', 7))
    await w.svc.reconcile()
    const st = w.svc.status()
    check(w.read() === cred('A', 7) && st.activeId === w.idA && st.lastSwitch.reason === 'external' && st.autoPaused === null, 'a later login of the left account is an external switch, not a write-back')
  }
  {
    // Rollback: the target's refresh fails and empties the file (B's access token was due).
    const w = await twoAccounts({ expB: now + 30 * MIN })
    await w.svc.switchTo('primary', 'manual')
    w.write(cred('A', 2)) // A refreshed fine once while live
    await rec(w)
    await w.svc.switchTo('secondary', 'manual')
    now += 30 * MIN
    w.write(EMPTY)
    await rec(w)
    const st = w.svc.status()
    const b = st.accounts.find(a => a.id === w.idB)
    check(w.read() === cred('A', 2), 'rollback: the account we left goes back, with its latest login')
    check(st.activeId === w.idA && b.needsRecapture && b.tokenState === 'invalid' && st.autoPaused === 'refreshFailed', 'the target needs a capture and automatic switching pauses')
    check(w.events.at(-1).kind === 'rollback' && w.alerts.at(-1).event.kind === 'rollback' && !w.alerts.at(-1).body.includes('@'), 'rollback event and alert (no email)')
    check((await w.svc.switchTo('secondary', 'manual')).error === 'locked' && w.read() === cred('A', 2), 'a slot that needs a capture answers locked and the file is untouched')
    w.write(cred('B', 5))
    const re = await w.svc.capture('secondary')
    check(re.ok && !re.state.accounts.find(a => a.id === w.idB).needsRecapture && re.state.autoPaused === null, 'capturing it again clears needsRecapture and the pause')
  }
  {
    // An emptied file soon after our switch while the target's access token is still good: a sign-out, never rolled back.
    const w = await twoAccounts()
    await w.svc.switchTo('primary', 'manual')
    w.write(EMPTY)
    await rec(w)
    const st = w.svc.status()
    check(w.read() === EMPTY && st.liveIdentity === 'none' && st.autoPaused === 'noLogin', 'an emptied file before the target refresh was due: nothing written (no rollback)')
    const lo = w.alerts.at(-1)
    check(w.events.at(-1).kind === 'loggedOut' && lo && lo.event.kind === 'loggedOut' && /signed out/i.test(lo.title) && !lo.body.includes('@'), 'the user is told Claude is signed out (alert, no email)')
  }
  {
    // The rollback arm survives a restart inside the window.
    const w = await twoAccounts({ expA: now + 20 * MIN })
    await w.svc.switchTo('primary', 'manual')
    w.svc.dispose()
    const meta = JSON.parse(fs.readFileSync(path.join(w.vaultDir, 'accounts.v2.json'), 'utf8'))
    check(meta.verify && meta.verify.to === w.idA && meta.verify.from === w.idB && typeof meta.verify.targetExpiresAt === 'number', 'the verify arm is persisted in accounts.v2.json (ids and times only)')
    const w2 = makeService({ dir: w.dir, vaultDir: w.vaultDir })
    await w2.svc.init(null)
    now += 20 * MIN
    w2.write(EMPTY)
    await rec(w2)
    check(w2.read() === cred('B', 1) && w2.svc.status().activeId === w.idB && w2.svc.status().lastSwitch.reason === 'rollback', 'after a restart the failed refresh of the target still rolls back')
  }
  {
    // An emptied file with no switch of ours: the active login is dead too.
    const w = await twoAccounts()
    w.write(EMPTY)
    await rec(w)
    const st = w.svc.status()
    check(st.liveIdentity === 'none' && st.autoPaused === 'noLogin' && st.accounts.find(a => a.id === w.idB).needsRecapture && w.read() === EMPTY, 'an emptied file without a recent switch: noLogin, nothing written')
  }
  {
    // Decrypt failure (portable folder on another PC): locked.
    const w = await twoAccounts()
    const raw = w.read()
    const w2 = makeService({ dir: w.dir, vaultDir: w.vaultDir, crypto: { ...fakeCrypto(), decrypt: () => { throw new Error('decrypt') } } })
    await w2.svc.init(null)
    const st = w2.svc.status()
    const a = st.accounts.find(x => x.id === w.idA)
    check(a.needsRecapture && a.tokenState === 'invalid' && st.autoPaused === 'locked', 'undecryptable snapshots need a capture and pause (locked)')
    check(!st.accounts.find(x => x.id === w.idB).needsRecapture, 'the live account is captured again from the live login')
    const r = await w2.svc.switchTo('primary', 'manual')
    check(r.error === 'locked' && w2.read() === raw, 'switchTo answers locked without touching .credentials.json')
  }
}

/** Every file in the vault folder, decrypted when it can be (prev.bin and <id>.bin). */
function vaultPlain(dir) {
  return fs.readdirSync(dir).map(f => {
    const buf = fs.readFileSync(path.join(dir, f))
    try { return fakeCrypto().decrypt(buf) } catch { return buf.toString('utf8') }
  }).join('\n')
}

async function hardeningChecks() {
  {
    // Only claudeAiOauth moves: Claude Code's other grants in the same file (mcpOAuth) stay as on disk.
    const w = await twoAccounts()
    const withMcp = (acct, n, mcp) => JSON.stringify({ ...JSON.parse(cred(acct, n)), mcpOAuth: { srv: { accessToken: `mcp-${mcp}`, refreshToken: `mcprt-${mcp}` } } })
    w.write(withMcp('B', 1, 1))
    const r = await w.svc.switchTo('primary', 'manual')
    const live = JSON.parse(w.read())
    check(r.ok && live.claudeAiOauth.refreshToken === 'rt-A1' && live.mcpOAuth.srv.refreshToken === 'mcprt-1', 'a switch replaces claudeAiOauth only and keeps mcpOAuth')
    check(!(await w.vault.getSnapshot(w.idB)).credentialsRaw.includes('mcp') && !(await w.vault.getSnapshot(w.idA)).credentialsRaw.includes('mcp'), 'snapshots never carry the MCP tokens')
    // The MCP grant rotates while on A: switching back never brings the old one.
    w.write(JSON.stringify({ ...JSON.parse(w.read()), mcpOAuth: { srv: { accessToken: 'mcp-2', refreshToken: 'mcprt-2' } } }))
    await w.svc.switchTo('secondary', 'manual')
    const back = JSON.parse(w.read())
    check(back.claudeAiOauth.refreshToken === 'rt-B1' && back.mcpOAuth.srv.refreshToken === 'mcprt-2', 'switching back keeps the rotated MCP grant')
  }
  {
    // An unreadable live file (mid-write, locked): busy, nothing written.
    const w = await twoAccounts()
    const broken = '{"claudeAiOauth": {"accessToken": "at-B1"'
    w.write(broken)
    const r = await w.svc.switchTo('primary', 'manual')
    check(r.ok === false && r.error === 'busy' && w.read() === broken, 'a file that does not parse: switchTo answers busy and leaves it untouched')
  }
  {
    // A rotation landing between the classification and the re-read is captured, not lost.
    let reads = 0
    let hook = null
    const files = { readCredentials: async p => { reads++; if (hook) hook(reads); return M.files.readCredentials(p) } }
    const w = await twoAccounts({ files })
    reads = 0
    hook = n => { if (n === 2) w.write(cred('B', 3)) }
    const r = await w.svc.switchTo('primary', 'manual')
    hook = null
    check(r.ok && (await w.vault.getSnapshot(w.idB)).credentialsRaw === cred('B', 3) && w.read() === cred('A', 1), 'a rotation between the two reads is classified again and the newest login of the left account is kept')
    // ... and one right before the write: nothing is written, busy.
    await w.svc.switchTo('secondary', 'manual')
    now += 2 * MIN
    reads = 0
    hook = n => { if (n === 3) w.write(cred('B', 4)) }
    const r2 = await w.svc.switchTo('primary', 'manual')
    hook = null
    check(r2.error === 'busy' && w.read() === cred('B', 4) && (await w.vault.getSnapshot(w.idB)).credentialsRaw === cred('B', 4), 'a refresh right before the write: busy, the new login stays live and is captured')
  }
  {
    // Re-capture with the profile down and a stale .claude.json hint (after a switch of ours): refused.
    const w = await twoAccounts()
    await w.svc.switchTo('primary', 'manual')
    fs.writeFileSync(path.join(w.dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-b', emailAddress: 'beto@example.com', organizationUuid: 'org-b' } }))
    profileUp = false
    const r = await w.svc.capture('secondary')
    profileUp = true
    check(r.error === 'identity_failed' && (await w.vault.getSnapshot(w.idB)).credentialsRaw === cred('B', 1) && r.state.activeId === w.idA, 'a stale hint after our switch is not trusted (identity_failed, B untouched)')
  }
  {
    // After an external login the hint is trusted, but a grant another slot holds is a duplicate.
    const w = await twoAccounts()
    w.write(cred('A', 1))
    now += 2 * MIN; await w.svc.reconcile()
    check(w.svc.status().lastSwitch.reason === 'external', 'external switch to A')
    fs.writeFileSync(path.join(w.dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-b', emailAddress: 'beto@example.com', organizationUuid: 'org-b' } }))
    profileUp = false
    const r = await w.svc.capture('secondary')
    profileUp = true
    check(r.error === 'duplicate' && (await w.vault.getSnapshot(w.idB)).credentialsRaw === cred('B', 1), 'the live grant of A is never saved as B (duplicate)')
  }
  {
    // Remove: no working copy of the removed account stays in the vault (prev.bin included).
    const w = await twoAccounts()
    w.write(cred('B', 2))
    await w.svc.switchTo('primary', 'manual')
    check(vaultPlain(w.vaultDir).includes('rt-B2'), 'before: prev.bin and B.bin hold B')
    await w.svc.remove(w.idB)
    check(!vaultPlain(w.vaultDir).includes('rt-B') && !fs.existsSync(path.join(w.vaultDir, 'prev.bin')), 'after remove no vault file decrypts to the removed account')
  }
  {
    // The phone badge is pushed again when it changes (roles swap): no stale role reaches "Use <other>".
    const w = await twoAccounts()
    const before = w.republishes
    await w.svc.setPrimary(w.idB)
    check(w.republishes === before + 1 && w.svc.badge().other.role === 'secondary' && w.svc.badge().role === 'primary', 'setPrimary republishes the usage snapshot once with the new roles')
    await w.svc.rename(w.idA, 'Work')
    check(w.republishes === before + 1, 'an unchanged badge is not pushed again')
  }
  {
    // A changed login that cannot be identified: flagged, its readings ignored, no automatic switch.
    const w = await twoAccounts({ cfg: { autoSwitch: true } })
    w.write(cred('C', 1, { expiresAt: now - MIN }))
    now += 2 * MIN; await w.svc.reconcile()
    const st = w.svc.status()
    check(st.liveUnverified === true && st.activeId === w.idB && w.emits.at(-1).liveUnverified === true, 'an unverifiable live login is flagged in the state (and emitted)')
    check(w.svc.badge() === null, 'no account badge over the unverified login\'s usage rows')
    const usageBefore = JSON.stringify(st.accounts.find(a => a.id === w.idB).usage)
    w.svc.onActiveUsage([{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 100, resetsAt: null, status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 1, resetsAt: null, status: 'ok' }], now)
    await settle(w.svc)
    check(JSON.stringify(w.svc.status().accounts.find(a => a.id === w.idB).usage) === usageBefore, 'its readings are not stored as the active account\'s')
    check(w.svc.status().activeId === w.idB && !w.events.some(e => e.kind === 'switched' && e.auto), 'no automatic switch while the live login is unverified')
  }
  {
    // Runtime smoke 2026-10-20: a /login right after a capture is throttled
    // (unverified, no badge), then the profile rejects its token (401): the
    // login is classified as unknown and stops being unverified, so a switch
    // says unknown_live_account and later reconciles do not poll the profile.
    const w = await twoAccounts()
    w.write(cred('D', 1))
    await w.svc.reconcile()
    check(w.svc.status().liveUnverified === true && w.svc.badge() === null, 'a /login within the profile throttle is unverified, without a badge')
    now += 2 * MIN; await w.svc.reconcile()
    const st = w.svc.status()
    check(st.liveIdentity === 'unknown' && st.liveUnverified === undefined && st.activeId === null && st.autoPaused === 'unknownAccount', 'a rejected token is an unknown login, no longer unverified')
    const sw = await w.svc.switchTo('secondary', 'manual')
    check(sw.error === 'unknown_live_account' && w.read() === cred('D', 1), 'switching away answers unknown_live_account and leaves the file')
    const calls = profileCalls
    now += 2 * MIN; await w.svc.reconcile(); await w.svc.reconcile()
    check(profileCalls === calls, 'the same unknown file is not sent to the profile again')
  }
  {
    // Teardown: nothing runs after dispose.
    const w = await twoAccounts()
    w.svc.dispose()
    w.write(cred('A', 1))
    now += 2 * MIN
    await w.svc.reconcile()
    check(w.svc.status().activeId === w.idB && (await w.svc.switchTo('primary', 'manual')).error === 'busy' && w.read() === cred('A', 1), 'after dispose reconcile and switch do nothing')
  }
}

async function policyServiceChecks() {
  const parkedFetch = async (_flags, deps) => {
    const c = await deps.readCred()
    const who = c.claudeAiOauth.accessToken.slice(3, 4)
    return { rows: [{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: who === 'A' ? 20 : 3, resetsAt: new Date(now + H).toISOString(), status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 10, resetsAt: new Date(now + 48 * H).toISOString(), status: 'ok' }] }
  }
  const w = await twoAccounts({ cfg: { autoSwitch: true }, fetchUsage: parkedFetch, labelA: 'ana@example.com' })
  await w.svc.switchTo('primary', 'manual')
  check(w.svc.windowsNeeded() === true, 'with auto on and two accounts the policy needs 5h and 7d')
  now += 11 * MIN
  await w.svc.pollParked()
  const b = w.svc.status().accounts.find(a => a.id === w.idB)
  check(b.usage.fiveHour.percent === 3 && b.usage.fiveHour.source === 'parked', 'the parked account is polled with its own token')
  const reset = new Date(now + 40 * MIN).toISOString()
  w.svc.onActiveUsage([{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 99, resetsAt: reset, status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 50, resetsAt: reset, status: 'ok' }], now)
  await settle(w.svc)
  const st = w.svc.status()
  check(st.activeId === w.idB && st.lastSwitch.reason === 'auto_exhausted' && w.read() === cred('B', 1), 'the active account at 99% switches to the other one by itself')
  const al = w.alerts.at(-1)
  check(al && /99%/.test(al.body) && /5-hour/.test(al.body) && al.body.includes('Account 1') && !al.body.includes('@'), 'the alert names the label or Account N (an email label falls back to Account N)')
  const badge = w.svc.badge()
  check(badge.id === w.idB && badge.role === 'secondary' && badge.other.role === 'primary' && !JSON.stringify(badge).includes('@'), 'the usage badge (phone) carries no email')
  w.lang = 'es'
  const es = M.accountsNoticeText({ settings: { language: 'es' } }, { kind: 'switched', auto: true, reason: 'auto_exhausted', from: 'x', to: 'y', window: '7d', percent: 99, at: now }, id => (id === 'x' ? 'Trabajo' : 'Personal'))
  check(es.title === 'Cambió la cuenta de Claude' && es.body.includes('Personal') && es.body.includes('límite semanal') && !es.body.includes('de semanal'), 'the notices have Spanish text')
  // Dwell: right after the switch nothing moves even at 100%.
  w.svc.onActiveUsage([{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 100, resetsAt: reset, status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 1, resetsAt: reset, status: 'ok' }], now)
  await settle(w.svc)
  check(w.svc.status().activeId === w.idB, 'minDwell holds the new account')
  // Defer while a Claude console works.
  now += 11 * MIN
  w.statuses = [{ paneId: 'p1', provider: 'claude', state: 'working' }]
  w.svc.onActiveUsage([{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 100, resetsAt: reset, status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 1, resetsAt: reset, status: 'ok' }], now)
  await settle(w.svc)
  const pend = w.svc.status()
  check(pend.activeId === w.idB && (pend.blocked === 'allExhausted' || pend.pending?.to === w.idA), 'a Claude console working defers (or both are at the limit)')
}

/** app 2.4.0: N accounts in the service (badge.others, reorder, anchor, per-account exhaustedUntil, round robin). */
async function nAccountServiceChecks() {
  const vaultMeta = w => JSON.parse(fs.readFileSync(path.join(w.vaultDir, 'accounts.v2.json'), 'utf8'))
  {
    // A 2.3.0 vault (accounts.json + <id>.bin): the service migrates it on start, writes v2 once, never touches v1 or the .bin files.
    const old = await twoAccounts()
    const v2 = vaultMeta(old)
    const v1 = { version: 1, activeId: v2.activeId, lastSwitch: v2.lastSwitch, autoPaused: null, exhaustedUntil: null, verify: null, accounts: v2.accounts.map(({ exhaustedUntil, ...a }, i) => ({ ...a, role: i === 0 ? 'secondary' : 'primary' })) }
    fs.rmSync(path.join(old.vaultDir, 'accounts.v2.json'))
    fs.writeFileSync(path.join(old.vaultDir, 'accounts.json'), JSON.stringify(v1, null, 2))
    const hashes = () => fs.readdirSync(old.vaultDir).filter(f => f === 'accounts.json' || f.endsWith('.bin')).sort().map(f => f + ':' + require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(old.vaultDir, f))).digest('hex')).join()
    const before = hashes()
    const w = makeService({ dir: old.dir, vaultDir: old.vaultDir })
    await w.svc.init(null)
    const st = w.svc.status()
    check(st.accounts.map(a => a.id).join() === [old.idB, old.idA].join() && st.accounts.every(a => !a.needsRecapture) && st.activeId === old.idB, 'a 2.3.0 vault starts as v2: the primary first, every saved login still usable')
    check(fs.existsSync(path.join(old.vaultDir, 'accounts.v2.json')) && vaultMeta(w).version === 2 && hashes() === before, 'accounts.v2.json is written; accounts.json and the .bin files are byte-identical')
    await w.svc.rename(old.idA, 'Otra')
    check(hashes() === before, 'later saves never write accounts.json')
  }
  {
    const w = await nAccounts(3)
    const [A, B, C] = w.ids
    await w.svc.rename(B, 'beto@example.com')
    const badge = w.svc.badge()
    check(badge.id === C && badge.rank === 2 && badge.role === 'secondary' && badge.other.id === A && badge.other.role === 'primary' && badge.other.rank === 0, 'badge: rank, and other = the first other account by rank (its role names it for a 2.3.0 phone)')
    check(badge.others.map(o => `${o.id}:${o.rank}:${o.role}:${o.ready}`).join() === `${A}:0:primary:true,${B}:1:secondary:true` && badge.others[1].label === '' && !JSON.stringify(badge).includes('@'), 'badge.others: every other account by rank, no email (an @ label goes out as "")')
    // Reorder: a permutation of the saved ids only.
    const before = w.republishes
    for (const bad of [[A, B], [A, B, B], [A, B, 'acc_ffffffffffff'], [A, B, C, A]]) check((await w.svc.reorder(bad)).error === 'bad_request', 'reorder refuses ' + JSON.stringify(bad.length) + ' ids that are not a permutation')
    const re = await w.svc.reorder([C, A, B])
    check(re.ok && re.state.accounts.map(a => a.id).join() === [C, A, B].join() && re.state.accounts.map(a => a.rank).join() === '0,1,2' && re.state.accounts[0].role === 'primary', 'reorder sets the priority (ranks follow the list)')
    check(vaultMeta(w).accounts.map(a => a.id).join() === [C, A, B].join(), 'the new order is saved in accounts.v2.json')
    check(w.republishes > before && w.svc.badge().rank === 0 && w.svc.badge().other.id === A, 'a reorder pushes the changed badge at once')
    check((await w.svc.move(B, 0)).state.accounts.map(a => a.id).join() === [B, C, A].join() && (await w.svc.move(B, 99)).state.accounts.map(a => a.id).join() === [C, A, B].join(), 'move puts one account at a rank (clamped)')
    check((await w.svc.setPrimary(A)).state.accounts.map(a => a.id).join() === [A, C, B].join(), 'setPrimary is a move to #1')
    check((await w.svc.move('acc_ffffffffffff', 0)).error === 'not_found', 'move of an unknown id: not_found')
    // Switching by role names a rank; the anchor follows the user's picks only.
    check(w.svc.status().anchorId === C, 'the last capture anchored its account')
    await w.svc.switchTo('secondary', 'manual')
    check(w.svc.status().activeId === C && w.svc.status().anchorId === C, "switchTo('secondary') is #2")
    await w.svc.switchTo(B, 'phone')
    check(w.svc.status().anchorId === B, 'a phone pick anchors')
    await w.svc.switchTo(A, 'auto_exhausted')
    check(w.svc.status().activeId === A && w.svc.status().anchorId === B, 'an automatic switch never moves the anchor')
    await w.svc.remove(B)
    check(w.svc.status().anchorId === null && vaultMeta(w).anchorId === null, 'removing the anchor clears it')
  }
  {
    // The parked accounts are polled one per tick, in turn, never more.
    const seen = []
    const fetchUsage = async (_f, deps) => { const c = await deps.readCred(); seen.push(c.claudeAiOauth.accessToken.slice(3, 4)); return { rows: [{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 1, resetsAt: null, status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 1, resetsAt: null, status: 'ok' }] } }
    const w = await nAccounts(4, { fetchUsage, exp: { B: now + 2 * MIN } })
    await w.svc.pollParked()
    await w.svc.pollParked()
    check(seen.join() === 'A,C', 'one parked account per tick; B (its token about to expire) is skipped without a fetch and never refreshed')
    await w.svc.pollParked()
    check(seen.join() === 'A,C', 'each account waits its own interval (nothing due: no fetch)')
    now += 6 * MIN
    await w.svc.pollParked()
    await w.svc.pollParked()
    check(seen.join() === 'A,C,A,C' && w.svc.status().accounts.find(a => a.id === w.ids[1]).usage.fiveHour.source === 'none', 'round robin over the due accounts; the expired one runs on estimates only')
  }
  {
    // The chain A -> B -> C, then the staged return C -> B -> A as the resets land.
    const pct = { A: 20, B: 3, C: 5 }
    const fetchUsage = async (_f, deps) => {
      const c = await deps.readCred()
      const p = pct[c.claudeAiOauth.accessToken.slice(3, 4)]
      return { rows: [{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: p, resetsAt: new Date(now + 3 * H).toISOString(), status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: p, resetsAt: new Date(now + 48 * H).toISOString(), status: 'ok' }] }
    }
    const w = await nAccounts(3, { cfg: { autoSwitch: true }, fetchUsage })
    const [A, B, C] = w.ids
    await w.svc.switchTo(A, 'manual')
    const rows = (p, reset) => [{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: p, resetsAt: new Date(reset).toISOString(), status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 10, resetsAt: new Date(now + 48 * H).toISOString(), status: 'ok' }]
    now += 11 * MIN
    const resetA = now + 120 * MIN
    w.svc.onActiveUsage(rows(99, resetA), now)
    await settle(w.svc)
    check(w.svc.status().activeId === B && w.read() === cred('B', 1) && vaultMeta(w).accounts[0].exhaustedUntil === Date.parse(new Date(resetA).toISOString()), 'A at 99%: to B, and A keeps its own exhaustedUntil')
    now += 11 * MIN
    const resetB = now + 40 * MIN
    w.svc.onActiveUsage(rows(99, resetB), now)
    await settle(w.svc)
    check(w.svc.status().activeId === C && w.read() === cred('C', 1) && vaultMeta(w).accounts[1].exhaustedUntil !== null, 'B at 99% with A before its reset: to C')
    check(w.events.filter(e => e.kind === 'switched' && e.auto).map(e => e.to).join() === [B, C].join(), 'two automatic switches, in priority order')
    // B resets (A not yet): back to B, not A.
    now += 50 * MIN
    await w.svc.pollParked(); await w.svc.pollParked()
    w.svc.onActiveUsage(rows(40, now + 3 * H), now)
    await settle(w.svc)
    check(w.svc.status().activeId === B && w.svc.status().lastSwitch.reason === 'auto_return', 'B reset first: C goes back to B')
    // Then A resets: B goes back to A.
    now += 75 * MIN
    await w.svc.pollParked(); await w.svc.pollParked()
    w.svc.onActiveUsage(rows(40, now + 3 * H), now)
    await settle(w.svc)
    check(w.svc.status().activeId === A && w.svc.status().lastSwitch.reason === 'auto_return' && w.read() === cred('A', 1), 'then A resets: B goes back to A')
    check(w.svc.status().anchorId === A, 'automatic moves never touch the anchor')
  }
  {
    // An automatic switch decided while a manual one is in flight is dropped once that lands.
    const pct = { A: 20, B: 3, C: 5 }
    const fetchUsage = async (_f, deps) => {
      const c = await deps.readCred()
      const p = pct[c.claudeAiOauth.accessToken.slice(3, 4)]
      return { rows: [{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: p, resetsAt: new Date(now + 3 * H).toISOString(), status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: p, resetsAt: new Date(now + 48 * H).toISOString(), status: 'ok' }] }
    }
    const w = await nAccounts(3, { cfg: { autoSwitch: true }, fetchUsage })
    const [A, B, C] = w.ids
    await w.svc.switchTo(A, 'manual')
    now += 11 * MIN
    await w.svc.pollParked(); await w.svc.pollParked()
    const resetA = now + 120 * MIN
    const manual = w.svc.switchTo(C, 'manual')
    w.svc.onActiveUsage([{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 99, resetsAt: new Date(resetA).toISOString(), status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 10, resetsAt: new Date(now + 48 * H).toISOString(), status: 'ok' }], now)
    const mr = await manual
    await settle(w.svc)
    const st = w.svc.status()
    const metaC = vaultMeta(w).accounts.find(a => a.id === C)
    check(mr.ok && st.activeId === C && st.lastSwitch.reason === 'manual' && w.read() === cred('C', 1), 'a queued automatic switch from A never undoes the manual pick of C that landed first')
    check(metaC.exhaustedUntil === null && !w.events.some(e => e.kind === 'switched' && e.auto), 'and C is never marked exhausted with A\'s reset')
  }
  {
    // A manual pick of B anchors: the return from C stops at B even with A fine.
    const fetchUsage = async () => ({ rows: [{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 2, resetsAt: null, status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 2, resetsAt: null, status: 'ok' }] })
    const w = await nAccounts(3, { cfg: { autoSwitch: true }, fetchUsage })
    const [A, B, C] = w.ids
    await w.svc.switchTo(B, 'manual')
    await w.svc.switchTo(C, 'auto_exhausted')
    check(w.svc.status().anchorId === B && w.svc.status().activeId === C, 'anchored on the manual pick B, C live after an automatic move')
    now += 11 * MIN
    await w.svc.pollParked(); await w.svc.pollParked()
    w.svc.onActiveUsage([{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 40, resetsAt: null, status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 40, resetsAt: null, status: 'ok' }], now)
    await settle(w.svc)
    check(w.svc.status().activeId === B && w.svc.status().activeId !== A && w.svc.status().lastSwitch.reason === 'auto_return', 'the return stops at the anchor B, never above it to A')
  }
}

async function usageChecks() {
  const dir = tmp('usagecred')
  env.CLAUDE_CONFIG_DIR = dir
  fs.writeFileSync(path.join(dir, '.credentials.json'), cred('A', 1))
  const seen = []
  const res = await M.fetchClaudeUsage({ claude5h: true, claude7d: true, claudeOpus7d: false, claudeSonnet7d: false }, {
    readCred: async () => JSON.parse(cred('B', 1)),
    version: async () => '9.9.9',
    get: async (_url, headers) => { seen.push(headers.Authorization); return { status: 200, json: { five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 34, resets_at: null } } } },
  })
  check(res.rows.length === 2 && res.rows[0].percent === 12 && seen.length === 1 && seen[0].endsWith('at-B1'), 'fetchClaudeUsage with an injected readCred never uses the live file')
  const poll = new M.ClaudePoll()
  poll.apply({ rows: [{ id: 'claude.5h', status: 'ok', percent: 5 }] }, 60000, now)
  poll.apply({ rows: [{ id: 'claude.5h', status: 'error', percent: null }], rateLimited: true, retryAfterMs: 600000 }, 60000, now)
  check(poll.rows.length === 1 && !poll.canFetch(now), 'before reset: rows held and backing off')
  poll.reset()
  check(poll.rows.length === 0 && poll.canFetch(now), 'ClaudePoll.reset clears the held rows and the back-off')
  const shown = { claude5h: false, claude7d: true, claudeOpus7d: true, claudeSonnet7d: false, codex5h: true, codex7d: true }
  const flags = M.claudeFetchFlags(shown, true)
  check(flags.claude5h && flags.claude7d && flags.claudeOpus7d && !flags.claudeSonnet7d, 'the policy fetches 5h and 7d even when hidden')
  check(JSON.stringify(M.claudeFetchFlags(shown, false)) === JSON.stringify({ claude5h: false, claude7d: true, claudeOpus7d: true, claudeSonnet7d: false }), 'without the policy the shown rows only')
  const rows = [{ id: 'claude.5h' }, { id: 'claude.7d' }, { id: 'claude.opus7d' }]
  check(M.displayRows(rows, shown).map(r => r.id).join() === 'claude.7d,claude.opus7d', 'hidden rows never reach the bars')
  // Paths follow CLAUDE_CONFIG_DIR (computed only; the real home is never read).
  check(M.files.credentialsPath() === path.join(dir, '.credentials.json') && M.files.claudeGlobalConfigPath() === path.join(dir, '.claude.json'), 'with CLAUDE_CONFIG_DIR both files live inside it')
  env.CLAUDE_CONFIG_DIR = ''
  check(M.files.claudeGlobalConfigPath() === path.join(os.homedir(), '.claude.json') && M.files.credentialsPath() === path.join(os.homedir(), '.claude', '.credentials.json'), 'without it: ~/.claude.json and ~/.claude/.credentials.json')
  env.CLAUDE_CONFIG_DIR = dir
  // Live credentials classification.
  check((await M.files.readCredentials(path.join(dir, 'none.json'))).kind === 'missing', 'readCredentials: missing')
  fs.writeFileSync(path.join(dir, 'empty.json'), EMPTY)
  check((await M.files.readCredentials(path.join(dir, 'empty.json'))).kind === 'empty', 'readCredentials: an emptied file')
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"claudeAiOauth": {"accessToken": "at-A1"')
  const bad = await M.files.readCredentials(path.join(dir, 'bad.json'))
  check(bad.kind === 'bad' && bad.code === 'parse' && !JSON.stringify(bad).includes('at-A1'), 'readCredentials: a broken file reports only a code')
  // The profile endpoint.
  const prof = await M.fetchClaudeProfile('at-A1', { version: async () => '1', get: async (url, headers) => ({ status: url.endsWith('/api/oauth/profile') && headers['anthropic-beta'] ? 200 : 404, json: { account: { uuid: 'uuid-a', email: 'ana@example.com', has_claude_max: true }, organization: { uuid: 'org-a', name: 'Org', rate_limit_tier: 'tier_max' } } }) })
  check(prof.ok && prof.accountUuid === 'uuid-a' && prof.organizationUuid === 'org-a' && prof.rateLimitTier === 'tier_max', 'fetchClaudeProfile parses account and organization')
  check((await M.fetchClaudeProfile('x', { version: async () => '1', get: async () => ({ status: 401, json: null }) })).status === 401, 'a 401 profile reports the status')
  check((await M.fetchClaudeProfile('x', { version: async () => '1', get: async () => { throw new Error('boom') } })).status === 'network', 'a network error is network')
}

async function ipcChecks() {
  const calls = []
  const st = { supported: true, accounts: [] }
  const svc = {
    status: () => st,
    capture: async (...a) => { calls.push(['capture', ...a]); return { ok: true, state: st } },
    switchTo: async (...a) => { calls.push(['switch', ...a]); return { ok: true, state: st } },
    remove: async (...a) => { calls.push(['remove', ...a]); return { ok: true, state: st } },
    rename: async (...a) => { calls.push(['rename', ...a]); return { ok: true, state: st } },
    setPrimary: async (...a) => { calls.push(['primary', ...a]); return { ok: true, state: st } },
    reorder: async (...a) => { calls.push(['reorder', ...a]); return { ok: true, state: st } },
    resumeAuto: async () => ({ ok: true, state: st }),
    setConfig: c => calls.push(['config', c]),
  }
  M.registerAccountsIpc(svc)
  const inv = (ch, p) => ipcHandlers.get(ch)({}, p)
  const { CH } = M
  check(['accounts:getState', 'accounts:capture', 'accounts:switch', 'accounts:remove', 'accounts:rename', 'accounts:setPrimary', 'accounts:reorder', 'accounts:resumeAuto', 'accounts:setConfig'].every(c => ipcHandlers.has(c)) && CH.ACCOUNTS_REORDER === 'accounts:reorder' && CH.ACCOUNTS_CHANGED === 'accounts:changed' && CH.ACCOUNTS_EVENT === 'accounts:event', 'the accounts:* channels are registered (domain:action)')
  check((await inv(CH.ACCOUNTS_SWITCH, { target: 'secondary', reason: 'auto_exhausted' })).error === 'bad_request' && (await inv(CH.ACCOUNTS_SWITCH, { target: 'secondary', reason: 'cli' })).error === 'bad_request', 'the renderer cannot claim auto_* or cli')
  check((await inv(CH.ACCOUNTS_SWITCH, { target: '../x', reason: 'manual' })).error === 'bad_request' && (await inv(CH.ACCOUNTS_REMOVE, { id: 'acc_xyz' })).error === 'bad_request', 'targets and ids are validated')
  await inv(CH.ACCOUNTS_SWITCH, { target: 'secondary', reason: 'manual' })
  await inv(CH.ACCOUNTS_SWITCH, { target: 'acc_0123456789ab', reason: 'phone' })
  await inv(CH.ACCOUNTS_CAPTURE, { role: 'primary', label: 'W', replace: true })
  await inv(CH.ACCOUNTS_CAPTURE, { replaceId: 'acc_0123456789ab' })
  await inv(CH.ACCOUNTS_CAPTURE, { recaptureId: 'acc_0123456789ab', label: 'X' })
  await inv(CH.ACCOUNTS_CAPTURE, {})
  check((await inv(CH.ACCOUNTS_CAPTURE, { role: 'tertiary' })).error === 'bad_request' && (await inv(CH.ACCOUNTS_CAPTURE, { replaceId: '../x' })).error === 'bad_request', 'capture validates the role and the ids')
  ipcHandlers.get(CH.ACCOUNTS_SET_CONFIG)({}, { autoSwitch: true, switchAtPercent: 500 })
  check(JSON.stringify(calls.slice(0, 6)) === JSON.stringify([['switch', 'secondary', 'manual'], ['switch', 'acc_0123456789ab', 'phone'], ['capture', { label: 'W', role: 'primary', replace: true }], ['capture', { replaceId: 'acc_0123456789ab' }], ['capture', { label: 'X', recaptureId: 'acc_0123456789ab' }], ['capture', {}]]), 'valid payloads reach the service')
  // accounts:reorder: an array of valid ids, at most 8 (the permutation is the service's check).
  await inv(CH.ACCOUNTS_REORDER, { ids: ['acc_000000000002', 'acc_000000000001'] })
  check(JSON.stringify(calls.at(-1)) === JSON.stringify(['reorder', ['acc_000000000002', 'acc_000000000001']]), 'reorder reaches the service with the ids')
  const nine = Array.from({ length: 9 }, (_, i) => 'acc_' + String(i).padStart(12, '0'))
  check((await inv(CH.ACCOUNTS_REORDER, { ids: nine })).error === 'bad_request' && (await inv(CH.ACCOUNTS_REORDER, { ids: ['nope'] })).error === 'bad_request' && (await inv(CH.ACCOUNTS_REORDER, { ids: [] })).error === 'bad_request' && (await inv(CH.ACCOUNTS_REORDER, null)).error === 'bad_request', 'reorder validates the payload')
  const cfgCall = calls.find(c => c[0] === 'config')
  check(cfgCall && cfgCall[1].autoSwitch === true && cfgCall[1].switchAtPercent === 100, 'setConfig is normalized in main')
  // WS: the phone's ctl.
  const frame = action => M.parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'ctl', id: 'x', action }))
  check(!!frame({ kind: 'claudeAccountUse', role: 'secondary' }) && !frame({ kind: 'claudeAccountUse', role: 'x' }), 'the WS schema accepts claudeAccountUse { role } and rejects other roles')
  check(!!frame({ kind: 'claudeAccountUse', id: 'acc_0123456789ab' }) && !frame({ kind: 'claudeAccountUse', id: '../acc' }) && !frame({ kind: 'claudeAccountUse', id: 'acc_XYZ' }), 'app 2.4.0: claudeAccountUse { id } with a valid id only')
  // A discriminatedUnion member takes no .refine: both or neither parse, the executor refuses them (rendererChecks).
  check(!!frame({ kind: 'claudeAccountUse' }) && !!frame({ kind: 'claudeAccountUse', role: 'primary', id: 'acc_0123456789ab' }), 'the schema lets both or neither through to the executor')
}

// Renderer modules bundled with the i18n tables (no React rendering), like test-usage.cjs.
function loadRenderer(contents, win = { addEventListener() {}, snApi: {} }) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, setTimeout, clearTimeout, window: win, localStorage: { getItem: () => null, setItem() {} }, document: {}, navigator: { language: 'en' } })
  return mod.exports
}

async function rendererChecks() {
  const rwin = { addEventListener() {}, snApi: {} }
  const R = loadRenderer(`
export { accountChipView } from './components/sidebar/UsageBars'
export { accountWindowMeter } from './components/settings/sections/ClaudeAccountsSection'
export { accountName, accountsEventToast, accountsErrorText, movedOrder } from './lib/accountsStore'
export { remoteNoticeText, initRemoteCommands } from './lib/remoteCommands'
export { useAccountsStore } from './lib/accountsStore'
export { translate } from './i18n'
`, rwin)
  const tEn = (k, v) => R.translate('en', k, v)
  const tEs = (k, v) => R.translate('es', k, v)
  const win = (percent, source = 'live') => ({ percent, resetsAt: null, at: T0, source })
  const acc = (id, role, label, extra = {}) => ({ id, rank: role === 'primary' ? 0 : 1, role, label, email: `${id}@example.test`, organizationName: null, subscriptionType: 'max', capturedAt: T0, active: false, tokenState: 'ok', needsRecapture: false, identityConfirmed: true, usage: { fiveHour: win(40), sevenDay: win(10) }, ...extra })
  const state = (accounts, activeId, extra = {}) => ({ supported: true, liveSwitch: true, accounts, activeId, liveIdentity: activeId ? 'known' : 'none', autoPaused: null, lastSwitch: null, pending: null, blocked: null, restartNeeded: [], ...extra })
  const two = state([acc('acc_aaaaaaaaaaaa', 'primary', 'Work', { active: true }), acc('acc_bbbbbbbbbbbb', 'secondary', '')], 'acc_aaaaaaaaaaaa')

  // The chip: active label, "Use <other>" with "Account N" as the fallback, both languages.
  const en = R.accountChipView(two, tEn)
  check(en.label === 'Work' && en.title === 'Claude account: Work' && en.manage === 'Manage accounts', 'chip (en): active label, title and manage row')
  check(en.items.length === 1 && en.items[0].id === 'acc_bbbbbbbbbbbb' && en.items[0].label === 'Use Account 2' && !en.items[0].disabled, 'chip (en): an unlabeled other account is named Account N')
  const es = R.accountChipView(two, tEs)
  check(es.title === 'Cuenta de Claude: Work' && es.items[0].label === 'Usar Cuenta 2' && es.manage === 'Administrar cuentas', 'chip (es)')
  // app 2.4.0: every other account, by priority.
  const four = state([acc('acc_aaaaaaaaaaaa', 'primary', 'Work'), acc('acc_bbbbbbbbbbbb', 'secondary', '', { rank: 1 }), acc('acc_cccccccccccc', 'secondary', 'Casa', { rank: 2, active: true }), acc('acc_dddddddddddd', 'secondary', '', { rank: 3 })], 'acc_cccccccccccc')
  const c4 = R.accountChipView(four, tEn)
  check(c4.label === 'Casa' && c4.items.map(i => i.label).join('|') === 'Use Work|Use Account 2|Use Account 4' && c4.items.map(i => i.rank).join() === '0,1,3', 'chip with four accounts: one Use row per other account, by rank')
  check(R.accountChipView(null, tEn) === null && R.accountChipView(state([], null), tEn) === null && R.accountChipView({ ...two, supported: false }, tEn) === null, 'no chip without a saved account or support')
  const unknown = R.accountChipView({ ...two, activeId: null, liveIdentity: 'unknown' }, tEn)
  check(unknown.label === 'Unsaved login' && unknown.items.length === 2 && unknown.items.every(i => i.disabled), 'an unsaved live login: chip says so and the switch rows are disabled')
  const locked = R.accountChipView(state([acc('acc_aaaaaaaaaaaa', 'primary', 'Work', { active: true }), acc('acc_bbbbbbbbbbbb', 'secondary', 'Home', { needsRecapture: true })], 'acc_aaaaaaaaaaaa'), tEn)
  check(locked.items[0].disabled && locked.items[0].hint === 'That saved login can no longer be used. Capture it again.', 'a slot that needs a capture cannot be picked from the chip')
  check(!JSON.stringify(en).includes('@') && !JSON.stringify(es).includes('@'), 'the chip never shows an email')

  // Window meters: "as of" for a parked reading, estimated after the reset, no data.
  check(R.accountWindowMeter(win(55, 'parked'), 'Session', tEn).subText.startsWith('as of ') && R.accountWindowMeter(win(55, 'parked'), 'Session', tEn).valueText === '55%', 'a parked window shows "as of"')
  check(R.accountWindowMeter(win(0, 'estimated'), 'Session', tEs).subText === 'ya se reinició (estimado)', 'an estimated window says the reset passed (es)')
  check(R.accountWindowMeter({ percent: null, resetsAt: null, at: null, source: 'none' }, 'Session', tEn).muted, 'no reading: a muted meter')

  // Names, errors and event toasts (labels or role names, never an email).
  check(R.accountName({ label: '  ', rank: 0 }, tEs) === 'Cuenta 1' && R.accountName({ label: '', rank: 4 }, tEn) === 'Account 5' && R.accountName({ label: 'Casa', rank: 1 }, tEn) === 'Casa', 'accountName: label, else Account N')
  check(R.accountName({ label: '', role: 'secondary' }, tEn) === 'Account 2', 'accountName: a bare 2.3.0 role names #1 / #2')
  check(R.accountsErrorText('limit_reached', tEn).includes('Remove one first') && R.accountsErrorText('limit_reached', tEs).includes('Quitá una'), 'limit_reached has its text (es+en)')
  const ids = ['a', 'b', 'c']
  check(R.movedOrder(ids, 'b', -1).join() === 'b,a,c' && R.movedOrder(ids, 'b', 1).join() === 'a,c,b' && R.movedOrder(ids, 'a', -1) === null && R.movedOrder(ids, 'c', 1) === null && R.movedOrder(ids, 'x', 1) === null, 'movedOrder: up and down, nothing past the ends')
  check(R.accountsErrorText('locked', tEn).includes('Capture it again') && R.accountsErrorText('nope', tEn) === 'The account operation failed.', 'error texts, with a generic fallback')
  const evt = (e) => R.accountsEventToast({ auto: false, at: T0, ...e }, two, tEn)
  check(evt({ kind: 'switched', reason: 'manual', to: 'acc_bbbbbbbbbbbb' }).text === 'Claude now uses Account 2', 'manual switch toast')
  check(evt({ kind: 'switched', reason: 'auto_exhausted', auto: true, from: 'acc_aaaaaaaaaaaa', to: 'acc_bbbbbbbbbbbb', percent: 99 }).text === 'Claude switched to Account 2: Work reached 99%', 'automatic switch toast')
  check(evt({ kind: 'switched', reason: 'phone', to: 'acc_bbbbbbbbbbbb' }) === null, 'the phone switch has its own remote notice, no second toast')
  check(evt({ kind: 'rollback', from: 'acc_bbbbbbbbbbbb', to: 'acc_aaaaaaaaaaaa' }).kind === 'warning' && evt({ kind: 'locked', to: 'acc_bbbbbbbbbbbb' }).kind === 'error', 'rollback warns, locked is an error')
  const allEvents = ['switched', 'allExhausted', 'unknownAccount', 'conflict', 'rollback', 'locked', 'loggedOut'].map(kind => evt({ kind, from: 'acc_aaaaaaaaaaaa', to: 'acc_bbbbbbbbbbbb' }))
  check(allEvents.every(x => x && !x.text.includes('@') && !x.text.includes('{')), 'every event kind has a filled toast without an email')

  // The phone's switch notice on the desktop names the account (store state, role fallback).
  R.useAccountsStore.setState({ state: two })
  const notice = R.remoteNoticeText({ kind: 'claudeAccountUse', role: 'secondary' }, { ok: true }, 'Pixel', 'Secondary', 'en')
  check(notice === 'From Pixel: Claude account switched to Secondary', 'remote notice for claudeAccountUse')
  check(R.remoteNoticeText({ kind: 'claudeAccountUse', role: 'secondary' }, { ok: false, error: 'rate' }, 'Pixel', 'Secondary', 'en') === null, 'no notice for a refused switch')

  // The executor: the phone's ctl reaches accounts.switchTo(role, 'phone') and its error comes back as is.
  let onCmd = null
  const results = []
  const calls = []
  let reply = { ok: false, error: 'locked', state: two }
  rwin.snApi.remote = { onCommand: cb => { onCmd = cb; return () => undefined }, commandResult: r => results.push(r) }
  rwin.snApi.accounts = { switchTo: async (...a) => { calls.push(a); return reply } }
  const off = R.initRemoteCommands()
  onCmd({ id: 'c1', deviceName: 'Pixel', action: { kind: 'claudeAccountUse', role: 'secondary' } })
  await sleep(10)
  check(JSON.stringify(calls[0]) === JSON.stringify(['secondary', 'phone']) && JSON.stringify(results[0]) === JSON.stringify({ id: 'c1', ok: false, error: 'locked' }), 'claudeAccountUse calls switchTo(role, phone) and passes the error through')
  reply = { ok: true, state: two }
  onCmd({ id: 'c2', deviceName: 'Pixel', action: { kind: 'claudeAccountUse', role: 'primary' } })
  await sleep(10)
  check(JSON.stringify(calls[1]) === JSON.stringify(['primary', 'phone']) && JSON.stringify(results[1]) === JSON.stringify({ id: 'c2', ok: true }), 'a successful phone switch acks ok')
  // app 2.4.0: by id; both or neither is bad_target and never reaches main.
  onCmd({ id: 'c3', deviceName: 'Pixel', action: { kind: 'claudeAccountUse', id: 'acc_bbbbbbbbbbbb' } })
  await sleep(10)
  check(JSON.stringify(calls[2]) === JSON.stringify(['acc_bbbbbbbbbbbb', 'phone']) && JSON.stringify(results[2]) === JSON.stringify({ id: 'c3', ok: true }), 'claudeAccountUse { id } calls switchTo(id, phone)')
  onCmd({ id: 'c4', deviceName: 'Pixel', action: { kind: 'claudeAccountUse', id: 'acc_bbbbbbbbbbbb', role: 'primary' } })
  onCmd({ id: 'c5', deviceName: 'Pixel', action: { kind: 'claudeAccountUse' } })
  await sleep(10)
  check(calls.length === 3 && results.slice(3).every(r => r.ok === false && r.error === 'bad_target') && results.length === 5, 'both or neither of id and role: bad_target, no switch')
  const byId = R.remoteNoticeText({ kind: 'claudeAccountUse', id: 'acc_bbbbbbbbbbbb' }, { ok: true }, 'Pixel', 'Account 2', 'en')
  check(byId === 'From Pixel: Claude account switched to Account 2', 'remote notice for claudeAccountUse { id }')
  off()
}

async function usageIpcChecks() {
  // registerUsageIpc itself, with an injected Claude fetch and timers that never hold the process.
  env.CODEX_HOME = tmp('codexhome')
  const unref = t => { t.unref?.(); return t }
  const U = load("export { registerUsageIpc } from './src/main/ipc/registerUsageIpc'", { setTimeout: (...a) => unref(setTimeout(...a)), setInterval: (...a) => unref(setInterval(...a)) })
  const pending = []
  const fetchClaude = flags => new Promise(resolve => pending.push({ flags, resolve }))
  const policyRows = []
  const sent = []
  const badge = { id: 'acc_aaaaaaaaaaaa', rank: 0, role: 'primary', label: 'Work', other: { id: 'acc_bbbbbbbbbbbb', rank: 1, role: 'secondary', label: '' }, others: [{ id: 'acc_bbbbbbbbbbbb', rank: 1, role: 'secondary', label: '', ready: true }, { id: 'acc_cccccccccccc', rank: 2, role: 'secondary', label: 'Casa', ready: false }] }
  const rowsOf = p => [{ id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: p, resetsAt: null, status: 'ok' }, { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: p, resetsAt: null, status: 'ok' }]
  const handle = U.registerUsageIpc({
    getSender: () => ({ isDestroyed: () => false, send: (_ch, snap) => sent.push(snap) }),
    getInitialConfig: () => ({ enabled: true, claudeIntervalMs: 60000, codexIntervalMs: 600000, refreshOnFocus: false, showStatus: false, rows: { claude5h: false, claude7d: true, claudeOpus7d: false, claudeSonnet7d: false, codex5h: false, codex7d: false }, custom: [] }),
    accounts: { windowsNeeded: () => true, badge: () => badge, onActiveResult: rows => policyRows.push(rows), reconcile: () => undefined },
    fetchClaude,
  })
  await sleep(10)
  check(pending.length === 1 && pending[0].flags.claude5h === true && pending[0].flags.claude7d === true, 'registerUsageIpc asks for 5h and 7d when the policy needs them, even with 5h hidden')
  // A switch while the first fetch (the old account, X) is in flight.
  const refreshed = handle.refreshClaudeNow()
  pending[0].resolve({ rows: rowsOf(77) })
  await sleep(10)
  check(pending.length === 2, 'refreshClaudeNow fetches again once the old fetch settled')
  pending[1].resolve({ rows: rowsOf(11) })
  await refreshed
  check(policyRows.length === 1 && policyRows[0].every(r => r.percent === 11), 'the fetch that started before the switch never reaches the policy (generation)')
  const snap = handle.get()
  const claudeRows = snap.rows.filter(r => r.provider === 'claude')
  check(claudeRows.length === 1 && claudeRows[0].id === 'claude.7d' && claudeRows[0].percent === 11, 'the bars get the second fetch, minus the hidden 5h row')
  check(policyRows[0].some(r => r.id === 'claude.5h'), 'the policy still gets the hidden 5h row')
  check(JSON.stringify(snap.activeAccount) === JSON.stringify(badge), 'the snapshot carries the account badge (rank and others included)')
  const n = sent.length
  handle.republish()
  check(sent.length === n + 1 && JSON.stringify(sent.at(-1).activeAccount) === JSON.stringify(badge), 'republish pushes the snapshot again')
  check(handle.intervalMs() === 60000, 'intervalMs is the normalized Claude interval')
}

async function main() {
  try {
    await schemaChecks()
    policyChecks()
    await vaultChecks()
    await captureChecks()
    await switchChecks()
    await reconcileChecks()
    await hardeningChecks()
    await policyServiceChecks()
    await nAccountServiceChecks()
    await usageChecks()
    await usageIpcChecks()
    await ipcChecks()
    await rendererChecks()
  } finally {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  }
  console.log(`PASS: ${checks} Claude account checks (schema 18, policy with N accounts, vault v2 and the v1 migration, vault, capture, switch, reconcile, rollback, locked, usage seams, IPC and WS validation, renderer chip / toasts es+en)`)
}

main().catch(err => { console.error('FAIL:', err && err.message ? err.message : err); process.exit(1) })
