// Notice discipline (app 2.7.0, A5): noticeCoalescer (10 s window per
// channel, the first 3 at once, the rest as one summary, `action` never held,
// one timer only while something is held, clock jumps), summaryNotice
// (status.push.digest in es and en, places, redaction), createNoticeRouter
// with the coalescers (per channel, after the away gate and each channel's
// filter, routeCustom too, the summary re-checks the gate), the channel texts
// of a done digest and a summary (Discord, ntfy), the digest line StatusManager
// attaches to a done notice (families in the config language, redacted, never
// reply text) and the 2 s throttle of the status sound.
// Same esbuild + vm harness as test-status.cjs: fake clock and timers, no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, fetch, Response, AbortController, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const T0 = 1_700_000_000_000
const WINDOW = 10_000
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const SK = 'sk-proj-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe'

/** A fake platform: a clock and timers that keep the clock time they are due at. */
function fakePlatform() {
  const p = { clock: T0, seq: 0, timers: new Map(), armed: 0 }
  p.now = () => p.clock
  p.setTimeout = (fn, ms) => { p.armed++; p.timers.set(++p.seq, { fn, ms, due: p.clock + ms }); return p.seq }
  p.clearTimeout = (id) => { p.timers.delete(id) }
  /** Moves the clock by `ms` and runs every timer due by then, earliest first. */
  p.advance = (ms) => {
    const to = p.clock + ms
    for (;;) {
      const next = [...p.timers].filter(([, t]) => t.due <= to).sort(([, a], [, b]) => a.due - b.due)[0]
      if (!next) break
      p.timers.delete(next[0]); p.clock = Math.max(p.clock, next[1].due); next[1].fn()
    }
    p.clock = to
  }
  p.deps = () => ({ now: p.now, setTimeout: p.setTimeout, clearTimeout: p.clearTimeout })
  return p
}

const configOf = (language, extra = {}) => ({
  settings: { language, notifications: { onlyWhenAway: false, notifyDone: true, notifyAction: true, ...extra } },
  workspaces: [{ id: 'w1', name: 'Front', panes: [{ id: 'p1', title: 'Builder' }, { id: 'p2', title: 'Api' }, { id: 'p3', title: `leak ${GHP}` }] }],
})

// --- 1. The coalescer on its own -------------------------------------------------

