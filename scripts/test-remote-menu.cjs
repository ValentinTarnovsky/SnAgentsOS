// app 2.4.0: Claude's answer menu for the phone's Chat view, read by main off
// the headless mirror. esbuild + vm, no Electron:
//  - HeadlessMirror.screenRows and PtyManager.screenRows (fake node-pty) with
//    the shared parser over scripts/fixtures/claude-menus.cjs, null with
//    snapshotMode 'off' or without a live pty;
//  - PromptMenuWatcher: only a precise Claude plan / permission, only while a
//    phone watches, throttled, validated per kind, cleared with the request;
//  - RemoteManager + SessionManager with a fake socket and a fake clock: the
//    menu goes out in paneStatus and in every state frame (a pushState keeps
//    the Chat card), an identical menu is not sent again, and the answerMenu
//    ctl answers ok / stale / menu_changed / no_menu and writes only the
//    digit, never "\r"; it sits behind the rate bucket and is never relayed
//    to the renderer.
const { buildSync, build } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const M = require('./fixtures/claude-menus.cjs')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const XTERM_EXTERNAL = ['electron', 'ws', 'node-pty', 'qrcode', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: XTERM_EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, ...overrides })
  return mod.exports
}
const screen = rows => '\x1b[2J\x1b[H' + rows.join('\r\n')

// --- HeadlessMirror.screenRows + the shared parser ---------------------------
const Menu = load('src/shared/promptMenu.ts')
{
  const { HeadlessMirror } = load('src/main/pty/HeadlessMirror.ts')
  const mirror = new HeadlessMirror({ cols: 80, rows: 30, scrollback: 200, unicode11: true })
  mirror.write(screen(M.bashPermission))
  const rows = mirror.screenRows()
  check(Array.isArray(rows) && rows.length === 30, 'screenRows reads the 30 screen rows of the mirror')
  const always = Menu.alwaysOption(Menu.parseMenu(rows))
  check(always?.n === 2 && always.label.startsWith("Yes, and don't ask again"), 'the Bash permission on the mirror validates "Always allow" as option 2')
  mirror.write(screen(M.editPermission))
  check(Menu.alwaysOption(Menu.parseMenu(mirror.screenRows()))?.label === 'Yes, allow all edits during this session', 'the boxed Edit dialog validates off the mirror (borders and key hint dropped)')
  mirror.write(screen(M.plan))
  const plan = Menu.planOptions(Menu.parseMenu(mirror.screenRows()))
  check(plan?.length === 3 && plan[0].label === 'Yes, and auto-accept edits' && plan[2].label === 'No, keep planning', 'the plan menu validates off the mirror')
  mirror.write(screen(M.planWithFeedback))
  check(Menu.planOptions(Menu.parseMenu(mirror.screenRows()))?.[3].cls === 'feedback', 'the plan layout with the free text row validates off the mirror')
  mirror.write(screen(M.changedPlan))
  check(Menu.planOptions(Menu.parseMenu(mirror.screenRows())) === null, 'an unknown plan layout gives no menu')
  // A soft wrapped option is joined back (screenRowsOf on the headless buffer).
  const narrow = new HeadlessMirror({ cols: 30, rows: 12, scrollback: 50, unicode11: true })
  narrow.write(screen([' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for npm test commands", '   3. No']))
  const joined = narrow.screenRows().find(r => r.includes('2. Yes'))
  check(joined && joined.includes('npm test commands'), 'a soft wrapped row is joined back into one')
  check(Menu.alwaysOption(Menu.parseMenu(narrow.screenRows()))?.n === 2, 'and still validates')
  mirror.dispose()
  narrow.dispose()
}

// --- PtyManager.screenRows with a fake node-pty --------------------------------
let current = null
const Pty = load('src/main/pty/PtyManager.ts', {
  require: id => id === 'node-pty' ? { spawn: (...a) => current.impl(...a) } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
  console: { ...console, warn() {} },
})
function fakeHarness() {
  const procs = []
  const impl = (_shell, _args, opts) => {
    const dataCbs = [], exitCbs = []
    const proc = {
      cols: opts.cols, rows: opts.rows, writes: [], killed: false,
      onData: cb => dataCbs.push(cb), onExit: cb => exitCbs.push(cb),
      write: d => proc.writes.push(d), resize: (c, r) => { proc.cols = c; proc.rows = r },
      pause() {}, resume() {},
      kill: () => { proc.killed = true; exitCbs.forEach(cb => cb({ exitCode: 1 })) },
      emit: d => dataCbs.forEach(cb => cb(d)),
    }
    procs.push(proc)
    return proc
  }
  return { impl, procs }
}
function ptyManager(engine) {
  current = fakeHarness()
  const pm = new Pty.PtyManager(() => ({ isDestroyed: () => false, send() {} }))
  pm.setEngine(engine)
  return { pm, h: current }
}
const flushAll = () => new Promise(r => setTimeout(r, 30))

async function testPtyScreenRows() {
  {
    const { pm, h } = ptyManager({ snapshotMode: 'auto', persist: false })
    pm.spawn({ paneId: 'p1', cols: 80, rows: 30 })
    h.procs[0].emit(screen(M.plan))
    await flushAll()
    const rows = pm.screenRows('p1')
    check(Array.isArray(rows) && Menu.planOptions(Menu.parseMenu(rows))?.length === 3, 'PtyManager.screenRows creates the mirror on demand, seeded from the ring')
    // Output still in the coalesce buffer is flushed before the read.
    h.procs[0].emit(screen(M.bashPermission))
    check(Menu.alwaysOption(Menu.parseMenu(pm.screenRows('p1')))?.n === 2, 'pending output is flushed into the mirror before the read')
    check(pm.screenRows('nope') === null, 'a pane without a live pty reads null')
    check(h.procs[0].writes.length === 0, 'reading the screen never writes to the pty')
    pm.killAll()
  }
  {
    const { pm, h } = ptyManager({ snapshotMode: 'off' })
    pm.spawn({ paneId: 'p1', cols: 80, rows: 30 })
    h.procs[0].emit(screen(M.plan))
    await flushAll()
    check(pm.screenRows('p1') === null, "snapshotMode 'off' reads null (no mirror, no menu)")
    pm.killAll()
  }
}

// --- PromptMenuWatcher -------------------------------------------------------
const W = load('src/main/remote/PromptMenuWatcher.ts')
function clockRig() {
  let clock = 0, seq = 0
  const timers = new Map()
  return {
    now: () => clock,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: clock + ms, fn }); return id },
    clearTimeout: id => timers.delete(id),
    advance(ms) {
      const end = clock + ms
      for (;;) {
        let best = null
        for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t]
        if (!best) break
        timers.delete(best[0])
        clock = Math.max(clock, best[1].at)
        best[1].fn()
      }
      clock = end
    },
    get pending() { return timers.size },
  }
}
const planReq = { id: 'tp1', kind: 'plan', toolName: 'ExitPlanMode', summary: 'Plan' }
const permReq = { id: 'tb1', kind: 'permission', toolName: 'Bash', summary: 'npm test' }
const evt = (paneId, state, rest = {}) => ({ paneId, state, precise: true, notify: false, provider: 'claude', pendingCount: 0, stateSince: 1000, updatedAt: 1234, ...rest })