function coalescerChecks() {
  const { createNoticeCoalescer, NOTICE_WINDOW_MS, NOTICE_BURST } = load('src/main/status/noticeCoalescer.ts')
  check(NOTICE_WINDOW_MS === WINDOW && NOTICE_BURST === 3, 'window 10 s, burst 3')
  const make = () => {
    const p = fakePlatform(), out = [], sums = []
    const c = createNoticeCoalescer({ timers: p.deps(), immediate: (n) => n.state === 'action', deliver: (n) => out.push(n.id), summarize: (held) => sums.push(held.map((n) => n.id)) })
    return { p, c, out, sums, push: (id, state = 'done') => c.push({ id, state }) }
  }
  {
    const { p, c, out, sums, push } = make()
    push('a'); p.advance(1000); push('b'); push('c')
    check(out.join() === 'a,b,c' && p.timers.size === 0 && !c.pending(), 'the first 3 of a window go out at once and arm nothing')
    p.advance(1000); push('d'); push('e')
    check(out.join() === 'a,b,c' && c.heldCount() === 2, 'the 4th and 5th are held')
    check(p.timers.size === 1 && p.armed === 1 && [...p.timers.values()][0].due === T0 + WINDOW && c.pending(), 'one timer, armed once, at the end of the window (from its first notice)')
    push('x', 'action')
    check(out.join() === 'a,b,c,x' && c.heldCount() === 2 && p.timers.size === 1, 'an action goes out at once even with the window full, held ones stay')
    p.advance(WINDOW)
    check(sums.length === 1 && sums[0].join() === 'd,e', 'the window closes with ONE summary of what it held')
    check(p.timers.size === 0 && !c.pending() && c.heldCount() === 0, 'no timer left after the window closes')
    push('f')
    check(out.at(-1) === 'f' && p.timers.size === 0, 'after the summary a new window opens: its first goes out at once, no timer')
  }
  {
    const { p, out, sums, push } = make()
    for (let i = 0; i < 6; i++) push('act' + i, 'action')
    check(out.length === 6 && p.timers.size === 0 && sums.length === 0, 'actions never take a slot: 6 in a row all go out, nothing armed')
    push('d1'); push('d2'); push('d3'); push('d4')
    check(out.length === 9 && p.timers.size === 1, 'and they did not open the window: 3 dones still pass after them')
  }
  {
    const { p, c, out, sums, push } = make()
    push('a'); push('b'); push('c')
    p.advance(WINDOW)
    push('d'); push('e'); push('f')
    check(out.join() === 'a,b,c,d,e,f' && sums.length === 0 && p.armed === 0, 'a window that held nothing expires on the clock: no timer ever ran for it')
    push('g')
    check(c.heldCount() === 1 && p.timers.size === 1, 'the next window counts from zero')
  }
  {
    // A late timer (a busy loop, a clock jump): the next notice closes the old window first.
    const { p, c, out, sums, push } = make()
    push('a'); push('b'); push('c'); push('d')
    p.clock += WINDOW + 5000
    push('e')
    check(sums.length === 1 && sums[0].join() === 'd' && out.at(-1) === 'e', 'a notice past the window flushes the summary first, then goes out in a new window')
    check(p.timers.size === 0 && !c.pending(), 'and the stale timer is cleared')
    push('f'); push('g'); push('h')
    check(out.join() === 'a,b,c,e,f,g' && c.heldCount() === 1, 'the new window counts e as its first')
    p.clock -= 60_000
    push('i')
    check(sums.length === 2 && sums[1].join() === 'h' && out.at(-1) === 'i', 'a clock moved back closes the window too')
  }
  {
    const p = fakePlatform()
    let calls = 0
    const c = createNoticeCoalescer({ timers: p.deps(), deliver: () => {}, summarize: () => { calls++; throw new Error('channel down') } })
    for (let i = 0; i < 4; i++) c.push({})
    p.advance(WINDOW)
    check(calls === 1 && p.timers.size === 0, 'a summary that throws never escapes the timer')
    for (let i = 0; i < 4; i++) c.push({})
    check(c.heldCount() === 1 && p.timers.size === 1, 'and the next window works')
    c.dispose()
    check(p.timers.size === 0 && c.heldCount() === 0 && !c.pending(), 'dispose drops the held notices and the timer')
  }
  {
    // Real timers by default: the module only needs setTimeout/clearTimeout of the platform.
    const c = createNoticeCoalescer({ deliver: () => {}, summarize: () => {} })
    for (let i = 0; i < 4; i++) c.push({})
    check(c.pending(), 'real timers by default')
    c.dispose()
  }
}

// --- 2. summaryNotice ------------------------------------------------------------

function summaryChecks() {
  const { summaryNotice, SUMMARY_PLACES_MAX } = load('src/main/status/noticeCoalescer.ts')
  const held = [
    { paneId: 'p1', provider: 'codex', state: 'done' },
    { paneId: 'p2', provider: 'claude', state: 'done' },
    { paneId: 'p1', provider: 'claude', state: 'done' },
  ]
  const en = summaryNotice(held, configOf('en'))
  check(en.summary.text === 'More notices from SnAgentsOS: 3' && en.summary.count === 3, 'status.push.digest in English with the count')
  check(en.summary.places === 'Front / Builder, Front / Api', 'the distinct places of the held notices, in order')
  check(en.paneId === '' && en.state === 'done' && en.provider === 'codex', 'paneId empty, done when all were done, the first provider')
  const es = summaryNotice(held, configOf('es'))
  check(es.summary.text === 'Más avisos de SnAgentsOS: 3', 'status.push.digest in Spanish')
  const mixed = summaryNotice([...held, { paneId: 'p2', provider: 'claude', state: 'error' }], configOf('en'))
  check(mixed.state === 'error' && mixed.summary.count === 4, 'an error among them makes the summary an error (notifyAction lets it through)')
  const custom = summaryNotice([{ kind: 'custom', paneId: null, title: 't', body: 'b' }, { kind: 'custom', paneId: 'p2', title: 't', body: 'b' }], configOf('en'))
  check(custom.state === 'done' && custom.provider === 'claude' && custom.summary.places === 'Front / Api', 'custom notices count as done; one with no pane adds no place')
  const leak = summaryNotice([{ paneId: 'p3', provider: 'claude', state: 'done' }], configOf('en'))
  check(!leak.summary.places.includes(GHP) && leak.summary.places === 'Front / leak [redacted]', 'the places are redacted (a token in a console title)')
  const many = { ...configOf('en'), workspaces: [{ id: 'w', name: 'W'.repeat(40), panes: Array.from({ length: 8 }, (_, i) => ({ id: 'q' + i, title: 'console ' + i })) }] }
  const long = summaryNotice(Array.from({ length: 8 }, (_, i) => ({ paneId: 'q' + i, provider: 'claude', state: 'done' })), many)
  check(long.summary.places === '' && long.summary.count === 8 && SUMMARY_PLACES_MAX === 160, 'places longer than 160 are left out')
  const none = summaryNotice([{ paneId: 'gone', provider: 'claude', state: 'done' }], null)
  check(none.summary.text === 'More notices from SnAgentsOS: 1' && none.summary.places === '', 'no config: English, no places')
}

// --- 3. The router with its coalescers --------------------------------------------

function routerChecks() {
  const { createNoticeRouter } = load('src/main/status/noticeRouter.ts')
  const make = (opts = {}) => {
    const p = fakePlatform()
    const env = { language: 'en', onlyWhenAway: false, away: undefined, viewed: false, discordWants: true, notifyDone: true, ...opts }
    const sent = { push: [], discord: [], ntfy: [] }
    const router = createNoticeRouter({
      discord: {
        notify: (n) => sent.discord.push(n),
        notifyCustom: (n) => sent.discord.push(n),
        ...(opts.noDiscordWants ? {} : { wants: (n) => !!n.summary || env.discordWants, wantsCustom: () => true }),
      },
      ntfy: { notify: (n, c, click) => sent.ntfy.push({ ...n, click }), wants: () => true, wantsCustom: () => true, notifyCustom: (n, c, click) => sent.ntfy.push({ ...n, click }) },
      loadConfig: () => configOf(env.language, { onlyWhenAway: env.onlyWhenAway, notifyDone: env.notifyDone }),
      isAway: () => env.away,
      isPaneViewed: () => env.viewed,
      deepLinkBase: () => 'http://100.64.0.2:4517',
      push: (n) => sent.push.push(n),
      timers: p.deps(),
    })
    const done = (paneId = 'p1') => router.route({ paneId, provider: 'claude', state: 'done', digest: 'Edit 1' })
    const count = () => `${sent.push.length}/${sent.discord.length}/${sent.ntfy.length}`
    return { p, env, sent, router, done, count }
  }
  {
    const { p, sent, router, done, count } = make()
    for (let i = 0; i < 5; i++) done(i % 2 ? 'p2' : 'p1')
    check(count() === '3/3/3' && p.timers.size === 3, '5 done notices in a window: each channel sends 3 and holds 2, one timer per channel')
    router.route({ paneId: 'p1', provider: 'claude', state: 'action', reason: 'permission' })
    check(count() === '4/4/4', 'an action is never held: it goes out at once on every channel')
    check(sent.ntfy[2].click === 'http://100.64.0.2:4517/#ws=w1&pane=p1' && sent.ntfy[2].digest === 'Edit 1', 'an immediate ntfy notice keeps its deep link and its digest')
    p.advance(WINDOW - 1)
    check(count() === '4/4/4', 'nothing more before the window ends')
    p.advance(1)
    check(count() === '5/5/5' && p.timers.size === 0, 'when it closes, ONE summary per channel, and no timer is left')
    const [ps, ds, ns] = [sent.push.at(-1), sent.discord.at(-1), sent.ntfy.at(-1)]
    check(ps.summary.count === 2 && ds.summary.count === 2 && ns.summary.count === 2, 'each summary stands for the 2 held')
    check(ps.summary.text === 'More notices from SnAgentsOS: 2' && ps.summary.places === 'Front / Api, Front / Builder', 'the summary uses status.push.digest with the places')
    check(ns.click === 'http://100.64.0.2:4517/', 'the ntfy summary opens the app root')
  }
  {
    const { p, sent, done, env } = make({ language: 'en' })
    for (let i = 0; i < 4; i++) done()
    env.language = 'es'
    p.advance(WINDOW)
    check(sent.discord.at(-1).summary.text === 'Más avisos de SnAgentsOS: 1', 'the summary reads the config language when it goes out (es)')
  }
  {
    // Per channel: a channel that does not want a notice never counts it.
    const { p, sent, done, env, count } = make()
    env.discordWants = false
    done(); done(); done()
    check(count() === '3/0/3', 'Discord with done off: push and ntfy take the 3, Discord nothing')
    env.discordWants = true
    done(); done()
    check(count() === '3/2/3' && sent.discord.length === 2, 'its own window is still empty: Discord sends the next 2 at once while push and ntfy hold them')
    check(p.timers.size === 2, 'only the channels that hold something have a timer')
    env.viewed = true
    done()
    check(count() === '3/3/3', 'a pane watched on the phone takes no ntfy slot')
    p.advance(WINDOW)
    check(count() === '4/3/4' && sent.ntfy.at(-1).summary.count === 2 && p.timers.size === 0, 'push and ntfy summarize their 2; Discord had nothing held')
    env.notifyDone = false
    done(); done(); done(); done()
    check(sent.push.length === 4, 'the desktop notifyDone off: Web Push takes nothing (RemoteManager.notifyPush would drop it)')
  }
  {
    // routeCustom (snaos notify) goes through the same coalescers.
    const { p, sent, router, count } = make()
    for (let i = 0; i < 5; i++) router.routeCustom({ kind: 'custom', paneId: 'p2', title: 'CI', body: 'build ' + i })
    check(count() === '0/3/3' && sent.discord.every((n) => n.kind === 'custom'), 'routeCustom: Discord and ntfy send 3, Web Push never gets a custom notice')
    check(sent.ntfy[0].click === 'http://100.64.0.2:4517/#ws=w1&pane=p2', 'a custom notice keeps its deep link')
    router.route({ paneId: 'p1', provider: 'claude', state: 'done' })
    check(count() === '1/3/3', 'an agent notice in the same window waits behind them on Discord and ntfy (one window per channel)')
    p.advance(WINDOW)
    check(sent.discord.at(-1).summary.count === 3 && sent.discord.at(-1).summary.places === 'Front / Api, Front / Builder' && p.timers.size === 0, 'one summary for custom and agent notices together')
  }
  {
    // The away gate runs first: a gated notice takes no slot and arms nothing.
    const { p, env, router, done, count } = make({ onlyWhenAway: true, away: false })
    for (let i = 0; i < 6; i++) done()
    router.routeCustom({ kind: 'custom', paneId: 'p1', title: 't', body: 'b' })
    check(count() === '0/0/0' && p.timers.size === 0, 'only when away + an active PC: nothing goes out, nothing is counted or armed')
    env.away = true
    done(); done(); done()
    check(count() === '3/3/3', 'away: the first 3 go out (the gated ones never took a slot)')
    done()
    env.away = false
    p.advance(WINDOW)
    check(count() === '3/3/3' && p.timers.size === 0, 'back at the PC when the window closes: the summary is dropped by the same gate')
  }
  {
    // Existing callers build the router without timers or the Discord filters.
    const { sent, done, count } = make({ noDiscordWants: true })
    done(); done()
    check(count() === '2/2/2' && sent.discord.length === 2, 'a Discord dep without wants still gets every notice')
  }
}