function testWatcher() {
  check(W.MENU_READ_THROTTLE_MS === 250, 'the menu is re-read at most every 250 ms')
  check(W.menuTarget(evt('p', 'action', { pending: [planReq] }))?.kind === 'plan', 'a precise Claude plan is a target')
  check(W.menuTarget(evt('p', 'action', { pending: [permReq] }))?.pendingId === 'tb1', 'a precise Claude permission is a target')
  check(W.menuTarget(evt('p', 'action', { pending: [permReq, planReq] }))?.kind === 'plan', 'the plan wins over a permission (like the phone card)')
  check(W.menuTarget(evt('p', 'action', { precise: false, pending: [planReq] })) === null, 'a title-only (approximate) track is no target')
  check(W.menuTarget(evt('p', 'action', { provider: 'codex', pending: [permReq] })) === null, 'a Codex request is no target (the key row covers it)')
  check(W.menuTarget(evt('p', 'action', { pending: [{ id: 'q', kind: 'question', summary: '' }, { id: 'e', kind: 'elicitation', summary: '' }] })) === null, 'questions and elicitations are no target')
  check(W.menuTarget(evt('p', 'working', { pending: [planReq] })) === null, 'only in action')
  check(W.validMenu(M.plan, 'plan')?.length === 3 && W.validMenu(M.plan, 'permission') === null, 'validMenu checks the layout against the request kind')
  check(W.validMenu(M.bashPermission, 'permission')?.length === 3 && W.validMenu(M.bashPermission, 'plan') === null, 'a permission menu is never a plan menu')
  check(W.validMenu(null, 'plan') === null && W.validMenu(M.changedPlan, 'plan') === null && W.validMenu(M.staleMenu, 'permission') === null, 'no rows, an unknown layout or a stale menu give null')

  const c = clockRig()
  let rows = M.plan
  let watched = false
  const changes = []
  let reads = 0
  const w = new W.PromptMenuWatcher({
    screenRows: () => { reads++; return rows },
    isWatched: () => watched,
    onChange: paneId => changes.push(paneId),
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
  })
  const planEvt = evt('p1', 'action', { pending: [planReq] })
  w.onStatus(planEvt)
  c.advance(0)
  check(reads === 0 && changes.length === 0 && w.menuFor('p1', planEvt.pending) === undefined, 'no phone watches the pane: the screen is not read')
  watched = true
  w.watch('p1')
  c.advance(0)
  const menu = w.menuFor('p1', planEvt.pending)
  check(reads === 1 && changes.join() === 'p1' && menu?.for === 'tp1' && menu.options.length === 3, 'a phone starts watching: one read and one change with the validated menu')
  check(w.menuFor('p1', [permReq]) === undefined, 'the menu only goes with a status that still holds its request')
  // Output streams in: one read per 250 ms at most, and the same menu is no change.
  for (let i = 0; i < 10; i++) { w.onData('pty', 'p1', 'x'); c.advance(20) }
  c.advance(300)
  check(reads <= 3 && reads >= 2, `a burst of output is read at most every 250 ms (${reads} reads)`)
  check(changes.length === 1, 'the same menu read again is no change')
  // The menu goes away (answered on the PC): one change, no menu.
  rows = ['> next', '⏺ Working...']
  w.onData('pty', 'p1', 'y')
  c.advance(300)
  check(changes.length === 2 && w.menuFor('p1', planEvt.pending) === undefined, 'a screen without the menu clears it (one change)')
  // A layout the request kind does not accept is no menu.
  rows = M.bashPermission
  w.onData('pty', 'p1', 'z')
  c.advance(300)
  check(changes.length === 2 && w.menuFor('p1', planEvt.pending) === undefined, 'a permission menu on screen is never sent for a plan request')
  // A new request (another id) drops the old menu and reads again.
  rows = M.bashPermission
  const permEvt = evt('p1', 'action', { pending: [permReq] })
  w.onStatus(permEvt)
  c.advance(0)
  check(w.menuFor('p1', permEvt.pending)?.for === 'tb1' && changes.length === 3, 'a new request reads again and its menu is for its id')
  // The request goes away: target and menu forgotten, nothing read afterwards.
  w.onStatus(evt('p1', 'working', { pending: [] }))
  const before = reads
  w.onData('pty', 'p1', 'a')
  c.advance(500)
  check(reads === before && w.menuFor('p1', permEvt.pending) === undefined && w.targetOf('p1') === null, 'the request answered: no target, no menu, no reads')
  // A phone that stops watching gets its menu cleared on the next read.
  w.onStatus(planEvt)
  rows = M.plan
  c.advance(0)
  check(!!w.menuFor('p1', planEvt.pending), 'the plan is read again')
  watched = false
  w.onData('pty', 'p1', 'b')
  c.advance(300)
  check(w.menuFor('p1', planEvt.pending) === undefined, 'nobody watches any more: the menu is dropped')
  // A new pty (restart) or an exit clears a menu.
  watched = true
  w.watch('p1')
  c.advance(300)
  const n = changes.length
  w.onSpawn('pty2', 'p1')
  check(w.menuFor('p1', planEvt.pending) === undefined && changes.length === n + 1, 'a new pty drops the menu of the old screen')
  // screenRows throwing never escapes.
  const w2 = new W.PromptMenuWatcher({ screenRows: () => { throw new Error('boom') }, isWatched: () => true, onChange() {}, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout })
  w2.onStatus(planEvt)
  c.advance(0)
  check(w2.menuFor('p1', planEvt.pending) === undefined, 'a failing screen read is no menu, never a throw')
  w.onData('pty', 'p1', 'c')
  w.dispose()
  const afterDispose = reads
  c.advance(1000)
  check(reads === afterDispose && w.targetOf('p1') === null, 'dispose drops the targets and the pending reads')
}