// --- 4. Channel texts: a done digest and a summary --------------------------------

async function channelChecks() {
  const { describeNotice, noticeDigestLine, NOTICE_DIGEST_MAX } = load('src/main/status/events.ts')
  check(NOTICE_DIGEST_MAX === 160, 'a notice digest line is at most 160')
  const done = { paneId: 'p1', provider: 'claude', state: 'done', digest: 'Edit 3, Read 2 (src/a.ts)' }
  check(describeNotice(done, configOf('en'), 'X').digest === 'Tools: Edit 3, Read 2 (src/a.ts)', 'describeNotice: status.push.doneDigest in English')
  check(describeNotice(done, configOf('es'), 'X').digest === 'Herramientas: Edit 3, Read 2 (src/a.ts)', 'and in Spanish')
  check(noticeDigestLine({ ...done, state: 'error' }, null) === undefined && noticeDigestLine({ ...done, state: 'action' }, null) === undefined && noticeDigestLine({ ...done, digest: '  ' }, null) === undefined, 'only a done notice with a digest has the line')
  const summary = { paneId: '', provider: 'claude', state: 'done', summary: { count: 2, text: 'More notices from SnAgentsOS: 2', places: 'Front / Builder' } }
  const ds = describeNotice(summary, configOf('en'), 'SnAgentsOS')
  check(ds.message === summary.summary.text && ds.place === 'Front / Builder' && ds.workspaceId === null && ds.digest === undefined, 'a summary reads as its text and places, with no console to open')

  const { DiscordNotifier } = load('src/main/status/DiscordNotifier.ts')
  const posted = []
  const discord = new DiscordNotifier(async (url, init) => { posted.push(JSON.parse(init.body).content); return { ok: true, status: 204, body: { cancel: async () => {} } } }, async () => {})
  const dcfg = { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/12345678901234567/abc_DEF-1', userId: '', notifyDone: true, notifyAction: false }
  discord.setConfig(dcfg)
  discord.notify(done, configOf('en'))
  await sleep(10)
  check(/^Claude: Turn complete\nFront \/ Builder\nTools: Edit 3, Read 2 \(src\/a\.ts\)\n\d{4}-/.test(posted[0]), 'Discord: a done notice adds the digest line after the place')
  discord.notify({ paneId: 'p1', provider: 'claude', state: 'done' }, configOf('en'))
  await sleep(10)
  check(/^Claude: Turn complete\nFront \/ Builder\n\d{4}-/.test(posted[1]), 'Discord: a done notice with no digest reads as before')
  discord.setConfig({ ...dcfg, notifyDone: false })
  check(!discord.wants(done) && discord.wants(summary) && discord.wantsCustom(), 'Discord wants: done off drops a done, a summary only needs the channel on')
  discord.notify(summary, configOf('en'))
  discord.notify({ ...summary, summary: { ...summary.summary, places: '' } }, configOf('en'))
  await sleep(10)
  check(/^More notices from SnAgentsOS: 2\nFront \/ Builder\n\d{4}-/.test(posted[2]) && /^More notices from SnAgentsOS: 2\n\d{4}-/.test(posted[3]), 'Discord: a summary is its text, its places when it has them, and the time')
  discord.setConfig({ ...dcfg, enabled: false })
  check(!discord.wants(summary) && !discord.wantsCustom(), 'Discord off wants nothing')

  const { NtfyNotifier, ntfyNoticeMessage } = load('src/main/status/NtfyNotifier.ts', { require: (id) => (id === 'electron' ? {} : require(id)) })
  const m = ntfyNoticeMessage(done, configOf('es'))
  check(m.title === 'Claude: Turno terminado' && m.message === 'Front / Builder\nHerramientas: Edit 3, Read 2 (src/a.ts)' && !m.urgent, 'ntfy: a done notice adds the digest line under the place')
  const ms = ntfyNoticeMessage({ ...summary, state: 'error' }, configOf('en'), 'http://h:1/')
  check(ms.title === summary.summary.text && ms.message === 'Front / Builder' && ms.urgent && ms.click === 'http://h:1/', 'ntfy: a summary is titled with its text over its places, urgent when it stands for an error')
  check(ntfyNoticeMessage({ ...summary, summary: { ...summary.summary, places: '' } }, null).message === 'SnAgentsOS', 'ntfy: a summary with no places says the product name')
  const ntfy = new NtfyNotifier(async () => ({ ok: true, status: 200, body: { cancel: async () => {} }, headers: { get: () => null } }), async () => {})
  ntfy.setConfig({ enabled: true, server: 'https://ntfy.sh', topic: 'my_topic', token: '', notifyDone: false, notifyAction: false })
  check(!ntfy.wants(done) && ntfy.wants(summary), 'ntfy wants: a summary only needs the channel on with a topic')
}

// --- 5. StatusManager: the digest line of a done notice ---------------------------

function statusManagerChecks() {
  const SID = '0123abcd-0000-4000-8000-0000000000a5'
  const rig = (language) => {
    const notices = [], timers = new Map()
    let seq = 0, clock = T0
    class FakeDate extends Date { static now() { return clock } }
    const mod = load('src/main/status/StatusManager.ts', {
      require: (id) => (id === 'electron' ? { Notification: { isSupported: () => false } } : require(id)),
      setTimeout: (fn, ms = 0) => { timers.set(++seq, { fn, at: clock + (ms || 0) }); return seq }, clearTimeout: (id) => timers.delete(id), Date: FakeDate,
    })
    const win = { isDestroyed: () => false, isFocused: () => false, webContents: { send() {} }, flashFrame() {} }
    let configReads = 0
    const manager = new mod.StatusManager(() => win, () => { configReads++; return configOf(language) }, (n) => notices.push(n))
    manager.onSpawn('pty', 'pane')
    const advance = (ms) => {
      const end = clock + ms
      for (;;) {
        let next = null
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
        if (!next) break
        timers.delete(next[0]); clock = Math.max(clock, next[1].at); next[1].fn()
      }
      clock = end
    }
    const hook = (name, rest = {}) => manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: SID, name, ...rest })
    const turn = (tools) => {
      hook('UserPromptSubmit', { prompt: 'arreglá el login' })
      tools.forEach(([toolName, toolFile], i) => { hook('PreToolUse', { toolName, toolUseId: 't' + seq + i, toolSummary: toolName, ...(toolFile ? { toolFile } : {}) }); hook('PostToolUse', { toolUseId: 't' + seq + i }) })
      hook('Stop', { lastAssistantMessage: 'SECRET-REPLY listo, el token es ' + GHP })
      advance(701)
      return notices.at(-1)
    }
    return { manager, hook, advance, notices, turn, configReads: () => configReads }
  }
  {
    const h = rig('en')
    const n = h.turn([['Edit', 'src/a.ts'], ['Edit', 'src/a.ts'], ['Read', 'src/b.ts'], ['Bash']])
    check(n.state === 'done' && n.digest === 'Edit 2, Read 1, Run 1', 'a done notice carries the digest line of its turn (English families, counts only: no file names leave the PC)')
    check(!JSON.stringify(n).includes('SECRET') && !JSON.stringify(n).includes(GHP), 'and never any text of the reply')
  }
  {
    const h = rig('es')
    const n = h.turn([['Read', 'src/b.ts'], ['Grep']])
    check(n.digest === 'Lectura 1, Búsqueda 1', 'the families follow the config language (Spanish)')
    const before = h.configReads()
    const bare = h.turn([])
    check(bare.state === 'done' && bare.digest === undefined && h.configReads() === before, 'a turn with no tool: no digest, and no config read for it')
  }
  {
    const h = rig('en')
    const n = h.turn([['Read', `keys/${GHP}`], ['Edit', `cfg/${SK}.env`]])
    check(n.digest === 'Read 1, Edit 1' && !n.digest.includes(GHP) && !n.digest.includes(SK), 'file names never reach the digest line, credentials in them included')
    const long = h.turn([['Read', 'a/' + 'x'.repeat(110)], ['Read', 'b/' + 'y'.repeat(110)]])
    check(long.digest === 'Read 2', 'long file names leave the digest line at its counts')
  }
  {
    const h = rig('en')
    h.hook('UserPromptSubmit', { prompt: 'x' })
    h.hook('PreToolUse', { toolName: 'Edit', toolUseId: 'e1', toolFile: 'src/a.ts' })
    h.hook('PermissionRequest', { toolName: 'Edit', toolUseId: 'e1', toolSummary: 'Edit a.ts' })
    check(h.notices.at(-1).state === 'action' && h.notices.at(-1).digest === undefined, 'an action notice carries no digest')
    h.hook('StopFailure', { failureCode: 'overloaded' })
    check(h.notices.at(-1).state === 'error' && h.notices.at(-1).digest === undefined, 'an error notice carries no digest')
  }
}