// --- RemoteManager + SessionManager --------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-remote-menu-'))
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /\/RemoteServer$/ }, () => ({ path: 'RemoteServer', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
    b.onLoad({ filter: /^RemoteServer$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `
export class RemoteServer {
  constructor(port: number, handlers: any) { (globalThis as any).__server = { port, handlers } }
  start() { return Promise.resolve() }
  close() {}
}` }))
    b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(dataDir)} }` }))
  },
}

function world(code) {
  let clock = 0, seq = 0
  const timers = new Map()
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: clock + Math.max(0, ms || 0), fn, every }); return { id, unref() {}, ref() {} } }
  const del = h => { if (h) timers.delete(typeof h === 'object' ? h.id : h) }
  function advance(ms) {
    const end = clock + ms
    for (;;) {
      let best = null
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t]
      if (!best) break
      const [id, t] = best
      clock = Math.max(clock, t.at)
      if (t.every) t.at += t.every; else timers.delete(id)
      t.fn()
    }
    clock = end
  }
  class FakeDate extends Date { static now() { return 1700000000000 + clock } }
  const ctx = {
    module: { exports: {} }, require: id => id === 'qrcode' ? { toDataURL: async () => 'data:' } : require(id),
    console, process, Buffer, URL, queueMicrotask,
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: del,
    setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: del,
    Date: FakeDate,
  }
  ctx.exports = ctx.module.exports
  ctx.globalThis = ctx
  vm.runInNewContext(code, ctx)
  const api = ctx.module.exports
  const writes = []
  const statuses = []
  const sinks = new Map()
  const screens = { p1: null }
  const pty = {
    addSink(s) { sinks.set(s.id, s) }, removeSink(id) { sinks.delete(id) }, setRunningChangeListener() {}, setForcedFast() {},
    runningPaneIds: () => ['p1', 'p2'],
    exitedPaneCodes: () => new Map(),
    getReplay: paneId => ({ ptyId: 'pty-' + paneId, replay: 'R:' + paneId, cols: 80, rows: 24 }),
    ptyIdForPane: paneId => (paneId === 'gone' ? null : 'pty-' + paneId),
    sizeOf: () => ({ cols: 80, rows: 24 }),
    write: (ptyId, data, origin) => writes.push({ ptyId, data, origin }),
    screenRows: paneId => screens[paneId] ?? null,
  }
  const commands = []
  const webContents = { isDestroyed: () => false, setBackgroundThrottling() {}, send: (ch, cmd) => { if (ch === 'remote:controlCmd') commands.push(cmd) } }
  const manager = new api.RemoteManager(pty, () => webContents, '2.4.0', () => statuses, () => 'MI-PC')
  // index.ts wires StatusManager's listener to pushPaneStatus.
  const emit = e => {
    const i = statuses.findIndex(s => s.paneId === e.paneId)
    if (i >= 0) statuses.splice(i, 1)
    if (e.state != null) statuses.push(e)
    manager.pushPaneStatus(e)
  }
  manager.applyConfig({ enabled: true, port: 4610 })
  class FakeSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.inbox = []; this.handlers = {}; this.closed = null }
    on(ev, fn) { this.handlers[ev] = fn }
    send(data) { this.inbox.push(JSON.parse(data)) }
    close(code) { this.closed = code; this.readyState = 3; this.handlers.close && this.handlers.close() }
    terminate() { this.close(1006) }
    msg(obj) { this.handlers.message(JSON.stringify({ v: 1, ...obj })) }
    of(type) { return this.inbox.filter(m => m.type === type) }
  }
  const socket = () => { const ws = new FakeSocket(); ctx.__server.handlers.onSocket(ws, '100.64.0.9', '100.64.0.9'); return ws }
  return { api, manager, statuses, writes, commands, socket, advance, emit, screens, sinks }
}

async function pair(w) {
  await new Promise(resolve => setImmediate(resolve))
  const payload = await w.manager.pairingBegin()
  const ws = w.socket()
  ws.msg({ type: 'hello', clientNonce: 'aa'.repeat(32) })
  ws.msg({ type: 'pair', code: payload.code, deviceName: 'Phone' })
  const requestId = w.manager.getUiState().pendingPairing.requestId
  w.manager.pairingResolve(requestId, true)
  const paired = ws.of('paired')[0]
  return { ws, deviceId: paired.deviceId, secret: paired.secret }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const snapshot = {
  workspaces: [{ id: 'w1', name: 'One', layoutOrder: ['p1', 'p2'], panes: [
    { id: 'p1', title: 'A', type: 'claude', color: '', icon: '', running: true },
    { id: 'p2', title: 'B', type: 'claude', color: '', icon: '', running: true },
  ] }],
  activeWorkspaceId: 'w1', themeTokens: {}, language: 'en', fontFamily: '', fontSize: 14,
}

async function testRemote(code) {
  const api = (() => { const w = world(code); return w.api })()
  // toRemoteStatus whitelists the menu and only with its request still pending.
  const menu = { for: 'tp1', options: [{ n: 1, label: 'Yes, and auto-accept edits' }, { n: 2, label: 'No, keep planning' }] }
  const withPlan = evt('p1', 'action', { reason: 'plan', pendingCount: 1, pending: [planReq] })
  check(JSON.stringify(api.toRemoteStatus(withPlan, menu).menu) === JSON.stringify(menu), 'toRemoteStatus carries the menu')
  check(!('menu' in api.toRemoteStatus(withPlan)) && !('menu' in api.toRemoteStatus(withPlan, null)), 'no menu argument, no menu field')
  check(!('menu' in api.toRemoteStatus(evt('p1', 'action', { pending: [permReq] }), menu)), 'a menu for a request that is gone is dropped')

  const w = world(code)
  w.manager.pushState(snapshot)
  const { ws } = await pair(w)
  w.screens.p1 = M.plan
  w.emit(withPlan)
  w.advance(0)
  const menuFrames = () => ws.of('paneStatus').filter(f => f.paneId === 'p1' && f.status?.menu)
  check(menuFrames().length === 0, 'no phone watches p1 yet: no menu goes out')
  ws.msg({ type: 'chatSub', paneId: 'p1' })
  w.advance(0)
  const first = menuFrames().at(-1)
  check(first && first.status.menu.for === 'tp1' && first.status.menu.options.length === 3 && first.status.menu.options[2].label === 'No, keep planning', 'a chatSub reads the menu and paneStatus carries it')
  check(first.status.pending?.[0]?.id === 'tp1' && first.status.state === 'action', 'the re-broadcast is the full status plus the menu')
  // A state frame (pushState, a running change) keeps the menu: the phone replaces its paneStatus map from it.
  w.manager.pushState(snapshot)
  const state = ws.of('state').at(-1)
  check(state.state.workspaces[0].panes[0].status?.menu?.for === 'tp1', 'a pushState while the menu is set still carries status.menu')
  // Identical reads are not sent again.
  const count = ws.of('paneStatus').length
  for (const s of w.sinks.values()) s.onData?.('pty-p1', 'p1', 'tick')
  w.advance(600)
  check(ws.of('paneStatus').length === count, 'the same menu read again is not re-sent')
  // An unrelated status update of the same request (activity) keeps the menu.
  w.emit({ ...withPlan, lastMessage: 'Plan ready' })
  w.advance(200)
  check(ws.of('paneStatus').at(-1).status?.menu?.for === 'tp1', 'a later paneStatus of the same request still carries the menu')

  // answerMenu through the phone's ctl: handled in main, never relayed.
  const ack = id => ws.of('ctlAck').find(a => a.id === id)
  const relayedBefore = w.commands.length
  ws.msg({ type: 'ctl', id: 'm1', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'tp1', n: 2, label: 'Yes, and manually approve edits' } })
  await settle()
  check(ack('m1')?.ok === true, 'answerMenu with the label on screen acks ok')
  check(w.writes.length === 1 && w.writes[0].data === '2' && w.writes[0].ptyId === 'pty-p1' && w.writes[0].origin === 'user', 'only the digit is written, as user input')
  check(w.commands.length === relayedBefore, 'answerMenu never reaches the renderer executor')
  ws.msg({ type: 'ctl', id: 'm2', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'tp1', n: 2, label: 'Yes, and bypass permissions' } })
  await settle()
  check(ack('m2')?.ok === false && ack('m2').error === 'menu_changed' && w.writes.length === 1, 'a label that changed acks menu_changed and writes nothing')
  ws.msg({ type: 'ctl', id: 'm3', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'tp1', n: 5, label: 'Yes, go' } })
  await settle()
  check(ack('m3')?.error === 'menu_changed', 'an option number the menu does not have acks menu_changed')
  w.screens.p1 = M.changedPlan
  ws.msg({ type: 'ctl', id: 'm4', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'tp1', n: 1, label: 'Yes, and auto-accept edits' } })
  await settle()
  check(ack('m4')?.error === 'menu_changed', 'a menu of another layout on screen acks menu_changed')
  w.screens.p1 = null
  ws.msg({ type: 'ctl', id: 'm5', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'tp1', n: 1, label: 'Yes, and auto-accept edits' } })
  await settle()
  check(ack('m5')?.error === 'no_menu', "an unreadable screen (snapshotMode 'off', no mirror) acks no_menu")
  w.screens.p1 = ['$ ', '']
  ws.msg({ type: 'ctl', id: 'm6', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'tp1', n: 1, label: 'Yes, and auto-accept edits' } })
  await settle()
  check(ack('m6')?.error === 'no_menu', 'a screen without any menu acks no_menu')
  w.screens.p1 = M.plan
  ws.msg({ type: 'ctl', id: 'm7', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'other', n: 1, label: 'Yes, and auto-accept edits' } })
  await settle()
  check(ack('m7')?.error === 'stale', 'a request that is not pending acks stale')
  check(w.writes.length === 1 && w.writes.every(x => !x.data.includes('\r') && !x.data.includes('\n')), 'nothing else was written and never an Enter')
  // The request answered: the status drops it, the menu goes away with it.
  w.emit(evt('p1', 'working', { pending: [] }))
  w.advance(200)
  check(!ws.of('paneStatus').at(-1).status?.menu, 'the request answered: the next status carries no menu')
  ws.msg({ type: 'ctl', id: 'm8', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'tp1', n: 1, label: 'Yes, and auto-accept edits' } })
  await settle()
  check(ack('m8')?.error === 'stale' && w.writes.length === 1, 'answering it afterwards acks stale')

  // A permission: "Always allow" by answerMenu.
  w.screens.p1 = M.bashPermission
  w.emit(evt('p1', 'action', { reason: 'permission', pendingCount: 1, pending: [permReq] }))
  w.advance(0)
  const perm = ws.of('paneStatus').at(-1).status
  check(perm.menu?.for === 'tb1' && perm.menu.options[1].n === 2, 'a permission menu goes out for its request')
  ws.msg({ type: 'ctl', id: 'p1', action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'tb1', n: 2, label: perm.menu.options[1].label } })
  await settle()
  check(ack('p1')?.ok && w.writes.at(-1).data === '2', '"Always allow" writes "2", no Enter')

  // Rate: answerMenu is behind the session bucket.
  check(w.api.RATE_LIMITED_CTL_KINDS.has('answerMenu') && w.api.isRateLimitedMsg({ type: 'ctl', action: { kind: 'answerMenu' } }), 'answerMenu is a rate limited ctl kind')
  for (let i = 0; i < 40; i++) ws.msg({ type: 'ctl', id: `r${i}`, action: { kind: 'answerMenu', paneId: 'p1', pendingId: 'gone', n: 1, label: 'x' } })
  await settle()
  check(ws.of('ctlAck').some(a => /^r\d+$/.test(a.id) && a.error === 'rate') && !ws.closed, 'a burst past the bucket acks rate without closing the socket')

  // Server teardown leaves no reader behind.
  w.manager.applyConfig({ enabled: false, port: 4610 })
  check(!w.sinks.has('remote-prompt-menu'), 'the watcher leaves the pty sinks with the server')
}

async function main() {
  await testPtyScreenRows()
  testWatcher()
  const code = (await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `
export { RemoteManager, toRemoteStatus } from './src/main/remote/RemoteManager'
export { isRateLimitedMsg, RATE_LIMITED_CTL_KINDS } from './src/main/remote/SessionManager'
` },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: XTERM_EXTERNAL,
    plugins: [stubs], alias: { '@shared': path.join(root, 'src/shared') },
  })).outputFiles[0].text
  await testRemote(code)
  // The ctl schema (main only).
  const S = load('src/shared/remote-protocol-schemas.ts')
  const frame = action => S.parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'ctl', id: 'x', action }))
  const ok = { kind: 'answerMenu', paneId: 'p1', pendingId: 'toolu_01', n: 2, label: 'Yes, and auto-accept edits' }
  check(!!frame(ok), 'the ctl schema accepts answerMenu')
  check(!frame({ ...ok, n: 0 }) && !frame({ ...ok, n: 10 }) && !frame({ ...ok, n: 1.5 }) && !frame({ ...ok, n: '2' }), 'n is an integer digit 1..9')
  check(!frame({ ...ok, label: '' }) && !frame({ ...ok, label: 'x'.repeat(161) }) && !frame({ ...ok, pendingId: '' }) && !frame({ ...ok, pendingId: 'x'.repeat(201) }), 'label 1..160 and pendingId 1..200')
  check(!frame({ kind: 'answerMenu', paneId: 'p1', pendingId: 'a', n: 1 }) && !frame({ kind: 'answerMenu', pendingId: 'a', n: 1, label: 'x' }), 'every field is required')
  check(!('data' in frame({ ...ok, data: '\r' }).action), 'a stray data field is stripped (only the digit is ever written)')
  fs.rmSync(dataDir, { recursive: true, force: true })
  console.log(`PASS: ${checks} remote menu checks (mirror screen rows, PromptMenuWatcher, paneStatus.menu, answerMenu)`)
}

main().catch(error => { console.error(error); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(1) })