// --- 6. The status sound: at most one every 2 s -----------------------------------

function soundChecks() {
  let clock = T0
  class FakeDate extends Date { static now() { return clock } }
  let oscillators = 0
  const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
    resume() { return Promise.resolve() }
    createOscillator() { oscillators++; return { type: '', frequency: param, connect() {}, start() {}, stop() {} } }
    createGain() { return { gain: param, connect() {} } }
  }
  const { playStatusSound, SOUND_MIN_GAP_MS } = load('src/renderer/lib/sound.ts', { Date: FakeDate, AudioContext: FakeAudioContext })
  check(SOUND_MIN_GAP_MS === 2000, 'the gap is 2 s')
  playStatusSound('ping', 80)
  check(oscillators === 1, 'the first sound plays')
  clock += 500; playStatusSound('ping', 80)
  clock += 1499; playStatusSound('chime', 80)
  check(oscillators === 1, 'a sound inside 2 s of the last one is dropped (not queued)')
  clock += 1; playStatusSound('ping', 80)
  check(oscillators === 2, 'at 2 s the next one plays')
  clock += 2500; playStatusSound('ping', 0)
  clock += 10; playStatusSound('ping', 80)
  check(oscillators === 3, 'a silent call (volume 0) does not count against the gap')
  clock -= 60_000; playStatusSound('ping', 80)
  check(oscillators === 4, 'a clock moved back plays at once')
  const bare = load('src/renderer/lib/sound.ts', { Date: FakeDate })
  bare.playStatusSound('pop', 80)
  check(true, 'without an AudioContext (the renderer suites) it returns quietly')
}

async function main() {
  coalescerChecks()
  summaryChecks()
  routerChecks()
  await channelChecks()
  statusManagerChecks()
  soundChecks()
  console.log(`PASS: ${checks} notice discipline checks (coalescer, summary, router per channel and away gate, routeCustom, Discord and ntfy texts, done digest line, sound throttle)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
